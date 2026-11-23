import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Castle,
  Clock,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Hammer,
  Layers,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Sprout,
  Square,
  Sword,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  ActivityLogEntry,
  AppSettings,
  AutoFarmConfig,
  AutoFarmRuntimeState,
  ConstructionModel,
  FarmPlunderTarget,
  ProxyConfig,
  RecruitmentModel,
  ScheduledCommand,
  SessionStatus,
  TroopModelPreset,
  TwAccount,
  TwVillage,
} from './types';
import { AccountModal } from './components/AccountModal';
import { AccountDetailModal } from './components/AccountDetailModal';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ToastStack, type ToastItem } from './components/ui/ToastStack';

const SchedulerView = lazy(() =>
  import('./components/SchedulerView').then((m) => ({ default: m.SchedulerView }))
);
const VillagesView = lazy(() =>
  import('./components/VillagesView').then((m) => ({ default: m.VillagesView }))
);
const TaggerView = lazy(() =>
  import('./components/TaggerView').then((m) => ({ default: m.TaggerView }))
);
const ModelsView = lazy(() =>
  import('./components/ModelsView').then((m) => ({ default: m.ModelsView }))
);
const AutoFarmView = lazy(() =>
  import('./components/AutoFarmView').then((m) => ({ default: m.AutoFarmView }))
);

type ActiveTab =
  | 'accounts'
  | 'scheduler'
  | 'villages'
  | 'tagger'
  | 'models'
  | 'autofarm'
  | 'multiview'
  | 'proxies'
  | 'logs'
  | 'settings';

const FALLBACK_WORLDS: Record<string, Record<string, string>> = {
  'tribalwars.com.br': {
    br128: 'https://br128.tribalwars.com.br',
    br129: 'https://br129.tribalwars.com.br',
    br130: 'https://br130.tribalwars.com.br',
    br131: 'https://br131.tribalwars.com.br',
    brs1: 'https://brs1.tribalwars.com.br',
  },
  'tribalwars.com.pt': {
    pt104: 'https://pt104.tribalwars.com.pt',
    pt105: 'https://pt105.tribalwars.com.pt',
    pts1: 'https://pts1.tribalwars.com.pt',
  },
  'tribalwars.net': {
    en141: 'https://en141.tribalwars.net',
    en142: 'https://en142.tribalwars.net',
    ens1: 'https://ens1.tribalwars.net',
  },
};

