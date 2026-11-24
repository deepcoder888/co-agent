import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { openEpub, chapterMarkdown, resolveHref } from '../src/books/epub.mjs';
import { createBooks } from '../src/books/index.mjs';
import { renderMarkdown } from '../public/markdown.js';
import { preferredBookFile, derivedReadingCopy } from '../public/display.js';
import { mountApp } from '../public/app.js';
import { mountBookReader } from '../public/book-reader.js';

// v0.41 在软件中阅读原书 (2026-11-01): 「打开原书」 reads EPUB and PDF books in the app's reading mode, in every layout.
// A small EPUB built here: stored and deflated entries, an EPUB 3 nav, an image and the usual XHTML.
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), data = deflate ? zlib.deflateRawSync(raw) : raw, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5e00000000049454e44ae426082', 'hex');
const epubBytes = () => zip([
  ['mimetype', 'application/epub+zip'],
  ['META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
  ['OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">习惯的力量 &amp; Co</dc:title></metadata>
    <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/two%20b.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="images/a (1).png" media-type="image/png"/><item id="css" href="s.css" media-type="text/css"/></manifest>
    <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`, true],
  ['OEBPS/nav.xhtml', `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml">第一章 开始</a>
    <ol><li><a href="text/one.xhtml#s2">一、小节</a></li></ol></li><li><a href="text/two%20b.xhtml">第二章 习惯</a></li><li><a href="http://evil.example/x">外链</a></li></ol></nav></body></html>`],
  ['OEBPS/text/one.xhtml', `<html><head><title>x</title><style>p{}</style><script>alert(1)</script></head><body><h1>第一章&nbsp;开始</h1>
    <p>正文 <em>强调</em> 与 <b>加粗</b>，<span>&lt;script&gt;不执行&lt;/script&gt;</span> 和 *星号*。</p><p><img src="../images/a%20(1).png" alt="图 一"/></p>
    <blockquote><p>引文第一段</p><p>引文第二段</p></blockquote><ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>
    <table><tr><th>项</th><th>值</th></tr><tr><td>a|b</td><td>1</td></tr></table><p># 不是标题</p></body></html>`, true],
  ['OEBPS/text/two b.xhtml', '<html><body><p>第二章正文</p><pre>code  kept</pre></body></html>'],
  ['OEBPS/images/a (1).png', png],
]);

test('v041 EPUB: package, spine, nav outline, title and chapters convert to the reader\'s escaped Markdown', () => {
  const book = openEpub(epubBytes());
  assert.equal(book.title, '习惯的力量 & Co');
  assert.equal(book.chapters.length, 2);
  // v0.53.14: each entry carries the anchor of its link ('' without a fragment).
  assert.deepEqual(book.toc, [{ title: '第一章 开始', chapter: 0, depth: 0, anchor: '' }, { title: '一、小节', chapter: 0, depth: 1, anchor: 's2' }, { title: '第二章 习惯', chapter: 1, depth: 0, anchor: '' }], 'external links are dropped');
  const md = book.chapter(0, name => '/api/books/x/0/assets?path=' + encodeURIComponent(name));
  assert.match(md, /^## 第一章 开始$/m, 'a no-break space in the book folds like any other space');
  assert.match(md, /正文 \*强调\* 与 \*\*加粗\*\*，\\<script\\>不执行\\<\/script\\> 和 \\\*星号\\\*。/);
  assert.match(md, /!\[图 一\]\(\/api\/books\/x\/0\/assets\?path=OEBPS%2Fimages%2Fa%20%281%29\.png\)/);
  assert.match(md, /> 引文第一段\n> \n> 引文第二段/);
  assert.match(md, /- 甲\n {2}- 甲一\n- 乙/);
  assert.match(md, /\| 项 \| 值 \|\n\| --- \| --- \|\n\| a\\\|b \| 1 \|/);
  assert.match(md, /^\\# 不是标题$/m);
  assert.doesNotMatch(md, /alert|p\{\}/, 'scripts and styles contribute nothing');
  assert.match(book.chapter(1, n => n), /第二章正文[\s\S]*```\ncode  kept\n```/);
  assert.deepEqual(book.asset('OEBPS/images/a (1).png'), { type: 'image/png', data: png });
  assert.throws(() => book.asset('OEBPS/s.css'), { status: 404 }); assert.throws(() => book.chapter(2), { status: 404 });
  assert.equal(resolveHref('OEBPS/text/one.xhtml', '../../../etc/x'), null); assert.equal(resolveHref('a/b.xhtml', 'https://x'), null);
  assert.throws(() => openEpub(Buffer.from('not a zip')), { status: 422 });
});

test('v041 EPUB 2: the NCX outline is used when there is no nav, and void tags without a closing slash keep their text', () => {
  const book = openEpub(zip([
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'],
    ['c.opf', '<package><metadata><title>旧书</title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.html" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="a"/></spine></package>'],
    ['toc.ncx', '<ncx><navMap><navPoint><navLabel><text>序</text></navLabel><content src="a.html#top"/></navPoint></navMap></ncx>'],
    ['a.html', '<html><body><p>一行<br>二行</p></body></html>'],
  ]));
  assert.deepEqual(book.toc, [{ title: '序', chapter: 0, depth: 0, anchor: 'top' }]);
  assert.match(book.chapter(0), /一行\n二行/);
  assert.match(chapterMarkdown('<body><p>a&mdash;b&hellip;</p></body>', 'x.html'), /a—b…/);
});

test('v041 reader Markdown shows only this app\'s own book images; any other image stays text', async () => {
  const { doc } = await appDocument(); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const root = renderMarkdown(doc, '![封面](/api/books/clemo/0/assets?path=OEBPS%2Fc.jpg)\n\n![外部](https://evil.example/x.png)\n\n![旁路](/api/registry)');
  const images = root.querySelectorAll('img');
  assert.equal(images.length, 1); assert.equal(images[0].getAttribute('src'), '/api/books/clemo/0/assets?path=OEBPS%2Fc.jpg'); assert.equal(images[0].getAttribute('alt'), '封面');
  assert.match(root.textContent, /图片：外部（https:\/\/evil\.example\/x\.png）[\s\S]*图片：旁路（\/api\/registry）/);
});

async function library(t) {
  const { root, config } = await fixture(t);
  const epub = path.join(root, 'books', 'habit.epub'), pdf = path.join(root, 'books', 'habit.pdf'), mobi = path.join(root, 'books', 'habit.mobi');
  await fs.mkdir(path.dirname(epub), { recursive: true });
  await fs.writeFile(epub, epubBytes()); await fs.writeFile(pdf, '%PDF-1.4 fixture'); await fs.writeFile(mobi, 'mobi');
  const book = { id: 'habit', name: 'habit', kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: '习惯的力量', author: '作者' },
    platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' },
    bookFiles: [{ index: 0, label: '习惯的力量', path: epub, ext: 'epub', exists: true }, { index: 1, label: '习惯 PDF', path: pdf, ext: 'pdf', exists: true },
      { index: 2, label: '习惯 MOBI', path: mobi, ext: 'mobi', exists: true }, { index: 3, label: '丢失', path: path.join(root, 'gone.epub'), ext: 'epub', exists: false }] };
  const registry = { agents: [book, { ...book, id: 'role', kind: 'role', bookFiles: [] }], categories: ['学习'], summary: { books: 1, roles: 1 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  return { root, config, registry, book, epub, pdf };
}

test('v041 books service: files only by registry index, cached EPUB, PDF and MOBI handling, and saved positions', async t => {
  const { config, registry } = await library(t);
  let reads = 0;
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, io: { ...fs, readFile: (...args) => { reads++; return fs.readFile(...args); } }, now: () => new Date('2026-11-01T10:00:00Z') });
  const info = await books.info('habit', 0);
  assert.equal(info.format, 'epub'); assert.equal(info.chapters.length, 2); assert.equal(info.toc[0].title, '第一章 开始');
  assert.deepEqual(info.files.map(f => [f.format, f.readable, f.exists]), [['epub', true, true], ['pdf', true, true], ['mobi', false, true], ['epub', true, false]]);
  await books.chapter('habit', 0, 1); assert.equal(reads, 1, 'the outline and the chapters share one parsed book');
  assert.match((await books.chapter('habit', 0, 0)).markdown, /\/api\/books\/habit\/0\/assets\?path=OEBPS%2Fimages%2Fa%20%281%29\.png/);
  assert.equal((await books.asset('habit', 0, 'OEBPS/images/a (1).png')).type, 'image/png');
  assert.deepEqual(await books.info('habit', 1), { ...(await books.info('habit', 1)), format: 'pdf', pdf: '/api/books/habit/1/pdf' });
  assert.equal((await books.info('habit', 2)).unsupported, true);
  await assert.rejects(books.info('habit', 3), { status: 404 }); await assert.rejects(books.info('habit', 9), { status: 404 }); await assert.rejects(books.info('role', 0), { status: 404 });
  await assert.rejects(books.pdf('habit', 0), { status: 415 }); await assert.rejects(books.chapter('habit', 1, 0), { status: 415 });
  assert.equal(await books.progress('habit'), null);
  assert.deepEqual(await books.saveProgress('habit', { index: 0, chapter: 1, ratio: 0.123456 }), { index: 0, chapter: 1, ratio: 0.1235, updatedAt: '2026-11-01T10:00:00.000Z' });
  for (const bad of [{ index: 9, chapter: 0, ratio: 0 }, { index: 0, chapter: -1, ratio: 0 }, { index: 0, chapter: 0, ratio: 2 }, null]) await assert.rejects(books.saveProgress('habit', bad), { status: 400 });
  const fresh = createBooks({ dataDir: config.dataDir, getRegistry: () => registry });
  assert.equal((await fresh.progress('habit')).chapter, 1, 'positions survive a restart in the data directory');
  assert.ok(JSON.parse(await fs.readFile(path.join(config.dataDir, 'reading-progress.json'), 'utf8')).books.habit);
});

test('v041 HTTP: book routes, PDF framing for this app only, token-guarded progress, and no paths from the page', async t => {
  // After hooks run in registration order: close the app before the fixture folder is removed.
  let app; t.after(() => app?.close());
  const { config, registry } = await library(t);
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await (await fetch(base + '/api/books/habit/0')).json()).toc.length, 3);
  assert.match((await (await fetch(base + '/api/books/habit/0/chapters/0')).json()).markdown, /第一章/);
  const image = await fetch(base + '/api/books/habit/0/assets?path=' + encodeURIComponent('OEBPS/images/a (1).png'));
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const pdf = await fetch(base + '/api/books/habit/1/pdf');
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(pdf.headers.get('content-security-policy'), "frame-ancestors 'self'"); assert.equal(await pdf.text(), '%PDF-1.4 fixture');
  for (const url of ['/api/books/habit/x', '/api/books/habit/0/chapters/9', '/api/books/habit/0/nope', '/api/books/habit/0/assets?path=..%2Fsecret', '/api/books/nobody/0', '/api/books/habit/0/chapters/0/extra'])
    assert.equal((await fetch(base + url)).status, 404, url);
  const put = (headers = {}) => fetch(base + '/api/reading-progress/habit', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ index: 0, chapter: 1, ratio: 0.5 }) });
  assert.equal((await put()).status, 403);
  assert.equal((await put({ 'X-Co-Agent-Token': app.token })).status, 200);
  assert.equal((await (await fetch(base + '/api/reading-progress/habit')).json()).progress.chapter, 1);
});

