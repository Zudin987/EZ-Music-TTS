import fs from 'node:fs';

const path = 'test/source-routing.test.js';
let text = fs.readFileSync(path, 'utf8');

function replaceExact(before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing test expectation: ${label}`);
  text = text.replace(before, after);
}

replaceExact(
  `  assert.equal(target.calls.length, 1);\n  assert.equal(target.calls[0].query, 'Never Gonna Give You Up');\n  assert.equal(target.calls[0].options.source, 'ytmsearch:');`,
  `  assert.equal(target.calls.length, 2);\n  assert.equal(target.calls[0].query, 'Never Gonna Give You Up');\n  assert.equal(target.calls[0].options.source, 'ytmsearch:');\n  assert.equal(target.calls[1].query, 'Never Gonna Give You Up');\n  assert.equal(target.calls[1].options.source, 'ytsearch:');`,
  'unconfigured Spotify title ambiguity comparison',
);

replaceExact(
  `  assert.deepEqual(target.calls.map((call) => call.options.source), [undefined, 'ytmsearch:']);`,
  `  assert.deepEqual(target.calls.map((call) => call.options.source), [undefined, 'ytmsearch:', 'ytsearch:']);`,
  'configured Spotify fallback title ambiguity comparison',
);

replaceExact(
  `  assert.equal(pkg.version, '0.1.9');`,
  `  assert.equal(pkg.version, '0.1.10');`,
  'v0.1.10 version assertion',
);

fs.writeFileSync(path, text);
