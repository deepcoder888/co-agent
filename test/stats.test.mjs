import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';
import { parseClaude } from '../src/stats/claude.mjs';
import { parseCodex, TAIL_BYTES } from '../src/stats/codex.mjs';
import { parseHub } from '../src/stats/hub.mjs';
import { createStats, aggregate } from '../src/stats/index.mjs';
import { loadConfig } from '../src/config.mjs';

const at = '2026-10-06T12:00:00.000Z', now = Date.parse(at);
const agents = [{ id: 'jack', name: '-jack' }, { id: 'harlo', name: 'Harlo' }];
const use = (id, role = '-jack', timestamp = at) => ({ type: 'assistant', timestamp, sessionId: 'main', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', id, input: { subagent_type: role, description: 'synthetic', prompt: 'synthetic' } }] } });
const result = (id, is_error) => ({ type: 'user', timestamp: at, sessionId: 'main', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'synthetic result', ...(is_error === undefined ? {} : { is_error }) }] } });
const user = text => ({ type: 'user', timestamp: at, sessionId: 'main', message: { role: 'user', content: text } });
const meta = (id, spawn = { agent_role: '-Jack', parent_thread_id: 'parent', depth: 1 }, timestamp = at) => ({ type: 'session_meta', payload: { id, timestamp, cwd: 'synthetic', source: spawn === null ? 'cli' : { subagent: { thread_spawn: spawn } }, originator: 'codex-tui', history_mode: 'paginated' } });
const event = type => ({ type: 'event_msg', payload: { type, turn_id: 'synthetic', ...(type === 'turn_aborted' ? { reason: 'interrupted' } : {}) } });
const context = [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'synthetic environment' }] } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for synthetic\n<INSTRUCTIONS>synthetic</INSTRUCTIONS>' }] } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>synthetic</environment_context>' }] } }];

test('S1 Claude streaming tool results: ok/failed/unknown, provenance and bad lines', async t => {
  const { root } = await fixture(t), file = path.join(root, 'main.jsonl');
  await jsonl(file, [user('# AGENTS.md instructions for synthetic\n<INSTRUCTIONS>synthetic</INSTRUCTIONS>'), use('ok'), result('ok'), use('fail'), result('fail', true), use('missing'), use('foreign', 'plugin:worker')]);
  await fs.appendFile(file, '{broken\n');
  const parsed = await parseClaude(file);
  assert.equal(parsed.badLines, 1);
  assert.deepEqual(parsed.events.map(e => e.status), ['ok', 'failed', 'unknown', 'unknown']);
  assert.equal(parsed.events[0].line, 2); assert.equal(parsed.events[0].file, file);
});

test('S1 agent-setting ignores probes, tool results and injected context; real question counts once', async t => {
  const { root } = await fixture(t), file = path.join(root, 'session.jsonl');
  const rows = [{ type: 'agent-setting', agentSetting: 'harlo', sessionId: 'main' }, user('# AGENTS.md instructions for synthetic\n<INSTRUCTIONS>synthetic</INSTRUCTIONS>'), user('<environment_context>synthetic</environment_context>'), result('x'), user('【Agent Hub 启动检查 synthetic】READY')];
  await jsonl(file, rows); assert.equal((await parseClaude(file)).events.length, 0);
  await jsonl(file, [...rows, user('Synthetic real question'), user('Another question')]);
  const parsed = await parseClaude(file); assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, 'session'); assert.equal(parsed.events[0].line, 6);
  assert.equal(parsed.events[0].status, 'ok'); assert.equal(parsed.events[0].at, at);
});

test('S2 Codex roles, empty spawn, parent exclusion and observed terminal events', async t => {
  const { root } = await fixture(t), file = path.join(root, 'rollout-x.jsonl');
  for (const [spawn, terminal, expected] of [[{ agent_role: '-Jack' }, 'task_complete', 'ok'], [{ agent_role: '-Jack' }, 'turn_aborted', 'failed'], [{ agent_role: '-Jack' }, 'token_count', 'unknown'], [{}, 'task_complete', null], [null, 'task_complete', null]]) {
    await jsonl(file, [meta('child', spawn), ...context, event(terminal)]);
    const parsed = await parseCodex(file);
    assert.equal(parsed.events.length, spawn === null ? 0 : 1);
    if (expected) { assert.equal(parsed.events[0].status, expected); assert.equal(parsed.events[0].agentName, '-Jack'); }
    if (spawn && !spawn.agent_role) assert.equal(parsed.events[0].kind, 'unlabeled');
  }
  await jsonl(file, [meta('child'), ...context, event('task_complete'), event('task_started')]);
  assert.equal((await parseCodex(file)).events[0].status, 'unknown');
});

