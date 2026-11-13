import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import { createStatsView } from '../public/stats-view.js';
import * as bento from '../public/layouts/bento.js';

const categories = Array.from({ length: 11 }, (_, i) => `书籍分类${i}`);
function data() {
  const agents = Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, name: `Agent${String(i).padStart(2, '0')}`,
    kind: i < 4 ? 'role' : 'book', primary: categories[i % 11], purpose: i < 4 ? '检查证据' : null,
    book: i < 4 ? null : { title: `书名${i}` }, description: '说明', tags: [],
    platforms: { claude: { available: true }, codex: { available: true } }, sources: { checked: true, missing: [] }, sync: { state: '同步' } }));
  const bucket = n => ({ calls: n, ok: Math.max(0, n - 2), failed: n ? 1 : 0, unknown: n ? 1 : 0,
    bySource: { claude: Math.floor(n / 2), codex: n - Math.floor(n / 2) } });
  const stats = { generatedAt: '2026-10-08T12:00:00Z', sources: [{ id: 'fixture', available: true, failedFiles: [], scannedFiles: 1 }],
    perAgent: Object.fromEntries(agents.map((a, i) => [a.id, { last7d: bucket(i < 24 ? 25 - i : 0), last30d: bucket(i < 24 ? (25 - i) * 2 : 0),
      total: bucket(i < 24 ? (25 - i) * 3 : 0), lastAt: '2026-10-07T00:00:00Z', launches: { last7d: 999, last30d: 999, total: 999 } }])),
    limited: true, limitedReasons: ['累计归档缺口'], last7dLimited: false, last7dLimitedReasons: [], last30dLimited: true, last30dLimitedReasons: ['30 天目录不可读', '<img src=x>保留原始原因'],
    daily: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 9 + i)).toISOString().slice(0, 10), calls: i, role: 0, book: i, claude: Math.floor(i / 2), codex: i - Math.floor(i / 2) })) };
  return { stats, registry: { agents, categories, summary: { roles: 4, books: 22, synced: 26 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] } };
}
function safeDOM(doc) {
  for (const method of ['createElement', 'createElementNS']) {
    const create = doc[method]; doc[method] = (...args) => {
      const el = create(...args), set = el.setAttribute.bind(el);
      Object.defineProperty(el, 'innerHTML', { set() { assert.fail('HTML injection'); } });
      el.setAttribute = (key, value) => { assert.notEqual(key, 'style', 'CSP blocks style attributes'); set(key, value); }; return el;
    };
  }
  return doc;
}
const visible = el => !!el && !el.closest('[hidden]');
const key = (doc, name) => doc.querySelector(`[data-focus-key="stats-${name}"]`);
const rows = doc => doc.getElementById('stats-panel').querySelectorAll('.chart-bar-row');
function fixture() {
  const doc = safeDOM(documentFrom('<body><div id="layout-root"></div></body>')), calls = [], input = data();
  const view = createStatsView({ getStats: () => input.stats, getRegistry: () => input.registry, onState: () => update() });
  const actions = new Proxy({ openStats() { ctx.state.view = 'stats'; update(); }, setStatsRange: view.setRange,
    setStatsFilter: view.setFilter, setStatsCategory: view.setCategory, toggleStatsShowAll: view.toggleShowAll,
    showView(v) { ctx.state.view = v; update(); } }, { get: (target, name) => (...args) => { calls.push([name, ...args]); return target[name]?.(...args); } });
  const ctx = { doc, refs: {}, state: { view: 'catalog', detailOpen: false }, actions };
  ctx.root = bento.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  bento.renderMetrics(ctx, { recent7: 324, recentByKind: { role: 94, book: 230 }, total: 26, roles: 4, books: 22, sync: { ok: 26, total: 26 }, scopeLimited: true, scopeReasons: ['旧数据有限'], statsState: 'ready', top: [] });
  function update() { bento.renderStats(ctx, view.snapshot()); }
  update(); return { doc, ctx, input, view, update, calls, get: id => doc.getElementById(id), page: () => actions.openStats() };
}
const css = await fs.readFile('public/layouts/bento.css', 'utf8');
const source = await fs.readFile('public/layouts/bento.js', 'utf8');
function rule(selector) { const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, selector); return css.slice(start, css.indexOf('}', start)); }

