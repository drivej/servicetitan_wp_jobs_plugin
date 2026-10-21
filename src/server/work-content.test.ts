import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { completedFormFindings, invoiceWorkContent, safeWorkText } from './work-content.js';
import { getRecentFormContent } from './form-content-cache.js';
import { ServiceTitanClient } from './service-titan.js';
import { buildJobCopyFacts } from './job-copy-prompt.js';
import { minimizeJobDetails } from './saas/providers.js';

const config = () => ({ contentScope: randomUUID(), clientId: 'client', clientSecret: 'secret', appKey: 'key', tenantId: '123', apiBaseUrl: 'https://example.test', authUrl: 'https://example.test/token' });

test('invoice content is job-linked, bounded, deduplicated and excludes raw financial/customer fields', () => {
  const good = { job: { id: 42 }, summary: '<p>Replaced pump</p>', total: 900, customer: { name: 'Private Customer' }, items: [{ description: 'Pump replacement', price: 900 }, { description: 'Pump replacement' }, { description: 'Cancelled task', quantity: 0 }] };
  const content = invoiceWorkContent([good, good, { ...good, job: { id: 9 }, summary: 'Wrong job' }, { ...good, status: 'Voided', summary: 'Voided job' }, { ...good, isAdjustment: true, summary: 'Adjustment' }], 42);
  assert.deepEqual(content.invoiceSummaries, ['Replaced pump']);
  assert.deepEqual(content.invoiceWorkItems, ['Pump replacement']);
  assert(!JSON.stringify(content).includes('Private Customer'));
  assert(!JSON.stringify(content).includes('900'));
  const large = invoiceWorkContent([{ job: { id: 42 }, items: Array.from({ length: 100 }, (_, i) => ({ description: String(i) + 'x'.repeat(1000) })) }], 42);
  assert(large.invoiceWorkItems!.length <= 30);
  assert(large.invoiceWorkItems!.join('').length <= 8000);
  assert.equal(safeWorkText('Email a@example.com, call 555-123-4567 at 123 Main Street. $200'), 'Email [email removed], call [phone removed] at [address removed] [amount removed]');
});

test('forms require completed job ownership and actual supported answers', () => {
  const form = { status: 'Completed', owners: [{ type: 'Job', id: 42 }], units: [
    { type: 'Text', name: 'Work performed', value: 'Replaced leaking valve' },
    { type: 'Checkbox', name: 'Inspection findings', values: ['Leak detected'], options: 'Unselected: exploded boiler' },
    { type: 'Text', name: 'Customer name', value: 'Private Customer' },
    { type: 'Text', name: 'Access code', value: '1234' },
    { type: 'Text', name: 'Repair needed', value: '' },
    { type: 'Picture', name: 'Completed repair', attachments: [{ fileName: 'private.jpg' }] },
  ] };
  const findings = completedFormFindings([form, form, { ...form, status: 'Draft' }, { ...form, owners: [{ type: 'Location', id: 42 }] }], 42);
  assert.deepEqual(findings, [{ question: 'Work performed', answer: 'Replaced leaking valve' }, { question: 'Inspection findings', answer: 'Leak detected' }]);
  assert.deepEqual(completedFormFindings([{ ...form, owners: [{ type: 'Job', id: 9 }] }], 42), []);
});

test('form window coalesces requests, chooses latest completed form and isolates credentials/scopes', async () => {
  const settings = config(); let calls = 0;
  const make = (date: number, value: string) => ({ formId: 1, submittedOn: new Date(date).toISOString(), status: 'Completed', owners: [{ type: 'Job', id: 42 }], units: [{ type: 'Text', name: 'Work performed', value }] });
  const get = async () => { calls++; return { data: [make(Date.now()-2000, 'Old work'), make(Date.now()-1000, 'Latest work'), make(Date.now()-90*86400_000, 'Outdated work')], hasMore: false }; };
  const [a,b] = await Promise.all([getRecentFormContent(settings,42,get), getRecentFormContent(settings,42,get)]);
  assert.equal(calls, 1); assert.deepEqual(a,b);
  assert.deepEqual(a.formFindings, [{ question: 'Work performed', answer: 'Latest work' }]);
  assert.equal(a.contentSources?.[0]?.state, 'partial');
  assert.deepEqual((await getRecentFormContent(settings,9,get)).formFindings, []);
  await getRecentFormContent({ ...settings, clientSecret: 'rotated' },42,get); assert.equal(calls,2);
  await getRecentFormContent({ ...settings, contentScope: 'another-workspace' },42,get); assert.equal(calls,3);
  let pages = 0;
  await getRecentFormContent(config(),42,async () => { pages++; return { data: [], hasMore: true }; }); assert.equal(pages,3);
});

test('job details propagate safe enrichment through SaaS and prompts while optional errors degrade gracefully', async () => {
  let invoiceCalls = 0, formCalls = 0;
  const client = new ServiceTitanClient(config());
  Object.assign(client, { api: {
    post: async () => ({ data: { access_token: 'token', expires_in: 3600 } }),
    get: async (url: string) => {
      if (url.endsWith('/jobs/42')) return { data: { id: 42, locationId: 1, jobTypeId: 2, jobNumber: '42', jobStatus: 'Completed', summary: 'Original issue', summaryOfWork: 'Completed valve replacement' } };
      if (url.endsWith('/history')) return { data: { history: [] } };
      if (url.endsWith('/attachments') || url.endsWith('/notes')) return { data: { data: [] } };
      if (url.endsWith('/locations')) return { data: { data: [{ id: 1, address: { city: 'Rome', state: 'GA', zip: '30161' } }] } };
      if (url.endsWith('/job-types')) return { data: { data: [{ id: 2, name: 'Plumbing' }] } };
      if (url.endsWith('/invoices')) { invoiceCalls++; return { data: { data: [{ job: { id: 42 }, summary: 'Invoice narrative', items: [{ description: 'Valve replacement' }] }] } }; }
      if (url.endsWith('/submissions')) { formCalls++; throw { isAxiosError: true, response: { status: 403 } }; }
      throw new Error('Unexpected endpoint');
    },
  } });
  const details = minimizeJobDetails(await client.getJobDetails(42));
  assert.equal(details.summary.workSummary, 'Completed valve replacement');
  assert.deepEqual(details.summary.invoiceWorkItems, ['Valve replacement']);
  assert.equal(details.summary.contentSources?.find(s => s.source === 'forms')?.state, 'unavailable');
  const facts = buildJobCopyFacts(details.summary);
  assert.match(facts, /COMPLETION SUMMARY:\nCompleted valve replacement/);
  assert.match(facts, /Invoice narrative/); assert.match(facts, /Valve replacement/);
  await client.getJobDetails(42); assert.equal(invoiceCalls,1); assert.equal(formCalls,1);
});

test('copy enrichment has an aggregate prompt budget even with large inputs', () => {
  const facts = buildJobCopyFacts({ jobName: 'Repair', location: { city: 'Rome', state: 'GA', zip: '30161' }, workSummary: 'w'.repeat(5000), invoiceSummaries: ['i'.repeat(20000)], invoiceWorkItems: ['j'.repeat(20000)], formFindings: [{ question: 'Work performed', answer: 'f'.repeat(20000) }] });
  const count = (facts.match(/[wijf]/g) || []).length;
  assert(count < 12500);
});
