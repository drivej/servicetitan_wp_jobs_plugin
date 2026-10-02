import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AppNavigation } from './AppNavigation';
import { accountFetch, clearAccountCache, configureApi } from './api';

interface User { id: string; name: string; email: string; jobTokens: number; }
interface Connection { id: string; name: string; environment: string; tenantId: string; }
interface Website { id: string; name: string; url: string; connectionId: string; restBase: string; zipAcfField: string; wordpressConfigured: boolean; }
interface Session { mode: 'saas' | 'local'; testTokensEnabled?: boolean; user?: User; csrfToken?: string; }

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}
export function Workspace({ children }: { children: ReactNode }) {
  const tokenDialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<Session>();
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [editingWebsite, setEditingWebsite] = useState<Website>();

  async function refresh(user: User, token: string) {
    const [connectionResult, siteResult] = await Promise.all([
      accountFetch('/api/connections').then(json<{ connections: Connection[] }>),
      accountFetch('/api/websites').then(json<{ websites: Website[] }>),
    ]);
    setConnections(connectionResult.connections);
    setWebsites(siteResult.websites);
    let saved = '';
    try { saved = window.sessionStorage.getItem(`website:${user.id}`) || ''; } catch { /* optional */ }
    const site = siteResult.websites.find((item) => item.id === saved) || siteResult.websites[0];
    configureApi(user.id, site?.id || '', token);
    setSelected(site?.id || '');
    setLoaded(true);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/api/session', { credentials: 'same-origin' });
        if (!active) return;
        if (response.status === 401) { setSignedOut(true); return; }
        const current = await json<Session>(response);
        if (!active) return;
        setSession(current);
        if (current.mode === 'local') { configureApi('local', '', ''); setLoaded(true); return; }
        if (!current.user || !current.csrfToken) throw new Error('Invalid session response.');
        configureApi(current.user.id, '', current.csrfToken);
        await refresh(current.user, current.csrfToken);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load your account.'); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (session?.mode !== 'saas') return;
    let active = true;
    let revision = 0;
    const refreshBalance = async () => {
      const current = ++revision;
      try {
        const updated = await accountFetch('/api/session').then(json<Session>);
        if (active && current === revision) setSession(updated);
      } catch { /* Keep the last confirmed balance; the API still enforces spending. */ }
    };
    const update = () => { void refreshBalance(); };
    const exhausted = () => tokenDialog.current?.showModal();
    window.addEventListener('job-tokens-exhausted', exhausted);
    window.addEventListener('job-tokens-changed', update);
    window.addEventListener('focus', update);
    const interval = window.setInterval(update, 30_000);
    return () => { active = false; window.removeEventListener('job-tokens-exhausted', exhausted); window.clearInterval(interval); window.removeEventListener('job-tokens-changed', update); window.removeEventListener('focus', update); };
  }, [session?.mode]);

  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const currentPage = path === '/wordpress-plugin' ? 'plugin' : path === '/wordpress-integration' ? 'guide' : path === '/' || path.startsWith('/jobs/') ? 'jobs' : undefined;
  const jobsHref = currentPage === 'jobs' ? `/${window.location.search}` : '/';

  if (signedOut) return <main className="account-page login-page">
    <p className="eyebrow">ServiceTitan Jobs</p><h1>Turn completed jobs into local stories.</h1>
    <p className="intro">Connect your ServiceTitan account, review project copy, and publish it to your WordPress websites.</p>
    {new URLSearchParams(window.location.search).get('login') === 'failed' && <p className="notice error" role="alert">Sign-in could not be completed. Please try again.</p>}
    <a className="account-primary-link" href="/auth/google">Continue with Google</a>
    <p className="field-help">Your websites and integrations stay private to your account.</p>
  </main>;
  if (!loaded) return <main className="account-page"><h1>ServiceTitan Jobs</h1><p role={error ? 'alert' : 'status'}>{error || 'Loading your workspace…'}</p>{error && <button onClick={() => window.location.reload()}>Try again</button>}</main>;
  if (session?.mode === 'local') return <><header className="workspace-bar"><a className="workspace-brand" href="/">ServiceTitan Jobs</a><span className="local-mode-note">Local workspace</span><AppNavigation current={currentPage} jobsHref={jobsHref} /></header>{children}</>;
  const user = session!.user!;
  const tokensPage = path === '/add-tokens';
  const accountPage = !tokensPage && (path === '/account' || websites.length === 0);

  const chooseSite = (id: string) => {
    configureApi(user.id, id, session!.csrfToken!);
    try { window.sessionStorage.setItem(`website:${user.id}`, id); } catch { /* optional */ }
    setSelected(id);
    // Old job IDs and filters should not carry into another tenant's detail page.
    window.location.assign('/');
  };
  const addTestToken = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      await accountFetch('/api/tokens/test-credit', { method: 'POST' }).then(json);
      window.dispatchEvent(new Event('job-tokens-changed'));
      setMessage('1 test token added.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add a test token.'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError('');
    try {
      const response = await accountFetch('/api/logout', { method: 'POST' });
      if (!response.ok) await json(response);
      clearAccountCache(user.id); configureApi('signed-out', '', ''); window.location.assign('/');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign out failed.'); setBusy(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>, kind: 'connections' | 'websites') => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) || '').trim();
    const editing = kind === 'connections' ? editingConnection : editingWebsite;
    const body = kind === 'connections'
      ? { name: field('name'), environment: field('environment'), tenantId: field('tenantId'), clientId: field('clientId'), clientSecret: field('clientSecret'), appKey: field('appKey') }
      : { name: field('name'), connectionId: field('connectionId'), url: field('url'), restBase: field('restBase'), zipAcfField: field('zipAcfField'),
          ...(field('username') || field('applicationPassword') ? { wordpress: { username: field('username'), applicationPassword: field('applicationPassword') } } : {}) };
    try {
      await accountFetch(`/api/${kind}${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
      if (kind === 'connections' && editingConnection && field('environment') !== editingConnection.environment) clearAccountCache(user.id);
      form.reset(); setEditingConnection(undefined); setEditingWebsite(undefined);
      await refresh(user, session!.csrfToken!);
      setMessage(kind === 'connections' ? 'ServiceTitan connection saved.' : 'Website saved. Open Jobs to verify the connection and review your content.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save.'); }
    finally { setBusy(false); }
  };

  return <>
    <header className="workspace-bar">
      <a className="workspace-brand" href="/">ServiceTitan Jobs</a>
      {websites.length > 0 && <label className="workspace-selector"><span>Website</span><select aria-label="Active website" value={selected} onChange={(event) => chooseSite(event.target.value)}>{websites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label>}
      <span className="workspace-tokens" role="status" title="Each successful push, rebuild, or AI description costs 1 job token.">{user.jobTokens.toLocaleString()} job tokens available</span>
      <AppNavigation current={accountPage ? undefined : currentPage} jobsHref={jobsHref} />
      <nav aria-label="Account"><a href="/add-tokens" aria-current={tokensPage ? 'page' : undefined}>Add Tokens</a><a href="/account" aria-current={accountPage ? 'page' : undefined}>Settings</a><button disabled={busy} onClick={() => void logout()}>Sign out</button></nav>
    </header>
    {error && <p className="notice error account-notice" role="alert">{error}</p>}
    <dialog ref={tokenDialog} className="error-modal token-dialog" aria-labelledby="token-dialog-title" aria-describedby="token-dialog-description">
      <h2 id="token-dialog-title">No job tokens available</h2>
      <p id="token-dialog-description">Add tokens to push a post, rebuild a post, or generate an AI description. Your request has not been completed.</p>
      <div className="account-actions"><a className="account-primary-link" href="/add-tokens">Add Tokens</a><button onClick={() => tokenDialog.current?.close()}>Close</button></div>
    </dialog>
    {tokensPage ? <main className="account-page">
      <p className="eyebrow">Your workspace</p><h1>Add Tokens</h1>
      <p className="intro">Use job tokens to publish posts, rebuild posts, and generate AI descriptions.</p>
      <section className="panel account-panel">
        <h2>{user.jobTokens.toLocaleString()} job tokens available</h2>
        <p>Each successful action costs 1 token. Failed requests do not spend tokens.</p>
        <p>Token purchases are coming soon.</p>
        {session?.testTokensEnabled && <><h3>Testing</h3><p>Add one free token at a time to test the application. No payment is required.</p><button className="primary" disabled={busy} onClick={() => void addTestToken()}>{busy ? 'Adding…' : 'Add 1 test token'}</button></>}
        {message && <p className="notice" role="status">{message}</p>}
      </section>
    </main> : accountPage ? <main className="account-page">
      <p className="eyebrow">Your workspace</p><h1>{websites.length ? 'Settings' : `Welcome, ${user.name.split(' ')[0]}.`}</h1>
      <p className="intro">{websites.length ? 'Manage the connections that power your project stories.' : 'Add a ServiceTitan connection, then connect your first website.'}</p>
      <p className="field-help">Signed in as {user.email}</p>
      <p>Each successful push, rebuild, or AI description generation costs 1 job token. Failed requests do not spend tokens.</p>
      {message && <p className="notice" role="status">{message}</p>}
      <div className="account-grid">
        <section className="panel account-panel"><p className="eyebrow">1 · Source</p><h2>ServiceTitan connections</h2>
          <ul className="account-resource-list">{connections.map((connection) => <li key={connection.id}><div><strong>{connection.name}</strong><small>{connection.environment} · Tenant {connection.tenantId}</small></div><button onClick={() => { setEditingConnection(connection); setMessage(''); }}>Update credentials</button></li>)}</ul>
          <form key={editingConnection?.id || 'new-connection'} onSubmit={(event) => void submit(event, 'connections')} className="account-form">
            <h3>{editingConnection ? `Update ${editingConnection.name}` : 'Add a connection'}</h3>
            <label>Name<input name="name" required maxLength={100} defaultValue={editingConnection?.name} placeholder="My service business" /></label>
            <div className="account-field-pair"><label>Environment<select name="environment" defaultValue={editingConnection?.environment || 'integration'}><option value="integration">Integration</option><option value="production">Production</option></select></label>
            <label>Tenant ID<input name="tenantId" required pattern="[0-9]{1,20}" defaultValue={editingConnection?.tenantId} readOnly={Boolean(editingConnection)} /></label></div>
            <label>Client ID<input name="clientId" required={!editingConnection} placeholder={editingConnection ? 'Saved — leave blank to keep' : undefined} maxLength={500} autoComplete="off" /></label>
            <label>Client secret<input name="clientSecret" type="password" required={!editingConnection} placeholder={editingConnection ? 'Saved — leave blank to keep' : undefined} maxLength={2000} autoComplete="new-password" /></label>
            <label>App key<input name="appKey" type="password" required={!editingConnection} placeholder={editingConnection ? 'Saved — leave blank to keep' : undefined} maxLength={2000} autoComplete="new-password" /></label>
            <p className="field-help">Credentials are encrypted and are not displayed again. When updating the same environment, leave a credential blank to keep its saved value. To switch environments, enter all three credentials for the new environment. The change applies to every website using this connection; existing WordPress posts are not changed. Saving does not test ServiceTitan access.</p>
            <div className="account-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save connection'}</button>{editingConnection && <button type="button" onClick={() => setEditingConnection(undefined)}>Cancel</button>}</div>
          </form>
        </section>
        <section className="panel account-panel"><p className="eyebrow">2 · Destination</p><h2>Websites</h2>
          <ul className="account-resource-list">{websites.map((site) => <li key={site.id}><div><strong>{site.name}</strong><small>{site.url}</small><small>{site.wordpressConfigured ? 'WordPress credentials saved' : 'WordPress credentials needed'}</small></div><button onClick={() => setEditingWebsite(site)}>Edit</button></li>)}</ul>
          {connections.length === 0 ? <p className="notice">Save a ServiceTitan connection first.</p> : <form key={editingWebsite?.id || 'new-site'} onSubmit={(event) => void submit(event, 'websites')} className="account-form">
            <h3>{editingWebsite ? `Edit ${editingWebsite.name}` : 'Add a website'}</h3>
            <label>Name<input name="name" required maxLength={100} defaultValue={editingWebsite?.name} placeholder="My company website" /></label>
            <label>Website URL<input name="url" type="url" required defaultValue={editingWebsite?.url} readOnly={Boolean(editingWebsite)} placeholder="https://example.com" /></label>
            <label>ServiceTitan connection<select name="connectionId" defaultValue={editingWebsite?.connectionId || connections[0]?.id}>{connections.filter((connection) => !editingWebsite || connection.id === editingWebsite.connectionId).map((connection) => <option value={connection.id} key={connection.id}>{connection.name}</option>)}</select></label>
            <p className="field-help">Install the <a href="/downloads/servicetitan-job-integration-1.18.0.zip" download>WordPress plugin</a> and Advanced Custom Fields, then enter a dedicated WordPress Application Password.</p>
            <label>WordPress username<input name="username" maxLength={100} autoComplete="off" /></label>
            <label>Application password<input name="applicationPassword" type="password" maxLength={500} autoComplete="new-password" /></label>
            {editingWebsite?.wordpressConfigured && <p className="field-help">Leave both fields blank to keep existing WordPress credentials.</p>}
            <details><summary>WordPress settings</summary><label>Post type REST base<input name="restBase" defaultValue={editingWebsite?.restBase || 'st-jobs'} required /></label><label>ZIP ACF field<input name="zipAcfField" defaultValue={editingWebsite?.zipAcfField || 'my_zip_codes'} required /></label></details>
            <div className="account-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save website'}</button>{editingWebsite && <button type="button" onClick={() => setEditingWebsite(undefined)}>Cancel</button>}</div>
          </form>}
        </section>
      </div>
    </main> : <div key={`${user.id}:${selected}`}>{children}</div>}
  </>;
}
