import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const commands = fs.readFileSync('src/commands.js', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const index = fs.readFileSync('src/index.js', 'utf8');

test('all Discord command responses use private interaction flags', () => {
  assert.match(commands, /MessageFlags\.Ephemeral/);
  assert.doesNotMatch(commands, /\bephemeral\s*:/i);
  assert.doesNotMatch(commands, /deferReply\(\s*\)/);
  assert.doesNotMatch(commands, /interaction\.reply\(\s*['"`]/);
});

test('music core never sends a public player panel to a text channel', () => {
  assert.doesNotMatch(music, /channel\.send\s*\(/i);
  assert.doesNotMatch(music, /panelMessages/i);
  assert.doesNotMatch(music, /SuppressNotifications/i);
});

test('discord.js ready event uses the v15-safe ClientReady name', () => {
  assert.match(index, /Events\.ClientReady/);
  assert.doesNotMatch(index, /once\(['"]ready['"]/);
});
