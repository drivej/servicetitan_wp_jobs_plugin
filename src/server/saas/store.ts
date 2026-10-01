import { randomUUID } from 'node:crypto';
import type { Database, Sql } from './database.js';
import { hashToken, randomToken, type SecretVault } from './crypto.js';
import { HttpError, type ConnectionInput, type WebsiteInput } from './validation.js';

export interface Identity { subject: string; email: string; name: string; avatarUrl?: string; }
export interface User { id: string; email: string; name: string; avatarUrl: string | null; jobTokens: number; }
export interface Connection { id: string; name: string; environment: 'integration' | 'production'; tenantId: string; version: number; }
export interface Website { id: string; name: string; url: string; connectionId: string; restBase: string; zipAcfField: string; wordpressConfigured: boolean; version: number; }
export interface WebsiteContext {
  website: Website;
  connection: Connection & Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>;
  wordpress?: NonNullable<WebsiteInput['wordpress']>;
}
const userFrom = (row: Record<string, unknown>): User => ({ id: String(row.id), email: String(row.email), name: String(row.name), avatarUrl: row.avatar_url ? String(row.avatar_url) : null, jobTokens: Number(row.job_tokens) });
const connectionFrom = (row: Record<string, unknown>): Connection => ({ id: String(row.id), name: String(row.name), environment: row.environment as Connection['environment'], tenantId: String(row.tenant_id), version: Number(row.version) });
const websiteFrom = (row: Record<string, unknown>): Website => ({ id: String(row.id), name: String(row.name), url: String(row.url), connectionId: String(row.connection_id), restBase: String(row.rest_base), zipAcfField: String(row.zip_acf_field), wordpressConfigured: Boolean(row.wordpress_credentials), version: Number(row.version) });
const audit = async (sql: Sql, userId: string, action: string, target: string): Promise<void> => {
  await sql.query('INSERT INTO audit_logs(id, user_id, action, target_id) VALUES ($1,$2,$3,$4)', [randomUUID(), userId, action, target]);
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
      if (previousToken) await sql.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(previousToken)]);
      await sql.query('DELETE FROM sessions WHERE expires_at <= now()');
      const token = randomToken();
      await sql.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [hashToken(token), row.id]);
      await sql.query("SELECT set_config('app.user_id',$1,true)", [row.id]);
      await audit(sql, String(row.id), 'account.login', String(row.id));
      return { user: userFrom(row), token };
    });
  }
  async session(token: string): Promise<User | undefined> {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return undefined;
    return this.db.transaction(undefined, async (sql) => {
      const row = (await sql.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`, [hashToken(token)])).rows[0];
      return row ? userFrom(row) : undefined;
    });
  }
  async logout(userId: string, token: string): Promise<void> {
    await this.db.transaction(userId, async (sql) => {
      await sql.query('DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2', [hashToken(token), userId]);
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
  async listConnections(userId: string): Promise<Connection[]> {
    return this.db.transaction(userId, async (sql) => (await sql.query('SELECT * FROM servicetitan_connections WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows.map(connectionFrom));
  }
  async saveConnection(userId: string, input: ConnectionInput, id: string = randomUUID(), update = false): Promise<Connection> {
    return this.db.transaction(userId, async (sql) => {
      if (update) {
        const row = (await sql.query('SELECT * FROM servicetitan_connections WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id])).rows[0];
        if (!row) throw new HttpError('Connection not found.', 404);
        if (row.tenant_id !== input.tenantId || row.environment !== input.environment) throw new HttpError('Create a new connection to change tenant or environment.');
      }
      const encrypted = this.vault.encrypt({ clientId: input.clientId, clientSecret: input.clientSecret, appKey: input.appKey }, `connection:${userId}:${id}`);
      const result = update
        ? await sql.query('UPDATE servicetitan_connections SET name=$3,credentials=$4,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *', [userId, id, input.name, encrypted])
        : await sql.query('INSERT INTO servicetitan_connections(id,user_id,name,environment,tenant_id,credentials) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, userId, input.name, input.environment, input.tenantId, encrypted]);
      await audit(sql, userId, update ? 'connection.updated' : 'connection.created', id);
      return connectionFrom(result.rows[0]!);
    });
  }
  async listWebsites(userId: string): Promise<Website[]> {
    return this.db.transaction(userId, async (sql) => (await sql.query('SELECT * FROM websites WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows.map(websiteFrom));
  }
  async saveWebsite(userId: string, input: WebsiteInput, id: string = randomUUID(), update = false): Promise<Website> {
    return this.db.transaction(userId, async (sql) => {
      let previous: Record<string, unknown> | undefined;
      if (update) {
        previous = (await sql.query('SELECT * FROM websites WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id])).rows[0];
        if (!previous) throw new HttpError('Website not found.', 404);
        if (previous.connection_id !== input.connectionId || previous.url !== input.url) throw new HttpError('Create a new website to change its URL or ServiceTitan connection.');
      }
      const connection = (await sql.query('SELECT id FROM servicetitan_connections WHERE user_id=$1 AND id=$2', [userId, input.connectionId])).rows[0];
      if (!connection) throw new HttpError('Connection not found.', 404);
      const encrypted = input.wordpress ? this.vault.encrypt(input.wordpress, `website:${userId}:${id}`) : previous?.wordpress_credentials || null;
      const row = (update
        ? await sql.query('UPDATE websites SET name=$3,wordpress_credentials=$4,rest_base=$5,zip_acf_field=$6,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *', [userId, id, input.name, encrypted, input.restBase, input.zipAcfField])
        : await sql.query('INSERT INTO websites(id,user_id,connection_id,name,url,wordpress_credentials,rest_base,zip_acf_field) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [id, userId, input.connectionId, input.name, input.url, encrypted, input.restBase, input.zipAcfField])).rows[0]!;
      await audit(sql, userId, update ? 'website.updated' : 'website.created', id);
      return websiteFrom(row);
    });
  }
  async websiteContext(userId: string, id: string): Promise<WebsiteContext> {
    return this.db.transaction(userId, async (sql) => {
      const site = (await sql.query('SELECT * FROM websites WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
      if (!site) throw new HttpError('Website not found.', 404);
      const connection = (await sql.query('SELECT * FROM servicetitan_connections WHERE user_id=$1 AND id=$2', [userId, site.connection_id])).rows[0];
      if (!connection) throw new HttpError('Connection not found.', 404);
      return {
        website: websiteFrom(site),
        connection: { ...connectionFrom(connection), ...this.vault.decrypt<Pick<ConnectionInput, 'clientId' | 'clientSecret' | 'appKey'>>(String(connection.credentials), `connection:${userId}:${connection.id}`) },
        ...(site.wordpress_credentials ? { wordpress: this.vault.decrypt<NonNullable<WebsiteInput['wordpress']>>(String(site.wordpress_credentials), `website:${userId}:${id}`) } : {}),
      };
    });
  }
  async spendJobToken<T>(userId: string, websiteId: string, action: string, operation: () => Promise<T>): Promise<T> {
    return this.db.transaction(userId, async (sql) => {
      // Serialize across websites, tabs, and server instances. Never trust a client balance.
      const row = (await sql.query('SELECT job_tokens FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [userId])).rows[0];
      if (!row || Number(row.job_tokens) < 1) throw new HttpError('No job tokens available. Add tokens before trying again.', 402);
      const result = await operation();
      await sql.query('UPDATE users SET job_tokens=job_tokens-1 WHERE id=$1', [userId]);
      await audit(sql, userId, `job_token.spent.${action}`, websiteId);
      // The transaction commits before the caller sends the success response.
      return result;
    });
  }
  async recordAction(userId: string, action: string, target: string): Promise<void> {
    await this.db.transaction(userId, (sql) => audit(sql, userId, action, target));
  }
}
