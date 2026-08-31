from pathlib import Path
import json


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, value):
    Path(path).write_text(value, encoding='utf-8')


def replace_exact(text, before, after, label):
    if before not in text:
        raise RuntimeError(f'Missing patch target: {label}')
    return text.replace(before, after, 1)


write('src/playback-fallback.js', r'''import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

export function youtubeTrackId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

function normalizeWords(value) {
  return String(value || '')
    .replace(/[()[\]{}“”"']/g, ' ')
    .replace(/\s*[-–—|•]\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function playbackFallbackQuery(track) {
  return normalizeWords(String(track?.title || '')
    .replace(/\bM\s*\/\s*V\b/gi, ' ')
    .replace(/\b(?:official\s+)?(?:music\s+)?video\b/gi, ' ')
    .replace(/\bcolor\s+coded\s+lyrics?\b/gi, ' ')
    .replace(/\blyric\s+video\b/gi, ' ')
    .replace(/\blyrics?\b/gi, ' ')
    .replace(/\b(?:official\s+)?audio\b/gi, ' '));
}

function conciseFallbackText(value) {
  return normalizeWords(String(value || '')
    .replace(/\b(?:one\s+piece\s+film\s*:?\s*red|film\s*:?\s*red)\b/gi, ' ')
    .replace(/\b(?:original\s+soundtrack|soundtrack|ost|lirik|terjemahan|translation|subtitles?)\b/gi, ' ')
    .replace(/\s+from\s*$/gi, ' ')
    .replace(/\s*[|•]+\s*/g, ' '));
}

function usefulAuthor(author) {
  const value = normalizeWords(String(author || '').replace(/\s*-\s*Topic\s*$/i, ' '));
  if (!value || /^(?:unknown|various artists?)$/i.test(value)) return '';
  if (/\b(?:lyrics?|lirik|terjemahan|translation|karaoke)\b/i.test(value)) return '';
  return value;
}

export function playbackFallbackQueries(track) {
  const broad = playbackFallbackQuery(track);
  if (!broad) return [];

  const candidates = [];
  const add = (value) => {
    const clean = conciseFallbackText(value);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!candidates.some((item) => item.toLowerCase() === key)) candidates.push(clean);
  };

  // Common upload title: "New Genesis by Ado × Yasutaka Nakata from ...".
  // For alternate-source search, the primary artist + song is much stronger than
  // preserving franchise/translator/uploader decoration.
  const byMatch = broad.match(/^(.+?)\s+by\s+(.+?)(?:\s+from\s+.+)?$/i);
  if (byMatch) {
    const song = conciseFallbackText(byMatch[1]);
    const artist = conciseFallbackText(byMatch[2].split(/[×|,&]/)[0]);
    if (song && artist) add(`${artist} ${song}`);
  }

  const compact = conciseFallbackText(broad);
  const dashMatch = compact.match(/^([^\-–—]{1,45})\s*[-–—]\s*(.+)$/);
  if (dashMatch) add(`${dashMatch[1]} ${dashMatch[2]}`);

  const author = usefulAuthor(track?.author);
  if (author && compact && !compact.toLowerCase().includes(author.toLowerCase())) add(`${author} ${compact}`);

  add(compact);
  add(broad);
  return candidates.slice(0, 3);
}

export function isCredentiallessYoutubeBlock(message) {
  const value = String(message || '');
  return /all clients failed to load the item|this video requires login|sign in to confirm you.?re not a bot|no supported audio streams available|video player configuration error|must find sig function from script/i.test(value);
}

function durationCompatible(failedTrack, candidate) {
  const failed = Number(failedTrack?.length || 0);
  const next = Number(candidate?.length || 0);
  if (!failed || !next) return true;
  if (failed >= 120_000 && next < 60_000) return false;
  return Math.abs(next - failed) <= Math.max(120_000, failed * 0.55);
}

function sameUri(a, b) {
  const left = String(a?.uri || a?.realUri || '').trim();
  const right = String(b?.uri || b?.realUri || '').trim();
  return Boolean(left && right && left === right);
}

export function choosePlaybackAlternative(query, tracks, failedTrack) {
  const failedId = youtubeTrackId(failedTrack);
  for (const candidate of Array.isArray(tracks) ? tracks : []) {
    if (!candidate || candidate?.isStream) continue;
    const candidateId = youtubeTrackId(candidate);
    if (!candidateId || (failedId && candidateId === failedId)) continue;
    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;
    if (!durationCompatible(failedTrack, candidate)) continue;
    return candidate;
  }
  return null;
}

export function chooseSoundCloudAlternative(query, tracks, failedTrack) {
  for (const candidate of Array.isArray(tracks) ? tracks : []) {
    if (!candidate || candidate?.isStream || sameUri(candidate, failedTrack)) continue;
    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;
    if (!durationCompatible(failedTrack, candidate)) continue;
    return candidate;
  }
  return null;
}

export function takeFallbackQueueHold(queue) {
  if (!queue) return [];
  const held = [...queue];
  if (held.length && typeof queue.clear === 'function') queue.clear();
  return held;
}

export function restoreFallbackQueue(queue, heldTracks) {
  if (!queue || !Array.isArray(heldTracks) || !heldTracks.length) return 0;
  const tracks = [...heldTracks];
  if (queue.current) queue.unshift(...tracks);
  else if (typeof queue.add === 'function') queue.add(tracks);
  else queue.push(...tracks);
  return heldTracks.length;
}
''')

