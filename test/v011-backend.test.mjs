import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

const at = '2026-10-08T01:00:00Z';
const book = (id, extra = {}) => ({ id, name: id.toUpperCase(), kind: 'book', description: '简介\n\n不加入目录的第二段', primary: '学习',
  book: { title: `《${id}的书》`, author: `${id}作者` }, platforms: { codex: { available: true } }, sources: { missing: [] }, ...extra });
const agents = ['one','two','three','four','five','six','seven','eight'].map(id => book(id));
const term = { zh: '习惯', en: 'Habit', fr: 'Habitude' };
// v0.53.12: every attribution quotes the participant's own analysis, which contains this sentence.
const quote = '第三章说习惯靠线索维持', cite = agent => ({ agent, quote });
function output(names = ['ONE','TWO','THREE']) {
  return { selected: names.map(agent => ({ agent, reason: `${agent}直接论述` })),
    perAgent: names.map(agent => ({ agent, analysis: `BOOK：${quote}。\r\nINFERENCE：${agent}原文\n覆盖程度：直接`, coverage: '直接' })),
    commonAnswer: { summary: '共同结论', points: [{ text: '全体支持', support: names.map(cite), strength: '全员一致' }, { text: '多数支持', support: names.slice(0, Math.floor(names.length / 2) + 1).map(cite), strength: '多数同意' }] },
    divergences: [{ topic: '分歧', positions: names.slice(0, 2).map(agent => ({ agent, view: '立场和理由', quote })) }],
    actions: [1,2,3].map(n => ({ text: `建议${n}`, basis: [cite(names[0])] })), terms: [term] };
}
const record = () => ({ seminarId: randomUUID(), createdAt: at, input: '为什么人很难改变习惯？', mode: 'auto', requestedAgents: null, catalog: agents });
async function setup(t, options = {}, list = agents) {
  // After hooks run in registration order: close the engine (and any app) before the fixture folder is removed.
  let engine; t.after(() => engine?.close());
  const ctx = await fixture(t); ctx.config.seminar = { timeoutMs: 1000, thinkDir: path.join(ctx.root, '研讨') };
  const { createSeminars } = await import('../src/seminars/index.mjs');
  engine = createSeminars(ctx.config, () => ({ agents: list }), { now: () => new Date(at), runner: async () => output(), verifier: async () => ({ state: 'unconfirmed' }), ...options });
  await engine.recover(); return { ...ctx, engine };
}
function fakeOutput(value, calls = [], { hang = false, malformed = false, code = 0 } = {}) {
  return (exe, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 23456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { exe, args, options, prompt: '' }; calls.push(call);
    child.stdin.on('data', chunk => { call.prompt += chunk; });
    child.stdin.on('finish', async () => {
      if (hang) return;
      await fs.writeFile(args[args.indexOf('-o') + 1], malformed ? '{' : JSON.stringify(value)); child.emit('close', code, null);
    }); return child;
  };
}

test('v011 seminar prompt uses exact contract paragraphs, catalog summaries, and explicit selection', async () => {
  const { seminarPrompt } = await import('../src/seminars/runner.mjs');
  const r = record(); r.seminarId = 'ID'; r.catalog = agents.slice(0, 3);
  // v0.53: the prompt as specified in the v0.11 manual, kept verbatim in test/fixtures/templates (user named Alex).
  const prompt = seminarPrompt(r, 'Alex');
  const template = (await fs.readFile('test/fixtures/templates/v0.11-seminar-prompt.txt', 'utf8')).replaceAll('\r\n', '\n');
  const expected = template.replace('<seminarId>', 'ID')
    .replace(/<自动时：([^>]+)><指定时：[^>]+>/, '$1').replace('<input>', r.input)
    .replace('<每行一项：codexName｜《书名》｜作者｜分类｜一句话简介（取 summary，最多 80 字）>',
      agents.slice(0, 3).map(a => `${a.name}｜${a.book.title}｜${a.book.author}｜学习｜简介`).join('\n'));
  assert.ok(prompt.startsWith(expected)); assert.match(prompt, /terms/); assert.match(prompt, /只译.*词|只翻译.*词/);
  const explicit = seminarPrompt({ ...r, mode: 'explicit', requestedAgents: ['one','two','three'] });
  assert.match(explicit, /参加者已经确定，按下面的名单进行，不得增删/); assert.match(explicit, /ONE、TWO、THREE/);
  assert.doesNotMatch(explicit, /从下面的书籍 Agent 目录中选出/);
  const long = seminarPrompt({ ...r, catalog: [book('one', { description: '字'.repeat(100) + '\n\n不要展示' })] });
  assert.equal(long.split('\n').find(line => line.startsWith('ONE｜')).split('｜').at(-1).length, 80);
});

