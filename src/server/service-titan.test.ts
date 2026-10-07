import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareHistoryItems, ServiceTitanClient } from './service-titan.js';
import { filterJobsByLocationIds, serviceTitanJobsListParams } from './service-titan-query.js';

test('requests only completed ServiceTitan jobs before pagination', () => {
  assert.deepEqual(serviceTitanJobsListParams({
    startDate: '2026-08-01T00:00:00.000Z',
    endDateExclusive: '2026-08-08T00:00:00.000Z',
    page: 2,
    pageSize: 25,
  }), {
    firstAppointmentStartsOnOrAfter: '2026-08-01T00:00:00.000Z',
    firstAppointmentStartsBefore: '2026-08-08T00:00:00.000Z',
    jobStatus: 'Completed',
    page: 2,
    pageSize: 25,
    includeTotal: true,
  });
});

test('keeps only jobs assigned to locations resolved for the ZIP code', () => {
  const jobs = [
    { id: 1, locationId: 1029384 },
    { id: 2, locationId: 9000000 },
    { id: 3, locationId: 1029385 },
  ];

  assert.deepEqual(
    filterJobsByLocationIds(jobs, new Set([1029384, 1029385])),
    [jobs[0], jobs[2]],
  );
});

test('filters ZIP matches before paginating and reports ZIP-specific counts', async () => {
  const calls: Array<{ url: string; params?: Record<string, unknown> }> = [];
  const client = new ServiceTitanClient({
    clientId: 'client-id', clientSecret: 'client-secret', appKey: 'app-key', tenantId: 'tenant-id',
    apiBaseUrl: 'https://api.example', authUrl: 'https://auth.example/token',
  });
  const api = {
    defaults: { timeout: 0 },
    post: async () => ({ data: { access_token: 'token', expires_in: 3600 } }),
    get: async (url: string, options?: { params?: Record<string, unknown> }) => {
      calls.push({ url, params: options?.params });
      if (url.endsWith('/jobs')) {
        const page = Number(options?.params?.page);
        return { data: page === 1 ? {
          page, pageSize: 500, hasMore: true, totalCount: 3,
          data: [
            { id: 1, locationId: 100, jobTypeId: 20, jobNumber: 'J-1', jobStatus: 'Completed' },
            { id: 2, locationId: 200, jobTypeId: 20, jobNumber: 'J-2', jobStatus: 'Completed' },
          ],
        } : {
          page, pageSize: 500, hasMore: false, totalCount: 3,
          data: [{ id: 3, locationId: 100, jobTypeId: 20, jobNumber: 'J-3', jobStatus: 'Completed' }],
        } };
      }
      if (url.endsWith('/locations')) {
        if (options?.params?.zip) return { data: { page: 1, pageSize: 500, hasMore: false, data: [{ id: 100 }] } };
        return { data: { data: [{ id: 100, address: { city: 'Austin', state: 'TX', zip: '78701' } }] } };
      }
      if (url.endsWith('/job-types')) return { data: { data: [{ id: 20, name: 'Repair' }] } };
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
  (client as unknown as { api: typeof api }).api = api;

  const query = {
    startDate: '2026-08-01T00:00:00.000Z', endDateExclusive: '2026-08-08T00:00:00.000Z',
    page: 1, pageSize: 1, zip: '78701',
  };
  const first = await client.getJobs(query);
  const second = await client.getJobs({ ...query, page: 2 });

  assert.deepEqual(first.data.map((job) => job.id), [1]);
  assert.equal(first.totalCount, undefined, 'ZIP totals are not fetched by scanning every matching job');
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.data.map((job) => job.id), [3]);
  assert.equal(second.totalCount, undefined);
  assert.equal(second.hasMore, false);
  const jobListCalls = calls.filter((call) => call.url.endsWith('/jobs'));
  assert.equal(jobListCalls.length, 4, 'each page scans only through its next-match lookahead');
  assert.ok(jobListCalls.every((call) => call.params?.pageSize === 500));
  assert.equal(calls.filter((call) => call.url.endsWith('/locations') && call.params?.zip).length, 1, 'ZIP location IDs are cached across page requests');
});

test('lists jobs without downloading images and securely downloads verified job images from details', async () => {
  const requestedUrls: string[] = [];
  const client = new ServiceTitanClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appKey: 'app-key',
    tenantId: 'tenant-id',
    apiBaseUrl: 'https://api.example',
    authUrl: 'https://auth.example/token',
  });
  const api = {
    defaults: { timeout: 0 },
    post: async () => ({ data: { access_token: 'token', expires_in: 3600 } }),
    get: async (url: string) => {
      requestedUrls.push(url);
      if (url.endsWith('/jobs')) return { data: {
        page: 1,
        pageSize: 50,
        hasMore: false,
        data: [
          { id: 1, jobNumber: 'J-1', locationId: 10, jobTypeId: 20, jobStatus: 'Completed' },
          { id: 2, jobNumber: 'J-2', locationId: 11, jobTypeId: 21, jobStatus: 'Completed', summary: 'Repaired leaking pipe.' },
        ],
      } };
      if (url.endsWith('/jobs/1/attachments')) return { data: { data: [{ id: 'pdf-1', fileName: 'invoice.pdf', contentType: 'application/pdf' }] } };
      if (url.endsWith('/jobs/2/attachments')) return { data: { data: [{ id: 'image-2', fileName: 'completed.jpg', contentType: 'image/jpeg' }] } };
      if (url.endsWith('/jobs/2/history')) return { data: { history: [
        { id: 1, eventType: 'File uploaded', date: '2026-08-01T09:00:00Z', memo: 'Technician uploaded a completed installation photograph.' },
        { id: 2, eventType: 'Work update', date: '2026-08-02T10:00:00Z', memo: 'Diagnosed a leaking supply line behind the water heater.' },
      ] } };
      if (url.endsWith('/jobs/2/notes')) return { data: {
        page: 1,
        pageSize: 50,
        hasMore: false,
        data: [{ text: 'Replaced the damaged line and verified normal operation.', createdOn: '2026-08-03T11:00:00Z', modifiedOn: '2026-08-03T11:00:00Z', isPinned: false }],
      } };
      if (url.endsWith('/jobs/2')) return { data: { id: 2, jobNumber: 'J-2', locationId: 11, jobTypeId: 21, jobStatus: 'Completed', summary: 'Repaired leaking pipe.', equipmentIds: [31] } };
      if (url.endsWith('/jobs/attachment/image-2')) return {
        data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
        headers: { 'content-type': 'image/jpeg' },
      };
      if (url.endsWith('/locations')) return { data: { data: [
        { id: 10, address: { city: 'One', state: 'TX', zip: '75001' } },
        { id: 11, address: { street: '123 Main St', unit: 'Suite 2', city: 'Two', state: 'TX', zip: '75002' } },
      ] } };
      if (url.endsWith('/job-types')) return { data: { data: [
        { id: 20, name: 'Inspection' },
        { id: 21, name: 'Pipe Repair' },
      ] } };
      if (url.endsWith('/installed-equipment')) return { data: { data: [
        { id: 31, name: 'Bradford White Water Heater' },
      ] } };
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
  (client as unknown as { api: typeof api }).api = api;

  const jobs = await client.getJobs({
    startDate: '2026-08-01T00:00:00.000Z',
    endDateExclusive: '2026-08-08T00:00:00.000Z',
    page: 1,
    pageSize: 25,
  });
  assert.deepEqual(jobs.data.map((job) => job.id), [1, 2]);
  assert.equal(jobs.totalCount, undefined);
  assert.deepEqual(jobs.data.map((job) => job.attachments), [[], []]);
  assert.equal(jobs.data[0]?.sourceCopyStatus, 'missing');
  assert.equal(jobs.data[1]?.sourceCopyStatus, 'limited');
  assert.equal(jobs.data[1]?.summaryText, undefined, 'source assessment must not expose the raw summary');
  assert.equal(jobs.data[1]?.location.address, undefined, 'street addresses must not be exposed in the list response');
  assert.equal(requestedUrls.some((url) => url.includes('/jobs/attachment/')), false, 'list filtering must use metadata only');

  const details = await client.getJobDetails(2);
  assert.equal(details.job.id, 2);
  assert.deepEqual(details.attachments, [{ id: 'image-2', fileName: 'completed.jpg', contentType: 'image/jpeg' }]);
  assert.deepEqual(details.history.map((item) => item.content), [
    'Diagnosed a leaking supply line behind the water heater.',
    'Replaced the damaged line and verified normal operation.',
  ]);
  assert.deepEqual(details.summary.equipmentNames, ['Bradford White Water Heater']);
  assert.equal(details.summary.summaryText, 'Repaired leaking pipe.');
  assert.equal(details.summary.location.address, '123 Main St, Suite 2, Two, TX, 75002');
  const image = await client.getJobImage(2, 'image-2');
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.bytes.byteLength, 4);
});

