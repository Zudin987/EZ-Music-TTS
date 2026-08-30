import { MessageFlags } from 'discord.js';
import { Kazagumo } from 'kazagumo';
import { Connectors } from 'shoukaku';
import { addHistory, getAutoplayMode, recentHistory, setAutoplayMode } from './storage.js';
import { nowPlayingEmbed, playerButtons } from './ui.js';
import { radioFallbackHistory, trackKey, truncate } from './utils.js';

function youtubeId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
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

  // A persisted AI mode must not survive a restart where Gemini was removed.
  if (!gemini?.enabled && getAutoplayMode(config.discordGuildId) === 'ai') {
    setAutoplayMode(config.discordGuildId, 'off');
  }

  music.shoukaku.on('ready', (name, resumed) => console.log(`[lavalink] ${name} ready${resumed ? ' (resumed)' : ''}`));
  music.shoukaku.on('error', (name, error) => console.error(`[lavalink] ${name}`, error));
  music.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink] ${name} closed ${code}: ${reason || 'no reason'}`));

  music.on('playerStart', (player, track) => {
    void handlePlayerStart(player, track).catch((error) => console.warn('[player-start]', error?.message || error));
  });

  music.on('queueUpdate', (player) => refreshPanel(player).catch(() => {}));

  music.on('playerException', (player, data) => {
    console.warn('[player-exception]', player.guildId, data?.exception?.message || data?.message || 'track exception');
    try {
      if (player.queue.current) {
        if (player.loop !== 'none') player.setLoop('none');
        player.skip();
      }
    } catch (error) { console.warn('[player-exception] skip failed', error?.message || error); }
  });

  music.on('playerStuck', (player, data) => {
    console.warn('[player-stuck]', player.guildId, data?.thresholdMs || 'unknown threshold');
    try {
      if (player.queue.current) {
        if (player.loop !== 'none') player.setLoop('none');
        player.skip();
      }
    } catch (error) { console.warn('[player-stuck] skip failed', error?.message || error); }
  });

  music.on('playerEmpty', (player) => {
    void handlePlayerEmpty(player).catch((error) => console.warn('[player-empty]', error?.message || error));
  });

  music.on('playerDestroy', (player) => {
    void handlePlayerDestroy(player).catch((error) => console.warn('[player-destroy]', error?.message || error));
  });

  async function handlePlayerStart(player, track) {
    clearDisconnect(player.guildId);
    lastTracks.set(player.guildId, track);
    if (player.voiceId) voiceIds.set(player.guildId, player.voiceId);
    try {
      addHistory(player.guildId, track?.requester?.id || 'unknown', track);
    } catch (error) {
      // Local history should never be able to break otherwise healthy playback.
      console.warn('[history] unable to record track', error?.message || error);
    }
    await setVoiceStatus(player, track);
    await refreshPanel(player, { createIfMissing: true });
  }

  async function handlePlayerEmpty(player) {
    const filled = await refillAutoplay(player).catch((error) => {
      console.warn('[autoplay]', error?.message || error);
      return false;
    });
    if (!filled && music.players.get(player.guildId) === player) {
      await clearVoiceStatus(player);
      await removePanel(player.guildId);
      scheduleDisconnect(player);
    }
  }

  async function handlePlayerDestroy(player) {
    clearDisconnect(player.guildId);
    await clearVoiceStatus(player);
    await removePanel(player.guildId);
    voiceIds.delete(player.guildId);
    lastTracks.delete(player.guildId);
    autoplayLocks.delete(player.guildId);
  }

  function clearDisconnect(guildId) {
    const timer = disconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(guildId);
  }

  function scheduleDisconnect(player) {
    clearDisconnect(player.guildId);
    const timer = setTimeout(() => {
      disconnectTimers.delete(player.guildId);
      const completelyIdle = !player.queue.current && player.queue.isEmpty && !player.playing && !player.paused;
      if (completelyIdle && music.players.get(player.guildId) === player) {
        player.destroy().catch((error) => console.warn('[idle-disconnect]', error?.message || error));
      }
    }, config.autoDisconnectMinutes * 60_000);
    timer.unref?.();
    disconnectTimers.set(player.guildId, timer);
  }

  async function ensurePlayer(interaction) {
    const voice = interaction.member?.voice?.channel;
    if (!voice) throw new Error('Join a voice channel first.');

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
    } else {
      if (player.voiceId && player.voiceId !== voice.id) throw new Error('Join the same voice channel as the bot first.');
      player.setTextChannel(interaction.channelId);
    }

    // Keep an idle player on a fresh timeout even if the upcoming search fails.
    // playerStart clears this timer after playback actually begins.
    if (!player.queue.current && !player.playing) scheduleDisconnect(player);
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

  async function resolveQueries(player, queries, requester, seen = new Set(), limit = 5, concurrency = 3) {
    const selected = [];
    const cleanQueries = (queries || []).filter(Boolean);
    const width = Math.max(1, Math.min(5, concurrency));

    for (let offset = 0; offset < cleanQueries.length && selected.length < limit; offset += width) {
      const batch = cleanQueries.slice(offset, offset + width);
      const results = await Promise.all(batch.map((query) => player.search(query, { requester }).catch(() => null)));
      for (const result of results) {
        const track = result?.tracks?.find((candidate) => {
          const key = trackKey(candidate);
          return key && !seen.has(key);
        });
        if (!track) continue;
        const key = trackKey(track);
        seen.add(key);
        selected.push(track);
        if (selected.length >= limit) break;
      }
    }

    return selected;
  }

  async function standardRecommendations(player, seedTrack, limit = 5, requester = seedTrack?.requester || client.user) {
    if (!seedTrack) return [];
    const recent = new Set(recentHistory(player.guildId, 30).map((row) => trackKey(row)).filter(Boolean));
    const seedKey = trackKey(seedTrack);
    const selected = [];
    const selectedKeys = new Set();

    const takeUsable = (tracks) => {
      for (const track of tracks || []) {
        const key = trackKey(track);
        if (!key || key === seedKey || recent.has(key) || selectedKeys.has(key)) continue;
        selectedKeys.add(key);
        selected.push(track);
        if (selected.length >= limit) break;
      }
      return selected;
    };

    const id = youtubeId(seedTrack);
    if (id) {
      try {
        const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
        const result = await player.search(mixUrl, { requester });
        takeUsable(result?.tracks);
        if (selected.length >= limit) return selected;
      } catch { /* YouTube mixes occasionally fail; use search fallback */ }
    }

    const fallbackQuery = `${seedTrack.author || seedTrack.title || ''} songs`.trim();
    if (fallbackQuery) {
      const fallback = await player.search(fallbackQuery, { requester }).catch(() => null);
      takeUsable(fallback?.tracks);
    }
    return selected.slice(0, limit);
  }

  async function aiRecommendations(player, limit = 5) {
    if (!gemini?.enabled) return [];
    const recent = recentHistory(player.guildId, 20);
    const plan = await gemini.makeQueue('Continue this listening session naturally. Recommend songs that fit what this server has been playing. Avoid repeats.', { recent, maxSongs: limit });
    const seen = new Set(recent.map((row) => trackKey(row)).filter(Boolean));
    return resolveQueries(player, plan.queries.slice(0, limit), client.user, seen, limit, 3);
  }

  async function refillAutoplay(player) {
    const mode = getAutoplayMode(player.guildId);
    if (mode === 'off' || autoplayLocks.has(player.guildId)) return false;
    autoplayLocks.add(player.guildId);
    try {
      const seed = lastTracks.get(player.guildId);
      let tracks = [];
      if (mode === 'ai') {
        try {
          tracks = await aiRecommendations(player, 5);
        } catch (error) {
          console.warn('[autoplay] AI continuation unavailable; falling back to standard recommendations:', error?.message || error);
        }
        if (!tracks.length) tracks = await standardRecommendations(player, seed, 5);
      } else {
        tracks = await standardRecommendations(player, seed, 5);
      }

      // The user may have disabled/switched autoplay, or destroyed the player,
      // while network/AI searches were still in flight. Never enqueue stale work.
      if (getAutoplayMode(player.guildId) !== mode || music.players.get(player.guildId) !== player) return false;
      if (!tracks.length) return false;
      player.queue.add([...tracks]);
      if (!player.playing && !player.paused) await player.play();
      return true;
    } finally {
      autoplayLocks.delete(player.guildId);
    }
  }

  async function startServerRadio(player, requester) {
    const history = recentHistory(player.guildId, 100);
    if (!history.length) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');

    const seen = new Set(history.slice(0, 15).map((row) => trackKey(row)).filter(Boolean));
    const picked = [];
    const uniqueSeedKeys = new Set();
    const seeds = [];
    for (const row of history) {
      const key = row.uri || trackKey(row);
      if (!key || uniqueSeedKeys.has(key)) continue;
      uniqueSeedKeys.add(key);
      seeds.push(row);
      if (seeds.length >= 8) break;
    }

    // Resolve a few recommendation seeds in parallel so /radio does not make
    // every network lookup wait for the previous one to finish.
    for (let offset = 0; offset < seeds.length && picked.length < 15; offset += 3) {
      const batch = seeds.slice(offset, offset + 3);
      const recommendationSets = await Promise.all(batch.map((seed) => standardRecommendations(player, seed, 5, requester).catch(() => [])));
      for (const recommendations of recommendationSets) {
        for (const track of recommendations) {
          const key = trackKey(track);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          picked.push(track);
          if (picked.length >= 15) break;
        }
        if (picked.length >= 15) break;
      }
    }

    if (picked.length < 5 && gemini?.enabled) {
      try {
        const extra = await gemini.makeQueue('Build a server radio from this listening history. Pick varied songs that fit the established taste and avoid exact repeats.', { recent: history.slice(0, 25), maxSongs: 10 });
        const resolved = await resolveQueries(player, extra.queries, requester, seen, 15 - picked.length, 3);
        picked.push(...resolved);
      } catch (error) {
        console.warn('[radio] Gemini enhancement unavailable:', error?.message || error);
      }
    }

    // Last-resort fallback: prefer older history. If the server is brand-new and
    // has fewer than 16 history entries, replaying a recent known-good track is
    // better than claiming radio cannot be built at all.
    if (!picked.length) {
      const fallbackRows = radioFallbackHistory(history, 15, 10);
      const fallbackQueries = fallbackRows.map((row) => row.uri || `${row.author || ''} ${row.title || ''}`.trim()).filter(Boolean);
      const fallbackSeen = new Set();
      const resolved = await resolveQueries(player, fallbackQueries, requester, fallbackSeen, 10, 3);
      picked.push(...resolved);
    }

    if (!picked.length) throw new Error('Could not build server radio from the available sources.');
    const count = picked.length;
    player.queue.add([...picked]);
    if (!player.playing && !player.paused) await player.play();
    return count;
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
