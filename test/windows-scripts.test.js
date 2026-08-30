import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const setup = fs.readFileSync('setup.bat', 'utf8');
const start = fs.readFileSync('start-bot.bat', 'utf8');
const stop = fs.readFileSync('stop-bot.bat', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');

test('Windows setup uses native Java Lavalink and verifies the pinned jar', () => {
  assert.match(setup, /22\.14\.0/);
  assert.match(setup, /Java 17 or newer/i);
  assert.match(setup, /Lavalink\/releases\/download\/%LAVALINK_VERSION%\/Lavalink\.jar/i);
  assert.match(setup, /8cb801e591072c3689fafd71ccf571a95a4ead3cc35dfc045e157d763d89119a/i);
  assert.match(setup, /Get-FileHash/i);
  assert.doesNotMatch(setup, /\bwhere\s+docker\b|\bdocker\s+compose\b/i);
});

test('Windows launcher starts standalone Lavalink with bounded heap and waits for authenticated readiness', () => {
  assert.match(start, /Starting native Lavalink/i);
  assert.match(start, /-Xms128M/i);
  assert.match(start, /-Xmx512M/i);
  assert.match(start, /Start-Process -FilePath 'java'/i);
  assert.match(start, /lavalink\.pid/i);
  assert.match(start, /127\.0\.0\.1:2333\/version/i);
  assert.match(start, /Authorization='ezmusic-local-only'/i);
  assert.match(start, /22\.14\.0/);
  assert.doesNotMatch(start, /\bdocker\s+compose\b|\bdocker\s+run\b/i);
});

test('Windows stop script refuses to kill a stale unrelated PID', () => {
  assert.match(stop, /Get-CimInstance Win32_Process/i);
  assert.match(stop, /Lavalink\\\.jar/i);
  assert.match(stop, /refusing to kill/i);
});

test('native Lavalink is bound to localhost only', () => {
  assert.match(lavalink, /address:\s*127\.0\.0\.1/i);
});
