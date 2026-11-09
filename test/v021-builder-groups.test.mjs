import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';

function textNodes(doc) { doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; }; return doc; }
const agent = (id, primary, kind = 'book') => ({ id, name: id, kind, primary, book: kind === 'book' ? { title: `《${id} 的书》`, author: '作者' } : null,
  purpose: kind === 'role' ? '协调' : null, description: '说明', tags: [], platforms: { codex: { available: true }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
// Registry order deliberately interleaves categories; the shelf's category order is 睡眠 → 投资 → 写作.
const registry = { agents: [agent('Marvo', '投资'), agent('Walvo', '睡眠'), agent('Peter', '功能性 Agent', 'role'), agent('Orphan', undefined),
  agent('Jadra', '睡眠'), agent('Boolan', '写作'), agent('Bufano', '投资')],
  categories: ['睡眠', '投资', '写作'], summary: { roles: 1, books: 6 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };

async function mounted(t, ui) {
  const { doc } = await appDocument(ui); textNodes(doc);
  const app = await mountApp(doc, async url => {
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui, recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/groups' ? { groups: [] } : url.startsWith('/api/concepts?') ? { items: [], running: null, today: null } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  app.actions.openJoint([]);
  const results = doc.getElementById('builder-results');
  const groups = () => results.querySelectorAll('.builder-group').map(group => ({
    label: group.getAttribute('aria-label'), title: group.querySelector('.builder-group-title').textContent,
    members: group.querySelectorAll('input').map(check => check.getAttribute('aria-label').replace('选择 ', '')) }));
  return { doc, results, groups };
}

for (const ui of ['shelf', 'threepane', 'bento', 'editorial']) test(`v021 ${ui} joint builder lists agents grouped like the shelf: staff, categories in order, then 未分类`, async t => {
  const h = await mounted(t, ui);
  assert.deepEqual(h.groups(), [
    { label: '功能性 Agent', title: '功能性 Agent · 1', members: ['Peter'] },
    { label: '睡眠', title: '睡眠 · 2', members: ['Walvo', 'Jadra'] },
    { label: '投资', title: '投资 · 2', members: ['Marvo', 'Bufano'] },
    { label: '写作', title: '写作 · 1', members: ['Boolan'] },
    { label: '未分类', title: '未分类 · 1', members: ['Orphan'] },
  ]);
  assert.ok(h.results.querySelectorAll('.builder-group').every(group => group.getAttribute('role') === 'group'));
  const search = h.doc.getElementById('builder-search'); search.value = 'Marvo'; await search.fire('input');
  assert.deepEqual(h.groups().map(group => group.title), ['投资 · 1'], 'empty groups disappear while searching');
  search.value = 'nothing-matches'; await search.fire('input');
  assert.equal(h.results.querySelectorAll('.builder-group').length, 0); assert.match(h.results.textContent, /没有匹配的 Agent/);
  search.value = ''; await search.fire('input');
  const jadra = h.results.querySelector('[aria-label="选择 Jadra"]'); jadra.checked = true; await jadra.fire('change');
  assert.match(h.doc.getElementById('builder-limit').textContent, /已选 1 \/ 8/);
});

test('v021 the builder follows the current layout category order: shelf puts 睡眠 before 投资, other layouts keep the registry order', async t => {
  const saved = registry.categories;
  registry.categories = ['投资／金融与金钱管理', '睡眠／健康／运动'];
  const renamed = new Map([['睡眠', '睡眠／健康／运动'], ['投资', '投资／金融与金钱管理']]);
  for (const a of registry.agents) if (renamed.has(a.primary)) a.primary = renamed.get(a.primary);
  t.after(() => { registry.categories = saved; for (const a of registry.agents) for (const [short, long] of renamed) if (a.primary === long) a.primary = short; });
  const shelf = await mounted(t, 'shelf');
  // 写作 is no longer a registry category here, so it sorts after the known ones in both layouts.
  assert.deepEqual(shelf.groups().map(g => g.label), ['功能性 Agent', '睡眠／健康／运动', '投资／金融与金钱管理', '未分类', '写作']);
  const threepane = await mounted(t, 'threepane');
  assert.deepEqual(threepane.groups().map(g => g.label), ['功能性 Agent', '投资／金融与金钱管理', '睡眠／健康／运动', '未分类', '写作']);
});
