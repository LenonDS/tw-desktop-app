import { AttackPlanItem, TroopCounts, TwUnitType, TwVillage } from '../types';

export interface PlannerTarget {
  coords: string;
  villageName?: string;
  playerName?: string;
}

export const UNIT_LABELS: Record<TwUnitType, { label: string; speed: number }> = {
  spear: { label: 'Lanceiro', speed: 18 },
  sword: { label: 'Espadachim', speed: 22 },
  axe: { label: 'Bárbaro', speed: 18 },
  archer: { label: 'Arqueiro', speed: 18 },
  spy: { label: 'Explorador', speed: 9 },
  light: { label: 'Cav. Leve', speed: 10 },
  marcher: { label: 'Arq. a Cavalo', speed: 10 },
  heavy: { label: 'Cav. Pesada', speed: 11 },
  ram: { label: 'Aríete', speed: 30 },
  catapult: { label: 'Catapulta', speed: 30 },
  knight: { label: 'Paladino', speed: 10 },
  snob: { label: 'Nobre (Snob)', speed: 35 },
};

export function detectSlowestUnitClient(
  troops: TroopCounts | undefined,
  fallback: TwUnitType
): TwUnitType {
  if (!troops) return fallback;
  let slowest: TwUnitType | null = null;
  let maxSpeed = -1;
  for (const [u, qty] of Object.entries(troops)) {
    if ((Number(qty) || 0) <= 0) continue;
    const unit = u as TwUnitType;
    const sp = UNIT_LABELS[unit]?.speed ?? 0;
    if (sp > maxSpeed) {
      maxSpeed = sp;
      slowest = unit;
    }
  }
  return slowest || fallback;
}

