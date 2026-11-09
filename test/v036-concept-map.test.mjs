import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { createConceptMap, normalize, deriveConcepts, buildGraph, selectInput, emptyMap } from '../src/conceptMap/index.mjs';
import { validateMap, mapPrompt, runMapProcess } from '../src/conceptMap/runner.mjs';
import { mountApp } from '../public/app.js';
import { renderDefaultConceptMap } from '../public/layouts/shared.js';
import { createConceptMap as controller, renderMapGraph, mapMatches } from '../public/conceptMap.js';

const at = '2026-10-24T01:00:00.000Z';
const agents = ['one', 'two', 'three', 'four'].map(id => ({ id, name: id.toUpperCase(), kind: 'book', primary: '学习', tags: [], description: '简介',
  book: { title: `《${id}的书》`, author: id }, platforms: { codex: { available: true, name: id.toUpperCase() }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } }));
const identity = id => ({ id, name: id.toUpperCase(), codexName: id.toUpperCase(), title: id + '的书', bookLabel: `《${id}的书》` });
const registry = () => ({ agents: structuredClone(agents), categories: ['学习'], summary: { roles: 0, books: 4 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] });
const concept = (zh = '复利', id = 'one') => ({ version: 1, conceptId: randomUUID(), kind: 'manual', day: '2026-10-24', createdAt: at, status: 'done',
  agent: identity(id), result: { concept: zh, conceptEn: 'Compounding', term: { zh, en: 'Compound interest', fr: 'Intérêt composé' }, oneLine: `${id} 的一句话说明`, markdown: '完整讲解', sourceRefs: ['第三章'] },
  perspectives: [], verify: { state: 'unconfirmed' } });
function records() {
  const concepts = [concept(), concept('复利式积累', 'two'), concept('反馈', 'three')];
  concepts[0].perspectives.push({ runId: randomUUID(), status: 'done', agents: [identity('two')], results: [{ agentId: 'two', name: 'TWO', analysis: '不同视角🙂'.repeat(60) }] });
  const seminars = [{ version: 1, seminarId: randomUUID(), createdAt: at, status: 'done', input: '复利如何影响学习',
    result: { terms: [{ zh: '复利', en: 'Compounding', fr: 'Capitalisation' }], selected: ['three', 'four'].map(id => ({ ...identity(id), agent: id.toUpperCase(), reason: '相关章节' })),
      perAgent: [{ ...identity('three'), agent: 'THREE', coverage: '直接', analysis: '分析' }, { ...identity('four'), agent: 'FOUR', coverage: '无', analysis: '无' }],
      commonAnswer: { summary: '研讨共同摘要'.repeat(60), points: [] }, divergences: [], actions: [] }, verify: { state: 'unconfirmed' } }];
  return { concepts, seminars };
}
const output = () => ({ merges: [{ canonical: '复利', label: '复利', members: ['复利', '复利式积累'] }],
  relations: [{ a: '复利', b: '反馈', type: '因果', explanation: '积累通过反馈调整', basis: ['one'] },
    { a: '复利', b: '不存在', type: '相关', explanation: '无效关系', basis: ['one'] }], splits: [{ key: '复利', reason: '两书含义可能不同，请查看摘录后判断' }] });
const rawRecords = () => { const r = records(); return deriveConcepts(r.concepts, r.seminars); };
const until = async predicate => { const end = Date.now() + 12000; while (!predicate()) { if (Date.now() > end) throw Error('等待超时'); await new Promise(r => setTimeout(r, 15)); } };
function spawner(value, calls = [], { hang = false, code = 0, malformed = false, wait } = {}) {
  return (exe, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 23456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { exe, args, options, prompt: '' }; calls.push(call); child.stdin.on('data', chunk => { call.prompt += chunk; });
    child.stdin.on('finish', async () => {
      try { if (hang) return; if (wait) await wait();
        if (code) child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'fixture quota exhausted' } }) + '\n');
        await fs.writeFile(args[args.indexOf('-o') + 1], malformed ? '{' : JSON.stringify(typeof value === 'function' ? value(call.prompt) : value)); child.emit('close', code, null);
      } catch (e) { child.emit('error', e); }
    }); return child;
  };
}
async function setup(t, options = {}, r = records()) {
  const h = await fixture(t); const engine = createConceptMap(h.config, { getConcepts: async () => structuredClone(r.concepts), getSeminars: async () => structuredClone(r.seminars),
    runner: async () => output(), now: () => new Date(at), ...options });
  t.after(() => engine.close()); await engine.recover(); return { ...h, engine, records: r };
}
async function seed(config, r = records()) {
  for (const c of r.concepts) await put(path.join(config.dataDir, 'concepts', c.conceptId + '.json'), JSON.stringify(c));
  for (const s of r.seminars) await put(path.join(config.dataDir, 'seminars', s.seminarId + '.json'), JSON.stringify(s));
  return r;
}

