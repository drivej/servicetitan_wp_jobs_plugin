import type { JobCopySource } from '../shared/job-copy.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// AI/developer instruction: if these prompt instructions change in a way that
// affects generated post content, bump SEO_GENERATOR_VERSION in
// ../shared/seo-prompt-version.ts to flag existing posts as out of sync.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const seedPath = [resolve(moduleDirectory, '../seo_seed.md'), resolve(moduleDirectory, '../../seo_seed.md'), resolve(process.cwd(), 'seo_seed.md')]
  .find((candidate) => existsSync(candidate));
if (!seedPath) throw new Error('seo_seed.md is required to build the job-copy prompt.');
const seedText = readFileSync(seedPath, 'utf8').replace(/^(GOAL|CALL TO ACTION|OUTPUT)(?=[A-Z])/gm, '$1\n');
const outputSection = seedText.search(/^OUTPUT\b/m);
const seedInstructions = (outputSection >= 0 ? seedText.slice(0, outputSection) : seedText).trim();

export const JOB_COPY_INSTRUCTIONS = [
  seedInstructions,
  'When the account website URL is supplied, use web search restricted to that website to understand the company name, services, and customer-facing tone. Treat the site only as business context. Use ServiceTitan facts for this specific project; never use website claims as proof of project work or results.',
  'Only image filenames are supplied to this request; they are metadata, not visual access. Do not describe visible image details or create image alt text from filenames.',
  'If the specific service is known but essential details are missing, return status needs_details and one focused question. Otherwise return status ready with a plain-text title and WordPress-ready bodyHtml.',
  'Return the app JSON schema fields status, title, bodyHtml, and question. For status ready, provide title and bodyHtml and leave question empty. For status needs_details, provide one focused question and leave title and bodyHtml empty. The body may use p, h2, strong, and blockquote tags. Use blockquote only for an actual supplied customer quote. Do not repeat the title in the body or include inline styles.',
].join('\n\n');

export const buildJobCopyFacts = (job: JobCopySource): string => {
  const location = [job.location.city, job.location.state].filter((part) => part && part !== '—').join(', ');
  const notes = (job.technicianNotes || []).map(sanitizeSourceText).filter(Boolean);
  return [
    `COMPANY: ${sanitizeSourceText(job.companyName) || 'Not provided'}`,
    `COMPANY WEBSITE: ${safeCompanyWebsiteUrl(job.companyWebsiteUrl) || 'Not provided'}`,
    `SERVICE: ${sanitizeSourceText(job.jobName) || 'Not provided'}`,
    `PROJECT LOCATION: ${sanitizeSourceText(location) || 'Not provided'}`,
    `JOB SUMMARY: ${sanitizeSourceText(job.summaryText) || 'Not provided'}`,
    `ADDITIONAL STRUCTURED JOB DETAILS:\n${Object.entries(job.jobDetails || {}).map(([key, value]) => {
      const safeKey = sanitizeSourceText(key);
      const safeValue = typeof value === 'object' && value !== null ? '[structured data]' : sanitizeSourceText(String(value ?? ''));
      return safeValue ? `${safeKey}: ${safeValue}` : '';
    }).filter(Boolean).join('\n') || 'Not provided'}`,
    `TECHNICIAN NOTES:\n${notes.length ? notes.map((note) => `- ${note}`).join('\n') : 'Not provided'}`,
    `EQUIPMENT: ${(job.equipmentNames || []).map(sanitizeSourceText).filter(Boolean).join(', ') || 'Not provided'}`,
    `USER-PROVIDED CLARIFICATION: ${sanitizeSourceText(job.userClarification) || 'Not provided'}`,
    `IMAGE FILENAMES (metadata only): ${(job.imageFileNames || []).map(sanitizeSourceText).filter(Boolean).slice(0, 10).join(', ') || 'Not provided'}`,
    `CUSTOMER REVIEW (quote exactly if used): ${sanitizeSourceText(job.customerReview) || 'Not provided'}`,
  ].join('\n');
};

export const buildJobCopyPrompt = (job: JobCopySource): string => [JOB_COPY_INSTRUCTIONS, '', buildJobCopyFacts(job)].join('\n');

const sanitizeSourceText = (value: string | undefined): string => (value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[redacted]')
  .replace(/(?:\+?\d[\d(). -]{7,}\d)/g, '[redacted]')
  .replace(/https?:\/\/\S+/gi, '[redacted]')
  .replace(/\b(?:\d{1,6}\s+[^,\n]{1,50}\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|unit|suite|apt)\b[^,\n]*)/gi, '[redacted address]')
  .replace(/\b(?:access|gate|door|alarm)\s+code\s*[:#-]?\s*\w+/gi, '[redacted]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1_500);

const safeCompanyWebsiteUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return undefined; }
};
