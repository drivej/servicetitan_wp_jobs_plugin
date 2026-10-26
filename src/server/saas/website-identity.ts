import { publicFetch } from './public-fetch.js';
import { HttpError, websiteUrl, uuid, type WebsiteInput } from './validation.js';

export interface WebsiteIdentity { installationId: string; canonicalUrl: string; }
async function readIdentity(url: string, credentials: NonNullable<WebsiteInput['wordpress']>, fetcher: typeof fetch = publicFetch): Promise<WebsiteIdentity> {
  const response = await fetcher(`${websiteUrl(url)}/wp-json/servicetitan-job-integration/v1/identity`, {
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.applicationPassword}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new HttpError('Verify WordPress administrator credentials and install the latest companion plugin to confirm website ownership.', 422);
  const body = await response.json() as { installationId?: unknown; canonicalUrl?: unknown };
  try { return { installationId: uuid(body.installationId), canonicalUrl: websiteUrl(body.canonicalUrl) }; }
  catch { throw new HttpError('WordPress returned an invalid installation identity.', 422); }
}
export const ownershipConflict = () => new HttpError('Website already connected. Request access to the existing workspace or submit an ownership dispute.', 409, 'website_already_connected');

export async function verifyWebsiteIdentity(url: string, credentials: NonNullable<WebsiteInput['wordpress']>, fetcher: typeof fetch = publicFetch): Promise<WebsiteIdentity> {
  const identity = await readIdentity(url,credentials,fetcher);
  if (identity.canonicalUrl !== websiteUrl(url)) {
    // Never send application passwords to a different origin supplied by a remote response.
    if (new URL(identity.canonicalUrl).origin !== new URL(url).origin) {
      throw new HttpError('Use the canonical WordPress address from General Settings, then verify again. Credentials cannot be forwarded to another domain.',422);
    }
    // A site may report a path alias, but cannot reserve another installation.
    const canonical = await readIdentity(identity.canonicalUrl,credentials,fetcher);
    if (canonical.installationId !== identity.installationId || canonical.canonicalUrl !== identity.canonicalUrl) {
      throw new HttpError('The canonical WordPress address did not confirm the same installation.',422);
    }
  }
  return identity;
}
