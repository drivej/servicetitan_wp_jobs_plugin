import { TokenAccounts } from './token-accounts.js';
import { postTokenTransaction } from './token-ledger.js';
import Stripe from 'stripe';
import { BillingService } from './billing.js';
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
import { buildJobCopyFacts } from '../job-copy-prompt.js';

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
  await sql.query(`REVOKE INSERT,UPDATE,DELETE ON platform_administrators FROM ${role}; REVOKE UPDATE,DELETE ON token_transactions FROM ${role}`);
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
      assert.equal((await f.sql.query('SELECT * FROM schema_migrations')).rows.length, 5);
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
    await f.db.transaction(alice.user.id, (sql) => postTokenTransaction(sql, { workspaceId: alice.user.id, kind: 'test_credit', requestedAmount: 3, reference: 'test:seed', reason: 'Test setup' }));
    await assert.rejects(f.store.spendJobToken(alice.user.id, site.id, 'push', async () => { throw new Error('Provider failed'); }), /Provider failed/);
    assert.equal((await f.store.session(alice.token))?.jobTokens, 3);
    for (const action of ['push', 'rebuild', 'ai_generation']) {
      assert.equal(await f.store.spendJobToken(alice.user.id, site.id, action, operation), 'done');
    }
    assert.equal((await f.store.session(alice.token))?.jobTokens, 0);
    assert.equal((await f.store.session(bob.token))?.jobTokens, 0);
    const audit = await f.sql.query("SELECT action FROM audit_logs WHERE action LIKE 'job_token.spent.%'");
    assert.equal(audit.rows.length, 3);
    await f.db.transaction(alice.user.id, (sql) => postTokenTransaction(sql, { workspaceId: alice.user.id, kind: 'test_credit', requestedAmount: 1, reference: 'test:refill', reason: 'Test setup' }));
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


test('Stripe invoice grants are capped, atomic, deduplicated and workspace isolated', async () => {
  const f = await fixture();
  try {
    const owner = await f.store.login({ subject: 'billing-owner', email: 'billing@example.com', name: 'Billing' });
    const other = await f.store.login({ subject: 'billing-other', email: 'other-billing@example.com', name: 'Other' });
    await f.sql.query('INSERT INTO workspace_billing(workspace_id,customer_id) VALUES($1,$2)', [owner.user.id, 'cus_test']);
    const billing = new BillingService(f.db, { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: [], development: true, maxTokens: 200 }, 'http://localhost:3000');
    const plan = { id: 'price_test', name: 'Test', amount: 1000, currency: 'usd', tokens: 100, maxTokens: 200, interval: 'month' as const, intervalCount: 1 };
    await Promise.all([1, 2].map(() => billing.creditInvoice('cus_test', 'in_first', 'sub_test', 1, plan)));
    assert.equal((await f.store.session(owner.token))?.jobTokens, 100);
    await billing.creditInvoice('cus_test', 'in_duplicate_period', 'sub_test', 1, plan);
    assert.equal((await f.store.session(owner.token))?.jobTokens, 100);
    await billing.creditInvoice('cus_test', 'in_second', 'sub_test', 2, plan);
    await billing.creditInvoice('cus_test', 'in_third', 'sub_test', 3, plan);
    assert.equal((await f.store.session(owner.token))?.jobTokens, 200);
    assert.equal((await f.store.session(other.token))?.jobTokens, 0);
    // Changing the environment cap applies to new grants; stale plan caps do not.
    billing.config.maxTokens = 250;
    await billing.creditInvoice('cus_test', 'in_new_cap', 'sub_test', 4, { ...plan, maxTokens: 999 });
    assert.equal((await f.store.session(owner.token))?.jobTokens, 250);
    await billing.creditInvoice('cus_test', 'in_new_cap', 'sub_test', 4, plan);
    assert.equal((await f.store.session(owner.token))?.jobTokens, 250);
    await assert.rejects(billing.creditInvoice('cus_test', 'in_bad', 'sub_test', 5, { ...plan, tokens: -1 }));
    assert.equal((await f.sql.query("SELECT * FROM stripe_token_grants WHERE invoice_id='in_bad'")).rows.length, 0);
  } finally { await f.close(); }
});

