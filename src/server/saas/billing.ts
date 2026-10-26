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
      const workspace = (await sql.query('SELECT id,paused_at FROM workspaces WHERE id=$1 FOR UPDATE', [user.workspaceId])).rows[0];
      const member = (await sql.query(`SELECT m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id
        JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.owner_user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [user.workspaceId, user.id])).rows[0];
      if (!workspace || !member || (ownerOnly && member.role !== 'owner')) throw new HttpError('Only the workspace owner can manage billing.', 403);
      await sql.query('INSERT INTO workspace_billing(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [user.workspaceId]);
      const row = (await sql.query('SELECT * FROM workspace_billing WHERE workspace_id=$1', [user.workspaceId])).rows[0]!;
      await sql.query("SELECT set_config('app.workspace_id',$1,true)",[user.workspaceId]);
      return action(sql, { ...row, paused_at: workspace.paused_at });
    });
  }
  private async subscriptions(customer: string) {
    return (await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100 })).data.filter((s) => ['active', 'trialing'].includes(s.status));
  }
  private requireUnpaused(row: Record<string, unknown>) {
    if (row.paused_at || row.pause_action) throw new HttpError('This account is paused. Ask an account admin to resume it before starting a subscription.',409);
  }
  private async pauseScope<T>(user: User, workspaceId: string, action: (sql: Sql, row: Record<string, unknown>) => Promise<T>): Promise<T> {
    return this.db.transaction(user.id,async sql=>{
      const workspace=(await sql.query('SELECT id,paused_at FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
      const allowed=(await sql.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=$2 JOIN users owner ON owner.id=w.owner_user_id
        LEFT JOIN workspace_memberships m ON m.workspace_id=w.id AND m.user_id=u.id
        WHERE u.id=$1 AND u.disabled_at IS NULL AND (
          EXISTS(SELECT 1 FROM platform_administrators a WHERE a.user_id=u.id) OR
          (m.role IN ('owner','admin') AND owner.disabled_at IS NULL))`,[user.id,workspaceId])).rows[0];
      if (!workspace || !allowed) throw new HttpError('Only account admins and superadmins can pause or resume accounts.',403);
      await sql.query('INSERT INTO workspace_billing(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId]);
      const row=(await sql.query('SELECT * FROM workspace_billing WHERE workspace_id=$1',[workspaceId])).rows[0]!;
      await sql.query("SELECT set_config('app.workspace_id',$1,true)",[user.workspaceId]);
      return action(sql,{...row,paused_at:workspace.paused_at});
    });
  }
  async setPaused(user: User, paused: boolean, workspaceId = user.workspaceId): Promise<void> {
    this.assertMode();
    const action = paused ? 'pause' : 'resume';
    // Commit the intent first, so an API timeout or process crash stays fail-closed.
    await this.pauseScope(user,workspaceId,async(sql,row)=>{
      if (row.pause_action && row.pause_action!==action) throw new HttpError('Finish the pending billing change before changing account status.',409);
      if (row.pause_action || Boolean(row.paused_at)===paused) return;
      const requestId=randomUUID();
      if (paused) {
        await sql.query('UPDATE workspaces SET paused_at=now() WHERE id=$1',[workspaceId]);
        await sql.query('INSERT INTO workspace_pause_periods(id,workspace_id) VALUES($1,$2)',[requestId,workspaceId]);
      }
      await sql.query('UPDATE workspace_billing SET pause_action=$2,pause_request_id=$3 WHERE workspace_id=$1',[workspaceId,action,requestId]);
    });
    try {
      await this.pauseScope(user,workspaceId,async(sql,row)=>{
        if (!row.pause_action) return; // Another retry already synchronized it.
        if (row.pause_action!==action) throw new HttpError('Account status changed. Refresh billing.',409);
        const key=String(row.pause_request_id);
        if (row.customer_id) {
          const customer=String(row.customer_id);
          if (paused && row.checkout_id) {
            const session=await this.stripe.checkout.sessions.retrieve(String(row.checkout_id));
            if (session.status==='open') await this.stripe.checkout.sessions.expire(session.id);
          }
          // Expire all open subscription checkouts, including an earlier retry's session.
          if (paused) {
            for await (const session of this.stripe.checkout.sessions.list({customer,status:'open',limit:100})) {
              if (session.mode==='subscription') await this.stripe.checkout.sessions.expire(session.id);
            }
          }
          const subscriptions=[];
          for await (const subscription of this.stripe.subscriptions.list({customer,status:'all',limit:100})) {
            if (!['canceled','incomplete_expired'].includes(subscription.status)) subscriptions.push(subscription);
          }
          for (const subscription of subscriptions) {
            await this.stripe.subscriptions.update(subscription.id,{pause_collection:paused?{behavior:'void'}:''},{idempotencyKey:`account-${key}-${subscription.id}`});
          }
          if (paused) {
            // Stripe continues retries for pre-pause invoices unless explicitly voided.
            for (const status of ['open','draft'] as const) {
              for await (const invoice of this.stripe.invoices.list({customer,status,limit:100})) {
                const subscription=objectId(invoice.parent?.subscription_details?.subscription);
                if (!subscription || !subscriptions.some(item=>item.id===subscription)) continue;
                if (status==='draft') await this.stripe.invoices.del(invoice.id);
                else await this.stripe.invoices.voidInvoice(invoice.id,{},{idempotencyKey:`account-${key}-void-${invoice.id}`});
              }
            }
          }
        }
        if (!paused) {
          await sql.query('UPDATE workspace_pause_periods SET ended_at=now() WHERE workspace_id=$1 AND ended_at IS NULL',[workspaceId]);
          await sql.query('UPDATE workspaces SET paused_at=NULL WHERE id=$1',[workspaceId]);
        }
        await sql.query('UPDATE workspace_billing SET pause_action=NULL,pause_request_id=NULL,checkout_id=NULL,checkout_key=NULL,checkout_price=NULL,checkout_expires_at=NULL WHERE workspace_id=$1',[workspaceId]);
        await sql.query(`INSERT INTO audit_logs(id,user_id,workspace_id,action,target_id) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),user.id,user.workspaceId,paused?'account.paused':'account.resumed',workspaceId]);
      });
    } catch {
      throw new HttpError('The account remains paused while the billing change is pending. Stripe has not confirmed completion; payments may still be collected. Retry the pending change.',503);
    }
  }
  async hasActiveProduct(user: User): Promise<boolean> {
    return this.owned(user, false, async (_sql, row) => {
      if (!row.customer_id) return false;
      return (await this.subscriptions(String(row.customer_id))).length > 0;
    });
  }
  async summary(user: User) {
    const plans = await this.plans();
    return this.owned(user, false, async (_sql, row) => {
      const subscriptions = row.customer_id ? await this.subscriptions(String(row.customer_id)) : [];
      const subscription = subscriptions[0];
      const testPlan = this.config.testTokensEnabled && user.role === 'owner' ? await this.freePlan() : null;
      return { paused: Boolean(row.paused_at), pausePending: row.pause_action || null, canPause: ['owner','admin'].includes(user.role) || user.isPlatformAdmin === true, plans, testPlan, canManage: user.role === 'owner', hasCustomer: Boolean(row.customer_id), subscription: subscription ? {
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
      this.requireUnpaused(row);
      const reservationExpires = Number(new Date(String(row.checkout_expires_at)));
      const reuseReservation = Boolean(row.checkout_key && reservationExpires > Date.now() && row.checkout_price === plan.id);
      if (row.checkout_id) {
        const previous = await this.stripe.checkout.sessions.retrieve(String(row.checkout_id));
        if (previous.status === 'complete') throw new HttpError('The previous checkout has completed. Refresh your billing page before choosing another plan.', 409);
        if (reuseReservation && previous.status === 'open') return { key: String(row.checkout_key), expires: Math.floor(reservationExpires / 1000) };
        if (previous.status === 'open') await this.stripe.checkout.sessions.expire(String(row.checkout_id));
        else if (previous.status !== 'expired') throw new HttpError('The previous checkout status could not be confirmed. Try again.', 409);
      } else if (reuseReservation) return { key: String(row.checkout_key), expires: Math.floor(reservationExpires / 1000) };
      const key = randomUUID(), expires = Math.floor(Date.now() / 1000) + 35 * 60;
      await sql.query('UPDATE workspace_billing SET checkout_key=$2,checkout_price=$3,checkout_expires_at=to_timestamp($4),checkout_id=NULL WHERE workspace_id=$1', [user.workspaceId, key, plan.id, expires]);
      return { key, expires };
    });
    // Persist customer mapping before Checkout can emit a paid-invoice event.
    const customer = await this.owned(user, true, async (sql, row) => {
      this.requireUnpaused(row);
      if (row.customer_id) return String(row.customer_id);
      const created = await this.stripe.customers.create({ metadata: { workspace_id: user.workspaceId } }, { idempotencyKey: `workspace-customer:${user.workspaceId}` });
      await sql.query('UPDATE workspace_billing SET customer_id=$2 WHERE workspace_id=$1', [user.workspaceId, created.id]);
      return created.id;
    });
    return this.owned(user, true, async (sql, row) => {
      this.requireUnpaused(row);
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
        success_url: `${this.origin}/add-tokens/plans?checkout=success`, cancel_url: `${this.origin}/add-tokens/plans?checkout=canceled`,
        expires_at: attempt.expires,
      }, { idempotencyKey: `workspace-checkout:${attempt.key}` });
      if (!session.url) throw new Error('Stripe checkout URL missing.');
      await sql.query('UPDATE workspace_billing SET checkout_id=$2 WHERE workspace_id=$1', [user.workspaceId, session.id]);
      return { url: session.url };
    });
  }
  async deleteAccountCustomer({ customerId,checkoutId }: { customerId: string | null; checkoutId: string | null }): Promise<void> {
    this.assertMode();
    try {
      if (checkoutId) {
        try {
          const checkout=await this.stripe.checkout.sessions.retrieve(checkoutId);
          if (checkout.status==='open') await this.stripe.checkout.sessions.expire(checkoutId);
        } catch(error) { if ((error as {code?:string}).code!=='resource_missing') throw error; }
      }
      if (customerId) {
        try {
          const customer=await this.stripe.customers.retrieve(customerId);
          if (!customer.deleted) await this.stripe.customers.del(customerId);
        } catch(error) { if ((error as {code?:string}).code!=='resource_missing') throw error; }
      }
    } catch { throw new HttpError('Billing cleanup failed. The account has not been deleted from the app. Retry deletion.',503); }
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
      const session = await this.stripe.billingPortal.sessions.create({ customer: String(row.customer_id), configuration: configuration.id, return_url: `${this.origin}/add-tokens/plans` });
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
      const workspace=(await sql.query('SELECT id,paused_at FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
      if (!workspace) return; // Account deletion may have won the workspace lock.
      if (workspace.paused_at) {
        await sql.query('INSERT INTO workspace_paused_invoices(invoice_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[invoiceId,workspaceId]);
        return;
      }
      if ((await sql.query('SELECT 1 FROM workspace_paused_invoices WHERE invoice_id=$1',[invoiceId])).rows.length) return;
      // Delayed/replayed paid events for paused renewal periods must stay suppressed
      // after resume. A webhook retry must never backfill skipped monthly tokens.
      if ((await sql.query(`SELECT 1 FROM workspace_pause_periods WHERE workspace_id=$1
        AND to_timestamp($2)>=started_at AND (ended_at IS NULL OR to_timestamp($2)<ended_at)`,[workspaceId,periodStart])).rows.length) return;
      const inserted = await sql.query(`INSERT INTO stripe_token_grants(invoice_id,workspace_id,subscription_id,period_start,tokens)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING invoice_id`, [invoiceId, workspaceId, subscriptionId, periodStart, plan.tokens]);
      if (!inserted.rows.length) return;
      await postTokenTransaction(sql, { workspaceId, kind: 'stripe_credit', requestedAmount: plan.tokens, maxTokens: this.config.maxTokens,
        reference: `stripe:${invoiceId}`, reason: 'Paid subscription invoice', stripeInvoiceId: invoiceId });
    });
  }
}
