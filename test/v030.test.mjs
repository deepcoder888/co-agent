import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { verifyJoint, findJointSession } from '../src/joint/verify.mjs';
import { createConcepts } from '../src/concepts/index.mjs';
import { runJsonProcess } from '../src/concepts/runner.mjs';
import { toHistoryView } from '../public/app.js';
import { renderDefaultConcepts } from '../public/layouts/shared.js';
import * as threepane from '../public/layouts/threepane.js';
import * as bento from '../public/layouts/bento.js';
import * as editorial from '../public/layouts/editorial.js';
import * as shelf from '../public/layouts/shelf.js';
import main from '../electron/main.cjs';

const instant = new Date('2026-10-21T01:00:00Z');
const book = (id = 'Book', extra = {}) => ({ id, name: id, kind: 'book', book: { title: '测试书' },
  platforms: { codex: { available: true, name: id } }, sources: { missing: [] }, ...extra });
const sessionRecord = (type, extra = {}) => ({ [type === 'joint' ? 'jointId' : 'launchId']: randomUUID(),
  createdAt: new Date().toISOString(), pid: 4242, cli: 'codex', agentName: 'Book', agentId: 'book',
  whitelist: [{ id: 'book', codexName: 'Book', claudeName: 'book' }], ...extra });
const verified = (overall = 'done') => ({ overall, message: { ready: '已就绪', resumed: '已恢复', done: '已完成' }[overall],
  cwd: { state: 'ok', observed: 'PROJECT' }, agent: { state: 'ok', evidence: ['agent evidence'] }, waiting: { state: 'ok' },
  calls: [{ agent: 'Book', state: 'done', evidence: ['call evidence'] }], session: { id: randomUUID(), file: 'fixture.jsonl' } });

test('v030 3.1 completed joint survives process exit and its message reaches the history view', async t => {
  const { config } = await fixture(t), record = sessionRecord('joint'), evidence = verified();
  config.verifyPollMs = 0;
  const store = createSessions(config, { isAlive: () => false, jointVerifier: async () => structuredClone(evidence) });
  await put(path.join(config.dataDir, 'joints', `${record.jointId}.json`), JSON.stringify(record));
  await store.register('joint', record);
  const status = await store.check('joint', record.jointId);
  assert.equal(status.overall, 'done'); assert.equal(status.process.state, 'exited');
  assert.equal(status.message, '已完成 · 会话已结束'); assert.deepEqual(status.calls, evidence.calls);
  const row = (await store.allHistory()).items[0], view = toHistoryView(row);
  assert.equal(view.statusTone, 'ok'); assert.equal(view.status.message, status.message);
});

for (const overall of ['ready', 'resumed', 'done']) test(`v030 3.1 saved ${overall} retains every evidence field after exit`, async t => {
  const { config } = await fixture(t), record = sessionRecord('launch'), evidence = verified(overall);
  config.verifyPollMs = 0; let alive = true;
  const store = createSessions(config, { isAlive: () => alive, verifier: async () => alive ? structuredClone(evidence)
    : { overall: 'failed', message: '启动失败：进程已退出', reason: '进程已退出', cwd: { state: 'pending' } } });
  await store.register('launch', record);
  await store.check('launch', record.launchId); alive = false;
  for (let i = 0; i < 2; i++) {
    const status = await store.check('launch', record.launchId);
    assert.deepEqual(status, { ...evidence, process: { pid: record.pid, state: 'exited' }, message: `${evidence.message} · 会话已结束` });
    assert.equal(toHistoryView({ status }).statusTone, 'ok');
  }
});

for (const value of [
  { overall: 'pending' },
  { overall: 'failed', message: '启动失败：进程已退出', reason: '进程已退出' },
  { overall: 'failed', message: '恢复失败：进程已退出' },
]) test(`v030 3.1 exit before verification: ${value.message || value.overall}`, async t => {
  const { config } = await fixture(t), record = sessionRecord('launch');
  const store = createSessions(config, { isAlive: () => false, verifier: async () => ({ ...value }) });
  await store.register('launch', record);
  const status = await store.check('launch', record.launchId);
  assert.equal(status.overall, 'failed'); assert.equal(status.message, '进程已退出（未完成核验）');
});

