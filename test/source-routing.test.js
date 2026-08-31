import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifySpotifyInput, fetchSpotifyOEmbed, resolvePreferredSearch } from '../src/source-routing.js';

const config = fs.readFileSync('src/config.js', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');
const launcher = fs.readFileSync('start-bot.bat', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function fakeTarget(handler) {
  const calls = [];
  return {
    calls,
    async search(query, options = {}) {
      calls.push({ query, options });
      return handler(query, options, calls.length);
    },
  };
}

function fakeOEmbed({ title = 'Never Gonna Give You Up', type = 'track', id = '4uLU6hMCjMI75M1A2tKUQC', status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          provider_name: 'Spotify',
          title,
          html: `<iframe src="https://open.spotify.com/embed/${type}/${id}?utm_source=oembed"></iframe>`,
        });
      },
    };
  };
  return { calls, fetchImpl };
}

test('plain text routing uses YTM first and skips YouTube when YTM succeeds', async () => {
  const target = fakeTarget(async (_query, options) => ({ tracks: options.source === 'ytmsearch:' ? [{ title: 'Rose', author: 'D.O' }] : [] }));
  const result = await resolvePreferredSearch(target, 'D.O Rose', { id: 'u1' });
  assert.equal(result.tracks[0].title, 'Rose');
  assert.deepEqual(target.calls.map((call) => call.options.source), ['ytmsearch:']);
});

test('YTM empty/error falls back once to YouTube search', async () => {
  for (const mode of ['empty', 'error']) {
    const target = fakeTarget(async (_query, options) => {
      if (options.source === 'ytmsearch:') {
        if (mode === 'error') throw new Error('ytm unavailable');
        return { tracks: [] };
      }
      if (options.source === 'ytsearch:') return { tracks: [{ title: 'D.O - Rose', author: 'D.O' }] };
      throw new Error('unexpected route');
    });
    const result = await resolvePreferredSearch(target, 'D.O Rose', null);
    assert.equal(result.tracks[0].title, 'D.O - Rose');
    assert.deepEqual(target.calls.map((call) => call.options.source), ['ytmsearch:', 'ytsearch:']);
  }
});

test('direct non-Spotify URLs and explicit search prefixes are not rewritten', async () => {
  for (const query of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'ytsearch:D.O Rose', 'ytmsearch:D.O Rose', 'scsearch:D.O Rose']) {
    const target = fakeTarget(async () => ({ tracks: [{ title: 'direct' }] }));
    await resolvePreferredSearch(target, query, null);
    assert.equal(target.calls.length, 1);
    assert.equal(target.calls[0].query, query);
    assert.equal(target.calls[0].options.source, undefined);
  }
});

test('Spotify track/album/playlist references and short links are classified', () => {
  const id = '4uLU6hMCjMI75M1A2tKUQC';
  for (const value of [
    `https://open.spotify.com/track/${id}?si=abc`,
    `https://open.spotify.com/album/${id}`,
    `https://open.spotify.com/playlist/${id}/`,
    `https://open.spotify.com/intl-de/track/${id}`,
    `spotify:track:${id}`,
    `spotify:album:${id}`,
    `spotify:playlist:${id}`,
  ]) {
    const info = classifySpotifyInput(value);
    assert.equal(info.spotify, true, value);
    assert.equal(info.supported, true, value);
    assert.ok(['track', 'album', 'playlist'].includes(info.type), value);
  }
  const short = classifySpotifyInput('https://spotify.link/example');
  assert.equal(short.spotify, true);
  assert.equal(short.supported, true);
  assert.equal(short.short, true);
  assert.equal(short.type, null);
});

test('unsupported/malformed Spotify objects are rejected before Lavalink', async () => {
  const id = '4uLU6hMCjMI75M1A2tKUQC';
  for (const query of [
    `https://open.spotify.com/artist/${id}`,
    `https://open.spotify.com/episode/${id}`,
    `https://open.spotify.com/show/${id}`,
    'https://open.spotify.com/track/not-a-valid-id',
    `https://open.spotify.com/track/${id}/extra`,
    `spotify:artist:${id}`,
    'spotify:track:bad',
  ]) {
    const target = fakeTarget(async () => ({ tracks: [] }));
    await assert.rejects(() => resolvePreferredSearch(target, query, null, { spotifyConfigured: true }), /Unsupported Spotify|Malformed Spotify/);
    assert.equal(target.calls.length, 0, query);
  }
});

test('unconfigured Spotify track uses oEmbed metadata then YTM', async () => {
  const oembed = fakeOEmbed();
  const target = fakeTarget(async (query, options) => ({ tracks: options.source === 'ytmsearch:' ? [{ title: query }] : [] }));
  const result = await resolvePreferredSearch(
    target,
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
    { id: 'u1' },
    { spotifyOEmbedOptions: { fetchImpl: oembed.fetchImpl, timeoutMs: 0 } },
  );
  assert.equal(result.tracks[0].title, 'Never Gonna Give You Up');
  assert.equal(oembed.calls.length, 1);
  assert.equal(target.calls.length, 2);
  assert.equal(target.calls[0].query, 'Never Gonna Give You Up');
  assert.equal(target.calls[0].options.source, 'ytmsearch:');
  assert.equal(target.calls[1].query, 'Never Gonna Give You Up');
  assert.equal(target.calls[1].options.source, 'ytsearch:');
});

