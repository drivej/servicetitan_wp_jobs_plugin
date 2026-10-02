import { isSaaSWorkspace } from './api';

export function WordPressIntegrationGuide() {
  const saas = isSaaSWorkspace();
  return (
    <main className="guide-page">

      <header className="guide-hero">
        <p className="eyebrow">Integration guide</p>
        <h1>Connect your WordPress site</h1>
        <p className="intro">Install the companion plugin, authorize the ServiceTitan Jobs app, and publish a ZIP-targeted job directory on any WordPress page.</p>
        <a className="guide-setup-link" href="/wordpress-plugin">Open WordPress plugin setup</a>
      </header>

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
            {saas ? <p>Open <a href="/account">Settings</a>, add your website under the correct ServiceTitan connection, and enter the WordPress username and Application Password. The default REST base is <code>st-jobs</code>. Save, select that website, and check its connection in the WordPress plugin tab.</p> : <>
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
