import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import { createApp } from '../src/server.mjs';
import { openEpub, chapterMarkdown } from '../src/books/epub.mjs';
import { createBooks } from '../src/books/index.mjs';
import { markdownText, measureText, READ_SPEED } from '../src/books/facts.mjs';
import { readSettings } from '../src/settings.mjs';
import { renderMarkdown } from '../public/markdown.js';
import { mountBookReader, TRACK_MS, ANCHOR_GAP } from '../public/book-reader.js';
import { configureReaderPrefs, readerPrefsState, normalizeReaderPrefs } from '../public/reader-prefs.js';
import * as shelf from '../public/layouts/shelf.js';

// v0.53.14 阅读模式的阅读体验 (2026-11-16): marks for anchors, superscripts, subscripts and links inside a book; the outline
// jumps to sections; ← / →; the progress line; places by paragraph; a PDF's page; one 排版 setting for both readers.
function contrast(a, b) {
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const M = { a:'\uE000', a1: '\uE001', sup: '\uE002', sup1: '\uE003', sub: '\uE004', sub1: '\uE005', link: '\uE006', text: '\uE007', link1: '\uE008' };
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const container = ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'];
const epubBytes = () => zip([container,
  ['OEBPS/content.opf', `<package><metadata><title>示例之书</title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`],
  ['OEBPS/nav.xhtml', `<html><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml">第一章</a><ol><li><a href="text/one.xhtml#sec%201">小节</a></li></ol></li>
    <li><a href="text/two.xhtml">第二章</a></li></ol></nav></body></html>`],
  ['OEBPS/text/one.xhtml', `<html><body><h1 id="top">第一章</h1><p id="unused">甲乙<sup>2</sup>丙H<sub>2</sub>O</p><h2 id="sec 1">小节</h2>
    <p>见<a href="two.xhtml#n1"><sup>1</sup></a>，又见<a href="#top">开头</a>，网页<a href="https://example.com/x">网站</a>，邮件<a href="mailto:x@example.com">信箱</a>。${M.a}伪造${M.a1}</p></body></html>`],
  ['OEBPS/text/two.xhtml', '<html><body><p>正文</p><p><a id="n1"/>注一</p></body></html>'],
]);

test('v05314 EPUB: outline anchors; marks for pointed-at ids, sup, sub and links; the book cannot forge a mark', () => {
  const book = openEpub(epubBytes());
  assert.deepEqual(book.toc, [{ title: '第一章', chapter: 0, depth: 0, anchor: '' }, { title: '小节', chapter: 0, depth: 1, anchor: 'sec 1' }, { title: '第二章', chapter: 1, depth: 0, anchor: '' }]);
  const one = book.chapter(0), two = book.chapter(1);
  assert.ok(one.includes(`## ${M.a}top${M.a1}第一章`), 'a heading\'s anchor stands before its text; #top is pointed at by a link');
  assert.ok(one.includes(`### ${M.a}sec%201${M.a1}小节`), 'the outline\'s anchor, %-encoded inside the mark');
  assert.doesNotMatch(one, /unused/, 'an id nothing points at gets no anchor');
  assert.ok(one.includes(`甲乙${M.sup}2${M.sup1}丙H${M.sub}2${M.sub1}O`));
  assert.ok(one.includes(`见${M.link}1#n1${M.text}${M.sup}1${M.sup1}${M.link1}`), 'a footnote link names the spine chapter and the anchor');
  assert.ok(one.includes(`又见${M.link}0#top${M.text}开头${M.link1}`), 'a bare #fragment is the same chapter');
  assert.ok(one.includes('网页[网站](https://example.com/x)'), 'web links keep the Markdown link form');
  assert.ok(one.includes('邮件信箱。伪造') && !/mailto/.test(one), 'other links leave only their text; the book\'s own private-use characters are removed');
  assert.equal(one.split(M.a).length - 1, 2, 'exactly the two wanted anchors');
  assert.ok(two.includes(`${M.a}n1${M.a1}注一`), 'an empty anchor element marks the text after it');
  // Called on its own (as the tests and older callers do), nothing is marked as an anchor.
  assert.doesNotMatch(chapterMarkdown('<body><h2 id="x">题</h2><p><a href="other.xhtml#y">去</a></p></body>', 'a.xhtml'), /[\uE000\uE006]/);
  // The fallback outline from headings keeps a heading's own id as its anchor.
  const plain = openEpub(zip([container,
    ['OEBPS/content.opf', '<package><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'],
    ['OEBPS/c.xhtml', '<body><h1 id="h-1">甲</h1><p>文</p><h2>乙</h2><h3 id="h-3">丙</h3></body>']]));
  assert.deepEqual(plain.toc.map(t => [t.title, t.anchor]), [['甲', 'h-1'], ['乙', ''], ['丙', 'h-3']]);
  assert.match(plain.chapter(0), new RegExp(`${M.a}h-3${M.a1}丙`));
});

test('v05314 markdownText counts the readable text only: no anchor names, no link targets, no marks', () => {
  const text = markdownText(`${M.a}anchorname${M.a1}Hello ${M.link}1#target${M.text}world${M.sup}2${M.sup1}${M.link1} 中${M.sub}文${M.sub1}`);
  assert.equal(text, 'Hello world2 中文');
  assert.deepEqual(measureText(text), { chars: 2, words: 2, lang: 'en' });
});

test('v05314 renderMarkdown { book: true } turns marks into anchors, sup, sub and in-book link buttons; without it they stay text', async () => {
  const { doc } = await appDocument(); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const source = `## ${M.a}sec%201${M.a1}小节\n\n见${M.link}1#n%5F1${M.text}*注*${M.sup}1${M.sup1}${M.link1}，H${M.sub}2${M.sub1}O 与 x${M.sup}2${M.sup1}，[网站](https://example.com/x)`;
  const root = renderMarkdown(doc, source, { book: true });
  const anchor = root.querySelector('span[data-book-anchor]');
  assert.equal(anchor.getAttribute('data-book-anchor'), 'sec 1'); assert.equal(anchor.textContent, ''); assert.equal(anchor.parentElement.tagName, 'H2');
  const link = root.querySelector('button.book-link');
  assert.equal(link.getAttribute('type'), 'button'); assert.equal(link.getAttribute('data-book-chapter'), '1'); assert.equal(link.getAttribute('data-book-anchor'), 'n_1');
  assert.equal(link.textContent, '注1'); assert.equal(link.querySelector('em').textContent, '注', 'inline formats inside a link'); assert.equal(link.querySelector('sup').textContent, '1');
  assert.deepEqual(root.querySelectorAll('sup').map(n => n.textContent), ['1', '2']); assert.equal(root.querySelector('sub').textContent, '2');
  assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.com/x'); assert.equal(root.querySelector('a').textContent, '网站（https://example.com/x）');
  assert.doesNotMatch(root.textContent, /[\uE000-\uE008]/);
  const plain = renderMarkdown(doc, source);
  assert.equal(plain.querySelectorAll('span[data-book-anchor]').length + plain.querySelectorAll('button').length + plain.querySelectorAll('sup').length, 0);
  assert.match(plain.textContent, /\uE000sec%201\uE001小节/, 'other callers keep these characters as ordinary text');
  assert.equal(renderMarkdown(doc, `a${M.sup}没有结束`, { book: true }).textContent, 'a没有结束', 'an unmatched mark is dropped');
});

async function library(t) {
  const { root, config } = await fixture(t);
  const epub = path.join(root, 'books', 'sample.epub'), pdf = path.join(root, 'books', 'sample.pdf');
  await fs.mkdir(path.dirname(epub), { recursive: true }); await fs.writeFile(epub, epubBytes()); await fs.writeFile(pdf, '%PDF-1.4 fixture');
  const book = { id: 'walvo', name: 'walvo', kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: '示例之书', author: '作者' },
    platforms: {}, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' },
    bookFiles: [{ index: 0, label: '示例之书', path: epub, ext: 'epub', exists: true }, { index: 1, label: '示例 PDF', path: pdf, ext: 'pdf', exists: true }] };
  return { config, registry: { agents: [book], categories: ['学习'], summary: { books: 1, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] } };
}

