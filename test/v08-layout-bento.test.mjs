import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import * as bento from '../public/layouts/bento.js';

const markdown = '# 带宽 - AI-Era Learning Map\n\n**可用注意力**与*选择*。\n\n'
  + Array.from({ length: 11 }, (_, i) => `### ${i + 1}. 小节\n\n第 ${i + 1} 节正文`).join('\n\n')
  + '\n\n| 项目 | 内容 |\n| --- | --- |\n| 证据 | 章节 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n<script>literal</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))';
const concept = (id = 'today', extra = {}) => ({ conceptId: id, kind: 'daily', day: '2026-10-08', createdAt: '2026-10-08T01:00:00Z',
  status: 'done', agent: { id: 'source', name: 'Senvo', title: '**稀缺**', bookLabel: '《稀缺》' },
  result: { concept: id === 'today' ? '带宽' : '旧概念', conceptEn: 'Bandwidth', oneLine: '稀缺占用可用注意力。', whyUnknown: '忙碌也会消耗认知资源。', sourceRefs: ['第 2 章'], markdown },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, thinkError: null, perspectives: [], ...extra });
const old = concept('old'), today = concept();
const model = () => ({ today: { day: '2026-10-08', conceptId: 'today', status: 'done' }, items: [old, today], selected: old, running: null, busy: false, error: '' });
const visible = el => !!el && !el.closest('[hidden]');
const button = (root, name) => descendants(root).find(n => n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === name || n.textContent === name));
function safeDOM(doc) {
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag), set = el.setAttribute.bind(el);
    Object.defineProperty(el, 'innerHTML', { set() { assert.fail('No HTML injection'); } });
    el.setAttribute = (key, value) => { assert.notEqual(key, 'style', 'CSP rejects style attributes'); set(key, value); };
    return el;
  };
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  return doc;
}
function fixture(value = model()) {
  const doc = safeDOM(documentFrom('<body><div id="layout-root"></div></body>')), calls = [];
  const ctx = { doc, refs: {}, state: { view: 'catalog', detailOpen: false }, actions: new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }) };
  ctx.root = bento.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const update = () => bento.renderConcepts(ctx, value); update();
  return { doc, ctx, calls, value, update, get: id => doc.getElementById(id), page() { ctx.state.view = 'concepts'; update(); } };
}
const css = await fs.readFile('public/layouts/bento.css', 'utf8');
const source = await fs.readFile('public/layouts/bento.js', 'utf8');
function rule(selector) {
  const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, selector);
  return css.slice(start, css.indexOf('}', start));
}

test('v08 bento home: owned two-column today tile below first row, today data stays independent of archive selection', async () => {
  const h = fixture(), tile = h.get('concepts-today');
  assert.ok(tile); assert.equal(tile.parentElement, h.get('bento-grid'));
  assert.match(tile.textContent, /今日概念.*带宽.*《稀缺》.*Senvo.*稀缺占用可用注意力/);
  assert.equal(tile.querySelector('.concept-today-badge').textContent, '今日');
  assert.doesNotMatch(tile.textContent, /旧概念|\*\*/);
  assert.ok(visible(h.get('concepts-open'))); assert.equal(h.get('concepts-panel').hidden, true);
  assert.ok(h.ctx.root.contains(h.get('concepts-panel'))); assert.equal(h.doc.querySelector('.concepts-default'), null);
  await h.get('concepts-open').fire('click'); assert.deepEqual(h.calls, [['openConcepts'], ['selectConcept', 'today']]);
  assert.match(rule('[data-ui="bento"] .bento-home-concept'), /grid-column:\s*1\s*\/\s*3/);
  assert.match(rule('[data-ui="bento"] .bento-home-concept'), /grid-row:\s*3/);
});

