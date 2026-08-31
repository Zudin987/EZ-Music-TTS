import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activeTrackMatchesCurrent } from '../src/playback-start.js';

function player(current, active) {
  return {
    queue: { current: current ? { track: current } : null },
    shoukaku: { track: active || null },
  };
}

test('late TrackStart identity mismatch is detectable from Shoukaku encoded track', () => {
  assert.equal(activeTrackMatchesCurrent(player('encoded-b', 'encoded-a')), false);
  assert.equal(activeTrackMatchesCurrent(player('encoded-b', 'encoded-b')), true);
});

test('playerStart handler refuses stale/mislabeled Kazagumo start before mutating playback state', () => {
  const music = fs.readFileSync('src/music.js', 'utf8').replace(/\r\n/g, '\n');
  assert.match(music, /import \{ activeTrackMatchesCurrent \} from '\.\/playback-start\.js';/);
  const handler = music.match(/async function handlePlayerStart\(player, track\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const guard = handler.indexOf('if (!activeTrackMatchesCurrent(player))');
  const history = handler.indexOf('stagePlaybackHistory(player, track)');
  assert.ok(guard >= 0, 'playerStart must verify the actual Shoukaku encoded track');
  assert.ok(history >= 0 && guard < history, 'stale start guard must run before history/status/recovery mutation');
});
