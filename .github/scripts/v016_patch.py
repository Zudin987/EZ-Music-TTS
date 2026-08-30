from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Version + syntax-check surface.
replace_once('package.json', '"version": "0.1.5"', '"version": "0.1.6"')
replace_once(
    'package.json',
    'node --check src/utils.js && node --check src/source-routing.js && node --check src/live-panel.js',
    'node --check src/utils.js && node --check src/source-routing.js && node --check src/live-panel.js && node --check src/performance.js',
)

# Small pure helpers keep performance policy unit-testable without Discord/Lavalink mocks.
Path('src/performance.js').write_text("""export function emptyVoiceTransition({ hasHuman, hasCurrentTrack, playing, paused, autoPaused }) {
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
""", encoding='utf-8')

# Align the YouTube client path with youtube-source's current recommended example.
# Every playback client here advertises Opus support; MUSIC remains search-only.
replace_once(
    'lavalink/application.yml',
    '''    # MUSIC is search-only. Playback falls through the maintained anonymous\n    # clients with the August 2026 Android/iOS/TV fixes.\n    clients:\n      - MUSIC\n      - ANDROID\n      - IOS\n      - TVHTML5_SIMPLY\n      - ANDROID_MUSIC\n      - ANDROID_VR\n      - MWEB\n      - WEB\n      - WEBEMBEDDED\n''',
    '''    # Keep the playback path short and Opus-capable. This follows the current\n    # youtube-source recommended example: MUSIC searches, then playback falls\n    # through ANDROID_VR -> WEB -> WEBEMBEDDED. Avoiding regular ANDROID (marked\n    # frequently dysfunctional upstream), IOS (no Opus), and TVHTML5_SIMPLY also\n    # avoids known failed-client work before playback starts.\n    clients:\n      - MUSIC\n      - ANDROID_VR\n      - WEB\n      - WEBEMBEDDED\n''',
)

# Auto-pause immediately when the last human leaves; only auto-resume a pause that
# EZ Music itself created. Manual pauses must remain manual.
replace_once(
    'src/music.js',
    "import { resolvePreferredSearch } from './source-routing.js';\n",
    "import { resolvePreferredSearch } from './source-routing.js';\nimport { emptyVoiceTransition } from './performance.js';\n",
)
replace_once(
    'src/music.js',
    '''  const emptyVoiceTimers = new Map();\n  const playbackFailures = new Map();\n''',
    '''  const emptyVoiceTimers = new Map();\n  const emptyVoiceAutoPaused = new Set();\n  const playbackFailures = new Map();\n''',
)
replace_once(
    'src/music.js',
    '''  function evaluateVoiceOccupancy(player) {\n    if (!player || music.players.get(player.guildId) !== player) return;\n    if (hasHumanListener(player)) return clearEmptyVoiceTimer(player.guildId);\n    if (emptyVoiceTimers.has(player.guildId)) return;\n\n    const timer = setTimeout(async () => {\n      emptyVoiceTimers.delete(player.guildId);\n      if (music.players.get(player.guildId) !== player || hasHumanListener(player)) return;\n      console.log(`[voice] no human listeners for 2 minutes; disconnecting ${player.guildId}`);\n      invalidateQueueWork(player.guildId);\n      setAutoplayMode(player.guildId, 'off');\n      discardHeldQueue(player.guildId);\n      clearRecoverySession(player.guildId);\n      try { player.queue.clear(); } catch { /* player may already be tearing down */ }\n      try { await player.destroy(); } catch (error) { console.warn('[voice] auto-leave failed', error?.message || error); }\n    }, EMPTY_VOICE_GRACE_MS);\n    timer.unref?.();\n    emptyVoiceTimers.set(player.guildId, timer);\n  }\n''',
    '''  function evaluateVoiceOccupancy(player) {\n    if (!player || music.players.get(player.guildId) !== player) return;\n    const guildId = player.guildId;\n    const hasHuman = hasHumanListener(player);\n    const transition = emptyVoiceTransition({\n      hasHuman,\n      hasCurrentTrack: Boolean(player.queue.current),\n      playing: Boolean(player.playing),\n      paused: Boolean(player.paused),\n      autoPaused: emptyVoiceAutoPaused.has(guildId),\n    });\n\n    if (hasHuman) {\n      clearEmptyVoiceTimer(guildId);\n      const wasAutoPaused = emptyVoiceAutoPaused.delete(guildId);\n      if (transition === 'resume' && wasAutoPaused) {\n        try {\n          player.pause(false);\n          scheduleRecoverySave(player, 0);\n          console.log(`[voice] human listener returned; auto-resumed ${guildId}`);\n        } catch (error) {\n          console.warn('[voice] auto-resume failed', error?.message || error);\n        }\n      }\n      return;\n    }\n\n    if (transition === 'pause') {\n      try {\n        player.pause(true);\n        emptyVoiceAutoPaused.add(guildId);\n        scheduleRecoverySave(player, 0);\n        console.log(`[voice] channel empty; auto-paused ${guildId}`);\n      } catch (error) {\n        console.warn('[voice] auto-pause failed', error?.message || error);\n      }\n    }\n\n    if (emptyVoiceTimers.has(guildId)) return;\n    const timer = setTimeout(async () => {\n      emptyVoiceTimers.delete(guildId);\n      if (music.players.get(guildId) !== player || hasHumanListener(player)) {\n        evaluateVoiceOccupancy(player);\n        return;\n      }\n      emptyVoiceAutoPaused.delete(guildId);\n      console.log(`[voice] no human listeners for 2 minutes; disconnecting ${guildId}`);\n      invalidateQueueWork(guildId);\n      setAutoplayMode(guildId, 'off');\n      discardHeldQueue(guildId);\n      clearRecoverySession(guildId);\n      try { player.queue.clear(); } catch { /* player may already be tearing down */ }\n      try { await player.destroy(); } catch (error) { console.warn('[voice] auto-leave failed', error?.message || error); }\n    }, EMPTY_VOICE_GRACE_MS);\n    timer.unref?.();\n    emptyVoiceTimers.set(guildId, timer);\n  }\n''',
)
replace_once(
    'src/music.js',
    '''  async function handlePlayerEmpty(player) {\n    // Kazagumo can leave its paused flag set when a paused track is skipped or\n''',
    '''  async function handlePlayerEmpty(player) {\n    // No current track means an empty-room pause marker can no longer refer to\n    // a resumable item. A future playerStart will reevaluate occupancy itself.\n    emptyVoiceAutoPaused.delete(player.guildId);\n    // Kazagumo can leave its paused flag set when a paused track is skipped or\n''',
)
replace_once(
    'src/music.js',
    '''    clearEmptyVoiceTimer(player.guildId);\n    clearSourceSuccess(player.guildId);\n''',
    '''    clearEmptyVoiceTimer(player.guildId);\n    emptyVoiceAutoPaused.delete(player.guildId);\n    clearSourceSuccess(player.guildId);\n''',
)
replace_once(
    'src/music.js',
    '''    getRuntimeStats,\n    getSourceHealth,\n''',
    '''    getRuntimeStats,\n    getSourceHealth,\n    isAutoPausedForEmptyVoice: (guildId) => emptyVoiceAutoPaused.has(guildId),\n''',
)

