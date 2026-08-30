import { MessageFlags, REST, Routes, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { recentHistory } from './storage.js';
import { nowPlayingEmbed, playerButtons, playbackToolsPayload, queueManagerPayload, seekModal } from './ui.js';
import { parseTimeToSeconds, trackKey, truncate } from './utils.js';

const PRIVATE_FLAGS = MessageFlags.Ephemeral;
const MAX_PLAYLIST_ADD = 250;

export const commandDefinitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('previous').setDescription('Replay the previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and fully reset the active queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set persistent playback volume').addIntegerOption(o => o.setName('percent').setDescription('0-100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show your private player panel'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear upcoming songs and prevent automatic refill'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle upcoming songs'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices({name:'Off',value:'none'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
  new SlashCommandBuilder().setName('autoplay').setDescription('Turn source-based autoplay on or off').addStringOption(o => o.setName('mode').setDescription('Autoplay').setRequired(true).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})),
  new SlashCommandBuilder().setName('radio').setDescription('Radio controls').addSubcommand(s => s.setName('server').setDescription('Build radio from this server\'s listening history')),
  new SlashCommandBuilder().setName('ai').setDescription('Gemini AI DJ')
    .addStringOption(o => o.setName('request').setDescription('Natural-language music request').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('autoplay').setDescription('AI autoplay').setRequired(false).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})),
  new SlashCommandBuilder().setName('help').setDescription('Show commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Show Discord gateway latency'),
  new SlashCommandBuilder().setName('status').setDescription('Show music bot status'),
].map(x => x.toJSON());

export async function registerGuildCommands(config) {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commandDefinitions });
  console.log(`[discord] registered ${commandDefinitions.length} guild commands`);
}

function privateReply(interaction, content, extra = {}) {
  const payload = { flags: PRIVATE_FLAGS, ...extra };
  if (content !== undefined && content !== null) payload.content = content;
  return interaction.reply(payload);
}

function privateDefer(interaction) {
  return interaction.deferReply({ flags: PRIVATE_FLAGS });
}

function playerPanelPayload(player, autoplayMode, notice = null) {
  const track = player?.queue?.current;
  if (!track) return { content: notice || 'Nothing is playing.', embeds: [], components: [] };
  return {
    content: notice,
    embeds: [nowPlayingEmbed(track, player, autoplayMode)],
    components: playerButtons(player, autoplayMode),
  };
}

function getPlayer(music, guildId) {
  const player = music.players.get(guildId);
  if (!player) throw new Error('The bot is not connected to voice.');
  return player;
}

function requireSameVoice(interaction, player) {
  const voiceId = interaction.member?.voice?.channelId;
  if (!voiceId) throw new Error('Join the bot\'s voice channel first.');
  if (player.voiceId && voiceId !== player.voiceId) throw new Error('Join the same voice channel as the bot first.');
}

function requireVoiceForSetting(interaction, music) {
  const player = music.players.get(interaction.guildId);
  if (player) return requireSameVoice(interaction, player);
  if (!interaction.member?.voice?.channelId) throw new Error('Join a voice channel first.');
}

function requireCurrentTrack(player) {
  if (!player?.queue?.current) throw new Error('Nothing is playing.');
}

function expectedError(message) {
  const error = new Error(message);
  error.expected = true;
  return error;
}

function assertQueueRequestActive(music, player, guildId, revision, isQueueRevisionCurrent) {
  if (music.players.get(guildId) !== player || !isQueueRevisionCurrent(guildId, revision)) {
    throw expectedError('Request canceled because the queue was cleared, stopped, or disconnected before it finished.');
  }
}

function clearUpcomingQueue(player, guildId, { setGuildAutoplay, invalidateQueueWork, discardHeldQueue }) {
  const removed = Number(player.queue.length || 0) + discardHeldQueue(guildId);
  invalidateQueueWork(guildId);
  player.setLoop('none');
  setGuildAutoplay(guildId, 'off');
  player.queue.clear();
  return removed;
}

async function stopAndResetPlayer(player, guildId, { setGuildAutoplay, invalidateQueueWork, discardHeldQueue }) {
  const removed = Number(player.queue.length || 0) + discardHeldQueue(guildId);
  invalidateQueueWork(guildId);
  player.setLoop('none');
  setGuildAutoplay(guildId, 'off');
  player.queue.clear();
  if (Array.isArray(player.queue.previous)) player.queue.previous.splice(0, player.queue.previous.length);

  if (player.queue.current) {
    if (player.paused || player.shoukaku?.paused) {
      try { await player.shoukaku.setPaused(false); } catch { /* stop below still wins */ }
      player.paused = false;
    }
    player.queue.current = null;
    player.skip();
  } else {
    player.paused = false;
    player.playing = false;
  }

  return removed;
}

