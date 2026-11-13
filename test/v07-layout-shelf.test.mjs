import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as shelf from '../public/layouts/shelf.js';

const sleep = '睡眠／健康／运动', finance = '投资／金融与金钱管理';
const categories = [finance, '心理／认知与行为', sleep, '软件工程', '艺术／美学', '思维／逻辑／因果与不确定性',
  '经济学／经济史／博弈论', '商业／传记／组织管理', '哲学／神话', '学习／研究／工作方法', '科学／技术与社会'];
const roleNames = ['-albert', '-jack', '-ark', '-jason', '-steven', 'Loki', '-Alan', '-Ames', '-Ben', '-Monsey', 'Peter'];
const rolePurposes = ['系统诊断', '提示词优化', '研究', '事实核查', '批判审查', '法律政治研究', '双语翻译', '技术写作', '信息提取', '代码诊断', '开发协调'];
const bookNames = ['Walvo', 'Jadra', 'Rusko', 'liebo', 'Stevo', 'Ishvo', 'hafo', 'Levro', 'Munto', 'Granto'];
const member = (name, kind, primary, title) => ({ id: name.toLowerCase(), name, kind, primary, tags: [],
  description: '帮助检查问题。\n\n<example>user: 不应出现的触发示例</example>',
  book: kind === 'book' ? { title, author: `作者 ${name}`, edition: '测试版' } : null,
  platforms: { claude: { available: true, file: 'fixture.md' }, codex: { available: true } },
  permissions: { claude: { model: 'sonnet', effort: 'high' }, codex: { sandbox: 'read-only' } },
  sources: { checked: true, missing: [], total: 1 }, sync: { state: '同步', detail: '测试定义相同' } });
const makeAgents = () => [
  ...roleNames.map((name, i) => ({ ...member(name, 'role', '功能性 Agent'), purpose: rolePurposes[i] })),
  ...Array.from({ length: 70 }, (_, i) => member(bookNames[i] || `Book${i}`, 'book', i < 8 ? sleep : categories[(i - 8) % categories.length],
    i === 0 ? '*Notes on Sample: Science*' : i === 1 ? '**Dear Sample**' : i === 2 ? '_Sample Time: A Sample Clock_' :
      i === 3 ? '一二三四五六七八九十一二三四' : i === 8 ? '多书，2 部：《示例小宝典》；《第二本》' : `《测试藏书${i}》`)),
];
const record = (id, canResume) => ({ type: 'joint', id, createdAt: '2026-10-06T16:00:00Z', cli: 'codex',
  agents: [{ id: 'walvo', name: 'Walvo' }, { id: 'jadra', name: 'Jadra' }], mode: 'joint', source: 'manual',
  inputPreview: '<script>保留用户任务为纯文本', status: { overall: 'done' }, canResume, resumeReason: canResume ? '' : '会话文件已不存在' });
