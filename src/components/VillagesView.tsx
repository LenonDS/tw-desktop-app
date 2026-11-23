import React, { useState } from 'react';
import { Castle, ExternalLink, Plus, RefreshCw, Sword } from 'lucide-react';
import type { TwAccount, TwUnitType, TwVillage } from '../types';

const SHORT_UNIT_NAMES: Partial<Record<TwUnitType, string>> = {
  spear: 'Lan',
  sword: 'Esp',
  axe: 'Bár',
  archer: 'Arq',
  spy: 'Exp',
  light: 'CL',
  marcher: 'AC',
  heavy: 'CP',
  ram: 'Arí',
  catapult: 'Cat',
  knight: 'Pal',
  snob: 'Nob',
};

interface VillagesViewProps {
  accounts: TwAccount[];
  onSyncVillages: (accountId: string) => Promise<void>;
  onSyncCombinedVillages?: (accountId: string) => Promise<void>;
  onAddManualVillage: (accountId: string, village: TwVillage) => Promise<void>;
  onOpenVillageScreen: (account: TwAccount, villageId: string, screen: string) => Promise<void>;
}

export const VillagesView: React.FC<VillagesViewProps> = ({
  accounts,
  onSyncVillages,
  onSyncCombinedVillages,
  onAddManualVillage,
  onOpenVillageScreen,
}) => {
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?._id || '');
  const [syncing, setSyncing] = useState(false);
  const [syncingTroops, setSyncingTroops] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualCoords, setManualCoords] = useState('500|500');
  const [manualPoints, setManualPoints] = useState('3500');

  const selectedAccount = accounts.find((a) => a._id === selectedAccountId) || accounts[0] || null;
  const villages = selectedAccount?.villages || [];

  const handleSync = async () => {
    if (!selectedAccount) return;
    setSyncing(true);
    try {
      await onSyncVillages(selectedAccount._id);
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncCombined = async () => {
    if (!selectedAccount || !onSyncCombinedVillages) return;
    setSyncingTroops(true);
    try {
      await onSyncCombinedVillages(selectedAccount._id);
    } finally {
      setSyncingTroops(false);
    }
  };

  const handleAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount || !manualCoords.trim()) return;
    const m = /(\d{1,3})\|(\d{1,3})/.exec(manualCoords.trim());
    const coords = m ? `${m[1]}|${m[2]}` : '500|500';
    const [x, y] = coords.split('|').map(Number);
    await onAddManualVillage(selectedAccount._id, {
      id: crypto.randomUUID().slice(0, 8),
      name: manualName.trim() || `Aldeia (${coords})`,
      coords,
      x,
      y,
      points: Number(manualPoints) || 1000,
      wood: 10000,
      stone: 10000,
      iron: 10000,
      storage: 50000,
      pop: 2400,
      popMax: 24000,
      updatedAt: new Date().toISOString(),
    });
    setManualName('');
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-surface-card p-5">
        <div className="flex items-center gap-3">
          <Castle className="h-5 w-5 text-amber-400" />
          <div>
            <h2 className="text-sm font-bold text-slate-100">
              Diretório de Aldeias, Produção e População
            </h2>
            <p className="text-xs text-slate-400">
              Sincronize as aldeias diretamente da sessão ativa ou cadastre coordenadas para uso no Agendador.
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
            {syncing ? 'Sincronizando...' : 'Sincronizar Produção'}
          </button>

          {onSyncCombinedVillages && (
            <button
              onClick={handleSyncCombined}
              disabled={!selectedAccount || syncingTroops}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
            >
              <Sword className={`h-3.5 w-3.5 ${syncingTroops ? 'animate-spin' : ''}`} />
              {syncingTroops ? 'Lendo Combinada...' : 'Sincronizar Tropas (Combinada)'}
            </button>
          )}
        </div>
      </div>

      {/* Quick Manual Add Village */}
      <form
        onSubmit={handleAddManual}
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-[#141923] p-4"
      >
        <div className="flex-1 min-w-[180px]">
          <label className="block text-[11px] text-slate-400 mb-1">Nome da Aldeia</label>
          <input
            type="text"
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="Ex: 001 | Fortaleza Norte"
            className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
          />
        </div>
        <div className="w-36">
          <label className="block text-[11px] text-slate-400 mb-1">Coordenada (X|Y)</label>
          <input
            type="text"
            required
            value={manualCoords}
            onChange={(e) => setManualCoords(e.target.value)}
            placeholder="500|500"
            className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 font-mono text-xs text-slate-100"
          />
        </div>
        <div className="w-32">
          <label className="block text-[11px] text-slate-400 mb-1">Pontos</label>
          <input
            type="number"
            value={manualPoints}
            onChange={(e) => setManualPoints(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
          />
        </div>
        <button
          type="submit"
          disabled={!selectedAccount}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0f1218] px-4 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5 text-amber-400" />
          Adicionar Aldeia
        </button>
      </form>

      {/* Villages Table */}
      <div className="rounded-2xl border border-slate-800 bg-surface-card p-5">
        <h3 className="text-sm font-semibold text-slate-100 mb-3 tabular-nums">
          Aldeias de {selectedAccount?.username || '—'} ({villages.length})
        </h3>
        {villages.length === 0 ? (
          <p className="text-xs text-slate-400 py-6 text-center">
            Nenhuma aldeia sincronizada ainda. Clique em "Sincronizar Produção" com sua conta logada no mundo ou adicione manualmente acima.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 px-3">Aldeia</th>
                  <th className="py-2.5 px-3">Coordenada</th>
                  <th className="py-2.5 px-3">Pontos</th>
                  <th className="py-2.5 px-3">Recursos (Mad / Arg / Fer)</th>
                  <th className="py-2.5 px-3">Tropas em Casa</th>
                  <th className="py-2.5 px-3">Armazém</th>
                  <th className="py-2.5 px-3">Fazenda</th>
                  <th className="py-2.5 px-3 text-right">Atalhos na Aldeia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {villages.map((v) => {
                  const troopEntries = Object.entries(v.troops || {}).filter(
                    ([, qty]) => Number(qty) > 0
                  );
                  return (
                    <tr key={v.id} className="hover:bg-slate-900/40">
                      <td className="py-3 px-3 font-semibold text-slate-100">
                        <div className="flex items-center gap-1.5">
                          <span>{v.name}</span>
                          {v.localCategory && (
                            <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                              {v.localCategory}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-amber-300">{v.coords}</td>
                      <td className="py-3 px-3 text-slate-200">
                        {v.points.toLocaleString('pt-BR')}
                      </td>
                      <td className="py-3 px-3 text-slate-300">
                        {v.wood.toLocaleString('pt-BR')} / {v.stone.toLocaleString('pt-BR')} /{' '}
                        {v.iron.toLocaleString('pt-BR')}
                      </td>
                      <td className="py-3 px-3">
                        {troopEntries.length === 0 ? (
                          <span className="text-slate-500">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1 max-w-[260px]">
                            {troopEntries.map(([u, qty]) => (
                              <span
                                key={u}
                                className="rounded bg-[#0f1218] border border-slate-700/80 px-1.5 py-0.5 text-[10px] text-slate-200"
                              >
                                {Number(qty).toLocaleString('pt-BR')}{' '}
                                {SHORT_UNIT_NAMES[u as TwUnitType] || u}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-400">
                        {v.storage.toLocaleString('pt-BR')}
                      </td>
                      <td className="py-3 px-3 text-slate-300">
                        {v.pop} / {v.popMax}
                      </td>
                      <td className="py-3 px-3 text-right space-x-1.5">
                        {selectedAccount && (
                          <>
                            <button
                              onClick={() => onOpenVillageScreen(selectedAccount, v.id, 'overview')}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-800"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Visão Geral
                            </button>
                            <button
                              onClick={() => onOpenVillageScreen(selectedAccount, v.id, 'place')}
                              className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-800"
                            >
                              Praça
                            </button>
                          </>
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