const TAB_META: Record<ActiveTab, { title: string; subtitle: string }> = {
  accounts: {
    title: 'Gerenciamento de Contas Tribal Wars',
    subtitle: 'Gerencie perfis isolados, proxies dedicados e sessões ativas por mundo',
  },
  scheduler: {
    title: 'Agendador de Comandos, NTs e Apoios',
    subtitle: 'Planeje ataques coordenados, Noble Trains e apoios com disparo no milissegundo exato',
  },
  villages: {
    title: 'Sincronizador de Aldeias e Produção',
    subtitle: 'Consulte recursos, população, tropas em casa e abra atalhos por aldeia',
  },
  tagger: {
    title: 'Monitor de Ataques a Chegar & Etiquetador (Tagger)',
    subtitle: 'Identifique a unidade mais lenta dos ataques recebidos, agende Auto-Dodge e encaixe Snips',
  },
  models: {
    title: 'Modelos de Construção e Recrutamento',
    subtitle: 'Crie templates de evolução e composição de tropas vinculados às suas contas',
  },
  autofarm: {
    title: 'Auto-Farm (Assistente de Saque & Rotas)',
    subtitle: 'Automatize envios no Assistente de Saque e rotas personalizadas com controle de segurança',
  },
  multiview: {
    title: 'Central Multi-Sessão (Janelas Isoladas)',
    subtitle: 'Alterne entre janelas abertas e acesse telas diretas do jogo sem trocar de perfil',
  },
  proxies: {
    title: 'Gerenciador e Testador de Proxies',
    subtitle: 'Cadastre servidores HTTP/HTTPS/SOCKS5 e valide conectividade e latência',
  },
  logs: {
    title: 'Histórico e Registro de Ações',
    subtitle: 'Acompanhe eventos de conexão, disparos agendados e alertas das sessões',
  },
  settings: {
    title: 'Configurações do Aplicativo',
    subtitle: 'Defina servidor regional e mundo padrão para novas contas cadastradas',
  },
};

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('accounts');
  const [accounts, setAccounts] = useState<TwAccount[]>([]);
  const [proxies, setProxies] = useState<ProxyConfig[]>([]);
  const [scheduledCommands, setScheduledCommands] = useState<ScheduledCommand[]>([]);
  const [schedulerPresets, setSchedulerPresets] = useState<TroopModelPreset[]>([]);
  const [constructionModels, setConstructionModels] = useState<ConstructionModel[]>([]);
  const [recruitmentModels, setRecruitmentModels] = useState<RecruitmentModel[]>([]);
  const [autoFarmConfigs, setAutoFarmConfigs] = useState<Record<string, AutoFarmConfig>>({});
  const [autoFarmStates, setAutoFarmStates] = useState<Record<string, AutoFarmRuntimeState>>({});
  const [logs, setLogs] = useState<ActivityLogEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    defaultDomain: 'tribalwars.com.br',
    defaultWorld: 'br130',
    autoRestoreSessions: false,
    theme: 'dark',
  });

  // Filters & Modals
  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | SessionStatus>('ALL');
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<TwAccount | null>(null);
  const [detailAccount, setDetailAccount] = useState<TwAccount | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);

  // Proxy form state
  const [newProxyLabel, setNewProxyLabel] = useState('');
  const [newProxyProtocol, setNewProxyProtocol] = useState<
    'http' | 'https' | 'socks4' | 'socks5'
  >('http');
  const [newProxyHost, setNewProxyHost] = useState('');
  const [newProxyPort, setNewProxyPort] = useState('8080');
  const [newProxyUser, setNewProxyUser] = useState('');
  const [newProxyPass, setNewProxyPass] = useState('');
  const [testingProxyId, setTestingProxyId] = useState<string | null>(null);

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (msg: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, message: msg }]);
      const timer = setTimeout(() => {
        toastTimersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
      toastTimersRef.current.set(id, timer);
    },
    []
  );

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const refreshAll = useCallback(async () => {
    const api = window.electronAPI;
    if (api) {
      const [
        accList,
        proxyList,
        cmdList,
        presetList,
        constList,
        recList,
        logList,
        cfg,
        farmSnap,
      ] = await Promise.all([
        api.store.accounts.list(),
        api.store.proxies.list(),
        api.scheduler.list(),
        api.scheduler.presets(),
        api.store.constructionModels.list(),
        api.store.recruitmentModels.list(),
        api.store.logs.list(),
        api.store.settings.get(),
        api.autoFarm.getStates(),
      ]);
      setAccounts(accList);
      setProxies(proxyList);
      setScheduledCommands(cmdList);
      setSchedulerPresets(presetList);
      setConstructionModels(constList);
      setRecruitmentModels(recList);
      setLogs(logList);
      setSettings(cfg);
      setAutoFarmConfigs(farmSnap?.configs || {});
      setAutoFarmStates(farmSnap?.states || {});
    } else {
      const rawAcc = localStorage.getItem('tw_accounts');
      if (rawAcc) setAccounts(JSON.parse(rawAcc));
      const rawPrx = localStorage.getItem('tw_proxies');
      if (rawPrx) setProxies(JSON.parse(rawPrx));
    }
  }, []);

  useEffect(() => {
    refreshAll();
    const api = window.electronAPI;
    if (!api) return;
    const unsubStatus = api.browser.onStatusChange((_event, payload) => {
      setAccounts((prev) =>
        prev.map((acc) =>
          acc._id === payload.accountId
            ? {
                ...acc,
                status: payload.status,
                lastError: payload.error,
                playerInfo: payload.playerInfo || acc.playerInfo,
              }
            : acc
        )
      );
      api.store.logs.list().then(setLogs).catch(() => {});
    });

    const unsubWake = api.scheduler.onWake((_event, cmd) => {
      notify(
        `[Agendador] Preparando Praça de Reunião: ${cmd.accountName} (${cmd.originCoords} → ${cmd.targetCoords})`
      );
      refreshAll();
    });

    const unsubUpdated = api.scheduler.onUpdated((_event, cmd) => {
      notify(
        `[Agendador] Comando ${cmd.status.toUpperCase()}: ${cmd.originCoords} → ${cmd.targetCoords}`
      );
      refreshAll();
    });

    const unsubFarm = api.autoFarm.onStateChanged((_event, farmState) => {
      const stateKey = farmState.configId || farmState.accountId;
      setAutoFarmStates((prev) => ({ ...prev, [stateKey]: farmState }));
      if (farmState.pausedReason && farmState.pausedReason !== 'manual') {
        notify(`[Auto-Farm] Pausado (${farmState.pausedReason}): ${farmState.lastError || ''}`);
      }
    });

    return () => {
      unsubStatus();
      unsubWake();
      unsubUpdated();
      unsubFarm();
    };
  }, [refreshAll, notify]);

  const fetchServers = useCallback(async (domain: string): Promise<Record<string, string>> => {
    if (window.electronAPI) {
      return window.electronAPI.game.getServers(domain);
    }
    return FALLBACK_WORLDS[domain] || FALLBACK_WORLDS['tribalwars.com.br'];
  }, []);

  const handleSaveAccount = async (payload: Partial<TwAccount>) => {
    const api = window.electronAPI;
    if (api) {
      if (payload._id) {
        await api.store.accounts.update(payload._id, payload);
        notify(`Conta "${payload.username}" atualizada.`);
      } else {
        await api.store.accounts.create(payload);
        notify(`Conta "${payload.username}" adicionada.`);
      }
      await refreshAll();
    } else {
      const next: TwAccount = {
        _id: payload._id || crypto.randomUUID(),
        username: payload.username || 'Nova Conta',
        domain: payload.domain || 'tribalwars.com.br',
        world: payload.world || 'br130',
        serverUrl:
          payload.serverUrl ||
          `https://${payload.world || 'br130'}.${payload.domain || 'tribalwars.com.br'}`,
        group: payload.group || 'Geral',
        notes: payload.notes || '',
        credentials: payload.credentials,
        proxy: payload.proxy,
        cookies: payload.cookies || [],
        status: 'offline',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const updated = payload._id
        ? accounts.map((a) => (a._id === payload._id ? next : a))
        : [...accounts, next];
      setAccounts(updated);
      localStorage.setItem('tw_accounts', JSON.stringify(updated));
      notify(`Conta "${next.username}" salva.`);
    }
  };

  const handleDeleteAccount = async (acc: TwAccount) => {
    if (window.electronAPI) {
      await window.electronAPI.store.accounts.delete(acc._id);
      await refreshAll();
    } else {
      const updated = accounts.filter((a) => a._id !== acc._id);
      setAccounts(updated);
      localStorage.setItem('tw_accounts', JSON.stringify(updated));
    }
    notify(`Conta "${acc.username}" removida.`);
  };

  const handleOpenVisibleSession = async (acc: TwAccount, targetUrl?: string) => {
    if (window.electronAPI) {
      const res = await window.electronAPI.browser.openVisible({
        accountId: acc._id,
        pagina: targetUrl,
      });
      if (!res.success && res.error) {
        notify(`Erro em ${acc.username}: ${res.error}`);
      } else {
        notify(`Janela Tribal Wars aberta para ${acc.username} (${acc.world.toUpperCase()}).`);
      }
      await refreshAll();
    } else {
      const url = targetUrl || acc.serverUrl || `https://${acc.world}.${acc.domain}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleOpenNewWindow = async (acc: TwAccount, targetUrl?: string) => {
    if (window.electronAPI) {
      const res = await window.electronAPI.browser.openNewWindow({
        accountId: acc._id,
        targetUrl,
      });
      if (!res.success && res.error) {
        notify(`Erro ao abrir nova janela: ${res.error}`);
      } else {
        notify(`Nova janela aberta para ${acc.username} (${acc.world.toUpperCase()}).`);
      }
      await refreshAll();
    } else {
      const url = targetUrl || acc.serverUrl || `https://${acc.world}.${acc.domain}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleStartBackgroundSession = async (acc: TwAccount) => {
    if (window.electronAPI) {
      const res = await window.electronAPI.browser.startSession({
        accountId: acc._id,
        visible: false,
      });
      if (res.success) {
        notify(`Sessão em segundo plano iniciada para ${acc.username}.`);
      } else {
        notify(`Falha ao iniciar ${acc.username}: ${res.error || 'Erro desconhecido'}`);
      }
      await refreshAll();
    } else {
      handleOpenVisibleSession(acc);
    }
  };

  const handleStopSession = async (acc: TwAccount) => {
    if (window.electronAPI) {
      await window.electronAPI.browser.stopSession(acc._id);
      notify(`Sessão de ${acc.username} encerrada.`);
      await refreshAll();
    }
  };

  const handleOpenGameScreen = async (acc: TwAccount, screen: string) => {
    const base = acc.serverUrl || `https://${acc.world}.${acc.domain}`;
    const targetUrl = `${base}/game.php?screen=${screen}`;
    await handleOpenVisibleSession(acc, targetUrl);
  };

  const handleOpenVillageScreen = async (
    acc: TwAccount,
    villageId: string,
    screen: string
  ) => {
    const base = acc.serverUrl || `https://${acc.world}.${acc.domain}`;
    const targetUrl = `${base}/game.php?village=${villageId}&screen=${screen}`;
    await handleOpenVisibleSession(acc, targetUrl);
  };

  const handleExportCookies = async (accountId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.browser.exportCookies(accountId);
    if (res.success) {
      notify(`${res.cookies.length} cookies salvos da sessão ativa.`);
      await refreshAll();
    }
  };

  const handleReloadSession = async (accountId: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.browser.reloadPage(accountId);
    notify('Página da sessão recarregada.');
  };

  // Feature 1: Scheduler handlers
  const handleCreateScheduledCommand = async (
    payload: Partial<ScheduledCommand> & {
      timingMode?: 'arrival' | 'send';
      worldSpeed?: number;
      unitSpeed?: number;
    }
  ) => {
    if (!window.electronAPI) return;
    const created = await window.electronAPI.scheduler.create(payload);
    notify(
      `Comando agendado para envio às ${new Date(created.sendTimeMs).toLocaleTimeString('pt-BR')}`
    );
    await refreshAll();
  };

  const handleCreateBatchScheduledCommands = async (
    payloads: Array<
      Partial<ScheduledCommand> & {
        timingMode?: 'arrival' | 'send';
        worldSpeed?: number;
        unitSpeed?: number;
      }
    >
  ) => {
    if (!window.electronAPI || payloads.length === 0) return;
    const created = await window.electronAPI.scheduler.createBatch(payloads);
    notify(
      `[Planejador OP] ${created.length} comando(s) enfileirado(s) para envio automático!`
    );
    await refreshAll();
  };

  const handleTriggerScheduledNow = async (commandId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.scheduler.triggerNow(commandId);
    if (res.success) {
      notify('Comando confirmado e enviado automaticamente na Praça de Reunião!');
    } else {
      notify(`Falha ao enviar comando: ${res.error}`);
    }
    await refreshAll();
  };

  const handleSyncWorldAndVillages = async (_accountId: string) => {
    await refreshAll();
  };

  const handleCancelScheduled = async (commandId: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.scheduler.cancel(commandId);
    notify('Comando removido do Agendador.');
    await refreshAll();
  };

  const handleCreateDodgeCommand = async (payload: {
    accountId: string;
    accountName?: string;
    originVillageId?: string;
    originCoords: string;
    targetCoords?: string;
    incomingCommandId?: string;
    attackerName?: string;
    enemyArrivalTimeMs: number;
    dodgeBeforeSec?: number;
    cancelAfterSec?: number;
    sendAllTroops?: boolean;
    troops?: Partial<Record<'spear' | 'sword' | 'axe' | 'archer' | 'spy' | 'light' | 'marcher' | 'heavy' | 'ram' | 'catapult' | 'knight' | 'snob', number>>;
    triggerBeforeMs?: number;
    notes?: string;
  }) => {
    if (!window.electronAPI) return;
    const created = await window.electronAPI.scheduler.createDodge(payload);
    notify(
      `[Auto-Dodge] Evasão agendada (${created.originCoords} → ${created.targetCoords}) | Envio: ${new Date(created.sendTimeMs).toLocaleTimeString('pt-BR')}`
    );
    await refreshAll();
  };

  const handleCancelDodgeNow = async (commandId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.scheduler.cancelDodgeNow(commandId);
    if (res.success) {
      notify('[Auto-Dodge] Apoio cancelado com sucesso! Tropas retornando.');
    } else {
      notify(`[Auto-Dodge] Falha ao cancelar apoio: ${res.error}`);
    }
    await refreshAll();
  };

  const handleClearAllScheduled = async () => {
    if (!window.electronAPI) return;
    await window.electronAPI.scheduler.clearAll();
    notify('Fila do Agendador limpa.');
    await refreshAll();
  };

  // Feature 2: Villages handlers
  const handleSyncVillages = async (accountId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.game.fetchVillages(accountId);
    if (res.success) {
      notify(`${res.villages.length} aldeias sincronizadas da sessão ativa.`);
    } else {
      notify(`Aviso ao sincronizar aldeias: ${res.error}`);
    }
    await refreshAll();
  };

  const handleSyncCombinedVillages = async (accountId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.game.fetchCombinedVillages({ accountId, groupId: '0' });
    if (res.success) {
      notify(`[Visão Combinada] ${res.villages.length} aldeia(s) e tropas sincronizadas!`);
    } else {
      notify(`Aviso ao sincronizar tropas: ${res.error}`);
    }
    await refreshAll();
  };

  const handleAddManualVillage = async (accountId: string, village: TwVillage) => {
    const acc = accounts.find((a) => a._id === accountId);
    if (!acc) return;
    const nextVillages = [...(acc.villages || []), village];
    if (window.electronAPI) {
      await window.electronAPI.store.accounts.update(accountId, {
        villages: nextVillages,
        playerInfo: { ...acc.playerInfo, villagesCount: nextVillages.length },
      });
      await refreshAll();
    }
    notify(`Aldeia ${village.name} (${village.coords}) adicionada.`);
  };

  // Feature 3: Incoming Attacks Tagger handlers
  const handleSyncIncomings = async (accountId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.game.fetchIncomingAttacks(accountId);
    if (res.success) {
      notify(`${res.incomings.length} ataque(s) a chegar sincronizado(s).`);
    } else {
      notify(`Aviso: ${res.error}`);
    }
    await refreshAll();
  };

  // Feature 4: Construction & Recruitment Models handlers
  const handleSaveConstructionModel = async (
    model: Partial<ConstructionModel> & { name: string }
  ) => {
    if (!window.electronAPI) return;
    await window.electronAPI.store.constructionModels.save(model);
    notify(`Modelo de construção "${model.name}" salvo.`);
    await refreshAll();
  };

  const handleDeleteConstructionModel = async (id: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.store.constructionModels.delete(id);
    notify('Modelo de construção removido.');
    await refreshAll();
  };

  const handleSaveRecruitmentModel = async (
    model: Partial<RecruitmentModel> & { name: string }
  ) => {
    if (!window.electronAPI) return;
    await window.electronAPI.store.recruitmentModels.save(model);
    notify(`Modelo de recrutamento "${model.name}" salvo.`);
    await refreshAll();
  };

  const handleDeleteRecruitmentModel = async (id: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.store.recruitmentModels.delete(id);
    notify('Modelo de recrutamento removido.');
    await refreshAll();
  };

  const handleAssignModelsToAccount = async (
    accountId: string,
    constructionModelId?: string,
    recruitmentModelId?: string
  ) => {
    if (!window.electronAPI) return;
    await window.electronAPI.store.accounts.update(accountId, {
      constructionModelId,
      recruitmentModelId,
    });
    notify('Modelos vinculados à conta atualizados.');
    await refreshAll();
  };

  // Wave 7: Auto-Farm handlers
  const handleSaveAutoFarmConfig = async (
    config: Partial<AutoFarmConfig> & { accountId: string }
  ): Promise<AutoFarmConfig | undefined> => {
    if (!window.electronAPI) return undefined;
    const saved = await window.electronAPI.autoFarm.saveConfig(config);
    setAutoFarmConfigs((prev) => ({ ...prev, [saved.id]: saved }));
    notify(`[Auto-Farm] Configuração "${saved.name || saved.originCoords || 'Aldeia'}" salva.`);
    return saved;
  };

  const handleDeleteAutoFarmConfig = async (configId: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.autoFarm.deleteConfig(configId);
    setAutoFarmConfigs((prev) => {
      const next = { ...prev };
      delete next[configId];
      return next;
    });
    setAutoFarmStates((prev) => {
      const next = { ...prev };
      delete next[configId];
      return next;
    });
    notify('[Auto-Farm] Configuração removida.');
  };

  const handleStartAutoFarm = async (configId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.autoFarm.start(configId);
    if (res.state) {
      setAutoFarmStates((prev) => ({ ...prev, [res.state!.configId || configId]: res.state! }));
    }
    if (!res.success && res.error) {
      notify(`[Auto-Farm] ${res.error}`);
    } else {
      notify('[Auto-Farm] Rotina iniciada!');
    }
  };

  const handleStopAutoFarm = async (configId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.autoFarm.stop(configId, 'manual');
    if (res.state) {
      setAutoFarmStates((prev) => ({ ...prev, [res.state!.configId || configId]: res.state! }));
    }
    notify('[Auto-Farm] Pausado.');
  };

  const handleRunAutoFarmOnce = async (configId: string) => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.autoFarm.runOnce(configId);
    if (res.state) {
      setAutoFarmStates((prev) => ({ ...prev, [res.state!.configId || configId]: res.state! }));
    }
    if (!res.success && res.error) {
      notify(`[Auto-Farm] ${res.error}`);
    } else {
      notify(`[Auto-Farm] Ciclo concluído (${res.state?.attacksThisCycle ?? 0} envios).`);
    }
  };

  const handleScanAutoFarm = async (
    accountId: string,
    villageId?: string
  ): Promise<FarmPlunderTarget[]> => {
    if (!window.electronAPI) return [];
    const res = await window.electronAPI.autoFarm.scanFa({ accountId, villageId });
    if (res.captchaDetected) {
      notify('[Auto-Farm] CAPTCHA detectado na janela do jogo!');
    } else if (!res.success && res.error) {
      notify(`[Auto-Farm] ${res.error}`);
    } else {
      notify(`[Auto-Farm] ${res.targets.length} alvo(s) carregado(s) do Assistente de Saque.`);
    }
    return res.targets || [];
  };

  const handleMapAutoFarmTargets = async (payload: {
    accountId: string;
    originVillageId?: string;
    originCoords: string;
    radius: number;
  }): Promise<FarmPlunderTarget[]> => {
    if (!window.electronAPI) return [];
    const res = await window.electronAPI.autoFarm.mapTargets(payload);
    if (!res.success && res.error) {
      notify(`[Auto-Farm] ${res.error}`);
    } else {
      notify(`[Auto-Farm] ${res.targets.length} bárbara(s) mapeada(s) no raio de ${payload.radius} campos.`);
    }
    return res.targets || [];
  };

  const handleAddProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProxyHost.trim()) return;
    const proxyPayload: ProxyConfig = {
      enabled: true,
      label: newProxyLabel.trim() || `${newProxyHost.trim()}:${newProxyPort}`,
      protocol: newProxyProtocol,
      host: newProxyHost.trim(),
      port: Number(newProxyPort) || 8080,
      username: newProxyUser.trim() || undefined,
      password: newProxyPass || undefined,
      lastStatus: 'untested',
    };
    if (window.electronAPI) {
      await window.electronAPI.store.proxies.save(proxyPayload);
      await refreshAll();
    } else {
      const next = [...proxies, { ...proxyPayload, id: crypto.randomUUID() }];
      setProxies(next);
      localStorage.setItem('tw_proxies', JSON.stringify(next));
    }
    setNewProxyLabel('');
    setNewProxyHost('');
    setNewProxyUser('');
    setNewProxyPass('');
    notify('Proxy adicionado à lista.');
  };

  const handleTestProxy = async (proxy: ProxyConfig) => {
    if (!window.electronAPI) {
      notify('Teste de conexão de proxy disponível apenas no aplicativo desktop.');
      return;
    }
    setTestingProxyId(proxy.id || null);
    try {
      const res = await window.electronAPI.proxy.test(proxy);
      const updated: ProxyConfig = {
        ...proxy,
        lastStatus: res.success ? 'ok' : 'error',
        lastIp: res.ip,
        latencyMs: res.latencyMs,
      };
      await window.electronAPI.store.proxies.save(updated);
      await refreshAll();
      notify(
        res.success
          ? `Proxy OK (${res.ip} — ${res.latencyMs}ms)`
          : `Falha no proxy: ${res.error}`
      );
    } finally {
      setTestingProxyId(null);
    }
  };

  const handleDeleteProxy = async (id?: string) => {
    if (!id) return;
    if (window.electronAPI) {
      await window.electronAPI.store.proxies.delete(id);
      await refreshAll();
    } else {
      const next = proxies.filter((p) => p.id !== id);
      setProxies(next);
      localStorage.setItem('tw_proxies', JSON.stringify(next));
    }
    notify('Proxy removido.');
  };

  const groups = useMemo(() => {
    const set = new Set<string>();
    accounts.forEach((a) => {
      if (a.group) set.add(a.group);
    });
    return ['ALL', ...Array.from(set)];
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (groupFilter !== 'ALL' && acc.group !== groupFilter) return false;
      if (statusFilter !== 'ALL' && acc.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchUser = acc.username.toLowerCase().includes(q);
        const matchWorld = acc.world.toLowerCase().includes(q);
        const matchGroup = (acc.group || '').toLowerCase().includes(q);
        if (!matchUser && !matchWorld && !matchGroup) return false;
      }
      return true;
    });
  }, [accounts, groupFilter, statusFilter, searchQuery]);

  const runningCount = useMemo(
    () => accounts.filter((a) => a.status === 'running' || a.status === 'starting').length,
    [accounts]
  );

  const totalIncomings = useMemo(
    () => accounts.reduce((acc, item) => acc + (item.playerInfo?.incomings || 0), 0),
    [accounts]
  );

  const activeScheduledCount = useMemo(
    () =>
      scheduledCommands.filter((c) => c.status === 'scheduled' || c.status === 'waking')
        .length,
    [scheduledCommands]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-base text-slate-100">
      {/* Sidebar */}
      <aside className="flex w-64 select-none flex-col justify-between border-r border-slate-800/80 bg-surface-sidebar p-4">
        <div className="space-y-5">
          <div className="flex items-center gap-3 px-2 py-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <Sword className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight text-slate-100">
                TW Evolution
              </div>
              <div className="text-[11px] text-emerald-400 font-medium">
                Workspace Local Ativo
              </div>
            </div>
          </div>

          <nav aria-label="Navegação principal" className="space-y-1">
            <button
              type="button"
              aria-current={activeTab === 'accounts' ? 'page' : undefined}
              onClick={() => setActiveTab('accounts')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'accounts'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <LayoutDashboard className="h-4 w-4" />
                Contas Tribal Wars
              </span>
              <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300">
                {accounts.length}
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'scheduler' ? 'page' : undefined}
              onClick={() => setActiveTab('scheduler')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'scheduler'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Clock className="h-4 w-4" />
                Agendador (NT/Ataques)
              </span>
              <span className="rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[11px] tabular-nums text-amber-300">
                {activeScheduledCount}
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'villages' ? 'page' : undefined}
              onClick={() => setActiveTab('villages')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'villages'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Castle className="h-4 w-4" />
                Aldeias & Recursos
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'tagger' ? 'page' : undefined}
              onClick={() => setActiveTab('tagger')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'tagger'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <ShieldAlert className="h-4 w-4" />
                Ataques / Etiquetador
              </span>
              {totalIncomings > 0 && (
                <span className="rounded-md bg-rose-500/20 px-1.5 py-0.5 text-[11px] tabular-nums text-rose-300">
                  {totalIncomings}
                </span>
              )}
            </button>

            <button
              type="button"
              aria-current={activeTab === 'models' ? 'page' : undefined}
              onClick={() => setActiveTab('models')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'models'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Hammer className="h-4 w-4" />
                Modelos (Build/Tropas)
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'autofarm' ? 'page' : undefined}
              onClick={() => setActiveTab('autofarm')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'autofarm'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Sprout className="h-4 w-4" />
                Auto-Farm (Saque)
              </span>
              {Object.values(autoFarmStates).some((s) => s.running) && (
                <span className="rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                  ON
                </span>
              )}
            </button>

            <button
              type="button"
              aria-current={activeTab === 'multiview' ? 'page' : undefined}
              onClick={() => setActiveTab('multiview')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'multiview'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Layers className="h-4 w-4" />
                Multi-Sessão Ativa
              </span>
              <span className="rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[11px] tabular-nums text-emerald-300">
                {runningCount}
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'proxies' ? 'page' : undefined}
              onClick={() => setActiveTab('proxies')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'proxies'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Shield className="h-4 w-4" />
                Gerenciador de Proxies
              </span>
              <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300">
                {proxies.length}
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'logs' ? 'page' : undefined}
              onClick={() => setActiveTab('logs')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'logs'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Activity className="h-4 w-4" />
                Registro de Ações
              </span>
              <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300">
                {logs.length}
              </span>
            </button>

            <button
              type="button"
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              onClick={() => setActiveTab('settings')}
              className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                activeTab === 'settings'
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Settings className="h-4 w-4" />
                Configurações
              </span>
            </button>
          </nav>
        </div>

        {/* Status Summary Footer */}
        <div className="rounded-xl border border-slate-800 bg-surface-base p-3.5 space-y-2 tabular-nums">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Sessões Online</span>
            <span className="font-semibold text-emerald-400">
              {runningCount} / {accounts.length}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Comandos na Fila</span>
            <span className="font-semibold text-amber-400">{activeScheduledCount}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Ataques Detectados</span>
            <span
              className={`font-semibold ${
                totalIncomings > 0 ? 'text-rose-400' : 'text-slate-300'
              }`}
            >
              {totalIncomings}
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="flex items-center justify-between border-b border-slate-800/80 bg-surface-sidebar/60 px-6 py-4">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-100">
              {TAB_META[activeTab].title}
            </h1>
            <p className="text-xs text-slate-400">{TAB_META[activeTab].subtitle}</p>
          </div>

          <div className="flex items-center gap-2.5">
            {activeTab === 'accounts' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    accounts.forEach((acc) => {
                      if (acc.status === 'offline') handleStartBackgroundSession(acc);
                    });
                  }}
                  disabled={accounts.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-medium text-emerald-300 transition-colors duration-150 hover:bg-emerald-500/20 active:scale-[0.98] disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5" />
                  Conectar Todas
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingAccount(null);
                    setShowAccountModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors duration-150 hover:bg-amber-400 active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" />
                  Nova Conta
                </button>
              </>
            )}
          </div>
        </header>

        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center p-8 text-xs text-slate-400">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin text-amber-400" />
                Carregando módulo...
              </div>
            }
          >
            {/* Feature 1: Scheduler View */}
            {activeTab === 'scheduler' && (
              <SchedulerView
                accounts={accounts}
                commands={scheduledCommands}
                presets={schedulerPresets}
                onCreateCommand={handleCreateScheduledCommand}
                onCreateBatchCommands={handleCreateBatchScheduledCommands}
                onTriggerNow={handleTriggerScheduledNow}
                onCancelCommand={handleCancelScheduled}
                onCancelDodgeNow={handleCancelDodgeNow}
                onClearAll={handleClearAllScheduled}
                onSyncWorldAndVillages={handleSyncWorldAndVillages}
              />
            )}

            {/* Feature 2: Villages Directory View */}
            {activeTab === 'villages' && (
              <VillagesView
                accounts={accounts}
                onSyncVillages={handleSyncVillages}
                onSyncCombinedVillages={handleSyncCombinedVillages}
                onAddManualVillage={handleAddManualVillage}
                onOpenVillageScreen={handleOpenVillageScreen}
              />
            )}

            {/* Feature 3: Incoming Attacks Tagger View */}
            {activeTab === 'tagger' && (
              <TaggerView
                accounts={accounts}
                scheduledCommands={scheduledCommands}
                onSyncIncomings={handleSyncIncomings}
                onSyncCombinedVillages={handleSyncCombinedVillages}
                onCreateBatchCommands={handleCreateBatchScheduledCommands}
                onCreateDodge={handleCreateDodgeCommand}
                onCancelDodgeNow={handleCancelDodgeNow}
                onOpenIncomingsScreen={(acc) =>
                  handleOpenGameScreen(acc, 'overview_villages&mode=incomings')
                }
              />
            )}

            {/* Feature 4: Construction & Recruitment Models View */}
            {activeTab === 'models' && (
              <ModelsView
                accounts={accounts}
                constructionModels={constructionModels}
                recruitmentModels={recruitmentModels}
                onSaveConstructionModel={handleSaveConstructionModel}
                onDeleteConstructionModel={handleDeleteConstructionModel}
                onSaveRecruitmentModel={handleSaveRecruitmentModel}
                onDeleteRecruitmentModel={handleDeleteRecruitmentModel}
                onAssignModelsToAccount={handleAssignModelsToAccount}
              />
            )}

            {/* Wave 7: Auto-Farm View */}
            {activeTab === 'autofarm' && (
              <AutoFarmView
                accounts={accounts}
                configs={autoFarmConfigs}
                states={autoFarmStates}
                onSaveConfig={handleSaveAutoFarmConfig}
                onDeleteConfig={handleDeleteAutoFarmConfig}
                onStart={handleStartAutoFarm}
                onStop={handleStopAutoFarm}
                onRunOnce={handleRunAutoFarmOnce}
                onScanFa={handleScanAutoFarm}
                onMapTargets={handleMapAutoFarmTargets}
                onOpenFaScreen={(acc, villageId) =>
                  villageId
                    ? handleOpenVillageScreen(acc, villageId, 'am_farm')
                    : handleOpenGameScreen(acc, 'am_farm')
                }
              />
            )}
          </Suspense>
        </ErrorBoundary>

        {/* Tab: Accounts Dashboard */}
        {activeTab === 'accounts' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <Search className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar por nick, mundo (br130) ou grupo..."
                  className="w-full rounded-xl border border-slate-800 bg-[#141923] pl-10 pr-4 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  className="rounded-xl border border-slate-800 bg-[#141923] px-3 py-2 text-xs text-slate-200"
                >
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g === 'ALL' ? 'Todos os Grupos' : `Grupo: ${g}`}
                    </option>
                  ))}
                </select>

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'ALL' | SessionStatus)}
                  className="rounded-xl border border-slate-800 bg-[#141923] px-3 py-2 text-xs text-slate-200"
                >
                  <option value="ALL">Todos os Status</option>
                  <option value="running">Online / Conectado</option>
                  <option value="offline">Offline</option>
                  <option value="error">Com Erro</option>
                </select>
              </div>
            </div>

            {filteredAccounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-[#141923]/50 py-16 px-4 text-center">
                <Globe className="h-10 w-10 text-amber-400/70 mb-3" />
                <h3 className="text-sm font-semibold text-slate-200">
                  Nenhuma conta Tribal Wars cadastrada
                </h3>
                <p className="text-xs text-slate-400 max-w-md mt-1 mb-5">
                  Adicione suas contas do Tribal Wars para abrir sessões isoladas por perfil, configurar proxies dedicados e acessar os mundos rapidamente.
                </p>
                <button
                  onClick={() => {
                    setEditingAccount(null);
                    setShowAccountModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  <Plus className="h-4 w-4" />
                  Cadastrar Primeira Conta
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredAccounts.map((acc) => {
                  const isRunning = acc.status === 'running' || acc.status === 'starting';
                  return (
                    <div
                      key={acc._id}
                      className="flex flex-col justify-between rounded-2xl border border-slate-800/90 bg-[#141923] p-5 transition hover:border-slate-700"
                    >
                      <div className="space-y-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-base font-bold text-slate-100">
                                {acc.username}
                              </span>
                              <span className="rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                                {acc.world.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
                              <span>{acc.domain}</span>
                              <span>•</span>
                              <span className="text-slate-300">{acc.group || 'Geral'}</span>
                            </div>
                          </div>

                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                              acc.status === 'running'
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                : acc.status === 'starting'
                                  ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                                  : acc.status === 'error'
                                    ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                                    : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {isRunning ? (
                              <Wifi className="h-3 w-3" />
                            ) : (
                              <WifiOff className="h-3 w-3" />
                            )}
                            {acc.status === 'running'
                              ? 'Conectado'
                              : acc.status === 'starting'
                                ? 'Conectando...'
                                : acc.status === 'error'
                                  ? 'Erro'
                                  : 'Offline'}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-800/80 bg-surface-base p-3 text-center tabular-nums">
                          <div>
                            <div className="text-[11px] text-slate-400">Pontos</div>
                            <div className="text-xs font-bold text-slate-200 mt-0.5">
                              {(acc.playerInfo?.points || 0).toLocaleString('pt-BR')}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-slate-400">Aldeias</div>
                            <div className="text-xs font-bold text-amber-400 mt-0.5">
                              {acc.playerInfo?.villagesCount || 1}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] text-slate-400">Ataques</div>
                            <div
                              className={`text-xs font-bold mt-0.5 ${
                                (acc.playerInfo?.incomings || 0) > 0
                                  ? 'text-rose-400'
                                  : 'text-emerald-400'
                              }`}
                            >
                              {acc.playerInfo?.incomings || 0}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <span className="inline-flex items-center gap-1.5">
                            <Shield
                              className={`h-3.5 w-3.5 ${
                                acc.proxy?.enabled ? 'text-emerald-400' : 'text-slate-600'
                              }`}
                            />
                            {acc.proxy?.enabled
                              ? `${acc.proxy.protocol.toUpperCase()} ${acc.proxy.host}:${acc.proxy.port}`
                              : 'Conexão Direta (Sem Proxy)'}
                          </span>
                          {acc.notes && (
                            <span className="truncate max-w-[140px] text-slate-500" title={acc.notes}>
                              {acc.notes}
                            </span>
                          )}
                        </div>

                        {acc.lastError && (
                          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
                            {acc.lastError}
                          </div>
                        )}
                      </div>

                      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3.5">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleOpenVisibleSession(acc)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Abrir Jogo
                          </button>

                          <button
                            onClick={() => handleOpenNewWindow(acc)}
                            title="Abrir uma nova janela independente desta conta (Multi-Janelas)"
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
                          >
                            <Plus className="h-3 w-3" />
                            + Janela
                          </button>

                          {isRunning ? (
                            <button
                              onClick={() => handleStopSession(acc)}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                            >
                              <Square className="h-3 w-3" />
                              Parar
                            </button>
                          ) : (
                            <button
                              onClick={() => handleStartBackgroundSession(acc)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
                              title="Conectar sessão em segundo plano"
                            >
                              <Play className="h-3 w-3 text-emerald-400" />
                              2º Plano
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setDetailAccount(acc)}
                            className="rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
                            title="Atalhos de Aldeia, Academia, Coleta e Cookies"
                          >
                            Painel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingAccount(acc);
                              setShowAccountModal(true);
                            }}
                            aria-label={`Editar conta ${acc.username}`}
                            className="rounded-lg p-1.5 text-slate-400 transition-colors duration-150 hover:bg-slate-800 hover:text-slate-200 active:scale-[0.98]"
                            title="Editar Conta"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmState({
                                title: 'Remover conta',
                                description: `Tem certeza que deseja remover a conta "${acc.username}" (${acc.world.toUpperCase()})? Sessões e agendamentos vinculados não serão mantidos.`,
                                confirmLabel: 'Remover Conta',
                                onConfirm: async () => {
                                  await handleDeleteAccount(acc);
                                  setConfirmState(null);
                                },
                              })
                            }
                            aria-label={`Remover conta ${acc.username}`}
                            className="rounded-lg p-1.5 text-slate-400 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.98]"
                            title="Remover Conta"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab: Multi-Session View */}
        {activeTab === 'multiview' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5">
              <h2 className="text-sm font-semibold text-slate-100 mb-1">
                Controle de Sessões Simultâneas
              </h2>
              <p className="text-xs text-slate-400 mb-4">
                Alterne rapidamente entre janelas abertas do Tribal Wars, recarregue sessões ou abra atalhos diretos (Praça, Cunhagem, Coleta).
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3">Conta</th>
                      <th className="py-2.5 px-3">Mundo / Servidor</th>
                      <th className="py-2.5 px-3">Proxy</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Ações Rápidas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {accounts.map((acc) => (
                      <tr key={acc._id} className="hover:bg-slate-900/40">
                        <td className="py-3 px-3 font-semibold text-slate-100">{acc.username}</td>
                        <td className="py-3 px-3 text-slate-300">
                          {acc.world.toUpperCase()} ({acc.domain})
                        </td>
                        <td className="py-3 px-3 text-slate-400">
                          {acc.proxy?.enabled
                            ? `${acc.proxy.protocol}://${acc.proxy.host}:${acc.proxy.port}`
                            : 'Direto'}
                        </td>
                        <td className="py-3 px-3">
                          <span
                            className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                              acc.status === 'running'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {acc.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right space-x-1.5">
                          <button
                            onClick={() => handleOpenVisibleSession(acc)}
                            className="rounded-lg bg-amber-500 px-2.5 py-1 text-slate-950 font-semibold hover:bg-amber-400"
                          >
                            Focar / Abrir
                          </button>
                          <button
                            onClick={() => handleOpenNewWindow(acc)}
                            title="Abrir nova janela desta conta"
                            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300 hover:bg-amber-500/20 font-medium"
                          >
                            + Janela
                          </button>
                          <button
                            onClick={() => handleOpenGameScreen(acc, 'overview')}
                            className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-800"
                          >
                            Aldeia
                          </button>
                          <button
                            onClick={() => handleOpenGameScreen(acc, 'place&mode=scavenge')}
                            className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-800"
                          >
                            Coleta
                          </button>
                          <button
                            onClick={() => handleOpenGameScreen(acc, 'snob')}
                            className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-800"
                          >
                            Academia
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Proxy Manager */}
        {activeTab === 'proxies' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <form
              onSubmit={handleAddProxy}
              className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4"
            >
              <h2 className="text-sm font-semibold text-slate-100">
                Cadastrar Novo Proxy (HTTP / HTTPS / SOCKS5)
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Identificação</label>
                  <input
                    type="text"
                    value={newProxyLabel}
                    onChange={(e) => setNewProxyLabel(e.target.value)}
                    placeholder="Proxy BR #1"
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Protocolo</label>
                  <select
                    value={newProxyProtocol}
                    onChange={(e) =>
                      setNewProxyProtocol(
                        e.target.value as 'http' | 'https' | 'socks4' | 'socks5'
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="socks4">SOCKS4</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Host / IP *</label>
                  <input
                    type="text"
                    required
                    value={newProxyHost}
                    onChange={(e) => setNewProxyHost(e.target.value)}
                    placeholder="177.54.10.20"
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Porta *</label>
                  <input
                    type="number"
                    required
                    value={newProxyPort}
                    onChange={(e) => setNewProxyPort(e.target.value)}
                    placeholder="8080"
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Usuário</label>
                  <input
                    type="text"
                    value={newProxyUser}
                    onChange={(e) => setNewProxyUser(e.target.value)}
                    placeholder="Opcional"
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Senha</label>
                  <input
                    type="password"
                    value={newProxyPass}
                    onChange={(e) => setNewProxyPass(e.target.value)}
                    placeholder="Opcional"
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                >
                  <Plus className="h-4 w-4" />
                  Salvar Proxy
                </button>
              </div>
            </form>

            <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5">
              <h3 className="text-sm font-semibold text-slate-100 mb-3">
                Proxies Cadastrados ({proxies.length})
              </h3>
              {proxies.length === 0 ? (
                <p className="text-xs text-slate-400">Nenhum proxy salvo ainda.</p>
              ) : (
                <div className="space-y-2">
                  {proxies.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0f1218] px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <Server className="h-4 w-4 text-amber-400" />
                        <div>
                          <div className="text-xs font-semibold text-slate-100">
                            {p.label || `${p.host}:${p.port}`}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {p.protocol.toUpperCase()}://{p.host}:{p.port}{' '}
                            {p.username ? `(autenticado: ${p.username})` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {p.lastStatus === 'ok' && (
                          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                            Online ({p.latencyMs}ms • {p.lastIp})
                          </span>
                        )}
                        {p.lastStatus === 'error' && (
                          <span className="rounded-md bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300">
                            Falha na conexão
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTestProxy(p)}
                          disabled={testingProxyId === p.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${testingProxyId === p.id ? 'animate-spin' : ''}`}
                          />
                          Testar
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmState({
                              title: 'Remover proxy',
                              description: `Deseja remover o proxy "${p.label || `${p.host}:${p.port}`}" da lista?`,
                              confirmLabel: 'Remover Proxy',
                              onConfirm: async () => {
                                await handleDeleteProxy(p.id);
                                setConfirmState(null);
                              },
                            })
                          }
                          aria-label={`Remover proxy ${p.label || p.host}`}
                          className="rounded-lg p-1.5 text-slate-400 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.98]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab: Activity Logs */}
        {activeTab === 'logs' && (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-100 tabular-nums">
                  Registro de Eventos das Sessões ({logs.length})
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.electronAPI) {
                        notify('Abertura da pasta de logs disponível apenas no aplicativo desktop.');
                        return;
                      }
                      const res = await window.electronAPI.store.logs.openFolder();
                      if (!res.success && res.error) {
                        notify(`Falha ao abrir pasta de logs: ${res.error}`);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                    Abrir Pasta de Logs
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.electronAPI) {
                        notify('Exportação de logs disponível apenas no aplicativo desktop.');
                        return;
                      }
                      const res = await window.electronAPI.store.logs.export();
                      if (res.success && res.filePath) {
                        notify(`Logs exportados em: ${res.filePath}`);
                      } else if (!res.canceled && res.error) {
                        notify(`Falha ao exportar logs: ${res.error}`);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors duration-150 hover:bg-amber-500/20 active:scale-[0.98]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Exportar Logs
                  </button>
                  <button
                    type="button"
                    disabled={logs.length === 0}
                    onClick={() =>
                      setConfirmState({
                        title: 'Limpar histórico de ações',
                        description: `Deseja apagar todos os ${logs.length} registro(s) de eventos das sessões?`,
                        confirmLabel: 'Limpar Histórico',
                        onConfirm: async () => {
                          if (window.electronAPI) {
                            await window.electronAPI.store.logs.clear();
                          }
                          setLogs([]);
                          setConfirmState(null);
                          notify('Histórico de ações limpo.');
                        },
                      })
                    }
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98] disabled:opacity-40"
                  >
                    Limpar Histórico
                  </button>
                </div>
              </div>

              {logs.length === 0 ? (
                <p className="text-xs text-slate-400">Nenhum evento registrado.</p>
              ) : (
                <div className="space-y-1.5 font-mono text-xs">
                  {logs.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between rounded-lg border border-slate-800/70 bg-surface-base px-3.5 py-2"
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            entry.level === 'error'
                              ? 'bg-rose-400'
                              : entry.level === 'warn'
                                ? 'bg-amber-400'
                                : 'bg-emerald-400'
                          }`}
                        />
                        {entry.accountName && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-amber-300">
                            {entry.accountName}
                          </span>
                        )}
                        <span className="text-slate-200">{entry.message}</span>
                      </div>
                      <span className="text-[11px] tabular-nums text-slate-500">
                        {new Date(entry.timestamp).toLocaleTimeString('pt-BR')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab: Settings */}
        {activeTab === 'settings' && (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-xl rounded-2xl border border-slate-800 bg-[#141923] p-6 space-y-5">
              <h2 className="text-sm font-semibold text-slate-100">
                Preferências Padrão de Conexão Tribal Wars
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Servidor Regional Padrão
                  </label>
                  <select
                    value={settings.defaultDomain}
                    onChange={async (e) => {
                      const next = { ...settings, defaultDomain: e.target.value };
                      setSettings(next);
                      await window.electronAPI?.store.settings.update(next);
                      notify('Servidor padrão atualizado.');
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3.5 py-2 text-xs text-slate-100"
                  >
                    <option value="tribalwars.com.br">Brasil (tribalwars.com.br)</option>
                    <option value="tribalwars.com.pt">Portugal (tribalwars.com.pt)</option>
                    <option value="tribalwars.net">Internacional (tribalwars.net)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Mundo Padrão</label>
                  <input
                    type="text"
                    value={settings.defaultWorld}
                    onChange={async (e) => {
                      const next = { ...settings, defaultWorld: e.target.value };
                      setSettings(next);
                      await window.electronAPI?.store.settings.update(next);
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3.5 py-2 text-xs text-slate-100"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      {showAccountModal && (
        <AccountModal
          initial={editingAccount}
          savedProxies={proxies}
          onClose={() => {
            setShowAccountModal(false);
            setEditingAccount(null);
          }}
          onSave={handleSaveAccount}
          fetchServers={fetchServers}
        />
      )}

      {detailAccount && (
        <AccountDetailModal
          account={detailAccount}
          onClose={() => setDetailAccount(null)}
          onOpenScreen={handleOpenGameScreen}
          onExportCookies={handleExportCookies}
          onReloadSession={handleReloadSession}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.title || ''}
        description={confirmState?.description || ''}
        confirmLabel={confirmState?.confirmLabel || 'Confirmar'}
        onCancel={() => setConfirmState(null)}
        onConfirm={async () => {
          if (confirmState) await confirmState.onConfirm();
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default App;
