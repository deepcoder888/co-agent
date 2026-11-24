import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSeminar, normalizeQuote } from '../src/seminars/runner.mjs';

// Shape taken from the first real seminar (Claude acceptance 2026-10-08): the model wrote citations into name fields.
const book = name => ({ id: name.toLowerCase(), kind: 'book', name, platforms: { codex: { available: true } } });
const record = { mode: 'auto', input: '为什么人很难改变习惯？', catalog: ['Corvo', 'Dirvo', 'Xiaomo', 'Walvo'].map(book) };
// v0.53.12: every attribution quotes a sentence of that author's own analysis.
const analyses = {
  Corvo: '第二部第1章：习惯是环境线索触发的自动反应。\n\nINFERENCE：**改变线索**比依靠意志更可靠。',
  Dirvo: '第9章 Design for Habits 指出，小步骤让新行为更容易开始。',
  Xiaomo: '第13章：人在压力下会退回旧习惯，因此需要提前设计好替代行为。',
};
const quote = { Corvo: '习惯是环境线索触发的自动反应', Dirvo: '小步骤让新行为更容易开始', Xiaomo: '人在压力下会退回旧习惯' };
const cite = agent => ({ agent, quote: quote[agent.split(/[：:（( ，,·]/)[0]] });
const value = () => ({
  selected: ['Corvo', 'Dirvo', 'Xiaomo'].map(agent => ({ agent, reason: '理由' })),
  perAgent: ['Corvo', 'Dirvo', 'Xiaomo'].map(agent => ({ agent, analysis: analyses[agent], coverage: '直接' })),
  commonAnswer: { summary: '总结', points: [
    { text: '要点一', support: ['Corvo', 'Dirvo', 'Xiaomo'].map(cite), strength: '全员一致' },
    { text: '要点二', support: ['Dirvo', 'Xiaomo（第13章）'].map(cite), strength: '全员一致' },
  ] },
  divergences: [{ topic: '分歧', positions: [{ agent: 'Corvo', view: '甲', quote: quote.Corvo }, { agent: 'Dirvo：第9章', view: '乙', quote: quote.Dirvo }] }],
  actions: [
    { text: '行动一', basis: ['Corvo：第二部第1章《认识习惯》', 'Dirvo：第9章“Design for Habits”'].map(cite) },
    { text: '行动二', basis: ['Xiaomo'].map(cite) },
    { text: '行动三', basis: ['Corvo', 'Dirvo'].map(cite) },
  ],
  terms: [{ zh: '习惯', en: 'habit', fr: 'habitude' }],
});

test('v011 seminar name fields accept "name：citation", normalize to names, keep notes, recount strength', () => {
  const { result, strengthCorrected } = validateSeminar(value(), record);
  assert.deepEqual(result.actions[0].basis, ['Corvo', 'Dirvo']);
  assert.deepEqual(result.actions[0].notes, ['Corvo：第二部第1章《认识习惯》', 'Dirvo：第9章“Design for Habits”']);
  assert.equal(result.actions[1].notes, undefined);
  assert.deepEqual(result.commonAnswer.points[1].support, ['Dirvo', 'Xiaomo']);
  assert.deepEqual(result.commonAnswer.points[1].notes, ['Xiaomo：第13章']);
  assert.equal(result.commonAnswer.points[1].strength, '多数同意'); assert.equal(strengthCorrected, true);
  assert.equal(result.divergences[0].positions[1].agent, 'Dirvo');
});

test('v011 seminar name fields still reject non-participants and duplicates', () => {
  for (const mutate of [
    v => { v.actions[1].basis = [{ agent: 'Walvo：第1章', quote: quote.Corvo }]; },
    v => { v.actions[1].basis = [{ agent: 'Xiaolaix', quote: quote.Corvo }]; },
    v => { v.actions[2].basis = ['Corvo', 'Corvo：第2章'].map(cite); },
    v => { v.commonAnswer.points[0].support = [...['Corvo', 'Dirvo'].map(cite), { agent: 'Stranger', quote: quote.Corvo }]; },
    v => { v.commonAnswer.points[0].support = ['Corvo', 'Dirvo', 'Xiaomo']; },
    v => { v.actions[0].basis = ['Corvo']; },
    v => { delete v.divergences[0].positions[0].quote; },
  ]) {
    const v = value(); mutate(v);
    assert.throws(() => validateSeminar(v, record), /研讨 JSON 格式、名单或共识支持人数无效/);
  }
});

test('v0.53.12 原文回查: verbatim quotes are verified, with evidence in support order and a source check', () => {
  const { result } = validateSeminar(value(), record);
  assert.deepEqual(result.commonAnswer.points[0].evidence, ['Corvo', 'Dirvo', 'Xiaomo'].map(agent => ({ agent, quote: quote[agent], verified: true })));
  assert.deepEqual(result.commonAnswer.points[1].evidence.map(e => e.agent), result.commonAnswer.points[1].support);
  assert.deepEqual(result.actions[0].evidence.map(e => [e.agent, e.verified]), [['Corvo', true], ['Dirvo', true]]);
  assert.deepEqual(result.divergences[0].positions[1], { agent: 'Dirvo', view: '乙', quote: quote.Dirvo, verified: true });
  // 3 + 2 support quotes, 2 positions, 2 + 1 + 2 basis quotes.
  assert.deepEqual(result.sourceCheck, { total: 12, unverified: 0 });
});

test('v0.53.12 原文回查: full/half-width punctuation, whitespace, quote marks and Markdown stars still match', () => {
  const v = value();
  // Corvo's analysis has "**改变线索**比依靠意志更可靠。"; Dirvo's has "Design for Habits 指出，".
  v.commonAnswer.points[0].support[0].quote = '“改变线索比依靠意志更可靠.”';
  v.actions[2].basis[1].quote = 'design for habits指出, 小步骤让新行为';
  v.divergences[0].positions[0].quote = '第二部第1章:习惯是环境线索';
  const { result } = validateSeminar(v, record);
  assert.equal(result.commonAnswer.points[0].evidence[0].verified, true);
  assert.equal(result.actions[2].evidence[1].verified, true);
  assert.equal(result.divergences[0].positions[0].verified, true);
  assert.deepEqual(result.sourceCheck, { total: 12, unverified: 0 });
});

test('v0.53.12 原文回查: a quote missing from that author\'s analysis is marked, not rejected', () => {
  const v = value();
  v.commonAnswer.points[0].support[1].quote = quote.Xiaomo;          // another author's sentence is not Dirvo's
  v.actions[1].basis[0].quote = '这句话不在任何人的分析里出现';
  v.divergences[0].positions[1].quote = '小步骤让旧行为更容易开始';     // reworded
  const { result } = validateSeminar(v, record);
  assert.deepEqual(result.commonAnswer.points[0].support, ['Corvo', 'Dirvo', 'Xiaomo']);
  assert.deepEqual(result.commonAnswer.points[0].evidence.map(e => e.verified), [true, false, true]);
  assert.deepEqual(result.actions[1].basis, ['Xiaomo']); assert.equal(result.actions[1].evidence[0].verified, false);
  assert.equal(result.divergences[0].positions[1].verified, false); assert.equal(result.divergences[0].positions[1].agent, 'Dirvo');
  assert.deepEqual(result.sourceCheck, { total: 12, unverified: 3 });
  const none = value();
  for (const p of none.commonAnswer.points) for (const s of p.support) s.quote = '完全找不到的一句引文';
  for (const a of none.actions) for (const b of a.basis) b.quote = '完全找不到的一句引文';
  for (const p of none.divergences[0].positions) p.quote = '完全找不到的一句引文';
  assert.deepEqual(validateSeminar(none, record).result.sourceCheck, { total: 12, unverified: 12 });
});

test('v0.53.12 原文回查: a quote that is empty, not a string, under 8 or over 120 characters is invalid JSON', () => {
  for (const q of ['', '   ', null, 7, '一二三四五六七', '「一二三四五六七」', '字'.repeat(121)]) {
    for (const mutate of [v => { v.commonAnswer.points[0].support[0].quote = q; }, v => { v.actions[0].basis[0].quote = q; }, v => { v.divergences[0].positions[0].quote = q; }]) {
      const v = value(); mutate(v);
      assert.throws(() => validateSeminar(v, record), /研讨 JSON 格式、名单或共识支持人数无效/, String(q));
    }
  }
  const edges = value(); edges.commonAnswer.points[0].support[0].quote = '一二三四五六七八'; edges.actions[0].basis[0].quote = '字'.repeat(120);
  const { result } = validateSeminar(edges, record);
  assert.equal(result.commonAnswer.points[0].evidence[0].verified, false); assert.equal(result.actions[0].evidence[0].verified, false);
});

test('v0.53.12 normalizeQuote removes whitespace, quote marks, dashes and Markdown, unifies punctuation and case', () => {
  assert.equal(normalizeQuote(' 甲，乙。丙；丁：戊！己？(庚)（辛）、壬… '), '甲,乙.丙;丁:戊!己?(庚)(辛),壬...');
  assert.equal(normalizeQuote('「甲」『乙』“丙”‘丁’"戊"\'己\''), '甲乙丙丁戊己');
  assert.equal(normalizeQuote('a—b–c-d'), 'abcd');
  assert.equal(normalizeQuote('**粗体** _斜体_ `代码` # 标题 > 引用'), '粗体斜体代码标题引用');
  assert.equal(normalizeQuote('Design\tFor\r\nHabits　中文'), 'designforhabits中文');
  assert.equal(normalizeQuote('第9章, 小步骤.'), normalizeQuote('第9章，小步骤。'));
});

test('v011 seminar enrich gives participants and analyses book labels and avatar colours (also for saved records)', async () => {
  const { enrich } = await import('../src/seminars/index.mjs');
  const catalog = [{ id: 'corvo', kind: 'book', name: 'Corvo', platforms: { codex: { available: true } }, book: { title: '《示例的日常》' } }];
  const r = enrich({ catalog, result: { selected: [{ agent: 'Corvo', reason: 'x' }], perAgent: [{ agent: 'Corvo', analysis: 'y', coverage: '直接' }] } });
  for (const a of [r.result.selected[0], r.result.perAgent[0]]) {
    assert.equal(a.id, 'corvo'); assert.equal(a.bookLabel, '《示例的日常》'); assert.match(a.avatarColor, /^#[0-9a-f]{6}$/i);
  }
});
