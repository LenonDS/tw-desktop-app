export interface ProxyConfig {
  id?: string;
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  label?: string;
  lastStatus?: 'ok' | 'error' | 'untested';
  lastIp?: string;
  latencyMs?: number;
}

export interface TwCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface TwFingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
}

export interface TwPlayerInfo {
  points?: number;
  rank?: number;
  villagesCount?: number;
  tribe?: string;
  wood?: number;
  stone?: number;
  iron?: number;
  incomings?: number;
}

export type SessionStatus = 'offline' | 'starting' | 'running' | 'error' | 'session_expired';

export interface TwVillageGroup {
  id: string;
  name: string;
  isLocal?: boolean;
}

export interface TwVillage {
  id: string;
  name: string;
  coords: string; // "500|500"
  x: number;
  y: number;
  points: number;
  wood: number;
  stone: number;
  iron: number;
  storage: number;
  pop: number;
  popMax: number;
  troops?: TroopCounts;
  localCategory?: string;
  updatedAt: string;
}

export interface TwTargetPlayer {
  id: string;
  name: string;
  allyId?: string;
  villagesCount: number;
  points: number;
  rank: number;
}

export interface TwTargetVillage {
  id: string;
  name: string;
  coords: string;
  x: number;
  y: number;
  points: number;
  continent: string;
  playerId: string;
  playerName: string;
}

export interface AttackPlanItem {
  id: string;
  originVillageId: string;
  originVillageName: string;
  originCoords: string;
  targetCoords: string;
  targetVillageName?: string;
  targetPlayerName?: string;
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves: number;
  allWavesTroops?: TroopCounts[];
  distance: number;
  travelTimeMs: number;
  sendTimeMs: number;
  arrivalTimeMs: number;
  timingMode?: 'arrival' | 'send';
  notes?: string;
}

export type TwUnitType =
  | 'spear'
  | 'sword'
  | 'axe'
  | 'archer'
  | 'spy'
  | 'light'
  | 'marcher'
  | 'heavy'
  | 'ram'
  | 'catapult'
  | 'knight'
  | 'snob';

export type TroopCounts = Partial<Record<TwUnitType, number>>;

export interface TwWorldConfig {
  worldKey: string; // "${domain}:${world}"
  domain: string;
  world: string;
  speed: number;
  unitSpeed: number;
  archer: boolean;
  paladin: boolean;
  church: boolean;
  watchtower: boolean;
  moral: boolean;
  commandCancelSec?: number;
  attackGapMs?: number;
  fakeLimitPct?: number;
  unitSpeeds: Partial<Record<TwUnitType, number>>; // real minutes per field in this world
  fetchedAt: string;
}

export interface TroopModelPreset {
  id: string;
  presetId?: string;
  name: string;
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  isPreset?: boolean;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves?: number;
  allWavesTroops?: TroopCounts[];
}

export type ScheduledCommandStatus =
  | 'pending'
  | 'scheduled'
  | 'waking'
  | 'sent'
  | 'dodging'
  | 'dodged'
  | 'failed'
  | 'cancelled';

export interface AutoDodgeConfig {
  enabled: boolean;
  incomingCommandId?: string;
  attackerName?: string;
  enemyArrivalTimeMs: number;
  dodgeBeforeMs: number;
  cancelAfterMs: number;
  cancelTimeMs: number;
  expectedReturnTimeMs: number;
  sendAllTroops?: boolean;
  outgoingCommandId?: string;
  cancelStatus?: 'pending' | 'cancelling' | 'cancelled_ok' | 'cancel_failed';
  cancelError?: string;
  cancelledAt?: string;
}

