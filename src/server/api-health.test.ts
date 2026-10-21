import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceTitanClient } from './service-titan.js';

function clientWith(get: (url: string) => Promise<unknown>, authenticate = true) {
  const client = new ServiceTitanClient({ clientId: 'client', clientSecret: 'private-secret', appKey: 'private-key', tenantId: '123', apiBaseUrl: 'https://example.test', authUrl: 'https://example.test/token' });
  Object.assign(client, { api: { post: async () => { if (!authenticate) throw new Error('private-secret'); return { data: { access_token: 'private-token', expires_in: 3600 } }; }, get } });
  return client;
}

test('API health checks read endpoints with a sample job and does not return provider data or download files', async () => {
  const calls: string[] = [];
  const client = clientWith(async (url) => {
    calls.push(url);
    return { status: 200, data: url.endsWith('/jobs') ? { data: [{ id: 42, customerName: 'Private customer' }] } : { data: [] } };
  });
  const report = await client.checkApiHealth();
  assert.equal(report.checks.filter((check) => check.state === 'available').length, 10);
  assert.equal(report.checks.find((check) => check.name === 'Attachment download')?.state, 'not_checked');
  assert(calls.some((url) => url.endsWith('/jobs/42/history')));
  assert(!calls.some((url) => url.includes('/attachment/')));
  assert(!JSON.stringify(report).includes('Private customer'));
  assert(!JSON.stringify(report).includes('private-token'));
});

test('API health distinguishes denied, rate limited and missing sample job without leaking upstream errors', async () => {
  const client = clientWith(async (url) => {
    if (url.endsWith('/locations')) throw { isAxiosError: true, response: { status: 403, data: 'private-secret' } };
    if (url.endsWith('/tag-types')) throw { isAxiosError: true, response: { status: 429 } };
    return { status: 200, data: { data: [] } };
  });
  const report = await client.checkApiHealth();
  assert.equal(report.checks.find((check) => check.name === 'Locations')?.statusCode, 403);
  assert.match(report.checks.find((check) => check.name === 'Tag types')!.message, /rate limit/);
  assert.equal(report.checks.find((check) => check.name === 'Job details')?.state, 'not_checked');
  assert(!JSON.stringify(report).includes('private-secret'));
});

test('API health marks dependent APIs unchecked when authentication fails', async () => {
  let requests = 0;
  const report = await clientWith(async () => { requests++; throw new Error('unexpected'); }, false).checkApiHealth();
  assert.equal(requests, 0);
  assert.equal(report.checks[0]?.state, 'unavailable');
  assert(report.checks.slice(1).every((check) => check.state === 'not_checked'));
  assert(!JSON.stringify(report).includes('private-secret'));
});
