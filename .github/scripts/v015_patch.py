from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Version.
replace_once('package.json', '"version": "0.1.4"', '"version": "0.1.5"')

# More buffering headroom without changing the raw audio path.
replace_once(
    'lavalink/application.yml',
    '    bufferDurationMs: 1000\n    frameBufferDurationMs: 10000\n',
    '    bufferDurationMs: 2000\n    frameBufferDurationMs: 20000\n',
)

# Merge Lavalink WebSocket stats (which include frameStats) with REST stats.
replace_once(
    'src/music.js',
    '''  async function getRuntimeStats() {\n    const node = process.memoryUsage();\n    let lavalink = null;\n    try {\n      const response = await fetch(`${lavalinkBaseUrl()}/v4/stats`, {\n        headers: { Authorization: config.lavalinkPassword },\n        signal: AbortSignal.timeout(2_000),\n      });\n      if (response.ok) lavalink = await response.json();\n    } catch { /* status remains useful even if stats endpoint is temporarily unavailable */ }\n    return {\n      node: { rss: node.rss, heapUsed: node.heapUsed, heapTotal: node.heapTotal },\n      lavalink,\n      queueLimit: MAX_UPCOMING_QUEUE,\n    };\n  }\n''',
    '''  async function getRuntimeStats() {\n    const node = process.memoryUsage();\n    let lavalink = null;\n    let liveStats = null;\n    try {\n      const nodes = music.shoukaku?.nodes;\n      const candidates = typeof nodes?.values === 'function' ? [...nodes.values()] : [];\n      liveStats = candidates.find((candidate) => candidate?.stats)?.stats || null;\n    } catch { /* live WebSocket stats are optional diagnostics */ }\n    try {\n      const response = await fetch(`${lavalinkBaseUrl()}/v4/stats`, {\n        headers: { Authorization: config.lavalinkPassword },\n        signal: AbortSignal.timeout(2_000),\n      });\n      if (response.ok) lavalink = await response.json();\n    } catch { /* status remains useful even if stats endpoint is temporarily unavailable */ }\n\n    // Lavalink intentionally omits frameStats from GET /v4/stats. Shoukaku keeps\n    // the latest WebSocket stats payload, so merge those frame/CPU counters into\n    // the REST snapshot without adding another connection or monitoring service.\n    if (liveStats) {\n      lavalink = lavalink\n        ? { ...lavalink, cpu: liveStats.cpu || lavalink.cpu, frameStats: liveStats.frameStats ?? null }\n        : { ...liveStats };\n    }\n\n    return {\n      node: { rss: node.rss, heapUsed: node.heapUsed, heapTotal: node.heapTotal },\n      lavalink,\n      queueLimit: MAX_UPCOMING_QUEUE,\n    };\n  }\n''',
)

# Public/silent Now Playing only; everything else remains private.
replace_once(
    'src/commands.js',
    'const PRIVATE_FLAGS = MessageFlags.Ephemeral;\nconst MAX_PLAYLIST_ADD = 250;',
    'const PRIVATE_FLAGS = MessageFlags.Ephemeral;\nconst PUBLIC_NOWPLAYING_FLAGS = MessageFlags.SuppressNotifications;\nconst MAX_PLAYLIST_ADD = 250;',
)

replace_once(
    'src/commands.js',
    '''function privateDefer(interaction) {\n  return interaction.deferReply({ flags: PRIVATE_FLAGS });\n}\n''',
    '''function privateDefer(interaction) {\n  return interaction.deferReply({ flags: PRIVATE_FLAGS });\n}\n\nfunction publicNowPlayingReply(interaction, payload = {}) {\n  return interaction.reply({\n    ...payload,\n    flags: Number(payload.flags || 0) | PUBLIC_NOWPLAYING_FLAGS,\n  });\n}\n\nfunction isPublicComponentInteraction(interaction) {\n  if (!interaction?.isMessageComponent?.()) return false;\n  const flags = interaction?.message?.flags;\n  if (typeof flags?.has === 'function') return !flags.has(MessageFlags.Ephemeral);\n  return (Number(flags?.bitfield ?? flags ?? 0) & MessageFlags.Ephemeral) === 0;\n}\n''',
)

