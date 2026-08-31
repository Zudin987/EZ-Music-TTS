import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSearchChoices } from '../src/search-choices.js';

function track(title, author, identifier, length = 205_000) {
  return { title, author, identifier, uri: `https://www.youtube.com/watch?v=${identifier}`, length };
}

function target(routes) {
  return {
    async search(query, options = {}) {
      return routes[`${options.source || ''}${query}`] || { type: 'SEARCH', tracks: [] };
    },
  };
}

test('corroborated artist identity removes unrelated exact-title result', async () => {
  const search = target({
    'ytsearch:Heavy Serenade lyrics': {
      type: 'SEARCH',
      tracks: [track('NMIXX - Heavy Serenade (Lyrics)', '7clouds K-pop', 'lyrics00001')],
    },
    'ytmsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [
        track('Heavy Serenade', 'Khmer woman', 'wrong000001'),
        track('Heavy Serenade', 'NMIXX', 'music000001'),
      ],
    },
    'ytsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [
        track('NMIXX(엔믹스) “Heavy Serenade” (Official Audio)', 'NMIXX', 'audio000001'),
        track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment', 'mvvideo0001'),
      ],
    },
  });

  const choices = await resolveSearchChoices(search, 'Heavy Serenade', null, { limit: 3 });
  assert.equal(choices.length, 3);
  assert.ok(choices.every((choice) => !/khmer woman/i.test(choice.track.author || '')));
  assert.ok(choices.every((choice) => /nmixx|jyp/i.test(`${choice.track.title || ''} ${choice.track.author || ''}`)));
  assert.equal(choices[0].kind, 'Lyrics');
  assert.ok(choices.some((choice) => choice.kind === 'Audio'));
});
