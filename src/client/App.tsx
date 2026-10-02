import { apiFetch, wordpressStatusStorage } from './api';
import { useEffect, useMemo, useState } from 'react';

import { jobDetailsUrl, jobsListUrl, parseJobsSearch, type JobFilters } from './jobsSearch';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { readCachedWordPressStatuses, writeCachedWordPressStatuses, type WordPressStatus } from './wordpressStatusCache';

interface JobItem {
  id: number;
  jobNumber: string;
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
        <h3>ServiceTitan Jobs Search</h3>
        {/* <p className='intro'>Choose an inclusive date range to find completed jobs and their service locations.</p> */}
      </header>

      {wordpressPluginLoading ? (
        <div className='plugin-compatibility-banner' role='status'>
          Checking WordPress plugin compatibility…
        </div>
      ) : (
        !wordpressPluginReady &&
        !wordpressPluginUpdateRequired && (
          <div className='plugin-compatibility-banner warning' role='alert'>
            <div>
              <strong>{wordpressPluginStatus?.state === 'update_required' ? 'WordPress plugin update required' : 'WordPress plugin could not be verified'}</strong>
              <span>
                {wordpressPluginStatus?.installedVersion ? `Installed ${wordpressPluginStatus.installedVersion}; ` : ''}
                required {wordpressPluginStatus?.requiredVersion || '1.18.0'}. WordPress actions are disabled.
              </span>
            </div>
            <a href='/wordpress-plugin'>Open plugin setup</a>
          </div>
        )
      )}

      <section className='panel' aria-labelledby='filters-heading'>
        {/* <h2 id='filters-heading'>Date range</h2> */}
        <form action='/' method='get'>
          <label>
            <span>Start date</span>
            <input name='start' type='date' required value={draftRange.start} max={draftRange.end} onChange={(event) => setDraftRange((current) => ({ ...current, start: event.target.value }))} />
          </label>
          <label>
            <span>End date</span>
            <input name='end' type='date' required value={draftRange.end} min={draftRange.start} onChange={(event) => setDraftRange((current) => ({ ...current, end: event.target.value }))} />
          </label>
          <label>
            <span>ZIP code</span>
            <input name={draftRange.zip ? 'zip' : undefined} type='text' inputMode='numeric' autoComplete='postal-code' placeholder='Optional' pattern='\d{5}(-\d{4})?' value={draftRange.zip} onChange={(event) => setDraftRange((current) => ({ ...current, zip: event.target.value.trim() }))} />
          </label>
          <input name='pageSize' type='hidden' value={search.pageSize} />
          <button className='primary' type='submit' disabled={loading}>
            {loading ? 'Loading…' : 'Find jobs'}
          </button>
        </form>
      </section>

      <section className='results' aria-labelledby='results-heading' aria-busy={loading}>
        <div className='results-header'>
          <div>
            <p className='page-label'>Results</p>
            {/* <h2 id='results-heading'>{result?.totalCount === undefined ? 'Service jobs' : `${result.totalCount.toLocaleString()} service ${result.totalCount === 1 ? 'job' : 'jobs'}`}</h2> */}
          </div>
          {result && (
            <div className='results-actions'>
              {/* {result.data.length > 0 && (
                <button className={`bulk-refresh-button${bulkRefreshing ? ' is-spinning' : ''}`} type='button' disabled={!wordpressPluginReady || loading || bulkRefreshing || busyWordpressJobs.size > 0} onClick={() => void refreshPageWordpressStatuses()}>
                  <RefreshIcon />
                  {bulkRefreshing ? 'Refreshing…' : 'Refresh page statuses'}
                </button>
              )} */}
              <p className='page-label'>
                Page {result.page}
                {pageCount ? ` of ${pageCount}` : ''}
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className='notice error' role='alert'>
            {error}
          </div>
        )}
        {loading && (
          <div className='notice' role='status'>
            Loading ServiceTitan jobs…
          </div>
        )}
        {!loading && !error && result?.data.length === 0 && <div className='notice'>No jobs were found in this appointment date range.</div>}

