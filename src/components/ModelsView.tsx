import React, { useState } from 'react';
import { Hammer, Plus, Shield, Sword, Trash2 } from 'lucide-react';
import type {
  ConstructionModel,
  RecruitmentModel,
  TwAccount,
  TwUnitType,
} from '../types';
import { ConfirmDialog } from './ui/ConfirmDialog';

interface ModelsViewProps {
  accounts: TwAccount[];
  constructionModels: ConstructionModel[];
  recruitmentModels: RecruitmentModel[];
  onSaveConstructionModel: (
    model: Partial<ConstructionModel> & { name: string }
  ) => Promise<void>;
  onDeleteConstructionModel: (id: string) => Promise<void>;
  onSaveRecruitmentModel: (
    model: Partial<RecruitmentModel> & { name: string }
  ) => Promise<void>;
  onDeleteRecruitmentModel: (id: string) => Promise<void>;
  onAssignModelsToAccount: (
    accountId: string,
    constructionModelId?: string,
    recruitmentModelId?: string
  ) => Promise<void>;
}

const BUILDING_LABELS: Record<string, string> = {
  main: 'Edifício Principal',
  barracks: 'Quartel',
  stable: 'Estábulo',
  garage: 'Oficina',
  snob: 'Academia',
  smith: 'Ferreiro',
  place: 'Praça de Reunião',
  statue: 'Estátua',
  market: 'Mercado',
  wood: 'Bosque',
  stone: 'Poço de Argila',
  iron: 'Mina de Ferro',
  farm: 'Fazenda',
  storage: 'Armazém',
  hide: 'Esconderijo',
  wall: 'Muralha',
};

