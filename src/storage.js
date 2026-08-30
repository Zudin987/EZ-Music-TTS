import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const HISTORY_LIMIT_PER_GUILD = 5000;
const HISTORY_PRUNE_EVERY = 100;

fs.mkdirSync('data', { recursive: true });
const db = new Database(path.join('data', 'ez-music.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS favorites (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, uri)
);
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
`);

// Existing installs may already have guild_settings from before persistent
// volume existed. Add the nullable column in place without touching history.
const guildSettingColumns = db.prepare('PRAGMA table_info(guild_settings)').all();
if (!guildSettingColumns.some((column) => column.name === 'volume_percent')) {
  db.exec('ALTER TABLE guild_settings ADD COLUMN volume_percent INTEGER');
}

const historyStmt = db.prepare(`INSERT INTO history
(guild_id,user_id,uri,title,author,duration_ms,played_at) VALUES (?,?,?,?,?,?,?)`);
const recentHistoryStmt = db.prepare('SELECT * FROM history WHERE guild_id=? ORDER BY played_at DESC, id DESC LIMIT ?');
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

let historyWrites = 0;
let closed = false;

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
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  return recentHistoryStmt.all(guildId, safeLimit);
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

export function trackToInfo(track) {
  return {
    uri: track?.uri || track?.realUri || track?.identifier || '',
    title: track?.title || 'Unknown title',
    author: track?.author || '',
    length: Number(track?.length || 0),
  };
}

export function closeStorage() {
  if (closed) return;
  closed = true;
  db.close();
}
