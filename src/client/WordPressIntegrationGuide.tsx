import { Button } from '@mui/material';
import { isSaaSWorkspace } from './api';
import { PageHeader } from './PageHeader';

export function WordPressIntegrationGuide({ topic }: { topic?: string } = {}) {
  const saas = isSaaSWorkspace();
  const topics: Record<string, { title: string; body: string; service: string }> = {
    'wordpress-credentials': { title: 'WordPress credentials were rejected', service: 'WordPress', body: 'Use the WordPress account login name and a generated Application Password from Users → Profile. Do not use the normal account password. Regenerate the Application Password if it may have been copied incorrectly, then save it in Settings and test the connection again.' },
    'wordpress-rest-api': { title: 'WordPress REST API route was not found', service: 'WordPress', body: 'Check that the site URL points to the WordPress installation, the ServiceTitan Job Integration plugin is active, and permalinks are enabled. Open Settings → Permalinks and save once. The custom post route normally uses /wp-json/wp/v2/st-jobs. If WordPress is installed in a subdirectory, include that path in the site URL.' },
    'wordpress-reachability': { title: 'The WordPress site could not be reached', service: 'WordPress', body: 'The site must be reachable by the app server over public HTTPS. Confirm the URL opens without a login wall or browser challenge and the TLS certificate is valid. Ask your host to allow inbound HTTPS requests to /wp-json/ through CDN, WAF, bot protection, security plugins, and firewall rules. Keep API authentication enabled.' },
    'wordpress-permissions': { title: 'The WordPress user lacks publishing permissions', service: 'WordPress', body: 'Use a dedicated user that can create and edit the ServiceTitan Jobs post type and upload media. Confirm the companion plugin is active and the account is not restricted by a role editor or security plugin. Use the generated Application Password for this user.' },
    'servicetitan-credentials': { title: 'ServiceTitan API credentials were rejected', service: 'ServiceTitan', body: 'Confirm Client ID, Client Secret, and App Key belong to the same ServiceTitan application and environment. Copy the current secret and app key carefully. If a secret was rotated, enter all updated credentials in Settings, save, and test again.' },
    'servicetitan-permissions': { title: 'ServiceTitan Jobs permission is missing', service: 'ServiceTitan', body: 'Open the application’s ServiceTitan permissions or scopes settings and grant read access to Job Management jobs (JPM Jobs). Save the permission change and allow it to propagate, then test the connection again. Production access may require approval for your ServiceTitan account.' },
    'servicetitan-tenant': { title: 'ServiceTitan tenant or environment does not match', service: 'ServiceTitan', body: 'The tenant ID must belong to the account associated with these API credentials. Select Integration for sandbox credentials and Production for live credentials. Check the tenant ID in ServiceTitan and make sure the application is enabled in that environment.' },
  };
  const selectedTopic = topic ? topics[topic] : undefined;
  if (topic) return <main className="guide-page"><PageHeader className="guide-hero" eyebrow={`${selectedTopic?.service || 'Connection'} help`} title={selectedTopic?.title || 'Connection issue'} description={selectedTopic?.body || 'This help topic was not found.'} actions={<Button component="a" variant="contained" href="/settings">Return to setup</Button>} /><article className="guide-content"><p>{selectedTopic?.body}</p><p>After applying the fix, return to Settings and select <strong>Test Connection</strong>. The next onboarding step becomes available once the test succeeds.</p><p><a href="/help">Browse all help topics</a></p></article></main>;
  return (
    <main className="guide-page">

      <PageHeader className='guide-hero' eyebrow='ServiceTitan Jobs' title='Connect your WordPress site' description='Install the companion plugin, authorize the ServiceTitan Jobs app, and publish a ZIP-targeted job directory on any WordPress page.' actions={<Button component="a" variant="contained" href="/wordpress-plugin" className="guide-setup-link">Open WordPress plugin setup</Button>} />

      <div className="guide-layout">
        <aside className="guide-toc">
          <strong>On this page</strong>
          <a href="#requirements">Requirements</a>
          <a href="#install-plugin">Install the plugin</a>
          <a href="#credentials">Create credentials</a>
          <a href="#configure-app">Configure the app</a>
          <a href="#publish">Push jobs</a>
          <a href="#job-page">Create the jobs page</a>
          <a href="#existing-posts">Existing posts</a>
          <a href="#troubleshooting">Troubleshooting</a>
          <a href="/help/wordpress-credentials">WordPress credentials</a>
          <a href="/help/wordpress-permissions">WordPress permissions</a>
          <a href="/help/wordpress-rest-api">WordPress REST API</a>
          <a href="/help/wordpress-reachability">WordPress reachability</a>
          <a href="/help/servicetitan-credentials">ServiceTitan credentials</a>
          <a href="/help/servicetitan-permissions">ServiceTitan permissions</a>
          <a href="/help/servicetitan-tenant">ServiceTitan tenant and environment</a>
          <a href="#report-bug">Report a bug</a>
        </aside>

        <article className="guide-content">
          <section className="guide-callout">
            <h2>What the integration does</h2>
            <p>The app reads jobs from ServiceTitan and creates correlated WordPress <code>st_job</code> posts. The plugin registers the job post type, enables REST creation, assigns each service ZIP code to an indexed taxonomy, and provides the <code>[servicetitan_jobs]</code> page shortcode.</p>
            <p>The plugin never stores your ServiceTitan credentials or WordPress Application Password.</p>
          </section>

          <section id="requirements">
            <p className="guide-step">Before you begin</p>
            <h2>Requirements</h2>
            <ul>
              <li>A WordPress administrator account.</li>
              <li>HTTPS on the public WordPress site.</li>
              <li>Permission to install plugins and create Application Passwords.</li>
              <li>Advanced Custom Fields installed and active.</li>
              <li>Access to your ServiceTitan Jobs account settings.</li>
            </ul>
          </section>

          <section id="install-plugin">
            <p className="guide-step">Step 1</p>
            <h2>Install the companion plugin</h2>
            <ol>
              <li>Install and activate <strong>Advanced Custom Fields</strong> if it is not already active.</li>
              <li>Open the app’s <a href="/wordpress-plugin">WordPress plugin tab</a> and download the plugin ZIP. Do not extract it.</li>
              <li>In WordPress, open <strong>Plugins → Add New Plugin → Upload Plugin</strong>.</li>
              <li>Select <code>servicetitan-job-integration-1.18.0.zip</code>, then choose <strong>Install Now</strong>.</li>
              <li>Activate <strong>ServiceTitan Job Integration</strong>.</li>
            </ol>
            <p>Activation requires Advanced Custom Fields and creates the ServiceTitan Jobs post type, REST endpoint, shared ZIP ACF fields, ZIP-code taxonomy, and page shortcode automatically. For an update, upload the newer ZIP and choose <strong>Replace current with uploaded</strong>.</p>
          </section>

          <section id="credentials">
            <p className="guide-step">Step 2</p>
            <h2>Create a WordPress integration user</h2>
            <ol>
              <li>Create or select a dedicated WordPress user. Use a dedicated integration user with permission to edit/publish job posts and upload media.</li>
              <li>Open <strong>Users → Profile</strong> for that user.</li>
              <li>Under <strong>Application Passwords</strong>, enter a label such as <em>ServiceTitan Jobs</em>.</li>
              <li>Choose <strong>Add New Application Password</strong> and copy the generated password immediately.</li>
            </ol>
            <div className="guide-note"><strong>Important:</strong> Use the generated Application Password in the app—not the user’s normal WordPress login password.</div>
          </section>

          <section id="configure-app">
            <p className="guide-step">Step 3</p>
            <h2>Configure the ServiceTitan Jobs app</h2>
            {saas ? <p>Open <a href="/settings">Settings</a>, add your website under the correct ServiceTitan connection, and enter the WordPress username and Application Password. The default REST base is <code>st-jobs</code>. Save, select that website, and check its connection in the WordPress plugin tab.</p> : <>
            <p>Add these server-side environment variables locally or in the Sevalla/Kinsta application settings:</p>
            <pre><code>{`WORDPRESS_URL=https://www.example.com
WORDPRESS_USERNAME=servicetitan-integration
WORDPRESS_APPLICATION_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
WORDPRESS_POST_TYPE_REST_BASE=st-jobs
WORDPRESS_POST_STATUS=draft
WORDPRESS_ZIP_ACF_FIELD_NAME=my_zip_codes
ZIP_LOOKUP_API_URL=https://api.zippopotam.us`}</code></pre>
            <dl className="guide-definitions">
              <div><dt><code>WORDPRESS_URL</code></dt><dd>The WordPress site root, without <code>/wp-admin</code> or <code>/wp-json</code>.</dd></div>
              <div><dt><code>WORDPRESS_USERNAME</code></dt><dd>The integration user’s login name.</dd></div>
              <div><dt><code>WORDPRESS_APPLICATION_PASSWORD</code></dt><dd>The generated Application Password. Spaces are accepted.</dd></div>
              <div><dt><code>WORDPRESS_POST_TYPE_REST_BASE</code></dt><dd>The post type’s REST base. This setup uses <code>st-jobs</code>.</dd></div>
              <div><dt><code>WORDPRESS_POST_STATUS</code></dt><dd>The initial status assigned during Push. Use <code>draft</code> for editorial review or <code>publish</code> for immediate display.</dd></div>
              <div><dt><code>WORDPRESS_ZIP_ACF_FIELD_NAME</code></dt><dd>The shared ACF Taxonomy field registered on Posts, Pages, and ServiceTitan jobs. It defaults to <code>my_zip_codes</code>.</dd></div>
              <div><dt><code>ZIP_LOOKUP_API_URL</code></dt><dd>Optional. Defaults to Zippopotam.us, which requires no API key. Change it only for a compatible proxy or mirror.</dd></div>
            </dl>
            <p>Restart or redeploy the app after changing environment variables.</p>
            </>}
          </section>

          <section id="publish">
            <p className="guide-step">Step 4</p>
            <h2>Verify and push a job</h2>
            <ol>
              <li>Open the <a href="/">Jobs workspace</a> and select a date range.</li>
              <li>On a job row, select the refresh icon beside <strong>WP post status</strong>.</li>
              <li>Confirm the status changes from <strong>Unknown</strong> to <strong>None</strong>.</li>
              <li>To check every job on the current page at once, select <strong>Refresh page statuses</strong> above the table.</li>
              <li>Open <strong>Details</strong>, generate and review the complete copy, choose one image, then select <strong>Push</strong>.</li>
              <li>Use the row’s status selector to change the WordPress post between <strong>Draft</strong> and <strong>Published</strong> when needed.</li>
              <li>Open WordPress and verify the new job post, its status, and its ZIP Codes assignment.</li>
            </ol>
            <p>Public post copy may use the normalized service name, city, state, ZIP code, controlled service categories, and approved educational text. Street addresses, unit numbers, raw ServiceTitan notes, customer details, job numbers, and operational status are not displayed.</p>
            <p>Every job uses a stable slug based on its ServiceTitan ID, such as <code>servicetitan-job-123456</code>. The app checks this correlation before creating a post.</p>
          </section>

          <section id="job-page">
            <p className="guide-step">Step 5</p>
            <h2>Create a jobs page</h2>
            <ol>
              <li>In WordPress, open <strong>Pages → Add New Page</strong>.</li>
              <li>Add a Shortcode block.</li>
              <li>Enter <code>[servicetitan_jobs]</code>.</li>
              <li>Publish the page.</li>
            </ol>
            <p>The page displays published job posts as cards containing the featured image, title, and excerpt. ZIP filtering is configured only in the shortcode; visitors never see or change ZIP-code controls. A job matching any ZIP code listed in the shortcode is displayed.</p>
            <p>Advanced Custom Fields is required. The plugin creates a shared multi-select ZIP taxonomy field named <code>my_zip_codes</code> by default on Posts, Pages, and ServiceTitan jobs. Manage the shared records under <strong>Posts → ZIP Codes</strong> or <strong>ServiceTitan Jobs → ZIP Codes</strong>. Single job pages display an approximate map plus linked <strong>Project Area</strong> and <strong>Completed</strong> metadata. Assign one or more ZIP terms to a city page to make it eligible as the Project Area destination.</p>

            <h3>Shortcode options</h3>
            <div className="code-examples">
              <div><span>All published jobs, 20 per page</span><code>[servicetitan_jobs]</code></div>
              <div><span>Configure several ZIP codes</span><code>[servicetitan_jobs zipcodes="78701,78702,78703"]</code></div>
              <div><span>Skip one, cap results at ten, and show two per page</span><code>[servicetitan_jobs zipcodes="07001,07002" offset="1" limit="10" page_size="2"]</code></div>
              <div><span>Show jobs from a fixed ZIP-code list</span><code>[servicetitan_jobs zipcodes="78701,78702"]</code></div>
            </div>
            <p><code>offset</code> skips jobs once at the beginning, <code>limit</code> caps the total results across all pages, and <code>page_size</code> controls how many jobs appear on each page. The older <code>posts_per_page</code> option is still supported when <code>page_size</code> is omitted.</p>
            <div className="guide-note"><strong>Visibility:</strong> Draft and private jobs do not appear in the shortcode. Change the row selector to <strong>Published</strong>, publish them in WordPress, or set <code>WORDPRESS_POST_STATUS=publish</code> for future pushes.</div>
          </section>

          <section id="existing-posts">
            <p className="guide-step">Existing content</p>
            <h2>Assign ZIP codes to older job posts</h2>
            <p>Jobs pushed before plugin version 1.1.0 do not receive taxonomy data automatically. Edit each existing job in WordPress, choose or add its value in the <strong>ZIP Codes</strong> panel, and update the post. Newly pushed jobs are assigned automatically.</p>
          </section>

          <section id="troubleshooting">
            <p className="guide-step">Reference</p>
            <h2>Troubleshooting</h2>
            <div className="troubleshooting-list">
              <details><summary>“Sorry, you are not allowed to create posts as this user.”</summary><p>Confirm the companion plugin is active and the integration user can edit and publish <code>st_job</code> posts. Refresh the app status after correcting permissions.</p></details>
              <details><summary>“Incompatible Archive” during plugin upload</summary><p>Restart the ServiceTitan Jobs app, download the current ZIP again, and upload it without extracting or recompressing it. Delete older copies from the browser’s Downloads folder to avoid selecting the wrong file.</p></details>
              <details><summary>The WordPress status stays “Unknown”</summary><p>Verify the site URL, username, Application Password, HTTPS certificate, and REST base. The collection URL should resemble <code>https://www.example.com/wp-json/wp/v2/st-jobs</code>.</p></details>
              <details><summary>A pushed job does not appear on the jobs page</summary><p>Confirm the post is published. If it is an older post, assign a ZIP Codes term manually. Also check whether the page shortcode includes that job’s ZIP code.</p></details>
              <details><summary>The Push button is disabled</summary><p>Select the row’s refresh icon first. Push is enabled only after WordPress confirms the correlated post does not already exist.</p></details>
            </div>
          </section>

          <section id="st-troubleshooting">
            <p className="guide-step">Connection help</p>
            <h2>ServiceTitan connection problems</h2>
            <div className="troubleshooting-list">
              <details id="st-credentials"><summary>ServiceTitan rejects the client credentials</summary><p>Confirm the Client ID and Client Secret belong to the same ServiceTitan application and that the app key is copied without extra characters. Re-enter all credentials if you rotated the secret. The secret is not shown after saving.</p></details>
              <details id="st-permissions"><summary>The app authenticates but does not have Jobs access</summary><p>In ServiceTitan, open the application’s permission or scopes configuration and grant read access to Job Management jobs (the JPM Jobs scope). Save the app configuration, then wait for changes to propagate before validating again. This app only checks read access during setup.</p></details>
              <details id="st-tenant"><summary>Tenant ID or environment does not match</summary><p>Use the tenant ID for the same ServiceTitan account as the app credentials. Select Integration for sandbox credentials and Production for live credentials. Production access may need to be enabled by ServiceTitan for your account.</p></details>
            </div>
          </section>

          <section id="wp-troubleshooting">
            <p className="guide-step">Connection help</p>
            <h2>WordPress REST API problems</h2>
            <p>The WordPress API must be reachable by the ServiceTitan Jobs server over public HTTPS. In a browser, check that <code>https://your-site.example/wp-json/</code> returns JSON. A login page, firewall block, or hosting “coming soon” page means the API is not reachable yet.</p>
            <div className="troubleshooting-list">
              <details id="wp-credentials"><summary>WordPress says the username or password is invalid</summary><p>Enter the WordPress login name and a generated Application Password from Users → Profile. Do not use the normal account password. Ensure this user can edit the ServiceTitan Jobs post type.</p></details>
              <details id="wp-rest-api"><summary>The REST API or companion status route returns 404</summary><p>Confirm WordPress is installed at the saved site URL, permalinks are enabled (Settings → Permalinks → Save Changes), and the ServiceTitan Job Integration plugin is active. The route should be under <code>/wp-json/wp/v2/st-jobs</code>; if your WordPress installation is in a subdirectory, include that path in the site URL.</p></details>
              <details id="wp-reachability"><summary>The site cannot be reached or returns a firewall/challenge page</summary><p>Allow inbound HTTPS requests from the app’s server at your hosting provider. Disable bot challenges or Basic Auth for <code>/wp-json/</code> and allow authenticated REST API requests through your CDN, WAF, security plugin, and host firewall. Do not expose wp-admin or disable authentication; only the REST API needs to be reachable.</p></details>
              <details><summary>Application Passwords are missing</summary><p>Use HTTPS, check that the WordPress user is not blocked from application passwords by a plugin or policy, and ask your host or administrator to enable WordPress Application Passwords.</p></details>
              <details><summary>The API returns 401 or 403</summary><p>Regenerate the Application Password, verify the exact username, and ensure the integration user can edit and publish the custom job post type. Security plugins can block Application Password authentication; allow it for this account and the REST API.</p></details>
            </div>
          </section>

          <section id="report-bug">
            <h2>Report a bug</h2>
            <p>Please describe the problem you were having and what you were doing when it happened.</p>
          </section>

          <section className="guide-callout security-callout">
            <h2>Security checklist</h2>
            <ul>
              <li>Use a dedicated integration user and Application Password.</li>
              <li>Keep WordPress and the companion plugin updated.</li>
              <li>Use HTTPS outside local development.</li>
              <li>Store credentials through Settings, or in server environment variables for local mode.</li>
              <li>Revoke the Application Password immediately if it is exposed.</li>
            </ul>
          </section>
        </article>
      </div>
    </main>
  );
}
