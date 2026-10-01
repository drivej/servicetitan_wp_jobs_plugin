import 'dotenv/config';
import pg from 'pg';
import { migrate, PostgresDatabase } from './saas/database.js';

const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
try {
  await new PostgresDatabase(pool).transaction(undefined, migrate);
  console.log('Database migrations are current.');
} catch {
  console.error('Migration failed. Check database access and migration integrity. No partial migration was committed.');
  process.exitCode = 1;
} finally { await pool.end(); }
