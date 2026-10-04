import { TokenAccounts } from './token-accounts.js';
import { BillingService } from './billing.js';
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
interface Options { config: SaaSConfig; store: AccountStore; google: GoogleLogin; websiteApp: WebsiteAppFactory; staticDirectory?: string; billing?: BillingService; }

export function createSaaSApp({ config, store, google, websiteApp, staticDirectory, billing = config.billing ? new BillingService(store.db, config.billing, config.origin) : undefined }: Options) {
  const app = express();
  const tokenAccounts = new TokenAccounts(store.db);
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
  // Stripe signatures require the untouched request body and replace session/CSRF
  // authentication on this one endpoint only.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    try {
      if (!billing) throw new HttpError('Billing is not configured.', 503);
      if (!Buffer.isBuffer(req.body)) throw new HttpError('Expected a JSON webhook body.', 400);
      await billing.webhook(req.body, req.get('Stripe-Signature') || '');
      res.json({ received: true });
    } catch (error) { next(error); }
  });
  app.use('/api', async (req, res, next) => {
    try {
      const token = cookieValue(req.headers.cookie, sessionName);
      const user = await store.session(token);
      if (!user) throw new HttpError('Sign in to continue.', 401);
      if (req.get('X-Workspace-ID') && req.get('X-Workspace-ID') !== user.workspaceId && req.path !== '/session') throw new HttpError('Your active workspace changed. Refresh the page.', 409);
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
  app.get('/api/billing', async (_req, res, next) => {
    try {
      if (!billing) throw new HttpError('Billing is not configured.', 503);
      res.json(await billing.summary(res.locals.user as User));
    } catch (error) { next(error); }
  });
  app.post('/api/billing/checkout', async (req, res, next) => {
    try {
      if (!billing) throw new HttpError('Billing is not configured.', 503);
      res.json(await billing.checkout(res.locals.user as User, req.body?.priceId));
    } catch (error) { next(error); }
  });
  app.post('/api/billing/portal', async (_req, res, next) => {
    try {
      if (!billing) throw new HttpError('Billing is not configured.', 503);
      res.json(await billing.portal(res.locals.user as User));
    } catch (error) { next(error); }
  });
  app.get('/api/tokens/history', async (req, res, next) => {
    const user = res.locals.user as User;
    try { res.json(await tokenAccounts.history(user.id, user.workspaceId, req.query.before)); } catch (error) { next(error); }
  });
  app.get('/api/admin/token-accounts', async (req, res, next) => {
    try { res.json(await tokenAccounts.list((res.locals.user as User).id, req.query.search, req.query.after)); } catch (error) { next(error); }
  });
  app.get('/api/admin/token-accounts/:workspaceId/transactions', async (req, res, next) => {
    try { res.json(await tokenAccounts.history((res.locals.user as User).id, uuid(req.params.workspaceId), req.query.before, true)); } catch (error) { next(error); }
  });
  app.post('/api/admin/token-accounts/:workspaceId/transactions', async (req, res, next) => {
    try { res.json(await tokenAccounts.adjust((res.locals.user as User).id, uuid(req.params.workspaceId), req.body)); } catch (error) { next(error); }
  });
  app.post('/api/tokens/test-credit', async (_req, res, next) => {
    try {
      if (!config.testTokensEnabled) throw new HttpError('Test tokens are disabled.', 403);
      res.json({ jobTokens: await store.addTestJobToken((res.locals.user as User).id, (res.locals.user as User).workspaceId) });
    } catch (error) { next(error); }
  });
  app.post('/api/logout', async (_req, res, next) => {
    try {
      await store.logout((res.locals.user as User).id, String(res.locals.sessionToken));
      res.clearCookie(sessionName, cookieOptions);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get('/api/workspaces', async (_req, res, next) => {
    try { res.json({ workspaces: await store.listWorkspaces((res.locals.user as User).id) }); } catch (error) { next(error); }
  });
  app.post('/api/workspaces/select', async (req, res, next) => {
    try { await store.switchWorkspace((res.locals.user as User).id, String(res.locals.sessionToken), uuid(req.body?.workspaceId)); res.status(204).end(); } catch (error) { next(error); }
  });
  app.get('/api/team', async (_req, res, next) => {
    const user = res.locals.user as User;
    try { res.json(await store.team(user.id,user.workspaceId)); } catch (error) { next(error); }
  });
  app.post('/api/team/invitations', async (req, res, next) => {
    const user = res.locals.user as User;
    try {
      if (typeof req.body?.email !== 'string') throw new HttpError('Enter an email address.');
      const invite = await store.invite(user.id,user.workspaceId,req.body.email,req.body.role);
      res.status(201).json({ id: invite.id, email: invite.email, role: invite.role, url: `${config.origin}/invite#token=${invite.token}` });
    } catch (error) { next(error); }
  });
  app.delete('/api/team/invitations/:id', async (req, res, next) => {
    const user = res.locals.user as User;
    try { await store.revokeInvitation(user.id,user.workspaceId,uuid(req.params.id)); res.status(204).end(); } catch (error) { next(error); }
  });
  app.patch('/api/team/members/:id', async (req, res, next) => {
    const user = res.locals.user as User;
    try {
      if (!['admin','member'].includes(req.body?.role)) throw new HttpError('Choose Admin or Member.');
      await store.changeMember(user.id,user.workspaceId,uuid(req.params.id),req.body.role); res.status(204).end();
    } catch (error) { next(error); }
  });
  app.delete('/api/team/members/:id', async (req, res, next) => {
    const user = res.locals.user as User;
    try { await store.changeMember(user.id,user.workspaceId,uuid(req.params.id)); res.status(204).end(); } catch (error) { next(error); }
  });
  app.post('/api/invitations/preview', async (req, res, next) => {
    try {
      if (typeof req.body?.token !== 'string') throw new HttpError('Invitation is invalid.');
      res.json(await store.invitationDetails((res.locals.user as User).id,req.body.token));
    } catch (error) { next(error); }
  });
  app.post('/api/invitations/accept', async (req, res, next) => {
    try {
      if (typeof req.body?.token !== 'string') throw new HttpError('Invitation is invalid.');
      await store.acceptInvitation((res.locals.user as User).id,String(res.locals.sessionToken),req.body.token); res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get('/api/connections', async (_req, res, next) => {
    try { res.json({ connections: await store.listConnections((res.locals.user as User).id, (res.locals.user as User).workspaceId) }); }
    catch (error) { next(error); }
  });
  app.post('/api/connections', async (req, res, next) => {
    try { res.status(201).json(await store.saveConnection((res.locals.user as User).id, connectionInput(req.body), undefined, false, (res.locals.user as User).workspaceId)); }
    catch (error) { next(error); }
  });
  app.put('/api/connections/:id', async (req, res, next) => {
    try { res.json(await store.saveConnection((res.locals.user as User).id, connectionInput(req.body, true), uuid(req.params.id), true, (res.locals.user as User).workspaceId)); }
    catch (error) { next(error); }
  });
  app.get('/api/websites', async (_req, res, next) => {
    try { res.json({ websites: await store.listWebsites((res.locals.user as User).id, (res.locals.user as User).workspaceId) }); }
    catch (error) { next(error); }
  });
  app.post('/api/websites', async (req, res, next) => {
    try { res.status(201).json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body), undefined, false, (res.locals.user as User).workspaceId)); }
    catch (error) { next(error); }
  });
  app.put('/api/websites/:id', async (req, res, next) => {
    try { res.json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body), uuid(req.params.id), true, (res.locals.user as User).workspaceId)); }
    catch (error) { next(error); }
  });
  app.use('/api/websites/:id', async (req, res, next) => {
    try {
      const userId = (res.locals.user as User).id;
      const id = uuid(req.params.id);
      const context = await store.websiteContext(userId, id, (res.locals.user as User).workspaceId);
      if (['POST', 'PATCH'].includes(req.method)) {
        const action = req.path.endsWith('/ai-copy') ? 'generation.requested' : 'wordpress.operation_requested';
        const jobMatch = req.path.match(/^\/jobs\/(\d+)\//);
        await store.recordAction(userId, action, id, (res.locals.user as User).workspaceId, jobMatch ? Number(jobMatch[1]) : undefined);
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
