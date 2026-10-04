import type { JobCopyGenerator } from './openai.js';
import type { JobsProvider, JobImage } from './service-titan.js';
import type { WordPressProvider } from './wordpress.js';
import { formatJobCopy } from '../shared/job-copy.js';
import { parseApprovedPostCopy } from './app.js';

export interface BuildProviders {
  serviceTitan: JobsProvider;
  wordpress: WordPressProvider;
  copyGenerator: JobCopyGenerator;
  spendJobToken?: <T>(action: string, operation: () => Promise<T>, jobId?: number) => Promise<T>;
}

export async function buildAndDeploy(jobId: number, providers: BuildProviders) {
  const { serviceTitan, wordpress, copyGenerator, spendJobToken = async (_action, operation) => operation() } = providers;
  if ((await wordpress.getPluginStatus()).state !== 'current') throw new Error('Verify the WordPress plugin before building a draft.');
  const existing = await wordpress.getStatus(jobId);
  if (existing.state === 'exists') throw new Error('This job already has a WordPress post. Open Details to rebuild it.');
  if (existing.state !== 'not_found') throw new Error('Unable to verify whether this job already has a WordPress post.');
  const details = await serviceTitan.getJobDetails(jobId);
  let image: JobImage | undefined;
  for (const attachment of details.attachments) {
    try {
      const candidate = await serviceTitan.getJobImage(jobId, attachment.id);
      if (candidate.contentType.startsWith('image/') && candidate.bytes.byteLength > 0 && candidate.bytes.byteLength <= 30 * 1024 * 1024) {
        image = candidate;
        break;
      }
    } catch { /* Try the next available image in source order. */ }
  }
  if (!image) throw new Error('This job has no available image. Add a working image and try again.');
  const copy = await spendJobToken('ai_generation', async () =>
    parseApprovedPostCopy(formatJobCopy(await copyGenerator.generate(details.summary)), true)!, jobId);
  return spendJobToken('push', () => wordpress.pushJob(details.summary, [image!], 'draft', copy), jobId);
}
