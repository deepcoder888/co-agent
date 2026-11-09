import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { codexArgs } from '../src/launch/codex.mjs';
import { jointArgs } from '../src/joint/spec.mjs';
import { resumeArgs, verifyResume } from '../src/launch/resume.mjs';
import { verifyJoint } from '../src/joint/verify.mjs';
import { recommendationArgs } from '../src/recommend/runner.mjs';
import { readSettings } from '../src/settings.mjs';
import { parseHub } from '../src/stats/hub.mjs';

const member = (id, extra = {}) => ({ id, name: id, kind: 'role', tags: [], primary: '功能性 Agent', description: '用途',
  platforms: { claude: { available: true, name: id }, codex: { available: true } }, ...extra });
const input = '请独立分析\n原文 $() ` & <img> 中文';
async function harness(t) {
  let app; t.after(() => app?.close());
  const { config, root } = await fixture(t), calls = [];
  const agents = [member('Walvo'), member('Peter', { writable: true }), member('Jadra', { sources: { missing: ['missing.epub'] } }),
    member('absent', { platforms: { claude: { available: false, reason: '未安装' }, codex: { available: false } } })];
  const registry = { agents, categories: [], sources: [], summary: {} };
  app = await createApp(config, { conceptAutoDaily: false, spawnImpl: fakeSpawner(calls), registryBuilder: async () => registry });
  await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, body, token = app.token) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const record = async (type, id) => JSON.parse(await fs.readFile(path.join(config.dataDir, type === 'joint' ? 'joints' : 'launches', `${id}.json`), 'utf8'));
  return { config, root, app, calls, agents, request, record };
}
test('v07 F29 manual validation, confirmations, token and durable template/source', async t => {
  const h = await harness(t), body = { source: 'manual', agentIds: ['Walvo'], input, cli: 'claude' };
  assert.equal((await h.request('/api/joint', body, '')).status, 403);
  for (const change of [{ input: undefined }, { input: '' }, { input: ' '.repeat(3) }, { input: 'a'.repeat(8001) },
    { agentIds: [] }, { agentIds: Array.from({ length: 9 }, (_, i) => String(i)) }, { agentIds: ['Walvo', 'Walvo'] }, { agentIds: ['unknown'] }, { source: 'bad' }])
    assert.equal((await h.request('/api/joint', { ...body, ...change })).status, 400, JSON.stringify(change));
  for (const id of ['absent', 'Peter', 'Jadra']) assert.equal((await h.request('/api/joint', { ...body, agentIds: [id] })).status, 409, id);
  assert.equal(h.calls.length, 0);
  const response = await h.request('/api/joint', { ...body, agentIds: ['Walvo', 'Peter', 'Jadra'], writableConfirmed: true, sourcesConfirmed: true });
  assert.equal(response.status, 200); const record = await h.record('joint', response.value.jointId);
  assert.equal(record.source, 'manual'); assert.equal(record.recommendId, null); assert.equal(record.input, input);
  assert.deepEqual(record.args, jointArgs('claude', record, h.agents.slice(0, 3), h.config, [...h.config.builtinClaudeAgents].sort()));
  assert.equal(h.calls[0].options.shell, false); assert.equal(h.calls[0].options.windowsHide, true);
  assert.equal(h.calls[0].options.env.AH_DISPLAY, 'secondary'); assert.equal(h.calls[0].options.env.AH_MODE, 'fullscreen');
  assert.ok(!h.calls[0].args.some(a => a.includes(input)));
});
test('v07 F29 existing recommendation subset validation and source preserved', async t => {
  const h = await harness(t), id = randomUUID();
  await put(path.join(h.config.dataDir, 'recommend', id, 'record.json'), JSON.stringify({ recommendId: id, status: 'done', input, results: [{ id: 'Walvo' }] }));
  assert.equal((await h.request('/api/joint', { recommendId: id, agentIds: ['Peter'], cli: 'codex' })).status, 400);
  const r = await h.request('/api/joint', { recommendId: id, agentIds: ['Walvo'], cli: 'codex' }); assert.equal(r.status, 200);
  const record = await h.record('joint', r.value.jointId); assert.equal(record.source, 'recommend'); assert.equal(record.recommendId, id);
});
test('v07 F30 history merges all ages, filters, limits, excludes sidecars and validates session file', async t => {
  const h = await harness(t), a = randomUUID(), b = randomUUID(), session = randomUUID(), file = path.join(h.root, 'session.jsonl');
  await put(file, '{}\n');
  await put(path.join(h.config.dataDir, 'launches', `${a}.json`), JSON.stringify({ launchId: a, agentId: 'Walvo', agentName: 'Walvo', cli: 'claude', createdAt: '2020-01-01T00:00:00Z' }));
  await put(path.join(h.config.dataDir, 'joints', `${b}.json`), JSON.stringify({ jointId: b, cli: 'codex', input: '中'.repeat(121), whitelist: [{ id: 'Walvo', codexName: 'Walvo' }], createdAt: '2021-01-01T00:00:00Z' }));
  await put(path.join(h.config.dataDir, 'joints', `${b}.status.json`), JSON.stringify({ overall: 'done', session: { id: session, file } }));
  await put(path.join(h.config.dataDir, 'joints', `${b}.pid`), '9');
  let r = await h.request('/api/history?type=all&limit=50'); assert.equal(r.status, 200);
  assert.deepEqual(r.value.items.map(x => x.id), [b, a]);
  assert.equal(r.value.items[0].inputPreview.length, 120); assert.equal(r.value.items[0].source, 'recommend');
  assert.equal(r.value.items[0].canResume, true); assert.equal(r.value.items[1].canResume, false);
  assert.ok(r.value.items[1].resumeReason); assert.equal(r.value.items[1].inputPreview, undefined);
  assert.deepEqual((await h.request('/api/history?type=launch&limit=50')).value.items.map(x => x.id), [a]);
  assert.deepEqual((await h.request('/api/history?type=joint&limit=1')).value.items.map(x => x.id), [b]);
  for (const query of ['type=bad', 'limit=-1', 'limit=no', 'limit=0', 'limit=1.5']) assert.equal((await h.request(`/api/history?${query}`)).status, 400);
  await fs.rm(file); r = await h.request('/api/history'); assert.equal(r.value.items[0].canResume, false);
  assert.equal(h.calls.length, 0);
});
test('v07 F30 rerun new records, exact original input, and fresh confirmation/registry checks', async t => {
  const h = await harness(t);
  const launch = (await h.request('/api/launch', { agentId: 'Walvo', cli: 'codex' })).value;
  const joint = (await h.request('/api/joint', { source: 'manual', agentIds: ['Peter', 'Jadra'], input, cli: 'claude', writableConfirmed: true, sourcesConfirmed: true })).value;
  assert.equal((await h.request('/api/history/rerun', { type: 'launch', id: launch.launchId }, '')).status, 403);
  assert.equal((await h.request('/api/history/rerun', { type: 'joint', id: joint.jointId })).status, 409);
  const l = await h.request('/api/history/rerun', { type: 'launch', id: launch.launchId }); assert.equal(l.status, 200); assert.notEqual(l.value.launchId, launch.launchId);
  assert.equal((await h.record('launch', l.value.launchId)).rerunOf, launch.launchId);
  const j = await h.request('/api/history/rerun', { type: 'joint', id: joint.jointId, writableConfirmed: true, sourcesConfirmed: true }); assert.equal(j.status, 200);
  const record = await h.record('joint', j.value.jointId); assert.equal(record.rerunOf, joint.jointId); assert.equal(record.source, 'manual'); assert.equal(record.recommendId, null); assert.equal(record.input, input);
  const firstLaunch = await h.record('launch', launch.launchId), newLaunch = await h.record('launch', l.value.launchId);
  const originalEvent = (await parseHub(firstLaunch.specFile)).events, rerunEvent = (await parseHub(newLaunch.specFile)).events;
  assert.equal(originalEvent.length, 1); assert.equal(rerunEvent.length, 1); assert.notEqual(originalEvent[0].key, rerunEvent[0].key);
  h.app.stats.setAgents(h.app.registry.agents.map(a => ({ ...a, id: a.id.toLowerCase() })));
  await h.app.stats.refresh();
  assert.equal(h.app.stats.snapshot().perAgent.walvo.launches.total, 2);
  h.agents[0].platforms.codex.available = false;
  assert.equal((await h.request('/api/history/rerun', { type: 'launch', id: launch.launchId })).status, 409);
  for (const body of [null, { type: 'bad', id: launch.launchId }, { type: 'joint', id: '../../outside' }]) assert.equal((await h.request('/api/history/rerun', body)).status, 400);
});
test('v07 single rerun rechecks newly writable and missing sources without mutating the original', async t => {
  const h = await harness(t), response = await h.request('/api/launch', { agentId: 'Walvo', cli: 'claude' });
  const id = response.value.launchId, before = await h.record('launch', id); h.app.registry.agents[0].writable = true; h.app.registry.agents[0].sources = { missing: ['book.epub'] };
  assert.equal((await h.request('/api/history/rerun', { type: 'launch', id })).status, 409);
  assert.equal((await h.request('/api/history/rerun', { type: 'launch', id, writableConfirmed: true })).status, 409);
  const after = await h.request('/api/history/rerun', { type: 'launch', id, writableConfirmed: true, sourcesConfirmed: true }); assert.equal(after.status, 200);
  assert.deepEqual(await h.record('launch', id), before); assert.equal(h.calls.length, 2);
});
test('v07 joint resume rejects missing evidence, unavailable members, stale scope and absent confirmations', async t => {
  const h = await harness(t), id = (await h.request('/api/joint', { source: 'manual', agentIds: ['Walvo'], input, cli: 'claude' })).value.jointId;
  const body = { type: 'joint', id };
  assert.equal((await h.request('/api/resume', body, '')).status, 403);
  assert.equal((await h.request('/api/resume', body)).status, 409);
  const record = await h.record('joint', id), file = path.join(h.root, 'resumable.jsonl'); await jsonl(file, [{ sessionId: record.sessionId }]);
  await h.app.sessions.register('joint', record, { overall: 'historical', session: { id: record.sessionId, file } });
  h.agents[0].platforms.claude.available = false; assert.equal((await h.request('/api/resume', body)).status, 409);
  h.agents[0].platforms.claude.available = true; h.app.registry.agents[0].writable = true; assert.equal((await h.request('/api/resume', body)).status, 409);
  h.app.registry.agents[0].sources = { missing: ['absent'] }; assert.equal((await h.request('/api/resume', { ...body, writableConfirmed: true })).status, 409);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.request('/api/resume', { ...body, writableConfirmed: true, sourcesConfirmed: true })).status, 200);
});
for (const cli of ['claude', 'codex']) test(`v07 F30 ${cli} joint resume exact args, original deny list and baseline verification`, async t => {
  const h = await harness(t);
  // Pin the verifier clock to the record: this checks evidence/argv, not a wall-clock deadline.
  const j = (await h.request('/api/joint', { source: 'manual', agentIds: ['Walvo'], input, cli })).value;
  const original = await h.record('joint', j.jointId), session = randomUUID(), file = path.join(h.root, `${session}.jsonl`);
  await jsonl(file, [cli === 'claude' ? { sessionId: session } : { type: 'session_meta', payload: { id: session } }]);
  await h.app.sessions.register('joint', original, { overall: 'historical', session: { id: session, file } });
  const response = await h.request('/api/resume', { type: 'joint', id: j.jointId }); assert.equal(response.status, 200);
  const resumed = await h.record('joint', response.value.jointId), at = original.args.indexOf('--append-system-prompt');
  const expected = cli === 'claude' ? [...original.args.slice(0, original.args.indexOf('--session-id')), '--resume', session, '--append-system-prompt', original.args[at + 1]] :
    ['resume', session, '--profile', h.config.codexProfile, '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh', '-C', h.config.launchProject];
  assert.deepEqual(resumed.args, expected); assert.equal(resumed.resumeOf, original.jointId); assert.deepEqual(resumed.whitelist, original.whitelist);
  assert.equal(resumed.resumeBaseline.size, (await fs.stat(file)).size);
  const waiting = await verifyResume(resumed, h.config, { isAlive: () => true, now: Date.parse(resumed.createdAt) }); assert.equal(waiting.overall, 'pending');
  await fs.appendFile(file, JSON.stringify({ sessionId: session, type: 'user', message: { content: '追问' } }) + '\n');
  // Await in-flight verification, then request a fresh check of the completed append.
  await h.app.sessions.idle();
  const pollMs = h.config.verifyPollMs;
  try {
    h.config.verifyPollMs = 0;
    assert.equal((await h.app.sessions.check('joint', resumed.jointId)).overall, 'resumed');
  } finally { h.config.verifyPollMs = pollMs; }
});
test('v07 3.5 all Codex argv defaults and config overrides, no global config mutation', async t => {
  const { config, root } = await fixture(t);
  assert.equal(config.codexModel, 'gpt-test'); assert.equal(config.codexEffort, 'xhigh');
  assert.deepEqual(config.recommend.codex, { model: 'gpt-test', effort: 'xhigh' });
  for (const [model, effort] of [['gpt-test', 'xhigh'], ['custom-model', 'low']]) {
    const c = { ...config, codexModel: model, codexEffort: effort }, prefix = ['--profile', c.codexProfile, '-m', model, '-c', `model_reasoning_effort=${effort}`, '-C', c.launchProject];
    assert.deepEqual(codexArgs('Walvo', 'id', c).slice(0, -1), prefix);
    assert.deepEqual(jointArgs('codex', { input, jointId: 'id' }, [member('Walvo')], c).slice(0, -1), prefix);
    assert.deepEqual(resumeArgs({ cli: 'codex', codexProfile: c.codexProfile, cwd: c.launchProject }, 'thread', c), ['resume', 'thread', ...prefix]);
  }
  assert.deepEqual(recommendationArgs('codex', config, 'id', { schema: 's', output: 'o' }), ['exec', '-m', 'gpt-test', '-c', 'model_reasoning_effort="xhigh"', '-s', 'read-only', '--skip-git-repo-check', '--json', '--output-schema', 's', '-o', 'o', '-']);
  await put(path.join(config.dataDir, 'config.json'), JSON.stringify({ codexModel: 'custom', codexEffort: 'low' }));
  const loaded = await loadConfig({ env: { CO_AGENT_DATA_DIR: config.dataDir }, home: root }); assert.equal(loaded.codexModel, 'custom'); assert.equal(loaded.codexEffort, 'low');
});
test('v07 legacy themes map without error or immediate rewrite', async t => {
  const { config } = await fixture(t), file = path.join(config.dataDir, 'settings.json');
  for (const ui of ['classic', 'shadcn', 'tabler', 'dracula']) {
    const bytes = JSON.stringify({ version: 1, ui }); await put(file, bytes); const logs = [];
    assert.equal((await readSettings(config.dataDir, text => logs.push(text))).ui, 'threepane'); assert.equal(logs.length, 0); assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
});
for (const cli of ['claude', 'codex']) test(`v07 ${cli} joint verifier persists real session identity for history`, async t => {
  const { config } = await fixture(t), id = randomUUID(), thread = randomUUID(), createdAt = new Date().toISOString();
  const joint = { jointId: id, sessionId: id, cli, createdAt, pid: process.pid, whitelist: [{ id: 'Walvo', codexName: 'Walvo', claudeName: 'Walvo' }] };
  const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`) : path.join(config.codexSessionsDir, 'rollout-test.jsonl');
  await jsonl(file, cli === 'claude' ? [{ type: 'user', sessionId: id, cwd: config.launchProject, message: { content: `【CO-AGENT 联合调用 ${id}】\n${input}` } }] : [
    { type: 'session_meta', payload: { id: thread, cwd: config.launchProject, timestamp: createdAt } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: `【CO-AGENT 联合调用 ${id}】\n${input}` }] } }]);
  assert.deepEqual((await verifyJoint(joint, config)).session, { id: cli === 'claude' ? id : thread, file });
});
