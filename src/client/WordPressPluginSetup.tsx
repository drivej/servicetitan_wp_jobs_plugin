import { AppNavigation } from './AppNavigation';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';

const pluginFilename = 'servicetitan-job-integration-1.18.0.zip';
const pluginDownload = `/downloads/${pluginFilename}`;

export function WordPressPluginSetup() {
  const { status, loading, refresh, ready } = useWordPressPluginStatus();
  return (
    <main className="plugin-page">
      <AppNavigation current="plugin" />

      <header className="plugin-page-hero">
        <p className="eyebrow">One-time WordPress setup</p>
        <h1>Companion plugin</h1>
        <p className="intro">Install this plugin once, then return here only when the app reports that an update is required.</p>
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
          <li>Activate the plugin, return here, and select <strong>Check again</strong>.</li>
        </ol>
        <p>The Jobs tab enables WordPress actions only after the installed plugin reports a compatible version.</p>
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
