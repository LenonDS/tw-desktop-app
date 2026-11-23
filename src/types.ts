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
  coords: string;
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
  worldKey: string;
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
  unitSpeeds: Partial<Record<TwUnitType, number>>;
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
  originCoords: string;
  targetCoords: string;
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

export interface ElectronBridgeAPI {
  browser: {
    startSession: (payload: { accountId: string; visible?: boolean; targetUrl?: string }) => Promise<{
      success: boolean;
      status: SessionStatus;
      error?: string;
    }>;
    stopSession: (accountId: string) => Promise<{ success: boolean }>;
    restartSession: (accountId: string) => Promise<{ success: boolean; status: SessionStatus }>;
    openVisible: (payload: { accountId: string; pagina?: string; newWindow?: boolean }) => Promise<{
      success: boolean;
      status: SessionStatus;
      error?: string;
    }>;
    openNewWindow: (payload: { accountId: string; targetUrl?: string }) => Promise<{
      success: boolean;
      status: SessionStatus;
      error?: string;
    }>;
    bringToFront: (accountId: string) => Promise<{ success: boolean }>;
    reloadPage: (accountId: string) => Promise<{ success: boolean }>;
    exportCookies: (accountId: string) => Promise<{ success: boolean; cookies: TwCookie[] }>;
    getStatus: (accountId: string) => Promise<{ status: SessionStatus; visible: boolean; error?: string }>;
    getAllStatuses: () => Promise<Record<string, { status: SessionStatus; visible: boolean; error?: string }>>;
    onStatusChange: (
      callback: (
        event: unknown,
        data: { accountId: string; status: SessionStatus; error?: string; playerInfo?: TwPlayerInfo }
      ) => void
    ) => () => void;
  };
  game: {
    getServers: (domain: string) => Promise<Record<string, string>>;
    fetchWorldConfig: (accountId: string) => Promise<{
      success: boolean;
      worldConfig?: TwWorldConfig;
      error?: string;
    }>;
    fetchVillages: (accountId: string) => Promise<{
      success: boolean;
      villages: TwVillage[];
      error?: string;
    }>;
    fetchCombinedVillages: (payload: { accountId: string; groupId?: string }) => Promise<{
      success: boolean;
      villages: TwVillage[];
      groups: TwVillageGroup[];
      error?: string;
    }>;
    searchTargetPlayer: (payload: { accountId: string; query: string }) => Promise<{
      success: boolean;
      matchedPlayers: TwTargetPlayer[];
      villages: TwTargetVillage[];
      error?: string;
    }>;
    fetchIncomingAttacks: (accountId: string) => Promise<{
      success: boolean;
      incomings: TwIncomingAttack[];
      error?: string;
    }>;
  };
  scheduler: {
    list: (accountId?: string) => Promise<ScheduledCommand[]>;
    presets: () => Promise<TroopModelPreset[]>;
    create: (
      payload: Partial<ScheduledCommand> & {
        timingMode?: 'arrival' | 'send';
        worldSpeed?: number;
        unitSpeed?: number;
      }
    ) => Promise<ScheduledCommand>;
    createBatch: (
      payloads: Array<
        Partial<ScheduledCommand> & {
          timingMode?: 'arrival' | 'send';
          worldSpeed?: number;
          unitSpeed?: number;
        }
      >
    ) => Promise<ScheduledCommand[]>;
    createDodge: (payload: {
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
    }) => Promise<ScheduledCommand>;
    cancelDodgeNow: (
      commandId: string
    ) => Promise<{ success: boolean; commandId?: string; error?: string }>;
    triggerNow: (commandId: string) => Promise<{ success: boolean; error?: string }>;
    cancel: (commandId: string) => Promise<boolean>;
    clearAccount: (accountId: string) => Promise<{ success: boolean }>;
    clearAll: () => Promise<{ success: boolean }>;
    stats: () => Promise<{
      success: boolean;
      stats: { activeTimers: number; powerBlockerActive: boolean; nextSendTimeMs: number | null };
    }>;
    onWake: (callback: (event: unknown, cmd: ScheduledCommand) => void) => () => void;
    onUpdated: (callback: (event: unknown, cmd: ScheduledCommand) => void) => () => void;
  };
  autoFarm: {
    getStates: () => Promise<{
      configs: Record<string, AutoFarmConfig>;
      states: Record<string, AutoFarmRuntimeState>;
    }>;
    saveConfig: (config: Partial<AutoFarmConfig> & { accountId: string }) => Promise<AutoFarmConfig>;
    deleteConfig: (configId: string) => Promise<boolean>;
    start: (configId: string) => Promise<{ success: boolean; state?: AutoFarmRuntimeState; error?: string }>;
    stop: (configId: string, reason?: FarmPauseReason) => Promise<{ success: boolean; state?: AutoFarmRuntimeState }>;
    runOnce: (configId: string) => Promise<{ success: boolean; state?: AutoFarmRuntimeState; error?: string }>;
    scanFa: (payload: { accountId: string; villageId?: string }) => Promise<{
      success: boolean;
      captchaDetected?: boolean;
      troops?: TroopCounts;
      targets: FarmPlunderTarget[];
      error?: string;
    }>;
    mapTargets: (payload: {
      accountId: string;
      originVillageId?: string;
      originCoords: string;
      radius: number;
    }) => Promise<{
      success: boolean;
      targets: FarmPlunderTarget[];
      source?: 'fa+map' | 'map' | 'fa';
      error?: string;
    }>;
    onStateChanged: (callback: (event: unknown, state: AutoFarmRuntimeState) => void) => () => void;
  };
  proxy: {
    test: (proxy: ProxyConfig) => Promise<{
      success: boolean;
      latencyMs?: number;
      ip?: string;
      error?: string;
    }>;
  };
  store: {
    accounts: {
      list: () => Promise<TwAccount[]>;
      get: (id: string) => Promise<TwAccount | null>;
      create: (data: Partial<TwAccount>) => Promise<TwAccount>;
      update: (id: string, patch: Partial<TwAccount>) => Promise<TwAccount | null>;
      delete: (id: string) => Promise<boolean>;
    };
    constructionModels: {
      list: () => Promise<ConstructionModel[]>;
      save: (model: Partial<ConstructionModel> & { name: string }) => Promise<ConstructionModel>;
      delete: (id: string) => Promise<boolean>;
    };
    recruitmentModels: {
      list: () => Promise<RecruitmentModel[]>;
      save: (model: Partial<RecruitmentModel> & { name: string }) => Promise<RecruitmentModel>;
      delete: (id: string) => Promise<boolean>;
    };
    proxies: {
      list: () => Promise<ProxyConfig[]>;
      save: (proxy: ProxyConfig) => Promise<ProxyConfig>;
      delete: (id: string) => Promise<boolean>;
    };
    settings: {
      get: () => Promise<AppSettings>;
      update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    };
    logs: {
      list: () => Promise<ActivityLogEntry[]>;
      add: (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => Promise<ActivityLogEntry>;
      clear: () => Promise<{ success: boolean }>;
      export: () => Promise<{
        success: boolean;
        filePath?: string;
        canceled?: boolean;
        error?: string;
      }>;
      openFolder: () => Promise<{ success: boolean; path: string; error?: string }>;
    };
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
  }
}
