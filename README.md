# ServiceTitan Jobs

The SaaS account foundation is now available: Google sign-in, PostgreSQL-backed
accounts and sessions, encrypted integration credentials, multiple websites, and
ownership-protected job workflows. See [development and deployment setup](docs/development.md).
The instructions below describe the existing local single-user workflow; hosted
production now requires SaaS configuration and will not run in local mode.

A React and Express application that queries completed ServiceTitan jobs with image attachments by first appointment date, resolves each job type name and location, and safely creates correlated WordPress custom posts with selected job images.

The user-facing setup documentation is available in the running app at
`/wordpress-integration`.

## Local development

Requires Node.js 22 or newer.

1. Copy `.env.example` to `.env` and enter credentials from the same ServiceTitan environment.
2. Ensure the ServiceTitan app has read access to **Jobs**, **Job Types**, and **Locations**.
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
user chooses **Push** or **Rebuild**. The prompt permits city, state, and ZIP in
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
package it as `dist/downloads/servicetitan-job-integration-1.18.0.zip`. The app serves
that archive at `/downloads/servicetitan-job-integration-1.18.0.zip` (with the
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
published jobs with pagination. ZIP filtering is fixed by the shortcode and no
visitor-facing ZIP controls are rendered. Configure it with
`zipcodes="07001,07002"`, `offset="1"`, `limit="10"`, and `page_size="2"`.
`posts_per_page` remains available as a backward-compatible alias when
`page_size` is omitted. Each shortcode card contains only the job's featured
image, linked title, and excerpt. On a single job page, the plugin appends the
approximate ZIP-based map and a **Project Area** link to any published city page
that shares the job's ZIP taxonomy term through the configured ACF field. The
same metadata row displays the ServiceTitan completion date when available.

### ServiceTitan ↔ WordPress correlation

Every ServiceTitan job maps to the deterministic WordPress slug:

```text
servicetitan-job-{SERVICE_TITAN_JOB_ID}
```

The refresh action performs an authenticated lookup by that slug across all WordPress post statuses. A row starts as **Unknown**, so Push is disabled. A successful lookup that finds no post changes the status to **None** and enables Push. If a post exists—or the lookup fails and remains unknown—Push stays disabled. The server repeats the lookup immediately before POSTing and returns HTTP 409 if the post already exists.

**Refresh page statuses** sends the visible page's ServiceTitan IDs in one app
request. Companion plugin 1.4.0 resolves all corresponding WordPress slugs with
one `WP_Query` and returns found and missing statuses together.

## Build and run

```sh
npm run build
npm start
```

The build emits the React application to `dist/client` and the Node server to `dist/server`. The production server serves both the API and client on the `PORT` environment variable.

## Sevalla / Kinsta deployment

The [deployment workflow](.github/workflows/deploy.yml) uses `SEVALLA_TOKEN` to trigger a Sevalla app deployment. That token only authorizes the Sevalla API request; it does not create PostgreSQL roles, run migrations, or change database permissions. Apply migrations before deploying. The app accepts either a restricted non-owner PostgreSQL login or the owner of both token tables as `DATABASE_URL`; see [database setup](docs/development.md#database-setup).

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

The dates are inclusive calendar dates and filter on a job's first appointment. The optional `zip` filter accepts a five-digit ZIP code or ZIP+4 and resolves matching ServiceTitan locations before building the filtered jobs page. The ServiceTitan list request applies `jobStatus=Completed`, then checks attachment metadata and retains only jobs with supported images. Attachment lookups use bounded concurrency and a short-lived cache. Ranges are capped at 366 days, and page size is capped at 50.

### Job tokens

Hosted accounts display their available job tokens in the workspace header. Each successful WordPress push, rebuild, or AI copy generation costs one token; status changes and reads are free. The active workspace shares one balance across its team and websites. Client-supplied balances, costs, and user IDs do not control spending. Local development mode is unmetered.

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

On the job list, **Build & deploy** queues a job that has no WordPress post. The server fetches its details, selects the first downloadable image in attachment order, generates and validates complete copy, and pushes a **draft**. Closing the browser or signing out does not cancel an accepted task. Queued/running state and any failure are shown when the list is opened again. Existing posts use the existing Details/Rebuild workflow.

The action uses the existing token rules: one token for successful copy generation and one for a successful WordPress push. If the push fails after generation, the generation token remains spent; retrying generates new copy. Missing images fail before generation. The button submits immediately without a confirmation dialog.

SaaS deployments must run migration `006_build_deploy_queue.sql` before starting this version. For a separate runtime role, also grant `SELECT, INSERT, UPDATE` on `build_deploy_tasks` (substitute your actual role):

```sql
GRANT SELECT, INSERT, UPDATE ON build_deploy_tasks TO st_jobs_app;
```

The queue is an internal server control table; its HTTP routes authorize the website/workspace before enqueueing or reading status. Workers recheck the requesting user's current workspace access and use current integration credentials. PostgreSQL coordinates claims and active-job deduplication across app instances. Each instance processes one task at a time. Local mode uses `.data/build-deploy.json`; override with `BUILD_QUEUE_FILE` and run only one local process per file.

Queued tasks survive server restarts. If a running task loses its worker heartbeat for five minutes, it is marked failed for manual review instead of automatically repeating external writes or token charges. Check WordPress before retrying an interrupted operation. Queue records currently remain until an operator removes them; back up the database/local queue file as appropriate. Graceful shutdown allows up to two minutes for the active operation to finish.
