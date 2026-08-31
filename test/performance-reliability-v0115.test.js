import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('SQLite metadata writes use WAL plus NORMAL synchronous mode', () => {
  const source = fs.readFileSync('src/storage.js', 'utf8');
  assert.match(source, /journal_mode = WAL/);
  assert.match(source, /synchronous = NORMAL/);
});

test('syntax check covers configuration and awaited transport control modules', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.check, /src\/config\.js/);
  assert.match(pkg.scripts.check, /src\/player-control\.js/);
});

test('SoundCloud fallback excludes preview-only tracks', () => {
  const config = fs.readFileSync('lavalink/application.yml', 'utf8');
  assert.match(config, /soundcloudFilterOutPreviewTracks:\s*true/);
});

test('Windows graceful shutdown can outlast the 20 second Lavalink REST timeout', () => {
  const stop = fs.readFileSync('stop-bot.bat', 'utf8');
  const music = fs.readFileSync('src/music.js', 'utf8');
  assert.match(stop, /for\(\$i=0;\$i -lt 100;\$i\+\+\)\{Start-Sleep -Milliseconds 250;/);
  assert.match(music, /restTimeout:\s*20_000/);
});
