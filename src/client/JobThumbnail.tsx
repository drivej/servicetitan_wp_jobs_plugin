import { useEffect, useState } from 'react';
import { apiUrl } from './api';

export function JobThumbnail({ jobId, jobName, attachments, onValidationChange }: {
  jobId: number;
  jobName: string;
  attachments: Array<{ id: string; fileName: string }>;
  onValidationChange?: (state: 'loading' | 'valid' | 'invalid' | 'error') => void;
}) {
  const [candidates, setCandidates] = useState(attachments);
  const [lookupState, setLookupState] = useState<'loading' | 'ready' | 'error'>(attachments.length ? 'ready' : 'loading');
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [candidateFailed, setCandidateFailed] = useState(false);
  useEffect(() => {
    if (attachments.length) {
      setCandidates(attachments);
      setLookupState('ready');
      setIndex(0);
      setLoaded(false);
      setCandidateFailed(false);
      return;
    }
    const controller = new AbortController();
    setLookupState('loading');
    void fetch(apiUrl(`/api/jobs/${jobId}/image-candidates`), { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load images');
        return response.json() as Promise<{ attachments?: Array<{ id: string; fileName: string }> }>;
      })
      .then((body) => { setCandidates(body.attachments || []); setIndex(0); setLoaded(false); setCandidateFailed(false); setLookupState('ready'); })
      .catch(() => { if (!controller.signal.aborted) setLookupState('error'); });
    return () => controller.abort();
  }, [jobId, attachments, attachments.length]);
  const attachment = candidates[index];
  const validationState = lookupState === 'loading' ? 'loading' : lookupState === 'error' ? 'error' : loaded ? 'valid' : attachment ? 'loading' : candidateFailed ? 'invalid' : 'invalid';
  useEffect(() => { onValidationChange?.(validationState); }, [validationState, onValidationChange]);

  // Only mount one candidate at a time. Success leaves it in place; failure tries the next.
  return <div className="job-thumbnail" aria-busy={Boolean(attachment && !loaded)}>
    {attachment && <img
      key={attachment.id}
      src={apiUrl(`/api/jobs/${jobId}/images/${encodeURIComponent(attachment.id)}`)}
      alt={`Image for ${jobName}`}
      title={attachment.fileName}
      width={64}
      height={64}
      className={loaded ? '' : 'is-checking'}
      onLoad={() => setLoaded(true)}
      onError={() => { setLoaded(false); setCandidateFailed(true); setIndex((current) => current + 1); }}
    />}
    {!loaded && <span className="job-thumbnail-message" role="status">
      {attachment ? 'Checking…' : lookupState === 'loading' ? 'Loading…' : lookupState === 'error' ? 'Unavailable' : 'No valid image'}
    </span>}
  </div>;
}
