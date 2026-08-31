import { Kazagumo } from 'kazagumo';
import { Connectors, Constants } from 'shoukaku';
import {
  addHistory,
  deleteRecoverySession,
  getAutoplayMode,
  getGuildVolume as getStoredVolume,
  getRecoverySession as getStoredRecoverySession,
  recentHistory,
  saveRecoverySession,
  setAutoplayMode,
  setGuildVolume as setStoredVolume,
  updateRecoveryPosition,
} from './storage.js';
import { radioFallbackHistory, trackKey, truncate } from './utils.js';
import { resolvePreferredSearch } from './source-routing.js';
import { emptyVoiceTransition } from './performance.js';
import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, playbackFallbackQueries, playbackFallbackQuery, restoreFallbackQueue, takeFallbackQueueHold, youtubeTrackId } from './playback-fallback.js';
import { playbackHistoryFingerprint, playbackHistoryReady } from './playback-history.js';
import { activeTrackMatchesCurrent } from './playback-start.js';
import { setPlayerPaused, stopPlayerTrack } from './player-control.js';
import { nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceChannelTransition, voiceCloseDisposition, VOICE_CLOSE_RECOVERY_GRACE_MS } from './lavalink-lifecycle.js';

const MAX_UPCOMING_QUEUE = 300;
const SOURCE_FAILURE_WINDOW_MS = 60_000;
const SOURCE_FAILURE_THRESHOLD = 3;
const SOURCE_RETRY_MS = 60_000;
const SOURCE_STABLE_MS = 20_000;
const EMPTY_VOICE_GRACE_MS = 120_000;
const RECOVERY_SAVE_DEBOUNCE_MS = 750;
const RECOVERY_POSITION_SAVE_MS = 15_000;
const RECOVERY_SYNC_BATCH = 20;
const PLAYBACK_FALLBACK_WINDOW_MS = 30_000;
const PLAYBACK_FALLBACK_SEARCH_TIMEOUT_MS = 6_000;
const PLAYBACK_FALLBACK_SETTLE_TIMEOUT_MS = 2_000;
const LAVALINK_NODE_NAME = 'local';

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
    // Shoukaku 4.3.0 has an upstream reconnect bug where a failed attempt can
    // leave a stale connectError that tears down a later successful retry in the
    // same connect() loop. One library attempt + our event-driven node supervisor
    // avoids that bug without replacing/forking Shoukaku.
    reconnectTries: 1,
    reconnectInterval: 2,
    restTimeout: 20_000,
  });

  const disconnectTimers = new Map();
  const lastTracks = new Map();
  const autoplayLocks = new Set();
  const voiceIds = new Map();
  const queueRevisions = new Map();
  const emptyVoiceTimers = new Map();
  const emptyVoiceAutoPaused = new Set();
  const playbackFailures = new Map();
  const heldQueues = new Map();
  const sourceRetryTimers = new Map();
  const sourceSuccessTimers = new Map();
  const recoverySaveTimers = new Map();
  const recoveryPositionSavedAt = new Map();
  const operationChains = new Map();
  const playerCreationPromises = new Map();
  const recoveryResumes = new Set();
  const playbackFallbackAttempts = new Map();
  const playbackFallbackHolds = new Map();
  const pendingPlaybackHistory = new Map();
  const voiceCloseRecoveryTimers = new Map();
  const transportRetirements = new Map();
  let localNodeReconnectTimer = null;
  let localNodeReconnectAttempt = 0;
  let localNodeRetryAt = 0;
  let localNodeEverReady = false;
  let localNodeState = 'starting';
  let localNodeLastError = '';
  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);

  const searchPreferred = (target, query, requester) => resolvePreferredSearch(target, query, requester, { spotifyConfigured });

  function clearVoiceCloseRecoveryTimer(guildId) {
    const timer = voiceCloseRecoveryTimers.get(guildId);
    if (timer) clearTimeout(timer);
    voiceCloseRecoveryTimers.delete(guildId);
  }

  function clearLocalNodeReconnectTimer() {
    if (localNodeReconnectTimer) clearTimeout(localNodeReconnectTimer);
    localNodeReconnectTimer = null;
    localNodeRetryAt = 0;
  }

  function isLocalNodeConnected() {
    return music.shoukaku.nodes.get(LAVALINK_NODE_NAME)?.state === Constants.State.CONNECTED;
  }

  function getLavalinkNodeHealth() {
    const node = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
    if (node?.state === Constants.State.CONNECTED) {
      return { status: 'connected', attempt: 0, retryAt: 0, lastError: '' };
    }
    const connecting = node?.state === Constants.State.CONNECTING;
    return {
      status: connecting || localNodeReconnectTimer || localNodeState === 'reconnecting' ? 'reconnecting' : localNodeState,
      attempt: localNodeReconnectAttempt,
      retryAt: localNodeRetryAt,
      lastError: localNodeLastError,
    };
  }

  async function retirePlayerForTransportLoss(player, reason) {
    if (!player || music.players.get(player.guildId) !== player) return false;
    const guildId = player.guildId;
    const existing = transportRetirements.get(guildId);
    if (existing) return existing;

    const retirement = (async () => {
      console.warn(`[transport] retiring stale player ${guildId}: ${String(reason || 'transport lost').slice(0, 220)}`);
      // Snapshot current + upcoming + held fallback work before any in-memory
      // cleanup. This makes a node/server/voice failure recoverable via /status.
      checkpointRecovery(player);
      invalidateQueueWork(guildId);
      clearVoiceCloseRecoveryTimer(guildId);

      // Shoukaku's leaveVoiceChannel is intentionally used instead of
      // KazagumoPlayer.destroy(): it catches a dead-node REST destroy failure but
      // still sends Discord channel_id:null and removes Shoukaku connection state.
      try { await music.shoukaku.leaveVoiceChannel(guildId); }
      catch (error) { console.warn('[transport] Shoukaku voice cleanup failed', error?.message || error); }

      if (music.players.get(guildId) === player) music.players.delete(guildId);
      player.playing = false;
      player.paused = false;
      player.voiceId = null;
      await handlePlayerDestroy(player);
      return true;
    })().finally(() => {
      if (transportRetirements.get(guildId) === retirement) transportRetirements.delete(guildId);
    });

    transportRetirements.set(guildId, retirement);
    return retirement;
  }

  async function retirePlayersForNodeLoss(reason) {
    const affected = [...music.players.values()].filter((player) => player?.shoukaku?.node?.name === LAVALINK_NODE_NAME);
    if (!affected.length) return 0;
    await Promise.allSettled(affected.map((player) => retirePlayerForTransportLoss(player, reason)));
    return affected.length;
  }

  function scheduleLocalNodeReplacement(reason = 'Lavalink node unavailable') {
    if (isLocalNodeConnected() || localNodeReconnectTimer) return false;
    const existing = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
    if (existing?.state === Constants.State.CONNECTING) return false;
    if (existing && existing.state !== Constants.State.CONNECTED) music.shoukaku.nodes.delete(LAVALINK_NODE_NAME);

    localNodeState = 'reconnecting';
    localNodeLastError = String(reason || '').slice(0, 500);
    const attempt = ++localNodeReconnectAttempt;
    const delay = nodeReconnectDelayMs(attempt);
    localNodeRetryAt = Date.now() + delay;
    console.warn(`[lavalink] local node unavailable; replacement attempt ${attempt} in ${Math.round(delay / 1000)}s`);

    localNodeReconnectTimer = setTimeout(() => {
      localNodeReconnectTimer = null;
      localNodeRetryAt = 0;
      if (isLocalNodeConnected()) return;
      const current = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
      if (current?.state === Constants.State.CONNECTING) return;
      if (current) music.shoukaku.nodes.delete(LAVALINK_NODE_NAME);
      try {
        music.shoukaku.addNode(nodes[0]);
      } catch (error) {
        localNodeLastError = String(error?.message || error).slice(0, 500);
        scheduleLocalNodeReplacement(localNodeLastError);
      }
    }, delay);
    localNodeReconnectTimer.unref?.();
    return true;
  }

  async function withGuildOperation(guildId, task) {
    const previous = operationChains.get(guildId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    operationChains.set(guildId, current);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (operationChains.get(guildId) === current) operationChains.delete(guildId);
    }
  }

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
    const heldCount = getHeldQueueCount(player?.guildId);
    const available = Math.max(0, MAX_UPCOMING_QUEUE - Number(player?.queue?.length || 0) - heldCount);
    const allowed = Math.max(0, Math.min(available, Number.isFinite(perRequestLimit) ? perRequestLimit : MAX_UPCOMING_QUEUE));
    const added = input.slice(0, allowed);
    if (added.length) {
      // While a failed YouTube item is being resolved through SoundCloud, keep
      // newly queued work in the same temporary hold. Otherwise Kazagumo could
      // auto-promote that new work before the fallback search has finished.
      if (playbackFallbackHolds.has(player.guildId)) {
        const held = heldQueues.get(player.guildId) || [];
        if (next) held.unshift(...added);
        else held.push(...added);
        heldQueues.set(player.guildId, held.slice(0, MAX_UPCOMING_QUEUE));
      } else if (next) player.queue.unshift(...added);
      else player.queue.add([...added]);
    }
    return { added, omitted: Math.max(0, input.length - added.length), capacity: MAX_UPCOMING_QUEUE };
  }

  function getHeldQueueCount(guildId) {
    return heldQueues.get(guildId)?.length || 0;
  }


  function stagePlaybackHistory(player, track) {
    const fingerprint = playbackHistoryFingerprint(track);
    if (!fingerprint) return pendingPlaybackHistory.delete(player.guildId);
    pendingPlaybackHistory.set(player.guildId, {
      fingerprint,
      track,
      requesterId: track?.requester?.id || 'unknown',
    });
  }

  function clearPendingPlaybackHistory(guildId, track = null) {
    const pending = pendingPlaybackHistory.get(guildId);
    if (!pending) return false;
    if (track && pending.fingerprint !== playbackHistoryFingerprint(track)) return false;
    pendingPlaybackHistory.delete(guildId);
    return true;
  }

  function commitPendingPlaybackHistory(player) {
    const pending = pendingPlaybackHistory.get(player.guildId);
    if (!playbackHistoryReady(pending, player.queue.current, player.position, player.paused || player.shoukaku?.paused)) return false;
    pendingPlaybackHistory.delete(player.guildId);
    try {
      addHistory(player.guildId, pending.requesterId, pending.track);
      return true;
    } catch (error) {
      console.warn('[history] unable to record track', error?.message || error);
      return false;
    }
  }

  function getHeldQueueSnapshot(guildId) {
    return [...(heldQueues.get(guildId) || [])];
  }

  function clearRecoverySaveTimer(guildId) {
    const timer = recoverySaveTimers.get(guildId);
    if (timer) clearTimeout(timer);
    recoverySaveTimers.delete(guildId);
  }

  function recoveryQueue(player) {
    const held = getHeldQueueSnapshot(player.guildId);
    return [...player.queue, ...held].slice(0, MAX_UPCOMING_QUEUE);
  }

  function persistRecovery(player) {
    if (!player || music.players.get(player.guildId) !== player) return false;
    const queue = recoveryQueue(player);
    const current = player.queue.current || null;
    if (!current && !queue.length) {
      deleteRecoverySession(player.guildId);
      return false;
    }
    return saveRecoverySession(player.guildId, {
      voiceId: player.voiceId || voiceIds.get(player.guildId) || '',
      textId: player.textId || '',
      current,
      queue,
      positionMs: Number(player.position || 0),
      volumePercent: Number(player.volume || getStoredVolume(player.guildId, config.defaultVolume)),
      loopMode: player.loop || 'none',
      autoplayMode: getAutoplayMode(player.guildId),
      paused: Boolean(player.paused),
    });
  }

  function scheduleRecoverySave(player, delay = RECOVERY_SAVE_DEBOUNCE_MS) {
    if (!player) return;
    clearRecoverySaveTimer(player.guildId);
    const timer = setTimeout(() => {
      recoverySaveTimers.delete(player.guildId);
      try { persistRecovery(player); }
      catch (error) { console.warn('[recovery] save failed', error?.message || error); }
    }, Math.max(0, delay));
    timer.unref?.();
    recoverySaveTimers.set(player.guildId, timer);
  }

  function checkpointRecovery(player) {
    clearRecoverySaveTimer(player?.guildId);
    try { return persistRecovery(player); }
    catch (error) {
      console.warn('[recovery] checkpoint failed', error?.message || error);
      return false;
    }
  }

  function clearRecoverySession(guildId) {
    clearRecoverySaveTimer(guildId);
    recoveryPositionSavedAt.delete(guildId);
    return deleteRecoverySession(guildId);
  }

  function getRecoverableSession(guildId) {
    if (music.players.get(guildId)?.queue?.current) return null;
    return getStoredRecoverySession(guildId);
  }

  async function resolveStoredTrack(player, row, requester) {
    if (!row) return null;
    const primary = String(row.uri || '').trim() || `${row.author || ''} ${row.title || ''}`.trim();
    if (!primary) return null;
    let result = await searchPreferred(player, primary, requester).catch(() => null);
    if (!result?.tracks?.length && row.title) {
      result = await searchPreferred(player, `${row.author || ''} ${row.title}`.trim(), requester).catch(() => null);
    }
    return result?.tracks?.[0] || null;
  }

  async function resolveStoredBatch(player, rows, requester, revision) {
    const resolved = [];
    for (let offset = 0; offset < rows.length; offset += 4) {
      if (!queueRequestStillValid(player, revision)) break;
      const batch = rows.slice(offset, offset + 4);
      const tracks = await Promise.all(batch.map((row) => resolveStoredTrack(player, row, requester)));
      if (!queueRequestStillValid(player, revision)) break;
      resolved.push(...tracks.filter(Boolean));
    }
    return resolved;
  }

  async function restoreRecoveryTail(player, rows, requester, revision) {
    try {
      for (let offset = 0; offset < rows.length; offset += 12) {
        if (!queueRequestStillValid(player, revision)) return;
        const resolved = await resolveStoredBatch(player, rows.slice(offset, offset + 12), requester, revision);
        if (!resolved.length) continue;
        await withGuildOperation(player.guildId, async () => {
          if (!queueRequestStillValid(player, revision)) return;
          queueTracks(player, resolved);
          scheduleRecoverySave(player);
        });
        if (player.queue.length >= MAX_UPCOMING_QUEUE) return;
      }
    } catch (error) {
      console.warn('[recovery] background queue restore stopped', error?.message || error);
    }
  }

  async function resumeRecoverySession(interaction, session) {
    const guildId = interaction.guildId;
    if (!session) throw queueCanceledError('No recent recoverable session is available.');
    if (recoveryResumes.has(guildId)) throw queueCanceledError('A session restore is already in progress for this server.');
    if (music.players.get(guildId)) throw queueCanceledError('A voice session is already active. Stop or disconnect it before restoring an older session.');

    recoveryResumes.add(guildId);
    try {
      const player = await ensurePlayer(interaction);
      const revision = invalidateQueueWork(guildId);
      const requester = interaction.user || client.user;
      const rows = Array.isArray(session.queue) ? session.queue.slice(0, MAX_UPCOMING_QUEUE) : [];
      const currentRow = session.current || rows.shift() || null;
      const currentTrack = await resolveStoredTrack(player, currentRow, requester);
      const initialRows = rows.slice(0, RECOVERY_SYNC_BATCH);
      const initialTracks = await resolveStoredBatch(player, initialRows, requester, revision);

      if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Session restore was canceled because the queue changed.');
      if (!currentTrack && !initialTracks.length) {
        clearRecoverySession(guildId);
        await player.destroy().catch(() => {});
        throw new Error('The saved session could not be resolved by the current music source.');
      }

      await withGuildOperation(guildId, async () => {
        if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Session restore was canceled because the queue changed.');
        player.queue.clear();
        const restoredUpcoming = [...initialTracks];
        const startTrack = currentTrack || restoredUpcoming.shift();
        if (!startTrack) throw new Error('No recoverable track could be loaded.');
        const maxPosition = Math.max(0, Number(startTrack.length || 0));
        const requestedPosition = currentTrack ? Math.max(0, Number(session.positionMs || 0)) : 0;
        const startPosition = maxPosition ? Math.min(Math.max(0, maxPosition - 1), requestedPosition) : requestedPosition;
        // Kazagumo/Shoukaku call this field `position` (milliseconds). Using an
        // invented `startTime` key silently starts from zero after a restart.
        // Start the recovered current track before adding upcoming items because
        // queue.add() on an empty player promotes its first item to queue.current.
        await player.play(startTrack, { replaceCurrent: true, position: Math.max(0, startPosition) });
        if (restoredUpcoming.length) queueTracks(player, restoredUpcoming);
        const loop = ['none', 'track', 'queue'].includes(session.loopMode) ? session.loopMode : 'none';
        player.setLoop(loop);
        let autoplay = ['off', 'standard', 'ai'].includes(session.autoplayMode) ? session.autoplayMode : 'off';
        if (autoplay === 'ai' && !gemini?.enabled) autoplay = 'off';
        setAutoplayMode(player.guildId, autoplay);
        const volume = Math.max(0, Math.min(100, Number(session.volumePercent ?? getStoredVolume(player.guildId, config.defaultVolume))));
        await player.setVolume(volume);
        setStoredVolume(player.guildId, Math.round(volume));
        if (session.paused) await setPlayerPaused(player, true);
        scheduleRecoverySave(player, 0);
      });

      // The saved record is now represented by the live player. The live
      // checkpoint immediately replaces it; deleting first avoids a stale record
      // if background resolution later fails.
      deleteRecoverySession(guildId);
      checkpointRecovery(player);

      const tail = rows.slice(RECOVERY_SYNC_BATCH);
      if (tail.length) void restoreRecoveryTail(player, tail, requester, revision);
      return {
        current: player.queue.current,
        restoredNow: Number(player.queue.length || 0),
        restoring: tail.length,
        savedTotal: rows.length,
      };
    } finally {
      recoveryResumes.delete(guildId);
    }
  }

  function checkpointAllRecoveries() {
    for (const player of music.players.values()) checkpointRecovery(player);
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
    const fallback = playbackFallbackHolds.get(guildId);
    if (fallback) fallback.resolveSettled?.();
    playbackFallbackHolds.delete(guildId);
    playbackFallbackAttempts.delete(guildId);
    clearSourceRetry(guildId);
    clearSourceSuccess(guildId);
    if (resetHealth) playbackFailures.delete(guildId);
    return removed;
  }

  function getSourceHealth(guildId) {
    const state = playbackFailures.get(guildId);
    // A live alternate-source attempt is more actionable than an older healthy
    // failure counter. Always surface it while the temporary queue hold exists.
    if (playbackFallbackHolds.has(guildId)) return {
      status: 'fallback',
      failures: state?.times?.length || 0,
      retryAt: 0,
      lastError: state?.lastError || '',
      held: getHeldQueueCount(guildId),
    };
    if (!state) return {
      status: 'healthy',
      failures: 0,
      retryAt: 0,
      lastError: '',
      held: getHeldQueueCount(guildId),
    };
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
      try {
        await withGuildOperation(guildId, async () => {
          if (music.players.get(guildId) !== player) return;
          const result = queueTracks(player, held);
          const recovering = playbackFailures.get(guildId) || { times: [] };
          recovering.status = 'recovering';
          recovering.times = [];
          recovering.retryAt = 0;
          playbackFailures.set(guildId, recovering);
          console.warn(`[source-protection] retrying ${result.added.length} preserved track(s) for ${guildId}`);
          if (!result.added.length) return setHealthy(guildId);
          await player.play();
          checkpointRecovery(player);
        });
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
    scheduleRecoverySave(player, 0);

    if (stopCurrent) {
      if (player.queue.current) void stopPlayerTrack(player).catch((error) => console.warn('[source-protection] stop failed', error?.message || error));
    }
    scheduleSourceRetry(player);
  }

  function recordPlaybackFailure(player, message, { skipCurrent = true, trackOverride = null } = {}) {
    const guildId = player.guildId;
    clearSourceSuccess(guildId);
    const now = Date.now();
    const track = trackOverride || player.queue.current;
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
          void stopPlayerTrack(player).catch((error) => console.warn('[source-protection] stop failed', error?.message || error));
        }
      } catch (error) { console.warn('[source-protection] stop scheduling failed', error?.message || error); }
    }
    return state;
  }

  function beginPlaybackFallbackHold(player, failedTrack) {
    const guildId = player?.guildId;
    const failedId = youtubeTrackId(failedTrack);
    const title = playbackFallbackQuery(failedTrack);
    if (!guildId || !failedId || !title || failedTrack?._ezPlaybackFallback) return null;
    if (playbackFallbackHolds.has(guildId)) return null;

    let resolveSettled;
    const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });
    const state = {
      failedId,
      revision: getQueueRevision(guildId),
      settled: false,
      settledPromise,
      resolveSettled,
    };
    playbackFallbackHolds.set(guildId, state);

    const upcoming = takeFallbackQueueHold(player.queue);
    if (upcoming.length) {
      const existing = heldQueues.get(guildId) || [];
      heldQueues.set(guildId, [...existing, ...upcoming].slice(0, MAX_UPCOMING_QUEUE));
    }
    scheduleRecoverySave(player, 0);
    return state;
  }

  function settlePlaybackFallbackHold(player) {
    const state = playbackFallbackHolds.get(player?.guildId);
    if (!state) return false;
    state.settled = true;
    state.resolveSettled?.();
    return true;
  }

  async function waitForPlaybackFallbackSlot(player, state) {
    if (!state || playbackFallbackHolds.get(player.guildId) !== state) return false;
    const currentId = youtubeTrackId(player.queue.current);
    if (state.settled || !player.queue.current || currentId !== state.failedId) return true;

    let timer;
    try {
      await Promise.race([
        state.settledPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, PLAYBACK_FALLBACK_SETTLE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (playbackFallbackHolds.get(player.guildId) !== state) return false;
    const afterId = youtubeTrackId(player.queue.current);
    return state.settled || !player.queue.current || afterId !== state.failedId;
  }

  function releasePlaybackFallbackHold(player, state, { restore = true } = {}) {
    const guildId = player?.guildId;
    if (!guildId || playbackFallbackHolds.get(guildId) !== state) return { released: false, restored: 0 };
    playbackFallbackHolds.delete(guildId);
    state.resolveSettled?.();

    let restored = 0;
    if (restore) {
      const held = heldQueues.get(guildId) || [];
      heldQueues.delete(guildId);
      restored = restoreFallbackQueue(player.queue, held);
    }
    scheduleRecoverySave(player, 0);
    return { released: true, restored };
  }

  async function cancelPlaybackFallbackForSkip(player) {
    const state = playbackFallbackHolds.get(player?.guildId);
    if (!state) return false;
    const failedStillCurrent = Boolean(player.queue.current) && youtubeTrackId(player.queue.current) === state.failedId;
    playbackFallbackAttempts.delete(player.guildId);
    releasePlaybackFallbackHold(player, state, { restore: true });

    if (failedStillCurrent && player.queue.current) {
      if (player.loop !== 'none') player.setLoop('none');
      await stopPlayerTrack(player);
    } else if (player.queue.current && !player.playing && !player.paused && !player.shoukaku?.paused) {
      await player.play();
    }
    checkpointRecovery(player);
    return true;
  }

  async function withFallbackTimeout(promise, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function tryYoutubePlaybackFallback(player, failedTrack, message, state) {
    const guildId = player?.guildId;
    const failedId = youtubeTrackId(failedTrack);
    const title = playbackFallbackQuery(failedTrack);
    if (!guildId || !failedId || !title || failedTrack?._ezPlaybackFallback) return false;
    if (!state || playbackFallbackHolds.get(guildId) !== state) return false;

    const fingerprint = `youtube:${failedId}:${title.toLowerCase()}`;
    const previous = playbackFallbackAttempts.get(guildId);
    if (previous?.fingerprint === fingerprint && Date.now() - previous.at < PLAYBACK_FALLBACK_WINDOW_MS) return false;
    playbackFallbackAttempts.set(guildId, { fingerprint, at: Date.now() });

    try {
      const result = await withFallbackTimeout(
        player.search(title, { requester: failedTrack?.requester || client.user, source: 'ytsearch:' }),
        PLAYBACK_FALLBACK_SEARCH_TIMEOUT_MS,
        'alternate YouTube search',
      );
      const alternative = choosePlaybackAlternative(title, result?.tracks, failedTrack);
      if (!alternative) return false;
      if (!(await waitForPlaybackFallbackSlot(player, state))) return false;

      return await withGuildOperation(guildId, async () => {
        if (music.players.get(guildId) !== player || playbackFallbackHolds.get(guildId) !== state || !isQueueRevisionCurrent(guildId, state.revision)) return false;
        if (player.paused || player.shoukaku?.paused) return false;
        const current = player.queue.current;
        const currentId = youtubeTrackId(current);
        if (current && currentId !== failedId) return false;
        try { alternative._ezPlaybackFallback = true; } catch { /* track may be sealed */ }
        console.warn(`[playback-fallback] ${guildId}: ${failedTrack.title} failed (${String(message || 'source error').slice(0, 120)}); retrying ${alternative.title} — ${alternative.author || 'Unknown'}`);
        await player.play(alternative, { replaceCurrent: true });
        releasePlaybackFallbackHold(player, state, { restore: true });
        // A successful substitution is not a retry storm. Allow the same source
        // item to fall back again immediately if it legitimately appears twice.
        playbackFallbackAttempts.delete(guildId);
        checkpointRecovery(player);
        return true;
      });
    } catch (error) {
      console.warn('[playback-fallback] alternate video retry failed', error?.message || error);
      return false;
    }
  }

  async function trySoundCloudPlaybackFallback(player, failedTrack, message, state) {
    const guildId = player?.guildId;
    const failedId = youtubeTrackId(failedTrack);
    const queries = playbackFallbackQueries(failedTrack);
    if (!guildId || !failedId || !queries.length || failedTrack?._ezPlaybackFallback) return false;
    if (!state || playbackFallbackHolds.get(guildId) !== state) return false;

    const fingerprint = `soundcloud:${failedId}:${queries[0].toLowerCase()}`;
    const previous = playbackFallbackAttempts.get(guildId);
    if (previous?.fingerprint === fingerprint && Date.now() - previous.at < PLAYBACK_FALLBACK_WINDOW_MS) return false;
    playbackFallbackAttempts.set(guildId, { fingerprint, at: Date.now() });

    const deadline = Date.now() + PLAYBACK_FALLBACK_SEARCH_TIMEOUT_MS;
    let alternative = null;
    let matchedQuery = '';
    for (const query of queries) {
      if (playbackFallbackHolds.get(guildId) !== state) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const result = await withFallbackTimeout(
          player.search(query, { requester: failedTrack?.requester || client.user, source: 'scsearch:' }),
          Math.min(3_000, remaining),
          'SoundCloud search',
        );
        alternative = chooseSoundCloudAlternative(query, result?.tracks, failedTrack);
        if (alternative) {
          matchedQuery = query;
          break;
        }
      } catch (error) {
        console.warn(`[playback-fallback] SoundCloud query failed (${query})`, error?.message || error);
      }
    }
    if (!alternative) return false;
    if (!(await waitForPlaybackFallbackSlot(player, state))) return false;

    try {
      return await withGuildOperation(guildId, async () => {
        if (music.players.get(guildId) !== player || playbackFallbackHolds.get(guildId) !== state || !isQueueRevisionCurrent(guildId, state.revision)) return false;
        if (player.paused || player.shoukaku?.paused) return false;
        const current = player.queue.current;
        const currentId = youtubeTrackId(current);
        if (current && currentId !== failedId) return false;
        try { alternative._ezPlaybackFallback = true; } catch { /* track may be sealed */ }
        console.warn(`[playback-fallback] ${guildId}: YouTube unavailable for ${failedTrack.title}; using SoundCloud ${alternative.title} — ${alternative.author || 'Unknown'} via "${matchedQuery}" (${String(message || 'source error').slice(0, 100)})`);
        await player.play(alternative, { replaceCurrent: true });
        releasePlaybackFallbackHold(player, state, { restore: true });
        // A successful substitution is not a retry storm. Allow the same source
        // item to fall back again immediately if it legitimately appears twice.
        playbackFallbackAttempts.delete(guildId);
        checkpointRecovery(player);
        return true;
      });
    } catch (error) {
      console.warn('[playback-fallback] SoundCloud retry failed', error?.message || error);
      return false;
    }
  }

  async function finishPlaybackFallbackFailure(player, failedTrack, message, state) {
    if (!state || playbackFallbackHolds.get(player.guildId) !== state) return false;
    const current = player.queue.current;
    const currentId = youtubeTrackId(current);
    const userMovedToDifferentCurrent = Boolean(current) && currentId !== state.failedId;
    const failureState = recordPlaybackFailure(player, message, {
      skipCurrent: !userMovedToDifferentCurrent,
      trackOverride: failedTrack,
    });

    if (failureState.status === 'degraded') {
      // openSourceCircuit deliberately keeps heldQueues intact for its one-minute
      // retry. Only remove the temporary fallback marker here.
      if (playbackFallbackHolds.get(player.guildId) === state) {
        playbackFallbackHolds.delete(player.guildId);
        state.resolveSettled?.();
      }
      scheduleRecoverySave(player, 0);
      return true;
    }

    releasePlaybackFallbackHold(player, state, { restore: true });
    const after = player.queue.current;
    const afterId = youtubeTrackId(after);
    if (!userMovedToDifferentCurrent && after && afterId !== state.failedId && !player.playing && !player.paused && !player.shoukaku?.paused) {
      await player.play();
    }
    checkpointRecovery(player);
    return true;
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

  async function evaluateVoiceOccupancy(player) {
    if (!player || music.players.get(player.guildId) !== player) return;
    const guildId = player.guildId;
    const hasHuman = hasHumanListener(player);
    const transition = emptyVoiceTransition({
      hasHuman,
      hasCurrentTrack: Boolean(player.queue.current),
      playing: Boolean(player.playing),
      paused: Boolean(player.paused),
      autoPaused: emptyVoiceAutoPaused.has(guildId),
    });

    if (hasHuman) {
      clearEmptyVoiceTimer(guildId);
      const wasAutoPaused = emptyVoiceAutoPaused.delete(guildId);
      if (transition === 'resume' && wasAutoPaused) {
        try {
          await setPlayerPaused(player, false);
          scheduleRecoverySave(player, 0);
          console.log(`[voice] human listener returned; auto-resumed ${guildId}`);
          if (!hasHumanListener(player)) await evaluateVoiceOccupancy(player);
        } catch (error) {
          emptyVoiceAutoPaused.add(guildId);
          console.warn('[voice] auto-resume failed', error?.message || error);
        }
      }
      return;
    }

    if (transition === 'pause') {
      try {
        await setPlayerPaused(player, true);
        if (hasHumanListener(player)) {
          await setPlayerPaused(player, false);
          emptyVoiceAutoPaused.delete(guildId);
          scheduleRecoverySave(player, 0);
          return;
        }
        emptyVoiceAutoPaused.add(guildId);
        scheduleRecoverySave(player, 0);
        console.log(`[voice] channel empty; auto-paused ${guildId}`);
      } catch (error) {
        emptyVoiceAutoPaused.delete(guildId);
        console.warn('[voice] auto-pause failed', error?.message || error);
      }
    }

    if (emptyVoiceTimers.has(guildId)) return;
    const timer = setTimeout(async () => {
      emptyVoiceTimers.delete(guildId);
      if (music.players.get(guildId) !== player || hasHumanListener(player)) {
        await evaluateVoiceOccupancy(player);
        return;
      }
      emptyVoiceAutoPaused.delete(guildId);
      console.log(`[voice] no human listeners for 2 minutes; disconnecting ${guildId}`);
      invalidateQueueWork(guildId);
      setAutoplayMode(guildId, 'off');
      discardHeldQueue(guildId);
      clearRecoverySession(guildId);
      try { player.queue.clear(); } catch { /* player may already be tearing down */ }
      try { await player.destroy(); } catch (error) { console.warn('[voice] auto-leave failed', error?.message || error); }
    }, EMPTY_VOICE_GRACE_MS);
    timer.unref?.();
    emptyVoiceTimers.set(guildId, timer);
  }

  client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;
    const player = guildId ? music.players.get(guildId) : null;
    if (!player) return;

    // Shoukaku consumes raw VOICE_STATE_UPDATE packets and follows external bot
    // moves, but Kazagumo's wrapper voiceId is not updated by that path. Keep EZ's
    // wrapper/cache synchronized with the state Discord already accepted instead
    // of sending a second move request back to Discord.
    if (oldState.id === client.user?.id) {
      const botTransition = voiceChannelTransition(oldState.channelId, newState.channelId);
      if (botTransition.kind === 'left') {
        void retirePlayerForTransportLoss(player, 'Discord moved bot out of voice').catch((error) => {
          console.warn('[voice] external disconnect cleanup failed', error?.message || error);
        });
        return;
      }
      if (botTransition.kind === 'moved' || botTransition.kind === 'joined') {
        const previousVoiceId = botTransition.from;
        player.voiceId = botTransition.to;
        voiceIds.set(guildId, botTransition.to);
        clearVoiceCloseRecoveryTimer(guildId);
        scheduleRecoverySave(player, 0);

        if (previousVoiceId && previousVoiceId !== botTransition.to) {
          void client.rest.put(`/channels/${previousVoiceId}/voice-status`, { body: { status: null } }).catch(() => {});
        }
        if (player.queue.current) void setVoiceStatus(player, player.queue.current);
        void evaluateVoiceOccupancy(player).catch((error) => console.warn('[voice] occupancy evaluation failed', error?.message || error));
        return;
      }
    }

    const voiceId = player.voiceId || voiceIds.get(guildId);
    if (!voiceId || (oldState.channelId !== voiceId && newState.channelId !== voiceId)) return;
    void evaluateVoiceOccupancy(player).catch((error) => console.warn('[voice] occupancy evaluation failed', error?.message || error));
  });

  function lavalinkBaseUrl() {
    const raw = String(config.lavalinkUrl || 'localhost:2333').replace(/^https?:\/\//i, '');
    return `${config.lavalinkSecure ? 'https' : 'http'}://${raw}`;
  }

  async function getRuntimeStats() {
    const node = process.memoryUsage();
    let lavalink = null;
    let liveStats = null;
    try {
      const nodes = music.shoukaku?.nodes;
      const candidates = typeof nodes?.values === 'function' ? [...nodes.values()] : [];
      liveStats = candidates.find((candidate) => candidate?.stats)?.stats || null;
    } catch { /* live WebSocket stats are optional diagnostics */ }
    try {
      const response = await fetch(`${lavalinkBaseUrl()}/v4/stats`, {
        headers: { Authorization: config.lavalinkPassword },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) lavalink = await response.json();
    } catch { /* status remains useful even if stats endpoint is temporarily unavailable */ }

    // Lavalink intentionally omits frameStats from GET /v4/stats. Shoukaku keeps
    // the latest WebSocket stats payload, so merge those frame/CPU counters into
    // the REST snapshot without adding another connection or monitoring service.
    if (liveStats) {
      lavalink = lavalink
        ? { ...lavalink, cpu: liveStats.cpu || lavalink.cpu, frameStats: liveStats.frameStats ?? null }
        : { ...liveStats };
    }

    return {
      node: { rss: node.rss, heapUsed: node.heapUsed, heapTotal: node.heapTotal },
      lavalink,
      lavalinkNode: getLavalinkNodeHealth(),
      queueLimit: MAX_UPCOMING_QUEUE,
    };
  }

  // A persisted AI mode must not survive a restart where Gemini was removed.
  if (!gemini?.enabled && getAutoplayMode(config.discordGuildId) === 'ai') {
    setAutoplayMode(config.discordGuildId, 'off');
  }

  music.shoukaku.on('ready', (name, resumed, libraryResumed = false) => {
    console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`);
    if (name !== LAVALINK_NODE_NAME) return;
    const hadReady = localNodeEverReady;
    localNodeEverReady = true;
    localNodeState = 'connected';
    localNodeLastError = '';
    localNodeReconnectAttempt = 0;
    clearLocalNodeReconnectTimer();

    // A websocket reconnect can succeed while the Lavalink *server session* was
    // lost (for example Lavalink.jar restarted). Server-side resume=false means
    // the cached Kazagumo players no longer exist remotely. Retire them instead
    // of letting /play or /nowplaying operate on ghosts.
    if (hadReady && !resumed && !libraryResumed) {
      void retirePlayersForNodeLoss('Lavalink reconnected with a fresh session; previous remote players no longer exist');
    }
  });
  music.shoukaku.on('reconnecting', (name, left, interval) => {
    if (name === LAVALINK_NODE_NAME) localNodeState = 'reconnecting';
    console.warn(`[lavalink] ${name} reconnecting (${left} library attempt${left === 1 ? '' : 's'} left, ${interval}s interval)`);
  });
  music.shoukaku.on('error', (name, error) => {
    console.error(`[lavalink] ${name}`, error);
    if (name !== LAVALINK_NODE_NAME) return;
    localNodeLastError = String(error?.message || error).slice(0, 500);
    const node = music.shoukaku.nodes.get(name);
    if (!node || node.state === Constants.State.DISCONNECTED) {
      localNodeState = 'unavailable';
      void retirePlayersForNodeLoss(`Lavalink node disconnected: ${localNodeLastError}`);
      scheduleLocalNodeReplacement(localNodeLastError);
    }
  });
  music.shoukaku.on('close', (name, code, reason) => {
    console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`);
    if (name !== LAVALINK_NODE_NAME) return;
    localNodeState = 'reconnecting';
    localNodeLastError = `websocket closed ${code}: ${reason || 'no reason'}`;
    // Persist before Shoukaku attempts session resume. A successful first retry
    // continues normally; a failed retry can then retire the player safely.
    checkpointAllRecoveries();
  });

  music.on('playerStart', (player, track) => {
    void handlePlayerStart(player, track).catch((error) => console.warn('[player-start]', error?.message || error));
  });

  music.on('queueUpdate', (player) => scheduleRecoverySave(player));

  music.on('playerUpdate', (player, data) => {
    if (data?.state?.connected) clearVoiceCloseRecoveryTimer(player.guildId);
    commitPendingPlaybackHistory(player);
    const now = Date.now();
    const last = recoveryPositionSavedAt.get(player.guildId) || 0;
    if (now - last < RECOVERY_POSITION_SAVE_MS || !player.queue.current) return;
    recoveryPositionSavedAt.set(player.guildId, now);
    try { updateRecoveryPosition(player.guildId, Number(player.position || 0), Boolean(player.paused)); }
    catch (error) { console.warn('[recovery] position checkpoint failed', error?.message || error); }
  });

  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    const failedTrack = resolveLifecycleEventTrack(data?.track, player.queue.current, lastTracks.get(player.guildId) || null);
    if (!failedTrack) {
      console.warn('[player-exception]', player.guildId, 'stale track event ignored:', message);
      return;
    }
    const failedId = youtubeTrackId(failedTrack);
    clearPendingPlaybackHistory(player.guildId, failedTrack);
    console.warn('[player-exception]', player.guildId, message);

    const existingHold = playbackFallbackHolds.get(player.guildId);
    if (existingHold && existingHold.failedId === failedId) return;
    if (existingHold) releasePlaybackFallbackHold(player, existingHold, { restore: true });

    const fallbackState = beginPlaybackFallbackHold(player, failedTrack);
    if (!fallbackState) {
      recordPlaybackFailure(player, message, { trackOverride: failedTrack });
      return;
    }

    void (async () => {
      const credentiallessBlock = isCredentiallessYoutubeBlock(message);
      if (!credentiallessBlock && await tryYoutubePlaybackFallback(player, failedTrack, message, fallbackState)) return;
      if (await trySoundCloudPlaybackFallback(player, failedTrack, message, fallbackState)) return;
      await finishPlaybackFallbackFailure(player, failedTrack, message, fallbackState);
    })().catch(async (error) => {
      console.warn('[player-exception] fallback handler failed', error?.message || error);
      await finishPlaybackFallbackFailure(player, failedTrack, message, fallbackState).catch((finishError) => {
        console.warn('[player-exception] fallback cleanup failed', finishError?.message || finishError);
      });
    });
  });

  music.on('playerResolveError', (player, track, message) => {
    const detail = message || `could not resolve ${track?.title || 'track'}`;
    console.warn('[player-resolve-error]', player.guildId, detail);
    // Kazagumo advances a resolve failure itself after this synchronous event.
    recordPlaybackFailure(player, detail, { skipCurrent: false });
  });

  music.on('playerStuck', (player, data) => {
    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;
    const failedTrack = resolveLifecycleEventTrack(data?.track, player.queue.current, lastTracks.get(player.guildId) || null);
    if (!failedTrack) {
      console.warn('[player-stuck]', player.guildId, 'stale track event ignored:', message);
      return;
    }
    clearPendingPlaybackHistory(player.guildId, failedTrack);
    console.warn('[player-stuck]', player.guildId, message);
    recordPlaybackFailure(player, message, { trackOverride: failedTrack });
  });

  music.on('playerClosed', (player, data) => {
    void handlePlayerClosed(player, data).catch((error) => console.warn('[player-closed]', error?.message || error));
  });

  music.on('playerEmpty', (player) => {
    void handlePlayerEmpty(player).catch((error) => console.warn('[player-empty]', error?.message || error));
  });

  music.on('playerDestroy', (player) => {
    void handlePlayerDestroy(player).catch((error) => console.warn('[player-destroy]', error?.message || error));
  });

  async function handlePlayerClosed(player, data) {
    if (!player || music.players.get(player.guildId) !== player || !player.voiceId) return;
    const code = Number(data?.code || 0);
    const reason = String(data?.reason || 'voice websocket closed');
    console.warn(`[voice] Discord voice websocket closed for ${player.guildId}: ${code || 'unknown'} ${reason}`);
    clearPendingPlaybackHistory(player.guildId);
    checkpointRecovery(player);
    clearVoiceCloseRecoveryTimer(player.guildId);

    if (voiceCloseDisposition(code) === 'retire') {
      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);
      return;
    }

    // Some transient voice closes recover inside Lavalink/Koe. Give that path a
    // short chance and cancel this watchdog as soon as a connected playerUpdate
    // arrives. If it never does, preserve recovery and retire the stale wrapper.
    const timer = setTimeout(() => {
      voiceCloseRecoveryTimers.delete(player.guildId);
      if (music.players.get(player.guildId) !== player || !player.voiceId) return;
      void retirePlayerForTransportLoss(player, `Discord voice did not recover after close ${code}: ${reason}`);
    }, VOICE_CLOSE_RECOVERY_GRACE_MS);
    timer.unref?.();
    voiceCloseRecoveryTimers.set(player.guildId, timer);
  }

  async function handlePlayerStart(player, track) {
    // Kazagumo emits queue.current for playerStart instead of the TrackStartEvent
    // payload. A late start from a replaced track can therefore be mislabeled as
    // the newer queue.current. Shoukaku keeps the actual encoded Lavalink track;
    // reject any mismatch before it can pollute history/status/recovery state.
    if (!activeTrackMatchesCurrent(player)) {
      console.warn('[player-start]', player.guildId, 'stale/mismatched TrackStart ignored');
      return;
    }
    clearDisconnect(player.guildId);
    clearEmptyVoiceTimer(player.guildId);
    clearVoiceCloseRecoveryTimer(player.guildId);
    scheduleSourceSuccess(player, track);
    lastTracks.set(player.guildId, track);
    if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    // Lavalink emits TrackStart before the executor proves it can actually read
    // audio. Stage history here and commit it on a later playerUpdate only after
    // the track has made real progress, so login/SABR failures never pollute
    // Recent History as if they were heard successfully.
    stagePlaybackHistory(player, track);
    await setVoiceStatus(player, track);
    scheduleRecoverySave(player, 0);
    await evaluateVoiceOccupancy(player);
  }

  async function handlePlayerEmpty(player) {
    clearPendingPlaybackHistory(player.guildId);
    // No current track means an empty-room pause marker can no longer refer to
    // a resumable item. A future playerStart will reevaluate occupancy itself.
    emptyVoiceAutoPaused.delete(player.guildId);
    // Kazagumo can leave its paused flag set when a paused track is skipped or
    // stopped. Normalize both the wrapper and Lavalink state before any future
    // autoplay/new play request so an old pause cannot silently block playback.
    if (player.paused || player.shoukaku?.paused) {
      try { await player.shoukaku.setPaused(false); }
      catch (error) { console.warn('[player-empty] unable to reset paused state', error?.message || error); }
      player.paused = false;
    }
    player.playing = false;

    // A YouTube executor failure intentionally parks upcoming work while the
    // SoundCloud fallback search runs. Do not treat that brief empty event as a
    // naturally finished queue or start autoplay/disconnect logic.
    if (playbackFallbackHolds.has(player.guildId)) {
      settlePlaybackFallbackHold(player);
      scheduleRecoverySave(player, 0);
      return;
    }

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
      if (!player.queue.current && player.queue.isEmpty && !getHeldQueueCount(player.guildId)) clearRecoverySession(player.guildId);
      else scheduleRecoverySave(player, 0);
      scheduleDisconnect(player);
    } else if (filled) {
      scheduleRecoverySave(player, 0);
    }
  }

  async function handlePlayerDestroy(player) {
    // Never allow an old /play, /ai or /radio request to enqueue into a player
    // that has already been destroyed/recreated.
    invalidateQueueWork(player.guildId);
    clearDisconnect(player.guildId);
    clearEmptyVoiceTimer(player.guildId);
    clearVoiceCloseRecoveryTimer(player.guildId);
    emptyVoiceAutoPaused.delete(player.guildId);
    clearSourceSuccess(player.guildId);
    clearRecoverySaveTimer(player.guildId);
    recoveryPositionSavedAt.delete(player.guildId);
    clearPendingPlaybackHistory(player.guildId);
    const fallback = playbackFallbackHolds.get(player.guildId);
    if (fallback) fallback.resolveSettled?.();
    playbackFallbackHolds.delete(player.guildId);
    playbackFallbackAttempts.delete(player.guildId);
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
        // A naturally finished healthy queue has nothing useful to recover. If
        // the source circuit is still holding tracks, keep the SQLite recovery
        // snapshot even if the idle player is eventually destroyed.
        const health = getSourceHealth(player.guildId);
        if (health.status === 'healthy' && !getHeldQueueCount(player.guildId)) clearRecoverySession(player.guildId);
        else checkpointRecovery(player);
        player.destroy().catch((error) => console.warn('[idle-disconnect]', error?.message || error));
      }
    }, config.autoDisconnectMinutes * 60_000);
    timer.unref?.();
    disconnectTimers.set(player.guildId, timer);
  }

  async function ensurePlayer(interaction) {
    const voice = interaction.member?.voice?.channel;
    if (!voice) throw new Error('Join a voice channel first.');

    const nodeHealth = getLavalinkNodeHealth();
    if (nodeHealth.status !== 'connected') {
      const retrySeconds = nodeHealth.retryAt > Date.now() ? Math.max(1, Math.ceil((nodeHealth.retryAt - Date.now()) / 1000)) : 0;
      throw queueCanceledError(`Lavalink is ${nodeHealth.status === 'reconnecting' ? 'reconnecting' : 'temporarily unavailable'}${retrySeconds ? `; retrying in about ${retrySeconds}s` : ''}. Your saved recovery queue is preserved.`);
    }

    const sourceHealth = getSourceHealth(interaction.guildId);
    if (sourceHealth.status === 'degraded' || sourceHealth.status === 'recovering') {
      const wait = sourceHealth.retryAt > Date.now() ? Math.ceil((sourceHealth.retryAt - Date.now()) / 1000) : 0;
      throw queueCanceledError(`Playback source protection is ${sourceHealth.status}. ${sourceHealth.held || 0} queued track(s) are preserved${wait ? `; automatic retry in about ${wait}s` : ''}.`);
    }

    let player = music.players.get(interaction.guildId);
    if (!player) {
      // Two slash commands can arrive while the voice connection is still being
      // created. Collapse them onto one creation promise so we never race two
      // Shoukaku/Kazagumo connections for the same guild.
      let creating = playerCreationPromises.get(interaction.guildId);
      if (!creating) {
        creating = (async () => {
          const existing = music.players.get(interaction.guildId);
          if (existing) return existing;
          return music.createPlayer({
            guildId: interaction.guildId,
            textId: interaction.channelId,
            voiceId: voice.id,
            deaf: true,
            volume: getStoredVolume(interaction.guildId, config.defaultVolume),
          });
        })();
        playerCreationPromises.set(interaction.guildId, creating);
        creating.finally(() => {
          if (playerCreationPromises.get(interaction.guildId) === creating) playerCreationPromises.delete(interaction.guildId);
        }).catch(() => {});
      }
      player = await creating;
      if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    }

    // This check also handles two simultaneous first-use commands issued from
    // different voice channels: whichever creates the player wins; the other
    // request is rejected instead of silently moving the bot.
    if (player.voiceId && player.voiceId !== voice.id) throw new Error('Join the same voice channel as the bot first.');
    player.setTextChannel(interaction.channelId);

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
      const results = await Promise.all(batch.map((query) => searchPreferred(player, query, requester).catch(() => null)));
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
      const fallback = await searchPreferred(player, fallbackQuery, requester).catch(() => null);
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
      return withGuildOperation(player.guildId, async () => {
        if (getAutoplayMode(player.guildId) !== mode || !queueRequestStillValid(player, revision)) return false;
        const queued = queueTracks(player, tracks);
        if (!queued.added.length) return false;
        if (!player.playing && !player.paused) await player.play();
        scheduleRecoverySave(player);
        return true;
      });
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
    return withGuildOperation(player.guildId, async () => {
      if (!queueRequestStillValid(player, revision)) throw queueCanceledError('Server radio was canceled because the queue changed.');
      const queued = queueTracks(player, picked);
      if (!queued.added.length) throw new Error(`Queue is full (maximum ${MAX_UPCOMING_QUEUE} upcoming tracks).`);
      if (!player.playing && !player.paused) await player.play();
      scheduleRecoverySave(player);
      return queued.added.length;
    });
  }

  function setGuildAutoplay(guildId, mode) {
    if (mode === 'ai' && !gemini?.enabled) throw new Error('Gemini is not configured, so AI autoplay cannot be enabled.');
    setAutoplayMode(guildId, mode);
    const player = music.players.get(guildId);
    if (player) scheduleRecoverySave(player);
    return mode;
  }

  function getGuildVolume(guildId) {
    return getStoredVolume(guildId, config.defaultVolume);
  }

  function setGuildVolume(guildId, volume) {
    const saved = setStoredVolume(guildId, volume);
    const player = music.players.get(guildId);
    if (player) scheduleRecoverySave(player);
    return saved;
  }

  return {
    music,
    ensurePlayer,
    startServerRadio,
    setGuildAutoplay,
    getGuildAutoplay: getAutoplayMode,
    searchPreferred,
    isSpotifyConfigured: () => spotifyConfigured,
    getGuildVolume,
    setGuildVolume,
    getQueueRevision,
    invalidateQueueWork,
    isQueueRevisionCurrent,
    queueTracks,
    getQueueLimit: () => MAX_UPCOMING_QUEUE,
    getRuntimeStats,
    getSourceHealth,
    getLavalinkNodeHealth,
    isAutoPausedForEmptyVoice: (guildId) => emptyVoiceAutoPaused.has(guildId),
    getHeldQueueCount,
    discardHeldQueue,
    getHeldQueueSnapshot,
    withGuildOperation,
    checkpointRecovery,
    checkpointAllRecoveries,
    clearRecoverySession,
    getRecoverableSession,
    resumeRecoverySession,
    cancelPlaybackFallbackForSkip,
  };
}
