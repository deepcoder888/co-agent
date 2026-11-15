import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { createAgentLists } from '../src/registry/lists.mjs';
import { createCandidates } from '../src/registry/candidates.mjs';
import { createApp } from '../src/server.mjs';
import { mountApp } from '../public/app.js';

// v0.52 Agent 管理 (2026-11-08): what is listed in the app goes to the data dir; the catalog folder is read-only;
// agent files are only ever added, and only where allowAgentImport is on (off).
async function setup(t) {
  const ctx = await fixture(t), { config } = ctx;
  config.catalogDir = path.join(ctx.root, 'catalog');
  await put(path.join(config.catalogDir, 'roles.json'), JSON.stringify({ version: 1, roles: ['Lister'], purposes: { Lister: '列清单' } }));
  await put(path.join(config.catalogDir, 'book-categories.json'), JSON.stringify({ version: 1, categories: ['科学'],
    books: [{ agent: 'Physics', title: '《物理》', author: '甲', edition: '一', primary: '科学', tags: [] }] }));
  for (const name of ['Lister', 'Physics', 'Helper', 'Reader', 'Novel']) {
    await put(path.join(config.codexAgentsDir, `${name.toLowerCase()}.toml`), `name="${name}"\ndescription="${name} agent <example>hidden</example> text"`);
  }
  let registry = await buildRegistry(config);
  const lists = createAgentLists(config, () => registry, { onChanged: async () => { registry = await buildRegistry(config); } });
  return { ...ctx, lists, registry: () => registry };
}

test('v052 lists made in the app merge with the catalog and say where they came from', async t => {
  const { lists, registry, config } = await setup(t);
  assert.deepEqual((await lists.describe()).unlisted.map(a => a.id).sort(), ['helper', 'novel', 'reader']);
  assert.equal((await lists.describe()).unlisted.find(a => a.id === 'helper').description, 'Helper agent text', 'examples are not shown');
  assert.equal((await lists.change({ op: 'addCategory', name: '文学' })).message, '已添加分类「文学」');
  await lists.change({ op: 'addRole', id: 'helper', purpose: '帮忙整理' });
  const result = await lists.change({ op: 'addBook', id: 'novel', title: '《小说》', author: '乙', edition: '二', primary: '文学' });
  assert.deepEqual(registry().categories, ['科学', '文学']);
  const kind = id => { const a = registry().agents.find(x => x.id === id); return [a.kind, a.listSource]; };
  assert.deepEqual(['lister', 'helper', 'physics', 'novel'].map(kind), [['role', 'catalog'], ['role', 'app'], ['book', 'catalog'], ['book', 'app']]);
  assert.equal(registry().agents.find(a => a.id === 'helper').purpose, '帮忙整理');
  assert.deepEqual(result.categories, [{ name: '科学', source: 'catalog', books: 1 }, { name: '文学', source: 'app', books: 1 }]);
  assert.deepEqual(result.unlisted.map(a => a.id), ['reader']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir, 'catalog-additions.json'), 'utf8')),
    { version: 1, roles: [{ agent: 'Helper', purpose: '帮忙整理' }], categories: ['文学'] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir, 'book-additions.json'), 'utf8')).books,
    [{ agent: 'Novel', title: '《小说》', author: '乙', edition: '二', primary: '文学', tags: [] }]);
  const catalogBefore = await fs.readFile(path.join(config.catalogDir, 'roles.json'), 'utf8');
  await lists.change({ op: 'removeBook', id: 'novel' }); await lists.change({ op: 'removeRole', id: 'helper' });
  assert.equal((await lists.change({ op: 'removeCategory', name: '文学' })).message, '已删除分类「文学」');
  assert.deepEqual((await lists.describe()).unlisted.map(a => a.id).sort(), ['helper', 'novel', 'reader']);
  assert.equal(await fs.readFile(path.join(config.catalogDir, 'roles.json'), 'utf8'), catalogBefore, 'the catalog folder is never written');
});

