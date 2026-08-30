import test from 'node:test';
import assert from 'node:assert/strict';
import { playerButtons, queueText } from '../src/ui.js';

function fakeTrack(index, title = `Track ${index}`) {
  return { title, author: `Artist ${index}`, length: 240_000 };
}

function fakePlayer(count = 3) {
  const queue = Array.from({ length: count }, (_, index) => fakeTrack(index + 1));
  queue.current = fakeTrack(0, 'Current');
  queue.previous = [fakeTrack(-1, 'Previous track')];
  Object.defineProperty(queue, 'durationLength', { get: () => queue.reduce((sum, track) => sum + track.length, 0) });
  return {
    queue,
    paused: false,
    loop: 'none',
    volume: 80,
    getPrevious: () => queue.previous[0],
  };
}

test('player panel exposes only approved controls', () => {
  const labels = playerButtons(fakePlayer(), 'standard')
    .flatMap((row) => row.components)
    .map((component) => component.data.label);
  assert.deepEqual(labels, [
    'Previous', 'Loop: Off', 'Pause', 'Shuffle', 'Skip',
    'Queue (3)', 'Clear', 'Stop', 'Autoplay: On', 'Vol -', 'Vol +', 'Refresh',
  ]);
  assert.equal(labels.some((label) => /filter|karaoke|8d|nightcore|eq/i.test(label)), false);
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
