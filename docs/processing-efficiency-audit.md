# Processing efficiency and Sevalla cost audit

Date: 2026-10-14. Source revision: `0926ae0`.

## Scope and conclusion

Inspected the Node/Express app, React request flows, PostgreSQL migrations, ServiceTitan and WordPress clients, background build queue, and deployment configuration. This is a source-based audit with a mocked SQL-count check and existing test verification. No live Sevalla metrics, invoices, database query plans, production settings, or production traffic were available. Rankings reflect avoidable work and likely impact, not measured dollar savings. No application behavior was changed.

The strongest opportunities are full-size thumbnail downloads, constant idle queue/database polling, and constant browser polling amplified by expensive request middleware. Search rescans and short-lived provider caches become increasingly significant with more users. Ordinary I/O waits do not consume a CPU core continuously; connection contention, memory peaks, parsing, and repeated database work are the scaling concerns.

## How the work affects bills

Sevalla publishes runtime pod prices by size, build pods at $0.02/minute, external bandwidth at $0.10/GB, and free internal bandwidth. S1 is listed at $10/month and S2 at $40/month. These are published estimates excluding tax, not this app's verified plan. Source: [Sevalla application hosting pricing](https://sevalla.com/application-hosting/pricing/), checked 2026-10-14.

Removing SQL calls does not produce a per-query bill reduction. It reduces pressure on provisioned app/database resources and may avoid an upgrade or allow downsizing. Bandwidth reductions and avoided deployment build minutes have a more direct metered impact. Confirm the account's actual bandwidth accounting and discounts before treating the examples below as invoice predictions.

## Prioritized findings

### 1. Full original images are downloaded for tiny thumbnails — high priority

Evidence: `src/client/JobThumbnail.tsx:26` and `:48`; `src/server/app.ts:156`; `src/server/service-titan.ts:210`.

Every list job returns an empty attachment list, prompting a separate image-candidate request. Each thumbnail then requests an original image through the application. CSS/HTML displays it at 64 × 64 pixels but does not reduce the downloaded bytes. The server downloads and buffers up to 15 MiB, then copies the bytes into another Buffer for the response. Responses use `private, no-store`. The browser mounts images eagerly, with no lazy-loading attribute. Failed candidates are tried sequentially and can add more downloads.

At the default 25 rows, a page with one valid image per job generates 25 candidate requests plus 25 image requests, in addition to search/status traffic. Those requests also incur SaaS database middleware. Image bytes are not cached server-side; metadata is cached. Reopening a page repeats full image transfers.

Illustrative browser delivery: 25 × 5 MB = 125 MB per page. At 10,000 such page loads/month that is 1,250 GB, roughly $125 at the published external bandwidth rate, considering this browser-bound leg alone. A 20 KB thumbnail would reduce that leg to about 5 GB, or $0.50. These are hypothetical decimal-unit examples; actual image sizes and page loads are unknown. Concurrent large images also create memory peaks beyond a single buffer's size and can trigger a larger pod or restarts.

Recommended: generate a small thumbnail once, store it in a bounded cache/object store, and serve that variant to the list. Retain authorization and tenant isolation; do not expose ServiceTitan credentials or signed upstream URLs. Consider private short-lived browser caching with credential/version-aware keys and explicit invalidation. Lazy-load rows outside the viewport and bound concurrent original downloads. Resizing on every request without caching would trade bandwidth waste for CPU waste.

### 2. Worker queries PostgreSQL every second while idle — high priority

Evidence: `src/server/build-queue.ts:85`, `:110`; `src/server/saas/database.ts:15`; `src/server/index.ts:66`.

The worker starts in every application instance. Every empty claim opens a transaction, sets two session variables, attempts a stale-task UPDATE, selects a queued task, and commits: six SQL commands. A mocked client executing the actual transaction wrapper and claim method confirmed this sequence.

