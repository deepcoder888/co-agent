import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
import { missingSourcesFor } from '../public/display.js';
import { confirmMembers } from '../public/calls.js';
import { createApp } from '../src/server.mjs';
import { createConcepts, selectAgent, excludedConcepts } from '../src/concepts/index.mjs';
import { conceptPrompt, validateConcept, termFits } from '../src/concepts/runner.mjs';
import { termPrompt, validateTermOutput } from '../src/concepts/terms.mjs';
import { createSeminars } from '../src/seminars/index.mjs';
import { createStats } from '../src/stats/index.mjs';
import { parseClaude } from '../src/stats/claude.mjs';
import { atomicWrite } from '../src/fsutil.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { identityMatches } from '../src/close.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import * as threepane from '../public/layouts/threepane.js';
import * as bento from '../public/layouts/bento.js';
import * as editorial from '../public/layouts/editorial.js';
import * as shelf from '../public/layouts/shelf.js';

const at = '2026-10-21T01:00:00.000Z';
const book = (id = 'book', extra = {}) => ({ id, name: id, kind: 'book', book: { title: '测试书' },
  platforms: { codex: { available: true, name: id }, claude: { available: true, name: id } },
  sources: { checked: true, missing: ['claude-only.epub（Claude）'], missingByVersion: { claude: ['claude-only.epub'], codex: [] } }, ...extra });
const sessionRecord = (extra = {}) => ({ launchId: randomUUID(), pid: 4242, createdAt: at, cli: 'codex', agentName: 'book', ...extra });
const identity = (record, extra = {}) => ({ pid: record.pid, name: 'pwsh.exe', creationDate: record.createdAt, ...extra });

test('v031 3.1 per-CLI paths, legacy fallback and frontend confirmations', async () => {
  const agent = book(), prompts = [], options = { confirm: async text => { prompts.push(text); return true; }, permissionText: () => '' };
  assert.deepEqual(missingSourcesFor(agent, 'codex'), []);
  assert.deepEqual(missingSourcesFor(agent, 'claude'), ['claude-only.epub']);
  assert.deepEqual(await confirmMembers([agent], 'codex', options), {}); assert.equal(prompts.length, 0);
  assert.deepEqual(await confirmMembers([agent], 'claude', options), { sourcesConfirmed: true }); assert.equal(prompts.length, 1);
  assert.match(prompts[0], /claude-only.epub/);
  const legacy = book('legacy', { sources: { missing: ['old.epub'] } });
  for (const cli of ['claude', 'codex']) {
    assert.deepEqual(missingSourcesFor(legacy, cli), ['old.epub']);
    assert.deepEqual(await confirmMembers([legacy], cli, options), { sourcesConfirmed: true });
    assert.equal(await confirmMembers([legacy], cli, { ...options, confirm: async () => false }), null);
  }
  assert.deepEqual(missingSourcesFor({}, 'codex'), []);
  assert.equal(selectAgent([book('normalized', { sourcesOk: false })], [], () => 0).id, 'normalized');
  assert.throws(() => selectAgent([book('legacy', { sources: undefined, sourcesOk: false })], []), /没有可用/);
});

test('v031 3.1 launch, joint and both resume paths use the original CLI', async t => {
  let app; t.after(() => app?.close());
  const { config, root } = await fixture(t), agent = book(), calls = [];
  app = await createApp(config, { conceptAutoDaily: false, spawnImpl: fakeSpawner(calls, 4242), isAlive: () => false,
    queryIdentity: async () => assert.fail('dead PID must not be queried'), registryBuilder: async () => ({ agents: [agent] }) });
  await app.listen();
  const request = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${url}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  for (const cli of ['codex', 'claude']) for (const type of ['launch', 'joint']) {
    const payload = type === 'launch' ? { agentId: agent.id, cli } : { source: 'manual', agentIds: [agent.id], cli, input: '测试问题' };
    const initial = await request(`/api/${type}`, payload);
    assert.equal(initial.status, cli === 'codex' ? 200 : 409);
    const accepted = cli === 'codex' ? initial : await request(`/api/${type}`, { ...payload, sourcesConfirmed: true });
    assert.equal(accepted.status, 200);
    const id = accepted.body[`${type}Id`], record = JSON.parse(await fs.readFile(path.join(config.dataDir, `${type === 'joint' ? 'joints' : 'launches'}`, `${id}.json`), 'utf8'));
    const file = path.join(root, `${id}.jsonl`); await put(file, '{}\n');
    await app.sessions.register(type, record, { overall: 'historical', session: { id: randomUUID(), file } });
    const resume = type === 'launch' ? { agentId: agent.id, launchId: id } : { type, id };
    const resumed = await request('/api/resume', { ...resume, cli: cli === 'codex' ? 'claude' : 'codex' });
    assert.equal(resumed.status, cli === 'codex' ? 200 : 409);
    if (cli === 'codex') assert.equal(resumed.body.cli, 'codex');
    else assert.equal((await request('/api/resume', { ...resume, sourcesConfirmed: true })).status, 200);
  }
  app.registry.agents[0].sources = { missing: ['legacy.epub'] };
  for (const cli of ['codex', 'claude']) assert.equal((await request('/api/launch', { agentId: agent.id, cli })).status, 409);
  assert.equal(calls.length, 8, 'only accepted launch/resume requests reach the process substitute');
});

