import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasCompleteJobBody, isWordPressBodyHtml } from './job-copy.js';

test('rejects missing or non-string generated HTML without throwing', () => {
  assert.equal(hasCompleteJobBody({ title: 'Drain Service' }), false);
  assert.equal(hasCompleteJobBody({ title: 'Drain Service', bodyHtml: undefined }), false);
  assert.equal(hasCompleteJobBody({ title: 'Drain Service', bodyHtml: 12 }), false);
  assert.equal(isWordPressBodyHtml(undefined), false);
});
