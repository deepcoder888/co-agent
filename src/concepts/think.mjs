import fs from 'node:fs/promises';
import path from 'node:path';

export function thinkMarkdown(record) {
  const { markdown, response } = record.result;
  const target = record.respondsTo;
  return response && target ? `${markdown}\n\n## 回应前一篇概念：${target.concept}（${target.agent.bookLabel || target.agent.name}）\n立场：${response.stance}\n${response.text}\n` : markdown;
}

// concept-ai-era Final Persistence Step 2–11, in its specified order.
export function conceptBasename(label, now = new Date()) {
  let base = String(label).replace(/^[ .]+|[ .]+$/g, '')
    .replace(/[<>:"/\\|?*\p{Cc}\s]+/gu, '-').replace(/^[- .]+|[- .]+$/g, '');
  base = Array.from(base).slice(0, 80).join('');
  if (!base) {
    const pad = n => String(n).padStart(2, '0');
    base = `concept-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
  // Windows also reserves device names with extensions (e.g. CON.notes).
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `concept-${base}`;
  return base;
}

export async function saveThink(label, markdown, dir, { now = new Date(), io = fs, extension = '.txt' } = {}) {
  if (!['.txt','.md'].includes(extension)) throw new Error('THINK 扩展名无效');
  // The THINK exception authorizes this directory, not a junction into a source tree.
  for (let ancestor = path.resolve(dir); ; ancestor = path.dirname(ancestor)) {
    try { if ((await io.lstat(ancestor)).isSymbolicLink()) throw new Error(`THINK 目录包含链接：${ancestor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  try { await io.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const base = conceptBasename(label, now);
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}${extension}`);
    try { await io.writeFile(file, markdown, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const bytes = await io.readFile(file);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
        !bytes.equals(Buffer.from(markdown, 'utf8')) || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== markdown) {
      throw new Error(`THINK 文件回读不一致或含 BOM：${file}`);
    }
    return file;
  }
}
