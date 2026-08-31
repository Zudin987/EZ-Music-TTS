import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  playbackFallbackQueries,
  restoreFallbackQueue,
  takeFallbackQueueHold,
} from '../src/playback-fallback.js';
import { playbackHistoryFingerprint, playbackHistoryReady } from '../src/playback-history.js';

function queueFixture(current, upcoming = []) {
  const queue = [...upcoming];
  queue.current = current;
  queue.clear = function clear() { this.splice(0, this.length); };
  queue.add = function add(tracks) {
    const copy = [...tracks];
    if (!this.current) this.current = copy.shift() || null;
    this.push(...copy);
  };
  return queue;
}

test('New Genesis upload noise reduces to a strong Ado SoundCloud query', () => {
  const first = playbackFallbackQueries({
    title: 'ADO - NEW GENESIS (One Piece Film Red OST) Lyrics | Lirik & Terjemahan',
    author: 'Ado',
  });
  assert.equal(first[0].toLowerCase(), 'ado new genesis');

  const second = playbackFallbackQueries({
    title: 'New Genesis by Ado × Yasutaka Nakata from ONE PIECE FILM RED',
    author: 'Ado',
  });
  assert.equal(second[0].toLowerCase(), 'ado new genesis');
  assert.ok(second.length <= 3);
});

test('fallback queue hold removes upcoming work before Kazagumo can auto-advance', () => {
  const current = { title: 'failed' };
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(current, [a, b]);
  const held = takeFallbackQueueHold(queue);
  assert.deepEqual(held, [a, b]);
  assert.equal(queue.current, current);
  assert.equal(queue.length, 0);
});

test('held queue restores in order behind a successful fallback', () => {
  const fallback = { title: 'SoundCloud fallback' };
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(fallback, []);
  assert.equal(restoreFallbackQueue(queue, [a, b]), 2);
  assert.equal(queue.current, fallback);
  assert.deepEqual([...queue], [a, b]);
});

test('held queue promotes first item when failed current has already ended', () => {
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(null, []);
  restoreFallbackQueue(queue, [a, b]);
  assert.equal(queue.current, a);
  assert.deepEqual([...queue], [b]);
});

test('history waits for real playback progress and ignores executor-only starts', () => {
  const track = { sourceName: 'youtube', identifier: 'abcdefghijk', uri: 'https://youtube.test/watch?v=abcdefghijk', title: 'Song' };
  const pending = { fingerprint: playbackHistoryFingerprint(track) };
  assert.equal(playbackHistoryReady(pending, track, 0, false), false);
  assert.equal(playbackHistoryReady(pending, track, 1_999, false), false);
  assert.equal(playbackHistoryReady(pending, track, 2_000, false), true);
  assert.equal(playbackHistoryReady(pending, track, 5_000, true), false);
  assert.equal(playbackHistoryReady(pending, { ...track, identifier: 'different-id' }, 5_000, false), false);
});

test('music core holds queue before async fallback, suppresses transient empty, and defers history', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const handler = music.split("music.on('playerException'")[1]?.split("music.on('playerResolveError'")[0] || '';
  assert.match(handler, /beginPlaybackFallbackHold\(player, failedTrack\)/);
  assert.ok(handler.indexOf('beginPlaybackFallbackHold(player, failedTrack)') < handler.indexOf('void (async () =>'));
  assert.match(music, /if \(playbackFallbackHolds\.has\(player\.guildId\)\) \{\n\s+settlePlaybackFallbackHold\(player\)/);
  assert.match(music, /stagePlaybackHistory\(player, track\)/);
  assert.doesNotMatch(music.split('async function handlePlayerStart')[1]?.split('async function handlePlayerEmpty')[0] || '', /addHistory\(/);
  assert.match(music, /commitPendingPlaybackHistory\(player\);/);
});

test('queue additions stay held during fallback and manual skip cancels the pending fallback', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(music, /if \(playbackFallbackHolds\.has\(player\.guildId\)\)/);
  assert.match(music, /cancelPlaybackFallbackForSkip/);
  assert.match(commands, /await cancelPlaybackFallbackForSkip\(player\)/);
});

test('v0.1.14 preserves buffers, heap caps, DSP and YouTube client chain', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.equal(pkg.version, '0.1.15');
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(app, /equalizer:\s*false/i);
  assert.match(app, /timescale:\s*false/i);
  const section = app.split('  youtube:\n')[1] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(clients.slice(0, 4), ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']);
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});


test('fallback status takes priority over an older failure counter and success clears retry fingerprint', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const health = music.split('function getSourceHealth(guildId)')[1]?.split('function setHealthy')[0] || '';
  assert.ok(health.indexOf('playbackFallbackHolds.has(guildId)') < health.indexOf("if (!state) return"));
  const youtubeFallback = music.split('async function tryYoutubePlaybackFallback')[1]?.split('async function trySoundCloudPlaybackFallback')[0] || '';
  const soundcloudFallback = music.split('async function trySoundCloudPlaybackFallback')[1]?.split('async function finishPlaybackFallbackFailure')[0] || '';
  assert.match(youtubeFallback, /releasePlaybackFallbackHold[\s\S]*playbackFallbackAttempts\.delete\(guildId\)/);
  assert.match(soundcloudFallback, /releasePlaybackFallbackHold[\s\S]*playbackFallbackAttempts\.delete\(guildId\)/);
});
