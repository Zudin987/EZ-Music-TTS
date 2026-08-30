import { randomBytes } from 'node:crypto';

export const SEARCH_PICKER_TTL_MS = 120_000;
export const SEARCH_PICKER_MAX = 32;

export function createSearchPickerRegistry({
  ttlMs = SEARCH_PICKER_TTL_MS,
  maxEntries = SEARCH_PICKER_MAX,
  now = () => Date.now(),
  tokenFactory = () => randomBytes(6).toString('base64url'),
} = {}) {
  const entries = new Map();
  const safeTtl = Math.max(1, Number(ttlMs) || SEARCH_PICKER_TTL_MS);
  const safeMax = Math.max(1, Math.floor(Number(maxEntries) || SEARCH_PICKER_MAX));

  function purge() {
    const current = Number(now());
    const safeNow = Number.isFinite(current) ? current : Date.now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= safeNow) entries.delete(token);
    }
    while (entries.size > safeMax) entries.delete(entries.keys().next().value);
  }

  function create({ guildId, userId, tracks, next = false, revision = 0 }) {
    purge();
    const token = String(tokenFactory());
    const current = Number(now());
    const safeNow = Number.isFinite(current) ? current : Date.now();
    entries.set(token, {
      guildId: String(guildId || ''),
      userId: String(userId || ''),
      tracks: Array.isArray(tracks) ? tracks.slice(0, 5) : [],
      next: Boolean(next),
      revision: Number(revision) || 0,
      expiresAt: safeNow + safeTtl,
    });
    purge();
    return token;
  }

  function getOwned({ guildId, userId, token }) {
    purge();
    const entry = entries.get(String(token || ''));
    if (!entry || entry.guildId !== String(guildId || '') || entry.userId !== String(userId || '')) return null;
    return entry;
  }

  function isCurrent(entry, revision) {
    return Boolean(entry && Number(entry.revision) === Number(revision));
  }

  return {
    create,
    getOwned,
    isCurrent,
    delete: (token) => entries.delete(String(token || '')),
    size: () => { purge(); return entries.size; },
  };
}
