import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp, toAgentView, toDetailView, permissionText } from '../public/app.js';
import { createConcepts } from '../public/concepts.js';
import { layouts } from '../public/layouts/index.js';

// Entirely synthetic API/DOM fixtures: no server, disk scan or CLI process.
const member = (extra = {}) => ({ id: 'author', name: 'Author', kind: 'book', primary: '学习',
  description: '测试书籍 Agent', book: { title: '测试书籍', author: '作者' }, tags: [], writable: false,
  platforms: { claude: { available: true, file: 'fixture.md' }, codex: { available: true } },
  permissions: { codex: { sandbox: 'workspace-write', model: 'fixture', effort: 'high' }, claude: { writable: true, tools: ['Read', 'Edit'] } },
  sources: { checked: true, total: 1, missing: [], missingByVersion: { codex: [], claude: [] } },
  sync: { state: '同步', detail: '描述与正文一致' }, ...extra });
const registryFor = agent => ({ agents: [agent], categories: ['学习'], summary: { roles: 0, books: 1, synced: 1 },
  sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-21T01:00:00Z' });
const bucket = { calls: 1, ok: 1, failed: 0, unknown: 0, bySource: { claude: 1, codex: 0 } };
const readyStats = { building: false, sources: [{ id: 'fixture', available: true, failedFiles: [] }],
  perAgent: { author: { last7d: bucket, last30d: bucket, total: bucket } }, daily: [], limitedReasons: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const oldLaunch = cli => ({ type: 'launch', id: 'old-launch', cli, agents: [{ id: 'author', name: 'Author' }],
  canResume: true, createdAt: '2026-10-20T01:00:00Z', status: { overall: 'closed' } });

function safeDOM(doc) {
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag), set = el.setAttribute.bind(el);
    for (const name of ['innerHTML', 'outerHTML']) Object.defineProperty(el, name, { set() { assert.fail(`${name} is forbidden`); } });
    el.setAttribute = (key, value) => { assert.notEqual(key, 'style', 'CSP forbids style attributes'); set(key, value); };
    return el;
  };
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; };
  return doc;
}

async function mounted(t, { agent = member(), cli = 'codex', ui = 'threepane', answer = async () => true, statsReply } = {}) {
  const { doc } = await appDocument(ui, 'v029-test-token'); safeDOM(doc);
  const registry = registryFor(agent), requests = [], prompts = [];
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, body, opts });
    let value;
    if (url === '/api/registry' || url === '/api/refresh') value = registry;
    else if (url === '/api/stats' || url === '/api/stats/refresh') value = statsReply ? await statsReply(url) : readyStats;
    else if (url === '/api/settings') value = { ui: body?.ui || ui, recommend: { codex: { model: 'fixture' } } };
    else if (url === '/api/pins') value = { ids: [] };
    else if (url.startsWith('/api/history?')) value = { items: [oldLaunch(cli)] };
    else if (url === '/api/history/author') value = { items: [{ ...oldLaunch(cli), launchId: 'old-launch' }], unavailable: [] };
    else if (['/api/launch', '/api/resume', '/api/history/rerun'].includes(url)) value = { launchId: 'new-launch' };
    else if (url === '/api/launch/new-launch') value = { overall: 'ready', agent: { state: 'confirmed' } };
    else if (url === '/api/concepts?limit=30') value = { items: [], today: null, running: null };
    else value = { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async text => { prompts.push(text); return answer(text, prompts.length); } });
  t.after(() => app.dispose());
  return { app, doc, registry, requests, prompts, get: id => doc.getElementById(id) };
}

const launchRoutes = {
  launch: (app, cli) => app.actions.launch('author', cli),
  resume: (app, cli) => app.actions.resume('author', cli, 'old-launch'),
  latest: (app, cli) => app.actions.resume('author', cli),
  history: app => app.actions.resumeHistory('launch', 'old-launch'),
  rerun: app => app.actions.rerun('launch', 'old-launch'),
};
const executionRequests = h => h.requests.filter(r => ['/api/launch', '/api/resume', '/api/history/rerun'].includes(r.url));

