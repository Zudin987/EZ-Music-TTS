import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const setup = fs.readFileSync('setup.bat', 'utf8');
const start = fs.readFileSync('start-bot.bat', 'utf8');

test('Windows setup enforces the supported Node baseline and Docker Compose v2', () => {
  assert.match(setup, /22\.9\.0/);
  assert.match(setup, /docker compose version/i);
});

test('Windows launcher waits for Lavalink readiness and prints logs on timeout', () => {
  assert.match(start, /Waiting for Lavalink to become ready/i);
  assert.match(start, /127\.0\.0\.1['"],2333|127\.0\.0\.1.*2333/i);
  assert.match(start, /docker compose logs --tail 80 lavalink/i);
  assert.match(start, /22\.9\.0/);
});
