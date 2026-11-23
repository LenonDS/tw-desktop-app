import type {
  SnipAttackGap,
  SnipSupportCandidate,
  TroopCounts,
  TwIncomingAttack,
  TwUnitType,
  TwVillage,
} from '../types';

export const UNIT_SPEED_MIN_PER_FIELD_CLIENT: Record<TwUnitType, number> = {
  spy: 9,
  light: 10,
  marcher: 10,
  knight: 10,
  heavy: 11,
  spear: 18,
  axe: 18,
  archer: 18,
  sword: 22,
  ram: 30,
  catapult: 30,
  snob: 35,
};

export const SNIP_UNIT_LABELS: Record<TwUnitType, string> = {
  spear: 'Lanceiro',
  sword: 'Espadachim',
  axe: 'Bárbaro',
  archer: 'Arqueiro',
  spy: 'Explorador',
  light: 'Cavalaria Leve',
  marcher: 'Arq. a Cavalo',
  heavy: 'Cav. Pesada',
  ram: 'Aríete',
  catapult: 'Catapulta (Âncora)',
  knight: 'Paladino',
  snob: 'Nobre',
};

const UNIT_POP_WEIGHT: Record<TwUnitType, number> = {
  spear: 1,
  sword: 1,
  axe: 1,
  archer: 1,
  spy: 2,
  light: 4,
  marcher: 5,
  heavy: 6,
  ram: 5,
  catapult: 8,
  knight: 10,
  snob: 100,
};

const DEFAULT_ALLOWED_UNITS: TwUnitType[] = [
  'knight',
  'heavy',
  'spear',
  'archer',
  'sword',
  'catapult',
  'ram',
  'light',
  'spy',
];

const DEFAULT_UNSYNCED_COMPOSITIONS: Partial<Record<TwUnitType, TroopCounts>> = {
  knight: { knight: 1, spy: 10 },
  heavy: { heavy: 300 },
  spear: { spear: 1000, heavy: 200 },
  archer: { archer: 1000, heavy: 200 },
  sword: { sword: 1000, spear: 1000, heavy: 200 },
  catapult: { catapult: 1, spear: 1000, sword: 1000 },
  ram: { ram: 1, spear: 1000, sword: 1000 },
  light: { light: 100, spy: 5 },
  marcher: { marcher: 100, spy: 5 },
  spy: { spy: 50 },
};

export function parseCoordsClient(raw: string): { x: number; y: number } | null {
  const m = /(\d{1,3})\|(\d{1,3})/.exec((raw || '').trim());
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

function isNobleIncoming(inc: TwIncomingAttack): boolean {
  const text = `${inc.detectedUnit || ''} ${inc.label || ''}`.toLowerCase();
  return /nobre|snob|\bnt\b/.test(text);
}

/**
 * Groups incoming attacks by account + target village and detects ms gaps between
 * consecutive incoming hits for Auto-Snip support placement.
 */
export function detectSnipWindowsClient(
  incomings: TwIncomingAttack[],
  options?: { maxGapMs?: number; safetyMarginMs?: number }
): SnipAttackGap[] {
  if (!Array.isArray(incomings) || incomings.length === 0) return [];
  const maxGapMs = Math.max(10, options?.maxGapMs ?? 60000);
  const defaultMarginMs = Math.max(1, options?.safetyMarginMs ?? 10);

  const grouped = new Map<string, TwIncomingAttack[]>();
  for (const inc of incomings) {
    if (!Number.isFinite(inc.arrivalTimeMs)) continue;
    const parsed = parseCoordsClient(inc.targetCoords);
    const cleanTarget = parsed ? `${parsed.x}|${parsed.y}` : inc.targetCoords.trim();
    const key = `${inc.accountId}::${cleanTarget}`;
    const list = grouped.get(key) || [];
    list.push({ ...inc, targetCoords: cleanTarget });
    grouped.set(key, list);
  }

  const gaps: SnipAttackGap[] = [];
  for (const list of grouped.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      if (a.arrivalTimeMs !== b.arrivalTimeMs) return a.arrivalTimeMs - b.arrivalTimeMs;
      return String(a.commandId || a.id).localeCompare(String(b.commandId || b.id));
    });

    for (let i = 0; i < sorted.length - 1; i++) {
      const first = sorted[i];
      const second = sorted[i + 1];
      const gapMs = Math.round(second.arrivalTimeMs - first.arrivalTimeMs);
      if (gapMs <= 0 || gapMs > maxGapMs) continue;

      const margin = gapMs > 30 ? Math.min(defaultMarginMs, Math.floor(gapMs / 4)) : 1;
      const windowStartMs = first.arrivalTimeMs + margin;
      const windowEndMs = Math.max(windowStartMs, second.arrivalTimeMs - margin);
      const recommendedArrivalMs = Math.round((first.arrivalTimeMs + second.arrivalTimeMs) / 2);

      const firstIsNoble = isNobleIncoming(first);
      const secondIsNoble = isNobleIncoming(second);

      let priority: SnipAttackGap['priority'] = 'standard';
      if (secondIsNoble && !firstIsNoble) {
        priority = 'critical_noble';
      } else if (firstIsNoble && secondIsNoble) {
        priority = 'noble_train';
      } else if (gapMs <= 2000) {
        priority = 'tight_gap';
      }

      gaps.push({
        id: `${first.accountId}:${first.targetCoords}:${first.commandId}->${second.commandId}`,
        accountId: first.accountId,
        accountName: first.accountName,
        targetCoords: first.targetCoords,
        targetName: first.targetName || second.targetName || first.targetCoords,
        firstAttackId: first.commandId,
        firstAttackLabel: first.label || first.detectedUnit,
        firstAttackUnit: first.detectedUnit,
        firstAttackArrivalMs: first.arrivalTimeMs,
        secondAttackId: second.commandId,
        secondAttackLabel: second.label || second.detectedUnit,
        secondAttackUnit: second.detectedUnit,
        secondAttackArrivalMs: second.arrivalTimeMs,
        gapMs,
        windowStartMs,
        windowEndMs,
        recommendedArrivalMs,
        priority,
      });
    }
  }

  const rank: Record<SnipAttackGap['priority'], number> = {
    critical_noble: 0,
    noble_train: 1,
    tight_gap: 2,
    standard: 3,
  };

  return gaps.sort((a, b) => {
    const rDiff = rank[a.priority] - rank[b.priority];
    if (rDiff !== 0) return rDiff;
    return a.firstAttackArrivalMs - b.firstAttackArrivalMs;
  });
}