write('src/playback-history.js', r'''export const PLAYBACK_HISTORY_MIN_POSITION_MS = 2_000;

export function playbackHistoryFingerprint(track) {
  if (!track) return '';
  return [
    track?.sourceName || '',
    track?.identifier || '',
    track?.uri || track?.realUri || '',
    track?.title || '',
  ].join('\u0000');
}

export function playbackHistoryReady(pending, currentTrack, positionMs, paused = false) {
  if (!pending || paused) return false;
  if (Number(positionMs || 0) < PLAYBACK_HISTORY_MIN_POSITION_MS) return false;
  const current = playbackHistoryFingerprint(currentTrack);
  return Boolean(current && current === pending.fingerprint);
}
''')

# music.js
path = 'src/music.js'
text = read(path)
text = replace_exact(
    text,
    "import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, playbackFallbackQuery, youtubeTrackId } from './playback-fallback.js';",
    "import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, playbackFallbackQueries, playbackFallbackQuery, restoreFallbackQueue, takeFallbackQueueHold, youtubeTrackId } from './playback-fallback.js';\nimport { playbackHistoryFingerprint, playbackHistoryReady } from './playback-history.js';",
    'music fallback imports',
)
text = replace_exact(
    text,
    "const PLAYBACK_FALLBACK_WINDOW_MS = 30_000;",
    "const PLAYBACK_FALLBACK_WINDOW_MS = 30_000;\nconst PLAYBACK_FALLBACK_SEARCH_TIMEOUT_MS = 6_000;\nconst PLAYBACK_FALLBACK_SETTLE_TIMEOUT_MS = 2_000;",
    'fallback timeout constants',
)
text = replace_exact(
    text,
    "  const playbackFallbackInFlight = new Set();\n  const playbackFallbackAttempts = new Map();",
    "  const playbackFallbackAttempts = new Map();\n  const playbackFallbackHolds = new Map();\n  const pendingPlaybackHistory = new Map();",
    'fallback state maps',
)
old_queue = r'''  function queueTracks(player, tracks, { next = false, perRequestLimit = MAX_UPCOMING_QUEUE } = {}) {
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
'''
new_queue = r'''  function queueTracks(player, tracks, { next = false, perRequestLimit = MAX_UPCOMING_QUEUE } = {}) {
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
'''
text = replace_exact(text, old_queue, new_queue, 'queue tracks fallback hold')

history_helpers_anchor = "  function getHeldQueueCount(guildId) {\n    return heldQueues.get(guildId)?.length || 0;\n  }\n"
history_helpers = history_helpers_anchor + r'''

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
'''
text = replace_exact(text, history_helpers_anchor, history_helpers, 'staged history helpers')

