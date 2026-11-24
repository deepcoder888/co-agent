import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, put } from './fixtures/helpers.mjs';
import { atomicWrite } from '../src/fsutil.mjs';
import { createReports } from '../src/reports/index.mjs';
import { chapterMarkdown, openEpub } from '../src/books/epub.mjs';
import { createBooks } from '../src/books/index.mjs';
import { parseXml } from '../src/reports/docx.mjs';
import { renderMarkdown } from '../public/markdown.js';
import { appDocument } from './fixtures/app.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runJsonProcess, validateConcept } from '../src/concepts/runner.mjs';
import { createCandidates, readAdditions, suggestionPrompt, suggestionSchema } from '../src/registry/candidates.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { mountCandidates } from '../public/candidates.js';
import { mountApp } from '../public/app.js';
import { createApp } from '../src/server.mjs';
import { verifyResume } from '../src/launch/resume.mjs';

test('v043 #1 installer retries transient locks with increasing bounded delays and preserves the original failure', async t => {
  const { root } = await fixture(t), from = path.join(root, 'package'), runner = path.join(root, 'retry.ps1');
  for (const file of ['CO-AGENT.exe', 'resources/app/src/server.mjs', 'resources/app/package.json']) await put(path.join(from, file), 'fixture');
  await put(runner, String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
. (Join-Path $env:CO_TEST_REPO 'scripts/uninstall.ps1')
$target = Join-Path $env:CO_TEST_ROOT 'install'
$env:CO_AGENT_DATA_DIR = Join-Path $env:CO_TEST_ROOT 'data'
$exe = Join-Path $target 'CO-AGENT.exe'
$marker = Join-Path $target '.co-agent-install.json'
$sleeps = [Collections.Generic.List[int]]::new()
$attempts = [Collections.Generic.List[string]]::new()
$deps = @{ Processes = { @() }; Sleep = { param($ms) $sleeps.Add($ms) } }
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $target -NoShortcuts -Dependencies $deps
$deps.Remove = { param($file)
  if ($file -eq $exe) { $attempts.Add($file); if ($attempts.Count -le 2) { throw [UnauthorizedAccessException]::new('original locked exe') } }
  Remove-Item -LiteralPath $file -Recurse -Force -ErrorAction Stop
}
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $target -NoShortcuts -Dependencies $deps
$recovered = @{attempts=$attempts.Count;delays=@($sleeps.ToArray());exe=(Test-Path -LiteralPath $exe)}
$sleeps.Clear(); $attempts.Clear()
$deps.Remove = { param($file)
  if ($file -eq $exe) { $attempts.Add($file); throw [IO.IOException]::new('original persistent lock') }
  Remove-Item -LiteralPath $file -Recurse -Force -ErrorAction Stop
}
$message = ''
try { Uninstall-CoAgent -InstallDir $target -NoShortcuts -Yes -Dependencies $deps } catch { $message = $_.Exception.Message }
$failed = @{message=$message;attempts=$attempts.Count;delays=@($sleeps.ToArray());marker=(Test-Path -LiteralPath $marker);exe=(Test-Path -LiteralPath $exe)}
$sleeps.Clear(); $attempts.Clear()
$deps.Remove = { param($file) $attempts.Add($file); throw [ArgumentException]::new('not transient') }
$fatal = ''
try { Uninstall-CoAgent -InstallDir $target -NoShortcuts -Yes -Dependencies $deps } catch { $fatal = $_.Exception.Message }
@{recovered=$recovered;failed=$failed;fatal=$fatal;fatalAttempts=$attempts.Count;fatalSleeps=$sleeps.Count} | ConvertTo-Json -Depth 5
`);
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root, CO_TEST_FROM: from },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n{') + 1));
  assert.equal(value.recovered.attempts, 3); assert.equal(value.recovered.exe, true);
  assert.deepEqual(value.recovered.delays, [250, 500]);
  assert.equal(value.failed.message, 'original persistent lock');
  assert.equal(value.failed.marker, true); assert.equal(value.failed.exe, true);
  assert.equal(value.failed.attempts, value.failed.delays.length + 1);
  assert.ok(value.failed.delays.reduce((n, ms) => n + ms, 0) <= 10000);
  assert.ok(value.failed.delays.length > 2 && value.failed.delays.length < 10);
  assert.ok(value.failed.delays.every((ms, i, all) => !i || ms > all[i - 1]));
  assert.equal(value.fatal, 'not transient'); assert.equal(value.fatalAttempts, 1); assert.equal(value.fatalSleeps, 0);
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) test(`v043 #2 atomicWrite retries ${code} then writes exact contents`, async t => {
  const { config } = await fixture(t), file = path.join(config.dataDir, 'record.json');
  const error = Object.assign(new Error('original locked rename'), { code }); let calls = 0;
  await atomicWrite(file, 'old');
  await atomicWrite(file, 'new', { rename: async (...args) => { if (++calls <= 2) throw error; return fs.rename(...args); } });
  assert.equal(calls, 3); assert.equal(await fs.readFile(file, 'utf8'), 'new');
  assert.deepEqual(await fs.readdir(config.dataDir), ['record.json']);
});
test('v043 #2 atomicWrite exhaustion keeps the original error and content; nontransient errors do not retry; EXDEV still copies', async t => {
  const { config } = await fixture(t), file = path.join(config.dataDir, 'record.json');
  await atomicWrite(file, 'old');
  for (const code of ['EPERM', 'ENOENT']) {
    let calls = 0; const error = Object.assign(new Error('original ' + code), { code });
    await assert.rejects(atomicWrite(file, 'new', { rename: async () => { calls++; throw error; } }), e => e === error);
    assert.equal(calls, code === 'EPERM' ? 6 : 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(config.dataDir), ['record.json']);
  }
  let calls = 0;
  await atomicWrite(file, 'copied', { rename: async () => { calls++; throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); } });
  assert.equal(calls, 1); assert.equal(await fs.readFile(file, 'utf8'), 'copied');
  assert.deepEqual(await fs.readdir(config.dataDir), ['record.json']);
});