test('v011 schema and validator recount strength, reject minority/duplicates/foreign references, preserve exact analyses', async () => {
  const { seminarSchema, validateSeminar } = await import('../src/seminars/runner.mjs');
  assert.equal(seminarSchema.additionalProperties, false); assert.ok(seminarSchema.required.includes('terms'));
  const r = record(), raw = output(); raw.commonAnswer.points[0].strength = '多数同意'; raw.commonAnswer.points[1].strength = '全员一致';
  const corrected = validateSeminar(raw, r);
  assert.equal(corrected.strengthCorrected, true);
  assert.deepEqual(corrected.result.commonAnswer.points.map(p => p.strength), ['全员一致','多数同意']);
  assert.equal(raw.commonAnswer.points[0].strength, '多数同意');
  assert.deepEqual(corrected.result.perAgent.map(p => p.analysis), raw.perAgent.map(p => p.analysis));
  for (const mutate of [
    o => o.selected.pop(), o => o.selected.push(o.selected[0]), o => o.selected[0].agent = 'ROLE',
    o => o.perAgent.pop(), o => o.perAgent[0].coverage = 'unknown', o => o.perAgent[0].analysis = '',
    o => o.commonAnswer.points[0].support = ['ONE'].map(cite), o => o.commonAnswer.points[0].support = ['ONE','ONE','TWO'].map(cite),
    o => o.actions[0].basis = [cite('ROLE')], o => o.actions.pop(), o => o.divergences[0].positions[0].agent = 'ROLE',
    o => o.commonAnswer.points[0].support = ['ONE','TWO','THREE'], o => o.actions[0].basis[0].quote = '太短', o => delete o.divergences[0].positions[0].quote,
    o => o.terms = [], o => o.terms = [term,term,term,term], o => o.terms[0] = { ...term, zh: '多于八个汉字的概念名称' }, o => o.extra = true,
  ]) { const value = output(); mutate(value); assert.throws(() => validateSeminar(value, r)); }
  const eight = agents.map(a => a.name), explicit = { ...r, mode: 'explicit', requestedAgents: agents.map(a => a.id) };
  assert.equal(validateSeminar(output(eight), explicit).result.selected.length, 8);
  assert.throws(() => validateSeminar(output(), explicit));
  assert.throws(() => validateSeminar(output(eight), r));
  const offline = { ...r, catalog: agents.map(a => a.id === 'one' ? book('one', { platforms: { codex: { available: false } } }) : a) };
  assert.throws(() => validateSeminar(output(), offline));
});

