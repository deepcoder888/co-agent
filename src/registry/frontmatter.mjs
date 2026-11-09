export function parseFrontmatter(input) {
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('缺少开头 frontmatter');
  const end = lines.findIndex((s, index) => index > 0 && s === '---');
  if (end < 0) throw new Error('frontmatter 未结束');
  const names = lines.slice(1, end).filter(s => /^name\s*:/.test(s));
  if (names.length !== 1) throw new Error('frontmatter 需要唯一 name');
  let name = names[0].replace(/^name\s*:\s*/, '').trim();
  if (name.startsWith('"')) {
    try { name = JSON.parse(name); } catch { throw new Error('frontmatter name 引号无效'); }
  } else if (name.startsWith("'")) {
    if (!name.endsWith("'")) throw new Error('frontmatter name 引号无效');
    name = name.slice(1, -1).replaceAll("''", "'");
  } else name = name.replace(/\s+#.*$/, '').trim();
  if (typeof name !== 'string' || !name.trim()) throw new Error('frontmatter name 为空');
  const values = { name };
  const scalar = raw => {
    raw = raw.trim();
    if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { throw new Error('frontmatter 引号无效'); } }
    if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) throw new Error('frontmatter 引号无效');
      return raw.slice(1, -1).replaceAll("''", "'");
    }
    return raw.replace(/\s+#.*$/, '').trim();
  };
  const descriptions = lines.slice(1, end).map((s, i) => ({ s, i: i + 1 })).filter(({ s }) => /^description\s*:/.test(s));
  if (descriptions.length > 1) throw new Error('frontmatter 重复字段 description');
  if (descriptions.length) {
    const { s, i } = descriptions[0], raw = s.replace(/^description\s*:\s*/, '');
    if (/^[|>][-+]?$/.test(raw)) {
      const block = [];
      for (let j = i + 1; j < end && (!lines[j].trim() || /^\s+/.test(lines[j])); j++) block.push(lines[j]);
      const indent = Math.min(...block.filter(s => s.trim()).map(s => s.match(/^\s*/)[0].length));
      const text = block.map(s => s.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
      // Fold adjacent text lines, retaining blank paragraphs and indented content.
      const folded = raw.startsWith('>') ? text.replace(/(?<=\S)\n(?=\S)/g, ' ') : text;
      values.description = raw.endsWith('-') ? folded.replace(/\n+$/, '') : folded.replace(/\n*$/, '\n');
    } else values.description = scalar(raw);
  }
  values.body = lines.slice(end + 1).join('\n');
  for (const key of ['model', 'effort', 'tools']) {
    const found = lines.slice(1, end).map((s, i) => ({ s, i: i + 1 })).filter(({ s }) => s.startsWith(`${key}:`));
    if (found.length > 1) throw new Error(`frontmatter 重复字段 ${key}`);
    if (!found.length) continue;
    const { s, i } = found[0]; const raw = s.slice(key.length + 1).trim();
    if (key !== 'tools') { values[key] = scalar(raw) || undefined; continue; }
    let tools;
    if (!raw) {
      tools = [];
      for (let j = i + 1; j < end && /^\s+/.test(lines[j]); j++) {
        if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
        const match = /^\s+-\s+(.+)$/.exec(lines[j]);
        if (!match) throw new Error('frontmatter tools 列表无效');
        tools.push(scalar(match[1]));
      }
    } else if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) throw new Error('frontmatter tools 列表未结束');
      tools = raw.slice(1, -1).trim() ? raw.slice(1, -1).split(',').map(scalar) : [];
    } else {
      if (/^[{|>]/.test(raw)) throw new Error('frontmatter tools 写法不支持');
      tools = scalar(raw).split(',').map(s => s.trim());
    }
    if (tools.some(s => typeof s !== 'string' || !s || /[\[\]{}]/.test(s))) throw new Error('frontmatter tools 项无效');
    values.tools = tools;
  }
  return values;
}
