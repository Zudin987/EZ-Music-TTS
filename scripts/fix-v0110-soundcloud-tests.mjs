import fs from 'node:fs';

function edit(path, fn) {
  const before = fs.readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`No change made to ${path}`);
  fs.writeFileSync(path, after);
}

edit('src/playback-fallback.js', (text) => {
  const marker = `export function isCredentiallessYoutubeBlock(message) {`;
  const helper = `export function playbackFallbackQuery(track) {\n  return String(track?.title || '')\n    .replace(/\\bM\\s*\\/\\s*V\\b/gi, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();\n}\n\n`;
  if (!text.includes('export function playbackFallbackQuery')) {
    if (!text.includes(marker)) throw new Error('playback fallback helper marker missing');
    text = text.replace(marker, helper + marker);
  }
  return text;
});

edit('src/music.js', (text) => {
  text = text.replace(
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, youtubeTrackId } from './playback-fallback.js';`,
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, playbackFallbackQuery, youtubeTrackId } from './playback-fallback.js';`,
  );
  const oldLine = `    const title = String(failedTrack?.title || '').trim();`;
  const count = text.split(oldLine).length - 1;
  if (count !== 2) throw new Error(`Expected 2 fallback title lines, found ${count}`);
  return text.split(oldLine).join(`    const title = playbackFallbackQuery(failedTrack);`);
});

edit('test/search-playback-v0110.test.js', (text) => {
  text = text.replace(
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock } from '../src/playback-fallback.js';`,
    `import { choosePlaybackAlternative, chooseSoundCloudAlternative, isCredentiallessYoutubeBlock, playbackFallbackQuery } from '../src/playback-fallback.js';`,
  );
  text = text.replace(
    `chooseSoundCloudAlternative(failed.title, candidates, failed)?.uri`,
    `chooseSoundCloudAlternative(playbackFallbackQuery(failed), candidates, failed)?.uri`,
  );
  // Avoid nested-template escaping ambiguity for this simple config invariant.
  text = text.replace(/assert\.match\(app, \/soundcloud:[^\n]*\);/, `assert.ok(app.includes('soundcloud: true'));`);
  const insertion = `test('fallback query removes YouTube M/V presentation noise without lowering match threshold', () => {\n  const failed = track('NMIXX(엔믹스) “Heavy Serenade” M/V', 'JYP Entertainment and NMIXX', '6Ycn9qZK09I');\n  assert.equal(playbackFallbackQuery(failed), 'NMIXX(엔믹스) “Heavy Serenade”');\n});\n\n`;
  const marker = `test('known credential-free YouTube failures are classified for source fallback', () => {`;
  if (!text.includes('fallback query removes YouTube M/V presentation noise')) {
    if (!text.includes(marker)) throw new Error('fallback classification test marker missing');
    text = text.replace(marker, insertion + marker);
  }
  return text;
});
