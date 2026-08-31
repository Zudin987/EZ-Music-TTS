import { isAmbiguousTitleOnlyMatch, rankSearchResult, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

const SPOTIFY_HOST = 'open.spotify.com';
const SPOTIFY_SHORT_HOST = 'spotify.link';
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist']);
const SPOTIFY_OEMBED_ENDPOINT = 'https://open.spotify.com/oembed';
const SPOTIFY_OEMBED_TIMEOUT_MS = 2_500;
const SPOTIFY_OEMBED_MAX_BYTES = 64 * 1024;

function unsupportedSpotify(message = null) {
  return {
    spotify: true,
    supported: false,
    short: false,
    type: null,
    id: null,
    error: message || 'Unsupported Spotify reference. EZ Music supports Spotify track, album, or playlist references only.',
  };
}

export function classifySpotifyInput(value) {
  const text = String(value || '').trim();
  if (!text) return { spotify: false, supported: false, short: false, type: null, id: null, error: null };

  if (/^spotify:/i.test(text)) {
    const match = text.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/i);
    if (!match) return unsupportedSpotify('Malformed Spotify URI. EZ Music supports spotify:track, spotify:album, and spotify:playlist references with a valid Spotify ID.');
    const type = match[1].toLowerCase();
    const id = match[2];
    if (!SPOTIFY_TYPES.has(type) || !SPOTIFY_ID_RE.test(id)) return unsupportedSpotify();
    return { spotify: true, supported: true, short: false, type, id, error: null };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return { spotify: false, supported: false, short: false, type: null, id: null, error: null };
  }

  const host = url.hostname.toLowerCase();
  if (host === SPOTIFY_SHORT_HOST) {
    if (url.protocol !== 'https:') return unsupportedSpotify('Spotify short links must use https://spotify.link/.');
    return { spotify: true, supported: true, short: true, type: null, id: null, error: null };
  }
  if (host !== SPOTIFY_HOST) return { spotify: false, supported: false, short: false, type: null, id: null, error: null };
  if (url.protocol !== 'https:') return unsupportedSpotify('Spotify links must use https://open.spotify.com/.');

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] && /^intl-[a-z]{2,3}$/i.test(parts[0])) parts.shift();
  if (parts.length !== 2) return unsupportedSpotify();

  const type = String(parts[0] || '').toLowerCase();
  const id = String(parts[1] || '');
  if (!SPOTIFY_TYPES.has(type) || !SPOTIFY_ID_RE.test(id)) return unsupportedSpotify();
  return { spotify: true, supported: true, short: false, type, id, error: null };
}

function spotifyCanonicalUrl(info, original) {
  if (info?.short) return String(original || '').trim();
  if (!info?.type || !info?.id) return String(original || '').trim();
  return `https://open.spotify.com/${info.type}/${info.id}`;
}

function spotifyEmbedReference(html) {
  const match = String(html || '').match(/https:\/\/open\.spotify\.com\/embed\/(track|album|playlist)\/([A-Za-z0-9]{22})/i);
  if (!match) return null;
  return { type: match[1].toLowerCase(), id: match[2] };
}

export async function fetchSpotifyOEmbed(value, { fetchImpl = globalThis.fetch, timeoutMs = SPOTIFY_OEMBED_TIMEOUT_MS } = {}) {
  const clean = String(value || '').trim();
  const info = classifySpotifyInput(clean);
  if (!info.spotify || !info.supported) throw new Error(info.error || 'Unsupported Spotify reference.');
  if (typeof fetchImpl !== 'function') throw new Error('Spotify metadata lookup is unavailable in this runtime.');

  const spotifyUrl = spotifyCanonicalUrl(info, clean);
  const endpoint = new URL(SPOTIFY_OEMBED_ENDPOINT);
  endpoint.searchParams.set('url', spotifyUrl);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json' },
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'failed';
    throw new Error(`Spotify metadata lookup ${reason}. Try the song name or a YouTube link instead.`);
  }

  if (!response?.ok) throw new Error(`Spotify metadata lookup failed (HTTP ${response?.status || 'unknown'}).`);
  const declaredBytes = Number(response.headers?.get?.('content-length') || 0);
  if (declaredBytes > SPOTIFY_OEMBED_MAX_BYTES) throw new Error('Spotify metadata response was unexpectedly large.');

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > SPOTIFY_OEMBED_MAX_BYTES) throw new Error('Spotify metadata response was unexpectedly large.');

  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error('Spotify metadata response was invalid.'); }

  const embedded = spotifyEmbedReference(data?.html);
  const type = embedded?.type || info.type;
  const id = embedded?.id || info.id;
  const title = String(data?.title || '').trim();
  if (!SPOTIFY_TYPES.has(type) || !SPOTIFY_ID_RE.test(String(id || '')) || !title) {
    throw new Error('Spotify link is not a supported track, album, or playlist reference.');
  }

  return {
    title,
    type,
    id,
    canonicalUrl: `https://open.spotify.com/${type}/${id}`,
  };
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hasExplicitSearchPrefix(value) {
  return /^(?:ytmsearch|ytsearch|scsearch|spsearch):/i.test(String(value || '').trim());
}

