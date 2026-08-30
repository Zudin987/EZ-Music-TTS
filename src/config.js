import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: required('DISCORD_GUILD_ID'),
  lavalinkUrl: process.env.LAVALINK_URL?.trim() || 'localhost:2333',
  lavalinkPassword: process.env.LAVALINK_PASSWORD?.trim() || 'ezmusic-local-only',
  lavalinkSecure: (process.env.LAVALINK_SECURE ?? 'false').toLowerCase() === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || '',
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
  defaultVolume: integer('DEFAULT_VOLUME', 80, 0, 100),
  autoDisconnectMinutes: integer('AUTO_DISCONNECT_MINUTES', 10, 1, 120),
};
