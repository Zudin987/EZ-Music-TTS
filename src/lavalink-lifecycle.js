const NODE_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000];

const VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([
  4006, // session no longer valid
  4009, // session timed out
  4014, // disconnected; Discord says do not reconnect
  4017, // DAVE required
  4021, // rate limited; do not reconnect
  4022, // call terminated; do not reconnect
]);

export const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;

export function nodeReconnectDelayMs(attempt) {
  const index = Math.max(0, Math.min(NODE_RECONNECT_DELAYS_MS.length - 1, Number(attempt || 1) - 1));
  return NODE_RECONNECT_DELAYS_MS[index];
}

export function voiceCloseDisposition(code) {
  const value = Number(code || 0);
  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(value)) return 'retire';
  return 'watch';
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
  // Lavalink v4 includes the exact track on TrackExceptionEvent and
  // TrackStuckEvent. Shoukaku 4.3.0's TypeScript interface omitted the
  // exception track field, but its runtime forwards the raw Lavalink payload.
  // Never guess when identity is missing: a malformed or late trackless event
  // must not be allowed to skip, circuit-break, or source-fallback a newer song.
  if (!eventTrack) return null;
  if (eventTrackMatches(eventTrack, currentTrack)) return currentTrack;
  if (!currentTrack && eventTrackMatches(eventTrack, lastTrack)) return lastTrack;
  return null;
}
