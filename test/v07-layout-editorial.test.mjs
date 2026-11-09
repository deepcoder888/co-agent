import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as editorial from '../public/layouts/editorial.js';

const health = '睡眠／健康／运动';
const categories = [health, '投资／金融与金钱管理', '心理／认知与行为', '软件工程', '艺术／美学', '思维／逻辑／因果与不确定性', '经济学／经济史／博弈论', '商业／传记／组织管理', '哲学／神话', '学习／研究／工作方法', '科学／技术与社会'];
const agent = (id, kind, title) => ({ id, name: id, kind, primary: kind === 'role' ? '功能性 Agent' : health,
  description: '核对原书并解释问题。\n\n<example>user: 原始示例</example>\n\n保留完整说明。', purpose: kind === 'role' ? '调查和核对事实' : undefined,
  tags: [], book: kind === 'book' ? { title, author: '甲、乙、丙', edition: '2026' } : null,
  platforms: { claude: { available: true, file: 'fixture.md' }, codex: { available: true } },
  permissions: { claude: { model: 'sonnet', effort: 'high' } }, sources: { checked: true, total: 1, missing: [] }, sync: { state: '同步', detail: 'fixture' } });
const seedAgents = [agent('Peter', 'role'), agent('Walvo', 'book', '*Notes on Sample*'), agent('Jadra', 'book', '《示例力练习》'), agent('Rusko', 'book', '多书，2 部：《Sample Time》；《第二本》')];
const records = [{ type: 'joint', id: 'j1', agents: [{ id: 'Walvo', name: 'Walvo' }, { id: 'Jadra', name: 'Jadra' }],
  createdAt: '2026-10-06T16:01:02Z', cli: 'codex', source: 'manual', mode: 'joint', inputPreview: '<script>只当文本', status: { overall: 'done' }, canResume: true },
{ type: 'launch', id: 'l1', agents: [{ id: 'Peter', name: 'Peter' }], createdAt: '2026-10-06T01:00:00Z', cli: 'claude', status: { overall: 'failed' }, canResume: false, resumeReason: '会话文件不存在' }];
const find = (root, label) => descendants(root).find(n => n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === label || n.textContent === label));
const visible = node => !!node && !node.closest('[hidden]') && !(!node.closest('dialog')?.open && node.closest('dialog'));
async function fixture(t, { running = [], available = true, ui = 'editorial', members = seedAgents } = {}) {
  const doc = documentFrom((await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="fixture-token">'));
  doc.documentElement.setAttribute('data-ui', ui);
  const agents = structuredClone(members), calls = [];
  if (!available) agents[1].platforms.codex = { available: false, reason: '入口不存在' };
  const registry = { agents, categories, summary: { roles: 1, books: 3, synced: 4 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-07T00:00:00Z',
    // v0.53: the featured joint call comes from the catalog (registry.display).
    display: { shelfOrder: [], featured: { members: [{ id: 'walvo', label: 'Walvo' }, { id: 'jadra', label: 'Jadra' }, { id: 'rusko', label: 'Rusko' }], title: ['一个示例问题，', '请三位作者坐下来谈谈。'], text: '从三个示例角度回答同一个问题。一次联合调用，三份并排的回答。' } } };
  const stats = { perAgent: Object.fromEntries(agents.map(a => [a.id, { last7d: { calls: 2, bySource: { claude: 1, codex: 1 } }, total: { calls: 4, bySource: { claude: 2, codex: 2 } } }])), sources: [{ id: 'fixture', available: true, failedFiles: [] }], limited: true, limitedReasons: ['合成覆盖范围'] };
  const app = await mountApp(doc, async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
    const value = url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/stats' ? stats :
      url === '/api/settings' ? { ui: options.body ? JSON.parse(options.body).ui : ui, recommend: { claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-test', effort: 'xhigh' } } } :
      url.startsWith('/api/history?') ? { items: records } : url === '/api/running' ? { items: running } :
      url === '/api/history/Walvo' ? { items: [{ launchId: 'saved', cli: 'claude', createdAt: records[0].createdAt, mode: 'agent' }], unavailable: [] } :
      url.startsWith('/api/history/') && url !== '/api/history/rerun' ? { items: [], unavailable: [] } :
      url === '/api/recommend' ? { recommendId: 'r1' } : url === '/api/recommend/r1' ? { recommendId: 'r1', status: 'done', engine: 'claude', results: [{ id: 'Walvo', reason: '解释睡眠' }], audit: { ok: true, agentCalls: 0, children: 0 } } :
      url === '/api/launch' || url === '/api/resume' ? { launchId: 'new' } : url === '/api/launch/new' ? { overall: 'failed', message: '测试终态', process: { state: 'exited' }, cwd: { state: 'ok' }, agent: { state: 'pending' }, waiting: { state: 'pending' } } : { items: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  const get = id => doc.getElementById(id);
  return { doc, app, calls, registry, get, button: label => find(doc.documentElement, label) };
}

test('editorial §5.1: scoped offline paper palette, content width and original gutters', async () => {
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  assert.doesNotMatch(css, /@import|https?:|url\(/);
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    if (block[1].trim().startsWith('@')) continue;
    for (const selector of block[1].split(',')) assert.match(selector, /\[data-ui="editorial"\]/);
  }
  for (const color of ['#f7f4ee', '#1a1714', '#8a2b1c', '#3b352e', '#5a534a', '#d9d0c2', '#c9c0b3']) assert.ok(css.includes(color), color);
  assert.match(css, /max-width:\s*1312px/);
  assert.match(css, /padding:\s*40px 64px/);
  assert.match(css, /Georgia, "Songti SC", "SimSun", serif/);
  assert.match(css, /gap:\s*48px/);
});

test('editorial §5.2: dynamic issue, single brand, exactly six ordered columns and conditional running marker', async t => {
  const { doc, get, app } = await fixture(t);
  const [year, month] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  assert.equal(get('brand').children.find(n => n.tagName === 'H1').textContent, 'CO-AGENT');
  assert.equal(get('issue-date').textContent, `CO-AGENT · 第 4 期 · ${year} 年 ${Number(month)} 月`);
  assert.deepEqual(doc.querySelector('.editorial-columns').children.filter(n => !n.hidden).map(n => n.textContent), ['目录', '人物', '藏书', '调用组', '推荐', '概念', '圆桌', '会诊室', '顾问团','概念地图','对话', '统计', '往期', '设置'] /* v0.35 顾问团 */);
  assert.equal(get('editorial-running').hidden, true);
  assert.equal(doc.querySelector('.editorial-columns').querySelectorAll('nav').length, 0);
  const data = app.snapshot(); data.metrics.total = 81; data.state.date = '2026-12-31T16:00:00Z';
  const ctx = { doc, refs: { ...Object.fromEntries(descendants(doc.documentElement).filter(n => n.id).map(n => [n.id, n])) }, state: data.state };
  editorial.renderMetrics(ctx, data.metrics);
  assert.equal(get('issue-date').textContent, 'CO-AGENT · 第 81 期 · 2027 年 1 月');
});

test('editorial §5.2: active-session marker is immediately after archives and routes to running', async t => {
  const { doc, get, app } = await fixture(t, { running: [{ agentName: 'Walvo', type: 'launch', cli: 'claude', createdAt: records[0].createdAt, status: { overall: 'ready' } }] });
  const items = doc.querySelector('.editorial-columns').children;
  assert.deepEqual(items.map(n => n.textContent), ['目录', '人物', '藏书', '调用组', '推荐', '概念', '圆桌', '会诊室', '顾问团','概念地图','对话', '统计', '往期', '运行中 1', '设置']);
  assert.equal(get('editorial-running').hidden, false);
  await get('editorial-running').fire('click');
  assert.equal(app.snapshot().state.view, 'running'); assert.ok(visible(get('running-panel')));
});

test('editorial §5.3: focus copy, button order and numeric-first statistics', async t => {
  const { doc, get } = await fixture(t);
  const focus = doc.querySelector('.editorial-focus');
  assert.match(focus.textContent, /本周焦点一个示例问题，/);
  assert.match(focus.textContent, /Walvo、Jadra 与 Rusko/);
  assert.equal(focus.children.find(n => n.tagName === 'H2').querySelectorAll('br').length, 1);
  assert.deepEqual(focus.querySelectorAll('button').map(n => n.textContent), ['发起联合调用', '先让 AI 推荐']);
  assert.deepEqual(get('metrics').querySelectorAll('strong').map(n => n.textContent), ['8', '3', '1']);
  for (const tile of get('metrics').querySelectorAll('.metric-tile')) assert.equal(tile.children[0].tagName, 'STRONG');
  assert.deepEqual(get('metrics').querySelectorAll('.metric-label').map(n => n.textContent), ['近 7 天调用ⓘ', '书籍 Agent', '人名角色']);
  assert.equal(get('metrics').querySelectorAll('.scope-info').length, 1);
  assert.equal(focus.querySelector('#refresh'), null);
});

test('editorial §5.4: eyebrow/search then plain categories then numbered directory, cleaned titles and author line', async t => {
  const { doc, get, app } = await fixture(t); app.actions.selectCategory(health);
  const directory = doc.querySelector('.editorial-directory');
  assert.deepEqual(directory.children.slice(0, 3).map(n => n.id), ['editorial-directory-heading', 'navigation', 'catalog']);
  assert.equal(get('view-title').textContent, `藏书目录 · ${health}`);
  assert.equal(get('search-control').parentElement, get('view-title').parentElement);
  assert.equal(get('search').getAttribute('placeholder'), '检索作者、书名…');
  assert.equal(get('search').getAttribute('aria-label'), '全局搜索');
  assert.equal(get('search').getAttribute('title'), '/ 或 Ctrl+K');
  assert.equal(get('navigation').children.length, 13);
  assert.doesNotMatch(get('navigation').textContent, /\d|·|（|▼/);
  assert.equal(get('navigation').querySelectorAll('svg, details').length, 0);
  assert.equal(get('navigation').querySelector('[aria-current="page"]').getAttribute('title'), health);
  const rows = get('cards').querySelectorAll('.directory-row');
  assert.deepEqual(rows.map(n => n.querySelector('.directory-number').textContent), ['01', '02', '03']);
  assert.deepEqual(rows.map(n => n.querySelector('.directory-title').textContent), ['Notes on Sample', '示例力练习', 'Sample Time 等 2 本']);
  assert.equal(rows[0].querySelector('.row-subtitle').textContent, '甲、乙 · 由 Walvo 主讲');
  for (const row of rows) assert.deepEqual(row.querySelector('.directory-actions').children.map(n => n.textContent), ['Claude', 'Codex']);
  assert.doesNotMatch(get('cards').textContent, /\*|《|<example>|范围有限/);
  app.actions.selectCategory('role');
  assert.equal(get('cards').querySelector('.directory-title').textContent, 'Peter');
  assert.equal(get('cards').querySelector('.row-subtitle').textContent, '调查和核对事实');
});

test('editorial §5.1–4 and E2: accepted typography with original headline/directory sizes; shapes and spacing stay local', async () => {
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  for (const pattern of [/800 88px\/1/, /600 46px\/1\.15/, /17px\/1\.8/, /600 64px\/1/, /600 36px/, /600 22px/, /height:\s*48px/, /padding:\s*18px 0/, /border-bottom:\s*3px solid/, /border-bottom:\s*1px solid/, /gap:\s*22px/, /gap:\s*32px/, /border-radius:\s*0/]) assert.match(css, pattern);
});

test('editorial E2-1: original 46px headline has two complete lines without hanging punctuation', async t => {
  const { doc } = await fixture(t);
  const title = doc.querySelector('.editorial-focus').children.find(n => n.tagName === 'H2');
  assert.deepEqual(title.children.map(n => [n.tagName, n.textContent]), [
    ['SPAN', '一个示例问题，'], ['BR', ''], ['SPAN', '请三位作者坐下来谈谈。']
  ]);
  assert.equal(title.querySelector('.hanging-stop'), null);
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  assert.match(css, /\.editorial-focus h2\s*\{[^}]*font:\s*600 46px\/1\.15/);
  assert.doesNotMatch(css, /hanging-stop|600 52px/);
});

test('editorial E2-2: catalog and recommendation titles use supplied spineTitle or helper fallback, retaining full tooltips', async t => {
  const { app } = await fixture(t);
  const models = app.snapshot(), doc = documentFrom('<body></body>');
  const ctx = { doc, refs: {}, state: models.state, actions: app.actions };
  doc.body.append(editorial.render(ctx)); t.after(() => ctx.refs.dispose());
  const books = [
    { ...models.state.allAgents.find(a => a.id === 'Walvo'), book: { title: '*Notes on Sample: Opening the Store of Samples*' }, cleanTitle: 'Notes on Sample: Opening the Store of Samples', spineTitle: undefined },
    { ...models.state.allAgents.find(a => a.id === 'Jadra'), book: { title: '《示例力练习（珍藏版）：示例的日常》' }, cleanTitle: '示例力练习（珍藏版）：示例的日常', spineTitle: '示例力练习' },
    { ...models.state.allAgents.find(a => a.id === 'Rusko'), book: null, cleanTitle: 'Sample Time: A Sample Clock', spineTitle: undefined }
  ];
  const titles = ['Notes on Sample', '示例力练习', 'Sample Time'];
  const full = ['Notes on Sample: Opening the Store of Samples', '示例力练习（珍藏版）：示例的日常', 'Sample Time: A Sample Clock'];
  const before = structuredClone(books);
  editorial.renderCatalog(ctx, { ...models.catalog, agents: books });
  editorial.renderRecommend(ctx, { ...models.recommend, results: books });
  for (const target of [ctx.refs.cards, ctx.refs['recommend-results']]) {
    const headings = target.querySelectorAll('.directory-title');
    assert.deepEqual(headings.map(n => n.textContent), titles);
    assert.deepEqual(headings.map(n => n.getAttribute('title')), full.map(t => `${t}
Ctrl+单击打开原书`)); // v0.10 hint
    assert.doesNotMatch(headings.map(n => n.textContent).join(''), /\*|《|：|:/);
  }
  assert.deepEqual(books, before, 'presentation must not mutate shared models');
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  assert.match(css, /\.directory-title\s*\{[^}]*font:\s*600 22px\/1\.2/);
});

test('editorial E2-3: focus selects exactly the three existing IDs regardless of directory filter or previous selection', async t => {
  const members = seedAgents.map(a => ({ ...a, id: a.id.toLowerCase() }));
  const { app, button, get, calls } = await fixture(t, { members });
  app.actions.addToJoint('peter', undefined, false);
  app.actions.search('no matching author');
  assert.equal(app.snapshot().catalog.count, 0);
  const trigger = button('新建联合调用'); trigger.focus(); await trigger.fire('click');
  assert.equal(get('joint-builder').open, true);
  assert.deepEqual(app.snapshot().state.jointSelectedIds, ['walvo', 'jadra', 'rusko']);
  assert.equal(calls.filter(c => c.url === '/api/joint').length, 0, 'opening must not launch');
  await get('joint-builder').fire('keydown', { key: 'Escape' }); assert.equal(get('joint-builder').open, false);
  assert.equal(get('builder-input').value, '');
});

for (const missing of ['Walvo', 'Jadra', 'Rusko']) test(`editorial E2-3: missing ${missing} uses generic copy and an empty builder, never a partial prefill`, async t => {
  const members = seedAgents.filter(a => a.id !== missing);
  // A matching display name is not the specified identity.
  members.push({ ...agent('different-id', 'book', '无关书籍'), name: missing });
  const { app, doc, button, get } = await fixture(t, { members });
  const copy = doc.querySelector('.focus-copy');
  assert.equal(copy.textContent, '一个问题，多位作者的回答。');
  app.actions.addToJoint('Peter', undefined, false);
  await button('新建联合调用').fire('click');
  assert.equal(get('joint-builder').open, true);
  assert.deepEqual(app.snapshot().state.jointSelectedIds, []);
});

test('editorial E2-3: registry refresh updates both focus copy and click-time prefill without remounting', async t => {
  const { app, doc, registry, button, get } = await fixture(t);
  const trigger = button('新建联合调用');
  registry.agents = registry.agents.filter(a => a.id !== 'Jadra'); await app.actions.refresh();
  assert.equal(doc.querySelector('.focus-copy').textContent, '一个问题，多位作者的回答。');
  await trigger.fire('click'); assert.deepEqual(app.snapshot().state.jointSelectedIds, []); await get('builder-close').fire('click');
  registry.agents.push(structuredClone(seedAgents[2])); await app.actions.refresh();
  assert.match(doc.querySelector('.focus-copy').textContent, /Walvo、Jadra 与 Rusko/);
  await trigger.fire('click'); assert.deepEqual(app.snapshot().state.jointSelectedIds, ['Walvo', 'Jadra', 'Rusko']);
});

test('editorial E2-3: an absent allAgents snapshot starts with safe generic copy and no prefill', async t => {
  const doc = documentFrom('<body></body>'), opened = [];
  const ctx = { doc, refs: {}, state: {}, actions: { openJoint: ids => opened.push(ids) } };
  doc.body.append(editorial.render(ctx)); t.after(() => ctx.refs.dispose());
  assert.equal(doc.querySelector('.focus-copy').textContent, '一个问题，多位作者的回答。');
  await find(doc.body, '新建联合调用').fire('click'); assert.deepEqual(opened, [[]]);
});

test('editorial E2-4: scope information follows the seven-day label in flow, with keyboard-accessible explanation', async t => {
  const { doc, get, app } = await fixture(t), metrics = get('metrics');
  const labels = metrics.querySelectorAll('.metric-label'), info = metrics.querySelector('.scope-info');
  assert.ok(info.parentElement === labels[0], 'scope marker must belong to the first metric label');
  assert.ok(labels[0].children.at(-1) === info, 'scope marker must follow the label text');
  assert.equal(labels[0].textContent, '近 7 天调用ⓘ');
  assert.equal(info.getAttribute('title'), '合成覆盖范围'); assert.equal(info.getAttribute('tabindex'), '0');
  assert.match(info.getAttribute('aria-label'), /统计范围有限：合成覆盖范围/);
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  const rule = css.match(/\.scope-info\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(rule, /position:\s*(absolute|fixed)|(?:top|right):/);
  const model = app.snapshot();
  editorial.renderMetrics({ doc, refs: { metrics, 'issue-date': get('issue-date') }, state: model.state }, { ...model.metrics, scopeLimited: false, recent7: null, statsState: 'building' });
  assert.equal(metrics.querySelector('.scope-info'), null);
  assert.equal(metrics.querySelector('strong').textContent, '统计中…');
});

test('editorial S2 compatibility: use localized history fields when available and raw fields otherwise', async t => {
  const { app } = await fixture(t), doc = documentFrom('<body></body>'), models = app.snapshot();
  const ctx = { doc, refs: {}, state: { ...models.state, view: 'history', detailOpen: true }, actions: app.actions };
  doc.body.append(editorial.render(ctx)); t.after(() => ctx.refs.dispose());
  for (const localized of [true, false]) {
    const record = { ...records[0], ...(localized ? { cliLabel: 'Codex', sourceLabel: '手动', modeLabel: '联合', statusTone: 'ok' } : {}) };
    editorial.renderHistory(ctx, { ...models.history, items: [record], selected: record });
    assert.match(ctx.refs['history-list'].textContent, localized ? /Codex/ : /codex/);
    assert.match(ctx.refs['detail-body'].textContent, localized ? /模式：联合 · 来源：手动/ : /模式：joint · 来源：manual/);
  }
});

test('editorial E2 CSP: owned markup never sets blocked style attributes', async t => {
  const { doc, app } = await fixture(t);
  for (const view of ['catalog', 'recommend', 'history', 'coverage', 'running']) {
    await app.actions.showView(view);
    assert.equal(doc.querySelector('.layout-editorial').querySelectorAll('[style]').length, 0);
  }
  const source = await fs.readFile('public/layouts/editorial.js', 'utf8');
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]|\.style\s*=|\.cssText\s*=/);
});

test('editorial §5.5: owned right drawer provides complete detail and literal, cleaned display text', async t => {
  const { app, get, doc } = await fixture(t); app.actions.selectCategory(health);
  const trigger = find(get('cards'), '查看 Walvo 详情'); trigger.focus(); await trigger.fire('click');
  assert.equal(get('detail').open, true); assert.ok(get('detail').className.includes('editorial-drawer'));
  assert.equal(get('detail').className.split(/\s/).includes('drawer'), false);
  for (const label of ['完整说明', '权限与模型', '来源与书目', '原书路径', '双版本同步', '调用统计', '继续上次会话']) assert.match(get('detail-body').textContent, new RegExp(label));
  assert.match(get('detail-body').textContent, /保留完整说明/); assert.doesNotMatch(get('detail-body').textContent, /<example>|原始示例|\*Why/);
  // v0.10: the agent-linked drawer title is focusable (Ctrl+Enter), so the trap starts at the first focusable, not necessarily 关闭.
  const close = get('detail-title').getAttribute('tabindex') === '0' ? get('detail-title') : get('close-detail'); close.focus();
  await get('detail').fire('keydown', { key: 'Tab', shiftKey: true }); assert.notEqual(doc.activeElement, close);
  await get('detail').fire('keydown', { key: 'Escape' });
  assert.equal(get('detail').open, false); assert.equal(doc.activeElement.getAttribute('data-focus-key'), trigger.getAttribute('data-focus-key'));
  await app.actions.refreshRunning(); assert.equal(get('detail').open, false);
});

test('editorial §5.5: archives use date/member/italic metadata/action columns, filters and disabled resume reason', async t => {
  const { button, get, calls, app } = await fixture(t); await button('历史调用').fire('click');
  assert.ok(visible(get('history-panel'))); assert.equal(get('navigation').hidden, true);
  assert.equal(get('view-title').textContent, '往期 · 历史调用');
  const rows = get('history-list').querySelectorAll('.history-row');
  assert.equal(rows[0].querySelector('.history-md').textContent, '10-07'); assert.equal(rows[0].querySelector('.history-year').textContent, '2026'); /* v0.16 */
  assert.equal(rows[0].querySelector('.directory-title').textContent, 'Walvo、Jadra');
  assert.match(rows[0].querySelector('.row-subtitle').textContent, /<script>只当文本.*[Cc]odex.*完成/);
  assert.match(rows[0].textContent, /联合 · 2 个/); assert.equal(rows[0].querySelectorAll('script').length, 0);
  assert.deepEqual(rows[0].querySelector('.directory-actions').children.map(n => n.textContent), ['重新调用', '继续']);
  await find(rows[0], '重新调用 Walvo、Jadra').fire('click');
  await find(get('history-list'), '继续该次会话 Walvo、Jadra').fire('click');
  assert.deepEqual(calls.find(c => c.url === '/api/history/rerun').body, { type: 'joint', id: 'j1' });
  assert.deepEqual(calls.find(c => c.url === '/api/resume').body, { type: 'joint', id: 'j1' });
  const noResume = find(get('history-list'), '继续该次会话 Peter'); assert.equal(noResume.disabled, true); assert.equal(noResume.getAttribute('title'), '会话文件不存在');
  get('history-filter').value = 'joint'; await get('history-filter').fire('change'); assert.equal(app.snapshot().history.filter, 'joint');
});

test('editorial §5.5: recommendation form replaces left focus, results use right directory and join controls', async t => {
  const { button, get, doc, calls } = await fixture(t); await button('AI 推荐').fire('click');
  assert.ok(visible(get('recommend-panel'))); assert.ok(get('recommend-panel').closest('.editorial-left'));
  assert.ok(get('recommend-results').closest('.editorial-directory')); assert.equal(doc.querySelector('.editorial-focus').hidden, true);
  get('recommend-input').value = '解释睡眠'; await get('recommend-input').fire('input'); await get('recommend-submit').fire('click');
  assert.ok(calls.some(c => c.url === '/api/recommend'));
  const row = get('recommend-results').querySelector('.directory-row'); assert.ok(row); assert.match(row.textContent, /Notes on Sample/);
  assert.equal(row.querySelectorAll('.avatar, .card').length, 0);
  const check = row.querySelector('input'); assert.equal(check.getAttribute('aria-label'), '加入联合调用 Walvo');
  check.checked = true; await check.fire('change'); assert.equal(get('joint-submit').disabled, false);
});

test('editorial §5.5: square serif joint skin preserves shared selection, input and keyboard focus', async t => {
  const { button, get, doc } = await fixture(t); const trigger = button('新建联合调用'); trigger.focus(); await trigger.fire('click');
  assert.equal(get('joint-builder').open, true); assert.match(get('joint-builder').className, /editorial-builder/);
  assert.equal(doc.activeElement, get('builder-search'));
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8');
  assert.match(css, /\.editorial-builder\s*\{[^}]*border-radius:\s*0/);
  assert.match(css, /\.editorial-builder h2/); assert.match(css, /#builder-submit/);
  await get('joint-builder').fire('keydown', { key: 'Escape' }); assert.equal(doc.activeElement, trigger);
});

test('editorial: all eleven functions remain reachable through real shared actions with mocked APIs', async t => {
  const { app, button, get, doc, calls } = await fixture(t, { running: [{ type: 'launch', agentName: 'Walvo', cli: 'claude', createdAt: records[0].createdAt }] });
  await button('藏书').fire('click'); assert.equal(app.snapshot().state.category, 'book');
  await find(get('navigation'), health).fire('click'); assert.equal(app.snapshot().state.category, health);
  for (const event of [{ key: '/', target: doc.body }, { key: 'k', ctrlKey: true, target: doc.body }]) { await doc.fire('keydown', { ...event, preventDefault() {} }); assert.equal(doc.activeElement, get('search')); }
  get('search').value = 'Walvo'; await get('search').fire('input'); assert.equal(app.snapshot().catalog.count, 1);
  await button('查看 Walvo 详情').fire('click'); assert.equal(get('detail').open, true);
  for (const cli of ['Claude', 'Codex']) await find(get('detail-body'), `在 ${cli} CLI 中调用 Walvo`).fire('click');
  assert.deepEqual(calls.filter(c => c.url === '/api/launch').map(c => c.body.cli), ['claude', 'codex']);
  const resume = get('detail-body').querySelector('[data-focus-key="resume-Walvo-saved"]'); await resume.fire('click');
  assert.ok(calls.some(c => c.url === '/api/resume' && c.body.launchId === 'saved'));
  await get('close-detail').fire('click'); await button('AI 推荐').fire('click'); assert.ok(visible(get('recommend-panel')));
  await button('目录').fire('click'); await button('新建联合调用').fire('click'); assert.equal(get('joint-builder').open, true); await get('builder-close').fire('click');
  await button('历史调用').fire('click'); assert.ok(visible(get('history-panel')));
  await button('运行中的会话').fire('click'); assert.ok(visible(get('running-panel')));
  await button('打开设置').fire('click'); assert.equal(get('settings-dialog').open, true);
  assert.ok(get('settings-coverage').closest('section')); await get('settings-coverage').fire('click'); assert.ok(visible(get('coverage-panel')));
  assert.ok(get('refresh').closest('#settings-dialog'));
});

test('editorial: unavailable platform has a disabled link and accessible reason', async t => {
  const { app, get } = await fixture(t, { available: false }); app.actions.selectCategory(health);
  const launch = find(get('cards'), '在 Codex CLI 中调用 Walvo'); assert.equal(launch.disabled, true); assert.equal(launch.getAttribute('title'), '入口不存在');
  assert.ok(launch.getAttribute('aria-describedby'));
});

test('editorial: switching to and from every layout preserves shared state and drafts without reload/refetch', async t => {
  const { app, doc, get, calls } = await fixture(t); app.actions.selectCategory(health); await app.actions.openDetail('Walvo'); app.actions.search('Walvo');
  app.actions.setRecommendInput('未提交的杂志草稿'); app.actions.setRecommendEngine('codex'); app.actions.addToJoint('Jadra', undefined, false);
  app.actions.openJoint(undefined); get('builder-input').value = '联合草稿'; await get('builder-input').fire('input'); await get('builder-close').fire('click');
  await app.actions.setHistoryFilter('joint'); app.actions.openSettings();
  for (const index of [0, 2, 1, 2, 3, 2]) {
    await doc.querySelectorAll('[role="radio"]')[index].fire('click');
    const model = app.snapshot(); assert.equal(model.state.category, health); assert.equal(model.state.selectedId, 'Walvo'); assert.equal(model.state.query, 'Walvo');
    assert.equal(model.recommend.input, '未提交的杂志草稿'); assert.equal(model.recommend.engine, 'codex'); assert.deepEqual(model.state.jointSelectedIds, ['Jadra']);
    assert.equal(model.history.filter, 'joint'); assert.equal(get('builder-input').value, '联合草稿'); assert.equal(get('detail').open, false);
    assert.equal(doc.querySelectorAll('[id="search"]').length, 1); assert.equal(doc.querySelectorAll('[id="detail"]').length, 1);
  }
  assert.equal(calls.filter(c => c.url === '/api/registry').length, 1); assert.equal(calls.filter(c => c.url === '/api/recommend').length, 0);
});
