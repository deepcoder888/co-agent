import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
import { checkSources, extractBookFiles } from '../src/registry/sources.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { compareVersions } from '../src/registry/sync.mjs';
import { createReports } from '../src/reports/index.mjs';
import { createStats } from '../src/stats/index.mjs';
import { createConcepts } from '../src/concepts/index.mjs';
import { createSeminars } from '../src/seminars/index.mjs';
import { createLogger } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';

const deferred = () => Promise.withResolvers();
const instant = new Date('2026-10-21T02:00:00Z');
const member = (id = 'walvo', extra = {}) => ({ id, name: id, kind: 'book', tags: [], primary: '软件工程', description: 'fixture',
  book: { title: '《Testing Book》', author: 'Fixture' }, writable: false,
  platforms: { claude: { available: true, name: id }, codex: { available: true, name: id } }, ...extra });
const noStats = () => ({ refresh: async () => {}, snapshot: () => ({ building: false }), setAgents() {} });
const neverRun = async () => { throw new Error('fixture runner'); };

async function harness(t, agents = [], options = {}) {
  const { root, config } = await fixture(t), calls = [];
  config.verifyPollMs = 60000;
  const app = await createApp(config, { conceptAutoDaily: false, statsRefreshMs: 0, statsFactory: noStats,
    registryBuilder: async () => ({ agents, summary: {}, sources: [], categories: [] }),
    spawnImpl: fakeSpawner(calls), verifier: async () => ({ overall: 'pending' }), isAlive: () => true, ...options });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(close);
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  return { root, config, app, calls, request, close };
}

test('v029 3.1 Spitvo page-N quoted source is excluded without probing the disk', async () => {
  const result = await checkSources('Existing page images are under `D:/work/Reading/.a-deepbooker-work/spitvo/source-hd-pages/page-N.png`; For PDF166/167/204/284/294/316/327, verify the image hash in the bound critical_image_bindings file and the original PDF hash.',
    { exists: async () => assert.fail('template must not be probed') });
  assert.deepEqual(result, { checked: true, missing: [], total: 0, templatesExcluded: 1 });
});

for (const [open, close] of [['`', '`'], ['"', '"'], ['“', '”']]) test(`v029 3.1 ${open} quoted paths preserve spaces, punctuation and full-width parentheses`, async () => {
  const file = 'D:/书 籍（正文）/Chapter, One; Notes.md', calls = [];
  const result = await checkSources(`Read ${open}${file}${close}; For more information.`, {
    exists: async value => { calls.push(value); return false; },
  });
  assert.deepEqual(result.missing, [file]); assert.deepEqual(calls, [file]);
});

test('v029 3.1 unmatched quote retains legacy separator probing', async () => {
  const file = 'D:/books/book.pdf';
  assert.deepEqual((await checkSources('`' + file + '; metadata', { exists: async value => value === file })).missing, []);
});

test('v029 3.1 token templates and legacy placeholders are excluded, ordinary N names still checked', async () => {
  const templates = ['page-N.png', 'chapter_NN.md', 'N.pdf', 'img-XX.jpg', 'page NNNN', 'page-n.png', 'X', 'image00NNN.jpeg', '<page>.png', '{page}.png', '*.png', '?.png'];
  const ordinary = ['Notes.md', 'NIN.pdf', 'Samplex.epub', 'Page-Nine.png', 'N-gram.pdf'], calls = [];
  const result = await checkSources([...templates, ...ordinary].map(name => '`D:/books/' + name + '`').join('\n'), {
    exists: async value => { calls.push(value); return false; },
  });
  assert.equal(result.templatesExcluded, templates.length);
  assert.deepEqual(result.missing, ordinary.map(name => `D:/books/${name}`)); assert.deepEqual(calls, result.missing);
});

test('v029 3.1 extractBookFiles retains its book-file extraction rules', async () => {
  const result = await extractBookFiles('`D:/books/N.pdf`\n`D:/books/Book（正文）.epub`', { exists: async () => false });
  assert.deepEqual(result.map(file => file.path), ['D:\\books\\N.pdf', 'D:\\books\\Book（正文）.epub']);
});

