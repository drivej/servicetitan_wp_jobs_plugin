import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WordPressConfig } from './config.js';
import type { JobImage, JobListItem } from './service-titan.js';
import { SEO_GENERATOR_VERSION, WordPressClient, serviceTitanJobSlug } from './wordpress.js';

const config: WordPressConfig = {
  collectionUrl: 'https://wordpress.example/wp-json/wp/v2/st_job',
  username: 'api-user',
  applicationPassword: 'application-password',
  postStatus: 'draft',
  zipAcfFieldName: 'my_zip_codes',
};

const job: JobListItem = {
  id: 123456,
  jobNumber: 'J-9000',
  jobName: 'Water Heater Repair',
  status: 'Completed',
  completedOn: '2026-09-10T18:30:00Z',
  location: { city: 'Austin', state: 'TX', zip: '78701' },
  seoDetails: { issue: 'a hot-water performance issue', action: 'targeted repairs' },
  equipmentNames: ['Bradford White Water Heater'],
};
const image: JobImage = {
  id: 'attachment-1',
  fileName: 'completed-job.jpg',
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
const approvedCopy = {
  title: 'Water Heater Repair in Austin, TX',
  bodyHtml: '<p>An Austin homeowner needed help with a documented hot-water performance issue.</p><p>The technician evaluated the reported concern involving the water heater.</p><p>The documented repair addressed the hot-water issue for this Austin property.</p>',
};

test('uses a stable ServiceTitan ID slug for correlation', () => {
  assert.equal(serviceTitanJobSlug(job.id), 'servicetitan-job-123456');
});

test('reports a missing WordPress post with the current SEO version', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ statuses: { '123456': { state: 'not_found', label: 'None' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const status = await client.getStatus(job.id);

  assert.deepEqual(status, { state: 'not_found', label: 'None', currentSeoVersion: SEO_GENERATOR_VERSION });
  assert.equal(requests[0]!.url, 'https://wordpress.example/wp-json/servicetitan-job-integration/v1/statuses');
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), { jobIds: [123456] });
});

