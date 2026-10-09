=== Job Showcase for ServiceTitan ===
Contributors: servicetitan-jobs
Tags: servicetitan, rest-api, custom-post-type
Requires at least: 6.5
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.18.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Publishes ServiceTitan job posts with shortcode-configured multi-ZIP filtering.

== Description ==

This companion plugin registers the ServiceTitan job custom post type, enables
REST publishing, and fixes its collection-level create capability. If another
plugin already provides the st_job post type, that registration is preserved.

Advanced Custom Fields is required. The plugin registers a shared, multi-select
ZIP taxonomy field on Posts, Pages, and ServiceTitan job posts. Each ZIP term
stores city and state metadata, and missing terms are created when jobs are published.
Add `[servicetitan_jobs]` to a page to show published jobs and pagination. ZIP
codes are configured in the shortcode and are never shown as visitor-facing
filter controls.

Shortcode options:

* `[servicetitan_jobs]`
* `[servicetitan_jobs zipcodes="78701,78702"]`
* `[servicetitan_jobs zipcodes="07001,07002" offset="1" limit="10" page_size="2"]`
* `[servicetitan_jobs posts_per_page="12"]`

`offset` skips matching jobs, `limit` caps the complete result set, and
`page_size` controls the number of jobs shown on each pagination page. The
older `posts_per_page` attribute remains supported when `page_size` is omitted.

The plugin does not store ServiceTitan or WordPress credentials.

== Installation ==

1. Install and activate Advanced Custom Fields.
2. Download the ZIP from the ServiceTitan Jobs application.
3. In WordPress, go to Plugins > Add New Plugin > Upload Plugin.
4. Select the ZIP, install it, and activate Job Showcase for ServiceTitan.
5. Confirm the integration user has the post type's edit and publish capabilities.

Developers can change the default st_job post type key with the stji_post_type
filter. Add custom post types to the shared ZIP selector with the
stji_zip_post_types filter.

== Changelog ==

= 1.18.2 =
* Return each post's updated timestamp in bulk status responses.

= 1.18.1 =
* Return the current WordPress post title and excerpt so existing copy can be reviewed and edited before rebuilding.

= 1.17.0 =
* Store validated latitude and longitude metadata from Zippopotam.us on each ZIP term for future proximity features.

= 1.16.0 =
* Show each ZIP term's city and state in the ZIP Codes admin list.

= 1.15.0 =
* Keep the shared ZIP selector in the ACF meta-box area and remove the duplicate native editor-sidebar panel.
* Keep ZIP term management under ServiceTitan Jobs while removing duplicate Posts and Pages submenu links.

= 1.14.0 =
* Show the ZIP term's city at the top of each job post and link it to a published Page assigned to the same ZIP when available.

= 1.13.0 =
* Expose the shared ZIP taxonomy and ACF selector on regular WordPress Posts.
* Allow developers to add other custom post types with the stji_zip_post_types filter.

= 1.12.0 =
* Require Advanced Custom Fields and register a shared, configurable multi-ZIP taxonomy field on Pages and ServiceTitan jobs.
* Create missing ZIP terms during job publishing and store city/state metadata on each ZIP term.
* Add linked Project Area and ServiceTitan completion date metadata to single job pages.

= 1.11.1 =
* Allowed responsive job grids to add more columns within theme-constrained content areas.

= 1.11.0 =
* Made shortcode job cards fill a responsive, equal-height grid across phone, tablet, and desktop layouts.

= 1.10.0 =
* Simplified shortcode cards to the featured image, title, and excerpt.
* Moved the approximate map to single job pages.
* Added Project Area links to published city pages using their ACF ZIP-code values.

= 1.9.3 =
* Present shortcode jobs as compact project-snapshot cards with the featured image and approximate map in one visual stack.

= 1.9.2 =
* Track the originating ServiceTitan attachment for featured images and expose it to the admin app.

= 1.9.1 =
* Simplified shortcode maps by removing the place-information overlay and increasing street-level zoom.

= 1.9.0 =
* Added lazy approximate-location maps to shortcode cards using each job's ZIP taxonomy.
* Added a first-attached-image fallback for legacy posts without a featured image.

= 1.8.0 =
* Added featured images and responsive card styling to shortcode job results.

= 1.7.0 =
* Added SEO generator version metadata and generated-content fingerprints.
* Reports current, outdated, legacy, and manually edited generated posts to the app.
* Enabled WordPress revisions for safer SEO regeneration.

= 1.6.0 =
* Added featured-image support for ServiceTitan job posts.

= 1.5.2 =
* Kept ZIP taxonomy terms available for shortcode queries without displaying ZIP codes publicly.

= 1.5.1 =
* Made ZIP selection shortcode-only and removed visitor-facing filter controls.

= 1.5.0 =
* Added shortcode offset, total-result limit, and page-size controls.

= 1.4.1 =
* Hid empty shortcode results from visitors and added an administrator-only empty-state message.

= 1.4.0 =
* Added an authenticated bulk post-status endpoint using one WordPress query.

= 1.3.0 =
* Added an authenticated compatibility endpoint for app-side update detection.

= 1.2.0 =
* Added automatic ServiceTitan job custom-post-type registration.
* Preserves compatible st_job registrations supplied by another plugin.

= 1.1.0 =
* Added the job ZIP-code taxonomy and REST assignment field.
* Added the filterable, paginated servicetitan_jobs shortcode.
* Added multiple ZIP-code selection and shortcode defaults.

= 1.0.1 =
* Repackaged using a WordPress-compatible ZIP format.

= 1.0.0 =
* Initial release.