test('v029 3.2 both versions contribute normalized unique paths and version-specific missing labels', async t => {
  const { root, config } = await fixture(t);
  const present = path.join(root, '已处理', 'Book.epub'), old = path.join(root, '未处理', 'Book.epub');
  const shared = path.join(root, 'shared.pdf'), onlyCodex = path.join(root, 'codex.pdf');
  await put(present, 'fixture');
  await put(path.join(config.codexAgentsDir, 'stevo.toml'), `name="Stevo"\ndescription="book"\ndeveloper_instructions='''\n\`${present}\`\n\`${shared}\`\n\`${onlyCodex}\`\n\`D:/page-N.png\`\n'''`);
  await put(path.join(config.claudeAgentDirs[0], 'stevo.md'), `---\nname: Stevo\ndescription: book\n---\n\`${present.replaceAll('\\', '/')}\`\n\`${shared.toUpperCase().replaceAll('\\', '/')}\`\n\`${old}\`\n\`D:/chapter_NN.md\``);
  const agent = (await buildRegistry(config)).agents.find(a => a.id === 'stevo');
  assert.equal(agent.sources.checked, true); assert.equal(agent.sources.total, 4); assert.equal(agent.sources.templatesExcluded, 2);
  assert.deepEqual(agent.sources.missing, [shared, `${onlyCodex}（仅 Codex 版本）`, `${old}（仅 Claude 版本）`]);
  assert.deepEqual(agent.sources.missingByVersion, { codex: [shared, onlyCodex], claude: [shared.toUpperCase().replaceAll('\\', '/'), old] });
  await fs.unlink(path.join(config.claudeAgentDirs[0], 'stevo.md'));
  const single = (await buildRegistry(config)).agents.find(a => a.id === 'stevo').sources;
  assert.equal(single.total, 3); assert.equal(single.templatesExcluded, 1); assert.deepEqual(single.missingByVersion.claude, []);
});

const sync = (codex, claude, cd = 'description', ad = cd) => compareVersions({ developer_instructions: codex, description: cd }, { body: claude, description: ad });
test('v029 3.3 additions anywhere in the ordered sequence are synchronized and counted', () => {
  const result = sync('one  \r\n\n two\t\nthree', 'intro\none\n\n two\nClaude tool mapping\nRead maps to read\nthree\n');
  assert.equal(result.state, '同步'); assert.match(result.detail, /另有 3 行附加内容/); assert.equal(result.diff, undefined);
  assert.equal(sync('one\n\ntwo', 'one\ntwo').detail, '描述与正文一致（忽略示例块、换行与行尾空白）');
});
test('v029 3.3 rewritten and deleted lines align to the corresponding original', () => {
  assert.deepEqual(sync('one\ntwo\nthree', 'intro\none\nrewritten\nthree').diff, [{ codex: 'two', claude: 'rewritten' }]);
  assert.equal(sync('one\ntwo\nthree', 'one\nrewritten\nthree').state, '指令不同');
  assert.deepEqual(sync('one\ntwo\nthree', 'one\nthree').diff, [{ codex: 'two', claude: null }]);
  assert.equal(sync('one\ntwo', 'two\none').state, '指令不同');
});
test('v029 3.3 differences are capped at three groups and 200 characters including ellipsis', () => {
  const result = sync(['😀'.repeat(250), 'b', 'c', 'd'].join('\n'), ['改'.repeat(250), 'B', 'C', 'D'].join('\n'), 'x'.repeat(250), 'y'.repeat(250));
  assert.equal(result.state, '描述和指令都不同'); assert.equal(result.diff.length, 3);
  for (const text of [result.diff[0].codex, result.diff[0].claude, result.descriptionDiff.codex, result.descriptionDiff.claude]) {
    assert.equal(Array.from(text).length, 200); assert.ok(text.endsWith('…'));
  }
  assert.equal(sync('one', 'one\nextra', 'a', 'b').state, '描述不同');
});

