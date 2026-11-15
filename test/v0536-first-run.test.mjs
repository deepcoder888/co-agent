// v0.53: what a stranger sees on a computer without the author's setup: an empty catalog with a next step, a book
// dialog that works without categories, settings titled 设置 with 基本配置 visible, no internal notes, rooms that say
// how many books they need, a described (not alarming) version comparison, and folders that are simply not made yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appDocument } from './fixtures/app.mjs';
import { fixture, put } from './fixtures/helpers.mjs';
import { mountApp, toAgentView, toDetailView } from '../public/app.js';
import { mountCandidates } from '../public/candidates.js';
import { renderRooms } from '../public/rooms-page.js';
import { createSeminars } from '../public/seminars.js';
import { createBasicConfig } from '../src/basic-config.mjs';

const emptyRegistry = (extra = {}) => ({ agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], candidates: [], ...extra });
const unlisted = id => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'out-of-scope', reason: '未登记', description: '示例', platforms: { codex: { available: true }, claude: { available: false } } });

async function mount(t, ui, { registry = emptyRegistry(), config = { firstRun: false, values: {}, paths: {}, environment: {} }, before = () => {} } = {}) {
  const { doc } = await appDocument(ui), calls = [];
  before(doc);
  const app = await mountApp(doc, async (url, opts = {}) => {
    calls.push(url);
    const value = url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/config' ? config
      : url === '/api/agent-lists' ? { allowImport: false, bookMaker: null, categories: [], roles: [], books: [], unlisted: registry.outOfScope }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui, recommend: {} } : { items: [], unavailable: [] };
    return { ok: true, status: 200, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, calls };
}

for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) {
  test(`v0.53 empty catalog (${ui}): says what was found and opens Agent 管理`, async t => {
    const { doc, calls } = await mount(t, ui, { registry: emptyRegistry({ outOfScope: [unlisted('walvo'), unlisted('jadra')] }) });
    const empty = doc.querySelector('.empty-catalog');
    assert.ok(empty, 'an empty-catalog block is shown');
    assert.match(empty.textContent, /还没有登记 Agent/);
    assert.match(empty.textContent, /找到 2 个还没登记的 Agent/);
    const shown = n => !n.hidden && !n.parent?.closest('[hidden]');
    assert.ok(!doc.querySelectorAll('p').some(n => n.textContent === '当前分类没有 Agent。' && shown(n)), 'the short category text is not shown');
    const open = empty.querySelectorAll('button').find(b => b.textContent === '打开 Agent 管理');
    await open.fire('click');
    assert.equal(doc.getElementById('agent-manager-dialog').open, true);
    assert.ok(calls.includes('/api/agent-lists'));
  });
}

test('v0.53 empty catalog: no agent files at all points to importing or making one; a merely empty category keeps the short text', async t => {
  const { doc } = await mount(t, 'threepane');
  assert.match(doc.querySelector('.empty-catalog').textContent, /还没有找到 Codex 或 Claude 的 Agent 文件/);
  const book = { id: 'walvo', name: 'Walvo', kind: 'book', primary: '示例', tags: [], description: 'd', book: { title: 'T', author: 'A', edition: 'E' },
    platforms: { codex: { available: true }, claude: { available: false } }, permissions: { codex: { sandbox: 'read-only' } }, access: 'read', writable: false, sync: { state: '同步', detail: '' } };
  const filled = await mount(t, 'threepane', { registry: emptyRegistry({ agents: [book], categories: ['示例', '空分类'], summary: { roles: 0, books: 1 } }) });
  await filled.app.actions.selectCategory('空分类');
  assert.equal(filled.doc.querySelector('.empty-catalog'), null);
  assert.match(filled.doc.getElementById('layout-root').textContent, /当前分类没有 Agent。/);
});

