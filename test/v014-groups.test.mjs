import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeSpawner } from './fixtures/helpers.mjs';
import { createApp } from '../src/server.mjs';
import { createGroups, LIMITS } from '../src/groups.mjs';

const member = (id, extra = {}) => ({ id, name: id, kind: 'role', tags: [], primary: '功能性 Agent', description: '用途',
  platforms: { claude: { available: true, name: id }, codex: { available: true } }, ...extra });

async function harness(t) {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t), calls = [];
  const agents = [member('Walvo'), member('Jadra'), member('Rusko'), member('Peter', { writable: true })];
  const registry = { agents, categories: [], sources: [], summary: {} };
  app = await createApp(config, { spawnImpl: fakeSpawner(calls), registryBuilder: async () => registry });
  await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, { method = 'GET', body, token = app.token } = {}) => {
    const init = { method, headers: { 'X-Co-Agent-Token': token } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetch(base + url, init);
    return { status: response.status, value: await response.json() };
  };
  const joint = async id => JSON.parse(await fs.readFile(path.join(config.dataDir, 'joints', `${id}.json`), 'utf8'));
  return { config, app, calls, request, joint };
}
const sleepGroup = { name: '睡眠三人组', agentIds: ['Walvo', 'Jadra', 'Rusko'], cli: 'claude' };

test('v014 groups: create, list, get, rename, change members and CLI; persisted to groups.json', async t => {
  const h = await harness(t);
  const created = await h.request('/api/groups', { method: 'POST', body: { ...sleepGroup, presets: [{ text: '失眠怎么办？', title: '失眠' }] } });
  assert.equal(created.status, 200); const g = created.value;
  assert.match(g.id, /^[0-9a-f-]{36}$/); assert.equal(g.name, '睡眠三人组'); assert.equal(g.cli, 'claude'); assert.equal(g.runCount, 0); assert.equal(g.lastRunAt, null);
  assert.deepEqual(g.presets.map(p => [p.title, p.text]), [['失眠', '失眠怎么办？']]);
  assert.deepEqual((await h.request('/api/groups')).value.groups.map(x => x.id), [g.id]);
  assert.equal((await h.request(`/api/groups/${g.id}`)).value.name, '睡眠三人组');
  const updated = await h.request(`/api/groups/${g.id}`, { method: 'PUT', body: { name: '  睡眠  小组 ', agentIds: ['Jadra'], cli: 'codex' } });
  assert.equal(updated.value.name, '睡眠 小组'); assert.deepEqual(updated.value.agentIds, ['Jadra']); assert.equal(updated.value.cli, 'codex');
  const file = JSON.parse(await fs.readFile(path.join(h.config.dataDir, 'groups.json'), 'utf8'));
  assert.equal(file.version, 1); assert.equal(file.groups[0].name, '睡眠 小组');
});

