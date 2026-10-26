# Account pause

Account owners and account admins can open **Tokens → Plans** (or the Settings billing link), confirm **Pause account**, and later select **Resume account**. Basic members cannot pause or resume. Subscription purchases and billing-portal access remain owner-only. Superadmins can pause or resume any account from its card on **Account members**, including accounts they do not belong to. Superadmin impersonation cannot pause or resume a customer account.

Pause preserves existing members, saved tokens, account data, website ownership, and normal use of those tokens. It immediately blocks invitations and joining through existing links. Existing invitations remain valid until their normal expiry and can be accepted after resume. Stripe payment collection is paused indefinitely with `pause_collection.behavior=void`; paused periods are not billed later. Pending subscription checkouts are expired and unpaid open subscription invoices are voided; draft subscription invoices are deleted. Payments already completed are not refunded, and payments already processing may complete.

Resume removes payment collection pause without resetting the billing schedule or prorating. Renewals and token grants resume on the existing schedule, without immediate or catch-up tokens. Canceled subscriptions are not recreated; an owner can choose a new plan through Checkout after resuming.

## Deployment

Apply **016_account_pause.sql** using the migration-owner connection before deploying the new server. The application migration runner wraps migrations in a transaction. For a SQL editor, run `BEGIN`, the entire migration, and `COMMIT` together; do not apply individual statements. No live migrations or Stripe changes are performed by the build command.

Separate runtime roles need the new table grants (replace `st_jobs_app` with the configured runtime role):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_pause_periods, workspace_paused_invoices TO st_jobs_app;
```

Startup checks the new schema, grants, and membership/invitation guard triggers. Table owners already have access. Existing workspace/billing UPDATE grants continue to cover the new columns.

## Retry and consistency

Pause intent and its unique Stripe request ID are committed before Stripe calls. Token renewals and new memberships are blocked immediately. Stripe changes are serialized with other billing, membership, and token operations using the existing workspace lock. Stripe retries reuse the stored request ID. If an API call fails or the process stops, the account stays paused and the billing page offers **Retry pause** or **Retry resume**. Payment collection may continue until Stripe confirms completion; the UI does not claim success while a change is pending. Complete the pending change before requesting the opposite change.

A resume request leaves local restrictions in place until Stripe confirms. Account pause history and suppressed invoice IDs prevent delayed or duplicate paid-invoice deliveries from backfilling paused renewals. They cascade away with account deletion. The existing token ledger remains immutable; pause never changes previous credits or the saved balance.

The new team guards also protect direct membership/invitation inserts at the database layer and take the same workspace lock, preventing an invitation acceptance from racing with pause. Normal membership removal, role management, and session use remain available.

Billing changes made outside this application (for example, manually resuming Stripe collection in the Stripe Dashboard) are operator actions and should be coordinated with the account's app status. A failed request must be retried; there is no new background retry scheduler.
