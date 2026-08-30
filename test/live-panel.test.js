import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePanelRegistry } from '../src/live-panel.js';
import { readFileSync } from 'node:fs';

function fakeScheduler() {
  const state = { starts: 0, clears: 0, callback: null };
  return {
    state,
    setIntervalFn(callback) {
      state.starts += 1;
      state.callback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {
      state.clears += 1;
      state.callback = null;
    },
  };
}

function fakeInteraction(id, { guildId = 'guild', userId = 'user', createdTimestamp = 1_000, ephemeral = true } = {}) {
  const edits = [];
  return {
    id,
    guildId,
    user: { id: userId },
    createdTimestamp,
    ephemeral,
    edits,
    async editReply(payload) {
      edits.push(payload);
      return payload;
    },
  };
}

test('live registry keeps only the newest private panel per guild/user', async () => {
  let now = 1_000;
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    now: () => now,
    render: (interaction) => ({ content: interaction.id }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const first = fakeInteraction('first');
  const second = fakeInteraction('second');
  assert.equal(registry.track(first), true);
  assert.equal(registry.track(second), true);
  assert.equal(registry.size(), 1);
  assert.equal(scheduler.state.starts, 1);
  await registry.tick();
  assert.equal(first.edits.length, 0);
  assert.deepEqual(second.edits, [{ content: 'second' }]);
  registry.shutdown();
});

test('different users can each have one private live panel and maxEntries evicts oldest', () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    maxEntries: 2,
    render: () => ({ content: 'ok' }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const now = Date.now();
  const a = fakeInteraction('a', { userId: 'a', createdTimestamp: now });
  const b = fakeInteraction('b', { userId: 'b', createdTimestamp: now });
  const c = fakeInteraction('c', { userId: 'c', createdTimestamp: now });
  registry.track(a);
  registry.track(b);
  registry.track(c);
  assert.equal(registry.size(), 2);
  assert.equal(registry.has(a), false);
  assert.equal(registry.has(b), true);
  assert.equal(registry.has(c), true);
  registry.shutdown();
});

test('public live panels share one guild lease regardless of which user refreshes it', async () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    render: (interaction) => ({ content: interaction.id }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const a = fakeInteraction('public-a', { userId: 'a', ephemeral: false, createdTimestamp: Date.now() });
  const b = fakeInteraction('public-b', { userId: 'b', ephemeral: false, createdTimestamp: Date.now() });
  registry.track(a);
  registry.track(b);
  assert.equal(registry.size(), 1);
  await registry.tick();
  assert.equal(a.edits.length, 0);
  assert.deepEqual(b.edits, [{ content: 'public-b' }]);
  registry.shutdown();
});

test('expired lease gets one final retiring render then stops', async () => {
  let now = 10_000;
  const scheduler = fakeScheduler();
  const retiring = [];
  const interaction = fakeInteraction('lease', { createdTimestamp: now });
  const registry = createLivePanelRegistry({
    ttlMs: 100,
    now: () => now,
    render: (_interaction, state) => {
      retiring.push(state.retiring);
      return { content: state.retiring ? 'expired' : 'live' };
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  registry.track(interaction);
  await registry.tick();
  assert.deepEqual(retiring, [false]);
  now += 100;
  await registry.tick();
  assert.deepEqual(retiring, [false, true]);
  assert.deepEqual(interaction.edits, [{ content: 'live' }, { content: 'expired' }]);
  assert.equal(registry.size(), 0);
  assert.equal(scheduler.state.clears, 1);
});

test('render can stop a live panel after a final idle update', async () => {
  const scheduler = fakeScheduler();
  const interaction = fakeInteraction('idle', { createdTimestamp: Date.now() });
  const registry = createLivePanelRegistry({
    render: () => ({ payload: { content: 'idle' }, stopAfter: true }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  registry.track(interaction);
  await registry.tick();
  assert.deepEqual(interaction.edits, [{ content: 'idle' }]);
  assert.equal(registry.size(), 0);
});

test('pause immediately removes the matching live lease', () => {
  const scheduler = fakeScheduler();
  const interaction = fakeInteraction('pause', { createdTimestamp: Date.now() });
  const registry = createLivePanelRegistry({
    render: () => ({ content: 'ok' }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  registry.track(interaction);
  assert.equal(registry.pause(interaction), true);
  assert.equal(registry.size(), 0);
  assert.equal(scheduler.state.clears, 1);
});

test('commands wire /nowplaying and player-return buttons into live refresh', () => {
  const source = readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  assert.match(source, /createLivePanelRegistry/);
  assert.match(source, /await publicNowPlayingReply\(interaction, panelPayload\(player, interaction\.guildId\)\);\s*livePanels\.track\(interaction\)/);
  assert.match(source, /livePanels\.pause\(interaction\)/);
  assert.match(source, /return editLivePanel\(interaction, player\)/);
  assert.equal((source.match(/interaction\.editReply\(panelPayload\(/g) || []).length, 1);
  assert.match(source, /const result = await interaction\.editReply\(panelPayload\(currentPlayer, interaction\.guildId, notice\)\);/);
});
