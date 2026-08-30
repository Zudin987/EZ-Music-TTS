import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync('start-bot.bat', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const commands = fs.readFileSync('src/commands.js', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');

test('single-server RAM caps stay lean', () => {
  assert.match(launcher, /-Xms64M/);
  assert.match(launcher, /-Xmx256M/);
  assert.match(launcher, /--max-old-space-size=128/);
  assert.doesNotMatch(launcher, /-Xmx512M/);
});

test('Lavalink allocation/log/playlist controls stay lean without DSP', () => {
  assert.match(lavalink, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(lavalink, /youtubePlaylistLoadLimit:\s*3/);
  assert.match(lavalink, /request:\s*\r?\n\s*enabled:\s*false/);
  assert.match(lavalink, /bufferDurationMs:\s*2000/);
  assert.match(lavalink, /frameBufferDurationMs:\s*20000/);
  for (const filter of ['equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass']) {
    assert.match(lavalink, new RegExp(`${filter}:\\s*false`, 'i'));
  }
});

test('queue growth is bounded in both Lavalink and bot code', () => {
  assert.match(music, /MAX_UPCOMING_QUEUE = 300/);
  assert.match(commands, /MAX_PLAYLIST_ADD = 250/);
  assert.match(commands, /queueTracks\(player, tracks, \{ next, perRequestLimit \}\)/);
});

test('empty-room auto-leave and source circuit breaker are present', () => {
  assert.match(music, /EMPTY_VOICE_GRACE_MS = 120_000/);
  assert.match(music, /SOURCE_FAILURE_THRESHOLD = 3/);
  assert.match(music, /heldQueues = new Map\(\)/);
  assert.match(music, /scheduleSourceRetry/);
  assert.match(music, /playerResolveError/);
  assert.match(music, /voiceStateUpdate/);
});

test('status has memory/source telemetry and private UI is timer-free', () => {
  assert.match(music, /getRuntimeStats/);
  assert.match(commands, /Node RAM:/);
  assert.match(commands, /Lavalink JVM:/);
  assert.match(commands, /Playback source:/);
  assert.match(ui, /Private Queue Manager/);
  assert.match(ui, /music:seekmodal/);
  assert.doesNotMatch(ui, /setInterval\s*\(/);
});
