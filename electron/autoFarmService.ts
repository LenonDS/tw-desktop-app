import crypto from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  computeHumanizedDelayMs,
  computeNextDailyScheduleMs,
  detectSlowestUnitFromTroops,
  evaluateFarmSafetyStop,
  filterPlunderTargetsForPhase,
  getEffectiveTemplateOrder,
  selectDuePlayerFarmTargets,
} from './store';
import type { DataStore } from './store';
import type { SessionManager } from './sessionManager';
import type {
  AutoFarmConfig,
  AutoFarmRuntimeState,
  FarmPauseReason,
  FarmPlunderTarget,
  FarmTemplateKey,
  ScheduledCommand,
} from './types';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function canUseTemplateOnTarget(target: FarmPlunderTarget, key: FarmTemplateKey): boolean {
  if (key === 'a') return target.canSendA;
  if (key === 'b') return target.canSendB;
  return target.canSendC;
}

export class AutoFarmService {
  private readonly store: DataStore;
  private readonly sessionManager: SessionManager;
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dailyTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeLocks = new Set<string>();
  private readonly states = new Map<string, AutoFarmRuntimeState>();
  private currentDayKey = getLocalDateKey();

  constructor(
    store: DataStore,
    sessionManager: SessionManager,
    getMainWindow: () => BrowserWindow | null
  ) {
    this.store = store;
    this.sessionManager = sessionManager;
    this.getMainWindow = getMainWindow;
  }

  private ensureState(config: AutoFarmConfig): AutoFarmRuntimeState {
    const today = getLocalDateKey();
    if (today !== this.currentDayKey) {
      this.currentDayKey = today;
      for (const st of this.states.values()) {
        st.attacksToday = 0;
      }
    }

    let state = this.states.get(config.id);
    if (!state) {
      state = {
        configId: config.id,
        accountId: config.accountId,
        running: false,
        farmPhase: 'primary',
        coveredTargetCoords: [],
        waitingForTroops: false,
        attacksToday: 0,
        attacksThisCycle: 0,
      };
      this.states.set(config.id, state);
    }
    return state;
  }

  private resolveConfig(configIdOrAccountId: string): AutoFarmConfig | null {
    const byId = this.store.getAutoFarmConfigById(configIdOrAccountId);
    if (byId) return byId;
    const byAcc = this.store.getAutoFarmConfigsByAccount(configIdOrAccountId);
    if (byAcc.length > 0) return byAcc[0];
    const account = this.store.getAccountById(configIdOrAccountId);
    if (account) {
      return this.store.saveAutoFarmConfig({ accountId: account._id, id: account._id });
    }
    return null;
  }

