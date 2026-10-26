import { FileScannerStore, PostgresScannerStore } from './scanner-store.js';
import { executeScan, ScannerWorker, scannerApi } from './job-scanner.js';
import { DisabledJobScorer, OpenAIJobScorer } from './job-scorer.js';
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
const scannerStore = db ? new PostgresScannerStore(db) : new FileScannerStore(resolve('.data/job-scanner.json'));
const scorer = aiConfig ? new OpenAIJobScorer(aiConfig) : new DisabledJobScorer();
const localScope = { userId: 'local', workspaceId: 'local', websiteId: 'local' };
const localWordPressSiteUrl = (collectionUrl: string): string => {
  const url = new URL(collectionUrl);
  const restIndex = url.pathname.indexOf('/wp-json/');
  url.pathname = restIndex >= 0 ? url.pathname.slice(0, restIndex) || '/' : '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};
const localProviders = config ? {
  ...(config.wordpress ? { companyWebsiteUrl: localWordPressSiteUrl(config.wordpress.collectionUrl) } : {}),
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
const scannerWorker = new ScannerWorker(scannerStore, async task => {
  const providers = store
    ? websiteBuildProviders(store,copyGenerator,task.userId,await store.websiteContext(task.userId,task.websiteId,task.workspaceId))
    : localProviders!;
  await executeScan(task,providers,scorer,scannerStore,queue);
});
const app = saasConfig && store
  ? createSaaSApp({ config: saasConfig, store, google: new GoogleOIDC(saasConfig), websiteApp: websiteAppFactory(store, copyGenerator, queue, scannerStore, scorer), ...staticOptions })
  : createApp({ jobScorer: scorer, ...localProviders!, ...staticOptions, scanner: scannerApi(localScope,scannerStore,queue),
      localPlatformAdmin: process.env.LOCAL_USER_PLATFORM_ADMIN?.toLowerCase() !== 'false',
      buildQueue: { enqueue: (jobId) => queue.enqueue(localScope, jobId), list: (jobIds) => queue.list(localScope, jobIds) },
    });
worker.start();
scannerWorker.start();
if (mode === 'local') app.get('/api/session', (_req, res) => {
  res.json({ mode: 'local', user: {
    id: process.env.LOCAL_USER_ID || 'local-user',
    name: process.env.LOCAL_USER_NAME || 'Local Test User',
    email: process.env.LOCAL_USER_EMAIL || 'local@example.test',
    avatarUrl: process.env.LOCAL_USER_AVATAR_URL || null,
    workspaceId: 'local', workspaceName: 'Local Workspace', role: 'owner', jobTokens: 3,
    // Local development defaults to platform admin for support/debug tooling.
    // Set LOCAL_USER_PLATFORM_ADMIN=false to exercise a non-admin local UI.
    isPlatformAdmin: process.env.LOCAL_USER_PLATFORM_ADMIN?.toLowerCase() !== 'false'
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
    await Promise.all([worker.stop(),scannerWorker.stop()]);
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
