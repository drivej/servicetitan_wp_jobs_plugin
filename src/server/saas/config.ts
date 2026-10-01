import { SecretVault } from './crypto.js';

export interface SaaSConfig {
  databaseUrl: string;
  origin: string;
  googleClientId: string;
  googleClientSecret: string;
  secureCookies: boolean;
  trustProxyHops: number;
  vault: SecretVault;
}
const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};
export function applicationMode(env: NodeJS.ProcessEnv = process.env): 'local' | 'saas' {
  const mode = env.APP_MODE || (env.NODE_ENV === 'production' ? 'saas' : 'local');
  if (mode !== 'local' && mode !== 'saas') throw new Error('APP_MODE must be local or saas.');
  if (mode === 'local' && env.NODE_ENV === 'production') throw new Error('Local single-user mode cannot run in production.');
  return mode;
}
export function loadSaaSConfig(env: NodeJS.ProcessEnv = process.env): SaaSConfig {
  const origin = new URL(required(env, 'APP_ORIGIN'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local && origin.protocol === 'http:'))) {
    throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP loopback is allowed in development).');
  }
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS || '0');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be between 0 and 5.');
  let keys: unknown;
  try { keys = JSON.parse(required(env, 'CREDENTIAL_ENCRYPTION_KEYS')); }
  catch { throw new Error('CREDENTIAL_ENCRYPTION_KEYS must be a JSON object of key IDs to base64 keys.'); }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some((value) => typeof value !== 'string')) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEYS must map key IDs to base64 keys.');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'), origin: origin.origin,
    googleClientId: required(env, 'GOOGLE_CLIENT_ID'), googleClientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    secureCookies: origin.protocol === 'https:', trustProxyHops,
    vault: new SecretVault(keys as Record<string, string>, required(env, 'CREDENTIAL_ENCRYPTION_ACTIVE_KEY')),
  };
}
