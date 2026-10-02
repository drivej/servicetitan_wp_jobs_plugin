import { useEffect, useId, useRef } from 'react';

export function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (message && !dialog.current?.open) dialog.current?.showModal();
    if (!message && dialog.current?.open) dialog.current.close();
  }, [message]);

  return <dialog ref={dialog} className="error-modal token-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onClose={onClose}>
    <h2 id={titleId}>Unable to complete the request</h2>
    <p id={descriptionId}>{message}</p>
    <div className="account-actions">
      <a className="account-primary-link" href="/wordpress-integration#report-bug">Report bug</a>
      <button type="button" onClick={() => dialog.current?.close()}>Close</button>
    </div>
  </dialog>;
}