for (const cli of ['codex', 'claude']) for (const [route, invoke] of Object.entries(launchRoutes)) {
  test(`v029 5.1 ${cli} ${route}: writable confirmation precedes sources; accepted flags reach the API`, async t => {
    const path = 'fixture.epub（仅 Claude 版本）', agent = member({ writable: true,
      sources: { checked: true, total: 1, missing: [path], missingByVersion: { codex: [], claude: ['fixture.epub'] } } });
    const h = await mounted(t, { agent, cli }); await invoke(h.app, cli);
    assert.deepEqual(h.prompts, [`以下 Agent 可写或权限未声明，请确认后执行：\nAuthor\n${permissionText(agent)}`,
      ...(cli === 'claude' ? ['原书路径失效，请确认后执行：\nAuthor：fixture.epub'] : [])]);
    const [request] = executionRequests(h); assert.equal(executionRequests(h).length, 1);
    assert.equal(request.url, route === 'launch' ? '/api/launch' : route === 'rerun' ? '/api/history/rerun' : '/api/resume');
    assert.deepEqual(request.body, { ...(route === 'rerun' ? { type: 'launch', id: 'old-launch' }
      : { agentId: 'author', ...(route === 'launch' ? { cli } : { launchId: 'old-launch' }) }), writableConfirmed: true,
      ...(cli === 'claude' ? { sourcesConfirmed: true } : {}) });
    assert.equal(request.opts.method, 'POST'); assert.equal(request.opts.headers['X-Co-Agent-Token'], 'v029-test-token');
  });
}

for (const [route, invoke] of Object.entries(launchRoutes)) {
  for (const declineAt of [1, 2]) test(`v029 5.1 ${route}: cancelling confirmation ${declineAt} sends no execution request`, async t => {
    const h = await mounted(t, { agent: member({ writable: true, sources: { checked: true, missing: ['missing.epub'] } }),
      answer: async (_text, count) => count !== declineAt });
    await invoke(h.app, 'codex');
    assert.equal(h.prompts.length, declineAt); assert.deepEqual(executionRequests(h), []);
    assert.equal(h.app.snapshot().state.allAgents[0].launchBusy, false);
    assert.equal(h.app.snapshot().history.busy, false);
  });
  test(`v029 5.1 ${route}: read-only Agent needs no confirmation or writable flag`, async t => {
    const h = await mounted(t); await invoke(h.app, 'codex');
    assert.deepEqual(h.prompts, []); assert.equal(executionRequests(h).length, 1);
    assert.equal(Object.hasOwn(executionRequests(h)[0].body, 'writableConfirmed'), false);
    assert.equal(Object.hasOwn(executionRequests(h)[0].body, 'sourcesConfirmed'), false);
  });
}

test('v029 5.1 awaiting confirmation blocks duplicate launch; cancellation releases busy state', async t => {
  const reply = pending(), asked = pending();
  const h = await mounted(t, { agent: member({ writable: true }), answer: () => { asked.resolve(); return reply.promise; } });
  const launching = h.app.actions.launch('author', 'codex'); await asked.promise;
  await h.app.actions.launch('author', 'codex');
  assert.equal(h.prompts.length, 1); assert.deepEqual(executionRequests(h), []);
  assert.equal(h.app.snapshot().state.allAgents[0].launchBusy, true);
  reply.resolve(false); await launching;
  assert.equal(h.app.snapshot().state.allAgents[0].launchBusy, false);
});

const differences = { state: '描述和指令都不同', detail: '有删改',
  descriptionDiff: { codex: '原描述', claude: 'Claude 描述 <img src=x>' },
  diff: [{ codex: '原指令 <script>literal</script>', claude: '改写的指令' }, { codex: '被删除的行', claude: null }, { codex: null, claude: '另一行' }] };
test('v029 5.2 sync details preserve aligned rows, missing-line markers and safe repair advice', () => {
  const agent = toAgentView(member({ sync: differences })), before = structuredClone(agent);
  const rows = toDetailView(agent).sections.find(s => s.key === 'sync').rows;
  assert.deepEqual(rows, [
    { label: '状态', value: '两个版本的描述和指令都不同：有删改' },
    { label: 'Codex 描述', value: '原描述' }, { label: 'Claude 描述', value: 'Claude 描述 <img src=x>' },
    { label: 'Codex', value: '原指令 <script>literal</script>' }, { label: 'Claude', value: '改写的指令' },
    { label: 'Codex', value: '被删除的行' }, { label: 'Claude', value: '（无此行）' },
    { label: 'Codex', value: '（无此行）' }, { label: 'Claude', value: '另一行' },
    { label: '如需一致', value: '对照差异手动更新 Claude 版本，保留其中专为 Claude 写的工具映射段' },
  ]);
  assert.deepEqual(agent, before);
  for (const state of ['描述不同', '指令不同', '无法比较']) {
    const legacy = toDetailView(toAgentView(member({ sync: { state, detail: '旧接口' } }))).sections.find(s => s.key === 'sync').rows;
    assert.equal(legacy.length, 2); assert.equal(legacy[1].label, '如需一致');
  }
  const detail = '描述与正文一致；Claude 版本另有 3 行附加内容（如工具映射）';
  const synced = toDetailView(toAgentView(member({ sync: { ...differences, state: '同步', detail } }))).sections.find(s => s.key === 'sync').rows;
  assert.deepEqual(synced, [{ label: '状态', value: `两个版本一致：${detail}` }]);
});