test('S2 only header blocks plus at most last 256 KB read for >1MB rollout', async t => {
  const { root } = await fixture(t), file = path.join(root, 'rollout-big.jsonl');
  const first = JSON.stringify(meta('large')) + '\n';
  await put(file, first + (JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic '.repeat(110000) }] } }) + '\n') + JSON.stringify(event('task_complete')) + '\n');
  const size = (await fs.stat(file)).size, reads = [];
  const parsed = await parseCodex(file, { onRead: r => reads.push(r) });
  assert.ok(size > 1024 * 1024); assert.equal(parsed.events[0].status, 'ok');
  assert.equal(parsed.badLines, 0, 'partial first tail line is not corruption');
  assert.ok(reads.every(r => r.position < Buffer.byteLength(first) + 4096 || r.position >= size - TAIL_BYTES));
  assert.ok(reads.reduce((n, r) => n + r.bytesRead, 0) <= Buffer.byteLength(first) + 4096 + TAIL_BYTES);
  assert.ok(parsed.events[0].statusEvidence.byteOffset > size - TAIL_BYTES);
});

test('S2 corrupt header fails and bad complete tail lines counted; UTF8/CRLF/no final newline', async t => {
  const { root } = await fixture(t), file = path.join(root, 'rollout-x.jsonl');
  await put(file, '{bad\n'); await assert.rejects(parseCodex(file), /session_meta/);
  await put(file, JSON.stringify(meta('child')) + '\r\n{bad}\r\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成中文' }] } }) + '\r\n' + JSON.stringify(event('turn_aborted')));
  const parsed = await parseCodex(file); assert.equal(parsed.badLines, 1); assert.equal(parsed.events[0].status, 'failed');
});

test('S3 launch specs require valid identity/time; launch stays separate', async t => {
  const { root } = await fixture(t), file = path.join(root, 'launch.json');
  await put(file, JSON.stringify({ launchId: 'synthetic', cli: 'codex', agentName: '-jack', createdAt: at, args: ['synthetic'] }));
  const parsed = await parseHub(file); assert.equal(parsed.events[0].kind, 'launch');
  await put(file, JSON.stringify({ launchId: 'bad', agentName: '-jack', createdAt: 'invalid' }));
  await assert.rejects(parseHub(file));
});