        {!error && result && result.data.length > 0 && (
          <div className='table-wrap'>
            <table className='jobs-table'>
              <colgroup>
                <col className='job-number-column' />
                <col className='job-name-column' />
                <col className='state-column' />
                <col className='zip-column' />
                <col className='city-column' />
                <col className='st-status-column' />
                <col className='wp-status-column' />
                <col className='wp-link-column' />
                <col className='actions-column' />
                <col className='refresh-column' />
              </colgroup>
              <thead>
                <tr>
                  <th scope='colgroup' colSpan={2}>Job</th>
                  <th scope='colgroup' colSpan={3}>Location</th>
                  <th scope='col'>ST status</th>
                  <th scope='colgroup' colSpan={2}>WordPress</th>
                  <th scope='col'>
                    <span className='visually-hidden'>Job actions</span>
                  </th>
                  <th scope='col'>
                    <span className='visually-hidden'>Refresh status</span>
                    <button title='Refresh all' aria-label='Refresh all WordPress statuses' className={`icon-button Xbulk-refresh-button${bulkRefreshing ? ' is-spinning' : ''}`} type='button' disabled={!wordpressPluginReady || loading || bulkRefreshing || busyWordpressJobs.size > 0} onClick={() => void refreshPageWordpressStatuses()}>
                      <RefreshIcon />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((job) => {
                  const wordpressStatus = wordpressStatuses[job.id] || unknownWordPressStatus;
                  const wordpressBusy = busyWordpressJobs.has(job.id);
                  const wordpressDisplayLabel = wordpressStatus.state === 'not_found' ? 'None' : wordpressStatus.label;
                  const wordpressStatusValue = wordpressStatus.label === 'Loading…' || wordpressStatus.label === 'Updating…' ? '' : wordpressStatus.postStatus === 'draft' || wordpressStatus.postStatus === 'publish' ? wordpressStatus.postStatus : '';
                  return (
                    <tr key={job.id}>
                      <td className='job-cell job-number-cell' data-label='Job #'>
                        <b>#{job.jobNumber}</b>
                        {/* <strong>{job.jobName}</strong>
                        <span className='job-number'>#{job.jobNumber}</span> */}
                      </td>
                      <td className='job-name-cell' data-label='Job'><div className='job-name' title={job.jobName}>{job.jobName}</div></td>
                      <td className='location-cell state-cell' data-label='State'>
                        {/* <strong>{job.location.city}</strong> */}
                        {/* <span> */}
                          {job.location.state}
                        {/* </span> */}
                      </td>
                      <td className='location-cell zip-cell' data-label='ZIP'>{job.location.zip}</td>
                      <td className='location-cell city-cell' data-label='City'><div className='location-cell-city' title={job.location.city}>
                        {job.location.city}
                      </div></td>
                      <td className='st-status-cell' data-label='ST status'>
                        <span className='status'>{job.status}</span>
                      </td>
                      <td className='wp-status-cell' data-label='WordPress'>
                        <div className='wordpress-status' title={wordpressStatus.message}>
                          <select
                            className='wp-status-select'
                            aria-label={`WordPress status for ${job.jobName}`}
                            value={wordpressStatusValue}
                            disabled={!wordpressPluginReady || wordpressBusy || wordpressStatus.state !== 'exists'}
                            onChange={(event) => void updateWordpressStatus(job.id, event.target.value as WordPressWritableStatus)}
                          >
                            {wordpressStatusValue === '' && <option value=''>{wordpressDisplayLabel}</option>}
                            {wordpressStatus.state === 'exists' && <option value='draft'>Draft</option>}
                            {wordpressStatus.state === 'exists' && <option value='publish'>Published</option>}
                          </select>
                          {/* <button
                            className={`icon-button${wordpressBusy ? ' is-spinning' : ''}`}
                            type="button"
                            aria-label={`Refresh WordPress status for ${job.jobName}`}
                            title="Refresh WordPress post status"
                            disabled={!wordpressPluginReady || wordpressBusy}
                            onClick={() => void requestWordpress(job.id)}
                          >
                            <RefreshIcon />
                          </button> */}
                        </div>
                      </td>
                      <td className='wp-link-cell' data-label='WordPress post'>
                        {wordpressStatus.state === 'exists' && wordpressStatus.link && (
                          <a className='wordpress-view-link' href={wordpressStatus.link} target='_blank' rel='noreferrer' aria-label='View post' title='View post'>
                            <LinkIcon />
                          </a>
                        )}
                      </td>
                      <td className='actions-cell' data-label='Actions'>
                        <div className='row-actions'>
                          {wordpressStatus.state === 'exists' && (
                            <button
                              className={`regenerate-button rebuild-${rebuildUpdateLevel(wordpressStatus)}`}
                              type='button'
                              disabled={!wordpressPluginReady || wordpressBusy || wordpressStatus.seoState === 'newer'}
                              title={rebuildButtonDescription(wordpressStatus)}
                              onClick={() => void regenerateWordpress(job.id, wordpressStatus)}
                            >
                              {wordpressBusy && wordpressStatus.label === 'Regenerating…' ? 'Regenerating…' : 'Rebuild'}
                            </button>
                          )}
                          <a className='details-button' href={jobDetailsUrl(job.id, search)}>
                            Details
                          </a>
                        </div>
                      </td>
                      <td className='refresh-cell' data-label='Refresh'>
                        <button className={`icon-button${wordpressBusy ? ' is-spinning' : ''}`} type='button' aria-label={`Refresh WordPress status for ${job.jobName}`} title='Refresh WordPress post status' disabled={!wordpressPluginReady || wordpressBusy} onClick={() => void requestWordpress(job.id)}>
                          <RefreshIcon />
                        </button>
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
              <a className='pagination-link' href={jobsListUrl(search, search.page - 1)}>
                Previous
              </a>
            ) : (
              <span className='pagination-link is-disabled' aria-disabled='true'>
                Previous
              </span>
            )}
            <span>Page {search.page}</span>
            {result.hasMore ? (
              <a className='pagination-link' href={jobsListUrl(search, search.page + 1)}>
                Next
              </a>
            ) : (
              <span className='pagination-link is-disabled' aria-disabled='true'>
                Next
              </span>
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
            <button type='button' className='primary' autoFocus onClick={() => setActionError(undefined)}>
              Close
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden='true' viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M20 6v5h-5' />
      <path d='M4 18v-5h5' />
      <path d='M18.4 9A7 7 0 0 0 6.1 6.1L4 8' />
      <path d='M5.6 15A7 7 0 0 0 17.9 17.9L20 16' />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden='true' viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' />
      <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' />
    </svg>
  );
}

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
