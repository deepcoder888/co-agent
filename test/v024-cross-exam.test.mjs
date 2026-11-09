import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeSpawner } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createWorkflows } from '../src/recommend/workflows.mjs';
import { mountJointBuilder } from '../public/calls.js';
import { matchesSearch } from '../public/display.js';
import { drawJointStatus } from '../public/layouts/shelf.js';
import { mountGroupAsk } from '../public/groups.js';

const member = (id, kind = 'book', extra = {}) => ({ id, name: kind === 'role' ? `-${id}` : id, kind, primary: kind === 'role' ? '功能性 Agent' : '睡眠', tags: [],
  description: '说明', writable: false, sources: { checked: true, missing: [] }, permissions: {},
  platforms: { claude: { available: true, name: id }, codex: { available: true, name: id } }, sync: { state: '同步' }, ...extra });
const registry = { agents: [member('walvo'), member('jadra'), member('jason', 'role', { reviewer: true })], categories: ['睡眠'], summary: { books: 2, roles: 1 } };

test('v024 startJoint: crossExam must be a boolean, is recorded, and follows manual, group and rerun starts', async t => {
  const { config } = await fixture(t), calls = [];
  const workflows = createWorkflows(config, () => registry, { spawnImpl: fakeSpawner(calls) });
  const manual = { source: 'manual', agentIds: ['walvo', 'jason'], input: '几点睡最合适', cli: 'claude' };
  for (const crossExam of ['yes', 1, null]) await assert.rejects(workflows.startJoint({ ...manual, crossExam }), error => error.status === 400, String(crossExam));
  const started = await workflows.startJoint({ ...manual, crossExam: true });
  assert.equal(started.crossExam, true);
  const record = JSON.parse(await fs.readFile(path.join(config.dataDir, 'joints', `${started.jointId}.json`), 'utf8'));
  assert.equal(record.crossExam, true); assert.deepEqual(record.whitelist.map(a => a.stage), [undefined, 'review']);
  assert.match(record.args[record.args.indexOf('--append-system-prompt') + 1], /交叉质询（已勾选，必须执行/);
  assert.equal((await workflows.startJoint({ ...manual })).crossExam, false, 'omitted means off');
  assert.equal((await workflows.startJoint({}, { originalJoint: record })).crossExam, true, 'a rerun keeps the original choice');
  const group = { id: 'g1', name: '睡眠组', agentIds: ['walvo', 'jadra'] };
  assert.equal((await workflows.startJoint({ input: '问题', cli: 'codex', crossExam: true }, { group })).crossExam, true);
  assert.equal((await workflows.startJoint({ input: '问题', cli: 'codex' }, { group })).crossExam, false);
});

function textNodes(doc) { doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; }; return doc; }
async function builder(t) {
  const { doc } = await appDocument('shelf'); textNodes(doc);
  const posts = [], saved = [];
  const api = async (url, body) => { posts.push({ url, body }); return { jointId: 'j1' }; };
  const ui = mountJointBuilder(doc, { api, getRegistry: () => registry, matchesSearch, confirm: async () => true, permissionText: () => '只读',
    onSaveGroup: async value => { saved.push(value); return { id: 'g1' }; }, onUpdateGroup: async () => {} });
  const get = id => doc.getElementById(id);
  const pick = async name => { const check = get('builder-results').querySelector(`[aria-label="选择 ${name}"]`); check.checked = true; await check.fire('change'); };
  return { doc, ui, posts, saved, get, pick };
}

