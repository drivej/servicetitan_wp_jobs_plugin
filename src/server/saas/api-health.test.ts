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
