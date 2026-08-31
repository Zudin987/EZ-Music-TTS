import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSearchChoices } from '../src/search-choices.js';

function track(title, author, identifier, length) {
  return { title, author, identifier, uri: `https://www.youtube.com/watch?v=${identifier}`, length };
}

function target(routes) {
  return {
    async search(query, options = {}) {
      return routes[`${options.source || ''}${query}`] || { type: 'SEARCH', tracks: [] };
    },
  };
}

test('picker keeps song-length uploads and drops trailers/full albums', async () => {
  const search = target({
    'ytsearch:Heavy Serenade lyrics': {
      type: 'SEARCH',
      tracks: [
        track('NMIXX Heavy Serenade Lyrics', 'NMIXX Lyrics', 'lyrics00001', 202_000),
        track('NMIXX Heavy Serenade Trailer', 'NMIXX', 'trailer0001', 52_000),
      ],
    },
    'ytmsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [track('Heavy Serenade', 'NMIXX', 'music000001', 205_000)],
    },
    'ytsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [
        track('NMIXX Heavy Serenade Official Audio', 'NMIXX', 'audio000001', 204_000),
        track('[Full Album] NMIXX - Heavy Serenade', 'NMIXX', 'album000001', 1_850_000),
      ],
    },
  });

  const choices = await resolveSearchChoices(search, 'Heavy Serenade', null, { limit: 3 });
  assert.ok(choices.length >= 2);
  assert.ok(choices.every((choice) => choice.track.length >= 140_000 && choice.track.length <= 270_000));
  assert.ok(!choices.some((choice) => /trailer|full album/i.test(choice.track.title || '')));
});
