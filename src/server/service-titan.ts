import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import type { ServiceTitanConfig } from './config.js';
import { extractSafeSeoDetails } from './job-seo.js';
import { ServiceTitanRequestError } from './service-titan-error.js';
import { filterJobsByLocationIds, serviceTitanJobsListParams } from './service-titan-query.js';
import { publicFetch } from './saas/public-fetch.js';

import type { ApiHealthCheck, ApiHealthReport } from '../shared/api-health.js';

import { getRecentFormContent } from './form-content-cache.js';
import { invoiceWorkContent, jobDescriptionPreview, objectValue, safeWorkText } from './work-content.js';
import type { WorkContent } from '../shared/work-content.js';

interface TokenResponse { access_token: string; expires_in: number; }
interface PaginatedResponse<T> { page: number; pageSize: number; hasMore: boolean; totalCount?: number; data: T[]; }
interface ServiceTitanJob extends Record<string, unknown> { id: number; jobNumber: string; locationId: number; jobTypeId: number; jobStatus: string; summary?: string; completedOn?: string; modifiedOn?: string; sourceCopyStatus?: 'missing' | 'limited' | 'available'; }
interface ServiceTitanJobType { id: number; name: string; }
interface ServiceTitanTagType { id: number; name: string; }
interface ServiceTitanLocation { id: number; address?: { street?: string; unit?: string; city?: string; state?: string; zip?: string; }; }
interface ServiceTitanInstalledEquipment { id: number; name?: string | null; }
interface ServiceTitanHistoryEntry { id?: string | number; eventType?: string; date?: string; memo?: string; }
interface ServiceTitanNote { text?: string; createdOn?: string; modifiedOn?: string; isPinned?: boolean; }
interface ServiceTitanAttachment extends Record<string, unknown> {
  id?: string | number;
  attachmentId?: string | number;
  fileId?: string | number;
  originalFileName?: string;
  fileName?: string;
  name?: string;
  contentType?: string;
  mimeType?: string;
  mediaType?: string;
  type?: string;
  url?: string;
}

export interface JobsQuery { startDate: string; endDateExclusive: string; page: number; pageSize: number; zip?: string; }
export interface JobListItem extends WorkContent {
  id: number;
  jobNumber: string;
  jobName: string;
  descriptionPreview?: string;
  status: string;
  completedOn?: string;
  modifiedOn?: string;
  location: { address?: string; city: string; state: string; zip: string; };
  summaryText?: string;
  seoDetails?: { issue?: string; action?: string; };
  equipmentNames?: string[];
  tagNames?: string[];
  attachments?: JobAttachment[];
  sourceCopyStatus?: 'missing' | 'limited' | 'available';
}
export interface JobsResult { data: JobListItem[]; page: number; pageSize: number; hasMore: boolean; totalCount?: number; }
export interface JobAttachment { id: string; fileName: string; contentType: string; }
export interface JobContentHistoryItem { id: string; source: 'history' | 'note'; type: string; date: string; content: string; promptEligible: boolean; }
export interface JobDetails { job: ServiceTitanJob; summary: JobListItem; attachments: JobAttachment[]; history: JobContentHistoryItem[]; }
export interface JobImage { id: string; fileName: string; contentType: string; bytes: Uint8Array; }
export interface JobsProvider {
  getScannerJobs?(page: number): Promise<JobsResult>;
  getRawJob?(jobId: number): Promise<unknown>;
  getJobs(query: JobsQuery): Promise<JobsResult>;
  getJobImageCandidates?(jobId: number): Promise<JobAttachment[]>;
  getJob(jobId: number): Promise<JobListItem>;
  getJobDetails(jobId: number): Promise<JobDetails>;
  getJobImage(jobId: number, attachmentId: string): Promise<JobImage>;
}

const TAG_CATALOG_CACHE_MS = 24 * 60 * 60_000;
const TAG_CATALOG_CACHE_MAX_ENTRIES = 100;
const tagCatalogCache = new Map<string, { expiresAt: number; request: Promise<ServiceTitanTagType[]> }>();

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jfif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp']);
const IMAGE_MEDIA_TYPES = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/pjpeg', 'image/png', 'image/tiff', 'image/webp']);
const ATTACHMENT_CACHE_MS = 5 * 60_000;
const ATTACHMENT_CACHE_MAX_ENTRIES = 500;
const ZIP_LOCATIONS_CACHE_MS = 24 * 60 * 60_000;
const ZIP_LOCATIONS_CACHE_MAX_ENTRIES = 50;
const ZIP_LOCATIONS_CACHE_MAX_IDS = 500;
const ZIP_SCAN_PAGE_SIZE = 500;
const ZIP_SCAN_MAX_PAGES = 20;
const ZIP_SCAN_MAX_JOBS = ZIP_SCAN_PAGE_SIZE * ZIP_SCAN_MAX_PAGES;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const zipLocationsCache = new Map<string, { expiresAt: number; request: Promise<Set<number>> }>();

export class ServiceTitanClient implements JobsProvider {
  private readonly api: AxiosInstance;
  private readonly rawResponses = new AsyncLocalStorage<Array<{ endpoint: string; params?: unknown; status?: number; body: unknown }>>();
  private accessToken?: { value: string; expiresAt: number };
  private tokenRequest: Promise<string> | undefined;
  private readonly workCache = new Map<number, { expiresAt: number; request: Promise<WorkContent> }>();
  private invoiceDeniedUntil = 0;
  private readonly invoicePreviewCache = new Map<string, { expiresAt: number; text: string }>();
  private readonly invoicePreviewRequests = new Map<string, Promise<Map<number, string>>>();
  private readonly attachmentCache = new Map<number, { expiresAt: number; request: Promise<ServiceTitanAttachment[]> }>();

