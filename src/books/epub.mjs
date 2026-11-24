// v0.41 (2026-11-01): read an original EPUB inside CO-AGENT's reading mode. Standard library only: the ZIP is
// read through its central directory, the package (OPF), spine and table of contents (EPUB 3 nav or EPUB 2 NCX) are
// walked with the small XML parser of the Word reports, and each chapter's XHTML becomes the reader's Markdown subset.
// Book text stays literal: it is escaped, never passed through as HTML; images become local asset addresses.
import zlib from 'node:zlib';
import path from 'node:path';
import { parseXml } from '../reports/docx.mjs';

const MAX_PART = 64 * 1024 * 1024;
const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const local = name => String(name || '').split(':').pop().toLowerCase();
const children = (node, name) => (node?.children || []).filter(child => child.name && local(child.name) === name);
const child = (node, name) => children(node, name)[0];
function find(node, test) {
  if (node.name && test(node)) return node;
  for (const item of node.children || []) { const found = item.name ? find(item, test) : null; if (found) return found; }
  return null;
}
const textOf = node => node.text ?? (node.children || []).map(textOf).join('');
const named = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', shy: '', zwnj: '', zwj: '',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', iuml: 'ï', ocirc: 'ô' };

// The ZIP directory: name → entry. Entries are inflated on demand.
export function zipIndex(buffer) {
  const entries = new Map();
  try {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) fail('不是有效的 EPUB 文件：缺少 ZIP 目录');
    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(at) !== 0x02014b50) fail('EPUB 文件目录已损坏');
      const method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
      const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
      const offset = buffer.readUInt32LE(at + 42), name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
      entries.set(name, { method, compressed, size, offset });
      at += 46 + nameLength + extraLength + commentLength;
    }
  } catch (error) { if (error.status) throw error; fail(`EPUB 文件无法读取：${error.message}`); }
  return entries;
}
export function readEntry(buffer, entry) {
  if (!entry) fail('EPUB 中没有这个部件', 404);
  if (entry.size > MAX_PART) fail('EPUB 部件过大');
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) fail('EPUB 文件内容已损坏');
  const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
  const data = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART });
  fail(`不支持的 EPUB 压缩方式：${entry.method}`);
}

