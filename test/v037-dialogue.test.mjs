import './fixtures/time-zone.mjs';
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
import { createApp } from '../src/server.mjs';
import { createConcepts, responseTarget, localTime } from '../src/concepts/index.mjs';
import { conceptSchema, conceptPrompt, validateConcept } from '../src/concepts/runner.mjs';
import { thinkMarkdown } from '../src/concepts/think.mjs';
import { deriveConcepts } from '../src/conceptMap/index.mjs';
import { mountApp } from '../public/app.js';
import { createConcepts as controller } from '../public/concepts.js';
import { renderDefaultConcepts } from '../public/layouts/shared.js';

const at = '2026-10-24T01:00:00.000Z';
const agents = ['one', 'two', 'three', 'four'].map(id => ({ id, name: id.toUpperCase(), kind: 'book', primary: '学习', tags: [], description: '简介',
  book: { title: `《${id}的书》`, author: id }, platforms: { codex: { available: true, name: id.toUpperCase() }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } }));
const registry = () => ({ agents: structuredClone(agents), categories: ['学习'], summary: { roles: 0, books: 4 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] });
const identity = id => ({ id, name: id.toUpperCase(), codexName: id.toUpperCase(), title: id + '的书', bookLabel: `《${id}的书》` });
const validResponse = () => ({ stance: '补充', text: '《自己的书》第三章指出，判断一个概念必须先确认适用条件。'.repeat(3) });
const output = (concept = '新概念', response = { stance: '无', text: '' }) => ({ concept, conceptEn: `Concept ${concept}`, oneLine: '一句话概括', whyUnknown: '书名没有提示',
  sourceRefs: ['第三章'], markdown: `# ${concept} - AI-Era Learning Map\n` + Array.from({ length: 11 }, (_, i) => `### ${i + 1}. 小节\n正文${i + 1}\n`).join(''),
  term: { zh: concept, en: 'Concept', fr: 'Concept' }, response });
function record(day = '2026-10-23', overrides = {}) {
  const result = output('前日概念'); delete result.response; // Pre-v0.37 archive.
  return { version: 1, conceptId: randomUUID(), kind: 'daily', day, createdAt: `${day}T01:00:00Z`, status: 'done', attempt: 1, sequence: 1,
    agent: identity('one'), excludedConcepts: [], perspectives: [], verify: { state: 'unconfirmed' }, result, ...overrides };
}
const seed = async (config, records) => { for (const r of records) await put(path.join(config.dataDir, 'concepts', r.conceptId + '.json'), JSON.stringify(r)); };
async function setup(t, records = [], options = {}) {
  // After hooks run in registration order: close engines and apps before the fixture folder is removed.
  let engine; t.after(() => engine?.close());
  const h = await fixture(t); await seed(h.config, records);
  engine = createConcepts(h.config, registry, { now: () => new Date(at), randomIntImpl: () => 0, runner: async r => output('新概念', r.respondsTo ? validResponse() : { stance: '无', text: '' }),
    conceptVerifier: async () => ({ state: 'unconfirmed' }), ...options });
  await engine.recover(); return { ...h, engine };
}
function spawner(values, calls) {
  return (exe, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 23456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { exe, args, options, prompt: '' }; calls.push(call);
    child.stdin.on('data', chunk => { call.prompt += chunk; });
    child.stdin.on('finish', async () => {
      try { await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(values.shift())); child.emit('close', 0, null); }
      catch (error) { child.emit('error', error); }
    }); return child;
  };
}

test('v037 X1 first day, all failed and over seven days have no response target', () => {
  for (const records of [[], [record('2026-10-23', { status: 'failed' })], [record('2026-10-16')]])
    assert.equal(responseTarget(records, 'daily', '2026-10-24', 'two'), null);
  assert.equal(responseTarget([record('2026-10-17')], 'daily', '2026-10-24', 'two').day, '2026-10-17');
  const checked = validateConcept(output()); assert.equal(checked.response, null); assert.equal(checked.responseError, null);
});

