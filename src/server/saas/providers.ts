import type { Express } from 'express';
import { createApp } from '../app.js';
import { DisabledJobCopyGenerator, type JobCopyGenerator } from '../openai.js';
import { ServiceTitanClient, type JobDetails } from '../service-titan.js';
import { DisabledWordPressClient, WordPressClient } from '../wordpress.js';
import { ZippopotamClient } from '../zip-lookup.js';
import { publicFetch } from './public-fetch.js';
import type { WebsiteContext } from './store.js';

export type WebsiteAppFactory = (userId: string, context: WebsiteContext) => Express;
export function minimizeJobDetails(details: JobDetails): JobDetails {
  const { address: _address, ...location } = details.summary.location;
  const { id, jobNumber, locationId, jobTypeId, jobStatus } = details.job;
  return { ...details, job: { id, jobNumber, locationId, jobTypeId, jobStatus }, summary: { ...details.summary, location } };
}
export function websiteAppFactory(copyGenerator: JobCopyGenerator = new DisabledJobCopyGenerator()): WebsiteAppFactory {
  const apps = new Map<string, { app: Express; expiresAt: number }>();
  return (userId, { website, connection, wordpress }) => {
    const key = `${userId}:${website.id}:${website.version}:${connection.id}:${connection.version}`;
    for (const [id, value] of apps) if (value.expiresAt <= Date.now()) apps.delete(id);
    const existing = apps.get(key);
    if (existing) return existing.app;
    const production = connection.environment === 'production';
    const serviceTitan = new ServiceTitanClient({ ...connection,
      apiBaseUrl: production ? 'https://api.servicetitan.io' : 'https://api-integration.servicetitan.io',
      authUrl: production ? 'https://auth.servicetitan.io/connect/token' : 'https://auth-integration.servicetitan.io/connect/token',
    });
    const getJobDetails = async (id: number) => minimizeJobDetails(await serviceTitan.getJobDetails(id));
    const app = createApp({ serviceTitan: {
      getJobs: (query) => serviceTitan.getJobs(query),
      getJob: async (id) => (await getJobDetails(id)).summary,
      getJobDetails,
      getJobImage: (id, attachment) => serviceTitan.getJobImage(id, attachment),
    }, copyGenerator, apiPrefix: '',
      wordpress: wordpress ? new WordPressClient({ ...wordpress,
        collectionUrl: `${website.url}/wp-json/wp/v2/${website.restBase}`,
        postStatus: 'draft', zipAcfFieldName: website.zipAcfField,
      }, publicFetch, new ZippopotamClient({ apiBaseUrl: 'https://api.zippopotam.us' })) : new DisabledWordPressClient(),
    });
    if (apps.size >= 100) apps.delete(apps.keys().next().value!);
    apps.set(key, { app, expiresAt: Date.now() + 5 * 60_000 });
    return app;
  };
}