const named = (doc, label, root = doc.documentElement) => descendants(root).find(n => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === label);
const byClass = (root, name) => root.querySelectorAll(`.${name}`);
// The recording fixture's selector parser supports letter-only tag names.
const heading = (root, level) => descendants(root).find(n => n.tagName === `H${level}`);
const visible = n => !!n && !n.closest('[hidden]');
// CSP leaves a style attribute in the DOM but does not apply it. Record only
// CSSOM writes as effective styles; these tests do not claim browser rendering.
function recordStyles(doc, measure = () => ({})) {
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag), values = new Map();
    el.styleWrites = [];
    el.style = {
      setProperty(key, value) { values.set(key, String(value)); el.styleWrites.push([key, String(value)]); },
      getPropertyValue(key) { return values.get(key) || ''; },
      set cssText(_) { assert.fail('style.cssText is not the CSP-safe property API'); },
    };
    for (const key of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
      Object.defineProperty(el, key, { get: () => measure(el)[key] || 0 });
    }
    return el;
  };
  return doc;
}
const style = (el, key) => el.style.getPropertyValue(key);
function catalogFixture(agents, measure) {
  const doc = recordStyles(documentFrom('<html><body></body></html>'), measure);
  const state = { view: 'catalog', category: 'all', query: '', sort: 'default', selectedId: null,
    jointSelectedIds: [], allAgents: agents, categories: [sleep], detailOpen: false };
  const ctx = { doc, state, refs: {}, actions: {} };
  ctx.root = shelf.render(ctx); doc.body.append(ctx.root);
  const model = { title: '藏书', agents, query: '', sort: 'default', categories: [sleep] };
  const draw = () => shelf.renderCatalog(ctx, model);
  draw(); return { doc, ctx, draw };
}
async function fixture(t, ui = 'shelf') {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="shelf-test">');
  const doc = recordStyles(documentFrom(html)); doc.documentElement.setAttribute('data-ui', ui);
  const agents = makeAgents(), calls = [];
  const registry = { agents, categories, summary: { roles: 11, books: 70, synced: 81, inScope: 81 },
    sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-07T00:00:00Z' };
  const stats = { sources: [{ id: 'fixture', available: true, failedFiles: [] }], limited: true, limitedReasons: ['合成统计'],
    perAgent: Object.fromEntries(agents.map(a => [a.id, { last7d: { calls: 1, bySource: {} }, total: { calls: 2, bySource: {} } }])) };
  let running = [];
  let agentHistory = { items: [{ launchId: 'previous', cli: 'claude', mode: 'agent', createdAt: '2026-10-07T00:00:00Z' }], unavailable: [] };
  const app = await mountApp(doc, async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined; calls.push({ url, body });
    let data;
    if (url === '/api/registry' || url === '/api/refresh') data = registry;
    else if (url === '/api/stats' || url === '/api/stats/refresh') data = stats;
    else if (url === '/api/settings') data = { ui: body?.ui || ui, recommend: { claude: { model: 'sonnet', effort: 'high' } } };
    else if (url === '/api/running') data = { items: running };
    else if (url.startsWith('/api/history?')) data = { items: [record('available', true), record('missing', false)] };
    else if (url === '/api/history/rerun') data = { jointId: 'rerun' };
    else if (url.startsWith('/api/history/')) data = agentHistory;
    else if (url === '/api/launch' || url === '/api/resume') data = { launchId: 'synthetic-launch' };
    else if (url.startsWith('/api/launch/')) data = { overall: 'failed', message: '仅测试替身', process: { state: 'exited' }, cwd: { state: 'ok' }, agent: { state: 'ok' }, waiting: { state: 'ok' } };
    else if (url === '/api/recommend') data = { recommendId: 'synthetic-rec' };
    else if (url.startsWith('/api/recommend/')) data = { recommendId: 'synthetic-rec', status: 'done', engine: 'claude', model: 'sonnet', audit: { ok: true, agentCalls: 0, children: 0 }, results: [{ ...agents[11], reason: '合成推荐' }] };
    else if (url === '/api/joint') data = { jointId: 'synthetic-joint' };
    else data = { items: [] };
    return { ok: true, json: async () => data };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, agents, calls, get: id => doc.getElementById(id), button: label => named(doc, label),
    setAgentHistory: value => { agentHistory = value; },
    setRunning: async items => { running = items; await app.actions.refreshRunning(); } };
}

test('shelf §6.1: masthead, tools and removals follow the original structure', async t => {
  const h = await fixture(t), head = h.doc.querySelector('.shelf-header');
  assert.equal(heading(head, 1).textContent, 'CO-AGENT 书房');
  assert.equal(h.get('shelf-subtitle').textContent, '70 本书 · 11 位同事 · 点书脊，向作者提问');
  assert.equal(h.get('search').getAttribute('placeholder'), '找一本书或一位作者');
  assert.equal(h.get('search').getAttribute('aria-label'), '全局搜索');
  assert.equal(h.get('search').getAttribute('title'), '/ 或 Ctrl+K');
  assert.equal(h.get('search-control').textContent, '');
  const controls = head.querySelector('.shelf-tools').children;
  assert.deepEqual(controls.map(n => n.id), ['shelf-reading', 'search-control', 'shelf-recommend', 'settings-open']);
  assert.equal(h.button('AI 推荐').textContent, '请书房推荐');
  assert.equal(h.button('打开设置').textContent, '⚙');
  assert.doesNotMatch(head.textContent, /全局搜索|v0\.|刷新目录/);
  assert.equal(h.doc.querySelector('.utility-nav'), null);
  // v0.28 D: the only icons among the shelves are the gilt chevrons of “整排查看”.
  assert.equal(h.get('navigation').querySelectorAll('details').length, 0);
  assert.ok(h.get('navigation').querySelectorAll('svg').every(n => n.parentElement.className === 'shelf-chevron'));
  for (const id of ['shelf-history', 'stats-open', 'groups-open']) assert.equal(h.get(id).querySelectorAll('svg').length, 1, id);
  assert.equal(h.get('navigation').querySelectorAll('button').filter(n => /（\d+）/.test(n.textContent)).length, 0);
  assert.ok(!visible(h.get('shelf-reading')));
  await h.setRunning([{ agentName: 'Walvo', cli: 'claude', createdAt: '2026-10-07T00:00:00Z', status: { overall: 'ready' } }]);
  assert.equal(h.get('shelf-reading').textContent, '在读 1'); assert.ok(visible(h.get('shelf-reading')));
  await h.get('shelf-reading').fire('click'); assert.equal(h.app.snapshot().state.view, 'running');
});

test('shelf §6.2: all eleven staff badges precede shelves, with concise purposes and separate desk actions', async t => {
  const h = await fixture(t), cards = h.get('cards'), row = cards.querySelector('.staff-row');
  assert.equal(cards.children[0].id, 'shelf-staff-strip'); assert.equal(row.parentElement, cards.children[0]); assert.equal(row.children.length, 11); // v0.17 arrow strip
  assert.deepEqual(row.children.slice(0, 7).map(n => n.querySelector('strong').textContent), ['-ark', '-jason', '-steven', '-jack', '-albert', 'Peter', 'Loki']);
  for (const item of row.children) {
    const badge = item.querySelector('.staff-badge');
    assert.equal(badge.children[0].textContent, 'STAFF'); assert.equal(badge.children[1].tagName, 'STRONG');
    assert.ok(badge.children[2].textContent.length > 0 && badge.children[2].textContent.length <= 12);
    assert.ok(item.querySelector('.put-on-desk')); assert.equal(badge.querySelector('button'), null);
    assert.doesNotMatch(badge.textContent, /<example>|不应出现/);
  }
  await h.button('查看 -ark 详情').fire('click'); assert.equal(h.get('detail').open, true);
});

test('shelf §6.3: eleven layers, original order, cleaned vertical titles, stable dimensions and author tooltips', async t => {
  const h = await fixture(t), layers = byClass(h.get('navigation'), 'shelf-layer');
  assert.equal(layers.length, 11); assert.equal(heading(layers[0], 3).textContent, sleep);
  assert.equal(heading(layers[1], 3).textContent, finance);
  for (const layer of layers) assert.deepEqual(layer.children.map(n => n.className), ['shelf-layer-heading', 'book-row', 'wood-edge']);
  const spines = byClass(h.get('cards'), 'book-spine'); assert.equal(spines.length, 70);
  const heights = new Set(), widths = new Set();
  for (const spine of spines) {
    const height = parseFloat(style(spine, 'height')), width = parseFloat(style(spine, 'width'));
    assert.ok(height >= 230 && height <= 260); assert.ok(width >= 50 && width <= 64); heights.add(height); widths.add(width);
    assert.equal(spine.querySelector('small'), null); assert.match(spine.title, /作者/);
    assert.doesNotMatch(spine.textContent, /\*|<example>|作者|· 7 天/);
  }
  assert.ok(heights.size > 1); assert.ok(widths.size > 1);
  const walvo = h.button('查看 Walvo 详情'), dimensions = ['height', 'width', '--book-color'].map(key => style(walvo, key));
  assert.equal(walvo.textContent, 'Notes on Sample'); assert.equal(h.button('查看 liebo 详情').textContent, '一二三四五六七八九十一二三四');
  await layers[0].querySelector('.shelf-view-all').fire('click');
  assert.equal(h.app.snapshot().state.category, sleep); assert.equal(byClass(h.get('cards'), 'shelf-layer').length, 1);
  assert.deepEqual(['height', 'width', '--book-color'].map(key => style(h.button('查看 Walvo 详情'), key)), dimensions);
  assert.ok(visible(h.get('shelf-back'))); await h.get('shelf-back').fire('click');
  assert.equal(byClass(h.get('cards'), 'shelf-layer').length, 11);
  // Global search must cross the selected row instead of filtering only that row.
  h.app.actions.selectCategory(sleep); h.get('search').value = 'Munto'; await h.get('search').fire('input');
  assert.equal(byClass(h.get('cards'), 'book-spine').length, 1); assert.ok(h.button('查看 Munto 详情'));
  await h.get('shelf-back').fire('click'); assert.equal(h.get('search').value, '');
  assert.equal(byClass(h.get('cards'), 'book-spine').length, 70);
});

test('shelf §6.4: desk tags add/remove without a dialog, guard eight members, and distinguish prefill from empty', async t => {
  const h = await fixture(t), start = h.button('发起联合调用');
  assert.equal(start.textContent, '发起联合调用（0）'); assert.equal(start.disabled, true);
  await h.button('放上书桌 Walvo').fire('click'); await h.button('放上书桌 -ark').fire('click');
  assert.equal(h.get('joint-builder').open, false); assert.deepEqual(h.app.snapshot().state.jointSelectedIds, ['walvo', '-ark']);
  assert.match(h.get('tray-selected').textContent, /Walvo.*-ark/); assert.equal(start.textContent, '发起联合调用（2）');
  await named(h.doc, '移除 -ark', h.get('tray-selected')).fire('click');
  await start.fire('click'); assert.equal(h.get('joint-builder').open, true); assert.match(h.get('joint-builder').className, /shelf-builder/);
  assert.match(h.get('builder-selected').textContent, /Walvo/); await h.get('builder-close').fire('click');
  await h.button('新建联合调用').fire('click'); assert.deepEqual(h.app.snapshot().state.jointSelectedIds, []);
  await h.get('builder-close').fire('click');
  for (const name of bookNames.slice(0, 8)) await h.button(`放上书桌 ${name}`).fire('click');
  assert.equal(h.button('放上书桌 Munto').disabled, true); assert.match(h.button('放上书桌 Munto').title, /8/);
  await named(h.doc, '移除 Walvo', h.get('tray-selected')).fire('click'); assert.equal(h.button('放上书桌 Munto').disabled, false);
});

test('shelf §6.5: lending cards have date stamps, members, task text, both actions and explicit resume failures', async t => {
  const h = await fixture(t); await h.button('历史调用').fire('click');
  assert.equal(heading(h.get('history-panel'), 2).textContent, '借阅记录');
  const cards = byClass(h.get('history-list'), 'lending-card'); assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.lending-stamp').tagName, 'TIME'); assert.match(cards[0].querySelector('.lending-stamp').textContent, /2026-10-07 00:00:00/);
  assert.equal(cards[0].querySelector('.lending-type').textContent,'联合');
  assert.match(cards[0].textContent, /借阅人.*Walvo、Jadra/); assert.match(cards[0].querySelector('.lending-meta').textContent, /2 个.*Codex.*完成/);
  assert.match(cards[0].textContent, /<script>保留用户任务为纯文本/); assert.equal(cards[0].querySelector('script'), null);
  const rerun = named(h.doc, '重新调用', cards[0]), resume = named(h.doc, '继续该次会话', cards[0]);
  assert.equal(rerun.textContent, '再借一次'); assert.equal(resume.textContent, '继续阅读');
  await rerun.fire('click'); await named(h.doc, '继续该次会话', byClass(h.get('history-list'), 'lending-card')[0]).fire('click');
  assert.ok(h.calls.some(c => c.url === '/api/history/rerun' && c.body.id === 'available'));
  assert.ok(h.calls.some(c => c.url === '/api/resume' && c.body.id === 'available'));
  const unavailable = byClass(h.get('history-list'), 'lending-card')[1];
  assert.match(unavailable.textContent, /会话文件已不存在/); assert.equal(named(h.doc, '继续该次会话', unavailable).disabled, true);
  h.get('history-filter').value = 'joint'; await h.get('history-filter').fire('change');
  assert.ok(h.calls.some(c => c.url === '/api/history?type=joint&limit=50'));
});

test('shelf §6.6: cream detail dialog includes source evidence, launches, resume, desk and keyboard close', async t => {
  const h = await fixture(t); await h.button('查看 Walvo 详情').fire('click');
  assert.match(h.get('detail').className, /shelf-detail/); assert.equal(h.get('detail').open, true);
  const body = h.get('detail-body');
  for (const label of ['Notes on Sample', '作者 Walvo', '测试版', '权限与模型', '原书路径', '双版本同步', '调用统计', '继续上次会话']) assert.ok(body.textContent.includes(label), label);
  assert.doesNotMatch(body.textContent, /\*Why|<example>|不应出现/);
  for (const cli of ['Claude', 'Codex']) await h.button(`在 ${cli} CLI 中调用 Walvo`).fire('click');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/launch').map(c => c.body.cli), ['claude', 'codex']);
  await byClass(h.get('detail-body'), 'agent-resume')[0].fire('click');
  assert.ok(h.calls.some(c => c.url === '/api/resume' && c.body.launchId === 'previous'));
  await h.get('detail').fire('keydown', { key: 'Escape' }); await h.app.actions.refreshRunning();
  assert.equal(h.get('detail').open, false); assert.ok(h.doc.activeElement.isConnected);
  await h.button('查看 Walvo 详情').fire('click'); assert.equal(h.button('加入联合调用 Walvo').textContent, '放上书桌');
  await h.button('加入联合调用 Walvo').fire('click'); assert.equal(h.get('detail').open, false);
});

test('shelf functional contract: all eleven functions reachable including recommendation execution, shortcuts, coverage and settings', async t => {
  const h = await fixture(t);
  assert.equal(byClass(h.get('cards'), 'shelf-layer').length, 11); assert.equal(byClass(h.get('cards'), 'staff-badge').length, 11);
  for (const event of [{ key: '/' }, { key: 'k', ctrlKey: true }]) {
    await h.doc.fire('keydown', { ...event, target: h.doc.body, preventDefault() {} }); assert.equal(h.doc.activeElement, h.get('search'));
  }
  await h.button('AI 推荐').fire('click'); assert.ok(visible(h.get('recommend-panel')));
  h.get('recommend-input').value = '分析睡眠'; await h.get('recommend-input').fire('input'); await h.get('recommend-submit').fire('click');
  assert.ok(h.calls.some(c => c.url === '/api/recommend' && c.body.input === '分析睡眠'));
  const result = h.get('recommend-results'); assert.match(result.textContent, /Notes on Sample/); assert.doesNotMatch(result.textContent, /\*|<example>/);
  const check = result.querySelector('input'); check.checked = true; await check.fire('change'); await h.get('joint-submit').fire('click');
  assert.ok(h.calls.some(c => c.url === '/api/joint' && c.body.recommendId === 'synthetic-rec'));
  for (const [label, panel] of [['历史调用', 'history-panel'], ['运行中的会话', 'running-panel'], ['扫描摘要和数据覆盖', 'coverage-panel']]) {
    await h.button(label).fire('click'); assert.ok(visible(h.get(panel)), label);
  }
  assert.equal(h.get('coverage-panel').querySelectorAll('.scope-info').length, 1);
  await h.button('打开设置').fire('click'); assert.equal(h.get('settings-dialog').open, true);
  assert.ok(h.get('refresh').closest('#settings-dialog'));
});

test('shelf layout switching preserves category, selected agent, search, recommendation draft and desk without refetch', async t => {
  const h = await fixture(t, 'threepane');
  h.app.actions.selectCategory(sleep); await h.app.actions.openDetail('jadra'); h.app.actions.closeDetail(); h.app.actions.search('Jadra');
  h.app.actions.setRecommendInput('尚未提交的问题'); h.app.actions.setRecommendEngine('codex'); h.app.actions.addToJoint('walvo', undefined, false);
  h.app.actions.openSettings();
  const options = h.doc.querySelectorAll('[role="radio"]');
  for (const index of [3, 0, 3]) {
    await options[index].fire('click'); const state = h.app.snapshot();
    assert.equal(state.state.category, sleep); assert.equal(state.state.selectedId, 'jadra'); assert.equal(h.get('search').value, 'Jadra');
    assert.equal(h.get('detail-title').textContent, 'Jadra'); assert.equal(h.get('recommend-input').value, '尚未提交的问题');
    assert.equal(state.recommend.engine, 'codex'); assert.deepEqual(state.state.jointSelectedIds, ['walvo']);
    assert.equal(h.get('detail').open, false);
  }
  assert.equal(h.calls.filter(c => c.url === '/api/registry').length, 1);
  assert.equal(h.calls.filter(c => c.url === '/api/recommend').length, 0);
});

test('shelf detail unavailable platforms and resume explain disabled actions; a full desk remains guarded in detail', async t => {
  const h = await fixture(t), agent = h.agents.find(a => a.name === 'Walvo');
  agent.platforms.codex = { available: false, reason: '测试入口不可用' };
  h.setAgentHistory({ items: [], unavailable: [{ reason: '记录未核验', canReverify: true }] });
  await h.button('查看 Walvo 详情').fire('click');
  const launch = h.button('在 Codex CLI 中调用 Walvo'); assert.equal(launch.disabled, true);
  assert.equal(h.get(launch.getAttribute('aria-describedby')).textContent, '测试入口不可用');
  assert.equal(h.button('继续上次会话 Walvo').disabled, true); assert.match(h.get('detail-body').textContent, /记录未核验/);
  h.app.actions.closeDetail();
  for (const name of bookNames.slice(0, 8)) await h.button(`放上书桌 ${name}`).fire('click');
  await h.button('查看 Munto 详情').fire('click');
  assert.equal(h.button('加入联合调用 Munto').disabled, true); assert.match(h.button('加入联合调用 Munto').title, /8/);
  assert.ok(!h.calls.some(c => c.url === '/api/launch' || c.url === '/api/resume'));
});

test('shelf polling retains horizontal scroll, expanded evidence and a live keyboard focus target', async t => {
  const h = await fixture(t), staff = h.get('shelf-staff'), row = h.get('cards').querySelector('.book-row');
  staff.scrollLeft = 140; row.scrollLeft = 80; const book = h.button('查看 Walvo 详情'); book.focus();
  await h.app.actions.refreshRunning(); assert.equal(h.doc.activeElement, book); assert.equal(row.scrollLeft, 80);
  await book.fire('click'); const full = h.get('detail-body').querySelector('details'); full.open = true; full.querySelector('summary').focus();
  await h.app.actions.refreshRunning(); assert.equal(full.open, true); assert.ok(h.doc.activeElement.isConnected);
  h.app.actions.closeDetail(); assert.equal(h.get('shelf-staff').scrollLeft, 140); assert.equal(h.get('cards').querySelector('.book-row').scrollLeft, 80);
});

test('shelf style contract: local fonts, fully scoped rules, original materials and specified density', async () => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.doesNotMatch(css, /@import|https?:/);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selector] of rules) for (const part of selector.trim().split(',')) assert.match(part, /\[data-ui="shelf"\]/, part);
  for (const color of ['#2b2118', '#f3e9d8', '#c9b89c', '#3a2d21', '#6b5640', '#f2c879', '#6b4a2b', '#1a130d']) assert.ok(css.includes(color), color);
  const rule = name => css.match(new RegExp(`\\.${name}\\s*\\{([^}]+)\\}`))?.[1] || '';
  assert.match(rule('shelf-title'), /56px/); assert.match(rule('shelf-subtitle'), /17px/);
  assert.match(rule('layout-shelf'), /gap:\s*26px/); assert.match(rule('layout-shelf'), /padding:\s*36px 48px/);
  assert.match(rule('staff-row'), /flex-wrap:\s*nowrap/); assert.match(rule('staff-row'), /overflow-x:\s*auto/);
  assert.match(rule('book-spine'), /writing-mode:\s*vertical-rl/); assert.match(rule('book-spine'), /18px/);
  assert.match(rule('spine-title'), /white-space:\s*normal/); assert.doesNotMatch(rule('spine-title'), /ellipsis|nowrap/);
  assert.match(rule('wood-edge'), /height:\s*14px/); assert.match(rule('wood-edge'), /0 6px 0 #1a130d/);
  assert.match(rule('desk-tray'), /position:\s*fixed/); assert.match(rule('desk-tray'), /bottom:\s*0/);
  assert.match(css, /\.shelf-builder\s+\.builder-row\s*\{[^}]*background:\s*#f3e9d8/);
});

