import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSearchPickerRegistry } from '../src/search-picker.js';
import { createShutdownCoordinator } from '../src/shutdown.js';

test('search picker becomes stale after queue revision changes', () => {
  let now = 1_000;
  const registry = createSearchPickerRegistry({ now: () => now, tokenFactory: () => 'picker-token' });
  const token = registry.create({ guildId: 'g', userId: 'u', tracks: [{ title: 'A' }], revision: 7 });
  const entry = registry.getOwned({ guildId: 'g', userId: 'u', token });
  assert.equal(registry.isCurrent(entry, 7), true);
  assert.equal(registry.isCurrent(entry, 8), false);
  now += 121_000;
  assert.equal(registry.getOwned({ guildId: 'g', userId: 'u', token }), null);
});

test('shutdown coordinator runs cleanup once and every caller waits for the same promise', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = createShutdownCoordinator(async () => { calls += 1; await gate; return 'done'; });
  const first = coordinator.run('SIGTERM');
  const second = coordinator.run('stop-requested');
  assert.strictEqual(first, second);
  assert.equal(coordinator.isRunning(), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await second, 'done');
  assert.equal(calls, 1);
});

test('stale picker guard is evaluated before ensurePlayer can reconnect', () => {
  const commands = fs.readFileSync('src/commands.js', 'utf8');
  const handler = commands.match(/async function handleSearchSelect[\s\S]*?\r?\n}\r?\n/)?.[0] || '';
  const staleCheck = handler.indexOf('isQueueRevisionCurrent(interaction.guildId, entry.revision)');
  const ensure = handler.indexOf('await ensurePlayer(interaction)');
  assert.ok(staleCheck >= 0 && ensure >= 0 && staleCheck < ensure);
  assert.match(handler, /music\.players\.get\(interaction\.guildId\) !== player/);
});

test('production and CI use the same low-memory Lavalink heap and locked npm install', () => {
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const setup = fs.readFileSync('setup.bat', 'utf8');
  const start = fs.readFileSync('start-bot.bat', 'utf8');
  assert.match(ci, /java -Xms64M -Xmx256M -jar Lavalink\.jar/);
  assert.match(ci, /- run: npm ci/);
  assert.match(setup, /call npm ci/);
  assert.match(start, /call npm ci/);
  assert.match(start, /-Dezmusic\.instance=/);
});

test('bundled Lavalink connection has one fixed source of truth', () => {
  const config = fs.readFileSync('src/config.js', 'utf8');
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.doesNotMatch(config, /process\.env\.LAVALINK_/);
  assert.doesNotMatch(env, /^LAVALINK_(?:URL|PASSWORD|SECURE)=/m);
  assert.match(config, /lavalinkUrl: 'localhost:2333'/);
  assert.match(config, /lavalinkPassword: 'ezmusic-local-only'/);
});