test('v036 M1 empty data gives empty map and refuses organization', async t => {
  const h = await setup(t, {}, { concepts: [], seminars: [] }); const view = await h.engine.list();
  assert.deepEqual(view.concepts, []); assert.equal(view.newCount, 0); await assert.rejects(h.engine.organize(), { status: 409 });
  const doc = documentFrom('<html><body><div id="layout-root"></div></body></html>');
  renderDefaultConceptMap({ doc, refs: {}, actions: {}, state: { view: 'conceptMap' } }, { ...view, query: '', error: '', busy: false, selected: null });
  assert.equal(doc.getElementById('concept-map-organize').disabled, true); assert.match(doc.getElementById('concept-map-list').textContent, /地图会随每日概念和研讨自动丰富/);
});

test('v036 D79 M2 M3 M4 derives all three sources, excludes unfinished records and falls back to legacy concept', () => {
  const r = records(); const raw = deriveConcepts(r.concepts, r.seminars), c = raw.find(n => n.key === '复利');
  assert.equal(raw.length, 3); assert.deepEqual(c.mentions.map(m => m.sourceType), ['concept', 'perspective', 'seminar']);
  assert.equal(Array.from(c.mentions[1].excerpt).length, 200); assert.equal(Array.from(c.mentions[2].excerpt).length, 200);
  assert.equal(c.mentions[0].excerpt, 'one 的一句话说明'); assert.equal(c.mentions.some(m => m.agentId === 'four'), false);
  for (const status of ['failed', 'running', 'queued']) {
    const v = structuredClone(r); v.concepts.forEach(c => { c.status = status; }); v.seminars[0].status = status; assert.deepEqual(deriveConcepts(v.concepts, v.seminars), []);
    const single = concept(); single.perspectives = [{ status, agents: [identity('two')], results: [{ agentId: 'two', analysis: 'partial' }] }];
    assert.equal(deriveConcepts([single], [])[0].mentions.length, 1);
  }
  const old = concept('旧概念'); delete old.result.term; const one = deriveConcepts([old], []);
  assert.equal(one[0].key, '旧概念'); const graph = buildGraph(one, emptyMap()); assert.equal(graph.concepts[0].bookCount, 1);
  const doc = documentFrom('<html><body></body></html>'); const svg = renderMapGraph(doc, { ...graph.nodes.get('旧概念'), relations: [] }, { selectMapConcept() {}, openDetail() {} });
  assert.equal(svg.querySelectorAll('a').length, 2); assert.equal(svg.querySelectorAll('line').length, 1);
});

test('v036 D80 M5 NFKC whitespace punctuation case merge exact keys and retain distinct book excerpts', () => {
  assert.equal(normalize(' ＡＢＣ， 复－利！'), 'abc复利'); assert.equal(normalize('e\u0301!'), 'é');
  const a = concept('ＡＢＣ，复利', 'one'), b = concept('abc 复利', 'two');
  const raw = deriveConcepts([a, b, concept('近义复利')], []), graph = buildGraph(raw, emptyMap());
  assert.equal(raw.length, 2); const n = graph.nodes.get('abc复利'); assert.equal(n.bookCount, 2); assert.equal(n.mentionCount, 2);
  assert.deepEqual(n.mentions.map(m => m.excerpt), ['one 的一句话说明', 'two 的一句话说明']);
  assert.ok(mapMatches(n, 'INTÉRÊT')); assert.ok(mapMatches(n, 'ＡＢＣ'));
});