export function parseCoordsPair(coords: string): { x: number; y: number } | null {
  const m = /(\d{1,3})\|(\d{1,3})/.exec(coords.trim());
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Builds a single manually configured attack item for the operation list.
 * Supports both 'arrival' (calculate sendTimeMs from targetTimeMs) and
 * 'send' (calculate arrivalTimeMs from targetTimeMs).
 */
export function buildManualAttackPlanItem(params: {
  id?: string;
  origin: TwVillage;
  target: PlannerTarget;
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves: number;
  allWavesTroops?: TroopCounts[];
  timingMode: 'arrival' | 'send';
  targetTimeMs: number;
  getMinPerField: (unit: TwUnitType) => number;
  notes?: string;
}): AttackPlanItem | null {
  const parsedTarget = parseCoordsPair(params.target.coords);
  if (!parsedTarget || !Number.isFinite(params.targetTimeMs)) {
    return null;
  }

  const normalizedTargetCoords = `${parsedTarget.x}|${parsedTarget.y}`;
  if (params.origin.coords === normalizedTargetCoords) {
    return null;
  }

  const resolvedSlowest = detectSlowestUnitClient(params.troops, params.slowestUnit);
  const minPerField = params.getMinPerField(resolvedSlowest);
  const totalWaves = Math.max(1, Math.min(5, params.waves || 1));

  const distance = Math.hypot(params.origin.x - parsedTarget.x, params.origin.y - parsedTarget.y);
  const travelTimeMs = Math.round(distance * minPerField * 60 * 1000);

  const sendTimeMs =
    params.timingMode === 'send'
      ? params.targetTimeMs
      : params.targetTimeMs - travelTimeMs;
  const arrivalTimeMs =
    params.timingMode === 'send'
      ? params.targetTimeMs + travelTimeMs
      : params.targetTimeMs;

  const wavesArr =
    params.allWavesTroops && params.allWavesTroops.length > 0
      ? params.allWavesTroops.slice(0, totalWaves).map((w) => ({ ...w }))
      : Array.from({ length: totalWaves }, () => ({ ...(params.troops || {}) }));

  const id =
    params.id ||
    `${params.origin.id || params.origin.coords}-${normalizedTargetCoords}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

  return {
    id,
    originVillageId: params.origin.id,
    originVillageName: params.origin.name,
    originCoords: params.origin.coords,
    targetCoords: normalizedTargetCoords,
    targetVillageName: params.target.villageName,
    targetPlayerName: params.target.playerName,
    commandType: params.commandType,
    presetName: params.presetName,
    slowestUnit: resolvedSlowest,
    troops: { ...(wavesArr[0] || params.troops || {}) },
    waves: totalWaves,
    allWavesTroops: wavesArr,
    distance: Number(distance.toFixed(2)),
    travelTimeMs,
    sendTimeMs,
    arrivalTimeMs,
    timingMode: params.timingMode,
    notes: params.notes,
  };
}

/**
 * Applies optional synchronized arrival or synchronized send timing to the
 * operation attack list (all items or only selected IDs), preserving anti-collision
 * staggering (>= 200ms) for commands sharing the same origin village.
 */
export function applySyncTimingToPlanItems(
  items: AttackPlanItem[],
  syncMode: 'arrival' | 'send',
  syncTimeMs: number,
  selectedIds?: Set<string>
): AttackPlanItem[] {
  if (!Number.isFinite(syncTimeMs)) return items;

  const usedSendTimes = new Map<string, number[]>();
  return items.map((item) => {
    const originKey = item.originVillageId || item.originCoords;
    if (selectedIds && !selectedIds.has(item.id)) {
      const existing = usedSendTimes.get(originKey) || [];
      existing.push(item.sendTimeMs);
      usedSendTimes.set(originKey, existing);
      return item;
    }

    let sendTimeMs = syncMode === 'send' ? syncTimeMs : syncTimeMs - item.travelTimeMs;
    let arrivalTimeMs = syncMode === 'send' ? syncTimeMs + item.travelTimeMs : syncTimeMs;

    const prevTimes = usedSendTimes.get(originKey) || [];
    while (prevTimes.some((t) => Math.abs(t - sendTimeMs) < 200)) {
      sendTimeMs += 250;
      arrivalTimeMs += 250;
    }
    prevTimes.push(sendTimeMs);
    usedSendTimes.set(originKey, prevTimes);

    return {
      ...item,
      timingMode: syncMode,
      sendTimeMs,
      arrivalTimeMs,
    };
  });
}

export function computePlannerMatrix(params: {
  origins: TwVillage[];
  targets: PlannerTarget[];
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves: number;
  allWavesTroops?: TroopCounts[];
  timingMode?: 'arrival' | 'send';
  targetTimeMs: number;
  getMinPerField: (unit: TwUnitType) => number;
  allocationStrategy: 'nearest' | 'round-robin';
  maxCommandsPerOrigin: number;
  commandsPerTarget: number;
  notes?: string;
}): AttackPlanItem[] {
  const { origins, targets } = params;
  if (origins.length === 0 || targets.length === 0 || !Number.isFinite(params.targetTimeMs)) {
    return [];
  }

  const timingMode: 'arrival' | 'send' = params.timingMode || 'arrival';
  const resolvedSlowest = detectSlowestUnitClient(params.troops, params.slowestUnit);
  const minPerField = params.getMinPerField(resolvedSlowest);
  const totalWaves = Math.max(1, Math.min(5, params.waves || 1));
  const maxPerOrigin = Math.max(1, params.maxCommandsPerOrigin || 1);
  const perTarget = Math.max(1, params.commandsPerTarget || 1);

  const slots: PlannerTarget[] = [];
  for (const t of targets) {
    for (let i = 0; i < perTarget; i++) {
      slots.push(t);
    }
  }

  const usedPerOrigin = new Map<string, number>();
  const usedSendTimes = new Map<string, number[]>();
  const originKeyOf = (v: TwVillage) => v.id || v.coords;
  let rrCursor = 0;

  const items: AttackPlanItem[] = [];
  for (let sIdx = 0; sIdx < slots.length; sIdx++) {
    const slot = slots[sIdx];
    const parsed = parseCoordsPair(slot.coords);
    if (!parsed) continue;
    const { x: tx, y: ty } = parsed;

    let chosen: TwVillage | null = null;
    let chosenDist = 0;

    if (params.allocationStrategy === 'round-robin') {
      for (let step = 0; step < origins.length; step++) {
        const idx = (rrCursor + step) % origins.length;
        const cand = origins[idx];
        const key = originKeyOf(cand);
        if ((usedPerOrigin.get(key) || 0) < maxPerOrigin && cand.coords !== slot.coords) {
          chosen = cand;
          chosenDist = Math.hypot(cand.x - tx, cand.y - ty);
          rrCursor = (idx + 1) % origins.length;
          break;
        }
      }
    } else {
      let bestDist = Infinity;
      for (const cand of origins) {
        const key = originKeyOf(cand);
        if ((usedPerOrigin.get(key) || 0) >= maxPerOrigin || cand.coords === slot.coords) continue;
        const d = Math.hypot(cand.x - tx, cand.y - ty);
        if (d < bestDist) {
          bestDist = d;
          chosen = cand;
          chosenDist = d;
        }
      }
    }

    if (!chosen) break;

    const oKey = originKeyOf(chosen);
    usedPerOrigin.set(oKey, (usedPerOrigin.get(oKey) || 0) + 1);

    const travelTimeMs = Math.round(chosenDist * minPerField * 60 * 1000);
    let sendTimeMs =
      timingMode === 'send' ? params.targetTimeMs : params.targetTimeMs - travelTimeMs;
    let arrivalTimeMs =
      timingMode === 'send' ? params.targetTimeMs + travelTimeMs : params.targetTimeMs;

    const prevTimes = usedSendTimes.get(oKey) || [];
    while (prevTimes.some((t) => Math.abs(t - sendTimeMs) < 200)) {
      sendTimeMs += 250;
      arrivalTimeMs += 250;
    }
    prevTimes.push(sendTimeMs);
    usedSendTimes.set(oKey, prevTimes);

    const wavesArr =
      params.allWavesTroops && params.allWavesTroops.length > 0
        ? params.allWavesTroops.slice(0, totalWaves).map((w) => ({ ...w }))
        : Array.from({ length: totalWaves }, () => ({ ...(params.troops || {}) }));

    items.push({
      id: `${oKey}-${slot.coords}-${sIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      originVillageId: chosen.id,
      originVillageName: chosen.name,
      originCoords: chosen.coords,
      targetCoords: slot.coords,
      targetVillageName: slot.villageName,
      targetPlayerName: slot.playerName,
      commandType: params.commandType,
      presetName: params.presetName,
      slowestUnit: resolvedSlowest,
      troops: { ...(wavesArr[0] || params.troops || {}) },
      waves: totalWaves,
      allWavesTroops: wavesArr,
      distance: Number(chosenDist.toFixed(2)),
      travelTimeMs,
      sendTimeMs,
      arrivalTimeMs,
      timingMode,
      notes: params.notes,
    });
  }

  return items.sort((a, b) => a.sendTimeMs - b.sendTimeMs);
}
