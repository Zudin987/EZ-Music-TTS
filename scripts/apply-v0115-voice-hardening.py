from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

# --- lifecycle helpers -----------------------------------------------------
path = Path('src/lavalink-lifecycle.js')
text = path.read_text(encoding='utf-8')
old = """const VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([\n  4006,\n  4009,\n  4014,\n  4017,\n  4021,\n  4022,\n]);\n\nexport const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;\n"""
new = """// Koe already retries session-timeout/server-crash/transient voice closes.\n// These codes instead require a fresh Discord gateway voice handshake because\n// the old voice websocket/session must not simply be resumed.\nconst VOICE_CLOSE_REFRESH_SESSION = new Set([4006, 4014, 4022]);\n\n// A DAVE-required close on a DAVE-capable Lavalink stack indicates a persistent\n// capability mismatch; a rate-limit close must not be hammered with rejoins.\nconst VOICE_CLOSE_IMMEDIATE_RETIRE = new Set([4017, 4021]);\n\nexport const VOICE_CLOSE_RECOVERY_GRACE_MS = 5_000;\n"""
text = replace_once(text, old, new, 'voice close sets')
old = """export function voiceCloseDisposition(code) {\n  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(Number(code || 0))) return 'retire';\n  return 'watch';\n}\n"""
new = """export function voiceCloseDisposition(code) {\n  const numeric = Number(code || 0);\n  if (VOICE_CLOSE_IMMEDIATE_RETIRE.has(numeric)) return 'retire';\n  if (VOICE_CLOSE_REFRESH_SESSION.has(numeric)) return 'refresh';\n  return 'watch';\n}\n\nexport function botVoiceChannelTransition(botUserId, oldState, newState) {\n  const botId = String(botUserId || '');\n  const oldId = String(oldState?.id || '');\n  const newId = String(newState?.id || '');\n  if (!botId || (oldId !== botId && newId !== botId)) return null;\n\n  const oldChannelId = oldState?.channelId || null;\n  const channelId = newState?.channelId || null;\n  if (oldChannelId === channelId) return null;\n  if (channelId) {\n    return {\n      type: oldChannelId ? 'moved' : 'joined',\n      oldChannelId,\n      channelId,\n    };\n  }\n  if (oldChannelId) return { type: 'left', oldChannelId, channelId: null };\n  return null;\n}\n"""
text = replace_once(text, old, new, 'voice disposition')
path.write_text(text, encoding='utf-8')

# --- music lifecycle integration ------------------------------------------
path = Path('src/music.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceCloseDisposition, VOICE_CLOSE_RECOVERY_GRACE_MS } from './lavalink-lifecycle.js';",
    "import { botVoiceChannelTransition, nodeReconnectDelayMs, resolveLifecycleEventTrack, voiceCloseDisposition, VOICE_CLOSE_RECOVERY_GRACE_MS } from './lavalink-lifecycle.js';",
    'lifecycle import',
)

anchor = """  function clearVoiceCloseRecoveryTimer(guildId) {\n    const timer = voiceCloseRecoveryTimers.get(guildId);\n    if (timer) clearTimeout(timer);\n    voiceCloseRecoveryTimers.delete(guildId);\n  }\n\n"""
insert = """  function clearVoiceCloseRecoveryTimer(guildId) {\n    const timer = voiceCloseRecoveryTimers.get(guildId);\n    if (timer) clearTimeout(timer);\n    voiceCloseRecoveryTimers.delete(guildId);\n  }\n\n  function currentBotVoiceChannelId(guildId) {\n    const guild = client.guilds.cache.get(guildId);\n    const botId = client.user?.id;\n    if (!guild || !botId) return null;\n    return guild.voiceStates?.cache?.get(botId)?.channelId || guild.members?.me?.voice?.channelId || null;\n  }\n\n  function syncPlayerVoiceChannel(player, channelId) {\n    if (!player || !channelId || music.players.get(player.guildId) !== player) return false;\n    const previous = player.voiceId || voiceIds.get(player.guildId) || null;\n    player.voiceId = channelId;\n    voiceIds.set(player.guildId, channelId);\n    if (previous === channelId) return false;\n\n    console.log(`[voice] synchronized ${player.guildId} channel ${previous || 'none'} -> ${channelId}`);\n    scheduleRecoverySave(player, 0);\n\n    // Voice channel status belongs to the channel, so do not leave a stale\n    // Playing: label behind when an administrator moves the bot.\n    if (previous) {\n      void client.rest.put(`/channels/${previous}/voice-status`, { body: { status: null } }).catch(() => {});\n    }\n    if (player.queue.current) void setVoiceStatus(player, player.queue.current);\n    return true;\n  }\n\n  function scheduleVoiceTransportWatchdog(player, reason) {\n    if (!player || music.players.get(player.guildId) !== player) return false;\n    const guildId = player.guildId;\n    clearVoiceCloseRecoveryTimer(guildId);\n    const timer = setTimeout(() => {\n      voiceCloseRecoveryTimers.delete(guildId);\n      if (music.players.get(guildId) !== player || !player.voiceId) return;\n      const actualChannelId = currentBotVoiceChannelId(guildId);\n      if (actualChannelId) syncPlayerVoiceChannel(player, actualChannelId);\n      void retirePlayerForTransportLoss(player, reason);\n    }, VOICE_CLOSE_RECOVERY_GRACE_MS);\n    timer.unref?.();\n    voiceCloseRecoveryTimers.set(guildId, timer);\n    return true;\n  }\n\n"""
text = replace_once(text, anchor, insert, 'voice lifecycle helpers')

