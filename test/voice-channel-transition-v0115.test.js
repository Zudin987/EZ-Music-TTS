import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { voiceChannelTransition } from '../src/lavalink-lifecycle.js';

test('Discord bot voice channel transitions classify move and disconnect', () => {
  assert.deepEqual(voiceChannelTransition('A', 'B'), { kind: 'moved', from: 'A', to: 'B' });
  assert.deepEqual(voiceChannelTransition('A', null), { kind: 'left', from: 'A', to: null });
  assert.deepEqual(voiceChannelTransition(null, 'B'), { kind: 'joined', from: null, to: 'B' });
  assert.deepEqual(voiceChannelTransition('A', 'A'), { kind: 'none', from: 'A', to: 'A' });
});

test('EZ syncs Kazagumo voiceId when Discord moves the bot and retires on external disconnect', () => {
  const music = fs.readFileSync('src/music.js', 'utf8').replace(/\r\n/g, '\n');
  assert.match(music, /voiceChannelTransition/);
  assert.match(music, /oldState\.id === client\.user\?\.id/);
  assert.match(music, /player\.voiceId = botTransition\.to/);
  assert.match(music, /voiceIds\.set\(guildId, botTransition\.to\)/);
  assert.match(music, /botTransition\.kind === 'left'/);
  assert.match(music, /retirePlayerForTransportLoss\(player, 'Discord moved bot out of voice'/);
  assert.doesNotMatch(music, /botTransition[\s\S]{0,700}setVoiceChannel\(/);
});
