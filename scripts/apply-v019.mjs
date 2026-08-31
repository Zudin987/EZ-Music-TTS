import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing patch target: ${label}`);
  return text.replace(before, after);
}

// Search routing: YTM remains preferred only when it actually resembles the query.
{
  const path = 'src/source-routing.js';
  let text = read(path);
  text = replaceExact(
    text,
    "const SPOTIFY_HOST = 'open.spotify.com';",
    "import { rankSearchResult, SEARCH_MATCH_THRESHOLD } from './search-quality.js';\n\nconst SPOTIFY_HOST = 'open.spotify.com';",
    'source-routing import',
  );
  const before = `async function searchTextPreferred(target, clean, requester) {
  let ytmError = null;
  try {
    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });
    if (ytm?.tracks?.length) return ytm;
  } catch (error) {
    ytmError = error;
  }

  try {
    return await target.search(clean, { requester, source: 'ytsearch:' });
  } catch (error) {
    throw error || ytmError || new Error(\`No results for: \${clean}\`);
  }
}`;
  const after = `async function searchTextPreferred(target, clean, requester) {
  let ytmError = null;
  let rankedYtm = null;
  try {
    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });
    if (ytm?.tracks?.length) {
      rankedYtm = rankSearchResult(ytm, clean);
      if (rankedYtm.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;
    }
  } catch (error) {
    ytmError = error;
  }

  try {
    const youtube = await target.search(clean, { requester, source: 'ytsearch:' });
    if (youtube?.tracks?.length) {
      const rankedYoutube = rankSearchResult(youtube, clean);
      if (rankedYoutube.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYoutube.result;
    }
    // A weak result is worse than an explicit no-result message: never silently
    // substitute an unrelated title merely because a search endpoint returned it.
    return { ...(youtube || rankedYtm?.result || {}), tracks: [] };
  } catch (error) {
    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;
    throw error || ytmError || new Error(\`No results for: \${clean}\`);
  }
}`;
  text = replaceExact(text, before, after, 'searchTextPreferred');
  write(path, text);
}

// Playback commands: use actual Lavalink track state rather than a possibly stale wrapper flag.
{
  const path = 'src/commands.js';
  let text = read(path);
  text = replaceExact(
    text,
    "import { createSearchPickerRegistry } from './search-picker.js';",
    "import { createSearchPickerRegistry } from './search-picker.js';\nimport { ensureQueuedPlayback } from './playback-start.js';",
    'commands playback import',
  );

  const beforeSearchAndQueue = `async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit, searchPreferred, mutate = async (task) => task()) {
  const { tracks, result } = await searchTracks(player, query, requester, searchPreferred);
  guard();
  const perRequestLimit = result.type === 'PLAYLIST' ? MAX_PLAYLIST_ADD : 1;
  const queued = await mutate(async () => {
    guard();
    const value = queueTracks(player, tracks, { next, perRequestLimit });
    if (!value.added.length) throw expectedError(\`Queue is full (maximum \${queueLimit} upcoming tracks).\`);
    if (!player.playing && !player.paused) await player.play();
    return value;
  });
  return { tracks: queued.added, result, omitted: queued.omitted, sourceCount: tracks.length };
}`;
  const afterSearchAndQueue = `async function searchAndQueue(player, query, requester, next, guard, queueTracks, queueLimit, searchPreferred, mutate = async (task) => task()) {
  const { tracks, result } = await searchTracks(player, query, requester, searchPreferred);
  guard();
  const perRequestLimit = result.type === 'PLAYLIST' ? MAX_PLAYLIST_ADD : 1;
  const queued = await mutate(async () => {
    guard();
    const value = queueTracks(player, tracks, { next, perRequestLimit });
    if (!value.added.length) throw expectedError(\`Queue is full (maximum \${queueLimit} upcoming tracks).\`);
    const startState = await ensureQueuedPlayback(player);
    return { value, startState };
  });
  return {
    tracks: queued.value.added,
    result,
    omitted: queued.value.omitted,
    sourceCount: tracks.length,
    started: Boolean(queued.startState?.started),
  };
}`;
  text = replaceExact(text, beforeSearchAndQueue, afterSearchAndQueue, 'searchAndQueue');

  // All other queue entry points receive the same stale-playing protection.
  const oldStart = 'if (!player.playing && !player.paused) await player.play();';
  const count = text.split(oldStart).length - 1;
  if (count !== 4) throw new Error(`Expected 4 remaining old playback gates, found ${count}`);
  text = text.split(oldStart).join('await ensureQueuedPlayback(player);');

  const beforeReply = `        const where = next ? 'Queued next' : 'Queued';
        if (queued.result.type === 'PLAYLIST') {
          const limitNote = queued.omitted ? \` Limited for stability: **\${queued.omitted} track\${queued.omitted === 1 ? '' : 's'} not added** (max \${MAX_PLAYLIST_ADD} per playlist / \${queueLimit} upcoming).\` : '';
          return interaction.editReply(\`\${where} **\${queued.tracks.length} tracks**.\${limitNote}\`);
        }
        return interaction.editReply(\`\${where} **\${safeTitle(queued.tracks[0])}**.\`);`;
  const afterReply = `        if (queued.result.type === 'PLAYLIST') {
          const action = next ? 'Queued next' : queued.started ? '▶️ Started playlist with' : 'Queued';
          const limitNote = queued.omitted ? \` Limited for stability: **\${queued.omitted} track\${queued.omitted === 1 ? '' : 's'} not added** (max \${MAX_PLAYLIST_ADD} per playlist / \${queueLimit} upcoming).\` : '';
          return interaction.editReply(\`\${action} **\${queued.tracks.length} tracks**.\${limitNote}\`);
        }
        const action = next ? 'Queued next' : queued.started ? '▶️ Playing' : 'Queued';
        return interaction.editReply(\`\${action} **\${safeTitle(queued.tracks[0])}**.\`);`;
  text = replaceExact(text, beforeReply, afterReply, 'play reply action');

  const beforeNow = `      if (name === 'nowplaying') {
        requireSameVoice(interaction, player);
        requireCurrentTrack(player);
        await publicNowPlayingReply(interaction, panelPayload(player, interaction.guildId));
        livePanels.track(interaction);
        return;
      }`;
  const afterNow = `      if (name === 'nowplaying') {
        requireSameVoice(interaction, player);
        let notice = null;
        if (!player.queue.current && player.queue.length > 0) {
          try {
            await withGuildOperation(interaction.guildId, async () => {
              await ensureQueuedPlayback(player);
              checkpointRecovery(player);
            });
          } catch (error) {
            notice = \`⚠️ Playback is idle: \${error?.message || 'the queued track could not start.'}\`;
          }
        }
        await publicNowPlayingReply(interaction, panelPayload(player, interaction.guildId, notice));
        if (player.queue.current || player.queue.length > 0) livePanels.track(interaction);
        return;
      }`;
  text = replaceExact(text, beforeNow, afterNow, 'nowplaying queue recovery');

  // Keep a queued-idle panel alive instead of immediately retiring it.
  text = replaceExact(
    text,
    "    if (!currentPlayer?.queue?.current) {",
    "    if (!currentPlayer?.queue?.current && !Number(currentPlayer?.queue?.length || 0)) {",
    'live panel idle condition',
  );
  text = replaceExact(
    text,
    "  if (currentPlayer?.queue?.current) livePanels.track(interaction);\n  else livePanels.pause(interaction);",
    "  if (currentPlayer?.queue?.current || Number(currentPlayer?.queue?.length || 0) > 0) livePanels.track(interaction);\n  else livePanels.pause(interaction);",
    'live panel edit condition',
  );

  write(path, text);
}

// UI: when current is absent but queue work exists, show the waiting queue instead of "Nothing is playing".
{
  const path = 'src/ui.js';
  let text = read(path);
  const beforeIdle = `function idleContainerPayload(notice = null, heading = '⏹️ Playback Idle') {
  return textContainerPayload([
    \`### \${heading}\`,
    notice ? safeText(notice, 900) : 'Nothing is playing right now.',
    '',
    'Use \`/play\` to start music, or open your library below.',
  ], statusButtons());
}`;
  const afterIdle = `function idleContainerPayload(notice = null, heading = '⏹️ Playback Idle') {
  return textContainerPayload([
    \`### \${heading}\`,
    notice ? safeText(notice, 900) : 'Nothing is playing right now.',
    '',
    'Use \`/play\` to start music, or open your library below.',
  ], statusButtons());
}

function queuedIdleContainerPayload(player, autoplayMode = 'off', notice = null, { canUndo = false } = {}) {
  const count = Number(player?.queue?.length || 0);
  const first = player?.queue?.[0];
  const lines = [
    '### ⏳ Playback Idle — Queue Waiting',
    notice ? safeText(notice, 900) : 'Playback is not active yet, but the queue is not empty.',
    '',
    \`📜 **Up next:** \${count}\`,
  ];
  if (first) lines.push(\`⏭️ **First queued:** \${safeText(first.title, 90)} — \${safeText(first.author || 'Unknown', 50)}\`);
  lines.push('', 'Use **Queue** to inspect/manage the waiting tracks, or **Refresh** after playback starts.');
  return textContainerPayload(lines, playerButtons(player, autoplayMode, { canUndo }));
}`;
  text = replaceExact(text, beforeIdle, afterIdle, 'queued idle UI');

  const beforeJukebox = `export function jukeboxPlayerPayload(player, autoplayMode = 'off', notice = null, { canUndo = false } = {}) {
  const track = player?.queue?.current;
  if (!track) return idleContainerPayload(notice);
  return trackContainerPayload(track, player, autoplayMode, playerButtons(player, autoplayMode, { canUndo }), { notice });
}`;
  const afterJukebox = `export function jukeboxPlayerPayload(player, autoplayMode = 'off', notice = null, { canUndo = false } = {}) {
  const track = player?.queue?.current;
  if (!track && Number(player?.queue?.length || 0) > 0) return queuedIdleContainerPayload(player, autoplayMode, notice, { canUndo });
  if (!track) return idleContainerPayload(notice);
  return trackContainerPayload(track, player, autoplayMode, playerButtons(player, autoplayMode, { canUndo }), { notice });
}`;
  text = replaceExact(text, beforeJukebox, afterJukebox, 'jukebox queued idle');
  write(path, text);
}

// Keep development checks aware of the two new pure helpers.
{
  const path = 'package.json';
  const pkg = JSON.parse(read(path));
  pkg.version = '0.1.9';
  pkg.scripts.check = pkg.scripts.check
    .replace('node --check src/source-routing.js', 'node --check src/source-routing.js && node --check src/search-quality.js && node --check src/playback-start.js');
  write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

// Short release behavior note; existing detailed docs stay intact.
{
  const path = 'README.md';
  let text = read(path);
  const marker = '## Search routing and Spotify URLs (v0.1.4)';
  const note = `## Search/start reliability (v0.1.9)\n\nPlain-text YTM results now need to resemble the requested title/artist. Weak YTM matches fall through to normal YouTube instead of silently queueing an unrelated song; weak results from both sources are reported as no result. Idle queue starts use Lavalink's actual track state rather than only Kazagumo's wrapper playing flag, and a resolve failure can no longer be reported as a successful queue/start. \`/nowplaying\` also shows a queue-waiting panel when tracks exist but no current item is active.\n\n`;
  if (!text.includes('## Search/start reliability (v0.1.9)')) {
    if (!text.includes(marker)) throw new Error('README marker missing');
    text = text.replace(marker, `${note}${marker}`);
  }
  write(path, text);
}
