<?php
/**
 * Plugin Name: Job Showcase for ServiceTitan
 * Description: Publishes ServiceTitan job posts and provides shortcode-configured ZIP filtering for WordPress pages.
 * Version: 1.18.1
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Requires Plugins: advanced-custom-fields
 * Author: ServiceTitan Jobs
 * License: GPL-2.0-or-later
 * Text Domain: servicetitan-job-integration
 */

if (!defined('ABSPATH')) {
    exit;
}

define('STJI_VERSION', '1.18.1');
define('STJI_SEO_VERSION_META', '_stji_seo_version');
define('STJI_GENERATED_HASH_META', '_stji_generated_hash');
define('STJI_GENERATED_AT_META', '_stji_generated_at');
define('STJI_JOB_ID_META', '_stji_job_id');
define('STJI_SOURCE_ATTACHMENT_ID_META', '_stji_source_attachment_id');
define('STJI_COMPLETED_ON_META', '_stji_completed_on');
define('STJI_ZIP_ACF_FIELD_OPTION', 'stji_zip_acf_field_name');
define('STJI_ZIP_ACF_FIELD_KEY', 'field_stji_zip_codes');
define('STJI_ZIP_CITY_FIELD_KEY', 'field_stji_zip_city');
define('STJI_ZIP_STATE_FIELD_KEY', 'field_stji_zip_state');
define('STJI_ZIP_LATITUDE_FIELD_KEY', 'field_stji_zip_latitude');
define('STJI_ZIP_LONGITUDE_FIELD_KEY', 'field_stji_zip_longitude');

/**
 * Remember which ServiceTitan attachment produced an uploaded media item.
 *
 * @param WP_Post         $attachment Media attachment post.
 * @param WP_REST_Request $request    REST request used to create it.
 * @param bool            $creating   Whether this request created the attachment.
 */
function stji_store_source_attachment_id(WP_Post $attachment, WP_REST_Request $request, bool $creating): void
{
    if (!$creating) {
        return;
    }

    $source_attachment_id = trim((string) $request->get_header('X-STJI-Source-Attachment-ID'));
    if ('' === $source_attachment_id || !preg_match('/^[a-z0-9_-]{1,128}$/i', $source_attachment_id)) {
        return;
    }

    update_post_meta($attachment->ID, STJI_SOURCE_ATTACHMENT_ID_META, $source_attachment_id);
}
add_action('rest_after_insert_attachment', 'stji_store_source_attachment_id', 10, 3);

/**
 * Restore the collection-level create capability for the ServiceTitan job CPT.
 *
 * Some custom-post-type configurations set create_posts to do_not_allow. The
 * REST posts controller checks that exact capability before accepting a POST.
 * This maps creation to the same capability already used to edit job posts.
 *
 * @param array<string, mixed> $args      Post type registration arguments.
 * @param string               $post_type Post type key.
 * @return array<string, mixed>
 */
function stji_allow_rest_job_creation(array $args, string $post_type): array
{
    /**
     * Filters the post type managed by this integration.
     *
     * @param string $post_type Post type key. Defaults to st_job.
     */
    $service_titan_post_type = (string) apply_filters('stji_post_type', 'st_job');

    if ($post_type !== $service_titan_post_type) {
        return $args;
    }

    $capabilities = isset($args['capabilities']) && is_array($args['capabilities'])
        ? $args['capabilities']
        : array();

    if (!empty($capabilities['edit_posts'])) {
        $edit_posts_capability = (string) $capabilities['edit_posts'];
    } else {
        $capability_type = $args['capability_type'] ?? 'post';
        $plural_type = is_array($capability_type)
            ? (string) ($capability_type[1] ?? 'posts')
            : (string) $capability_type . 's';
        $edit_posts_capability = 'edit_' . $plural_type;
    }

    $capabilities['create_posts'] = $edit_posts_capability;
    $args['capabilities'] = $capabilities;

    $supports = isset($args['supports']) && is_array($args['supports'])
        ? $args['supports']
        : array('title', 'editor');
    if (!in_array('thumbnail', $supports, true)) {
        $supports[] = 'thumbnail';
    }
    if (!in_array('revisions', $supports, true)) {
        $supports[] = 'revisions';
    }
    $args['supports'] = $supports;

    return $args;
}
add_filter('register_post_type_args', 'stji_allow_rest_job_creation', 20, 2);

/**
 * Return the configured ServiceTitan job post type.
 */
function stji_post_type(): string
{
    return (string) apply_filters('stji_post_type', 'st_job');
}

/**
 * Return every post type that can share ZIP-code terms through ACF.
 *
 * Developers can add their own public custom post types with the
 * stji_zip_post_types filter.
 *
 * @return array<int, string>
 */
function stji_zip_post_types(): array
{
    $post_types = (array) apply_filters(
        'stji_zip_post_types',
        array(stji_post_type(), 'page', 'post')
    );

    return array_values(
        array_unique(
            array_filter(
                array_map(
                    static function ($post_type): string {
                        return sanitize_key((string) $post_type);
                    },
                    $post_types
                )
            )
        )
    );
}

/**
 * Register the ServiceTitan job post type when another plugin has not already
 * provided it. Existing registrations are preserved for compatibility.
 */
function stji_register_job_post_type(): void
{
    $post_type = stji_post_type();
    if (post_type_exists($post_type)) {
        return;
    }

    register_post_type(
        $post_type,
        array(
            'labels' => array(
                'name'               => __('ServiceTitan Jobs', 'servicetitan-job-integration'),
                'singular_name'      => __('ServiceTitan Job', 'servicetitan-job-integration'),
                'menu_name'          => __('ServiceTitan Jobs', 'servicetitan-job-integration'),
                'add_new'            => __('Add Job', 'servicetitan-job-integration'),
                'add_new_item'       => __('Add ServiceTitan Job', 'servicetitan-job-integration'),
                'edit_item'          => __('Edit ServiceTitan Job', 'servicetitan-job-integration'),
                'new_item'           => __('New ServiceTitan Job', 'servicetitan-job-integration'),
                'view_item'          => __('View ServiceTitan Job', 'servicetitan-job-integration'),
                'search_items'       => __('Search ServiceTitan Jobs', 'servicetitan-job-integration'),
                'not_found'          => __('No ServiceTitan jobs found.', 'servicetitan-job-integration'),
                'not_found_in_trash' => __('No ServiceTitan jobs found in Trash.', 'servicetitan-job-integration'),
            ),
            'public'              => true,
            'publicly_queryable'  => true,
            'show_ui'             => true,
            'show_in_menu'        => true,
            'show_in_rest'        => true,
            'rest_base'           => 'st-jobs',
            'has_archive'         => 'jobs',
            'rewrite'             => array('slug' => 'jobs'),
            'supports'            => array('title', 'editor', 'excerpt', 'thumbnail', 'revisions'),
            'menu_icon'           => 'dashicons-location-alt',
            'capability_type'     => 'post',
            'map_meta_cap'        => true,
            'delete_with_user'    => false,
        )
    );
}
add_action('init', 'stji_register_job_post_type', 15);

