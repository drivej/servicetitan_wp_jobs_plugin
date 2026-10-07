import { CircularProgress, Dialog } from '@mui/material';

export function LoadingModal({ open, label = 'Loading page' }: { open: boolean; label?: string }) {
  return (
    <Dialog open={open} className='loading-modal' aria-label={label} slotProps={{
      transition: { timeout: 0 },
      backdrop: { sx: { backgroundColor: 'rgba(241, 240, 234, .45)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(12px)' } },
    }}>
      <div className='loading-modal-spinner' role='status'>
        <CircularProgress size={36} thickness={3.5} disableShrink enableTrackSlot aria-hidden='true' />
        <span className='visually-hidden'>{label}</span>
      </div>
    </Dialog>
  );
}

// Keep a stable page shape while session checks run, without mounting views
// that would fetch account data before authentication and routing are ready.
export function LoadingPage() {
  return <>
    <div className='loading-page-placeholder' aria-hidden='true' inert>
      <header className='workspace-bar'><span className='workspace-brand p-3'>ServiceTitan Jobs</span><div className='loading-placeholder-nav' /></header>
      <main className='account-page'>
        <div className='loading-placeholder-title' />
        <div className='loading-placeholder-description' />
        <div className='panel loading-placeholder-panel'>
          <div /><div /><div />
        </div>
      </main>
    </div>
    <LoadingModal open />
  </>;
}
