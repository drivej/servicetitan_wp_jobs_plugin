import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OpenAIJobCopyGenerator } from './openai.js';
import { buildJobCopyPrompt } from './job-copy-prompt.js';

const bodyHtml = '<p>The company completed water heater service in Torrance, California, after the customer reported unreliable hot water.</p><p>The technician reviewed the reported concern and evaluated the tankless water heater listed in the job record.</p><p>The documented service addressed the reported issue. Contact the company for help with water heater service in Torrance.</p>';

test('uses issue tags for sparse jobs without claiming undocumented repairs or discussing missing details', () => {
  const prompt = buildJobCopyPrompt({
    jobName: 'Plumbing',
    tagNames: ['Water Damage'],
    location: { city: 'Austin', state: 'TX', zip: '78701' },
  });
  assert.match(prompt, /JOB TAGS \(service\/issue context; not proof of actions or results\): Water Damage/);
  assert.match(prompt, /Tags can establish a service category or reported issue/);
  assert.match(prompt, /use more specific job facts when supported/);
  assert.match(prompt, /but not a cause, damage extent, repair, product installation, or result/);
  assert.match(prompt, /Omit missing parts of the story without calling attention to their absence/);
});

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
            status: 'ready', image_alt_texts: [], body_html: bodyHtml,
            seo_title: 'Water Heater Service in Torrance, CA',
            meta_description: 'Water heater service in Torrance addressed a homeowner hot water concern with technician work documented in the service record.',
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
    tagNames: ['Water Heater', '<b>Repair</b> contact@example.com'],
    location: { address: '123 Main St, Torrance, CA 90505', city: 'Torrance', state: 'CA', zip: '90505' },
  });

  assert.deepEqual(generated, {
    status: 'ready', imageAltTexts: [], imageFileNames: [],
    title: 'Water Heater Service in Torrance, CA',
    bodyHtml,
    seoTitle: 'Water Heater Service in Torrance, CA',
    seoDescription: 'Water heater service in Torrance addressed a homeowner hot water concern with technician work documented in the service record.',
  });
  assert.equal(requestBody?.model, 'test-model');
  assert.equal(requestBody?.store, false);
  assert.match(String(requestBody?.input), /Tankless water heater/);
  assert.match(String(requestBody?.input), /JOB TAGS .*Water Heater, Repair \[redacted\]/);
  assert.doesNotMatch(String(requestBody?.input), /contact@example.com|<b>/);
  assert.match(String(requestBody?.instructions), /Tags can establish a service category or reported issue/);
  assert.match(String(requestBody?.instructions), /Use short, connected paragraphs/);
  assert.match(String(requestBody?.instructions), /Exclude customer names, contact information, street addresses, access codes/);
  assert.match(String(requestBody?.instructions), /Aim for 400–600 words/);
  assert.match(String(requestBody?.instructions), /Use 2–4 descriptive <h2> headings/);
  assert.match(String(requestBody?.instructions), /Include local references or context only when explicitly requested/);
  assert.doesNotMatch(String(requestBody?.instructions), /home-service|homeowner-friendly|at most one/);
  assert.doesNotMatch(String(requestBody?.instructions), /Do not publish[^.]*ZIP code/);
  assert.equal(requestBody?.text, undefined);
  assert.match(String(requestBody?.instructions), /return only the literal text try your best/);
});

test('uses no reasoning for GPT-6 copy generation so short JSON completes reliably', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        title: 'Drain Clearing Service in Austin, TX',
        status: 'ready', image_alt_texts: [], body_html: bodyHtml,
        seo_title: 'Drain Clearing Service in Austin, TX',
        meta_description: 'Drain clearing service in Austin, Texas, addressed a documented drainage concern with professional service for the home.',
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
  assert.equal(requestBody?.max_output_tokens, 3_000);
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


test('preserves the literal fallback as a non-publishable result', async () => {
  const generator = new OpenAIJobCopyGenerator({ apiKey: 'test', model: 'test', apiBaseUrl: 'https://api.openai.test/v1' },
    (async () => Response.json({ output_text: 'try your best' })) as typeof fetch);
  await assert.rejects(generator.generate({ jobName: '', location: { city: '', state: '', zip: '' } }),
    (error: unknown) => error instanceof Error && error.message === 'try your best' && 'status' in error && error.status === 422);
});

test('requires one alt-text entry per supplied image and preserves image order', async () => {
  let altTexts = ['', ''];
  const generator = new OpenAIJobCopyGenerator({ apiKey: 'test', model: 'test', apiBaseUrl: 'https://api.openai.test/v1' },
    (async () => Response.json({ output_text: JSON.stringify({ status: 'ready', title: 'Project service in Rome',
      body_html: bodyHtml, seo_title: 'Project service in Rome',
      meta_description: 'A service project in Rome addressed the documented customer concern with work supported by the project information.',
      image_alt_texts: altTexts }) })) as typeof fetch);
  const source = { jobName: 'Service', location: { city: 'Rome', state: 'GA', zip: '' }, imageFileNames: ['first.jpg', 'second.jpg'] };
  const copy = await generator.generate(source);
  assert.deepEqual(copy.imageAltTexts, ['', '']);
  assert.deepEqual(copy.imageFileNames, source.imageFileNames);
  altTexts = [''];
  await assert.rejects(generator.generate(source), /incomplete project metadata/);
});
