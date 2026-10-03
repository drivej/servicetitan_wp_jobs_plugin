import { useState } from 'react';
import { apiUrl } from './api';

export function JobThumbnail({ jobId, jobName, attachments }: {
  jobId: number;
  jobName: string;
  attachments: Array<{ id: string; fileName: string }>;
}) {
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const attachment = attachments[index];

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
      onError={() => { setLoaded(false); setIndex((current) => current + 1); }}
    />}
    {!loaded && <span className="job-thumbnail-message" role="status">
      {attachment ? 'Checking…' : 'No valid image'}
    </span>}
  </div>;
}