test('v05314 info: language, reading speed and each chapter\'s characters, measured once per parsed book', async t => {
  const { config, registry } = await library(t);
  let reads = 0;
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, io: { ...fs, readFile: (...args) => { reads++; return fs.readFile(...args); } } });
  const info = await books.info('walvo', 0);
  assert.equal(info.lang, 'zh'); assert.equal(info.speed, READ_SPEED.zh);
  const book = openEpub(epubBytes()), expected = [0, 1].map(n => measureText(markdownText(book.chapter(n))).chars);
  assert.deepEqual(info.chapters.map(c => c.units), expected); assert.deepEqual(expected, [23, 4]);
  assert.deepEqual(info.chapters.map(c => c.title), ['第一章', '第二章']);
  await books.info('walvo', 0); assert.equal(reads, 1, 'the measures stay with the cached book');
  assert.equal((await books.info('walvo', 1)).lang, undefined, 'a PDF has no chapter measures');
  await assert.rejects(fs.access(path.join(config.dataDir, 'book-facts.json')), 'nothing is written for them');
});

test('v05314 progress: optional paragraph, offset and PDF page are checked and saved; older records still read', async t => {
  const { config, registry } = await library(t);
  await put(path.join(config.dataDir, 'reading-progress.json'), JSON.stringify({ version: 1, books: { walvo: { index: 0, chapter: 1, ratio: 0.4, updatedAt: '2026-11-01T00:00:00.000Z' } } }));
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, now: () => new Date('2026-11-16T10:00:00Z') });
  assert.deepEqual(await books.progress('walvo'), { index: 0, chapter: 1, ratio: 0.4, updatedAt: '2026-11-01T00:00:00.000Z' }, 'an old record without block');
  assert.deepEqual(await books.saveProgress('walvo', { index: 0, chapter: 1, ratio: 0.5, block: 12, offset: 0.123456 }),
    { index: 0, chapter: 1, ratio: 0.5, block: 12, offset: 0.1235, updatedAt: '2026-11-16T10:00:00.000Z' });
  assert.deepEqual(await books.saveProgress('walvo', { index: 1, chapter: 0, ratio: 0, page: 37 }), { index: 1, chapter: 0, ratio: 0, page: 37, updatedAt: '2026-11-16T10:00:00.000Z' });
  assert.deepEqual(Object.keys(await books.saveProgress('walvo', { index: 0, chapter: 0, ratio: 0 })), ['index', 'chapter', 'ratio', 'updatedAt'], 'left out, they are not written');
  for (const bad of [{ block: -1 }, { block: 1.5 }, { block: 1000001 }, { block: '3' }, { offset: 1.2 }, { offset: -0.1 }, { offset: '0.5' }, { page: 0 }, { page: 100001 }, { page: 2.5 }])
    await assert.rejects(books.saveProgress('walvo', { index: 0, chapter: 0, ratio: 0, ...bad }), { status: 400 }, JSON.stringify(bad));
  assert.equal((await books.saveProgress('walvo', { index: 0, chapter: 0, ratio: 0, block: 1000000, offset: 1 })).block, 1000000);
});

