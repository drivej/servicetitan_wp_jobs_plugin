let websiteId = '';
let userId = 'local';
let csrf = '';
export function configureApi(user: string, website: string, token: string): void {
  userId = user; websiteId = website; csrf = token;
}
export const isSaaSWorkspace = (): boolean => userId !== 'local';
export const apiUrl = (path: string): string => websiteId ? `/api/websites/${encodeURIComponent(websiteId)}${path.replace(/^\/api/, '')}` : path;
export const accountFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD'].includes(init.method || 'GET') && csrf) headers.set('X-CSRF-Token', csrf);
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
};
export const apiFetch = (path: string, init?: RequestInit): Promise<Response> => accountFetch(apiUrl(path), init);
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
