import { postTokenTransaction } from './token-ledger.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from './database.js';
import { hashToken, randomToken, type SecretVault } from './crypto.js';
import { HttpError, type ConnectionInput, type WebsiteInput } from './validation.js';

export interface Identity { subject: string; email: string; name: string; avatarUrl?: string; }
export type Role = 'owner' | 'admin' | 'member';
const allRoles: Role[] = ['owner','admin','member'];
export interface User { workspaceId: string; workspaceName: string; role: Role; id: string; email: string; name: string; avatarUrl: string | null; jobTokens: number; isPlatformAdmin?: boolean; }
export interface Connection { id: string; name: string; environment: 'integration' | 'production'; tenantId: string; version: number; }
export interface Website { id: string; name: string; url: string; connectionId: string | null; restBase: string; zipAcfField: string; wordpressConfigured: boolean; version: number; }
export interface WebsiteContext {
  workspaceId: string;
  website: Website;
  connection: Connection & Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>;
  wordpress?: NonNullable<WebsiteInput['wordpress']>;
}
const userFrom = (row: Record<string, unknown>): User => ({ id: String(row.id), email: String(row.email), name: String(row.name), avatarUrl: row.avatar_url ? String(row.avatar_url) : null, jobTokens: Number(row.job_tokens), isPlatformAdmin: row.is_platform_admin === true, workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), role: row.role as Role });
const connectionFrom = (row: Record<string, unknown>): Connection => ({ id: String(row.id), name: String(row.name), environment: row.environment as Connection['environment'], tenantId: String(row.tenant_id), version: Number(row.version) });
const websiteFrom = (row: Record<string, unknown>): Website => ({ id: String(row.id), name: String(row.name), url: String(row.url), connectionId: row.connection_id == null ? null : String(row.connection_id), restBase: String(row.rest_base), zipAcfField: String(row.zip_acf_field), wordpressConfigured: Boolean(row.wordpress_credentials), version: Number(row.version) });
const audit = async (sql: Sql, userId: string, action: string, target: string, jobId?: number): Promise<void> => {
  await sql.query("INSERT INTO audit_logs(id, user_id, action, target_id, job_id, workspace_id) VALUES ($1,$2,$3,$4,$5,nullif(current_setting('app.workspace_id',true),'')::uuid)", [randomUUID(), userId, action, target, jobId ?? null]);
};

