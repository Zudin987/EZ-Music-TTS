import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();

async function withStorage(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-music-library-'));
  const storageUrl = `${pathToFileURL(path.join(repoRoot, 'src/storage.js')).href}?library-test=${Date.now()}-${Math.random()}`;
  process.chdir(temp);
  try {
    const storage = await import(storageUrl);
    await run(storage);
    storage.closeStorage();
  } finally {
    process.chdir(repoRoot);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('favorites are personal and history is paged', async () => {
  await withStorage(async (storage) => {
    const track = { uri: 'https://example.test/song', title: 'Song', author: 'Artist', length: 123_000 };
    storage.addHistory('guild', 'user-a', track);
    storage.addHistory('guild', 'user-b', { ...track, uri: 'https://example.test/song2', title: 'Song 2' });
    assert.equal(storage.countHistory('guild'), 2);
    assert.equal(storage.historyPage('guild', 1, 0).length, 1);

    storage.addFavorite('guild', 'user-a', track);
    assert.equal(storage.countFavorites('guild', 'user-a'), 1);
    assert.equal(storage.countFavorites('guild', 'user-b'), 0);
    const favorite = storage.listFavorites('guild', 'user-a', 20, 0)[0];
    assert.equal(favorite.duration_ms, 123_000);
    assert.equal(storage.getFavoriteById('guild', 'user-a', favorite.id).title, 'Song');
    assert.equal(storage.removeFavorite('guild', 'user-a', favorite.uri), true);
    assert.equal(storage.countFavorites('guild', 'user-a'), 0);
  });
});

test('recovery snapshot round-trips and position updates without rewriting the queue', async () => {
  await withStorage(async (storage) => {
    storage.saveRecoverySession('guild', {
      voiceId: 'voice',
      textId: 'text',
      current: { uri: 'https://example.test/current', title: 'Current', author: 'Artist', length: 200_000 },
      queue: [{ uri: 'https://example.test/next', title: 'Next', author: 'Artist', length: 180_000 }],
      positionMs: 12_000,
      volumePercent: 37,
      loopMode: 'queue',
      autoplayMode: 'standard',
      paused: true,
    });
    let session = storage.getRecoverySession('guild');
    assert.equal(session.voiceId, 'voice');
    assert.equal(session.positionMs, 12_000);
    assert.equal(session.queue.length, 1);
    assert.equal(session.volumePercent, 37);
    assert.equal(session.loopMode, 'queue');
    assert.equal(session.autoplayMode, 'standard');
    assert.equal(session.paused, true);

    storage.updateRecoveryPosition('guild', 33_000, false);
    session = storage.getRecoverySession('guild');
    assert.equal(session.positionMs, 33_000);
    assert.equal(session.paused, false);
    assert.equal(session.queue[0].title, 'Next');
    assert.equal(storage.deleteRecoverySession('guild'), true);
    assert.equal(storage.getRecoverySession('guild'), null);
  });
});