test('v09 bento entries: the original metric tile and recent heading open an owned statistics page', async () => {
  const h = fixture(), entry = h.get('stats-open');
  assert.equal(entry.tagName, 'BUTTON'); assert.equal(entry.parentElement, h.get('metrics'));
  assert.match(entry.className, /metric-tile/); assert.match(entry.textContent, /近 7 天调用324/);
  assert.ok(h.get('recent-history').contains(h.get('stats-recent-open')));
  assert.equal(h.get('stats-recent-open').parentElement.parentElement, descendants(h.get('recent-history')).find(n => n.tagName === 'H2').parentElement); /* v0.14: inside .bento-recent-links */
  assert.ok(h.ctx.root.contains(h.get('stats-panel'))); assert.equal(h.doc.querySelector('.stats-default,.stats-entry'), null);
  assert.equal(h.get('stats-panel').hidden, true);
  await entry.fire('click'); assert.ok(visible(h.get('stats-panel'))); assert.equal(h.ctx.root.hidden, false);
  assert.equal(h.get('bento-grid').hidden, true); assert.equal(h.doc.activeElement, h.get('stats-title'));
  await key(h.doc, 'back').fire('click'); assert.equal(h.get('stats-panel').hidden, true);
  await h.get('stats-recent-open').fire('click'); assert.equal(h.ctx.state.view, 'stats');
});

test('v09 bento page has three numeric tiles, two donuts, a wide trend and a tall ranking with accurate totals', () => {
  const h = fixture(); h.page(); const panel = h.get('stats-panel'), m = h.view.snapshot();
  assert.equal(panel.querySelectorAll('.bento-stats-number').length, 3);
  assert.deepEqual(panel.querySelectorAll('.bento-stats-value').map(n => n.textContent), [String(m.totals.calls), String(m.totals.claude), String(m.totals.codex)]);
  assert.match(panel.textContent, new RegExp(`已调用 Agent ${m.totals.agentsUsed}`));
  for (const [label, value] of [['成功', m.totals.ok], ['失败', m.totals.failed], ['未知', m.totals.unknown]]) assert.ok(panel.textContent.includes(`${label} ${value}`));
  assert.equal(panel.querySelectorAll('.chart-donut').length, 2); assert.ok(h.get('stats-trend').querySelector('.chart-columns'));
  assert.ok(h.get('stats-ranking').querySelector('.chart-bar-list')); assert.doesNotMatch(panel.textContent, /999/);
  assert.match(panel.textContent, /调用次数不包含启动次数/);
});

test('v09 bento range/refresh/filter controls and both donut legends and slices dispatch and display selection', async () => {
  const h = fixture(); h.page();
  for (const range of ['30d', 'all', '7d']) { await key(h.doc, range).fire('click'); assert.equal(h.view.snapshot().range, range); assert.equal(key(h.doc, range).getAttribute('aria-pressed'), 'true'); }
  await key(h.doc, 'refresh').fire('click'); assert.ok(h.calls.some(c => c[0] === 'refreshStats'));
  await h.get('stats-kind').querySelector('[data-segment="role"]').fire('keydown', { key: 'Enter' });
  assert.equal(h.view.snapshot().filter, 'role'); assert.equal(key(h.doc, 'legend-role').getAttribute('aria-pressed'), 'true');
  assert.ok(rows(h.doc).every(n => Number(n.getAttribute('data-agent-id').slice(1)) < 4));
  assert.equal(h.get('stats-category').querySelector('.chart-legend').children.length, 11);
  await h.get('stats-category').querySelector('[data-segment="书籍分类5"]').fire('keydown', { key: ' ' });
  assert.equal(h.view.snapshot().categoryFilter, '书籍分类5'); assert.equal(key(h.doc, 'legend-书籍分类5').getAttribute('aria-pressed'), 'true');
  await key(h.doc, 'legend-书籍分类5').fire('click'); assert.equal(h.view.snapshot().categoryFilter, null);
  await key(h.doc, 'filter-book').fire('click'); assert.equal(h.view.snapshot().filter, 'book');
  await key(h.doc, 'filter-all').fire('click'); assert.equal(h.view.snapshot().filter, 'all');
});

test('v09 bento daily columns retain all 30 days across ranges/filters and expose source values on focus', async () => {
  const h = fixture(); h.page(); const daily = h.view.snapshot().daily;
  for (const range of ['7d', '30d', 'all']) {
    h.view.setRange(range); h.view.setFilter('role'); const trend = h.get('stats-trend');
    const points = trend.querySelectorAll('[data-point]'); assert.equal(points.length, 30);
    await points[29].fire('focus'); assert.match(trend.querySelector('.chart-tooltip').textContent, /2026-10-08：29（claude 14，codex 15）/);
    assert.match(trend.textContent, /近 30 天全部 Agent.*本机时区/);
    assert.equal(trend.querySelector('.chart-data').children.length, 30); assert.deepEqual(h.view.snapshot().daily, daily);
  }
});

