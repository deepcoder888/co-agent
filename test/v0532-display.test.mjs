import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put } from './fixtures/helpers.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';

// v0.53: the 书架 room's default book order and 编辑版's example joint call are the catalog's shelfOrder and featured
// (book-categories.json), passed on as registry.display; the page code names no book.
test('v0532 the registry passes on the catalog\'s shelf order and featured joint call', async t => {
  const { config, root } = await fixture(t);
  const registry = await buildRegistry(config);
  assert.deepEqual(registry.display.shelfOrder.slice(0, 3), ['walvo', 'jadra', 'rusko']);
  assert.deepEqual(registry.display.featured.members, [{ id: 'walvo', label: 'Walvo' }, { id: 'jadra', label: 'Jadra' }, { id: 'rusko', label: 'Rusko' }]);
  assert.deepEqual(registry.display.featured.title, ['一个示例问题，', '请三位作者坐下来谈谈。']);
  config.catalogDir = path.join(root, 'plain-catalog');
  await put(path.join(config.catalogDir, 'book-categories.json'), '{"version":1,"categories":[],"books":[]}');
  assert.deepEqual((await buildRegistry(config)).display, { shelfOrder: [], featured: null }, 'both are optional');
  await put(path.join(config.catalogDir, 'book-categories.json'), '{"version":1,"categories":[],"books":[],"featured":{"members":["a"]}}');
  await assert.rejects(buildRegistry(config), /book-categories\.json 格式错误/, 'featured needs its text');
  await put(path.join(config.catalogDir, 'book-categories.json'), '{"version":1,"categories":[],"books":[],"shelfOrder":"a"}');
  await assert.rejects(buildRegistry(config), /book-categories\.json 格式错误/);
});

const book = id => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'book', primary: '示例分类', tags: [], description: '示例',
  book: { title: `《${id} 示例书》`, author: id, edition: '示例版' }, platforms: { claude: { available: true, file: 'x.md' }, codex: { available: true } },
  permissions: { claude: { model: 'sonnet', effort: 'high' }, codex: { sandbox: 'read-only' } }, sources: { checked: true, missing: [], total: 1 },
  sync: { state: '同步', detail: '示例' } });

async function mount(t, ui, display) {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="display-test">');
  const doc = documentFrom(html); doc.documentElement.setAttribute('data-ui', ui);
  const registry = { agents: ['ona', 'tavo', 'pell'].map(book), categories: ['示例分类'], summary: { roles: 0, books: 3, synced: 3, inScope: 3 },
    sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-11-09T00:00:00Z', display };
  const app = await mountApp(doc, async url => {
    const data = url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/settings' ? { ui, recommend: { claude: { model: 'sonnet', effort: 'high' } } }
      : url === '/api/stats' ? { sources: [], limited: true, limitedReasons: ['示例'], perAgent: {} } : { items: [] };
    return { ok: true, json: async () => structuredClone(data) };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app };
}

test('v0532 the shelf orders books by the catalog\'s shelfOrder, and by registry order without one', async t => {
  const spines = doc => Array.from(doc.querySelectorAll('.book-spine')).map(n => n.getAttribute('aria-label'));
  const ordered = await mount(t, 'shelf', { shelfOrder: ['pell', 'ona'], featured: null });
  assert.deepEqual(spines(ordered.doc), ['查看 Pell 详情', '查看 Ona 详情', '查看 Tavo 详情']);
  const plain = await mount(t, 'shelf', { shelfOrder: [], featured: null });
  assert.deepEqual(spines(plain.doc), ['查看 Ona 详情', '查看 Tavo 详情', '查看 Pell 详情']);
});

test('v0532 编辑版 shows the catalog\'s featured joint call, and a general invitation without one', async t => {
  const featured = { members: [{ id: 'tavo', label: 'Tavo' }, { id: 'pell', label: 'Pell' }], title: ['示例标题，', '第二行。'], text: '示例说明。' };
  const { doc, app } = await mount(t, 'editorial', { shelfOrder: [], featured });
  const focus = doc.querySelector('.editorial-focus'), title = focus.children.find(n => n.tagName === 'H2');
  assert.deepEqual(title.children.map(n => [n.tagName, n.textContent]), [['SPAN', '示例标题，'], ['BR', ''], ['SPAN', '第二行。']]);
  assert.equal(doc.querySelector('.focus-copy').textContent, 'Tavo 与 Pell 示例说明。');
  const start = focus.querySelectorAll('button').find(n => n.textContent === '发起联合调用'); await start.fire('click');
  assert.deepEqual(app.snapshot().state.jointSelectedIds, ['tavo', 'pell']);
  const plain = await mount(t, 'editorial', { shelfOrder: [], featured: null });
  assert.equal(plain.doc.querySelector('.focus-copy').textContent, '一个问题，多位作者的回答。');
  assert.equal(plain.doc.querySelector('.editorial-focus').children.find(n => n.tagName === 'H2').textContent, '一个问题，请几位作者坐下来谈谈。');
});
