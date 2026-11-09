import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as shelf from '../public/layouts/shelf.js';

const category = '学习／研究／工作方法';
const agents = ['Walvo', 'Jadra', 'Calo', 'Boolan', 'Peter'].map((id, i) => ({ id, name: id, kind: i === 4 ? 'role' : 'book', primary: category,
  book: i === 4 ? null : { title: `${id} 原书`, author: id }, description: '说明', tags: [], purpose: i === 4 ? '开发协调' : null,
  platforms: { codex: { available: true, name: `cli-${id}` }, claude: { available: true } }, sources: { checked: true, missing: [] }, sync: { state: '同步' }, permissions: {} }));
const registry = { agents, categories: [category], summary: { books: 4, roles: 1, synced: 5 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const term = { zh: '能量', en: 'Energy', fr: 'Énergie' }, terms = [term, { zh: '习惯', en: 'Habit', fr: 'Habitude' }, { zh: '记忆', en: 'Memory', fr: 'Mémoire' }];
const original = '## 作者原文\n\nBOOK：第 3 章。\n\nINFERENCE：**完整观点**，保留所有限制。\n\n> 书内出处\n\n- 建议一\n- 建议二\n\n<script>literal</script>\n\n最后一句不得省略。';
function record(id = 's1', extra = {}) {
  return { seminarId: id, input: '为什么习惯难以改变？', mode: 'auto', requestedAgents: null, status: 'done',
    createdAt: '2026-10-08T01:00:00Z', startedAt: '2026-10-08T01:00:00Z', finishedAt: '2026-10-08T01:01:00Z',
    result: { terms, selected: agents.slice(0, 3).map(a => ({ id: a.id, agent: a.platforms.codex.name, name: a.name, bookLabel: a.book.title, avatarColor: '#8c2f39', reason: `选择 ${a.name} 的理由` })),
      perAgent: agents.slice(0, 3).map((a, i) => ({ agent: a.platforms.codex.name, analysis: original + a.name, coverage: ['直接', '相关', '无'][i] })),
      commonAnswer: { summary: '共同答案概要', points: [{ text: '共同点甲', support: ['cli-Walvo', 'cli-Jadra', 'cli-Calo'], strength: '全员一致' },
        { text: '共同点乙', support: ['cli-Walvo', 'cli-Jadra'], strength: '多数同意', strengthCorrected: true }] },
      divergences: [{ topic: '分歧议题', positions: [{ agent: 'cli-Walvo', view: '立场甲与理由' }, { agent: 'cli-Jadra', view: '立场乙与理由' }] }],
      actions: [1, 2, 3].map(i => ({ text: `行动 ${i}`, basis: ['cli-Walvo', 'cli-Calo'] })) },
    verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, ...extra };
}
function concept(extra = {}) { return { conceptId: 'c1', status: 'done', agent: { id: 'Walvo', name: 'Walvo', title: 'Notes on Sample' },
  result: { term, concept: '能量：为什么休息影响学习', conceptEn: 'Legacy long English', markdown: original, oneLine: '一句话', sourceRefs: ['第 3 章'] }, perspectives: [], ...extra }; }
function safeDOM(html) {
  const doc = documentFrom(html), create = doc.createElement;
  doc.createElement = tag => { const el = create(tag), set = el.setAttribute.bind(el);
    el.setAttribute = (k, v) => { assert.notEqual(k, 'style'); set(k, v); };
    for (const sink of ['innerHTML', 'outerHTML']) Object.defineProperty(el, sink, { set() { assert.fail(sink); } });
    return el;
  };
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; }; return doc;
}
const view = selected => ({ items: [selected].filter(Boolean), selected, terms: selected?.result?.terms || [], input: '', running: null, busy: false, error: '' });
function unit(model = view(record())) {
  const doc = safeDOM('<html><body><div id="layout-root"></div></body></html>'), calls = [];
  const ctx = { doc, refs: {}, actions: new Proxy({}, { get: (_, action) => (...args) => calls.push({ action, args }) }),
    state: { view: 'seminars', category: 'all', query: '', selectedId: null, detailOpen: false, jointSelectedIds: [], allAgents: agents, categories: [category] } };
  ctx.root = shelf.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const draw = () => shelf.renderSeminars(ctx, model); draw();
  return { doc, ctx, model, calls, draw, get: id => doc.getElementById(id), panel: doc.getElementById('seminars-panel') };
}
async function fixture(t) {
  const doc = safeDOM((await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="shelf-seminar-test">'));
  doc.documentElement.setAttribute('data-ui', 'shelf'); const requests = [];
  const data = { records: new Map([['s1', record()], ['old', record('old', { input: '旧问题', result: { ...record().result, terms: undefined } })]]), running: null, concept: concept(), readError: false };
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, opts, body }); let value = { items: [], unavailable: [] };
    if (url === '/api/registry') value = registry;
    else if (url === '/api/settings') value = { ui: body?.ui || 'shelf', recommend: { codex: { model: 'fixture' } } };
    else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/seminars?limit=30') { if (data.readError) throw new Error('模拟读取失败'); value = { items: [...data.records.values()], running: data.running }; }
    else if (url === '/api/seminars' && body) { const id = 'new'; data.records.set(id, record(id, { input: body.input, status: 'queued', result: null })); data.running = { seminarId: id, status: 'queued' }; value = { seminarId: id }; }
    else if (url.startsWith('/api/seminars/')) value = data.records.get(url.split('/').at(-1));
    else if (url === '/api/concepts?limit=30') value = { items: [data.concept], today: { conceptId: 'c1' }, running: null };
    else if (url === '/api/concepts/c1') value = data.concept;
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true }); t.after(() => app.dispose());
  return { doc, app, data, requests, get: id => doc.getElementById(id), open: () => doc.getElementById('seminars-open').fire('click') };
}

