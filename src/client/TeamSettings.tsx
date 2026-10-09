import { TextField } from '@mui/material';
import { MenuItem, Select } from '@mui/material';
import { Button } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { accountFetch } from './api';

export type TeamRole = 'owner' | 'admin' | 'member';
interface Member { id: string; name: string; email: string; role: TeamRole; }
interface Invitation { id: string; email: string; role: TeamRole; expiresAt: string; }
interface Team { members: Member[]; invitations: Invitation[]; }
async function result<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to update the team.');
  return body as T;
}
export function TeamSettings({ role, workspaceId }: { role: TeamRole; workspaceId: string }) {
  const [team, setTeam] = useState<Team>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ url: string; email: string }>();
  const [message, setMessage] = useState('');
  const reload = async () => setTeam(await accountFetch('/api/team').then(result<Team>));
  useEffect(() => { void reload().catch((reason: Error) => setError(reason.message)); }, [workspaceId]);
  const update = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError(''); setMessage(''); setInvite(undefined);
    try {
      await accountFetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(result);
      await reload(); setMessage('Team updated.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update the team.'); }
    finally { setBusy(false); }
  };
  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage(''); setInvite(undefined);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const created = await accountFetch('/api/team/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), role: data.get('role') }) }).then(result<{ url: string; email: string }>);
      setInvite(created); form.reset(); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create invitation.'); }
    finally { setBusy(false); }
  };
  const openInvitationEmail = () => {
    if (!invite) return;
    const email = `mailto:${invite.email}?subject=Join my ServiceTitan Jobs workspace&body=You are invited to join my ServiceTitan Jobs workspace. Sign in with ${invite.email} and accept this invitation within 7 days:\n\n${invite.url}`;
    window.location.href = encodeURI(email);
    setMessage('Your email app should open with the invitation ready to send. If it does not, copy the invitation link and send it in an email.');
  };
  return <section className="panel account-panel team-settings-panel" id="team">
    <h2>Team</h2>
    <p>Everyone on this team can process jobs on all workspace websites and uses the same token balance.</p>
    <p className="field-help">Owners manage tokens and all team roles. Admins manage integrations and invite or remove members. Members process jobs.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {!team && !error && <p role="status">Loading team…</p>}
    <ul className="account-resource-list">{team?.members.map((member) => <li key={member.id}>
      <div><strong>{member.name}</strong><small>{member.email} · {member.role}</small></div>
      {role === 'owner' && member.role !== 'owner' && <Select size="small" variant='outlined' sx={{ width: '100%' }} aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={(event) => void update(`/api/team/members/${member.id}`, 'PATCH', { role: event.target.value })}><MenuItem value="member">Member</MenuItem><MenuItem value="admin">Admin</MenuItem></Select>}
      {member.role !== 'owner' && (role === 'owner' || role === 'admin' && member.role === 'member') && <Button color="error" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.name} (${member.email}) from ${workspaceId ? 'this workspace' : 'the team'}? They will lose access to its shared jobs, websites, and token balance.`)) void update(`/api/team/members/${member.id}`, 'DELETE'); }}>{busy ? 'Updating…' : 'Remove access'}</Button>}
    </li>)}</ul>
    {role !== 'member' && <>
      <form className="account-form" onSubmit={(event) => void createInvite(event)}>
        <h3>Invite a teammate</h3>
        <label>Google account email<TextField variant="outlined" size="small" fullWidth name="email" type="email" required placeholder="teammate@company.com" slotProps={{ htmlInput: { maxLength: 254 } }}/></label>
        <label>Role<Select size="small" variant='outlined' sx={{ width: '100%' }} name="role" aria-label="Role" defaultValue="member"><MenuItem value="member">Member</MenuItem>{role === 'owner' && <MenuItem value="admin">Admin</MenuItem>}</Select></label>
        <p className="field-help">Invitations expire after 7 days and must be accepted using the invited Google email. Creating a new invite for the same email replaces its previous link.</p>
        <Button type="submit" variant="contained" className="primary" disabled={busy}>{busy ? 'Creating invitation…' : 'Create invitation'}</Button>
      </form>
      {invite && <section className="team-invitation-created" aria-labelledby="team-invitation-created-title">
        <p className="eyebrow">Next step · Send the invitation</p>
        <h3 id="team-invitation-created-title">Invitation ready for {invite.email}</h3>
        <p>Creating the invitation does not email your teammate. Send them the invite link so they can join. They must sign in with this Google email address.</p>
        <Button type="button" variant="contained" className="team-invitation-email" onClick={openInvitationEmail}>Open email app</Button>
        <div className="team-invitation-link-row">
          <label htmlFor="team-invitation-link">Or copy and send this invitation link</label>
          <TextField id="team-invitation-link" className="team-invite-link" variant="outlined" size="small" fullWidth slotProps={{ htmlInput: { readOnly: true, 'aria-label': 'Invitation link' } }} value={invite.url} onFocus={(event) => event.target.select()} />
          <Button onClick={() => { void navigator.clipboard.writeText(invite.url).then(() => setMessage('Invitation link copied. Send it to your teammate to complete the invitation.'), () => setError('Select and copy the invitation link above, then send it to your teammate.')); }}>Copy link</Button>
        </div>
        <p className="team-invitation-expiry">This link expires in 7 days. Creating another invitation for the same email replaces this link.</p>
      </section>}
      <h3>Pending invitations</h3>
      {team?.invitations.length === 0 && <p>No pending invitations.</p>}
      <ul className="account-resource-list">{team?.invitations.map((pending) => <li key={pending.id}><div><strong>{pending.email}</strong><small>{pending.role} · Expires {new Date(pending.expiresAt).toLocaleDateString()}</small></div>{(role === 'owner' || pending.role === 'member') && <Button disabled={busy} onClick={() => void update(`/api/team/invitations/${pending.id}`, 'DELETE')}>Revoke</Button>}</li>)}</ul>
    </>}
  </section>;
}