for (const value of [
  { overall: 'failed', message: '工作目录不符', cwd: { state: 'mismatch' } },
  { overall: 'failed', message: '白名单违规', whitelist: { state: 'violation' } },
  { overall: 'failed', calls: [{ state: 'failed' }] },
  { overall: 'unconfirmed', message: '证据文件不可读', evidenceError: 'EACCES' },
]) test(`v030 3.1 independent failure survives exit: ${value.message || 'call failed'}`, async t => {
  const { config } = await fixture(t), record = sessionRecord('joint');
  const store = createSessions(config, { isAlive: () => false, jointVerifier: async () => structuredClone(value) });
  await store.register('joint', record);
  assert.deepEqual(await store.check('joint', record.jointId), { ...value, process: { pid: record.pid, state: 'exited' } });
});

test('v030 3.1 recover repairs recent and old joint exit failures, preserving other archived conclusions', async t => {
  const { config } = await fixture(t), calls = [], evidence = verified();
  const cases = [
    { type: 'joint', repair: true },
    { type: 'joint', repair: true, extra: { createdAt: '2020-01-01T00:00:00Z' } },
    { type: 'joint', outcome: 'unconfirmed', missingSession: true },
    { type: 'joint', outcome: 'throw' },
    { type: 'joint', extra: { closedAt: new Date().toISOString() } },
    { type: 'joint', message: '白名单违规' },
    { type: 'launch' },
    { type: 'joint', extra: { pid: 4243, createdAt: '2020-01-01T00:00:00Z' } },
  ];
  for (const item of cases) {
    item.record = sessionRecord(item.type, item.extra); item.id = item.record.jointId || item.record.launchId;
    item.file = path.join(config.dataDir, item.type === 'joint' ? 'joints' : 'launches', `${item.id}.status.json`);
    item.status = { ...evidence, overall: 'failed', message: item.message || '进程已退出', process: { state: 'exited', pid: item.record.pid } };
    if (item.missingSession) delete item.status.session;
    await put(item.file.replace('.status.json', '.json'), JSON.stringify(item.record));
    await put(item.file, JSON.stringify(item.status));
  }
  const store = createSessions(config, { isAlive: pid => pid === 4243, verifier: async () => assert.fail('launch must not be reverified'),
    jointVerifier: async record => {
      calls.push(record.jointId); const item = cases.find(c => c.id === record.jointId);
      if (item.outcome === 'throw') throw Error('fixture unreadable');
      return item.repair ? structuredClone(evidence) : { overall: item.outcome };
    } });
  await store.recover(); await store.idle();
  assert.deepEqual(new Set(calls), new Set(cases.slice(0, 4).map(c => c.id))); assert.equal(calls.length, 4);
  for (const item of cases) {
    const saved = JSON.parse(await fs.readFile(item.file, 'utf8'));
    // An inconclusive repair is recorded once (new wording); an unreadable log is retried at the next startup.
    assert.deepEqual(saved, item.repair ? { ...evidence, process: item.status.process, message: '已完成 · 会话已结束' }
      : item.outcome === 'unconfirmed' ? { ...item.status, message: '进程已退出（未完成核验）' } : item.status);
  }
});

for (const [name, layout] of [['threepane', threepane], ['bento', bento], ['editorial', editorial], ['shelf', shelf]]) {
  test(`v030 3.1 ${name} history and joint detail display the ended message`, t => {
    const doc = documentFrom('<body><div id="root"></div></body>');
    const ctx = { doc, refs: {}, state: { view: 'history', allAgents: [], detailOpen: false, category: 'all', query: '', jointSelectedIds: [] },
      actions: new Proxy({}, { get: () => () => {} }) };
    ctx.root = layout.render(ctx); doc.getElementById('root').append(ctx.root); t.after(() => ctx.refs.dispose?.());
    const status = { ...verified(), process: { state: 'exited' }, message: '已完成 · 会话已结束',
      parallel: { state: 'ok', evidence: [] }, whitelist: { state: 'ok', deniedAttempts: [], violations: [] } };
    const item = toHistoryView({ id: 'joint-id', type: 'joint', cli: 'codex', createdAt: instant.toISOString(), agents: [book()], status });
    layout.renderHistory(ctx, { items: [item], recent: [item], selected: item, selectedId: 'joint:joint-id', filter: 'all', message: '', busy: false });
    assert.match(doc.getElementById('history-list').textContent, /已完成 · 会话已结束/); assert.equal(item.statusTone, 'ok');
    const target = doc.createElement('section');
    layout.drawJointStatus(doc, target, sessionRecord('joint'), status);
    assert.match(target.textContent, /已完成 · 会话已结束/); assert.match(target.className, /done/);
    const launch = { ...verified('ready'), process: { state: 'exited' }, message: '已就绪 · 会话已结束' };
    layout.renderStatus(doc, target, launch); assert.match(target.textContent, /已就绪 · 会话已结束/);
  });
}