test('v041 every layout: 「打开原书」 opens the book in the reading mode, remembers the place, offers the other files and the system program', async t => {
  const { registry } = await library(t);
  for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) {
    const { doc } = await appDocument(ui); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
    const requests = [], saved = { progress: { index: 0, chapter: 1, ratio: 0 } };
    const front = await mountApp(doc, async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body, method: opts.method }); let value = { items: [], unavailable: [] };
      if (url === '/api/registry') value = registry; else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] }; else if (url === '/api/settings') value = { ui, recommend: {} };
      else if (url === '/api/reading-progress/habit') value = body ? { progress: body } : saved;
      else if (url === '/api/books/habit/0') value = { agentId: 'habit', index: 0, format: 'epub', label: '习惯的力量', title: '习惯的力量', chapters: [{ title: '第一章 开始' }, { title: '第二章 习惯' }],
        toc: [{ title: '第一章 开始', chapter: 0, depth: 0 }, { title: '第二章 习惯', chapter: 1, depth: 0 }], files: [{ index: 0, label: '习惯的力量', format: 'epub', exists: true, readable: true }, { index: 1, label: '习惯 PDF', format: 'pdf', exists: true, readable: true }, { index: 2, label: '习惯 MOBI', format: 'mobi', exists: true, readable: false }] };
      else if (/^\/api\/books\/habit\/0\/chapters\/\d$/.test(url)) value = { chapter: Number(url.at(-1)), markdown: `## 第 ${url.at(-1)} 章正文\n\n内容` };
      else if (url === '/api/books/habit/1') value = { agentId: 'habit', index: 1, format: 'pdf', label: '习惯 PDF', pdf: '/api/books/habit/1/pdf', files: [] };
      return { ok: true, json: async () => structuredClone(value) };
    }, { confirm: async () => true });
    t.after(() => front.dispose());
    await front.actions.openDetail('habit');
    await doc.querySelector('[data-open-agent="habit"]').fire('click');
    const reader = doc.getElementById('book-reader'), host = reader.parentElement;
    assert.equal(reader.open, true, ui); assert.equal(host.getAttribute('data-ui'), 'shelf', 'the shelf reading mode in every layout');
    assert.match(reader.className, /shelf-reader/);
    assert.match(doc.getElementById('book-reader-body').textContent, /第 1 章正文/, `${ui}: the saved chapter`);
    assert.match(reader.textContent, /习惯的力量/); assert.match(reader.textContent, /第二章 习惯/);
    assert.deepEqual(doc.getElementById('book-reader-file').options.map(o => [o.value, o.disabled]), [['0', false], ['1', false], ['2', true]], 'MOBI is listed for the system program only');
    assert.equal(doc.getElementById('book-reader-next').hidden, true); assert.match(doc.getElementById('book-reader-prev').textContent, /上一章：第一章 开始/);
    await doc.getElementById('book-reader-prev').fire('click');
    assert.match(doc.getElementById('book-reader-body').textContent, /第 0 章正文/);
    assert.deepEqual(requests.filter(r => r.method === 'PUT').at(-1).body, { index: 0, chapter: 0, ratio: 0 }, 'the place is saved when the chapter changes');
    const select = doc.getElementById('book-reader-file'); select.value = '1'; await select.fire('change'); await new Promise(r => setTimeout(r, 0));
    assert.equal(doc.querySelector('.book-reader-pdf').getAttribute('src'), '/api/books/habit/1/pdf'); assert.match(reader.className, /is-pdf/);
    await doc.getElementById('book-reader-external').fire('click');
    assert.deepEqual(requests.find(r => r.url === '/api/open').body, { agentId: 'habit', target: 'book', index: 1 });
    assert.equal(requests.some(r => r.url === '/api/open' && 'path' in r.body), false);
    reader.close();
    front.dispose();
  }
});