test('Stripe Checkout reuses sessions and enforces workspace ownership', async () => {
  const f = await fixture();
  try {
    const owner = await f.store.login({ subject: 'checkout-owner', email: 'checkout@example.com', name: 'Checkout' });
    const other = await f.store.login({ subject: 'checkout-other', email: 'checkout-other@example.com', name: 'Other' });
    let customers = 0, sessions = 0;
    const stripe = {
      prices: { retrieve: async () => ({ id: 'price_test', active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, billing_scheme: 'per_unit', unit_amount: 1000, currency: 'usd', metadata: { token_count: '100' }, product: 'prod_test' }) },
      customers: { create: async () => { customers++; return { id: 'cus_checkout' }; } },
      subscriptions: { list: async () => ({ data: [] }) },
      checkout: { sessions: {
        create: async () => {
          sessions++;
          assert.equal((await f.sql.query("SELECT * FROM workspace_billing WHERE customer_id='cus_checkout'")).rows.length, 1);
          return { id: 'cs_checkout', url: 'https://checkout.stripe.com/test' };
        },
        retrieve: async () => ({ status: 'open', url: 'https://checkout.stripe.com/test' }),
      } },
    } as unknown as Stripe;
    const billing = new BillingService(f.db, { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: ['price_test'], development: true, maxTokens: 200 }, 'http://localhost:3000', stripe);
    await assert.rejects(billing.checkout({ ...other.user, workspaceId: owner.user.workspaceId }, 'price_test'), /owner/);
    await assert.rejects(billing.checkout(owner.user, 'price_unknown'), /available/);
    const first = await billing.checkout(owner.user, 'price_test');
    const second = await billing.checkout(owner.user, 'price_test');
    assert.equal(first.url, second.url);
    assert.equal(customers, 1); assert.equal(sessions, 1);
  } finally { await f.close(); }
});