test('v031 3.1 daily and seminar candidate pools retain books missing only Claude sources', async t => {
  const { config } = await fixture(t), agents = [book(), book('two'), book('three')];
  const concepts = createConcepts(config, () => ({ agents }), { now: () => new Date(at), randomIntImpl: () => 0,
    runner: async () => { throw new Error('fixture generation stop'); }, isAlive: () => false });
  const seminars = createSeminars(config, () => ({ agents }), { runner: async () => { throw new Error('fixture seminar stop'); }, isAlive: () => false });
  t.after(async () => { await concepts.close(); await seminars.close(); });
  const daily = await concepts.ensureDaily(); await concepts.idle();
  assert.equal((await concepts.get(daily.conceptId)).agent.id, 'book');
  const started = await seminars.start({ input: '测试问题' }); await seminars.idle();
  assert.deepEqual((await seminars.get(started.seminarId)).catalog.map(a => a.id), agents.map(a => a.id));
  const explicit = await seminars.start({ input: '指定问题', agentIds: agents.map(a => a.id) }); await seminars.idle();
  assert.equal((await seminars.get(explicit.seminarId)).catalog.length, 3);
});

const use = (id, timestamp = at) => ({ type: 'assistant', timestamp, sessionId: 'main', message: { content: [
  { type: 'tool_use', name: 'Agent', id, input: { subagent_type: 'book' } },
] } });
async function statsFixture(t) {
  const ctx = await fixture(t);
  await fs.mkdir(ctx.config.codexArchiveDirs[0], { recursive: true });
  const file = path.join(ctx.config.claudeProjectsDir, 'a.jsonl'); await jsonl(file, [use('one', '2026-01-01T00:00:00Z')]);
  return { ...ctx, file, cacheFile: path.join(ctx.config.dataDir, 'stats-index.json') };
}

test('v031 3.2 deleted source retains events and coverage across restart and restoration', async t => {
  const { config, file, cacheFile } = await statsFixture(t), stats = createStats(config, [book()]);
  await stats.refresh(); const original = JSON.parse(await fs.readFile(cacheFile, 'utf8')).files[file];
  await fs.unlink(file); await stats.refresh();
  const retained = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  assert.equal(retained.parserRevision, 2); assert.deepEqual(retained.files[file], { ...original, retained: true });
  assert.equal(stats.snapshot().perAgent.book.total.calls, 1);
  const source = stats.snapshot().sources[0];
  assert.equal(source.files, 0); assert.equal(source.parsedFiles, 0); assert.equal(source.retainedFiles, 1);
  assert.equal(source.earliestAt, '2026-01-01T00:00:00.000Z');
  const restarted = createStats(config, [book()], { onParse: () => assert.fail('deleted file cannot be parsed') });
  await restarted.refresh(); assert.equal(restarted.snapshot().perAgent.book.total.calls, 1);
  await jsonl(file, [use('one', '2026-01-01T00:00:00Z')]); await stats.refresh();
  assert.equal(stats.snapshot().sources[0].retainedFiles, 0);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).files[file].retained, undefined);
});

