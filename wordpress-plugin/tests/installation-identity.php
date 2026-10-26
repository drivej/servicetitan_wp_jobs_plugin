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
function get_option($name, $default = false) { return $GLOBALS['options'][$GLOBALS['blog']][$name] ?? $default; }
function get_post_ancestors($id) { return [20, 30]; }
function get_post_meta($id, $key, $single) { return $GLOBALS['meta'][$id] ?? ''; }
class WP_Term { public $name; function __construct($name) { $this->name = $name; } }
function get_term($id, $taxonomy) { return isset($GLOBALS['terms'][$id]) ? new WP_Term($GLOBALS['terms'][$id]) : null; }
function shortcode_atts($defaults, $attributes, $tag) { return array_merge($defaults, $attributes); }
function get_the_ID() { return 10; }
function absint($value) { return abs((int) $value); }
function wp_reset_postdata() {}
function current_user_can($cap) { return $cap === 'manage_options' && ($GLOBALS['admin'] ?? false); }
class WP_Query {
    function __construct($args) { $GLOBALS['query'] = $args; }
    function have_posts() { return false; }
}

function add_option($name, $value, ...$args) {
    if (isset($GLOBALS['options'][$GLOBALS['blog']][$name])) return false;
    $GLOBALS['options'][$GLOBALS['blog']][$name] = $value;
    return true;
}
function wp_generate_uuid4() { return 'generated-id-' . ++$GLOBALS['generated']; }
function home_url() { return 'https://example.com/site-' . $GLOBALS['blog'] . '/'; }
function untrailingslashit($value) { return rtrim($value, '/'); }
function register_rest_route($namespace, $path, $definition) { $GLOBALS['routes'][$path] = $definition; }
class WP_REST_Server { const READABLE = 'GET'; const CREATABLE = 'POST'; }
class WP_REST_Response {
    public $data; public $headers = [];
    function __construct($data, $status) { $this->data = $data; }
    function header($key, $value) { $this->headers[$key] = $value; }
}
require dirname(__DIR__) . '/servicetitan-job-integration/servicetitan-job-integration.php';
function check($actual, $expected) { if ($actual !== $expected) throw new RuntimeException(var_export([$actual, $expected], true)); }
$GLOBALS['blog'] = 1; $GLOBALS['generated'] = 0;
stji_register_status_route();
$permission = $GLOBALS['routes']['/identity']['permission_callback'];
check($permission(), false);
$GLOBALS['admin'] = true;
check($permission(), true);
$first = stji_rest_identity();
check($first->data['canonicalUrl'], 'https://example.com/site-1');
check($first->headers['Cache-Control'], 'private, no-store');
check(stji_rest_identity()->data['installationId'], $first->data['installationId']);
check($GLOBALS['generated'], 1);
$GLOBALS['blog'] = 2;
$second = stji_rest_identity();
check($second->data['canonicalUrl'], 'https://example.com/site-2');
check($second->data['installationId'] === $first->data['installationId'], false);
check(array_key_exists('installationId', stji_rest_status()->data), false);
echo "Installation identity tests passed\n";
