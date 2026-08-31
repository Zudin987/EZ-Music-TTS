function hasQueuedWork(player) {
  return Boolean(player?.queue?.current) || Number(player?.queue?.length || 0) > 0;
}

export function playbackNeedsStart(player) {
  if (!player || !hasQueuedWork(player)) return false;
  // Never turn a deliberate pause into an implicit resume.
  if (player.queue?.current && (player.paused || player.shoukaku?.paused)) return false;
  // Shoukaku's track field reflects whether Lavalink actually has a track.
  // Kazagumo's wrapper `playing` flag can briefly/stale remain true after a
  // failed/ended item, so do not use it as the only start gate.
  return !player.shoukaku?.track;
}

export async function ensureQueuedPlayback(player) {
  if (!playbackNeedsStart(player)) {
    return {
      started: false,
      active: Boolean(player?.shoukaku?.track || player?.queue?.current || player?.paused),
    };
  }

  await player.play();

  // Kazagumo can emit PlayerResolveError, clear queue.current and return from
  // play() without throwing. Treat that as a failed start so callers never say
  // "Queued"/"Playing" when nothing survived resolution.
  const active = Boolean(player?.shoukaku?.track || player?.queue?.current);
  if (!active) {
    throw new Error('The selected track could not start playback. Try the song name again or use a direct YouTube link.');
  }

  return { started: true, active: true };
}