test('v0.41.2 打开原书 prefers an original EPUB, then the PDF; an OCR or page-text reading copy opens only when nothing else can be read', () => {
  const f = (ext, path, exists = true) => ({ ext, path, exists });
  for (const name of ['reading-copy.epub', 'reading-copy-v3.epub', 'reading.epub', 'arnova-1974-reading.epub', 'zevo-2009-ocr-reading.epub', 'sample-map-2021-ocr.epub'])
    assert.equal(derivedReadingCopy(f('epub', String.raw`D:\work\Reading\x-source` + '\\' + name)), true, name);
  assert.equal(derivedReadingCopy(f('epub', String.raw`D:\Reading\Sample Notes (Jon Sample).epub`)), false);
  assert.equal(derivedReadingCopy(f('pdf', String.raw`D:\Reading\reading-copy.pdf`)), false);
  assert.equal(preferredBookFile([f('pdf', 'D:/a/x.pdf'), f('epub', String.raw`D:\a-source\reading-copy.epub`)]), 0, 'the PDF beats its OCR copy');
  assert.equal(preferredBookFile([f('pdf', 'x.pdf'), f('epub', 'D:/Book (Author).epub')]), 1, 'an original EPUB beats the PDF');
  assert.equal(preferredBookFile([f('mobi', 'x.mobi'), f('epub', 'D:/b/reading-copy.epub')]), 1, 'with only MOBI beside it, the converted copy is read');
  assert.equal(preferredBookFile([f('epub', 'D:/gone.epub', false), f('pdf', 'y.pdf')]), 1, 'missing files are skipped');
  assert.equal(preferredBookFile([f('mobi', 'z.mobi')]), -1);
});

