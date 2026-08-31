import { createLivePanelRegistry } from './live-panel.js';
import { MessageFlags, REST, Routes, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import {
  addFavorite,
  countFavorites,
  countHistory,
  getFavoriteById,
  getHistoryById,
  historyPage,
  listFavorites,
  removeFavorite,
  toggleFavorite,
} from './storage.js';
import {
  favoritesPayload,
  historyPayload,
  jukeboxPlayerPayload,
  playbackToolsPayload,
  queueManagerPayload,
  searchPickerPayload,
  seekModal,
  statusButtons,
  undoButtonComponents,
} from './ui.js';
import { parseTimeToSeconds, trackKey, truncate } from './utils.js';
import { voiceTransportQuality } from './performance.js';
import { createSearchPickerRegistry } from './search-picker.js';
import { ensureQueuedPlayback } from './playback-start.js';

const PRIVATE_FLAGS = MessageFlags.Ephemeral;
const PUBLIC_NOWPLAYING_FLAGS = MessageFlags.SuppressNotifications;
const MAX_PLAYLIST_ADD = 250;
const UNDO_TTL_MS = 5 * 60_000;
const LIBRARY_PAGE_SIZE = 20;
const searchPickers = createSearchPickerRegistry();
const undoSnapshots = new Map();

export const commandDefinitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)).addBooleanOption(o => o.setName('select').setDescription('Privately choose from the top search results')),
  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)).addBooleanOption(o => o.setName('select').setDescription('Privately choose from the top search results')),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('previous').setDescription('Replay the previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and fully reset the active queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set persistent playback volume').addIntegerOption(o => o.setName('percent').setDescription('0-100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the shared Now Playing player panel'),
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
  const extraFlags = Number(extra.flags || 0);
  const payload = { ...extra, flags: PRIVATE_FLAGS | extraFlags };
  if (extraFlags & MessageFlags.IsComponentsV2) {
    delete payload.content;
    delete payload.embeds;
  } else if (content !== undefined && content !== null) {
    payload.content = content;
  }
  return interaction.reply(payload);
}

function privateDefer(interaction) {
  return interaction.deferReply({ flags: PRIVATE_FLAGS });
}

function publicNowPlayingReply(interaction, payload = {}) {
  return interaction.reply({
    ...payload,
    flags: Number(payload.flags || 0) | PUBLIC_NOWPLAYING_FLAGS,
  });
}

function isPublicComponentInteraction(interaction) {
  if (!interaction?.isMessageComponent?.()) return false;
  const flags = interaction?.message?.flags;
  if (typeof flags?.has === 'function') return !flags.has(MessageFlags.Ephemeral);
  return (Number(flags?.bitfield ?? flags ?? 0) & MessageFlags.Ephemeral) === 0;
}

