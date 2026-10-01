import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from './config.js';

test('loads ServiceTitan credentials only from ST-prefixed environment variables', () => {
  const names = ['ST_ENVIRONMENT', 'ST_CLIENT_ID', 'ST_CLIENT_SECRET', 'ST_APP_KEY', 'ST_TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'APP_KEY', 'TENANT_ID'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ST_ENVIRONMENT = 'integration';
    process.env.ST_CLIENT_ID = 'st-client';
    process.env.ST_CLIENT_SECRET = 'st-secret';
    process.env.ST_APP_KEY = 'st-app-key';
    process.env.ST_TENANT_ID = 'st-tenant';
    process.env.CLIENT_ID = 'old-client';
    process.env.CLIENT_SECRET = 'old-secret';
    process.env.APP_KEY = 'old-app-key';
    process.env.TENANT_ID = 'old-tenant';

    assert.deepEqual(loadConfig().serviceTitan, {
      clientId: 'st-client',
      clientSecret: 'st-secret',
      appKey: 'st-app-key',
      tenantId: 'st-tenant',
      apiBaseUrl: 'https://api-integration.servicetitan.io',
      authUrl: 'https://auth-integration.servicetitan.io/connect/token',
    });
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('loads the configurable WordPress ZIP ACF field name and ZIP lookup URL', () => {
  const names = [
    'ST_ENVIRONMENT', 'ST_CLIENT_ID', 'ST_CLIENT_SECRET', 'ST_APP_KEY', 'ST_TENANT_ID',
    'WORDPRESS_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APPLICATION_PASSWORD', 'WORDPRESS_ZIP_ACF_FIELD_NAME',
    'ZIP_LOOKUP_API_URL',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ST_ENVIRONMENT = 'integration';
    process.env.ST_CLIENT_ID = 'st-client';
    process.env.ST_CLIENT_SECRET = 'st-secret';
    process.env.ST_APP_KEY = 'st-app-key';
    process.env.ST_TENANT_ID = 'st-tenant';
    process.env.WORDPRESS_URL = 'https://wordpress.example';
    process.env.WORDPRESS_USERNAME = 'wp-user';
    process.env.WORDPRESS_APPLICATION_PASSWORD = 'wp-password';
    process.env.WORDPRESS_ZIP_ACF_FIELD_NAME = 'service_zip_codes';
    process.env.ZIP_LOOKUP_API_URL = 'https://zip.example.test/';

    const config = loadConfig();
    assert.equal(config.wordpress?.zipAcfFieldName, 'service_zip_codes');
    assert.deepEqual(config.zipLookup, { apiBaseUrl: 'https://zip.example.test' });
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('rejects invalid ACF field names', () => {
  const names = [
    'ST_ENVIRONMENT', 'ST_CLIENT_ID', 'ST_CLIENT_SECRET', 'ST_APP_KEY', 'ST_TENANT_ID',
    'WORDPRESS_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APPLICATION_PASSWORD', 'WORDPRESS_ZIP_ACF_FIELD_NAME',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ST_ENVIRONMENT = 'integration';
    process.env.ST_CLIENT_ID = 'st-client';
    process.env.ST_CLIENT_SECRET = 'st-secret';
    process.env.ST_APP_KEY = 'st-app-key';
    process.env.ST_TENANT_ID = 'st-tenant';
    process.env.WORDPRESS_URL = 'https://wordpress.example';
    process.env.WORDPRESS_USERNAME = 'wp-user';
    process.env.WORDPRESS_APPLICATION_PASSWORD = 'wp-password';
    process.env.WORDPRESS_ZIP_ACF_FIELD_NAME = 'Not Valid';
    assert.throws(() => loadConfig(), /valid lowercase ACF field name/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('loads OpenAI copy-generation settings without exposing them to the client', () => {
  const names = [
    'ST_ENVIRONMENT', 'ST_CLIENT_ID', 'ST_CLIENT_SECRET', 'ST_APP_KEY', 'ST_TENANT_ID',
    'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_API_URL',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ST_ENVIRONMENT = 'integration';
    process.env.ST_CLIENT_ID = 'st-client';
    process.env.ST_CLIENT_SECRET = 'st-secret';
    process.env.ST_APP_KEY = 'st-app-key';
    process.env.ST_TENANT_ID = 'st-tenant';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.OPENAI_API_URL = 'https://openai.example.test/v1/';

    assert.deepEqual(loadConfig().openai, {
      apiKey: 'test-openai-key',
      model: 'test-model',
      apiBaseUrl: 'https://openai.example.test/v1',
    });
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