At negligible database latency, one idle instance approaches 86,400 transactions/day, or 2.592 million per 30 days, containing approximately 15.552 million SQL commands. The loop waits one second after each completed check, so real counts are slightly lower. Three instances approximately triple this baseline.

Recommended: back off idle checks to 5–30 seconds, reset to a short delay when work appears, and run stale-task recovery less frequently. A 30-second empty interval reduces idle polling approximately 97%. PostgreSQL notifications can wake a worker sooner, with periodic polling retained for recovery. Keep deduplication and `SKIP LOCKED` semantics. Separate worker deployment only when metrics justify its additional pod cost; a new worker pod is not inherently a saving.

### 3. Jobs page polls continuously, even with no active builds — high priority

Evidence: `src/client/App.tsx:88`; `src/server/saas/app.ts:130`, `:487`; `src/server/saas/store.ts:50`, `:84`, `:104`, `:273`.

The list polls `/build-deploy/statuses` every three seconds whenever there are results. It continues after all tasks finish and on pages with no builds. There is no visibility-based pause or failure backoff. Details polling already limits itself to queued/running tasks, providing a useful pattern.

A successful normal SaaS list-status poll performs four transactions: session lookup (5 SQL commands), rate limiting (6), website context (10), and queue list (5): approximately 26 SQL commands. Website context also decrypts integration credentials even though queue status needs no provider. This count excludes impersonation and unusual paths.

One continuously open list approaches 1,200 polls/hour and 31,200 SQL commands/hour. Ten tabs left open eight hours/day for 30 days approach 2.88 million requests and 74.88 million SQL commands. Response latency and browser timer throttling can lower those numbers.

These status reads are POSTs, so they consume the shared write limit of 30/minute. One tab uses about 20/minute; two tabs can exceed the limit from polling alone, causing errors and more unsuccessful polling.

Recommended: check once on page load, poll rapidly only for active tasks, pause hidden tabs, and back off on errors/429 responses. Retain slower discovery or server notifications if builds started by another user must appear automatically. Give status reads their own rate-limit category and lightweight authorization path that does not load/decrypt provider credentials. Preserve membership checks and immediate access revocation requirements.

### 4. Every website request takes an exclusive workspace lock — medium/high priority

Evidence: `src/server/saas/store.ts:104`, `:273`; `src/server/saas/app.ts:487`; `src/server/index.ts:27`.

`websiteContext()` uses `workspaceTransaction()`, which locks the workspace row `FOR UPDATE`, even for image GETs and queue status reads. Requests for one workspace serialize during this transaction. A thumbnail-heavy page therefore produces a burst of competing locks; blocked requests occupy connections from a pool capped at ten per app instance. Credential decryption occurs before that transaction returns.

The lock is released before the downstream provider work; it is not held throughout image downloads or AI generation. Current `spendJobToken()` also commits its reservation before calling the external provider. The README's older description of holding a row lock during paid provider work does not match the current implementation.

Recommended: separate read authorization from mutation/spend locking. Design and test the revocation behavior before changing isolation or locks. Keep locking where it protects token accounting and access-changing mutations. Do not simply increase the pool: replicas already multiply the ten-connection cap.

### 5. ZIP pagination rescans earlier source pages — medium priority, workload dependent

Evidence: `src/server/service-titan.ts:347`, `:461`; README search limits.

Each ZIP search starts scanning jobs at source page one, up to 20 pages of 500 jobs. Moving to the next app page or revisiting a page repeats earlier source reads. Only ZIP location IDs are cached, not search results. Enrichment refetches locations and job types for each page; tag catalogs have a shared cache. Cold location lookup can add up to 20 additional source calls.

Recommended: use a short-lived bounded cache of filtered search windows or continuation state keyed by tenant/credential version, date range, ZIP, and relevant filters. Fetch each window once with concurrent request coalescing. Cache relatively static job types separately. Maintain freshness controls and current scan limits. Add a tenant job index/sync process only if measured search volume justifies its storage and maintenance cost.

