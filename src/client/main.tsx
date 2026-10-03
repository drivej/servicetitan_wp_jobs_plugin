import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from './Workspace';

import { App } from './App';
import { JobDetails } from './JobDetails';
import { WordPressIntegrationGuide } from './WordPressIntegrationGuide';
import { WordPressPluginSetup } from './WordPressPluginSetup';
import './styles.css';
import { useWordPressPluginStatus, WordPressPluginStatusProvider } from './useWordPressPluginStatus';

const path = window.location.pathname.replace(/\/$/, '') || '/';
const jobDetailsMatch = path.match(/^\/jobs\/(\d+)$/);
const page = path === '/wordpress-integration'
  ? <WordPressIntegrationGuide />
  : path === '/wordpress-plugin'
    ? <WordPressPluginSetup />
    : jobDetailsMatch
      ? <JobDetails jobId={Number(jobDetailsMatch[1])} />
      : <App />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace><WordPressPluginStatusProvider>
      <AppShell>{page}</AppShell>
    </WordPressPluginStatusProvider></Workspace>
  </StrictMode>,
);

function AppShell({ children }: { children: ReactNode }) {
  const { status } = useWordPressPluginStatus();
  const updateRequired = status?.state === 'update_required';

  return (
    <div className={`app-shell${updateRequired ? ' has-plugin-violator' : ''}`}>
      {children}
      {updateRequired && (
        <aside className="plugin-update-violator" role="alert" aria-label="WordPress plugin update required">
          <div className="plugin-update-violator-icon" aria-hidden="true">!</div>
          <div className="plugin-update-violator-copy">
            <span>Action required</span>
            <strong>Update the WordPress companion plugin</strong>
            <p>
              {status.installedVersion ? `Installed ${status.installedVersion}; ` : ''}
              version {status.requiredVersion} is required. WordPress actions are disabled.
            </p>
          </div>
          <a href="/wordpress-plugin">Open plugin setup</a>
        </aside>
      )}
    </div>
  );
}
