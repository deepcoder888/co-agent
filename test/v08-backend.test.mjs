import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { createConcepts, selectAgent, excludedConcepts, shanghaiTime } from '../src/concepts/index.mjs';
import { conceptPrompt, perspectivePrompt, conceptArgs, conceptSchema, perspectiveSchema, runConceptProcess, killProcessTree } from '../src/concepts/runner.mjs';
import { verifyConcept, verifyPerspectives, skillStructure } from '../src/concepts/verify.mjs';
import { conceptBasename, saveThink } from '../src/concepts/think.mjs';

const instant = new Date('2026-10-08T01:00:00Z');
const markdown = '# 心理表征 - AI-Era Learning Map\r\n' + Array.from({ length: 11 }, (_, i) => `### ${i + 1}. Section\r\n内容 ${i + 1}\r\n`).join('');
const result = { concept: '心理表征', conceptEn: 'Mental Representation', oneLine: '帮助理解', whyUnknown: '简介没有提到', sourceRefs: ['第三章'], markdown, term: { zh: '心理表征', en: 'Mental Representation', fr: 'Représentation mentale' }, response: { stance: '无', text: '' } };
const book = (id = 'walvo') => ({ id, name: id === 'walvo' ? 'Walvo' : id, kind: 'book', platforms: { codex: { available: true } }, book: { title: '睡眠', author: '作者' }, sources: { missing: [] } });
const record = () => ({ conceptId: randomUUID(), createdAt: instant.toISOString(), agent: { id: 'walvo', name: 'Walvo', codexName: 'Walvo', title: '睡眠' }, excludedConcepts: [], result });
async function setup(t, overrides = {}) {
  const { root, config } = await fixture(t);
  config.concept = { timeoutMs: 1000, thinkDir: path.join(root, 'think') };
  const engine = createConcepts(config, () => ({ agents: [book(), book('jadra'), book('peter')] }), {
    now: () => instant, randomIntImpl: () => 0, runner: async () => result,
    conceptVerifier: async () => ({ state: 'unconfirmed', session: null, children: [], skillStructure: skillStructure(markdown) }), ...overrides,
  });
  await engine.recover(); t.after(() => engine.close());
  return { root, config, engine };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('v08 selection excludes unavailable/missing sources and avoids last seven when possible', () => {
  const agents = [book(), book('jadra'), { ...book('bad'), sourcesOk: false }, { ...book('missing'), sources: { missing: ['lost'] } }, { ...book('off'), platforms: {} }, { ...book('role'), kind: 'role' }];
  assert.equal(selectAgent(agents, [{ agent: { id: 'walvo' } }], () => 0).id, 'jadra');
  assert.equal(selectAgent([book()], [{ agent: { id: 'walvo' } }], () => 0).id, 'walvo');
  assert.throws(() => selectAgent([], [], () => 0), /书籍/);
  assert.deepEqual(excludedConcepts([
    { status: 'done', agent: { id: 'walvo' }, result: { concept: ' 心 理 表 征 ', conceptEn: 'MENTAL Representation' } },
    { status: 'done', agent: { id: 'walvo' }, result: { concept: '心理表征', conceptEn: 'mentalrepresentation' } },
    { status: 'failed', agent: { id: 'walvo' }, result }, { status: 'done', agent: { id: 'jadra' }, result },
  ], 'walvo'), ['心理表征', 'mentalrepresentation']);
});

test('v08 exact concept prompt and process argv keep prompt off command line', async () => {
  const r = record(); r.conceptId = 'ID'; r.excludedConcepts = ['概念甲', 'concept b'];
  assert.equal(conceptPrompt(r), `【CO-AGENT 随机概念 ID】
你是协调者，只做以下事情：
1. 派生且只派生一个 agent_role 为「Walvo」的子 Agent。不得派生其他 Agent，不得自己代替它回答，不要调用其他工具。
2. 交给它的任务原文如下：
「请从你绑定的书《睡眠》中选出一个核心概念。它应当是读者很可能『不知道自己不知道』的概念：普通读者看书名和简介时意识不到它的存在，但理解它会改变对问题的理解或决策。不得选择以下已讲过的概念：概念甲；concept b。然后使用 $concept-ai-era 技能，用中文讲解这个概念。必须保留该技能规定的开头行和全部 11 个编号小节（### 1. 到 ### 11.）。讲解必须以书中内容为依据，并注明书内出处（章节）。不要执行该技能的 Final Persistence Step，不要写任何文件，文件由 CO-AGENT 保存。最后另起一段，用一句话说明：为什么读者很可能不知道自己不知道这个概念。」
3. 等它完成后，按输出 schema 返回：concept（概念中文名）、conceptEn（英文名，没有则为 null）、oneLine（一句话说明）、whyUnknown（子 Agent 给出的那句「为什么不知道」）、sourceRefs（书内出处数组）、markdown（子 Agent 的完整概念讲解原文，不得删改或总结；回应单独放 response，正文仍为 11 节）。response 必填，没有回应对象，stance 必须填「无」，text 必须为空字符串，不要回应其他概念。另给出核心概念 term：zh 必须是 concept 中连续的一段（1–8 个汉字），能单独代表这个概念，不能是「概念」「创造」这类泛词；concept 本身不超过 8 个汉字时，zh 就是 concept。例：「会话目标罗盘」（6 字）→「会话目标罗盘」；「内外嵌套的调节工具箱」（10 字）→「调节工具箱」，不能是「嵌套」。en、fr 只翻译 zh 这个词。法文去掉冠词并保留重音符号。`);
  assert.match(conceptPrompt({ ...r, excludedConcepts: [] }), /已讲过的概念：无。/);
  assert.deepEqual(conceptArgs({ codexProfile: 'gpt', codexModel: 'gpt-test', codexEffort: 'xhigh', launchProject: 'project' }, { schema: 'schema', output: 'out' }),
    ['exec', '--profile', 'gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort="xhigh"', '-c', 'agents.max_threads=8', '-s', 'read-only', '--skip-git-repo-check', '-C', 'project', '--json', '--output-schema', 'schema', '-o', 'out', '-']);
  assert.equal(conceptSchema.additionalProperties, false);
  assert.deepEqual(conceptSchema.required, Object.keys(result));
  assert.equal(perspectiveSchema.properties.results.items.additionalProperties, false);
  const prompt = perspectivePrompt({ ...r, result: { ...result, markdown: '字'.repeat(5000) } }, { runId: 'RUN', agents: [{ codexName: 'Jadra' }, { codexName: 'Peter' }] });
  assert.ok(prompt.includes('全部派生之后才开始等待：Jadra、Peter。'));
  assert.equal((prompt.match(/字/g) || []).length, 4001); // 300–600 字 plus excerpt
});

test('v08 structure checks real Markdown headings, ignoring fenced examples and number prefixes', () => {
  assert.deepEqual(skillStructure(markdown), { state: 'ok', missing: [], titleLine: true });
  const missing = skillStructure('```md\n' + markdown + '\n```\n### 10. only\n### 110. not eleven');
  assert.equal(missing.titleLine, false); assert.deepEqual(missing.missing, [1,2,3,4,5,6,7,8,9,11]);
});

test('v08 THINK follows skill naming, exclusive collisions, UTF-8 and exact CRLF bytes', async t => {
  const { root } = await fixture(t), dir = path.join(root, 'concept');
  assert.equal(conceptBasename(' .<名称>:  / 测试?. '), '名称-测试');
  assert.equal(conceptBasename('CoN'), 'concept-CoN');
  for (const label of ['PRN', 'aux', 'NUL', 'COM9', 'lpt1']) assert.match(conceptBasename(label), /^concept-/);
  assert.equal(Array.from(conceptBasename('汉'.repeat(90))).length, 80);
  assert.equal(conceptBasename('...', new Date(2026, 9, 8, 9, 1, 2)), 'concept-20261008-090102');
  await fs.mkdir(dir); await put(path.join(dir, '心理表征.txt'), 'keep'); await put(path.join(dir, '心理表征-3.txt'), 'keep3');
  const saved = await saveThink('心理表征', markdown, dir);
  assert.equal(saved, path.join(dir, '心理表征-2.txt')); assert.deepEqual(await fs.readFile(saved), Buffer.from(markdown));
  assert.equal(await fs.readFile(path.join(dir, '心理表征.txt'), 'utf8'), 'keep');
  const paths = await Promise.all([saveThink('parallel', markdown, dir), saveThink('parallel', markdown, dir)]);
  assert.equal(new Set(paths).size, 2);
  await assert.rejects(saveThink('x', markdown, path.join(root, 'missing', 'concept')), { code: 'ENOENT' });
});

async function rollout(config, r, { id = 'main', source = 'exec', time = r.createdAt, name = id, tools = [] } = {}) {
  const file = path.join(config.codexSessionsDir, `rollout-${name}.jsonl`);
  await jsonl(file, [{ type: 'session_meta', payload: { id, timestamp: time, source, cwd: config.launchProject } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: `【CO-AGENT ${r.runId ? '概念多视角 ' + r.runId : '随机概念 ' + r.conceptId}】` }] } },
    ...tools.map(([name, role]) => ({ type: 'response_item', payload: { type: 'function_call', name: `collaboration.${name}`, arguments: JSON.stringify({ agent_type: role }) } })),
  ]); return file;
}
async function child(config, role, { id = 'child', parent = 'main', depth = 1 } = {}) {
  await jsonl(path.join(config.codexSessionsDir, `rollout-${id}.jsonl`), [{ type: 'session_meta', payload: { id, timestamp: instant.toISOString(), source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: role, depth } } } } }]);
}
test('v08 verification requires exec marker, one matching direct child, handles ambiguity/recursion and prefilters old bodies', async t => {
  const { config } = await fixture(t), r = record();
  const old = await rollout(config, r, { name: 'old', time: '2020-01-01T00:00:00Z' });
  await fs.appendFile(old, 'not valid json: old body must not be parsed\n');
  await rollout(config, r, { name: 'interactive', source: 'cli' });
  assert.equal((await verifyConcept(r, config)).state, 'unconfirmed');
  await rollout(config, r); assert.equal((await verifyConcept(r, config)).state, 'unconfirmed');
  await child(config, 'Walvo'); const ok = await verifyConcept(r, config);
  assert.equal(ok.state, 'ok'); assert.equal(ok.children[0].role, 'Walvo'); assert.equal(ok.session.id, 'main');
  await child(config, 'Jadra', { id: 'grandchild', parent: 'child', depth: 2 });
  assert.equal((await verifyConcept(r, config)).state, 'violation');
  await rollout(config, r, { name: 'copy' });
  const ambiguous = await verifyConcept(r, config); assert.equal(ambiguous.state, 'unconfirmed'); assert.match(ambiguous.error, /歧义|多个/);
});

