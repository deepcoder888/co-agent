import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as shelf from '../public/layouts/shelf.js';

const category = '睡眠／健康／运动';
const member = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? category : '功能性 Agent',
  book: kind === 'book' ? { title: `**${id} 的书**`, author: '作者' } : null, purpose: kind === 'role' ? '开发协调' : null,
  description: '说明', tags: [], platforms: { codex: { available: true }, claude: { available: true } },
  sources: { checked: true, missing: [], total: 1 }, permissions: {}, sync: { state: '同步' } });
const agents = [member('Walvo'), member('Jadra'), member('Peter', 'role')];
const markdown = '# 睡眠压力 - AI-Era Learning Map\n\n' + Array.from({ length: 11 }, (_, i) => `### ${i + 1}. Section\n\n正文 **重点** 与 *斜体* 和 \`code\`。`).join('\n\n') +
  '\n\n- 观察一\n- 观察二\n\n1. 步骤\n\n> 引用\n\n---\n\n| 名称 | 值 |\n| --- | --- |\n| 测试 | 1 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[出处](https://example.test/source) [坏](javascript:alert(1))';
const record = (id = 'today', extra = {}) => ({ conceptId: id, kind: id === 'today' ? 'daily' : 'manual', day: '2026-10-08',
  createdAt: '2026-10-08T01:00:00Z', startedAt: '2026-10-08T01:00:00Z', finishedAt: '2026-10-08T01:01:00Z', status: 'done',
  agent: { id: 'Walvo', name: 'Walvo', title: '**Notes on Sample**', author: 'Matt Walkerson', bookLabel: 'Notes on Sample' },
  result: { concept: id === 'today' ? '睡眠压力' : '旧概念', conceptEn: 'Sleep Pressure', oneLine: '清醒时间累积睡眠压力。', whyUnknown: '书名不会提示这个机制。', sourceRefs: ['第 2 章'], markdown },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, thinkError: null, perspectives: [], ...extra });
const view = selected => ({ today: { conceptId: 'today', day: '2026-10-08', status: 'done' }, items: [record('old'), record()], selected, running: null, busy: false, error: '' });
const find = (root, label) => descendants(root).find(n => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === label);
const key = (root, value) => root.querySelector(`[data-focus-key="concepts-${value}"]`);
const visible = el => !!el && !el.closest('[hidden]');
function safeDocument(html) {
  const doc = documentFrom(html), create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag);
    Object.defineProperty(el, 'innerHTML', { set() { assert.fail('HTML injection sink'); } });
    Object.defineProperty(el, 'outerHTML', { set() { assert.fail('HTML injection sink'); } });
    return el;
  };
  doc.createTextNode = text => { const el = doc.createElement('text'); el.textContent = text; return el; };
  return doc;
}
function unit(model = view(record())) {
  const doc = safeDocument('<html><body><div id="layout-root"></div></body></html>'), calls = [];
  const actions = new Proxy({}, { get: (_, action) => (...args) => { calls.push({ action, args }); } });
  const ctx = { doc, actions, refs: {}, state: { view: 'concepts', category: 'all', query: '', selectedId: null,
    jointSelectedIds: [], allAgents: agents, detailOpen: false } };
  ctx.root = shelf.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const draw = () => shelf.renderConcepts(ctx, model); draw();
  return { doc, ctx, calls, model, draw, panel: doc.getElementById('concepts-panel') };
}
async function fixture(t, ui = 'shelf') {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="shelf-v08-test">');
  const doc = safeDocument(html); doc.documentElement.setAttribute('data-ui', ui);
  const records = new Map([['today', record()], ['old', record('old')]]), calls = [];
  const registry = { agents, categories: [category], summary: { roles: 1, books: 2, synced: 3, inScope: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  let running = null;
  const app = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ url, body, headers: opts.headers });
    let value;
    if (url === '/api/registry' || url === '/api/refresh') value = registry;
    else if (url === '/api/settings') value = { ui: body?.ui || ui, recommend: { codex: { model: 'fixture', effort: 'xhigh' } } };
    else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/concepts?limit=30') value = { items: [...records.values()].reverse().map(r => ({ ...r, result: r.result && { concept: r.result.concept, oneLine: r.result.oneLine }, perspectives: [] })), running, today: { day: '2026-10-08', conceptId: 'today', status: records.get('today').status } };
    else if (url === '/api/concepts' && body) {
      records.set('new', record('new', { status: 'running', startedAt: new Date().toISOString(), result: null }));
      running = { conceptId: 'new', kind: 'manual', startedAt: records.get('new').startedAt }; value = { conceptId: 'new' };
    } else if (/^\/api\/concepts\/[^/]+\/perspectives$/.test(url)) value = { runId: 'run-new' };
    else if (url.startsWith('/api/concepts/')) value = records.get(url.split('/').at(-1));
    else if (url === '/api/recommend') value = { recommendId: 'rec' };
    else if (url === '/api/recommend/rec') value = { status: 'done', model: 'fixture', results: [{ id: 'Walvo', reason: '应被排除' }, { id: 'Jadra', reason: '补充认知视角' }] };
    else value = { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, calls, records, get: id => doc.getElementById(id), open: () => doc.getElementById('concepts-open').fire('click') };
}

