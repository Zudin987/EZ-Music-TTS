import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import { formatDuration, truncate } from './utils.js';

const QUEUE_PAGE_SIZE = 25;
const LIBRARY_PAGE_SIZE = 20;

function prettyLoop(loop) {
  if (loop === 'track') return 'Track';
  if (loop === 'queue') return 'Queue';
  return 'Off';
}

function prettyAutoplay(mode) {
  if (mode === 'ai') return 'AI';
  if (mode === 'standard') return 'On';
  return 'Off';
}

function safeText(value, max) {
  return truncate(escapeMarkdown(String(value ?? '')), max);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
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

function clampPage(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  return Math.max(0, Math.min(pages - 1, Number.parseInt(page, 10) || 0));
}

function progressText(track, player) {
  const length = Math.max(0, Number(track?.length || 0));
  const rawPosition = Number(player?.position || 0);
  const position = Number.isFinite(rawPosition) ? Math.max(0, Math.min(length || Number.MAX_SAFE_INTEGER, rawPosition)) : 0;
  if (!length || track?.isStream) return track?.isStream ? '`LIVE`' : `\`${formatDuration(position)}\``;

  const width = 12;
  const ratio = Math.max(0, Math.min(1, position / length));
  const marker = Math.min(width - 1, Math.floor(ratio * width));
  const bar = Array.from({ length: width }, (_, index) => (index === marker ? '●' : '━')).join('');
  return `\`${formatDuration(position)} ${bar} ${formatDuration(length)}\``;
}

export function playerButtons(player, autoplayMode = 'off', { canUndo = false } = {}) {
  const paused = Boolean(player?.paused);
  const hasCurrent = Boolean(player?.queue?.current);
  const upcoming = Number(player?.queue?.length || 0);
  const hasPrevious = Boolean(player?.getPrevious?.(false));
  const volume = Math.round(Number(player?.volume || 0));
  const clearHasEffect = upcoming > 0 || player?.loop !== 'none' || autoplayMode !== 'off';

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:previous').setLabel('Previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(!hasPrevious),
      new ButtonBuilder().setCustomId('music:loop').setLabel(`Loop: ${prettyLoop(player?.loop)}`).setEmoji('🔁').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(paused ? 'music:resume' : 'music:pause').setLabel(paused ? 'Resume' : 'Pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary).setDisabled(!hasCurrent),
      new ButtonBuilder().setCustomId('music:shuffle').setLabel('Shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(upcoming < 2),
      new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!hasCurrent),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:queue').setLabel(`Queue (${upcoming})`).setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:clear').setLabel('Clear').setEmoji('🧹').setStyle(ButtonStyle.Secondary).setDisabled(!clearHasEffect),
      new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!hasCurrent && upcoming === 0),
      new ButtonBuilder().setCustomId('music:autoplay').setLabel(`Autoplay: ${prettyAutoplay(autoplayMode)}`).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:volume_down').setLabel('Vol -').setEmoji('🔉').setStyle(ButtonStyle.Secondary).setDisabled(volume <= 0),
      new ButtonBuilder().setCustomId('music:volume_up').setLabel('Vol +').setEmoji('🔊').setStyle(ButtonStyle.Secondary).setDisabled(volume >= 100),
      new ButtonBuilder().setCustomId(`music:favorite:${hasCurrent ? queueFingerprint(player.queue.current) : 'none'}`).setLabel('Favorite').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(!hasCurrent),
      new ButtonBuilder().setCustomId('music:more').setLabel('More').setEmoji('⚙️').setStyle(ButtonStyle.Secondary).setDisabled(!hasCurrent),
      new ButtonBuilder().setCustomId('music:refresh').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (canUndo) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:undo').setLabel('Undo Last Queue Change').setEmoji('↩️').setStyle(ButtonStyle.Primary),
    ));
  }
  return rows;
}