test('v08 perspective verification checks whitelist, exact depth, multiplicity, all spawns before first wait', async t => {
  const { config } = await fixture(t), r = { runId: randomUUID(), createdAt: instant.toISOString(), agents: [{ codexName: 'Walvo' }, { codexName: 'Jadra' }] };
  await rollout(config, r, { tools: [['spawn_agent', 'Walvo'], ['spawn_agent', 'Jadra'], ['wait_agent']] });
  await child(config, 'Walvo'); await child(config, 'Jadra', { id: 'child2' });
  assert.equal((await verifyPerspectives(r, config)).state, 'ok');
  await rollout(config, r, { tools: [['spawn_agent', 'Walvo'], ['wait_agent'], ['spawn_agent', 'Jadra']] });
  const serial = await verifyPerspectives(r, config); assert.equal(serial.state, 'violation'); assert.equal(serial.parallel.state, 'not-parallel');
  await child(config, 'Walvo', { id: 'extra' }); assert.equal((await verifyPerspectives(r, config)).state, 'violation');
});

function spawnOutput(value, calls, { code = 0, signal = null, hang = false, malformed = false } = {}) {
  return (exe, args, options) => {
    const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 12345;
    const call = { exe, args, options, child: c, prompt: '' }; calls.push(call);
    c.stdin.on('data', chunk => { call.prompt += chunk; });
    c.stdin.on('finish', async () => {
      if (hang) return;
      await fs.writeFile(args[args.indexOf('-o') + 1], malformed ? 'broken' : JSON.stringify(value));
      c.stdout.write('{"type":"thread.started","thread_id":"main"}\n'); c.stderr.write('fixture stderr'); c.emit('close', code, signal);
    });
    return c;
  };
}
test('v08 runner uses sanitized hidden shell:false spawn, schema/work files and stdin', async t => {
  const { config } = await fixture(t), calls = [], r = record();
  config.concept = { timeoutMs: 1000 };
  const value = await runConceptProcess(r, config, { spawnImpl: spawnOutput(result, calls), env: { PATH: 'keep', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(value, { ...result, response: null, responseError: null }); const c = calls[0];
  assert.equal(c.options.shell, false); assert.equal(c.options.windowsHide, true); assert.equal(c.options.cwd, config.launchProject);
  assert.equal(c.options.env.CLAUDECODE, undefined); assert.equal(c.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(c.prompt, conceptPrompt(r)); assert.ok(!c.args.some(a => a.includes('你是协调者')));
  const dir = path.join(config.dataDir, 'concepts/work', r.conceptId);
  assert.equal(await fs.readFile(path.join(dir, 'prompt.txt'), 'utf8'), c.prompt);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'schema.json'))).additionalProperties, false);
});
for (const [label, value, options, match] of [
  ['exit', result, { code: 3 }, /退出码 3/], ['signal', result, { signal: 'SIGTERM' }, /SIGTERM/],
  ['json', result, { malformed: true }, /JSON/], ['shape', { ...result, sourceRefs: [3] }, {}, /格式/],
  ['extra', { ...result, surprising: true }, {}, /格式/],
]) test(`v08 runner rejects ${label}`, async t => {
  const { config } = await fixture(t); config.concept = { timeoutMs: 1000 };
  await assert.rejects(runConceptProcess(record(), config, { spawnImpl: spawnOutput(value, [], options) }), match);
});
test('v08 timeout/abort waits for whole process-tree termination and kill uses PID not name', async t => {
  const { config } = await fixture(t); config.concept = { timeoutMs: 10 }; let killed = false;
  await assert.rejects(runConceptProcess(record(), config, { spawnImpl: spawnOutput(result, [], { hang: true }), killTree: async c => { assert.equal(c.pid, 12345); killed = true; } }), /超时/);
  assert.equal(killed, true);
  const calls = [];
  await killProcessTree({ pid: 12345 }, { platform: 'win32', spawnImpl: (exe, args, options) => {
    calls.push({ exe, args, options }); const c = new EventEmitter(); queueMicrotask(() => c.emit('close', 0)); return c;
  } });
  assert.deepEqual(calls[0].args, ['/PID', '12345', '/T', '/F']); assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.shell, false);
  assert.ok(!calls[0].args.includes('/IM'));
});