test('v036 M6 M11 invalid merges and relations drop individually; envelope fails and reasons cap at 20', () => {
  const raw = rawRecords(), state = emptyMap(), input = selectInput(raw, state), good = output();
  const badMerges = [
    { ...good.merges[0], members: ['复利', 'missing'] }, { ...good.merges[0], members: ['复利', '复利'] },
    { ...good.merges[0], canonical: '反馈' }, { ...good.merges[0], members: ['复利', '反馈'] },
  ];
  const checked = validateMap({ merges: [good.merges[0], ...badMerges], relations: [
    good.relations[0], good.relations[0], good.relations[1], { ...good.relations[0], b: '复利' },
    { ...good.relations[0], b: '复利式积累' }, { ...good.relations[0], type: '相关', basis: ['four'] },
    { ...good.relations[0], explanation: '字'.repeat(201) }, { ...good.relations[0], basis: [] },
  ] }, input, state);
  assert.equal(checked.merges.length, 1); assert.equal(checked.relations.length, 1); assert.equal(checked.droppedCount, 11);
  assert.ok(checked.dropped.some(r => r.includes('basis'))); assert.ok(checked.dropped.some(r => r.includes('自环')));
  assert.equal(validateMap({ merges: [], relations: Array(30).fill(good.relations[1]) }, input, state).dropped.length, 20);
  for (const bad of [null, [], {}, { merges: {}, relations: [] }, { merges: [], relations: [], splits: {} }]) assert.throws(() => validateMap(bad, input, state), /整体结构/);
  state.manual.unmerged.push({ canonical: '复利', member: '复利式积累' }); state.manual.hiddenRelations.push(good.relations[0]);
  const overrides = validateMap(good, input, state); assert.equal(overrides.merges.length, 0); assert.equal(overrides.relations.length, 0);
  assert.equal(overrides.droppedCount, 3);
  assert.equal(validateMap({ merges: [{ ...good.merges[0], canonical: '复利式积累' }], relations: [] }, input, state).merges.length, 0);
  const hidden = emptyMap(); hidden.manual.hiddenConcepts.push('反馈'); assert.equal(validateMap(good, input, hidden).relations.length, 0);
  const reverse = emptyMap(); reverse.manual.hiddenRelations.push({ a: '复利', b: '反馈', type: '对立' });
  assert.equal(validateMap({ merges: [], relations: [{ ...good.relations[0], a: '反馈', b: '复利', type: '对立' }] }, input, reverse).relations.length, 0);
});

test('v036 M7 failed output preserves graph and organization timestamp', async t => {
  let value = output(); const h = await setup(t, { runner: async () => { if (value instanceof Error) throw value; return value; } });
  await h.engine.organize(); await h.engine.idle(); const before = await h.engine.list();
  for (const invalid of [{ merges: 'broken', relations: [] }, Error('fixture exhausted')]) {
    value = invalid; await h.engine.organize(); await h.engine.idle(); const failed = await h.engine.list();
    assert.equal(failed.lastRun.status, 'failed'); assert.match(failed.lastRun.error, /整体结构|fixture exhausted/);
    for (const key of ['concepts', 'merges', 'relations', 'organizedAt']) assert.deepEqual(failed[key], before[key]);
  }
});

test('v036 M7 M8 M18 snapshot excludes concurrent new concepts, serializes organize and accepts live manual edits', async t => {
  let resolve; const h = await setup(t, { runner: () => new Promise(r => { resolve = r; }) });
  await h.engine.organize(); await assert.rejects(h.engine.organize(), { status: 409 });
  h.records.concepts.push(concept('新概念')); await h.engine.manual({ hideRelation: output().relations[0] });
  await h.engine.manual({ unmerge: { canonical: '复利', member: '复利式积累' } }); resolve(output()); await h.engine.idle();
  const after = await h.engine.list(); assert.equal(after.newCount, 1); assert.equal(after.concepts.find(n => n.key === '新概念').organized, false);
  assert.equal(after.merges.length, 0); assert.equal(after.relations.length, 0);
});