export function nowPlayingEmbed(track, player, autoplayMode = 'off') {
  const requester = track?.requester?.displayName || track?.requester?.globalName || track?.requester?.username || 'Unknown';
  const title = safeText(track?.title || 'Unknown title', 240);
  const uri = safeHttpUrl(track?.uri || track?.realUri);
  const next = player?.queue?.[0];
  const queueCount = Number(player?.queue?.length || 0);
  const queueDuration = Number(player?.queue?.durationLength || 0);

  const embed = new EmbedBuilder()
    .setTitle('🎵 Now Playing')
    .setDescription(`**${title}**\n${progressText(track, player)}`)
    .addFields(
      { name: '🎙️ Artist', value: safeText(track?.author || 'Unknown', 100), inline: true },
      { name: '⏱️ Duration', value: formatDuration(track?.length || 0), inline: true },
      { name: '👤 Requester', value: safeText(requester, 100), inline: true },
    )
    .setFooter({
      text: `Volume: ${Math.round(player?.volume ?? 0)}% | Loop: ${prettyLoop(player?.loop)} | Autoplay: ${prettyAutoplay(autoplayMode)} | Up next: ${queueCount}${queueDuration > 0 ? ` (${formatDuration(queueDuration)})` : ''}`,
    });

  if (uri) embed.setURL(uri);
  if (next) embed.addFields({ name: '⏭️ Up Next', value: `${safeText(next.title, 90)} • ${formatDuration(next.length || 0)}` });
  const thumbnail = safeHttpUrl(track?.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

export function queueManagerPayload(player, page = 0, selectedIndex = null, notice = null, { canUndo = false } = {}) {
  const total = Number(player?.queue?.length || 0);
  const safePage = clampPage(total, page, QUEUE_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const start = safePage * QUEUE_PAGE_SIZE;
  const pageTracks = [...(player?.queue || [])].slice(start, start + QUEUE_PAGE_SIZE);
  const current = player?.queue?.current;
  const selected = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < total ? player.queue[selectedIndex] : null;

  const lines = ['**📜 Private Queue Manager**'];
  if (current) lines.push(`Now: **${safeText(current.title, 70)}** — ${safeText(current.author, 35)}`);
  lines.push(`Up next: **${total}** • Page **${safePage + 1}/${pages}**`);
  if (selected) lines.push(`Selected #${selectedIndex + 1}: **${safeText(selected.title, 70)}** — ${safeText(selected.author, 35)}`);
  if (notice) lines.push('', safeText(notice, 600));
  if (!total) lines.push('', 'Nothing is queued.');
  else lines.push('', 'Select a track below to remove it, move it next, or play it now.');

  const components = [];
  if (pageTracks.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`music:qselect:${safePage}`)
      .setPlaceholder('Choose an upcoming track')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(pageTracks.map((track, offset) => ({
        label: truncate(`${start + offset + 1}. ${String(track?.title || 'Unknown title')}`, 100),
        description: truncate(`${String(track?.author || 'Unknown')} • ${formatDuration(track?.length || 0)}`, 100),
        value: String(start + offset),
      })));
    components.push(new ActionRowBuilder().addComponents(menu));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:qpage:${safePage - 1}`).setLabel('Prev Page').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`music:qpage:${safePage + 1}`).setLabel('Next Page').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1),
    new ButtonBuilder().setCustomId(`music:qdedupe:${safePage}`).setLabel('Dedupe').setEmoji('🧽').setStyle(ButtonStyle.Secondary).setDisabled(total < 2),
    new ButtonBuilder().setCustomId(`music:qrefresh:${safePage}`).setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:qback').setLabel('Player').setEmoji('🎵').setStyle(ButtonStyle.Secondary),
  ));

  if (selected) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`music:qremove:${selectedIndex}:${safePage}:${queueFingerprint(selected)}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`music:qnext:${selectedIndex}:${safePage}:${queueFingerprint(selected)}`).setLabel('Move Next').setEmoji('⬆️').setStyle(ButtonStyle.Secondary).setDisabled(selectedIndex === 0),
      new ButtonBuilder().setCustomId(`music:qplay:${selectedIndex}:${safePage}:${queueFingerprint(selected)}`).setLabel('Play Now').setEmoji('▶️').setStyle(ButtonStyle.Primary),
    ));
  }
  if (canUndo) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:undo').setLabel('Undo Last Queue Change').setEmoji('↩️').setStyle(ButtonStyle.Primary),
    ));
  }

  return { content: lines.join('\n'), embeds: [], components };
}

