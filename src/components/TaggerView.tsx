import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calculator,
  CheckSquare,
  Crosshair,
  ExternalLink,
  Layers,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react';
import type {
  ScheduledCommand,
  SnipAttackGap,
  SnipSupportCandidate,
  TroopCounts,
  TwAccount,
  TwIncomingAttack,
  TwUnitType,
  TwVillage,
} from '../types';
import {
  detectSnipWindowsClient,
  findViableSnipSupportsClient,
} from '../utils/snipEngine';
import { CountdownText } from './ui/CountdownText';

export interface CreateDodgePayload {
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
  troops?: TroopCounts;
  triggerBeforeMs?: number;
  notes?: string;
}

export type CreateBatchCommandPayload = Partial<ScheduledCommand> & {
  timingMode?: 'arrival' | 'send';
  worldSpeed?: number;
  unitSpeed?: number;
};

interface TaggerViewProps {
  accounts: TwAccount[];
  scheduledCommands?: ScheduledCommand[];
  onSyncIncomings: (accountId: string) => Promise<void>;
  onSyncCombinedVillages?: (accountId: string) => Promise<void>;
  onCreateBatchCommands?: (payloads: CreateBatchCommandPayload[]) => Promise<void>;
  onCreateDodge?: (payload: CreateDodgePayload) => Promise<void>;
  onCancelDodgeNow?: (commandId: string) => Promise<void>;
  onOpenIncomingsScreen: (account: TwAccount) => Promise<void>;
}

const OFFENSIVE_EVAC_TROOPS: TroopCounts = {
  axe: 999999,
  light: 999999,
  marcher: 999999,
  ram: 999999,
  catapult: 999999,
  snob: 999999,
};

