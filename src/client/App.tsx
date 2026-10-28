import { ScanHistory } from './ScanHistory';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import { JobScanner, type JobScannerHandle } from './JobScanner';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Switch, IconButton, Pagination, Paper, TextField } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuildTask } from '../shared/build-queue';
import { SEO_GENERATOR_VERSION } from '../shared/seo-prompt-version';
import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { apiFetch, wordpressStatusStorage } from './api';

import { ErrorDialog } from './ErrorDialog';
import { LoadingModal } from './LoadingModal';
import { PageHeader } from './PageHeader';
import { jobDetailsUrl, jobsListUrl, parseJobsSearch, type JobFilters } from './jobsSearch';
import { navigateTo } from './navigation';
import { showTokenError, useTokensExhausted } from './tokenState';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { isSeoPromptOutOfSync, readCachedWordPressStatuses, writeCachedWordPressStatuses, type WordPressStatus } from './wordpressStatusCache';
import { useTokenSpendConfirmation } from './TokenSpendConfirmation';

interface JobsResponse {
  data: JobTableItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCount?: number;
}
interface ActionError {
  title: string;
  message: string;
}
type WordPressWritableStatus = 'draft' | 'publish';
const unknownWordPressStatus: WordPressStatus = { state: 'unknown', label: 'Unknown' };

const toDateInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const initialRange = (): JobFilters => {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return { start: toDateInput(start), end: toDateInput(end), zip: '' };
};

