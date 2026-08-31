from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

music_path = Path('src/music.js')
music = music_path.read_text(encoding='utf-8')

music = replace_once(
    music,
    "import { Connectors } from 'shoukaku';",
    "import { Connectors, Constants } from 'shoukaku';",
    'shoukaku import',
)
music = replace_once(
    music,
    "import { playbackHistoryFingerprint, playbackHistoryReady } from './playback-history.js';",
    "import { playbackHistoryFingerprint, playbackHistoryReady } from './playback-history.js';\nimport { nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceCloseDisposition, VOICE_CLOSE_RECOVERY_GRACE_MS } from './lavalink-lifecycle.js';",
    'lifecycle import',
)
music = replace_once(
    music,
    "const PLAYBACK_FALLBACK_SETTLE_TIMEOUT_MS = 2_000;",
    "const PLAYBACK_FALLBACK_SETTLE_TIMEOUT_MS = 2_000;\nconst LAVALINK_NODE_NAME = 'local';",
    'node name constant',
)
music = replace_once(
    music,
    "    reconnectTries: 8,\n    restTimeout: 20_000,",
    "    // Shoukaku 4.3.0 has an upstream reconnect bug where a failed attempt can\n    // leave a stale connectError that tears down a later successful retry in the\n    // same connect() loop. One library attempt + our event-driven node supervisor\n    // avoids that bug without replacing/forking Shoukaku.\n    reconnectTries: 1,\n    reconnectInterval: 2,\n    restTimeout: 20_000,",
    'reconnect options',
)
music = replace_once(
    music,
    "  const pendingPlaybackHistory = new Map();\n  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);",
    "  const pendingPlaybackHistory = new Map();\n  const voiceCloseRecoveryTimers = new Map();\n  const transportRetirements = new Map();\n  let localNodeReconnectTimer = null;\n  let localNodeReconnectAttempt = 0;\n  let localNodeRetryAt = 0;\n  let localNodeEverReady = false;\n  let localNodeState = 'starting';\n  let localNodeLastError = '';\n  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);",
    'lifecycle state',
)

anchor = "  const searchPreferred = (target, query, requester) => resolvePreferredSearch(target, query, requester, { spotifyConfigured });\n\n"
insert = r'''  const searchPreferred = (target, query, requester) => resolvePreferredSearch(target, query, requester, { spotifyConfigured });

  function clearVoiceCloseRecoveryTimer(guildId) {
    const timer = voiceCloseRecoveryTimers.get(guildId);
    if (timer) clearTimeout(timer);
    voiceCloseRecoveryTimers.delete(guildId);
  }

  function clearLocalNodeReconnectTimer() {
    if (localNodeReconnectTimer) clearTimeout(localNodeReconnectTimer);
    localNodeReconnectTimer = null;
    localNodeRetryAt = 0;
  }

  function isLocalNodeConnected() {
    return music.shoukaku.nodes.get(LAVALINK_NODE_NAME)?.state === Constants.State.CONNECTED;
  }

  function getLavalinkNodeHealth() {
    const node = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
    if (node?.state === Constants.State.CONNECTED) {
      return { status: 'connected', attempt: 0, retryAt: 0, lastError: '' };
    }
    const connecting = node?.state === Constants.State.CONNECTING;
    return {
      status: connecting || localNodeReconnectTimer || localNodeState === 'reconnecting' ? 'reconnecting' : localNodeState,
      attempt: localNodeReconnectAttempt,
      retryAt: localNodeRetryAt,
      lastError: localNodeLastError,
    };
  }

  async function retirePlayerForTransportLoss(player, reason) {
    if (!player || music.players.get(player.guildId) !== player) return false;
    const guildId = player.guildId;
    const existing = transportRetirements.get(guildId);
    if (existing) return existing;

    const retirement = (async () => {
      console.warn(`[transport] retiring stale player ${guildId}: ${String(reason || 'transport lost').slice(0, 220)}`);
      // Snapshot current + upcoming + held fallback work before any in-memory
      // cleanup. This makes a node/server/voice failure recoverable via /status.
      checkpointRecovery(player);
      invalidateQueueWork(guildId);
      clearVoiceCloseRecoveryTimer(guildId);

      // Shoukaku's leaveVoiceChannel is intentionally used instead of
      // KazagumoPlayer.destroy(): it catches a dead-node REST destroy failure but
      // still sends Discord channel_id:null and removes Shoukaku connection state.
      try { await music.shoukaku.leaveVoiceChannel(guildId); }
      catch (error) { console.warn('[transport] Shoukaku voice cleanup failed', error?.message || error); }

      if (music.players.get(guildId) === player) music.players.delete(guildId);
      player.playing = false;
      player.paused = false;
      player.voiceId = null;
      await handlePlayerDestroy(player);
      return true;
    })().finally(() => {
      if (transportRetirements.get(guildId) === retirement) transportRetirements.delete(guildId);
    });

    transportRetirements.set(guildId, retirement);
    return retirement;
  }

  async function retirePlayersForNodeLoss(reason) {
    const affected = [...music.players.values()].filter((player) => player?.shoukaku?.node?.name === LAVALINK_NODE_NAME);
    if (!affected.length) return 0;
    await Promise.allSettled(affected.map((player) => retirePlayerForTransportLoss(player, reason)));
    return affected.length;
  }

  function scheduleLocalNodeReplacement(reason = 'Lavalink node unavailable') {
    if (isLocalNodeConnected() || localNodeReconnectTimer) return false;
    const existing = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
    if (existing?.state === Constants.State.CONNECTING) return false;
    if (existing && existing.state !== Constants.State.CONNECTED) music.shoukaku.nodes.delete(LAVALINK_NODE_NAME);

    localNodeState = 'reconnecting';
    localNodeLastError = String(reason || '').slice(0, 500);
    const attempt = ++localNodeReconnectAttempt;
    const delay = nodeReconnectDelayMs(attempt);
    localNodeRetryAt = Date.now() + delay;
    console.warn(`[lavalink] local node unavailable; replacement attempt ${attempt} in ${Math.round(delay / 1000)}s`);

    localNodeReconnectTimer = setTimeout(() => {
      localNodeReconnectTimer = null;
      localNodeRetryAt = 0;
      if (isLocalNodeConnected()) return;
      const current = music.shoukaku.nodes.get(LAVALINK_NODE_NAME);
      if (current?.state === Constants.State.CONNECTING) return;
      if (current) music.shoukaku.nodes.delete(LAVALINK_NODE_NAME);
      try {
        music.shoukaku.addNode(nodes[0]);
      } catch (error) {
        localNodeLastError = String(error?.message || error).slice(0, 500);
        scheduleLocalNodeReplacement(localNodeLastError);
      }
    }, delay);
    localNodeReconnectTimer.unref?.();
    return true;
  }

'''
music = replace_once(music, anchor, insert, 'lifecycle functions')

