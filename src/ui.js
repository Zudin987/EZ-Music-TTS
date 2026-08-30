import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatDuration, truncate } from './utils.js';

export function playerButtons(paused = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:previous').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(paused ? 'music:resume' : 'music:pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:favorite').setEmoji('❤️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
  )];
}

export function nowPlayingEmbed(track, player) {
  const requester = track?.requester?.displayName || track?.requester?.username || track?.requester?.globalName || 'Unknown';
  const title = truncate(track?.title || 'Unknown title', 240);
  const uri = track?.uri || track?.realUri;
  const embed = new EmbedBuilder()
    .setTitle('Now Playing')
    .setDescription(uri ? `[${title}](${uri})` : title)
    .addFields(
      { name: 'Artist', value: truncate(track?.author || 'Unknown', 100), inline: true },
      { name: 'Length', value: formatDuration(track?.length || 0), inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Requested by', value: truncate(requester, 100), inline: true },
      { name: 'Loop', value: player.loop || 'none', inline: true },
      { name: 'Playback', value: 'Raw / no DSP effects', inline: true },
    );
  if (track?.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}
