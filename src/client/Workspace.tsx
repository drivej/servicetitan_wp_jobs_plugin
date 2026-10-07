import { Avatar, Button, IconButton, MenuItem, Select, TextField } from '@mui/material';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AccountMembersAdmin } from './AccountMembersAdmin';
import { BillingPlans } from './BillingPlans';
import { TeamSettings, type TeamRole } from './TeamSettings';
import { TokenAdmin } from './TokenAdmin';
import { TokenHistory } from './TokenHistory';
import { TokenBalanceCard } from './TokenBalanceCard';
import { accountFetch, clearAccountCache, configureApi } from './api';
import { clearTokenError, setAvailableTokens, useTokenError, useTokensExhausted } from './tokenState';
import { PageHeader } from './PageHeader';
import { MarketingPage } from './MarketingPage';
import { LoadingModal, LoadingPage } from './LoadingModal';
import { navigateTo, useNavigationLoading } from './navigation';

interface User {
  isPlatformAdmin?: boolean;
  avatarUrl?: string | null;
  workspaceId: string;
  workspaceName: string;
  role: TeamRole;
  id: string;
  name: string;
  email: string;
  jobTokens: number;
}
interface Connection {
  id: string;
  name: string;
  environment: string;
  tenantId: string;
}
interface Website {
  id: string;
  name: string;
  url: string;
  connectionId: string | null;
  wordpressUsername?: string | null;
  restBase: string;
  zipAcfField: string;
  wordpressConfigured: boolean;
}
interface Session {
  mode: 'saas' | 'local';
  testTokensEnabled?: boolean;
  user?: User;
  csrfToken?: string;
}
interface OnboardingStatus { activeProduct: boolean; pluginReady: boolean; websiteReady: boolean; serviceTitanReady: boolean; settingsReady: boolean; onboardingStep: number; }
type ConnectionCheckKind = 'wordpress' | 'servicetitan' | 'plugin';
interface ConnectionCheck { kind: ConnectionCheckKind; success: boolean; message: string; helpUrl?: string; }

function workspaceRedirect(path: string, status: OnboardingStatus | undefined, isLocal: boolean, hasInvitation: boolean): string | undefined {
  if (isLocal || !status || hasInvitation) return undefined;
  // Jobs require a subscription; setup, billing, settings, and help remain accessible.
  if (!status.activeProduct) return path === '/jobs' || path.startsWith('/jobs/') ? '/pricing' : undefined;
  const setupComplete = status.settingsReady || status.onboardingStep >= 3;
  if (!setupComplete && !['/onboarding', '/settings', '/help', '/wordpress-plugin', '/invite'].includes(path)) return '/onboarding';
  if (setupComplete && path === '/pricing') return '/';
  return undefined;
}

const DemoWebsites: Website[] = [
  {
    id: 'demo-1',
    name: 'Demo Website',
    url: 'https://example.com',
    connectionId: 'demo-connection',
    restBase: 'wp-json',
    zipAcfField: 'zip_code',
    wordpressConfigured: true
  }
];

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string; requestId?: string };
  if (!response.ok) throw new Error(`${body.error || 'The request could not be completed.'}${body.requestId ? ` (Request ID: ${body.requestId})` : ''}`);
  return body;
}

const BrandBanner = () => {
  return (
    <a className='workspace-brand p-3' href='/'>
      ServiceTitan Jobs
    </a>
  );
};

const WorkspaceTokens = ({ count, path }: { count: number; path: string }) => {
  const href = '/add-tokens';
  return (
    <Button component='a' className='btn-nav' variant={path === href ? 'contained' : 'text'} href={href} aria-current={path === href ? 'page' : undefined}>
      Tokens
    </Button>
  );

  // return (
  //   <div className='workspace-token-control' role='group' aria-label='Job tokens'>
  //     <span className='workspace-token-balance' role='status' title='Each successful push, rebuild, or AI description costs 1 job token.'>
  //       <strong>{count.toLocaleString()}</strong> tokens
  //     </span>
  //     <a className='workspace-token-add' href='/add-tokens' aria-label='Add tokens' aria-current={path === '/add-tokens' ? 'page' : undefined}>
  //       <span aria-hidden='true'>+</span> Add
  //     </a>
  //   </div>
  // );
};

const SettingsButton = ({ path }: { path: string }) => {
  const href = '/settings';
  return (
    <Button component='a' className='btn-nav' variant={path === href ? 'contained' : 'text'} href={href} aria-current={path === href ? 'page' : undefined}>
      Settings
    </Button>
  );

  // return (
  //   <Button component='a' className='btn-nav workspace-icon-link' variant={path === '/settings' ? 'contained' : 'text'} href='/settings' aria-label='Settings' title='Settings' aria-current={path === '/settings' ? 'page' : undefined}>
  //     <SettingsRoundedIcon aria-hidden='true' />
  //   </Button>
  // );
};

