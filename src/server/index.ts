import 'dotenv/config';
import pg from 'pg';
import { applicationMode, loadSaaSConfig } from './saas/config.js';
import { PostgresDatabase } from './saas/database.js';
import { AccountStore } from './saas/store.js';
import { GoogleOIDC } from './saas/google.js';
import { createSaaSApp } from './saas/app.js';
import { websiteAppFactory } from './saas/providers.js';
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
const app = saasConfig && store
  ? createSaaSApp({ config: saasConfig, store, google: new GoogleOIDC(saasConfig), websiteApp: websiteAppFactory(store, copyGenerator), ...staticOptions })
  : createApp({
      serviceTitan: new ServiceTitanClient(config!.serviceTitan),
      wordpress: config!.wordpress ? new WordPressClient(config!.wordpress, fetch, new ZippopotamClient(config!.zipLookup)) : new DisabledWordPressClient(),
      copyGenerator, ...staticOptions,
    });
if (mode === 'local') app.get('/api/session', (_req, res) => { res.json({ mode: 'local' }); });
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
  }, 5_000);
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
