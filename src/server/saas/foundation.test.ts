import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import express from 'express';
import { AccountStore } from './store.js';
import { csrfToken, hashToken, randomToken, SecretVault } from './crypto.js';
import { applicationMode, loadSaaSConfig, type SaaSConfig } from './config.js';
import { migrate, type Database, type Sql } from './database.js';
import { createSaaSApp } from './app.js';
import { connectionInput, publicAddress, websiteInput, websiteUrl } from './validation.js';
import { minimizeJobDetails } from './providers.js';
import { buildJobCopyFacts } from '../../shared/job-copy.js';

const key = randomBytes(32).toString('base64');
const vault = new SecretVault({ test: key }, 'test');
const source = { name: 'Plumbing', environment: 'integration' as const, tenantId: '1234', clientId: 'client', clientSecret: 'secret-never-return', appKey: 'key-never-return' };
const siteInput = (connectionId: string) => ({ name: 'Main site', connectionId, url: 'https://example.com', restBase: 'st-jobs', zipAcfField: 'my_zip_codes', wordpress: { username: 'publisher', applicationPassword: 'wp-never-return' } });

// Run the same SQL/ownership cases against embedded PostgreSQL locally and a real
// server when TEST_DATABASE_URL is supplied (CI). Each run owns its isolated schema/role.
async function fixture(beforeWorkspaceMigration?: (sql: Sql) => Promise<void>) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const role = `${schema}_runtime`;
  const pool = process.env.TEST_DATABASE_URL ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }) : undefined;
  const embedded = pool ? undefined : new PGlite();
  const sql: Sql = pool || {
    async query<T extends Record<string, unknown>>(query: string, values?: unknown[]) {
      const result = values ? await embedded!.query<T>(query, values) : (await embedded!.exec(query)).at(-1);
      return { rows: (result?.rows || []) as T[] };
    },
  };
  await sql.query(`CREATE SCHEMA ${schema}; CREATE ROLE ${role} NOLOGIN; SET search_path TO ${schema};`);
  await sql.query('BEGIN');
  if (beforeWorkspaceMigration) {
    const directory = await mkdtemp(join(tmpdir(), 'st-old-migrations-'));
    try {
      for (const name of ['001_accounts.sql','002_job_tokens.sql']) await writeFile(join(directory,name),await readFile(join('migrations',name),'utf8'));
      await migrate(sql,directory);
      await beforeWorkspaceMigration(sql);
    } finally { await rm(directory,{ recursive: true, force: true }); }
  }
  await migrate(sql);
  await sql.query('COMMIT');
  await sql.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  let tail = Promise.resolve();
  const db: Database = {
    async transaction<T>(userId: string | undefined, action: (sql: Sql) => Promise<T>) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((done) => { release = done; });
      await previous;
      try {
        await sql.query(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL search_path TO ${schema};`);
        await sql.query("SELECT set_config('app.user_id',$1,true)", [userId || '']);
        await sql.query("SELECT set_config('app.workspace_id',$1,true)", [userId || '']);
        const value = await action(sql);
        await sql.query('COMMIT');
        return value;
      } catch (error) { await sql.query('ROLLBACK'); throw error; }
      finally { release(); }
    },
  };
  return { db, sql, store: new AccountStore(db, vault), async close() {
    if (pool) {
      await sql.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${role}`);
      await pool.end();
    } else await embedded!.close();
  } };
}

test('credential encryption authenticates owner/context and supports key rotation', () => {
  const envelope = vault.encrypt({ secret: 'private' }, 'owner:one');
  assert(!envelope.includes('private'));
  assert.deepEqual(vault.decrypt(envelope, 'owner:one'), { secret: 'private' });
  assert.throws(() => vault.decrypt(envelope, 'owner:two'));
  const tampered = JSON.parse(envelope); tampered.data = Buffer.from('tampered').toString('base64');
  assert.throws(() => vault.decrypt(JSON.stringify(tampered), 'owner:one'));
  const rotated = new SecretVault({ test: key, next: randomBytes(32).toString('base64') }, 'next');
  assert.deepEqual(rotated.decrypt(envelope, 'owner:one'), { secret: 'private' });
  assert.equal(JSON.parse(rotated.encrypt({}, 'owner:one')).key, 'next');
});