const AccountMenu = ({ user, onSignOut, busy }: { user: User; onSignOut: () => void; busy: boolean }) => {
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        container.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);
  const initials =
    user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') ||
    user.email[0]?.toUpperCase() ||
    '?';
  return (
    <div className='account-menu' ref={container}>
      <IconButton
        className='account-avatar-button'
        sx={{ p: 0, width: 38, height: 38, border: '2px solid #d7e5dd', backgroundColor: '#dfece5', color: '#234f42', '&:hover, &[aria-expanded=true]': { borderColor: '#186d4c' } }}
        type='button'
        aria-label={`Account menu for ${user.name || user.email}`}
        aria-expanded={open}
        aria-controls='account-menu-panel'
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar sx={{ width: 34, height: 34, fontSize: '0.85rem' }} src={!imageFailed ? user.avatarUrl || undefined : undefined} alt='' slotProps={{ img: { referrerPolicy: 'no-referrer', onError: () => setImageFailed(true) } }}>
          {initials}
        </Avatar>
      </IconButton>
      {open && (
        <div className='account-menu-panel' id='account-menu-panel'>
          <div className='account-menu-identity'>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <a href='/settings'>Settings</a>
          <a href='/add-tokens'>Tokens</a>
          {user.isPlatformAdmin && (
            <>
              <a href='/admin/tokens'>Token admin</a>
              <a href='/admin/members'>Account members</a>
            </>
          )}
          <a href='/help'>Help</a>
          <Button type='button' variant='text' sx={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }} disabled={busy} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
};

const JobsButton = ({ href, path }: { href: string; path: string }) => {
  return (
    <Button component='a' className='btn-nav' variant={path === '/jobs' || path.startsWith('/jobs/') ? 'contained' : 'text'} href={href} aria-current={path === '/jobs' || path.startsWith('/jobs/') ? 'page' : undefined}>
      Jobs
    </Button>
  );
};

const PluginButton = ({ path }: { path: string }) => {
  return (
    <Button component='a' className='btn-nav' variant={path === '/wordpress-plugin' ? 'contained' : 'text'} href='/wordpress-plugin' aria-current={path === '/wordpress-plugin' ? 'page' : undefined}>
      Plugin
    </Button>
  );
};

const WordpressButton = ({ path }: { path: string }) => {
  const href = '/help';
  return (
    <Button component='a' className='btn-nav' variant={path === href ? 'contained' : 'text'} href={href} aria-current={path === href ? 'page' : undefined}>
      Help
    </Button>
  );
  // return (
  //   <a
  //   className=''
  //   href='/help'
  //   aria-label='Help'
  //   title='Help'
  //   aria-current={path === '/help' ? 'page' : undefined}>
  //     Help
  //   </a>
  // );
  // return (
  //   <Button component='a' className='btn-nav workspace-icon-link' variant={path === '/help' ? 'contained' : 'text'} href='/help' aria-label='Help' title='Help' aria-current={path === '/help' ? 'page' : undefined}>
  //     <HelpOutlineRoundedIcon aria-hidden='true' />
  //   </Button>
  // );
};

const ConnectionTestButton = ({ disabled, busy, busyLabel, label = 'Test Connection', type = 'button', onClick }: {
  disabled: boolean;
  busy: boolean;
  busyLabel: string;
  label?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
}) => (
  <Button type={type} variant='outlined' className='connection-test-button' disabled={disabled} onClick={onClick}>
    {busy ? busyLabel : label}
  </Button>
);

const ConnectionCheckMessage = ({ check }: { check: ConnectionCheck }) => (
  <p className={check.success ? 'notice' : 'notice error'} role={check.success ? 'status' : 'alert'}>
    {check.message}{check.helpUrl && <> <a href={check.helpUrl}>Open help</a></>}
  </p>
);

export function Workspace({ children }: { children: ReactNode }) {
  const navigating = useNavigationLoading();
  const [invitationToken] = useState(() => {
    const incoming = window.location.pathname === '/invite' ? new URLSearchParams(window.location.hash.slice(1)).get('token') : null;
    try {
      if (incoming && /^[a-zA-Z0-9_-]{43}$/.test(incoming)) window.sessionStorage.setItem('pending-team-invite', incoming);
      return window.sessionStorage.getItem('pending-team-invite') || '';
    } catch {
      return incoming || '';
    }
  });
  const [invitation, setInvitation] = useState<{ workspaceName: string; role: TeamRole; email: string }>();
  const [session, setSession] = useState<Session>();
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState('');
  const tokenError = useTokenError();
  const tokensExhausted = useTokensExhausted();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serviceTitanFormDirty, setServiceTitanFormDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [testTokenAmount, setTestTokenAmount] = useState('1');
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [editingWebsite, setEditingWebsite] = useState<Website>();
  const [onboarding, setOnboarding] = useState<OnboardingStatus>();
  const [websiteTestPassed, setWebsiteTestPassed] = useState(false);
  const [serviceTitanTestPassed, setServiceTitanTestPassed] = useState(false);
  const [validationError, setValidationError] = useState<{ message: string; helpUrl: string }>();
  const [settingsCheck, setSettingsCheck] = useState<ConnectionCheck>();
  const [testingSection, setTestingSection] = useState<ConnectionCheckKind>();
  const [onboardingStage, setOnboardingStage] = useState<1 | 2 | 3>(() => { try { const value = Number(window.sessionStorage.getItem('onboarding-stage')); return value === 2 ? 2 : value === 3 || value === 4 ? 3 : 1; } catch { return 1; } });
  const userSelectedOnboardingStage = useRef(false);
  const [validationSuccess, setValidationSuccess] = useState('');
  const savedOnboardingStep = onboarding?.onboardingStep || 1;
  const websiteStepComplete = Boolean(onboarding?.websiteReady || savedOnboardingStep >= 2);
  const serviceTitanStepComplete = Boolean(onboarding?.serviceTitanReady || savedOnboardingStep >= 3);
  const onboardingComplete = Boolean(onboarding?.settingsReady || savedOnboardingStep >= 3);

  useEffect(() => {
    if (!onboarding) return;
    if (!userSelectedOnboardingStage.current) {
      const savedStage: 1 | 2 | 3 = onboarding.settingsReady || onboarding.onboardingStep >= 3
        ? 3
        : onboarding.websiteReady || onboarding.onboardingStep >= 2 || websiteTestPassed ? 2 : 1;
      if (onboardingStage !== savedStage) {
        setOnboardingStage(savedStage);
        window.sessionStorage.setItem('onboarding-stage', String(savedStage));
      }
      return;
    }
    if (onboardingStage === 2 && !onboarding.websiteReady && !websiteTestPassed) {
      setOnboardingStage(1);
      window.sessionStorage.setItem('onboarding-stage', '1');
    } else if (onboardingStage === 3 && !onboarding.settingsReady && onboarding.onboardingStep < 3) {
      const nextStage = onboarding.websiteReady || websiteTestPassed ? 2 : 1;
      setOnboardingStage(nextStage);
      window.sessionStorage.setItem('onboarding-stage', String(nextStage));
    }
  }, [onboarding, onboardingStage, websiteTestPassed]);

  const selectOnboardingStage = (stage: 1 | 2 | 3) => {
    userSelectedOnboardingStage.current = true;
    if (stage === 2) {
      setServiceTitanTestPassed(false);
      setSettingsCheck(undefined);
    }
    setOnboardingStage(stage);
    window.sessionStorage.setItem('onboarding-stage', String(stage));
  };

  async function refresh(user: User, token: string) {
    // The first refresh runs before setSession has updated React state.
    // This helper is called only for SaaS sessions, so load status directly.
    const [connectionResult, siteResult, onboardingStatus] = await Promise.all([
      accountFetch('/api/connections').then(json<{ connections: Connection[] }>),
      accountFetch('/api/websites').then(json<{ websites: Website[] }>),
      accountFetch('/api/onboarding/status').then(json<OnboardingStatus>),
    ]);
    setConnections(connectionResult.connections);
    setWebsites(siteResult.websites);
    setOnboarding(onboardingStatus);
    const site = siteResult.websites[0];
    configureApi(user.id, site?.id || '', token, user.workspaceId);
    setSelected(site?.id || '');
    setLoaded(true);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/api/session', { credentials: 'same-origin' });
        if (!active) return;
        if (response.status === 401) {
          setSignedOut(true);
          return;
        }
        const current = await json<Session>(response);
        if (!active) return;
        setSession(current);
        if (current.mode === 'local') {
          if (!current.user) throw new Error('Invalid local session response.');
          setWebsites(DemoWebsites);
          setConnections([]);
          configureApi('local', '', '');
          setSelected(DemoWebsites[0]?.id || '');
          setLoaded(true);
          return;
        }
        if (!current.user || !current.csrfToken) throw new Error('Invalid session response.');
        configureApi(current.user.id, '', current.csrfToken, current.user.workspaceId);
        setAvailableTokens(current.user.jobTokens);
        await refresh(current.user, current.csrfToken);
        if (invitationToken) setInvitation(await accountFetch('/api/invitations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitationToken }) }).then(json<{ workspaceName: string; role: TeamRole; email: string }>));
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load your account.');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (session?.mode !== 'saas') return;
    let active = true;
    let revision = 0;
    const refreshBalance = async () => {
      const current = ++revision;
      try {
        const updated = await accountFetch('/api/session').then(json<Session>);
        if (active && current === revision) {
          if (updated.user?.workspaceId !== session.user?.workspaceId || updated.user?.role !== session.user?.role) {
            navigateTo('/settings');
            return;
          }
          setSession(updated);
          if (updated.user) setAvailableTokens(updated.user.jobTokens);
        }
      } catch {
        /* Keep the last confirmed balance; the API still enforces spending. */
      }
    };
    const update = () => {
      void refreshBalance();
    };
    window.addEventListener('job-tokens-changed', update);
    window.addEventListener('focus', update);
    const interval = window.setInterval(update, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('job-tokens-changed', update);
      window.removeEventListener('focus', update);
    };
  }, [session?.mode, session?.user?.workspaceId, session?.user?.role]);

  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const onboardingPage = path === '/onboarding';
  const settingsPage = path === '/settings';
  const currentPage = path === '/wordpress-plugin' ? 'plugin' : path === '/help' ? 'guide' : path === '/jobs' || path.startsWith('/jobs/') ? 'jobs' : undefined;
  const jobsHref = currentPage === 'jobs' ? `/jobs${window.location.search}` : '/jobs';
  const redirectTarget = loaded && !signedOut ? workspaceRedirect(path, onboarding, session?.mode === 'local', Boolean(invitationToken)) : undefined;
  const redirectedTo = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!redirectTarget || redirectedTo.current === redirectTarget) return;
    redirectedTo.current = redirectTarget;
    window.location.replace(redirectTarget);
  }, [redirectTarget]);

  useLayoutEffect(() => {
    if (onboardingPage) window.scrollTo(0, 0);
  }, [onboardingPage, onboardingStage]);

  if (signedOut)
    return <><LoadingModal open={navigating} /><MarketingPage />{invitationToken && <p className='marketing-invite-notice'>Sign in with the Google email address that received your team invitation. <a href='/auth/google'>Continue with Google</a></p>}{new URLSearchParams(window.location.search).get('login') === 'failed' && <p className='marketing-login-error' role='alert'>Sign-in could not be completed. Please try again.</p>}</>;
  if (!loaded && !error) return <LoadingPage />;
  if (!loaded)
    return (
      <main className='account-page'>
        <h1>ServiceTitan Jobs</h1>
        <p role='alert'>{error}</p>
        {error && <Button onClick={() => window.location.reload()}>Try again</Button>}
      </main>
    );

  if (redirectTarget)
    return <LoadingPage />;

  const user = session!.user!;
  const isLocal = session!.mode === 'local';
  const canManage = user.role !== 'member';
  const invitePage = Boolean(invitationToken) || path === '/invite';
  const tokensPage = path === '/add-tokens';
  const adminPage = path === '/admin/tokens';
  const membersAdminPage = path === '/admin/members';

  const acceptInvite = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await accountFetch('/api/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitationToken }) });
      if (!response.ok) await json(response);
      window.sessionStorage.removeItem('pending-team-invite');
      clearAccountCache(user.id);
      navigateTo('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to accept invitation.');
      setBusy(false);
    }
  };
  const addTestToken = async () => {
    const amount = Number(testTokenAmount);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      setError('Enter a positive whole token amount.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await accountFetch('/api/tokens/test-credit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) }).then(json);
      window.dispatchEvent(new Event('job-tokens-changed'));
      setMessage(`${amount.toLocaleString()} test token${amount === 1 ? '' : 's'} added.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to add a test token.');
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (isLocal) return;
    setBusy(true);
    setError('');
    try {
      const response = await accountFetch('/api/logout', { method: 'POST' });
      if (!response.ok) await json(response);
      clearAccountCache(user.id);
      configureApi('signed-out', '', '');
      navigateTo('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign out failed.');
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>, kind: 'connections' | 'websites') => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) || '').trim();
    const activeWebsite = websites.find((site) => site.id === selected) || websites[0];
    const websiteEditing = editingWebsite || activeWebsite;
    const editing = kind === 'connections' ? editingConnection || connections.find((item) => item.id === activeWebsite?.connectionId) || connections[0] : websiteEditing;
    const wordpressUsername = field('wp-username');
    const applicationPassword = field('wp-application-password');
    if (kind === 'websites' && websiteEditing?.wordpressConfigured && wordpressUsername !== (websiteEditing.wordpressUsername || '') && !applicationPassword) {
      setError('Enter a new Application Password when changing the WordPress username.');
      setBusy(false);
      return;
    }
    const body =
      kind === 'connections'
        ? { name: field('name'), environment: 'production', tenantId: field('tenantId'), clientId: field('clientId'), clientSecret: field('clientSecret'), appKey: field('appKey') }
        : { name: field('name'), ...(field('connectionId') ? { connectionId: field('connectionId') } : {}), url: field('url'), restBase: field('restBase') || websiteEditing?.restBase || 'st-jobs', zipAcfField: field('zipAcfField') || websiteEditing?.zipAcfField || 'my_zip_codes', ...(applicationPassword ? { wordpress: { username: wordpressUsername, applicationPassword } } : {}) };
    try {
      const saved = await accountFetch(`/api/${kind}${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ id?: string }>);
      if (kind === 'connections' && saved.id) setEditingConnection({ id: saved.id, name: field('name'), environment: 'production', tenantId: field('tenantId') });
      if (kind === 'connections' && editingConnection && editingConnection.environment !== 'production') clearAccountCache(user.id);
      form.reset();
      if (kind === 'connections') setServiceTitanFormDirty(false);
      setEditingConnection(undefined);
      setEditingWebsite(undefined);
      await refresh(user, session!.csrfToken!);
      setMessage(kind === 'connections' ? 'ServiceTitan connection saved. Select Test Connection to verify API permissions.' : 'Website saved. Select Test Connection to verify the WordPress REST API.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  };

  const updateServiceTitanFormDirty = (form: HTMLFormElement, initialName?: string) => {
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const changedName = Boolean(name && name !== (initialName || ''));
    const changedCredential = ['clientId', 'clientSecret', 'appKey']
      .some((key) => String(data.get(key) || '').trim().length > 0);
    setServiceTitanFormDirty(changedName || changedCredential);
  };

  const testSettingsSection = async (kind: ConnectionCheckKind) => {
    const website = websites.find((site) => site.id === selected) || websites[0];
    if (!website) {
      setSettingsCheck({ kind, success: false, message: 'Save a website before running this check.', helpUrl: '/help/onboarding-save-failed' });
      return;
    }
    const connection = connections.find((item) => item.id === website.connectionId) || editingConnection || connections[0];
    if (kind === 'servicetitan' && !connection) {
      setSettingsCheck({ kind, success: false, message: 'Save a ServiceTitan connection before testing it.', helpUrl: '/help/servicetitan-credentials' });
      return;
    }
    setBusy(true);
    setTestingSection(kind);
    setSettingsCheck(undefined);
    try {
      const endpoint = kind === 'wordpress' ? '/api/onboarding/validate-website' : kind === 'plugin' ? '/api/onboarding/validate-plugin' : '/api/onboarding/validate-servicetitan';
      const payload = kind === 'servicetitan' ? { connectionId: connection!.id, websiteId: website.id } : { websiteId: website.id };
      const response = await accountFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string; helpUrl?: string; version?: string; requestId?: string };
      if (!response.ok) {
        setSettingsCheck({ kind, success: false, message: `${result.error || 'Connection check failed.'}${result.requestId ? ` (Request ID: ${result.requestId})` : ''}`, helpUrl: result.helpUrl || (kind === 'wordpress' ? '/help/wordpress-reachability' : kind === 'plugin' ? '/help/plugin-test-failed' : '/help/servicetitan-permissions') });
        return;
      }
      await refresh(user, session!.csrfToken!);
      const message = kind === 'plugin' ? `Plugin version ${result.version} is detected and compatible.` : kind === 'wordpress' ? 'WordPress REST API access validated.' : 'ServiceTitan Jobs access validated.';
      setSettingsCheck({ kind, success: true, message });
    } catch (reason) {
      setSettingsCheck({ kind, success: false, message: reason instanceof Error ? reason.message : 'Connection check failed.', helpUrl: kind === 'wordpress' ? '/help/wordpress-reachability' : kind === 'plugin' ? '/help/plugin-test-failed' : '/help/servicetitan-permissions' });
    } finally {
      setTestingSection(undefined);
      setBusy(false);
    }
  };

  const settingsWebsite = websites.find((site) => site.id === selected) || websites[0];
  const settingsConnection = connections.find((connection) => connection.id === settingsWebsite?.connectionId) || connections[0];
  const onboardingConnection = editingConnection || connections.find((connection) => connection.id === websites[0]?.connectionId) || connections[0];
  const settingsNeedsProductionCredentials = Boolean(settingsConnection && settingsConnection.environment !== 'production');
  const onboardingNeedsProductionCredentials = Boolean(onboardingConnection && onboardingConnection.environment !== 'production');

  const saveAndTestPlugin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    userSelectedOnboardingStage.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    setValidationError(undefined);
    setValidationSuccess('');
    setWebsiteTestPassed(false);
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) || '').trim();
    const existing = editingWebsite || websites[0];
    const wordpressUsername = value('wp-username');
    const applicationPassword = value('wp-application-password');
    if (existing?.wordpressConfigured && wordpressUsername !== (existing.wordpressUsername || '') && !applicationPassword) {
      setValidationError({ message: 'Enter a new Application Password when changing the WordPress username.', helpUrl: '/help/wordpress-credentials' });
      setBusy(false);
      return;
    }
    let saved: Website;
    try {
      saved = await accountFetch(`/api/websites${existing ? `/${existing.id}` : ''}`, {
        method: existing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: value('name'), url: value('url'),
          ...(applicationPassword ? { wordpress: { username: wordpressUsername, applicationPassword } } : {}),
          restBase: editingWebsite?.restBase || existing?.restBase || 'st-jobs',
          zipAcfField: editingWebsite?.zipAcfField || existing?.zipAcfField || 'my_zip_codes',
        }),
      }).then(json<Website>);
    } catch (reason) {
      setValidationError({
        message: reason instanceof Error ? reason.message : 'Website setup could not be saved.',
        helpUrl: '/help/onboarding-save-failed',
      });
      setBusy(false);
      return;
    }
    try {
      await refresh(user, session!.csrfToken!);
      const response = await accountFetch('/api/onboarding/validate-plugin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteId: saved.id }),
      });
      const body = await response.json() as { error?: string; helpUrl?: string; version?: string; requestId?: string };
      if (!response.ok) {
        const details = `${body.error || 'The plugin test failed.'}${body.requestId ? ` (Request ID: ${body.requestId})` : ''}`;
        setValidationError({ message: details, helpUrl: body.helpUrl || '/help/plugin-test-failed' });
        return;
      }
      await refresh(user, session!.csrfToken!);
      const wpResponse = await accountFetch('/api/onboarding/validate-website', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteId: saved.id }),
      });
      const wpBody = await wpResponse.json() as { error?: string; helpUrl?: string; requestId?: string };
      if (!wpResponse.ok) {
        setValidationError({
          message: `${wpBody.error || 'WordPress access validation failed.'}${wpBody.requestId ? ` (Request ID: ${wpBody.requestId})` : ''}`,
          helpUrl: wpBody.helpUrl || '/help/wordpress-credentials',
        });
        return;
      }
      await refresh(user, session!.csrfToken!);
      setEditingWebsite(undefined);
      setWebsiteTestPassed(true);
      setValidationSuccess(`WordPress plugin ${body.version} and authenticated API access validated.`);
    } catch (reason) {
      setValidationError({
        message: reason instanceof Error ? reason.message : 'Unable to validate WordPress access.',
        helpUrl: '/help/wordpress-reachability',
      });
    } finally {
      setBusy(false);
    }
  };

  const testAndSaveServiceTitan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    userSelectedOnboardingStage.current = true;
    const website = websites[0];
    if (!website) {
      setSettingsCheck({ kind: 'servicetitan', success: false, message: 'Connect and test your WordPress website first.', helpUrl: '/help/wordpress-credentials' });
      return;
    }
    setBusy(true);
    setSettingsCheck(undefined);
    setServiceTitanTestPassed(false);
    setValidationError(undefined);
    setValidationSuccess('');
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) || '').trim();
    const existing = onboardingConnection;
    try {
      const saved = await accountFetch(`/api/connections${existing ? `/${existing.id}` : ''}`, {
        method: existing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: value('name'), environment: 'production', tenantId: value('tenantId'),
          clientId: value('clientId'), clientSecret: value('clientSecret'), appKey: value('appKey'),
        }),
      }).then(json<Connection>);
      setServiceTitanFormDirty(false);
      if (existing && existing.environment !== 'production') clearAccountCache(user.id);
      await refresh(user, session!.csrfToken!);

      const response = await accountFetch('/api/onboarding/validate-servicetitan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: saved.id, websiteId: website.id }),
      });
      const result = await response.json() as { error?: string; helpUrl?: string; requestId?: string };
      if (!response.ok) {
        setSettingsCheck({
          kind: 'servicetitan', success: false,
          message: `${result.error || 'ServiceTitan connection check failed.'}${result.requestId ? ` (Request ID: ${result.requestId})` : ''}`,
          helpUrl: result.helpUrl || '/help/servicetitan-permissions',
        });
        return;
      }
      await refresh(user, session!.csrfToken!);
      setServiceTitanTestPassed(true);
      setSettingsCheck({ kind: 'servicetitan', success: true, message: 'ServiceTitan Jobs access validated.' });
    } catch (reason) {
      setSettingsCheck({
        kind: 'servicetitan', success: false,
        message: reason instanceof Error ? reason.message : 'ServiceTitan connection check failed.',
        helpUrl: '/help/servicetitan-credentials',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LoadingModal open={navigating} />
      <header className='workspace-bar'>
        <BrandBanner />
        <div className='d-flex gap-2 p-2 align-end'>
          <div style={{ flexGrow: 1 }} />
          <JobsButton href={jobsHref} path={path} />
          <WorkspaceTokens count={isLocal ? 3 : user.jobTokens} path={path} />
          <PluginButton path={path} />
          <WordpressButton path={path} />
          <SettingsButton path={path} />
          <AccountMenu user={user} onSignOut={() => void logout()} busy={busy || isLocal} />
        </div>
      </header>

      {error && (
        <p className='notice error account-notice' role='alert'>
          {error}
        </p>
      )}
      {tokenError && (
        <div className='modal-backdrop' role='presentation'>
          <section className='error-modal' role='alertdialog' aria-modal='true' aria-labelledby='token-dialog-title' aria-describedby='token-dialog-description'>
            <div className='error-modal-icon' aria-hidden='true'>
              !
            </div>
            <h2 id='token-dialog-title'>No job tokens available</h2>
            <p id='token-dialog-description'>{tokenError}</p>
            <p>Your request has not been completed.</p>
            <div className='account-actions'>
              <Button component='a' variant='contained' className='account-primary-link' href='/add-tokens'>
                Add Tokens
              </Button>
              <Button onClick={clearTokenError}>Close</Button>
            </div>
          </section>
        </div>
      )}
      {!onboardingPage && tokensExhausted && (isLocal || onboardingComplete) && (
        <div className='token-violator' role='status'>
          <span>You’re out of job tokens. Add tokens to keep publishing and rebuilding posts.</span>
          <Button component='a' href='/add-tokens' className='token-violator-link'>
            Get tokens
          </Button>
        </div>
      )}
      {isLocal && tokensPage ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Local workspace' title='Add Tokens' description='Local mode does not use job tokens. To test subscriptions locally, run the app in SaaS mode with a workspace account and Stripe sandbox credentials.' />
        </main>
      ) : isLocal && path === '/settings' ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Local workspace' title='Settings' description='Local workspace connections are configured through the server environment.' />
          <p className='field-help'>
            Signed in as {user.name} ({user.email})
          </p>
        </main>
      ) : invitePage ? (
        <main className='account-page'>
          <h1>Join a workspace</h1>
          <p>Signed in as {user.email}. Accepting adds you to the invited team and switches your active workspace. Your own workspace stays available.</p>
          {invitation && (
            <p>
              You are invited to <strong>{invitation.workspaceName}</strong> as a <strong>{invitation.role}</strong>.
            </p>
          )}
          {invitationToken ? (
            <Button variant='contained' className='primary' disabled={busy || !invitation} onClick={() => void acceptInvite()}>
              Accept invitation
            </Button>
          ) : (
            <p className='notice error'>This invitation link is missing its token. Ask the owner for a new link.</p>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              window.sessionStorage.removeItem('pending-team-invite');
              navigateTo('/');
            }}
          >
            Cancel
          </Button>
        </main>
      ) : adminPage ? (
        user.isPlatformAdmin ? (
          <TokenAdmin />
        ) : (
          <main className='account-page'>
            <h1>Access denied</h1>
            <p>Platform administrator access is required.</p>
          </main>
        )
      ) : membersAdminPage ? (
        user.isPlatformAdmin ? (
          <AccountMembersAdmin />
        ) : (
          <main className='account-page'>
            <h1>Access denied</h1>
            <p>Platform administrator access is required.</p>
          </main>
        )
      ) : tokensPage ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Your workspace' title='Add Tokens' description='Use job tokens to publish posts, rebuild posts, and generate AI descriptions.' />
          <TokenBalanceCard tokens={user.jobTokens} />
          <section className='panel account-panel'>
            <h2>Keep your tokens topped up</h2>
            <BillingPlans key={user.workspaceId} workspaceId={user.workspaceId} />
            {canManage && <TokenHistory key={`history:${user.workspaceId}`} workspaceId={user.workspaceId} />}
            {session?.testTokensEnabled && user.role === 'owner' && (
              <>
                <h3>Testing</h3>
                <p>Add free tokens to test the application. No payment is required.</p>
                <div className='d-flex gap-2 align-end'>
                  <TextField label='Amount' type='number' size='small' value={testTokenAmount} slotProps={{ htmlInput: { min: 1, step: 1 } }} disabled={busy} onChange={(event) => setTestTokenAmount(event.target.value)} />
                  <Button variant='contained' className='primary' disabled={busy} onClick={() => void addTestToken()}>
                    {busy ? 'Adding…' : 'Add test tokens'}
                  </Button>
                </div>
              </>
            )}
            {message && (
              <p className='notice' role='status'>
                {message}
              </p>
            )}
          </section>
        </main>
      ) : settingsPage ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Configuration' title='Settings' description='Review your saved integrations and test each connection from this page.' />
          {message && <p className='notice' role='status'>{message}</p>}
          {!canManage && <p className='notice'>An owner or admin manages these configuration values.</p>}
          <div className='account-grid'>
            <section className='panel account-panel settings-integration-panel'>
              <h2>WordPress website</h2>
              {settingsWebsite && <p>{settingsWebsite.name} · {settingsWebsite.url}</p>}
              <form key={editingWebsite?.id || settingsWebsite?.id || 'website-settings'} onSubmit={(event) => void submit(event, 'websites')} className='account-form'>
                <label>Website name<TextField size='small' fullWidth name='name' required defaultValue={editingWebsite?.name || settingsWebsite?.name} placeholder='My company website' /></label>
                <label>Website URL<TextField size='small' fullWidth name='url' type='url' required defaultValue={editingWebsite?.url || settingsWebsite?.url} slotProps={{ htmlInput: { readOnly: Boolean(editingWebsite || settingsWebsite) } }} placeholder='https://example.com' /></label>
                <label>WordPress username<TextField size='small' fullWidth id='wp-username' name='wp-username' required={!(settingsWebsite?.wordpressConfigured ?? false)} defaultValue={settingsWebsite?.wordpressUsername || ''} autoComplete='username' /></label>
                <label>Application Password<TextField size='small' fullWidth id='wp-application-password' name='wp-application-password' type='password' required={!(settingsWebsite?.wordpressConfigured ?? false)} placeholder={settingsWebsite?.wordpressConfigured ? '********' : undefined} autoComplete='current-password' /></label>
                <p className='field-help'>The saved password stays on the server. Leave it blank to keep the current value or enter a replacement. <a href='/help/wordpress-credentials'>Credential help</a></p>
                <label>Post type REST base<TextField size='small' fullWidth name='restBase' required defaultValue={settingsWebsite?.restBase || 'st-jobs'} /></label>
                <label>ZIP ACF field<TextField size='small' fullWidth name='zipAcfField' required defaultValue={settingsWebsite?.zipAcfField || 'my_zip_codes'} /></label>
                <div className='settings-save-actions'><Button type='submit' variant='contained' className='primary' disabled={busy || !canManage}>{busy ? 'Saving…' : 'Save WordPress settings'}</Button></div>
              </form>
              <ConnectionTestButton disabled={busy || !canManage || !settingsWebsite?.wordpressConfigured} busy={testingSection === 'wordpress'} busyLabel='Testing WordPress…' onClick={() => void testSettingsSection('wordpress')} />
              {settingsCheck?.kind === 'wordpress' && <div className='connection-feedback'><ConnectionCheckMessage check={settingsCheck} /></div>}
            </section>
            <section className='panel account-panel settings-integration-panel'>
              <h2>ServiceTitan connection</h2>
              {settingsConnection && <p>{settingsConnection.name} · Production · Tenant {settingsConnection.tenantId}</p>}
              {settingsNeedsProductionCredentials && <p className='notice error' role='status'>This saved connection was configured for Integration. Enter all three Production credentials and save to switch it.</p>}
              <form key={editingConnection?.id || settingsConnection?.id || 'servicetitan-settings'} onSubmit={(event) => void submit(event, 'connections')} onChange={(event) => updateServiceTitanFormDirty(event.currentTarget, editingConnection?.name || settingsConnection?.name)} className='account-form'>
                <label>Connection name<TextField size='small' fullWidth name='name' required defaultValue={editingConnection?.name || settingsConnection?.name} placeholder='My ServiceTitan account' /></label>
                <label>Tenant ID<TextField size='small' fullWidth name='tenantId' required defaultValue={editingConnection?.tenantId || settingsConnection?.tenantId} slotProps={{ htmlInput: { pattern: '[0-9]{1,20}', readOnly: Boolean(editingConnection || settingsConnection) } }} /></label>
                <label>Client ID<TextField size='small' fullWidth name='clientId' type='text' required={!settingsConnection || settingsNeedsProductionCredentials} placeholder={settingsConnection ? settingsNeedsProductionCredentials ? 'Enter Production credential' : '********' : ''} /></label>
                <label>Client secret<TextField size='small' fullWidth name='clientSecret' type='text' required={!settingsConnection || settingsNeedsProductionCredentials} placeholder={settingsConnection ? settingsNeedsProductionCredentials ? 'Enter Production credential' : '********' : ''} /></label>
                <label>App key<TextField size='small' fullWidth name='appKey' type='text' required={!settingsConnection || settingsNeedsProductionCredentials} placeholder={settingsConnection ? settingsNeedsProductionCredentials ? 'Enter Production credential' : '********' : ''} /></label>
                <p className='field-help'>This app always uses ServiceTitan Production. Asterisks indicate saved credentials; leave those fields blank to keep them.</p>
                <div className='settings-save-actions'><Button type='submit' variant='contained' className='primary' disabled={busy || !canManage || !serviceTitanFormDirty}>{busy ? 'Saving…' : 'Save ServiceTitan settings'}</Button></div>
              </form>
              <ConnectionTestButton disabled={busy || !canManage || !settingsConnection || !settingsWebsite?.id} busy={testingSection === 'servicetitan'} busyLabel='Testing ServiceTitan…' onClick={() => void testSettingsSection('servicetitan')} />
              {settingsCheck?.kind === 'servicetitan' && <div className='connection-feedback'><ConnectionCheckMessage check={settingsCheck} /></div>}
            </section>
            <section className='panel account-panel settings-integration-panel'>
              <h2>WordPress plugin version</h2>
              <p>Confirm the companion plugin is reachable and meets the required version.</p>
              <ConnectionTestButton disabled={busy || !canManage || !settingsWebsite} busy={testingSection === 'plugin'} busyLabel='Checking plugin…' label='Test plugin version' onClick={() => void testSettingsSection('plugin')} />
              {settingsCheck?.kind === 'plugin' && <div className='connection-feedback'><ConnectionCheckMessage check={settingsCheck} /></div>}
            </section>
          </div>
        </main>
      ) : onboardingPage ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Onboarding' title={onboardingStage === 1 ? 'Connect your WordPress website' : onboardingStage === 2 ? 'Connect ServiceTitan' : 'Invite your team'} description={onboardingStage === 1 ? 'Install the companion plugin, add WordPress access, and test both connections.' : onboardingStage === 2 ? 'Enter your ServiceTitan API credentials and test Jobs access.' : 'Invite teammates to share this workspace, or skip this step and start working.'} />
          {message && (
            <p className='notice' role='status'>
              {message}
            </p>
          )}
          {!canManage && <p className='notice'>An owner or admin manages this workspace’s connections and websites.</p>}
          {canManage && (
            <>
            <nav className='onboarding-steps' aria-label='Setup steps'><button type='button' aria-current={onboardingStage===1?'step':undefined} onClick={()=>selectOnboardingStage(1)}>1. WordPress {(websiteStepComplete||websiteTestPassed)&&<span className='onboarding-step-check' aria-label='complete'>✓</span>}</button><button type='button' disabled={!websiteStepComplete && !websiteTestPassed} aria-current={onboardingStage===2?'step':undefined} onClick={()=>selectOnboardingStage(2)}>2. ServiceTitan {serviceTitanStepComplete&&<span className='onboarding-step-check' aria-label='complete'>✓</span>}</button><button type='button' disabled={!onboardingComplete} aria-current={onboardingStage===3?'step':undefined} onClick={()=>selectOnboardingStage(3)}>3. Invite people (optional)</button></nav>
            <div className='account-grid'>
            {onboardingStage === 1 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 1 of 3</p><h2>Install the plugin and connect WordPress</h2><p>Install and activate the companion plugin, then enter WordPress credentials so onboarding can test both the plugin route and authenticated REST API access.</p><p><a href='/downloads/servicetitan-job-integration-1.18.1.zip' download>Download WordPress plugin 1.18.1</a> · <a href='/wordpress-plugin'>Installation instructions</a></p>{websites[0] && <p>{websites[0].name} · {websites[0].wordpressConfigured ? 'Credentials saved' : 'Credentials needed'} <Button onClick={() => setEditingWebsite(websites[0])}>Edit</Button></p>}<form key={editingWebsite?.id || 'stage-site'} onSubmit={(event) => void saveAndTestPlugin(event)} onChange={() => { setWebsiteTestPassed(false); setValidationError(undefined); setValidationSuccess(''); }} className='account-form'><label>Website name<TextField size='small' fullWidth name='name' required defaultValue={editingWebsite?.name || websites[0]?.name} placeholder='My company website' /></label><label>Website URL<TextField size='small' fullWidth name='url' type='url' required defaultValue={editingWebsite?.url || websites[0]?.url} slotProps={{ htmlInput: { readOnly: Boolean(editingWebsite || websites[0]) } }} placeholder='https://example.com' /></label><label>WordPress username<TextField size='small' fullWidth id='wp-username' name='wp-username' required={!(editingWebsite?.wordpressConfigured ?? websites[0]?.wordpressConfigured)} defaultValue={editingWebsite ? editingWebsite.wordpressUsername ?? '' : websites[0]?.wordpressUsername ?? ''} autoComplete='username' /></label><label>Application Password<TextField size='small' fullWidth id='wp-application-password' name='wp-application-password' type='password' required={!(editingWebsite?.wordpressConfigured ?? websites[0]?.wordpressConfigured)} placeholder={(editingWebsite?.wordpressConfigured ?? websites[0]?.wordpressConfigured) ? '********' : undefined} autoComplete='current-password' /></label><p className='field-help'>Use a generated Application Password, not your normal WordPress password. The saved password stays on the server; leave the field blank to keep it or enter a replacement. <a href='/help/wordpress-credentials'>Credential help</a></p><ConnectionTestButton type='submit' disabled={busy} busy={busy} busyLabel='Testing WordPress…' /></form>{(validationSuccess || validationError) && <div className='connection-feedback'>{validationSuccess && <p className='notice' role='status'>{validationSuccess}</p>}{validationError && <p className='notice error' role='alert'>{validationError.message} <a href={validationError.helpUrl}>Open help for this issue</a></p>}</div>}<div className='onboarding-step-actions'><Button variant='contained' className='primary' endIcon={<span aria-hidden='true'>→</span>} disabled={!websiteTestPassed} onClick={()=>{selectOnboardingStage(2);setValidationError(undefined);setValidationSuccess('');}}>Save &amp; Continue</Button></div></section>}
              {onboardingStage === 2 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 2 of 3</p><h2>Connect ServiceTitan</h2><p>Enter API credentials and verify Jobs read permission. <a href='/help/servicetitan-permissions'>ServiceTitan setup help</a></p>{connections.map(connection=><p key={connection.id}>{connection.name} · Production · Tenant {connection.tenantId}</p>)}{onboardingNeedsProductionCredentials&&<p className='notice error' role='status'>This saved connection was configured for Integration. Enter all three Production credentials and save to switch it.</p>}<form key={onboardingConnection?.id || 'stage-connection'} onSubmit={(event)=>void testAndSaveServiceTitan(event)} onChange={(event)=>{updateServiceTitanFormDirty(event.currentTarget, editingConnection?.name || onboardingConnection?.name);setSettingsCheck(undefined);setServiceTitanTestPassed(false);setValidationError(undefined);setValidationSuccess('');}} className='account-form'><label>Connection name<TextField size='small' fullWidth name='name' required defaultValue={editingConnection?.name || onboardingConnection?.name} placeholder='My ServiceTitan account'/></label><label>Tenant ID<TextField size='small' fullWidth name='tenantId' required defaultValue={editingConnection?.tenantId || onboardingConnection?.tenantId} slotProps={{htmlInput:{pattern:'[0-9]{1,20}',readOnly:Boolean(editingConnection||onboardingConnection)}}}/></label><label>Client ID<TextField size='small' fullWidth name='clientId' type='text' required={!onboardingConnection||onboardingNeedsProductionCredentials} placeholder={onboardingConnection?onboardingNeedsProductionCredentials?'Enter Production credential':'********':''}/></label><label>Client secret<TextField size='small' fullWidth name='clientSecret' type='text' required={!onboardingConnection||onboardingNeedsProductionCredentials} placeholder={onboardingConnection?onboardingNeedsProductionCredentials?'Enter Production credential':'********':''}/></label><label>App key<TextField size='small' fullWidth name='appKey' type='text' required={!onboardingConnection||onboardingNeedsProductionCredentials} placeholder={onboardingConnection?onboardingNeedsProductionCredentials?'Enter Production credential':'********':''}/></label><p className='field-help'>The app always connects to ServiceTitan Production. Credentials are encrypted on the server. Asterisks indicate saved values; leave fields blank to keep them, or enter replacements.</p><ConnectionTestButton type='submit' disabled={busy||!canManage||!websites[0]?.id} busy={busy} busyLabel='Testing ServiceTitan…' /></form>{(settingsCheck?.kind==='servicetitan'||validationSuccess||validationError)&&<div className='connection-feedback'>{settingsCheck?.kind==='servicetitan'&&<ConnectionCheckMessage check={settingsCheck} />}{validationSuccess&&<p className='notice' role='status'>{validationSuccess}</p>}{validationError&&<p className='notice error' role='alert'>{validationError.message} <a href={validationError.helpUrl}>Open help for this issue</a></p>}</div>}<div className='onboarding-step-actions'><Button variant='contained' className='primary' endIcon={<span aria-hidden='true'>→</span>} disabled={!serviceTitanTestPassed || serviceTitanFormDirty} onClick={()=>{selectOnboardingStage(3);setValidationError(undefined);setValidationSuccess('');}}>Save &amp; Continue</Button></div></section>}
              {onboardingStage === 3 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 3 of 3 · Optional</p><h2>Invite people to your account</h2><p>You can invite teammates now or skip this step and start using Jobs.</p><TeamSettings role={user.role} workspaceId={user.workspaceId} /><Button variant='contained' className='primary' onClick={()=>navigateTo('/jobs')}>Start using Jobs</Button><Button onClick={()=>navigateTo('/jobs')}>Skip for now</Button></section>}
            </div>
            </>
          )}
        </main>
      ) : (
        <div key={`${user.id}:${selected}`}>{!isLocal && !onboardingComplete && (path === '/jobs' || path.startsWith('/jobs/')) ? <main className='account-page'><h1>Complete setup</h1><p>{websiteStepComplete ? 'WordPress is connected. Finish the ServiceTitan check in onboarding to open Jobs.' : 'Connect your WordPress website first, then verify ServiceTitan to open Jobs.'}</p><Button component='a' href='/onboarding' onClick={()=>window.sessionStorage.setItem('onboarding-stage', websiteStepComplete ? '2' : '1')}>{websiteStepComplete ? 'Continue to ServiceTitan' : 'Continue onboarding'}</Button></main> : children}</div>
      )}
    </>
  );
}
