import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing refine target: ${label}`);
  return text.replace(before, after);
}

{
  const path = 'src/commands.js';
  let text = read(path);

  text = replaceExact(
    text,
    "    'Plain-text song searches try YouTube Music first, then normal YouTube. Spotify URLs work when optional Spotify app credentials are configured.',",
    "    'Plain-text song searches prefer relevant YouTube Music matches, then fall back to normal YouTube. Single Spotify tracks also work without Spotify app credentials.',",
    'help search/spotify wording',
  );

  text = replaceExact(
    text,
    "          `Player: **${player ? (isAutoPausedForEmptyVoice(interaction.guildId) ? 'Auto-paused (empty VC)' : player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle') : 'Disconnected'}**`,",
    "          `Player: **${player ? (isAutoPausedForEmptyVoice(interaction.guildId) ? 'Auto-paused (empty VC)' : (player.paused || player.shoukaku?.paused) ? 'Paused' : player.shoukaku?.track ? 'Playing' : (player.queue?.current || player.queue?.length > 0) ? 'Idle (queue waiting)' : 'Idle') : 'Disconnected'}**`,",
    'status actual Lavalink state',
  );

  text = replaceExact(
    text,
    "          const action = next ? 'Queued next' : queued.started ? '▶️ Started playlist with' : 'Queued';",
    "          const action = queued.started ? '▶️ Started playlist with' : next ? 'Queued next' : 'Queued';",
    'playlist reply start priority',
  );
  text = replaceExact(
    text,
    "        const action = next ? 'Queued next' : queued.started ? '▶️ Playing' : 'Queued';",
    "        const action = queued.started ? '▶️ Playing' : next ? 'Queued next' : 'Queued';",
    'single reply start priority',
  );

  text = replaceExact(
    text,
    "        if (!player.queue.current && player.queue.length > 0) {",
    "        if (!player.shoukaku?.track && !player.paused && !player.shoukaku?.paused && (player.queue.current || player.queue.length > 0)) {",
    'nowplaying actual-track recovery condition',
  );

  const beforePicker = `  await withGuildOperation(interaction.guildId, async () => {
    if (!isQueueRevisionCurrent(interaction.guildId, entry.revision) || music.players.get(interaction.guildId) !== player) {
      searchPickers.delete(token);
      throw expectedError('That search picker is stale because the queue changed. Run \`/play\` again.');
    }
    const queued = queueTracks(player, [track], { next: entry.next, perRequestLimit: 1 });
    if (!queued.added.length) throw expectedError(\`Queue is full (maximum \${queueLimit} upcoming tracks).\`);
    await ensureQueuedPlayback(player);
    checkpointRecovery(player);
  });
  searchPickers.delete(token);
  return interaction.editReply({ content: \`\${entry.next ? 'Queued next' : 'Queued'} **\${safeTitle(track)}**.\`, embeds: [], components: [] });`;
  const afterPicker = `  const startState = await withGuildOperation(interaction.guildId, async () => {
    if (!isQueueRevisionCurrent(interaction.guildId, entry.revision) || music.players.get(interaction.guildId) !== player) {
      searchPickers.delete(token);
      throw expectedError('That search picker is stale because the queue changed. Run \`/play\` again.');
    }
    const queued = queueTracks(player, [track], { next: entry.next, perRequestLimit: 1 });
    if (!queued.added.length) throw expectedError(\`Queue is full (maximum \${queueLimit} upcoming tracks).\`);
    const state = await ensureQueuedPlayback(player);
    checkpointRecovery(player);
    return state;
  });
  searchPickers.delete(token);
  const action = startState?.started ? '▶️ Playing' : entry.next ? 'Queued next' : 'Queued';
  return interaction.editReply({ content: \`\${action} **\${safeTitle(track)}**.\`, embeds: [], components: [] });`;
  text = replaceExact(text, beforePicker, afterPicker, 'picker start reply');

  write(path, text);
}

{
  const path = 'test/search-playback-v019.test.js';
  let text = read(path);
  if (!text.includes("test('queued-only paused state is never implicitly started'")) {
    const marker = `test('manual pause is not implicitly resumed by queue activity', async () => {
  const player = playerMock({ paused: true, llTrack: 'encoded-track' });
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, false);
  assert.equal(player.playCalls, 0);
});`;
    const addition = `${marker}\n\ntest('queued-only paused state is never implicitly started', async () => {
  const player = playerMock({ current: null, upcoming: [track('Heavy Serenade', 'NMIXX')], paused: true, llTrack: null });
  const state = await ensureQueuedPlayback(player);
  assert.equal(state.started, false);
  assert.equal(player.playCalls, 0);
});`;
    text = replaceExact(text, marker, addition, 'paused queued-only test');
  }
  write(path, text);
}
