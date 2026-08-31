import { classifySpotifyInput, hasExplicitSearchPrefix, isHttpUrl } from './source-routing.js';
import { isAmbiguousTitleOnlyMatch, rankSearchResult, searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

const DEFAULT_CHOICE_LIMIT = 3;
const PER_SOURCE_SCAN = 8;

function exactMediaKey(track) {
  const identifier = String(track?.identifier || '').trim();
  if (identifier) return `id:${identifier}`;
  const uri = String(track?.uri || track?.realUri || '').trim();
  if (uri) return `uri:${uri.toLowerCase()}`;
  return `meta:${String(track?.author || '').toLowerCase()}\u0000${String(track?.title || '').toLowerCase()}`;
}

function rawQueryTokens(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[\p{L}\p{N}]+/gu) || []);
}

export function searchChoiceKind(track, origin = '') {
  const title = String(track?.title || '');
  if (/\blyrics?\b|lyric\s+video/i.test(title)) return 'Lyrics';
  if (/\bofficial\s+audio\b|\baudio\s+only\b|\baudio\b/i.test(title)) return 'Audio';
  if (/\bm\s*\/\s*v\b|\bm\.?v\.?\b|\bmusic\s+video\b|\bofficial\s+(?:music\s+)?video\b/i.test(title)) return 'M/V';
  if (origin === 'ytm') return 'Music';
  return 'YouTube';
}

function preferenceScore(query, track, origin, { canonical = false } = {}) {
  const base = searchTrackScore(query, track);
  if (base < SEARCH_MATCH_THRESHOLD) return base;

  const requested = rawQueryTokens(query);
  const kind = searchChoiceKind(track, origin);
  const requestedLyrics = requested.has('lyric') || requested.has('lyrics');
  const requestedAudio = requested.has('audio');
  const requestedVideo = requested.has('mv') || requested.has('video');

  let bonus = canonical ? 0.06 : 0;
  if (kind === 'Lyrics') bonus += requestedLyrics ? 0.22 : 0.18;
  else if (kind === 'Audio') bonus += requestedAudio ? 0.18 : 0.12;
  else if (kind === 'Music') bonus += 0.04;
  else if (kind === 'M/V') bonus += requestedVideo ? 0.16 : -0.08;

  if (origin === 'lyrics' && kind === 'Lyrics') bonus += 0.04;
  return Math.max(0, Math.min(1.3, base + bonus));
}

function rankedTracks(result, query) {
  if (!result?.tracks?.length) return [];
  const ranked = rankSearchResult(result, query);
  return ranked.result?.tracks || [];
}

function canonicalTrack(query, rankedYtm, rankedYoutube) {
  const ytm = rankedYtm[0] || null;
  const yt = rankedYoutube[0] || null;
  if (ytm && searchTrackScore(query, ytm) >= SEARCH_MATCH_THRESHOLD && !isAmbiguousTitleOnlyMatch(query, ytm)) return ytm;
  if (yt && searchTrackScore(query, yt) >= SEARCH_MATCH_THRESHOLD) return yt;
  if (ytm && searchTrackScore(query, ytm) >= SEARCH_MATCH_THRESHOLD) return ytm;
  return null;
}

function sameExactTrack(a, b) {
  return Boolean(a && b && exactMediaKey(a) === exactMediaKey(b));
}

function collectCandidates(query, sourceTracks, canonical) {
  const candidates = [];
  const seen = new Set();
  for (const source of sourceTracks) {
    for (const track of source.tracks.slice(0, PER_SOURCE_SCAN)) {
      const score = preferenceScore(query, track, source.origin, { canonical: sameExactTrack(track, canonical) });
      if (score < SEARCH_MATCH_THRESHOLD) continue;
      const key = exactMediaKey(track);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        track,
        kind: searchChoiceKind(track, source.origin),
        origin: source.origin,
        score,
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function pickDiverse(candidates, limit) {
  const selected = [];
  const usedKinds = new Set();

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (usedKinds.has(candidate.kind)) continue;
    selected.push(candidate);
    usedKinds.add(candidate.kind);
  }

  if (selected.length < limit) {
    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      if (selected.includes(candidate)) continue;
      selected.push(candidate);
    }
  }
  return selected;
}

async function safeSearch(target, query, requester, source) {
  try {
    return await target.search(query, { requester, source });
  } catch {
    return null;
  }
}

export function shouldOfferSearchChoices(query) {
  const clean = String(query || '').trim();
  if (!clean) return false;
  if (isHttpUrl(clean) || hasExplicitSearchPrefix(clean)) return false;
  if (classifySpotifyInput(clean).spotify) return false;
  return true;
}

export async function resolveSearchChoices(target, query, requester, { limit = DEFAULT_CHOICE_LIMIT } = {}) {
  const clean = String(query || '').trim();
  if (!shouldOfferSearchChoices(clean)) return [];
  const safeLimit = Math.max(1, Math.min(3, Number(limit) || DEFAULT_CHOICE_LIMIT));

  // These are metadata/search calls only. They do not touch the active Lavalink
  // audio stream. Run them together so the richer picker does not triple latency.
  const [lyricsResult, ytmResult, youtubeResult] = await Promise.all([
    safeSearch(target, `${clean} lyrics`, requester, 'ytsearch:'),
    safeSearch(target, clean, requester, 'ytmsearch:'),
    safeSearch(target, clean, requester, 'ytsearch:'),
  ]);

  const rankedLyrics = rankedTracks(lyricsResult, clean);
  const rankedYtm = rankedTracks(ytmResult, clean);
  const rankedYoutube = rankedTracks(youtubeResult, clean);
  const canonical = canonicalTrack(clean, rankedYtm, rankedYoutube);
  const candidates = collectCandidates(clean, [
    { origin: 'lyrics', tracks: rankedLyrics },
    { origin: 'ytm', tracks: rankedYtm },
    { origin: 'youtube', tracks: rankedYoutube },
  ], canonical);

  return pickDiverse(candidates, safeLimit);
}
