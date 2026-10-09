import { Checkbox } from '@mui/material';
import { Button } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';
import { isSaaSWorkspace, tokenPreferenceKey } from './api';

const actionLabels = {
  ai_generation: 'Generate Copy',
  push: 'Push to WordPress',
  update_seo: 'Update SEO',
} as const;
type TokenAction = keyof typeof actionLabels;
interface PendingConfirmation {
  action: TokenAction;
  preferenceKey: string;
  resolve: (confirmed: boolean) => void;
}

// Each action has its own preference; include the price so a price change asks again.
export function useTokenSpendConfirmation() {
  const [pending, setPending] = useState<PendingConfirmation>();
  const pendingRef = useRef<PendingConfirmation | undefined>(undefined);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal();
  }, [pending]);
  useEffect(() => () => {
    pendingRef.current?.resolve(false);
    pendingRef.current = undefined;
  }, []);

  const confirmTokenSpend = (action: TokenAction): Promise<boolean> => {
    if (pendingRef.current) return Promise.resolve(false);
    // Standalone installations do not charge tokens.
    if (!isSaaSWorkspace()) return Promise.resolve(true);
    const preferenceKey = tokenPreferenceKey(action, 1);
    try {
      if (window.localStorage.getItem(preferenceKey) === 'hidden') return Promise.resolve(true);
    } catch { /* Ask normally when browser storage is unavailable. */ }
    setDontShowAgain(false);
    return new Promise((resolve) => {
      const confirmation = { action, preferenceKey, resolve };
      pendingRef.current = confirmation;
      setPending(confirmation);
    });
  };

  const finish = (confirmed: boolean) => {
    const confirmation = pendingRef.current;
    if (!confirmation) return;
    if (confirmed && dontShowAgain) {
      try { window.localStorage.setItem(confirmation.preferenceKey, 'hidden'); }
      catch { /* A storage restriction must not prevent the action. */ }
    }
    pendingRef.current = undefined;
    dialog.current?.close();
    setPending(undefined);
    confirmation.resolve(confirmed);
  };

  const tokenSpendDialog = <dialog
    ref={dialog}
    className="error-modal token-dialog"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); finish(false); }}
  >
    <h2 id={titleId}>{pending ? actionLabels[pending.action] : 'Confirm token spend'}</h2>
    <p id={descriptionId}>This will cost 1 token. Continue?</p>
    <label className="token-spend-preference">
      <Checkbox checked={dontShowAgain} onChange={(event) => setDontShowAgain(event.target.checked)} />
      <span>Don’t show this again for this action</span>
    </label>
    <div className="account-actions">
      <Button type="button" autoFocus onClick={() => finish(false)}>Cancel</Button>
      <Button type="button" variant="contained" className="primary" onClick={() => finish(true)}>Continue</Button>
    </div>
  </dialog>;

  return { confirmTokenSpend, tokenSpendDialog };
}