// One stored ZIP entry is sufficient for the real DOCX reader; all bytes are synthetic.
function reportBytes() {
  const name = Buffer.from('word/document.xml'), content = Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture report body</w:t></w:r></w:p></w:body></w:document>');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}
async function reportFixture(t) {
  const { root } = await fixture(t), directory = path.join(root, 'word'), mappingFile = path.join(root, 'mapping.json');
  await put(mappingFile, JSON.stringify({ directory, agents: {
    mapped: [{ label: 'Mapped Book', prefix: 'Mapped Book' }], missing: [{ label: 'Missing Book', prefix: 'Missing Book' }], empty: [],
  } }));
  for (const name of ['Testing Book-old.docx', 'Testing Book-new.docx', 'Mapped Book-old.docx', 'Mapped Book-new.docx', 'Orphan.docx', 'draft-Orphan.docx', '~$temp.docx']) {
    const file = path.join(directory, name); await put(file, reportBytes());
    const at = new Date(name.includes('-old') ? '2025-01-01' : '2026-01-01'); await fs.utimes(file, at, at);
  }
  const reports = createReports({ directory, mappingFile }); await reports.load();
  return { reports, directory, mappingFile };
}
test('v029 3.4 unmapped single-book report uses full cleaned title and can be read', async t => {
  const { reports } = await reportFixture(t), agent = member('auto', { book: { title: '**《Testing Book》**' } });
  const [entry] = reports.describe(agent.id, agent);
  assert.equal(entry.auto, true); assert.equal(entry.available, true); assert.equal(entry.index, 0); assert.equal(entry.label, 'Testing Book');
  assert.equal(entry.file, 'Testing Book-new.docx');
  assert.match((await reports.read(agent.id, 0, agent)).markdown, /Fixture report body/);
});
test('v029 3.4 multi-book, short-title and explicit empty mappings do not fall back', async t => {
  const { reports } = await reportFixture(t);
  for (const title of ['多书，2 部：《Testing Book》；《Another Book》', '**多书，1 部：《Testing Book》**', '《短书名》', 'A ! B']) {
    const agent = member('auto', { book: { title } }); assert.deepEqual(reports.describe(agent.id, agent), []);
    await assert.rejects(reports.read(agent.id, 0, agent), error => error.status === 404);
  }
  assert.deepEqual(reports.describe('empty', member('empty')), []);
});
test('v029 3.4 coverage ignores old matching reports and working files, and server exposes coverage and auto reads', async t => {
  const { reports, directory, mappingFile } = await reportFixture(t);
  const agents = [member('auto'), member('mapped'), member('missing'), member('absent', { book: { title: 'Absent Book' } }), member('role', { kind: 'role' })];
  const coverage = reports.coverage(agents);
  assert.deepEqual(coverage.booksWithout.map(a => a.id), ['missing', 'absent']);
  assert.deepEqual(coverage.booksWithout[0], { id: 'missing', name: 'missing', title: 'Testing Book' });
  assert.deepEqual(coverage.unusedFiles, ['Orphan.docx']); assert.equal(coverage.directory, directory);
  const h = await harness(t, agents, { reportOptions: { directory, mappingFile } });
  const registry = (await h.request('/api/registry')).value;
  assert.deepEqual(registry.reports, coverage); assert.equal(registry.summary.reportsMissing, 2);
  assert.equal(registry.agents[0].reports[0].auto, true);
  const response = await h.request('/api/reports/auto/0'); assert.equal(response.status, 200); assert.match(response.value.markdown, /Fixture report body/);
});

test('v029 3.5 refresh during a build coalesces one follow-up, includes new files and stays building', async t => {
  const { config } = await fixture(t), firstWrite = deferred(), releaseFirst = deferred(), secondWrite = deferred(), releaseSecond = deferred();
  let writes = 0;
  const stats = createStats(config, [member()], { now: () => instant.getTime(), write: async () => {
    writes++;
    if (writes === 1) { firstWrite.resolve(); await releaseFirst.promise; }
    if (writes === 2) { secondWrite.resolve(); await releaseSecond.promise; }
  } });
  t.after(() => { releaseFirst.resolve(); releaseSecond.resolve(); });
  const first = stats.refresh(); await firstWrite.promise;
  assert.equal(stats.snapshot().perAgent.walvo.launches.total, 0);
  await put(path.join(config.dataDir, 'launches', 'new.json'), JSON.stringify({ launchId: 'new', agentName: 'walvo', cli: 'codex', createdAt: instant.toISOString() }));
  let resolved = false;
  const queued = [stats.refresh(), stats.refresh(), stats.refresh()]; queued[0].then(() => { resolved = true; });
  releaseFirst.resolve(); await secondWrite.promise;
  assert.equal(resolved, false); assert.equal(stats.snapshot().building, true); assert.equal(stats.snapshot().perAgent.walvo.launches.total, 1);
  releaseSecond.resolve(); await Promise.all([first, ...queued]);
  assert.equal(writes, 2); assert.equal(stats.snapshot().building, false); assert.equal(resolved, true);
});
test('v029 3.5 failed first persistence does not discard a queued refresh', async t => {
  const { config } = await fixture(t), entered = deferred(), release = deferred(); let writes = 0;
  const stats = createStats(config, [], { write: async () => { if (++writes === 1) { entered.resolve(); await release.promise; throw Error('first write failed'); } } });
  const first = stats.refresh(); await entered.promise; const next = stats.refresh(); release.resolve();
  await Promise.all([first, next]); assert.equal(writes, 2); assert.equal(stats.snapshot().building, false); assert.equal(stats.snapshot().indexError, undefined);
});
test('v029 3.5 injected stats timer refreshes repeatedly and stops after close', async t => {
  let refreshes = 0;
  const h = await harness(t, [], { statsRefreshMs: 15, statsFactory: () => ({ ...noStats(), refresh: async () => { refreshes++; } }) });
  for (let attempt = 0; attempt < 100 && refreshes < 3; attempt++) await delay(10);
  assert.ok(refreshes >= 3); await h.close(); const afterClose = refreshes;
  await delay(60); assert.equal(refreshes, afterClose);
});
test('v029 3.5 zero interval disables periodic stats refresh', async t => {
  let refreshes = 0;
  const h = await harness(t, [], { statsRefreshMs: 0, statsFactory: () => ({ ...noStats(), refresh: async () => { refreshes++; } }) });
  await delay(50); assert.equal(refreshes, 1); await h.close();
});

const activeRecord = (at, extra = {}) => ({ conceptId: randomUUID(), kind: 'manual', day: '2026-10-21', status: 'running',
  startedAt: at, createdAt: at, pid: 12345, agent: { id: 'walvo' }, perspectives: [], ...extra });
async function conceptEngine(t, records, options = {}) {
  const { config } = await fixture(t); config.concept.timeoutMs = 1000;
  for (const record of records) await put(path.join(config.dataDir, 'concepts', `${record.conceptId}.json`), JSON.stringify(record));
  const engine = createConcepts(config, () => ({ agents: [member(), member('jadra')] }), {
    now: () => instant, isAlive: () => true, runner: neverRun, perspectiveRunner: neverRun, termRunner: neverRun,
    killTree: () => assert.fail('reconciliation must not kill processes'), ...options });
  t.after(() => engine.close()); await engine.recover();
  return { config, engine };
}
test('v029 3.6 stale concept with live PID fails and releases the generation lock', async t => {
  const record = activeRecord(new Date(instant - 601001).toISOString());
  const { config, engine } = await conceptEngine(t, [record]);
  const failed = await engine.get(record.conceptId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, '超时未结束（可能已中断）'); assert.equal(failed.pid, null); assert.equal(failed.finishedAt, instant.toISOString());
  assert.match(await fs.readFile(path.join(config.dataDir, 'logs', 'concepts.log'), 'utf8'), /超时未结束/);
  assert.notEqual((await engine.startManual({ kind: 'manual' })).conceptId, record.conceptId); await engine.idle();
});
test('v029 3.6 fresh records and the exact threshold remain running; missing startedAt falls back to createdAt', async t => {
  const boundary = activeRecord(new Date(instant - 601000).toISOString());
  const stale = activeRecord(new Date(instant - 601001).toISOString(), { startedAt: null, status: 'queued' });
  const { engine } = await conceptEngine(t, [boundary, stale]);
  assert.equal((await engine.get(boundary.conceptId)).status, 'running');
  assert.equal((await engine.get(stale.conceptId)).status, 'failed');
  await assert.rejects(engine.startManual({ kind: 'manual' }), error => error.status === 409);
});
test('v029 3.6 stale perspectives and term backfill fail independently without killing live PIDs', async t => {
  const old = new Date(instant - 601001).toISOString(), fresh = instant.toISOString();
  const record = activeRecord(fresh, { status: 'done', result: { concept: '测试', term: { zh: '测试', en: 'test', fr: 'test' } },
    perspectives: [{ runId: randomUUID(), status: 'running', startedAt: old, pid: 12345 }, { runId: randomUUID(), status: 'running', createdAt: fresh, pid: 12345 }],
    termBackfill: { status: 'running', createdAt: old, pid: 12345 } });
  const { engine } = await conceptEngine(t, [record]); const result = await engine.get(record.conceptId);
  assert.equal(result.status, 'done'); assert.equal(result.perspectives[1].status, 'running');
  for (const item of [result.perspectives[0], result.termBackfill]) {
    assert.equal(item.status, 'failed'); assert.equal(item.error, '超时未结束（可能已中断）'); assert.equal(item.pid, null); assert.equal(item.finishedAt, instant.toISOString());
  }
});
test('v029 3.6 dead-process diagnosis wins over age, and fresh term backfill remains running', async t => {
  const old = activeRecord(new Date(instant - 601001).toISOString());
  const { engine } = await conceptEngine(t, [old], { isAlive: () => false });
  assert.equal((await engine.get(old.conceptId)).error, '进程中断');
  const term = activeRecord(instant.toISOString(), { status: 'done', result: { concept: 'x', term: {} }, termBackfill: { status: 'running', startedAt: instant.toISOString(), pid: 12345 } });
  const other = await conceptEngine(t, [term]); assert.equal((await other.engine.get(term.conceptId)).termBackfill.status, 'running');
});
test('v029 3.6 stale queued term work ages out without being launched', async t => {
  const record = activeRecord(instant.toISOString(), { status: 'done', result: { concept: 'fixture' },
    termBackfill: { status: 'queued', createdAt: new Date(instant - 601001).toISOString(), pid: null } });
  let runs = 0;
  const { engine } = await conceptEngine(t, [record], { isAlive: () => false, termRunner: async () => { runs++; throw Error('must not run'); } });
  const result = (await engine.get(record.conceptId)).termBackfill;
  assert.equal(result.status, 'failed'); assert.equal(result.error, '超时未结束（可能已中断）'); assert.equal(runs, 0);
});
test('v029 3.6 a local controller protects an ongoing generation even after the age threshold', async t => {
  let at = instant; const started = deferred(), release = deferred();
  const { engine } = await conceptEngine(t, [], { now: () => at, runner: async () => { started.resolve(); await release.promise; throw Error('fixture finish'); } });
  t.after(() => release.resolve());
  const { conceptId } = await engine.startManual({ kind: 'manual' }); await started.promise;
  at = new Date(instant.getTime() + 1000000); await engine.recover();
  assert.equal((await engine.get(conceptId)).status, 'running'); release.resolve(); await engine.idle();
});
for (const [age, isAlive, expected] of [[601001, true, '超时未结束（可能已中断）'], [601000, true, null], [601001, false, '进程中断']]) {
  test(`v029 3.6 seminar reconciliation age=${age}, alive=${isAlive}`, async t => {
    const { config } = await fixture(t); config.seminar.timeoutMs = 1000;
    const record = { seminarId: randomUUID(), status: 'running', createdAt: new Date(instant - age).toISOString(), startedAt: null, pid: 12345 };
    await put(path.join(config.dataDir, 'seminars', `${record.seminarId}.json`), JSON.stringify(record));
    const engine = createSeminars(config, () => ({ agents: [member(), member('jadra'), member('calo')] }), {
      now: () => instant, isAlive: () => isAlive, runner: neverRun, killTree: () => assert.fail('must not kill a recovered PID') });
    t.after(() => engine.close()); await engine.recover(); const result = await engine.get(record.seminarId);
    assert.equal(result.status, expected ? 'failed' : 'running');
    if (expected) {
      assert.equal(result.error, expected); assert.equal(result.pid, null); assert.equal(result.finishedAt, instant.toISOString());
      assert.ok((await fs.readFile(path.join(config.dataDir, 'logs', 'seminars.log'), 'utf8')).includes(expected));
      assert.ok((await engine.start({ input: 'fixture topic' })).seminarId); await engine.idle();
    } else assert.equal((await engine.list()).active, 1, 'a live, unexpired seminar still counts toward the limit');
  });
}

test('v029 3.7 exists is logged once per day and status transitions log again', async t => {
  const record = activeRecord(instant.toISOString(), { kind: 'daily' });
  const { config, engine } = await conceptEngine(t, [record]);
  for (let i = 0; i < 3; i++) assert.equal((await engine.ensureDaily(instant)).status, 'exists');
  const logFile = path.join(config.dataDir, 'logs', 'concepts.log');
  assert.equal((await fs.readFile(logFile, 'utf8')).trim().split('\n').length, 1);
  for (let i = 0; i < 3; i++) assert.equal((await engine.ensureDaily(new Date('2026-10-21T00:00:00Z'))).status, 'not-due');
  await engine.ensureDaily(instant);
  assert.equal((await fs.readFile(logFile, 'utf8')).trim().split('\n').length, 3);
});
test('v029 3.7 busy is deduplicated and failures are always logged', async t => {
  const record = activeRecord(instant.toISOString()); const { config, engine } = await conceptEngine(t, [record]);
  for (let i = 0; i < 3; i++) assert.equal((await engine.ensureDaily(instant)).status, 'busy');
  assert.equal((await fs.readFile(path.join(config.dataDir, 'logs', 'concepts.log'), 'utf8')).trim().split('\n').length, 1);
  const failed = activeRecord(instant.toISOString(), { kind: 'daily', status: 'failed', attempt: 3, error: 'fixture failure' });
  const other = await conceptEngine(t, [failed]);
  await other.engine.ensureDaily(instant); await other.engine.ensureDaily(instant);
  assert.equal((await fs.readFile(path.join(other.config.dataDir, 'logs', 'concepts.log'), 'utf8')).trim().split('\n').length, 2);
});
test('v029 3.7 custom log filename rotates and default server.log remains available', async t => {
  const { config } = await fixture(t), file = path.join(config.dataDir, 'logs', 'concepts.log');
  const log = createLogger(config.dataDir, { file: 'concepts.log', limit: 120 });
  await log('a'.repeat(70)); await log('second');
  assert.match(await fs.readFile(file + '.1', 'utf8'), /aaaa/); assert.match(await fs.readFile(file, 'utf8'), /second/);
  await createLogger(config.dataDir)('default'); assert.match(await fs.readFile(path.join(config.dataDir, 'logs', 'server.log'), 'utf8'), /default/);
});
test('v029 3.7 concept module rotates its own log at the default 5 MB limit', async t => {
  const record = activeRecord(instant.toISOString(), { kind: 'daily' }); const { config, engine } = await conceptEngine(t, [record]);
  const file = path.join(config.dataDir, 'logs', 'concepts.log'); await put(file, 'x'.repeat(5 * 1024 * 1024 + 1));
  await engine.ensureDaily(instant);
  assert.equal((await fs.stat(file + '.1')).size, 5 * 1024 * 1024 + 1); assert.match(await fs.readFile(file, 'utf8'), /daily exists/);
});

for (const cli of ['claude', 'codex']) test(`v029 3.8 ${cli} writable single launch requires strict confirmation, read-only does not`, async t => {
  const h = await harness(t, [member('writer', { writable: true }), member('reader')]);
  for (const writableConfirmed of [undefined, false, 'true']) {
    const response = await h.request('/api/launch', { agentId: 'writer', cli, writableConfirmed });
    assert.equal(response.status, 409); assert.equal(response.value.error, '存在可写 Agent，请先确认权限');
    assert.deepEqual(response.value.writable, [{ id: 'writer', name: 'writer' }]);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request('/api/launch', { agentId: 'writer', cli, writableConfirmed: true })).status, 200);
  assert.equal((await h.request('/api/launch', { agentId: 'reader', cli })).status, 200); assert.equal(h.calls.length, 2);
});
for (const cli of ['claude', 'codex']) test(`v029 3.8 ${cli} single resume rechecks writable confirmation with real fixture session evidence`, async t => {
  const h = await harness(t, [member('writer', { writable: true }), member('reader')]);
  for (const id of ['writer', 'reader']) {
    const launch = await h.request('/api/launch', { agentId: id, cli, writableConfirmed: true }); assert.equal(launch.status, 200);
    const record = JSON.parse(await fs.readFile(path.join(h.config.dataDir, 'launches', `${launch.value.launchId}.json`), 'utf8'));
    const session = randomUUID(), file = path.join(h.root, `${session}.jsonl`);
    await jsonl(file, [cli === 'claude' ? { sessionId: session } : { type: 'session_meta', payload: { id: session } }]);
    await h.app.sessions.register('launch', record, { overall: 'historical', session: { id: session, file } });
    const body = { type: 'launch', agentId: id, launchId: record.launchId };
    if (id === 'writer') {
      const count = h.calls.length;
      const denied = await h.request('/api/resume', body); assert.equal(denied.status, 409);
      assert.deepEqual(denied.value.writable, [{ id, name: id }]); assert.equal(denied.value.error, '存在可写 Agent，请先确认权限');
      assert.equal(h.calls.length, count);
      assert.equal((await h.request('/api/resume', { ...body, writableConfirmed: true })).status, 200);
    } else assert.equal((await h.request('/api/resume', body)).status, 200);
  }
});

test('v029 acceptance: a missing unquoted book path is reported whole, not cut at "J. Author"', async () => {
  const file = String.raw`D:\work\Reading\ai\未处理\A Sample Book (Pat J. Author, Ph.D.) (scan 1, scan 2, scan 3).epub`;
  const escaped = file.replaceAll('\\', '\\\\');
  const result = await checkSources(`SOURCE: ${file}\n{"op":"lookup","source":"${escaped}","locator":"S01"}`, { exists: async () => false });
  assert.deepEqual(result.missing, [file]);
  assert.equal(result.total, 1);
});
