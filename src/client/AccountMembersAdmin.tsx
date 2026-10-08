import { Button, TextField } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';

interface Role { workspaceId: string; workspaceName: string; role: string; }
interface Member { id: string; name: string; email: string; disabled: boolean; isPlatformAdmin: boolean; roles: Role[]; }
interface Page { members: Member[]; nextCursor: string | null; }
interface PreviewOptions { member: { id: string; name: string; email: string }; workspaces: Array<{ workspaceId: string; workspaceName: string; role: string; websites: Array<{ id: string; name: string }> }>; }
interface PreviewJob { id: number; jobNumber: string; jobName: string; status: string; completedOn?: string; location: { city: string; state: string; zip: string }; }
interface PreviewJobsPage { data: PreviewJob[]; page: number; hasMore: boolean; totalCount?: number; }

function MemberJobPreview({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const [options, setOptions] = useState<PreviewOptions>();
  const [workspaceId, setWorkspaceId] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); });
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [jobs, setJobs] = useState<PreviewJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rawJob, setRawJob] = useState<{ id: number; data: unknown }>();
  const [rawLoading, setRawLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number>();
  useEffect(() => {
    let active = true;
    void accountFetch(`/api/admin/members/${memberId}/job-preview`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to open the member job preview.');
      if (active) {
        const result = body as PreviewOptions;
        setOptions(result);
        const firstWorkspace = result.workspaces.find((workspace) => workspace.websites.length > 0);
        if (firstWorkspace) { setWorkspaceId(firstWorkspace.workspaceId); setWebsiteId(firstWorkspace.websites[0]!.id); }
      }
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [memberId]);
  useEffect(() => {
    if (!workspaceId || !websiteId) return;
    let active = true;
    setLoading(true); setError(''); setRawJob(undefined);
    const params = new URLSearchParams({ workspaceId, websiteId, start, end, page: String(page), pageSize: '50' });
    void accountFetch(`/api/admin/members/${memberId}/job-preview/jobs?${params}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load jobs for this member.');
      if (active) {
        const result = body as PreviewJobsPage;
        setJobs(result.data || []); setHasMore(result.hasMore); setTotalCount(result.totalCount);
      }
    }).catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [memberId, workspaceId, websiteId, start, end, page, revision]);
  const workspace = options?.workspaces.find((item) => item.workspaceId === workspaceId);
  const inspect = async (jobId: number) => {
    if (!workspaceId || !websiteId) return;
    setRawLoading(true); setRawJob(undefined); setError('');
    const params = new URLSearchParams({ workspaceId, websiteId });
    try {
      const response = await accountFetch(`/api/admin/members/${memberId}/job-preview/jobs/${jobId}/raw?${params}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load the ServiceTitan response.');
      setRawJob({ id: jobId, data: body.data });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load the ServiceTitan response.'); }
    finally { setRawLoading(false); }
  };
  return <section className='member-job-preview'>
    <div className='account-actions'><Button onClick={onBack}>← Back to members</Button></div>
    <p className='eyebrow'>Read-only support preview</p>
    <h2>{options?.member.name || 'Member jobs'}</h2>
    <p className='field-help'>Viewing job data as {options?.member.email || 'the selected member'}. This preview cannot edit jobs, publish to WordPress, or spend tokens.</p>
    <div className='notice'>Super admin support preview · Read only</div>
    {options && <div className='account-actions member-preview-filters'>
      <label>Workspace<select value={workspaceId} onChange={(event) => { const selected = options.workspaces.find((item) => item.workspaceId === event.target.value); setWorkspaceId(event.target.value); setWebsiteId(selected?.websites[0]?.id || ''); setPage(1); }}>
        {options.workspaces.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.workspaceName} · {item.role}</option>)}
      </select></label>
      <label>Website<select value={websiteId} onChange={(event) => { setWebsiteId(event.target.value); setPage(1); }}>
        {(workspace?.websites || []).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>
      <label>From<TextField size='small' type='date' value={start} onChange={(event) => { setStart(event.target.value); setPage(1); }} /></label>
      <label>Through<TextField size='small' type='date' value={end} onChange={(event) => { setEnd(event.target.value); setPage(1); }} /></label>
      <Button onClick={() => { setPage(1); setRevision((value) => value + 1); }} disabled={loading || !websiteId}>Refresh jobs</Button>
    </div>}
    {!options && !error && <p role='status'>Loading member workspaces…</p>}
    {options && !options.workspaces.some((item) => item.websites.length > 0) && <p className='notice'>This member has no active website with a ServiceTitan connection.</p>}
    {error && <p className='notice error' role='alert'>{error}</p>}
    {loading && <p role='status'>Loading ServiceTitan jobs…</p>}
    {jobs.length > 0 && <><p className='field-help'>Page {page}{totalCount !== undefined ? ` · ${totalCount.toLocaleString()} jobs total` : ''}</p><div className='table-wrap'><table className='jobs-table member-preview-table'>
      <thead><tr><th>Job</th><th>Status</th><th>Completed</th><th>Location</th><th>Debug</th></tr></thead>
      <tbody>{jobs.map((job) => <tr key={job.id}><td><strong>#{job.jobNumber}</strong><br />{job.jobName}</td><td>{job.status}</td><td>{job.completedOn ? new Date(job.completedOn).toLocaleDateString() : '—'}</td><td>{[job.location.city, job.location.state, job.location.zip].filter(Boolean).join(', ') || '—'}</td><td><Button size='small' disabled={rawLoading} onClick={() => void inspect(job.id)}>Raw response</Button></td></tr>)}</tbody>
    </table></div><div className='account-actions'>{page > 1 && <Button disabled={loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous jobs</Button>}{hasMore && <Button disabled={loading} onClick={() => setPage((value) => value + 1)}>Next jobs</Button>}</div></>}
    {!loading && options && websiteId && jobs.length === 0 && !error && <p>No jobs found in this date range.</p>}
    {rawLoading && <p role='status'>Loading raw response…</p>}
    {rawJob && <details className='panel details-panel raw-api-panel' open><summary>ServiceTitan response for job #{rawJob.id}</summary><pre className='raw-api-json'><code>{JSON.stringify(rawJob.data, null, 2)}</code></pre></details>}
  </section>;
}

export function AccountMembersAdmin() {
  const [previewMemberId, setPreviewMemberId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState('');
  const [page, setPage] = useState<Page>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void accountFetch(`/api/admin/members?search=${encodeURIComponent(query)}&after=${encodeURIComponent(after)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load account members.');
        if (active) setPage(body as Page);
      }).catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, after, revision]);

  const disable = async (member: Member) => {
    const ownsWorkspace = member.roles.some((role) => role.role === 'owner');
    if (!window.confirm(`Disable ${member.name} (${member.email})? They will lose access to every workspace and be signed out.${ownsWorkspace ? ' Members of workspaces they own will also lose access.' : ''}`)) return;
    setBusy(member.id); setError(''); setMessage('');
    try {
      const response = await accountFetch(`/api/admin/members/${member.id}/disable`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || 'Unable to disable member.');
      }
      setMessage(`${member.name} has been disabled.`);
      setRevision((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to disable member.'); }
    finally { setBusy(''); }
  };

  return <main className='account-page'>
    <p className='eyebrow'>Platform administration</p><h1>Account members</h1>
    <p className='intro'>View users and their roles across workspaces. Disabling a member ends their sessions and blocks new sign-ins.</p>
    {previewMemberId ? <MemberJobPreview memberId={previewMemberId} onBack={() => setPreviewMemberId('')} /> : <>
    <form className='account-actions' onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(search); setAfter(''); setRevision((value) => value + 1); }}>
      <label>Name or email<TextField variant="outlined" size="small" value={search} slotProps={{ htmlInput: { maxLength: 200 } }} onChange={(event) => setSearch(event.target.value)} /></label>
      <Button disabled={loading}>Search</Button>
    </form>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {message && <p className='notice' role='status'>{message}</p>}
    {loading && <p role='status'>Loading members…</p>}
    {page && !loading && <>
      <ul className='account-resource-list'>{page.members.map((member) => {
        const protectedMember = member.isPlatformAdmin;
        return <li key={member.id}>
          <div><strong>{member.name}</strong><small>{member.email} · {member.disabled ? 'Disabled' : 'Active'}{member.isPlatformAdmin ? ' · Platform admin' : ''}</small>
            {member.roles.map((role) => <small key={role.workspaceId}>{role.workspaceName}: {role.role}</small>)}
          </div>
          <div className='account-actions'>{!member.disabled && <Button disabled={Boolean(busy) || protectedMember} title={protectedMember ? 'Platform administrators cannot be disabled here' : undefined} onClick={() => void disable(member)}>{busy === member.id ? 'Disabling…' : 'Disable'}</Button>}{!member.disabled && <Button onClick={() => { setError(''); setPreviewMemberId(member.id); }}>View jobs</Button>}</div>
        </li>;
      })}</ul>
      {page.members.length === 0 && <p>No members found.</p>}
      <div className='account-actions'>{after && <Button onClick={() => setAfter('')}>First page</Button>}{page.nextCursor && <Button onClick={() => setAfter(page.nextCursor!)}>Next members</Button>}</div>
    </>}
    </>}
  </main>;
}
