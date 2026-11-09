import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { createStatsView } from '../public/stats-view.js';
import * as shelf from '../public/layouts/shelf.js';

const categories = ['投资／金融与金钱管理', '心理／认知与行为', '睡眠／健康／运动', '软件工程', '艺术／美学',
  '思维／逻辑／因果与不确定性', '经济学／经济史／博弈论', '商业／传记／组织管理', '哲学／神话', '学习／研究／工作方法', '科学／技术与社会'];
const agents = Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, name: `Agent${String(i).padStart(2, '0')}`,
  kind: i < 3 ? 'role' : 'book', primary: categories[i % 11], purpose: i < 3 ? '开发协调' : null,
  book: i < 3 ? null : { title: `书名 ${i}`, author: '作者' }, description: '说明', tags: [],
  platforms: { claude: { available: true }, codex: { available: true } }, sources: { checked: true, missing: [] }, sync: { state: '同步' } }));
const registry = { agents, categories, summary: { roles: 3, books: 23, synced: 26 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const bucket = calls => ({ calls, ok: Math.max(0, calls - 2), failed: calls ? 1 : 0, unknown: calls ? 1 : 0,
  bySource: { claude: Math.ceil(calls / 2), codex: Math.floor(calls / 2) } });
function data() {
  return { generatedAt: '2026-10-08T12:00:00Z', sources: [{ id: 'fixture', available: true, failedFiles: [], scannedFiles: 1 }],
    perAgent: Object.fromEntries(agents.map((a, i) => { const n = i < 24 ? (i < 2 ? 24 : 25 - i) : 0;
      return [a.id, { last7d: bucket(n), last30d: bucket(n * 2), total: bucket(n * 3), lastAt: '2026-10-07T00:00:00Z' }]; })),
    limited: true, limitedReasons: ['累计：旧存档不可读'], last7dLimited: false, last7dLimitedReasons: [],
    last30dLimited: true, last30dLimitedReasons: ['30 天：缺少 9 月日志', '部分文件未完成扫描'],
    daily: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 9 + i)).toISOString().slice(0, 10),
      calls: i * 2, role: i, book: i, claude: i, codex: i })) };
}
function safeDocument(html) {
  const doc = documentFrom(html);
  for (const name of ['createElement', 'createElementNS']) {
    const create = doc[name]; doc[name] = (...args) => {
      const el = create(...args), set = el.setAttribute.bind(el);
      for (const sink of ['innerHTML', 'outerHTML']) Object.defineProperty(el, sink, { set() { assert.fail(sink); } });
      el.setAttribute = (key, value) => { assert.notEqual(key, 'style', 'CSP rejects style attributes'); set(key, value); };
      return el;
    };
  }
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  return doc;
}
const key = (root, id) => root.querySelector(`[data-focus-key="stats-${id}"]`);
const shown = node => !!node && !node.closest('[hidden]');
async function fixture(t, stats = data()) {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="stats-fixture">');
  const doc = safeDocument(html); doc.documentElement.setAttribute('data-ui', 'shelf'); const requests = [];
  const app = await mountApp(doc, async (url, opts = {}) => {
    requests.push({ url, opts }); const body = opts.body ? JSON.parse(opts.body) : {};
    const result = url === '/api/registry' ? registry : ['/api/stats', '/api/stats/refresh'].includes(url) ? stats :
      url === '/api/settings' ? { ui: body.ui || 'shelf', recommend: { codex: { model: 'fixture' } } } :
      url === '/api/concepts?limit=30' ? { items: [], today: null, running: null } : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(result) };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, requests, get: id => doc.getElementById(id), open: () => doc.getElementById('stats-open').fire('click') };
}
function unit(model) {
  const doc = safeDocument('<html><body><div id="layout-root"></div></body></html>'), calls = [];
  const actions = new Proxy({}, { get: (_, action) => (...args) => calls.push({ action, args }) });
  const ctx = { doc, actions, refs: {}, state: { view: 'stats', category: 'all', query: '', selectedId: null,
    jointSelectedIds: [], allAgents: agents, categories, detailOpen: false } };
  ctx.root = shelf.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const draw = () => shelf.renderStats(ctx, model); draw();
  return { doc, ctx, calls, model, draw, panel: doc.getElementById('stats-panel') };
}
const model = stats => createStatsView({ getStats: () => stats, getRegistry: () => registry }).snapshot();

