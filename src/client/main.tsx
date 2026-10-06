import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { Workspace } from './Workspace';

import { App } from './App';
import { JobDetails } from './JobDetails';
import { WordPressIntegrationGuide } from './WordPressIntegrationGuide';
import { WordPressPluginSetup } from './WordPressPluginSetup';
import { MarketingPage } from './MarketingPage';
import { BillingPlans } from './BillingPlans';
import './styles.css';
import { useWordPressPluginStatus, WordPressPluginStatusProvider } from './useWordPressPluginStatus';

const path = window.location.pathname.replace(/\/$/, '') || '/';
const jobDetailsMatch = path.match(/^\/jobs\/(\d+)$/);
const helpTopicMatch = path.match(/^\/help\/(wordpress|servicetitan|onboarding|plugin)-([a-z-]+)$/);
const page = helpTopicMatch
  ? <WordPressIntegrationGuide topic={`${helpTopicMatch[1]}-${helpTopicMatch[2]}`} />
  : path === '/help'
  ? <WordPressIntegrationGuide />
  : path === '/landing'
    ? <MarketingPage />
  : path === '/pricing'
    ? <main className='account-page'><PageHeaderFallback /><BillingPlans workspaceId='current' /></main>
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
    <ThemeProvider theme={theme}>
    <CssBaseline />
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
          <Button component="a" href="/wordpress-plugin" variant="contained">Open plugin setup</Button>
        </aside>
      )}
    </div>
    </ThemeProvider>
  );
}

function PageHeaderFallback() {
  return <header className='account-page-hero'><p className='eyebrow'>Choose a plan</p><h1>Pricing</h1><p>Select a subscription to continue to setup.</p></header>;
}

const theme = createTheme({
  palette: { mode: 'light', primary: { main: '#186d4c', dark: '#11593d' }, background: { default: '#f1f0ea', paper: '#fcfcf8' }, text: { primary: '#17201c', secondary: '#536159' } },
  shape: { borderRadius: 9 },
  typography: { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', button: { fontWeight: 700, textTransform: 'none' } },
  components: { MuiButton: { defaultProps: { variant: 'outlined', size: 'small' } } },
});