export interface ScheduledCommand {
  id: string;
  accountId: string;
  accountName: string;
  originVillageId?: string;
  originCoords: string; // "500|500"
  targetCoords: string; // "505|502"
  commandType: 'attack' | 'support' | 'noble4' | 'fake';
  presetName?: string;
  slowestUnit: TwUnitType;
  troops: TroopCounts;
  waves: number;
  allWavesTroops?: TroopCounts[];
  distance: number;
  travelTimeMs: number;
  sendTimeMs: number;
  arrivalTimeMs: number;
  triggerBeforeMs: number;
  status: ScheduledCommandStatus;
  autoDodge?: AutoDodgeConfig;
  notes?: string;
  error?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface TwIncomingAttack {
  id: string;
  accountId: string;
  accountName: string;
  commandId: string;
  originName: string;
  originCoords: string;
  targetName: string;
  targetCoords: string;
  attackerName: string;
  arrivalTimeMs: number;
  remainingSec: number;
  distance: number;
  detectedUnit: string;
  label: string;
  updatedAt: string;
}

export interface SnipAttackGap {
  id: string;
  accountId: string;
  accountName: string;
  targetCoords: string;
  targetName: string;
  firstAttackId: string;
  firstAttackLabel: string;
  firstAttackUnit: string;
  firstAttackArrivalMs: number;
  secondAttackId: string;
  secondAttackLabel: string;
  secondAttackUnit: string;
  secondAttackArrivalMs: number;
  gapMs: number;
  windowStartMs: number;
  windowEndMs: number;
  recommendedArrivalMs: number;
  priority: 'critical_noble' | 'noble_train' | 'tight_gap' | 'standard';
}

export interface SnipSupportCandidate {
  id: string;
  accountId: string;
  accountName: string;
  originVillageId: string;
  originVillageName: string;
  originCoords: string;
  originGroup?: string;
  targetCoords: string;
  slowestUnit: TwUnitType;
  unitLabel: string;
  distance: number;
  travelTimeMs: number;
  sendTimeMs: number;
  arrivalTimeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  leadTimeMs: number;
  availableTroops: TroopCounts;
  suggestedTroops: TroopCounts;
  totalDefensivePop: number;
}

export interface ConstructionStep {
  building:
    | 'main'
    | 'barracks'
    | 'stable'
    | 'garage'
    | 'snob'
    | 'smith'
    | 'place'
    | 'statue'
    | 'market'
    | 'wood'
    | 'stone'
    | 'iron'
    | 'farm'
    | 'storage'
    | 'hide'
    | 'wall';
  level: number;
}

export interface ConstructionModel {
  id: string;
  name: string;
  description: string;
  steps: ConstructionStep[];
  createdAt: string;
}

export interface RecruitmentModel {
  id: string;
  name: string;
  category: 'offensive' | 'defensive' | 'scout' | 'hybrid';
  description: string;
  troops: TroopCounts;
  createdAt: string;
}

export interface TwAccount {
  _id: string;
  username: string;
  domain: string;
  world: string;
  serverUrl?: string;
  group?: string;
  notes?: string;
  credentials?: {
    username?: string;
    password?: string;
    autoLogin?: boolean;
  };
  proxy?: ProxyConfig;
  cookies?: TwCookie[];
  fingerprint?: TwFingerprint;
  status: SessionStatus;
  lastError?: string;
  playerInfo?: TwPlayerInfo;
  villages?: TwVillage[];
  villageGroups?: TwVillageGroup[];
  incomingsList?: TwIncomingAttack[];
  worldConfig?: TwWorldConfig;
  constructionModelId?: string;
  recruitmentModelId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogEntry {
  id: string;
  accountId?: string;
  accountName?: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface AppSettings {
  defaultDomain: string;
  defaultWorld: string;
  autoRestoreSessions: boolean;
  userAgentOverride?: string;
  theme: 'dark' | 'slate';
}

export type FarmTemplateKey = 'a' | 'b' | 'c';

export type FarmTargetStatus = 'green' | 'yellow' | 'red' | 'blue' | 'unknown';

export interface FarmPlunderTarget {
  villageId: string;
  coords: string;
  name: string;
  distance: number;
  wallLevel?: number;
  lastReportStatus: FarmTargetStatus;
  hasFullLoot?: boolean;
  canSendA: boolean;
  canSendB: boolean;
  canSendC: boolean;
}

export interface FarmPlayerRouteTarget {
  id: string;
  coords: string;
  villageName?: string;
  playerName?: string;
  troops: TroopCounts;
  minIntervalMinutes: number;
  lastAttackedAt?: string;
  enabled: boolean;
}

export interface AutoFarmConfig {
  id: string;
  accountId: string;
  name?: string;
  enabled: boolean;
  mode: 'fa' | 'players' | 'both';
  originVillageId?: string;
  originCoords?: string;
  templateKey: FarmTemplateKey;
  templatePriorityOrder?: FarmTemplateKey[];
  enableTemplateCFollowUp?: boolean;
  maxDistance: number;
  allowYellowReports: boolean;
  allowPartialLootOnly: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  cycleIntervalSec: number;
  dailyMaxAttacks: number;
  pauseOnLowTroops: boolean;
  minReserveLight: number;
  minReserveSpear: number;
  pauseOnIncomings: boolean;
  maxIncomingsThreshold: number;
  pauseOnCaptcha: boolean;
  dailyScheduleEnabled?: boolean;
  dailyScheduleTime?: string;
  restrictToMappedTargets: boolean;
  mappedTargets: FarmPlunderTarget[];
  playerTargets: FarmPlayerRouteTarget[];
  updatedAt: string;
}

export interface FarmDuplicateOriginRef {
  configId: string;
  originVillageId?: string;
  originCoords?: string;
  label: string;
}

export interface FarmDuplicateSummary {
  duplicatesByCoord: Record<string, FarmDuplicateOriginRef[]>;
  duplicateCountByConfigId: Record<string, number>;
}

export type FarmPauseReason =
  | 'captcha'
  | 'low_troops'
  | 'incomings'
  | 'daily_limit'
  | 'manual'
  | 'session_offline';

export interface AutoFarmRuntimeState {
  configId: string;
  accountId: string;
  running: boolean;
  pausedReason?: FarmPauseReason;
  waitingForTroops?: boolean;
  farmPhase?: 'primary' | 'template_c';
  coveredTargetCoords?: string[];
  attacksToday: number;
  attacksThisCycle: number;
  lastRunAt?: string;
  nextRunAt?: string;
  nextDailyRunAt?: string;
  lastError?: string;
  currentTroops?: TroopCounts;
  lastTargetsCount?: number;
  lastTargets?: FarmPlunderTarget[];
}

export interface StoreSchema {
  accounts: TwAccount[];
  proxies: ProxyConfig[];
  scheduledCommands: ScheduledCommand[];
  constructionModels: ConstructionModel[];
  recruitmentModels: RecruitmentModel[];
  worldConfigs: Record<string, TwWorldConfig>;
  autoFarmConfigs?: Record<string, AutoFarmConfig>;
  logs: ActivityLogEntry[];
  settings: AppSettings;
}
