import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseTimeToSeconds, truncate, isUrl, trackKey, radioFallbackHistory } from '../src/utils.js';

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

test('trackKey normalizes metadata and rejects blank tracks', () => {
  assert.equal(trackKey({ author: ' Artist ', title: ' Song ' }), 'artist\u0000song');
  assert.equal(trackKey({ author: '', title: '' }), '');
});

test('radio fallback prefers older history and falls back to recent history for a new server', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    uri: `https://example.test/${index}`,
    author: `Artist ${index}`,
    title: `Track ${index}`,
  }));
  assert.deepEqual(radioFallbackHistory(history, 15, 3).map((row) => row.title), ['Track 15', 'Track 16', 'Track 17']);

  const shortHistory = history.slice(0, 4);
  assert.deepEqual(radioFallbackHistory(shortHistory, 15, 2).map((row) => row.title), ['Track 0', 'Track 1']);
});
