import { apiFetch, apiUrl, wordpressStatusStorage } from './api';
import { useEffect, useMemo, useState } from 'react';

import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { type WordPressStatus, writeCachedWordPressStatuses } from './wordpressStatusCache';
import {
  buildJobCopyPrompt,
  formatJobCopy,
  hasCompleteJobBody,
  hasFormattedJobBody,
  type GeneratedJobCopy,
  type JobCopySource,
} from '../shared/job-copy';

interface JobAttachment { id: string; fileName: string; contentType: string; }
interface JobHistoryItem { id: string; source: 'history' | 'note'; type: string; date: string; content: string; promptEligible: boolean; }
interface JobSummary extends JobCopySource {
  id: number;
  jobNumber: string;
  status: string;
}
interface JobDetailsResponse {
  job: Record<string, unknown>;
  summary: JobSummary;
  attachments: JobAttachment[];
  history: JobHistoryItem[];
}
interface DetailField { name: string; value: string; }
type WordPressWritableStatus = 'draft' | 'publish';

interface JobImageOptionProps {
  attachment: JobAttachment;
  disabled: boolean;
  jobId: number;
  onToggle: () => void;
  selected: boolean;
}

function JobImageOption({ attachment, disabled, jobId, onToggle, selected }: JobImageOptionProps) {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');

  return (
    <label className={`image-option image-${imageState}${selected ? ' selected' : ''}`}>
      <span className="image-preview">
        {imageState === 'loading' && (
          <span className="image-loader" role="status">
            <span className="image-loader-spinner" aria-hidden="true" />
            <span className="visually-hidden">Loading {attachment.fileName}</span>
          </span>
        )}
        {imageState === 'error' && <span className="image-load-error" role="status">Image unavailable</span>}
        <img
          src={apiUrl(`/api/jobs/${jobId}/images/${encodeURIComponent(attachment.id)}`)}
          alt={attachment.fileName}
          loading="lazy"
          onLoad={() => setImageState('loaded')}
          onError={() => setImageState('error')}
        />
      </span>
      <span className="image-choice">
        <input type="radio" name="job-image" checked={selected} disabled={disabled} onChange={onToggle} />
        <span>{attachment.fileName}</span>
      </span>
    </label>
  );
}