test('v011 shelf F38 concept heading, bookmark and archive show accents, keep long subtitle and update terms without replacing Markdown', async t => {
  const h = await fixture(t); await h.get('concepts-open').fire('click'); const heading = h.get('concepts-heading');
  assert.equal(heading.querySelector('.shelf-term-title').tagName, 'H3'); assert.equal(heading.querySelector('.shelf-term-title').textContent, '能量'); assert.equal(heading.querySelector('.shelf-term-translations').textContent, 'Energy · Énergie');
  assert.match(heading.querySelector('.shelf-term-subtitle').textContent, /能量：为什么休息影响学习/);
  assert.equal(heading.querySelector('[lang="fr"]').textContent, 'Énergie'); assert.doesNotMatch(heading.textContent, /Legacy long English/);
  for (const id of ['concepts-archive', 'shelf-concept-bookmark']) { const el = h.get(id); assert.match(el.textContent, /Energy · Énergie/); assert.match(el.textContent, /能量：为什么休息影响学习/); }
  assert.match(h.get('concepts-archive').textContent, /能量 · Energy · Énergie/);
  const body = h.get('concepts-body').children[0]; h.data.concept.result.term = { zh: '记忆', en: 'Memory', fr: 'Mémoire' }; await h.app.actions.openConcepts();
  assert.equal(h.get('concepts-heading').querySelector('.shelf-term-title').textContent, '记忆'); assert.equal(h.get('concepts-body').children[0], body);
  assert.match(body.textContent, /最后一句不得省略/); assert.ok(h.get('concepts-heading').querySelector('[data-agent-link="Walvo"]'));
  delete h.data.concept.result.term; await h.app.actions.openConcepts();
  assert.equal(h.get('concepts-heading').querySelector('.shelf-term-title').textContent, '能量：为什么休息影响学习'); assert.match(h.get('concepts-heading').textContent, /Legacy long English/);
});