test('v011 engine saves enriched results, verification warnings, list/detail, and parent reruns', async t => {
  const { engine, config } = await setup(t, { verifier: async () => ({ state: 'violation', parallel: { state: 'not-parallel' }, violations: ['fixture'] }) });
  const { seminarId } = await engine.start({ input: '为什么人很难改变习惯？' }); await engine.idle();
  const r = await engine.get(seminarId); assert.equal(r.status, 'done'); assert.equal(r.verify.state, 'violation');
  assert.equal(r.model, 'gpt-test'); assert.equal(r.effort, 'xhigh'); assert.equal(r.parentId, null);
  assert.deepEqual(r.result.perAgent.map(p => p.id), ['one','two','three']);
  assert.ok(r.result.perAgent.every(p => p.bookLabel && /^#[0-9a-f]{6}$/.test(p.avatarColor)));
  assert.equal(r.result.perAgent[0].analysis, output().perAgent[0].analysis);
  assert.equal((await engine.list()).items[0].seminarId, seminarId);
  assert.equal((await engine.list()).running, null);
  // v0.53.12: 3 + 2 support quotes, 2 positions and 3 action quotes, all found in the analyses.
  assert.deepEqual(r.result.sourceCheck, { total: 10, unverified: 0 });
  assert.deepEqual((await engine.list()).items[0].result.sourceCheck, { total: 10, unverified: 0 });
  assert.equal((await engine.list()).items[0].result.commonAnswer.points, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir,'seminars',seminarId+'.json'))), r);
  const rerun = await engine.start({ input: r.input, agentIds: ['one','two','three'], parentId: seminarId }); await engine.idle();
  assert.equal((await engine.get(rerun.seminarId)).parentId, seminarId);
  assert.equal((await engine.get(rerun.seminarId)).mode, 'explicit');
  for (const limit of [0, 201, NaN, 1.5]) await assert.rejects(engine.list(limit), { status: 400 });
  for (const id of ['../x', randomUUID()]) await assert.rejects(engine.get(id), { status: 404 });
});

test('v011 explicit validation and exact confirmations happen before any process; auto catalog is safe', async t => {
  let calls = 0;
  const list = [...agents.slice(0,3), book('writable', { writable: true }), book('missing', { sources: { missing: ['gone'] } }), book('off', { platforms: { codex: { available: false } } }), book('role', { kind: 'role' })];
  const { engine } = await setup(t, { runner: async r => { calls++; return output(r.catalog.slice(0,3).map(a => a.name)); } }, list);
  for (const body of [null, {}, { input: '' }, { input: '字'.repeat(2001) }, { input: 'x', agentIds: [] }, { input: 'x', agentIds: ['one','one','two'] },
    { input: 'x', agentIds: ['one','two','role'] }, { input: 'x', agentIds: ['one','two','unknown'] }, { input: 'x', parentId: randomUUID() }]) {
    await assert.rejects(engine.start(body), { status: 400 });
  }
  await assert.rejects(engine.start({ input: 'x', agentIds: ['one','two','off'] }), { status: 409 });
  await assert.rejects(engine.start({ input: 'x', agentIds: ['one','two','writable'], writableConfirmed: 'true' }), e => e.status === 409 && e.writable.length === 1);
  await assert.rejects(engine.start({ input: 'x', agentIds: ['one','two','missing'], sourcesConfirmed: 'true' }), { status: 409 });
  assert.equal(calls, 0);
  const auto = await engine.start({ input: 'x' }); await engine.idle();
  assert.deepEqual((await engine.get(auto.seminarId)).catalog.map(a => a.id), ['one','two','three']);
  const explicit = await engine.start({ input: 'x', agentIds: ['one','writable','missing'], writableConfirmed: true, sourcesConfirmed: true }); await engine.idle();
  assert.equal((await engine.get(explicit.seminarId)).status, 'done');
});

