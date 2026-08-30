import { REST, Routes, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { recentHistory } from './storage.js';
import { queueText } from './ui.js';
import { trackKey, truncate } from './utils.js';

export const commandDefinitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('previous').setDescription('Replay the previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set normal playback volume').addIntegerOption(o => o.setName('percent').setDescription('0-100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show/recreate the player panel'),
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
    'The player panel also has Previous, Loop, Pause/Resume, Shuffle, Skip, Queue, Clear, Stop, Autoplay and Volume controls.',
    'Playback is raw: no filters, EQ, nightcore, karaoke, 8D, pitch/speed or other DSP effects.',
  ].join('\n');
}

export function createInteractionHandler({ client, music, ensurePlayer, gemini, showPanel, refreshPanel, startServerRadio, setGuildAutoplay, getGuildAutoplay }) {
  return async function handle(interaction) {
    try {
      if (interaction.isButton()) return await handleButton(interaction, { music, gemini, refreshPanel, setGuildAutoplay, getGuildAutoplay });
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'help') return interaction.reply({ ephemeral: true, content: helpText() });
      if (name === 'ping') return interaction.reply({ ephemeral: true, content: `🏓 Discord gateway: **${Math.max(0, Math.round(client.ws.ping))} ms**` });
      if (name === 'status') {
        const player = music.players.get(interaction.guildId);
        const mode = getGuildAutoplay(interaction.guildId);
        let lavalink = 'Unavailable';
        try { await music.getLeastUsedNode(); lavalink = 'Connected'; } catch { /* no online node */ }
        const lines = [
          `Discord: **Online** (${Math.max(0, Math.round(client.ws.ping))} ms)`,
          `Lavalink: **${lavalink}**`,
          `Gemini: **${gemini.enabled ? `Configured (${gemini.model})` : 'Not configured'}**`,
          `Autoplay: **${mode === 'ai' ? 'AI' : mode === 'standard' ? 'On' : 'Off'}**`,
          `Player: **${player ? (player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,
        ];
        if (player) lines.push(`Queue: **${player.queue.length}** | Volume: **${Math.round(player.volume)}%** | Loop: **${player.loop || 'none'}**`);
        return interaction.reply({ ephemeral: true, content: lines.join('\n') });
      }

      if (name === 'play' || name === 'playnext') {
        await interaction.deferReply();
        const player = await ensurePlayer(interaction);
        const { tracks, result } = await searchAndQueue(player, interaction.options.getString('query', true), interaction.user, name === 'playnext');
        await refreshPanel(player).catch(() => {});
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
          return interaction.reply(`🤖 AI autoplay: **${autoplay.toUpperCase()}**.`);
        }
        await interaction.deferReply();
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
        await refreshPanel(player).catch(() => {});
        return interaction.editReply(`🤖 **${truncate(escapeMarkdown(plan.summary), 600)}**\nQueued ${added.length} song${added.length === 1 ? '' : 's'}.`);
      }

      if (name === 'autoplay') {
        requireVoiceForSetting(interaction, music);
        const enabled = interaction.options.getString('mode', true) === 'on';
        setGuildAutoplay(interaction.guildId, enabled ? 'standard' : 'off');
        return interaction.reply(`Autoplay: **${enabled ? 'ON' : 'OFF'}**.`);
      }

      if (name === 'radio') {
        if (!recentHistory(interaction.guildId, 1).length) throw new Error('Server radio needs some listening history first. Play a few songs, then try again.');
        await interaction.deferReply();
        const player = await ensurePlayer(interaction);
        const count = await startServerRadio(player, interaction.user);
        await refreshPanel(player).catch(() => {});
        return interaction.editReply(`📻 Server radio queued **${count} tracks** based on this server's listening history.`);
      }

      const player = getPlayer(music, interaction.guildId);
      if (name === 'nowplaying') {
        requireSameVoice(interaction, player);
        requireCurrentTrack(player);
        await interaction.deferReply({ ephemeral: true });
        player.setTextChannel(interaction.channelId);
        const message = await showPanel(player);
        if (!message) throw new Error('Could not create the player panel in this channel.');
        return interaction.editReply('Player panel recreated.');
      }
      requireSameVoice(interaction, player);

      if (name === 'pause') { requireCurrentTrack(player); player.pause(true); await refreshPanel(player); return interaction.reply('Paused.'); }
      if (name === 'resume') { requireCurrentTrack(player); player.pause(false); await refreshPanel(player); return interaction.reply('Resumed.'); }
      if (name === 'skip') { skipCurrent(player); return interaction.reply('Skipped.'); }
      if (name === 'previous') {
        const prev = player.getPrevious(false);
        if (!prev) throw new Error('No previous song is available.');
        await player.play(prev);
        player.getPrevious(true);
        return interaction.reply(`Playing previous: **${safeTitle(prev)}**.`);
      }
      if (name === 'stop') {
        player.queue.clear();
        player.setLoop('none');
        setGuildAutoplay(interaction.guildId, 'off');
        if (player.queue.current) player.skip();
        return interaction.reply('Stopped and cleared the queue.');
      }
      if (name === 'disconnect') {
        await interaction.deferReply();
        await player.destroy();
        return interaction.editReply('Disconnected.');
      }
      if (name === 'volume') {
        const n = interaction.options.getInteger('percent', true);
        await player.setVolume(n);
        await refreshPanel(player);
        return interaction.reply(`Volume: **${n}%**.`);
      }
      if (name === 'clear') { player.queue.clear(); await refreshPanel(player); return interaction.reply('Upcoming queue cleared.'); }
      if (name === 'shuffle') { player.queue.shuffle(); await refreshPanel(player); return interaction.reply('Queue shuffled.'); }
      if (name === 'loop') {
        const mode = interaction.options.getString('mode', true);
        player.setLoop(mode);
        await refreshPanel(player);
        return interaction.reply(`Loop: **${mode === 'none' ? 'off' : mode}**.`);
      }
    } catch (error) {
      console.error('[interaction]', error);
      const message = `⚠️ ${truncate(error?.message || 'Something went wrong.', 1800)}`;
      if (interaction.isButton()) {
        if (interaction.deferred || interaction.replied) return interaction.followUp({ ephemeral: true, content: message }).catch(() => {});
        return interaction.reply({ ephemeral: true, content: message }).catch(() => {});
      }
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
      return interaction.reply({ ephemeral: true, content: message }).catch(() => {});
    }
  };
}

