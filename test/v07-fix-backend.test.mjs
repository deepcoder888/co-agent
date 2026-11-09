import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
import { createApp } from '../src/server.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { reverifyHistory } from '../src/launch/reverify.mjs';
import { findJointSession, verifyJoint } from '../src/joint/verify.mjs';

const before = '2026-01-01T00:00:00.000Z', resumedAt = '2026-01-02T00:00:00.000Z';
const after = '2026-01-02T00:00:01.000Z';
const whitelist = [{ id: 'book', codexName: 'Book', claudeName: 'book' }, { id: 'peer', codexName: 'Peer', claudeName: 'peer' }];
const member = (id, name) => ({ id, name, kind: 'role', writable: false,
  platforms: { claude: { available: true, name: id }, codex: { available: true } } });
const cUse = (name, id) => ({ type: 'tool_use', name: 'Agent', id, input: { subagent_type: name } });
const cRow = (type, content, timestamp = after, id = randomUUID()) => ({ type, timestamp, message: { id, content } });
const xUser = text => ({ type: 'response_item', timestamp: after, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const xTool = (name, args = {}) => ({ type: 'response_item', timestamp: after, payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });
const xMeta = (id, cwd, timestamp, spawn) => ({ type: 'session_meta', payload: { id, cwd, timestamp, source: spawn ? { subagent: { thread_spawn: spawn } } : 'cli' } });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function harness(t, setup) {
  let app; t.after(() => app?.close());
  const { config, root } = await fixture(t), calls = [];
  config.verifyPollMs = 60_000;
  const agents = [member('book', 'Book'), member('peer', 'Peer')];
  if (setup) await setup(config);
  app = await createApp(config, { spawnImpl: fakeSpawner(calls), isAlive: () => true,
    jointVerifier: async () => ({ overall: 'pending' }),
    registryBuilder: async () => ({ agents, categories: [], sources: [], summary: {} }) });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  return { app, config, root, calls, agents, request, record: id => read(path.join(config.dataDir, 'joints', `${id}.json`)) };
}

async function resumedFixture(t, cli, variant = 'allowed') {
  const { config } = await fixture(t), sid = randomUUID(), originalId = randomUUID();
  const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${sid}.jsonl`) : path.join(config.codexSessionsDir, 'rollout-main.jsonl');
  const oldRows = cli === 'claude' ? [
    { ...cRow('user', `【CO-AGENT 联合调用 ${originalId}】\n原文中文`, before), sessionId: sid, cwd: config.launchProject },
    cRow('assistant', [cUse(variant === 'allowed' ? 'book' : 'old-outsider', 'old')], before),
  ] : [xMeta(sid, config.launchProject, before), xUser(`【CO-AGENT 联合调用 ${originalId}】\n原文中文`), xTool('spawn_agent', { agent_type: variant === 'allowed' ? 'Book' : 'old-outsider' })];
  // CRLF and multibyte text ensure the resume boundary is measured in bytes.
  await put(file, oldRows.map(JSON.stringify).join('\r\n') + '\r\n');
  await fs.utimes(file, new Date(before), new Date(before));
  const baseline = await fs.stat(file);
  const joint = { jointId: randomUUID(), sessionId: sid, sessionFile: file, resumeOf: originalId,
    resumeBaseline: { size: baseline.size, mtimeMs: baseline.mtimeMs }, createdAt: resumedAt,
    cli, cwd: config.launchProject, pid: process.pid, whitelist };
  if (cli === 'claude' && variant !== 'allowed') {
    await jsonl(path.join(path.dirname(file), sid, 'subagents', 'old.jsonl'), [cRow('assistant', [cUse('old-nested', 'old-nested')], before)]);
  } else if (cli === 'codex') {
    await jsonl(path.join(config.codexSessionsDir, 'rollout-old.jsonl'), [xMeta(randomUUID(), config.launchProject, before, { parent_thread_id: sid, depth: 1, agent_role: variant === 'allowed' ? 'Book' : 'old-outsider' })]);
  }
  if (variant !== 'unchanged') {
    const names = cli === 'claude' ? ['book', 'peer'] : ['Book', 'Peer'];
    if (variant === 'violation' || variant === 'tool-only') names.push('new-outsider');
    const fresh = cli === 'claude' ? [
      { ...cRow('user', '追问'), sessionId: sid, cwd: config.launchProject },
      cRow('assistant', names.map((name, i) => cUse(name, `new-${i}`)), after, 'parallel-message'),
      cRow('user', names.map((_, i) => ({ type: 'tool_result', tool_use_id: `new-${i}`, content: 'done' }))),
    ] : [xUser('追问'), ...names.map(agent_type => xTool('spawn_agent', { agent_type })), xTool('wait_agent')];
    await fs.appendFile(file, fresh.map(JSON.stringify).join('\r\n') + '\r\n');
    if (cli === 'codex') for (const name of names) {
      if (variant === 'tool-only' && name === 'new-outsider') continue;
      await jsonl(path.join(config.codexSessionsDir, `rollout-${name}.jsonl`), [
        xMeta(randomUUID(), config.launchProject, after, { parent_thread_id: sid, depth: 1, agent_role: name }),
        { type: 'event_msg', timestamp: after, payload: { type: 'task_complete' } },
      ]);
    }
    if (variant === 'nested' && cli === 'claude') await fs.appendFile(path.join(path.dirname(file), sid, 'subagents', 'old.jsonl'),
      JSON.stringify(cRow('assistant', [cUse('new-nested', 'new-nested')])) + '\n');
  }
  return { config, joint, file, baseline };
}

for (const cli of ['claude', 'codex']) for (const variant of ['allowed', 'violation', 'before-only']) {
  test(`B1 ${cli} resume ${variant}: segment whitelist, calls, parallel and growth evidence`, async t => {
    const { config, joint, file, baseline } = await resumedFixture(t, cli, variant);
    // Exercise history dispatch, not only the verifier in isolation.
    const sessions = createSessions(config, { isAlive: () => true });
    await sessions.register('joint', joint);
    const status = await sessions.check('joint', joint.jointId);
    assert.equal(status.whitelist?.state, variant === 'violation' ? 'violation' : 'ok');
    assert.deepEqual(status.calls.map(c => c.state), ['done', 'done']);
    assert.ok(!JSON.stringify(status.whitelist).includes('old-outsider'));
    assert.ok(!JSON.stringify(status.whitelist).includes('old-nested'));
    assert.equal(status.resume?.state, 'ok');
    assert.equal(status.resume.baselineSize, baseline.size);
    assert.equal(status.resume.size, (await fs.stat(file)).size);
    assert.deepEqual(status.session, { id: joint.sessionId, file });
    if (variant === 'violation') {
      assert.equal(status.overall, 'failed');
      assert.ok(status.whitelist.violations.some(v => v.agent === 'new-outsider'));
    } else {
      assert.equal(status.overall, 'resumed'); assert.equal(status.parallel.state, 'ok');
      assert.ok(status.parallel.evidence.length >= 2);
    }
  });
}
test('B1 Codex resume rejects an off-whitelist spawn even before its child rollout exists', async t => {
  const { config, joint } = await resumedFixture(t, 'codex', 'tool-only');
  const status = await verifyJoint(joint, config);
  assert.equal(status.whitelist.state, 'violation'); assert.equal(status.overall, 'failed');
  assert.ok(status.whitelist.violations.some(v => v.agent === 'new-outsider'));
});
test('B1 Codex resume checks actual agent_role even when main spawn arguments claim an allowed agent', async t => {
  const { config, joint } = await resumedFixture(t, 'codex', 'allowed');
  await jsonl(path.join(config.codexSessionsDir, 'rollout-misreported.jsonl'), [xMeta(randomUUID(), config.launchProject, after,
    { parent_thread_id: joint.sessionId, depth: 1, agent_role: 'actual-outsider' })]);
  const status = await verifyJoint(joint, config);
  assert.equal(status.overall, 'failed'); assert.ok(status.whitelist.violations.some(v => v.agent === 'actual-outsider'));
});
test('B1 Claude resume checks only new nested calls in existing child transcripts', async t => {
  const { config, joint } = await resumedFixture(t, 'claude', 'nested');
  const status = await verifyJoint(joint, config);
  assert.equal(status.overall, 'failed');
  assert.deepEqual(status.whitelist.violations.map(v => v.agent), ['new-nested']);
});
for (const cli of ['claude', 'codex']) test(`B1 ${cli} unchanged or truncated file is not resumed`, async t => {
  const { config, joint, file } = await resumedFixture(t, cli, 'unchanged');
  const options = { now: Date.parse(resumedAt), isAlive: () => true };
  let status = await verifyJoint(joint, config, options);
  assert.equal(status.resume?.state, 'pending'); assert.notEqual(status.overall, 'resumed');
  await fs.truncate(file, 0); status = await verifyJoint(joint, config, options);
  assert.notEqual(status.overall, 'resumed'); assert.match(status.evidenceError, /截断/);
});
for (const cli of ['claude', 'codex']) test(`B1 ${cli} mismatched session identity cannot be reported resumed`, async t => {
  const { config, joint, file } = await resumedFixture(t, cli);
  if (cli === 'claude') await fs.appendFile(file, JSON.stringify({ type: 'user', sessionId: randomUUID() }) + '\n');
  else joint.sessionId = randomUUID();
  const status = await verifyJoint(joint, config);
  assert.notEqual(status.overall, 'resumed'); assert.match(status.evidenceError, /会话 ID 改变/);
});
test('B1 single-agent resume still uses verifyResume unchanged', async t => {
  const { config, joint, file } = await resumedFixture(t, 'claude');
  const sessions = createSessions(config, { isAlive: () => true, jointVerifier: async () => assert.fail('joint verifier selected'), verifier: async () => assert.fail('launch verifier selected') });
  const record = { ...joint, launchId: randomUUID() }; delete record.jointId;
  await sessions.register('launch', record);
  const status = await sessions.check('launch', record.launchId);
  assert.equal(status.overall, 'resumed'); assert.equal(status.whitelist, undefined);
  assert.deepEqual(status.session, { id: record.sessionId, file });
});

for (const source of ['manual', 'recommend', 'deleted-recommend', 'failed-recommend']) test(`B2 rerun ${source} retains provenance independently of recommendation state`, async t => {
  const h = await harness(t), recommendId = source === 'manual' ? null : randomUUID(), input = '原始任务\n中文 $() ` &';
  const recommendFile = path.join(h.config.dataDir, 'recommend', recommendId || 'unused', 'record.json');
  if (recommendId) await put(recommendFile, JSON.stringify({ recommendId, status: 'done', input, results: [{ id: 'book' }] }));
  const first = await h.request('/api/joint', recommendId ? { recommendId, agentIds: ['book'], cli: 'codex' } : { source, agentIds: ['book'], input, cli: 'codex' });
  assert.equal(first.status, 200);
  if (source === 'deleted-recommend') await fs.rm(recommendFile);
  if (source === 'failed-recommend') await put(recommendFile, JSON.stringify({ recommendId, status: 'failed', input: 'changed', results: [] }));
  const rerun = await h.request('/api/history/rerun', { type: 'joint', id: first.value.jointId });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.value));
  const record = await h.record(rerun.value.jointId);
  assert.equal(record.source, recommendId ? 'recommend' : 'manual');
  assert.equal(record.recommendId, recommendId); assert.equal(record.rerunOf, first.value.jointId);
  assert.equal(record.input, input); assert.notEqual(record.jointId, first.value.jointId);
  const history = (await h.request('/api/history')).value.items;
  for (const id of [record.jointId, first.value.jointId]) assert.equal(history.find(x => x.id === id).source, record.source);
  assert.equal(h.calls.length, 2);
});
test('B2 recommendation rerun revalidates CURRENT registry and cannot bypass fresh recommendation validation', async t => {
  const h = await harness(t), recommendId = randomUUID();
  await put(path.join(h.config.dataDir, 'recommend', recommendId, 'record.json'), JSON.stringify({ recommendId, status: 'done', input: 'task', results: [{ id: 'book' }] }));
  const first = await h.request('/api/joint', { recommendId, agentIds: ['book'], cli: 'codex' });
  const body = { type: 'joint', id: first.value.jointId };
  const book = h.app.registry.agents[0];
  book.platforms.codex.available = false;
  assert.equal((await h.request('/api/history/rerun', body)).status, 409);
  book.platforms.codex.available = true; book.writable = true;
  assert.equal((await h.request('/api/history/rerun', body)).status, 409);
  book.sources = { missing: ['missing.epub'] };
  assert.equal((await h.request('/api/history/rerun', { ...body, writableConfirmed: true })).status, 409);
  assert.equal((await h.request('/api/history/rerun', { ...body, writableConfirmed: true, sourcesConfirmed: true })).status, 200);
  h.app.registry.agents.splice(0, 1);
  assert.equal((await h.request('/api/history/rerun', body)).status, 400);
  assert.equal((await h.request('/api/joint', { source: 'recommend', recommendId, rerunOf: first.value.jointId, agentIds: ['peer'], cli: 'codex' })).status, 400);
  assert.equal(h.calls.length, 2);
});

