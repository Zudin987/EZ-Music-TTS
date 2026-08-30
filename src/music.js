import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import { addHistory } from './storage.js';
import { nowPlayingEmbed, playerButtons } from './ui.js';

export function createMusic(client, config) {
  const nodes = [{
    name: 'local',
    url: config.lavalinkUrl,
    auth: config.lavalinkPassword,
    secure: config.lavalinkSecure,
  }];

  const music = new Kazagumo({
    defaultSearchEngine: 'youtube',
    send: (guildId, payload) => client.guilds.cache.get(guildId)?.shard.send(payload),
  }, new Connectors.DiscordJS(client), nodes, {
    resume: true,
    resumeTimeout: 30,
    reconnectTries: 8,
    restTimeout: 20_000,
  });

  const disconnectTimers = new Map();

  music.shoukaku.on('ready', (name, resumed) => console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`));
  music.shoukaku.on('error', (name, error) => console.error(`[lavalink] ${name}`, error));
  music.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`));

  music.on('playerStart', async (player, track) => {
    const requesterId = track?.requester?.id || 'unknown';
    addHistory(player.guildId, requesterId, track);
    const channel = player.textId ? client.channels.cache.get(player.textId) : null;
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [nowPlayingEmbed(track, player)], components: playerButtons(false) }).catch(() => {});
    }
  });

  music.on('playerEmpty', (player) => {
    scheduleDisconnect(player);
  });

  music.on('playerDestroy', (player) => clearDisconnect(player.guildId));

  function clearDisconnect(guildId) {
    const timer = disconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(guildId);
  }

  function scheduleDisconnect(player) {
    clearDisconnect(player.guildId);
    const timer = setTimeout(() => {
      if (player.queue.isEmpty && !player.playing) player.destroy().catch(() => {});
    }, config.autoDisconnectMinutes * 60_000);
    timer.unref?.();
    disconnectTimers.set(player.guildId, timer);
  }

  async function ensurePlayer(interaction) {
    const voice = interaction.member?.voice?.channel;
    if (!voice) throw new Error('Join a voice channel first.');
    clearDisconnect(interaction.guildId);
    let player = music.players.get(interaction.guildId);
    if (!player) {
      player = await music.createPlayer({
        guildId: interaction.guildId,
        textId: interaction.channelId,
        voiceId: voice.id,
        deaf: true,
        volume: config.defaultVolume,
      });
    } else {
      if (player.voiceId !== voice.id) player.setVoiceChannel(voice.id);
      player.setTextChannel(interaction.channelId);
    }
    return player;
  }

  return { music, ensurePlayer };
}