// v0.48 (2026-11-07): up to three 圆桌 run at once; restarts and failed tree kills still count toward the limit.
test('v011 concurrent start lock, restart recovery and failed tree kill count toward the three-seminar limit', async t => {
  const releases = []; let alive = true;
  const { engine, config } = await setup(t, { isAlive: () => alive, runner: () => new Promise(resolve => { releases.push(resolve); }) });
  const accepted = await Promise.allSettled(['a', 'b', 'c', 'd'].map(input => engine.start({ input })));
  assert.equal(accepted.filter(v => v.status === 'fulfilled').length, 3);
  const refused = accepted.find(v => v.status === 'rejected').reason;
  assert.equal(refused.status, 409); assert.match(refused.message, /最多同时进行 3 场圆桌/); assert.equal(refused.active, 3); assert.equal(refused.parallel, 3);
  assert.equal((await engine.list()).active, 3);
  while (releases.length < 3) await new Promise(resolve => setImmediate(resolve)); for (const release of releases) release(output()); await engine.idle();
  assert.equal((await engine.list()).active, 0);
  const dead = { ...(await engine.get(accepted.find(v => v.status === 'fulfilled').value.seminarId)), seminarId: randomUUID(), status: 'running', pid: 555 };
  await put(path.join(config.dataDir,'seminars',dead.seminarId+'.json'), JSON.stringify(dead));
  await engine.recover(); assert.equal((await engine.list()).active, 1, 'a live process keeps its seminar counted');
  alive = false; await engine.recover(); assert.equal((await engine.get(dead.seminarId)).error, '进程中断');
  const failed = await setup(t, { isAlive: () => true, runner: async () => { throw Object.assign(Error('kill failed'), { processMayBeAlive: true, pid: 123 }); } });
  const started = await failed.engine.start({ input: 'x' }); await failed.engine.idle();
  assert.equal((await failed.engine.get(started.seminarId)).status, 'running');
  assert.equal((await failed.engine.list()).active, 1);
});