  constructor(private readonly config: ServiceTitanConfig, private readonly imageFetch: typeof fetch = publicFetch) {
    this.api = (axios as unknown as { create(): AxiosInstance }).create();
    this.api.defaults.timeout = 20_000;
    this.api.defaults.maxContentLength = MAX_IMAGE_BYTES;
    this.api.defaults.maxRedirects = 0;
  }

  async getJobs(query: JobsQuery): Promise<JobsResult> {
    try {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey };
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      const zipResults = query.zip ? await this.getZipFilteredJobs(query, headers, tenantPath) : undefined;
      const jobsResponse = query.zip ? undefined : await this.getJobsPage(query, headers, tenantPath);
      const pageJobs = zipResults?.data ?? jobsResponse!.data.data;
      const [enrichedJobs, invoicePreviews] = await Promise.all([this.enrichJobs(pageJobs, headers, tenantPath), this.getListInvoicePreviews(pageJobs, headers, tenantPath)]);

      return {
        data: enrichedJobs.map((job, index) => {
          const summary = redactHistoryContent(pageJobs[index]!.summary).trim();
          const wordCount = summary.split(/\s+/).filter(Boolean).length;
          return {
            ...job,
            descriptionPreview: invoicePreviews.get(job.id) || job.descriptionPreview || '',
            attachments: [],
            sourceCopyStatus: pageJobs[index]!.sourceCopyStatus || (wordCount === 0 ? 'missing' : wordCount < 10 ? 'limited' : 'available'),
          };
        }),
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.zip ? zipResults!.hasMore : jobsResponse!.data.hasMore,
        ...(!query.zip && jobsResponse!.data.totalCount !== undefined ? { totalCount: jobsResponse!.data.totalCount } : {}),
      };
    } catch (error) {
      throw this.toRequestError(error);
    }
  }

  /** Scanner order is independent of the job browser's appointment-date filters. */
  async getScannerJobs(page: number): Promise<JobsResult> {
    try {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey };
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      const response = await this.get<PaginatedResponse<ServiceTitanJob>>(`${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs`, { headers, params: { jobStatus: 'Completed', sort: '-CreatedOn', page, pageSize: 25, includeTotal: false } });
      return { page, pageSize: 25, hasMore: response.data.hasMore, data: response.data.data.slice(0,25).map(job => ({ id: job.id, jobNumber: job.jobNumber, jobName: `Job ${job.jobNumber}`, status: job.jobStatus, location: { city: '', state: '', zip: '' } })) };
    } catch (error) { throw this.toRequestError(error); }
  }

  /** Small read-only probes; response bodies and credentials never leave this method. */
  async checkApiHealth(includeOptional = true): Promise<ApiHealthReport> {
    const checks: ApiHealthCheck[] = [];
    const checkedAt = new Date().toISOString();
    const tenant = `tenant/${encodeURIComponent(this.config.tenantId)}`;
    let headers: Record<string, string> | undefined;
    const started = Date.now();
    try {
      headers = { Authorization: `Bearer ${await this.getAccessToken()}`, 'ST-App-Key': this.config.appKey };
      checks.push({ name: 'Authentication', endpoint: 'POST /connect/token', state: 'available', message: 'Credentials accepted.', durationMs: Date.now() - started });
    } catch {
      checks.push({ name: 'Authentication', endpoint: 'POST /connect/token', state: 'unavailable', message: 'Authentication failed or timed out. Verify the connection credentials.', durationMs: Date.now() - started });
    }
    const probe = async (name: string, path: string, params?: Record<string, unknown>): Promise<unknown> => {
      const endpoint = `GET /${path.replace(tenant, 'tenant/{tenant}')}`;
      if (!headers) {
        checks.push({ name, endpoint, state: 'not_checked', message: 'Authentication is required.' });
        return;
      }
      const start = Date.now();
      try {
        const response = await this.api.get(`${this.config.apiBaseUrl}/${path}`, { headers, params, timeout: 5_000 });
        checks.push({ name, endpoint, state: 'available', message: 'API request succeeded.', statusCode: response.status, durationMs: Date.now() - start });
        return response.data;
      } catch (error) {
        const status = isAxiosError(error) ? error.response?.status : undefined;
        checks.push({ name, endpoint, state: 'unavailable', message: status === 401 || status === 403 ? 'Access denied. Check the app permissions and tenant access.' : status === 429 ? 'ServiceTitan rate limit reached. Try again later.' : status === 404 ? 'Endpoint or record was not found.' : 'Request failed or timed out.', ...(status ? { statusCode: status } : {}), durationMs: Date.now() - start });
      }
    };
    const jobs = await probe('Jobs', `jpm/v2/${tenant}/jobs`, { page: 1, pageSize: 1 }) as { data?: Array<{ id?: number }> } | undefined;
    // Two concurrent probes at most to avoid a diagnostic request burst.
    for (const batch of [
      [['Locations', `crm/v2/${tenant}/locations`], ['Job types', `jpm/v2/${tenant}/job-types`]],
      [['Tag types', `settings/v2/${tenant}/tag-types`], ['Installed equipment', `equipmentsystems/v2/${tenant}/installed-equipment`]],
    ]) await Promise.all(batch.map(([name, path]) => probe(name!, path!, { page: 1, pageSize: 1 })));
    const jobId = jobs?.data?.[0]?.id;
    for (const [name, path] of [
      ['Job details', `jpm/v2/${tenant}/jobs/{jobId}`],
      ['Job history', `jpm/v2/${tenant}/jobs/{jobId}/history`],
      ['Job notes', `jpm/v2/${tenant}/jobs/{jobId}/notes`],
      ['Job attachments', `forms/v2/${tenant}/jobs/{jobId}/attachments`],
    ]) {
      if (Number.isSafeInteger(jobId) && jobId! > 0) {
        const body = await probe(name!, path!.replace('{jobId}', String(jobId)), { page: 1, pageSize: 1 });
        if (includeOptional && name === 'Job details') {
          const present = Object.hasOwn(objectValue(body), 'summaryOfWork');
          checks.push({ name: 'Summary of Work', endpoint: 'Field: jobs/{jobId}.summaryOfWork', optional: true,
            state: present ? 'available' : 'not_checked', message: present ? safeWorkText(objectValue(body).summaryOfWork) ? 'Field is available and populated.' : 'Field is available but empty on the sample job.' : 'Field was not returned on the sample job.' });
        }
      }
      else checks.push({ name: name!, endpoint: `GET /${path!.replace(tenant, 'tenant/{tenant}')}`, state: 'not_checked', message: 'No sample job was available from Jobs.' });
    }
    if (includeOptional) {
      if (!checks.some((check) => check.name === 'Summary of Work')) checks.push({ name: 'Summary of Work', endpoint: 'Field: jobs/{jobId}.summaryOfWork', optional: true, state: 'not_checked', message: 'No sample job was available.' });
      for (const [name, path] of [
        ['Invoices', `accounting/v2/${tenant}/invoices`],
        ['Forms definitions', `forms/v2/${tenant}/forms`],
        ['Form submissions', `forms/v2/${tenant}/submissions`],
      ]) {
        await probe(name!, path!, { page: 1, pageSize: 1, ...(name === 'Invoices' && jobId ? { jobId } : {}) });
        checks[checks.length - 1]!.optional = true;
      }
    }
    checks.push({ name: 'Attachment download', endpoint: 'GET /forms/v2/tenant/{tenant}/jobs/attachment/{id}', state: 'not_checked', message: 'Check an image in Job Details to verify downloads. Health checks do not download original files.' });
    return { checkedAt, checks };
  }

  /** Verify auth and the tenant-level job read permission without returning customer data. */
  async validateAccess(): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      await this.get(`${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs`, {
        headers: { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey },
        params: { page: 1, pageSize: 1 },
      });
    } catch (error) { throw this.toRequestError(error); }
  }

  async getJobImageCandidates(jobId: number): Promise<JobAttachment[]> {
    try {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey };
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      return (await this.getAttachments(jobId, headers, tenantPath))
        .filter((attachment) => attachmentId(attachment) && isImageAttachment(attachment))
        .map(publicAttachment);
    } catch (error) {
      throw this.toRequestError(error);
    }
  }

  async getJob(jobId: number): Promise<JobListItem> {
    return (await this.getJobDetails(jobId)).summary;
  }

  /** Capture the response bodies from the same read pipeline used for job content. */
  async getRawJob(jobId: number): Promise<unknown> {
    const responses: Array<{ endpoint: string; params?: unknown; status?: number; body: unknown }> = [];
    return this.rawResponses.run(responses, async () => {
      await this.getJobDetails(jobId);
      return { jobId, responses };
    });
  }

  private async get<T = unknown>(url: string, options: AxiosRequestConfig = {}) {
    const response = await this.api.get<T>(url, options);
    this.rawResponses.getStore()?.push({
      endpoint: new URL(url).pathname,
      ...(options.params ? { params: options.params } : {}),
      status: response.status,
      body: response.data,
    });
    return response;
  }

  async getJobDetails(jobId: number): Promise<JobDetails> {
    try {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey };
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      const [response, attachmentRecords, historyResponse, notes] = await Promise.all([
        this.get<ServiceTitanJob>(`${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs/${jobId}`, { headers }),
        this.getAttachments(jobId, headers, tenantPath),
        this.get<{ history?: ServiceTitanHistoryEntry[] }>(
          `${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs/${jobId}/history`,
          { headers },
        ),
        this.getJobNotes(jobId, headers, tenantPath),
      ]);
      const jobs = await this.enrichJobs([response.data], headers, tenantPath, true);
      const job = jobs[0];
      if (!job) throw new ServiceTitanRequestError('ServiceTitan job was not found.', 404);
      const seoDetails = extractSafeSeoDetails(response.data.summary);
      const equipmentNames = await this.getEquipmentNames(response.data.equipmentIds, headers, tenantPath);
      const workContent = await this.getWorkContent(jobId, headers, tenantPath);
      const workSummary = safeWorkText(response.data.summaryOfWork, 2000);
      const summary = {
        ...job,
        ...workContent,
        descriptionPreview: jobDescriptionPreview({ ...response.data, invoiceSummary: workContent.invoiceSummaries?.[0] }),
        ...(workSummary ? { workSummary } : {}),
        ...(redactHistoryContent(response.data.summary) ? { summaryText: redactHistoryContent(response.data.summary).slice(0, 2_000) } : {}),
        ...(Object.keys(seoDetails).length > 0 ? { seoDetails } : {}),
        ...(equipmentNames.length > 0 ? { equipmentNames } : {}),
      };
      return {
        job: response.data,
        summary,
        attachments: attachmentRecords.filter((attachment) => attachmentId(attachment) && isImageAttachment(attachment)).map(publicAttachment),
        history: prepareHistoryItems(historyResponse.data.history || [], notes),
      };
    } catch (error) {
      throw this.toRequestError(error);
    }
  }

  /** Fetch the listed jobs' canonical invoices in one batch, without forms or item enrichment. */
  private async getListInvoicePreviews(jobs: ServiceTitanJob[], headers: Record<string, string>, tenantPath: string): Promise<Map<number, string>> {
    const previews = new Map<number, string>();
    const missing = jobs.filter(job => {
      if (!Number.isSafeInteger(job.invoiceId) || Number(job.invoiceId) <= 0) return false;
      const entry = this.invoicePreviewCache.get(`${job.id}:${job.invoiceId}`);
      if (entry && entry.expiresAt > Date.now()) { previews.set(job.id, entry.text); return false; }
      return true;
    }).slice(0, 50);
    if (!missing.length || this.invoiceDeniedUntil > Date.now()) return previews;
    const ids = [...new Set(missing.map(job => Number(job.invoiceId)))].sort((a,b) => a-b).join(',');
    let request = this.invoicePreviewRequests.get(ids);
    if (!request) {
      request = (async () => {
        const found = new Map<number, string>();
        try {
          const response = await this.get<unknown>(`${this.config.apiBaseUrl}/accounting/v2/${tenantPath}/invoices`, { headers, params: { ids, page: 1, pageSize: 50 }, timeout: 5000 });
          const data = objectValue(response.data).data;
          if (!Array.isArray(data)) return found;
          for (const job of missing) {
            const matching = data.filter(raw => objectValue(raw).id === job.invoiceId);
            const summary = invoiceWorkContent(matching, job.id).invoiceSummaries?.[0];
            found.set(job.id, summary ? jobDescriptionPreview({ invoiceSummary: summary }) : '');
          }
          for (const [key, entry] of this.invoicePreviewCache) if (entry.expiresAt <= Date.now()) this.invoicePreviewCache.delete(key);
          for (const job of missing) {
            if (this.invoicePreviewCache.size >= 500) this.invoicePreviewCache.delete(this.invoicePreviewCache.keys().next().value!);
            this.invoicePreviewCache.set(`${job.id}:${job.invoiceId}`, { expiresAt: Date.now() + 5 * 60_000, text: found.get(job.id) || '' });
          }
        } catch (error) {
          const status = isAxiosError(error) ? error.response?.status : undefined;
          if (status === 401 || status === 403 || status === 429) this.invoiceDeniedUntil = Date.now() + 60_000;
        }
        return found;
      })().finally(() => { this.invoicePreviewRequests.delete(ids); });
      this.invoicePreviewRequests.set(ids, request);
    }
    for (const [id, text] of await request) previews.set(id, text);
    return previews;
  }

  private getWorkContent(jobId: number, headers: Record<string, string>, tenantPath: string): Promise<WorkContent> {
    const cached = this.workCache.get(jobId);
    if (cached && cached.expiresAt > Date.now()) return cached.request;
    for (const [key, entry] of this.workCache) if (entry.expiresAt <= Date.now()) this.workCache.delete(key);
    if (this.workCache.size >= 100) this.workCache.delete(this.workCache.keys().next().value!);
    const request = Promise.all([
      this.fetchInvoiceWorkContent(jobId, headers, tenantPath),
      getRecentFormContent(this.config, jobId, async (params) => (await this.get(`${this.config.apiBaseUrl}/forms/v2/${tenantPath}/submissions`, { headers, params, timeout: 5000 })).data),
    ]).then(([invoices, forms]) => ({ ...invoices, ...forms, contentSources: [...(invoices.contentSources || []), ...(forms.contentSources || [])] }));
    this.workCache.set(jobId, { expiresAt: Date.now() + 5 * 60_000, request });
    return request;
  }

  private async fetchInvoiceWorkContent(jobId: number, headers: Record<string, string>, tenantPath: string): Promise<WorkContent> {
    const unavailable: WorkContent = { contentSources: [{ source: 'invoices', state: 'unavailable', message: 'Invoice work descriptions could not be loaded. Existing job sources remain available.' }] };
    if (this.invoiceDeniedUntil > Date.now()) return unavailable;
    try {
      const invoices: unknown[] = [];
      let hasMore = false;
      for (let page = 1; page <= 5; page++) {
        const response = await this.get<unknown>(`${this.config.apiBaseUrl}/accounting/v2/${tenantPath}/invoices`, { headers, params: { jobId, page, pageSize: 20 }, timeout: 5000 });
        const body = objectValue(response.data);
        if (!Array.isArray(body.data)) return unavailable;
        invoices.push(...body.data.slice(0, 20));
        hasMore = body.hasMore === true;
        if (!hasMore) break;
      }
      return { ...invoiceWorkContent(invoices, jobId), contentSources: [{ source: 'invoices', state: hasMore ? 'partial' : 'available', message: hasMore ? 'Invoice scan limit reached; work descriptions may be incomplete.' : 'Job-linked invoice descriptions loaded. Billed scope does not confirm completed actions.' }] };
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      if (status === 401 || status === 403 || status === 429) this.invoiceDeniedUntil = Date.now() + 60_000;
      return unavailable;
    }
  }

  async getJobImage(jobId: number, attachmentIdValue: string): Promise<JobImage> {
    try {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': this.config.appKey };
      const tenantPath = `tenant/${encodeURIComponent(this.config.tenantId)}`;
      const attachments = await this.getAttachments(jobId, headers, tenantPath);
      const attachment = attachments.find((candidate) => attachmentId(candidate) === attachmentIdValue && isImageAttachment(candidate));
      if (!attachment) throw new ServiceTitanRequestError('The selected job image was not found.', 404);
      const response = await this.get<ArrayBuffer>(
        `${this.config.apiBaseUrl}/forms/v2/${tenantPath}/jobs/attachment/${encodeURIComponent(attachmentIdValue)}`,
        { headers, responseType: 'arraybuffer', timeout: 90_000,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 302 },
      );
      // The API hands downloads off to a signed Azure Blob URL. Never enable
      // automatic redirects on the authenticated client: ST-App-Key could leak.
      const download = response.status === 302
        ? await this.downloadImageRedirect(response.headers.location)
        : { bytes: new Uint8Array(response.data), contentType: response.headers['content-type'] };
      const bytes = download.bytes;
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new ServiceTitanRequestError('The selected image is empty or larger than 15 MB.', 413);
      }
      const metadata = publicAttachment(attachment);
      const declaredType = String(download.contentType || '').split(';', 1)[0]!.trim().toLowerCase();
      const contentType = !declaredType || declaredType === 'application/octet-stream'
        ? imageSignatureType(bytes) : declaredType;
      if (!IMAGE_MEDIA_TYPES.has(contentType)) {
        throw new ServiceTitanRequestError('ServiceTitan returned an unsupported image response.', 502);
      }
      return {
        ...metadata,
        contentType,
        bytes,
      };
    } catch (error) {
      throw this.toRequestError(error);
    }
  }

  private async downloadImageRedirect(location: unknown): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    try {
      const url = new URL(typeof location === 'string' ? location : '');
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)) {
        throw new Error('Invalid image storage destination.');
      }
      // publicFetch checks DNS at connection time and rejects further redirects.
      // No API credentials or caller-supplied headers cross this boundary.
      const response = await this.imageFetch(url, { redirect: 'error', signal: AbortSignal.timeout(90_000) });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Image storage request failed.');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
          throw new ServiceTitanRequestError('The selected image is empty or larger than 15 MB.', 413);
        }
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) {
            throw new ServiceTitanRequestError('The selected image is empty or larger than 15 MB.', 413);
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return { bytes: Buffer.concat(chunks, size), contentType: response.headers.get('content-type') };
    } catch (error) {
      if (error instanceof ServiceTitanRequestError) throw error;
      // Signed URLs are credentials; never expose fetch error messages containing them.
      throw new ServiceTitanRequestError('ServiceTitan image storage could not complete the download.', 502);
    }
  }

  private async getLocationIdsByZip(
    zip: string,
    headers: Record<string, string>,
    tenantPath: string,
  ): Promise<Set<number>> {
    const cacheKey = `${this.config.apiBaseUrl}:${this.config.tenantId}:${this.config.clientId}:${zip}`;
    const cached = zipLocationsCache.get(cacheKey);
    if (!this.rawResponses.getStore() && cached && cached.expiresAt > Date.now()) return cached.request;
    for (const [key, value] of zipLocationsCache) {
      if (value.expiresAt <= Date.now()) zipLocationsCache.delete(key);
    }
    if (zipLocationsCache.size >= ZIP_LOCATIONS_CACHE_MAX_ENTRIES) zipLocationsCache.delete(zipLocationsCache.keys().next().value!);

    const request = this.fetchLocationIdsByZip(zip, headers, tenantPath);
    zipLocationsCache.set(cacheKey, { expiresAt: Date.now() + ZIP_LOCATIONS_CACHE_MS, request });
    try {
      const ids = await request;
      if (ids.size > ZIP_LOCATIONS_CACHE_MAX_IDS) zipLocationsCache.delete(cacheKey);
      return ids;
    } catch (error) {
      zipLocationsCache.delete(cacheKey);
      throw error;
    }
  }

  private async fetchLocationIdsByZip(
    zip: string,
    headers: Record<string, string>,
    tenantPath: string,
  ): Promise<Set<number>> {
    const ids = new Set<number>();
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > ZIP_SCAN_MAX_PAGES) throw new ServiceTitanRequestError('ServiceTitan returned too many locations for this ZIP search.', 502);
      const response = await this.get<PaginatedResponse<ServiceTitanLocation>>(
        `${this.config.apiBaseUrl}/crm/v2/${tenantPath}/locations`,
        { headers, params: { zip, active: 'Any', page, pageSize: ZIP_SCAN_PAGE_SIZE } },
      );
      for (const location of response.data.data) ids.add(location.id);
      hasMore = response.data.hasMore;
      page += 1;
    }

    return ids;
  }

  private async getZipFilteredJobs(
    query: JobsQuery,
    headers: Record<string, string>,
    tenantPath: string,
  ): Promise<{ data: ServiceTitanJob[]; hasMore: boolean }> {
    return this.fetchZipFilteredJobs(query, headers, tenantPath);
  }

  private async fetchZipFilteredJobs(
    query: JobsQuery,
    headers: Record<string, string>,
    tenantPath: string,
  ): Promise<{ data: ServiceTitanJob[]; hasMore: boolean }> {
    const locationIds = await this.getLocationIdsByZip(query.zip!, headers, tenantPath);
    if (locationIds.size === 0) return { data: [], hasMore: false };

    const matchingJobs: ServiceTitanJob[] = [];
    const firstResultIndex = (query.page - 1) * query.pageSize;
    const targetCount = firstResultIndex + query.pageSize + 1;
    if (targetCount > ZIP_SCAN_MAX_JOBS) {
      throw new ServiceTitanRequestError('This page is too deep to safely filter by ZIP. Narrow the date range or move closer to the first page.', 422);
    }
    let page = 1;
    let hasMore = true;
    while (hasMore && matchingJobs.length < targetCount) {
      if (page > ZIP_SCAN_MAX_PAGES) {
        throw new ServiceTitanRequestError('This date range has too many jobs to safely filter by ZIP. Narrow the date range and try again.', 422);
      }
      const response = await this.getJobsPage(
        { ...query, page, pageSize: ZIP_SCAN_PAGE_SIZE },
        headers,
        tenantPath,
      );
      for (const job of filterJobsByLocationIds(response.data.data, locationIds) as ServiceTitanJob[]) {
        const summary = redactHistoryContent(job.summary).trim();
        const wordCount = summary.split(/\s+/).filter(Boolean).length;
        matchingJobs.push({
          id: job.id,
          jobNumber: job.jobNumber,
          locationId: job.locationId,
          jobTypeId: job.jobTypeId,
          jobStatus: job.jobStatus,
          descriptionPreview: jobDescriptionPreview(job),
          ...(Number.isSafeInteger(job.invoiceId) ? { invoiceId: job.invoiceId } : {}),
          ...(job.completedOn ? { completedOn: job.completedOn } : {}),
          sourceCopyStatus: wordCount === 0 ? 'missing' : wordCount < 10 ? 'limited' : 'available',
        });
        if (matchingJobs.length >= targetCount) break;
      }
      hasMore = response.data.hasMore;
      page += 1;
    }

    return {
      data: matchingJobs.slice(firstResultIndex, firstResultIndex + query.pageSize),
      hasMore: matchingJobs.length > firstResultIndex + query.pageSize,
    };
  }

  private getJobsPage(
    query: JobsQuery,
    headers: Record<string, string>,
    tenantPath: string,
  ) {
    return this.get<PaginatedResponse<ServiceTitanJob>>(
      `${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs`,
      { headers, params: serviceTitanJobsListParams(query) },
    );
  }

  private getAttachments(jobId: number, headers: Record<string, string>, tenantPath: string): Promise<ServiceTitanAttachment[]> {
    const cached = this.attachmentCache.get(jobId);
    if (!this.rawResponses.getStore() && cached && cached.expiresAt > Date.now()) return cached.request;
    for (const [id, entry] of this.attachmentCache) {
      if (entry.expiresAt <= Date.now()) this.attachmentCache.delete(id);
    }
    if (this.attachmentCache.size >= ATTACHMENT_CACHE_MAX_ENTRIES) {
      this.attachmentCache.delete(this.attachmentCache.keys().next().value!);
    }
    const request = this.get<PaginatedResponse<ServiceTitanAttachment> | ServiceTitanAttachment[] | { attachments?: ServiceTitanAttachment[] }>(
      `${this.config.apiBaseUrl}/forms/v2/${tenantPath}/jobs/${jobId}/attachments`,
      { headers },
    ).then((response) => attachmentRecords(response.data)).catch((error) => {
      this.attachmentCache.delete(jobId);
      throw error;
    });
    this.attachmentCache.set(jobId, { expiresAt: Date.now() + ATTACHMENT_CACHE_MS, request });
    return request;
  }

  private async getJobNotes(jobId: number, headers: Record<string, string>, tenantPath: string): Promise<ServiceTitanNote[]> {
    const notes: ServiceTitanNote[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      if (page > 100) throw new ServiceTitanRequestError('ServiceTitan job notes exceeded the pagination safety limit.', 502);
      const response = await this.get<PaginatedResponse<ServiceTitanNote>>(
        `${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/jobs/${jobId}/notes`,
        { headers, params: { page, pageSize: 50 } },
      );
      notes.push(...response.data.data);
      hasMore = response.data.hasMore;
      page += 1;
    }
    return notes;
  }

  private async getEquipmentNames(
    equipmentIdsValue: unknown,
    headers: Record<string, string>,
    tenantPath: string,
  ): Promise<string[]> {
    if (!Array.isArray(equipmentIdsValue)) return [];
    const equipmentIds = unique(equipmentIdsValue.filter((id): id is number => Number.isSafeInteger(id) && id > 0));
    if (equipmentIds.length === 0) return [];
    const equipment = await this.getByIds<ServiceTitanInstalledEquipment>(
      `${this.config.apiBaseUrl}/equipmentsystems/v2/${tenantPath}/installed-equipment`,
      equipmentIds,
      headers,
      {},
    );
    return [...new Set(equipment.map((item) => publicEquipmentName(item.name)).filter((name): name is string => Boolean(name)))].slice(0, 5);
  }

  private async enrichJobs(
    jobs: ServiceTitanJob[],
    headers: Record<string, string>,
    tenantPath: string,
    includeStreetAddress = false,
  ): Promise<JobListItem[]> {
    const locationIds = unique(jobs.map((job) => job.locationId));
    const jobTypeIds = unique(jobs.map((job) => job.jobTypeId));
    const tagIds = unique(jobs.flatMap((job) => Array.isArray(job.tagTypeIds)
      ? job.tagTypeIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : []));
    const [locations, jobTypes, tagTypes] = await Promise.all([
      this.getByIds<ServiceTitanLocation>(`${this.config.apiBaseUrl}/crm/v2/${tenantPath}/locations`, locationIds, headers, { active: 'Any' }),
      this.getByIds<ServiceTitanJobType>(`${this.config.apiBaseUrl}/jpm/v2/${tenantPath}/job-types`, jobTypeIds, headers, { active: 'Any' }),
      this.getTagTypes(tagIds, headers, tenantPath),
    ]);
    const locationById = new Map(locations.map((location) => [location.id, location]));
    const jobTypeById = new Map(jobTypes.map((jobType) => [jobType.id, jobType]));
    const tagById = new Map(tagTypes.map((tag) => [tag.id, tag.name]));

    return jobs.map((job) => {
      const address = locationById.get(job.locationId)?.address;
      return {
        id: job.id,
        jobNumber: job.jobNumber,
        jobName: jobTypeById.get(job.jobTypeId)?.name || `Job ${job.jobNumber}`,
        descriptionPreview: typeof job.descriptionPreview === 'string' ? job.descriptionPreview : jobDescriptionPreview(job),
        status: job.jobStatus,
        tagNames: unique(Array.isArray(job.tagTypeIds) ? job.tagTypeIds : [])
          .map((id) => tagById.get(id)).filter((name): name is string => Boolean(name)),
        ...(job.completedOn ? { completedOn: job.completedOn } : {}),
        ...(job.modifiedOn ? { modifiedOn: job.modifiedOn } : {}),
        location: {
          ...(includeStreetAddress && address ? { address: formatServiceAddress(address) } : {}),
          city: address?.city || '—',
          state: address?.state || '—',
          zip: address?.zip || '—',
        },
      };
    });
  }

  private async getTagTypes(ids: number[], headers: Record<string, string>, tenantPath: string): Promise<ServiceTitanTagType[]> {
    if (ids.length === 0) return [];
    // Share across clients (including queue workers), but isolate credentials and tenants.
    const key = createHash('sha256').update(JSON.stringify([
      this.config.apiBaseUrl, this.config.authUrl, this.config.tenantId,
      this.config.clientId, this.config.clientSecret, this.config.appKey,
    ])).digest('hex');
    if (this.rawResponses.getStore()) {
      return (await this.fetchTagCatalog(headers, tenantPath)).filter((tag) => ids.includes(tag.id));
    }
    for (const [cacheKey, entry] of tagCatalogCache) {
      if (entry.expiresAt <= Date.now()) tagCatalogCache.delete(cacheKey);
    }
    let entry = tagCatalogCache.get(key);
    if (!entry) {
      if (tagCatalogCache.size >= TAG_CATALOG_CACHE_MAX_ENTRIES) {
        tagCatalogCache.delete(tagCatalogCache.keys().next().value!);
      }
      const request = this.fetchTagCatalog(headers, tenantPath);
      entry = { expiresAt: Date.now() + TAG_CATALOG_CACHE_MS, request };
      tagCatalogCache.set(key, entry);
      const current = entry;
      void request.catch(() => {
        if (tagCatalogCache.get(key) === current) tagCatalogCache.delete(key);
      });
    }
    return (await entry.request).filter((tag) => ids.includes(tag.id));
  }

  private async fetchTagCatalog(headers: Record<string, string>, tenantPath: string): Promise<ServiceTitanTagType[]> {
    const tags: ServiceTitanTagType[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.get<PaginatedResponse<ServiceTitanTagType>>(
        `${this.config.apiBaseUrl}/settings/v2/${tenantPath}/tag-types`,
        { headers, params: { active: 'Any', page, pageSize: 500 } },
      );
      tags.push(...response.data.data);
      if (!response.data.hasMore) return tags;
    }
    throw new ServiceTitanRequestError('ServiceTitan tag types exceeded the pagination safety limit.', 502);
  }

  private async getByIds<T>(url: string, ids: number[], headers: Record<string, string>, extraParams: Record<string, string>): Promise<T[]> {
    if (ids.length === 0) return [];
    const response = await this.get<PaginatedResponse<T>>(url, {
      headers,
      params: { ids: ids.join(','), pageSize: 50, ...extraParams },
    });
    return response.data.data;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchAccessToken().finally(() => { this.tokenRequest = undefined; });
    }
    return this.tokenRequest;
  }

  private async fetchAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.api.post<TokenResponse>(this.config.authUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!response.data.access_token) throw new Error('ServiceTitan did not return an access token.');
    this.accessToken = { value: response.data.access_token, expiresAt: Date.now() + response.data.expires_in * 1_000 };
    return response.data.access_token;
  }

  private toRequestError(error: unknown): ServiceTitanRequestError {
    if (error instanceof ServiceTitanRequestError) return error;
    if (isAxiosError(error)) {
      const status = error.response?.status || 502;
      const data = error.response?.data as { title?: string; detail?: string; error_description?: string } | undefined;
      const detail = data?.title || data?.detail || data?.error_description || ((status === 401 || status === 403)
        ? 'ServiceTitan rejected the configured credentials or scopes.'
        : 'ServiceTitan could not complete the request.');
      return new ServiceTitanRequestError(detail, status >= 400 && status < 500 ? status : 502);
    }
    return new ServiceTitanRequestError(error instanceof Error ? error.message : 'ServiceTitan could not complete the request.', 502);
  }
}