test('v08 shelf bookmark sits between staff and shelves, opens today, and archive uses dated lending cards', async t => {
  const h = await fixture(t), cards = h.get('cards');
  assert.deepEqual(cards.children.slice(0, 3).map(n => n.id), ['shelf-staff-strip', 'shelf-concept-bookmark', 'navigation'] /* v0.17: staff row wrapped with arrows */);
  const bookmark = h.get('shelf-concept-bookmark');
  assert.match(bookmark.className, /shelf-bookmark/); assert.match(bookmark.textContent, /今日一讲.*今日.*睡眠压力/);
  assert.match(bookmark.textContent, /Notes on Sample.*Walvo/); assert.match(bookmark.textContent, /清醒时间/);
  assert.equal(h.get('concepts-open').getAttribute('aria-label'), '随机概念');
  await h.open(); const panel = h.get('concepts-panel');
  assert.ok(visible(panel)); assert.ok(panel.closest('.layout-shelf')); assert.ok(visible(h.get('brand')));
  assert.match(h.get('concepts-title').textContent, /阅读桌/); assert.ok(!visible(h.get('catalog')));
  assert.match(panel.querySelector('.shelf-concept-paper').textContent, /睡眠压力.*Notes on Sample.*Walvo/);
  const archive = panel.querySelector('[aria-label="概念存档"]');
  assert.equal(archive.children[0].getAttribute('data-focus-key'), 'concepts-select-today');
  assert.equal(archive.querySelectorAll('time').length, 2);
  assert.equal(key(archive, 'select-today').getAttribute('aria-current'), 'page');
  await key(archive, 'select-old').fire('click'); assert.equal(h.app.snapshot().concepts.selected.conceptId, 'old');
  await key(panel, 'back').fire('click'); assert.ok(!visible(panel)); assert.equal(h.doc.activeElement, h.get('concepts-open'));
  assert.match(bookmark.textContent, /睡眠压力/); assert.doesNotMatch(bookmark.textContent, /旧概念/);
  await h.open(); assert.equal(h.app.snapshot().concepts.selected.conceptId, 'today');
});

