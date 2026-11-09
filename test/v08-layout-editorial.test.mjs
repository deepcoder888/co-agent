import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as editorial from '../public/layouts/editorial.js';

function safeDocument(doc) {
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag);
    for (const name of ['innerHTML', 'outerHTML']) Object.defineProperty(el, name, { set() { assert.fail(`${name} is forbidden`); } });
    return el;
  };
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; };
  return doc;
}
const member = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent',
  book: kind === 'book' ? { title: '**学习之书**', author: '作者' } : null, purpose: kind === 'role' ? '项目协调' : null,
  description: '核对来源', tags: [], permissions: {}, sources: { checked: true, missing: [] }, sync: { state: '同步' },
  platforms: { claude: { available: true }, codex: { available: true } } });
const registry = { agents: [member('Walvo'), member('Jadra'), member('Peter', 'role')], categories: ['学习'],
  summary: { roles: 1, books: 2, synced: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const markdown = '# 认知边界 - AI-Era Learning Map\n\n' + Array.from({ length: 11 }, (_, i) =>
  `### ${i + 1}. ${i ? 'Section' : 'Essence'}\n\n理解 **边界**，从一个具体问题开始。`).join('\n\n') +
  '\n\n- 观察\n- 反思\n\n> 原书引文\n\n| 领域 | 方法 |\n| --- | --- |\n| 学习 | `记录` |\n\n```mermaid\ngraph TD; A-->B\n```\n\n<script>不得执行</script> [坏](javascript:alert(1))';
const record = (id = 'today', extra = {}) => ({ conceptId: id, kind: 'daily', day: '2026-10-08', createdAt: '2026-10-08T01:00:00Z',
  startedAt: '2026-10-08T01:00:00Z', status: 'done', agent: { id: 'Walvo', name: 'Walvo', title: '**学习之书**' },
  result: { concept: id === 'today' ? '认知边界' : '昨日的概念', conceptEn: 'Boundary', oneLine: '一句话说明。', whyUnknown: '容易被忽略的前提。', sourceRefs: ['第 2 章'], markdown },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, thinkFile: null, thinkError: null, perspectives: [], ...extra });
const run = (extra = {}) => ({ runId: 'p1', status: 'done', createdAt: '2026-10-08T02:00:00Z',
  agents: [{ id: 'Jadra', name: 'Jadra', bookLabel: '《学习之书》' }, { id: 'Peter', name: 'Peter', purpose: '项目协调' }],
  results: [{ agentId: 'Jadra', name: 'Jadra', analysis: '**第一封来稿**\n\n书中依据。' }, { agentId: 'Peter', name: 'Peter', analysis: '## 第二封来稿\n\n具体实践。' }],
  verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, ...extra });
const view = selected => ({ today: { day: '2026-10-08', conceptId: 'today', status: 'done' }, items: [record('old'), record()], selected,
  running: null, busy: false, error: '' });
const byKey = (root, key) => root.querySelector(`[data-focus-key="concepts-${key}"]`);
const visible = el => !!el && !el.closest('[hidden]');

function isolated(t, model = view(record())) {
  const doc = safeDocument(documentFrom('<body></body>')), calls = [];
  const actions = Object.fromEntries(['openConcepts', 'selectConcept', 'nextConcept', 'openPerspectivePicker', 'runPerspectives', 'continueInJoint', 'showView'].map(name =>
    [name, (...args) => calls.push({ name, args })]));
  const ctx = { doc, refs: {}, actions, state: { view: 'concepts', allAgents: [] } };
  ctx.root = editorial.render(ctx); doc.body.append(ctx.root); editorial.renderConcepts(ctx, model);
  t.after(() => ctx.refs.dispose());
  return { doc, ctx, model, calls, panel: doc.getElementById('concepts-panel'), update: value => editorial.renderConcepts(ctx, value) };
}
async function fixture(t) {
  const { doc, ids } = await appDocument('editorial'); safeDocument(doc);
  const records = new Map([['today', record()], ['old', record('old')]]), requests = [];
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body, opts });
    let value;
    if (url === '/api/registry' || url === '/api/refresh') value = registry;
    else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/settings') value = { ui: body?.ui || 'editorial', recommend: { codex: { model: 'fixture', effort: 'high' } } };
    else if (url === '/api/concepts?limit=30') value = { items: [records.get('old'), records.get('today')], today: view().today, running: null };
    else if (url === '/api/concepts' && body) { records.set('new', record('new', { status: 'running', result: null })); value = { conceptId: 'new' }; }
    else if (url.endsWith('/perspectives') && body) value = { runId: 'new-perspective' };
    else if (url.startsWith('/api/concepts/')) value = records.get(url.split('/').at(-1));
    else if (url === '/api/recommend') value = { recommendId: 'r' };
    else if (url === '/api/recommend/r') value = { status: 'done', results: [{ id: 'Jadra', reason: '补充书中视角' }], model: 'fixture' };
    else value = { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose()); return { app, doc, ids, requests, records };
}

