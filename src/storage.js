import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const HISTORY_LIMIT_PER_GUILD = 5000;
const HISTORY_PRUNE_EVERY = 100;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync('data', { recursive: true });
const db = new Database(path.join('data', 'ez-music.sqlite'));
db.pragma('journal_mode = WAL');
// WAL + NORMAL keeps metadata writes fast while preserving database integrity.
// A sudden power loss may lose the newest transaction, which is acceptable for
// disposable history/recovery metadata and avoids FULL-mode fsync overhead.
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS favorites (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, uri)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user_created ON favorites(guild_id, user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_guild_played ON history(guild_id, played_at DESC);
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  autoplay_mode TEXT NOT NULL DEFAULT 'off',
  volume_percent INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_recovery (
  guild_id TEXT PRIMARY KEY,
  voice_id TEXT NOT NULL DEFAULT '',
  text_id TEXT NOT NULL DEFAULT '',
  current_json TEXT,
  queue_json TEXT NOT NULL DEFAULT '[]',
  position_ms INTEGER NOT NULL DEFAULT 0,
  volume_percent INTEGER NOT NULL DEFAULT 80,
  loop_mode TEXT NOT NULL DEFAULT 'none',
  autoplay_mode TEXT NOT NULL DEFAULT 'off',
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);

// Existing installs may already have guild_settings from before persistent
// volume existed. Add the nullable column in place without touching history.
const guildSettingColumns = db.prepare('PRAGMA table_info(guild_settings)').all();
if (!guildSettingColumns.some((column) => column.name === 'volume_percent')) {
  db.exec('ALTER TABLE guild_settings ADD COLUMN volume_percent INTEGER');
}

const favoriteColumns = db.prepare('PRAGMA table_info(favorites)').all();
if (!favoriteColumns.some((column) => column.name === 'duration_ms')) {
  db.exec('ALTER TABLE favorites ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0');
}

const historyStmt = db.prepare(`INSERT INTO history
(guild_id,user_id,uri,title,author,duration_ms,played_at) VALUES (?,?,?,?,?,?,?)`);
const recentHistoryStmt = db.prepare('SELECT * FROM history WHERE guild_id=? ORDER BY played_at DESC, id DESC LIMIT ?');
const historyPageStmt = db.prepare('SELECT * FROM history WHERE guild_id=? ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?');
const historyCountStmt = db.prepare('SELECT COUNT(*) AS count FROM history WHERE guild_id=?');
const historyByIdStmt = db.prepare('SELECT * FROM history WHERE guild_id=? AND id=? LIMIT 1');
const pruneHistoryStmt = db.prepare(`DELETE FROM history
WHERE guild_id=? AND id NOT IN (
  SELECT id FROM history WHERE guild_id=? ORDER BY played_at DESC, id DESC LIMIT ?
)`);
const getSettingsStmt = db.prepare('SELECT autoplay_mode, volume_percent FROM guild_settings WHERE guild_id=?');
const setAutoplayStmt = db.prepare(`INSERT INTO guild_settings (guild_id, autoplay_mode, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(guild_id) DO UPDATE SET autoplay_mode=excluded.autoplay_mode, updated_at=excluded.updated_at`);
const setVolumeStmt = db.prepare(`INSERT INTO guild_settings (guild_id, volume_percent, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(guild_id) DO UPDATE SET volume_percent=excluded.volume_percent, updated_at=excluded.updated_at`);

const favoriteInsertStmt = db.prepare(`INSERT OR IGNORE INTO favorites
(guild_id,user_id,uri,title,author,duration_ms,created_at) VALUES (?,?,?,?,?,?,?)`);
const favoriteUpdateStmt = db.prepare(`UPDATE favorites SET title=?, author=?, duration_ms=?, created_at=?
WHERE guild_id=? AND user_id=? AND uri=?`);
const favoriteDeleteStmt = db.prepare('DELETE FROM favorites WHERE guild_id=? AND user_id=? AND uri=?');
const favoriteExistsStmt = db.prepare('SELECT 1 AS found FROM favorites WHERE guild_id=? AND user_id=? AND uri=? LIMIT 1');
const favoritePageStmt = db.prepare(`SELECT rowid AS id, guild_id, user_id, uri, title, author, duration_ms, created_at
FROM favorites WHERE guild_id=? AND user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`);
const favoriteCountStmt = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE guild_id=? AND user_id=?');
const favoriteByIdStmt = db.prepare(`SELECT rowid AS id, guild_id, user_id, uri, title, author, duration_ms, created_at
FROM favorites WHERE guild_id=? AND user_id=? AND rowid=? LIMIT 1`);

const recoveryUpsertStmt = db.prepare(`INSERT INTO session_recovery
(guild_id,voice_id,text_id,current_json,queue_json,position_ms,volume_percent,loop_mode,autoplay_mode,paused,updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(guild_id) DO UPDATE SET
  voice_id=excluded.voice_id,
  text_id=excluded.text_id,
  current_json=excluded.current_json,
  queue_json=excluded.queue_json,
  position_ms=excluded.position_ms,
  volume_percent=excluded.volume_percent,
  loop_mode=excluded.loop_mode,
  autoplay_mode=excluded.autoplay_mode,
  paused=excluded.paused,
  updated_at=excluded.updated_at`);
const recoveryPositionStmt = db.prepare(`UPDATE session_recovery
SET position_ms=?, paused=?, updated_at=? WHERE guild_id=?`);
const recoveryGetStmt = db.prepare('SELECT * FROM session_recovery WHERE guild_id=? LIMIT 1');
const recoveryDeleteStmt = db.prepare('DELETE FROM session_recovery WHERE guild_id=?');

let historyWrites = 0;
let closed = false;

function clampInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function favoriteUri(track) {
  const info = trackToInfo(track);
  if (info.uri) return info.uri;
  const author = String(info.author || '').trim().toLocaleLowerCase();
  const title = String(info.title || '').trim().toLocaleLowerCase();
  return `meta:${encodeURIComponent(`${author}\u0000${title}`)}`;
}

export function addHistory(guildId, userId, track) {
  const info = trackToInfo(track);
  historyStmt.run(guildId, userId || 'unknown', info.uri, info.title, info.author, info.length, Date.now());
  historyWrites += 1;
  if (historyWrites >= HISTORY_PRUNE_EVERY) {
    pruneHistoryStmt.run(guildId, guildId, HISTORY_LIMIT_PER_GUILD);
    historyWrites = 0;
  }
}

export function recentHistory(guildId, limit = 20) {
  const safeLimit = clampInt(limit, 1, 100, 20);
  return recentHistoryStmt.all(guildId, safeLimit);
}

export function historyPage(guildId, limit = 20, offset = 0) {
  return historyPageStmt.all(guildId, clampInt(limit, 1, 25, 20), clampInt(offset, 0, HISTORY_LIMIT_PER_GUILD, 0));
}

export function countHistory(guildId) {
  return Number(historyCountStmt.get(guildId)?.count || 0);
}

export function getHistoryById(guildId, id) {
  const safeId = Number.parseInt(id, 10);
  if (!Number.isInteger(safeId) || safeId < 1) return null;
  return historyByIdStmt.get(guildId, safeId) || null;
}

export function getAutoplayMode(guildId) {
  const mode = getSettingsStmt.get(guildId)?.autoplay_mode;
  return mode === 'standard' || mode === 'ai' ? mode : 'off';
}

export function setAutoplayMode(guildId, mode) {
  if (!['off', 'standard', 'ai'].includes(mode)) throw new Error(`Invalid autoplay mode: ${mode}`);
  setAutoplayStmt.run(guildId, mode, Date.now());
  return mode;
}

export function getGuildVolume(guildId, fallback = 80) {
  const stored = getSettingsStmt.get(guildId)?.volume_percent;
  if (Number.isInteger(stored) && stored >= 0 && stored <= 100) return stored;
  const safeFallback = Number.parseInt(fallback, 10);
  return Number.isFinite(safeFallback) ? Math.max(0, Math.min(100, safeFallback)) : 80;
}

export function setGuildVolume(guildId, volume) {
  const value = Number(volume);
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`Invalid volume: ${volume}`);
  setVolumeStmt.run(guildId, value, Date.now());
  return value;
}