test('v011 THINK structure, terms, exact analysis, 40 code points, exclusive suffixes and failed copy are isolated', async t => {
  const { saveSeminarThink, seminarMarkdown } = await import('../src/seminars/think.mjs');
  const { engine, root } = await setup(t); const started = await engine.start({ input: '为什么人很难改变习惯？' }); await engine.idle();
  const r = await engine.get(started.seminarId), markdown = seminarMarkdown(r);
  assert.deepEqual(await fs.readFile(r.thinkFile), Buffer.from(markdown, 'utf8'));
  assert.match(markdown, /^# 研讨：为什么人很难改变习惯？\n\n核心概念：习惯 · Habit · Habitude/);
  for (const heading of ['共同答案','分歧点','行动建议','各作者的看法']) assert.ok(markdown.includes(`## ${heading}`));
  assert.ok(markdown.includes('【全员一致】')); assert.ok(markdown.includes('【多数同意】')); assert.ok(markdown.includes(r.result.perAgent[0].analysis));
  const english = structuredClone(r); english.result.perAgent[0].bookLabel = 'English Book';
  assert.ok(seminarMarkdown(english).includes('ONE · 《English Book》 · ONE直接论述'));
  const dir = path.join(root, 'separate'), long = { ...r, input: '字'.repeat(45) };
  const files = await Promise.all([saveSeminarThink(long, dir), saveSeminarThink(long, dir)]);
  assert.deepEqual(files.map(file => path.basename(file)).sort(), ['字'.repeat(40)+'-2.md', '字'.repeat(40)+'.md'].sort());
  await assert.rejects(saveSeminarThink(r, path.join(root,'absent','leaf')), { code: 'ENOENT' });
  await assert.rejects(saveSeminarThink(r, dir, { io: { ...fs, readFile: async () => Buffer.from('wrong') } }), /回读/);
  const failed = await setup(t, { thinkWriter: async () => { throw Error('fixture denied'); } });
  const id = await failed.engine.start({ input: 'x' }); await failed.engine.idle();
  const value = await failed.engine.get(id.seminarId); assert.equal(value.status, 'done'); assert.match(value.thinkError, /denied/);
});

test('v0.53.12 THINK lists each quote under its point, action and position, with the source check above the summary', async t => {
  const { seminarMarkdown } = await import('../src/seminars/think.mjs');
  const { engine } = await setup(t); const started = await engine.start({ input: '为什么人很难改变习惯？' }); await engine.idle();
  const r = await engine.get(started.seminarId);
  r.result.commonAnswer.points[0].evidence[1].verified = false; r.result.divergences[0].positions[1].verified = false; r.result.sourceCheck.unverified = 2;
  const markdown = seminarMarkdown(r);
  assert.ok(markdown.includes(`## 共同答案\n\n原文回查：10 处依据，2 处未在作者原文中找到。\n\n共同结论\n\n`));
  assert.ok(markdown.includes(`- 【全员一致】全体支持（支持：ONE、TWO、THREE）\n  - ONE：「${quote}」\n  - TWO：「${quote}」（未在原文中找到）\n  - THREE：「${quote}」\n`));
  assert.ok(markdown.includes(`- ONE：立场和理由——「${quote}」\n- TWO：立场和理由——「${quote}」（未在原文中找到）`));
  assert.ok(markdown.includes(`1. 建议1（依据：ONE）\n   - ONE：「${quote}」\n2. 建议2`));
});

test('v0.53.12 THINK output of a record saved before 原文回查 is unchanged', async () => {
  const { seminarMarkdown } = await import('../src/seminars/think.mjs');
  const { localTime } = await import('../src/concepts/index.mjs');
  const old = { input: '问题', createdAt: at, result: { terms: [term], selected: [{ agent: 'ONE', reason: '理由' }],
    perAgent: [{ agent: 'ONE', name: '一号', bookLabel: '《一的书》', analysis: '分析原文', coverage: '直接' }],
    commonAnswer: { summary: '总结', points: [{ text: '要点', support: ['ONE'], strength: '全员一致' }] },
    divergences: [{ topic: '议题', positions: [{ agent: 'ONE', view: '立场' }] }], actions: [{ text: '行动', basis: ['ONE'] }] } };
  assert.equal(seminarMarkdown(old), `# 研讨：问题\n\n核心概念：习惯 · Habit · Habitude\n\n日期：${localTime(new Date(at)).day}（本机时区）\n\n参加者：\n- 一号 · 《一的书》 · 理由\n\n` +
    '## 共同答案\n\n总结\n\n- 【全员一致】要点（支持：一号）\n\n## 分歧点\n\n### 议题\n\n- 一号：立场\n\n## 行动建议\n\n1. 行动（依据：一号）\n\n## 各作者的看法\n\n### 一号 · 《一的书》\n\n分析原文\n');
});

test('v011 process uses existing argv/env scrubbing, files and stdin; timeout/abort await process-tree kill', async t => {
  const { runSeminarProcess } = await import('../src/seminars/runner.mjs');
  const { config } = await fixture(t); config.seminar = { timeoutMs: 1000 }; const calls = [], r = record();
  assert.deepEqual(await runSeminarProcess(r, config, { spawnImpl: fakeOutput(output(), calls), env: { CLAUDECODE: 'secret', ELECTRON_RUN_AS_NODE: '1', PATH: 'keep' } }), output());
  const call = calls[0]; assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.env.CLAUDECODE, undefined);
  assert.equal(call.args.at(-1), '-'); assert.ok(!call.args.join('').includes(r.input)); assert.ok(call.prompt.includes(r.input));
  assert.equal(await fs.readFile(path.join(config.dataDir,'seminars/work',r.seminarId,'prompt.txt'),'utf8'), call.prompt);
  config.seminar.timeoutMs = 10; let kills = 0;
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}, [], { hang: true }), killTree: async c => { assert.equal(c.pid,23456); kills++; } }), /超时/);
  assert.equal(kills, 1);
  config.seminar.timeoutMs = 1000; // only the hang case needs the 10 ms deadline; under load later cases must not time out
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}, [], { malformed: true }) }), /JSON/);
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}, [], { code: 2 }) }), /退出码 2/);
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}) }), /JSON|格式/);
  const controller = new AbortController(); controller.abort(); let spawned = false;
  await assert.rejects(runSeminarProcess(record(), config, { signal: controller.signal, spawnImpl: () => { spawned = true; } }), /进程中断/); assert.equal(spawned, false);
});

