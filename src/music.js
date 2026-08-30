import { MessageFlags } from 'discord.js';
import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import { addHistory, getAutoplayMode, recentHistory, setAutoplayMode } from './storage.js';
import { nowPlayingEmbed, playerButtons } from './ui.js';
import { truncate } from './utils.js';

function youtubeId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

function keyOf(track) {
  return `${String(track?.author || '').toLowerCase()}\u0000${String(track?.title || '').toLowerCase()}`;
}

export function createMusic(client, config, gemini) {
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
  const panelMessages = new Map();
  const lastTracks = new Map();
  const autoplayLocks = new Set();
  const voiceIds = new Map();

  music.shoukaku.on('ready', (name, resumed) => console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`));
  music.shoukaku.on('error', (name, error) => console.error(`[lavalink] ${name}`, error));
  music.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`));

  music.on('playerStart', async (player, track) => {
    clearDisconnect(player.guildId);
    lastTracks.set(player.guildId, track);
    if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    addHistory(player.guildId, track?.requester?.id || 'unknown', track);
    await setVoiceStatus(player, track);
    await refreshPanel(player, { createIfMissing: true });
  });

  music.on('queueUpdate', (player) => refreshPanel(player).catch(() => {}));

  music.on('playerEmpty', async (player) => {
    const filled = await refillAutoplay(player).catch((error) => {
      console.warn('[autoplay]', error?.message || error);
      return false;
    });
    if (!filled) {
      await clearVoiceStatus(player);
      await removePanel(player.guildId);
      scheduleDisconnect(player);
    }
  });

  music.on('playerDestroy', async (player) => {
    clearDisconnect(player.guildId);
    await clearVoiceStatus(player);
    await removePanel(player.guildId);
    voiceIds.delete(player.guildId);
  });

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
      if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
      scheduleDisconnect(player);
    } else {
      if (player.voiceId && player.voiceId !== voice.id) throw new Error('Join the same voice channel as the bot first.');
      player.setTextChannel(interaction.channelId);
    }
    return player;
  }

  async function setVoiceStatus(player, track) {
    const voiceId = player?.voiceId || voiceIds.get(player?.guildId);
    if (!voiceId || !track) return;
    voiceIds.set(player.guildId, voiceId);
    const status = truncate(`Playing: ${track.title || 'Unknown'} • ${track.author || 'Unknown'}`, 500);
    await client.rest.put(`/channels/${voiceId}/voice-status`, { body: { status } }).catch((error) => {
      console.warn('[voice-status] unable to set status; grant Set Voice Channel Status permission', error?.message || error);
    });
  }

  async function clearVoiceStatus(player) {
    const voiceId = player?.voiceId || voiceIds.get(player?.guildId);
    if (!voiceId) return;
    await client.rest.put(`/channels/${voiceId}/voice-status`, { body: { status: null } }).catch(() => {});
  }

  async function refreshPanel(player, { createIfMissing = false, forceNew = false } = {}) {
    const track = player?.queue?.current;
    if (!track) return null;
    const autoplayMode = getAutoplayMode(player.guildId);
    const payload = { embeds: [nowPlayingEmbed(track, player, autoplayMode)], components: playerButtons(player, autoplayMode) };
    const existing = panelMessages.get(player.guildId);

    if (!forceNew && existing) {
      const edited = await existing.edit(payload).catch(() => null);
      if (edited) return edited;
      panelMessages.delete(player.guildId);
    }

    if (!createIfMissing && !forceNew) return null;
    const channel = player.textId ? client.channels.cache.get(player.textId) : null;
    if (!channel?.isTextBased()) return null;
    const sent = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications }).catch(() => null);
    if (sent) panelMessages.set(player.guildId, sent);
    return sent;
  }

  async function showPanel(player) {
    await removePanel(player.guildId);
    return refreshPanel(player, { createIfMissing: true, forceNew: true });
  }

  async function removePanel(guildId) {
    const message = panelMessages.get(guildId);
    panelMessages.delete(guildId);
    if (message) await message.delete().catch(() => {});
  }

  async function standardRecommendations(player, seedTrack, limit = 5) {
    if (!seedTrack) return [];
    const recent = new Set(recentHistory(player.guildId, 30).map((row) => `${String(row.author).toLowerCase()}\u0000${String(row.title).toLowerCase()}`));
    const seedKey = keyOf(seedTrack);
    const usable = (tracks) => (tracks || []).filter((track) => keyOf(track) !== seedKey && !recent.has(keyOf(track))).slice(0, limit);

    const id = youtubeId(seedTrack);
    if (id) {
      try {
        const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
        const result = await player.search(mixUrl, { requester: seedTrack?.requester || client.user });
        const tracks = usable(result?.tracks);
        if (tracks.length) return tracks;
      } catch { /* YouTube mixes occasionally fail; use search fallback */ }
    }

    const fallback = await player.search(`${seedTrack.author || ''} songs`, { requester: seedTrack?.requester || client.user }).catch(() => null);
    return usable(fallback?.tracks);
  }

  async function aiRecommendations(player, limit = 5) {
    if (!gemini?.enabled) return [];
    const recent = recentHistory(player.guildId, 20);
    const plan = await gemini.makeQueue('Continue this listening session naturally. Recommend songs that fit what this server has been playing. Avoid repeats.', { recent, maxSongs: limit });
    const added = [];
    const seen = new Set(recent.map((row) => `${String(row.author).toLowerCase()}\u0000${String(row.title).toLowerCase()}`));
    for (const query of plan.queries.slice(0, limit)) {
      try {
        const result = await player.search(query, { requester: client.user });
        const track = result?.tracks?.find((candidate) => !seen.has(keyOf(candidate)));
        if (track) { seen.add(keyOf(track)); added.push(track); }
      } catch { /* one source miss should not stop autoplay */ }
    }
    return added;
  }

  async function refillAutoplay(player) {
    const mode = getAutoplayMode(player.guildId);
    if (mode === 'off' || autoplayLocks.has(player.guildId)) return false;
    autoplayLocks.add(player.guildId);
    try {
      const seed = lastTracks.get(player.guildId);
      const tracks = mode === 'ai'
        ? await aiRecommendations(player, 5)
        : await standardRecommendations(player, seed, 5);
      if (!tracks.length) return false;
      player.queue.add(tracks);
      if (!player.playing && !player.paused) await player.play();
      return true;
    } finally {
      autoplayLocks.delete(player.guildId);
    }
  }

  async function startServerRadio(player, requester) {
    const history = recentHistory(player.guildId, 100);
    if (!history.length) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');

    const seen = new Set(history.slice(0, 15).map((row) => `${String(row.author).toLowerCase()}\u0000${String(row.title).toLowerCase()}`));
    const picked = [];
    const seeds = history.filter((row, index, rows) => rows.findIndex((other) => other.uri === row.uri) === index).slice(0, 8);

    for (const seed of seeds) {
      if (picked.length >= 15) break;
      const id = youtubeId({ uri: seed.uri });
      if (!id) continue;
      try {
        const result = await player.search(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, { requester });
        for (const track of result?.tracks || []) {
          const key = keyOf(track);
          if (seen.has(key)) continue;
          seen.add(key);
          picked.push(track);
          if (picked.length >= 15) break;
        }
      } catch { /* try another seed */ }
    }

    if (picked.length < 5 && gemini?.enabled) {
      try {
        const extra = await gemini.makeQueue('Build a server radio from this listening history. Pick varied songs that fit the established taste and avoid exact repeats.', { recent: history.slice(0, 25), maxSongs: 10 });
        for (const query of extra.queries) {
          if (picked.length >= 15) break;
          const result = await player.search(query, { requester }).catch(() => null);
          const track = result?.tracks?.find((candidate) => !seen.has(keyOf(candidate)));
          if (track) { seen.add(keyOf(track)); picked.push(track); }
        }
      } catch { /* history replay fallback below */ }
    }

    if (!picked.length) {
      for (const row of seeds.slice(0, 10)) {
        const result = await player.search(row.uri || `${row.author} ${row.title}`, { requester }).catch(() => null);
        if (result?.tracks?.[0]) picked.push(result.tracks[0]);
      }
    }

    if (!picked.length) throw new Error('Could not build server radio from the available sources.');
    player.queue.add(picked);
    if (!player.playing && !player.paused) await player.play();
    return picked.length;
  }

  function setGuildAutoplay(guildId, mode) {
    if (mode === 'ai' && !gemini?.enabled) throw new Error('Gemini is not configured, so AI autoplay cannot be enabled.');
    setAutoplayMode(guildId, mode);
    const player = music.players.get(guildId);
    if (player) refreshPanel(player).catch(() => {});
    return mode;
  }

  return {
    music,
    ensurePlayer,
    showPanel,
    refreshPanel,
    startServerRadio,
    setGuildAutoplay,
    getGuildAutoplay: getAutoplayMode,
  };
}
