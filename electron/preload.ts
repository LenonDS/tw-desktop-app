import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  browser: {
    startSession: (payload: { accountId: string; visible?: boolean; targetUrl?: string }) =>
      ipcRenderer.invoke('browser:start-session', payload),
    stopSession: (accountId: string) => ipcRenderer.invoke('browser:stop-session', accountId),
    restartSession: (accountId: string) => ipcRenderer.invoke('browser:restart-session', accountId),
    openVisible: (payload: { accountId: string; pagina?: string; newWindow?: boolean }) =>
      ipcRenderer.invoke('browser:open-visible', payload),
    openNewWindow: (payload: { accountId: string; targetUrl?: string }) =>
      ipcRenderer.invoke('browser:open-new-window', payload),
    bringToFront: (accountId: string) => ipcRenderer.invoke('browser:bring-to-front', accountId),
    reloadPage: (accountId: string) => ipcRenderer.invoke('browser:reload-page', accountId),
    exportCookies: (accountId: string) => ipcRenderer.invoke('browser:export-cookies', accountId),
    getStatus: (accountId: string) => ipcRenderer.invoke('browser:get-status', accountId),
    getAllStatuses: () => ipcRenderer.invoke('browser:get-all-statuses'),
    onStatusChange: (callback: (event: unknown, data: unknown) => void) => {
      ipcRenderer.on('browser:status-changed', callback);
      return () => ipcRenderer.removeListener('browser:status-changed', callback);
    },
  },
  game: {
    getServers: (domain: string) => ipcRenderer.invoke('game:get-servers', domain),
    fetchWorldConfig: (accountId: string) => ipcRenderer.invoke('game:fetch-world-config', accountId),
    fetchVillages: (accountId: string) => ipcRenderer.invoke('game:fetch-villages', accountId),
    fetchCombinedVillages: (payload: { accountId: string; groupId?: string }) =>
      ipcRenderer.invoke('game:fetch-combined-villages', payload),
    searchTargetPlayer: (payload: { accountId: string; query: string }) =>
      ipcRenderer.invoke('game:search-target-player', payload),
    fetchIncomingAttacks: (accountId: string) =>
      ipcRenderer.invoke('game:fetch-incoming-attacks', accountId),
  },
  scheduler: {
    list: (accountId?: string) => ipcRenderer.invoke('scheduler:list', accountId),
    presets: () => ipcRenderer.invoke('scheduler:presets'),
    create: (payload: unknown) => ipcRenderer.invoke('scheduler:create', payload),
    createBatch: (payloads: unknown[]) => ipcRenderer.invoke('scheduler:create-batch', payloads),
    createDodge: (payload: unknown) => ipcRenderer.invoke('scheduler:create-dodge', payload),
    cancelDodgeNow: (commandId: string) =>
      ipcRenderer.invoke('scheduler:cancel-dodge-now', commandId),
    triggerNow: (commandId: string) => ipcRenderer.invoke('scheduler:trigger-now', commandId),
    cancel: (commandId: string) => ipcRenderer.invoke('scheduler:cancel', commandId),
    clearAccount: (accountId: string) => ipcRenderer.invoke('scheduler:clear-account', accountId),
    clearAll: () => ipcRenderer.invoke('scheduler:clear-all'),
    stats: () => ipcRenderer.invoke('scheduler:stats'),
    onWake: (callback: (event: unknown, data: unknown) => void) => {
      ipcRenderer.on('scheduler:wake', callback);
      return () => ipcRenderer.removeListener('scheduler:wake', callback);
    },
    onUpdated: (callback: (event: unknown, data: unknown) => void) => {
      ipcRenderer.on('scheduler:updated', callback);
      return () => ipcRenderer.removeListener('scheduler:updated', callback);
    },
  },
  autoFarm: {
    getStates: () => ipcRenderer.invoke('autofarm:get-states'),
    saveConfig: (config: unknown) => ipcRenderer.invoke('autofarm:save-config', config),
    deleteConfig: (configId: string) => ipcRenderer.invoke('autofarm:delete-config', configId),
    start: (configId: string) => ipcRenderer.invoke('autofarm:start', configId),
    stop: (configId: string, reason?: string) =>
      ipcRenderer.invoke('autofarm:stop', configId, reason),
    runOnce: (configId: string) => ipcRenderer.invoke('autofarm:run-once', configId),
    scanFa: (payload: { accountId: string; villageId?: string }) =>
      ipcRenderer.invoke('autofarm:scan-fa', payload),
    mapTargets: (payload: {
      accountId: string;
      originVillageId?: string;
      originCoords: string;
      radius: number;
    }) => ipcRenderer.invoke('autofarm:map-targets', payload),
    onStateChanged: (callback: (event: unknown, state: unknown) => void) => {
      ipcRenderer.on('autofarm:state-changed', callback);
      return () => ipcRenderer.removeListener('autofarm:state-changed', callback);
    },
  },
  proxy: {
    test: (proxy: unknown) => ipcRenderer.invoke('proxy:test', proxy),
  },
  store: {
    accounts: {
      list: () => ipcRenderer.invoke('store:accounts:list'),
      get: (id: string) => ipcRenderer.invoke('store:accounts:get', id),
      create: (data: unknown) => ipcRenderer.invoke('store:accounts:create', data),
      update: (id: string, patch: unknown) => ipcRenderer.invoke('store:accounts:update', id, patch),
      delete: (id: string) => ipcRenderer.invoke('store:accounts:delete', id),
    },
    constructionModels: {
      list: () => ipcRenderer.invoke('store:construction:list'),
      save: (model: unknown) => ipcRenderer.invoke('store:construction:save', model),
      delete: (id: string) => ipcRenderer.invoke('store:construction:delete', id),
    },
    recruitmentModels: {
      list: () => ipcRenderer.invoke('store:recruitment:list'),
      save: (model: unknown) => ipcRenderer.invoke('store:recruitment:save', model),
      delete: (id: string) => ipcRenderer.invoke('store:recruitment:delete', id),
    },
    proxies: {
      list: () => ipcRenderer.invoke('store:proxies:list'),
      save: (proxy: unknown) => ipcRenderer.invoke('store:proxies:save', proxy),
      delete: (id: string) => ipcRenderer.invoke('store:proxies:delete', id),
    },
    settings: {
      get: () => ipcRenderer.invoke('store:settings:get'),
      update: (patch: unknown) => ipcRenderer.invoke('store:settings:update', patch),
    },
    logs: {
      list: () => ipcRenderer.invoke('store:logs:list'),
      add: (entry: unknown) => ipcRenderer.invoke('store:logs:add', entry),
      clear: () => ipcRenderer.invoke('store:logs:clear'),
      export: () => ipcRenderer.invoke('store:logs:export'),
      openFolder: () => ipcRenderer.invoke('store:logs:open-folder'),
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    openExternal: (url: string) => ipcRenderer.invoke('window:open-external', url),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
