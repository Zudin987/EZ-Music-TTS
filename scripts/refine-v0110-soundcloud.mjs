import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing refine target: ${label}`);
  return text.replace(before, after);
}

// Pure fallback helpers: classify the current upstream credential-free YouTube block
// and choose a relevance-checked SoundCloud result without allowing remix/cover noise.
write('src/playback-fallback.js', `import { searchTrackScore, SEARCH_MATCH_THRESHOLD } from './search-quality.js';

export function youtubeTrackId(track) {
  const direct = String(track?.identifier || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
  const uri = String(track?.uri || track?.realUri || '');
  const match = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/) || uri.match(/youtu\\.be\\/([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

export function isCredentiallessYoutubeBlock(message) {
  const value = String(message || '');
  return /all clients failed to load the item|this video requires login|sign in to confirm you.?re not a bot|no supported audio streams available|video player configuration error/i.test(value);
}

function durationCompatible(failedTrack, candidate) {
  const failed = Number(failedTrack?.length || 0);
  const next = Number(candidate?.length || 0);
  if (!failed || !next) return true;
  if (failed >= 120_000 && next < 60_000) return false;
  return Math.abs(next - failed) <= Math.max(120_000, failed * 0.55);
}

function sameUri(a, b) {
  const left = String(a?.uri || a?.realUri || '').trim();
  const right = String(b?.uri || b?.realUri || '').trim();
  return Boolean(left && right && left === right);
}

export function choosePlaybackAlternative(query, tracks, failedTrack) {
  const failedId = youtubeTrackId(failedTrack);
  for (const candidate of Array.isArray(tracks) ? tracks : []) {
    if (!candidate || candidate?.isStream) continue;
    const candidateId = youtubeTrackId(candidate);
    if (!candidateId || (failedId && candidateId === failedId)) continue;
    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;
    if (!durationCompatible(failedTrack, candidate)) continue;
    return candidate;
  }
  return null;
}

export function chooseSoundCloudAlternative(query, tracks, failedTrack) {
  for (const candidate of Array.isArray(tracks) ? tracks : []) {
    if (!candidate || candidate?.isStream || sameUri(candidate, failedTrack)) continue;
    if (searchTrackScore(query, candidate) < SEARCH_MATCH_THRESHOLD) continue;
    if (!durationCompatible(failedTrack, candidate)) continue;
    return candidate;
  }
  return null;
}
`);

// Runtime fallback: for the known all-client/login failure, skip another doomed
// YouTube retry and resolve the same title through the already-enabled SoundCloud source.
{
  const path = 'src/music.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { choosePlaybackAlternative, youtubeTrackId } from './playback-fallback.js';`,
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, youtubeTrackId } from './playback-fallback.js';`,
    'music fallback imports',
  );
  text = replaceExact(
    text,
    `    const fingerprint = \`${'${failedId}'}:${'${title.toLowerCase()}'}\`;`,
    `    const fingerprint = \`youtube:${'${failedId}'}:${'${title.toLowerCase()}'}\`;`,
    'YouTube fallback fingerprint',
  );

  const marker = `  function clearEmptyVoiceTimer(guildId) {`;
  const soundcloud = `  async function trySoundCloudPlaybackFallback(player, failedTrack, message) {
    const guildId = player?.guildId;
    const failedId = youtubeTrackId(failedTrack);
    const title = String(failedTrack?.title || '').trim();
    if (!guildId || !failedId || !title || failedTrack?._ezPlaybackFallback) return false;
    if (playbackFallbackInFlight.has(guildId)) return false;

    const fingerprint = \`soundcloud:${'${failedId}'}:${'${title.toLowerCase()}'}\`;
    const previous = playbackFallbackAttempts.get(guildId);
    if (previous?.fingerprint === fingerprint && Date.now() - previous.at < PLAYBACK_FALLBACK_WINDOW_MS) return false;
    playbackFallbackAttempts.set(guildId, { fingerprint, at: Date.now() });
    playbackFallbackInFlight.add(guildId);

    try {
      const result = await player.search(title, { requester: failedTrack?.requester || client.user, source: 'scsearch:' });
      const alternative = chooseSoundCloudAlternative(title, result?.tracks, failedTrack);
      if (!alternative) return false;

      return await withGuildOperation(guildId, async () => {
        if (music.players.get(guildId) !== player || player.paused || player.shoukaku?.paused) return false;
        const currentId = youtubeTrackId(player.queue.current);
        if (currentId && currentId !== failedId) return false;
        try { alternative._ezPlaybackFallback = true; } catch { /* track may be sealed */ }
        console.warn(\`[playback-fallback] ${'${guildId}'}: YouTube unavailable for ${'${failedTrack.title}'}; using SoundCloud ${'${alternative.title}'} — ${'${alternative.author || "Unknown"}'} (${ '${String(message || "source error").slice(0, 100)}' })\`);
        await player.play(alternative, { replaceCurrent: true });
        checkpointRecovery(player);
        return true;
      });
    } catch (error) {
      console.warn('[playback-fallback] SoundCloud retry failed', error?.message || error);
      return false;
    } finally {
      playbackFallbackInFlight.delete(guildId);
    }
  }

`;
  if (!text.includes('async function trySoundCloudPlaybackFallback')) {
    text = replaceExact(text, marker, soundcloud + marker, 'SoundCloud fallback function');
  }

  const beforeHandler = `  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;
    const failedId = youtubeTrackId(failedTrack);
    console.warn('[player-exception]', player.guildId, message);
    void (async () => {
      if (await tryYoutubePlaybackFallback(player, failedTrack, message)) return;
      const currentId = youtubeTrackId(player.queue.current);
      const sameFailedItem = !failedId || !currentId || currentId === failedId;
      recordPlaybackFailure(player, message, { skipCurrent: sameFailedItem });
    })().catch((error) => {
      console.warn('[player-exception] fallback handler failed', error?.message || error);
      recordPlaybackFailure(player, message);
    });
  });`;
  const afterHandler = `  music.on('playerException', (player, data) => {
    const message = data?.exception?.message || data?.message || 'track exception';
    const failedTrack = player.queue.current || lastTracks.get(player.guildId) || null;
    const failedId = youtubeTrackId(failedTrack);
    console.warn('[player-exception]', player.guildId, message);
    void (async () => {
      const credentiallessBlock = isCredentiallessYoutubeBlock(message);
      if (credentiallessBlock) {
        if (await trySoundCloudPlaybackFallback(player, failedTrack, message)) return;
      } else {
        if (await tryYoutubePlaybackFallback(player, failedTrack, message)) return;
        if (await trySoundCloudPlaybackFallback(player, failedTrack, message)) return;
      }
      const currentId = youtubeTrackId(player.queue.current);
      const sameFailedItem = !failedId || !currentId || currentId === failedId;
      recordPlaybackFailure(player, message, { skipCurrent: sameFailedItem });
    })().catch((error) => {
      console.warn('[player-exception] fallback handler failed', error?.message || error);
      recordPlaybackFailure(player, message);
    });
  });`;
  text = replaceExact(text, beforeHandler, afterHandler, 'playerException source fallback order');
  write(path, text);
}

// Extra YouTube clients were proven useless by the live check, so keep the shorter
// recommended chain to avoid more failed client attempts before SoundCloud fallback.
{
  const path = 'lavalink/application.yml';
  let text = read(path);
  const before = `    # Keep the normal playback path identical to upstream's recommended example,
    # then add MWEB and ANDROID_MUSIC only as last-resort Opus-capable fallbacks.
    # They cost nothing once an earlier client succeeds. Regular ANDROID remains
    # excluded (frequently dysfunctional), IOS remains excluded (no Opus / extra
    # transcoding), and TVHTML5_SIMPLY stays excluded after prior sign-in/403 issues.
    clients:
      - MUSIC
      - ANDROID_VR
      - WEB
      - WEBEMBEDDED
      - MWEB
      - ANDROID_MUSIC`;
  const after = `    # Keep the upstream recommended short chain. Current YouTube login/SABR
    # blocking can still make all credential-free playback clients fail; EZ Music
    # handles that at runtime with a relevance-checked SoundCloud audio fallback
    # instead of adding OAuth, poToken services, transcoding, or more failed clients.
    clients:
      - MUSIC
      - ANDROID_VR
      - WEB
      - WEBEMBEDDED`;
  text = replaceExact(text, before, after, 'remove ineffective extra YouTube clients');
  write(path, text);
}

// Tests: restore the short client invariant and cover block classification + SoundCloud selection.
{
  const path = 'test/performance-v016.test.js';
  let text = read(path);
  text = text.replace(
    `['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED', 'MWEB', 'ANDROID_MUSIC']`,
    `['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']`,
  );
  write(path, text);
}

{
  const path = 'test/search-playback-v0110.test.js';
  let text = read(path);
  text = replaceExact(
    text,
    `import { choosePlaybackAlternative } from '../src/playback-fallback.js';`,
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock } from '../src/playback-fallback.js';`,
    'v0.1.10 fallback test imports',
  );
  text = replaceExact(
    text,
    `test('v0.1.10 keeps only Opus-capable extra clients and no heap/buffer increase', () => {
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');
  const section = app.split('  youtube:\\n')[1] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(clients.slice(0, 6), ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED', 'MWEB', 'ANDROID_MUSIC']);
  assert.ok(!clients.includes('IOS'));
  assert.ok(!clients.includes('ANDROID'));
  assert.ok(!clients.includes('TVHTML5_SIMPLY'));
  assert.match(app, /bufferDurationMs: 2000/);
  assert.match(app, /frameBufferDurationMs: 20000/);
  assert.match(app, /nonAllocatingFrameBuffer: true/);
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});`,
    `test('known credential-free YouTube failures are classified for source fallback', () => {
  assert.equal(isCredentiallessYoutubeBlock('All clients failed to load the item. Client [WEB] failed: This video requires login.'), true);
  assert.equal(isCredentiallessYoutubeBlock('No supported audio streams available, available types:'), true);
  assert.equal(isCredentiallessYoutubeBlock('Video player configuration error'), true);
  assert.equal(isCredentiallessYoutubeBlock('track stuck (10000 ms)'), false);
});

test('SoundCloud fallback accepts a relevant standard version and rejects remix noise', () => {
  const failed = track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I', 205_000);
  const candidates = [
    { title: 'NMIXX (엔믹스) “Heavy Serenade” (EDM REMIX)', author: 'Niterit', uri: 'https://soundcloud.com/remix', length: 210_000 },
    { title: 'NMIXX - Heavy Serenade', author: '求愛する', uri: 'https://soundcloud.com/tezjh7rwwjkl/nmixx-heavy-serenade', length: 205_000 },
  ];
  assert.equal(chooseSoundCloudAlternative(failed.title, candidates, failed)?.uri, 'https://soundcloud.com/tezjh7rwwjkl/nmixx-heavy-serenade');
});

test('v0.1.10 keeps the short YouTube chain and no heap/buffer increase', () => {
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');
  const section = app.split('  youtube:\\n')[1] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(clients.slice(0, 4), ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED']);
  assert.ok(!clients.includes('MWEB'));
  assert.ok(!clients.includes('ANDROID_MUSIC'));
  assert.ok(!clients.includes('IOS'));
  assert.ok(!clients.includes('ANDROID'));
  assert.ok(!clients.includes('TVHTML5_SIMPLY'));
  assert.match(app, /soundcloud:\s*true/);
  assert.match(app, /bufferDurationMs: 2000/);
  assert.match(app, /frameBufferDurationMs: 20000/);
  assert.match(app, /nonAllocatingFrameBuffer: true/);
  const start = fs.readFileSync(new URL('../start-bot.bat', import.meta.url), 'utf8');
  assert.match(start, /-Xmx256M/);
  assert.match(start, /--max-old-space-size=128/);
});`,
    'replace ineffective client test with SoundCloud fallback tests',
  );
  text = replaceExact(
    text,
    `  assert.match(handler, /tryYoutubePlaybackFallback/);
  assert.match(handler, /recordPlaybackFailure/);
  assert.ok(handler.indexOf('tryYoutubePlaybackFallback') < handler.indexOf('recordPlaybackFailure'));`,
    `  assert.match(handler, /tryYoutubePlaybackFallback/);
  assert.match(handler, /trySoundCloudPlaybackFallback/);
  assert.match(handler, /isCredentiallessYoutubeBlock/);
  assert.match(handler, /recordPlaybackFailure/);
  assert.ok(handler.indexOf('trySoundCloudPlaybackFallback') < handler.indexOf('recordPlaybackFailure'));`,
    'playerException fallback ordering test',
  );
  write(path, text);
}

// README: describe the tested source fallback rather than the ineffective extra clients.
{
  const path = 'README.md';
  let text = read(path);
  const before = `## Search/playback fallback reliability (v0.1.10)

Title-only searches that produce an exact but artist-ambiguous YouTube Music result now compare normal YouTube before choosing, preventing same-title uploads from unrelated channels from silently winning. If a chosen YouTube video still throws a playback exception, EZ Music makes one bounded normal-YouTube alternate-video attempt for the same title before the existing source-protection logic skips it. The normal youtube-source client chain is unchanged first; MWEB and ANDROID_MUSIC are appended only as Opus-capable last-resort playback clients. No OAuth, poToken worker, yt-dlp, DSP, heap increase, or extra process is introduced.
`;
  const after = `## Search/playback fallback reliability (v0.1.10)

Title-only searches that produce an exact but artist-ambiguous YouTube Music result now compare normal YouTube before choosing, preventing same-title uploads from unrelated channels from silently winning. Current youtube-source can still hit YouTube's credential/login/SABR block even for the correct video; when that known all-clients failure occurs, EZ Music now searches the already-enabled SoundCloud source for a relevance-checked standard version of the same title and replaces the failed YouTube item automatically. Other playback exceptions can still try one alternate normal-YouTube result before SoundCloud. The short upstream-recommended YouTube client chain is retained because live testing showed extra MWEB/ANDROID_MUSIC clients hit the same login block. No OAuth, poToken worker, yt-dlp, DSP, heap increase, or extra process is introduced.
`;
  text = replaceExact(text, before, after, 'README v0.1.10 source fallback note');
  write(path, text);
}
