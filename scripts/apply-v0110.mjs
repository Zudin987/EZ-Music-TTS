import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true }); fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing patch target: ${label}`);
  return text.replace(before, after);
}

// 1) Search-quality: detect exact-title ambiguity where the query gives no artist signal.
{
  const path = 'src/search-quality.js';
  let text = read(path);
  const marker = `export function searchTrackScore(query, track) {`;
  const helper = `export function isAmbiguousTitleOnlyMatch(query, track) {\n  const queryTokens = tokens(query);\n  if (queryTokens.length < 2) return false;\n  const titleTokens = tokens(track?.title);\n  const authorTokens = tokens(track?.author);\n  // Example: \"Heavy Serenade\" perfectly matches many unrelated uploads. If\n  // every query token is only in the title and none identify the uploader/artist,\n  // compare normal YouTube ranking before accepting the YTM result.\n  return coverage(queryTokens, titleTokens) === 1 && coverage(queryTokens, authorTokens) === 0;\n}\n\n`;
  if (!text.includes('export function isAmbiguousTitleOnlyMatch')) {
    text = replaceExact(text, marker, helper + marker, 'ambiguous title-only helper');
  }
  write(path, text);
}

// 2) Plain-text routing: keep YTM fast when artist intent is clear; compare YouTube for ambiguous exact titles.
{
  const path = 'src/source-routing.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { rankSearchResult, SEARCH_MATCH_THRESHOLD } from './search-quality.js';`,
    `import { isAmbiguousTitleOnlyMatch, rankSearchResult, SEARCH_MATCH_THRESHOLD } from './search-quality.js';`,
    'source-routing quality import',
  );

  const before = `async function searchTextPreferred(target, clean, requester) {\n  let ytmError = null;\n  let rankedYtm = null;\n  try {\n    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });\n    if (ytm?.tracks?.length) {\n      rankedYtm = rankSearchResult(ytm, clean);\n      if (rankedYtm.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;\n    }\n  } catch (error) {\n    ytmError = error;\n  }\n\n  try {\n    const youtube = await target.search(clean, { requester, source: 'ytsearch:' });\n    if (youtube?.tracks?.length) {\n      const rankedYoutube = rankSearchResult(youtube, clean);\n      if (rankedYoutube.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYoutube.result;\n    }\n    // A weak result is worse than an explicit no-result message: never silently\n    // substitute an unrelated title merely because a search endpoint returned it.\n    return { ...(youtube || rankedYtm?.result || {}), tracks: [] };\n  } catch (error) {\n    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;\n    throw error || ytmError || new Error(\`No results for: \${clean}\`);\n  }\n}`;
  const after = `async function searchTextPreferred(target, clean, requester) {\n  let ytmError = null;\n  let rankedYtm = null;\n  let ytmNeedsYoutubeComparison = false;\n  try {\n    const ytm = await target.search(clean, { requester, source: 'ytmsearch:' });\n    if (ytm?.tracks?.length) {\n      rankedYtm = rankSearchResult(ytm, clean);\n      if (rankedYtm.bestScore >= SEARCH_MATCH_THRESHOLD) {\n        const bestYtm = rankedYtm.result?.tracks?.[0];\n        ytmNeedsYoutubeComparison = isAmbiguousTitleOnlyMatch(clean, bestYtm);\n        if (!ytmNeedsYoutubeComparison) return rankedYtm.result;\n      }\n    }\n  } catch (error) {\n    ytmError = error;\n  }\n\n  try {\n    const youtube = await target.search(clean, { requester, source: 'ytsearch:' });\n    if (youtube?.tracks?.length) {\n      const rankedYoutube = rankSearchResult(youtube, clean);\n      if (rankedYoutube.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYoutube.result;\n    }\n    // If YouTube has no good answer, an otherwise strong YTM exact-title match is\n    // still preferable to returning nothing. The comparison only resolves ambiguity.\n    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;\n    return { ...(youtube || rankedYtm?.result || {}), tracks: [] };\n  } catch (error) {\n    if (rankedYtm?.bestScore >= SEARCH_MATCH_THRESHOLD) return rankedYtm.result;\n    throw error || ytmError || new Error(\`No results for: \${clean}\`);\n  }\n}`;
  text = replaceExact(text, before, after, 'searchTextPreferred v0.1.10');
  write(path, text);
}

