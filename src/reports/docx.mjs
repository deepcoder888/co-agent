// v0.21 (2026-10-15): read a Deepbooker Word report as Markdown for the shelf reading mode.
// Standard library only: the .docx ZIP is read through its central directory and inflated with zlib,
// and WordprocessingML is walked with a small tag parser. Only what the reports use is converted:
// title/subtitle, headings, paragraphs, bold/italic, hyperlinks, lists and tables. Word's own
// table of contents (TOC styles, TOC/PAGEREF field codes) is dropped; the reader builds its own outline.
import zlib from 'node:zlib';

const MAX_PART = 64 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };

export function unzipParts(buffer, wanted) {
  const parts = new Map();
  try {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) fail('不是有效的 Word 文件：缺少 ZIP 目录');
    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(at) !== 0x02014b50) fail('Word 文件目录已损坏');
      const method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
      const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
      const local = buffer.readUInt32LE(at + 42), name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (!wanted.includes(name)) continue;
      if (size > MAX_PART) fail(`Word 文件部件过大：${name}`);
      if (buffer.readUInt32LE(local) !== 0x04034b50) fail('Word 文件内容已损坏');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) parts.set(name, data.toString('utf8'));
      else if (method === 8) parts.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_PART }).toString('utf8'));
      else fail(`不支持的 Word 压缩方式：${method}`);
    }
  } catch (error) {
    if (error.status) throw error;
    fail(`Word 文件无法读取：${error.message}`);
  }
  return parts;
}

const entities = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (text, named) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => name[0] !== '#' ? entities[name] ?? named[name.toLowerCase()] ?? whole
  : String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))));
