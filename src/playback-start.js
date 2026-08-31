function hasQueuedWork(player) {
  return Boolean(player?.queue?.current) || Number(player?.queue?.length || 0) > 0;
}

function encodedTrack(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return typeof value.track === 'string' ? value.track : typeof value.encoded === 'string' ? value.encoded : '';
}

/**
 * True only when Lavalink/Shoukaku is actually pointing at the same encoded
 * track Kazagumo exposes as queue.current. Merely having any Shoukaku track is
 * not enough: after a failed/replaced source it can briefly retain the previous
 * encoded track while queue.current already points at the next request.
 */
export function activeTrackMatchesCurrent(player) {
  const current = encodedTrack(player?.queue?.current);
  const active = encodedTrack(player?.shoukaku?.track);
  return Boolean(current && active && current === active);
}

export function playbackNeedsStart(player) {
  if (!player || !hasQueuedWork(player)) return false;
  // Never turn any explicit paused state into an implicit resume.
  if (player.paused || player.shoukaku?.paused) return false;

  // If Kazagumo has a current item, the active Lavalink Base64 must be that
  // exact item. A stale non-empty Shoukaku track must not suppress playback.
  if (player.queue?.current) return !activeTrackMatchesCurrent(player);

  // Queue-only state: preserve the old guard if Lavalink still has an active
  // track during a very short queue transition.
  return !encodedTrack(player.shoukaku?.track);
}

export async function ensureQueuedPlayback(player) {
  if (!playbackNeedsStart(player)) {
    return {
      started: false,
      active: Boolean(player?.paused || player?.shoukaku?.paused || activeTrackMatchesCurrent(player)),
    };
  }

  await player.play();

  // Shoukaku updates its local encoded track when playTrack() completes. Require
  // an exact match here; queue.current alone is not proof that audio was sent to
  // Lavalink and was the source of the v0.1.11 ghost-Now-Playing regression.
  if (!activeTrackMatchesCurrent(player)) {
    throw new Error('The selected track could not start playback. EZ Music will retry/fallback when the source reports a playback error.');
  }

  return { started: true, active: true };
}