test('v05314 settings: reader defaults and range, saved on its own and merged, invalid values 400, invalid stored fields fall back one by one', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t);
  app = await createApp(config, { conceptAutoDaily: false }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = body => fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
  const first = await (await fetch(base + '/api/settings')).json();
  assert.deepEqual(first.reader, { fontSize: 19, lineHeight: 205, measure: 'medium', theme: 'paper' });
  assert.deepEqual(first.readerRange.fontSize, { min: 16, max: 26, step: 1, default: 19 });
  assert.deepEqual(first.readerRange.measure.options, ['narrow', 'medium', 'wide']);
  const saved = await (await send({ reader: { fontSize: 22, theme: 'night' } })).json();
  assert.deepEqual(saved.reader, { fontSize: 22, lineHeight: 205, measure: 'medium', theme: 'night' }); assert.equal(saved.ui, 'shelf'); assert.equal(saved.bookText, 100);
  assert.equal((await (await send({ ui: 'bento' })).json()).reader.fontSize, 22, 'the layout alone leaves the typography');
  assert.equal((await (await send({ reader: { measure: 'wide', lineHeight: 240 } })).json()).ui, 'bento', 'the typography alone leaves the layout');
  for (const bad of [{ fontSize: 15 }, { fontSize: 27 }, { fontSize: 19.5 }, { fontSize: '20' }, { lineHeight: 207 }, { lineHeight: 155 }, { lineHeight: 245 },
    { measure: 'huge' }, { theme: 'dark' }, { colour: 'red' }, [], null, 'paper'])
    assert.equal((await send({ reader: bad })).status, 400, JSON.stringify(bad));
  const file = JSON.parse(await fs.readFile(path.join(config.dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(file.reader, { fontSize: 22, lineHeight: 240, measure: 'wide', theme: 'night' });
  await fs.writeFile(path.join(config.dataDir, 'settings.json'), JSON.stringify({ version: 1, ui: 'editorial', bookText: 120, reader: { fontSize: 99, lineHeight: 180, measure: 'x', theme: 'gray' } }));
  assert.deepEqual(await readSettings(config.dataDir), { version: 1, ui: 'editorial', bookText: 120, reader: { fontSize: 19, lineHeight: 180, measure: 'medium', theme: 'gray' }, depth: 'off' });
  assert.deepEqual(normalizeReaderPrefs('nonsense'), { fontSize: 19, lineHeight: 205, measure: 'medium', theme: 'paper' });
});

// A recording DOM with just enough layout: the reader dialog is the viewport (top 0), the chapter's top-level blocks are
// 200 px tall from y = 1000 (+ shift), and an anchor's y is set per name. Positions move with the dialog's scrollTop.
async function readerHarness(t, { info, chapters, progress = null }) {
  const { doc } = await appDocument('shelf'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const layout = { shift: 0, anchors: {} }, create = doc.createElement;
  doc.createElement = tag => {
    const node = create(tag);
    node.getBoundingClientRect = () => {
      const dialog = doc.getElementById('book-reader'), scroll = dialog?.scrollTop || 0;
      if (node === dialog) return { top: 0, height: 960, bottom: 960 };
      const name = node.getAttribute('data-book-anchor');
      if (node.tagName === 'SPAN' && name !== null) { const y = (layout.anchors[name] ?? 0) + layout.shift - scroll; return { top: y, height: 0, bottom: y }; }
      if (node.parentElement?.className === 'concept-markdown') {
        const y = 1000 + node.parentElement.children.indexOf(node) * 200 + layout.shift - scroll; return { top: y, height: 200, bottom: y + 200 };
      }
      return { top: 0, height: 0, bottom: 0 };
    };
    return node;
  };
  const timers = new Map(); let id = 0;
  const setTimer = (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer = key => timers.delete(key);
  const run = async ms => { for (const [key, timer] of [...timers.entries()].filter(([, x]) => x.ms === ms)) { timers.delete(key); await timer.fn(); } };
  const calls = [];
  const api = async (url, body, method) => {
    calls.push({ url, body, method });
    if (url === '/api/settings') return { reader: { fontSize: 19, lineHeight: 205, measure: 'medium', theme: 'paper' } };
    if (url.startsWith('/api/reading-progress/')) return { progress: method === 'PUT' ? body : progress };
    if (url.startsWith('/api/reading-time/')) return { seconds: 0 };
    const chapter = url.match(/\/chapters\/(\d+)$/);
    if (chapter) return { chapter: Number(chapter[1]), markdown: chapters[Number(chapter[1])] };
    return structuredClone(info[Number(url.split('/').at(-1))]);
  };
  const registry = { agents: [{ id: 'walvo', name: 'walvo', kind: 'book', book: { title: '示例之书' },
    bookFiles: [{ ext: 'epub', exists: true, path: 'D:/x/sample.epub' }, { ext: 'pdf', exists: true, path: 'D:/x/sample.pdf' }] }] };
  const reader = mountBookReader(doc, { api, getRegistry: () => registry, setTimer, clearTimer }); t.after(() => reader.dispose());
  const dialog = doc.getElementById('book-reader'); dialog.scrollHeight = 5960; dialog.clientHeight = 960; dialog.scrollTop = 0;
  const current = () => doc.getElementById('book-reader-toc-list').children.filter(b => b.getAttribute('aria-current') === 'true').map(b => b.textContent);
  const fetched = () => calls.filter(c => /\/chapters\/\d+$/.test(c.url)).map(c => Number(c.url.at(-1)));
  const lastPut = () => calls.filter(c => c.method === 'PUT' && c.url.startsWith('/api/reading-progress/')).at(-1)?.body;
  return { doc, reader, dialog, layout, run, calls, current, fetched, lastPut, body: () => doc.getElementById('book-reader-body') };
}
const files = [{ index: 0, label: '示例之书', format: 'epub', exists: true, readable: true }, { index: 1, label: '示例 PDF', format: 'pdf', exists: true, readable: true }];
const epubInfo = { agentId: 'walvo', index: 0, format: 'epub', label: '示例之书', title: '示例之书', files, lang: 'zh', speed: 100,
  chapters: [{ title: '第一章', units: 1000 }, { title: '第二章', units: 1000 }],
  toc: [{ title: '第一章', chapter: 0, depth: 0, anchor: '' }, { title: '甲节', chapter: 0, depth: 1, anchor: 'sec-a' }, { title: '乙节', chapter: 0, depth: 1, anchor: 'sec-b' },
    { title: '第二章', chapter: 1, depth: 0, anchor: '' }] };
const pdfInfo = { agentId: 'walvo', index: 1, format: 'pdf', label: '示例 PDF', pdf: '/api/books/walvo/1/pdf', files };
const chapterText = [
  `## 第一章\n\n正文一${M.a}sec-a${M.a1}甲。\n\n第二段见注${M.link}1#note1${M.text}${M.sup}1${M.sup1}${M.link1}。\n\n![图](/api/books/walvo/0/assets?path=x.png)\n\n${M.a}sec-b${M.a1}第三段`,
  `${M.a}note1${M.a1}注一：说明。`,
];

test('v05314 reader: the outline jumps to a section in the chapter, exactly one entry is current, and the progress line follows', async t => {
  const h = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText });
  Object.assign(h.layout.anchors, { 'sec-a': 1200, 'sec-b': 3000, note1: 1500 });
  await h.reader.open('walvo');
  assert.deepEqual(h.current(), ['第一章'], 'at the start of the chapter its first entry');
  assert.equal(h.doc.getElementById('book-reader-progress').textContent, '全书 0% · 本章还剩约 10 分钟');
  assert.equal(h.doc.getElementById('book-reader-progress').getAttribute('aria-hidden'), 'true');
  assert.equal(h.doc.getElementById('book-reader-progress').title, '全书 0% · 本章还剩约 10 分钟');
  await h.doc.getElementById('book-reader-toc-list').children[2].fire('click');
  assert.equal(h.dialog.scrollTop, 3000 - ANCHOR_GAP, 'the section\'s anchor lands just below the top');
  assert.deepEqual(h.current(), ['乙节']); assert.deepEqual(h.fetched(), [0], 'a section of the open chapter needs no new request');
  h.dialog.scrollTop = 2500; await h.dialog.fire('scroll'); await h.run(TRACK_MS);
  assert.deepEqual(h.current(), ['甲节'], 'the last entry whose anchor has passed the top');
  assert.equal(h.doc.getElementById('book-reader-progress').textContent, '全书 25% · 本章还剩约 5 分钟');
  h.dialog.scrollTop = 5000; await h.dialog.fire('scroll'); await h.run(TRACK_MS);
  assert.deepEqual(h.current(), ['乙节']); assert.equal(h.doc.getElementById('book-reader-progress').textContent, '全书 50% · 本章还剩不到 1 分钟');
  await h.doc.getElementById('book-reader-toc-list').children[3].fire('click');
  assert.deepEqual(h.fetched(), [0, 1]); assert.deepEqual(h.current(), ['第二章']); assert.equal(h.dialog.scrollTop, 0);
  // Without measures the line stays hidden.
  const h2 = await readerHarness(t, { info: [{ ...epubInfo, chapters: [{ title: '第一章' }, { title: '第二章' }] }, pdfInfo], chapters: chapterText });
  await h2.reader.open('walvo'); assert.equal(h2.doc.getElementById('book-reader-progress').hidden, true);
});

test('v05314 reader: a link inside the book goes to its note, 「回到刚才的位置」 returns by paragraph; places are saved and restored by paragraph', async t => {
  const h = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText });
  Object.assign(h.layout.anchors, { 'sec-a': 1200, 'sec-b': 3000, note1: 1500 });
  await h.reader.open('walvo');
  const back = h.doc.getElementById('book-reader-back');
  assert.equal(back.hidden, true);
  h.dialog.scrollTop = 1300;
  const link = h.body().querySelector('.book-link'); assert.equal(link.textContent, '1'); assert.equal(link.querySelector('sup').textContent, '1');
  await link.fire('click');
  assert.match(h.body().textContent, /注一：说明/); assert.equal(h.dialog.scrollTop, 1500 - ANCHOR_GAP);
  assert.equal(back.hidden, false); assert.equal(back.textContent, '↩ 回到刚才的位置');
  await h.doc.getElementById('book-reader-toc-list').children[3].fire('click');
  assert.equal(back.hidden, false, 'the way back stays while the reader looks around');
  await back.fire('click');
  assert.match(h.body().textContent, /第二段见注/); assert.equal(h.dialog.scrollTop, 1300, 'the same paragraph and offset as before the jump');
  assert.equal(back.hidden, true);
  assert.deepEqual(h.lastPut(), { index: 0, chapter: 0, ratio: 0.26, block: 1, offset: 0.5 }, 'the place is saved by paragraph');
  // Pictures that load after the restore move the text; the place follows them until the reader does something.
  h.layout.shift = 300; await h.body().querySelector('img').fire('load');
  assert.equal(h.dialog.scrollTop, 1600);
  await h.dialog.fire('wheel'); h.layout.shift = 600; await h.body().querySelector('img').fire('load');
  assert.equal(h.dialog.scrollTop, 1600, 'after the first wheel the reader owns the position');
  // A saved record with a paragraph is restored by that paragraph; an older one by its share of the page.
  const saved = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText, progress: { index: 0, chapter: 0, ratio: 0.9, block: 2, offset: 0.25 } });
  await saved.reader.open('walvo'); assert.equal(saved.dialog.scrollTop, 1450);
  const old = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText, progress: { index: 0, chapter: 1, ratio: 0.5 } });
  await old.reader.open('walvo'); assert.equal(old.dialog.scrollTop, 2500); assert.match(old.body().textContent, /注一/);
});

