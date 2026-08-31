import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolvePreferredSearch } from '../src/source-routing.js';
import { isAmbiguousTitleOnlyMatch } from '../src/search-quality.js';
import { choosePlaybackAlternative } from '../src/playback-fallback.js';

function track(title, author, identifier, length = 200_000) {
  return { title, author, identifier, uri: `https://www.youtube.com/watch?v=${identifier}`, length };
}

function target(ytm, yt) {
  const calls = [];
  return {
    calls,
    async search(query, options = {}) {
      calls.push(options.source);
      if (options.source === 'ytmsearch:') return { type: 'SEARCH', tracks: ytm };
      if (options.source === 'ytsearch:') return { type: 'SEARCH', tracks: yt };
      return { type: 'SEARCH', tracks: [] };
    },
  };
}

test('plain exact-title ambiguity compares normal YouTube and avoids unrelated uploader', async () => {
  const ytm = [track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000)];
  const yt = [track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I', 205_000)];
  const search = target(ytm, yt);
  const result = await resolvePreferredSearch(search, 'Heavy Serenade', { id: 'u' });
  assert.equal(result.tracks[0].identifier, '6Ycn9qZK09I');
  assert.deepEqual(search.calls, ['ytmsearch:', 'ytsearch:']);
});

test('artist-qualified good YTM result stays fast without unnecessary YouTube query', async () => {
  const ytm = [track('Heavy Serenade', 'NMIXX', 'aaaaaaaaaaa')];
  const search = target(ytm, [track('Heavy Serenade', 'Other', 'bbbbbbbbbbb')]);
  const result = await resolvePreferredSearch(search, 'NMIXX Heavy Serenade', { id: 'u' });
  assert.equal(result.tracks[0].identifier, 'aaaaaaaaaaa');
  assert.deepEqual(search.calls, ['ytmsearch:']);
});

test('ambiguous-title helper requires full title coverage and no artist signal', () => {
  assert.equal(isAmbiguousTitleOnlyMatch('Heavy Serenade', track('Heavy Serenade', 'Khmer woman', 'aaaaaaaaaaa')), true);
  assert.equal(isAmbiguousTitleOnlyMatch('NMIXX Heavy Serenade', track('Heavy Serenade', 'NMIXX', 'aaaaaaaaaaa')), false);
  assert.equal(isAmbiguousTitleOnlyMatch('D.O Rose', track('Rose', 'D.O', 'aaaaaaaaaaa')), false);
});

test('playback fallback keeps native YouTube order, skips failed id and variant uploader', () => {
  const failed = track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000);
  const candidates = [
    track('Heavy Serenade', 'Khmer woman', 'Cuzk8zVnzXQ', 211_000),
    track('Heavy Serenade', 'Shin Giwon Piano', 'pianopiano1', 205_000),
    track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I', 205_000),
  ];
  assert.equal(choosePlaybackAlternative('Heavy Serenade', candidates, failed)?.identifier, '6Ycn9qZK09I');
});

test('v0.1.10 keeps only Opus-capable extra clients and no heap/buffer increase', () => {
  const app = fs.readFileSync(new URL('../lavalink/application.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const section = app.split('  youtube:\n')[1] || '';
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
});

test('playerException attempts alternate video before normal source-protection skip', () => {
  const music = fs.readFileSync(new URL('../src/music.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const handler = music.split("music.on('playerException'")[1]?.split("music.on('playerResolveError'")[0] || '';
  assert.match(handler, /tryYoutubePlaybackFallback/);
  assert.match(handler, /recordPlaybackFailure/);
  assert.ok(handler.indexOf('tryYoutubePlaybackFallback') < handler.indexOf('recordPlaybackFailure'));
});
