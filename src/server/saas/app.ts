import { TokenAccounts } from './token-accounts.js';
import { PlatformMembers } from './platform-members.js';
import { BillingService } from './billing.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import type { SaaSConfig } from './config.js';
import { csrfToken, randomToken } from './crypto.js';
import type { GoogleLogin } from './google.js';
import type { WebsiteAppFactory } from './providers.js';
import { AccountStore, type User } from './store.js';
import { ServiceTitanClient } from '../service-titan.js';
import { parseJobsQuery } from '../app.js';
import { WordPressClient } from '../wordpress.js';
import { ServiceTitanRequestError } from '../service-titan-error.js';
import { WordPressRequestError } from '../wordpress-error.js';
import { connectionInput, HttpError, uuid, websiteInput, websiteUrl } from './validation.js';
import { publicFetch } from './public-fetch.js';

export const sessionCookieName = (secure: boolean): string => secure ? '__Host-st_session' : 'st_session';
const cookieValue = (header: string | undefined, name: string): string => {
  const values = (header || '').split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
};
const equalToken = (left: string, right: string): boolean => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
interface Options { config: SaaSConfig; store: AccountStore; google: GoogleLogin; websiteApp: WebsiteAppFactory; staticDirectory?: string; billing?: BillingService; }

function websiteSchemaIssue(error: unknown): { code: string; table?: string; column?: string; constraint?: string; message: string } | undefined {
  const issue = error as { code?: string; table?: string; column?: string; constraint?: string };
  if (!['23502', '42703', '42P01'].includes(String(issue?.code))) return undefined;
  let message = 'Website setup could not be saved because the onboarding database schema is out of date. Apply the latest database migrations and retry.';
  if (issue.code === '23502' && issue.column === 'connection_id') {
    message = 'Website setup could not be saved because this database still requires a ServiceTitan connection during the website step. Apply migration 008_staged_onboarding.sql to the database used by this app, then retry.';
  } else if (issue.code === '23502' && issue.column) {
    message = `Website setup could not be saved because the database still requires a value for ${issue.column}. Apply the latest database migrations to the database used by this app, then retry.`;
  } else if (issue.code === '42703' && issue.column) {
    message = `Website setup could not be saved because the database is missing the ${issue.column} column. Apply the latest database migrations to the database used by this app, then retry.`;
  } else if (issue.code === '42P01' && issue.table) {
    message = `Website setup could not be saved because the database is missing the ${issue.table} table. Apply the latest database migrations to the database used by this app, then retry.`;
  }
  return { code: issue.code!, ...(issue.table ? { table: issue.table } : {}), ...(issue.column ? { column: issue.column } : {}), ...(issue.constraint ? { constraint: issue.constraint } : {}), message };
}

