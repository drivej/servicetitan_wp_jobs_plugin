# SaaS architecture assessment and migration proposal

Assessment date: 2026-10-01. Status: proposal for owner review; migration has not started.

Implementation follow-up: the owner approved development on 2026-10-01. Phase 1
implementation and setup are tracked in `docs/development.md`. The assessment
below preserves the original findings and proposal, rather than implying that
all later phases or unresolved billing policies have already been implemented.

Repository follow-up (2026-10-01): the owner selected `https://github.com/drivej/servicetitan_wp_jobs_plugin`. The workspace now tracks `origin/main`, based on remote commit `17caff49303102feab2d27cb65ae110b3fe16d17`, which contains only `.gitignore`. Remote ignore rules were merged with local exclusions, preserving `.env.*` protection and the `.env.example` exception. Existing application files remain local and uncommitted; nothing was pushed. References below to missing Git metadata describe the initial assessment state. Architecture approval remains pending.

## Recommendation

Keep the React/Vite frontend, Express API, existing ServiceTitan adapter, structured copy format, and WordPress presentation features. Add PostgreSQL, Google sign-in, durable processing, account ownership, and billing incrementally. Run the same modular application as a web process and a background worker. Adapt the existing plugin into a pull connector without changing existing post URLs or discarding its taxonomy, ACF, media, and editorial protections.

The current application is a useful single-operator publishing tool, not yet a secure multi-user service. ServiceTitan and AI already run outside WordPress; this substantially reduces the migration scope.

## Inspection and verification

- Inspected the handoff, source structure, server integrations and routes, client workflows, shared copy format, PHP plugin, configuration, packaging, and existing test coverage.
- `npm test`: **47/47 passed**. The initial sandboxed run passed 44 and failed three HTTP tests because loopback listening was prohibited; the approved unrestricted rerun passed all 47.
- `npm run typecheck`: passed.
- `npm run build`: passed, producing frontend/server bundles and the plugin ZIP.
- `php -l wordpress-plugin/servicetitan-job-integration/servicetitan-job-integration.php`: passed on PHP 8.5.2. This does not establish compatibility with the declared minimum PHP 7.4.
- Node used: 22.22.0. No live ServiceTitan generation or WordPress publishing was performed. Tests use substitutes for external services; this was not an end-to-end WordPress runtime test or dependency vulnerability audit.
- No application source or infrastructure was changed. This report was added and generated `dist` build artifacts were rebuilt.
- This directory is **not a Git working tree**. No `.git` history, remote, branch, CI configuration, or deployment manifest was available. No applicable `AGENTS.md` was found in the checked project/ancestor locations. Historical secret exposure cannot be assessed without repository history.

## 1. Current architecture

```text
React browser UI
   └─ Express API: one configured ServiceTitan tenant + one WordPress site
        ├─ ServiceTitan OAuth/API → jobs, locations, notes, images
        ├─ OpenAI Responses API → editable structured copy
        ├─ Zippopotam.us → ZIP location enrichment
        └─ WordPress REST API → posts, media, taxonomy, generator metadata

WordPress plugin → CPT, ACF/ZIP relationships, shortcode, maps, project-area links
```

| Location | Responsibility |
|---|---|
| `src/client/main.tsx` | React entry; pathname-based selection of list, details, plugin setup, integration guide |
| `src/client/App.tsx`, `JobDetails.tsx` | Job browsing, cached WP status, manual generation/review, push/rebuild/status changes |
| `src/server/index.ts` | Loads environment, constructs singleton clients, serves Express on `0.0.0.0`; Vite middleware in development; graceful shutdown |
| `src/server/app.ts` | Route validation, orchestration, image proxy, ZIP downloads, error mapping |
| `src/server/service-titan.ts` | Token management, discovery, enrichment, notes/history and attachment retrieval |
| `src/server/openai.ts`, `src/shared/job-copy.ts` | AI request/schema, prompt and copy serialization |
| `src/server/wordpress.ts` | Push integration, correlation, media upload, regeneration, location synchronization |
| `src/server/job-seo.ts`, `zip-lookup.ts` | Controlled fallback SEO categories and ZIP enrichment |
| `wordpress-plugin/servicetitan-job-integration/` | One PHP implementation, CSS, release readme; plugin version 1.18.0 |
| `scripts/` | esbuild server bundling and independently installable plugin ZIP packaging |