test('v08 manual generation lock, archives unconfirmed results and THINK failures independently', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const { config, engine } = await setup(t, { runner: () => pending });
  const { conceptId } = await engine.startManual({ kind: 'manual' });
  await assert.rejects(engine.startManual({ kind: 'manual' }), e => e.status === 409 && e.message === '正在生成' && e.running.conceptId === conceptId);
  config.concept.thinkDir = path.join(config.dataDir, 'nonexistent', 'concept');
  finish(result); await engine.idle();
  const stored = await engine.get(conceptId);
  assert.equal(stored.status, 'done'); assert.deepEqual(stored.result, { ...result, response: null }); assert.equal(stored.verify.state, 'unconfirmed');
  assert.equal(stored.thinkFile, null); assert.match(stored.thinkError, /ENOENT/);
  assert.equal((await engine.list()).running, null); assert.ok((await fs.readFile(path.join(config.dataDir, 'logs/concepts.log'), 'utf8')).includes(conceptId));
});
test('v08 duplicate concept names fail without silently retaining a repeated lesson', async t => {
  const { engine } = await setup(t, { randomIntImpl: () => 0 });
  const one = await engine.startManual({ kind: 'manual' }); await engine.idle();
  // Three eligible agents are used in rotation before falling back to the first.
  await engine.startManual({ kind: 'manual' }); await engine.idle();
  await engine.startManual({ kind: 'manual' }); await engine.idle();
  const four = await engine.startManual({ kind: 'manual' }); await engine.idle();
  assert.equal((await engine.get(one.conceptId)).status, 'done'); assert.equal((await engine.get(four.conceptId)).status, 'failed');
  assert.match((await engine.get(four.conceptId)).error, /重复/);
});
test('v08 ensureDaily Shanghai cutoff, concurrency, two retries maximum, no catch-up before 08:55', async t => {
  assert.deepEqual(shanghaiTime(new Date('2026-10-07T16:00:00Z')), { day: '2026-10-08', minutes: 0 });
  let attempts = 0; const { engine } = await setup(t, { dailyRetryDelayMs: 0, runner: async () => { attempts++; throw Error('fixture failure'); } });
  assert.equal((await engine.ensureDaily(new Date('2026-10-08T00:54:59Z'))).status, 'not-due'); assert.equal(attempts, 0);
  await Promise.all([engine.ensureDaily(new Date('2026-10-08T00:55:00Z')), engine.ensureDaily(instant)]);
  await engine.idle(); assert.equal(attempts, 1);
  await engine.ensureDaily(instant); await engine.idle(); assert.equal(attempts, 2);
  await engine.ensureDaily(instant); await engine.idle(); assert.equal(attempts, 3);
  const last = await engine.ensureDaily(instant); assert.equal(last.status, 'failed'); assert.equal(attempts, 3);
  const list = await engine.list(); assert.equal(list.today.day, '2026-10-08'); assert.equal(list.today.status, 'failed');
  assert.equal(Math.max(...list.items.map(i => i.attempt)), 3);
});
test('v08 recovery fails interrupted running/queued and perspectives, retains live process lock', async t => {
  const { config, engine } = await setup(t, { isAlive: pid => pid === 999 });
  const dead = { ...record(), status: 'running', kind: 'daily', day: '2026-10-08', attempt: 1, pid: 123, perspectives: [{ runId: randomUUID(), status: 'running', pid: 123 }] };
  const live = { ...record(), status: 'running', kind: 'manual', pid: 999, perspectives: [] };
  for (const r of [dead, live]) await put(path.join(config.dataDir, 'concepts', r.conceptId + '.json'), JSON.stringify(r));
  await engine.recover(); assert.equal((await engine.get(dead.conceptId)).error, '进程中断');
  assert.equal((await engine.get(dead.conceptId)).perspectives[0].error, '进程中断');
  assert.equal((await engine.get(live.conceptId)).status, 'running');
  await assert.rejects(engine.startManual({ kind: 'manual' }), { status: 409 });
});
test('v08 perspectives validates confirmations, other-agent whitelist, one run per concept, permits generation concurrently', async t => {
  let release; const { engine } = await setup(t, { perspectiveRunner: () => new Promise(resolve => { release = resolve; }),
    perspectiveVerifier: async () => ({ state: 'ok', parallel: { state: 'ok' }, violations: [] }) });
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.idle();
  for (const agentIds of [[], ['walvo'], ['jadra','jadra'], ['unknown'], Array(9).fill('jadra')]) await assert.rejects(engine.startPerspectives(conceptId, { agentIds }), { status: 400 });
  const { runId } = await engine.startPerspectives(conceptId, { agentIds: ['jadra'] });
  await assert.rejects(engine.startPerspectives(conceptId, { agentIds: ['peter'] }), { status: 409 });
  await engine.startManual({ kind: 'manual' });
  while (!release) await tick(); release({ results: [{ agent: 'jadra', analysis: '分析原文' }] }); await engine.idle();
  const run = (await engine.get(conceptId)).perspectives[0]; assert.equal(run.runId, runId); assert.equal(run.status, 'done'); assert.equal(run.results[0].agentId, 'jadra');
});

