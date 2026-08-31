export const PLAYBACK_HISTORY_MIN_POSITION_MS = 2_000;

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
