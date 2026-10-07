import { Button, Chip, IconButton } from '@mui/material';
import { useState } from 'react';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import type { BuildTask } from '../shared/build-queue';
import { JobThumbnail } from './JobThumbnail';
import type { WordPressStatus } from './wordpressStatusCache';

export interface JobTableItem {
  id: number;
  attachments?: Array<{ id: string; fileName: string }>;
  imageValidationState?: 'loading' | 'valid' | 'invalid' | 'error';
  sourceCopyStatus?: 'missing' | 'limited' | 'available';
  jobName: string;
  status: string;
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
  onBuild: () => void;
  onPublish: () => void;
  onRebuild: () => void;
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
          <span>ACTIONS</span>
          <IconButton size='small' title='Refresh WordPress statuses' aria-label='Refresh WordPress statuses' className={refreshing ? 'is-spinning' : undefined} disabled={disabled} onClick={onRefresh}>
            <RefreshRoundedIcon fontSize='small' aria-hidden='true' />
          </IconButton>
        </div>
      </th>
    </tr>
  </thead>;
}

export function JobTableRow({ job, wordpressStatus, wordpressBusy = false, buildTask, queueError, wordpressPluginReady, tokensExhausted, onOpen, onBuild, onPublish, onRebuild, onRefresh }: JobTableRowProps) {
  const [imageValidationState, setImageValidationState] = useState<JobTableItem['imageValidationState']>('loading');
  const buildBusy = wordpressBusy || buildTask?.state === 'queued' || buildTask?.state === 'running';
  const statusLabel = wordpressStatus.state === 'not_found' ? 'None'
    : wordpressStatus.state === 'exists' ? wordpressStatus.postStatus === 'publish' ? 'Published' : wordpressStatus.postStatus === 'draft' ? 'Draft' : wordpressStatus.label
    : wordpressStatus.label;
  const statusColor = wordpressStatus.state === 'not_found' ? 'default'
    : wordpressStatus.state === 'unknown' ? wordpressStatus.label.toLowerCase().includes('loading') ? 'info' : 'error'
    : wordpressStatus.postStatus === 'publish' ? 'success' : wordpressStatus.postStatus === 'draft' ? 'warning' : 'default';
  const readiness = imageValidationState || job.imageValidationState || 'loading';
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

  return <tr className={`job-row${onOpen ? '' : ' job-row-static'}`} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? `Open ${job.jobName} details` : undefined} onClick={onOpen} onKeyDown={(event) => {
    if (!onOpen || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  }}>
    <td className={`readiness-cell readiness-${readinessState}`} data-label='Publish readiness' title={readinessLabel} aria-label={readinessLabel}>
      {readinessState === 'loading' ? <HourglassTopRoundedIcon aria-hidden='true' /> : readinessState === 'valid' ? <CheckRoundedIcon aria-hidden='true' /> : readinessState === 'invalid' ? <CloseRoundedIcon aria-hidden='true' /> : <WarningAmberRoundedIcon aria-hidden='true' />}
    </td>
    <td className='job-image-cell' data-label='Image'><JobThumbnail key={`${job.id}:${job.attachments?.map((image) => image.id).join(',')}`} jobId={job.id} jobName={job.jobName} attachments={job.attachments || []} onValidationChange={setImageValidationState} /></td>
    <td className='job-name-cell' data-label='Job'>
      <div className='job-name' title={job.jobName}>{job.jobName}</div>
      {sourceCopyMessage && <span className={`source-copy-status source-${job.sourceCopyStatus || 'concern'}`} title='Basic summary check: missing, fewer than 20 words, or at least 20 words. Review the source before generating copy.'>{sourceCopyMessage}</span>}
    </td>
    <td className='location-cell' data-label='Location'><div className='location-cell-city' title={`${job.location.city}, ${job.location.state}`}>{job.location.city}, {job.location.state}</div><span>{job.location.zip}</span></td>
    <td className='wp-status-cell' data-label='WordPress'>
      <Chip component={wordpressStatus.state === 'exists' && wordpressStatus.link ? 'a' : 'div'} clickable={wordpressStatus.state === 'exists' && Boolean(wordpressStatus.link)} href={wordpressStatus.state === 'exists' ? wordpressStatus.link : undefined} target={wordpressStatus.state === 'exists' && wordpressStatus.link ? '_blank' : undefined} rel={wordpressStatus.state === 'exists' && wordpressStatus.link ? 'noreferrer' : undefined} onClick={(event: React.MouseEvent) => { if (wordpressStatus.state === 'exists' && wordpressStatus.link) event.stopPropagation(); }} size='small' color={statusColor} icon={wordpressStatus.state === 'exists' ? <EditRoundedIcon fontSize='small' /> : undefined} label={statusLabel} title={wordpressStatus.link ? `Open ${statusLabel.toLowerCase()} post on the website` : wordpressStatus.message} />
    </td>
    <td className='actions-cell' data-label='Actions'><div className='row-actions'>
      {wordpressStatus.state === 'not_found' && <Button variant='contained' color='primary' className='build-deploy-button' type='button' disabled={!wordpressPluginReady || buildBusy || Boolean(queueError)} aria-disabled={!wordpressPluginReady || tokensExhausted || buildBusy || Boolean(queueError)} title='Generate copy, select the first available image, and create a WordPress draft. Uses 2 job tokens.' onClick={(event) => { event.stopPropagation(); onBuild(); }}>{buildTask?.state === 'running' ? 'Building…' : buildBusy ? 'Queued…' : 'Build'}</Button>}
      {buildTask?.state === 'failed' && buildTask.error !== 'No job tokens available. Add tokens before trying again.' && <span className='build-deploy-error' role='status'>{buildTask.error}</span>}
      {wordpressStatus.state === 'exists' && wordpressStatus.postStatus === 'draft' && <Button variant='contained' className='job-action-publish' type='button' disabled={!wordpressPluginReady || wordpressBusy} onClick={(event) => { event.stopPropagation(); onPublish(); }}>{wordpressBusy && wordpressStatus.label === 'Updating…' ? 'Publishing…' : 'Publish'}</Button>}
      {wordpressStatus.state === 'exists' && wordpressStatus.postStatus === 'publish' && <Button className={`regenerate-button job-action-rebuild rebuild-${rebuildUpdateLevel(wordpressStatus)}`} type='button' disabled={!wordpressPluginReady || wordpressBusy || wordpressStatus.seoState === 'newer'} title={rebuildButtonDescription(wordpressStatus)} onClick={(event) => { event.stopPropagation(); onRebuild(); }}>{wordpressBusy && wordpressStatus.label === 'Regenerating…' ? 'Regenerating…' : 'Rebuild'}</Button>}
      <IconButton size='small' className={`icon-button${wordpressBusy ? ' is-spinning' : ''}`} type='button' aria-label={`Refresh WordPress status for ${job.jobName}`} title='Refresh WordPress post status' disabled={!wordpressPluginReady || wordpressBusy} onClick={(event) => { event.stopPropagation(); onRefresh(); }}><RefreshRoundedIcon fontSize='small' aria-hidden='true' /></IconButton>
    </div></td>
  </tr>;
}

