import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing patch target: ${label}`);
  return text.replace(before, after);
}

write('src/playback-start.js', `function hasQueuedWork(player) {
  return Boolean(player?.queue?.current) || Number(player?.queue?.length || 0) > 0;
}

function encodedTrack(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return typeof value.track === 'string' ? value.track : typeof value.encoded === 'string' ? value.encoded : '';
}

/**
 * True only when Lavalink/Shoukaku is actually pointing at the same encoded
 * track Kazagumo exposes as queue.current. Merely having any Shoukaku track is
 * not enough: after a failed/replaced source it can briefly retain the previous
 * encoded track while queue.current already points at the next request.
 */
export function activeTrackMatchesCurrent(player) {
  const current = encodedTrack(player?.queue?.current);
  const active = encodedTrack(player?.shoukaku?.track);
  return Boolean(current && active && current === active);
}

export function playbackNeedsStart(player) {
  if (!player || !hasQueuedWork(player)) return false;
  // Never turn any explicit paused state into an implicit resume.
  if (player.paused || player.shoukaku?.paused) return false;

  // If Kazagumo has a current item, the active Lavalink Base64 must be that
  // exact item. A stale non-empty Shoukaku track must not suppress playback.
  if (player.queue?.current) return !activeTrackMatchesCurrent(player);

  // Queue-only state: preserve the old guard if Lavalink still has an active
  // track during a very short queue transition.
  return !encodedTrack(player.shoukaku?.track);
}

export async function ensureQueuedPlayback(player) {
  if (!playbackNeedsStart(player)) {
    return {
      started: false,
      active: Boolean(player?.paused || player?.shoukaku?.paused || activeTrackMatchesCurrent(player)),
    };
  }

  await player.play();

  // Shoukaku updates its local encoded track when playTrack() completes. Require
  // an exact match here; queue.current alone is not proof that audio was sent to
  // Lavalink and was the source of the v0.1.11 ghost-Now-Playing regression.
  if (!activeTrackMatchesCurrent(player)) {
    throw new Error('The selected track could not start playback. EZ Music will retry/fallback when the source reports a playback error.');
  }

  return { started: true, active: true };
}
`);

{
  const path = 'src/commands.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { ensureQueuedPlayback } from './playback-start.js';`,
    `import { activeTrackMatchesCurrent, ensureQueuedPlayback } from './playback-start.js';`,
    'playback-start import',
  );
  text = replaceExact(
    text,
    `: player.shoukaku?.track ? 'Playing' : (player.queue?.current || player.queue?.length > 0) ? 'Idle (queue waiting)' : 'Idle') : 'Disconnected'}**\``,
    `: activeTrackMatchesCurrent(player) ? 'Playing' : (player.queue?.current || player.queue?.length > 0) ? 'Idle (queue waiting)' : 'Idle') : 'Disconnected'}**\``,
    'status active-track identity',
  );
  text = replaceExact(
    text,
    `if (!player.shoukaku?.track && !player.paused && !player.shoukaku?.paused && (player.queue.current || player.queue.length > 0)) {`,
    `if (!activeTrackMatchesCurrent(player) && !player.paused && !player.shoukaku?.paused && (player.queue.current || player.queue.length > 0)) {`,
    'nowplaying stale-track recovery',
  );
  write(path, text);
}

