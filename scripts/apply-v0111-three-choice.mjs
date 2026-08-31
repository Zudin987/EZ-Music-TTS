import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing patch target: ${label}`);
  return text.replace(before, after);
}

{
  const path = 'src/commands.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { ensureQueuedPlayback } from './playback-start.js';`,
    `import { ensureQueuedPlayback } from './playback-start.js';\nimport { resolveSearchChoices, shouldOfferSearchChoices } from './search-choices.js';`,
    'commands search-choice import',
  );
  text = replaceExact(
    text,
    `  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)).addBooleanOption(o => o.setName('select').setDescription('Privately choose from the top search results')),\n  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)).addBooleanOption(o => o.setName('select').setDescription('Privately choose from the top search results')),`,
    `  new SlashCommandBuilder().setName('play').setDescription('Play or queue a song/playlist').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),\n  new SlashCommandBuilder().setName('playnext').setDescription('Put a song/playlist directly after the current song').addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true).setMaxLength(1000)),`,
    'remove redundant select options',
  );
  text = replaceExact(
    text,
    `    'More: seek/replay plus Favorites and Recent History. \`/play select:true\` privately lets you choose an exact search result.',\n    'Plain-text song searches prefer relevant YouTube Music matches, then fall back to normal YouTube. Single Spotify tracks also work without Spotify app credentials.',`,
    `    'More: seek/replay plus Favorites and Recent History.',\n    'Typed \`/play\` and \`/playnext\` searches show 3 private choices before anything is queued. The choices combine a YouTube lyrics-biased search, YouTube Music, and normal YouTube.',\n    'Direct YouTube/Spotify/SoundCloud links play immediately. Single Spotify tracks also work without Spotify app credentials.',`,
    'help search-picker text',
  );

  const before = `      if (name === 'play' || name === 'playnext') {\n        await privateDefer(interaction);\n        const query = interaction.options.getString('query', true);\n        const next = name === 'playnext';\n        if (interaction.options.getBoolean('select') === true) {\n          const result = await searchPreferred(music, query, interaction.user);\n          if (!result?.tracks?.length) throw new Error(\`No results for: \${truncate(query, 120)}\`);\n          if (result.type !== 'PLAYLIST' && result.tracks.length > 1) {\n            const token = createSearchPicker(interaction, result.tracks, next, getQueueRevision(interaction.guildId));\n            return interaction.editReply(searchPickerPayload(token, result.tracks, next ? 'next' : 'play'));\n          }\n          // A playlist/direct URL has one unambiguous target; queue it normally.\n        }\n        const player = await ensurePlayer(interaction);`;
  const after = `      if (name === 'play' || name === 'playnext') {\n        await privateDefer(interaction);\n        const query = interaction.options.getString('query', true);\n        const next = name === 'playnext';\n\n        // Typed searches are intentionally selection-first. Search metadata before\n        // connecting to voice so a user can cancel without creating a player.\n        // Direct URLs and explicit source prefixes keep immediate expert behavior.\n        if (shouldOfferSearchChoices(query)) {\n          const choices = await resolveSearchChoices(music, query, interaction.user, { limit: 3 });\n          if (!choices.length) throw new Error(\`No relevant results for: \${truncate(query, 120)}\`);\n          const tracks = choices.map((choice) => choice.track);\n          const hints = choices.map((choice) => choice.kind);\n          const token = createSearchPicker(interaction, tracks, next, getQueueRevision(interaction.guildId));\n          return interaction.editReply(searchPickerPayload(token, tracks, next ? 'next' : 'play', hints));\n        }\n\n        const player = await ensurePlayer(interaction);`;
  text = replaceExact(text, before, after, 'default three-choice play handler');
  write(path, text);
}

