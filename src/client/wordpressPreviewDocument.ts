import type { WordPressPostPreview } from '../shared/wordpress-preview';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const imageUrl = (value?: string) => {
  try { const url = new URL(value || ''); return url.protocol === 'https:' || url.protocol === 'http:' ? escapeHtml(url.href) : ''; }
  catch { return ''; }
};


export const buildWordPressPreviewDocument = (post: WordPressPostPreview): string => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0;background:#fff;color:#263347;font:16px/1.75 system-ui,sans-serif}article{max-width:760px;margin:auto;padding:32px}h1{font-size:32px;line-height:1.2;color:#14243b;margin:0 0 20px}h2,h3{line-height:1.35;color:#14243b}img{max-width:100%;height:auto;border-radius:12px}article>img{width:100%;max-height:380px;object-fit:cover;margin-bottom:24px}a{color:inherit;pointer-events:none}iframe,script,form,object,embed{display:none}pre,table{max-width:100%;overflow:auto}*{box-sizing:border-box}@media(max-width:500px){article{padding:20px}h1{font-size:26px}}</style></head><body><article>${imageUrl(post.featuredImageUrl) ? `<img src="${imageUrl(post.featuredImageUrl)}" alt="${escapeHtml(post.featuredImageAlt || '')}">` : ''}<h1>${post.titleHtml || 'Untitled post'}</h1>${post.contentHtml || (post.excerptHtml ? `<aside><p>Only the saved excerpt is available.</p>${post.excerptHtml}</aside>` : '<p>No post content yet.</p>')}</article></body></html>`;
