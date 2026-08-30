import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('lavalink/application.yml', 'utf8');
const music = fs.readFileSync('src/music.js', 'utf8');
const commands = fs.readFileSync('src/commands.js', 'utf8');

test('single-server playback has expanded non-DSP buffering headroom', () => {
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /equalizer:\s*false/);
  assert.match(app, /timescale:\s*false/);
});

test('/status merges Shoukaku WebSocket frame stats and exposes frame starvation diagnostics', () => {
  assert.match(music, /music\.shoukaku\?\.nodes/);
  assert.match(music, /frameStats: liveStats\.frameStats/);
  assert.match(commands, /Audio stream:/);
  assert.match(commands, /Audio frames:/);
  assert.match(commands, /Frame starvation detected/);
  assert.match(commands, /Lavalink CPU:/);
});
