import { classifySpotifyInput, hasExplicitSearchPrefix, isHttpUrl } from './source-routing.js';
import { isAmbiguousTitleOnlyMatch, rankSearchResult, searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

const DEFAULT_CHOICE_LIMIT = 3;
const PER_SOURCE_SCAN = 8;
const IDENTITY_NOISE = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'visualizer', 'mv', 'music',
  'topic', 'vevo', 'entertainment', 'records', 'record', 'channel', 'provided', 'youtube',
]);

function exactMediaKey(track) {
  const identifier = String(track?.identifier || '').trim();
  if (identifier) return `id:${identifier}`;
  const uri = String(track?.uri || track?.realUri || '').trim();
  if (uri) return `uri:${uri.toLowerCase()}`;
  return `meta:${String(track?.author || '').toLowerCase()}\u0000${String(track?.title || '').toLowerCase()}`;
}

function textTokens(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function rawQueryTokens(value) {
  return new Set(textTokens(value));
}

function trackIdentityTokens(track, queryTokens) {
  const found = new Set();
  for (const token of [...textTokens(track?.title), ...textTokens(track?.author)]) {
    if (queryTokens.has(token) || IDENTITY_NOISE.has(token)) continue;
    found.add(token);
  }
  return found;
}

function corroboratedIdentityTokens(query, sourceTracks) {
  const queryTokens = rawQueryTokens(query);
  const originsByToken = new Map();

  for (const source of sourceTracks) {
    const sourceTokens = new Set();
    for (const track of source.tracks.slice(0, 4)) {
      if (searchTrackScore(query, track) < SEARCH_MATCH_THRESHOLD) continue;
      for (const token of trackIdentityTokens(track, queryTokens)) sourceTokens.add(token);
    }
    for (const token of sourceTokens) {
      const origins = originsByToken.get(token) || new Set();
      origins.add(source.origin);
      originsByToken.set(token, origins);
    }
  }

  // Only trust artist/entity clues independently seen in at least two search
  // routes. This keeps title-only searches from inheriting a single bad uploader.
  return new Set([...originsByToken.entries()]
    .filter(([, origins]) => origins.size >= 2)
    .map(([token]) => token));
}

function matchesCorroboratedIdentity(track, query, identityTokens) {
  if (!identityTokens.size) return true;
  const candidate = trackIdentityTokens(track, rawQueryTokens(query));
  for (const token of identityTokens) if (candidate.has(token)) return true;
  return false;
}

function durationCompatible(canonical, candidate) {
  const base = Number(canonical?.length || 0);
  const next = Number(candidate?.length || 0);
  if (!base || !next) return true;
  const tolerance = Math.max(45_000, base * 0.30);
  return Math.abs(next - base) <= tolerance;
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

function collectCandidates(query, sourceTracks, canonical, identityTokens) {
  const candidates = [];
  const seen = new Set();
  for (const source of sourceTracks) {
    for (const track of source.tracks.slice(0, PER_SOURCE_SCAN)) {
      if (!track || track?.isStream) continue;
      const score = preferenceScore(query, track, source.origin, { canonical: sameExactTrack(track, canonical) });
      if (score < SEARCH_MATCH_THRESHOLD) continue;
      if (!matchesCorroboratedIdentity(track, query, identityTokens)) continue;
      if (!durationCompatible(canonical, track)) continue;
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
  const sourceTracks = [
    { origin: 'lyrics', tracks: rankedLyrics },
    { origin: 'ytm', tracks: rankedYtm },
    { origin: 'youtube', tracks: rankedYoutube },
  ];
  const canonical = canonicalTrack(clean, rankedYtm, rankedYoutube);
  const identityTokens = corroboratedIdentityTokens(clean, sourceTracks);
  const candidates = collectCandidates(clean, sourceTracks, canonical, identityTokens);

  return pickDiverse(candidates, safeLimit);
}