old_listeners = """  music.shoukaku.on('ready', (name, resumed) => console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`));\n  music.shoukaku.on('error', (name, error) => console.error(`[lavalink] ${name}`, error));\n  music.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`));\n"""
new_listeners = r'''  music.shoukaku.on('ready', (name, resumed, libraryResumed = false) => {
    console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`);
    if (name !== LAVALINK_NODE_NAME) return;
    const hadReady = localNodeEverReady;
    localNodeEverReady = true;
    localNodeState = 'connected';
    localNodeLastError = '';
    localNodeReconnectAttempt = 0;
    clearLocalNodeReconnectTimer();

    // A websocket reconnect can succeed while the Lavalink *server session* was
    // lost (for example Lavalink.jar restarted). Server-side resume=false means
    // the cached Kazagumo players no longer exist remotely. Retire them instead
    // of letting /play or /nowplaying operate on ghosts.
    if (hadReady && !resumed && !libraryResumed) {
      void retirePlayersForNodeLoss('Lavalink reconnected with a fresh session; previous remote players no longer exist');
    }
  });
  music.shoukaku.on('reconnecting', (name, left, interval) => {
    if (name === LAVALINK_NODE_NAME) localNodeState = 'reconnecting';
    console.warn(`[lavalink] ${name} reconnecting (${left} library attempt${left === 1 ? '' : 's'} left, ${interval}s interval)`);
  });
  music.shoukaku.on('error', (name, error) => {
    console.error(`[lavalink] ${name}`, error);
    if (name !== LAVALINK_NODE_NAME) return;
    localNodeLastError = String(error?.message || error).slice(0, 500);
    const node = music.shoukaku.nodes.get(name);
    if (!node || node.state === Constants.State.DISCONNECTED) {
      localNodeState = 'unavailable';
      void retirePlayersForNodeLoss(`Lavalink node disconnected: ${localNodeLastError}`);
      scheduleLocalNodeReplacement(localNodeLastError);
    }
  });
  music.shoukaku.on('close', (name, code, reason) => {
    console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`);
    if (name !== LAVALINK_NODE_NAME) return;
    localNodeState = 'reconnecting';
    localNodeLastError = `websocket closed ${code}: ${reason || 'no reason'}`;
    // Persist before Shoukaku attempts session resume. A successful first retry
    // continues normally; a failed retry can then retire the player safely.
    checkpointAllRecoveries();
  });
'''
music = replace_once(music, old_listeners, new_listeners, 'shoukaku listeners')