test('v036 M7 process timeout, interruption, nonzero and malformed JSON preserve old map; live kill failure holds lock', async t => {
  const h = await fixture(t), r = records(), originalTimeout = h.config.conceptMap.timeoutMs;
  t.after(() => { h.config.conceptMap.timeoutMs = originalTimeout; });
  for (const kind of ['timeout', 'abort', 'code', 'malformed', 'kill']) {
    h.config.conceptMap.timeoutMs = ['timeout', 'kill'].includes(kind) ? 25 : 5000;
    const state = emptyMap(); state.organizedKeys = ['复利']; state.relations = [output().relations[0]];
    await put(path.join(h.config.dataDir, 'concept-map.json'), JSON.stringify(state));
    let alive = kind === 'kill', killed = 0;
    const engine = createConceptMap(h.config, { getConcepts: () => r.concepts, getSeminars: () => r.seminars,
      spawnImpl: spawner(output(), [], { hang: ['timeout', 'abort', 'kill'].includes(kind), code: kind === 'code' ? 1 : 0, malformed: kind === 'malformed' }),
      isAlive: () => alive, killTree: async () => { killed++; if (kind === 'kill') throw Error('fixture kill denied'); } });
    t.after(() => engine.close());
    await engine.recover(); await engine.organize(); if (kind === 'abort') await engine.close(); await engine.idle();
    const view = await engine.list(); assert.equal(view.lastRun.status, 'failed'); assert.deepEqual(view.relations, state.relations);
    assert.match(view.lastRun.error, { timeout: /超时/, abort: /中断/, code: /fixture quota exhausted/, malformed: /JSON 无效/, kill: /fixture kill denied/ }[kind]);
    if (['timeout', 'kill'].includes(kind)) assert.equal(killed, 1);
    if (kind === 'kill') { assert.ok(view.running); await assert.rejects(engine.organize(), { status: 409 }); alive = false; assert.equal((await engine.list()).running, null); }
    await engine.close();
  }
});

test('v036 M7 restart marks interrupted run failed without replacing saved graph', async t => {
  const h = await fixture(t), r = records(), state = emptyMap(); state.relations = [output().relations[0]];
  state.lastRun = { runId: randomUUID(), status: 'running', startedAt: at, finishedAt: null, error: null, pid: null };
  await put(path.join(h.config.dataDir, 'concept-map.json'), JSON.stringify(state));
  const engine = createConceptMap(h.config, { getConcepts: () => r.concepts, getSeminars: () => r.seminars }); await engine.recover();
  assert.equal((await engine.list()).lastRun.error, '应用重启，整理中断'); assert.deepEqual((await engine.list()).relations, state.relations); await engine.close();
});

test('v036 M9 chooses new keys first, related existing context, caps 300 and records truncation', async t => {
  const r = { concepts: Array.from({ length: 350 }, (_, i) => concept(`概念${i}`, i < 200 ? 'one' : 'two')), seminars: [] };
  const raw = deriveConcepts(r.concepts, []), state = emptyMap(); state.organizedKeys = raw.slice(0, 320).map(n => n.key);
  const selected = selectInput(raw, state); assert.equal(selected.concepts.length, 300); assert.equal(selected.newKeys.length, 30);
  assert.equal(selected.truncated, 50); assert.ok(selected.concepts.slice(0, 30).every(n => !state.organizedKeys.includes(n.key)));
  assert.equal(selected.concepts[30].agentIds[0], 'two'); assert.ok(selected.concepts.every(n => Array.from(n.oneLine).length <= 120));
  let input; const h = await setup(t, { runner: async r => { input = r.input; return { merges: [], relations: [] }; } }, r);
  await h.engine.organize(); await h.engine.idle(); const view = await h.engine.list();
  assert.equal(input.concepts.length, 300); assert.equal(view.lastRun.truncated, 50); assert.equal(view.newCount, 50);
});

test('v036 M10 corrupt syntax and invalid nested shape are preserved byte for byte with notice', async t => {
  const h = await fixture(t), file = path.join(h.config.dataDir, 'concept-map.json');
  for (const text of ['{broken', JSON.stringify({ ...emptyMap(), manual: { hiddenConcepts: [] } }), JSON.stringify({ ...emptyMap(), relations: [{}] }),
    JSON.stringify({ ...emptyMap(), lastRun: { runId: 'id', status: 'done', startedAt: at, finishedAt: at, error: null, dropped: 'invalid' } })]) {
    await put(file, text); const engine = createConceptMap(h.config, { getConcepts: () => [], getSeminars: () => [] }); await engine.recover();
    const value = await engine.list(); assert.match(value.notice, /损坏.*已保留/); assert.deepEqual(value.concepts, []); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const names = (await fs.readdir(h.config.dataDir)).filter(n => n.startsWith('concept-map.corrupt-'));
    assert.ok((await Promise.all(names.map(n => fs.readFile(path.join(h.config.dataDir, n), 'utf8')))).includes(text)); await engine.close();
  }
});

