import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLivePanelRegistry } from '../src/live-panel.js';

function fakeScheduler() {
  let nextId = 1;
  const active = new Map();
  let starts = 0;
  let clears = 0;
  return {
    setIntervalFn(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, ms });
      starts += 1;
      return id;
    },
    clearIntervalFn(id) {
      if (active.delete(id)) clears += 1;
    },
    async tick() {
      for (const { fn } of [...active.values()]) await fn();
    },
    state: {
      get starts() { return starts; },
      get clears() { return clears; },
      get active() { return active.size; },
    },
  };
}

function fakeInteraction(guildId, userId = 'user-1', createdTimestamp = Date.now()) {
  let edits = 0;
  return {
    guildId,
    user: { id: userId },
    createdTimestamp,
    webhook: {
      async editMessage() { edits += 1; },
    },
    get edits() { return edits; },
  };
}

test('live registry keeps only the newest private panel per guild/user', async () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    render: async () => ({ payload: { content: 'ok' } }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const first = fakeInteraction('g1', 'u1');
  const second = fakeInteraction('g1', 'u1');
  registry.track(first);
  registry.track(second);
  assert.equal(registry.size(), 1);
  assert.equal(scheduler.state.starts, 1);
  assert.equal(scheduler.state.active, 1);
  await scheduler.tick();
  assert.equal(first.edits, 0);
  assert.equal(second.edits, 1);
});

test('different users can each have one private live panel and maxEntries evicts oldest', async () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    maxEntries: 2,
    render: async () => ({ payload: { content: 'ok' } }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const first = fakeInteraction('g1', 'u1');
  const second = fakeInteraction('g1', 'u2');
  const third = fakeInteraction('g2', 'u3');
  registry.track(first);
  registry.track(second);
  registry.track(third);
  assert.equal(registry.size(), 2);
  await scheduler.tick();
  assert.equal(first.edits, 0);
  assert.equal(second.edits, 1);
  assert.equal(third.edits, 1);
});

test('public live panels share one guild lease regardless of which user refreshes it', async () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    render: async () => ({ payload: { content: 'ok' } }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const first = fakeInteraction('g1', 'u1');
  const second = fakeInteraction('g1', 'u2');
  registry.track(first, { visibility: 'public' });
  registry.track(second, { visibility: 'public' });
  assert.equal(registry.size(), 1);
  await scheduler.tick();
  assert.equal(first.edits, 0);
  assert.equal(second.edits, 1);
});

test('expired lease gets one final retiring render then stops', async () => {
  const scheduler = fakeScheduler();
  let now = 1000;
  const renderStates = [];
  const registry = createLivePanelRegistry({
    intervalMs: 100,
    maxAgeMs: 500,
    now: () => now,
    render: async (_interaction, state) => {
      renderStates.push(state);
      return { payload: { content: state.retiring ? 'retiring' : 'live' } };
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const interaction = fakeInteraction('g1', 'u1');
  registry.track(interaction);
  now = 1600;
  await scheduler.tick();
  assert.equal(interaction.edits, 1);
  assert.equal(renderStates[0].retiring, true);
  assert.equal(registry.size(), 0);
  assert.equal(scheduler.state.active, 0);
});

test('render can stop a live panel after a final idle update', async () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    render: async () => ({ payload: { content: 'idle' }, stopAfter: true }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const interaction = fakeInteraction('g1', 'u1');
  registry.track(interaction);
  await scheduler.tick();
  assert.equal(interaction.edits, 1);
  assert.equal(registry.size(), 0);
  assert.equal(scheduler.state.active, 0);
});

test('pause immediately removes the matching live lease', () => {
  const scheduler = fakeScheduler();
  const registry = createLivePanelRegistry({
    render: async () => ({ payload: { content: 'ok' } }),
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });
  const interaction = fakeInteraction('g1', 'u1');
  registry.track(interaction);
  assert.equal(registry.pause(interaction), true);
  assert.equal(registry.size(), 0);
  assert.equal(scheduler.state.clears, 1);
});

test('commands wire /nowplaying and player-return buttons into live refresh', () => {
  const source = readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
  assert.match(source, /createLivePanelRegistry/);
  assert.match(source, /await publicNowPlayingReply\(interaction, panelPayload\(player, interaction\.guildId, notice\)\);\s*if \(player\.queue\.current \|\| player\.queue\.length > 0\) livePanels\.track\(interaction\)/);
  assert.match(source, /if \(!currentPlayer\?\.queue\?\.current && !Number\(currentPlayer\?\.queue\?\.length \|\| 0\)\)/);
  assert.match(source, /livePanels\.pause\(interaction\)/);
  assert.match(source, /return editLivePanel\(interaction, player\)/);
  assert.equal((source.match(/interaction\.editReply\(panelPayload\(/g) || []).length, 1);
  assert.match(source, /const result = await interaction\.editReply\(panelPayload\(currentPlayer, interaction\.guildId, notice\)\);/);
});