export const ModelsView: React.FC<ModelsViewProps> = ({
  accounts,
  constructionModels,
  recruitmentModels,
  onSaveConstructionModel,
  onDeleteConstructionModel,
  onSaveRecruitmentModel,
  onDeleteRecruitmentModel,
  onAssignModelsToAccount,
}) => {
  const [newConstName, setNewConstName] = useState('');
  const [newConstDesc, setNewConstDesc] = useState('');

  const [newRecName, setNewRecName] = useState('');
  const [newRecCategory, setNewRecCategory] = useState<
    'offensive' | 'defensive' | 'scout' | 'hybrid'
  >('offensive');
  const [newRecSpear, setNewRecSpear] = useState(0);
  const [newRecSword, setNewRecSword] = useState(0);
  const [newRecAxe, setNewRecAxe] = useState(6500);
  const [newRecSpy, setNewRecSpy] = useState(50);
  const [newRecLight, setNewRecLight] = useState(3000);
  const [newRecHeavy, setNewRecHeavy] = useState(0);
  const [newRecRam, setNewRecRam] = useState(300);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'construction' | 'recruitment';
    id: string;
    name: string;
  } | null>(null);

  const handleAddConstruction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newConstName.trim()) return;
    await onSaveConstructionModel({
      name: newConstName.trim(),
      description: newConstDesc.trim() || 'Sequência personalizada de evolução de aldeia.',
      steps: [
        { building: 'main', level: 10 },
        { building: 'barracks', level: 10 },
        { building: 'wall', level: 15 },
        { building: 'farm', level: 20 },
      ],
    });
    setNewConstName('');
    setNewConstDesc('');
  };

  const handleAddRecruitment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRecName.trim()) return;
    await onSaveRecruitmentModel({
      name: newRecName.trim(),
      category: newRecCategory,
      description: `Template ${newRecCategory.toUpperCase()} personalizado.`,
      troops: {
        spear: newRecSpear,
        sword: newRecSword,
        axe: newRecAxe,
        spy: newRecSpy,
        light: newRecLight,
        heavy: newRecHeavy,
        ram: newRecRam,
      },
    });
    setNewRecName('');
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Account Assignment Matrix */}
      <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-3">
        <h2 className="text-sm font-bold text-slate-100">
          Vínculo de Modelos por Conta Tribal Wars
        </h2>
        <p className="text-xs text-slate-400">
          Defina qual template de Construção e de Recrutamento cada conta utiliza por padrão.
        </p>

        {accounts.length === 0 ? (
          <p className="text-xs text-slate-500">Cadastre uma conta primeiro.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            {accounts.map((acc) => (
              <div
                key={acc._id}
                className="flex flex-col gap-2.5 rounded-xl border border-slate-800 bg-[#0f1218] p-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-100">
                    {acc.username} ({acc.world.toUpperCase()})
                  </span>
                  <span className="text-[11px] text-slate-400">{acc.group}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">
                      Modelo de Construção
                    </label>
                    <select
                      value={acc.constructionModelId || ''}
                      onChange={(e) =>
                        onAssignModelsToAccount(
                          acc._id,
                          e.target.value || undefined,
                          acc.recruitmentModelId
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-[#141923] px-2.5 py-1.5 text-xs text-slate-200"
                    >
                      <option value="">Nenhum</option>
                      {constructionModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">
                      Modelo de Recrutamento
                    </label>
                    <select
                      value={acc.recruitmentModelId || ''}
                      onChange={(e) =>
                        onAssignModelsToAccount(
                          acc._id,
                          acc.constructionModelId,
                          e.target.value || undefined
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-[#141923] px-2.5 py-1.5 text-xs text-slate-200"
                    >
                      <option value="">Nenhum</option>
                      {recruitmentModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Construction Models Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Hammer className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-bold text-slate-100">
              Modelos de Construção ({constructionModels.length})
            </h3>
          </div>

          <form onSubmit={handleAddConstruction} className="flex gap-2">
            <input
              type="text"
              required
              value={newConstName}
              onChange={(e) => setNewConstName(e.target.value)}
              placeholder="Nome do modelo (Ex: Rush Nobre K55)"
              className="flex-1 rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
            <input
              type="text"
              value={newConstDesc}
              onChange={(e) => setNewConstDesc(e.target.value)}
              placeholder="Descrição curta"
              className="flex-1 rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
            >
              <Plus className="h-3.5 w-3.5" />
              Criar
            </button>
          </form>

          <div className="space-y-3">
            {constructionModels.map((m) => (
              <div
                key={m.id}
                className="rounded-xl border border-slate-800 bg-[#0f1218] p-3.5 space-y-2"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs font-bold text-slate-100">{m.name}</div>
                    <div className="text-[11px] text-slate-400">{m.description}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingDelete({ kind: 'construction', id: m.id, name: m.name })
                    }
                    aria-label={`Remover modelo de construção ${m.name}`}
                    className="rounded p-1 text-slate-500 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.98]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {m.steps.map((s, idx) => (
                    <span
                      key={idx}
                      className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-300"
                    >
                      {idx + 1}. {BUILDING_LABELS[s.building] || s.building} Nv.{s.level}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recruitment Models Section */}
        <div className="rounded-2xl border border-slate-800 bg-[#141923] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sword className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-bold text-slate-100">
              Modelos de Recrutamento ({recruitmentModels.length})
            </h3>
          </div>

          <form onSubmit={handleAddRecruitment} className="space-y-2.5">
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={newRecName}
                onChange={(e) => setNewRecName(e.target.value)}
                placeholder="Nome do modelo de tropas"
                className="flex-1 rounded-lg border border-slate-700 bg-[#0f1218] px-3 py-1.5 text-xs text-slate-100"
              />
              <select
                value={newRecCategory}
                onChange={(e) =>
                  setNewRecCategory(
                    e.target.value as 'offensive' | 'defensive' | 'scout' | 'hybrid'
                  )
                }
                className="rounded-lg border border-slate-700 bg-[#0f1218] px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="offensive">Ofensivo</option>
                <option value="defensive">Defensivo</option>
                <option value="scout">Exploradores</option>
                <option value="hybrid">Híbrido</option>
              </select>
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                <Plus className="h-3.5 w-3.5" />
                Criar
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1.5 text-[10px]">
              {[
                { label: 'Lança', val: newRecSpear, set: setNewRecSpear },
                { label: 'Espada', val: newRecSword, set: setNewRecSword },
                { label: 'Bárbaro', val: newRecAxe, set: setNewRecAxe },
                { label: 'Spy', val: newRecSpy, set: setNewRecSpy },
                { label: 'CL', val: newRecLight, set: setNewRecLight },
                { label: 'CP', val: newRecHeavy, set: setNewRecHeavy },
                { label: 'Aríete', val: newRecRam, set: setNewRecRam },
              ].map((u) => (
                <div key={u.label} className="rounded border border-slate-800 bg-[#0f1218] p-1.5">
                  <div className="text-slate-400">{u.label}</div>
                  <input
                    type="number"
                    value={u.val}
                    onChange={(e) => u.set(Number(e.target.value) || 0)}
                    className="w-full bg-transparent text-xs font-semibold text-slate-100 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </form>

          <div className="space-y-3">
            {recruitmentModels.map((m) => (
              <div
                key={m.id}
                className="rounded-xl border border-slate-800 bg-[#0f1218] p-3.5 space-y-2"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    {m.category === 'defensive' ? (
                      <Shield className="h-3.5 w-3.5 text-sky-400" />
                    ) : (
                      <Sword className="h-3.5 w-3.5 text-rose-400" />
                    )}
                    <div>
                      <div className="text-xs font-bold text-slate-100">{m.name}</div>
                      <div className="text-[11px] text-slate-400">{m.description}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingDelete({ kind: 'recruitment', id: m.id, name: m.name })
                    }
                    aria-label={`Remover modelo de recrutamento ${m.name}`}
                    className="rounded p-1 text-slate-500 transition-colors duration-150 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.98]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 tabular-nums">
                  {Object.entries(m.troops).map(([unit, count]) =>
                    count && count > 0 ? (
                      <span
                        key={unit}
                        className="rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
                      >
                        {unit.toUpperCase()}: {count.toLocaleString('pt-BR')}
                      </span>
                    ) : null
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={
          pendingDelete?.kind === 'construction'
            ? 'Remover modelo de construção'
            : 'Remover modelo de recrutamento'
        }
        description={`Deseja remover o modelo "${pendingDelete?.name || ''}"?`}
        confirmLabel="Remover Modelo"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === 'construction') {
            await onDeleteConstructionModel(pendingDelete.id);
          } else {
            await onDeleteRecruitmentModel(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
};