# Voice-transport quality label and explicit empty-room status.
replace_once(
    'src/commands.js',
    "import { parseTimeToSeconds, trackKey, truncate } from './utils.js';\n",
    "import { parseTimeToSeconds, trackKey, truncate } from './utils.js';\nimport { voiceTransportQuality } from './performance.js';\n",
)
replace_once(
    'src/commands.js',
    "  new SlashCommandBuilder().setName('nowplaying').setDescription('Show your private player panel'),",
    "  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the shared Now Playing player panel'),",
)
replace_once(
    'src/commands.js',
    '''  getRuntimeStats,\n  getSourceHealth,\n  discardHeldQueue,\n''',
    '''  getRuntimeStats,\n  getSourceHealth,\n  isAutoPausedForEmptyVoice,\n  discardHeldQueue,\n''',
)
replace_once(
    'src/commands.js',
    '''          `Player: **${player ? (player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,\n''',
    '''          `Player: **${player ? (isAutoPausedForEmptyVoice(interaction.guildId) ? 'Auto-paused (empty VC)' : player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,\n''',
)
replace_once(
    'src/commands.js',
    '''          const voicePing = Number(player.shoukaku?.ping ?? 0);\n          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms` : 'connected / measuring'}**`);\n''',
    '''          const voicePing = Number(player.shoukaku?.ping ?? 0);\n          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms • ${voiceTransportQuality(voicePing)}` : 'connected / measuring'}**`);\n''',
)
replace_once(
    'src/commands.js',
    "    '`/stop` fully resets current/upcoming/previous state. Volume stays saved until changed again.',\n",
    "    '`/stop` fully resets current/upcoming/previous state. Volume stays saved until changed again.',\n    'When the last human leaves the voice channel, active playback auto-pauses immediately; returning within 2 minutes auto-resumes it. Manual pauses are never auto-resumed.',\n",
)

