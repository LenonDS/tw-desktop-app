import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Castle,
  CheckSquare,
  Clock,
  Copy,
  Crosshair,
  Filter,
  Globe,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  Sparkles,
  Sword,
  Tag,
  Timer,
  Trash2,
  Unlock,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { CountdownText } from './ui/CountdownText';
import type {
  AttackPlanItem,
  ScheduledCommand,
  TroopCounts,
  TroopModelPreset,
  TwAccount,
  TwTargetPlayer,
  TwTargetVillage,
  TwUnitType,
  TwVillage,
  TwWorldConfig,
} from '../types';
import {
  UNIT_LABELS,
  type PlannerTarget,
  applySyncTimingToPlanItems,
  buildManualAttackPlanItem,
  computePlannerMatrix,
  detectSlowestUnitClient,
  parseCoordsPair,
} from '../utils/plannerEngine';

interface SchedulerViewProps {
  accounts: TwAccount[];
  commands: ScheduledCommand[];
  presets: TroopModelPreset[];
  onCreateCommand: (
    payload: Partial<ScheduledCommand> & {
      timingMode?: 'arrival' | 'send';
      worldSpeed?: number;
      unitSpeed?: number;
    }
  ) => Promise<void>;
  onCreateBatchCommands?: (
    payloads: Array<
      Partial<ScheduledCommand> & {
        timingMode?: 'arrival' | 'send';
        worldSpeed?: number;
        unitSpeed?: number;
      }
    >
  ) => Promise<void>;
  onTriggerNow: (commandId: string) => Promise<void>;
  onCancelCommand: (commandId: string) => Promise<void>;
  onCancelDodgeNow?: (commandId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onSyncWorldAndVillages?: (accountId: string) => Promise<void>;
}

const LOCAL_CATEGORIES = ['Ofensiva', 'Nobre / NT', 'Fake', 'Defensiva'] as const;

const SHORT_UNIT_NAMES: Partial<Record<TwUnitType, string>> = {
  spear: 'Lan',
  sword: 'Esp',
  axe: 'Bár',
  archer: 'Arq',
  spy: 'Exp',
  light: 'CL',
  marcher: 'AC',
  heavy: 'CP',
  ram: 'Arí',
  catapult: 'Cat',
  knight: 'Pal',
  snob: 'Nob',
};

function extractCoordsFromText(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw.matchAll(/(\d{1,3})\|(\d{1,3})/g)) {
    const coord = `${Number(m[1])}|${Number(m[2])}`;
    if (!seen.has(coord)) {
      seen.add(coord);
      out.push(coord);
    }
  }
  return out;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function parseLocalDatetimeInput(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(
    (value || '').trim()
  );
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || '0');
  const d = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute ||
    d.getSeconds() !== second
  ) {
    return NaN;
  }
  return d.getTime();
}