test('v08 config defaults and nested validation preserve unrelated settings', async t => {
  const { root } = await fixture(t), dataDir = path.join(root, 'configdata');
  const read = () => loadConfig({ env: { CO_AGENT_DATA_DIR: dataDir }, home: root });
  assert.deepEqual((await read()).concept, { timeoutMs: 2400000, thinkDir: null, autoDaily: false }, 'v0.50: no copy and no catch-up unless configured');
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ concept: { timeoutMs: 123 } }));
  assert.equal((await read()).concept.timeoutMs, 123); assert.equal((await read()).codexModel, null);
  for (const concept of [null, [], { timeoutMs: 0 }, { timeoutMs: 3000001 }, { thinkDir: '' }, { thinkDir: path.resolve('src') }]) {
    await put(path.join(dataDir, 'config.json'), JSON.stringify({ concept })); await assert.rejects(read(), /concept|只读|仓库/);
  }
});

test('v08 API auth, 202/409, detail/limit validation and catch-up timer with injected engine', async t => {
  const { config } = await fixture(t), calls = []; let timerFn, cleared;
  const concepts = { recover: async () => calls.push('recover'), ensureDaily: async () => calls.push('daily'),
    list: async limit => ({ items: [], running: null, today: { day: '2026-10-08', conceptId: null, status: null }, limit }),
    get: async id => ({ conceptId: id }), startManual: async () => { if (calls.includes('start')) throw Object.assign(Error('正在生成'), { status: 409, running: { conceptId: 'running' } }); calls.push('start'); return { conceptId: 'new' }; },
    startPerspectives: async (id, body) => ({ runId: id + body.agentIds[0] }), close: async () => calls.push('close'), idle: async () => {},
  };
  const app = await createApp(config, { registryBuilder: async () => ({ agents: [] }), conceptsFactory: () => concepts,
    conceptTimers: { setInterval: (fn, ms) => { assert.equal(ms, 600000); timerFn = fn; return { unref() {} }; }, clearInterval: () => { cleared = true; } } });
  await app.listen(); t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-co-agent-token': app.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/concepts', { kind: 'manual' }, { 'x-co-agent-token': 'wrong' })).status, 403);
  assert.equal((await post('/api/concepts', { kind: 'manual' }, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await post('/api/concepts', { kind: 'manual' })).status, 202);
  const conflict = await post('/api/concepts', { kind: 'manual' }); assert.equal(conflict.status, 409); assert.deepEqual((await conflict.json()).running, { conceptId: 'running' });
  assert.equal((await (await fetch(url + '/api/concepts?limit=12')).json()).limit, 12);
  assert.equal((await (await fetch(url + '/api/concepts/abc')).json()).conceptId, 'abc');
  assert.equal((await post('/api/concepts/abc/perspectives', { agentIds: ['jadra'] })).status, 202);
  assert.equal(calls.filter(c => c === 'daily').length, 1); await timerFn(); assert.equal(calls.filter(c => c === 'daily').length, 2);
  await app.close(); assert.equal(cleared, true);
});

