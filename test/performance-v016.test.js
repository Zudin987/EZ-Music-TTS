import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyVoiceTransition, voiceTransportQuality } from '../src/performance.js';

const app = fs.readFileSync('lavalink/application.yml', 'utf8');
const launcher = fs.readFileSync('start-bot.bat', 'utf8');

test('empty voice policy pauses active playback and only resumes an automatic pause', () => {
  assert.equal(emptyVoiceTransition({ hasHuman: false, hasCurrentTrack: true, playing: true, paused: false, autoPaused: false }), 'pause');
  assert.equal(emptyVoiceTransition({ hasHuman: true, hasCurrentTrack: true, playing: false, paused: true, autoPaused: true }), 'resume');
  assert.equal(emptyVoiceTransition({ hasHuman: true, hasCurrentTrack: true, playing: false, paused: true, autoPaused: false }), 'none', 'manual pause must remain paused');
  assert.equal(emptyVoiceTransition({ hasHuman: false, hasCurrentTrack: false, playing: false, paused: false, autoPaused: false }), 'none');
});

test('voice transport quality is a bounded diagnostic heuristic', () => {
  assert.equal(voiceTransportQuality(24), 'Excellent');
  assert.equal(voiceTransportQuality(60), 'Good');
  assert.equal(voiceTransportQuality(120), 'Elevated');
  assert.equal(voiceTransportQuality(200), 'Poor');
  assert.equal(voiceTransportQuality(0), 'Measuring');
});

test('YouTube client chain is short, upstream-aligned and avoids non-Opus/restricted early fallbacks', () => {
  const normalized = app.replace(/\r\n/g, '\n');
  const section = normalized.split('  youtube:\n')[1]?.split('\nlogging:')[0] || '';
  const clients = [...section.matchAll(/^      - ([A-Z0-9_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(clients, ['MUSIC', 'ANDROID_VR', 'WEB', 'WEBEMBEDDED', 'MWEB', 'ANDROID_MUSIC']);
  assert.ok(!clients.includes('ANDROID'));
  assert.ok(!clients.includes('IOS'));
  assert.ok(!clients.includes('TVHTML5_SIMPLY'));
});

test('performance pass preserves low-memory and non-DSP limits', () => {
  assert.match(launcher, /-Xmx256M/);
  assert.match(launcher, /--max-old-space-size=128/);
  assert.match(app, /bufferDurationMs:\s*2000/);
  assert.match(app, /frameBufferDurationMs:\s*20000/);
  assert.match(app, /nonAllocatingFrameBuffer:\s*true/);
  assert.match(app, /equalizer:\s*false/);
  assert.match(app, /timescale:\s*false/);
  assert.match(app, /http:\s*false/);
  assert.match(app, /local:\s*false/);
});