test('v043 #3 report fallback tries full title before the main title, supports four separators, and preserves explicit mapping', async t => {
  const { root } = await fixture(t), directory = path.join(root, 'word'), mappingFile = path.join(root, 'mapping.json');
  const report = epubFixture([], [['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>']]);
  const pairs = [
    ['huvo', 'AI Sampling: Making Samples from Example Parts', 'AI Sampling'],
    ['klevo', 'Rivers of Samples：How Samples Find Paths', 'Rivers of Samples'],
    ['benrow', 'The Reading of Sample Pages - The Plain Sample Edition', 'The Reading of Sample Pages'],
    ['chanto', 'The Weight of Samples — The Short Story of Samples', 'The Weight of Samples'],
  ];
  await put(mappingFile, JSON.stringify({ agents: { mapped: [{ label: 'explicit', prefix: 'Only mapped' }] } }));
  for (const [, , title] of pairs) await put(path.join(directory, title + '-deepbooker.docx'), report);
  await put(path.join(directory, 'AI-deepbooker.docx'), 'short');
  const reports = createReports({ mappingFile, directory }); await reports.load();
  const agents = pairs.map(([id, title]) => ({ id, kind: 'book', book: { title } }));
  for (const [i, agent] of agents.entries()) {
    const entries = reports.describe(agent.id, agent);
    assert.equal(entries.length, 1); assert.equal(entries[0].file, pairs[i][2] + '-deepbooker.docx');
  }
  assert.deepEqual(reports.coverage(agents).unusedFiles, ['AI-deepbooker.docx']);
  assert.equal(reports.describe('short', { book: { title: 'AI: A very long subtitle' } })[0].available, false);
  assert.equal(reports.describe('mapped', agents[0])[0].available, false);
  const full = 'AI Sampling Making Samples from Example Parts-deepbooker.docx';
  await put(path.join(directory, full), report); await fs.utimes(path.join(directory, full), new Date(0), new Date(0));
  assert.equal((await reports.read('huvo', 0, agents[0])).file, full, 'read refreshes files before selecting the fallback');
  await reports.load(); assert.equal(reports.describe('huvo', agents[0])[0].file, full, 'full title takes precedence over newer main-title matches');
});

