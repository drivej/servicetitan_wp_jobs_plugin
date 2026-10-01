export type ServiceTitanEnvironment = 'integration' | 'production';

export interface ServiceTitanConfig {
  clientId: string;
  clientSecret: string;
  appKey: string;
  tenantId: string;
  apiBaseUrl: string;
  authUrl: string;
}

export interface AppConfig {
  port: number;
  serviceTitan: ServiceTitanConfig;
  wordpress?: WordPressConfig;
  openai?: OpenAIConfig;
  zipLookup: ZipLookupConfig;
}

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
}

export interface WordPressConfig {
  collectionUrl: string;
  username: string;
  applicationPassword: string;
  postStatus: string;
  zipAcfFieldName: string;
}

export interface ZipLookupConfig {
  apiBaseUrl: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const loadConfig = (): AppConfig => {
  const environment = (process.env.ST_ENVIRONMENT?.trim() || 'integration') as ServiceTitanEnvironment;
  if (!['integration', 'production'].includes(environment)) {
    throw new Error('ST_ENVIRONMENT must be "integration" or "production".');
  }

  const parsedPort = Number.parseInt(process.env.PORT || '3000', 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const isProduction = environment === 'production';
  const wordpress = loadWordPressConfig();
  const openai = loadOpenAIConfig();
  return {
    port: parsedPort,
    serviceTitan: {
      clientId: required('ST_CLIENT_ID'),
      clientSecret: required('ST_CLIENT_SECRET'),
      appKey: required('ST_APP_KEY'),
      tenantId: required('ST_TENANT_ID'),
      apiBaseUrl: process.env.ST_API_URL?.trim() || (isProduction ? 'https://api.servicetitan.io' : 'https://api-integration.servicetitan.io'),
      authUrl: process.env.ST_AUTH_URL?.trim() || (isProduction ? 'https://auth.servicetitan.io/connect/token' : 'https://auth-integration.servicetitan.io/connect/token'),
    },
    zipLookup: {
      apiBaseUrl: process.env.ZIP_LOOKUP_API_URL?.trim().replace(/\/$/, '') || 'https://api.zippopotam.us',
    },
    ...(wordpress ? { wordpress } : {}),
    ...(openai ? { openai } : {}),
  };
};

export const loadOpenAIConfig = (): OpenAIConfig | undefined => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const configuredModel = process.env.OPENAI_MODEL?.trim();
  if (!apiKey && !configuredModel) return undefined;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when OPENAI_MODEL is configured.');

  const model = configuredModel || 'gpt-6-luna';
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(model)) {
    throw new Error('OPENAI_MODEL must be a valid model identifier.');
  }

  const apiBaseUrl = process.env.OPENAI_API_URL?.trim().replace(/\/$/, '') || 'https://api.openai.com/v1';
  const parsedUrl = new URL(apiBaseUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !(isLocal && parsedUrl.protocol === 'http:')) {
    throw new Error('OPENAI_API_URL must use HTTPS (except localhost).');
  }
  return { apiKey, model, apiBaseUrl };
};

const loadWordPressConfig = (): WordPressConfig | undefined => {
  const siteUrl = firstEnvironmentValue('WORDPRESS_URL', 'WP_URL');
  const explicitApiUrl = firstEnvironmentValue('WORDPRESS_API_URL', 'WP_API_URL');
  const username = firstEnvironmentValue('WORDPRESS_USERNAME', 'WP_USERNAME', 'WP_USER');
  const applicationPassword = firstEnvironmentValue(
    'WORDPRESS_APPLICATION_PASSWORD',
    'WP_APPLICATION_PASSWORD',
    'WP_APP_PASSWORD',
    'WP_PASSWORD',
  );

  if (!siteUrl && !explicitApiUrl && !username && !applicationPassword) return undefined;
  if ((!siteUrl && !explicitApiUrl) || !username || !applicationPassword) {
    throw new Error(
      'WordPress configuration is incomplete. Set WORDPRESS_URL, WORDPRESS_USERNAME, and WORDPRESS_APPLICATION_PASSWORD.',
    );
  }

  const restBase = firstEnvironmentValue(
    'WORDPRESS_POST_TYPE_REST_BASE',
    'WP_POST_TYPE_REST_BASE',
    'WP_REST_BASE',
    'WP_POST_TYPE',
  ) || 'st_job';
  if (!/^[a-z0-9_-]+$/i.test(restBase)) {
    throw new Error('WORDPRESS_POST_TYPE_REST_BASE must be a valid REST route segment.');
  }

  const collectionUrl = explicitApiUrl
    ? explicitApiUrl.replace(/\/$/, '')
    : `${siteUrl!.replace(/\/$/, '')}/wp-json/wp/v2/${restBase}`;
  const parsedUrl = new URL(collectionUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)
    || parsedUrl.hostname.endsWith('.local')
    || parsedUrl.hostname.endsWith('.test');
  if (parsedUrl.protocol !== 'https:' && !(isLocal && parsedUrl.protocol === 'http:')) {
    throw new Error('WordPress REST API connections must use HTTPS (except localhost).');
  }

  const postStatus = firstEnvironmentValue('WORDPRESS_POST_STATUS', 'WP_POST_STATUS') || 'draft';
  if (!/^[a-z0-9_-]+$/i.test(postStatus)) {
    throw new Error('WORDPRESS_POST_STATUS must be a valid WordPress status slug.');
  }

  const zipAcfFieldName = firstEnvironmentValue('WORDPRESS_ZIP_ACF_FIELD_NAME', 'WP_ZIP_ACF_FIELD_NAME') || 'my_zip_codes';
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(zipAcfFieldName)) {
    throw new Error('WORDPRESS_ZIP_ACF_FIELD_NAME must be a valid lowercase ACF field name.');
  }

  return { collectionUrl, username, applicationPassword, postStatus, zipAcfFieldName };
};

const firstEnvironmentValue = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};