const unique = (values: number[]): number[] => [...new Set(values)];

// Blob storage often serves images as octet-stream. Infer only from bytes,
// never from filenames, so HTML/SVG cannot become active same-origin content.
const imageSignatureType = (bytes: Uint8Array): string => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = b.subarray(0, 8).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e470d0a1a0a') return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (hex.startsWith('424d')) return 'image/bmp';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'image/tiff';
  if (b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return '';
};

const publicEquipmentName = (value: string | null | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, 120);
  return name || undefined;
};

const formatServiceAddress = (address: NonNullable<ServiceTitanLocation['address']>): string =>
  [address.street, address.unit, address.city, address.state, address.zip]
    .map((part) => String(part || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, 300);

const attachmentRecords = (body: PaginatedResponse<ServiceTitanAttachment> | ServiceTitanAttachment[] | { attachments?: ServiceTitanAttachment[] }): ServiceTitanAttachment[] => {
  if (Array.isArray(body)) return body;
  if ('data' in body && Array.isArray(body.data)) return body.data;
  return 'attachments' in body && Array.isArray(body.attachments) ? body.attachments : [];
};

const attachmentId = (attachment: ServiceTitanAttachment): string =>
  String(attachment.id || attachment.attachmentId || attachment.fileId || '').trim();

const attachmentName = (attachment: ServiceTitanAttachment): string =>
  String(attachment.originalFileName || attachment.fileName || attachment.name || `job-image-${attachmentId(attachment)}`).trim().slice(0, 255);

export const isImageAttachment = (attachment: ServiceTitanAttachment): boolean => {
  const mediaType = String(attachment.contentType || attachment.mimeType || attachment.mediaType || attachment.type || '').toLowerCase();
  if (mediaType.includes('/')) return IMAGE_MEDIA_TYPES.has(mediaType.split(';', 1)[0]!.trim());
  return [attachment.originalFileName, attachment.fileName, attachment.name, attachment.url].some((value) => {
    const match = String(value || '').split(/[?#]/, 1)[0]!.match(/\.([a-z0-9]+)$/i);
    return Boolean(match && IMAGE_EXTENSIONS.has(match[1]!.toLowerCase()));
  });
};

const publicAttachment = (attachment: ServiceTitanAttachment): JobAttachment => ({
  id: attachmentId(attachment),
  fileName: attachmentName(attachment),
  contentType: String(attachment.contentType || attachment.mimeType || attachment.mediaType || attachment.type || '').slice(0, 100),
});

export const prepareHistoryItems = (
  history: ServiceTitanHistoryEntry[],
  notes: ServiceTitanNote[],
): JobContentHistoryItem[] => {
  const historyCandidates: JobContentHistoryItem[] = history.flatMap((entry, index) => {
    const type = cleanHistoryText(entry.eventType) || 'Event';
    if (isAttachmentEventType(type)) return [];
    const memo = redactHistoryContent(entry.memo);
    if (!memo && type === 'Event') return [];
    return [{
      id: `history:${String(entry.id || index)}`,
      source: 'history' as const,
      type,
      date: String(entry.date || ''),
      content: memo || type,
      promptEligible: Boolean(memo) && isSeoRelevantHistoryContent(memo),
    }];
  });
  const noteCandidates: JobContentHistoryItem[] = notes.flatMap((note, index) => {
    const content = redactHistoryContent(note.text);
    if (!isSeoRelevantHistoryContent(content)) return [];
    return [{
      id: `note:${String(note.createdOn || note.modifiedOn || index)}:${index}`,
      source: 'note' as const,
      type: note.isPinned ? 'Pinned note' : 'Note',
      date: String(note.createdOn || note.modifiedOn || ''),
      content,
      promptEligible: true,
    }];
  });
  const candidates = [...historyCandidates, ...noteCandidates];
  const uniqueItems = new Map<string, JobContentHistoryItem>();
  for (const item of candidates) {
    const duplicateKey = `${item.date}|${item.content.toLowerCase()}`;
    if (!uniqueItems.has(duplicateKey)) uniqueItems.set(duplicateKey, item);
  }
  return [...uniqueItems.values()].sort((left, right) => historyTimestamp(left.date) - historyTimestamp(right.date));
};

const cleanHistoryText = (value: unknown): string => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ')
  .trim();

const redactHistoryContent = (value: unknown): string => cleanHistoryText(value)
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
  .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone removed]')
  .replace(/https?:\/\/\S+/gi, '[link removed]');

const isAttachmentEventType = (type: string): boolean =>
  /\b(?:attachment|file|photo|document|upload|download)\b/i.test(type);

const isSeoRelevantHistoryContent = (content: string): boolean => {
  const words = content.match(/[a-z0-9]+/gi) || [];
  if (content.length < 18 || words.length < 3) return false;
  if (/^(?:job|appointment|technician|invoice|customer)\s+(?:was\s+)?(?:created|scheduled|rescheduled|dispatched|arrived|completed|canceled|assigned|unassigned|updated|modified)\.?$/i.test(content)) return false;
  return true;
};

const historyTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
};

interface AxiosLikeError {
  isAxiosError: true;
  response?: {
    status?: number;
    data?: unknown;
  };
}

const isAxiosError = (error: unknown): error is AxiosLikeError =>
  typeof error === 'object' && error !== null && 'isAxiosError' in error;