async function legacyJoint(config, cli = 'claude', overrides = {}) {
  const id = randomUUID(), record = { jointId: id, cli, whitelist, input: 'legacy task', cwd: config.launchProject,
    createdAt: before, pid: 99999999, ...overrides };
  record.args = cli === 'claude' ? ['--disallowedTools', 'Agent(Explore)', 'Agent(other)', '--session-id', id, '--append-system-prompt', 'original joint instruction'] : ['--profile', 'original-profile', '-C', record.cwd, `【CO-AGENT 联合调用 ${id}】`];
  const status = { overall: 'historical', process: { state: 'exited', pid: 99999999 }, message: 'old message',
    cwd: { state: 'pending' }, calls: [{ agent: 'Book', state: 'done' }], whitelist: { state: 'ok' }, extra: { keep: true } };
  const spec = path.join(config.dataDir, 'joints', `${id}.json`), sidecar = spec.replace('.json', '.status.json');
  await put(spec, JSON.stringify(record)); await put(sidecar, JSON.stringify(status));
  return { record, status, spec, sidecar };
}
async function legacyLog(config, item, { cwd = item.record.cwd, duplicate = false, marker = true, child = false } = {}) {
  const { record } = item, id = record.cli === 'claude' ? record.jointId : randomUUID();
  const file = record.cli === 'claude' ? path.join(config.claudeProjectsDir, duplicate ? 'copy' : 'p', `${id}.jsonl`) : path.join(config.codexSessionsDir, `rollout-${id}.jsonl`);
  const text = marker ? `【CO-AGENT 联合调用 ${record.jointId}】\n原文` : 'unrelated';
  await jsonl(file, record.cli === 'claude' ? [{ type: 'user', cwd, sessionId: id, message: { content: text } }] :
    [xMeta(id, cwd, before, child ? { parent_thread_id: randomUUID(), agent_role: 'Book', depth: 1 } : undefined), xUser(text)]);
  return { id, file };
}
for (const cli of ['claude', 'codex']) test(`B3 legacy ${cli} reverify-all backfills session, preserves sidecar and builds exact resume argv`, async t => {
  const h = await harness(t), item = await legacyJoint(h.config, cli), session = await legacyLog(h.config, item);
  const specBytes = await fs.readFile(item.spec), logBytes = await fs.readFile(session.file);
  const result = await h.request('/api/history/reverify-all', {});
  assert.equal(result.status, 200); assert.deepEqual(result.value.summary, { checked: 1, found: 1, notFound: 0 });
  const status = await read(item.sidecar);
  assert.deepEqual(status.session, session);
  const { session: saved, reverified, ...oldFields } = status; assert.deepEqual(oldFields, item.status);
  assert.equal(reverified.result, 'found');
  assert.equal((await h.request('/api/history')).value.items[0].canResume, true);
  const resumed = await h.request('/api/resume', { type: 'joint', id: item.record.jointId });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
  const record = await h.record(resumed.value.jointId);
  assert.deepEqual(record.args, cli === 'claude' ? ['--disallowedTools', 'Agent(Explore)', 'Agent(other)', '--resume', session.id, '--append-system-prompt', 'original joint instruction'] :
    ['resume', session.id, '--profile', 'original-profile', '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh', '-C', item.record.cwd]);
  assert.deepEqual(await fs.readFile(item.spec), specBytes); assert.deepEqual(await fs.readFile(session.file), logBytes);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.shell, false);
});
for (const cli of ['claude', 'codex']) for (const variant of ['ambiguous', 'missing', 'cwd-mismatch', 'marker-missing']) test(`B3 ${cli} ${variant} stays non-resumable with a precise reason`, async t => {
  const h = await harness(t), item = await legacyJoint(h.config, cli);
  if (variant !== 'missing') await legacyLog(h.config, item, { cwd: variant === 'cwd-mismatch' ? 'D:/wrong' : item.record.cwd, marker: variant !== 'marker-missing' });
  if (variant === 'ambiguous') await legacyLog(h.config, item, { duplicate: true });
  await h.request('/api/history/reverify-all', {});
  const row = (await h.request('/api/history')).value.items[0];
  assert.equal(row.canResume, false);
  assert.match(row.resumeReason, variant === 'ambiguous' ? /多个.*会话.*匹配/ : variant === 'cwd-mismatch' ? /工作目录不符/ : /会话文件不存在/);
  assert.equal((await h.request('/api/resume', { type: 'joint', id: item.record.jointId })).status, 409);
  assert.equal(h.calls.length, 0);
});
test('B3 lazy history backfill is nonblocking, once per record per run; explicit retry remains possible', async t => {
  const h = await harness(t), item = await legacyJoint(h.config);
  await Promise.all(Array.from({ length: 3 }, () => h.request('/api/history'))); await h.app.sessions.idle();
  const status = await read(item.sidecar); assert.equal(status.reverified?.result, 'not-found');
  const bytes = await fs.readFile(item.sidecar);
  await legacyLog(h.config, item);
  for (let i = 0; i < 3; i++) await h.request('/api/history');
  await h.app.sessions.idle(); assert.deepEqual(await fs.readFile(item.sidecar), bytes);
  assert.equal((await h.request('/api/history')).value.items[0].canResume, false);
  await h.request('/api/history/reverify-all', {});
  assert.equal((await h.request('/api/history')).value.items[0].canResume, true);
});
test('B3 lazy history successful backfill appears on the next poll', async t => {
  const h = await harness(t), item = await legacyJoint(h.config, 'codex'); await legacyLog(h.config, item);
  await h.request('/api/history'); await h.app.sessions.idle();
  assert.equal((await h.request('/api/history')).value.items[0].canResume, true);
});
test('B3 lazy response does not wait for a blocked sidecar write and queues only one attempt', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config); await legacyLog(config, item);
  let release, started, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), writing = new Promise(resolve => { started = resolve; });
  const sessions = createSessions(config, { io: { rename: async (...args) => { writes++; started(); await gate; await fs.rename(...args); } } });
  const history = sessions.allHistory();
  try {
    await writing;
    const timeout = AbortSignal.timeout(1000);
    const snapshot = await Promise.race([history, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('history blocked on backfill'))))]);
    assert.equal(snapshot.items[0].canResume, false);
    await sessions.allHistory(); await sessions.allHistory(); assert.equal(writes, 1);
  } finally { release(); await sessions.idle(); }
  assert.equal((await sessions.allHistory()).items[0].canResume, true); assert.equal(writes, 1);
});
test('B3 startup backfills old joints outside recovery window using recorded cwd', async t => {
  let item;
  const h = await harness(t, async config => {
    item = await legacyJoint(config, 'codex'); await legacyLog(config, item);
    config.launchProject = path.join(config.launchProject, 'new-default'); await fs.mkdir(config.launchProject);
  });
  await h.app.sessions.idle(); assert.ok((await read(item.sidecar)).session);
  assert.equal((await h.request('/api/history')).value.items[0].canResume, true);
});
test('B3 reverify-all includes legacy joints whose agents have left the current registry', async t => {
  const h = await harness(t), item = await legacyJoint(h.config); await legacyLog(h.config, item);
  h.app.registry.agents.length = 0;
  assert.deepEqual((await h.request('/api/history/reverify-all', {})).value.summary, { checked: 1, found: 1, notFound: 0 });
  assert.equal((await h.request('/api/history')).value.items[0].canResume, true);
  assert.equal((await h.request('/api/resume', { type: 'joint', id: item.record.jointId })).status, 409);
});
test('B3 recent historical joint cache receives lazy evidence without rerunning live verification', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'claude', { createdAt: new Date().toISOString() });
  await legacyLog(config, item);
  const sessions = createSessions(config, { isAlive: () => true, jointVerifier: async () => assert.fail('historical record reverified live') });
  await sessions.register('joint', item.record, item.status);
  await sessions.allHistory(); await sessions.idle();
  assert.equal((await sessions.allHistory()).items[0].canResume, true);
  const status = await sessions.check('joint', item.record.jointId); assert.ok(status.session);
  assert.equal(status.overall, 'historical'); assert.equal(status.message, item.status.message);
});
test('B3 backfill ignores Codex child markers and keeps existing session evidence byte-identical', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'codex');
  await legacyLog(config, item, { child: true }); const session = await legacyLog(config, item);
  await reverifyHistory(config, ['book']); assert.deepEqual((await read(item.sidecar)).session, session);
  const bytes = await fs.readFile(item.sidecar);
  assert.equal((await reverifyHistory(config, ['book'])).summary.checked, 0);
  assert.deepEqual(await fs.readFile(item.sidecar), bytes);
});
test('B3 sidecar atomic failure preserves old bytes; EXDEV fallback writes only injected dataDir', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config), session = await legacyLog(config, item);
  const bytes = await fs.readFile(item.sidecar), logBytes = await fs.readFile(session.file);
  await assert.rejects(reverifyHistory(config, ['book'], { io: { rename: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }), { code: 'EACCES' });
  assert.deepEqual(await fs.readFile(item.sidecar), bytes);
  let writes = 0;
  await reverifyHistory(config, ['book'], { io: { rename: async (from, to) => {
    assert.equal(path.dirname(to), path.join(config.dataDir, 'joints')); writes++;
    throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
  } } });
  assert.equal(writes, 1); assert.deepEqual((await read(item.sidecar)).session, session);
  assert.deepEqual(await fs.readFile(session.file), logBytes);
  assert.ok(!(await fs.readdir(path.dirname(item.sidecar))).some(name => name.endsWith('.tmp')));
});

