// v0.21 (2026-10-15): book agents' Deepbooker Word reports, read-only from the Reading word folder.
// <catalogDir>/book-reports.json (v0.51) maps each agent to report filename prefixes; the newest
// matching .docx wins, so a regenerated report is picked up without editing the mapping.
import fs from 'node:fs/promises';
import path from 'node:path';
import { docxToMarkdown } from './docx.mjs';
import { cleanTitle } from '../../public/display.js';

const MAX_FILE = 50 * 1024 * 1024;
const working = /^[.~]|draft|\.tmp|staging|attempt|probe|smoke|preflight|superseded/i;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Coverage lists show plain titles: registry titles carry 《》 and Markdown emphasis (Claude acceptance 2026-10-21).
const displayTitle = (title = '') => { const { text, multi } = cleanTitle(title); return multi > 1 ? title.replace(/[*_]/g, '') : text || ''; };
export const reportKey =value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

export function createReports({ mappingFile, directory, io = fs } = {}) {
  // v0.51: directory is null when no report folder is configured; nothing is then scanned (never the working folder).
  let mapping = { directory: null, agents: {} }, files = [];
  const cache = new Map();
  async function scan() {
    if (!mapping.directory) { files = []; return files; }
    try {
      const entries = await io.readdir(mapping.directory, { withFileTypes: true });
      const found = await Promise.all(entries.filter(entry => entry.isFile() && /\.docx$/i.test(entry.name) && !working.test(entry.name)).map(async entry => {
        const stat = await io.stat(path.join(mapping.directory, entry.name));
        return { name: entry.name, key: reportKey(entry.name.replace(/\.docx$/i, '')), mtimeMs: stat.mtimeMs, size: stat.size };
      }));
      files = found;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files = [];
    }
    return files;
  }
  const matches = (file, entry) => {
    const prefix = reportKey(entry.prefix), excluded = (entry.exclude || []).map(reportKey);
    return file.key.startsWith(prefix) && !excluded.some(key => file.key.startsWith(key));
  };
  const newest = entry => files.filter(file => matches(file, entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0] || null;
  const entriesFor = (agentId, agent) => {
    if (Object.hasOwn(mapping.agents, agentId)) return mapping.agents[agentId];
    if (!agent?.book?.title) return [];
    const { text, multi } = cleanTitle(agent.book.title), prefix = reportKey(text);
    if (multi !== 1 || /^[*_\s]*多书[，,]\s*\d+\s*部[：:]/.test(agent.book.title) || Array.from(prefix).length < 4) return [];
    const full = { label: text, prefix, auto: true };
    const main = reportKey(text.split(/:|：| - | — /)[0]);
    // Keep one report slot; prefer the full title even when a shorter match is newer.
    if (newest(full) || main === prefix || Array.from(main).length < 4) return [full];
    return [{ ...full, prefix: main }];
  };
  return {
    async load() {
      let json = {};
      try { if (mappingFile) json = JSON.parse(await io.readFile(mappingFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const folder = directory || json.directory;
      mapping = { directory: folder ? path.resolve(folder) : null, agents: json.agents || {} };
      await scan();
    },
    describe(agentId, agent) {
      return entriesFor(agentId, agent).map((entry, index) => {
        const file = newest(entry);
        return { index, label: entry.label, available: !!file, file: file?.name ?? null, updatedAt: file ? new Date(file.mtimeMs).toISOString() : null,
          ...(entry.auto ? { auto: true } : {}) };
      });
    },
    coverage(agents) {
      const books = agents.filter(agent => agent.kind === 'book');
      const entries = [...Object.values(mapping.agents).flat(), ...books.flatMap(agent => entriesFor(agent.id, agent))];
      return {
        booksWithout: books.filter(agent => !entriesFor(agent.id, agent).some(newest))
          .map(agent => ({ id: agent.id, name: agent.name, title: displayTitle(agent.book?.title) })),
        unusedFiles: files.filter(file => !entries.some(entry => matches(file, entry))).map(file => file.name).sort((a, b) => a.localeCompare(b)),
        directory: mapping.directory,
      };
    },
    async read(agentId, index, agent) {
      await scan();
      const entry = entriesFor(agentId, agent)[index];
      if (!entry) fail(404, '未登记该 Word 报告');
      const file = newest(entry);
      if (!file) fail(404, '暂无 Word 报告');
      if (file.size > MAX_FILE) fail(413, 'Word 报告超过 50 MB，无法在阅读模式中打开');
      const full = path.join(mapping.directory, file.name), stamp = `${full}|${file.mtimeMs}|${file.size}`;
      let converted = cache.get(full);
      if (converted?.stamp !== stamp) {
        converted = { stamp, value: docxToMarkdown(await io.readFile(full)) };
        cache.set(full, converted);
      }
      return { agentId, index, label: entry.label, file: file.name, updatedAt: new Date(file.mtimeMs).toISOString(), ...converted.value };
    },
  };
}
