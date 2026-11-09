import fs from 'node:fs/promises';
import path from 'node:path';

// K3 contractual order. Prefixes are tried by length, not by this list's order.
export const separators = ['; ', '；', '。', '，', '. ', ', ', ' (SHA', '`', '"', '”', '’', '）', "'", ' | ', ' SHA256', ' SHA', ' is ', ' and ', ' may ', ' (3.', ' (use ', ' (JPG', ' — ', ' -- ', ' → ', ' are ', ' with '];
const stripTrailing = value => value.replace(/[ .;,:`"']+$/, '');
function* sourceCandidates(instructions, useQuotes = false) {
  if (typeof instructions !== 'string') return;
  for (const line of instructions.replaceAll('\\\\', '\\').split(/\r?\n/)) {
    for (const match of line.matchAll(/(?<![A-Za-z])[A-Za-z]:[\\/]/g)) {
      const close = useQuotes && ({ '`': '`', '"': '"', '“': '”' })[line[match.index - 1]];
      const end = close ? line.indexOf(close, match.index) : -1;
      yield end < 0 ? { candidate: stripTrailing(line.slice(match.index).trim()), quoted: false }
        : { candidate: line.slice(match.index, end), quoted: true };
    }
  }
}
const normalizePath = value => path.win32.normalize(value.replaceAll('/', '\\'));
async function exists(file) {
  try { const stat = await fs.stat(file); return stat.isFile() || stat.isDirectory(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}
export async function fileExists(file) {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

export async function extractBookFiles(instructions, { exists: present = fileExists, agentId, readingAgentsDir } = {}) {
  const files = [], seen = new Set();
  for (const { candidate } of sourceCandidates(instructions)) {
    // An extension must end the path, not a directory or an executable suffix.
    // Unlike the general source checker, keep spaces/punctuation in missing
    // book names: truncating at a prose separator can select the wrong book.
    const match = /^([A-Za-z]:[\\/][^\x00-\x1f<>:"|?*{}]*?\.(epub|pdf|mobi|azw3))(?=$|[\s;,"'‘’“”`)\]），。；]|\.(?:\s|$))/i.exec(candidate);
    if (!match) continue;
    const file = normalizePath(match[1]), key = file.toLowerCase();
    if (seen.has(key) || path.win32.dirname(file).split('\\').some(dir => /^(?:agent-support|.*-knowledge)$/i.test(dir))) continue;
    seen.add(key);
    const extension = path.win32.extname(file);
    // Converted copies under Reading\book-agents\<agent>-source stay openable (e.g. an epub for a mobi original)
    // but are labelled and listed after the originals.
    const derived = path.win32.dirname(file).split('\\').some(dir => /^.+-source$/i.test(dir));
    // Download sites append their domains in parentheses, e.g. "(example.org, example.net)": a parenthesis that holds
    // only domain names is not part of the title (v0.53: matched by shape, not by naming sites).
    const label = path.win32.basename(file, extension)
      .replace(/[（(]\s*[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}(?:\s*[,，]\s*[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6})*\s*[）)]/gi, '')
      .replace(/\s+/g, ' ').trim() + (derived ? '（阅读副本）' : '');
    files.push({ label, path: file, ext: extension.slice(1).toLowerCase(), exists: await present(file), derived });
  }
  // v0.45: Reading's .claude/agents directory is already configured; derive its root here for both registry paths.
  // Only one filename is discovered, and the agent id must stay a single directory component.
  if (readingAgentsDir && typeof agentId === 'string' && agentId.trim() &&
      !/[\\/<>:"|?*\x00-\x1f]/.test(agentId) && !agentId.includes('..')) {
    const file = normalizePath(path.join(readingAgentsDir, '..', '..', 'book-agents', `${agentId}-source`, 'reading-copy.epub'));
    if (!seen.has(file.toLowerCase()) && await present(file)) {
      files.push({ label: 'reading-copy（阅读副本）', path: file, ext: 'epub', exists: true, derived: true });
    }
  }
  // `derived` is only present when true, so the public shape of ordinary entries is unchanged.
  return [...files.filter(f => !f.derived), ...files.filter(f => f.derived)]
    .map(({ derived, ...f }, index) => ({ index, ...f, ...(derived ? { derived: true } : {}) }));
}

export async function checkSources(instructions, { exists: present = exists, pathKeys = new Set() } = {}) {
  if (typeof instructions !== 'string') return { checked: false, missing: [], total: 0, templatesExcluded: 0 };
  const paths = new Map(); let templatesExcluded = 0;
  for (const { candidate, quoted } of sourceCandidates(instructions, true)) {
    const cuts = quoted ? [] : [...new Set(separators.flatMap(separator => {
      const found = []; let at = candidate.indexOf(separator);
      while (at >= 0) { found.push(at); at = candidate.indexOf(separator, at + separator.length); }
      return found;
    }))].sort((a, b) => b - a);
    const last = path.win32.basename(cuts.length ? candidate.slice(0, cuts.at(-1)) : candidate);
    const stem = last.slice(0, last.length - path.win32.extname(last).length);
    // Keep the legacy image00NNN placeholder alongside delimiter-separated tokens.
    if (/[<>*?{]/.test(last) || /NNN$/.test(stem) || /(?:^|[-_ ])(?:N{1,4}|X{1,2}|n)$/.test(stem)) { templatesExcluded++; continue; }
    let value = candidate, available = await present(candidate);
    if (!available) for (const cut of cuts) {
      const prefix = stripTrailing(candidate.slice(0, cut).trimEnd());
      if (await present(prefix)) { value = prefix; available = true; break; }
    }
    // A missing path that ends in a file extension is reported whole; prose separators such as ". " inside
    // a book name ("Pat J. Author") must not truncate it (Claude acceptance 2026-10-21).
    // That named file is checked too: prose after it ("README.md supplies …") has no separator (Baiyo, Rumvo).
    const named = available ? null : /^.*?\.(?:epub|pdf|mobi|azw3|docx?|md|json|txt|png|jpe?g|html?)(?=$|[\s;,"'`)\]），。；])/i.exec(candidate);
    if (named) { value = named[0]; available = value !== candidate && await present(value); }
    else if (!available && cuts.length) value = stripTrailing(candidate.slice(0, cuts.at(-1)).trimEnd());
    const key = normalizePath(value).toLowerCase();
    pathKeys.add(key);
    if (!paths.has(key)) paths.set(key, { value, available });
    else if (available) paths.get(key).available = true;
  }
  return { checked: true, missing: [...paths.values()].filter(p => !p.available).map(p => p.value), total: paths.size, templatesExcluded };
}
