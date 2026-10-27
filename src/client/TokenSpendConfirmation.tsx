import { Button } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';
import { isSaaSWorkspace } from './api';
import { GoldCoins } from './TokenBalanceCard';
import { TOKEN_ACTIONS, type TokenAction } from '../shared/token-actions';
interface PendingConfirmation {
  action: TokenAction;
  resolve: (confirmed: boolean) => void;
}
const actionCopy: Record<TokenAction, { title: string; benefit: string; approve: string }> = {
  job_scan: { title: 'Find your next great posts', benefit: 'AI Job Scout searches completed jobs using your current search filters, skips jobs already in WordPress, and prepares up to five drafts for your review. You choose what to publish.', approve: 'Approve scan & drafts' },
  ai_generation: { title: 'Bring this job to life', benefit: 'Create fresh post copy from your job’s details, ready for you to review.', approve: 'Spend 1 token & generate' },
  build: { title: 'Make your next great post', benefit: 'Turn this job into a WordPress draft, ready for your review.', approve: 'Spend 1 token & build' },
  update: { title: 'Give this post a fresh spark', benefit: 'Generate fresh copy and update your WordPress post.', approve: 'Spend 1 token & update' },
  publish: { title: 'Ready to share your work?', benefit: 'Publish your WordPress draft.', approve: 'Publish draft' },
};

export function useTokenSpendConfirmation() {
  const [pending, setPending] = useState<PendingConfirmation>();
  const pendingRef = useRef<PendingConfirmation | undefined>(undefined);
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

  const confirmTokenSpend = (action: TokenAction, alwaysConfirm = false): Promise<boolean> => {
    if (pendingRef.current) return Promise.resolve(false);
    // Standalone installations and free actions do not charge tokens.
    if ((!isSaaSWorkspace() && !alwaysConfirm) || TOKEN_ACTIONS[action].cost === 0) return Promise.resolve(true);
    // Every paid action needs explicit approval, including accounts that saved
    // a "hide confirmation" preference in an older version.
    return new Promise((resolve) => {
      const confirmation = { action, resolve };
      pendingRef.current = confirmation;
      setPending(confirmation);
    });
  };

  const finish = (confirmed: boolean) => {
    const confirmation = pendingRef.current;
    if (!confirmation) return;
    pendingRef.current = undefined;
    dialog.current?.close();
    setPending(undefined);
    confirmation.resolve(confirmed);
  };
  const action = pending?.action || 'build';
  const copy = actionCopy[action];
  const scanning = action === 'job_scan';
  const cost = TOKEN_ACTIONS[action].cost;

  const tokenSpendDialog = <dialog
    ref={dialog}
    className='token-approval-dialog'
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); finish(false); }}
  >
    <div className='token-approval-hero'>
      <span className='token-approval-eyebrow'>A little token. A lot of possibility.</span>
      <div className='token-approval-art'><GoldCoins /></div>
      <span className='token-approval-action'>{TOKEN_ACTIONS[action].label}</span>
      <h2 id={titleId}>{copy.title}</h2>
      <p>{copy.benefit}</p>
    </div>
    <div className='token-approval-body'>
      <div className='token-approval-cost'>
        <span>{scanning ? 'Maximum spend' : 'You’re approving'}</span>
        <strong>{scanning ? 'Up to 6' : cost} <span>{!scanning && cost === 1 ? 'token' : 'tokens'}</span></strong>
      </div>
      <p id={descriptionId}>{scanning
        ? '1 token for the scan, plus 1 token for each draft built (up to 5). Approving authorizes up to 6 tokens from your account balance.'
        : `Approve spending ${cost} ${cost === 1 ? 'token' : 'tokens'} from your account balance to ${action === 'ai_generation' ? 'generate this copy' : action === 'update' ? 'update this post' : 'build this draft'}.`}</p>
      <div className='token-approval-actions'>
        <Button type='button' autoFocus className='token-approval-cancel' onClick={() => finish(false)}>Maybe Later</Button>
        <Button type='button' variant='contained' className='token-approval-confirm' onClick={() => finish(true)}>{copy.approve}<span className='token-approval-arrow' aria-hidden='true'>→</span></Button>
      </div>
      <p className='token-approval-footnote'>Nothing starts until you approve.</p>
    </div>
  </dialog>;

  return { confirmTokenSpend, tokenSpendDialog };
}