test('v036 M11 M12 manual split hide restore survive restart and constrain prompt and next organization', async t => {
  const h = await setup(t); await h.engine.organize(); await h.engine.idle();
  await h.engine.manual({ unmerge: { canonical: '复利', member: '复利式积累' } });
  await h.engine.manual({ hideRelation: output().relations[0] }); await h.engine.manual({ hideConcept: '反馈' });
  let view = await h.engine.list(); assert.equal(view.merges.length, 0); assert.equal(view.relations.length, 0); assert.equal(view.concepts.some(n => n.key === '反馈'), false);
  await assert.rejects(h.engine.get('反馈'), { status: 404 }); assert.equal(view.hiddenConcepts[0].key, '反馈');
  await h.engine.close(); const engine = createConceptMap(h.config, { getConcepts: () => h.records.concepts, getSeminars: () => h.records.seminars, runner: async r => {
    const prompt = mapPrompt(r); assert.ok(prompt.includes('不要再合并 X 与 Y')); assert.ok(prompt.includes('不要再提出这条关系'));
    assert.ok(prompt.includes(JSON.stringify(r.input.manual))); return output();
  } }); t.after(() => engine.close()); await engine.recover(); await engine.organize(); await engine.idle();
  view = await engine.list(); assert.equal(view.merges.length, 0); assert.equal(view.relations.length, 0);
  for (const op of [{ hideConcept: '反馈' }, { hideRelation: output().relations[0] }, { unmerge: { canonical: '复利', member: '复利式积累' } }]) await engine.manual({ restore: op });
  assert.equal((await engine.list()).hiddenConcepts.length, 0);
  for (const op of [null, {}, { nope: 1 }, { restore: {} }, { hideConcept: 'missing' }, { hideConcept: '反馈', unmerge: {} }, { unmerge: { canonical: '复利', member: '复利' } }]) await assert.rejects(engine.manual(op), { status: 400 });
});

test('v036 M13 dangling members endpoints and basis are filtered after records change', async t => {
  const h = await setup(t); await h.engine.organize(); await h.engine.idle();
  h.records.concepts = h.records.concepts.filter(c => c.result.concept !== '复利式积累'); assert.equal((await h.engine.list()).merges.length, 0);
  h.records.concepts = h.records.concepts.filter(c => c.result.concept !== '反馈'); assert.equal((await h.engine.list()).relations.length, 0);
  h.records.concepts = []; h.records.seminars = []; assert.deepEqual((await h.engine.list()).concepts, []);
});

test('v036 M11 M13 incremental organization keeps unaffected members and out-of-input existing relations', () => {
  const raw = rawRecords(); raw.push(...deriveConcepts([concept('积累', 'one')], []));
  const state = emptyMap(); state.merges = [{ canonical: '复利', label: '复利', members: ['复利', '复利式积累', '积累'] }];
  state.relations = [output().relations[0]]; state.manual.unmerged = [{ canonical: '复利', member: '复利式积累' }];
  const input = selectInput(raw, state, 1), checked = validateMap({ merges: [], relations: [] }, input, state);
  assert.deepEqual(checked.merges[0].members, ['复利', '积累']); assert.deepEqual(checked.relations, state.relations);
  const graph = buildGraph(raw.filter(n => n.key !== '复利'), { ...state, manual: emptyMap().manual });
  assert.equal(graph.merges[0].canonical, '复利式积累'); assert.equal(graph.relations.length, 0);
});

