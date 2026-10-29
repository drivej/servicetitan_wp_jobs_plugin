import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import UpgradeRoundedIcon from '@mui/icons-material/UpgradeRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Button, Chip, IconButton } from '@mui/material';
import { useState } from 'react';
import type { BuildTask } from '../shared/build-queue';
import { TOKEN_ACTIONS } from '../shared/token-actions';
import { JobThumbnail } from './JobThumbnail';
import { isSeoPromptOutOfSync, type WordPressStatus } from './wordpressStatusCache';
import { WordPressStatusControl, type WordPressLifecycleStatus } from './WordPressStatusControl';

export interface JobTableItem {
  id: number;
  attachments?: Array<{ id: string; fileName: string }>;
  wordpressRecord?: boolean;
  wordpressFeaturedImageUrl?: string;
  wordpressFeaturedImageAlt?: string;
  imageValidationState?: 'loading' | 'valid' | 'invalid' | 'error';
  sourceCopyStatus?: 'missing' | 'limited' | 'available';
  jobName: string;
  descriptionPreview?: string;
  status: string;
  completedOn?: string;
  modifiedOn?: string;
  location: { city: string; state: string; zip: string };
}

export interface JobTableRowProps {
  job: JobTableItem;
  wordpressStatus: WordPressStatus;
  wordpressBusy?: boolean;
  buildTask?: BuildTask | undefined;
  queueError?: string;
  wordpressPluginReady: boolean;
  tokensExhausted: boolean;
  onOpen?: () => void;
  rating?: { score: number; reason: string };
  onBuild?: () => void | Promise<void>;
  onPublish: () => void | Promise<void>;
  onSetDraft?: () => void | Promise<void>;
  onTrash?: () => void | Promise<void>;
  onUnlink?: () => void | Promise<void>;
  onUpdate?: () => void;
  onRefresh: () => void;
}

export function JobTableHeader({ onRefresh, refreshing = false, disabled = false }: { onRefresh: () => void; refreshing?: boolean; disabled?: boolean }) {
  return <thead>
    <tr>
      <th scope='col' className='readiness-column' aria-label='Publish readiness'></th>
      <th scope='colgroup' colSpan={2}>Job</th>
      <th scope='col'>Location</th>
      <th scope='col'>WordPress</th>
      <th scope='col' className='actions-heading'>
        <div className='actions-heading-content'>
          {/* <span>ACTIONS</span> */}
          <IconButton size='small' title='Refresh WordPress statuses' aria-label='Refresh WordPress statuses' className={refreshing ? 'is-spinning' : undefined} disabled={disabled} onClick={onRefresh}>
            <RefreshRoundedIcon fontSize='small' aria-hidden='true' />
          </IconButton>
        </div>
      </th>
    </tr>
  </thead>;
}

