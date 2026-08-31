import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('status distinguishes credential-free Spotify tracks from credential-gated albums/playlists', () => {
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  assert.doesNotMatch(commands, /Spotify URL mirror:/);
  assert.match(commands, /Spotify: \*\*Tracks: oEmbed fallback/);
  assert.match(commands, /Albums\/playlists:/);
});