test('v031 3.2 moving Codex sessions to archive deduplicates retained events', async t => {
  const { config } = await statsFixture(t), file = path.join(config.codexSessionsDir, 'rollout-one.jsonl');
  await jsonl(file, [{ type: 'session_meta', payload: { id: 'child', timestamp: at,
    source: { subagent: { thread_spawn: { agent_role: 'book', parent_thread_id: 'parent', depth: 1 } } } } }]);
  const stats = createStats(config, [book()]); await stats.refresh();
  assert.equal(stats.snapshot().perAgent.book.total.bySource.codex, 1);
  const destination = path.join(config.codexArchiveDirs[0], 'rollout-archived.jsonl');
  await fs.copyFile(file, destination); await fs.unlink(file); await stats.refresh();
  assert.equal(stats.snapshot().perAgent.book.total.bySource.codex, 1);
  assert.equal(stats.snapshot().sources.find(s => s.id === 'codex-live').retainedFiles, 1);
  assert.equal(stats.snapshot().sources.find(s => s.id === 'codex-archive').parsedFiles, 1);
  assert.ok(!stats.snapshot().limitedReasons.some(reason => reason.includes('Claude 会话记录最早只到')));
});

test('v031 3.2 stat ENOENT retains entries; other stat/read failures discard them', async t => {
  const { config, file, cacheFile } = await statsFixture(t); let readError;
  const stats = createStats(config, [book()], { parsers: { claude: async file => {
    if (readError) throw Object.assign(new Error('fixture read denied'), { code: readError });
    return parseClaude(file);
  } } });
  await stats.refresh(); const stat = fs.stat;
  const mocked = t.mock.method(fs, 'stat', async (target, ...args) => {
    if (target === file) throw Object.assign(new Error('fixture vanished'), { code: 'ENOENT' });
    return stat(target, ...args);
  });
  await stats.refresh(); assert.equal(stats.snapshot().perAgent.book.total.calls, 1);
  assert.equal(stats.snapshot().sources[0].files, 0); assert.equal(stats.snapshot().sources[0].retainedFiles, 1);
  mocked.mock.restore();
  await jsonl(file, [use('one'), use('two')]); readError = 'EACCES'; await stats.refresh();
  assert.equal(stats.snapshot().perAgent.book.total.calls, 0); assert.equal(stats.snapshot().sources[0].failedFiles.length, 1);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).files[file], undefined);
});

test('v031 3.2 retained earliest Claude timestamp prevents a false cleanup coverage warning', async t => {
  const { config, file } = await statsFixture(t);
  await jsonl(path.join(config.claudeProjectsDir, 'new.jsonl'), [use('new')]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-midyear.jsonl'), [{ type: 'session_meta', payload: {
    id: 'child', timestamp: '2026-06-01T00:00:00Z', source: { subagent: { thread_spawn: { agent_role: 'book' } } },
  } }]);
  const stats = createStats(config, [book()]); await stats.refresh(); await fs.unlink(file); await stats.refresh();
  assert.equal(stats.snapshot().sources[0].earliestAt, '2026-01-01T00:00:00.000Z');
  assert.ok(!stats.snapshot().limitedReasons.some(reason => reason.includes('Claude 会话记录最早只到')));
});

for (const method of ['stat', 'readdir']) test(`v031 3.2 ${method} EACCES is not treated as deletion`, async t => {
  const { config, file, cacheFile } = await statsFixture(t), stats = createStats(config, [book()]);
  await stats.refresh(); const original = fs[method];
  t.mock.method(fs, method, async (target, ...args) => {
    if (target === (method === 'stat' ? file : config.claudeProjectsDir))
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return original(target, ...args);
  });
  await stats.refresh(); assert.equal(stats.snapshot().perAgent.book.total.calls, 0);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).files[file], undefined);
  assert.equal(stats.snapshot().sources[0].retainedFiles, 0);
  if (method === 'stat') assert.equal(stats.snapshot().sources[0].failedFiles.length, 1);
  else assert.equal(stats.snapshot().sources[0].available, false);
});

test('v031 3.5 unchanged refresh/startup skips writes; changed files and retention write once', async t => {
  const { config, file } = await statsFixture(t); let writes = 0;
  const write = async (...args) => { writes++; await atomicWrite(...args); };
  const stats = createStats(config, [book()], { write });
  await stats.refresh(); await stats.refresh(); assert.equal(writes, 1);
  const restarted = createStats(config, [book()], { write }); await restarted.refresh(); assert.equal(writes, 1);
  await jsonl(file, [use('one'), use('two')]); await restarted.refresh(); assert.equal(writes, 2);
  await fs.unlink(file); await restarted.refresh(); await restarted.refresh(); assert.equal(writes, 3);
});

test('v031 3.5 failed write is retried even without further source changes', async t => {
  const { config } = await statsFixture(t); let writes = 0;
  const stats = createStats(config, [book()], { write: async (...args) => {
    if (++writes === 1) throw new Error('fixture disk error'); await atomicWrite(...args);
  } });
  await assert.rejects(stats.refresh(), /fixture disk error/); assert.match(stats.snapshot().indexError, /写入失败/);
  await stats.refresh(); await stats.refresh(); assert.equal(writes, 2); assert.equal(stats.snapshot().indexError, undefined);
});