export function isFavorite(guildId, userId, track) {
  return Boolean(favoriteExistsStmt.get(guildId, userId, favoriteUri(track)));
}

export function addFavorite(guildId, userId, track) {
  const info = trackToInfo(track);
  const uri = favoriteUri(track);
  const now = Date.now();
  const result = favoriteInsertStmt.run(guildId, userId, uri, info.title, info.author, info.length, now);
  if (!result.changes) favoriteUpdateStmt.run(info.title, info.author, info.length, now, guildId, userId, uri);
  return true;
}

export function removeFavorite(guildId, userId, trackOrUri) {
  const uri = typeof trackOrUri === 'string' ? trackOrUri : favoriteUri(trackOrUri);
  return favoriteDeleteStmt.run(guildId, userId, uri).changes > 0;
}

export function toggleFavorite(guildId, userId, track) {
  if (isFavorite(guildId, userId, track)) {
    removeFavorite(guildId, userId, track);
    return false;
  }
  addFavorite(guildId, userId, track);
  return true;
}

export function listFavorites(guildId, userId, limit = 20, offset = 0) {
  return favoritePageStmt.all(guildId, userId, clampInt(limit, 1, 25, 20), Math.max(0, Number.parseInt(offset, 10) || 0));
}

export function countFavorites(guildId, userId) {
  return Number(favoriteCountStmt.get(guildId, userId)?.count || 0);
}