test('v08 editorial: seventh masthead entry opens an owned magazine column without losing the masthead', async t => {
  const { doc, ids, app } = await fixture(t);
  assert.deepEqual(doc.querySelector('.editorial-columns').children.filter(n => !n.hidden).map(n => n.textContent), ['目录', '人物', '藏书', '调用组', '推荐', '概念', '圆桌', '会诊室', '顾问团', '概念地图', '对话', '统计', '往期', '设置']);
  assert.ok(ids['concepts-open'].closest('.editorial-masthead'));
  ids['concepts-open'].focus(); await ids['concepts-open'].fire('click');
  assert.equal(app.snapshot().state.view, 'concepts'); assert.ok(visible(ids['concepts-panel']));
  assert.ok(ids['concepts-panel'].closest('.layout-editorial')); assert.ok(visible(doc.querySelector('.editorial-masthead')));
  assert.equal(visible(doc.querySelector('.editorial-spread')), false);
  assert.equal(doc.querySelector('.concepts-default'), null); assert.match(ids['concepts-panel'].textContent, /今日一讲/);
  const back = byKey(ids['concepts-panel'], 'back'); back.focus(); await back.fire('click');
  assert.equal(ids['concepts-panel'].hidden, true); assert.equal(doc.activeElement.id, 'concepts-open');
  assert.ok(visible(doc.querySelector('.editorial-spread')));
});

test('v08 editorial: today is pinned with its own badge, archive rows retain dates, titles and selection', async t => {
  const { doc, ids, app } = await fixture(t); await app.actions.openConcepts();
  const archive = doc.querySelector('.editorial-concept-archive'), rows = archive.querySelectorAll('.editorial-concept-index-row');
  assert.equal(rows.length, 2); assert.equal(byKey(archive, 'select-today').getAttribute('aria-current'), 'page');
  assert.match(rows[0].textContent, /今日/); assert.equal(rows[0].querySelector('.concept-today').textContent, '今日');
  assert.match(rows[0].querySelector('time').textContent, /2026-10-08/);
  assert.equal(byKey(rows[0], 'select-today').textContent, '认知边界');
  await byKey(archive, 'select-old').fire('click'); assert.equal(app.snapshot().concepts.selected.conceptId, 'old');
  assert.ok(byKey(doc.querySelector('.editorial-concept-archive'), 'select-old').getAttribute('aria-current'));
  assert.equal(doc.querySelector('.editorial-concept-reading').querySelector('.concept-today'), null);
  assert.match(ids['concepts-panel'].textContent, /今日/);
});