test('v037 X2 X4 X5 select latest completed daily before today, skip manual and same book', () => {
  const a = record('2026-10-22'), failed = record('2026-10-23', { status: 'failed' });
  const records = [record('2026-10-25'), record('2026-10-23', { kind: 'manual' }), failed, a, record('2026-10-21')];
  const target = responseTarget(records, 'daily', '2026-10-24', 'two');
  assert.equal(target.conceptId, a.conceptId); assert.equal(target.oneLine, a.result.oneLine); assert.deepEqual(target.term, a.result.term);
  target.agent.name = 'changed'; assert.equal(a.agent.name, 'ONE');
  assert.equal(responseTarget(records, 'manual', '2026-10-24', 'two'), null);
  assert.equal(responseTarget(records, 'daily', '2026-10-24', 'one'), null);
});

test('v037 X14 selection compares UTC+8 day fields even when UTC dates disagree', () => {
  const day = localTime(new Date('2026-10-23T16:05:00Z')).day;
  assert.equal(day, '2026-10-24');
  const a = record('2026-10-23', { createdAt: '2026-10-22T16:10:00Z' });
  const older = record('2026-10-22', { createdAt: '2026-10-23T02:00:00Z' });
  assert.equal(responseTarget([older, a], 'daily', day, 'two').conceptId, a.conceptId);
  assert.equal(responseTarget([record('2026-10-16', { createdAt: at })], 'daily', day, 'two'), null);
});

test('v037 X3 retries reuse the first persisted snapshot including null after restart', async t => {
  const a = record(); let attempt = 0, second; t.after(() => second?.close());
  const h = await setup(t, [a], { dailyRetryDelayMs: 0, runner: async () => { if (++attempt === 1) throw Error('fixture first failure'); return output('新概念', validResponse()); } });
  const first = await h.engine.ensureDaily(); assert.equal(first.status, 'failed'); assert.equal(first.respondsTo.conceptId, a.conceptId);
  await h.engine.close();
  // A later imported record must not change the same day's target.
  const newer = record('2026-10-23', { sequence: 20, agent: identity('three') }); await seed(h.config, [newer]);
  second = createConcepts(h.config, registry, { now: () => new Date(at), randomIntImpl: () => 0, dailyRetryDelayMs: 0,
    runner: async () => output('再试概念', validResponse()), conceptVerifier: async () => ({ state: 'unconfirmed' }) });
  await second.recover(); const retried = await second.ensureDaily();
  assert.equal(retried.status, 'done'); assert.equal(retried.attempt, 2); assert.deepEqual(retried.respondsTo, first.respondsTo);
  for (const respondsTo of [null, undefined]) assert.equal(responseTarget([a, record('2026-10-24', { status: 'failed', respondsTo })], 'daily', '2026-10-24', 'two'), null);
  const disk = JSON.parse(await fs.readFile(path.join(h.config.dataDir, 'concepts', retried.conceptId + '.json'), 'utf8'));
  assert.deepEqual(disk.respondsTo, first.respondsTo);
});

test('v037 X4 X5 engine manual runs and same-book daily runs persist null targets', async t => {
  let single; t.after(() => single?.close());
  const a = record(), h = await setup(t, [a]); const manual = await h.engine.startManual({ kind: 'manual' }); await h.engine.idle();
  const saved = await h.engine.get(manual.conceptId); assert.equal(saved.respondsTo, null); assert.equal(saved.result.response, null); assert.equal(saved.responseError, null);
  assert.equal((await h.engine.thread()).items.some(r => r.conceptId === manual.conceptId), false);
  const one = await setup(t, [a]); await one.engine.close();
  single = createConcepts(one.config, () => ({ agents: [agents[0]] }), { now: () => new Date(at), runner: async () => output(), conceptVerifier: async () => ({ state: 'unconfirmed' }) });
  await single.recover(); assert.equal((await single.ensureDaily()).respondsTo, null);
});