test('v09 bento ranking shows sorted top20, exact Claude/Codex stacks, expands zeros and opens detail', async () => {
  const h = fixture(); h.page(); let list = rows(h.doc);
  assert.equal(list.length, 20); assert.equal(list[0].getAttribute('data-agent-id'), 'a0');
  assert.equal(list.at(-1).getAttribute('data-agent-id'), 'a19'); assert.match(list[0].textContent, /检查证据/);
  const parts = list[0].querySelectorAll('[data-part]'); assert.deepEqual(parts.map(n => n.getAttribute('data-part')), ['claude', 'codex']);
  assert.deepEqual(parts.map(n => Number(n.getAttribute('width'))), [48, 52]);
  assert.match(key(h.doc, 'expand').textContent, /展开全部（26）/); assert.match(h.get('stats-ranking').textContent, /未调用的 Agent：2 个/);
  await key(h.doc, 'expand').fire('click'); list = rows(h.doc); assert.equal(list.length, 26);
  assert.equal(list.filter(n => n.className.includes('chart-zero')).length, 2); assert.match(list[4].textContent, /《书名4》/);
  await list[25].fire('click'); assert.equal(h.calls.at(-1)[0], 'openDetail'); assert.equal(h.calls.at(-1)[1], 'a25');
  await key(h.doc, 'expand').fire('click'); assert.equal(rows(h.doc).length, 20);
});

test('v09 bento limited-data reasons remain literal and empty/loading/unavailable are distinct', async () => {
  const h = fixture(); h.page(); h.view.setRange('30d');
  assert.match(h.get('stats-panel').textContent, /30 天目录不可读.*<img src=x>保留原始原因/);
  assert.equal(h.get('stats-panel').querySelector('img'), null); assert.equal(h.get('stats-limited').getAttribute('role'), 'status');
  h.input.stats.building = true; h.update(); assert.match(h.get('stats-panel').textContent, /统计正在建立/);
  assert.equal(h.get('stats-panel').querySelectorAll('.chart-donut').length, 0); assert.equal(rows(h.doc).length, 0);
  assert.ok(h.get('stats-panel').querySelectorAll('.bento-stats-value').every(n => n.textContent === '—'));
  h.input.stats.building = false; delete h.input.stats.perAgent.a0.last30d; h.update(); assert.match(h.get('stats-panel').textContent, /调用统计暂不可用/);
  assert.doesNotMatch(h.get('stats-panel').textContent, /未调用的 Agent：0/);
  h.view.setRange('7d');
  for (const agent of Object.values(h.input.stats.perAgent)) agent.last7d = { calls: 0, ok: 0, failed: 0, unknown: 0, bySource: { claude: 0, codex: 0 } };
  h.update(); assert.match(h.get('stats-panel').textContent, /该时间范围内没有调用/);
  assert.equal(h.get('stats-panel').querySelectorAll('[data-segment]').length, 0);
  assert.match(h.get('stats-ranking').textContent, /未调用的 Agent：26 个/); await key(h.doc, 'expand').fire('click'); assert.equal(rows(h.doc).length, 26);
});