function isolated(t, ui, view) {
  const doc = safeDOM(documentFrom('<body><div id="layout-root"></div></body>'));
  const ctx = { doc, refs: {}, state: { view, category: 'book', selectedId: null, allAgents: [], jointSelectedIds: [], detailOpen: false },
    actions: new Proxy({}, { get: () => () => {} }) };
  ctx.root = layouts[ui].render(ctx); doc.getElementById('layout-root').append(ctx.root);
  t.after(() => ctx.refs.dispose?.());
  return { doc, ctx, get: id => doc.getElementById(id) };
}

const emptyConcepts = () => ({ items: [], today: undefined, selected: null, running: null, busy: false, error: '' });
const concept = { conceptId: 'today', status: 'done', kind: 'daily', day: '2026-10-21', createdAt: '2026-10-21T01:00:00Z',
  agent: { id: 'author', name: 'Author', title: '测试书籍' }, perspectives: [],
  result: { concept: '认知边界', oneLine: '一句话', whyUnknown: '说明', markdown: '正文', sourceRefs: [] } };

for (const ui of Object.keys(layouts)) {
  test(`v029 5.2 ${ui}: rendered sync/source evidence is literal text, never executable markup`, async t => {
    const path = 'fixture.epub（仅 Claude 版本）';
    const h = await mounted(t, { ui, agent: member({ sync: differences, sources: { checked: true, missing: [path] },
      reports: [{ index: 0, label: '自动匹配报告', auto: true, available: true }] }) });
    await h.app.actions.openDetail('author'); const body = h.get('detail-body');
    for (const text of ['原描述', 'Claude 描述 <img src=x>', '原指令 <script>literal</script>', '改写的指令', '被删除的行', '（无此行）', '另一行', '保留其中专为 Claude 写的工具映射段', path]) assert.ok(body.textContent.includes(text), text);
    assert.doesNotMatch(body.textContent, /删除过期|port_codex_agents/);
    assert.equal(body.querySelector('img,script'), null);
    assert.equal(h.app.snapshot().detail.reports[0].auto, true);
  });

  test(`v029 5.3 ${ui}: coverage adds both report groups, renders empty groups and omits them for the old API`, t => {
    const h = isolated(t, ui, 'coverage'), registry = registryFor(member());
    const model = { registry, stats: readyStats, loading: false, statsLoading: false };
    const render = () => layouts[ui].renderCoverage(h.ctx, model), target = h.get('scan-detail');
    const groupValues = () => {
      const groups = new Map(); let values;
      for (const node of target.children) {
        if (node.tagName === 'H3') { values = []; groups.set(node.textContent, values); }
        else values.push(node.textContent);
      }
      return groups;
    };
    render(); assert.equal(groupValues().has('无 Word 报告的书籍'), false);
    assert.equal(groupValues().has('未登记的 Word 报告文件'), false);
    registry.reports = { booksWithout: [{ id: 'a', name: 'Author <img>', title: '书籍 <script>literal</script>' },
      { id: 'b', name: '第二位作者', title: '另一部书' }], unusedFiles: ['未登记.docx', '<img onerror=x>.docx'], directory: 'fixture-word' };
    registry.summary.reportsMissing = 2; const before = structuredClone(registry);
    render();
    assert.deepEqual(groupValues().get('无 Word 报告的书籍'), ['Author <img>：书籍 <script>literal</script>', '第二位作者：另一部书']);
    assert.deepEqual(groupValues().get('未登记的 Word 报告文件'), registry.reports.unusedFiles);
    assert.ok(groupValues().has('无法解析')); assert.ok(groupValues().has('映射存在、目录缺失'));
    assert.equal(target.querySelector('script,img'), null); assert.deepEqual(registry, before);
    registry.reports = { booksWithout: [], unusedFiles: [], directory: 'fixture-word' }; render();
    for (const key of ['无 Word 报告的书籍', '未登记的 Word 报告文件']) assert.deepEqual(groupValues().get(key), ['无']);
    delete registry.reports; render(); assert.equal(groupValues().has('无 Word 报告的书籍'), false);
    assert.equal(groupValues().has('未登记的 Word 报告文件'), false);
    assert.ok(descendants(target).every(node => node.getAttribute('style') === null));
  });

  test(`v029 5.4 ${ui}: opening stats POSTs refresh, polls building by GET, then shows the result`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let rebuilding = false;
    const h = await mounted(t, { ui, statsReply: url => {
      if (url.endsWith('/refresh')) { rebuilding = true; return { ...readyStats, building: true }; }
      rebuilding = false; return readyStats;
    } });
    assert.equal(h.requests.filter(r => r.url === '/api/stats/refresh').length, 0, 'startup stays a GET');
    await h.app.actions.openStats();
    const refresh = h.requests.find(r => r.url === '/api/stats/refresh');
    assert.deepEqual(refresh.body, {}); assert.equal(refresh.opts.method, 'POST');
    assert.equal(h.app.snapshot().state.view, 'stats'); assert.equal(h.app.snapshot().stats.status, 'loading');
    assert.match(h.get('stats-panel').textContent, /统计正在建立/); assert.equal(rebuilding, true);
    const reads = h.requests.filter(r => r.url === '/api/stats').length;
    t.mock.timers.tick(1000); await tick();
    assert.equal(h.requests.filter(r => r.url === '/api/stats').length, reads + 1);
    assert.equal(h.requests.filter(r => r.url === '/api/stats/refresh').length, 1);
    assert.equal(h.app.snapshot().stats.status, 'ready'); assert.equal(rebuilding, false);
    assert.doesNotMatch(h.get('stats-panel').textContent, /统计正在建立/);
    await h.app.actions.showView('stats'); assert.equal(h.requests.filter(r => r.url === '/api/stats/refresh').length, 2);
  });

  test(`v029 5.5 ${ui}: initial/load/empty/today transitions repaint without a false not-generated state`, t => {
    const h = isolated(t, ui, ['bento', 'shelf'].includes(ui) ? 'catalog' : 'concepts'), model = emptyConcepts();
    const draw = value => layouts[ui].renderConcepts(h.ctx, value);
    const target = () => ui === 'editorial' ? h.ctx.refs.conceptsStatus : h.get(ui === 'bento' ? 'concepts-today' : ui === 'shelf' ? 'concepts-open' : 'concepts-status');
    for (const value of [undefined, model, { ...model, error: '概念读取失败：离线替身' }]) {
      draw(value); assert.match(target().textContent, /今日讲解载入中…/);
      assert.doesNotMatch(target().textContent, /尚未生成/); assert.equal(target().hidden, false);
    }
    for (const today of [null, { day: '2026-10-21', conceptId: null, status: null }]) {
      model.today = today; draw(model);
      assert.match(target().textContent, /今日讲解尚未生成/); assert.doesNotMatch(target().textContent, /载入中/);
    }
    model.today = { conceptId: 'today', status: 'done' }; model.items = [concept]; model.selected = concept; draw(model);
    assert.doesNotMatch(target().textContent, /尚未生成|载入中/);
    assert.ok(h.ctx.root.textContent.includes('认知边界'));
    model.today = undefined; model.items = []; model.selected = null; draw(model);
    assert.match(target().textContent, /今日讲解载入中…/, 'loading/empty cache keys must remain distinct');
    assert.ok(descendants(h.ctx.root).every(node => node.getAttribute('style') === null));
  });
}

