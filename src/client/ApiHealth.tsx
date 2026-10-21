import { useEffect, useRef, useState } from 'react';
import { Button } from '@mui/material';
import { accountFetch } from './api';
import { PageHeader } from './PageHeader';
import type { ApiHealthReport } from '../shared/api-health';

export function ApiHealth({ connections }: { connections: Array<{ id: string; name: string; tenantId: string }> }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id || '');
  const [report, setReport] = useState<ApiHealthReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const check = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setError(''); setReport(undefined);
    try {
      const response = await accountFetch(`/api/admin/service-titan/${connectionId}/health`, { method: 'POST', signal: request.signal });
      const body = await response.json() as ApiHealthReport & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to check ServiceTitan APIs.');
      if (!request.signal.aborted) setReport(body);
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to check ServiceTitan APIs.');
    } finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <main className='app-page'>
    <PageHeader eyebrow='Superadmin' title='API Health' description='Check access to the ServiceTitan APIs used by this app for a connection in the current workspace.' />
    <section className='panel account-panel'>
      {!connections.length ? <p>No ServiceTitan connections in this workspace. Add a connection in Settings.</p> : <>
        <label htmlFor='api-health-connection'>ServiceTitan connection</label>
        <select id='api-health-connection' value={connectionId} disabled={busy} onChange={(event) => { setConnectionId(event.target.value); setReport(undefined); setError(''); }}>
          {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} — Tenant {connection.tenantId}</option>)}
        </select>
        <Button variant='contained' disabled={busy || !connectionId} onClick={() => void check()}>{busy ? 'Checking APIs…' : 'Check APIs'}</Button>
        <p className='field-help'>Checks run only when requested, at most once per minute per connection. Availability reflects this connection’s access at the time of the check. Empty lists can still be available.</p>
      </>}
      {busy && <p role='status'>Checking ServiceTitan access. This may take up to a minute.</p>}
      {error && <p role='alert' className='notice error'>{error}</p>}
      {report && <>
        <p role='status'>Last checked: {new Date(report.checkedAt).toLocaleString()}. {report.checks.filter((check) => check.state === 'available').length} available, {report.checks.filter((check) => check.state === 'unavailable').length} unavailable, {report.checks.filter((check) => check.state === 'not_checked').length} not checked.</p>
        <div style={{ overflowX: 'auto' }}><table className='api-health-table'>
          <caption>ServiceTitan API availability</caption>
          <thead><tr><th scope='col'>API</th><th scope='col'>Availability</th><th scope='col'>Details</th></tr></thead>
          <tbody>{report.checks.map((check) => <tr key={check.name}>
            <th scope='row'>{check.name}<br /><code>{check.endpoint}</code></th>
            <td>{check.state === 'available' ? 'Available' : check.state === 'unavailable' ? 'Unavailable' : 'Not checked'}</td>
            <td>{check.message}{check.statusCode ? ` (HTTP ${check.statusCode})` : ''}{check.durationMs !== undefined ? ` · ${check.durationMs} ms` : ''}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
    </section>
  </main>;
}
