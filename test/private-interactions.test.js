import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const commands = fs.readFileSync('src/commands.js', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const index = fs.readFileSync('src/index.js', 'utf8');

test('only /nowplaying is public and it uses Discord silent notifications', () => {
  assert.match(commands, /const PRIVATE_FLAGS = MessageFlags\.Ephemeral/);
  assert.match(commands, /const PUBLIC_NOWPLAYING_FLAGS = MessageFlags\.SuppressNotifications/);
  assert.match(commands, /await publicNowPlayingReply\(interaction, panelPayload\(player, interaction\.guildId\)\)/);
  assert.doesNotMatch(commands, /\bephemeral\s*:/i);
  assert.doesNotMatch(commands, /deferReply\(\s*\)/);
  assert.doesNotMatch(commands, /interaction\.reply\(\s*['"`]/);
});

test('public Now Playing keeps detailed Queue/More and personal favorite feedback private', () => {
  assert.match(commands, /if \(publicSource\) return privateReply\(interaction, null, queuePayload/);
  assert.match(commands, /if \(publicSource\) return privateReply\(interaction, null, playbackToolsPayload/);
  assert.match(commands, /if \(publicSource\) return privateReply\(interaction, `\$\{added/);
});

test('music core never sends a public player panel directly to a text channel', () => {
  assert.doesNotMatch(music, /channel\.send\s*\(/i);
  assert.doesNotMatch(music, /panelMessages/i);
});

test('discord.js ready event uses the v15-safe ClientReady name', () => {
  assert.match(index, /Events\.ClientReady/);
  assert.doesNotMatch(index, /once\(['"]ready['"]/);
});
