import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackToolsPayload, playerButtons, queueManagerPayload, queueText } from '../src/ui.js';

function fakeTrack(index, title = `Track ${index}`) {
  return { identifier: `track-${index}`, title, author: `Artist ${index}`, length: 240_000, isSeekable: true, isStream: false };
}

function fakePlayer(count = 3) {
  const queue = Array.from({ length: count }, (_, index) => fakeTrack(index + 1));
  queue.current = fakeTrack(0, 'Current');
  queue.previous = [fakeTrack(-1, 'Previous track')];
  Object.defineProperty(queue, 'durationLength', { get: () => queue.reduce((sum, track) => sum + track.length, 0) });
  return {
    queue,
    paused: false,
    playing: true,
    loop: 'none',
    volume: 80,
    position: 60_000,
    getPrevious: () => queue.previous[0],
  };
}

test('player panel exposes only approved lightweight controls', () => {
  const labels = playerButtons(fakePlayer(), 'standard')
    .flatMap((row) => row.components)
    .map((component) => component.data.label);
  assert.deepEqual(labels, [
    'Previous', 'Loop: Off', 'Pause', 'Shuffle', 'Skip',
    'Queue (3)', 'Clear', 'Stop', 'Autoplay: On', 'Vol -', 'Vol +', 'More', 'Refresh',
  ]);
  assert.equal(labels.some((label) => /filter|karaoke|8d|nightcore|eq|bass/i.test(label)), false);
});

test('private queue manager is paged and stateless', () => {
  const player = fakePlayer(30);
  const payload = queueManagerPayload(player, 0, 2);
  const json = JSON.stringify(payload.components.map((row) => row.toJSON()));
  assert.match(json, /music:qselect:0/);
  assert.match(json, /music:qpage:1/);
  assert.match(json, /music:qremove:2:0:/);
  assert.match(json, /music:qnext:2:0:/);
  assert.match(json, /music:qplay:2:0:/);
  assert.match(json, /Dedupe/);
});

test('playback tools expose seek/replay without DSP controls', () => {
  const payload = playbackToolsPayload(fakePlayer(), 'off');
  const labels = payload.components.flatMap((row) => row.components).map((component) => component.data.label);
  assert.deepEqual(labels, ['-30s', '-10s', 'Replay', '+10s', '+30s', 'Seek…', 'Refresh', 'Back']);
  assert.equal(labels.some((label) => /filter|eq|pitch|speed|bass|nightcore/i.test(label)), false);
});

test('private queue text stays under Discord message limit', () => {
  const player = fakePlayer(50);
  for (const track of player.queue) {
    track.title = 'A'.repeat(300);
    track.author = 'B'.repeat(200);
  }
  const text = queueText(player);
  assert.ok(text.length <= 1850, `queue response too long: ${text.length}`);
  assert.match(text, /more/);
});