test('billing HTTP preserves raw webhook signatures and protects checkout with session and CSRF', async () => {
  const f = await fixture();
  const billing = new BillingService(f.db, { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: [], development: true, maxTokens: 200 }, 'http://localhost:3000');
  const config: SaaSConfig = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault };
  const app = createSaaSApp({ config, store: f.store, billing, google: { authorization: async () => '', exchange: async () => { throw new Error('unused'); } }, websiteApp: () => express() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const owner = await f.store.login({ subject: 'billing-http', email: 'billing-http@example.com', name: 'Owner' });
    const payload = JSON.stringify({ id: 'evt_http', type: 'customer.subscription.updated', livemode: false, data: { object: {} } }, null, 2);
    const signature = billing.stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_example' });
    assert.equal((await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload })).status, 200);
    assert.equal((await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload + ' ' })).status, 400);
    assert.equal((await fetch(base + '/api/billing/checkout', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { Cookie: `st_session=${owner.token}`, Origin: config.origin } })).status, 403);
    assert.equal((await fetch(base + '/api/billing/portal', { method: 'POST', headers: { Cookie: `st_session=${owner.token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(owner.token), 'X-Workspace-ID': randomUUID() } })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await f.close();
  }
});


test('free Stripe Checkout is owner-only, flag-gated and requires a zero-cost price', async () => {
  const f = await fixture();
  try {
    const owner = await f.store.login({ subject: 'free-owner', email: 'free-owner@example.com', name: 'Owner' });
    const member = await f.store.login({ subject: 'free-member', email: 'free-member@example.com', name: 'Member' });
    await f.sql.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')", [owner.user.id, member.user.id]);
    const memberUser = { ...member.user, workspaceId: owner.user.id, role: 'member' as const };
    let freeAmount = 0;
    let checkoutCalls = 0;
    const stripe = {
      prices: { retrieve: async (id: string) => ({ id, active: true, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, billing_scheme: 'per_unit', unit_amount: id === 'price_free' ? freeAmount : 1000, currency: 'usd', metadata: { token_count: '10' }, product: 'prod_test' }) },
      customers: { create: async () => ({ id: 'cus_free' }) },
      subscriptions: { list: async () => ({ data: [] }) },
      checkout: { sessions: { create: async (params: Stripe.Checkout.SessionCreateParams) => {
        checkoutCalls++;
        assert.equal(params.mode, 'subscription');
        assert.equal(params.line_items?.[0]?.price, 'price_free');
        return { id: 'cs_free', url: 'https://checkout.stripe.com/free' };
      } } },
    } as unknown as Stripe;
    const config = { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: ['price_paid'], freePrice: 'price_free', testTokensEnabled: false, development: true, maxTokens: 200 };
    const billing = new BillingService(f.db, config, 'http://localhost:3000', stripe);
    assert.equal((await billing.summary(owner.user)).testPlan, null);
    await assert.rejects(billing.checkout(owner.user, 'price_free'), /available/);
    config.testTokensEnabled = true;
    assert.equal((await billing.summary(owner.user)).testPlan?.id, 'price_free');
    assert.equal((await billing.summary(memberUser)).testPlan, null);
    await assert.rejects(billing.checkout(memberUser, 'price_free'), /owner/);
    freeAmount = 100;
    await assert.rejects(billing.checkout(owner.user, 'price_free'), /zero price/);
    freeAmount = 0;
    assert.equal((await billing.checkout(owner.user, 'price_free')).url, 'https://checkout.stripe.com/free');
    assert.equal(checkoutCalls, 1);
    assert.equal((await f.store.session(owner.token))?.jobTokens, 0);
  } finally { await f.close(); }
});

test('ledger records actual credits, cap loss, spending and immutable reconciled balances', async () => {
  const f = await fixture();
  try {
    const owner = await f.store.login({ subject: 'ledger-owner', email: 'ledger-owner@example.com', name: 'Owner' });
    const connection = await f.store.saveConnection(owner.user.id, source);
    const site = await f.store.saveWebsite(owner.user.id, siteInput(connection.id));
    const accounts = new TokenAccounts(f.db);
    await f.store.addTestJobToken(owner.user.id);
    await f.sql.query('INSERT INTO workspace_billing(workspace_id,customer_id) VALUES($1,$2)', [owner.user.id, 'cus_ledger']);
    const billing = new BillingService(f.db, { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: [], development: true, maxTokens: 5 }, 'http://localhost:3000');
    const plan = { id: 'price_ledger', name: 'Plan', amount: 1000, currency: 'usd', tokens: 10, maxTokens: 5, interval: 'week' as const, intervalCount: 1 };
    await Promise.all([1, 2].map(() => billing.creditInvoice('cus_ledger', 'in_ledger', 'sub_ledger', 1, plan)));
    await f.store.spendJobToken(owner.user.id, site.id, 'push', async () => 'ok', owner.user.id, 123);
    await assert.rejects(f.store.spendJobToken(owner.user.id, site.id, 'push', async () => { throw new Error('failed'); }));
    const history = await accounts.history(owner.user.id, owner.user.id);
    assert.equal(history.balance, 4);
    assert.equal(history.ledgerBalance, 4);
    assert.equal(history.reconciled, true);
    assert.equal(history.transactions.length, 3);
    assert.equal(history.transactions[0]!.kind, 'spend');
    assert.equal(history.transactions[0]!.amount, -1);
    assert.equal(history.transactions[0]!.jobId, 123);
    assert.equal(history.transactions[0]!.actorUserId, owner.user.id);
    const credit = history.transactions[1]!;
    assert.equal(credit.requestedAmount, 10);
    assert.equal(credit.amount, 4);
    assert.equal(credit.discardedAmount, 6);
    assert.equal(credit.balanceBefore, 1);
    assert.equal(credit.balanceAfter, 5);
    assert.equal(credit.stripeInvoiceId, 'in_ledger');
    await assert.rejects(f.sql.query('UPDATE token_transactions SET amount=0 WHERE id=$1', [credit.id]), /append-only/);
    await assert.rejects(f.sql.query('DELETE FROM token_transactions WHERE id=$1', [credit.id]), /append-only/);
    await assert.rejects(f.sql.query('TRUNCATE token_transactions'), /append-only/);
    await assert.rejects(f.sql.query('UPDATE workspaces SET job_tokens=999 WHERE id=$1', [owner.user.id]), /ledger/);
    assert.equal((await f.store.session(owner.token))!.jobTokens, 4);
    await assert.rejects(f.db.transaction(owner.user.id, async (sql) => {
      await postTokenTransaction(sql, { workspaceId: owner.user.id, kind: 'test_credit', requestedAmount: 3, reference: 'rollback:test', reason: 'Rollback test' });
      throw new Error('Abort');
    }));
    assert.equal((await accounts.history(owner.user.id, owner.user.id)).transactions.length, 3);
    // A cap reduction has an explicit negative net change, not an unexplained loss.
    billing.config.maxTokens = 2;
    await billing.creditInvoice('cus_ledger', 'in_lower_cap', 'sub_ledger', 2, plan);
    const capped = (await accounts.history(owner.user.id, owner.user.id)).transactions[0]!;
    assert.equal(capped.amount, -2); assert.equal(capped.discardedAmount, 12); assert.equal(capped.balanceAfter, 2);
  } finally { await f.close(); }
});

test('platform administration is distinct from workspace roles and adjustments are retry safe', async () => {
  const f = await fixture();
  try {
    const operator = await f.store.login({ subject: 'platform-operator', email: 'operator@example.com', name: 'Operator' });
    const owner = await f.store.login({ subject: 'platform-customer', email: 'customer@example.com', name: 'Customer' });
    const admin = await f.store.login({ subject: 'workspace-admin', email: 'admin@example.com', name: 'Workspace admin' });
    const member = await f.store.login({ subject: 'ledger-member', email: 'member@example.com', name: 'Member' });
    await f.sql.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')", [owner.user.id, admin.user.id, member.user.id]);
    const accounts = new TokenAccounts(f.db);
    for (const user of [owner.user, admin.user, member.user, operator.user]) {
      await assert.rejects(accounts.list(user.id), /Platform administrator/);
      await assert.rejects(accounts.adjust(user.id, owner.user.id, { amount: 10, reason: 'Unauthorized', requestId: randomUUID() }), /Platform administrator/);
    }
    await assert.rejects(accounts.history(member.user.id, owner.user.id), /owner or admin/);
    await assert.rejects(accounts.history(operator.user.id, owner.user.id), /owner or admin/);
    assert.equal((await accounts.history(admin.user.id, owner.user.id)).balance, 0);
    await assert.rejects(f.db.transaction(operator.user.id, (sql) => sql.query('INSERT INTO platform_administrators(user_id) VALUES($1)', [operator.user.id])), /permission/);
    await f.sql.query('INSERT INTO platform_administrators(user_id) VALUES($1)', [operator.user.id]);
    assert.equal((await f.store.session(operator.token))!.isPlatformAdmin, true);
    assert.equal((await accounts.list(operator.user.id, 'customer@example.com')).accounts.length, 1);
    const request = { amount: 50, reason: 'Customer service credit', requestId: randomUUID() };
    const replies = await Promise.all([1, 2].map(() => accounts.adjust(operator.user.id, owner.user.id, request)));
    assert.equal(replies[0]!.transaction.id, replies[1]!.transaction.id);
    assert.equal(replies[0]!.balance, 50);
    await assert.rejects(accounts.adjust(operator.user.id, owner.user.id, { ...request, amount: 51 }), /different details/);
    await assert.rejects(accounts.adjust(operator.user.id, owner.user.id, { ...request, reason: 'Changed' }), /different details/);
    await assert.rejects(accounts.adjust(operator.user.id, owner.user.id, { ...request, requestId: randomUUID(), amount: -51 }), /allowed range/);
    await assert.rejects(accounts.adjust(operator.user.id, owner.user.id, { ...request, requestId: randomUUID(), reason: ' ' }), /reason/);
    await accounts.adjust(operator.user.id, owner.user.id, { amount: -5, reason: 'Correction', requestId: randomUUID() });
    const history = await accounts.history(operator.user.id, owner.user.id, '', true);
    assert.equal(history.balance, 45); assert.equal(history.reconciled, true);
    assert.equal(history.transactions[0]!.actorUserId, operator.user.id);
    assert.equal(history.transactions[0]!.actorName, 'Operator');
    assert.equal(history.transactions[1]!.reason, 'Customer service credit');
    await f.sql.query('DELETE FROM platform_administrators WHERE user_id=$1', [operator.user.id]);
    assert.equal((await f.store.session(operator.token))!.isPlatformAdmin, false);
    await assert.rejects(accounts.history(operator.user.id, owner.user.id, '', true), /Platform administrator/);
    await assert.rejects(accounts.adjust(operator.user.id, owner.user.id, request), /Platform administrator/);
  } finally { await f.close(); }
});

test('ledger history pagination does not duplicate transactions and opening balances survive migration', async () => {
  const f = await fixture(async (sql) => {
    const id = randomUUID();
    await sql.query('INSERT INTO users(id,google_subject,email,name,job_tokens) VALUES($1,$2,$3,$4,23)', [id, 'pre-ledger-user', 'legacy@example.com', 'Legacy']);
  });
  try {
    const owner = await f.store.login({ subject: 'pre-ledger-user', email: 'legacy@example.com', name: 'Legacy' });
    const accounts = new TokenAccounts(f.db);
    const opening = await accounts.history(owner.user.id, owner.user.id);
    assert.equal(opening.balance, 23);
    assert.equal(opening.transactions[0]!.kind, 'opening');
    assert.equal(opening.transactions[0]!.amount, 23);
    for (let i = 0; i < 52; i++) await f.store.addTestJobToken(owner.user.id);
    const first = await accounts.history(owner.user.id, owner.user.id);
    assert.equal(first.transactions.length, 50);
    assert(first.nextCursor);
    await f.store.addTestJobToken(owner.user.id);
    const second = await accounts.history(owner.user.id, owner.user.id, first.nextCursor);
    assert.equal(second.transactions.length, 3);
    assert.equal(new Set([...first.transactions, ...second.transactions].map((t) => t.id)).size, 53);
    assert.equal(second.reconciled, true);
    await assert.rejects(accounts.history(owner.user.id, owner.user.id, 'invalid'), /cursor/);
  } finally { await f.close(); }
});

test('ledger HTTP endpoints enforce platform permissions, CSRF and immutable adjustment references', async () => {
  const f = await fixture();
  const config: SaaSConfig = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault };
  const app = createSaaSApp({ config, store: f.store, google: { authorization: async () => '', exchange: async () => { throw new Error('unused'); } }, websiteApp: () => express() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const operator = await f.store.login({ subject: 'ledger-http-admin', email: 'ledger-admin@example.com', name: 'Operator' });
    const customer = await f.store.login({ subject: 'ledger-http-customer', email: 'ledger-customer@example.com', name: 'Customer' });
    await f.sql.query('INSERT INTO platform_administrators(user_id) VALUES($1)', [operator.user.id]);
    const endpoint = `${base}/api/admin/token-accounts/${customer.user.id}/transactions`;
    const headers = (token: string) => ({ Cookie: `st_session=${token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(token), 'Content-Type': 'application/json' });
    const body = JSON.stringify({ amount: 7, reason: 'Support credit', requestId: randomUUID() });
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: headers(customer.token) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: headers(customer.token), body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Cookie: `st_session=${operator.token}`, 'Content-Type': 'application/json' }, body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers(operator.token), Origin: 'https://evil.example' }, body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers(operator.token), 'X-Workspace-ID': customer.user.id }, body })).status, 409);
    const first = await fetch(endpoint, { method: 'POST', headers: headers(operator.token), body });
    assert.equal(first.status, 200);
    const posted = await first.json();
    const replay = await fetch(endpoint, { method: 'POST', headers: headers(operator.token), body });
    assert.equal((await replay.json()).transaction.id, posted.transaction.id);
    const history = await fetch(endpoint, { headers: headers(operator.token) }).then((r) => r.json());
    assert.equal(history.balance, 7); assert.equal(history.transactions.length, 1);
    const own = await fetch(base + '/api/tokens/history', { headers: headers(customer.token) }).then((r) => r.json());
    assert.equal(own.balance, 7);
    // Customer cannot promote themselves by inserting privilege fields.
    const forged = await fetch(endpoint, { method: 'POST', headers: headers(customer.token), body: JSON.stringify({ ...JSON.parse(body), isPlatformAdmin: true }) });
    assert.notEqual(forged.status, 200);
    await f.sql.query('DELETE FROM platform_administrators WHERE user_id=$1', [operator.user.id]);
    assert.equal((await fetch(endpoint, { headers: headers(operator.token) })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
