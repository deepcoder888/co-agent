import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import * as shelf from '../public/layouts/shelf.js';

const agents = [{ id: 'xiaomo2', name: 'Xiaomo2', kind: 'book', primary: '学习', book: { title: '示例年度记', author: '李笑来' },
  description: '说明', tags: [], platforms: { codex: { available: true }, claude: { available: true } },
  sources: { checked: true, missing: [], total: 1 }, permissions: {}, sync: { state: '同步' } }];
const markdown = ['# 概念即认知传感器 - AI-Era Learning Map', '## Direct Answer', '### 1. Essence', '正文第一段。',
  '### 2. World Model', '| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |', '## Grounding Status', '哈希全部匹配。',
  '## Evidence Ledger', '| Claim | Label |\n| --- | --- |\n| 主张 | BOOK |', 'STATUS: GROUNDED'].join('\n\n');
const record = (extra = {}) => ({ conceptId: 'today', kind: 'daily', day: '2026-10-15', status: 'done',
  agent: { id: 'xiaomo2', name: 'Xiaomo2', title: '示例年度记', author: '李笑来' },
  result: { concept: '概念即认知传感器', term: { zh: '概念', en: 'concept', fr: 'concept' }, oneLine: '概念是认知传感器。',
    whyUnknown: '书名不提示。', sourceRefs: ['第 12 章'], markdown },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, perspectives: [], ...extra });
const view = selected => ({ today: { conceptId: 'today', day: '2026-10-15', status: selected?.status ?? null }, items: selected ? [selected] : [], selected, running: null, busy: false, error: '' });
function unit(model) {
  const doc = documentFrom('<html><body><div id="layout-root"></div></body></html>');
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; };
  const actions = new Proxy({}, { get: () => () => {} });
  const ctx = { doc, actions, refs: {}, state: { view: 'concepts', category: 'all', query: '', selectedId: null, jointSelectedIds: [], allAgents: agents, detailOpen: false } };
  ctx.root = shelf.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  shelf.renderConcepts(ctx, model);
  const reader = doc.getElementById('concept-reader');
  return { doc, ctx, reader, entry: doc.getElementById('concepts-reader'), toc: () => doc.getElementById('concept-reader-toc-list').children };
}

test('v020 reading-mode entry is disabled until a lecture exists and opens a full-window dialog', async () => {
  assert.equal(unit(view(record({ status: 'running', result: null }))).entry.disabled, true);
  const h = unit(view(record()));
  assert.equal(h.entry.disabled, false); assert.equal(h.entry.textContent, '阅读模式'); assert.equal(h.reader.tagName, 'DIALOG');
  assert.equal(h.reader.open, false);
  await h.entry.fire('click');
  assert.equal(h.reader.open, true);
  assert.equal(h.doc.activeElement, h.doc.getElementById('concept-reader-exit'));
});

test('v020 masthead uses the full concept name as the title and the de-duplicated core term as small text', async () => {
  const h = unit(view(record())); await h.entry.fire('click');
  const masthead = h.doc.getElementById('concept-reader-masthead');
  assert.equal(h.doc.getElementById('concept-reader-title').textContent, '概念即认知传感器');
  assert.equal(masthead.querySelector('.shelf-reader-term').textContent, '概念 · concept');
  assert.match(masthead.textContent, /今日一讲 · 2026-10-15/);
  assert.match(masthead.textContent, /《示例年度记》 · 李笑来 · 由 Xiaomo2 讲解/);
  const body = h.doc.getElementById('concept-reader-body');
  assert.equal(body.querySelectorAll('h1').length, 0, 'the lecture title line is not repeated');
  // Only the lecture itself: no desk controls, verification marks or perspectives inside the reader.
  for (const id of ['concepts-perspectives', 'concepts-continue', 'concepts-marks', 'concepts-perspective-results']) assert.equal(h.reader.contains(h.doc.getElementById(id)), false, id);
});

test('v020 provenance sections are folded closed and keep their own content', async () => {
  const h = unit(view(record())); await h.entry.fire('click');
  const folds = h.doc.getElementById('concept-reader-body').querySelectorAll('details');
  assert.deepEqual(folds.map(f => f.children[0].textContent), ['Grounding Status', 'Evidence Ledger']);
  assert.ok(folds.every(f => f.open === false));
  assert.match(folds[0].textContent, /哈希全部匹配/); assert.match(folds[1].textContent, /主张.*BOOK/); assert.match(folds[1].textContent, /STATUS: GROUNDED/);
  assert.doesNotMatch(descendants(h.doc.getElementById('concept-reader-body')).filter(n => n.tagName === 'H2').map(n => n.textContent).join('|'), /Grounding|Evidence/);
});