test('v052 every change is checked; catalog entries cannot be removed here', async t => {
  const { lists, config } = await setup(t);
  await lists.change({ op: 'addCategory', name: '文学' });
  await lists.change({ op: 'addBook', id: 'novel', title: '书', author: '作者', edition: '版', primary: '文学' });
  const refused = [
    [{ op: 'addCategory', name: '科学' }, 409, /已有分类/], [{ op: 'addCategory', name: '未分类' }, 400, /保留名称/],
    [{ op: 'addCategory', name: ' ' }, 400, /1–20/], [{ op: 'addCategory', name: '字'.repeat(21) }, 400, /1–20/],
    [{ op: 'removeCategory', name: '科学' }, 409, /只能删除在软件里添加的分类/], [{ op: 'removeCategory', name: '文学' }, 409, /还有书在用/],
    [{ op: 'addRole', id: 'lister', purpose: '用途' }, 409, /不在「未登记」里/], [{ op: 'addRole', id: 'helper', purpose: '' }, 400, /1–40/],
    [{ op: 'addRole', id: 'helper', purpose: '字'.repeat(41) }, 400, /1–40/],
    [{ op: 'addBook', id: 'reader', title: '书', author: '作者', edition: '版', primary: '没有' }, 400, /书名、作者、版本或分类无效/],
    [{ op: 'addBook', id: 'reader', title: '', author: '作者', edition: '版', primary: '科学' }, 400, /书名、作者、版本或分类无效/],
    [{ op: 'removeRole', id: 'lister' }, 409, /只能移出在软件里登记的工具/], [{ op: 'removeBook', id: 'physics' }, 409, /只能移出在软件里登记的书籍/],
    [{ op: 'nothing' }, 400, /op 无效/], [[], 400, /请求体无效/],
  ];
  for (const [body, status, message] of refused) await assert.rejects(lists.change(body), error => error.status === status && message.test(error.message), JSON.stringify(body));
  await put(path.join(config.dataDir, 'catalog-additions.json'), '{"version":1,"roles":"x","categories":[]}');
  await assert.rejects(lists.describe().then(() => lists.change({ op: 'addCategory', name: '新' })), error => error.status === 409 && /catalog-additions\.json 格式无效/.test(error.message));
});

test('v052 agent files: off means 403; on adds new files only, exactly as given', async t => {
  const { lists, config, registry } = await setup(t);
  const toml = 'name = "Imported"\ndescription = "导入的书 Agent"\ndeveloper_instructions = """\n第一行\n"""\n';
  await assert.rejects(lists.importFile({ fileName: 'imported.toml', content: toml }), error => error.status === 403);
  config.allowAgentImport = true;
  const codex = await lists.importFile({ fileName: 'whatever.toml', content: toml });
  assert.deepEqual(codex, { name: 'Imported', kind: 'codex', file: path.join(config.codexAgentsDir, 'Imported.toml'), listed: true });
  assert.equal(await fs.readFile(codex.file, 'utf8'), toml);
  assert.ok(registry().outOfScope.some(a => a.id === 'imported'), 'it waits in 未登记');
  const md = '---\nname: Imported\ndescription: Claude 版\n---\n正文\n';
  const claude = await lists.importFile({ fileName: 'imported.md', content: md });
  assert.equal(claude.file, path.join(config.claudeAgentDirs[0], 'Imported.md')); assert.equal(claude.listed, true);
  assert.equal(await fs.readFile(claude.file, 'utf8'), md);
  const lone = await lists.importFile({ fileName: 'lone.md', content: '---\nname: Lone\n---\n' });
  assert.equal(lone.listed, false, 'a Claude-only agent is not listed until a Codex version arrives');
  const refused = [
    [{ fileName: 'again.toml', content: toml }, 409, /已有同名 Agent/], [{ fileName: 'h.toml', content: 'name="Helper"' }, 409, /已有同名 Agent/],
    [{ fileName: 'x.json', content: toml }, 400, /只能导入/], [{ fileName: 'x.toml', content: ' ' }, 400, /空的/],
    [{ fileName: 'x.toml', content: 'name="Big"\n#' + 'x'.repeat(256 * 1024) }, 400, /256 KB/], [{ fileName: 'x.toml', content: 'name="N"\0' }, 400, /NUL/],
    [{ fileName: 'x.toml', content: 'description="no name"' }, 400, /缺少 name/], [{ fileName: 'x.toml', content: 'name="../escape"' }, 400, /不安全/],
    [{ fileName: 'x.md', content: '没有 front matter 的正文' }, 400, /文件解析失败/],
  ];
  for (const [body, status, message] of refused) await assert.rejects(lists.importFile(body), error => error.status === status && message.test(error.message), body.fileName + ' ' + body.content.slice(0, 20));
  assert.equal(await fs.readFile(codex.file, 'utf8'), toml, 'nothing was overwritten');
  await put(path.join(config.codexAgentsDir, 'Fresh.toml'), 'name="Other"');
  await assert.rejects(lists.importFile({ fileName: 'f.toml', content: 'name="Fresh"' }), error => error.status === 409 && /同名 Agent 文件/.test(error.message));
  assert.equal(await fs.readFile(path.join(config.codexAgentsDir, 'Fresh.toml'), 'utf8'), 'name="Other"');
});