test('v0.53 确认新书籍 Agent without categories: no AI call, a category can be added here, then it works', async t => {
  const { doc } = await appDocument('threepane');
  const registry = emptyRegistry({ candidates: [{ id: 'walvo', name: 'Walvo', description: '示例', bookFiles: ['x.epub'], hasReadingMd: false }] });
  const posts = [];
  const candidates = mountCandidates(doc, {
    api: async (url, body) => {
      posts.push([url, body]);
      if (url === '/api/agent-lists') return { message: 'ok' };
      if (url === '/api/candidates/suggest') return [{ id: 'walvo', title: '示例书', author: '某人', edition: '示例版', primary: '心理' }];
      throw new Error(`unexpected ${url}`);
    },
    getRegistry: () => registry, onChanged: async () => { registry.categories = ['心理']; }, notify: () => {} });
  t.after(() => candidates.dispose());
  await candidates.open();
  const get = id => doc.getElementById(id);
  assert.deepEqual(posts, [], 'no AI suggestion is requested while there is no category');
  assert.equal(get('candidate-no-category').hidden, false);
  assert.match(get('candidate-no-category').textContent, /还没有书的分类/);
  assert.doesNotMatch(get('candidate-status').textContent, /失败/);
  assert.equal(get('candidate-suggest').disabled, true);
  assert.match(doc.querySelector('.candidate-source').textContent, /书籍 Agent 目录里没有它的 Claude 版，加入后只能用 Codex 调用/);
  get('candidate-category').value = '心理'; await get('candidate-category').fire('input');
  await get('candidate-add-category').fire('click');
  assert.deepEqual(posts[0], ['/api/agent-lists', { op: 'addCategory', name: '心理' }]);
  assert.equal(posts[1][0], '/api/candidates/suggest', 'suggestions run once a category exists');
  assert.equal(get('candidate-no-category').hidden, true);
  const select = doc.querySelector('select[data-field="primary"]');
  assert.deepEqual(select.options.map(o => o.value), ['心理']);
  assert.equal(select.value, '心理');
  assert.equal(get('candidate-accept').disabled, false, 'the book can now be added');
});

test('v0.53 settings: titled 设置, 页面排版 is a visible section heading, first run leaves 基本配置 below the sticky heading', async t => {
  const config = { firstRun: true, values: { userName: '用户' }, paths: {}, environment: {} };
  const { doc } = await mount(t, 'threepane', { config, before: doc => {
    const dialog = doc.getElementById('settings-dialog');
    dialog.scrollTop = 300;
    dialog.querySelector('.drawer-heading').getBoundingClientRect = () => ({ top: 0, bottom: 134 });
    doc.getElementById('settings-basic').getBoundingClientRect = () => ({ top: 54 });
  } });
  const dialog = doc.getElementById('settings-dialog');
  assert.equal(doc.getElementById('settings-title').textContent, '设置');
  const style = doc.getElementById('settings-style-title');
  assert.equal(style.textContent, '页面排版'); assert.doesNotMatch(style.className, /sr-only/);
  assert.equal(dialog.open, true);
  assert.equal(dialog.scrollTop, 300 - 80 - 12, 'scrolled back by the part the heading covered, plus a margin');
});

test('v0.53 settings: no internal development notes in the page', async () => {
  const html = await fs.readFile('public/index.html', 'utf8');
  for (const note of [/v0\.7 排版/, /Design 画布/, /原有平台禁止规则/, /只读发现本地定义/]) assert.doesNotMatch(html, note);
  assert.match(html, /<footer>CO-AGENT v<!-- CO_AGENT_VERSION --> · /);
});

test('v0.53 基本配置: folders CO-AGENT makes later are not shown as problems', async t => {
  const config = { firstRun: false, values: {}, environment: {}, paths: { 'backup.dir': { exists: false, createdLater: true },
    catalogDir: { exists: false, createdLater: true }, readingAgentsDir: { exists: false }, launchProject: { exists: true } } };
  const { doc } = await mount(t, 'threepane', { config });
  const hint = key => doc.querySelectorAll('[data-config-missing]').find(el => el.getAttribute('data-config-missing') === key);
  assert.equal(hint('backup.dir').textContent, '还没有，第一次备份时自动创建'); assert.equal(hint('backup.dir').className, 'settings-basic-later');
  assert.match(hint('catalogDir').textContent, /^还没有。没有清单也能用/); assert.equal(hint('catalogDir').hidden, false);
  assert.equal(hint('readingAgentsDir').textContent, '目录不存在'); assert.equal(hint('readingAgentsDir').className, 'settings-basic-missing');
  assert.equal(hint('launchProject').hidden, true);
});

test('v0.53 基本配置: the server marks only the backup folder and the default catalog folder as made later', async t => {
  const { root, config } = await fixture(t);
  const basic = createBasicConfig(config, { isDirectory: async () => false, resolver: async () => null });
  let { paths } = await basic.describe();
  assert.deepEqual(paths['backup.dir'], { exists: false, createdLater: true });
  assert.deepEqual(paths.catalogDir, { exists: false, createdLater: true });
  await put(path.join(config.dataDir, 'config.json'), JSON.stringify({ catalogDir: path.join(root, 'my-lists'), readingAgentsDir: path.join(root, 'books') }));
  ({ paths } = await basic.describe());
  assert.deepEqual(paths.catalogDir, { exists: false }, 'a folder the user chose and that is missing is a problem');
  assert.deepEqual(paths.readingAgentsDir, { exists: false });
});