// 3) Pure helper for one-shot alternate-video recovery after a YouTube stream fails.
write('src/playback-fallback.js', `import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';\n\nexport function youtubeTrackId(track) {\n  const direct = String(track?.identifier || '').trim();\n  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;\n  const uri = String(track?.uri || track?.realUri || '');\n  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\\.be\\/([A-Za-z0-9_-]{11})/);\n  return match?.[1] || null;\n}\n\nfunction durationCompatible(failedTrack, candidate) {\n  const failed = Number(failedTrack?.length || 0);\n  const next = Number(candidate?.length || 0);\n  if (!failed || !next) return true;\n  if (failed >= 120_000 && next < 60_000) return false;\n  return Math.abs(next - failed) <= Math.max(120_000, failed * 0.55);\n}\n\nexport function choosePlaybackAlternative(query, tracks, failedTrack) {\n  const failedId = youtubeTrackId(failedTrack);\n  for (const candidate of Array.isArray(tracks) ? tracks : []) {\n    if (!candidate || candidate?.isStream) continue;\n    const candidateId = youtubeTrackId(candidate);\n    if (!candidateId || (failedId && candidateId === failedId)) continue;\n    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;\n    if (!durationCompatible(failedTrack, candidate)) continue;\n    // Keep native normal-YouTube ranking among acceptable candidates. This is\n    // intentionally different from re-sorting exact-title clones by title alone.\n    return candidate;\n  }\n  return null;\n}\n`);

// 4) Music runtime: one controlled normal-YouTube alternative retry before dropping the failed track.
{
  const path = 'src/music.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { emptyVoiceTransition } from './performance.js';`,
    `import { emptyVoiceTransition } from './performance.js';\nimport { choosePlaybackAlternative, youtubeTrackId } from './playback-fallback.js';`,
    'music fallback import',
  );
  text = replaceExact(text, `const RECOVERY_SYNC_BATCH = 20;`, `const RECOVERY_SYNC_BATCH = 20;\nconst PLAYBACK_FALLBACK_WINDOW_MS = 30_000;`, 'fallback constant');
  text = replaceExact(
    text,
    `  const recoveryResumes = new Set();\n  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);`,
    `  const recoveryResumes = new Set();\n  const playbackFallbackInFlight = new Set();\n  const playbackFallbackAttempts = new Map();\n  const spotifyConfigured = Boolean(config.spotifyClientId && config.spotifyClientSecret);`,
    'fallback state maps',
  );

  const insertionMarker = `  function clearEmptyVoiceTimer(guildId) {`;
  const fallbackFunctions = `  async function tryYoutubePlaybackFallback(player, failedTrack, message) {\n    const guildId = player?.guildId;\n    const failedId = youtubeTrackId(failedTrack);\n    const title = String(failedTrack?.title || '').trim();\n    if (!guildId || !failedId || !title || failedTrack?._ezPlaybackFallback) return false;\n    if (playbackFallbackInFlight.has(guildId)) return false;\n\n    const fingerprint = \`${'${failedId}'}:${'${title.toLowerCase()}'}\`;\n    const previous = playbackFallbackAttempts.get(guildId);\n    if (previous?.fingerprint === fingerprint && Date.now() - previous.at < PLAYBACK_FALLBACK_WINDOW_MS) return false;\n    playbackFallbackAttempts.set(guildId, { fingerprint, at: Date.now() });\n    playbackFallbackInFlight.add(guildId);\n\n    try {\n      const result = await player.search(title, { requester: failedTrack?.requester || client.user, source: 'ytsearch:' });\n      const alternative = choosePlaybackAlternative(title, result?.tracks, failedTrack);\n      if (!alternative) return false;\n\n      return await withGuildOperation(guildId, async () => {\n        if (music.players.get(guildId) !== player || player.paused || player.shoukaku?.paused) return false;\n        const current = player.queue.current;\n        const currentId = youtubeTrackId(current);\n        // Never interrupt a different item if the queue already advanced while the\n        // fallback search was in flight. Replacing the same failed item is safe.\n        if (currentId && currentId !== failedId) return false;\n        try { alternative._ezPlaybackFallback = true; } catch { /* track may be sealed */ }\n        console.warn(\`[playback-fallback] ${'${guildId}'}: ${'${failedTrack.title}'} failed (${ '${String(message || "source error").slice(0, 120)}' }); retrying ${'${alternative.title}'} — ${'${alternative.author || "Unknown"}'}\`);\n        await player.play(alternative, { replaceCurrent: true });\n        checkpointRecovery(player);\n        return true;\n      });\n    } catch (error) {\n      console.warn('[playback-fallback] alternate video retry failed', error?.message || error);\n      return false;\n    } finally {\n      playbackFallbackInFlight.delete(guildId);\n    }\n  }\n\n`;
  if (!text.includes('async function tryYoutubePlaybackFallback')) {
    text = replaceExact(text, insertionMarker, fallbackFunctions + insertionMarker, 'fallback runtime functions');
  }

  const beforeHandler = `  music.on('playerException', (player, data) => {\n    const message = data?.exception?.message || data?.message || 'track exception';\n    console.warn('[player-exception]', player.guildId, message);\n    recordPlaybackFailure(player, message);\n  });`;
  const afterHandler = `  music.on('playerException', (player, data) => {\n    const message = data?.exception?.message || data?.message || 'track exception';\n    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;\n    const failedId = youtubeTrackId(failedTrack);\n    console.warn('[player-exception]', player.guildId, message);\n    void (async () => {\n      if (await tryYoutubePlaybackFallback(player, failedTrack, message)) return;\n      const currentId = youtubeTrackId(player.queue.current);\n      const sameFailedItem = !failedId || !currentId || currentId === failedId;\n      recordPlaybackFailure(player, message, { skipCurrent: sameFailedItem });\n    })().catch((error) => {\n      console.warn('[player-exception] fallback handler failed', error?.message || error);\n      recordPlaybackFailure(player, message);\n    });\n  });`;
  text = replaceExact(text, beforeHandler, afterHandler, 'playerException fallback handler');

  text = replaceExact(
    text,
    `    recoveryPositionSavedAt.delete(player.guildId);\n    discardHeldQueue(player.guildId);`,
    `    recoveryPositionSavedAt.delete(player.guildId);\n    playbackFallbackInFlight.delete(player.guildId);\n    playbackFallbackAttempts.delete(player.guildId);\n    discardHeldQueue(player.guildId);`,
    'destroy fallback cleanup',
  );
  write(path, text);
}

