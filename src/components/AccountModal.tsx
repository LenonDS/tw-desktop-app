import React, { useEffect, useId, useState } from 'react';
import { Eye, EyeOff, Globe, KeyRound, RefreshCw, Server, Shield } from 'lucide-react';
import type { ProxyConfig, TwAccount } from '../types';
import { Modal } from './ui/Modal';

interface AccountModalProps {
  initial?: TwAccount | null;
  savedProxies: ProxyConfig[];
  onClose: () => void;
  onSave: (payload: Partial<TwAccount>) => Promise<void>;
  fetchServers: (domain: string) => Promise<Record<string, string>>;
}

const DOMAINS = [
  { value: 'tribalwars.com.br', label: 'Brasil (tribalwars.com.br)' },
  { value: 'tribalwars.com.pt', label: 'Portugal (tribalwars.com.pt)' },
  { value: 'tribalwars.net', label: 'Internacional (tribalwars.net)' },
];

export const AccountModal: React.FC<AccountModalProps> = ({
  initial,
  savedProxies,
  onClose,
  onSave,
  fetchServers,
}) => {
  const formId = useId();
  const [username, setUsername] = useState(initial?.username || '');
  const [domain, setDomain] = useState(initial?.domain || 'tribalwars.com.br');
  const [world, setWorld] = useState(initial?.world || 'br130');
  const [group, setGroup] = useState(initial?.group || 'Principal');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [password, setPassword] = useState(initial?.credentials?.password || '');
  const [showPassword, setShowPassword] = useState(false);
  const [useProxy, setUseProxy] = useState<boolean>(!!initial?.proxy?.enabled);
  const [proxyProtocol, setProxyProtocol] = useState<'http' | 'https' | 'socks4' | 'socks5'>(
    initial?.proxy?.protocol || 'http'
  );
  const [proxyHost, setProxyHost] = useState(initial?.proxy?.host || '');
  const [proxyPort, setProxyPort] = useState(String(initial?.proxy?.port || 8080));
  const [proxyUser, setProxyUser] = useState(initial?.proxy?.username || '');
  const [proxyPass, setProxyPass] = useState(initial?.proxy?.password || '');
  const [showProxyPass, setShowProxyPass] = useState(false);
  const [cookiesRaw, setCookiesRaw] = useState(
    initial?.cookies?.length ? JSON.stringify(initial.cookies, null, 2) : ''
  );
  const [servers, setServers] = useState<Record<string, string>>({});
  const [loadingServers, setLoadingServers] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadWorlds = async (targetDomain: string) => {
    setLoadingServers(true);
    try {
      const list = await fetchServers(targetDomain);
      setServers(list);
      const keys = Object.keys(list);
      if (keys.length > 0 && !list[world]) {
        setWorld(keys[keys.length - 1]);
      }
    } finally {
      setLoadingServers(false);
    }
  };

  useEffect(() => {
    loadWorlds(domain);
  }, [domain]);

  const handleSelectSavedProxy = (proxyId: string) => {
    const found = savedProxies.find((p) => p.id === proxyId);
    if (!found) return;
    setUseProxy(true);
    setProxyProtocol(found.protocol);
    setProxyHost(found.host);
    setProxyPort(String(found.port));
    setProxyUser(found.username || '');
    setProxyPass(found.password || '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setSaving(true);
    try {
      let parsedCookies = initial?.cookies || [];
      if (cookiesRaw.trim()) {
        try {
          const parsed = JSON.parse(cookiesRaw);
          if (Array.isArray(parsed)) parsedCookies = parsed;
        } catch {
          // Keep existing cookies if JSON is invalid
        }
      }
      const serverUrl = servers[world] || `https://${world}.${domain}`;
      await onSave({
        ...(initial ? { _id: initial._id } : {}),
        username: username.trim(),
        domain,
        world: world.trim(),
        serverUrl,
        group: group.trim() || 'Geral',
        notes: notes.trim(),
        credentials: {
          username: username.trim(),
          password,
          autoLogin: Boolean(password),
        },
        proxy: useProxy
          ? {
              enabled: true,
              protocol: proxyProtocol,
              host: proxyHost.trim(),
              port: Number(proxyPort) || 8080,
              username: proxyUser.trim() || undefined,
              password: proxyPass || undefined,
            }
          : {
              enabled: false,
              protocol: 'http',
              host: '',
              port: 8080,
            },
        cookies: parsedCookies,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? `Editar Conta: ${initial.username}` : 'Adicionar Conta Tribal Wars'}
      headerIcon={<Globe className="h-5 w-5 shrink-0 text-amber-400" />}
      maxWidthClass="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor={`${formId}-username`}
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Nick / Usuário Tribal Wars *
            </label>
            <input
              id={`${formId}-username`}
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Ex: LordPaladin"
              className="w-full rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor={`${formId}-group`}
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Grupo / Esquadrão
            </label>
            <input
              id={`${formId}-group`}
              type="text"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="Ex: Front Norte, Speed, Farm"
              className="w-full rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor={`${formId}-domain`}
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Servidor Regional
            </label>
            <select
              id={`${formId}-domain`}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
            >
              {DOMAINS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor={`${formId}-world`}
                className="block text-xs font-medium text-slate-400"
              >
                Mundo (World)
              </label>
              <button
                type="button"
                onClick={() => loadWorlds(domain)}
                className="inline-flex items-center gap-1 text-xs text-amber-400 transition-colors duration-150 hover:text-amber-300"
              >
                <RefreshCw className={`h-3 w-3 ${loadingServers ? 'animate-spin' : ''}`} />
                Atualizar mundos
              </button>
            </div>
            <div className="flex gap-2">
              {Object.keys(servers).length > 0 ? (
                <select
                  id={`${formId}-world`}
                  value={world}
                  onChange={(e) => setWorld(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  {Object.entries(servers).map(([code, url]) => (
                    <option key={code} value={code}>
                      {code.toUpperCase()} — {url}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${formId}-world`}
                  type="text"
                  value={world}
                  onChange={(e) => setWorld(e.target.value)}
                  placeholder="br130"
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-surface-base/70 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
            <KeyRound className="h-4 w-4 text-amber-400" />
            Credenciais Opcionais & Cookies de Sessão Tribal Wars
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor={`${formId}-password`}
                className="block text-xs text-slate-400 mb-1"
              >
                Senha da conta Tribal Wars (opcional)
              </label>
              <div className="relative">
                <input
                  id={`${formId}-password`}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-3 py-1.5 pr-9 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar senha da conta' : 'Mostrar senha da conta'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <div>
              <label
                htmlFor={`${formId}-notes`}
                className="block text-xs text-slate-400 mb-1"
              >
                Notas rápidas / Aldeia principal
              </label>
              <input
                id={`${formId}-notes`}
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ex: Co-play noturno, K55"
                className="w-full rounded-lg border border-slate-700 bg-surface-base px-3 py-1.5 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`${formId}-cookies`}
              className="block text-xs text-slate-400 mb-1"
            >
              Cookies em formato JSON (opcional — a sessão isolada já persiste o login automaticamente)
            </label>
            <textarea
              id={`${formId}-cookies`}
              rows={2}
              value={cookiesRaw}
              onChange={(e) => setCookiesRaw(e.target.value)}
              placeholder='[{"name": "cid", "value": "..."}]'
              className="w-full rounded-lg border border-slate-700 bg-surface-base px-3 py-1.5 font-mono text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-surface-base/70 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`${formId}-use-proxy`}
              className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer"
            >
              <input
                id={`${formId}-use-proxy`}
                type="checkbox"
                checked={useProxy}
                onChange={(e) => setUseProxy(e.target.checked)}
                className="rounded border-slate-700 text-amber-500 focus:ring-amber-500"
              />
              <Shield className="h-4 w-4 text-emerald-400" />
              Usar Proxy dedicado nesta conta (HTTP / SOCKS5)
            </label>

            {savedProxies.length > 0 && (
              <select
                aria-label="Carregar proxy salvo"
                onChange={(e) => handleSelectSavedProxy(e.target.value)}
                defaultValue=""
                className="rounded-lg border border-slate-700 bg-surface-card px-2.5 py-1 text-xs text-slate-300"
              >
                <option value="" disabled>
                  Carregar proxy salvo...
                </option>
                {savedProxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || `${p.protocol}://${p.host}:${p.port}`}
                  </option>
                ))}
              </select>
            )}
          </div>

          {useProxy && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-1">
              <div>
                <label
                  htmlFor={`${formId}-proxy-protocol`}
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  Protocolo
                </label>
                <select
                  id={`${formId}-proxy-protocol`}
                  value={proxyProtocol}
                  onChange={(e) =>
                    setProxyProtocol(e.target.value as 'http' | 'https' | 'socks4' | 'socks5')
                  }
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor={`${formId}-proxy-host`}
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  Host / IP
                </label>
                <input
                  id={`${formId}-proxy-host`}
                  type="text"
                  value={proxyHost}
                  onChange={(e) => setProxyHost(e.target.value)}
                  placeholder="192.168.1.10"
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor={`${formId}-proxy-port`}
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  Porta
                </label>
                <input
                  id={`${formId}-proxy-port`}
                  type="number"
                  value={proxyPort}
                  onChange={(e) => setProxyPort(e.target.value)}
                  placeholder="8080"
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 text-xs tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor={`${formId}-proxy-user`}
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  Usuário
                </label>
                <input
                  id={`${formId}-proxy-user`}
                  type="text"
                  value={proxyUser}
                  onChange={(e) => setProxyUser(e.target.value)}
                  placeholder="Opcional"
                  className="w-full rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 text-xs text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor={`${formId}-proxy-pass`}
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  Senha do Proxy
                </label>
                <div className="relative">
                  <input
                    id={`${formId}-proxy-pass`}
                    type={showProxyPass ? 'text' : 'password'}
                    value={proxyPass}
                    onChange={(e) => setProxyPass(e.target.value)}
                    placeholder="Opcional"
                    className="w-full rounded-lg border border-slate-700 bg-surface-base px-2.5 py-1.5 pr-8 text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => setShowProxyPass((prev) => !prev)}
                    aria-label={
                      showProxyPass ? 'Ocultar senha do proxy' : 'Mostrar senha do proxy'
                    }
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-200"
                  >
                    {showProxyPass ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 transition-colors duration-150 hover:bg-amber-400 active:scale-[0.98] disabled:opacity-50"
          >
            <Server className="h-4 w-4" />
            {saving ? 'Salvando...' : initial ? 'Salvar Alterações' : 'Cadastrar Conta'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
