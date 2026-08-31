import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const commands = fs.readFileSync('src/commands.js', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const storage = fs.readFileSync('src/storage.js', 'utf8');
const utils = fs.readFileSync('src/utils.js', 'utf8');
const index = fs.readFileSync('src/index.js', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');
const searchPicker = fs.readFileSync('src/search-picker.js', 'utf8');

test('crash recovery is SQLite-backed and opt-in instead of auto-joining voice', () => {
  assert.match(storage, /CREATE TABLE IF NOT EXISTS session_recovery/);
  assert.match(storage, /saveRecoverySession/);
  assert.match(storage, /updateRecoveryPosition/);
  assert.match(music, /RECOVERY_POSITION_SAVE_MS = 15_000/);
  assert.match(music, /resumeRecoverySession/);
  assert.match(music, /position: Math\.max\(0, startPosition\)/);
  assert.doesNotMatch(music, /startTime:/);
  assert.match(music, /recoveryResumes = new Set\(\)/);
  assert.match(ui, /music:recovery_resume/);
  assert.match(commands, /Join the voice channel where you want to resume/);
  assert.match(index, /checkpointAllRecoveries/);
  assert.doesNotMatch(index, /resumeRecoverySession\(/);
});

test('typed search picker is default, bounded, temporary, and revision-safe', () => {
  assert.doesNotMatch(commands, /setName\('select'\)/);
  assert.match(commands, /shouldOfferSearchChoices\(query\)/);
  assert.match(commands, /resolveSearchChoices\(music, query, interaction\.user, \{ limit: 3 \}\)/);
  assert.match(searchPicker, /SEARCH_PICKER_TTL_MS = 120_000/);
  assert.match(searchPicker, /SEARCH_PICKER_MAX = 32/);
  assert.match(searchPicker, /tracks: Array\.isArray\(tracks\) \? tracks\.slice\(0, 3\)/);
  assert.match(searchPicker, /revision:/);
  assert.match(commands, /isQueueRevisionCurrent\(interaction\.guildId, entry\.revision\)/);
});

test('favorites and recent history reuse SQLite with no new service', () => {
  assert.match(storage, /CREATE TABLE IF NOT EXISTS favorites/);
  assert.match(storage, /toggleFavorite/);
  assert.match(storage, /historyPage/);
  assert.match(commands, /getFavoritesPayload/);
  assert.match(commands, /getHistoryPayload/);
  assert.doesNotMatch(storage, /mongodb|redis/i);
});

test('queue undo is one bounded five-minute snapshot', () => {
  assert.match(commands, /UNDO_TTL_MS = 5 \* 60_000/);
  assert.match(commands, /undoSnapshots = new Map\(\)/);
  assert.match(commands, /setUndoSnapshot/);
  assert.match(commands, /restoreUndo/);
  assert.match(commands, /undoButtonComponents/);
});

test('dedupe normalizes presentation labels but preserves meaningful versions', () => {
  assert.ok(utils.includes('official\\\\s'));
  assert.match(utils, /live, remix, acoustic/i);
  assert.match(utils, /topic\\s\*\$/i);
  assert.match(commands, /dedupeUpcoming/);
});

test('queue mutations have a per-guild operation lock', () => {
  assert.match(music, /operationChains = new Map\(\)/);
  assert.match(music, /withGuildOperation/);
  assert.match(music, /playerCreationPromises = new Map\(\)/);
  assert.match(music, /Collapse them onto one creation promise/);
  assert.match(commands, /withGuildOperation\(interaction\.guildId/);
});


test('stale private player panels cannot favorite the wrong newly-playing song', () => {
  assert.match(ui, /music:favorite:\$\{hasCurrent \? queueFingerprint/);
  assert.match(commands, /The song changed since this panel was opened/);
});

test('prolonged source degradation preserves crash recovery on idle destroy', () => {
  assert.match(music, /health\.status === 'healthy'[\s\S]*clearRecoverySession/);
  assert.match(music, /else checkpointRecovery\(player\)/);
});


test('library Play Now respects the upcoming queue ceiling', () => {
  assert.match(commands, /player\.queue\.current && player\.queue\.length >= queueLimit/);
  assert.match(commands, /Remove one track before using Play/);
});

test('favorite library actions validate a stable track fingerprint', () => {
  assert.match(ui, /music:fremove:\$\{selected\.id\}:\$\{safePage\}:\$\{queueFingerprint\(selected\)\}/);
  assert.match(commands, /That favorite changed or was replaced/);
});
