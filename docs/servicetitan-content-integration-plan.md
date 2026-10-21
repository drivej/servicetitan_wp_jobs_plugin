# ServiceTitan work-content access results and integration plan

Tested 2026-10-21 against Production using the existing ServiceTitan credentials in local `.env`. This does not establish that the deployed SaaS database stores the same credentials or that every tenant has these permissions. No ServiceTitan records were modified, no AI requests were made, and no WordPress posts were created or changed. OAuth token issuance was the only POST. The probe prints HTTP statuses, record counts, field types, and presence flags; it does not save customer text, job IDs, invoice values, tokens, or credentials.

Reproduce with `node scripts/probe-servicetitan-content.mjs` from the repository root. It deliberately uses `.env` without logging its values and uses the official production/integration hosts selected by `ST_ENVIRONMENT`. Each request has a 15-second timeout, redirects are rejected, and record samples are bounded. Network access must be available. The report is point-in-time evidence, not an ongoing uptime check.

## Observed access

See `servicetitan-content-access-results.json` for the metadata-only result.

| Source | Request | Observed result | Meaning |
|---|---|---|---|
| OAuth | POST `/connect/token` | 200 | Existing credentials accepted |
| Jobs | GET `/jpm/v2/tenant/{tenant}/jobs` | 200, three completed jobs sampled | Job IDs available for linked probes |
| Job details / Summary of Work | GET `/jpm/v2/tenant/{tenant}/jobs/{id}` | 200 for all three; `summaryOfWork` present but empty for all three | No additional completion narrative demonstrated in this sample; ordinary summaries were nonempty |
| Invoices | GET `/accounting/v2/tenant/{tenant}/invoices?jobId={jobId}` | 200 for all three; one invoice sampled per job | All three invoice job links matched the requested job; each contained a nonempty summary, items, and item descriptions |
| Forms | GET `/forms/v2/tenant/{tenant}/forms` | 200, one record | Definitions metadata accessible |
| Form submissions | GET `/forms/v2/tenant/{tenant}/submissions` | 200, one record | Owners and units accessible; sampled owners have `type` and `id` |

The single sampled submission had an attachment unit, not demonstrated narrative question/answer content. It exposes attachment filename fields, not a verified downloadable URL. Access to the submissions list does not prove that all form types expose usable answers or that this sample belongs to one of the three jobs. No attachment bytes were downloaded. The invoice sample establishes useful text is populated, not that the text is high quality or uniquely describes completed actions.

## Recommendation

Implement invoice summaries/items first, alongside opportunistic `summaryOfWork` extraction from the job response already fetched. Add forms after verifying job-owner matching, completed-status semantics, and actual narrative/checklist unit shapes on representative job-linked submissions. Keep the existing notes/history sources. Do not make optional enrichment permissions a prerequisite for the app's existing job workflow.

## Phase 1 — invoice and completion-summary enrichment

1. Extend the provider types in `src/server/service-titan.ts` and the shared `JobCopySource` in `src/shared/job-copy.ts` with separate, bounded fields such as `workSummary` and `invoiceWorkItems`. Keep the ordinary job summary separate so the reason for the call is distinguishable from the work completed. Carry a source identifier and modification timestamp where provided.
2. Extract `summaryOfWork` from the existing job-details response. Add no separate API call. Treat missing/null/empty strings as absent; do not interpret them as denied access or a failure.
3. Add a typed `getJobInvoiceWorkContent(jobId)` using the verified invoices endpoint. Filter by the job ID and explicitly recheck each response invoice's job association before using its content. Handle pagination and adjustment/cancelled/void statuses according to the actual schema; do not assume the first invoice is the only invoice or that every adjustment represents completed work. Enforce a proposed bound of five pages × 20 invoices, 30 selected work items, and 8,000 total sanitized text characters per job. If truncated, surface that fact internally rather than silently claiming a complete invoice history.
4. Allowlist service descriptions, item descriptions, and relevant material/equipment names. Exclude prices, taxes, balances, payment details, customer contact/address information, signatures, and internal identifiers from public copy inputs. Strip markup, redact contact data, deduplicate repeated descriptions, and enforce lengths before crossing the SaaS/browser/AI boundary. Treat source text as data, never instructions.
5. Preserve these safe fields through `minimizeJobDetails()` in `src/server/saas/providers.ts`. Confirm all entry points receive them: Job Details, manual AI generation/prompt preview in `src/server/app.ts`, regeneration, and `buildAndDeploy()`.
6. Show a Work performed section in Job Details with source labels: Completion summary, Invoice summary, Billed service items, and Technician notes. Make it possible to inspect the factual source before updating a post. Do not label a generic pricebook description as a technician-confirmed action or outcome.
7. Update `buildJobCopyFacts()` and the prompt rules in `src/server/job-copy-prompt.ts`. Prefer explicit job-specific completion notes; treat invoice items as evidence of billed scope and keep generic pricebook promises, warranties, suggested repairs, and exclusions from becoming claims of completed work. Resolve contradictions conservatively and never infer results from a billed item alone. Bump `SEO_GENERATOR_VERSION` when these inputs/rules change so existing posts can be reviewed and regenerated deliberately.

## Phase 2 — completed job forms

