export async function setPlayerPaused(player, paused) {
  if (!player?.shoukaku?.setPaused) throw new Error('Player voice transport is unavailable.');
  if (typeof paused !== 'boolean') throw new TypeError('paused must be a boolean');

  const alreadyWrapper = Boolean(player.paused) === paused;
  const alreadyTransport = Boolean(player.shoukaku.paused) === paused;
  if (alreadyWrapper && alreadyTransport) return false;

  // Kazagumo 3.4.3's pause() fires this Promise without awaiting/catching it.
  // Await Shoukaku directly so REST failures are observable instead of becoming
  // process-level unhandledRejection events. Only publish wrapper state after
  // Lavalink accepted the change.
  await player.shoukaku.setPaused(paused);
  player.paused = paused;
  player.playing = !paused;
  return true;
}

export async function stopPlayerTrack(player) {
  if (!player?.shoukaku?.stopTrack) throw new Error('Player voice transport is unavailable.');

  // Kazagumo 3.4.3's skip() also drops this Promise. Await the underlying REST
  // request so callers can handle a dead/restarting Lavalink node explicitly.
  await player.shoukaku.stopTrack();
  return true;
}