test('v09 bento charts use local palette classes, stable category colors, accessible alternatives and no inline HTML/styles', () => {
  const h = fixture(); h.page(); const before = h.view.snapshot(); bento.renderStats(h.ctx, before); assert.deepEqual(h.view.snapshot(), before);
  const panel = h.get('stats-panel'), color = panel.querySelector('[data-segment="书籍分类5"]').getAttribute('class');
  h.view.setRange('all'); assert.equal(panel.querySelector('[data-segment="书籍分类5"]').getAttribute('class'), color);
  for (const chart of panel.querySelectorAll('.chart-donut,.chart-columns,.chart-bar-list')) { assert.ok(chart.querySelector('title')); assert.ok(chart.querySelector('.chart-data')); }
  for (const el of descendants(panel)) assert.equal(el.getAttribute('style'), null);
  for (const name of ['claude', 'codex', ...Array.from({ length: 11 }, (_, i) => `color-${i}`)]) assert.match(rule(`[data-ui="bento"] .bento-stats-${name}`), /fill:\s*#[0-9a-f]{6}/i);
  assert.doesNotMatch(source, /renderDefaultStats|innerHTML|outerHTML|insertAdjacentHTML|\.cssText|setAttribute\(['"]style/);
  assert.doesNotMatch(css, /@import|https?:|url\(/);
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) if (!m[1].trim().startsWith('@media')) assert.ok(m[1].split(',').every(s => s.trim().startsWith('[data-ui="bento"]')), m[1]);
});

test('v09 bento statistics grid keeps original radii, spacing, type scale and responsive single-column reading', () => {
  assert.match(rule('[data-ui="bento"] .bento-stats-grid'), /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(rule('[data-ui="bento"] .bento-stats-grid'), /gap:\s*16px/);
  assert.match(rule('[data-ui="bento"] .bento-stats-tile'), /border-radius:\s*24px/);
  assert.match(rule('[data-ui="bento"] .bento-stats-tile'), /padding:\s*22px/);
  assert.match(rule('[data-ui="bento"] .bento-stats-value'), /font-size:\s*64px/);
  assert.match(rule('[data-ui="bento"] .bento-stats-ranking'), /grid-column:\s*7\s*\/\s*-1/);
  assert.match(rule('[data-ui="bento"] .bento-stats-ranking'), /grid-row:\s*1\s*\/\s*4/);
  assert.match(rule('[data-ui="bento"] .bento-stats-trend'), /grid-column:\s*1\s*\/\s*7/);
  assert.match(css.slice(css.indexOf('@media(max-width:600px)')), /\.bento-stats-grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('v09 bento unchanged polling preserves chart nodes, focused controls and grid scroll state', () => {
  const h = fixture(); h.page(); const panel = h.get('stats-panel'), chart = panel.querySelector('.chart-bar-list'), control = key(h.doc, 'expand');
  control.focus(); chart.scrollTop = 80; h.update();
  assert.equal(panel.querySelector('.chart-bar-list'), chart); assert.equal(chart.scrollTop, 80); assert.equal(h.doc.activeElement, control); assert.equal(control.isConnected, true);
});

test('v09 bento app switches preserve range/category/expansion/draft, focused slices and detail reachability', async t => {
  const { doc } = await appDocument('bento'), input = data(), requests = []; safeDOM(doc);
  const app = await mountApp(doc, async (url, opts = {}) => {
    requests.push(url); const body = opts.body ? JSON.parse(opts.body) : {};
    const value = url === '/api/registry' ? input.registry : url.startsWith('/api/stats') ? input.stats : url === '/api/settings' ? { ui: body.ui || 'bento', recommend: { claude: { model: 'fixture' }, codex: { model: 'fixture' } } } : url === '/api/concepts?limit=30' ? { items: [], today: null, running: null } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true }); t.after(() => app.dispose());
  await doc.getElementById('stats-open').fire('click'); await key(doc, '30d').fire('click');
  const slice = doc.getElementById('stats-panel').querySelector('[data-segment="book"]'); slice.focus(); await slice.fire('keydown', { key: 'Enter' });
  assert.equal(doc.activeElement.getAttribute('data-segment'), 'book'); assert.equal(doc.activeElement.isConnected, true);
  await key(doc, 'legend-书籍分类5').fire('click'); await key(doc, 'expand').fire('click');
  app.actions.setRecommendInput('保留草稿'); const before = app.snapshot().stats, reads = requests.filter(u => u === '/api/stats').length;
  app.actions.openSettings(); const choices = doc.querySelectorAll('[role="radio"]');
  for (const index of [0, 1, 2, 1, 3, 1]) {
    await choices[index].fire('click'); assert.deepEqual(app.snapshot().stats, before); assert.equal(app.snapshot().recommend.input, '保留草稿');
    assert.equal(app.snapshot().state.view, 'stats');
  }
  assert.equal(requests.filter(u => u === '/api/stats').length, reads); assert.equal(doc.getElementById('layout-root').getAttribute('data-stats-open'), null);
  assert.ok(visible(doc.getElementById('stats-panel'))); assert.equal(doc.querySelector('.stats-default'), null);
  doc.getElementById('settings-dialog').close(); await rows(doc)[0].fire('click');
  assert.equal(app.snapshot().state.selectedId, 'a5'); assert.equal(doc.getElementById('detail').open, true);
  assert.equal(doc.getElementById('stats-panel').hidden, true); assert.ok(!requests.some(u => /\/api\/(launch|joint|resume)$/.test(u)));
});
