import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reverifyHistory } from '../src/launch/reverify.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { createApp } from '../src/server.mjs';
import { createStats } from '../src/stats/index.mjs';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';

const agent = { id: 'book', name: 'Book', platforms: { claude: { available: true }, codex: { available: true } } };
async function legacy(config, overrides = {}, status = { process: { state: 'exited', pid: 42 }, cwd: { state: 'pending' }, overall: 'failed', message: '进程已退出', extra: { keep: true } }) {
  const record = { launchId: randomUUID(), agentId: 'book', agentName: 'Book', cli: 'claude', mode: 'agent',
    args: ['--session-id', randomUUID()], createdAt: new Date().toISOString(), cwd: config.launchProject, ...overrides };
  const file = path.join(config.dataDir, 'launches', `${record.launchId}.json`);
  await put(file, JSON.stringify(record));
  const sidecar = file.replace(/\.json$/, '.status.json');
  if (status) await put(sidecar, JSON.stringify(status));
  return { record, sidecar, status, read: async () => JSON.parse(await fs.readFile(sidecar, 'utf8')) };
}
async function claudeLog(config, item, cwd = config.launchProject, setting = 'Book') {
  const sid = item.record.args[item.record.args.indexOf('--session-id') + 1];
  const file = path.join(config.claudeProjectsDir, 'project', `${sid}.jsonl`);
  await jsonl(file, [{ type: 'summary' }, { type: 'user', cwd }, { type: 'agent-setting', agentSetting: setting }]);
  return { id: sid, file };
}
async function codexLog(config, item, { brand = 'Agent Hub', source = 'cli', cwd = config.launchProject, dayOffset = 0 } = {}) {
  const date = new Date(item.record.createdAt); date.setUTCDate(date.getUTCDate() + dayOffset);
  const file = path.join(config.codexSessionsDir, date.toISOString().slice(0, 10).replaceAll('-', '/'), `rollout-${randomUUID()}.jsonl`);
  const id = randomUUID();
  await jsonl(file, [{ type: 'session_meta', payload: { id, source, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS.md instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'injected' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `【${brand} 启动检查 ${item.record.launchId}】` }] } }]);
  return { id, file };
}

