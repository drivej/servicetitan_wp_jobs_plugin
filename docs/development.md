# SaaS foundation: development and deployment

Phase 1 adds Google-only accounts, persistent sessions, encrypted ServiceTitan and WordPress credentials, owned websites, and website-scoped access to the existing manual publishing workflow. No billing policy has been implemented. The build-and-deploy worker uses the durable queue described in the README; the pull connector remains a later milestone; WordPress Application Passwords are temporary credentials for the existing push adapter.

## Local single-user workflow

Existing `.env` credentials still work with `npm run dev`. In development, absent `APP_MODE` defaults to `local`; it binds only `127.0.0.1`. `APP_MODE=local` is forbidden when `NODE_ENV=production`. Never tunnel or expose local single-user mode to other users. Production defaults to SaaS and fails startup if account/database configuration is missing.

## SaaS development configuration

Use Node 22.22 or newer and PostgreSQL 17. Put these in your ignored `.env` (use your actual local configuration):

```dotenv
APP_MODE=saas
APP_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://st_jobs_app:REPLACE_ME@localhost:5432/st_jobs
MIGRATION_DATABASE_URL=postgresql://DATABASE_OWNER:REPLACE_ME@localhost:5432/st_jobs
GOOGLE_CLIENT_ID=REPLACE_ME
GOOGLE_CLIENT_SECRET=REPLACE_ME
CREDENTIAL_ENCRYPTION_ACTIVE_KEY=v1
CREDENTIAL_ENCRYPTION_KEYS={"v1":"REPLACE_WITH_BASE64_32_BYTE_KEY"}
TRUST_PROXY_HOPS=0
```

Generate an encryption key locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Keep the result in secret configuration, not source control or chat. The key ring enables rotation: retain the old key while adding a new ID and selecting it as active. Existing envelopes continue to decrypt; writing credentials again encrypts with the active key. Back up keys securely with the database recovery plan. There is no bulk re-encryption command yet.

Google OAuth client setup must allow the exact callback `http://localhost:3000/auth/google/callback` for development, and `https://YOUR_APP_DOMAIN/auth/google/callback` for production. Request only `openid email profile`. Real Google login requires an owner-configured OAuth client; tests substitute only the external provider, not the production authentication middleware. No development-login endpoint is shipped.

## Database setup

Use a non-superuser login without `BYPASSRLS`. A separate restricted runtime login is preferred where available; a single-login database may use the table owner for both migrations and runtime. The web server checks the role and ledger triggers at startup. Apply migrations before starting the app:

```sh
npm install
npm run db:migrate
```

The runner uses `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` for single-login setups. It serializes migrations with a transaction-scoped advisory lock, applies the batch transactionally, and refuses modified historical migration files. It does not automatically migrate when the web process starts.

After migrations, a database administrator can grant a separate runtime login the following privileges (substitute the real role if different). These grants are unnecessary when `DATABASE_URL` uses the owner of both protected tables:

```sql
GRANT CONNECT ON DATABASE st_jobs TO st_jobs_app;
GRANT USAGE ON SCHEMA public TO st_jobs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, oauth_attempts, rate_limits,
  workspaces, workspace_memberships, workspace_invitations,
  servicetitan_connections, websites, audit_logs, workspace_billing, stripe_token_grants
TO st_jobs_app;
GRANT SELECT, INSERT ON token_transactions TO st_jobs_app;
REVOKE UPDATE, DELETE, TRUNCATE ON token_transactions FROM st_jobs_app;
GRANT SELECT ON platform_administrators TO st_jobs_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_administrators FROM st_jobs_app;
```

For the restricted-login setup, the login itself must already exist with its password held in the secret store. Do not grant it schema creation or migration-table privileges. With a table-owner runtime login, the ledger triggers still enforce normal writes, but a compromised database credential could disable triggers or edit platform administrators. Connections, websites and audit tables use forced row-level security. Every workspace operation runs in one transaction with `SET LOCAL`-equivalent user and workspace context. Resource RLS also checks membership. Workspaces, memberships, and invitations are authorization control tables accessed only through the server, like sessions; callers cannot query them directly. Auth tables are intentionally accessed through narrowly scoped server code before a user is known. They are not browser APIs.

For remote PostgreSQL, configure verified TLS in the connection string/provider configuration. Do not disable certificate verification. With separate logins, keep the migration credential out of the hosted web process.