test('v043 #4 EPUB entities decode exactly once in text, attributes and code while Word XML stays unchanged', async () => {
  const md = chapterMarkdown('<body><p>A&nbsp;B / &amp;nbsp; / &amp;amp; / &#39; / &mdash; / &amp;mdash;</p><pre>&nbsp; &amp;nbsp;</pre><p><img src="a.png" alt="&amp;nbsp;"/></p></body>', 'c.xhtml');
  assert.match(md, /A B \/ &nbsp; \/ &amp; \/ ' \/ — \/ &mdash;/);
  assert.match(md, /```\n  &nbsp;\n```/);
  assert.match(md, /!\[&nbsp;\]/);
  const { doc } = await appDocument();
  doc.createTextNode = text => { const node = doc.createElement('text'); node.textContent = text; return node; };
  assert.match(renderMarkdown(doc, md).textContent, /&nbsp; \/ &amp;/, 'the reader preserves literal ampersands through text nodes');
  const xml = parseXml('<p>&amp;nbsp; &nbsp; &amp;amp;</p>');
  assert.equal(xml.children[0].children[0].text, '&nbsp; &nbsp; &amp;');
});

// Tiny stored ZIP fixture: no CLI, library or real source-book mutation.
function epubFixture(chapters, extra = []) {
  const files = [
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'],
    ['book.opf', `<package><metadata><title>Fixture &amp;nbsp;</title></metadata><manifest>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`],
    ...chapters.map((body, i) => [`c${i}.xhtml`, `<html><body>${body}</body></html>`]), ...extra,
  ];
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), bytes = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(bytes.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(bytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, bytes, data); centrals.push(central, bytes); offset += local.length + bytes.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('v043 #5 EPUB fallback outline deduplicates h1-h3 in source order, ignores empty/long headings and requires three', async t => {
  const headings = ['<h1>第一章</h1><h2> </h2>', '<h2>第二章</h2><h1>第一章</h1>', `<h3>第三章</h3><h2>${'长'.repeat(81)}</h2><h4>不收录</h4>`];
  const bytes = epubFixture(headings), book = openEpub(bytes);
  // v0.53.14: a heading's own id would be its anchor; these headings have none.
  assert.deepEqual(book.toc, [{ title: '第一章', chapter: 0, depth: 0, anchor: '' }, { title: '第二章', chapter: 1, depth: 0, anchor: '' }, { title: '第三章', chapter: 2, depth: 1, anchor: '' }]);
  assert.deepEqual(book.chapters.map(c => c.title), ['第一章', '第二章', '第三章']);
  assert.deepEqual(openEpub(epubFixture(headings.slice(0, 2))).toc, []);
  const { config, root } = await fixture(t), file = path.join(root, 'cached.epub'); await fs.writeFile(file, bytes);
  let reads = 0;
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => ({ agents: [{ id: 'book', kind: 'book', bookFiles: [{ path: file }] }] }),
    io: { ...fs, readFile: (...args) => { if (args[0] === file) reads++; return fs.readFile(...args); } } });
  assert.deepEqual((await books.info('book', 0)).toc, book.toc);
  assert.deepEqual((await books.info('book', 0)).toc, book.toc); assert.equal(reads, 1, 'info reuses the opened book and generated outline');
});

const validConcept = () => ({ concept: '复利', conceptEn: 'Compounding', oneLine: '一句话', whyUnknown: '原因', sourceRefs: ['第1章'], markdown: '正文',
  term: { zh: '复利', en: 'Compounding', fr: 'Capitalisation' }, response: { stance: '无', text: '' } });