export class AccountStore {
  constructor(readonly db: Database, private readonly vault: SecretVault) {}
  async login(identity: Identity, previousToken?: string): Promise<{ user: User; token: string }> {
    return this.db.transaction(undefined, async (sql) => {
      const row = (await sql.query(`INSERT INTO users(id, google_subject, email, name, avatar_url)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(google_subject) DO UPDATE
        SET email=excluded.email, name=excluded.name, avatar_url=excluded.avatar_url, updated_at=now(), last_login_at=now()
        WHERE users.disabled_at IS NULL RETURNING *`, [randomUUID(), identity.subject, identity.email, identity.name, identity.avatarUrl || null])).rows[0];
      if (!row) throw new HttpError('This account is disabled.', 403);
      await sql.query('INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$1,$2) ON CONFLICT(owner_user_id) DO NOTHING', [row.id, `${String(row.name).slice(0,180)}'s workspace`]);
      await sql.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$1,'owner') ON CONFLICT DO NOTHING", [row.id]);
      if (previousToken) await sql.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(previousToken)]);
      await sql.query('DELETE FROM sessions WHERE expires_at <= now()');
      const token = randomToken();
      await sql.query("INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$2,now()+interval '7 days')", [hashToken(token), row.id]);
      await sql.query("SELECT set_config('app.user_id',$1,true)", [row.id]);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [row.id]);
      await audit(sql, String(row.id), 'account.login', String(row.id));
      const workspace = (await sql.query('SELECT * FROM workspaces WHERE id=$1', [row.id])).rows[0]!;
      return { user: userFrom({ ...row, job_tokens: workspace.job_tokens, workspace_id: workspace.id, workspace_name: workspace.name, role: 'owner' }), token };
    });
  }
  async session(token: string): Promise<User | undefined> {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return undefined;
    return this.db.transaction(undefined, async (sql) => {
      const row = (await sql.query(`SELECT u.*,w.id AS workspace_id,w.name AS workspace_name,w.job_tokens,m.role,
        EXISTS(SELECT 1 FROM platform_administrators pa WHERE pa.user_id=u.id) AS is_platform_admin
        FROM sessions s JOIN users u ON u.id=s.user_id
        JOIN workspaces w ON w.id=CASE WHEN EXISTS(SELECT 1 FROM workspace_memberships active WHERE active.workspace_id=s.workspace_id AND active.user_id=u.id) THEN s.workspace_id ELSE u.id END
        JOIN users owner ON owner.id=w.owner_user_id
        JOIN workspace_memberships m ON m.workspace_id=w.id AND m.user_id=u.id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [hashToken(token)])).rows[0];
      return row ? userFrom(row) : undefined;
    });
  }
  async logout(userId: string, token: string): Promise<void> {
    await this.db.transaction(userId, async (sql) => {
      await sql.query('DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2', [hashToken(token), userId]);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [userId]);
      await audit(sql, userId, 'account.logout', userId);
    });
  }
  async beginLogin(state: string, browser: string, verifier: string, nonce: string): Promise<void> {
    await this.db.transaction(undefined, async (sql) => {
      await sql.query('DELETE FROM oauth_attempts WHERE expires_at <= now()');
      await sql.query("INSERT INTO oauth_attempts(state_hash,browser_hash,secret,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
        [hashToken(state), hashToken(browser), this.vault.encrypt({ verifier, nonce }, `oauth:${hashToken(state)}`)]);
    });
  }
  async consumeLogin(state: string, browser: string): Promise<{ verifier: string; nonce: string }> {
    return this.db.transaction(undefined, async (sql) => {
      const row = (await sql.query('DELETE FROM oauth_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING secret', [hashToken(state), hashToken(browser)])).rows[0];
      if (!row) throw new HttpError('Sign-in expired or was already used. Please try again.', 400);
      return this.vault.decrypt(String(row.secret), `oauth:${hashToken(state)}`);
    });
  }
  async allowRequest(key: string, maximum: number, seconds: number): Promise<boolean> {
    return this.db.transaction(undefined, async (sql) => {
      await sql.query('DELETE FROM rate_limits WHERE expires_at <= now()');
      const row = (await sql.query(`INSERT INTO rate_limits(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
        ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`, [hashToken(key), seconds])).rows[0]!;
      return Number(row.hits) <= maximum;
    });
  }
  private async workspaceTransaction<T>(userId: string, workspaceId: string, roles: Role[], action: (sql: Sql, role: Role) => Promise<T>): Promise<T> {
    return this.db.transaction(userId, async (sql) => {
      // All workspace mutations and spending use the same lock. Revocation cannot
      // race with an invite acceptance or token spend already in this transaction.
      const workspace = (await sql.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
      const member = (await sql.query(`SELECT m.role FROM workspace_memberships m
        JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
        JOIN users owner ON owner.id=w.owner_user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [workspaceId, userId])).rows[0];
      if (!workspace || !member || !roles.includes(member.role as Role)) throw new HttpError('You do not have permission in this workspace.', 403);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      return action(sql, member.role as Role);
    });
  }
  async listWorkspaces(userId: string) {
    return this.db.transaction(userId, async (sql) => (await sql.query(`SELECT w.id,w.name,m.role FROM workspaces w
      JOIN workspace_memberships m ON m.workspace_id=w.id JOIN users owner ON owner.id=w.owner_user_id
      WHERE m.user_id=$1 AND owner.disabled_at IS NULL ORDER BY w.created_at,w.id`, [userId])).rows);
  }
  async switchWorkspace(userId: string, token: string, workspaceId: string): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      await sql.query('UPDATE sessions SET workspace_id=$3 WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()', [userId, hashToken(token), workspaceId]);
    });
  }
  async team(userId: string, workspaceId: string) {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql, role) => ({
      members: (await sql.query(`SELECT u.id,u.name,u.email,m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at,u.id`, [workspaceId])).rows,
      invitations: role === 'member' ? [] : (await sql.query(`SELECT id,email,role,expires_at AS "expiresAt" FROM workspace_invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`, [workspaceId])).rows,
    }));
  }
  async invite(userId: string, workspaceId: string, email: string, role: 'admin' | 'member') {
    email = email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Enter a valid email address.');
    if (!['admin','member'].includes(role)) throw new HttpError('Choose Admin or Member.');
    return this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql, actorRole) => {
      if (actorRole !== 'owner' && role !== 'member') throw new HttpError('Only the owner can invite admins.', 403);
      const existing = (await sql.query(`SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND lower(u.email)=$2`, [workspaceId, email])).rows[0];
      if (existing) throw new HttpError('That person is already on this team.', 409);
      const pending = (await sql.query(`SELECT role FROM workspace_invitations WHERE workspace_id=$1 AND email=$2 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now()`, [workspaceId, email])).rows;
      if (actorRole !== 'owner' && pending.some((item) => item.role === 'admin')) throw new HttpError('Only the owner can replace an admin invitation.', 403);
      await sql.query('UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [workspaceId, email]);
      const id = randomUUID(), token = randomToken();
      await sql.query(`INSERT INTO workspace_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days')`, [id, workspaceId, email, role, hashToken(token), userId]);
      await audit(sql, userId, 'team.invited', id);
      return { id, token, email, role };
    });
  }
  async revokeInvitation(userId: string, workspaceId: string, id: string): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql, role) => {
      const invite = (await sql.query('SELECT role FROM workspace_invitations WHERE workspace_id=$1 AND id=$2', [workspaceId,id])).rows[0];
      if (!invite) throw new HttpError('Invitation not found.',404);
      if (role !== 'owner' && invite.role !== 'member') throw new HttpError('Only the owner can revoke an admin invitation.',403);
      await sql.query('UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NULL', [workspaceId,id]);
      await audit(sql,userId,'team.invitation_revoked',id);
    });
  }
  async changeMember(userId: string, workspaceId: string, targetId: string, newRole?: 'admin' | 'member'): Promise<void> {
    if (newRole !== undefined && !['admin','member'].includes(newRole)) throw new HttpError('Choose Admin or Member.');
    await this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql, role) => {
      const target = (await sql.query('SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId,targetId])).rows[0];
      if (!target) throw new HttpError('Member not found.',404);
      if (target.role === 'owner') throw new HttpError('The workspace owner cannot be removed or demoted.',403);
      if (role !== 'owner' && (newRole !== undefined || target.role !== 'member')) throw new HttpError('Only the owner can manage admin roles.',403);
      if (newRole) await sql.query('UPDATE workspace_memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspaceId,targetId,newRole]);
      else {
        await sql.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId,targetId]);
        // Revoke outstanding invitations to this address so removal cannot be undone with an old link.
        await sql.query(`UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=(SELECT lower(email) FROM users WHERE id=$2) AND accepted_at IS NULL`, [workspaceId,targetId]);
      }
      if (!newRole || newRole === 'member') await sql.query('UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=$1 AND invited_by=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [workspaceId,targetId]);
      await audit(sql,userId,newRole ? 'team.role_changed' : 'team.removed',targetId);
    });
  }
  async invitationDetails(userId: string, token: string) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new HttpError('Invitation is invalid or expired.',404);
    return this.db.transaction(userId, async (sql) => {
      const invite = (await sql.query(`SELECT w.name AS "workspaceName",i.role,i.email FROM workspace_invitations i
        JOIN workspaces w ON w.id=i.workspace_id JOIN users owner ON owner.id=w.owner_user_id
        JOIN users u ON u.id=$2 AND lower(u.email)=i.email AND u.disabled_at IS NULL
        WHERE i.token_hash=$1 AND i.expires_at>now() AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND owner.disabled_at IS NULL`, [hashToken(token),userId])).rows[0];
      if (!invite) throw new HttpError('This invitation is expired, revoked, or for a different Google email. Sign in with the invited email or ask for a new link.',404);
      return invite;
    });
  }
  async acceptInvitation(userId: string, sessionToken: string, token: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new HttpError('Invitation is invalid or expired.',404);
    await this.db.transaction(userId, async (sql) => {
      const candidate = (await sql.query('SELECT workspace_id FROM workspace_invitations WHERE token_hash=$1', [hashToken(token)])).rows[0];
      if (!candidate) throw new HttpError('Invitation is invalid or expired.',404);
      const workspaceId = String(candidate.workspace_id);
      await sql.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const invite = (await sql.query(`SELECT i.* FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id JOIN users owner ON owner.id=w.owner_user_id
        WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND owner.disabled_at IS NULL`, [hashToken(token)])).rows[0];
      if (!invite) throw new HttpError('Invitation is invalid or expired.',404);
      const user = (await sql.query('SELECT email FROM users WHERE id=$1 AND disabled_at IS NULL', [userId])).rows[0];
      if (!user || String(user.email).toLowerCase() !== invite.email) throw new HttpError('Sign in with the Google email address this invitation was sent to.',403);
      await sql.query(`INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO NOTHING`, [workspaceId,userId,invite.role]);
      await sql.query('UPDATE workspace_invitations SET accepted_at=now() WHERE id=$1', [invite.id]);
      await sql.query('UPDATE sessions SET workspace_id=$3 WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()', [userId,hashToken(sessionToken),workspaceId]);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      await audit(sql,userId,'team.invitation_accepted',String(invite.id));
    });
  }
  async listConnections(userId: string, workspaceId = userId): Promise<Connection[]> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => (await sql.query('SELECT * FROM servicetitan_connections WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows.map(connectionFrom));
  }
  async saveConnection(userId: string, input: ConnectionInput, id: string = randomUUID(), update = false, workspaceId = userId): Promise<Connection> {
    return this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql) => {
      let saved: Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'> | undefined;
      if (update) {
        const row = (await sql.query('SELECT * FROM servicetitan_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, id])).rows[0];
        if (!row) throw new HttpError('Connection not found.', 404);
        if (row.tenant_id !== input.tenantId) throw new HttpError('Create a new connection to change tenant.');
        if (row.environment !== input.environment && (!input.clientId || !input.clientSecret || !input.appKey)) throw new HttpError('Enter the Client ID, client secret, and app key for the new environment.');
        saved = this.vault.decrypt(String(row.credentials), `connection:${workspaceId}:${id}`);
      }
      const credentials = { clientId: input.clientId || saved?.clientId, clientSecret: input.clientSecret || saved?.clientSecret, appKey: input.appKey || saved?.appKey };
      if (!credentials.clientId || !credentials.clientSecret || !credentials.appKey) throw new HttpError('ServiceTitan credentials are required.');
      const encrypted = this.vault.encrypt(credentials, `connection:${workspaceId}:${id}`);
      const result = update
        ? await sql.query('UPDATE servicetitan_connections SET name=$3,credentials=$4,environment=$5,validated_at=NULL,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId, id, input.name, encrypted, input.environment])
        : await sql.query('INSERT INTO servicetitan_connections(id,workspace_id,name,environment,tenant_id,credentials) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, workspaceId, input.name, input.environment, input.tenantId, encrypted]);
      await audit(sql, userId, update ? 'connection.updated' : 'connection.created', id);
      return connectionFrom(result.rows[0]!);
    });
  }
  async listWebsites(userId: string, workspaceId = userId): Promise<Website[]> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => (await sql.query('SELECT * FROM websites WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows.map(websiteFrom));
  }
  async saveWebsite(userId: string, input: WebsiteInput, id: string = randomUUID(), update = false, workspaceId = userId): Promise<Website> {
    return this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql) => {
      let previous: Record<string, unknown> | undefined;
      if (update) {
        previous = (await sql.query('SELECT * FROM websites WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, id])).rows[0];
        if (!previous) throw new HttpError('Website not found.', 404);
        if (previous.url !== input.url) throw new HttpError('Create a new website to change its URL.');
      }
      if (input.connectionId) {
        const connection = (await sql.query('SELECT id FROM servicetitan_connections WHERE workspace_id=$1 AND id=$2', [workspaceId, input.connectionId])).rows[0];
        if (!connection) throw new HttpError('Connection not found.', 404);
      }
      const encrypted = input.wordpress ? this.vault.encrypt(input.wordpress, `website:${workspaceId}:${id}`) : previous?.wordpress_credentials || null;
      const row = (update
        ? await sql.query('UPDATE websites SET name=$3,connection_id=coalesce($7,connection_id),wordpress_credentials=$4,rest_base=$5,zip_acf_field=$6,validated_at=NULL,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId, id, input.name, encrypted, input.restBase, input.zipAcfField, input.connectionId || null])
        : await sql.query('INSERT INTO websites(id,workspace_id,connection_id,name,url,wordpress_credentials,rest_base,zip_acf_field) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [id, workspaceId, input.connectionId || null, input.name, input.url, encrypted, input.restBase, input.zipAcfField])).rows[0]!;
      await audit(sql, userId, update ? 'website.updated' : 'website.created', id);
      return websiteFrom(row);
    });
  }
  async websiteContext(userId: string, id: string, workspaceId = userId): Promise<WebsiteContext> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const site = (await sql.query('SELECT * FROM websites WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0];
      if (!site) throw new HttpError('Website not found.', 404);
      const connection = (await sql.query('SELECT * FROM servicetitan_connections WHERE workspace_id=$1 AND id=$2', [workspaceId, site.connection_id])).rows[0];
      if (!connection) throw new HttpError('Connection not found.', 404);
      return {
        workspaceId,
        website: websiteFrom(site),
        connection: { ...connectionFrom(connection), ...this.vault.decrypt<Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>>(String(connection.credentials), `connection:${workspaceId}:${connection.id}`) },
        ...(site.wordpress_credentials ? { wordpress: this.vault.decrypt<NonNullable<WebsiteInput['wordpress']>>(String(site.wordpress_credentials), `website:${workspaceId}:${id}`) } : {}),
      };
    });
  }
  async connectionContext(userId: string, id: string, workspaceId = userId): Promise<Connection & Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const row = (await sql.query('SELECT * FROM servicetitan_connections WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0];
      if (!row) throw new HttpError('Connection not found.', 404);
      return { ...connectionFrom(row), ...this.vault.decrypt<Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>>(String(row.credentials), `connection:${workspaceId}:${id}`) };
    });
  }
  async websiteWordPressContext(userId: string, id: string, workspaceId = userId): Promise<{ website: Website; wordpress?: NonNullable<WebsiteContext['wordpress']> }> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const row = (await sql.query('SELECT * FROM websites WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0];
      if (!row) throw new HttpError('Website not found.', 404);
      return {
        website: websiteFrom(row),
        ...(row.wordpress_credentials ? { wordpress: this.vault.decrypt<NonNullable<WebsiteContext['wordpress']>>(String(row.wordpress_credentials), `website:${workspaceId}:${id}`) } : {}),
      };
    });
  }
  async onboardingFlags(userId: string, workspaceId = userId): Promise<{ pluginReady: boolean; websiteReady: boolean; serviceTitanReady: boolean }> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const row = (await sql.query(`SELECT
        EXISTS(SELECT 1 FROM websites WHERE workspace_id=$1 AND plugin_validated_at IS NOT NULL) AS plugin_ready,
        EXISTS(SELECT 1 FROM websites WHERE workspace_id=$1 AND wordpress_credentials IS NOT NULL AND validated_at IS NOT NULL) AS website_ready,
        EXISTS(SELECT 1 FROM servicetitan_connections c WHERE c.workspace_id=$1 AND c.validated_at IS NOT NULL AND EXISTS(SELECT 1 FROM websites w WHERE w.workspace_id=$1 AND w.connection_id=c.id AND w.validated_at IS NOT NULL)) AS st_ready`, [workspaceId])).rows[0]!;
      return { pluginReady: row.plugin_ready === true, websiteReady: row.website_ready === true, serviceTitanReady: row.st_ready === true };
    });
  }
  async markWebsiteValidated(userId: string, id: string, workspaceId = userId): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const result = await sql.query('UPDATE websites SET validated_at=now() WHERE workspace_id=$1 AND id=$2 AND wordpress_credentials IS NOT NULL RETURNING id', [workspaceId, id]);
      if (result.rows.length !== 1) throw new HttpError('Website credentials are missing.', 400);
    });
  }
  async markPluginValidated(userId: string, id: string, workspaceId = userId): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const result = await sql.query('UPDATE websites SET plugin_validated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id]);
      if (result.rows.length !== 1) throw new HttpError('Website not found.', 404);
    });
  }
  async attachConnection(userId: string, websiteId: string, connectionId: string, workspaceId = userId): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, ['owner','admin'], async (sql) => {
      const result = await sql.query('UPDATE websites SET connection_id=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, websiteId, connectionId]);
      if (result.rows.length !== 1) throw new HttpError('Website not found.', 404);
    });
  }
  async markConnectionValidated(userId: string, id: string, workspaceId = userId): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const result = await sql.query('UPDATE servicetitan_connections SET validated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id]);
      if (result.rows.length !== 1) throw new HttpError('Connection not found.', 404);
    });
  }
  async addTestJobToken(userId: string, amount = 1, workspaceId = userId): Promise<number> {
    return this.workspaceTransaction(userId, workspaceId, ['owner'], async (sql) => {
      const entry = await postTokenTransaction(sql, { workspaceId, kind: 'test_credit', requestedAmount: amount, actorUserId: userId,
        reference: `test:${randomUUID()}`, reason: `Manual test credit: ${amount} token${amount === 1 ? '' : 's'}` });
      await audit(sql, userId, 'job_token.credited.test', userId);
      return entry.balanceAfter;
    });
  }
  async spendJobToken<T>(userId: string, websiteId: string, action: string, operation: () => Promise<T>, workspaceId = userId, jobId?: number): Promise<T> {
    return this.workspaceTransaction(userId, workspaceId, allRoles, async (sql) => {
      const site = (await sql.query('SELECT id FROM websites WHERE workspace_id=$1 AND id=$2', [workspaceId,websiteId])).rows[0];
      if (!site) throw new HttpError('Website not found.',404);
      // Serialize across websites, tabs, and server instances. Never trust a client balance.
      const row = (await sql.query('SELECT job_tokens FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
      if (!row || Number(row.job_tokens) < 1) throw new HttpError('No job tokens available. Add tokens before trying again.', 402);
      const result = await operation();
      await postTokenTransaction(sql, { workspaceId, kind: 'spend', requestedAmount: -1, actorUserId: userId, websiteId,
        ...(jobId === undefined ? {} : { jobId }), reference: `spend:${randomUUID()}`, reason: action });
      await audit(sql, userId, `job_token.spent.${action}`, websiteId, jobId);
      // The transaction commits before the caller sends the success response.
      return result;
    });
  }
  async recordAction(userId: string, action: string, target: string, workspaceId = userId, jobId?: number): Promise<void> {
    await this.workspaceTransaction(userId, workspaceId, allRoles, (sql) => audit(sql, userId, action, target, jobId));
  }
}