/**
 * Register ZIP codes as an indexed taxonomy for job filtering.
 */
function stji_register_zipcode_taxonomy(): void
{
    register_taxonomy(
        'st_job_zipcode',
        stji_zip_post_types(),
        array(
            'labels' => array(
                'name'          => __('ZIP Codes', 'servicetitan-job-integration'),
                'singular_name' => __('ZIP Code', 'servicetitan-job-integration'),
                'search_items'  => __('Search ZIP Codes', 'servicetitan-job-integration'),
                'all_items'     => __('All ZIP Codes', 'servicetitan-job-integration'),
                'edit_item'     => __('Edit ZIP Code', 'servicetitan-job-integration'),
                'update_item'   => __('Update ZIP Code', 'servicetitan-job-integration'),
                'add_new_item'  => __('Add New ZIP Code', 'servicetitan-job-integration'),
                'new_item_name' => __('New ZIP Code', 'servicetitan-job-integration'),
                'menu_name'     => __('ZIP Codes', 'servicetitan-job-integration'),
            ),
            'hierarchical'      => false,
            'public'            => false,
            'show_ui'           => true,
            'show_admin_column' => true,
            'show_in_rest'      => true,
            'meta_box_cb'       => false,
            'rest_base'         => 'st-job-zipcodes',
            'query_var'         => false,
            'rewrite'           => false,
        )
    );
}
add_action('init', 'stji_register_zipcode_taxonomy', 20);

/**
 * Add location details to the ZIP Codes admin table.
 *
 * @param array<string, string> $columns Existing taxonomy columns.
 * @return array<string, string>
 */
function stji_zipcode_admin_columns(array $columns): array
{
    $updated_columns = array();

    foreach ($columns as $column_name => $label) {
        $updated_columns[$column_name] = $label;
        if ('name' === $column_name) {
            $updated_columns['stji_zip_city'] = __('City', 'servicetitan-job-integration');
            $updated_columns['stji_zip_state'] = __('State', 'servicetitan-job-integration');
        }
    }

    return $updated_columns;
}
add_filter('manage_edit-st_job_zipcode_columns', 'stji_zipcode_admin_columns');

/**
 * Render city and state values stored on each ZIP term.
 */
function stji_zipcode_admin_column(string $content, string $column_name, int $term_id): string
{
    if ('stji_zip_city' === $column_name) {
        $city = trim((string) get_term_meta($term_id, 'stji_zip_city', true));
        return '' !== $city ? esc_html($city) : '&mdash;';
    }

    if ('stji_zip_state' === $column_name) {
        $state = trim((string) get_term_meta($term_id, 'stji_zip_state', true));
        return '' !== $state ? esc_html($state) : '&mdash;';
    }

    return $content;
}
add_filter('manage_st_job_zipcode_custom_column', 'stji_zipcode_admin_column', 10, 3);

/**
 * Keep ZIP term management under ServiceTitan Jobs without duplicating it in
 * the Posts and Pages admin menus.
 */
function stji_hide_zipcode_submenus(): void
{
    global $submenu;

    foreach (array('edit.php', 'edit.php?post_type=page') as $parent_menu) {
        if (empty($submenu[$parent_menu]) || !is_array($submenu[$parent_menu])) {
            continue;
        }
        $submenu[$parent_menu] = array_values(
            array_filter(
                $submenu[$parent_menu],
                static function ($item): bool {
                    $menu_slug = is_array($item) ? (string) ($item[2] ?? '') : '';
                    return false === strpos($menu_slug, 'taxonomy=st_job_zipcode');
                }
            )
        );
    }
}
add_action('admin_menu', 'stji_hide_zipcode_submenus', PHP_INT_MAX);

/**
 * Remove Gutenberg's native taxonomy panel. The ACF taxonomy field remains in
 * the main meta-box area and is the single ZIP relationship editor.
 */
function stji_hide_native_zipcode_editor_panel(): void
{
    $script = <<<'JS'
wp.domReady(function () {
    var editor = wp.data && wp.data.dispatch('core/edit-post');
    if (editor && editor.removeEditorPanel) {
        editor.removeEditorPanel('taxonomy-panel-st_job_zipcode');
    }
});
JS;
    wp_add_inline_script('wp-edit-post', $script, 'after');
}
add_action('enqueue_block_editor_assets', 'stji_hide_native_zipcode_editor_panel');

/**
 * Register the simple ZIP-code field accepted by the Node application.
 */
function stji_register_zipcode_rest_field(): void
{
    register_rest_field(
        stji_post_type(),
        'stji_zipcode',
        array(
            'get_callback'    => 'stji_get_rest_zipcode',
            'update_callback' => 'stji_update_rest_zipcode',
            'schema'          => array(
                'description' => __('Service location ZIP code.', 'servicetitan-job-integration'),
                'type'        => 'string',
                'context'     => array('view', 'edit'),
            ),
        )
    );

    register_rest_field(
        stji_post_type(),
        'stji_location',
        array(
            'get_callback'    => 'stji_get_rest_location',
            'update_callback' => 'stji_update_rest_location',
            'schema'          => array(
                'description' => __('ZIP, city, state, completion date, and ACF field configuration.', 'servicetitan-job-integration'),
                'type'        => 'object',
                'context'     => array('edit'),
            ),
        )
    );

    register_rest_field(
        stji_post_type(),
        'stji_generation',
        array(
            'get_callback'    => 'stji_get_rest_generation',
            'update_callback' => 'stji_update_rest_generation',
            'schema'          => array(
                'description' => __('SEO generation metadata.', 'servicetitan-job-integration'),
                'type'        => 'object',
                'context'     => array('edit'),
                'properties'  => array(
                    'version'     => array('type' => 'integer'),
                    'jobId'       => array('type' => 'integer'),
                    'generatedAt' => array('type' => 'string'),
                ),
            ),
        )
    );
}
add_action('rest_api_init', 'stji_register_zipcode_rest_field');

/**
 * Return the configured ACF field name used on pages and job posts.
 */