test('v08 bento acceptance: v07 ask/statistics/usage placement stays intact above a concept/recent row and Agent tiles', () => {
  const h = fixture(), order = h.get('bento-grid').children.map(el => el.id);
  assert.deepEqual(order, ['recommend-panel', 'metrics', 'top-agents', 'concepts-today', 'recent-history', 'recommend-output', 'catalog', 'navigation', 'running-panel', 'coverage-tile']);
  assert.ok(h.get('recommend-panel').className.split(' ').includes('bento-ask'));
  assert.ok(h.get('concepts-today').className.split(' ').includes('bento-home-concept'));
  assert.ok(h.get('recent-history').className.split(' ').includes('bento-home-recent'));
  const ask = rule('[data-ui="bento"] .bento-ask'), metrics = rule('[data-ui="bento"] #metrics'), top = rule('[data-ui="bento"] #top-agents');
  assert.match(ask, /grid-column:\s*1\s*\/\s*3/); assert.match(ask, /grid-row:\s*1\s*\/\s*3/);
  assert.doesNotMatch(ask, /min-height:/, 'restore the v07 content-driven ask height');
  assert.match(metrics, /grid-column:\s*3\s*\/\s*5/); assert.match(metrics, /grid-row:\s*1\s*;/);
  assert.match(metrics, /align-self:\s*start/); assert.doesNotMatch(metrics, /align-self:\s*stretch/);
  assert.match(rule('[data-ui="bento"] .metric-tile'), /min-height:\s*210px/);
  assert.match(top, /grid-column:\s*3\s*\/\s*5/); assert.match(top, /grid-row:\s*2\s*;/);
  assert.match(rule('[data-ui="bento"] .bento-home-recent'), /grid-column:\s*3\s*\/\s*5/);
  assert.match(rule('[data-ui="bento"] .bento-home-recent'), /grid-row:\s*3/);
  // Both new placements must return to source order when the grid drops to two columns.
  const narrow = css.slice(css.indexOf('@media(max-width:1100px)'));
  for (const name of ['bento-home-concept', 'bento-home-recent']) {
    assert.match(narrow, new RegExp(`\\.${name} \\{[^}]*grid-column:\\s*1\\s*/\\s*-1;[^}]*grid-row:\\s*auto`));
  }
});

test('v08 bento acceptance: absent daily uses latest completed archive concept, dated recent label and working actions', async () => {
  const value = model(); value.today = { day: '2026-10-08', conceptId: null, status: null };
  const latest = concept('latest', { kind: 'manual', day: '2026-10-08', createdAt: '2026-10-08T00:30:00Z', result: { ...today.result, concept: '最近完成的概念' } });
  const older = concept('older', { day: '2026-10-07', createdAt: '2026-10-07T01:00:00Z' });
  value.items = [concept('failed', { status: 'failed' }), older, latest, concept('pending', { status: 'running', result: null }), concept('malformed', { result: null })];
  value.selected = older;
  const before = structuredClone(value), h = fixture(value), tile = h.get('concepts-today');
  assert.match(tile.textContent, /最近概念.*2026-10-08.*最近完成的概念.*《稀缺》.*稀缺占用可用注意力/);
  assert.equal(tile.getAttribute('aria-label'), '最近概念');
  assert.match(tile.textContent, /今日 09:00 自动生成/); assert.equal(tile.querySelector('.concept-today-badge'), null);
  assert.equal(tile.querySelector('time').getAttribute('datetime'), '2026-10-08');
  assert.equal(button(tile, '多视角分析').disabled, false);
  await button(tile, '多视角分析').fire('click'); await h.get('concepts-open').fire('click');
  assert.deepEqual(h.calls, [['openPerspectivePicker', 'latest'], ['openConcepts'], ['selectConcept', 'latest']]);
  assert.deepEqual(value, before, 'sorting must not mutate the shared archive');
});

test('v08 bento acceptance: fallback dates use Shanghai time and daily arrival/day rollover update the cached home tile', () => {
  const value = model(), saved = concept('saved', { kind: 'manual', day: null, createdAt: '2026-10-07T16:30:00Z' });
  value.today = null; value.items = [saved]; value.selected = saved;
  const h = fixture(value), tile = h.get('concepts-today');
  assert.match(tile.textContent, /最近概念.*2026-10-08/); assert.equal(tile.querySelector('.concept-today-badge'), null);
  value.items.push(today); value.today = { day: '2026-10-08', conceptId: 'today', status: 'done' }; h.update();
  assert.match(tile.textContent, /今日概念.*带宽/); assert.equal(tile.querySelector('.concept-today-badge').textContent, '今日');
  assert.doesNotMatch(tile.textContent, /今日 09:00 自动生成/);
  // Same record can be today's daily and later the newest archived concept.
  value.today = { day: '2026-10-09', conceptId: null, status: null }; h.update();
  assert.match(tile.textContent, /最近概念.*2026-10-08.*带宽/); assert.equal(tile.querySelector('.concept-today-badge'), null);
  assert.match(tile.textContent, /今日 09:00 自动生成/);
  value.items = [concept('failed', { status: 'failed' })]; value.selected = null; h.update();
  assert.match(tile.textContent, /今日讲解尚未生成/); assert.equal(button(tile, '多视角分析').disabled, true);
});

