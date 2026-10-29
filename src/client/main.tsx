import { JobScannerGuide } from './JobScannerGuide';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { Workspace } from './Workspace';

import { App } from './App';
import { JobDetails } from './JobDetails';
import { JobScanner } from './JobScanner';
import { WordPressJobs } from './WordPressJobs';
import { WordPressIntegrationGuide } from './WordPressIntegrationGuide';
import { WordPressPluginSetup } from './WordPressPluginSetup';
import { MarketingPage } from './MarketingPage';
import { BillingPlans } from './BillingPlans';
import { PageHeader } from './PageHeader';
import './styles.css';
import { useWordPressPluginStatus, WordPressPluginStatusProvider } from './useWordPressPluginStatus';
import packageJson from '../../package.json';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import { apiFetch } from './api';
import { navigateTo } from './navigation';

const path = window.location.pathname.replace(/\/$/, '') || '/';
const jobDetailsMatch = path.match(/^\/jobs\/(\d+)$/);
const helpTopicMatch = path.match(/^\/help\/(wordpress|servicetitan|onboarding|plugin)-([a-z-]+)$/);
const page = path === '/help/job-scanner' ? <JobScannerGuide /> : helpTopicMatch
  ? <WordPressIntegrationGuide topic={`${helpTopicMatch[1]}-${helpTopicMatch[2]}`} />
  : path === '/help'
  ? <WordPressIntegrationGuide />
  : path === '/landing'
    ? <MarketingPage />
  : path === '/pricing'
    ? <main className='app-page'><PageHeaderFallback /><BillingPlans workspaceId='current' /></main>
  : path === '/wordpress-plugin'
    ? <WordPressPluginSetup />
  : path === '/team'
    ? <WelcomePage />
  : path === '/invite'
    ? <WelcomePage />
  : path === '/job-scanner'
    ? <JobScanner />
  : path === '/previous-scans'
    ? <App initialView='history' />
  : path === '/wordpress-jobs'
    ? <WordPressJobs />
  : jobDetailsMatch
      ? <JobDetails jobId={Number(jobDetailsMatch[1])} />
      : path === '/jobs'
        ? <App />
        : <WelcomePage />;

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
      <footer className="app-footer">
        <span>v{packageJson.version}</span>
        <span>© {new Date().getFullYear()} Contento Interactive Group, LLC.</span>
      </footer>
    </div>
    </ThemeProvider>
  );
}

function PageHeaderFallback() {
  return <header ><p className='eyebrow'>Choose a plan</p><h1>Pricing</h1><p>Select a subscription to continue to setup.</p></header>;
}

function WelcomePage() {
  const [postCount, setPostCount] = useState<number>();
  const [countLoading, setCountLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/wordpress/summary', { signal: controller.signal }).then(async (response) => {
      const body = await response.json() as { postCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to load the WordPress post count.');
      if (Number.isSafeInteger(body.postCount)) setPostCount(body.postCount);
    }).catch(() => { if (!controller.signal.aborted) setPostCount(undefined); })
      .finally(() => { if (!controller.signal.aborted) setCountLoading(false); });
    return () => controller.abort();
  }, []);

  return (
    <main className='app-page'>
      <PageHeader
        eyebrow='Your workspace'
        title='Welcome to Job Showcase for ServiceTitan'
        description='Browse the latest ServiceTitan jobs and choose one to work on.'
      />
      {(countLoading || postCount !== 0) && <section className='home-overview panel' aria-label='WordPress overview'>
        <div><span className='eyebrow'>WORDPRESS</span><h2>{countLoading ? 'Loading…' : postCount ?? 'Unavailable'}</h2><p>Recent Jobs posts on your WordPress website</p></div>
        <div className='home-overview-actions'>
          <Button component='a' href='/jobs' variant='outlined'>Browse jobs</Button>
          <Button component='a' href='/job-scanner' variant='contained' startIcon={<AutoAwesomeRoundedIcon aria-hidden='true' />}>AI Job Scanner</Button>
        </div>
      </section>}
      {!countLoading && postCount === 0 && <section className='home-scanner-promo' aria-labelledby='home-scanner-promo-title'>
        <div className='home-scanner-promo-copy'>
          <span className='eyebrow'>A SIMPLE WAY TO GET STARTED</span>
          <h2 id='home-scanner-promo-title'>Turn completed jobs into WordPress drafts</h2>
          <p>AI Job Scanner finds promising jobs and prepares drafts for your review. Choose a ZIP code and draft count, start a scan, then review the drafts before publishing.</p>
        </div>
        <Button component='a' href='/job-scanner' variant='contained' size='large' startIcon={<AutoAwesomeRoundedIcon aria-hidden='true' />}>Open AI Job Scanner</Button>
      </section>}
    </main>
  );
}

const theme = createTheme({
  palette: { mode: 'light', primary: { main: '#186d4c', dark: '#11593d' }, background: { default: '#f1f0ea', paper: '#fcfcf8' }, text: { primary: '#17201c', secondary: '#536159' } },
  shape: { borderRadius: 9 },
  typography: { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', button: { fontWeight: 700, textTransform: 'none' } },
  components: { MuiButton: { defaultProps: { variant: 'outlined', size: 'small' } } },
});
