// v0.42 书本检视 (2026-11-01): the pulled-out book shows its weight by page count and the hours a normal reader
// needs. A PDF has real pages; an EPUB's pages are estimated from its text. Reading speed: 255 Chinese characters a
// minute (Trauzettel-Klosinski et al. 2012, IReST) and 238 English words a minute for non-fiction (Brysbaert 2019).
import zlib from 'node:zlib';

export const PAGE_UNITS = { zh: 600, en: 300 };   // characters or words on one printed page
export const READ_SPEED = { zh: 255, en: 238 };   // per minute
const CJK = /[㐀-䶿一-鿿豈-﫿]/g, WORD = /[A-Za-z][A-Za-z'’-]*/g;

// Characters and words of plain text; a book is Chinese when its Chinese characters outnumber its English words.
export function measureText(text) {
  const chars = (String(text).match(CJK) || []).length, words = (String(text).match(WORD) || []).length;
  return { chars, words, lang: chars > words ? 'zh' : 'en' };
}

// Text of an EPUB chapter's Markdown: image and link targets are not read.
export const markdownText = markdown => String(markdown).replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\]\([^)]*\)/g, ' ');

// The page count of a PDF: the largest /Count of a /Type /Pages node, searched in the file and inside its compressed
// object streams; failing that, the number of /Type /Page leaves.
export function pdfPageCount(buffer) {
  const texts = [buffer.toString('latin1')];
  for (const match of texts[0].matchAll(/\/Type\s*\/ObjStm\b/g)) {
    const start = texts[0].indexOf('stream', match.index); if (start < 0) continue;
    let from = start + 6; if (texts[0][from] === '\r') from++; if (texts[0][from] === '\n') from++;
    const end = texts[0].indexOf('endstream', from); if (end < 0) continue;
    try { texts.push(zlib.inflateSync(buffer.subarray(from, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1')); } catch { /* not Flate, or damaged */ }
  }
  let count = 0, leaves = 0;
  for (const text of texts) {
    for (const match of text.matchAll(/\/Type\s*\/Pages\b/g)) {
      const around = text.slice(Math.max(0, match.index - 300), match.index + 300);
      for (const n of around.matchAll(/\/Count\s+(\d+)/g)) count = Math.max(count, Number(n[1]));
    }
    leaves += (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  }
  return count || leaves;
}

// Pages and reading minutes of one book from either real pages (PDF) or measured text (EPUB).
export function fileFacts({ pages, chars = 0, words = 0, lang }) {
  const units = lang === 'zh' ? chars : words;
  return { pages: pages || Math.max(1, Math.round(units / PAGE_UNITS[lang])), estimatedPages: !pages,
    minutes: (pages ? pages * PAGE_UNITS[lang] : units) / READ_SPEED[lang] };
}
// A set of books (one agent may hold several) weighs and takes what its books do together; hours to the whole hour.
export function bookFacts(measurements) {
  const books = measurements.map(fileFacts);
  return {
    books: books.length, pages: books.reduce((sum, b) => sum + b.pages, 0), estimatedPages: books.some(b => b.estimatedPages),
    // A sheet of book paper and its share of the binding: 1.4 g a page on 100 g of cover, per book.
    weightKg: Math.round(books.reduce((sum, b) => sum + 0.1 + b.pages * 0.0014, 0) * 100) / 100,
    hours: Math.max(1, Math.round(books.reduce((sum, b) => sum + b.minutes, 0) / 60)),
  };
}
