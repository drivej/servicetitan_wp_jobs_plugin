import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Chip, IconButton, Paper, TextField, Typography } from '@mui/material';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import LinkIcon from '@mui/icons-material/Link';
import type { BuildTask } from '../shared/build-queue';
import { JobThumbnail } from './JobThumbnail';
import { apiFetch, wordpressStatusStorage } from './api';

import { jobDetailsUrl, jobsListUrl, parseJobsSearch, type JobFilters } from './jobsSearch';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { readCachedWordPressStatuses, writeCachedWordPressStatuses, type WordPressStatus } from './wordpressStatusCache';
import { ErrorDialog } from './ErrorDialog';

interface JobItem {
  id: number;
  attachments?: Array<{ id: string; fileName: string }>;
  sourceCopyStatus?: 'missing' | 'limited' | 'available';
  jobName: string;
  status: string;
  location: { city: string; state: string; zip: string };
}
interface JobsResponse {
  data: JobItem[];
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
type StatusChipColor = 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning';
const unknownWordPressStatus: WordPressStatus = { state: 'unknown', label: 'Unknown' };

const serviceTitanStatusColor = (status: string): StatusChipColor => {
  const normalized = status.toLowerCase();
  if (/completed|complete|success|closed/.test(normalized)) return 'success';
  if (/cancel|failed|error|void/.test(normalized)) return 'error';
  if (/progress|dispatched|started|working/.test(normalized)) return 'info';
  if (/scheduled|hold|pending|on.?hold/.test(normalized)) return 'warning';
  return 'default';
};

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
    window.location.assign(jobDetailsUrl(jobId, search));
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
      <header className='hero'>
        {/* <p className='eyebrow'>ServiceTitan workspace</p> */}
        <Typography variant="h3" component="h1">ServiceTitan Jobs Search</Typography>
        {/* <p className='intro'>Choose an inclusive date range to find completed jobs and their service locations.</p> */}
      </header>

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
                required {wordpressPluginStatus?.requiredVersion || '1.18.0'}. WordPress actions are disabled.
              </span>
            </div>
            <a href='/wordpress-plugin'>Open plugin setup</a>
          </Alert>
        )
      )}

      <Paper component='section' variant='outlined' className='panel' aria-labelledby='filters-heading'>
        {/* <h2 id='filters-heading'>Date range</h2> */}
        <form className='job-search-form' action='/' method='get'>
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
            <p className='page-label'>Results</p>
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
                <col className='job-image-column' />
                <col className='job-name-column' />
                <col className='location-column' />
                <col className='st-status-column' />
                <col className='wp-status-column' />
                <col className='actions-column' />
              </colgroup>
              <thead>
                <tr>
                  <th scope='colgroup' colSpan={2}>
                    Job
                  </th>
                  <th scope='col'>
                    Location
                  </th>
                  <th scope='col'>ST status</th>
                  <th scope='col'>
                    WordPress
                  </th>
                  <th scope='col' className='actions-heading'>
                    <div className='actions-heading-content'>
                      <span>ACTIONS</span>
                      <IconButton
                        size='small'
                        title='Refresh all WordPress statuses'
                        aria-label='Refresh all WordPress statuses'
                        className={bulkRefreshing ? 'is-spinning' : undefined}
                        disabled={!wordpressPluginReady || loading || bulkRefreshing || busyWordpressJobs.size > 0}
                        onClick={() => void refreshPageWordpressStatuses()}
                      >
                        <RefreshIcon />
                      </IconButton>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((job) => {
                  const wordpressStatus = wordpressStatuses[job.id] || unknownWordPressStatus;
                  const buildTask = buildTasks[job.id];
                  const buildBusy = queueingJobs.has(job.id) || buildTask?.state === 'queued' || buildTask?.state === 'running';
                  const wordpressBusy = busyWordpressJobs.has(job.id) || buildBusy;
                  const wordpressDisplayLabel = wordpressStatus.state === 'not_found' ? 'None' : wordpressStatus.label;
                  const wordpressStatusLabel = wordpressStatus.state === 'exists'
                    ? wordpressStatus.postStatus === 'publish' ? 'Published' : wordpressStatus.postStatus === 'draft' ? 'Draft' : wordpressStatus.label
                    : wordpressDisplayLabel;
                  const wordpressStatusColor: StatusChipColor = wordpressStatus.state === 'not_found'
                    ? 'default'
                    : wordpressStatus.state === 'unknown'
                      ? wordpressStatus.label.toLowerCase().includes('loading') ? 'info' : 'error'
                      : wordpressStatus.postStatus === 'publish' ? 'success' : wordpressStatus.postStatus === 'draft' ? 'warning' : 'default';
                  const detailsHref = jobDetailsUrl(job.id, search);
                  const openJobDetails = () => window.location.assign(detailsHref);
                  return (
                    <tr
                      key={job.id}
                      className='job-row'
                      tabIndex={0}
                      aria-label={`Open ${job.jobName} details`}
                      onClick={openJobDetails}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openJobDetails();
                        }
                      }}
                    >
                      <td className='job-image-cell' data-label='Image'>
                        <JobThumbnail key={`${job.id}:${job.attachments?.map((image) => image.id).join(',')}`} jobId={job.id} jobName={job.jobName} attachments={job.attachments || []} />
                      </td>
                      <td className='job-name-cell' data-label='Job'>
                        <div className='job-name' title={job.jobName}>
                          {job.jobName}
                        </div>
                        {wordpressStatus.state !== 'exists' && job.sourceCopyStatus && (
                          <span className={`source-copy-status source-${job.sourceCopyStatus}`} title='Basic summary check: missing, fewer than 20 words, or at least 20 words. Review the source before generating copy.'>
                            {job.sourceCopyStatus === 'missing' ? 'Missing source copy' : job.sourceCopyStatus === 'limited' ? 'Limited source copy' : 'Source copy available'}
                          </span>
                        )}
                      </td>
                      <td className='location-cell' data-label='Location'>
                        <div className='location-cell-city' title={`${job.location.city}, ${job.location.state}`}>
                          {job.location.city}, {job.location.state}
                        </div>
                        <span>{job.location.zip}</span>
                      </td>
                      <td className='st-status-cell' data-label='ST status'>
                        <Chip size='small' color={serviceTitanStatusColor(job.status)} label={job.status} />
                      </td>
                      <td className='wp-status-cell' data-label='WordPress'>
                        <Chip
                          size='small'
                          color={wordpressStatusColor}
                          label={wordpressStatusLabel}
                          title={wordpressStatus.message}
                        />
                      </td>
                      <td className='actions-cell' data-label='Actions'>
                        <div className='row-actions'>
                          {wordpressStatus.state === 'exists' && wordpressStatus.link && (
                            <Button component='a' href={wordpressStatus.link} target='_blank' rel='noreferrer' startIcon={<LinkIcon />} onClick={(event) => event.stopPropagation()}>
                              View post
                            </Button>
                          )}
                          {wordpressStatus.state === 'not_found' && (
                            <Button variant='contained' color='primary' className='build-deploy-button' type='button'
                              disabled={!wordpressPluginReady || wordpressBusy || Boolean(queueError)}
                              title='Generate copy, select the first available image, and create a WordPress draft. Uses 2 job tokens.'
                              onClick={(event) => { event.stopPropagation(); void enqueueBuild(job.id); }}>
                              {buildTask?.state === 'running' ? 'Building…' : buildBusy ? 'Queued…' : 'Build draft'}
                            </Button>
                          )}
                          {buildTask?.state === 'failed' && <span className='build-deploy-error' role='status'>{buildTask.error}</span>}

                          {wordpressStatus.state === 'exists' && wordpressStatus.postStatus === 'draft' && (
                            <Button variant='contained' className='primary' type='button' disabled={!wordpressPluginReady || wordpressBusy} onClick={(event) => { event.stopPropagation(); void updateWordpressStatus(job.id, 'publish'); }}>
                              {wordpressBusy && wordpressStatus.label === 'Updating…' ? 'Publishing…' : 'Publish post'}
                            </Button>
                          )}
                          {wordpressStatus.state === 'exists' && wordpressStatus.postStatus === 'publish' && (
                            <Button
                              className={`regenerate-button rebuild-${rebuildUpdateLevel(wordpressStatus)}`}
                              type='button'
                              disabled={!wordpressPluginReady || wordpressBusy || wordpressStatus.seoState === 'newer'}
                              title={rebuildButtonDescription(wordpressStatus)}
                              onClick={(event) => { event.stopPropagation(); void regenerateWordpress(job.id, wordpressStatus); }}
                            >
                              {wordpressBusy && wordpressStatus.label === 'Regenerating…' ? 'Regenerating…' : 'Rebuild'}
                            </Button>
                          )}
                          <IconButton size='small' className={`icon-button${wordpressBusy ? ' is-spinning' : ''}`} type='button' aria-label={`Refresh WordPress status for ${job.jobName}`} title='Refresh WordPress post status' disabled={!wordpressPluginReady || wordpressBusy} onClick={(event) => { event.stopPropagation(); void requestWordpress(job.id); }}>
                            <RefreshIcon />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {result && !error && (
          <nav className='pagination' aria-label='Jobs pages'>
            {search.page > 1 ? (
              <Button component='a' className='pagination-link' href={jobsListUrl(search, search.page - 1)}>
                Previous
              </Button>
            ) : (
              <Button className='pagination-link' disabled>Previous</Button>
            )}
            <span>Page {search.page}</span>
            {result.hasMore ? (
              <Button component='a' className='pagination-link' href={jobsListUrl(search, search.page + 1)}>
                Next
              </Button>
            ) : (
              <Button className='pagination-link' disabled>Next</Button>
            )}
          </nav>
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

const RefreshIcon = () => <RefreshRoundedIcon fontSize="small" aria-hidden="true" />;

type RebuildUpdateLevel = 'unnecessary' | 'minor' | 'major' | 'required';

function rebuildUpdateLevel(status: WordPressStatus): RebuildUpdateLevel {
  if (status.seoState === 'current' || status.seoState === 'newer') return 'unnecessary';
  if (status.seoState === 'legacy' || !status.seoVersion) return 'required';
  const versionGap = (status.currentSeoVersion || status.seoVersion) - status.seoVersion;
  if (versionGap <= 0) return 'unnecessary';
  if (versionGap === 1) return 'minor';
  if (versionGap === 2) return 'major';
  return 'required';
}

function rebuildButtonDescription(status: WordPressStatus): string {
  if (status.seoState === 'newer') return 'Unavailable: this post was generated by a newer app version.';
  const level = rebuildUpdateLevel(status);
  if (level === 'unnecessary') {
    return status.seoState === 'modified' ? 'Rebuild is unnecessary for the current SEO version. This post was manually edited in WordPress.' : 'Rebuild is unnecessary. This post uses the current SEO version.';
  }
  const versionChange = status.seoVersion && status.currentSeoVersion ? ` SEO v${status.seoVersion} → v${status.currentSeoVersion}.` : '';
  if (level === 'minor') return `Minor update available.${versionChange}`;
  if (level === 'major') return `Major update available.${versionChange}`;
  return `Required update.${versionChange || ' This post predates SEO version tracking.'}`;
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