function findNearestClientVillage(originCoords: string, villages: TwVillage[]): TwVillage | null {
  const mOrigin = /(\d{1,3})\|(\d{1,3})/.exec(originCoords || '');
  if (!mOrigin || villages.length === 0) return null;
  const ox = Number(mOrigin[1]);
  const oy = Number(mOrigin[2]);
  const cleanOrigin = `${ox}|${oy}`;
  let best: TwVillage | null = null;
  let bestDist = Infinity;
  for (const v of villages) {
    const mv = /(\d{1,3})\|(\d{1,3})/.exec(v.coords || '');
    if (!mv) continue;
    const vx = Number(mv[1]);
    const vy = Number(mv[2]);
    if (`${vx}|${vy}` === cleanOrigin) continue;
    const d = Math.hypot(ox - vx, oy - vy);
    if (d > 0 && d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

const UNIT_SPEEDS = [
  { name: 'Explorador (Spy)', minPerField: 9, color: 'text-sky-300 bg-sky-500/15' },
  { name: 'Cavalaria Leve / Arq. Cavalo', minPerField: 10, color: 'text-amber-300 bg-amber-500/15' },
  { name: 'Cavalaria Pesada', minPerField: 11, color: 'text-purple-300 bg-purple-500/15' },
  { name: 'Bárbaro / Lanceiro / Arqueiro', minPerField: 18, color: 'text-orange-300 bg-orange-500/15' },
  { name: 'Espadachim', minPerField: 22, color: 'text-emerald-300 bg-emerald-500/15' },
  { name: 'Aríete / Catapulta', minPerField: 30, color: 'text-rose-300 bg-rose-500/15' },
  { name: 'Nobre (Snob)', minPerField: 35, color: 'text-fuchsia-300 bg-fuchsia-500/20' },
];

const SNIP_SHORT_UNITS: Partial<Record<TwUnitType, string>> = {
  spear: 'Lan',
  sword: 'Esp',
  archer: 'Arq',
  spy: 'Exp',
  light: 'CL',
  marcher: 'AC',
  heavy: 'CP',
  ram: 'Arí',
  catapult: 'Cat',
  knight: 'Pal',
};

const SNIP_ANCHOR_TOGGLES: Array<{ unit: TwUnitType; label: string }> = [
  { unit: 'knight', label: 'Paladino' },
  { unit: 'heavy', label: 'CP' },
  { unit: 'spear', label: 'Lança' },
  { unit: 'archer', label: 'Arqueiro' },
  { unit: 'sword', label: 'Espada' },
  { unit: 'catapult', label: 'Catapulta Âncora' },
];

function formatDurationSec(sec: number): string {
  if (sec <= 0) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatTimeWithMs(tsMs: number): string {
  if (!Number.isFinite(tsMs)) return '--:--:--.---';
  const d = new Date(tsMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function toLocalDatetimeAndMs(tsMs: number): { dt: string; ms: number } {
  const safe = Number.isFinite(tsMs) ? tsMs : Date.now();
  const ms = ((Math.round(safe) % 1000) + 1000) % 1000;
  const d = new Date(safe - ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return { dt: d.toISOString().slice(0, 19), ms };
}

function fromLocalDatetimeAndMs(dtStr: string, msPart: number): number {
  const baseMs = new Date(dtStr).getTime();
  if (!Number.isFinite(baseMs)) return NaN;
  const baseSecMs = Math.floor(baseMs / 1000) * 1000;
  const clampedMs = Math.max(0, Math.min(999, Math.round(msPart || 0)));
  return baseSecMs + clampedMs;
}

function formatTroopSummary(troops: TroopCounts): string {
  return Object.entries(troops)
    .filter(([, qty]) => (Number(qty) || 0) > 0)
    .map(([unit, qty]) => `${SNIP_SHORT_UNITS[unit as TwUnitType] || unit}: ${qty}`)
    .join(' • ');
}

export const TaggerView: React.FC<TaggerViewProps> = ({
  accounts,
  scheduledCommands = [],
  onSyncIncomings,
  onSyncCombinedVillages,
  onCreateBatchCommands,
  onCreateDodge,
  onCancelDodgeNow,
  onOpenIncomingsScreen,
}) => {
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?._id || '');
  const [syncing, setSyncing] = useState(false);
  const mountNowRef = useRef(Date.now());

  // Auto-Dodge Config & Manual Anti-Backtime State
  const [dodgeBeforeSec, setDodgeBeforeSec] = useState(4);
  const [cancelAfterSec, setCancelAfterSec] = useState(2);
  const [dodgeTroopMode, setDodgeTroopMode] = useState<'all' | 'offensive'>('all');
  const [dodgeTargetOverride, setDodgeTargetOverride] = useState('');
  const [manualOriginCoords, setManualOriginCoords] = useState('500|500');
  const [manualImpactInput, setManualImpactInput] = useState(() => {
    const d = new Date(Date.now() + 5 * 60 * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 19);
  });
  const [manualAttackerLabel, setManualAttackerLabel] = useState('Backtime / Ataque Inimigo');
  const [schedulingDodge, setSchedulingDodge] = useState(false);

  // Manual Incoming Tagger Calculator state
  const [calcOrigin, setCalcOrigin] = useState('495|498');
  const [calcTarget, setCalcTarget] = useState('500|500');
  const [calcRemaining, setCalcRemaining] = useState('02:35:00');
  const [worldSpeed, setWorldSpeed] = useState(1);

  // Wave 6: Auto-Snip State
  const [snipTargetCoords, setSnipTargetCoords] = useState('500|500');
  const [snipStartDt, setSnipStartDt] = useState(() => toLocalDatetimeAndMs(Date.now() + 10 * 60 * 1000).dt);
  const [snipStartMs, setSnipStartMs] = useState(100);
  const [snipEndDt, setSnipEndDt] = useState(() => toLocalDatetimeAndMs(Date.now() + 10 * 60 * 1000).dt);
  const [snipEndMs, setSnipEndMs] = useState(350);
  const [snipArrivalDt, setSnipArrivalDt] = useState(
    () => toLocalDatetimeAndMs(Date.now() + 10 * 60 * 1000).dt
  );
  const [snipArrivalMs, setSnipArrivalMs] = useState(225);
  const [snipGroupFilter, setSnipGroupFilter] = useState('ALL');
  const [snipMinLeadSec, setSnipMinLeadSec] = useState(15);
  const [snipMinPop, setSnipMinPop] = useState(10);
  const [snipAllowedUnits, setSnipAllowedUnits] = useState<TwUnitType[]>([
    'knight',
    'heavy',
    'spear',
    'archer',
    'sword',
    'catapult',
  ]);
  const [selectedGapId, setSelectedGapId] = useState<string | null>(null);
  const [selectedSnipIds, setSelectedSnipIds] = useState<Set<string>>(() => new Set());
  const [syncingTroops, setSyncingTroops] = useState(false);
  const [schedulingSnip, setSchedulingSnip] = useState(false);

  const selectedAccount = accounts.find((a) => a._id === selectedAccountId) || accounts[0] || null;
  const allIncomings = useMemo(
    () => accounts.flatMap((a) => a.incomingsList || []),
    [accounts]
  );

  const detectedGaps = useMemo(() => detectSnipWindowsClient(allIncomings), [allIncomings]);

  const snipVillageCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const v of selectedAccount?.villages || []) {
      if (v.localCategory && v.localCategory.trim()) {
        cats.add(v.localCategory.trim());
      }
    }
    return Array.from(cats);
  }, [selectedAccount?.villages]);

  const snipWindowBounds = useMemo(() => {
    const startMs = fromLocalDatetimeAndMs(snipStartDt, snipStartMs);
    const endMs = fromLocalDatetimeAndMs(snipEndDt, snipEndMs);
    const arrivalMs = fromLocalDatetimeAndMs(snipArrivalDt, snipArrivalMs);
    return {
      startMs: Number.isFinite(startMs) ? startMs : mountNowRef.current + 600000,
      endMs: Number.isFinite(endMs) ? endMs : mountNowRef.current + 600250,
      arrivalMs: Number.isFinite(arrivalMs) ? arrivalMs : undefined,
    };
  }, [snipStartDt, snipStartMs, snipEndDt, snipEndMs, snipArrivalDt, snipArrivalMs]);

  const effectiveSnipWorldSpeed = selectedAccount?.worldConfig?.speed ?? worldSpeed;
  const effectiveSnipUnitSpeed = selectedAccount?.worldConfig?.unitSpeed ?? 1;

  const snipCandidates = useMemo(() => {
    if (!selectedAccount || !selectedAccount.villages || selectedAccount.villages.length === 0) {
      return [];
    }
    return findViableSnipSupportsClient({
      accountId: selectedAccount._id,
      accountName: selectedAccount.username,
      targetCoords: snipTargetCoords,
      windowStartMs: snipWindowBounds.startMs,
      windowEndMs: snipWindowBounds.endMs,
      targetArrivalMs: snipWindowBounds.arrivalMs,
      villages: selectedAccount.villages,
      groupFilter: snipGroupFilter,
      minDefensivePop: snipMinPop,
      minLeadTimeMs: snipMinLeadSec * 1000,
      nowMs: Date.now(),
      worldSpeed: effectiveSnipWorldSpeed,
      unitSpeed: effectiveSnipUnitSpeed,
      unitSpeeds: selectedAccount.worldConfig?.unitSpeeds,
      allowedUnits: snipAllowedUnits,
    });
  }, [
    selectedAccount,
    snipTargetCoords,
    snipWindowBounds,
    snipGroupFilter,
    snipMinPop,
    snipMinLeadSec,
    effectiveSnipWorldSpeed,
    effectiveSnipUnitSpeed,
    snipAllowedUnits,
  ]);

  const handleLoadGapIntoSnip = (gap: SnipAttackGap) => {
    setSelectedAccountId(gap.accountId);
    setSelectedGapId(gap.id);
    setSnipTargetCoords(gap.targetCoords);
    const st = toLocalDatetimeAndMs(gap.windowStartMs);
    const en = toLocalDatetimeAndMs(gap.windowEndMs);
    const rec = toLocalDatetimeAndMs(gap.recommendedArrivalMs);
    setSnipStartDt(st.dt);
    setSnipStartMs(st.ms);
    setSnipEndDt(en.dt);
    setSnipEndMs(en.ms);
    setSnipArrivalDt(rec.dt);
    setSnipArrivalMs(rec.ms);
    setSelectedSnipIds(new Set());
  };

  const handleCenterSnipArrival = () => {
    const mid = Math.round((snipWindowBounds.startMs + snipWindowBounds.endMs) / 2);
    const parsed = toLocalDatetimeAndMs(mid);
    setSnipArrivalDt(parsed.dt);
    setSnipArrivalMs(parsed.ms);
  };

  const toggleSnipAnchorUnit = (unit: TwUnitType) => {
    setSnipAllowedUnits((prev) =>
      prev.includes(unit)
        ? prev.length > 1
          ? prev.filter((u) => u !== unit)
          : prev
        : [...prev, unit]
    );
  };

  const toggleSnipCandidateSelection = (id: string) => {
    setSelectedSnipIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllSnipCandidates = () => {
    if (snipCandidates.length === 0) return;
    if (selectedSnipIds.size === snipCandidates.length) {
      setSelectedSnipIds(new Set());
    } else {
      setSelectedSnipIds(new Set(snipCandidates.map((c) => c.id)));
    }
  };

  const handleSyncCombinedTroops = async () => {
    if (!selectedAccount || !onSyncCombinedVillages) return;
    setSyncingTroops(true);
    try {
      await onSyncCombinedVillages(selectedAccount._id);
    } finally {
      setSyncingTroops(false);
    }
  };

  const enqueueSnipCandidates = async (items: SnipSupportCandidate[]) => {
    if (!selectedAccount || !onCreateBatchCommands || items.length === 0) return;
    setSchedulingSnip(true);
    try {
      const payloads: CreateBatchCommandPayload[] = items.map((cand) => ({
        accountId: selectedAccount._id,
        accountName: selectedAccount.username,
        originVillageId: cand.originVillageId,
        originCoords: cand.originCoords,
        targetCoords: cand.targetCoords,
        commandType: 'support',
        presetName: `Auto-Snip (${cand.unitLabel})`,
        slowestUnit: cand.slowestUnit,
        troops: cand.suggestedTroops,
        waves: 1,
        timingMode: 'arrival',
        arrivalTimeMs: cand.arrivalTimeMs,
        triggerBeforeMs: 30000,
        worldSpeed: effectiveSnipWorldSpeed,
        unitSpeed: effectiveSnipUnitSpeed,
        notes: `Auto-Snip [${cand.unitLabel}] -> ${cand.targetCoords} @ ${formatTimeWithMs(cand.arrivalTimeMs)}`,
      }));
      await onCreateBatchCommands(payloads);
      setSelectedSnipIds(new Set());
    } finally {
      setSchedulingSnip(false);
    }
  };

  useEffect(() => {
    if (selectedAccount?.villages && selectedAccount.villages.length > 0) {
      const exists = selectedAccount.villages.some((v) => v.coords === manualOriginCoords);
      if (!exists) {
        setManualOriginCoords(selectedAccount.villages[0].coords);
      }
    }
  }, [selectedAccount?._id, selectedAccount?.villages]);

  const dodgeCommands = useMemo(
    () => scheduledCommands.filter((c) => c.autoDodge?.enabled),
    [scheduledCommands]
  );

  const findExistingDodgeForIncoming = (inc: TwIncomingAttack): ScheduledCommand | undefined => {
    return dodgeCommands.find(
      (c) =>
        c.accountId === inc.accountId &&
        (c.autoDodge?.incomingCommandId === inc.commandId ||
          (c.originCoords === inc.targetCoords &&
            Math.abs((c.autoDodge?.enemyArrivalTimeMs || 0) - inc.arrivalTimeMs) <= 5000))
    );
  };

  const resolveEvasionTarget = (accountId: string, attackedCoords: string) => {
    const cleanOverride = dodgeTargetOverride.trim();
    if (/^\d{1,3}\|\d{1,3}$/.test(cleanOverride)) {
      return { coords: cleanOverride, label: `Manual (${cleanOverride})` };
    }
    const acc = accounts.find((a) => a._id === accountId);
    const nearest = findNearestClientVillage(attackedCoords, acc?.villages || []);
    if (nearest) {
      return { coords: nearest.coords, label: `${nearest.name} (${nearest.coords})` };
    }
    const m = /(\d{1,3})\|(\d{1,3})/.exec(attackedCoords);
    const fallback = m ? `${Math.min(999, Number(m[1]) + 1)}|${m[2]}` : '501|500';
    return { coords: fallback, label: `Adjacente (${fallback})` };
  };

  const triggerDodgeForIncoming = async (inc: TwIncomingAttack) => {
    if (!onCreateDodge) return;
    const acc = accounts.find((a) => a._id === inc.accountId);
    const originVillage = (acc?.villages || []).find((v) => v.coords === inc.targetCoords);
    const cleanOverride = dodgeTargetOverride.trim();
    const targetOverride = /^\d{1,3}\|\d{1,3}$/.test(cleanOverride) ? cleanOverride : undefined;
    await onCreateDodge({
      accountId: inc.accountId,
      accountName: inc.accountName,
      originVillageId: originVillage?.id,
      originCoords: inc.targetCoords,
      targetCoords: targetOverride,
      incomingCommandId: inc.commandId,
      attackerName: inc.attackerName,
      enemyArrivalTimeMs: inc.arrivalTimeMs,
      dodgeBeforeSec,
      cancelAfterSec,
      sendAllTroops: dodgeTroopMode === 'all',
      troops: dodgeTroopMode === 'offensive' ? OFFENSIVE_EVAC_TROOPS : {},
      notes: `Auto-Dodge vs ${inc.attackerName} (${inc.originCoords})`,
    });
  };

  const handleScheduleAllIncomings = async () => {
    if (!onCreateDodge || allIncomings.length === 0) return;
    setSchedulingDodge(true);
    try {
      for (const inc of allIncomings) {
        if (!findExistingDodgeForIncoming(inc)) {
          await triggerDodgeForIncoming(inc);
        }
      }
    } finally {
      setSchedulingDodge(false);
    }
  };

  const handleScheduleManualDodge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onCreateDodge || !selectedAccount) return;
    const impactMs = new Date(manualImpactInput).getTime();
    if (!Number.isFinite(impactMs)) return;
    const originVillage = (selectedAccount.villages || []).find(
      (v) => v.coords === manualOriginCoords
    );
    const cleanOverride = dodgeTargetOverride.trim();
    const targetOverride = /^\d{1,3}\|\d{1,3}$/.test(cleanOverride) ? cleanOverride : undefined;

    setSchedulingDodge(true);
    try {
      await onCreateDodge({
        accountId: selectedAccount._id,
        accountName: selectedAccount.username,
        originVillageId: originVillage?.id,
        originCoords: manualOriginCoords,
        targetCoords: targetOverride,
        attackerName: manualAttackerLabel.trim() || 'Manual',
        enemyArrivalTimeMs: impactMs,
        dodgeBeforeSec,
        cancelAfterSec,
        sendAllTroops: dodgeTroopMode === 'all',
        troops: dodgeTroopMode === 'offensive' ? OFFENSIVE_EVAC_TROOPS : {},
        notes: manualAttackerLabel.trim() || 'Auto-Dodge Manual',
      });
    } finally {
      setSchedulingDodge(false);
    }
  };

  const manualAnalysis = useMemo(() => {
    const m1 = /(\d{1,3})\|(\d{1,3})/.exec(calcOrigin);
    const m2 = /(\d{1,3})\|(\d{1,3})/.exec(calcTarget);
    if (!m1 || !m2) return null;
    const dist = Math.hypot(Number(m1[1]) - Number(m2[1]), Number(m1[2]) - Number(m2[2]));
    const parts = calcRemaining.split(':').map(Number);
    const remSec =
      parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0;

    const candidates = UNIT_SPEEDS.map((u) => {
      const fullSec = Math.round(((dist * u.minPerField) / Math.max(0.1, worldSpeed)) * 60);
      return {
        ...u,
        fullSec,
        possible: remSec <= fullSec + 30,
      };
    });

    const probable =
      candidates.find((c) => c.possible && remSec >= c.fullSec * 0.72) ||
      candidates.filter((c) => c.possible)[0] ||
      candidates[candidates.length - 1];

    return { dist: dist.toFixed(2), remSec, candidates, probable };
  }, [calcOrigin, calcTarget, calcRemaining, worldSpeed]);

  const handleSync = async () => {
    if (!selectedAccount) return;
    setSyncing(true);
    try {
      await onSyncIncomings(selectedAccount._id);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-[#141923] p-5">
        <div className="flex items-center gap-3">
          <ShieldAlert className="h-5 w-5 text-rose-400" />
          <div>
            <h2 className="text-sm font-bold text-slate-100">
              Monitor de Ataques a Chegar & Classificador (Tagger)
            </h2>
            <p className="text-xs text-slate-400">
              Lê os ataques recebidos da sessão ativa e identifica automaticamente se o ataque é Nobre, Aríete, Bárbaro ou Spy pela velocidade.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <select
            value={selectedAccount?._id || ''}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="rounded-xl border border-slate-700 bg-[#0f1218] px-3.5 py-2 text-xs text-slate-100"
          >
            {accounts.map((acc) => (
              <option key={acc._id} value={acc._id}>
                {acc.username} ({acc.world.toUpperCase()})
              </option>
            ))}
          </select>

          <button
            onClick={handleSync}
            disabled={!selectedAccount || syncing}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Lendo ataques...' : 'Sincronizar Ataques'}
          </button>

          {selectedAccount && (
            <button
              onClick={() => onOpenIncomingsScreen(selectedAccount)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0f1218] px-3.5 py-2 text-xs text-slate-200 hover:bg-slate-800"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir no Jogo
            </button>
          )}
        </div>
      </div>

      {/* Interactive Tagger Speed Classifier */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
            <Calculator className="h-4 w-4" />
            Simulador de Etiquetagem por Tempo Restante (Tagger)
          </div>
          {manualAnalysis && (
            <span className="text-xs text-slate-300">
              Unidade Mais Provável:{' '}
              <strong className="rounded-md bg-amber-500/20 px-2 py-0.5 text-amber-300">
                {manualAnalysis.probable.name}
              </strong>
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Aldeia Atacante (X|Y)</label>
            <input
              type="text"
              value={calcOrigin}
              onChange={(e) => setCalcOrigin(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Sua Aldeia Alvo (X|Y)</label>
            <input
              type="text"
              value={calcTarget}
              onChange={(e) => setCalcTarget(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Tempo Restante (HH:MM:SS)
            </label>
            <input
              type="text"
              value={calcRemaining}
              onChange={(e) => setCalcRemaining(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Velocidade Efetiva</label>
            <input
              type="number"
              step="0.1"
              min={0.5}
              value={worldSpeed}
              onChange={(e) => setWorldSpeed(Number(e.target.value) || 1)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
          </div>
        </div>

        {manualAnalysis && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
            {manualAnalysis.candidates.map((c) => (
              <div
                key={c.name}
                className={`rounded-xl border p-2.5 text-xs ${
                  c.possible
                    ? 'border-slate-700 bg-[#0f1218]'
                    : 'border-slate-800/50 bg-[#0f1218]/40 opacity-40'
                }`}
              >
                <div className="font-semibold text-slate-200 truncate">{c.name}</div>
                <div className="font-mono text-[11px] text-amber-400 mt-1">
                  {formatDurationSec(c.fullSec)}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {c.possible ? 'Possível' : 'Já passou'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Wave 5: Auto-Dodge Configuration & Anti-Backtime Manual Scheduler */}
      <div className="rounded-2xl border border-sky-500/30 bg-[#141923] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-sky-400" />
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Desviador de Ataques (Auto-Dodge / Anti-Backtime via Apoio + Cancelamento)
              </h2>
              <p className="text-[11px] text-slate-400">
                Retira as tropas instantes antes do impacto enviando apoio para a aldeia própria mais próxima e cancela o comando logo após o ataque passar.
              </p>
            </div>
          </div>

          {onCreateDodge && allIncomings.length > 0 && (
            <button
              type="button"
              disabled={schedulingDodge}
              onClick={handleScheduleAllIncomings}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40"
            >
              <Zap className="h-3.5 w-3.5" />
              Agendar Auto-Dodge para Todos ({allIncomings.length})
            </button>
          )}
        </div>

        {/* Dodge Timing & Troop Selection Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Retirar Antes do Impacto (seg)
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={dodgeBeforeSec}
              onChange={(e) => setDodgeBeforeSec(Math.max(1, Math.min(60, Number(e.target.value) || 4)))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Cancelar Apoio Após Impacto (seg)
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={cancelAfterSec}
              onChange={(e) => setCancelAfterSec(Math.max(1, Math.min(60, Number(e.target.value) || 2)))}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Tropas a Retirar
            </label>
            <select
              value={dodgeTroopMode}
              onChange={(e) => setDodgeTroopMode(e.target.value as 'all' | 'offensive')}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="all">Todas as Tropas da Aldeia (100% Estoque)</option>
              <option value="offensive">Apenas Tropas Ofensivas (Bár, CL, AC, Arí, Cat, Nob)</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Destino do Apoio (Opcional)
            </label>
            <input
              type="text"
              value={dodgeTargetOverride}
              onChange={(e) => setDodgeTargetOverride(e.target.value)}
              placeholder="Automático (Aldeia Própria Mais Próxima)"
              className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
            />
          </div>
        </div>

        {/* Manual Anti-Backtime Dodge Form */}
        {onCreateDodge && (
          <form
            onSubmit={handleScheduleManualDodge}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end rounded-xl border border-slate-800 bg-[#0f1218]/70 p-3.5"
          >
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Aldeia Atacada (Origem da Evasão)
              </label>
              {selectedAccount?.villages && selectedAccount.villages.length > 0 ? (
                <select
                  value={manualOriginCoords}
                  onChange={(e) => setManualOriginCoords(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  {selectedAccount.villages.map((v) => (
                    <option key={v.id} value={v.coords}>
                      {v.name} ({v.coords})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required
                  value={manualOriginCoords}
                  onChange={(e) => setManualOriginCoords(e.target.value)}
                  placeholder="500|500"
                  className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
                />
              )}
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Horário do Impacto Inimigo *
              </label>
              <input
                type="datetime-local"
                step="1"
                required
                value={manualImpactInput}
                onChange={(e) => setManualImpactInput(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Etiqueta / Atacante
              </label>
              <input
                type="text"
                value={manualAttackerLabel}
                onChange={(e) => setManualAttackerLabel(e.target.value)}
                placeholder="Backtime / Ataque Inimigo"
                className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
              />
            </div>
            <button
              type="submit"
              disabled={!selectedAccount || schedulingDodge}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/50 bg-sky-500/15 px-3.5 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Agendar Auto-Dodge Manual
            </button>
          </form>
        )}

        {/* Active / Recent Auto-Dodge Commands Strip */}
        {dodgeCommands.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">
              Evasões Agendadas & Em Execução ({dodgeCommands.length})
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {dodgeCommands.map((dc) => (
                <div
                  key={dc.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#0f1218] px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-100">
                      <span className="font-mono text-amber-300">{dc.originCoords}</span> →{' '}
                      <span className="font-mono text-sky-300">{dc.targetCoords}</span>{' '}
                      <span className="text-[10px] text-slate-400">({dc.accountName})</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      Retirar: {new Date(dc.sendTimeMs).toLocaleTimeString('pt-BR')} • Cancelar:{' '}
                      {dc.autoDodge?.cancelTimeMs
                        ? new Date(dc.autoDodge.cancelTimeMs).toLocaleTimeString('pt-BR')
                        : '—'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                        dc.status === 'dodged'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : dc.status === 'dodging'
                            ? 'bg-sky-500/20 text-sky-300'
                            : dc.status === 'failed'
                              ? 'bg-rose-500/15 text-rose-300'
                              : 'bg-amber-500/15 text-amber-300'
                      }`}
                    >
                      {dc.status === 'dodging' && dc.autoDodge ? (
                        <CountdownText
                          targetMs={dc.autoDodge.cancelTimeMs}
                          intervalMs={1000}
                          urgentThresholdMs={0}
                          prefix="Cancelar em "
                          formatFn={(ms) => `${Math.ceil(ms / 1000)}s`}
                          completedText="0s"
                          className="text-sky-300"
                          completedClassName="text-sky-300"
                        />
                      ) : dc.status === 'dodged' ? (
                        'Desviado'
                      ) : dc.status === 'failed' ? (
                        'Falhou'
                      ) : (
                        'Agendado'
                      )}
                    </span>
                    {dc.status === 'dodging' && onCancelDodgeNow && (
                      <button
                        type="button"
                        onClick={() => onCancelDodgeNow(dc.id)}
                        className="rounded-lg bg-sky-500 px-2 py-1 text-[10px] font-semibold text-slate-950 hover:bg-sky-400"
                      >
                        Cancelar Agora
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Wave 6: Auto-Defesa (Auto-Snip por Apoio entre Comandos Inimigos) */}
      <div className="rounded-2xl border border-emerald-500/30 bg-[#141923] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <Crosshair className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Auto-Defesa (Auto-Snip Cirúrgico por Apoio entre Ataques Inimigos)
              </h2>
              <p className="text-[11px] text-slate-400">
                Detecta frestas em milissegundos entre limpeza e nobres, varre aldeias/grupos defensivos compatíveis e agenda apoios exatos no Scheduler.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onSyncCombinedVillages && selectedAccount && (
              <button
                type="button"
                disabled={syncingTroops}
                onClick={handleSyncCombinedTroops}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
              >
                <Layers className={`h-3.5 w-3.5 ${syncingTroops ? 'animate-spin' : ''}`} />
                {syncingTroops ? 'Sincronizando Tropas...' : 'Sincronizar Tropas (Visão Combinada)'}
              </button>
            )}
            {onCreateBatchCommands && selectedSnipIds.size > 0 && (
              <button
                type="button"
                disabled={schedulingSnip}
                onClick={() =>
                  enqueueSnipCandidates(snipCandidates.filter((c) => selectedSnipIds.has(c.id)))
                }
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                <CheckSquare className="h-3.5 w-3.5" />
                Enfileirar Snips Selecionados ({selectedSnipIds.size})
              </button>
            )}
          </div>
        </div>

        {/* Phase 21: Detected Snip Gaps */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Janelas / Frestas de Snip Detectadas ({detectedGaps.length})
            </span>
            {selectedAccount?.worldConfig && (
              <span className="text-[10px] font-normal normal-case text-slate-400">
                Mundo: Vel. {effectiveSnipWorldSpeed}x • Unid. {effectiveSnipUnitSpeed}x
              </span>
            )}
          </div>

          {detectedGaps.length === 0 ? (
            <div className="rounded-xl border border-slate-800/80 bg-[#0f1218]/60 px-3.5 py-2.5 text-xs text-slate-400">
              Nenhuma fresta consecutiva (&le; 60s) detectada automaticamente entre ataques na mesma aldeia. Você pode configurar uma janela manual abaixo.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
              {detectedGaps.map((gap) => {
                const isLoaded = selectedGapId === gap.id;
                const priorityBadge =
                  gap.priority === 'critical_noble'
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                    : gap.priority === 'noble_train'
                      ? 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40'
                      : gap.priority === 'tight_gap'
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-slate-700/40 text-slate-300 border-slate-600/40';
                const priorityLabel =
                  gap.priority === 'critical_noble'
                    ? 'CRÍTICO: LIMPEZA → NOBRE'
                    : gap.priority === 'noble_train'
                      ? 'NOBLE TRAIN'
                      : gap.priority === 'tight_gap'
                        ? 'GAP CURTO'
                        : 'JANELA PADRÃO';

                return (
                  <div
                    key={gap.id}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-xs transition ${
                      isLoaded
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-slate-800 bg-[#0f1218]'
                    }`}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${priorityBadge}`}
                        >
                          {priorityLabel}
                        </span>
                        <span className="font-mono font-semibold text-amber-300">
                          {gap.targetCoords}
                        </span>
                        <span className="text-[11px] text-slate-400 truncate">
                          ({gap.accountName}) • Gap: <strong className="text-emerald-300">{gap.gapMs} ms</strong>
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-300 font-mono">
                        {gap.firstAttackUnit} ({formatTimeWithMs(gap.firstAttackArrivalMs)}) →{' '}
                        {gap.secondAttackUnit} ({formatTimeWithMs(gap.secondAttackArrivalMs)})
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Janela útil:{' '}
                        <span className="font-mono text-emerald-300">
                          {formatTimeWithMs(gap.windowStartMs)} – {formatTimeWithMs(gap.windowEndMs)}
                        </span>{' '}
                        • Alvo ideal: <span className="font-mono text-slate-200">{formatTimeWithMs(gap.recommendedArrivalMs)}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleLoadGapIntoSnip(gap)}
                      className="shrink-0 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25"
                    >
                      {isLoaded ? 'Carregada' : 'Carregar Janela de Snip'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Phase 22 & 23: Snip Window Configurator & Filters */}
        <div className="rounded-xl border border-slate-800 bg-[#0f1218]/70 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Aldeia Alvo Sob Ataque (X|Y)
              </label>
              <input
                type="text"
                value={snipTargetCoords}
                onChange={(e) => {
                  setSelectedGapId(null);
                  setSnipTargetCoords(e.target.value);
                }}
                placeholder="500|500"
                className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
              />
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Início da Janela (Data/Hora + ms)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="datetime-local"
                  step="1"
                  value={snipStartDt}
                  onChange={(e) => setSnipStartDt(e.target.value)}
                  className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
                />
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={snipStartMs}
                  onChange={(e) =>
                    setSnipStartMs(Math.max(0, Math.min(999, Number(e.target.value) || 0)))
                  }
                  title="Milissegundos iniciais"
                  className="w-16 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 font-mono text-xs text-emerald-300"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Fim da Janela (Data/Hora + ms)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="datetime-local"
                  step="1"
                  value={snipEndDt}
                  onChange={(e) => setSnipEndDt(e.target.value)}
                  className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
                />
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={snipEndMs}
                  onChange={(e) =>
                    setSnipEndMs(Math.max(0, Math.min(999, Number(e.target.value) || 0)))
                  }
                  title="Milissegundos finais"
                  className="w-16 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 font-mono text-xs text-emerald-300"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-slate-400">Chegada Exata (.mmm)</label>
                <button
                  type="button"
                  onClick={handleCenterSnipArrival}
                  className="text-[10px] text-emerald-400 hover:underline"
                >
                  Centralizar
                </button>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="datetime-local"
                  step="1"
                  value={snipArrivalDt}
                  onChange={(e) => setSnipArrivalDt(e.target.value)}
                  className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-[#0f1218] px-2 py-1.5 text-xs text-slate-100"
                />
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={snipArrivalMs}
                  onChange={(e) =>
                    setSnipArrivalMs(Math.max(0, Math.min(999, Number(e.target.value) || 0)))
                  }
                  title="Milissegundo alvo de chegada do apoio"
                  className="w-16 rounded-lg border border-emerald-500/50 bg-[#0f1218] px-2 py-1.5 font-mono text-xs text-emerald-300"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Grupo / Categoria de Aldeias
                </label>
                <select
                  value={snipGroupFilter}
                  onChange={(e) => setSnipGroupFilter(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="ALL">Todas as Aldeias ({selectedAccount?.villages?.length || 0})</option>
                  {snipVillageCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Antecedência Mín. (seg)
                </label>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={snipMinLeadSec}
                  onChange={(e) => setSnipMinLeadSec(Math.max(1, Number(e.target.value) || 15))}
                  className="w-24 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Pop. Def. Mínima</label>
                <input
                  type="number"
                  min={0}
                  value={snipMinPop}
                  onChange={(e) => setSnipMinPop(Math.max(0, Number(e.target.value) || 0))}
                  className="w-24 rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 mr-1">Unidades Âncora:</span>
              {SNIP_ANCHOR_TOGGLES.map((item) => {
                const active = snipAllowedUnits.includes(item.unit);
                return (
                  <button
                    key={item.unit}
                    type="button"
                    onClick={() => toggleSnipAnchorUnit(item.unit)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                      active
                        ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200'
                        : 'border-slate-700 bg-[#0f1218] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Viable Snip Candidates Table */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">
              Apoios Viáveis para Encaixe ({snipCandidates.length})
            </span>
            {snipCandidates.length > 0 && (
              <button
                type="button"
                onClick={toggleSelectAllSnipCandidates}
                className="text-[11px] text-emerald-400 hover:underline"
              >
                {selectedSnipIds.size === snipCandidates.length
                  ? 'Desmarcar Todos'
                  : `Selecionar Todos (${snipCandidates.length})`}
              </button>
            )}
          </div>

          {!selectedAccount || !selectedAccount.villages || selectedAccount.villages.length === 0 ? (
            <p className="rounded-xl border border-slate-800/80 bg-[#0f1218]/60 py-4 text-center text-xs text-slate-400">
              Sincronize as aldeias da conta selecionada (ou clique em "Sincronizar Tropas") para calcular apoios de snip.
            </p>
          ) : snipCandidates.length === 0 ? (
            <p className="rounded-xl border border-slate-800/80 bg-[#0f1218]/60 py-4 text-center text-xs text-slate-400">
              Nenhuma combinação de aldeia/unidade consegue chegar na janela configurada com antecedência mínima de {snipMinLeadSec}s. Tente habilitar a Catapulta Âncora ou ajustar o horário.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0f1218]">
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 px-3 w-8">
                      <input
                        type="checkbox"
                        checked={
                          snipCandidates.length > 0 &&
                          selectedSnipIds.size === snipCandidates.length
                        }
                        onChange={toggleSelectAllSnipCandidates}
                        className="rounded border-slate-600 bg-[#0f1218]"
                      />
                    </th>
                    <th className="py-2 px-3">Aldeia de Apoio</th>
                    <th className="py-2 px-3">Dist.</th>
                    <th className="py-2 px-3">Âncora</th>
                    <th className="py-2 px-3">Tropas Compatíveis</th>
                    <th className="py-2 px-3">Viagem</th>
                    <th className="py-2 px-3">Horário de Envio</th>
                    <th className="py-2 px-3">Disparo em</th>
                    <th className="py-2 px-3 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {snipCandidates.map((cand) => {
                    const checked = selectedSnipIds.has(cand.id);
                    return (
                      <tr
                        key={cand.id}
                        className={checked ? 'bg-emerald-500/10' : 'hover:bg-slate-900/40'}
                      >
                        <td className="py-2.5 px-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSnipCandidateSelection(cand.id)}
                            className="rounded border-slate-600 bg-[#0f1218]"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-slate-100">
                            {cand.originVillageName}{' '}
                            <span className="font-mono text-amber-300">({cand.originCoords})</span>
                          </div>
                          {cand.originGroup && (
                            <span className="text-[10px] text-slate-400">{cand.originGroup}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-slate-300">{cand.distance}</td>
                        <td className="py-2.5 px-3">
                          <span className="rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                            {cand.unitLabel}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-[11px] text-slate-300">
                          <div>{formatTroopSummary(cand.suggestedTroops)}</div>
                          <div className="text-[10px] text-slate-500">
                            {cand.totalDefensivePop} pop.
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-400">
                          {formatDurationSec(Math.round(cand.travelTimeMs / 1000))}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold text-emerald-300">
                          {formatTimeWithMs(cand.sendTimeMs)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-amber-300">
                          <CountdownText
                            targetMs={cand.sendTimeMs}
                            intervalMs={1000}
                            urgentThresholdMs={30000}
                            formatFn={(ms) => formatDurationSec(Math.floor(ms / 1000))}
                            completedText="00:00:00"
                            className="text-amber-300"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {onCreateBatchCommands && (
                            <button
                              type="button"
                              disabled={schedulingSnip}
                              onClick={() => enqueueSnipCandidates([cand])}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
                            >
                              <Crosshair className="h-3 w-3" />
                              Agendar Snip
                            </button>
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
      </div>

      {/* Live Incomings List */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5">
        <h3 className="text-sm font-semibold text-slate-100 mb-3">
          Ataques a Chegar Detectados ({allIncomings.length})
        </h3>
        {allIncomings.length === 0 ? (
          <p className="text-xs text-slate-400 py-6 text-center">
            Nenhum ataque a chegar sincronizado no momento.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 px-3">Conta</th>
                  <th className="py-2.5 px-3">Atacante</th>
                  <th className="py-2.5 px-3">Origem → Alvo</th>
                  <th className="py-2.5 px-3">Distância</th>
                  <th className="py-2.5 px-3">Tempo Restante</th>
                  <th className="py-2.5 px-3">Unidade Detectada</th>
                  <th className="py-2.5 px-3">Destino Evasão</th>
                  <th className="py-2.5 px-3 text-right">Auto-Dodge</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {allIncomings.map((inc) => {
                  const evasionTarget = resolveEvasionTarget(inc.accountId, inc.targetCoords);
                  const existingDodge = findExistingDodgeForIncoming(inc);
                  return (
                    <tr key={inc.id} className="hover:bg-slate-900/40">
                      <td className="py-3 px-3 font-semibold text-slate-100">{inc.accountName}</td>
                      <td className="py-3 px-3 text-slate-300">{inc.attackerName}</td>
                      <td className="py-3 px-3 font-mono text-slate-200">
                        {inc.originCoords} → {inc.targetCoords}
                      </td>
                      <td className="py-3 px-3 text-slate-400">{inc.distance} campos</td>
                      <td className="py-3 px-3 font-mono font-semibold text-rose-400">
                        <div>{formatDurationSec(inc.remainingSec)}</div>
                        <div className="text-[10px] font-normal text-slate-400">
                          Chegada: {formatTimeWithMs(inc.arrivalTimeMs)}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <span className="rounded-md bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                          {inc.detectedUnit}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-slate-300 font-mono text-[11px]">
                        {evasionTarget.label}
                      </td>
                      <td className="py-3 px-3 text-right">
                        {existingDodge ? (
                          <div className="inline-flex items-center gap-1.5">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                                existingDodge.status === 'dodged'
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : existingDodge.status === 'dodging'
                                    ? 'bg-sky-500/20 text-sky-300'
                                    : existingDodge.status === 'failed'
                                      ? 'bg-rose-500/15 text-rose-300'
                                      : 'bg-amber-500/15 text-amber-300'
                              }`}
                            >
                              {existingDodge.status === 'dodging' && existingDodge.autoDodge ? (
                                <CountdownText
                                  targetMs={existingDodge.autoDodge.cancelTimeMs}
                                  intervalMs={1000}
                                  urgentThresholdMs={0}
                                  prefix="Em Evasão ("
                                  formatFn={(ms) => `${Math.ceil(ms / 1000)}s)`}
                                  completedText="0s)"
                                  className="text-sky-300"
                                  completedClassName="text-sky-300"
                                />
                              ) : existingDodge.status === 'dodged' ? (
                                'Desviado'
                              ) : existingDodge.status === 'waking' ? (
                                'Preparando...'
                              ) : existingDodge.status === 'failed' ? (
                                'Falhou'
                              ) : (
                                'Dodge Agendado'
                              )}
                            </span>
                            {existingDodge.status === 'dodging' && onCancelDodgeNow && (
                              <button
                                type="button"
                                onClick={() => onCancelDodgeNow(existingDodge.id)}
                                className="rounded-lg bg-sky-500 px-2 py-1 text-[10px] font-semibold text-slate-950 hover:bg-sky-400"
                              >
                                Cancelar Agora
                              </button>
                            )}
                          </div>
                        ) : (
                          onCreateDodge && (
                            <button
                              type="button"
                              onClick={() => triggerDodgeForIncoming(inc)}
                              className="inline-flex items-center gap-1 rounded-lg border border-sky-500/50 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Desviar Tropas
                            </button>
                          )
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
    </div>
  );
};