test('v052 HTTP: /api/agent-lists and /api/agent-files need the token and change the registry', async t => {
  // After hooks run in registration order: close the app or store before the fixture folder is removed.
  let app; t.after(() => app?.close());
  const { config } = await setup(t);
  app = await createApp(config, { conceptAutoDaily: false });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, token = app.token) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-co-agent-token': token }, body: JSON.stringify(body) });
  const lists = await (await fetch(base + '/api/agent-lists')).json();
  assert.equal(lists.allowImport, false); assert.deepEqual(lists.unlisted.map(a => a.id).sort(), ['helper', 'novel', 'reader']);
  assert.equal((await post('/api/agent-lists', { op: 'addCategory', name: '文学' }, 'f'.repeat(64))).status, 403);
  const changed = await post('/api/agent-lists', { op: 'addRole', id: 'helper', purpose: '帮忙' });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).message, '已把 Helper 设为工具 Agent');
  assert.equal((await (await fetch(base + '/api/registry')).json()).agents.find(a => a.id === 'helper').kind, 'role');
  const off = await post('/api/agent-files', { fileName: 'a.toml', content: 'name="A"' });
  assert.equal(off.status, 403); assert.match((await off.json()).error, /关闭了导入/);
  assert.equal((await fs.readdir(config.codexAgentsDir)).includes('A.toml'), false);
});

test('v052 with no categories the new-book suggestion stops before calling Codex', async t => {
  let candidates; t.after(() => candidates?.close());
  const { config } = await fixture(t);
  const registry = { categories: [], agents: [], candidates: [{ id: 'reader', name: 'Reader', description: '' }] };
  candidates = createCandidates(config, () => registry, { runner: async () => assert.fail('Codex must not be called') });
  await assert.rejects(candidates.suggest({ ids: ['reader'] }), error => error.status === 409 && /还没有分类/.test(error.message));
});

function managerFetch(state, calls) {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (url === '/api/agent-lists' && opts.method === 'POST') {
      calls.push(body);
      if (body.op === 'addCategory') state.lists.categories.push({ name: body.name, source: 'app', books: 0 });
      if (body.op === 'addRole') { state.lists.unlisted = state.lists.unlisted.filter(a => a.id !== body.id); state.lists.roles.push({ id: body.id, name: body.id, purpose: body.purpose, source: 'app' }); }
      if (body.op === 'removeRole') state.lists.roles = state.lists.roles.filter(r => r.id !== body.id);
      return { ok: true, json: async () => structuredClone({ message: `done ${body.op}`, ...state.lists }) };
    }
    if (url === '/api/agent-files') { calls.push(body); return { ok: body.fileName !== 'bad.toml', status: 400, json: async () => body.fileName === 'bad.toml' ? { error: '文件里缺少 name' } : { name: 'Imported', kind: 'codex', listed: true } }; }
    const value = url === '/api/agent-lists' ? state.lists
      : url === '/api/registry' ? { agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui: 'threepane', recommend: {} }
      : url === '/api/config' ? { firstRun: false, values: {}, paths: {}, environment: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  };
}