function stji_zip_acf_field_name(): string
{
    $field_name = sanitize_key((string) get_option(STJI_ZIP_ACF_FIELD_OPTION, 'my_zip_codes'));
    return preg_match('/^[a-z][a-z0-9_]{0,63}$/', $field_name) ? $field_name : 'my_zip_codes';
}

/**
 * Find an ACF field already registered with the configured name.
 *
 * @return array<string, mixed>|null
 */
function stji_find_acf_field_by_name(string $field_name): ?array
{
    if (!function_exists('acf_get_field_groups') || !function_exists('acf_get_fields')) {
        return null;
    }
    foreach ((array) acf_get_field_groups() as $group) {
        foreach ((array) acf_get_fields($group) as $field) {
            if (is_array($field) && ($field['name'] ?? '') === $field_name) {
                return $field;
            }
        }
    }
    return null;
}

/**
 * Use an existing compatible field key, or the plugin's stable local key.
 */
function stji_zip_acf_field_key(): string
{
    $field = stji_find_acf_field_by_name(stji_zip_acf_field_name());
    return is_array($field) && !empty($field['key']) ? (string) $field['key'] : STJI_ZIP_ACF_FIELD_KEY;
}

/**
 * Register the shared ZIP relationship and ZIP city/state fields in ACF.
 */
function stji_register_acf_fields(): void
{
    if (!function_exists('acf_add_local_field_group')) {
        return;
    }

    $existing_zip_field = stji_find_acf_field_by_name(stji_zip_acf_field_name());
    if (!$existing_zip_field) {
        acf_add_local_field_group(array(
            'key'    => 'group_stji_zip_codes',
            'title'  => __('Service Area ZIP Codes', 'servicetitan-job-integration'),
            'fields' => array(
                array(
                    'key'           => STJI_ZIP_ACF_FIELD_KEY,
                    'label'         => __('ZIP Codes', 'servicetitan-job-integration'),
                    'name'          => stji_zip_acf_field_name(),
                    'type'          => 'taxonomy',
                    'taxonomy'      => 'st_job_zipcode',
                    'field_type'    => 'multi_select',
                    'allow_null'    => 1,
                    'add_term'      => 1,
                    'save_terms'    => 1,
                    'load_terms'    => 1,
                    'return_format' => 'id',
                ),
            ),
            'position' => 'normal',
            'location' => array_map(
                static function (string $post_type): array {
                    return array(array('param' => 'post_type', 'operator' => '==', 'value' => $post_type));
                },
                stji_zip_post_types()
            ),
        ));
    }

    acf_add_local_field_group(
        array(
            'key'    => 'group_stji_zip_place',
            'title'  => __('ZIP Location Data', 'servicetitan-job-integration'),
            'fields' => array(
                array(
                    'key'       => STJI_ZIP_CITY_FIELD_KEY,
                    'label'     => __('City', 'servicetitan-job-integration'),
                    'name'      => 'stji_zip_city',
                    'type'      => 'text',
                    'maxlength' => 100,
                ),
                array(
                    'key'       => STJI_ZIP_STATE_FIELD_KEY,
                    'label'     => __('State', 'servicetitan-job-integration'),
                    'name'      => 'stji_zip_state',
                    'type'      => 'text',
                    'maxlength' => 2,
                ),
                array(
                    'key'       => STJI_ZIP_LATITUDE_FIELD_KEY,
                    'label'     => __('Latitude', 'servicetitan-job-integration'),
                    'name'      => 'stji_zip_latitude',
                    'type'      => 'number',
                    'min'       => -90,
                    'max'       => 90,
                    'step'      => 0.000001,
                ),
                array(
                    'key'       => STJI_ZIP_LONGITUDE_FIELD_KEY,
                    'label'     => __('Longitude', 'servicetitan-job-integration'),
                    'name'      => 'stji_zip_longitude',
                    'type'      => 'number',
                    'min'       => -180,
                    'max'       => 180,
                    'step'      => 0.000001,
                ),
            ),
            'location' => array(
                array(array('param' => 'taxonomy', 'operator' => '==', 'value' => 'st_job_zipcode')),
            ),
        )
    );
}
add_action('acf/init', 'stji_register_acf_fields');

/**
 * Explain the required dependency on older WordPress installations that do not
 * enforce the Requires Plugins header.
 */
function stji_acf_dependency_notice(): void
{
    if (function_exists('acf_add_local_field_group')) {
        return;
    }

    echo '<div class="notice notice-error"><p>'
        . esc_html__('ServiceTitan Job Integration requires Advanced Custom Fields to manage ZIP-code relationships.', 'servicetitan-job-integration')
        . '</p></div>';
}
add_action('admin_notices', 'stji_acf_dependency_notice');

/**
 * Warn when an existing configured field cannot represent ZIP terms.
 */
function stji_acf_field_compatibility_notice(): void
{
    if (!function_exists('acf_get_field_groups')) {
        return;
    }
    $field = stji_find_acf_field_by_name(stji_zip_acf_field_name());
    if (!$field || ('taxonomy' === ($field['type'] ?? '') && 'st_job_zipcode' === ($field['taxonomy'] ?? ''))) {
        return;
    }
    echo '<div class="notice notice-error"><p>'
        . esc_html(sprintf(
            __('The ACF field “%s” already exists but is not a ZIP Codes taxonomy field. Rename or remove it before using ServiceTitan ZIP relationships.', 'servicetitan-job-integration'),
            stji_zip_acf_field_name()
        ))
        . '</p></div>';
}
add_action('admin_notices', 'stji_acf_field_compatibility_notice');

/**
 * Expose non-sensitive compatibility status for onboarding checks.
 */
function stji_register_status_route(): void
{
    register_rest_route(
        'servicetitan-job-integration/v1',
        '/status',
        array(
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'stji_rest_status',
            // This endpoint returns only the installed integration version and
            // post type name so onboarding can confirm installation before the
            // site owner has created an Application Password.
            'permission_callback' => '__return_true',
        )
    );
    register_rest_route(
        'servicetitan-job-integration/v1',
        '/statuses',
        array(
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => 'stji_rest_bulk_statuses',
            'permission_callback' => static function (): bool {
                return current_user_can('edit_posts') || current_user_can('edit_st_jobs');
            },
        )
    );
    register_rest_route(
        'servicetitan-job-integration/v1',
        '/zipcodes',
        array(
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => 'stji_rest_zipcodes',
                'permission_callback' => static function (): bool {
                    return current_user_can('edit_posts') || current_user_can('edit_st_jobs');
                },
            ),
            array(
                'methods'             => WP_REST_Server::CREATABLE,
                'callback'            => 'stji_rest_update_zipcodes',
                'permission_callback' => static function (): bool {
                    return current_user_can('edit_posts') || current_user_can('edit_st_jobs');
                },
            ),
        )
    );
}
add_action('rest_api_init', 'stji_register_status_route');

