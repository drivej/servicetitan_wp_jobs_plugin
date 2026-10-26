import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './api';

export function JobThumbnail({ jobId, jobName, attachments, onValidationChange }: {
  jobId: number;
  jobName: string;
  attachments: Array<{ id: string; fileName: string }>;
  onValidationChange?: (state: 'loading' | 'valid' | 'invalid' | 'error') => void;
}) {
  // Scanner detail hydration and polling may create a new array containing
  // the same images. Only a change in the actual candidates should reset checks.
  const attachmentsKey = JSON.stringify(attachments.map(({id,fileName})=>({id,fileName})));
  const imageRef = useRef<HTMLImageElement>(null);
  const [candidates, setCandidates] = useState(attachments);
  const [lookupState, setLookupState] = useState<'loading' | 'ready' | 'error'>(attachments.length ? 'ready' : 'loading');
  const [index, setIndex] = useState(0);
  const [loadedSource, setLoadedSource] = useState('');
  const [candidateFailed, setCandidateFailed] = useState(false);
  useEffect(() => {
    const suppliedAttachments = JSON.parse(attachmentsKey) as typeof attachments;
    if (suppliedAttachments.length) {
      setCandidates(suppliedAttachments);
      setLookupState('ready');
      setIndex(0);
      setLoadedSource('');
      setCandidateFailed(false);
      return;
    }
    const controller = new AbortController();
    setCandidates([]); setIndex(0); setLoadedSource(''); setCandidateFailed(false);
    setLookupState('loading');
    void fetch(apiUrl(`/api/jobs/${jobId}/image-candidates`), { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load images');
        return response.json() as Promise<{ attachments?: Array<{ id: string; fileName: string }> }>;
      })
      .then((body) => { if (controller.signal.aborted) return; setCandidates(body.attachments || []); setIndex(0); setLoadedSource(''); setCandidateFailed(false); setLookupState('ready'); })
      .catch(() => { if (!controller.signal.aborted) setLookupState('error'); });
    return () => controller.abort();
  }, [jobId, attachmentsKey]);
  const attachment = candidates[index];
  const imageSource = attachment ? apiUrl(`/api/jobs/${jobId}/images/${encodeURIComponent(attachment.id)}`) : '';
  const loaded = Boolean(imageSource && loadedSource === imageSource);
  useEffect(() => {
    // A cached image can finish before effects run, or remain mounted when the
    // candidates change. In either case there may be no new onLoad event.
    const image = imageRef.current;
    if (lookupState === 'ready' && image?.complete && image.naturalWidth > 0) setLoadedSource(imageSource);
  }, [imageSource, attachmentsKey, lookupState]);
  const validationState = lookupState === 'loading' ? 'loading' : lookupState === 'error' ? 'error' : loaded ? 'valid' : attachment ? 'loading' : candidateFailed ? 'invalid' : 'invalid';
  useEffect(() => { onValidationChange?.(validationState); }, [validationState, onValidationChange]);

  // Only mount one candidate at a time. Success leaves it in place; failure tries the next.
  return <div className="job-thumbnail" aria-busy={validationState === 'loading'}>
    {attachment && <img
      ref={imageRef}
      key={`${jobId}:${attachment.id}`}
      src={imageSource}
      alt={`Image for ${jobName}`}
      title={attachment.fileName}
      width={64}
      height={64}
      className={loaded ? '' : 'is-checking'}
      onLoad={() => setLoadedSource(imageSource)}
      onError={() => { setLoadedSource(''); setCandidateFailed(true); setIndex((current) => current + 1); }}
    />}
    {!loaded && <span className="job-thumbnail-message" role="status">
      {attachment ? 'Checking…' : lookupState === 'loading' ? 'Loading…' : lookupState === 'error' ? 'Unavailable' : 'No valid image'}
    </span>}
  </div>;
}