test('H1 Claude finds first cwd, records agentSetting, preserves fields, EXDEV and byte idempotence', async t => {
  const { config } = await fixture(t), item = await legacy(config), session = await claudeLog(config, item);
  let fallbacks = 0;
  const result = await reverifyHistory(config, ['book'], { io: { rename: async () => { fallbacks++; throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); } } });
  assert.deepEqual(result.summary, { checked: 1, found: 1, notFound: 0 }); assert.equal(fallbacks, 1);
  const status = await item.read(); assert.deepEqual(status.session, session);
  assert.equal(status.overall, 'historical'); assert.equal(status.message, '历史会话 · 已核验');
  assert.deepEqual(status.process, item.status.process); assert.deepEqual(status.extra, item.status.extra); assert.deepEqual(status.cwd, item.status.cwd);
  assert.equal(status.reverified.result, 'found'); assert.equal(status.reverified.evidence.agentSetting, 'Book');
  const before = await fs.readFile(item.sidecar);
  assert.deepEqual((await reverifyHistory(config, ['book'])).summary, { checked: 0, found: 0, notFound: 0 });
  assert.deepEqual(await fs.readFile(item.sidecar), before);
});
for (const variant of ['mismatch', 'missing', 'no-cwd', 'wrong-first-cwd']) test(`H1 Claude ${variant} writes only reason and preserves original state`, async t => {
  const { config } = await fixture(t), item = await legacy(config);
  if (variant !== 'missing') {
    const session = await claudeLog(config, item, variant === 'no-cwd' ? undefined : 'D:/wrong');
    if (variant === 'no-cwd') await jsonl(session.file, [{ type: 'summary' }]);
    if (variant === 'wrong-first-cwd') await fs.appendFile(session.file, JSON.stringify({ cwd: config.launchProject }) + '\n');
  }
  assert.deepEqual((await reverifyHistory(config, ['book'])).summary, { checked: 1, found: 0, notFound: 1 });
  const status = await item.read(); const { reverified, ...rest } = status;
  assert.deepEqual(rest, item.status); assert.equal(reverified.result, ['mismatch', 'wrong-first-cwd'].includes(variant) ? 'cwd-mismatch' : 'not-found');
  assert.match(reverified.reason, /会话|工作目录/);
});
test('H1 missing status, normalized cwd and absent agentSetting remain usable with explicit additional evidence', async t => {
  const { config } = await fixture(t), item = await legacy(config, {}, null);
  await claudeLog(config, item, config.launchProject.replaceAll('\\', '/').toUpperCase() + '/', 'Other');
  await reverifyHistory(config, ['book']); const status = await item.read();
  assert.equal(status.overall, 'historical'); assert.equal(status.process.state, 'exited');
  assert.equal(status.reverified.evidence.agentSetting, null);
});
for (const brand of ['Agent Hub', 'CO-AGENT']) test(`H1 Codex ${brand} marker after injected messages, next day, cli-only`, async t => {
  const { config } = await fixture(t), item = await legacy(config, { cli: 'codex' });
  await codexLog(config, item, { source: { subagent: { thread_spawn: { agent_role: 'Book' } } } });
  const session = await codexLog(config, item, { brand, dayOffset: 1 });
  await reverifyHistory(config, ['book']); assert.deepEqual((await item.read()).session, session);
});
for (const variant of ['subagent', 'missing', 'mismatch', 'duplicate', 'outside-date']) test(`H1 Codex ${variant} cannot be resumed`, async t => {
  const { config } = await fixture(t), item = await legacy(config, { cli: 'codex' });
  if (variant !== 'missing') await codexLog(config, item, { source: variant === 'subagent' ? 'exec' : 'cli', cwd: variant === 'mismatch' ? 'D:/wrong' : config.launchProject, dayOffset: variant === 'outside-date' ? 3 : 0 });
  if (variant === 'duplicate') await codexLog(config, item);
  await reverifyHistory(config, ['book']); const status = await item.read(); assert.equal(status.session, undefined);
  assert.equal(status.reverified.result, variant === 'mismatch' ? 'cwd-mismatch' : 'not-found'); assert.ok(status.reverified.reason);
});
test('H1 existing session.id is untouched even if file/id is invalid; excludes out of scope and mismatched filenames', async t => {
  const { config } = await fixture(t), item = await legacy(config, {}, { session: { id: 'existing' }, extra: 7 });
  const excluded = await legacy(config, { agentId: 'outside' });
  const invalid = await legacy(config); const moved = path.join(path.dirname(invalid.sidecar), `${randomUUID()}.json`);
  await fs.rename(invalid.sidecar.replace('.status.json', '.json'), moved);
  const before = await fs.readFile(item.sidecar), other = await fs.readFile(excluded.sidecar);
  assert.equal((await reverifyHistory(config, ['book'])).summary.checked, 0);
  assert.deepEqual(await fs.readFile(item.sidecar), before); assert.deepEqual(await fs.readFile(excluded.sidecar), other);
});
test('H1 ambiguous Claude copies are refused; failed atomic write leaves old bytes and no temporary files', async t => {
  const { config } = await fixture(t), item = await legacy(config);
  const session = await claudeLog(config, item);
  await put(path.join(config.claudeProjectsDir, 'other', path.basename(session.file)), await fs.readFile(session.file, 'utf8'));
  await reverifyHistory(config, ['book']); assert.match((await item.read()).reverified.reason, /多个会话文件/);
  const before = await fs.readFile(item.sidecar);
  await assert.rejects(reverifyHistory(config, ['book'], { io: { rename: async () => { throw Object.assign(new Error('blocked fixture write'), { code: 'EACCES' }); } } }), { code: 'EACCES' });
  assert.deepEqual(await fs.readFile(item.sidecar), before);
  assert.ok(!(await fs.readdir(path.dirname(item.sidecar))).some(name => name.endsWith('.tmp')));
});
test('H1 Codex assistant-only, different launchId and absent source are rejected', async t => {
  const { config } = await fixture(t), item = await legacy(config, { cli: 'codex' });
  for (const variant of ['assistant', 'wrong-id', 'no-source']) {
    const session = await codexLog(config, item), rows = (await fs.readFile(session.file, 'utf8')).trim().split('\n').map(JSON.parse);
    if (variant === 'assistant') rows.at(-1).payload.role = 'assistant';
    if (variant === 'wrong-id') rows.at(-1).payload.content[0].text = `【CO-AGENT 启动检查 ${randomUUID()}】`;
    if (variant === 'no-source') delete rows[0].payload.source;
    await jsonl(session.file, rows);
  }
  assert.deepEqual((await reverifyHistory(config, ['book'])).summary, { checked: 1, found: 0, notFound: 1 });
  assert.equal((await item.read()).session, undefined);
});
test('H2 in-flight live verification completes before historical write; later checks cannot overwrite it', async t => {
  const { config } = await fixture(t), item = await legacy(config); await claudeLog(config, item);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const store = createSessions(config, { isAlive: () => false, verifier: async () => { await gate; return { overall: 'failed', process: { state: 'exited' } }; } });
  await store.register('launch', item.record);
  const pending = store.check('launch', item.record.launchId); await new Promise(resolve => setImmediate(resolve));
  const batch = store.reverify(['book']); release(); await pending; assert.equal((await batch).summary.found, 1);
  const before = await fs.readFile(item.sidecar); assert.equal((await store.check('launch', item.record.launchId)).overall, 'historical');
  assert.deepEqual(await fs.readFile(item.sidecar), before);
});
test('H2 history canReverify, failure reason, retry after missing file; restart and PID reuse cannot overwrite historical', async t => {
  const { config } = await fixture(t), item = await legacy(config); const store = createSessions(config, { isAlive: () => false }); await store.recover();
  assert.equal((await store.history('book')).unavailable[0].canReverify, true);
  await store.reverify(['book']); assert.match((await store.history('book')).unavailable[0].reason, /会话文件不存在/);
  await claudeLog(config, item); await store.reverify(['book']);
  const before = await fs.readFile(item.sidecar); assert.equal((await store.history('book')).items.length, 1);
  const restarted = createSessions(config, { isAlive: () => true, verifier: async () => { throw new Error('must not verify historical'); } });
  await restarted.recover(); assert.equal((await restarted.running()).items.length, 0); assert.equal((await restarted.history('book')).items.length, 1);
  assert.deepEqual(await fs.readFile(item.sidecar), before);
  const status = await item.read(); await fs.rm(status.session.file); assert.match((await restarted.history('book')).unavailable[0].reason, /会话文件/);
});
test('H2/H4 API token, origin, scope, summaries, concurrent requests, resume argv for all modes and unchanged statistics', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t), calls = [];
  const items = [];
  for (const variant of [{ cli: 'claude', mode: 'agent' }, { cli: 'claude', mode: 'relay' }, { cli: 'codex', mode: 'relay' }]) {
    const item = await legacy(config, { ...variant, codexProfile: 'gpt' });
    if (variant.mode === 'agent') item.record.args.unshift('--agent', 'Book');
    if (variant.mode === 'relay' && variant.cli === 'claude') { item.record.args.push('--append-system-prompt', 'original relay instruction'); await put(item.sidecar.replace('.status.json', '.json'), JSON.stringify(item.record)); }
    // Actual pre-v0.4 specs have argv but no mode or codexProfile.
    delete item.record.mode; delete item.record.codexProfile;
    if (variant.cli === 'codex') item.record.args.push('--profile', 'gpt');
    await put(item.sidecar.replace('.status.json', '.json'), JSON.stringify(item.record));
    item.session = variant.cli === 'claude' ? await claudeLog(config, item) : await codexLog(config, item); items.push(item);
  }
  await legacy(config); await legacy(config, { agentId: 'outside' });
  app = await createApp(config, { registryBuilder: async () => ({ agents: [agent] }), spawnImpl: fakeSpawner(calls), isAlive: () => false }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body = {}, token = app.token, origin) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Co-Agent-Token': token } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/history/book/reverify', {}, null)).status, 403);
  assert.equal((await post('/api/history/reverify-all', {}, null)).status, 403);
  assert.equal((await post('/api/history/book/reverify', {}, app.token, 'http://other')).status, 403);
  assert.equal((await post('/api/history/outside/reverify')).status, 404);
  const stats = createStats(config, [agent]); await stats.refresh(); const before = stats.snapshot();
  const first = await (await post('/api/history/book/reverify')).json(); assert.deepEqual(first.summary, { checked: 4, found: 3, notFound: 1 });
  assert.equal((await items[0].read()).reverified.evidence.agentSetting, 'Book');
  assert.equal(first.history.items.find(item => item.launchId === items[0].record.launchId).mode, 'agent');
  assert.deepEqual(first.history, await (await fetch(base + '/api/history/book')).json()); assert.equal(calls.length, 0);
  await stats.refresh(); assert.deepEqual(stats.snapshot().perAgent, before.perAgent); assert.equal(stats.snapshot().sources.find(s => s.id === 'hub').files, 5);
  const results = await Promise.all([post('/api/history/reverify-all'), post('/api/history/book/reverify')]);
  const all = await results[0].json(); assert.deepEqual(all.summary, { checked: 1, found: 0, notFound: 1 }); assert.deepEqual(all.foundByAgent, { book: 0 });
  for (const item of items) {
    const response = await post('/api/resume', { agentId: 'book', launchId: item.record.launchId }); assert.equal(response.status, 200); const value = await response.json();
    const record = JSON.parse(await fs.readFile(path.join(config.dataDir, 'launches', `${value.launchId}.json`), 'utf8'));
    const expected = item.record.cli === 'codex' ? ['resume', item.session.id, '--profile', 'gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh', '-C', config.launchProject] : item.record.args.includes('--agent') ? ['--agent', 'Book', '--resume', item.session.id] : ['--resume', item.session.id, '--append-system-prompt', 'original relay instruction'];
    assert.deepEqual(record.args, expected); assert.equal(record.resumeOf, item.record.launchId);
    assert.equal(record.mode, item.record.args.includes('--agent') ? 'agent' : 'relay');
  }
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.options.shell === false));
});