test('v0.41.3 a collapsed outline rail slides off after 3 s; the left edge brings it back after 120 ms, hover and Tab keep it', async t => {
  const { registry } = await library(t);
  const { doc } = await appDocument('threepane'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const timers = new Map(); let id = 0;
  const setTimer = (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer = key => timers.delete(key);
  const due = ms => [...timers.entries()].filter(([, timer]) => timer.ms === ms);
  const run = async ms => { for (const [key, timer] of due(ms)) { timers.delete(key); await timer.fn(); } };
  const api = async (url, body) => url.startsWith('/api/reading-progress') ? { progress: body || null }
    : url === '/api/books/habit/0' ? { agentId: 'habit', index: 0, format: 'epub', label: 'x', chapters: [{ title: '一' }], toc: [{ title: '一', chapter: 0, depth: 0 }], files: [] }
    : { chapter: 0, markdown: '正文' };
  const reader = mountBookReader(doc, { api, getRegistry: () => registry, setTimer, clearTimer }); t.after(() => reader.dispose());
  await reader.open('habit');
  const dialog = doc.getElementById('book-reader'), toc = doc.getElementById('book-reader-toc'), edge = dialog.querySelector('.shelf-reader-edge');
  assert.equal(due(3000).length, 0, 'an open outline never hides');
  await doc.getElementById('book-reader-toc-toggle').fire('click');
  assert.equal(due(3000).length, 1); assert.doesNotMatch(dialog.className, /is-rail-hidden/);
  await run(3000); assert.match(dialog.className, /is-rail-hidden/, 'after 3 s the rail is gone');
  await edge.fire('mouseenter'); await edge.fire('mouseleave'); assert.equal(due(120).length, 0, 'a quick pass over the edge does nothing');
  await edge.fire('mouseenter'); await run(120); assert.doesNotMatch(dialog.className, /is-rail-hidden/, 'resting on the edge brings it back');
  assert.equal(due(3000).length, 1, 'and counts down at once, in case the pointer never enters the rail');
  await toc.fire('mouseenter'); assert.equal(due(3000).length, 0, 'it stays while the pointer is on it');
  await toc.fire('mouseleave'); assert.equal(due(3000).length, 1); await run(3000); assert.match(dialog.className, /is-rail-hidden/);
  await dialog.fire('keydown', { key: 'Tab' }); assert.doesNotMatch(dialog.className, /is-rail-hidden/, 'Tab brings the outline back for the keyboard');
  await doc.getElementById('book-reader-toc-toggle').fire('click'); assert.equal(due(3000).length, 0, 'expanding the outline cancels hiding');
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /dialog\.shelf-reader\.is-rail-hidden \.shelf-reader-grid\.is-toc-collapsed \{ grid-template-columns:0 minmax\(0,1fr\); \}/);
  assert.match(css, /\.shelf-reader-edge \{ position:fixed;[^}]*width:14px/);
});
