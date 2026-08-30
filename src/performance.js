export function emptyVoiceTransition({ hasHuman, hasCurrentTrack, playing, paused, autoPaused }) {
  if (hasHuman) return autoPaused && hasCurrentTrack && paused ? 'resume' : 'none';
  if (hasCurrentTrack && playing && !paused) return 'pause';
  return 'none';
}

// Local diagnostic heuristic, not an official Discord quality grade.
export function voiceTransportQuality(pingMs) {
  const ping = Number(pingMs);
  if (!Number.isFinite(ping) || ping <= 0) return 'Measuring';
  if (ping < 60) return 'Excellent';
  if (ping < 120) return 'Good';
  if (ping < 200) return 'Elevated';
  return 'Poor';
}