test('v031 3.4 identity predicate accepts only matching PID, PowerShell and inclusive time window', () => {
  const record = sessionRecord();
  for (const offset of [-60000, 0, 180000]) for (const name of ['pwsh.exe', 'PowerShell.EXE'])
    assert.equal(identityMatches(record, identity(record, { name, creationDate: new Date(Date.parse(at) + offset).toISOString() })), true);
  for (const value of [null, identity(record, { pid: 4243 }), identity(record, { name: 'codex.exe' }),
    identity(record, { creationDate: 'invalid' }), ...[-60001, 180001].map(offset => identity(record, { creationDate: new Date(Date.parse(at) + offset).toISOString() }))])
    assert.equal(identityMatches(record, value), false);
});

for (const [label, extra] of [['name', { name: 'electron.exe' }], ['time', { creationDate: '2020-01-01T00:00:00Z' }], ['PID', { pid: 999 }], ['valid', {}]]) {
  test(`v031 3.4 running identity ${label}, cache and status`, async t => {
    const { config } = await fixture(t), record = sessionRecord(); let queries = 0;
    config.verifyPollMs = 0;
    const sessions = createSessions(config, { isAlive: () => true, queryIdentity: async () => { queries++; return identity(record, extra); },
      verifier: async () => ({ overall: 'ready', message: '已就绪' }) });
    await sessions.register('launch', record);
    for (let i = 0; i < 3; i++) assert.equal((await sessions.running()).items.length, label === 'valid' ? 1 : 0);
    assert.equal((await sessions.check('launch', record.launchId)).process.state, label === 'valid' ? 'alive' : 'exited');
    assert.equal(queries, 1);
  });
}

test('v031 3.4 query failure stays visible and retries next refresh; cache key includes createdAt', async t => {
  const { config } = await fixture(t), record = sessionRecord(); let queries = 0;
  const sessions = createSessions(config, { isAlive: () => true, queryIdentity: async () => {
    if (++queries === 1) throw Error('fixture helper failed'); return identity(record);
  }, verifier: async () => ({ overall: 'ready' }) });
  await sessions.register('launch', record);
  assert.equal((await sessions.running()).items.length, 1); assert.equal(queries, 1);
  await sessions.refresh(); assert.equal(queries, 2);
  assert.equal((await sessions.running()).items.length, 1); assert.equal(queries, 2);
  const reused = sessionRecord({ createdAt: '2026-10-22T01:00:00Z' }); await sessions.register('launch', reused);
  assert.deepEqual((await sessions.running()).items.map(item => item.id), [record.launchId]); assert.equal(queries, 3);
});

test('v031 3.4 no injected identity query under node:test cannot launch a helper', async t => {
  const { config } = await fixture(t), record = sessionRecord();
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const sessions = createSessions(config, { isAlive: () => true, verifier: async () => ({ overall: 'ready' }) });
  await sessions.register('launch', record); assert.equal((await sessions.running()).items.length, 1);
  await assert.rejects(fs.access(path.join(config.dataDir, 'close')), { code: 'ENOENT' });
});

test('v031 3.4 failed identity query followed by mismatch updates a throttled alive status', async t => {
  const { config } = await fixture(t), record = sessionRecord(); let queries = 0;
  config.verifyPollMs = 60000;
  const sessions = createSessions(config, { isAlive: () => true, queryIdentity: async () => {
    if (++queries === 1) throw Error('fixture helper failed'); return identity(record, { name: 'electron.exe' });
  }, verifier: async () => ({ overall: 'ready', process: { state: 'alive' } }) });
  await sessions.register('launch', record);
  assert.equal((await sessions.running()).items[0].status.process.state, 'alive');
  assert.equal((await sessions.running()).items.length, 0);
  assert.equal((await sessions.check('launch', record.launchId)).process.state, 'exited'); assert.equal(queries, 2);
});

const compassTerm = { zh: '会话目标罗盘', en: 'Conversational goal compass', fr: 'Boussole des objectifs conversationnels' };
const conceptResult = (extra = {}) => ({ concept: '会话目标罗盘', conceptEn: 'Conversational goal compass',
  oneLine: '以目标调整会话', whyUnknown: '书名未提到', sourceRefs: ['第一章'], markdown: '# 完整讲解\r\nÉnergie 与原文\r\n',
  term: { zh: '协调', en: 'Coordination', fr: 'Coordination' }, ...extra });