Languages: TypeScript/TSX, PHP, CSS, JavaScript build scripts. Declared packages include React 19, Express 5, Axios 0.29, dotenv 17, Vite 8, TypeScript 7, esbuild, tsx, and archiver. `js-cookie` is declared but has no source usage. There is no database driver, ORM, session/authentication framework, Stripe integration, scheduler, or durable queue.

`npm run build` cleans `dist`, typechecks, builds the client with Vite, bundles the server with esbuild, and packages the plugin. `npm start` runs `dist/server/index.js`. Production requires `NODE_ENV=production`; otherwise the server imports Vite. Express, Vite, and dotenv are external to the server bundle. Hosting must retain required runtime dependencies and build dependencies during the build. Development rebuilds server code at startup; it does not provide server watch/reload.

## 2. ServiceTitan behavior

Authentication uses OAuth client credentials, an in-memory access token refreshed 30 seconds before expiry, and a shared in-flight token promise. Requests include `Authorization: Bearer …` and `ST-App-Key`. Integration and production hosts are selected through `ST_ENVIRONMENT`; server-only API/auth URL overrides exist. There is no automatic 401 refresh/replay or 429/backoff policy.

Endpoints in the implementation, relative to the configured API host:

| Method/path | Purpose |
|---|---|
| POST configured `/connect/token` auth URL | Client-credentials token |
| GET `/jpm/v2/tenant/{tenant}/jobs` | Completed jobs filtered by first appointment |
| GET `/jpm/v2/tenant/{tenant}/jobs/{id}` | Full job details |
| GET `/jpm/v2/tenant/{tenant}/jobs/{id}/history` | Timeline |
| GET `/jpm/v2/tenant/{tenant}/jobs/{id}/notes` | Paginated notes |
| GET `/jpm/v2/tenant/{tenant}/job-types` | Job-type names by IDs |
| GET `/crm/v2/tenant/{tenant}/locations` | ZIP lookup and address enrichment |
| GET `/equipmentsystems/v2/tenant/{tenant}/installed-equipment` | Equipment names |
| GET `/forms/v2/tenant/{tenant}/jobs/{id}/attachments` | Attachment metadata |
| GET `/forms/v2/tenant/{tenant}/jobs/attachment/{attachmentId}` | Verified attachment bytes |

The list route accepts inclusive calendar dates, converts them to UTC start/exclusive-end timestamps, limits a range to 366 days and page size to 50. It requests `jobStatus=Completed` and filters on **first appointment**, not completion date. Optional ZIP/ZIP+4 filtering first paginates matching locations. Jobs are scanned from source page 1 on every browser page request, in batches of 50, until enough jobs with supported image metadata are found. Attachment checks have concurrency 8 and a five-minute promise cache. Notes paginate with a 100-page limit. Attachments accept several response shapes but do not follow `hasMore`; ID enrichment also reads one page only.

Details combine the raw job response, enriched summary, supported attachments, and chronological deduplicated history/notes. File events and low-value notes are filtered; regexes remove some emails, phones, and URLs. History is editorial reference and is not sent in the AI prompt. Summary enrichment includes full service address and up to five equipment names.

Image retrieval verifies the attachment belongs to the job and uses the fixed provider endpoint, not an arbitrary attachment URL. Images are limited to 15 MB **after downloading**. Requests use a 20-second default timeout and 90 seconds for image downloads.

There is no scheduled sync, persistent cursor, source revision, update detection, or durable job state. Explicit browser actions reload source data. WordPress slugs and metadata preserve the numeric ST job ID; location/job-type/equipment IDs otherwise remain transient. Current correlation omits connection/environment/tenant identity.

## 3. AI behavior

The server calls OpenAI `/responses` using native fetch, the configured `OPENAI_MODEL` (source default `gpt-6-luna`), `store:false`, a 1,600 output-token cap, and a 30-second timeout. Source code conditionally requests no reasoning for model identifiers matching its GPT-6 pattern; this assessment verifies code behavior, not live model availability.

`JOB_COPY_INSTRUCTIONS` is embedded in `src/shared/job-copy.ts`. Facts contain service title, partially redacted summary, full service address when present, and equipment names. Instructions prohibit public street addresses, personal names, contact details, prices, invented work, and unsupported outcomes. They treat source facts as untrusted input. A strict JSON schema requires title, excerpt, introduction, context heading/paragraph, work heading, 2–4 scope bullets, and closing. Runtime validation enforces lengths and rejects HTML.