# README performance notes.
replace_once(
    'README.md',
    'A clean Discord `/stop`, `/disconnect`, natural completed queue, or 2-minute empty-room auto-leave clears obsolete recovery state.',
    'A clean Discord `/stop`, `/disconnect`, natural completed queue, or 2-minute empty-room auto-leave clears obsolete recovery state. Active playback pauses immediately when the last human leaves; if a human returns during that 2-minute grace window, only that automatic pause is resumed. A manual `/pause` is never auto-resumed.',
)
replace_once(
    'README.md',
    '- **Empty-room auto-leave:** if no human listener remains in the bot voice channel for 2 minutes, the player disconnects and frees resources.',
    '- **Empty-room auto-pause/leave:** when the last human listener leaves during active playback, EZ Music pauses immediately to stop unnecessary audio work. If a human returns within 2 minutes, playback resumes from that automatic pause; manual pauses stay paused. If the room remains empty for 2 minutes, the existing disconnect/reset cleanup runs.',
)
replace_once(
    'README.md',
    '- YouTube through the maintained `youtube-source` plugin, pinned to the current August 2026 upstream playback-fix snapshot used by this bot\n',
    '- YouTube through the maintained `youtube-source` plugin, pinned to the current August 2026 upstream playback-fix snapshot used by this bot. Client order is kept short and Opus-capable: `MUSIC` (search only) → `ANDROID_VR` → `WEB` → `WEBEMBEDDED`, matching the current upstream example and avoiding known failed/restricted/transcoding-prone clients before playback.\n',
)
replace_once(
    'README.md',
    '- voice-transport ping while connected\n',
    '- voice-transport ping while connected, plus a lightweight local quality grade (`Excellent` <60 ms, `Good` <120 ms, `Elevated` <200 ms, otherwise `Poor`; this is an EZ Music diagnostic heuristic, not an official Discord grade)\n',
)

# Existing version assertion.
replace_once('test/source-routing.test.js', "assert.equal(pkg.version, '0.1.5');", "assert.equal(pkg.version, '0.1.6');")

# Strengthen the existing lean-runtime check.
replace_once(
    'test/lean-runtime.test.js',
    '''test('empty-room auto-leave and source circuit breaker are present', () => {\n  assert.match(music, /EMPTY_VOICE_GRACE_MS = 120_000/);\n''',
    '''test('empty-room auto-pause/leave and source circuit breaker are present', () => {\n  assert.match(music, /EMPTY_VOICE_GRACE_MS = 120_000/);\n  assert.match(music, /emptyVoiceAutoPaused = new Set\\(\\)/);\n  assert.match(music, /player\\.pause\\(true\\)/);\n  assert.match(music, /player\\.pause\\(false\\)/);\n''',
)

Path('test/performance-v016.test.js').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyVoiceTransition, voiceTransportQuality } from '../src/performance.js';

const app = fs.readFileSync('lavalink/application.yml', 'utf8');
const launcher = fs.readFileSync('start-bot.bat', 'utf8');

test('empty voice policy pauses active playback and only resumes an automatic pause', () => {
  assert.equal(emptyVoiceTransition({ hasHuman: false, hasCurrentTrack: true, playing: true, paused: false, autoPaused: false }), 'pause');
  assert.equal(emptyVoiceTransition({ hasHuman: true, hasCurrentTrack: true, playing: false, paused: true, autoPaused: true }), 'resume');
  assert.equal(emptyVoiceTransition({ hasHuman: true, hasCurrentTrack: true, playing: false, paused: true, autoPaused: false }), 'none', 'manual pause must remain paused');
  assert.equal(emptyVoiceTransition({ hasHuman: false, hasCurrentTrack: false, playing: false, paused: false, autoPaused: false }), 'none');
});

test('voice transport quality is a bounded diagnostic heuristic', () => {
  assert.equal(voiceTransportQuality(24), 'Excellent');
  assert.equal(voiceTransportQuality(60), 'Good');
  assert.equal(voiceTransportQuality(120), 'Elevated');
  assert.equal(voiceTransportQuality(200), 'Poor');
  assert.equal(voiceTransportQuality(0), 'Measuring');
});

test('YouTube client chain is short, upstream-aligned and avoids non-Opus/restricted early fallbacks', () => {
  const section = app.split('  youtube:\\n')[1]?.split('\\nlogging:')[0] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(clients, ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']);
  assert.ok(!clients.includes('ANDROID'));
  assert.ok(!clients.includes('IOS'));
  assert.ok(!clients.includes('TVHTML5_SIMPLY'));
});

test('performance pass preserves low-memory and non-DSP limits', () => {
  assert.match(launcher, /-Xmx256M/);
  assert.match(launcher, /--max-old-space-size=128/);
  assert.match(app, /bufferDurationMs:\\s*2000/);
  assert.match(app, /frameBufferDurationMs:\\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\\s*true/);
  assert.match(app, /equalizer:\\s*false/);
  assert.match(app, /timescale:\\s*false/);
  assert.match(app, /http:\\s*false/);
  assert.match(app, /local:\\s*false/);
});
""", encoding='utf-8')
