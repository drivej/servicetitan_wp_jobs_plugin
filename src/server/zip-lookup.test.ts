import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZippopotamClient } from './zip-lookup.js';

test('resolves and caches city, state, and coordinates by ZIP through Zippopotam.us', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({
      'post code': '90712',
      places: [{
        'place name': 'Lakewood',
        state: 'California',
        'state abbreviation': 'CA',
        latitude: '33.8471',
        longitude: '-118.1222',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' }, mockFetch);

  assert.deepEqual(await client.lookup('90712'), {
    city: 'Lakewood',
    state: 'CA',
    latitude: 33.8471,
    longitude: -118.1222,
  });
  assert.equal(requests[0]!.url, 'https://api.zippopotam.us/us/90712');
  assert.equal((requests[0]!.init?.headers as Record<string, string>).Accept, 'application/json');
  assert.deepEqual(await client.lookup('90712'), {
    city: 'Lakewood',
    state: 'CA',
    latitude: 33.8471,
    longitude: -118.1222,
  });
  assert.equal(requests.length, 1);
});

test('keeps place data but rejects incomplete or out-of-range coordinates', async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({
    places: [{
      'place name': 'Lakewood',
      'state abbreviation': 'CA',
      latitude: '91',
      longitude: '-118.1222',
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const client = new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' }, mockFetch);

  assert.deepEqual(await client.lookup('90712'), { city: 'Lakewood', state: 'CA' });
});

test('returns no place for invalid or unknown ZIP codes', async () => {
  let requests = 0;
  const mockFetch: typeof fetch = async () => {
    requests += 1;
    return new Response(null, { status: 404 });
  };
  const client = new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' }, mockFetch);

  assert.equal(await client.lookup('invalid'), undefined);
  assert.equal(requests, 0);
  assert.equal(await client.lookup('00000'), undefined);
  assert.equal(requests, 1);
});