Run `npm run dev`, open the app, sign in with Google, and use **Account & websites** to add a connection followed by a website. Saving does not contact ServiceTitan or WordPress. Opening Jobs tests retrieval; plugin status checks test WordPress access. SaaS website URLs must use public HTTPS endpoints. Private/local WordPress sites remain available only in the local single-user mode.

## API boundary

- `GET /api/session`: current profile and CSRF token, or 401; no bearer session token in JSON.
- `POST /api/logout`: revoke the current session.
- `GET/POST /api/connections`, `PUT /api/connections/:id`: own connection metadata and credential replacement.
- `GET/POST /api/websites`, `PUT /api/websites/:id`: own websites and optional WordPress credential replacement.
- `/api/websites/:id/jobs...` and `/api/websites/:id/wordpress...`: existing integration routes, with ownership resolved before constructing/accessing provider clients.
- The former global `/api/jobs...` and `/api/wordpress...` are unavailable in SaaS mode.
- Mutations require the exact configured Origin and `X-CSRF-Token` from `/api/session` in addition to the HttpOnly session cookie.

Tenant/environment and site URL/connection identities are immutable in this milestone: create a new resource instead of silently redirecting existing job identities. Credential forms never retrieve secrets. Session expiry is seven days; logout removes the database session. Google subject is the permanent key; matching email addresses do not merge accounts.

WordPress calls use DNS validation at socket connection time and reject redirects. All DNS answers must be public addresses; this prevents user-configured sites from becoming a private-network proxy. Use the site's final canonical HTTPS URL. Do not relax this for hosting convenience.

## Verification

```sh
npm test
npm run build
php -l wordpress-plugin/servicetitan-job-integration/servicetitan-job-integration.php
```

Local account tests use PGlite's embedded PostgreSQL engine with a restricted role. Set `TEST_DATABASE_URL` to a **disposable test database with permission to create test schemas/roles** to run the same cases on PostgreSQL. Each test run creates an isolated random schema and role, then removes them. CI supplies PostgreSQL 17 and runs this path. Never point this variable at production.

Coverage includes two users sharing an email, identity/session rotation, encrypted secrets, cross-user reads/writes, RLS without an owner filter, composite ownership foreign keys, OAuth state/browser binding/expiry/replay, CSRF, unscoped route denial, persisted rate limits, and the existing content/publishing tests.

## Hosted release prerequisites and remaining work

Build with `npm ci && npm run build`; start with `npm start`. Set `NODE_ENV=production`, `APP_MODE=saas`, an HTTPS `APP_ORIGIN`, and the secret variables above. Set `TRUST_PROXY_HOPS` only after verifying the exact trusted reverse-proxy topology; default 0 trusts no forwarded client IPs. `/api/health` is a process health endpoint, not a database readiness check.

No Sevalla resources have been provisioned. The region, resources, domain, Google OAuth registration and database/runtime credentials still need configuration. This implementation is not a production launch: the existing push adapter still has process-local publication locking and partial-publication recovery limitations. Next phases add durable operations, generation/cost provenance, the pull connector, billing semantics and Stripe. Account deletion/export, connection/site archival, bulk encryption rotation, operational cleanup jobs and fuller WordPress integration tests also remain future work.

