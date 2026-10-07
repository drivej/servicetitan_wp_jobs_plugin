# Stripe subscriptions

Billing belongs to a workspace. Only its owner can start Checkout or open the
Stripe customer portal. Members can view the available plans and subscription.
No payment is created by loading a page.

## Local setup

1. Run in SaaS mode (`APP_MODE=saas`) with `APP_ORIGIN=http://localhost:3000`,
   a development database/runtime role, Google sign-in and encryption settings.
   Follow [development setup](development.md). Single-user local mode does not
   have account billing APIs. Use a separate development database, not production.
2. Set `STRIPE_SECRET_KEY` to your sandbox secret key. Create matching sandbox
   prices; live prices are not accessible with a sandbox key. Development blocks
   live billing credentials. `STRIPE_PRICE_TIER_1`, `_2`, `_3` accept price IDs or
   lookup keys. Hosted Checkout does not require the publishable key.
3. Set `token_count` metadata on each price to a positive integer allowance per
   paid billing cycle. Product metadata is not used for tokens. Set the server
   environment variable `MAX_TOKENS` to the maximum accumulated balance (for
   example, `MAX_TOKENS=900`), shared by all plans. Restart after changing it.
   The billing interval and interval count come from Stripe (for example, weekly,
   every three months, or yearly). Prices use quantity 1, licensed usage, and
   per-unit pricing. Each paid cycle grants token_count once, without scaling it
   by the interval.
4. Apply all migrations with `npm run db:migrate`, then grant the runtime database
   role SELECT, INSERT, UPDATE, DELETE on `workspace_billing` and
   `stripe_token_grants` (replace the role name as appropriate). Also apply the
   [ledger grants](token-ledger.md) introduced in migration 005.
5. Authenticate the Stripe CLI to your sandbox and run:

   ```sh
   stripe listen --events invoice.paid --forward-to localhost:3000/api/stripe/webhook
   ```

   Copy the CLI's `whsec_...` into `STRIPE_WEBHOOK_SECRET`. This differs from the
   secret for a Dashboard webhook endpoint. Restart the server after changing it.
6. Run `npm run dev`, sign in, and open `/add-tokens`. Subscribe with Stripe's
   sandbox card `4242 4242 4242 4242`, a future expiry and any valid CVC. Verify the
   invoice event reaches the CLI and the workspace balance changes. The return
   page itself does not grant tokens; use Refresh balance while delivery finishes.
7. Test a renewal with a Stripe test clock, failed payment, duplicate delivery,
   cancellation, and retrying Checkout. Test clocks must be attached to test
   customers before subscriptions are created. Synthetic `stripe trigger` invoice
   events for unrelated customers do not credit an application workspace.

## Behavior and limits

Each paid initial or renewal invoice adds the price’s `token_count`, capped at
the server’s `MAX_TOKENS`: `new balance = min(current balance + token_count, MAX_TOKENS)`.
The cap includes the new grant and carried-over tokens; changing it applies on the
next grant rather than rewriting existing balances immediately.
The invoice ID and subscription billing-period start are recorded atomically
with the balance update, so retries cannot grant tokens twice. Failed payments
add nothing. Existing tokens remain usable after cancellation; cancellation in
the portal takes effect at period end. Metadata is read when processing invoices;
changes affect subsequent processing. Keep historical price IDs configured while
pending invoices are being delivered.

The portal supports payment details, invoice history and cancellation. Plan
switching is disabled in the app-created portal configuration until upgrade and
proration rules are implemented. Do not change plans in the Dashboard expecting
an immediate token adjustment: prorated update invoices do not grant tokens.
Refund/dispute-driven token revocation is not implemented in this initial build.
Do not launch live billing until those operational rules have been decided.

A pending Checkout is reused to prevent duplicate subscriptions. Switching to a
different plan while Checkout is pending is blocked until that session expires
(35 minutes). Subscription status is fetched from Stripe whenever the billing
page is loaded, rather than trusting webhook delivery order.

## Deployment

Configure the same variables with live credentials/prices, apply migration 004
and database grants, and set the production APP_ORIGIN. Register
`https://YOUR_APP_DOMAIN/api/stripe/webhook` for `invoice.paid`, with API version
`2026-09-30.endive` (the installed SDK version). Use that endpoint's signing secret
in production. The webhook is intentionally outside cookie/CSRF middleware and
verifies Stripe signatures against the raw body. Other billing endpoints require
normal session, workspace and CSRF validation.

The integration does not automatically enable tax collection or promotion codes.

## Free subscription Checkout test

Set `STRIPE_PRICE_FREE=subscription_free` (or its price ID) and
`ENABLE_TEST_TOKENS=true`, then restart the server. This price must be a zero-cost
recurring price with positive `token_count` metadata, in the same Stripe
sandbox as the configured key. On Pricing and Add Tokens, workspace owners see a
**Free test subscription** alongside the paid plans. This uses normal Checkout and grants tokens only after
Stripe sends the zero-total `invoice.paid` event; the normal `MAX_TOKENS` cap and
invoice deduplication apply. No card charge is made by a zero-cost subscription.

Use a workspace without an existing subscription. The existing one-subscription
and pending-Checkout protections also apply to this plan. The direct
**Add 1 test token** button remains a separate shortcut that does not test Stripe.

When `ENABLE_TEST_TOKENS=false`, the server rejects new purchases of this test
price and hides the plan. Existing subscriptions are not canceled: their paid
invoices still grant tokens while `STRIPE_PRICE_FREE` remains configured. Cancel
the test subscription through Manage billing when finished. Development still
requires sandbox credentials, including for free subscriptions.

All credits and spending now post to the [token ledger](token-ledger.md), including cap effects and platform-admin adjustments.