export function createSaaSApp({ config, store, google, websiteApp, staticDirectory, billing = config.billing ? new BillingService(store.db, config.billing, config.origin) : undefined }: Options) {
  const app = express();
  const tokenAccounts = new TokenAccounts(store.db);
  const platformMembers = new PlatformMembers(store.db);
  const sessionName = sessionCookieName(config.secureCookies);
  const loginName = config.secureCookies ? '__Host-st_login' : 'st_login';
  let publicPlansCache: { expiresAt: number; plans: Omit<Awaited<ReturnType<BillingService['plans']>>[number], 'id'>[] } | undefined;
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
      res.redirect('/pricing');
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
  app.get('/api/public/plans', async (_req, res, next) => {
    try {
      if (!billing) throw new HttpError('Pricing is not configured.', 503);
      // Only publish the same display fields shown during checkout; customer and payment data remain private.
      if (!publicPlansCache || publicPlansCache.expiresAt <= Date.now()) {
        const plans = (await billing.plans()).map(({ name, amount, currency, tokens, maxTokens, interval, intervalCount }) => ({ name, amount, currency, tokens, maxTokens, interval, intervalCount }));
        publicPlansCache = { plans, expiresAt: Date.now() + 5 * 60_000 };
      }
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ plans: publicPlansCache.plans });
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
  app.get('/api/onboarding/status', async (_req, res, next) => {
    try {
      const user = res.locals.user as User;
      const [connections, websites, activeProduct] = await Promise.all([
        store.listConnections(user.id, user.workspaceId),
        store.listWebsites(user.id, user.workspaceId),
        billing ? billing.hasActiveProduct(user) : Promise.resolve(false),
      ]);
      const flags = await store.onboardingFlags(user.id, user.workspaceId);
      res.json({ activeProduct, ...flags, settingsReady: flags.websiteReady && flags.serviceTitanReady });
    } catch (error) { next(error); }
  });
  app.post('/api/onboarding/validate-plugin', async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      const websiteId = uuid(req.body?.websiteId);
      const context = await store.websiteWordPressContext(user.id, websiteId, user.workspaceId);
      const cooldownKey = `${user.workspaceId}:plugin:${websiteId}:${context.website.version}`;
      if (!await store.allowRequest(`settings-test-attempt:${cooldownKey}`, 5, 60)) { res.status(429).json({ error: 'Too many checks for these settings. Wait a minute before trying again.' }); return; }
      if (await store.testCooldownActive(cooldownKey)) { res.status(429).json({ error: 'This check was completed recently. Change and save the settings to test again, or wait 30 seconds.' }); return; }
      const endpoint = `${websiteUrl(context.website.url)}/wp-json/servicetitan-job-integration/v1/status`;
      let response: Response;
      try {
        response = await publicFetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        // Some hosts or security plugins require authentication even for this
        // deliberately public status route. Retry with the saved WordPress
        // Application Password so users do not need to change host settings.
        if (response.status === 401 && context.wordpress) {
          response = await publicFetch(endpoint, {
            headers: {
              Accept: 'application/json',
              Authorization: `Basic ${Buffer.from(`${context.wordpress.username}:${context.wordpress.applicationPassword}`).toString('base64')}`,
            },
            signal: AbortSignal.timeout(15_000),
          });
        }
      }
      catch (error) { res.status(422).json({ service: 'wordpress-plugin', error: error instanceof Error ? error.message : 'Could not reach the WordPress plugin status endpoint.', helpUrl: '/help/wordpress-reachability' }); return; }
      if (!response.ok) {
        const code = response.status === 404 ? 'wordpress-plugin' : 'wordpress-reachability';
        res.status(422).json({ service: 'wordpress-plugin', error: response.status === 404 ? 'The companion plugin status route was not found. Install and activate the plugin, then test again.' : `WordPress returned HTTP ${response.status} from the plugin status endpoint.`, helpUrl: code === 'wordpress-plugin' ? '/wordpress-plugin' : '/help/wordpress-reachability' }); return;
      }
      const body = await response.json() as { plugin?: string; version?: string; postType?: string };
      const version = body.version?.split('.').map(Number);
      const compatible = body.plugin === 'servicetitan-job-integration' && version?.length === 3 && version.every(Number.isFinite) && (version[0]! > 1 || version[0] === 1 && (version[1]! > 18 || version[1] === 18 && version[2]! >= 1));
      if (!compatible) { res.status(422).json({ service: 'wordpress-plugin', error: 'The companion plugin is missing, too old, or returned an invalid status. Install the latest plugin and test again.', helpUrl: '/wordpress-plugin' }); return; }
      try {
        await store.markPluginValidated(user.id, websiteId, user.workspaceId);
      } catch {
        res.status(503).json({
          error: 'The plugin was detected, but the onboarding check could not be saved. Verify the latest database migrations, then retry.',
          helpUrl: '/help/plugin-test-failed', requestId: res.locals.requestId,
        });
        return;
      }
      await store.startTestCooldown(cooldownKey, 30);
      res.json({ valid: true, version: body.version });
    } catch (error) { next(error); }
  });
  app.post('/api/onboarding/validate-website', async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      const websiteId = uuid(req.body?.websiteId);
      const context = await store.websiteWordPressContext(user.id, websiteId, user.workspaceId);
      const cooldownKey = `${user.workspaceId}:wordpress:${websiteId}:${context.website.version}`;
      if (!await store.allowRequest(`settings-test-attempt:${cooldownKey}`, 5, 60)) { res.status(429).json({ error: 'Too many checks for these settings. Wait a minute before trying again.' }); return; }
      if (await store.testCooldownActive(cooldownKey)) { res.status(429).json({ error: 'This check was completed recently. Change and save the settings to test again, or wait 30 seconds.' }); return; }
      if (!context.wordpress) { res.status(422).json({ service: 'wordpress', code: 'credentials', error: 'WordPress credentials are missing.', helpUrl: '/help/wordpress-credentials' }); return; }
      const wordpress = new WordPressClient({ ...context.wordpress, collectionUrl: `${context.website.url}/wp-json/wp/v2/${context.website.restBase}`, postStatus: 'draft', zipAcfFieldName: context.website.zipAcfField });
      try { await wordpress.validateAccess(); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'WordPress REST API validation failed.';
        const status = error instanceof WordPressRequestError ? error.status : 0;
        const code = status === 401 ? 'credentials' : status === 403 ? 'permissions' : status === 404 ? 'rest-api' : 'reachability';
        res.status(422).json({ service: 'wordpress', code, error: message, helpUrl: `/help/wordpress-${code}` }); return;
      }
      await store.markWebsiteValidated(user.id, websiteId, user.workspaceId);
      await store.startTestCooldown(cooldownKey, 30);
      res.json({ valid: true, service: 'wordpress' });
    } catch (error) { next(error); }
  });
  app.post('/api/onboarding/validate-servicetitan', async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      const connectionId = uuid(req.body?.connectionId);
      const websiteId = uuid(req.body?.websiteId);
      const connections = await store.listConnections(user.id, user.workspaceId);
      const connection = connections.find((item) => item.id === connectionId);
      if (!connection) throw new HttpError('Select a saved ServiceTitan connection.');
      const connectionContext = await store.connectionContext(user.id, connectionId, user.workspaceId);
      const cooldownKey = `${user.workspaceId}:servicetitan:${connectionId}:${connectionContext.version}`;
      if (!await store.allowRequest(`settings-test-attempt:${cooldownKey}`, 5, 60)) { res.status(429).json({ error: 'Too many checks for these settings. Wait a minute before trying again.' }); return; }
      if (await store.testCooldownActive(cooldownKey)) { res.status(429).json({ error: 'This check was completed recently. Change and save the settings to test again, or wait 30 seconds.' }); return; }
      const client = new ServiceTitanClient({ ...connectionContext,
        apiBaseUrl: 'https://api.servicetitan.io',
        authUrl: 'https://auth.servicetitan.io/connect/token' });
      try { await client.validateAccess(); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'ServiceTitan rejected the connection.';
        const code = error instanceof ServiceTitanRequestError && error.status === 401 ? 'credentials' : error instanceof ServiceTitanRequestError && error.status === 403 ? 'permissions' : 'tenant';
        res.status(422).json({ service: 'servicetitan', code, error: message, helpUrl: `/help/servicetitan-${code}` }); return;
      }
      const site = await store.websiteWordPressContext(user.id, websiteId, user.workspaceId);
      if (!site.website.wordpressConfigured) throw new HttpError('Validate the WordPress website first.', 409);
      await store.attachConnection(user.id, websiteId, connectionId, user.workspaceId);
      await store.markConnectionValidated(user.id, connectionId, user.workspaceId);
      await store.startTestCooldown(cooldownKey, 30);
      res.json({ valid: true, service: 'servicetitan' });
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
  app.get('/api/admin/token-accounts/:workspaceId/spend-operations', async (req, res, next) => {
    try { res.json({ operations: await tokenAccounts.pendingSpends((res.locals.user as User).id, uuid(req.params.workspaceId)) }); } catch (error) { next(error); }
  });
  app.post('/api/admin/token-accounts/:workspaceId/spend-operations/:operationId/resolve', async (req, res, next) => {
    try { res.json(await tokenAccounts.resolveSpend((res.locals.user as User).id, uuid(req.params.workspaceId), req.params.operationId, req.body?.decision)); } catch (error) { next(error); }
  });
  app.get('/api/admin/members', async (req, res, next) => {
    try { res.json(await platformMembers.list((res.locals.user as User).id, req.query.search, req.query.after)); } catch (error) { next(error); }
  });
  app.get('/api/admin/members/:memberId/job-preview', async (req, res, next) => {
    try {
      const actor = res.locals.user as User;
      res.json(await platformMembers.jobPreviewOptions(actor.id, actor.workspaceId, uuid(req.params.memberId)));
    } catch (error) { next(error); }
  });
  app.get('/api/admin/members/:memberId/job-preview/jobs', async (req, res, next) => {
    try {
      const actor = res.locals.user as User;
      const memberId = uuid(req.params.memberId);
      await platformMembers.requirePlatformAdmin(actor.id);
      const workspaceId = uuid(req.query.workspaceId);
      const websiteId = uuid(req.query.websiteId);
      const context = await store.websiteContext(memberId, websiteId, workspaceId);
      const provider = new ServiceTitanClient({ ...context.connection, apiBaseUrl: 'https://api.servicetitan.io', authUrl: 'https://auth.servicetitan.io/connect/token' });
      const jobs = await provider.getJobs(parseJobsQuery(req.query as Record<string, unknown>));
      await platformMembers.auditJobPreview(actor.id, actor.workspaceId, websiteId);
      res.json(jobs);
    } catch (error) { next(error); }
  });
  app.get('/api/admin/members/:memberId/job-preview/jobs/:jobId/raw', async (req, res, next) => {
    try {
      const actor = res.locals.user as User;
      const memberId = uuid(req.params.memberId);
      await platformMembers.requirePlatformAdmin(actor.id);
      const workspaceId = uuid(req.query.workspaceId);
      const websiteId = uuid(req.query.websiteId);
      if (typeof req.params.jobId !== 'string' || !/^\d+$/.test(req.params.jobId) || !Number.isSafeInteger(Number(req.params.jobId)) || Number(req.params.jobId) < 1) throw new HttpError('jobId must be a positive integer.');
      const context = await store.websiteContext(memberId, websiteId, workspaceId);
      const provider = new ServiceTitanClient({ ...context.connection, apiBaseUrl: 'https://api.servicetitan.io', authUrl: 'https://auth.servicetitan.io/connect/token' });
      const data = await provider.getRawJob(Number(req.params.jobId));
      await platformMembers.auditJobPreview(actor.id, actor.workspaceId, websiteId, Number(req.params.jobId));
      res.json({ data });
    } catch (error) { next(error); }
  });
  app.post('/api/admin/members/:memberId/disable', async (req, res, next) => {
    try { await platformMembers.disable((res.locals.user as User).id, uuid(req.params.memberId)); res.status(204).end(); } catch (error) { next(error); }
  });
  app.post('/api/tokens/test-credit', async (req, res, next) => {
    try {
      if (!config.testTokensEnabled) throw new HttpError('Test tokens are disabled.', 403);
      const rawAmount = req.body?.amount;
      const amount = rawAmount === undefined ? 1 : Number(rawAmount);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) throw new HttpError('Enter a positive whole token amount.');
      const user = res.locals.user as User;
      res.json({ jobTokens: await store.addTestJobToken(user.id, amount, user.workspaceId) });
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
    try {
      const input = connectionInput(req.body);
      res.status(201).json(await store.saveConnection((res.locals.user as User).id, { ...input, environment: 'production' }, undefined, false, (res.locals.user as User).workspaceId));
    }
    catch (error) { next(error); }
  });
  app.put('/api/connections/:id', async (req, res, next) => {
    try {
      const input = connectionInput(req.body, true);
      res.json(await store.saveConnection((res.locals.user as User).id, { ...input, environment: 'production' }, uuid(req.params.id), true, (res.locals.user as User).workspaceId));
    }
    catch (error) { next(error); }
  });
  app.get('/api/websites', async (_req, res, next) => {
    try { res.json({ websites: await store.listWebsites((res.locals.user as User).id, (res.locals.user as User).workspaceId) }); }
    catch (error) { next(error); }
  });
  app.post('/api/websites', async (req, res, next) => {
    try { res.status(201).json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body), undefined, false, (res.locals.user as User).workspaceId)); }
    catch (error) {
      const issue = websiteSchemaIssue(error);
      if (issue) {
        console.error('Website save schema mismatch', { requestId: res.locals.requestId, ...issue });
        res.status(503).json({ error: issue.message, helpUrl: '/help/onboarding-save-failed', requestId: res.locals.requestId });
        return;
      }
      next(error);
    }
  });
  app.put('/api/websites/:id', async (req, res, next) => {
    try { res.json(await store.saveWebsite((res.locals.user as User).id, websiteInput(req.body), uuid(req.params.id), true, (res.locals.user as User).workspaceId)); }
    catch (error) {
      const issue = websiteSchemaIssue(error);
      if (issue) {
        console.error('Website save schema mismatch', { requestId: res.locals.requestId, ...issue });
        res.status(503).json({ error: issue.message, helpUrl: '/help/onboarding-save-failed', requestId: res.locals.requestId });
        return;
      }
      next(error);
    }
  });
  app.get('/api/websites/:id/admin/service-titan/jobs/:jobId/raw', async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      if (!user.isPlatformAdmin) throw new HttpError('Platform administrator access required.', 403);
      const context = await store.websiteContext(user.id, uuid(req.params.id), user.workspaceId);
      if (!/^\d+$/.test(req.params.jobId) || !Number.isSafeInteger(Number(req.params.jobId)) || Number(req.params.jobId) < 1) {
        throw new HttpError('jobId must be a positive integer.');
      }
      const serviceTitan = new ServiceTitanClient({ ...context.connection,
        apiBaseUrl: 'https://api.servicetitan.io',
        authUrl: 'https://auth.servicetitan.io/connect/token',
      });
      res.set('Cache-Control', 'private, no-store');
      res.json({ data: await serviceTitan.getRawJob(Number(req.params.jobId)) });
    } catch (error) { next(error); }
  });
  app.use('/api/websites/:id', async (req, res, next) => {
    try {
      const userId = (res.locals.user as User).id;
      const id = uuid(req.params.id);
      const context = await store.websiteContext(userId, id, (res.locals.user as User).workspaceId);
      if (['POST', 'PATCH'].includes(req.method) && req.path !== '/build-deploy/statuses') {
        const action = req.path.endsWith('/ai-copy') ? 'generation.requested' : 'wordpress.operation_requested';
        const jobMatch = req.path.match(/^\/jobs\/(\d+)\//);
        await store.recordAction(userId, action, id, (res.locals.user as User).workspaceId, jobMatch ? Number(jobMatch[1]) : undefined);
      }
      websiteApp(userId, context)(req, res, next);
    } catch (error) { next(error); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  app.get('/downloads/servicetitan-job-integration-1.18.1.zip', (_req, res, next) => {
    res.download(resolve('dist/downloads/servicetitan-job-integration-1.18.1.zip'), (error) => { if (error && !res.headersSent) next(error); });
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