The existing privacy limitation remains: summary text is not a comprehensive PII redactor. SaaS no longer sends the raw job object or the structured street/unit address to its editor/generator, but free-text facts still require review and stronger minimization before automated publication.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [openid-client](https://github.com/panva/openid-client), [node-postgres transactions](https://node-postgres.com/features/transactions).

## Run locally against a remote test database

Use a dedicated development PostgreSQL database, separate from production. The `.env.remote` profile is ignored by Git; `.env.remote.example` documents its fields. `npm run dev:remote` runs the authenticated SaaS workflow on loopback while using the remote database for accounts, sessions, integrations, and job tokens. It does not read the usual `.env` file. ServiceTitan and WordPress credentials are entered through the account UI; optionally configure OpenAI in `.env.remote` for AI generation.

1. Provision PostgreSQL with a public connection endpoint accessible from your development machine and verified TLS. If your provider uses its own CA, include the provider's CA path as `sslrootcert` in the URL; keep `sslmode=verify-full`.
2. Put a non-superuser login without BYPASSRLS in `DATABASE_URL`. On a single-login database, use the table owner; otherwise use a separate restricted login and put the owner's direct URL in `MIGRATION_DATABASE_URL`. URL-encode special characters in passwords.
3. Configure the development Google OAuth client and `http://localhost:3000/auth/google/callback`. Keep the generated encryption key stable; changing it loses access to previously saved encrypted integration credentials.
4. Run `npm run db:migrate:remote`. If using a separate runtime login, apply the runtime grants in the Database setup section using your actual database and role names.
5. Run `npm run db:check:remote` to verify connectivity, runtime permissions, ownership policies, and the job-token migration.
6. Run `npm run dev:remote` and open `http://localhost:3000`. Sign in and configure test integrations. Allocate development job tokens as described in the README.

The runner keeps migration credentials out of the web-server process. It rejects missing credentials and URLs without `sslmode=verify-full`. Regular `npm run dev` continues to use `.env`. These commands exercise the app with a remote database; `npm test` continues to use embedded PostgreSQL unless a separate disposable `TEST_DATABASE_URL` is explicitly supplied.

### Current Sevalla development instance

Provisioned in the **ServiceTitan WP Jobs Plugin** project: **ServiceTitan Jobs Dev**, PostgreSQL 17, London, DB1 ($5/month), database `st_jobs_dev`. External networking was enabled with owner approval. The migration owner URL is stored only in ignored `.env.remote`.

Connection verification found that this instance rejects PostgreSQL TLS negotiation (`The server does not support SSL connections`); Studio reports `ssl=off`. The supplied owner is not a superuser and has no `CREATEROLE` permission. Both versioned migrations were applied atomically through Sevalla's HTTPS Studio, preserving the repository checksums.

Local app startup against this remote database still needs a verified encrypted connection (provider-enabled TLS or an encrypted tunnel) and Google OAuth development credentials. Keep `sslmode=verify-full`; do not work around this by sending application/session data over an unencrypted public database connection. External access is currently enabled without IP restrictions. No app users or test token allocations have been added.

The Sevalla app deployment workflow's `SEVALLA_TOKEN` authenticates only the deployment API call. It cannot grant SQL privileges. The `ServiceTitan Jobs Dev` database currently exposes only the `like-red-cicada` login, which owns `token_transactions` and `platform_administrators`; the app now permits this owner login at runtime. The database owner can change protected tables or triggers, so keep this credential private and switch to the restricted-login setup when available. Run `npm run db:check:remote` against the same database before deploying when a verified connection is available.


## Team workspaces

Migration `003_workspaces.sql` gives every existing user a workspace and an owner membership. It moves tokens into `workspaces.job_tokens`, changes integration ownership to `workspace_id`, and preserves old encryption contexts by keeping workspace IDs equal to former owner IDs. Existing sessions and audit history are migrated too. Do not edit previously applied migration files.

This schema change is **not compatible with the old server**. Take a database backup and use a maintenance window: stop the old web process, run `npm run db:migrate` with the migration-owner connection, grant the new tables to the runtime role using the SQL above, then deploy/start the new server. `npm run db:check:remote` checks the new tables and grants when a working remote development connection is configured. Do not run old and new server versions against this schema together.

Settings → Team lets an owner invite admins or members. Admins can invite/remove members and edit integrations; only owners can promote/demote admins, manage other admins, or add test tokens. Members can process jobs on every website in that workspace. Roles and membership are checked on the server for each operation. Removing a member blocks new work immediately; an operation already authorized and running may finish before the removal transaction completes. Removing or demoting an admin also revokes their pending invitations.

Invitation links expire after seven days and require the exact verified Google email (case-insensitive). Only the token hash is stored. Links put the token in a URL fragment so it is not sent in HTTP URLs/access logs. The recipient signs in, previews the workspace and role, and accepts. Reissuing revokes the old link; accepted/expired/revoked links cannot be reused. The UI provides Copy link and Open email invitation; there is no automatic email sender configured.

The workspace selector changes the current session. Other tabs refresh when they notice the change; requests carry an expected workspace header to prevent stale tabs from mutating the wrong workspace. Shared spending locks the workspace row and rechecks membership, balances, and website ownership. Successful charges include the actor, workspace, website, action, and job ID in audit logs. Failed provider calls do not charge tokens.

See [Stripe subscriptions](stripe.md) for sandbox setup and billing migration requirements.

See [token ledger and platform administration](token-ledger.md) for migration 005, operator bootstrap and adjustment APIs.
