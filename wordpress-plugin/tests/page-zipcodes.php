<?php
// Run with: php wordpress-plugin/tests/page-zipcodes.php
define('ABSPATH', __DIR__);
function add_action(...$args) {}
function add_filter(...$args) {}
function apply_filters($name, $value, ...$args) { return $value; }
function add_shortcode(...$args) {}
function register_activation_hook(...$args) {}
function register_deactivation_hook(...$args) {}
function sanitize_key($value) { return $value; }
function sanitize_text_field($value) { return trim($value); }
function acf_get_field_groups() { return [ ['key' => 'test'] ]; }
function acf_get_fields($group) { return $GLOBALS['acf_fields'] ?? []; }
function update_post_meta($id, $key, $value) { $GLOBALS['meta'][$id][$key] = $value; }
function get_option($name, $default = false) { return $default; }
function get_post_ancestors($id) { return [20, 30]; }
function get_post_meta($id, $key, $single) { return $GLOBALS['meta'][$id] ?? ''; }
class WP_Term { public $name; function __construct($name) { $this->name = $name; } }
function get_term($id, $taxonomy) { return isset($GLOBALS['terms'][$id]) ? new WP_Term($GLOBALS['terms'][$id]) : null; }
function shortcode_atts($defaults, $attributes, $tag) { return array_merge($defaults, $attributes); }
function get_the_ID() { return 10; }
function absint($value) { return abs((int) $value); }
function wp_reset_postdata() {}
function current_user_can($cap) { return false; }
class WP_Query {
    function __construct($args) { $GLOBALS['query'] = $args; }
    function have_posts() { return false; }
}
require dirname(__DIR__) . '/servicetitan-job-integration/servicetitan-job-integration.php';
function check($actual, $expected) {
    if ($actual !== $expected) { throw new RuntimeException(var_export([$actual, $expected], true)); }
}
$GLOBALS['terms'] = [1 => '07001', 2 => '07002', 3 => '07003'];
$GLOBALS['meta'] = [10 => ['1', '2', '999'], 20 => ['2', '3'], 30 => '07003,07004'];
check(stji_get_page_zipcodes(10), ['07001', '07002', '07003', '07004']);
check(stji_get_page_zipcodes(10, false), ['07001', '07002']);
check(stji_get_page_zipcodes(0), []);
stji_render_jobs_shortcode();
check($GLOBALS['query']['tax_query'][0]['terms'], ['07001', '07002', '07003', '07004']);
stji_render_jobs_shortcode(['zipcodes' => ' ', 'inherit_zipcodes' => 'false']);
check($GLOBALS['query']['tax_query'][0]['terms'], ['07001', '07002']);
stji_render_jobs_shortcode(['zipcodes' => '90210,90210']);
check($GLOBALS['query']['tax_query'][0]['terms'], ['90210']);
$GLOBALS['meta'] = [];
unset($GLOBALS['query']);
check(stji_render_jobs_shortcode(), '');
check(isset($GLOBALS['query']), false);
check(stji_render_jobs_shortcode(['zipcodes' => 'invalid']), '');
check(isset($GLOBALS['query']), false);
// Disabling inheritance must not fall back to ancestor ZIPs.
$GLOBALS['meta'] = [20 => ['1']];
check(stji_render_jobs_shortcode(['inherit_zipcodes' => 'false']), '');
check(isset($GLOBALS['query']), false);
$GLOBALS['acf_fields'] = [['name' => 'my_zip_codes', 'key' => 'field_existing', 'type' => 'textarea']];
$GLOBALS['meta'] = [10 => "07001, 07002\n07003;07001", 20 => '07004'];
check(stji_get_page_zipcodes(10), ['07001', '07002', '07003', '07004']);
ob_start();
stji_acf_field_compatibility_notice();
check(ob_get_clean(), '');
stji_store_zip_acf_value(40, [1, 2]);
check($GLOBALS['meta'][40]['my_zip_codes'], '07001, 07002');
check($GLOBALS['meta'][40]['_my_zip_codes'], 'field_existing');
foreach (['checkbox', 'select'] as $type) {
    $GLOBALS['acf_fields'] = [['name' => 'my_zip_codes', 'key' => 'field_existing', 'type' => $type, 'multiple' => 1]];
    // Five-digit numeric strings are ZIPs, not term IDs.
    $GLOBALS['meta'] = [10 => ['07001', '07002'], 20 => ['07002', '07003']];
    check(stji_get_page_zipcodes(10), ['07001', '07002', '07003']);
    ob_start();
    stji_acf_field_compatibility_notice();
    check(ob_get_clean(), '');
    stji_store_zip_acf_value(40, [1, 2]);
    check($GLOBALS['meta'][40]['my_zip_codes'], ['07001', '07002']);
}
$GLOBALS['acf_fields'][0]['multiple'] = 0;
$GLOBALS['meta'] = [10 => '07001'];
check(stji_get_page_zipcodes(10, false), ['07001']);
stji_store_zip_acf_value(40, [1]);
check($GLOBALS['meta'][40]['my_zip_codes'], '07001');
echo "Page ZIP shortcode checks passed.\n";
