import type { JobImage, JobListItem } from './service-titan.js';
import type { WordPressConfig } from './config.js';
import type { ZipCodeLookup, ZipCodePlace } from './zip-lookup.js';
import { normalizeServiceName, serviceGuidance } from './job-seo.js';
import { WordPressRequestError } from './wordpress-error.js';
import type { GeneratedJobCopy } from '../shared/job-copy.js';

interface WordPressPost {
  id: number;
  slug: string;
  status: string;
  link?: string;
}

interface WordPressErrorBody {
  message?: string;
}

export interface WordPressPostStatus {
  state: 'unknown' | 'not_found' | 'exists';
  label: string;
  postId?: number;
  postStatus?: string;
  link?: string;
  postTitle?: string;
  postExcerpt?: string;
  message?: string;
  seoVersion?: number;
  currentSeoVersion?: number;
  seoState?: 'current' | 'outdated' | 'legacy' | 'modified' | 'newer';
  generatedAt?: string;
  featuredImageId?: number;
  featuredImageFileName?: string;
  featuredImageAttachmentId?: string;
}

export type WordPressWritableStatus = 'draft' | 'publish';
export type ApprovedPostCopy = GeneratedJobCopy;

export interface WordPressPluginStatus {
  state: 'current' | 'update_required' | 'unknown';
  requiredVersion: string;
  installedVersion?: string;
  message?: string;
  seoGeneratorVersion: number;
}

export interface WordPressProvider {
  getPluginStatus(): Promise<WordPressPluginStatus>;
  getStatuses(serviceTitanJobIds: number[]): Promise<Record<number, WordPressPostStatus>>;
  getStatus(serviceTitanJobId: number): Promise<WordPressPostStatus>;
  pushJob(job: JobListItem, images: JobImage[], status: WordPressWritableStatus, approvedCopy: ApprovedPostCopy): Promise<WordPressPostStatus>;
  regenerateJob(job: JobListItem, force: boolean, image?: JobImage, approvedCopy?: ApprovedPostCopy): Promise<WordPressPostStatus>;
  updateStatus(serviceTitanJobId: number, status: WordPressWritableStatus): Promise<WordPressPostStatus>;
}

type FetchImplementation = typeof fetch;
export const REQUIRED_WORDPRESS_PLUGIN_VERSION = '1.18.1';
export const SEO_GENERATOR_VERSION = 6;

export class WordPressClient implements WordPressProvider {
  private readonly authorization: string;
  private readonly pushes = new Map<number, Promise<WordPressPostStatus>>();
  private readonly regenerations = new Map<number, Promise<WordPressPostStatus>>();
  private zipSync: Promise<void> | undefined;