function skipCurrent(player) {
  requireCurrentTrack(player);
  if (player.loop === 'track') player.setLoop('none');
  player.skip();
}

async function searchTracks(player, query, requester) {
  const result = await player.search(query, { requester });
  if (!result?.tracks?.length) throw new Error(`No results for: ${truncate(query, 120)}`);
  return { result, tracks: result.type === 'PLAYLIST' ? [...result.tracks] : [result.tracks[0]] };
}

async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit) {
  const { tracks, result } = await searchTracks(player, query, requester);
  guard();
  const perRequestLimit = result.type === 'PLAYLIST' ? MAX_PLAYLIST_ADD : 1;
  const queued = queueTracks(player, tracks, { next, perRequestLimit });
  if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
  if (!player.playing && !player.paused) await player.play();
  return { tracks: queued.added, result, omitted: queued.omitted, sourceCount: tracks.length };
}

async function resolveSearchQueries(player, queries, requester, seen = new Set(), limit = 10, concurrency = 3, guard = () => {}) {
  const added = [];
  const cleanQueries = (queries || []).filter(Boolean);
  const width = Math.max(1, Math.min(5, concurrency));

  for (let offset = 0; offset < cleanQueries.length && added.length < limit; offset += width) {
    guard();
    const batch = cleanQueries.slice(offset, offset + width);
    const results = await Promise.all(batch.map((query) => player.search(query, { requester }).catch(() => null)));
    guard();
    for (const result of results) {
      const track = result?.tracks?.find((candidate) => {
        const key = trackKey(candidate);
        return key && !seen.has(key);
      });
      if (!track) continue;
      seen.add(trackKey(track));
      added.push(track);
      if (added.length >= limit) break;
    }
  }

  return added;
}

function safeTitle(track, max = 100) {
  return truncate(escapeMarkdown(track?.title || 'Unknown title'), max);
}

