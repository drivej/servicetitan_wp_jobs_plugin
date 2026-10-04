# Token ledger and platform administration

Token accounts belong to workspaces. Customers share their workspace balance;
platform administrators are separate from customer workspace owners/admins.

## Deployment

Run the normal migrations (`npm run db:migrate`) with the migration-owner
connection, then apply these grants using a database owner. Substitute your actual
runtime role. Never use the migration owner as the web runtime role.

```sql
GRANT SELECT, INSERT ON token_transactions TO st_jobs_app;
REVOKE UPDATE, DELETE, TRUNCATE ON token_transactions FROM st_jobs_app;
GRANT SELECT ON platform_administrators TO st_jobs_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_administrators FROM st_jobs_app;
```

Inherited roles and PUBLIC grants must not reintroduce these privileges. Startup
checks enforce them and require the ledger integrity triggers. The runtime role
must not own these tables or inherit their owner role.

Migration 005 freezes balance writes while it creates an opening entry for every
existing workspace. This preserves current balances without inventing historical
cap effects. Old Stripe grant records and action audits remain intact. New
workspaces start at zero and get their first entry when tokens move.

### Grant the first platform administrator

First have the intended operator sign in normally. Using the database-owner
connection, identify the exact existing user ID (email alone is not the unique
account key), then insert that ID:

```sql
SELECT id, email, name FROM users WHERE lower(email)=lower('operator@example.com');
INSERT INTO platform_administrators(user_id)
VALUES ('REPLACE_WITH_VERIFIED_USER_UUID') ON CONFLICT DO NOTHING;
```

Refresh the app. The **Token admin** link opens `/admin/tokens`. No administrator
is granted automatically and no browser API can grant this role. To revoke it:

```sql
DELETE FROM platform_administrators WHERE user_id='REPLACE_WITH_USER_UUID';
```

Every admin API request rechecks the database, including retries of older
adjustments. Workspace owner/admin roles alone cannot make adjustments or view
other customers' accounts.

## Accounting behavior

`token_transactions` is append-only and stores sequence, actual signed change,
requested amount, amount discarded by the cap, balance before/after, actor,
reason, reference, timestamp and optional invoice/job/website IDs. An insert
updates `workspaces.job_tokens` in the same database transaction. Triggers reject
mutated/deleted/truncated history, a broken balance chain, and unlogged balance
changes. Account operations serialize on the workspace row.

- Stripe: paid initial/renewal invoices create a grant record and ledger credit
  atomically. Invoice and subscription-period uniqueness prevent duplicate
  credits. The ledger records the actual credit after `MAX_TOKENS`, including
  zero credits at the cap. If the cap is lowered below an existing balance, the
  next grant records the resulting net reduction and discarded amount explicitly.
- Spending: successful pushes, rebuilds and AI generation record a debit of one
  token, with actor and job/website references. Failed provider calls do not debit.
- Test credits: the existing test button also posts ledger entries.
- Admin adjustments: a signed nonzero integer and mandatory reason produce an
  `admin_adjustment`. Positive adjustments intentionally bypass the subscription
  rollover cap for manual corrections. Negative adjustments cannot overdraw the
  account. Retry the same `requestId` with the exact same details to retrieve the
  original transaction; changed details return 409. Corrections are new entries,
  never edits to an old entry. The UI retains the request ID after an ambiguous
  network/server error; keep the page open and use **Retry this transaction**.

Workspace owners/admins can see their own history on Add Tokens. Platform admins
can search all accounts by workspace name or owner email, page through history,
and post adjustments. History includes a reconciliation comparison of the ledger
sum with the stored balance. It uses sequence-based pagination so concurrent new
entries do not duplicate older pages.

## API

- `GET /api/tokens/history?before=SEQUENCE`: current workspace, owner/admin only.
- `GET /api/admin/token-accounts?search=TEXT&after=WORKSPACE_UUID`: platform-admin account search, 50 per page.
- `GET /api/admin/token-accounts/:workspaceId/transactions?before=SEQUENCE`: 50 ledger entries per page.
- `POST /api/admin/token-accounts/:workspaceId/transactions`: `{ "amount": 10, "reason": "Support credit", "requestId": "UUID" }`.

Admin targets come from the path. The normal session, Origin/CSRF and active
workspace checks still apply. The browser's X-Workspace-ID must describe the
operator's active workspace, not the target customer's workspace.

## Boundaries

Ledger and database balance changes are atomic. External WordPress/OpenAI work
cannot participate in that PostgreSQL transaction: if the provider succeeds but
the connection or commit fails, an external side effect may exist without a debit.
Spending currently uses an operation reference per invocation, not an end-to-end
client retry key. Do not claim exactly-once execution for external operations;
provider idempotency/reservation recovery is a separate follow-up.

Stripe refund/dispute events do not automatically reverse tokens. A platform
admin can post a reasoned correction now; automated refund policy remains to be
defined. This ledger tracks integer service tokens, not payment amounts, taxes,
or a monetary general ledger. Stripe remains the payment record.
