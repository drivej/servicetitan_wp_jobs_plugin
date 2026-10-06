import { Avatar, Button, IconButton, MenuItem, Select, TextField, type SelectChangeEvent } from '@mui/material';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AccountMembersAdmin } from './AccountMembersAdmin';
import { BillingPlans } from './BillingPlans';
import { TeamSettings, type TeamRole } from './TeamSettings';
import { TokenAdmin } from './TokenAdmin';
import { TokenHistory } from './TokenHistory';
import { accountFetch, clearAccountCache, configureApi } from './api';
import { clearTokenError, setAvailableTokens, useTokenError, useTokensExhausted } from './tokenState';
import { PageHeader } from './PageHeader';
import { MarketingPage } from './MarketingPage';

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
interface Workspace {
  id: string;
  name: string;
  role: TeamRole;
}
interface Website {
  id: string;
  name: string;
  url: string;
  connectionId: string;
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
interface OnboardingStatus { activeProduct: boolean; websiteReady: boolean; serviceTitanReady: boolean; settingsReady: boolean; }

const DemoWebsites: Website[] = [
  {
    id: 'demo-1',
    name: 'Demo Site 1',
    url: 'https://demo1.example.com',
    connectionId: 'demo-connection',
    restBase: 'wp-json',
    zipAcfField: 'zip_code',
    wordpressConfigured: true
  },
  {
    id: 'demo-2',
    name: 'Demo Site 2',
    url: 'https://demo2.example.com',
    connectionId: 'demo-connection',
    restBase: 'wp-json',
    zipAcfField: 'zip_code',
    wordpressConfigured: false
  }
];

const DemoWorkspaces: Workspace[] = [
  {
    id: 'demo-workspace-1',
    name: 'Demo Workspace 1',
    role: 'member'
  },
  {
    id: 'demo-workspace-2',
    name: 'Demo Workspace 2',
    role: 'admin'
  }
];

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

const BrandBanner = () => {
  return (
    <a className='workspace-brand p-3' href='/'>
      ServiceTitan Jobs
    </a>
  );
};

const WorkspaceSelect = ({ workspaces, disabled, onChange, value }: { workspaces: Workspace[]; disabled: boolean; value: string; onChange: (event: SelectChangeEvent<string>) => void }) => {
  return (
    workspaces.length > 0 && (
      <label className='workspace-selector'>
        <span>Workspace</span>
        <Select variant='outlined' size='small' sx={{ minWidth: 180 }} aria-label='Active workspace' disabled={disabled} value={value} onChange={onChange}>
          {workspaces.map((workspace) => (
            <MenuItem value={workspace.id} key={workspace.id}>
              {workspace.name}
            </MenuItem>
          ))}
        </Select>
      </label>
    )
  );
};

const WebsitesSelect = ({ websites, onChange, selected }: { websites: Website[]; selected: string; onChange: (event: SelectChangeEvent<string>) => void }) => {
  return (
    websites.length > 0 && (
      <label className='workspace-selector'>
        <span>Website</span>
        <Select variant='outlined' size='small' sx={{ minWidth: 180 }} aria-label='Active website' value={selected} onChange={onChange}>
          {websites.map((site) => (
            <MenuItem value={site.id} key={site.id}>
              {site.name}
            </MenuItem>
          ))}
        </Select>
      </label>
    )
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
    <Button component='a' className='btn-nav' variant={path === '/' || path.startsWith('/jobs/') ? 'contained' : 'text'} href={href} aria-current={path === '/' || path.startsWith('/jobs/') ? 'page' : undefined}>
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

export function Workspace({ children }: { children: ReactNode }) {
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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
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
  const [message, setMessage] = useState('');
  const [testTokenAmount, setTestTokenAmount] = useState('1');
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [editingWebsite, setEditingWebsite] = useState<Website>();
  const [onboarding, setOnboarding] = useState<OnboardingStatus>();
  const [validationError, setValidationError] = useState<{ message: string; helpUrl: string }>();
  const [onboardingStage, setOnboardingStage] = useState<1 | 2 | 3>(() => { try { const value = Number(window.sessionStorage.getItem('onboarding-stage')); return value === 2 || value === 3 ? value : 1; } catch { return 1; } });
  const [validationSuccess, setValidationSuccess] = useState('');

  async function refresh(user: User, token: string) {
    const [connectionResult, siteResult, workspaceResult] = await Promise.all([
      accountFetch('/api/connections').then(json<{ connections: Connection[] }>),
      accountFetch('/api/websites').then(json<{ websites: Website[] }>),
      accountFetch('/api/workspaces').then(json<{ workspaces: { id: string; name: string; role: TeamRole }[] }>)
    ]);
    setWorkspaces(workspaceResult.workspaces);
    setConnections(connectionResult.connections);
    setWebsites(siteResult.websites);
    if (session?.mode === 'saas') {
      try { setOnboarding(await accountFetch('/api/onboarding/status').then(json<OnboardingStatus>)); }
      catch { setOnboarding({ activeProduct: false, websiteReady: false, serviceTitanReady: false, settingsReady: false }); }
    }
    let saved = '';
    try {
      saved = window.sessionStorage.getItem(`website:${user.id}`) || '';
    } catch {
      /* optional */
    }
    const site = siteResult.websites.find((item) => item.id === saved) || siteResult.websites[0];
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
          setWorkspaces(DemoWorkspaces);
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
            window.location.assign('/settings');
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
  const currentPage = path === '/wordpress-plugin' ? 'plugin' : path === '/help' ? 'guide' : path === '/' || path.startsWith('/jobs/') ? 'jobs' : undefined;
  const jobsHref = currentPage === 'jobs' ? `/${window.location.search}` : '/';

  if (signedOut)
    return <><MarketingPage />{invitationToken && <p className='marketing-invite-notice'>Sign in with the Google email address that received your team invitation. <a href='/auth/google'>Continue with Google</a></p>}{new URLSearchParams(window.location.search).get('login') === 'failed' && <p className='marketing-login-error' role='alert'>Sign-in could not be completed. Please try again.</p>}</>;
  if (!loaded)
    return (
      <main className='account-page'>
        <h1>ServiceTitan Jobs</h1>
        <p role={error ? 'alert' : 'status'}>{error || 'Loading your workspace…'}</p>
        {error && <Button onClick={() => window.location.reload()}>Try again</Button>}
      </main>
    );

  const user = session!.user!;
  const isLocal = session!.mode === 'local';
  if (!isLocal && onboarding && !onboarding.activeProduct && path !== '/pricing' && !invitationToken) window.location.replace('/pricing');
  if (!isLocal && onboarding?.activeProduct && !onboarding.settingsReady && path !== '/settings' && !invitationToken) window.location.replace('/settings');
  if (!isLocal && onboarding?.settingsReady && (path === '/pricing' || path === '/settings')) window.location.replace('/');
  const canManage = user.role !== 'member';
  const invitePage = Boolean(invitationToken) || path === '/invite';
  const tokensPage = path === '/add-tokens';
  const adminPage = path === '/admin/tokens';
  const membersAdminPage = path === '/admin/members';
  const accountPage = !invitePage && !tokensPage && !adminPage && (path === '/settings' || websites.length === 0);

  const selectWorkspace = async (workspaceId: string) => {
    if (isLocal) {
      setSession({ ...session!, user: { ...user, workspaceId, workspaceName: DemoWorkspaces.find((workspace) => workspace.id === workspaceId)?.name || user.workspaceName } });
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await accountFetch('/api/workspaces/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      if (!response.ok) await json(response);
      clearAccountCache(user.id);
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to switch workspace.');
      setBusy(false);
    }
  };
  const acceptInvite = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await accountFetch('/api/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitationToken }) });
      if (!response.ok) await json(response);
      window.sessionStorage.removeItem('pending-team-invite');
      clearAccountCache(user.id);
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to accept invitation.');
      setBusy(false);
    }
  };
  const chooseSite = (id: string) => {
    if (isLocal) {
      setSelected(id);
      return;
    }
    configureApi(user.id, id, session!.csrfToken!, user.workspaceId);
    try {
      window.sessionStorage.setItem(`website:${user.id}`, id);
    } catch {
      /* optional */
    }
    setSelected(id);
    // Old job IDs and filters should not carry into another tenant's detail page.
    window.location.assign('/');
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
      window.location.assign('/');
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
    const editing = kind === 'connections' ? editingConnection : editingWebsite;
    const body =
      kind === 'connections'
        ? { name: field('name'), environment: field('environment'), tenantId: field('tenantId'), clientId: field('clientId'), clientSecret: field('clientSecret'), appKey: field('appKey') }
        : { name: field('name'), ...(field('connectionId') ? { connectionId: field('connectionId') } : {}), url: field('url'), restBase: field('restBase'), zipAcfField: field('zipAcfField'), ...(field('username') || field('applicationPassword') ? { wordpress: { username: field('username'), applicationPassword: field('applicationPassword') } } : {}) };
    try {
      await accountFetch(`/api/${kind}${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
      if (kind === 'connections' && editingConnection && field('environment') !== editingConnection.environment) clearAccountCache(user.id);
      form.reset();
      setEditingConnection(undefined);
      setEditingWebsite(undefined);
      await refresh(user, session!.csrfToken!);
      setMessage(kind === 'connections' ? 'ServiceTitan connection saved.' : 'Website saved. Open Jobs to verify the connection and review your content.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className='workspace-bar'>
        <BrandBanner />
        <div className='d-flex gap-2 p-2 align-end'>
          <WorkspaceSelect workspaces={isLocal ? DemoWorkspaces : workspaces} disabled={busy} value={user.workspaceId} onChange={(event) => void selectWorkspace(event.target.value)} />
          <WebsitesSelect websites={isLocal ? DemoWebsites : websites} selected={selected} onChange={(event) => chooseSite(event.target.value)} />
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
      {tokensExhausted && (
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
              window.location.assign('/');
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
          <section className='panel account-panel'>
            <h2>{user.jobTokens.toLocaleString()} job tokens available</h2>
            <p>Each successful action costs 1 token. Failed requests do not spend tokens.</p>
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
      ) : accountPage ? (
        <main className='account-page'>
          <PageHeader className='account-page-hero' eyebrow='Your workspace' title={websites.length ? 'Settings' : `Welcome, ${user.name.split(' ')[0]}.`} description={websites.length ? 'Manage the connections that power your project stories.' : 'Add a ServiceTitan connection, then connect your first website.'} />
          {!isLocal && !onboarding?.settingsReady && onboarding?.activeProduct && <p className='notice'>Complete setup by saving a ServiceTitan connection and a website with WordPress credentials. Then validate access from Jobs.</p>}
          <p className='field-help'>Signed in as {user.email}</p>
          <p>Each successful push, rebuild, or AI description generation costs 1 job token. Failed requests do not spend tokens.</p>
          {message && (
            <p className='notice' role='status'>
              {message}
            </p>
          )}
          {!canManage && <p className='notice'>An owner or admin manages this workspace’s connections and websites.</p>}
          {canManage && (
            <>
            <nav className='onboarding-steps' aria-label='Setup steps'><button type='button' aria-current={onboardingStage === 1 ? 'step' : undefined} onClick={() => {setOnboardingStage(1);window.sessionStorage.setItem('onboarding-stage','1');}}>1. Website</button><button type='button' disabled={!onboarding?.websiteReady} aria-current={onboardingStage === 2 ? 'step' : undefined} onClick={() => {setOnboardingStage(2);window.sessionStorage.setItem('onboarding-stage','2');}}>2. ServiceTitan</button><button type='button' disabled={!onboarding?.settingsReady} aria-current={onboardingStage === 3 ? 'step' : undefined} onClick={() => {setOnboardingStage(3);window.sessionStorage.setItem('onboarding-stage','3');}}>3. Invite people (optional)</button></nav>
            <div className='account-grid'>
              {onboardingStage === 1 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 1 of 3</p><h2>Link your website</h2><p>Connect WordPress and confirm the app can reach its REST API before adding ServiceTitan credentials.</p>{websites.map(site => <p key={site.id}>{site.name} · {site.wordpressConfigured ? 'Credentials saved' : 'Credentials needed'} <Button onClick={() => setEditingWebsite(site)}>Edit</Button></p>)}<form key={editingWebsite?.id || 'stage-site'} onSubmit={(event) => void submit(event, 'websites')} className='account-form'><label>Website name<TextField size='small' fullWidth name='name' required defaultValue={editingWebsite?.name} placeholder='My company website' /></label><label>Website URL<TextField size='small' fullWidth name='url' type='url' required defaultValue={editingWebsite?.url} slotProps={{ htmlInput: { readOnly: Boolean(editingWebsite) } }} placeholder='https://example.com' /></label><input type='hidden' name='connectionId' value={editingWebsite?.connectionId || ''} /><p>Install the <a href='/wordpress-plugin'>WordPress companion plugin</a> and set up an Application Password. <a href='/help#wp-troubleshooting'>WordPress API help</a></p><label>WordPress username<TextField size='small' fullWidth name='username' required={!editingWebsite?.wordpressConfigured} /></label><label>Application password<TextField size='small' fullWidth name='applicationPassword' type='password' required={!editingWebsite?.wordpressConfigured} /></label><details><summary>Advanced WordPress settings</summary><label>Post type REST base<TextField size='small' fullWidth name='restBase' defaultValue={editingWebsite?.restBase || 'st-jobs'} required /></label><label>ZIP ACF field<TextField size='small' fullWidth name='zipAcfField' defaultValue={editingWebsite?.zipAcfField || 'my_zip_codes'} required /></label></details><Button variant='contained' className='primary' disabled={busy}>{editingWebsite ? 'Save website changes' : 'Save website'}</Button></form>{websites.length > 0 && <Button disabled={busy || !websites[0]?.wordpressConfigured} onClick={async () => {setBusy(true);setValidationError(undefined);setValidationSuccess('');try {const response=await accountFetch('/api/onboarding/validate-website',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({websiteId:selected||websites[0]!.id})});const body=await response.json() as {error?:string;helpUrl?:string};if(!response.ok){setValidationError({message:body.error||'Website validation failed.',helpUrl:body.helpUrl||'/help#wp-troubleshooting'});return;}await refresh(user,session!.csrfToken!);setValidationSuccess('WordPress connection validated. Continue to ServiceTitan setup.');}catch(reason){setValidationError({message:reason instanceof Error?reason.message:'Website validation failed.',helpUrl:'/help#wp-troubleshooting'});}finally{setBusy(false);}}}>{busy?'Checking WordPress…':'Validate website'}</Button>}{validationSuccess&&<p className='notice' role='status'>{validationSuccess}</p>}{validationError&&<p className='notice error' role='alert'>{validationError.message} <a href={validationError.helpUrl}>Troubleshooting help</a></p>}<Button disabled={!onboarding?.websiteReady} onClick={()=>{setOnboardingStage(2);window.sessionStorage.setItem('onboarding-stage','2');setValidationError(undefined);setValidationSuccess('');}}>Continue to Step 2</Button></section>}
              {onboardingStage === 3 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 3 of 3 · Optional</p><h2>Invite people to your account</h2><p>You can invite teammates now or skip this and start using the jobs workspace.</p><TeamSettings role={user.role} workspaceId={user.workspaceId} /><Button variant='contained' className='primary' onClick={()=>window.location.assign('/')}>Start using Jobs</Button><Button onClick={()=>window.location.assign('/')}>Skip for now</Button></section>}
              {onboardingStage === 2 && <section className='panel account-panel onboarding-step'><p className='eyebrow'>Step 2 of 3</p><h2>Connect ServiceTitan</h2><p>Enter API credentials and verify Jobs read permission. <a href='/help#st-troubleshooting'>ServiceTitan setup help</a></p>{connections.map(connection=><p key={connection.id}>{connection.name} · {connection.environment} · Tenant {connection.tenantId} <Button onClick={()=>setEditingConnection(connection)}>Edit credentials</Button></p>)}<form key={editingConnection?.id || 'stage-connection'} onSubmit={(event)=>void submit(event,'connections')} className='account-form'><label>Connection name<TextField size='small' fullWidth name='name' required defaultValue={editingConnection?.name} placeholder='My ServiceTitan account'/></label><div className='account-field-pair'><label>Environment<Select size='small' sx={{width:'100%'}} name='environment' defaultValue={editingConnection?.environment||'integration'}><MenuItem value='integration'>Integration</MenuItem><MenuItem value='production'>Production</MenuItem></Select></label><label>Tenant ID<TextField size='small' fullWidth name='tenantId' required defaultValue={editingConnection?.tenantId} slotProps={{htmlInput:{pattern:'[0-9]{1,20}',readOnly:Boolean(editingConnection)}}}/></label></div><label>Client ID<TextField size='small' fullWidth name='clientId' required={!editingConnection} placeholder={editingConnection?'Saved — leave blank to keep':''}/></label><label>Client secret<TextField size='small' fullWidth name='clientSecret' type='password' required={!editingConnection} placeholder={editingConnection?'Saved — leave blank to keep':''}/></label><label>App key<TextField size='small' fullWidth name='appKey' type='password' required={!editingConnection} placeholder={editingConnection?'Saved — leave blank to keep':''}/></label><p className='field-help'>Credentials are encrypted. Saving changed credentials clears their previous validation.</p><Button variant='contained' className='primary' disabled={busy}>{busy?'Saving…':'Save ServiceTitan credentials'}</Button></form>{connections.length>0&&<Button disabled={busy||websites.length===0} onClick={async()=>{setBusy(true);setValidationError(undefined);setValidationSuccess('');try{const connection=editingConnection||connections[0]!;const response=await accountFetch('/api/onboarding/validate-servicetitan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:connection.id})});const body=await response.json() as {error?:string;helpUrl?:string};if(!response.ok){setValidationError({message:body.error||'ServiceTitan validation failed.',helpUrl:body.helpUrl||'/help#st-troubleshooting'});return;}await refresh(user,session!.csrfToken!);setValidationSuccess('ServiceTitan credentials and Jobs read permission validated.');}catch(reason){setValidationError({message:reason instanceof Error?reason.message:'ServiceTitan validation failed.',helpUrl:'/help#st-troubleshooting'});}finally{setBusy(false);}}}>{busy?'Checking ServiceTitan…':'Validate ServiceTitan API'}</Button>}{validationSuccess&&<p className='notice' role='status'>{validationSuccess}</p>}{validationError&&<p className='notice error' role='alert'>{validationError.message} <a href={validationError.helpUrl}>Troubleshooting help</a></p>}<Button disabled={!onboarding?.settingsReady} onClick={()=>{setOnboardingStage(3);window.sessionStorage.setItem('onboarding-stage','3');setValidationError(undefined);setValidationSuccess('');}}>Continue to optional Step 3</Button></section>}
            </div>
            </>
          )}
        </main>
      ) : (
        <div key={`${user.id}:${selected}`}>{!isLocal && !onboarding?.settingsReady ? <main className='account-page'><h1>Complete setup</h1><p>Complete the website and ServiceTitan checks in Settings to open Jobs.</p><Button component='a' href='/settings'>Continue onboarding</Button></main> : children}</div>
      )}
    </>
  );
}