test('v036 M14 M15 M19 SVG safely renders long labels, caps neighbors and supports Enter Space arrows', async () => {
  const doc = documentFrom('<html><body></body></html>'), clicked = [], evil = '非常长的标签<script>&🙂更多字符';
  const selected = { key: 'center', label: evil, books: [{ agentId: 'one', bookLabel: '一本书' }], relations: Array.from({ length: 15 }, (_, i) => ({ a: 'center', b: `n${i}`, otherKey: `n${i}`, otherLabel: evil + i, type: ['相关', '对立', '包含', '因果'][i % 4], explanation: '说明', basis: ['one'] })) };
  const graph = renderMapGraph(doc, selected, { selectMapConcept: k => clicked.push(k), openDetail: k => clicked.push(k) }); doc.body.append(graph);
  assert.equal(graph.querySelectorAll('a').length, 13); assert.match(graph.textContent, /另有 4 个/); assert.equal(graph.querySelector('script'), null);
  assert.ok(graph.querySelectorAll('title').some(n => n.textContent === evil)); assert.ok(graph.querySelectorAll('text').some(n => n.textContent === Array.from(evil).slice(0, 8).join('') + '…'));
  assert.equal(graph.querySelector('line[data-relation-type="对立"]').getAttribute('stroke-dasharray'), '8 5');
  const buttons = graph.querySelectorAll('a'); for (const b of buttons) { assert.equal(b.getAttribute('role'), 'button'); assert.equal(b.getAttribute('tabindex'), '0'); }
  await buttons[0].fire('keydown', { key: 'Enter' }); await buttons[1].fire('keydown', { key: ' ' }); assert.deepEqual(clicked, ['n0', 'n1']);
  await buttons[0].fire('keydown', { key: 'ArrowRight' }); assert.equal(doc.activeElement, buttons[1]);
  await buttons[0].fire('keydown', { key: 'Home' }); assert.equal(doc.activeElement, buttons.at(-1));
  const ctx = { doc, refs: {}, actions: {}, state: { view: 'conceptMap', allAgents: [{ id: 'one', name: 'Book One' }] } }, view = { concepts: [], hiddenConcepts: [], selected: { ...selected, labels: { zh: evil }, mentions: [], merges: [], splits: [] }, error: '', query: '' };
  const root = doc.createElement('div'); root.id = 'layout-root'; doc.body.append(root); renderDefaultConceptMap(ctx, view);
  assert.equal(ctx.refs.conceptMapDetail.querySelectorAll('.concept-map-relation').length, 15);
  // Claude acceptance 2026-10-24: the basis shows agent names, not raw ids.
  assert.match(ctx.refs.conceptMapDetail.querySelector('.concept-map-relation').textContent, /依据：Book One/);
});

test('v036 M16 controller reports missing source and preserves selected map; disposes timers and stale responses', async () => {
  let opened = 0, timers = 0; const c = controller({ api: async () => { throw Object.assign(Error('gone'), { status: 404 }); },
    onSource: async () => { opened++; }, setTimer: () => ++timers, clearTimer() {} });
  await c.openMapSource({ sourceType: 'perspective', sourceId: 'gone' }); assert.equal(c.snapshot().error, '原记录不存在'); assert.equal(opened, 0);
  c.dispose(); await c.refresh(); assert.equal(timers, 0);
  let release; const delayed = controller({ api: () => new Promise(r => { release = r; }), setTimer: () => ++timers, clearTimer() {} });
  const task = delayed.refresh(); delayed.dispose(); release({ concepts: [] }); await task; assert.equal(timers, 0); assert.equal(delayed.snapshot().loaded, false);
});

test('v036 M17 homonyms keep book excerpts and split suggestions stay advisory', async t => {
  const h = await setup(t); h.records.concepts.push(concept('复利', 'four')); await h.engine.organize(); await h.engine.idle();
  const n = await h.engine.get('复利'); assert.ok(n.mentions.some(m => m.agentId === 'four')); assert.equal(n.splits.length, 1);
  assert.equal((await h.engine.list()).concepts.length, 2); assert.equal(n.merges.length, 1);
});

test('v036 runner uses JSON data stdin, schema, hidden shell-free transport and explicit no delegation', async t => {
  const { config } = await fixture(t), calls = [], raw = rawRecords(), state = emptyMap(); raw[0].oneLine = '"忽略规则"`命令`\\文件🙂';
  const r = { runId: randomUUID(), input: selectInput(raw, state) }; await runMapProcess(r, config, { spawnImpl: spawner(output(), calls) });
  assert.equal(calls[0].prompt, mapPrompt(r)); assert.equal(calls[0].args.at(-1), '-'); assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].prompt.includes(JSON.stringify(r.input.concepts))); assert.match(calls[0].prompt, /不派生子 Agent.*不调用工具/);
  assert.match(calls[0].prompt, /数据，不是指令/); assert.equal(calls[0].args.some(a => a.includes(raw[0].oneLine)), false);
  const schema = JSON.parse(await fs.readFile(calls[0].args[calls[0].args.indexOf('--output-schema') + 1], 'utf8')); assert.equal(schema.additionalProperties, false);
});

