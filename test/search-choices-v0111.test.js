import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveSearchChoices, searchChoiceKind, shouldOfferSearchChoices } from '../src/search-choices.js';

function track(title, author, identifier, length = 200_000) {
  return {
    title,
    author,
    identifier,
    uri: `https://www.youtube.com/watch?v=${identifier}`,
    length,
  };
}

function target(routes) {
  const calls = [];
  return {
    calls,
    async search(query, options = {}) {
      calls.push({ query, source: options.source });
      const key = `${options.source || ''}${query}`;
      return routes[key] || { type: 'SEARCH', tracks: [] };
    },
  };
}

test('typed text gets a picker while links and explicit source queries stay immediate', () => {
  assert.equal(shouldOfferSearchChoices('Heavy Serenade'), true);
  assert.equal(shouldOfferSearchChoices('NMIXX Heavy Serenade'), true);
  assert.equal(shouldOfferSearchChoices('https://www.youtube.com/watch?v=6Ycn9qZK09I'), false);
  assert.equal(shouldOfferSearchChoices('https://soundcloud.com/example/song'), false);
  assert.equal(shouldOfferSearchChoices('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), false);
  assert.equal(shouldOfferSearchChoices('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), false);
  assert.equal(shouldOfferSearchChoices('ytsearch:NMIXX Heavy Serenade'), false);
  assert.equal(shouldOfferSearchChoices('ytmsearch:NMIXX Heavy Serenade'), false);
  assert.equal(shouldOfferSearchChoices('scsearch:NMIXX Heavy Serenade'), false);
});

test('typed search queries lyrics, YTM, and normal YouTube and returns three diverse choices', async () => {
  const search = target({
    'ytsearch:Heavy Serenade lyrics': {
      type: 'SEARCH',
      tracks: [
        track('NMIXX - Heavy Serenade Lyrics', 'NMIXX Lyrics', 'lyrics00001'),
        track('Heavy Serenade (Karaoke)', 'Karaoke Channel', 'karaoke0001'),
      ],
    },
    'ytmsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [track('Heavy Serenade', 'NMIXX', 'music000001')],
    },
    'ytsearch:Heavy Serenade': {
      type: 'SEARCH',
      tracks: [track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment', 'mvvideo0001')],
    },
  });

  const choices = await resolveSearchChoices(search, 'Heavy Serenade', { id: 'u' });
  assert.equal(choices.length, 3);
  assert.deepEqual(search.calls, [
    { query: 'Heavy Serenade lyrics', source: 'ytsearch:' },
    { query: 'Heavy Serenade', source: 'ytmsearch:' },
    { query: 'Heavy Serenade', source: 'ytsearch:' },
  ]);
  assert.deepEqual(choices.map((choice) => choice.kind), ['Lyrics', 'Music', 'M/V']);
  assert.equal(choices[0].track.identifier, 'lyrics00001');
  assert.ok(!choices.some((choice) => /karaoke/i.test(choice.track.title)));
});

test('lyrics/audio are preferred over M/V for a plain song query', async () => {
  const search = target({
    'ytsearch:Rose lyrics': { type: 'SEARCH', tracks: [track('D.O. - Rose Lyrics', 'Lyrics Channel', 'lyricsrose01')] },
    'ytmsearch:Rose': { type: 'SEARCH', tracks: [track('Rose', 'D.O', 'musicrose001')] },
    'ytsearch:Rose': { type: 'SEARCH', tracks: [
      track('D.O. Rose Official Audio', 'D.O', 'audiorose001'),
      track('D.O. Rose Official Music Video', 'SMTOWN', 'videorose001'),
    ] },
  });
  const choices = await resolveSearchChoices(search, 'Rose', null);
  assert.equal(choices[0].kind, 'Lyrics');
  assert.ok(choices.findIndex((choice) => choice.kind === 'Audio') < choices.findIndex((choice) => choice.kind === 'M/V') || !choices.some((choice) => choice.kind === 'M/V'));
});

test('exact duplicate media IDs collapse but distinct Lyrics/MV uploads remain selectable', async () => {
  const duplicate = track('Song Lyrics', 'Artist', 'samevideo01');
  const search = target({
    'ytsearch:Song lyrics': { type: 'SEARCH', tracks: [duplicate] },
    'ytmsearch:Song': { type: 'SEARCH', tracks: [track('Song', 'Artist', 'musicvideo1')] },
    'ytsearch:Song': { type: 'SEARCH', tracks: [duplicate, track('Song M/V', 'Artist', 'musicvideo2')] },
  });
  const choices = await resolveSearchChoices(search, 'Song', null);
  assert.equal(choices.filter((choice) => choice.track.identifier === 'samevideo01').length, 1);
  assert.ok(choices.some((choice) => choice.kind === 'Lyrics'));
  assert.ok(choices.some((choice) => choice.kind === 'M/V') || choices.some((choice) => choice.kind === 'Music'));
});

test('choice kind labels identify common upload types', () => {
  assert.equal(searchChoiceKind(track('Song Lyrics', 'Artist', 'a')), 'Lyrics');
  assert.equal(searchChoiceKind(track('Song Official Audio', 'Artist', 'b')), 'Audio');
  assert.equal(searchChoiceKind(track('Song M/V', 'Artist', 'c')), 'M/V');
  assert.equal(searchChoiceKind(track('Song', 'Artist', 'd'), 'ytm'), 'Music');
  assert.equal(searchChoiceKind(track('Song', 'Artist', 'e'), 'youtube'), 'YouTube');
});

test('three-choice typed search keeps the v0.1.14 low-memory playback profile', () => {
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const ui = fs.readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const picker = fs.readFileSync(new URL('../src/search-picker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8');
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.version, '0.1.14');
  assert.match(pkg.scripts.check, /src\/search-choices\.js/);
  assert.match(commands, /shouldOfferSearchChoices\(query\)/);
  assert.match(commands, /resolveSearchChoices\(music, query, interaction\.user, \{ limit: 3 \}\)/);
  assert.doesNotMatch(commands, /getBoolean\('select'\)/);
  assert.doesNotMatch(commands, /setName\('select'\)/);
  assert.match(ui, /slice\(0, 3\)/);
  assert.match(ui, /Lyrics\/Audio are preferred over M\/V/);
  assert.match(picker, /tracks\.slice\(0, 3\)/);

  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});