test('v029 5.5 concept state remains unknown on first failure and becomes empty only after a successful list', async t => {
  let response = pending();
  const controller = createConcepts({ api: () => response.promise, getRegistry: () => registryFor(member()),
    confirm: async () => true, permissionText, setTimer: () => 1, clearTimer() {} });
  t.after(() => controller.dispose());
  assert.equal(controller.snapshot().today, undefined);
  const first = controller.refresh(); assert.equal(controller.snapshot().today, undefined);
  response.resolve({ error: 'invalid response' }); await first;
  assert.equal(controller.snapshot().today, undefined); assert.match(controller.snapshot().error, /概念列表响应无效/);
  response = pending(); const second = controller.refresh();
  assert.equal(controller.snapshot().today, undefined);
  response.resolve({ items: [], today: null, running: null }); await second;
  assert.equal(controller.snapshot().today, null); assert.equal(controller.snapshot().error, '');
  response = pending(); const third = controller.refresh();
  assert.equal(controller.snapshot().today, null, 'later polling keeps the known result while waiting');
  response.resolve({ items: [], today: null, running: null }); await third;
});

test('v029 5.6 manifest and both lockfile version fields are 0.53.10', async () => {
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
  assert.equal(manifest.version, '0.53.10'); assert.equal(lock.version, '0.53.10'); assert.equal(lock.packages[''].version, '0.53.10');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, { '@electron/packager': '20.3.0', electron: '44.10.2' });
});