/**
 * Return companion-plugin compatibility information.
 */
function stji_rest_status(): WP_REST_Response
{
    return new WP_REST_Response(
        array(
            'plugin'   => 'servicetitan-job-integration',
            'version'  => STJI_VERSION,
            'postType' => stji_post_type(),
        ),
        200
    );
}

/**
 * List ZIP terms and their reusable city/state metadata for app-side syncing.
 */
function stji_rest_zipcodes(): WP_REST_Response
{
    $terms = get_terms(array('taxonomy' => 'st_job_zipcode', 'hide_empty' => false));
    $zipcodes = array();
    if (!is_wp_error($terms)) {
        foreach ($terms as $term) {
            $zipcodes[] = array(
                'zipcode' => $term->name,
                'city'    => (string) get_term_meta($term->term_id, 'stji_zip_city', true),
                'state'   => (string) get_term_meta($term->term_id, 'stji_zip_state', true),
                'latitude'  => stji_get_zip_coordinate($term->term_id, 'stji_zip_latitude'),
                'longitude' => stji_get_zip_coordinate($term->term_id, 'stji_zip_longitude'),
            );
        }
    }
    return new WP_REST_Response(array('acfFieldName' => stji_zip_acf_field_name(), 'zipcodes' => $zipcodes), 200);
}

/**
 * Apply app configuration and city/state enrichment to shared ZIP terms.
 *
 * @return WP_REST_Response|WP_Error
 */
function stji_rest_update_zipcodes(WP_REST_Request $request)
{
    $field_name = sanitize_key((string) $request->get_param('acfFieldName'));
    if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/', $field_name)) {
        return new WP_Error('stji_invalid_acf_field', __('The ZIP ACF field name is invalid.', 'servicetitan-job-integration'), array('status' => 400));
    }
    update_option(STJI_ZIP_ACF_FIELD_OPTION, $field_name, false);

    $places = $request->get_param('zipcodes');
    $places = is_array($places) ? array_slice($places, 0, 1000) : array();
    $term_ids = stji_ensure_zip_places($places);
    if (is_wp_error($term_ids)) {
        return $term_ids;
    }
    return new WP_REST_Response(array('acfFieldName' => $field_name, 'updated' => count($term_ids)), 200);
}

/**
 * Resolve multiple ServiceTitan job slugs with one WordPress query.
 *
 * @param WP_REST_Request $request REST request.
 * @return WP_REST_Response|WP_Error
 */
function stji_rest_bulk_statuses(WP_REST_Request $request)
{
    $requested_ids = $request->get_param('jobIds');
    if (!is_array($requested_ids) || empty($requested_ids) || count($requested_ids) > 50) {
        return new WP_Error(
            'stji_invalid_job_ids',
            __('jobIds must contain between 1 and 50 jobs.', 'servicetitan-job-integration'),
            array('status' => 400)
        );
    }

    $job_ids = array();
    foreach ($requested_ids as $requested_id) {
        $job_id = absint($requested_id);
        if ($job_id < 1 || (string) $job_id !== (string) $requested_id || in_array($job_id, $job_ids, true)) {
            return new WP_Error(
                'stji_invalid_job_id',
                __('Every jobId must be a unique positive integer.', 'servicetitan-job-integration'),
                array('status' => 400)
            );
        }
        $job_ids[] = $job_id;
    }

    $job_id_by_slug = array();
    $statuses = array();
    foreach ($job_ids as $job_id) {
        $slug = 'servicetitan-job-' . $job_id;
        $job_id_by_slug[$slug] = $job_id;
        $statuses[(string) $job_id] = array(
            'state' => 'not_found',
            'label' => __('None', 'servicetitan-job-integration'),
        );
    }

    $posts_query = new WP_Query(
        array(
            'post_type'              => stji_post_type(),
            'post_status'            => get_post_stati(array(), 'names'),
            'post_name__in'          => array_keys($job_id_by_slug),
            'posts_per_page'         => count($job_ids),
            'no_found_rows'           => true,
            'update_post_meta_cache' => true,
            'update_post_term_cache' => false,
        )
    );

    foreach ($posts_query->posts as $post) {
        if (!isset($job_id_by_slug[$post->post_name])) {
            continue;
        }
        $job_id = $job_id_by_slug[$post->post_name];
        $status_object = get_post_status_object($post->post_status);
        $link = get_permalink($post);
        $seo_version = absint(get_post_meta($post->ID, STJI_SEO_VERSION_META, true));
        $generated_hash = (string) get_post_meta($post->ID, STJI_GENERATED_HASH_META, true);
        $generated_at = (string) get_post_meta($post->ID, STJI_GENERATED_AT_META, true);
        $featured_image_id = get_post_thumbnail_id($post->ID);
        $featured_image_path = $featured_image_id ? get_attached_file($featured_image_id) : false;
        $source_attachment_id = $featured_image_id
            ? (string) get_post_meta($featured_image_id, STJI_SOURCE_ATTACHMENT_ID_META, true)
            : '';
        $statuses[(string) $job_id] = array(
            'state'      => 'exists',
            'label'      => $status_object ? $status_object->label : ucwords(str_replace(array('-', '_'), ' ', $post->post_status)),
            'postId'     => $post->ID,
            'postStatus' => $post->post_status,
            'link'       => is_string($link) ? $link : '',
            'postTitle'  => $post->post_title,
            'postExcerpt' => $post->post_excerpt,
            'seoVersion' => $seo_version,
            'seoModified' => '' !== $generated_hash && !hash_equals($generated_hash, stji_generated_content_hash($post)),
            'generatedAt' => $generated_at,
            'featuredImageId' => $featured_image_id,
            'featuredImageFileName' => is_string($featured_image_path) ? wp_basename($featured_image_path) : '',
            'featuredImageAttachmentId' => $source_attachment_id,
        );
    }

    return new WP_REST_Response(array('statuses' => $statuses), 200);
}

/**
 * Get a job's assigned ZIP code for REST responses.
 *
 * @param array<string, mixed> $post REST post data.
 */
