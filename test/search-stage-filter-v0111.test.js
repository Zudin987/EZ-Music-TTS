import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from '../src/search-quality.js';

function track(title, author = 'NMIXX') {
  return { title, author };
}

test('broadcast/stage versions are rejected for a plain song query', () => {
  const variants = [
    'NMIXX - Heavy Serenade | Show! MusicCore',
    'NMIXX Heavy Serenade Performance',
    'NMIXX Heavy Serenade Stage',
    'NMIXX Heavy Serenade Fancam',
    'NMIXX Heavy Serenade Inkigayo',
    'NMIXX Heavy Serenade M Countdown',
    'NMIXX Heavy Serenade Music Bank',
  ];
  for (const title of variants) {
    assert.ok(searchTrackScore('Heavy Serenade', track(title)) < SEARCH_MATCH_THRESHOLD, title);
  }
});

test('stage/performance remains valid when explicitly requested', () => {
  assert.ok(searchTrackScore('Heavy Serenade performance', track('NMIXX Heavy Serenade Performance')) >= SEARCH_MATCH_THRESHOLD);
  assert.ok(searchTrackScore('Heavy Serenade stage', track('NMIXX Heavy Serenade Stage')) >= SEARCH_MATCH_THRESHOLD);
});
