import { BrowserWindow, clipboard, Menu, session, shell } from 'electron';
import https from 'node:https';
import http from 'node:http';
import type { DataStore } from './store';
import {
  calculateDistance,
  classifyIncomingAttackUnit,
  formatProxyRules,
  parseCoords,
  parsePhpSerializedServers,
  parseWorldConfigXml,
  parseWorldPlayersTxt,
  parseWorldVillagesTxt,
  searchTargetPlayerVillages,
} from './store';
import type {
  FarmPlunderTarget,
  FarmTargetStatus,
  FarmTemplateKey,
  ProxyConfig,
  ScheduledCommand,
  SessionStatus,
  TroopCounts,
  TwAccount,
  TwCookie,
  TwIncomingAttack,
  TwPlayerInfo,
  TwTargetPlayer,
  TwTargetVillage,
  TwUnitType,
  TwVillage,
  TwVillageGroup,
  TwWorldConfig,
} from './types';

export { parsePhpSerializedServers };

export function isTribalWarsUrl(
  url: string,
  accountDomain: string,
  accountWorld?: string
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const cleanDomain = (accountDomain || 'tribalwars.com.br').toLowerCase().trim();
    if (cleanDomain && (host === cleanDomain || host.endsWith('.' + cleanDomain))) {
      return true;
    }
    if (accountWorld && host.includes(accountWorld.toLowerCase())) {
      return true;
    }
    if (host.includes('tribalwars.') || host.includes('innogames.')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface ManagedSession {
  accountId: string;
  window: BrowserWindow;
  extraWindows: Set<BrowserWindow>;
  status: SessionStatus;
  visible: boolean;
  lastError?: string;
}

interface PreparedCommandState {
  commandId: string;
  villageId: string;
  csrfToken: string;
  serializedForm: string;
  targetX: number;
  targetY: number;
  commandType: string;
  extraWavesTroops: Array<Partial<Record<string, number>>>;
  trainsAdded: number;
  preparedAt: number;
}

const FALLBACK_SERVERS: Record<string, Record<string, string>> = {
  'tribalwars.com.br': {
    br128: 'https://br128.tribalwars.com.br',
    br129: 'https://br129.tribalwars.com.br',
    br130: 'https://br130.tribalwars.com.br',
    br131: 'https://br131.tribalwars.com.br',
    brs1: 'https://brs1.tribalwars.com.br',
  },
  'tribalwars.com.pt': {
    pt104: 'https://pt104.tribalwars.com.pt',
    pt105: 'https://pt105.tribalwars.com.pt',
    pts1: 'https://pts1.tribalwars.com.pt',
  },
  'tribalwars.net': {
    en141: 'https://en141.tribalwars.net',
    en142: 'https://en142.tribalwars.net',
    ens1: 'https://ens1.tribalwars.net',
  },
};

export async function fetchTribalWarsServers(
  domain = 'tribalwars.com.br'
): Promise<Record<string, string>> {
  const cleanDomain = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  const url = `https://www.${cleanDomain}/backend/get_servers.php`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        const parsed = parsePhpSerializedServers(body);
        if (Object.keys(parsed).length > 0) {
          resolve(parsed);
        } else {
          resolve(FALLBACK_SERVERS[cleanDomain] || FALLBACK_SERVERS['tribalwars.com.br']);
        }
      });
    });
    req.on('error', () => {
      resolve(FALLBACK_SERVERS[cleanDomain] || FALLBACK_SERVERS['tribalwars.com.br']);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(FALLBACK_SERVERS[cleanDomain] || FALLBACK_SERVERS['tribalwars.com.br']);
    });
  });
}