old = """  async function handlePlayerClosed(player, data) {\n    if (!player || music.players.get(player.guildId) !== player || !player.voiceId) return;\n    const code = Number(data?.code || 0);\n    const reason = String(data?.reason || 'voice websocket closed');\n    console.warn(`[voice] Discord voice websocket closed for ${player.guildId}: ${code || 'unknown'} ${reason}`);\n    clearPendingPlaybackHistory(player.guildId);\n    checkpointRecovery(player);\n    clearVoiceCloseRecoveryTimer(player.guildId);\n\n    if (voiceCloseDisposition(code) === 'retire') {\n      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);\n      return;\n    }\n\n    // Some transient voice closes recover inside Lavalink/Koe. Give that path a\n    // short chance and cancel this watchdog as soon as a connected playerUpdate\n    // arrives. If it never does, preserve recovery and retire the stale wrapper.\n    const timer = setTimeout(() => {\n      voiceCloseRecoveryTimers.delete(player.guildId);\n      if (music.players.get(player.guildId) !== player || !player.voiceId) return;\n      void retirePlayerForTransportLoss(player, `Discord voice did not recover after close ${code}: ${reason}`);\n    }, VOICE_CLOSE_RECOVERY_GRACE_MS);\n    timer.unref?.();\n    voiceCloseRecoveryTimers.set(player.guildId, timer);\n  }\n"""
new = """  async function handlePlayerClosed(player, data) {\n    if (!player || music.players.get(player.guildId) !== player || !player.voiceId) return;\n    const code = Number(data?.code || 0);\n    const reason = String(data?.reason || 'voice websocket closed');\n    const disposition = voiceCloseDisposition(code);\n    const alreadyRecovering = voiceCloseRecoveryTimers.has(player.guildId);\n    const actualChannelId = currentBotVoiceChannelId(player.guildId);\n    if (actualChannelId) syncPlayerVoiceChannel(player, actualChannelId);\n\n    console.warn(`[voice] Discord voice websocket closed for ${player.guildId}: ${code || 'unknown'} ${reason} (${disposition})`);\n    clearPendingPlaybackHistory(player.guildId);\n    checkpointRecovery(player);\n\n    if (disposition === 'retire') {\n      clearVoiceCloseRecoveryTimer(player.guildId);\n      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);\n      return;\n    }\n\n    // Koe already retries transient/time-out/server-crash closes itself. For\n    // 4006/4014/4022 the old voice session must not be resumed, so request one\n    // fresh main-gateway voice handshake if Discord still says the bot is in a\n    // channel. A kicked/deleted-channel bot has no actual channel and simply\n    // falls through to the same bounded watchdog.\n    if (disposition === 'refresh' && actualChannelId && !alreadyRecovering) {\n      try {\n        player.setVoiceChannel(actualChannelId);\n        console.warn(`[voice] requested a fresh Discord voice session for ${player.guildId} after close ${code}`);\n      } catch (error) {\n        console.warn('[voice] fresh-session request failed', error?.message || error);\n      }\n    }\n\n    scheduleVoiceTransportWatchdog(\n      player,\n      `Discord voice did not recover after close ${code}: ${reason}`,\n    );\n  }\n"""
text = replace_once(text, old, new, 'playerClosed handler')