export function App() {
  const [search,setSearch] = useState(() => parseJobsSearch(window.location.search, initialRange()));
  const [view,setView] = useState<'browse'|'scout'|'history'>(()=>window.location.pathname==='/job-scanner' || new URLSearchParams(window.location.search).get('view')==='scout'?'scout':'browse');
  const [draftRange, setDraftRange] = useState<JobFilters>(search.filters);
  const [result, setResult] = useState<JobsResponse>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [wordpressStatuses, setWordpressStatuses] = useState<Record<number, WordPressStatus>>({});
  const [busyWordpressJobs, setBusyWordpressJobs] = useState<Set<number>>(() => new Set());
  const [buildTasks, setBuildTasks] = useState<Record<number, BuildTask>>({});
  const [queueingJobs, setQueueingJobs] = useState<Set<number>>(() => new Set());
  const [queueError, setQueueError] = useState('');
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [actionError, setActionError] = useState<ActionError>();
  const { status: wordpressPluginStatus, loading: wordpressPluginLoading, ready: wordpressPluginReady } = useWordPressPluginStatus();
  const wordpressPluginUpdateRequired = wordpressPluginStatus?.state === 'update_required';
  const tokensExhausted = useTokensExhausted();
  const { confirmTokenSpend, tokenSpendDialog } = useTokenSpendConfirmation();
  const scannerControl=useRef<JobScannerHandle>(null);
  const [scoutInfoOpen,setScoutInfoOpen] = useState(false);


  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ start: search.filters.start, end: search.filters.end, page: String(search.page), pageSize: String(search.pageSize) });
        if (search.filters.useDateRange===false) params.set('allDates','true');
        if (search.filters.zip) params.set('zip', search.filters.zip);
        const response = await apiFetch(`/api/jobs?${params}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
        const body = await readApiResponse<JobsResponse | { error?: string }>(response, 'Unable to load jobs.');
        if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to load jobs.');
        setResult(body as JobsResponse);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setResult(undefined);
        setError(requestError instanceof Error ? requestError.message : 'Unable to load jobs.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [search]);

  useEffect(() => {
    if (!result?.data.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await apiFetch('/api/build-deploy/statuses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobIds: result.data.map((job) => job.id) }),
          signal: controller.signal
        });
        const body = await readApiResponse<{ tasks: BuildTask[]; error?: string }>(response, 'Unable to check build progress.');
        if (!response.ok) throw new Error(body.error || 'Unable to check build progress.');
        if (controller.signal.aborted) return;
        setQueueError('');
        setBuildTasks(Object.fromEntries(body.tasks.map((task) => [task.jobId, task])));
        // Read live status once per completed task so a saved queue result
        // cannot overwrite later WordPress edits.
        if (wordpressPluginReady)
          for (const task of body.tasks) {
            if (task.state === 'succeeded' && !observed.has(task.id)) {
              observed.add(task.id);
              void requestWordpress(task.jobId);
            }
          }
      } catch (error) {
        if (!controller.signal.aborted) setQueueError(error instanceof Error ? error.message : 'Unable to check build progress.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    };
    const observed = new Set<string>();
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [result, wordpressPluginReady]);

  const enqueueBuild = async (jobId: number) => {
    setQueueingJobs((current) => new Set(current).add(jobId));
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/build-deploy`, { method: 'POST' });
      const body = await readApiResponse<BuildTask & { error?: string }>(response, 'Unable to queue build.');
      if (!response.ok) throw new Error(body.error || 'Unable to queue build.');
      setBuildTasks((current) => ({ ...current, [jobId]: body }));
    } catch (error) {
      setActionError({ title: 'Build and deploy failed', message: error instanceof Error ? error.message : 'Unable to queue build.' });
    } finally {
      setQueueingJobs((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
    }
  };

  const pageCount = useMemo(() => (result?.totalCount === undefined ? undefined : Math.max(1, Math.ceil(result.totalCount / result.pageSize))), [result]);

  const setWordpressBusy = (jobId: number, busy: boolean) => {
    setBusyWordpressJobs((current) => {
      const next = new Set(current);
      if (busy) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  };

  const requestWordpress = async (jobId: number) => {
    setWordpressBusy(jobId, true);
    setActionError(undefined);
    setWordpressStatuses((current) => ({
      ...current,
      [jobId]: {
        ...(current[jobId] || unknownWordPressStatus),
        label: 'Loading…'
      }
    }));
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
      const body = await readApiResponse<WordPressStatus | { error?: string }>(response, 'WordPress could not complete the request.');
      if (!response.ok) {
        throw new Error('error' in body && body.error ? body.error : 'WordPress could not complete the request.');
      }
      const wordpressStatus = body as WordPressStatus;
      setWordpressStatuses((current) => ({ ...current, [jobId]: wordpressStatus }));
      writeCachedWordPressStatuses({ [jobId]: wordpressStatus }, wordpressStatusStorage());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'WordPress could not complete the request.';
      setWordpressStatuses((current) => ({
        ...current,
        [jobId]: {
          state: 'unknown',
          label: 'Unknown',
          message
        }
      }));
      setActionError({
        title: 'Could not refresh WordPress status',
        message
      });
    } finally {
      setWordpressBusy(jobId, false);
    }
  };

  const updateWordpressStatus = async (jobId: number, status: WordPressWritableStatus) => {
    if (!wordpressPluginReady) {
      setActionError({ title: 'WordPress plugin update required', message: 'Install the required companion plugin from the WordPress plugin tab before using WordPress actions.' });
      return;
    }
    const previousStatus = wordpressStatuses[jobId] || unknownWordPressStatus;
    setWordpressBusy(jobId, true);
    setActionError(undefined);
    setWordpressStatuses((current) => ({
      ...current,
      [jobId]: {
        ...(current[jobId] || unknownWordPressStatus),
        label: 'Updating…'
      }
    }));
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/status`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const body = await readApiResponse<WordPressStatus | { error?: string }>(response, 'WordPress could not update the post status.');
      if (!response.ok) {
        throw new Error('error' in body && body.error ? body.error : 'WordPress could not update the post status.');
      }
      const wordpressStatus = body as WordPressStatus;
      setWordpressStatuses((current) => ({ ...current, [jobId]: wordpressStatus }));
      writeCachedWordPressStatuses({ [jobId]: wordpressStatus }, wordpressStatusStorage());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'WordPress could not update the post status.';
      setWordpressStatuses((current) => ({
        ...current,
        [jobId]: previousStatus
      }));
      setActionError({ title: 'Could not update WordPress status', message });
    } finally {
      setWordpressBusy(jobId, false);
    }
  };

  const trashWordpressPost = async (jobId: number) => {
    if (!wordpressPluginReady) return;
    const previousStatus = wordpressStatuses[jobId] || unknownWordPressStatus;
    setWordpressBusy(jobId, true);
    setActionError(undefined);
    setWordpressStatuses((current) => ({ ...current, [jobId]: { ...previousStatus, label: 'Moving to Trash…' } }));
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/trash`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await readApiResponse<WordPressStatus | { error?: string }>(response, 'WordPress could not move the post to Trash.');
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'WordPress could not move the post to Trash.');
      const status = body as WordPressStatus;
      setWordpressStatuses((current) => ({ ...current, [jobId]: status }));
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'WordPress could not move the post to Trash.';
      setWordpressStatuses((current) => ({ ...current, [jobId]: previousStatus }));
      setActionError({ title: 'Could not move post to Trash', message });
    } finally {
      setWordpressBusy(jobId, false);
    }
  };

  const updateWordpressSeo = async (jobId: number, currentStatus: WordPressStatus) => {
    const serviceTitanModifiedOn = result?.data.find((job) => job.id === jobId)?.modifiedOn;
    if (!wordpressPluginReady || !isSeoPromptOutOfSync(currentStatus, serviceTitanModifiedOn)) return;
    if (tokensExhausted) { showTokenError(); return; }
    const force = currentStatus.seoState === 'modified';
    if (force && !window.confirm('This post was edited in WordPress. Updating will replace its title, excerpt, and content with copy generated by the latest AI prompt. Continue?')) return;
    if (!(await confirmTokenSpend('update'))) return;
    setWordpressBusy(jobId, true);
    setActionError(undefined);
    setWordpressStatuses((current) => ({ ...current, [jobId]: { ...currentStatus, label: 'Updating…' } }));
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/regenerate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      if (response.status === 402) {
        setWordpressStatuses((current) => ({ ...current, [jobId]: currentStatus }));
        return;
      }
      const body = await readApiResponse<WordPressStatus | { error?: string }>(response, 'WordPress could not update the post.');
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'WordPress could not update the post.');
      const status = body as WordPressStatus;
      setWordpressStatuses((current) => ({ ...current, [jobId]: status }));
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'WordPress could not update the post.';
      setWordpressStatuses((current) => ({ ...current, [jobId]: { ...currentStatus, label: currentStatus.postStatus === 'publish' ? 'Published' : 'Unknown', message } }));
      setActionError({ title: 'Could not update WordPress post', message });
    } finally {
      setWordpressBusy(jobId, false);
    }
  };

  const refreshWordpressStatuses = async (jobIds: number[], options: { showBulkProgress: boolean; reportError: boolean }) => {
    if (jobIds.length === 0) return;

    if (options.showBulkProgress) setBulkRefreshing(true);
    if (options.reportError) setActionError(undefined);
    setBusyWordpressJobs((current) => new Set([...current, ...jobIds]));
    setWordpressStatuses((current) => {
      const next = { ...current };
      for (const jobId of jobIds) next[jobId] = { ...(current[jobId] || unknownWordPressStatus), label: 'Loading…' };
      return next;
    });

    try {
      const response = await apiFetch('/api/wordpress/statuses', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds })
      });
      const body = await readApiResponse<{ statuses: Record<number, WordPressStatus> } | { error?: string }>(response, 'WordPress could not refresh page statuses.');
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'WordPress could not refresh page statuses.');
      const refreshedStatuses = (body as { statuses: Record<number, WordPressStatus> }).statuses;
      setWordpressStatuses((current) => ({ ...current, ...refreshedStatuses }));
      writeCachedWordPressStatuses(refreshedStatuses, wordpressStatusStorage());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'WordPress could not refresh page statuses.';
      setWordpressStatuses((current) => {
        const next = { ...current };
        for (const jobId of jobIds) next[jobId] = { state: 'unknown', label: 'Unknown', message };
        return next;
      });
      if (options.reportError) setActionError({ title: 'Could not refresh WordPress statuses', message });
    } finally {
      setBusyWordpressJobs((current) => {
        const next = new Set(current);
        for (const jobId of jobIds) next.delete(jobId);
        return next;
      });
      if (options.showBulkProgress) setBulkRefreshing(false);
    }
  };

  const refreshPageWordpressStatuses = async () => {
    const jobIds = result?.data.map((job) => job.id) || [];
    await refreshWordpressStatuses(jobIds, { showBulkProgress: true, reportError: true });
  };

  useEffect(() => {
    const jobIds = result?.data.map((job) => job.id) || [];
    if (jobIds.length === 0) return;

    const cached = readCachedWordPressStatuses(jobIds, wordpressStatusStorage(), Date.now(), SEO_GENERATOR_VERSION);
    if (Object.keys(cached.statuses).length > 0) {
      setWordpressStatuses((current) => ({ ...current, ...cached.statuses }));
    }

    if (cached.missingJobIds.length > 0) {
      void refreshWordpressStatuses(cached.missingJobIds, { showBulkProgress: false, reportError: true });
    }
  }, [result]);

  return (
    <main className='app-page'>
      <LoadingModal open={loading && view==='browse'} label='Loading ServiceTitan jobs' />
      <PageHeader eyebrow='ServiceTitan Jobs' title='Job search' className='jobs-page-header' />
      <Dialog open={scoutInfoOpen} onClose={()=>setScoutInfoOpen(false)} aria-labelledby='job-scout-info-title' aria-describedby='job-scout-info-description'>
        <DialogTitle id='job-scout-info-title'>AI Job Scout</DialogTitle>
        <DialogContent>
          <h3>Your next great post is already in your job history.</h3>
          <p id='job-scout-info-description'>Let AI find promising completed jobs and turn the best matches into WordPress drafts—ready for your review.</p>
          <p>AI Job Scout uses the same appointment date range and ZIP search as Browse jobs. It skips jobs already in WordPress and prepares up to five drafts. You choose what to publish.</p>
          <p>1 token per scan, plus 1 token per draft created (up to 6 tokens total). You’ll approve the spend before the scan starts.</p>
        </DialogContent>
        <DialogActions><Button onClick={()=>setScoutInfoOpen(false)}>Got it</Button></DialogActions>
      </Dialog>


      {wordpressPluginLoading ? (
        <Alert severity='info' role='status'>
          Checking WordPress plugin compatibility…
        </Alert>
      ) : (
        !wordpressPluginReady &&
        !wordpressPluginUpdateRequired && (
          <Alert severity='warning' role='alert'>
            <div>
              <strong>{wordpressPluginStatus?.state === 'update_required' ? 'WordPress plugin update required' : 'WordPress plugin could not be verified'}</strong>
              <span>
                {wordpressPluginStatus?.installedVersion ? `Installed ${wordpressPluginStatus.installedVersion}; ` : ''}
                required {wordpressPluginStatus?.requiredVersion || '1.20.3'}. WordPress actions are disabled.
              </span>
            </div>
            <a href='/wordpress-plugin'>Open plugin setup</a>
          </Alert>
        )
      )}

      <Paper component='section' variant='outlined' className='panel' aria-labelledby='filters-heading'>
        <form className='job-search-form' onSubmit={event=>{event.preventDefault();const nextView=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')==='scout'?'scout':'browse';if(nextView==='scout'){void scannerControl.current?.start(draftRange);return;}const next={...search,filters:draftRange,page:1};setSearch(next);setView(nextView);window.history.replaceState(null,'',jobsListUrl(next));}}>
          <div className='job-search-date-range'>
            <div className='job-search-dates-toggle'>
              <label htmlFor='job-search-use-dates'>Use Dates</label>
              <div className='job-search-switch-control'><Switch slotProps={{input:{id:'job-search-use-dates'}}} checked={draftRange.useDateRange!==false} onChange={event=>setDraftRange(current=>({...current,useDateRange:event.target.checked}))}/></div>
            </div>
            <label>
              <span>Start date</span>
              <TextField fullWidth name='start' type='date' required={draftRange.useDateRange!==false} disabled={draftRange.useDateRange===false} size='small' value={draftRange.start} slotProps={{ htmlInput: { max: draftRange.end } }} onChange={(event) => setDraftRange((current) => ({ ...current, start: event.target.value }))} />
            </label>
            <label>
              <span>End date</span>
              <TextField fullWidth name='end' type='date' required={draftRange.useDateRange!==false} disabled={draftRange.useDateRange===false} size='small' value={draftRange.end} slotProps={{ htmlInput: { min: draftRange.start } }} onChange={(event) => setDraftRange((current) => ({ ...current, end: event.target.value }))} />
            </label>
          </div>
          <label>
            <span>ZIP code</span>
            <TextField
              fullWidth
              name={draftRange.zip ? 'zip' : undefined}
              type='text'
              size='small'
              slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '\\d{5}(-\\d{4})?' } }}
              autoComplete='postal-code'
              placeholder='Optional'
              value={draftRange.zip}
              onChange={(event) => setDraftRange((current) => ({ ...current, zip: event.target.value.trim() }))}
            />
          </label>
          <input name='pageSize' type='hidden' value={search.pageSize} />
          <div className='job-search-actions'>
            <Button variant='contained' className='primary' type='submit' value='browse' disabled={loading}>Search</Button>
            <Button variant='contained' className='job-scout-button' type='submit' value='scout' disabled={!wordpressPluginReady} startIcon={<AutoAwesomeRoundedIcon aria-hidden='true'/>}>AI Job Scout</Button>
            <IconButton type='button' className='scout-history-button' aria-label='Previous scans' title='Previous scans' onClick={()=>setView('history')}><FormatListBulletedIcon/></IconButton>
            <IconButton aria-label='About AI Job Scout' title='About AI Job Scout' onClick={()=>setScoutInfoOpen(true)}><InfoOutlinedIcon/></IconButton>
          </div>
        </form>
      </Paper>

      <ScanHistory open={view==='history'}/>
      <JobScanner searchFilters={search.filters} controlRef={scannerControl} onShow={()=>setView('scout')} visible={view==='scout'}/>
      <section style={view!=='browse'?{display:'none'}:undefined} className='results' aria-labelledby='results-heading' aria-busy={loading}>
        <div className='results-header'>
          <div>
            {/* <p className='page-label'>Results</p> */}
            {/* <h2 id='results-heading'>{result?.totalCount === undefined ? 'Service jobs' : `${result.totalCount.toLocaleString()} service ${result.totalCount === 1 ? 'job' : 'jobs'}`}</h2> */}
          </div>
          {result && (
            <div className='results-actions'>
              {/* {result.data.length > 0 && (
                <Button className={`bulk-refresh-button${bulkRefreshing ? ' is-spinning' : ''}`} type='button' disabled={!wordpressPluginReady || loading || bulkRefreshing || busyWordpressJobs.size > 0} onClick={() => void refreshPageWordpressStatuses()}>
                  <RefreshIcon />
                  {bulkRefreshing ? 'Refreshing…' : 'Refresh page statuses'}
                </Button>
              )} */}
              <p className='page-label'>
                Page {result.page}
                {pageCount ? ` of ${pageCount}` : ''}
              </p>
            </div>
          )}
        </div>

        {!loading && !error && result?.data.length === 0 && <div className='notice'>No jobs matched this search.</div>}

        {!error && result && result.data.length > 0 && (
          <div className='table-wrap'>
            <table className='jobs-table'>
              <colgroup>
                <col className='readiness-column' />
                <col className='job-image-column' />
                <col className='job-name-column' />
                <col className='location-column' />
                <col className='wp-status-column' />
                <col className='actions-column' />
              </colgroup>
              <JobTableHeader refreshing={bulkRefreshing} disabled={loading || bulkRefreshing || busyWordpressJobs.size > 0} onRefresh={() => void refreshPageWordpressStatuses()} />
              <tbody>
                {result.data.map((job) => (
                  <JobTableRow
                    key={job.id}
                    job={job}
                    wordpressStatus={wordpressStatuses[job.id] || unknownWordPressStatus}
                    wordpressBusy={busyWordpressJobs.has(job.id) || queueingJobs.has(job.id) || buildTasks[job.id]?.state === 'queued' || buildTasks[job.id]?.state === 'running'}
                    buildTask={buildTasks[job.id]}
                    queueError={queueError}
                    wordpressPluginReady={wordpressPluginReady}
                    tokensExhausted={tokensExhausted}
                    onOpen={() => navigateTo(jobDetailsUrl(job.id))}
                    onBuild={() => {
                      if (tokensExhausted) {
                        showTokenError();
                        return;
                      }
                      if (wordpressPluginReady && !queueError) void enqueueBuild(job.id);
                    }}
                    onPublish={() => void updateWordpressStatus(job.id, 'publish')}
                    onSetDraft={() => void updateWordpressStatus(job.id, 'draft')}
                    onTrash={() => void trashWordpressPost(job.id)}
                    onUpdate={() => void updateWordpressSeo(job.id, wordpressStatuses[job.id] || unknownWordPressStatus)}
                    onRefresh={() => void requestWordpress(job.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && !error && <Pagination className='pagination' aria-label='Jobs pages' count={pageCount ?? Math.max(search.page, result.hasMore ? search.page + 1 : search.page)} page={search.page} color='primary' shape='rounded' onChange={(_event, page) => navigateTo(jobsListUrl(search, page))} />}
      </section>

      {actionError && (
        <div className='modal-backdrop' role='presentation'>
          <section className='error-modal' role='alertdialog' aria-modal='true' aria-labelledby='wordpress-error-title' aria-describedby='wordpress-error-message'>
            <div className='error-modal-icon' aria-hidden='true'>
              !
            </div>
            <h2 id='wordpress-error-title'>{actionError.title}</h2>
            <p id='wordpress-error-message'>{actionError.message}</p>
            <Button type='button' variant='contained' className='primary' autoFocus onClick={() => setActionError(undefined)}>
              Close
            </Button>
          </section>
        </div>
      )}
      <ErrorDialog
        message={error || queueError}
        onClose={() => {
          setError('');
          setQueueError('');
        }}
        title={queueError && !error ? 'Unable to check build progress' : error.includes('No job tokens available') ? 'No job tokens available' : undefined}
        actionHref={error.includes('No job tokens available') || queueError.includes('No job tokens available') ? '/add-tokens' : undefined}
        actionLabel='Add Tokens'
        detail={queueError ? 'Builds already queued continue on the server.' : undefined}
      />
      {tokenSpendDialog}
    </main>
  );
}

async function readApiResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${fallbackMessage} The app server returned an empty response (HTTP ${response.status}). Restart the app server and try again.`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${fallbackMessage} The app server returned an invalid response (HTTP ${response.status}). Restart the app server and try again.`);
  }
}
