import { MessageFlags, REST, Routes, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { recentHistory } from './storage.js';
import { nowPlayingEmbed, playerButtons, queueText } from './ui.js';
import { trackKey, truncate } from './utils.js';

const PRIVATE_FLAGS = MessageFlags.Ephemeral;

export const commandDefinitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('previous').setDescription('Replay the previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set persistent playback volume').addIntegerOption(o => o.setName('percent').setDescription('0-100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show your private player panel'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear all upcoming songs'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle upcoming songs'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices({name:'Off',value:'none'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
  new SlashCommandBuilder().setName('autoplay').setDescription('Turn source-based autoplay on or off').addStringOption(o => o.setName('mode').setDescription('Autoplay').setRequired(true).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})),
  new SlashCommandBuilder().setName('radio').setDescription('Radio controls').addSubcommand(s => s.setName('server').setDescription('Build radio from this server\'s listening history')),
  new SlashCommandBuilder().setName('ai').setDescription('Gemini AI DJ')
    .addStringOption(o => o.setName('request').setDescription('Natural-language music request').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('autoplay').setDescription('AI autoplay').setRequired(false).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})),
  new SlashCommandBuilder().setName('help').setDescription('Show commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Show Discord latency'),
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

function playerPanelPayload(player, autoplayMode) {
  const track = player?.queue?.current;
  if (!track) return { content: 'Nothing is playing.', embeds: [], components: [] };
  return {
    content: null,
    embeds: [nowPlayingEmbed(track, player, autoplayMode)],
    components: playerButtons(player, autoplayMode),
  };
}

function getPlayer(music, guildId) {
  const player = music.players.get(guildId);
  if (!player) throw new Error('Nothing is playing.');
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

function skipCurrent(player) {
  requireCurrentTrack(player);
  // Kazagumo requeues the current track when track-loop is active, so /skip
  // must disable that mode first or the same song immediately starts again.
  if (player.loop === 'track') player.setLoop('none');
  player.skip();
}

async function searchTracks(player, query, requester) {
  const result = await player.search(query, { requester });
  if (!result?.tracks?.length) throw new Error(`No results for: ${truncate(query, 120)}`);
  return { result, tracks: result.type === 'PLAYLIST' ? [...result.tracks] : [result.tracks[0]] };
}

async function searchAndQueue(player, query, requester, next = false) {
  const { tracks, result } = await searchTracks(player, query, requester);
  if (next) player.queue.unshift(...tracks);
  else player.queue.add([...tracks]);
  if (!player.playing && !player.paused) await player.play();
  return { tracks, result };
}

async function resolveSearchQueries(player, queries, requester, seen = new Set(), limit = 10, concurrency = 3) {
  const added = [];
  const cleanQueries = (queries || []).filter(Boolean);
  const width = Math.max(1, Math.min(5, concurrency));

  for (let offset = 0; offset < cleanQueries.length && added.length < limit; offset += width) {
    const batch = cleanQueries.slice(offset, offset + width);
    const results = await Promise.all(batch.map((query) => player.search(query, { requester }).catch(() => null)));
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

function helpText() {
  return [
    '**EZ Music commands**',
    '`/play` `/playnext` `/pause` `/resume` `/skip` `/previous` `/stop` `/disconnect`',
    '`/volume` `/nowplaying` `/clear` `/shuffle` `/loop`',
    '`/autoplay on|off` `/radio server`',
    '`/ai request:<text>` `/ai autoplay:on|off`',
    '`/help` `/ping` `/status`',
    '',
    'All command replies and the `/nowplaying` control panel are private to the person who invoked them, so the music text channel stays empty.',
    'Volume is saved for the server and remains in effect across disconnects and bot restarts until changed again.',
    'The private player panel has Previous, Loop, Pause/Resume, Shuffle, Skip, Queue, Clear, Stop, Autoplay and Volume controls.',
    'Playback is raw: no filters, EQ, nightcore, karaoke, 8D, pitch/speed or other DSP effects.',
  ].join('\n');
}

export function createInteractionHandler({ client, music, ensurePlayer, gemini, startServerRadio, setGuildAutoplay, getGuildAutoplay, getGuildVolume, setGuildVolume }) {
  return async function handle(interaction) {
    try {
      if (interaction.isButton()) return await handleButton(interaction, { music, gemini, setGuildAutoplay, getGuildAutoplay, setGuildVolume });
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'help') return privateReply(interaction, helpText());
      if (name === 'ping') return privateReply(interaction, `🏓 Discord gateway: **${Math.max(0, Math.round(client.ws.ping))} ms**`);
      if (name === 'status') {
        const player = music.players.get(interaction.guildId);
        const mode = getGuildAutoplay(interaction.guildId);
        const volume = getGuildVolume(interaction.guildId);
        let lavalink = 'Unavailable';
        try { await music.getLeastUsedNode(); lavalink = 'Connected'; } catch { /* no online node */ }
        const lines = [
          `Discord: **Online** (${Math.max(0, Math.round(client.ws.ping))} ms)`,
          `Lavalink: **${lavalink}**`,
          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,
          `Autoplay: **${mode === 'ai' ? 'AI' : mode === 'standard' ? 'On' : 'Off'}**`,
          `Volume: **${volume}%**`,
          `Player: **${player ? (player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,
        ];
        if (player) lines.push(`Queue: **${player.queue.length}** | Loop: **${player.loop || 'none'}**`);
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
        const { tracks, result } = await searchAndQueue(player, interaction.options.getString('query', true), interaction.user, name === 'playnext');
        const where = name === 'playnext' ? 'Queued next' : 'Queued';
        return interaction.editReply(result.type === 'PLAYLIST' ? `${where} **${tracks.length} tracks**.` : `${where} **${safeTitle(tracks[0])}**.`);
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
        const recent = recentHistory(interaction.guildId, 20);
        const plan = await gemini.makeQueue(request, { recent, maxSongs: 10 });
        const player = await ensurePlayer(interaction);
        const seen = new Set(recent.map((row) => trackKey(row)).filter(Boolean));
        if (player.queue.current) {
          const key = trackKey(player.queue.current);
          if (key) seen.add(key);
        }
        for (const track of player.queue) {
          const key = trackKey(track);
          if (key) seen.add(key);
        }
        const added = await resolveSearchQueries(player, plan.queries, interaction.user, seen, 10, 3);
        if (!added.length) throw new Error('Gemini suggested songs, but none could be resolved by the music source.');
        player.queue.add([...added]);
        if (!player.playing && !player.paused) await player.play();
        return interaction.editReply(`🤖 **${truncate(escapeMarkdown(plan.summary), 600)}**\nQueued ${added.length} song${added.length === 1 ? '' : 's'}.`);
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
        const count = await startServerRadio(player, interaction.user);
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
        await player.play(prev);
        player.getPrevious(true);
        return privateReply(interaction, `Playing previous: **${safeTitle(prev)}**.`);
      }
      if (name === 'stop') {
        player.queue.clear();
        player.setLoop('none');
        setGuildAutoplay(interaction.guildId, 'off');
        if (player.queue.current) player.skip();
        return privateReply(interaction, 'Stopped and cleared the queue.');
      }
      if (name === 'disconnect') {
        await privateDefer(interaction);
        await player.destroy();
        return interaction.editReply('Disconnected.');
      }
      if (name === 'clear') { player.queue.clear(); return privateReply(interaction, 'Upcoming queue cleared.'); }
      if (name === 'shuffle') { player.queue.shuffle(); return privateReply(interaction, 'Queue shuffled.'); }
      if (name === 'loop') {
        const mode = interaction.options.getString('mode', true);
        player.setLoop(mode);
        return privateReply(interaction, `Loop: **${mode === 'none' ? 'off' : mode}**.`);
      }
    } catch (error) {
      console.error('[interaction]', error);
      const message = `⚠️ ${truncate(error?.message || 'Something went wrong.', 1800)}`;
      if (interaction.isButton()) {
        if (interaction.deferred || interaction.replied) return interaction.followUp({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
        return interaction.reply({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
      }
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
      return interaction.reply({ flags: PRIVATE_FLAGS, content: message }).catch(() => {});
    }
  };
}

async function handleButton(interaction, { music, gemini, setGuildAutoplay, getGuildAutoplay, setGuildVolume }) {
  const player = getPlayer(music, interaction.guildId);
  const action = interaction.customId.split(':')[1];

  if (action === 'queue') return privateReply(interaction, queueText(player));
  requireSameVoice(interaction, player);

  if (action === 'previous' && !player.getPrevious(false)) throw new Error('No previous song is available.');

  await interaction.deferUpdate();
  let settle = false;

  if (action === 'pause') { requireCurrentTrack(player); player.pause(true); }
  else if (action === 'resume') { requireCurrentTrack(player); player.pause(false); }
  else if (action === 'skip') { skipCurrent(player); settle = true; }
  else if (action === 'previous') {
    const previous = player.getPrevious(false);
    if (!previous) throw new Error('No previous song is available.');
    await player.play(previous);
    player.getPrevious(true);
    settle = true;
  }
  else if (action === 'shuffle') player.queue.shuffle();
  else if (action === 'clear') player.queue.clear();
  else if (action === 'stop') {
    player.queue.clear();
    player.setLoop('none');
    setGuildAutoplay(interaction.guildId, 'off');
    if (player.queue.current) player.skip();
    return interaction.editReply({ content: 'Stopped and cleared the queue.', embeds: [], components: [] });
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
  return interaction.editReply(playerPanelPayload(player, getGuildAutoplay(interaction.guildId)));
}