test('v08 confirmations are exact booleans and failed source/writable checks create no run', async t => {
  const { config } = await fixture(t); config.concept = { timeoutMs: 1000, thinkDir: path.join(path.dirname(config.dataDir), 'think') };
  let runs = 0;
  const agents = [book(), { ...book('peter'), kind: 'role', writable: true }, { ...book('jadra'), sources: { missing: ['gone.epub'] } }, { ...book('offline'), platforms: { codex: { available: false } } }];
  const engine = createConcepts(config, () => ({ agents }), { now: () => instant, runner: async () => result,
    conceptVerifier: async () => ({ state: 'unconfirmed' }), perspectiveRunner: async () => { runs++; return { results: [{ agent: 'peter', analysis: 'A' }, { agent: 'jadra', analysis: 'B' }] }; },
    perspectiveVerifier: async () => ({ state: 'violation', parallel: { state: 'not-parallel' }, violations: ['fixture'] }),
  });
  t.after(() => engine.close()); await engine.recover(); const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.idle();
  await assert.rejects(engine.startPerspectives(conceptId, { agentIds: ['offline'] }), e => e.status === 409 && e.unavailable.length === 1);
  await assert.rejects(engine.startPerspectives(conceptId, { agentIds: ['peter'], writableConfirmed: 'true' }), e => e.status === 409 && e.writable.length === 1);
  await assert.rejects(engine.startPerspectives(conceptId, { agentIds: ['jadra'], sourcesConfirmed: 'true' }), /原书/);
  assert.equal((await engine.get(conceptId)).perspectives.length, 0); assert.equal(runs, 0);
  await engine.startPerspectives(conceptId, { agentIds: ['peter', 'jadra'], writableConfirmed: true, sourcesConfirmed: true }); await engine.idle();
  const saved = (await engine.get(conceptId)).perspectives[0]; assert.equal(saved.status, 'done'); assert.equal(saved.verify.state, 'violation'); assert.equal(saved.results.length, 2);
});

