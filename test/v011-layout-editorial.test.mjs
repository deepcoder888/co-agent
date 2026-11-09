import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { renderMarkdown } from '../public/markdown.js';
import * as editorial from '../public/layouts/editorial.js';

const members = ['Walvo', 'Jadra', 'Rusko', 'Calo'].map(id => ({ id, name: id, kind: 'book', primary: '学习',
  book: { title: `原书${id}`, author: id }, description: '书中说明', tags: [], permissions: {},
  platforms: { codex: { available: true, name: `cli-${id}` }, claude: { available: true } },
  sources: { checked: true, missing: [] }, sync: { state: '同步' } }));
const registry = { agents: members, categories: ['学习'], summary: { books: 4, roles: 0, synced: 4 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const terms = [{ zh: '能量', en: 'Energy', fr: 'Énergie' }, { zh: '习惯', en: 'Habit', fr: 'Habitude' }];
const analysis = '# 作者原文\n\nBOOK：第 3 章。**不可删改的论据**。\n\nINFERENCE：' + '保留推论。'.repeat(110) +
  '\n\n> 引文与限定\n\n- 第一点\n- 第二点\n\n| 项目 | 判断 |\n| --- | --- |\n| 证据 | 相关 |\n\n```js\nconst x = 1;\n```\n\n<script>literal</script>';
function record(id = 's1', extra = {}) {
  return { seminarId: id, input: '为什么习惯难以改变？', mode: 'auto', requestedAgents: null, status: 'done',
    createdAt: '2026-10-08T01:00:00Z', startedAt: '2026-10-08T01:00:00Z', finishedAt: '2026-10-08T01:02:00Z', model: 'fixture', effort: 'xhigh',
    result: { terms, selected: members.slice(0, 3).map(a => ({ agent: `cli-${a.id}`, id: a.id, name: a.name, bookLabel: a.book.title, reason: `理由${a.id}`, avatarColor: '#b4c8ab' })),
      perAgent: members.slice(0, 3).map((a, i) => ({ agent: `cli-${a.id}`, id: a.id, analysis, coverage: ['直接', '相关', '无'][i] })),
      commonAnswer: { summary: '共同答案导语', points: [
        { text: '共同要点', support: ['cli-Walvo', 'cli-Jadra', 'cli-Rusko'], strength: '全员一致' },
        { text: '多数要点', support: ['cli-Walvo', 'cli-Jadra'], strength: '多数同意', strengthCorrected: true }] },
      divergences: [{ topic: '观察期限', positions: [{ agent: 'cli-Walvo', view: '立场甲及理由' }, { agent: 'cli-Jadra', view: '立场乙及理由' }] }],
      actions: [1, 2, 3].map(i => ({ text: `行动${i}`, basis: ['cli-Walvo', 'cli-Rusko'] })) },
    verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, thinkFile: 'fixture.md', thinkError: null, ...extra };
}
const concept = (extra = {}) => ({ conceptId: 'c1', status: 'done', createdAt: '2026-10-08T01:00:00Z',
  agent: { id: 'Walvo', name: 'Walvo', title: '原书Walvo' },
  result: { term: terms[0], concept: '能量：理解精力的长标题', conceptEn: 'Old long English title', oneLine: '概念导语', whyUnknown: '前提容易忽略', markdown: analysis },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, perspectives: [], ...extra });
function safeDOM(doc) {
  for (const method of ['createElement', 'createElementNS']) {
    const create = doc[method]; doc[method] = (...args) => {
      const el = create(...args), set = el.setAttribute.bind(el);
      el.setAttribute = (k, v) => { assert.notEqual(k, 'style'); set(k, v); };
      for (const sink of ['innerHTML', 'outerHTML']) Object.defineProperty(el, sink, { set() { assert.fail(sink); } });
      return el;
    };
  }
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; }; return doc;
}
const visible = el => !!el && !el.closest('[hidden]');
const control = (root, key) => root.querySelector(`[data-focus-key="seminars-${key}"]`);
function isolated(t, selected = record(), options = {}) {
  const doc = safeDOM(documentFrom('<body></body>')), calls = [];
  const actions = Object.fromEntries(['openSeminars', 'startSeminar', 'setSeminarInput', 'selectSeminar', 'openSeminarAddPicker', 'rerunSeminar', 'continueSeminarInJoint', 'showView', 'openSettings'].map(name =>
    [name, (...args) => calls.push({ name, args })]));
  const ctx = { doc, refs: {}, actions, state: { view: 'seminars', allAgents: members, categories: ['学习'] } };
  ctx.root = editorial.render(ctx); doc.body.append(ctx.root);
  const model = { items: selected ? [selected] : [], selected, running: null, busy: false, input: '', error: '', ...options };
  editorial.renderSeminars(ctx, model); t.after(() => ctx.refs.dispose());
  return { ctx, doc, model, calls, panel: doc.getElementById('seminars-panel'), update: () => editorial.renderSeminars(ctx, model) };
}
async function fixture(t) {
  const { doc } = await appDocument('editorial'); safeDOM(doc);
  const requests = [], data = { records: new Map([['s1', record()], ['old', record('old', { result: null, status: 'failed', error: '进程中断' })]]), running: null, concept: concept() };
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body, opts });
    let value = { items: [], unavailable: [] };
    if (url === '/api/registry') value = registry;
    else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/settings') value = { ui: body?.ui || 'editorial', recommend: { codex: { model: 'fixture' } } };
    else if (url === '/api/seminars?limit=30') value = { items: [...data.records.values()], running: data.running };
    else if (url === '/api/seminars') { value = { seminarId: 'new' }; data.running = { seminarId: 'new', status: 'queued', stage: 'selecting' }; data.records.set('new', record('new', { status: 'queued', stage: 'selecting', result: null })); }
    else if (url.startsWith('/api/seminars/')) value = data.records.get(url.split('/').at(-1));
    else if (url === '/api/concepts?limit=30') value = { items: [data.concept], today: { conceptId: 'c1' }, running: null };
    else if (url === '/api/concepts/c1') value = data.concept;
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true }); t.after(() => app.dispose());
  await doc.getElementById('seminars-open').fire('click'); return { app, doc, requests, data, panel: doc.getElementById('seminars-panel') };
}

test('v011 editorial F38: concept heading and archive use Chinese first, one bilingual line, intact long subtitle and French accents', async t => {
  const { doc, app } = await fixture(t); await app.actions.openConcepts();
  const reading = doc.querySelector('.editorial-concept-reading'), heading = reading.querySelector('.editorial-concept-byline');
  assert.equal(heading.querySelector('.editorial-concept-title').textContent, '能量');
  assert.equal(heading.querySelector('.editorial-term-translations').textContent, 'Energy · Énergie');
  assert.equal(heading.querySelector('.editorial-term-subtitle').textContent, '能量：理解精力的长标题');
  const entry = doc.querySelector('.editorial-concept-index-row'); assert.equal(entry.querySelector('.directory-title').textContent, '能量');
  assert.equal(entry.querySelector('.editorial-term-translations').textContent, 'Energy · Énergie'); assert.match(entry.textContent, /能量：理解精力的长标题/);
  assert.equal(reading.querySelector('.concept-markdown').textContent, renderMarkdown(doc, analysis).textContent);
  assert.ok(reading.querySelector('.concept-today')); assert.equal(doc.querySelectorAll('[data-focus-key="concepts-perspectives"]').length, 1);
});
