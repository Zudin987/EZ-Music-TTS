import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventTrackMatches, nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceCloseDisposition } from '../src/lavalink-lifecycle.js';

test('node reconnect backoff is bounded and becomes 30s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(nodeReconnectDelayMs), [2000, 5000, 10000, 15000, 30000, 30000]);
});

test('Discord voice close policy distinguishes fresh-session, transient, and hard-stop cases', () => {
  for (const code of [4006, 4014, 4022]) assert.equal(voiceCloseDisposition(code), 'refresh');
  for (const code of [4009, 4015, 1006]) assert.equal(voiceCloseDisposition(code), 'watch');
  for (const code of [4017, 4021]) assert.equal(voiceCloseDisposition(code), 'retire');
});

test('event identity prefers exact encoded Lavalink track', () => {
  const current = { track: 'encoded-new', identifier: 'same-id', sourceName: 'youtube', uri: 'https://x/new' };
  const event = { encoded: 'encoded-old', info: { identifier: 'same-id', sourceName: 'youtube', uri: 'https://x/new' } };
  assert.equal(eventTrackMatches(event, current), false);
});

test('late event from previous song never resolves against a newer current song', () => {
  const current = { track: 'new64', identifier: 'new', sourceName: 'youtube' };
  const previous = { track: 'old64', identifier: 'old', sourceName: 'youtube' };
  const event = { encoded: 'old64', info: { identifier: 'old', sourceName: 'youtube' } };
  assert.equal(resolveLifecycleEventTrack(event, current, previous), null);
  assert.equal(resolveLifecycleEventTrack(event, null, previous), previous);
});

test('missing event track keeps Shoukaku 4.3.0 compatibility fallback', () => {
  const current = { track: 'new64' };
  const previous = { track: 'old64' };
  assert.equal(resolveLifecycleEventTrack(null, current, previous), current);
});

test('v0.1.14 source wires node, voice close, and stale-event protections', () => {
  const music = fs.readFileSync('src/music.js', 'utf8');
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(music, /reconnectTries:\s*1/);
  assert.match(music, /reconnectInterval:\s*2/);
  assert.match(music, /Constants\.State\.CONNECTED/);
  assert.match(music, /scheduleLocalNodeReplacement/);
  assert.match(music, /leaveVoiceChannel\(guildId\)/);
  assert.match(music, /music\.on\('playerClosed'/);
  assert.match(music, /resolveLifecycleEventTrack\(data\?\.track/);
  assert.match(music, /getLavalinkNodeHealth/);
  assert.match(commands, /getLavalinkNodeHealth/);
  assert.equal(pkg.version, '0.1.15');
});
