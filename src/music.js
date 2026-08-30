import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import { addHistory, getAutoplayMode, getGuildVolume as getStoredVolume, recentHistory, setAutoplayMode, setGuildVolume as setStoredVolume } from './storage.js';
import { radioFallbackHistory, trackKey, truncate } from './utils.js';

const MAX_UPCOMING_QUEUE = 300;
const SOURCE_FAILURE_WINDOW_MS = 60_000;
const SOURCE_FAILURE_THRESHOLD = 3;
const SOURCE_RETRY_MS = 60_000;
const SOURCE_STABLE_MS = 20_000;
const EMPTY_VOICE_GRACE_MS = 120_000;

function youtubeId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

export function createMusic(client, config, gemini) {
  const nodes = [{
    name: 'local',
    url: config.lavalinkUrl,
    auth: config.lavalinkPassword,
    secure: config.lavalinkSecure,
  }];

  const music = new Kazagumo({
    defaultSearchEngine: 'youtube',
    send: (guildId, payload) => client.guilds.cache.get(guildId)?.shard.send(payload),
  }, new Connectors.DiscordJS(client), nodes, {
    resume: true,
    resumeTimeout: 30,
    reconnectTries: 8,
    restTimeout: 20_000,
  });

  const disconnectTimers = new Map();
  const lastTracks = new Map();
  const autoplayLocks = new Set();
  const voiceIds = new Map();
  const queueRevisions = new Map();
  const emptyVoiceTimers = new Map();
  const playbackFailures = new Map();
  const heldQueues = new Map();
  const sourceRetryTimers = new Map();
  const sourceSuccessTimers = new Map();

  function getQueueRevision(guildId) {
    return queueRevisions.get(guildId) || 0;
  }

  function invalidateQueueWork(guildId) {
    const revision = getQueueRevision(guildId) + 1;
    queueRevisions.set(guildId, revision);
    return revision;
  }

  function isQueueRevisionCurrent(guildId, revision) {
    return getQueueRevision(guildId) === revision;
  }

  function queueRequestStillValid(player, revision) {
    return music.players.get(player.guildId) === player && isQueueRevisionCurrent(player.guildId, revision);
  }

  function queueCanceledError(message = 'Queue request was canceled because the queue changed.') {
    const error = new Error(message);
    error.expected = true;
    return error;
  }

  function queueTracks(player, tracks, { next = false, perRequestLimit = MAX_UPCOMING_QUEUE } = {}) {
    const input = Array.isArray(tracks) ? tracks.filter(Boolean) : tracks ? [tracks] : [];
    const available = Math.max(0, MAX_UPCOMING_QUEUE - Number(player?.queue?.length || 0));
    const allowed = Math.max(0, Math.min(available, Number.isFinite(perRequestLimit) ? perRequestLimit : MAX_UPCOMING_QUEUE));
    const added = input.slice(0, allowed);
    if (added.length) {
      if (next) player.queue.unshift(...added);
      else player.queue.add([...added]);
    }
    return { added, omitted: Math.max(0, input.length - added.length), capacity: MAX_UPCOMING_QUEUE };
  }

  function getHeldQueueCount(guildId) {
    return heldQueues.get(guildId)?.length || 0;
  }

  function clearSourceRetry(guildId) {
    const timer = sourceRetryTimers.get(guildId);
    if (timer) clearTimeout(timer);
    sourceRetryTimers.delete(guildId);
  }

  function clearSourceSuccess(guildId) {
    const timer = sourceSuccessTimers.get(guildId);
    if (timer) clearTimeout(timer);
    sourceSuccessTimers.delete(guildId);
  }

  function scheduleSourceSuccess(player, track) {
    const guildId = player.guildId;
    clearSourceSuccess(guildId);
    const fingerprint = `${track?.identifier || ''}:${track?.title || ''}`;
    const timer = setTimeout(() => {
      sourceSuccessTimers.delete(guildId);
      const current = player.queue.current;
      const currentFingerprint = `${current?.identifier || ''}:${current?.title || ''}`;
      if (music.players.get(guildId) === player && player.playing && currentFingerprint === fingerprint) {
        setHealthy(guildId);
      }
    }, SOURCE_STABLE_MS);
    timer.unref?.();
    sourceSuccessTimers.set(guildId, timer);
  }

  function discardHeldQueue(guildId, resetHealth = true) {
    const removed = getHeldQueueCount(guildId);
    heldQueues.delete(guildId);
    clearSourceRetry(guildId);
    clearSourceSuccess(guildId);
    if (resetHealth) playbackFailures.delete(guildId);
    return removed;
  }

  function getSourceHealth(guildId) {
    const state = playbackFailures.get(guildId);
    if (!state) return { status: 'healthy', failures: 0, retryAt: 0, lastError: '', held: getHeldQueueCount(guildId) };
    return {
      status: state.status || 'healthy',
      failures: state.times?.length || 0,
      retryAt: state.retryAt || 0,
      lastError: state.lastError || '',
      held: getHeldQueueCount(guildId),
    };
  }

  function setHealthy(guildId) {
    clearSourceRetry(guildId);
    clearSourceSuccess(guildId);
    playbackFailures.delete(guildId);
  }

  function scheduleSourceRetry(player) {
    const guildId = player.guildId;
    clearSourceRetry(guildId);
    const state = playbackFailures.get(guildId);
    if (!state || state.status !== 'degraded') return;
    const delay = Math.max(1_000, state.retryAt - Date.now());
    const timer = setTimeout(async () => {
      sourceRetryTimers.delete(guildId);
      const currentPlayer = music.players.get(guildId);
      const held = heldQueues.get(guildId) || [];
      if (currentPlayer !== player || !held.length) {
        if (!held.length) setHealthy(guildId);
        return;
      }

      // Do not interrupt something the user managed to start manually. Retry
      // when the player is idle instead of creating another race.
      if (player.queue.current || player.playing || player.paused) {
        const retryState = playbackFailures.get(guildId);
        if (retryState) {
          retryState.retryAt = Date.now() + SOURCE_RETRY_MS;
          playbackFailures.set(guildId, retryState);
          scheduleSourceRetry(player);
        }
        return;
      }

      heldQueues.delete(guildId);
      const result = queueTracks(player, held);
      const recovering = playbackFailures.get(guildId) || { times: [] };
      recovering.status = 'recovering';
      recovering.times = [];
      recovering.retryAt = 0;
      playbackFailures.set(guildId, recovering);
      console.warn(`[source-protection] retrying ${result.added.length} preserved track(s) for ${guildId}`);
      if (!result.added.length) return setHealthy(guildId);
      try {
        await player.play();
      } catch (error) {
        console.warn('[source-protection] retry failed to start', error?.message || error);
        openSourceCircuit(player, error?.message || 'retry failed');
      }
    }, delay);
    timer.unref?.();
    sourceRetryTimers.set(guildId, timer);
  }

  function openSourceCircuit(player, message, stopCurrent = true) {
    const guildId = player.guildId;
    const state = playbackFailures.get(guildId) || { times: [] };
    if (state.status === 'degraded') return;

    invalidateQueueWork(guildId);
    if (player.loop !== 'none') player.setLoop('none');
    setAutoplayMode(guildId, 'off');

    const existing = heldQueues.get(guildId) || [];
    const upcoming = [...player.queue];
    if (upcoming.length) {
      player.queue.clear();
      heldQueues.set(guildId, [...existing, ...upcoming].slice(0, MAX_UPCOMING_QUEUE));
    }

    state.status = 'degraded';
    state.retryAt = Date.now() + SOURCE_RETRY_MS;
    state.lastError = String(message || 'playback source error').slice(0, 500);
    playbackFailures.set(guildId, state);
    console.warn(`[source-protection] circuit open for ${guildId}; preserved ${getHeldQueueCount(guildId)} upcoming track(s)`);

    // Force the failed current item to end only after the upcoming queue has
    // been moved aside. Kazagumo can then emit playerEmpty without burning
    // through the preserved queue.
    if (stopCurrent) {
      try { if (player.queue.current) player.skip(); } catch { /* end event may already be in flight */ }
    }
    scheduleSourceRetry(player);
  }

  function recordPlaybackFailure(player, message, { skipCurrent = true } = {}) {
    const guildId = player.guildId;
    clearSourceSuccess(guildId);
    const now = Date.now();
    const track = player.queue.current;
    const fingerprint = `${track?.identifier || ''}:${track?.title || ''}`;
    const state = playbackFailures.get(guildId) || { times: [], status: 'healthy', lastFingerprint: '', lastFailureAt: 0 };

    // Lavalink can emit stuck + exception for the same failed item. Count that
    // as one failure rather than opening the circuit twice for one track.
    if (state.lastFingerprint === fingerprint && now - Number(state.lastFailureAt || 0) < 1_500) return state;
    state.lastFingerprint = fingerprint;
    state.lastFailureAt = now;
    state.lastError = String(message || 'playback source error').slice(0, 500);
    state.times = (state.times || []).filter((time) => now - time <= SOURCE_FAILURE_WINDOW_MS);
    state.times.push(now);
    playbackFailures.set(guildId, state);

    const threshold = state.status === 'recovering' ? 1 : SOURCE_FAILURE_THRESHOLD;
    if (state.times.length >= threshold) openSourceCircuit(player, state.lastError, skipCurrent);
    else if (skipCurrent) {
      try {
        if (player.queue.current) {
          if (player.loop !== 'none') player.setLoop('none');
          player.skip();
        }
      } catch (error) { console.warn('[source-protection] skip failed', error?.message || error); }
    }
    return state;
  }

  function clearEmptyVoiceTimer(guildId) {
    const timer = emptyVoiceTimers.get(guildId);
    if (timer) clearTimeout(timer);
    emptyVoiceTimers.delete(guildId);
  }

  function hasHumanListener(player) {
    const voiceId = player?.voiceId || voiceIds.get(player?.guildId);
    if (!voiceId) return false;
    const channel = client.channels.cache.get(voiceId);
    if (channel?.members?.some?.((member) => !member.user?.bot)) return true;

    // Voice-state cache is available with GuildVoiceStates and does not need
    // the privileged GuildMembers intent. Use it as a fallback so the 2-minute
    // auto-leave timer does not depend on the full member cache.
    const guild = client.guilds.cache.get(player.guildId);
    return Boolean(guild?.voiceStates?.cache?.some?.((state) => {
      if (state.channelId !== voiceId || state.id === client.user?.id) return false;
      return client.users.cache.get(state.id)?.bot !== true;
    }));
  }

  function evaluateVoiceOccupancy(player) {
    if (!player || music.players.get(player.guildId) !== player) return;
    if (hasHumanListener(player)) return clearEmptyVoiceTimer(player.guildId);
    if (emptyVoiceTimers.has(player.guildId)) return;

    const timer = setTimeout(async () => {
      emptyVoiceTimers.delete(player.guildId);
      if (music.players.get(player.guildId) !== player || hasHumanListener(player)) return;
      console.log(`[voice] no human listeners for 2 minutes; disconnecting ${player.guildId}`);
      invalidateQueueWork(player.guildId);
      setAutoplayMode(player.guildId, 'off');
      discardHeldQueue(player.guildId);
      try { player.queue.clear(); } catch { /* player may already be tearing down */ }
      try { await player.destroy(); } catch (error) { console.warn('[voice] auto-leave failed', error?.message || error); }
    }, EMPTY_VOICE_GRACE_MS);
    timer.unref?.();
    emptyVoiceTimers.set(player.guildId, timer);
  }

  client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;
    const player = guildId ? music.players.get(guildId) : null;
    if (!player) return;
    const voiceId = player.voiceId || voiceIds.get(guildId);
    if (!voiceId || (oldState.channelId !== voiceId && newState.channelId !== voiceId)) return;
    evaluateVoiceOccupancy(player);
  });

  function lavalinkBaseUrl() {
    const raw = String(config.lavalinkUrl || 'localhost:2333').replace(/^https?:\/\//i, '');
    return `${config.lavalinkSecure ? 'https' : 'http'}://${raw}`;
  }

  async function getRuntimeStats() {
    const node = process.memoryUsage();
    let lavalink = null;
    try {
      const response = await fetch(`${lavalinkBaseUrl()}/v4/stats`, {
        headers: { Authorization: config.lavalinkPassword },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) lavalink = await response.json();
    } catch { /* status remains useful even if stats endpoint is temporarily unavailable */ }
    return {
      node: { rss: node.rss, heapUsed: node.heapUsed, heapTotal: node.heapTotal },
      lavalink,
      queueLimit: MAX_UPCOMING_QUEUE,
    };
  }

  // A persisted AI mode must not survive a restart where Gemini was removed.
  if (!gemini?.enabled && getAutoplayMode(config.discordGuildId) === 'ai') {
    setAutoplayMode(config.discordGuildId, 'off');
  }

  music.shoukaku.on('ready', (name, resumed) => console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`));
  music.shoukaku.on('error', (name, error) => console.error(`[lavalink] ${name}`, error));
  music.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`));

  music.on('playerStart', (player, track) => {
    void handlePlayerStart(player, track).catch((error) => console.warn('[player-start]', error?.message || error));
  });

  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    console.warn('[player-exception]', player.guildId, message);
    recordPlaybackFailure(player, message);
  });

  music.on('playerResolveError', (player, track, message) => {
    const detail = message || `could not resolve ${track?.title || 'track'}`;
    console.warn('[player-resolve-error]', player.guildId, detail);
    // Kazagumo advances a resolve failure itself after this synchronous event.
    recordPlaybackFailure(player, detail, { skipCurrent: false });
  });

  music.on('playerStuck', (player, data) => {
    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;
    console.warn('[player-stuck]', player.guildId, message);
    recordPlaybackFailure(player, message);
  });

  music.on('playerEmpty', (player) => {
    void handlePlayerEmpty(player).catch((error) => console.warn('[player-empty]', error?.message || error));
  });

  music.on('playerDestroy', (player) => {
    void handlePlayerDestroy(player).catch((error) => console.warn('[player-destroy]', error?.message || error));
  });

  async function handlePlayerStart(player, track) {
    clearDisconnect(player.guildId);
    clearEmptyVoiceTimer(player.guildId);
    scheduleSourceSuccess(player, track);
    lastTracks.set(player.guildId, track);
    if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    try {
      addHistory(player.guildId, track?.requester?.id || 'unknown', track);
    } catch (error) {
      // Local history should never be able to break otherwise healthy playback.
      console.warn('[history] unable to record track', error?.message || error);
    }
    await setVoiceStatus(player, track);
    evaluateVoiceOccupancy(player);
  }

  async function handlePlayerEmpty(player) {
    // Kazagumo can leave its paused flag set when a paused track is skipped or
    // stopped. Normalize both the wrapper and Lavalink state before any future
    // autoplay/new play request so an old pause cannot silently block playback.
    if (player.paused || player.shoukaku?.paused) {
      try { await player.shoukaku.setPaused(false); }
      catch (error) { console.warn('[player-empty] unable to reset paused state', error?.message || error); }
      player.paused = false;
    }
    player.playing = false;

    const health = getSourceHealth(player.guildId);
    if (health.status === 'degraded' || health.status === 'recovering') {
      await clearVoiceStatus(player);
      scheduleDisconnect(player);
      return;
    }

    const filled = await refillAutoplay(player).catch((error) => {
      console.warn('[autoplay]', error?.message || error);
      return false;
    });
    if (!filled && music.players.get(player.guildId) === player) {
      await clearVoiceStatus(player);
      scheduleDisconnect(player);
    }
  }

  async function handlePlayerDestroy(player) {
    // Never allow an old /play, /ai or /radio request to enqueue into a player
    // that has already been destroyed/recreated.
    invalidateQueueWork(player.guildId);
    clearDisconnect(player.guildId);
    clearEmptyVoiceTimer(player.guildId);
    clearSourceSuccess(player.guildId);
    discardHeldQueue(player.guildId);
    await clearVoiceStatus(player);
    voiceIds.delete(player.guildId);
    lastTracks.delete(player.guildId);
    autoplayLocks.delete(player.guildId);
  }

  function clearDisconnect(guildId) {
    const timer = disconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(guildId);
  }

  function scheduleDisconnect(player) {
    clearDisconnect(player.guildId);
    const timer = setTimeout(() => {
      disconnectTimers.delete(player.guildId);
      const completelyIdle = !player.queue.current && player.queue.isEmpty && !player.playing && !player.paused;
      if (completelyIdle && music.players.get(player.guildId) === player) {
        player.destroy().catch((error) => console.warn('[idle-disconnect]', error?.message || error));
      }
    }, config.autoDisconnectMinutes * 60_000);
    timer.unref?.();
    disconnectTimers.set(player.guildId, timer);
  }

  async function ensurePlayer(interaction) {
    const voice = interaction.member?.voice?.channel;
    if (!voice) throw new Error('Join a voice channel first.');

    const sourceHealth = getSourceHealth(interaction.guildId);
    if (sourceHealth.status === 'degraded' || sourceHealth.status === 'recovering') {
      const wait = sourceHealth.retryAt > Date.now() ? Math.ceil((sourceHealth.retryAt - Date.now()) / 1000) : 0;
      throw queueCanceledError(`Playback source protection is ${sourceHealth.status}. ${sourceHealth.held || 0} queued track(s) are preserved${wait ? `; automatic retry in about ${wait}s` : ''}.`);
    }

    let player = music.players.get(interaction.guildId);
    if (!player) {
      player = await music.createPlayer({
        guildId: interaction.guildId,
        textId: interaction.channelId,
        voiceId: voice.id,
        deaf: true,
        volume: getStoredVolume(interaction.guildId, config.defaultVolume),
      });
      if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    } else {
      if (player.voiceId && player.voiceId !== voice.id) throw new Error('Join the same voice channel as the bot first.');
      player.setTextChannel(interaction.channelId);
    }

    clearEmptyVoiceTimer(player.guildId);

    // Keep an idle player on a fresh timeout even if the upcoming search fails.
    // playerStart clears this timer after playback actually begins.
    if (!player.queue.current && !player.playing) scheduleDisconnect(player);
    return player;
  }

  async function setVoiceStatus(player, track) {
    const voiceId = player?.voiceId || voiceIds.get(player?.guildId);
    if (!voiceId || !track) return;
    voiceIds.set(player.guildId, voiceId);
    const status = truncate(`Playing: ${track.title || 'Unknown'} • ${track.author || 'Unknown'}`, 500);
    await client.rest.put(`/channels/${voiceId}/voice-status`, { body: { status } }).catch((error) => {
      console.warn('[voice-status] unable to set status; grant Set Voice Channel Status permission', error?.message || error);
    });
  }

  async function clearVoiceStatus(player) {
    const voiceId = player?.voiceId || voiceIds.get(player?.guildId);
    if (!voiceId) return;
    await client.rest.put(`/channels/${voiceId}/voice-status`, { body: { status: null } }).catch(() => {});
  }

  async function resolveQueries(player, queries, requester, seen = new Set(), limit = 5, concurrency = 3, revision = null) {
    const selected = [];
    const cleanQueries = (queries || []).filter(Boolean);
    const width = Math.max(1, Math.min(5, concurrency));

    for (let offset = 0; offset < cleanQueries.length && selected.length < limit; offset += width) {
      if (revision !== null && !queueRequestStillValid(player, revision)) break;
      const batch = cleanQueries.slice(offset, offset + width);
      const results = await Promise.all(batch.map((query) => player.search(query, { requester }).catch(() => null)));
      if (revision !== null && !queueRequestStillValid(player, revision)) break;
      for (const result of results) {
        const track = result?.tracks?.find((candidate) => {
          const key = trackKey(candidate);
          return key && !seen.has(key);
        });
        if (!track) continue;
        const key = trackKey(track);
        seen.add(key);
        selected.push(track);
        if (selected.length >= limit) break;
      }
    }

    return selected;
  }

  async function standardRecommendations(player, seedTrack, limit = 5, requester = seedTrack?.requester || client.user) {
    if (!seedTrack) return [];
    const recent = new Set(recentHistory(player.guildId, 30).map((row) => trackKey(row)).filter(Boolean));
    const seedKey = trackKey(seedTrack);
    const selected = [];
    const selectedKeys = new Set();

    const takeUsable = (tracks) => {
      for (const track of tracks || []) {
        const key = trackKey(track);
        if (!key || key === seedKey || recent.has(key) || selectedKeys.has(key)) continue;
        selectedKeys.add(key);
        selected.push(track);
        if (selected.length >= limit) break;
      }
      return selected;
    };

    const id = youtubeId(seedTrack);
    if (id) {
      try {
        const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
        const result = await player.search(mixUrl, { requester });
        takeUsable(result?.tracks);
        if (selected.length >= limit) return selected;
      } catch { /* YouTube mixes occasionally fail; use search fallback */ }
    }

    const fallbackQuery = `${seedTrack.author || seedTrack.title || ''} songs`.trim();
    if (fallbackQuery) {
      const fallback = await player.search(fallbackQuery, { requester }).catch(() => null);
      takeUsable(fallback?.tracks);
    }
    return selected.slice(0, limit);
  }

  async function aiRecommendations(player, limit = 5, revision = null) {
    if (!gemini?.enabled) return [];
    const recent = recentHistory(player.guildId, 20);
    const plan = await gemini.makeQueue('Continue this listening session naturally. Recommend songs that fit what this server has been playing. Avoid repeats.', { recent, maxSongs: limit });
    if (revision !== null && !queueRequestStillValid(player, revision)) return [];
    const seen = new Set(recent.map((row) => trackKey(row)).filter(Boolean));
    return resolveQueries(player, plan.queries.slice(0, limit), client.user, seen, limit, 3, revision);
  }

  async function refillAutoplay(player) {
    const mode = getAutoplayMode(player.guildId);
    if (mode === 'off' || autoplayLocks.has(player.guildId)) return false;
    const revision = getQueueRevision(player.guildId);
    autoplayLocks.add(player.guildId);
    try {
      const seed = lastTracks.get(player.guildId);
      let tracks = [];
      if (mode === 'ai') {
        try {
          tracks = await aiRecommendations(player, 5, revision);
        } catch (error) {
          console.warn('[autoplay] AI continuation unavailable; falling back to standard recommendations:', error?.message || error);
        }
        if (!tracks.length && queueRequestStillValid(player, revision)) tracks = await standardRecommendations(player, seed, 5);
      } else {
        tracks = await standardRecommendations(player, seed, 5);
      }

      // The user may have cleared/stopped the queue, disabled/switched autoplay,
      // or destroyed the player while network/AI searches were in flight.
      if (getAutoplayMode(player.guildId) !== mode || !queueRequestStillValid(player, revision)) return false;
      if (!tracks.length) return false;
      const queued = queueTracks(player, tracks);
      if (!queued.added.length) return false;
      if (!player.playing && !player.paused) await player.play();
      return true;
    } finally {
      autoplayLocks.delete(player.guildId);
    }
  }

  async function startServerRadio(player, requester, revision = getQueueRevision(player.guildId)) {
    const history = recentHistory(player.guildId, 100);
    if (!history.length) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');
    if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');

    const seen = new Set(history.slice(0, 15).map((row) => trackKey(row)).filter(Boolean));
    if (player.queue.current) {
      const key = trackKey(player.queue.current);
      if (key) seen.add(key);
    }
    for (const track of player.queue) {
      const key = trackKey(track);
      if (key) seen.add(key);
    }

    const picked = [];
    const uniqueSeedKeys = new Set();
    const seeds = [];
    for (const row of history) {
      const key = row.uri || trackKey(row);
      if (!key || uniqueSeedKeys.has(key)) continue;
      uniqueSeedKeys.add(key);
      seeds.push(row);
      if (seeds.length >= 8) break;
    }

    // Resolve a few recommendation seeds in parallel so /radio does not make
    // every network lookup wait for the previous one to finish.
    for (let offset = 0; offset < seeds.length && picked.length < 15; offset += 3) {
      if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
      const batch = seeds.slice(offset, offset + 3);
      const recommendationSets = await Promise.all(batch.map((seed) => standardRecommendations(player, seed, 5, requester).catch(() => [])));
      if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
      for (const recommendations of recommendationSets) {
        for (const track of recommendations) {
          const key = trackKey(track);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          picked.push(track);
          if (picked.length >= 15) break;
        }
        if (picked.length >= 15) break;
      }
    }

    if (picked.length < 5 && gemini?.enabled && queueRequestStillValid(player, revision)) {
      try {
        const extra = await gemini.makeQueue('Build a server radio from this listening history. Pick varied songs that fit the established taste and avoid exact repeats.', { recent: history.slice(0, 25), maxSongs: 10 });
        if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
        const resolved = await resolveQueries(player, extra.queries, requester, seen, 15 - picked.length, 3, revision);
        picked.push(...resolved);
      } catch (error) {
        if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
        console.warn('[radio] Gemini enhancement unavailable:', error?.message || error);
      }
    }

    // Last-resort fallback: prefer older history. If the server is brand-new and
    // has fewer than 16 history entries, replaying a recent known-good track is
    // better than claiming radio cannot be built at all.
    if (!picked.length && queueRequestStillValid(player, revision)) {
      const fallbackRows = radioFallbackHistory(history, 15, 10);
      const fallbackQueries = fallbackRows.map((row) => row.uri || `${row.author || ''} ${row.title || ''}`.trim()).filter(Boolean);
      const fallbackSeen = new Set(seen);
      const resolved = await resolveQueries(player, fallbackQueries, requester, fallbackSeen, 10, 3, revision);
      picked.push(...resolved);
    }

    if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
    if (!picked.length) throw new Error('Could not build server radio from the available sources.');
    const queued = queueTracks(player, picked);
    if (!queued.added.length) throw new Error(`Queue is full (maximum ${MAX_UPCOMING_QUEUE} upcoming tracks).`);
    if (!player.playing && !player.paused) await player.play();
    return queued.added.length;
  }

  function setGuildAutoplay(guildId, mode) {
    if (mode === 'ai' && !gemini?.enabled) throw new Error('Gemini is not configured, so AI autoplay cannot be enabled.');
    setAutoplayMode(guildId, mode);
    return mode;
  }

  function getGuildVolume(guildId) {
    return getStoredVolume(guildId, config.defaultVolume);
  }

  function setGuildVolume(guildId, volume) {
    return setStoredVolume(guildId, volume);
  }

  return {
    music,
    ensurePlayer,
    startServerRadio,
    setGuildAutoplay,
    getGuildAutoplay: getAutoplayMode,
    getGuildVolume,
    setGuildVolume,
    getQueueRevision,
    invalidateQueueWork,
    isQueueRevisionCurrent,
    queueTracks,
    getQueueLimit: () => MAX_UPCOMING_QUEUE,
    getRuntimeStats,
    getSourceHealth,
    getHeldQueueCount,
    discardHeldQueue,
  };
}
