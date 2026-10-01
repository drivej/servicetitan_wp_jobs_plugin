import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readCachedWordPressStatuses,
  WORDPRESS_STATUS_CACHE_TTL_MS,
  writeCachedWordPressStatuses,
} from '../client/wordpressStatusCache.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('persists confirmed WordPress statuses by ServiceTitan job ID', () => {
  const storage = new MemoryStorage();
  writeCachedWordPressStatuses({
    123: { state: 'exists', label: 'Published', postId: 77, postStatus: 'publish' },
  }, storage, 1_000);

  assert.deepEqual(readCachedWordPressStatuses([123, 456], storage, 2_000), {
    statuses: {
      123: { state: 'exists', label: 'Published', postId: 77, postStatus: 'publish' },
    },
    missingJobIds: [456],
  });
});

test('expires cached WordPress statuses after 24 hours', () => {
  const storage = new MemoryStorage();
  writeCachedWordPressStatuses({ 123: { state: 'not_found', label: 'None' } }, storage, 1_000);

  assert.deepEqual(
    readCachedWordPressStatuses([123], storage, 1_000 + WORDPRESS_STATUS_CACHE_TTL_MS),
    { statuses: {}, missingJobIds: [123] },
  );
});

test('does not persist transient or failed WordPress status checks', () => {
  const storage = new MemoryStorage();
  writeCachedWordPressStatuses({ 123: { state: 'unknown', label: 'Unknown', message: 'Connection failed' } }, storage, 1_000);

  assert.deepEqual(readCachedWordPressStatuses([123], storage, 2_000), {
    statuses: {},
    missingJobIds: [123],
  });
});

test('invalidates statuses cached by an older SEO generator', () => {
  const storage = new MemoryStorage();
  writeCachedWordPressStatuses({
    123: {
      state: 'exists',
      label: 'Published',
      postId: 77,
      postStatus: 'publish',
      seoVersion: 1,
      currentSeoVersion: 1,
      seoState: 'current',
    },
  }, storage, 1_000);

  assert.deepEqual(readCachedWordPressStatuses([123], storage, 2_000, 2), {
    statuses: {},
    missingJobIds: [123],
  });
});