old_discard = r'''  function discardHeldQueue(guildId, resetHealth = true) {
    const removed = getHeldQueueCount(guildId);
    heldQueues.delete(guildId);
    clearSourceRetry(guildId);
    clearSourceSuccess(guildId);
    if (resetHealth) playbackFailures.delete(guildId);
    return removed;
  }
'''
new_discard = r'''  function discardHeldQueue(guildId, resetHealth = true) {
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
'''
text = replace_exact(text, old_discard, new_discard, 'discard fallback hold')

old_health = r'''  function getSourceHealth(guildId) {
    const state = playbackFailures.get(guildId);
    if (!state) return { status: 'healthy', failures: 0, retryAt: 0, lastError: '', held: getHeldQueueCount(guildId) };
    return {
'''
new_health = r'''  function getSourceHealth(guildId) {
    const state = playbackFailures.get(guildId);
    if (!state) return {
      status: playbackFallbackHolds.has(guildId) ? 'fallback' : 'healthy',
      failures: 0,
      retryAt: 0,
      lastError: '',
      held: getHeldQueueCount(guildId),
    };
    return {
'''
text = replace_exact(text, old_health, new_health, 'fallback source health')

text = replace_exact(
    text,
    "  function recordPlaybackFailure(player, message, { skipCurrent = true } = {}) {\n    const guildId = player.guildId;\n    clearSourceSuccess(guildId);\n    const now = Date.now();\n    const track = player.queue.current;",
    "  function recordPlaybackFailure(player, message, { skipCurrent = true, trackOverride = null } = {}) {\n    const guildId = player.guildId;\n    clearSourceSuccess(guildId);\n    const now = Date.now();\n    const track = trackOverride || player.queue.current;",
    'failure fingerprint override',
)

fallback_start = text.index('  async function tryYoutubePlaybackFallback')
fallback_end = text.index('  function clearEmptyVoiceTimer', fallback_start)
old_fallback_block = text[fallback_start:fallback_end]
new_fallback_block = r'''  function beginPlaybackFallbackHold(player, failedTrack) {
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
      player.skip();
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

'''
text = text[:fallback_start] + new_fallback_block + text[fallback_end:]

old_player_update = r'''  music.on('playerUpdate', (player) => {
    const now = Date.now();
    const last = recoveryPositionSavedAt.get(player.guildId) || 0;
    if (now - last < RECOVERY_POSITION_SAVE_MS || !player.queue.current) return;
    recoveryPositionSavedAt.set(player.guildId, now);
    try { updateRecoveryPosition(player.guildId, Number(player.position || 0), Boolean(player.paused)); }
    catch (error) { console.warn('[recovery] position checkpoint failed', error?.message || error); }
  });
'''
new_player_update = r'''  music.on('playerUpdate', (player) => {
    commitPendingPlaybackHistory(player);
    const now = Date.now();
    const last = recoveryPositionSavedAt.get(player.guildId) || 0;
    if (now - last < RECOVERY_POSITION_SAVE_MS || !player.queue.current) return;
    recoveryPositionSavedAt.set(player.guildId, now);
    try { updateRecoveryPosition(player.guildId, Number(player.position || 0), Boolean(player.paused)); }
    catch (error) { console.warn('[recovery] position checkpoint failed', error?.message || error); }
  });
'''
text = replace_exact(text, old_player_update, new_player_update, 'player update history commit')

old_exception = r'''  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;
    const failedId = youtubeTrackId(failedTrack);
    console.warn('[player-exception]', player.guildId, message);
    void (async () => {
      const credentiallessBlock = isCredentiallessYoutubeBlock(message);
      if (credentiallessBlock) {
        if (await trySoundCloudPlaybackFallback(player, failedTrack, message)) return;
      } else {
        if (await tryYoutubePlaybackFallback(player, failedTrack, message)) return;
        if (await trySoundCloudPlaybackFallback(player, failedTrack, message)) return;
      }
      const currentId = youtubeTrackId(player.queue.current);
      const sameFailedItem = !failedId || !currentId || currentId === failedId;
      recordPlaybackFailure(player, message, { skipCurrent: sameFailedItem });
    })().catch((error) => {
      console.warn('[player-exception] fallback handler failed', error?.message || error);
      recordPlaybackFailure(player, message);
    });
  });
'''
new_exception = r'''  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;
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
'''
text = replace_exact(text, old_exception, new_exception, 'player exception fallback hold')