// 5) YouTube clients: keep current recommended chain, then add two Opus-capable last-resort clients.
{
  const path = 'lavalink/application.yml';
  let text = read(path);
  const before = `    # Keep the playback path short and Opus-capable. This follows the current\n    # youtube-source recommended example: MUSIC searches, then playback falls\n    # through ANDROID_VR -> WEB -> WEBEMBEDDED. Avoiding regular ANDROID (marked\n    # frequently dysfunctional upstream), IOS (no Opus), and TVHTML5_SIMPLY also\n    # avoids known failed-client work before playback starts.\n    clients:\n      - MUSIC\n      - ANDROID_VR\n      - WEB\n      - WEBEMBEDDED`;
  const after = `    # Keep the normal playback path identical to upstream's recommended example,\n    # then add MWEB and ANDROID_MUSIC only as last-resort Opus-capable fallbacks.\n    # They cost nothing once an earlier client succeeds. Regular ANDROID remains\n    # excluded (frequently dysfunctional), IOS remains excluded (no Opus / extra\n    # transcoding), and TVHTML5_SIMPLY stays excluded after prior sign-in/403 issues.\n    clients:\n      - MUSIC\n      - ANDROID_VR\n      - WEB\n      - WEBEMBEDDED\n      - MWEB\n      - ANDROID_MUSIC`;
  text = replaceExact(text, before, after, 'youtube client fallback chain');
  write(path, text);
}

// 6) Version/check script.
{
  const path = 'package.json';
  const pkg = JSON.parse(read(path));
  pkg.version = '0.1.10';
  if (!pkg.scripts.check.includes('src/playback-fallback.js')) {
    pkg.scripts.check = pkg.scripts.check.replace('node --check src/playback-start.js', 'node --check src/playback-start.js && node --check src/playback-fallback.js');
  }
  write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 7) Update old client invariant test and add focused regression tests.
{
  const path = 'test/performance-v016.test.js';
  let text = read(path);
  text = text.replace(
    `['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']`,
    `['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED', 'MWEB', 'ANDROID_MUSIC']`,
  );
  write(path, text);
}