function queueFingerprint(track) {
  const input = `${track?.identifier || ''}\u0000${track?.uri || ''}\u0000${track?.author || ''}\u0000${track?.title || ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function mb(bytes) {
  const n = Number(bytes || 0);
  return n > 0 ? `${(n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB` : 'n/a';
}

function sourceHealthLine(health) {
  if (!health || health.status === 'healthy') return 'Playback source: **Healthy**';
  const held = Number(health.held || 0);
  const retrySeconds = health.retryAt > Date.now() ? Math.ceil((health.retryAt - Date.now()) / 1000) : 0;
  const label = health.status === 'recovering' ? 'Recovering' : 'Degraded';
  return `Playback source: **⚠️ ${label}**${held ? ` • ${held} track${held === 1 ? '' : 's'} preserved` : ''}${retrySeconds ? ` • retry in ~${retrySeconds}s` : ''}`;
}

function dedupeUpcoming(player) {
  const seen = new Set();
  const currentKey = trackKey(player?.queue?.current);
  if (currentKey) seen.add(currentKey);
  let removed = 0;
  let index = 0;
  while (index < player.queue.length) {
    const key = trackKey(player.queue[index]);
    if (key && seen.has(key)) {
      player.queue.splice(index, 1);
      removed += 1;
      continue;
    }
    if (key) seen.add(key);
    index += 1;
  }
  return removed;
}

function helpText() {
  return [
    '**EZ Music commands**',
    '`/play` `/playnext` `/pause` `/resume` `/skip` `/previous` `/stop` `/disconnect`',
    '`/volume` `/nowplaying` `/clear` `/shuffle` `/loop`',
    '`/autoplay on|off` `/radio server`',
    '`/ai request:<text>` `/ai autoplay:on|off`',
    '`/help` `/ping` `/status`',
    '',
    'All replies and player/queue controls are private, so the music text channel stays empty.',
    'Queue Manager: Queue → select a track → Remove / Move Next / Play Now. It also supports pages and duplicate cleanup.',
    'More: private seek/replay controls without adding extra slash commands.',
    '`/clear` keeps the current song playing, clears everything upcoming, and turns loop/autoplay off.',
    '`/stop` fully resets current/upcoming/previous state. Volume stays saved until changed again.',
    'Playback is raw: no filters, EQ, nightcore, karaoke, 8D, pitch/speed or other DSP effects.',
  ].join('\n');
}

export function createInteractionHandler({
  client,
  music,
  ensurePlayer,
  gemini,
  startServerRadio,
  setGuildAutoplay,
  getGuildAutoplay,
  getGuildVolume,
  setGuildVolume,
  getQueueRevision,
  invalidateQueueWork,
  isQueueRevisionCurrent,
  queueTracks,
  getQueueLimit,
  getRuntimeStats,
  getSourceHealth,
  discardHeldQueue,
}) {
  const queueLimit = getQueueLimit();
  const queueControls = { setGuildAutoplay, invalidateQueueWork, discardHeldQueue };
  const componentApi = { music, gemini, setGuildAutoplay, getGuildAutoplay, setGuildVolume, invalidateQueueWork, discardHeldQueue };

  return async function handle(interaction) {
    try {
      if (interaction.isStringSelectMenu()) return await handleQueueSelect(interaction, { music });
      if (interaction.isModalSubmit()) return await handleModalSubmit(interaction, { music, getGuildAutoplay });
      if (interaction.isButton()) return await handleButton(interaction, componentApi);
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'help') return privateReply(interaction, helpText());
      if (name === 'ping') {
        return privateReply(interaction, `🏓 Discord gateway: **${Math.max(0, Math.round(client.ws.ping))} ms**. Voice/audio latency is separate and is shown in \`/status\` while connected.`);
      }
      if (name === 'status') {
        const player = music.players.get(interaction.guildId);
        const mode = getGuildAutoplay(interaction.guildId);
        const volume = getGuildVolume(interaction.guildId);
        const health = getSourceHealth(interaction.guildId);
        const runtime = await getRuntimeStats();
        let lavalink = 'Unavailable';
        try { await music.getLeastUsedNode(); lavalink = 'Connected'; } catch { /* no online node */ }

        const lines = [
          `Discord gateway: **Online** (${Math.max(0, Math.round(client.ws.ping))} ms)`,
          `Lavalink: **${lavalink}**`,
          sourceHealthLine(health),
          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,
          `Autoplay: **${mode === 'ai' ? 'AI' : mode === 'standard' ? 'On' : 'Off'}**`,
          `Saved volume: **${volume}%**`,
          `Player: **${player ? (player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,
        ];

        if (player) {
          const voicePing = Number(player.shoukaku?.ping ?? 0);
          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms` : 'connected / measuring'}**`);
          if (player.queue.current) lines.push(`Current: **${safeTitle(player.queue.current, 100)}**`);
          lines.push(`Up next: **${player.queue.length}/${queueLimit}** | Loop: **${player.loop || 'none'}**`);
        } else {
          lines.push(`Queue safety limit: **${queueLimit} upcoming tracks**`);
        }

        const nodeMemory = runtime?.node;
        if (nodeMemory) lines.push(`Node RAM: **${mb(nodeMemory.rss)} RSS** • heap ${mb(nodeMemory.heapUsed)}/${mb(nodeMemory.heapTotal)}`);
        const llMemory = runtime?.lavalink?.memory;
        if (llMemory) lines.push(`Lavalink JVM: **${mb(llMemory.used)} used** • max ${mb(llMemory.reservable)}`);
        lines.push('RAM note: JVM figures are Lavalink runtime memory, not the Java process\'s complete Windows working set.');
        return privateReply(interaction, lines.join('\n'));
      }

      if (name === 'volume') {
        const n = interaction.options.getInteger('percent', true);
        const player = music.players.get(interaction.guildId);
        if (player) {
          requireSameVoice(interaction, player);
          await player.setVolume(n);
        }
        setGuildVolume(interaction.guildId, n);
        return privateReply(interaction, `Volume: **${n}%**. Saved until you change it again.`);
      }

      if (name === 'play' || name === 'playnext') {
        await privateDefer(interaction);
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const guard = () => assertQueueRequestActive(music, player, interaction.guildId, revision, isQueueRevisionCurrent);
        const queued = await searchAndQueue(player, interaction.options.getString('query', true), interaction.user, name === 'playnext', guard, queueTracks, queueLimit);
        const where = name === 'playnext' ? 'Queued next' : 'Queued';
        if (queued.result.type === 'PLAYLIST') {
          const limitNote = queued.omitted ? ` Limited for stability: **${queued.omitted} track${queued.omitted === 1 ? '' : 's'} not added** (max ${MAX_PLAYLIST_ADD} per playlist / ${queueLimit} upcoming).` : '';
          return interaction.editReply(`${where} **${queued.tracks.length} tracks**.${limitNote}`);
        }
        return interaction.editReply(`${where} **${safeTitle(queued.tracks[0])}**.`);
      }

      if (name === 'ai') {
        const autoplay = interaction.options.getString('autoplay');
        const request = interaction.options.getString('request');
        if (!autoplay && !request) throw new Error('Use either `request` or `autoplay`.');
        if (autoplay && request) throw new Error('Use `request` or `autoplay`, not both at the same time.');
        if (autoplay) {
          requireVoiceForSetting(interaction, music);
          const mode = autoplay === 'on' ? 'ai' : 'off';
          setGuildAutoplay(interaction.guildId, mode);
          return privateReply(interaction, `🤖 AI autoplay: **${autoplay.toUpperCase()}**.`);
        }

        await privateDefer(interaction);
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const guard = () => assertQueueRequestActive(music, player, interaction.guildId, revision, isQueueRevisionCurrent);
        const recent = recentHistory(interaction.guildId, 20);
        const plan = await gemini.makeQueue(request, { recent, maxSongs: 10 });
        guard();

        const seen = new Set(recent.map((row) => trackKey(row)).filter(Boolean));
        if (player.queue.current) {
          const key = trackKey(player.queue.current);
          if (key) seen.add(key);
        }
        for (const track of player.queue) {
          const key = trackKey(track);
          if (key) seen.add(key);
        }

        const resolved = await resolveSearchQueries(player, plan.queries, interaction.user, seen, 10, 3, guard);
        guard();
        if (!resolved.length) throw new Error('Gemini suggested songs, but none could be resolved by the music source.');
        const queued = queueTracks(player, resolved);
        if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
        if (!player.playing && !player.paused) await player.play();
        return interaction.editReply(`🤖 **${truncate(escapeMarkdown(plan.summary), 600)}**\nQueued ${queued.added.length} song${queued.added.length === 1 ? '' : 's'}${queued.omitted ? ` (${queued.omitted} omitted because the queue is full)` : ''}.`);
      }

      if (name === 'autoplay') {
        requireVoiceForSetting(interaction, music);
        const enabled = interaction.options.getString('mode', true) === 'on';
        setGuildAutoplay(interaction.guildId, enabled ? 'standard' : 'off');
        return privateReply(interaction, `Autoplay: **${enabled ? 'ON' : 'OFF'}**.`);
      }

      if (name === 'radio') {
        if (!recentHistory(interaction.guildId, 1).length) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');
        await privateDefer(interaction);
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const count = await startServerRadio(player, interaction.user, revision);
        return interaction.editReply(`📻 Server radio queued **${count} tracks** based on this server's listening history.`);
      }

      const player = getPlayer(music, interaction.guildId);
      if (name === 'nowplaying') {
        requireSameVoice(interaction, player);
        requireCurrentTrack(player);
        return privateReply(interaction, null, playerPanelPayload(player, getGuildAutoplay(interaction.guildId)));
      }
      requireSameVoice(interaction, player);

      if (name === 'pause') { requireCurrentTrack(player); player.pause(true); return privateReply(interaction, 'Paused.'); }
      if (name === 'resume') { requireCurrentTrack(player); player.pause(false); return privateReply(interaction, 'Resumed.'); }
      if (name === 'skip') { skipCurrent(player); return privateReply(interaction, 'Skipped.'); }
      if (name === 'previous') {
        const prev = player.getPrevious(false);
        if (!prev) throw new Error('No previous song is available.');
        await player.play(prev, { replaceCurrent: true });
        player.getPrevious(true);
        return privateReply(interaction, `Playing previous: **${safeTitle(prev)}**.`);
      }
      if (name === 'stop') {
        const removed = await stopAndResetPlayer(player, interaction.guildId, queueControls);
        return privateReply(interaction, `Stopped. Cleared **${removed} upcoming/preserved track${removed === 1 ? '' : 's'}**, previous-track state, loop, and autoplay.`);
      }
      if (name === 'disconnect') {
        await privateDefer(interaction);
        invalidateQueueWork(interaction.guildId);
        discardHeldQueue(interaction.guildId);
        await player.destroy();
        return interaction.editReply('Disconnected.');
      }
      if (name === 'clear') {
        const removed = clearUpcomingQueue(player, interaction.guildId, queueControls);
        const prefix = removed ? `Cleared **${removed} upcoming/preserved track${removed === 1 ? '' : 's'}**.` : 'The upcoming queue was already empty.';
        return privateReply(interaction, `${prefix} Current song keeps playing; loop and autoplay are **OFF** so the queue stays clear.`);
      }
      if (name === 'shuffle') {
        if (player.queue.length < 2) return privateReply(interaction, 'Need at least **2 upcoming songs** to shuffle.');
        player.queue.shuffle();
        return privateReply(interaction, `Shuffled **${player.queue.length} upcoming tracks**.`);
      }
      if (name === 'loop') {
        const mode = interaction.options.getString('mode', true);
        player.setLoop(mode);
        return privateReply(interaction, `Loop: **${mode === 'none' ? 'off' : mode}**.`);
      }
    } catch (error) {
      if (!error?.expected) console.error('[interaction]', error);
      const message = `⚠️ ${truncate(error?.message || 'Something went wrong.', 1800)}`;
      if (interaction.isMessageComponent?.() || interaction.isModalSubmit?.()) {
        if (interaction.deferred || interaction.replied) return interaction.followUp({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
        return interaction.reply({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
      }
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
      return interaction.reply({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
    }
  };
}

async function handleQueueSelect(interaction, { music }) {
  const player = getPlayer(music, interaction.guildId);
  const parts = interaction.customId.split(':');
  const page = Number.parseInt(parts[2], 10) || 0;
  const selectedIndex = Number.parseInt(interaction.values?.[0], 10);
  await interaction.deferUpdate();
  return interaction.editReply(queueManagerPayload(player, page, Number.isInteger(selectedIndex) ? selectedIndex : null));
}

async function handleModalSubmit(interaction, { music, getGuildAutoplay }) {
  if (interaction.customId !== 'music:seeksubmit') return;
  const player = getPlayer(music, interaction.guildId);
  requireSameVoice(interaction, player);
  requireCurrentTrack(player);
  if (player.queue.current?.isSeekable === false || player.queue.current?.isStream) throw new Error('This track cannot be seeked.');
  const seconds = parseTimeToSeconds(interaction.fields.getTextInputValue('position'));
  if (seconds === null) throw new Error('Use seconds, M:SS, or H:MM:SS (example: `1:37`).');
  const maxMs = Math.max(0, Number(player.queue.current.length || 0));
  const targetMs = Math.max(0, Math.min(maxMs || Number.MAX_SAFE_INTEGER, Math.round(seconds * 1000)));
  await interaction.deferUpdate();
  await player.seek(targetMs);
  return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId), `🎯 Seeked to **${Math.floor(targetMs / 1000)}s**.`));
}

async function handleButton(interaction, { music, gemini, setGuildAutoplay, getGuildAutoplay, setGuildVolume, invalidateQueueWork, discardHeldQueue }) {
  const player = getPlayer(music, interaction.guildId);
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const queueControls = { setGuildAutoplay, invalidateQueueWork, discardHeldQueue };

  // Read-only private navigation does not require joining voice.
  if (action === 'queue') {
    await interaction.deferUpdate();
    return interaction.editReply(queueManagerPayload(player, 0));
  }
  if (action === 'qpage' || action === 'qrefresh') {
    await interaction.deferUpdate();
    return interaction.editReply(queueManagerPayload(player, Number.parseInt(parts[2], 10) || 0));
  }
  if (action === 'qback' || action === 'back') {
    await interaction.deferUpdate();
    return interaction.editReply(playerPanelPayload(player, getGuildAutoplay(interaction.guildId)));
  }
  if (action === 'refresh') {
    await interaction.deferUpdate();
    return interaction.editReply(playerPanelPayload(player, getGuildAutoplay(interaction.guildId)));
  }
  if (action === 'more_refresh') {
    await interaction.deferUpdate();
    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));
  }

  requireSameVoice(interaction, player);

  if (action === 'seekmodal') return interaction.showModal(seekModal());
  if (action === 'more') {
    requireCurrentTrack(player);
    await interaction.deferUpdate();
    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));
  }

  if (action === 'qdedupe') {
    const page = Number.parseInt(parts[2], 10) || 0;
    const removed = dedupeUpcoming(player);
    await interaction.deferUpdate();
    return interaction.editReply(queueManagerPayload(player, page, null, removed ? `🧽 Removed ${removed} duplicate track${removed === 1 ? '' : 's'}.` : '🧽 No duplicates found.'));
  }

  if (['qremove', 'qnext', 'qplay'].includes(action)) {
    const index = Number.parseInt(parts[2], 10);
    const page = Number.parseInt(parts[3], 10) || 0;
    const expectedFingerprint = parts[4] || '';
    const selected = Number.isInteger(index) && index >= 0 ? player.queue[index] : null;
    if (!selected || queueFingerprint(selected) !== expectedFingerprint) throw expectedError('That queue item changed or no longer exists. Refresh the Queue Manager.');

    if (action === 'qremove') {
      player.queue.splice(index, 1);
      await interaction.deferUpdate();
      return interaction.editReply(queueManagerPayload(player, page, null, `🗑️ Removed **${safeTitle(selected, 80)}**.`));
    }
    if (action === 'qnext') {
      const [track] = player.queue.splice(index, 1);
      player.queue.unshift(track);
      await interaction.deferUpdate();
      return interaction.editReply(queueManagerPayload(player, 0, 0, `⬆️ Moved **${safeTitle(track, 80)}** to next.`));
    }
    const [track] = player.queue.splice(index, 1);
    await interaction.deferUpdate();
    await player.play(track);
    return interaction.editReply(playerPanelPayload(player, getGuildAutoplay(interaction.guildId), `▶️ Playing **${safeTitle(track, 80)}** now. The interrupted song was moved to the front of the queue.`));
  }

  if (action === 'seekdelta' || action === 'replay') {
    requireCurrentTrack(player);
    if (player.queue.current?.isSeekable === false || player.queue.current?.isStream) throw new Error('This track cannot be seeked.');
    const delta = action === 'replay' ? -Number(player.position || 0) : Number.parseInt(parts[2], 10) || 0;
    const max = Math.max(0, Number(player.queue.current.length || 0));
    const target = Math.max(0, Math.min(max || Number.MAX_SAFE_INTEGER, Number(player.position || 0) + delta));
    await interaction.deferUpdate();
    await player.seek(target);
    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId), action === 'replay' ? '🔁 Replaying from the beginning.' : `🎯 Seeked to ${Math.floor(target / 1000)}s.`));
  }

  if (action === 'previous' && !player.getPrevious(false)) throw new Error('No previous song is available.');

  await interaction.deferUpdate();
  let settle = false;
  let notice = null;

  if (action === 'pause') { requireCurrentTrack(player); player.pause(true); }
  else if (action === 'resume') { requireCurrentTrack(player); player.pause(false); }
  else if (action === 'skip') { skipCurrent(player); settle = true; }
  else if (action === 'previous') {
    const previous = player.getPrevious(false);
    if (!previous) throw new Error('No previous song is available.');
    await player.play(previous, { replaceCurrent: true });
    player.getPrevious(true);
    settle = true;
  }
  else if (action === 'shuffle') {
    if (player.queue.length < 2) notice = 'Need at least 2 upcoming songs to shuffle.';
    else player.queue.shuffle();
  }
  else if (action === 'clear') {
    const removed = clearUpcomingQueue(player, interaction.guildId, queueControls);
    notice = removed ? `🧹 Cleared ${removed} upcoming/preserved track${removed === 1 ? '' : 's'}. Loop and autoplay are off.` : '🧹 Queue already empty. Loop and autoplay are off.';
  }
  else if (action === 'stop') {
    const removed = await stopAndResetPlayer(player, interaction.guildId, queueControls);
    return interaction.editReply({ content: `Stopped and reset. Cleared ${removed} upcoming/preserved track${removed === 1 ? '' : 's'}.`, embeds: [], components: [] });
  } else if (action === 'loop') {
    const next = player.loop === 'none' ? 'track' : player.loop === 'track' ? 'queue' : 'none';
    player.setLoop(next);
  } else if (action === 'autoplay') {
    const current = getGuildAutoplay(interaction.guildId);
    const next = current === 'off' ? 'standard' : current === 'standard' && gemini.enabled ? 'ai' : 'off';
    setGuildAutoplay(interaction.guildId, next);
  } else if (action === 'volume_down') {
    const nextVolume = Math.max(0, player.volume - 10);
    await player.setVolume(nextVolume);
    setGuildVolume(interaction.guildId, nextVolume);
  } else if (action === 'volume_up') {
    const nextVolume = Math.min(100, player.volume + 10);
    await player.setVolume(nextVolume);
    setGuildVolume(interaction.guildId, nextVolume);
  } else {
    throw new Error('Unknown player control. Run `/nowplaying` again.');
  }

  if (settle) await new Promise((resolve) => setTimeout(resolve, 350));
  return interaction.editReply(playerPanelPayload(player, getGuildAutoplay(interaction.guildId), notice));
}