const roomBook = (id, extra = {}) => ({ id, name: id, kind: 'book', book: { title: id }, platforms: { codex: { available: true } }, writable: false, access: 'read', sources: { checked: true, missing: [] }, ...extra });
function rooms(doc) {
  const side = doc.createElement('aside'), main = doc.createElement('div'); doc.getElementById('layout-root').append(side, main);
  const ctx = { doc, refs: { chatArrange() {}, chatLayout: 'columns' }, state: { view: 'chat', allAgents: [] }, actions: {} };
  return model => renderRooms(ctx, model, { side, main });
}

test('v0.53 圆桌: the requirement shows before typing and the start button stays off below three ready books', async t => {
  const agents = [roomBook('a'), roomBook('b'), roomBook('c', { writable: true, access: 'unknown' }), roomBook('d', { platforms: { codex: { available: false } } })];
  const seminars = createSeminars({ api: async () => ({ items: [] }), getRegistry: () => ({ agents }), confirm: async () => true, permissionText: () => '', setTimer: () => 0, clearTimer: () => {} });
  t.after(() => seminars.dispose());
  assert.equal(seminars.snapshot().ready, 2, 'writable, undeclared or unavailable books are not ready');
  const { doc } = await appDocument('threepane'), render = rooms(doc);
  const model = { ...seminars.snapshot(), input: '为什么习惯难以改变？', active: 0, parallel: 3 };
  render({ room: 'seminars', fresh: { seminars: true }, seminars: model, follow: {} });
  const need = doc.getElementById('room-seminars-need');
  assert.equal(need.hidden, false);
  assert.match(need.textContent, /^圆桌需要至少 3 个可直接使用.*的书籍 Agent，现在有 2 个。/);
  assert.equal(doc.getElementById('room-seminars-start').disabled, true);
  render({ room: 'seminars', fresh: { seminars: true }, seminars: { ...model, ready: 3 }, follow: {} });
  assert.equal(need.hidden, true); assert.equal(doc.getElementById('room-seminars-start').disabled, false);
});

test('v0.53 会诊 and 顾问团: the minimum is shown and enforced before submitting', async () => {
  const { doc } = await appDocument('threepane'), render = rooms(doc);
  const books = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: id, bookLabel: id, available: i < 4, ready: i < 3 }));
  const consult = draft => ({ items: [], selected: null, running: null, active: 0, parallel: 3, busy: false, error: '', books, draft: { situation: '换工作吗', options: [], explicit: false, count: 3, lenses: [], parentId: null, ...draft } });
  render({ room: 'consults', fresh: { consults: true }, consults: consult({}), follow: {} });
  const start = () => doc.getElementById('room-consults-start'), validation = () => doc.getElementById('room-consults-validation').textContent;
  assert.equal(start().disabled, false);
  render({ room: 'consults', fresh: { consults: true }, consults: consult({ count: 5 }), follow: {} });
  assert.equal(start().disabled, true); assert.match(validation(), /^会诊自动选择 5 本需要至少 5 个可直接使用.*现在有 3 个/);
  render({ room: 'consults', fresh: { consults: true }, consults: { ...consult({}), books: books.slice(0, 2) }, follow: {} });
  assert.equal(start().disabled, true); assert.match(validation(), /现在有 2 个/);
  render({ room: 'councils', councils: { items: [], selected: null, draft: null, busy: false, books: books.slice(0, 1) }, follow: {} });
  assert.match(doc.querySelector('.room-empty-text').textContent, /顾问团需要至少 2 个书籍 Agent，现在有 1 个/);
});

test('v0.53 two versions that differ are described, not flagged', () => {
  const agent = { id: 'walvo', name: 'Walvo', kind: 'book', primary: '示例', tags: [], description: 'd', platforms: { codex: { available: true }, claude: { available: true } },
    access: 'read', writable: false, sync: { state: '描述不同', detail: '描述不同', descriptionDiff: { codex: 'a', claude: 'b' } } };
  const detail = toDetailView(toAgentView(agent), { items: [], unavailable: [] });
  const chip = detail.chips.find(c => /版本/.test(c.label));
  assert.deepEqual([chip.label, chip.tone], ['两个版本的描述不同', 'normal']);
  assert.ok(!detail.chips.some(c => c.label === '不同步'));
  const rows = detail.sections.find(s => s.key === 'sync').rows;
  assert.deepEqual(rows.slice(0, 3), [{ label: '状态', value: '两个版本的描述不同' }, { label: 'Codex 描述', value: 'a' }, { label: 'Claude 描述', value: 'b' }]);
});