const historicalConcept = (extra = {}) => ({ version: 1, conceptId: randomUUID(), kind: 'manual', day: '2026-10-21',
  createdAt: at, finishedAt: at, status: 'done', agent: { id: 'book', name: 'Book', codexName: 'book', title: '测试书' },
  result: conceptResult(), perspectives: [], ...extra });
async function conceptFixture(t, options = {}) {
  const ctx = await fixture(t); ctx.config.concept.thinkDir = path.join(ctx.root, 'think');
  const engine = createConcepts(ctx.config, () => ({ agents: [book()] }), {
    now: () => new Date(at), isAlive: () => false, runner: async () => conceptResult(),
    conceptVerifier: async () => ({ state: 'unconfirmed' }),
    termRunner: async () => assert.fail('unexpected term generation'), ...options,
  });
  t.after(() => engine.close()); return { ...ctx, engine };
}
const writeConcept = (config, record) => put(path.join(config.dataDir, 'concepts', `${record.conceptId}.json`), JSON.stringify(record));

test('v031 3.3 termFits keeps short full names, accepts specific substrings and rejects every generic word', () => {
  for (const [concept, zh, expected] of [
    ['会话目标罗盘', '协调', false], ['会话目标罗盘', '目标罗盘', false], ['会话目标罗盘', '会话目标罗盘', true],
    ['内外嵌套的调节工具箱', '调节工具箱', true], ['内外嵌套的调节工具箱', '嵌套', false], ['践行', '践行', true],
    ['会 话\n目标罗盘', '会话目标 罗盘', true], ['内外 嵌套的调节工具箱', '调节 工具箱', true],
    ['内外嵌套的调节工具箱', '内外工具箱', false], ['内外嵌套的调节工具箱', '目标罗盘', false],
    ['心', '心', true], ['甲乙丙丁戊己庚辛', '甲乙丙丁戊己庚辛', true], ['甲乙丙丁戊己庚辛', '甲', false],
    ['甲乙丙丁戊己庚辛壬', '甲乙丙丁戊己庚辛', true], ['甲乙丙丁戊己庚辛壬', '甲乙丙丁戊己庚辛壬', false],
    ['标题：调节工具箱', '调节工具箱', true], ['标题：调节工具箱', '：调节工具箱', false], ['English', 'English', false],
    ['', '', false], ['会话目标罗盘', '', false],
  ]) assert.equal(termFits({ zh }, concept), expected, `${concept} / ${zh}`);
  for (const zh of ['概念', '创造', '协调', '嵌套', '方法', '思维', '原则', '系统', '模型', '理论',
    '能力', '价值', '问题', '过程', '结构', '关系', '意义', '习惯', '认知', '学习']) {
    assert.equal(termFits({ zh }, `一种关于${zh}的完整说明标题`), false, zh);
    assert.equal(termFits({ zh }, zh), true, `full concept ${zh}`);
  }
  for (const term of [null, undefined, {}, { zh: 123 }]) assert.equal(termFits(term, '会话目标罗盘'), false);
  assert.equal(termFits(compassTerm, null), false);
});

test('v031 3.3 both prompts state the corrected full-name and long-title rules', () => {
  const record = { ...historicalConcept(), excludedConcepts: [] };
  const rule = 'zh 必须是 concept 中连续的一段（1–8 个汉字），能单独代表这个概念，不能是「概念」「创造」这类泛词；concept 本身不超过 8 个汉字时，zh 就是 concept。例：「会话目标罗盘」（6 字）→「会话目标罗盘」；「内外嵌套的调节工具箱」（10 字）→「调节工具箱」，不能是「嵌套」。en、fr 只翻译 zh 这个词。';
  for (const prompt of [conceptPrompt(record), termPrompt(record)]) {
    assert.ok(prompt.includes(rule)); assert.ok(prompt.includes('法文去掉冠词并保留重音符号'));
    assert.ok(!prompt.includes('zh 为一个词或一个字'));
  }
  const prompt = termPrompt(record), input = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  assert.deepEqual(Object.keys(input), ['concept', 'conceptEn', 'book', 'oneLine']);
  assert.ok(!prompt.includes(record.result.markdown));
});

