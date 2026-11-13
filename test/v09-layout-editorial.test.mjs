import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { createStatsView } from '../public/stats-view.js';
import * as editorial from '../public/layouts/editorial.js';

const categories = Array.from({ length: 11 }, (_, i) => `分类${i}`);
const agents = Array.from({ length: 27 }, (_, i) => ({
  id: `a${i}`, name: i === 0 ? 'Walvo' : `Author ${String(i).padStart(2, '0')}`, kind: i < 4 ? 'role' : 'book',
  primary: categories[i % 11], purpose: i < 4 ? `用途 ${i}` : null,
  book: i < 4 ? null : { title: `书籍 ${i}`, author: '作者' }, description: '来源说明', tags: [],
  sources: { checked: true, missing: [] }, sync: { state: '同步' },
  platforms: { claude: { available: true }, codex: { available: true } },
}));
const registry = { agents, categories, summary: { roles: 4, books: 23, synced: 27 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const bucket = n => ({ calls: n, ok: n, failed: 0, unknown: 0, bySource: { claude: Math.ceil(n / 2), codex: Math.floor(n / 2) } });
function statistics() {
  return {
    generatedAt: '2026-10-08T01:00:00Z', sources: [{ id: 'fixture', available: true, failedFiles: [] }],
    perAgent: Object.fromEntries(agents.map((agent, i) => {
      const n = i < 25 ? (i === 2 ? 24 : 25 - i) : 0;
      return [agent.id, { last7d: bucket(n), last30d: bucket(n * 2), total: bucket(n * 3), lastAt: null }];
    })),
    limited: true, limitedReasons: ['累计文件不完整'], last7dLimited: false, last7dLimitedReasons: [],
    last30dLimited: true, last30dLimitedReasons: ['30 天缺口 <script>literal</script>'],
    daily: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 9 + i)).toISOString().slice(0, 10),
      calls: i, role: 0, book: i, claude: Math.ceil(i / 2), codex: Math.floor(i / 2) })),
  };
}
function guard(doc) {
  for (const method of ['createElement', 'createElementNS']) {
    const create = doc[method];
    doc[method] = (...args) => {
      const el = create(...args), attr = el.setAttribute.bind(el);
      el.setAttribute = (key, value) => { assert.notEqual(key.toLowerCase(), 'style', 'CSP forbids style attributes'); attr(key, value); };
      for (const key of ['innerHTML', 'outerHTML']) Object.defineProperty(el, key, { set() { assert.fail(`${key} is forbidden`); } });
      return el;
    };
  }
  return doc;
}
const visible = node => !!node && !node.closest('[hidden]');
const key = (root, value) => root.querySelector(`[data-focus-key="stats-${value}"]`);
const rows = panel => panel.querySelectorAll('.chart-bar-row');
async function fixture(t, data = statistics()) {
  const { doc } = await appDocument('editorial'); guard(doc);
  const requests = [];
  const app = await mountApp(doc, async (url, opts = {}) => {
    requests.push({ url, opts }); const body = opts.body ? JSON.parse(opts.body) : {};
    const value = url === '/api/registry' ? registry : url === '/api/stats' || url === '/api/stats/refresh' ? data :
      url === '/api/settings' ? { ui: body.ui || 'editorial', recommend: { claude: { model: 'fixture' }, codex: { model: 'fixture' } } } :
      url === '/api/concepts?limit=30' ? { items: [], today: null, running: null } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  await doc.getElementById('stats-open').fire('click');
  return { app, doc, requests, data, panel: doc.getElementById('stats-panel') };
}
function isolated(t, data = statistics()) {
  const doc = guard(documentFrom('<body></body>')), calls = [];
  const ctx = { doc, refs: {}, state: { view: 'stats', allAgents: agents, categories },
    actions: { showView: value => calls.push(value), refreshStats: () => calls.push('refresh') } };
  ctx.root = editorial.render(ctx); doc.body.append(ctx.root);
  const model = createStatsView({ getStats: () => data, getRegistry: () => registry }).snapshot();
  editorial.renderStats(ctx, model); t.after(() => ctx.refs.dispose());
  return { doc, ctx, model, calls, panel: doc.getElementById('stats-panel') };
}

test('v09 editorial: eighth masthead entry opens the owned 数据专栏, with return focus and mutually exclusive pages', async t => {
  const { doc, app, panel } = await fixture(t);
  assert.deepEqual(doc.querySelector('.editorial-columns').children.filter(n => !n.hidden).map(n => n.textContent),
    ['目录', '人物', '藏书', '调用组', '推荐', '概念', '圆桌', '会诊室', '顾问团', '概念地图', '对话', '统计', '往期', '设置']);
  assert.ok(doc.getElementById('stats-open').closest('.editorial-masthead'));
  assert.ok(panel.closest('.layout-editorial')); assert.ok(visible(panel));
  assert.ok(visible(doc.querySelector('.editorial-masthead'))); assert.equal(visible(doc.querySelector('.editorial-spread')), false);
  assert.equal(visible(doc.getElementById('concepts-panel')), false); assert.equal(doc.querySelector('.stats-default'), null);
  assert.equal(doc.activeElement.id, 'editorial-stats-title'); assert.equal(doc.activeElement.textContent, '数据专栏');
  assert.equal(doc.getElementById('stats-open').getAttribute('aria-current'), 'page');
  key(panel, 'back').focus(); await key(panel, 'back').fire('click');
  assert.equal(app.snapshot().state.view, 'catalog'); assert.equal(panel.hidden, true);
  assert.ok(visible(doc.querySelector('.editorial-spread'))); assert.equal(doc.activeElement.id, 'stats-open');
  await app.actions.openConcepts(); assert.ok(visible(doc.getElementById('concepts-panel')));
  await doc.getElementById('stats-open').fire('click'); assert.ok(visible(panel)); assert.equal(visible(doc.getElementById('concepts-panel')), false);
});

test('v09 editorial: range controls use global totals, expose selection, refresh and precise coverage reasons', async t => {
  const { app, panel, requests } = await fixture(t);
  for (const range of ['7d', '30d', 'all']) {
    await key(panel, range).fire('click');
    assert.equal(app.snapshot().stats.range, range);
    assert.equal(key(panel, range).getAttribute('aria-pressed'), 'true');
    assert.equal(panel.querySelector('.editorial-stats-total').textContent, String(app.snapshot().stats.totals.calls));
    assert.match(panel.querySelector('.editorial-stats-intro').textContent, /Claude.*Codex/);
  }
  assert.match(panel.querySelector('.stats-limited').textContent, /累计文件不完整/);
  await key(panel, '30d').fire('click');
  assert.match(panel.querySelector('.stats-limited').textContent, /30 天缺口 <script>literal<\/script>/);
  assert.equal(panel.querySelector('.stats-limited').getAttribute('role'), 'status');
  await key(panel, '7d').fire('click'); assert.equal(visible(panel.querySelector('.stats-limited')), false);
  const before = requests.filter(r => r.url === '/api/stats/refresh').length;
  await key(panel, 'refresh').fire('click');
  assert.equal(requests.filter(r => r.url === '/api/stats/refresh').length, before + 1);
  assert.equal(panel.querySelectorAll('script').length, 0);
});

test('v09 editorial: captioned donuts retain all eleven categories, support mouse and keyboard filters and expose selection', async t => {
  const { app, panel } = await fixture(t), total = app.snapshot().stats.totals.calls;
  const donuts = panel.querySelectorAll('.chart-donut'); assert.equal(donuts.length, 2);
  for (const chart of donuts) { assert.ok(chart.closest('figure').querySelector('figcaption')); assert.ok(chart.querySelector('title')); assert.ok(chart.querySelector('.chart-data')); }
  assert.equal(donuts[1].querySelector('.chart-legend').children.length, 11);
  const book = panel.querySelector('[data-segment="book"]'); book.focus(); await book.fire('keydown', { key: ' ' });
  assert.equal(app.snapshot().stats.filter, 'book'); assert.equal(panel.querySelector('[data-segment="book"]').getAttribute('aria-pressed'), 'true');
  assert.equal(app.snapshot().stats.totals.calls, total);
  await key(panel, 'legend-role').fire('click'); assert.equal(app.snapshot().stats.filter, 'role'); assert.equal(rows(panel).length, 4);
  const category = panel.querySelector('[data-segment="分类5"]'); category.focus(); await category.fire('keydown', { key: 'Enter' });
  assert.equal(app.snapshot().stats.categoryFilter, '分类5'); assert.ok(app.snapshot().stats.agents.every(a => a.category === '分类5'));
  assert.equal(key(panel, 'legend-分类5').getAttribute('aria-pressed'), 'true');
  assert.match(panel.querySelector('.editorial-stats-ranking').textContent, /分类5/);
  await key(panel, 'category').fire('click'); assert.equal(app.snapshot().stats.filter, 'all');
  await key(panel, 'legend-分类5').fire('click'); await key(panel, 'legend-分类5').fire('click');
  assert.equal(app.snapshot().stats.categoryFilter, null); assert.equal(app.snapshot().stats.filter, 'all');
  await key(panel, 'filter-book').fire('click'); assert.equal(app.snapshot().stats.filter, 'book');
  await key(panel, 'filter-all').fire('click'); assert.equal(app.snapshot().stats.filter, 'all');
});

test('v09 editorial: category colors are stable across rank changes, zero categories remain selectable', t => {
  const data = statistics(), { ctx, model, panel } = isolated(t, data);
  const colors = new Map(model.byCategory.map(c => [c.key, panel.querySelector(`[data-segment="${c.key}"]`).getAttribute('class')]));
  for (const agent of agents) if (agent.primary === '分类5') data.perAgent[agent.id].last7d = bucket(0);
  const next = createStatsView({ getStats: () => data, getRegistry: () => registry }).snapshot();
  editorial.renderStats(ctx, next);
  assert.equal(panel.querySelector('[data-segment="分类5"]'), null); assert.ok(key(panel, 'legend-分类5'));
  assert.equal(panel.querySelectorAll('.chart-legend')[1].children.length, 11);
  for (const c of next.byCategory.filter(c => c.value)) assert.equal(panel.querySelector(`[data-segment="${c.key}"]`).getAttribute('class'), colors.get(c.key));
});

test('v09 editorial: fixed thirty-day stacked columns retain dates, accessible data and focus/hover values across ranges', async t => {
  const { app, panel, data } = await fixture(t);
  for (const range of ['7d', '30d', 'all']) {
    await key(panel, range).fire('click'); await key(panel, 'filter-role').fire('click');
    const chart = panel.querySelector('.chart-columns'), days = chart.querySelectorAll('[data-point]');
    assert.equal(days.length, 30); assert.equal(chart.querySelector('.chart-data').children.length, 30);
    assert.match(chart.closest('figure').querySelector('figcaption').textContent, /30 天.*本机时区/);
    assert.match(chart.textContent, new RegExp(data.daily[0].day)); assert.match(chart.textContent, new RegExp(data.daily.at(-1).day));
    // v0.29 B: one stacked area per source; each day's split lives in its label and the hover card.
    assert.deepEqual(chart.querySelectorAll('.chart-trend-area').map(n => n.getAttribute('data-part')), ['Claude', 'Codex']);
    assert.match(days[0].getAttribute('aria-label'), /Claude 0/);
    await days.at(-1).fire('focus'); assert.match(chart.querySelector('.chart-tooltip').textContent, /29.*Claude 15.*Codex 14/);
    await days[2].fire('mouseenter'); assert.match(chart.querySelector('.chart-tooltip').textContent, /2.*Claude 1.*Codex 1/);
    assert.equal(app.snapshot().stats.daily.length, 30);
  }
});

test('v09 editorial: numbered top twenty ranking follows counts and name ties, with proportional stacks, metadata and detail action', async t => {
  const { app, panel } = await fixture(t), model = app.snapshot().stats;
  assert.equal(rows(panel).length, 20);
  assert.deepEqual(rows(panel).map(n => n.getAttribute('data-agent-id')), model.agents.map(a => a.id));
  assert.deepEqual(rows(panel).map(n => n.querySelector('.editorial-stats-rank').textContent), Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0')));
  const first = rows(panel)[0]; assert.equal(first.querySelector('.chart-row-label').textContent, 'Walvo');
  assert.match(first.querySelector('.chart-row-sublabel').textContent, /用途 0/);
  assert.match(rows(panel)[4].querySelector('.chart-row-sublabel').textContent, /书籍/);
  assert.equal(Number(first.querySelector('[data-part="Claude"]').getAttribute('width')), 52);
  assert.equal(Number(first.querySelector('[data-part="Codex"]').getAttribute('width')), 48);
  assert.equal(Number(first.querySelector('[data-part="Codex"]').getAttribute('x')), 52);
  first.focus(); await first.fire('click');
  assert.equal(app.snapshot().state.selectedId, 'a0'); assert.equal(app.snapshot().state.detailOpen, true); assert.equal(panel.hidden, true);
});

test('v09 editorial: expand includes every ranked row and a separate muted zero group, collapse and filters reset it', async t => {
  const { app, panel } = await fixture(t);
  assert.match(panel.querySelector('.stats-zero').textContent, /未调用的 Agent：2 个/); assert.equal(panel.querySelectorAll('.chart-zero').length, 0);
  assert.match(key(panel, 'expand').textContent, /展开全部（27）/);
  await key(panel, 'expand').fire('click'); assert.equal(rows(panel).length, 27);
  assert.equal(panel.querySelectorAll('.chart-zero').length, 2);
  assert.deepEqual(rows(panel).slice(-2).map(n => n.getAttribute('data-agent-id')), ['a25', 'a26']);
  assert.equal(key(panel, 'expand').getAttribute('aria-expanded'), 'true');
  await key(panel, 'expand').fire('click'); assert.equal(rows(panel).length, 20);
  await key(panel, 'expand').fire('click'); await key(panel, '30d').fire('click'); assert.equal(app.snapshot().stats.showAll, false);
  await key(panel, 'expand').fire('click'); await key(panel, 'filter-role').fire('click'); assert.equal(app.snapshot().stats.showAll, false);
  await key(panel, 'filter-all').fire('click'); await key(panel, 'expand').fire('click');
  await panel.querySelector('[data-agent-id="a25"]').fire('click'); assert.equal(app.snapshot().state.selectedId, 'a25');
});

test('v09 editorial: ready all-zero period has true zero totals and expandable unused agents, without fabricated slices', async t => {
  const data = statistics(); for (const a of agents) data.perAgent[a.id].last7d = bucket(0);
  const { panel } = await fixture(t, data);
  assert.equal(panel.querySelector('.editorial-stats-total').textContent, '0'); assert.equal(panel.querySelectorAll('.chart-slice').length, 0);
  assert.equal(panel.querySelectorAll('.chart-donut').length, 2); assert.match(panel.textContent, /该时间范围内没有调用/);
  assert.match(panel.querySelector('.stats-zero').textContent, /27 个/); assert.equal(rows(panel).length, 0);
  await key(panel, 'expand').fire('click'); assert.equal(rows(panel).length, 27);
});

for (const status of ['loading', 'unavailable']) test(`v09 editorial: ${status} stays unknown and retains recovery controls instead of zero charts`, async t => {
  const data = statistics(); if (status === 'loading') data.building = true; else data.sources = [];
  const { panel, model, calls } = isolated(t, data); assert.equal(model.status, status);
  assert.match(panel.textContent, status === 'loading' ? /统计正在建立/ : /调用统计暂不可用/);
  assert.equal(panel.querySelectorAll('.chart-donut').length, 0); assert.equal(rows(panel).length, 0);
  assert.equal(panel.querySelector('.stats-zero'), null); assert.equal(panel.querySelector('.editorial-stats-total'), null);
  assert.ok(visible(panel.querySelector('.stats-limited')));
  await key(panel, 'refresh').fire('click'); await key(panel, 'back').fire('click'); assert.deepEqual(calls, ['refresh', 'catalog']);
});

test('v09 editorial: empty filtered ranking distinguishes filter results from the global totals', async t => {
  const data = statistics(); for (const a of agents.filter(a => a.kind === 'role')) data.perAgent[a.id].last7d = bucket(0);
  const { app, panel } = await fixture(t, data); await key(panel, 'filter-role').fire('click');
  assert.ok(app.snapshot().stats.totals.calls > 0); assert.equal(rows(panel).length, 0);
  assert.match(panel.querySelector('.editorial-stats-ranking').textContent, /当前筛选下没有调用/);
  await key(panel, 'filter-all').fire('click'); assert.equal(rows(panel).length, 20);
});

test('v09 editorial: choices and drafts survive all four layout switches without fetching stats or losing expansion', async t => {
  const { app, doc, requests } = await fixture(t);
  app.actions.search('保留检索'); app.actions.setRecommendInput('保留推荐草稿'); app.actions.addToJoint('a0', undefined, false);
  app.actions.openStats(); app.actions.setStatsRange('30d'); app.actions.setStatsCategory('分类5'); app.actions.toggleStatsShowAll();
  const before = app.snapshot(), count = requests.filter(r => r.url.startsWith('/api/stats')).length;
  app.actions.openSettings();
  for (const index of [0, 1, 3, 2]) {
    await doc.querySelectorAll('[role="radio"]')[index].fire('click'); const snapshot = app.snapshot();
    assert.deepEqual(snapshot.stats, before.stats); assert.equal(snapshot.state.query, '保留检索');
    assert.equal(snapshot.recommend.input, '保留推荐草稿'); assert.deepEqual(snapshot.state.jointSelectedIds, before.state.jointSelectedIds);
    assert.equal(snapshot.state.view, 'stats'); assert.ok(visible(doc.getElementById('stats-panel')));
  }
  assert.ok(doc.getElementById('stats-panel').closest('.layout-editorial'));
  assert.equal(key(doc.getElementById('stats-panel'), 'expand').getAttribute('aria-expanded'), 'true');
  assert.equal(requests.filter(r => r.url.startsWith('/api/stats')).length, count);
});

test('v09 editorial: unchanged snapshots preserve chart nodes/focus and never mutate supplied state', t => {
  const { ctx, model, doc, panel } = isolated(t), original = structuredClone(model);
  const day = panel.querySelector('[data-point="5"]'); day.focus();
  editorial.renderStats(ctx, structuredClone(model));
  assert.equal(panel.querySelector('[data-point="5"]'), day); assert.equal(doc.activeElement, day);
  assert.deepEqual(model, original);
  assert.equal(descendants(panel).filter(el => el.getAttribute('style') !== null).length, 0);
});

test('v09 editorial: charts use the shared engine with local print palette and scoped responsive CSS, never HTML/style injection', async () => {
  const js = await readFile(new URL('../public/layouts/editorial.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/layouts/editorial.css', import.meta.url), 'utf8');
  assert.match(js, /import\s*\{[^}]*donut[^}]*barList[^}]*columns[^}]*\}\s*from ['"]\.\.\/charts\.js/);
  assert.doesNotMatch(js, /renderDefaultStats|innerHTML|outerHTML|insertAdjacentHTML|\.cssText\s*=|setAttribute\(['"]style['"]/);
  for (const selector of ['.editorial-stats-intro', '.editorial-stats-total', '.editorial-stats-rank', '.editorial-stats-donuts', '.editorial-stats-ranking', '.editorial-chart-claude', '.editorial-chart-codex']) {
    assert.ok(css.includes(`[data-ui="editorial"] ${selector}`), selector);
  }
  assert.match(css, /editorial-stats-total\s*\{[^}]*64px[^}]*var\(--font-title\)/);
  assert.match(css, /editorial-stats-rank\s*\{[^}]*var\(--accent\)/);
  for (let i = 0; i < 11; i++) assert.ok(css.includes(`[data-ui="editorial"] .editorial-chart-category-${i}`));
  assert.match(css, /@media\s*\(max-width:900px\)[\s\S]*editorial-stats-donuts/);
  assert.doesNotMatch(css, /@import|https?:/);
});
