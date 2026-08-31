import fs from 'node:fs';

function patch(path, before, after, label) {
  const text = fs.readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`Missing refinement target: ${label}`);
  fs.writeFileSync(path, text.replace(before, after));
}

patch(
  'test/search-choices-v0111.test.js',
  `assert.equal(pkg.version, '0.1.11');`,
  `assert.equal(pkg.version, '0.1.12');`,
  'v0.1.11 picker version assertion',
);

patch(
  'test/search-playback-v019.test.js',
  `return { title, author, identifier: \`${'${title}:${author}'}\`, length: 180_000 };`,
  `return { title, author, identifier: \`${'${title}:${author}'}\`, track: 'encoded-track', length: 180_000 };`,
  'legacy KazagumoTrack fixture Base64',
);
