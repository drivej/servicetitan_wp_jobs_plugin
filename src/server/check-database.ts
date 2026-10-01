import 'dotenv/config';
import pg from 'pg';
import { PostgresDatabase } from './saas/database.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
try {
  if (!process.env.DATABASE_URL) throw new Error('missing connection');
  await new PostgresDatabase(pool).verifyRuntimeRole();
  await pool.query('SELECT job_tokens FROM users LIMIT 0');
  const permissions = await pool.query(`SELECT bool_and(
    has_table_privilege(current_user, name, 'SELECT') AND
    has_table_privilege(current_user, name, 'INSERT') AND
    has_table_privilege(current_user, name, 'UPDATE') AND
    has_table_privilege(current_user, name, 'DELETE')) AS ready
    FROM unnest(ARRAY['users','sessions','oauth_attempts','rate_limits','servicetitan_connections','websites','audit_logs']) AS name`);
  if (!permissions.rows[0]?.ready) throw new Error('missing runtime grants');
  console.log('Remote database is reachable; runtime role, ownership policies, job tokens, and table permissions are ready.');
} catch {
  console.error('Database check failed. Verify the remote URL, TLS certificate, runtime role, migrations, and table grants.');
  process.exitCode = 1;
} finally { await pool.end(); }