text = replace_exact(
    text,
    "  music.on('playerStuck', (player, data) => {\n    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;\n    console.warn('[player-stuck]', player.guildId, message);\n    recordPlaybackFailure(player, message);\n  });",
    "  music.on('playerStuck', (player, data) => {\n    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;\n    clearPendingPlaybackHistory(player.guildId, player.queue.current);\n    console.warn('[player-stuck]', player.guildId, message);\n    recordPlaybackFailure(player, message);\n  });",
    'stuck history clear',
)

old_start_history = r'''    try {
      addHistory(player.guildId, track?.requester?.id || 'unknown', track);
    } catch (error) {
      // Local history should never be able to break otherwise healthy playback.
      console.warn('[history] unable to record track', error?.message || error);
    }
    await setVoiceStatus(player, track);
'''
new_start_history = r'''    // Lavalink emits TrackStart before the executor proves it can actually read
    // audio. Stage history here and commit it on a later playerUpdate only after
    // the track has made real progress, so login/SABR failures never pollute
    // Recent History as if they were heard successfully.
    stagePlaybackHistory(player, track);
    await setVoiceStatus(player, track);
'''
text = replace_exact(text, old_start_history, new_start_history, 'defer history write')

old_empty_intro = r'''  async function handlePlayerEmpty(player) {
    // No current track means an empty-room pause marker can no longer refer to
    // a resumable item. A future playerStart will reevaluate occupancy itself.
    emptyVoiceAutoPaused.delete(player.guildId);
'''
new_empty_intro = r'''  async function handlePlayerEmpty(player) {
    clearPendingPlaybackHistory(player.guildId);
    // No current track means an empty-room pause marker can no longer refer to
    // a resumable item. A future playerStart will reevaluate occupancy itself.
    emptyVoiceAutoPaused.delete(player.guildId);
'''
text = replace_exact(text, old_empty_intro, new_empty_intro, 'empty history clear')

text = replace_exact(
    text,
    "    player.playing = false;\n\n    const health = getSourceHealth(player.guildId);",
    "    player.playing = false;\n\n    // A YouTube executor failure intentionally parks upcoming work while the\n    // SoundCloud fallback search runs. Do not treat that brief empty event as a\n    // naturally finished queue or start autoplay/disconnect logic.\n    if (playbackFallbackHolds.has(player.guildId)) {\n      settlePlaybackFallbackHold(player);\n      scheduleRecoverySave(player, 0);\n      return;\n    }\n\n    const health = getSourceHealth(player.guildId);",
    'empty fallback settle guard',
)

text = replace_exact(
    text,
    "    recoveryPositionSavedAt.delete(player.guildId);\n    playbackFallbackInFlight.delete(player.guildId);\n    playbackFallbackAttempts.delete(player.guildId);",
    "    recoveryPositionSavedAt.delete(player.guildId);\n    clearPendingPlaybackHistory(player.guildId);\n    const fallback = playbackFallbackHolds.get(player.guildId);\n    if (fallback) fallback.resolveSettled?.();\n    playbackFallbackHolds.delete(player.guildId);\n    playbackFallbackAttempts.delete(player.guildId);",
    'destroy fallback/history cleanup',
)

text = replace_exact(
    text,
    "    resumeRecoverySession,\n  };",
    "    resumeRecoverySession,\n    cancelPlaybackFallbackForSkip,\n  };",
    'export fallback skip cancel',
)
write(path, text)