export function undoButtonComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:undo').setLabel('Undo Last Queue Change').setEmoji('↩️').setStyle(ButtonStyle.Primary),
  )];
}

export function playbackToolsPayload(player, autoplayMode = 'off', notice = null) {
  const track = player?.queue?.current;
  if (!track) return { content: 'Nothing is playing.', embeds: [], components: statusButtons() };
  const seekable = track?.isSeekable !== false && !track?.isStream;
  const rawPosition = Number(player?.position || 0);
  const position = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0;
  const length = Math.max(0, Number(track?.length || 0));

  return {
    content: notice ? safeText(notice, 600) : '**⚙️ Playback Tools** • progress is a snapshot; press Refresh to update it.',
    embeds: [nowPlayingEmbed(track, player, autoplayMode)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music:seekdelta:-30000').setLabel('-30s').setEmoji('⏪').setStyle(ButtonStyle.Secondary).setDisabled(!seekable || position <= 0),
        new ButtonBuilder().setCustomId('music:seekdelta:-10000').setLabel('-10s').setEmoji('↩️').setStyle(ButtonStyle.Secondary).setDisabled(!seekable || position <= 0),
        new ButtonBuilder().setCustomId('music:replay').setLabel('Replay').setEmoji('🔁').setStyle(ButtonStyle.Primary).setDisabled(!seekable),
        new ButtonBuilder().setCustomId('music:seekdelta:10000').setLabel('+10s').setEmoji('↪️').setStyle(ButtonStyle.Secondary).setDisabled(!seekable || (length > 0 && position >= length)),
        new ButtonBuilder().setCustomId('music:seekdelta:30000').setLabel('+30s').setEmoji('⏩').setStyle(ButtonStyle.Secondary).setDisabled(!seekable || (length > 0 && position >= length)),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music:seekmodal').setLabel('Seek…').setEmoji('🎯').setStyle(ButtonStyle.Secondary).setDisabled(!seekable),
        new ButtonBuilder().setCustomId('music:history').setLabel('History').setEmoji('🕘').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:favorites').setLabel('Favorites').setEmoji('❤️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:more_refresh').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:back').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export function seekModal() {
  const input = new TextInputBuilder()
    .setCustomId('position')
    .setLabel('Position (seconds, M:SS, or H:MM:SS)')
    .setPlaceholder('Example: 1:37')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(12);

  return new ModalBuilder()
    .setCustomId('music:seeksubmit')
    .setTitle('Seek in current song')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

export function searchPickerPayload(token, tracks, mode = 'play') {
  const choices = (tracks || []).slice(0, 5);
  const label = mode === 'next' ? 'Play Next' : 'Play';
  if (!choices.length) return { content: 'No selectable results found.', embeds: [], components: [] };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`music:spick:${token}`)
    .setPlaceholder(`${label}: choose the exact result`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(choices.map((track, index) => ({
      label: truncate(`${index + 1}. ${String(track?.title || 'Unknown title')}`, 100),
      description: truncate(`${String(track?.author || 'Unknown')} • ${formatDuration(track?.length || 0)}`, 100),
      value: String(index),
    })));
  return {
    content: `**🔎 Choose a result** • ${label}\nThis picker expires in 2 minutes.`,
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`music:spcancel:${token}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

function libraryPayload(kind, rows, total, page = 0, selectedId = null, notice = null) {
  const safePage = clampPage(total, page, LIBRARY_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / LIBRARY_PAGE_SIZE));
  const selected = rows.find((row) => Number(row.id) === Number(selectedId));
  const isFavorite = kind === 'favorites';
  const prefix = isFavorite ? 'f' : 'h';
  const title = isFavorite ? '❤️ Your Favorites' : '🕘 Recent Server History';
  const lines = [`**${title}**`, `Items: **${total}** • Page **${safePage + 1}/${pages}**`];
  if (selected) lines.push(`Selected: **${safeText(selected.title, 70)}** — ${safeText(selected.author, 35)}`);
  if (notice) lines.push('', safeText(notice, 600));
  if (!rows.length) lines.push('', isFavorite ? 'No favorites saved yet.' : 'No recent listening history yet.');

  const components = [];
  if (rows.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`music:${prefix}select:${safePage}`)
        .setPlaceholder(isFavorite ? 'Choose a favorite' : 'Choose a recent track')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(rows.map((row) => ({
          label: truncate(String(row.title || 'Unknown title'), 100),
          description: truncate(`${String(row.author || 'Unknown')} • ${formatDuration(row.duration_ms || row.length || 0)}`, 100),
          value: String(row.id),
        }))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:${prefix}page:${safePage - 1}`).setLabel('Prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`music:${prefix}page:${safePage + 1}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1),
    new ButtonBuilder().setCustomId(`music:${prefix}refresh:${safePage}`).setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:libraryback').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
  ));
  if (selected) {
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`music:${prefix}play:${selected.id}:${safePage}${isFavorite ? `:${queueFingerprint(selected)}` : ''}`).setLabel('Play').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`music:${prefix}next:${selected.id}:${safePage}${isFavorite ? `:${queueFingerprint(selected)}` : ''}`).setLabel('Play Next').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
    );
    if (isFavorite) actionRow.addComponents(new ButtonBuilder().setCustomId(`music:fremove:${selected.id}:${safePage}:${queueFingerprint(selected)}`).setLabel('Remove Favorite').setEmoji('💔').setStyle(ButtonStyle.Danger));
    else actionRow.addComponents(new ButtonBuilder().setCustomId(`music:hfavorite:${selected.id}:${safePage}`).setLabel('Favorite').setEmoji('❤️').setStyle(ButtonStyle.Secondary));
    components.push(actionRow);
  }
  return { content: lines.join('\n'), embeds: [], components };
}

