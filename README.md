# ServiceTitan Jobs

The SaaS account foundation is now available: Google sign-in, PostgreSQL-backed
accounts and sessions, encrypted integration credentials, multiple websites, and
ownership-protected job workflows. See [development and deployment setup](docs/development.md).
The instructions below describe the existing local single-user workflow; hosted
production now requires SaaS configuration and will not run in local mode.

A React and Express application that queries completed ServiceTitan jobs with image attachments by first appointment date, resolves each job type name and location, and safely creates correlated WordPress custom posts with selected job images.

The user-facing setup documentation is available in the running app at
`/help`.

## Local development

Requires Node.js 24.22.1. Use `nvm install && nvm use` with the checked-in `.nvmrc`.

1. Copy `.env.example` to `.env` and enter credentials from the same ServiceTitan environment.
2. Ensure the ServiceTitan app has read access to **Jobs**, **Job Types**, **Locations**, and **Settings → Tag Types**. Assigned job tags are resolved to names and included as classification context when generating project copy.
3. Configure a WordPress user with permission to create the custom post type and generate an Application Password under **Users → Profile**.
4. Install and run:

   ```sh
   npm install
   npm run dev
   ```

5. Open `http://localhost:3000`.

The development command also packages the companion WordPress plugin. Download
it from the app's **WordPress plugin** tab, then upload and activate it under
**WordPress → Plugins → Add New Plugin → Upload Plugin**.

`ST_ENVIRONMENT` defaults to `integration`. Set it to `production` only when using production client credentials. Credentials stay on the Express server and are never sent to the browser.

## OpenAI copy generation

Set `OPENAI_API_KEY` to a dedicated OpenAI project API key and set
`OPENAI_MODEL` to a Structured Outputs-compatible model. The default model is
`gpt-6-luna`. Both values remain on the Express server and are never sent to the
browser or WordPress.

The job details screen's **Generate copy** action reloads trusted ServiceTitan
job data on the server and sends the service title, redacted summary, service
address, and available equipment names to the OpenAI Responses API. A strict
JSON schema requires separate `title` and `excerpt` fields. The generated result
is placed in the existing editor for human review; it is not published until the
user chooses **Push** or **Update**. The prompt permits city, state, and ZIP in
public copy while explicitly prohibiting the street address and unit number.

## WordPress configuration

Set the following server-side variables:

- `WORDPRESS_URL`: Site root, such as `https://example.com`.
- `WORDPRESS_USERNAME`: Login name for the WordPress integration user.
- `WORDPRESS_APPLICATION_PASSWORD`: A dedicated WordPress Application Password, not the user's interactive password.
- `WORDPRESS_POST_TYPE_REST_BASE`: Custom post type REST base; defaults to `st_job` when omitted. This project's WordPress post type currently exposes `st-jobs`.
- `WORDPRESS_POST_STATUS`: Status used when creating a post; defaults to `draft`.
- `WORDPRESS_ZIP_ACF_FIELD_NAME`: Shared ACF Taxonomy field name for Posts, Pages, and job posts; defaults to `my_zip_codes`.

Advanced Custom Fields is a required companion-plugin dependency. The plugin
registers the configured field as a multi-select relationship to its indexed
ZIP taxonomy. Missing ZIP terms are created automatically when jobs are pushed.
Each ZIP term stores its city and state once for reuse by Posts, Pages, and jobs.
Manage these shared records under **Posts → ZIP Codes** or **ServiceTitan Jobs
→ ZIP Codes**. Custom post types can opt in with the `stji_zip_post_types`
WordPress filter.

The app resolves each five-digit ZIP through Zippopotam.us before publishing.
No API key or account is required. If the service is unavailable, the app falls
back to ServiceTitan's city/state so publishing can continue. Set the optional
`ZIP_LOOKUP_API_URL` only when using a compatible proxy or mirror.

If you already know the complete custom-post collection endpoint, `WORDPRESS_API_URL` can replace `WORDPRESS_URL` and `WORDPRESS_POST_TYPE_REST_BASE`. Equivalent `WP_*` aliases are also accepted for compatibility.

The companion plugin registers the `st_job` post type and exposes it through the REST API. The configured WordPress user must be able to create posts. Remote WordPress connections are required to use HTTPS; HTTP is accepted only for localhost, loopback, `.local`, and `.test` development hosts.

