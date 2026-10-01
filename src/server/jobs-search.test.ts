import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jobDetailsUrl, jobsListUrl, parseJobsSearch } from '../client/jobsSearch.js';

const defaults = { start: '2026-09-01', end: '2026-09-07', zip: '' };

test('reads job filters and pagination from the URL', () => {
  assert.deepEqual(
    parseJobsSearch('?start=2026-08-01&end=2026-08-31&zip=90712&page=3&pageSize=10', defaults),
    {
      filters: { start: '2026-08-01', end: '2026-08-31', zip: '90712' },
      page: 3,
      pageSize: 10,
    },
  );
});

test('preserves the complete job search in list and detail links', () => {
  const search = parseJobsSearch('?start=2026-08-01&end=2026-08-31&zip=90712&page=3&pageSize=10', defaults);
  assert.equal(
    jobsListUrl(search, 2),
    '/?start=2026-08-01&end=2026-08-31&page=2&pageSize=10&zip=90712',
  );
  assert.equal(
    jobDetailsUrl(42058808, search),
    '/jobs/42058808?start=2026-08-01&end=2026-08-31&page=3&pageSize=10&zip=90712',
  );
});

test('uses safe pagination defaults for invalid URL values', () => {
  assert.deepEqual(parseJobsSearch('?page=0&pageSize=999', defaults), {
    filters: defaults,
    page: 1,
    pageSize: 25,
  });
});