test('v08 editorial: renders all eleven Markdown sections and a drop cap, with provenance and warnings before intact body', t => {
  const data = record('today', { verify: { state: 'violation', skillStructure: { state: 'missing', missing: [3, 11], titleLine: false } }, thinkError: '目标目录不可写' });
  const { panel } = isolated(t, view(data)), article = panel.querySelector('.editorial-concept-reading');
  assert.match(article.textContent, /《学习之书》 · Walvo/); assert.match(article.textContent, /一句话说明。/);
  assert.match(article.textContent, /容易被忽略的前提。/); assert.match(article.textContent, /第 2 章/);
  assert.match(article.textContent, /Agent 核验：违规/); assert.match(article.textContent, /11 节结构：.*3、11.*标题行/);
  assert.match(article.textContent, /THINK 另存失败：目标目录不可写/);
  const body = article.querySelector('.editorial-concept-body');
  assert.ok(article.children.indexOf(article.querySelector('.editorial-concept-checks')) < article.children.indexOf(body));
  assert.equal(descendants(body).filter(n => n.tagName === 'H3').length, 11);
  assert.match(body.querySelector('.editorial-dropcap').textContent, /理解 边界/);
  for (const tag of ['strong', 'ul', 'blockquote', 'table', 'pre']) assert.ok(body.querySelector(tag), tag);
  assert.match(body.textContent, /Mermaid 图（源码）/); assert.match(body.textContent, /<script>不得执行<\/script>/);
  assert.equal(body.querySelectorAll('script, img, iframe').length, 0);
  assert.equal(body.querySelectorAll('[style]').length, 0); assert.equal(body.querySelectorAll('a').length, 0);
});

test('v08 editorial: completion never implies verification; missing and success marks remain explicit', t => {
  const { panel, update } = isolated(t, view(record('today', { verify: null })));
  assert.match(panel.textContent, /Agent 核验：未确认/); assert.match(panel.textContent, /11 节结构：未确认/);
  update(view(record())); assert.match(panel.textContent, /Agent 核验：通过/); assert.match(panel.textContent, /11 节结构：通过/);
});

test('v08 editorial: global and selected generation states show elapsed/unknown time and guard duplicate actions', async t => {
  const selected = record('today', { status: 'running', result: null, startedAt: new Date(Date.now() - 65000).toISOString() });
  const h = isolated(t, { ...view(selected), running: { conceptId: 'today', startedAt: selected.startedAt } });
  assert.match(h.panel.textContent, /运行中.*已用 1 分/);
  assert.equal(byKey(h.panel, 'next').disabled, true); await byKey(h.panel, 'next').fire('click'); assert.equal(h.calls.length, 0);
  h.update({ ...view({ ...selected, startedAt: null, createdAt: null }), busy: true });
  assert.match(h.panel.textContent, /用时未知/); assert.match(h.panel.textContent, /正在提交/);
  assert.equal(byKey(h.panel, 'next').disabled, true);
});

test('v08 editorial: failed concept keeps reason, partial text and THINK notice, and retries via nextConcept', async t => {
  const data = record('today', { status: 'failed', error: '<script>生成中断</script>', thinkError: '磁盘已满' });
  const h = isolated(t, view(data)); assert.match(h.panel.textContent, /失败原因：<script>生成中断<\/script>/);
  assert.match(h.panel.textContent, /THINK 另存失败：磁盘已满/); assert.ok(h.panel.querySelector('.concept-markdown'));
  assert.equal(byKey(h.panel, 'perspectives').disabled, true);
  await byKey(h.panel, 'retry').fire('click'); assert.deepEqual(h.calls, [{ name: 'nextConcept', args: [] }]);
  h.update({ ...view(data), running: { conceptId: 'other', startedAt: data.startedAt } });
  assert.equal(byKey(h.panel, 'retry').disabled, true);
});

test('v08 editorial: request error, empty archive and selection loading retain refresh/generation actions', async t => {
  const h = isolated(t, { ...view(null), items: [], today: null, error: '概念读取失败：离线替身' });
  assert.match(h.panel.textContent, /暂无存档/); assert.match(h.panel.textContent, /请选择概念|等待详情/);
  assert.match(h.panel.querySelector('[role="alert"]').textContent, /离线替身/);
  await byKey(h.panel, 'refresh').fire('click'); await byKey(h.panel, 'next').fire('click');
  assert.deepEqual(h.calls.map(c => c.name), ['openConcepts', 'nextConcept']);
  h.update({ ...view(null), items: [] });
  assert.ok(byKey(h.panel, 'select-today'), 'today stays reachable even if outside the returned archive page');
});