function stji_get_rest_zipcode(array $post): string
{
    $post_id = isset($post['id']) ? (int) $post['id'] : 0;
    $terms = $post_id ? wp_get_object_terms($post_id, 'st_job_zipcode', array('fields' => 'names')) : array();

    return !is_wp_error($terms) && !empty($terms) ? (string) $terms[0] : '';
}

/**
 * Return the shared ZIP relationships and place metadata for REST edit requests.
 *
 * @param array<string, mixed> $post REST post data.
 * @return array<string, mixed>
 */
function stji_get_rest_location(array $post): array
{
    $post_id = isset($post['id']) ? (int) $post['id'] : 0;
    $terms = $post_id ? wp_get_object_terms($post_id, 'st_job_zipcode') : array();
    $zipcodes = array();
    if (!is_wp_error($terms)) {
        foreach ($terms as $term) {
            $zipcodes[] = array(
                'zipcode' => $term->name,
                'city'    => (string) get_term_meta($term->term_id, 'stji_zip_city', true),
                'state'   => (string) get_term_meta($term->term_id, 'stji_zip_state', true),
                'latitude'  => stji_get_zip_coordinate($term->term_id, 'stji_zip_latitude'),
                'longitude' => stji_get_zip_coordinate($term->term_id, 'stji_zip_longitude'),
            );
        }
    }

    return array(
        'acfFieldName' => stji_zip_acf_field_name(),
        'zipcodes'     => $zipcodes,
        'completedOn'  => $post_id ? (string) get_post_meta($post_id, STJI_COMPLETED_ON_META, true) : '',
    );
}

/**
 * Return private SEO generation metadata to authenticated edit-context requests.
 *
 * @param array<string, mixed> $post REST post data.
 * @return array<string, mixed>
 */
function stji_get_rest_generation(array $post): array
{
    $post_id = isset($post['id']) ? (int) $post['id'] : 0;
    return array(
        'version'     => $post_id ? absint(get_post_meta($post_id, STJI_SEO_VERSION_META, true)) : 0,
        'jobId'       => $post_id ? absint(get_post_meta($post_id, STJI_JOB_ID_META, true)) : 0,
        'generatedAt' => $post_id ? (string) get_post_meta($post_id, STJI_GENERATED_AT_META, true) : '',
    );
}

/**
 * Store the generator version and a fingerprint of the generated post fields.
 *
 * @param mixed   $value Generation metadata from the Node application.
 * @param WP_Post $post  Created or updated post.
 * @return true|WP_Error
 */
function stji_update_rest_generation($value, WP_Post $post)
{
    if (!is_array($value)) {
        return new WP_Error('stji_invalid_generation', __('Generation metadata must be an object.', 'servicetitan-job-integration'), array('status' => 400));
    }

    $version = isset($value['version']) ? absint($value['version']) : 0;
    $job_id = isset($value['jobId']) ? absint($value['jobId']) : 0;
    if ($version < 1 || $job_id < 1) {
        return new WP_Error('stji_invalid_generation', __('Generation version and jobId must be positive integers.', 'servicetitan-job-integration'), array('status' => 400));
    }

    $stored_post = get_post($post->ID);
    if (!$stored_post instanceof WP_Post) {
        return new WP_Error('stji_post_not_found', __('The generated post could not be loaded.', 'servicetitan-job-integration'), array('status' => 404));
    }

    update_post_meta($post->ID, STJI_SEO_VERSION_META, $version);
    update_post_meta($post->ID, STJI_JOB_ID_META, $job_id);
    update_post_meta($post->ID, STJI_GENERATED_HASH_META, stji_generated_content_hash($stored_post));
    update_post_meta($post->ID, STJI_GENERATED_AT_META, gmdate('c'));
    return true;
}

/**
 * Fingerprint only fields owned by the SEO generator.
 */
function stji_generated_content_hash(WP_Post $post): string
{
    return hash('sha256', $post->post_title . "\0" . $post->post_excerpt . "\0" . $post->post_content);
}

/**
 * Assign a ZIP-code taxonomy term from a REST create or update request.
 *
 * @param mixed   $value ZIP-code value.
 * @param WP_Post $post  Updated post.
 * @return true|WP_Error
 */
function stji_update_rest_zipcode($value, WP_Post $post)
{
    $zipcode = stji_normalize_zipcode((string) $value);
    if ('' === $zipcode && '' !== trim((string) $value)) {
        return new WP_Error(
            'stji_invalid_zipcode',
            __('ZIP code must use 12345 or 12345-6789 format.', 'servicetitan-job-integration'),
            array('status' => 400)
        );
    }

    return stji_assign_zip_places(
        $post->ID,
        '' === $zipcode ? array() : array(array('zipcode' => $zipcode, 'city' => '', 'state' => ''))
    );
}

/**
 * Store location data sent by the app and synchronize the shared ACF field.
 *
 * @param mixed   $value Location data from the Node application.
 * @param WP_Post $post  Created or updated job post.
 * @return true|WP_Error
 */
function stji_update_rest_location($value, WP_Post $post)
{
    if (!is_array($value)) {
        return new WP_Error('stji_invalid_location', __('Location data must be an object.', 'servicetitan-job-integration'), array('status' => 400));
    }

    $field_name = sanitize_key((string) ($value['acfFieldName'] ?? ''));
    if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/', $field_name)) {
        return new WP_Error('stji_invalid_acf_field', __('The ZIP ACF field name is invalid.', 'servicetitan-job-integration'), array('status' => 400));
    }
    update_option(STJI_ZIP_ACF_FIELD_OPTION, $field_name, false);

    $places = isset($value['zipcodes']) && is_array($value['zipcodes']) ? array_slice($value['zipcodes'], 0, 20) : array();
    $result = stji_assign_zip_places($post->ID, $places);
    if (is_wp_error($result)) {
        return $result;
    }

    $completed_on = sanitize_text_field((string) ($value['completedOn'] ?? ''));
    if ('' !== $completed_on) {
        $timestamp = strtotime($completed_on);
        if (false === $timestamp) {
            return new WP_Error('stji_invalid_completion_date', __('The completion date is invalid.', 'servicetitan-job-integration'), array('status' => 400));
        }
        update_post_meta($post->ID, STJI_COMPLETED_ON_META, gmdate('c', $timestamp));
    }

    return true;
}

/**
 * Create missing ZIP terms, enrich their place metadata, and assign them.
 *
 * @param array<int, mixed> $places ZIP place records.
 * @return true|WP_Error
 */
