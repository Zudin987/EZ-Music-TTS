import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

export function youtubeTrackId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

export function playbackFallbackQuery(track) {
  return String(track?.title || '')
    .replace(/\bM\s*\/\s*V\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCredentiallessYoutubeBlock(message) {
  const value = String(message || '');
  return /all clients failed to load the item|this video requires login|sign in to confirm you.?re not a bot|no supported audio streams available|video player configuration error/i.test(value);
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