test('shelf history polish: adjacent type/date stamps, localized metadata, coloured text chips and exact action labels', async () => {
  const h = catalogFixture([]), calls = [];
  h.ctx.actions = {rerun:(...args) => calls.push(['rerun',...args]), resumeHistory:(...args) => calls.push(['resume',...args])};
  h.ctx.state.view='history';
  const items = ['ok','fail','running','pending'].map((tone, i) => ({...record(`tone${i}`,true),
    type: i % 2 ? 'joint' : i === 2 ? 'single' : 'launch',
    statusTone:tone, status:{overall:'done'}, cliLabel:'Claude', modeLabel:'转调', sourceLabel:'AI 推荐',
    resumeOf:'previous-session', rerunOf:'previous-call'}));
  const model = {items,filter:'all',selected:null,busy:false,message:''};
  const draw = () => shelf.renderHistory(h.ctx,model); draw();
  const cards = byClass(h.ctx.refs['history-list'],'lending-card');
  for (const [i,card] of cards.entries()) {
    const date = card.querySelector('.lending-stamp'), type = card.querySelector('.lending-type');
    assert.ok(type); assert.equal(type.textContent,i % 2 ? '联合' : '单次');
    assert.equal(date.parentElement,type.parentElement); assert.deepEqual(date.parentElement.children,[date,type]);
    const chip = card.querySelector('.lending-state');
    assert.ok(chip); assert.equal(chip.textContent,'完成'); assert.equal(chip.getAttribute('data-tone'),items[i].statusTone);
    assert.notEqual(chip.getAttribute('aria-hidden'),'true'); assert.equal(chip.getAttribute('style'),null);
    assert.match(card.querySelector('.lending-meta').textContent,/Claude/); assert.doesNotMatch(card.textContent,/○|◈|codex|claude/);
    for (const [label,text] of [['重新调用','再借一次'],['继续该次会话','继续阅读']]) {
      const action = named(h.doc,label,card); assert.ok(action); assert.equal(action.textContent,text); await action.fire('click');
    }
  }
  assert.deepEqual(calls.slice(0,2),[['rerun','launch','tone0'],['resume','launch','tone0']]);
  model.selected=items[0]; h.ctx.state.detailOpen=true; draw();
  const detail=h.ctx.refs['detail-body'];
  assert.match(detail.textContent,/模式：转调 · 来源：AI 推荐/);
  assert.match(detail.textContent,/恢复自 previous-session · 重跑自 previous-call/);
  assert.ok(named(h.doc,'重新调用',detail)); assert.ok(named(h.doc,'继续该次会话',detail));
  model.selected={...items[0],typeLabel:'提供的类型',statusTone:'unknown'}; draw();
  assert.equal(detail.querySelector('.lending-type').textContent,'提供的类型');
  assert.equal(detail.querySelector('.lending-state').getAttribute('data-tone'),'pending');
  model.items=[record('raw',true)]; draw(); assert.match(h.ctx.refs['history-list'].textContent,/Codex/);
  const css = await fs.readFile('public/layouts/shelf.css','utf8');
  assert.match(css,/\.lending-stamps\s*\{[^}]*display:\s*flex/);
  assert.match(css,/\.lending-type\s*\{[^}]*border:\s*1px solid/);
  const backgrounds = [];
  for (const tone of ['ok','fail','running','pending']) {
    const selector = `[data-ui="shelf"] .lending-state[data-tone="${tone}"]`;
    const start = css.indexOf(selector); assert.ok(start >= 0,selector);
    const rule = css.slice(start,css.indexOf('}',start)); assert.match(rule,/color:\s*#[\da-f]{6}/i);
    backgrounds.push(rule.match(/background:\s*(#[\da-f]+)/i)?.[1]);
  }
  assert.equal(new Set(backgrounds).size,4);
});

test('SH2-1: every spine applies bounded, stable dimensions and palette colors through CSSOM under strict CSP', async t => {
  const h = await fixture(t), before = new Map();
  for (const spine of byClass(h.get('cards'), 'book-spine')) {
    assert.equal(spine.getAttribute('style'), null, 'no CSP-blocked style attribute');
    const values = ['height', 'width', '--book-color'].map(key => style(spine, key));
    assert.ok(parseFloat(values[0]) >= 230 && parseFloat(values[0]) <= 260, values[0]);
    assert.ok(parseFloat(values[1]) >= 50 && parseFloat(values[1]) <= 64, values[1]);
    assert.match(values[2], /^#[0-9a-f]{6}$/i);
    before.set(spine.getAttribute('data-member'), values);
  }
  h.app.actions.selectCategory(sleep);
  for (const spine of byClass(h.get('cards'), 'book-spine')) {
    assert.deepEqual(['height', 'width', '--book-color'].map(key => style(spine, key)), before.get(spine.getAttribute('data-member')));
  }
  const source = await fs.readFile('public/layouts/shelf.js', 'utf8');
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]|\.cssText\s*=/);
});

test('SH2-2 / v0.40.3: shared spineTitle wins; long titles thicken the spine to 84px before shrinking to a 12px floor; hidden shelves fit on return', async () => {
  const titles = ['短书名', '两列完整书名', '需要缩小的完整书名', '需要最低字号的完整书名'];
  const agents = titles.map((title, i) => ({ ...member(`Title${i}`, 'book', sleep, '**旧书名：旧副标题**'), spineTitle: title }));
  let measurements = 0;
  const h = catalogFixture(agents, el => {
    if (el.className !== 'spine-title') return {};
    measurements++;
    assert.ok(el.isConnected, 'measure after insertion');
    assert.ok(!el.closest('[hidden]'), 'do not shrink using hidden geometry');
    // Each title needs a fixed number of columns, each font-size × 1.35 wide; the box is the title's max-width.
    const font = parseFloat(style(el, 'font-size')) || 18, columns = [1, 2, 3, 5][titles.indexOf(el.textContent)];
    return { clientWidth: parseFloat(style(el, 'max-width')) || 49, clientHeight: 216, scrollWidth: columns * font * 1.35, scrollHeight: 216 };
  });
  const spans = byClass(h.ctx.root, 'spine-title');
  assert.deepEqual(spans.map(n => n.textContent), titles, 'never abbreviate or replace the supplied title');
  assert.deepEqual(spans.map(n => parseFloat(style(n, 'font-size')) || 18), [18, 18, 15, 12]);
  assert.deepEqual(spans.map(n => parseFloat(style(n.parentElement, 'width'))), [52, 52, 64, 84], 'the spine thickens before the font shrinks below 15px');
  assert.ok(measurements > 0);
  for (const span of spans) {
    assert.ok(span.styleWrites.every(([key, value]) => key !== 'font-size' || parseFloat(value) >= 12));
    assert.ok(span.scrollWidth <= span.clientWidth);
  }
  h.ctx.state.view = 'history'; h.draw();
  agents[0].spineTitle = titles[3]; const before = measurements; h.draw();
  assert.equal(measurements, before);
  h.ctx.state.view = 'catalog'; h.draw();
  assert.equal(style(byClass(h.ctx.root, 'spine-title')[0], 'font-size'), '12px');
  // Before S2 is merged, use the existing helper if the view field is absent.
  delete agents[0].spineTitle; h.draw();
  assert.equal(byClass(h.ctx.root, 'spine-title')[0].textContent, '旧书名');
  let measurable = false;
  const deferred = catalogFixture([agents[1]], el => {
    if (!measurable || el.className !== 'spine-title') return {};
    return { clientWidth: 48, clientHeight: 216, scrollWidth: parseFloat(style(el, 'font-size')) === 14 ? 38 : 72, scrollHeight: 216 };
  });
  measurable = true; deferred.draw();
  assert.equal(style(byClass(deferred.ctx.root, 'spine-title')[0], 'font-size'), '14px', 'retry zero-size geometry without requiring a catalog change');
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  const titleRule = css.match(/\.spine-title\s*\{([^}]+)\}/)[1];
  assert.match(titleRule, /height:\s*100%/);
  assert.match(titleRule, /width:\s*fit-content/, 'short titles must remain centered instead of reserving an empty second column');
  assert.match(titleRule, /max-width:\s*2\.7em/);
  assert.match(titleRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(titleRule, /overflow:\s*(hidden|clip)|ellipsis|line-clamp/);
});

test('SH2-3: original staff cards scroll without a visible bar, fade at the right, and keep the last colleague reachable', async t => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  const rule = selector => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1] || '';
  assert.match(rule('.staff-row'), /scrollbar-width:\s*none/);
  assert.match(rule('.staff-row'), /overflow-x:\s*auto/);
  // v0.17: the fade appears only while more staff are hidden to the right (with an arrow on it).
  assert.match(rule('.staff-strip.can-right .staff-row'), /mask-image:\s*linear-gradient\(to right,[^;]+transparent\)/);
  assert.match(rule('.staff-row::-webkit-scrollbar'), /display:\s*none/);
  assert.match(rule('.staff-row .shelf-item'), /width:\s*148px/); // original 120px content + 2 × 14px padding
  assert.match(rule('.staff-badge'), /padding:\s*10px 14px/);
  assert.match(rule('.staff-badge'), /border-radius:\s*6px/);
  const h = await fixture(t), row = h.get('shelf-staff');
  row.scrollLeft = 420; const last = row.children.at(-1).querySelector('.staff-badge');
  last.focus(); await h.app.actions.refreshRunning();
  assert.equal(row.scrollLeft, 420); assert.equal(h.doc.activeElement, last);
  await last.fire('click'); assert.equal(h.get('detail').open, true);
  assert.equal(h.get('detail-title').textContent, '-Monsey');
});

test('SH2-4: staff purposes come from AgentView for known and new names, with a safe pre-S2 fallback', async () => {
  const agents = [
    { ...member('-ark', 'role', '功能性 Agent'), purpose: '来自共享层的新用途' },
    { ...member('NewRole', 'role', '功能性 Agent'), purpose: '新同事用途' },
    member('-jason', 'role', '功能性 Agent'),
    { ...member('Unknown', 'role', '功能性 Agent'), description: '' },
  ];
  const h = catalogFixture(agents);
  assert.equal(named(h.doc, '查看 -ark 详情').children[2].textContent, '来自共享层的新用途');
  assert.equal(named(h.doc, '查看 NewRole 详情').children[2].textContent, '新同事用途');
  assert.equal(named(h.doc, '查看 -jason 详情').children[2].textContent, '帮助检查问题。');
  assert.equal(named(h.doc, '查看 Unknown 详情').children[2].textContent, '用途未载明');
  agents[0].purpose = '变更后的用途'; h.draw();
  assert.equal(named(h.doc, '查看 -ark 详情').children[2].textContent, '变更后的用途');
  assert.doesNotMatch(h.ctx.refs['shelf-staff'].textContent, /<example>|不应出现/);
  assert.doesNotMatch(await fs.readFile('public/layouts/shelf.js', 'utf8'), /staffPurposes/);
  assert.ok(makeAgents().filter(a => a.kind === 'role').every(a => /[\u4e00-\u9fff]/.test(a.purpose)));
  agents[0].purpose = ''; agents[0].description = 'A long legacy description that must stay inside the original compact staff card.'; h.draw();
  assert.equal(named(h.doc, '查看 -ark 详情').children[2].title, agents[0].description);
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\.staff-badge span\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.staff-badge span\s*\{[^}]*text-overflow:\s*ellipsis/);
});