function stji_assign_zip_places(int $post_id, array $places)
{
    $term_ids = stji_ensure_zip_places($places);
    if (is_wp_error($term_ids)) {
        return $term_ids;
    }

    $assigned = wp_set_object_terms($post_id, $term_ids, 'st_job_zipcode', false);
    if (is_wp_error($assigned)) {
        return $assigned;
    }
    stji_store_zip_acf_value($post_id, $term_ids);
    return true;
}

/**
 * Ensure ZIP terms exist and update their city/state metadata.
 *
 * @param array<int, mixed> $places ZIP place records.
 * @return array<int, int>|WP_Error
 */
function stji_ensure_zip_places(array $places)
{
    $term_ids = array();
    foreach ($places as $place) {
        if (!is_array($place)) {
            continue;
        }
        $zipcode = stji_normalize_zipcode((string) ($place['zipcode'] ?? ''));
        if ('' === $zipcode) {
            return new WP_Error('stji_invalid_zipcode', __('ZIP code must use 12345 or 12345-6789 format.', 'servicetitan-job-integration'), array('status' => 400));
        }

        $existing = term_exists($zipcode, 'st_job_zipcode');
        if (!$existing) {
            $existing = wp_insert_term($zipcode, 'st_job_zipcode', array('slug' => $zipcode));
        }
        if (is_wp_error($existing)) {
            return $existing;
        }
        $term_id = (int) (is_array($existing) ? $existing['term_id'] : $existing);
        $term_ids[] = $term_id;

        $city = sanitize_text_field((string) ($place['city'] ?? ''));
        $state = strtoupper(sanitize_text_field((string) ($place['state'] ?? '')));
        if ('' !== $city) {
            update_term_meta($term_id, 'stji_zip_city', substr($city, 0, 100));
            update_term_meta($term_id, '_' . 'stji_zip_city', STJI_ZIP_CITY_FIELD_KEY);
        }
        if (preg_match('/^[A-Z]{2}$/', $state)) {
            update_term_meta($term_id, 'stji_zip_state', $state);
            update_term_meta($term_id, '_' . 'stji_zip_state', STJI_ZIP_STATE_FIELD_KEY);
        }
        $latitude = stji_normalize_coordinate($place['latitude'] ?? null, -90, 90);
        $longitude = stji_normalize_coordinate($place['longitude'] ?? null, -180, 180);
        if (null !== $latitude && null !== $longitude) {
            update_term_meta($term_id, 'stji_zip_latitude', $latitude);
            update_term_meta($term_id, '_' . 'stji_zip_latitude', STJI_ZIP_LATITUDE_FIELD_KEY);
            update_term_meta($term_id, 'stji_zip_longitude', $longitude);
            update_term_meta($term_id, '_' . 'stji_zip_longitude', STJI_ZIP_LONGITUDE_FIELD_KEY);
        }
    }

    return array_values(array_unique($term_ids));
}

/**
 * Return a validated coordinate from ZIP term metadata.
 */
function stji_get_zip_coordinate(int $term_id, string $meta_key): ?float
{
    $limits = 'stji_zip_latitude' === $meta_key ? array(-90, 90) : array(-180, 180);
    return stji_normalize_coordinate(get_term_meta($term_id, $meta_key, true), $limits[0], $limits[1]);
}

/**
 * Normalize an external coordinate without accepting booleans or empty values.
 *
 * @param mixed $value Coordinate candidate.
 */
function stji_normalize_coordinate($value, float $minimum, float $maximum): ?float
{
    if (is_bool($value) || (is_string($value) && '' === trim($value)) || !is_numeric($value)) {
        return null;
    }
    $coordinate = (float) $value;
    return is_finite($coordinate) && $coordinate >= $minimum && $coordinate <= $maximum ? $coordinate : null;
}

/**
 * Store the ACF taxonomy value by its configurable name and stable field key.
 */
function stji_store_zip_acf_value(int $post_id, array $term_ids): void
{
    $field_name = stji_zip_acf_field_name();
    update_post_meta($post_id, $field_name, array_values(array_unique(array_map('intval', $term_ids))));
    update_post_meta($post_id, '_' . $field_name, stji_zip_acf_field_key());
}

/**
 * Normalize a US ZIP or ZIP+4 value.
 */
function stji_normalize_zipcode(string $value): string
{
    $zipcode = trim(sanitize_text_field($value));
    return preg_match('/^\d{5}(?:-\d{4})?$/', $zipcode) ? $zipcode : '';
}

/**
 * Render a shortcode-configured list of published ServiceTitan jobs.
 *
 * Usage: [servicetitan_jobs] or
 * [servicetitan_jobs zipcodes="07001,07002" offset="1" limit="10" page_size="2"]
 *
 * @param array<string, mixed> $attributes Shortcode attributes.
 */
function stji_render_jobs_shortcode(array $attributes = array()): string
{
    $attributes = shortcode_atts(
        array(
            'zipcodes'       => '',
            'posts_per_page' => 20,
            'page_size'      => '',
            'offset'         => 0,
            'limit'          => 0,
        ),
        $attributes,
        'servicetitan_jobs'
    );

    $zipcodes = stji_parse_zipcodes((string) $attributes['zipcodes']);
    $legacy_page_size = min(100, max(1, absint($attributes['posts_per_page'])));
    $page_size = '' === trim((string) $attributes['page_size'])
        ? $legacy_page_size
        : min(100, max(1, absint($attributes['page_size'])));
    $offset = max(0, (int) $attributes['offset']);
    $limit = max(0, (int) $attributes['limit']);
    $page = isset($_GET['stji_page']) ? max(1, absint(wp_unslash($_GET['stji_page']))) : 1; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    $items_before_page = ($page - 1) * $page_size;
    $remaining_limit = $limit > 0 ? max(0, $limit - $items_before_page) : $page_size;
    $query_page_size = min($page_size, $remaining_limit);

    if (0 === $query_page_size) {
        return stji_render_empty_jobs();
    }

    $query_args = array(
        'post_type'           => stji_post_type(),
        'post_status'         => 'publish',
        'posts_per_page'      => $query_page_size,
        'offset'              => $offset + $items_before_page,
        'ignore_sticky_posts' => true,
    );

    if (!empty($zipcodes)) {
        $query_args['tax_query'] = array(
            array(
                'taxonomy' => 'st_job_zipcode',
                'field'    => 'slug',
                'terms'    => $zipcodes,
                'operator' => 'IN',
            ),
        );
    }

    $jobs = new WP_Query($query_args);

    if (!$jobs->have_posts()) {
        wp_reset_postdata();

        return stji_render_empty_jobs();
    }

    $available_jobs = max(0, (int) $jobs->found_posts - $offset);
    $limited_jobs = $limit > 0 ? min($available_jobs, $limit) : $available_jobs;
    $total_pages = (int) ceil($limited_jobs / $page_size);

    wp_enqueue_style(
        'stji-jobs',
        plugins_url('assets/jobs.css', __FILE__),
        array(),
        STJI_VERSION
    );

    ob_start();
    ?>
    <section class="stji-jobs" aria-label="<?php esc_attr_e('Service jobs', 'servicetitan-job-integration'); ?>">
        <div class="stji-jobs__results" aria-live="polite">
            <?php while ($jobs->have_posts()) : $jobs->the_post(); ?>
                <?php $job_image_id = stji_get_job_image_id(get_the_ID()); ?>
                <article class="stji-job">
                    <div class="stji-job__body">
                        <?php if ($job_image_id) : ?>
                            <a class="stji-job__image-link" href="<?php the_permalink(); ?>" aria-label="<?php echo esc_attr(sprintf(__('View project: %s', 'servicetitan-job-integration'), get_the_title())); ?>">
                                <?php echo wp_get_attachment_image($job_image_id, 'large', false, array('class' => 'stji-job__image', 'loading' => 'lazy', 'decoding' => 'async')); ?>
                            </a>
                        <?php endif; ?>
                        <h3 class="stji-job__title"><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h3>
                        <div class="stji-job__excerpt"><?php the_excerpt(); ?></div>
                    </div>
                </article>
            <?php endwhile; ?>
        </div>

        <?php stji_render_pagination($total_pages, $page); ?>
    </section>
    <?php
    wp_reset_postdata();
    return (string) ob_get_clean();
}
add_shortcode('servicetitan_jobs', 'stji_render_jobs_shortcode');

