import './fixtures/time-zone.mjs';
import { appDocument, allStyles } from './fixtures/app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { excerpt, avatarLetter, createCard, fillDetails, renderStatus, renderNavigation, pollFinished, mountApp, renderCoverage, formatDate, sortAgents } from '../public/app.js';

// A minimal DOM records actual created nodes, text and event handlers; no browser/window is opened.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.events = {}; this._text = ''; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this.events[type] = callback; }
  fire(type,event) { return this.events[type]?.(event); }
}
const doc = { createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) };
const descendants = el => [el, ...el.children.flatMap(descendants)];
const agent = { id: 'jack', name: '-jack', description: '<img src=x onerror=alert(1)> 第一段。第二段', kind: 'role', primary: '功能性 Agent', tags: [], book: null, sourceFile: 'synthetic/jack.toml', platforms: { codex: { available: true, file: 'jack.toml' }, claude: { available: false, reason: '启动项目中没有该 Agent 的 Claude 版' } } };

test('U2 task-format badge depends on server contract metadata, not a hardcoded name list', () => {
  for (const taskFormat of [true, false]) {
    const { card } = createCard(doc, { ...agent, taskFormat }, { categories: [], onLaunch() {}, onDetails() {} });
    assert.equal(card.textContent.includes('转调 · 自动套用任务格式'), taskFormat);
  }
});

test('U3/U4 coverage shows migration and one shared reading-method explanation', () => {
  const target = new Element('div');
  const explanation = '仅解析 session_meta 首行与末尾最多 256 KB；中段坏行不可见；未知状态不代表成功或失败。';
  renderCoverage(doc, target, { ...stats, dataDirMigration: '已从旧目录迁移', explanations: [explanation],
    sources: ['codex-live', 'codex-archive'].map(id => ({ ...stats.sources[0], id, notes: [] })) });
  assert.ok(target.textContent.includes('已从旧目录迁移'));
  assert.ok(target.textContent.includes('说明'));
  assert.equal(target.textContent.split('256 KB').length - 1, 1);
});

test('T8 faithful excerpts, Unicode avatars and no invented statistics', () => {
  assert.equal(excerpt('First sentence. Next sentence.'), 'First sentence.');
  assert.equal(excerpt('首句。后句。'), '首句。');
  assert.equal(excerpt('First sentence. 下一句。'), 'First sentence.');
  assert.equal(excerpt(''), '无描述');
  assert.equal(excerpt('a'.repeat(121)), 'a'.repeat(120) + '…');
  assert.equal(avatarLetter('-steven'), 'S');
  assert.equal(avatarLetter('实习日记员'), '实');
});

test('T8 cards use text nodes, show both platforms and disabled reason; available button dispatches selected CLI', () => {
  const launches = [];
  const { card } = createCard(doc, agent, { categories: [], onLaunch: (a, cli) => launches.push([a.id, cli]), onDetails() {} });
  const all = descendants(card);
  assert.ok(card.textContent.includes(agent.description.split('。')[0] + '。'));
  assert.ok(card.textContent.includes('统计中…'));
  assert.ok(card.textContent.includes('Codex ✓ / Claude ✗'));
  assert.equal(all.filter(n => n.tagName === 'img').length, 0);
  const buttons = all.filter(n => n.tagName.toLowerCase() === 'button');
  const claude = buttons.find(b => b.textContent === '在 Claude CLI 中调用');
  assert.equal(claude.disabled, true);
  assert.equal(claude.title, agent.platforms.claude.reason);
  assert.ok(card.textContent.includes(agent.platforms.claude.reason));
  buttons.find(b => b.textContent === '在 Codex CLI 中调用').fire('click');
  assert.deepEqual(launches, [['jack', 'codex']]);
});

const statFor = (recent, total) => ({ last7d: { calls: recent, ok: recent, failed: 0, unknown: 0, bySource: { claude: recent, codex: 0 } }, total: { calls: total, ok: total - 2, failed: 1, unknown: 1, bySource: { claude: total - 3, codex: 3 } }, launches: { last7d: 1, total: 2 }, lastAt: '2026-10-06T16:00:00Z' });
const stats = { building: false, sources: [{ id: 'claude', path: '<synthetic>', available: true, files: 2, parsedFiles: 1, failedFiles: [{ file: '<bad>', reason: 'synthetic' }], badLines: 3, earliestAt: '2026-09-01T00:00:00Z', latestAt: '2026-10-06T00:00:00Z', notes: ['synthetic note'] }], perAgent: { jack: statFor(0, 8), harlo: statFor(5, 12) }, limited: true, limitedReasons: ['合成覆盖限制'], outOfScopeEvents: 4, unlabeledSubagents: 2 };