test('v011 seminar abort after spawn and failed kill keep process metadata even when diagnostic writes fail', async t => {
  const { runSeminarProcess } = await import('../src/seminars/runner.mjs');
  const { config } = await fixture(t); config.seminar = { timeoutMs: 15 };
  let diagnosticFailure = false;
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}, [], { hang: true }),
    killTree: async () => { throw Error('kill refused'); }, write: async (file, bytes) => {
      if (file.endsWith('stdout.txt')) { diagnosticFailure = true; throw Error('disk full'); }
      await put(file, bytes);
    },
  }), error => error.processMayBeAlive === true && error.pid === 23456 && /kill refused/.test(error.message));
  assert.equal(diagnosticFailure, true);
  const controller = new AbortController(); let killed = 0;
  await assert.rejects(runSeminarProcess(record(), config, { spawnImpl: fakeOutput({}, [], { hang: true }),
    signal: controller.signal, onSpawn: async () => { controller.abort(); }, killTree: async () => { killed++; },
  }), /进程中断/); assert.equal(killed, 1);
});

test('v011 seminar stores strengthCorrected and failure without losing records; shutdown prevents another run', async t => {
  const raw=output();raw.commonAnswer.points[0].strength='多数同意';
  const corrected=await setup(t,{runner:async()=>raw,verifier:async()=>{throw Error('unreadable evidence');}});
  const a=await corrected.engine.start({input:'question'});await corrected.engine.idle();const saved=await corrected.engine.get(a.seminarId);
  assert.equal(saved.strengthCorrected,true);assert.equal(saved.status,'done');assert.match(saved.verify.error,/unreadable/);
  const invalid=await setup(t,{runner:async()=>({...output(),actions:[]})});const b=await invalid.engine.start({input:'question'});await invalid.engine.idle();
  assert.equal((await invalid.engine.get(b.seminarId)).status,'failed');assert.equal((await invalid.engine.get(b.seminarId)).thinkFile,null);
  const owned=await setup(t,{runner:async(_r,_c,{signal})=>new Promise((_resolve,reject)=>{
    if(signal.aborted)reject(Error('进程中断'));else signal.addEventListener('abort',()=>reject(Error('进程中断')),{once:true});
  })});const c=await owned.engine.start({input:'question'});await owned.engine.close();
  assert.equal((await owned.engine.get(c.seminarId)).status,'failed');await assert.rejects(owned.engine.start({input:'question'}),{status:409});
});

test('v011 seminar verification reuses perspective rules with seminar marker, cutoff, whitelist, depth and parallel order', async t => {
  const { verifySeminar } = await import('../src/seminars/verify.mjs');
  const { config } = await fixture(t), r = { ...record(), result: output() };
  const main = async (id, time, tools, source = 'exec') => {
    const file = path.join(config.codexSessionsDir, `rollout-${id}.jsonl`);
    await jsonl(file, [{ type: 'session_meta', payload: { id, timestamp: time, source } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: `【CO-AGENT 研讨 ${r.seminarId}】` } },
      ...tools.map(([name, agent_type]) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify({ agent_type }) } }))]); return file;
  };
  const tools = [...['ONE','TWO','THREE'].map(name => ['spawn_agent', name]), ['wait_agent']];
  const old = await main('old', new Date(Date.parse(at)-300001).toISOString(), []); await fs.appendFile(old, 'invalid old body');
  await main('cli', at, [], 'cli'); const good = await main('main', new Date(Date.parse(at)-300000).toISOString(), tools);
  for (const name of ['ONE','TWO','THREE']) await jsonl(path.join(config.codexSessionsDir,`rollout-${name}.jsonl`), [{ type: 'session_meta', payload: { id: name, timestamp: at, source: { subagent: { thread_spawn: { parent_thread_id: 'main', agent_role: name, depth: 1 } } } } }]);
  const reads = []; assert.equal((await verifySeminar(r, config, { io: { ...fs, readFile: (...args) => { reads.push(args[0]); return fs.readFile(...args); } } })).state, 'ok');
  assert.deepEqual(reads, [good]);
  await main('main', at, [tools[0], ['wait_agent'], ...tools.slice(1,3)]);
  assert.equal((await verifySeminar(r, config)).state, 'violation');
  await main('main', at, tools);
  await jsonl(path.join(config.codexSessionsDir,'rollout-extra.jsonl'), [{ type:'session_meta', payload:{ id:'extra', timestamp:at, source:{ subagent:{ thread_spawn:{ parent_thread_id:'ONE', agent_role:'ROLE', depth:2 } } } } }]);
  assert.equal((await verifySeminar(r, config)).state, 'violation');
  await main('ambiguous', at, tools); assert.match((await verifySeminar(r, config)).error, /歧义/);
});

