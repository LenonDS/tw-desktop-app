import React, { useState } from 'react';
import {
  Castle,
  Compass,
  Cookie,
  ExternalLink,
  Hammer,
  Map,
  RefreshCw,
  ShieldAlert,
  Sprout,
  Sword,
  Trophy,
} from 'lucide-react';
import type { TwAccount } from '../types';
import { Modal } from './ui/Modal';

interface AccountDetailModalProps {
  account: TwAccount;
  onClose: () => void;
  onOpenScreen: (account: TwAccount, screen: string) => Promise<void>;
  onExportCookies: (accountId: string) => Promise<void>;
  onReloadSession: (accountId: string) => Promise<void>;
}

const TW_SCREENS = [
  { id: 'overview', label: 'Visão Geral da Aldeia', icon: Castle, desc: 'Edifícios, produção e tropas na aldeia' },
  { id: 'main', label: 'Edifício Principal', icon: Hammer, desc: 'Fila de construção e evolução' },
  { id: 'train', label: 'Recrutamento', icon: Sword, desc: 'Quartel, Estábulo e Oficina' },
  { id: 'place', label: 'Praça de Reunião', icon: Compass, desc: 'Comandos em andamento e envio de tropas' },
  { id: 'am_farm', label: 'Assistente de Saque', icon: Sprout, desc: 'Modelos A/B/C e saques em aldeias bárbaras' },
  { id: 'place&mode=scavenge', label: 'Coleta (Scavenge)', icon: RefreshCw, desc: 'Coleta individual e em massa' },
  { id: 'snob', label: 'Academia / Cunhagem', icon: Trophy, desc: 'Cunhar moedas de ouro e recrutar Nobres' },
  { id: 'map', label: 'Mapa do Mundo', icon: Map, desc: 'Navegação estratégica do continente' },
  { id: 'overview_villages&mode=incomings', label: 'Ataques a Chegar (Tagger)', icon: ShieldAlert, desc: 'Monitoramento de ataques recebidos' },
];

export const AccountDetailModal: React.FC<AccountDetailModalProps> = ({
  account,
  onClose,
  onOpenScreen,
  onExportCookies,
  onReloadSession,
}) => {
  const [busyScreen, setBusyScreen] = useState<string | null>(null);

  const handleNavigate = async (screen: string) => {
    setBusyScreen(screen);
    try {
      await onOpenScreen(account, screen);
    } finally {
      setBusyScreen(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      maxWidthClass="max-w-3xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{account.username}</span>
          <span className="rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-xs font-semibold text-amber-300">
            {account.world.toUpperCase()}
          </span>
          <span className="text-xs font-normal text-slate-400">{account.domain}</span>
        </span>
      }
      subtitle="Sessão isolada com armazenamento de cookies e proxy dedicado"
    >
      <div className="p-6 space-y-6">
        {/* Player Telemetry Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
          <div className="rounded-xl border border-slate-800 bg-surface-base p-3.5">
            <div className="text-[11px] text-slate-400">Pontos</div>
            <div className="text-lg font-bold text-slate-100 mt-0.5">
              {(account.playerInfo?.points || 0).toLocaleString('pt-BR')}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-surface-base p-3.5">
            <div className="text-[11px] text-slate-400">Aldeias</div>
            <div className="text-lg font-bold text-amber-400 mt-0.5">
              {account.playerInfo?.villagesCount || 1}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-surface-base p-3.5">
            <div className="text-[11px] text-slate-400">Recursos (Mad / Arg / Fer)</div>
            <div className="text-xs font-semibold text-slate-200 mt-1.5">
              {(account.playerInfo?.wood || 0).toLocaleString('pt-BR')} /{' '}
              {(account.playerInfo?.stone || 0).toLocaleString('pt-BR')} /{' '}
              {(account.playerInfo?.iron || 0).toLocaleString('pt-BR')}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-surface-base p-3.5">
            <div className="text-[11px] text-slate-400">Ataques a Chegar</div>
            <div
              className={`text-lg font-bold mt-0.5 ${
                (account.playerInfo?.incomings || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {account.playerInfo?.incomings || 0}
            </div>
          </div>
        </div>

        {/* Direct Tribal Wars Screen Shortcuts */}
        <div>
          <h3 className="text-xs font-semibold text-slate-400 mb-3">
            Atalhos diretos no jogo ({account.world.toUpperCase()})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {TW_SCREENS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavigate(item.id)}
                  disabled={busyScreen === item.id}
                  className="flex flex-col items-start rounded-xl border border-slate-800 bg-surface-base p-3.5 text-left transition-colors duration-150 hover:border-amber-500/50 hover:bg-slate-900 active:scale-[0.98] disabled:opacity-50"
                >
                  <div className="flex items-center justify-between w-full mb-1.5">
                    <Icon className="h-4 w-4 text-amber-400" />
                    <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="text-xs font-semibold text-slate-100">{item.label}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                    {item.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Session Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onExportCookies(account._id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
            >
              <Cookie className="h-3.5 w-3.5 text-amber-400" />
              Salvar / Exportar Cookies da Sessão ({account.cookies?.length || 0})
            </button>
            <button
              type="button"
              onClick={() => onReloadSession(account._id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-surface-base px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98]"
            >
              <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
              Recarregar Página
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-700 active:scale-[0.98]"
          >
            Fechar
          </button>
        </div>
      </div>
    </Modal>
  );
};
