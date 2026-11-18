import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// Promise-based replacement for window.confirm(): `if (!(await confirm({...}))) return;`
// Browser dialogs are suppressed in some embedded/PWA contexts and can't say what is
// about to be lost, so this one names the thing and styles destructive actions.
const Ctx = createContext(() => Promise.resolve(false));

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);

  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = useCallback((value) => {
    setState((s) => { s?.resolve(value); return null; });
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {state && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <div className="modal" style={{ maxWidth: 420 }} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal-title" id="confirm-title">{state.title || 'Are you sure?'}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{state.message}</div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => close(false)}>{state.cancelLabel || 'Cancel'}</button>
              <button className={state.danger ? 'btn-danger' : ''} autoFocus onClick={() => close(true)}>
                {state.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useConfirm = () => useContext(Ctx);
