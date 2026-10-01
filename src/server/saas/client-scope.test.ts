import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, configureApi, wordpressStatusStorage } from '../../client/api.js';

test('browser status caches are isolated by account and website', () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } } });
  try {
    configureApi('alice', 'site-one', 'csrf');
    wordpressStatusStorage().setItem('statuses', 'private title');
    assert.equal(apiUrl('/api/jobs/123/images/45'), '/api/websites/site-one/jobs/123/images/45');
    configureApi('alice', 'site-two', 'csrf');
    assert.equal(wordpressStatusStorage().getItem('statuses'), null);
    configureApi('bob', 'site-one', 'csrf');
    assert.equal(wordpressStatusStorage().getItem('statuses'), null);
    configureApi('alice', 'site-one', 'csrf');
    assert.equal(wordpressStatusStorage().getItem('statuses'), 'private title');
    configureApi('local', '', '');
    assert.equal(apiUrl('/api/jobs'), '/api/jobs');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