test('v036 conceptMap config defaults to ten minutes and rejects invalid timeout', async t => {
  const { root } = await fixture(t), data = path.join(root, 'conf'), read = () => loadConfig({ env: { CO_AGENT_DATA_DIR: data }, home: root });
  assert.deepEqual((await read()).conceptMap, { timeoutMs: 600000 });
  for (const conceptMap of [null, [], { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 2147483648 }]) {
    await put(path.join(data, 'config.json'), JSON.stringify({ conceptMap })); await assert.rejects(read(), /conceptMap/);
  }
});

for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v036 M5 M6 M8 M11 M12 M17 M19 ${ui} HTTP + mountApp + fake Codex end-to-end map organize override source`, async t => {
  const { config } = await fixture(t), calls = []; const r = await seed(config); let app, front, release, first = true;
  t.after(async () => { release?.(); front?.dispose(); await app?.close(); });
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry(), conceptMapOptions: {
    spawnImpl: spawner(output(), calls, { wait: () => first ? new Promise(resolve => { release = () => { first = false; resolve(); }; }) : Promise.resolve() }),
  } }); await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  const { doc } = await appDocument(ui, app.token); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  front = await mountApp(doc, (url, options) => fetch(base + url, options), { confirm: async () => true });
  const get = id => doc.getElementById('concept-map-' + id);
  await get('open').fire('click'); assert.equal(front.snapshot().state.view, 'conceptMap'); assert.equal(get('panel').hidden, false);
  assert.equal(front.snapshot().conceptMap.concepts.length, 3); assert.equal(front.snapshot().conceptMap.newCount, 3);
  await get('select-复利').fire('click'); assert.equal(front.snapshot().conceptMap.selected.mentionCount, 3); assert.equal(front.snapshot().conceptMap.selected.bookCount, 3);
  assert.equal(doc.querySelectorAll('.concept-map-mention').length, 3); assert.match(get('detail').textContent, /不同视角.*研讨共同摘要/);
  assert.equal(doc.querySelector('.concept-map-graph').querySelectorAll('a').length, 4);
  get('search').value = 'capitalisation'; await get('search').fire('input'); assert.equal(get('list').querySelectorAll('button').length, 1);
  get('search').value = ''; await get('search').fire('input');
  await get('organize').fire('click'); assert.equal(get('organize').disabled, true); await until(() => !!release);
  const post = (url, body, method = 'POST', headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/concept-map/organize', {})).status, 409);
  release(); await app.conceptMap.idle();
  await until(() => front.snapshot().conceptMap.lastRun?.status === 'done'); // Actual controller polling.
  assert.equal(front.snapshot().conceptMap.concepts.length, 2); assert.equal(front.snapshot().conceptMap.relations.length, 1); assert.match(get('status').textContent, /丢弃了 1 条/);
  assert.equal(doc.querySelectorAll('.concept-map-mention').length, 4); assert.match(get('detail').textContent, /拆开建议（仅提示）/);
  assert.equal(doc.querySelector('.concept-map-graph').querySelectorAll('a').length, 5);
  const related = doc.querySelector('.map-neighbor'); await related.fire('keydown', { key: 'Enter' }); assert.equal(front.snapshot().conceptMap.selected.key, '反馈');
  await front.actions.selectMapConcept('复利'); await get('hide-relation-0').fire('click'); assert.equal(front.snapshot().conceptMap.relations.length, 0);
  await get('unmerge-复利式积累').fire('click'); assert.equal(front.snapshot().conceptMap.concepts.length, 3);
  await get('organize').fire('click'); await app.conceptMap.idle(); await front.actions.openConceptMap();
  assert.equal(front.snapshot().conceptMap.relations.length, 0); assert.equal(front.snapshot().conceptMap.merges.length, 0);
  const input = JSON.parse(calls[1].prompt.split('输入 JSON：\n')[1]); assert.deepEqual(input.manual.unmerged, [{ canonical: '复利', member: '复利式积累' }]); assert.equal(input.manual.hiddenRelations.length, 1);
  assert.ok(calls[1].prompt.includes('不要再合并 X 与 Y')); assert.ok(calls[1].prompt.includes('不要再提出这条关系'));
  await front.actions.selectMapConcept('反馈'); await get('hide-concept').fire('click'); assert.equal(front.snapshot().conceptMap.concepts.some(n => n.key === '反馈'), false);
  await get('restore-反馈').fire('click'); assert.ok(front.snapshot().conceptMap.concepts.some(n => n.key === '反馈'));
  await front.actions.selectMapConcept('复利');
  if (ui === 'threepane') for (const next of ['bento', 'editorial', 'shelf', 'threepane']) {
    await get('settings').fire('click'); const radio = doc.querySelectorAll('[role="radio"]').find(n => n.getAttribute('aria-labelledby') === `theme-${next}-name`);
    await radio.fire('keydown', { key: 'Enter' }); doc.getElementById('settings-dialog').close(); assert.equal(get('panel').hidden, false); assert.equal(front.snapshot().conceptMap.selected.key, '复利');
  }
  get('title').focus(); await doc.fire('keydown', { key: '/', ctrlKey: false, preventDefault() {} }); assert.equal(doc.activeElement, get('search'));
  await get('source-0').fire('click'); assert.equal(front.snapshot().state.view, 'concepts'); assert.equal(front.snapshot().concepts.selected.conceptId, r.concepts[0].conceptId);
  await front.actions.openConceptMap('复利'); const seminarIndex = front.snapshot().conceptMap.selected.mentions.findIndex(m => m.sourceType === 'seminar');
  await get(`source-${seminarIndex}`).fire('click'); assert.equal(front.snapshot().state.view, 'chat'); assert.equal(front.snapshot().state.room, 'seminars'); assert.equal(front.snapshot().chat.seminars.selected.seminarId, r.seminars[0].seminarId);
  for (const [route, method] of [['organize', 'POST'], ['manual', 'PUT']]) {
    assert.equal((await post('/api/concept-map/' + route, {}, method, { 'X-Co-Agent-Token': '' })).status, 403);
    assert.equal((await post('/api/concept-map/' + route, {}, method, { Origin: 'https://evil.test' })).status, 403);
  }
  assert.equal((await fetch(base + '/api/concept-map/missing')).status, 404);
  const persisted = JSON.parse(await fs.readFile(path.join(config.dataDir, 'concept-map.json'), 'utf8')); assert.equal(persisted.mentions, undefined); assert.equal(persisted.version, 1);
  assert.ok((await fs.readFile(`public/layouts/${ui}.css`, 'utf8')).includes('.concept-map-page'));
  for (const n of get('panel').querySelectorAll('button,input,a')) assert.equal(n.getAttribute('style'), null);
});

test('v036 M20 real HTTP GET returns all 2000 mentions in one source read without list pagination loss', async t => {
  const { config } = await fixture(t); const r = { concepts: Array.from({ length: 2000 }, (_, i) => concept(`概念${i % 500}`, ['one', 'two', 'three', 'four'][i % 4])), seminars: [] };
  for (const c of r.concepts) c.termBackfill = { status: 'failed', reason: 'refit' }; // Synthetic numeric labels must never trigger CLI backfill.
  await seed(config, r); let app; t.after(() => app?.close()); app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry() }); await app.listen();
  const readAll = app.concepts.allRecords.bind(app.concepts), readSeminars = app.seminars.allRecords.bind(app.seminars);
  let conceptReads = 0, seminarReads = 0;
  app.concepts.allRecords = (...args) => { conceptReads++; return readAll(...args); };
  app.seminars.allRecords = (...args) => { seminarReads++; return readSeminars(...args); };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const start = performance.now(), response = await fetch(base + '/api/concept-map'), result = await response.json(), ms = performance.now() - start;
  assert.equal(response.status, 200); assert.equal(result.concepts.length, 500); assert.equal(result.concepts.reduce((n, c) => n + c.mentionCount, 0), 2000);
  assert.equal(conceptReads, 1); assert.equal(seminarReads, 1);
  t.diagnostic(`2000 mentions GET: ${ms.toFixed(1)} ms (diagnostic only; one read per source)`);
});
