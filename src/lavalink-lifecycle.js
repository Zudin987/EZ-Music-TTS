const NODE_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000];

// Koe already retries session-timeout/server-crash/transient voice closes.
// These codes instead require a fresh Discord gateway voice handshake because
// the old voice websocket/session must not simply be resumed.
const VOICE_CLOSE_REFRESH_SESSION = new Set([4006, 4014, 4022]);

// A DAVE-required close on a DAVE-capable Lavalink stack indicates a persistent
// capability mismatch; a rate-limit close must not be hammered with rejoins.
const VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([4017, 4021]);

export const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;

export function nodeReconnectDelayMs(attempt) {
  const index = Math.max(0, Math.min(NODE_RECONNECT_DELAYS_MS.length - 1, Number(attempt || 1) - 1));
  return NODE_RECONNECT_DELAYS_MS[index];
}

export function voiceCloseDisposition(code) {
  const numeric = Number(code || 0);
  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(numeric)) return 'retire';
  if (VOICE_CLOSE_REFRESH_SESSION.has(numeric)) return 'refresh';
  return 'watch';
}

export function botVoiceChannelTransition(botUserId, oldState, newState) {
  const botId = String(botUserId || '');
  const oldId = String(oldState?.id || '');
  const newId = String(newState?.id || '');
  if (!botId || (oldId !== botId && newId !== botId)) return null;

  const oldChannelId = oldState?.channelId || null;
  const channelId = newState?.channelId || null;
  if (oldChannelId === channelId) return null;
  if (channelId) {
    return {
      type: oldChannelId ? 'moved' : 'joined',
      oldChannelId,
      channelId,
    };
  }
  if (oldChannelId) return { type: 'left', oldChannelId, channelId: null };
  return null;
}

function eventEncoded(track) {
  return String(track?.encoded || track?.track || '').trim();
}

function candidateEncoded(track) {
  return String(track?.track || track?.encoded || '').trim();
}

function eventInfo(track) {
  return track?.info || track?._raw?.info || {};
}

export function eventTrackMatches(eventTrack, candidate) {
  if (!eventTrack || !candidate) return false;

  const eventBase64 = eventEncoded(eventTrack);
  const candidateBase64 = candidateEncoded(candidate);
  if (eventBase64 && candidateBase64) return eventBase64 === candidateBase64;

  const info = eventInfo(eventTrack);
  const eventIdentifier = String(info?.identifier || eventTrack?.identifier || '').trim();
  const candidateIdentifier = String(candidate?.identifier || candidate?._raw?.info?.identifier || '').trim();
  if (!eventIdentifier || !candidateIdentifier || eventIdentifier !== candidateIdentifier) return false;

  const eventSource = String(info?.sourceName || eventTrack?.sourceName || '').trim();
  const candidateSource = String(candidate?.sourceName || candidate?._raw?.info?.sourceName || '').trim();
  if (eventSource && candidateSource && eventSource !== candidateSource) return false;

  const eventUri = String(info?.uri || eventTrack?.uri || '').trim();
  const candidateUri = String(candidate?.uri || candidate?.realUri || candidate?._raw?.info?.uri || '').trim();
  if (eventUri && candidateUri && eventUri !== candidateUri) return false;

  return true;
}

export function resolveLifecycleEventTrack(eventTrack, currentTrack, lastTrack) {
  // Shoukaku 4.3.0's TypeScript interface omitted TrackExceptionEvent.track even
  // though Lavalink v4 sends it. Keep compatibility with an actually missing
  // field. When Lavalink does supply the exact event track, only act on it if it
  // is still queue.current. A late event from the previous song must never skip,
  // circuit-break, or source-fallback the newer song.
  if (!eventTrack) return currentTrack || lastTrack || null;
  if (eventTrackMatches(eventTrack, currentTrack)) return currentTrack;
  if (!currentTrack && eventTrackMatches(eventTrack, lastTrack)) return lastTrack;
  return null;
}
