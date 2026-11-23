import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  Crosshair,
  ExternalLink,
  HelpCircle,
  MapPin,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sprout,
  Trash2,
  Zap,
} from 'lucide-react';
import { ConfirmDialog } from './ui/ConfirmDialog';
import type {
  AutoFarmConfig,
  AutoFarmRuntimeState,
  FarmDuplicateOriginRef,
  FarmDuplicateSummary,
  FarmPlayerRouteTarget,
  FarmPlunderTarget,
  FarmTemplateKey,
  TroopCounts,
  TwAccount,
  TwVillage,
} from '../types';

interface AutoFarmViewProps {
  accounts: TwAccount[];
  configs: Record<string, AutoFarmConfig>;
  states: Record<string, AutoFarmRuntimeState>;
  onSaveConfig: (
    config: Partial<AutoFarmConfig> & { accountId: string }
  ) => Promise<AutoFarmConfig | undefined>;
  onDeleteConfig: (configId: string) => Promise<void>;
  onStart: (configId: string) => Promise<void>;
  onStop: (configId: string) => Promise<void>;
  onRunOnce: (configId: string) => Promise<void>;
  onScanFa: (accountId: string, villageId?: string) => Promise<FarmPlunderTarget[]>;
  onMapTargets: (payload: {
    accountId: string;
    originVillageId?: string;
    originCoords: string;
    radius: number;
  }) => Promise<FarmPlunderTarget[]>;
  onOpenFaScreen: (account: TwAccount, villageId?: string) => Promise<void>;
}

function HintTip({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex items-center text-slate-500 hover:text-sky-300 cursor-help ml-1 align-middle"
    >
      <HelpCircle className="h-3.5 w-3.5" />
    </span>
  );
}

function normalizeCoord(raw: string): string {
  const m = /(\d{1,3})\|(\d{1,3})/.exec((raw || '').trim());
  return m ? `${Number(m[1])}|${Number(m[2])}` : (raw || '').trim();
}

function findDuplicateTargetsClient(configs: AutoFarmConfig[]): FarmDuplicateSummary {
  const refsByCoord = new Map<string, Map<string, FarmDuplicateOriginRef>>();

  for (const cfg of configs) {
    const label = cfg.name || cfg.originCoords || 'Configuração';
    const ref: FarmDuplicateOriginRef = {
      configId: cfg.id,
      originVillageId: cfg.originVillageId,
      originCoords: cfg.originCoords,
      label,
    };

    const addCoord = (raw: string) => {
      const coord = normalizeCoord(raw);
      if (!/^\d{1,3}\|\d{1,3}$/.test(coord)) return;
      let byConfig = refsByCoord.get(coord);
      if (!byConfig) {
        byConfig = new Map();
        refsByCoord.set(coord, byConfig);
      }
      if (!byConfig.has(cfg.id)) {
        byConfig.set(cfg.id, ref);
      }
    };

    for (const mt of cfg.mappedTargets || []) {
      addCoord(mt.coords);
    }
    for (const pt of cfg.playerTargets || []) {
      if (pt.enabled) addCoord(pt.coords);
    }
  }

  const duplicatesByCoord: Record<string, FarmDuplicateOriginRef[]> = {};
  const duplicateCountByConfigId: Record<string, number> = {};

  for (const [coord, byConfig] of refsByCoord.entries()) {
    if (byConfig.size >= 2) {
      const refs = Array.from(byConfig.values());
      duplicatesByCoord[coord] = refs;
      for (const r of refs) {
        duplicateCountByConfigId[r.configId] = (duplicateCountByConfigId[r.configId] || 0) + 1;
      }
    }
  }

  return { duplicatesByCoord, duplicateCountByConfigId };
}

function buildDefaultConfig(accountId: string, village?: TwVillage): AutoFarmConfig {
  const id = village ? `${accountId}:${village.id}` : `${accountId}:new-${Date.now()}`;
  return {
    id,
    accountId,
    name: village ? `${village.name} (${village.coords})` : 'Assistente Padrão',
    enabled: false,
    mode: 'fa',
    originVillageId: village?.id,
    originCoords: village?.coords,
    templateKey: 'a',
    templatePriorityOrder: ['a'],
    enableTemplateCFollowUp: false,
    maxDistance: 20,
    allowYellowReports: false,
    allowPartialLootOnly: false,
    minDelayMs: 250,
    maxDelayMs: 600,
    cycleIntervalSec: 180,
    dailyMaxAttacks: 600,
    pauseOnLowTroops: true,
    minReserveLight: 0,
    minReserveSpear: 0,
    pauseOnIncomings: true,
    maxIncomingsThreshold: 1,
    pauseOnCaptcha: true,
    dailyScheduleEnabled: false,
    dailyScheduleTime: '08:00',
    restrictToMappedTargets: false,
    mappedTargets: [],
    playerTargets: [],
    updatedAt: new Date().toISOString(),
  };
}

const PAUSE_REASON_LABELS: Record<string, { label: string; badge: string }> = {
  captcha: {
    label: 'Pausado: CAPTCHA Detectado',
    badge: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  },
  incomings: {
    label: 'Pausado: Ataques a Chegar',
    badge: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  },
  low_troops: {
    label: 'Pausado: Estoque de Tropas Baixo',
    badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  },
  daily_limit: {
    label: 'Pausado: Limite Diário Atingido',
    badge: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  },
  session_offline: {
    label: 'Pausado: Sessão Offline',
    badge: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
  },
  manual: {
    label: 'Pausado Manualmente',
    badge: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
  },
};