test('v05314 reader: ← / → turn chapters in an EPUB, but not in the version picker, with a modifier, or in the 排版 panel', async t => {
  const h = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText });
  await h.reader.open('walvo');
  assert.equal(h.doc.getElementById('book-reader-next').title, '下一章（→）'); assert.equal(h.doc.getElementById('book-reader-prev').title, '上一章（←）');
  await h.dialog.fire('keydown', { key: 'ArrowRight', target: h.doc.getElementById('book-reader-file') });
  await h.dialog.fire('keydown', { key: 'ArrowRight', ctrlKey: true });
  await h.dialog.fire('keydown', { key: 'ArrowRight', target: h.doc.getElementById('book-reader-prefs-toggle') });
  assert.deepEqual(h.fetched(), [0]);
  await h.dialog.fire('keydown', { key: 'ArrowRight' }); assert.deepEqual(h.fetched(), [0, 1]); assert.match(h.body().textContent, /注一/);
  await h.dialog.fire('keydown', { key: 'ArrowRight' }); assert.deepEqual(h.fetched(), [0, 1], 'no chapter after the last');
  await h.dialog.fire('keydown', { key: 'ArrowLeft' }); assert.deepEqual(h.fetched(), [0, 1, 0]);
  // A PDF ignores the arrows (its viewer has its own) and shows no progress line.
  const files = h.doc.getElementById('book-reader-file'); files.value = '1'; await files.fire('change'); await new Promise(r => setTimeout(r, 0));
  await h.dialog.fire('keydown', { key: 'ArrowLeft' }); assert.deepEqual(h.fetched(), [0, 1, 0]);
  assert.equal(h.doc.getElementById('book-reader-progress').hidden, true);
});