test('v08 generation output and structure violations remain visible with exact THINK bytes after restart', async t => {
  const { config, engine } = await setup(t, { conceptVerifier: async () => { throw Error('unreadable rollout'); } });
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.idle();
  const r = await engine.get(conceptId); assert.equal(r.status, 'done'); assert.equal(r.verify.state, 'unconfirmed'); assert.match(r.verify.error, /unreadable/);
  assert.deepEqual(await fs.readFile(r.thinkFile), Buffer.from(markdown));
  const restarted = createConcepts(config, () => ({ agents: [book()] }), { now: () => instant, runner: async () => { throw Error('must not run'); } });
  t.after(() => restarted.close()); await restarted.recover(); assert.deepEqual(await restarted.get(conceptId), r);
  for (const limit of [0, -1, 201, 1.5, NaN, Infinity]) await assert.rejects(restarted.list(limit), { status: 400 });
  for (const id of ['../config', 'not-uuid', randomUUID()]) await assert.rejects(restarted.get(id), { status: 404 });
});

test('v08 daily completed record suppresses repeats, manual contention defers, next Shanghai day can run', async t => {
  let finish, attempts = 0;
  const { engine } = await setup(t, { runner: async () => {
    attempts++; if (attempts === 1) return new Promise(resolve => { finish = resolve; });
    const concept = attempts === 2 ? '概念乙' : '概念丙';
    return { ...result, concept, conceptEn: null, term: { zh: concept, en: 'New concept', fr: 'Nouveau concept' } };
  } });
  await engine.startManual({ kind: 'manual' });
  assert.equal((await engine.ensureDaily(instant)).status, 'busy');
  while (!finish) await tick(); finish(result); await engine.idle();
  assert.equal((await engine.ensureDaily(instant)).status, 'done');
  assert.equal((await engine.ensureDaily(instant)).status, 'exists'); assert.equal(attempts, 2);
  assert.equal((await engine.ensureDaily(new Date('2026-10-09T01:00:00Z'))).status, 'done'); assert.equal(attempts, 3);
});