test('v021 shelf hides the page scrollbar but keeps the page scrollable', async () => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\[data-ui="shelf"\],\s*\[data-ui="shelf"\] body \{\s*scrollbar-width:none;\s*\}/);
  assert.match(css, /\[data-ui="shelf"\]::-webkit-scrollbar,\s*\[data-ui="shelf"\] body::-webkit-scrollbar \{\s*display:none;\s*\}/);
  for (const block of css.match(/(^|\})\s*\[data-ui="shelf"\](,\s*\[data-ui="shelf"\] body)?\s*\{[^}]*\}/g) || []) {
    assert.doesNotMatch(block, /overflow(-y)?\s*:\s*(hidden|clip)/, 'the page must stay scrollable');
  }
  // Every popup (dialogs, popover menus) and everything inside them hides its scrollbar the same way and keeps scrolling.
  assert.match(css, /\[data-ui="shelf"\] dialog,\s*\[data-ui="shelf"\] dialog \*,\s*\[data-ui="shelf"\] \[popover\],\s*\[data-ui="shelf"\] \[popover\] \* \{\s*scrollbar-width:none;\s*\}/);
  assert.match(css, /\[data-ui="shelf"\] dialog::-webkit-scrollbar,\s*\[data-ui="shelf"\] dialog \*::-webkit-scrollbar,\s*\[data-ui="shelf"\] \[popover\]::-webkit-scrollbar,\s*\[data-ui="shelf"\] \[popover\] \*::-webkit-scrollbar \{\s*display:none;\s*\}/);
  assert.match(css, /\[data-ui="shelf"\] dialog\.shelf-reader \{[^}]*overflow:auto;/);
});