old = """  client.on('voiceStateUpdate', (oldState, newState) => {\n    const guildId = newState.guild?.id || oldState.guild?.id;\n    const player = guildId ? music.players.get(guildId) : null;\n    if (!player) return;\n    const voiceId = player.voiceId || voiceIds.get(guildId);\n    if (!voiceId || (oldState.channelId !== voiceId && newState.channelId !== voiceId)) return;\n    evaluateVoiceOccupancy(player);\n  });\n"""
new = """  client.on('voiceStateUpdate', (oldState, newState) => {\n    const guildId = newState.guild?.id || oldState.guild?.id;\n    const player = guildId ? music.players.get(guildId) : null;\n    if (!player) return;\n\n    const botTransition = botVoiceChannelTransition(client.user?.id, oldState, newState);\n    if (botTransition?.channelId) {\n      // Shoukaku receives the Discord gateway packet itself, but Kazagumo's\n      // public player.voiceId is not updated when an administrator moves the\n      // bot. Keep the wrapper/recovery/command checks synchronized with the\n      // gateway's actual channel without generating another move request.\n      syncPlayerVoiceChannel(player, botTransition.channelId);\n      evaluateVoiceOccupancy(player);\n      return;\n    }\n    if (botTransition?.type === 'left') {\n      clearPendingPlaybackHistory(guildId);\n      checkpointRecovery(player);\n      scheduleVoiceTransportWatchdog(player, 'Discord gateway reports the bot left voice and it did not recover');\n      return;\n    }\n\n    const voiceId = player.voiceId || voiceIds.get(guildId);\n    if (!voiceId || (oldState.channelId !== voiceId && newState.channelId !== voiceId)) return;\n    evaluateVoiceOccupancy(player);\n  });\n"""
text = replace_once(text, old, new, 'voiceStateUpdate handler')
path.write_text(text, encoding='utf-8')

# --- Lavalink SoundCloud preview filter -----------------------------------
path = Path('lavalink/application.yml')
text = path.read_text(encoding='utf-8')
old = """    youtubePlaylistLoadLimit: 3\n    # Diagnostic only: report unusually long JVM GC pauses so they can be\n"""
new = """    youtubePlaylistLoadLimit: 3\n    # SoundCloud is the emergency audio fallback when anonymous YouTube\n    # playback is blocked. Never surface subscription-only preview tracks as if\n    # they were a full-song fallback. This is filtering only, not audio DSP.\n    soundcloudFilterOutPreviewTracks: true\n    # Diagnostic only: report unusually long JVM GC pauses so they can be\n"""
text = replace_once(text, old, new, 'SoundCloud preview filter')
path.write_text(text, encoding='utf-8')

# --- version ---------------------------------------------------------------
path = Path('package.json')
pkg = json.loads(path.read_text(encoding='utf-8'))
if pkg.get('version') != '0.1.14':
    raise SystemExit(f"package version expected 0.1.14, got {pkg.get('version')}")
pkg['version'] = '0.1.15'
path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')

path = Path('package-lock.json')
lock = json.loads(path.read_text(encoding='utf-8'))
if lock.get('version') != '0.1.14' or lock.get('packages', {}).get('', {}).get('version') != '0.1.14':
    raise SystemExit('package-lock root version is not 0.1.14')
lock['version'] = '0.1.15'
lock['packages']['']['version'] = '0.1.15'
path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

# Keep older release tests validating the current package version.
for test_path in Path('test').glob('*.test.js'):
    source = test_path.read_text(encoding='utf-8')
    updated = source.replace("assert.equal(pkg.version, '0.1.14');", "assert.equal(pkg.version, '0.1.15');")
    test_path.write_text(updated, encoding='utf-8')