old_update = """  music.on('playerUpdate', (player) => {\n    commitPendingPlaybackHistory(player);\n"""
new_update = """  music.on('playerUpdate', (player, data) => {\n    if (data?.state?.connected) clearVoiceCloseRecoveryTimer(player.guildId);\n    commitPendingPlaybackHistory(player);\n"""
music = replace_once(music, old_update, new_update, 'playerUpdate signature')

old_exception = """  music.on('playerException', (player, data) => {\n    const message = data?.exception?.message || data?.message || 'track exception';\n    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;\n    const failedId = youtubeTrackId(failedTrack);\n    clearPendingPlaybackHistory(player.guildId, failedTrack);\n    console.warn('[player-exception]', player.guildId, message);\n"""
new_exception = """  music.on('playerException', (player, data) => {\n    const message = data?.exception?.message || data?.message || 'track exception';\n    const failedTrack = resolveLifecycleEventTrack(data?.track, player.queue.current, lastTracks.get(player.guildId) || null);\n    if (!failedTrack) {\n      console.warn('[player-exception]', player.guildId, 'stale track event ignored:', message);\n      return;\n    }\n    const failedId = youtubeTrackId(failedTrack);\n    clearPendingPlaybackHistory(player.guildId, failedTrack);\n    console.warn('[player-exception]', player.guildId, message);\n"""
music = replace_once(music, old_exception, new_exception, 'exception identity')

old_stuck = """  music.on('playerStuck', (player, data) => {\n    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;\n    clearPendingPlaybackHistory(player.guildId, player.queue.current);\n    console.warn('[player-stuck]', player.guildId, message);\n    recordPlaybackFailure(player, message);\n  });\n\n  music.on('playerEmpty', (player) => {\n"""
new_stuck = """  music.on('playerStuck', (player, data) => {\n    const message = `track stuck (${data?.thresholdMs || 'unknown'} ms)`;\n    const failedTrack = resolveLifecycleEventTrack(data?.track, player.queue.current, lastTracks.get(player.guildId) || null);\n    if (!failedTrack) {\n      console.warn('[player-stuck]', player.guildId, 'stale track event ignored:', message);\n      return;\n    }\n    clearPendingPlaybackHistory(player.guildId, failedTrack);\n    console.warn('[player-stuck]', player.guildId, message);\n    recordPlaybackFailure(player, message, { trackOverride: failedTrack });\n  });\n\n  music.on('playerClosed', (player, data) => {\n    void handlePlayerClosed(player, data).catch((error) => console.warn('[player-closed]', error?.message || error));\n  });\n\n  music.on('playerEmpty', (player) => {\n"""
music = replace_once(music, old_stuck, new_stuck, 'stuck/closed handlers')

old_start = """  async function handlePlayerStart(player, track) {\n    clearDisconnect(player.guildId);\n    clearEmptyVoiceTimer(player.guildId);\n"""
new_start = r'''  async function handlePlayerClosed(player, data) {
    if (!player || music.players.get(player.guildId) !== player || !player.voiceId) return;
    const code = Number(data?.code || 0);
    const reason = String(data?.reason || 'voice websocket closed');
    console.warn(`[voice] Discord voice websocket closed for ${player.guildId}: ${code || 'unknown'} ${reason}`);
    clearPendingPlaybackHistory(player.guildId);
    checkpointRecovery(player);
    clearVoiceCloseRecoveryTimer(player.guildId);

    if (voiceCloseDisposition(code) === 'retire') {
      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);
      return;
    }

    // Some transient voice closes recover inside Lavalink/Koe. Give that path a
    // short chance and cancel this watchdog as soon as a connected playerUpdate
    // arrives. If it never does, preserve recovery and retire the stale wrapper.
    const timer = setTimeout(() => {
      voiceCloseRecoveryTimers.delete(player.guildId);
      if (music.players.get(player.guildId) !== player || !player.voiceId) return;
      void retirePlayerForTransportLoss(player, `Discord voice did not recover after close ${code}: ${reason}`);
    }, VOICE_CLOSE_RECOVERY_GRACE_MS);
    timer.unref?.();
    voiceCloseRecoveryTimers.set(player.guildId, timer);
  }

  async function handlePlayerStart(player, track) {
    clearDisconnect(player.guildId);
    clearEmptyVoiceTimer(player.guildId);
    clearVoiceCloseRecoveryTimer(player.guildId);
'''
music = replace_once(music, old_start, new_start, 'playerClosed function')