export function historyPayload(rows, total, page = 0, selectedId = null, notice = null) {
  return libraryPayload('history', rows, total, page, selectedId, notice);
}

export function favoritesPayload(rows, total, page = 0, selectedId = null, notice = null) {
  return libraryPayload('favorites', rows, total, page, selectedId, notice);
}

export function statusButtons({ hasRecovery = false } = {}) {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:history').setLabel('Recent History').setEmoji('🕘').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:favorites').setLabel('Favorites').setEmoji('❤️').setStyle(ButtonStyle.Secondary),
  )];
  if (hasRecovery) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:recovery_resume').setLabel('Resume Session').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music:recovery_discard').setLabel('Discard Session').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

export function queueText(player, max = 20, maxChars = 1850) {
  const current = player?.queue?.current;
  const totalUpcoming = Number(player?.queue?.length || 0);
  const upcoming = [...(player?.queue || [])].slice(0, max);
  const lines = [];
  if (current) lines.push(`**Now:** ${safeText(current.title, 70)} — ${safeText(current.author, 35)}`);
  lines.push(totalUpcoming > 0 ? `**Up next (${totalUpcoming}):**` : '**Up next:** Nothing queued.');

  let shown = 0;
  for (let index = 0; index < upcoming.length; index += 1) {
    const track = upcoming[index];
    const line = `${index + 1}. **${safeText(track.title, 58)}** — ${safeText(track.author, 30)} (${formatDuration(track.length || 0)})`;
    const candidate = [...lines, line].join('\n');
    if (candidate.length > maxChars - 80) break;
    lines.push(line);
    shown += 1;
  }

  const hidden = Math.max(0, totalUpcoming - shown);
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  return truncate(lines.join('\n'), maxChars);
}