test('v05314 reader: a PDF opens at the saved page; 「读到第几页」 saves the page and rebuilds the viewer; EPUB has no such box', async t => {
  const h = await readerHarness(t, { info: [epubInfo, pdfInfo], chapters: chapterText, progress: { index: 1, chapter: 0, ratio: 0, page: 12 } });
  await h.reader.open('walvo');
  const input = h.doc.getElementById('book-reader-page'), frame = () => h.body().querySelector('.book-reader-pdf');
  assert.equal(frame().getAttribute('src'), '/api/books/walvo/1/pdf#page=12'); assert.equal(input.value, '12'); assert.equal(input.hidden, false);
  assert.equal(h.doc.querySelector('label[for="book-reader-page"]').textContent, '读到第几页');
  const before = frame(); input.value = '30'; await input.fire('change');
  assert.notEqual(frame(), before, 'a new viewer, so Chromium opens the page'); assert.equal(frame().getAttribute('src'), '/api/books/walvo/1/pdf#page=30');
  assert.deepEqual(h.lastPut(), { index: 1, chapter: 0, ratio: 0, page: 30 });
  for (const bad of ['abc', '0', '2.5', '100001']) { input.value = bad; await input.fire('change'); assert.equal(input.value, '30', bad); }
  input.value = ''; await input.fire('keydown', { key: 'Enter' });
  assert.equal(frame().getAttribute('src'), '/api/books/walvo/1/pdf', 'empty means from the start'); assert.deepEqual(h.lastPut(), { index: 1, chapter: 0, ratio: 0 });
  const files = h.doc.getElementById('book-reader-file'); files.value = '0'; await files.fire('change'); await new Promise(r => setTimeout(r, 0));
  assert.equal(input.hidden, true); assert.equal(h.doc.querySelector('label[for="book-reader-page"]').hidden, true);
});