export function JobDetails({ jobId }: { jobId: number }) {
  const jobsHref = `/${window.location.search}`;
  const [details, setDetails] = useState<JobDetailsResponse>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [wordpressStatus, setWordpressStatus] = useState<WordPressStatus>();
  const [wordpressStatusLoading, setWordpressStatusLoading] = useState(true);
  const [desiredStatus, setDesiredStatus] = useState<WordPressWritableStatus>('draft');
  const [aiCopy, setAiCopy] = useState('');
  const [aiCopyEdited, setAiCopyEdited] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const { ready: wordpressPluginReady } = useWordPressPluginStatus();

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await apiFetch(`/api/jobs/${jobId}`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
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
          signal: controller.signal,
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
          message: requestError instanceof Error ? requestError.message : 'Unable to load WordPress status.',
        });
      } finally {
        if (!controller.signal.aborted) setWordpressStatusLoading(false);
      }
    };
    void loadWordPressStatus();
    return () => controller.abort();
  }, [jobId]);

  const fields = useMemo(() => details ? flattenFields(details.job) : [], [details]);
  const currentFeaturedAttachmentId = useMemo(() => {
    if (!details || wordpressStatus?.state !== 'exists') return undefined;
    if (wordpressStatus.featuredImageAttachmentId
      && details.attachments.some((attachment) => attachment.id === wordpressStatus.featuredImageAttachmentId)) {
      return wordpressStatus.featuredImageAttachmentId;
    }
    if (!wordpressStatus.featuredImageFileName) return undefined;
    const expectedFileName = comparableUploadedFileName(wordpressStatus.featuredImageFileName);
    return details.attachments.find((attachment) => comparableUploadedFileName(attachment.fileName) === expectedFileName)?.id;
  }, [details, wordpressStatus]);
  const aiPrompt = useMemo(() => details ? buildJobCopyPrompt(details.summary) : '', [details]);
  const hasCompleteAiCopy = hasFormattedJobBody(aiCopy);
  const requiresCompleteAiCopy = wordpressStatus?.state === 'exists'
    && (!wordpressStatus.seoVersion
      || !wordpressStatus.currentSeoVersion
      || wordpressStatus.seoVersion < wordpressStatus.currentSeoVersion);
  useEffect(() => {
    if (currentFeaturedAttachmentId && selectedIds.length === 0) {
      setSelectedIds([currentFeaturedAttachmentId]);
    }
  }, [currentFeaturedAttachmentId, selectedIds.length]);
  useEffect(() => {
    if (wordpressStatus?.state !== 'exists' || aiCopyEdited) return;
    if (wordpressStatus.postTitle === undefined && wordpressStatus.postExcerpt === undefined) return;
    setAiCopy(formatJobCopy({ title: wordpressStatus.postTitle || '', excerpt: wordpressStatus.postExcerpt || '' }));
  }, [aiCopyEdited, wordpressStatus]);
  const toggleImage = (attachmentId: string) => {
    setSelectedIds([attachmentId]);
  };
  const copyAiPrompt = async () => {
    if (!aiPrompt) return;
    try {
      await navigator.clipboard.writeText(aiPrompt);
      setPromptCopied(true);
    } catch {
      setError('The prompt could not be copied automatically. Select the prompt text and copy it manually.');
    }
  };

  const generateAiCopy = async () => {
    setGeneratingCopy(true);
    setError('');
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/ai-copy`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const body = await readJson<GeneratedJobCopy & { error?: string }>(response);
      if (!response.ok) throw new Error(body.error || 'Unable to generate copy.');
      if (!body.title || !body.excerpt || !hasCompleteJobBody(body)) throw new Error('The app server returned incomplete generated copy.');
      setAiCopyEdited(true);
      setAiCopy(formatJobCopy(body));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to generate copy.');
    } finally {
      setGeneratingCopy(false);
    }
  };

  const pushToWordPress = async () => {
    if (selectedIds.length !== 1 || !hasCompleteAiCopy) return;
    setPushing(true);
    setError('');
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachmentIds: selectedIds, status: desiredStatus, aiCopy }),
      });
      const body = await readJson<WordPressStatus | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to create the WordPress post.');
      const status = body as WordPressStatus;
      setWordpressStatus(status);
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create the WordPress post.');
    } finally {
      setPushing(false);
    }
  };

  const regenerateWordPress = async () => {
    if (wordpressStatus?.state !== 'exists') return;
    if (requiresCompleteAiCopy && !hasCompleteAiCopy) {
      setError('Generate or paste the complete AI post copy before updating this post to the latest SEO version.');
      return;
    }
    const force = wordpressStatus.seoState === 'modified';
    const replacingImage = selectedIds.length === 1 && selectedIds[0] !== currentFeaturedAttachmentId;
    if (force && !window.confirm(`This post was edited in WordPress. Rebuilding will replace its title, excerpt, and content${replacingImage ? ', and featured image' : ''}. Continue?`)) return;

    setRegenerating(true);
    setError('');
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/wordpress/regenerate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          force,
          ...(replacingImage && selectedIds[0] ? { attachmentId: selectedIds[0] } : {}),
          ...(aiCopy.trim() ? { aiCopy } : {}),
        }),
      });
      const body = await readJson<WordPressStatus | { error?: string }>(response);
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to regenerate the WordPress post.');
      const status = body as WordPressStatus;
      setWordpressStatus(status);
      setSelectedIds([]);
      writeCachedWordPressStatuses({ [jobId]: status }, wordpressStatusStorage());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to regenerate the WordPress post.');
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <main>
      <header className="hero details-hero">
        <a className="back-link" href={jobsHref}>← Back to jobs</a>
        <p className="eyebrow">Job details</p>
        <h1>{details?.summary.jobName || `ServiceTitan job ${jobId}`}</h1>
        {details && <p className="intro">Job #{details.summary.jobNumber} · {details.summary.location.city}, {details.summary.location.state} {details.summary.location.zip}</p>}
      </header>

      <section className="wordpress-action-bar" aria-label="WordPress status and actions">
        <div className="wordpress-current-status">
          <span className="wordpress-status-label">WordPress status</span>
          <strong className={`wordpress-status-badge state-${wordpressStatus?.state || 'unknown'}`} title={wordpressStatus?.message}>
            {wordpressStatusLoading ? 'Checking…' : wordpressStatus?.label || 'Unknown'}
          </strong>
          {wordpressStatus?.state === 'exists' && wordpressStatus.seoState && (
            <span className={`seo-status-badge seo-${wordpressStatus.seoState}`} title={seoStatusDescription(wordpressStatus)}>
              {seoStatusLabel(wordpressStatus)}
            </span>
          )}
          {wordpressStatus?.link && <a href={wordpressStatus.link} target="_blank" rel="noreferrer">View post</a>}
        </div>
        <div className="wordpress-push-controls">
          {wordpressStatus?.state === 'exists' ? (
            <button
              className="primary wordpress-push-button"
              type="button"
              disabled={!wordpressPluginReady || wordpressStatusLoading || regenerating || wordpressStatus.seoState === 'newer' || Boolean(requiresCompleteAiCopy && !hasCompleteAiCopy)}
              title={requiresCompleteAiCopy && !hasCompleteAiCopy ? 'Generate the complete AI post copy before updating SEO.' : undefined}
              onClick={() => void regenerateWordPress()}
            >
              {regenerating ? 'Rebuilding…' : wordpressStatus.seoState === 'current' ? 'Rebuild' : 'Update SEO'}
            </button>
          ) : (
            <>
              <label>
                <span>Post status</span>
                <select
                  aria-label="Status for the new WordPress post"
                  value={desiredStatus}
                  disabled={pushing}
                  onChange={(event) => setDesiredStatus(event.target.value as WordPressWritableStatus)}
                >
                  <option value="draft">Draft</option>
                  <option value="publish">Published</option>
                </select>
              </label>
              <button
                className="primary wordpress-push-button"
                type="button"
                disabled={!wordpressPluginReady || wordpressStatusLoading || wordpressStatus?.state !== 'not_found' || selectedIds.length !== 1 || !hasCompleteAiCopy || pushing}
                title={selectedIds.length !== 1
                  ? 'Select an image before pushing.'
                  : !hasCompleteAiCopy ? 'Generate or paste the complete AI post copy before pushing.' : undefined}
                onClick={() => void pushToWordPress()}
              >
                {pushing ? 'Pushing…' : 'Push'}
              </button>
            </>
          )}
        </div>
      </section>

      {loading && <div className="notice" role="status">Loading job details and images…</div>}
      {error && <div className="notice error" role="alert">{error}</div>}

      {details && (
        <>
          <section className="panel details-panel" aria-labelledby="images-heading">
            <div className="details-section-heading">
              <div>
                <p className="eyebrow">Attachments</p>
                <h2 id="images-heading">{wordpressStatus?.state === 'exists' ? 'Replace featured image' : 'Select an image'}</h2>
              </div>
              <div className="image-selection-summary">
                <span className="selection-count">
                  {wordpressStatus?.state === 'exists'
                    ? selectedIds[0] === currentFeaturedAttachmentId && currentFeaturedAttachmentId
                      ? 'Current featured image selected'
                      : selectedIds.length === 1 ? 'New image selected' : 'Keeping current image'
                    : selectedIds.length === 1 ? '1 selected' : 'None selected'}
                </span>
                {wordpressStatus?.state === 'exists' && selectedIds.length === 1 && selectedIds[0] !== currentFeaturedAttachmentId && (
                  <button type="button" disabled={regenerating} onClick={() => setSelectedIds(currentFeaturedAttachmentId ? [currentFeaturedAttachmentId] : [])}>Keep current image</button>
                )}
              </div>
            </div>
            <p className="field-help">
              {wordpressStatus?.state === 'exists'
                ? 'The current featured image is selected when it can be matched. Choose a different image before rebuilding only if you want to replace it.'
                : 'The selected image is uploaded to the WordPress Media Library and becomes the generated post’s featured image.'}
            </p>
            <div className="image-grid">
              {details.attachments.map((attachment) => {
                const selected = selectedIds.includes(attachment.id);
                return (
                  <JobImageOption
                    key={attachment.id}
                    attachment={attachment}
                    disabled={pushing || regenerating}
                    jobId={jobId}
                    onToggle={() => toggleImage(attachment.id)}
                    selected={selected}
                  />
                );
              })}
            </div>
          </section>

          <section className="panel details-panel ai-copy-panel" aria-labelledby="ai-copy-heading">
            <p className="eyebrow">AI-assisted copy</p>
            <h2 id="ai-copy-heading">Prepare the complete post</h2>
            <p className="field-help">Generate a job-specific title, excerpt, and project story with the configured OpenAI API, or copy the prompt for another AI tool. Review and edit every field before pushing it to WordPress.</p>
            <div className="prompt-builder">
              <div className="prompt-builder-heading">
                <div>
                  <h3>SEO job-post prompt</h3>
                  <p>Built from the service title, ServiceTitan summary, service address, and available equipment keywords. City, state, and ZIP may be published; the street address and unit remain private source context.</p>
                </div>
                <div className="prompt-builder-actions">
                  <button type="button" disabled={generatingCopy} onClick={() => void copyAiPrompt()}>
                    {promptCopied ? 'Copied' : 'Copy prompt'}
                  </button>
                  <button className="primary generate-copy-button" type="button" disabled={generatingCopy} onClick={() => void generateAiCopy()}>
                    {generatingCopy ? 'Generating…' : 'Generate copy'}
                  </button>
                </div>
              </div>
              <textarea aria-label="Generated AI prompt" readOnly rows={15} value={aiPrompt} />
            </div>
            <label className="ai-output">
              <span>AI-generated post copy</span>
              <textarea
                aria-label="AI-generated post copy"
                rows={16}
                maxLength={6000}
                placeholder={'TITLE: Plumbing Service in Rancho Palos Verdes, CA\nEXCERPT: Short card description.\nINTRO: Opening project paragraph.\nCONTEXT HEADING: Why Did This Service Matter?\nCONTEXT: Job-specific explanation.\nWORK HEADING: What Did the Service Include?\nWORK ITEMS:\n- First documented scope item\n- Second documented scope item\nCLOSING: Appropriately qualified closing paragraph.'}
                value={aiCopy}
                onChange={(event) => {
                  setAiCopyEdited(true);
                  setAiCopy(event.target.value);
                }}
              />
              <span className="ai-output-meta">
                <span>{wordpressStatus?.state === 'exists'
                  ? 'The current title and excerpt are loaded from WordPress. Generate complete copy to replace the detail-page story, or edit the available fields before rebuilding.'
                  : 'Required before pushing. TITLE and EXCERPT power the card; the remaining fields build the job detail page.'}</span>
                <span>{aiCopy.length}/6000</span>
              </span>
            </label>
          </section>

          <section className="panel details-panel history-panel" aria-labelledby="history-heading">
            <div className="details-section-heading">
              <div>
                <p className="eyebrow">SEO source material</p>
                <h2 id="history-heading">Job history</h2>
              </div>
            </div>
            <p className="field-help">Events and relevant notes are shown oldest first for reference. They are not included in the AI prompt. Attachments are omitted.</p>
            {details.history.length === 0 ? (
              <div className="history-empty">No descriptive history entries are available for reference.</div>
            ) : (
              <div className="history-list">
                {details.history.map((item) => (
                  <article className={`history-item${item.promptEligible ? '' : ' prompt-ineligible'}`} key={item.id}>
                    <span className="history-item-body">
                      <span className="history-item-meta">
                        <strong>{item.type}</strong>
                        <time dateTime={item.date}>{formatHistoryDate(item.date)}</time>
                      </span>
                      <span className="history-item-content">{item.content}</span>
                      {!item.promptEligible && <span className="history-item-exclusion">Timeline only — no descriptive memo</span>}
                    </span>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel details-panel" aria-labelledby="fields-heading">
            <p className="eyebrow">Individual job response</p>
            <h2 id="fields-heading">ServiceTitan fields</h2>
            <div className="details-table-wrap">
              <table className="details-table">
                <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
                <tbody>{fields.map((field) => <tr key={field.name}><th scope="row">{field.name}</th><td>{field.value}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

const flattenFields = (value: unknown, prefix = ''): DetailField[] => {
  if (value === null || value === undefined) return prefix ? [{ name: prefix, value: '—' }] : [];
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [{ name: prefix, value: '[]' }] : [];
    return value.flatMap((item, index) => flattenFields(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return prefix ? [{ name: prefix, value: '{}' }] : [];
    return entries.flatMap(([key, item]) => flattenFields(item, prefix ? `${prefix}.${key}` : key));
  }
  return [{ name: prefix || 'value', value: typeof value === 'string' ? value || '—' : String(value) }];
};

const readJson = async <T,>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text.trim()) throw new Error(`The app server returned an empty response (HTTP ${response.status}).`);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`The app server returned an invalid response (HTTP ${response.status}).`); }
};

const seoStatusLabel = (status: WordPressStatus): string => {
  if (status.seoState === 'current') return `SEO v${status.seoVersion} current`;
  if (status.seoState === 'outdated') return `SEO v${status.seoVersion} → v${status.currentSeoVersion}`;
  if (status.seoState === 'legacy') return 'Legacy SEO';
  if (status.seoState === 'modified') return 'SEO manually edited';
  if (status.seoState === 'newer') return `SEO v${status.seoVersion} newer`;
  return 'SEO unknown';
};

const seoStatusDescription = (status: WordPressStatus): string => {
  if (status.seoState === 'current') return 'This post uses the current SEO generator.';
  if (status.seoState === 'outdated') return 'A newer SEO generator is available for this post.';
  if (status.seoState === 'legacy') return 'This post predates SEO version tracking and should be regenerated.';
  if (status.seoState === 'modified') return 'The generated title, excerpt, or content was edited in WordPress.';
  if (status.seoState === 'newer') return 'This post was generated by a newer app version.';
  return 'SEO generation status is unavailable.';
};

const formatHistoryDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const comparableUploadedFileName = (value: string): string => {
  const decoded = (() => {
    try { return decodeURIComponent(value); }
    catch { return value; }
  })();
  return decoded
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-(?:scaled|rotated)(?=\.[a-z0-9]+$)/i, '')
    .toLowerCase();
};