old_destroy = """    clearDisconnect(player.guildId);\n    clearEmptyVoiceTimer(player.guildId);\n    emptyVoiceAutoPaused.delete(player.guildId);\n"""
new_destroy = """    clearDisconnect(player.guildId);\n    clearEmptyVoiceTimer(player.guildId);\n    clearVoiceCloseRecoveryTimer(player.guildId);\n    emptyVoiceAutoPaused.delete(player.guildId);\n"""
music = replace_once(music, old_destroy, new_destroy, 'destroy voice timer')

old_ensure = """  async function ensurePlayer(interaction) {\n    const voice = interaction.member?.voice?.channel;\n    if (!voice) throw new Error('Join a voice channel first.');\n\n    const sourceHealth = getSourceHealth(interaction.guildId);\n"""
new_ensure = r'''  async function ensurePlayer(interaction) {
    const voice = interaction.member?.voice?.channel;
    if (!voice) throw new Error('Join a voice channel first.');

    const nodeHealth = getLavalinkNodeHealth();
    if (nodeHealth.status !== 'connected') {
      const retrySeconds = nodeHealth.retryAt > Date.now() ? Math.max(1, Math.ceil((nodeHealth.retryAt - Date.now()) / 1000)) : 0;
      throw queueCanceledError(`Lavalink is ${nodeHealth.status === 'reconnecting' ? 'reconnecting' : 'temporarily unavailable'}${retrySeconds ? `; retrying in about ${retrySeconds}s` : ''}. Your saved recovery queue is preserved.`);
    }

    const sourceHealth = getSourceHealth(interaction.guildId);
'''
music = replace_once(music, old_ensure, new_ensure, 'ensure node guard')

old_runtime_return = """      lavalink,\n      queueLimit: MAX_UPCOMING_QUEUE,\n    };\n"""
new_runtime_return = """      lavalink,\n      lavalinkNode: getLavalinkNodeHealth(),\n      queueLimit: MAX_UPCOMING_QUEUE,\n    };\n"""
music = replace_once(music, old_runtime_return, new_runtime_return, 'runtime node health')

old_return = """    getRuntimeStats,\n    getSourceHealth,\n    isAutoPausedForEmptyVoice: (guildId) => emptyVoiceAutoPaused.has(guildId),\n"""
new_return = """    getRuntimeStats,\n    getSourceHealth,\n    getLavalinkNodeHealth,\n    isAutoPausedForEmptyVoice: (guildId) => emptyVoiceAutoPaused.has(guildId),\n"""
music = replace_once(music, old_return, new_return, 'export node health')

music_path.write_text(music, encoding='utf-8')

# Commands: surface actual node lifecycle instead of optimistic/stale player state.
commands_path = Path('src/commands.js')
commands = commands_path.read_text(encoding='utf-8')
commands = replace_once(
    commands,
    "  getRuntimeStats,\n  getSourceHealth,\n  isAutoPausedForEmptyVoice,",
    "  getRuntimeStats,\n  getSourceHealth,\n  getLavalinkNodeHealth,\n  isAutoPausedForEmptyVoice,",
    'commands node health arg',
)
commands = replace_once(
    commands,
    "        const runtime = await getRuntimeStats();\n        const recovery = !player ? getRecoverableSession(interaction.guildId) : null;\n        let lavalink = 'Unavailable';\n        try { await music.getLeastUsedNode(); lavalink = 'Connected'; } catch { /* no online node */ }\n",
    "        const runtime = await getRuntimeStats();\n        const recovery = !player ? getRecoverableSession(interaction.guildId) : null;\n        const nodeHealth = getLavalinkNodeHealth();\n        const nodeRetrySeconds = nodeHealth.retryAt > Date.now() ? Math.max(1, Math.ceil((nodeHealth.retryAt - Date.now()) / 1000)) : 0;\n        const lavalink = nodeHealth.status === 'connected'\n          ? 'Connected'\n          : nodeHealth.status === 'reconnecting'\n            ? `Reconnecting${nodeRetrySeconds ? ` • retry in ~${nodeRetrySeconds}s` : ''}`\n            : nodeHealth.status === 'starting' ? 'Starting' : 'Unavailable';\n",
    'status node health',
)
commands_path.write_text(commands, encoding='utf-8')