test('keeps system events visible while excluding attachments and unsafe or low-value prompt content', () => {
  const items = prepareHistoryItems([
    { id: 1, eventType: 'Status', date: '2026-08-03T10:00:00Z', memo: 'Job was completed.' },
    { id: 2, eventType: 'Attachment', date: '2026-08-02T10:00:00Z', memo: 'Uploaded the final equipment photograph for this completed job.' },
    { id: 3, eventType: 'Technician note', date: '2026-08-04T10:00:00Z', memo: 'Call 555-123-4567 after replacing the failed blower motor and testing airflow.' },
  ], [
    { text: 'Found restricted airflow caused by a heavily clogged return filter.', createdOn: '2026-08-01T10:00:00Z', modifiedOn: '2026-08-01T10:00:00Z' },
    { text: 'Found restricted airflow caused by a heavily clogged return filter.', createdOn: '2026-08-01T10:00:00Z', modifiedOn: '2026-08-01T10:00:00Z' },
    { text: 'Done.', createdOn: '2026-08-05T10:00:00Z', modifiedOn: '2026-08-05T10:00:00Z' },
  ]);

  assert.equal(items.length, 3);
  assert.equal(items[0]?.source, 'note');
  assert.equal(items[1]?.content, 'Job was completed.');
  assert.equal(items[1]?.promptEligible, false);
  assert.match(items[2]?.content || '', /\[phone removed\]/);
  assert.equal(items[2]?.promptEligible, true);
});

