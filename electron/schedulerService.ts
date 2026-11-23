import { BrowserWindow, powerSaveBlocker } from 'electron';
import type { DataStore } from './store';
import type { SessionManager } from './sessionManager';
import type { ScheduledCommand } from './types';

const MAX_TIMEOUT_MS = 2_000_000_000;

export class SchedulerService {
  private readonly store: DataStore;
  private readonly sessionManager: SessionManager;
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private readonly sendTimers = new Map<string, NodeJS.Timeout>();
  private readonly cancelTimers = new Map<string, NodeJS.Timeout>();
  private blockerId: number | null = null;

  constructor(store: DataStore, sessionManager: SessionManager) {
    this.store = store;
    this.sessionManager = sessionManager;
    this.rescheduleAll();
  }

  public rescheduleAll(): void {
    this.clearTimersOnly();
    const now = Date.now();
    const commands = this.store.getScheduledCommands();
    for (const cmd of commands) {
      if (cmd.status === 'scheduled' || cmd.status === 'pending' || cmd.status === 'waking') {
        if (cmd.sendTimeMs <= now - 5000) {
          this.store.updateScheduledCommand(cmd.id, {
            status: 'failed',
            error: 'Horário de envio expirado enquanto o agendador estava inativo.',
            resolvedAt: new Date().toISOString(),
          });
        } else {
          this.scheduleCommandTimers(cmd);
        }
      } else if (cmd.status === 'dodging' && cmd.autoDodge?.enabled) {
        if (cmd.autoDodge.cancelTimeMs >= now - 60000) {
          this.scheduleCancelTimer(cmd);
        }
      }
    }
    this.updatePowerSaveBlocker();
  }