test('v08 bento concept page: archive today first, selected reading tile, source/why/verification then Markdown and perspective tiles', () => {
  const h = fixture(); h.value.selected = today;
  h.value.selected = { ...today, perspectives: [{ runId: 'p1', status: 'done', agents: [{ id: 'other', name: 'Jadra' }],
    verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, results: [{ agentId: 'other', name: 'Jadra', analysis: '## 睡眠视角\n\n**补充内容**' }] }] };
  const before = structuredClone(h.value); h.page();
  const panel = h.get('concepts-panel'), archive = h.get('concepts-archive'), reading = h.get('concepts-reading');
  assert.ok(visible(panel)); assert.equal(h.get('bento-grid').hidden, true); assert.equal(h.ctx.root.hidden, false);
  const entries = archive.querySelectorAll('button'); assert.equal(entries[0].getAttribute('data-concept-id'), 'today');
  assert.equal(entries[0].getAttribute('aria-current'), 'page'); assert.equal(entries[1].getAttribute('data-concept-id'), 'old');
  assert.equal(entries[1].querySelector('.concept-today-badge'), null);
  assert.match(reading.textContent, /带宽.*Bandwidth.*《稀缺》.*Senvo.*稀缺占用.*忙碌也会.*Agent 核验：通过.*11 小节.*通过.*第 2 章/s);
  assert.equal(reading.querySelectorAll('.concept-markdown').length, 1);
  const perspective = h.get('concepts-perspectives').querySelector('.bento-perspective-card');
  assert.match(perspective.textContent, /Jadra.*睡眠视角.*补充内容/s); assert.ok(perspective.querySelector('strong'));
  assert.deepEqual(h.value, before); assert.equal(h.doc.activeElement, h.get('concepts-title'));
});

test('v08 bento all entry, archive, generation, picker, continuation and back actions dispatch without direct requests', async () => {
  const h = fixture();
  await button(h.get('concepts-today'), '再来一个').fire('click');
  await button(h.get('concepts-today'), '多视角分析').fire('click');
  h.page();
  await button(h.get('concepts-panel'), '再来一个').fire('click');
  await button(h.get('concepts-reading'), '多视角分析').fire('click');
  await button(h.get('concepts-reading'), '在终端中继续').fire('click');
  await h.get('concepts-archive').querySelector('[data-concept-id="today"]').fire('click');
  const back = h.get('concepts-panel').querySelector('[data-focus-key="concepts-back"]'); back.focus(); await back.fire('click');
  h.ctx.state.view = 'catalog'; h.update(); assert.equal(h.doc.activeElement, h.get('concepts-open'));
  assert.deepEqual(h.calls, [['nextConcept'], ['openPerspectivePicker', 'today'], ['nextConcept'], ['openPerspectivePicker', 'old'],
    ['continueInJoint', 'old'], ['selectConcept', 'today'], ['showView', 'catalog']]);
  const ids = descendants(h.doc.body).map(n => n.id).filter(Boolean); assert.equal(new Set(ids).size, ids.length);
});

test('v08 bento running generation and perspectives show elapsed/unknown time and gate only the relevant actions', async () => {
  const h = fixture(), startedAt = new Date(Date.now() - 65000).toISOString();
  h.value.running = { conceptId: 'new', kind: 'manual', startedAt }; h.update();
  assert.match(h.get('concepts-today').textContent, /运行中.*已用 1 分/);
  assert.equal(button(h.get('concepts-today'), '再来一个').disabled, true);
  h.page(); assert.match(h.get('concepts-panel').textContent, /运行中.*已用 1 分/);
  await button(h.get('concepts-panel'), '再来一个').fire('click'); assert.equal(h.calls.length, 0);
  h.value.running = null; h.value.selected = { ...today, perspectives: [{ runId: 'running', status: 'running', startedAt, results: [], agents: [{ id: 'other' }] }] }; h.update();
  assert.match(h.get('concepts-perspectives').textContent, /运行中.*已用 1 分/);
  assert.equal(button(h.get('concepts-reading'), '多视角分析').disabled, true);
  assert.equal(button(h.get('concepts-reading'), '在终端中继续').disabled, false);
  assert.equal(button(h.get('concepts-panel'), '再来一个').disabled, false);
  h.value.selected = concept('new', { status: 'queued', result: null, createdAt: null }); h.update();
  assert.match(h.get('concepts-reading').textContent, /排队中.*用时未知/);
  h.value.busy = true; h.update(); assert.match(h.get('concepts-panel').textContent, /正在提交/);
  assert.equal(button(h.get('concepts-panel'), '再来一个').disabled, true);
});

