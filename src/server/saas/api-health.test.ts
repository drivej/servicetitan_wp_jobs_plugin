import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import { createSaaSApp } from './app.js';
import { csrfToken, SecretVault } from './crypto.js';
import type { AccountStore } from './store.js';
import { HttpError } from './validation.js';
import { ServiceTitanClient } from '../service-titan.js';

test('API health requires authentication, CSRF, superadmin, workspace access and cooldown', async () => {
  let admin = false;
  let cooldown = false;
  let contextCalls = 0;
  let probes = 0;
  const token = 'a'.repeat(43);
  const userId = randomUUID();
  const connectionId = randomUUID();
  const store = {
    session: async (value: string) => value === token ? { id: userId, workspaceId: userId, isPlatformAdmin: admin } : undefined,
    allowRequest: async (key: string) => { if (!key.startsWith('api-health:')) return true; if (cooldown) return false; cooldown = true; return true; },
    connectionContext: async (_user: string, id: string, workspace: string) => { contextCalls++; assert.equal(workspace, userId); if (id !== connectionId) throw new HttpError('Connection not found.', 404); return { id: connectionId, tenantId: '123' }; },
  } as unknown as AccountStore;
  const config = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault: new SecretVault({ test: randomBytes(32).toString('base64') }, 'test') };
  const original = ServiceTitanClient.prototype.checkApiHealth;
  ServiceTitanClient.prototype.checkApiHealth = async () => { probes++; return { checkedAt: new Date().toISOString(), checks: [] }; };
  const app = createSaaSApp({ config, store, google: { authorization: async () => '', exchange: async () => { throw new Error('unused'); } }, websiteApp: () => express() });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address(); assert(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/api/admin/service-titan/${connectionId}/health`;
    const headers = { Cookie: `st_session=${token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(token) };
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: headers.Cookie } })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 403);
    assert.equal(contextCalls, 0);
    admin = true;
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Workspace-ID': randomUUID() } })).status, 409);
    assert.equal((await fetch(url.replace(connectionId, randomUUID()), { method: 'POST', headers })).status, 404);
    assert.equal(probes, 0);
    const response = await fetch(url, { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 429);
    assert.equal(probes, 1);
    admin = false;
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 403);
  } finally {
    ServiceTitanClient.prototype.checkApiHealth = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Settings validates required endpoints and never marks a failed or incomplete connection validated', async () => {
  const token = 'b'.repeat(43);
  const userId = randomUUID(), connectionId = randomUUID(), websiteId = randomUUID();
  let marked = 0, attached = 0;
  let state: 'available' | 'unavailable' | 'not_checked' = 'unavailable';
  const store = {
    session: async () => ({ id: userId, workspaceId: userId, role: 'owner' }),
    allowRequest: async () => true,
    listConnections: async () => [{ id: connectionId }],
    connectionContext: async () => ({ id: connectionId, version: 1, tenantId: '123' }),
    testCooldownActive: async () => false,
    startTestCooldown: async () => {},
    websiteWordPressContext: async () => ({ website: { wordpressConfigured: true } }),
    attachConnection: async () => { attached++; },
    markConnectionValidated: async () => { marked++; },
  } as unknown as AccountStore;
  const original = ServiceTitanClient.prototype.checkApiHealth;
  ServiceTitanClient.prototype.checkApiHealth = async () => ({ checkedAt: new Date().toISOString(), checks: [
    { name: 'Authentication', endpoint: '/token', state: 'available', message: 'OK' },
    { name: 'Job notes', endpoint: '/notes', state, message: 'Probe result' },
    { name: 'Attachment download', endpoint: '/attachment', state: 'not_checked', message: 'Skipped' },
  ] });
  const config = { databaseUrl: 'unused', origin: 'http://localhost:3000', googleClientId: 'test', googleClientSecret: 'test', secureCookies: false, trustProxyHops: 0, vault: new SecretVault({ test: randomBytes(32).toString('base64') }, 'test') };
  const app = createSaaSApp({ config, store, google: { authorization: async () => '', exchange: async () => { throw new Error('unused'); } }, websiteApp: () => express() });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address(); assert(address && typeof address === 'object');
    const run = () => fetch(`http://127.0.0.1:${address.port}/api/onboarding/validate-servicetitan`, { method: 'POST', headers: { Cookie: `st_session=${token}`, Origin: config.origin, 'X-CSRF-Token': csrfToken(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, websiteId }) });
    for (const failedState of ['unavailable', 'not_checked'] as const) {
      state = failedState;
      const response = await run();
      assert.equal(response.status, 422);
      const body = await response.json();
      assert.match(body.error, /Job notes/);
      assert.equal(body.report.checks[1].state, failedState);
      assert.equal(marked, 0); assert.equal(attached, 0);
    }
    state = 'available';
    const response = await run();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).valid, true);
    assert.equal(marked, 1); assert.equal(attached, 1);
  } finally {
    ServiceTitanClient.prototype.checkApiHealth = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
