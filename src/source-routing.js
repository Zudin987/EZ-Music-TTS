const SPOTIFY_HOST = 'open.spotify.com';
const SPOTIFY_SHORT_HOST = 'spotify.link';
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist']);

function unsupportedSpotify(message = null) {
  return {
    spotify: true,
    supported: false,
    short: false,
    type: null,
    id: null,
    error: message || 'Unsupported Spotify reference. EZ Music supports only full open.spotify.com track, album, or playlist URLs (or matching spotify: URIs).',
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
    return {
      spotify: true,
      supported: false,
      short: true,
      type: null,
      id: null,
      error: 'Spotify short links (spotify.link) are not supported by the current LavaSrc source. Open the link in Spotify and paste the full open.spotify.com URL instead.',
    };
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

export async function resolvePreferredSearch(target, query, requester, { spotifyConfigured = false } = {}) {
  const clean = String(query || '').trim();
  if (!clean) throw new Error('Search query is empty.');

  const spotify = classifySpotifyInput(clean);
  if (spotify.spotify) {
    if (!spotify.supported) throw new Error(spotify.error);
    if (!spotifyConfigured) {
      throw new Error('Spotify URL support is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env, then restart EZ Music.');
    }
    return target.search(clean, { requester });
  }

  // Never rewrite direct URLs or an explicitly requested search prefix.
  if (isHttpUrl(clean) || hasExplicitSearchPrefix(clean)) return target.search(clean, { requester });

  let ytmError = null;
  try {
    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });
    if (ytm?.tracks?.length) return ytm;
  } catch (error) {
    ytmError = error;
  }

  try {
    return await target.search(clean, { requester, source: 'ytsearch:' });
  } catch (error) {
    throw error || ytmError || new Error(`No results for: ${clean}`);
  }
}
