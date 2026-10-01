# SaaS foundation: development and deployment

Phase 1 adds Google-only accounts, persistent sessions, encrypted ServiceTitan and WordPress credentials, owned websites, and website-scoped access to the existing manual publishing workflow. No billing policy has been implemented. The durable worker and pull connector are later milestones; WordPress Application Passwords are temporary credentials for the existing push adapter.

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

Use a database owner for migrations and a separate non-superuser runtime login with no `BYPASSRLS`. The web server checks this at startup. Apply migrations before starting the app:

```sh
npm install
npm run db:migrate
```

The runner uses `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` for local setups. It serializes migrations with a transaction-scoped advisory lock, applies the batch transactionally, and refuses modified historical migration files. It does not automatically migrate when the web process starts.

After migrations, the database administrator can grant the runtime login the following privileges (substitute the real role if different):

```sql
GRANT CONNECT ON DATABASE st_jobs TO st_jobs_app;
GRANT USAGE ON SCHEMA public TO st_jobs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, oauth_attempts, rate_limits,
  servicetitan_connections, websites, audit_logs
TO st_jobs_app;
```

The login itself must already exist with its password held in the secret store. Do not grant it schema creation or migration-table privileges. Connections, websites and audit tables use forced row-level security. Every account operation runs in one transaction with `SET LOCAL`-equivalent user context. Auth tables are intentionally accessed through narrowly scoped server code before a user is known. They are not browser APIs.

For remote PostgreSQL, configure verified TLS in the connection string/provider configuration. Do not disable certificate verification. Keep the migration credential out of the web process in hosted deployments.

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