replace_once(
    'src/commands.js',
    '''function sourceHealthLine(health) {\n  if (!health || health.status === 'healthy') return 'Playback source: **Healthy**';\n  const held = Number(health.held || 0);\n  const retrySeconds = health.retryAt > Date.now() ? Math.ceil((health.retryAt - Date.now()) / 1000) : 0;\n  const label = health.status === 'recovering' ? 'Recovering' : 'Degraded';\n  return `Playback source: **⚠️ ${label}**${held ? ` • ${held} track${held === 1 ? '' : 's'} preserved` : ''}${retrySeconds ? ` • retry in ~${retrySeconds}s` : ''}`;\n}\n''',
    '''function sourceHealthLine(health) {\n  if (!health || health.status === 'healthy') return 'Playback source: **Healthy**';\n  const held = Number(health.held || 0);\n  const retrySeconds = health.retryAt > Date.now() ? Math.ceil((health.retryAt - Date.now()) / 1000) : 0;\n  const label = health.status === 'recovering' ? 'Recovering' : 'Degraded';\n  return `Playback source: **⚠️ ${label}**${held ? ` • ${held} track${held === 1 ? '' : 's'} preserved` : ''}${retrySeconds ? ` • retry in ~${retrySeconds}s` : ''}`;\n}\n\nfunction audioStreamLines(runtime, connected) {\n  if (!connected) return [];\n  const frames = runtime?.lavalink?.frameStats;\n  if (!frames) return ['Audio stream: **Measuring / frame stats unavailable**'];\n  const sent = Math.max(0, Number(frames.sent || 0));\n  const nulled = Math.max(0, Number(frames.nulled || 0));\n  const deficit = Number(frames.deficit || 0);\n  const starving = nulled > 0 || deficit > 0;\n  const signedDeficit = `${deficit > 0 ? '+' : ''}${deficit}`;\n  return [\n    `Audio stream: **${starving ? '⚠️ Frame starvation detected' : 'Smooth'}**`,\n    `Audio frames: **${sent} sent** • ${nulled} nulled • ${signedDeficit} deficit`,\n  ];\n}\n\nfunction percent(value) {\n  const n = Number(value);\n  return Number.isFinite(n) ? `${(Math.max(0, n) * 100).toFixed(1)}%` : 'n/a';\n}\n''',
)

replace_once(
    'src/commands.js',
    "    'All replies and player/queue controls are private, so the music text channel stays empty.',",
    "    '`/nowplaying` is the only public response and is sent with Discord silent-notification flags; all commands, detailed menus, confirmations, and errors stay private.',",
)

replace_once(
    'src/commands.js',
    '''          const voicePing = Number(player.shoukaku?.ping ?? 0);\n          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms` : 'connected / measuring'}**`);\n          if (player.queue.current) lines.push(`Current: **${safeTitle(player.queue.current, 100)}**`);\n''',
    '''          const voicePing = Number(player.shoukaku?.ping ?? 0);\n          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms` : 'connected / measuring'}**`);\n          lines.push(...audioStreamLines(runtime, true));\n          if (player.queue.current) lines.push(`Current: **${safeTitle(player.queue.current, 100)}**`);\n''',
)

replace_once(
    'src/commands.js',
    '''        const llMemory = runtime?.lavalink?.memory;\n        if (llMemory) lines.push(`Lavalink JVM: **${mb(llMemory.used)} used** • max ${mb(llMemory.reservable)}`);\n        lines.push('RAM note: JVM figures are Lavalink runtime memory, not the Java process\\'s complete Windows working set.');\n''',
    '''        const llMemory = runtime?.lavalink?.memory;\n        if (llMemory) lines.push(`Lavalink JVM: **${mb(llMemory.used)} used** • max ${mb(llMemory.reservable)}`);\n        const llCpu = runtime?.lavalink?.cpu;\n        if (llCpu) lines.push(`Lavalink CPU: **${percent(llCpu.lavalinkLoad)}** • system ${percent(llCpu.systemLoad)}`);\n        lines.push('RAM note: JVM figures are Lavalink runtime memory, not the Java process\\'s complete Windows working set.');\n''',
)

replace_once(
    'src/commands.js',
    '''      if (name === 'nowplaying') {\n        requireSameVoice(interaction, player);\n        requireCurrentTrack(player);\n        await privateReply(interaction, null, panelPayload(player, interaction.guildId));\n        livePanels.track(interaction);\n        return;\n      }\n''',
    '''      if (name === 'nowplaying') {\n        requireSameVoice(interaction, player);\n        requireCurrentTrack(player);\n        await publicNowPlayingReply(interaction, panelPayload(player, interaction.guildId));\n        livePanels.track(interaction);\n        return;\n      }\n''',
)

