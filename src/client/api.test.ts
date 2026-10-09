import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFetch } from './api.js';

test('clears successful paid-operation keys when the response is consumed as text', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const entries = new Map<string, string>();
  const keys: string[] = [];
  let nextId = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'https://app.example' },
    crypto: { subtle: crypto.subtle, randomUUID: () => `operation-${++nextId}` },
    sessionStorage: {
      getItem: (key: string) => entries.get(key) || null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    },
    dispatchEvent: () => true,
  } as unknown as Window });
  globalThis.fetch = (async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key') || '');
    return new Response('{"title":"Drain service","bodyHtml":"<p>One</p><p>Two</p><p>Three</p>"}', { status: 200 });
  }) as typeof fetch;
  try {
    const oldDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('local::/api/jobs/42/ai-copy:'));
    const oldSuffix = Array.from(new Uint8Array(oldDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    entries.set(`st-spend-op:${oldSuffix}`, 'legacy-stale-operation');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await apiFetch('/api/jobs/42/ai-copy', { method: 'POST' });
      await response.text();
    }
    assert.notEqual(keys[0], 'legacy-stale-operation', 'copy contract changes must not reuse the old saved operation');
    assert.notEqual(keys[0], keys[1], 'a later click must not replay the prior operation result');
    assert.equal(entries.size, 1, 'the old-version key is left unused while the current key is cleared');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