test('S6 zero/building/no data DOM states, literal limitations, drawer sources/status/launches and UTC+8 midnight', () => {
  const card = data => createCard(doc, agent, { categories: [], onLaunch() {}, onDetails() {}, stats: data }).card;
  assert.match(card(stats).textContent, /近 7 天 0 · 累计 8/);
  assert.match(card({ ...stats, building: true }).textContent, /统计中…/);
  const noData = card({ ...stats, sources: stats.sources.map(s => ({ ...s, available: false })) });
  assert.match(noData.textContent, /暂无数据/); assert.doesNotMatch(noData.textContent, /累计 0/);
  assert.ok(!descendants(card(stats)).some(n => n.className === 'limited')); // H4: one overview indicator
  const body = new Element('div'); fillDetails(doc, body, agent, stats);
  for (const text of ['Claude 5', 'Codex 3', '成功 6', '失败 1', '未知 1', '启动', '2026-10-07 00:00:00']) assert.ok(body.textContent.includes(text), text);
  assert.equal(formatDate('2026-10-06T16:00:00Z'), '2026-10-07 00:00:00');
  const coverage = new Element('div'); renderCoverage(doc, coverage, stats);
  for (const text of ['<synthetic>', '<bad>', '坏行 3', '范围外事件 4', '未标注角色的子会话 2', '合成覆盖限制']) assert.ok(coverage.textContent.includes(text));
});

test('S6 category totals equal members, sort preserves default order and numbers agree across views', () => {
  const book = { ...agent, id: 'harlo', kind: 'book', name: 'Harlo', primary: 'History' };
  const registry = { agents: [agent, book], categories: ['History'], summary: { roles: 1, books: 1 } };
  const nav = new Element('nav'); renderNavigation(doc, nav, registry, 'book', () => {}, stats);
  assert.ok(nav.textContent.includes('History（1）')); assert.ok(nav.textContent.includes('功能性 Agent（1）'));
  assert.deepEqual(sortAgents(registry.agents, 'default', stats), registry.agents);
  assert.deepEqual(sortAgents(registry.agents, 'last7d', stats).map(a => a.id), ['harlo', 'jack']);
  assert.deepEqual(sortAgents(registry.agents, 'total', stats).map(a => a.id), ['harlo', 'jack']);
  assert.match(createCard(doc, book, { categories: [], onLaunch() {}, onDetails() {}, stats }).card.textContent, /近 7 天 5 · 累计 12/);
  const unavailable = { ...stats, sources: [] };
  renderNavigation(doc, nav, registry, 'book', () => {}, unavailable); assert.doesNotMatch(nav.textContent, /7 天 0 次/);
});

test('T8 full detail retains raw book metadata, source paths and literal HTML text', () => {
  const body = new Element('div');
  const book = { ...agent, kind: 'book', book: { title: '*Book*', author: 'Writer', edition: '版本未载明' } };
  fillDetails(doc, body, book);
  for (const text of [agent.description, agent.sourceFile, '*Book*', 'Writer', '版本未载明']) assert.ok(body.textContent.includes(text));
  assert.equal(descendants(body).filter(n => n.tagName === 'img').length, 0);
});

test('T8 navigation follows mapping order, computed counts and conditional uncategorized; status displays all four checks', () => {
  const nav = new Element('nav');
  renderNavigation(doc, nav, { categories: ['B', 'A'], agents: [agent, { ...agent, id: 'book', kind: 'book', primary: 'B' }], summary: { roles: 1, books: 1, uncategorized: 0 } }, 'role', () => {});
  assert.ok(nav.textContent.indexOf('B（1）') < nav.textContent.indexOf('A（0）'));
  assert.ok(!nav.textContent.includes('未分类'));
  const status = new Element('div');
  renderStatus(doc, status, { overall: 'ready', message: '已就绪 · Agent 首次提问后核验', process: { state: 'alive', pid: 42 }, cwd: { state: 'ok', observed: 'project' }, agent: { state: 'awaiting-first-call' }, waiting: { state: 'ok' } });
  for (const text of ['进程', '目录', 'Agent', '等待输入', '42', '首次提问后核验']) assert.ok(status.textContent.includes(text));
  assert.equal(pollFinished({ overall: 'ready', agent: { state: 'awaiting-first-call' } }), false);
  assert.equal(pollFinished({ overall: 'ready', agent: { state: 'confirmed' } }), true);
  assert.equal(pollFinished({ overall: 'unconfirmed' }), true);
});