{
  const path = 'src/ui.js';
  let text = read(path);
  const before = `export function searchPickerPayload(token, tracks, mode = 'play') {\n  const choices = (tracks || []).slice(0, 5);\n  const label = mode === 'next' ? 'Play Next' : 'Play';\n  if (!choices.length) return { content: 'No selectable results found.', embeds: [], components: [] };\n  const menu = new StringSelectMenuBuilder()\n    .setCustomId(\`music:spick:\${token}\`)\n    .setPlaceholder(\`\${label}: choose the exact result\`)\n    .setMinValues(1)\n    .setMaxValues(1)\n    .addOptions(choices.map((track, index) => ({\n      label: truncate(\`\${index + 1}. \${String(track?.title || 'Unknown title')}\`, 100),\n      description: truncate(\`\${String(track?.author || 'Unknown')} • \${formatDuration(track?.length || 0)}\`, 100),\n      value: String(index),\n    })));\n  return {\n    content: \`**🔎 Choose a result** • \${label}\\nThis picker expires in 2 minutes.\`,\n    embeds: [],\n    components: [\n      new ActionRowBuilder().addComponents(menu),\n      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(\`music:spcancel:\${token}\`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)),\n    ],\n  };\n}`;
  const after = `export function searchPickerPayload(token, tracks, mode = 'play', hints = []) {\n  const choices = (tracks || []).slice(0, 3);\n  const label = mode === 'next' ? 'Play Next' : 'Play';\n  if (!choices.length) return { content: 'No selectable results found.', embeds: [], components: [] };\n  const menu = new StringSelectMenuBuilder()\n    .setCustomId(\`music:spick:\${token}\`)\n    .setPlaceholder(\`\${label}: choose 1 of \${choices.length}\`)\n    .setMinValues(1)\n    .setMaxValues(1)\n    .addOptions(choices.map((track, index) => {\n      const hint = String(hints?.[index] || '').trim();\n      return {\n        label: truncate(\`\${index + 1}. \${String(track?.title || 'Unknown title')}\`, 100),\n        description: truncate(\`\${hint ? \`[\${hint}] \` : ''}\${String(track?.author || 'Unknown')} • \${formatDuration(track?.length || 0)}\`, 100),\n        value: String(index),\n      };\n    }));\n  return {\n    content: \`**🔎 Choose a result** • \${label}\\nTyped searches wait for your choice. **Lyrics/Audio are preferred over M/V** when they match. Picker expires in 2 minutes.\`,\n    embeds: [],\n    components: [\n      new ActionRowBuilder().addComponents(menu),\n      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(\`music:spcancel:\${token}\`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary)),\n    ],\n  };\n}`;
  text = replaceExact(text, before, after, 'three-result picker UI');
  write(path, text);
}

{
  const path = 'src/search-picker.js';
  let text = read(path);
  text = replaceExact(text, `tracks: Array.isArray(tracks) ? tracks.slice(0, 5) : [],`, `tracks: Array.isArray(tracks) ? tracks.slice(0, 3) : [],`, 'picker registry cap');
  write(path, text);
}

{
  const path = 'package.json';
  const pkg = JSON.parse(read(path));
  pkg.version = '0.1.11';
  if (!pkg.scripts.check.includes('src/search-choices.js')) {
    pkg.scripts.check = pkg.scripts.check.replace('node --check src/search-quality.js', 'node --check src/search-quality.js && node --check src/search-choices.js');
  }
  write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

{
  const path = 'package-lock.json';
  const lock = JSON.parse(read(path));
  lock.version = '0.1.11';
  if (lock.packages?.['']) lock.packages[''].version = '0.1.11';
  write(path, `${JSON.stringify(lock, null, 2)}\n`);
}

{
  const path = 'README.md';
  let text = read(path);
  if (!text.includes('## Three-choice typed search (v0.1.11)')) {
    text += `\n## Three-choice typed search (v0.1.11)\n\nTyped \`/play <song name>\` and \`/playnext <song name>\` requests now stay private and show up to **3 choices before anything is queued**. EZ Music searches normal YouTube with a \`lyrics\` bias, YouTube Music, and normal YouTube concurrently, then relevance-filters and deduplicates exact media IDs. Lyrics and official-audio style uploads are preferred over M/V uploads when the user did not ask for a video, while cover/remix/karaoke/instrumental/etc. filtering remains active. The picker intentionally keeps distinct Lyrics/Audio/M/V uploads selectable instead of collapsing them as queue duplicates. Direct YouTube, Spotify, and SoundCloud URLs still resolve immediately without a picker. These are short metadata searches only; they do not add a process, cache service, DSP, playback buffer, or background polling.\n`;
  }
  write(path, text);
}
