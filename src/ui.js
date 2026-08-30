import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
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

export function playerButtons(player, autoplayMode = 'off') {
  const paused = Boolean(player?.paused);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:previous').setLabel('Previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:loop').setLabel(`Loop: ${prettyLoop(player?.loop)}`).setEmoji('🔁').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(paused ? 'music:resume' : 'music:pause').setLabel(paused ? 'Resume' : 'Pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music:shuffle').setLabel('Shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:queue').setLabel('Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:clear').setLabel('Clear').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('music:autoplay').setLabel(`Autoplay: ${prettyAutoplay(autoplayMode)}`).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:volume_down').setLabel('Vol -').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:volume_up').setLabel('Vol +').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function nowPlayingEmbed(track, player, autoplayMode = 'off') {
  const requester = track?.requester?.displayName || track?.requester?.globalName || track?.requester?.username || 'Unknown';
  const title = truncate(track?.title || 'Unknown title', 240);
  const uri = track?.uri || track?.realUri;
  const next = player?.queue?.[0];
  const queueCount = Number(player?.queue?.length || 0);
  const queueDuration = Number(player?.queue?.durationLength || 0);

  const embed = new EmbedBuilder()
    .setTitle('🎵 Now Playing')
    .setDescription(uri ? `**[${title}](${uri})**` : `**${title}**`)
    .addFields(
      { name: '🎙️ Artist', value: truncate(track?.author || 'Unknown', 100), inline: true },
      { name: '⏱️ Duration', value: formatDuration(track?.length || 0), inline: true },
      { name: '👤 Requester', value: truncate(requester, 100), inline: true },
    )
    .setFooter({
      text: `Volume: ${Math.round(player?.volume ?? 0)}% | Loop: ${prettyLoop(player?.loop)} | Autoplay: ${prettyAutoplay(autoplayMode)} | Queue: ${queueCount}${queueDuration > 0 ? ` (${formatDuration(queueDuration)})` : ''}`,
    });

  if (next) embed.addFields({ name: '⏭️ Up Next', value: `${truncate(next.title, 90)} • ${formatDuration(next.length || 0)}` });
  if (track?.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function queueText(player, max = 20) {
  const current = player?.queue?.current;
  const upcoming = [...(player?.queue || [])].slice(0, max);
  const lines = [];
  if (current) lines.push(`**Now:** ${truncate(current.title, 80)} — ${truncate(current.author, 45)}`);
  lines.push(...upcoming.map((track, index) => `${index + 1}. **${truncate(track.title, 70)}** — ${truncate(track.author, 40)} (${formatDuration(track.length || 0)})`));
  if ((player?.queue?.length || 0) > max) lines.push(`…and ${player.queue.length - max} more`);
  return lines.join('\n') || 'Queue is empty.';
}
