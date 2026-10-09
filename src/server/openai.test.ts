import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OpenAIJobCopyGenerator } from './openai.js';

const bodyHtml = '<p>The company completed water heater service in Torrance, California, after the customer reported unreliable hot water.</p><p>The technician reviewed the reported concern and evaluated the tankless water heater listed in the job record.</p><p>The documented service addressed the reported issue. Contact the company for help with water heater service in Torrance.</p>';

test('generates structured job copy with the Responses API', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            title: 'Water Heater Service in Torrance, CA',
            bodyHtml,
          }),
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const generator = new OpenAIJobCopyGenerator({
    apiKey: 'test-key',
    model: 'test-model',
    apiBaseUrl: 'https://api.openai.test/v1',
  }, fetchImplementation);
  const generated = await generator.generate({
    jobName: 'Water Heater Service',
    summaryText: 'Customer reported unreliable hot water.',
    equipmentNames: ['Tankless water heater'],
    location: { address: '123 Main St, Torrance, CA 90505', city: 'Torrance', state: 'CA', zip: '90505' },
  });

  assert.deepEqual(generated, {
    title: 'Water Heater Service in Torrance, CA',
    bodyHtml,
  });
  assert.equal(requestBody?.model, 'test-model');
  assert.equal(requestBody?.store, false);
  assert.match(String(requestBody?.input), /Tankless water heater/);
  assert.match(String(requestBody?.instructions), /3–5 short paragraphs/);
  assert.match(String(requestBody?.instructions), /Exclude customer contact information, street addresses, access codes/);
  assert.doesNotMatch(String(requestBody?.instructions), /Do not publish[^.]*ZIP code/);
  assert.equal((requestBody?.text as { format?: { type?: string } })?.format?.type, 'json_schema');
});

test('uses no reasoning for GPT-6 copy generation so short JSON completes reliably', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        title: 'Drain Clearing Service in Austin, TX',
        bodyHtml,
      }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const generator = new OpenAIJobCopyGenerator({
    apiKey: 'test-key',
    model: 'gpt-6-luna',
    apiBaseUrl: 'https://api.openai.test/v1',
  }, fetchImplementation);

  await generator.generate({ jobName: 'Drain Clearing', location: { city: 'Austin', state: 'TX', zip: '78701' } });

  assert.deepEqual(requestBody?.reasoning, { effort: 'none' });
  assert.equal(requestBody?.max_output_tokens, 2_000);
});

test('returns a safe message when OpenAI rejects the API key', async () => {
  const fetchImplementation = (async () => new Response(JSON.stringify({
    error: { message: 'Secret upstream detail' },
  }), { status: 401, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const generator = new OpenAIJobCopyGenerator({
    apiKey: 'invalid-key',
    model: 'test-model',
    apiBaseUrl: 'https://api.openai.test/v1',
  }, fetchImplementation);

  await assert.rejects(
    generator.generate({ jobName: 'Plumbing Service', location: { city: 'Austin', state: 'TX', zip: '78701' } }),
    /Check OPENAI_API_KEY and project access/,
  );
});
