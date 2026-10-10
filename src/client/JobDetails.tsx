import { Button, Radio, TextField } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { BuildTask } from '../shared/build-queue';
import { ErrorDialog } from './ErrorDialog';
import { JobTableHeader, JobTableRow } from './JobTable';
import { useTokenSpendConfirmation } from './TokenSpendConfirmation';
import { accountFetch, apiFetch, apiUrl, wordpressStatusStorage } from './api';

import { formatJobCopy, hasCompleteJobBody, type GeneratedJobCopy, type JobCopySource } from '../shared/job-copy';
import { showTokenError, useTokensExhausted } from './tokenState';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { isSeoPromptOutOfSync, writeCachedWordPressStatuses, type WordPressStatus } from './wordpressStatusCache';
import { PageHeader } from './PageHeader';
import { LoadingModal } from './LoadingModal';
import { TOKEN_ACTIONS } from '../shared/token-actions';

interface JobAttachment {
  id: string;
  fileName: string;
  contentType: string;
}
interface JobHistoryItem {
  id: string;
  source: 'history' | 'note';
  type: string;
  date: string;
  content: string;
  promptEligible: boolean;
}
interface JobSummary extends JobCopySource {
  id: number;
  jobNumber: string;
  status: string;
  modifiedOn?: string;
}
interface JobDetailsResponse {
  job: Record<string, unknown>;
  summary: JobSummary;
  attachments: JobAttachment[];
  history: JobHistoryItem[];
}
interface JobImageOptionProps {
  attachment: JobAttachment;
  disabled: boolean;
  jobId: number;
  onToggle: () => void;
  onImageState: (id: string, state: 'loaded' | 'error') => void;
  selected: boolean;
}

function JobImageOption({ attachment, disabled, jobId, onToggle, onImageState, selected }: JobImageOptionProps) {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');

  return (
    <label className={`image-option image-${imageState}${selected ? ' selected' : ''}`}>
      <span className='image-preview'>
        {imageState === 'loading' && (
          <span className='image-loader' role='status'>
            <span className='image-loader-spinner' aria-hidden='true' />
            <span className='visually-hidden'>Loading {attachment.fileName}</span>
          </span>
        )}
        {imageState === 'error' && (
          <span className='image-load-error' role='status'>
            Image unavailable
          </span>
        )}
        <img
          src={apiUrl(`/api/jobs/${jobId}/images/${encodeURIComponent(attachment.id)}`)}
          alt={attachment.fileName}
          loading='lazy'
          onLoad={() => {
            setImageState('loaded');
            onImageState(attachment.id, 'loaded');
          }}
          onError={() => {
            setImageState('error');
            onImageState(attachment.id, 'error');
          }}
        />
      </span>
      <span className='image-choice'>
        <Radio name='job-image' checked={selected} disabled={disabled || imageState !== 'loaded'} onChange={onToggle} />
        <span>{attachment.fileName}</span>
      </span>
    </label>
  );
}

