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
  return <section className="panel account-panel" id="team">
    <h2>Team</h2>
    <p>Everyone on this team can process jobs on all workspace websites and uses the same token balance.</p>
    <p className="field-help">Owners manage tokens and all team roles. Admins manage integrations and invite or remove members. Members process jobs.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {!team && !error && <p role="status">Loading team…</p>}
    <ul className="account-resource-list">{team?.members.map((member) => <li key={member.id}>
      <div><strong>{member.name}</strong><small>{member.email} · {member.role}</small></div>
      {role === 'owner' && member.role !== 'owner' && <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={(event) => void update(`/api/team/members/${member.id}`, 'PATCH', { role: event.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select>}
      {member.role !== 'owner' && (role === 'owner' || role === 'admin' && member.role === 'member') && <button disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.email} from this workspace?`)) void update(`/api/team/members/${member.id}`, 'DELETE'); }}>Remove</button>}
    </li>)}</ul>
    {role !== 'member' && <>
      <form className="account-form" onSubmit={(event) => void createInvite(event)}>
        <h3>Invite a teammate</h3>
        <label>Google account email<input name="email" type="email" required maxLength={254} placeholder="teammate@company.com" /></label>
        <label>Role<select name="role" defaultValue="member"><option value="member">Member</option>{role === 'owner' && <option value="admin">Admin</option>}</select></label>
        <p className="field-help">Invitations expire after 7 days and must be accepted using the invited Google email. Creating a new invite for the same email replaces its previous link.</p>
        <button className="primary" disabled={busy}>Create invitation</button>
      </form>
      {invite && <div className="notice" role="status">
        <p>Invitation created for {invite.email}. Share the link below; no email has been sent automatically.</p>
        <label>Invitation link<input className="team-invite-link" readOnly value={invite.url} onFocus={(event) => event.target.select()} /></label>
        <div className="account-actions"><button onClick={() => { void navigator.clipboard.writeText(invite.url).then(() => setMessage('Invitation link copied.'), () => setError('Select and copy the invitation link above.')); }}>Copy link</button>
        <a href={`mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent('Join my ServiceTitan Jobs workspace')}&body=${encodeURIComponent(`You are invited to join my ServiceTitan Jobs workspace. Sign in with ${invite.email} and accept this invitation within 7 days:\n\n${invite.url}`)}`}>Open email invitation</a></div>
      </div>}
      <h3>Pending invitations</h3>
      {team?.invitations.length === 0 && <p>No pending invitations.</p>}
      <ul className="account-resource-list">{team?.invitations.map((pending) => <li key={pending.id}><div><strong>{pending.email}</strong><small>{pending.role} · Expires {new Date(pending.expiresAt).toLocaleDateString()}</small></div>{(role === 'owner' || pending.role === 'member') && <button disabled={busy} onClick={() => void update(`/api/team/invitations/${pending.id}`, 'DELETE')}>Revoke</button>}</li>)}</ul>
    </>}
  </section>;
}