test('v011 config seminar defaults, nested merge, validation and protected directories', async t => {
  const { root } = await fixture(t), dir = path.join(root,'conf'), configFile = path.join(dir,'config.json');
  const read = () => loadConfig({ env: { CO_AGENT_DATA_DIR: dir }, home: root });
  assert.deepEqual((await read()).seminar, { timeoutMs:2700000, thinkDir:null }, 'v0.50: no copy folder unless configured');
  await put(configFile, JSON.stringify({ seminar: { timeoutMs: 200 } })); assert.equal((await read()).seminar.timeoutMs,200);
  for (const seminar of [null,[],{timeoutMs:0},{timeoutMs:1.5},{timeoutMs:2147483648},{thinkDir:'relative'},{thinkDir:path.resolve('src')}]) {
    await put(configFile, JSON.stringify({ seminar })); await assert.rejects(read(), /seminar|只读|仓库/);
  }
});

test('v011 real HTTP seminar routes are token/Origin protected and expose 202,409,list,detail', async t => {
  let app; t.after(()=>app?.close());
  const { root, config } = await fixture(t); config.seminar.thinkDir = path.join(root,'研讨'); const releases=[];
  app = await createApp(config, { conceptAutoDaily:false, registryBuilder:async()=>({agents}), seminarOptions:{ runner:()=>new Promise(resolve=>{ releases.push(resolve); }), verifier:async()=>({state:'unconfirmed'}) } });
  await app.listen(); const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=(body,headers={})=>fetch(base+'/api/seminars',{method:'POST',headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token,...headers},body:JSON.stringify(body)});
  assert.equal((await post({input:'x'},{'X-Co-Agent-Token':''})).status,403); assert.equal((await post({input:'x'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await post({input:''})).status,400); assert.equal((await fetch(base+'/api/seminars?limit=0')).status,400);
  const response=await post({input:'x'}); assert.equal(response.status,202); const {seminarId}=await response.json();
  assert.equal((await post({input:'y'})).status,202); assert.equal((await post({input:'z'})).status,202);
  const full=await post({input:'w'}); assert.equal(full.status,409); assert.match((await full.json()).error,/最多同时进行 3 场圆桌/);
  const listed=await (await fetch(base+'/api/seminars')).json(); assert.equal(listed.active,3); assert.equal(listed.parallel,3);
  while(releases.length<3)await new Promise(resolve=>setImmediate(resolve)); for(const release of releases)release(output()); await app.seminars.idle();
  assert.equal((await (await fetch(base+'/api/seminars/'+seminarId)).json()).status,'done'); assert.equal((await fetch(base+'/api/seminars/bad')).status,404);
});

test('v050 a 圆桌 without a copy folder is kept in the app only, with no copy error', async t => {
  const { engine, config } = await setup(t, { thinkWriter: async () => assert.fail('no copy folder is configured') });
  config.seminar.thinkDir = null;
  const started = await engine.start({ input: '为什么人很难改变习惯？' }); await engine.idle();
  const r = await engine.get(started.seminarId);
  assert.equal(r.status, 'done'); assert.ok(!r.thinkFile); assert.ok(!r.thinkError);
});