# commands.js
path = 'src/commands.js'
text = read(path)
text = replace_exact(
    text,
    "  resumeRecoverySession,\n  searchPreferred,",
    "  resumeRecoverySession,\n  cancelPlaybackFallbackForSkip,\n  searchPreferred,",
    'handler fallback cancel arg',
)
text = replace_exact(
    text,
    "    invalidateQueueWork, isQueueRevisionCurrent, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,\n    withGuildOperation,",
    "    invalidateQueueWork, isQueueRevisionCurrent, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession, cancelPlaybackFallbackForSkip,\n    withGuildOperation,",
    'component api fallback cancel',
)
text = replace_exact(
    text,
    "    invalidateQueueWork, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,\n    withGuildOperation,",
    "    invalidateQueueWork, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession, cancelPlaybackFallbackForSkip,\n    withGuildOperation,",
    'button api fallback cancel',
)
text = replace_exact(
    text,
    "  if (!health || health.status === 'healthy') return 'Playback source: **Healthy**';\n  const held = Number(health.held || 0);",
    "  if (!health || health.status === 'healthy') return 'Playback source: **Healthy**';\n  const held = Number(health.held || 0);\n  if (health.status === 'fallback') return `Playback source: **🔄 Trying SoundCloud fallback**${held ? ` • ${held} queued track${held === 1 ? '' : 's'} held safely` : ''}`;",
    'status fallback label',
)
text = replace_exact(
    text,
    "      if (name === 'skip') return withGuildOperation(interaction.guildId, async () => { skipCurrent(player); checkpointRecovery(player); return privateReply(interaction, 'Skipped.'); });",
    "      if (name === 'skip') return withGuildOperation(interaction.guildId, async () => { if (!(await cancelPlaybackFallbackForSkip(player))) skipCurrent(player); checkpointRecovery(player); return privateReply(interaction, 'Skipped.'); });",
    'slash skip cancels fallback',
)
text = replace_exact(
    text,
    "    else if (action === 'skip') { skipCurrent(player); settle = true; }",
    "    else if (action === 'skip') { if (!(await cancelPlaybackFallbackForSkip(player))) skipCurrent(player); settle = true; }",
    'button skip cancels fallback',
)
write(path, text)

# package versions/checks
path = 'package.json'
pkg = json.loads(read(path))
pkg['version'] = '0.1.13'
check = pkg['scripts']['check']
if 'src/playback-history.js' not in check:
    check = check.replace('node --check src/playback-fallback.js', 'node --check src/playback-fallback.js && node --check src/playback-history.js')
pkg['scripts']['check'] = check
write(path, json.dumps(pkg, indent=2) + '\n')

path = 'package-lock.json'
lock = json.loads(read(path))
lock['version'] = '0.1.13'
if '' in lock.get('packages', {}):
    lock['packages']['']['version'] = '0.1.13'
write(path, json.dumps(lock, indent=2) + '\n')

# Keep tests that assert the current package version current.
for test_path in Path('test').glob('*.test.js'):
    value = test_path.read_text(encoding='utf-8')
    value = value.replace("assert.equal(pkg.version, '0.1.12');", "assert.equal(pkg.version, '0.1.13');")
    test_path.write_text(value, encoding='utf-8')

write('test/playback-fallback-v0113.test.js', r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  playbackFallbackQueries,
  restoreFallbackQueue,
  takeFallbackQueueHold,
} from '../src/playback-fallback.js';
import { playbackHistoryFingerprint, playbackHistoryReady } from '../src/playback-history.js';

function queueFixture(current, upcoming = []) {
  const queue = [...upcoming];
  queue.current = current;
  queue.clear = function clear() { this.splice(0, this.length); };
  queue.add = function add(tracks) {
    const copy = [...tracks];
    if (!this.current) this.current = copy.shift() || null;
    this.push(...copy);
  };
  return queue;
}

test('New Genesis upload noise reduces to a strong Ado SoundCloud query', () => {
  const first = playbackFallbackQueries({
    title: 'ADO - NEW GENESIS (One Piece Film Red OST) Lyrics | Lirik & Terjemahan',
    author: 'Ado',
  });
  assert.equal(first[0].toLowerCase(), 'ado new genesis');

  const second = playbackFallbackQueries({
    title: 'New Genesis by Ado × Yasutaka Nakata from ONE PIECE FILM RED',
    author: 'Ado',
  });
  assert.equal(second[0].toLowerCase(), 'ado new genesis');
  assert.ok(second.length <= 3);
});

test('fallback queue hold removes upcoming work before Kazagumo can auto-advance', () => {
  const current = { title: 'failed' };
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(current, [a, b]);
  const held = takeFallbackQueueHold(queue);
  assert.deepEqual(held, [a, b]);
  assert.equal(queue.current, current);
  assert.equal(queue.length, 0);
});

