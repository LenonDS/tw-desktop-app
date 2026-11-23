import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  NOOP_SECRET_CIPHER,
  decryptStoreSecrets,
  encryptStoreSecrets,
  type SecretCipher,
} from './secretCrypto';
import type {
  ActivityLogEntry,
  AppSettings,
  AttackPlanItem,
  AutoFarmConfig,
  ConstructionModel,
  FarmDuplicateOriginRef,
  FarmDuplicateSummary,
  FarmPauseReason,
  FarmPlayerRouteTarget,
  FarmPlunderTarget,
  FarmTemplateKey,
  ProxyConfig,
  RecruitmentModel,
  ScheduledCommand,
  SnipAttackGap,
  SnipSupportCandidate,
  StoreSchema,
  TroopCounts,
  TroopModelPreset,
  TwAccount,
  TwFingerprint,
  TwIncomingAttack,
  TwTargetPlayer,
  TwTargetVillage,
  TwUnitType,
  TwVillage,
  TwVillageGroup,
  TwWorldConfig,
} from './types';

const DEFAULT_SETTINGS: AppSettings = {
  defaultDomain: 'tribalwars.com.br',
  defaultWorld: 'br130',
  autoRestoreSessions: false,
  theme: 'dark',
};

/** Base unit speed in minutes per field on speed 1.0 worlds */
export const UNIT_SPEED_MIN_PER_FIELD: Record<TwUnitType, number> = {
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

/** Default command troop presets for common Tribal Wars operations */
export const DEFAULT_SCHEDULER_PRESETS: TroopModelPreset[] = [
  {
    id: 'preset-nt25',
    presetId: 'nt25',
    name: 'NT 25% (Noble Train 4x)',
    commandType: 'noble4',
    isPreset: true,
    slowestUnit: 'snob',
    waves: 4,
    troops: { axe: 250, light: 100, snob: 1 },
    allWavesTroops: [
      { axe: 250, light: 100, snob: 1 },
      { axe: 250, light: 100, snob: 1 },
      { axe: 250, light: 100, snob: 1 },
      { axe: 250, light: 100, snob: 1 },
    ],
  },
  {
    id: 'preset-full',
    presetId: 'full-attack',
    name: 'Ataque Full Ofensivo',
    commandType: 'attack',
    isPreset: true,
    slowestUnit: 'ram',
    waves: 1,
    troops: { axe: 6500, spy: 5, light: 3000, ram: 300, catapult: 50 },
  },
  {
    id: 'preset-fake',
    presetId: 'fake',
    name: 'Fake (Aríete + Spy)',
    commandType: 'fake',
    isPreset: true,
    slowestUnit: 'ram',
    waves: 1,
    troops: { spy: 50, ram: 1 },
  },
  {
    id: 'preset-fake-spy',
    presetId: 'fake-spy',
    name: 'Fake Spy (5 Exploradores)',
    commandType: 'fake',
    isPreset: true,
    slowestUnit: 'spy',
    waves: 1,
    troops: { spy: 5 },
  },
  {
    id: 'preset-support',
    presetId: 'support-def',
    name: 'Apoio Defensivo Rápido',
    commandType: 'support',
    isPreset: true,
    slowestUnit: 'sword',
    waves: 1,
    troops: { spear: 2000, sword: 2000, heavy: 300 },
  },
];

export const DEFAULT_CONSTRUCTION_MODELS: ConstructionModel[] = [
  {
    id: 'const-start-eco',
    name: 'Sprint Inicial de Recursos',
    description: 'Foco em Bosque, Argila, Ferro, Armazém e Edifício Principal até nível 10.',
    steps: [
      { building: 'wood', level: 3 },
      { building: 'stone', level: 3 },
      { building: 'iron', level: 1 },
      { building: 'main', level: 3 },
      { building: 'barracks', level: 1 },
      { building: 'storage', level: 5 },
      { building: 'farm', level: 5 },
      { building: 'wood', level: 10 },
      { building: 'stone', level: 10 },
      { building: 'iron', level: 8 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'const-rush-snob',
    name: 'Rush Academia / Nobre',
    description: 'Evolução acelerada de Edifício Principal 20, Ferreiro 20, Mercado 10 e Academia 1.',
    steps: [
      { building: 'main', level: 10 },
      { building: 'barracks', level: 5 },
      { building: 'smith', level: 5 },
      { building: 'stable', level: 3 },
      { building: 'market', level: 10 },
      { building: 'main', level: 20 },
      { building: 'storage', level: 23 },
      { building: 'farm', level: 22 },
      { building: 'smith', level: 20 },
      { building: 'snob', level: 1 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'const-fortress-def',
    name: 'Fortaleza Defensiva (Muralha 20)',
    description: 'Prioriza Muralha nível 20, Quartel 25 e Fazenda 30 para blindagem de front.',
    steps: [
      { building: 'wall', level: 10 },
      { building: 'barracks', level: 15 },
      { building: 'wall', level: 20 },
      { building: 'farm', level: 30 },
      { building: 'storage', level: 30 },
      { building: 'barracks', level: 25 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export const DEFAULT_RECRUITMENT_MODELS: RecruitmentModel[] = [
  {
    id: 'rec-full-off',
    name: 'Full Ofensivo Padrão',
    category: 'offensive',
    description: 'Aldeia de ataque clássica com Bárbaros, Cavalaria Leve e Aríetes.',
    troops: { axe: 6500, spy: 50, light: 3000, ram: 300, catapult: 50 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rec-full-def',
    name: 'Defesa Infantaria (Lança + Espada)',
    category: 'defensive',
    description: 'Defesa balanceada contra cavalaria e infantaria.',
    troops: { spear: 9500, sword: 9500, spy: 100 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rec-fast-def',
    name: 'Defesa Rápida (Lança + Cav. Pesada)',
    category: 'defensive',
    description: 'Ideal para snipes e apoios rápidos no front.',
    troops: { spear: 7000, heavy: 1800, spy: 100 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rec-scout-village',
    name: 'Aldeia Especialista Exploradores',
    category: 'scout',
    description: 'Focada em reconhecimento e proteção contra exploração.',
    troops: { spear: 1000, spy: 8500, catapult: 50 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export function parseCoords(coords: string): { x: number; y: number } | null {
  const m = /(\d{1,3})\|(\d{1,3})/.exec(coords.trim());
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Detects the slowest unit (`TwUnitType`) among all units in `troops` that have a quantity > 0.
 * Returns `null` when no unit has a count > 0, allowing free manual selection in the UI.
 */
export function detectSlowestUnitFromTroops(troops?: TroopCounts): TwUnitType | null {
  if (!troops) return null;
  let slowestUnit: TwUnitType | null = null;
  let maxMinPerField = -1;
  for (const [unitKey, rawCount] of Object.entries(troops)) {
    const count = Number(rawCount) || 0;
    if (count <= 0) continue;
    const unit = unitKey as TwUnitType;
    const speed = UNIT_SPEED_MIN_PER_FIELD[unit] ?? 0;
    if (speed > maxMinPerField) {
      maxMinPerField = speed;
      slowestUnit = unit;
    }
  }
  return slowestUnit;
}

export function calculateDistance(fromCoords: string, toCoords: string): number {
  const a = parseCoords(fromCoords);
  const b = parseCoords(toCoords);
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function calculateTravelTimeMs(
  fromCoords: string,
  toCoords: string,
  unit: TwUnitType,
  worldSpeed = 1,
  unitSpeed = 1,
  unitSpeedOverrideMinPerField?: number
): number {
  const dist = calculateDistance(fromCoords, toCoords);
  if (dist <= 0) return 0;
  // Note: In Tribal Wars `/interface.php?func=get_unit_info`, `<speed>` is given as
  // minutes per field already scaled by `worldSpeed * unitSpeed` OR base minutes per field.
  // If `unitSpeedOverrideMinPerField` is provided directly in effective minutes/field, use it!
  if (
    typeof unitSpeedOverrideMinPerField === 'number' &&
    Number.isFinite(unitSpeedOverrideMinPerField) &&
    unitSpeedOverrideMinPerField > 0
  ) {
    return Math.round(dist * unitSpeedOverrideMinPerField * 60 * 1000);
  }
  const minPerField = UNIT_SPEED_MIN_PER_FIELD[unit] ?? 18;
  const effectiveSpeed = Math.max(0.1, worldSpeed * unitSpeed);
  const minutes = (dist * minPerField) / effectiveSpeed;
  return Math.round(minutes * 60 * 1000);
}

export function calculateSendTimeMs(
  arrivalTimeMs: number,
  fromCoords: string,
  toCoords: string,
  unit: TwUnitType,
  worldSpeed = 1,
  unitSpeed = 1,
  unitSpeedOverrideMinPerField?: number
): { distance: number; travelTimeMs: number; sendTimeMs: number } {
  const distance = calculateDistance(fromCoords, toCoords);
  const travelTimeMs = calculateTravelTimeMs(
    fromCoords,
    toCoords,
    unit,
    worldSpeed,
    unitSpeed,
    unitSpeedOverrideMinPerField
  );
  return {
    distance: Number(distance.toFixed(2)),
    travelTimeMs,
    sendTimeMs: arrivalTimeMs - travelTimeMs,
  };
}

/**
 * Parses `/interface.php?func=get_config` and `/interface.php?func=get_unit_info` XML responses
 * to extract world speed, unit speed modifier, per-unit speeds, and world feature flags.
 */
export function parseWorldConfigXml(
  configXml: string,
  unitInfoXml?: string
): Omit<TwWorldConfig, 'worldKey' | 'domain' | 'world' | 'fetchedAt'> {
  const extractTag = (xml: string, tag: string): string | null => {
    const m = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(xml);
    return m ? m[1].trim() : null;
  };
  const extractNum = (xml: string, tag: string, fallback: number): number => {
    const raw = extractTag(xml, tag);
    if (raw === null) return fallback;
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const extractFlag = (xml: string, tag: string, fallback = false): boolean => {
    const raw = extractTag(xml, tag);
    if (raw === null) return fallback;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  };

  const speed = extractNum(configXml || '', 'speed', 1);
  const unitSpeed = extractNum(configXml || '', 'unit_speed', 1);
  const effectiveFactor = Math.max(0.1, speed * unitSpeed);

  const allUnits: TwUnitType[] = [
    'spear',
    'sword',
    'axe',
    'archer',
    'spy',
    'light',
    'marcher',
    'heavy',
    'ram',
    'catapult',
    'knight',
    'snob',
  ];

  const unitSpeeds: Partial<Record<TwUnitType, number>> = {};
  for (const u of allUnits) {
    unitSpeeds[u] = Number((UNIT_SPEED_MIN_PER_FIELD[u] / effectiveFactor).toFixed(4));
  }

  if (unitInfoXml) {
    for (const u of allUnits) {
      const blockMatch = new RegExp(`<${u}>([\\s\\S]*?)</${u}>`, 'i').exec(unitInfoXml);
      if (blockMatch) {
        const spRaw = extractTag(blockMatch[1], 'speed');
        const spVal = spRaw ? parseFloat(spRaw) : NaN;
        if (Number.isFinite(spVal) && spVal > 0) {
          // Tribal Wars `/interface.php?func=get_unit_info` returns `<speed>` already scaled by worldSpeed * unitSpeed
          // (e.g., 18 / (1.6 * 0.625) = 18, or on speed 2 / unit_speed 1 -> 9).
          unitSpeeds[u] = Number(spVal.toFixed(4));
        }
      }
    }
  }

  const cancelRaw = extractTag(configXml || '', 'command_cancel_time');
  const gapRaw = extractTag(configXml || '', 'attack_gap');
  const fakeRaw = extractTag(configXml || '', 'fake_limit');

  return {
    speed,
    unitSpeed,
    archer: extractFlag(configXml || '', 'archer', false),
    paladin: extractFlag(configXml || '', 'knight', true),
    church: extractFlag(configXml || '', 'church', false),
    watchtower: extractFlag(configXml || '', 'watchtower', false),
    moral: extractFlag(configXml || '', 'moral', true),
    commandCancelSec: cancelRaw && Number.isFinite(Number(cancelRaw)) ? Number(cancelRaw) : 600,
    attackGapMs: gapRaw && Number.isFinite(Number(gapRaw)) ? Number(gapRaw) : 100,
    fakeLimitPct: fakeRaw && Number.isFinite(Number(fakeRaw)) ? Number(fakeRaw) : 1,
    unitSpeeds,
  };
}

export function classifyIncomingAttackUnit(
  distance: number,
  remainingSec: number,
  worldSpeed = 1,
  unitSpeed = 1
): string {
  if (distance <= 0 || remainingSec <= 0) return 'Desconhecido';
  const effectiveSpeed = Math.max(0.1, worldSpeed * unitSpeed);
  const minPerField = (remainingSec / 60 / distance) * effectiveSpeed;

  if (minPerField >= 32) return 'Nobre (Snob)';
  if (minPerField >= 25) return 'Aríete / Catapulta';
  if (minPerField >= 20) return 'Espadachim';
  if (minPerField >= 14) return 'Bárbaro / Lanceiro';
  if (minPerField >= 10.5) return 'Cavalaria Pesada';
  if (minPerField >= 9.5) return 'Cavalaria Leve';
  return 'Explorador (Spy)';
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
];

export function generateFingerprint(): TwFingerprint {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    userAgent: ua,
    viewport: { width: 1366, height: 768 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  };
}

export function formatProxyRules(proxy?: ProxyConfig): string | null {
  if (!proxy || !proxy.enabled || !proxy.host || !proxy.port) {
    return null;
  }
  const protocol = proxy.protocol || 'http';
  return `${protocol}://${proxy.host}:${proxy.port}`;
}

export function parsePhpSerializedServers(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /s:\d+:"([^"]+)";s:\d+:"([^"]+)";/g;
  for (const match of raw.matchAll(regex)) {
    result[match[1]] = match[2];
  }
  return result;
}

export function decodeTwText(encoded: string): string {
  const raw = String(encoded || '');
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return raw.replace(/\+/g, ' ');
  }
}

export function parseWorldPlayersTxt(rawTxt: string): TwTargetPlayer[] {
  const players: TwTargetPlayer[] = [];
  if (!rawTxt) return players;
  const lines = rawTxt.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 6) continue;
    const id = parts[0].trim();
    const name = decodeTwText(parts[1]).trim();
    const allyId = parts[2].trim();
    const villagesCount = Number(parts[3]) || 0;
    const points = Number(parts[4]) || 0;
    const rank = Number(parts[5]) || 0;
    if (!id || !name) continue;
    players.push({
      id,
      name,
      allyId: allyId && allyId !== '0' ? allyId : undefined,
      villagesCount,
      points,
      rank,
    });
  }
  return players;
}

export function parseWorldVillagesTxt(
  rawTxt: string,
  playersById?: Map<string, TwTargetPlayer>
): TwTargetVillage[] {
  const villages: TwTargetVillage[] = [];
  if (!rawTxt) return villages;
  const lines = rawTxt.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 7) continue;
    const id = parts[0].trim();
    const name = decodeTwText(parts[1]).trim() || `Aldeia ${id}`;
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const playerId = parts[4].trim();
    const points = Number(parts[5]) || 0;
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const continent = `K${Math.floor(y / 100)}${Math.floor(x / 100)}`;
    const player = playersById?.get(playerId);
    villages.push({
      id,
      name,
      coords: `${x}|${y}`,
      x,
      y,
      points,
      continent,
      playerId,
      playerName: player?.name || (playerId === '0' ? 'Aldeia Bárbara' : ''),
    });
  }
  return villages;
}

export function searchTargetPlayerVillages(params: {
  query: string;
  players: TwTargetPlayer[];
  villages: TwTargetVillage[];
  limit?: number;
}): { matchedPlayers: TwTargetPlayer[]; villages: TwTargetVillage[] } {
  const trimmed = (params.query || '').trim();
  if (!trimmed) {
    return { matchedPlayers: [], villages: [] };
  }
  const maxVillages = Math.max(1, params.limit ?? 300);
  const coordMatch = /^(\d{1,3})\|(\d{1,3})$/.exec(trimmed);
  if (coordMatch) {
    const targetCoord = `${Number(coordMatch[1])}|${Number(coordMatch[2])}`;
    const matchedVillages = params.villages
      .filter((v) => v.coords === targetCoord)
      .slice(0, maxVillages);
    const ownerIds = new Set(matchedVillages.map((v) => v.playerId).filter((id) => id && id !== '0'));
    const matchedPlayers = params.players.filter((p) => ownerIds.has(p.id));
    return {
      matchedPlayers,
      villages: matchedVillages,
    };
  }

  const qLower = trimmed.toLowerCase();
  const matchedPlayers = params.players
    .filter((p) => p.name.toLowerCase().includes(qLower))
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === qLower ? 0 : aName.startsWith(qLower) ? 1 : 2;
      const bExact = bName === qLower ? 0 : bName.startsWith(qLower) ? 1 : 2;
      if (aExact !== bExact) return aExact - bExact;
      return b.points - a.points;
    })
    .slice(0, 25);

  if (matchedPlayers.length > 0) {
    const playerIds = new Set(matchedPlayers.map((p) => p.id));
    const villages = params.villages
      .filter((v) => playerIds.has(v.playerId))
      .sort((a, b) => b.points - a.points)
      .slice(0, maxVillages);
    return { matchedPlayers, villages };
  }

  // Fallback: match by village name substring if no player matched
  const villagesByName = params.villages
    .filter((v) => v.name.toLowerCase().includes(qLower) || v.coords.includes(trimmed))
    .sort((a, b) => b.points - a.points)
    .slice(0, maxVillages);

  return { matchedPlayers: [], villages: villagesByName };
}

export function buildAttackPlanMatrix(params: {
  origins: TwVillage[];
  targets: Array<{ coords: string; villageName?: string; playerName?: string }>;
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves?: number;
  allWavesTroops?: TroopCounts[];
  arrivalTimeMs: number;
  worldSpeed?: number;
  unitSpeed?: number;
  unitSpeedOverrideMinPerField?: number;
  allocationStrategy?: 'nearest' | 'round-robin';
  maxCommandsPerOrigin?: number;
  commandsPerTarget?: number;
  notes?: string;
}): AttackPlanItem[] {
  const { origins, targets } = params;
  if (!origins.length || !targets.length) return [];

  const resolvedSlowestUnit = detectSlowestUnitFromTroops(params.troops) || params.slowestUnit;
  const totalWaves = Math.max(1, Math.min(5, params.waves || 1));
  const strategy = params.allocationStrategy || 'nearest';
  const maxPerOrigin = Math.max(1, params.maxCommandsPerOrigin || 1);
  const perTarget = Math.max(1, params.commandsPerTarget || 1);
  const worldSpeed = params.worldSpeed ?? 1;
  const unitSpeed = params.unitSpeed ?? 1;

  // Expand target slots
  const targetSlots: Array<{ coords: string; villageName?: string; playerName?: string }> = [];
  for (const t of targets) {
    if (!parseCoords(t.coords)) continue;
    for (let i = 0; i < perTarget; i++) {
      targetSlots.push(t);
    }
  }
  if (targetSlots.length === 0) return [];

  const usedPerOrigin = new Map<string, number>();
  const usedSendTimesByOrigin = new Map<string, number[]>();
  const originKeyOf = (o: TwVillage) => o.id || o.coords;
  let rrIdx = 0;

  const plan: AttackPlanItem[] = [];

  for (const slot of targetSlots) {
    let chosenOrigin: TwVillage | null = null;

    if (strategy === 'round-robin') {
      for (let step = 0; step < origins.length; step++) {
        const idx = (rrIdx + step) % origins.length;
        const cand = origins[idx];
        const key = originKeyOf(cand);
        const used = usedPerOrigin.get(key) || 0;
        if (used < maxPerOrigin && cand.coords !== slot.coords) {
          chosenOrigin = cand;
          rrIdx = (idx + 1) % origins.length;
          break;
        }
      }
    } else {
      let bestDist = Infinity;
      for (const cand of origins) {
        const key = originKeyOf(cand);
        const used = usedPerOrigin.get(key) || 0;
        if (used >= maxPerOrigin || cand.coords === slot.coords) continue;
        const dist = calculateDistance(cand.coords, slot.coords);
        if (dist < bestDist) {
          bestDist = dist;
          chosenOrigin = cand;
        }
      }
    }

    if (!chosenOrigin) break;

    const originKey = originKeyOf(chosenOrigin);
    usedPerOrigin.set(originKey, (usedPerOrigin.get(originKey) || 0) + 1);

    const timing = calculateSendTimeMs(
      params.arrivalTimeMs,
      chosenOrigin.coords,
      slot.coords,
      resolvedSlowestUnit,
      worldSpeed,
      unitSpeed,
      params.unitSpeedOverrideMinPerField
    );

    let sendTimeMs = timing.sendTimeMs;
    let arrivalTimeMs = params.arrivalTimeMs;
    const prevTimes = usedSendTimesByOrigin.get(originKey) || [];
    while (prevTimes.some((t) => Math.abs(t - sendTimeMs) < 200)) {
      sendTimeMs += 250;
      arrivalTimeMs += 250;
    }
    prevTimes.push(sendTimeMs);
    usedSendTimesByOrigin.set(originKey, prevTimes);

    const wavesArr =
      params.allWavesTroops && params.allWavesTroops.length > 0
        ? params.allWavesTroops.slice(0, totalWaves).map((w) => ({ ...w }))
        : Array.from({ length: totalWaves }, () => ({ ...(params.troops || {}) }));

    plan.push({
      id: crypto.randomUUID(),
      originVillageId: chosenOrigin.id,
      originVillageName: chosenOrigin.name,
      originCoords: chosenOrigin.coords,
      targetCoords: slot.coords,
      targetVillageName: slot.villageName,
      targetPlayerName: slot.playerName,
      commandType: params.commandType,
      presetName: params.presetName,
      slowestUnit: resolvedSlowestUnit,
      troops: { ...(wavesArr[0] || params.troops || {}) },
      waves: totalWaves,
      allWavesTroops: wavesArr,
      distance: timing.distance,
      travelTimeMs: timing.travelTimeMs,
      sendTimeMs,
      arrivalTimeMs,
      timingMode: 'arrival',
      notes: params.notes,
    });
  }

  return plan.sort((a, b) => a.sendTimeMs - b.sendTimeMs);
}

/**
 * Builds a single manually configured AttackPlanItem supporting both
 * 'arrival' (calculate sendTimeMs) and 'send' (calculate arrivalTimeMs).
 */
export function buildManualAttackPlanItem(params: {
  id?: string;
  origin: TwVillage;
  target: { coords: string; villageName?: string; playerName?: string };
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves?: number;
  allWavesTroops?: TroopCounts[];
  timingMode: 'arrival' | 'send';
  targetTimeMs: number;
  worldSpeed?: number;
  unitSpeed?: number;
  unitSpeedOverrideMinPerField?: number;
  notes?: string;
}): AttackPlanItem | null {
  const parsedTarget = parseCoords(params.target.coords);
  if (!parsedTarget || !Number.isFinite(params.targetTimeMs)) return null;
  const normalizedTarget = `${parsedTarget.x}|${parsedTarget.y}`;
  if (params.origin.coords === normalizedTarget) return null;

  const resolvedSlowestUnit = detectSlowestUnitFromTroops(params.troops) || params.slowestUnit;
  const worldSpeed = params.worldSpeed ?? 1;
  const unitSpeed = params.unitSpeed ?? 1;
  const totalWaves = Math.max(1, Math.min(5, params.waves || 1));

  const timing = calculateSendTimeMs(
    params.targetTimeMs,
    params.origin.coords,
    normalizedTarget,
    resolvedSlowestUnit,
    worldSpeed,
    unitSpeed,
    params.unitSpeedOverrideMinPerField
  );

  const sendTimeMs =
    params.timingMode === 'send' ? params.targetTimeMs : timing.sendTimeMs;
  const arrivalTimeMs =
    params.timingMode === 'send'
      ? params.targetTimeMs + timing.travelTimeMs
      : params.targetTimeMs;

  const wavesArr =
    params.allWavesTroops && params.allWavesTroops.length > 0
      ? params.allWavesTroops.slice(0, totalWaves).map((w) => ({ ...w }))
      : Array.from({ length: totalWaves }, () => ({ ...(params.troops || {}) }));

  return {
    id: params.id || crypto.randomUUID(),
    originVillageId: params.origin.id,
    originVillageName: params.origin.name,
    originCoords: params.origin.coords,
    targetCoords: normalizedTarget,
    targetVillageName: params.target.villageName,
    targetPlayerName: params.target.playerName,
    commandType: params.commandType,
    presetName: params.presetName,
    slowestUnit: resolvedSlowestUnit,
    troops: { ...(wavesArr[0] || params.troops || {}) },
    waves: totalWaves,
    allWavesTroops: wavesArr,
    distance: timing.distance,
    travelTimeMs: timing.travelTimeMs,
    sendTimeMs,
    arrivalTimeMs,
    timingMode: params.timingMode,
    notes: params.notes,
  };
}

/**
 * Applies optional synchronized arrival or synchronized send timing to
 * AttackPlanItems (all or selected), preserving anti-collision staggering
 * (>= 200ms) for commands sharing the same origin village.
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

/**
 * Wave 5 (Phase 19): Finds the nearest friendly village owned by the same account
 * to serve as the evasion support destination for Auto-Dodge.
 */
export function findNearestFriendlyVillage(
  originCoords: string,
  villages: TwVillage[]
): TwVillage | null {
  const origin = parseCoords(originCoords);
  if (!origin || !Array.isArray(villages) || villages.length === 0) return null;
  const cleanOrigin = `${origin.x}|${origin.y}`;
  let best: TwVillage | null = null;
  let bestDist = Infinity;

  for (const v of villages) {
    const parsed = parseCoords(v.coords);
    if (!parsed) continue;
    const cleanV = `${parsed.x}|${parsed.y}`;
    if (cleanV === cleanOrigin) continue;
    const dist = calculateDistance(cleanOrigin, cleanV);
    if (dist > 0 && dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

/**
 * Wave 5 (Phase 19): Computes the exact Auto-Dodge withdrawal send timestamp,
 * post-impact cancellation timestamp, expected troop return timestamp, and
 * whether the evasion window fits safely within the world's command cancel limit.
 */
export function calculateAutoDodgeTiming(params: {
  enemyArrivalTimeMs: number;
  dodgeBeforeSec?: number;
  cancelAfterSec?: number;
  commandCancelLimitSec?: number;
}): {
  sendTimeMs: number;
  cancelTimeMs: number;
  dodgeBeforeMs: number;
  cancelAfterMs: number;
  travelBeforeCancelMs: number;
  expectedReturnTimeMs: number;
  withinCancelWindow: boolean;
} {
  const dodgeBeforeMs = Math.max(1000, Math.min(60000, Math.round((params.dodgeBeforeSec ?? 4) * 1000)));
  const cancelAfterMs = Math.max(500, Math.min(60000, Math.round((params.cancelAfterSec ?? 2) * 1000)));
  const sendTimeMs = params.enemyArrivalTimeMs - dodgeBeforeMs;
  const cancelTimeMs = params.enemyArrivalTimeMs + cancelAfterMs;
  const travelBeforeCancelMs = cancelTimeMs - sendTimeMs;
  const expectedReturnTimeMs = cancelTimeMs + travelBeforeCancelMs;
  const limitMs = (params.commandCancelLimitSec ?? 600) * 1000;
  const withinCancelWindow = travelBeforeCancelMs < limitMs - 5000;

  return {
    sendTimeMs,
    cancelTimeMs,
    dodgeBeforeMs,
    cancelAfterMs,
    travelBeforeCancelMs,
    expectedReturnTimeMs,
    withinCancelWindow,
  };
}

const SNIP_UNIT_LABELS: Record<TwUnitType, string> = {
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

const DEFAULT_SNIP_ALLOWED_UNITS: TwUnitType[] = [
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

const DEFAULT_UNSYNCED_SNIP_COMPOSITIONS: Partial<Record<TwUnitType, TroopCounts>> = {
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

function isNobleIncoming(inc: TwIncomingAttack): boolean {
  const text = `${inc.detectedUnit || ''} ${inc.label || ''}`.toLowerCase();
  return /nobre|snob|\bnt\b/.test(text);
}

/**
 * Wave 6 (Phase 21): Analyzes incoming attacks grouped by target village and
 * detects chronological gaps between consecutive hits for surgical Snip timing.
 */
export function detectSnipWindows(
  incomings: TwIncomingAttack[],
  options?: { maxGapMs?: number; safetyMarginMs?: number }
): SnipAttackGap[] {
  if (!Array.isArray(incomings) || incomings.length === 0) return [];

  const maxGapMs = Math.max(10, options?.maxGapMs ?? 60000);
  const defaultMarginMs = Math.max(1, options?.safetyMarginMs ?? 10);

  const grouped = new Map<string, TwIncomingAttack[]>();
  for (const inc of incomings) {
    if (!Number.isFinite(inc.arrivalTimeMs)) continue;
    const parsedTarget = parseCoords(inc.targetCoords);
    const cleanTarget = parsedTarget ? `${parsedTarget.x}|${parsedTarget.y}` : inc.targetCoords.trim();
    const key = `${inc.accountId}::${cleanTarget}`;
    const bucket = grouped.get(key) || [];
    bucket.push({ ...inc, targetCoords: cleanTarget });
    grouped.set(key, bucket);
  }

  const gaps: SnipAttackGap[] = [];
  for (const attacks of grouped.values()) {
    if (attacks.length < 2) continue;
    const sorted = [...attacks].sort((a, b) => {
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

  const priorityRank: Record<SnipAttackGap['priority'], number> = {
    critical_noble: 0,
    noble_train: 1,
    tight_gap: 2,
    standard: 3,
  };

  return gaps.sort((a, b) => {
    const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (rankDiff !== 0) return rankDiff;
    return a.firstAttackArrivalMs - b.firstAttackArrivalMs;
  });
}

function buildSnipTroopComposition(
  anchorUnit: TwUnitType,
  troops: TroopCounts | undefined,
  allowedSet: Set<TwUnitType>
): { suggestedTroops: TroopCounts; totalDefensivePop: number } | null {
  if (!troops) {
    if (anchorUnit === 'archer' && allowedSet.has('spear')) return null;
    if (anchorUnit === 'ram' && allowedSet.has('catapult')) return null;
    const preset = DEFAULT_UNSYNCED_SNIP_COMPOSITIONS[anchorUnit] || { [anchorUnit]: 100 };
    const suggestedTroops: TroopCounts = { ...preset };
    let totalDefensivePop = 0;
    for (const [u, qty] of Object.entries(suggestedTroops)) {
      const count = Number(qty) || 0;
      if (count > 0) {
        totalDefensivePop += count * (UNIT_POP_WEIGHT[u as TwUnitType] ?? 1);
      }
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

  const anchorSpeed = UNIT_SPEED_MIN_PER_FIELD[anchorUnit] ?? 18;
  // Insert anchorUnit first so detectSlowestUnitFromTroops resolves tie-speeds to anchorUnit
  const suggestedTroops: TroopCounts = {
    [anchorUnit]: anchorUnit === 'ram' ? 1 : anchorQty,
  };

  const compatiblePool: TwUnitType[] =
    anchorUnit === 'light' || anchorUnit === 'marcher'
      ? [anchorUnit, 'knight', 'spy']
      : ['knight', 'heavy', 'spear', 'archer', 'sword', 'spy'];

  for (const unit of compatiblePool) {
    if (unit === anchorUnit) continue;
    const unitQty = Number(troops[unit] ?? 0);
    if (unitQty <= 0) continue;
    if ((UNIT_SPEED_MIN_PER_FIELD[unit] ?? 999) <= anchorSpeed) {
      suggestedTroops[unit] = unitQty;
    }
  }

  let totalDefensivePop = 0;
  for (const [u, qty] of Object.entries(suggestedTroops)) {
    const count = Number(qty) || 0;
    if (count > 0) {
      totalDefensivePop += count * (UNIT_POP_WEIGHT[u as TwUnitType] ?? 1);
    }
  }

  return { suggestedTroops, totalDefensivePop };
}

/**
 * Wave 6 (Phase 22): Scans account villages (with optional group filter) and tests
 * each defensive anchor unit to find supports that can land inside [windowStartMs, windowEndMs]
 * with enough lead time to dispatch.
 */
export function findViableSnipSupports(params: {
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
  const targetParsed = parseCoords(params.targetCoords);
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
      : DEFAULT_SNIP_ALLOWED_UNITS;
  const allowedSet = new Set<TwUnitType>(allowedUnits);

  const normalizedGroup = (params.groupFilter || '').trim();
  const applyGroupFilter =
    normalizedGroup !== '' && normalizedGroup !== 'ALL' && normalizedGroup !== '0';

  const minDefensivePop = Math.max(0, params.minDefensivePop ?? 10);
  const minLeadTimeMs = params.minLeadTimeMs ?? 15000;
  const nowMs = params.nowMs ?? Date.now();
  const worldSpeed = params.worldSpeed ?? 1;
  const unitSpeed = params.unitSpeed ?? 1;

  const candidates: SnipSupportCandidate[] = [];

  for (const village of params.villages) {
    const vParsed = parseCoords(village.coords);
    if (!vParsed) continue;
    const cleanOriginCoords = `${vParsed.x}|${vParsed.y}`;
    if (cleanOriginCoords === cleanTargetCoords) continue;

    if (applyGroupFilter && (village.localCategory || '').trim() !== normalizedGroup) {
      continue;
    }

    const distance = Number(calculateDistance(cleanOriginCoords, cleanTargetCoords).toFixed(2));
    if (distance <= 0) continue;

    for (const anchorUnit of allowedUnits) {
      const comp = buildSnipTroopComposition(anchorUnit, village.troops, allowedSet);
      if (!comp || comp.totalDefensivePop < minDefensivePop) continue;

      const travelTimeMs = calculateTravelTimeMs(
        cleanOriginCoords,
        cleanTargetCoords,
        anchorUnit,
        worldSpeed,
        unitSpeed,
        params.unitSpeeds?.[anchorUnit]
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

/**
 * Wave 7 (Phase 24–26): Creates default Auto-Farm configuration for an account/village.
 */
export function createDefaultAutoFarmConfig(
  accountId: string,
  overrides?: Partial<AutoFarmConfig>
): AutoFarmConfig {
  const defaultId =
    overrides?.id ||
    (overrides?.originVillageId ? `${accountId}:${overrides.originVillageId}` : accountId);
  return {
    id: defaultId,
    accountId,
    name: overrides?.name,
    enabled: false,
    mode: 'fa',
    originVillageId: overrides?.originVillageId,
    originCoords: overrides?.originCoords,
    templateKey: 'a',
    templatePriorityOrder: overrides?.templatePriorityOrder || [overrides?.templateKey || 'a'],
    enableTemplateCFollowUp: overrides?.enableTemplateCFollowUp ?? false,
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
    ...overrides,
  };
}

function normalizeCoordKey(raw: string): string {
  const parsed = parseCoords(raw || '');
  return parsed ? `${parsed.x}|${parsed.y}` : (raw || '').trim();
}

export function getEffectiveTemplateOrder(
  config: Pick<AutoFarmConfig, 'templateKey' | 'templatePriorityOrder'>
): FarmTemplateKey[] {
  const raw = Array.isArray(config.templatePriorityOrder)
    ? config.templatePriorityOrder.filter((k): k is FarmTemplateKey => k === 'a' || k === 'b' || k === 'c')
    : [];
  if (raw.length > 0) return Array.from(new Set(raw));
  return [config.templateKey || 'a'];
}

function canTargetSendTemplate(target: FarmPlunderTarget, key: FarmTemplateKey): boolean {
  if (key === 'a') return target.canSendA;
  if (key === 'b') return target.canSendB;
  return target.canSendC;
}

/**
 * Wave 7: Filters Farm Assistant (#plunder_list) targets for a given phase
 * ('primary' using templatePriorityOrder, or 'template_c' using ['c']),
 * excluding already covered coordinates in the current sweep.
 */
export function filterPlunderTargetsForPhase(
  targets: FarmPlunderTarget[],
  config: Pick<
    AutoFarmConfig,
    'templateKey' | 'maxDistance' | 'allowYellowReports' | 'allowPartialLootOnly'
  > &
    Partial<
      Pick<
        AutoFarmConfig,
        'templatePriorityOrder' | 'restrictToMappedTargets' | 'mappedTargets'
      >
    >,
  phase: 'primary' | 'template_c' = 'primary',
  coveredCoords: Set<string> | string[] = []
): FarmPlunderTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const maxDist = Math.max(0.1, config.maxDistance || 20);

  const coveredSet =
    coveredCoords instanceof Set
      ? coveredCoords
      : new Set((coveredCoords || []).map((c) => normalizeCoordKey(c)));

  const allowedTemplates: FarmTemplateKey[] =
    phase === 'template_c' ? ['c'] : getEffectiveTemplateOrder(config);

  let allowedIds: Set<string> | null = null;
  let allowedCoords: Set<string> | null = null;
  if (config.restrictToMappedTargets) {
    const mapped = Array.isArray(config.mappedTargets) ? config.mappedTargets : [];
    if (mapped.length === 0) return [];
    allowedIds = new Set(mapped.map((m) => String(m.villageId)).filter(Boolean));
    allowedCoords = new Set(mapped.map((m) => normalizeCoordKey(m.coords)).filter(Boolean));
  }

  return targets
    .filter((t) => {
      if (!Number.isFinite(t.distance) || t.distance > maxDist) return false;
      if (t.lastReportStatus === 'red') return false;
      if (t.lastReportStatus === 'yellow' && !config.allowYellowReports) return false;
      if (config.allowPartialLootOnly && t.hasFullLoot === false) return false;

      const normCoord = normalizeCoordKey(t.coords);
      if (coveredSet.has(normCoord)) return false;

      if (allowedIds && allowedCoords) {
        const matchesId = t.villageId ? allowedIds.has(String(t.villageId)) : false;
        const matchesCoord = normCoord ? allowedCoords.has(normCoord) : false;
        if (!matchesId && !matchesCoord) return false;
      }

      return allowedTemplates.some((key) => canTargetSendTemplate(t, key));
    })
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Wave 7 (Phase 24): Filters Farm Assistant (#plunder_list) targets by distance,
 * mapped village whitelist (when restrictToMappedTargets is true), report safety status,
 * loot preference, and template A/B/C availability.
 */
export function filterPlunderTargets(
  targets: FarmPlunderTarget[],
  config: Pick<
    AutoFarmConfig,
    'templateKey' | 'maxDistance' | 'allowYellowReports' | 'allowPartialLootOnly'
  > &
    Partial<
      Pick<
        AutoFarmConfig,
        'templatePriorityOrder' | 'restrictToMappedTargets' | 'mappedTargets'
      >
    >
): FarmPlunderTarget[] {
  return filterPlunderTargetsForPhase(targets, config, 'primary');
}

/**
 * Wave 7: Detects target coordinates mapped in 2 or more Auto-Farm configs of the same account
 * so the UI can highlight overlapping farm targets across origin villages.
 */
export function findDuplicateFarmTargets(configs: AutoFarmConfig[]): FarmDuplicateSummary {
  const refsByCoord = new Map<string, Map<string, FarmDuplicateOriginRef>>();

  for (const cfg of configs) {
    const label = cfg.name || cfg.originCoords || 'Configuração';
    const ref: FarmDuplicateOriginRef = {
      configId: cfg.id,
      originVillageId: cfg.originVillageId,
      originCoords: cfg.originCoords,
      label,
    };

    const addCoord = (rawCoord: string) => {
      const coord = normalizeCoordKey(rawCoord);
      if (!coord || !parseCoords(coord)) return;
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

/**
 * Wave 7 (Phase 24): Computes a randomized humanized delay between minDelayMs and maxDelayMs.
 */
export function computeHumanizedDelayMs(
  minDelayMs: number,
  maxDelayMs: number,
  rng: () => number = Math.random
): number {
  const min = Math.max(100, Math.round(minDelayMs || 250));
  const max = Math.max(min, Math.round(maxDelayMs || 600));
  const r = Math.max(0, Math.min(0.999999, rng()));
  return min + Math.floor(r * (max - min + 1));
}

/**
 * Wave 7: Computes the next local timestamp (ms) for a daily "HH:MM" schedule.
 * If today's HH:MM has already passed (<= nowMs), schedules for tomorrow.
 */
export function computeNextDailyScheduleMs(
  timeHHMM: string,
  nowMs: number = Date.now()
): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((timeHHMM || '').trim());
  const rawHour = m ? Number(m[1]) : 8;
  const rawMin = m ? Number(m[2]) : 0;
  const hour = Number.isFinite(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 8;
  const minute = Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 59 ? rawMin : 0;

  const target = new Date(nowMs);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= nowMs) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/**
 * Wave 7 (Phase 25): Returns enabled player farm targets whose cooldown interval has elapsed.
 */
export function selectDuePlayerFarmTargets(
  targets: FarmPlayerRouteTarget[],
  nowMs: number = Date.now()
): FarmPlayerRouteTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return targets.filter((t) => {
    if (!t.enabled) return false;
    if (!parseCoords(t.coords)) return false;
    if (!t.lastAttackedAt) return true;
    const lastMs = new Date(t.lastAttackedAt).getTime();
    if (!Number.isFinite(lastMs)) return true;
    const intervalMs = Math.max(1, t.minIntervalMinutes || 15) * 60 * 1000;
    return nowMs - lastMs >= intervalMs;
  });
}

/**
 * Wave 7 (Phase 26): Evaluates safety stop conditions (CAPTCHA, incoming attacks,
 * minimum troop stock reserve, and daily request cap).
 */
export function evaluateFarmSafetyStop(params: {
  config: AutoFarmConfig;
  captchaDetected?: boolean;
  incomingsCount?: number;
  currentTroops?: TroopCounts;
  attacksToday?: number;
}): { shouldStop: boolean; reason?: FarmPauseReason; message?: string } {
  const { config } = params;

  if (config.pauseOnCaptcha && params.captchaDetected) {
    return {
      shouldStop: true,
      reason: 'captcha',
      message: 'CAPTCHA / verificação anti-bot detectada na sessão. Auto-Farm pausado.',
    };
  }

  if (
    config.pauseOnIncomings &&
    typeof params.incomingsCount === 'number' &&
    params.incomingsCount >= Math.max(1, config.maxIncomingsThreshold || 1)
  ) {
    return {
      shouldStop: true,
      reason: 'incomings',
      message: `${params.incomingsCount} ataque(s) a chegar detectado(s). Auto-Farm pausado por segurança.`,
    };
  }

  if (
    typeof params.attacksToday === 'number' &&
    config.dailyMaxAttacks > 0 &&
    params.attacksToday >= config.dailyMaxAttacks
  ) {
    return {
      shouldStop: true,
      reason: 'daily_limit',
      message: `Limite diário de ${config.dailyMaxAttacks} ataques atingido.`,
    };
  }

  if (config.pauseOnLowTroops && params.currentTroops) {
    const light = Number(params.currentTroops.light ?? 0);
    const spear = Number(params.currentTroops.spear ?? 0);
    const totalFarmUnits =
      light +
      spear +
      Number(params.currentTroops.axe ?? 0) +
      Number(params.currentTroops.sword ?? 0) +
      Number(params.currentTroops.marcher ?? 0) +
      Number(params.currentTroops.heavy ?? 0);

    if (
      totalFarmUnits <= 0 ||
      (config.minReserveLight > 0 && light <= config.minReserveLight && spear <= config.minReserveSpear) ||
      (config.minReserveSpear > 0 && spear <= config.minReserveSpear && light <= config.minReserveLight)
    ) {
      return {
        shouldStop: true,
        reason: 'low_troops',
        message: 'Estoque de tropas insuficiente ou abaixo da reserva mínima configurada.',
      };
    }
  }

  return { shouldStop: false };
}

export interface DataStoreOptions {
  cipher?: SecretCipher;
  onLog?: (entry: ActivityLogEntry) => void;
}

export class DataStore {
  private readonly filePath: string;
  private readonly cipher: SecretCipher;
  private readonly onLog?: (entry: ActivityLogEntry) => void;
  private data: StoreSchema;

  constructor(storageDir: string, options: DataStoreOptions = {}) {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    this.filePath = path.join(storageDir, 'tw-store.json');
    this.cipher = options.cipher ?? NOOP_SECRET_CIPHER;
    this.onLog = options.onLog;
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoreSchema {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<StoreSchema>;
        const schema: StoreSchema = {
          accounts: Array.isArray(parsed.accounts)
            ? parsed.accounts.map((a) => ({ ...a, status: 'offline' as const }))
            : [],
          proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
          scheduledCommands: Array.isArray(parsed.scheduledCommands)
            ? parsed.scheduledCommands
            : [],
          constructionModels:
            Array.isArray(parsed.constructionModels) && parsed.constructionModels.length > 0
              ? parsed.constructionModels
              : [...DEFAULT_CONSTRUCTION_MODELS],
          recruitmentModels:
            Array.isArray(parsed.recruitmentModels) && parsed.recruitmentModels.length > 0
              ? parsed.recruitmentModels
              : [...DEFAULT_RECRUITMENT_MODELS],
          worldConfigs:
            parsed.worldConfigs && typeof parsed.worldConfigs === 'object'
              ? parsed.worldConfigs
              : {},
          autoFarmConfigs: (() => {
            const rawMap =
              parsed.autoFarmConfigs && typeof parsed.autoFarmConfigs === 'object'
                ? parsed.autoFarmConfigs
                : {};
            const normalized: Record<string, AutoFarmConfig> = {};
            for (const [key, val] of Object.entries(rawMap)) {
              if (!val || typeof val !== 'object') continue;
              const cfgId = val.id || key;
              normalized[cfgId] = {
                ...createDefaultAutoFarmConfig(val.accountId || key, { id: cfgId }),
                ...val,
                id: cfgId,
                restrictToMappedTargets: Boolean(val.restrictToMappedTargets),
                mappedTargets: Array.isArray(val.mappedTargets) ? val.mappedTargets : [],
                playerTargets: Array.isArray(val.playerTargets) ? val.playerTargets : [],
              };
            }
            return normalized;
          })(),
          logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 500) : [],
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        };
        return decryptStoreSecrets(schema, this.cipher);
      }
    } catch {
      // Fallback to clean defaults on corrupt JSON
    }
    return {
      accounts: [],
      proxies: [],
      scheduledCommands: [],
      constructionModels: [...DEFAULT_CONSTRUCTION_MODELS],
      recruitmentModels: [...DEFAULT_RECRUITMENT_MODELS],
      worldConfigs: {},
      autoFarmConfigs: {},
      logs: [],
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  public saveNow(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payloadToPersist = encryptStoreSecrets(this.data, this.cipher);
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payloadToPersist, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  public getAccounts(): TwAccount[] {
    return this.data.accounts;
  }

  public getAccountById(id: string): TwAccount | null {
    return this.data.accounts.find((a) => a._id === id) ?? null;
  }

  public createAccount(input: Partial<TwAccount>): TwAccount {
    const now = new Date().toISOString();
    const domain = (input.domain || this.data.settings.defaultDomain || 'tribalwars.com.br').trim();
    const world = (input.world || this.data.settings.defaultWorld || 'br130').trim();
    const serverUrl = input.serverUrl?.trim() || `https://${world}.${domain}`;
    const account: TwAccount = {
      _id: input._id || crypto.randomUUID(),
      username: (input.username || 'Nova Conta').trim(),
      domain,
      world,
      serverUrl,
      group: input.group || 'Geral',
      notes: input.notes || '',
      credentials: input.credentials || { username: input.username || '', password: '', autoLogin: false },
      proxy: input.proxy,
      cookies: input.cookies || [],
      fingerprint: input.fingerprint || generateFingerprint(),
      status: 'offline',
      playerInfo: input.playerInfo || {
        points: 0,
        rank: 0,
        villagesCount: 1,
        wood: 0,
        stone: 0,
        iron: 0,
        incomings: 0,
      },
      villages: input.villages || [],
      incomingsList: input.incomingsList || [],
      constructionModelId: input.constructionModelId,
      recruitmentModelId: input.recruitmentModelId,
      createdAt: now,
      updatedAt: now,
    };
    this.data.accounts.push(account);
    this.addLog({
      accountId: account._id,
      accountName: account.username,
      level: 'info',
      message: `Conta "${account.username}" (${account.world}.${account.domain}) cadastrada.`,
    });
    this.saveNow();
    return account;
  }

  public updateAccount(id: string, patch: Partial<TwAccount>): TwAccount | null {
    const idx = this.data.accounts.findIndex((a) => a._id === id);
    if (idx === -1) return null;
    const current = this.data.accounts[idx];
    const domain = (patch.domain ?? current.domain).trim();
    const world = (patch.world ?? current.world).trim();
    const serverUrl =
      patch.serverUrl !== undefined
        ? patch.serverUrl
        : patch.domain || patch.world
          ? `https://${world}.${domain}`
          : current.serverUrl;
    const updated: TwAccount = {
      ...current,
      ...patch,
      _id: id,
      domain,
      world,
      serverUrl,
      updatedAt: new Date().toISOString(),
    };
    this.data.accounts[idx] = updated;
    this.saveNow();
    return updated;
  }

  public deleteAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a._id === id);
    if (idx === -1) return false;
    const removed = this.data.accounts[idx];
    this.data.accounts.splice(idx, 1);
    this.data.scheduledCommands = this.data.scheduledCommands.filter((c) => c.accountId !== id);
    if (this.data.autoFarmConfigs) {
      for (const [key, cfg] of Object.entries(this.data.autoFarmConfigs)) {
        if (cfg.accountId === id || key === id) {
          delete this.data.autoFarmConfigs[key];
        }
      }
    }
    this.addLog({
      accountId: id,
      accountName: removed.username,
      level: 'warn',
      message: `Conta "${removed.username}" removida.`,
    });
    this.saveNow();
    return true;
  }

  public setAccountVillages(accountId: string, villages: TwVillage[]): TwVillage[] {
    const existingAccount = this.getAccountById(accountId);
    const existingById = new Map<string, TwVillage>();
    for (const ev of existingAccount?.villages || []) {
      existingById.set(ev.id, ev);
      existingById.set(ev.coords, ev);
    }

    const mergedVillages: TwVillage[] = villages.map((v) => {
      const prev = existingById.get(v.id) || existingById.get(v.coords);
      if (!prev) return v;
      return {
        ...v,
        localCategory: v.localCategory ?? prev.localCategory,
        troops: v.troops ?? prev.troops,
      };
    });

    this.updateAccount(accountId, {
      villages: mergedVillages,
      playerInfo: {
        ...existingAccount?.playerInfo,
        villagesCount: mergedVillages.length || 1,
      },
    });
    return mergedVillages;
  }

  public setAccountVillageGroups(
    accountId: string,
    villageGroups: TwVillageGroup[]
  ): TwVillageGroup[] {
    this.updateAccount(accountId, { villageGroups });
    return villageGroups;
  }

  public setAccountIncomings(accountId: string, incomingsList: TwIncomingAttack[]): TwIncomingAttack[] {
    this.updateAccount(accountId, {
      incomingsList,
      playerInfo: {
        ...this.getAccountById(accountId)?.playerInfo,
        incomings: incomingsList.length,
      },
    });
    return incomingsList;
  }

  public getWorldConfig(domain: string, world: string): TwWorldConfig | null {
    const key = `${domain.trim().toLowerCase()}:${world.trim().toLowerCase()}`;
    return this.data.worldConfigs[key] ?? null;
  }

  public saveWorldConfig(config: TwWorldConfig, accountId?: string): TwWorldConfig {
    const key = `${config.domain.trim().toLowerCase()}:${config.world.trim().toLowerCase()}`;
    const normalized: TwWorldConfig = {
      ...config,
      worldKey: key,
    };
    this.data.worldConfigs[key] = normalized;
    if (accountId) {
      this.updateAccount(accountId, { worldConfig: normalized });
    }
    this.saveNow();
    return normalized;
  }

  // Scheduled Commands CRUD
  public getScheduledCommands(accountId?: string): ScheduledCommand[] {
    if (!accountId) return this.data.scheduledCommands;
    return this.data.scheduledCommands.filter((c) => c.accountId === accountId);
  }

  private buildScheduledCommandRecord(
    input: Omit<
      ScheduledCommand,
      'id' | 'distance' | 'travelTimeMs' | 'sendTimeMs' | 'arrivalTimeMs' | 'createdAt' | 'status'
    > & {
      arrivalTimeMs?: number;
      sendTimeMs?: number;
      timingMode?: 'arrival' | 'send';
      worldSpeed?: number;
      unitSpeed?: number;
      status?: ScheduledCommand['status'];
    }
  ): ScheduledCommand {
    const acc = this.getAccountById(input.accountId);
    const cachedWorld = acc ? acc.worldConfig || this.getWorldConfig(acc.domain, acc.world) : null;
    const effectiveWorldSpeed = input.worldSpeed ?? cachedWorld?.speed ?? 1;
    const effectiveUnitSpeed = input.unitSpeed ?? cachedWorld?.unitSpeed ?? 1;

    // Auto-detect slowest unit from troops if any troop has count > 0; otherwise keep input.slowestUnit
    const detectedSlowest = detectSlowestUnitFromTroops(input.troops);
    const resolvedSlowestUnit = detectedSlowest || input.slowestUnit;
    const unitSpeedOverride = cachedWorld?.unitSpeeds?.[resolvedSlowestUnit];

    const distance = Number(calculateDistance(input.originCoords, input.targetCoords).toFixed(2));
    const travelTimeMs = calculateTravelTimeMs(
      input.originCoords,
      input.targetCoords,
      resolvedSlowestUnit,
      effectiveWorldSpeed,
      effectiveUnitSpeed,
      unitSpeedOverride
    );

    const isSendMode =
      input.timingMode === 'send' ||
      (typeof input.sendTimeMs === 'number' && !input.arrivalTimeMs);

    let resolvedSendTimeMs: number;
    let resolvedArrivalTimeMs: number;
    if (isSendMode) {
      if (typeof input.sendTimeMs !== 'number' || !Number.isFinite(input.sendTimeMs)) {
        throw new Error('Horário de envio (sendTimeMs) inválido.');
      }
      resolvedSendTimeMs = input.sendTimeMs;
      resolvedArrivalTimeMs = resolvedSendTimeMs + travelTimeMs;
    } else {
      if (typeof input.arrivalTimeMs !== 'number' || !Number.isFinite(input.arrivalTimeMs)) {
        throw new Error('Horário de chegada (arrivalTimeMs) inválido.');
      }
      resolvedArrivalTimeMs = input.arrivalTimeMs;
      resolvedSendTimeMs = resolvedArrivalTimeMs - travelTimeMs;
    }

    return {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      accountName: input.accountName,
      originVillageId: input.originVillageId,
      originCoords: input.originCoords.trim(),
      targetCoords: input.targetCoords.trim(),
      commandType: input.commandType,
      presetName: input.presetName,
      slowestUnit: resolvedSlowestUnit,
      troops: input.troops || {},
      waves: input.waves || 1,
      allWavesTroops:
        input.allWavesTroops && input.allWavesTroops.length > 0
          ? input.allWavesTroops
          : Array.from({ length: input.waves || 1 }, () => ({ ...(input.troops || {}) })),
      distance,
      travelTimeMs,
      sendTimeMs: resolvedSendTimeMs,
      arrivalTimeMs: resolvedArrivalTimeMs,
      triggerBeforeMs: Math.max(20000, Math.min(90000, input.triggerBeforeMs || 30000)),
      status: input.status || 'scheduled',
      autoDodge: input.autoDodge,
      notes: input.notes,
      createdAt: new Date().toISOString(),
    };
  }

  public createScheduledCommand(
    input: Parameters<DataStore['buildScheduledCommandRecord']>[0]
  ): ScheduledCommand {
    const cmd = this.buildScheduledCommandRecord(input);
    this.data.scheduledCommands.push(cmd);
    this.data.scheduledCommands.sort((a, b) => a.sendTimeMs - b.sendTimeMs);
    this.addLog({
      accountId: cmd.accountId,
      accountName: cmd.accountName,
      level: 'info',
      message: `Comando agendado (${cmd.commandType.toUpperCase()}): ${cmd.originCoords} -> ${cmd.targetCoords} | Envio: ${new Date(cmd.sendTimeMs).toLocaleTimeString('pt-BR')}`,
    });
    this.saveNow();
    return cmd;
  }

  public createBatchScheduledCommands(
    inputs: Array<Parameters<DataStore['buildScheduledCommandRecord']>[0]>
  ): ScheduledCommand[] {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const created = inputs.map((item) => this.buildScheduledCommandRecord(item));
    this.data.scheduledCommands.push(...created);
    this.data.scheduledCommands.sort((a, b) => a.sendTimeMs - b.sendTimeMs);
    const first = created[0];
    this.addLog({
      accountId: first.accountId,
      accountName: first.accountName,
      level: 'success',
      message: `[Planejador OP] ${created.length} comando(s) agendado(s) em lote para envio automático.`,
    });
    this.saveNow();
    return created;
  }

  public createDodgeCommand(params: {
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
  }): ScheduledCommand {
    const acc = this.getAccountById(params.accountId);
    const originParsed = parseCoords(params.originCoords) || { x: 500, y: 500 };
    const cleanOriginCoords = `${originParsed.x}|${originParsed.y}`;

    const originVillage = (acc?.villages || []).find(
      (v) =>
        (params.originVillageId && v.id === params.originVillageId) ||
        v.coords.trim() === cleanOriginCoords
    );

    const parsedOverrideTarget = params.targetCoords ? parseCoords(params.targetCoords) : null;
    const nearestFriendly = findNearestFriendlyVillage(cleanOriginCoords, acc?.villages || []);
    const resolvedTargetCoords = parsedOverrideTarget
      ? `${parsedOverrideTarget.x}|${parsedOverrideTarget.y}`
      : nearestFriendly
        ? nearestFriendly.coords
        : `${Math.min(999, originParsed.x + 1)}|${originParsed.y}`;

    const timing = calculateAutoDodgeTiming({
      enemyArrivalTimeMs: params.enemyArrivalTimeMs,
      dodgeBeforeSec: params.dodgeBeforeSec,
      cancelAfterSec: params.cancelAfterSec,
      commandCancelLimitSec: acc?.worldConfig?.commandCancelSec,
    });

    return this.createScheduledCommand({
      accountId: params.accountId,
      accountName: params.accountName || acc?.username || 'Conta',
      originVillageId: params.originVillageId || originVillage?.id,
      originCoords: cleanOriginCoords,
      targetCoords: resolvedTargetCoords,
      commandType: 'support',
      presetName: 'Auto-Dodge (Evasão + Cancelamento)',
      slowestUnit: 'spear',
      troops: params.troops || {},
      waves: 1,
      timingMode: 'send',
      sendTimeMs: timing.sendTimeMs,
      triggerBeforeMs: params.triggerBeforeMs ?? 30000,
      notes:
        params.notes ||
        (params.attackerName ? `Auto-Dodge vs ${params.attackerName}` : 'Auto-Dodge'),
      autoDodge: {
        enabled: true,
        incomingCommandId: params.incomingCommandId,
        attackerName: params.attackerName,
        enemyArrivalTimeMs: params.enemyArrivalTimeMs,
        dodgeBeforeMs: timing.dodgeBeforeMs,
        cancelAfterMs: timing.cancelAfterMs,
        cancelTimeMs: timing.cancelTimeMs,
        expectedReturnTimeMs: timing.expectedReturnTimeMs,
        sendAllTroops: params.sendAllTroops ?? true,
        cancelStatus: 'pending',
      },
    });
  }

  public updateScheduledCommand(
    id: string,
    patch: Partial<ScheduledCommand>
  ): ScheduledCommand | null {
    const idx = this.data.scheduledCommands.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    this.data.scheduledCommands[idx] = {
      ...this.data.scheduledCommands[idx],
      ...patch,
      id,
    };
    this.saveNow();
    return this.data.scheduledCommands[idx];
  }

  public deleteScheduledCommand(id: string): boolean {
    const idx = this.data.scheduledCommands.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.data.scheduledCommands.splice(idx, 1);
    this.saveNow();
    return true;
  }

  public clearScheduledCommands(accountId?: string): void {
    if (accountId) {
      this.data.scheduledCommands = this.data.scheduledCommands.filter(
        (c) => c.accountId !== accountId
      );
    } else {
      this.data.scheduledCommands = [];
    }
    this.saveNow();
  }

  // Construction & Recruitment Models CRUD
  public getConstructionModels(): ConstructionModel[] {
    return this.data.constructionModels;
  }

  public saveConstructionModel(
    model: Partial<ConstructionModel> & { name: string }
  ): ConstructionModel {
    const item: ConstructionModel = {
      id: model.id || crypto.randomUUID(),
      name: model.name.trim(),
      description: model.description || '',
      steps: Array.isArray(model.steps) ? model.steps : [],
      createdAt: model.createdAt || new Date().toISOString(),
    };
    const idx = this.data.constructionModels.findIndex((m) => m.id === item.id);
    if (idx >= 0) {
      this.data.constructionModels[idx] = item;
    } else {
      this.data.constructionModels.push(item);
    }
    this.saveNow();
    return item;
  }

  public deleteConstructionModel(id: string): boolean {
    const idx = this.data.constructionModels.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.data.constructionModels.splice(idx, 1);
    this.saveNow();
    return true;
  }

  public getRecruitmentModels(): RecruitmentModel[] {
    return this.data.recruitmentModels;
  }

  public saveRecruitmentModel(
    model: Partial<RecruitmentModel> & { name: string }
  ): RecruitmentModel {
    const item: RecruitmentModel = {
      id: model.id || crypto.randomUUID(),
      name: model.name.trim(),
      category: model.category || 'offensive',
      description: model.description || '',
      troops: model.troops || {},
      createdAt: model.createdAt || new Date().toISOString(),
    };
    const idx = this.data.recruitmentModels.findIndex((m) => m.id === item.id);
    if (idx >= 0) {
      this.data.recruitmentModels[idx] = item;
    } else {
      this.data.recruitmentModels.push(item);
    }
    this.saveNow();
    return item;
  }

  public deleteRecruitmentModel(id: string): boolean {
    const idx = this.data.recruitmentModels.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.data.recruitmentModels.splice(idx, 1);
    this.saveNow();
    return true;
  }

  public getProxies(): ProxyConfig[] {
    return this.data.proxies;
  }

  public saveProxy(proxy: ProxyConfig): ProxyConfig {
    const item: ProxyConfig = {
      ...proxy,
      id: proxy.id || crypto.randomUUID(),
    };
    const idx = this.data.proxies.findIndex((p) => p.id === item.id);
    if (idx >= 0) {
      this.data.proxies[idx] = item;
    } else {
      this.data.proxies.push(item);
    }
    this.saveNow();
    return item;
  }

  public deleteProxy(id: string): boolean {
    const idx = this.data.proxies.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.data.proxies.splice(idx, 1);
    this.saveNow();
    return true;
  }

  public getSettings(): AppSettings {
    return this.data.settings;
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.saveNow();
    return this.data.settings;
  }

  public getLogs(): ActivityLogEntry[] {
    return this.data.logs;
  }

  public addLog(entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>): ActivityLogEntry {
    const record: ActivityLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.data.logs.unshift(record);
    if (this.data.logs.length > 500) {
      this.data.logs.length = 500;
    }
    this.onLog?.(record);
    this.saveNow();
    return record;
  }

  public clearLogs(): void {
    this.data.logs = [];
    this.saveNow();
  }

  // Wave 7: Auto-Farm Config Persistence (per-village / per-configId)
  public getAllAutoFarmConfigs(): Record<string, AutoFarmConfig> {
    if (!this.data.autoFarmConfigs) {
      this.data.autoFarmConfigs = {};
    }
    return this.data.autoFarmConfigs;
  }

  public getAutoFarmConfigsByAccount(accountId: string): AutoFarmConfig[] {
    return Object.values(this.getAllAutoFarmConfigs()).filter(
      (c) => c.accountId === accountId
    );
  }

  public getAutoFarmConfigById(configId: string): AutoFarmConfig | null {
    const all = this.getAllAutoFarmConfigs();
    return all[configId] ?? null;
  }

  public getAutoFarmConfig(accountIdOrConfigId: string): AutoFarmConfig {
    const all = this.getAllAutoFarmConfigs();
    if (all[accountIdOrConfigId]) {
      return all[accountIdOrConfigId];
    }
    const existingForAcc = Object.values(all).find(
      (c) => c.accountId === accountIdOrConfigId
    );
    if (existingForAcc) {
      return existingForAcc;
    }
    all[accountIdOrConfigId] = createDefaultAutoFarmConfig(accountIdOrConfigId, {
      id: accountIdOrConfigId,
    });
    return all[accountIdOrConfigId];
  }

  public saveAutoFarmConfig(
    patch: Partial<AutoFarmConfig> & { accountId: string }
  ): AutoFarmConfig {
    const all = this.getAllAutoFarmConfigs();
    const resolvedId =
      patch.id ||
      (patch.originVillageId
        ? `${patch.accountId}:${patch.originVillageId}`
        : patch.accountId);
    const current =
      all[resolvedId] ||
      createDefaultAutoFarmConfig(patch.accountId, {
        id: resolvedId,
        originVillageId: patch.originVillageId,
        originCoords: patch.originCoords,
      });
    const updated: AutoFarmConfig = {
      ...current,
      ...patch,
      id: resolvedId,
      accountId: patch.accountId,
      restrictToMappedTargets:
        patch.restrictToMappedTargets ?? current.restrictToMappedTargets ?? false,
      mappedTargets: Array.isArray(patch.mappedTargets)
        ? patch.mappedTargets
        : current.mappedTargets || [],
      playerTargets: Array.isArray(patch.playerTargets)
        ? patch.playerTargets
        : current.playerTargets || [],
      updatedAt: new Date().toISOString(),
    };
    all[resolvedId] = updated;
    this.saveNow();
    return updated;
  }

  public deleteAutoFarmConfig(configId: string): boolean {
    const all = this.getAllAutoFarmConfigs();
    if (!all[configId]) return false;
    delete all[configId];
    this.saveNow();
    return true;
  }

  public markPlayerFarmTargetAttacked(
    configIdOrAccountId: string,
    targetId: string,
    attackedAtIso: string = new Date().toISOString()
  ): void {
    const cfg = this.getAutoFarmConfig(configIdOrAccountId);
    const idx = cfg.playerTargets.findIndex((t) => t.id === targetId);
    if (idx === -1) return;
    cfg.playerTargets[idx] = {
      ...cfg.playerTargets[idx],
      lastAttackedAt: attackedAtIso,
    };
    cfg.updatedAt = attackedAtIso;
    this.saveNow();
  }
}