test('T8 local-only frontend assets and narrow single-column rules', async () => {
  const [html, js] = await Promise.all(['public/index.html', 'public/app.js'].map(file => fs.readFile(file, 'utf8'))); const css=await allStyles();
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\)/);
});

const trustNotice = '首次在此目录使用交互式 Claude：请在弹出的窗口中选择「Yes, I trust this folder」并按回车，之后会话才会开始。';
test('finding #3 pending and unconfirmed cards prominently show notice; ready/failed cards hide it', async () => {
  const target = new Element('div');
  const status = { notice: trustNotice, process: { state: 'alive' }, cwd: { state: 'pending' }, agent: { state: 'pending' }, waiting: { state: 'pending' } };
  for (const overall of ['pending', 'unconfirmed', 'ready', 'failed']) {
    renderStatus(doc, target, { ...status, overall });
    const nodes = descendants(target).filter(n => n.className === 'launch-notice');
    assert.equal(nodes.length, ['pending', 'unconfirmed'].includes(overall) ? 1 : 0);
    if (nodes.length) {
      assert.equal(target.children[0], nodes[0]);
      assert.equal(nodes[0].textContent, trustNotice);
      assert.equal(nodes[0].attrs.role, 'note');
    }
  }
  const css = await allStyles();
  assert.match(css, /\.launch-notice\s*\{[^}]*font-weight:\s*600/);
  assert.match(css, /\.launch-notice\s*\{[^}]*background:/);
});

