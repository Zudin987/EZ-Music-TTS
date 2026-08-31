import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setPlayerPaused, stopPlayerTrack } from '../src/player-control.js';

function fakePlayer() {
  return {
    paused: false,
    playing: true,
    shoukaku: {
      paused: false,
      async setPaused(value) { this.paused = value; },
      async stopTrack() { this.track = null; },
      track: 'encoded-a',
    },
  };
}

test('awaited pause publishes Kazagumo wrapper state only after transport success', async () => {
  const player = fakePlayer();
  await setPlayerPaused(player, true);
  assert.equal(player.shoukaku.paused, true);
  assert.equal(player.paused, true);
  assert.equal(player.playing, false);
});

test('pause REST rejection propagates without lying in wrapper state', async () => {
  const player = fakePlayer();
  player.shoukaku.setPaused = async () => { throw new Error('REST unavailable'); };
  await assert.rejects(() => setPlayerPaused(player, true), /REST unavailable/);
  assert.equal(player.paused, false);
  assert.equal(player.playing, true);
});

test('stop-track REST rejection is observable by the caller', async () => {
  const player = fakePlayer();
  player.shoukaku.stopTrack = async () => { throw new Error('node restarting'); };
  await assert.rejects(() => stopPlayerTrack(player), /node restarting/);
});

test('EZ runtime no longer calls Kazagumo fire-and-forget pause/skip wrappers', () => {
  const music = fs.readFileSync('src/music.js', 'utf8');
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  assert.doesNotMatch(music, /\bplayer\.pause\(/);
  assert.doesNotMatch(music, /\bplayer\.skip\(\)/);
  assert.doesNotMatch(commands, /\bplayer\.pause\(/);
  assert.doesNotMatch(commands, /\bplayer\.skip\(\)/);
  assert.match(music, /setPlayerPaused/);
  assert.match(music, /stopPlayerTrack/);
  assert.match(commands, /setPlayerPaused/);
  assert.match(commands, /stopPlayerTrack/);
});
