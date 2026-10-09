import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp, parseApprovedPostCopy, parseJobsQuery } from './app.js';

test('converts an inclusive date range into ServiceTitan UTC boundaries', () => {
  assert.deepEqual(
    parseJobsQuery({ start: '2026-08-01', end: '2026-08-07', page: '2', pageSize: '25' }),
    {
      startDate: '2026-08-01T00:00:00.000Z',
      endDateExclusive: '2026-08-08T00:00:00.000Z',
      page: 2,
      pageSize: 25,
    },
  );
});

test('applies pagination defaults', () => {
  const query = parseJobsQuery({ start: '2026-08-01', end: '2026-08-01' });
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 25);
});

test('accepts an optional ZIP-code jobs filter', () => {
  const query = parseJobsQuery({ start: '2026-08-01', end: '2026-08-07', zip: '07001' });
  assert.equal(query.zip, '07001');
  assert.throws(
    () => parseJobsQuery({ start: '2026-08-01', end: '2026-08-07', zip: '7001' }),
    /ZIP code/,
  );
});

test('rejects impossible dates, reversed ranges, and oversized pages', () => {
  assert.throws(() => parseJobsQuery({ start: '2026-02-30', end: '2026-03-01' }), /valid calendar dates/);
  assert.throws(() => parseJobsQuery({ start: '2026-03-02', end: '2026-03-01' }), /on or after/);
  assert.throws(() => parseJobsQuery({ start: '2026-03-01', end: '2026-03-02', pageSize: '51' }), /between 1 and 50/);
});

