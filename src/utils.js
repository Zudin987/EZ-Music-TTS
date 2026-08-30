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

export function trackKey(track) {
  const author = String(track?.author || '').trim().toLocaleLowerCase();
  const title = String(track?.title || '').trim().toLocaleLowerCase();
  if (!author && !title) return '';
  return `${author}\u0000${title}`;
}

export function radioFallbackHistory(history, recentCount = 15, limit = 10) {
  const rows = Array.isArray(history) ? history : [];
  const older = rows.slice(Math.max(0, recentCount));
  const source = older.length ? older : rows;
  const selected = [];
  const seen = new Set();

  for (const row of source) {
    const key = String(row?.uri || '').trim() || trackKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
    if (selected.length >= Math.max(1, limit)) break;
  }

  return selected;
}
