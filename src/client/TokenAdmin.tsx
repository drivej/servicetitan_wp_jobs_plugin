import { TextField } from '@mui/material';
import { Button } from '@mui/material';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountFetch } from './api';
import { TokenHistory } from './TokenHistory';
interface Account { id: string; name: string; ownerEmail: string; ownerName: string; balance: number; }
interface Accounts { accounts: Account[]; nextCursor: string | null; }
interface Adjustment { requestId: string; amount: number; reason: string; }
interface SpendOperation { operationId: string; actorUserId: string; jobId: number | null; action: string; state: string; createdAt: string; updatedAt: string; }
function AdjustmentForm({ account, onPosted }: { account: Account; onPosted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Adjustment>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const adjustment = pending || { requestId: crypto.randomUUID(), amount: Number(data.get('amount')), reason: String(data.get('reason') || '').trim() };
    if (!Number.isSafeInteger(adjustment.amount) || adjustment.amount === 0 || !adjustment.reason) { setError('Enter a nonzero whole number and a reason.'); return; }
    submitting.current = true; setPending(adjustment); setBusy(true); setError(''); setMessage('');
    try {
      const response = await accountFetch(`/api/admin/token-accounts/${account.id}/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(adjustment) });
      const body = await response.json();
      if (!response.ok) {
        // A definitive rejection can be edited. Network/server failures retain
        // the exact request ID and payload so Retry cannot credit twice.
        if ([400, 401, 403, 404, 409].includes(response.status)) setPending(undefined);
        throw new Error(body.error || 'Unable to post adjustment. Retry the same transaction.');
      }
      setMessage(`Transaction recorded. Balance: ${Number(body.balance).toLocaleString()} tokens.`);
      setPending(undefined); form.reset(); onPosted(); window.dispatchEvent(new Event('job-tokens-changed'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to post adjustment. Retry the same transaction.'); }
    finally { setBusy(false); submitting.current = false; }
  };
  return <section className='panel account-panel'>
    <h2>Post token adjustment</h2>
    <p>Account: <strong>{account.name}</strong> · {account.ownerEmail}</p>
    <p className='field-help'>Use a positive amount to add tokens or a negative amount to deduct them. Admin adjustments bypass the subscription rollover cap, but cannot make the balance negative.</p>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {message && <p className='notice' role='status'>{message}</p>}
    <form className='account-form' onSubmit={(event) => void submit(event)}>
      <label>Token amount<TextField variant="outlined" size="small" fullWidth name='amount' type='number' required slotProps={{ htmlInput: { step: 1, min: -2147483647, max: 2147483647, readOnly: Boolean(pending) } }} /></label>
      <label>Reason<TextField variant="outlined" size="small" fullWidth multiline name='reason' required rows={3} slotProps={{ htmlInput: { maxLength: 500, readOnly: Boolean(pending) } }} placeholder='Explain the credit or correction' /></label>
      <Button variant='contained' className='primary' disabled={busy}>{busy ? 'Posting…' : pending ? 'Retry this transaction' : 'Post adjustment'}</Button>
      {pending && !busy && <p className='field-help'>Keep this page open and retry to confirm the result without creating a duplicate.</p>}
    </form>
  </section>;
}
function SpendReconciliation({ account, revision, onResolved }: { account: Account; revision: number; onResolved: () => void }) {
  const [operations, setOperations] = useState<SpendOperation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let active = true;
    void accountFetch(`/api/admin/token-accounts/${account.id}/spend-operations`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load unresolved token operations.');
      if (active) setOperations(body.operations as SpendOperation[]);
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [account.id, revision]);
  const resolve = async (operation: SpendOperation, decision: 'confirm' | 'refund') => {
    const prompt = decision === 'confirm'
      ? 'Confirm the provider completed this operation. The reserved token will remain spent.'
      : 'Confirm the provider did not complete this operation. The token will be refunded.';
    if (!window.confirm(prompt)) return;
    setBusy(operation.operationId); setError('');
    try {
      const response = await accountFetch(`/api/admin/token-accounts/${account.id}/spend-operations/${encodeURIComponent(operation.operationId)}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to reconcile this operation.');
      setOperations((items) => items.filter((item) => item.operationId !== operation.operationId));
      onResolved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to reconcile this operation.'); }
    finally { setBusy(''); }
  };
  return <section className='panel account-panel'>
    <h2>Unresolved token operations</h2>
    <p className='field-help'>Check WordPress before resolving. Confirm keeps the debit; refund returns the token. Only operations older than 30 minutes can be resolved.</p>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {operations.length === 0 ? <p>No unresolved operations.</p> : <ul className='account-resource-list'>{operations.map((operation) => <li key={operation.operationId}>
      <div><strong>{operation.action}{operation.jobId ? ` · Job ${operation.jobId}` : ''}</strong><small>{operation.state} · {new Date(operation.createdAt).toLocaleString()} · {operation.operationId}</small></div>
      <div className='account-actions'>
        <Button disabled={Boolean(busy)} onClick={() => void resolve(operation, 'confirm')}>Confirm completed</Button>
        <Button disabled={Boolean(busy)} onClick={() => void resolve(operation, 'refund')}>Refund token</Button>
      </div>
    </li>)}</ul>}
  </section>;
}
export function TokenAdmin() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState('');
  const [accounts, setAccounts] = useState<Accounts>();
  const [selected, setSelected] = useState<Account>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void accountFetch(`/api/admin/token-accounts?search=${encodeURIComponent(query)}&after=${encodeURIComponent(after)}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load token accounts.');
      if (active) setAccounts(body as Accounts);
    }).catch((reason: Error) => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, after, revision]);
  return <main className='account-page'>
    <p className='eyebrow'>Platform administration</p><h1>Token accounts</h1>
    <form className='account-actions' onSubmit={(event) => { event.preventDefault(); setQuery(search); setAfter(''); setRevision((v) => v + 1); }}>
      <label>Workspace or owner email<TextField variant="outlined" size="small" value={search} slotProps={{ htmlInput: { maxLength: 200 } }} onChange={(event) => setSearch(event.target.value)} /></label>
      <Button disabled={loading}>Search</Button>
    </form>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {loading && <p role='status'>Loading accounts…</p>}
    {accounts && !loading && !error && <>
      <ul className='account-resource-list'>{accounts.accounts.map((account) => <li key={account.id}>
        <div><strong>{account.name}</strong><small>{account.ownerEmail} · {account.balance.toLocaleString()} tokens</small></div>
        <Button onClick={() => setSelected(account)} aria-pressed={selected?.id === account.id}>View account</Button>
      </li>)}</ul>
      {accounts.accounts.length === 0 && <p>No accounts found.</p>}
      <div className='account-actions'>{after && <Button onClick={() => setAfter('')}>First page</Button>}{accounts.nextCursor && <Button onClick={() => setAfter(accounts.nextCursor!)}>Next accounts</Button>}</div>
    </>}
    {selected && <>
      <AdjustmentForm key={selected.id} account={selected} onPosted={() => setRevision((v) => v + 1)} />
      <SpendReconciliation key={`spends:${selected.id}`} account={selected} revision={revision} onResolved={() => setRevision((v) => v + 1)} />
      <TokenHistory key={selected.id} workspaceId={selected.id} platform revision={revision} />
    </>}
  </main>;
}