async function handleButton(interaction, { music, gemini, refreshPanel, setGuildAutoplay, getGuildAutoplay }) {
  const player = getPlayer(music, interaction.guildId);
  const action = interaction.customId.split(':')[1];

  if (action === 'queue') return interaction.reply({ ephemeral: true, content: queueText(player) });
  requireSameVoice(interaction, player);

  if (action === 'previous' && !player.getPrevious(false)) throw new Error('No previous song is available.');

  await interaction.deferUpdate();

  if (action === 'pause') { requireCurrentTrack(player); player.pause(true); }
  else if (action === 'resume') { requireCurrentTrack(player); player.pause(false); }
  else if (action === 'skip') { skipCurrent(player); return; }
  else if (action === 'previous') {
    const previous = player.getPrevious(false);
    if (!previous) throw new Error('No previous song is available.');
    await player.play(previous);
    player.getPrevious(true);
    return;
  }
  else if (action === 'shuffle') player.queue.shuffle();
  else if (action === 'clear') player.queue.clear();
  else if (action === 'stop') {
    player.queue.clear();
    player.setLoop('none');
    setGuildAutoplay(interaction.guildId, 'off');
    if (player.queue.current) player.skip();
    else await refreshPanel(player).catch(() => {});
    return;
  } else if (action === 'loop') {
    const next = player.loop === 'none' ? 'track' : player.loop === 'track' ? 'queue' : 'none';
    player.setLoop(next);
  } else if (action === 'autoplay') {
    const current = getGuildAutoplay(interaction.guildId);
    const next = current === 'off' ? 'standard' : current === 'standard' && gemini.enabled ? 'ai' : 'off';
    setGuildAutoplay(interaction.guildId, next);
  } else if (action === 'volume_down') {
    await player.setVolume(Math.max(0, player.volume - 10));
  } else if (action === 'volume_up') {
    await player.setVolume(Math.min(100, player.volume + 10));
  } else {
    throw new Error('Unknown player control. Recreate the panel with `/nowplaying`.');
  }

  await refreshPanel(player).catch(() => {});
}
