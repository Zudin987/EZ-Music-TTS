import test from 'node:test';
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
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(commands, /activeTrackMatchesCurrent, ensureQueuedPlayback/);
  assert.match(commands, /activeTrackMatchesCurrent\(player\) \? 'Playing'/);
  assert.match(commands, /if \(!activeTrackMatchesCurrent\(player\) && !player\.paused/);
});

test('v0.1.12 ghost fix preserves low-memory raw playback profile', () => {
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8');
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(app, /equalizer:\s*false/i);
  assert.match(app, /timescale:\s*false/i);
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});