test('downloads the packaged WordPress plugin with an installable filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'st-plugin-download-'));
  const archivePath = join(directory, 'plugin.zip');
  const archive = Buffer.from('test plugin archive');
  await writeFile(archivePath, archive);

  const app = createApp({
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('not used'); },
      getJobDetails: async () => { throw new Error('not used'); },
      getJobImage: async () => { throw new Error('not used'); },
    },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: '1.18.2', installedVersion: '1.18.2', seoGeneratorVersion: 5 }),
      getStatuses: async () => ({}),
      getStatus: async () => ({ state: 'not_found', label: 'None' }),
      pushJob: async () => { throw new Error('not used'); },
      regenerateJob: async () => { throw new Error('not used'); },
      updateStatus: async () => { throw new Error('not used'); },
    },
    wordpressPluginArchivePath: archivePath,
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    const address = server.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/downloads/servicetitan-job-integration-1.18.2.zip`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /servicetitan-job-integration-1\.18\.2\.zip/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);

    const removedSave = await fetch(`http://127.0.0.1:${address.port}/api/wordpress/plugin/download`, { method: 'POST' });
    assert.equal(removedSave.status, 404);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('passes an optional replacement image through the regeneration route', async () => {
  let requestedImage = '';
  let regeneratedWithImage = '';
  let regeneratedWithTitle = '';
  let regeneratedWithExcerpt = '';
  const app = createApp({
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('not used'); },
      getJobDetails: async (jobId) => ({
        job: { id: jobId, jobNumber: 'J-42', locationId: 2, jobTypeId: 3, jobStatus: 'Completed' },
        summary: {
          id: jobId,
          jobNumber: 'J-42',
          jobName: 'Plumbing Service',
          status: 'Completed',
          location: { city: 'Torrance', state: 'CA', zip: '90505' },
        },
        attachments: [],
        history: [],
      }),
      getJobImage: async (_jobId, attachmentId) => {
        requestedImage = attachmentId;
        return { id: attachmentId, fileName: 'replacement.jpg', contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };
      },
    },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: '1.18.2', installedVersion: '1.18.2', seoGeneratorVersion: 5 }),
      getStatuses: async () => ({}),
      getStatus: async () => ({ state: 'exists', label: 'Published', postId: 77 }),
      pushJob: async () => { throw new Error('not used'); },
      regenerateJob: async (_job, force, image, copy) => {
        assert.equal(force, false);
        regeneratedWithImage = image?.id || '';
        regeneratedWithTitle = copy?.title || '';
        regeneratedWithExcerpt = copy?.excerpt || '';
        return { state: 'exists', label: 'Published', postId: 77 };
      },
      updateStatus: async () => { throw new Error('not used'); },
    },
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    const address = server.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/42/wordpress/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false, attachmentId: 'replacement_1', aiCopy: 'TITLE: Plumbing Service in Torrance, CA\nEXCERPT: A fresh SEO description for this completed plumbing service in Torrance, California.' }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestedImage, 'replacement_1');
    assert.equal(regeneratedWithImage, 'replacement_1');
    assert.equal(regeneratedWithTitle, 'Plumbing Service in Torrance, CA');
    assert.equal(regeneratedWithExcerpt, 'A fresh SEO description for this completed plumbing service in Torrance, California.');
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test('generates editable AI copy from trusted ServiceTitan job details', async () => {
  let generatedJobName = '';
  const bodyHtml = '<p>A Torrance property had a documented kitchen drain blockage that required drain clearing.</p><p>The technician located the documented blockage and cleared the affected drain line.</p><p>The completed work addressed the reported issue. Contact the company for drain clearing in Torrance.</p>';
  const app = createApp({
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('not used'); },
      getJobDetails: async (jobId) => ({
        job: { id: jobId, jobNumber: 'J-42', locationId: 2, jobTypeId: 3, jobStatus: 'Completed' },
        summary: {
          id: jobId,
          jobNumber: 'J-42',
          jobName: 'Drain Clearing',
          status: 'Completed',
          summaryText: 'Cleared a blocked kitchen drain.',
          location: { city: 'Torrance', state: 'CA', zip: '90505' },
        },
        attachments: [],
        history: [],
      }),
      getJobImage: async () => { throw new Error('not used'); },
    },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: '1.18.2', installedVersion: '1.18.2', seoGeneratorVersion: 5 }),
      getStatuses: async () => ({}),
      getStatus: async () => ({ state: 'not_found', label: 'None' }),
      pushJob: async () => { throw new Error('not used'); },
      regenerateJob: async () => { throw new Error('not used'); },
      updateStatus: async () => { throw new Error('not used'); },
    },
    copyGenerator: {
      generate: async (job) => {
        generatedJobName = job.jobName;
        return {
          title: 'Drain Clearing Service in Torrance, CA',
          bodyHtml,
        };
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    const address = server.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/42/ai-copy`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(generatedJobName, 'Drain Clearing');
    assert.deepEqual(await response.json(), {
      title: 'Drain Clearing Service in Torrance, CA',
      bodyHtml,
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test('parses title and WordPress-ready HTML body', () => {
  const fullCopy = [
    'TITLE: Water Heater Repair in Austin, TX',
    'BODY:',
    '<p>The company completed water heater repair in Austin, Texas, after unreliable hot water was reported.</p>',
    '<p>The technician reviewed the concern and evaluated the water heater named in the job record.</p>',
    '<p>The documented repair addressed the reported concern. Contact the company for water heater service in Austin.</p>',
  ].join('\n');
  assert.deepEqual(parseApprovedPostCopy(fullCopy, true), {
    title: 'Water Heater Repair in Austin, TX',
    bodyHtml: '<p>The company completed water heater repair in Austin, Texas, after unreliable hot water was reported.</p>\n<p>The technician reviewed the concern and evaluated the water heater named in the job record.</p>\n<p>The documented repair addressed the reported concern. Contact the company for water heater service in Austin.</p>',
  });
  assert.throws(() => parseApprovedPostCopy('A title without labeled fields', true), /Start with TITLE/);
  assert.throws(() => parseApprovedPostCopy('TITLE: Short\nBODY:\n<p>Too short.</p>', true), /title must be between/);
});

test('all paid routes enforce the server token gate even with forged billing fields', async () => {
  const fullCopy = 'TITLE: Drain Clearing in Torrance, CA\nBODY:\n<p>The company completed drain clearing in Torrance, California.</p><p>The technician reviewed the reported kitchen blockage.</p><p>The documented service addressed the blockage. Contact the company for drain service.</p>';

  const { HttpError } = await import('./saas/validation.js');
  const { DisabledWordPressClient } = await import('./wordpress.js');
  const actions: string[] = [];
  let imageUnavailable = false;
  const app = createApp({
    spendJobToken: async (action) => { actions.push(action); throw new HttpError('No job tokens available.', 402); },
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('unused'); },
      getJobDetails: async () => ({
        job: { id: 1, jobNumber: '1', locationId: 2, jobTypeId: 3, jobStatus: 'Completed' },
        summary: { id: 1, jobNumber: '1', jobName: 'Plumbing', status: 'Completed', location: { city: 'Austin', state: 'TX', zip: '78701' } },
        attachments: [], history: [],
      }),
      getJobImage: async () => {
        if (imageUnavailable) throw new HttpError('Image unavailable.', 502);
        return { id: 'image', fileName: 'image.jpg', contentType: 'image/jpeg', bytes: new Uint8Array([1]) };
      },
    },
    wordpress: new DisabledWordPressClient(),
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((done) => server.once('listening', done));
    const address = server.address();
    assert(address && typeof address === 'object');
    for (const path of ['ai-copy', 'wordpress', 'wordpress/regenerate']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/1/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobTokens: 999, cost: 0, userId: 'someone-else', attachmentIds: ['image'], status: 'draft', aiCopy: fullCopy, force: true }),
      });
      assert.equal(response.status, 402);
      assert.match((await response.json()).error, /No job tokens/);
    }
    assert.deepEqual(actions, ['ai_generation', 'push', 'rebuild']);
    imageUnavailable = true;
    const failedPush = await fetch(`http://127.0.0.1:${address.port}/api/jobs/1/wordpress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentIds: ['image'], status: 'publish', aiCopy: fullCopy }),
    });
    assert.equal(failedPush.status, 502);
    assert.match((await failedPush.json()).error, /Image unavailable/);
    // The token callback and WordPress publishing are never reached when the image fails.
    assert.deepEqual(actions, ['ai_generation', 'push', 'rebuild']);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});