  private emitState(state: AutoFarmRuntimeState): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('autofarm:state-changed', { ...state });
    }
  }

  private scheduleNextCycle(config: AutoFarmConfig, state: AutoFarmRuntimeState): void {
    const intervalMs = Math.max(30, config.cycleIntervalSec || 180) * 1000;
    state.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    const existing = this.timers.get(config.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.runCycle(config.id, false).catch(() => {});
    }, intervalMs);
    this.timers.set(config.id, timer);
  }

  public getSnapshot(): {
    configs: Record<string, AutoFarmConfig>;
    states: Record<string, AutoFarmRuntimeState>;
  } {
    const configs = this.store.getAllAutoFarmConfigs();
    const outStates: Record<string, AutoFarmRuntimeState> = {};
    for (const cfg of Object.values(configs)) {
      outStates[cfg.id] = { ...this.ensureState(cfg) };
    }
    return { configs, states: outStates };
  }

  public async startConfig(
    configIdOrAccountId: string
  ): Promise<{ success: boolean; state?: AutoFarmRuntimeState; error?: string }> {
    const config = this.resolveConfig(configIdOrAccountId);
    if (!config) {
      return { success: false, error: 'Configuração de Auto-Farm não encontrada.' };
    }
    const account = this.store.getAccountById(config.accountId);
    if (!account) {
      return { success: false, error: 'Conta não encontrada.' };
    }

    const st = this.sessionManager.getStatus(config.accountId);
    if (st.status !== 'running') {
      const launched = await this.sessionManager.launchSession(config.accountId, { visible: false });
      if (!launched.success) {
        const state = this.ensureState(config);
        state.running = false;
        state.pausedReason = 'session_offline';
        state.lastError = launched.error || 'Sessão offline.';
        this.emitState(state);
        return { success: false, state, error: state.lastError };
      }
    }

    const saved = this.store.saveAutoFarmConfig({
      id: config.id,
      accountId: config.accountId,
      enabled: true,
    });
    const state = this.ensureState(saved);
    state.running = true;
    state.pausedReason = undefined;
    state.waitingForTroops = false;
    state.lastError = undefined;
    this.emitState(state);

    this.store.addLog({
      accountId: config.accountId,
      accountName: account.username,
      level: 'info',
      message: `[Auto-Farm] Rotina iniciada (${saved.name || saved.originCoords || 'Geral'}).`,
    });

    await this.runCycle(saved.id, false);
    return { success: true, state: { ...this.ensureState(saved) } };
  }

  public stopConfig(
    configIdOrAccountId: string,
    reason: FarmPauseReason = 'manual',
    errorMessage?: string
  ): { success: boolean; state?: AutoFarmRuntimeState } {
    const config = this.resolveConfig(configIdOrAccountId);
    const key = config?.id || configIdOrAccountId;

    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(key);
    }

    if (!config) {
      return { success: false };
    }

    const saved = this.store.saveAutoFarmConfig({
      id: config.id,
      accountId: config.accountId,
      enabled: false,
    });
    const state = this.ensureState(saved);
    state.running = false;
    state.waitingForTroops = false;
    state.pausedReason = reason;
    state.nextRunAt = undefined;
    if (errorMessage) {
      state.lastError = errorMessage;
    }
    this.emitState(state);

    const acc = this.store.getAccountById(config.accountId);
    if (acc && reason !== 'manual') {
      this.store.addLog({
        accountId: config.accountId,
        accountName: acc.username,
        level: reason === 'captcha' || reason === 'incomings' ? 'warn' : 'info',
        message: `[Auto-Farm] Pausado (${saved.name || saved.originCoords || 'Geral'} - ${reason}): ${errorMessage || 'Parada de segurança acionada.'}`,
      });
    }

    return { success: true, state: { ...state } };
  }

  public deleteConfig(configId: string): boolean {
    const existingTimer = this.timers.get(configId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(configId);
    }
    const existingDaily = this.dailyTimers.get(configId);
    if (existingDaily) {
      clearTimeout(existingDaily);
      this.dailyTimers.delete(configId);
    }
    this.states.delete(configId);
    return this.store.deleteAutoFarmConfig(configId);
  }

  public syncAllDailySchedules(): void {
    const all = this.store.getAllAutoFarmConfigs();
    for (const cfg of Object.values(all)) {
      this.syncDailyScheduleForConfig(cfg);
    }
  }

  public syncDailyScheduleForConfig(config: AutoFarmConfig): void {
    const existing = this.dailyTimers.get(config.id);
    if (existing) {
      clearTimeout(existing);
      this.dailyTimers.delete(config.id);
    }

    const state = this.ensureState(config);
    if (!config.dailyScheduleEnabled) {
      state.nextDailyRunAt = undefined;
      this.emitState(state);
      return;
    }

    const nextMs = computeNextDailyScheduleMs(config.dailyScheduleTime || '08:00');
    state.nextDailyRunAt = new Date(nextMs).toISOString();
    this.emitState(state);

    const delayMs = Math.max(1000, nextMs - Date.now());
    const timer = setTimeout(() => {
      this.dailyTimers.delete(config.id);
      const latest = this.store.getAutoFarmConfigById(config.id);
      if (!latest || !latest.dailyScheduleEnabled) return;

      this.startConfig(latest.id).catch(() => {});
      // Re-arm for the next day until the user disables dailyScheduleEnabled
      this.syncDailyScheduleForConfig(latest);
    }, delayMs);

    this.dailyTimers.set(config.id, timer);
  }

  public stopAccount(accountId: string, reason: FarmPauseReason = 'manual'): void {
    const configs = this.store.getAutoFarmConfigsByAccount(accountId);
    for (const cfg of configs) {
      this.stopConfig(cfg.id, reason);
    }
  }

  public stopAll(): void {
    for (const configId of Array.from(this.timers.keys())) {
      this.stopConfig(configId, 'manual');
    }
    for (const timer of this.dailyTimers.values()) {
      clearTimeout(timer);
    }
    this.dailyTimers.clear();
  }

  public async runCycle(
    configIdOrAccountId: string,
    isSingleRun = true
  ): Promise<{ success: boolean; state?: AutoFarmRuntimeState; error?: string }> {
    const config = this.resolveConfig(configIdOrAccountId);
    if (!config) {
      return { success: false, error: 'Configuração de Auto-Farm não encontrada.' };
    }

    if (this.activeLocks.has(config.id)) {
      return { success: false, error: 'Ciclo desta aldeia já está em execução.' };
    }

    const account = this.store.getAccountById(config.accountId);
    if (!account) {
      return { success: false, error: 'Conta não encontrada.' };
    }

    const state = this.ensureState(config);
    this.activeLocks.add(config.id);
    state.attacksThisCycle = 0;
    state.waitingForTroops = false;
    state.lastError = undefined;
    this.emitState(state);

    try {
      // Phase 24 & 26: Farm Assistant (Barbarians) with Priority Order + Coverage Tracking + C Loop
      if (config.mode === 'fa' || config.mode === 'both') {
        const scan = await this.sessionManager.inspectFarmAssistant(
          config.accountId,
          config.originVillageId
        );

        if (!scan.success) {
          state.lastError = scan.error;
          if (!isSingleRun) {
            this.stopConfig(config.id, 'session_offline', scan.error);
          } else {
            this.emitState(state);
          }
          return { success: false, state: { ...state }, error: scan.error };
        }

        state.currentTroops = scan.troops;
        state.lastTargetsCount = scan.targets.length;
        state.lastTargets = scan.targets.slice(0, 60);

        const safety = evaluateFarmSafetyStop({
          config,
          captchaDetected: scan.captchaDetected,
          incomingsCount: scan.incomingsCount,
          currentTroops: scan.troops,
          attacksToday: state.attacksToday,
        });

        if (safety.shouldStop && safety.reason) {
          // In continuous loop, low_troops means wait for returning troops instead of killing the loop
          if (safety.reason === 'low_troops' && !isSingleRun && state.running) {
            state.waitingForTroops = true;
            state.lastRunAt = new Date().toISOString();
            this.scheduleNextCycle(config, state);
            this.emitState(state);
            return { success: true, state: { ...state } };
          }
          this.stopConfig(config.id, safety.reason, safety.message);
          return {
            success: false,
            state: { ...this.ensureState(config) },
            error: safety.message,
          };
        }

        // Up to 2 passes in the same cycle if primary coverage finishes and Model C follow-up is enabled
        for (let pass = 0; pass < 2; pass++) {
          if (!isSingleRun && !this.ensureState(config).running) break;

          const currentPhase = state.farmPhase || 'primary';
          const coveredSet = new Set<string>(state.coveredTargetCoords || []);
          const templateOrder =
            currentPhase === 'template_c' ? (['c'] as FarmTemplateKey[]) : getEffectiveTemplateOrder(config);
          const pendingTargets = filterPlunderTargetsForPhase(
            scan.targets,
            config,
            currentPhase,
            coveredSet
          );

          const exhaustedTemplates = new Set<FarmTemplateKey>();
          let stoppedForTroops = false;

          for (const target of pendingTargets) {
            if (!isSingleRun && !this.ensureState(config).running) break;
            if (config.dailyMaxAttacks > 0 && state.attacksToday >= config.dailyMaxAttacks) {
              this.stopConfig(
                config.id,
                'daily_limit',
                `Limite diário de ${config.dailyMaxAttacks} ataques atingido.`
              );
              return { success: true, state: { ...this.ensureState(config) } };
            }

            let sentThisTarget = false;
            for (const tplKey of templateOrder) {
              if (exhaustedTemplates.has(tplKey)) continue;
              if (!canUseTemplateOnTarget(target, tplKey)) continue;

              const dispatchRes = await this.sessionManager.dispatchFarmAssistantAttack(
                config.accountId,
                config.originVillageId,
                target.villageId,
                tplKey
              );

              if (dispatchRes.success) {
                sentThisTarget = true;
                coveredSet.add(target.coords);
                state.coveredTargetCoords = Array.from(coveredSet);
                state.attacksToday += 1;
                state.attacksThisCycle += 1;
                this.emitState(state);

                const delay = computeHumanizedDelayMs(config.minDelayMs, config.maxDelayMs);
                await sleepMs(delay);
                break;
              }

              if (dispatchRes.captchaDetected) {
                this.stopConfig(
                  config.id,
                  'captcha',
                  dispatchRes.error || 'CAPTCHA detectado durante o envio.'
                );
                return {
                  success: false,
                  state: { ...this.ensureState(config) },
                  error: dispatchRes.error,
                };
              }

              if (dispatchRes.lowTroops) {
                // Exhaust this higher-priority template and immediately try next priority template (e.g., A -> B)
                exhaustedTemplates.add(tplKey);
                continue;
              }

              state.lastError = dispatchRes.error;
            }

            if (!sentThisTarget && exhaustedTemplates.size >= templateOrder.length) {
              stoppedForTroops = true;
              break;
            }
          }

          if (stoppedForTroops) {
            if (!isSingleRun && state.running) {
              state.waitingForTroops = true;
            } else if (config.pauseOnLowTroops) {
              this.stopConfig(
                config.id,
                'low_troops',
                'Tropas insuficientes para concluir toda a seleção.'
              );
              return {
                success: false,
                state: { ...this.ensureState(config) },
                error: 'Tropas insuficientes para concluir toda a seleção.',
              };
            }
            break;
          }

          // Check if all targets for the current phase are now covered
          const remaining = filterPlunderTargetsForPhase(
            scan.targets,
            config,
            currentPhase,
            coveredSet
          );

          if (remaining.length === 0) {
            state.coveredTargetCoords = [];
            if (currentPhase === 'primary' && config.enableTemplateCFollowUp) {
              state.farmPhase = 'template_c';
              this.emitState(state);
              // Continue immediately into Model C pass if troops allow
              continue;
            } else {
              state.farmPhase = 'primary';
              this.emitState(state);
              break;
            }
          } else {
            break;
          }
        }
      }

      // Phase 25: Player / Custom Farm Routes via Rally Point
      if ((config.mode === 'players' || config.mode === 'both') && (isSingleRun || state.running)) {
        const dueRoutes = selectDuePlayerFarmTargets(config.playerTargets);
        const originCoords =
          config.originCoords || account.villages?.[0]?.coords || '500|500';
        const originVillageId =
          config.originVillageId || account.villages?.[0]?.id;

        for (const route of dueRoutes) {
          if (!isSingleRun && !this.ensureState(config).running) break;
          if (config.dailyMaxAttacks > 0 && state.attacksToday >= config.dailyMaxAttacks) {
            this.stopConfig(
              config.id,
              'daily_limit',
              `Limite diário de ${config.dailyMaxAttacks} ataques atingido.`
            );
            return { success: true, state: { ...this.ensureState(config) } };
          }

          const now = Date.now();
          const tempCmd: ScheduledCommand = {
            id: `autofarm-${crypto.randomUUID()}`,
            accountId: config.accountId,
            accountName: account.username,
            originVillageId,
            originCoords,
            targetCoords: route.coords,
            commandType: 'attack',
            slowestUnit: detectSlowestUnitFromTroops(route.troops) || 'light',
            troops: route.troops,
            waves: 1,
            distance: 0,
            travelTimeMs: 0,
            sendTimeMs: now,
            arrivalTimeMs: now,
            triggerBeforeMs: 30000,
            status: 'scheduled',
            createdAt: new Date(now).toISOString(),
          };

          const prep = await this.sessionManager.prepareRallyPoint(tempCmd);
          if (!prep.success) {
            state.lastError = prep.error;
            continue;
          }
          const sent = await this.sessionManager.dispatchRallyPointCommand(tempCmd);
          if (sent.success) {
            this.store.markPlayerFarmTargetAttacked(config.id, route.id);
            state.attacksToday += 1;
            state.attacksThisCycle += 1;
            this.emitState(state);
          } else {
            state.lastError = sent.error;
          }

          const delay = computeHumanizedDelayMs(config.minDelayMs, config.maxDelayMs);
          await sleepMs(delay);
        }
      }

      state.lastRunAt = new Date().toISOString();
      if (!isSingleRun && state.running) {
        this.scheduleNextCycle(config, state);
      }
      this.emitState(state);

      if (state.attacksThisCycle > 0) {
        this.store.addLog({
          accountId: config.accountId,
          accountName: account.username,
          level: 'success',
          message: `[Auto-Farm] Ciclo (${config.name || config.originCoords || 'Geral'}): ${state.attacksThisCycle} ataque(s) enviado(s) (${state.attacksToday} hoje).`,
        });
      }

      return { success: true, state: { ...state } };
    } finally {
      this.activeLocks.delete(config.id);
    }
  }
}