function playerPanelPayload(player, autoplayMode, notice = null, { canUndo = false } = {}) {
  return jukeboxPlayerPayload(player, autoplayMode, notice, { canUndo });
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

async function searchTracks(player, query, requester, searchPreferred) {
  const result = await searchPreferred(player, query, requester);
  if (!result?.tracks?.length) throw new Error(`No results for: ${truncate(query, 120)}`);
  return { result, tracks: result.type === 'PLAYLIST' ? [...result.tracks] : [result.tracks[0]] };
}

async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit, searchPreferred, mutate = async (task) => task()) {
  const { tracks, result } = await searchTracks(player, query, requester, searchPreferred);
  guard();
  const perRequestLimit = result.type === 'PLAYLIST' ? MAX_PLAYLIST_ADD : 1;
  const queued = await mutate(async () => {
    guard();
    const value = queueTracks(player, tracks, { next, perRequestLimit });
    if (!value.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
    const startState = await ensureQueuedPlayback(player);
    return { value, startState };
  });
  return {
    tracks: queued.value.added,
    result,
    omitted: queued.value.omitted,
    sourceCount: tracks.length,
    started: Boolean(queued.startState?.started),
  };
}

async function resolveSearchQueries(player, queries, requester, seen = new Set(), limit = 10, concurrency = 3, guard = () => {}, searchPreferred = null) {
  const added = [];
  const cleanQueries = (queries || []).filter(Boolean);
  const width = Math.max(1, Math.min(5, concurrency));

  for (let offset = 0; offset < cleanQueries.length && added.length < limit; offset += width) {
    guard();
    const batch = cleanQueries.slice(offset, offset + width);
    const results = await Promise.all(batch.map((query) => (searchPreferred ? searchPreferred(player, query, requester) : player.search(query, { requester })).catch(() => null)));
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

function audioStreamLines(runtime, connected) {
  if (!connected) return [];
  const frames = runtime?.lavalink?.frameStats;
  if (!frames) return ['Audio stream: **Measuring / frame stats unavailable**'];
  const sent = Math.max(0, Number(frames.sent || 0));
  const nulled = Math.max(0, Number(frames.nulled || 0));
  const deficit = Number(frames.deficit || 0);
  const starving = nulled > 0 || deficit > 0;
  const signedDeficit = `${deficit > 0 ? '+' : ''}${deficit}`;
  return [
    `Audio stream: **${starving ? '⚠️ Frame starvation detected' : 'Smooth'}**`,
    `Audio frames: **${sent} sent** • ${nulled} nulled • ${signedDeficit} deficit`,
  ];
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(Math.max(0, n) * 100).toFixed(1)}%` : 'n/a';
}

function dedupeUpcoming(player) {
  const seen = new Set();
  const currentKey = trackKey(player?.queue?.current);
  if (currentKey) seen.add(currentKey);
  const removed = [];
  let index = 0;
  while (index < player.queue.length) {
    const key = trackKey(player.queue[index]);
    if (key && seen.has(key)) {
      const [track] = player.queue.splice(index, 1);
      removed.push({ track, index });
      continue;
    }
    if (key) seen.add(key);
    index += 1;
  }
  return { count: removed.length, removed };
}

function purgeTemporaryState() {
  const now = Date.now();
  for (const [guildId, entry] of undoSnapshots) if (entry.expiresAt <= now) undoSnapshots.delete(guildId);
}

function createSearchPicker(interaction, tracks, next, revision) {
  return searchPickers.create({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tracks,
    next,
    revision,
  });
}

function getSearchPicker(interaction, token) {
  return searchPickers.getOwned({ guildId: interaction.guildId, userId: interaction.user.id, token });
}

function setUndoSnapshot(guildId, snapshot) {
  purgeTemporaryState();
  undoSnapshots.set(guildId, { ...snapshot, expiresAt: Date.now() + UNDO_TTL_MS });
}

function getUndoSnapshot(guildId) {
  purgeTemporaryState();
  return undoSnapshots.get(guildId) || null;
}

function clearUndoSnapshot(guildId) {
  undoSnapshots.delete(guildId);
}

function captureClearUndo(player, autoplayMode, heldTracks = []) {
  const tracks = [...(player?.queue || []), ...(heldTracks || [])];
  if (!tracks.length) return null;
  return {
    type: 'clear',
    items: tracks.map((track, index) => ({ track, index })),
    loop: player.loop || 'none',
    autoplay: autoplayMode || 'off',
  };
}

function statusRecoveryLine(session) {
  if (!session) return null;
  const count = Number(session.queue?.length || 0);
  const ageMinutes = Math.max(0, Math.round((Date.now() - Number(session.updatedAt || Date.now())) / 60_000));
  const title = session.current ? safeTitle(session.current, 80) : 'saved queue';
  return `Recoverable session: **${title}** • ${count} upcoming • saved ~${ageMinutes}m ago`;
}

function libraryQuery(row) {
  return String(row?.uri || '').trim() || `${row?.author || ''} ${row?.title || ''}`.trim();
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
    '`/nowplaying` is the only public response and is sent with Discord silent-notification flags; all commands, detailed menus, confirmations, and errors stay private.',
    'The player auto-refreshes about every 10 seconds for up to ~14 minutes; Refresh or Back starts a fresh live window.',
    'Queue Manager: select tracks, Remove / Move Next / Play Now / Dedupe, with a 5-minute Undo for clear/remove/dedupe.',
    'More: seek/replay plus Favorites and Recent History. `/play select:true` privately lets you choose an exact search result.',
    'Plain-text song searches try YouTube Music first, then normal YouTube. Spotify URLs work when optional Spotify app credentials are configured.',
    '`/status` offers Resume/Discard when a recent crash/restart session is recoverable.',
    '`/clear` keeps the current song playing, clears everything upcoming, and turns loop/autoplay off.',
    '`/stop` fully resets current/upcoming/previous state. Volume stays saved until changed again.',
    'When the last human leaves the voice channel, active playback auto-pauses immediately; returning within 2 minutes auto-resumes it. Manual pauses are never auto-resumed.',
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
  isAutoPausedForEmptyVoice,
  discardHeldQueue,
  getHeldQueueSnapshot,
  withGuildOperation,
  checkpointRecovery,
  clearRecoverySession,
  getRecoverableSession,
  resumeRecoverySession,
  searchPreferred,
  isSpotifyConfigured,
}) {
  const queueLimit = getQueueLimit();
  const queueControls = { setGuildAutoplay, invalidateQueueWork, discardHeldQueue, clearRecoverySession };

  const canUndo = (guildId) => Boolean(getUndoSnapshot(guildId));
  const panelPayload = (player, guildId, notice = null) => playerPanelPayload(player, getGuildAutoplay(guildId), notice, { canUndo: canUndo(guildId) });
const queuePayload = (player, guildId, page = 0, selectedIndex = null, notice = null) => queueManagerPayload(player, page, selectedIndex, notice, { canUndo: canUndo(guildId) });

const livePanels = createLivePanelRegistry({
  render: async (sourceInteraction, { retiring }) => {
    const currentPlayer = music.players.get(sourceInteraction.guildId);
    if (!currentPlayer?.queue?.current && !Number(currentPlayer?.queue?.length || 0)) {
      return {
        payload: panelPayload(
          currentPlayer,
          sourceInteraction.guildId,
          '⏹️ Playback ended or the bot disconnected. Live refresh stopped.',
        ),
        stopAfter: true,
      };
    }
    return {
      payload: panelPayload(
        currentPlayer,
        sourceInteraction.guildId,
        retiring ? '⏱️ Live refresh ended after about 14 minutes. Press Refresh to resume live updates.' : null,
      ),
    };
  },
  onError: (error) => {
    const code = Number(error?.code || 0);
    if (![10015, 10062, 50027].includes(code)) console.warn('[live-panel]', error?.message || error);
  },
});

async function editLivePanel(interaction, player, notice = null) {
  const currentPlayer = music.players.get(interaction.guildId) || player;
  const result = await interaction.editReply(panelPayload(currentPlayer, interaction.guildId, notice));
  if (currentPlayer?.queue?.current || Number(currentPlayer?.queue?.length || 0) > 0) livePanels.track(interaction);
  else livePanels.pause(interaction);
  return result;
}

  function getHistoryPayload(guildId, page = 0, selectedId = null, notice = null) {
    const total = countHistory(guildId);
    const safePage = Math.max(0, Math.min(Math.max(0, Math.ceil(total / LIBRARY_PAGE_SIZE) - 1), Number.parseInt(page, 10) || 0));
    const rows = historyPage(guildId, LIBRARY_PAGE_SIZE, safePage * LIBRARY_PAGE_SIZE);
    return historyPayload(rows, total, safePage, selectedId, notice);
  }

  function getFavoritesPayload(guildId, userId, page = 0, selectedId = null, notice = null) {
    const total = countFavorites(guildId, userId);
    const safePage = Math.max(0, Math.min(Math.max(0, Math.ceil(total / LIBRARY_PAGE_SIZE) - 1), Number.parseInt(page, 10) || 0));
    const rows = listFavorites(guildId, userId, LIBRARY_PAGE_SIZE, safePage * LIBRARY_PAGE_SIZE);
    return favoritesPayload(rows, total, safePage, selectedId, notice);
  }

  async function queueLibraryRow(interaction, row, { playNow = false } = {}) {
    const query = libraryQuery(row);
    if (!query) throw expectedError('That saved track no longer has enough information to play.');
    const player = await ensurePlayer(interaction);
    const revision = getQueueRevision(interaction.guildId);
    const result = await searchPreferred(player, query, interaction.user);
    const track = result?.tracks?.[0];
    if (!track) throw new Error('The music source could not resolve that saved track.');
    await withGuildOperation(interaction.guildId, async () => {
      if (!isQueueRevisionCurrent(interaction.guildId, revision) || music.players.get(interaction.guildId) !== player) throw expectedError('The queue changed before that track could be added.');
      if (playNow) {
        // Kazagumo moves the interrupted current song to the front of the
        // upcoming queue. Reject Play Now at a full queue instead of silently
        // exceeding the 300-upcoming safety ceiling.
        if (player.queue.current && player.queue.length >= queueLimit) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks). Remove one track before using Play.`);
        await player.play(track);
      } else {
        const queued = queueTracks(player, [track], { next: true, perRequestLimit: 1 });
        if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
        await ensureQueuedPlayback(player);
      }
      checkpointRecovery(player);
    });
    return { player, track };
  }

  async function restoreUndo(interaction, player) {
    const snapshot = getUndoSnapshot(interaction.guildId);
    if (!snapshot) throw expectedError('Nothing recent is available to undo.');
    return withGuildOperation(interaction.guildId, async () => {
      const available = Math.max(0, queueLimit - player.queue.length);
      const items = (snapshot.items || []).slice(0, available);
      if (!items.length) throw expectedError(`Cannot restore tracks because the queue is full (maximum ${queueLimit}).`);
      if (snapshot.type === 'clear') {
        const tracks = items.map((item) => item.track);
        if (player.queue.current) player.queue.unshift(...tracks);
        else {
          const restored = queueTracks(player, tracks, { next: false, perRequestLimit: queueLimit });
          if (!restored.added.length) throw expectedError(`Cannot restore tracks because the queue is full (maximum ${queueLimit}).`);
          await ensureQueuedPlayback(player);
        }
        if (snapshot.loop && ['none', 'track', 'queue'].includes(snapshot.loop)) player.setLoop(snapshot.loop);
        if (snapshot.autoplay && ['off', 'standard', 'ai'].includes(snapshot.autoplay)) {
          try { setGuildAutoplay(interaction.guildId, snapshot.autoplay); } catch { setGuildAutoplay(interaction.guildId, 'off'); }
        }
      } else {
        for (const item of items) {
          const index = Math.max(0, Math.min(player.queue.length, Number(item.index || 0)));
          player.queue.splice(index, 0, item.track);
        }
      }
      clearUndoSnapshot(interaction.guildId);
      checkpointRecovery(player);
      return items.length;
    });
  }

  const componentApi = {
    music, gemini, ensurePlayer, queueTracks, queueLimit, setGuildAutoplay, getGuildAutoplay, setGuildVolume,
    invalidateQueueWork, isQueueRevisionCurrent, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,
    withGuildOperation, checkpointRecovery, panelPayload, queuePayload, getHistoryPayload, getFavoritesPayload,
    queueLibraryRow, restoreUndo, livePanels, editLivePanel,
  };

  return async function handle(interaction) {
    try {
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('music:qselect:')) return await handleQueueSelect(interaction, componentApi);
        if (interaction.customId.startsWith('music:spick:')) return await handleSearchSelect(interaction, componentApi);
        if (interaction.customId.startsWith('music:hselect:') || interaction.customId.startsWith('music:fselect:')) return await handleLibrarySelect(interaction, componentApi);
        return;
      }
      if (interaction.isModalSubmit()) return await handleModalSubmit(interaction, componentApi);
      if (interaction.isButton()) return await handleButton(interaction, componentApi);
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'help') return privateReply(interaction, helpText());
      if (name === 'ping') return privateReply(interaction, `🏓 Discord gateway: **${Math.max(0, Math.round(client.ws.ping))} ms**. Voice/audio latency is separate and is shown in \`/status\` while connected.`);

      if (name === 'status') {
        const player = music.players.get(interaction.guildId);
        const mode = getGuildAutoplay(interaction.guildId);
        const volume = getGuildVolume(interaction.guildId);
        const health = getSourceHealth(interaction.guildId);
        const runtime = await getRuntimeStats();
        const recovery = !player ? getRecoverableSession(interaction.guildId) : null;
        let lavalink = 'Unavailable';
        try { await music.getLeastUsedNode(); lavalink = 'Connected'; } catch { /* no online node */ }

        const lines = [
          `Discord gateway: **Online** (${Math.max(0, Math.round(client.ws.ping))} ms)`,
          `Lavalink: **${lavalink}**`,
          sourceHealthLine(health),
          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,
          `Spotify: **Tracks: oEmbed fallback${isSpotifyConfigured() ? ' + LavaSrc' : ''} • Albums/playlists: ${isSpotifyConfigured() ? 'Configured' : 'Not configured'}**`,
          `Autoplay: **${mode === 'ai' ? 'AI' : mode === 'standard' ? 'On' : 'Off'}**`,
          `Saved volume: **${volume}%**`,
          `Player: **${player ? (isAutoPausedForEmptyVoice(interaction.guildId) ? 'Auto-paused (empty VC)' : player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,
        ];
        if (player) {
          const voicePing = Number(player.shoukaku?.ping ?? 0);
          lines.push(`Voice transport: **${voicePing > 0 ? `${Math.round(voicePing)} ms • ${voiceTransportQuality(voicePing)}` : 'connected / measuring'}**`);
          lines.push(...audioStreamLines(runtime, true));
          if (player.queue.current) lines.push(`Current: **${safeTitle(player.queue.current, 100)}**`);
          lines.push(`Up next: **${player.queue.length}/${queueLimit}** | Loop: **${player.loop || 'none'}**`);
        } else {
          lines.push(`Queue safety limit: **${queueLimit} upcoming tracks**`);
          const recoveryLine = statusRecoveryLine(recovery);
          if (recoveryLine) lines.push(recoveryLine);
        }
        const nodeMemory = runtime?.node;
        if (nodeMemory) lines.push(`Node RAM: **${mb(nodeMemory.rss)} RSS** • heap ${mb(nodeMemory.heapUsed)}/${mb(nodeMemory.heapTotal)}`);
        const llMemory = runtime?.lavalink?.memory;
        if (llMemory) lines.push(`Lavalink JVM: **${mb(llMemory.used)} used** • max ${mb(llMemory.reservable)}`);
        const llCpu = runtime?.lavalink?.cpu;
        if (llCpu) lines.push(`Lavalink CPU: **${percent(llCpu.lavalinkLoad)}** • system ${percent(llCpu.systemLoad)}`);
        lines.push('RAM note: JVM figures are Lavalink runtime memory, not the Java process\'s complete Windows working set.');
        return privateReply(interaction, lines.join('\n'), { components: statusButtons({ hasRecovery: Boolean(recovery) }) });
      }

      if (name === 'volume') {
        const n = interaction.options.getInteger('percent', true);
        const player = music.players.get(interaction.guildId);
        if (player) {
          requireSameVoice(interaction, player);
          await withGuildOperation(interaction.guildId, async () => { await player.setVolume(n); checkpointRecovery(player); });
        }
        setGuildVolume(interaction.guildId, n);
        return privateReply(interaction, `Volume: **${n}%**. Saved until you change it again.`);
      }

      if (name === 'play' || name === 'playnext') {
        await privateDefer(interaction);
        const query = interaction.options.getString('query', true);
        const next = name === 'playnext';
        if (interaction.options.getBoolean('select') === true) {
          const result = await searchPreferred(music, query, interaction.user);
          if (!result?.tracks?.length) throw new Error(`No results for: ${truncate(query, 120)}`);
          if (result.type !== 'PLAYLIST' && result.tracks.length > 1) {
            const token = createSearchPicker(interaction, result.tracks, next, getQueueRevision(interaction.guildId));
            return interaction.editReply(searchPickerPayload(token, result.tracks, next ? 'next' : 'play'));
          }
          // A playlist/direct URL has one unambiguous target; queue it normally.
        }
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const guard = () => assertQueueRequestActive(music, player, interaction.guildId, revision, isQueueRevisionCurrent);
        const queued = await searchAndQueue(player, query, interaction.user, next, guard, queueTracks, queueLimit, searchPreferred, (task) => withGuildOperation(interaction.guildId, task));
        checkpointRecovery(player);
        if (queued.result.type === 'PLAYLIST') {
          const action = next ? 'Queued next' : queued.started ? '▶️ Started playlist with' : 'Queued';
          const limitNote = queued.omitted ? ` Limited for stability: **${queued.omitted} track${queued.omitted === 1 ? '' : 's'} not added** (max ${MAX_PLAYLIST_ADD} per playlist / ${queueLimit} upcoming).` : '';
          return interaction.editReply(`${action} **${queued.tracks.length} tracks**.${limitNote}`);
        }
        const action = next ? 'Queued next' : queued.started ? '▶️ Playing' : 'Queued';
        return interaction.editReply(`${action} **${safeTitle(queued.tracks[0])}**.`);
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
          const player = music.players.get(interaction.guildId);
          if (player) checkpointRecovery(player);
          return privateReply(interaction, `🤖 AI autoplay: **${autoplay.toUpperCase()}**.`);
        }

        await privateDefer(interaction);
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const guard = () => assertQueueRequestActive(music, player, interaction.guildId, revision, isQueueRevisionCurrent);
        const recent = historyPage(interaction.guildId, 20, 0);
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
        const resolved = await resolveSearchQueries(player, plan.queries, interaction.user, seen, 10, 3, guard, searchPreferred);
        guard();
        if (!resolved.length) throw new Error('Gemini suggested songs, but none could be resolved by the music source.');
        const queued = await withGuildOperation(interaction.guildId, async () => {
          guard();
          const value = queueTracks(player, resolved);
          if (!value.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
          await ensureQueuedPlayback(player);
          checkpointRecovery(player);
          return value;
        });
        return interaction.editReply(`🤖 **${truncate(escapeMarkdown(plan.summary), 600)}**\nQueued ${queued.added.length} song${queued.added.length === 1 ? '' : 's'}${queued.omitted ? ` (${queued.omitted} omitted because the queue is full)` : ''}.`);
      }

      if (name === 'autoplay') {
        requireVoiceForSetting(interaction, music);
        const enabled = interaction.options.getString('mode', true) === 'on';
        setGuildAutoplay(interaction.guildId, enabled ? 'standard' : 'off');
        const player = music.players.get(interaction.guildId);
        if (player) checkpointRecovery(player);
        return privateReply(interaction, `Autoplay: **${enabled ? 'ON' : 'OFF'}**.`);
      }

      if (name === 'radio') {
        if (!countHistory(interaction.guildId)) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');
        await privateDefer(interaction);
        const player = await ensurePlayer(interaction);
        const revision = getQueueRevision(interaction.guildId);
        const count = await startServerRadio(player, interaction.user, revision);
        checkpointRecovery(player);
        return interaction.editReply(`📻 Server radio queued **${count} tracks** based on this server's listening history.`);
      }

      const player = getPlayer(music, interaction.guildId);
      if (name === 'nowplaying') {
        requireSameVoice(interaction, player);
        let notice = null;
        if (!player.queue.current && player.queue.length > 0) {
          try {
            await withGuildOperation(interaction.guildId, async () => {
              await ensureQueuedPlayback(player);
              checkpointRecovery(player);
            });
          } catch (error) {
            notice = `⚠️ Playback is idle: ${error?.message || 'the queued track could not start.'}`;
          }
        }
        await publicNowPlayingReply(interaction, panelPayload(player, interaction.guildId, notice));
        if (player.queue.current || player.queue.length > 0) livePanels.track(interaction);
        return;
      }
      requireSameVoice(interaction, player);

      if (name === 'pause') return withGuildOperation(interaction.guildId, async () => { requireCurrentTrack(player); player.pause(true); checkpointRecovery(player); return privateReply(interaction, 'Paused.'); });
      if (name === 'resume') return withGuildOperation(interaction.guildId, async () => { requireCurrentTrack(player); player.pause(false); checkpointRecovery(player); return privateReply(interaction, 'Resumed.'); });
      if (name === 'skip') return withGuildOperation(interaction.guildId, async () => { skipCurrent(player); checkpointRecovery(player); return privateReply(interaction, 'Skipped.'); });
      if (name === 'previous') return withGuildOperation(interaction.guildId, async () => {
        const prev = player.getPrevious(false);
        if (!prev) throw new Error('No previous song is available.');
        await player.play(prev, { replaceCurrent: true });
        player.getPrevious(true);
        checkpointRecovery(player);
        return privateReply(interaction, `Playing previous: **${safeTitle(prev)}**.`);
      });
      if (name === 'stop') return withGuildOperation(interaction.guildId, async () => {
        clearUndoSnapshot(interaction.guildId);
        const removed = await stopAndResetPlayer(player, interaction.guildId, queueControls);
        clearRecoverySession(interaction.guildId);
        return privateReply(interaction, `Stopped. Cleared **${removed} upcoming/preserved track${removed === 1 ? '' : 's'}**, previous-track state, loop, and autoplay.`);
      });
      if (name === 'disconnect') {
        await privateDefer(interaction);
        return withGuildOperation(interaction.guildId, async () => {
          clearUndoSnapshot(interaction.guildId);
          invalidateQueueWork(interaction.guildId);
          discardHeldQueue(interaction.guildId);
          clearRecoverySession(interaction.guildId);
          await player.destroy();
          return interaction.editReply('Disconnected.');
        });
      }
      if (name === 'clear') return withGuildOperation(interaction.guildId, async () => {
        const undo = captureClearUndo(player, getGuildAutoplay(interaction.guildId), getHeldQueueSnapshot(interaction.guildId));
        if (undo) setUndoSnapshot(interaction.guildId, undo);
        const removed = clearUpcomingQueue(player, interaction.guildId, queueControls);
        checkpointRecovery(player);
        const prefix = removed ? `Cleared **${removed} upcoming/preserved track${removed === 1 ? '' : 's'}**.` : 'The upcoming queue was already empty.';
        return privateReply(
          interaction,
          `${prefix} Current song keeps playing; loop and autoplay are **OFF** so the queue stays clear.${undo ? ' Undo is available for 5 minutes.' : ''}`,
          undo ? { components: undoButtonComponents() } : {},
        );
      });
      if (name === 'shuffle') return withGuildOperation(interaction.guildId, async () => {
        if (player.queue.length < 2) return privateReply(interaction, 'Need at least **2 upcoming songs** to shuffle.');
        player.queue.shuffle();
        checkpointRecovery(player);
        return privateReply(interaction, `Shuffled **${player.queue.length} upcoming tracks**.`);
      });
      if (name === 'loop') return withGuildOperation(interaction.guildId, async () => {
        const mode = interaction.options.getString('mode', true);
        player.setLoop(mode);
        checkpointRecovery(player);
        return privateReply(interaction, `Loop: **${mode === 'none' ? 'off' : mode}**.`);
      });
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

async function handleQueueSelect(interaction, { music, queuePayload }) {
  const player = getPlayer(music, interaction.guildId);
  const parts = interaction.customId.split(':');
  const page = Number.parseInt(parts[2], 10) || 0;
  const selectedIndex = Number.parseInt(interaction.values?.[0], 10);
  await interaction.deferUpdate();
  return interaction.editReply(queuePayload(player, interaction.guildId, page, Number.isInteger(selectedIndex) ? selectedIndex : null));
}

async function handleSearchSelect(interaction, { music, ensurePlayer, queueTracks, queueLimit, withGuildOperation, checkpointRecovery, isQueueRevisionCurrent }) {
  const token = interaction.customId.split(':')[2] || '';
  const entry = getSearchPicker(interaction, token);
  if (!entry) throw expectedError('That search picker expired. Run the command again.');
  if (!isQueueRevisionCurrent(interaction.guildId, entry.revision)) {
    searchPickers.delete(token);
    throw expectedError('That search picker is stale because the queue changed. Run `/play` again.');
  }
  const index = Number.parseInt(interaction.values?.[0], 10);
  const track = Number.isInteger(index) ? entry.tracks[index] : null;
  if (!track) throw expectedError('That search result is no longer available.');
  await interaction.deferUpdate();
  const player = await ensurePlayer(interaction);
  await withGuildOperation(interaction.guildId, async () => {
    if (!isQueueRevisionCurrent(interaction.guildId, entry.revision) || music.players.get(interaction.guildId) !== player) {
      searchPickers.delete(token);
      throw expectedError('That search picker is stale because the queue changed. Run `/play` again.');
    }
    const queued = queueTracks(player, [track], { next: entry.next, perRequestLimit: 1 });
    if (!queued.added.length) throw expectedError(`Queue is full (maximum ${queueLimit} upcoming tracks).`);
    await ensureQueuedPlayback(player);
    checkpointRecovery(player);
  });
  searchPickers.delete(token);
  return interaction.editReply({ content: `${entry.next ? 'Queued next' : 'Queued'} **${safeTitle(track)}**.`, embeds: [], components: [] });
}

async function handleLibrarySelect(interaction, { getHistoryPayload, getFavoritesPayload }) {
  const parts = interaction.customId.split(':');
  const kind = parts[1][0];
  const page = Number.parseInt(parts[2], 10) || 0;
  const selectedId = Number.parseInt(interaction.values?.[0], 10);
  await interaction.deferUpdate();
  if (kind === 'h') return interaction.editReply(getHistoryPayload(interaction.guildId, page, selectedId));
  return interaction.editReply(getFavoritesPayload(interaction.guildId, interaction.user.id, page, selectedId));
}

async function handleModalSubmit(interaction, { music, getGuildAutoplay, withGuildOperation, checkpointRecovery }) {
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
  await withGuildOperation(interaction.guildId, async () => { await player.seek(targetMs); checkpointRecovery(player); });
  return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId), `🎯 Seeked to **${Math.floor(targetMs / 1000)}s**.`));
}