export const AutoFarmView: React.FC<AutoFarmViewProps> = ({
  accounts,
  configs,
  states,
  onSaveConfig,
  onDeleteConfig,
  onStart,
  onStop,
  onRunOnce,
  onScanFa,
  onMapTargets,
  onOpenFaScreen,
}) => {
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?._id || '');
  const selectedAccount = accounts.find((a) => a._id === selectedAccountId) || accounts[0] || null;
  const activeAccountId = selectedAccount?._id || '';

  const accountConfigs = useMemo(() => {
    if (!activeAccountId) return [];
    return Object.values(configs)
      .filter((c) => c.accountId === activeAccountId)
      .sort((a, b) => (a.name || a.originCoords || '').localeCompare(b.name || b.originCoords || ''));
  }, [configs, activeAccountId]);

  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [draft, setDraft] = useState<AutoFarmConfig | null>(null);

  // Sync active config selection when account or saved configs change
  useEffect(() => {
    if (!activeAccountId) {
      setSelectedConfigId('');
      setDraft(null);
      return;
    }
    const existing = accountConfigs.find((c) => c.id === selectedConfigId);
    if (existing) {
      setDraft(existing);
    } else if (accountConfigs.length > 0) {
      setSelectedConfigId(accountConfigs[0].id);
      setDraft(accountConfigs[0]);
    } else {
      const firstVillage = selectedAccount?.villages?.[0];
      const fresh = buildDefaultConfig(activeAccountId, firstVillage);
      setSelectedConfigId(fresh.id);
      setDraft(fresh);
    }
  }, [activeAccountId, accountConfigs, selectedConfigId]);

  // Duplicate detection across all configs of the active account (including live draft edits)
  const effectiveConfigsForDupCheck = useMemo(() => {
    if (!draft) return accountConfigs;
    const withoutDraft = accountConfigs.filter((c) => c.id !== draft.id);
    return [...withoutDraft, draft];
  }, [accountConfigs, draft]);

  const duplicateSummary = useMemo(
    () => findDuplicateTargetsClient(effectiveConfigsForDupCheck),
    [effectiveConfigsForDupCheck]
  );

  const [scannedTargets, setScannedTargets] = useState<FarmPlunderTarget[]>([]);
  const [mappedCandidates, setMappedCandidates] = useState<FarmPlunderTarget[]>([]);
  const [selectedMapCoords, setSelectedMapCoords] = useState<Set<string>>(() => new Set());
  const [mapping, setMapping] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [runningOnce, setRunningOnce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);

  // New player route form state
  const [routeCoords, setRouteCoords] = useState('500|500');
  const [routePlayerName, setRoutePlayerName] = useState('');
  const [routeIntervalMin, setRouteIntervalMin] = useState(30);
  const [routeLight, setRouteLight] = useState(50);
  const [routeAxe, setRouteAxe] = useState(0);
  const [routeSpy, setRouteSpy] = useState(1);

  const runtimeState: AutoFarmRuntimeState | undefined = draft?.id
    ? states[draft.id]
    : undefined;

  const displayTargets =
    scannedTargets.length > 0 ? scannedTargets : runtimeState?.lastTargets || [];

  const getOtherConfigsForCoord = (coord: string, currentConfigId: string): FarmDuplicateOriginRef[] => {
    const refs = duplicateSummary.duplicatesByCoord[normalizeCoord(coord)] || [];
    return refs.filter((r) => r.configId !== currentConfigId);
  };

  // Also check if a candidate coord from "Mapear" is already mapped in any OTHER config
  const otherConfigsMappedLookup = useMemo(() => {
    const map = new Map<string, FarmDuplicateOriginRef[]>();
    if (!draft) return map;
    for (const cfg of accountConfigs) {
      if (cfg.id === draft.id) continue;
      const ref: FarmDuplicateOriginRef = {
        configId: cfg.id,
        originVillageId: cfg.originVillageId,
        originCoords: cfg.originCoords,
        label: cfg.name || cfg.originCoords || 'Outra Aldeia',
      };
      for (const mt of cfg.mappedTargets || []) {
        const key = normalizeCoord(mt.coords);
        const list = map.get(key) || [];
        list.push(ref);
        map.set(key, list);
      }
      for (const pt of cfg.playerTargets || []) {
        if (!pt.enabled) continue;
        const key = normalizeCoord(pt.coords);
        const list = map.get(key) || [];
        if (!list.some((r) => r.configId === cfg.id)) list.push(ref);
        map.set(key, list);
      }
    }
    return map;
  }, [accountConfigs, draft]);

  const handleCreateNewVillageConfig = async () => {
    if (!selectedAccount) return;
    const usedVillageIds = new Set(accountConfigs.map((c) => c.originVillageId).filter(Boolean));
    const nextVillage =
      (selectedAccount.villages || []).find((v) => !usedVillageIds.has(v.id)) ||
      selectedAccount.villages?.[0];
    const fresh = buildDefaultConfig(selectedAccount._id, nextVillage);
    if (accountConfigs.some((c) => c.id === fresh.id)) {
      fresh.id = `${selectedAccount._id}:cfg-${Date.now()}`;
    }
    const saved = await onSaveConfig(fresh);
    const chosen = saved || fresh;
    setSelectedConfigId(chosen.id);
    setDraft(chosen);
    setMappedCandidates([]);
    setSelectedMapCoords(new Set());
  };

  const handleSelectConfig = (cfg: AutoFarmConfig) => {
    setSelectedConfigId(cfg.id);
    setDraft(cfg);
    setMappedCandidates([]);
    setSelectedMapCoords(new Set((cfg.mappedTargets || []).map((t) => normalizeCoord(t.coords))));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await onSaveConfig(draft);
      if (saved) {
        setSelectedConfigId(saved.id);
        setDraft(saved);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleScan = async () => {
    if (!selectedAccount || !draft) return;
    setScanning(true);
    try {
      const targets = await onScanFa(selectedAccount._id, draft.originVillageId);
      setScannedTargets(targets);
    } finally {
      setScanning(false);
    }
  };

  const handleMapRadius = async () => {
    if (!selectedAccount || !draft) return;
    const originCoords =
      draft.originCoords ||
      selectedAccount.villages?.find((v) => v.id === draft.originVillageId)?.coords ||
      selectedAccount.villages?.[0]?.coords ||
      '500|500';

    setMapping(true);
    try {
      const targets = await onMapTargets({
        accountId: selectedAccount._id,
        originVillageId: draft.originVillageId,
        originCoords,
        radius: draft.maxDistance,
      });
      setMappedCandidates(targets);
      // Pre-select existing mappedTargets if any, otherwise all targets within radius
      const existingCoords = new Set(
        (draft.mappedTargets || []).map((t) => normalizeCoord(t.coords))
      );
      if (existingCoords.size > 0) {
        const nextSel = new Set<string>();
        for (const t of targets) {
          if (existingCoords.has(normalizeCoord(t.coords))) {
            nextSel.add(normalizeCoord(t.coords));
          }
        }
        setSelectedMapCoords(nextSel.size > 0 ? nextSel : new Set(targets.map((t) => normalizeCoord(t.coords))));
      } else {
        setSelectedMapCoords(new Set(targets.map((t) => normalizeCoord(t.coords))));
      }
    } finally {
      setMapping(false);
    }
  };

  const handleToggleMapCandidate = (coord: string) => {
    const key = normalizeCoord(coord);
    setSelectedMapCoords((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRemoveDuplicatesFromSelection = () => {
    setSelectedMapCoords((prev) => {
      const next = new Set<string>();
      for (const c of prev) {
        if (!otherConfigsMappedLookup.has(c)) {
          next.add(c);
        }
      }
      return next;
    });
  };

  const handleApplyMappedSelection = async () => {
    if (!draft) return;
    const chosenTargets = mappedCandidates.filter((t) =>
      selectedMapCoords.has(normalizeCoord(t.coords))
    );
    const nextDraft: AutoFarmConfig = {
      ...draft,
      mappedTargets: chosenTargets,
      restrictToMappedTargets: true,
    };
    setDraft(nextDraft);
    const saved = await onSaveConfig(nextDraft);
    if (saved) {
      setSelectedConfigId(saved.id);
      setDraft(saved);
    }
  };

  const handleRemoveMappedTarget = async (coord: string) => {
    if (!draft) return;
    const key = normalizeCoord(coord);
    const nextDraft: AutoFarmConfig = {
      ...draft,
      mappedTargets: (draft.mappedTargets || []).filter((t) => normalizeCoord(t.coords) !== key),
    };
    setDraft(nextDraft);
    await onSaveConfig(nextDraft);
  };

  const handleRunOnce = async () => {
    if (!selectedAccount || !draft) return;
    setRunningOnce(true);
    try {
      const saved = await onSaveConfig(draft);
      await onRunOnce(saved?.id || draft.id);
    } finally {
      setRunningOnce(false);
    }
  };

  const handleStart = async () => {
    if (!selectedAccount || !draft) return;
    const saved = await onSaveConfig(draft);
    await onStart(saved?.id || draft.id);
  };

  const handleAddPlayerRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const coordMatch = /(\d{1,3})\|(\d{1,3})/.exec(routeCoords.trim());
    if (!coordMatch) return;
    const cleanCoords = `${Number(coordMatch[1])}|${Number(coordMatch[2])}`;

    const troops: TroopCounts = {};
    if (routeLight > 0) troops.light = routeLight;
    if (routeAxe > 0) troops.axe = routeAxe;
    if (routeSpy > 0) troops.spy = routeSpy;
    if (Object.keys(troops).length === 0) troops.light = 25;

    const newRoute: FarmPlayerRouteTarget = {
      id: crypto.randomUUID(),
      coords: cleanCoords,
      playerName: routePlayerName.trim() || undefined,
      troops,
      minIntervalMinutes: Math.max(1, routeIntervalMin || 30),
      enabled: true,
    };

    const nextDraft: AutoFarmConfig = {
      ...draft,
      playerTargets: [...draft.playerTargets, newRoute],
    };
    setDraft(nextDraft);
    await onSaveConfig(nextDraft);
    setRoutePlayerName('');
  };

  const handleToggleRoute = async (routeId: string) => {
    if (!draft) return;
    const nextDraft: AutoFarmConfig = {
      ...draft,
      playerTargets: draft.playerTargets.map((r) =>
        r.id === routeId ? { ...r, enabled: !r.enabled } : r
      ),
    };
    setDraft(nextDraft);
    await onSaveConfig(nextDraft);
  };

  const handleDeleteRoute = async (routeId: string) => {
    if (!draft) return;
    const nextDraft: AutoFarmConfig = {
      ...draft,
      playerTargets: draft.playerTargets.filter((r) => r.id !== routeId),
    };
    setDraft(nextDraft);
    await onSaveConfig(nextDraft);
  };

  if (!selectedAccount || !draft) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-2xl border border-slate-800 bg-[#141923] p-8 text-center text-xs text-slate-400">
          Adicione uma conta na aba Contas para configurar o Auto-Farm.
        </div>
      </div>
    );
  }

  const pauseMeta = runtimeState?.pausedReason
    ? PAUSE_REASON_LABELS[runtimeState.pausedReason]
    : null;
  const totalDuplicatesInAccount = Object.keys(duplicateSummary.duplicatesByCoord).length;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header & Account Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-[#141923] p-5">
        <div className="flex items-center gap-3">
          <Sprout className="h-5 w-5 text-emerald-400" />
          <div>
            <h2 className="text-sm font-bold text-slate-100">
              Auto-Farm por Aldeia — Assistente de Saque & Mapeamento de Setores
            </h2>
            <p className="text-[11px] text-slate-400">
              Programe uma configuração por aldeia de origem, mapeie bárbaras por raio e evite ataques duplicados no mesmo alvo.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedAccount._id}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="rounded-xl border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-100"
          >
            {accounts.map((acc) => (
              <option key={acc._id} value={acc._id}>
                {acc.username} ({acc.world.toUpperCase()})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleCreateNewVillageConfig}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            <Plus className="h-3.5 w-3.5" />
            Programar Nova Aldeia
          </button>

          <button
            type="button"
            onClick={() => onOpenFaScreen(selectedAccount, draft.originVillageId)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Abrir FA
          </button>
        </div>
      </div>

      {/* Compact Quick Instructions Banner */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0f1218]/80 px-4 py-2.5 text-[11px] text-slate-300 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold text-emerald-400">Como funciona:</span>
        <span>
          <strong>1.</strong> Crie uma config por aldeia e clique em <strong>Mapear</strong> para delimitar as bárbaras do setor (sem duplicar alvos entre aldeias).
        </span>
        <span>
          <strong>2.</strong> Escolha a prioridade (ex: <strong>A → B</strong>) e se deve rodar <strong>Modelo C</strong> após cobrir todas.
        </span>
        <span>
          <strong>3.</strong> Clique em <strong>Iniciar</strong>: se faltar tropa, ele aguarda o retorno para concluir a lista em loop.
        </span>
      </div>

      {/* Programmed Configs List (Per Village) */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Configurações Programadas ({accountConfigs.length})
            </h3>
            {totalDuplicatesInAccount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                {totalDuplicatesInAccount} alvo(s) duplicado(s) entre aldeias
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-400">
            Clique em uma configuração para editar seus alvos ou iniciar/pausar individualmente.
          </span>
        </div>

        {accountConfigs.length === 0 ? (
          <div className="rounded-xl border border-slate-800/80 bg-[#0f1218]/60 px-4 py-3 text-xs text-slate-400">
            Nenhuma configuração salva ainda. Edite os parâmetros abaixo e clique em <strong>Salvar Configurações</strong> ou em <strong>Programar Nova Aldeia</strong>.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {accountConfigs.map((cfg) => {
              const st = states[cfg.id];
              const isSelected = draft.id === cfg.id;
              const dupCount = duplicateSummary.duplicateCountByConfigId[cfg.id] || 0;

              return (
                <div
                  key={cfg.id}
                  onClick={() => handleSelectConfig(cfg)}
                  className={`cursor-pointer rounded-xl border p-3.5 transition space-y-2.5 ${
                    dupCount > 0
                      ? isSelected
                        ? 'border-amber-400 bg-amber-500/10 ring-1 ring-amber-400/50'
                        : 'border-amber-500/50 bg-amber-500/5 hover:border-amber-400'
                      : isSelected
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-slate-800 bg-[#0f1218] hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-bold text-slate-100">
                          {cfg.name || cfg.originCoords || 'Aldeia Ativa'}
                        </span>
                        {st?.running && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                            ATIVO
                          </span>
                        )}
                        {cfg.dailyScheduleEnabled && (
                          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                            DIÁRIO {cfg.dailyScheduleTime || '08:00'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        Modelo{' '}
                        <strong className="text-amber-300">
                          {(cfg.templatePriorityOrder && cfg.templatePriorityOrder.length > 0
                            ? cfg.templatePriorityOrder
                            : [cfg.templateKey]
                          )
                            .map((k) => k.toUpperCase())
                            .join(' → ')}
                          {cfg.enableTemplateCFollowUp ? ' + C' : ''}
                        </strong>{' '}
                        • Raio <strong>{cfg.maxDistance}</strong> •{' '}
                        {cfg.restrictToMappedTargets
                          ? `${cfg.mappedTargets?.length || 0} alvos delimitados`
                          : 'Todos do FA'}
                      </div>
                    </div>

                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {st?.running ? (
                        <button
                          type="button"
                          onClick={() => onStop(cfg.id)}
                          title="Pausar"
                          className="rounded-lg bg-rose-500/20 p-1.5 text-rose-300 hover:bg-rose-500/30"
                        >
                          <Pause className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onStart(cfg.id)}
                          title="Iniciar"
                          className="rounded-lg bg-emerald-500/20 p-1.5 text-emerald-300 hover:bg-emerald-500/30"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            title: 'Excluir configuração de Auto-Farm',
                            description: `Deseja excluir a configuração "${cfg.name || cfg.originCoords || 'Aldeia'}"?`,
                            confirmLabel: 'Excluir Config',
                            onConfirm: async () => {
                              await onDeleteConfig(cfg.id);
                              setConfirmAction(null);
                            },
                          })
                        }
                        aria-label={`Excluir configuração ${cfg.name || cfg.originCoords || ''}`}
                        title="Excluir Config"
                        className="rounded-lg p-1.5 text-slate-400 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px]">
                    <span className="text-slate-400">
                      Ataques hoje: <strong className="text-slate-200">{st?.attacksToday ?? 0}</strong> / Limite diário: {cfg.dailyMaxAttacks}
                    </span>
                    {dupCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 font-semibold text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        {dupCount} duplicado(s)
                      </span>
                    ) : (
                      <span className="text-emerald-400/90">Sem duplicidades</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Active Config Actions & Status */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              Editando: {draft.name || draft.originCoords || 'Configuração'}
            </h3>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {runtimeState?.running ? (
                <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                  <ShieldCheck className="h-3 w-3" />
                  {runtimeState.waitingForTroops
                    ? 'Aguardando Retorno de Tropas'
                    : runtimeState.farmPhase === 'template_c'
                      ? 'Em Execução (Fase Modelo C)'
                      : 'Em Execução (Fase Principal)'}
                </span>
              ) : pauseMeta ? (
                <span
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold ${pauseMeta.badge}`}
                >
                  <ShieldAlert className="h-3 w-3" />
                  {pauseMeta.label}
                </span>
              ) : (
                <span className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-300">
                  Inativo
                </span>
              )}
              <span className="text-[11px] text-slate-400">
                Ataques hoje: <strong className="text-amber-300">{runtimeState?.attacksToday ?? 0}</strong> / Limite diário: {draft.dailyMaxAttacks}
                {runtimeState?.nextRunAt &&
                  ` • Próximo ciclo: ${new Date(runtimeState.nextRunAt).toLocaleTimeString('pt-BR')}`}
                {draft.dailyScheduleEnabled &&
                  ` • Início diário: ${draft.dailyScheduleTime || '08:00'}`}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={mapping}
              onClick={handleMapRadius}
              className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/50 bg-sky-500/15 px-3.5 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
            >
              <MapPin className={`h-3.5 w-3.5 ${mapping ? 'animate-pulse' : ''}`} />
              {mapping ? 'Mapeando...' : `Mapear (Raio ${draft.maxDistance})`}
            </button>

            <button
              type="button"
              disabled={scanning}
              onClick={handleScan}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Lendo FA...' : 'Escanear FA'}
            </button>

            <button
              type="button"
              disabled={runningOnce}
              onClick={handleRunOnce}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
            >
              <Zap className="h-3.5 w-3.5" />
              {runningOnce ? 'Executando...' : 'Executar 1 Ciclo'}
            </button>

            {runtimeState?.running ? (
              <button
                type="button"
                onClick={() => onStop(draft.id)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-rose-400"
              >
                <Pause className="h-3.5 w-3.5" />
                Pausar
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
              >
                <Play className="h-3.5 w-3.5" />
                Iniciar
              </button>
            )}

            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Salvando...' : 'Salvar Config'}
            </button>
          </div>
        </div>

        {runtimeState?.pausedReason === 'captcha' && (
          <div className="flex items-center gap-3 rounded-xl border border-rose-500/50 bg-rose-500/15 px-4 py-3 text-xs text-rose-200">
            <AlertTriangle className="h-5 w-5 shrink-0 text-rose-400" />
            <div>
              <strong>CAPTCHA detectado!</strong> Resolva manualmente na janela do jogo e depois clique em <strong>Iniciar</strong>.
            </div>
          </div>
        )}

        {/* Config Fields */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Nome da Config</label>
            <input
              type="text"
              value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Ex: Front Norte"
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Aldeia de Origem</label>
            <select
              value={draft.originVillageId || ''}
              onChange={(e) => {
                const v = selectedAccount.villages?.find((item) => item.id === e.target.value);
                setDraft({
                  ...draft,
                  originVillageId: e.target.value || undefined,
                  originCoords: v?.coords,
                  name: v ? `${v.name} (${v.coords})` : draft.name,
                });
              }}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="">Aldeia Ativa na Sessão</option>
              {(selectedAccount.villages || []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.coords})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Modo de Operação
              <HintTip text="Define se o loop usa apenas o Assistente de Saque (FA), apenas rotas manuais de jogadores, ou ambos." />
            </label>
            <select
              value={draft.mode}
              onChange={(e) => setDraft({ ...draft, mode: e.target.value as AutoFarmConfig['mode'] })}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="fa">Somente Assistente de Saque (FA)</option>
              <option value="players">Somente Rotas de Jogadores</option>
              <option value="both">FA Bárbaras + Rotas de Jogadores</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Modelos & Prioridade FA
              <HintTip text="Em 'A → B', o assistente envia sempre o Modelo A primeiro; quando acabarem as tropas de A, passa automaticamente para o Modelo B." />
            </label>
            <select
              value={(draft.templatePriorityOrder && draft.templatePriorityOrder.length > 0
                ? draft.templatePriorityOrder
                : [draft.templateKey]
              ).join(',')}
              onChange={(e) => {
                const order = e.target.value
                  .split(',')
                  .filter((k): k is FarmTemplateKey => k === 'a' || k === 'b' || k === 'c');
                setDraft({
                  ...draft,
                  templatePriorityOrder: order.length > 0 ? order : ['a'],
                  templateKey: order[0] || 'a',
                });
              }}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="a">Somente Modelo A</option>
              <option value="b">Somente Modelo B</option>
              <option value="a,b">Modelo A + B (Prioridade: A → B)</option>
              <option value="b,a">Modelo B + A (Prioridade: B → A)</option>
              <option value="c">Somente Modelo C</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Raio / Distância Máxima
              <HintTip text="Distância máxima em campos usada tanto pelo botão Mapear quanto para filtrar os alvos do FA." />
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={draft.maxDistance}
              onChange={(e) =>
                setDraft({ ...draft, maxDistance: Math.max(1, Number(e.target.value) || 20) })
              }
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Delay Humano (ms mín / máx)
              <HintTip text="Tempo aleatório de espera (em milissegundos) entre cada ataque enviado para simular comportamento humano." />
            </label>
            <div className="flex gap-1.5">
              <input
                type="number"
                min={100}
                value={draft.minDelayMs}
                onChange={(e) =>
                  setDraft({ ...draft, minDelayMs: Math.max(100, Number(e.target.value) || 250) })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
              <input
                type="number"
                min={150}
                value={draft.maxDelayMs}
                onChange={(e) =>
                  setDraft({ ...draft, maxDelayMs: Math.max(150, Number(e.target.value) || 600) })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Ciclo (seg) / Limite Diário
              <HintTip text="Esquerda: tempo em segundos até tentar novamente após cobrir a lista ou aguardar retorno de tropas. Direita: máximo de ataques por dia nesta config." />
            </label>
            <div className="flex gap-1.5">
              <input
                type="number"
                min={30}
                value={draft.cycleIntervalSec}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cycleIntervalSec: Math.max(30, Number(e.target.value) || 180),
                  })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
              <input
                type="number"
                min={10}
                value={draft.dailyMaxAttacks}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    dailyMaxAttacks: Math.max(10, Number(e.target.value) || 600),
                  })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Reserva Mín. (CL / Lança)
              <HintTip text="Quantidade mínima de Cavalaria Leve (esq.) e Lanceiros (dir.) que o assistente preserva na aldeia sem enviar para o farm." />
            </label>
            <div className="flex gap-1.5">
              <input
                type="number"
                min={0}
                value={draft.minReserveLight}
                onChange={(e) =>
                  setDraft({ ...draft, minReserveLight: Math.max(0, Number(e.target.value) || 0) })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
              <input
                type="number"
                min={0}
                value={draft.minReserveSpear}
                onChange={(e) =>
                  setDraft({ ...draft, minReserveSpear: Math.max(0, Number(e.target.value) || 0) })
                }
                className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Início Diário Agendado
              <HintTip text="Quando ativado, o Auto-Farm desta aldeia inicia automaticamente 1x por dia no horário definido (mesmo se estiver pausado), até você desativar." />
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1">
              <input
                type="checkbox"
                checked={Boolean(draft.dailyScheduleEnabled)}
                onChange={(e) =>
                  setDraft({ ...draft, dailyScheduleEnabled: e.target.checked })
                }
              />
              <input
                type="time"
                value={draft.dailyScheduleTime || '08:00'}
                onChange={(e) =>
                  setDraft({ ...draft, dailyScheduleTime: e.target.value || '08:00' })
                }
                disabled={!draft.dailyScheduleEnabled}
                className="flex-1 bg-transparent text-xs text-slate-100 disabled:opacity-40"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 pt-1 text-xs text-slate-300">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(draft.enableTemplateCFollowUp)}
              onChange={(e) =>
                setDraft({ ...draft, enableTemplateCFollowUp: e.target.checked })
              }
            />
            <span>
              Após cobrir toda a seleção, enviar Modelo C em loop
              <HintTip text="Quando todas as aldeias da seleção receberem ataque na fase principal (A/B), inicia automaticamente uma varredura com Modelo C na mesma ordem de proximidade e depois recomeça o loop." />
            </span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.restrictToMappedTargets}
              onChange={(e) =>
                setDraft({ ...draft, restrictToMappedTargets: e.target.checked })
              }
            />
            <span>
              Atacar somente os alvos mapeados nesta config ({draft.mappedTargets?.length || 0})
              <HintTip text="Quando ativo, dispara apenas para as bárbaras selecionadas pelo botão Mapear desta aldeia, evitando sobrepor outras aldeias." />
            </span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.allowYellowReports}
              onChange={(e) => setDraft({ ...draft, allowYellowReports: e.target.checked })}
            />
            Permitir relatórios amarelos
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.pauseOnLowTroops}
              onChange={(e) => setDraft({ ...draft, pauseOnLowTroops: e.target.checked })}
            />
            Pausar por tropas baixas
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.pauseOnIncomings}
              onChange={(e) => setDraft({ ...draft, pauseOnIncomings: e.target.checked })}
            />
            Pausar ao receber ataques
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.pauseOnCaptcha}
              onChange={(e) => setDraft({ ...draft, pauseOnCaptcha: e.target.checked })}
            />
            Pausar em CAPTCHA
          </label>
        </div>
      </div>

      {/* Mapped Targets Selector Panel (Result of "Mapear" button) */}
      {mappedCandidates.length > 0 && (
        <div className="rounded-2xl border border-sky-500/40 bg-[#141923] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Crosshair className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                Mapeamento no Raio de {draft.maxDistance} campos ({mappedCandidates.length} encontradas •{' '}
                {selectedMapCoords.size} selecionadas)
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRemoveDuplicatesFromSelection}
                className="inline-flex items-center gap-1 rounded-xl border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Desmarcar Duplicados
              </button>
              <button
                type="button"
                onClick={handleApplyMappedSelection}
                className="inline-flex items-center gap-1 rounded-xl bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"
              >
                <CheckSquare className="h-3.5 w-3.5" />
                Aplicar Seleção ({selectedMapCoords.size})
              </button>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#0f1218]">
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3 w-8">Sel.</th>
                  <th className="py-2 px-3">Aldeia</th>
                  <th className="py-2 px-3">Coords</th>
                  <th className="py-2 px-3">Distância</th>
                  <th className="py-2 px-3">Status em Outras Configs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {mappedCandidates.map((cand) => {
                  const key = normalizeCoord(cand.coords);
                  const checked = selectedMapCoords.has(key);
                  const otherRefs = otherConfigsMappedLookup.get(key) || [];
                  const isDup = otherRefs.length > 0;

                  return (
                    <tr
                      key={`${cand.villageId}-${key}`}
                      className={
                        isDup
                          ? 'bg-amber-500/10 hover:bg-amber-500/15'
                          : checked
                            ? 'bg-sky-500/5 hover:bg-sky-500/10'
                            : 'hover:bg-slate-900/40'
                      }
                    >
                      <td className="py-2 px-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleMapCandidate(cand.coords)}
                        />
                      </td>
                      <td className="py-2 px-3 text-slate-200">{cand.name}</td>
                      <td className="py-2 px-3 font-mono text-amber-300">{key}</td>
                      <td className="py-2 px-3 text-slate-300">{cand.distance} campos</td>
                      <td className="py-2 px-3">
                        {isDup ? (
                          <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                            <AlertTriangle className="h-3 w-3" />
                            Já mapeada em: {otherRefs.map((r) => r.label).join(', ')}
                          </span>
                        ) : (
                          <span className="text-[11px] text-emerald-400">Livre (exclusiva)</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Currently Delimited / Mapped Targets of This Config */}
      {(draft.mappedTargets?.length || 0) > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Alvos Delimitados desta Aldeia ({draft.mappedTargets.length})
            </h3>
            <span className="text-[11px] text-slate-400">
              Alvos com destaque âmbar também estão presentes em outra config programada.
            </span>
          </div>
          <div className="max-h-60 overflow-y-auto overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#0f1218]">
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Aldeia</th>
                  <th className="py-2 px-3">Coords</th>
                  <th className="py-2 px-3">Distância</th>
                  <th className="py-2 px-3">Duplicidade</th>
                  <th className="py-2 px-3 text-right">Remover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {draft.mappedTargets.map((mt) => {
                  const otherRefs = getOtherConfigsForCoord(mt.coords, draft.id);
                  const isDup = otherRefs.length > 0;
                  return (
                    <tr
                      key={`${mt.villageId}-${mt.coords}`}
                      className={isDup ? 'bg-amber-500/10' : 'hover:bg-slate-900/40'}
                    >
                      <td className="py-2 px-3 text-slate-200">{mt.name}</td>
                      <td className="py-2 px-3 font-mono text-amber-300">{mt.coords}</td>
                      <td className="py-2 px-3 text-slate-300">{mt.distance} campos</td>
                      <td className="py-2 px-3">
                        {isDup ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            Duplicada em {otherRefs.map((r) => r.label).join(', ')}
                          </span>
                        ) : (
                          <span className="text-[11px] text-emerald-400">Exclusiva</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveMappedTarget(mt.coords)}
                          className="rounded-lg p-1 text-rose-400 hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Phase 25: Player / Custom Farm Routes */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-100">
          Rotas de Farm de Jogadores / Inativos ({draft.playerTargets.length})
        </h3>

        <form
          onSubmit={handleAddPlayerRoute}
          className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 items-end rounded-xl border border-slate-800 bg-[#0f1218]/70 p-3.5"
        >
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Coords (X|Y)</label>
            <input
              type="text"
              required
              value={routeCoords}
              onChange={(e) => setRouteCoords(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 font-mono text-xs text-slate-100"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-[11px] text-slate-400 mb-1">Jogador / Nota</label>
            <input
              type="text"
              value={routePlayerName}
              onChange={(e) => setRoutePlayerName(e.target.value)}
              placeholder="Inativo K55"
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">CL</label>
            <input
              type="number"
              min={0}
              value={routeLight}
              onChange={(e) => setRouteLight(Math.max(0, Number(e.target.value) || 0))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Bárbaros</label>
            <input
              type="number"
              min={0}
              value={routeAxe}
              onChange={(e) => setRouteAxe(Math.max(0, Number(e.target.value) || 0))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Espiões</label>
            <input
              type="number"
              min={0}
              value={routeSpy}
              onChange={(e) => setRouteSpy(Math.max(0, Number(e.target.value) || 0))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Cooldown (min)</label>
            <input
              type="number"
              min={1}
              value={routeIntervalMin}
              onChange={(e) => setRouteIntervalMin(Math.max(1, Number(e.target.value) || 30))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            <Plus className="h-3.5 w-3.5" />
            Adicionar
          </button>
        </form>

        {draft.playerTargets.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Ativo</th>
                  <th className="py-2 px-3">Coords</th>
                  <th className="py-2 px-3">Jogador / Nota</th>
                  <th className="py-2 px-3">Tropas</th>
                  <th className="py-2 px-3">Cooldown</th>
                  <th className="py-2 px-3">Duplicidade</th>
                  <th className="py-2 px-3 text-right">Remover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {draft.playerTargets.map((route) => {
                  const otherRefs = getOtherConfigsForCoord(route.coords, draft.id);
                  const isDup = otherRefs.length > 0;
                  return (
                    <tr
                      key={route.id}
                      className={isDup ? 'bg-amber-500/10' : 'hover:bg-slate-900/40'}
                    >
                      <td className="py-2.5 px-3">
                        <input
                          type="checkbox"
                          checked={route.enabled}
                          onChange={() => handleToggleRoute(route.id)}
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono text-amber-300">{route.coords}</td>
                      <td className="py-2.5 px-3 text-slate-200">{route.playerName || '—'}</td>
                      <td className="py-2.5 px-3 text-slate-300">
                        {Object.entries(route.troops)
                          .filter(([, q]) => (Number(q) || 0) > 0)
                          .map(([u, q]) => `${u}: ${q}`)
                          .join(' • ')}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400">{route.minIntervalMinutes} min</td>
                      <td className="py-2.5 px-3">
                        {isDup ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                            Duplicada ({otherRefs.map((r) => r.label).join(', ')})
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({
                              title: 'Remover rota de farm',
                              description: `Deseja remover a rota para ${route.coords}?`,
                              confirmLabel: 'Remover Rota',
                              onConfirm: async () => {
                                await handleDeleteRoute(route.id);
                                setConfirmAction(null);
                              },
                            })
                          }
                          aria-label={`Remover rota ${route.coords}`}
                          className="rounded-lg p-1 text-rose-400 transition-colors duration-150 hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Farm Assistant Targets Preview */}
      <div className="rounded-2xl border border-slate-800 bg-surface-card p-5">
        <h3 className="text-sm font-semibold text-slate-100 mb-3 tabular-nums">
          Alvos Lidos do Assistente de Saque ({displayTargets.length})
        </h3>
        {displayTargets.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">
            Clique em <strong>Escanear FA</strong> com a sessão online para carregar os alvos do Assistente de Saque ao vivo.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Aldeia</th>
                  <th className="py-2 px-3">Coords</th>
                  <th className="py-2 px-3">Distância</th>
                  <th className="py-2 px-3">Relatório</th>
                  <th className="py-2 px-3">Modelos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {displayTargets.map((t) => (
                  <tr key={t.villageId} className="hover:bg-slate-900/40">
                    <td className="py-2 px-3 text-slate-200">{t.name}</td>
                    <td className="py-2 px-3 font-mono text-amber-300">{t.coords}</td>
                    <td className="py-2 px-3 text-slate-300">{t.distance} campos</td>
                    <td className="py-2 px-3">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                          t.lastReportStatus === 'green'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : t.lastReportStatus === 'yellow'
                              ? 'bg-amber-500/20 text-amber-300'
                              : t.lastReportStatus === 'red'
                                ? 'bg-rose-500/20 text-rose-300'
                                : 'bg-slate-700/40 text-slate-300'
                        }`}
                      >
                        {t.lastReportStatus.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono text-[11px] text-slate-300">
                      {[t.canSendA ? 'A' : '', t.canSendB ? 'B' : '', t.canSendC ? 'C' : '']
                        .filter(Boolean)
                        .join(' / ') || 'Indisponível'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title || ''}
        description={confirmAction?.description || ''}
        confirmLabel={confirmAction?.confirmLabel || 'Confirmar'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (confirmAction) await confirmAction.onConfirm();
        }}
      />
    </div>
  );
};