{
  const path = 'package.json';
  const pkg = JSON.parse(read(path));
  pkg.version = '0.1.12';
  write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

{
  const path = 'package-lock.json';
  const lock = JSON.parse(read(path));
  lock.version = '0.1.12';
  if (lock.packages?.['']) lock.packages[''].version = '0.1.12';
  write(path, `${JSON.stringify(lock, null, 2)}\n`);
}

{
  const path = 'test/source-routing.test.js';
  let text = read(path);
  text = replaceExact(text, `assert.equal(pkg.version, '0.1.11');`, `assert.equal(pkg.version, '0.1.12');`, 'version assertion');
  write(path, text);
}

write('test/playback-start-v0112.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activeTrackMatchesCurrent, ensureQueuedPlayback, playbackNeedsStart } from '../src/playback-start.js';

function fakePlayer({ current = 'encoded-new', active = 'encoded-new', paused = false, upcoming = 0, onPlay = null } = {}) {
  const player = {
    paused,
    queue: {
      current: current ? { track: current, title: 'Current' } : null,
      length: upcoming,
    },
    shoukaku: { track: active || null, paused },
    playCalls: 0,
    async play() {
      this.playCalls += 1;
      if (onPlay) return onPlay(this);
      if (this.queue.current) this.shoukaku.track = this.queue.current.track;
    },
  };
  return player;
}

test('matching encoded Lavalink track is the only active-current success state', () => {
  assert.equal(activeTrackMatchesCurrent(fakePlayer()), true);
  assert.equal(activeTrackMatchesCurrent(fakePlayer({ active: 'encoded-old' })), false);
  assert.equal(activeTrackMatchesCurrent(fakePlayer({ active: null })), false);
  assert.equal(activeTrackMatchesCurrent(fakePlayer({ current: null, active: 'encoded-old', upcoming: 1 })), false);
});

test('stale previous Shoukaku track cannot suppress a new queue.current start', () => {
  const ghost = fakePlayer({ current: 'encoded-matthew', active: 'encoded-previous' });
  assert.equal(playbackNeedsStart(ghost), true);
});

test('matching active current is never started twice', () => {
  assert.equal(playbackNeedsStart(fakePlayer({ current: 'same', active: 'same' })), false);
});

test('manual pause still blocks automatic restart even when encoded tracks differ', () => {
  assert.equal(playbackNeedsStart(fakePlayer({ current: 'encoded-new', active: 'encoded-old', paused: true })), false);
});

test('ensureQueuedPlayback sends exactly one play for a ghost current and verifies the new encoded track', async () => {
  const ghost = fakePlayer({ current: 'encoded-matthew', active: 'encoded-previous' });
  const result = await ensureQueuedPlayback(ghost);
  assert.equal(ghost.playCalls, 1);
  assert.deepEqual(result, { started: true, active: true });
  assert.equal(ghost.shoukaku.track, 'encoded-matthew');
});

test('queue.current alone is no longer accepted as proof of a successful start', async () => {
  const ghost = fakePlayer({
    current: 'encoded-new',
    active: 'encoded-old',
    onPlay(player) {
      // Simulate a resolve/start failure that leaves the stale Lavalink track in
      // place. The old v0.1.11 check incorrectly treated queue.current as active.
      player.shoukaku.track = 'encoded-old';
    },
  });
  await assert.rejects(() => ensureQueuedPlayback(ghost), /could not start playback/i);
  assert.equal(ghost.playCalls, 1);
});

test('status and nowplaying use exact active-current identity instead of any non-empty Shoukaku track', () => {
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');
  assert.match(commands, /activeTrackMatchesCurrent, ensureQueuedPlayback/);
  assert.match(commands, /activeTrackMatchesCurrent\\(player\\) \\? 'Playing'/);
  assert.match(commands, /if \\(!activeTrackMatchesCurrent\\(player\\) && !player\\.paused/);
});

test('v0.1.12 ghost fix preserves low-memory raw playback profile', () => {
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8');
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.match(app, /bufferDurationMs:\\s*2000/);
  assert.match(app, /frameBufferDurationMs:\\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\\s*true/);
  assert.match(app, /equalizer:\\s*false/i);
  assert.match(app, /timescale:\\s*false/i);
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});
`);

{
  const path = 'README.md';
  let text = read(path);
  if (!text.includes('## Ghost playback start fix (v0.1.12)')) {
    text += `\n## Ghost playback start fix (v0.1.12)\n\nPlayback start/recovery now verifies that Lavalink/Shoukaku's active encoded track is the **same encoded track as Kazagumo's current queue item**. A stale non-empty Shoukaku track from an earlier failed/replaced source can no longer make EZ Music show a new song at 0:00 without ever sending it to Lavalink. Typed picker choices, direct URLs and \`/nowplaying\` recovery all use the corrected start gate; \`/status\` only reports **Playing** for an exact active/current match. Manual pause protection remains intact. This fix does not change buffers, DSP, heap caps, source clients or add background polling.\n`;
  }
  write(path, text);
}