write('test/search-playback-v0110.test.js', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { resolvePreferredSearch } from '../src/source-routing.js';\nimport { isAmbiguousTitleOnlyMatch } from '../src/search-quality.js';\nimport { choosePlaybackAlternative } from '../src/playback-fallback.js';\n\nfunction track(title, author, identifier, length = 200_000) {\n  return { title, author, identifier, uri: \`https://www.youtube.com/watch?v=\${identifier}\`, length };\n}\n\nfunction target(ytm, yt) {\n  const calls = [];\n  return {\n    calls,\n    async search(query, options = {}) {\n      calls.push(options.source);\n      if (options.source === 'ytmsearch:') return { type: 'SEARCH', tracks: ytm };\n      if (options.source === 'ytsearch:') return { type: 'SEARCH', tracks: yt };\n      return { type: 'SEARCH', tracks: [] };\n    },\n  };\n}\n\ntest('plain exact-title ambiguity compares normal YouTube and avoids unrelated uploader', async () => {\n  const ytm = [track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000)];\n  const yt = [track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I', 205_000)];\n  const search = target(ytm, yt);\n  const result = await resolvePreferredSearch(search, 'Heavy Serenade', { id: 'u' });\n  assert.equal(result.tracks[0].identifier, '6Ycn9qZK09I');\n  assert.deepEqual(search.calls, ['ytmsearch:', 'ytsearch:']);\n});\n\ntest('artist-qualified good YTM result stays fast without unnecessary YouTube query', async () => {\n  const ytm = [track('Heavy Serenade', 'NMIXX', 'aaaaaaaaaaa')];\n  const search = target(ytm, [track('Heavy Serenade', 'Other', 'bbbbbbbbbbb')]);\n  const result = await resolvePreferredSearch(search, 'NMIXX Heavy Serenade', { id: 'u' });\n  assert.equal(result.tracks[0].identifier, 'aaaaaaaaaaa');\n  assert.deepEqual(search.calls, ['ytmsearch:']);\n});\n\ntest('ambiguous-title helper requires full title coverage and no artist signal', () => {\n  assert.equal(isAmbiguousTitleOnlyMatch('Heavy Serenade', track('Heavy Serenade', 'Khmer woman', 'aaaaaaaaaaa')), true);\n  assert.equal(isAmbiguousTitleOnlyMatch('NMIXX Heavy Serenade', track('Heavy Serenade', 'NMIXX', 'aaaaaaaaaaa')), false);\n  assert.equal(isAmbiguousTitleOnlyMatch('D.O Rose', track('Rose', 'D.O', 'aaaaaaaaaaa')), false);\n});\n\ntest('playback fallback keeps native YouTube order, skips failed id and variant uploader', () => {\n  const failed = track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000);\n  const candidates = [\n    track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000),\n    track('Heavy Serenade', 'Shin Giwon Piano', 'pianopiano1', 205_000),\n    track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I', 205_000),\n  ];\n  assert.equal(choosePlaybackAlternative('Heavy Serenade', candidates, failed)?.identifier, '6Ycn9qZK09I');\n});\n\ntest('v0.1.10 keeps only Opus-capable extra clients and no heap/buffer increase', () => {\n  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');\n  const section = app.split('  youtube:\\n')[1] || '';\n  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((m) => m[1]);\n  assert.deepEqual(clients.slice(0, 6), ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED', 'MWEB', 'ANDROID_MUSIC']);\n  assert.ok(!clients.includes('IOS'));\n  assert.ok(!clients.includes('ANDROID'));\n  assert.ok(!clients.includes('TVHTML5_SIMPLY'));\n  assert.match(app, /bufferDurationMs: 2000/);\n  assert.match(app, /frameBufferDurationMs: 20000/);\n  assert.match(app, /nonAllocatingFrameBuffer: true/);\n  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');\n  assert.match(start, /-Xmx256M/);\n  assert.match(start, /--max-old-space-size=128/);\n});\n\ntest('playerException attempts alternate video before normal source-protection skip', () => {\n  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');\n  const handler = music.split("music.on('playerException'")[1]?.split("music.on('playerResolveError'")[0] || '';\n  assert.match(handler, /tryYoutubePlaybackFallback/);\n  assert.match(handler, /recordPlaybackFailure/);\n  assert.ok(handler.indexOf('tryYoutubePlaybackFallback') < handler.indexOf('recordPlaybackFailure'));\n});\n`);

// 8) Release note in README.
{
  const path = 'README.md';
  let text = read(path);
  const marker = '## Search/start reliability (v0.1.9)';
  const note = `## Search/playback fallback reliability (v0.1.10)\n\nTitle-only searches that produce an exact but artist-ambiguous YouTube Music result now compare normal YouTube before choosing, preventing same-title uploads from unrelated channels from silently winning. If a chosen YouTube video still throws a playback exception, EZ Music makes one bounded normal-YouTube alternate-video attempt for the same title before the existing source-protection logic skips it. The normal youtube-source client chain is unchanged first; MWEB and ANDROID_MUSIC are appended only as Opus-capable last-resort playback clients. No OAuth, poToken worker, yt-dlp, DSP, heap increase, or extra process is introduced.\n\n`;
  if (!text.includes('## Search/playback fallback reliability (v0.1.10)')) {
    if (!text.includes(marker)) throw new Error('README v0.1.9 marker missing');
    text = text.replace(marker, note + marker);
  }
  write(path, text);
}
