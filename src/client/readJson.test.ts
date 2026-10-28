import assert from 'node:assert/strict';
import test from 'node:test';
import { readJson } from './readJson';

test('reads successful JSON and structured SEO update errors', async () => {
  assert.deepEqual(await readJson(Response.json({ state: 'exists' })), { state: 'exists' });
  assert.deepEqual(await readJson(Response.json({ error: 'More project details are needed.' }, { status: 422 })), { error: 'More project details are needed.' });
});

test('explains a legacy plain-text SEO fallback instead of reporting invalid JSON', async () => {
  await assert.rejects(readJson(new Response('try your best', { status: 422 })), /not enough supported project information/);
});

test('still identifies malformed and empty responses', async () => {
  await assert.rejects(readJson(new Response('<html>Error</html>', { status: 502 })), /invalid response \(HTTP 502\)/);
  await assert.rejects(readJson(new Response('', { status: 422 })), /empty response \(HTTP 422\)/);
});