test('held queue restores in order behind a successful fallback', () => {
  const fallback = { title: 'SoundCloud fallback' };
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(fallback, []);
  assert.equal(restoreFallbackQueue(queue, [a, b]), 2);
  assert.equal(queue.current, fallback);
  assert.deepEqual([...queue], [a, b]);
});

test('held queue promotes first item when failed current has already ended', () => {
  const a = { title: 'A' };
  const b = { title: 'B' };
  const queue = queueFixture(null, []);
  restoreFallbackQueue(queue, [a, b]);
  assert.equal(queue.current, a);
  assert.deepEqual([...queue], [b]);
});

test('history waits for real playback progress and ignores executor-only starts', () => {
  const track = { sourceName: 'youtube', identifier: 'abcdefghijk', uri: 'https://youtube.test/watch?v=abcdefghijk', title: 'Song' };
  const pending = { fingerprint: playbackHistoryFingerprint(track) };
  assert.equal(playbackHistoryReady(pending, track, 0, false), false);
  assert.equal(playbackHistoryReady(pending, track, 1_999, false), false);
  assert.equal(playbackHistoryReady(pending, track, 2_000, false), true);
  assert.equal(playbackHistoryReady(pending, track, 5_000, true), false);
  assert.equal(playbackHistoryReady(pending, { ...track, identifier: 'different-id' }, 5_000, false), false);
});

test('music core holds queue before async fallback, suppresses transient empty, and defers history', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const handler = music.split("music.on('playerException'")[1]?.split("music.on('playerResolveError'")[0] || '';
  assert.match(handler, /beginPlaybackFallbackHold\(player, failedTrack\)/);
  assert.ok(handler.indexOf('beginPlaybackFallbackHold(player, failedTrack)') < handler.indexOf('void (async () =>'));
  assert.match(music, /if \(playbackFallbackHolds\.has\(player\.guildId\)\) \{\n\s+settlePlaybackFallbackHold\(player\)/);
  assert.match(music, /stagePlaybackHistory\(player, track\)/);
  assert.doesNotMatch(music.split('async function handlePlayerStart')[1]?.split('async function handlePlayerEmpty')[0] || '', /addHistory\(/);
  assert.match(music, /commitPendingPlaybackHistory\(player\);/);
});

test('queue additions stay held during fallback and manual skip cancels the pending fallback', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const commands = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(music, /if \(playbackFallbackHolds\.has\(player\.guildId\)\)/);
  assert.match(music, /cancelPlaybackFallbackForSkip/);
  assert.match(commands, /await cancelPlaybackFallbackForSkip\(player\)/);
});

test('v0.1.13 does not change buffers, heap caps, DSP or YouTube client chain', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.equal(pkg.version, '0.1.13');
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(app, /equalizer:\s*false/i);
  assert.match(app, /timescale:\s*false/i);
  const section = app.split('  youtube:\n')[1] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(clients.slice(0, 4), ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']);
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});
''')

# Document why this release intentionally does not add OAuth/remote PoT services.
path = 'README.md'
text = read(path)
section = r'''

## YouTube fallback race fix (v0.1.13)

When YouTube metadata/search works but playback is rejected by every anonymous playback client, EZ Music temporarily holds upcoming tracks before Kazagumo can auto-advance through them. It then tries a bounded SoundCloud fallback using up to three cleaned queries (for example, noisy `ADO - NEW GENESIS ... OST | Lirik & Terjemahan` metadata is reduced to `Ado New Genesis`). A successful fallback restores the held queue in its original order; a manual Skip cancels the pending fallback and continues safely. New queue additions made while fallback is running join the temporary hold instead of racing it.

Recent History now records a track only after Lavalink reports at least 2 seconds of real playback progress. A `TrackStart` immediately followed by YouTube login/SABR failure no longer appears as a successfully heard song.

This hotfix intentionally keeps the existing single-process Node + single local Lavalink architecture. It does not enable YouTube OAuth, add a remote poToken/webpo service, alter the YouTube client chain, enable DSP, or change the existing buffer/heap caps.
'''
if '## YouTube fallback race fix (v0.1.13)' not in text:
    text += section
write(path, text)