test('finding #3 launch notice is visible before first status GET and survives unconfirmed repaint', async t => {
  const {doc:mountedDoc,ids}=await appDocument();
  const available = { ...agent, platforms: { ...agent.platforms, claude: { available: true } } };
  const registry = { agents: [available], categories: [], summary: { roles: 1, books: 0, uncategorized: 0, outOfScope: 0, failed: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-06T12:00:00Z' };
  let completeStatus;
  const delayed = new Promise(resolve => { completeStatus = resolve; });
  const mounted = await mountApp(mountedDoc, async url => {
    const value = url === '/api/launch' ? { launchId: 'synthetic', notice: trustNotice } : url.startsWith('/api/launch/') ? await delayed : url==='/api/registry'||url==='/api/refresh'?registry:url==='/api/stats'?{perAgent:{},sources:[],limitedReasons:[]}:url==='/api/settings'?{recommend:{}}:{items:[]};
    return { ok: true, json: async () => value };
  });
  t.after(() => mounted.dispose());
  descendants(ids.cards).find(n => n.tagName.toLowerCase() === 'button' && n.textContent === '在 Claude CLI 中调用').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ids.cards.textContent.includes(trustNotice), 'notice must show while GET is still pending');
  completeStatus({ notice: trustNotice, overall: 'unconfirmed', message: '启动未确认', process: { state: 'alive', pid: 42 }, cwd: { state: 'pending' }, agent: { state: 'pending' }, waiting: { state: 'pending' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ids.cards.textContent.includes(trustNotice));
  assert.ok(ids.cards.textContent.includes('启动未确认'));
  ids.search.fire('input');
  assert.ok(ids.cards.textContent.includes(trustNotice), 'notice must survive rebuilding the card');
});

test('T8 mounted app supports filters, navigation, refresh, drawer and authenticated launch/status', async t => {
  const {doc:mountedDoc,ids}=await appDocument();
  const book = { ...agent, id: 'harlo', name: 'Harlo', kind: 'book', primary: 'History', description: 'Synthetic book Agent', book: { title: 'Book', author: 'Writer', edition: '2024' } };
  const registry = { agents: [agent, book], categories: ['History'], summary: { roles: 1, books: 1, uncategorized: 0, outOfScope: 0, failed: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-06T12:00:00Z' };
  const calls = [];
  const mounted = await mountApp(mountedDoc, async (url, options) => {
    calls.push({ url, options });
    const value = url === '/api/launch' ? { launchId: 'synthetic-launch' } : url.startsWith('/api/launch/') ?
      { overall: 'ready', message: '已就绪', process: { state: 'alive', pid: 42 }, cwd: { state: 'ok' }, agent: { state: 'confirmed' }, waiting: { state: 'ok' } } : url==='/api/registry'||url==='/api/refresh'?registry:url==='/api/stats'?{perAgent:{},sources:[],limitedReasons:[]}:url==='/api/settings'?{recommend:{}}:{items:[]};
    return { ok: true, json: async () => value };
  });
  t.after(() => mounted.dispose());
  assert.ok(ids.cards.textContent.includes('-jack'));
  assert.ok(!ids.cards.textContent.includes('Harlo'));
  ids.search.value = 'nothing'; ids.search.fire('input');
  assert.match(ids.cards.textContent, /没有匹配的 Agent/);
  ids.search.value = ''; ids.search.fire('input');
  descendants(ids.cards).find(n => n.tagName.toLowerCase() === 'button' && n.textContent === '-jack').fire('click');
  assert.equal(ids.detail.open, true);
  assert.ok(ids['detail-body'].textContent.includes(agent.description));
  ids['close-detail'].fire('click'); assert.equal(ids.detail.open, false);
  descendants(ids.cards).find(n => n.tagName.toLowerCase() === 'button' && n.textContent === '在 Codex CLI 中调用').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  const posted = calls.find(c => c.url === '/api/launch');
  assert.equal(posted.options.headers['X-Co-Agent-Token'], 'synthetic-token');
  assert.deepEqual(JSON.parse(posted.options.body), { agentId: 'jack', cli: 'codex' });
  assert.ok(ids.cards.textContent.includes('已就绪'));
  descendants(ids.navigation).find(n => n.tagName.toLowerCase() === 'button' && n.textContent === 'History（1）').fire('click');
  assert.ok(ids.cards.textContent.includes('Harlo'));
  assert.ok(!ids.cards.textContent.includes('-jack'));
  await ids.refresh.fire('click');
  assert.equal(calls.find(c=>c.url==='/api/refresh').options.method, 'POST');
});

test('S6 mounted sort, stats refresh authentication, coverage, drawer and navigation share one snapshot', async t => {
  const {doc:mountedDoc,ids}=await appDocument();
  const second = { ...agent, id: 'harlo', name: 'Harlo' };
  const registry = { agents: [agent, second], categories: [], summary: { roles: 2, books: 0, uncategorized: 0, outOfScope: 0, failed: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-06T12:00:00Z' };
  const calls = [];
  const mounted = await mountApp(mountedDoc, async (url, options) => {
    calls.push({ url, options });
    const value = url === '/api/stats/refresh' ? { ...stats, sources: stats.sources.map(s => ({ ...s, available: false })) } : url === '/api/stats' ? stats : url==='/api/registry'||url==='/api/refresh'?registry:url==='/api/stats'?{perAgent:{},sources:[],limitedReasons:[]}:url==='/api/settings'?{recommend:{}}:{items:[]};
    return { ok: true, json: async () => value };
  });
  t.after(() => mounted.dispose());
  assert.doesNotMatch(ids.navigation.textContent,/7 天/); // H4
  assert.ok(ids.cards.textContent.indexOf('-jack') < ids.cards.textContent.indexOf('Harlo'));
  ids.sort.value = 'last7d'; ids.sort.fire('change');
  assert.ok(ids.cards.textContent.indexOf('Harlo') < ids.cards.textContent.indexOf('-jack'));
  descendants(ids.cards).find(n => n.tagName.toLowerCase() === 'button' && n.textContent === '-jack').fire('click');
  assert.match(ids['detail-body'].textContent, /近 7 天 0 · 累计 8/);
  assert.ok(ids['stats-detail'].textContent.includes('范围外事件 4'));
  await ids['stats-refresh'].fire('click');
  const posted = calls.find(c => c.url === '/api/stats/refresh');
  assert.equal(posted.options.method, 'POST'); assert.equal(posted.options.headers['X-Co-Agent-Token'], 'synthetic-token');
  assert.match(ids.cards.textContent, /暂无数据/); assert.match(ids['detail-body'].textContent, /暂无数据/);
  assert.doesNotMatch(ids.navigation.textContent, /7 天 0 次/);
});
