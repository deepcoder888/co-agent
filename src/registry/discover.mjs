import fs from 'node:fs/promises';
import path from 'node:path';
import { parseToml } from './toml-lite.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

export async function discover(config) {
  const sources = [], records = [], scannedAt = new Date().toISOString();
  const dirs = [{ kind: 'codex', dir: config.codexAgentsDir }, ...config.claudeAgentDirs.map(dir => ({ kind: 'claude', dir }))];
  for (const [index, { kind, dir }] of dirs.entries()) {
    const source = { id: `${kind}-${index}`, path: dir, kind, available: true, total: 0, parsed: 0, excluded: 0, failed: [], scannedAt };
    sources.push(source);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { source.available = false; source.reason = error.message; continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (kind === 'codex' && /\.bak|\.before-|\.orig/i.test(entry.name)) { source.excluded++; continue; }
      if (!entry.name.toLowerCase().endsWith(kind === 'codex' ? '.toml' : '.md')) continue;
      source.total++;
      const file = path.join(dir, entry.name);
      try {
        const content = await fs.readFile(file, 'utf8');
        const parsed = kind === 'codex' ? parseToml(content) : { values: parseFrontmatter(content), unsupported: [] };
        const values = parsed.values;
        if (typeof values.name !== 'string' || !values.name.trim()) throw new Error('缺少有效 name 字符串');
        if (values.description !== undefined && typeof values.description !== 'string') throw new Error('description 必须为字符串');
        records.push({ ...values, description: values.description || '', kind, file, sourceId: source.id, unsupported: parsed.unsupported });
        source.parsed++;
      } catch (error) { source.failed.push({ file, reason: error.message }); }
    }
  }
  return { scannedAt, sources, records };
}