test('v08 bento failures retain partial results and all warnings, retry generation/perspectives and re-read separately', async () => {
  const h = fixture(); h.value.selected = concept('broken', { status: 'failed', error: '生成中断', thinkError: '磁盘不可写',
    verify: { state: 'violation', skillStructure: { state: 'missing', missing: [3, 11], titleLine: false } },
    perspectives: [{ runId: 'failed-run', status: 'failed', error: '分析中断', agents: [{ id: 'other' }],
      verify: { state: 'violation', parallel: false, violations: ['越权角色'] }, results: [{ name: '<img onerror=x>', analysis: '**部分结果**' }] }] });
  h.value.error = '读取失败'; h.page(); const panel = h.get('concepts-panel');
  for (const text of ['生成中断', '磁盘不可写', '分析中断', '越权角色', '部分结果', '读取失败']) assert.ok(panel.textContent.includes(text), text);
  assert.match(panel.textContent, /Agent 核验：违规/); assert.match(panel.textContent, /11 小节.*3、11.*标题行/);
  assert.ok(panel.querySelector('[role="alert"]'));
  await panel.querySelector('[data-focus-key="concepts-retry"]').fire('click');
  assert.equal(panel.querySelector('[data-focus-key="concepts-retry-failed-run"]').disabled, true, 'backend requires a completed concept for perspectives');
  h.value.selected.status = 'done'; h.update();
  await panel.querySelector('[data-focus-key="concepts-retry-failed-run"]').fire('click');
  await button(panel, '重新读取').fire('click');
  assert.deepEqual(h.calls, [['nextConcept'], ['runPerspectives', 'broken', ['other']], ['openConcepts']]);
  h.value.busy = true; h.update();
  await panel.querySelector('[data-focus-key="concepts-retry-failed-run"]').fire('click'); assert.equal(h.calls.length, 3);
  h.value.selected.result = null; h.update(); assert.match(panel.textContent, /THINK 另存失败：磁盘不可写/);
});

test('v08 bento unknown verification is never success; missing today/archive/selection are explicit and Markdown is safe', () => {
  const h = fixture(); h.value.selected = concept('uncertain', { verify: null }); h.page();
  assert.match(h.get('concepts-reading').textContent, /核验：未确认/); assert.match(h.get('concepts-reading').textContent, /11 小节.*未确认/);
  const md = h.get('concepts-reading').querySelector('.concept-markdown');
  assert.equal(md.querySelectorAll('script,img,iframe,style').length, 0);
  assert.equal(md.querySelectorAll('a').length, 0); assert.ok(md.querySelector('table')); assert.ok(md.querySelector('strong'));
  assert.match(md.textContent, /Mermaid 图（源码）/); assert.match(md.textContent, /<script>literal<\/script>/);
  assert.equal(descendants(md).filter(n => n.tagName === 'H3').length, 11);
  h.value.today = { conceptId: null }; h.value.items = []; h.value.selected = null; h.update();
  assert.match(h.get('concepts-panel').textContent, /暂无存档/); assert.match(h.get('concepts-reading').textContent, /请选择|读取/);
  h.ctx.state.view = 'catalog'; h.update();
  assert.match(h.get('concepts-today').textContent, /今日讲解尚未生成/);
  assert.equal(h.get('concepts-today').querySelector('.concept-today-badge'), null);
  assert.equal(button(h.get('concepts-today'), '多视角分析').disabled, true);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|renderDefaultConcepts|\.cssText|setAttribute\(['"]style/);
});

test('v08 bento polling preserves completed Markdown nodes and page styles use local bento geometry and picker skin', () => {
  const h = fixture(); h.page(); const md = h.get('concepts-reading').querySelector('.concept-markdown');
  h.value.error = '短暂读取错误'; h.update();
  assert.equal(h.get('concepts-reading').querySelector('.concept-markdown'), md);
  h.value.running = { conceptId: 'another', startedAt: new Date().toISOString() }; h.update();
  assert.equal(h.get('concepts-reading').querySelector('.concept-markdown'), md);
  assert.match(rule('[data-ui="bento"] .bento-concept-tile'), /border-radius:\s*24px/);
  assert.match(rule('[data-ui="bento"] .bento-concept-tile'), /padding:\s*24px/);
  assert.match(rule('[data-ui="bento"] .bento-concept-grid'), /gap:\s*16px/);
  assert.match(rule('[data-ui="bento"] .bento-perspective-cards'), /display:\s*grid/);
  assert.match(rule('[data-ui="bento"] .bento-builder #perspective-submit'), /background:\s*#1d1b19/);
  assert.match(rule('[data-ui="bento"] .bento-builder #perspective-search'), /border-radius:\s*14px/);
  assert.doesNotMatch(css, /@import|https?:|url\(/);
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim(); if (selector.startsWith('@media')) continue;
    assert.ok(selector.split(',').every(part => part.trim().startsWith('[data-ui="bento"]')), selector);
  }
});

async function mounted(t) {
  const { doc } = await appDocument('bento'); safeDOM(doc);
  const agents = ['source', 'other'].map(id => ({ id, name: id, kind: 'book', primary: '学习', description: '描述', tags: [], book: { title: '书名' },
    platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } }));
  const registry = { agents, categories: ['学习'], summary: { roles: 0, books: 2 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  const requests = [];
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, opts, body });
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } :
      url === '/api/settings' ? { ui: body?.ui || 'bento', recommend: { codex: { model: 'fixture' } } } :
      url === '/api/concepts?limit=30' ? { ...model(), items: [old, today] } : url === '/api/concepts/today' ? today : url === '/api/concepts/old' ? old :
      url === '/api/recommend' ? { recommendId: 'r' } : url === '/api/recommend/r' ? { status: 'done', results: [{ id: 'other', reason: '补充视角' }] } :
      url === '/api/concepts/old/perspectives' ? { runId: 'p1' } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true }); t.after(() => app.dispose());
  return { doc, app, requests, get: id => doc.getElementById(id) };
}

