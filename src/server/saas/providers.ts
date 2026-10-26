import { DisabledJobScorer, type JobScorer } from '../job-scorer.js';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { DisabledJobCopyGenerator, type JobCopyGenerator } from '../openai.js';
import { ServiceTitanClient, type JobDetails } from '../service-titan.js';
import { DisabledWordPressClient, WordPressClient } from '../wordpress.js';
import { ZippopotamClient } from '../zip-lookup.js';
import { verifyWebsiteIdentity } from './website-identity.js';
import { publicFetch } from './public-fetch.js';
import type { BuildQueueStore, BuildScope } from '../build-queue.js';
import { scannerApi, type ScannerStore } from '../job-scanner.js';
import type { BuildProviders } from '../build-deploy.js';
import type { AccountStore, WebsiteContext } from './store.js';
import { HttpError } from './validation.js';

export type WebsiteAppFactory = ((userId: string, context: WebsiteContext) => Express) & { clearCache?: () => void };
export function minimizeJobDetails(details: JobDetails): JobDetails {
  const { address: _address, ...location } = details.summary.location;
  const { id, jobNumber, locationId, jobTypeId, jobStatus } = details.job;
  return { ...details, job: { id, jobNumber, locationId, jobTypeId, jobStatus }, summary: { ...details.summary, location } };
}
export function websiteAppFactory(store: AccountStore, copyGenerator: JobCopyGenerator = new DisabledJobCopyGenerator(), queue?: BuildQueueStore, scannerStore?: ScannerStore, jobScorer: JobScorer = new DisabledJobScorer()): WebsiteAppFactory {
  const apps = new Map<string, { app: Express; expiresAt: number }>();
  const factory: WebsiteAppFactory = (userId, context) => {
    const { website, connection, workspaceId } = context;
    const key = `${userId}:${workspaceId}:${website.id}:${website.version}:${connection.id}:${connection.version}`;
    for (const [id, value] of apps) if (value.expiresAt <= Date.now()) apps.delete(id);
    const existing = apps.get(key);
    if (existing) return existing.app;
    const scope: BuildScope = { userId, workspaceId, websiteId: website.id };
    const app = createApp({ jobScorer, ...(scannerStore && queue ? { scanner: scannerApi(scope,scannerStore,queue) } : {}), ...websiteBuildProviders(store, copyGenerator, userId, context), apiPrefix: '',
      ...(queue ? { buildQueue: { enqueue: (jobId: number) => queue.enqueue(scope, jobId), list: (jobIds: number[]) => queue.list(scope, jobIds) } } : {}),
    });
    if (apps.size >= 100) apps.delete(apps.keys().next().value!);
    apps.set(key, { app, expiresAt: Date.now() + 5 * 60_000 });
    return app;
  };
  factory.clearCache=()=>apps.clear();
  return factory;
}

export function websiteBuildProviders(store: AccountStore, copyGenerator: JobCopyGenerator, userId: string, { website, connection, wordpress, workspaceId }: WebsiteContext, fetcher: typeof fetch = publicFetch): BuildProviders {
  const serviceTitan = new ServiceTitanClient({ ...connection, contentScope: `${workspaceId}:${connection.id}:${connection.version}`,
    apiBaseUrl: 'https://api.servicetitan.io',
    authUrl: 'https://auth.servicetitan.io/connect/token',
  });
  const assertOwned = async () => {
    await store.assertWebsiteOwnership(userId,website.id,workspaceId,website.version);
    if (!wordpress || !website.installationId || !website.ownershipVerified) throw new HttpError('Verify website ownership in Settings.',409);
    const identity=await verifyWebsiteIdentity(website.url,wordpress,fetcher);
    if (identity.installationId !== website.installationId || identity.canonicalUrl !== website.canonicalUrl) throw new HttpError('Website identity changed. Verify ownership in Settings.',409);
    // Settings or membership may have changed during the remote check.
    await store.assertWebsiteOwnership(userId,website.id,workspaceId,website.version);
  };
  const ownedFetch: typeof fetch = async (input, init) => {
    // Re-check cached apps and queued work before each WordPress request.
    await assertOwned();
    return store.withWebsiteOwnership(userId,website.id,workspaceId,website.version,()=>fetcher(input,init));
  };
  const getJobDetails = async (id: number) => minimizeJobDetails(await serviceTitan.getJobDetails(id));
  return { companyWebsiteUrl: website.url, serviceTitan: {
    getScannerJobs: (page) => serviceTitan.getScannerJobs(page),
    getJobs: (query) => serviceTitan.getJobs(query),
    getJobImageCandidates: (id) => serviceTitan.getJobImageCandidates(id),
    getJob: async (id) => (await getJobDetails(id)).summary,
    getJobDetails,
    getJobImage: (id, attachment) => serviceTitan.getJobImage(id, attachment),
  }, copyGenerator,
    spendJobToken: async (action, operation, jobId, operationId, fingerprint) => {
      if (!operationId) throw new HttpError('A valid Idempotency-Key is required.');
      if (action !== 'ai_generation') await assertOwned();
      return store.spendJobToken(userId, website.id, action, operation, workspaceId, jobId, operationId, fingerprint);
    },
    wordpress: wordpress ? new WordPressClient({ ...wordpress,
      collectionUrl: `${website.url}/wp-json/wp/v2/${website.restBase}`,
      postStatus: 'draft', zipAcfFieldName: website.zipAcfField,
    }, ownedFetch, new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' })) : new DisabledWordPressClient(),
  };
}