  constructor(
    private readonly config: WordPressConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly zipCodeLookup?: ZipCodeLookup,
  ) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.applicationPassword}`).toString('base64')}`;
  }

  /** Check authenticated REST API access and companion endpoint permissions. */
  async validateAccess(): Promise<void> {
    try {
      const response = await this.request(pluginApiUrl(this.config.collectionUrl, 'status'));
      const body = await parseJson<{ version?: string }>(response);
      if (!body.version || !/^\d+\.\d+\.\d+$/.test(body.version)) throw new WordPressRequestError('The companion plugin did not return a valid status.', 502);
    } catch (error) { throw this.toRequestError(error); }
  }

  async getPluginStatus(): Promise<WordPressPluginStatus> {
    try {
      const response = await this.request(pluginApiUrl(this.config.collectionUrl, 'status'));
      const body = await parseJson<{ version?: string }>(response);
      if (!body.version || !/^\d+\.\d+\.\d+$/.test(body.version)) {
        return {
          state: 'unknown',
          requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION,
          seoGeneratorVersion: SEO_GENERATOR_VERSION,
          message: 'WordPress returned an invalid companion-plugin status.',
        };
      }

      const state = compareVersions(body.version, REQUIRED_WORDPRESS_PLUGIN_VERSION) >= 0 ? 'current' : 'update_required';
      if (state === 'current' && (this.zipCodeLookup || this.config.zipAcfFieldName !== 'my_zip_codes')) {
        try {
          await this.ensureZipConfiguration();
        } catch (error) {
          console.warn('WordPress ZIP metadata sync failed; plugin status remains available.', error);
        }
      }

      return {
        state,
        requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION,
        installedVersion: body.version,
        seoGeneratorVersion: SEO_GENERATOR_VERSION,
      };
    } catch (error) {
      const requestError = this.toRequestError(error);
      if (requestError.status === 404) {
        return {
          state: 'update_required',
          requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION,
          seoGeneratorVersion: SEO_GENERATOR_VERSION,
          message: 'The companion plugin is missing or does not support version detection.',
        };
      }
      return {
        state: 'unknown',
        requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION,
        seoGeneratorVersion: SEO_GENERATOR_VERSION,
        message: requestError.message,
      };
    }
  }

  async getStatuses(serviceTitanJobIds: number[]): Promise<Record<number, WordPressPostStatus>> {
    const response = await this.request(pluginApiUrl(this.config.collectionUrl, 'statuses'), {
      method: 'POST',
      body: JSON.stringify({ jobIds: serviceTitanJobIds }),
    });
    const body = await parseJson<{ statuses?: Record<string, WordPressPostStatus> }>(response);
    const statuses: Record<number, WordPressPostStatus> = {};

    for (const jobId of serviceTitanJobIds) {
      statuses[jobId] = decorateSeoStatus(body.statuses?.[String(jobId)] || { state: 'not_found', label: 'None' });
    }
    return statuses;
  }

  async getStatus(serviceTitanJobId: number): Promise<WordPressPostStatus> {
    try {
      return (await this.getStatuses([serviceTitanJobId]))[serviceTitanJobId]!;
    } catch (error) {
      const requestError = this.toRequestError(error);
      return {
        state: 'unknown',
        label: 'Unknown',
        currentSeoVersion: SEO_GENERATOR_VERSION,
        message: requestError.message,
      };
    }
  }

  async pushJob(job: JobListItem, images: JobImage[], status: WordPressWritableStatus, approvedCopy: ApprovedPostCopy): Promise<WordPressPostStatus> {
    const currentPush = this.pushes.get(job.id);
    if (currentPush) return currentPush;

    const push = this.createJobPost(job, images, status, approvedCopy).finally(() => {
      this.pushes.delete(job.id);
    });
    this.pushes.set(job.id, push);
    return push;
  }

  async regenerateJob(job: JobListItem, force: boolean, image?: JobImage, approvedCopy?: ApprovedPostCopy): Promise<WordPressPostStatus> {
    const currentRegeneration = this.regenerations.get(job.id);
    if (currentRegeneration) return currentRegeneration;

    const regeneration = this.updateGeneratedPost(job, force, image, approvedCopy).finally(() => {
      this.regenerations.delete(job.id);
    });
    this.regenerations.set(job.id, regeneration);
    return regeneration;
  }

  async updateStatus(serviceTitanJobId: number, status: WordPressWritableStatus): Promise<WordPressPostStatus> {
    const currentStatus = await this.getStatus(serviceTitanJobId);
    if (currentStatus.state !== 'exists' || !currentStatus.postId) {
      throw new WordPressRequestError('This ServiceTitan job does not exist in WordPress.', 404);
    }

    const response = await this.request(`${this.config.collectionUrl}/${currentStatus.postId}`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    return { ...currentStatus, ...postToStatus(await parseJson<WordPressPost>(response)) };
  }

  private async createJobPost(job: JobListItem, images: JobImage[], status: WordPressWritableStatus, approvedCopy: ApprovedPostCopy): Promise<WordPressPostStatus> {
    if (images.length !== 1) {
      throw new WordPressRequestError('Select exactly one job image.', 400);
    }
    const currentStatus = await this.lookupStatus(job.id);
    if (currentStatus.state === 'exists') {
      throw new WordPressRequestError('This ServiceTitan job already exists in WordPress.', 409);
    }

    const response = await this.request(this.config.collectionUrl, {
      method: 'POST',
      body: JSON.stringify({
        ...generatedPostFields(job, approvedCopy),
        ...await this.locationPostFields(job),
        slug: serviceTitanJobSlug(job.id),
        status,
      }),
    });
    let post = await parseJson<WordPressPost>(response);
    const mediaId = await this.uploadImage(images[0]!, post.id);
    const featuredResponse = await this.request(`${this.config.collectionUrl}/${post.id}`, {
      method: 'POST',
      body: JSON.stringify({ featured_media: mediaId }),
    });
    post = await parseJson<WordPressPost>(featuredResponse);
    return decorateSeoStatus({
      ...postToStatus(post),
      featuredImageId: mediaId,
      featuredImageFileName: safeMediaFilename(images[0]!.fileName),
      featuredImageAttachmentId: images[0]!.id,
    }, SEO_GENERATOR_VERSION, false);
  }

  private async updateGeneratedPost(job: JobListItem, force: boolean, image?: JobImage, approvedCopy?: ApprovedPostCopy): Promise<WordPressPostStatus> {
    const currentStatus = await this.getStatus(job.id);
    if (currentStatus.state !== 'exists' || !currentStatus.postId) {
      throw new WordPressRequestError('This ServiceTitan job does not exist in WordPress.', 404);
    }
    if (currentStatus.seoState === 'newer') {
      throw new WordPressRequestError('This post was generated by a newer SEO generator and cannot be overwritten by this app version.', 409);
    }
    if (currentStatus.seoState === 'modified' && !force) {
      throw new WordPressRequestError('This post was edited in WordPress. Confirm that you want to replace its generated title, excerpt, and content.', 409);
    }
    if ((!currentStatus.seoVersion || currentStatus.seoVersion < SEO_GENERATOR_VERSION) && !approvedCopy?.bodyHtml) {
      throw new WordPressRequestError('Generate or paste the complete AI post copy before updating this post to the latest SEO version.', 400);
    }

    const featuredMedia = image ? await this.uploadImage(image, currentStatus.postId) : undefined;
    const generatedFields = generatedPostFields(job, approvedCopy);
    if (!approvedCopy) {
      delete generatedFields.title;
      delete generatedFields.excerpt;
    }
    if (!approvedCopy?.bodyHtml) delete generatedFields.content;
    const response = await this.request(`${this.config.collectionUrl}/${currentStatus.postId}`, {
      method: 'POST',
      body: JSON.stringify({
        ...generatedFields,
        ...await this.locationPostFields(job),
        ...(featuredMedia ? { featured_media: featuredMedia } : {}),
      }),
    });
    const post = await parseJson<WordPressPost>(response);
    return decorateSeoStatus({
      ...postToStatus(post),
      ...(image ? {
        featuredImageId: featuredMedia!,
        featuredImageFileName: safeMediaFilename(image.fileName),
        featuredImageAttachmentId: image.id,
      } : {
        ...(currentStatus.featuredImageId ? { featuredImageId: currentStatus.featuredImageId } : {}),
        ...(currentStatus.featuredImageFileName ? { featuredImageFileName: currentStatus.featuredImageFileName } : {}),
        ...(currentStatus.featuredImageAttachmentId ? { featuredImageAttachmentId: currentStatus.featuredImageAttachmentId } : {}),
      }),
    }, SEO_GENERATOR_VERSION, false);
  }

  private async uploadImage(image: JobImage, postId: number): Promise<number> {
    const url = new URL(wordPressMediaUrl(this.config.collectionUrl));
    url.searchParams.set('post', String(postId));
    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': image.contentType,
        'Content-Disposition': `attachment; filename="${safeMediaFilename(image.fileName)}"`,
        'X-STJI-Source-Attachment-ID': image.id,
      },
      body: Buffer.from(image.bytes),
    });
    const media = await parseJson<{ id?: number }>(response);
    if (!media.id) throw new WordPressRequestError('WordPress did not return an ID for an uploaded image.', 502);
    return media.id;
  }

  private async locationPostFields(job: JobListItem): Promise<{
    stji_location?: {
      acfFieldName: string;
      zipcodes: Array<{ zipcode: string; city: string; state: string; latitude?: number; longitude?: number }>;
      completedOn?: string;
    };
  }> {
    const zipcode = normalizeZipcode(job.location.zip);
    if (!zipcode) return {};
    let place: ZipCodePlace | undefined;
    if (this.zipCodeLookup) {
      try {
        place = await this.zipCodeLookup.lookup(zipcode);
      } catch (error) {
        console.warn(`ZIP city/state lookup failed for ZIP ${zipcode}; using ServiceTitan location data.`, error);
      }
    }
    const city = place?.city || cleanLocationPart(job.location.city);
    const state = place?.state || cleanState(job.location.state);
    return {
      stji_location: {
        acfFieldName: this.config.zipAcfFieldName,
        zipcodes: [{
          zipcode,
          city,
          state,
          ...(place?.latitude !== undefined && place.longitude !== undefined
            ? { latitude: place.latitude, longitude: place.longitude }
            : {}),
        }],
        ...(job.completedOn ? { completedOn: job.completedOn } : {}),
      },
    };
  }

  private async ensureZipConfiguration(): Promise<void> {
    if (!this.zipSync) {
      this.zipSync = this.syncZipConfiguration().catch((error) => {
        this.zipSync = undefined;
        throw error;
      });
    }
    return this.zipSync;
  }

  private async syncZipConfiguration(): Promise<void> {
    const zipcodes: Array<{ zipcode: string; city: string; state: string; latitude?: number; longitude?: number }> = [];
    if (this.zipCodeLookup) {
      const response = await this.request(pluginApiUrl(this.config.collectionUrl, 'zipcodes'));
      const body = await parseJson<{ zipcodes?: Array<{
        zipcode?: string;
        city?: string;
        state?: string;
        latitude?: number | null;
        longitude?: number | null;
      }> }>(response);
      for (const item of body.zipcodes || []) {
        const zipcode = normalizeZipcode(item.zipcode || '');
        const hasCoordinates = isCoordinate(item.latitude, -90, 90) && isCoordinate(item.longitude, -180, 180);
        if (!zipcode || (item.city && item.state && hasCoordinates)) continue;
        const place = await this.zipCodeLookup.lookup(zipcode);
        if (place) zipcodes.push({
          zipcode,
          city: place.city,
          state: place.state,
          ...(place.latitude !== undefined && place.longitude !== undefined
            ? { latitude: place.latitude, longitude: place.longitude }
            : {}),
        });
      }
    }

    await this.request(pluginApiUrl(this.config.collectionUrl, 'zipcodes'), {
      method: 'POST',
      body: JSON.stringify({ acfFieldName: this.config.zipAcfFieldName, zipcodes }),
    });
  }

  private async lookupStatus(serviceTitanJobId: number): Promise<WordPressPostStatus> {
    const url = new URL(this.config.collectionUrl);
    url.searchParams.set('slug', serviceTitanJobSlug(serviceTitanJobId));
    url.searchParams.set('status', 'any');
    url.searchParams.set('context', 'edit');
    url.searchParams.set('per_page', '1');
    url.searchParams.set('_fields', 'id,slug,status,link');

    const response = await this.request(url.toString());
    const posts = await parseJson<WordPressPost[]>(response);
    const post = posts[0];
    return post ? postToStatus(post) : { state: 'not_found', label: 'None' };
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw this.toRequestError(error);
    }

    if (!response.ok) {
      const body = await safeJson<WordPressErrorBody>(response);
      const detail = body?.message ? stripHtml(body.message) : `WordPress returned HTTP ${response.status}.`;
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new WordPressRequestError(detail, status);
    }
    return response;
  }

  private toRequestError(error: unknown): WordPressRequestError {
    if (error instanceof WordPressRequestError) return error;
    return new WordPressRequestError(
      error instanceof Error ? `WordPress connection failed: ${error.message}` : 'WordPress connection failed.',
      502,
    );
  }
}