test('v08 editorial: perspectives are two-column letters, showing members, Markdown, run errors and verification', async t => {
  const failed = run({ status: 'failed', error: '分析中断', verify: { state: 'violation', parallel: { state: 'not-parallel' }, violations: ['额外角色'] } });
  const h = isolated(t, view(record('today', { perspectives: [failed] })));
  const letters = h.panel.querySelector('.editorial-concept-letters'); assert.match(letters.textContent, /来稿/);
  assert.equal(letters.querySelectorAll('.editorial-letter').length, 2); assert.match(letters.textContent, /Jadra.*学习之书/);
  assert.match(letters.textContent, /Peter.*项目协调/); assert.match(letters.textContent, /分析中断/);
  assert.match(letters.textContent, /多视角核验：违规.*并行：未通过.*额外角色/);
  assert.equal(letters.querySelector('strong').textContent, '第一封来稿');
  await byKey(letters, 'retry-p1').fire('click');
  assert.deepEqual(h.calls, [{ name: 'runPerspectives', args: ['today', ['Jadra', 'Peter']] }]);
  h.update(view(record('today', { perspectives: [failed, run({ runId: 'p2', status: 'running', startedAt: new Date(Date.now() - 125000).toISOString(), results: [], verify: null })] })));
  assert.match(h.panel.textContent, /运行中.*已用 2 分/); assert.equal(byKey(h.panel, 'retry-p1').disabled, true);
  assert.equal(byKey(h.panel, 'perspectives').disabled, true); assert.equal(byKey(h.panel, 'continue').disabled, false);
});

test('v08 editorial: picker uses magazine skin, excludes source and invokes shared background analysis with authenticated IDs', async t => {
  const { doc, ids, app, requests } = await fixture(t); await app.actions.openConcepts();
  byKey(ids['concepts-panel'], 'perspectives').focus(); await byKey(ids['concepts-panel'], 'perspectives').fire('click');
  assert.equal(ids['perspective-picker'].open, true); assert.match(ids['perspective-picker'].className, /editorial-builder/);
  assert.equal(doc.activeElement.id, 'perspective-search'); assert.match(ids['perspective-recommend'].textContent, /补充书中视角/);
  assert.equal(ids['perspective-all'].querySelector('[data-agent-id="Walvo"]'), null);
  const check = ids['perspective-all'].querySelector('[data-agent-id="Jadra"]'); check.checked = true; await check.fire('change');
  await ids['perspective-submit'].fire('click');
  const sent = requests.find(r => r.url === '/api/concepts/today/perspectives'); assert.deepEqual(sent.body, { agentIds: ['Jadra'] });
  assert.equal(sent.opts.headers['X-Co-Agent-Token'], 'synthetic-token'); assert.equal(ids['perspective-picker'].open, false);
  assert.match(ids['concepts-panel'].textContent, /排队中/);
});

test('v08 editorial: terminal action prefills shared builder and never launches a CLI', async t => {
  const { ids, app, records, requests } = await fixture(t); records.get('today').perspectives = [run()]; await app.actions.openConcepts();
  await byKey(ids['concepts-panel'], 'continue').fire('click');
  assert.equal(ids['joint-builder'].open, true); assert.match(ids['joint-builder'].className, /editorial-builder/);
  assert.equal(ids['builder-cli'].value, 'codex'); assert.match(ids['builder-input'].value, /认知边界.*Boundary/);
  assert.deepEqual(app.snapshot().state.jointSelectedIds, ['Jadra', 'Peter']);
  assert.equal(requests.filter(r => ['/api/joint', '/api/launch'].includes(r.url)).length, 0);
});