The route reloads trusted ST data instead of accepting a browser prompt. Generated copy is returned to the editor for human review; publication is a separate action. Users can also copy a prompt and paste manually obtained content. Approved plain text is parsed and HTML-escaped into Gutenberg blocks.

Refusals, invalid JSON, incomplete output, timeout, authentication, rate-limit and provider failures receive mapped errors. No automatic retry, persistent generation identity, model response ID, prompt version, input/output token totals, cost estimate, or accepted-copy history is stored. Clicking Generate again invokes another request. Provider usage fields are ignored.

## 4. WordPress behavior and persistence

The plugin declares WordPress 6.5+, PHP 7.4+, and an ACF dependency. It registers `st_job` if missing, with REST base `st-jobs`, `/jobs` routes, title/editor/excerpt/thumbnail/revision support. A filter adapts existing CPT registration, including mapping creation to its edit capability. This is a deliberate capability change that deserves review for sites with custom roles.

Node authenticates with a WordPress Application Password via Basic auth over HTTPS, with local development exceptions. The plugin contains no ST or AI credentials and makes no ST/AI requests. There is no polling or WP-Cron pipeline today.

Custom REST namespace: `/wp-json/servicetitan-job-integration/v1`:

- GET `/status`: authenticated `read` capability; returns plugin version/post type.
- POST `/statuses`: `edit_posts` or `edit_st_jobs`; up to 50 IDs, one `WP_Query` across statuses, returns post status, copy, media correlation and SEO fingerprint status.
- GET/POST `/zipcodes`: same broad edit capability; reads terms or updates shared ACF field configuration and ZIP metadata.

Posts/media use standard `/wp-json/wp/v2/{restBase}` and `/wp-json/wp/v2/media`. Custom fields are `stji_zipcode`, edit-context `stji_location`, and `stji_generation`.

Create sequence: look up `servicetitan-job-{id}` → create post at requested draft/publish status → upload one image → set featured media. Rebuild preserves slug, URL and status, and preserves the image unless replacement is requested. Current-version title/excerpt edits preserve the body. Legacy/outdated content requires complete copy. Manually edited content requires `force`; newer generator content is refused. A SHA-256 fingerprint covers title, excerpt, and body; current generator version is 6.

Persistence today:

| Store | Data |
|---|---|
| WordPress posts/media/revisions | Generated or edited copy, publication status, slug, media, revision recovery |
| WordPress post meta | `_stji_job_id`, `_stji_seo_version`, `_stji_generated_hash`, `_stji_generated_at`, `_stji_completed_on`; attachment `_stji_source_attachment_id` |
| Taxonomy/term meta | `st_job_zipcode` relationships; `stji_zip_city`, `stji_zip_state`, latitude/longitude, ACF field references |
| WP options/ACF meta | `stji_zip_acf_field_name`, migration marker `stji_zip_relationships_migrated_1_12_0`, configured ACF values/references |
| Browser localStorage | WP statuses, titles/excerpts and media correlation, keyed only by job ID under one cache key; 24-hour TTL |
| Node memory | ST token, attachment requests/cache, ZIP lookups, push/rebuild promises, one-time ZIP sync promise |
| Local files | `.env`, generated bundles/ZIP; plugin download action writes to the server user's `~/Downloads` |

There is no application database. The plugin uses the site's existing WordPress database; no plugin-specific tables exist. ZIP relationships undergo a one-time unbatched migration during WordPress `init`. No WP transients are used. `[servicetitan_jobs]` renders published cards with fixed ZIP filters, offset, limit and pagination. Single posts add project-area links to matching city pages, completion date, and an approximate ZIP-based Google map.

## 5. Findings ranked for migration

