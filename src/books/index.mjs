// v0.41 在软件中阅读原书 (2026-11-01). A book file is named only by its agent and its index in the registry's
// bookFiles, never by a path from the page; the files stay read-only. EPUBs are parsed here (src/books/epub.mjs) and
// served chapter by chapter; PDFs are streamed to the reader's embedded viewer; MOBI is left to the system program.
// Reading positions live in <dataDir>/reading-progress.json.
// v0.42: each file's measured pages or text are cached in <dataDir>/book-facts.json, and the time spent reading a book
// in the app (only while someone is actually reading: 2026-11-01) adds up in <dataDir>/reading-time.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../fsutil.mjs';
import { openEpub } from './epub.mjs';
import { measureText, markdownText, pdfPageCount, bookFacts } from './facts.mjs';
import { derivedReadingCopy } from '../../public/display.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const readableFormats = ['epub', 'pdf'];
export const formatOf = file => String(file?.ext || path.extname(file?.path || '').slice(1)).toLowerCase();

// Language of a PDF, whose text is not read: from the recorded edition, else from the title.
export function bookLang(agent) {
  const edition = String(agent?.book?.edition || '');
  if (/中文|汉译|Chinese/i.test(edition)) return 'zh';
  if (/英文|英语|English/i.test(edition)) return 'en';
  return /[\u4e00-\u9fff]/.test(String(agent?.book?.title || '').replace(/[《》]/g, '')) ? 'zh' : 'en';
}
// Away from the keyboard for this long and the reading clock stops.
export const IDLE_LIMIT_S = 300;

