// Read-only access diagnostic. Outputs metadata only, never records or credentials.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
const env = parse(readFileSync('.env'));
const production = env.ST_ENVIRONMENT === 'production';
const base = production ? 'https://api.servicetitan.io' : 'https://api-integration.servicetitan.io';
const auth = production ? 'https://auth.servicetitan.io/connect/token' : 'https://auth-integration.servicetitan.io/connect/token';
const tenant = encodeURIComponent(env.ST_TENANT_ID || '');
const shape = (value, depth = 0) => depth > 6 ? typeof value : value === null ? 'null' : Array.isArray(value) ? { count: value.length, sample: value.length ? shape(value[0], depth + 1) : null } : typeof value === 'object' ? Object.fromEntries(Object.entries(value).slice(0, 35).map(([key, child]) => [key, shape(child, depth + 1)])) : typeof value;
const report = { checkedAt: new Date().toISOString(), environment: production ? 'production' : 'integration', credentialSource: '.env (not verified against saved SaaS connections)', checks: [] };
const request = async (url, init) => { try { return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch { return undefined; } };
const tokenResponse = await request(auth, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.ST_CLIENT_ID || '', client_secret: env.ST_CLIENT_SECRET || '' }) });
report.checks.push({ api: 'Authentication', status: tokenResponse?.status ?? 'network_or_timeout' });
if (!tokenResponse?.ok) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; }
else {
  const token = (await tokenResponse.json()).access_token;
  if (!token) throw new Error('Authentication returned no access token.');
  const get = async (api, path, params = {}, describe = () => ({})) => {
    const url = new URL(`${base}/${path}`); Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,String(v)));
    const response = await request(url, { headers: { Authorization: `Bearer ${token}`, 'ST-App-Key': env.ST_APP_KEY || '' } });
    const row = { api, status: response?.status ?? 'network_or_timeout' }; report.checks.push(row);
    if (!response?.ok) return;
    let body; try { body = await response.json(); } catch { row.invalidJson = true; return; }
    const records = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : undefined;
    if (records) row.recordsReturned = records.length;
    Object.assign(row, describe(body, records));
    return body;
  };
  const jobs = await get('Completed jobs sample', `jpm/v2/tenant/${tenant}/jobs`, { page: 1, pageSize: 3, jobStatus: 'Completed', sort: '-modifiedOn' });
  const samples = (jobs?.data || []).filter(j => Number.isSafeInteger(j.id) && j.id > 0).slice(0,3);
  for (const [index, job] of samples.entries()) {
    await get(`Job details sample ${index+1}`, `jpm/v2/tenant/${tenant}/jobs/${job.id}`, {}, body => ({ summaryOfWorkPresent: Object.hasOwn(body,'summaryOfWork'), summaryOfWorkNonempty: typeof body.summaryOfWork === 'string' && !!body.summaryOfWork.trim(), summaryNonempty: typeof body.summary === 'string' && !!body.summary.trim(), hasInvoiceId: Number.isSafeInteger(body.invoiceId) }));
    await get(`Invoices for sample ${index+1}`, `accounting/v2/tenant/${tenant}/invoices`, { jobId: job.id, page: 1, pageSize: 1 }, (_body, records) => ({ jobLinkMatches: records?.every(r => (r.job?.id ?? r.jobId) === job.id) ?? false, summaryNonempty: records?.some(r => typeof r.summary === 'string' && !!r.summary.trim()) || false, hasItems: records?.some(r => Array.isArray(r.items) && r.items.length > 0) || false, hasItemDescriptions: records?.some(r => r.items?.some(i => typeof i.description === 'string' && !!i.description.trim())) || false }));
  }
  if (!samples.length) await get('Invoices access (no sample job)', `accounting/v2/tenant/${tenant}/invoices`, { page: 1, pageSize: 1 });
  await get('Forms definitions', `forms/v2/tenant/${tenant}/forms`, { page: 1, pageSize: 1 }, (_body, records) => ({ recordShape: records?.[0] ? shape(records[0]) : null }));
  await get('Form submissions', `forms/v2/tenant/${tenant}/submissions`, { page: 1, pageSize: 1 }, (_body, records) => ({ recordShape: records?.[0] ? shape(records[0]) : null }));
  console.log(JSON.stringify(report, null, 2));
}
