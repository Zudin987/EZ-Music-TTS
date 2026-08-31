const SEARCH_NOISE = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'visualizer', 'mv',
  'music', 'topic', 'vevo', 'feat', 'ft', 'featuring',
]);

const VARIANT_PATTERNS = [
  ['cover'],
  ['karaoke'],
  ['instrumental'],
  ['remix'],
  ['acoustic'],
  ['nightcore'],
  ['slowed'],
  ['live'],
  ['sped', 'up'],
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

function hasUnrequestedVariant(query, title) {
  const queryTokens = new Set(rawTokens(query));
  const titleTokens = new Set(rawTokens(title));
  return VARIANT_PATTERNS.some((pattern) => (
    includesPattern(titleTokens, pattern) && !includesPattern(queryTokens, pattern)
  ));
}

function coverage(queryTokens, candidateTokens) {
  if (!queryTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  let matched = 0;
  for (const token of queryTokens) if (candidate.has(token)) matched += 1;
  return matched / queryTokens.length;
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

  // A cover/karaoke/instrumental/etc. can have a perfect title match while still
  // being the wrong version. Prefer the standard/original result unless the user
  // explicitly asked for that variant.
  if (hasUnrequestedVariant(query, track?.title)) score *= 0.4;
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
