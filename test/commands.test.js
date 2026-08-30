import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDefinitions } from '../src/commands.js';

const approved = [
  'play', 'playnext', 'pause', 'resume', 'skip', 'previous', 'stop', 'disconnect',
  'volume', 'nowplaying', 'clear', 'shuffle', 'loop', 'autoplay', 'radio', 'ai',
  'help', 'ping', 'status',
];

test('slash-command surface stays within the approved scope', () => {
  assert.deepEqual(commandDefinitions.map((command) => command.name), approved);
  const serialized = JSON.stringify(commandDefinitions).toLowerCase();
  for (const forbidden of ['nightcore', 'karaoke', '8d', 'bassboost', 'equalizer', 'pitch', 'vaporwave']) {
    assert.equal(serialized.includes(forbidden), false, `unexpected audio-effect command: ${forbidden}`);
  }
  assert.equal(commandDefinitions.some((command) => command.name === 'queue'), false);
});