  private clearTimersOnly(): void {
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    for (const timer of this.sendTimers.values()) clearTimeout(timer);
    for (const timer of this.cancelTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.sendTimers.clear();
    this.cancelTimers.clear();
  }

  private updatePowerSaveBlocker(): void {
    const activeCount = this.sendTimers.size + this.cancelTimers.size;
    if (activeCount > 0 && this.blockerId === null) {
      try {
        if (powerSaveBlocker && typeof powerSaveBlocker.start === 'function') {
          this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
        }
      } catch {
        // Ignore if unsupported in current environment
      }
    } else if (activeCount === 0 && this.blockerId !== null) {
      try {
        if (powerSaveBlocker && typeof powerSaveBlocker.stop === 'function') {
          powerSaveBlocker.stop(this.blockerId);
        }
      } catch {
        // Ignore
      }
      this.blockerId = null;
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, payload);
        } catch {
          // Ignore destroyed webContents
        }
      }
    }
  }

  public scheduleCommandTimers(cmd: ScheduledCommand): void {
    const existingWake = this.wakeTimers.get(cmd.id);
    if (existingWake) clearTimeout(existingWake);
    this.wakeTimers.delete(cmd.id);
    const existingSend = this.sendTimers.get(cmd.id);
    if (existingSend) clearTimeout(existingSend);
    this.sendTimers.delete(cmd.id);

    const now = Date.now();
    if (!Number.isFinite(cmd.sendTimeMs) || cmd.sendTimeMs <= now) {
      const updated = this.store.updateScheduledCommand(cmd.id, {
        status: 'failed',
        error: 'Horário de envio inválido ou já expirado. Comando não disparado automaticamente.',
        resolvedAt: new Date().toISOString(),
      });
      this.store.addLog({
        accountId: cmd.accountId,
        accountName: cmd.accountName,
        level: 'error',
        message: `[Agendador] Comando ${cmd.originCoords} -> ${cmd.targetCoords} recusado: horário de envio inválido ou no passado.`,
      });
      this.broadcast('scheduler:updated', updated || cmd);
      this.updatePowerSaveBlocker();
      return;
    }

    const wakeAtMs = cmd.sendTimeMs - (cmd.triggerBeforeMs || 30000);
    if (wakeAtMs > now) {
      const remainingWake = wakeAtMs - now;
      if (remainingWake > MAX_TIMEOUT_MS) {
        const wakeTimer = setTimeout(() => {
          this.wakeTimers.delete(cmd.id);
          const current = this.store.getScheduledCommands().find((c) => c.id === cmd.id);
          if (
            current &&
            (current.status === 'scheduled' || current.status === 'pending' || current.status === 'waking')
          ) {
            this.scheduleCommandTimers(current);
          }
        }, MAX_TIMEOUT_MS);
        this.wakeTimers.set(cmd.id, wakeTimer);
      } else {
        const wakeTimer = setTimeout(() => {
          this.wakeTimers.delete(cmd.id);
          this.fireWake(cmd);
        }, remainingWake);
        this.wakeTimers.set(cmd.id, wakeTimer);
      }
    } else if (cmd.sendTimeMs - now > 2500) {
      // Only fire a separate wake pre-warm if there is at least 2.5s before sendTimeMs;
      // otherwise executeSend will run prepareRallyPoint + dispatch in one continuous step without racing!
      this.fireWake(cmd);
    }

    const remainingSend = cmd.sendTimeMs - now;
    if (remainingSend > MAX_TIMEOUT_MS) {
      const sendTimer = setTimeout(() => {
        this.sendTimers.delete(cmd.id);
        const current = this.store.getScheduledCommands().find((c) => c.id === cmd.id);
        if (
          current &&
          (current.status === 'scheduled' || current.status === 'pending' || current.status === 'waking')
        ) {
          this.scheduleCommandTimers(current);
        } else {
          this.updatePowerSaveBlocker();
        }
      }, MAX_TIMEOUT_MS);
      this.sendTimers.set(cmd.id, sendTimer);
    } else {
      const sendTimer = setTimeout(() => {
        this.sendTimers.delete(cmd.id);
        const current = this.store.getScheduledCommands().find((c) => c.id === cmd.id);
        if (
          !current ||
          !(current.status === 'scheduled' || current.status === 'pending' || current.status === 'waking')
        ) {
          this.updatePowerSaveBlocker();
          return;
        }
        if (current.sendTimeMs - Date.now() > 50) {
          this.scheduleCommandTimers(current);
          return;
        }
        this.executeSend(cmd.id);
      }, remainingSend);
      this.sendTimers.set(cmd.id, sendTimer);
    }

    if (cmd.autoDodge?.enabled && cmd.autoDodge.cancelTimeMs) {
      this.scheduleCancelTimer(cmd);
    }

    this.updatePowerSaveBlocker();
  }

  private scheduleCancelTimer(cmd: ScheduledCommand): void {
    if (!cmd.autoDodge?.enabled || !cmd.autoDodge.cancelTimeMs) return;
    const existingCancel = this.cancelTimers.get(cmd.id);
    if (existingCancel) clearTimeout(existingCancel);

    const cancelDelay = Math.max(0, Math.min(cmd.autoDodge.cancelTimeMs - Date.now(), 2_000_000_000));
    const timer = setTimeout(() => {
      this.cancelTimers.delete(cmd.id);
      this.executeCancelDodge(cmd.id);
    }, cancelDelay);
    this.cancelTimers.set(cmd.id, timer);
    this.updatePowerSaveBlocker();
  }

  private async fireWake(cmd: ScheduledCommand): Promise<void> {
    const updated = this.store.updateScheduledCommand(cmd.id, { status: 'waking' });
    this.store.addLog({
      accountId: cmd.accountId,
      accountName: cmd.accountName,
      level: 'info',
      message: `[Wake] Preparando Praça de Reunião e tela de confirmação para ${cmd.originCoords} -> ${cmd.targetCoords} (${cmd.commandType.toUpperCase()})`,
    });
    // Pre-warm the session window on the Rally Point and advance to the Confirmation Screen (#troop_confirm_submit)
    const prep = await this.sessionManager.prepareRallyPoint(cmd);
    if (!prep.success && prep.error) {
      this.store.addLog({
        accountId: cmd.accountId,
        accountName: cmd.accountName,
        level: 'warn',
        message: `[Wake] Aviso no preparo prévio de ${cmd.originCoords} -> ${cmd.targetCoords}: ${prep.error} (nova tentativa ocorrerá no horário de envio)`,
      });
    } else {
      this.store.addLog({
        accountId: cmd.accountId,
        accountName: cmd.accountName,
        level: 'info',
        message: `[Wake] Tela de confirmação pronta (#troop_confirm_submit) para ${cmd.originCoords} -> ${cmd.targetCoords}. Aguardando horário exato de disparo.`,
      });
    }
    this.broadcast('scheduler:wake', updated || cmd);
  }

  public async executeSend(commandId: string): Promise<{ success: boolean; error?: string }> {
    const existingWake = this.wakeTimers.get(commandId);
    if (existingWake) {
      clearTimeout(existingWake);
      this.wakeTimers.delete(commandId);
    }
    const existingSend = this.sendTimers.get(commandId);
    if (existingSend) {
      clearTimeout(existingSend);
      this.sendTimers.delete(commandId);
    }

    const cmd = this.store.getScheduledCommands().find((c) => c.id === commandId);
    if (!cmd) {
      this.updatePowerSaveBlocker();
      return { success: false, error: 'Comando não encontrado.' };
    }

    const res = await this.sessionManager.dispatchRallyPointCommand(cmd);

    if (res.success && cmd.autoDodge?.enabled) {
      const updated = this.store.updateScheduledCommand(commandId, {
        status: 'dodging',
        error: undefined,
        autoDodge: {
          ...cmd.autoDodge,
          outgoingCommandId: res.outgoingCommandId || cmd.autoDodge.outgoingCommandId,
          cancelStatus: 'pending',
        },
      });
      this.store.addLog({
        accountId: cmd.accountId,
        accountName: cmd.accountName,
        level: 'info',
        message: `[Auto-Dodge] Tropas retiradas (${cmd.originCoords} -> ${cmd.targetCoords}). Cancelamento agendado para ${new Date(cmd.autoDodge.cancelTimeMs).toLocaleTimeString('pt-BR')}.`,
      });
      this.scheduleCancelTimer(updated || cmd);
      this.updatePowerSaveBlocker();
      this.broadcast('scheduler:updated', updated);
      return res;
    }

    if (!res.success) {
      const existingCancel = this.cancelTimers.get(commandId);
      if (existingCancel) {
        clearTimeout(existingCancel);
        this.cancelTimers.delete(commandId);
      }
    }

    const finalStatus = res.success ? 'sent' : 'failed';
    const updated = this.store.updateScheduledCommand(commandId, {
      status: finalStatus,
      error: res.error,
      resolvedAt: new Date().toISOString(),
    });

    this.store.addLog({
      accountId: cmd.accountId,
      accountName: cmd.accountName,
      level: res.success ? 'success' : 'error',
      message: res.success
        ? `[Agendador] Comando confirmado e enviado com sucesso: ${cmd.originCoords} -> ${cmd.targetCoords} (${cmd.commandType.toUpperCase()})`
        : `[Agendador] Falha ao enviar ${cmd.originCoords} -> ${cmd.targetCoords}: ${res.error}`,
    });

    this.updatePowerSaveBlocker();
    this.broadcast('scheduler:updated', updated);
    return res;
  }

  public async executeCancelDodge(
    commandId: string
  ): Promise<{ success: boolean; commandId?: string; error?: string }> {
    const existingCancel = this.cancelTimers.get(commandId);
    if (existingCancel) {
      clearTimeout(existingCancel);
      this.cancelTimers.delete(commandId);
    }

    const cmd = this.store.getScheduledCommands().find((c) => c.id === commandId);
    if (!cmd || !cmd.autoDodge?.enabled) {
      this.updatePowerSaveBlocker();
      return { success: false, error: 'Comando Auto-Dodge não encontrado.' };
    }

    this.store.updateScheduledCommand(commandId, {
      autoDodge: {
        ...cmd.autoDodge,
        cancelStatus: 'cancelling',
      },
    });

    const res = await this.sessionManager.cancelRallyPointCommand(cmd);
    const nowIso = new Date().toISOString();
    const updated = this.store.updateScheduledCommand(commandId, {
      status: res.success ? 'dodged' : 'failed',
      error: res.success ? undefined : res.error,
      resolvedAt: nowIso,
      autoDodge: {
        ...cmd.autoDodge,
        outgoingCommandId: res.commandId || cmd.autoDodge.outgoingCommandId,
        cancelStatus: res.success ? 'cancelled_ok' : 'cancel_failed',
        cancelError: res.error,
        cancelledAt: res.success ? nowIso : undefined,
      },
    });

    this.store.addLog({
      accountId: cmd.accountId,
      accountName: cmd.accountName,
      level: res.success ? 'success' : 'error',
      message: res.success
        ? `[Auto-Dodge] Apoio cancelado com sucesso! Tropas retornando ilesas para ${cmd.originCoords}.`
        : `[Auto-Dodge] Falha ao cancelar apoio (${cmd.originCoords} -> ${cmd.targetCoords}): ${res.error}`,
    });

    this.updatePowerSaveBlocker();
    this.broadcast('scheduler:updated', updated);
    return res;
  }

  public cancelCommand(commandId: string): boolean {
    const w = this.wakeTimers.get(commandId);
    if (w) clearTimeout(w);
    this.wakeTimers.delete(commandId);

    const s = this.sendTimers.get(commandId);
    if (s) clearTimeout(s);
    this.sendTimers.delete(commandId);

    const c = this.cancelTimers.get(commandId);
    if (c) clearTimeout(c);
    this.cancelTimers.delete(commandId);

    this.sessionManager.releaseCommandWindow(commandId, true);
    const removed = this.store.deleteScheduledCommand(commandId);
    this.updatePowerSaveBlocker();
    return removed;
  }

  public clearAccount(accountId: string): void {
    const list = this.store.getScheduledCommands(accountId);
    for (const c of list) {
      this.cancelCommand(c.id);
    }
    this.store.clearScheduledCommands(accountId);
    this.updatePowerSaveBlocker();
  }

  public clearAll(): void {
    this.clearTimersOnly();
    this.store.clearScheduledCommands();
    this.updatePowerSaveBlocker();
  }

  public getStats(): {
    activeTimers: number;
    powerBlockerActive: boolean;
    nextSendTimeMs: number | null;
  } {
    const active = this.store
      .getScheduledCommands()
      .filter((c) => c.status === 'scheduled' || c.status === 'waking' || c.status === 'dodging');
    const nextSendTimeMs =
      active.length > 0 ? Math.min(...active.map((c) => c.sendTimeMs)) : null;
    return {
      activeTimers: this.sendTimers.size + this.cancelTimers.size,
      powerBlockerActive: this.blockerId !== null,
      nextSendTimeMs,
    };
  }
}