test('configured Spotify track uses LavaSrc directly when it works', async () => {
  const oembed = fakeOEmbed();
  const target = fakeTarget(async () => ({ type: 'TRACK', tracks: [{ title: 'Spotify mirrored' }] }));
  const result = await resolvePreferredSearch(
    target,
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
    { id: 'u1' },
    { spotifyConfigured: true, spotifyOEmbedOptions: { fetchImpl: oembed.fetchImpl, timeoutMs: 0 } },
  );
  assert.equal(result.tracks[0].title, 'Spotify mirrored');
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].query, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(oembed.calls.length, 0);
});

test('configured but unusable Spotify track automatically falls back through oEmbed', async () => {
  const oembed = fakeOEmbed();
  const target = fakeTarget(async (_query, options, callNumber) => {
    if (callNumber === 1) throw new Error('Spotify API unavailable');
    if (options.source === 'ytmsearch:') return { tracks: [{ title: 'Never Gonna Give You Up', author: 'Rick Astley' }] };
    return { tracks: [] };
  });
  const result = await resolvePreferredSearch(
    target,
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    { id: 'u1' },
    { spotifyConfigured: true, spotifyOEmbedOptions: { fetchImpl: oembed.fetchImpl, timeoutMs: 0 } },
  );
  assert.equal(result.tracks[0].title, 'Never Gonna Give You Up');
  assert.equal(oembed.calls.length, 1);
  assert.deepEqual(target.calls.map((call) => call.options.source), [undefined, 'ytmsearch:', 'ytsearch:']);
});

test('Spotify short track link resolves to a canonical URL before configured LavaSrc', async () => {
  const oembed = fakeOEmbed();
  const target = fakeTarget(async (query) => ({ tracks: [{ title: query }] }));
  await resolvePreferredSearch(
    target,
    'https://spotify.link/example',
    null,
    { spotifyConfigured: true, spotifyOEmbedOptions: { fetchImpl: oembed.fetchImpl, timeoutMs: 0 } },
  );
  assert.equal(oembed.calls.length, 1);
  assert.equal(target.calls[0].query, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
});

test('album/playlist without working credentials fail clearly; oEmbed is not treated as a tracklist', async () => {
  const target = fakeTarget(async () => ({ tracks: [] }));
  for (const type of ['album', 'playlist']) {
    await assert.rejects(
      () => resolvePreferredSearch(target, `https://open.spotify.com/${type}/4uLU6hMCjMI75M1A2tKUQC`, null),
      /album\/playlist links require working/,
    );
  }
  assert.equal(target.calls.length, 0);
});

test('oEmbed response is size-bounded before body parsing', async () => {
  const hugeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(70 * 1024) },
    async text() { return '{}'; },
  });
  await assert.rejects(
    () => fetchSpotifyOEmbed('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', { fetchImpl: hugeFetch, timeoutMs: 0 }),
    /unexpectedly large/,
  );
});

test('Spotify remains optional and LavaSrc provider order stays YTM before YouTube', () => {
  assert.equal(pkg.version, '0.1.10');
  assert.match(envExample, /Single Spotify track links work without these credentials/i);
  assert.match(config, /spotifyClientId/);
  assert.match(config, /spotifyClientSecret/);
  assert.match(lavalink, /lavasrc-plugin:4\.8\.3/);
  assert.match(lavalink, /spotify:\s*\$\{SPOTIFY_ENABLED:false\}/);
  const ytmProvider = lavalink.indexOf('ytmsearch:%QUERY%');
  const ytProvider = lavalink.indexOf('ytsearch:%QUERY%');
  assert.ok(ytmProvider >= 0 && ytProvider > ytmProvider, 'Spotify mirroring must prefer YTM before YouTube');
});

test('launcher passes Spotify secrets through child environment, not Java arguments', () => {
  assert.match(launcher, /SPOTIFY_CLIENT_ID/);
  assert.match(launcher, /SPOTIFY_CLIENT_SECRET/);
  assert.match(launcher, /SPOTIFY_ENABLED='true'/);
  assert.doesNotMatch(launcher, /-DSPOTIFY_CLIENT_SECRET|--plugins\.lavasrc\.spotify\.clientSecret/i);
});

test('playback audit preserves low-RAM/raw-audio invariants and enables GC warnings', () => {
  assert.match(lavalink, /http:\s*false/);
  assert.match(lavalink, /local:\s*false/);
  assert.match(lavalink, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(lavalink, /bufferDurationMs:\s*2000/);
  assert.match(lavalink, /frameBufferDurationMs:\s*20000/);
  assert.match(lavalink, /gc-warnings:\s*true/);
  for (const filter of ['equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass']) {
    assert.match(lavalink, new RegExp(`${filter}:\\s*false`, 'i'));
  }
});