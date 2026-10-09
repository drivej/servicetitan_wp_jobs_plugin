import { resolve } from 'node:path';

import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

import { HttpError } from './saas/validation.js';

import { OpenAIRequestError } from './openai-error.js';
import { DisabledJobCopyGenerator, type JobCopyGenerator } from './openai.js';
import type { JobsProvider, JobsQuery } from './service-titan.js';
import { ServiceTitanRequestError } from './service-titan-error.js';
import type { ApprovedPostCopy, WordPressProvider, WordPressWritableStatus } from './wordpress.js';
import { WordPressRequestError } from './wordpress-error.js';

import type { BuildTask } from '../shared/build-queue.js';
import { isWordPressBodyHtml } from '../shared/job-copy.js';

interface CreateAppOptions {
  buildQueue?: { enqueue(jobId: number): Promise<BuildTask>; list(jobIds: number[]): Promise<BuildTask[]> };
  serviceTitan: JobsProvider;
  wordpress: WordPressProvider;
  copyGenerator?: JobCopyGenerator;
  staticDirectory?: string;
  wordpressPluginArchivePath?: string;
  apiPrefix?: string;
  spendJobToken?: <T>(action: string, operation: () => Promise<T>, jobId?: number, operationId?: string, fingerprint?: string) => Promise<T>;
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const WORDPRESS_PLUGIN_FILENAME = 'job-showcase-for-servicetitan-1.18.2.zip';
const WORDPRESS_PLUGIN_ARCHIVE = resolve(process.cwd(), 'dist/downloads', WORDPRESS_PLUGIN_FILENAME);

export const createApp = ({
  serviceTitan,
  wordpress,
  copyGenerator = new DisabledJobCopyGenerator(),
  staticDirectory,
  wordpressPluginArchivePath = WORDPRESS_PLUGIN_ARCHIVE,
  apiPrefix = '/api',
  buildQueue,
  spendJobToken = async (_action, operation) => operation(),
}: CreateAppOptions) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get(`${apiPrefix}/health`, (_request, response) => { response.json({ status: 'ok' }); });
  app.get(`${apiPrefix}/wordpress/plugin`, async (_request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store');
      response.json(await wordpress.getPluginStatus());
    } catch (error) { next(error); }
  });
  app.get([
    '/downloads/servicetitan-job-integration.zip',
    '/downloads/job-showcase-for-servicetitan-1.18.2.zip',
    '/downloads/servicetitan-job-integration-1.11.1.zip',
    '/downloads/servicetitan-job-integration-1.11.0.zip',
    '/downloads/servicetitan-job-integration-1.10.0.zip',
    '/downloads/servicetitan-job-integration-1.9.2.zip',
    '/downloads/servicetitan-job-integration-1.9.1.zip',
    '/downloads/servicetitan-job-integration-1.9.0.zip',
    '/downloads/servicetitan-job-integration-1.8.0.zip',
    '/downloads/servicetitan-job-integration-1.7.0.zip',
  ], (_request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
    });
    response.download(wordpressPluginArchivePath, WORDPRESS_PLUGIN_FILENAME, (error) => {
      if (error && !response.headersSent) next(error);
    });
  });
  app.get(`${apiPrefix}/jobs`, async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store');
      response.json(await serviceTitan.getJobs(parseJobsQuery(request.query)));
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/jobs/:jobId`, async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store');
      response.json(await serviceTitan.getJobDetails(parseJobId(request.params.jobId)));
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/jobs/:jobId/image-candidates`, async (request, response, next) => {
    try {
      if (!serviceTitan.getJobImageCandidates) throw new HttpError('Image candidate lookup is unavailable.', 501);
      response.set('Cache-Control', 'private, no-store');
      response.json({ attachments: await serviceTitan.getJobImageCandidates(parseJobId(request.params.jobId)) });
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/jobs/:jobId/build-deploy`, async (request, response, next) => {
    try {
      if (!buildQueue) throw new HttpError('Build queue is unavailable.', 503);
      response.set('Cache-Control', 'no-store');
      response.status(202).json(await buildQueue.enqueue(parseJobId(request.params.jobId)));
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/build-deploy/statuses`, async (request, response, next) => {
    try {
      if (!buildQueue) throw new HttpError('Build queue is unavailable.', 503);
      response.set('Cache-Control', 'no-store');
      response.json({ tasks: await buildQueue.list(parseJobIds(request.body?.jobIds)) });
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/jobs/:jobId/ai-copy`, async (request, response, next) => {
    try {
      const details = await serviceTitan.getJobDetails(parseJobId(request.params.jobId));
      response.set('Cache-Control', 'no-store');
      const promptSource = { ...details.summary,
        technicianNotes: details.history.filter((item) => item.promptEligible).map((item) => item.content),
        imageFileNames: details.attachments.map((attachment) => attachment.fileName),
      };
      response.json(await spendJobToken('ai_generation', () => copyGenerator.generate(promptSource), details.summary.id, request.get('Idempotency-Key'), JSON.stringify({ action: 'ai_generation', jobId: details.summary.id })));
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/jobs/:jobId/images/:attachmentId`, async (request, response, next) => {
    try {
      const image = await serviceTitan.getJobImage(
        parseJobId(request.params.jobId),
        parseAttachmentId(request.params.attachmentId),
      );
      response.set({
        'Cache-Control': 'private, no-store',
        'Content-Type': image.contentType,
        'Content-Disposition': `inline; filename="${safeHeaderFilename(image.fileName)}"`,
        'X-Content-Type-Options': 'nosniff',
      });
      response.send(Buffer.from(image.bytes));
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/wordpress/statuses`, async (request, response, next) => {
    try {
      const jobIds = parseJobIds(request.body?.jobIds);
      response.set('Cache-Control', 'no-store');
      response.json({ statuses: await wordpress.getStatuses(jobIds) });
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/jobs/:jobId/wordpress`, async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store');
      response.json(await wordpress.getStatus(parseJobId(request.params.jobId)));
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/jobs/:jobId/wordpress`, async (request, response, next) => {
    try {
      const jobId = parseJobId(request.params.jobId);
      const attachmentIds = parseAttachmentIds(request.body?.attachmentIds);
      const status = parseWordPressStatus(request.body?.status);
      const approvedCopy = parseApprovedPostCopy(request.body?.aiCopy, true)!;
      const details = await serviceTitan.getJobDetails(jobId);
      const images = await Promise.all(attachmentIds.map((attachmentId) => serviceTitan.getJobImage(jobId, attachmentId)));
      response.status(201).json(await spendJobToken('push', () => wordpress.pushJob(details.summary, images, status, approvedCopy), jobId, request.get('Idempotency-Key'), JSON.stringify({ action: 'push', jobId, attachmentIds, status, approvedCopy })));
    } catch (error) { next(error); }
  });
  app.post(`${apiPrefix}/jobs/:jobId/wordpress/regenerate`, async (request, response, next) => {
    try {
      const jobId = parseJobId(request.params.jobId);
      const force = parseRegenerationForce(request.body?.force);
      const attachmentId = parseOptionalAttachmentId(request.body?.attachmentId);
      const approvedCopy = parseApprovedPostCopy(request.body?.aiCopy, false);
      const details = await serviceTitan.getJobDetails(jobId);
      const image = attachmentId ? await serviceTitan.getJobImage(jobId, attachmentId) : undefined;
      response.set('Cache-Control', 'no-store');
      response.json(await spendJobToken('rebuild', () => wordpress.regenerateJob(details.summary, force, image, approvedCopy), jobId, request.get('Idempotency-Key'), JSON.stringify({ action: 'rebuild', jobId, force, attachmentId, approvedCopy })));
    } catch (error) { next(error); }
  });
  const updateWordpressStatus: RequestHandler = async (request, response, next) => {
    try {
      const jobId = parseJobId(request.params.jobId);
      const status = parseWordPressStatus(request.body?.status);
      response.set('Cache-Control', 'no-store');
      response.json(await wordpress.updateStatus(jobId, status));
    } catch (error) { next(error); }
  };
  app.post(`${apiPrefix}/jobs/:jobId/wordpress/status`, updateWordpressStatus);
  app.patch(`${apiPrefix}/jobs/:jobId/wordpress`, updateWordpressStatus);

  if (staticDirectory) {
    app.use(express.static(staticDirectory, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_request, response) => { response.sendFile(resolve(staticDirectory, 'index.html')); });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof ValidationError) { response.status(400).json({ error: error.message }); return; }
    if (error instanceof OpenAIRequestError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof ServiceTitanRequestError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof WordPressRequestError) { response.status(error.status).json({ error: error.message }); return; }
    console.error('Integration request failed.');
    response.status(500).json({ error: 'An unexpected server error occurred.' });
  };
  app.use(errorHandler);
  return app;
};

class ValidationError extends Error {}

export const parseJobsQuery = (query: Record<string, unknown>): JobsQuery => {
  const start = singleValue(query.start, 'start');
  const end = singleValue(query.end, 'end');
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) throw new ValidationError('Start and end must be valid dates in YYYY-MM-DD format.');
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const inclusiveEndDate = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startDate.valueOf()) || Number.isNaN(inclusiveEndDate.valueOf()) || startDate.toISOString().slice(0, 10) !== start || inclusiveEndDate.toISOString().slice(0, 10) !== end) {
    throw new ValidationError('Start and end must be valid calendar dates.');
  }
  if (inclusiveEndDate < startDate) throw new ValidationError('End date must be on or after start date.');
  const endDateExclusive = new Date(inclusiveEndDate);
  endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1);
  if ((endDateExclusive.valueOf() - startDate.valueOf()) / 86_400_000 > MAX_RANGE_DAYS) throw new ValidationError(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  const zip = optionalZip(query.zip);
  return {
    startDate: startDate.toISOString(),
    endDateExclusive: endDateExclusive.toISOString(),
    page: positiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER),
    pageSize: positiveInteger(query.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    ...(zip ? { zip } : {}),
  };
};

const optionalZip = (value: unknown): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{5}(?:-\d{4})?$/.test(value)) {
    throw new ValidationError('ZIP code must contain five digits with an optional four-digit extension.');
  }
  return value;
};

const singleValue = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new ValidationError(`${name} is required.`);
  return value;
};

const positiveInteger = (value: unknown, name: string, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ValidationError(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new ValidationError(`${name} must be between 1 and ${maximum}.`);
  return parsed;
};

const parseJobId = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ValidationError('jobId must be a positive integer.');
  const jobId = Number(value);
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new ValidationError('jobId must be a positive integer.');
  return jobId;
};

const parseAttachmentId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value)) {
    throw new ValidationError('attachmentId is invalid.');
  }
  return value;
};

const parseOptionalAttachmentId = (value: unknown): string | undefined =>
  value === undefined ? undefined : parseAttachmentId(value);

const parseAttachmentIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ValidationError('Select exactly one job image.');
  }
  return value.map(parseAttachmentId);
};

const safeHeaderFilename = (value: string): string =>
  value.replace(/["\\\r\n]/g, '_').slice(0, 255) || 'job-image';

const parseWordPressStatus = (value: unknown): WordPressWritableStatus => {
  if (value !== 'draft' && value !== 'publish') {
    throw new ValidationError('WordPress status must be "draft" or "publish".');
  }
  return value;
};

const parseRegenerationForce = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ValidationError('force must be a boolean.');
  return value;
};

export const parseApprovedPostCopy = (value: unknown, required: boolean): ApprovedPostCopy | undefined => {
  if (value === undefined || (typeof value === 'string' && !value.trim())) {
    if (required) throw new ValidationError('Generate or paste the complete AI post copy before pushing.');
    return undefined;
  }
  if (typeof value !== 'string') throw new ValidationError('AI-generated copy must contain a title and HTML body.');
  const match = value.trim().match(/^TITLE:\s*([^\n]+)\nBODY:\s*([\s\S]+)$/i);
  if (!match) throw new ValidationError('Start with TITLE: followed by BODY: and the WordPress-ready HTML.');
  const title = match[1]!.trim();
  const bodyHtml = match[2]!.trim();
  if (title.length < 5 || title.length > 160) throw new ValidationError('AI-generated title must be between 5 and 160 characters.');
  if (!isWordPressBodyHtml(bodyHtml)) throw new ValidationError('The body must contain 3–5 short paragraphs using p tags and optional blockquote.');
  if (/<(?:script|style|img|a|h[1-6]|ul|ol|li|div|span)\b|\son\w+\s*=|style\s*=|javascript:/i.test(bodyHtml)) throw new ValidationError('The body contains unsupported HTML.');
  return { title, bodyHtml };
};

const parseJobIds = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGE_SIZE) {
    throw new ValidationError(`jobIds must contain between 1 and ${MAX_PAGE_SIZE} jobs.`);
  }

  const jobIds = value.map((jobId) => {
    if (!Number.isSafeInteger(jobId) || jobId < 1) throw new ValidationError('Every jobId must be a positive integer.');
    return jobId as number;
  });
  if (new Set(jobIds).size !== jobIds.length) throw new ValidationError('jobIds cannot contain duplicates.');
  return jobIds;
};
