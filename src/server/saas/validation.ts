import ipaddr from 'ipaddr.js';

export class HttpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const record = (input: unknown, allowed: string[]): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError('A JSON object is required.');
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError('Unexpected fields in request.');
  return input as Record<string, unknown>;
};
export const textField = (value: unknown, label: string, max = 100): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(`${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
};
export const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError('Resource not found.', 404);
  return value.toLowerCase();
};
export function publicAddress(value: string): boolean {
  try {
    let parsed = ipaddr.parse(value);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function websiteUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(textField(value, 'Website URL', 500)); }
  catch { throw new HttpError('Enter a valid public HTTPS website URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== '443') || host.endsWith('.') || !host.includes('.')
    || /(?:^|\.)(?:localhost|local|test|internal|home|lan|invalid)$/.test(host)
    || (ipaddr.isValid(host) && !publicAddress(host))) {
    throw new HttpError('Enter a public HTTPS website URL without credentials, query parameters, or a custom port.');
  }
  return url.toString().replace(/\/+$/, '');
}
export interface ConnectionInput { name: string; environment: 'integration' | 'production'; tenantId: string; clientId: string; clientSecret: string; appKey: string; }
export function connectionInput(input: unknown, update = false): ConnectionInput {
  const value = record(input, ['name', 'environment', 'tenantId', 'clientId', 'clientSecret', 'appKey']);
  if (value.environment !== 'integration' && value.environment !== 'production') throw new HttpError('Choose a ServiceTitan environment.');
  const tenantId = textField(value.tenantId, 'Tenant ID', 20);
  if (!/^\d+$/.test(tenantId)) throw new HttpError('Tenant ID must contain only digits.');
  const credential = (key: string, label: string, max: number) => update && (value[key] === undefined || value[key] === '') ? '' : textField(value[key], label, max);
  return { name: textField(value.name, 'Connection name'), environment: value.environment, tenantId,
    clientId: credential('clientId', 'Client ID', 500), clientSecret: credential('clientSecret', 'Client secret', 2000), appKey: credential('appKey', 'App key', 2000) };
}
export interface WebsiteInput { name: string; connectionId: string; url: string; restBase: string; zipAcfField: string; wordpress?: { username: string; applicationPassword: string }; }
export function websiteInput(input: unknown): WebsiteInput {
  const value = record(input, ['name', 'connectionId', 'url', 'restBase', 'zipAcfField', 'wordpress']);
  const restBase = textField(value.restBase || 'st-jobs', 'REST base', 100);
  const zipAcfField = textField(value.zipAcfField || 'my_zip_codes', 'ZIP field', 64);
  if (!/^[a-z0-9_-]+$/i.test(restBase) || !/^[a-z][a-z0-9_]{0,63}$/.test(zipAcfField)) throw new HttpError('Invalid WordPress REST base or ZIP field.');
  let wordpress: WebsiteInput['wordpress'];
  if (value.wordpress !== undefined) {
    const credentials = record(value.wordpress, ['username', 'applicationPassword']);
    const username = textField(credentials.username, 'WordPress username', 100);
    if (username.includes(':')) throw new HttpError('WordPress username cannot contain a colon.');
    wordpress = { username, applicationPassword: textField(credentials.applicationPassword, 'Application password', 500) };
  }
  return { name: textField(value.name, 'Website name'), connectionId: uuid(value.connectionId), url: websiteUrl(value.url), restBase, zipAcfField, ...(wordpress ? { wordpress } : {}) };
}
