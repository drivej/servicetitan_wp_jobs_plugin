import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAndDeploy, type BuildProviders } from './build-deploy.js';
import { BuildQueueWorker, FileBuildQueueStore } from './build-queue.js';
import { createApp } from './app.js';

function fixture() {
  const events: string[] = [];
  const summary = { id: 42, jobNumber: '42', jobName: 'Drain clearing', status: 'Completed', location: { city: 'Torrance', state: 'CA', zip: '90505' } };
  const providers: BuildProviders = {
    serviceTitan: {
      getJobs: async () => ({ data: [summary], page: 1, pageSize: 25, hasMore: false }),
      getJob: async () => summary,
      getJobDetails: async () => ({ job: { id: 42, jobNumber: '42', locationId: 2, jobTypeId: 3, jobStatus: 'Completed' }, summary, history: [], attachments: ['broken', 'first', 'second'].map((id) => ({ id, fileName: `${id}.jpg`, contentType: 'image/jpeg' })) }),
      getJobImage: async (_id, id) => {
        events.push(`image:${id}`);
        if (id === 'broken') throw new Error('Image unavailable');
        return { id, fileName: `${id}.jpg`, contentType: 'image/jpeg', bytes: new Uint8Array([1]) };
      },
    },
    copyGenerator: { generate: async () => {
      events.push('generate');
      return { title: 'Drain Clearing in Torrance, CA', bodyHtml: '<p>The company completed drain clearing in Torrance, California, to address a reported kitchen blockage.</p><p>The technician assessed the reported issue and identified the affected drain line.</p><p>The documented drain clearing addressed the reported blockage. Contact the company for drain service in Torrance.</p>' };
    } },
    wordpress: {
      getPluginStatus: async () => ({ state: 'current', requiredVersion: '1.18.1', seoGeneratorVersion: 6 }),
      getStatus: async () => ({ state: 'not_found', label: 'None' }), getStatuses: async () => ({}),
      pushJob: async (job, images, status, copy) => {
        assert.equal(job.id, 42); assert.equal(images.length, 1); assert.equal(images[0]?.id, 'first');
        assert.equal(status, 'draft'); assert(copy.bodyHtml); events.push('push:draft');
        return { state: 'exists', label: 'Draft', postStatus: 'draft', postId: 10 };
      },
      regenerateJob: async () => { throw new Error('Unexpected rebuild'); }, updateStatus: async () => { throw new Error('Unexpected status change'); },
    },
    spendJobToken: async (action, operation, jobId) => { assert.equal(jobId, 42); events.push(`spend:${action}`); return operation(); },
  };
  return { providers, events };
}

test('build generates validated copy, selects first usable image and pushes a draft with normal token accounting', async () => {
  const { providers, events } = fixture();
  assert.equal((await buildAndDeploy(42, providers)).postStatus, 'draft');
  assert.deepEqual(events, ['image:broken', 'image:first', 'spend:ai_generation', 'generate', 'spend:push', 'push:draft']);
});

test('missing images, existing posts, unknown status and invalid copy cannot publish', async () => {
  const { providers, events } = fixture();
  providers.serviceTitan.getJobImage = async () => { throw new Error('missing'); };
  await assert.rejects(buildAndDeploy(42, providers), /no available image/);
  assert.deepEqual(events, []);
  providers.wordpress.getStatus = async () => ({ state: 'exists', label: 'Published', postStatus: 'publish' });
  await assert.rejects(buildAndDeploy(42, providers), /already has/);
  providers.wordpress.getStatus = async () => ({ state: 'unknown', label: 'Unknown' });
  await assert.rejects(buildAndDeploy(42, providers), /Unable to verify/);
  const invalid = fixture();
  invalid.providers.copyGenerator.generate = async () => ({ title: 'Incomplete copy', bodyHtml: '<p>Short.</p>' });
  await assert.rejects(buildAndDeploy(42, invalid.providers), /3–5 short paragraphs/);
  assert(!invalid.events.includes('push:draft'));
});

test('accepted HTTP tasks persist and execute after the requesting server closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'build-queue-'));
  const path = join(directory, 'queue.json');
  const scope = { userId: 'local', workspaceId: 'local', websiteId: 'local' };
  const { providers, events } = fixture();
  const queue = new FileBuildQueueStore(path);
  const app = createApp({ ...providers, buildQueue: { enqueue: (id) => queue.enqueue(scope, id), list: (ids) => queue.list(scope, ids) } });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/jobs/42/build-deploy`;
    const [a, b] = await Promise.all([fetch(url, { method: 'POST' }), fetch(url, { method: 'POST' })]);
    assert.equal(a.status, 202); assert.equal(b.status, 202);
    assert.equal((await a.json()).id, (await b.json()).id);
    assert.deepEqual(events, []);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const restored = new FileBuildQueueStore(path);
    const worker = new BuildQueueWorker(restored, (task) => buildAndDeploy(task.jobId, providers));
    await worker.runOnce();
    assert.equal((await restored.list(scope, [42]))[0]?.state, 'succeeded');
    assert.equal((await restored.list(scope, [42]))[0]?.result?.postStatus, 'draft');
    await worker.runOnce();
    assert.equal(events.filter((event) => event === 'generate').length, 1);
    assert.deepEqual(await restored.list({ ...scope, websiteId: 'other' }, [42]), []);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker persists failures and continues with the next queued job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'build-failure-'));
  try {
    const queue = new FileBuildQueueStore(join(directory, 'queue.json'));
    const scope = { userId: 'local', workspaceId: 'local', websiteId: 'local' };
    await queue.enqueue(scope, 1); await queue.enqueue(scope, 2);
    const worker = new BuildQueueWorker(queue, async (task) => {
      if (task.jobId === 1) throw new Error('No available image');
      return { state: 'exists', label: 'Draft', postStatus: 'draft' };
    });
    await worker.runOnce(); await worker.runOnce();
    const tasks = await queue.list(scope, [1, 2]);
    assert.equal(tasks[0]?.state, 'failed'); assert.equal(tasks[0]?.error, 'No available image');
    assert.equal(tasks[1]?.state, 'succeeded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
