import { Button } from '@mui/material';
import { useEffect, useState } from 'react';
import { accountFetch } from './api';
interface Transaction {
  id: string; sequence: string; kind: string; amount: number; requestedAmount: number; discardedAmount: number;
  balanceBefore: number; balanceAfter: number; actorName: string | null; actorUserId: string | null;
  reason: string; reference: string; stripeInvoiceId: string | null; jobId: number | null; createdAt: string;
}
interface History { workspaceName: string; balance: number; ledgerBalance: number; reconciled: boolean; transactions: Transaction[]; nextCursor: string | null; }
const kinds: Record<string, string> = { opening: 'Opening balance', stripe_credit: 'Subscription credit', spend: 'Usage', spend_refund: 'Usage refund', test_credit: 'Test credit', admin_adjustment: 'Admin adjustment' };
const signed = (amount: number) => `${amount > 0 ? '+' : ''}${amount.toLocaleString()}`;
export function TokenHistory({ workspaceId, platform = false, revision = 0 }: { workspaceId: string; platform?: boolean; revision?: number }) {
  const [history, setHistory] = useState<History>();
  const [before, setBefore] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { setBefore(''); setCursors([]); }, [workspaceId, revision]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const endpoint = platform ? `/api/admin/token-accounts/${workspaceId}/transactions` : '/api/tokens/history';
    void accountFetch(`${endpoint}?before=${encodeURIComponent(before)}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load token history.');
      if (active) setHistory(body as History);
    }).catch((reason: Error) => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, platform, before, revision, refresh]);
  return <section className='panel account-panel token-history' aria-label='Token transaction history'>
    <div className='account-actions'><h2>Token history</h2><Button disabled={loading} onClick={() => setRefresh((v) => v + 1)}>Refresh history</Button></div>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {loading && <p role='status'>Loading transactions…</p>}
    {history && !loading && !error && <>
      <p><strong>{history.balance.toLocaleString()}</strong> tokens available · {history.workspaceName}</p>
      {!history.reconciled && <p className='notice error' role='alert'>The account balance does not match its transaction history. Contact a platform administrator.</p>}
      {history.transactions.length === 0 ? <p>No token transactions yet.</p> : <div className='token-table-scroll' tabIndex={0} role='region' aria-label='Scrollable token transactions'>
        <table className='token-table'>
          <thead><tr><th scope='col'>Date / type</th><th scope='col'>Change</th><th scope='col'>Balance</th><th scope='col'>Details</th></tr></thead>
          <tbody>{history.transactions.map((tx) => <tr key={tx.id}>
            <td><time dateTime={tx.createdAt}>{new Date(tx.createdAt).toLocaleString()}</time><small>{kinds[tx.kind] || tx.kind}</small></td>
            <td>{signed(tx.amount)}{tx.discardedAmount > 0 && <small>{tx.requestedAmount.toLocaleString()} requested; {tx.discardedAmount.toLocaleString()} discarded by cap</small>}</td>
            <td>{tx.balanceBefore.toLocaleString()} → {tx.balanceAfter.toLocaleString()}</td>
            <td>{tx.reason}<small>{tx.actorName || tx.actorUserId || 'System'}</small>{tx.jobId !== null && <small>Job {tx.jobId}</small>}<small className='token-reference'>{tx.stripeInvoiceId || tx.reference}</small></td>
          </tr>)}</tbody>
        </table>
      </div>}
      <div className='account-actions'>
        {cursors.length > 0 && <Button onClick={() => { setBefore(cursors.at(-1)!); setCursors((items) => items.slice(0, -1)); }}>Newer transactions</Button>}
        {history.nextCursor && <Button onClick={() => { setCursors((items) => [...items, before]); setBefore(history.nextCursor!); }}>Older transactions</Button>}
      </div>
      <p className='field-help'>Credits and debits are permanent. Corrections appear as new transactions. Opening entries preserve balances from before the ledger was introduced.</p>
    </>}
  </section>;
}