function formatLocalDatetimeInput(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDefaultFutureDatetime(offsetMs: number): string {
  return formatLocalDatetimeInput(Date.now() + offsetMs);
}

export const SchedulerView: React.FC<SchedulerViewProps> = ({
  accounts,
  commands,
  presets,
  onCreateCommand,
  onCreateBatchCommands,
  onTriggerNow,
  onCancelCommand,
  onCancelDodgeNow,
  onClearAll,
  onSyncWorldAndVillages,
}) => {
  const [activeMode, setActiveMode] = useState<'single' | 'planner'>('single');
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?._id || '');
  const [originCoords, setOriginCoords] = useState('500|500');
  const [originVillageId, setOriginVillageId] = useState<string | undefined>(undefined);
  const [targetCoords, setTargetCoords] = useState('505|502');
  const [commandType, setCommandType] = useState<'attack' | 'support' | 'noble4' | 'fake'>('attack');
  const [slowestUnit, setSlowestUnit] = useState<TwUnitType>('ram');
  const [waves, setWaves] = useState(1);
  const [triggerBeforeSec, setTriggerBeforeSec] = useState(30);
  const [timingMode, setTimingMode] = useState<'arrival' | 'send'>('arrival');
  const [arrivalInput, setArrivalInput] = useState(() =>
    formatDefaultFutureDatetime(2 * 3600 * 1000)
  );
  const [sendInput, setSendInput] = useState(() =>
    formatDefaultFutureDatetime(5 * 60 * 1000)
  );
  const [singleFormError, setSingleFormError] = useState<string | null>(null);
  const [troops, setTroops] = useState<TroopCounts>({
    axe: 6500,
    spy: 5,
    light: 3000,
    ram: 300,
  });
  const [allWavesTroops, setAllWavesTroops] = useState<TroopCounts[]>([
    { axe: 6500, spy: 5, light: 3000, ram: 300 },
  ]);
  const [activeWaveTab, setActiveWaveTab] = useState(0);
  const [notes, setNotes] = useState('');
  const [confirmClearQueueOpen, setConfirmClearQueueOpen] = useState(false);
  const [syncingWorld, setSyncingWorld] = useState(false);
  const [loadedWorldConfig, setLoadedWorldConfig] = useState<TwWorldConfig | null>(null);

  // Wave 4 Attack Planner State
  const [syncingCombined, setSyncingCombined] = useState(false);
  const [plannerMessage, setPlannerMessage] = useState<string | null>(null);
  const [selectedTwGroupId, setSelectedTwGroupId] = useState('0');
  const [groupVillageIds, setGroupVillageIds] = useState<string[] | null>(null);
  const [localCategoryFilter, setLocalCategoryFilter] = useState('ALL');
  const [categoryToApply, setCategoryToApply] = useState<string>('Ofensiva');
  const [minTroopFilters, setMinTroopFilters] = useState<{
    axe: number;
    light: number;
    ram: number;
    snob: number;
    spy: number;
  }>({ axe: 0, light: 0, ram: 0, snob: 0, spy: 0 });
  const [selectedOriginIds, setSelectedOriginIds] = useState<string[]>([]);

  const [targetSearchQuery, setTargetSearchQuery] = useState('');
  const [searchingTargets, setSearchingTargets] = useState(false);
  const [matchedPlayers, setMatchedPlayers] = useState<TwTargetPlayer[]>([]);
  const [foundTargetVillages, setFoundTargetVillages] = useState<TwTargetVillage[]>([]);
  const [selectedPlayerFilterId, setSelectedPlayerFilterId] = useState<string>('ALL');
  const [selectedContinentFilter, setSelectedContinentFilter] = useState<string>('ALL');
  const [selectedFoundTargetIds, setSelectedFoundTargetIds] = useState<string[]>([]);
  const [bulkCoordsInput, setBulkCoordsInput] = useState('');
  const [opTargets, setOpTargets] = useState<PlannerTarget[]>([]);

  const [opMissionPresetId, setOpMissionPresetId] = useState<string>(presets[1]?.id || presets[0]?.id || 'custom');
  const [opCommandType, setOpCommandType] = useState<'attack' | 'support' | 'noble4' | 'fake'>('attack');
  const [opSlowestUnit, setOpSlowestUnit] = useState<TwUnitType>('ram');
  const [opWaves, setOpWaves] = useState(1);
  const [opTroops, setOpTroops] = useState<TroopCounts>({ axe: 6500, spy: 5, light: 3000, ram: 300 });
  const [opAllWavesTroops, setOpAllWavesTroops] = useState<TroopCounts[]>([
    { axe: 6500, spy: 5, light: 3000, ram: 300 },
  ]);
  const [opAllocationStrategy, setOpAllocationStrategy] = useState<'nearest' | 'round-robin'>('nearest');
  const [opMaxPerOrigin, setOpMaxPerOrigin] = useState(1);
  const [opPerTarget, setOpPerTarget] = useState(1);
  const [opSyncMode, setOpSyncMode] = useState<'manual' | 'arrival' | 'send'>('manual');
  const [opSyncTimeInput, setOpSyncTimeInput] = useState(() =>
    formatDefaultFutureDatetime(3 * 3600 * 1000)
  );
  const [opNotes, setOpNotes] = useState('OP Coordenada');

  // Attack Builder (Configurador Manual de Ataques) + Curated Attack List
  const [builderOriginId, setBuilderOriginId] = useState<string>('');
  const [builderTargetCoords, setBuilderTargetCoords] = useState<string>('');
  const [builderTimingMode, setBuilderTimingMode] = useState<'arrival' | 'send'>('arrival');
  const [builderTimeInput, setBuilderTimeInput] = useState(() =>
    formatDefaultFutureDatetime(3 * 3600 * 1000)
  );
  const [builderActiveWaveTab, setBuilderActiveWaveTab] = useState(0);
  const [builderShowTroopEditor, setBuilderShowTroopEditor] = useState(false);
  const [showAutoBatchPanel, setShowAutoBatchPanel] = useState(false);

  const [opAttackList, setOpAttackList] = useState<AttackPlanItem[]>([]);
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [enqueueingBatch, setEnqueueingBatch] = useState(false);

  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0]._id);
    }
  }, [accounts, selectedAccountId]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a._id === selectedAccountId) || null,
    [accounts, selectedAccountId]
  );

  // Sync world config and villages automatically when switching accounts/worlds
  const syncWorldContext = useCallback(
    async (accountId: string, forceVillages = false) => {
      if (!accountId || !window.electronAPI) return;
      setSyncingWorld(true);
      try {
        const cfgRes = await window.electronAPI.game.fetchWorldConfig(accountId);
        if (cfgRes.success && cfgRes.worldConfig) {
          setLoadedWorldConfig(cfgRes.worldConfig);
        }
        const acc = accounts.find((a) => a._id === accountId);
        if (forceVillages || !acc?.villages || acc.villages.length === 0) {
          await window.electronAPI.game.fetchVillages(accountId);
        }
        if (onSyncWorldAndVillages) {
          await onSyncWorldAndVillages(accountId);
        }
      } catch {
        // Ignore transient offline errors
      } finally {
        setSyncingWorld(false);
      }
    },
    [accounts, onSyncWorldAndVillages]
  );

  useEffect(() => {
    if (!selectedAccount) return;
    if (selectedAccount.worldConfig) {
      setLoadedWorldConfig(selectedAccount.worldConfig);
    } else {
      syncWorldContext(selectedAccount._id, false);
    }
  }, [selectedAccount?._id]);

  // Sync default origin village when switching accounts or when villages list updates
  useEffect(() => {
    if (selectedAccount?.villages && selectedAccount.villages.length > 0) {
      const stillValid = selectedAccount.villages.find(
        (v) => v.id === originVillageId || v.coords === originCoords
      );
      const chosen = stillValid || selectedAccount.villages[0];
      setOriginCoords(chosen.coords);
      setOriginVillageId(chosen.id);
    }
  }, [selectedAccount?._id, selectedAccount?.villages]);

  const activeWorldConfig = selectedAccount?.worldConfig || loadedWorldConfig;
  const worldSpeed = activeWorldConfig?.speed ?? 1;
  const unitSpeed = activeWorldConfig?.unitSpeed ?? 1;

  // Compute real minutes per field for each unit in the selected world
  const getUnitMinPerField = useCallback(
    (unit: TwUnitType): number => {
      const fromWorld = activeWorldConfig?.unitSpeeds?.[unit];
      if (typeof fromWorld === 'number' && Number.isFinite(fromWorld) && fromWorld > 0) {
        return fromWorld;
      }
      const base = UNIT_LABELS[unit]?.speed || 18;
      const eff = Math.max(0.1, worldSpeed * unitSpeed);
      return Number((base / eff).toFixed(2));
    },
    [activeWorldConfig, worldSpeed, unitSpeed]
  );

  const applyPreset = (preset: TroopModelPreset) => {
    setCommandType(preset.commandType);
    setSlowestUnit(preset.slowestUnit);
    const w = Math.max(1, Math.min(5, preset.waves || 1));
    setWaves(w);
    setTroops({ ...preset.troops });
    if (preset.allWavesTroops && preset.allWavesTroops.length > 0) {
      setAllWavesTroops(preset.allWavesTroops.map((t) => ({ ...t })));
    } else {
      setAllWavesTroops(Array.from({ length: w }, () => ({ ...preset.troops })));
    }
    setActiveWaveTab(0);
    setNotes(preset.name);
  };

  const handleWavesChange = (newWaves: number) => {
    const clamped = Math.max(1, Math.min(5, newWaves));
    setWaves(clamped);
    setAllWavesTroops((prev) => {
      const updated = [...prev];
      while (updated.length < clamped) {
        if (commandType === 'noble4' || (troops.snob && troops.snob > 0)) {
          updated.push({ axe: 100, spy: 1, snob: 1 });
        } else {
          updated.push({ ...troops });
        }
      }
      return updated.slice(0, clamped);
    });
    if (activeWaveTab >= clamped) {
      setActiveWaveTab(clamped - 1);
    }
  };

  const handleTroopChange = (unit: TwUnitType, val: number) => {
    const clamped = Math.max(0, val);
    setAllWavesTroops((prev) => {
      const copy = [...prev];
      if (!copy[activeWaveTab]) copy[activeWaveTab] = {};
      copy[activeWaveTab] = { ...copy[activeWaveTab], [unit]: clamped };
      return copy;
    });
    if (activeWaveTab === 0) {
      setTroops((prev) => ({ ...prev, [unit]: clamped }));
    }
  };

  const copyWave1ToAll = () => {
    const w1 = allWavesTroops[0] || troops;
    setAllWavesTroops(Array.from({ length: waves }, () => ({ ...w1 })));
  };

  const setupStandardNt = () => {
    setAllWavesTroops((prev) => {
      const res: TroopCounts[] = [];
      res.push({ ...(prev[0] || troops), snob: 1 });
      for (let i = 1; i < waves; i++) {
        res.push({ axe: 100, spy: 1, snob: 1 });
      }
      return res;
    });
  };

  const clearCurrentWave = () => {
    setAllWavesTroops((prev) => {
      const copy = [...prev];
      copy[activeWaveTab] = {};
      return copy;
    });
    if (activeWaveTab === 0) {
      setTroops({});
    }
  };

  const clearAllWavesTroops = () => {
    setTroops({});
    setAllWavesTroops(Array.from({ length: waves }, () => ({})));
  };

  // Visible units filtered by world configuration (hide archer/marcher on non-archer worlds)
  const visibleTroopKeys = useMemo(() => {
    const hasArcher = activeWorldConfig ? activeWorldConfig.archer : false;
    const baseUnits: TwUnitType[] = [
      'spear',
      'sword',
      'axe',
      ...(hasArcher ? (['archer'] as TwUnitType[]) : []),
      'spy',
      'light',
      ...(hasArcher ? (['marcher'] as TwUnitType[]) : []),
      'heavy',
      'ram',
      'catapult',
      'knight',
      'snob',
    ];
    return baseUnits;
  }, [activeWorldConfig]);

  // Auto-detect slowest unit from troops across all active waves when any unit has quantity > 0.
  // When all units are 0, allow free manual selection of `slowestUnit`.
  const autoDetectedSlowestUnit = useMemo<TwUnitType | null>(() => {
    let slowest: TwUnitType | null = null;
    let maxBaseSpeed = -1;
    const wavesToCheck = allWavesTroops.slice(0, waves);
    if (wavesToCheck.length === 0) wavesToCheck.push(troops);
    for (const wTroops of wavesToCheck) {
      for (const [uKey, rawVal] of Object.entries(wTroops || {})) {
        const qty = Number(rawVal) || 0;
        if (qty <= 0) continue;
        const unit = uKey as TwUnitType;
        const baseSpeed = UNIT_LABELS[unit]?.speed ?? 0;
        if (baseSpeed > maxBaseSpeed) {
          maxBaseSpeed = baseSpeed;
          slowest = unit;
        }
      }
    }
    return slowest;
  }, [allWavesTroops, waves, troops]);

  useEffect(() => {
    if (autoDetectedSlowestUnit && autoDetectedSlowestUnit !== slowestUnit) {
      setSlowestUnit(autoDetectedSlowestUnit);
    }
  }, [autoDetectedSlowestUnit, slowestUnit]);

  const effectiveSlowestUnit = autoDetectedSlowestUnit || slowestUnit;
  const isSlowestUnitLocked = autoDetectedSlowestUnit !== null;

  // Live preview of distance, travel time, send time, and arrival time using real world speeds
  const preview = useMemo(() => {
    const m1 = /(\d{1,3})\|(\d{1,3})/.exec(originCoords);
    const m2 = /(\d{1,3})\|(\d{1,3})/.exec(targetCoords);
    if (!m1 || !m2) return null;
    const dist = Math.hypot(Number(m1[1]) - Number(m2[1]), Number(m1[2]) - Number(m2[2]));
    const minPerField = getUnitMinPerField(effectiveSlowestUnit);
    const travelTimeMs = Math.round(dist * minPerField * 60 * 1000);

    let arrivalTimeMs: number;
    let sendTimeMs: number;
    if (timingMode === 'send') {
      sendTimeMs = parseLocalDatetimeInput(sendInput);
      arrivalTimeMs = Number.isFinite(sendTimeMs) ? sendTimeMs + travelTimeMs : NaN;
    } else {
      arrivalTimeMs = parseLocalDatetimeInput(arrivalInput);
      sendTimeMs = Number.isFinite(arrivalTimeMs) ? arrivalTimeMs - travelTimeMs : NaN;
    }

    const isInvalidTime = !Number.isFinite(sendTimeMs) || !Number.isFinite(arrivalTimeMs);
    const isPast = !isInvalidTime && sendTimeMs <= Date.now();

    return {
      distance: dist.toFixed(2),
      minPerField: minPerField.toFixed(2),
      travelTimeMs,
      arrivalTimeMs,
      sendTimeMs,
      isInvalidTime,
      isPast,
    };
  }, [
    originCoords,
    targetCoords,
    effectiveSlowestUnit,
    getUnitMinPerField,
    timingMode,
    arrivalInput,
    sendInput,
  ]);

  // Reset group filter and selections when switching account
  useEffect(() => {
    setSelectedTwGroupId('0');
    setGroupVillageIds(null);
    setSelectedOriginIds([]);
    setMatchedPlayers([]);
    setFoundTargetVillages([]);
    setSelectedFoundTargetIds([]);
    setOpAttackList([]);
    setSelectedPlanIds([]);
    setBuilderOriginId('');
  }, [selectedAccount?._id]);

  // Sync combined villages & groups (Phase 15)
  const syncCombinedForGroup = useCallback(
    async (accountId: string, gid: string) => {
      if (!window.electronAPI) return;
      setSyncingCombined(true);
      setPlannerMessage(null);
      try {
        const res = await window.electronAPI.game.fetchCombinedVillages({
          accountId,
          groupId: gid,
        });
        if (res.success) {
          if (gid === '0') {
            setGroupVillageIds(null);
          } else {
            setGroupVillageIds(res.villages.map((v) => v.id));
          }
          setPlannerMessage(
            `${res.villages.length} aldeia(s) e ${res.groups.length} grupo(s) sincronizados via Visão Combinada.`
          );
          if (onSyncWorldAndVillages) {
            await onSyncWorldAndVillages(accountId);
          }
        } else {
          setPlannerMessage(res.error || 'Falha ao sincronizar visão combinada.');
        }
      } catch (err) {
        setPlannerMessage(err instanceof Error ? err.message : 'Erro ao sincronizar tropas.');
      } finally {
        setSyncingCombined(false);
      }
    },
    [onSyncWorldAndVillages]
  );

  const handleTwGroupChange = async (newGroupId: string) => {
    setSelectedTwGroupId(newGroupId);
    if (!selectedAccount) return;
    if (newGroupId === '0') {
      setGroupVillageIds(null);
    }
    if (selectedAccount.status === 'running') {
      await syncCombinedForGroup(selectedAccount._id, newGroupId);
    }
  };

  const handleApplyLocalCategory = async (categoryValue: string) => {
    if (!selectedAccount || !window.electronAPI || selectedOriginIds.length === 0) return;
    const selectedSet = new Set(selectedOriginIds);
    const updatedVillages = (selectedAccount.villages || []).map((v) =>
      selectedSet.has(v.id)
        ? { ...v, localCategory: categoryValue === 'CLEAR' ? undefined : categoryValue }
        : v
    );
    await window.electronAPI.store.accounts.update(selectedAccount._id, {
      villages: updatedVillages,
    });
    setPlannerMessage(
      categoryValue === 'CLEAR'
        ? `Categoria removida de ${selectedOriginIds.length} aldeia(s).`
        : `Categoria "${categoryValue}" aplicada em ${selectedOriginIds.length} aldeia(s).`
    );
    if (onSyncWorldAndVillages) {
      await onSyncWorldAndVillages(selectedAccount._id);
    }
  };

  const filteredOriginVillages = useMemo(() => {
    const all = selectedAccount?.villages || [];
    const groupSet = groupVillageIds ? new Set(groupVillageIds) : null;
    return all.filter((v) => {
      if (groupSet && !groupSet.has(v.id)) return false;
      if (localCategoryFilter !== 'ALL' && (v.localCategory || '') !== localCategoryFilter) {
        return false;
      }
      const tr = v.troops || {};
      if ((tr.axe || 0) < minTroopFilters.axe) return false;
      if ((tr.light || 0) < minTroopFilters.light) return false;
      if ((tr.ram || 0) < minTroopFilters.ram) return false;
      if ((tr.snob || 0) < minTroopFilters.snob) return false;
      if ((tr.spy || 0) < minTroopFilters.spy) return false;
      return true;
    });
  }, [selectedAccount?.villages, groupVillageIds, localCategoryFilter, minTroopFilters]);

  const selectedOriginVillages = useMemo(() => {
    const idSet = new Set(selectedOriginIds);
    return (selectedAccount?.villages || []).filter((v) => idSet.has(v.id));
  }, [selectedAccount?.villages, selectedOriginIds]);

  const handleSearchTargetPlayer = async (overrideQuery?: string) => {
    if (!selectedAccount || !window.electronAPI) return;
    const q = (overrideQuery ?? targetSearchQuery).trim();
    if (!q) return;
    setSearchingTargets(true);
    setPlannerMessage(null);
    try {
      const res = await window.electronAPI.game.searchTargetPlayer({
        accountId: selectedAccount._id,
        query: q,
      });
      if (res.success) {
        setMatchedPlayers(res.matchedPlayers);
        setFoundTargetVillages(res.villages);
        setSelectedPlayerFilterId('ALL');
        setSelectedContinentFilter('ALL');
        setSelectedFoundTargetIds([]);
        setPlannerMessage(
          `Busca "${q}": ${res.matchedPlayers.length} jogador(es) e ${res.villages.length} aldeia(s) encontrados.`
        );
      } else {
        setPlannerMessage(res.error || 'Erro ao buscar jogador alvo.');
      }
    } finally {
      setSearchingTargets(false);
    }
  };

  const targetContinents = useMemo(() => {
    const set = new Set<string>();
    for (const v of foundTargetVillages) {
      if (v.continent) set.add(v.continent);
    }
    return Array.from(set).sort();
  }, [foundTargetVillages]);

  const filteredTargetVillages = useMemo(() => {
    return foundTargetVillages.filter((v) => {
      if (selectedPlayerFilterId !== 'ALL' && v.playerId !== selectedPlayerFilterId) return false;
      if (selectedContinentFilter !== 'ALL' && v.continent !== selectedContinentFilter) return false;
      return true;
    });
  }, [foundTargetVillages, selectedPlayerFilterId, selectedContinentFilter]);

  const addTargetsUnique = (incoming: PlannerTarget[]) => {
    setOpTargets((prev) => {
      const existing = new Set(prev.map((t) => t.coords));
      const next = [...prev];
      for (const item of incoming) {
        if (!existing.has(item.coords)) {
          existing.add(item.coords);
          next.push(item);
        }
      }
      return next;
    });
  };

  const handleAddSelectedFoundTargets = () => {
    const idSet = new Set(selectedFoundTargetIds);
    const chosen = filteredTargetVillages
      .filter((v) => idSet.has(v.id))
      .map((v) => ({ coords: v.coords, villageName: v.name, playerName: v.playerName }));
    addTargetsUnique(chosen);
    setSelectedFoundTargetIds([]);
  };

  const handleAddAllFilteredTargets = () => {
    const chosen = filteredTargetVillages.map((v) => ({
      coords: v.coords,
      villageName: v.name,
      playerName: v.playerName,
    }));
    addTargetsUnique(chosen);
  };

  const handleExtractBulkCoords = () => {
    const coords = extractCoordsFromText(bulkCoordsInput);
    if (coords.length === 0) return;
    addTargetsUnique(coords.map((c) => ({ coords: c })));
    setBulkCoordsInput('');
  };

  const handleSelectOpMission = (missionId: string) => {
    setOpMissionPresetId(missionId);
    if (missionId === 'custom') {
      const w = Math.max(1, Math.min(5, waves));
      setOpCommandType(commandType);
      setOpSlowestUnit(effectiveSlowestUnit);
      setOpWaves(w);
      setOpTroops({ ...(allWavesTroops[0] || troops) });
      setOpAllWavesTroops(allWavesTroops.slice(0, w).map((t) => ({ ...t })));
      return;
    }
    const preset = presets.find((p) => p.id === missionId);
    if (!preset) return;
    const w = Math.max(1, Math.min(5, preset.waves || 1));
    setOpCommandType(preset.commandType);
    setOpSlowestUnit(preset.slowestUnit);
    setOpWaves(w);
    setOpTroops({ ...preset.troops });
    if (preset.allWavesTroops && preset.allWavesTroops.length > 0) {
      setOpAllWavesTroops(preset.allWavesTroops.map((t) => ({ ...t })));
    } else {
      setOpAllWavesTroops(Array.from({ length: w }, () => ({ ...preset.troops })));
    }
  };

  // Keep custom OP preset synced when user selects 'custom'
  const effectiveOpMission = useMemo(() => {
    if (opMissionPresetId === 'custom') {
      const w = Math.max(1, Math.min(5, waves));
      return {
        presetName: notes || 'Personalizado',
        commandType,
        slowestUnit: effectiveSlowestUnit,
        waves: w,
        troops: allWavesTroops[0] || troops,
        allWavesTroops: allWavesTroops.slice(0, w),
      };
    }
    const foundPreset = presets.find((p) => p.id === opMissionPresetId);
    return {
      presetName: foundPreset?.name || opCommandType.toUpperCase(),
      commandType: opCommandType,
      slowestUnit: opSlowestUnit,
      waves: opWaves,
      troops: opTroops,
      allWavesTroops: opAllWavesTroops,
    };
  }, [
    opMissionPresetId,
    presets,
    waves,
    commandType,
    effectiveSlowestUnit,
    allWavesTroops,
    troops,
    notes,
    opCommandType,
    opSlowestUnit,
    opWaves,
    opTroops,
    opAllWavesTroops,
  ]);

  const toLocalDatetimeInput = (ms: number): string => {
    return formatLocalDatetimeInput(ms);
  };

  const accountVillages = useMemo(
    () => selectedAccount?.villages || [],
    [selectedAccount?.villages]
  );

  const builderOriginVillage = useMemo(() => {
    if (builderOriginId) {
      const found = accountVillages.find((v) => v.id === builderOriginId);
      if (found) return found;
    }
    return selectedOriginVillages[0] || accountVillages[0] || null;
  }, [builderOriginId, accountVillages, selectedOriginVillages]);

  const builderResolvedTarget = useMemo((): PlannerTarget | null => {
    const parsed = parseCoordsPair(builderTargetCoords);
    if (!parsed) {
      return opTargets[0] || null;
    }
    const norm = `${parsed.x}|${parsed.y}`;
    const existing = opTargets.find((t) => t.coords === norm);
    return existing || { coords: norm };
  }, [builderTargetCoords, opTargets]);

  const builderEffectiveTimingMode: 'arrival' | 'send' =
    opSyncMode === 'manual' ? builderTimingMode : opSyncMode;

  const builderEffectiveTimeInput =
    opSyncMode === 'manual' ? builderTimeInput : opSyncTimeInput;

  const builderPreviewItem = useMemo(() => {
    if (!builderOriginVillage || !builderResolvedTarget) return null;
    const targetTimeMs = parseLocalDatetimeInput(builderEffectiveTimeInput);
    return buildManualAttackPlanItem({
      origin: builderOriginVillage,
      target: builderResolvedTarget,
      commandType: effectiveOpMission.commandType,
      presetName: effectiveOpMission.presetName,
      slowestUnit: effectiveOpMission.slowestUnit,
      troops: effectiveOpMission.troops,
      waves: effectiveOpMission.waves,
      allWavesTroops: effectiveOpMission.allWavesTroops,
      timingMode: builderEffectiveTimingMode,
      targetTimeMs,
      getMinPerField: getUnitMinPerField,
      notes: opNotes,
    });
  }, [
    builderOriginVillage,
    builderResolvedTarget,
    builderEffectiveTimeInput,
    builderEffectiveTimingMode,
    effectiveOpMission,
    getUnitMinPerField,
    opNotes,
  ]);

  const handleAddManualAttack = () => {
    if (!builderOriginVillage) {
      setPlannerMessage('Selecione uma aldeia de origem válida.');
      return;
    }
    if (!builderResolvedTarget) {
      setPlannerMessage('Informe ou selecione uma coordenada alvo válida (ex: 500|500).');
      return;
    }
    if (builderOriginVillage.coords === builderResolvedTarget.coords) {
      setPlannerMessage('Origem e alvo não podem ser a mesma coordenada.');
      return;
    }
    if (!builderPreviewItem) {
      setPlannerMessage('Verifique o horário informado para calcular o ataque.');
      return;
    }
    const newItem: AttackPlanItem = {
      ...builderPreviewItem,
      id: `${builderPreviewItem.originVillageId || builderPreviewItem.originCoords}-${builderPreviewItem.targetCoords}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,
    };
    setOpAttackList((prev) => [...prev, newItem]);
    setSelectedPlanIds((prev) => [...prev, newItem.id]);
    setPlannerMessage(
      `Ataque adicionado à lista: ${newItem.originCoords} → ${newItem.targetCoords} (${newItem.timingMode === 'send' ? 'Envio' : 'Chegada'
      }).`
    );
  };

  const handleGenerateAutoBatchToList = () => {
    const syncMs = parseLocalDatetimeInput(
      opSyncMode === 'manual' ? builderTimeInput : opSyncTimeInput
    );
    const generated = computePlannerMatrix({
      origins: selectedOriginVillages,
      targets: opTargets,
      commandType: effectiveOpMission.commandType,
      presetName: effectiveOpMission.presetName,
      slowestUnit: effectiveOpMission.slowestUnit,
      troops: effectiveOpMission.troops,
      waves: effectiveOpMission.waves,
      allWavesTroops: effectiveOpMission.allWavesTroops,
      timingMode: opSyncMode === 'send' ? 'send' : opSyncMode === 'arrival' ? 'arrival' : builderTimingMode,
      targetTimeMs: syncMs,
      getMinPerField: getUnitMinPerField,
      allocationStrategy: opAllocationStrategy,
      maxCommandsPerOrigin: opMaxPerOrigin,
      commandsPerTarget: opPerTarget,
      notes: opNotes,
    });
    if (generated.length === 0) {
      setPlannerMessage('Selecione origens (Passo 1) e alvos (Passo 2) para gerar em lote.');
      return;
    }
    setOpAttackList((prev) => [...prev, ...generated]);
    setSelectedPlanIds((prev) => [...prev, ...generated.map((g) => g.id)]);
    setPlannerMessage(`${generated.length} ataque(s) gerados e adicionados à lista da OP.`);
  };

  const handleApplySyncToList = (
    syncMode: 'arrival' | 'send',
    scope: 'selected' | 'all'
  ) => {
    const syncMs = parseLocalDatetimeInput(opSyncTimeInput);
    if (!Number.isFinite(syncMs) || opAttackList.length === 0) return;
    const selectedSet = scope === 'selected' ? new Set(selectedPlanIds) : undefined;
    if (selectedSet && selectedSet.size === 0) return;
    setOpAttackList((prev) =>
      applySyncTimingToPlanItems(prev, syncMode, syncMs, selectedSet)
    );
    setPlannerMessage(
      `${syncMode === 'arrival' ? 'Chegada sincronizada' : 'Envio sincronizado'} aplicado ${scope === 'selected' ? `a ${selectedSet?.size} selecionado(s)` : 'a toda a lista'
      }.`
    );
  };

  const handleUpdatePlanItemTiming = (
    id: string,
    nextMode: 'arrival' | 'send',
    nextTimeStr: string
  ) => {
    const ms = parseLocalDatetimeInput(nextTimeStr);
    if (!Number.isFinite(ms)) return;
    setOpAttackList((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const sendTimeMs = nextMode === 'send' ? ms : ms - item.travelTimeMs;
        const arrivalTimeMs = nextMode === 'send' ? ms + item.travelTimeMs : ms;
        return {
          ...item,
          timingMode: nextMode,
          sendTimeMs,
          arrivalTimeMs,
        };
      })
    );
  };

  const handleDuplicatePlanItem = (item: AttackPlanItem) => {
    const copyId = `${item.originVillageId || item.originCoords}-${item.targetCoords}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const cloned: AttackPlanItem = { ...item, id: copyId };
    setOpAttackList((prev) => [...prev, cloned]);
    setSelectedPlanIds((prev) => [...prev, copyId]);
  };

  const handleRemovePlanItem = (id: string) => {
    setOpAttackList((prev) => prev.filter((item) => item.id !== id));
    setSelectedPlanIds((prev) => prev.filter((pid) => pid !== id));
  };

  const multiWindowOverlapIds = useMemo(() => {
    const overlap = new Set<string>();
    const wakeWindowMs = Math.max(20000, triggerBeforeSec * 1000);
    for (let i = 0; i < opAttackList.length; i++) {
      for (let j = i + 1; j < opAttackList.length; j++) {
        if (Math.abs(opAttackList[i].sendTimeMs - opAttackList[j].sendTimeMs) <= wakeWindowMs) {
          overlap.add(opAttackList[i].id);
          overlap.add(opAttackList[j].id);
        }
      }
    }
    return overlap;
  }, [opAttackList, triggerBeforeSec]);

  const handleEnqueueAttacks = async (scope: 'selected' | 'all') => {
    if (!selectedAccount || opAttackList.length === 0) return;
    const selectedSet = new Set(selectedPlanIds);
    const targetsToSend =
      scope === 'selected'
        ? opAttackList.filter((item) => selectedSet.has(item.id))
        : opAttackList;
    if (targetsToSend.length === 0) return;

    const now = Date.now();
    const expiredOrInvalid = targetsToSend.filter(
      (item) => !Number.isFinite(item.sendTimeMs) || item.sendTimeMs <= now
    );
    if (expiredOrInvalid.length > 0) {
      setPlannerMessage(
        `${expiredOrInvalid.length} ataque(s) estão com horário de disparo no passado ou inválido. Ajuste os horários antes de enfileirar.`
      );
      return;
    }

    setEnqueueingBatch(true);
    try {
      const payloads = targetsToSend.map((item) => {
        const mode: 'arrival' | 'send' = item.timingMode || 'arrival';
        const baseNotes = item.notes || opNotes || 'OP Coordenada';
        return {
          accountId: selectedAccount._id,
          accountName: selectedAccount.username,
          originVillageId: item.originVillageId,
          originCoords: item.originCoords,
          targetCoords: item.targetCoords,
          commandType: item.commandType,
          presetName: item.presetName,
          slowestUnit: item.slowestUnit,
          troops: item.troops,
          waves: item.waves,
          allWavesTroops: item.allWavesTroops,
          timingMode: mode,
          arrivalTimeMs: mode === 'arrival' ? item.arrivalTimeMs : undefined,
          sendTimeMs: mode === 'send' ? item.sendTimeMs : undefined,
          triggerBeforeMs: triggerBeforeSec * 1000,
          worldSpeed,
          unitSpeed,
          notes: item.targetPlayerName
            ? `${baseNotes} (${item.targetPlayerName})`
            : baseNotes,
        };
      });

      if (onCreateBatchCommands) {
        await onCreateBatchCommands(payloads);
      } else {
        for (const p of payloads) {
          await onCreateCommand(p);
        }
      }
      const sentIds = new Set(targetsToSend.map((t) => t.id));
      setOpAttackList((prev) => prev.filter((item) => !sentIds.has(item.id)));
      setSelectedPlanIds((prev) => prev.filter((id) => !sentIds.has(id)));
      setPlannerMessage(
        `${payloads.length} comando(s) enviados para a Fila de Envio Automático!`
      );
    } finally {
      setEnqueueingBatch(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount || !preview) return;
    if (preview.isInvalidTime || preview.sendTimeMs <= Date.now()) {
      setSingleFormError(
        'O horário de disparo está no passado ou inválido. Ajuste para um horário futuro.'
      );
      return;
    }
    setSingleFormError(null);
    const waveCount = Math.max(1, Math.min(5, waves));
    const finalAllWaves =
      waveCount > 1
        ? allWavesTroops.slice(0, waveCount)
        : [allWavesTroops[0] || troops];

    try {
      await onCreateCommand({
        accountId: selectedAccount._id,
        accountName: selectedAccount.username,
        originVillageId,
        originCoords,
        targetCoords,
        commandType,
        presetName: notes || commandType.toUpperCase(),
        slowestUnit: effectiveSlowestUnit,
        troops: finalAllWaves[0] || troops,
        allWavesTroops: finalAllWaves,
        waves: waveCount,
        timingMode,
        arrivalTimeMs: timingMode === 'arrival' ? preview.arrivalTimeMs : undefined,
        sendTimeMs: timingMode === 'send' ? preview.sendTimeMs : undefined,
        triggerBeforeMs: triggerBeforeSec * 1000,
        worldSpeed,
        unitSpeed,
        notes,
      });
    } catch (err) {
      setSingleFormError(
        err instanceof Error ? err.message : 'Falha ao agendar comando.'
      );
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Connected World & Account Selector Banner */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-amber-400">
                Mundo Conectado & Sincronização Automática
              </div>
              <div className="text-xs text-slate-400">
                Velocidades do mundo, unidades (`interface.php`) e aldeias de origem carregadas automaticamente
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-xl border border-slate-700 bg-[#0f1218] px-3.5 py-2 text-xs font-semibold text-slate-100"
            >
              {accounts.map((acc) => (
                <option key={acc._id} value={acc._id}>
                  {acc.username} — Mundo {acc.world.toUpperCase()} ({acc.domain})
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={!selectedAccount || syncingWorld}
              onClick={() => selectedAccount && syncWorldContext(selectedAccount._id, true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncingWorld ? 'animate-spin' : ''}`} />
              {syncingWorld ? 'Sincronizando Mundo...' : 'Sincronizar Mundo & Aldeias'}
            </button>
          </div>
        </div>

        {/* Auto-Fetched World Settings Badges */}
        {selectedAccount && (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Servidor:{' '}
              <strong className="text-amber-300">{selectedAccount.world.toUpperCase()}</strong>
            </span>
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Vel. do Mundo: <strong className="text-emerald-400">{worldSpeed}x</strong>
            </span>
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Vel. das Unidades: <strong className="text-emerald-400">{unitSpeed}x</strong>
            </span>
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Fator Efetivo:{' '}
              <strong className="text-sky-400">{(worldSpeed * unitSpeed).toFixed(2)}x</strong>
            </span>
            {activeWorldConfig?.attackGapMs !== undefined && (
              <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
                Gap de Ataques: <strong className="text-slate-100">{activeWorldConfig.attackGapMs}ms</strong>
              </span>
            )}
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Arqueiros:{' '}
              <strong className="text-slate-100">
                {activeWorldConfig?.archer ? 'Ativo' : 'Inativo'}
              </strong>
            </span>
            <span className="rounded-lg border border-slate-700/80 bg-[#0f1218] px-3 py-1.5 text-slate-300">
              Aldeias na Conta:{' '}
              <strong className="text-amber-300">
                {selectedAccount.villages?.length || 0} sincronizada(s)
              </strong>
            </span>
          </div>
        )}
      </div>

      {/* Mode Switcher Tabs: Individual vs Multi-Origin Attack Planner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-[#141923] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveMode('single')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${activeMode === 'single'
              ? 'bg-amber-500 text-slate-950 shadow-sm'
              : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
              }`}
          >
            <Timer className="h-4 w-4" />
            Agendador Individual (Calculadora & Multi-Ondas)
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('planner')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${activeMode === 'planner'
              ? 'bg-amber-500 text-slate-950 shadow-sm'
              : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
              }`}
          >
            <Layers className="h-4 w-4" />
            Planejador de Operações (Multi-Origem → Multi-Destino)
            {opAttackList.length > 0 && (
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${activeMode === 'planner'
                  ? 'bg-slate-950/20 text-slate-950'
                  : 'bg-amber-500/20 text-amber-300'
                  }`}
              >
                {opAttackList.length}
              </span>
            )}
          </button>
        </div>
        <span className="px-2 text-[11px] text-slate-400">
          Multi-Janela automática ativa quando múltiplos comandos compartilham o mesmo segundo/janela
        </span>
      </div>

      {activeMode === 'single' && (
        <>
          {/* Presets Strip */}
          <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
                <Sparkles className="h-4 w-4" />
                Modelos Rápidos de Comando (Presets Mapeados)
              </div>
              <span className="text-[11px] text-slate-400">
                Clique em um preset para preencher tropas e unidade mais lenta automaticamente
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-700/80 bg-[#0f1218] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:border-amber-500/50 hover:text-amber-300"
                >
                  {p.commandType === 'support' ? (
                    <Shield className="h-3.5 w-3.5 text-sky-400" />
                  ) : p.commandType === 'noble4' ? (
                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <Sword className="h-3.5 w-3.5 text-rose-400" />
                  )}
                  <span>{p.name}</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {UNIT_LABELS[p.slowestUnit]?.label} ({getUnitMinPerField(p.slowestUnit)}m/c)
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Command Creation Form + Live Timing Preview */}
          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Timer className="h-5 w-5 text-amber-400" />
                <h2 className="text-sm font-bold text-slate-100">
                  Agendar Novo Comando (Envio Automático com Confirmação na Praça)
                </h2>
              </div>
              {preview && (
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <span className="text-slate-400">
                    Distância: <strong className="text-slate-100">{preview.distance} campos</strong>
                  </span>
                  <span className="text-slate-400">
                    Ritmo ({UNIT_LABELS[effectiveSlowestUnit]?.label}):{' '}
                    <strong className="text-sky-300">{preview.minPerField} min/campo</strong>
                  </span>
                  <span className="text-slate-400">
                    Duração:{' '}
                    <strong className="text-amber-300">{formatDuration(preview.travelTimeMs)}</strong>
                  </span>
                  <span className="text-slate-400">
                    Disparo:{' '}
                    <strong
                      className={
                        preview.isInvalidTime || preview.isPast
                          ? 'text-rose-400'
                          : 'text-emerald-400'
                      }
                    >
                      {preview.isInvalidTime
                        ? '--:--:--'
                        : new Date(preview.sendTimeMs).toLocaleTimeString('pt-BR')}
                    </strong>
                  </span>
                  <span className="text-slate-400">
                    Chegada:{' '}
                    <strong className="text-sky-300">
                      {preview.isInvalidTime
                        ? '--:--:--'
                        : new Date(preview.arrivalTimeMs).toLocaleTimeString('pt-BR')}
                    </strong>
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Automatic Origin Village Selector from Connected World */}
              <div>
                <label className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="inline-flex items-center gap-1">
                    <Castle className="h-3.5 w-3.5 text-amber-400" />
                    Aldeia de Origem ({selectedAccount?.world.toUpperCase() || 'Mundo'}) *
                  </span>
                  {selectedAccount?.villages && selectedAccount.villages.length > 0 && (
                    <span className="text-[10px] text-emerald-400">
                      {selectedAccount.villages.length} aldeia(s) disponíveis
                    </span>
                  )}
                </label>
                <div className="flex gap-1.5">
                  {selectedAccount?.villages && selectedAccount.villages.length > 0 ? (
                    <select
                      value={originVillageId || selectedAccount.villages[0]?.id || ''}
                      onChange={(e) => {
                        const v = selectedAccount.villages?.find(
                          (vil) => vil.id === e.target.value || vil.coords === e.target.value
                        );
                        if (v) {
                          setOriginVillageId(v.id);
                          setOriginCoords(v.coords);
                        }
                      }}
                      className="flex-1 rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs font-medium text-slate-100"
                    >
                      {selectedAccount.villages.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.coords}) — {v.points.toLocaleString('pt-BR')} pts
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      value={originCoords}
                      onChange={(e) => setOriginCoords(e.target.value)}
                      placeholder="500|500 (Abra a sessão e clique em Sincronizar)"
                      className="flex-1 rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs font-mono text-slate-100"
                    />
                  )}
                  <input
                    type="text"
                    required
                    value={originCoords}
                    onChange={(e) => setOriginCoords(e.target.value)}
                    title="Coordenada X|Y da Aldeia de Origem"
                    className="w-24 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-center text-xs font-mono text-amber-300"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Aldeia Alvo (Coordenada X|Y) *
                </label>
                <input
                  type="text"
                  required
                  value={targetCoords}
                  onChange={(e) => setTargetCoords(e.target.value)}
                  placeholder="505|502"
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-slate-400">
                    {timingMode === 'arrival'
                      ? 'Horário Desejado de Chegada *'
                      : 'Horário Exato de Disparo *'}
                  </label>
                  <div className="inline-flex rounded-lg border border-slate-700 bg-[#0f1218] p-0.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => {
                        setTimingMode('arrival');
                        setSingleFormError(null);
                      }}
                      className={`rounded-md px-2 py-0.5 font-semibold transition ${timingMode === 'arrival'
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                      Por Chegada
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTimingMode('send');
                        setSingleFormError(null);
                        const parsedSend = parseLocalDatetimeInput(sendInput);
                        if (!Number.isFinite(parsedSend) || parsedSend <= Date.now() + 15_000) {
                          setSendInput(formatDefaultFutureDatetime(5 * 60 * 1000));
                        }
                      }}
                      className={`rounded-md px-2 py-0.5 font-semibold transition ${timingMode === 'send'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                      Por Disparo
                    </button>
                  </div>
                </div>
                {timingMode === 'arrival' ? (
                  <input
                    type="datetime-local"
                    step="1"
                    required
                    value={arrivalInput}
                    onChange={(e) => {
                      setArrivalInput(e.target.value);
                      setSingleFormError(null);
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-100"
                  />
                ) : (
                  <input
                    type="datetime-local"
                    step="1"
                    required
                    value={sendInput}
                    onChange={(e) => {
                      setSendInput(e.target.value);
                      setSingleFormError(null);
                    }}
                    className="w-full rounded-lg border border-emerald-500/50 bg-[#0f1218] px-3 py-2 text-xs text-emerald-200"
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Tipo de Comando</label>
                <select
                  value={commandType}
                  onChange={(e) =>
                    setCommandType(e.target.value as 'attack' | 'support' | 'noble4' | 'fake')
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="attack">Ataque Real (Confirmar Atacar)</option>
                  <option value="noble4">Noble Train (NT Multi-Ondas)</option>
                  <option value="fake">Fake (Confirmar Atacar)</option>
                  <option value="support">Apoio / Defesa (Confirmar Apoiar)</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] text-slate-400">Unidade Mais Lenta</label>
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-medium ${isSlowestUnitLocked ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    title={
                      isSlowestUnitLocked
                        ? 'Definida automaticamente pela tropa mais lenta com quantidade > 0. Zere as tropas para selecionar livremente.'
                        : 'Seleção livre ativa (nenhuma tropa > 0 preenchida).'
                    }
                  >
                    {isSlowestUnitLocked ? (
                      <>
                        <Lock className="h-2.5 w-2.5" /> Auto (pelas tropas)
                      </>
                    ) : (
                      <>
                        <Unlock className="h-2.5 w-2.5" /> Livre seleção
                      </>
                    )}
                  </span>
                </div>
                <select
                  value={effectiveSlowestUnit}
                  disabled={isSlowestUnitLocked}
                  onChange={(e) => setSlowestUnit(e.target.value as TwUnitType)}
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs ${isSlowestUnitLocked
                    ? 'border-amber-500/30 bg-[#0f1218]/70 text-amber-200 cursor-not-allowed opacity-90'
                    : 'border-slate-700 bg-[#0f1218] text-slate-100'
                    }`}
                >
                  {visibleTroopKeys.map((key) => (
                    <option key={key} value={key}>
                      {UNIT_LABELS[key].label} ({getUnitMinPerField(key)} min/campo)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Ondas (Waves / NT)</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={waves}
                  onChange={(e) => handleWavesChange(Number(e.target.value) || 1)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Abrir Confirmação Antes (s)
                </label>
                <input
                  type="number"
                  min={20}
                  max={90}
                  value={triggerBeforeSec}
                  onChange={(e) => setTriggerBeforeSec(Number(e.target.value) || 30)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
            </div>

            {/* Multi-Wave Selector & Per-Wave Configuration Bar */}
            {waves > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-amber-300">
                    Configurar Tropas por Onda:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: waves }, (_, i) => {
                      const wData = allWavesTroops[i] || {};
                      const total = Object.values(wData).reduce((a, b) => a + (Number(b) || 0), 0);
                      const hasNoble = (Number(wData.snob) || 0) > 0;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setActiveWaveTab(i)}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${activeWaveTab === i
                            ? 'bg-amber-500 text-slate-950 shadow-sm'
                            : 'bg-[#0f1218] text-slate-300 hover:text-amber-200 border border-slate-700'
                            }`}
                        >
                          <span>Onda {i + 1}</span>
                          <span className="text-[10px] opacity-80">
                            ({total} un{hasNoble ? ' • 1 nobre' : ''})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={copyWave1ToAll}
                    className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-amber-400 hover:text-amber-300"
                    title="Copia a composição inteira de tropas da Onda 1 para as Ondas 2..N"
                  >
                    Copiar Onda 1 para Todas
                  </button>
                  <button
                    type="button"
                    onClick={setupStandardNt}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
                    title="Configura Onda 1 com ataque completo + 1 nobre, e Ondas 2..N com 100 bárbaros + 1 nobre de escolta"
                  >
                    Trem NT Padrão (1 Nobre por onda)
                  </button>
                  <button
                    type="button"
                    onClick={clearCurrentWave}
                    className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-[11px] text-slate-400 hover:text-rose-300"
                  >
                    Zerar Onda {activeWaveTab + 1}
                  </button>
                </div>
              </div>
            )}

            {/* Troop Quantities Row */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-400">
                  {waves > 1 ? (
                    <>
                      Tropas da <strong className="text-amber-300">Onda {activeWaveTab + 1}</strong> de{' '}
                      <strong className="text-slate-200">{waves} ondas</strong>
                    </>
                  ) : (
                    'Tropas do Comando'
                  )}{' '}
                  {isSlowestUnitLocked && (
                    <span className="text-amber-300">
                      • Velocidade ditada por: {UNIT_LABELS[effectiveSlowestUnit]?.label} (
                      {getUnitMinPerField(effectiveSlowestUnit)}m/c)
                    </span>
                  )}
                </span>
                {isSlowestUnitLocked && (
                  <button
                    type="button"
                    onClick={clearAllWavesTroops}
                    className="text-[11px] text-slate-400 hover:text-amber-300 underline"
                  >
                    Zerar todas as tropas (liberar seleção manual de unidade)
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-10 gap-2">
                {visibleTroopKeys.map((u) => {
                  const currentWaveData = (waves > 1 ? allWavesTroops[activeWaveTab] : troops) || {};
                  const isSlowestActive = isSlowestUnitLocked && effectiveSlowestUnit === u;
                  return (
                    <div
                      key={u}
                      className={`rounded-lg border p-2 transition ${isSlowestActive
                        ? 'border-amber-500/60 bg-amber-500/10'
                        : 'border-slate-800 bg-[#0f1218]'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <label className="block text-[10px] text-slate-400 truncate">
                          {UNIT_LABELS[u].label}
                        </label>
                        <span className="text-[11px] tabular-nums text-slate-500">
                          {getUnitMinPerField(u)}m
                        </span>
                      </div>
                      <input
                        type="number"
                        min={0}
                        value={currentWaveData[u] ?? 0}
                        onChange={(e) => handleTroopChange(u, Number(e.target.value) || 0)}
                        className="w-full bg-transparent text-xs font-semibold text-slate-100 focus:outline-none mt-0.5"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {(singleFormError || preview?.isPast || preview?.isInvalidTime) && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
                {singleFormError ||
                  (preview?.isInvalidTime
                    ? 'Informe uma data e hora válidas para o agendamento.'
                    : 'O horário de disparo calculado está no passado. Ajuste a data/hora para um horário futuro antes de agendar.')}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Etiqueta / Observação (Ex: OP Tribo K55 - Aldeia Alvo Principal)"
                className="w-full max-w-md rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-200"
              />

              <button
                type="submit"
                disabled={
                  !selectedAccount ||
                  !preview ||
                  preview.isInvalidTime ||
                  preview.isPast
                }
                className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="h-4 w-4" />
                Adicionar à Fila de Envio Automático
              </button>
            </div>
          </form>
        </>
      )}

      {activeMode === 'planner' && (
        <div className="space-y-6">
          {plannerMessage && (
            <div className="flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
              <span>{plannerMessage}</span>
              <button
                type="button"
                onClick={() => setPlannerMessage(null)}
                className="text-amber-300 hover:underline"
              >
                Fechar
              </button>
            </div>
          )}

          {/* Step A: Origin Villages, Combined Sync, Groups & Troop Filters */}
          <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <Castle className="h-5 w-5 text-amber-400" />
                <div>
                  <h2 className="text-sm font-bold text-slate-100">
                    1. Aldeias de Origem & Filtros de Tropas (Visão Combinada)
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Leia todas as aldeias e tropas pela Visão Combinada, filtre por grupo/tropas e selecione as origens da OP
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={selectedTwGroupId}
                  onChange={(e) => handleTwGroupChange(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-200"
                  title="Grupo dinâmico do Tribal Wars"
                >
                  {(selectedAccount?.villageGroups && selectedAccount.villageGroups.length > 0
                    ? selectedAccount.villageGroups
                    : [{ id: '0', name: 'Todas' }]
                  ).map((g) => (
                    <option key={g.id} value={g.id}>
                      Grupo TW: {g.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={!selectedAccount || syncingCombined}
                  onClick={() =>
                    selectedAccount && syncCombinedForGroup(selectedAccount._id, selectedTwGroupId)
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncingCombined ? 'animate-spin' : ''}`} />
                  {syncingCombined ? 'Lendo Tropas...' : 'Sincronizar Visão Combinada + Tropas'}
                </button>
              </div>
            </div>

            {/* Filters Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 items-end">
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">
                  Categoria Local (App)
                </label>
                <select
                  value={localCategoryFilter}
                  onChange={(e) => setLocalCategoryFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="ALL">Todas Categorias</option>
                  {LOCAL_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">Bárbaros &gt;=</label>
                <input
                  type="number"
                  min={0}
                  value={minTroopFilters.axe}
                  onChange={(e) =>
                    setMinTroopFilters((p) => ({ ...p, axe: Math.max(0, Number(e.target.value) || 0) }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">Cav. Leve &gt;=</label>
                <input
                  type="number"
                  min={0}
                  value={minTroopFilters.light}
                  onChange={(e) =>
                    setMinTroopFilters((p) => ({
                      ...p,
                      light: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">Aríetes &gt;=</label>
                <input
                  type="number"
                  min={0}
                  value={minTroopFilters.ram}
                  onChange={(e) =>
                    setMinTroopFilters((p) => ({ ...p, ram: Math.max(0, Number(e.target.value) || 0) }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">Nobres &gt;=</label>
                <input
                  type="number"
                  min={0}
                  value={minTroopFilters.snob}
                  onChange={(e) =>
                    setMinTroopFilters((p) => ({ ...p, snob: Math.max(0, Number(e.target.value) || 0) }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">Exploradores &gt;=</label>
                <input
                  type="number"
                  min={0}
                  value={minTroopFilters.spy}
                  onChange={(e) =>
                    setMinTroopFilters((p) => ({ ...p, spy: Math.max(0, Number(e.target.value) || 0) }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMinTroopFilters({ axe: 0, light: 0, ram: 0, snob: 0, spy: 0 })}
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800"
                >
                  Limpar Filtros
                </button>
              </div>
            </div>

            {/* Quick Troop Presets + Local Category Tagging */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 text-slate-400 mr-1">
                  <Filter className="h-3.5 w-3.5 text-amber-400" /> Atalhos:
                </span>
                <button
                  type="button"
                  onClick={() => setMinTroopFilters({ axe: 5000, light: 0, ram: 200, snob: 0, spy: 0 })}
                  className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-slate-200 hover:border-amber-500/50"
                >
                  Fulls Ataque (5k+ Bár / 200+ Arí)
                </button>
                <button
                  type="button"
                  onClick={() => setMinTroopFilters({ axe: 0, light: 0, ram: 0, snob: 1, spy: 0 })}
                  className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-slate-200 hover:border-amber-500/50"
                >
                  Com Nobres (1+)
                </button>
                <button
                  type="button"
                  onClick={() => setMinTroopFilters({ axe: 0, light: 0, ram: 0, snob: 4, spy: 0 })}
                  className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-slate-200 hover:border-amber-500/50"
                >
                  Prontas p/ NT (4+ Nobres)
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 text-sky-400" />
                <select
                  value={categoryToApply}
                  onChange={(e) => setCategoryToApply(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1 text-[11px] text-slate-200"
                >
                  {LOCAL_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                  <option value="CLEAR">Remover Categoria</option>
                </select>
                <button
                  type="button"
                  disabled={selectedOriginIds.length === 0}
                  onClick={() => handleApplyLocalCategory(categoryToApply)}
                  className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-medium text-sky-300 hover:bg-sky-500/20 disabled:opacity-40"
                >
                  Marcar Selecionadas ({selectedOriginIds.length})
                </button>
              </div>
            </div>

            {/* Origin Villages Table */}
            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-slate-300">
                Mostrando <strong className="text-amber-300">{filteredOriginVillages.length}</strong>{' '}
                aldeia(s) • Selecionadas para a OP:{' '}
                <strong className="text-emerald-400">{selectedOriginIds.length}</strong>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedOriginIds(filteredOriginVillages.map((v) => v.id))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  <CheckSquare className="h-3 w-3 text-emerald-400" />
                  Selecionar Todas ({filteredOriginVillages.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedOriginIds([])}
                  className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                >
                  Limpar Seleção
                </button>
              </div>
            </div>

            {filteredOriginVillages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 py-8 text-center text-xs text-slate-400">
                Nenhuma aldeia de origem corresponde aos filtros atuais. Clique em "Sincronizar Visão Combinada + Tropas" ou ajuste os filtros.
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#0f1218] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2 px-3 w-8">
                        <input
                          type="checkbox"
                          checked={
                            filteredOriginVillages.length > 0 &&
                            filteredOriginVillages.every((v) => selectedOriginIds.includes(v.id))
                          }
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedOriginIds(filteredOriginVillages.map((v) => v.id));
                            } else {
                              setSelectedOriginIds([]);
                            }
                          }}
                        />
                      </th>
                      <th className="py-2 px-3">Aldeia de Origem</th>
                      <th className="py-2 px-3">Coords</th>
                      <th className="py-2 px-3">Categoria</th>
                      <th className="py-2 px-3">Tropas em Casa (Visão Combinada)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredOriginVillages.map((v) => {
                      const isChecked = selectedOriginIds.includes(v.id);
                      const troopItems = Object.entries(v.troops || {}).filter(
                        ([, qty]) => Number(qty) > 0
                      );
                      return (
                        <tr
                          key={v.id}
                          onClick={() =>
                            setSelectedOriginIds((prev) =>
                              prev.includes(v.id)
                                ? prev.filter((id) => id !== v.id)
                                : [...prev, v.id]
                            )
                          }
                          className={`cursor-pointer transition ${isChecked ? 'bg-amber-500/10' : 'hover:bg-slate-900/50'
                            }`}
                        >
                          <td className="py-2 px-3" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedOriginIds((prev) =>
                                    prev.includes(v.id) ? prev : [...prev, v.id]
                                  );
                                } else {
                                  setSelectedOriginIds((prev) => prev.filter((id) => id !== v.id));
                                }
                              }}
                            />
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-100">{v.name}</td>
                          <td className="py-2 px-3 font-mono text-amber-300">{v.coords}</td>
                          <td className="py-2 px-3">
                            {v.localCategory ? (
                              <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-[10px] text-sky-300">
                                {v.localCategory}
                              </span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            {troopItems.length === 0 ? (
                              <span className="text-slate-500 text-[11px]">
                                Sem tropas lidas (clique Sincronizar Visão Combinada)
                              </span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {troopItems.map(([u, qty]) => (
                                  <span
                                    key={u}
                                    className="rounded border border-slate-700/80 bg-[#0f1218] px-1.5 py-0.5 text-[10px] text-slate-200"
                                  >
                                    {Number(qty).toLocaleString('pt-BR')}{' '}
                                    {SHORT_UNIT_NAMES[u as TwUnitType] || u}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Step B: Target Player Search & Bulk Target Coords */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
              <div className="flex items-center gap-2.5 border-b border-slate-800 pb-3">
                <Users className="h-5 w-5 text-rose-400" />
                <div>
                  <h2 className="text-sm font-bold text-slate-100">
                    2. Buscar Jogador Alvo / Coordenada (`/map/player.txt` + `village.txt`)
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Pesquise pelo nick do inimigo ou coordenada para listar todas as suas aldeias no mundo
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                  <input
                    type="text"
                    value={targetSearchQuery}
                    onChange={(e) => setTargetSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSearchTargetPlayer();
                      }
                    }}
                    placeholder="Nick do jogador inimigo ou coord (ex: 510|495)"
                    className="w-full rounded-xl border border-slate-700 bg-[#0f1218] pl-9 pr-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <button
                  type="button"
                  disabled={!selectedAccount || searchingTargets || !targetSearchQuery.trim()}
                  onClick={() => handleSearchTargetPlayer()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-40"
                >
                  <Search className={`h-3.5 w-3.5 ${searchingTargets ? 'animate-spin' : ''}`} />
                  {searchingTargets ? 'Buscando...' : 'Buscar Alvo'}
                </button>
              </div>

              {/* Matched Players Chips */}
              {matchedPlayers.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedPlayerFilterId('ALL')}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border ${selectedPlayerFilterId === 'ALL'
                      ? 'border-rose-500/60 bg-rose-500/20 text-rose-200'
                      : 'border-slate-700 bg-[#0f1218] text-slate-300'
                      }`}
                  >
                    Todos ({matchedPlayers.length})
                  </button>
                  {matchedPlayers.slice(0, 8).map((pl) => (
                    <button
                      key={pl.id}
                      type="button"
                      onClick={() => {
                        if (foundTargetVillages.length <= 1 && matchedPlayers.length === 1) {
                          handleSearchTargetPlayer(pl.name);
                        } else {
                          setSelectedPlayerFilterId(pl.id);
                        }
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border ${selectedPlayerFilterId === pl.id
                        ? 'border-rose-500/60 bg-rose-500/20 text-rose-200'
                        : 'border-slate-700 bg-[#0f1218] text-slate-300 hover:border-rose-500/40'
                        }`}
                    >
                      {pl.name} ({pl.villagesCount} alds • {pl.points.toLocaleString('pt-BR')} pts)
                    </button>
                  ))}
                </div>
              )}

              {/* Target Villages Filter & Add Buttons */}
              {foundTargetVillages.length > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <select
                      value={selectedContinentFilter}
                      onChange={(e) => setSelectedContinentFilter(e.target.value)}
                      className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1 text-[11px] text-slate-200"
                    >
                      <option value="ALL">Todos Continentes ({foundTargetVillages.length})</option>
                      {targetContinents.map((k) => (
                        <option key={k} value={k}>
                          Continente {k}
                        </option>
                      ))}
                    </select>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={selectedFoundTargetIds.length === 0}
                        onClick={handleAddSelectedFoundTargets}
                        className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                      >
                        + Adicionar Selecionadas ({selectedFoundTargetIds.length})
                      </button>
                      <button
                        type="button"
                        onClick={handleAddAllFilteredTargets}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/20"
                      >
                        + Adicionar Todas ({filteredTargetVillages.length})
                      </button>
                    </div>
                  </div>

                  <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-[#0f1218] text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-1.5 px-2.5 w-7">
                            <input
                              type="checkbox"
                              checked={
                                filteredTargetVillages.length > 0 &&
                                filteredTargetVillages.every((v) =>
                                  selectedFoundTargetIds.includes(v.id)
                                )
                              }
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedFoundTargetIds(
                                    filteredTargetVillages.map((v) => v.id)
                                  );
                                } else {
                                  setSelectedFoundTargetIds([]);
                                }
                              }}
                            />
                          </th>
                          <th className="py-1.5 px-2.5">Aldeia Alvo</th>
                          <th className="py-1.5 px-2.5">Coord</th>
                          <th className="py-1.5 px-2.5">K</th>
                          <th className="py-1.5 px-2.5">Pontos</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {filteredTargetVillages.map((tv) => {
                          const checked = selectedFoundTargetIds.includes(tv.id);
                          return (
                            <tr
                              key={tv.id}
                              onClick={() =>
                                setSelectedFoundTargetIds((prev) =>
                                  prev.includes(tv.id)
                                    ? prev.filter((id) => id !== tv.id)
                                    : [...prev, tv.id]
                                )
                              }
                              className={`cursor-pointer ${checked ? 'bg-rose-500/10' : 'hover:bg-slate-900/40'
                                }`}
                            >
                              <td className="py-1.5 px-2.5" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedFoundTargetIds((prev) =>
                                        prev.includes(tv.id) ? prev : [...prev, tv.id]
                                      );
                                    } else {
                                      setSelectedFoundTargetIds((prev) =>
                                        prev.filter((id) => id !== tv.id)
                                      );
                                    }
                                  }}
                                />
                              </td>
                              <td className="py-1.5 px-2.5 text-slate-100">
                                <div>{tv.name}</div>
                                {tv.playerName && (
                                  <div className="text-[10px] text-slate-400">{tv.playerName}</div>
                                )}
                              </td>
                              <td className="py-1.5 px-2.5 font-mono text-rose-300">{tv.coords}</td>
                              <td className="py-1.5 px-2.5 text-slate-400">{tv.continent}</td>
                              <td className="py-1.5 px-2.5 text-slate-300">
                                {tv.points.toLocaleString('pt-BR')}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Bulk Coordinate Paste & Selected Targets List */}
            <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2.5">
                  <Crosshair className="h-5 w-5 text-amber-400" />
                  <div>
                    <h2 className="text-sm font-bold text-slate-100">
                      Lista de Alvos da Operação ({opTargets.length})
                    </h2>
                    <p className="text-[11px] text-slate-400">
                      Adicione pela busca ao lado ou cole múltiplas coordenadas (BBCode / lista / texto livre)
                    </p>
                  </div>
                </div>
                {opTargets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpTargets([])}
                    className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:text-rose-300"
                  >
                    Limpar Alvos
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <textarea
                  rows={3}
                  value={bulkCoordsInput}
                  onChange={(e) => setBulkCoordsInput(e.target.value)}
                  placeholder="Cole coordenadas aqui em lote: Ex: 510|495 512|498 [coord]515|500[/coord]"
                  className="w-full rounded-xl border border-slate-700 bg-[#0f1218] p-3 text-xs font-mono text-slate-100"
                />
                <button
                  type="button"
                  disabled={!bulkCoordsInput.trim()}
                  onClick={handleExtractBulkCoords}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Extrair e Adicionar Coordenadas
                </button>
              </div>

              {opTargets.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 py-6 text-center text-xs text-slate-400">
                  Nenhum alvo adicionado à OP ainda.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto p-1">
                  {opTargets.map((t) => (
                    <span
                      key={t.coords}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200"
                    >
                      <span className="font-mono font-semibold">{t.coords}</span>
                      {t.playerName && (
                        <span className="text-[10px] text-rose-300/80">({t.playerName})</span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setOpTargets((prev) => prev.filter((item) => item.coords !== t.coords))
                        }
                        className="text-rose-300 hover:text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Step C: Attack Builder (Manual Matrix) + Curated Attack List & Optional Sync */}
          <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <Sword className="h-5 w-5 text-amber-400" />
                <div>
                  <h2 className="text-sm font-bold text-slate-100">
                    3. Configurador de Ataques &amp; Lista da Operação
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Monte cada ataque escolhendo origem, alvo, tropas e horário (envio ou chegada) e adicione à lista. Chegada ou envio sincronizado são opcionais.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {multiWindowOverlapIds.size > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[11px] font-semibold text-amber-200">
                    <Layers className="h-3.5 w-3.5" />
                    Multi-Janela Automática: {multiWindowOverlapIds.size} comandos na mesma janela
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowAutoBatchPanel((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-amber-500/50"
                >
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  {showAutoBatchPanel ? 'Ocultar Gerador em Lote' : 'Gerador em Lote (Opcional)'}
                </button>
              </div>
            </div>

            {/* 3A: Attack Builder (Configuração Individual de Ataque) */}
            <div className="rounded-xl border border-slate-800/90 bg-[#0f1218]/70 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300">
                  Configurar Novo Ataque para a Lista
                </h3>
                <button
                  type="button"
                  onClick={() => setBuilderShowTroopEditor((v) => !v)}
                  className="rounded-lg border border-slate-700 bg-[#141923] px-2.5 py-1 text-[11px] text-slate-300 hover:border-amber-500/50"
                >
                  {builderShowTroopEditor || opMissionPresetId === 'custom'
                    ? 'Ocultar Editor de Tropas/Ondas'
                    : 'Editar Tropas & Ondas'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                {/* Origin selector */}
                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Aldeia de Origem
                  </label>
                  <select
                    value={builderOriginVillage?.id || ''}
                    onChange={(e) => setBuilderOriginId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100"
                  >
                    {accountVillages.length === 0 && (
                      <option value="">Sincronize as aldeias no Passo 1</option>
                    )}
                    {accountVillages.map((v) => {
                      const isSel = selectedOriginIds.includes(v.id);
                      const t = v.troops || {};
                      return (
                        <option key={v.id} value={v.id}>
                          {isSel ? '[Sel] ' : ''}
                          {v.name} ({v.coords}) — Bár:{t.axe || 0} CL:{t.light || 0} Arí:{t.ram || 0} Nob:{t.snob || 0}
                        </option>
                      );
                    })}
                  </select>
                </div>

                {/* Target selector + manual coords */}
                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Alvo (Passo 2 ou Coordenada Manual)
                  </label>
                  <div className="flex gap-1.5">
                    <select
                      value={
                        opTargets.some((t) => t.coords === builderResolvedTarget?.coords)
                          ? builderResolvedTarget?.coords || ''
                          : '__manual__'
                      }
                      onChange={(e) => {
                        if (e.target.value !== '__manual__') {
                          setBuilderTargetCoords(e.target.value);
                        }
                      }}
                      className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-2 text-xs text-slate-100"
                    >
                      <option value="__manual__">Manual...</option>
                      {opTargets.map((t) => (
                        <option key={t.coords} value={t.coords}>
                          {t.coords} {t.playerName ? `(${t.playerName})` : t.villageName ? `(${t.villageName})` : ''}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={builderTargetCoords}
                      onChange={(e) => setBuilderTargetCoords(e.target.value)}
                      placeholder="Ex: 500|500"
                      className="w-1/2 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs font-mono text-slate-100"
                    />
                  </div>
                </div>

                {/* Mission / Troops Preset */}
                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Modelo de Tropas / Missão
                  </label>
                  <select
                    value={opMissionPresetId}
                    onChange={(e) => handleSelectOpMission(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100"
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({UNIT_LABELS[p.slowestUnit]?.label} • {p.waves || 1}x)
                      </option>
                    ))}
                    <option value="custom">
                      Personalizado (Configurar Tropas / Ondas)
                    </option>
                  </select>
                </div>
              </div>

              {/* Per-attack timing & note */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Tipo de Horário deste Ataque
                  </label>
                  <select
                    value={builderEffectiveTimingMode}
                    disabled={opSyncMode !== 'manual'}
                    onChange={(e) =>
                      setBuilderTimingMode(e.target.value as 'arrival' | 'send')
                    }
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100 disabled:opacity-60"
                  >
                    <option value="arrival">Horário de Chegada</option>
                    <option value="send">Horário de Envio</option>
                  </select>
                </div>

                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    {builderEffectiveTimingMode === 'send'
                      ? 'Data/Hora de Envio (Disparo)'
                      : 'Data/Hora de Chegada'}
                    {opSyncMode !== 'manual' && (
                      <span className="ml-1.5 text-[10px] text-amber-300">(Sincronizado)</span>
                    )}
                  </label>
                  <input
                    type="datetime-local"
                    step="1"
                    value={builderEffectiveTimeInput}
                    disabled={opSyncMode !== 'manual'}
                    onChange={(e) => setBuilderTimeInput(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100 disabled:opacity-60"
                  />
                </div>

                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Etiqueta / Nota do Ataque
                  </label>
                  <input
                    type="text"
                    value={opNotes}
                    onChange={(e) => setOpNotes(e.target.value)}
                    placeholder="Ex: Full 1, NT Alvo Sul..."
                    className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-2 text-xs text-slate-200"
                  />
                </div>

                <div>
                  <button
                    type="button"
                    onClick={handleAddManualAttack}
                    disabled={!builderOriginVillage || !builderResolvedTarget}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" />
                    Adicionar à Lista
                  </button>
                </div>
              </div>

              {/* Inline Troop & Wave Editor for Planner */}
              {(builderShowTroopEditor || opMissionPresetId === 'custom') && (
                <div className="rounded-xl border border-slate-800 bg-[#141923] p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={opMissionPresetId === 'custom' ? commandType : opCommandType}
                        onChange={(e) => {
                          const val = e.target.value as 'attack' | 'support' | 'noble4' | 'fake';
                          if (opMissionPresetId === 'custom') setCommandType(val);
                          else setOpCommandType(val);
                        }}
                        className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                      >
                        <option value="attack">Ataque</option>
                        <option value="support">Apoio</option>
                        <option value="noble4">Trem de Nobres</option>
                        <option value="fake">Fake</option>
                      </select>

                      <select
                        value={opMissionPresetId === 'custom' ? slowestUnit : opSlowestUnit}
                        onChange={(e) => {
                          const val = e.target.value as TwUnitType;
                          if (opMissionPresetId === 'custom') setSlowestUnit(val);
                          else setOpSlowestUnit(val);
                        }}
                        className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                      >
                        {Object.entries(UNIT_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            Base: {v.label}
                          </option>
                        ))}
                      </select>

                      <div className="flex items-center gap-1.5 text-xs text-slate-300">
                        <span>Ondas:</span>
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={effectiveOpMission.waves}
                          onChange={(e) => {
                            const w = Math.max(1, Math.min(5, Number(e.target.value) || 1));
                            if (opMissionPresetId === 'custom') {
                              setWaves(w);
                            } else {
                              setOpWaves(w);
                              setOpAllWavesTroops((prev) =>
                                Array.from({ length: w }, (_, idx) => ({
                                  ...(prev[idx] || prev[0] || opTroops),
                                }))
                              );
                            }
                            if (builderActiveWaveTab >= w) setBuilderActiveWaveTab(w - 1);
                          }}
                          className="w-14 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1 text-xs text-slate-100"
                        />
                      </div>
                    </div>

                    {effectiveOpMission.waves > 1 && (
                      <div className="flex flex-wrap gap-1">
                        {Array.from({ length: effectiveOpMission.waves }, (_, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setBuilderActiveWaveTab(idx)}
                            className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${builderActiveWaveTab === idx
                              ? 'bg-amber-500 text-slate-950'
                              : 'border border-slate-700 bg-[#0f1218] text-slate-300'
                              }`}
                          >
                            Onda {idx + 1}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-12 gap-2">
                    {(Object.keys(UNIT_LABELS) as TwUnitType[]).map((unit) => {
                      const waveIdx = Math.min(
                        builderActiveWaveTab,
                        Math.max(0, effectiveOpMission.waves - 1)
                      );
                      const currentWaveTroops =
                        effectiveOpMission.allWavesTroops[waveIdx] ||
                        effectiveOpMission.troops ||
                        {};
                      return (
                        <div key={unit}>
                          <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                            {SHORT_UNIT_NAMES[unit] || unit}
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={currentWaveTroops[unit] || 0}
                            onChange={(e) => {
                              const qty = Math.max(0, Number(e.target.value) || 0);
                              if (opMissionPresetId === 'custom') {
                                setAllWavesTroops((prev) => {
                                  const next = [...prev];
                                  next[waveIdx] = { ...(next[waveIdx] || {}), [unit]: qty };
                                  if (waveIdx === 0) setTroops(next[0]);
                                  return next;
                                });
                              } else {
                                setOpAllWavesTroops((prev) => {
                                  const next = [...prev];
                                  next[waveIdx] = { ...(next[waveIdx] || {}), [unit]: qty };
                                  if (waveIdx === 0) setOpTroops(next[0]);
                                  return next;
                                });
                              }
                            }}
                            className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1 text-xs text-slate-100"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Live Single-Attack Preview Strip */}
              {builderPreviewItem && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#141923] px-3 py-2 text-[11px] text-slate-300">
                  <span>
                    Prévia: <strong className="text-amber-300">{builderPreviewItem.originCoords}</strong> →{' '}
                    <strong className="text-rose-300">{builderPreviewItem.targetCoords}</strong>
                  </span>
                  <span>Distância: <strong>{builderPreviewItem.distance}</strong> campos</span>
                  <span>Viagem: <strong>{formatDuration(builderPreviewItem.travelTimeMs)}</strong></span>
                  <span>
                    Disparo:{' '}
                    <strong className={builderPreviewItem.sendTimeMs <= Date.now() ? 'text-rose-400' : 'text-emerald-400'}>
                      {new Date(builderPreviewItem.sendTimeMs).toLocaleString('pt-BR')}
                    </strong>
                  </span>
                  <span>
                    Chegada:{' '}
                    <strong className="text-sky-300">
                      {new Date(builderPreviewItem.arrivalTimeMs).toLocaleString('pt-BR')}
                    </strong>
                  </span>
                </div>
              )}
            </div>

            {/* Optional Auto-Batch Generator (Collapsible) */}
            {showAutoBatchPanel && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-amber-200">
                    Gerador Automático em Lote (adiciona pares Origem→Alvo do Passo 1 e Passo 2 à Lista)
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Estratégia de Alocação
                    </label>
                    <select
                      value={opAllocationStrategy}
                      onChange={(e) =>
                        setOpAllocationStrategy(e.target.value as 'nearest' | 'round-robin')
                      }
                      className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100"
                    >
                      <option value="nearest">Mais Próximas (Distância)</option>
                      <option value="round-robin">Round-Robin (Alternada)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Máx. Cmds / Origem
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={opMaxPerOrigin}
                      onChange={(e) => setOpMaxPerOrigin(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Cmds por Alvo
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={opPerTarget}
                      onChange={(e) => setOpPerTarget(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-2 text-xs text-slate-100"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateAutoBatchToList}
                    disabled={selectedOriginVillages.length === 0 || opTargets.length === 0}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-500/50 bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-40"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Gerar e Adicionar à Lista
                  </button>
                </div>
              </div>
            )}

            {/* 3B: Optional Global Sync Bar & Attack List Actions */}
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-slate-800 bg-[#0f1218]/60 p-3.5">
              <div className="flex flex-wrap items-end gap-2.5">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">
                    Sincronização Global (Opcional)
                  </label>
                  <select
                    value={opSyncMode}
                    onChange={(e) =>
                      setOpSyncMode(e.target.value as 'manual' | 'arrival' | 'send')
                    }
                    className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                  >
                    <option value="manual">Individual (Cada ataque com seu horário)</option>
                    <option value="arrival">Chegada Sincronizada (Opcional)</option>
                    <option value="send">Envio Sincronizado (Opcional)</option>
                  </select>
                </div>

                {opSyncMode !== 'manual' && (
                  <>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">
                        {opSyncMode === 'arrival'
                          ? 'Horário de Chegada Sincronizada'
                          : 'Horário de Envio Sincronizado'}
                      </label>
                      <input
                        type="datetime-local"
                        step="1"
                        value={opSyncTimeInput}
                        onChange={(e) => setOpSyncTimeInput(e.target.value)}
                        className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={selectedPlanIds.length === 0}
                      onClick={() => handleApplySyncToList(opSyncMode, 'selected')}
                      className="rounded-lg border border-slate-700 bg-[#141923] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-amber-500/50 disabled:opacity-40"
                    >
                      Aplicar aos Selecionados ({selectedPlanIds.length})
                    </button>
                    <button
                      type="button"
                      disabled={opAttackList.length === 0}
                      onClick={() => handleApplySyncToList(opSyncMode, 'all')}
                      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
                    >
                      Aplicar a Todos ({opAttackList.length})
                    </button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {opAttackList.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpAttackList([]);
                      setSelectedPlanIds([]);
                    }}
                    className="rounded-lg border border-slate-700 px-2.5 py-2 text-[11px] text-slate-300 hover:bg-slate-800"
                  >
                    Limpar Lista
                  </button>
                )}
                <button
                  type="button"
                  disabled={!selectedAccount || selectedPlanIds.length === 0 || enqueueingBatch}
                  onClick={() => handleEnqueueAttacks('selected')}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/60 bg-amber-500/20 px-4 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-40"
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  Enviar Selecionados ({selectedPlanIds.length})
                </button>
                <button
                  type="button"
                  disabled={!selectedAccount || opAttackList.length === 0 || enqueueingBatch}
                  onClick={() => handleEnqueueAttacks('all')}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" />
                  {enqueueingBatch
                    ? 'Enfileirando...'
                    : `Enviar Todos (${opAttackList.length})`}
                </button>
              </div>
            </div>

            {/* Curated Attack List Table */}
            {opAttackList.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 py-8 text-center text-xs text-slate-400">
                Sua lista de ataques da operação está vazia. Configure um ataque acima e clique em{' '}
                <strong>Adicionar à Lista</strong> (ou use o <strong>Gerador em Lote</strong>).
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#0f1218] text-slate-400 border-b border-slate-800 z-10">
                    <tr>
                      <th className="py-2 px-3 w-8">
                        <input
                          type="checkbox"
                          checked={
                            opAttackList.length > 0 &&
                            selectedPlanIds.length === opAttackList.length
                          }
                          onChange={(e) =>
                            setSelectedPlanIds(
                              e.target.checked ? opAttackList.map((i) => i.id) : []
                            )
                          }
                          title="Selecionar todos os ataques"
                        />
                      </th>
                      <th className="py-2 px-2">#</th>
                      <th className="py-2 px-2">Origem</th>
                      <th className="py-2 px-2">Alvo</th>
                      <th className="py-2 px-2">Tropas / Missão</th>
                      <th className="py-2 px-2">Modo</th>
                      <th className="py-2 px-2">Disparo (Envio)</th>
                      <th className="py-2 px-2">Chegada</th>
                      <th className="py-2 px-2">Execução</th>
                      <th className="py-2 px-3 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {opAttackList.map((row, idx) => {
                      const isPast = row.sendTimeMs <= Date.now();
                      const isMultiWin = multiWindowOverlapIds.has(row.id);
                      const isChecked = selectedPlanIds.includes(row.id);
                      const rowMode: 'arrival' | 'send' = row.timingMode || 'arrival';
                      const troopSummary = Object.entries(row.troops || {})
                        .filter(([, q]) => (Number(q) || 0) > 0)
                        .slice(0, 4)
                        .map(([u, q]) => `${SHORT_UNIT_NAMES[u as TwUnitType] || u}:${q}`)
                        .join(' ');
                      return (
                        <tr
                          key={row.id}
                          className={`hover:bg-slate-900/40 ${isChecked ? 'bg-amber-500/5' : ''}`}
                        >
                          <td className="py-2 px-3">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedPlanIds((prev) =>
                                    prev.includes(row.id) ? prev : [...prev, row.id]
                                  );
                                } else {
                                  setSelectedPlanIds((prev) =>
                                    prev.filter((id) => id !== row.id)
                                  );
                                }
                              }}
                            />
                          </td>
                          <td className="py-2 px-2 text-slate-500 font-mono">{idx + 1}</td>
                          <td className="py-2 px-2">
                            <div className="font-semibold text-slate-100">
                              {row.originVillageName}
                            </div>
                            <div className="font-mono text-[11px] text-amber-300">
                              {row.originCoords} • {row.distance}c
                            </div>
                          </td>
                          <td className="py-2 px-2">
                            <div className="font-mono font-semibold text-rose-300">
                              {row.targetCoords}
                            </div>
                            {row.targetPlayerName && (
                              <div className="text-[11px] text-slate-400">
                                {row.targetPlayerName}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-2 text-slate-300">
                            <div className="flex items-center gap-1">
                              <span>{row.presetName || UNIT_LABELS[row.slowestUnit]?.label}</span>
                              {row.waves > 1 && (
                                <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-300">
                                  {row.waves}x
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {troopSummary || UNIT_LABELS[row.slowestUnit]?.label}
                            </div>
                          </td>
                          <td className="py-2 px-2">
                            <select
                              value={rowMode}
                              onChange={(e) => {
                                const nextMode = e.target.value as 'arrival' | 'send';
                                const baseMs =
                                  nextMode === 'send' ? row.sendTimeMs : row.arrivalTimeMs;
                                handleUpdatePlanItemTiming(
                                  row.id,
                                  nextMode,
                                  toLocalDatetimeInput(baseMs)
                                );
                              }}
                              className="rounded border border-slate-700 bg-[#0f1218] px-1.5 py-1 text-[11px] text-slate-200"
                            >
                              <option value="arrival">Chegada</option>
                              <option value="send">Envio</option>
                            </select>
                          </td>
                          <td className="py-2 px-2 font-mono">
                            {rowMode === 'send' ? (
                              <input
                                type="datetime-local"
                                step="1"
                                value={toLocalDatetimeInput(row.sendTimeMs)}
                                onChange={(e) =>
                                  handleUpdatePlanItemTiming(row.id, 'send', e.target.value)
                                }
                                className={`rounded border border-slate-700 bg-[#0f1218] px-1.5 py-1 text-[11px] ${isPast ? 'text-rose-400' : 'text-emerald-400'
                                  }`}
                              />
                            ) : (
                              <span className={isPast ? 'text-rose-400' : 'text-emerald-400'}>
                                {new Date(row.sendTimeMs).toLocaleString('pt-BR')}
                              </span>
                            )}
                            {isPast && (
                              <span className="ml-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[11px] text-rose-300">
                                Passado
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 font-mono text-sky-300">
                            {rowMode === 'arrival' ? (
                              <input
                                type="datetime-local"
                                step="1"
                                value={toLocalDatetimeInput(row.arrivalTimeMs)}
                                onChange={(e) =>
                                  handleUpdatePlanItemTiming(row.id, 'arrival', e.target.value)
                                }
                                className="rounded border border-slate-700 bg-[#0f1218] px-1.5 py-1 text-[11px] text-sky-300"
                              />
                            ) : (
                              <span>{new Date(row.arrivalTimeMs).toLocaleString('pt-BR')}</span>
                            )}
                          </td>
                          <td className="py-2 px-2">
                            {isMultiWin ? (
                              <span className="rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                                Multi-Janela
                              </span>
                            ) : (
                              <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
                                Janela Única
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDuplicatePlanItem(row)}
                                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-amber-300"
                                title="Duplicar ataque"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemovePlanItem(row.id)}
                                className="rounded p-1 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"
                                title="Remover ataque da lista"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Scheduled Queue Table */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Fila de Comandos Agendados ({commands.length})
            </h3>
          </div>
          {commands.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearQueueOpen(true)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
            >
              Limpar Todos
            </button>
          )}
        </div>

        {commands.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">
            Nenhum comando na fila do Agendador. Utilize a calculadora acima para agendar ataques, NTs ou apoios com envio e confirmação automáticos.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 px-3">Conta</th>
                  <th className="py-2.5 px-3">Tipo / Etiqueta</th>
                  <th className="py-2.5 px-3">Origem → Alvo</th>
                  <th className="py-2.5 px-3">Unidade Base</th>
                  <th className="py-2.5 px-3">Horário de Envio</th>
                  <th className="py-2.5 px-3">Contagem Regressiva</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {commands.map((cmd) => {
                  return (
                    <tr key={cmd.id} className="hover:bg-slate-900/40">
                      <td className="py-3 px-3 font-semibold text-slate-100">
                        {cmd.accountName}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-amber-300">
                            {cmd.presetName || cmd.commandType.toUpperCase()}
                          </span>
                          {cmd.autoDodge?.enabled && (
                            <span className="rounded bg-sky-500/20 border border-sky-500/40 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
                              AUTO-DODGE
                            </span>
                          )}
                          {cmd.waves > 1 && (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200 tabular-nums">
                              {cmd.waves}x Ondas
                            </span>
                          )}
                        </div>
                        {cmd.autoDodge?.enabled && (
                          <div className="mt-1 text-[11px] text-slate-400 tabular-nums">
                            Impacto:{' '}
                            <span className="font-mono text-rose-300">
                              {new Date(cmd.autoDodge.enemyArrivalTimeMs).toLocaleTimeString('pt-BR')}
                            </span>{' '}
                            • Cancelar:{' '}
                            <span className="font-mono text-sky-300">
                              {new Date(cmd.autoDodge.cancelTimeMs).toLocaleTimeString('pt-BR')}
                            </span>{' '}
                            • Retorno est.:{' '}
                            <span className="font-mono text-emerald-300">
                              {new Date(cmd.autoDodge.expectedReturnTimeMs).toLocaleTimeString('pt-BR')}
                            </span>
                          </div>
                        )}
                        {cmd.waves > 1 && cmd.allWavesTroops && cmd.allWavesTroops.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {cmd.allWavesTroops.slice(0, cmd.waves).map((wTroops, wIdx) => {
                              const activeEntries = Object.entries(wTroops || {}).filter(
                                ([_, qty]) => Number(qty) > 0
                              );
                              const summary = activeEntries
                                .map(([u, q]) => `${q} ${u}`)
                                .join(', ');
                              return (
                                <span
                                  key={wIdx}
                                  title={`Onda ${wIdx + 1}: ${summary || '0 tropas'}`}
                                  className="rounded border border-slate-700 bg-surface-base px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300"
                                >
                                  Onda {wIdx + 1}: {summary || '0'}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {cmd.error && (
                          <div className="text-[11px] text-rose-400 mt-0.5">{cmd.error}</div>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-slate-200">
                        {cmd.originCoords} → {cmd.targetCoords}{' '}
                        <span className="text-slate-500">({cmd.distance}c)</span>
                      </td>
                      <td className="py-3 px-3 text-slate-300">
                        {UNIT_LABELS[cmd.slowestUnit]?.label || cmd.slowestUnit}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-slate-200">
                        {new Date(cmd.sendTimeMs).toLocaleTimeString('pt-BR')}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums font-bold">
                        {cmd.status === 'sent' ? (
                          <span className="text-emerald-400">Confirmado & Enviado</span>
                        ) : cmd.status === 'dodged' ? (
                          <span className="text-emerald-400">Desviado & Retornando</span>
                        ) : cmd.status === 'dodging' && cmd.autoDodge ? (
                          <CountdownText
                            targetMs={cmd.autoDodge.cancelTimeMs}
                            intervalMs={500}
                            urgentThresholdMs={0}
                            prefix="Cancelar em "
                            formatFn={formatDuration}
                            className="text-sky-300"
                            completedClassName="text-sky-300"
                          />
                        ) : (
                          <CountdownText
                            targetMs={cmd.sendTimeMs}
                            intervalMs={500}
                            urgentThresholdMs={30000}
                            formatFn={formatDuration}
                          />
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${cmd.status === 'sent' || cmd.status === 'dodged'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : cmd.status === 'waking'
                              ? 'bg-amber-500/20 text-amber-300'
                              : cmd.status === 'dodging'
                                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                : cmd.status === 'failed'
                                  ? 'bg-rose-500/15 text-rose-300'
                                  : 'bg-sky-500/15 text-sky-300'
                            }`}
                        >
                          {cmd.status === 'waking'
                            ? 'Confirmando na Praça'
                            : cmd.status === 'dodging'
                              ? 'Em Evasão (Aguard. Cancelar)'
                              : cmd.status === 'dodged'
                                ? 'Desviado'
                                : cmd.status}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right space-x-1.5">
                        {cmd.status === 'dodging' && onCancelDodgeNow ? (
                          <button
                            type="button"
                            onClick={() => onCancelDodgeNow(cmd.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 transition-colors duration-150 hover:bg-sky-400 active:scale-[0.98]"
                            title="Cancelar imediatamente o apoio enviado para devolver as tropas à aldeia"
                          >
                            Cancelar Apoio Agora
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onTriggerNow(cmd.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 transition-colors duration-150 hover:bg-amber-400 active:scale-[0.98]"
                            title="Preencher Praça, avançar para tela de confirmação e enviar ataque/apoio agora"
                          >
                            <Send className="h-3 w-3" />
                            Enviar Agora
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onCancelCommand(cmd.id)}
                          aria-label={`Remover comando de ${cmd.originCoords} para ${cmd.targetCoords}`}
                          className="inline-flex items-center rounded-lg p-1.5 text-slate-400 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.98]"
                          title="Remover comando"
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

      <ConfirmDialog
        open={confirmClearQueueOpen}
        title="Limpar fila do Agendador"
        description={`Deseja remover todos os ${commands.length} comando(s) da fila do Agendador? Esta ação não pode ser desfeita.`}
        confirmLabel="Limpar Todos"
        onCancel={() => setConfirmClearQueueOpen(false)}
        onConfirm={async () => {
          await onClearAll();
          setConfirmClearQueueOpen(false);
        }}
      />
    </div>
  );
};
