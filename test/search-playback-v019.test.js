import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolvePreferredSearch } from '../src/source-routing.js';
import { searchTrackScore } from '../src/search-quality.js';
import { ensureQueuedPlayback, playbackNeedsStart } from '../src/playback-start.js';
import { jukeboxPlayerPayload } from '../src/ui.js';

function track(title, author = 'Unknown') {
  return { title, author, identifier: `${title}:${author}`, length: 180_000 };
}

function searchTarget({ ytm = [], yt = [] }) {
  const calls = [];
  return {
    calls,
    async search(query, options = {}) {
      calls.push({ query, source: options.source || null });
      if (options.source === 'ytmsearch:') return { type: 'SEARCH', tracks: ytm };
      if (options.source === 'ytsearch:') return { type: 'SEARCH', tracks: yt };
      return { type: 'SEARCH', tracks: [] };
    },
  };
}

test('weak YTM title falls back to a matching normal YouTube result', async () => {
  const target = searchTarget({
    ytm: [track('LOUD.', 'NMIXX')],
    yt: [track('NMIXX - Heavy Serenade (Official Audio)', 'NMIXX')],
  });
  const result = await resolvePreferredSearch(target, 'heavy serenade nmixx', { id: 'u1' });
  assert.equal(result.tracks[0].title, 'NMIXX - Heavy Serenade (Official Audio)');
  assert.deepEqual(target.calls.map((call) => call.source), ['ytmsearch:', 'ytsearch:']);
});

test('unrelated YTM result does not win a title-only query', async () => {
  const target = searchTarget({
    ytm: [track('Crescendo.', 'Another Artist')],
    yt: [track('Heavy Serenade', 'NMIXX')],
  });
  const result = await resolvePreferredSearch(target, 'heavy serenade', { id: 'u1' });
  assert.equal(result.tracks[0].title, 'Heavy Serenade');
});

test('good title+artist split stays on YTM without an unnecessary fallback', async () => {
  const target = searchTarget({
    ytm: [track('Abracadabra', 'Lady Gaga')],
    yt: [track('Abracadabra', 'Lady Gaga')],
  });
  const result = await resolvePreferredSearch(target, 'lady gaga abracadabra', { id: 'u1' });
  assert.equal(result.tracks[0].title, 'Abracadabra');
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].source, 'ytmsearch:');
});

test('artist-only searches can still match the author field', () => {
  assert.ok(searchTrackScore('aespa', track('Supernova', 'aespa')) >= 0.55);
});

test('weak results from both search sources return no track instead of a wrong song', async () => {
  const target = searchTarget({
    ytm: [track('LOUD.', 'NMIXX')],
    yt: [track('Crescendo.', 'NMIXX')],
  });
  const result = await resolvePreferredSearch(target, 'heavy serenade nmixx', { id: 'u1' });
  assert.equal(result.tracks.length, 0);
});

test('direct/explicit search requests bypass automatic relevance fallback', async () => {
  const calls = [];
  const target = {
    async search(query, options) {
      calls.push({ query, options });
      return { type: 'SEARCH', tracks: [track('Whatever', 'Explicit')] };
    },
  };
  const result = await resolvePreferredSearch(target, 'ytsearch:heavy serenade', { id: 'u1' });
  assert.equal(result.tracks.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'ytsearch:heavy serenade');
});

function playerMock({ current = track('Heavy Serenade', 'NMIXX'), upcoming = [], wrapperPlaying = false, llTrack = null, paused = false, playImpl = null } = {}) {
  const queue = [...upcoming];
  queue.current = current;
  const player = {
    queue,
    playing: wrapperPlaying,
    paused,
    shoukaku: { track: llTrack, paused },
    playCalls: 0,
    async play() {
      this.playCalls += 1;
      if (playImpl) return playImpl(this);
      this.shoukaku.track = 'encoded-track';
    },
  };
  return player;
}

test('stale Kazagumo playing=true cannot block an idle Lavalink start', async () => {
  const player = playerMock({ wrapperPlaying: true, llTrack: null });
  assert.equal(playbackNeedsStart(player), true);
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, true);
  assert.equal(player.playCalls, 1);
});

test('an actually active Lavalink track is never started twice', async () => {
  const player = playerMock({ wrapperPlaying: true, llTrack: 'encoded-track' });
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, false);
  assert.equal(player.playCalls, 0);
});

test('manual pause is not implicitly resumed by queue activity', async () => {
  const player = playerMock({ paused: true, llTrack: 'encoded-track' });
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, false);
  assert.equal(player.playCalls, 0);
});

test('queued-only paused state is never implicitly started', async () => {
  const player = playerMock({ current: null, upcoming: [track('Heavy Serenade', 'NMIXX')], paused: true, llTrack: null });
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, false);
  assert.equal(player.playCalls, 0);
});

test('Kazagumo resolve failure cannot be reported as a successful start', async () => {
  const player = playerMock({
    llTrack: null,
    playImpl(instance) {
      instance.queue.current = null;
      instance.shoukaku.track = null;
    },
  });
  await assert.rejects(() => ensureQueuedPlayback(player), /could not start playback/i);
});

test('queued-idle nowplaying UI exposes the waiting queue instead of saying nothing is playing', () => {
  const queue = [track('Heavy Serenade', 'NMIXX'), track('High Horse', 'NMIXX')];
  queue.current = null;
  const player = {
    queue,
    paused: false,
    volume: 80,
    loop: 'none',
    getPrevious: () => null,
  };
  const payload = jukeboxPlayerPayload(player, 'off');
  const json = JSON.stringify(payload.components.map((component) => component.toJSON?.() ?? component));
  assert.match(json, /Playback Idle/);
  assert.match(json, /Heavy Serenade/);
  assert.match(json, /Queue \(2\)/);
});

test('commands use centralized playback start and nowplaying no longer requires current track', () => {
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(commands, /if \(!player\.playing && !player\.paused\) await player\.play\(\);/);
  const nowPlaying = commands.split("if (name === 'nowplaying') {")[1]?.split('      requireSameVoice(interaction, player);')[0] || '';
  assert.doesNotMatch(nowPlaying, /requireCurrentTrack/);
  assert.match(commands, /ensureQueuedPlayback\(player\)/);
});