async function searchTextPreferred(target, clean, requester) {
  let ytmError = null;
  let rankedYtm = null;
  let ytmNeedsYoutubeComparison = false;
  try {
    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });
    if (ytm?.tracks?.length) {
      rankedYtm = rankSearchResult(ytm, clean);
      if (rankedYtm.bestScore >= SEARCH_MATCH_THRESHOLD) {
        const bestYtm = rankedYtm.result?.tracks?.[0];
        ytmNeedsYoutubeComparison = isAmbiguousTitleOnlyMatch(clean, bestYtm);
        if (!ytmNeedsYoutubeComparison) return rankedYtm.result;
      }
    }
  } catch (error) {
    ytmError = error;
  }

  try {
    const youtube = await target.search(clean, { requester, source: 'ytsearch:' });
    if (youtube?.tracks?.length) {
      const rankedYoutube = rankSearchResult(youtube, clean);
      if (rankedYoutube.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYoutube.result;
    }
    // If YouTube has no good answer, an otherwise strong YTM exact-title match is
    // still preferable to returning nothing. The comparison only resolves ambiguity.
    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;
    return { ...(youtube || rankedYtm?.result || {}), tracks: [] };
  } catch (error) {
    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;
    throw error || ytmError || new Error(`No results for: ${clean}`);
  }
}

export async function resolvePreferredSearch(target, query, requester, { spotifyConfigured = false, spotifyOEmbedOptions = {} } = {}) {
  const clean = String(query || '').trim();
  if (!clean) throw new Error('Search query is empty.');

  const spotify = classifySpotifyInput(clean);
  if (spotify.spotify) {
    if (!spotify.supported) throw new Error(spotify.error);

    let metadata = null;
    let type = spotify.type;
    let directQuery = spotifyCanonicalUrl(spotify, clean);

    // spotify.link does not expose the object type in its path. oEmbed is the
    // official lightweight way to resolve it without the Premium-gated Web API.
    if (spotify.short) {
      metadata = await fetchSpotifyOEmbed(clean, spotifyOEmbedOptions);
      type = metadata.type;
      directQuery = metadata.canonicalUrl;
    }

    if (spotifyConfigured) {
      let directError = null;
      try {
        const direct = await target.search(directQuery, { requester });
        if (direct?.tracks?.length) return direct;
        directError = new Error('Spotify returned no playable mirror results.');
      } catch (error) {
        directError = error;
      }

      // oEmbed exposes entity metadata, not an album/playlist tracklist.
      if (type !== 'track') throw directError;
    }

    if (type !== 'track') {
      throw new Error('Spotify album/playlist links require working SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET credentials. Single track links work without them.');
    }

    // Track-only fallback: Spotify supplies metadata; YTM/YouTube supplies audio.
    // This request is bounded and never enters the live Lavalink audio stream.
    metadata ||= await fetchSpotifyOEmbed(directQuery, spotifyOEmbedOptions);
    if (metadata.type !== 'track') throw new Error('Spotify fallback supports single track links only.');
    return searchTextPreferred(target, metadata.title, requester);
  }

  // Never rewrite direct URLs or an explicitly requested search prefix.
  if (isHttpUrl(clean) || hasExplicitSearchPrefix(clean)) return target.search(clean, { requester });
  return searchTextPreferred(target, clean, requester);
}
