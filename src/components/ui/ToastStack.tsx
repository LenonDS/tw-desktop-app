import React from 'react';
import { X } from 'lucide-react';

export interface ToastItem {
  id: string;
  message: string;
}

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

/**
 * Fixed non-shifting toast notification stack with polite live-region announcements.
 */
export const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-5 right-5 z-50 flex max-w-md flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-surface-card/95 px-4 py-2.5 text-xs text-amber-100 shadow-xl"
        >
          <span className="leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Fechar notificação"
            className="shrink-0 rounded-md p-1 text-amber-300 transition-colors duration-150 hover:bg-amber-500/15 hover:text-amber-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