const meta = (id, timestamp, cwd, spawn) => ({ type: 'session_meta', payload: { id, timestamp, cwd,
  source: spawn ? { subagent: { thread_spawn: spawn } } : 'cli' } });
const user = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const tool = (name, args = {}) => ({ type: 'response_item', payload: { type: 'function_call', name: `functions.${name}`, arguments: JSON.stringify(args) } });
async function jointLogs(t) {
  const { config } = await fixture(t), record = sessionRecord('joint', { createdAt: instant.toISOString() });
  const mainId = randomUUID(), conversation = [user(`【CO-AGENT 联合调用 ${record.jointId}】`), tool('spawn_agent', { agent_type: 'Book' }), tool('wait_agent')];
  await jsonl(path.join(config.codexSessionsDir, 'rollout-main.jsonl'), [meta(mainId, record.createdAt, config.launchProject), ...conversation]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-child.jsonl'), [meta(randomUUID(), record.createdAt, config.launchProject,
    { parent_thread_id: mainId, depth: 1, agent_role: 'Book' }), { type: 'event_msg', payload: { type: 'task_complete' } }]);
  return { config, record, mainId, conversation };
}
test('v030 3.2 same marker two days later cannot invalidate a completed joint', async t => {
  const { config, record, mainId, conversation } = await jointLogs(t);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-later.jsonl'), [meta(randomUUID(), new Date(+instant + 2 * 86400000).toISOString(), config.launchProject), ...conversation]);
  const status = await verifyJoint(record, config, { now: +instant + 1000, isAlive: () => false });
  assert.equal(status.overall, 'done'); assert.equal(status.session.id, mainId); assert.equal(status.evidenceError, undefined);
});
test('v030 3.1 recover uses real joint fixture evidence to repair the persisted outcome', async t => {
  const { config, record } = await jointLogs(t);
  const file = path.join(config.dataDir, 'joints', `${record.jointId}.json`), sidecar = file.replace('.json', '.status.json');
  await put(file, JSON.stringify(record));
  await put(sidecar, JSON.stringify({ overall: 'failed', message: '进程已退出', process: { state: 'exited' } }));
  const store = createSessions(config, { isAlive: () => false }); await store.recover(); await store.idle();
  const saved = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.equal(saved.overall, 'done'); assert.equal(saved.message, '已完成 · 会话已结束'); assert.equal(saved.calls[0].state, 'done');
});
test('v030 3.2 two main sessions inside the window remain ambiguous', async t => {
  const { config, record, conversation } = await jointLogs(t);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-copy.jsonl'), [meta(randomUUID(), new Date(+instant + 600000).toISOString(), config.launchProject), ...conversation]);
  assert.match((await verifyJoint(record, config, { now: +instant + 1000, isAlive: () => false })).evidenceError, /多个会话匹配/);
});
for (const [offset, matches] of [[-300001, false], [-300000, true], [600000, true], [600001, false]]) {
  test(`v030 3.2 inclusive time boundary ${offset} ms`, async t => {
    const { config } = await fixture(t), record = sessionRecord('joint', { createdAt: instant.toISOString() });
    await jsonl(path.join(config.codexSessionsDir, 'rollout-boundary.jsonl'), [meta('main', new Date(+instant + offset).toISOString(), config.launchProject), user(`【CO-AGENT 联合调用 ${record.jointId}】`)]);
    assert.equal(!!await findJointSession(record, config), matches);
  });
}

