import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractSafeSeoDetails, normalizeServiceName, serviceGuidance } from './job-seo.js';

test('extracts controlled SEO categories without copying customer notes', () => {
  const summary = 'Customer Jane called from 555-555-1212 about no hot water. Technician repaired the unit.';
  assert.deepEqual(extractSafeSeoDetails(summary), {
    issue: 'a hot-water performance issue',
    action: 'targeted repairs',
  });
  assert.doesNotMatch(JSON.stringify(extractSafeSeoDetails(summary)), /Jane|555/);
});

test('normalizes internal job-type wording for public copy', () => {
  assert.equal(normalizeServiceName('Stoppage (1hr)'), 'Drain Clearing');
  assert.equal(normalizeServiceName('Water Heater Flush (1.5hrs.)'), 'Water Heater Flush');
  assert.match(serviceGuidance('Water Heater Repair'), /reliable hot water/i);
});

test('does not repeat service in generic guidance', () => {
  assert.equal(
    serviceGuidance('Plumbing Service'),
    'Professional plumbing service helps address the immediate concern and identify related maintenance needs.',
  );
  assert.equal(
    serviceGuidance('Plumbing Services'),
    'Professional plumbing services help address the immediate concern and identify related maintenance needs.',
  );
});
