import fs from 'node:fs/promises';
import path from 'node:path';
import { readCatalogFile } from '../catalog.mjs';
import { discover } from './discover.mjs';
import { normalize, mergeIdentity } from './identity.mjs';
import { checkSources, extractBookFiles, fileExists } from './sources.mjs';
import { compareVersions } from './sync.mjs';
import { readAdditions, readIgnored, mergeBooks, discoverCandidates, validBlurb } from './candidates.mjs';
import { readListAdditions, mergeRoles, mergeCategories } from './lists.mjs';

export function classify(records, roleMap, bookMap, diskIds = records.map(r => r.id)) {
  const roles = new Map(roleMap.roles.map(name => [normalize(name), roleMap.purposes?.[name] ?? null]));
  const reviewers = new Set((roleMap.reviewers || []).map(normalize)), appRoles = new Set(roleMap.appRoles || []);
  const books = new Map(bookMap.books.map(book => [normalize(book.agent), book]));
  const agents = [], outOfScope = [];
  for (const record of records) {
    const agent = { ...record, tags: [], book: null, primary: null, purpose: null };
    if (roles.has(agent.id)) Object.assign(agent, { kind: 'role', primary: '功能性 Agent', purpose: roles.get(agent.id), listSource: appRoles.has(agent.id) ? 'app' : 'catalog', ...(reviewers.has(agent.id) ? { reviewer: true } : {}) });
    else if (books.has(agent.id)) {
      const { primary, tags, title, author, edition, blurb, listSource = 'catalog' } = books.get(agent.id);
      const description = validBlurb(blurb);
      Object.assign(agent, { kind: 'book', primary, tags, listSource, book: { title, author, edition, ...(description ? { blurb: description } : {}) } });
    } else Object.assign(agent, { kind: 'out-of-scope', reason: '尚未入库，或不在角色与书目范围内' });
    (agent.kind === 'out-of-scope' ? outOfScope : agents).push(agent);
  }
  const present = new Set(diskIds);
  const missingFromDisk = [...roleMap.roles.map(name => ({ name, kind: 'role' })), ...bookMap.books.map(b => ({ name: b.agent, kind: 'book' }))]
    .filter(r => !present.has(normalize(r.name)));
  const summary = { inScope: agents.length, roles: agents.filter(a => a.kind === 'role').length,
    books: agents.filter(a => a.kind === 'book').length, uncategorized: agents.filter(a => a.primary === '未分类').length,
    outOfScope: outOfScope.length, excludedBackups: 0, failed: 0 };
  return { agents, outOfScope, categories: bookMap.categories, missingFromDisk, summary };
}

export async function buildRegistry(config, { io = fs, exists = fileExists } = {}) {
  const [scan, catalogRoles, bundled, additions, ignored, lists] = await Promise.all([
    // v0.51: the role and book lists come from catalogDir, not from the code; v0.52 adds what was listed in the app.
    discover(config), readCatalogFile(config, 'roles', io), readCatalogFile(config, 'books', io),
    readAdditions(config, io), readIgnored(config, io), readListAdditions(config, io),
  ]);
  const roleMap = mergeRoles(catalogRoles, lists);
  const bookMap = { ...mergeBooks(bundled, additions), categories: mergeCategories(bundled.categories, lists.categories) };
  const merged = mergeIdentity(scan.records);
  const classified = classify(merged.agents, roleMap, bookMap, scan.records.filter(r => r.kind === 'codex').map(r => normalize(r.name)));
  // v0.53: how the layouts show the books comes from the catalog too, so no book is named in the page code.
  classified.display = {
    shelfOrder: (bundled.shelfOrder || []).map(normalize),
    featured: bundled.featured ? { members: bundled.featured.members.map(name => ({ id: normalize(name), label: name })), text: bundled.featured.text,
      title: bundled.featured.title || [] } : null,
  };
  // v0.42 书本检视: the two-sentence description shown beside a pulled-out book (<catalogDir>/book-blurbs.json since v0.51).
  const blurbs = (await readCatalogFile(config, 'blurbs', io)).blurbs || {};
  const blurbOf = new Map(Object.entries(blurbs).map(([name, text]) => [normalize(name), text]));
  for (const agent of classified.agents) if (agent.book && typeof blurbOf.get(agent.id) === 'string') agent.book.blurb = blurbOf.get(agent.id);
  classified.candidates = await discoverCandidates(merged.agents, scan.records, roleMap, bookMap, ignored, config, { io, exists });
  classified.summary.candidates = classified.candidates.length;
  for (const agent of classified.agents) {
    const codex = scan.records.find(r => r.file === agent.sourceFile);
    const claude = agent.platforms.claude.available ? scan.records.find(r => r.file === agent.platforms.claude.file) : undefined;
    agent.sync = compareVersions(codex, claude);
    if (agent.kind === 'book') {
      // Sources may be directories (each book's -knowledge package); the injected check is file-only.
      const pathKeys = new Set();
      const codexSources = await checkSources(codex?.developer_instructions, { pathKeys });
      const claudeSources = await checkSources(claude?.body, { pathKeys });
      const key = value => path.win32.normalize(value).toLowerCase();
      const codexMissing = new Set(codexSources.missing.map(key)), claudeMissing = new Set(claudeSources.missing.map(key));
      agent.sources = {
        checked: codexSources.checked || claudeSources.checked, total: pathKeys.size,
        templatesExcluded: codexSources.templatesExcluded + claudeSources.templatesExcluded,
        missing: [
          ...codexSources.missing.map(p => claudeMissing.has(key(p)) ? p : `${p}（仅 Codex 版本）`),
          ...claudeSources.missing.filter(p => !codexMissing.has(key(p))).map(p => `${p}（仅 Claude 版本）`),
        ],
        missingByVersion: { codex: codexSources.missing, claude: claudeSources.missing },
      };
      agent.bookFiles = await extractBookFiles(codex?.developer_instructions, { exists, agentId: agent.id, readingAgentsDir: config.readingAgentsDir });
    } else if (agent.kind === 'role') {
      // Discovery/identity already resolved the actual TOML (including casing).
      agent.definitionFile = { path: agent.sourceFile, exists: await fileExists(agent.sourceFile) };
    }
  }
  classified.summary.synced = classified.agents.filter(a => a.sync.state === '同步').length;
  classified.summary.excludedBackups = scan.sources.reduce((n, s) => n + s.excluded, 0);
  classified.summary.failed = scan.sources.reduce((n, s) => n + s.failed.length, 0);
  return { scannedAt: scan.scannedAt, sources: scan.sources, ...classified, conflicts: merged.conflicts };
}