function buildSnipCompositionClient(
  anchorUnit: TwUnitType,
  troops: TroopCounts | undefined,
  allowedSet: Set<TwUnitType>
): { suggestedTroops: TroopCounts; totalDefensivePop: number } | null {
  if (!troops) {
    if (anchorUnit === 'archer' && allowedSet.has('spear')) return null;
    if (anchorUnit === 'ram' && allowedSet.has('catapult')) return null;
    const preset = DEFAULT_UNSYNCED_COMPOSITIONS[anchorUnit] || { [anchorUnit]: 100 };
    const suggestedTroops: TroopCounts = { ...preset };
    let totalDefensivePop = 0;
    for (const [u, qty] of Object.entries(suggestedTroops)) {
      const count = Number(qty) || 0;
      if (count > 0) totalDefensivePop += count * (UNIT_POP_WEIGHT[u as TwUnitType] ?? 1);
    }
    return { suggestedTroops, totalDefensivePop };
  }

  const anchorQty = Number(troops[anchorUnit] ?? 0);
  if (anchorQty <= 0) return null;
  if (anchorUnit === 'archer' && Number(troops.spear ?? 0) > 0 && allowedSet.has('spear')) {
    return null;
  }
  if (anchorUnit === 'ram' && Number(troops.catapult ?? 0) > 0 && allowedSet.has('catapult')) {
    return null;
  }

  const anchorSpeed = UNIT_SPEED_MIN_PER_FIELD_CLIENT[anchorUnit] ?? 18;
  const suggestedTroops: TroopCounts = {
    [anchorUnit]: anchorUnit === 'ram' ? 1 : anchorQty,
  };

  const compatiblePool: TwUnitType[] =
    anchorUnit === 'light' || anchorUnit === 'marcher'
      ? [anchorUnit, 'knight', 'spy']
      : ['knight', 'heavy', 'spear', 'archer', 'sword', 'spy'];

  for (const unit of compatiblePool) {
    if (unit === anchorUnit) continue;
    const qty = Number(troops[unit] ?? 0);
    if (qty <= 0) continue;
    if ((UNIT_SPEED_MIN_PER_FIELD_CLIENT[unit] ?? 999) <= anchorSpeed) {
      suggestedTroops[unit] = qty;
    }
  }

  let totalDefensivePop = 0;
  for (const [u, qty] of Object.entries(suggestedTroops)) {
    const count = Number(qty) || 0;
    if (count > 0) totalDefensivePop += count * (UNIT_POP_WEIGHT[u as TwUnitType] ?? 1);
  }

  return { suggestedTroops, totalDefensivePop };
}

/**
 * Scans account villages and calculates all viable (village + anchorUnit) support
 * combinations whose travel time fits inside [windowStartMs, windowEndMs] before send cutoff.
 */
