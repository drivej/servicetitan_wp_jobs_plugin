import { Button } from '@mui/material';
import { useEffect, useId, useRef } from 'react';

export function ErrorDialog({ message, onClose, title, actionHref, actionLabel, detail }: { message: string; onClose: () => void; title?: string | undefined; actionHref?: string | undefined; actionLabel?: string | undefined; detail?: string | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (message && !dialog.current?.open) dialog.current?.showModal();
    if (!message && dialog.current?.open) dialog.current.close();
  }, [message]);

  return <dialog ref={dialog} className="error-modal token-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onClose={onClose}>
    <h2 id={titleId}>{title || 'Unable to complete the request'}</h2>
    <p id={descriptionId}>{message}</p>
    {detail && <p>{detail}</p>}
    <div className="account-actions">
      {actionHref ? <Button component="a" variant="contained" className="account-primary-link" href={actionHref}>{actionLabel || 'Open'}</Button> : <Button component="a" variant="contained" className="account-primary-link" href="/wordpress-integration#report-bug">Report bug</Button>}
      <Button type="button" onClick={() => dialog.current?.close()}>Close</Button>
    </div>
  </dialog>;
}
