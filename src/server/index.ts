import { BuildQueueWorker, FileBuildQueueStore, PostgresBuildQueueStore } from './build-queue.js';
import { buildAndDeploy } from './build-deploy.js';
import 'dotenv/config';
import pg from 'pg';
import { applicationMode, loadSaaSConfig } from './saas/config.js';
import { PostgresDatabase } from './saas/database.js';
import { AccountStore } from './saas/store.js';
import { GoogleOIDC } from './saas/google.js';
import { createSaaSApp } from './saas/app.js';
import { websiteBuildProviders, websiteAppFactory } from './saas/providers.js';
import { closePublicFetch } from './saas/public-fetch.js';

import { resolve } from 'node:path';

import { createApp } from './app.js';
import { loadConfig, loadOpenAIConfig } from './config.js';
import { DisabledJobCopyGenerator, OpenAIJobCopyGenerator } from './openai.js';
import { ServiceTitanClient } from './service-titan.js';
import { ZippopotamClient } from './zip-lookup.js';
import { DisabledWordPressClient, WordPressClient } from './wordpress.js';

const isProduction = process.env.NODE_ENV === 'production';
const mode = applicationMode();
const config = mode === 'local' ? loadConfig() : undefined;
const saasConfig = mode === 'saas' ? loadSaaSConfig() : undefined;
const pool = saasConfig ? new pg.Pool({ connectionString: saasConfig.databaseUrl, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }) : undefined;
const db = pool ? new PostgresDatabase(pool) : undefined;
if (db) await db.verifyRuntimeRole();
const aiConfig = loadOpenAIConfig();
const copyGenerator = aiConfig ? new OpenAIJobCopyGenerator(aiConfig) : new DisabledJobCopyGenerator();
const staticOptions = isProduction ? { staticDirectory: resolve(process.cwd(), 'dist/client') } : {};
const store = saasConfig && db ? new AccountStore(db, saasConfig.vault) : undefined;
const queue = db ? new PostgresBuildQueueStore(db) : new FileBuildQueueStore(resolve(process.env.BUILD_QUEUE_FILE || '.data/build-deploy.json'));
const localScope = { userId: 'local', workspaceId: 'local', websiteId: 'local' };
const localProviders = config ? {
  serviceTitan: new ServiceTitanClient(config.serviceTitan),
  wordpress: config.wordpress ? new WordPressClient(config.wordpress, fetch, new ZippopotamClient(config.zipLookup)) : new DisabledWordPressClient(),
  copyGenerator,
} : undefined;
const worker = new BuildQueueWorker(queue, async (task) => {
  const providers = store
    ? websiteBuildProviders(store, copyGenerator, task.userId, await store.websiteContext(task.userId, task.websiteId, task.workspaceId))
    : localProviders!;
  return buildAndDeploy(task.jobId, providers, task.id);
});
const app = saasConfig && store
  ? createSaaSApp({ config: saasConfig, store, google: new GoogleOIDC(saasConfig), websiteApp: websiteAppFactory(store, copyGenerator, queue), ...staticOptions })
  : createApp({ ...localProviders!, ...staticOptions,
      buildQueue: { enqueue: (jobId) => queue.enqueue(localScope, jobId), list: (jobIds) => queue.list(localScope, jobIds) },
    });
worker.start();
if (mode === 'local') app.get('/api/session', (_req, res) => {
  res.json({ mode: 'local', user: {
    id: process.env.LOCAL_USER_ID || 'local-user',
    name: process.env.LOCAL_USER_NAME || 'Local Test User',
    email: process.env.LOCAL_USER_EMAIL || 'local@example.test',
    avatarUrl: process.env.LOCAL_USER_AVATAR_URL || null,
    workspaceId: 'local', workspaceName: 'Local Workspace', role: 'owner', jobTokens: 3,
    isPlatformAdmin: process.env.LOCAL_USER_PLATFORM_ADMIN === 'true'
  } });
});
const port = config?.port || Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');

let vite: import('vite').ViteDevServer | undefined;

if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true } });
  app.use(vite.middlewares);
}

const server = app.listen(port, mode === 'local' ? '127.0.0.1' : (process.env.HOST || '0.0.0.0'), () => {
  console.log(`ServiceTitan Jobs is listening on http://localhost:${port}`);
});

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received; closing HTTP server.`);

  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit.');
    server.closeAllConnections();
    process.exit(1);
  }, 120_000);
  forceExit.unref();

  try {
    // Vite owns file watchers and a WebSocket server in development mode.
    // Close it before waiting for Node's HTTP connections to drain.
    await vite?.close();
    let forceConnectionsClosed: NodeJS.Timeout | undefined;
    if (server.listening) {
      server.closeIdleConnections();
      forceConnectionsClosed = setTimeout(() => {
        server.closeAllConnections();
      }, 1_500);
      forceConnectionsClosed.unref();

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolveClose();
          else rejectClose(error);
        });
      });
    }

    if (forceConnectionsClosed) clearTimeout(forceConnectionsClosed);
    await worker.stop();
    await pool?.end();
    await closePublicFetch();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error(error);
    server.closeAllConnections();
    process.exit(1);
  }
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
