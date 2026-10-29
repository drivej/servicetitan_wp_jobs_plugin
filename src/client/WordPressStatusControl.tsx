import { CircularProgress } from '@mui/material';
import CloudQueueRoundedIcon from '@mui/icons-material/CloudQueueRounded';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

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

const STATES: Array<{ value: WordPressLifecycleStatus; label: string; Icon: typeof CloudQueueRoundedIcon }> = [
  { value: 'none', label: 'None', Icon: CloudQueueRoundedIcon },
  { value: 'draft', label: 'Draft', Icon: DescriptionOutlinedIcon },
  { value: 'published', label: 'Published', Icon: PublicRoundedIcon },
  { value: 'trash', label: 'Trash', Icon: DeleteOutlineRoundedIcon },
];
const HOLD_TO_CONFIRM_MS = 2_000;

/** Compact lifecycle track. Destructive backward transitions require a deliberate hold. */
export function WordPressStatusControl({ currentStatus, onStatusChange, disabled = false, busy = false, canBuild = true, canTrash = true, canUnlink = true }: WordPressStatusControlProps) {
  const [pendingStatus, setPendingStatus] = useState<WordPressLifecycleStatus | undefined>(undefined);
  const [holdingStatus, setHoldingStatus] = useState<WordPressLifecycleStatus | undefined>(undefined);
  const [hoveredStatus, setHoveredStatus] = useState<WordPressLifecycleStatus | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldTransition = useRef<WordPressLifecycleStatus | undefined>(undefined);

  useEffect(() => {
    setPendingStatus(undefined);
    setHoldingStatus(undefined);
    setHoveredStatus(undefined);
    heldTransition.current = undefined;
    if (timer.current) clearTimeout(timer.current);
  }, [currentStatus]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = async (nextStatus: WordPressLifecycleStatus) => {
    if (disabled || busy || pendingStatus) return;
    setPendingStatus(nextStatus);
    try { await onStatusChange(nextStatus); }
    finally { setPendingStatus(undefined); }
  };

  const isDestructiveTransition = (nextStatus: WordPressLifecycleStatus) =>
    (currentStatus === 'draft' && nextStatus === 'none')
    || (currentStatus === 'published' && nextStatus === 'trash');

  const allowed = (nextStatus: WordPressLifecycleStatus) => !disabled && !busy && !pendingStatus && (
    (currentStatus === 'none' && nextStatus === 'draft' && canBuild)
    || (currentStatus === 'draft' && nextStatus === 'published')
    || (currentStatus === 'draft' && nextStatus === 'none' && canUnlink)
    || (currentStatus === 'published' && nextStatus === 'trash' && canTrash)
  );

  const beginHold = (event: PointerEvent<HTMLButtonElement>, nextStatus: WordPressLifecycleStatus) => {
    if (!isDestructiveTransition(nextStatus) || !allowed(nextStatus) || event.button !== 0) return;
    if (timer.current) clearTimeout(timer.current);
    setHoldingStatus(nextStatus);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      heldTransition.current = nextStatus;
      setHoldingStatus(undefined);
      void commit(nextStatus);
    }, HOLD_TO_CONFIRM_MS);
  };

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setHoldingStatus(undefined);
  };

  const leaveNode = () => {
    cancelHold();
    setHoveredStatus(undefined);
  };

  const handleClick = (nextStatus: WordPressLifecycleStatus, clickDetail: number) => {
    if (heldTransition.current === nextStatus) {
      heldTransition.current = undefined;
      return;
    }
    if (!allowed(nextStatus)) return;
    if (isDestructiveTransition(nextStatus)) {
      // Keyboard activation has no pointer-hold event; require an explicit confirmation instead.
      if (clickDetail === 0) {
        const message = nextStatus === 'none'
          ? 'Permanently remove this draft from WordPress and disconnect it from this job?'
          : 'Move this published post to WordPress Trash?';
        if (window.confirm(message)) void commit(nextStatus);
      }
      return;
    }
    void commit(nextStatus);
  };

  const activeStatus = pendingStatus || currentStatus;
  const activeIndex = Math.max(0, STATES.findIndex((state) => state.value === activeStatus));
  const busyTarget = pendingStatus || (busy && currentStatus === 'none' ? 'draft' : undefined);

  return <div
    className={`wordpress-lifecycle${disabled ? ' is-disabled' : ''}${busy || pendingStatus ? ' is-busy' : ''}`}
    data-status={currentStatus}
    data-active-status={activeStatus}
    data-active-index={activeIndex}
    data-holding={holdingStatus || undefined}
    data-hover-target={hoveredStatus || undefined}
    aria-label={`WordPress lifecycle: ${currentStatus}`}
  >
    <div className='wordpress-lifecycle-track'>
      <span className='wordpress-lifecycle-capsule' aria-hidden='true' />
      {STATES.map(({ value, label, Icon }) => {
        const transitionEnabled = allowed(value);
        const destructive = isDestructiveTransition(value);
        const isActive = currentStatus === value;
        const isPending = busyTarget === value || (busy && isActive);
        const title = destructive
          ? `Hold for 2 seconds to ${value === 'none' ? 'permanently remove this draft from WordPress' : 'move this post to WordPress Trash'}. Keyboard users can press Enter and confirm.`
          : value === 'draft' && currentStatus === 'none'
            ? 'Build a WordPress draft from this job. Uses 1 token.'
            : value === 'published' && currentStatus === 'draft'
              ? 'Publish this WordPress draft. No token cost.'
              : `${label}${isActive ? ' (current status)' : ''}`;
        return <button
          key={value}
          className={`wordpress-lifecycle-node${isActive ? ' is-active' : ''}${transitionEnabled ? ' is-next' : ''}${destructive ? ' is-destructive' : ''}${holdingStatus === value ? ' is-holding' : ''}`}
          type='button'
          aria-label={`${label}${isActive ? ', current status' : ''}`}
          aria-current={isActive ? 'step' : undefined}
          aria-disabled={!transitionEnabled}
          title={title}
          onPointerEnter={() => setHoveredStatus(value)}
          onPointerDown={(event) => beginHold(event, value)}
          onPointerUp={cancelHold}
          onPointerLeave={leaveNode}
          onPointerCancel={leaveNode}
          onContextMenu={(event) => { if (destructive) event.preventDefault(); }}
          onClick={(event) => { event.stopPropagation(); handleClick(value, event.detail); }}
        >
          {isPending ? <CircularProgress size={15} aria-label={`${label} in progress`} /> : <Icon aria-hidden='true' />}
        </button>;
      })}
    </div>
  </div>;
}