// Paths inside the book: relative to the referring file, without fragments or escapes.
export function resolveHref(base, href) {
  let target = String(href || '').split('#')[0];
  try { target = decodeURIComponent(target); } catch { /* keep the literal name */ }
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
  return joined.startsWith('../') || joined === '..' ? null : joined.replace(/^\.\//, '');
}
// v0.53.14: the fragment of a link (after #, decoded), '' without one.
export function hrefAnchor(href) {
  const text = String(href || ''), at = text.indexOf('#');
  if (at < 0) return '';
  try { return decodeURIComponent(text.slice(at + 1)); } catch { return text.slice(at + 1); }
}
// A link inside the book: its file (the referring file itself for a bare #fragment) and its anchor; null when it leaves the book.
function bookTarget(base, href) {
  const text = String(href || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  const file = text.split('#')[0] ? resolveHref(base, text) : base;
  return file ? { file, anchor: hrefAnchor(text) } : null;
}

// v0.53.14 书内标记: private-use characters wrap anchors, superscripts, subscripts and links inside the book in the
// chapter's Markdown; only renderMarkdown(doc, markdown, { book: true }) reads them. The book's own text never carries
// them (escapeText removes U+E000–U+E008), so a book cannot forge one.
export const MARK = Object.freeze({ anchor: '', anchorEnd: '', sup: '', supEnd: '', sub: '', subEnd: '',
  link: '', linkText: '', linkEnd: '' });
const MARKS = /[-]/g;
// Anchor names inside a mark keep only characters the Markdown reader never treats as syntax; the rest is %-encoded.
export const encodeAnchor = name => Array.from(String(name).replace(MARKS, '')).map(c => /[A-Za-z0-9.:-]/.test(c) ? c
  : [...Buffer.from(c, 'utf8')].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')).join('');

export function openEpub(buffer) {
  const index = zipIndex(buffer);
  const read = name => readEntry(buffer, index.get(name));
  const xml = name => parseXml(read(name).toString('utf8'), named);
  const container = xml('META-INF/container.xml');
  const opfPath = find(container, node => local(node.name) === 'rootfile')?.attrs['full-path'];
  if (!opfPath || !index.has(opfPath)) fail('EPUB 缺少包文件（OPF）');
  const opf = xml(opfPath), pkg = find(opf, node => local(node.name) === 'package');
  const manifest = new Map();
  for (const item of children(child(pkg, 'manifest'), 'item')) {
    const href = resolveHref(opfPath, item.attrs.href);
    if (href) manifest.set(item.attrs.id, { href, type: item.attrs['media-type'] || '', properties: item.attrs.properties || '' });
  }
  const spineNode = child(pkg, 'spine');
  const spine = children(spineNode, 'itemref').map(ref => manifest.get(ref.attrs.idref)).filter(item => item && index.has(item.href) && /html|xml/.test(item.type));
  if (!spine.length) fail('EPUB 没有可读的章节');
  const title = textOf(find(child(pkg, 'metadata') || pkg, node => local(node.name) === 'title') || { text: '' }).trim();
  const chapterOf = href => spine.findIndex(item => item.href === href);
  const toc = [];
  // v0.53.14: each entry also carries the anchor of its link (the decoded fragment, '' without one).
  const add = (label, base, href, depth) => {
    const chapter = chapterOf(resolveHref(base, href)), text = label.replace(/\s+/g, ' ').trim();
    if (chapter >= 0 && text) toc.push({ title: text, chapter, depth, anchor: hrefAnchor(href) });
  };
  const nav = [...manifest.values()].find(item => /\bnav\b/.test(item.properties) && index.has(item.href));
  if (nav) {
    const doc = xml(nav.href);
    const tocNav = find(doc, node => local(node.name) === 'nav' && /toc/.test(node.attrs['epub:type'] || node.attrs.role || '')) || find(doc, node => local(node.name) === 'nav');
    const walk = (list, depth) => {
      for (const li of children(list, 'li')) {
        const link = child(li, 'a') || child(li, 'span');
        if (link?.attrs?.href) add(textOf(link), nav.href, link.attrs.href, depth);
        const sub = child(li, 'ol') || child(li, 'ul'); if (sub) walk(sub, depth + 1);
      }
    };
    const list = tocNav && (child(tocNav, 'ol') || child(tocNav, 'ul'));
    if (list) walk(list, 0);
  }
  if (!toc.length) {
    const ncx = manifest.get(spineNode?.attrs.toc) || [...manifest.values()].find(item => /ncx/.test(item.type));
    if (ncx && index.has(ncx.href)) {
      const walk = (parent, depth) => {
        for (const point of children(parent, 'navpoint')) {
          const label = textOf(child(point, 'navlabel') || { text: '' }), src = child(point, 'content')?.attrs.src;
          if (src) add(label, ncx.href, src, depth);
          walk(point, depth + 1);
        }
      };
      walk(find(xml(ncx.href), node => local(node.name) === 'navmap') || {}, 0);
    }
  }
  if (!toc.length) {
    // Generated once when opening the book; createBooks caches this object for subsequent info requests.
    const headings = [], seen = new Set();
    const walk = (node, chapter) => {
      const tag = local(node.name);
      if (SKIP.has(tag)) return;
      if (/^h[1-3]$/.test(tag)) {
        const title = textOf(node).replace(/\s+/g, ' ').trim();
        if (title && Array.from(title).length <= 80 && !seen.has(title)) {
          seen.add(title); headings.push({ title, chapter, depth: tag === 'h3' ? 1 : 0, anchor: String(node.attrs.id || '') });
        }
      }
      for (const child of node.children || []) if (child.name) walk(child, chapter);
    };
    spine.forEach((item, chapter) => walk(xml(item.href), chapter));
    if (headings.length >= 3) toc.push(...headings);
  }
  const chapters = spine.map((item, i) => ({ title: toc.find(entry => entry.chapter === i)?.title || '' }));
  // Ids something points at, per file: the outline's anchors and every chapter's own links. Scanned once, on the first chapter.
  let targets = null;
  const anchorTargets = () => {
    if (targets) return targets;
    targets = new Map(spine.map(item => [item.href, new Set()]));
    for (const entry of toc) if (entry.anchor) targets.get(spine[entry.chapter].href).add(entry.anchor);
    const walk = (node, base) => {
      if (local(node.name) === 'a' && node.attrs.href) {
        const target = bookTarget(base, node.attrs.href);
        if (target?.anchor && targets.has(target.file)) targets.get(target.file).add(target.anchor);
      }
      for (const item of node.children || []) if (item.name) walk(item, base);
    };
    for (const item of spine) { try { walk(xml(item.href), item.href); } catch { /* a damaged chapter fails when it is read */ } }
    return targets;
  };
  return {
    title, chapters, toc,
    chapter(n, assetUrl) {
      const item = spine[n]; if (!item) fail('没有这一章', 404);
      return chapterMarkdown(read(item.href).toString('utf8'), item.href, assetUrl, { anchors: anchorTargets().get(item.href), chapterOf });
    },
    asset(name) {
      const item = [...manifest.values()].find(entry => entry.href === name);
      if (!item || !/^image\//.test(item.type)) fail('没有这个图片', 404);
      return { type: item.type, data: read(name) };
    },
  };
}

// XHTML → the reader's Markdown subset. Text is escaped; tags outside the subset contribute their text only.
const escapeText = text => text.replace(MARKS, '').replace(/[\\`*_[\]|~<>]/g, '\\$&');
const escapeLineStart = line => /^(#|>|[-+]\s|\d+[.)]\s|-{3,}|`{3})/.test(line) ? '\\' + line : line;
const BLOCK = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption', 'blockquote', 'ul', 'ol', 'li', 'table',
  'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'center', 'body', 'html']);
const SKIP = new Set(['head', 'script', 'style', 'title', 'link', 'meta']);
// options (v0.53.14): anchors, the ids in this file that something points at (an anchor mark is written only for those);
// chapterOf(file), the spine index of a file in the book (-1 outside the spine), for links inside the book.
export function chapterMarkdown(xhtml, href, assetUrl = name => name, { anchors = null, chapterOf = () => -1 } = {}) {
  const doc = parseXml(xhtml, named), body = find(doc, node => local(node.name) === 'body') || doc, out = [];
  const image = (src, alt = '') => {
    const name = resolveHref(href, src);
    return name ? `![${escapeText(alt.replace(/\s+/g, ' ').trim())}](${assetUrl(name).replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())})` : '';
  };
  const anchorOf = node => { const id = node.attrs?.id; return id && anchors?.has(id) ? MARK.anchor + encodeAnchor(id) + MARK.anchorEnd : ''; };
  // The anchor of a block waits for the block's first text (for an empty block, the next text).
  let pending = '';
  const take = () => { const mark = pending; pending = ''; return mark; };
  function link(node, text) {
    const address = String(node.attrs.href || '').trim();
    if (/^https?:\/\//i.test(address)) {
      if (!text.trim() || text.includes('![')) return text;
      return `[${text.trim()}](${address.replace(MARKS, '').replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))})`;
    }
    const target = bookTarget(href, address), chapter = target ? chapterOf(target.file) : -1;
    if (chapter < 0 || !text.trim()) return text;
    return MARK.link + chapter + '#' + encodeAnchor(target.anchor) + MARK.linkText + text.trim() + MARK.linkEnd;
  }
  function inline(node) {
    if (node.text !== undefined) return escapeText(node.text.replace(/\s+/g, ' '));
    const tag = local(node.name), inner = () => (node.children || []).map(inline).join('');
    if (SKIP.has(tag)) return '';
    const mark = anchorOf(node);
    if (tag === 'br') return '\n' + mark + inner();
    if (tag === 'img') return mark + ` ${image(node.attrs.src, node.attrs.alt || '')} ` + inner();
    if (tag === 'image') return mark + ` ${image(node.attrs['xlink:href'] || node.attrs.href, '')} `;
    const text = inner();
    if (!text.trim()) return mark + text;
    if (['em', 'i', 'cite', 'dfn'].includes(tag)) return `${mark}*${text.trim()}*`;
    if (['strong', 'b'].includes(tag)) return `${mark}**${text.trim()}**`;
    if (tag === 'code' || tag === 'kbd') return mark + '`' + textOf(node).replace(MARKS, '').replace(/`/g, "'") + '`';
    if (tag === 'sup') return mark + MARK.sup + text.trim() + MARK.supEnd;
    if (tag === 'sub') return mark + MARK.sub + text.trim() + MARK.subEnd;
    if (tag === 'a' && node.attrs.href) return mark + link(node, text);
    return mark + text;
  }
  const push = (text, prefix = '') => {
    const lines = text.split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) return;
    if (pending) lines[0] = take() + lines[0];
    out.push(lines.map((line, i) => (i ? ' '.repeat(prefix.length) : prefix) + (prefix ? line : escapeLineStart(line))).join('\n'), '');
  };
  function block(node, quote = '') {
    if (node.text !== undefined) { push(inline(node), quote); return; }
    const tag = local(node.name);
    if (SKIP.has(tag)) return;
    if (/^h[1-6]$/.test(tag)) {
      // A heading's own anchor comes from inline(), in front of its text.
      const text = inline(node).replace(/\n/g, ' ').trim();
      if (text) out.push(quote + '#'.repeat(Math.min(6, Number(tag[1]) + 1)) + ' ' + take() + text, '');
      return;
    }
    pending += anchorOf(node);
    if (tag === 'hr') { out.push('---', ''); return; }
    if (tag === 'pre') { out.push('```', textOf(node).replace(MARKS, '').replace(/```/g, "'''"), '```', ''); return; }
    if (tag === 'ul' || tag === 'ol') { list(node, tag === 'ol', 0); out.push(''); return; }
    if (tag === 'table') { table(node); return; }
    if (tag === 'blockquote') { const start = out.length; for (const item of node.children || []) block(item); for (let i = start; i < out.length - 1; i++) out[i] = out[i].split('\n').map(line => '> ' + line).join('\n'); return; }
    // Inline runs between blocks become paragraphs; nested blocks keep their own paragraphs.
    let run = '';
    const flush = () => { if (run.trim()) push(run, quote); run = ''; };
    for (const item of node.children || []) {
      if (item.name && BLOCK.has(local(item.name))) { flush(); block(item, quote); }
      else if (item.name && local(item.name) === 'img' && !run.trim()) { flush(); push(inline(item)); }
      else run += inline(item);
    }
    flush();
  }
  function list(node, ordered, depth) {
    let n = 0;
    for (const li of children(node, 'li')) {
      n++;
      const nested = (li.children || []).filter(item => item.name && ['ul', 'ol'].includes(local(item.name)));
      const text = (li.children || []).filter(item => !nested.includes(item)).map(inline).join('').replace(/\s*\n\s*/g, ' ').trim();
      out.push(' '.repeat(depth * 2) + (ordered ? `${n}. ` : '- ') + take() + anchorOf(li) + (text || '·'));
      for (const sub of nested) list(sub, local(sub.name) === 'ol', depth + 1);
    }
  }
  function table(node) {
    const rows = [];
    const collect = parent => { for (const item of parent.children || []) { if (!item.name) continue; const tag = local(item.name);
      // Cells in document order: a row header (<th scope="row">) stays in the first column. inline() already escapes |.
      if (tag === 'tr') {
        const row = (item.children || []).filter(cell => cell.name && ['td', 'th'].includes(local(cell.name))).map(cell => inline(cell).replace(/\s*\n\s*/g, ' ').trim());
        if (row.length) row[0] = anchorOf(item) + row[0];
        rows.push(row);
      }
      else if (['thead', 'tbody', 'tfoot'].includes(tag)) collect(item); } };
    collect(node);
    const width = Math.max(0, ...rows.map(row => row.length));
    if (!width) return;
    rows[0][0] = take() + (rows[0][0] || '');
    const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || ' ').join(' | ') + ' |';
    out.push(line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line), '');
  }
  block(body);
  if (pending) out.push(take(), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
