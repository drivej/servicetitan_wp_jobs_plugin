import { buildWordPressPreviewDocument } from './wordpressPreviewDocument';
import { Button, Chip } from '@mui/material';
import { useEffect, useState } from 'react';
import type { WordPressPostPreview as PostPreview } from '../shared/wordpress-preview';
import { apiFetch } from './api';


export function WordPressPostPreview({ jobId, revision }: { jobId: number; revision: unknown }) {
  const [post, setPost] = useState<PostPreview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setPost(undefined);
    void (async () => {
      try {
        const response = await apiFetch(`/api/jobs/${jobId}/wordpress/preview`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load WordPress preview.');
        if (active) setPost(body as PostPreview);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load WordPress preview.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [jobId, revision, retry]);
  const source = post ? buildWordPressPreviewDocument(post) : '';
  return <section className='panel wordpress-preview-card' aria-labelledby='wordpress-preview-title'>
    <div className='wordpress-preview-heading'><div><h2 id='wordpress-preview-title'>WordPress post preview</h2><p className='field-help'>Saved WordPress content in a simplified layout.</p></div><Button size='small' disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh preview</Button></div>
    {loading && <p role='status'>Loading WordPress post…</p>}
    {error && <p role='alert'>{error}</p>}
    {post && <><div className='wordpress-preview-meta'><Chip size='small' label={post.status === 'publish' ? 'Published' : post.status === 'trash' ? 'Trash' : post.status === 'draft' ? 'Draft' : post.status} />{post.modifiedOn && <span>Updated {new Date(post.modifiedOn).toLocaleString()}</span>}</div><iframe title='WordPress post mockup' sandbox='' referrerPolicy='no-referrer' srcDoc={source} className='wordpress-preview-frame' /></>}
  </section>;
}
