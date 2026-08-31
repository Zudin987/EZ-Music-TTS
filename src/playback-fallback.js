import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

export function youtubeTrackId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

function durationCompatible(failedTrack, candidate) {
  const failed = Number(failedTrack?.length || 0);
  const next = Number(candidate?.length || 0);
  if (!failed || !next) return true;
  if (failed >= 120_000 && next < 60_000) return false;
  return Math.abs(next - failed) <= Math.max(120_000, failed * 0.55);
}

export function choosePlaybackAlternative(query, tracks, failedTrack) {
  const failedId = youtubeTrackId(failedTrack);
  for (const candidate of Array.isArray(tracks) ? tracks : []) {
    if (!candidate || candidate?.isStream) continue;
    const candidateId = youtubeTrackId(candidate);
    if (!candidateId || (failedId && candidateId === failedId)) continue;
    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;
    if (!durationCompatible(failedTrack, candidate)) continue;
    // Keep native normal-YouTube ranking among acceptable candidates. This is
    // intentionally different from re-sorting exact-title clones by title alone.
    return candidate;
  }
  return null;
}
