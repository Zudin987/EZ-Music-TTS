const SEARCH_NOISE = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'visualizer', 'mv',
  'music', 'topic', 'vevo', 'feat', 'ft', 'featuring',
]);

const TITLE_VARIANT_PATTERNS = [
  ['cover'],
  ['karaoke'],
  ['instrumental'],
  ['remix'],
  ['acoustic'],
  ['nightcore'],
  ['slowed'],
  ['live'],
  ['performance'],
  ['stage'],
  ['fancam'],
  ['musiccore'],
  ['inkigayo'],
  ['countdown'],
  ['music', 'bank'],
  ['dance', 'practice'],
  ['choreography'],
  ['trailer'],
  ['teaser'],
  ['preview'],
  ['snippet'],
  ['shorts'],
  ['hidden', 'vocals'],
  ['vocals', 'louder'],
  ['bass', 'boosted'],
  ['line', 'distribution'],
  ['fanmade'],
  ['fan', 'made'],
  ['edit'],
  ['8d'],
  ['sped', 'up'],
];

// Some alternate-version uploaders leave the title completely clean, e.g.
// "Heavy Serenade — Shin Giwon Piano". These source-name hints are strong
// enough to down-rank unless the user explicitly includes the same intent.
const AUTHOR_VARIANT_PATTERNS = [
  ['cover'],
  ['karaoke'],
  ['instrumental'],
  ['piano'],
  ['tribute'],
];

function rawTokens(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function tokens(value) {
  const found = rawTokens(value);
  const filtered = found.filter((token) => !SEARCH_NOISE.has(token));
  return filtered.length ? [...new Set(filtered)] : [...new Set(found)];
}

function includesPattern(tokenSet, pattern) {
  return pattern.every((token) => tokenSet.has(token));
}

function hasUnrequestedVariant(query, track) {
  const queryTokens = new Set(rawTokens(query));
  const titleTokens = new Set(rawTokens(track?.title));
  const authorTokens = new Set(rawTokens(track?.author));
  const unrequested = (tokenSet, pattern) => (
    includesPattern(tokenSet, pattern) && !includesPattern(queryTokens, pattern)
  );
  return TITLE_VARIANT_PATTERNS.some((pattern) => unrequested(titleTokens, pattern))
    || AUTHOR_VARIANT_PATTERNS.some((pattern) => unrequested(authorTokens, pattern));
}

function coverage(queryTokens, candidateTokens) {
  if (!queryTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  let matched = 0;
  for (const token of queryTokens) if (candidate.has(token)) matched += 1;
  return matched / queryTokens.length;
}

export function isAmbiguousTitleOnlyMatch(query, track) {
  const queryTokens = tokens(query);
  if (queryTokens.length < 2) return false;
  const titleTokens = tokens(track?.title);
  const authorTokens = tokens(track?.author);
  // Example: "Heavy Serenade" perfectly matches many unrelated uploads. If
  // every query token is only in the title and none identify the uploader/artist,
  // compare normal YouTube ranking before accepting the YTM result.
  return coverage(queryTokens, titleTokens) === 1 && coverage(queryTokens, authorTokens) === 0;
}

export function searchTrackScore(query, track) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return 0;
  const titleTokens = tokens(track?.title);
  const authorTokens = tokens(track?.author);
  const combined = [...new Set([...titleTokens, ...authorTokens])];
  const combinedCoverage = coverage(queryTokens, combined);
  const titleCoverage = coverage(queryTokens, titleTokens);
  let score = Math.min(1, (combinedCoverage * 0.75) + (titleCoverage * 0.25));

  // A cover/karaoke/instrumental/stage/promo/fan-edit/etc. can have a perfect title
  // match while still being the wrong version. Prefer the standard/original result
  // unless the user explicitly asked for that variant.
  if (hasUnrequestedVariant(query, track)) score *= 0.4;
  return score;
}

export function rankSearchResult(result, query) {
  const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
  const ranked = tracks
    .map((track, index) => ({ track, index, score: searchTrackScore(query, track) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    result: result ? { ...result, tracks: ranked.map((entry) => entry.track) } : result,
    bestScore: ranked[0]?.score || 0,
  };
}

export const SEARCH_MATCH_THRESHOLD = 0.55;