async function allDirs(config) { for (const dir of [config.claudeProjectsDir, config.codexSessionsDir, ...config.codexArchiveDirs, path.join(config.dataDir, 'launches')]) await fs.mkdir(dir, { recursive: true }); }
test('S4 source deduplication, child nesting, unknown/outside, launch counts and persistent cache', async t => {
  const { config } = await fixture(t); await allDirs(config);
  await jsonl(path.join(config.claudeProjectsDir, 'p', 'main.jsonl'), [use('same'), result('same')]);
  await jsonl(path.join(config.claudeProjectsDir, 'p', 'main', 'subagents', 'agent-a.jsonl'), [use('same'), use('nested', 'Harlo'), result('nested', true), use('outside', 'plugin:worker')]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-live.jsonl'), [meta('duplicate'), ...context, event('task_complete')]);
  await jsonl(path.join(config.codexArchiveDirs[0], 'rollout-copy.jsonl'), [meta('duplicate'), event('turn_aborted')]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-empty.jsonl'), [meta('empty', {})]);
  await put(path.join(config.dataDir, 'launches', 'l.json'), JSON.stringify({ launchId: 'l', cli: 'claude', agentName: 'jack', createdAt: at }));
  let parses = 0;
  const stats = createStats(config, agents, { now: () => now, onParse: () => parses++ });
  await stats.refresh(); const data = stats.snapshot();
  assert.equal(data.perAgent.jack.total.calls, 2); assert.deepEqual(data.perAgent.jack.total.bySource, { claude: 1, codex: 1 });
  assert.equal(data.perAgent.harlo.total.failed, 1); assert.equal(data.outOfScopeEvents, 1); assert.equal(data.unlabeledSubagents, 1);
  assert.deepEqual(data.perAgent.jack.launches, { last7d: 1, last30d: 1, total: 1 } /* v0.9 adds the 30-day window */);
  assert.equal(data.perAgent.jack.total.ok, 2, 'live duplicate wins');
  const count = parses; await stats.refresh(); assert.equal(parses, count);
  const restored = createStats(config, agents, { now: () => now, onParse: () => parses++ });
  await restored.refresh(); assert.equal(parses, count); assert.deepEqual(restored.snapshot().perAgent, data.perAgent);
  const cache = JSON.parse(await fs.readFile(path.join(config.dataDir, 'stats-index.json'), 'utf8')); assert.equal(cache.version, 1);
});

test('S4 cache retains deleted files and skips caching read failures; malformed cache rebuilt', async t => {
  const { config } = await fixture(t); await allDirs(config); let parses = 0;
  const file = path.join(config.claudeProjectsDir, 'p', 'main.jsonl'); await jsonl(file, [use('one')]);
  const stats = createStats(config, agents, { now: () => now, onParse: () => parses++ });
  await stats.refresh(); await jsonl(file, [use('one'), use('two')]); await stats.refresh();
  assert.equal(parses, 2); assert.equal(stats.snapshot().perAgent.jack.total.calls, 2);
  await fs.unlink(file); await stats.refresh(); assert.equal(stats.snapshot().perAgent.jack.total.calls, 2);
  const retained = JSON.parse(await fs.readFile(path.join(config.dataDir, 'stats-index.json'), 'utf8')).files;
  assert.equal(Object.keys(retained).length, 1); assert.equal(retained[file].retained, true);
  const broken = path.join(config.codexSessionsDir, 'rollout-bad.jsonl');
  await put(broken, '{broken\n'); await fs.utimes(broken, new Date(now), new Date(now)); await stats.refresh();
  assert.equal(stats.snapshot().sources[1].failedFiles.length, 1); assert.equal(stats.snapshot().last7dLimited, true);
  await stats.refresh(); assert.equal(parses, 4);
  await put(path.join(config.dataDir, 'stats-index.json'), '{bad'); const fresh = createStats(config, agents); await fresh.refresh(); assert.equal(fresh.snapshot().building, false);
});

test('S4 inclusive window, future excluded from 7d, source coverage and failed/unknown counts', () => {
  const events = [-604800000, -604800001, 0, 1].map((delta, i) => ({ key: `claude:call:${i}`, kind: 'call', agentName: 'jack', source: 'claude', at: new Date(now + delta).toISOString(), status: ['ok', 'failed', 'unknown', 'ok'][i] }));
  const data = aggregate(events, agents, [{ id: 'claude', available: true, failedFiles: [], earliestAt: at }], now);
  assert.equal(data.perAgent.jack.last7d.calls, 2); assert.equal(data.perAgent.jack.total.calls, 4);
  assert.equal(data.perAgent.jack.last7d.unknown, 1); assert.equal(data.perAgent.harlo.total.calls, 0);
});

test('S4 coverage limitations distinguish historical gaps from recent failure/unavailable', async t => {
  const { config } = await fixture(t); await allDirs(config);
  await jsonl(path.join(config.claudeProjectsDir, 'p', 'main.jsonl'), [use('new')]);
  await jsonl(path.join(config.codexArchiveDirs[0], 'rollout-old.jsonl'), [meta('old', { agent_role: 'jack' }, '2026-01-01T00:00:00Z')]);
  const stats = createStats(config, agents, { now: () => now }); await stats.refresh();
  assert.equal(stats.snapshot().limited, true); assert.equal(stats.snapshot().last7dLimited, false);
  assert.match(stats.snapshot().limitedReasons.join(''), /此前的 Claude 调用无法统计/);
  const file = path.join(config.codexSessionsDir, 'rollout-bad.jsonl'); await put(file, '{bad'); await fs.utimes(file, new Date(0), new Date(0));
  await stats.refresh(); assert.equal(stats.snapshot().last7dLimited, false);
  config.codexArchiveDirs = [path.join(config.dataDir, 'nonexistent')];
  const missing = createStats(config, agents); await missing.refresh(); assert.equal(missing.snapshot().last7dLimited, true);
  assert.match(missing.snapshot().limitedReasons.join(''), /不可读/);
});

test('S4 refresh single flight exposes building and recovers write error honestly', async t => {
  const { config } = await fixture(t); await allDirs(config); let release;
  const gate = new Promise(resolve => { release = resolve; });
  await jsonl(path.join(config.claudeProjectsDir, 'p', 'm.jsonl'), [use('one')]);
  let parses = 0;
  const stats = createStats(config, agents, { parsers: { claude: async file => { parses++; await gate; return parseClaude(file); } } });
  const first = stats.refresh(); assert.equal(stats.snapshot().building, true);
  const second = stats.refresh(); assert.equal(first, second); release(); await first; assert.equal(parses, 1); assert.equal(stats.snapshot().building, false);
});

test('S5 archive config validation and data-root protection', async t => {
  const { root, config } = await fixture(t); await fs.mkdir(config.dataDir, { recursive: true });
  // v0.50: no archive folder unless config.json names one.
  assert.deepEqual((await loadConfig({ env: { AGENT_HUB_DATA_DIR: config.dataDir } })).codexArchiveDirs, []);
  for (const codexArchiveDirs of [null, 'bad', [2], ['']]) {
    await put(path.join(config.dataDir, 'config.json'), JSON.stringify({ codexArchiveDirs }));
    await assert.rejects(loadConfig({ env: { AGENT_HUB_DATA_DIR: config.dataDir } }), /codexArchiveDirs/);
  }
  await put(path.join(config.dataDir, 'config.json'), JSON.stringify({ codexArchiveDirs: [root] }));
  await assert.rejects(loadConfig({ env: { AGENT_HUB_DATA_DIR: config.dataDir } }), /运行数据/);
});

test('S4 all unreadable sources expose unavailable coverage and cache-write errors are visible', async t => {
  const { root, config } = await fixture(t);
  Object.assign(config, { claudeProjectsDir: path.join(root, 'missing-c'), codexSessionsDir: path.join(root, 'missing-x'), codexArchiveDirs: [path.join(root, 'missing-a')] });
  const stats = createStats(config, agents, { write: async () => { throw Object.assign(new Error('synthetic permission denied'), { code: 'EACCES' }); } });
  await assert.rejects(stats.refresh(), /synthetic permission denied/);
  const data = stats.snapshot(); assert.equal(data.building, false);
  assert.ok(data.sources.filter(s => s.id !== 'hub').every(s => !s.available));
  assert.equal(data.sources.find(s => s.id === 'hub').available, true);
  assert.equal(data.limited, true); assert.equal(data.last7dLimited, true); assert.match(data.indexError, /EACCES/);
});

test('S3/S4 duplicate launchId counted once; bad-line counts and future modification limits retained', async t => {
  const { config } = await fixture(t); await allDirs(config);
  const spec = JSON.stringify({ launchId: 'same', agentName: '-jack', cli: 'claude', createdAt: at });
  for (const name of ['a', 'b']) await put(path.join(config.dataDir, 'launches', `${name}.json`), spec);
  await jsonl(path.join(config.claudeProjectsDir, 'p', 'm.jsonl'), [use('good')]);
  await fs.appendFile(path.join(config.claudeProjectsDir, 'p', 'm.jsonl'), '{broken\n');
  const stats = createStats(config, agents, { now: () => now }); await stats.refresh();
  assert.equal(stats.snapshot().perAgent.jack.launches.total, 1); assert.equal(stats.snapshot().sources[0].badLines, 1);
  await stats.refresh(); assert.equal(stats.snapshot().sources[0].badLines, 1);
});

test('S2 long first-line metadata reads no middle; semantic corruption rejected', async t => {
  const { root } = await fixture(t), file = path.join(root, 'rollout-long.jsonl');
  const first = JSON.stringify({ ...meta('long'), payload: { ...meta('long').payload, base_instructions: { text: 'synthetic '.repeat(10000) } } }) + '\n';
  await put(file, first + 'synthetic middle'.repeat(100000) + '\n' + JSON.stringify(event('task_complete')) + '\n');
  const reads = [], size = (await fs.stat(file)).size;
  const parsed = await parseCodex(file, { onRead: r => reads.push(r) }); assert.equal(parsed.events[0].status, 'ok');
  assert.ok(reads.every(r => r.position < Buffer.byteLength(first) + 4096 || r.position >= size - TAIL_BYTES));
  for (const row of [{ type: 'other', payload: {} }, { type: 'session_meta', payload: { id: 'x', timestamp: 'bad' } }]) {
    await jsonl(file, [row]); await assert.rejects(parseCodex(file), /session_meta/);
  }
});
