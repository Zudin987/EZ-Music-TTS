import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const commands = fs.readFileSync(path.join(repoRoot, 'src/commands.js'), 'utf8');
const music = fs.readFileSync(path.join(repoRoot, 'src/music.js'), 'utf8');

test('volume is persisted independently from autoplay settings', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-music-volume-'));
  const storageUrl = `${pathToFileURL(path.join(repoRoot, 'src/storage.js')).href}?volume-test=${Date.now()}`;
  process.chdir(temp);
  try {
    const storage = await import(storageUrl);
    assert.equal(storage.getGuildVolume('guild-a', 73), 73);
    assert.equal(storage.setGuildVolume('guild-a', 42), 42);
    assert.equal(storage.getGuildVolume('guild-a', 73), 42);
    storage.setAutoplayMode('guild-a', 'standard');
    assert.equal(storage.getGuildVolume('guild-a', 73), 42);
    storage.setGuildVolume('guild-a', 61);
    assert.equal(storage.getAutoplayMode('guild-a'), 'standard');
    storage.closeStorage();
  } finally {
    process.chdir(repoRoot);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('volume command works without creating a player and status reports saved volume', () => {
  assert.match(commands, /if \(name === 'volume'\)[\s\S]*music\.players\.get\(interaction\.guildId\)[\s\S]*setGuildVolume\(interaction\.guildId, n\)/);
  assert.match(commands, /Saved volume: \*\*\$\{volume\}%\*\*/);
  assert.match(music, /volume: getStoredVolume\(interaction\.guildId, config\.defaultVolume\)/);
});

test('volume buttons also update the persistent setting', () => {
  assert.match(commands, /volume_down[\s\S]*setGuildVolume\(interaction\.guildId, nextVolume\)/);
  assert.match(commands, /volume_up[\s\S]*setGuildVolume\(interaction\.guildId, nextVolume\)/);
});