replace_once(
    'src/commands.js',
    '''  // Stop the previous auto-refresh lease before handling any button. Views that\n  // render the player again acquire a fresh ~14-minute interaction-token lease.\n  livePanels.pause(interaction);\n''',
    '''  // Private sub-views keep their own per-user refresh lease. A public Now Playing\n  // button must not kill the shared public lease merely because it opens a\n  // private Queue/More view. Direct public controls can renew the public lease.\n  const publicSource = isPublicComponentInteraction(interaction);\n  if (!publicSource) livePanels.pause(interaction);\n''',
)

replace_once(
    'src/commands.js',
    "  if (action === 'queue') { await interaction.deferUpdate(); return interaction.editReply(queuePayload(player, interaction.guildId, 0)); }",
    "  if (action === 'queue') {\n    if (publicSource) return privateReply(interaction, null, queuePayload(player, interaction.guildId, 0));\n    await interaction.deferUpdate();\n    return interaction.editReply(queuePayload(player, interaction.guildId, 0));\n  }",
)

replace_once(
    'src/commands.js',
    '''    const added = toggleFavorite(interaction.guildId, interaction.user.id, player.queue.current);\n    await interaction.deferUpdate();\n    return editLivePanel(interaction, player, `${added ? '❤️ Added to' : '💔 Removed from'} your favorites.`);\n''',
    '''    const added = toggleFavorite(interaction.guildId, interaction.user.id, player.queue.current);\n    if (publicSource) return privateReply(interaction, `${added ? '❤️ Added to' : '💔 Removed from'} your favorites.`);\n    await interaction.deferUpdate();\n    return editLivePanel(interaction, player, `${added ? '❤️ Added to' : '💔 Removed from'} your favorites.`);\n''',
)

replace_once(
    'src/commands.js',
    "  if (action === 'more') { requireCurrentTrack(player); await interaction.deferUpdate(); return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId))); }",
    "  if (action === 'more') {\n    requireCurrentTrack(player);\n    if (publicSource) return privateReply(interaction, null, playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));\n    await interaction.deferUpdate();\n    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));\n  }",
)

# Public and private live panels must not evict each other.
replace_once(
    'src/live-panel.js',
    '''function panelKey(interaction) {\n  const guildId = interaction?.guildId;\n  const userId = interaction?.user?.id;\n  return guildId && userId ? `${guildId}:${userId}` : null;\n}\n''',
    '''const EPHEMERAL_FLAG = 1 << 6;\n\nfunction interactionIsEphemeral(interaction) {\n  if (interaction?.ephemeral === true) return true;\n  if (interaction?.ephemeral === false) return false;\n  const flags = interaction?.message?.flags;\n  if (typeof flags?.has === 'function') return flags.has(EPHEMERAL_FLAG);\n  return Boolean(Number(flags?.bitfield ?? flags ?? 0) & EPHEMERAL_FLAG);\n}\n\nfunction panelKey(interaction) {\n  const guildId = interaction?.guildId;\n  const userId = interaction?.user?.id;\n  if (!guildId || !userId) return null;\n  return interactionIsEphemeral(interaction)\n    ? `${guildId}:private:${userId}`\n    : `${guildId}:public`;\n}\n''',
)

