import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database {
  transaction<T>(userId: string | undefined, action: (sql: Sql) => Promise<T>): Promise<T>;
}
export class PostgresDatabase implements Database {
  constructor(readonly pool: pg.Pool) {}
  async transaction<T>(userId: string | undefined, action: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId || '']);
      await client.query("SELECT set_config('app.workspace_id', '', true)");
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async verifyRuntimeRole(): Promise<void> {
    const result = await this.pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (!result.rows[0] || result.rows[0].rolsuper || result.rows[0].rolbypassrls) {
      throw new Error('DATABASE_URL must use a non-superuser role without BYPASSRLS.');
    }
    await this.pool.query('SELECT w.job_tokens,m.role FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id LIMIT 0');
    await this.pool.query('SELECT workspace_id,amount,balance_after FROM token_transactions LIMIT 0');
    await this.pool.query('SELECT user_id FROM platform_administrators LIMIT 0');
    const queuePermissions = await this.pool.query("SELECT has_table_privilege(current_user,'build_deploy_tasks','SELECT') AND has_table_privilege(current_user,'build_deploy_tasks','INSERT') AND has_table_privilege(current_user,'build_deploy_tasks','UPDATE') AS ready");
    if (!queuePermissions.rows[0]?.ready) throw new Error('Build queue permissions are missing. Run migrations and grant SELECT, INSERT, UPDATE on build_deploy_tasks.');
    const ledgerPermissions = await this.pool.query(`SELECT
      has_table_privilege(current_user,'token_transactions','SELECT') AND
      has_table_privilege(current_user,'token_transactions','INSERT') AND
      has_table_privilege(current_user,'platform_administrators','SELECT') AND (
        (NOT has_table_privilege(current_user,'token_transactions','UPDATE,DELETE,TRUNCATE') AND
         NOT has_table_privilege(current_user,'platform_administrators','INSERT,UPDATE,DELETE,TRUNCATE') AND
         NOT EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('platform_administrators'::regclass,'token_transactions'::regclass) AND pg_has_role(current_user,relowner,'USAGE')))
        OR
        (SELECT count(*)=2 FROM pg_class WHERE oid IN ('platform_administrators'::regclass,'token_transactions'::regclass) AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
      ) AS ready`);
    if (!ledgerPermissions.rows[0]?.ready) throw new Error(
      'DATABASE_URL needs either a non-owner role with append-only token ledger and read-only platform administrator grants, or the owner of both tables. Check PostgreSQL permissions and run migrations first.'
    );
    const ledgerTriggers = await this.pool.query(`SELECT count(*)::integer AS count FROM pg_trigger WHERE
      (tgrelid='token_transactions'::regclass AND tgname IN ('token_ledger_immutable','token_ledger_no_truncate','token_ledger_insert','token_ledger_apply') OR
       tgrelid='workspaces'::regclass AND tgname='token_balance_check') AND tgenabled='O'`);
    if (ledgerTriggers.rows[0]?.count !== 5) throw new Error('Required token ledger integrity triggers are missing. Run migrations first.');
    const tables = await this.pool.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('servicetitan_connections'::regclass, 'websites'::regclass, 'audit_logs'::regclass)");
    if (tables.rows.length !== 3 || tables.rows.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) {
      throw new Error('Required database ownership policies are missing. Run migrations first.');
    }
  }
}

export async function migrate(sql: Sql, directory = resolve('migrations')): Promise<void> {
  // Caller supplies one connection and transaction; concurrent releases serialize here.
  await sql.query('SELECT pg_advisory_xact_lock(817250031)');
  await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
    const source = await readFile(resolve(directory, name), 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const previous = (await sql.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name])).rows[0];
    if (previous) {
      if (previous.checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
      continue;
    }
    await sql.query(source);
    await sql.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
  }
}