test('v09 shelf top-bar entry opens an integrated cream statistics board and returns without clearing catalog choices', async t => {
  const h = await fixture(t); h.app.actions.selectCategory(categories[2]); h.app.actions.search('Agent');
  const entry = h.get('stats-open'); assert.equal(entry.textContent, '借阅统计'); assert.ok(entry.closest('.shelf-header'));
  entry.focus(); await h.open(); const panel = h.get('stats-panel');
  assert.ok(shown(panel)); assert.ok(panel.closest('.layout-shelf')); assert.ok(shown(h.get('brand')));
  assert.match(panel.className, /shelf-stats-board/); assert.equal(h.get('stats-title').textContent, '借阅统计板');
  assert.equal(h.doc.activeElement, h.get('stats-title')); assert.ok(!shown(h.get('catalog'))); assert.ok(!shown(h.get('shelf-back')));
  assert.equal(panel.querySelectorAll('.shelf-stats-card').length, 4);
  assert.equal(panel.querySelectorAll('.chart-donut').length, 2); assert.ok(panel.querySelector('.chart-columns'));
  assert.match(panel.querySelector('.shelf-stats-ranking').textContent, /借阅排行/);
  const ids = descendants(h.doc.documentElement).map(n => n.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'statistics controls must not duplicate existing page IDs');
  key(panel, 'back').focus(); await key(panel, 'back').fire('click');
  assert.equal(h.app.snapshot().state.view, 'catalog'); assert.equal(h.app.snapshot().state.category, categories[2]);
  assert.equal(h.app.snapshot().state.query, 'Agent'); assert.equal(h.doc.activeElement, entry);
});