test('v08 runner abort, spawn/stdin errors and output bounds terminate the exact tree', async t => {
  const { config } = await fixture(t); config.concept = { timeoutMs: 1000 };
  for (const scenario of ['abort', 'spawn', 'stdin', 'stdout', 'stderr']) {
    const controller = new AbortController(), calls = []; let kills = 0;
    const promise = runConceptProcess(record(), config, { signal: controller.signal,
      spawnImpl: (...args) => {
        const child = spawnOutput(result, calls, { hang: true })(...args);
        setImmediate(() => {
          if (scenario === 'abort') controller.abort();
          if (scenario === 'spawn') child.emit('error', Error('spawn failed'));
          if (scenario === 'stdin') child.stdin.emit('error', Error('stdin failed'));
          if (scenario === 'stdout') child.stdout.write('x'.repeat(10 * 1024 * 1024 + 1));
          if (scenario === 'stderr') child.stderr.write('x'.repeat(1024 * 1024 + 1));
        }); return child;
      }, killTree: async child => { assert.equal(child.pid, 12345); kills++; },
    });
    await assert.rejects(promise, /进程中断|spawn failed|stdin failed|超过/); assert.equal(kills, 1);
  }
  let spawned = false; const c = new AbortController(); c.abort();
  await assert.rejects(runConceptProcess(record(), config, { signal: c.signal, spawnImpl: () => { spawned = true; } }), /进程中断/); assert.equal(spawned, false);
});

test('v08 THINK refuses directory symlinks and catches readback mismatches', async t => {
  const { root } = await fixture(t), actual = path.join(root, 'actual'), link = path.join(root, 'link');
  await fs.mkdir(actual);
  const io = { ...fs, lstat: async file => file === link ? { isSymbolicLink: () => true } : fs.lstat(file),
    writeFile: async () => assert.fail('拒绝链接目录后不得写文件') };
  await assert.rejects(saveThink('refuse', markdown, link, { io }), /链接/); assert.deepEqual(await fs.readdir(actual), []);
  await assert.rejects(saveThink('bad', markdown, actual, { io: { ...fs, readFile: async () => Buffer.from('different') } }), /回读/);
});

test('v08 failed tree kill preserves a live generation lock until recovery proves it exited', async t => {
  let alive = true;
  const { engine } = await setup(t, { isAlive: () => alive, runner: async () => { throw Object.assign(Error('tree kill failed'), { processMayBeAlive: true, pid: 12345 }); } });
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.idle();
  assert.equal((await engine.get(conceptId)).status, 'running');
  await assert.rejects(engine.startManual({ kind: 'manual' }), { status: 409 });
  alive = false; await engine.recover(); assert.equal((await engine.get(conceptId)).status, 'failed');
});