test('v031 3.3 concept validation retains lecture data but term-only validation fails unacceptable words', () => {
  for (const zh of ['协调', '目标罗盘', '无关词']) {
    const original = conceptResult({ term: { ...compassTerm, zh } }), validated = validateConcept(original);
    assert.deepEqual(validated, { ...original, term: null, response: null, responseError: '回应格式无效' });
    assert.deepEqual(validateConcept(validated), validated); // process runner and engine both validate
    assert.equal(original.term.zh, zh);
    assert.throws(() => validateTermOutput({ term: original.term }, { result: original }), /不符合概念名规则/);
  }
  assert.deepEqual(validateConcept(conceptResult({ term: compassTerm })).term, compassTerm);
  assert.deepEqual(validateTermOutput({ term: { ...compassTerm, fr: `la ${compassTerm.fr}` } }, historicalConcept()), { term: compassTerm });
  const long = conceptResult({ concept: '内外嵌套的调节工具箱', term: { zh: '调节工具箱', en: 'Regulation toolbox', fr: 'Boîte à outils de régulation' } });
  assert.deepEqual(validateTermOutput({ term: long.term }, { result: long }), { term: long.term });
  assert.throws(() => validateTermOutput({ term: { ...long.term, zh: '嵌套' } }, { result: long }), /不符合概念名规则/);
  assert.throws(() => validateConcept(conceptResult({ markdown: '' })), /概念 JSON 格式无效/);
});

test('v031 3.3 generated invalid term is saved as null, queued once and uses concept for THINK', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), writes = []; let calls = 0;
  t.after(() => release.resolve());
  const { engine, config } = await conceptFixture(t, {
    recordWriter: async (file, bytes) => { writes.push(JSON.parse(bytes)); await atomicWrite(file, bytes); },
    termRunner: async () => { calls++; entered.resolve(); await release.promise; return { term: compassTerm }; },
  });
  await engine.recover(); const { conceptId } = await engine.startManual({ kind: 'manual' }); await entered.promise;
  const pending = await engine.get(conceptId);
  assert.equal(pending.status, 'done'); assert.deepEqual(pending.result, { ...conceptResult({ term: null }), response: null });
  assert.ok(writes.some(r => r.status === 'done' && r.result.term === null && r.termBackfill?.status === 'queued'));
  assert.equal(pending.termBackfill.status, 'running'); assert.equal(pending.termBackfill.reason, undefined);
  assert.equal(path.basename(pending.thinkFile), '会话目标罗盘.txt');
  assert.deepEqual(await fs.readFile(pending.thinkFile), Buffer.from(pending.result.markdown));
  const before = await fs.stat(pending.thinkFile);
  await engine.recover(); await engine.backfillTerm(conceptId); assert.equal(calls, 1);
  release.resolve(); await engine.idle();
  const done = await engine.get(conceptId);
  assert.deepEqual(done.result, { ...conceptResult({ term: compassTerm }), response: null }); assert.equal(done.termBackfill.status, 'done');
  assert.equal(done.thinkFile, pending.thinkFile); assert.equal((await fs.stat(done.thinkFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(done.thinkFile), Buffer.from(pending.result.markdown));
  await engine.recover(); await engine.backfillTerm(conceptId); await engine.idle(); assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(config.dataDir, 'concepts', `${conceptId}.json`), 'utf8')).termBackfill.attempt, 1);
});

test('v031 3.3 failed generated-term backfill keeps completed lecture and null without retry', async t => {
  let calls = 0;
  const { engine, config } = await conceptFixture(t, { termRunner: async () => { calls++; return { term: { ...compassTerm, zh: '目标罗盘' } }; } });
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await engine.idle();
  const saved = await engine.get(conceptId);
  assert.equal(saved.status, 'done'); assert.deepEqual(saved.result, { ...conceptResult({ term: null }), response: null });
  assert.equal(saved.termBackfill.status, 'failed'); assert.match(saved.termBackfill.error, /不符合概念名规则/);
  assert.deepEqual(await fs.readFile(saved.thinkFile), Buffer.from(saved.result.markdown));
  await assert.rejects(engine.backfillTerm(conceptId), { status: 409 }); await engine.recover(); await engine.idle();
  await engine.close();
  const restarted = createConcepts(config, () => ({ agents: [book()] }), { isAlive: () => false, termRunner: async () => { calls++; return { term: compassTerm }; } });
  t.after(() => restarted.close()); await restarted.recover(); await restarted.idle();
  assert.deepEqual((await restarted.get(conceptId)).result, saved.result); assert.equal(calls, 1);
});