function isCoordinate(value: number | null | undefined, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export class DisabledWordPressClient implements WordPressProvider {
  async getPluginStatus(): Promise<WordPressPluginStatus> {
    return {
      state: 'unknown',
      requiredVersion: REQUIRED_WORDPRESS_PLUGIN_VERSION,
      seoGeneratorVersion: SEO_GENERATOR_VERSION,
      message: 'WordPress is not configured on the server.',
    };
  }

  async getStatuses(): Promise<Record<number, WordPressPostStatus>> {
    throw new WordPressRequestError('WordPress is not configured on the server.', 503);
  }

  async getStatus(): Promise<WordPressPostStatus> {
    return {
      state: 'unknown',
      label: 'Unknown',
      currentSeoVersion: SEO_GENERATOR_VERSION,
      message: 'WordPress is not configured on the server.',
    };
  }

  async pushJob(): Promise<WordPressPostStatus> {
    throw new WordPressRequestError('WordPress is not configured on the server.', 503);
  }

  async regenerateJob(): Promise<WordPressPostStatus> {
    throw new WordPressRequestError('WordPress is not configured on the server.', 503);
  }

  async updateStatus(): Promise<WordPressPostStatus> {
    throw new WordPressRequestError('WordPress is not configured on the server.', 503);
  }
}

export const serviceTitanJobSlug = (serviceTitanJobId: number): string =>
  `servicetitan-job-${serviceTitanJobId}`;

const postToStatus = (post: WordPressPost): WordPressPostStatus => ({
  state: 'exists',
  label: humanizeStatus(post.status),
  postId: post.id,
  postStatus: post.status,
  ...(post.link ? { link: post.link } : {}),
});

const decorateSeoStatus = (
  status: WordPressPostStatus & { seoModified?: boolean },
  knownVersion = status.seoVersion,
  knownModified = status.seoModified,
): WordPressPostStatus => {
  const { seoModified: _seoModified, ...baseStatus } = status;
  if (status.state !== 'exists') return { ...baseStatus, currentSeoVersion: SEO_GENERATOR_VERSION };
  const seoState = knownModified
    ? 'modified'
    : !knownVersion
      ? 'legacy'
      : knownVersion < SEO_GENERATOR_VERSION
        ? 'outdated'
        : knownVersion > SEO_GENERATOR_VERSION
          ? 'newer'
          : 'current';
  return {
    ...baseStatus,
    ...(knownVersion ? { seoVersion: knownVersion } : {}),
    currentSeoVersion: SEO_GENERATOR_VERSION,
    seoState,
  };
};

const generatedPostFields = (job: JobListItem, approvedCopy?: ApprovedPostCopy): {
  title?: string;
  content?: string;
  excerpt?: string;
  stji_generation: { version: number; jobId: number };
  stji_zipcode?: string;
} => {
  const zipcode = normalizeZipcode(job.location.zip);
  return {
    title: approvedCopy?.title || `${normalizeServiceName(job.jobName)} in ${formatCityState(job)}`,
  content: approvedCopy?.bodyHtml ? buildAiPostContent(approvedCopy.bodyHtml) : buildPostContent(job),
    excerpt: approvedCopy?.bodyHtml ? stripHtml(approvedCopy.bodyHtml).slice(0, 320) : buildPostExcerpt(job),
    stji_generation: { version: SEO_GENERATOR_VERSION, jobId: job.id },
    ...(zipcode ? { stji_zipcode: zipcode } : {}),
  };
};

const buildAiPostContent = (bodyHtml: string): string => bodyHtml
  .replace(/<p>/gi, '<!-- wp:paragraph -->\n<p>')
  .replace(/<\/p>/gi, '</p>\n<!-- /wp:paragraph -->')
  .replace(/<blockquote>/gi, '<!-- wp:quote -->\n<blockquote>')
  .replace(/<\/blockquote>/gi, '</blockquote>\n<!-- /wp:quote -->');

const humanizeStatus = (status: string): string =>
  status === 'publish'
    ? 'Published'
    : status.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatCityState = (job: JobListItem): string =>
  [job.location.city, job.location.state].filter((part) => part && part !== '—').join(', ');

const normalizeZipcode = (value: string): string | undefined => {
  const zipcode = value.trim();
  return /^\d{5}(?:-\d{4})?$/.test(zipcode) ? zipcode : undefined;
};

const cleanLocationPart = (value: string): string => value === '—' ? '' : value.trim().slice(0, 100);
const cleanState = (value: string): string => {
  const state = cleanLocationPart(value).toUpperCase();
  return /^[A-Z]{2}$/.test(state) ? state : '';
};

const buildPostContent = (job: JobListItem): string => {
  const serviceName = normalizeServiceName(job.jobName);
  const location = formatCityState(job);
  const equipmentNames = formatEquipmentNames(job.equipmentNames);
  const safeDetails = [
    job.seoDetails?.issue ? `The visit addressed ${job.seoDetails.issue}.` : '',
    job.seoDetails?.action ? `The work included ${job.seoDetails.action}.` : '',
    equipmentNames ? `The equipment involved ${job.equipmentNames?.length === 1 ? 'was' : 'included'} ${equipmentNames}.` : '',
  ].filter(Boolean).join(' ');
  return [
    '<!-- wp:paragraph -->',
    `<p>Our team recently completed a ${escapeHtml(serviceName.toLowerCase())} project in ${escapeHtml(location)}.</p>`,
    '<!-- /wp:paragraph -->',
    ...(safeDetails ? [
      '<!-- wp:heading {"level":2} -->',
      '<h2>Service overview</h2>',
      '<!-- /wp:heading -->',
      '<!-- wp:paragraph -->',
      `<p>${escapeHtml(safeDetails)}</p>`,
      '<!-- /wp:paragraph -->',
    ] : []),
    '<!-- wp:heading {"level":2} -->',
    `<h2>About ${escapeHtml(serviceName.toLowerCase())}</h2>`,
    '<!-- /wp:heading -->',
    '<!-- wp:paragraph -->',
    `<p>${escapeHtml(serviceGuidance(serviceName))}</p>`,
    '<!-- /wp:paragraph -->',
    '<!-- wp:heading {"level":2} -->',
    `<h2>Need ${escapeHtml(serviceName.toLowerCase())} in ${escapeHtml(location)}?</h2>`,
    '<!-- /wp:heading -->',
    '<!-- wp:paragraph -->',
    '<p>Contact our team to discuss your service needs and schedule an appointment.</p>',
    '<!-- /wp:paragraph -->',
  ].join('\n');
};

const buildPostExcerpt = (job: JobListItem): string => {
  const serviceName = normalizeServiceName(job.jobName);
  const equipmentNames = formatEquipmentNames(job.equipmentNames);
  return equipmentNames
    ? `Our team recently completed ${serviceName.toLowerCase()} involving ${equipmentNames} in ${formatCityState(job)}.`
    : `Our team recently completed ${serviceName.toLowerCase()} in ${formatCityState(job)}. Learn about the service and when to request professional help.`;
};

const formatEquipmentNames = (names: string[] | undefined): string => {
  const safeNames = (names || []).filter(Boolean).slice(0, 5);
  if (safeNames.length < 2) return safeNames[0] || '';
  if (safeNames.length === 2) return `${safeNames[0]} and ${safeNames[1]}`;
  return `${safeNames.slice(0, -1).join(', ')}, and ${safeNames.at(-1)}`;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!);

const stripHtml = (value: string): string => value.replace(/<[^>]*>/g, '').trim();

const parseJson = async <T>(response: Response): Promise<T> => {
  try {
    return await response.json() as T;
  } catch {
    throw new WordPressRequestError('WordPress returned an invalid JSON response.', 502);
  }
};

const safeJson = async <T>(response: Response): Promise<T | undefined> => {
  try {
    return await response.json() as T;
  } catch {
    return undefined;
  }
};

const pluginApiUrl = (collectionUrl: string, route: string): string => {
  const url = new URL(collectionUrl);
  const restIndex = url.pathname.indexOf('/wp-json/');
  const sitePath = restIndex >= 0 ? url.pathname.slice(0, restIndex) : '';
  url.pathname = `${sitePath}/wp-json/servicetitan-job-integration/v1/${route}`;
  url.search = '';
  return url.toString();
};

const wordPressMediaUrl = (collectionUrl: string): string => {
  const url = new URL(collectionUrl);
  const restIndex = url.pathname.indexOf('/wp-json/');
  if (restIndex < 0) throw new WordPressRequestError('WordPress REST collection URL is invalid.', 500);
  url.pathname = `${url.pathname.slice(0, restIndex)}/wp-json/wp/v2/media`;
  url.search = '';
  return url.toString();
};

const safeMediaFilename = (value: string): string =>
  value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'job-image.jpg';

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
};