test('v08 editorial: 再来一个 creates and selects a manual concept through shared actions', async t => {
  const { ids, app, requests } = await fixture(t); await app.actions.openConcepts(); await byKey(ids['concepts-panel'], 'next').fire('click');
  assert.deepEqual(requests.find(r => r.url === '/api/concepts').body, { kind: 'manual' });
  assert.equal(app.snapshot().concepts.selected.conceptId, 'new'); assert.match(ids['concepts-panel'].textContent, /运行中/);
});

test('v08 editorial: unchanged reading DOM and focus survive busy/error/elapsed updates without model mutation', t => {
  const model = { ...view(record()), running: { conceptId: 'another', startedAt: new Date(Date.now() - 65000).toISOString() } }, saved = structuredClone(model);
  const h = isolated(t, model), body = h.panel.querySelector('.editorial-concept-body'), button = byKey(h.panel, 'continue');
  assert.ok(body, 'the reading node must exist before testing preservation');
  button.focus(); h.panel.scrollTop = 230;
  h.update({ ...structuredClone(model), busy: true, error: '请求失败', running: { ...model.running, startedAt: new Date(Date.now() - 125000).toISOString() } });
  assert.ok(h.panel.querySelector('.editorial-concept-body') === body); assert.ok(h.doc.activeElement === button);
  assert.equal(h.panel.scrollTop, 230); assert.match(h.panel.textContent, /已用 2 分/); assert.deepEqual(model, saved);
});

test('v08 editorial: layout switching retains concept selection, drafts, filters and joint members without concept refetch', async t => {
  const { app, doc, ids, requests } = await fixture(t);
  app.actions.selectCategory('学习'); app.actions.search('Jadra'); app.actions.setRecommendInput('未提交草稿'); app.actions.addToJoint('Peter', undefined, false);
  await app.actions.openConcepts(); await byKey(ids['concepts-panel'], 'select-old').fire('click');
  const reads = requests.filter(r => r.url.startsWith('/api/concepts')).length; app.actions.openSettings();
  for (const index of [0, 2, 1, 2, 3, 2]) {
    await doc.querySelectorAll('[role="radio"]')[index].fire('click'); const state = app.snapshot();
    assert.equal(state.state.view, 'concepts'); assert.equal(state.concepts.selected.conceptId, 'old');
    assert.equal(state.state.category, '学习'); assert.equal(state.state.query, 'Jadra'); assert.equal(state.recommend.input, '未提交草稿');
    assert.deepEqual(state.state.jointSelectedIds, ['Peter']);
    assert.equal(doc.querySelectorAll('[id="concepts-panel"]').length, 1); assert.equal(doc.querySelectorAll('[id="concepts-open"]').length, 1);
  }
  assert.equal(requests.filter(r => r.url.startsWith('/api/concepts')).length, reads);
  assert.match(ids['perspective-picker'].className, /editorial-builder/);
});

test('v08 editorial: CSS keeps paper/serif/square language, drop cap, two-column letters and responsive reading', async () => {
  const css = await fs.readFile('public/layouts/editorial.css', 'utf8'), source = await fs.readFile('public/layouts/editorial.js', 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|renderDefaultConcepts|setAttribute\(\s*['"]style['"]|\.cssText\s*=/);
  assert.match(source, /import\s*\{\s*renderMarkdown\s*\}\s*from ['"]\.\.\/markdown\.js/);
  assert.match(css, /\.editorial-dropcap::first-letter\s*\{[^}]*float:\s*left/);
  assert.match(css, /\.editorial-concept-body\s*\{[^}]*font:\s*17px\/1\.8 var\(--font-title\)/);
  assert.match(css, /\.editorial-letters-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.editorial-letters-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /#perspective-submit/); assert.match(css, /#perspective-continue/);
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    if (block[1].trim().startsWith('@')) continue;
    for (const selector of block[1].split(',')) assert.match(selector, /\[data-ui="editorial"\]/);
  }
});