for (const field of ['concept', 'conceptEn', 'oneLine', 'whyUnknown', 'sourceRefs', 'markdown', 'term']) {
  test(`v043 #6 concept identifies missing ${field}`, () => {
    const value = validConcept(); delete value[field];
    assert.throws(() => validateConcept(value), new RegExp(`概念 JSON 格式无效：${field} 缺失`));
  });
}
for (const field of ['concept', 'conceptEn', 'oneLine', 'whyUnknown', 'sourceRefs', 'markdown']) {
  test(`v043 #6 concept identifies wrong type and empty ${field}`, () => {
    assert.throws(() => validateConcept({ ...validConcept(), [field]: 4 }), new RegExp(`概念 JSON 格式无效：${field} 类型错误`));
    assert.throws(() => validateConcept({ ...validConcept(), [field]: field === 'sourceRefs' ? [] : ' ' }), new RegExp(`概念 JSON 格式无效：${field} 为空`));
  });
}
test('v043 #6 concept reports the first bad source ref; term/response defects remain local', () => {
  assert.throws(() => validateConcept({ ...validConcept(), sourceRefs: ['chapter', 2] }), /sourceRefs\[1\] 类型错误/);
  assert.throws(() => validateConcept({ ...validConcept(), sourceRefs: [' '] }), /sourceRefs\[0\] 为空/);
  assert.throws(() => validateConcept({ ...validConcept(), surprise: true }), /surprise 未知字段/);
  assert.throws(() => validateConcept(null), /概念 JSON 格式无效：根对象 类型错误/);
  for (const bad of [null, 'bad', {}, { zh: '复利', en: 2, fr: 'f' }]) assert.equal(validateConcept({ ...validConcept(), term: bad }).term, null);
  const missingResponse = validConcept(); delete missingResponse.response;
  assert.match(validateConcept(missingResponse).responseError, /回应格式无效/);
  for (const bad of [null, {}, { stance: '无', text: 2 }]) assert.match(validateConcept({ ...validConcept(), response: bad }).responseError, /回应格式无效/);
});