test('B4 Codex time prefilter never fully reads old marker rollouts and includes the five-minute boundary', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'codex');
  const cutoff = Date.parse(item.record.createdAt) - 5 * 60_000;
  const oldFile = path.join(config.codexSessionsDir, 'rollout-too-old.jsonl');
  const file = path.join(config.codexSessionsDir, 'rollout-boundary.jsonl'), id = randomUUID();
  const marker = `【CO-AGENT 联合调用 ${item.record.jointId}】`;
  await jsonl(oldFile, [xMeta(randomUUID(), config.launchProject, new Date(cutoff - 1).toISOString()), xUser(marker)]);
  await jsonl(file, [xMeta(id, config.launchProject, new Date(cutoff).toISOString()), xUser(marker)]);
  const fullReads = [];
  const io = { readFile: async (...args) => { fullReads.push(args[0]); return fs.readFile(...args); } };
  const found = await findJointSession(item.record, config, undefined, { io });
  assert.equal(found?.id, id); assert.equal(found?.file, file);
  assert.deepEqual(fullReads, [file], 'old rollouts receive only the metadata header read');
});

test('B4 Codex candidate without the joint id is read raw but its body is never JSON-parsed', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'codex');
  const file = path.join(config.codexSessionsDir, 'rollout-unrelated.jsonl');
  const unrelatedBody = 'B4-unrelated-body: deliberately invalid JSON';
  await put(file, JSON.stringify(xMeta(randomUUID(), config.launchProject, item.record.createdAt)) + '\n' + unrelatedBody + '\n');
  const parse = JSON.parse, bodyParses = [], fullReads = [];
  t.mock.method(JSON, 'parse', function (text, ...args) {
    if (typeof text === 'string' && text.includes('B4-unrelated-body')) bodyParses.push(text);
    return parse.call(this, text, ...args);
  });
  const io = { readFile: async (...args) => { fullReads.push(args[0]); return fs.readFile(...args); } };
  const found = await findJointSession(item.record, config, undefined, { io });
  assert.equal(found, null); assert.deepEqual(fullReads, [file]); assert.deepEqual(bodyParses, []);
});

