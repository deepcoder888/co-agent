import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { createBooks, bookLang, IDLE_LIMIT_S } from '../src/books/index.mjs';
import { measureText, markdownText, pdfPageCount, fileFacts, bookFacts } from '../src/books/facts.mjs';
import { readSettings, writeSettings } from '../src/settings.mjs';
import { categoryGlyphs, readingLine, blurbOf } from '../public/layouts/shelf.js';
import { mountBookReader, BEAT_MS } from '../public/book-reader.js';
import { mountSettings } from '../public/settings.js';

// v0.42 书本检视 (2026-11-01): beside the pulled-out book, a game-style card with the category glyphs, the title, a
// two-sentence description written by Codex, 已研读 x.x 小时，共需 n 小时 and the weight by page count; a settings slider sizes it.
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const epub = text => zip([
  ['mimetype', 'application/epub+zip'],
  ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'],
  ['c.opf', '<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'],
  ['a.xhtml', `<html><body><p>${text}</p><p><img src="x.png" alt="图片说明文字"/></p></body></html>`],
]);
// A PDF whose page tree sits in a compressed object stream, as in most books exported since PDF 1.5.
const packedPdf = pages => Buffer.concat([Buffer.from('%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\n', 'latin1'),
  zlib.deflateSync(Buffer.from(`2 0 << /Type /Pages /Kids [3 0 R] /Count ${pages} >>`, 'latin1')), Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')]);

test('v042 facts: PDF pages from the page tree (plain or packed), EPUB text by language, weight and hours', () => {
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count 312 >> endobj\n2 0 obj << /Type /Outlines /Count 9 >> endobj', 'latin1')), 312);
  assert.equal(pdfPageCount(packedPdf(472)), 472, 'the page tree inside an object stream');
  assert.equal(pdfPageCount(Buffer.from('<< /Type /Page >> << /Type /Page >> << /Type /Pages >>', 'latin1')), 2, 'no /Count: the leaves are counted');
  assert.deepEqual(measureText('示例工坊 deep work 很重要'), { chars: 7, words: 2, lang: 'zh' });
  assert.equal(measureText('A plain English sentence with 中文').lang, 'en');
  assert.equal(markdownText('看![图](/api/x.png)和[链接](http://a.b/c)'), '看 和[链接 ');
  // 600 Chinese characters or 300 English words make a page; 255 characters or 238 words a minute.
  assert.deepEqual(fileFacts({ chars: 153000, words: 0, lang: 'zh' }), { pages: 255, estimatedPages: true, minutes: 600 });
  assert.deepEqual(fileFacts({ pages: 238, lang: 'en' }), { pages: 238, estimatedPages: false, minutes: 300 });
  assert.deepEqual(bookFacts([{ pages: 300, lang: 'en' }]), { books: 1, pages: 300, estimatedPages: false, weightKg: 0.52, hours: 6 });
  assert.deepEqual(bookFacts([{ chars: 153000, lang: 'zh' }, { pages: 238, lang: 'en' }]), { books: 2, pages: 493, estimatedPages: true, weightKg: 0.89, hours: 15 }, 'a set weighs and reads as its books together');
  assert.equal(bookFacts([{ words: 10, lang: 'en' }]).hours, 1, 'never 0 hours');
  assert.equal(bookLang({ book: { edition: 'English 2018' } }), 'en'); assert.equal(bookLang({ book: { edition: '中文2010' } }), 'zh');
  assert.equal(bookLang({ book: { title: '《示例工坊》' } }), 'zh'); assert.equal(bookLang({ book: { title: 'Deep Work' } }), 'en');
});

async function library(t) {
  const { root, config } = await fixture(t);
  const dir = path.join(root, 'books'); await fs.mkdir(dir, { recursive: true });
  const files = { one: path.join(dir, 'one.epub'), two: path.join(dir, 'two.pdf'), copy: path.join(dir, 'reading-copy.epub'), mobi: path.join(dir, 'x.mobi') };
  await fs.writeFile(files.one, epub('字'.repeat(15300))); await fs.writeFile(files.two, packedPdf(238)); await fs.writeFile(files.copy, epub('副本'.repeat(5000))); await fs.writeFile(files.mobi, 'mobi');
  const agent = (id, bookFiles) => ({ id, name: id, kind: 'book', primary: '学习', tags: [], book: { title: '《书》', edition: '中文' }, bookFiles });
  const registry = { agents: [
    agent('set', [{ path: files.one, ext: 'epub', exists: true }, { path: files.two, ext: 'pdf', exists: true }, { path: files.copy, ext: 'epub', exists: true }, { path: files.mobi, ext: 'mobi', exists: true }]),
    agent('ocr', [{ path: files.mobi, ext: 'mobi', exists: true }, { path: files.copy, ext: 'epub', exists: true }]),
    agent('none', [{ path: files.mobi, ext: 'mobi', exists: true }]),
  ] };
  return { config, registry, files };
}

test('v042 books service: facts add up the original books, are cached, and reading time counts only while someone is there', async t => {
  const { config, registry, files } = await library(t);
  let idle = 0, reads = 0;
  const io = { ...fs, readFile: (...args) => { if (!String(args[0]).endsWith('.json')) reads++; return fs.readFile(...args); } };
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, io, systemIdle: () => idle, now: () => new Date('2026-11-01T10:00:00Z') });
  const facts = await books.facts('set');
  // 15300 characters = 26 pages, 60 min; the PDF has 238 pages read as Chinese (edition 中文): 238 × 600 / 255 = 560 min.
  assert.deepEqual(facts, { agentId: 'set', books: 2, pages: 264, estimatedPages: true, weightKg: 0.57, hours: 10, readSeconds: 0 }, 'the reading copy and the MOBI are not counted');
  assert.equal(reads, 2);
  await books.facts('set'); assert.equal(reads, 2, 'measured once per file version');
  const again = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, io });
  assert.equal((await again.facts('set')).pages, 264); assert.equal(reads, 2, 'the measurements survive a restart in book-facts.json');
  assert.equal((await books.facts('ocr')).pages, 17, 'with no readable original the reading copy stands in');
  assert.deepEqual(await books.facts('none'), { agentId: 'none', books: 0, readSeconds: 0 });
  await fs.writeFile(files.one, epub('字'.repeat(30600)));
  assert.equal((await books.facts('set')).pages, 289, 'a changed file is measured again');

  assert.deepEqual(await books.addReadingTime('set', { seconds: 30, active: false }), { seconds: 30, counted: true }, 'the system idle time decides, not the page');
  idle = IDLE_LIMIT_S;
  assert.deepEqual(await books.addReadingTime('set', { seconds: 30, active: true }), { seconds: 30, counted: false }, 'five minutes away and the clock stops');
  idle = 10; await books.addReadingTime('set', { seconds: 12.5 });
  assert.equal((await books.facts('set')).readSeconds, 42.5);
  for (const bad of [{ seconds: -1 }, { seconds: 121 }, { seconds: '30' }, null]) await assert.rejects(books.addReadingTime('set', bad), { status: 400 });
  await assert.rejects(books.addReadingTime('nobody', { seconds: 1 }), { status: 404 });
  await books.idle();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir, 'reading-time.json'), 'utf8')).books.set, { seconds: 42.5, updatedAt: '2026-11-01T10:00:00.000Z' });
  const browser = createBooks({ dataDir: config.dataDir, getRegistry: () => registry });
  assert.equal((await browser.addReadingTime('ocr', { seconds: 5, active: true })).counted, true, 'outside the desktop app the page reports recent input');
  assert.equal((await browser.addReadingTime('ocr', { seconds: 5, active: false })).counted, false);
});

