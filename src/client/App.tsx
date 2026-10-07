import { Alert, Button, Pagination, Paper, TextField } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { BuildTask } from '../shared/build-queue';
import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { apiFetch, wordpressStatusStorage } from './api';

import { ErrorDialog } from './ErrorDialog';
import { jobDetailsUrl, jobsListUrl, parseJobsSearch, type JobFilters } from './jobsSearch';
import { showTokenError, useTokensExhausted } from './tokenState';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { readCachedWordPressStatuses, writeCachedWordPressStatuses, type WordPressStatus } from './wordpressStatusCache';
import { PageHeader } from './PageHeader';

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
  const search = useMemo(() => parseJobsSearch(window.location.search, initialRange()), []);
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

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ start: search.filters.start, end: search.filters.end, page: String(search.page), pageSize: String(search.pageSize) });
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
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobIds: result.data.map((job) => job.id) }), signal: controller.signal,
        });
        const body = await readApiResponse<{ tasks: BuildTask[]; error?: string }>(response, 'Unable to check build progress.');
        if (!response.ok) throw new Error(body.error || 'Unable to check build progress.');
        if (controller.signal.aborted) return;
        setQueueError('');
        setBuildTasks(Object.fromEntries(body.tasks.map((task) => [task.jobId, task])));
        // Read live status once per completed task so a saved queue result
        // cannot overwrite later WordPress edits.
        if (wordpressPluginReady) for (const task of body.tasks) {
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
    return () => { controller.abort(); clearTimeout(timer); };
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
      setQueueingJobs((current) => { const next = new Set(current); next.delete(jobId); return next; });
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
    if (!wordpressPluginReady) {
      setActionError({ title: 'WordPress plugin update required', message: 'Install the required companion plugin from the WordPress plugin tab before using WordPress actions.' });
      return;
    }
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
        [jobId]: { state: 'unknown', label: 'Unknown', message }
      }));
      setActionError({ title: 'Could not update WordPress status', message });
    } finally {
      setWordpressBusy(jobId, false);
    }
  };

  const regenerateWordpress = async (jobId: number, currentStatus: WordPressStatus) => {
    if (!wordpressPluginReady || currentStatus.state !== 'exists') return;
    window.location.assign(jobDetailsUrl(jobId));
    return;
  };

  const refreshWordpressStatuses = async (jobIds: number[], options: { showBulkProgress: boolean; reportError: boolean }) => {
    if (!wordpressPluginReady || jobIds.length === 0) return;

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

    const cached = readCachedWordPressStatuses(jobIds, wordpressStatusStorage(), Date.now(), wordpressPluginStatus?.seoGeneratorVersion);
    if (Object.keys(cached.statuses).length > 0) {
      setWordpressStatuses((current) => ({ ...current, ...cached.statuses }));
    }

    if (wordpressPluginReady && cached.missingJobIds.length > 0) {
      void refreshWordpressStatuses(cached.missingJobIds, { showBulkProgress: false, reportError: false });
    }
  }, [result, wordpressPluginReady, wordpressPluginStatus?.seoGeneratorVersion]);

  return (
    <main>
      <PageHeader eyebrow='ServiceTitan Jobs' title='Job search' />

      {wordpressPluginLoading ? (
        <Alert severity="info" sx={{ mb: 2 }} role='status'>
          Checking WordPress plugin compatibility…
        </Alert>
      ) : (
        !wordpressPluginReady &&
        !wordpressPluginUpdateRequired && (
          <Alert severity="warning" sx={{ mb: 2 }} role='alert'>
            <div>
              <strong>{wordpressPluginStatus?.state === 'update_required' ? 'WordPress plugin update required' : 'WordPress plugin could not be verified'}</strong>
              <span>
                {wordpressPluginStatus?.installedVersion ? `Installed ${wordpressPluginStatus.installedVersion}; ` : ''}
                required {wordpressPluginStatus?.requiredVersion || '1.18.1'}. WordPress actions are disabled.
              </span>
            </div>
            <a href='/wordpress-plugin'>Open plugin setup</a>
          </Alert>
        )
      )}

      <Paper component='section' variant='outlined' className='panel' aria-labelledby='filters-heading'>
        {/* <h2 id='filters-heading'>Date range</h2> */}
        <form className='job-search-form' action='/jobs' method='get'>
          <label>
            <span>Start date</span>
            <TextField name='start' type='date' required size="small" value={draftRange.start} slotProps={{ htmlInput: { max: draftRange.end } }} onChange={(event) => setDraftRange((current) => ({ ...current, start: event.target.value }))} />
          </label>
          <label>
            <span>End date</span>
            <TextField name='end' type='date' required size="small" value={draftRange.end} slotProps={{ htmlInput: { min: draftRange.start } }} onChange={(event) => setDraftRange((current) => ({ ...current, end: event.target.value }))} />
          </label>
          <label>
            <span>ZIP code</span>
            <TextField name={draftRange.zip ? 'zip' : undefined} type='text' size="small" slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '\\d{5}(-\\d{4})?' } }} autoComplete='postal-code' placeholder='Optional' value={draftRange.zip} onChange={(event) => setDraftRange((current) => ({ ...current, zip: event.target.value.trim() }))} />
          </label>
          <input name='pageSize' type='hidden' value={search.pageSize} />
          <Button variant='contained' className='primary' type='submit' disabled={loading}>
            {loading ? 'Loading…' : 'Find jobs'}
          </Button>
        </form>
      </Paper>

      <section className='results' aria-labelledby='results-heading' aria-busy={loading}>
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

        {loading && (
          <Alert severity="info" role='status'>
            Loading ServiceTitan jobs…
          </Alert>
        )}
        {!loading && !error && result?.data.length === 0 && <div className='notice'>No jobs were found in this appointment date range.</div>}

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
              <JobTableHeader refreshing={bulkRefreshing} disabled={!wordpressPluginReady || loading || bulkRefreshing || busyWordpressJobs.size > 0} onRefresh={() => void refreshPageWordpressStatuses()} />
              <tbody>
                {result.data.map((job) => <JobTableRow key={job.id} job={job} wordpressStatus={wordpressStatuses[job.id] || unknownWordPressStatus} wordpressBusy={busyWordpressJobs.has(job.id) || queueingJobs.has(job.id) || buildTasks[job.id]?.state === 'queued' || buildTasks[job.id]?.state === 'running'} buildTask={buildTasks[job.id]} queueError={queueError} wordpressPluginReady={wordpressPluginReady} tokensExhausted={tokensExhausted} onOpen={() => window.location.assign(jobDetailsUrl(job.id))} onBuild={() => { if (tokensExhausted) { showTokenError(); return; } if (wordpressPluginReady && !queueError) void enqueueBuild(job.id); }} onPublish={() => void updateWordpressStatus(job.id, 'publish')} onRebuild={() => void regenerateWordpress(job.id, wordpressStatuses[job.id] || unknownWordPressStatus)} onRefresh={() => void requestWordpress(job.id)} />)}
              </tbody>
            </table>
          </div>
        )}

        {result && !error && (
          <Pagination
            className='pagination'
            aria-label='Jobs pages'
            count={pageCount ?? Math.max(search.page, result.hasMore ? search.page + 1 : search.page)}
            page={search.page}
            color='primary'
            shape='rounded'
            onChange={(_event, page) => window.location.assign(jobsListUrl(search, page))}
          />
        )}
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
        onClose={() => { setError(''); setQueueError(''); }}
        title={queueError && !error ? 'Unable to check build progress' : error.includes('No job tokens available') ? 'No job tokens available' : undefined}
        actionHref={error.includes('No job tokens available') || queueError.includes('No job tokens available') ? '/add-tokens' : undefined}
        actionLabel="Add Tokens"
        detail={queueError ? 'Builds already queued continue on the server.' : undefined}
      />
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
