import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { layouts } from '../public/layouts/index.js';

function textNodes(doc) { doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; }; return doc; }
const member = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent',
  book: kind === 'book' ? { title: '《书》', author: '作者' } : null, purpose: kind === 'role' ? '协调' : null, description: '说明', tags: [],
  platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const agents = ['Walvo', 'Jadra', 'Rusko', 'Peter'].map(id => member(id));
const registry = { agents, categories: ['学习'], summary: { roles: 0, books: 4 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };

// In-memory /api/groups that mirrors the server contract closely enough for UI tests.
function groupsApi() {
  let seq = 0; const groups = [];
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return { groups, handle(url, method, body) {
    const parts = url.split('/'); const g = groups.find(x => x.id === parts[3]);
    if (url === '/api/groups' && method === 'GET') return { groups };
    if (url === '/api/groups' && method === 'POST') { const group = { id: id(), name: body.name, agentIds: body.agentIds, cli: body.cli, presets: (body.presets || []).map(p => ({ id: id(), ...p })), runCount: 0, lastRunAt: null, createdAt: 'x', updatedAt: 'x' }; groups.push(group); return group; }
    if (g && parts.length === 4 && method === 'PUT') return Object.assign(g, body);
    if (g && parts.length === 4 && method === 'DELETE') { groups.splice(groups.indexOf(g), 1); return { deleted: g.id }; }
    if (g && parts[4] === 'run' && method === 'POST') return { jointId: 'j1', cli: body.cli, whitelist: [], group: { id: g.id, name: g.name }, preset: body.savePreset ? { id: id(), title: body.presetTitle, text: body.input } : null, presetError: null };
    if (g && parts[4] === 'presets' && method === 'DELETE') { g.presets = g.presets.filter(p => p.id !== parts[5]); return { deleted: parts[5] }; }
    return null;
  } };
}
async function fixture(t, ui = 'threepane', { seed = [] } = {}) {
  const { doc, ids } = await appDocument(ui); textNodes(doc);
  const requests = [], store = groupsApi(), confirms = [];
  for (const g of seed) store.handle('/api/groups', 'POST', g);
  const app = await mountApp(doc, async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, method, body, opts });
    const grouped = url.startsWith('/api/groups') ? store.handle(url, method, body) : null;
    const value = grouped ?? (url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui, recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} } : { items: [], unavailable: [] });
    return { ok: true, json: async () => value };
  }, { confirm: async (text, trigger, options) => { confirms.push({ text, options }); return true; } });
  t.after(() => app.dispose());
  return { doc, ids, app, requests, store, confirms };
}
const seeded = [{ name: '睡眠三人组', agentIds: ['Walvo', 'Jadra', 'Rusko'], cli: 'claude', presets: [{ title: '睡前手机', text: '睡前看手机为什么影响入睡？' }] }];

test('v014 builder saves a named group (question becomes the first preset) without running it', async t => {
  const h = await fixture(t);
  await h.app.actions.newGroup();
  assert.equal(h.ids['joint-builder'].open, true); assert.equal(h.ids['builder-title'].textContent, '新建联合调用');
  assert.equal(h.ids['builder-save'].disabled, true, 'needs agents and a name');
  for (const id of ['Walvo', 'Jadra']) { const check = h.ids['builder-results'].querySelector(`[aria-label="选择 ${id}"]`); check.checked = true; await check.fire('change'); }
  h.ids['builder-name'].value = '睡眠小组'; await h.ids['builder-name'].fire('input');
  h.ids['builder-input'].value = '失眠怎么办？'; await h.ids['builder-input'].fire('input');
  assert.equal(h.ids['builder-save'].disabled, false); assert.equal(h.ids['builder-save-run'].disabled, false);
  await h.ids['builder-save'].fire('click');
  const post = h.requests.find(r => r.url === '/api/groups' && r.method === 'POST');
  assert.deepEqual(post.body, { name: '睡眠小组', agentIds: ['Walvo', 'Jadra'], cli: 'codex', presets: [{ text: '失眠怎么办？', title: '' }] });
  assert.equal(post.opts.headers['X-Co-Agent-Token'], 'synthetic-token');
  assert.ok(!h.requests.some(r => r.url === '/api/joint' || r.url.endsWith('/run')), 'saving must not run');
  assert.equal(h.ids['joint-builder'].open, false); assert.equal(h.app.snapshot().state.view, 'groups');
  assert.equal(h.app.snapshot().groups.groups[0].name, '睡眠小组');
  assert.match(h.ids['app-toast'].textContent, /已保存调用组「睡眠小组」/);
});

test('v014 保存并运行 saves then runs the group with the question', async t => {
  const h = await fixture(t);
  await h.app.actions.newGroup();
  const check = h.ids['builder-results'].querySelector('[aria-label="选择 Walvo"]'); check.checked = true; await check.fire('change');
  h.ids['builder-name'].value = '单人'; await h.ids['builder-name'].fire('input');
  h.ids['builder-input'].value = '问一下'; await h.ids['builder-input'].fire('input');
  await h.ids['builder-save-run'].fire('click');
  const run = h.requests.find(r => r.url.endsWith('/run'));
  assert.equal(run.method, 'POST'); assert.equal(run.body.input, '问一下'); assert.equal(run.body.cli, 'codex'); assert.equal(run.body.savePreset, false);
});