### Companion WordPress plugin

The independently deployable PHP source lives in
`wordpress-plugin/servicetitan-job-integration`. Run `npm run build:plugin` to
package it as `dist/downloads/job-showcase-for-servicetitan-1.19.2.zip`. The app serves
that archive at `/downloads/job-showcase-for-servicetitan-1.19.2.zip` (with the
unversioned URL retained as a compatibility alias).

The plugin registers the `st_job` post type when it does not already exist and
maps its `create_posts` capability to its existing `edit_posts` capability. It
contains no API credentials. Sites using a different post type key can
customize it with the `stji_post_type` WordPress filter.

The plugin exposes an authenticated compatibility endpoint. The app checks this
endpoint before enabling WordPress refresh, push, or status-change actions and
directs users to the **WordPress plugin** tab when an install or update is
required.

Generated posts store the SEO generator version and a fingerprint of the title,
excerpt, and content. The Jobs and Job Details views flag legacy, outdated, and
manually edited SEO. Regeneration reloads current ServiceTitan data and updates
only generated post fields and ZIP taxonomy data; publication status, media,
featured image, slug, and post URL are preserved. Manually edited content
requires explicit overwrite confirmation, and WordPress revisions remain
available for recovery.

When a job is pushed, its ZIP code is assigned to the plugin's
`st_job_zipcode` taxonomy. Add `[servicetitan_jobs]` to a WordPress page to show
published jobs with pagination. Blank or omitted `zipcodes` uses the page’s `my_zip_codes` ACF field (or the configured field name), merging and deduplicating ZIPs from all ancestor pages. Existing ACF Text, Text Area, Select, and Checkbox fields are supported with ZIPs separated by commas, whitespace, or semicolons. Set `inherit_zipcodes="false"` to use only the current page. Explicit `zipcodes` overrides page ZIPs. If no valid ZIPs are found, the shortcode renders nothing. ZIP filtering has no
visitor-facing ZIP controls are rendered. Configure it with
`zipcodes="07001,07002"`, `offset="1"`, `limit="10"`, and `page_size="2"`.
`posts_per_page` remains available as a backward-compatible alias when
`page_size` is omitted. Each shortcode card contains only the job's featured
image, linked title, and excerpt. On a single job page, the plugin appends the
approximate ZIP-based map and a **Project Area** link to any published city page
that shares the job's ZIP taxonomy term through the configured ACF field. The
same metadata row displays the ServiceTitan completion date when available.

### ServiceTitan ↔ WordPress correlation

New WordPress posts use a slugified SEO title followed by the ServiceTitan job ID, for example:

```text
water-damage-service-in-austin-tx-42370117
```

The companion plugin matches posts only using stored ServiceTitan job-ID metadata. Existing post URLs are preserved during regeneration. The server checks this identity before creating a post to prevent duplicates.

**Refresh page statuses** sends the visible page's ServiceTitan IDs in one app
request. Companion plugin 1.20.2 resolves stored job IDs and returns found and missing statuses together.

## Build and run

```sh
npm run build
npm start
```

The build emits the React application to `dist/client` and the Node server to `dist/server`. The production server serves both the API and client on the `PORT` environment variable.

## Sevalla / Kinsta deployment