test('v08 shelf paper renders Markdown blocks, sources, verification and 11-section marks without interpreting HTML', () => {
  const h = unit(), paper = h.panel.querySelector('.shelf-concept-paper'); assert.ok(paper);
  assert.match(paper.textContent, /书名不会提示这个机制/); assert.match(paper.textContent, /第 2 章/);
  assert.match(paper.textContent, /Agent 核验：通过/); assert.match(paper.textContent, /11 小节结构：通过/);
  const body = paper.querySelector('.concept-markdown'); assert.ok(body);
  assert.equal(descendants(body).filter(n => n.tagName === 'H3').length, 11);
  for (const tag of ['strong', 'em', 'code', 'ul', 'ol', 'blockquote', 'hr', 'table', 'pre']) assert.ok(body.querySelector(tag), tag);
  assert.match(body.textContent, /Mermaid 图（源码）/); assert.match(body.textContent, /<script>alert/);
  assert.equal(body.querySelectorAll('script,img,iframe,style').length, 0);
  assert.equal(body.querySelectorAll('a').length, 1);
  assert.equal(body.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
});

test('v08 shelf next and generation retry reach only the shared manual-generation action', async t => {
  const h = await fixture(t); await h.open(); await key(h.get('concepts-panel'), 'next').fire('click');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/concepts').map(c => c.body), [{ kind: 'manual' }]);
  assert.equal(h.app.snapshot().concepts.selected.conceptId, 'new');
  assert.match(h.get('concepts-panel').textContent, /运行中.*已用/);
  assert.equal(key(h.get('concepts-panel'), 'next').disabled, true);
  const failed = unit(view(record('today', { status: 'failed', error: '合成生成超时', result: null })));
  assert.match(failed.panel.textContent, /失败原因：合成生成超时/);
  assert.equal(key(failed.panel, 'retry').textContent, '重试'); await key(failed.panel, 'retry').fire('click');
  assert.deepEqual(failed.calls, [{ action: 'nextConcept', args: [] }]);
});

test('v08 shelf opens the shared skinned picker and submits selected perspectives through shared actions', async t => {
  const h = await fixture(t); await h.open(); await key(h.get('concepts-panel'), 'perspectives').fire('click');
  const picker = h.get('perspective-picker'); assert.equal(picker.open, true); assert.match(picker.className, /shelf-builder/);
  assert.equal(h.doc.activeElement, h.get('perspective-search'));
  assert.match(h.get('perspective-recommend').textContent, /补充认知视角/);
  assert.doesNotMatch(picker.textContent, /应被排除|Walvo ·/); assert.match(picker.textContent, /Peter · 开发协调/);
  const check = h.get('perspective-all').querySelector('[data-agent-id="Jadra"]'); check.checked = true; await check.fire('change');
  await h.get('perspective-submit').fire('click'); assert.equal(picker.open, false);
  const posted = h.calls.find(c => c.url === '/api/concepts/today/perspectives');
  assert.deepEqual(posted.body, { agentIds: ['Jadra'] }); assert.equal(posted.headers['X-Co-Agent-Token'], 'shelf-v08-test');
  assert.match(h.get('concepts-panel').textContent, /排队中/);
  assert.ok(!h.calls.some(c => ['/api/joint', '/api/launch'].includes(c.url)));
});

test('v08 shelf terminal continuation prefills the shared builder with the selected concept and previous members', async t => {
  const h = await fixture(t);
  h.records.get('today').perspectives = [{ runId: 'previous', status: 'done', agents: [{ id: 'Jadra', name: 'Jadra' }], results: [], verify: { state: 'ok', parallel: true } }];
  await h.open(); await key(h.get('concepts-panel'), 'continue').fire('click');
  assert.equal(h.get('joint-builder').open, true); assert.match(h.get('joint-builder').className, /shelf-builder/);
  assert.equal(h.get('builder-cli').value, 'codex'); assert.match(h.get('builder-input').value, /睡眠压力/);
  assert.match(h.get('builder-input').value, /Notes on Sample/);
  assert.match(h.get('builder-input').value, /AI-Era Learning Map/); assert.match(h.get('builder-selected').textContent, /Jadra/);
  assert.ok(!h.calls.some(c => c.url === '/api/joint'));
});

test('v08 shelf shows running/unknown elapsed time, locks conflicting actions and preserves completed body during polling', async () => {
  const model = view(record()); model.running = { conceptId: 'other', startedAt: new Date(Date.now() - 65000).toISOString() };
  const h = unit(model), before = h.panel.querySelector('.concept-markdown'); before.scrollTop = 180;
  assert.match(h.panel.textContent, /运行中 · 已用 1 分/); assert.equal(key(h.panel, 'next').disabled, true);
  assert.equal(key(h.panel, 'perspectives').disabled, false, 'perspectives may overlap another concept generation');
  await key(h.panel, 'next').fire('click'); assert.equal(h.calls.length, 0);
  model.running.startedAt = new Date(Date.now() - 125000).toISOString(); h.draw();
  assert.match(h.panel.textContent, /已用 2 分/); assert.equal(h.panel.querySelector('.concept-markdown'), before); assert.equal(before.scrollTop, 180);
  model.running.startedAt = undefined; h.draw(); assert.match(h.panel.textContent, /用时未知/);
  model.busy = true; h.draw(); assert.match(h.panel.textContent, /正在提交/);
  for (const action of ['next', 'perspectives', 'continue']) { assert.equal(key(h.panel, action).disabled, true); await key(h.panel, action).fire('click'); }
  assert.equal(h.calls.length, 0);
});

test('v08 shelf preserves partial results and exposes every failed verification, missing section and THINK failure', () => {
  const model = view(record('today', { verify: { state: 'violation', skillStructure: { state: 'missing', missing: [3, 11], titleLine: false } }, thinkError: '磁盘拒绝写入' }));
  const h = unit(model);
  assert.match(h.panel.textContent, /Agent 核验：违规/); assert.match(h.panel.textContent, /11 小节结构：.*3、11.*缺少标题行/);
  assert.match(h.panel.textContent, /THINK 另存失败：磁盘拒绝写入/); assert.ok(h.panel.querySelector('.concept-markdown'));
  assert.ok(h.panel.querySelectorAll('.concept-warning').length >= 3);
  delete model.selected.verify; h.draw(); assert.match(h.panel.textContent, /Agent 核验：未确认/);
  assert.doesNotMatch(h.panel.textContent, /Agent 核验：通过|11 小节结构：通过/);
  model.selected.result = null; h.draw(); assert.match(h.panel.textContent, /THINK 另存失败/);
});

test('v08 shelf perspective sticky notes retain Markdown, per-run elapsed time, failed evidence and retry members', async () => {
  const run = { runId: 'p1', status: 'failed', error: '分析失败', agents: [{ id: 'Jadra', name: 'Jadra' }, { id: 'Peter', name: 'Peter' }],
    verify: { state: 'violation', parallel: { state: 'not-parallel' }, violations: ['名单外 Agent'] },
    results: [{ agentId: 'Jadra', name: 'Jadra', analysis: '**部分结果**\n\n> 证据' }, { agentId: 'Peter', name: 'Peter', analysis: '另一视角 <script>x</script>' }] };
  const model = view(record('today', { perspectives: [run] })), h = unit(model);
  const notes = h.panel.querySelectorAll('.shelf-perspective-note'); assert.equal(notes.length, 2);
  assert.match(notes[0].textContent, /Jadra.*部分结果/); assert.ok(notes[0].querySelector('strong')); assert.equal(notes[1].querySelector('script'), null);
  assert.match(h.panel.textContent, /失败原因：分析失败/); assert.match(h.panel.textContent, /名单外 Agent/); assert.match(h.panel.textContent, /并行：未通过或未确认/);
  await key(h.panel, 'retry-p1').fire('click'); assert.deepEqual(h.calls, [{ action: 'runPerspectives', args: ['today', ['Jadra', 'Peter']] }]);
  model.selected.perspectives.push({ runId: 'p2', status: 'running', startedAt: new Date(Date.now() - 65000).toISOString(), agents: run.agents, results: [] }); h.draw();
  assert.match(h.panel.textContent, /运行中 · 已用 1 分/); assert.equal(key(h.panel, 'perspectives').disabled, true);
  assert.equal(key(h.panel, 'retry-p1').disabled, true); assert.equal(key(h.panel, 'continue').disabled, false);
  assert.equal(key(h.panel, 'next').disabled, false); await key(h.panel, 'retry-p1').fire('click'); assert.equal(h.calls.length, 1);
});

test('v08 shelf empty/loading/request failure states remain readable and retry uses the shared read action', async () => {
  const model = { today: null, items: [], selected: null, running: null, busy: false, error: '' }, h = unit(model);
  assert.match(h.panel.textContent, /暂无存档/); assert.match(h.panel.textContent, /再来一个/);
  assert.ok(!h.doc.getElementById('shelf-concept-bookmark').querySelector('.shelf-today-badge'));
  model.error = '概念读取失败：离线替身'; h.draw(); assert.match(h.panel.querySelector('[role="alert"]').textContent, /离线替身/);
  await key(h.panel, 'refresh').fire('click'); assert.deepEqual(h.calls, [{ action: 'openConcepts', args: [] }]);
  model.items = [{ conceptId: 'flat', concept: '平面摘要', status: 'done' }]; h.draw();
  assert.match(h.panel.textContent, /平面摘要/); assert.match(h.panel.textContent, /请选择概念或等待详情读取/);
});

test('v08 shelf today metadata without a loaded summary remains honest and opens the recorded id', async () => {
  const h = unit({ ...view(record('old')), items: [record('old')] });
  const bookmark = h.doc.getElementById('shelf-concept-bookmark');
  assert.match(bookmark.textContent, /今日讲解待载入/); assert.match(bookmark.textContent, /已完成/);
  assert.doesNotMatch(bookmark.textContent, /尚未生成|旧概念/);
  await h.doc.getElementById('concepts-open').fire('click');
  assert.deepEqual(h.calls, [{ action: 'openConcepts', args: [] }, { action: 'selectConcept', args: ['today'] }]);
});

test('v08 shelf switching preserves selection, concept runs, other drafts, picker skin and avoids new requests', async t => {
  const h = await fixture(t); h.app.actions.selectCategory(category); h.app.actions.search('Jadra');
  h.app.actions.setRecommendInput('草稿'); h.app.actions.addToJoint('Jadra', undefined, false);
  await h.open(); await key(h.get('concepts-panel'), 'select-old').fire('click');
  await h.app.actions.runPerspectives('old', ['Jadra']);
  const expected = h.app.snapshot(), requests = h.calls.length; h.app.actions.openSettings();
  for (const index of [0, 1, 2, 3]) {
    await h.doc.querySelectorAll('[role="radio"]')[index].fire('click'); const actual = h.app.snapshot();
    assert.deepEqual(actual.concepts, expected.concepts); assert.equal(actual.state.view, 'concepts');
    assert.equal(actual.state.category, category); assert.equal(actual.state.query, 'Jadra');
    assert.equal(actual.recommend.input, '草稿'); assert.deepEqual(actual.state.jointSelectedIds, ['Jadra']);
  }
  assert.ok(visible(h.get('concepts-panel'))); assert.ok(h.get('concepts-panel').closest('.layout-shelf'));
  assert.match(h.get('perspective-picker').className, /shelf-builder/);
  assert.equal(h.calls.slice(requests).filter(c => c.url !== '/api/settings').length, 0);
});

test('v08 shelf rendering does not mutate models or refetch; CSS stays scoped, offline and paper-toned', async () => {
  const h = unit(), before = structuredClone(h.model); h.draw(); assert.deepEqual(h.model, before); assert.deepEqual(h.calls, []);
  const source = await fs.readFile('public/layouts/shelf.js', 'utf8'), css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.doesNotMatch(source, /renderDefaultConcepts|innerHTML|outerHTML|insertAdjacentHTML|\bfetch\s*\(|setInterval\s*\(|setTimeout\s*\(|setAttribute\(\s*['"]style['"]/);
  assert.match(source, /import\s*\{\s*renderMarkdown\s*\}\s*from\s*['"]\.\.\/markdown\.js/);
  assert.doesNotMatch(css, /@import|https?:/);
  for (const [, selectors] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const selector of selectors.split(',')) assert.match(selector, /\[data-ui="shelf"\]/);
  for (const name of ['shelf-bookmark', 'shelf-concept-paper', 'shelf-concept-loan', 'shelf-perspective-note']) assert.ok(css.includes(`.${name}`), name);
  assert.match(css, /\.shelf-concept-paper[^{}]*\{[^}]*background:\s*#f3e9d8/);
  assert.match(css, /\.shelf-concept-paper[^{}]*\{[^}]*border-radius:\s*6px/);
  assert.match(css, /\.shelf-reading-layout\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /\.shelf-builder\.perspective-dialog/);
  assert.match(css, /\.shelf-concept-paper \.concept-markdown a\s*\{[^}]*color:\s*#2f4a6d/);
  assert.match(css, /\.shelf-perspective-run > \.shelf-concept-meta\s*\{[^}]*color:\s*#c9b89c/);
});