test('detects the installed companion plugin version', async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.equal(String(input), 'https://wordpress.example/wp-json/servicetitan-job-integration/v1/status');
    return new Response(JSON.stringify({ version: '1.18.2' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new WordPressClient(config, mockFetch);

  assert.deepEqual(await client.getPluginStatus(), {
    state: 'current',
    requiredVersion: '1.18.2',
    installedVersion: '1.18.2',
    seoGeneratorVersion: SEO_GENERATOR_VERSION,
  });
});

test('syncs the configured ACF field and backfills missing ZIP location metadata', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ version: '1.18.2' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({ zipcodes: [
        { zipcode: '90712', city: '', state: '', latitude: null, longitude: null },
        { zipcode: '78701', city: 'Austin', state: 'TX', latitude: 30.2711, longitude: -97.7437 },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(
    { ...config, zipAcfFieldName: 'service_zip_codes' },
    mockFetch,
    { lookup: async (zipcode) => zipcode === '90712' ? {
      city: 'Lakewood',
      state: 'CA',
      latitude: 33.8471,
      longitude: -118.1222,
    } : undefined },
  );

  assert.equal((await client.getPluginStatus()).state, 'current');
  assert.equal(requests[1]!.url, 'https://wordpress.example/wp-json/servicetitan-job-integration/v1/zipcodes');
  assert.equal(requests[2]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[2]!.init?.body)), {
    acfFieldName: 'service_zip_codes',
    zipcodes: [{
      zipcode: '90712',
      city: 'Lakewood',
      state: 'CA',
      latitude: 33.8471,
      longitude: -118.1222,
    }],
  });
});

test('requires an update when the companion plugin status route is missing', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({
    code: 'rest_no_route',
    message: 'No route was found matching the URL and request method.',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const client = new WordPressClient(config, mockFetch);
  const status = await client.getPluginStatus();

  assert.equal(status.state, 'update_required');
  assert.equal(status.requiredVersion, '1.18.2');
});

test('loads multiple correlated post statuses in one plugin request', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({
      statuses: {
        '123456': {
          state: 'exists',
          label: 'Published',
          postId: 77,
          postStatus: 'publish',
          postTitle: 'Existing WordPress title',
          postExcerpt: 'Existing WordPress excerpt.',
          postModifiedOn: '2026-08-02T11:00:00',
          seoVersion: 1,
          seoModified: false,
        },
        '123457': { state: 'not_found', label: 'None' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const statuses = await client.getStatuses([123456, 123457]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://wordpress.example/wp-json/servicetitan-job-integration/v1/statuses');
  assert.equal(requests[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), { jobIds: [123456, 123457] });
  assert.equal(statuses[123456]?.postStatus, 'publish');
  assert.equal(statuses[123456]?.postTitle, 'Existing WordPress title');
  assert.equal(statuses[123456]?.postExcerpt, 'Existing WordPress excerpt.');
  assert.equal(statuses[123456]?.postModifiedOn, '2026-08-02T11:00:00');
  assert.equal(statuses[123456]?.seoState, 'outdated');
  assert.equal(statuses[123456]?.currentSeoVersion, SEO_GENERATOR_VERSION);
  assert.equal(statuses[123457]?.state, 'not_found');
});

test('uses the selected status and sets the selected image as featured', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    if (requests.length === 1) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (requests.length === 3) {
      return new Response(JSON.stringify({ id: 501 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 77,
      slug: 'servicetitan-job-123456',
      status: 'publish',
      link: 'https://wordpress.example/?post_type=st_job&p=77',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const status = await client.pushJob(job, [image], 'publish', approvedCopy);

  assert.equal(requests.length, 4);
  assert.equal(requests[1]!.init?.method, 'POST');
  const payload = JSON.parse(String(requests[1]!.init?.body)) as Record<string, string>;
  assert.equal(payload.slug, 'servicetitan-job-123456');
  assert.equal(payload.status, 'publish');
  assert.deepEqual(payload.stji_generation, { version: SEO_GENERATOR_VERSION, jobId: job.id });
  assert.equal(payload.title, 'Water Heater Repair in Austin, TX');
  assert.match(payload.content!, /hot-water performance issue/);
  assert.match(payload.content!, /The technician evaluated the reported concern/);
  assert.match(payload.content!, /<p>The documented repair addressed/);
  assert.doesNotMatch(payload.content!, /Need water heater repair|Contact our team|About water heater repair/i);
  assert.equal(payload.excerpt, approvedCopy.bodyHtml.replace(/<[^>]+>/g, '').slice(0, 320));
  assert.equal(payload.title, approvedCopy.title);
  assert.doesNotMatch(payload.content!, /J-9000|78701|ServiceTitan/);
  assert.equal(payload.stji_zipcode, '78701');
  assert.deepEqual(payload.stji_location, {
    acfFieldName: 'my_zip_codes',
    zipcodes: [{ zipcode: '78701', city: 'Austin', state: 'TX' }],
    completedOn: '2026-09-10T18:30:00Z',
  });
  assert.equal(requests[2]!.url, 'https://wordpress.example/wp-json/wp/v2/media?post=77');
  assert.equal((requests[2]!.init?.headers as Record<string, string>)['Content-Type'], 'image/jpeg');
  assert.match((requests[2]!.init?.headers as Record<string, string>)['Content-Disposition']!, /completed-job\.jpg/);
  assert.equal((requests[2]!.init?.headers as Record<string, string>)['X-STJI-Source-Attachment-ID'], image.id);
  assert.deepEqual(JSON.parse(String(requests[3]!.init?.body)), { featured_media: 501 });
  assert.deepEqual(status, {
    state: 'exists',
    label: 'Published',
    postId: 77,
    postStatus: 'publish',
    link: 'https://wordpress.example/?post_type=st_job&p=77',
    seoVersion: SEO_GENERATOR_VERSION,
    currentSeoVersion: SEO_GENERATOR_VERSION,
    seoState: 'current',
    featuredImageId: 501,
    featuredImageFileName: 'completed-job.jpg',
    featuredImageAttachmentId: 'attachment-1',
  });
});

test('requires exactly one selected image', async () => {
  const client = new WordPressClient(config, async () => {
    throw new Error('WordPress should not be called when image selection is invalid.');
  });

  await assert.rejects(
    () => client.pushJob(job, [], 'draft', approvedCopy),
    /Select exactly one job image/,
  );
  await assert.rejects(
    () => client.pushJob(job, [image, image], 'draft', approvedCopy),
    /Select exactly one job image/,
  );
});

test('refuses to push when the correlated post already exists', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
    id: 77,
    slug: 'servicetitan-job-123456',
    status: 'publish',
  }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const client = new WordPressClient(config, mockFetch);

  await assert.rejects(() => client.pushJob(job, [image], 'draft', approvedCopy), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 409);
    return true;
  });
});

test('updates the status of a correlated WordPress post', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ statuses: { '123456': {
        state: 'exists', label: 'Draft', postId: 77, postStatus: 'draft', seoVersion: SEO_GENERATOR_VERSION, seoModified: false,
      } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 77,
      slug: 'servicetitan-job-123456',
      status: 'publish',
      link: 'https://wordpress.example/jobs/servicetitan-job-123456',
      modified: '2026-09-11T10:15:00',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const status = await client.updateStatus(job.id, 'publish');

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.url, 'https://wordpress.example/wp-json/wp/v2/st_job/77');
  assert.equal(requests[1]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), { status: 'publish' });
  assert.equal(status.postStatus, 'publish');
  assert.equal(status.postModifiedOn, '2026-09-11T10:15:00');
  assert.equal(status.seoState, 'current');
});

test('preserves existing content when editing only title and excerpt on a current post', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ statuses: { '123456': {
        state: 'exists', label: 'Published', postId: 77, postStatus: 'publish', seoVersion: SEO_GENERATOR_VERSION, seoModified: false,
      } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 77, slug: 'servicetitan-job-123456', status: 'publish', link: 'https://wordpress.example/jobs/servicetitan-job-123456',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const titleAndExcerpt = { title: approvedCopy.title } as typeof approvedCopy;
  const status = await client.regenerateJob(job, false, undefined, titleAndExcerpt);

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.url, 'https://wordpress.example/wp-json/wp/v2/st_job/77');
  const payload = JSON.parse(String(requests[1]!.init?.body)) as Record<string, unknown>;
  assert.equal('status' in payload, false);
  assert.equal('featured_media' in payload, false);
  assert.equal(payload.title, titleAndExcerpt.title);
  assert.notEqual(payload.excerpt, '');
  assert.equal('content' in payload, false);
  assert.deepEqual(payload.stji_generation, { version: SEO_GENERATOR_VERSION, jobId: job.id });
  assert.equal(status.seoState, 'current');
});

test('requires complete AI copy before upgrading an outdated post', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ statuses: { '123456': {
    state: 'exists', label: 'Published', postId: 77, postStatus: 'publish', seoVersion: 5, seoModified: false,
  } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const client = new WordPressClient(config, mockFetch);

  await assert.rejects(
    () => client.regenerateJob(job, false, undefined, { title: approvedCopy.title }),
    /complete AI post copy/,
  );
});

test('replaces the featured image when one is selected during regeneration', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ statuses: { '123456': {
        state: 'exists', label: 'Published', postId: 77, postStatus: 'publish', seoVersion: 1, seoModified: false,
      } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({ id: 808 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 77, slug: 'servicetitan-job-123456', status: 'publish', link: 'https://wordpress.example/jobs/servicetitan-job-123456',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);
  const status = await client.regenerateJob(job, false, image, approvedCopy);

  assert.equal(requests.length, 3);
  assert.equal(requests[1]!.url, 'https://wordpress.example/wp-json/wp/v2/media?post=77');
  assert.match((requests[1]!.init?.headers as Record<string, string>)['Content-Disposition']!, /completed-job\.jpg/);
  assert.equal(requests[2]!.url, 'https://wordpress.example/wp-json/wp/v2/st_job/77');
  const payload = JSON.parse(String(requests[2]!.init?.body)) as Record<string, unknown>;
  assert.equal(payload.featured_media, 808);
  assert.equal(payload.excerpt, approvedCopy.bodyHtml.replace(/<[^>]+>/g, '').slice(0, 320));
  assert.equal(payload.title, approvedCopy.title);
  assert.equal(status.featuredImageId, 808);
  assert.equal(status.featuredImageAttachmentId, image.id);
  assert.equal('status' in payload, false);
  assert.equal(status.seoState, 'current');
});

test('requires explicit force before replacing manually edited generated content', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ statuses: { '123456': {
      state: 'exists', label: 'Published', postId: 77, postStatus: 'publish', seoVersion: SEO_GENERATOR_VERSION, seoModified: true,
    } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new WordPressClient(config, mockFetch);

  await assert.rejects(() => client.regenerateJob(job, false), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 409);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('maps connection failures to an unknown, non-pushable status', async () => {
  const mockFetch: typeof fetch = async () => { throw new Error('offline'); };
  const client = new WordPressClient(config, mockFetch);
  const status = await client.getStatus(job.id);

  assert.equal(status.state, 'unknown');
  assert.match(status.message || '', /connection failed/i);
});