test('v031 3.3 historical refits run serially once even after older backfills, replacing only term', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = []; let active = 0, maximum = 0;
  t.after(() => release.resolve());
  const { engine, config, root } = await conceptFixture(t, { termRunner: async r => {
    calls.push(r.conceptId); maximum = Math.max(maximum, ++active); entered.resolve(); await release.promise; active--;
    return { term: compassTerm };
  } });
  const records = [historicalConcept(), historicalConcept({ termBackfill: { status: 'done', attempt: 1 } }),
    historicalConcept({ termBackfill: { status: 'failed', attempt: 1, error: 'old failure' } }),
    historicalConcept({ termBackfill: { status: 'queued', attempt: 0, createdAt: at } })];
  const valid = historicalConcept({ result: conceptResult({ concept: '学习', term: { zh: '学习', en: 'Learning', fr: 'Apprentissage' } }) });
  const unfinished = historicalConcept({ status: 'failed' });
  const thinkFile = path.join(root, 'old-title.txt'), original = '旧 THINK 字节\r\nÉnergie\r\n';
  await put(thinkFile, original); const before = await fs.stat(thinkFile);
  for (const r of [...records, valid, unfinished]) { r.thinkFile = thinkFile; await writeConcept(config, r); }
  await engine.recover(); await entered.promise;
  for (const r of records) {
    const pending = await engine.get(r.conceptId);
    assert.deepEqual(pending.result, r.result); assert.equal(pending.termBackfill.reason, 'refit');
    assert.ok(['queued', 'running'].includes(pending.termBackfill.status));
  }
  await engine.recover(); await Promise.all(records.map(r => engine.backfillTerm(r.conceptId)));
  assert.equal(calls.length, 1); release.resolve(); await engine.idle();
  assert.equal(maximum, 1); assert.equal(calls.length, records.length); assert.equal(new Set(calls).size, records.length);
  for (const r of records) {
    const done = await engine.get(r.conceptId);
    assert.deepEqual(done.result, { ...r.result, term: compassTerm });
    assert.deepEqual({ ...done, result: r.result, termBackfill: r.termBackfill }, { ...r, termBackfill: r.termBackfill });
    assert.equal(done.termBackfill.reason, 'refit'); assert.equal(done.termBackfill.attempt, 1); assert.equal(done.termBackfill.status, 'done');
  }
  assert.deepEqual(await engine.get(valid.conceptId), valid); assert.deepEqual(await engine.get(unfinished.conceptId), unfinished);
  assert.equal(await fs.readFile(thinkFile, 'utf8'), original); assert.equal((await fs.stat(thinkFile)).mtimeMs, before.mtimeMs);
  await engine.recover(); await engine.idle(); await engine.close();
  const restarted = createConcepts(config, () => ({ agents: [book()] }), { isAlive: () => false, termRunner: async () => assert.fail('refit repeated after restart') });
  t.after(() => restarted.close()); await restarted.recover(); await restarted.idle();
  for (const r of records) assert.deepEqual((await restarted.get(r.conceptId)).result.term, compassTerm);
  assert.equal(calls.length, records.length);
});

for (const failure of ['invalid term', 'runner error', 'save error']) test(`v031 3.3 refit ${failure} preserves original data and never retries`, async t => {
  let calls = 0;
  const { engine, config, root } = await conceptFixture(t, {
    termRunner: async () => {
      calls++; if (failure === 'runner error') throw Error('fixture term failure');
      return { term: failure === 'invalid term' ? { ...compassTerm, zh: '目标罗盘' } : compassTerm };
    },
    recordWriter: async (file, bytes) => {
      if (failure === 'save error' && JSON.parse(bytes).result?.term?.zh === compassTerm.zh) throw Error('fixture save failure');
      await atomicWrite(file, bytes);
    },
  });
  const r = historicalConcept({ thinkFile: path.join(root, 'existing.txt') });
  await put(r.thinkFile, '原始 THINK\r\n'); await writeConcept(config, r);
  await engine.recover(); await engine.idle();
  const saved = await engine.get(r.conceptId);
  assert.deepEqual(saved.result, r.result); assert.equal(saved.status, 'done'); assert.equal(saved.thinkFile, r.thinkFile);
  assert.equal(saved.termBackfill.reason, 'refit'); assert.equal(saved.termBackfill.status, 'failed'); assert.equal(saved.termBackfill.attempt, 1);
  const onDisk = JSON.parse(await fs.readFile(path.join(config.dataDir, 'concepts', `${r.conceptId}.json`), 'utf8'));
  assert.deepEqual(onDisk, saved); assert.equal(await fs.readFile(r.thinkFile, 'utf8'), '原始 THINK\r\n');
  await engine.recover(); await assert.rejects(engine.backfillTerm(r.conceptId), { status: 409 }); await engine.idle(); await engine.close();
  const restarted = createConcepts(config, () => ({ agents: [book()] }), { isAlive: () => false, termRunner: async () => { calls++; return { term: compassTerm }; } });
  t.after(() => restarted.close()); await restarted.recover(); await restarted.idle();
  assert.deepEqual(await restarted.get(r.conceptId), saved); assert.equal(calls, 1);
});

