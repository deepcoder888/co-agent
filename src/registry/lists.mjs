// v0.52 Agent 管理 (2026-11-08): register agents already on this computer as tools or books, manage book
// categories, and import agent files. Changes made in the app go to the data dir (the user chose this over writing
// the catalog folder): tools and categories to catalog-additions.json, books to book-additions.json. Entries from
// the catalog folder are read-only here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalize } from './identity.mjs';
import { parseToml } from './toml-lite.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { readAdditions, saveJSON, safeName, validateItems } from './candidates.mjs';
import { readCatalogFile } from '../catalog.mjs';
import { describeBookMaker } from '../bookmaker.mjs';

const FILE = 'catalog-additions.json', MAX_FILE = 256 * 1024;
const RESERVED = new Set(['功能性 Agent', '未分类']);
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' ? value.trim() : '';
const length = value => Array.from(value).length;
const summary = value => Array.from(String(value || '').replace(/<example\b[^>]*>[\s\S]*?<\/example\s*>/gi, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160).join('');

export async function readListAdditions(config, io = fs) {
  let raw;
  try { raw = await io.readFile(path.join(config.dataDir, FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, roles: [], categories: [] }; throw problem(`${FILE} 读取失败：${error.message}`, 409); }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw problem(`${FILE} 不是有效的 JSON：${error.message}`, 409); }
  if (value?.version !== 1 || !Array.isArray(value.roles) || !Array.isArray(value.categories) ||
      value.roles.some(role => !role || typeof role.agent !== 'string' || !role.agent.trim() || typeof role.purpose !== 'string') ||
      value.categories.some(name => typeof name !== 'string' || !name.trim())) throw problem(`${FILE} 格式无效`, 409);
  return value;
}

// Catalog roles first; a role listed in both places stays a catalog role.
export function mergeRoles(catalog, additions) {
  const listed = new Set(catalog.roles.map(normalize));
  const added = additions.roles.filter(role => !listed.has(normalize(role.agent)));
  return { ...catalog, roles: [...catalog.roles, ...added.map(role => role.agent)],
    purposes: { ...catalog.purposes, ...Object.fromEntries(added.map(role => [role.agent, role.purpose])) },
    appRoles: added.map(role => normalize(role.agent)) };
}
export const mergeCategories = (catalog, additions) => [...new Set([...catalog, ...additions])];

export function createAgentLists(config, getRegistry, { io = fs, onChanged = async () => {} } = {}) {
  let work = Promise.resolve();
  const serial = task => { const next = work.then(task); work = next.catch(() => {}); return next; };
  const unlisted = id => {
    const agent = (getRegistry().outOfScope || []).find(a => a.id === id);
    if (!agent) throw problem('这个 Agent 不在「未登记」里，请刷新目录', 409);
    return agent;
  };
  async function describe() {
    const r = getRegistry(), catalog = new Set((await readCatalogFile(config, 'books', io)).categories);
    const books = (r.agents || []).filter(a => a.kind === 'book'), roles = (r.agents || []).filter(a => a.kind === 'role');
    return {
      allowImport: config.allowAgentImport !== false, bookMaker: describeBookMaker(r),
      categories: (r.categories || []).map(name => ({ name, source: catalog.has(name) ? 'catalog' : 'app', books: books.filter(a => a.primary === name).length })),
      roles: roles.map(a => ({ id: a.id, name: a.name, purpose: a.purpose ?? null, source: a.listSource || 'catalog' })),
      books: books.map(a => ({ id: a.id, name: a.name, title: a.book?.title || '', primary: a.primary, source: a.listSource || 'catalog' })),
      unlisted: (r.outOfScope || []).map(a => ({ id: a.id, name: a.name, description: summary(a.description),
        platforms: ['codex', 'claude'].filter(p => a.platforms?.[p]?.available) })),
    };
  }
  async function apply(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('请求体无效');
    const r = getRegistry(), additions = await readListAdditions(config, io), save = () => saveJSON(config, FILE, additions, io);
    switch (body.op) {
      case 'addCategory': {
        const name = text(body.name);
        if (!name || length(name) > 20) throw problem('分类名必须为 1–20 字');
        if (RESERVED.has(name)) throw problem(`「${name}」是保留名称，不能用作分类`);
        if ((r.categories || []).includes(name)) throw problem(`已有分类「${name}」`, 409);
        additions.categories.push(name); await save(); return `已添加分类「${name}」`;
      }
      case 'removeCategory': {
        const name = text(body.name);
        if (!additions.categories.includes(name) || (await readCatalogFile(config, 'books', io)).categories.includes(name)) throw problem('只能删除在软件里添加的分类', 409);
        const books = await readAdditions(config, io);
        if ((r.agents || []).some(a => a.kind === 'book' && a.primary === name) || books.books.some(b => b.primary === name)) throw problem(`还有书在用分类「${name}」，先把它们改到别的分类`, 409);
        additions.categories = additions.categories.filter(c => c !== name); await save(); return `已删除分类「${name}」`;
      }
      case 'addRole': {
        const agent = unlisted(body.id), purpose = text(body.purpose);
        if (!purpose || length(purpose) > 40) throw problem('用途必须为 1–40 字');
        additions.roles.push({ agent: agent.name, purpose }); await save(); return `已把 ${agent.name} 设为工具 Agent`;
      }
      case 'removeRole': {
        const index = additions.roles.findIndex(role => normalize(role.agent) === body.id);
        if (index < 0 || (r.agents || []).some(a => a.id === body.id && a.kind === 'role' && a.listSource !== 'app')) throw problem('只能移出在软件里登记的工具 Agent', 409);
        const [role] = additions.roles.splice(index, 1); await save(); return `已移出 ${role.agent}`;
      }
      case 'addBook': {
        const agent = unlisted(body.id);
        const [item] = validateItems([{ id: agent.id, title: body.title, author: body.author, edition: body.edition, primary: body.primary }],
          [{ id: agent.id, name: agent.name }], r.categories || []);
        const books = await readAdditions(config, io);
        books.books.push({ agent: agent.name, title: item.title, author: item.author, edition: item.edition, primary: item.primary, tags: [] });
        await saveJSON(config, 'book-additions.json', books, io); return `已把 ${agent.name} 设为书籍 Agent`;
      }
      case 'removeBook': {
        const books = await readAdditions(config, io), index = books.books.findIndex(book => normalize(book.agent) === body.id);
        if (index < 0) throw problem('只能移出在软件里登记的书籍 Agent', 409);
        const [book] = books.books.splice(index, 1);
        await saveJSON(config, 'book-additions.json', books, io); return `已移出 ${book.agent}`;
      }
      default: throw problem('op 无效');
    }
  }
  return {
    describe,
    change(body) { return serial(async () => { const message = await apply(body); await onChanged(); return { message, ...await describe() }; }); },
    // Only new files: an existing file or an agent of the same name on that platform is never replaced.
    importFile(body) { return serial(async () => {
      if (config.allowAgentImport === false) throw problem('这台电脑关闭了导入 Agent 文件（设置 → 基本配置）', 403);
      const fileName = typeof body?.fileName === 'string' ? body.fileName : '', content = body?.content;
      const extension = path.extname(fileName).toLowerCase();
      if (!['.toml', '.md'].includes(extension)) throw problem('只能导入 .toml（Codex）或 .md（Claude）Agent 文件');
      if (typeof content !== 'string' || !content.trim()) throw problem('文件是空的');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw problem('Agent 文件超过 256 KB');
      if (content.includes('\0')) throw problem('Agent 文件含有 NUL 字符');
      let values;
      try { values = extension === '.toml' ? parseToml(content).values : parseFrontmatter(content); }
      catch (error) { throw problem(`文件解析失败：${error.message}`); }
      if (typeof values?.name !== 'string' || !values.name.trim()) throw problem('文件里缺少 name');
      if (values.description !== undefined && typeof values.description !== 'string') throw problem('description 必须为字符串');
      const name = safeName(values.name), kind = extension === '.toml' ? 'codex' : 'claude';
      const r = getRegistry(), id = normalize(name);
      if ([...(r.agents || []), ...(r.outOfScope || [])].some(a => a.id === id && a.platforms?.[kind]?.available)) throw problem(`已有同名 Agent「${name}」，没有覆盖`, 409);
      const dir = kind === 'codex' ? config.codexAgentsDir : config.claudeAgentDirs[0];
      const file = path.join(dir, `${name}${extension}`);
      await io.mkdir(dir, { recursive: true });
      try { await io.writeFile(file, content, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw problem('已有同名 Agent 文件，没有覆盖', 409); throw error; }
      await onChanged();
      // The registry is built from Codex definitions; a Claude file joins the one with the same name.
      const listed = [...(getRegistry().agents || []), ...(getRegistry().outOfScope || [])].some(a => a.id === id);
      return { name, kind, file, listed };
    }); },
  };
}
