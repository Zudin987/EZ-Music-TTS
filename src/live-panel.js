export const LIVE_PANEL_REFRESH_MS = 10_000;
export const LIVE_PANEL_TTL_MS = 14 * 60_000;
export const LIVE_PANEL_MAX = 32;

function panelKey(interaction) {
  const guildId = interaction?.guildId;
  const userId = interaction?.user?.id;
  return guildId && userId ? `${guildId}:${userId}` : null;
}

export function createLivePanelRegistry({
  refreshMs = LIVE_PANEL_REFRESH_MS,
  ttlMs = LIVE_PANEL_TTL_MS,
  maxEntries = LIVE_PANEL_MAX,
  now = () => Date.now(),
  render,
  setIntervalFn = (callback, delay) => setInterval(callback, delay),
  clearIntervalFn = (handle) => clearInterval(handle),
  onError = () => {},
} = {}) {
  if (typeof render !== 'function') throw new TypeError('Live panel registry requires a render function.');

  const intervalMs = Math.max(1, Number(refreshMs) || LIVE_PANEL_REFRESH_MS);
  const leaseMs = Math.max(1, Number(ttlMs) || LIVE_PANEL_TTL_MS);
  const limit = Math.max(1, Math.floor(Number(maxEntries) || LIVE_PANEL_MAX));
  const entries = new Map();
  let timer = null;

  function stopTimerIfIdle() {
    if (entries.size || timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function ensureTimer() {
    if (timer !== null || !entries.size) return;
    timer = setIntervalFn(() => { void tick(); }, intervalMs);
    timer?.unref?.();
  }

  function drop(key) {
    const entry = entries.get(key);
    if (entry) entry.active = false;
    entries.delete(key);
    stopTimerIfIdle();
  }

  function pause(interaction) {
    const key = panelKey(interaction);
    if (!key) return false;
    const existed = entries.has(key);
    drop(key);
    return existed;
  }

  function track(interaction) {
    const key = panelKey(interaction);
    if (!key || typeof interaction?.editReply !== 'function') return false;

    const currentTime = Number(now());
    const safeNow = Number.isFinite(currentTime) ? currentTime : Date.now();
    const createdAt = Number(interaction.createdTimestamp);
    const tokenStart = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : safeNow;
    const expiresAt = Math.min(safeNow + leaseMs, tokenStart + leaseMs);

    const previous = entries.get(key);
    if (previous) previous.active = false;
    entries.delete(key);
    entries.set(key, {
      interaction,
      expiresAt,
      active: true,
      updating: false,
    });

    while (entries.size > limit) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      drop(oldestKey);
    }
    ensureTimer();
    return true;
  }

  async function refreshEntry(key, entry, retiring) {
    if (!entry.active || entries.get(key) !== entry || entry.updating) return;
    entry.updating = true;
    try {
      const rendered = await render(entry.interaction, { retiring, expiresAt: entry.expiresAt });
      if (!entry.active || entries.get(key) !== entry) return;
      if (!rendered) {
        drop(key);
        return;
      }

      const payload = Object.prototype.hasOwnProperty.call(rendered, 'payload') ? rendered.payload : rendered;
      const stopAfter = retiring || Boolean(rendered.stopAfter);
      await entry.interaction.editReply(payload);
      if (stopAfter && entries.get(key) === entry) drop(key);
    } catch (error) {
      if (entries.get(key) === entry) drop(key);
      try { onError(error, { guildId: entry.interaction.guildId, userId: entry.interaction.user?.id }); } catch { /* logging must never break the scheduler */ }
    } finally {
      entry.updating = false;
    }
  }

  async function tick() {
    const currentTime = Number(now());
    const safeNow = Number.isFinite(currentTime) ? currentTime : Date.now();
    const work = [];
    for (const [key, entry] of [...entries]) {
      work.push(refreshEntry(key, entry, safeNow >= entry.expiresAt));
    }
    await Promise.allSettled(work);
    stopTimerIfIdle();
  }

  function shutdown() {
    for (const entry of entries.values()) entry.active = false;
    entries.clear();
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return {
    track,
    pause,
    tick,
    shutdown,
    has: (interaction) => {
      const key = panelKey(interaction);
      return Boolean(key && entries.has(key));
    },
    size: () => entries.size,
  };
}