test('v031 3.3 interrupted refit retains original term and a queued refit resumes only once', async t => {
  const calls = [], { engine, config } = await conceptFixture(t, { termRunner: async r => { calls.push(r.conceptId); return { term: compassTerm }; } });
  const interrupted = historicalConcept({ termBackfill: { reason: 'refit', status: 'running', attempt: 1, pid: 999, startedAt: at } });
  const queued = historicalConcept({ termBackfill: { reason: 'refit', status: 'queued', attempt: 0, createdAt: at } });
  for (const r of [interrupted, queued]) await writeConcept(config, r);
  await engine.recover(); await engine.idle(); await engine.recover(); await engine.idle();
  const failed = await engine.get(interrupted.conceptId), done = await engine.get(queued.conceptId);
  assert.deepEqual(failed.result, interrupted.result); assert.equal(failed.termBackfill.status, 'failed'); assert.match(failed.termBackfill.error, /进程中断/);
  assert.deepEqual(done.result, { ...queued.result, term: compassTerm }); assert.equal(done.termBackfill.status, 'done');
  assert.deepEqual(calls, [queued.conceptId]);
});

test('v031 3.3 different concepts sharing a term do not trigger duplicate detection', async t => {
  const term = { zh: '移情', en: 'Transference', fr: 'Transfert' }; let generated = conceptResult({ concept: '移情：过时的地图', conceptEn: 'Old maps', term });
  const { engine } = await conceptFixture(t, { runner: async () => generated });
  for (const [concept, conceptEn] of [['移情：过时的地图', 'Old maps'], ['移情：更新的地图', 'New maps'], ['移情', 'Transference']]) {
    generated = { ...generated, concept, conceptEn };
    const started = await engine.startManual({ kind: 'manual' }); await engine.idle();
    const done = await engine.get(started.conceptId); assert.equal(done.status, 'done'); assert.deepEqual(done.result.term, term);
  }
});

test('v031 3.3 exclusions contain only normalized Chinese/English concept names', () => {
  const record = { status: 'done', agent: { id: 'book' }, result: { concept: '会话 目标罗盘', conceptEn: 'Conversation Compass',
    term: { zh: '协调', en: 'Coordination', fr: 'Coordination' } } };
  assert.deepEqual(excludedConcepts([record, record, { ...record, status: 'failed' }], 'book'), ['会话目标罗盘', 'conversationcompass']);
  assert.deepEqual(excludedConcepts([record], 'other'), []);
});

for (const [name, layout] of Object.entries({ threepane, bento, editorial, shelf })) {
  test(`v031 3.3 ${name} uses concept as its title when term is null`, t => {
    const doc = documentFrom('<body><div id="layout-root"></div></body>');
    doc.createTextNode = text => { const node = doc.createElement('text'); node.textContent = text; return node; };
    const ctx = { doc, refs: {}, state: { view: 'concepts', allAgents: [], detailOpen: false, category: 'all', query: '', jointSelectedIds: [] },
      actions: new Proxy({}, { get: () => () => {} }) };
    ctx.root = layout.render(ctx); doc.getElementById('layout-root').append(ctx.root); t.after(() => ctx.refs.dispose?.());
    const record = { conceptId: 'fixture-concept', kind: 'daily', day: '2026-10-21', createdAt: at, status: 'done',
      agent: { id: 'book', name: 'Book', title: '测试书' }, result: { concept: '会话目标罗盘', conceptEn: 'Conversation Compass', term: null,
        oneLine: '说明', whyUnknown: '原因', sourceRefs: ['第一章'], markdown: '# 完整正文' },
      verify: { state: 'ok', skillStructure: { state: 'ok', missing: [], titleLine: true } }, perspectives: [] };
    layout.renderConcepts(ctx, { selected: record, items: [record], today: { day: record.day, conceptId: record.conceptId }, running: null, busy: false, error: '' });
    assert.ok(doc.querySelectorAll('*').some(node => /^H[1-6]$/.test(node.tagName) && node.textContent === record.result.concept), 'concept is rendered as the detail heading');
  });
}
