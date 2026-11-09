import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSeminar } from '../src/seminars/runner.mjs';

// Shape taken from the first real seminar (Claude acceptance 2026-10-08): the model wrote citations into name fields.
const book = name => ({ id: name.toLowerCase(), kind: 'book', name, platforms: { codex: { available: true } } });
const record = { mode: 'auto', input: '为什么人很难改变习惯？', catalog: ['Corvo', 'Dirvo', 'Xiaomo', 'Walvo'].map(book) };
const value = () => ({
  selected: ['Corvo', 'Dirvo', 'Xiaomo'].map(agent => ({ agent, reason: '理由' })),
  perAgent: ['Corvo', 'Dirvo', 'Xiaomo'].map(agent => ({ agent, analysis: '分析', coverage: '直接' })),
  commonAnswer: { summary: '总结', points: [
    { text: '要点一', support: ['Corvo', 'Dirvo', 'Xiaomo'], strength: '全员一致' },
    { text: '要点二', support: ['Dirvo', 'Xiaomo（第13章）'], strength: '全员一致' },
  ] },
  divergences: [{ topic: '分歧', positions: [{ agent: 'Corvo', view: '甲' }, { agent: 'Dirvo：第9章', view: '乙' }] }],
  actions: [
    { text: '行动一', basis: ['Corvo：第二部第1章《认识习惯》', 'Dirvo：第9章“Design for Habits”'] },
    { text: '行动二', basis: ['Xiaomo'] },
    { text: '行动三', basis: ['Corvo', 'Dirvo'] },
  ],
  terms: [{ zh: '习惯', en: 'habit', fr: 'habitude' }],
});

test('v011 seminar name fields accept "name：citation", normalize to names, keep notes, recount strength', () => {
  const { result, strengthCorrected } = validateSeminar(value(), record);
  assert.deepEqual(result.actions[0].basis, ['Corvo', 'Dirvo']);
  assert.deepEqual(result.actions[0].notes, ['Corvo：第二部第1章《认识习惯》', 'Dirvo：第9章“Design for Habits”']);
  assert.equal(result.actions[1].notes, undefined);
  assert.deepEqual(result.commonAnswer.points[1].support, ['Dirvo', 'Xiaomo']);
  assert.equal(result.commonAnswer.points[1].strength, '多数同意'); assert.equal(strengthCorrected, true);
  assert.equal(result.divergences[0].positions[1].agent, 'Dirvo');
});

test('v011 seminar name fields still reject non-participants and duplicates', () => {
  for (const mutate of [
    v => { v.actions[1].basis = ['Walvo：第1章']; },
    v => { v.actions[1].basis = ['Xiaolaix']; },
    v => { v.actions[2].basis = ['Corvo', 'Corvo：第2章']; },
    v => { v.commonAnswer.points[0].support = ['Corvo', 'Dirvo', 'Stranger'];  },
  ]) {
    const v = value(); mutate(v);
    assert.throws(() => validateSeminar(v, record), /研讨 JSON 格式、名单或共识支持人数无效/);
  }
});

test('v011 seminar enrich gives participants and analyses book labels and avatar colours (also for saved records)', async () => {
  const { enrich } = await import('../src/seminars/index.mjs');
  const catalog = [{ id: 'corvo', kind: 'book', name: 'Corvo', platforms: { codex: { available: true } }, book: { title: '《示例的日常》' } }];
  const r = enrich({ catalog, result: { selected: [{ agent: 'Corvo', reason: 'x' }], perAgent: [{ agent: 'Corvo', analysis: 'y', coverage: '直接' }] } });
  for (const a of [r.result.selected[0], r.result.perAgent[0]]) {
    assert.equal(a.id, 'corvo'); assert.equal(a.bookLabel, '《示例的日常》'); assert.match(a.avatarColor, /^#[0-9a-f]{6}$/i);
  }
});
