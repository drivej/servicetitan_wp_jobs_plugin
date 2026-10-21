import { createHash } from 'node:crypto';
import type { ServiceTitanConfig } from './config.js';
import type { WorkContent } from '../shared/work-content.js';
import { completedFormFindings, objectValue, recordList } from './work-content.js';

type GetPage = (params: Record<string, string | number>) => Promise<unknown>;
type FormIndex = { byJob: Map<number, NonNullable<WorkContent['formFindings']>>; unavailable: boolean };
const cache = new Map<string, { expiresAt: number; request: Promise<FormIndex> }>();

/** A small recent-window index shared by a workspace/integration, never a scan per job. */
export async function getRecentFormContent(config: ServiceTitanConfig, jobId: number, getPage: GetPage): Promise<WorkContent> {
  const key = createHash('sha256').update(JSON.stringify([config.contentScope || 'local', config.apiBaseUrl, config.tenantId, config.clientId, config.clientSecret, config.appKey])).digest('hex');
  for (const [id, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(id);
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= 10) cache.delete(cache.keys().next().value!);
    entry = { expiresAt: Date.now() + 5 * 60_000, request: loadWindow(getPage) };
    cache.set(key, entry);
  }
  const result = await entry.request;
  return { formFindings: result.byJob.get(jobId) || [], contentSources: [{ source: 'forms', state: result.unavailable ? 'unavailable' : 'partial', message: result.unavailable ? 'Optional form findings could not be loaded. Existing job sources remain available.' : 'Completed job-linked forms from a bounded 30-day window only; older forms and additional pages may be omitted.' }] };
}

async function loadWindow(getPage: GetPage): Promise<FormIndex> {
  const byJob: FormIndex['byJob'] = new Map();
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  try {
    const submissions: unknown[] = [];
    // At most 150 submissions, indexed once per five minutes per credential/scope.
    // Validate dates and owners locally even if the upstream ignores a filter.
    for (let page = 1; page <= 3; page++) {
      const body = objectValue(await getPage({ page, pageSize: 50, submittedOnOrAfter: cutoff }));
      if (!Array.isArray(body.data)) return { byJob, unavailable: true };
      submissions.push(...body.data.slice(0, 50));
      if (body.hasMore !== true) break;
    }
    const seenForms = new Set<string>();
    const newestFirst = recordList(submissions).sort((a, b) => Date.parse(String(b.submittedOn)) - Date.parse(String(a.submittedOn)));
    for (const record of newestFirst) {
      const timestamp = typeof record.submittedOn === 'string' ? Date.parse(record.submittedOn) : NaN;
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(cutoff) || timestamp > Date.now() || record.status !== 'Completed') continue;
      if (!Number.isSafeInteger(record.formId)) continue;
      const jobIds = recordList(record.owners).slice(0, 10).filter(owner => owner.type === 'Job' && Number.isSafeInteger(owner.id) && Number(owner.id) > 0).map(owner => Number(owner.id));
      for (const id of jobIds) {
        const versionKey = `${id}:${record.formId}`;
        if (seenForms.has(versionKey)) continue;
        seenForms.add(versionKey);
        const existing = byJob.get(id) || [];
        let remaining = 8000 - existing.reduce((size, finding) => size + finding.question.length + finding.answer.length, 0);
        const additions = completedFormFindings([record], id).filter(finding => { remaining -= finding.question.length + finding.answer.length; return remaining >= 0; });
        byJob.set(id, [...existing, ...additions].slice(0, 50));
      }
    }
    return { byJob, unavailable: false };
  } catch { return { byJob: new Map(), unavailable: true }; }
}
