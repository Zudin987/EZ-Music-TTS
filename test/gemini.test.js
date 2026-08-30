import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiPlan } from '../src/gemini.js';

test('Gemini plan parser tolerates fenced JSON and removes duplicate queries', () => {
  const plan = parseGeminiPlan('```json\n{"summary":"  Chill set  ","queries":["Artist - Song","artist - song","Other - Track"]}\n```', 10);
  assert.equal(plan.summary, 'Chill set');
  assert.deepEqual(plan.queries, ['Artist - Song', 'Other - Track']);
});

test('Gemini plan parser enforces the requested maximum', () => {
  const raw = JSON.stringify({ summary: 'x', queries: Array.from({ length: 10 }, (_, i) => `Artist - Song ${i}`) });
  assert.equal(parseGeminiPlan(raw, 3).queries.length, 3);
});

test('Gemini plan parser rejects unusable output', () => {
  assert.throws(() => parseGeminiPlan('{"summary":"x","queries":[]}'), /no usable/i);
  assert.throws(() => parseGeminiPlan('not json'), /invalid recommendation/i);
});
