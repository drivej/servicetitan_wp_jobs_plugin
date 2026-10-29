import { Alert, Pagination, Paper } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { apiFetch, enqueueWordPressTrash, enqueueWordPressUnlink } from './api';
import { PageHeader } from './PageHeader';
import { useTokensExhausted } from './tokenState';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import type { WordPressStatus } from './wordpressStatusCache';

interface WordPressJob {
  jobId: number;
  postId: number;
  title: string;
  excerpt: string;
  status: string;
  modifiedOn: string;
  completedOn: string;
  location: { city: string; state: string; zip: string };
  featuredImageUrl: string;
  featuredImageAlt: string;
  link: string;
}

interface WordPressJobsResponse {
  posts: WordPressJob[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

const perPage = 25;
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to load WordPress jobs.');
  return body as T;
}

export function WordPressJobs() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<WordPressJobsResponse>();
  const [statuses, setStatuses] = useState<Record<number, WordPressStatus>>({});
  const [loading, setLoading] = useState(true);
  const [busyJob, setBusyJob] = useState<number>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const plugin = useWordPressPluginStatus();
  const tokensExhausted = useTokensExhausted();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void (async () => {
      const body = await read<WordPressJobsResponse>(await apiFetch(`/api/wordpress/jobs?page=${page}&perPage=${perPage}`, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      setResult(body);
      if (!body.posts.length) { setStatuses({}); return; }
      const ids = body.posts.map((post) => post.jobId);
      const live = await read<{ statuses: Record<number, WordPressStatus> }>(await apiFetch('/api/wordpress/statuses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobIds: ids }), signal: controller.signal,
      }));
      if (!controller.signal.aborted) setStatuses(live.statuses);
    })().catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load WordPress jobs.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, retry]);

  const refreshStatuses = useCallback(async (ids = result?.posts.map((post) => post.jobId) || []) => {
    if (!ids.length) { setRetry((value) => value + 1); return; }
    setError('');
    try {
      const live = await read<{ statuses: Record<number, WordPressStatus> }>(await apiFetch('/api/wordpress/statuses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobIds: ids }),
      }));
      setStatuses((current) => ({ ...current, ...live.statuses }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to refresh WordPress statuses.'); }
  }, [result]);

  const setPostStatus = async (jobId: number, status: 'draft' | 'publish') => {
    setBusyJob(jobId); setError('');
    try {
      const updated = await read<WordPressStatus>(await apiFetch(`/api/jobs/${jobId}/wordpress/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      }));
      setStatuses((current) => ({ ...current, [jobId]: updated }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update the WordPress post status.'); }
    finally { setBusyJob(undefined); }
  };

  const trashPost = async (jobId: number) => {
    setBusyJob(jobId); setError('');
    try {
      const updated = await read<WordPressStatus>(await enqueueWordPressTrash(jobId));
      setStatuses((current) => ({ ...current, [jobId]: updated }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to move the post to Trash.'); }
    finally { setBusyJob(undefined); }
  };

  const unlinkPost = async (jobId: number) => {
    setBusyJob(jobId); setError('');
    try {
      await read<WordPressStatus>(await enqueueWordPressUnlink(jobId));
      setRetry((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to remove the WordPress draft.'); }
    finally { setBusyJob(undefined); }
  };

  const jobs: JobTableItem[] = (result?.posts || []).map((post) => ({
    id: post.jobId,
    wordpressRecord: true,
    wordpressFeaturedImageUrl: post.featuredImageUrl,
    wordpressFeaturedImageAlt: post.featuredImageAlt,
    jobName: post.title || `ServiceTitan job ${post.jobId}`,
    ...(post.excerpt ? { descriptionPreview: post.excerpt } : {}),
    status: post.status,
    ...(post.completedOn ? { completedOn: post.completedOn } : {}),
    location: {
      city: post.location?.city || '—',
      state: post.location?.state || '—',
      zip: post.location?.zip || '—',
    },
  }));

  return <main className='app-page wordpress-jobs-page'>
    <PageHeader eyebrow='WordPress' title='WordPress Jobs' description='Jobs that already have a post on your WordPress website.' />
    {error && <Alert severity='error'>{error}</Alert>}
    <Paper component='section' variant='outlined' className='panel wordpress-jobs-panel' aria-label='WordPress jobs'>
      <div className='wordpress-jobs-summary' aria-live='polite'>
        {loading ? 'Loading WordPress jobs…' : `${result?.total ?? 0} ${result?.total === 1 ? 'job' : 'jobs'}`}
      </div>
      {!loading && !error && !jobs.length && <p>No WordPress job posts found.</p>}
      {!!jobs.length && <div className='table-wrap'><table className='jobs-table'>
        <caption className='visually-hidden'>ServiceTitan jobs with existing WordPress posts</caption>
        <colgroup><col className='readiness-column'/><col className='job-image-column'/><col className='job-name-column'/><col className='location-column'/><col className='wp-status-column'/><col className='actions-column'/></colgroup>
        <JobTableHeader refreshing={loading} disabled={loading || busyJob !== undefined} onRefresh={() => void refreshStatuses()} />
        <tbody>{jobs.map((job) => <JobTableRow
          key={job.id}
          job={job}
          wordpressStatus={statuses[job.id] || { state: 'unknown', label: loading ? 'Loading…' : 'Unknown' }}
          wordpressBusy={busyJob === job.id || loading}
          wordpressPluginReady={plugin.ready}
          tokensExhausted={tokensExhausted}
          onPublish={() => setPostStatus(job.id, 'publish')}
          onSetDraft={() => setPostStatus(job.id, 'draft')}
          onTrash={() => trashPost(job.id)}
          onUnlink={() => unlinkPost(job.id)}
          onRefresh={() => void refreshStatuses([job.id])}
        />)}</tbody>
      </table></div>}
      {(result?.totalPages || 0) > 1 && <Pagination className='pagination' aria-label='WordPress jobs pages' count={result!.totalPages} page={page} color='primary' shape='rounded' disabled={loading || busyJob !== undefined} onChange={(_event, nextPage) => setPage(nextPage)} />}
    </Paper>
  </main>;
}