test('v042 HTTP: facts, token-guarded reading time, and the description size in settings and on the page', async t => {
  // After hooks run in registration order: close the app before the fixture folder is removed.
  let app; t.after(() => app?.close());
  const { config, registry } = await library(t);
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry, bookOptions: { systemIdle: () => 0 } }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`, json = { 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(base + '/api/book-facts/set')).json()).pages, 264);
  assert.equal((await fetch(base + '/api/book-facts/nobody')).status, 404);
  const beat = headers => fetch(base + '/api/reading-time/set', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ seconds: 30, active: true }) });
  assert.equal((await beat()).status, 403);
  assert.deepEqual(await (await beat({ 'X-Co-Agent-Token': app.token })).json(), { seconds: 30, counted: true });
  const put = body => fetch(base + '/api/settings', { method: 'PUT', headers: { ...json, 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(base + '/api/settings')).json()).bookText, 100);
  const saved = await (await put({ bookText: 130 })).json();
  assert.equal(saved.bookText, 130); assert.equal(saved.ui, 'shelf', 'the size alone leaves the layout');
  assert.equal((await (await put({ ui: 'shelf' })).json()).bookText, 130, 'the layout alone leaves the size');
  for (const bad of [{ bookText: 75 }, { bookText: 125 }, { bookText: 170 }, { bookText: '130' }, {}]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  assert.match(await (await fetch(base + '/')).text(), /<html lang="zh-CN" data-ui="shelf" data-book-text="130" data-depth="off">/);
  // v0.53.14: the readers' typography is part of the settings, at its defaults here.
  assert.deepEqual(await readSettings(config.dataDir), { version: 1, ui: 'shelf', bookText: 130, reader: { fontSize: 19, lineHeight: 205, measure: 'medium', theme: 'paper' }, depth: 'off' });
  await fs.writeFile(path.join(config.dataDir, 'settings.json'), JSON.stringify({ version: 1, ui: 'bento' }));
  assert.equal((await readSettings(config.dataDir)).bookText, 100, 'older settings files read as 100%');
  await assert.rejects(writeSettings(config.dataDir, 'shelf', 90.5), { status: 400 });
});

// v0.53: the check that every listed book has its card and every category its glyphs is about the user's own lists and
// moved to test/profile.test.mjs; an unknown category falls back to the generic glyphs.
test('v042 the card falls back to the category, and an unknown category gets the generic glyphs', async () => {
  assert.equal(categoryGlyphs['自己加的分类'], undefined);
  assert.equal(blurbOf({ primary: '哲学／神话', book: {} }), '有关哲学、神话的详细信息。');
  assert.equal(blurbOf({ book: { blurb: '有关甲的详细信息。研读这本书可以乙。' } }), '有关甲的详细信息。研读这本书可以乙。');
  assert.equal(readingLine({ readSeconds: 359, hours: 3 }), '已研读 0.0 小时，共需 3 小时', 'read time rounds down to the tenth');
  assert.equal(readingLine({ readSeconds: 36000, hours: 12 }), '已研读 10.0 小时，共需 12 小时');
});

test('v042 the open reader beats every 30 s while in front; closing sends the last part; a hidden window sends nothing', async t => {
  const { doc } = await appDocument('shelf');
  let clock = 1_000_000; const timers = [], calls = [];
  const api = async (url, body, method) => { calls.push({ url, body, method }); if (url.startsWith('/api/books/')) return { agentId: 'b', index: 0, format: 'pdf', label: 'B', pdf: '/x.pdf', files: [] }; return { progress: null }; };
  const registry = { agents: [{ id: 'b', name: 'b', kind: 'book', book: { title: 'B' }, bookFiles: [{ ext: 'pdf', exists: true, path: 'b.pdf' }] }] };
  const reader = mountBookReader(doc, { api, getRegistry: () => registry, now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: id => { if (timers[id - 1]) timers[id - 1].fn = null; } });
  t.after(() => reader.dispose());
  doc.hasFocus = () => true; doc.visibilityState = 'visible';
  await reader.open('b');
  const beats = () => calls.filter(c => c.url === '/api/reading-time/b');
  const tick = () => { const timer = timers.findLast(x => x.fn && x.ms === BEAT_MS); const fn = timer.fn; timer.fn = null; fn(); };
  clock += 30000; tick();
  assert.deepEqual(beats(), [{ url: '/api/reading-time/b', body: { seconds: 30, active: true }, method: 'POST' }]);
  clock += 400000; tick();
  assert.deepEqual(beats()[1].body, { seconds: 120, active: false }, 'a long gap is capped and, with no input for 5 minutes, reported idle');
  await doc.getElementById('book-reader').fire('wheel'); clock += 30000; tick();
  assert.equal(beats()[2].body.active, true, 'scrolling is reading');
  doc.visibilityState = 'hidden'; clock += 30000; tick();
  assert.equal(beats().length, 3, 'nothing while the window is hidden');
  doc.visibilityState = 'visible'; clock += 12000; doc.getElementById('book-reader').close(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(beats()[3].body, { seconds: 12, active: true }, 'closing reports the part since the last beat');
});

test('v042 settings: the slider sizes the card at once, saves when let go, and puts the saved size back after a failure', async t => {
  const { doc } = await appDocument('shelf');
  doc.documentElement.setAttribute('data-book-text', '120');
  const vars = {}; doc.documentElement.style = { setProperty: (k, v) => { vars[k] = v; } };
  let fail = false; const sent = [];
  const settings = mountSettings(doc, async (url, opts) => { sent.push(JSON.parse(opts.body)); return fail ? { ok: false, status: 500, json: async () => ({ error: '磁盘满' }) } : { ok: true, json: async () => ({ ui: 'shelf', bookText: JSON.parse(opts.body).bookText }) }; }, 'tok', () => {}, { bindTrigger: false });
  t.after(() => settings.dispose());
  const slider = doc.getElementById('settings-book-text');
  assert.equal(slider.value, '120'); assert.equal(vars['--book-text-scale'], '1.2'); assert.equal(doc.getElementById('settings-book-text-value').textContent, '120%');
  slider.value = '140'; await slider.fire('input');
  assert.equal(vars['--book-text-scale'], '1.4'); assert.equal(sent.length, 0, 'moving the slider does not save yet');
  await slider.fire('change'); await settings.saveBookText();
  assert.deepEqual(sent, [{ bookText: 140 }]); assert.equal(doc.documentElement.getAttribute('data-book-text'), '140');
  fail = true; slider.value = '90'; await slider.fire('change'); await settings.saveBookText();
  assert.equal(slider.value, '140'); assert.equal(vars['--book-text-scale'], '1.4');
  assert.match(doc.getElementById('settings-book-text-status').textContent, /保存失败，已恢复原字号：磁盘满/);
});
