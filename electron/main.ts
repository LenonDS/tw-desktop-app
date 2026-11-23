import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DataStore, DEFAULT_SCHEDULER_PRESETS } from './store';
import { FileLogger, redactSensitiveText } from './fileLogger';
import { createElectronSafeStorageCipher } from './secretCrypto';
import {
  fetchTribalWarsServers,
  SessionManager,
  testProxyConnection,
} from './sessionManager';
import { SchedulerService } from './schedulerService';
import { AutoFarmService } from './autoFarmService';
import type {
  AutoFarmConfig,
  ConstructionModel,
  FarmPauseReason,
  ProxyConfig,
  RecruitmentModel,
  ScheduledCommand,
  TroopCounts,
  TwAccount,
} from './types';

let mainWindow: BrowserWindow | null = null;
let store: DataStore;
let fileLogger: FileLogger;
let sessionManager: SessionManager;
let schedulerService: SchedulerService;
let autoFarmService: AutoFarmService;

// Ensure timers and fetch/DOM execution inside BrowserWindows never get throttled
// when the Windows screen is locked (Win+L) or windows are minimized/occluded
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: 'TW Evolution — Workspace & Command Manager',
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  // Accounts CRUD
  ipcMain.handle('store:accounts:list', () => store.getAccounts());
  ipcMain.handle('store:accounts:get', (_e, id: string) => store.getAccountById(id));
  ipcMain.handle('store:accounts:create', (_e, payload: Partial<TwAccount>) =>
    store.createAccount(payload)
  );
  ipcMain.handle('store:accounts:update', (_e, id: string, patch: Partial<TwAccount>) =>
    store.updateAccount(id, patch)
  );
  ipcMain.handle('store:accounts:delete', async (_e, id: string) => {
    autoFarmService.stopAccount(id, 'manual');
    schedulerService.clearAccount(id);
    await sessionManager.stopSession(id);
    return store.deleteAccount(id);
  });

  // Feature 4: Construction & Recruitment Models CRUD
  ipcMain.handle('store:construction:list', () => store.getConstructionModels());
  ipcMain.handle(
    'store:construction:save',
    (_e, model: Partial<ConstructionModel> & { name: string }) =>
      store.saveConstructionModel(model)
  );
  ipcMain.handle('store:construction:delete', (_e, id: string) =>
    store.deleteConstructionModel(id)
  );

  ipcMain.handle('store:recruitment:list', () => store.getRecruitmentModels());
  ipcMain.handle(
    'store:recruitment:save',
    (_e, model: Partial<RecruitmentModel> & { name: string }) =>
      store.saveRecruitmentModel(model)
  );
  ipcMain.handle('store:recruitment:delete', (_e, id: string) =>
    store.deleteRecruitmentModel(id)
  );

  // Proxies CRUD & Testing
  ipcMain.handle('store:proxies:list', () => store.getProxies());
  ipcMain.handle('store:proxies:save', (_e, proxy: ProxyConfig) => store.saveProxy(proxy));
  ipcMain.handle('store:proxies:delete', (_e, id: string) => store.deleteProxy(id));
  ipcMain.handle('proxy:test', (_e, proxy: ProxyConfig) => testProxyConnection(proxy));

  // Settings & Logs
  ipcMain.handle('store:settings:get', () => store.getSettings());
  ipcMain.handle('store:settings:update', (_e, patch: Record<string, unknown>) =>
    store.updateSettings(patch)
  );
  ipcMain.handle('store:logs:list', () => store.getLogs());
  ipcMain.handle(
    'store:logs:add',
    (
      _e,
      entry: {
        level: 'info' | 'success' | 'warn' | 'error';
        message: string;
        accountId?: string;
        accountName?: string;
      }
    ) => store.addLog(entry)
  );
  ipcMain.handle('store:logs:clear', () => {
    store.clearLogs();
    return { success: true };
  });
  ipcMain.handle('store:logs:open-folder', async () => {
    const dir = fileLogger.getLogDir();
    const err = await shell.openPath(dir);
    return { success: !err, path: dir, error: err || undefined };
  });
  ipcMain.handle('store:logs:export', async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dialogOptions: Electron.SaveDialogOptions = {
        title: 'Exportar Logs de Diagnóstico',
        defaultPath: path.join(app.getPath('documents'), `tw-evolution-logs-${today}.log`),
        filters: [
          { name: 'Log / Texto', extensions: ['log', 'txt'] },
          { name: 'Todos os arquivos', extensions: ['*'] },
        ],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const recentFileLogs = fileLogger.readRecent();
      const storeLogs = store
        .getLogs()
        .map(
          (entry) =>
            `[${entry.timestamp}] [${entry.level.toUpperCase()}]${
              entry.accountName ? ` [${redactSensitiveText(entry.accountName)}]` : ''
            } ${redactSensitiveText(entry.message)}`
        )
        .join('\n');

      const combined = [
        `# TW Evolution Diagnostic Logs`,
        `# Exported at: ${new Date().toISOString()}`,
        `# App Version: ${app.getVersion()} | Platform: ${process.platform} (${process.arch})`,
        '',
        '=== FILE LOG (app.log) ===',
        recentFileLogs || '(sem registros em arquivo)',
        '',
        '=== SESSION ACTIVITY LOGS ===',
        storeLogs || '(sem registros na sessão)',
        '',
      ].join('\n');

      fs.writeFileSync(result.filePath, combined, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Falha ao exportar logs.',
      };
    }
  });

  // Game Servers & Live Scrapers (Features 2 & 3 + World Config)
  ipcMain.handle('game:get-servers', (_e, domain: string) =>
    fetchTribalWarsServers(domain || 'tribalwars.com.br')
  );
  ipcMain.handle('game:fetch-world-config', (_e, accountId: string) =>
    sessionManager.fetchWorldConfig(accountId)
  );
  ipcMain.handle('game:fetch-villages', (_e, accountId: string) =>
    sessionManager.fetchVillages(accountId)
  );
  ipcMain.handle(
    'game:fetch-combined-villages',
    (_e, payload: { accountId: string; groupId?: string }) =>
      sessionManager.fetchCombinedVillages(payload.accountId, payload.groupId || '0')
  );
  ipcMain.handle(
    'game:search-target-player',
    (_e, payload: { accountId: string; query: string }) =>
      sessionManager.searchTargetPlayer(payload.accountId, payload.query)
  );
  ipcMain.handle('game:fetch-incoming-attacks', (_e, accountId: string) =>
    sessionManager.fetchIncomingAttacks(accountId)
  );

  // Feature 1: Command Scheduler Engine
  ipcMain.handle('scheduler:list', (_e, accountId?: string) =>
    store.getScheduledCommands(accountId)
  );
  ipcMain.handle('scheduler:presets', () => DEFAULT_SCHEDULER_PRESETS);
  ipcMain.handle(
    'scheduler:create',
    (_e, payload: Parameters<DataStore['createScheduledCommand']>[0]) => {
      const cmd = store.createScheduledCommand(payload);
      schedulerService.scheduleCommandTimers(cmd);
      return cmd;
    }
  );
  ipcMain.handle(
    'scheduler:create-batch',
    (_e, payloads: Parameters<DataStore['createBatchScheduledCommands']>[0]) => {
      const cmds = store.createBatchScheduledCommands(payloads);
      for (const c of cmds) {
        schedulerService.scheduleCommandTimers(c);
      }
      return cmds;
    }
  );
  ipcMain.handle(
    'scheduler:create-dodge',
    (
      _e,
      payload: {
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
    ) => {
      const cmd = store.createDodgeCommand(payload);
      schedulerService.scheduleCommandTimers(cmd);
      return cmd;
    }
  );
  ipcMain.handle('scheduler:cancel-dodge-now', (_e, commandId: string) =>
    schedulerService.executeCancelDodge(commandId)
  );
  ipcMain.handle('scheduler:trigger-now', (_e, commandId: string) =>
    schedulerService.executeSend(commandId)
  );
  ipcMain.handle('scheduler:cancel', (_e, commandId: string) =>
    schedulerService.cancelCommand(commandId)
  );
  ipcMain.handle('scheduler:clear-account', (_e, accountId: string) => {
    schedulerService.clearAccount(accountId);
    return { success: true };
  });
  ipcMain.handle('scheduler:clear-all', () => {
    schedulerService.clearAll();
    return { success: true };
  });
  ipcMain.handle('scheduler:stats', () => ({
    success: true,
    stats: schedulerService.getStats(),
  }));

  // Wave 7: Auto-Farm IPC Handlers
  ipcMain.handle('autofarm:get-states', () => autoFarmService.getSnapshot());
  ipcMain.handle(
    'autofarm:save-config',
    (_e, config: Partial<AutoFarmConfig> & { accountId: string }) => {
      const saved = store.saveAutoFarmConfig(config);
      autoFarmService.syncDailyScheduleForConfig(saved);
      return saved;
    }
  );
  ipcMain.handle('autofarm:delete-config', (_e, configId: string) =>
    autoFarmService.deleteConfig(configId)
  );
  ipcMain.handle('autofarm:start', (_e, configId: string) =>
    autoFarmService.startConfig(configId)
  );
  ipcMain.handle(
    'autofarm:stop',
    (_e, configId: string, reason?: FarmPauseReason) =>
      autoFarmService.stopConfig(configId, reason || 'manual')
  );
  ipcMain.handle('autofarm:run-once', (_e, configId: string) =>
    autoFarmService.runCycle(configId, true)
  );
  ipcMain.handle(
    'autofarm:scan-fa',
    (_e, payload: { accountId: string; villageId?: string }) =>
      sessionManager.inspectFarmAssistant(payload.accountId, payload.villageId)
  );
  ipcMain.handle(
    'autofarm:map-targets',
    (
      _e,
      payload: {
        accountId: string;
        originVillageId?: string;
        originCoords: string;
        radius: number;
      }
    ) => sessionManager.mapNearestFarmTargets(payload)
  );

  // Browser & Session Lifecycle
  ipcMain.handle(
    'browser:start-session',
    (_e, payload: { accountId: string; visible?: boolean; targetUrl?: string } | string) => {
      if (typeof payload === 'string') {
        return sessionManager.launchSession(payload, { visible: false });
      }
      return sessionManager.launchSession(payload.accountId, {
        visible: payload.visible ?? false,
        targetUrl: payload.targetUrl,
      });
    }
  );
  ipcMain.handle('browser:stop-session', (_e, accountId: string) =>
    sessionManager.stopSession(accountId)
  );
  ipcMain.handle('browser:restart-session', async (_e, accountId: string) => {
    await sessionManager.stopSession(accountId);
    return sessionManager.launchSession(accountId, { visible: true });
  });
  ipcMain.handle(
    'browser:open-visible',
    (_e, payload: { accountId: string; pagina?: string; newWindow?: boolean } | string) => {
      if (typeof payload === 'string') {
        return sessionManager.launchSession(payload, { visible: true });
      }
      return sessionManager.launchSession(payload.accountId, {
        visible: true,
        targetUrl: payload.pagina,
        newWindow: payload.newWindow,
      });
    }
  );
  ipcMain.handle(
    'browser:open-new-window',
    (_e, payload: { accountId: string; targetUrl?: string }) => {
      return sessionManager.openAdditionalWindow(payload.accountId, payload.targetUrl);
    }
  );
  ipcMain.handle('browser:bring-to-front', (_e, accountId: string) =>
    sessionManager.bringToFront(accountId)
  );
  ipcMain.handle('browser:reload-page', (_e, accountId: string) =>
    sessionManager.reloadPage(accountId)
  );
  ipcMain.handle('browser:export-cookies', (_e, accountId: string) =>
    sessionManager.exportCookies(accountId)
  );
  ipcMain.handle('browser:get-status', (_e, accountId: string) =>
    sessionManager.getStatus(accountId)
  );
  ipcMain.handle('browser:get-all-statuses', () => sessionManager.getAllStatuses());

  // Window Controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  fileLogger = new FileLogger(path.join(app.getPath('userData'), 'logs'));
  fileLogger.write('info', `Application started (v${app.getVersion()}, ${process.platform}/${process.arch})`);

  process.on('uncaughtException', (err) => {
    fileLogger.write('error', `uncaughtException: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    fileLogger.write('error', `unhandledRejection: ${msg}`);
  });

  store = new DataStore(path.join(app.getPath('userData'), 'data'), {
    cipher: createElectronSafeStorageCipher(),
    onLog: (entry) => fileLogger.write(entry.level, entry.message, entry.accountName),
  });
  sessionManager = new SessionManager(store, (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:status-changed', payload);
    }
  });
  schedulerService = new SchedulerService(store, sessionManager);
  autoFarmService = new AutoFarmService(store, sessionManager, () => mainWindow);
  autoFarmService.syncAllDailySchedules();

  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  autoFarmService?.stopAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
