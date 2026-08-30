import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

fs.mkdirSync('data', { recursive: true });
const db = new Database(path.join('data', 'ez-music.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
`);

const addFavoriteStmt = db.prepare(`INSERT OR IGNORE INTO favorites
(guild_id,user_id,uri,title,author,created_at) VALUES (?,?,?,?,?,?)`);
const removeFavoriteStmt = db.prepare('DELETE FROM favorites WHERE guild_id=? AND user_id=? AND uri=?');
const listFavoritesStmt = db.prepare('SELECT * FROM favorites WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?');
const historyStmt = db.prepare(`INSERT INTO history
(guild_id,user_id,uri,title,author,duration_ms,played_at) VALUES (?,?,?,?,?,?,?)`);
const recentHistoryStmt = db.prepare('SELECT * FROM history WHERE guild_id=? ORDER BY played_at DESC LIMIT ?');

export function addFavorite(guildId, userId, track) {
  const info = trackToInfo(track);
  return addFavoriteStmt.run(guildId, userId, info.uri, info.title, info.author, Date.now()).changes > 0;
}

export function removeFavorite(guildId, userId, uri) {
  return removeFavoriteStmt.run(guildId, userId, uri).changes > 0;
}

export function listFavorites(guildId, userId, limit = 25) {
  return listFavoritesStmt.all(guildId, userId, limit);
}

export function addHistory(guildId, userId, track) {
  const info = trackToInfo(track);
  historyStmt.run(guildId, userId || 'unknown', info.uri, info.title, info.author, info.length, Date.now());
}

export function recentHistory(guildId, limit = 20) {
  return recentHistoryStmt.all(guildId, limit);
}

export function trackToInfo(track) {
  return {
    uri: track?.uri || track?.realUri || track?.identifier || '',
    title: track?.title || 'Unknown title',
    author: track?.author || '',
    length: Number(track?.length || 0),
  };
}