function redirectedImageClient(location: string, imageFetch: typeof fetch) {
  const client = new ServiceTitanClient({ clientId: 'client', clientSecret: 'secret', appKey: 'app-key', tenantId: 'tenant', apiBaseUrl: 'https://api.example', authUrl: 'https://auth.example' }, imageFetch);
  const requests: string[] = [];
  (client as any).api = {
    post: async () => ({ data: { access_token: 'private-token', expires_in: 3600 } }),
    get: async (url: string, options: any) => {
      requests.push(url);
      if (url.endsWith('/attachments')) return { data: [{ id: 'photo', fileName: 'photo.jpg' }] };
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      assert.equal(options.validateStatus(302), true);
      assert.equal(options.validateStatus(301), false);
      return { status: 302, headers: { location }, data: new ArrayBuffer(0) };
    },
  };
  return { client, requests };
}
const signedImageUrl = 'https://titanblobs.blob.core.windows.net/container/photo.jpg?sig=secret';

test('downloads a signed storage redirect without forwarding ServiceTitan credentials', async () => {
  const { client } = redirectedImageClient(signedImageUrl, async (url, init) => {
    assert.equal(String(url), signedImageUrl);
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });
  });
  const image = await client.getJobImage(1, 'photo');
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.bytes.length, 4);
});

test('rejects unsafe storage destinations before issuing any request', async () => {
  for (const url of ['', 'http://titanblobs.blob.core.windows.net/a', 'https://127.0.0.1/a', 'https://example.com/a', 'https://titanblobs.blob.core.windows.net.evil.example/a', 'https://user:password@titanblobs.blob.core.windows.net/a', 'https://titanblobs.blob.core.windows.net:8443/a']) {
    const { client } = redirectedImageClient(url, async () => { assert.fail('must not fetch'); });
    await assert.rejects(client.getJobImage(1, 'photo'), /image storage could not complete/);
  }
});

test('checks job ownership before following a download redirect', async () => {
  const { client, requests } = redirectedImageClient(signedImageUrl, async () => { assert.fail('must not fetch'); });
  await assert.rejects(client.getJobImage(1, 'someone-elses-photo'), /not found/);
  assert.equal(requests.length, 1);
});

test('rejects empty, oversized, and non-image storage responses', async () => {
  for (const response of [
    new Response(new Uint8Array(), { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response('small', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(16 * 1024 * 1024) } }),
    new Response(new Uint8Array(15 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('missing', { status: 404 }),
    new Response(null, { status: 302, headers: { Location: 'http://localhost' } }),
  ]) {
    const { client } = redirectedImageClient(signedImageUrl, async () => response);
    await assert.rejects(client.getJobImage(1, 'photo'), /larger than 15 MB|unsupported image|image storage could not complete/);
  }
});

test('does not expose signed URL credentials in download errors', async () => {
  const { client } = redirectedImageClient(signedImageUrl, async () => { throw new Error(`failed ${signedImageUrl}`); });
  await assert.rejects(client.getJobImage(1, 'photo'), (error: Error) => {
    assert.equal(error.message.includes('sig='), false);
    assert.equal(error.message, 'ServiceTitan image storage could not complete the download.');
    return true;
  });
});

test('detects JPEG bytes in Azure octet-stream responses without trusting the filename', async () => {
  const { client } = redirectedImageClient(signedImageUrl, async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'Content-Type': 'application/octet-stream' } }));
  assert.equal((await client.getJobImage(1, 'photo')).contentType, 'image/jpeg');
  const { client: invalid } = redirectedImageClient(signedImageUrl, async () => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'application/octet-stream' } }));
  await assert.rejects(invalid.getJobImage(1, 'photo'), /unsupported image/);
});