export function JobTableRow({ job, wordpressStatus, wordpressBusy = false, buildTask, queueError, wordpressPluginReady, tokensExhausted, onOpen, rating, onBuild, onPublish, onSetDraft, onTrash, onUnlink, onUpdate, onRefresh }: JobTableRowProps) {
  const [imageValidationState, setImageValidationState] = useState<JobTableItem['imageValidationState']>('loading');
  const buildBusy = wordpressBusy || buildTask?.state === 'queued' || buildTask?.state === 'running';
  const updateAvailable = isSeoPromptOutOfSync(wordpressStatus, job.modifiedOn);
  const statusLabel = wordpressStatus.state === 'not_found' ? 'None'
    : wordpressStatus.state === 'exists' ? wordpressStatus.postStatus === 'publish' ? 'Published' : wordpressStatus.postStatus === 'draft' ? 'Draft' : wordpressStatus.label
    : wordpressStatus.label;
  const statusColor = wordpressStatus.state === 'not_found' ? 'default'
    : wordpressStatus.state === 'unknown' ? wordpressStatus.label.toLowerCase().includes('loading') ? 'info' : 'error'
    : wordpressStatus.postStatus === 'publish' ? 'success' : wordpressStatus.postStatus === 'draft' ? 'warning' : 'default';
  const readiness = job.wordpressRecord && !job.wordpressFeaturedImageUrl ? 'invalid' : imageValidationState || job.imageValidationState || 'loading';
  const readinessState = readiness === 'loading'
    ? 'loading'
    : readiness === 'invalid' || readiness === 'error' || job.sourceCopyStatus === 'missing'
    ? 'invalid'
    : readiness === 'valid' && job.sourceCopyStatus !== 'limited'
      ? 'valid'
      : 'concern';
  const readinessReason = imageValidationState === 'error' || job.imageValidationState === 'error' ? 'Image check unavailable'
    : job.sourceCopyStatus === 'missing' ? 'Missing source copy'
    : job.sourceCopyStatus === 'limited' ? 'Limited source copy'
      : readiness === 'invalid' || readiness === 'error' ? 'No valid image'
        : 'Checking image';
  const readinessLabel = readinessState === 'loading' ? 'Checking image'
    : readinessState === 'valid' ? 'Ready to publish'
    : readinessState === 'invalid' ? `Not ready to publish: ${readinessReason}`
      : `Review before publishing: ${readinessReason}`;
  const sourceCopyMessage = job.sourceCopyStatus === 'missing' ? 'Missing source copy'
    : job.sourceCopyStatus === 'limited' ? 'Limited source copy'
      : readinessState === 'concern' ? readinessReason
        : undefined;
  const lifecycleStatus: WordPressLifecycleStatus | undefined = wordpressStatus.state === 'not_found' ? 'none'
    : wordpressStatus.state !== 'exists' ? undefined
      : wordpressStatus.postStatus === 'publish' ? 'published'
        : wordpressStatus.postStatus === 'draft' ? 'draft'
          : wordpressStatus.postStatus === 'trash' ? 'trash' : undefined;

  const changeLifecycleStatus = (nextStatus: WordPressLifecycleStatus) => {
    if (nextStatus === 'draft' && lifecycleStatus === 'none') return onBuild?.();
    if (nextStatus === 'draft' && (lifecycleStatus === 'published' || lifecycleStatus === 'trash')) return onSetDraft?.();
    if (nextStatus === 'published' && (lifecycleStatus === 'draft' || lifecycleStatus === 'trash')) return onPublish();
    if (nextStatus === 'trash' && (lifecycleStatus === 'draft' || lifecycleStatus === 'published')) return onTrash?.();
    if (nextStatus === 'none' && lifecycleStatus === 'draft') return onUnlink?.();
  };

  return <tr className={`job-row${onOpen ? '' : ' job-row-static'}`} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? `Open ${job.descriptionPreview || job.jobName} details` : undefined} onClick={(event) => {
    if (event.target instanceof Element && event.target.closest('button, a[href]')) return;
    onOpen?.();
  }} onKeyDown={(event) => {
    if (!onOpen || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  }}>
    <td className={`readiness-cell readiness-${readinessState}`} data-label='Publish readiness' title={readinessLabel} aria-label={readinessLabel}>
      {readinessState === 'loading' ? <HourglassTopRoundedIcon aria-hidden='true' /> : readinessState === 'valid' ? <CheckRoundedIcon aria-hidden='true' /> : readinessState === 'invalid' ? <CloseRoundedIcon aria-hidden='true' /> : <WarningAmberRoundedIcon aria-hidden='true' />}
    </td>
    <td className='job-image-cell' data-label='Image'>{job.wordpressRecord ? <div className='job-thumbnail' aria-busy={!job.wordpressFeaturedImageUrl}>
      {job.wordpressFeaturedImageUrl ? <img src={job.wordpressFeaturedImageUrl} alt={job.wordpressFeaturedImageAlt || `Image for ${job.jobName}`} width={64} height={64} onLoad={() => setImageValidationState('valid')} onError={() => setImageValidationState('invalid')} /> : <span className='job-thumbnail-message'>No image</span>}
    </div> : <JobThumbnail key={`${job.id}:${job.attachments?.map((image) => image.id).join(',')}`} jobId={job.id} jobName={job.jobName} attachments={job.attachments || []} onValidationChange={setImageValidationState} />}</td>
    <td className='job-name-cell' data-label='Job'>
      <div className='job-name' title={job.descriptionPreview || job.jobName}>{job.descriptionPreview || job.jobName}</div>
      <div className='job-row-metadata'>
        <span>{formatJobDate(job.completedOn)}</span>
        <span>#{job.id}</span>
      </div>
      {rating && <span className='scanner-row-rating' title={rating.reason} aria-label={`Scanner rating ${rating.score} out of 100. ${rating.reason}`}>{rating.score}/100</span>}
      {sourceCopyMessage && <span className={`source-copy-status source-${job.sourceCopyStatus || 'concern'}`} title='Basic summary check: missing, fewer than 10 words, or at least 10 words. Review the source before generating copy.'>{sourceCopyMessage}</span>}
    </td>
    <td className='location-cell' data-label='Location'><div className='location-cell-city' title={`${job.location.city}, ${job.location.state}`}>{job.location.city}, {job.location.state}</div><span>{job.location.zip}</span></td>
    <td className='wp-status-cell' data-label='WordPress'>
      {lifecycleStatus ? <div className='wordpress-state-control' aria-busy={wordpressBusy || buildBusy} onClick={(event) => event.stopPropagation()}>
        <WordPressStatusControl
          currentStatus={lifecycleStatus}
          onStatusChange={changeLifecycleStatus}
          disabled={!wordpressPluginReady || wordpressStatus.state === 'unknown' || (lifecycleStatus === 'none' && (!onBuild || readiness !== 'valid' || Boolean(queueError)))}
          busy={wordpressBusy || buildBusy}
          canBuild={Boolean(onBuild) && readiness === 'valid' && !buildBusy && !queueError}
          canTrash={Boolean(onTrash)}
          canUnlink={Boolean(onUnlink)}
        />
        <span className='wordpress-state-accessory'>
          {!wordpressBusy && !buildBusy && wordpressStatus.link && wordpressStatus.postStatus !== 'trash' && <IconButton component='a' href={wordpressStatus.link} target='_blank' rel='noreferrer' size='small' aria-label={`Open ${job.jobName} on WordPress`} title='Open WordPress post' onClick={(event) => event.stopPropagation()}><OpenInNewRoundedIcon sx={{ fontSize: 15 }} /></IconButton>}
        </span>
      </div> : <Chip size='small' color={statusColor} label={statusLabel} title={wordpressStatus.message} />}
    </td>
    <td className='actions-cell' data-label='Actions'><div className='row-actions'>
      {onUpdate && wordpressStatus.state === 'exists' && updateAvailable && wordpressStatus.seoState !== 'newer' && <Button variant='contained' className='job-action-seo token-cost' type='button' startIcon={<UpgradeRoundedIcon aria-hidden='true' />} disabled={!wordpressPluginReady || wordpressBusy || tokensExhausted} title={`${seoUpdateDescription(wordpressStatus, job.modifiedOn)} Uses ${TOKEN_ACTIONS.update.cost} job token and preserves the current WordPress status.`} aria-label={`Regenerate SEO for ${job.jobName}`} onClick={(event) => { event.stopPropagation(); onUpdate(); }}>{wordpressBusy && wordpressStatus.label === 'Updating…' ? 'Updating…' : 'SEO'}</Button>}
      {wordpressStatus.state === 'exists' && wordpressStatus.postStatus === 'publish' && !updateAvailable && wordpressStatus.seoState === 'newer' && <Button className='job-action-update update-current' type='button' disabled title='This post was generated by a newer prompt version.'>Newer</Button>}
      <IconButton size='small' className={`icon-button${wordpressBusy ? ' is-spinning' : ''}`} type='button' aria-label={`Refresh WordPress status for ${job.jobName}`} title='Refresh WordPress post status' disabled={wordpressBusy} onClick={(event) => { event.stopPropagation(); onRefresh(); }}><RefreshRoundedIcon fontSize='small' aria-hidden='true' /></IconButton>
    </div></td>
  </tr>;
}

