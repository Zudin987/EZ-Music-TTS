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
    'NMIXX Heavy Serenade Dance Practice',
    'NMIXX Heavy Serenade Choreography',
  ];
  for (const title of variants) assert.ok(searchTrackScore('Heavy Serenade', track(title)) < SEARCH_MATCH_THRESHOLD, title);
});

test('promo/trailer versions are rejected for a plain song query', () => {
  const variants = [
    'NMIXX Heavy Serenade Trailer',
    'NMIXX Heavy Serenade Teaser',
    'NMIXX Heavy Serenade Preview',
    'NMIXX Heavy Serenade Snippet',
    'NMIXX Heavy Serenade Shorts',
  ];
  for (const title of variants) assert.ok(searchTrackScore('Heavy Serenade', track(title)) < SEARCH_MATCH_THRESHOLD, title);
});

test('fan-edited versions are rejected for a plain song query', () => {
  const variants = [
    "NMIXX ‘Heavy Serenade’ but the hidden vocals are louder",
    'NMIXX Heavy Serenade Vocals Louder',
    'NMIXX Heavy Serenade Bass Boosted',
    'NMIXX Heavy Serenade 8D',
    'NMIXX Heavy Serenade Line Distribution',
    'NMIXX Heavy Serenade Fanmade',
    'NMIXX Heavy Serenade Fan Made',
    'NMIXX Heavy Serenade Edit',
  ];
  for (const title of variants) assert.ok(searchTrackScore('Heavy Serenade', track(title)) < SEARCH_MATCH_THRESHOLD, title);
});

test('alternate variants remain valid when explicitly requested', () => {
  assert.ok(searchTrackScore('Heavy Serenade performance', track('NMIXX Heavy Serenade Performance')) >= SEARCH_MATCH_THRESHOLD);
  assert.ok(searchTrackScore('Heavy Serenade stage', track('NMIXX Heavy Serenade Stage')) >= SEARCH_MATCH_THRESHOLD);
  assert.ok(searchTrackScore('Heavy Serenade edit', track('NMIXX Heavy Serenade Edit')) >= SEARCH_MATCH_THRESHOLD);
  assert.ok(searchTrackScore('Heavy Serenade trailer', track('NMIXX Heavy Serenade Trailer')) >= SEARCH_MATCH_THRESHOLD);
});