test('hosted configuration fails closed and rejects private network website URLs', () => {
  assert.equal(applicationMode({ NODE_ENV: 'production' }), 'saas');
  assert.throws(() => applicationMode({ NODE_ENV: 'production', APP_MODE: 'local' }));
  assert.throws(() => loadSaaSConfig({ NODE_ENV: 'production' }), /APP_ORIGIN/);
  for (const value of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254', 'https://2130706433', 'https://10.0.0.1', 'https://example.com:3000', 'https://user:pass@example.com']) assert.throws(() => websiteUrl(value));
  for (const address of ['127.0.0.2', '10.0.1.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '169.254.169.254', '100.64.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(websiteUrl('https://example.com/blog/'), 'https://example.com/blog');
  assert.throws(() => connectionInput({ ...source, userId: randomUUID() }), /Unexpected/);
  assert.throws(() => websiteInput({ ...siteInput(randomUUID()), wordpress: { username: 'admin:fake', applicationPassword: 'test' } }));
});

test('SaaS removes raw provider data and the structured street address before generation', () => {
  const details = minimizeJobDetails({
    job: { id: 1, jobNumber: '100', locationId: 2, jobTypeId: 3, jobStatus: 'Completed', customerName: 'Private Person', summary: 'Private raw data' },
    summary: { id: 1, jobNumber: '100', jobName: 'Drain clearing', status: 'Completed', location: { address: '123 Private Street, Unit 4', city: 'Los Angeles', state: 'CA', zip: '90001' } },
    attachments: [], history: [],
  });
  assert.equal(details.job.customerName, undefined);
  assert.equal(details.job.summary, undefined);
  assert.equal(details.summary.location.address, undefined);
  assert(!buildJobCopyFacts(details.summary).includes('Private Street'));
  assert(buildJobCopyFacts(details.summary).includes('Los Angeles'));
});

test('PostgreSQL account isolation, sessions, OAuth replay and protected HTTP workflow', async (t) => {
  const f = await fixture();
  try {
    await t.test('migrations are repeatable without recreating or overwriting tables', async () => {
      await f.sql.query('BEGIN'); await migrate(f.sql); await f.sql.query('COMMIT');
      assert.equal((await f.sql.query('SELECT * FROM schema_migrations')).rows.length, 3);
    });
    const alice = await f.store.login({ subject: 'google-alice', email: 'same@example.com', name: 'Alice' });
    const bob = await f.store.login({ subject: 'google-bob', email: 'same@example.com', name: 'Bob' });
    const connection = await f.store.saveConnection(alice.user.id, source);
    const site = await f.store.saveWebsite(alice.user.id, siteInput(connection.id));

    await t.test('uses Google subject, stores only session hashes and rotates sessions', async () => {
      assert.notEqual(alice.user.id, bob.user.id);
      const again = await f.store.login({ subject: 'google-alice', email: 'changed@example.com', name: 'Alice' });
      assert.equal(again.user.id, alice.user.id);
      const rows = (await f.sql.query('SELECT token_hash FROM sessions')).rows;
      assert(rows.some((row) => row.token_hash === hashToken(alice.token)));
      assert(!JSON.stringify(rows).includes(alice.token));
      await f.store.login({ subject: 'google-alice', email: 'changed@example.com', name: 'Alice' }, again.token);
      assert.equal(await f.store.session(again.token), undefined);
      await f.store.logout(bob.user.id, bob.token);
      assert.equal(await f.store.session(bob.token), undefined);
    });
    await t.test('RLS, composite foreign keys, and ownership queries reject another user', async () => {
      assert.deepEqual(await f.store.listConnections(bob.user.id), []);
      assert.deepEqual(await f.store.listWebsites(bob.user.id), []);
      await assert.rejects(f.store.websiteContext(bob.user.id, site.id), /not found/);
      await assert.rejects(f.store.saveConnection(bob.user.id, source, connection.id, true), /not found/);
      await assert.rejects(f.store.saveWebsite(bob.user.id, siteInput(connection.id)), /not found/);
      assert.deepEqual(await f.db.transaction(bob.user.id, async (sql) => (await sql.query('SELECT * FROM websites')).rows), []);
      assert.deepEqual(await f.db.transaction(undefined, async (sql) => (await sql.query('SELECT * FROM websites')).rows), []);
      await assert.rejects(f.db.transaction(bob.user.id, (sql) => sql.query("INSERT INTO websites(id,workspace_id,connection_id,name,url) VALUES($1,$2,$3,'bad','https://bad.example.com')", [randomUUID(), alice.user.id, connection.id])), /row-level security/);
      await assert.rejects(f.db.transaction(bob.user.id, (sql) => sql.query("INSERT INTO websites(id,workspace_id,connection_id,name,url) VALUES($1,$2,$3,'bad','https://bad.example.com')", [randomUUID(), bob.user.id, connection.id])), /foreign key/);
    });
    await t.test('credentials stay encrypted and are omitted from account responses', async () => {
      const raw = JSON.stringify((await f.sql.query('SELECT credentials FROM servicetitan_connections')).rows);
      assert(!raw.includes(source.clientSecret));
      const listing = JSON.stringify([await f.store.listConnections(alice.user.id), await f.store.listWebsites(alice.user.id)]);
      for (const secret of [source.clientId, source.clientSecret, source.appKey, 'wp-never-return']) assert(!listing.includes(secret));
      const context = await f.store.websiteContext(alice.user.id, site.id);
      assert.equal(context.connection.clientSecret, source.clientSecret);
      assert.equal(context.wordpress?.applicationPassword, 'wp-never-return');
      await f.store.saveConnection(alice.user.id, { ...source, clientSecret: 'rotated' }, connection.id, true);
      assert.equal((await f.store.websiteContext(alice.user.id, site.id)).connection.clientSecret, 'rotated');
      const unchanged = connectionInput({ ...source, clientId: '', clientSecret: '', appKey: '' }, true);
      await f.store.saveConnection(alice.user.id, unchanged, connection.id, true);
      assert.equal((await f.store.websiteContext(alice.user.id, site.id)).connection.clientSecret, 'rotated');
      await assert.rejects(f.store.saveConnection(alice.user.id, { ...unchanged, environment: 'production' }, connection.id, true), /new environment/);
      assert.equal((await f.store.websiteContext(alice.user.id, site.id)).connection.environment, 'integration');
      const switched = await f.store.saveConnection(alice.user.id, { ...source, environment: 'production', clientSecret: 'production-secret' }, connection.id, true);
      assert.equal(switched.environment, 'production');
      assert(switched.version > connection.version);
      assert.equal((await f.store.websiteContext(alice.user.id, site.id)).connection.clientSecret, 'production-secret');
      assert.throws(() => connectionInput({ ...source, clientSecret: '' }), /Client secret/);
      await assert.rejects(f.store.saveConnection(alice.user.id, { ...source, tenantId: '999' }, connection.id, true), /new connection/);
      await assert.rejects(f.store.saveWebsite(alice.user.id, { ...siteInput(connection.id), url: 'https://changed.example.com' }, site.id, true), /new website/);
    });
    await t.test('OAuth attempts are bound to browser, expire and can only be consumed once', async () => {
      const state = randomToken(), browser = randomToken();
      await f.store.beginLogin(state, browser, 'verifier', 'nonce');
      await assert.rejects(f.store.consumeLogin(state, randomToken()));
      assert.deepEqual(await f.store.consumeLogin(state, browser), { verifier: 'verifier', nonce: 'nonce' });
      await assert.rejects(f.store.consumeLogin(state, browser));
      const expired = randomToken();
      await f.store.beginLogin(expired, browser, 'v', 'n');
      await f.sql.query("UPDATE oauth_attempts SET expires_at=now()-interval '1 second'");
      await assert.rejects(f.store.consumeLogin(expired, browser));
    });
    await t.test('rate counters persist across store instances and block at their limit', async () => {
      assert.equal(await f.store.allowRequest('isolated-limit', 2, 60), true);
      assert.equal(await new AccountStore(f.db, vault).allowRequest('isolated-limit', 2, 60), true);
      assert.equal(await f.store.allowRequest('isolated-limit', 2, 60), false);
    });
    await t.test('HTTP rejects unauthenticated, forged, cross-user and unscoped integration access', async () => {
      const bobSession = await f.store.login({ subject: 'google-bob', email: 'bob@example.com', name: 'Bob' });
      const config: SaaSConfig = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault };
      const reached: string[] = [];
      const app = createSaaSApp({ config, store: f.store, google: {
        authorization: async (state) => `https://accounts.google.com/test?state=${state}`,
        exchange: async (_url, _state, nonce, verifier) => { assert(nonce && verifier); return { subject: 'google-http', email: 'http@example.com', name: 'HTTP' }; },
      }, websiteApp: (userId, context) => {
        const router = express();
        router.get('/jobs', (_req, res) => { reached.push(userId); res.json({ site: context.website.id }); });
        router.post('/jobs/1/ai-copy', (_req, res) => { reached.push(userId); res.json({ ok: true }); });
        return router;
      } });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((done) => server.once('listening', done));
      const address = server.address(); assert(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      const headers = (token: string) => ({ Cookie: `st_session=${token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(token), 'Content-Type': 'application/json' });
      try {
        assert.equal((await fetch(`${base}/api/websites/${site.id}/jobs`)).status, 401);
        assert.equal((await fetch(`${base}/api/jobs`, { headers: headers(alice.token) })).status, 404);
        assert.equal((await fetch(`${base}/api/websites/${site.id}/jobs`, { headers: headers(bobSession.token) })).status, 404);
        assert.equal(reached.length, 0);
        assert.equal((await fetch(`${base}/api/websites/${site.id}/jobs`, { headers: headers(alice.token) })).status, 200);
        assert.deepEqual(reached, [alice.user.id]);
        assert.equal((await fetch(`${base}/api/connections/${connection.id}`, { method: 'PUT', headers: headers(bobSession.token), body: JSON.stringify(source) })).status, 404);
        assert.equal((await fetch(`${base}/api/connections`, { method: 'POST', headers: { ...headers(alice.token), Origin: 'https://evil.example' }, body: JSON.stringify(source) })).status, 403);
        assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: `st_session=${alice.token}`, Origin: config.origin } })).status, 403);
        assert.equal((await fetch(`${base}/api/connections`, { method: 'POST', headers: headers(alice.token), body: JSON.stringify({ ...source, user_id: bob.user.id }) })).status, 400);
        const sessionResponse = await fetch(`${base}/api/session`, { headers: headers(alice.token) });
        assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
        const sessionBody = await sessionResponse.json() as { csrfToken: string; user: { id: string } };
        assert.equal(sessionBody.csrfToken, csrfToken(alice.token));
        assert.equal(sessionBody.user.id, alice.user.id);
        const creditUrl = `${base}/api/tokens/test-credit`;
        assert.equal((await fetch(creditUrl, { method: 'POST' })).status, 401);
        assert.equal((await fetch(creditUrl, { method: 'POST', headers: headers(alice.token) })).status, 403);
        config.testTokensEnabled = true;
        assert.equal((await fetch(creditUrl, { method: 'POST', headers: { Cookie: `st_session=${alice.token}`, Origin: config.origin } })).status, 403);
        const aliceBalance = (await f.store.session(alice.token))!.jobTokens;
        const bobBalance = (await f.store.session(bobSession.token))!.jobTokens;
        const credits = await Promise.all([1, 2].map(() => fetch(creditUrl, {
          method: 'POST', headers: headers(alice.token),
          body: JSON.stringify({ userId: bob.user.id, amount: 1000, jobTokens: 1000 }),
        })));
        assert(credits.every((response) => response.status === 200));
        assert.equal((await f.store.session(alice.token))!.jobTokens, aliceBalance + 2);
        assert.equal((await f.store.session(bobSession.token))!.jobTokens, bobBalance);
        config.testTokensEnabled = false;
        assert.equal((await fetch(creditUrl, { method: 'POST', headers: headers(alice.token) })).status, 403);
        const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
        const loginCookie = start.headers.get('set-cookie')!;
        assert.match(loginCookie, /HttpOnly/); assert.match(loginCookie, /SameSite=Lax/);
        const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
        const callback = `${base}/auth/google/callback?code=test&state=${state}`;
        const loggedIn = await fetch(callback, { headers: { Cookie: loginCookie.split(';')[0]! }, redirect: 'manual' });
        assert.equal(loggedIn.headers.get('location'), '/');
        assert(loggedIn.headers.getSetCookie().some((value) => value.startsWith('st_session=') && value.includes('HttpOnly')));
        const replay = await fetch(callback, { headers: { Cookie: loginCookie.split(';')[0]! }, redirect: 'manual' });
        assert.equal(replay.headers.get('location'), '/?login=failed');
        assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: headers(bobSession.token) })).status, 204);
        assert.equal((await fetch(`${base}/api/session`, { headers: headers(bobSession.token) })).status, 401);
      } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
    });
    await t.test('expired sessions and disabled accounts cannot authenticate', async () => {
      const expired = await f.store.login({ subject: 'expired', email: 'expired@example.com', name: 'Expired' });
      await f.sql.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashToken(expired.token)]);
      assert.equal(await f.store.session(expired.token), undefined);
      await f.sql.query('UPDATE users SET disabled_at=now() WHERE id=$1', [alice.user.id]);
      assert.equal(await f.store.session(alice.token), undefined);
      await assert.rejects(f.store.login({ subject: 'google-alice', email: 'changed@example.com', name: 'Alice' }), /disabled/);
    });
  } finally { await f.close(); }
});

test('job tokens charge only successful work, prevent overspending, and belong to the session account', async () => {
  const f = await fixture();
  try {
    const alice = await f.store.login({ subject: 'tokens-alice', email: 'alice@example.com', name: 'Alice' });
    const bob = await f.store.login({ subject: 'tokens-bob', email: 'bob@example.com', name: 'Bob' });
    const connection = await f.store.saveConnection(alice.user.id, source);
    const site = await f.store.saveWebsite(alice.user.id, siteInput(connection.id));
    assert.equal(alice.user.jobTokens, 0);
    let calls = 0;
    const operation = async () => { calls++; return 'done'; };
    await assert.rejects(f.store.spendJobToken(alice.user.id, site.id, 'push', operation), /No job tokens/);
    assert.equal(calls, 0);
    await f.sql.query('UPDATE workspaces SET job_tokens=3 WHERE id=$1', [alice.user.id]);
    await assert.rejects(f.store.spendJobToken(alice.user.id, site.id, 'push', async () => { throw new Error('Provider failed'); }), /Provider failed/);
    assert.equal((await f.store.session(alice.token))?.jobTokens, 3);
    for (const action of ['push', 'rebuild', 'ai_generation']) {
      assert.equal(await f.store.spendJobToken(alice.user.id, site.id, action, operation), 'done');
    }
    assert.equal((await f.store.session(alice.token))?.jobTokens, 0);
    assert.equal((await f.store.session(bob.token))?.jobTokens, 0);
    const audit = await f.sql.query("SELECT action FROM audit_logs WHERE action LIKE 'job_token.spent.%'");
    assert.equal(audit.rows.length, 3);
    await f.sql.query('UPDATE workspaces SET job_tokens=1 WHERE id=$1', [alice.user.id]);
    const before = calls;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.store.spendJobToken(alice.user.id, site.id, 'push', operation)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(calls - before, 1);
    assert.equal((await f.store.session(alice.token))?.jobTokens, 0);
    await assert.rejects(f.sql.query('UPDATE workspaces SET job_tokens=-1 WHERE id=$1', [alice.user.id]));
  } finally { await f.close(); }
});

test('workspace invitations, roles, shared spending and revocation enforce team boundaries', async () => {
  const f = await fixture();
  try {
    const owner = await f.store.login({ subject: 'team-owner', email: 'owner@example.com', name: 'Owner' });
    const admin = await f.store.login({ subject: 'team-admin', email: 'admin@example.com', name: 'Admin' });
    const member = await f.store.login({ subject: 'team-member', email: 'member@example.com', name: 'Member' });
    const outsider = await f.store.login({ subject: 'team-outsider', email: 'outsider@example.com', name: 'Outsider' });
    const workspaceId = owner.user.workspaceId;
    const connection = await f.store.saveConnection(owner.user.id, source);
    const site = await f.store.saveWebsite(owner.user.id, siteInput(connection.id));
    const invite = await f.store.invite(owner.user.id, workspaceId, ' Member@Example.com ', 'member');
    const raw = (await f.sql.query('SELECT * FROM workspace_invitations WHERE id=$1', [invite.id])).rows[0]!;
    assert.equal(raw.token_hash, hashToken(invite.token));
    assert(!JSON.stringify(raw).includes(invite.token));
    await assert.rejects(f.store.acceptInvitation(outsider.user.id, outsider.token, invite.token), /Google email/);
    assert.equal((await f.store.invitationDetails(member.user.id,invite.token)).role,'member');
    await f.store.acceptInvitation(member.user.id, member.token, invite.token);
    assert.equal((await f.store.session(member.token))!.workspaceId,workspaceId);
    assert.equal((await f.store.session(member.token))!.role,'member');
    await assert.rejects(f.store.acceptInvitation(member.user.id, member.token, invite.token), /invalid or expired/);
    assert.equal((await f.store.listWebsites(member.user.id, workspaceId))[0]!.id, site.id);
    assert.equal((await f.store.websiteContext(member.user.id,site.id,workspaceId)).wordpress!.applicationPassword,'wp-never-return');
    assert(!JSON.stringify(await f.store.listConnections(member.user.id,workspaceId)).includes(source.clientSecret));
    await assert.rejects(f.store.listWebsites(outsider.user.id,workspaceId), /permission/);
    await assert.rejects(f.store.switchWorkspace(outsider.user.id,outsider.token,workspaceId), /permission/);
    // Forging workspace context is insufficient: resource RLS also checks membership.
    assert.deepEqual(await f.db.transaction(outsider.user.id, async (sql) => {
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      return (await sql.query('SELECT * FROM websites')).rows;
    }), []);
    await assert.rejects(f.store.saveConnection(member.user.id,source,connection.id,true,workspaceId), /permission/);
    await assert.rejects(f.store.saveWebsite(member.user.id,siteInput(connection.id),site.id,true,workspaceId), /permission/);
    await assert.rejects(f.store.addTestJobToken(member.user.id,workspaceId), /permission/);
    await assert.rejects(f.store.invite(member.user.id,workspaceId,'new@example.com','member'), /permission/);

    const adminInvite = await f.store.invite(owner.user.id,workspaceId,admin.user.email,'admin');
    await f.store.acceptInvitation(admin.user.id,admin.token,adminInvite.token);
    await f.store.saveConnection(admin.user.id,{ ...source, name: 'Updated by admin' },connection.id,true,workspaceId);
    await assert.rejects(f.store.invite(admin.user.id,workspaceId,'new@example.com','admin'), /Only the owner/);
    await assert.rejects(f.store.changeMember(admin.user.id,workspaceId,member.user.id,'admin'), /Only the owner/);
    await assert.rejects(f.store.changeMember(owner.user.id,workspaceId,owner.user.id), /owner cannot/);
    await assert.rejects(f.store.changeMember(owner.user.id,workspaceId,owner.user.id,'member'), /owner cannot/);
    await assert.rejects(f.store.addTestJobToken(admin.user.id,workspaceId), /permission/);

    await f.store.addTestJobToken(owner.user.id,workspaceId);
    let performed = 0;
    const attempts = await Promise.allSettled([member.user.id,admin.user.id].map((actor) => f.store.spendJobToken(actor,site.id,'push',async () => { performed++; },workspaceId,42052409)));
    assert.equal(attempts.filter((value) => value.status === 'fulfilled').length,1);
    assert.equal(performed,1);
    assert.equal((await f.store.session(owner.token))!.jobTokens,0);
    assert.equal((await f.store.session(member.token))!.jobTokens,0);
    const audit = (await f.sql.query("SELECT * FROM audit_logs WHERE action='job_token.spent.push'")).rows[0]!;
    assert.equal(audit.user_id,member.user.id);
    assert.equal(audit.workspace_id,workspaceId);
    assert.equal(Number(audit.job_id),42052409);

    const expired = await f.store.invite(owner.user.id,workspaceId,outsider.user.email,'member');
    await f.sql.query("UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await assert.rejects(f.store.acceptInvitation(outsider.user.id,outsider.token,expired.token), /invalid or expired/);
    const revoked = await f.store.invite(owner.user.id,workspaceId,outsider.user.email,'member');
    await f.store.revokeInvitation(owner.user.id,workspaceId,revoked.id);
    await assert.rejects(f.store.acceptInvitation(outsider.user.id,outsider.token,revoked.token), /invalid or expired/);
    const replaced = await f.store.invite(owner.user.id,workspaceId,outsider.user.email,'member');
    await f.store.invite(owner.user.id,workspaceId,outsider.user.email,'member');
    await assert.rejects(f.store.acceptInvitation(outsider.user.id,outsider.token,replaced.token), /invalid or expired/);
    const pendingAdmin = await f.store.invite(admin.user.id,workspaceId,'future@example.com','member');
    await f.store.changeMember(owner.user.id,workspaceId,admin.user.id,'member');
    assert((await f.sql.query('SELECT revoked_at FROM workspace_invitations WHERE id=$1', [pendingAdmin.id])).rows[0]!.revoked_at);
    assert.equal((await f.store.session(admin.token))!.role,'member');
    await assert.rejects(f.store.invite(admin.user.id,workspaceId,'no@example.com','member'), /permission/);
    await f.store.changeMember(owner.user.id,workspaceId,member.user.id);
    assert.equal((await f.store.session(member.token))!.workspaceId,member.user.id);
    await assert.rejects(f.store.websiteContext(member.user.id,site.id,workspaceId), /permission/);
    await assert.rejects(f.store.spendJobToken(member.user.id,site.id,'push',async () => { performed++; },workspaceId), /permission/);
    assert.equal(performed,1);
  } finally { await f.close(); }
});

test('workspace migration preserves existing sessions, balances, resources, encrypted credentials and audit history', async () => {
  const ownerId = randomUUID(), connectionId = randomUUID(), siteId = randomUUID(), token = randomToken();
  const f = await fixture(async (sql) => {
    await sql.query("INSERT INTO users(id,google_subject,email,name,job_tokens) VALUES($1,'existing','existing@example.com','Existing',17)", [ownerId]);
    await sql.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(token),ownerId]);
    await sql.query("SELECT set_config('app.user_id',$1,true)", [ownerId]);
    await sql.query("INSERT INTO servicetitan_connections(id,user_id,name,environment,tenant_id,credentials) VALUES($1,$2,'Existing','production','1234',$3)", [connectionId,ownerId,vault.encrypt(source,`connection:${ownerId}:${connectionId}`)]);
    await sql.query("INSERT INTO websites(id,user_id,connection_id,name,url,wordpress_credentials) VALUES($1,$2,$3,'Existing site','https://example.com',$4)", [siteId,ownerId,connectionId,vault.encrypt({ username: 'existing', applicationPassword: 'kept-secret' },`website:${ownerId}:${siteId}`)]);
    await sql.query("INSERT INTO audit_logs(id,user_id,action,target_id) VALUES($1,$2,'website.created',$3)", [randomUUID(),ownerId,siteId]);
  });
  try {
    const session = (await f.store.session(token))!;
    assert.equal(session.workspaceId,ownerId);
    assert.equal(session.role,'owner');
    assert.equal(session.jobTokens,17);
    const context = await f.store.websiteContext(ownerId,siteId,ownerId);
    assert.equal(context.connection.clientSecret,source.clientSecret);
    assert.equal(context.wordpress!.applicationPassword,'kept-secret');
    assert.equal((await f.store.listWebsites(ownerId))[0]!.id,siteId);
    const oldAudit = (await f.sql.query("SELECT * FROM audit_logs WHERE action='website.created'")).rows[0]!;
    assert.equal(oldAudit.workspace_id,ownerId);
    assert.equal(oldAudit.user_id,ownerId);
    assert.equal(oldAudit.job_id,null);
  } finally { await f.close(); }
});

test('team HTTP endpoints bind invitations and permissions to the authenticated session workspace', async () => {
  const f = await fixture();
  const owner = await f.store.login({ subject: 'http-team-owner', email: 'owner@example.com', name: 'Owner' });
  const member = await f.store.login({ subject: 'http-team-member', email: 'member@example.com', name: 'Member' });
  const config: SaaSConfig = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault, testTokensEnabled: true };
  const app = createSaaSApp({ config, store: f.store, google: { authorization: async () => '', exchange: async () => { throw new Error('unused'); } }, websiteApp: () => express() });
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>((done) => server.once('listening',done));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (token: string) => ({ Cookie: `st_session=${token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(token), 'Content-Type': 'application/json' });
  const post = (path: string, token: string, body: unknown = {}) => fetch(base+path,{ method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base+'/api/team')).status,401);
    assert.equal((await fetch(base+'/api/team/invitations',{ method: 'POST', headers: { Cookie: `st_session=${owner.token}` } })).status,403);
    const response = await post('/api/team/invitations',owner.token,{ email: member.user.email, role: 'member', workspaceId: member.user.id });
    assert.equal(response.status,201);
    const invitation = await response.json() as { url: string };
    const inviteToken = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('token')!;
    assert.equal((await post('/api/invitations/preview',member.token,{ token: inviteToken })).status,200);
    assert.equal((await post('/api/invitations/accept',member.token,{ token: inviteToken, role: 'owner' })).status,204);
    assert.equal((await f.store.session(member.token))!.workspaceId,owner.user.id);
    assert.equal((await f.store.session(member.token))!.role,'member');
    assert.equal((await post('/api/connections',member.token,source)).status,403);
    assert.equal((await post('/api/tokens/test-credit',member.token)).status,403);
    assert.equal((await post('/api/team/invitations',member.token,{ email: 'other@example.com', role: 'member' })).status,403);
    assert.equal((await fetch(base+`/api/team/members/${member.user.id}`,{ method: 'PATCH', headers: headers(member.token), body: JSON.stringify({ role: 'admin' }) })).status,403);
    assert.equal((await post('/api/workspaces/select',member.token,{ workspaceId: randomUUID() })).status,403);
    assert.equal((await post('/api/workspaces/select',member.token,{ workspaceId: member.user.id })).status,204);
    const stale = await fetch(base+'/api/team/invitations',{ method: 'POST', headers: { ...headers(member.token), 'X-Workspace-ID': owner.user.id }, body: JSON.stringify({ email: 'other@example.com',role: 'member' }) });
    assert.equal(stale.status,409);
    await f.store.switchWorkspace(member.user.id,member.token,owner.user.id);
    assert.equal((await fetch(base+`/api/team/members/${member.user.id}`,{ method: 'DELETE', headers: headers(owner.token) })).status,204);
    assert.equal((await post('/api/workspaces/select',member.token,{ workspaceId: owner.user.id })).status,403);
    assert.equal((await f.store.session(member.token))!.workspaceId,member.user.id);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await f.close(); }
});
