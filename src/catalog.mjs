// v0.51 Agent 目录清单: the five lists that say which agents are tools or books, how books are grouped and described,
// where their Word reports are, and which agents need the task format. They live in config.catalogDir (default
// <dataDir>/catalog), not in the code. A missing file is an empty list, so a new install starts with nothing listed.
import fs from 'node:fs/promises';
import path from 'node:path';

export const CATALOG_FILES = {
  roles: 'roles.json', books: 'book-categories.json', blurbs: 'book-blurbs.json', reports: 'book-reports.json', taskContracts: 'task-contracts.json',
};
const EMPTY = {
  roles: { version: 1, roles: [], reviewers: [], purposes: {} },
  books: { version: 1, categories: [], books: [] },
  blurbs: { blurbs: {} },
  reports: { directory: null, agents: {} },
  taskContracts: { version: 1, octopus: [] },
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const names = value => Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim());
// Only the shape every reader relies on; a wrong shape is reported by file name instead of failing somewhere later.
const valid = {
  roles: value => names(value.roles) && (value.reviewers === undefined || names(value.reviewers)) && (value.purposes === undefined || object(value.purposes)),
  // v0.53: shelfOrder (the 书架 room's default order) and featured (编辑版's example joint call) are optional.
  books: value => names(value.categories) && Array.isArray(value.books) && value.books.every(book => object(book) && typeof book.agent === 'string' && book.agent.trim())
    && (value.shelfOrder === undefined || names(value.shelfOrder))
    && (value.featured === undefined || (object(value.featured) && names(value.featured.members) && typeof value.featured.text === 'string'
      && (value.featured.title === undefined || names(value.featured.title)))),
  blurbs: value => value.blurbs === undefined || object(value.blurbs),
  reports: value => (value.directory == null || typeof value.directory === 'string') && (value.agents === undefined || object(value.agents)),
  taskContracts: value => value.version === 1 && names(value.octopus),
};

export const catalogFile = (config, key) => path.join(config.catalogDir, CATALOG_FILES[key]);

export async function readCatalogFile(config, key, io = fs) {
  const file = catalogFile(config, key);
  let text;
  try { text = await io.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(EMPTY[key]); throw new Error(`Agent 目录清单 ${CATALOG_FILES[key]} 无法读取：${error.message}`); }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Agent 目录清单 ${CATALOG_FILES[key]} 不是有效的 JSON：${error.message}`); }
  if (!object(value) || !valid[key](value)) throw new Error(`Agent 目录清单 ${CATALOG_FILES[key]} 格式错误：${file}`);
  return value;
}
