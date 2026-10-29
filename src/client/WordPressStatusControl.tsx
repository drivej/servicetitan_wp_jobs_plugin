import { CircularProgress } from '@mui/material';
import { useState } from 'react';

export type WordPressLifecycleStatus = 'none' | 'draft' | 'published' | 'trash';

interface WordPressStatusControlProps {
  currentStatus: WordPressLifecycleStatus;
  onStatusChange: (newStatus: WordPressLifecycleStatus) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  canBuild?: boolean;
  canTrash?: boolean;
  canUnlink?: boolean;
}

const STATES: Array<{ value: WordPressLifecycleStatus; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'trash', label: 'Trash' },
];

/** Compact status dropdown. Destructive transitions ask for confirmation before dispatch. */
export function WordPressStatusControl({ currentStatus, onStatusChange, disabled = false, busy = false, canBuild = true, canTrash = true, canUnlink = true }: WordPressStatusControlProps) {
  const [pending, setPending] = useState(false);
  const isLoading = busy || pending;

  const allowed = (nextStatus: WordPressLifecycleStatus) => !disabled && !isLoading && (
    (currentStatus === 'none' && nextStatus === 'draft' && canBuild)
    || (currentStatus === 'draft' && nextStatus === 'published')
    || (currentStatus === 'published' && nextStatus === 'draft')
    || (currentStatus === 'trash' && nextStatus === 'draft')
    || (currentStatus === 'trash' && nextStatus === 'published')
    || (currentStatus === 'draft' && nextStatus === 'none' && canUnlink)
    || (currentStatus === 'draft' && nextStatus === 'trash' && canTrash)
    || (currentStatus === 'published' && nextStatus === 'trash' && canTrash)
  );

  const handleChange = async (nextStatus: WordPressLifecycleStatus) => {
    if (!allowed(nextStatus)) return;
    const destructive = (currentStatus === 'draft' && nextStatus === 'none')
      || ((currentStatus === 'draft' || currentStatus === 'published') && nextStatus === 'trash');
    if (destructive) {
      const message = nextStatus === 'none'
        ? 'Permanently remove this draft from WordPress and disconnect it from this job?'
        : 'Move this post to WordPress Trash?';
      if (!window.confirm(message)) return;
    }
    setPending(true);
    try { await onStatusChange(nextStatus); }
    finally { setPending(false); }
  };

  return <div className={`wordpress-lifecycle${disabled ? ' is-disabled' : ''}${isLoading ? ' is-busy' : ''}`} data-status={currentStatus} aria-busy={isLoading}>
    <select
      className='wordpress-lifecycle-select'
      aria-label={`WordPress status: ${currentStatus}`}
      value={currentStatus}
      disabled={disabled || isLoading}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        event.stopPropagation();
        void handleChange(event.target.value as WordPressLifecycleStatus);
      }}
    >
      {STATES.map(({ value, label }) => <option key={value} value={value} disabled={value !== currentStatus && !allowed(value)}>{label}</option>)}
    </select>
    {isLoading && <span className='wordpress-lifecycle-loading' role='status' aria-label='Updating WordPress status'>
      <CircularProgress size={16} aria-label='Updating WordPress status' />
    </span>}
  </div>;
}
