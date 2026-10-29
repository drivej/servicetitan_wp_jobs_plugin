# Exclusive WordPress website ownership

Each workspace continues to own one website. Team members share the website using the existing membership and email-bound invitation model; signing up does not grant another workspace publication rights.

## Deployment

1. Publish companion plugin **1.20.5**. The authenticated `/wp-json/servicetitan-job-integration/v1/identity` route requires `manage_options`. It creates an atomic, persistent, per-blog installation UUID and returns the WordPress home URL. The public status endpoint does not expose this identifier. Preserve the option through plugin upgrades, deactivation, and disconnects. A database clone preserves the UUID and is deliberately blocked from becoming a second owner.
2. Apply migration **014_website_ownership.sql** with the migration-owner connection before deploying the server. For a separate runtime role, grant `SELECT, INSERT ON website_ownership_requests` (substitute the actual role). Existing website rows and encrypted credentials remain intact. Previously validated websites become unverified and onboarding restarts at step 1; there is no automatic assignment among legacy duplicates.
3. Deploy the server and client. Each existing website administrator must verify again with a WordPress administrator application password. A plain URL save remains provisional and cannot publish. Do not run the previous server alongside the updated server: the previous code does not enforce ownership verification.

## Enforcement

The claim is committed only after administrator authentication at the installation identity endpoint. Global partial unique indexes protect both the installation UUID and its verified canonical URL across workspace RLS boundaries. Concurrent claims serialize at PostgreSQL's unique constraint; the loser receives a generic HTTP 409 with code `website_already_connected`. No owner, workspace identifier, email, or membership information is returned.

The original public-network DNS/socket checks and redirect prohibition remain in use, including the onboarding access check. URLs retain installation subpaths; HTTPS, lowercase/IDNA hosts, default port removal, dot-segment resolution, and trailing-slash removal use URL parsing. Private destinations, embedded credentials, queries, fragments, custom ports, backslashes and encoded path separators are rejected. Distinct `www` hosts and subdirectories are not blindly merged. A WordPress canonical address on another origin must be entered explicitly; the server never forwards the application password to a domain supplied by a remote response. Unclaimed URLs can be corrected in Settings; claimed URLs require reviewed migration.

Credential/settings edits invalidate verification but retain the exclusive claim. Verification is bound to the saved settings version, so a delayed check cannot validate newer credentials. Installation or canonical URL changes on an existing claim are blocked. Cached providers and background jobs check current membership, settings version, the database claim, and the remote identity before WordPress requests; paid WordPress operations also check before token reservation. Public WordPress status checking during onboarding does not grant ownership.

## Requests and disputes

The conflict screen lets a signed-in workspace owner/admin submit access or dispute requests with an explanation after proving current WordPress administrator access. Requests are rate limited through the existing authenticated API limiter and deduplicated per workspace/installation/kind.

Access requests appear under **Team settings → Website requests** in the connected workspace. Its owner/admin reviews the requester and uses the existing **Invite teammates** flow. Invitation creation does not send email: the administrator shares the generated link using the existing UI. Email-bound acceptance, role restrictions, expiry, revocation, and workspace switching continue unchanged. Requests never add members automatically. Requesters do not see existing owner identity.

Platform administrators can review disputes (and access requests) in their own Team settings. Dispute records do not grant access or release a claim. There is no outgoing email notification, automated adjudication, status resolution, or ownership transfer endpoint in this change. Requests remain as review records; repeats do not overwrite their evidence. Standalone website disconnect and ownership transfer remain unavailable. Migration 015 adds a separate, explicitly confirmed superadmin account-deletion flow that erases the account’s website row and releases its ownership claim; see [account deletion](account-deletion.md).

## Decisions before rollout

- Confirm the one-time re-verification rollout and which verified administrator should claim any legacy duplicates.
- Assign a platform dispute reviewer and an operational response process. Decide later whether to add request resolution/status, notifications, appeal evidence without current WordPress access, or a support contact.
- Define a separately reviewed transfer/domain-migration/disconnect protocol before exposing those operations. It must pause publishing/queues, revoke old credentials, invalidate cached contexts, verify the recipient, audit the change, and retain a claim until transfer is atomic. Do not delete a claim merely because credentials fail or billing lapses.

## Verification

Ownership tests cover competing claims, canonical URL reuse after UUID reset, RLS/privacy, team-member verification restrictions and revocation, stale verification, credential edits, URL handling, canonical credential forwarding, and provider rejection before external writes/token reservations. The PHP identity test covers administrator permissions, persistent identity, multisite separation and exclusion from public status.

Run `npm run typecheck`, the relevant Node tests, `php wordpress-plugin/tests/installation-identity.php`, `php wordpress-plugin/tests/page-zipcodes.php`, and the normal build. The existing full suite also contains unrelated failures; see the implementation report for the baseline comparison.
