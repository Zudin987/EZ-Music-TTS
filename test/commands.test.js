import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/commands.js', 'utf8');
const definitionBlock = source.match(/export const commandDefinitions = \[([\s\S]*?)\n\]\.map\(x => x\.toJSON\(\)\);/)?.[1] || '';
const commandNames = [...definitionBlock.matchAll(/new SlashCommandBuilder\(\)\.setName\('([^']+)'\)/g)].map((match) => match[1]);

const approved = [
  'play', 'playnext', 'pause', 'resume', 'skip', 'previous', 'stop', 'disconnect',
  'volume', 'nowplaying', 'clear', 'shuffle', 'loop', 'autoplay', 'radio', 'ai',
  'help', 'ping', 'status',
];

test('slash-command surface stays within the approved scope', () => {
  assert.ok(definitionBlock, 'could not locate command definition block');
  assert.deepEqual(commandNames, approved);
  const serialized = definitionBlock.toLowerCase();
  for (const forbidden of ['nightcore', 'karaoke', '8d', 'bassboost', 'equalizer', 'pitch', 'vaporwave']) {
    assert.equal(serialized.includes(forbidden), false, `unexpected audio-effect command: ${forbidden}`);
  }
  assert.equal(commandNames.includes('queue'), false);
});