test('v037 D85 prompt starts child task with snapshot and schema requires response in both modes', () => {
  const r = record('2026-10-24', { respondsTo: responseTarget([record()], 'daily', '2026-10-24', 'two') });
  const prompt = conceptPrompt(r), task = prompt.split('2. 交给它的任务原文如下：\n')[1];
  assert.ok(task.startsWith('「上一篇每日概念（2026-10-23）是《one的书》的作者讲的「前日概念」：一句话概括。'));
  assert.ok(task.indexOf('60–400 字回应') < task.indexOf('请从你绑定的书')); assert.match(prompt, /必须引用自己绑定书中的出处/);
  const empty = conceptPrompt({ ...r, respondsTo: null }); assert.doesNotMatch(empty, /上一篇每日概念/); assert.match(empty, /stance 必须填「无」，text 必须为空字符串/);
  assert.ok(conceptSchema.required.includes('response')); assert.equal(conceptSchema.properties.response.type, 'object');
  assert.deepEqual(conceptSchema.properties.response.required, ['stance', 'text']); assert.deepEqual(conceptSchema.properties.response.properties.stance.enum, ['赞同', '反驳', '补充', '无']);
});

test('v037 X6 X7 D86 response errors discard only response and remain idempotent', () => {
  const r = { respondsTo: responseTarget([record()], 'daily', '2026-10-24', 'two') };
  const invalid = [undefined, null, {}, { stance: '无', text: '' }, { stance: '别的', text: '第'.repeat(60) }, { stance: '补充', text: 42 },
    { stance: '补充', text: '第'.repeat(59) }, { stance: '反驳', text: '第'.repeat(401) }, { stance: '赞同', text: '没有出处'.repeat(30) }];
  for (const response of invalid) {
    const value = output('新概念', response), checked = validateConcept(value, r);
    assert.equal(checked.response, null); assert.ok(checked.responseError); assert.equal(checked.markdown, value.markdown);
    assert.deepEqual(checked.term, value.term); assert.deepEqual(validateConcept(checked, r), checked);
  }
  for (const stance of ['赞同', '反驳', '补充']) for (const n of [60, 400]) {
    const response = { stance, text: '第' + '🙂'.repeat(n - 1) }, checked = validateConcept(output('新概念', response), r);
    assert.deepEqual(checked.response, response); assert.equal(checked.responseError, null); assert.deepEqual(validateConcept(checked, r), checked);
  }
  for (const marker of ['《', '第', '章', 'S0']) assert.equal(validateConcept(output('新概念', { stance: '补充', text: marker + '字'.repeat(60) }), r).responseError, null);
  for (const response of [validResponse(), { stance: '无', text: '多余文字' }, { stance: '补充', text: '' }]) {
    const checked = validateConcept(output('新概念', response)); assert.equal(checked.response, null); assert.match(checked.responseError, /没有回应对象/);
  }
  for (const value of [null, [], output('新概念', validResponse())]) {
    if (value && !Array.isArray(value)) value.markdown = '';
    assert.throws(() => validateConcept(value, r), /概念 JSON 格式无效/);
  }
});

