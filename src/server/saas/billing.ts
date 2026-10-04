import { postTokenTransaction } from './token-ledger.js';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { BillingConfig } from './billing-config.js';
import type { Database, Sql } from './database.js';
import type { User } from './store.js';
import { HttpError } from './validation.js';

export interface BillingPlan { id: string; name: string; amount: number; currency: string; tokens: number; maxTokens: number; interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number; }
const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;
export function planFromPrice(price: Stripe.Price, maxTokens: number): BillingPlan {
  const product = typeof price.product === 'object' && !('deleted' in price.product) ? price.product : undefined;
  const tokenCount = price.metadata.token_count?.trim() || '';
  const tokens = Number(tokenCount);
  if (!price.active || price.type !== 'recurring' || !price.recurring || !['day', 'week', 'month', 'year'].includes(price.recurring.interval) || !Number.isSafeInteger(price.recurring.interval_count) || price.recurring.interval_count < 1 || price.recurring.usage_type !== 'licensed' || price.billing_scheme !== 'per_unit' || price.unit_amount === null
    || !/^\d+$/.test(tokenCount) || !Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 2_147_483_647) {
    throw new HttpError('A Stripe plan needs a recurring fixed price and a positive integer token_count in its price metadata.', 503);
  }
  return { id: price.id, name: price.nickname || price.lookup_key || product?.name || 'Subscription', amount: price.unit_amount, currency: price.currency, tokens, maxTokens, interval: price.recurring.interval as BillingPlan['interval'], intervalCount: price.recurring.interval_count };
}
export class BillingService {
  readonly stripe: Stripe;
  constructor(private readonly db: Database, readonly config: BillingConfig, private readonly origin: string, stripe?: Stripe) {
    this.stripe = stripe || new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
  }
  private assertMode() {
    if (this.config.development && /^(sk|rk)_live_/.test(this.config.secretKey)) throw new HttpError('Local billing tests require Stripe sandbox keys and matching sandbox prices.', 503);
  }
  private async resolvePlan(reference: string): Promise<BillingPlan> {
    this.assertMode();
    const price = reference.startsWith('price_')
      ? await this.stripe.prices.retrieve(reference, { expand: ['product'] })
      : (await this.stripe.prices.list({ lookup_keys: [reference], expand: ['data.product'], limit: 2 })).data[0];
    if (!price) throw new HttpError('A configured Stripe price was not found.', 503);
    if (this.config.development && price.livemode) throw new HttpError('Use sandbox prices for local testing.', 503);
    return planFromPrice(price, this.config.maxTokens);
  }
  async plans(): Promise<BillingPlan[]> {
    this.assertMode();
    return Promise.all(this.config.prices.map((reference) => this.resolvePlan(reference)));
  }
  private async freePlan(): Promise<BillingPlan | null> {
    if (!this.config.freePrice) return null;
    const plan = await this.resolvePlan(this.config.freePrice);
    if (plan.amount !== 0) throw new HttpError('STRIPE_PRICE_FREE must have a zero price.', 503);
    return plan;
  }
  private async owned<T>(user: User, ownerOnly: boolean, action: (sql: Sql, row: Record<string, unknown>) => Promise<T>): Promise<T> {
    return this.db.transaction(user.id, async (sql) => {
      const workspace = (await sql.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [user.workspaceId])).rows[0];
      const member = (await sql.query(`SELECT m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id
        JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.owner_user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [user.workspaceId, user.id])).rows[0];
      if (!workspace || !member || (ownerOnly && member.role !== 'owner')) throw new HttpError('Only the workspace owner can manage billing.', 403);
      await sql.query('INSERT INTO workspace_billing(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [user.workspaceId]);
      const row = (await sql.query('SELECT * FROM workspace_billing WHERE workspace_id=$1', [user.workspaceId])).rows[0]!;
      return action(sql, row);
    });
  }
  private async subscriptions(customer: string) {
    return (await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100 })).data.filter((s) => !['canceled', 'incomplete_expired'].includes(s.status));
  }
  async summary(user: User) {
    const plans = await this.plans();
    return this.owned(user, false, async (_sql, row) => {
      const subscriptions = row.customer_id ? await this.subscriptions(String(row.customer_id)) : [];
      const subscription = subscriptions[0];
      const testPlan = this.config.testTokensEnabled && user.role === 'owner' ? await this.freePlan() : null;
      return { plans, testPlan, canManage: user.role === 'owner', hasCustomer: Boolean(row.customer_id), subscription: subscription ? {
        status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end,
        priceId: subscription.items.data[0]?.price.id,
      } : null };
    });
  }
  async checkout(user: User, priceId: unknown) {
    const plans = await this.plans();
    const freePlan = this.config.testTokensEnabled ? await this.freePlan() : null;
    const plan = [...plans, ...(freePlan ? [freePlan] : [])].find((item) => item.id === priceId);
    if (!plan) throw new HttpError('Select an available subscription plan.');
    // Reserve a durable attempt before calling Stripe. Retries reuse the same
    // idempotency key, even after an API timeout or database rollback.
    const attempt = await this.owned(user, true, async (sql, row) => {
      if (row.checkout_key && Number(new Date(String(row.checkout_expires_at))) > Date.now()) {
        if (row.checkout_price !== plan.id) throw new HttpError('A checkout for another plan is pending. Finish it or wait 35 minutes before switching plans.', 409);
        return { key: String(row.checkout_key), expires: Math.floor(Number(new Date(String(row.checkout_expires_at))) / 1000) };
      }
      const key = randomUUID(), expires = Math.floor(Date.now() / 1000) + 35 * 60;
      await sql.query('UPDATE workspace_billing SET checkout_key=$2,checkout_price=$3,checkout_expires_at=to_timestamp($4),checkout_id=NULL WHERE workspace_id=$1', [user.workspaceId, key, plan.id, expires]);
      return { key, expires };
    });
    // Persist customer mapping before Checkout can emit a paid-invoice event.
    const customer = await this.owned(user, true, async (sql, row) => {
      if (row.customer_id) return String(row.customer_id);
      const created = await this.stripe.customers.create({ metadata: { workspace_id: user.workspaceId } }, { idempotencyKey: `workspace-customer:${user.workspaceId}` });
      await sql.query('UPDATE workspace_billing SET customer_id=$2 WHERE workspace_id=$1', [user.workspaceId, created.id]);
      return created.id;
    });
    return this.owned(user, true, async (sql, row) => {
      if (row.checkout_key !== attempt.key) throw new HttpError('Checkout changed. Please try again.', 409);
      if ((await this.subscriptions(customer)).length) throw new HttpError('This workspace already has a subscription. Use Manage billing.', 409);
      if (row.checkout_id) {
        const existing = await this.stripe.checkout.sessions.retrieve(String(row.checkout_id));
        if (existing.status === 'open' && existing.url) return { url: existing.url };
        throw new HttpError('Checkout is complete or expired. Refresh your billing page.', 409);
      }
      const session = await this.stripe.checkout.sessions.create({
        customer, mode: 'subscription', line_items: [{ price: plan.id, quantity: 1 }],
        client_reference_id: user.workspaceId, subscription_data: { metadata: { workspace_id: user.workspaceId } },
        success_url: `${this.origin}/add-tokens?checkout=success`, cancel_url: `${this.origin}/add-tokens?checkout=canceled`,
        expires_at: attempt.expires,
      }, { idempotencyKey: `workspace-checkout:${attempt.key}` });
      if (!session.url) throw new Error('Stripe checkout URL missing.');
      await sql.query('UPDATE workspace_billing SET checkout_id=$2 WHERE workspace_id=$1', [user.workspaceId, session.id]);
      return { url: session.url };
    });
  }
  async portal(user: User) {
    this.assertMode();
    return this.owned(user, true, async (_sql, row) => {
      if (!row.customer_id) throw new HttpError('Subscribe before managing billing.');
      // Keep plan changes off until proration/token upgrade rules are defined.
      const configuration = await this.stripe.billingPortal.configurations.create({
        business_profile: { headline: 'Manage your workspace billing' },
        features: { customer_update: { enabled: true, allowed_updates: ['email', 'address'] }, invoice_history: { enabled: true },
          payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: false } },
      }, { idempotencyKey: 'workspace-portal-configuration-v1' });
      const session = await this.stripe.billingPortal.sessions.create({ customer: String(row.customer_id), configuration: configuration.id, return_url: `${this.origin}/add-tokens` });
      return { url: session.url };
    });
  }
  async webhook(body: Buffer, signature: string) {
    this.assertMode();
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(body, signature, this.config.webhookSecret); }
    catch { throw new HttpError('Invalid Stripe webhook signature.', 400); }
    if (event.livemode !== /^(sk|rk)_live_/.test(this.config.secretKey)) throw new HttpError('Stripe event mode does not match server credentials.', 400);
    // Subscription status is fetched from Stripe on every billing-page load,
    // so old/out-of-order subscription events cannot overwrite newer state.
    if (event.type !== 'invoice.paid') return;
    const invoice = await this.stripe.invoices.retrieve(event.data.object.id);
    if (invoice.status !== 'paid' || !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason || '')) return;
    const customer = objectId(invoice.customer);
    const subscription = objectId(invoice.parent?.subscription_details?.subscription);
    if (!customer || !subscription) return;
    const plans = await this.plans();
    const lines = await this.stripe.invoices.listLineItems(invoice.id, { limit: 100 });
    if (lines.has_more || lines.data.length !== 1) throw new Error('Unexpected subscription invoice lines.');
    const line = lines.data[0]!;
    let plan = plans.find((p) => p.id === line.pricing?.price_details?.price);
    // Honor invoices for existing test subscriptions even if new test purchases
    // have since been disabled. Disabling the flag does not cancel subscriptions.
    if (!plan) {
      const freePlan = await this.freePlan();
      if (freePlan?.id === line.pricing?.price_details?.price) plan = freePlan || undefined;
    }
    if (!plan || line.quantity !== 1 || line.parent?.subscription_item_details?.proration) throw new Error('Unsupported subscription invoice.');
    await this.creditInvoice(customer, invoice.id, subscription, line.period.start, plan);
  }
  async creditInvoice(customer: string, invoiceId: string, subscriptionId: string, periodStart: number, plan: BillingPlan) {
    return this.db.transaction(undefined, async (sql) => {
      const billing = (await sql.query('SELECT workspace_id FROM workspace_billing WHERE customer_id=$1', [customer])).rows[0];
      if (!billing) return; // Not a subscription belonging to this application.
      const workspaceId = String(billing.workspace_id);
      await sql.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const inserted = await sql.query(`INSERT INTO stripe_token_grants(invoice_id,workspace_id,subscription_id,period_start,tokens)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING invoice_id`, [invoiceId, workspaceId, subscriptionId, periodStart, plan.tokens]);
      if (!inserted.rows.length) return;
      await postTokenTransaction(sql, { workspaceId, kind: 'stripe_credit', requestedAmount: plan.tokens, maxTokens: this.config.maxTokens,
        reference: `stripe:${invoiceId}`, reason: 'Paid subscription invoice', stripeInvoiceId: invoiceId });
    });
  }
}