for (const mode of ['live', 'backfill']) test(`B4 ${mode} shares the time and raw-id filters without losing a valid legacy session`, async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'codex'), session = await legacyLog(config, item);
  const cutoff = Date.parse(item.record.createdAt) - 5 * 60_000;
  await jsonl(path.join(config.codexSessionsDir, 'rollout-too-old.jsonl'), [
    xMeta(randomUUID(), config.launchProject, new Date(cutoff - 1).toISOString()), xUser(`【CO-AGENT 联合调用 ${item.record.jointId}】`),
  ]);
  await put(path.join(config.codexSessionsDir, 'rollout-unrelated.jsonl'),
    JSON.stringify(xMeta(randomUUID(), config.launchProject, item.record.createdAt)) + '\nB4-unrelated-body: invalid JSON\n');
  if (mode === 'live') {
    const status = await verifyJoint(item.record, config, { isAlive: () => true });
    assert.equal(status.evidenceError, undefined); assert.deepEqual(status.session, session);
  } else {
    assert.deepEqual((await reverifyHistory(config, ['book'])).summary, { checked: 1, found: 1, notFound: 0 });
    assert.deepEqual((await read(item.sidecar)).session, session);
  }
});

test('B4 copied rollouts inside the clock-skew window still reject ambiguous matches', async t => {
  const { config } = await fixture(t), item = await legacyJoint(config, 'codex');
  const file = path.join(config.codexSessionsDir, 'rollout-original.jsonl');
  const timestamp = new Date(Date.parse(item.record.createdAt) - 5 * 60_000).toISOString();
  await jsonl(file, [xMeta(randomUUID(), config.launchProject, timestamp), xUser(`【CO-AGENT 联合调用 ${item.record.jointId}】`)]);
  await fs.copyFile(file, path.join(config.codexSessionsDir, 'rollout-copy.jsonl'));
  await assert.rejects(findJointSession(item.record, config), /多个会话匹配/);
});