# README.
replace_once(
    'README.md',
    'Private single-server Discord music bot focused on raw/original playback, a clean text channel, a private JukeBox-style player panel, server radio, autoplay, and an optional Gemini AI DJ.',
    'Private single-server Discord music bot focused on raw/original playback, a clean text channel, a shared silent Now Playing JukeBox, private detailed controls, server radio, autoplay, and an optional Gemini AI DJ.',
)
replace_once(
    'README.md',
    '- All slash-command replies and the player panel are ephemeral/private to the person using them, so the music text channel can stay empty.',
    '- `/nowplaying` is the only public response and uses Discord\'s suppress-notifications flag. All other slash-command replies, detailed menus, confirmations, and errors remain ephemeral/private.',
)
replace_once('README.md', '## Private player UI', '## Shared Now Playing + private detailed UI')
replace_once(
    'README.md',
    'The response is visible only to you. The player uses Discord Components V2: artwork, metadata, status, and every control button live inside one colored JukeBox container instead of buttons floating below a legacy embed.',
    'The response is public so everyone in the music channel can see the current player, but it is sent with Discord\'s **Suppress Notifications** flag. The player uses Discord Components V2: artwork, metadata, status, and control buttons live inside one colored JukeBox container instead of buttons floating below a legacy embed. Discord can still mark a channel unread for a new public message; the API does not provide a flag that guarantees a visible public message never affects unread state.',
)
replace_once(
    'README.md',
    '`Queue` opens a private Queue Manager with 25-track pages, a track selector, Remove, Move Next, Play Now, stronger duplicate cleanup, and refresh/back controls. Clear/Remove/Dedupe keep one bounded **5-minute Undo** snapshot so accidental queue changes can be reversed without another service.',
    '`Queue` opens a private Queue Manager with 25-track pages, a track selector, Remove, Move Next, Play Now, stronger duplicate cleanup, and refresh/back controls. `More` and personal Favorite confirmations also stay private even when opened from the public Now Playing panel. Clear/Remove/Dedupe keep one bounded **5-minute Undo** snapshot so accidental queue changes can be reversed without another service.',
)
replace_once(
    'README.md',
    'While the main `/nowplaying` JukeBox view is open, its progress/current-track/status display refreshes about every **10 seconds**. Only one live player message per user/server is tracked. Opening Queue, More, History, or Favorites pauses that live lease so a background refresh never overwrites the sub-view; returning with Back or pressing Refresh starts a fresh lease. Each lease retires after about **14 minutes**, before Discord\'s ephemeral interaction token expires, and leaves a notice telling you to press Refresh to resume. The registry is capped at 32 live panels and uses one lazy timer only while at least one live panel exists; it adds no service or audio-processing process.',
    'While the main `/nowplaying` JukeBox view is open, its progress/current-track/status display refreshes about every **10 seconds**. Public panels use one shared live lease per server, while private sub-views keep per-user leases so opening Queue/More never turns those details public or evicts the shared panel. Each interaction-backed lease retires after about **14 minutes** and leaves a notice telling you to press Refresh to resume. The registry is capped at 32 live panels and uses one lazy timer only while at least one live panel exists; it adds no service or audio-processing process.',
)
replace_once(
    'README.md',
    'bufferDurationMs: 1000\nframeBufferDurationMs: 10000',
    'bufferDurationMs: 2000\nframeBufferDurationMs: 20000',
)
replace_once(
    'README.md',
    'The extra headroom is intended to absorb short source/network/GC hiccups, especially near track startup.',
    'The extra 2-second non-allocating buffer and 20-second frame buffer are intended to absorb short source/network/GC hiccups, especially near track startup, while staying comfortably within the existing 256 MB Lavalink heap cap for this single-server bot.',
)
replace_once(
    'README.md',
    '- Lavalink JVM memory stats\n- playback-source health / preserved-queue protection state',
    '- Lavalink JVM memory and CPU stats\n- live audio frame counters (`sent`, `nulled`, `deficit`) plus a smooth/frame-starvation indicator\n- playback-source health / preserved-queue protection state',
)

# Focused interaction policy tests.
Path('test/private-interactions.test.js').write_text('''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst commands = fs.readFileSync('src/commands.js', 'utf8');\nconst music = fs.readFileSync('src/music.js', 'utf8');\nconst index = fs.readFileSync('src/index.js', 'utf8');\n\ntest('only /nowplaying is public and it uses Discord silent notifications', () => {\n  assert.match(commands, /const PRIVATE_FLAGS = MessageFlags\\.Ephemeral/);\n  assert.match(commands, /const PUBLIC_NOWPLAYING_FLAGS = MessageFlags\\.SuppressNotifications/);\n  assert.match(commands, /await publicNowPlayingReply\\(interaction, panelPayload\\(player, interaction\\.guildId\\)\\)/);\n  assert.doesNotMatch(commands, /\\bephemeral\\s*:/i);\n  assert.doesNotMatch(commands, /deferReply\\(\\s*\\)/);\n  assert.doesNotMatch(commands, /interaction\\.reply\\(\\s*['"`]/);\n});\n\ntest('public Now Playing keeps detailed Queue/More and personal favorite feedback private', () => {\n  assert.match(commands, /if \\(publicSource\\) return privateReply\\(interaction, null, queuePayload/);\n  assert.match(commands, /if \\(publicSource\\) return privateReply\\(interaction, null, playbackToolsPayload/);\n  assert.match(commands, /if \\(publicSource\\) return privateReply\\(interaction, `\\$\\{added/);\n});\n\ntest('music core never sends a public player panel directly to a text channel', () => {\n  assert.doesNotMatch(music, /channel\\.send\\s*\\(/i);\n  assert.doesNotMatch(music, /panelMessages/i);\n});\n\ntest('discord.js ready event uses the v15-safe ClientReady name', () => {\n  assert.match(index, /Events\\.ClientReady/);\n  assert.doesNotMatch(index, /once\\(['"]ready['"]/);\n});\n''', encoding='utf-8')

