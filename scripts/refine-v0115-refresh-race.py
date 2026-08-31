from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

path = Path('src/music.js')
text = path.read_text(encoding='utf-8')

text = replace_once(
    text,
    "  const voiceCloseRecoveryTimers = new Map();\n  const transportRetirements = new Map();",
    "  const voiceCloseRecoveryTimers = new Map();\n  const voiceFreshSessionTimers = new Map();\n  const transportRetirements = new Map();",
    'voice timer state',
)

old = """  function clearVoiceCloseRecoveryTimer(guildId) {\n    const timer = voiceCloseRecoveryTimers.get(guildId);\n    if (timer) clearTimeout(timer);\n    voiceCloseRecoveryTimers.delete(guildId);\n  }\n\n  function currentBotVoiceChannelId(guildId) {\n"""
new = """  function clearVoiceCloseRecoveryTimer(guildId) {\n    const timer = voiceCloseRecoveryTimers.get(guildId);\n    if (timer) clearTimeout(timer);\n    voiceCloseRecoveryTimers.delete(guildId);\n  }\n\n  function clearVoiceFreshSessionTimer(guildId) {\n    const timer = voiceFreshSessionTimers.get(guildId);\n    if (timer) clearTimeout(timer);\n    voiceFreshSessionTimers.delete(guildId);\n  }\n\n  function currentBotVoiceChannelId(guildId) {\n"""
text = replace_once(text, old, new, 'fresh-session timer clear')

anchor = """  function scheduleVoiceTransportWatchdog(player, reason) {\n    if (!player || music.players.get(player.guildId) !== player) return false;\n    const guildId = player.guildId;\n    clearVoiceCloseRecoveryTimer(guildId);\n    const timer = setTimeout(() => {\n      voiceCloseRecoveryTimers.delete(guildId);\n      if (music.players.get(guildId) !== player || !player.voiceId) return;\n      const actualChannelId = currentBotVoiceChannelId(guildId);\n      if (actualChannelId) syncPlayerVoiceChannel(player, actualChannelId);\n      void retirePlayerForTransportLoss(player, reason);\n    }, VOICE_CLOSE_RECOVERY_GRACE_MS);\n    timer.unref?.();\n    voiceCloseRecoveryTimers.set(guildId, timer);\n    return true;\n  }\n\n"""
insert = anchor + """  function scheduleFreshVoiceSession(player, code) {\n    if (!player || music.players.get(player.guildId) !== player || voiceFreshSessionTimers.has(player.guildId)) return false;\n    const guildId = player.guildId;\n\n    // 4014/4022 may be followed immediately by a guild VoiceState update that\n    // tells us the bot was deliberately kicked or the call was terminated. Do\n    // not rejoin from a stale cache value. Give the main gateway a short window\n    // to publish the authoritative channel state first. Keep the timer marker\n    // after it fires so repeated close events cannot create a rejoin storm; a\n    // connected playerUpdate or cleanup clears the marker.\n    const timer = setTimeout(() => {\n      if (music.players.get(guildId) !== player || !player.voiceId) return;\n      const actualChannelId = currentBotVoiceChannelId(guildId);\n      if (!actualChannelId) return;\n      syncPlayerVoiceChannel(player, actualChannelId);\n      try {\n        player.setVoiceChannel(actualChannelId);\n        console.warn(`[voice] requested one fresh Discord voice session for ${guildId} after close ${code}`);\n      } catch (error) {\n        console.warn('[voice] fresh-session request failed', error?.message || error);\n      }\n    }, 750);\n    timer.unref?.();\n    voiceFreshSessionTimers.set(guildId, timer);\n    return true;\n  }\n\n"""
text = replace_once(text, anchor, insert, 'fresh-session scheduler')

text = replace_once(
    text,
    "      clearVoiceCloseRecoveryTimer(guildId);\n\n      // Shoukaku's leaveVoiceChannel",
    "      clearVoiceCloseRecoveryTimer(guildId);\n      clearVoiceFreshSessionTimer(guildId);\n\n      // Shoukaku's leaveVoiceChannel",
    'retirement clears fresh session',
)

old = """  music.on('playerUpdate', (player, data) => {\n    if (data?.state?.connected) clearVoiceCloseRecoveryTimer(player.guildId);\n    commitPendingPlaybackHistory(player);\n"""
new = """  music.on('playerUpdate', (player, data) => {\n    if (data?.state?.connected) {\n      clearVoiceCloseRecoveryTimer(player.guildId);\n      clearVoiceFreshSessionTimer(player.guildId);\n    }\n    commitPendingPlaybackHistory(player);\n"""
text = replace_once(text, old, new, 'connected update clears both timers')

