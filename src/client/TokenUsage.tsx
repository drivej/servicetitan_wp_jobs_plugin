import { useEffect, useState } from 'react';
import { Button } from '@mui/material';
import { accountFetch } from './api';

export function TokenUsage({ workspaceId }: { workspaceId: string }) {
  const [usage, setUsage] = useState<{ currentMonthUsage: number; previousMonthUsage: number }>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setUsage(undefined); setError('');
    void accountFetch('/api/tokens/summary').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load token usage.');
      if (active) setUsage(body);
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('job-tokens-changed', refresh);
    return () => { active = false; window.removeEventListener('job-tokens-changed', refresh); };
  }, [workspaceId, revision]);
  return <section className='panel account-panel' aria-label='Monthly token usage'>
    <h2>Monthly usage</h2>
    {error ? <p className='notice error' role='alert'>{error} <Button onClick={() => setRevision((value) => value + 1)}>Retry</Button></p> : !usage ? <p role='status'>Loading usage…</p> : <div className='token-usage-grid'>
      <div><h3>This month</h3><strong>{usage.currentMonthUsage.toLocaleString()}</strong><p>tokens used</p></div>
      <div><h3>Last month</h3><strong>{usage.previousMonthUsage.toLocaleString()}</strong><p>tokens used</p></div>
    </div>}
    <p className='field-help'>Calendar months in UTC. Usage includes token refunds; credits and plan purchases are excluded.</p>
  </section>;
}
