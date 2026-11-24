// A deliberately small Markdown subset. Source HTML always remains literal text.
const element = (doc, tag, text) => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
function externalAddress(raw) {
  if (!/^https?:\/\//i.test(raw) || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  try { const url = new URL(raw); return url.username || url.password ? null : url.href; }
  catch { return null; }
}
// 2026-11-16 书内标记 (src/books/epub.mjs): with { book: true } the private-use marks U+E000–U+E008 of an original book's
// chapter become anchors, superscripts, subscripts and links inside the book; elsewhere they stay ordinary characters.
const bookPairs = { '': ['sup', ''], '': ['sub', ''] };
const isBookMark = c => c >= '' && c <= '';
const decodeName = text => { try { return decodeURIComponent(text); } catch { return text; } };
function closing(source, from, open, close) {
  let level = 1;
  for (let i = from; i < source.length; i++) { if (source[i] === open) level++; else if (source[i] === close && !--level) return i; }
  return -1;
}
// Renders the mark at source[i] and returns the index after it; an unmatched or stray mark is dropped.
function bookMark(doc, target, source, i, depth) {
  const c = source[i];
  if (c === '') {
    const end = source.indexOf('', i + 1); if (end < 0) return i + 1;
    const span = element(doc, 'span'); span.setAttribute('data-book-anchor', decodeName(source.slice(i + 1, end))); target.append(span);
    return end + 1;
  }
  if (bookPairs[c]) {
    const [tag, close] = bookPairs[c], end = closing(source, i + 1, c, close); if (end < 0) return i + 1;
    const node = element(doc, tag); inline(doc, node, source.slice(i + 1, end), depth + 1, true); target.append(node);
    return end + 1;
  }
  if (c === '') {
    const middle = source.indexOf('', i + 1), end = middle < 0 ? -1 : closing(source, middle + 1, '', '');
    if (end < 0) return i + 1;
    const goal = source.slice(i + 1, middle), at = goal.indexOf('#'), chapter = at < 0 ? goal : goal.slice(0, at);
    if (!/^\d{1,6}$/.test(chapter)) { inline(doc, target, source.slice(middle + 1, end), depth + 1, true); return end + 1; }
    const link = element(doc, 'button'); link.setAttribute('type', 'button'); link.className = 'book-link';
    link.setAttribute('data-book-chapter', chapter); link.setAttribute('data-book-anchor', at < 0 ? '' : decodeName(goal.slice(at + 1)));
    inline(doc, link, source.slice(middle + 1, end), depth + 1, true); target.append(link);
    return end + 1;
  }
  return i + 1;
}
function inline(doc, target, source, depth = 0, book = false) {
  if (depth > 20) { target.append(doc.createTextNode(book ? source.replace(/[-]/g, '') : source)); return; }
  let plain = '';
  const flush = () => { if (plain) target.append(doc.createTextNode(plain)); plain = ''; };
  for (let i = 0; i < source.length;) {
    if (book && isBookMark(source[i])) { flush(); i = bookMark(doc, target, source, i, depth); continue; }
    if (source[i] === '\\' && /[\\`*_{}\[\]()#+.!>|~-]/.test(source[i + 1] || '')) { plain += source[i + 1]; i += 2; continue; }
    if (source[i] === '`') {
      const delimiter = source.slice(i).match(/^`+/)[0], end = source.indexOf(delimiter, i + delimiter.length);
      if (end >= 0) { flush(); target.append(element(doc, 'code', source.slice(i + delimiter.length, end))); i = end + delimiter.length; continue; }
    }
    const image = source.startsWith('![', i), start = image ? i + 1 : i;
    if (source[start] === '[') {
      const endLabel = source.indexOf('](', start + 1);
      if (endLabel >= 0) {
        let end = endLabel + 2, level = 1;
        while (end < source.length && level) { if (source[end] === '(') level++; if (source[end] === ')') level--; end++; }
        if (!level) {
          const label = source.slice(start + 1, endLabel), address = source.slice(endLabel + 2, end - 1), href = !image && externalAddress(address);
          flush();
          // v0.41: an original book's own pictures, served by this app (/api/books/…/assets), are shown; any other image stays text.
          if (image && /^\/api\/books\/[^\s"'<>()]+$/.test(address)) {
            const picture = element(doc, 'img'); picture.setAttribute('src', address); picture.setAttribute('alt', label.replace(/\\(.)/g, '$1'));
            picture.className = 'book-image'; target.append(picture); // Not lazy: inside the reader dialog a lazy 0×0 image never starts loading.
          } else if (href) {
            // In a book the link text is the book's escaped (and possibly marked) text, so it is rendered, not shown raw.
            const link = element(doc, 'a', book ? undefined : `${label}（${address}）`);
            if (book) { inline(doc, link, label, depth + 1, true); link.append(doc.createTextNode(`（${address}）`)); }
            link.setAttribute('href', href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
            target.append(link); // Electron's existing external-link handler owns navigation.
          } else target.append(doc.createTextNode(`${image ? '图片：' : ''}${label}（${address}）`));
          i = end; continue;
        }
      }
    }
    const mark = ['***', '___', '**', '__', '*', '_'].find(value => source.startsWith(value, i));
    if (mark && !(mark[0] === '_' && /[\p{L}\p{N}]/u.test(source[i - 1] || ''))) {
      const end = source.indexOf(mark, i + mark.length);
      if (end > i + mark.length) {
        flush(); const node = element(doc, mark.length > 1 ? 'strong' : 'em');
        const child = mark.length === 3 ? element(doc, 'em') : node;
        inline(doc, child, source.slice(i + mark.length, end), depth + 1, book);
        if (child !== node) node.append(child);
        target.append(node); i = end + mark.length; continue;
      }
    }
    plain += source[i++];
  }
  flush();
}
function cells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, ''), result = []; let cell = '', ticks = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; }
    else if (text[i] === '`') { ticks = !ticks; cell += '`'; }
    else if (text[i] === '|' && !ticks) { result.push(cell.trim()); cell = ''; }
    else cell += text[i];
  }
  result.push(cell.trim()); return result;
}
const fence = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
const listItem = line => line.match(/^( *)([-+*]|\d+[.)])\s+(.*)$/);
const rule = line => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const heading = line => line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
function tableStart(lines, i) {
  return lines[i]?.includes('|') && lines[i + 1]?.includes('|') && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c));
}
function blocks(doc, target, lines, depth = 0, book = false) {
  if (depth > 32) { target.append(element(doc, 'pre', lines.join('\n'))); return; }
  for (let i = 0; i < lines.length;) {
    const line = lines[i]; if (!line.trim()) { i++; continue; }
    const codeFence = fence(line), title = heading(line), item = listItem(line);
    if (codeFence) {
      const source = [], delimiter = codeFence[1]; i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}\\s*$`).test(lines[i])) source.push(lines[i++]);
      if (i < lines.length) i++;
      const box = element(doc, 'figure');
      if (codeFence[2].trim().toLowerCase() === 'mermaid') box.append(element(doc, 'figcaption', 'Mermaid 图（源码）'));
      const pre = element(doc, 'pre'); pre.append(element(doc, 'code', source.join('\n'))); box.append(pre); target.append(box); continue;
    }
    if (title) { const h = element(doc, `h${title[1].length}`); inline(doc, h, title[2], 0, book); target.append(h); i++; continue; }
    if (rule(line)) { target.append(element(doc, 'hr')); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote = []; while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      const node = element(doc, 'blockquote'); blocks(doc, node, quote, depth + 1, book); target.append(node); continue;
    }
    if (tableStart(lines, i)) {
      const table = element(doc, 'table'), head = element(doc, 'thead'), body = element(doc, 'tbody'), row = element(doc, 'tr'), headers = cells(line);
      for (const text of headers) { const cell = element(doc, 'th'); cell.setAttribute('scope', 'col'); inline(doc, cell, text, 0, book); row.append(cell); }
      head.append(row); i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = element(doc, 'tr'), values = cells(lines[i++]);
        for (let j = 0; j < headers.length; j++) { const cell = element(doc, 'td'); inline(doc, cell, values[j] || '', 0, book); row.append(cell); }
        body.append(row);
      }
      table.append(head, body); target.append(table); continue;
    }
    if (item) {
      const ordered = /^\d/.test(item[2]), indent = item[1].length, list = element(doc, ordered ? 'ol' : 'ul');
      if (ordered) list.setAttribute('start', String(parseInt(item[2], 10)));
      while (i < lines.length) {
        const match = listItem(lines[i]); if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered || rule(lines[i])) break;
        const li = element(doc, 'li'); inline(doc, li, match[3], 0, book); i++;
        const nested = [];
        while (i < lines.length && lines[i].trim() && lines[i].match(/^ */)[0].length > indent) nested.push(lines[i++].slice(indent + 2));
        if (nested.length) blocks(doc, li, nested, depth + 1, book);
        list.append(li);
      }
      target.append(list); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !heading(lines[i]) && !rule(lines[i]) && !listItem(lines[i]) && !/^ {0,3}>/.test(lines[i]) && !tableStart(lines, i)) paragraph.push(lines[i++]);
    const p = element(doc, 'p'); inline(doc, p, paragraph.join('\n'), 0, book); target.append(p);
  }
}
export function renderMarkdown(doc, markdown = '', { book = false } = {}) {
  const root = element(doc, 'div'); root.className = 'concept-markdown';
  blocks(doc, root, String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n'), 0, book === true);
  return root;
}
