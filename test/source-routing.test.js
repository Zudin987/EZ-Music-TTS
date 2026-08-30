import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifySpotifyInput, resolvePreferredSearch } from '../src/source-routing.js';

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

test('plain text routing uses YTM first and does not call YouTube when YTM succeeds', async () => {
  const target = fakeTarget(async (_query, options) => ({ tracks: options.source === 'ytmsearch:' ? [{ title: 'Rose' }] : [] }));
  const result = await resolvePreferredSearch(target, 'D.O Rose', { id: 'u1' });
  assert.equal(result.tracks[0].title, 'Rose');
  assert.deepEqual(target.calls.map((call) => call.options.source), ['ytmsearch:']);
});

test('YTM empty/error falls back once to normal YouTube', async () => {
  for (const ytmMode of ['empty', 'error']) {
    const target = fakeTarget(async (_query, options) => {
      if (options.source === 'ytmsearch:') {
        if (ytmMode === 'error') throw new Error('ytm unavailable');
        return { tracks: [] };
      }
      if (options.source === 'ytsearch:') return { tracks: [{ title: 'fallback' }] };
      throw new Error('unexpected route');
    });
    const result = await resolvePreferredSearch(target, 'D.O Rose', null);
    assert.equal(result.tracks[0].title, 'fallback');
    assert.deepEqual(target.calls.map((call) => call.options.source), ['ytmsearch:', 'ytsearch:']);
  }
});

test('direct URLs and explicit search prefixes are never rewritten', async () => {
  for (const query of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'ytsearch:D.O Rose', 'ytmsearch:D.O Rose', 'scsearch:D.O Rose']) {
    const target = fakeTarget(async () => ({ tracks: [{ title: 'direct' }] }));
    await resolvePreferredSearch(target, query, null);
    assert.equal(target.calls.length, 1);
    assert.equal(target.calls[0].query, query);
    assert.equal(target.calls[0].options.source, undefined);
  }
});

test('Spotify track/album/playlist references are strictly classified', () => {
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
});

test('unsupported or malformed Spotify objects are rejected before Lavalink', async () => {
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

test('Spotify short links and unconfigured Spotify fail clearly without search calls', async () => {
  const id = '4uLU6hMCjMI75M1A2tKUQC';
  const shortTarget = fakeTarget(async () => ({ tracks: [] }));
  await assert.rejects(() => resolvePreferredSearch(shortTarget, 'https://spotify.link/example', null, { spotifyConfigured: true }), /Spotify short links/);
  assert.equal(shortTarget.calls.length, 0);

  const target = fakeTarget(async () => ({ tracks: [] }));
  await assert.rejects(() => resolvePreferredSearch(target, `https://open.spotify.com/track/${id}`, null), /Spotify URL support is not configured/);
  assert.equal(target.calls.length, 0);
});

test('configured valid Spotify references are passed directly to LavaSrc once', async () => {
  const query = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc';
  const target = fakeTarget(async () => ({ type: 'TRACK', tracks: [{ title: 'Spotify mirrored' }] }));
  const result = await resolvePreferredSearch(target, query, { id: 'u1' }, { spotifyConfigured: true });
  assert.equal(result.tracks[0].title, 'Spotify mirrored');
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].query, query);
  assert.equal(target.calls[0].options.source, undefined);
});

test('Spotify remains optional and LavaSrc mirrors via YTM before YouTube', () => {
  assert.equal(pkg.version, '0.1.5');
  assert.match(envExample, /SPOTIFY_CLIENT_ID=/);
  assert.match(envExample, /SPOTIFY_CLIENT_SECRET=/);
  assert.match(config, /spotifyClientId/);
  assert.match(config, /spotifyClientSecret/);
  assert.match(lavalink, /lavasrc-plugin:4\.8\.3/);
  assert.match(lavalink, /spotify:\s*\$\{SPOTIFY_ENABLED:false\}/);
  const ytmProvider = lavalink.indexOf('ytmsearch:%QUERY%');
  const ytProvider = lavalink.indexOf('ytsearch:%QUERY%');
  assert.ok(ytmProvider >= 0 && ytProvider > ytmProvider, 'Spotify mirroring must prefer YTM before YouTube');
});

test('launcher passes Spotify secrets via child environment, not Java arguments', () => {
  assert.match(launcher, /SPOTIFY_CLIENT_ID/);
  assert.match(launcher, /SPOTIFY_CLIENT_SECRET/);
  assert.match(launcher, /SPOTIFY_ENABLED='true'/);
  assert.doesNotMatch(launcher, /-DSPOTIFY_CLIENT_SECRET|--plugins\.lavasrc\.spotify\.clientSecret/i);
});

test('new source support does not enable DSP or generic HTTP/local playback', () => {
  assert.match(lavalink, /http:\s*false/);
  assert.match(lavalink, /local:\s*false/);
  for (const filter of ['equalizer', 'karaoke', 'timescale', 'tremolo', 'vibrato', 'distortion', 'rotation', 'channelMix', 'lowPass']) {
    assert.match(lavalink, new RegExp(`${filter}:\\s*false`, 'i'));
  }
});