test('v08 prefilter never reads old or non-exec rollout bodies and preserves exact five-minute boundary', async t => {
  const { config } = await fixture(t), r = record(), read = [];
  const old = await rollout(config, r, { id: 'old', time: new Date(instant.getTime() - 300001).toISOString() });
  const cli = await rollout(config, r, { id: 'cli', source: 'cli' });
  const main = await rollout(config, r, { time: new Date(instant.getTime() - 300000).toISOString() }); await child(config, 'Walvo');
  const value = await verifyConcept(r, config, { io: { ...fs, readFile: async (...args) => { read.push(args[0]); return fs.readFile(...args); } } });
  assert.equal(value.state, 'ok'); assert.deepEqual(read, [main]); assert.ok(!read.includes(old)); assert.ok(!read.includes(cli));
});

test('v08 real HTTP routes archive and reload an injected process result, rejecting invalid bodies and IDs', async t => {
  const { root, config } = await fixture(t); config.concept = { timeoutMs: 1000, thinkDir: path.join(root,'think') };
  const app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents: [book(),book('jadra')] }),
    conceptOptions: { now: () => instant, randomIntImpl: () => 0, spawnImpl: spawnOutput(result, []),
      perspectiveRunner: async () => ({ results: [{ agent: 'jadra', analysis: '跨视角分析原文' }] }),
    } });
  await app.listen(); t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`, post = (route, body) => fetch(url + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-co-agent-token': app.token, origin: url }, body: JSON.stringify(body),
  });
  for (const body of [null, {}, { kind: 'daily' }]) assert.equal((await post('/api/concepts', body)).status, 400);
  assert.equal((await fetch(url + '/api/concepts?limit=0')).status, 400);
  assert.equal((await fetch(url + '/api/concepts/not-a-uuid')).status, 404);
  const response = await post('/api/concepts', { kind: 'manual' }); assert.equal(response.status, 202);
  const { conceptId } = await response.json(); await app.concepts.idle();
  const saved = await (await fetch(url + '/api/concepts/' + conceptId)).json();
  assert.equal(saved.status, 'done'); assert.equal(saved.verify.state, 'unconfirmed'); assert.deepEqual(saved.result, { ...result, response: null });
  assert.deepEqual(await fs.readFile(saved.thinkFile), Buffer.from(markdown));
  assert.equal((await (await fetch(url + '/api/concepts?limit=1')).json()).items[0].result.concept, result.concept);
  assert.equal((await post(`/api/concepts/${conceptId}/perspectives`, { agentIds: ['jadra'] })).status, 202);
  await app.concepts.idle(); assert.equal((await app.concepts.get(conceptId)).perspectives[0].results[0].analysis, '跨视角分析原文');
});

for (const [label, results] of [
  ['missing', []], ['duplicate', [{ agent: 'Jadra', analysis: 'A' }, { agent: 'Jadra', analysis: 'B' }]],
  ['foreign', [{ agent: 'foreign', analysis: 'A' }]], ['empty', [{ agent: 'Jadra', analysis: '' }]],
]) test(`v08 perspective process rejects ${label} output without invented agent results`, async t => {
  const { config } = await fixture(t); config.concept = { timeoutMs: 1000 };
  const run = { runId: randomUUID(), agents: [{ id: 'jadra', name: 'Jadra', codexName: 'Jadra' }] };
  await assert.rejects(runConceptProcess(run, config, { concept: record(), spawnImpl: spawnOutput({ results }, []) }), /格式|名单/);
});

test('v08 shutdown cancels owned generation, persists interruption and releases handles', async t => {
  const { engine } = await setup(t, { runner: (_record, _config, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(Error('进程中断'));
    else signal.addEventListener('abort', () => reject(Error('进程中断')), { once: true });
  }) });
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.close();
  assert.equal((await engine.get(conceptId)).status, 'failed'); assert.match((await engine.get(conceptId)).error, /进程中断/);
  await assert.rejects(engine.startManual({ kind: 'manual' }), { status: 409 });
});