// Exact stderr from the 2026-10-22 09:00 and 10:00 local runs; stdout supplies the routing failure.
const transportLine = 'worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (https://chatgpt.com/backend-api/ps/mcp)")))';
const stderrSamples = [
  ['2026-10-22T01:00:49.801310Z', '2026-10-22T01:00:52.920911Z', '2026-10-22T01:01:06.192255Z', '2026-10-22T01:01:31.120823Z', '2026-10-22T01:02:01.096609Z', '2026-10-22T01:05:25.061284Z'],
  ['2026-10-22T02:00:34.694645Z', '2026-10-22T02:00:39.618156Z', '2026-10-22T02:00:49.624304Z', '2026-10-22T02:01:12.152059Z', '2026-10-22T02:01:42.030640Z'],
].map(times => times.map((stamp, i) => `${stamp} ERROR ${i === 3 || i === 4 ? 'rmcp::transport::worker: ' + transportLine : 'codex_models_manager::manager: failed to refresh available models: request timed out'}`).join('\n') + '\n');
async function failedProcess(t, namespace, stdout, stderr) {
  const { config } = await fixture(t), id = 'fixture-error';
  const spawnImpl = () => {
    const child = new EventEmitter(); Object.assign(child, { pid: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.once('finish', () => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', 1); });
    return child;
  };
  let message;
  await assert.rejects(runJsonProcess({ id, namespace, prompt: 'fixture', schema: {}, timeoutMs: 10000, label: 'fixture' }, config, { spawnImpl }), error => { message = error.message.split('：').slice(1).join('：'); return true; });
  for (const [file, text] of [['stdout', stdout], ['stderr', stderr]]) assert.equal(await fs.readFile(path.join(config.dataDir, namespace, 'work', id, file + '.txt'), 'utf8'), text);
  return message;
}
for (const [i, stderr] of stderrSamples.entries()) test(`v043 #6 process error ${i + 1} strips duplicate log prefixes, limits diagnostics and retains full logs`, async t => {
  const message = await failedProcess(t, i ? 'seminars' : 'concepts', '', stderr);
  assert.match(message, /request timed out/); assert.ok(Array.from(message).length <= 300, message);
  assert.doesNotMatch(message, /2026-10-22T|codex_models_manager|rmcp::transport/);
  assert.equal(message.match(/request timed out/g).length, 1);
});
test('v043 #6 turn.failed wins over error events and stderr, and long structured errors are bounded', async t => {
  const stdout = JSON.stringify({ type: 'turn.failed', error: { message: 'workspace routing discovery timed out' + '原'.repeat(400) } }) + '\n' + JSON.stringify({ type: 'error', message: 'less specific' });
  const message = await failedProcess(t, 'concepts', stdout, stderrSamples[0]);
  assert.match(message, /^workspace routing discovery timed out/); assert.ok(Array.from(message).length <= 300);
  assert.equal(await failedProcess(t, 'seminars', JSON.stringify({ type: 'error', message: 'request timed out' }), stderrSamples[1]), 'request timed out');
});

const goodBlurb = '有关学习方法与知识积累的详细信息。研读这本书可以掌握检验理解与改进练习的方法。';
test('v043 #7 candidate runner blurb survives suggestion, UI acceptance, persistence and registry; old entries stay valid', async t => {
  // After hooks run in registration order: close the store before the fixture folder is removed.
  let store; t.after(() => store?.close());
  const { config } = await fixture(t);
  for (const name of ['NewBook', 'Legacy']) await put(path.join(config.codexAgentsDir, name + '.toml'), `name="${name}"\ndescription="edition-bound book Agent"\ndeveloper_instructions="fixture"`);
  const categories = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json', 'utf8')).categories;
  const legacy = { agent: 'Legacy', title: '旧书', author: '作者', edition: '中文', primary: categories[0], tags: [] };
  await put(path.join(config.dataDir, 'book-additions.json'), JSON.stringify({ version: 1, books: [legacy] }));
  let registry = await buildRegistry(config);
  store = createCandidates(config, () => registry, { runner: async () => ({ items: [{ id: 'newbook', title: '新书', author: '作者', edition: '中文', primary: categories[0], blurb: goodBlurb }] }),
    linkIO: { lstat: async () => { throw Object.assign(Error('fixture no link'), { code: 'ENOENT' }); } }, onChanged: async () => { registry = await buildRegistry(config); } });
  const { doc } = await appDocument();
  const ui = mountCandidates(doc, { getRegistry: () => registry, notify() {}, onChanged: async () => {}, api: (url, body) => url.endsWith('/suggest') ? store.suggest(body) : store.accept(body) });
  t.after(() => ui.dispose());
  await ui.open(); assert.equal(doc.getElementById('candidate-accept').disabled, false);
  await doc.getElementById('candidate-accept').fire('click');
  assert.equal(registry.agents.find(a => a.id === 'newbook')?.book.blurb, goodBlurb);
  const saved = await readAdditions(config);
  assert.equal(saved.books.find(b => b.agent === 'NewBook').blurb, goodBlurb); assert.deepEqual(saved.books.find(b => b.agent === 'Legacy'), legacy);
  assert.ok(suggestionSchema(categories).properties.items.items.required.includes('blurb'));
  assert.match(suggestionPrompt([], categories, []), /28[–—-]60/);
});
test('v043 #7 invalid candidate blurbs are discarded without rejecting the book; bundled blurbs win', async t => {
  const { config } = await fixture(t), categories = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json', 'utf8')).categories;
  for (const [i, blurb] of [null, 3, '', '短', goodBlurb + 'English', goodBlurb.replace('学习方法', '《学习方法》'), goodBlurb.replace('学习方法', '“学习方法”'), '有关' + '长'.repeat(70) + '的详细信息。研读这本书可以学习。'].entries()) {
    const name = 'New' + i, id = name.toLowerCase(); await put(path.join(config.codexAgentsDir, name + '.toml'), `name="${name}"\ndescription="book Agent"`);
    const store = createCandidates(config, () => ({ candidates: [{ id, name }], categories, agents: [] }), { linkIO: { lstat: async () => { throw Error('fixture'); } } });
    const result = await store.accept({ items: [{ id, title: '新书', author: '作者', edition: '中文', primary: categories[0], blurb }] });
    assert.equal(result.items[0].accepted, true); await store.close();
  }
  const additions = await readAdditions(config); assert.ok(additions.books.every(b => !b.blurb));
  const r = await buildRegistry(config); assert.equal(r.agents.length, 8); assert.ok(r.agents.every(a => !a.book.blurb));
  await put(path.join(config.codexAgentsDir, 'Clemo.toml'), 'name="Clemo"\ndescription="book Agent"');
  additions.books.push({ agent: 'Clemo', title: '书', author: '人', edition: '中文', primary: categories[0], tags: [], blurb: goodBlurb });
  await put(path.join(config.dataDir, 'book-additions.json'), JSON.stringify(additions));
  const bundled = JSON.parse(await fs.readFile('test/fixtures/catalog/book-blurbs.json', 'utf8')).blurbs;
  assert.equal((await buildRegistry(config)).agents.find(a => a.id === 'clemo').book.blurb, bundled.clemo || bundled.Clemo);
});

test('v043 #8 narrow inspection measures the card, keeps the book above it, remeasures on resize, and retains wide/fallback poses', async t => {
  // Same WAAPI/layout shim as v038 turningShelf, with measured card dimensions and resize events.
  const { doc } = await appDocument('shelf'), resize = []; let cardHeight = 310, measurements = 0;
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag), classes = () => el.className.split(/\s+/).filter(Boolean), write = list => { el.className = list.join(' '); };
    el.classList = { add: (...c) => write([...new Set([...classes(), ...c])]), remove: (...c) => write(classes().filter(x => !c.includes(x))),
      toggle: (c, on) => { const want = on ?? !classes().includes(c); write(want ? [...new Set([...classes(), c])] : classes().filter(x => x !== c)); return want; },
      replace: (a, b) => write(classes().map(x => x === a ? b : x)), contains: c => classes().includes(c) };
    el.animate = () => ({ finished: Promise.resolve(), cancel() {} });
    el.getBoundingClientRect = () => {
      if (el.id === 'book-inspect') { measurements++; return { height: cardHeight, width: 560, top: doc.defaultView.innerHeight * .95 - cardHeight }; }
      return { left: 100, top: 300, width: 52, height: 240, right: 152, bottom: 540 };
    };
    Object.defineProperty(el, 'offsetHeight', { value: 240 }); Object.defineProperty(el, 'offsetWidth', { value: 52 });
    return el;
  };
  doc.defaultView = { innerWidth: 820, innerHeight: 640, matchMedia: () => ({ matches: true }),
    addEventListener: (name, fn) => { if (name === 'resize') resize.push(fn); },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '18px', maxWidth: '' }) };
  const agent = { id: 'book', name: 'Book', kind: 'book', primary: '学习', book: { title: '书', author: '作者', blurb: goodBlurb }, tags: [],
    platforms: { codex: { available: true }, claude: { available: true } }, sources: { missing: [] }, permissions: {}, sync: { state: '同步' } };
  const registry = { agents: [agent], categories: ['学习'], summary: { roles: 0, books: 1 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  const app = await mountApp(doc, async url => ({ ok: true, json: async () => url === '/api/registry' ? registry
    : url === '/api/settings' ? { ui: 'shelf', recommend: { claude: {}, codex: {} } }
    : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
    : url === '/api/pins' ? { ids: [] } : { items: [], unavailable: [], running: null, today: {} } }));
  t.after(() => app.dispose());
  await doc.querySelector('.book-spine').fire('click'); await new Promise(setImmediate);
  const book = doc.querySelector('.book-3d');
  const fits = () => {
    const [, x, y, scale] = book.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/).map(Number);
    assert.equal(x + 129, doc.defaultView.innerWidth / 2);
    assert.ok(scale >= .5 && scale <= .72);
    const top = doc.defaultView.innerHeight * .95 - cardHeight;
    assert.ok(y + 190 + 380 * scale / 2 <= top, `${book.style.transform}; card top ${top}`);
    assert.ok(y + 190 - 380 * scale / 2 >= 0, 'book fits above the card');
  };
  fits(); assert.ok(measurements > 0);
  cardHeight = 360; doc.defaultView.innerHeight = 700; const previous = measurements;
  resize.forEach(fn => fn()); fits(); assert.ok(measurements > previous);
  doc.defaultView.innerWidth = 1440; doc.defaultView.innerHeight = 960; resize.forEach(fn => fn());
  assert.match(book.style.transform, /^translate\(303px,278px\) scale\(1\)/);
  cardHeight = 0; doc.defaultView.innerWidth = 820; doc.defaultView.innerHeight = 640; resize.forEach(fn => fn());
  assert.match(book.style.transform, /^translate\(281px,40\.39999999999998px\) scale\(0\.72\)/);
});