export function parseXml(xml, named = {}) {
  const root = { name: '#root', attrs: {}, children: [] }, stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
  let last = 0, match;
  const text = value => { if (value && stack.length > 1) stack.at(-1).children.push({ text: value }); };
  while ((match = tag.exec(xml))) {
    if (match.index > last) text(decode(xml.slice(last, match.index), named));
    last = tag.lastIndex;
    if (match[5] !== undefined) { text(match[5]); continue; }
    if (!match[2]) continue;
    if (match[1]) {
      const open = stack.findLastIndex(node => node.name === match[2]);
      if (open > 0) stack.length = open;
      continue;
    }
    const attrs = {};
    for (const [, key, , double, single] of match[3].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[key] = decode(double ?? single, named);
    const node = { name: match[2], attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!match[4]) stack.push(node);
  }
  return root;
}
const elements = (node, name) => (node?.children || []).filter(child => child.name === name);
const element = (node, name) => (node?.children || []).find(child => child.name === name);
const value = (node, name) => element(node, name)?.attrs['w:val'];
const on = node => !!node && !['0', 'false', 'off'].includes(node.attrs['w:val']);

// Markdown control characters in Word text stay literal (public/markdown.js honours backslash escapes).
const escapeText = text => text.replace(/[\\`*_[\]|~]/g, '\\$&');
const escapeLineStart = line => /^(#|>|[-+]\s|\d+[.)]\s|-{3,}|`{3})/.test(line) ? '\\' + line : line;

export function docxToMarkdown(buffer) {
  const parts = unzipParts(buffer, ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']);
  if (!parts.has('word/document.xml')) fail('Word 文件缺少正文 word/document.xml');
  const styles = new Map();
  for (const style of elements(element(parseXml(parts.get('word/styles.xml') || ''), 'w:styles'), 'w:style')) {
    styles.set(style.attrs['w:styleId'], String(value(style, 'w:name') || style.attrs['w:styleId'] || '').toLowerCase());
  }
  const links = new Map();
  for (const rel of elements(element(parseXml(parts.get('word/_rels/document.xml.rels') || ''), 'Relationships'), 'Relationship')) {
    if (/^https?:\/\//i.test(rel.attrs.Target || '')) links.set(rel.attrs.Id, rel.attrs.Target);
  }
  const numbering = element(parseXml(parts.get('word/numbering.xml') || ''), 'w:numbering');
  const abstract = new Map(elements(numbering, 'w:abstractNum').map(node => [node.attrs['w:abstractNumId'],
    new Map(elements(node, 'w:lvl').map(level => [level.attrs['w:ilvl'], value(level, 'w:numFmt') || 'decimal']))]));
  const formats = new Map(elements(numbering, 'w:num').map(node => [node.attrs['w:numId'], abstract.get(value(node, 'w:abstractNumId'))]));
  const body = element(element(parseXml(parts.get('word/document.xml')), 'w:document'), 'w:body');
  if (!body) fail('Word 文件缺少正文 w:body');

  const notices = new Set();
  function inline(paragraph, plain = false) {
    const segments = [];
    let field = null;
    const walk = (node, href) => {
      for (const child of node.children) {
        if (!child.name) continue;
        if (child.name === 'w:hyperlink') { walk(child, links.get(child.attrs['r:id']) || href); continue; }
        if (['w:ins', 'w:smartTag', 'w:customXml', 'w:fldSimple', 'w:sdt', 'w:sdtContent'].includes(child.name)) { walk(child, href); continue; }
        if (child.name !== 'w:r') continue;
        const props = element(child, 'w:rPr');
        if (on(element(props, 'w:vanish'))) continue;
        const bold = on(element(props, 'w:b')), italic = on(element(props, 'w:i'));
        for (const part of child.children) {
          if (part.name === 'w:fldChar') { const type = part.attrs['w:fldCharType']; field = type === 'begin' ? 'code' : type === 'separate' ? 'result' : null; continue; }
          if (field === 'code' || part.name === 'w:instrText') continue;
          let text = '';
          if (part.name === 'w:t') text = part.children.map(node => node.text || '').join('');
          else if (['w:tab', 'w:br', 'w:cr'].includes(part.name)) text = ' ';
          else if (part.name === 'w:noBreakHyphen') text = '-';
          else if (['w:drawing', 'w:pict', 'w:object'].includes(part.name)) { notices.add('图片或嵌入对象未显示'); text = '［图片未显示］'; }
          if (text) segments.push({ text, bold, italic, href });
        }
      }
    };
    walk(paragraph);
    if (plain) return escapeText(segments.map(s => s.text).join('').replace(/\s+/g, ' ').trim());
    const merged = [];
    for (const segment of segments) {
      const previous = merged.at(-1);
      if (previous && previous.bold === segment.bold && previous.italic === segment.italic && previous.href === segment.href) previous.text += segment.text;
      else merged.push({ ...segment });
    }
    return merged.map(({ text, bold, italic, href }) => {
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text.replace(/\s+/g, ' '));
      if (!core) return lead + trail;
      let out = escapeText(core);
      if (italic) out = `*${out}*`;
      if (bold) out = `**${out}**`;
      if (href) out = `[${out}](${href})`;
      return lead + out + trail;
    }).join('').trim();
  }
  const cellText = cell => elements(cell, 'w:p').map(p => inline(p)).concat(elements(cell, 'w:tbl').map(t => tableRows(t).flat().join(' ')))
    .filter(Boolean).join(' ');
  function tableRows(table) {
    return elements(table, 'w:tr').map(row => elements(row, 'w:tc').flatMap(cell => {
      const props = element(cell, 'w:tcPr'), span = Number(value(props, 'w:gridSpan')) || 1, merge = element(props, 'w:vMerge');
      const text = merge && merge.attrs['w:val'] !== 'restart' ? '' : cellText(cell);
      return [text, ...Array(span - 1).fill('')];
    }));
  }

  let title = '', subtitle = '';
  const blocks = [], counters = new Map();
  const add = (text, list = false) => blocks.push({ text, list });
  const visit = node => {
    for (const child of node.children) {
      if (child.name === 'w:sdt' || child.name === 'w:sdtContent' || child.name === 'w:customXml') { visit(child); continue; }
      if (child.name === 'w:tbl') {
        const rows = tableRows(child).filter(row => row.some(Boolean));
        if (!rows.length) continue;
        const width = Math.max(...rows.map(row => row.length));
        const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || ' ').join(' | ') + ' |';
        add([line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n'));
        continue;
      }
      if (child.name !== 'w:p') continue;
      const props = element(child, 'w:pPr'), style = styles.get(value(props, 'w:pStyle')) || String(value(props, 'w:pStyle') || '').toLowerCase();
      if (/^toc\s?\d|^toc heading$|^tocheading$/.test(style)) continue;
      const text = inline(child);
      if (!text) continue;
      if (style === 'title') { if (!title) title = inline(child, true).replace(/\\(.)/g, '$1'); else add('# ' + inline(child, true)); continue; }
      if (style === 'subtitle') { if (!subtitle) subtitle = inline(child, true).replace(/\\(.)/g, '$1'); else add(escapeLineStart(text)); continue; }
      const heading = /^heading\s?([1-9])$/.exec(style);
      if (heading) { add('#'.repeat(Math.min(6, Number(heading[1]) + 1)) + ' ' + inline(child, true)); continue; }
      const list = element(props, 'w:numPr');
      if (list) {
        const id = value(list, 'w:numId'), level = value(list, 'w:ilvl') || '0', format = formats.get(id)?.get(level) || 'decimal';
        if (id !== '0') {
          if (format === 'bullet' || format === 'none') { add('- ' + text, 'ul'); continue; }
          const key = id + ':' + level, next = (counters.get(key) || 0) + 1; counters.set(key, next);
          add(`${next}. ${text}`, 'ol'); continue;
        }
      }
      add(escapeLineStart(text));
    }
  };
  visit(body);
  const markdown = blocks.map((block, i) => (i && !(block.list && block.list === blocks[i - 1].list) ? '\n\n' : i ? '\n' : '') + block.text).join('');
  return { title, subtitle, markdown, notices: [...notices] };
}