test('v024 builder: 交叉质询 is off by default, a checked box is sent and then reset, and save-and-run carries it', async t => {
  const h = await builder(t);
  h.ui.open();
  const box = h.get('builder-cross-exam'), label = h.get('builder-cross-exam-label');
  // The recording DOM keeps parsed attributes; a browser maps them to properties. Unchecked = not true.
  assert.equal(box.getAttribute('type'), 'checkbox'); assert.notEqual(box.checked, true); assert.equal(box.getAttribute('checked'), null); assert.equal(label.hidden, false);
  assert.match(label.textContent, /交叉质询（多一轮，更慢）/);
  await h.pick('walvo'); h.get('builder-input').value = '几点睡最合适'; await h.get('builder-input').fire('input');
  box.checked = true; await box.fire('change');
  await h.get('builder-submit').fire('click');
  assert.equal(h.posts.at(-1).body.crossExam, true); assert.equal(box.checked, false, 'reset after a successful start');
  h.ui.open(); await h.pick('walvo'); h.get('builder-input').value = '再问一次'; await h.get('builder-input').fire('input');
  await h.get('builder-submit').fire('click');
  assert.equal(h.posts.at(-1).body.crossExam, false);

  h.ui.open(); await h.pick('walvo'); h.get('builder-name').value = '睡眠组'; await h.get('builder-name').fire('input');
  h.get('builder-input').value = '问题'; await h.get('builder-input').fire('input'); box.checked = true;
  await h.get('builder-save-run').fire('click');
  assert.equal(h.saved.at(-1).run, true); assert.equal(h.saved.at(-1).crossExam, true); assert.equal(box.checked, false);
});

test('v024 builder: editing a saved group hides 交叉质询', async t => {
  const h = await builder(t);
  h.ui.edit({ id: 'g1', name: '睡眠组', cli: 'claude', agentIds: ['walvo'] });
  assert.equal(h.get('builder-cross-exam-label').hidden, true);
  h.ui.open([]);
});

test('v024 joint status shows the 交叉质询 line only when it was requested', async () => {
  const { doc } = await appDocument('shelf'); textNodes(doc);
  const record = { cli: 'claude', whitelist: [{ claudeName: 'walvo', codexName: 'walvo' }] };
  const base = { overall: 'failed', process: { state: 'exited' }, cwd: { state: 'ok' }, parallel: { state: 'ok', evidence: [] },
    whitelist: { state: 'ok', violations: [], deniedAttempts: [] }, calls: [{ agent: 'walvo', state: 'done' }] };
  const with_ = doc.createElement('article');
  drawJointStatus(doc, with_, record, { ...base, crossExam: { state: 'failed', evidence: [{ agent: 'walvo', calls: 1 }] } });
  assert.match(with_.textContent, /交叉质询：失败/);
  const without = doc.createElement('article');
  drawJointStatus(doc, without, record, base);
  assert.doesNotMatch(without.textContent, /交叉质询/);
});

test('v024 group ask: 交叉质询 is off by default, a checked box is sent with the run and then reset', async () => {
  const { doc } = await appDocument('shelf'); textNodes(doc);
  const runs = [], group = { id: 'g1', name: '睡眠组', cli: 'claude', presets: [], members: [{ name: 'walvo', avatarLetter: 'W', avatarColor: '#335' }] };
  const groups = { get: id => id === 'g1' ? group : id === 'g2' ? { ...group, id: 'g2', name: '另一组' } : null,
    run: async (id, options) => { runs.push({ id, ...options }); return { jointId: 'j1' }; }, updatePreset: async () => {}, removePreset: async () => {} };
  const ask = mountGroupAsk(doc, { groups });
  const get = id => doc.getElementById(id), box = get('group-ask-cross-exam'), input = get('group-ask-input');
  const run = async (text, check) => { ask.open('g1'); input.value = text; await input.fire('input'); if (check) box.checked = true; await get('group-ask-run').fire('click'); };
  ask.open('g1');
  assert.equal(box.type, 'checkbox');
  assert.notEqual(box.checked, true); assert.match(get('group-ask-cross-exam-label').textContent, /交叉质询（多一轮，更慢）/);
  await run('几点睡最合适', true);
  assert.equal(runs.at(-1).crossExam, true); assert.equal(runs.at(-1).id, 'g1'); assert.equal(box.checked, false, 'reset after a successful run');
  await run('再问一次', false);
  assert.equal(runs.at(-1).crossExam, false);
  ask.open('g1'); box.checked = true; ask.open('g2');
  assert.equal(box.checked, false, 'switching to another group resets it');
  ask.dispose();
});