/**
 * Return the featured image, or the first attached image for legacy posts.
 */
function stji_get_job_image_id(int $post_id): int
{
    $featured_image_id = (int) get_post_thumbnail_id($post_id);
    if ($featured_image_id > 0) {
        return $featured_image_id;
    }

    $attached_images = get_children(
        array(
            'post_parent'    => $post_id,
            'post_type'      => 'attachment',
            'post_mime_type' => 'image',
            'numberposts'    => 1,
            'orderby'        => 'menu_order ID',
            'order'          => 'ASC',
            'fields'         => 'ids',
        )
    );

    return empty($attached_images) ? 0 : (int) reset($attached_images);
}

/**
 * Build a privacy-conscious approximate Google Maps embed from the ZIP term.
 */
function stji_get_job_map_url(int $post_id): string
{
    $zipcodes = wp_get_object_terms($post_id, 'st_job_zipcode', array('fields' => 'names'));
    if (is_wp_error($zipcodes) || empty($zipcodes)) {
        return '';
    }

    $zipcode = stji_normalize_zipcode((string) reset($zipcodes));
    if ('' === $zipcode) {
        return '';
    }

    return add_query_arg(
        array(
            'q'      => $zipcode . ', USA',
            'z'      => 15,
            'output' => 'embed',
            'iwloc'  => 0,
        ),
        'https://www.google.com/maps'
    );
}

/**
 * Return published city pages whose ACF ZIP field contains the job ZIP code.
 *
 * The shared ACF Taxonomy field stores ZIP term relationships on Posts, Pages,
 * ServiceTitan jobs, and any filtered custom post types.
 *
 * @return array<int, WP_Post>
 */
function stji_get_job_city_pages(int $post_id): array
{
    $zipcodes = wp_get_object_terms($post_id, 'st_job_zipcode', array('fields' => 'names'));
    if (is_wp_error($zipcodes) || empty($zipcodes)) {
        return array();
    }

    $normalized_zipcodes = array();
    foreach ($zipcodes as $value) {
        $zipcode = stji_normalize_zipcode((string) $value);
        if ('' !== $zipcode) {
            $normalized_zipcodes[] = $zipcode;
        }
    }
    if (empty($normalized_zipcodes)) {
        return array();
    }

    $pages = get_posts(
        array(
            'post_type'        => 'page',
            'post_status'      => 'publish',
            'posts_per_page'   => -1,
            'orderby'          => 'title',
            'order'            => 'ASC',
            'tax_query'        => array(
                array(
                    'taxonomy' => 'st_job_zipcode',
                    'field'    => 'name',
                    'terms'    => $normalized_zipcodes,
                    'operator' => 'IN',
                ),
            ),
            'suppress_filters' => false,
        )
    );

    return (array) apply_filters('stji_job_city_pages', $pages, $post_id, $zipcodes);
}

/**
 * Return the city stored on each job ZIP term and its matching city Page.
 *
 * @return array<int, array{name: string, url: string}>
 */
function stji_get_job_project_areas(int $post_id): array
{
    $terms = wp_get_object_terms(
        $post_id,
        'st_job_zipcode',
        array('orderby' => 'name', 'order' => 'ASC')
    );
    if (is_wp_error($terms) || empty($terms)) {
        return array();
    }

    $city_pages = stji_get_job_city_pages($post_id);
    $areas = array();

    foreach ($terms as $term) {
        if (!$term instanceof WP_Term) {
            continue;
        }
        $city = trim((string) get_term_meta($term->term_id, 'stji_zip_city', true));
        if ('' === $city) {
            continue;
        }

        $matching_page = null;
        foreach ($city_pages as $city_page) {
            if (!has_term($term->term_id, 'st_job_zipcode', $city_page)) {
                continue;
            }
            if (null === $matching_page) {
                $matching_page = $city_page;
            }
            if (0 === strcasecmp(trim(wp_strip_all_tags(get_the_title($city_page))), $city)) {
                $matching_page = $city_page;
                break;
            }
        }

        $key = strtolower($city);
        $url = $matching_page instanceof WP_Post ? (string) get_permalink($matching_page) : '';
        if (!isset($areas[$key]) || ('' === $areas[$key]['url'] && '' !== $url)) {
            $areas[$key] = array('name' => $city, 'url' => $url);
        }
    }

    return array_values($areas);
}

/**
 * Migrate legacy string-based ACF values and existing job terms once.
 */
