import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseTimeToSeconds, truncate, isUrl } from '../src/utils.js';

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_665_000), '1:01:05');
});

test('parseTimeToSeconds', () => {
  assert.equal(parseTimeToSeconds('90'), 90);
  assert.equal(parseTimeToSeconds('1:30'), 90);
  assert.equal(parseTimeToSeconds('1:02:03'), 3723);
  assert.equal(parseTimeToSeconds('nope'), null);
});

test('truncate and URL detection', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(isUrl('https://example.com/a'), true);
  assert.equal(isUrl('song name'), false);
});
