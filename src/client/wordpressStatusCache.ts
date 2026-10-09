export interface WordPressStatus {
  state: 'unknown' | 'not_found' | 'exists';
  label: string;
  postId?: number;
  postStatus?: string;
  link?: string;
  postTitle?: string;
  postExcerpt?: string;
  postModifiedOn?: string;
  message?: string;
  seoVersion?: number;
  currentSeoVersion?: number;
  seoState?: 'current' | 'outdated' | 'legacy' | 'modified' | 'newer';
  generatedAt?: string;
  featuredImageId?: number;
  featuredImageFileName?: string;
  featuredImageAttachmentId?: string;
}

export function isSeoPromptOutOfSync(status: WordPressStatus, serviceTitanModifiedOn?: string): boolean {
  if (status.state !== 'exists' || status.seoState === 'newer') return false;
  const serviceTitanModifiedTime = serviceTitanModifiedOn ? Date.parse(serviceTitanModifiedOn) : Number.NaN;
  const wordpressModifiedTime = status.postModifiedOn ? Date.parse(status.postModifiedOn) : Number.NaN;
  if (Number.isFinite(serviceTitanModifiedTime) && Number.isFinite(wordpressModifiedTime)
    && serviceTitanModifiedTime > wordpressModifiedTime) return true;
  if (status.seoVersion !== undefined && status.currentSeoVersion !== undefined) {
    return status.seoVersion < status.currentSeoVersion;
  }
  return status.seoState === 'legacy' || status.seoState === 'outdated'
    || (status.seoState === 'modified' && status.seoVersion === undefined);
}

interface CachedWordPressStatus {
  checkedAt: number;
  status: WordPressStatus;
}

interface StatusStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CACHE_KEY = 'servicetitan-jobs:wordpress-statuses:v2';
export const WORDPRESS_STATUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function readCachedWordPressStatuses(
  jobIds: number[],
  storage: StatusStorage,
  now = Date.now(),
  currentSeoVersion?: number,
): { statuses: Record<number, WordPressStatus>; missingJobIds: number[] } {
  const cache = readCache(storage);
  const statuses: Record<number, WordPressStatus> = {};
  const missingJobIds: number[] = [];
  let changed = false;

  for (const [key, entry] of Object.entries(cache)) {
    if (
      !isCachedStatus(entry)
      || now - entry.checkedAt >= WORDPRESS_STATUS_CACHE_TTL_MS
      || (currentSeoVersion !== undefined && entry.status.currentSeoVersion !== currentSeoVersion)
    ) {
      delete cache[key];
      changed = true;
    }
  }

  for (const jobId of jobIds) {
    const entry = cache[String(jobId)];
    if (entry) statuses[jobId] = entry.status;
    else missingJobIds.push(jobId);
  }

  if (changed) writeCache(storage, cache);
  return { statuses, missingJobIds };
}

export function writeCachedWordPressStatuses(
  statuses: Record<number, WordPressStatus>,
  storage: StatusStorage,
  now = Date.now(),
): void {
  const cache = readCache(storage);

  for (const [jobId, status] of Object.entries(statuses)) {
    if (status.state === 'exists' || status.state === 'not_found') {
      cache[jobId] = { checkedAt: now, status };
    }
  }

  for (const [key, entry] of Object.entries(cache)) {
    if (!isCachedStatus(entry) || now - entry.checkedAt >= WORDPRESS_STATUS_CACHE_TTL_MS) delete cache[key];
  }

  writeCache(storage, cache);
}

function readCache(storage: StatusStorage): Record<string, CachedWordPressStatus> {
  try {
    const value = storage.getItem(CACHE_KEY);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed as Record<string, CachedWordPressStatus> : {};
  } catch {
    return {};
  }
}

function writeCache(storage: StatusStorage, cache: Record<string, CachedWordPressStatus>): void {
  try {
    if (Object.keys(cache).length === 0) storage.removeItem(CACHE_KEY);
    else storage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Browser storage can be unavailable in private or quota-restricted contexts.
  }
}

function isCachedStatus(value: unknown): value is CachedWordPressStatus {
  if (!isRecord(value) || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt)) return false;
  const status = value.status;
  return isRecord(status)
    && (status.state === 'exists' || status.state === 'not_found')
    && typeof status.label === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
