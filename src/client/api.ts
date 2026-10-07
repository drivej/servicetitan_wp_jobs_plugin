
let websiteId = '';
let userId = 'local';
let csrf = '';
let workspaceId = '';
export function configureApi(user: string, website: string, token: string, workspace = ''): void {
  userId = user; websiteId = website; csrf = token; workspaceId = workspace;
}
export const isSaaSWorkspace = (): boolean => userId !== 'local';
export const apiUrl = (path: string): string => websiteId ? `/api/websites/${encodeURIComponent(websiteId)}${path.replace(/^\/api/, '')}` : path;
export const accountFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (workspaceId) headers.set('X-Workspace-ID', workspaceId);
  if (!['GET', 'HEAD'].includes(init.method || 'GET') && csrf) headers.set('X-CSRF-Token', csrf);
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
};
const paidOperationPath = (path: string, method: string): boolean => method.toUpperCase() === 'POST'
  && /\/jobs\/\d+\/(?:ai-copy|wordpress(?:\/regenerate)?)$/.test(new URL(path, window.location.origin).pathname);
const paidOperationKey = async (path: string, init: RequestInit): Promise<{ key: string; storageKey: string }> => {
  const body = typeof init.body === 'string' ? init.body : '';
  const material = `${userId}:${websiteId}:${path}:${body}`;
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const storageKey = `st-spend-op:${suffix}`;
  let key = '';
  try { key = window.sessionStorage.getItem(storageKey) || ''; } catch { /* Use a one-shot key when storage is unavailable. */ }
  if (!key) {
    key = window.crypto.randomUUID();
    try { window.sessionStorage.setItem(storageKey, key); } catch { /* The request still works, but cannot resume after navigation. */ }
  }
  return { key, storageKey };
};
export const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  const request = init || {};
  const headers = new Headers(request.headers);
  const operation = paidOperationPath(path, request.method || 'GET') ? await paidOperationKey(path, request) : undefined;
  if (operation) headers.set('Idempotency-Key', operation.key);
  try {
    const response = await accountFetch(apiUrl(path), { ...request, headers });
    if (isSaaSWorkspace() && response.status === 402) markTokensExhausted();
    if (operation && response.ok) {
      const readJson = response.json.bind(response);
      response.json = async () => {
        const body = await readJson();
        try { window.sessionStorage.removeItem(operation.storageKey); } catch { /* Ignore unavailable storage. */ }
        return body;
      };
    }
    if (operation && response.status === 409) {
      const problem = await response.clone().json().catch(() => undefined) as { error?: string } | undefined;
      if (problem?.error?.startsWith('This operation was reconciled as complete.')) {
        try { window.sessionStorage.removeItem(operation.storageKey); } catch { /* Ignore unavailable storage. */ }
      } else {
        try { window.sessionStorage.setItem(operation.storageKey, operation.key); } catch { /* Keep the current request key for retries when possible. */ }
      }
    }
    return response;
  }
  finally {
    if (isSaaSWorkspace() && init?.method && !['GET', 'HEAD'].includes(init.method)) {
      window.dispatchEvent(new Event('job-tokens-changed'));
    }
  }
};
export function wordpressStatusStorage() {
  const prefix = `account:${userId}:website:${websiteId || 'local'}:`;
  return {
    getItem: (key: string) => window.localStorage.getItem(prefix + key),
    setItem: (key: string, value: string) => window.localStorage.setItem(prefix + key, value),
    removeItem: (key: string) => window.localStorage.removeItem(prefix + key),
  };
}
export function clearAccountCache(user: string): void {
  try {
    const prefix = `account:${user}:`;
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(prefix)) window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(`website:${user}`);
  } catch { /* Storage may be unavailable. */ }
}

// Browser preferences survive sign-out/cache clearing and are isolated per user.
export const tokenPreferenceKey = (action: string, cost: number): string =>
  `user-preferences:${userId}:token-spend:${action}:${cost}`;
import { markTokensExhausted } from './tokenState';
