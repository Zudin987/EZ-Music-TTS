import fs from 'node:fs';

function patch(path, before, after, label) {
  const text = fs.readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`Missing test patch target: ${label}`);
  fs.writeFileSync(path, text.replace(before, after));
}

patch(
  'test/library-recovery.test.js',
  `test('search picker is opt-in and temporary', () => {\n  assert.match(commands, /setName\\('select'\\)/);\n  assert.match(searchPicker, /SEARCH_PICKER_TTL_MS = 120_000/);\n  assert.match(searchPicker, /SEARCH_PICKER_MAX = 32/);\n  assert.match(searchPicker, /tracks: Array\\.isArray\\(tracks\\) \\? tracks\\.slice\\(0, 5\\)/);\n  assert.match(searchPicker, /revision:/);\n  assert.match(commands, /isQueueRevisionCurrent\\(interaction\\.guildId, entry\\.revision\\)/);\n});`,
  `test('typed search picker is default, bounded, temporary, and revision-safe', () => {\n  assert.doesNotMatch(commands, /setName\\('select'\\)/);\n  assert.match(commands, /shouldOfferSearchChoices\\(query\\)/);\n  assert.match(commands, /resolveSearchChoices\\(music, query, interaction\\.user, \\{ limit: 3 \\}\\)/);\n  assert.match(searchPicker, /SEARCH_PICKER_TTL_MS = 120_000/);\n  assert.match(searchPicker, /SEARCH_PICKER_MAX = 32/);\n  assert.match(searchPicker, /tracks: Array\\.isArray\\(tracks\\) \\? tracks\\.slice\\(0, 3\\)/);\n  assert.match(searchPicker, /revision:/);\n  assert.match(commands, /isQueueRevisionCurrent\\(interaction\\.guildId, entry\\.revision\\)/);\n});`,
  'library picker behavior',
);

patch(
  'test/ui.test.js',
  `test('search picker is private-component friendly and bounded to five choices', () => {\n  const tracks = Array.from({ length: 8 }, (_, i) => fakeTrack(i + 1));\n  const payload = searchPickerPayload('abc123', tracks, 'play');\n  const json = JSON.stringify(payload.components.map((row) => row.toJSON()));\n  assert.match(json, /music:spick:abc123/);\n  assert.equal(payload.components[0].components[0].options.length, 5);\n});`,
  `test('search picker is private-component friendly and bounded to three choices', () => {\n  const tracks = Array.from({ length: 8 }, (_, i) => fakeTrack(i + 1));\n  const payload = searchPickerPayload('abc123', tracks, 'play', ['Lyrics', 'Music', 'M/V']);\n  const json = JSON.stringify(payload.components.map((row) => row.toJSON()));\n  assert.match(json, /music:spick:abc123/);\n  assert.equal(payload.components[0].components[0].options.length, 3);\n  assert.match(json, /\\[Lyrics\\]/);\n  assert.match(json, /\\[M\\/V\\]/);\n});`,
  'UI picker cap',
);

patch(
  'test/source-routing.test.js',
  `assert.equal(pkg.version, '0.1.10');`,
  `assert.equal(pkg.version, '0.1.11');`,
  'source-routing version',
);
