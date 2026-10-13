import { Button, TextField } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';

interface Website { name: string; url: string; }
interface Member { id: string; name: string; email: string; disabled: boolean; isPlatformAdmin: boolean; role: string; }
interface Account { workspaceId: string; name: string; websites: Website[]; members: Member[]; }
interface Page { accounts: Account[]; nextCursor: string | null; }

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
  const [startingViewAs, setStartingViewAs] = useState('');
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
    const ownsWorkspace = member.role === 'owner';
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

  const startViewAs = async (memberId: string, workspaceId: string) => {
    if (!memberId || !workspaceId) return;
    setStartingViewAs(memberId); setError('');
    try {
      const response = await accountFetch('/api/admin/impersonation/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUserId: memberId, workspaceId }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Unable to view as this user.'); }
      window.location.assign('/jobs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to view as this user.'); setStartingViewAs(''); }
  };

  return <main className='app-page'>
    <p className='eyebrow'>Platform administration</p><h1>Account members</h1>
    <p className='intro'>Accounts are grouped by workspace, with administrators first. Disabling a member ends their sessions and blocks new sign-ins.</p>
    <form className='account-actions' onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(search); setAfter(''); setRevision((value) => value + 1); }}>
      <label>Name or email<TextField variant="outlined" size="small" value={search} slotProps={{ htmlInput: { maxLength: 200 } }} onChange={(event) => setSearch(event.target.value)} /></label>
      <Button disabled={loading}>Search</Button>
    </form>
    {error && <p className='notice error' role='alert'>{error}</p>}
    {message && <p className='notice' role='status'>{message}</p>}
    {loading && <p role='status'>Loading members…</p>}
    {page && !loading && <>
      <div className='account-groups'>{page.accounts.map((account) => <section className='account-group' key={account.workspaceId}>
        <header className='account-group-header'>
          <h2>{account.name}</h2>
          {account.websites.map((website) => <small key={website.url}>{website.name}: <a href={website.url} target='_blank' rel='noreferrer'>{website.url}</a></small>)}
        </header>
        <ul className='account-resource-list'>
          {account.members.filter((member) => member.role !== 'member').map((member) => <AccountMemberRow key={member.id} member={member} workspaceId={account.workspaceId} isAccountAdmin onViewAs={startViewAs} onDisable={disable} busy={busy} startingViewAs={startingViewAs} />)}
          {account.members.filter((member) => member.role === 'member').map((member) => <AccountMemberRow key={member.id} member={member} workspaceId={account.workspaceId} onViewAs={startViewAs} onDisable={disable} busy={busy} startingViewAs={startingViewAs} />)}
        </ul>
      </section>)}</div>
      {page.accounts.length === 0 && <p>No accounts found.</p>}
      <div className='account-actions'>{after && <Button onClick={() => setAfter('')}>First page</Button>}{page.nextCursor && <Button onClick={() => setAfter(page.nextCursor!)}>Next accounts</Button>}</div>
    </>}
  </main>;
}

function AccountMemberRow({ member, workspaceId, isAccountAdmin = false, onViewAs, onDisable, busy, startingViewAs }: {
  member: Member;
  workspaceId: string;
  isAccountAdmin?: boolean;
  onViewAs: (memberId: string, workspaceId: string) => Promise<void>;
  onDisable: (member: Member) => Promise<void>;
  busy: string;
  startingViewAs: string;
}) {
  const protectedMember = member.isPlatformAdmin;
  return <li className={isAccountAdmin ? 'account-admin-row' : 'account-member-row'}>
    <div><strong>{member.name}{isAccountAdmin ? ' · Account admin' : ''}</strong><small>{member.email} · {member.disabled ? 'Disabled' : 'Active'}{member.isPlatformAdmin ? ' · Platform admin' : ''}{!isAccountAdmin ? ` · ${member.role}` : ''}</small></div>
    <div className='account-actions'>
      {!member.disabled && <Button disabled={Boolean(startingViewAs)} onClick={() => void onViewAs(member.id, workspaceId)}>{startingViewAs === member.id ? 'Opening…' : 'View as'}</Button>}
      {!member.disabled && <Button disabled={Boolean(busy) || protectedMember} title={protectedMember ? 'Platform administrators cannot be disabled here' : undefined} onClick={() => void onDisable(member)}>{busy === member.id ? 'Disabling…' : 'Disable'}</Button>}
    </div>
  </li>;
}