test('v052 Agent 管理 page: open from settings, add a category, list a tool, remove it, import files', async t => {
  const { doc } = await appDocument('shelf'), calls = [];
  const state = { lists: { allowImport: false, categories: [], roles: [], books: [{ id: 'physics', name: 'Physics', title: '《物理》', primary: '科学', source: 'catalog' }],
    unlisted: [{ id: 'helper', name: 'Helper', description: '帮手', platforms: ['codex', 'claude'] }] } };
  const front = await mountApp(doc, managerFetch(state, calls), { confirm: async () => true });
  t.after(() => front.dispose());
  const dialog = () => doc.getElementById('agent-manager-dialog');
  const button = label => dialog().querySelectorAll('button').find(b => b.getAttribute('aria-label') === label || b.textContent === label);
  await doc.getElementById('settings-agents').fire('click');
  assert.equal(dialog().open, true); assert.equal(doc.getElementById('settings-dialog').open, false);
  assert.equal(doc.getElementById('agent-manager-import').hidden, true, 'import is hidden where it is switched off');
  assert.equal(doc.getElementById('agent-manager-no-category').hidden, false);
  assert.equal(button('把 Helper 设为书籍 Agent').disabled, true, 'no category, no book');
  assert.equal(doc.getElementById('agent-manager-added').textContent, '还没有在软件里登记的 Agent。', 'catalog books are not listed for removal');
  doc.getElementById('agent-manager-category').value = ' 文学 ';
  await doc.getElementById('agent-manager-add-category').fire('click');
  assert.deepEqual(calls.at(-1), { op: 'addCategory', name: '文学' });
  assert.equal(doc.getElementById('agent-manager-category').value, '');
  assert.match(doc.getElementById('agent-manager-categories').textContent, /文学0 本/);
  assert.equal(button('删除分类 文学').textContent, '删除');
  assert.equal(button('把 Helper 设为书籍 Agent').disabled, false);
  await button('把 Helper 设为工具 Agent').fire('click');
  const purpose = dialog().querySelectorAll('input').find(i => i.getAttribute('data-field') === 'purpose');
  purpose.value = '帮忙整理';
  await button('保存').fire('click');
  assert.deepEqual(calls.at(-1), { op: 'addRole', id: 'helper', purpose: '帮忙整理' });
  assert.equal(doc.getElementById('agent-manager-status').textContent, 'done addRole');
  assert.match(doc.getElementById('agent-manager-added').textContent, /helper工具 Agent · 帮忙整理/);
  await button('移出 helper').fire('click');
  assert.deepEqual(calls.at(-1), { op: 'removeRole', id: 'helper' });
  state.lists.allowImport = true; await front.actions.openSettings?.(); await doc.getElementById('settings-agents').fire('click');
  assert.equal(doc.getElementById('agent-manager-import').hidden, false);
  const file = doc.getElementById('agent-manager-file');
  file.files = [{ name: 'good.toml', text: async () => 'name="Imported"' }, { name: 'bad.toml', text: async () => 'x' }];
  await file.fire('change');
  assert.deepEqual(calls.slice(-2).map(c => c.fileName), ['good.toml', 'bad.toml']);
  assert.equal(doc.getElementById('agent-manager-status').textContent, '已导入 Imported（Codex 版）；bad.toml：文件里缺少 name');
});
