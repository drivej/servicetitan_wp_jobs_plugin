import { Button, Chip } from '@mui/material';
import { useEffect, useState } from 'react';
import type { WordPressPostPreview as PostPreview } from '../shared/wordpress-preview';
import { apiFetch } from './api';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const imageUrl = (value?: string) => {
  try { const url = new URL(value || ''); return url.protocol === 'https:' || url.protocol === 'http:' ? escapeHtml(url.href) : ''; }
  catch { return ''; }
};

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
  const source = post ? `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0;background:#fff;color:#263347;font:16px/1.75 system-ui,sans-serif}article{max-width:760px;margin:auto;padding:32px}h1{font-size:32px;line-height:1.2;color:#14243b;margin:0 0 20px}h2,h3{line-height:1.35;color:#14243b}img{max-width:100%;height:auto;border-radius:12px}article>img{width:100%;max-height:380px;object-fit:cover;margin-bottom:24px}.excerpt{color:#64748b;font-size:18px;border-bottom:1px solid #e2e8f0;margin-bottom:24px;padding-bottom:16px}a{color:inherit;pointer-events:none}iframe,script,form,object,embed{display:none}pre,table{max-width:100%;overflow:auto}*{box-sizing:border-box}@media(max-width:500px){article{padding:20px}h1{font-size:26px}}</style></head><body><article>${imageUrl(post.featuredImageUrl) ? `<img src="${imageUrl(post.featuredImageUrl)}" alt="${escapeHtml(post.featuredImageAlt || '')}">` : ''}<h1>${post.titleHtml || 'Untitled post'}</h1>${post.excerptHtml ? `<div class="excerpt">${post.excerptHtml}</div>` : ''}${post.contentHtml || '<p>No post content yet.</p>'}</article></body></html>` : '';
  return <section className='panel wordpress-preview-card' aria-labelledby='wordpress-preview-title'>
    <div className='wordpress-preview-heading'><div><h2 id='wordpress-preview-title'>WordPress post preview</h2><p className='field-help'>Saved WordPress content in a simplified layout.</p></div><Button size='small' disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh preview</Button></div>
    {loading && <p role='status'>Loading WordPress post…</p>}
    {error && <p role='alert'>{error}</p>}
    {post && <><div className='wordpress-preview-meta'><Chip size='small' label={post.status === 'publish' ? 'Published' : post.status === 'trash' ? 'Trash' : post.status === 'draft' ? 'Draft' : post.status} />{post.modifiedOn && <span>Updated {new Date(post.modifiedOn).toLocaleString()}</span>}</div><iframe title='WordPress post mockup' sandbox='' referrerPolicy='no-referrer' srcDoc={source} className='wordpress-preview-frame' /></>}
  </section>;
}