### 6. Provider instances expire frequently and are recreated for every queued build — medium priority

Evidence: `src/server/saas/providers.ts:24`, `:48`; `src/server/service-titan.ts:84`, `:408`, `:552`; `src/server/wordpress.ts:334`.

Website apps are cached for a fixed five minutes, keyed by user/workspace/site/credential versions and capped at 100. Each new app creates new ServiceTitan and WordPress clients. Access tokens, attachment metadata, and WordPress ZIP-sync completion are instance-local. Every queued task creates fresh providers, so consecutive tasks cannot reuse those client caches. Shared ZIP location/tag caches already mitigate some repeated work.

Plugin status checks also invoke ZIP configuration sync. With fresh clients, this can repeatedly read the ZIP catalog and POST configuration; missing coordinates may trigger sequential external lookups. This adds latency and upstream work even when the requested action is just status checking.

Recommended: pool providers by workspace/integration/credential version while preserving request-level user authorization. Bound lifetimes and cache sizes. Move ZIP maintenance to explicit configuration changes or a versioned periodic operation. Avoid adding Redis solely for this until instance count and measured cache misses justify the extra service.

### 7. Queue history grows without a matching status-history index — medium priority over time

Evidence: `migrations/006_build_deploy_queue.sql`; `src/server/build-queue.ts:81`, `:87`; README queue retention.

Completed tasks remain indefinitely. Existing indexes cover active deduplication and pending claims, but do not fully support latest historical status lookup by workspace/site/job ordered by creation time. Stale recovery also has no dedicated running/updated-time index. As history grows, status lookup and recovery can examine increasingly large candidate sets; the actual plan depends on table size and statistics.

Recommended: inspect `EXPLAIN (ANALYZE, BUFFERS)` on representative staging data before adding indexes. Candidates: `(workspace_id, website_id, job_id, created_at DESC)` for status and a partial `(updated_at) WHERE state='running'` index for stale recovery. Retain active tasks; archive/delete terminal history in small batches according to an agreed retention period. Treat audit logs, token ledger, and spend idempotency records separately; deleting those blindly can break reconciliation or replay protection.

Local-mode caveat: `FileBuildQueueStore.access()` reads and rewrites the complete JSON file even for list/empty-claim calls. History therefore amplifies local disk work every second. Production mode is SaaS, so this is a local development concern rather than the normal Sevalla path.

### 8. Rate limiting writes and performs global expiry cleanup on every API request — medium priority

Evidence: `src/server/saas/store.ts:84`; `migrations/001_accounts.sql:31`.

Every authenticated request executes expiry deletion plus counter upsert in its own transaction. Expiry is indexed, so this is not necessarily a full-table scan; however, image and polling volume turn rate limiting into sustained database write/WAL churn. Requests exceeding the limit still perform this work. Counters are shared per actor/category, adding contention during bursts.

Recommended: first reduce request volume. Then move expiration cleanup off the hot path to bounded periodic batches and make the upsert reset expired windows correctly. Preserve distributed enforcement if moving counters out of PostgreSQL; a naive per-process map changes limits across replicas. An existing edge rate limiter may help, but deployment support and cost must be verified.

## Additional costs and deployment checks