test('v05314 排版: one setting for both readers, applied at once through CSSOM, rapid clicks merged, a failed save restored, Esc closes the panel', async t => {
  const doc = documentFrom('<html><body><div id="layout-root"></div></body></html>');
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const ctx = { doc, actions: new Proxy({}, { get: () => () => {} }), refs: {}, state: { view: 'concepts', category: 'all', query: '', selectedId: null, jointSelectedIds: [], allAgents: [], detailOpen: false } };
  ctx.root = shelf.render(ctx); doc.getElementById('layout-root').append(ctx.root);
  const puts = []; let answer;
  const api = (url, body, method) => {
    if (method === 'PUT') { puts.push(body); return new Promise((resolve, reject) => { answer = { resolve, reject }; }); }
    if (url === '/api/settings') return Promise.resolve({ reader: { fontSize: 21, lineHeight: 200, measure: 'wide', theme: 'paper' } });
    return Promise.resolve({ progress: null });
  };
  const reader = mountBookReader(doc, { api, getRegistry: () => ({ agents: [] }) }); t.after(() => reader.dispose());
  await configureReaderPrefs(doc, { api });
  const dialogs = [doc.getElementById('book-reader'), doc.getElementById('concept-reader')];
  const vars = name => dialogs.map(d => d.style.getPropertyValue(name));
  assert.deepEqual(vars('--reader-font-size'), ['21px', '21px'], 'the saved setting reaches both readers');
  assert.deepEqual(vars('--reader-line-height'), ['2', '2']); assert.deepEqual(vars('--reader-measure'), ['42', '42']);
  assert.ok(doc.getElementById('concept-reader-prefs-toggle'), 'the lecture / Word reader has its own 「Aa 排版」');
  const toggle = doc.getElementById('book-reader-prefs-toggle'), panel = doc.getElementById('book-reader-prefs');
  assert.equal(panel.hidden, true); assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(toggle.getAttribute('aria-controls'), 'book-reader-prefs');
  await toggle.fire('click'); assert.equal(panel.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const control = label => panel.querySelectorAll('button').find(b => b.getAttribute('aria-label') === label || b.textContent === label);
  await control('字号增大').fire('click');
  assert.deepEqual(vars('--reader-font-size'), ['22px', '22px'], 'at once, before the save returns');
  assert.equal(doc.getElementById('book-reader-prefs-font').textContent, '22'); assert.equal(doc.getElementById('concept-reader-prefs-font').textContent, '22');
  await control('字号增大').fire('click'); await control('字号增大').fire('click');
  assert.equal(puts.length, 1, 'one save at a time'); assert.deepEqual(puts[0], { reader: { fontSize: 22, lineHeight: 200, measure: 'wide', theme: 'paper' } });
  answer.resolve({ reader: puts[0].reader }); await new Promise(r => setTimeout(r, 0));
  assert.equal(puts.length, 2, 'the clicks made meanwhile are one save'); assert.equal(puts[1].reader.fontSize, 24);
  answer.resolve({ reader: puts[1].reader }); await readerPrefsState(doc).idle();
  assert.deepEqual(readerPrefsState(doc).saved, { fontSize: 24, lineHeight: 200, measure: 'wide', theme: 'paper' });
  await control('夜间').fire('click');
  assert.deepEqual(dialogs.map(d => d.getAttribute('data-reader-theme')), ['night', 'night']);
  assert.equal(control('夜间').getAttribute('aria-pressed'), 'true'); assert.equal(control('米黄').getAttribute('aria-pressed'), 'false');
  answer.reject(new Error('磁盘满')); await readerPrefsState(doc).idle();
  assert.deepEqual(dialogs.map(d => d.getAttribute('data-reader-theme')), ['paper', 'paper'], 'a failed save puts the saved colours back');
  assert.match(panel.textContent, /排版设置保存失败，已恢复原设置：磁盘满/);
  await control('恢复默认').fire('click');
  assert.deepEqual(vars('--reader-font-size'), ['19px', '19px']); assert.deepEqual(vars('--reader-measure'), ['36', '36']);
  answer.resolve({ reader: puts.at(-1).reader }); await readerPrefsState(doc).idle();
  for (let i = 0; i < 10; i++) {
    await control('字号增大').fire('click'); answer.resolve({ reader: puts.at(-1).reader }); await readerPrefsState(doc).idle();
  }
  assert.equal(control('字号增大').disabled, true, 'the largest size stops the button'); assert.deepEqual(vars('--reader-font-size'), ['26px', '26px']);
  // Esc in the panel closes the panel and gives the focus back to its button; the reader stays open.
  dialogs[0].showModal();
  await panel.parentElement.fire('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true); assert.equal(doc.activeElement, toggle); assert.equal(dialogs[0].open, true);
});

test('v05314 styles: measure by characters, variables for body type, readable colours in all three themes, quiet sup/sub and book links', async () => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\.shelf-reader-body \.concept-markdown \{\s*font-family:var\(--reader-song\);\s*font-size:var\(--reader-font-size\);\s*line-height:var\(--reader-line-height\);/);
  assert.match(css, /dialog\.shelf-reader \{[^}]*--reader-font-size:19px;[^}]*--reader-line-height:2\.05;[^}]*--reader-measure:36;/);
  assert.match(css, /\.shelf-reader-body sub \{\s*font-size:\.72em;\s*line-height:0;/);
  assert.match(css, /\.shelf-reader-body \.book-link \{[^}]*border:0;[^}]*background:none;/);
  const reader = css.slice(css.indexOf('/* v0.20 reading mode'), css.indexOf('/* The pulled-out book turns'));
  assert.doesNotMatch(reader.replace(/--reader-[\w-]+:#[0-9a-f]+;/g, ''), /#eadfc8|#efe4cf/, 'the reader\'s fixed colours are variables now');
  const palette = block => Object.fromEntries([...block.matchAll(/--reader-([\w-]+):(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]]));
  const paper = palette(css.match(/\[data-ui="shelf"\] dialog\.shelf-reader \{([^}]+)\}/)[1]);
  for (const theme of ['paper', 'gray', 'night']) {
    const colours = theme === 'paper' ? paper : { ...paper, ...palette(css.match(new RegExp(`dialog\\.shelf-reader\\[data-reader-theme="${theme}"\\] \\{([^}]+)\\}`))[1]) };
    for (const fg of ['ink', 'muted', 'link', 'quote']) for (const bg of ['paper', 'shade', 'hover'])
      assert.ok(contrast(colours[fg], colours[bg]) >= 4.5, `${theme}: ${fg} on ${bg} ${contrast(colours[fg], colours[bg]).toFixed(2)}`);
  }
  assert.match(css, /\.book-reader-pdf \{[^}]*background:#fff;/, 'a PDF stays on white');
});

// 2026-11-17: an English EPUB is set in a Latin serif; Chinese books and PDFs keep the Chinese serif.
test('v05315 reader: an English book marks the dialog for the Latin serif, a Chinese book and a PDF do not', async t => {
  const h = await readerHarness(t, { info: [{ ...epubInfo, lang: 'en' }, pdfInfo], chapters: chapterText });
  await h.reader.open('walvo');
  assert.equal(h.dialog.getAttribute('data-reader-lang'), 'en');
  const files = h.doc.getElementById('book-reader-file'); files.value = '1'; await files.fire('change');
  assert.equal(h.dialog.getAttribute('data-reader-lang'), 'zh', 'a PDF has its own fonts');
  const css = await (await import('node:fs/promises')).readFile(new URL('../public/layouts/shelf.css', import.meta.url), 'utf8');
  assert.match(css, /dialog\.book-reader\[data-reader-lang="en"\] \{ --reader-song:Georgia,/);
});