export function JobDetails({ jobId }: { jobId: number }) {
  const { confirmTokenSpend, tokenSpendDialog } = useTokenSpendConfirmation();
  const tokensExhausted = useTokensExhausted();
  const jobsHref = `/jobs${window.location.search}`;
  const [details, setDetails] = useState<JobDetailsResponse>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [imageStates, setImageStates] = useState<Record<string, 'loaded' | 'error'>>({});
  const hasValidImage = Boolean(details?.attachments.some((attachment) => imageStates[attachment.id] === 'loaded'));
  const recordImageState = (id: string, state: 'loaded' | 'error') => {
    setImageStates((current) => ({ ...current, [id]: state }));
    if (state === 'error') {
      setSelectedIds((current) => {
        if (!current.includes(id)) return current;
        const nextImage = details?.attachments.find((attachment) => attachment.id !== id && imageStates[attachment.id] === 'loaded');
        return nextImage ? [nextImage.id] : [];
      });
      return;
    }
    setSelectedIds((current) => current.length ? current : [id]);
  };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [buildTask, setBuildTask] = useState<BuildTask>();
  const [queueingBuild, setQueueingBuild] = useState(false);
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [wordpressStatus, setWordpressStatus] = useState<WordPressStatus>();
  const [wordpressStatusLoading, setWordpressStatusLoading] = useState(true);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [rawResponse, setRawResponse] = useState<unknown>();
  const [rawResponseLoading, setRawResponseLoading] = useState(false);
  const [rawResponseError, setRawResponseError] = useState('');
  const [rawResponseCopied, setRawResponseCopied] = useState(false);
  const [aiCopy, setAiCopy] = useState('');
  const [aiCopyEdited, setAiCopyEdited] = useState(false);
  const { ready: wordpressPluginReady, status: wordpressPluginStatus, loading: wordpressPluginStatusLoading } = useWordPressPluginStatus();

  useEffect(() => {
    const controller = new AbortController();
    void accountFetch('/api/session', { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ mode?: string; user?: { isPlatformAdmin?: boolean }; impersonation?: { actor?: { isPlatformAdmin?: boolean } } }> : undefined)
      .then((session) => {
        setIsLocalMode(session?.mode === 'local');
        setIsPlatformAdmin(session?.user?.isPlatformAdmin === true || session?.impersonation?.actor?.isPlatformAdmin === true);
      })
      .catch(() => setIsPlatformAdmin(false));
    return () => controller.abort();
  }, []);

  const loadRawResponse = async () => {
    if (rawResponse !== undefined || rawResponseLoading) return;
    setRawResponseLoading(true);
    setRawResponseError('');
    try {
      if (isLocalMode) {
        const response = await apiFetch(`/api/jobs/${jobId}`, { headers: { Accept: 'application/json' } });
        const body = await readJson<JobDetailsResponse | { error?: string }>(response);
        if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to load the raw ServiceTitan response.');
        setRawResponse((body as JobDetailsResponse).job);
        return;
      }
      const response = await apiFetch(`/api/admin/service-titan/jobs/${jobId}/raw`, { headers: { Accept: 'application/json' } });
      const body = await readJson<{ data?: unknown; error?: string }>(response);
      if (!response.ok) throw new Error(body.error || 'Unable to load the raw ServiceTitan response.');
      setRawResponse(body.data);
    } catch (requestError) {
      setRawResponseError(requestError instanceof Error ? requestError.message : 'Unable to load the raw ServiceTitan response.');
    } finally {
      setRawResponseLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await apiFetch(`/api/jobs/${jobId}`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        const body = await readJson<JobDetailsResponse | { error?: string }>(response);
        if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to load job details.');
        setDetails(body as JobDetailsResponse);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : 'Unable to load job details.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [jobId]);

  useEffect(() => {
    const controller = new AbortController();
    const loadWordPressStatus = async () => {
      setWordpressStatusLoading(true);
      try {
        const response = await apiFetch(`/api/jobs/${jobId}/wordpress`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        const body = await readJson<WordPressStatus | { error?: string }>(response);
        if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to load WordPress status.');
        const status = body as WordPressStatus;
        setWordpressStatus(status);
        writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setWordpressStatus({
          state: 'unknown',
          label: 'Unknown',
          message: requestError instanceof Error ? requestError.message : 'Unable to load WordPress status.'
        });
      } finally {
        if (!controller.signal.aborted) setWordpressStatusLoading(false);
      }
    };
    void loadWordPressStatus();
    return () => controller.abort();
  }, [jobId]);

  const currentFeaturedAttachmentId = useMemo(() => {
    if (!details || wordpressStatus?.state !== 'exists') return undefined;
    if (wordpressStatus.featuredImageAttachmentId && details.attachments.some((attachment) => attachment.id === wordpressStatus.featuredImageAttachmentId)) {
      return wordpressStatus.featuredImageAttachmentId;
    }
    if (!wordpressStatus.featuredImageFileName) return undefined;
    const expectedFileName = comparableUploadedFileName(wordpressStatus.featuredImageFileName);
    return details.attachments.find((attachment) => comparableUploadedFileName(attachment.fileName) === expectedFileName)?.id;
  }, [details, wordpressStatus]);
  useEffect(() => {
    if (currentFeaturedAttachmentId && selectedIds.length === 0) {
      setSelectedIds([currentFeaturedAttachmentId]);
    }
  }, [currentFeaturedAttachmentId, selectedIds.length]);
  useEffect(() => {
    if (wordpressStatus?.state !== 'exists' || aiCopyEdited) return;
    if (wordpressStatus.postTitle === undefined && wordpressStatus.postExcerpt === undefined) return;
    setAiCopy(formatJobCopy({ title: wordpressStatus.postTitle || '', bodyHtml: `<p>${wordpressStatus.postExcerpt || ''}</p><p></p><p></p>` }));
  }, [aiCopyEdited, wordpressStatus]);
  const toggleImage = (attachmentId: string) => {
    setSelectedIds([attachmentId]);
  };
  const generateAiCopy = async () => {
    if (!hasValidImage || generatingCopy) return;
    if (!(await confirmTokenSpend('ai_generation'))) return;
    setGeneratingCopy(true);
    setError('');
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/ai-copy`, {
        method: 'POST',
        headers: { Accept: 'application/json' }
      });
      if (response.status === 402) return;
      const body = await readJson<GeneratedJobCopy & { error?: string }>(response);
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Unable to generate copy.');
      if (!hasCompleteJobBody(body)) throw new Error('The app server returned incomplete generated copy.');
      setAiCopyEdited(true);
      setAiCopy(formatJobCopy(body));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to generate copy.');
    } finally {
      setGeneratingCopy(false);
    }
  };

  const regenerateWordPress = async () => {
    if (!wordpressStatus || !isSeoPromptOutOfSync(wordpressStatus, details?.summary.modifiedOn)) return;
    const force = wordpressStatus.seoState === 'modified';
    const replacingImage = selectedIds.length === 1 && selectedIds[0] !== currentFeaturedAttachmentId;
    if (force && !window.confirm(`This post was edited in WordPress. Updating will replace its title, excerpt, and content with copy generated by the latest AI prompt${replacingImage ? ', and featured image' : ''}. Continue?`)) return;

    if (!(await confirmTokenSpend('update'))) return;
    setRegenerating(true);
    setError('');
    setWordpressStatus({ ...wordpressStatus, label: 'Updating…' });
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/regenerate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          force,
          ...(replacingImage && selectedIds[0] ? { attachmentId: selectedIds[0] } : {}),
        })
      });
      if (response.status === 402) { setWordpressStatus(wordpressStatus); return; }
      const body = await readJson<WordPressStatus | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to update the WordPress post.');
      const status = body as WordPressStatus;
      setWordpressStatus(status);
      setSelectedIds([]);
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      setWordpressStatus({ ...wordpressStatus, label: wordpressStatus.postStatus === 'publish' ? 'Published' : 'Unknown' });
      setError(requestError instanceof Error ? requestError.message : 'Unable to update the WordPress post.');
    } finally {
      setRegenerating(false);
    }
  };

  const refreshWordPressStatus = async () => {
    setWordpressStatusLoading(true);
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress`, { headers: { Accept: 'application/json' } });
      const body = await readJson<WordPressStatus | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to refresh WordPress status.');
      const status = body as WordPressStatus;
      setWordpressStatus(status);
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to refresh WordPress status.');
    } finally {
      setWordpressStatusLoading(false);
    }
  };

  const publishWordPressPost = async () => {
    if (wordpressStatus?.state !== 'exists' || !wordpressPluginReady || publishing) return;
    setPublishing(true);
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/status`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'publish' })
      });
      const body = await readJson<WordPressStatus | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'WordPress could not publish the post.');
      const status = body as WordPressStatus;
      setWordpressStatus(status);
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'WordPress could not publish the post.');
    } finally {
      setPublishing(false);
    }
  };

  const enqueueBuild = async () => {
    if (!wordpressPluginReady || queueingBuild || buildTask?.state === 'queued' || buildTask?.state === 'running') return;
    setQueueingBuild(true);
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/build-deploy`, { method: 'POST' });
      const body = await readJson<BuildTask | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to queue build.');
      setBuildTask(body as BuildTask);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to queue build.');
    } finally {
      setQueueingBuild(false);
    }
  };

  useEffect(() => {
    if (!buildTask || !['queued', 'running'].includes(buildTask.state)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await apiFetch('/api/build-deploy/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobIds: [jobId] }) });
        const body = await readJson<{ tasks: BuildTask[]; error?: string }>(response);
        if (!response.ok) throw new Error(body.error || 'Unable to check build progress.');
        if (cancelled) return;
        const task = body.tasks[0];
        if (task) {
          setBuildTask(task);
          if (task.state === 'succeeded' && task.result) {
            setWordpressStatus(task.result);
            writeCachedWordPressStatuses({ [jobId]: task.result }, wordpressStatusStorage());
          }
        }
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Unable to check build progress.');
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 3000);
      }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [buildTask?.state, jobId]);

  const seoVersionMismatch = wordpressStatus?.state === 'exists'
    && wordpressStatus.seoVersion !== undefined
    && wordpressStatus.currentSeoVersion !== undefined
    && wordpressStatus.seoVersion !== wordpressStatus.currentSeoVersion;
  const seoRegenerationAvailable = Boolean(wordpressStatus && isSeoPromptOutOfSync(wordpressStatus, details?.summary.modifiedOn));
  const versionSyncLabel = wordpressStatusLoading || wordpressPluginStatusLoading
    ? 'Checking…'
    : wordpressStatus?.state !== 'exists'
      ? wordpressStatus?.state === 'not_found' ? 'No associated post' : 'Unavailable'
      : wordpressStatus.seoVersion === undefined
        ? 'SEO version unknown'
        : !wordpressPluginStatus || wordpressPluginStatus.state === 'unknown'
          ? 'Plugin status unavailable'
          : seoVersionMismatch || wordpressPluginStatus?.state === 'update_required'
            ? 'Out of sync'
            : 'In sync';

  return (
    <main className='app-page'>
      <LoadingModal open={loading} label='Loading job details' />
      {tokenSpendDialog}
      <PageHeader
        className='details-hero'
        beforeTitle={<Button component='a' className='back-link' href={jobsHref}>← Back to jobs</Button>}
        eyebrow={`ServiceTitan Job #${details?.summary.jobNumber || jobId}`}
        title={details?.summary.jobName || `ServiceTitan job ${jobId}`}
      />

      <div className='details-sections'>
      {/* <div className='results-header'>
        <p className='page-label'>Job actions</p>
      </div> */}
      {details && <div className='table-wrap'>
        <table className='jobs-table' aria-label='Job list row'>
          <colgroup><col className='readiness-column' /><col className='job-image-column' /><col className='job-name-column' /><col className='location-column' /><col className='wp-status-column' /><col className='actions-column' /></colgroup>
          <JobTableHeader disabled={!wordpressPluginReady || wordpressStatusLoading || publishing || regenerating || queueingBuild} onRefresh={() => void refreshWordPressStatus()} />
          <tbody><JobTableRow job={{ ...details.summary, attachments: details.attachments, sourceCopyStatus: details.summary.summaryText?.trim() ? details.summary.summaryText.trim().split(/\s+/).length < 10 ? 'limited' : 'available' : 'missing' }} wordpressStatus={wordpressStatus || { state: 'unknown', label: wordpressStatusLoading ? 'Loading…' : 'Unknown' }} wordpressBusy={wordpressStatusLoading || publishing || regenerating || queueingBuild || buildTask?.state === 'queued' || buildTask?.state === 'running'} buildTask={buildTask} wordpressPluginReady={wordpressPluginReady} tokensExhausted={tokensExhausted} onBuild={() => { if (tokensExhausted) { showTokenError(); return; } void enqueueBuild(); }} onPublish={() => void publishWordPressPost()} onUpdate={() => { if (tokensExhausted) { showTokenError(); return; } void regenerateWordPress(); }} onRefresh={() => void refreshWordPressStatus()} /></tbody>
        </table>
      </div>}

      {seoRegenerationAvailable && wordpressStatus?.state === 'exists' && <aside className='notice seo-out-of-sync' aria-labelledby='seo-out-of-sync-heading'>
        <div>
          <strong id='seo-out-of-sync-heading'>SEO copy is out of sync</strong>
          <p>{seoVersionMismatch
            ? `This post uses SEO generator v${wordpressStatus.seoVersion}; the current version is v${wordpressStatus.currentSeoVersion}.`
            : 'The ServiceTitan job details have changed since this post was last updated.'}
            {' '}Regenerating updates the post’s SEO copy and costs {TOKEN_ACTIONS.update.cost} token{TOKEN_ACTIONS.update.cost === 1 ? '' : 's'}.
          </p>
          {wordpressStatus.postStatus === 'draft' && <p>You can also publish the current draft as-is. Publishing changes only its WordPress status; it does not regenerate SEO or spend a token.</p>}
        </div>
      </aside>}


      {details && (
        <>
          <section className='panel details-panel' aria-labelledby='images-heading'>
            <div className='details-section-heading'>
              <div>
                <p className='eyebrow'>Attachments</p>
                <h2 id='images-heading'>{wordpressStatus?.state === 'exists' ? 'Replace featured image' : 'Select an image'}</h2>
              </div>
              <div className='image-selection-summary'>
                <span className='selection-count'>
                  {wordpressStatus?.state === 'exists' ? (selectedIds[0] === currentFeaturedAttachmentId && currentFeaturedAttachmentId ? 'Current featured image selected' : selectedIds.length === 1 ? 'New image selected' : 'Keeping current image') : selectedIds.length === 1 ? '1 selected' : 'None selected'}
                </span>
                {wordpressStatus?.state === 'exists' && selectedIds.length === 1 && selectedIds[0] !== currentFeaturedAttachmentId && (
                  <Button type='button' disabled={regenerating} onClick={() => setSelectedIds(currentFeaturedAttachmentId ? [currentFeaturedAttachmentId] : [])}>
                    Keep current image
                  </Button>
                )}
              </div>
            </div>
            <p className='field-help'>
              {wordpressStatus?.state === 'exists' ? 'The current featured image is selected when it can be matched. Choose a different image before updating only if you want to replace it.' : 'The selected image is uploaded to the WordPress Media Library and becomes the generated post’s featured image.'}
            </p>
            {(details.attachments.length === 0 || details.attachments.every((attachment) => imageStates[attachment.id] === 'error')) && (
              <p className='notice' role='status'>
                This job does not qualify to be pushed because it has no working images. Add or restore an image in ServiceTitan, then reload this page to check again.
              </p>
            )}
            <div className='image-grid'>
              {details.attachments.map((attachment) => {
                const selected = selectedIds.includes(attachment.id);
                return <JobImageOption key={attachment.id} attachment={attachment} disabled={regenerating || publishing || queueingBuild} jobId={jobId} onImageState={recordImageState} onToggle={() => toggleImage(attachment.id)} selected={selected} />;
              })}
            </div>
          </section>

          <section className='panel details-panel ai-copy-panel' aria-labelledby='ai-copy-heading'>
            <div>
              <p className='eyebrow'>AI-assisted copy</p>
              <h2 id='ai-copy-heading'>Prepare the complete post</h2>
            </div>
            <p>
              <Button variant='contained' className='primary generate-copy-button token-cost' type='button' disabled={generatingCopy || !hasValidImage} aria-disabled={generatingCopy || tokensExhausted || !hasValidImage} title={!hasValidImage ? 'This job needs at least one working image before generating copy.' : `Uses ${TOKEN_ACTIONS.ai_generation.cost} job token.`} onClick={() => { if (tokensExhausted) { showTokenError(); return; } void generateAiCopy(); }}>
                {generatingCopy ? 'Generating…' : 'Generate Copy'}
              </Button>
            </p>
            <label className='ai-output'>
              <span>AI-generated post copy</span>
              <TextField
                variant='outlined'
                size='small'
                fullWidth
                multiline
                aria-label='AI-generated post copy'
                rows={16}
                slotProps={{ htmlInput: { maxLength: 6000 } }}
                placeholder={'TITLE: Service Performed in City, ST\nBODY:\n<p>Opening paragraph describing the work and location.</p>\n<p>Original problem or project goal.</p>\n<p>Documented work and result.</p>'}
                value={aiCopy}
                onChange={(event) => {
                  setAiCopyEdited(true);
                  setAiCopy(event.target.value);
                }}
              />
              <span className='ai-output-meta'>
                <span>
                  {wordpressStatus?.state === 'exists'
                    ? 'The current title and excerpt are loaded from WordPress. Update generates fresh copy with the latest AI prompt before sending it to WordPress.'
                    : 'Build creates the initial draft and generates its copy automatically. Use TITLE: and BODY: with WordPress-ready paragraph HTML when preparing an SEO update.'}
                </span>
                <span>{aiCopy.length}/6000</span>
              </span>
            </label>
          </section>
        </>
      )}
      </div>
      {isPlatformAdmin && <section className='superadmin-debug-panel' aria-labelledby='superadmin-debug-heading'>
        <div className='superadmin-debug-banner'><strong>SUPER ADMIN CONTENT</strong><span>Visible to the signed-in platform administrator</span></div>
        <h2 id='superadmin-versions-heading'>WordPress post versions</h2>
        <dl className='superadmin-version-list' aria-labelledby='superadmin-versions-heading'>
          <div><dt>SEO generator on this post</dt><dd>{wordpressStatus?.state === 'exists' ? wordpressStatus.seoVersion ?? 'Unknown / legacy post' : wordpressStatus?.state === 'not_found' ? 'No WordPress post' : 'Unavailable'}</dd></div>
          <div><dt>Current SEO generator</dt><dd>{wordpressStatus?.currentSeoVersion ?? wordpressPluginStatus?.seoGeneratorVersion ?? 'Unavailable'}</dd></div>
          <div><dt>Installed WordPress plugin</dt><dd>{wordpressPluginStatusLoading ? 'Checking…' : wordpressPluginStatus?.installedVersion ?? 'Unknown'}</dd></div>
          <div><dt>Required WordPress plugin</dt><dd>{wordpressPluginStatus?.requiredVersion ?? 'Unavailable'}</dd></div>
          <div className='superadmin-version-state'><dt>Sync status</dt><dd>{versionSyncLabel}</dd></div>
        </dl>
        <h2 id='superadmin-debug-heading'>Raw ServiceTitan API data</h2>
        <p>Fetched directly from ServiceTitan when opened. This response may contain customer information.</p>
        <details className='raw-api-panel' onToggle={(event) => { if (event.currentTarget.open) void loadRawResponse(); }}>
          <summary>Show raw response</summary>
          {rawResponseLoading && <p role='status'>Loading raw response…</p>}
          {rawResponseError && <p className='notice error' role='alert'>{rawResponseError} <Button onClick={() => { setRawResponse(undefined); void loadRawResponse(); }}>Retry</Button></p>}
          {rawResponse !== undefined && <>
            <div className='raw-api-actions'><Button size='small' onClick={() => void navigator.clipboard.writeText(JSON.stringify(rawResponse, null, 2)).then(() => setRawResponseCopied(true))}>{rawResponseCopied ? 'Copied' : 'Copy JSON'}</Button></div>
            <pre className='raw-api-json'><code>{JSON.stringify(rawResponse, null, 2)}</code></pre>
          </>}
        </details>
      </section>}
      <ErrorDialog message={error.includes('No job tokens available') ? '' : error} onClose={() => setError('')} />
    </main>
  );
}

const readJson = async <T,>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text.trim()) throw new Error(`The app server returned an empty response (HTTP ${response.status}).`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The app server returned an invalid response (HTTP ${response.status}).`);
  }
};

const comparableUploadedFileName = (value: string): string => {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return decoded
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-(?:scaled|rotated)(?=\.[a-z0-9]+$)/i, '')
    .toLowerCase();
};
