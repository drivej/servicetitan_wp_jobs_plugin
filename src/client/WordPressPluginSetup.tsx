import { isSaaSWorkspace } from './api';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';

const pluginFilename = 'servicetitan-job-integration-1.18.0.zip';
const pluginDownload = `/downloads/${pluginFilename}`;

export function WordPressPluginSetup() {
  const saas = isSaaSWorkspace();
  const { status, loading, refresh, ready } = useWordPressPluginStatus();
  return (
    <main className="plugin-page">

      <header className="plugin-page-hero">
        <p className="eyebrow">One-time WordPress setup</p>
        <h1>Companion plugin</h1>
        <p className="intro">Install the plugin and connect your site with a WordPress Application Password so the app can verify the plugin version and publish jobs.</p>
      </header>

      <section className={`plugin-install-card plugin-install-card-${status?.state || 'checking'}`}>
        <div className="plugin-version-status" aria-live="polite">
          <span className="plugin-version-icon" aria-hidden="true">{loading ? '…' : ready ? '✓' : '!'}</span>
          <div>
            <p className="eyebrow">Compatibility status</p>
            <h2>{loading ? 'Checking WordPress…' : ready ? 'Plugin is current' : status?.state === 'update_required' ? 'Plugin update required' : 'Could not verify plugin'}</h2>
            {!loading && status && (
              <p>
                {status.installedVersion ? `Installed: ${status.installedVersion}. ` : ''}
                Required: {status.requiredVersion}.
                {status.message ? ` ${status.message}` : ''}
              </p>
            )}
          </div>
        </div>

        <div className="plugin-install-actions">
          <a className="download-button account-primary-link" href={pluginDownload} download={pluginFilename}>
            <DownloadIcon /> Download version 1.18.0
          </a>
          <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
        </div>
      </section>

      <section className="plugin-instructions">
        <h2>Install or update</h2>
        <ol>
          <li>Download the ZIP above. Do not extract it.</li>
          <li>In WordPress, open <strong>Plugins → Add New Plugin → Upload Plugin</strong>.</li>
          <li>Upload <code>{pluginFilename}</code>.</li>
          <li>For an update, choose <strong>Replace current with uploaded</strong>.</li>
          <li>Activate the plugin, then configure an Application Password using the steps below.</li>
        </ol>
        <p>The Jobs tab enables WordPress actions only after the installed plugin reports a compatible version.</p>
      </section>

      <section className="plugin-instructions">
        <h2>Connect with an Application Password</h2>
        <p>Installing the plugin is only the first step. The app also needs your WordPress username and a generated <strong>Application Password</strong> to check the installed version and publish jobs. Your regular WordPress login password is not the credential to enter here.</p>
        <ol>
          <li>In WordPress, open <strong>Users → Profile</strong> for the user you want the app to connect as. Use a dedicated integration user with permission to edit and publish job posts and upload media.</li>
          <li>Find <strong>Application Passwords</strong>, enter <strong>ServiceTitan Jobs</strong> as the name, and select <strong>Add New Application Password</strong>.</li>
          <li>Copy the generated password immediately; WordPress shows it only once.</li>
          <li>{saas ? <>Open <a href="/account">Settings</a>, edit the matching website, and save that user’s WordPress username and Application Password.</> : <>Set <code>WORDPRESS_USERNAME</code> and <code>WORDPRESS_APPLICATION_PASSWORD</code> in your local server configuration, then restart the app.</>}</li>
          <li>Return to this page and select <strong>Check again</strong>.</li>
        </ol>
        <p>If Application Passwords is missing, confirm your site uses HTTPS and ask your WordPress administrator or host whether a security setting has disabled the feature.</p>
        <p>If you see <strong>“Sorry, you are not allowed to do that”</strong>, check the username, Application Password, and user permissions. A security plugin or hosting rule may also be blocking access. This message alone does not mean the companion plugin needs an update.</p>
      </section>
    </main>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
