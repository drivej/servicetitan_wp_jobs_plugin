# Superadmin account deletion

The **Delete Account** button on `/admin/members` is available only in the superadmin page. The server rechecks the authenticated actor against `platform_administrators`; workspace ownership/admin roles are insufficient. Deletion is also refused while impersonating a user. The request must include normal session/Origin/CSRF protection and `{ "confirmation": "DELETE" }` at `DELETE /api/admin/accounts/:workspaceId`.

The dialog identifies the account and website, explains that deletion is destructive and irreversible, and requires typing **DELETE** before the final button becomes enabled. Cancel leaves the account unchanged.

## Erasure and shared users

Migration **015_account_deletion.sql** defines account-scoped cascades for memberships, invitations, connections and encrypted credentials, websites and ownership claims, account audit history, billing mappings, invoice/token grants, ledger entries, spend operations, and scanner/build queues. Incoming requests for installations owned by the deleted account are also removed. The confirmed account deletion releases its website ownership claim; credential edits and billing failures still do not release claims.

Associated user rows are locked before their remaining associations are checked. Users with another account membership or ownership are retained. Users with no other account are erased, including their sessions, platform administrator role if any, ownership requests, addressed invitations, and queued task payloads. Historical actor/inviter references in other accounts are anonymized instead of deleting those accounts’ financial records. Their balances and ledger reconciliation remain unchanged.

Shared users whose personal account is deleted can continue using surviving accounts, sign out and sign in again. Login no longer recreates an empty personal account when surviving memberships exist. Existing sessions fall back to a surviving account. A superadmin may not erase their own final account; another superadmin must perform that deletion. A successful deletion records an administrative audit event containing the acting administrator and the deleted account’s opaque identifier, without retaining the deleted account’s profile or credentials.

Normal ledger UPDATE, DELETE and TRUNCATE remain forbidden. Trigger-depth and missing-parent checks allow only referential cascades during account erasure, or FK anonymization when an actor/website was actually erased. No user-settable deletion bypass is introduced. New ledger entries cannot claim to have an already-deleted actor.

Running build/scanner jobs and reserved token operations block deletion until they complete or are reconciled. Queued/history tasks are deleted through cascades. Generated queue actor foreign keys prevent stale workers from recreating tasks for an erased user. Cached website providers and global ServiceTitan/form caches are cleared in the serving process after success; other processes must reauthorize against the deleted database records. WordPress requests hold the same workspace lock used by deletion, so deletion waits for an in-flight WordPress request before releasing the ownership claim. Other already-issued external HTTP calls cannot be recalled.

## Billing and external data

If the account has Stripe billing, the configured BillingService expires open Checkout sessions and deletes its Stripe customer before local erasure commits. Stripe customer deletion immediately cancels active subscriptions, as documented in the [Stripe customer deletion API](https://docs.stripe.com/api/customers/delete). Already-deleted/missing customers are safe to retry. If billing is configured incorrectly or cleanup fails, the app keeps the account and reports an error instead of silently forgetting a potentially billable subscription.

Stripe and PostgreSQL do not share a transaction. If remote cleanup succeeds but the database subsequently fails, retry the deletion; the remote cleanup is repeatable. Stripe may retain invoice/history records, and deleting the SaaS account does not delete published WordPress posts, ServiceTitan records, existing external credentials, or operational backups. No live customer was deleted during implementation.

## Deployment

Apply migration **015** with the migration-owner connection before deploying the updated server. A separate runtime role needs the existing application grants plus:

```sql
GRANT DELETE ON website_ownership_requests TO st_jobs_app;
```

Use the updated application migration runner (`npm run db:migrate`). During pending migration 015, it temporarily exempts the website table owner from forced row security so existing ledger website references can be validated. Normal tenant roles retain row security, and forced owner filtering is restored before the transaction commits. A failed run rolls the exception back along with the migration; retrying does not require deleting ledger data. The 015 SQL file and previously recorded checksums remain unchanged, and already-applied migrations are skipped. Invalid references still fail normal FK validation.

Substitute the real runtime role. Keep token ledger grants append-only and platform administrator grants read-only; no direct ledger DELETE or platform-administrator DELETE privilege is required. FK cascades perform the scoped cleanup. Startup verifies the new guards, queue actor columns and request-deletion permission.

Deploy updated processes together; do not leave old code that assumes every retained user has a personal workspace. No production migration or deployment is performed by the implementation task.

## Validation

New database/HTTP tests cover complete erasure, shared-user preservation and session fallback, login/logout after personal-account deletion, superadmin authorization, CSRF, typed confirmation, impersonation denial, active-work guards, billing failure rollback, cache invalidation, claim release, anonymized surviving ledgers and stale queue insertion. Billing tests cover Checkout expiry, customer deletion, retry and failure. Existing immutable-ledger and legacy migration tests remain in the suite. A browser preview with fictional account data verified the confirmation wording, disabled/enabled delete button, and cancellation.

### Recovery when pasting SQL into a database editor

If an earlier attempt persisted part of migration 015 (for example, `actor_deleted` already exists), use `scripts/recover-account-deletion.sql` instead of pasting migration 015 again. If the editor has an aborted transaction, roll it back first. Run the entire recovery file in one execution using the schema/table owner and the application's normal schema search path.

The recovery uses one transaction, checks existing columns before reusing them, replaces constraints and triggers safely, validates existing website references, and restores forced website row security before committing. It does not delete accounts, users, ledger rows, or balances. The final result should show `website_rls_restored` and `ledger_website_fk_validated` both true. On any error, roll back the failed transaction and report the error; do not continue with individual statements.

The original migration remains unchanged. Recovery records its original checksum only when all preceding migration history matches; it does not fabricate missing migration history or overwrite differing checksums.
