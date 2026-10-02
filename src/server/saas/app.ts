import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import type { SaaSConfig } from './config.js';
import { csrfToken, randomToken } from './crypto.js';
import type { GoogleLogin } from './google.js';
import type { WebsiteAppFactory } from './providers.js';
import { AccountStore, type User } from './store.js';
import { connectionInput, HttpError, uuid, websiteInput } from './validation.js';

export const sessionCookieName = (secure: boolean): string => secure ? '__Host-st_session' : 'st_session';
const cookieValue = (header: string | undefined, name: string): string => {
  const values = (header || '').split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
};
const equalToken = (left: string, right: string): boolean => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
interface Options { config: SaaSConfig; store: AccountStore; google: GoogleLogin; websiteApp: WebsiteAppFactory; staticDirectory?: string; }

export function createSaaSApp({ config, store, google, websiteApp, staticDirectory }: Options) {
  const app = express();
  const sessionName = sessionCookieName(config.secureCookies);
  const loginName = config.secureCookies ? '__Host-st_login' : 'st_login';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' };
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/auth', async (req, _res, next) => {
    try {
      if (!await store.allowRequest(`auth:${req.ip}`, 20, 600)) throw new HttpError('Too many sign-in attempts. Try again later.', 429);
      next();
    } catch (error) { next(error); }
  });
  app.get('/auth/google', async (_req, res, next) => {
    try {
      const state = randomToken(), browser = randomToken(), verifier = randomToken(), nonce = randomToken();
      const url = await google.authorization(state, nonce, verifier);
      await store.beginLogin(state, browser, verifier, nonce);
      res.cookie(loginName, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
      res.redirect(url);
    } catch (error) { next(error); }
  });
  app.get('/auth/google/callback', async (req, res) => {
    res.clearCookie(loginName, cookieOptions);
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const browser = cookieValue(req.headers.cookie, loginName);
      if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || !/^[a-zA-Z0-9_-]{43}$/.test(browser)) throw new HttpError('Invalid login state.');
      const attempt = await store.consumeLogin(state, browser);
      const identity = await google.exchange(new URL(req.originalUrl, config.origin), state, attempt.nonce, attempt.verifier);
      const result = await store.login(identity, cookieValue(req.headers.cookie, sessionName));
      res.cookie(sessionName, result.token, { ...cookieOptions, maxAge: 7 * 86_400_000 });
      res.redirect('/');
    } catch {
      // Provider errors may contain tokens/codes; never log them or put them in the redirect.
      res.redirect('/?login=failed');
    }
  });
  app.use('/api', async (req, res, next) => {
    try {
      const token = cookieValue(req.headers.cookie, sessionName);
      const user = await store.session(token);
      if (!user) throw new HttpError('Sign in to continue.', 401);
      res.locals.user = user;
      res.locals.sessionToken = token;
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (mutation && (req.get('Origin') !== config.origin || !equalToken(req.get('X-CSRF-Token') || '', csrfToken(token)))) {
        throw new HttpError('The request could not be verified. Refresh the page and try again.', 403);
      }
      const ai = req.path.endsWith('/ai-copy');
      if (!await store.allowRequest(`${ai ? 'ai' : mutation ? 'write' : 'read'}:${user.id}`, ai ? 10 : mutation ? 30 : 180, 60)) {
        throw new HttpError('Too many requests. Try again in a minute.', 429);
      }
      next();
    } catch (error) { next(error); }
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/session', (_req, res) => {
    res.json({ mode: 'saas', testTokensEnabled: config.testTokensEnabled === true, user: res.locals.user, csrfToken: csrfToken(String(res.locals.sessionToken)) });
  });
  app.post('/api/tokens/test-credit', async (_req, res, next) => {
    try {
      if (!config.testTokensEnabled) throw new HttpError('Test tokens are disabled.', 403);
      res.json({ jobTokens: await store.addTestJobToken((res.locals.user as User).id) });
    } catch (error) { next(error); }
  });
  app.post('/api/logout', async (_req, res, next) => {
    try {
      await store.logout((res.locals.user as User).id, String(res.locals.sessionToken));
      res.clearCookie(sessionName, cookieOptions);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get('/api/connections', async (_req, res, next) => {
    try { res.json({ connections: await store.listConnections((res.locals.user as User).id) }); }
    catch (error) { next(error); }
  });
  app.post('/api/connections', async (req, res, next) => {
    try { res.status(201).json(await store.saveConnection((res.locals.user as User).id, connectionInput(req.body))); }
    catch (error) { next(error); }
  });
  app.put('/api/connections/:id', async (req, res, next) => {
    try { res.json(await store.saveConnection((res.locals.user as User).id, connectionInput(req.body, true), uuid(req.params.id), true)); }
    catch (error) { next(error); }
  });
  app.get('/api/websites', async (_req, res, next) => {
    try { res.json({ websites: await store.listWebsites((res.locals.user as User).id) }); }
    catch (error) { next(error); }
  });
  app.post('/api/websites', async (req, res, next) => {
    try { res.status(201).json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body))); }
    catch (error) { next(error); }
  });
  app.put('/api/websites/:id', async (req, res, next) => {
    try { res.json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body), uuid(req.params.id), true)); }
    catch (error) { next(error); }
  });
  app.use('/api/websites/:id', async (req, res, next) => {
    try {
      const userId = (res.locals.user as User).id;
      const id = uuid(req.params.id);
      const context = await store.websiteContext(userId, id);
      if (['POST', 'PATCH'].includes(req.method)) {
        const action = req.path.endsWith('/ai-copy') ? 'generation.requested' : 'wordpress.operation_requested';
        await store.recordAction(userId, action, id);
      }
      websiteApp(userId, context)(req, res, next);
    } catch (error) { next(error); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  app.get('/downloads/servicetitan-job-integration-1.18.0.zip', (_req, res, next) => {
    res.download(resolve('dist/downloads/servicetitan-job-integration-1.18.0.zip'), (error) => { if (error && !res.headersSent) next(error); });
  });
  if (staticDirectory) {
    app.use(express.static(staticDirectory, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => { res.sendFile(resolve(staticDirectory, 'index.html')); });
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    const code = (error as { code?: string }).code;
    if (code === '23505') { res.status(409).json({ error: 'That connection or website already exists.' }); return; }
    if (code === '23503') { res.status(400).json({ error: 'The selected connection is not available.' }); return; }
    if ((error as { type?: string }).type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON.' }); return; }
    if ((error as { type?: string }).type === 'entity.too.large') { res.status(413).json({ error: 'Request is too large.' }); return; }
    console.error('Request failed', { requestId: res.locals.requestId });
    res.status(500).json({ error: 'The request could not be completed.', requestId: res.locals.requestId });
  };
  app.use(errors);
  return app;
}