1. Use an identified completed job with known form content to verify `owners[].type/id` association and supported query filters. An owner must explicitly match the current job; location/customer-only ownership is not sufficient evidence for this particular job. Verify which owner type values identify jobs; do not infer by numeric ID equality alone.
2. Verify response schemas for text answers, selected choices, measurements, repeated sections, comments, and attachments. The tested definition record supplied metadata only; verify whether any additional read endpoint is needed for field labels before promising question/answer mapping.
3. Select completed submissions and the correct version/revision; distinguish unchecked/blank fields from explicit negative answers. Retain question + answer + units together and avoid confusing template questions with recorded observations. Allowlist work-relevant fields and omit personal, billing, signature, and access-code fields.
4. Add a sanitized `formFindings` structure with source labels and strict caps (proposed: ten submissions, 50 relevant answers, 8,000 text characters). Keep photos/PDFs as references initially; do not add OCR or vision processing by default. Those would add network/AI cost and need their own extraction/validation design.
5. Prefer a documented job-scoped filter. If ServiceTitan cannot query submissions by job, avoid a tenant-wide scan on every Job Details request: use an incremental, bounded sync keyed by tenant/credential version and submission modification/creation cursor, build a job-owner index, and retain a configurable lookback for edits. Confirm rate limits and pagination behavior before choosing sync frequency. This phase may warrant a database migration; phase 1 need not.

## Health checks and graceful degradation

- Add invoices, forms definitions, and submissions as optional enrichment rows in the superadmin API Health page. Summary of Work is a field-presence/content check on job details, not a separate endpoint. Distinguish access granted but empty from denied access.
- Keep optional checks separate from the Settings required-endpoint validation. Existing customers with only the current permissions should retain existing functionality. If richer content later becomes a product requirement, change that policy explicitly rather than incidentally through a new probe.
- Optional 401/403/404/429/timeouts must not break ordinary job loading or make an accepted build fail solely due to enrichment. Return per-source availability flags and a useful internal notice, while generating conservatively from the available sources.
- Keep scope enforcement on every request. Cache keys must include tenant/integration identity and credential version; never reuse content across workspaces. Do not cache authorization decisions long enough to preserve revoked access.

## Processing-cost controls

- Do not enrich the jobs list per row. Fetch richer content only for Job Details, generation, or a queued build.
- Share one enrichment result across preview/generation/build stages where freshness allows. Suggested initial cache: five-minute TTL, 100 jobs or 10 MiB total per process (whichever comes first), in-flight request coalescing, two enrichment requests at most per connection, and explicit refresh. Reuse the established provider pool/cache design or account for the current five-minute provider lifetimes.
- Add short negative-access caching per connection/version for denied optional endpoints. Honor Retry-After on 429; avoid retry loops or repeated full submission scans.
- Keep canonical source bounds and an aggregate prompt budget so invoices/forms cannot grow AI input without limit. Track calls/job, response bytes, cache hit rate, enrichment latency, and safe token-usage metadata. Never log raw invoice/form bodies by default.

## Verification before release

- Fixtures for populated/empty/null `summaryOfWork`; invoice job mismatch; multiple invoices/adjustments; pagination/truncation; duplicated descriptions; denied/missing/rate-limited/timed-out optional APIs.
- Security cases for cross-workspace/tenant access, credential rotation, malicious source instructions, contact data/financial fields, and accidental raw-payload exposure in browser/AI requests.
- Form cases for wrong owner type, customer/location-only ownership, drafts, superseded submissions, unchecked fields, attachment-only units, missing labels, and multiple visits to one job.
- Contract checks that manual generation, previews, queued builds and regeneration receive the same sanitized sources; normal list requests must issue zero enrichment calls.
- Compare drafts for a small set of user-selected completed jobs with and without enrichment. Success means more specific supported work descriptions with no invented repairs or outcomes, and bounded API/AI cost. Release behind optional enrichment controls, then expand after review; do not rewrite existing WordPress posts automatically.

## Remaining decisions

Invoices are ready for a typed implementation spike based on verified access and populated fields. Before forms implementation, select representative jobs with completed narrative/checklist forms and verify their documented query/status semantics. Before deployment, confirm the saved SaaS connection matches the local credential set tested here, or repeat the same read-only probes through its authorized connection context.

Reference: [ServiceTitan API reference](https://tenant-api-credentials-portal.servicetitan.io/docs/apis), [Summary of Work field documentation](https://developer.servicetitan.io/docs/apis/tenant-jpm-v2/endpoints/Jobs_Update), [Forms guidance](https://help.servicetitan.com/docs/forms). These references describe capability; the HTTP results above are the actual access evidence for this credential set.

## Implemented 2026-10-21

Invoice descriptions and nonempty completion summaries now flow through shared job details into manual/queued generation, regeneration, and the source-review UI. Optional API Health rows were added without expanding Settings' required checks. A second live read-only sample confirmed `Completed` form status, `Job` ownership, and native Text/Checkbox units; its metadata-only schema result is saved in `servicetitan-form-schema-results.json`.

Forms use a deliberately bounded in-memory recent-window index rather than the proposed persistent full-history sync: 30 days, at most 150 submissions per five minutes per workspace/integration/credential, ten integration caches. All form coverage is marked partial. The latest sampled completed form per job/form is selected; attachments and unsupported units are ignored. This avoids a database migration and unbounded scanning, but historical completeness remains a future enhancement. Optional prompt enrichment has an aggregate 12,000-character ceiling.

A live smoke test of the implemented pipeline on one production job succeeded, returning one invoice summary and two item descriptions. That sample had no populated completion summary or matching recent form findings. No AI generation or WordPress writes were performed.
