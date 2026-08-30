import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const music = fs.readFileSync('src/music.js', 'utf8');
const commands = fs.readFileSync('src/commands.js', 'utf8');
const config = fs.readFileSync('src/config.js', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');
const lavalink = fs.readFileSync('lavalink/application.yml', 'utf8');
const launcher = fs.readFileSync('start-bot.bat', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('plain text routing is YTM-first with normal YouTube fallback', () => {
  const ytm = music.indexOf("source: 'ytmsearch:'");
  const yt = music.indexOf("source: 'ytsearch:'");
  assert.ok(ytm >= 0, 'ytmsearch route missing');
  assert.ok(yt > ytm, 'ytsearch fallback must come after ytmsearch');
  assert.match(music, /isHttpUrl\(clean\) \|\| hasExplicitSearchPrefix\(clean\)/);
  assert.match(commands, /searchPreferred\(music, query, interaction\.user\)/);
  assert.match(commands, /searchAndQueue\([^\n]+searchPreferred/);
});

test('Spotify is optional, credential-gated, and mirrored YTM before YouTube', () => {
  assert.equal(pkg.version, '0.1.3');
  assert.match(envExample, /SPOTIFY_CLIENT_ID=/);
  assert.match(envExample, /SPOTIFY_CLIENT_SECRET=/);
  assert.match(config, /spotifyClientId/);
  assert.match(config, /spotifyClientSecret/);
  assert.match(lavalink, /lavasrc-plugin:4\.8\.3/);
  assert.match(lavalink, /spotify:\s*\$\{SPOTIFY_ENABLED:false\}/);
  const ytmProvider = lavalink.indexOf("ytmsearch:%QUERY%");
  const ytProvider = lavalink.indexOf("ytsearch:%QUERY%");
  assert.ok(ytmProvider >= 0 && ytProvider > ytmProvider, 'Spotify mirroring must prefer YTM before YouTube');
  assert.match(music, /Spotify URL support is not configured/);
  assert.match(music, /Spotify short links \(spotify\.link\) are not supported/);
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
