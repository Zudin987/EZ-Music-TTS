import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const commands = fs.readFileSync('src/commands.js', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');

test('clear is a durable clear: invalidate stale work, disable loop/autoplay, then clear upcoming', () => {
  const helper = commands.match(/function clearUpcomingQueue\([\s\S]*?\r?\n}\r?\n/)?.[0] || '';
  assert.match(helper, /invalidateQueueWork\(guildId\)/);
  assert.match(helper, /player\.setLoop\('none'\)/);
  assert.match(helper, /setGuildAutoplay\(guildId, 'off'\)/);
  assert.match(helper, /player\.queue\.clear\(\)/);
});

test('stop fully resets previous state and stale async queue work', () => {
  const helper = commands.match(/async function stopAndResetPlayer\([\s\S]*?\r?\n}\r?\n/)?.[0] || '';
  assert.match(helper, /invalidateQueueWork\(guildId\)/);
  assert.match(helper, /player\.queue\.clear\(\)/);
  assert.match(helper, /player\.queue\.previous\.splice/);
  assert.match(helper, /player\.queue\.current = null/);
  assert.match(helper, /setPaused\(false\)/);
});

test('async autoplay/radio work is guarded against clear-stop-disconnect races', () => {
  assert.match(music, /queueRevisions = new Map\(\)/);
  assert.match(music, /queueRequestStillValid\(player, revision\)/);
  assert.match(music, /refillAutoplay[\s\S]*getQueueRevision\(player\.guildId\)/);
  assert.match(music, /startServerRadio\(player, requester, revision/);
  assert.match(commands, /assertQueueRequestActive/);
});

test('private panel clarifies upcoming count and includes manual refresh', () => {
  assert.match(ui, /music:refresh/);
  assert.match(ui, /Queue \(\$\{upcoming\}\)/);
  assert.match(ui, /Up next:/i);
});

test('Lavalink stability buffers are larger without enabling DSP', () => {
  assert.match(lavalink, /bufferDurationMs:\s*1000/);
  assert.match(lavalink, /frameBufferDurationMs:\s*10000/);
  for (const filter of ['equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass']) {
    assert.match(lavalink, new RegExp(`${filter}:\\s*false`, 'i'));
  }
});
