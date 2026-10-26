import type { JobDetails } from './service-titan.js';
import type { JobScorer } from './job-scorer.js';

export function scannerSource(details: JobDetails) {
  return { ...details.summary, technicianNotes: details.history.filter(item => item.promptEligible).map(item => item.content) };
}
export function scannerSkipReason(details: JobDetails): string | undefined {
  // The shared scorer judges factual usefulness, including brief records and
  // service context from equipment/tags. Character count is not an eligibility gate.
  if (!details.attachments.length) return 'The scanner skips this job because it has no attachments.';
  return undefined;
}
export const rateScannerJob = (details: JobDetails, scorer: JobScorer) => scorer.rate(scannerSource(details));
