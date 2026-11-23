import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Confirmation dialog for destructive or high-impact actions.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
  onConfirm,
  onCancel,
}) => {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  const confirmClasses =
    tone === 'danger'
      ? 'bg-rose-500 text-white hover:bg-rose-400'
      : 'bg-amber-500 text-slate-950 hover:bg-amber-400';

  const iconColor = tone === 'danger' ? 'text-rose-400' : 'text-amber-400';

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      headerIcon={<AlertTriangle className={`h-5 w-5 shrink-0 ${iconColor}`} />}
      maxWidthClass="max-w-md"
    >
      <div className="p-6 space-y-5">
        <p className="text-xs leading-relaxed text-slate-300">{description}</p>
        <div className="flex items-center justify-end gap-2.5 border-t border-slate-800 pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-800 active:scale-[0.98] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirm}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors duration-150 active:scale-[0.98] disabled:opacity-50 ${confirmClasses}`}
          >
            {busy ? 'Processando...' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
};