test('v014 提问 dialog: presets fill the question, 保存为预设 is sent, CLI override, closes after run', async t => {
  const h = await fixture(t, 'threepane', { seed: seeded }); const g = h.store.groups[0];
  await h.app.actions.openGroups();
  // Threepane quick list in the left column opens the dialog directly.
  const quick = descendants(h.doc.body).find(n => n.getAttribute?.('data-focus-key') === `groups-nav-${g.id}`);
  assert.ok(quick, 'quick entry'); await quick.fire('click');
  const dialog = h.ids['group-ask']; assert.equal(dialog.open, true); assert.equal(h.ids['group-ask-title'].textContent, '睡眠三人组');
  assert.equal(h.ids['group-ask-cli'].value, 'claude'); assert.equal(h.ids['group-ask-run'].disabled, true);
  const use = descendants(dialog).find(n => n.className === 'group-preset-use'); await use.fire('click');
  assert.equal(h.ids['group-ask-input'].value, '睡前看手机为什么影响入睡？'); assert.equal(h.ids['group-ask-run'].disabled, false);
  h.ids['group-ask-input'].value = '新的问题'; await h.ids['group-ask-input'].fire('input');
  h.ids['group-ask-save'].checked = true; await h.ids['group-ask-save'].fire('change'); assert.equal(h.ids['group-ask-preset-title'].hidden, false);
  h.ids['group-ask-preset-title'].value = '新预设'; h.ids['group-ask-cli'].value = 'codex';
  await h.ids['group-ask-run'].fire('click');
  const run = h.requests.find(r => r.url === `/api/groups/${g.id}/run`);
  assert.deepEqual([run.body.input, run.body.cli, run.body.savePreset, run.body.presetTitle], ['新的问题', 'codex', true, '新预设']);
  assert.equal(dialog.open, false); assert.equal(h.app.snapshot().groups.groups[0].presets.length, 2);
  assert.match(h.ids['app-toast'].textContent, /已向「睡眠三人组」发起联合调用，并保存为预设/);
});

test('v014 delete confirms as destructive and uses an authenticated DELETE; edit uses PUT', async t => {
  const h = await fixture(t, 'threepane', { seed: seeded }); const g = h.store.groups[0];
  await h.app.actions.openGroups();
  h.app.actions.editGroup(g.id);
  assert.equal(h.ids['builder-title'].textContent, '编辑调用组'); assert.equal(h.ids['builder-name'].value, '睡眠三人组');
  assert.equal(h.ids['builder-question'].hidden, true); assert.equal(h.ids['builder-submit'].hidden, true); assert.equal(h.ids['builder-save'].textContent, '保存修改');
  h.ids['builder-name'].value = '睡眠组'; await h.ids['builder-name'].fire('input'); await h.ids['builder-save'].fire('click');
  const put = h.requests.find(r => r.method === 'PUT'); assert.equal(put.url, `/api/groups/${g.id}`); assert.equal(put.body.name, '睡眠组');
  // A fresh 新建 after editing starts clean.
  await h.app.actions.newGroup(); assert.equal(h.ids['builder-title'].textContent, '新建联合调用'); assert.equal(h.ids['builder-name'].value, ''); h.ids['joint-builder'].close();
  await h.app.actions.deleteGroup(g.id);
  assert.equal(h.confirms.at(-1).options.danger, true); assert.match(h.confirms.at(-1).text, /删除调用组/);
  const del = h.requests.find(r => r.method === 'DELETE'); assert.equal(del.url, `/api/groups/${g.id}`);
  assert.equal(del.opts.headers['X-Co-Agent-Token'], 'synthetic-token'); assert.equal(del.opts.body, undefined);
  assert.equal(h.app.snapshot().groups.groups.length, 0);
});

for (const ui of ['bento', 'editorial', 'shelf']) test(`v014 ${ui}: 调用组 entry opens the shared page with cards and actions`, async t => {
  const h = await fixture(t, ui, { seed: seeded });
  const entry = h.ids['groups-open']; assert.ok(entry, `${ui} has a 调用组 entry`); await entry.fire('click');
  const panel = h.ids['groups-panel']; assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /睡眠三人组/); assert.match(panel.textContent, /默认 Claude · 1 个预设问题/);
  const ask = descendants(panel).find(n => n.textContent === '提问'); await ask.fire('click');
  assert.equal(h.ids['group-ask'].open, true); assert.ok(h.ids['group-ask'].className.includes(layouts[ui].jointBuilderSkin));
});

test('v014 empty groups page explains how to create one', async t => {
  const h = await fixture(t, 'bento');
  await h.app.actions.openGroups(); assert.match(h.ids['groups-panel'].textContent, /还没有调用组/);
});
