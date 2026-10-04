import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { loadBillingConfig } from './billing-config.js';
import { BillingService, planFromPrice } from './billing.js';
import type { Database } from './database.js';
const price = (metadata: Record<string, string> = { token_count: '100' }) => ({ id: 'price_a', active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, billing_scheme: 'per_unit', unit_amount: 1000, currency: 'usd', metadata, product: { id: 'prod_a', name: 'Plan', metadata: { token_count: '50' } } }) as unknown as Stripe.Price;
test('tokens come only from price token_count; the balance cap comes from config', () => {
  assert.equal(planFromPrice(price(), 900).tokens, 100);
  assert.equal(planFromPrice(price({ token_count: '100', MAX_TOKENS: '200' }), 900).maxTokens, 900);
  for (const metadata of [{}, { MONTHLY_TOKENS: '100' }, { token_count: '0' }, { token_count: '-1' }, { token_count: '1.5' }, { token_count: 'NaN' }]) {
    assert.throws(() => planFromPrice(price(metadata), 900));
  }
  assert.throws(() => planFromPrice({ ...price(), recurring: null }, 900));
});
test('billing config is optional and accepts lookup keys', () => {
  assert.equal(loadBillingConfig({}), undefined);
  const config = loadBillingConfig({ STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_example', STRIPE_PRICE_TIER_1: 'basic', STRIPE_PRICE_TIER_2: 'plus', STRIPE_PRICE_TIER_3: 'pro', MAX_TOKENS: '900' });
  assert.deepEqual(config?.prices, ['basic', 'plus', 'pro']);
  assert.equal(config?.maxTokens, 900);
  for (const max of ['', '0', '-1', '1.5', 'Infinity', '2147483648']) {
    assert.throws(() => loadBillingConfig({ STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_example', MAX_TOKENS: max }), /MAX_TOKENS/);
  }
  assert.throws(() => loadBillingConfig({ STRIPE_SECRET_KEY: 'sk_test_example' }));
});
test('signature validation rejects forged events; development rejects live credentials', async () => {
  const db: Database = { transaction: async () => { throw new Error('Database must not be accessed'); } };
  const config = { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: [], development: true, maxTokens: 200 };
  const billing = new BillingService(db, config, 'http://localhost:3000');
  await assert.rejects(billing.webhook(Buffer.from('{}'), 'bad'), /signature/);
  const body = JSON.stringify({ id: 'evt_test', type: 'customer.subscription.updated', livemode: false, data: { object: {} } });
  const signature = billing.stripe.webhooks.generateTestHeaderString({ payload: body, secret: config.webhookSecret });
  await billing.webhook(Buffer.from(body), signature);
  await assert.rejects(new BillingService(db, { ...config, secretKey: 'sk_live_example' }, 'http://localhost:3000').plans(), /sandbox/);
});

test('paid renewal webhook credits invoice lines, ignoring unpaid and prorated invoices', async () => {
  const db: Database = { transaction: async () => { throw new Error('Unexpected SQL'); } };
  const config = { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: ['price_a'], development: true, maxTokens: 200 };
  let reason = 'subscription_cycle', status = 'paid';
  const stripe = new Stripe(config.secretKey);
  stripe.invoices.retrieve = (async () => ({ id: 'in_renewal', status, billing_reason: reason, customer: 'cus_a', parent: { subscription_details: { subscription: 'sub_a' } } })) as never;
  stripe.invoices.listLineItems = (async () => ({ has_more: false, data: [{ quantity: 1, pricing: { price_details: { price: 'price_a' } }, parent: { subscription_item_details: { proration: false } }, period: { start: 100 } }] })) as never;
  stripe.prices.retrieve = (async () => price()) as never;
  const billing = new BillingService(db, config, 'http://localhost:3000', stripe);
  const grants: unknown[][] = [];
  billing.creditInvoice = async (...args) => { grants.push(args); };
  const body = JSON.stringify({ id: 'evt_paid', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_renewal' } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret: config.webhookSecret });
  await billing.webhook(Buffer.from(body), signature);
  assert.deepEqual(grants[0]?.slice(0, 4), ['cus_a', 'in_renewal', 'sub_a', 100]);
  reason = 'subscription_update';
  await billing.webhook(Buffer.from(body), signature);
  reason = 'subscription_cycle'; status = 'open';
  await billing.webhook(Buffer.from(body), signature);
  assert.equal(grants.length, 1);
});


test('free Checkout configuration is gated by ENABLE_TEST_TOKENS', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_example', STRIPE_PRICE_TIER_1: 'basic', STRIPE_PRICE_TIER_2: 'plus', STRIPE_PRICE_TIER_3: 'pro', MAX_TOKENS: '900', STRIPE_PRICE_FREE: 'subscription_free' };
  assert.equal(loadBillingConfig(env)?.testTokensEnabled, false);
  assert.equal(loadBillingConfig({ ...env, ENABLE_TEST_TOKENS: 'true' })?.testTokensEnabled, true);
  assert.equal(loadBillingConfig(env)?.freePrice, 'subscription_free');
  assert.throws(() => loadBillingConfig({ ...env, STRIPE_PRICE_FREE: 'basic' }), /distinct/);
});

test('zero-total invoices credit free subscriptions even after the testing flag is disabled', async () => {
  const db: Database = { transaction: async () => { throw new Error('Unexpected SQL'); } };
  const config = { secretKey: 'sk_test_example', webhookSecret: 'whsec_example', prices: [], freePrice: 'price_a', testTokensEnabled: false, development: true, maxTokens: 200 };
  const stripe = new Stripe(config.secretKey);
  stripe.prices.retrieve = (async () => ({ ...price(), unit_amount: 0, recurring: { ...price().recurring!, interval: 'week', interval_count: 2 } })) as never;
  stripe.invoices.retrieve = (async () => ({ id: 'in_free', status: 'paid', amount_paid: 0, billing_reason: 'subscription_create', customer: 'cus_free', parent: { subscription_details: { subscription: 'sub_free' } } })) as never;
  stripe.invoices.listLineItems = (async () => ({ has_more: false, data: [{ quantity: 1, pricing: { price_details: { price: 'price_a' } }, parent: { subscription_item_details: { proration: false } }, period: { start: 100 } }] })) as never;
  const billing = new BillingService(db, config, 'http://localhost:3000', stripe);
  const grants: unknown[][] = [];
  billing.creditInvoice = async (...args) => { grants.push(args); };
  const body = JSON.stringify({ id: 'evt_free', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_free' } } });
  await billing.webhook(Buffer.from(body), stripe.webhooks.generateTestHeaderString({ payload: body, secret: config.webhookSecret }));
  assert.deepEqual(grants[0]?.slice(0, 4), ['cus_free', 'in_free', 'sub_free', 100]);
  assert.equal((grants[0]?.[4] as { tokens: number }).tokens, 100);
});


test('plans preserve Stripe recurrence for daily, weekly, monthly and yearly billing', () => {
  for (const interval of ['day', 'week', 'month', 'year'] as const) {
    for (const count of [1, 2, 3]) {
      const plan = planFromPrice({ ...price(), recurring: { ...price().recurring!, interval, interval_count: count } }, 900);
      assert.equal(plan.interval, interval);
      assert.equal(plan.intervalCount, count);
      assert.equal(plan.tokens, 100);
    }
  }
  for (const count of [0, -1, 1.5]) {
    assert.throws(() => planFromPrice({ ...price(), recurring: { ...price().recurring!, interval_count: count } }, 900));
  }
});