async function conceptEngine(t, { agents = [book()], ...options } = {}) {
  const { config } = await fixture(t);
  const engine = createConcepts(config, () => ({ agents }), { now: () => instant, randomIntImpl: () => 0,
    runner: async () => { throw Error('fixture failure'); }, thinkWriter: async () => assert.fail('unexpected THINK write'),
    termRunner: async () => assert.fail('unexpected term runner'), ...options });
  t.after(() => engine.close()); await engine.recover(); return { config, engine };
}
test('v030 3.3 daily cooldown, restart, exact boundary, deduplicated wait log and three-attempt cap', async t => {
  let at = instant, attempts = 0;
  const options = { now: () => at, runner: async () => { attempts++; throw Error('fixture failure'); } };
  const { config, engine } = await conceptEngine(t, options);
  assert.equal((await engine.ensureDaily()).attempt, 1); await engine.idle();
  at = new Date(+instant + 30 * 60000 - 1);
  const wait = { status: 'retry-wait', retryAt: new Date(+instant + 30 * 60000).toISOString() };
  for (let i = 0; i < 3; i++) assert.deepEqual(await engine.ensureDaily(), wait);
  const logFile = path.join(config.dataDir, 'logs', 'concepts.log');
  assert.equal((await fs.readFile(logFile, 'utf8')).match(/daily retry-wait/g).length, 1); assert.equal(attempts, 1);
  await engine.close();
  const restarted = createConcepts(config, () => ({ agents: [book()] }), options); t.after(() => restarted.close());
  await restarted.recover(); assert.deepEqual(await restarted.ensureDaily(), wait); assert.equal(attempts, 1);
  at = new Date(+instant + 30 * 60000);
  assert.equal((await restarted.ensureDaily()).attempt, 2); await restarted.idle();
  assert.equal((await restarted.ensureDaily()).status, 'retry-wait');
  at = new Date(+instant + 60 * 60000);
  assert.equal((await restarted.ensureDaily()).attempt, 3); await restarted.idle();
  for (let i = 0; i < 2; i++) assert.equal((await restarted.ensureDaily()).status, 'failed');
  at = new Date(+instant + 12 * 3600000); assert.equal((await restarted.ensureDaily()).status, 'failed');
  assert.equal(attempts, 3); assert.equal((await restarted.list()).items.length, 3);
});
test('v030 3.3 retry constants can be injected without real waiting', async t => {
  let at = instant;
  const { engine } = await conceptEngine(t, { now: () => at, dailyRetryDelayMs: 10, dailyMaxAttempts: 2 });
  await engine.ensureDaily(); await engine.idle();
  at = new Date(+instant + 9); assert.equal((await engine.ensureDaily()).status, 'retry-wait');
  at = new Date(+instant + 10); assert.equal((await engine.ensureDaily()).attempt, 2);
  await engine.idle(); assert.equal((await engine.ensureDaily()).status, 'failed');
});
test('v030 3.3 retry-wait headless run closes normally with exit 0 and no windows', async t => {
  const { config } = await fixture(t), calls = [], app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, setPath() {}, setAppUserModelId() {},
    commandLine: { appendSwitch() {} }, whenReady: async () => {}, exit: code => calls.push(['exit', code]), quit: () => assert.fail('quit') });
  await main.createMain({ argv: ['app', '--daily-concept'], env: { CO_AGENT_DATA_DIR: config.dataDir }, log: async text => calls.push(['log', text]),
    electron: { app, BrowserWindow: class { constructor() { assert.fail('window'); } }, Menu: { setApplicationMenu() {} },
      shell: {}, dialog: { showErrorBox: () => assert.fail('dialog') }, session: { defaultSession: {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    importConfig: async () => ({ loadConfig: async () => config }), importServer: async () => ({ startServer: async (_config, options) => {
      assert.equal(options.conceptAutoDaily, false);
      return { exitCode: 0, app: { server: { address: () => ({ port: 12345 }) }, close: async () => calls.push(['close']),
        concepts: { ensureDaily: async () => ({ status: 'retry-wait', retryAt: instant.toISOString() }) } } };
    } }),
  }).ready;
  assert.deepEqual(calls.at(-1), ['exit', 0]); assert.ok(calls.some(c => c[0] === 'close'));
  assert.ok(calls.some(c => c[0] === 'log' && /retry-wait exit=0/.test(c[1])));
});
test('v030 3.3 task trigger repeats hourly for three hours using scheduler substitutes only', async t => {
  const { root } = await fixture(t), runner = path.join(root, 'task-fixture.ps1');
  await put(runner, String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
function New-ScheduledTaskAction { param($Execute,$Argument) @{execute=$Execute;argument=$Argument} }
function New-ScheduledTaskTrigger {
  param([switch]$Daily,[switch]$Once,$At,$RepetitionInterval,$RepetitionDuration)
  [pscustomobject]@{daily=[bool]$Daily;once=[bool]$Once;at=$At;Repetition=if($Once){@{interval=$RepetitionInterval.TotalSeconds;duration=$RepetitionDuration.TotalSeconds}}else{$null}}
}
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances) @{start=[bool]$StartWhenAvailable;battery=[bool]$AllowStartIfOnBatteries;keep=[bool]$DontStopIfGoingOnBatteries;limit=$ExecutionTimeLimit.TotalSeconds;multiple=$MultipleInstances} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) @{user=$UserId;logon=$LogonType;level=$RunLevel} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Principal,[switch]$Force) $script:result=@{name=$TaskName;action=$Action;trigger=$Trigger;settings=$Settings;principal=$Principal;force=[bool]$Force} }
Register-CoDailyTask $env:CO_TEST_ROOT
$script:result | ConvertTo-Json -Depth 8
`);
  const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const actual = JSON.parse(run.stdout);
  assert.equal(actual.trigger.daily, true); assert.equal(actual.trigger.at, '09:00');
  assert.deepEqual(actual.trigger.Repetition, { interval: 3600, duration: 10800 });
  assert.equal(actual.action.execute, path.join(root, 'CO-AGENT.exe')); assert.equal(actual.action.argument, '--daily-concept');
  assert.equal(actual.name, 'CO-AGENT 每日概念'); assert.equal(actual.force, true);
  assert.deepEqual(actual.settings, { start: true, battery: true, keep: true, limit: 3600, multiple: 'IgnoreNew' });
  assert.equal(actual.principal.logon, 'Interactive'); assert.equal(actual.principal.level, 'Limited');
});

for (const [name, rows, stderr, expected] of [
  ['turn.failed without stderr', [{ type: 'turn.failed', error: { message: '额度不足' } }], '', '额度不足'],
  ['last turn.failed wins over later error and stderr', [{ type: 'turn.failed', error: { message: 'old' } }, 'invalid json',
    { type: 'error', message: 'error fallback' }, { type: 'turn.failed', error: { message: 'last turn' } }, { type: 'error', message: 'later error' }], 'stderr', 'last turn'],
  ['last error', [null, 'invalid json', { type: 'error', message: 'old' }, { type: 'error', message: 'last error' }], 'stderr', 'last error'],
  ['stderr message limited to 300 characters', ['invalid json'], 'context: ' + '尾'.repeat(800), 'context: ' + '尾'.repeat(291)],
  ['empty output', [], '', '无错误输出'],
]) test(`v030 3.4 process failure: ${name}`, async t => {
  const { config } = await fixture(t), id = randomUUID(), stdout = rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
  const spawnImpl = (_exe, _args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); child.pid = 4242;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.once('finish', () => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', 1, null); });
    return child;
  };
  await assert.rejects(runJsonProcess({ id, namespace: 'concepts', prompt: 'fixture', schema: {}, label: '概念', timeoutMs: 10000 }, config,
    { spawnImpl, killTree: async () => assert.fail('already exited') }), error => {
    assert.equal(error.message, `概念进程失败（退出码 1）：${expected}`); return true;
  });
  assert.equal(await fs.readFile(path.join(config.dataDir, 'concepts', 'work', id, 'stdout.txt'), 'utf8'), stdout);
  assert.equal(await fs.readFile(path.join(config.dataDir, 'concepts', 'work', id, 'stderr.txt'), 'utf8'), stderr);
});

const warning = '可选书籍 1/10 本：其余原书路径失效或 Codex 不可用';
for (const kind of ['manual', 'daily']) test(`v030 3.5 ${kind} persists 1/10 pool warning in record, list and log`, async t => {
  const agents = Array.from({ length: 10 }, (_, i) => book(`Book${i}`, i === 0 ? {} : i < 5 ? { sourcesOk: false } : { platforms: { codex: { available: false } } }));
  agents.push(book('role', { kind: 'role' }));
  const { config, engine } = await conceptEngine(t, { agents });
  const { conceptId } = kind === 'daily' ? await engine.ensureDaily() : await engine.startManual({ kind }); await engine.idle();
  assert.equal((await engine.get(conceptId)).poolWarning, warning);
  assert.equal((await engine.list()).items[0].poolWarning, warning);
  const saved = JSON.parse(await fs.readFile(path.join(config.dataDir, 'concepts', `${conceptId}.json`), 'utf8'));
  assert.equal(saved.poolWarning, warning);
  assert.equal((await fs.readFile(path.join(config.dataDir, 'logs', 'concepts.log'), 'utf8')).split(warning).length - 1, 1);
});
for (const eligible of [5, 10]) test(`v030 3.5 ${eligible}/10 pool produces no warning, regardless of recent rotation`, async t => {
  const agents = Array.from({ length: 10 }, (_, i) => book(`Book${i}`, i >= eligible ? { sources: { missing: ['missing.epub'] } } : {}));
  const { config, engine } = await conceptEngine(t, { agents });
  for (let i = 0; i < 5; i++) { await engine.startManual({ kind: 'manual' }); await engine.idle(); }
  assert.ok((await engine.list()).items.every(r => !Object.hasOwn(r, 'poolWarning')));
  assert.doesNotMatch(await fs.readFile(path.join(config.dataDir, 'logs', 'concepts.log'), 'utf8'), /可选书籍/);
});

const conceptRecord = () => ({ conceptId: 'today', kind: 'daily', day: '2026-10-21', createdAt: instant.toISOString(), status: 'done',
  agent: { id: 'Book', name: 'Book', title: '测试书' }, result: { concept: '测试', oneLine: '说明', whyUnknown: '原因', sourceRefs: ['第一章'], markdown: '# 正文' },
  verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, perspectives: [] });
for (const [name, layout, css] of [['threepane', threepane, '.concept-notice'], ['bento', bento, '.bento-concept-warning'],
  ['editorial', editorial, '.editorial-concept-warning'], ['shelf', shelf, '.concept-warning']]) {
  test(`v030 3.5 ${name} detail shows, updates and removes the pool warning via DOM`, t => {
    const doc = documentFrom('<body><div id="layout-root"></div></body>');
    doc.createTextNode = text => { const node = doc.createElement('text'); node.textContent = text; return node; };
    const ctx = { doc, refs: {}, state: { view: 'concepts', allAgents: [], detailOpen: false, category: 'all', query: '', jointSelectedIds: [] },
      actions: new Proxy({}, { get: () => () => {} }) };
    ctx.root = layout.render(ctx); doc.getElementById('layout-root').append(ctx.root); t.after(() => ctx.refs.dispose?.());
    const record = conceptRecord(), model = { selected: record, items: [record], today: { day: record.day, conceptId: record.conceptId }, running: null, busy: false, error: '' };
    const warnings = () => doc.querySelectorAll(css).filter(node => node.textContent.startsWith('可选书籍') && !node.closest('[hidden]'));
    layout.renderConcepts(ctx, model); assert.equal(warnings().length, 0);
    record.poolWarning = warning;
    layout.renderConcepts(ctx, model); assert.equal(warnings().length, 1); assert.equal(warnings()[0].textContent, warning);
    record.poolWarning = warning + ' <script>literal</script>';
    layout.renderConcepts(ctx, model); assert.equal(warnings()[0].textContent, record.poolWarning); assert.equal(warnings()[0].querySelector('script'), null);
    record.result = null; record.status = 'running';
    layout.renderConcepts(ctx, model); assert.equal(warnings().length, 1, 'warning is available before generation completes');
    delete record.poolWarning; layout.renderConcepts(ctx, model); assert.equal(warnings().length, 0);
  });
}
test('v030 3.5 shared fallback detail also displays the warning', () => {
  const doc = documentFrom('<body><div id="root"></div></body>');
  doc.createTextNode = text => { const node = doc.createElement('text'); node.textContent = text; return node; };
  const ctx = { doc, root: doc.getElementById('root'), state: { view: 'concepts' }, refs: {}, actions: new Proxy({}, { get: () => () => {} }) };
  const selected = { ...conceptRecord(), poolWarning: warning };
  renderDefaultConcepts(ctx, { selected, items: [selected], today: {}, running: null });
  const panel = doc.getElementById('concepts-panel');
  assert.ok(panel.querySelectorAll('.concept-warning').some(n => n.textContent === warning));
});