test('v014 groups: validation rejects bad names, members, CLI, duplicates and limits without writing', async t => {
  const h = await harness(t);
  for (const change of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(LIMITS.name + 1) }, { name: 3 }, { agentIds: [] }, { agentIds: ['Walvo', 'Walvo'] },
    { agentIds: ['nobody'] }, { agentIds: Array.from({ length: 9 }, () => 'Walvo') }, { cli: 'gpt' }, { presets: [{ text: '' }] }, { presets: 'x' }])
    assert.equal((await h.request('/api/groups', { method: 'POST', body: { ...sleepGroup, ...change } })).status, 400, JSON.stringify(change));
  await assert.rejects(fs.stat(path.join(h.config.dataDir, 'groups.json')), { code: 'ENOENT' });
  assert.equal((await h.request('/api/groups', { method: 'POST', body: sleepGroup })).status, 200);
  assert.equal((await h.request('/api/groups', { method: 'POST', body: { ...sleepGroup, name: '睡眠三人组' } })).status, 409, 'duplicate name');
  assert.equal((await h.request('/api/groups/not-an-id')).status, 404);
  assert.equal((await h.request('/api/groups/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await h.request('/api/groups/a/b/c/d')).status, 404);
});

test('v014 groups: mutations need the token (DELETE included); delete removes the group', async t => {
  const h = await harness(t), g = (await h.request('/api/groups', { method: 'POST', body: sleepGroup })).value;
  assert.equal((await h.request('/api/groups', { method: 'POST', body: sleepGroup, token: '' })).status, 403);
  assert.equal((await h.request(`/api/groups/${g.id}`, { method: 'DELETE', token: '' })).status, 403);
  assert.equal((await h.request(`/api/groups/${g.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await h.request('/api/groups')).value.groups, []);
});

test('v014 presets: add, edit, delete, validation and the per-group limit', async t => {
  const h = await harness(t), g = (await h.request('/api/groups', { method: 'POST', body: sleepGroup })).value;
  const p = (await h.request(`/api/groups/${g.id}/presets`, { method: 'POST', body: { text: '午睡多久最好？' } })).value;
  assert.equal(p.title, ''); assert.equal(p.text, '午睡多久最好？');
  const edited = await h.request(`/api/groups/${g.id}/presets/${p.id}`, { method: 'PUT', body: { title: '午睡', text: '午睡多久？' } });
  assert.deepEqual([edited.value.title, edited.value.text], ['午睡', '午睡多久？']);
  assert.equal((await h.request(`/api/groups/${g.id}/presets`, { method: 'POST', body: { text: 'x'.repeat(LIMITS.text + 1) } })).status, 400);
  assert.equal((await h.request(`/api/groups/${g.id}/presets/${p.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await h.request(`/api/groups/${g.id}/presets/${p.id}`, { method: 'DELETE' })).status, 404);
  for (let i = 0; i < LIMITS.presets; i++) await h.request(`/api/groups/${g.id}/presets`, { method: 'POST', body: { text: `问题 ${i}` } });
  assert.equal((await h.request(`/api/groups/${g.id}/presets`, { method: 'POST', body: { text: '再多一个' } })).status, 409);
});

test('v014 run: members come from the stored group, CLI defaults to the group and can be overridden, provenance is recorded', async t => {
  const h = await harness(t), g = (await h.request('/api/groups', { method: 'POST', body: sleepGroup })).value;
  const ran = await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body: { input: '睡前看手机为什么影响入睡？', agentIds: ['Peter'] } });
  assert.equal(ran.status, 200, JSON.stringify(ran.value)); assert.equal(ran.value.cli, 'claude'); assert.deepEqual(ran.value.group, { id: g.id, name: '睡眠三人组' });
  assert.deepEqual(ran.value.whitelist.map(w => w.id), ['Walvo', 'Jadra', 'Rusko'], 'request agentIds must be ignored');
  const record = await h.joint(ran.value.jointId);
  assert.equal(record.source, 'group'); assert.deepEqual(record.group, { id: g.id, name: '睡眠三人组' }); assert.equal(record.recommendId, null);
  const codex = await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body: { input: '第二个问题', cli: 'codex' } });
  assert.equal(codex.value.cli, 'codex');
  const after = (await h.request(`/api/groups/${g.id}`)).value; assert.equal(after.runCount, 2); assert.ok(after.lastRunAt);
  const history = (await h.request('/api/history?type=joint')).value.items;
  assert.ok(history.every(item => item.source === 'group' && item.group.name === '睡眠三人组'));
  // Rerun from history keeps the group provenance.
  const rerun = await h.request('/api/history/rerun', { method: 'POST', body: { type: 'joint', id: ran.value.jointId } });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.value));
  assert.deepEqual((await h.joint(rerun.value.jointId)).group, { id: g.id, name: '睡眠三人组' });
});

test('v014 run: preset saved only after a successful start; confirmation round-trips do not duplicate it', async t => {
  const h = await harness(t);
  const g = (await h.request('/api/groups', { method: 'POST', body: { name: '含可写', agentIds: ['Walvo', 'Peter'], cli: 'claude' } })).value;
  const body = { input: '这个问题要保存', savePreset: true, presetTitle: '保存的' };
  const first = await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body });
  assert.equal(first.status, 409); assert.equal((await h.request(`/api/groups/${g.id}`)).value.presets.length, 0);
  const second = await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body: { ...body, writableConfirmed: true } });
  assert.equal(second.status, 200); assert.equal(second.value.preset.title, '保存的'); assert.equal(second.value.presetError, null);
  const presets = (await h.request(`/api/groups/${g.id}`)).value.presets;
  assert.deepEqual(presets.map(p => [p.title, p.text]), [['保存的', '这个问题要保存']]);
  assert.equal((await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body: { input: '' } })).status, 400);
});

test('v014 run: a full preset list does not fail an already started run', async t => {
  const h = await harness(t), g = (await h.request('/api/groups', { method: 'POST', body: sleepGroup })).value;
  for (let i = 0; i < LIMITS.presets; i++) await h.request(`/api/groups/${g.id}/presets`, { method: 'POST', body: { text: `问题 ${i}` } });
  const ran = await h.request(`/api/groups/${g.id}/run`, { method: 'POST', body: { input: '新问题', savePreset: true } });
  assert.equal(ran.status, 200); assert.ok(ran.value.jointId); assert.equal(ran.value.preset, null); assert.match(ran.value.presetError, /最多/);
});

test('v014 store: concurrent mutations are serialized without losing updates', async t => {
  const { config } = await fixture(t);
  const store = createGroups(config, () => ({ agents: [member('Walvo')] }));
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.create({ name: `组 ${i}`, agentIds: ['Walvo'], cli: 'codex' })));
  assert.equal((await store.list()).groups.length, 12);
  const g = (await store.list()).groups[0];
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.addPreset(g.id, { text: `问 ${i}` })));
  assert.equal((await store.get(g.id)).presets.length, 10);
});
