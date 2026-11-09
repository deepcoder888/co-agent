// A deliberately limited top-level TOML reader; tables belong to the CLI, not the registry.
export function parseToml(input) {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const values = {}, unsupported = [], seen = new Set();
  let i = 0;
  const line = at => text.slice(0, at).split('\n').length;
  const fail = (message, at = i) => { throw new Error(`行 ${line(at)}：${message}`); };
  const horizontal = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const endLine = () => {
    horizontal();
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
    if (i < text.length && text[i] !== '\n') fail('值后有多余内容');
    if (text[i] === '\n') i++;
  };
  function string() {
    const start = i, quote = text[i], multi = text.startsWith(quote.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && text[i] === '\n') i++;
    let result = '';
    while (i < text.length) {
      if (text[i] === quote) {
        if (!multi) { i++; return result; }
        let n = 0;
        while (text[i + n] === quote) n++;
        if (n >= 3) {
          if (n > 5) fail('多行字符串结束引号过多');
          result += quote.repeat(n - 3); i += n; return result;
        }
      }
      const c = text[i++];
      if (!multi && c === '\n') fail('单行字符串不能换行', start);
      if ((c.charCodeAt(0) < 32 && c !== '\t' && c !== '\n') || c.charCodeAt(0) === 127) fail('字符串包含控制字符', i - 1);
      if (quote === '"' && c === '\\') {
        const escapeStart = i - 1;
        if (multi && /^[ \t]*\n/.test(text.slice(i))) {
          while (/[ \t\n]/.test(text[i] || '\0')) i++;
          continue;
        }
        const e = text[i++];
        const escapes = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (Object.hasOwn(escapes, e)) result += escapes[e];
        else if (e === 'u' || e === 'U') {
          const digits = e === 'u' ? 4 : 8, hex = text.slice(i, i + digits);
          if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) fail('Unicode 转义无效', escapeStart);
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('Unicode 码点无效', escapeStart);
          result += String.fromCodePoint(cp); i += digits;
        } else fail('不支持的字符串转义', escapeStart);
      } else result += c;
    }
    fail('字符串未结束', start);
  }
  function compound() {
    const start = i, stack = [];
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") { string(); continue; }
      if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '[') stack.push(']');
      if (c === '{') stack.push('}');
      if (c === ']' || c === '}') {
        if (stack.pop() !== c) fail('复合值括号不匹配');
        i++;
        if (stack.length === 0) return;
        continue;
      }
      i++;
    }
    fail('复合值未结束', start);
  }
  function integer(scalar, at) {
    const value = BigInt(scalar.replaceAll('_', ''));
    if (value < -9223372036854775808n || value > 9223372036854775807n) fail('整数超出 TOML 64 位范围', at);
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  while (i < text.length) {
    horizontal();
    if (text[i] === '\n' || text[i] === '#') { endLine(); continue; }
    if (i >= text.length) break;
    if (text[i] === '[') break;
    const keyStart = i;
    let key;
    if (text[i] === '"' || text[i] === "'") key = string();
    else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!match) fail('键无效');
      key = match[0]; i += key.length;
    }
    horizontal();
    if (text[i++] !== '=') fail('缺少等号', keyStart);
    if (seen.has(key)) fail(`重复键 ${key}`, keyStart);
    seen.add(key); horizontal();
    if (text[i] === '"' || text[i] === "'") values[key] = string();
    else if (text[i] === '[' || text[i] === '{') { compound(); unsupported.push(key); }
    else {
      const start = i;
      while (i < text.length && text[i] !== '\n' && text[i] !== '#') i++;
      const scalar = text.slice(start, i).trim();
      if (/^(true|false)$/.test(scalar)) values[key] = scalar === 'true';
      else if (/^[+-]?(0|[1-9](?:_?\d)*)$/.test(scalar)) {
        values[key] = integer(scalar, start);
      } else if (/^(?:0x[0-9a-fA-F](?:_?[0-9a-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/.test(scalar)) {
        values[key] = integer(scalar, start);
      } else if (/^[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)$/.test(scalar) ||
        /^[+-]?\d(?:_?\d)*\.\d(?:_?\d)*$/.test(scalar) || /^[+-]?(inf|nan)$/.test(scalar) ||
        /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(scalar) ||
        /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(scalar)) unsupported.push(key);
      else fail('值语法无效', start);
    }
    endLine();
  }
  return { values, unsupported };
}