test('v09 shelf range buttons use all three shared windows, display exact totals, limits and refresh', async t => {
  const h = await fixture(t); await h.open(); const panel = h.get('stats-panel');
  for (const [range, label] of [['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '累计']]) {
    const button = key(panel, range); assert.equal(button.textContent, label); button.focus(); await button.fire('click');
    assert.equal(h.app.snapshot().stats.range, range); assert.equal(key(panel, range).getAttribute('aria-pressed'), 'true');
    assert.equal(h.doc.activeElement, key(panel, range));
    const totals = h.app.snapshot().stats.totals;
    assert.equal(panel.querySelector('[data-stat="calls"]').textContent, String(totals.calls));
    assert.match(panel.textContent, new RegExp(`Claude ${totals.claude}.*Codex ${totals.codex}`));
    if (range !== '7d') for (const reason of h.app.snapshot().stats.limitedReasons) assert.ok(panel.querySelector('.shelf-stats-limited').textContent.includes(reason));
  }
  await key(panel, 'refresh').fire('click'); assert.ok(h.requests.some(r => r.url === '/api/stats/refresh' && r.opts.method === 'POST'));
});

test('v09 shelf both donuts filter via slices and legends; all eleven categories keep stable spine colors across ranges', async t => {
  const stats = data(); stats.perAgent.a10.last30d = bucket(900);
  const h = await fixture(t, stats); await h.open(); const panel = h.get('stats-panel');
  const colors = Object.fromEntries(panel.querySelector('.shelf-stats-categories').querySelectorAll('[data-segment]').map(n => [n.getAttribute('data-segment'), n.className]));
  assert.equal(Object.keys(colors).length, 11); assert.equal(new Set(Object.values(colors)).size, 11);
  assert.equal(panel.querySelector('.shelf-stats-categories').querySelectorAll('.chart-legend')[0].children.length, 11);
  const slice = panel.querySelector('[data-segment="role"]'); slice.focus(); await slice.fire('keydown', { key: 'Enter' });
  assert.equal(h.app.snapshot().stats.filter, 'role'); assert.equal(h.doc.activeElement.getAttribute('data-segment'), 'role');
  assert.equal(h.doc.activeElement.getAttribute('aria-pressed'), 'true');
  await key(panel, 'legend-book').fire('click'); assert.ok(h.app.snapshot().stats.agents.every(a => a.kind === 'book'));
  const total = h.app.snapshot().stats.totals.calls;
  await key(panel, `legend-${categories[5]}`).fire('click');
  assert.equal(h.app.snapshot().stats.categoryFilter, categories[5]); assert.equal(h.app.snapshot().stats.totals.calls, total);
  assert.ok(h.app.snapshot().stats.agents.every(a => a.category === categories[5]));
  assert.equal(key(panel, `legend-${categories[5]}`).getAttribute('aria-pressed'), 'true');
  await key(panel, `legend-${categories[5]}`).fire('click'); assert.equal(h.app.snapshot().stats.filter, 'all');
  await key(panel, '30d').fire('click');
  for (const slice of panel.querySelector('.shelf-stats-categories').querySelectorAll('[data-segment]')) assert.equal(slice.className, colors[slice.getAttribute('data-segment')]);
  await key(panel, `legend-${categories[5]}`).fire('click'); await key(panel, 'category').fire('click');
  assert.equal(h.app.snapshot().stats.categoryFilter, null);
});

test('v09 shelf trend retains thirty days and both CLI stacks across filters; hover/focus disclose the exact date', async t => {
  const h = await fixture(t); await h.open(); const panel = h.get('stats-panel');
  assert.match(panel.querySelector('.shelf-stats-trend').textContent, /近 30 天.*全部 Agent.*Asia\/Shanghai/);
  for (const range of ['7d', '30d', 'all']) {
    await key(panel, range).fire('click'); await key(panel, 'filter-role').fire('click');
    const trend = panel.querySelector('.chart-columns'), points = trend.querySelectorAll('[data-point]'); assert.equal(points.length, 30);
    for (const event of ['focus', 'mouseenter']) { await points[9].fire(event); assert.match(trend.querySelector('.chart-tooltip').textContent, /2026-09-18：18（claude 9，codex 9）/); }
    // v0.29 B: both sources are stacked areas; the hover card lists each source and the total.
    assert.equal(trend.querySelectorAll('.chart-trend-area').length, 2); assert.equal(trend.querySelector('.chart-trend-card').children.filter(n => n.className.startsWith('chart-trend-row')).length, 3);
    assert.equal(trend.querySelector('.chart-data').children.length, 30);
    assert.ok(trend.querySelector('title')); assert.equal(points[0].getAttribute('tabindex'), '0');
  }
});

test('v09 shelf spine ranking is descending with named ties, top20, stacked ratios, expansion, zero group and details', async t => {
  const h = await fixture(t); await h.open(); const panel = h.get('stats-panel');
  let rows = panel.querySelectorAll('.chart-bar-row'); assert.equal(rows.length, 20);
  assert.deepEqual(rows.map(n => n.getAttribute('data-agent-id')), h.app.snapshot().stats.agents.map(a => a.id));
  assert.deepEqual(rows.slice(0, 2).map(n => n.getAttribute('data-agent-id')), ['a0', 'a1']);
  assert.equal(rows[0].querySelector('[data-part="claude"]').getAttribute('width'), '50');
  assert.equal(rows[0].querySelector('[data-part="codex"]').getAttribute('x'), '50');
  assert.match(rows[0].textContent, /开发协调/); assert.match(rows[3].textContent, /书名/);
  const zero = panel.querySelector('.shelf-stats-zero'); assert.match(zero.textContent, /未调用的 Agent：2 个/); assert.equal(zero.querySelectorAll('.chart-bar-row').length, 0);
  assert.equal(key(panel, 'expand').textContent, '展开全部（26）'); await key(panel, 'expand').fire('click');
  assert.equal(panel.querySelectorAll('.chart-bar-row').length, 26); assert.equal(panel.querySelector('.shelf-stats-zero').querySelectorAll('.chart-zero').length, 2);
  assert.equal(key(panel, 'expand').getAttribute('aria-expanded'), 'true');
  await key(panel, 'expand').fire('click'); assert.equal(panel.querySelectorAll('.chart-bar-row').length, 20);
  await panel.querySelector('[data-agent-id="a4"]').fire('click');
  assert.equal(h.app.snapshot().state.selectedId, 'a4'); assert.equal(h.app.snapshot().state.detailOpen, true); assert.equal(h.get('detail').open, true);
  assert.equal(h.requests.some(r => /\/api\/(launch|joint)/.test(r.url)), false);
});

test('v09 shelf empty and filtered-empty ranges retain controls, eleven zero legends and expandable uncalled agents', async t => {
  const stats = data(); for (const value of Object.values(stats.perAgent)) value.last7d = bucket(0);
  const h = await fixture(t, stats); await h.open(); const panel = h.get('stats-panel');
  assert.match(panel.textContent, /该时间范围内没有调用/); assert.equal(panel.querySelectorAll('.chart-slice').length, 0);
  assert.equal(panel.querySelector('.shelf-stats-categories').querySelector('.chart-legend').children.length, 11);
  assert.match(panel.textContent, /未调用的 Agent：26 个/); await key(panel, 'expand').fire('click'); assert.equal(panel.querySelectorAll('.chart-zero').length, 26);
  await key(panel, '30d').fire('click'); assert.equal(h.app.snapshot().stats.showAll, false); assert.ok(panel.querySelector('.chart-slice'));
  await key(panel, '7d').fire('click'); await key(panel, 'filter-book').fire('click');
  assert.match(panel.querySelector('.shelf-stats-ranking').textContent, /当前筛选没有调用/);
});

test('v09 shelf loading and unavailable data never draw stale charts or invent zero totals', () => {
  for (const status of ['loading', 'unavailable']) {
    const m = { ...model(data()), status, limited: true, limitedReasons: ['统计来源 <script>不可读</script>'],
      totals: { calls: null, claude: null, codex: null, agentsUsed: null }, agents: [] };
    const h = unit(m); assert.match(h.panel.textContent, status === 'loading' ? /统计正在建立/ : /调用统计暂不可用/);
    assert.equal(h.panel.querySelector('.chart-donut'), null); assert.equal(h.panel.querySelector('.chart-bar-row'), null);
    assert.equal(h.panel.querySelector('script'), null); assert.ok(shown(key(h.panel, 'refresh'))); assert.ok(shown(key(h.panel, '30d')));
    assert.doesNotMatch(h.panel.textContent, /未调用的 Agent：0|Claude 0|Codex 0/);
  }
});

test('v09 shelf polling retains chart nodes and focus; switching layouts preserves statistics and existing drafts', async t => {
  const h = await fixture(t); h.app.actions.search('Agent'); h.app.actions.setRecommendInput('保留草稿'); h.app.actions.addToJoint('a3', undefined, false);
  await h.open(); let panel = h.get('stats-panel'); await key(panel, '30d').fire('click');
  await key(panel, `legend-${categories[5]}`).fire('click'); await key(panel, 'expand').fire('click');
  const row = panel.querySelector('.chart-bar-row'); row.focus(); await h.app.actions.refreshStats(); assert.equal(panel.querySelector('.chart-bar-row'), row); assert.equal(h.doc.activeElement, row);
  const expected = h.app.snapshot(), requests = h.requests.length; h.app.actions.openSettings();
  for (const index of [0, 1, 2, 3]) {
    await h.doc.querySelectorAll('[role="radio"]')[index].fire('click');
    const actual = h.app.snapshot(); assert.deepEqual(actual.stats, expected.stats); assert.equal(actual.state.view, 'stats');
    assert.equal(actual.state.query, 'Agent'); assert.equal(actual.recommend.input, '保留草稿'); assert.deepEqual(actual.state.jointSelectedIds, ['a3']);
  }
  panel = h.get('stats-panel'); assert.ok(shown(panel)); assert.ok(panel.closest('.layout-shelf'));
  assert.equal(h.doc.activeElement.closest('dialog')?.id, 'settings-dialog');
  assert.equal(h.requests.slice(requests).filter(r => r.url !== '/api/settings').length, 0);
});

test('v09 shelf uses shared SVG charts without unsafe HTML, style attributes, network or mutations; all CSS is scoped', async () => {
  const m = model(data()); m.agents[0].name = '<img src=x onerror=boom>'; m.agents[0].purpose = '<example>literal</example>';
  const before = structuredClone(m), h = unit(m); h.draw(); assert.deepEqual(m, before); assert.deepEqual(h.calls, []);
  assert.equal(h.panel.querySelector('img'), null); assert.ok(h.panel.textContent.includes('<img src=x onerror=boom>'));
  assert.ok(h.panel.querySelectorAll('.chart-data').length >= 4); assert.ok(descendants(h.panel).every(n => n.getAttribute('style') === null));
  const source = await fs.readFile('public/layouts/shelf.js', 'utf8'), css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(source, /from ['"]\.\.\/charts\.js['"]/); assert.doesNotMatch(source, /renderDefaultStats|innerHTML|outerHTML|insertAdjacentHTML|cssText|\bfetch\s*\(/);
  assert.doesNotMatch(css, /@import|https?:/);
  for (const [, selectors] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const selector of selectors.split(',')) assert.match(selector, /\[data-ui="shelf"\]/);
  assert.match(css, /\.shelf-stats-card\s*\{[^}]*background:\s*#f3e9d8/);
  assert.match(css, /\.shelf-stats-card\s*\{[^}]*border-radius:\s*6px/);
  assert.match(css, /\.shelf-stats-ranking \.chart-bar-row\s*\{[^}]*border-left:/);
  for (let i = 0; i < 11; i++) assert.ok(css.includes(`.shelf-chart-${i}`));
});