test('v020 outline items jump to their section, opening a folded one', async () => {
  const h = unit(view(record())); await h.entry.fire('click');
  const items = h.toc();
  assert.deepEqual(items.map(b => b.textContent), ['Direct Answer', '1. Essence', '2. World Model', 'Grounding Status', 'Evidence Ledger']);
  assert.deepEqual(items.map(b => b.className.split(' ')[1]), ['is-main', 'is-sub', 'is-sub', 'is-main', 'is-main']);
  const scrolled = [];
  for (const heading of descendants(h.reader).filter(n => /^concept-reader-section-/.test(n.id || ''))) heading.scrollIntoView = options => scrolled.push([heading.id, options.block]);
  await items[2].fire('click');
  const world = h.doc.getElementById('concept-reader-section-2');
  assert.equal(world.textContent, '2. World Model'); assert.deepEqual(scrolled, [['concept-reader-section-2', 'start']]); assert.equal(h.doc.activeElement, world);
  await items[4].fire('click');
  const summary = h.doc.getElementById('concept-reader-section-4');
  assert.equal(summary.tagName, 'SUMMARY'); assert.equal(summary.parentElement.open, true); assert.equal(h.doc.activeElement, summary);
  assert.equal(summary.getAttribute('tabindex'), null, 'summaries stay in the tab order');
});

test('v020 the whole outline sidebar collapses to a rail, and stays collapsed when the reader is reopened', async () => {
  const h = unit(view(record())); await h.entry.fire('click');
  const toggle = h.doc.getElementById('concept-reader-toc-toggle'), list = h.doc.getElementById('concept-reader-toc-list');
  const heading = h.doc.getElementById('concept-reader-toc-heading');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(toggle.getAttribute('aria-controls'), 'concept-reader-toc-list');
  assert.equal(toggle.getAttribute('aria-label'), '收起目录'); assert.equal(heading.textContent, '本讲目录'); assert.equal(heading.hidden, false);
  await toggle.fire('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(list.hidden, true); assert.equal(heading.hidden, true);
  assert.equal(toggle.getAttribute('aria-label'), '展开目录'); assert.equal(toggle.textContent, '目录 ›');
  // The exit keeps only its arrow inside the rail; its accessible name is unchanged.
  const exit = h.doc.getElementById('concept-reader-exit');
  assert.match(exit.className, /is-compact/); assert.equal(exit.getAttribute('aria-label'), '退出阅读模式');
  assert.match(await fs.readFile('public/layouts/shelf.css', 'utf8'), /\.shelf-reader-exit\.is-compact \.shelf-reader-exit-label,\s*\[data-ui="shelf"\] \.shelf-reader-exit\.is-compact kbd \{\s*display:none;/);
  assert.match(h.doc.getElementById('concept-reader-grid').className, /is-toc-collapsed/);
  // The collapsed grid narrows the sidebar column; since v0.53.14 the page column keeps its measure (characters per
  // line of the body text) instead of widening to 920px.
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\.shelf-reader-grid\.is-toc-collapsed \{\s*grid-template-columns:52px minmax\(0,1fr\);/);
  assert.doesNotMatch(css, /\.is-toc-collapsed \.shelf-reader-page \{/);
  assert.match(css, /\.shelf-reader-page \{[^}]*max-width:calc\(var\(--reader-font-size\) \* var\(--reader-measure\)\);/);
  h.reader.close(); await h.entry.fire('click');
  assert.equal(list.hidden, true); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await toggle.fire('click'); assert.equal(list.hidden, false);
  assert.doesNotMatch(h.doc.getElementById('concept-reader-exit').className, /is-compact/);
  assert.equal(h.doc.getElementById('concept-reader-exit').textContent, '← 合上书Esc');
});

test('v020 collapsing the sidebar keeps the section being read at the top', async () => {
  const h = unit(view(record())); await h.entry.fire('click');
  const items = h.toc(), world = h.doc.getElementById('concept-reader-section-2'), grid = h.doc.getElementById('concept-reader-grid');
  const scrolled = []; world.scrollIntoView = options => scrolled.push(options.block);
  items[2].setAttribute('aria-current', 'true');
  await h.doc.getElementById('concept-reader-toc-toggle').fire('click');
  assert.deepEqual(scrolled, ['start'], 'aligned immediately');
  await grid.fire('transitionend');
  assert.deepEqual(scrolled, ['start', 'start'], 'aligned again once the width transition ends');
});
test('v020 the exit button and Escape close the reader and return focus to the entry', async () => {
  const h = unit(view(record()));
  h.entry.focus(); await h.entry.fire('click');
  await h.doc.getElementById('concept-reader-exit').fire('click');
  assert.equal(h.reader.open, false); assert.equal(h.doc.activeElement, h.entry);
  await h.entry.fire('click');
  await h.reader.fire('keydown', { key: 'Escape' });
  assert.equal(h.reader.open, false); assert.equal(h.doc.activeElement, h.entry);
});

test('v020 reader styles stay inside the shelf skin and use CSSOM-safe CSS only', async () => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8'), js = await fs.readFile('public/layouts/shelf.js', 'utf8');
  const block = css.slice(css.indexOf('/* v0.20 reading mode')).replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = block.split('}').map(r => r.split('{').at(-2)).filter(Boolean).flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
  assert.ok(selectors.length > 30);
  for (const selector of selectors) assert.match(selector, /^\[data-ui="shelf"\]/, selector);
  assert.doesNotMatch(js.slice(js.indexOf('// v0.20 reading mode'), js.indexOf('function buildReader')), /innerHTML|style=|setAttribute\('style'/);
});