test('v08 bento shared picker runs perspectives and terminal continuation only opens the prefilled manual builder', async t => {
  const h = await mounted(t); await h.get('concepts-open').fire('click'); await h.app.actions.selectConcept('old');
  await button(h.get('concepts-reading'), '多视角分析').fire('click');
  assert.equal(h.get('perspective-picker').open, true); assert.ok(h.get('perspective-picker').className.includes('bento-builder'));
  const check = h.get('perspective-all').querySelector('[data-agent-id="other"]'); check.checked = true; await check.fire('change');
  await h.get('perspective-submit').fire('click');
  const request = h.requests.find(r => r.url === '/api/concepts/old/perspectives');
  assert.deepEqual(request.body.agentIds, ['other']); assert.ok(request.opts.headers['X-Co-Agent-Token']);
  await button(h.get('concepts-reading'), '在终端中继续').fire('click');
  assert.equal(h.get('joint-builder').open, true); assert.match(h.get('builder-input').value, /旧概念.*Bandwidth/s);
  assert.equal(h.get('builder-cli').value, 'codex'); assert.ok(!h.requests.some(r => r.url === '/api/joint'));
});

test('v08 bento switches preserve selected concept, drafts and perspective picker selection with no concept refetch', async t => {
  const h = await mounted(t); await h.get('concepts-open').fire('click'); await h.app.actions.selectConcept('old');
  h.app.actions.setRecommendInput('保留草稿');
  await button(h.get('concepts-reading'), '多视角分析').fire('click');
  const check = h.get('perspective-all').querySelector('[data-agent-id="other"]'); check.checked = true; await check.fire('change');
  const before = h.app.snapshot().concepts, count = h.requests.filter(r => r.url.startsWith('/api/concepts')).length;
  h.app.actions.openSettings(); const choices = h.doc.querySelectorAll('[role="radio"]');
  for (const index of [0, 1, 2, 1, 3, 1]) {
    await choices[index].fire('click'); assert.deepEqual(h.app.snapshot().concepts, before);
    assert.equal(h.app.snapshot().state.view, 'concepts'); assert.equal(h.app.snapshot().recommend.input, '保留草稿');
    assert.equal(h.get('perspective-all').querySelector('[data-agent-id="other"]').checked, true);
  }
  assert.equal(h.requests.filter(r => r.url.startsWith('/api/concepts')).length, count);
  assert.equal(h.get('perspective-picker').className.includes('bento-builder'), true);
  assert.ok(visible(h.get('concepts-panel'))); assert.equal(h.get('layout-root').getAttribute('data-concepts-open'), null);
});
