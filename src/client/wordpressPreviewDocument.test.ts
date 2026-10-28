import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordPressPreviewDocument } from './wordpressPreviewDocument';

test('previews the complete body without prepending the truncated WordPress excerpt', () => {
  const contentHtml = '<p>We offered a camera inspection.</p><h2>What can help diagnose a sewer-line restriction?</h2><p>A camera inspection can help us look inside a drain line and assess its condition.</p>';
  const html = buildWordPressPreviewDocument({
    id: 21413, status: 'draft', titleHtml: 'Drain Cleaning in Torrance',
    excerptHtml: '<p>We offered a camera inspection.What can help diagnose a sewer-line restriction?A camera inspection can help us look i</p>',
    contentHtml,
  });
  assert(html.includes(contentHtml));
  assert(!html.includes('inspection.What'));
  assert(!html.includes('look i</p>'));
  assert.equal(html.split('What can help diagnose a sewer-line restriction?').length - 1, 1);
});

test('clearly labels the excerpt when full body content is unavailable', () => {
  const html = buildWordPressPreviewDocument({ id: 1, status: 'draft', titleHtml: 'Title', contentHtml: '', excerptHtml: '<p>Summary</p>' });
  assert(html.includes('Only the saved excerpt is available.'));
  assert(html.includes('<p>Summary</p>'));
});
