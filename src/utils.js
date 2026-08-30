export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function parseTimeToSeconds(input) {
  const value = String(input ?? '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0) || parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function truncate(text, max = 80) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function youtubeIdentifier(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || '';
}

function normalizedUri(track) {
  const raw = String(track?.uri || track?.realUri || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'si', 'feature']) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, '').toLocaleLowerCase();
  } catch {
    return raw.toLocaleLowerCase();
  }
}

function normalizeMusicText(value, { title = false, author = false } = {}) {
  let text = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'");

  if (author) {
    text = text.replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '');
  }

  if (title) {
    // Strip presentation/upload labels that commonly describe the same audio,
    // but deliberately keep meaningful versions such as live, remix, acoustic,
    // instrumental, sped-up, slowed, demo, or radio edit distinct.
    const junk = '(?:official\\s*(?:music\\s*)?video|official\\s*audio|audio\\s*only|lyrics?|lyric\\s*video|visuali[sz]er|m\\.?v\\.?|music\\s*video|4k|hd|hq)';
    text = text
      .replace(new RegExp(`\\s*[\\[(]\\s*${junk}\\s*[\\])]\\s*`, 'gi'), ' ')
      .replace(new RegExp(`\\s*[-–—|:]\\s*${junk}\\s*$`, 'gi'), ' ')
      .replace(new RegExp(`\\s+${junk}\\s*$`, 'gi'), ' ');
  }

  return text
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trackKey(track) {
  // Prefer normalized metadata when both fields are present. This catches
  // common Official Video vs Official Audio duplicates even when upload IDs
  // differ, while keeping Live/Remix/Acoustic/Instrumental variants distinct.
  const author = normalizeMusicText(track?.author, { author: true });
  const title = normalizeMusicText(track?.title, { title: true });
  if (author && title) return `meta:${author}\u0000${title}`;

  const yt = youtubeIdentifier(track);
  if (yt) return `yt:${yt}`;
  const uri = normalizedUri(track);
  if (uri && !uri.startsWith('meta:')) return `uri:${uri}`;
  if (!author && !title) return '';
  return `meta:${author}\u0000${title}`;
}

export function sameTrack(a, b) {
  const aKey = trackKey(a);
  const bKey = trackKey(b);
  return Boolean(aKey && bKey && aKey === bKey);
}

export function radioFallbackHistory(history, recentCount = 15, limit = 10) {
  const rows = Array.isArray(history) ? history : [];
  const older = rows.slice(Math.max(0, recentCount));
  const source = older.length ? older : rows;
  const selected = [];
  const seen = new Set();

  for (const row of source) {
    const key = trackKey(row) || String(row?.uri || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
    if (selected.length >= Math.max(1, limit)) break;
  }

  return selected;
}