export function getFavoriteById(guildId, userId, id) {
  const safeId = Number.parseInt(id, 10);
  if (!Number.isInteger(safeId) || safeId < 1) return null;
  return favoriteByIdStmt.get(guildId, userId, safeId) || null;
}

export function saveRecoverySession(guildId, snapshot) {
  const current = snapshot?.current ? trackToRecovery(snapshot.current) : null;
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue.slice(0, 300).map(trackToRecovery).filter(Boolean) : [];
  if (!current && !queue.length) {
    recoveryDeleteStmt.run(guildId);
    return false;
  }
  const loop = ['none', 'track', 'queue'].includes(snapshot?.loopMode) ? snapshot.loopMode : 'none';
  const autoplay = ['off', 'standard', 'ai'].includes(snapshot?.autoplayMode) ? snapshot.autoplayMode : 'off';
  recoveryUpsertStmt.run(
    guildId,
    String(snapshot?.voiceId || ''),
    String(snapshot?.textId || ''),
    current ? JSON.stringify(current) : null,
    JSON.stringify(queue),
    Math.max(0, Math.round(Number(snapshot?.positionMs || 0))),
    clampInt(snapshot?.volumePercent, 0, 100, 80),
    loop,
    autoplay,
    snapshot?.paused ? 1 : 0,
    Date.now(),
  );
  return true;
}

export function updateRecoveryPosition(guildId, positionMs, paused = false) {
  recoveryPositionStmt.run(Math.max(0, Math.round(Number(positionMs || 0))), paused ? 1 : 0, Date.now(), guildId);
}

export function getRecoverySession(guildId, maxAgeMs = RECOVERY_MAX_AGE_MS) {
  const row = recoveryGetStmt.get(guildId);
  if (!row) return null;
  const age = Date.now() - Number(row.updated_at || 0);
  if (age < 0 || age > Math.max(60_000, Number(maxAgeMs || RECOVERY_MAX_AGE_MS))) {
    recoveryDeleteStmt.run(guildId);
    return null;
  }
  const current = row.current_json ? safeJsonParse(row.current_json, null) : null;
  const queue = safeJsonParse(row.queue_json, []);
  if (!current && !Array.isArray(queue)) {
    recoveryDeleteStmt.run(guildId);
    return null;
  }
  if (!current && !queue.length) {
    recoveryDeleteStmt.run(guildId);
    return null;
  }
  return {
    guildId: row.guild_id,
    voiceId: row.voice_id,
    textId: row.text_id,
    current,
    queue: Array.isArray(queue) ? queue.slice(0, 300) : [],
    positionMs: Math.max(0, Number(row.position_ms || 0)),
    volumePercent: clampInt(row.volume_percent, 0, 100, 80),
    loopMode: ['none', 'track', 'queue'].includes(row.loop_mode) ? row.loop_mode : 'none',
    autoplayMode: ['off', 'standard', 'ai'].includes(row.autoplay_mode) ? row.autoplay_mode : 'off',
    paused: Boolean(row.paused),
    updatedAt: Number(row.updated_at || 0),
  };
}

export function deleteRecoverySession(guildId) {
  return recoveryDeleteStmt.run(guildId).changes > 0;
}

export function trackToInfo(track) {
  return {
    uri: track?.uri || track?.realUri || track?.identifier || '',
    title: track?.title || 'Unknown title',
    author: track?.author || '',
    length: Number(track?.length || track?.duration_ms || 0),
  };
}

export function trackToRecovery(track) {
  if (!track) return null;
  const info = trackToInfo(track);
  return {
    uri: info.uri,
    title: info.title,
    author: info.author,
    length: info.length,
    identifier: String(track?.identifier || ''),
  };
}

export function closeStorage() {
  if (closed) return;
  closed = true;
  db.close();
}