export function createBooks({ dataDir, getRegistry, io = fs, cacheSize = 3, now = () => new Date(), systemIdle = null }) {
  const cache = new Map(), progressFile = path.join(dataDir, 'reading-progress.json');
  const factsFile = path.join(dataDir, 'book-facts.json'), timeFile = path.join(dataDir, 'reading-time.json'), measuring = new Map();
  let progress = null, factsCache = null, times = null, writes = Promise.resolve();
  function fileOf(agentId, index) {
    const agent = getRegistry()?.agents.find(a => a.id === agentId && a.kind === 'book');
    if (!agent || !Number.isSafeInteger(index) || index < 0 || !agent.bookFiles?.[index]) fail(404, '没有这本原书');
    return { agent, file: agent.bookFiles[index] };
  }
  async function epub(agentId, index) {
    const { file } = fileOf(agentId, index);
    if (formatOf(file) !== 'epub') fail(415, '这本原书不是 EPUB');
    let stat;
    try { stat = await io.stat(file.path); } catch { fail(404, '原书文件不存在或无法读取'); }
    const key = `${file.path}|${stat.size}|${stat.mtimeMs}`;
    if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
    const book = openEpub(await io.readFile(file.path));
    cache.set(key, book);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return book;
  }
  async function loadProgress() {
    if (progress) return progress;
    try { const value = JSON.parse(await io.readFile(progressFile, 'utf8')); progress = value?.books && typeof value.books === 'object' ? value : null; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return progress ??= { version: 1, books: {} };
  }
  async function loadJSON(file, fallback, key) {
    try { const value = JSON.parse(await io.readFile(file, 'utf8')); if (value?.[key] && typeof value[key] === 'object') return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return fallback;
  }
  const queue = task => { const work = writes.then(task); writes = work.catch(() => {}); return work; };
  // Pages of a PDF, or the characters and words of an EPUB's chapters, measured once per file version.
  async function measure(agent, file) {
    let stat;
    try { stat = await io.stat(file.path); } catch { fail(404, '原书文件不存在或无法读取'); }
    const key = `${file.path}|${stat.size}|${stat.mtimeMs}`;
    factsCache ??= await loadJSON(factsFile, { version: 1, files: {} }, 'files');
    if (factsCache.files[key]) return factsCache.files[key];
    if (!measuring.has(key)) measuring.set(key, (async () => {
      let value;
      if (formatOf(file) === 'pdf') value = { pages: pdfPageCount(await io.readFile(file.path)), lang: bookLang(agent) };
      else {
        const book = openEpub(await io.readFile(file.path));
        value = measureText(book.chapters.map((_, n) => markdownText(book.chapter(n, () => ''))).join('\n'));
      }
      await queue(async () => {
        for (const old of Object.keys(factsCache.files)) if (old.startsWith(file.path + '|')) delete factsCache.files[old];
        factsCache.files[key] = value;
        await atomicWrite(factsFile, JSON.stringify(factsCache, null, 2) + '\n');
      });
      return value;
    })().finally(() => measuring.delete(key)));
    return measuring.get(key);
  }
  return {
    // What the reader needs to open a book: every file with whether it can be read here, and the chosen file's outline.
    async info(agentId, index) {
      const { agent, file } = fileOf(agentId, index), format = formatOf(file);
      const files = agent.bookFiles.map((f, i) => ({ index: i, label: f.label || path.basename(f.path), format: formatOf(f), exists: f.exists !== false, readable: readableFormats.includes(formatOf(f)), derived: derivedReadingCopy(f) }));
      const base = { agentId, index, label: file.label || path.basename(file.path), format, files };
      if (format === 'pdf') return { ...base, pdf: `/api/books/${encodeURIComponent(agentId)}/${index}/pdf` };
      if (format !== 'epub') return { ...base, unsupported: true };
      const book = await epub(agentId, index);
      return { ...base, title: book.title, chapters: book.chapters, toc: book.toc };
    },
    async chapter(agentId, index, n) {
      const book = await epub(agentId, index);
      if (!Number.isSafeInteger(n) || n < 0 || n >= book.chapters.length) fail(404, '没有这一章');
      const prefix = `/api/books/${encodeURIComponent(agentId)}/${index}/assets?path=`;
      return { chapter: n, title: book.chapters[n].title, markdown: book.chapter(n, name => prefix + encodeURIComponent(name)) };
    },
    async asset(agentId, index, name) {
      if (typeof name !== 'string' || !name || name.length > 512) fail(404, '没有这个图片');
      return (await epub(agentId, index)).asset(name);
    },
    // The PDF itself, for the embedded viewer; read-only and only a registered book file.
    async pdf(agentId, index) {
      const { file } = fileOf(agentId, index);
      if (formatOf(file) !== 'pdf') fail(415, '这本原书不是 PDF');
      try { const stat = await io.stat(file.path); if (!stat.isFile()) throw new Error(); return { path: file.path, size: stat.size }; }
      catch { fail(404, '原书文件不存在或无法读取'); }
    },
    async progress(agentId) {
      fileOf(agentId, 0);
      return (await loadProgress()).books[agentId] || null;
    },
    async saveProgress(agentId, body) {
      const { agent } = fileOf(agentId, 0);
      const { index, chapter, ratio } = body || {};
      if (!Number.isSafeInteger(index) || index < 0 || !agent.bookFiles[index]) fail(400, '原书序号无效');
      if (!Number.isSafeInteger(chapter) || chapter < 0 || chapter > 100000) fail(400, '章节无效');
      if (typeof ratio !== 'number' || !(ratio >= 0 && ratio <= 1)) fail(400, '阅读位置无效');
      return queue(async () => {
        const all = await loadProgress();
        all.books[agentId] = { index, chapter, ratio: Math.round(ratio * 10000) / 10000, updatedAt: now().toISOString() };
        await atomicWrite(progressFile, JSON.stringify(all, null, 2) + '\n');
        return all.books[agentId];
      });
    },
    // What the pulled-out book shows: pages, weight, the hours a normal reader needs, and the hours already read here.
    // Every original EPUB or PDF counts (an agent can hold several books); a derived reading copy only stands in when
    // there is no readable original.
    async facts(agentId) {
      const { agent } = fileOf(agentId, 0);
      const readable = agent.bookFiles.filter(f => f.exists !== false && readableFormats.includes(formatOf(f)));
      const originals = readable.filter(f => !derivedReadingCopy(f)), files = originals.length ? originals : readable.slice(0, 1);
      const measured = [];
      for (const file of files) measured.push(await measure(agent, file).catch(error => { if (error.status === 404) return null; throw error; }));
      times ??= await loadJSON(timeFile, { version: 1, books: {} }, 'books');
      const known = measured.filter(Boolean), readSeconds = times.books[agentId]?.seconds || 0;
      return { agentId, ...(known.length ? bookFacts(known) : { books: 0 }), readSeconds };
    },
    // A heartbeat from the open reader: the seconds since its last beat count only while someone is at the computer.
    // In the desktop app that is the system's own idle time (it also sees scrolling inside the PDF viewer); in a
    // browser it is the page's report of recent input.
    async addReadingTime(agentId, body) {
      fileOf(agentId, 0);
      const { seconds, active } = body || {};
      if (typeof seconds !== 'number' || !(seconds >= 0 && seconds <= 120)) fail(400, '阅读时长无效');
      const reading = systemIdle ? systemIdle() < IDLE_LIMIT_S : active === true;
      return queue(async () => {
        times ??= await loadJSON(timeFile, { version: 1, books: {} }, 'books');
        const entry = times.books[agentId] ||= { seconds: 0 };
        if (reading && seconds > 0) {
          entry.seconds = Math.round((entry.seconds + seconds) * 10) / 10; entry.updatedAt = now().toISOString();
          await atomicWrite(timeFile, JSON.stringify(times, null, 2) + '\n');
        }
        return { seconds: entry.seconds, counted: reading };
      });
    },
    idle: () => writes,
  };
}