# Package version/check command.
package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '0.1.14'
check = package['scripts']['check']
needle = 'node --check src/playback-history.js'
if 'src/lavalink-lifecycle.js' not in check:
    if needle not in check:
        raise SystemExit('package check insertion anchor missing')
    check = check.replace(needle, needle + ' && node --check src/lavalink-lifecycle.js')
package['scripts']['check'] = check
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

# Lockfile only needs root version update; npm install/ci verifier will validate it.
lock_path = Path('package-lock.json')
lock = json.loads(lock_path.read_text(encoding='utf-8'))
lock['version'] = '0.1.14'
lock['packages']['']['version'] = '0.1.14'
lock_path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

readme_path = Path('README.md')
readme = readme_path.read_text(encoding='utf-8')
readme += """

## Transport lifecycle hardening (v0.1.14)

EZ Music now treats Lavalink-node state, Discord voice-WebSocket state, and track-event identity as separate lifecycle signals instead of assuming a cached Kazagumo player is healthy. Shoukaku 4.3.0's multi-attempt reconnect bug is avoided by using one library reconnect attempt at a time plus a tiny event-driven local-node supervisor with bounded backoff. If the local Lavalink session is genuinely lost, live players are snapshotted to SQLite and retired rather than left as ghost players; `/status` exposes reconnecting/unavailable node state and `/play` refuses to queue into a dead node.

Discord voice-WebSocket closes are also watched: close codes that Discord says should not reconnect retire the stale player immediately, while other closes get a short recovery grace window and are retired only if no connected player update arrives. Lavalink v4's event-provided Track object is used to reject late TrackException/TrackStuck events from a previous song, preventing a stale event from skipping or source-fallbacking the new current song.

This hardening is event-driven and adds no polling service, audio filters, extra Lavalink node, buffer increase, or heap increase.
"""
readme_path.write_text(readme, encoding='utf-8')

# Regression tests.
test_path = Path('test/lavalink-lifecycle-v0114.test.js')
test_path.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventTrackMatches, nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceCloseDisposition } from '../src/lavalink-lifecycle.js';

test('node reconnect backoff is bounded and becomes 30s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(nodeReconnectDelayMs), [2000, 5000, 10000, 15000, 30000, 30000]);
});

test('Discord close codes that must not reconnect retire immediately', () => {
  for (const code of [4006, 4009, 4014, 4017, 4021, 4022]) assert.equal(voiceCloseDisposition(code), 'retire');
  assert.equal(voiceCloseDisposition(4015), 'watch');
  assert.equal(voiceCloseDisposition(1006), 'watch');
});

test('event identity prefers exact encoded Lavalink track', () => {
  const current = { track: 'encoded-new', identifier: 'same-id', sourceName: 'youtube', uri: 'https://x/new' };
  const event = { encoded: 'encoded-old', info: { identifier: 'same-id', sourceName: 'youtube', uri: 'https://x/new' } };
  assert.equal(eventTrackMatches(event, current), false);
});

test('late event from previous song never resolves against a newer current song', () => {
  const current = { track: 'new64', identifier: 'new', sourceName: 'youtube' };
  const previous = { track: 'old64', identifier: 'old', sourceName: 'youtube' };
  const event = { encoded: 'old64', info: { identifier: 'old', sourceName: 'youtube' } };
  assert.equal(resolveLifecycleEventTrack(event, current, previous), null);
  assert.equal(resolveLifecycleEventTrack(event, null, previous), previous);
});

test('missing event track keeps Shoukaku 4.3.0 compatibility fallback', () => {
  const current = { track: 'new64' };
  const previous = { track: 'old64' };
  assert.equal(resolveLifecycleEventTrack(null, current, previous), current);
});

test('v0.1.14 source wires node, voice close, and stale-event protections', () => {
  const music = fs.readFileSync('src/music.js', 'utf8');
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(music, /reconnectTries:\s*1/);
  assert.match(music, /reconnectInterval:\s*2/);
  assert.match(music, /Constants\.State\.CONNECTED/);
  assert.match(music, /scheduleLocalNodeReplacement/);
  assert.match(music, /leaveVoiceChannel\(guildId\)/);
  assert.match(music, /music\.on\('playerClosed'/);
  assert.match(music, /resolveLifecycleEventTrack\(data\?\.track/);
  assert.match(music, /getLavalinkNodeHealth/);
  assert.match(commands, /getLavalinkNodeHealth/);
  assert.equal(pkg.version, '0.1.14');
});
''', encoding='utf-8')

print('Applied v0.1.14 lifecycle hardening patch')
