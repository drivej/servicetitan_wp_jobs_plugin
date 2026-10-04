import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';

interface Role { workspaceId: string; workspaceName: string; role: string; }
interface Member { id: string; name: string; email: string; disabled: boolean; isPlatformAdmin: boolean; roles: Role[]; }
interface Page { members: Member[]; nextCursor: string | null; }

export function AccountMembersAdmin() {
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
    <form className='account-actions' onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(search); setAfter(''); setRevision((value) => value + 1); }}>
      <label>Name or email<input value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /></label>
      <button disabled={loading}>Search</button>
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
          {!member.disabled && <button disabled={Boolean(busy) || protectedMember} title={protectedMember ? 'Platform administrators cannot be disabled here' : undefined} onClick={() => void disable(member)}>{busy === member.id ? 'Disabling…' : 'Disable'}</button>}
        </li>;
      })}</ul>
      {page.members.length === 0 && <p>No members found.</p>}
      <div className='account-actions'>{after && <button onClick={() => setAfter('')}>First page</button>}{page.nextCursor && <button onClick={() => setAfter(page.nextCursor!)}>Next members</button>}</div>
    </>}
  </main>;
}
