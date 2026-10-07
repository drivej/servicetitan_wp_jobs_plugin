import type { Express } from 'express';
import { createApp } from '../app.js';
import { DisabledJobCopyGenerator, type JobCopyGenerator } from '../openai.js';
import { ServiceTitanClient, type JobDetails } from '../service-titan.js';
import { DisabledWordPressClient, WordPressClient } from '../wordpress.js';
import { ZippopotamClient } from '../zip-lookup.js';
import { publicFetch } from './public-fetch.js';
import type { BuildQueueStore, BuildScope } from '../build-queue.js';
import type { BuildProviders } from '../build-deploy.js';
import type { AccountStore, WebsiteContext } from './store.js';

export type WebsiteAppFactory = (userId: string, context: WebsiteContext) => Express;
export function minimizeJobDetails(details: JobDetails): JobDetails {
  const { address: _address, ...location } = details.summary.location;
  const { id, jobNumber, locationId, jobTypeId, jobStatus } = details.job;
  return { ...details, job: { id, jobNumber, locationId, jobTypeId, jobStatus }, summary: { ...details.summary, location } };
}
export function websiteAppFactory(store: AccountStore, copyGenerator: JobCopyGenerator = new DisabledJobCopyGenerator(), queue?: BuildQueueStore): WebsiteAppFactory {
  const apps = new Map<string, { app: Express; expiresAt: number }>();
  return (userId, context) => {
    const { website, connection, workspaceId } = context;
    const key = `${userId}:${workspaceId}:${website.id}:${website.version}:${connection.id}:${connection.version}`;
    for (const [id, value] of apps) if (value.expiresAt <= Date.now()) apps.delete(id);
    const existing = apps.get(key);
    if (existing) return existing.app;
    const scope: BuildScope = { userId, workspaceId, websiteId: website.id };
    const app = createApp({ ...websiteBuildProviders(store, copyGenerator, userId, context), apiPrefix: '',
      ...(queue ? { buildQueue: { enqueue: (jobId: number) => queue.enqueue(scope, jobId), list: (jobIds: number[]) => queue.list(scope, jobIds) } } : {}),
    });
    if (apps.size >= 100) apps.delete(apps.keys().next().value!);
    apps.set(key, { app, expiresAt: Date.now() + 5 * 60_000 });
    return app;
  };
}

export function websiteBuildProviders(store: AccountStore, copyGenerator: JobCopyGenerator, userId: string, { website, connection, wordpress, workspaceId }: WebsiteContext): BuildProviders {
  const serviceTitan = new ServiceTitanClient({ ...connection,
    apiBaseUrl: 'https://api.servicetitan.io',
    authUrl: 'https://auth.servicetitan.io/connect/token',
  });
  const getJobDetails = async (id: number) => minimizeJobDetails(await serviceTitan.getJobDetails(id));
  return { serviceTitan: {
    getJobs: (query) => serviceTitan.getJobs(query),
    getJob: async (id) => (await getJobDetails(id)).summary,
    getJobDetails,
    getJobImage: (id, attachment) => serviceTitan.getJobImage(id, attachment),
  }, copyGenerator,
    spendJobToken: (action, operation, jobId) => store.spendJobToken(userId, website.id, action, operation, workspaceId, jobId),
    wordpress: wordpress ? new WordPressClient({ ...wordpress,
      collectionUrl: `${website.url}/wp-json/wp/v2/${website.restBase}`,
      postStatus: 'draft', zipAcfFieldName: website.zipAcfField,
    }, publicFetch, new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' })) : new DisabledWordPressClient(),
  };
}