test('v043 #9 all book endpoints decode ids exactly once and malformed escapes are 404, including report ids containing percent escapes', async t => {
  let app; t.after(() => app?.close());
  const { config, root } = await fixture(t), file = path.join(root, 'source.epub'), directory = path.join(root, 'word'), mappingFile = path.join(root, 'mapping.json');
  await fs.writeFile(file, epubFixture(['<p>正文</p>']));
  // This stored ZIP also contains a minimal Word document for the reports endpoint.
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'Fixture.docx'), epubFixture([], [['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>']]));
  const ids = ['老子', 'two words', 'literal%20id', 'literal%E0%A4%A'];
  await put(mappingFile, JSON.stringify({ agents: Object.fromEntries(ids.map(id => [id, [{ label: 'fixture', prefix: 'Fixture' }]])) }));
  const agents = ids.map(id => ({ id, name: id, kind: 'book', primary: '学习', tags: [], book: { title: '书' }, bookFiles: [{ path: file, ext: 'epub' }] }));
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents, categories: [], sources: [], summary: {} }), reportOptions: { mappingFile, directory } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const endpoints = [['books', 'GET', '/0'], ['book-facts', 'GET', ''], ['reading-time', 'POST', ''], ['reading-progress', 'PUT', ''], ['reading-progress', 'GET', ''], ['reports', 'GET', '/0']];
  for (const rawId of [...ids.map(encodeURIComponent), '%E0%A4%A']) for (const [route, method, suffix] of endpoints) {
    const response = await fetch(`${base}/api/${route}/${rawId}${suffix}`, { method, ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token },
      body: JSON.stringify(route === 'reading-time' ? { seconds: 2, active: true } : { index: 0, chapter: 0, ratio: .5 }) } : {}) });
    assert.equal(response.status, rawId === '%E0%A4%A' ? 404 : 200, `${route}/${rawId}: ${await response.text()}`);
  }
});

test('v043 #10 unchanged resume baseline with submillisecond mtime is pending, then appended evidence is resumed', async t => {
  const { config, root } = await fixture(t), file = path.join(root, 'session.jsonl'), id = 'fixture-session';
  await put(file, JSON.stringify({ sessionId: id }) + '\n');
  // Windows file timestamps have finer precision than the ISO createdAt timestamp.
  await fs.utimes(file, 1700000000.0005, 1700000000.0005);
  const stat = await fs.stat(file), createdAt = new Date(Math.floor(stat.mtimeMs)).toISOString();
  assert.ok(stat.mtimeMs > Date.parse(createdAt), 'fixture reproduces the fractional-millisecond boundary');
  const record = { cli: 'claude', sessionId: id, sessionFile: file, createdAt, cwd: root, pid: 42, resumeBaseline: { size: stat.size, mtimeMs: stat.mtimeMs } };
  const options = { isAlive: () => true, now: Date.parse(createdAt) };
  assert.equal((await verifyResume(record, config, options)).overall, 'pending');
  await fs.appendFile(file, JSON.stringify({ sessionId: id, type: 'user', message: { content: '追问' } }) + '\n');
  assert.equal((await verifyResume(record, config, options)).overall, 'resumed');
});