old = """    const disposition = voiceCloseDisposition(code);\n    const alreadyRecovering = voiceCloseRecoveryTimers.has(player.guildId);\n    const actualChannelId = currentBotVoiceChannelId(player.guildId);\n    if (actualChannelId) syncPlayerVoiceChannel(player, actualChannelId);\n"""
new = """    const disposition = voiceCloseDisposition(code);\n    const actualChannelId = currentBotVoiceChannelId(player.guildId);\n    if (actualChannelId) syncPlayerVoiceChannel(player, actualChannelId);\n"""
text = replace_once(text, old, new, 'remove shared watchdog suppression')

old = """    if (disposition === 'retire') {\n      clearVoiceCloseRecoveryTimer(player.guildId);\n      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);\n      return;\n    }\n\n    // Koe already retries transient/time-out/server-crash closes itself. For\n    // 4006/4014/4022 the old voice session must not be resumed, so request one\n    // fresh main-gateway voice handshake if Discord still says the bot is in a\n    // channel. A kicked/deleted-channel bot has no actual channel and simply\n    // falls through to the same bounded watchdog.\n    if (disposition === 'refresh' && actualChannelId && !alreadyRecovering) {\n      try {\n        player.setVoiceChannel(actualChannelId);\n        console.warn(`[voice] requested a fresh Discord voice session for ${player.guildId} after close ${code}`);\n      } catch (error) {\n        console.warn('[voice] fresh-session request failed', error?.message || error);\n      }\n    }\n\n    scheduleVoiceTransportWatchdog(\n"""
new = """    if (disposition === 'retire') {\n      clearVoiceCloseRecoveryTimer(player.guildId);\n      clearVoiceFreshSessionTimer(player.guildId);\n      await retirePlayerForTransportLoss(player, `Discord voice closed ${code}: ${reason}`);\n      return;\n    }\n\n    // Koe already retries transient/time-out/server-crash closes itself. For\n    // 4006/4014/4022 the old session cannot simply resume, but do not request a\n    // replacement until the guild VoiceState cache has had a chance to report a\n    // deliberate kick/move. This prevents a stale 4014 cache from rejoining the\n    // bot after an administrator intentionally disconnected it.\n    if (disposition === 'refresh') scheduleFreshVoiceSession(player, code);\n\n    scheduleVoiceTransportWatchdog(\n"""
text = replace_once(text, old, new, 'safe refresh behavior')

text = replace_once(
    text,
    "    if (botTransition?.type === 'left') {\n      clearPendingPlaybackHistory(guildId);",
    "    if (botTransition?.type === 'left') {\n      clearVoiceFreshSessionTimer(guildId);\n      clearPendingPlaybackHistory(guildId);",
    'gateway leave cancels refresh',
)

text = replace_once(
    text,
    "    clearEmptyVoiceTimer(player.guildId);\n    clearVoiceCloseRecoveryTimer(player.guildId);\n    emptyVoiceAutoPaused.delete(player.guildId);",
    "    clearEmptyVoiceTimer(player.guildId);\n    clearVoiceCloseRecoveryTimer(player.guildId);\n    clearVoiceFreshSessionTimer(player.guildId);\n    emptyVoiceAutoPaused.delete(player.guildId);",
    'destroy clears fresh session',
)

path.write_text(text, encoding='utf-8')

# Strengthen permanent wiring test for the moved-vs-kicked race.
path = Path('test/voice-move-v0115.test.js')
test = path.read_text(encoding='utf-8')
old = """  assert.match(music, /scheduleVoiceTransportWatchdog/);\n  assert.match(music, /player\\.setVoiceChannel\\(actualChannelId\\)/);\n  assert.match(music, /currentBotVoiceChannelId/);\n"""
new = """  assert.match(music, /scheduleVoiceTransportWatchdog/);\n  assert.match(music, /scheduleFreshVoiceSession/);\n  assert.match(music, /setTimeout\\(\\(\\) => \\{[\\s\\S]*?currentBotVoiceChannelId\\(guildId\\)[\\s\\S]*?player\\.setVoiceChannel\\(actualChannelId\\)/);\n  assert.match(music, /botTransition\\?\\.type === 'left'[\\s\\S]*?clearVoiceFreshSessionTimer\\(guildId\\)/);\n  assert.match(music, /data\\?\\.state\\?\\.connected[\\s\\S]*?clearVoiceFreshSessionTimer/);\n  assert.match(music, /currentBotVoiceChannelId/);\n"""
test = replace_once(test, old, new, 'v0.1.15 refresh-race static test')
path.write_text(test, encoding='utf-8')
print('Refined v0.1.15 moved-vs-kicked fresh-session race')
