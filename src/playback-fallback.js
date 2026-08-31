import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

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
    .replace(/\s*[|•]+\s*/g, ' ')
    .replace(/\s+[&+]\s*$/g, ' '));
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
