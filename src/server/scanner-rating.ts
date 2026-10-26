import type { JobDetails } from './service-titan.js';
import type { JobScorer } from './job-scorer.js';

export function scannerSource(details: JobDetails) {
  return { ...details.summary, technicianNotes: details.history.filter(item => item.promptEligible).map(item => item.content) };
}
export function scannerSkipReason(details: JobDetails): string | undefined {
  const source = scannerSource(details);
  const content = [source.workSummary, source.summaryText, ...(source.invoiceSummaries || []), ...(source.invoiceWorkItems || []), ...(source.formFindings || []).map(item => item.answer), ...source.technicianNotes].filter(Boolean).join(' ');
  if (content.length < 120) return 'The scanner skips this job because it has fewer than 120 characters of documented work.';
  if (!details.attachments.length) return 'The scanner skips this job because it has no attachments.';
  return undefined;
}
export const rateScannerJob = (details: JobDetails, scorer: JobScorer) => scorer.rate(scannerSource(details));