| Priority | Finding and consequence | Evidence |
|---|---|---|
| Critical before public hosting | No API user authentication, authorization, rate limiting or ownership boundary. Anyone who can reach the server can read job details/images, incur AI calls, and invoke WP mutations with the server's credentials. Network exposure beyond this machine was not tested. | `src/server/app.ts:41`, `:94`, `:97`, `:132`; `index.ts` binds all interfaces |
| High | Duplicate protection is non-durable: separate processes can both pass lookup and create; crashes lose promise locks. Job-only slugs cannot distinguish connections/tenants, and changed slugs break correlation. | `src/server/wordpress.ts:63`, `:185`, `:358` |
| High | Post creation precedes media/featured-image completion. An upload failure can leave an already-published partial post, and retry sees an existing post instead of resuming. Rebuild failures can orphan uploaded media. | `src/server/wordpress.ts:194`, `:203`, `:233` |
| High | Privacy filtering is incomplete. The browser receives the raw job object; full address goes into the AI request. Prompt instructions are not a redaction boundary, and regexes do not remove all names/contact data. | `src/server/service-titan.ts:143`, `src/shared/job-copy.ts:46` |
| High | Plugin bulk-status query returns all statuses after a broad edit capability check, without per-post read/edit checks; lower-privilege users can receive other authors' private/draft titles and excerpts. ZIP writes also change shared configuration under broad edit permissions. | Plugin PHP `:527`, `:638`, `:692`, `:849` |
| Medium | List-row Rebuild sends only `force`. Legacy/outdated posts require complete AI copy and fail. Current posts preserve all copy but update location/generation metadata; this action does not regenerate AI text despite its wording. | `src/client/App.tsx:174`, `src/server/wordpress.ts:229` |
| Medium | Paginated attachment responses can omit later images; enrichment is single-page. List requests repeatedly rescan from page 1. Jobs/locations loops lack a page/work budget and caches lack size eviction. | `src/server/service-titan.ts:74`, `:213`, `:294` |
| Medium | Image size enforcement happens after full buffering, and response MIME is forwarded without byte validation. ZIP lookup has no timeout, so publish or compatibility checks can hang. | `src/server/service-titan.ts:162`, `src/server/zip-lookup.ts:41` |
| Medium | Plugin download button saves on the server, not the browser's machine. It becomes incorrect in hosted deployment and exposes repeatable disk writes. | `src/server/app.ts:70`, `src/client/WordPressPluginSetup.tsx:16` |
| Medium | Status cache has no user/site/connection namespace. A future account/site switch would reuse another context's copy/status unless redesigned and cleared on logout. | `src/client/wordpressStatusCache.ts:30` |
| Medium | Missing entries in a successful bulk-status response are interpreted as definitely missing, rather than unknown. Compatibility checks happen in the UI, not before every server mutation. | `src/server/wordpress.ts:131`, `src/server/app.ts:132` |
| Medium | Manual-edit protection is a read-then-write comparison: a WP edit between lookup and update can be overwritten. Concurrent pushes and rebuilds also use separate locks. | `src/server/wordpress.ts:219` |
| Medium | GET plugin status can write ZIP configuration/backfill through `ensureZipConfiguration`; startup UI reads have remote side effects. | `src/server/wordpress.ts:91` |
| Low | Default REST base is `st_job` while the bundled plugin exposes `st-jobs`; configured users avoid this but defaults fail. Client error fallback advertises SEO version 5 versus server 6. Versions are repeated across source/build files. | `src/server/config.ts`, `src/client/useWordPressPluginStatus.ts` |

Other gaps: no durable audit or billing history; no sync cursor or job provenance; no automated PHP integration/concurrency tests; local `.env` is readable according to its current file mode by other local users; `.gitignore` ignores `.env` but not every possible secret-bearing environment variant. Unexpected errors are logged as full objects, so future adapters must redact request credentials and PII. No claim of a discovered dependency CVE is made.

Positive controls to retain: explicit body/date/ID limits, server-reloaded source facts, attachment membership checks, TLS enforcement for WordPress, escaped Gutenberg text, unknown-status handling on request failures, human editorial review, revisions, source attachment correlation, and content-change fingerprints.

## 6. Sevalla inspection

Read-only inspection used the existing authenticated Chrome dashboard; no credentials were copied or revealed.

| Item | Observed result |
|---|---|
| Project | ServiceTitan WP Jobs Plugin |
| Project name | `servicetitan-wp-jobs-plugin-2jeso` |
| Project ID | `280afd51-329e-4257-b14e-3cddb33a4550` |
| Applications, databases, other services | Services screen explicitly says no services; Settings confirms no apps/databases to suspend |
| Deployment configuration / linked Git repository | No project application exists, so none is configured at application level |
| Application environment variables | None to inspect because no project application exists; company-wide configuration was not audited |
| CLI | Neither `sevalla` nor `kinsta` found on PATH; common Homebrew/local Sevalla executable paths absent |
| CLI authentication | Standard `~/.config/sevalla` credentials directory absent; no `SEVALLA_*` or `KINSTA_*` process variables; CLI authentication not configured in the checked locations |
| Dashboard authentication | Existing browser session is authenticated |

