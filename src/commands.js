import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { addFavorite, listFavorites, recentHistory, removeFavorite } from './storage.js';
import { formatDuration, parseTimeToSeconds, truncate } from './utils.js';
import { nowPlayingEmbed, playerButtons } from './ui.js';

const defs = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('previous').setDescription('Play the previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear the queue'),
  new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect the music bot'),
  new SlashCommandBuilder().setName('now').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (raw playback, no DSP)').addIntegerOption(o => o.setName('percent').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Seek in the current song').addStringOption(o => o.setName('time').setDescription('Seconds, mm:ss, or hh:mm:ss').setRequired(true)),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices({name:'Off',value:'none'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle queued songs'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear upcoming songs'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a queued song').addIntegerOption(o => o.setName('position').setDescription('Queue position, starting at 1').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('favorite').setDescription('Favorite controls')
    .addSubcommand(s => s.setName('add').setDescription('Favorite the current song'))
    .addSubcommand(s => s.setName('list').setDescription('Show your favorites'))
    .addSubcommand(s => s.setName('play').setDescription('Queue one of your favorites').addIntegerOption(o => o.setName('position').setDescription('Favorite list position').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove one of your favorites').addIntegerOption(o => o.setName('position').setDescription('Favorite list position').setMinValue(1).setRequired(true))),
  new SlashCommandBuilder().setName('history').setDescription('Show recently played songs'),
  new SlashCommandBuilder().setName('ai').setDescription('Ask Gemini AI DJ to build a queue').addStringOption(o => o.setName('request').setDescription('e.g. chill anime piano, no fast songs').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('Show bot features'),
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

async function searchAndQueue(player, query, requester) {
  const result = await player.search(query, { requester });
  if (!result?.tracks?.length) throw new Error(`No results for: ${query}`);
  const tracks = result.type === 'PLAYLIST' ? result.tracks : [result.tracks[0]];
  player.queue.add(tracks);
  if (!player.playing && !player.paused) await player.play();
  return { tracks, result };
}

export function createInteractionHandler({ music, ensurePlayer, gemini }) {
  return async function handle(interaction) {
    try {
      if (interaction.isButton()) return handleButton(interaction, music);
      if (!interaction.isChatInputCommand()) return;

      const name = interaction.commandName;
      if (name === 'play') {
        await interaction.deferReply();
        const player = await ensurePlayer(interaction);
        const { tracks, result } = await searchAndQueue(player, interaction.options.getString('query', true), interaction.user);
        return interaction.editReply(result.type === 'PLAYLIST' ? `Queued **${tracks.length} tracks**.` : `Queued **${truncate(tracks[0].title, 100)}**.`);
      }

      if (name === 'ai') {
        await interaction.deferReply();
        const request = interaction.options.getString('request', true);
        const plan = await gemini.makeQueue(request, { recent: recentHistory(interaction.guildId, 12) });
        const player = await ensurePlayer(interaction);
        const added = [];
        for (const query of plan.queries) {
          try {
            const result = await player.search(query, { requester: interaction.user });
            if (result?.tracks?.[0]) { player.queue.add(result.tracks[0]); added.push(result.tracks[0]); }
          } catch { /* one failed search should not cancel the whole AI queue */ }
        }
        if (!added.length) throw new Error('Gemini suggested songs, but none could be resolved by the music source.');
        if (!player.playing && !player.paused) await player.play();
        return interaction.editReply(`🤖 **${plan.summary}**\nQueued ${added.length} song${added.length === 1 ? '' : 's'}.`);
      }

      if (name === 'help') return interaction.reply({ ephemeral: true, content: '**EZ Music**\nRaw-song playback only: no nightcore, karaoke, 8D, EQ, pitch/speed or other DSP effects.\n\nCore: `/play` `/pause` `/resume` `/skip` `/previous` `/queue` `/seek` `/loop` `/shuffle` `/volume` `/favorite` `/history`\nAI: `/ai request:<what you want>` (requires GEMINI_API_KEY)\nButtons are also available on the Now Playing card.' });

      if (name === 'history') {
        const rows = recentHistory(interaction.guildId, 15);
        const text = rows.length ? rows.map((r,i) => `${i+1}. **${truncate(r.title, 70)}** — ${truncate(r.author, 40)}`).join('\n') : 'No history yet.';
        return interaction.reply({ ephemeral: true, content: text });
      }

      if (name === 'favorite') return handleFavorite(interaction, music, ensurePlayer);

      const player = getPlayer(music, interaction.guildId);
      if (name === 'pause') { player.pause(true); return interaction.reply('Paused.'); }
      if (name === 'resume') { player.pause(false); return interaction.reply('Resumed.'); }
      if (name === 'skip') { player.skip(); return interaction.reply('Skipped.'); }
      if (name === 'previous') {
        const prev = player.getPrevious(true);
        if (!prev) throw new Error('No previous song is available.');
        await player.play(prev);
        return interaction.reply(`Playing previous: **${truncate(prev.title, 100)}**.`);
      }
      if (name === 'stop') { player.queue.clear(); player.setLoop('none'); player.skip(); return interaction.reply('Stopped and cleared the queue.'); }
      if (name === 'disconnect') { await player.destroy(); return interaction.reply('Disconnected.'); }
      if (name === 'now') {
        const track = player.queue.current;
        if (!track) throw new Error('Nothing is playing.');
        return interaction.reply({ embeds: [nowPlayingEmbed(track, player)], components: playerButtons(player.paused) });
      }
      if (name === 'queue') {
        const current = player.queue.current;
        const upcoming = [...player.queue].slice(0, 15);
        const lines = [];
        if (current) lines.push(`**Now:** ${truncate(current.title, 90)} (${formatDuration(current.length)})`);
        lines.push(...upcoming.map((t, i) => `${i+1}. ${truncate(t.title, 80)} (${formatDuration(t.length)})`));
        if (player.queue.length > 15) lines.push(`…and ${player.queue.length - 15} more`);
        return interaction.reply({ ephemeral: true, content: lines.join('\n') || 'Queue is empty.' });
      }
      if (name === 'volume') { const n = interaction.options.getInteger('percent', true); await player.setVolume(n); return interaction.reply(`Volume set to ${n}%. No DSP effects applied.`); }
      if (name === 'seek') {
        const sec = parseTimeToSeconds(interaction.options.getString('time', true));
        if (sec === null) throw new Error('Invalid time. Use seconds, mm:ss, or hh:mm:ss.');
        await player.seek(sec); return interaction.reply(`Seeked to ${formatDuration(sec * 1000)}.`);
      }
      if (name === 'loop') { const mode = interaction.options.getString('mode', true); player.setLoop(mode); return interaction.reply(`Loop: **${mode}**.`); }
      if (name === 'shuffle') { player.queue.shuffle(); return interaction.reply('Queue shuffled.'); }
      if (name === 'clear') { player.queue.clear(); return interaction.reply('Upcoming queue cleared.'); }
      if (name === 'remove') {
        const pos = interaction.options.getInteger('position', true) - 1;
        if (pos < 0 || pos >= player.queue.length) throw new Error('That queue position does not exist.');
        const [removed] = player.queue.splice(pos, 1);
        return interaction.reply(`Removed **${truncate(removed.title, 100)}**.`);
      }
    } catch (error) {
      console.error('[interaction]', error);
      const message = `⚠️ ${error?.message || 'Something went wrong.'}`;
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
      return interaction.reply({ ephemeral: true, content: message }).catch(() => {});
    }
  };
}

async function handleFavorite(interaction, music, ensurePlayer) {
  const sub = interaction.options.getSubcommand();
  const rows = listFavorites(interaction.guildId, interaction.user.id, 25);
  if (sub === 'list') {
    const text = rows.length ? rows.map((r,i) => `${i+1}. **${truncate(r.title, 70)}** — ${truncate(r.author, 40)}`).join('\n') : 'You have no favorites yet.';
    return interaction.reply({ ephemeral: true, content: text });
  }
  if (sub === 'add') {
    const player = getPlayer(music, interaction.guildId); const track = player.queue.current;
    if (!track) throw new Error('Nothing is playing.');
    return interaction.reply({ ephemeral: true, content: addFavorite(interaction.guildId, interaction.user.id, track) ? `❤️ Saved **${truncate(track.title, 100)}**.` : 'That song is already in your favorites.' });
  }
  const index = interaction.options.getInteger('position', true) - 1;
  const row = rows[index];
  if (!row) throw new Error('That favorite position does not exist.');
  if (sub === 'remove') {
    removeFavorite(interaction.guildId, interaction.user.id, row.uri);
    return interaction.reply({ ephemeral: true, content: `Removed **${truncate(row.title, 100)}** from favorites.` });
  }
  if (sub === 'play') {
    await interaction.deferReply();
    const player = await ensurePlayer(interaction);
    const { tracks } = await searchAndQueue(player, row.uri || `${row.author} ${row.title}`, interaction.user);
    return interaction.editReply(`Queued favorite **${truncate(tracks[0].title, 100)}**.`);
  }
}

async function handleButton(interaction, music) {
  const player = getPlayer(music, interaction.guildId);
  const action = interaction.customId.split(':')[1];
  if (action === 'pause') player.pause(true);
  else if (action === 'resume') player.pause(false);
  else if (action === 'skip') player.skip();
  else if (action === 'stop') { player.queue.clear(); player.setLoop('none'); player.skip(); }
  else if (action === 'previous') {
    const prev = player.getPrevious(true);
    if (!prev) throw new Error('No previous song is available.');
    await player.play(prev);
  } else if (action === 'favorite') {
    const track = player.queue.current;
    if (!track) throw new Error('Nothing is playing.');
    const saved = addFavorite(interaction.guildId, interaction.user.id, track);
    return interaction.reply({ ephemeral: true, content: saved ? `❤️ Saved **${truncate(track.title, 100)}**.` : 'Already in your favorites.' });
  }
  return interaction.reply({ ephemeral: true, content: `Done: ${action}.` });
}
