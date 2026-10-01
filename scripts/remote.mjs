import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const action = process.argv[2];
if (!['dev', 'migrate', 'check'].includes(action)) {
  console.error('Usage: node scripts/remote.mjs dev|migrate|check');
  process.exit(1);
}
const profilePath = resolve('.env.remote');
let profile;
try { profile = parse(readFileSync(profilePath)); }
catch { console.error('Create .env.remote from .env.remote.example and configure your remote test database.'); process.exit(1); }
const required = action === 'migrate' ? ['MIGRATION_DATABASE_URL'] : ['DATABASE_URL'];
if (action === 'dev') required.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CREDENTIAL_ENCRYPTION_KEYS', 'CREDENTIAL_ENCRYPTION_ACTIVE_KEY');
for (const key of required) {
  if (!profile[key]?.trim() || profile[key].includes('REPLACE_ME')) {
    console.error(`Configure ${key} in .env.remote.`); process.exit(1);
  }
}
// Use verified TLS for every database credential in this profile.
for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
  if (!profile[key]) continue;
  try {
    const url = new URL(profile[key]);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.get('sslmode') !== 'verify-full') throw new Error();
  } catch { console.error(`${key} must be a PostgreSQL URL with sslmode=verify-full.`); process.exit(1); }
}
const origin = profile.APP_ORIGIN || 'http://localhost:3000';
try {
  const url = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error();
} catch { console.error('APP_ORIGIN in .env.remote must be an HTTP loopback origin.'); process.exit(1); }
const env = { ...process.env, ...profile, APP_MODE: 'saas', APP_ORIGIN: origin, NODE_ENV: 'development', HOST: '127.0.0.1', DOTENV_CONFIG_PATH: profilePath };
// Never pass the migration login to the locally running web server.
if (action !== 'migrate') delete env.MIGRATION_DATABASE_URL;
// Prevent dotenv/config from reloading owner credentials into the web process.
env.DOTENV_CONFIG_PATH = '/dev/null';
const run = (command, args) => {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) { console.error('Unable to start the requested command.'); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
};
if (action === 'dev') run('npm', ['run', 'build:plugin']);
run('npm', ['run', 'build:server']);
run(process.execPath, [`dist/server/${action === 'dev' ? 'index' : action === 'migrate' ? 'migrate' : 'check-database'}.js`]);