test('v037 D88 X10 THINK appends response after unchanged eleven sections and write failure stays done', async t => {
  const a = record(), h = await setup(t, [a]); const done = await h.engine.ensureDaily();
  const bytes = await fs.readFile(done.thinkFile, 'utf8'); assert.ok(done.thinkFile.startsWith(h.root));
  assert.ok(bytes.startsWith(done.result.markdown)); assert.equal((bytes.match(/^### /gm) || []).length, 11);
  assert.equal(bytes, done.result.markdown + `\n\n## 回应前一篇概念：前日概念（《one的书》）\n立场：补充\n${validResponse().text}\n`);
  assert.equal(thinkMarkdown({ ...done, result: { ...done.result, response: null } }), done.result.markdown);
  const failedWrite = await setup(t, [a], { thinkWriter: async () => { throw Object.assign(Error('fixture denied'), { code: 'EACCES' }); } });
  const saved = await failedWrite.engine.ensureDaily(); assert.equal(saved.status, 'done'); assert.match(saved.thinkError, /EACCES.*fixture denied/); assert.deepEqual(saved.result.response, validResponse());
});

test('v037 X8 recovery skips corrupt target and keeps dependent snapshot and original bytes', async t => {
  const a = record(), target = responseTarget([a], 'daily', '2026-10-24', 'two');
  const b = record('2026-10-24', { agent: identity('two'), respondsTo: target, result: output('新概念', validResponse()) });
  let engine; t.after(() => engine?.close());
  const h = await fixture(t); await seed(h.config, [b]); const file = path.join(h.config.dataDir, 'concepts', a.conceptId + '.json'); await put(file, '{corrupt');
  const malformed = [record(undefined, { day: undefined }), record(undefined, { day: 123 }), record(undefined, { agent: null })];
  await seed(h.config, malformed);
  engine = createConcepts(h.config, registry); await engine.recover();
  await assert.rejects(engine.get(a.conceptId), { status: 404 }); assert.deepEqual((await engine.get(b.conceptId)).respondsTo, target);
  for (const r of malformed) await assert.rejects(engine.get(r.conceptId), { status: 404 });
  assert.deepEqual((await engine.thread()).items.map(r => r.conceptId), [b.conceptId]);
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupt'); assert.match(await fs.readFile(path.join(h.config.dataDir, 'logs', 'concepts.log'), 'utf8'), /跳过不可读概念/);
});

test('v037 X11 X12 refit preserves response and THINK; responses create no map mentions', async t => {
  const a = record(), target = responseTarget([a], 'daily', '2026-10-24', 'two');
  const b = record('2026-10-24', { agent: identity('two'), respondsTo: target, responseError: null, result: output('会话目标罗盘', validResponse()) });
  let engine; t.after(() => engine?.close());
  b.result.term.zh = '目标罗盘'; const h = await fixture(t), thinkFile = path.join(h.root, 'existing-think.txt'); b.thinkFile = thinkFile;
  await put(thinkFile, thinkMarkdown(b)); await seed(h.config, [a, b]); const before = await fs.readFile(thinkFile); let calls = 0;
  engine = createConcepts(h.config, registry, { termRunner: async () => { calls++; return { term: { zh: '会话目标罗盘', en: 'Compass', fr: 'Boussole' } }; } });
  await engine.recover(); await engine.idle(); const saved = await engine.get(b.conceptId);
  assert.equal(calls, 1); assert.equal(saved.termBackfill.reason, 'refit'); assert.deepEqual(saved.result.response, b.result.response); assert.deepEqual(saved.respondsTo, target);
  assert.equal(saved.responseError, null); assert.equal(saved.result.markdown, b.result.markdown); assert.deepEqual(await fs.readFile(thinkFile), before);
  const withResponse = deriveConcepts([a, saved], []), without = structuredClone(saved); delete without.result.response; delete without.respondsTo;
  assert.deepEqual(withResponse, deriveConcepts([a, without], [])); assert.equal(withResponse.reduce((n, r) => n + r.mentions.length, 0), 2);
});

test('v037 X9 X13 HTTP thread defaults limits daily dedup failure gaps and legacy summaries', async t => {
  let app; t.after(() => app?.close());
  const h = await fixture(t), dates = Array.from({ length: 65 }, (_, i) => new Date(Date.parse('2026-10-23') - i * 86400000).toISOString().slice(0, 10));
  const records = dates.map(day => record(day)), failed = record('2026-10-24', { status: 'failed', result: null });
  const retry = record('2026-10-23', { status: 'failed', result: null, createdAt: at, sequence: 99 });
  const manual = record('2026-10-25', { kind: 'manual' }); await seed(h.config, [...records, failed, retry, manual]);
  app = await createApp(h.config, { conceptAutoDaily: false, registryBuilder: async () => registry() }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const [query, count] of [['', 30], ['?limit=1', 1], ['?limit=60', 60]]) {
    const response = await fetch(base + '/api/concepts/thread' + query), data = await response.json(); assert.equal(response.status, 200); assert.equal(data.items.length, count);
    assert.equal(data.items[0].status, 'failed'); assert.equal(data.items[0].day, '2026-10-24');
    assert.ok(data.items.every(r => r.conceptId !== manual.conceptId && r.conceptId !== retry.conceptId));
    if (count > 1) { assert.equal(data.items[1].response, null); assert.equal(data.items[1].respondsTo, null); }
  }
  for (const query of ['?limit=0', '?limit=61', '?limit=-1', '?limit=1.5', '?limit=NaN', '?limit=', '?limit=1e1', '?limit=%20', '?limit=1&limit=2'])
    assert.equal((await fetch(base + '/api/concepts/thread' + query)).status, 400, query);
  const summary = (await (await fetch(base + '/api/concepts?limit=200')).json()).items.find(r => r.conceptId === records[0].conceptId);
  assert.equal(summary.respondsTo, null); assert.equal(summary.response, null);
});

// Native button keyboard activation sends click in a browser; the recording DOM
// has no default keyboard actions, so verify its focus contract and dispatch click.
async function activate(button, doc) {
  assert.equal(button.tagName, 'BUTTON'); assert.equal(button.type, 'button'); assert.ok(!button.disabled); assert.ok(!button.closest('[hidden]'));
  assert.notEqual(button.getAttribute('tabindex'), '-1'); button.focus(); assert.equal(doc.activeElement, button); await button.fire('click');
}
for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v037 E2E X6 X8 X9 X15 ${ui} HTTP mountApp fake Codex response, thread, home and omitted response`, async t => {
  let front, app; t.after(async () => { front?.dispose(); await app?.close(); });
  const h = await fixture(t), a = record(), old = record('2026-10-21', { agent: identity('three') }), gap = record('2026-10-22', { status: 'failed', agent: identity('four'), result: null });
  await seed(h.config, [old, gap, a]); let now = new Date(at); const calls = [];
  app = await createApp(h.config, { conceptAutoDaily: false, registryBuilder: async () => registry(), conceptOptions: {
    now: () => now, randomIntImpl: () => 0, spawnImpl: spawner([output('新概念', validResponse()), output('后日概念', { stance: '无', text: '' })], calls),
    conceptVerifier: async () => ({ state: 'unconfirmed' }),
  } }); await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  const done = await app.concepts.ensureDaily(); assert.equal(done.status, 'done'); assert.equal(done.respondsTo.conceptId, a.conceptId);
  assert.ok(calls[0].prompt.includes(a.result.concept)); assert.ok(calls[0].prompt.includes(a.agent.bookLabel)); assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
  const schemaFile = calls[0].args[calls[0].args.indexOf('--output-schema') + 1]; assert.ok(JSON.parse(await fs.readFile(schemaFile)).required.includes('response'));
  assert.ok(!calls[0].args.some(s => s.includes('作者讲的「'))); assert.ok(done.thinkFile.startsWith(h.root));
  const summary = (await app.concepts.list()).items.find(r => r.conceptId === done.conceptId);
  assert.equal(Array.from(summary.response.text).length, 80); assert.deepEqual(summary.response, summary.result.response);
  const { doc } = await appDocument(ui, app.token); let missing = false;
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  front = await mountApp(doc, (url, options) => missing && url === `/api/concepts/${a.conceptId}` ? Promise.resolve({ ok: false, status: 404, json: async () => ({ error: '概念记录不存在' }) }) : fetch(base + url, options), { confirm: async () => true });
  assert.match(doc.querySelector('.concept-response-note').textContent, /^回应 \d{4}-\d{2}-\d{2} · 补充$/);
  await front.actions.openConcepts(); let card = doc.querySelector('.concept-response'); assert.ok(card); assert.match(card.textContent, /回应 《one的书》的「前日概念」/);
  assert.ok(card.textContent.includes(validResponse().text)); const panel = doc.getElementById('concepts-panel');
  assert.ok(panel.textContent.indexOf(validResponse().text) < panel.textContent.indexOf('正文1'));
  await activate(card.querySelector('button'), doc); assert.equal(front.snapshot().concepts.selected.conceptId, a.conceptId); assert.equal(doc.querySelector('.concept-response'), null);
  assert.ok(doc.activeElement.className.includes('concept-markdown'));
  await front.actions.selectConcept(done.conceptId); await activate(doc.getElementById('concept-thread-toggle'), doc);
  assert.equal(doc.getElementById('concept-thread-toggle').getAttribute('aria-expanded'), 'true'); assert.equal(doc.getElementById('concept-thread').hidden, false);
  const nodes = doc.querySelectorAll('.concept-thread-node'); assert.equal(nodes.length, 4);
  assert.equal(nodes[0].getAttribute('data-responds-to'), a.conceptId); assert.match(nodes[0].textContent, /＋ 补充.*回应 2026-10-23 · 前日概念/);
  assert.match(nodes[2].textContent, /这天没有生成.*断点/); assert.match(nodes[3].textContent, /无回应/);
  await activate(nodes[1].querySelector('button'), doc); assert.equal(front.snapshot().concepts.selected.conceptId, a.conceptId);
  await activate(doc.getElementById('concept-thread-toggle'), doc); assert.equal(doc.getElementById('concept-thread').hidden, true);
  await front.actions.selectConcept(done.conceptId); missing = true; await activate(doc.querySelector('.concept-response').querySelector('button'), doc);
  assert.equal(front.snapshot().concepts.selected.conceptId, done.conceptId); assert.match(front.snapshot().concepts.error, /原记录不存在/);
  assert.match(doc.querySelector('.concept-response').textContent, /one的书.*前日概念/); missing = false;
  now = new Date('2026-10-25T01:00:00Z'); const invalid = await app.concepts.ensureDaily(); assert.equal(invalid.status, 'done'); assert.equal(invalid.result.response, null); assert.match(invalid.responseError, /立场/);
  assert.equal(await fs.readFile(invalid.thinkFile, 'utf8'), invalid.result.markdown);
  await front.actions.openConcepts(); await front.actions.selectConcept(invalid.conceptId);
  assert.equal(doc.querySelector('.concept-response'), null); assert.match(doc.querySelector('.concept-response-error').textContent, /本次回应未通过格式校验，已省略/);
  assert.equal(doc.querySelector('.concept-response-note'), null); assert.match(panel.textContent, /正文11/);
  await activate(doc.getElementById('concept-thread-toggle'), doc); assert.match(doc.querySelector('.concept-thread-node').textContent, /无回应/);
  assert.equal(calls.length, 2); const persisted = JSON.parse(await fs.readFile(path.join(h.config.dataDir, 'concepts', invalid.conceptId + '.json'), 'utf8'));
  assert.equal(persisted.status, 'done'); assert.equal(persisted.responseError, invalid.responseError);
});

test('v037 shared fallback renders response and keyboard thread controls', async () => {
  const doc = documentFrom('<html><body><main><div id="root"></div></main></body></html>'), a = record();
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const r = record('2026-10-24', { respondsTo: responseTarget([a], 'daily', '2026-10-24', 'two'), result: output('新概念', validResponse()) });
  let selected, toggled = false; const ctx = { doc, root: doc.getElementById('root'), refs: {}, state: { view: 'concepts' }, actions: {
    openConceptResponse: async id => { selected = id; return a; }, toggleConceptThread: () => { toggled = true; },
  } };
  renderDefaultConcepts(ctx, { items: [r], selected: r, today: { conceptId: r.conceptId }, threadOpen: false });
  await activate(doc.querySelector('.concept-response').querySelector('button'), doc); assert.equal(selected, a.conceptId);
  await activate(doc.getElementById('concept-thread-toggle'), doc); assert.equal(toggled, true);
});

test('v037 thread loading failure retries and stale source requests cannot replace selection', async () => {
  let fail = true, resolve; const a = record(), b = record('2026-10-24');
  const state = controller({ api: async url => {
    if (url.includes('/thread?')) { if (fail) throw Error('offline'); return { items: [] }; }
    if (url.endsWith(a.conceptId)) return new Promise(r => { resolve = r; }); return b;
  }, setTimer: () => 0, clearTimer() {} });
  await state.toggleConceptThread(); assert.match(state.snapshot().threadError, /offline/); assert.equal(state.snapshot().threadLoading, false);
  fail = false; await state.refreshThread(); assert.equal(state.snapshot().threadError, '');
  const stale = state.openConceptResponse(a.conceptId); await state.selectConcept(b.conceptId); resolve(a); await stale;
  assert.equal(state.snapshot().selected.conceptId, b.conceptId); state.dispose();
});
