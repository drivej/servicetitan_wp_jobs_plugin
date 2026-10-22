import type { WorkContent } from '../shared/work-content.js';

type RecordValue = Record<string, unknown>;
export const objectValue = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const recordList = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(objectValue) : [];

/** Allowlisted source text only. Never pass entire financial/customer records to copy generation. */
export const safeWorkText = (value: unknown, max = 1000): string => typeof value !== 'string' ? '' : value
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
  .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone removed]')
  .replace(/https?:\/\/\S+/gi, '[link removed]')
  .replace(/\b\d{1,6}\s+(?:[A-Za-z0-9.-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd)\b\.?/gi, '[address removed]')
  .replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, '[amount removed]')
  .replace(/\s+/g, ' ').trim().slice(0, max);

export function invoiceWorkContent(invoices: unknown[], jobId: number): WorkContent {
  const summaries = new Set<string>(), items = new Set<string>();
  let remaining = 8000;
  const add = (set: Set<string>, value: unknown) => {
    const text = safeWorkText(value, Math.min(1000, remaining));
    if (!text || set.has(text) || remaining === 0) return;
    set.add(text); remaining -= text.length;
  };
  for (const raw of invoices) {
    const invoice = objectValue(raw);
    if ((objectValue(invoice.job).id ?? invoice.jobId) !== jobId) continue;
    const status = String(invoice.status ?? '').toLowerCase();
    if (/void|cancel|deleted|adjustment/.test(status) || invoice.isAdjustment === true || invoice.isVoided === true || Number(invoice.adjustmentToId || 0) > 0) continue;
    add(summaries, invoice.summary);
    for (const item of recordList(invoice.items)) {
      if (items.size >= 30) break;
      if (typeof item.quantity === 'number' && item.quantity <= 0) continue;
      add(items, item.description);
    }
  }
  return { invoiceSummaries: [...summaries], invoiceWorkItems: [...items] };
}

/** Verified native form units only; a location/customer match is never sufficient. */
export function completedFormFindings(submissions: unknown[], jobId: number): NonNullable<WorkContent['formFindings']> {
  const findings: NonNullable<WorkContent['formFindings']> = [];
  const seen = new Set<string>();
  let remaining = 8000;
  for (const raw of submissions) {
    const submission = objectValue(raw);
    if (submission.status !== 'Completed' || !recordList(submission.owners).some(owner => owner.type === 'Job' && owner.id === jobId)) continue;
    for (const unit of recordList(submission.units)) {
      if (findings.length >= 50 || remaining <= 0) return findings;
      const question = safeWorkText(unit.name, 200);
      // Personal/signature/access/billing questions are not publishable work findings.
      if (!question || /customer|client|name|address|email|phone|signature|payment|price|amount|balance|access code|gate code|alarm|password/i.test(question)) continue;
      if (!/work|repair|service|issue|problem|diagnos|finding|observ|inspect|condition|measure|pressure|temperature|install|replace|test|result|action|note|comment|equipment|system|material|perform/i.test(question)) continue;
      const value = unit.type === 'Text' ? unit.value : unit.type === 'Checkbox' ? (Array.isArray(unit.values) ? unit.values.filter((value): value is string => typeof value === 'string').slice(0, 10).join(', ') : '') : '';
      if (remaining <= question.length) return findings;
      const answer = safeWorkText(value, Math.min(1000, remaining - question.length));
      if (!answer) continue;
      const key = `${question.toLowerCase()}:${answer.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key); findings.push({ question, answer }); remaining -= question.length + answer.length;
    }
  }
  return findings;
}

/** Compact literal excerpt, preferring a verified invoice summary; no AI inference. */
export function jobDescriptionPreview(job: Record<string, unknown>): string {
  const text = safeWorkText(job.invoiceSummary, 2000) || safeWorkText(job.summaryOfWork, 2000) || safeWorkText(job.summary, 2000);
  if (text.length <= 160) return text;
  const segment = text.slice(0, 160);
  const boundary = segment.lastIndexOf(' ');
  return `${segment.slice(0, boundary >= 100 ? boundary : 160).trimEnd()}…`;
}
