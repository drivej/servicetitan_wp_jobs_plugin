import { Button, TextField } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';

interface Role { workspaceId: string; workspaceName: string; role: string; }
interface Member { id: string; name: string; email: string; disabled: boolean; isPlatformAdmin: boolean; roles: Role[]; }
interface Page { members: Member[]; nextCursor: string | null; }

export function AccountMembersAdmin() {
  const [viewAsMemberId, setViewAsMemberId] = useState('');
  const [viewAsWorkspaceId, setViewAsWorkspaceId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState('');
  const [page, setPage] = useState<Page>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [startingViewAs, setStartingViewAs] = useState(false);
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

  const startViewAs = async () => {
    if (!viewAsMemberId || !viewAsWorkspaceId) return;
    setStartingViewAs(true); setError('');
    try {
      const response = await accountFetch('/api/admin/impersonation/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUserId: viewAsMemberId, workspaceId: viewAsWorkspaceId }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Unable to view as this user.'); }
      window.location.assign('/jobs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to view as this user.'); setStartingViewAs(false); }
  };

  return <main className='app-page'>
    <p className='eyebrow'>Platform administration</p><h1>Account members</h1>
    <p className='intro'>View users and their roles across workspaces. Disabling a member ends their sessions and blocks new sign-ins.</p>
    {viewAsMemberId && <section className='panel member-view-as-panel'>
      <h2>Choose a workspace</h2>
      <p>Select the workspace to open with this member’s permissions and data.</p>
      <label>Workspace<select value={viewAsWorkspaceId} onChange={(event) => setViewAsWorkspaceId(event.target.value)}>
        {(page?.members.find((member) => member.id === viewAsMemberId)?.roles || []).map((role) => <option key={role.workspaceId} value={role.workspaceId}>{role.workspaceName} · {role.role}</option>)}
      </select></label>
      <div className='account-actions'><Button disabled={startingViewAs || !viewAsWorkspaceId} onClick={() => void startViewAs()}>{startingViewAs ? 'Opening…' : 'Start viewing as user'}</Button><Button disabled={startingViewAs} onClick={() => setViewAsMemberId('')}>Cancel</Button></div>
    </section>}
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
          <div className='account-actions'>{!member.disabled && <Button disabled={startingViewAs || member.roles.length === 0} onClick={() => { setError(''); setViewAsMemberId(member.id); setViewAsWorkspaceId(member.roles[0]?.workspaceId || ''); }}>View as</Button>}{!member.disabled && <Button disabled={Boolean(busy) || protectedMember} title={protectedMember ? 'Platform administrators cannot be disabled here' : undefined} onClick={() => void disable(member)}>{busy === member.id ? 'Disabling…' : 'Disable'}</Button>}</div>
        </li>;
      })}</ul>
      {page.members.length === 0 && <p>No members found.</p>}
      <div className='account-actions'>{after && <Button onClick={() => setAfter('')}>First page</Button>}{page.nextCursor && <Button onClick={() => setAfter(page.nextCursor!)}>Next members</Button>}</div>
    </>}
  </main>;
}