# Live-panel tests explicitly model private/public scope.
replace_once(
    'test/live-panel.test.js',
    "function fakeInteraction(id, { guildId = 'guild', userId = 'user', createdTimestamp = 1_000 } = {}) {",
    "function fakeInteraction(id, { guildId = 'guild', userId = 'user', createdTimestamp = 1_000, ephemeral = true } = {}) {",
)
replace_once(
    'test/live-panel.test.js',
    '''    createdTimestamp,\n    edits,\n''',
    '''    createdTimestamp,\n    ephemeral,\n    edits,\n''',
)
replace_once(
    'test/live-panel.test.js',
    "test('live registry keeps only the newest panel per guild/user', async () => {",
    "test('live registry keeps only the newest private panel per guild/user', async () => {",
)
replace_once(
    'test/live-panel.test.js',
    "test('different users can each have one live panel and maxEntries evicts oldest', () => {",
    "test('different users can each have one private live panel and maxEntries evicts oldest', () => {",
)
replace_once(
    'test/live-panel.test.js',
    '''test('expired lease gets one final retiring render then stops', async () => {\n''',
    '''test('public live panels share one guild lease regardless of which user refreshes it', async () => {\n  const scheduler = fakeScheduler();\n  const registry = createLivePanelRegistry({\n    render: (interaction) => ({ content: interaction.id }),\n    setIntervalFn: scheduler.setIntervalFn,\n    clearIntervalFn: scheduler.clearIntervalFn,\n  });\n  const a = fakeInteraction('public-a', { userId: 'a', ephemeral: false, createdTimestamp: Date.now() });\n  const b = fakeInteraction('public-b', { userId: 'b', ephemeral: false, createdTimestamp: Date.now() });\n  registry.track(a);\n  registry.track(b);\n  assert.equal(registry.size(), 1);\n  await registry.tick();\n  assert.equal(a.edits.length, 0);\n  assert.deepEqual(b.edits, [{ content: 'public-b' }]);\n  registry.shutdown();\n});\n\ntest('expired lease gets one final retiring render then stops', async () => {\n''',
)
replace_once(
    'test/live-panel.test.js',
    '''  assert.match(source, /await privateReply\\(interaction, null, panelPayload\\(player, interaction\\.guildId\\)\\);\\s*livePanels\\.track\\(interaction\\)/);\n''',
    '''  assert.match(source, /await publicNowPlayingReply\\(interaction, panelPayload\\(player, interaction\\.guildId\\)\\);\\s*livePanels\\.track\\(interaction\\)/);\n''',
)

Path('test/playback-stability.test.js').write_text('''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst app = fs.readFileSync('lavalink/application.yml', 'utf8');\nconst music = fs.readFileSync('src/music.js', 'utf8');\nconst commands = fs.readFileSync('src/commands.js', 'utf8');\n\ntest('single-server playback has expanded non-DSP buffering headroom', () => {\n  assert.match(app, /nonAllocatingFrameBuffer:\\s*true/);\n  assert.match(app, /bufferDurationMs:\\s*2000/);\n  assert.match(app, /frameBufferDurationMs:\\s*20000/);\n  assert.match(app, /equalizer:\\s*false/);\n  assert.match(app, /timescale:\\s*false/);\n});\n\ntest('/status merges Shoukaku WebSocket frame stats and exposes frame starvation diagnostics', () => {\n  assert.match(music, /music\\.shoukaku\\?\\.nodes/);\n  assert.match(music, /frameStats: liveStats\\.frameStats/);\n  assert.match(commands, /Audio stream:/);\n  assert.match(commands, /Audio frames:/);\n  assert.match(commands, /Frame starvation detected/);\n  assert.match(commands, /Lavalink CPU:/);\n});\n''', encoding='utf-8')
