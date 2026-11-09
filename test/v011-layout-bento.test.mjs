import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import * as bento from '../public/layouts/bento.js';

const terms = [{ zh: '能量', en: 'Energy', fr: 'Énergie' }, { zh: '习惯', en: 'Habit', fr: 'Habitude' }, { zh: '韧性', en: 'Resilience', fr: 'Résilience' }];
const agents = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, name: `作者${i}`, kind: 'book', primary: '学习', tags: [], description: '说明',
  book: { title: `原书${i}` }, platforms: { codex: { available: true, name: `cli-${i}` }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } }));
const registry = { agents, categories: ['学习'], summary: { books: 4, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const markdown = '## 完整原文\n\nBOOK：第 3 章。\n\nINFERENCE：**保留看法**。\n\n<script>原样文本</script>\n\n[危险](javascript:alert(1))';
function record(id = 's1', extra = {}) {
  return { seminarId: id, input: '为什么习惯难以改变？', mode: 'auto', parentId: null, requestedAgents: null, status: 'done',
    createdAt: '2026-10-08T01:00:00Z', startedAt: '2026-10-08T01:00:00Z', finishedAt: '2026-10-08T01:02:00Z',
    result: { terms, selected: agents.slice(0, 3).map((a, i) => ({ id: a.id, agent: `cli-${i}`, name: a.name, bookLabel: `《原书${i}》`, reason: `选择理由${i}`, avatarColor: '#d9e6d3' })),
      perAgent: agents.slice(0, 3).map((a, i) => ({ agent: `cli-${i}`, analysis: markdown + `\n\n末尾证据${i}`, coverage: ['直接', '相关', '无'][i] })),
      commonAnswer: { summary: '共同说明全文', points: [{ text: '一致的要点', support: ['cli-0', 'cli-1', 'cli-2'], strength: '全员一致' },
        { text: '多数的要点', support: ['cli-0', 'cli-1'], strength: '多数同意', strengthCorrected: true }] },
      divergences: [{ topic: '分歧议题', positions: [{ agent: 'cli-0', view: '立场甲及理由' }, { agent: 'cli-1', view: '立场乙及理由' }] }],
      actions: [1, 2, 3].map(i => ({ text: `行动建议${i}`, basis: ['cli-0', 'cli-2'] })) },
    verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, thinkError: null, ...extra };
}
function model() { return { items: [record()], selected: record(), terms, running: null, busy: false, error: '', input: '' }; }
function concept(withTerm = true) {
  return { conceptId: 'c1', kind: 'daily', day: '2026-10-08', status: 'done', agent: { id: 'b0', name: '作者0', title: '原书0' },
    result: { concept: '能量：较长的原标题', conceptEn: 'Legacy English', ...(withTerm ? { term: terms[0] } : {}), oneLine: '说明', markdown }, perspectives: [] };
}
function safeDOM(doc) {
  for (const method of ['createElement', 'createElementNS']) {
    const create = doc[method]; doc[method] = (...args) => {
      const el = create(...args), set = el.setAttribute.bind(el);
      Object.defineProperty(el, 'innerHTML', { set() { assert.fail('No HTML sinks'); } });
      el.setAttribute = (k, v) => { assert.notEqual(k, 'style', 'CSP forbids style attributes'); set(k, v); }; return el;
    };
  }
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; }; return doc;
}
function fixture(value = model()) {
  const doc = safeDOM(documentFrom('<body><div id="layout-root"></div></body>')), calls = [];
  const ctx = { doc, refs: {}, state: { view: 'catalog', allAgents: agents, detailOpen: false }, actions: new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }) };
  ctx.root = bento.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const update = () => {};
  return { doc, ctx, value, calls, update, get: id => doc.getElementById(id), page() { ctx.state.view = 'seminars'; update(); } };
}
const visible = el => !!el && !el.closest('[hidden]');
const textNodes = (el, tag) => descendants(el).filter(n => n.tagName === tag.toUpperCase());
const css = await fs.readFile('public/layouts/bento.css', 'utf8'), source = await fs.readFile('public/layouts/bento.js', 'utf8');
function rule(selector) { const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, selector); return css.slice(start, css.indexOf('}', start)); }

test('v011 F38 concept home, reading and archive use zh, 13px bilingual line, original subtitle and accented French', () => {
  const h = fixture(), saved = concept(), value = { items: [saved], selected: saved, today: { conceptId: 'c1' }, running: null, busy: false, error: '' };
  h.ctx.state.view = 'concepts'; bento.renderConcepts(h.ctx, value);
  for (const target of [h.get('concepts-today'), h.get('concepts-reading'), h.get('concepts-archive')]) {
    assert.match(target.textContent, /能量.*Energy · Énergie.*能量：较长的原标题/);
    assert.equal(target.querySelector('[lang="fr"]').textContent, 'Énergie');
  }
  assert.equal(h.get('concepts-open').textContent, '能量'); assert.equal(h.get('concepts-reading').querySelector('.bento-concept-heading').textContent, '能量');
  assert.equal(h.get('concepts-reading').querySelector('.bento-term-subtitle').textContent, saved.result.concept);
  assert.equal(h.get('concepts-reading').querySelector('.concept-markdown').textContent.includes('BOOK：第 3 章。'), true);
  assert.equal(saved.result.markdown, markdown);
  const legacy = concept(false); value.items = [legacy]; value.selected = legacy; bento.renderConcepts(h.ctx, value);
  assert.equal(h.get('concepts-reading').querySelector('.bento-concept-heading').textContent, legacy.result.concept);
  assert.match(h.get('concepts-reading').textContent, /Legacy English/); assert.doesNotMatch(h.get('concepts-reading').textContent, /Énergie|undefined/);
  legacy.term = terms[0]; bento.renderConcepts(h.ctx, value); assert.equal(h.get('concepts-open').textContent, '能量', 'top-level legacy enrichment is supported');
});

async function mounted(t) {
  const { doc } = await appDocument('bento'); safeDOM(doc); const requests = [], saved = record(), c = concept();
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body });
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } :
      url === '/api/settings' ? { ui: body?.ui || 'bento', recommend: { codex: { model: 'fixture' } } } :
      url === '/api/seminars?limit=30' ? { items: [saved], running: null } : url === '/api/seminars' ? { seminarId: 's1' } : url === '/api/seminars/s1' ? saved :
      url === '/api/concepts?limit=30' ? { items: [c], today: { conceptId: 'c1' }, running: null } : url === '/api/concepts/c1' ? c : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true }); t.after(() => app.dispose()); return { doc, app, requests, get: id => doc.getElementById(id) };
}
