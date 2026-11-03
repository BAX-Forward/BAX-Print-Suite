import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { strings } from '../strings';
import styles from './Toasts.module.css';

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  success(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

const TOAST_TIMEOUT_MS = 6_000;
const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((current) => {
        if (current.some((toast) => toast.kind === kind && toast.message === message)) return current;
        return [...current, { id, kind, message }].slice(-MAX_TOASTS);
      });
      setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className={styles.region} aria-label={strings.common.notifications}>
        {/* Errors are announced assertively, everything else politely. */}
        <div role="alert" className={styles.stack}>
          {toasts
            .filter((toast) => toast.kind === 'error')
            .map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
        <div role="status" className={styles.stack}>
          {toasts
            .filter((toast) => toast.kind !== 'error')
            .map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  return (
    <div className={styles.toast} data-kind={toast.kind}>
      <span>{toast.message}</span>
      <button type="button" className="secondary" aria-label={strings.common.dismiss} onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
