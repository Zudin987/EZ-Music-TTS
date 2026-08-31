import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { botVoiceChannelTransition, voiceCloseDisposition } from '../src/lavalink-lifecycle.js';

const bot = 'bot-user';
const state = (id, channelId) => ({ id, channelId });

test('bot voice move and join transitions keep the destination channel', () => {
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, 'B')),
    { type: 'moved', oldChannelId: 'A', channelId: 'B' },
  );
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, null), state(bot, 'B')),
    { type: 'joined', oldChannelId: null, channelId: 'B' },
  );
});

test('bot voice leave is distinguishable from unrelated member changes', () => {
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, null)),
    { type: 'left', oldChannelId: 'A', channelId: null },
  );
  assert.equal(botVoiceChannelTransition(bot, state('human', 'A'), state('human', 'B')), null);
  assert.equal(botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, 'A')), null);
});

test('voice close policy follows Koe and Discord fresh-session behavior', () => {
  for (const code of [4006, 4014, 4022]) assert.equal(voiceCloseDisposition(code), 'refresh');
  for (const code of [4009, 4015, 1006, 4000]) assert.equal(voiceCloseDisposition(code), 'watch');
  for (const code of [4017, 4021]) assert.equal(voiceCloseDisposition(code), 'retire');
});

test('v0.1.15 wires bot move synchronization and SoundCloud preview filtering', () => {
  const music = fs.readFileSync('src/music.js', 'utf8');
  const app = fs.readFileSync('lavalink/application.yml', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(music, /botVoiceChannelTransition\(client\.user\?\.id/);
  assert.match(music, /syncPlayerVoiceChannel\(player, botTransition\.channelId\)/);
  assert.match(music, /scheduleVoiceTransportWatchdog/);
  assert.match(music, /player\.setVoiceChannel\(actualChannelId\)/);
  assert.match(music, /currentBotVoiceChannelId/);
  assert.match(app, /soundcloudFilterOutPreviewTracks:\s*true/);
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.equal(pkg.version, '0.1.15');
});