# Update v0.1.14 lifecycle close-code expectations to the safer policy.
path = Path('test/lavalink-lifecycle-v0114.test.js')
text = path.read_text(encoding='utf-8')
old = """test('Discord close codes that must not reconnect retire immediately', () => {\n  for (const code of [4006, 4009, 4014, 4017, 4021, 4022]) assert.equal(voiceCloseDisposition(code), 'retire');\n  assert.equal(voiceCloseDisposition(4015), 'watch');\n  assert.equal(voiceCloseDisposition(1006), 'watch');\n});\n"""
new = """test('Discord voice close policy distinguishes fresh-session, transient, and hard-stop cases', () => {\n  for (const code of [4006, 4014, 4022]) assert.equal(voiceCloseDisposition(code), 'refresh');\n  for (const code of [4009, 4015, 1006]) assert.equal(voiceCloseDisposition(code), 'watch');\n  for (const code of [4017, 4021]) assert.equal(voiceCloseDisposition(code), 'retire');\n});\n"""
text = replace_once(text, old, new, 'legacy lifecycle close-code test')
path.write_text(text, encoding='utf-8')

# New permanent tests.
Path('test/voice-move-v0115.test.js').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { botVoiceChannelTransition, voiceCloseDisposition } from '../src/lavalink-lifecycle.js';

const bot = 'bot-user';
const state = (id, channelId) => ({ id, channelId });

test('bot voice move and join transitions keep the destination channel', () => {
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, 'B')),
    { type: 'moved', oldChannelId: 'A', channelId: 'B' },
  );
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, null), state(bot, 'B')),
    { type: 'joined', oldChannelId: null, channelId: 'B' },
  );
});

test('bot voice leave is distinguishable from unrelated member changes', () => {
  assert.deepEqual(
    botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, null)),
    { type: 'left', oldChannelId: 'A', channelId: null },
  );
  assert.equal(botVoiceChannelTransition(bot, state('human', 'A'), state('human', 'B')), null);
  assert.equal(botVoiceChannelTransition(bot, state(bot, 'A'), state(bot, 'A')), null);
});

test('voice close policy follows Koe and Discord fresh-session behavior', () => {
  for (const code of [4006, 4014, 4022]) assert.equal(voiceCloseDisposition(code), 'refresh');
  for (const code of [4009, 4015, 1006, 4000]) assert.equal(voiceCloseDisposition(code), 'watch');
  for (const code of [4017, 4021]) assert.equal(voiceCloseDisposition(code), 'retire');
});

test('v0.1.15 wires bot move synchronization and SoundCloud preview filtering', () => {
  const music = fs.readFileSync('src/music.js', 'utf8');
  const app = fs.readFileSync('lavalink/application.yml', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(music, /botVoiceChannelTransition\(client\.user\?\.id/);
  assert.match(music, /syncPlayerVoiceChannel\(player, botTransition\.channelId\)/);
  assert.match(music, /scheduleVoiceTransportWatchdog/);
  assert.match(music, /player\.setVoiceChannel\(actualChannelId\)/);
  assert.match(music, /currentBotVoiceChannelId/);
  assert.match(app, /soundcloudFilterOutPreviewTracks:\s*true/);
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.equal(pkg.version, '0.1.15');
});
''', encoding='utf-8')

# README release note.
path = Path('README.md')
text = path.read_text(encoding='utf-8').rstrip() + "\n"
section = r'''

## Voice move and fallback hardening (v0.1.15)

EZ Music now treats the Discord gateway's bot voice state as the source of truth for channel moves. If an administrator moves the bot between voice channels, Kazagumo's cached `player.voiceId`, command same-channel checks, occupancy handling, voice-channel status, and SQLite recovery snapshot are synchronized to the new channel instead of staying pinned to the old one. A gateway-reported leave gets the same short transport-recovery watchdog used for voice websocket closures, so a kick cannot leave a cached ghost player.

Voice close handling is also aligned more closely with the current Discord/Koe lifecycle: session-invalid/disconnected/call-terminated closes (`4006`, `4014`, `4022`) request one fresh Discord gateway voice handshake when the bot is still present in a channel; Koe-managed transient closes are allowed to recover; DAVE-required/rate-limit hard failures (`4017`, `4021`) retire safely rather than looping. SoundCloud preview-only subscription tracks are filtered at Lavalink so emergency source fallback prefers complete songs.

This remains event-driven and keeps the existing raw-audio/low-memory profile unchanged: no DSP, OAuth, poToken service, extra Lavalink node, polling daemon, buffer increase, or heap increase.
'''
if '## Voice move and fallback hardening (v0.1.15)' not in text:
    text += section
path.write_text(text, encoding='utf-8')

print('Applied v0.1.15 voice move / close-code / SoundCloud preview hardening')