Dashboard: [project services](https://app.sevalla.com/project/servicetitan-wp-jobs-plugin-2jeso/services?idCompany=1d7d19f0-7059-4d39-8105-0c19df98e7a4). These statements apply to this project, not other company projects or Git-provider connections.

The [official CLI reference](https://github.com/sevalla-hosting/cli) documents `sevalla auth status`, device login, and the standard credential location. No CLI installation/login or infrastructure change was needed for this assessment.

Local `.env` variable names only: `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_ID`, `ST_APP_KEY`, `ST_TENANT_ID`, `ST_APP_GUID`, `ST_ENVIRONMENT`, `WORDPRESS_URL`, `WORDPRESS_APPLICATION_PASSWORD`, `WORDPRESS_USERNAME`, `WORDPRESS_POST_TYPE_REST_BASE`, `WORDPRESS_POST_STATUS`, `OPENAI_API_KEY`, `OPENAI_MODEL`. `ST_APP_ID` and `ST_APP_GUID` are not consumed by current configuration loading. Values were not included in tool output or this report.

## 7. Reuse decisions

| Classification | Components | Reason |
|---|---|---|
| REUSE AS-IS initially | Pure date/search helpers, plain-text serialization, escaping/Gutenberg rendering, shortcode/card CSS, project-area/map display | Useful behavior independent of account architecture; retain regression coverage |
| ADAPT | ServiceTitan adapter, WordPress adapter, React jobs/editor UI, plugin capabilities/status APIs, attachment and ZIP handling | Add explicit user/connection/site context, bounded work, safe retry and authorization |
| MOVE TO SAAS | Integration configuration, scheduling, job state, prompts/generations, audit, cost and usage tracking | Central ownership and durable provenance; ST/AI execution already lives in Node |
| REPLACE | Process-local operation locks, slug-only identity, global browser cache, singleton tenant/site configuration, synchronous orchestration | Cannot provide durable multi-user correctness |
| REMOVE after replacement | Server Downloads write route, unused `js-cookie`, stale guide claims, duplicate release-version constants; WP Application Password dependency after pull cutover | Hosted UX and connector no longer need these paths; retain push adapter during migration |

## 8. Proposed target architecture

One TypeScript codebase, React/Vite plus Express, PostgreSQL, and separate web/worker entry points. No framework rewrite, organizations, Redis, or microservice fleet required for v1. Proposed deployment: web process + background worker + managed PostgreSQL in the same region, private database connectivity, backup/restore verification, and an explicit migration release step. Resource sizes/region/cost remain owner choices.

```text
Google → authenticated React/Express → owned websites/connections/settings
                                      ↓
                       PostgreSQL state + durable work queue
                                      ↓
                    sync → sanitized revision → generation → approval
                                                               ↓
WP connector → claim pending publication → apply locally → acknowledge
                                                               ↓
                       publication history + usage ledger

Stripe signed webhook → durable event inbox → subscription/invoice history
```

Proposed structure keeps current paths and extracts modules incrementally:

```text
src/client/                       existing UI + account/site/billing screens
src/server/index.ts               web entry
src/server/worker.ts              worker entry
src/server/modules/               auth, websites, connections, jobs, content,
                                  publications, billing, usage, audit
src/server/integrations/           adapted ServiceTitan/OpenAI/WP/ZIP clients
src/server/db/                     repositories, transactions, migrations
src/shared/                       validated DTOs and content format
wordpress-plugin/                 existing plugin + pairing/polling/receipts
tests/integration/                PostgreSQL ownership/concurrency/retry tests
```

Google-only sign-in: authorization-code flow with state, nonce and PKCE using a maintained OIDC implementation; verify token signature, issuer, audience and expiry. Bind identity by Google subject, not email; retain email/name/avatar as profile attributes. Store an opaque session server-side and use Secure, HttpOnly, SameSite cookies, session rotation, logout revocation and CSRF protection for browser mutations. Google's [OIDC reference](https://developers.google.com/identity/openid-connect/reference) explicitly identifies `sub` as stable identity and documents the token claims to validate.

Every service/repository call receives an authenticated user context. Website IDs and connection IDs from clients are selectors, never proof of ownership. Composite foreign keys enforce same-user relationships. Use PostgreSQL row-level security as defense in depth with a non-owner runtime role and transaction-local identity; background tasks must establish their own user context. Platform catalogs and verified Stripe ingress have explicitly separated access paths.

Store encrypted ST credentials with authenticated encryption and key versioning; keep encryption keys outside the database in hosting secret configuration. Cache access tokens per connection, with bounded lifetime/size. Use fixed ST hosts; do not turn environment URL overrides into arbitrary user-controlled network destinations. Apply network/redirect protections to future site verification and media retrieval. Logs and audit payloads must redact secrets and unnecessary PII.

## 9. Proposed PostgreSQL schema

This is a logical design, not permission to create tables. Use UUID internal keys, `timestamptz`, integer minor currency units, explicit currency, and provider identifiers as text. All owned records carry `user_id`; financial/history records should not disappear via cascading deletion. Settings JSON is appropriate for non-relational options, not ownership or billing invariants.

| Table/domain | Main fields and constraints |
|---|---|
| `users` | id, unique google_subject, email, name, avatar_url, created/updated/last_login_at, disabled_at |
| `sessions` | hashed unique session token, user_id, expires_at, revoked_at; no browser-readable bearer identity |
| `servicetitan_connections` | id, user_id, environment, tenant_id, encrypted credential envelope/key_version, status, settings; unique `(user_id, environment, tenant_id)`; credential rotation updates this connection rather than making a duplicate |
| `websites` | id, user_id, connection_id, name, canonical_url, status, timezone/settings, plugin_version, last_seen_at; composite FK `(user_id, connection_id)`; one selected connection per site in v1, many sites per connection |
| `website_credentials` / `website_pairings` | site-scoped credential hash, scopes, created/revoked_at; separate short-lived, single-use pairing code hash and expiry |
| `sync_runs` / `sync_cursors` | connection, cursor/window, status, attempts, start/finish/error; advance cursor only after discovered work is durably recorded |
| `servicetitan_jobs` | user_id, connection_id, provider_job_id, status/eligibility, first_seen/last_seen; unique `(connection_id, provider_job_id)` |
| `job_revisions` | job_id, sanitized generation facts, selected-source hash, source modified time when available, observed_at; unique `(job_id, source_hash)`; no raw customer/job dump |
| `prompt_templates` / `prompt_versions` | template key, immutable version, instructions, JSON schema, hash, created_at; version also identifies facts-normalization policy |
| `generation_requests` | user/site/revision/prompt/model/config hash, logical operation key, state, accepted_generation_id; unique logical key; explicit regenerate creates a new request |
| `content_generations` | one provider attempt: request_id, attempt number, provider response ID, model, input/output/cached token counts when returned, usage availability, estimated_cost, rate snapshot/version, timing, outcome/error, generated structured copy; unique `(request_id, attempt_number)` |
| `publication_targets` | user/site/job, WordPress post ID, existing slug/URL, last acknowledged revision/hash; unique `(website_id, job_id)` and non-null `(website_id, wordpress_post_id)` |
| `publications` | immutable operation ID, target, accepted generation or manual-content revision, exact approved payload/hash, attachment identity, desired status, expected remote hash, state, lease/fencing token, retry info, acknowledged_at; unique `(target_id, operation_key)` |
| `publication_attempts` | publication_id, attempt, delivered/acknowledged timing, bounded error details, receipt; preserve failures separately from operation state |
| `plans` / `plan_prices` | plan identity separate from immutable version: currency, amount_minor, monthly_job_limit, max_websites, unique Stripe price ID, offered_from/retired_at; retirement affects new sales, not existing entitlement |
| `billing_customers` / `subscriptions` | user-to-Stripe-customer mapping; unique Stripe subscription ID, current status projection and lifecycle timestamps; current state is not historical entitlement |
| `subscription_entitlements` | subscription, plan_price_id, effective_from/to, event source; non-overlapping effective intervals; keep past versions when changing plans |
| `billing_periods` | user/subscription, start/end, entitlement reference/snapshot, agreed limit; unique period identity and valid ordered timestamps; no calendar-month approximation |
| `invoices` / `invoice_lines` | unique Stripe invoice/line IDs, subscription, amounts/currency/status, line-specific price/period/proration information |
| `payments` / `invoice_payments` | provider payment identity/status and amounts; distinct invoice-payment allocation record with unique Stripe InvoicePayment ID; do not assume one payment equals one invoice |
| `refunds` / `credit_notes` | unique provider IDs, affected payment/invoice, amount/currency/status/timestamps; additive corrections, not overwritten paid history |
| `stripe_events` | unique Stripe event ID with live/test context, type, provider/API version, received/processed time, retry state, necessary redacted payload |
| `usage_reservations` / `usage_events` | user, billing_period, publication, policy version; unique reservation and consumption per logical publication; signed correction events reference originals instead of deleting history |
| `work_items` | task type/entity, user, unique dedupe key, run_after, attempts, lease owner/expiry/fence, status and error; transactional enqueue with domain changes |
| `audit_logs` | actor user/site/system, action, owned target, timestamp, request/correlation ID and redacted change summary |

Add same-user composite FKs throughout jobs → revisions → requests → publications → targets. A publication must refer to a generation/manual revision for the same user, site and job, not merely any valid UUID. Enforce amounts/limits nonnegative, valid currencies/states, ordered periods, and uniqueness at database level. Application logic plus constraints should prevent multiple simultaneously entitled subscriptions per user. Choose explicit handling for trial/past-due states before enforcing that invariant.

Plan price financial/entitlement fields are immutable once used; use a restricted database role/trigger to enforce this. Correct billing history with new intervals/events. Product list prices and actual invoice amounts both remain available, so discounts/tax/proration do not erase what the customer actually paid.

Separate invoices from payments: Stripe has a distinct [Invoice Payment object](https://docs.stripe.com/api/invoice-payment/object) relating an invoice to payment details and allocated amounts. Avoid the preliminary schema's single payment row standing in for all billing activity.

## 10. Processing, idempotency and connector protocol

1. A scheduled worker claims a due connection, fetches bounded pages, persists eligible source revisions and work transactionally, then advances a cursor. Preserve first-appointment browsing behavior, but independently validate ServiceTitan's supported incremental-update semantics before choosing a sync cursor. Use overlapping sync windows plus unique identities and periodic reconciliation.
2. Normalize only generation-relevant facts into a stable hash. Unchanged retrievals create neither a new generation request nor a publication. Site settings, prompt/model changes and deliberate manual regeneration are explicit versioned operations.
3. Workers claim durable work with short transactions, leases, fencing and bounded concurrency. Retry transient failures with jitter/backoff and provider retry guidance; permanent validation/auth failures require repair. Expired claims resume without erasing earlier attempts.
4. Persist every AI attempt and its usage before accepting its content. A provider timeout after acceptance is an ambiguous outcome: local idempotency cannot guarantee the provider did not execute or charge. Reconcile where provider identifiers allow it; otherwise flag ambiguity rather than blindly regenerate. No claim of universal exactly-once external execution.
5. Preserve manual review for v1. Publishing captures the exact approved payload, its hash, selected attachment, desired status and expected remote fingerprint. Changes create a new content revision; retries reuse the operation ID.
6. WordPress pairs using a one-time code approved by the logged-in SaaS owner and a WP administrator. It keeps only a site credential; SaaS stores its hash and supports revocation/rotation. Poll and acknowledge routes derive the website/user from that credential and cannot act on another site's IDs.
7. The plugin polls for a bounded batch, records each operation in a local receipt/mapping table with unique operation and target identities, and serializes writes per target. It creates/stages a draft, attaches validated media, writes content/meta, then applies the intended publication status. A crash after remote creation must reconcile by the durable operation/target mapping before creating again. A receipt written only after the post would leave a duplicate window; use transactional local mapping where supported and explicit recovery for WP hooks/media side effects.
8. Acknowledgements validate operation, site, payload hash and lease/version; repeated acknowledgements return the previous result. Old deliveries must not overwrite newer revisions. Lost acknowledgements trigger re-delivery/reconciliation, not a second post or credit.
9. Keep WordPress fingerprints/revisions, with the expected fingerprint checked at the local write boundary. Manual changes create a conflict requiring review. Batch existing ZIP migration and keep shared ACF settings administrator-controlled.

Media should be delivered through authenticated SaaS endpoints scoped to the publication/site, with stream limits, timeouts and content validation. Do not retain images unnecessarily or expose ST credentials/download URLs to WordPress. Add private object storage only if offline delivery/retention requirements justify staging assets.

Poll scheduling needs a documented low-traffic-site strategy: WP-Cron with a health/last-seen indicator and a real host cron where predictable latency is required. Choose cadence and publication latency with the owner before promising an SLA.

## 11. Billing and proposed usage semantics

Stripe Checkout and Customer Portal should manage subscriptions; map a server-validated price version to the authenticated user. A redirect from checkout must not grant entitlement. Verify webhook signatures on the **raw body before `express.json`**, persist events uniquely, acknowledge quickly and process in the worker. Handle duplicates and out-of-order events with reconciliation, not arrival-order overwrites. These constraints follow [Stripe's webhook guidance](https://docs.stripe.com/webhooks). Pin/test an API version during implementation; no Stripe resources were created.

The following is a recommendation requiring explicit approval, not implemented policy:

| Operation | Proposed customer usage |
|---|---|
| First complete delivery to a WP draft or published post | 1, after verified success |
| Approved content/image update that changes an existing post | 1 per new logical operation |
| Same job delivered to a second website | 1 additional successful delivery, pooled against the same user |
| Retry, duplicate poll/ack, unchanged refresh | 0 additional |
| Failed AI generation or failed/partial WP delivery | 0 finalized usage |
| Generate/re-generate without delivery | 0 publication credits, but separate fair-use/rate/cost limits |
| Manual regeneration subsequently delivered | 1 successful update |
| Status-only draft/publish change | 0 |
| Imported existing posts or platform-required repair | 0, unless explicitly agreed otherwise |

Reserve capacity transactionally before queueing an approved publication; lock the user's period balance so two sites cannot spend the last credit simultaneously. Finalize one usage event when acknowledged, or release after confirmed cancellation/permanent failure. Never release an ambiguous delivered operation and then allow a late acknowledgement to consume unreserved capacity. Reconcile first. Proposed late-ack policy attributes success to its reserved billing period; require explicit approval and an expiry/reconciliation policy. Reversals are append-only adjustments.

Period boundaries come from the subscription, not month names. Plan changes, proration, grace periods, cancellation, rollover and overage behavior remain explicit decisions. Start with no paid overages and changes at renewal unless the owner chooses otherwise. No final prices or quotas are assumed.

## 12. Implementation phases and review gates

1. **Foundation:** establish or reconnect the private Git repository; baseline CI for current tests/build/PHP; fix hosted download and exposed API prerequisites; introduce PostgreSQL migrations, Google sessions, user ownership, encrypted connections and websites. Deliverable: two users cannot read or mutate each other's resources. No billing yet.
2. **Durable workflow:** persist sanitized jobs/revisions, prompts, generation attempts/costs and approved content; implement worker scheduling/leases/recovery with mocked-provider and database concurrency tests. Keep the existing editorial UI and push adapter behind ownership controls during transition.
3. **Pull connector:** pairing, poll/ack, durable local receipts, media recovery and manual-edit conflict handling. Import existing WordPress mappings using confirmed tenant plus metadata; use legacy slug fallback only with owner-reviewed disambiguation. Preserve all URLs, content, media and status. Imported records have unknown historical AI costs rather than fabricated provenance.
4. **Billing and metering:** only after semantics approval, add immutable price versions, subscription history, signed webhook inbox, invoice/payment reconciliation and atomic reservations/usage. Test duplicate/out-of-order webhooks, the last-credit race, and acknowledgements spanning periods.
5. **Staging and pilot:** after infrastructure approval, provision the reviewed Sevalla resources, configure Google/Stripe test environments and secrets, establish migration/rollback and backup restore, and run a controlled existing-site pilot. Disable legacy publishing per site before enabling its pull writer to avoid dual writers. Promote only after recovery and isolation tests pass.

## Decisions needed from the owner

1. Approve preserving React/Express with PostgreSQL + worker, Google-only users as the account boundary, and a pull-oriented WordPress connector.
2. Confirm whether v1 remains **human-reviewed publishing** (recommended) or needs automatic publication immediately; choose default draft/publish behavior, polling latency and sync cadence.
3. Approve or revise the usage table, especially drafts, second-site deliveries, manual regeneration, status-only changes and late acknowledgements. Define plan-change timing, past-due grace, limits, prices, free trials and fair-use behavior before billing work.
4. Identify the intended private Git repository, hosting region/budget and domain. This checkout has no Git remote; the Sevalla project is empty. Infrastructure provisioning remains a separate reviewed step.
5. Confirm initial import sites/tenant mappings, ACF dependency retention, and data retention/deletion requirements. Recommended privacy default: remove street/unit from AI inputs and store only sanitized source facts needed for provenance.

The handoff's explicit stop point is observed: this document is the reviewable proposal; no migration, provisioning, deployment, or billing implementation has begun.
