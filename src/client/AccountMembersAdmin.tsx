import { Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';
import { LoadingModal } from './LoadingModal';

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
  const [deleteTarget,setDeleteTarget]=useState<Account>();
  const [deleteConfirmation,setDeleteConfirmation]=useState('');
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

  const toggleAccess = async (member: Member) => {
    const enabling = member.disabled;
    if (!enabling && !window.confirm(`Disable ${member.email}? They will lose access to every workspace and be signed out.${member.role === 'owner' ? ' Members of workspaces they own will also lose access.' : ''}`)) return;
    setBusy(member.id); setError(''); setMessage('');
    try {
      const response = await accountFetch(`/api/admin/members/${member.id}/${enabling ? 'enable' : 'disable'}`, { method: 'POST' });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Unable to update member access.'); }
      setMessage(`${member.email} has been ${enabling ? 'enabled' : 'disabled'}.`);
      setRevision(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update member access.'); }
    finally { setBusy(''); }
  };

  const deleteAccount = async () => {
    if (!deleteTarget || deleteConfirmation!=='DELETE' || busy) return;
    const account=deleteTarget;
    setBusy(`delete:${account.workspaceId}`);setError('');setMessage('');
    try {
      const response=await accountFetch(`/api/admin/accounts/${account.workspaceId}`,{
        method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:deleteConfirmation}),
      });
      const body=await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to delete account.');
      setDeleteTarget(undefined);setDeleteConfirmation('');
      if (body.reloadSession) { window.location.assign('/admin/members');return; }
      setMessage(`${account.name} was permanently deleted. ${body.deletedUsers} users removed; ${body.retainedUsers} users retained because they belong to other accounts.`);
      setRevision(value=>value+1);
    } catch(reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete account.'); }
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
    <LoadingModal open={Boolean(startingViewAs)} label='Opening account workspace' />
    <p className='eyebrow'>Platform administration</p><h1>Account members</h1>
    <p className='intro'>Each card shows an account’s configured website and members. Disabling a member ends their sessions and blocks new sign-ins.</p>
    <form className='account-actions' onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(search); setAfter(''); setRevision((value) => value + 1); }}>
      <label>Name or email<TextField variant="outlined" size="small" value={search} slotProps={{ htmlInput: { maxLength: 200 } }} onChange={(event) => setSearch(event.target.value)} /></label>
      <Button type="submit" disabled={loading}>Search</Button>
    </form>
    {error && !deleteTarget && <p className='notice error' role='alert'>{error}</p>}
    {message && <p className='notice' role='status'>{message}</p>}
    {loading && <p role='status'>Loading members…</p>}
    {page && !loading && <>
      <div className='account-member-cards'>{page.accounts.map(account => <section className='panel account-member-card' key={account.workspaceId}>
        <header className='account-member-card-header'>
          <h2>{account.websites.length ? account.websites.map((website,index) => <span key={website.url}>{index > 0 && ' · '}<a href={website.url} target='_blank' rel='noreferrer'>{website.url.replace(/^https?:\/\//,'').replace(/\/$/,'')}</a></span>) : account.name}</h2>
          {!account.websites.length && <p className='field-help'>Website not configured</p>}
          <Button className='account-member-delete' color='error' disabled={Boolean(busy) || Boolean(startingViewAs)} onClick={()=>{setDeleteTarget(account);setDeleteConfirmation('');setError('');}}>Delete Account</Button>
        </header>
        <table className='account-member-table'>
          <caption className='visually-hidden'>Members of {account.websites[0]?.url || account.name}</caption>
          <colgroup><col /><col className='member-role-column' /><col className='member-status-column' /><col className='member-action-column' /><col className='member-action-column' /></colgroup>
          <thead><tr><th scope='col'>Email</th><th scope='col'>Role</th><th scope='col'>Status</th><th scope='col'><span className='visually-hidden'>View account</span></th><th scope='col'><span className='visually-hidden'>Change access</span></th></tr></thead>
          <tbody>{account.members.map(member => <AccountMemberRow key={member.id} member={member} workspaceId={account.workspaceId} onViewAs={startViewAs} onToggleAccess={toggleAccess} busy={busy} startingViewAs={startingViewAs} />)}</tbody>
        </table>
      </section>)}</div>
      {page.accounts.length === 0 && <p>No accounts found.</p>}
      <div className='account-actions'>{after && <Button onClick={() => setAfter('')}>First page</Button>}{page.nextCursor && <Button onClick={() => setAfter(page.nextCursor!)}>Next accounts</Button>}</div>
    </>}
    <Dialog open={Boolean(deleteTarget)} onClose={()=>{if(!busy){setDeleteTarget(undefined);setDeleteConfirmation('');setError('');}}} aria-labelledby='delete-account-title' aria-describedby='delete-account-description'>
      <DialogTitle id='delete-account-title'>Permanently delete account?</DialogTitle>
      <DialogContent>
        <p><strong>{deleteTarget?.name}</strong>{deleteTarget?.websites.map(site=><span key={site.url}> · {site.url}</span>)}</p>
        <p id='delete-account-description'>This is destructive and cannot be undone. All account information, website connections, saved credentials, invitations, tokens, history, and queued jobs will be permanently deleted. The website will be available to connect to another account.</p>
        <p>Users who do not belong to other accounts will also be deleted and signed out. Users with other accounts will retain those accounts.</p>
        <p>Connected Stripe billing will be removed and subscriptions canceled. Published WordPress posts will remain on the website.</p>
        <TextField autoFocus fullWidth margin='normal' label='Type DELETE to confirm' value={deleteConfirmation} disabled={Boolean(busy)} onChange={event=>setDeleteConfirmation(event.target.value)} slotProps={{htmlInput:{autoComplete:'off'}}}/>
        {error && <p className='notice error' role='alert'>{error}</p>}
      </DialogContent>
      <DialogActions>
        <Button disabled={Boolean(busy)} onClick={()=>{setDeleteTarget(undefined);setDeleteConfirmation('');setError('');}}>Cancel</Button>
        <Button color='error' variant='contained' disabled={Boolean(busy) || deleteConfirmation!=='DELETE'} onClick={()=>void deleteAccount()}>{busy ? 'Deleting…' : 'Permanently Delete Account'}</Button>
      </DialogActions>
    </Dialog>
  </main>;
}

function AccountMemberRow({ member, workspaceId, onViewAs, onToggleAccess, busy, startingViewAs }: {
  member: Member;
  workspaceId: string;
  onViewAs: (memberId: string, workspaceId: string) => Promise<void>;
  onToggleAccess: (member: Member) => Promise<void>;
  busy: string;
  startingViewAs: string;
}) {
  const protectedMember = member.isPlatformAdmin && !member.disabled;
  const role = member.isPlatformAdmin ? 'Super admin' : member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member';
  return <tr>
    <td data-label='Email' className='member-email'>{member.email}</td>
    <td data-label='Role'>{role}</td>
    <td data-label='Status'><Chip size='small' label={member.disabled ? 'Inactive' : 'Active'} color={member.disabled ? 'default' : 'success'} variant={member.disabled ? 'outlined' : 'filled'} /></td>
    <td><Button disabled={member.disabled || Boolean(startingViewAs) || Boolean(busy)} aria-label={`View as ${member.email}`} onClick={() => void onViewAs(member.id, workspaceId)}>{startingViewAs === member.id ? 'Opening…' : 'View as'}</Button></td>
    <td><Button disabled={Boolean(busy) || Boolean(startingViewAs) || protectedMember} title={protectedMember ? 'Superadmins cannot be disabled here' : undefined} aria-label={`${member.disabled ? 'Enable' : 'Disable'} ${member.email}`} onClick={() => void onToggleAccess(member)}>{busy === member.id ? 'Updating…' : member.disabled ? 'Enable' : 'Disable'}</Button></td>
  </tr>;
}
