import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { buildJobCopyFacts, JOB_COPY_INSTRUCTIONS } from './job-copy-prompt.js';

import { createApp, parseApprovedPostCopy, parseJobsQuery } from './app.js';
import { REQUIRED_WORDPRESS_PLUGIN_VERSION } from './wordpress.js';
import { SEO_GENERATOR_VERSION } from '../shared/seo-prompt-version.js';
import { formatJobCopy, type GeneratedJobCopy } from '../shared/job-copy.js';

const validCopy: GeneratedJobCopy = {
  title: 'Plumbing Service in Torrance, CA',
  bodyHtml: '<p>The company completed plumbing service in Torrance, California, to address a documented kitchen drain blockage.</p>',
  seoTitle: 'Plumbing Service in Torrance',
  seoDescription: 'Documented plumbing service in Torrance addressed a kitchen drain blockage with work recorded by the technician.',
};

test('superadmin prompt preview and scanner rating require the platform actor without spending tokens', async () => {
  let reads = 0;
  let generations = 0;
  let spent = 0;
  let generatedFacts = '';
  const routes = createApp({
    jobScorer: { rate: async source => {
      assert.deepEqual(source.technicianNotes, ['Repaired a leaking pipe.']);
      assert.deepEqual(source.tagNames, ['Water Heater']);
      assert.equal(source.companyWebsiteUrl, undefined, 'scanner source must not acquire copy-preview extras');
      return { score: 70, reason: 'Documented repair.' };
    } },
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('unused'); },
      getJobImage: async () => { throw new Error('unused'); },
      getJobDetails: async (id) => {
        reads++;
        return {
          job: { id, jobNumber: '42', locationId: 1, jobTypeId: 2, jobStatus: 'Completed' },
          summary: { id, jobNumber: '42', jobName: 'Leak repair', status: 'Completed', tagNames: ['Water Heater'], location: { city: 'Austin', state: 'TX', zip: '78701' } },
          attachments: [{ id: '1', fileName: 'repair.jpg', contentType: 'image/jpeg' }],
          history: [{ id: '1', source: 'note', type: 'Note', date: '', content: 'Repaired a leaking pipe.', promptEligible: true }],
        };
      },
    },
    wordpress: {} as Parameters<typeof createApp>[0]['wordpress'],
    companyWebsiteUrl: 'https://example.com',
    copyGenerator: { generate: async (source) => {
      generations++;
      generatedFacts = buildJobCopyFacts(source);
      return { title: 'Repair', bodyHtml: '<p>A documented repair in Austin addressed the leaking pipe.</p>', seoTitle: 'Leak repair in Austin', seoDescription: 'A documented plumbing repair in Austin addressed a leaking pipe in the home.' };
    } },
    spendJobToken: async (_action, operation) => { spent++; return operation(); },
  });
  const app = express();
  app.use((req, res, next) => {
    res.locals.actor = { isPlatformAdmin: req.get('X-Test-Actor') === 'admin' };
    res.locals.user = { isPlatformAdmin: true };
    next();
  });
  app.use(routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/jobs/42`;
  try {
    assert.equal((await fetch(`${url}/prompt-preview`)).status, 403);
    assert.equal((await fetch(`${url}/scanner-rating`, { method: 'POST' })).status, 403);
    assert.equal(reads, 0);
    const response = await fetch(`${url}/prompt-preview`, { headers: { 'X-Test-Actor': 'admin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const preview = await response.json() as { prompt: string };
    assert.match(preview.prompt, /Water Heater/);
    assert.equal(generations, 0);
    assert.equal(spent, 0);
    const ratingResponse = await fetch(`${url}/scanner-rating`, { method: 'POST', headers: { 'X-Test-Actor': 'admin' } });
    assert.equal(ratingResponse.status, 200);
    const rating = await ratingResponse.json() as { score: number; threshold: number; passesScore: boolean; skipReason: string };
    assert.equal(rating.score, 70);
    assert.equal(rating.threshold, 70);
    assert.equal(rating.passesScore, true);
    assert.match(rating.skipReason, /120 characters/);
    assert.equal(spent, 0);
    const generated = await fetch(`${url}/ai-copy`, { method: 'POST' });
    assert.equal(generated.status, 200);
    assert.equal(preview.prompt, `${JOB_COPY_INSTRUCTIONS}\nReturn the result using the supplied JSON schema.\n\n${generatedFacts}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

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
  const filename = `job-showcase-for-servicetitan-${REQUIRED_WORDPRESS_PLUGIN_VERSION}.zip`;
  await writeFile(archivePath, archive);

  const app = createApp({
    serviceTitan: {
      getJobs: async () => ({ data: [], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => { throw new Error('not used'); },
      getJobDetails: async () => { throw new Error('not used'); },
      getJobImage: async () => { throw new Error('not used'); },
    },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, installedVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, seoGeneratorVersion: SEO_GENERATOR_VERSION }),
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
    const response = await fetch(`http://127.0.0.1:${address.port}/downloads/${filename}`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/zip/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert((response.headers.get('content-disposition') || '').includes(filename));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);

    const removedSave = await fetch(`http://127.0.0.1:${address.port}/api/wordpress/plugin/download`, { method: 'POST' });
    assert.equal(removedSave.status, 404);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('regenerates fresh copy and passes an optional replacement image through the regeneration route', async () => {
  let requestedImage = '';
  let regeneratedWithImage = '';
  let regeneratedWithTitle = '';
  let regeneratedWithSeoDescription = '';
  let generatedFromJob = '';
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
    copyGenerator: { generate: async source => { generatedFromJob=source.jobName; return validCopy; } },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, installedVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, seoGeneratorVersion: SEO_GENERATOR_VERSION }),
      getStatuses: async () => ({}),
      getStatus: async () => ({ state: 'exists', label: 'Published', postId: 77 }),
      pushJob: async () => { throw new Error('not used'); },
      regenerateJob: async (_job, force, image, copy) => {
        assert.equal(force, false);
        regeneratedWithImage = image?.id || '';
        regeneratedWithTitle = copy?.title || '';
        regeneratedWithSeoDescription = copy?.seoDescription || '';
        assert.equal(copy?.seoTitle, validCopy.seoTitle);
        assert.equal(copy?.bodyHtml, validCopy.bodyHtml);
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
      body: JSON.stringify({ force: false, attachmentId: 'replacement_1', aiCopy: 'TITLE: Forged client title\nEXCERPT: Stale client text must not replace the generated copy.' }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestedImage, 'replacement_1');
    assert.equal(regeneratedWithImage, 'replacement_1');
    assert.equal(generatedFromJob, 'Plumbing Service');
    assert.equal(regeneratedWithTitle, validCopy.title);
    assert.equal(regeneratedWithSeoDescription, validCopy.seoDescription);
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
      getPluginStatus: async () => ({ state: 'current', requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, installedVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION, seoGeneratorVersion: SEO_GENERATOR_VERSION }),
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
          seoTitle: validCopy.seoTitle,
          seoDescription: validCopy.seoDescription,
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
      seoTitle: validCopy.seoTitle,
      seoDescription: validCopy.seoDescription,
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test('parses complete WordPress copy and rejects missing metadata or unsafe HTML', () => {
  const bodyHtml = '<p>The company completed water heater repair in Austin, Texas, after unreliable hot water was reported.</p>';
  const fullCopy = [
    'TITLE: Water Heater Repair in Austin, TX',
    'BODY:', bodyHtml,
    'SEO TITLE: Water Heater Repair in Austin',
    'SEO DESCRIPTION: A documented water heater repair in Austin addressed a reported hot water concern at the property.',
  ].join('\n');
  assert.deepEqual(parseApprovedPostCopy(fullCopy, true), {
    title: 'Water Heater Repair in Austin, TX', bodyHtml,
    seoTitle: 'Water Heater Repair in Austin',
    seoDescription: 'A documented water heater repair in Austin addressed a reported hot water concern at the property.',
  });
  assert.throws(() => parseApprovedPostCopy('A title without labeled fields', true), /Provide TITLE, BODY, SEO TITLE, and SEO DESCRIPTION/);
  assert.throws(() => parseApprovedPostCopy('TITLE: Water Heater Repair\nBODY:\n'+bodyHtml, true), /SEO TITLE/);
  assert.throws(() => parseApprovedPostCopy(fullCopy.replace('Water Heater Repair in Austin, TX','Bad'), true), /title must be between/);
  assert.throws(() => parseApprovedPostCopy(fullCopy.replace(bodyHtml,'<script>alert(1)</script>'), true), /body must use p tags/);
  assert.throws(() => parseApprovedPostCopy(fullCopy.replace(/SEO DESCRIPTION:[^\n]+/, 'SEO DESCRIPTION: Too short'), true), /SEO description must be between/);
});

test('all paid routes enforce the server token gate even with forged billing fields', async () => {
  const fullCopy = formatJobCopy(validCopy);

  const { HttpError } = await import('./saas/validation.js');
  const { DisabledWordPressClient } = await import('./wordpress.js');
  const actions: string[] = [];
  let imageUnavailable = false;
  const app = createApp({
    copyGenerator: { generate: async () => validCopy },
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
    assert.deepEqual(actions, ['ai_generation', 'build', 'update']);
    imageUnavailable = true;
    const failedPush = await fetch(`http://127.0.0.1:${address.port}/api/jobs/1/wordpress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentIds: ['image'], status: 'publish', aiCopy: fullCopy }),
    });
    assert.equal(failedPush.status, 502);
    assert.match((await failedPush.json()).error, /Image unavailable/);
    // The token callback and WordPress publishing are never reached when the image fails.
    assert.deepEqual(actions, ['ai_generation', 'build', 'update']);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});