export async function testProxyConnection(
  proxy: ProxyConfig
): Promise<{ success: boolean; latencyMs?: number; ip?: string; error?: string }> {
  const start = Date.now();
  if (!proxy.host || !proxy.port) {
    return { success: false, error: 'Host e porta do proxy são obrigatórios.' };
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: proxy.host,
        port: Number(proxy.port),
        method: 'GET',
        path: 'http://api.ipify.org?format=json',
        timeout: 6000,
        headers:
          proxy.username && proxy.password
            ? {
                'Proxy-Authorization':
                  'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
              }
            : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          const latencyMs = Date.now() - start;
          try {
            const parsed = JSON.parse(data) as { ip?: string };
            resolve({ success: true, latencyMs, ip: parsed.ip || proxy.host });
          } catch {
            resolve({
              success: res.statusCode !== undefined && res.statusCode < 500,
              latencyMs,
              ip: proxy.host,
            });
          }
        });
      }
    );
    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Tempo limite esgotado ao testar proxy.' });
    });
    req.end();
  });
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly prepareLocks = new Map<string, Promise<{ success: boolean; prepared?: boolean; error?: string }>>();
  private readonly preparedCommands = new Map<string, PreparedCommandState>();
  private readonly worldMapCache = new Map<
    string,
    { fetchedAt: number; players: TwTargetPlayer[]; villages: TwTargetVillage[] }
  >();
  private readonly commandWindows = new Map<string, BrowserWindow>();
  private readonly busyWindows = new Set<number>();
  private readonly autoWorkerWindows = new Set<number>();
  private readonly store: DataStore;
  private readonly onStatusChanged: (payload: {
    accountId: string;
    status: SessionStatus;
    error?: string;
    playerInfo?: TwPlayerInfo;
  }) => void;

  constructor(
    store: DataStore,
    onStatusChanged: (payload: {
      accountId: string;
      status: SessionStatus;
      error?: string;
      playerInfo?: TwPlayerInfo;
    }) => void
  ) {
    this.store = store;
    this.onStatusChanged = onStatusChanged;
  }

  public getStatus(accountId: string): { status: SessionStatus; visible: boolean; error?: string } {
    const active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      return { status: 'offline', visible: false };
    }
    const hasVisibleWindow =
      active.window.isVisible() ||
      Array.from(active.extraWindows).some((w) => !w.isDestroyed() && w.isVisible());
    return {
      status: active.status,
      visible: hasVisibleWindow,
      error: active.lastError,
    };
  }

  public getAllStatuses(): Record<string, { status: SessionStatus; visible: boolean; error?: string }> {
    const out: Record<string, { status: SessionStatus; visible: boolean; error?: string }> = {};
    for (const acc of this.store.getAccounts()) {
      out[acc._id] = this.getStatus(acc._id);
    }
    return out;
  }

  private emitStatus(
    accountId: string,
    status: SessionStatus,
    error?: string,
    playerInfo?: TwPlayerInfo
  ): void {
    this.store.updateAccount(accountId, {
      status,
      lastError: error,
      ...(playerInfo ? { playerInfo } : {}),
    });
    this.onStatusChanged({ accountId, status, error, playerInfo });
  }

  private createGameWindow(
    account: TwAccount,
    initialUrl: string,
    partitionName: string,
    isPrimary: boolean,
    showWindow: boolean = true
  ): BrowserWindow {
    const win = new BrowserWindow({
      width: account.fingerprint?.viewport?.width || 1366,
      height: account.fingerprint?.viewport?.height || 800,
      show: showWindow,
      title: `Tribal Wars — ${account.username} (${account.world.toUpperCase()})`,
      backgroundColor: '#0f1218',
      autoHideMenuBar: false,
      webPreferences: {
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const winId = win.id;

    const baseServerUrl = account.serverUrl || `https://${account.world}.${account.domain}`;

    // Native Window Menu with Browser Navigation & Shortcuts
    const menu = Menu.buildFromTemplate([
      {
        label: 'Navegação',
        submenu: [
          {
            label: 'Voltar',
            accelerator: 'Alt+Left',
            click: () => {
              if (!win.isDestroyed() && win.webContents.canGoBack()) {
                win.webContents.goBack();
              }
            },
          },
          {
            label: 'Avançar',
            accelerator: 'Alt+Right',
            click: () => {
              if (!win.isDestroyed() && win.webContents.canGoForward()) {
                win.webContents.goForward();
              }
            },
          },
          {
            label: 'Recarregar',
            accelerator: 'F5',
            click: () => {
              if (!win.isDestroyed()) win.webContents.reload();
            },
          },
          {
            label: 'Recarregar Limpando Cache',
            accelerator: 'Ctrl+F5',
            click: () => {
              if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
            },
          },
          { type: 'separator' },
          {
            label: 'Nova Janela',
            accelerator: 'Ctrl+N',
            click: () => {
              const cur = (!win.isDestroyed() && win.webContents.getURL()) || initialUrl;
              this.openAdditionalWindow(account._id, cur);
            },
          },
          {
            label: 'Duplicar Janela Atual',
            accelerator: 'Ctrl+T',
            click: () => {
              const cur = (!win.isDestroyed() && win.webContents.getURL()) || initialUrl;
              this.openAdditionalWindow(account._id, cur);
            },
          },
          { type: 'separator' },
          {
            label: 'Fechar Janela',
            accelerator: 'Ctrl+W',
            click: () => {
              if (!win.isDestroyed()) win.close();
            },
          },
        ],
      },
      {
        label: 'Telas Rápidas',
        submenu: [
          {
            label: 'Visão Geral da Aldeia',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=overview`);
            },
          },
          {
            label: 'Praça de Reunião',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=place`);
            },
          },
          {
            label: 'Mapa',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=map`);
            },
          },
          {
            label: 'Visão Geral das Aldeias (Produção)',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=overview_villages&mode=prod`);
            },
          },
          {
            label: 'Comandos / Ataques a Caminho',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=overview_villages&mode=incomings`);
            },
          },
          {
            label: 'Mensagens',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=mail`);
            },
          },
          {
            label: 'Relatórios',
            click: () => {
              if (!win.isDestroyed()) win.loadURL(`${baseServerUrl}/game.php?screen=report`);
            },
          },
        ],
      },
      {
        label: 'Exibir',
        submenu: [
          { role: 'zoomIn', label: 'Aumentar Zoom' },
          { role: 'zoomOut', label: 'Diminuir Zoom' },
          { role: 'resetZoom', label: 'Zoom Padrão (100%)' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Tela Cheia (F11)' },
          {
            label: 'Inspecionar Elemento (DevTools)',
            accelerator: 'F12',
            click: () => {
              if (!win.isDestroyed()) win.webContents.toggleDevTools();
            },
          },
        ],
      },
    ]);
    win.setMenu(menu);

    // Sync window title with dynamic Tribal Wars in-game title
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(`${title} — ${account.username} (${account.world.toUpperCase()})`);
    });

    // Mouse back/forward button support (XButton1 / XButton2)
    win.on('app-command', (e, cmd) => {
      if (cmd === 'browser-backward') {
        if (!win.isDestroyed() && win.webContents.canGoBack()) {
          e.preventDefault();
          win.webContents.goBack();
        }
      } else if (cmd === 'browser-forward') {
        if (!win.isDestroyed() && win.webContents.canGoForward()) {
          e.preventDefault();
          win.webContents.goForward();
        }
      }
    });

    // Keyboard navigation shortcuts
    win.webContents.on('before-input-event', (event, input) => {
      if (win.isDestroyed() || input.type !== 'keyDown') return;

      // Alt + Left Arrow -> Back
      if (input.alt && input.key === 'ArrowLeft') {
        if (win.webContents.canGoBack()) {
          event.preventDefault();
          win.webContents.goBack();
        }
        return;
      }

      // Alt + Right Arrow -> Forward
      if (input.alt && input.key === 'ArrowRight') {
        if (win.webContents.canGoForward()) {
          event.preventDefault();
          win.webContents.goForward();
        }
        return;
      }

      // F5 or Ctrl+R -> Reload
      if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.shift)) {
        event.preventDefault();
        win.webContents.reload();
        return;
      }

      // Ctrl+Shift+R or Ctrl+F5 -> Hard Reload
      if (
        ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') ||
        (input.control && input.key === 'F5')
      ) {
        event.preventDefault();
        win.webContents.reloadIgnoringCache();
        return;
      }

      // Ctrl+N -> New Game Window
      if ((input.control || input.meta) && input.key.toLowerCase() === 'n' && !input.shift && !input.alt) {
        event.preventDefault();
        const cur = win.webContents.getURL() || initialUrl;
        this.openAdditionalWindow(account._id, cur);
        return;
      }

      // Ctrl+T -> Duplicate/New Window
      if ((input.control || input.meta) && input.key.toLowerCase() === 't' && !input.shift && !input.alt) {
        event.preventDefault();
        const cur = win.webContents.getURL() || initialUrl;
        this.openAdditionalWindow(account._id, cur);
        return;
      }

      // Ctrl+W -> Close this window
      if ((input.control || input.meta) && input.key.toLowerCase() === 'w' && !input.shift && !input.alt) {
        event.preventDefault();
        win.close();
        return;
      }
    });

    // Right-Click Context Menu
    win.webContents.on('context-menu', (_e, params) => {
      if (win.isDestroyed()) return;
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: 'Voltar (Alt+←)',
          enabled: win.webContents.canGoBack(),
          click: () => {
            if (!win.isDestroyed()) win.webContents.goBack();
          },
        },
        {
          label: 'Avançar (Alt+→)',
          enabled: win.webContents.canGoForward(),
          click: () => {
            if (!win.isDestroyed()) win.webContents.goForward();
          },
        },
        {
          label: 'Recarregar (F5)',
          click: () => {
            if (!win.isDestroyed()) win.webContents.reload();
          },
        },
        { type: 'separator' },
      ];

      if (params.linkURL) {
        template.push(
          {
            label: 'Abrir link em nova janela',
            click: () => {
              this.openAdditionalWindow(account._id, params.linkURL);
            },
          },
          {
            label: 'Copiar endereço do link',
            click: () => clipboard.writeText(params.linkURL),
          },
          { type: 'separator' }
        );
      }

      if (params.selectionText) {
        template.push({ role: 'copy', label: 'Copiar' });
      }

      if (params.isEditable) {
        template.push(
          { role: 'paste', label: 'Colar' },
          { role: 'cut', label: 'Recortar' },
          { type: 'separator' }
        );
      }

      template.push(
        {
          label: 'Nova Janela (Ctrl+N)',
          click: () => {
            const cur = (!win.isDestroyed() && win.webContents.getURL()) || initialUrl;
            this.openAdditionalWindow(account._id, cur);
          },
        },
        { type: 'separator' },
        {
          label: 'Inspecionar Elemento',
          click: () => {
            if (!win.isDestroyed()) win.webContents.inspectElement(params.x, params.y);
          },
        }
      );

      const contextMenu = Menu.buildFromTemplate(template);
      contextMenu.popup({ window: win });
    });

    // Intercept window.open, target="_blank", middle clicks
    win.webContents.setWindowOpenHandler((details) => {
      const target = details.url;
      if (isTribalWarsUrl(target, account.domain, account.world)) {
        this.openAdditionalWindow(account._id, target);
        return { action: 'deny' };
      }

      if (target.startsWith('http://') || target.startsWith('https://')) {
        shell.openExternal(target).catch(() => {});
        return { action: 'deny' };
      }

      return { action: 'deny' };
    });

    // Proxy authentication
    if (account.proxy?.enabled && account.proxy.username && account.proxy.password) {
      win.webContents.on('login', (event, _details, _authInfo, callback) => {
        event.preventDefault();
        callback(account.proxy?.username || '', account.proxy?.password || '');
      });
    }

    // Window closed lifecycle handler
    win.on('closed', () => {
      this.busyWindows.delete(winId);
      this.autoWorkerWindows.delete(winId);
      for (const [cmdId, mappedWin] of this.commandWindows.entries()) {
        if (mappedWin === win) {
          this.commandWindows.delete(cmdId);
        }
      }

      const sessionData = this.sessions.get(account._id);
      if (!sessionData) return;

      if (!isPrimary) {
        sessionData.extraWindows.delete(win);
      } else {
        // If primary window is closed, check if any extra window can be promoted
        if (sessionData.extraWindows.size > 0) {
          const nextWin = sessionData.extraWindows.values().next().value;
          if (nextWin && !nextWin.isDestroyed()) {
            sessionData.extraWindows.delete(nextWin);
            sessionData.window = nextWin;
            return;
          }
        }
        // No windows left
        this.sessions.delete(account._id);
        this.emitStatus(account._id, 'offline');
      }
    });

    return win;
  }

  public async launchSession(
    accountId: string,
    options: { visible?: boolean; targetUrl?: string; newWindow?: boolean } = {}
  ): Promise<{ success: boolean; status: SessionStatus; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) {
      return { success: false, status: 'error', error: 'Conta não encontrada.' };
    }

    const showWindow = options.visible ?? true;
    const partitionName = `persist:tw-${account._id}`;
    const initialUrl =
      options.targetUrl || account.serverUrl || `https://${account.world}.${account.domain}`;

    const existing = this.sessions.get(accountId);
    if (existing && !existing.window.isDestroyed()) {
      if (options.newWindow) {
        const extraWin = this.createGameWindow(
          account,
          initialUrl,
          partitionName,
          false,
          true
        );
        existing.extraWindows.add(extraWin);
        this.store.addLog({
          accountId,
          accountName: account.username,
          level: 'info',
          message: `Abrindo nova janela adicional para ${account.username} em ${initialUrl}`,
        });
        extraWin.loadURL(initialUrl).catch(() => {});
        return { success: true, status: existing.status };
      }

      if (showWindow) {
        existing.window.show();
        existing.window.focus();
      }
      if (options.targetUrl) {
        try {
          await existing.window.loadURL(options.targetUrl);
        } catch (err) {
          // Ignore ERR_ABORTED (-3) when a form submission or redirect supersedes navigation
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('ERR_ABORTED') && !msg.includes('(-3)')) {
            return { success: false, status: 'error', error: msg };
          }
        }
      }
      return { success: true, status: existing.status };
    }

    this.emitStatus(accountId, 'starting');

    const ses = session.fromPartition(partitionName);

    if (account.fingerprint?.userAgent) {
      ses.setUserAgent(account.fingerprint.userAgent);
    }

    const proxyRules = formatProxyRules(account.proxy);
    if (proxyRules) {
      await ses.setProxy({ proxyRules });
    } else {
      await ses.setProxy({ mode: 'direct' });
    }

    if (Array.isArray(account.cookies) && account.cookies.length > 0) {
      const baseUrl = account.serverUrl || `https://${account.world}.${account.domain}`;
      for (const c of account.cookies) {
        if (c.name && c.value) {
          try {
            await ses.cookies.set({
              url: baseUrl,
              name: c.name,
              value: c.value,
              domain: c.domain || `.${account.domain}`,
              path: c.path || '/',
            });
          } catch {
            // Ignore invalid cookie
          }
        }
      }
    }

    const win = this.createGameWindow(
      account,
      initialUrl,
      partitionName,
      true,
      showWindow
    );

    const managed: ManagedSession = {
      accountId,
      window: win,
      extraWindows: new Set<BrowserWindow>(),
      status: 'starting',
      visible: showWindow,
    };
    this.sessions.set(accountId, managed);

    win.webContents.on('did-finish-load', async () => {
      if (win.isDestroyed()) return;
      managed.status = 'running';
      const playerInfo = await this.extractPlayerTelemetry(win, account);
      this.emitStatus(accountId, 'running', undefined, playerInfo);
      // Auto-sync world config and full village list when logged into the world
      const latestAcc = this.store.getAccountById(accountId);
      if (latestAcc && !latestAcc.worldConfig) {
        this.fetchWorldConfig(accountId).catch(() => {});
      }
      if (
        latestAcc &&
        playerInfo?.villagesCount &&
        (latestAcc.villages?.length || 0) < playerInfo.villagesCount
      ) {
        this.fetchVillages(accountId)
          .then(() => {
            this.emitStatus(accountId, 'running', undefined, playerInfo);
          })
          .catch(() => {});
      }
    });

    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        managed.status = 'error';
        managed.lastError = `${errorDescription} (${validatedURL})`;
        this.emitStatus(accountId, 'error', managed.lastError);
      }
    );

    try {
      this.store.addLog({
        accountId,
        accountName: account.username,
        level: 'info',
        message: `Iniciando sessão ${showWindow ? 'visível' : 'em segundo plano'} em ${initialUrl}`,
      });
      await win.loadURL(initialUrl);
      managed.status = 'running';
      this.emitStatus(accountId, 'running');
      return { success: true, status: 'running' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao conectar ao servidor Tribal Wars';
      managed.status = 'error';
      managed.lastError = msg;
      this.emitStatus(accountId, 'error', msg);
      return { success: false, status: 'error', error: msg };
    }
  }

  public async openAdditionalWindow(
    accountId: string,
    targetUrl?: string
  ): Promise<{ success: boolean; status: SessionStatus; error?: string }> {
    return this.launchSession(accountId, {
      visible: true,
      targetUrl,
      newWindow: true,
    });
  }

  private async extractPlayerTelemetry(
    win: BrowserWindow,
    account: TwAccount
  ): Promise<TwPlayerInfo | undefined> {
    try {
      const data = await win.webContents.executeJavaScript(`
        (() => {
          try {
            if (typeof window.TribalWars !== 'undefined' || typeof window.game_data !== 'undefined') {
              const gd = window.game_data || {};
              const p = gd.player || {};
              const v = gd.village || {};
              return {
                points: Number(p.points || 0),
                rank: Number(p.rank || 0),
                villagesCount: Number(p.villages || 1),
                incomings: Number(p.incomings || 0),
                wood: Number(v.wood || 0),
                stone: Number(v.stone || 0),
                iron: Number(v.iron || 0),
                currentVillage: v.id ? {
                  id: String(v.id),
                  name: String(v.name || 'Aldeia'),
                  coords: String(v.coord || (v.x + '|' + v.y)),
                  x: Number(v.x || 500),
                  y: Number(v.y || 500),
                  points: Number(v.points || 0),
                  wood: Number(v.wood || 0),
                  stone: Number(v.stone || 0),
                  iron: Number(v.iron || 0),
                  storage: Number(v.storage_max || 0),
                  pop: Number(v.pop || 0),
                  popMax: Number(v.pop_max || 0)
                } : null
              };
            }
          } catch {}
          return null;
        })();
      `);
      if (data && typeof data === 'object') {
        if (data.currentVillage) {
          const existingVillages = account.villages || [];
          const cv: TwVillage = {
            ...data.currentVillage,
            updatedAt: new Date().toISOString(),
          };
          const merged = existingVillages.some((v) => v.id === cv.id)
            ? existingVillages.map((v) => (v.id === cv.id ? cv : v))
            : [...existingVillages, cv];
          this.store.setAccountVillages(account._id, merged);
        }
        const { currentVillage: _unused, ...info } = data;
        return { ...account.playerInfo, ...info };
      }
    } catch {
      // Ignore on login screen
    }
    return undefined;
  }

  /**
   * Feature 2: Sync villages and resources from active Tribal Wars session
   */
  public async fetchVillages(
    accountId: string
  ): Promise<{ success: boolean; villages: TwVillage[]; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) return { success: false, villages: [], error: 'Conta não encontrada.' };

    let active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      const launched = await this.launchSession(accountId, { visible: false });
      if (!launched.success) {
        return {
          success: false,
          villages: account.villages || [],
          error: launched.error || 'Sessão não conectada.',
        };
      }
      active = this.sessions.get(accountId);
    }
    if (!active || active.window.isDestroyed()) {
      return { success: false, villages: account.villages || [], error: 'Janela indisponível.' };
    }

    try {
      const scraped = (await active.window.webContents.executeJavaScript(`
        (async () => {
          try {
            const gd = window.game_data;
            if (!gd) return { ok: false, error: 'Faça login no mundo Tribal Wars primeiro.' };
            const base = gd.link_base_pure || '/game.php?screen=';
            const res = await fetch(base + 'overview_villages&mode=prod', { credentials: 'include' });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const rows = Array.from(doc.querySelectorAll('#production_table tbody tr'));
            const list = [];
            for (const tr of rows) {
              const nameEl = tr.querySelector('.quickedit-vn');
              const id = nameEl?.getAttribute('data-id') || '';
              const fullText = (nameEl?.textContent || tr.textContent || '').trim();
              const coordMatch = /\\((\\d{1,3}\\|\\d{1,3})\\)/.exec(fullText);
              const coords = coordMatch ? coordMatch[1] : (gd.village?.coord || '500|500');
              const [x, y] = coords.split('|').map(Number);
              const cleanName = fullText.replace(/\\s*\\(\\d{1,3}\\|\\d{1,3}\\).*$/, '').trim() || 'Aldeia';
              const tds = Array.from(tr.querySelectorAll('td'));
              const parseNum = (s) => Number(String(s || '').replace(/[^0-9]/g, '')) || 0;
              const points = parseNum(tds[1]?.textContent);
              const resSpans = Array.from(tr.querySelectorAll('.res, .warn, .warn_90'));
              const wood = parseNum(resSpans[0]?.textContent);
              const stone = parseNum(resSpans[1]?.textContent);
              const iron = parseNum(resSpans[2]?.textContent);
              const storage = parseNum(tds[3]?.textContent);
              const popParts = String(tds[4]?.textContent || '0/0').split('/');
              const pop = parseNum(popParts[0]);
              const popMax = parseNum(popParts[1]);
              if (id || coordMatch) {
                list.push({ id: id || coords, name: cleanName, coords, x, y, points, wood, stone, iron, storage, pop, popMax });
              }
            }
            if (list.length === 0 && gd.village) {
              const v = gd.village;
              list.push({
                id: String(v.id || '1'),
                name: String(v.name || 'Aldeia Principal'),
                coords: String(v.coord || (v.x + '|' + v.y)),
                x: Number(v.x || 500),
                y: Number(v.y || 500),
                points: Number(v.points || 0),
                wood: Number(v.wood || 0),
                stone: Number(v.stone || 0),
                iron: Number(v.iron || 0),
                storage: Number(v.storage_max || 0),
                pop: Number(v.pop || 0),
                popMax: Number(v.pop_max || 0)
              });
            }
            return { ok: true, villages: list };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        })();
      `)) as { ok: boolean; villages?: Array<Omit<TwVillage, 'updatedAt'>>; error?: string };

      if (!scraped?.ok || !scraped.villages) {
        return {
          success: false,
          villages: account.villages || [],
          error: scraped?.error || 'Não foi possível ler as aldeias da sessão.',
        };
      }

      const now = new Date().toISOString();
      const villages: TwVillage[] = scraped.villages.map((v) => ({ ...v, updatedAt: now }));
      this.store.setAccountVillages(accountId, villages);
      this.store.addLog({
        accountId,
        accountName: account.username,
        level: 'success',
        message: `${villages.length} aldeia(s) sincronizada(s) de ${account.world.toUpperCase()}.`,
      });
      return { success: true, villages };
    } catch (err) {
      return {
        success: false,
        villages: account.villages || [],
        error: err instanceof Error ? err.message : 'Erro ao sincronizar aldeias.',
      };
    }
  }

  /**
   * Wave 4 (Phase 15): Scrape combined villages view (`mode=combined`) including home troops
   * and dynamic Tribal Wars groups (`groups&ajax=load_group_menu`).
   * Supports desktop `#combined_table`, mobile `.overview-container-item`, and non-Premium fallback.
   */
  public async fetchCombinedVillages(
    accountId: string,
    groupId = '0'
  ): Promise<{ success: boolean; villages: TwVillage[]; groups: TwVillageGroup[]; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) {
      return { success: false, villages: [], groups: [], error: 'Conta não encontrada.' };
    }

    let active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      const launched = await this.launchSession(accountId, { visible: false });
      if (!launched.success) {
        return {
          success: false,
          villages: account.villages || [],
          groups: account.villageGroups || [],
          error: launched.error || 'Sessão não conectada.',
        };
      }
      active = this.sessions.get(accountId);
    }
    if (!active || active.window.isDestroyed()) {
      return {
        success: false,
        villages: account.villages || [],
        groups: account.villageGroups || [],
        error: 'Janela indisponível.',
      };
    }

    try {
      const scraped = (await active.window.webContents.executeJavaScript(`
        (async () => {
          try {
            const gd = window.game_data;
            if (!gd || !gd.village) {
              return { ok: false, error: 'Faça login no mundo Tribal Wars primeiro.' };
            }
            const currentVid = String(gd.village.id || '');
            const base = gd.link_base_pure || ('/game.php?village=' + currentVid + '&screen=');
            const parser = new DOMParser();

            // 1. Fetch dynamic Tribal Wars groups (Account Premium)
            const groups = [{ id: '0', name: 'Todas' }];
            try {
              const gRes = await fetch('/game.php?village=' + currentVid + '&screen=groups&ajax=load_group_menu', {
                headers: {
                  'accept': 'application/json, text/javascript, */*; q=0.01',
                  'tribalwars-ajax': '1',
                  'x-requested-with': 'XMLHttpRequest'
                },
                credentials: 'include'
              });
              if (gRes.ok) {
                const gJson = await gRes.json();
                const arr = (gJson && gJson.response && gJson.response.result) || gJson.result || [];
                if (Array.isArray(arr)) {
                  for (const item of arr) {
                    const rawId = item.group_id !== undefined ? item.group_id : item.group?.id;
                    const rawName = item.name || item.group?.name || '';
                    if (rawId !== undefined && rawId !== null) {
                      const gid = String(rawId);
                      const cleanName = String(rawName).replace(/<[^>]+>/g, '').trim() || ('Grupo ' + gid);
                      if (!groups.some((g) => g.id === gid)) {
                        groups.push({ id: gid, name: gid === '0' ? 'Todas' : cleanName });
                      }
                    }
                  }
                }
              }
            } catch {}

            const cleanVillageName = (raw) =>
              String(raw || '')
                .replace(/\\s*\\(\\d{1,3}\\|\\d{1,3}\\)\\s*(?:K\\d+)?\\s*$/i, '')
                .replace(/\\s+/g, ' ')
                .trim() || 'Aldeia';

            const parseCombinedDoc = (doc) => {
              const out = [];
              const seen = new Set();

              // Strategy A: Mobile/widget .overview-container-item
              doc.querySelectorAll('.overview-container-item').forEach((w) => {
                const qe = w.querySelector('.quickedit-vn[data-id]');
                const vId = qe ? String(qe.getAttribute('data-id') || '') : '';
                if (!vId || seen.has(vId)) return;
                const labelEl = w.querySelector('.quickedit-label') || qe;
                const text = (labelEl?.textContent || '').trim();
                const cm = /(\\d{1,3})\\|(\\d{1,3})/.exec(text);
                if (!cm) return;
                const x = Number(cm[1]);
                const y = Number(cm[2]);
                const coords = x + '|' + y;
                const troops = {};
                w.querySelectorAll('.unit-row-item').forEach((it) => {
                  const img = it.querySelector('img');
                  const cnt = it.querySelector('.unit-row-name');
                  if (!img || !cnt) return;
                  const sm = (img.getAttribute('src') || '').match(/unit_([a-z]+)/);
                  if (!sm) return;
                  const n = parseInt((cnt.textContent || '').replace(/[^\\d]/g, '') || '0', 10);
                  if (n > 0) troops[sm[1]] = n;
                });
                let pts = 0;
                const ptsEl = w.querySelector('.points-header :scope > span:last-child');
                if (ptsEl) pts = parseInt((ptsEl.textContent || '').replace(/[^\\d]/g, '') || '0', 10) || 0;
                seen.add(vId);
                out.push({
                  id: vId,
                  name: cleanVillageName(text),
                  coords,
                  x,
                  y,
                  points: pts,
                  wood: 0,
                  stone: 0,
                  iron: 0,
                  storage: 0,
                  pop: 0,
                  popMax: 0,
                  troops,
                });
              });

              // Strategy B: Desktop #combined_table
              if (out.length === 0) {
                const table = doc.querySelector('#combined_table');
                if (table) {
                  const headerUnits = [];
                  table.querySelectorAll('thead th img[src*="unit_"], tr:first-child th img[src*="unit_"]').forEach((img) => {
                    const m = (img.getAttribute('src') || '').match(/unit_([a-z]+)/);
                    if (m) headerUnits.push(m[1]);
                  });

                  table.querySelectorAll('tr.row_a, tr.row_b, tbody tr.nowrap').forEach((tr) => {
                    const qe = tr.querySelector('.quickedit-vn[data-id]');
                    const link = qe ? null : tr.querySelector('a[href*="village="]');
                    const vId = qe
                      ? String(qe.getAttribute('data-id') || '')
                      : String((/village=(\\d+)/.exec(link?.getAttribute('href') || '') || [])[1] || '');
                    if (!vId || seen.has(vId)) return;
                    const labelEl = tr.querySelector('.quickedit-label') || qe || link;
                    const text = (labelEl?.textContent || tr.textContent || '').trim();
                    const cm = /(\\d{1,3})\\|(\\d{1,3})/.exec(text);
                    if (!cm) return;
                    const x = Number(cm[1]);
                    const y = Number(cm[2]);
                    const coords = x + '|' + y;
                    const troops = {};
                    const unitCells = tr.querySelectorAll('td.unit-item');
                    unitCells.forEach((td, idx) => {
                      const clsUnit = Array.from(td.classList).find((c) => c.startsWith('unit-item-') && c !== 'unit-item');
                      const unit = clsUnit ? clsUnit.replace('unit-item-', '') : headerUnits[idx];
                      if (!unit || unit === 'militia') return;
                      const rawVal = td.getAttribute('data-unit-count') ?? td.textContent ?? '0';
                      const cnt = parseInt(String(rawVal).replace(/[^\\d]/g, '') || '0', 10);
                      if (Number.isFinite(cnt) && cnt > 0) troops[unit] = cnt;
                    });
                    seen.add(vId);
                    out.push({
                      id: vId,
                      name: cleanVillageName(text),
                      coords,
                      x,
                      y,
                      points: 0,
                      wood: 0,
                      stone: 0,
                      iron: 0,
                      storage: 0,
                      pop: 0,
                      popMax: 0,
                      troops,
                    });
                  });
                }
              }

              return out;
            };

            const gid = ${JSON.stringify(groupId)};
            const combinedBase = '/game.php?village=' + currentVid + '&screen=overview_villages&mode=combined&group=' + encodeURIComponent(gid);
            let villages = [];
            const seenIds = new Set();

            const firstRes = await fetch(combinedBase + '&page=-1', {
              headers: { 'accept': 'text/html,application/xhtml+xml' },
              credentials: 'include'
            });
            if (firstRes.ok) {
              const firstHtml = await firstRes.text();
              const firstDoc = parser.parseFromString(firstHtml, 'text/html');
              for (const v of parseCombinedDoc(firstDoc)) {
                if (!seenIds.has(v.id)) {
                  seenIds.add(v.id);
                  villages.push(v);
                }
              }
              const totalAccountVillages = parseInt(gd.player?.villages || '0', 10) || 0;
              if (gid === '0' && villages.length > 0 && villages.length < totalAccountVillages && totalAccountVillages > 1000) {
                for (let p = 1; p < 25; p++) {
                  const pRes = await fetch(combinedBase + '&page=' + p, {
                    headers: { 'accept': 'text/html,application/xhtml+xml' },
                    credentials: 'include'
                  });
                  if (!pRes.ok) break;
                  const pDoc = parser.parseFromString(await pRes.text(), 'text/html');
                  const parsed = parseCombinedDoc(pDoc);
                  let added = 0;
                  for (const v of parsed) {
                    if (!seenIds.has(v.id)) {
                      seenIds.add(v.id);
                      villages.push(v);
                      added++;
                    }
                  }
                  if (added === 0) break;
                }
              }
            }

            // Strategy C: Fallback for non-Premium accounts (#production_table + screen=place)
            if (villages.length === 0) {
              const prodRes = await fetch(base + 'overview_villages&mode=prod&group=' + encodeURIComponent(gid), {
                credentials: 'include'
              });
              if (prodRes.ok) {
                const pDoc = parser.parseFromString(await prodRes.text(), 'text/html');
                pDoc.querySelectorAll('#production_table tbody tr').forEach((tr) => {
                  const nameEl = tr.querySelector('.quickedit-vn');
                  const id = nameEl?.getAttribute('data-id') || '';
                  const fullText = (nameEl?.textContent || tr.textContent || '').trim();
                  const cm = /(\\d{1,3})\\|(\\d{1,3})/.exec(fullText);
                  if (!id || !cm) return;
                  const x = Number(cm[1]);
                  const y = Number(cm[2]);
                  const tds = Array.from(tr.querySelectorAll('td'));
                  const parseNum = (s) => Number(String(s || '').replace(/[^0-9]/g, '')) || 0;
                  const points = parseNum(tds[1]?.textContent);
                  const resSpans = Array.from(tr.querySelectorAll('.res, .warn, .warn_90'));
                  const wood = parseNum(resSpans[0]?.textContent);
                  const stone = parseNum(resSpans[1]?.textContent);
                  const iron = parseNum(resSpans[2]?.textContent);
                  const storage = parseNum(tds[3]?.textContent);
                  const popParts = String(tds[4]?.textContent || '0/0').split('/');
                  villages.push({
                    id,
                    name: cleanVillageName(fullText),
                    coords: x + '|' + y,
                    x,
                    y,
                    points,
                    wood,
                    stone,
                    iron,
                    storage,
                    pop: parseNum(popParts[0]),
                    popMax: parseNum(popParts[1]),
                    troops: {},
                  });
                });
              }

              if (villages.length === 0 && gd.village) {
                const v = gd.village;
                villages.push({
                  id: String(v.id || '1'),
                  name: String(v.name || 'Aldeia Principal'),
                  coords: String(v.coord || (v.x + '|' + v.y)),
                  x: Number(v.x || 500),
                  y: Number(v.y || 500),
                  points: Number(v.points || 0),
                  wood: Number(v.wood || 0),
                  stone: Number(v.stone || 0),
                  iron: Number(v.iron || 0),
                  storage: Number(v.storage_max || 0),
                  pop: Number(v.pop || 0),
                  popMax: Number(v.pop_max || 0),
                  troops: {},
                });
              }

              // Read home troops from Rally Point (screen=place) for up to 15 villages
              const allUnits = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
              for (const v of villages.slice(0, 15)) {
                try {
                  const pr = await fetch('/game.php?village=' + v.id + '&screen=place', { credentials: 'include' });
                  if (!pr.ok) continue;
                  const pDoc = parser.parseFromString(await pr.text(), 'text/html');
                  const troops = {};
                  for (const u of allUnits) {
                    const inp = pDoc.querySelector('#unit_input_' + u + ', input[name="' + u + '"]');
                    const cnt = inp ? parseInt(inp.getAttribute('data-all-count') || '0', 10) : 0;
                    if (Number.isFinite(cnt) && cnt > 0) troops[u] = cnt;
                  }
                  v.troops = troops;
                } catch {}
              }
            }

            return { ok: true, villages, groups };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        })();
      `)) as {
        ok: boolean;
        villages?: Array<Omit<TwVillage, 'updatedAt'>>;
        groups?: TwVillageGroup[];
        error?: string;
      };

      if (!scraped?.ok || !scraped.villages) {
        return {
          success: false,
          villages: account.villages || [],
          groups: account.villageGroups || [],
          error: scraped?.error || 'Não foi possível ler a Visão Combinada.',
        };
      }

      const now = new Date().toISOString();
      const prevById = new Map<string, TwVillage>();
      for (const prev of account.villages || []) {
        prevById.set(prev.id, prev);
      }

      const villages: TwVillage[] = scraped.villages.map((v) => {
        const prev = prevById.get(v.id);
        return {
          ...v,
          points: v.points || prev?.points || 0,
          wood: v.wood || prev?.wood || 0,
          stone: v.stone || prev?.stone || 0,
          iron: v.iron || prev?.iron || 0,
          storage: v.storage || prev?.storage || 0,
          pop: v.pop || prev?.pop || 0,
          popMax: v.popMax || prev?.popMax || 0,
          localCategory: prev?.localCategory,
          updatedAt: now,
        };
      });

      const groups = scraped.groups && scraped.groups.length > 0 ? scraped.groups : [{ id: '0', name: 'Todas' }];
      let savedVillages = account.villages || [];
      if (groupId === '0' || !account.villages || account.villages.length === 0) {
        savedVillages = this.store.setAccountVillages(accountId, villages);
      } else {
        // When syncing a specific group, update troops/metadata of matching villages without dropping villages outside that group
        const updatedMap = new Map(villages.map((v) => [v.id, v]));
        const mergedAll = (account.villages || []).map((existingV) => updatedMap.get(existingV.id) || existingV);
        for (const v of villages) {
          if (!mergedAll.some((e) => e.id === v.id)) mergedAll.push(v);
        }
        savedVillages = this.store.setAccountVillages(accountId, mergedAll);
      }
      this.store.setAccountVillageGroups(accountId, groups);

      this.store.addLog({
        accountId,
        accountName: account.username,
        level: 'success',
        message: `[Visão Combinada] ${villages.length} aldeia(s) e ${groups.length} grupo(s) sincronizados (Grupo ${groupId}).`,
      });

      return { success: true, villages: groupId === '0' ? savedVillages : villages, groups };
    } catch (err) {
      return {
        success: false,
        villages: account.villages || [],
        groups: account.villageGroups || [],
        error: err instanceof Error ? err.message : 'Erro ao ler visão combinada.',
      };
    }
  }

  /**
   * Wave 4 (Phase 16): Search target player & resolve all target villages
   * via `/map/player.txt` + `/map/village.txt` (15-min cache) with in-game `api&ajax=target_selection` fallback.
   */
  public async searchTargetPlayer(
    accountId: string,
    query: string
  ): Promise<{ success: boolean; matchedPlayers: TwTargetPlayer[]; villages: TwTargetVillage[]; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) {
      return { success: false, matchedPlayers: [], villages: [], error: 'Conta não encontrada.' };
    }

    const trimmedQuery = (query || '').trim();
    if (!trimmedQuery) {
      return { success: true, matchedPlayers: [], villages: [] };
    }

    const base = (account.serverUrl || `https://${account.world}.${account.domain}`).replace(/\/+$/, '');
    const worldKey = `${account.domain.toLowerCase()}:${account.world.toLowerCase()}`;

    const fetchWorldTxt = (url: string): Promise<string> =>
      new Promise((resolve) => {
        const client = url.startsWith('http://') ? http : https;
        const req = client.get(url, { timeout: 12000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            const isHtml = /^\s*<(?:!doctype|html|head|body)/i.test(body);
            resolve(res.statusCode && res.statusCode < 400 && !isHtml ? body : '');
          });
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => {
          req.destroy();
          resolve('');
        });
      });

    try {
      let cached = this.worldMapCache.get(worldKey);
      const cacheValid = cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000;

      if (!cacheValid) {
        let [playersTxt, villagesTxt] = await Promise.all([
          fetchWorldTxt(`${base}/map/player.txt`),
          fetchWorldTxt(`${base}/map/village.txt`),
        ]);

        // Fallback via active Electron session (useful when proxy or session cookies are required)
        const active = this.sessions.get(accountId);
        if ((!playersTxt || !villagesTxt) && active && !active.window.isDestroyed()) {
          try {
            const sessionGrab = (await active.window.webContents.executeJavaScript(`
              (async () => {
                const grab = async (name) => {
                  try {
                    const r = await fetch(location.origin + '/map/' + name + '.txt', { credentials: 'include' });
                    const txt = await r.text();
                    const isHtml = /^\\s*<(?:!doctype|html|head|body)/i.test(txt);
                    return r.ok && !isHtml ? txt : '';
                  } catch {
                    return '';
                  }
                };
                const [p, v] = await Promise.all([grab('player'), grab('village')]);
                return { p, v };
              })();
            `)) as { p?: string; v?: string };
            if (!playersTxt && sessionGrab?.p) playersTxt = sessionGrab.p;
            if (!villagesTxt && sessionGrab?.v) villagesTxt = sessionGrab.v;
          } catch {}
        }

        if (playersTxt || villagesTxt) {
          const players = parseWorldPlayersTxt(playersTxt);
          const playersById = new Map(players.map((p) => [p.id, p]));
          const villages = parseWorldVillagesTxt(villagesTxt, playersById);
          cached = { fetchedAt: Date.now(), players, villages };
          this.worldMapCache.set(worldKey, cached);
        }
      }

      let matchedPlayers: TwTargetPlayer[] = [];
      let villages: TwTargetVillage[] = [];

      if (cached && (cached.players.length > 0 || cached.villages.length > 0)) {
        const res = searchTargetPlayerVillages({
          query: trimmedQuery,
          players: cached.players,
          villages: cached.villages,
          limit: 300,
        });
        matchedPlayers = res.matchedPlayers;
        villages = res.villages;
      }

      // In-game fallback via api&ajax=target_selection when world txt yielded no results and session is active
      const active = this.sessions.get(accountId);
      if (villages.length === 0 && active && !active.window.isDestroyed()) {
        try {
          const isCoord = /^\d{1,3}\|\d{1,3}$/.test(trimmedQuery);
          const ajaxType = isCoord ? 'coord' : 'player_name';
          const ajaxRes = (await active.window.webContents.executeJavaScript(`
            (async () => {
              try {
                const gd = window.game_data;
                if (!gd || !gd.link_base_pure) return null;
                const url = gd.link_base_pure + 'api&ajax=target_selection&input=' + encodeURIComponent(${JSON.stringify(trimmedQuery)}) + '&type=${ajaxType}&request_id=1&limit=100&offset=0';
                const r = await fetch(url, { headers: { 'accept': 'application/json' }, credentials: 'include' });
                if (!r.ok) return null;
                return await r.json();
              } catch {
                return null;
              }
            })();
          `)) as {
            villages?: Array<{
              id?: string | number;
              name?: string;
              x?: number;
              y?: number;
              points?: number;
              player_id?: string | number;
              player_name?: string;
            }>;
          } | null;

          if (ajaxRes?.villages && Array.isArray(ajaxRes.villages)) {
            villages = ajaxRes.villages
              .filter((v) => v && v.x !== undefined && v.y !== undefined)
              .map((v) => {
                const x = Number(v.x);
                const y = Number(v.y);
                return {
                  id: String(v.id || `${x}|${y}`),
                  name: String(v.name || `Aldeia ${x}|${y}`),
                  coords: `${x}|${y}`,
                  x,
                  y,
                  points: Number(v.points) || 0,
                  continent: `K${Math.floor(y / 100)}${Math.floor(x / 100)}`,
                  playerId: String(v.player_id || '0'),
                  playerName: String(v.player_name || ''),
                };
              });
          }
        } catch {}
      }

      return { success: true, matchedPlayers, villages };
    } catch (err) {
      return {
        success: false,
        matchedPlayers: [],
        villages: [],
        error: err instanceof Error ? err.message : 'Falha ao buscar jogador/aldeias alvo.',
      };
    }
  }

  /**
   * Feature 3: Fetch Incoming Attacks & Classify Slowest Unit (`#incomings_table`)
   */
  public async fetchIncomingAttacks(
    accountId: string
  ): Promise<{ success: boolean; incomings: TwIncomingAttack[]; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) return { success: false, incomings: [], error: 'Conta não encontrada.' };

    const active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      return {
        success: false,
        incomings: account.incomingsList || [],
        error: 'Abra a sessão da conta para sincronizar ataques recebidos.',
      };
    }

    try {
      const scraped = (await active.window.webContents.executeJavaScript(`
        (async () => {
          try {
            const gd = window.game_data;
            if (!gd) return { ok: false, error: 'Sessão ainda não autenticada no mundo.' };
            const base = gd.link_base_pure || '/game.php?screen=';
            const res = await fetch(base + 'overview_villages&mode=incomings&type=unignored&subtype=attacks&group=0', { credentials: 'include' });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const rows = Array.from(doc.querySelectorAll('#incomings_table tr.row_a, #incomings_table tr.row_b'));
            const items = [];
            for (const tr of rows) {
              const input = tr.querySelector('input[name^="command_ids["]');
              const commandId = input?.value || String(Math.random());
              const labelEl = tr.querySelector('.quickedit-label');
              const label = (labelEl?.textContent || 'Ataque').trim();
              const tds = Array.from(tr.querySelectorAll('td'));
              const targetText = (tds[1]?.textContent || '').trim();
              const originText = (tds[2]?.textContent || '').trim();
              const attackerName = (tds[3]?.textContent || 'Desconhecido').trim();
              const timerEl = tr.querySelector('span.timer');
              const endTimeAttr = Number(timerEl?.getAttribute('data-endtime') || 0);
              const timerParts = String(timerEl?.textContent || '0:00:00').trim().split(':').map(Number);
              const remainingSec =
                timerParts.length === 3
                  ? timerParts[0] * 3600 + timerParts[1] * 60 + timerParts[2]
                  : 0;
              let arrivalMillis = 0;
              const msEl = tr.querySelector('span.grey.small, .grey.small');
              const msText = (msEl?.textContent || '').trim();
              const msMatch = /^(?:[:.])?(\\d{3})$/.exec(msText) || /[:.](\\d{3})\\b/.exec(msText);
              if (msMatch) {
                arrivalMillis = Number(msMatch[1]);
              } else {
                for (const td of tds) {
                  if (timerEl && td.contains(timerEl)) continue;
                  const cellText = (td.textContent || '').trim();
                  const fullMsMatch = /\\d{1,2}:\\d{2}:\\d{2}\\s*[:.]\\s*(\\d{3})/.exec(cellText);
                  if (fullMsMatch) {
                    arrivalMillis = Number(fullMsMatch[1]);
                    break;
                  }
                }
              }
              const extractCoords = (s) => {
                const m = /(\\d{1,3}\\|\\d{1,3})/.exec(s);
                return m ? m[1] : '500|500';
              };
              items.push({
                commandId,
                label,
                originName: originText,
                originCoords: extractCoords(originText),
                targetName: targetText,
                targetCoords: extractCoords(targetText),
                attackerName,
                remainingSec,
                endTimeSec: Number.isFinite(endTimeAttr) && endTimeAttr > 0 ? endTimeAttr : 0,
                arrivalMillis: Number.isFinite(arrivalMillis) ? arrivalMillis : 0
              });
            }
            return { ok: true, items, incomingsHeaderCount: Number(gd.player?.incomings || items.length) };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        })();
      `)) as {
        ok: boolean;
        items?: Array<{
          commandId: string;
          label: string;
          originName: string;
          originCoords: string;
          targetName: string;
          targetCoords: string;
          attackerName: string;
          remainingSec: number;
          endTimeSec?: number;
          arrivalMillis?: number;
        }>;
        error?: string;
      };

      if (!scraped?.ok || !scraped.items) {
        return {
          success: false,
          incomings: account.incomingsList || [],
          error: scraped?.error || 'Falha ao ler #incomings_table.',
        };
      }

      const nowMs = Date.now();
      const baseNowSec = Math.floor(nowMs / 1000);
      const nowIso = new Date().toISOString();
      const incomings: TwIncomingAttack[] = scraped.items.map((item) => {
        const dist = Number(calculateDistance(item.originCoords, item.targetCoords).toFixed(2));
        const detectedUnit = classifyIncomingAttackUnit(dist, item.remainingSec);
        const msPart = Math.max(0, Math.min(999, Math.round(item.arrivalMillis || 0)));
        const arrivalTimeMs = (baseNowSec + item.remainingSec) * 1000 + msPart;
        return {
          id: `${accountId}-${item.commandId}`,
          accountId,
          accountName: account.username,
          commandId: item.commandId,
          originName: item.originName,
          originCoords: item.originCoords,
          targetName: item.targetName,
          targetCoords: item.targetCoords,
          attackerName: item.attackerName,
          arrivalTimeMs,
          remainingSec: item.remainingSec,
          distance: dist,
          detectedUnit,
          label: item.label,
          updatedAt: nowIso,
        };
      });

      this.store.setAccountIncomings(accountId, incomings);
      return { success: true, incomings };
    } catch (err) {
      return {
        success: false,
        incomings: account.incomingsList || [],
        error: err instanceof Error ? err.message : 'Erro ao buscar ataques a chegar.',
      };
    }
  }

  /**
   * Fetches `/interface.php?func=get_config` and `/interface.php?func=get_unit_info` directly from the
   * Tribal Wars world server (with optional active-window `window.game_data` enrichment) and caches it in DataStore.
   */
  public async fetchWorldConfig(
    accountId: string
  ): Promise<{ success: boolean; worldConfig?: TwWorldConfig; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) {
      return { success: false, error: 'Conta não encontrada.' };
    }

    const base = (account.serverUrl || `https://${account.world}.${account.domain}`).replace(/\/+$/, '');
    const fetchUrlText = (url: string): Promise<string> =>
      new Promise((resolve) => {
        const req = https.get(url, { timeout: 7000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve(res.statusCode && res.statusCode < 400 ? body : ''));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => {
          req.destroy();
          resolve('');
        });
      });

    try {
      const [configXml, unitInfoXml] = await Promise.all([
        fetchUrlText(`${base}/interface.php?func=get_config`),
        fetchUrlText(`${base}/interface.php?func=get_unit_info`),
      ]);

      let parsed = parseWorldConfigXml(configXml, unitInfoXml);

      // If an active browser session is open on the game, also inspect window.game_data.world_config as fallback/enrichment
      const active = this.sessions.get(accountId);
      if (active && !active.window.isDestroyed()) {
        try {
          const liveGd = (await active.window.webContents.executeJavaScript(`
            (() => {
              try {
                const wc = window.game_data?.world_config;
                if (!wc) return null;
                return {
                  speed: parseFloat(wc.speed) || null,
                  unitSpeed: parseFloat(wc.unit_speed) || null,
                  archer: wc.archer !== undefined ? String(wc.archer) === '1' : null,
                  paladin: wc.knight !== undefined ? String(wc.knight) === '1' : null,
                  church: wc.church !== undefined ? String(wc.church) === '1' : null,
                  watchtower: wc.watchtower !== undefined ? String(wc.watchtower) === '1' : null,
                  moral: wc.moral !== undefined ? String(wc.moral) === '1' : null,
                };
              } catch {
                return null;
              }
            })();
          `)) as Partial<TwWorldConfig> | null;

          if (liveGd && !configXml) {
            const speed = liveGd.speed || parsed.speed;
            const unitSpeed = liveGd.unitSpeed || parsed.unitSpeed;
            parsed = {
              ...parsed,
              speed,
              unitSpeed,
              archer: liveGd.archer ?? parsed.archer,
              paladin: liveGd.paladin ?? parsed.paladin,
              church: liveGd.church ?? parsed.church,
              watchtower: liveGd.watchtower ?? parsed.watchtower,
              moral: liveGd.moral ?? parsed.moral,
            };
          }
        } catch {
          // Ignore if session is not on a game_data screen
        }
      }

      const worldConfig: TwWorldConfig = {
        worldKey: `${account.domain.toLowerCase()}:${account.world.toLowerCase()}`,
        domain: account.domain,
        world: account.world,
        ...parsed,
        fetchedAt: new Date().toISOString(),
      };

      const saved = this.store.saveWorldConfig(worldConfig, accountId);
      this.store.addLog({
        accountId,
        accountName: account.username,
        level: 'info',
        message: `Configuração do mundo ${account.world.toUpperCase()} sincronizada: Vel. ${saved.speed}x | Unid. ${saved.unitSpeed}x.`,
      });
      return { success: true, worldConfig: saved };
    } catch (err) {
      const cached = account.worldConfig || this.store.getWorldConfig(account.domain, account.world);
      if (cached) {
        return { success: true, worldConfig: cached };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Falha ao buscar configurações do mundo.',
      };
    }
  }

  /**
   * Feature 1 Helper (Stage 1 — Wake / Prep):
   * Opens Rally Point with `&x={targetX}&y={targetY}` in the URL so Tribal Wars' server natively resolves and
   * populates `#inputx` and `#inputy`, preventing "Por favor, selecione uma aldeia alvo."
   * Also implements an automatic pure-AJAX fallback (`api&ajax=target_selection` -> `TribalWars.post('place', { ajax: 'confirm' })`)
   * in case the DOM confirmation form is not reached via click.
   */
  private async loadWindowUrlSafe(win: BrowserWindow, targetUrl: string): Promise<void> {
    if (win.isDestroyed()) return;
    try {
      await win.loadURL(targetUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('ERR_ABORTED') && !msg.includes('(-3)')) {
        throw err;
      }
    }
  }

  /**
   * Wave 4 (Phase 18): Acquires an isolated BrowserWindow for a scheduled command.
   * Uses the account's primary window if idle; if busy with another concurrent command,
   * reuses an idle secondary window or spawns a temporary parallel BrowserWindow on the
   * same `persist:tw-<accountId>` session partition.
   */
  private async acquireCommandWindow(
    account: TwAccount,
    cmd: ScheduledCommand,
    rallyUrl: string
  ): Promise<{ win: BrowserWindow | null; error?: string }> {
    const existingAssigned = this.commandWindows.get(cmd.id);
    if (existingAssigned && !existingAssigned.isDestroyed()) {
      this.busyWindows.add(existingAssigned.id);
      existingAssigned.show();
      existingAssigned.focus();
      try {
        await this.loadWindowUrlSafe(existingAssigned, rallyUrl);
        return { win: existingAssigned };
      } catch (err) {
        return {
          win: null,
          error: err instanceof Error ? err.message : 'Falha ao carregar Praça de Reunião.',
        };
      }
    }

    let active = this.sessions.get(cmd.accountId);
    if (!active || active.window.isDestroyed()) {
      const launched = await this.launchSession(cmd.accountId, { visible: true, targetUrl: rallyUrl });
      if (!launched.success) {
        return { win: null, error: launched.error || 'Falha ao abrir sessão da conta.' };
      }
      active = this.sessions.get(cmd.accountId);
      if (!active || active.window.isDestroyed()) {
        return { win: null, error: 'Janela da sessão indisponível.' };
      }
      if (!this.busyWindows.has(active.window.id)) {
        this.busyWindows.add(active.window.id);
        this.commandWindows.set(cmd.id, active.window);
        return { win: active.window };
      }
    }

    if (!this.busyWindows.has(active.window.id)) {
      this.busyWindows.add(active.window.id);
      this.commandWindows.set(cmd.id, active.window);
      active.window.show();
      active.window.focus();
      try {
        await this.loadWindowUrlSafe(active.window, rallyUrl);
        return { win: active.window };
      } catch (err) {
        this.releaseCommandWindow(cmd.id, false);
        return {
          win: null,
          error: err instanceof Error ? err.message : 'Falha ao carregar Praça de Reunião.',
        };
      }
    }

    // Primary window is currently occupied by another command: find an idle secondary window or spawn a worker
    let workerWin: BrowserWindow | null = null;
    for (const extra of active.extraWindows) {
      if (!extra.isDestroyed() && !this.busyWindows.has(extra.id)) {
        workerWin = extra;
        break;
      }
    }

    if (!workerWin) {
      const partitionName = `persist:tw-${account._id}`;
      workerWin = this.createGameWindow(account, rallyUrl, partitionName, false, true);
      active.extraWindows.add(workerWin);
      this.autoWorkerWindows.add(workerWin.id);
      this.store.addLog({
        accountId: account._id,
        accountName: account.username,
        level: 'info',
        message: `[Multi-Janela] Abrindo janela paralela para preparo/envio simultâneo (${cmd.originCoords} -> ${cmd.targetCoords}).`,
      });
    }

    this.busyWindows.add(workerWin.id);
    this.commandWindows.set(cmd.id, workerWin);
    workerWin.show();
    workerWin.focus();
    try {
      await this.loadWindowUrlSafe(workerWin, rallyUrl);
      return { win: workerWin };
    } catch (err) {
      this.releaseCommandWindow(cmd.id, true);
      return {
        win: null,
        error: err instanceof Error ? err.message : 'Falha ao abrir janela paralela para o comando.',
      };
    }
  }

  public releaseCommandWindow(commandId: string, closeAutoWorker = true): void {
    const win = this.commandWindows.get(commandId);
    this.commandWindows.delete(commandId);
    if (!win || win.isDestroyed()) return;
    const winId = win.id;
    this.busyWindows.delete(winId);
    if (closeAutoWorker && this.autoWorkerWindows.has(winId)) {
      this.autoWorkerWindows.delete(winId);
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.close();
        } catch {
          // Ignore close errors on already-destroyed window
        }
      }, 1500);
    }
  }

  public async prepareRallyPoint(
    cmd: ScheduledCommand
  ): Promise<{ success: boolean; prepared?: boolean; error?: string }> {
    const existingLock = this.prepareLocks.get(cmd.id);
    if (existingLock) {
      return existingLock;
    }

    const promise = this.prepareRallyPointInternal(cmd).finally(() => {
      this.prepareLocks.delete(cmd.id);
    });
    this.prepareLocks.set(cmd.id, promise);
    return promise;
  }

  private async prepareRallyPointInternal(
    cmd: ScheduledCommand
  ): Promise<{ success: boolean; prepared?: boolean; error?: string }> {
    const account = this.store.getAccountById(cmd.accountId);
    if (!account) return { success: false, error: 'Conta não encontrada.' };

    const target = parseCoords(cmd.targetCoords);
    if (!target) {
      return { success: false, error: 'Coordenadas de destino inválidas.' };
    }

    // Early-return if this exact command is already open on the Confirmation Screen in its assigned or idle primary window
    const existingSession = this.sessions.get(cmd.accountId);
    const candidateWin =
      this.commandWindows.get(cmd.id) ||
      (existingSession && !existingSession.window.isDestroyed() && !this.busyWindows.has(existingSession.window.id)
        ? existingSession.window
        : null);
    if (candidateWin && !candidateWin.isDestroyed()) {
      try {
        const alreadyConfirm = await candidateWin.webContents.executeJavaScript(`
          Boolean(
            window.__twPreparedCommand?.commandId === ${JSON.stringify(cmd.id)} &&
            document.querySelector('#command-data-form input[name="ch"]') &&
            document.querySelector('#troop_confirm_submit')
          )
        `);
        if (alreadyConfirm) {
          this.busyWindows.add(candidateWin.id);
          this.commandWindows.set(cmd.id, candidateWin);
          candidateWin.show();
          candidateWin.focus();
          return { success: true, prepared: true };
        }
      } catch {
        // Proceed with full navigation & preparation
      }
    }

    const base = (account.serverUrl || `https://${account.world}.${account.domain}`).replace(/\/+$/, '');
    const villageParam = cmd.originVillageId ? `village=${cmd.originVillageId}&` : '';
    // Pass `&x=${target.x}&y=${target.y}` directly in the URL so Tribal Wars server-side pre-resolves the target village!
    const rallyUrl = `${base}/game.php?${villageParam}screen=place&x=${target.x}&y=${target.y}`;

    const acquired = await this.acquireCommandWindow(account, cmd, rallyUrl);
    if (!acquired.win || acquired.win.isDestroyed()) {
      return { success: false, error: acquired.error || 'Janela da sessão indisponível.' };
    }
    const targetWin = acquired.win;

    const totalWaves = Math.max(1, cmd.waves || 1);
    const allWavesTroops =
      cmd.allWavesTroops && cmd.allWavesTroops.length > 0
        ? cmd.allWavesTroops
        : Array.from({ length: totalWaves }, () => ({ ...(cmd.troops || {}) }));

    const phase1PayloadJson = JSON.stringify({
      commandId: cmd.id,
      originVillageId: cmd.originVillageId || '',
      x: target.x,
      y: target.y,
      troops: cmd.troops,
      allWavesTroops,
      commandType: cmd.commandType,
      waves: totalWaves,
      sendAllTroops: Boolean(cmd.autoDodge?.enabled && cmd.autoDodge?.sendAllTroops),
    });

    const sleepNode = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const actionSelector =
      cmd.commandType === 'support'
        ? '#target_support, input[name="support"]'
        : '#target_attack, input[name="attack"]';

    let prepSucceeded = false;
    try {
      // PHASE 1: On screen=place, read stock, allocate waves, fill Wave 1 + coords, and click #target_attack/#target_support asynchronously
      const phase1Result = (await targetWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const cfg = ${phase1PayloadJson};
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const allUnits = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
            const totalWaves = Math.max(1, Number(cfg.waves) || 1);
            const allWavesTroops = Array.isArray(cfg.allWavesTroops) && cfg.allWavesTroops.length > 0
              ? cfg.allWavesTroops
              : Array.from({ length: totalWaves }, () => ({ ...(cfg.troops || {}) }));

            // 1. Wait up to 8s for Rally Point form + action button
            let inputX = null;
            let inputY = null;
            for (let i = 0; i < 80; i++) {
              if (
                document.getElementById('botprotection_quest') ||
                document.getElementById('bot_check') ||
                document.querySelector('.captcha, #popup_box_bot_protection')
              ) {
                return {
                  ok: false,
                  error: 'O jogo solicitou verificação anti-robô (CAPTCHA). Resolva na janela da conta.'
                };
              }
              if (document.querySelector('#login_form, form[action*="login"], input[name="password"]')) {
                return {
                  ok: false,
                  error: 'A sessão do jogo está desconectada (tela de login). Conecte na conta primeiro.'
                };
              }
              const readyState = document.readyState;
              inputX = document.querySelector('#inputx, input[name="x"]');
              inputY = document.querySelector('#inputy, input[name="y"]');
              const actionBtnReady = document.querySelector('#target_attack, #target_support');
              if (
                (readyState === 'interactive' || readyState === 'complete') &&
                inputX &&
                inputY &&
                actionBtnReady
              ) {
                break;
              }
              await sleep(100);
            }

            if (!inputX || !inputY) {
              return { ok: false, error: 'Formulário da Praça de Reunião não carregou a tempo.' };
            }

            // 2. Ensure target coordinates (X|Y) are populated and synced
            for (let i = 0; i < 20; i++) {
              const curX = String(inputX.value || '').trim();
              const curY = String(inputY.value || '').trim();
              if (curX === String(cfg.x) && curY === String(cfg.y)) break;
              inputX.value = String(cfg.x);
              inputX.dispatchEvent(new Event('input', { bubbles: true }));
              inputX.dispatchEvent(new Event('change', { bubbles: true }));
              inputX.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              inputY.value = String(cfg.y);
              inputY.dispatchEvent(new Event('input', { bubbles: true }));
              inputY.dispatchEvent(new Event('change', { bubbles: true }));
              inputY.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              const coordField = document.querySelector('#place_target input, input.target-input-field');
              if (coordField && !coordField.name) {
                coordField.value = cfg.x + '|' + cfg.y;
                coordField.dispatchEvent(new Event('input', { bubbles: true }));
                coordField.dispatchEvent(new Event('change', { bubbles: true }));
              }
              await sleep(100);
            }

            // 3. Read available stock (data-all-count) and compute wave allocation across Waves 1..N
            const stockAtPlace = {};
            const unitInputs = {};
            for (const unit of allUnits) {
              const el = document.querySelector('#unit_input_' + unit + ', input[name="' + unit + '"]');
              if (!el) continue;
              unitInputs[unit] = el;
              const availAttr = el.getAttribute('data-all-count');
              if (availAttr !== null) {
                const parsedAvail = parseInt(availAttr, 10);
                if (Number.isFinite(parsedAvail) && parsedAvail >= 0) {
                  stockAtPlace[unit] = parsedAvail;
                }
              } else {
                const allLink = document.querySelector('#units_entry_all_' + unit);
                if (allLink) {
                  const mAll = /\\((\\d+)\\)/.exec(allLink.textContent || '');
                  if (mAll) stockAtPlace[unit] = parseInt(mAll[1], 10) || 0;
                }
              }
            }

            const hasExplicitTroops = allWavesTroops.some((wReq) =>
              Object.values(wReq || {}).some((qty) => (Number(qty) || 0) > 0)
            );

            const pool = { ...stockAtPlace };
            const waveAlloc = [];
            for (let w = 0; w < totalWaves; w++) {
              const req = allWavesTroops[w] || cfg.troops || {};
              const alloc = {};
              if (cfg.sendAllTroops && !hasExplicitTroops && w === 0) {
                for (const unit of allUnits) {
                  const avail = pool[unit] ?? 0;
                  if (avail > 0) {
                    alloc[unit] = avail;
                    pool[unit] = 0;
                  }
                }
              } else {
                for (const unit of allUnits) {
                  const wanted = Number(req[unit]) || 0;
                  if (wanted <= 0) continue;
                  const avail = pool[unit] !== undefined ? pool[unit] : wanted;
                  const grant = Math.min(wanted, Math.max(0, avail));
                  if (grant > 0) {
                    alloc[unit] = grant;
                    if (pool[unit] !== undefined) pool[unit] -= grant;
                  }
                }
              }
              waveAlloc.push(alloc);
            }

            // Clear any pre-filled unit inputs first
            document.querySelectorAll('input.unitsInput').forEach((inp) => {
              inp.value = '';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            });

            // Fill Wave 1 into screen=place
            const wave1Alloc = waveAlloc[0] || {};
            const filledUnits = {};
            for (const unit of allUnits) {
              const toFill = Number(wave1Alloc[unit]) || 0;
              if (toFill <= 0) continue;
              const el = unitInputs[unit];
              if (!el) continue;
              el.value = String(toFill);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              filledUnits[unit] = toFill;
            }

            if (Object.keys(filledUnits).length === 0) {
              return {
                ok: false,
                error: 'Nenhuma tropa pôde ser preenchida na Praça de Reunião (a aldeia de origem não possui estoque das unidades selecionadas).'
              };
            }

            const gd = window.game_data || {};
            const villageId = String(cfg.originVillageId || (gd.village && gd.village.id) || '');
            const isSupport = cfg.commandType === 'support';
            const actionBtn = document.querySelector(
              isSupport ? '#target_support, input[name="support"]' : '#target_attack, input[name="attack"]'
            );
            if (!actionBtn) {
              return { ok: false, error: 'Botão de Atacar/Apoiar (#target_attack / #target_support) não encontrado.' };
            }

            // Schedule click slightly after return so this executeJavaScript resolves before full-page POST navigation unloads the document
            setTimeout(() => {
              try { actionBtn.click(); } catch {}
            }, 25);

            return {
              ok: true,
              villageId,
              stockAtPlace,
              waveAlloc,
              filledUnits
            };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
      `)) as {
        ok: boolean;
        error?: string;
        villageId?: string;
        stockAtPlace?: Record<string, number>;
        waveAlloc?: Array<Record<string, number>>;
        filledUnits?: Record<string, number>;
      };

      if (!phase1Result?.ok) {
        return {
          success: false,
          error: phase1Result?.error || 'Falha ao preencher tropas na Praça de Reunião.',
        };
      }

      // PHASE 2: Orchestrate polling from Node.js across the full-page POST navigation to screen=place&try=confirm
      let confirmationReady = false;
      let refusalError = '';
      for (let attempt = 0; attempt < 90; attempt++) {
        await sleepNode(120);
        if (targetWin.isDestroyed() || targetWin.webContents.isDestroyed()) {
          return {
            success: false,
            error: 'Janela da sessão fechada ao aguardar tela de confirmação.',
          };
        }
        try {
          const probe = (await targetWin.webContents.executeJavaScript(`
            (() => {
              if (
                document.getElementById('botprotection_quest') ||
                document.getElementById('bot_check') ||
                document.querySelector('.captcha, #popup_box_bot_protection')
              ) {
                return { status: 'bot' };
              }
              if (document.querySelector('#login_form, form[action*="login"], input[name="password"]')) {
                return { status: 'login' };
              }
              const errEl = document.querySelector('.error_box, .error, #error, .inlineError');
              const errText = errEl ? (errEl.textContent || '').trim() : '';
              if (errText) {
                return { status: 'error', error: errText };
              }
              const hasForm = Boolean(document.querySelector('#command-data-form'));
              const hasCh = Boolean(document.querySelector('#command-data-form input[name="ch"]'));
              const hasConfirmBtn = Boolean(document.querySelector('#troop_confirm_submit'));
              if (hasForm && hasCh && hasConfirmBtn) {
                return { status: 'ready' };
              }
              const stillOnPlace = Boolean(document.querySelector(${JSON.stringify(actionSelector)}));
              return { status: 'waiting', stillOnPlace };
            })();
          `)) as { status: string; error?: string; stillOnPlace?: boolean };

          if (probe.status === 'ready') {
            confirmationReady = true;
            break;
          }
          if (probe.status === 'bot') {
            return {
              success: false,
              error: 'O jogo solicitou verificação anti-robô (CAPTCHA). Resolva na janela da conta.',
            };
          }
          if (probe.status === 'login') {
            return {
              success: false,
              error: 'A sessão do jogo está desconectada (tela de login). Conecte na conta primeiro.',
            };
          }
          if (probe.status === 'error' && probe.error) {
            refusalError = probe.error;
            break;
          }
          // Retry click once at ~3s if page stayed on screen=place without transitioning
          if (attempt === 25 && probe.stillOnPlace) {
            await targetWin.webContents
              .executeJavaScript(
                `(() => { const b = document.querySelector(${JSON.stringify(actionSelector)}); if (b) b.click(); })();`
              )
              .catch(() => {});
          }
        } catch {
          // Expected transient rejection while webContents transitions between documents
        }
      }

      // Fallback to pure AJAX Confirm Dialog only if DOM transition did not reach Confirmation Screen
      if (!confirmationReady) {
        if (!targetWin.isDestroyed() && !targetWin.webContents.isDestroyed()) {
          const ajaxFallbackPayload = JSON.stringify({
            commandId: cmd.id,
            originVillageId: phase1Result.villageId || cmd.originVillageId || '',
            x: target.x,
            y: target.y,
            troops: cmd.troops,
            allWavesTroops: phase1Result.waveAlloc || allWavesTroops,
            filledUnits: phase1Result.filledUnits || {},
            commandType: cmd.commandType,
            waves: totalWaves,
            refusalError,
          });
          const ajaxPrep = (await targetWin.webContents.executeJavaScript(`
            (async () => {
              const cfg = ${ajaxFallbackPayload};
              const gd = window.game_data || {};
              const villageId = String(cfg.originVillageId || (gd.village && gd.village.id) || '');
              const isSupport = cfg.commandType === 'support';
              if (typeof window.TribalWars === 'undefined' || typeof window.$ === 'undefined') {
                return { ok: false, error: cfg.refusalError || 'Tela de confirmação não carregou.' };
              }
              return await new Promise((resolveAjax) => {
                try {
                  const base = gd.link_base_pure || ('/game.php?village=' + villageId + '&screen=');
                  fetch(base + 'api&ajax=target_selection&input=' + cfg.x + '|' + cfg.y + '&type=coord', {
                    credentials: 'include'
                  })
                    .then((r) => r.json())
                    .then((targetData) => {
                      const targetVillageId = targetData?.villages?.[0]?.id || '';
                      window.TribalWars.get(
                        'place',
                        { village: villageId, target: targetVillageId, ajax: 'command' },
                        (cmdResp) => {
                          if (!cmdResp || cmdResp.error) {
                            resolveAjax({
                              ok: false,
                              error: (cmdResp?.error && cmdResp.error[0]) || cfg.refusalError || 'Erro ao abrir comando via AJAX.'
                            });
                            return;
                          }
                          const data = window.$(cmdResp.dialog).find('input[type=hidden]').serializeArray();
                          data.push({ name: isSupport ? 'support' : 'attack', value: 'l' });
                          data.push({ name: 'x', value: String(cfg.x) });
                          data.push({ name: 'y', value: String(cfg.y) });
                          for (const [u, qty] of Object.entries(cfg.filledUnits || {})) {
                            data.push({ name: u, value: String(qty) });
                          }
                          window.TribalWars.post(
                            'place',
                            { village: villageId, ajax: 'confirm' },
                            data,
                            (confirmResp) => {
                              if (!confirmResp || confirmResp.error) {
                                resolveAjax({
                                  ok: false,
                                  error:
                                    (confirmResp?.error && confirmResp.error[0]) ||
                                    cfg.refusalError ||
                                    'Jogo recusou a confirmação do comando.'
                                });
                                return;
                              }
                              const finalFields = window.$(confirmResp.dialog).serializeArray();
                              const urlParams = new URLSearchParams();
                              let hToken = gd.csrf || window.csrf_token || '';
                              let hasCb = false;
                              let hasVil = false;
                              for (const f of finalFields) {
                                urlParams.append(f.name, f.value);
                                if (f.name === 'h') hToken = f.value;
                                if (f.name === 'cb') hasCb = true;
                                if (f.name === 'village') hasVil = true;
                              }
                              if (!hasCb) urlParams.append('cb', 'troop_confirm_submit');
                              if (!hasVil && villageId) urlParams.append('village', villageId);
                              const extraWaves = [];
                              for (let idx = 1; idx < cfg.waves; idx++) {
                                extraWaves.push((cfg.allWavesTroops && cfg.allWavesTroops[idx]) || cfg.troops || {});
                              }
                              const state = {
                                commandId: cfg.commandId,
                                villageId,
                                csrfToken: hToken,
                                serializedForm: urlParams.toString(),
                                targetX: cfg.x,
                                targetY: cfg.y,
                                commandType: cfg.commandType,
                                extraWavesTroops: extraWaves,
                                trainsAdded: 0,
                                preparedAt: Date.now()
                              };
                              window.__twPreparedCommand = state;
                              resolveAjax({ ok: true, prepared: true, state });
                            }
                          );
                        }
                      );
                    })
                    .catch((err) => resolveAjax({ ok: false, error: String(err) }));
                } catch (err) {
                  resolveAjax({ ok: false, error: String(err) });
                }
              });
            })();
          `)) as { ok: boolean; error?: string; state?: PreparedCommandState };

          if (ajaxPrep?.ok && ajaxPrep.state) {
            this.preparedCommands.set(cmd.id, ajaxPrep.state);
            prepSucceeded = true;
            return { success: true, prepared: true };
          }
          return {
            success: false,
            error:
              ajaxPrep?.error ||
              refusalError ||
              'A Praça de Reunião não avançou para a tela de confirmação (#troop_confirm_submit ausente).',
          };
        }
        return {
          success: false,
          error:
            refusalError ||
            'A Praça de Reunião não avançou para a tela de confirmação (#troop_confirm_submit ausente).',
        };
      }

      // PHASE 3: Inside the fresh Confirmation Screen document, add extra waves via #troop_confirm_train (any unit type!) and serialize form
      const phase3PayloadJson = JSON.stringify({
        commandId: cmd.id,
        x: target.x,
        y: target.y,
        commandType: cmd.commandType,
        waves: totalWaves,
        villageId: phase1Result.villageId || cmd.originVillageId || '',
        stockAtPlace: phase1Result.stockAtPlace || {},
        waveAlloc: phase1Result.waveAlloc || allWavesTroops,
        filledUnits: phase1Result.filledUnits || {},
      });

      const phase3Result = (await targetWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const cfg = ${phase3PayloadJson};
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const allUnits = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
            const totalWaves = Math.max(1, Number(cfg.waves) || 1);
            const gd = window.game_data || {};
            const villageId = String(cfg.villageId || (gd.village && gd.village.id) || '');

            // 1. Read canonical available_units from confirmation screen HTML if present; fallback to Phase 1 stockAtPlace
            const stock = {};
            try {
              const html = document.documentElement.innerHTML;
              const m = html.match(/"available_units"\\s*:\\s*(\\{[^}]*\\})/);
              if (m) {
                const au = JSON.parse(m[1]);
                for (const unit of allUnits) {
                  stock[unit] = parseInt(au[unit] || 0, 10) || 0;
                }
              }
            } catch {}
            for (const unit of allUnits) {
              if (stock[unit] === undefined && cfg.stockAtPlace && typeof cfg.stockAtPlace[unit] === 'number') {
                stock[unit] = cfg.stockAtPlace[unit];
              }
            }

            // 2. Subtract Wave 1 units and compute allocated extra waves (Waves 2..totalWaves)
            const remaining = {};
            for (const unit of allUnits) {
              if (stock[unit] !== undefined) {
                const used1 = (cfg.filledUnits && cfg.filledUnits[unit]) || 0;
                remaining[unit] = Math.max(0, stock[unit] - used1);
              }
            }

            const sendWaves = [];
            for (let w = 1; w < totalWaves; w++) {
              const req = (cfg.waveAlloc && cfg.waveAlloc[w]) || {};
              const alloc = {};
              let totalCount = 0;
              for (const unit of allUnits) {
                const want = Number(req[unit]) || 0;
                if (want <= 0) continue;
                const g = remaining[unit] !== undefined ? Math.min(want, remaining[unit]) : want;
                if (g > 0) {
                  alloc[unit] = g;
                  if (remaining[unit] !== undefined) remaining[unit] -= g;
                  totalCount += g;
                }
              }
              if (totalCount > 0) {
                sendWaves.push(alloc);
              }
            }

            // 3. Two-loop pattern for #troop_confirm_train (supports any unit type, not just nobles):
            // Loop 1: click #troop_confirm_train once per extra wave with 300ms pause so all train[2..N] rows render first
            let trainsAdded = 0;
            if (sendWaves.length > 0) {
              for (let k = 0; k < sendWaves.length; k++) {
                const addAttackBtn = document.querySelector('#troop_confirm_train');
                if (!addAttackBtn || addAttackBtn.classList.contains('btn-disabled')) break;
                addAttackBtn.click();
                trainsAdded++;
                await sleep(300);
              }
            }

            // Loop 2: fill ALL 12 units for each added wave (train[2..N]) and explicitly clear default values on 0 units
            for (let k = 0; k < trainsAdded; k++) {
              const trainIndex = k + 2;
              const waveUnits = sendWaves[k] || {};
              for (const unit of allUnits) {
                const input = document.querySelector('input[name="train[' + trainIndex + '][' + unit + ']"]');
                if (!input) continue;
                const v = Number(waveUnits[unit]) || 0;
                input.value = v > 0 ? String(v) : '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }

            await sleep(100);

            // 4. Re-query #command-data-form after DOM updates from #troop_confirm_train
            let confirmForm = document.querySelector('#command-data-form');
            for (let i = 0; i < 30 && !confirmForm; i++) {
              await sleep(100);
              confirmForm = document.querySelector('#command-data-form');
            }
            if (!confirmForm) {
              return { ok: false, error: '#command-data-form ausente após configurar ondas.' };
            }

            // Prepare mandatory hidden fields for AJAX popup_command submission
            const cbInput = confirmForm.querySelector('input[name="cb"]');
            if (cbInput) {
              cbInput.value = 'troop_confirm_submit';
            } else {
              const hiddenCb = document.createElement('input');
              hiddenCb.type = 'hidden';
              hiddenCb.name = 'cb';
              hiddenCb.value = 'troop_confirm_submit';
              confirmForm.appendChild(hiddenCb);
            }
            if (villageId && !confirmForm.querySelector('input[name="village"]')) {
              const hiddenVil = document.createElement('input');
              hiddenVil.type = 'hidden';
              hiddenVil.name = 'village';
              hiddenVil.value = villageId;
              confirmForm.appendChild(hiddenVil);
            }

            const csrfToken =
              confirmForm.getAttribute('data-csrf') ||
              document.querySelector('input[name="h"]')?.value ||
              gd.csrf ||
              window.csrf_token ||
              '';

            const params = [];
            confirmForm.querySelectorAll('input, select, textarea').forEach((el) => {
              if (!el.name) return;
              if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
              params.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value || ''));
            });
            const serializedForm = params.join('&');

            // Collect any waves not added natively via #troop_confirm_train (e.g. Motor 2 sequential AJAX fallback)
            const remainingExtraWaves = sendWaves.slice(trainsAdded);

            const state = {
              commandId: cfg.commandId,
              villageId,
              csrfToken,
              serializedForm,
              targetX: cfg.x,
              targetY: cfg.y,
              commandType: cfg.commandType,
              extraWavesTroops: remainingExtraWaves,
              trainsAdded,
              preparedAt: Date.now()
            };

            window.__twPreparedCommand = state;
            return { ok: true, prepared: true, state };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
      `)) as { ok: boolean; error?: string; state?: PreparedCommandState };

      if (!phase3Result?.ok || !phase3Result.state) {
        return {
          success: false,
          error: phase3Result?.error || 'Falha ao configurar ondas na tela de confirmação.',
        };
      }

      this.preparedCommands.set(cmd.id, phase3Result.state);
      this.store.addLog({
        accountId: cmd.accountId,
        accountName: account.username,
        level: 'info',
        message: `Tela de confirmação preparada: ${1 + phase3Result.state.trainsAdded} onda(s) no formulário${
          phase3Result.state.extraWavesTroops.length > 0
            ? ` + ${phase3Result.state.extraWavesTroops.length} onda(s) na fila AJAX`
            : ''
        }.`,
      });

      prepSucceeded = true;
      return { success: true, prepared: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Erro na preparação da Praça de Reunião.',
      };
    } finally {
      if (!prepSucceeded) {
        this.releaseCommandWindow(cmd.id, true);
      }
    }
  }

  /**
   * Feature 1 Helper (Stage 2 — Exact-Time Confirm & Submit):
   * If the confirmation screen is already prepared (`#command-data-form input[name="ch"]` + `#troop_confirm_submit`),
   * immediately submits the confirmation at the exact scheduled time. Otherwise runs Stage 1 + Stage 2 seamlessly.
   */
  public async dispatchRallyPointCommand(
    cmd: ScheduledCommand
  ): Promise<{ success: boolean; outgoingCommandId?: string; error?: string }> {
    const account = this.store.getAccountById(cmd.accountId);
    if (!account) return { success: false, error: 'Conta não encontrada.' };

    const inFlightPrep = this.prepareLocks.get(cmd.id);
    if (inFlightPrep) {
      await inFlightPrep.catch(() => {});
    }

    let active = this.sessions.get(cmd.accountId);
    let targetWin: BrowserWindow | undefined = this.commandWindows.get(cmd.id);
    if (!targetWin || targetWin.isDestroyed()) {
      targetWin =
        active && !active.window.isDestroyed() && !this.busyWindows.has(active.window.id)
          ? active.window
          : undefined;
    }

    let alreadyPreparedOnScreen = false;
    const cachedNodePrep = this.preparedCommands.get(cmd.id) || null;

    if (targetWin && !targetWin.isDestroyed()) {
      try {
        alreadyPreparedOnScreen = Boolean(
          await targetWin.webContents.executeJavaScript(`
            Boolean(
              (document.querySelector('#command-data-form input[name="ch"]') &&
                document.querySelector('#troop_confirm_submit') &&
                (window.__twPreparedCommand?.commandId === ${JSON.stringify(cmd.id)} || ${Boolean(cachedNodePrep)})) ||
              (window.__twPreparedCommand &&
                window.__twPreparedCommand.commandId === ${JSON.stringify(cmd.id)} &&
                window.__twPreparedCommand.serializedForm)
            )
          `)
        );
      } catch {
        alreadyPreparedOnScreen = false;
      }
    }

    if (!alreadyPreparedOnScreen) {
      const prep = await this.prepareRallyPoint(cmd);
      if (!prep.success) {
        return { success: false, error: prep.error || 'Não foi possível preparar a tela de confirmação.' };
      }
      active = this.sessions.get(cmd.accountId);
      targetWin = this.commandWindows.get(cmd.id) || active?.window;
    }

    if (!targetWin || targetWin.isDestroyed()) {
      return { success: false, error: 'Janela da sessão não disponível para confirmar o envio.' };
    }

    this.busyWindows.add(targetWin.id);
    this.commandWindows.set(cmd.id, targetWin);

    const prepFallbackJson = JSON.stringify(this.preparedCommands.get(cmd.id) || null);
    let dispatchSucceeded = false;

    try {
      const submitResult = (await targetWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const gd = window.game_data || {};
            const prep = window.__twPreparedCommand || ${prepFallbackJson} || {};
            const villageId = String(prep.villageId || (gd.village && gd.village.id) || '');

            const confirmForm = document.querySelector('#command-data-form');
            const chInput = document.querySelector('#command-data-form input[name="ch"]');
            const confirmBtn = document.querySelector('#troop_confirm_submit');

            let csrfToken =
              prep.csrfToken ||
              confirmForm?.getAttribute('data-csrf') ||
              document.querySelector('input[name="h"]')?.value ||
              gd.csrf ||
              window.csrf_token ||
              '';

            let serializedForm = prep.serializedForm || '';

            // If DOM confirmation form is on screen, refresh serializedForm from DOM inputs
            if (confirmForm && chInput && confirmBtn) {
              let cbInput = confirmForm.querySelector('input[name="cb"]');
              if (!cbInput) {
                cbInput = document.createElement('input');
                cbInput.type = 'hidden';
                cbInput.name = 'cb';
                confirmForm.appendChild(cbInput);
              }
              cbInput.value = 'troop_confirm_submit';

              if (villageId && !confirmForm.querySelector('input[name="village"]')) {
                const vInput = document.createElement('input');
                vInput.type = 'hidden';
                vInput.name = 'village';
                vInput.value = villageId;
                confirmForm.appendChild(vInput);
              }

              const params = [];
              confirmForm.querySelectorAll('input, select, textarea').forEach((el) => {
                if (!el.name) return;
                if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
                params.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value || ''));
              });
              serializedForm = params.join('&');
            }

            if (!serializedForm && (!confirmForm || !chInput || !confirmBtn)) {
              return {
                ok: false,
                error: 'Tela/dados de confirmação (#troop_confirm_submit / ch) não encontrados no momento do disparo.'
              };
            }

            const serverTimeMs =
              typeof window.Timing !== 'undefined' && typeof window.Timing.getCurrentServerTime === 'function'
                ? window.Timing.getCurrentServerTime()
                : Date.now();

            // Primary Strategy: Direct AJAX POST to popup_command endpoint
            if (csrfToken && serializedForm.includes('ch=')) {
              const baseUrl = gd.link_base_pure
                ? gd.link_base_pure.split('screen=')[0] + 'screen='
                : '/game.php?' + (villageId ? 'village=' + villageId + '&' : '') + 'screen=';
              const submitUrl =
                baseUrl +
                'place&ajaxaction=popup_command&h=' +
                encodeURIComponent(csrfToken) +
                '&client_time=' +
                Math.floor(serverTimeMs / 1000);

              try {
                const res = await fetch(submitUrl, {
                  method: 'POST',
                  headers: {
                    'TribalWars-Ajax': '1',
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: serializedForm,
                  credentials: 'include'
                });
                const text = await res.text();
                let parsedJson = null;
                try { parsedJson = JSON.parse(text); } catch {}
                if (parsedJson && parsedJson.error) {
                  const errMsg = Array.isArray(parsedJson.error) ? parsedJson.error.join('; ') : String(parsedJson.error);
                  return { ok: false, error: errMsg };
                }
                if (res.ok && !/error_box|class="error"/i.test(text)) {
                  // Motor 2: If extra waves remain (not in native train form), send them sequentially with 200ms attack gap
                  const extraWaves = Array.isArray(prep.extraWavesTroops) ? prep.extraWavesTroops : [];
                  let extraSent = 0;
                  if (extraWaves.length > 0 && typeof window.TribalWars !== 'undefined' && typeof window.$ !== 'undefined') {
                    const targetX = prep.targetX;
                    const targetY = prep.targetY;
                    const cmdType = prep.commandType || 'attack';
                    for (const waveTroops of extraWaves) {
                      await sleep(200); // 200ms attack gap (Tribal Wars limit 5 commands/sec)
                      try {
                        const targetUrl = baseUrl + 'api&ajax=target_selection&input=' + targetX + '|' + targetY + '&type=coord';
                        const tResp = await fetch(targetUrl, { credentials: 'include' });
                        const tData = await tResp.json();
                        const tVillageId = tData?.villages?.[0]?.id || '';
                        if (!tVillageId) continue;

                        const extraFields = await new Promise((resW) => {
                          window.TribalWars.get('place', { village: villageId, target: tVillageId, ajax: 'command' }, (cmdR) => {
                            if (!cmdR || cmdR.error) return resW(null);
                            const d = window.$(cmdR.dialog).find('input[type=hidden]').serializeArray();
                            d.push({ name: cmdType === 'support' ? 'support' : 'attack', value: 'l' });
                            d.push({ name: 'x', value: String(targetX) });
                            d.push({ name: 'y', value: String(targetY) });
                            for (const [u, q] of Object.entries(waveTroops)) {
                              if (Number(q) > 0) d.push({ name: u, value: String(q) });
                            }
                            window.TribalWars.post('place', { village: villageId, ajax: 'confirm' }, d, (confR) => {
                              if (!confR || confR.error) return resW(null);
                              const ff = window.$(confR.dialog).serializeArray();
                              const up = new URLSearchParams();
                              for (const f of ff) up.append(f.name, f.value);
                              if (!up.has('cb')) up.append('cb', 'troop_confirm_submit');
                              if (!up.has('village')) up.append('village', villageId);
                              resW(up.toString());
                            });
                          });
                        });

                        if (extraFields) {
                          const wSrvTime = typeof window.Timing !== 'undefined' && typeof window.Timing.getCurrentServerTime === 'function'
                            ? window.Timing.getCurrentServerTime()
                            : Date.now();
                          const extraSubmitUrl = baseUrl + 'place&ajaxaction=popup_command&h=' +
                            encodeURIComponent(csrfToken) + '&client_time=' + Math.floor(wSrvTime / 1000);
                          const extraRes = await fetch(extraSubmitUrl, {
                            method: 'POST',
                            headers: {
                              'TribalWars-Ajax': '1',
                              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                              'X-Requested-With': 'XMLHttpRequest'
                            },
                            body: extraFields,
                            credentials: 'include'
                          });
                          if (extraRes.ok) extraSent++;
                        }
                      } catch (err) {
                        // Ignore individual wave failure
                      }
                    }
                  }

                  const rawOutId =
                    parsedJson?.command_id ??
                    parsedJson?.id ??
                    parsedJson?.response?.command_id ??
                    parsedJson?.response?.id;
                  const outgoingCommandId =
                    rawOutId !== undefined && rawOutId !== null && String(rawOutId).trim() !== ''
                      ? String(rawOutId).trim()
                      : undefined;

                  delete window.__twPreparedCommand;
                  setTimeout(() => {
                    try { window.location.href = baseUrl + 'place'; } catch {}
                  }, 250);
                  return {
                    ok: true,
                    method: 'ajax_popup_command',
                    extraWavesSent: extraSent,
                    outgoingCommandId,
                  };
                }
              } catch {
                // Fallback to native button click below
              }
            }

            // Fallback Strategy: Native click on #troop_confirm_submit
            if (confirmBtn) {
              confirmBtn.click();
              delete window.__twPreparedCommand;
              return { ok: true, method: 'button_click' };
            }

            return { ok: false, error: 'Não foi possível submeter o formulário de confirmação.' };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
      `)) as { ok: boolean; method?: string; outgoingCommandId?: string; error?: string };

      if (!submitResult?.ok) {
        return {
          success: false,
          error: submitResult?.error || 'Falha ao confirmar envio do comando.',
        };
      }

      dispatchSucceeded = true;
      if (!targetWin.isDestroyed()) {
        targetWin.show();
        targetWin.focus();
      }
      return { success: true, outgoingCommandId: submitResult.outgoingCommandId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Erro ao submeter confirmação na Praça de Reunião.',
      };
    } finally {
      this.preparedCommands.delete(cmd.id);
      if (!cmd.autoDodge?.enabled || !dispatchSucceeded) {
        this.releaseCommandWindow(cmd.id, true);
      }
    }
  }

  /**
   * Wave 5 (Phase 20): Cancels an outgoing support command (Auto-Dodge) via Rally Point
   * (`place&mode=command` scan + `POST place&ajaxaction=cancel` with reload lock & retry).
   */
  public async cancelRallyPointCommand(
    cmd: ScheduledCommand
  ): Promise<{ success: boolean; commandId?: string; error?: string }> {
    const account = this.store.getAccountById(cmd.accountId);
    if (!account) return { success: false, error: 'Conta não encontrada.' };

    let targetWin = this.commandWindows.get(cmd.id);
    if (!targetWin || targetWin.isDestroyed()) {
      const active = this.sessions.get(cmd.accountId);
      if (active && !active.window.isDestroyed()) {
        targetWin = active.window;
      } else {
        const launched = await this.launchSession(cmd.accountId, { visible: true });
        if (!launched.success) {
          return {
            success: false,
            error: launched.error || 'Sessão indisponível para cancelar apoio.',
          };
        }
        targetWin = this.sessions.get(cmd.accountId)?.window;
      }
    }

    if (!targetWin || targetWin.isDestroyed()) {
      return { success: false, error: 'Janela da sessão indisponível para cancelamento.' };
    }

    const payloadJson = JSON.stringify({
      originVillageId: cmd.originVillageId || '',
      targetCoords: cmd.targetCoords,
      outgoingCommandId: cmd.autoDodge?.outgoingCommandId || '',
    });

    try {
      const res = (await targetWin.webContents.executeJavaScript(`
        (async () => {
          let reloadLocked = false;
          const unlockReload = () => {
            try {
              if (reloadLocked && window.Timing?.tickHandlers?.timers) {
                window.Timing.tickHandlers.timers._lock_content_reloading = false;
                reloadLocked = false;
              }
            } catch {}
          };

          try {
            const cfg = ${payloadJson};
            const gd = window.game_data || {};
            const villageId = String(cfg.originVillageId || gd.village?.id || '');
            let csrfToken = String(gd.csrf || window.csrf_token || '');

            if (!villageId) {
              return { ok: false, error: 'Sessão do Tribal Wars não autenticada (villageId ausente).' };
            }

            try {
              const timers = window.Timing?.tickHandlers?.timers;
              if (timers && !timers._lock_content_reloading) {
                timers._lock_content_reloading = true;
                reloadLocked = true;
                setTimeout(unlockReload, 30000);
              }
            } catch {}

            const basePrefix = gd.link_base_pure
              ? gd.link_base_pure.replace(/village=\\d+/, 'village=' + villageId).split('screen=')[0] + 'screen='
              : '/game.php?village=' + villageId + '&screen=';

            const parser = new DOMParser();

            const findCandidate = (doc) => {
              let bestId = cfg.outgoingCommandId || '';
              let bestEnd = -1;
              let cancelHref = '';

              const hInput = doc.querySelector('input[name="h"]');
              if (!csrfToken && hInput?.value) csrfToken = hInput.value;

              const rows = doc.querySelectorAll('#commands_outgoings .command-row, .command-row, table.vis tr');
              for (const row of rows) {
                const cancelLink = row.querySelector('a[href*="action=cancel"]');
                const span = row.querySelector('.quickedit-out[data-id], [data-id]');
                const href = cancelLink ? (cancelLink.getAttribute('href') || '') : '';
                const hrefIdMatch = /[?&]id=(\\d+)/.exec(href);
                const rowId = span?.getAttribute('data-id') || (hrefIdMatch ? hrefIdMatch[1] : '') || '';
                if (!rowId) continue;

                const rowText = (row.textContent || '').replace(/\\s+/g, ' ').trim();
                const matchesExplicitId = Boolean(cfg.outgoingCommandId && rowId === cfg.outgoingCommandId);
                const matchesCoords = Boolean(cfg.targetCoords && rowText.includes(cfg.targetCoords));

                if (!matchesExplicitId && !matchesCoords) continue;

                const endTime = parseInt(row.querySelector('[data-endtime]')?.getAttribute('data-endtime') || '0', 10) || 0;
                if (matchesExplicitId) {
                  bestId = rowId;
                  cancelHref = href;
                  break;
                }
                if (endTime >= bestEnd) {
                  bestEnd = endTime;
                  bestId = rowId;
                  cancelHref = href;
                }
              }

              return { bestId, cancelHref };
            };

            const scanUrl = basePrefix + 'place&mode=command';
            let found = { bestId: '', cancelHref: '' };
            for (const url of [scanUrl, basePrefix + 'place']) {
              try {
                const listResp = await fetch(url, { credentials: 'include' });
                if (!listResp.ok) continue;
                const html = await listResp.text();
                const doc = parser.parseFromString(html, 'text/html');
                found = findCandidate(doc);
                if (found.bestId) break;
              } catch {}
            }

            if (!found.bestId) {
              found = findCandidate(document);
            }

            const commandId = found.bestId;
            if (!commandId) {
              return {
                ok: false,
                error: 'Nenhum comando de saída localizado na Praça para ' + cfg.targetCoords + '.'
              };
            }

            if (!csrfToken && found.cancelHref) {
              const hm = /[?&]h=([^&]+)/.exec(found.cancelHref);
              if (hm) csrfToken = decodeURIComponent(hm[1]);
            }

            const commandStillListed = async () => {
              try {
                const r = await fetch(scanUrl, { credentials: 'include' });
                if (!r.ok) return null;
                const doc = parser.parseFromString(await r.text(), 'text/html');
                if (!doc.querySelector('#commands_outgoings, #content_value, .vis')) return null;
                for (const row of doc.querySelectorAll('#commands_outgoings .command-row, .command-row')) {
                  const sp = row.querySelector('.quickedit-out[data-id], [data-id]');
                  const lnk = row.querySelector('a[href*="action=cancel"]');
                  const lid = /[?&]id=(\\d+)/.exec(lnk?.getAttribute('href') || '')?.[1] || '';
                  if ((sp && sp.getAttribute('data-id') === commandId) || lid === commandId) {
                    return true;
                  }
                }
                return false;
              } catch {
                return null;
              }
            };

            const cancelUrl = basePrefix + 'place&ajaxaction=cancel';
            const body =
              'id=' + encodeURIComponent(commandId) +
              '&village=' + encodeURIComponent(villageId) +
              '&h=' + encodeURIComponent(csrfToken);

            let lastErr = '';
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const resp = await fetch(cancelUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'TribalWars-Ajax': '1',
                    'X-Requested-With': 'XMLHttpRequest',
                    'accept': 'application/json, text/javascript, */*; q=0.01'
                  },
                  body,
                  credentials: 'include'
                });
                const text = await resp.text();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch {}
                const errStr = parsed?.error
                  ? (Array.isArray(parsed.error) ? parsed.error.join('; ') : String(parsed.error))
                  : '';
                const ok = resp.ok && !errStr && (!parsed || parsed.response !== 'error');
                if (ok) {
                  return { ok: true, commandId };
                }
                lastErr = errStr || ('HTTP ' + resp.status);
              } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e);
              }

              const stillThere = await commandStillListed();
              if (stillThere === false) {
                return { ok: true, commandId };
              }
            }

            if (found.cancelHref) {
              try {
                const rFallback = await fetch(found.cancelHref, { credentials: 'include' });
                if (rFallback.ok) {
                  const stillThere = await commandStillListed();
                  if (stillThere !== true) {
                    return { ok: true, commandId };
                  }
                }
              } catch {}
            }

            return { ok: false, error: lastErr || 'Falha ao cancelar comando de desvio.' };
          } catch (e) {
            return { ok: false, error: String(e) };
          } finally {
            unlockReload();
          }
        })();
      `)) as { ok: boolean; commandId?: string; error?: string };

      if (!res?.ok) {
        return {
          success: false,
          error: res?.error || 'Não foi possível cancelar o comando de apoio.',
        };
      }
      return { success: true, commandId: res.commandId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Erro ao cancelar comando de desvio.',
      };
    } finally {
      this.releaseCommandWindow(cmd.id, true);
    }
  }

  public async stopSession(accountId: string): Promise<{ success: boolean }> {
    const active = this.sessions.get(accountId);
    if (active) {
      for (const [cmdId, mappedWin] of this.commandWindows.entries()) {
        if (mappedWin === active.window || active.extraWindows.has(mappedWin)) {
          this.commandWindows.delete(cmdId);
          this.preparedCommands.delete(cmdId);
        }
      }
      for (const extra of active.extraWindows) {
        if (!extra.isDestroyed()) {
          const eid = extra.id;
          this.busyWindows.delete(eid);
          this.autoWorkerWindows.delete(eid);
          extra.close();
        }
      }
      active.extraWindows.clear();
      if (!active.window.isDestroyed()) {
        const pid = active.window.id;
        this.busyWindows.delete(pid);
        this.autoWorkerWindows.delete(pid);
        active.window.close();
      }
    }
    this.sessions.delete(accountId);
    this.emitStatus(accountId, 'offline');
    return { success: true };
  }

  public async bringToFront(accountId: string): Promise<{ success: boolean }> {
    const active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      return this.launchSession(accountId, { visible: true });
    }
    active.window.show();
    active.window.focus();
    for (const extra of active.extraWindows) {
      if (!extra.isDestroyed() && extra.isVisible()) {
        extra.show();
      }
    }
    return { success: true };
  }

  public async reloadPage(accountId: string): Promise<{ success: boolean }> {
    const active = this.sessions.get(accountId);
    if (active && !active.window.isDestroyed()) {
      active.window.webContents.reload();
      for (const extra of active.extraWindows) {
        if (!extra.isDestroyed()) {
          extra.webContents.reload();
        }
      }
      return { success: true };
    }
    return { success: false };
  }

  public async exportCookies(accountId: string): Promise<{ success: boolean; cookies: TwCookie[] }> {
    const account = this.store.getAccountById(accountId);
    if (!account) return { success: false, cookies: [] };
    const ses = session.fromPartition(`persist:tw-${account._id}`);
    const rawCookies = await ses.cookies.get({});
    const cookies: TwCookie[] = rawCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));
    this.store.updateAccount(accountId, { cookies });
    return { success: true, cookies };
  }

  /**
   * Wave 7 (Phase 24 & 26): Scrapes Farm Assistant (`screen=am_farm`) for
   * #plunder_list targets, current home troops, incoming count, and CAPTCHA signals.
   */
  public async inspectFarmAssistant(
    accountId: string,
    originVillageId?: string
  ): Promise<{
    success: boolean;
    captchaDetected?: boolean;
    incomingsCount?: number;
    troops?: TroopCounts;
    targets: FarmPlunderTarget[];
    error?: string;
  }> {
    const account = this.store.getAccountById(accountId);
    if (!account) {
      return { success: false, targets: [], error: 'Conta não encontrada.' };
    }

    const active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      return {
        success: false,
        targets: [],
        error: 'Sessão offline. Abra a janela da conta para usar o Auto-Farm.',
      };
    }

    const villageParam = originVillageId ? String(originVillageId) : '';
    try {
      const result = (await active.window.webContents.executeJavaScript(`
        (async () => {
          try {
            const liveCaptcha = Boolean(
              document.querySelector('#botprotection_quest, #bot_check, .captcha, .h-captcha, .g-recaptcha')
            );
            if (liveCaptcha) {
              return { ok: true, captchaDetected: true, targets: [], incomingsCount: 0, troops: {} };
            }

            const gd = window.game_data;
            if (!gd) {
              return { ok: false, error: 'Sessão do Tribal Wars ainda não autenticada.' };
            }

            const villageId = ${JSON.stringify(villageParam)} || String(gd.village?.id || '');
            const basePrefix = gd.link_base_pure
              ? gd.link_base_pure.replace(/village=\\d+/, 'village=' + villageId).split('screen=')[0] + 'screen='
              : '/game.php?village=' + villageId + '&screen=';

            const resp = await fetch(basePrefix + 'am_farm', { credentials: 'include' });
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const htmlCaptcha = Boolean(
              doc.querySelector('#botprotection_quest, #bot_check, .captcha, .h-captcha, .g-recaptcha') ||
              /botprotection_quest|bot_check/i.test(html)
            );
            if (htmlCaptcha) {
              return {
                ok: true,
                captchaDetected: true,
                incomingsCount: Number(gd.player?.incomings || 0),
                targets: [],
                troops: {},
              };
            }

            const plunderTable = doc.querySelector('#plunder_list');
            if (!plunderTable) {
              return {
                ok: false,
                error: 'Tabela #plunder_list não encontrada (verifique se o Assistente de Saque está ativo).',
              };
            }

            const troops = {};
            let foundUnitDomElement = false;
            const unitKeys = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight'];
            for (const u of unitKeys) {
              const el =
                doc.querySelector('#units_home #' + u) ||
                doc.querySelector('#units_home td[id="' + u + '"]') ||
                doc.querySelector('#units_home td[data-unit="' + u + '"]') ||
                doc.querySelector('#units_home .unit-item-' + u) ||
                doc.querySelector('#current_units .' + u) ||
                doc.querySelector('input[name="' + u + '"][data-all-count]') ||
                doc.querySelector('a.units-entry-all[data-unit="' + u + '"]');
              if (el) {
                foundUnitDomElement = true;
                const raw = el.getAttribute('data-all-count') || el.textContent || '0';
                const val = parseInt(String(raw).replace(/[^\\d]/g, ''), 10);
                if (Number.isFinite(val) && val > 0) troops[u] = val;
              }
            }

            const rows = Array.from(plunderTable.querySelectorAll('tr[id^="village_"]'));
            const targets = [];
            for (const tr of rows) {
              const vId = String(tr.id || '').replace('village_', '').trim();
              if (!vId) continue;
              const rowText = (tr.textContent || '').replace(/\\s+/g, ' ').trim();
              const coordMatch = /(\\d{1,3}\\|\\d{1,3})/.exec(rowText);
              const coords = coordMatch ? coordMatch[1] : '';
              if (!coords) continue;

              const nameLink = tr.querySelector('a[href*="screen=info_village"], a[href*="village="]');
              const name = (nameLink?.textContent || coords).trim();

              let lastReportStatus = 'unknown';
              const dotImg = tr.querySelector('img[src*="dots/"]');
              const dotSrc = (dotImg?.getAttribute('src') || '').toLowerCase();
              if (dotSrc.includes('green')) lastReportStatus = 'green';
              else if (dotSrc.includes('yellow')) lastReportStatus = 'yellow';
              else if (dotSrc.includes('red')) lastReportStatus = 'red';
              else if (dotSrc.includes('blue')) lastReportStatus = 'blue';

              let hasFullLoot;
              const lootImg = tr.querySelector('img[src*="max_loot/"]');
              if (lootImg) {
                const lSrc = lootImg.getAttribute('src') || '';
                hasFullLoot = lSrc.includes('max_loot/1');
              }

              const tds = Array.from(tr.querySelectorAll('td'));
              let distance = 0;
              for (const td of tds) {
                const txt = (td.textContent || '').trim();
                if (/^\\d+(?:[.,]\\d+)?$/.test(txt)) {
                  const num = parseFloat(txt.replace(',', '.'));
                  if (Number.isFinite(num) && num > 0 && num < 500) {
                    distance = num;
                    break;
                  }
                }
              }

              const btnA = tr.querySelector('.farm_icon_a');
              const btnB = tr.querySelector('.farm_icon_b');
              const btnC = tr.querySelector('.farm_icon_c');

              targets.push({
                villageId: vId,
                coords,
                name,
                distance,
                lastReportStatus,
                hasFullLoot,
                canSendA: Boolean(btnA && !btnA.classList.contains('farm_icon_disabled')),
                canSendB: Boolean(btnB && !btnB.classList.contains('farm_icon_disabled')),
                canSendC: Boolean(btnC && !btnC.classList.contains('farm_icon_disabled')),
              });
            }

            return {
              ok: true,
              captchaDetected: false,
              incomingsCount: Number(gd.player?.incomings || 0),
              troops: foundUnitDomElement ? troops : undefined,
              targets,
            };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
      `)) as {
        ok: boolean;
        captchaDetected?: boolean;
        incomingsCount?: number;
        troops?: TroopCounts;
        targets?: Array<Omit<FarmPlunderTarget, 'lastReportStatus'> & { lastReportStatus: FarmTargetStatus }>;
        error?: string;
      };

      if (!result?.ok) {
        return {
          success: false,
          targets: [],
          error: result?.error || 'Falha ao ler #plunder_list do Assistente de Saque.',
        };
      }

      return {
        success: true,
        captchaDetected: Boolean(result.captchaDetected),
        incomingsCount: result.incomingsCount ?? 0,
        troops: result.troops,
        targets: result.targets || [],
      };
    } catch (err) {
      return {
        success: false,
        targets: [],
        error: err instanceof Error ? err.message : 'Erro ao inspecionar Assistente de Saque.',
      };
    }
  }

  /**
   * Wave 7 (Phase 24): Dispatches a Farm Assistant template (A/B/C) for a target village.
   */
  public async dispatchFarmAssistantAttack(
    accountId: string,
    originVillageId: string | undefined,
    targetVillageId: string,
    templateKey: FarmTemplateKey
  ): Promise<{ success: boolean; captchaDetected?: boolean; lowTroops?: boolean; error?: string }> {
    const account = this.store.getAccountById(accountId);
    if (!account) return { success: false, error: 'Conta não encontrada.' };

    const active = this.sessions.get(accountId);
    if (!active || active.window.isDestroyed()) {
      return { success: false, error: 'Sessão offline.' };
    }

    const win = active.window;
    const base = (account.serverUrl || `https://${account.world}.${account.domain}`).replace(/\/+$/, '');
    const villageQuery = originVillageId ? `village=${encodeURIComponent(originVillageId)}&` : '';
    const amFarmUrl = `${base}/game.php?${villageQuery}screen=am_farm`;

    try {
      const currentUrl = win.webContents.getURL();
      const needsLoad =
        !currentUrl.includes('screen=am_farm') ||
        (originVillageId ? !currentUrl.includes(`village=${originVillageId}`) : false);
      if (needsLoad) {
        await this.loadWindowUrlSafe(win, amFarmUrl);
      }

      const res = (await win.webContents.executeJavaScript(`
        (async () => {
          try {
            if (document.querySelector('#botprotection_quest, #bot_check, .captcha, .h-captcha, .g-recaptcha')) {
              return { ok: false, captchaDetected: true, error: 'CAPTCHA detectado.' };
            }
            const row = document.querySelector('#plunder_list tr#village_' + ${JSON.stringify(targetVillageId)});
            if (!row) {
              return { ok: false, error: 'Alvo não encontrado em #plunder_list.' };
            }
            const btn = row.querySelector('.farm_icon_' + ${JSON.stringify(templateKey)});
            if (!btn || btn.classList.contains('farm_icon_disabled')) {
              return { ok: false, lowTroops: true, error: 'Botão de saque indisponível ou sem tropas.' };
            }
            btn.click();
            await new Promise((r) => setTimeout(r, 150));

            if (document.querySelector('#botprotection_quest, #bot_check, .captcha')) {
              return { ok: false, captchaDetected: true, error: 'CAPTCHA detectado após disparo.' };
            }
            const errEl = document.querySelector('#error, .autoHideBox.error, .error_box');
            const errText = (errEl?.textContent || '').trim();
            if (errText) {
              const lowTroops = /unidades|tropas|insuficiente|units|troops/i.test(errText);
              return { ok: false, lowTroops, error: errText };
            }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
      `)) as { ok: boolean; captchaDetected?: boolean; lowTroops?: boolean; error?: string };

      if (!res?.ok) {
        return {
          success: false,
          captchaDetected: Boolean(res?.captchaDetected),
          lowTroops: Boolean(res?.lowTroops),
          error: res?.error || 'Falha ao disparar ataque no Assistente de Saque.',
        };
      }
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Erro ao disparar ataque no Assistente de Saque.',
      };
    }
  }

  /**
   * Wave 7 (Per-Village Mapping): Maps nearest barbarian targets within `radius`
   * around `originCoords`, merging live `#plunder_list` telemetry (when session is active)
   * with `/map/village.txt` (`playerId === '0'`) from the 15-min `worldMapCache`.
   */
  public async mapNearestFarmTargets(params: {
    accountId: string;
    originVillageId?: string;
    originCoords: string;
    radius: number;
  }): Promise<{
    success: boolean;
    targets: FarmPlunderTarget[];
    source?: 'fa+map' | 'map' | 'fa';
    error?: string;
  }> {
    const account = this.store.getAccountById(params.accountId);
    if (!account) {
      return { success: false, targets: [], error: 'Conta não encontrada.' };
    }

    const originParsed = parseCoords(params.originCoords);
    if (!originParsed) {
      return { success: false, targets: [], error: 'Coordenada de origem inválida.' };
    }
    const cleanOrigin = `${originParsed.x}|${originParsed.y}`;
    const maxRadius = Math.max(1, Math.min(200, Number(params.radius) || 20));

    // 1. Live FA targets (if session is active)
    const faByCoord = new Map<string, FarmPlunderTarget>();
    let usedFa = false;
    if (this.sessions.has(params.accountId)) {
      const faRes = await this.inspectFarmAssistant(params.accountId, params.originVillageId);
      if (faRes.success && faRes.targets.length > 0) {
        usedFa = true;
        for (const t of faRes.targets) {
          const dist = t.distance > 0 ? t.distance : Number(calculateDistance(cleanOrigin, t.coords).toFixed(2));
          if (dist <= maxRadius) {
            faByCoord.set(t.coords, { ...t, distance: dist });
          }
        }
      }
    }

    // 2. World map barbarians (/map/village.txt via 15-min cache)
    const worldKey = `${account.domain.toLowerCase()}:${account.world.toLowerCase()}`;
    const base = (account.serverUrl || `https://${account.world}.${account.domain}`).replace(/\/+$/, '');
    let cached = this.worldMapCache.get(worldKey);
    const cacheValid = cached && Date.now() - cached.fetchedAt < 15 * 60 * 1000;

    if (!cacheValid) {
      let villagesTxt = '';
      await new Promise<void>((resolve) => {
        const mod = base.startsWith('http://') ? http : https;
        const req = mod.get(`${base}/map/village.txt`, { timeout: 9000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 400 && !/^\s*<(?:!doctype|html)/i.test(body)) {
              villagesTxt = body;
            }
            resolve();
          });
        });
        req.on('error', () => resolve());
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
      });

      if (!villagesTxt) {
        const active = this.sessions.get(params.accountId);
        if (active && !active.window.isDestroyed()) {
          try {
            villagesTxt = (await active.window.webContents.executeJavaScript(`
              (async () => {
                try {
                  const r = await fetch(location.origin + '/map/village.txt', { credentials: 'include' });
                  const txt = await r.text();
                  return r.ok && !/^\\s*<(?:!doctype|html)/i.test(txt) ? txt : '';
                } catch {
                  return '';
                }
              })();
            `)) as string;
          } catch {}
        }
      }

      if (villagesTxt) {
        const parsedVillages = parseWorldVillagesTxt(villagesTxt, new Map());
        cached = {
          fetchedAt: Date.now(),
          players: cached?.players || [],
          villages: parsedVillages,
        };
        this.worldMapCache.set(worldKey, cached);
      }
    }

    const mergedByCoord = new Map<string, FarmPlunderTarget>(faByCoord);
    let usedMap = false;

    if (cached && cached.villages.length > 0) {
      usedMap = true;
      for (const v of cached.villages) {
        // playerId === '0' indicates Barbarian village in /map/village.txt
        if (v.playerId !== '0') continue;
        if (v.coords === cleanOrigin) continue;
        const dist = Number(calculateDistance(cleanOrigin, v.coords).toFixed(2));
        if (dist <= 0 || dist > maxRadius) continue;

        if (!mergedByCoord.has(v.coords)) {
          mergedByCoord.set(v.coords, {
            villageId: v.id,
            coords: v.coords,
            name: v.name || `Aldeia de Bárbaros (${v.coords})`,
            distance: dist,
            lastReportStatus: 'unknown',
            canSendA: true,
            canSendB: true,
            canSendC: true,
          });
        }
      }
    }

    const targets = Array.from(mergedByCoord.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 250);

    if (targets.length === 0 && !usedFa && !usedMap) {
      return {
        success: false,
        targets: [],
        error: 'Não foi possível ler o Assistente de Saque nem /map/village.txt. Abra a sessão da conta e tente novamente.',
      };
    }

    return {
      success: true,
      targets,
      source: usedFa && usedMap ? 'fa+map' : usedMap ? 'map' : 'fa',
    };
  }
}
