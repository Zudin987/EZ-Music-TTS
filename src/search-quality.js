const SEARCH_NOISE = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'visualizer', 'mv',
  'music', 'topic', 'vevo', 'feat', 'ft', 'featuring',
]);

function tokens(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ');
  const found = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const filtered = found.filter((token) => !SEARCH_NOISE.has(token));
  return filtered.length ? [...new Set(filtered)] : [...new Set(found)];
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
  return Math.min(1, (combinedCoverage * 0.75) + (titleCoverage * 0.25));
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