Sevalla’s native Git integration handles automatic deployment on commit. The [manual backup deployment workflow](.github/workflows/deploy.yml) uses `SEVALLA_TOKEN` only when explicitly dispatched in GitHub Actions. That token only authorizes the Sevalla API request; it does not create PostgreSQL roles, run migrations, or change database permissions. Apply migrations before deploying. The app accepts either a restricted non-owner PostgreSQL login or the owner of both token tables as `DATABASE_URL`; see [database setup](docs/development.md#database-setup).

The GitHub workflow is manual-only (`workflow_dispatch`) and restricted to `feat/saas-foundation`. It does not run on pushes, preventing duplicate deployments alongside Sevalla’s automatic-on-commit integration. It pins the published `sevalla-deploy` v2.0.0 release by commit SHA and passes the selected branch explicitly. For a deliberate backup deployment, select that branch when running the workflow (GitHub’s Run workflow control requires the workflow to exist on the repository’s default branch). The Actions secret `SEVALLA_TOKEN` must authorize deployment to the configured app ID. API-triggered deployments can appear as Manual in Sevalla; normal pushes should produce only Automatic on commit.

The current Sevalla development database has only its owner login available. It can run the app without additional PostgreSQL roles after this change. Ledger transactions and integrity triggers still enforce normal accounting, but a compromised owner credential could alter the tables or disable triggers. Use a restricted runtime login and the [grants](docs/development.md#database-setup) when the database provider supports it.

Deploy this directory as a Node.js application and configure these environment variables in the hosting dashboard:

- `NODE_ENV=production`
- `ST_ENVIRONMENT=integration` or `production`
- `ST_CLIENT_ID`
- `ST_CLIENT_SECRET`
- `ST_APP_KEY`
- `ST_TENANT_ID`
- `WORDPRESS_URL`
- `WORDPRESS_USERNAME`
- `WORDPRESS_APPLICATION_PASSWORD`
- `WORDPRESS_POST_TYPE_REST_BASE`
- `WORDPRESS_POST_STATUS`
- `WORDPRESS_ZIP_ACF_FIELD_NAME`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional; defaults to `gpt-6-luna`)
- `ZIP_LOOKUP_API_URL` (optional; defaults to `https://api.zippopotam.us`)

The checked-in `nixpacks.toml` installs checksum-verified Node.js 24.22.1 before dependencies/build and starts the app with that exact binary. Its custom runtime phase avoids relying on the Nixpacks package snapshot for patch availability. Do not override this with a start command pointing at an older system Node binary. Rebuild/redeploy to apply the runtime upgrade.

Use `npm run build` as the build command and `npm start` as the start command. Do not set `PORT`; Sevalla supplies it to the web process.

## API

`GET /api/jobs?start=YYYY-MM-DD&end=YYYY-MM-DD&zip=90505&page=1&pageSize=25`

`GET /api/jobs/:jobId` returns the individual ServiceTitan job response, image-attachment metadata, the service title, a redacted summary, the service address, and a chronological feed merged from the official job-history and job-notes endpoints. The details screen uses the title, summary, and address to prepare an SEO-description prompt. Job history remains visible only as editorial reference. File events, duplicate notes, undersized notes, and obvious contact details are removed. ServiceTitan's separate admin tabs for calls, email, and chat do not have a single documented job-history API equivalent and are not scraped.

`GET /api/jobs/:jobId/images/:attachmentId` securely proxies a verified image belonging to that job.

ServiceTitan may return a 302 handoff to a signed Azure Blob URL instead of image
bytes. The image proxy accepts that handoff only to HTTPS Azure Blob storage,
downloads without ServiceTitan credentials, validates public DNS at connection
time, and rejects further redirects. Downloads retain the 15 MB limit and a
90-second timeout. Generic binary responses use image byte signatures to select
the MIME type; unrecognized content is rejected. Signed URLs stay server-side
and are omitted from download errors. Automatic redirects remain disabled for
authenticated ServiceTitan API calls.

`POST /api/jobs/:jobId/ai-copy` reloads the job from ServiceTitan and uses the
server-side OpenAI configuration to return a validated title, excerpt, and
structured project-story body. The body contains an introduction, two tailored
sections, two to four scope bullets, and a closing. It does not accept prompt
text from the browser and does not publish or modify WordPress content.

`GET /api/jobs/:jobId/wordpress` refreshes the correlated WordPress post status.
The status includes the featured image's originating ServiceTitan attachment ID for new uploads and its WordPress filename as a fallback for older posts, allowing the details screen to preselect the current image.

`POST /api/wordpress/statuses` accepts up to 50 unique `jobIds` and refreshes
their correlated post statuses in one WordPress request.

`POST /api/jobs/:jobId/wordpress` accepts exactly one image ID, a `draft` or
`publish` status, and strict labeled plain-text AI copy. The copy includes
`TITLE`, `EXCERPT`, `INTRO`, `CONTEXT HEADING`, `CONTEXT`, `WORK HEADING`, two
to four `WORK ITEMS`, and `CLOSING` fields. The server safely converts those
fields into Gutenberg blocks; raw AI HTML is never accepted. It rechecks the
job and attachment in ServiceTitan, uploads the image to WordPress, and sets it
as the featured image. Shortcode job cards use the excerpt, while the job page
uses the generated project story.

`POST /api/jobs/:jobId/wordpress/status` accepts `{"status":"draft"}` or
`{"status":"publish"}` and updates the correlated WordPress post. The original
`PATCH /api/jobs/:jobId/wordpress` route remains available for compatibility.

`POST /api/jobs/:jobId/wordpress/regenerate` accepts optional `force`,
`attachmentId`, and `aiCopy` fields. Complete AI copy replaces the title,
excerpt, and project-story body. Title-and-excerpt-only copy is accepted for a
post already on the current generator and preserves its existing body. An old
or unversioned post requires complete AI copy before it can be upgraded to the
current generator version. Supplying an attachment replaces the featured
image; otherwise the existing featured image is preserved. A manually edited
post returns HTTP 409 unless `force` is true.

The dates are inclusive calendar dates and filter on a job's first appointment. The optional `zip` filter accepts a five-digit ZIP code or ZIP+4. Because the Jobs endpoint ignores a direct ZIP parameter, the app resolves matching locations and scans date- and status-filtered Jobs pages in batches of 500. It stops after finding the requested ZIP results plus one look-ahead job, then paginates those matches. ZIP searches omit an exact `totalCount` to avoid scanning all jobs; the page control reveals the next page when another match exists. Location IDs are cached in process memory for up to 24 hours (at most 50 ZIPs, and only when a ZIP has 500 or fewer locations). No job result lists are cached. A restart clears the location cache. Ranges are capped at 366 days, app page size at 50, and ZIP scans at 10,000 source jobs per request. Deep pages may require re-scanning earlier Jobs pages.

### Job tokens

Hosted accounts display their available job tokens in the workspace header. Generating copy costs one token. Build costs one token for the combined copy generation and draft creation. Update costs one token for fresh copy generation and updating the existing post. Publishing a draft, changing post status, and reading data are free. The active workspace shares one balance across its team and websites. Client-supplied balances, costs, and user IDs do not control spending. Local development mode is unmetered.

Apply all migrations, including `005_token_ledger.sql`, and the runtime-role grants in [the ledger setup guide](docs/token-ledger.md) before starting the updated server. New workspaces start with zero tokens. Platform administrators allocate or correct tokens through **Token admin**, which records an audited ledger transaction; direct balance updates are rejected. When `ENABLE_TEST_TOKENS=true`, workspace owners can also add one free token at a time on Add Tokens; disable this setting before paid use.

Paid provider operations hold a database row lock for the account. On provider success, the server decrements the balance and records an audit entry in the same transaction, committing before returning success. Provider failures roll back without a charge, and concurrent requests cannot overspend. Do not configure a database idle-in-transaction timeout shorter than the provider request duration. External provider changes cannot be atomically committed with PostgreSQL: a server/database failure after provider success but before commit requires administrative reconciliation; automatic refunds or retries cannot establish whether the external change occurred.

### Super-admin login and setup

A super admin (platform administrator) uses the same Google sign-in as every other
user. There is no separate admin login or password. Workspace owners and workspace
admins do not automatically receive platform-admin access.

1. Apply migration `005_token_ledger.sql` and the database grants in
   [the ledger setup guide](docs/token-ledger.md). Run the app in SaaS mode
   (`APP_MODE=saas`) and sign in with the intended administrator's Google account
   to create its user record.
2. Open the PostgreSQL console for the **same database the app uses**, using the
   database-owner connection. Replace the email below with the Google account's
   email and run:

   ```sql
   SELECT id, email, name
   FROM users
   WHERE lower(email) = lower('your-google-email@example.com');
   ```

   The value in the **`id` column** is the `USER_UUID`. Verify the email and name
   before copying it. If no row appears, confirm that you have signed in using
   SaaS mode and are querying the correct database.
3. Replace `USER_UUID` with that exact ID and grant access:

   ```sql
   INSERT INTO platform_administrators(user_id)
   VALUES ('USER_UUID')
   ON CONFLICT DO NOTHING;
   ```

4. Refresh the app. The **Token admin** link appears and opens `/admin/tokens`,
   where platform administrators can view account transaction history and post
   token adjustments with a required reason.

Platform administrators also see **Account members** at `/admin/members`. It lists
users and their roles in each workspace. Disabling a user blocks sign-in and
invalidates all existing sessions; the action is recorded in the audit log.
Platform administrator accounts cannot be disabled from this page. Disabling a
workspace owner also makes that owner's workspace unavailable to its members.

To revoke access, run this using the database-owner connection:

```sql
DELETE FROM platform_administrators
WHERE user_id = 'USER_UUID';
```

The application runtime database role has read-only access to administrator
assignments. The admin APIs check privileges on every request.

### Local app with a remote development database

Use the ignored `.env.remote` profile (see `.env.remote.example`) to keep remote test credentials separate from `.env`. Configure a dedicated remote PostgreSQL database, a restricted runtime login, the migration owner's direct connection, and development Google OAuth credentials. Both database URLs must include `sslmode=verify-full`.

```sh
npm run db:migrate:remote
# Apply runtime-role grants from docs/development.md after the migration.
npm run db:check:remote
npm run dev:remote
```

Open `http://localhost:3000`. This runs the account and token workflow locally against the remote database. Normal `npm run dev` retains the existing local configuration. Full setup steps, TLS, role grants, and OAuth callback details are in [the development guide](docs/development.md).

Useful Links:

https://app.sevalla.com/app/servicetitanwpjobsplugin-4unqy/overview?idCompany=1d7d19f0-7059-4d39-8105-0c19df98e7a4

https://servicetitanwpjobsplugin-4unqy.sevalla.app/

https://console.cloud.google.com/auth/clients?tutorial=iam--quickstart&project=servicetitan-wp-jobs-plugin

https://dashboard.stripe.com/acct_1PoRFT2MaKtF7IaH/account/status/tasks/astask_1QNmZ32MaKtF7IaH1E9EhkqF

https://platform.openai.com/api-keys

Docs:

https://developer.servicetitan.io/docs/apis/tenant-salestech-v2/endpoints

Reference:

https://callwiseway.com/recent-project/garbage-disposal-replacement-in-hermosa-beach/


### One-click build and deploy

On the job list, **Build** queues a job that has no WordPress post. The server fetches its details, selects the first downloadable image in attachment order, generates and validates complete copy, and pushes a **draft**. Closing the browser or signing out does not cancel an accepted task. Queued/running state and any failure are shown when the list is opened again. Existing posts use the Details/Update workflow.

The action costs one token for the combined copy generation and WordPress draft creation. Missing images fail before the paid operation. The button submits immediately without a confirmation dialog.

SaaS deployments must run migrations through `011_token_spend_reservations.sql` before starting this version. For a separate runtime role, also grant `SELECT, INSERT, UPDATE` on `build_deploy_tasks` and `token_spend_operations` (substitute your actual role):

```sql
GRANT SELECT, INSERT, UPDATE ON build_deploy_tasks TO st_jobs_app;
GRANT SELECT, INSERT, UPDATE ON token_spend_operations TO st_jobs_app;
```

The queue is an internal server control table; its HTTP routes authorize the website/workspace before enqueueing or reading status. Workers recheck the requesting user's current workspace access and use current integration credentials. PostgreSQL coordinates claims and active-job deduplication across app instances. Each instance processes one task at a time. Local mode uses `.data/build-deploy.json`; override with `BUILD_QUEUE_FILE` and run only one local process per file.

Queued tasks survive server restarts. If a running task loses its worker heartbeat for five minutes, it is marked failed for manual review instead of automatically repeating external writes or token charges. Check WordPress before retrying an interrupted operation. Queue records currently remain until an operator removes them; back up the database/local queue file as appropriate. Graceful shutdown allows up to two minutes for the active operation to finish.

### Superadmin ServiceTitan API health

Superadmins can open **API Health** from the Administration menu (`/admin/api-health`). Select a ServiceTitan connection in the current workspace and click **Check APIs**. The protected POST endpoint `/api/admin/service-titan/:connectionId/health` verifies the authenticated actor's platform administrator role, CSRF token, workspace access, and a one-minute per-actor/connection rate limit.

The page covers the ServiceTitan endpoints used by this app: authentication, jobs, locations, job types, tag types, installed equipment, job details, history, notes, and attachments. It reports availability, HTTP status when available, response time, and the check timestamp. Job-specific checks use one sample job; without one they display **Not checked**. Original attachment downloads are explicitly not checked to avoid transferring large files. Checks are manual, read-only apart from obtaining an OAuth token, and return no provider records or credentials. This is a connection access diagnostic, not a global ServiceTitan uptime monitor or a full API catalog.

Settings → ServiceTitan → **Test Connection** and onboarding use the same endpoint probes. The result lists each API's availability. The connection is marked validated only when all required probes succeed; if no sample job is available, job-specific probes remain unverified and validation stays incomplete. Original attachment downloads remain excluded from this check.

### Optional work-content enrichment

Job Details, copy generation, regeneration, and queued builds now use populated ServiceTitan `summaryOfWork`, job-linked invoice summaries/service descriptions, and supported completed form answers. Job Details shows the additional sources before publishing. Invoice billing scope is distinguished from evidence of completed actions; raw financial/customer objects are excluded, and source text is sanitized and bounded. SEO generator version 13 identifies the new generation rules; existing WordPress posts are not rewritten automatically.

Enrichment is optional: missing access, empty results, and provider failures preserve existing job sources. The superadmin API Health page includes **Invoices**, **Forms definitions**, **Form submissions**, and a **Summary of Work** field check. These are marked optional and do not change Settings' required API validation.

Cost bounds: full invoice enrichment is fetched only on details/generation/build, up to five pages of 20; per-job results are cached five minutes (100 jobs per provider). Completed forms are indexed in a shared workspace/integration/credential-scoped cache for five minutes, limited to three pages of 50 submissions in a 30-day window and ten cached integrations. Only explicit Job owners, completed submissions, and named Text/Checkbox answers are used; the latest sampled completed submission per form/job wins. Form coverage is explicitly partial, and older submissions may be absent. Attachments, OCR, and photos are excluded from form enrichment. Optional enrichment contributes at most 12,000 text characters to a prompt.

The jobs list prefers a sanitized invoice-summary excerpt, then Summary of Work, job summary, and finally job type. Canonical invoice IDs from the jobs response are fetched in one optional batch per page (up to 50), with strict invoice/job association checks and a five-minute preview cache. No forms or full per-job enrichment runs for list labels. Missing invoice IDs, denied access, and empty summaries preserve the existing fallback labels. Long excerpts wrap within the Job column; the original job-type label remains underneath.

### Job Scanner

Open **Job Scanner** (`/job-scanner`) in the workspace navigation. Starting a scan authorizes **1 token for scanning plus 1 token per draft build**, up to six total. Completed jobs are traversed newest-first by ServiceTitan creation date; the API does not support the completion-date sort we tested. Jobs already present in WordPress or whose status cannot be verified are skipped. Jobs need image metadata and at least 120 characters of source narrative before AI rating. The AI scores factual local-service content readiness (0–100), rather than promising search rankings.

The scanner stops at ten candidates scoring at least 70, source exhaustion, or safety limits (500 jobs, 40 ratings, about ten minutes before draft creation). It ranks the qualified candidates and sends up to five to the existing durable build queue. Each build rechecks current membership/credentials and existing WordPress posts, verifies an image, generates copy, and writes only a draft. Review the results and use **Publish draft** explicitly; publishing remains free. If the balance is insufficient or a provider fails, fewer drafts may be produced. The page shows per-draft failures; uncertain WordPress outcomes still follow the existing charged-reservation/manual-reconciliation rules.

SaaS requires migration `013_job_scanner.sql` **before deploying this server**. Apply it with the migration-owner connection. If using a separate runtime role, grant (substitute the actual role):

```sql
GRANT SELECT, INSERT, UPDATE ON job_scanner_tasks TO st_jobs_app;
```

Scanner tasks and ratings survive restarts. Active scans are deduplicated per workspace/website; request IDs and token reservations prevent repeat scan charges. A lost worker heartbeat marks the interrupted scan failed for manual review, instead of repeating work or writes. Queued builds can continue even if a scan is interrupted after enqueueing; check the displayed jobs/WordPress before retrying. Scoring failures before draft enqueueing are refunded; a completed scan with zero candidates still costs one scan token. The scanner uses one worker per process and checks its queue every 30 seconds while idle. The page polls only while work is active and pauses network polling in hidden tabs. Local mode stores scans in `.data/job-scanner.json` and must use a single process per file, as with local builds; local mode does not charge app tokens.

Full source records are not stored in scanner task payloads: only IDs, bounded titles, ratings/reasons, progress and build references. Existing enrichment cache and source limits apply. Scan history currently remains until operator cleanup; preserve ledger and idempotency history when setting retention policies.