export function findViableSnipSupportsClient(params: {
  accountId: string;
  accountName?: string;
  targetCoords: string;
  windowStartMs: number;
  windowEndMs: number;
  targetArrivalMs?: number;
  villages: TwVillage[];
  groupFilter?: string;
  minDefensivePop?: number;
  minLeadTimeMs?: number;
  nowMs?: number;
  worldSpeed?: number;
  unitSpeed?: number;
  unitSpeeds?: Partial<Record<TwUnitType, number>>;
  allowedUnits?: TwUnitType[];
}): SnipSupportCandidate[] {
  const targetParsed = parseCoordsClient(params.targetCoords);
  if (!targetParsed || !Array.isArray(params.villages) || params.villages.length === 0) {
    return [];
  }

  const cleanTargetCoords = `${targetParsed.x}|${targetParsed.y}`;
  const minWindow = Math.min(params.windowStartMs, params.windowEndMs);
  const maxWindow = Math.max(params.windowStartMs, params.windowEndMs);
  const rawArrival =
    typeof params.targetArrivalMs === 'number' && Number.isFinite(params.targetArrivalMs)
      ? params.targetArrivalMs
      : Math.round((minWindow + maxWindow) / 2);
  const clampedArrivalMs = Math.max(minWindow, Math.min(maxWindow, rawArrival));

  const allowedUnits =
    params.allowedUnits && params.allowedUnits.length > 0
      ? params.allowedUnits
      : DEFAULT_ALLOWED_UNITS;
  const allowedSet = new Set<TwUnitType>(allowedUnits);

  const normalizedGroup = (params.groupFilter || '').trim();
  const applyGroupFilter =
    normalizedGroup !== '' && normalizedGroup !== 'ALL' && normalizedGroup !== '0';

  const minDefensivePop = Math.max(0, params.minDefensivePop ?? 10);
  const minLeadTimeMs = params.minLeadTimeMs ?? 15000;
  const nowMs = params.nowMs ?? Date.now();
  const worldSpeed = Math.max(0.1, params.worldSpeed ?? 1);
  const unitSpeed = Math.max(0.1, params.unitSpeed ?? 1);
  const effectiveFactor = Math.max(0.1, worldSpeed * unitSpeed);

  const candidates: SnipSupportCandidate[] = [];

  for (const village of params.villages) {
    const vParsed = parseCoordsClient(village.coords);
    if (!vParsed) continue;
    const cleanOriginCoords = `${vParsed.x}|${vParsed.y}`;
    if (cleanOriginCoords === cleanTargetCoords) continue;

    if (applyGroupFilter && (village.localCategory || '').trim() !== normalizedGroup) {
      continue;
    }

    const rawDist = Math.hypot(vParsed.x - targetParsed.x, vParsed.y - targetParsed.y);
    const distance = Number(rawDist.toFixed(2));
    if (rawDist <= 0) continue;

    for (const anchorUnit of allowedUnits) {
      const comp = buildSnipCompositionClient(anchorUnit, village.troops, allowedSet);
      if (!comp || comp.totalDefensivePop < minDefensivePop) continue;

      const overrideMinPerField = params.unitSpeeds?.[anchorUnit];
      const travelTimeMs =
        typeof overrideMinPerField === 'number' &&
        Number.isFinite(overrideMinPerField) &&
        overrideMinPerField > 0
          ? Math.round(rawDist * overrideMinPerField * 60 * 1000)
          : Math.round(
              ((rawDist * (UNIT_SPEED_MIN_PER_FIELD_CLIENT[anchorUnit] ?? 18)) / effectiveFactor) *
                60 *
                1000
            );

      if (travelTimeMs <= 0) continue;

      const sendTimeMs = clampedArrivalMs - travelTimeMs;
      const leadTimeMs = sendTimeMs - nowMs;
      if (leadTimeMs < minLeadTimeMs) continue;

      candidates.push({
        id: `${village.id || cleanOriginCoords}:${anchorUnit}`,
        accountId: params.accountId,
        accountName: params.accountName || '',
        originVillageId: village.id,
        originVillageName: village.name,
        originCoords: cleanOriginCoords,
        originGroup: village.localCategory,
        targetCoords: cleanTargetCoords,
        slowestUnit: anchorUnit,
        unitLabel: SNIP_UNIT_LABELS[anchorUnit] || anchorUnit,
        distance,
        travelTimeMs,
        sendTimeMs,
        arrivalTimeMs: clampedArrivalMs,
        windowStartMs: minWindow,
        windowEndMs: maxWindow,
        leadTimeMs,
        availableTroops: { ...(village.troops || {}) },
        suggestedTroops: comp.suggestedTroops,
        totalDefensivePop: comp.totalDefensivePop,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.sendTimeMs !== b.sendTimeMs) return a.sendTimeMs - b.sendTimeMs;
    return b.totalDefensivePop - a.totalDefensivePop;
  });
}