- **Deployment builds:** `nixpacks.toml` installs development dependencies and runs the full build; `.github/workflows/deploy.yml` triggers a deployment on pushes to `feat/saas-foundation`. Confirm dashboard auto-deploy is not also triggering a second build; this cannot be established from source. At published rates, 100 builds × 5 minutes is $10. The user-facing Build button runs job generation/publishing, not a Sevalla deployment build.
- **Production configuration:** verify `NODE_ENV=production` and `APP_MODE=saas` in Sevalla. Otherwise `index.ts` starts Vite middleware/watchers. Documentation requires production mode, but live values were not inspected.
- **Database networking:** verify app/database use the supported internal connection and appropriate region placement. Source alone cannot establish the deployed connection route. Do not expose database credentials when collecting evidence.
- **Frontend delivery:** Express serves static assets with a one-hour cache. Existing built assets are approximately 605 KiB JS and 51 KiB CSS, uncompressed. Verify proxy/CDN compression before adding app compression. Long immutable caching for hashed assets is a secondary opportunity; image traffic is much larger.
- **AI charges:** generation enables optional web search for a company domain and caps output at 2,000 tokens. Model/tool charges are external-provider costs, distinct from Sevalla. Failed validation or timeout can still consume upstream work even if app tokens are refunded. Record safe usage/cost metadata; do not assume app token balances equal provider costs. Avoid changing generation quality solely to reduce hosting cost.
- **Repeated detail reads:** details, prompt previews, AI generation, and manual publish/update can repeat a multi-endpoint ServiceTitan fetch; notes may paginate up to 100 × 50 records. Details and image reads happen before token reservation/replay checks on some routes. Consider a short-lived authorized detail cache and earlier idempotency validation, while preserving content fingerprints and current access checks.
- **Worker scaling:** each web replica adds one worker and ten possible DB connections. More web replicas also increase job concurrency and downstream provider demand. An independent concurrency cap may be preferable to tying job throughput directly to web scaling.
- **Public WordPress pages:** the shortcode queries local WordPress posts; ordinary public page views do not call the Sevalla app through that shortcode. WordPress query optimization would principally reduce WordPress hosting load.

## Suggested implementation order and acceptance checks

1. Stop fast idle browser polling; pause hidden tabs and back off errors. Verify idle visible pages stop issuing three-second requests while active builds still update and remote builds remain discoverable.
2. Back off idle worker claims and decouple stale recovery. Verify idle claim counts fall at least 90%, enqueue latency stays within the accepted bound, restarts preserve tasks, and multiple workers cannot duplicate a task.
3. Add cached thumbnails and bounded image concurrency. Measure bytes/page and peak RSS for 25 and 50 rows; verify image candidate fallback and cross-workspace access protections.
4. Introduce lightweight queue authorization, reduce read-path locks, and tune rate-limit cleanup. Verify revoked users lose access, token accounting stays correct under concurrency, and two tabs do not exhaust mutation allowance just by viewing progress.
5. Add measured history indexes/retention and improve provider/search cache reuse. Validate plans, query time, cache hit rates, credential rotation, tenant isolation, and freshness.

## Production evidence needed to quantify savings

Collect a representative seven-day window: app/database pod sizes and instance counts; autoscaling bounds; CPU/RSS peaks and restarts; external GB; deployment count/duration; request counts/bytes by route; active/hidden tab time if available; queue depth and idle claim rate; upstream call counts/latency by provider; pool wait time and workspace lock waits; table/index sizes and growth; representative query plans; thumbnail source-size distribution. Use redacted request IDs and route templates, not customer payloads, credentials, or signed URLs.

Estimate total cost as provisioned app/runtime + database + billed external GB × bandwidth rate + build minutes × build rate + storage + external providers. Compare the same workload before and after each change. Do not promise a percentage reduction in the overall invoice from source-level request counts alone.

## Verification results

- Executed the actual PostgreSQL queue claim against a mocked pool: confirmed six SQL commands for an idle claim. This validates command count, not real database CPU, latency, or execution plans.
- Ran the existing `npm test` suite. Initial sandbox execution could not bind localhost (`EPERM`); reran with localhost access enabled. Final result: 98 tests, 86 passed, 12 failed (including failed parent/subtest entries). Failures include plugin download returning 404, copy/SEO fixture and validation errors, build/deploy expectations, account workflow assertions, and administrator response expectations. The suite is not green; failures were observed on unchanged application source and were not repaired as part of this audit.
- Inspected migration indexes and traced request middleware to derive per-poll counts. Did not run a production load test, contact live integration endpoints, read secret environment contents, or change deployment settings.