async function handleButton(interaction, api) {
  const {
    music, gemini, ensurePlayer, queueTracks, queueLimit, setGuildAutoplay, getGuildAutoplay, setGuildVolume,
    invalidateQueueWork, discardHeldQueue, getHeldQueueSnapshot, clearRecoverySession, getRecoverableSession, resumeRecoverySession,
    withGuildOperation, checkpointRecovery, panelPayload, queuePayload, getHistoryPayload, getFavoritesPayload,
    queueLibraryRow, restoreUndo, livePanels, editLivePanel,
  } = api;
  const queueControls = { setGuildAutoplay, invalidateQueueWork, discardHeldQueue };
  const parts = interaction.customId.split(':');
  const action = parts[1];

  // Private sub-views keep their own per-user refresh lease. A public Now Playing
  // button must not kill the shared public lease merely because it opens a
  // private Queue/More view. Direct public controls can renew the public lease.
  const publicSource = isPublicComponentInteraction(interaction);
  if (!publicSource) livePanels.pause(interaction);

  // Library/status/recovery controls work even while the bot is disconnected.
  if (action === 'history') {
    await interaction.deferUpdate();
    return interaction.editReply(getHistoryPayload(interaction.guildId, 0));
  }
  if (action === 'favorites') {
    await interaction.deferUpdate();
    return interaction.editReply(getFavoritesPayload(interaction.guildId, interaction.user.id, 0));
  }
  if (['hpage', 'hrefresh'].includes(action)) {
    await interaction.deferUpdate();
    return interaction.editReply(getHistoryPayload(interaction.guildId, Number.parseInt(parts[2], 10) || 0));
  }
  if (['fpage', 'frefresh'].includes(action)) {
    await interaction.deferUpdate();
    return interaction.editReply(getFavoritesPayload(interaction.guildId, interaction.user.id, Number.parseInt(parts[2], 10) || 0));
  }
  if (action === 'libraryback') {
    await interaction.deferUpdate();
    const player = music.players.get(interaction.guildId);
    if (player?.queue?.current) return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));
    return interaction.editReply(playbackToolsPayload(null, getGuildAutoplay(interaction.guildId), 'Library closed. Use `/status` for full bot health.'));
  }
  if (action === 'spcancel') {
    const token = parts[2] || '';
    const entry = getSearchPicker(interaction, token);
    if (entry) searchPickers.delete(token);
    await interaction.deferUpdate();
    return interaction.editReply({ content: 'Search selection canceled.', embeds: [], components: [] });
  }
  if (action === 'recovery_discard') {
    clearRecoverySession(interaction.guildId);
    await interaction.deferUpdate();
    return interaction.editReply({ content: 'Saved recovery session discarded.', embeds: [], components: statusButtons() });
  }
  if (action === 'recovery_resume') {
    const session = getRecoverableSession(interaction.guildId);
    if (!session) throw expectedError('No recent recoverable session is available.');
    if (!interaction.member?.voice?.channelId) throw expectedError('Join the voice channel where you want to resume, then press Resume Session again.');
    await interaction.deferUpdate();
    const result = await resumeRecoverySession(interaction, session);
    const background = result.restoring ? ` Restoring up to **${result.restoring}** additional saved track(s) in the background.` : '';
    return editLivePanel(interaction, music.players.get(interaction.guildId), `✅ Resumed **${safeTitle(result.current, 90)}** near the saved position.${background}`);
  }

  if (action.startsWith('h') && ['hplay', 'hnext', 'hfavorite'].includes(action)) {
    const id = Number.parseInt(parts[2], 10);
    const page = Number.parseInt(parts[3], 10) || 0;
    const row = getHistoryById(interaction.guildId, id);
    if (!row) throw expectedError('That history entry is no longer available. Refresh History.');
    if (action === 'hfavorite') {
      addFavorite(interaction.guildId, interaction.user.id, row);
      await interaction.deferUpdate();
      return interaction.editReply(getHistoryPayload(interaction.guildId, page, id, `❤️ Saved **${safeTitle(row, 80)}** to your favorites.`));
    }
    await interaction.deferUpdate();
    const { track } = await queueLibraryRow(interaction, row, { playNow: action === 'hplay' });
    return interaction.editReply(getHistoryPayload(interaction.guildId, page, id, `${action === 'hplay' ? '▶️ Playing' : '⬆️ Queued next'} **${safeTitle(track, 80)}**.`));
  }

  if (action.startsWith('f') && ['fplay', 'fnext', 'fremove'].includes(action)) {
    const id = Number.parseInt(parts[2], 10);
    const page = Number.parseInt(parts[3], 10) || 0;
    const row = getFavoriteById(interaction.guildId, interaction.user.id, id);
    if (!row) throw expectedError('That favorite is no longer available. Refresh Favorites.');
    const expectedFingerprint = parts[4] || '';
    if (expectedFingerprint && expectedFingerprint !== queueFingerprint(row)) throw expectedError('That favorite changed or was replaced. Refresh Favorites.');
    if (action === 'fremove') {
      removeFavorite(interaction.guildId, interaction.user.id, row.uri);
      await interaction.deferUpdate();
      return interaction.editReply(getFavoritesPayload(interaction.guildId, interaction.user.id, page, null, `💔 Removed **${safeTitle(row, 80)}** from favorites.`));
    }
    await interaction.deferUpdate();
    const { track } = await queueLibraryRow(interaction, row, { playNow: action === 'fplay' });
    return interaction.editReply(getFavoritesPayload(interaction.guildId, interaction.user.id, page, id, `${action === 'fplay' ? '▶️ Playing' : '⬆️ Queued next'} **${safeTitle(track, 80)}**.`));
  }

  const player = getPlayer(music, interaction.guildId);

  // Read-only player navigation does not require joining voice.
  if (action === 'queue') {
    if (publicSource) return privateReply(interaction, null, queuePayload(player, interaction.guildId, 0));
    await interaction.deferUpdate();
    return interaction.editReply(queuePayload(player, interaction.guildId, 0));
  }
  if (action === 'qpage' || action === 'qrefresh') { await interaction.deferUpdate(); return interaction.editReply(queuePayload(player, interaction.guildId, Number.parseInt(parts[2], 10) || 0)); }
  if (action === 'qback' || action === 'back') { await interaction.deferUpdate(); return editLivePanel(interaction, player); }
  if (action === 'refresh') { await interaction.deferUpdate(); return editLivePanel(interaction, player); }
  if (action === 'more_refresh') { await interaction.deferUpdate(); return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId))); }
  if (action === 'favorite') {
    requireCurrentTrack(player);
    const expectedFingerprint = parts[2] || '';
    if (expectedFingerprint && expectedFingerprint !== queueFingerprint(player.queue.current)) {
      throw expectedError('The song changed since this panel was opened. Refresh the player before favoriting.');
    }
    const added = toggleFavorite(interaction.guildId, interaction.user.id, player.queue.current);
    if (publicSource) return privateReply(interaction, `${added ? '❤️ Added to' : '💔 Removed from'} your favorites.`);
    await interaction.deferUpdate();
    return editLivePanel(interaction, player, `${added ? '❤️ Added to' : '💔 Removed from'} your favorites.`);
  }

  requireSameVoice(interaction, player);
  if (action === 'seekmodal') return interaction.showModal(seekModal());
  if (action === 'more') {
    requireCurrentTrack(player);
    if (publicSource) return privateReply(interaction, null, playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));
    await interaction.deferUpdate();
    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId)));
  }

  if (action === 'undo') {
    await interaction.deferUpdate();
    const restored = await restoreUndo(interaction, player);
    return editLivePanel(interaction, player, `↩️ Restored **${restored} track${restored === 1 ? '' : 's'}** from the last queue change.`);
  }

  if (action === 'qdedupe') {
    const page = Number.parseInt(parts[2], 10) || 0;
    await interaction.deferUpdate();
    const result = await withGuildOperation(interaction.guildId, async () => {
      const value = dedupeUpcoming(player);
      if (value.count) setUndoSnapshot(interaction.guildId, { type: 'dedupe', items: value.removed });
      checkpointRecovery(player);
      return value;
    });
    return interaction.editReply(queuePayload(player, interaction.guildId, page, null, result.count ? `🧽 Removed ${result.count} duplicate track${result.count === 1 ? '' : 's'}. Undo is available for 5 minutes.` : '🧽 No duplicates found.'));
  }

  if (['qremove', 'qnext', 'qplay'].includes(action)) {
    const index = Number.parseInt(parts[2], 10);
    const page = Number.parseInt(parts[3], 10) || 0;
    const expectedFingerprint = parts[4] || '';
    await interaction.deferUpdate();
    return withGuildOperation(interaction.guildId, async () => {
      const selected = Number.isInteger(index) && index >= 0 ? player.queue[index] : null;
      if (!selected || queueFingerprint(selected) !== expectedFingerprint) throw expectedError('That queue item changed or no longer exists. Refresh the Queue Manager.');
      if (action === 'qremove') {
        const [track] = player.queue.splice(index, 1);
        setUndoSnapshot(interaction.guildId, { type: 'remove', items: [{ track, index }] });
        checkpointRecovery(player);
        return interaction.editReply(queuePayload(player, interaction.guildId, page, null, `🗑️ Removed **${safeTitle(track, 80)}**. Undo is available for 5 minutes.`));
      }
      if (action === 'qnext') {
        const [track] = player.queue.splice(index, 1);
        player.queue.unshift(track);
        checkpointRecovery(player);
        return interaction.editReply(queuePayload(player, interaction.guildId, 0, 0, `⬆️ Moved **${safeTitle(track, 80)}** to next.`));
      }
      const [track] = player.queue.splice(index, 1);
      await player.play(track);
      checkpointRecovery(player);
      return editLivePanel(interaction, player, `▶️ Playing **${safeTitle(track, 80)}** now. The interrupted song was moved to the front of the queue.`);
    });
  }

  if (action === 'seekdelta' || action === 'replay') {
    requireCurrentTrack(player);
    if (player.queue.current?.isSeekable === false || player.queue.current?.isStream) throw new Error('This track cannot be seeked.');
    const delta = action === 'replay' ? -Number(player.position || 0) : Number.parseInt(parts[2], 10) || 0;
    const max = Math.max(0, Number(player.queue.current.length || 0));
    const target = Math.max(0, Math.min(max || Number.MAX_SAFE_INTEGER, Number(player.position || 0) + delta));
    await interaction.deferUpdate();
    await withGuildOperation(interaction.guildId, async () => { await player.seek(target); checkpointRecovery(player); });
    return interaction.editReply(playbackToolsPayload(player, getGuildAutoplay(interaction.guildId), action === 'replay' ? '🔁 Replaying from the beginning.' : `🎯 Seeked to ${Math.floor(target / 1000)}s.`));
  }

  if (action === 'previous' && !player.getPrevious(false)) throw new Error('No previous song is available.');
  await interaction.deferUpdate();

  return withGuildOperation(interaction.guildId, async () => {
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
    } else if (action === 'shuffle') {
      if (player.queue.length < 2) notice = 'Need at least 2 upcoming songs to shuffle.';
      else player.queue.shuffle();
    } else if (action === 'clear') {
      const undo = captureClearUndo(player, getGuildAutoplay(interaction.guildId), getHeldQueueSnapshot(interaction.guildId));
      if (undo) setUndoSnapshot(interaction.guildId, undo);
      const removed = clearUpcomingQueue(player, interaction.guildId, queueControls);
      notice = removed ? `🧹 Cleared ${removed} upcoming/preserved track${removed === 1 ? '' : 's'}. Loop and autoplay are off.${undo ? ' Undo is available for 5 minutes.' : ''}` : '🧹 Queue already empty. Loop and autoplay are off.';
    } else if (action === 'stop') {
      clearUndoSnapshot(interaction.guildId);
      const removed = await stopAndResetPlayer(player, interaction.guildId, queueControls);
      clearRecoverySession(interaction.guildId);
      return editLivePanel(interaction, player, `⏹️ Stopped and reset. Cleared ${removed} upcoming/preserved track${removed === 1 ? '' : 's'}.`);
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
    checkpointRecovery(player);
    if (settle) await new Promise((resolve) => setTimeout(resolve, 350));
    return editLivePanel(interaction, player, notice);
  });
}