type RebuildUpdateLevel = 'unnecessary' | 'minor' | 'major' | 'required';
function rebuildUpdateLevel(status: WordPressStatus): RebuildUpdateLevel {
  if (status.seoState === 'current' || status.seoState === 'newer') return 'unnecessary';
  if (status.seoState === 'legacy' || !status.seoVersion) return 'required';
  const gap = (status.currentSeoVersion || status.seoVersion) - status.seoVersion;
  return gap <= 0 ? 'unnecessary' : gap === 1 ? 'minor' : gap === 2 ? 'major' : 'required';
}
function rebuildButtonDescription(status: WordPressStatus): string {
  if (status.seoState === 'newer') return 'Unavailable: this post was generated by a newer app version.';
  const level = rebuildUpdateLevel(status);
  if (level === 'unnecessary') return status.seoState === 'modified' ? 'Rebuild is unnecessary for the current SEO version. This post was manually edited in WordPress.' : 'Rebuild is unnecessary. This post uses the current SEO version.';
  const versionChange = status.seoVersion && status.currentSeoVersion ? ` SEO v${status.seoVersion} → v${status.currentSeoVersion}.` : '';
  if (level === 'minor') return `Minor update available.${versionChange}`;
  if (level === 'major') return `Major update available.${versionChange}`;
  return `Required update.${versionChange || ' This post predates SEO version tracking.'}`;
}
