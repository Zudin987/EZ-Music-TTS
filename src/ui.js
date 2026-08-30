import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { formatDuration, truncate } from './utils.js';

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

export function playerButtons(player, autoplayMode = 'off') {
  const paused = Boolean(player?.paused);
  const hasCurrent = Boolean(player?.queue?.current);
  const upcoming = Number(player?.queue?.length || 0);
  const hasPrevious = Boolean(player?.getPrevious?.(false));
  const volume = Math.round(Number(player?.volume || 0));
  const clearHasEffect = upcoming > 0 || player?.loop !== 'none' || autoplayMode !== 'off';

  return [
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
      new ButtonBuilder().setCustomId('music:refresh').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    ),
  ];
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
    .setDescription(`**${title}**`)
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
