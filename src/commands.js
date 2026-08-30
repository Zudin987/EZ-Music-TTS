import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { recentHistory } from './storage.js';
import { queueText } from './ui.js';
import { truncate } from './utils.js';

const defs = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
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
  new SlashCommandBuilder().setName('ai').setDescription('Gemini AI DJ').addStringOption(o => o.setName('request').setDescription('Natural-language music request').setRequired(false)).addStringOption(o => o.setName('autoplay').setDescription('AI autoplay').setRequired(false).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})),
  new SlashCommandBuilder().setName('help').setDescription('Show commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Show Discord latency'),
  new SlashCommandBuilder().setName('status').setDescription('Show music bot status'),
].map(x => x.toJSON());

export async function registerGuildCommands(config) {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: defs });
  console.log(`[discord] registered ${defs.length} guild commands`);
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

async function searchTracks(player, query, requester) {
  const result = await player.search(query, { requester });
  if (!result?.tracks?.length) throw new Error(`No results for: ${query}`);
  return { result, tracks: result.type === 'PLAYLIST' ? result.tracks : [result.tracks[0]] };
}

async function searchAndQueue(player, query, requester, next = false) {
  const { tracks, result } = await searchTracks(player, query, requester);
  if (next) player.queue.unshift(...tracks);
  else player.queue.add(tracks);
  if (!player.playing && !player.paused) await player.play();
  return { tracks, result };
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
      if (interaction.isButton()) return handleButton(interaction, { music, gemini, refreshPanel, setGuildAutoplay, getGuildAutoplay });
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'help') return interaction.reply({ ephemeral: true, content: helpText() });
      if (name === 'ping') return interaction.reply({ ephemeral: true, content: `🏓 Discord gateway: **${Math.round(client.ws.ping)} ms**` });
      if (name === 'status') {
        const player = music.players.get(interaction.guildId);
        const mode = getGuildAutoplay(interaction.guildId);
        let lavalink = 'Unavailable';
        try { lavalink = music.getLeastUsedNode() ? 'Connected' : 'Unavailable'; } catch { /* no node */ }
        const lines = [
          `Discord: **Online** (${Math.round(client.ws.ping)} ms)`,
          `Lavalink: **${lavalink}**`,
          `Gemini: **${gemini.enabled ? `Ready (${gemini.model})` : 'Not configured'}**`,
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
        return interaction.editReply(result.type === 'PLAYLIST' ? `${where} **${tracks.length} tracks**.` : `${where} **${truncate(tracks[0].title, 100)}**.`);
      }

      if (name === 'ai') {
        const autoplay = interaction.options.getString('autoplay');
        const request = interaction.options.getString('request');
        if (!autoplay && !request) throw new Error('Use either `request` or `autoplay`.');
        if (autoplay) {
          const mode = autoplay === 'on' ? 'ai' : 'off';
          setGuildAutoplay(interaction.guildId, mode);
          return interaction.reply(`🤖 AI autoplay: **${autoplay.toUpperCase()}**.`);
        }
        await interaction.deferReply();
        const plan = await gemini.makeQueue(request, { recent: recentHistory(interaction.guildId, 20), maxSongs: 10 });
        const player = await ensurePlayer(interaction);
        const added = [];
        for (const query of plan.queries) {
          try {
            const result = await player.search(query, { requester: interaction.user });
            if (result?.tracks?.[0]) { player.queue.add(result.tracks[0]); added.push(result.tracks[0]); }
          } catch { /* one failed search should not cancel the AI queue */ }
        }
        if (!added.length) throw new Error('Gemini suggested songs, but none could be resolved by the music source.');
        if (!player.playing && !player.paused) await player.play();
        await refreshPanel(player).catch(() => {});
        return interaction.editReply(`🤖 **${plan.summary}**\nQueued ${added.length} song${added.length === 1 ? '' : 's'}.`);
      }

      if (name === 'autoplay') {
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
        const message = await showPanel(player);
        if (!message) throw new Error('Could not create the player panel in this channel.');
        return interaction.reply({ ephemeral: true, content: 'Player panel recreated.' });
      }
      requireSameVoice(interaction, player);

      if (name === 'pause') { player.pause(true); await refreshPanel(player); return interaction.reply('Paused.'); }
      if (name === 'resume') { player.pause(false); await refreshPanel(player); return interaction.reply('Resumed.'); }
      if (name === 'skip') { player.skip(); return interaction.reply('Skipped.'); }
      if (name === 'previous') {
        const prev = player.getPrevious(true);
        if (!prev) throw new Error('No previous song is available.');
        await player.play(prev);
        return interaction.reply(`Playing previous: **${truncate(prev.title, 100)}**.`);
      }
      if (name === 'stop') { player.queue.clear(); player.setLoop('none'); setGuildAutoplay(interaction.guildId, 'off'); player.skip(); return interaction.reply('Stopped and cleared the queue.'); }
      if (name === 'disconnect') { await player.destroy(); return interaction.reply('Disconnected.'); }
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
      const message = `⚠️ ${error?.message || 'Something went wrong.'}`;
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
  if (action === 'pause') player.pause(true);
  else if (action === 'resume') player.pause(false);
  else if (action === 'skip') { await interaction.deferUpdate(); player.skip(); return; }
  else if (action === 'previous') {
    const prev = player.getPrevious(true);
    if (!prev) throw new Error('No previous song is available.');
    await interaction.deferUpdate();
    await player.play(prev);
    return;
  } else if (action === 'shuffle') player.queue.shuffle();
  else if (action === 'clear') player.queue.clear();
  else if (action === 'stop') {
    player.queue.clear();
    player.setLoop('none');
    setGuildAutoplay(interaction.guildId, 'off');
    await interaction.deferUpdate();
    player.skip();
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
  }

  await refreshPanel(player).catch(() => {});
  return interaction.deferUpdate();
}