function stji_migrate_zip_relationships(): void
{
    if (!function_exists('acf_add_local_field_group') || !taxonomy_exists('st_job_zipcode')) {
        return;
    }
    if ('1' === get_option('stji_zip_relationships_migrated_1_12_0')) {
        return;
    }

    $field_name = stji_zip_acf_field_name();
    $post_ids = get_posts(
        array(
            'post_type'      => stji_zip_post_types(),
            'post_status'    => 'any',
            'posts_per_page' => -1,
            'fields'         => 'ids',
        )
    );

    foreach ($post_ids as $post_id) {
        $term_ids = wp_get_object_terms((int) $post_id, 'st_job_zipcode', array('fields' => 'ids'));
        $term_ids = is_wp_error($term_ids) ? array() : array_map('intval', $term_ids);
        $legacy_values = get_post_meta((int) $post_id, $field_name, true);
        $legacy_values = is_array($legacy_values) ? $legacy_values : array($legacy_values);
        foreach ($legacy_values as $legacy_value) {
            $zipcode = stji_normalize_zipcode((string) $legacy_value);
            if ('' === $zipcode) {
                continue;
            }
            $term = term_exists($zipcode, 'st_job_zipcode');
            if (!$term) {
                $term = wp_insert_term($zipcode, 'st_job_zipcode', array('slug' => $zipcode));
            }
            if (!is_wp_error($term)) {
                $term_ids[] = (int) (is_array($term) ? $term['term_id'] : $term);
            }
        }
        $term_ids = array_values(array_unique($term_ids));
        if (!empty($term_ids)) {
            wp_set_object_terms((int) $post_id, $term_ids, 'st_job_zipcode', false);
            stji_store_zip_acf_value((int) $post_id, $term_ids);
        }
    }

    update_option('stji_zip_relationships_migrated_1_12_0', '1', false);
}
add_action('init', 'stji_migrate_zip_relationships', 30);

/**
 * Add the ZIP term's city before, and the approximate map after, job content.
 */
function stji_render_job_detail_content(string $content): string
{
    if (!is_singular(stji_post_type()) || !in_the_loop() || !is_main_query()) {
        return $content;
    }

    $post_id = get_the_ID();
    $project_areas = stji_get_job_project_areas($post_id);
    $metadata = '';

    if (!empty($project_areas)) {
        $areas = array();
        foreach ($project_areas as $project_area) {
            $city = esc_html($project_area['name']);
            $areas[] = '' !== $project_area['url']
                ? '<a href="' . esc_url($project_area['url']) . '">' . $city . '</a>'
                : $city;
        }

        $metadata = '<span class="stji-job-detail__area"><strong>'
            . esc_html__('Project Area:', 'servicetitan-job-integration')
            . '</strong> '
            . implode(', ', $areas)
            . '</span>';
    }

    $completed_on = (string) get_post_meta($post_id, STJI_COMPLETED_ON_META, true);
    if ('' !== $completed_on && false !== strtotime($completed_on)) {
        $metadata .= '<span class="stji-job-detail__completed"><strong>'
            . esc_html__('Completed:', 'servicetitan-job-integration')
            . '</strong> '
            . esc_html(wp_date(get_option('date_format'), (int) strtotime($completed_on)))
            . '</span>';
    }
    if ('' !== $metadata) {
        $metadata = '<p class="stji-job-detail__meta">' . $metadata . '</p>';
    }

    $map_url = stji_get_job_map_url($post_id);
    $map = '';
    if ('' !== $map_url) {
        $map = '<section class="stji-job-detail__location" aria-labelledby="stji-job-location-heading">'
            . '<h2 id="stji-job-location-heading">' . esc_html__('Approximate Project Location', 'servicetitan-job-integration') . '</h2>'
            . '<div class="stji-job-detail__map"><iframe title="'
            . esc_attr(sprintf(__('Approximate location for %s', 'servicetitan-job-integration'), get_the_title($post_id)))
            . '" src="' . esc_url($map_url)
            . '" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>'
            . '</section>';
    }

    return $metadata . $content . $map;
}
add_filter('the_content', 'stji_render_job_detail_content', 20);

/**
 * Load the shared card/detail styles on single job pages.
 */
function stji_enqueue_job_detail_styles(): void
{
    if (!is_singular(stji_post_type())) {
        return;
    }

    wp_enqueue_style(
        'stji-jobs',
        plugins_url('assets/jobs.css', __FILE__),
        array(),
        STJI_VERSION
    );
}
add_action('wp_enqueue_scripts', 'stji_enqueue_job_detail_styles');

/**
 * Register rewrite rules immediately when the plugin is activated.
 */
function stji_activate(): void
{
    if (!function_exists('acf_add_local_field_group')) {
        if (!function_exists('deactivate_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die(
            esc_html__('ServiceTitan Job Integration requires the Advanced Custom Fields plugin to be installed and active.', 'servicetitan-job-integration'),
            esc_html__('Plugin dependency missing', 'servicetitan-job-integration'),
            array('back_link' => true)
        );
    }
    stji_register_job_post_type();
    stji_register_zipcode_taxonomy();
    flush_rewrite_rules();
}
register_activation_hook(__FILE__, 'stji_activate');

/**
 * Remove the plugin's rewrite rules from WordPress's cached rules.
 */
function stji_deactivate(): void
{
    flush_rewrite_rules();
}
register_deactivation_hook(__FILE__, 'stji_deactivate');

/**
 * Render shortcode pagination.
 */
function stji_render_pagination(int $total_pages, int $page): void
{
    if ($total_pages < 2) {
        return;
    }

    $links = paginate_links(
        array(
            'base'      => esc_url_raw(add_query_arg('stji_page', '%#%')),
            'format'    => '',
            'current'   => $page,
            'total'     => $total_pages,
            'type'      => 'list',
            'prev_text' => __('Previous', 'servicetitan-job-integration'),
            'next_text' => __('Next', 'servicetitan-job-integration'),
        )
    );

    if ($links) {
        echo '<nav class="stji-pagination" aria-label="' . esc_attr__('Job pages', 'servicetitan-job-integration') . '">' . wp_kses_post($links) . '</nav>';
    }
}

/**
 * Hide empty shortcode results from visitors while helping administrators.
 */
function stji_render_empty_jobs(): string
{
    if (!current_user_can('manage_options')) {
        return '';
    }

    return '<p class="stji-jobs__empty">'
        . esc_html__('No Service Titan jobs found', 'servicetitan-job-integration')
        . '</p>';
}

/**
 * Normalize a comma-separated string or array of ZIP codes.
 *
 * @param string|array<int, mixed> $values ZIP-code values.
 * @return array<int, string>
 */
function stji_parse_zipcodes($values): array
{
    $values = is_array($values) ? $values : explode(',', (string) $values);
    $zipcodes = array();

    foreach ($values as $value) {
        $zipcode = stji_normalize_zipcode((string) $value);
        if ('' !== $zipcode) {
            $zipcodes[] = $zipcode;
        }
    }

    return array_values(array_unique($zipcodes));
}