type SeoUpdateLevel = 'minor' | 'major' | 'required';
function formatJobDate(value: string | undefined): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function seoUpdateLevel(status: WordPressStatus): SeoUpdateLevel {
  if (status.seoState === 'legacy' || !status.seoVersion) return 'required';
  const gap = (status.currentSeoVersion || status.seoVersion) - status.seoVersion;
  return gap <= 1 ? 'minor' : gap === 2 ? 'major' : 'required';
}
function seoUpdateDescription(status: WordPressStatus, serviceTitanModifiedOn?: string): string {
  if (status.seoState === 'newer') return 'This post was generated by a newer prompt version.';
  const level = seoUpdateLevel(status);
  const versionChange = status.seoVersion && status.currentSeoVersion ? ` SEO v${status.seoVersion} → v${status.currentSeoVersion}.` : '';
  const serviceTitanModifiedTime = serviceTitanModifiedOn ? Date.parse(serviceTitanModifiedOn) : Number.NaN;
  const wordpressModifiedTime = status.postModifiedOn ? Date.parse(status.postModifiedOn) : Number.NaN;
  const jobChanged = Number.isFinite(serviceTitanModifiedTime) && Number.isFinite(wordpressModifiedTime)
    && serviceTitanModifiedTime > wordpressModifiedTime;
  const promptDescription = level === 'required'
    ? `Prompt update required.${versionChange || ' This post predates prompt version tracking.'}`
    : `A prompt update is available.${versionChange}`;
  return `${jobChanged ? 'ServiceTitan job details changed after this post was updated.' : ''}${jobChanged && promptDescription ? ' ' : ''}${promptDescription}`;
}
