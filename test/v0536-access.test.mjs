// v0.53: 可写 / 只读 / 权限未声明. 只读 is shown only when every available side is known read-only, and an agent that may
// write goes through the same confirmation as one that certainly writes.
import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mergeIdentity } from '../src/registry/identity.mjs';
import { createApp } from '../src/server.mjs';
import { accessLabel } from '../public/display.js';
import { confirmMembers } from '../public/calls.js';
import { fixture, put, fakeSpawner } from './fixtures/helpers.mjs';

const codex = (sandbox) => ({ kind: 'codex', sourceId: 'codex', name: 'walvo', file: 'walvo.toml', description: 'd', ...(sandbox ? { sandbox_mode: sandbox } : {}) });
const claude = (tools) => ({ kind: 'claude', sourceId: 'claude', name: 'walvo', file: 'walvo.md', description: 'd', ...(tools ? { tools } : {}) });
const merged = (...records) => mergeIdentity(records).agents[0];

test('v0.53 access: three states from the Codex sandbox and the Claude tools', () => {
  const cases = [
    [[codex('read-only')], 'read', '只读'],
    [[codex('read-only'), claude(['Read', 'Grep', 'Bash'])], 'read', '只读'],
    [[codex('workspace-write'), claude(['Read'])], 'write', '可写'],
    [[codex('danger-full-access')], 'write', '可写'],
    [[codex('read-only'), claude()], 'write', '可写'], // No tools list: the Claude version inherits every tool.
    [[codex('read-only'), claude(['Read', 'NotebookEdit'])], 'write', '可写'],
    [[codex('read-only'), claude(['Read', 'Edit(src/**)'])], 'write', '可写'],
    [[codex()], 'unknown', '权限未声明'], // The user's own Codex default applies.
    [[codex(), claude(['Read'])], 'unknown', '权限未声明'],
    [[codex(), claude(['Write'])], 'write', '可写'],
  ];
  for (const [records, access, label] of cases) {
    const agent = merged(...records);
    assert.equal(agent.access, access, JSON.stringify(records));
    assert.equal(agent.writable, access !== 'read', 'every agent that may write keeps the write confirmation');
    assert.equal(accessLabel(agent), label);
  }
  assert.equal(merged(codex('danger-full-access')).permissions.codex.sandbox, 'danger-full-access');
  assert.equal(merged(codex('read-only'), claude()).permissions.claude.writable, true);
});

test('v0.53 access: the page confirms an undeclared agent like a writable one', async () => {
  const prompts = [], agent = { ...merged(codex()), platforms: { codex: { available: true } } };
  const flags = await confirmMembers([agent], 'codex', { confirm: async text => { prompts.push(text); return true; }, permissionText: () => 'sandbox 未声明' });
  assert.deepEqual(flags, { writableConfirmed: true });
  assert.match(prompts[0], /^以下 Agent 可写或权限未声明，请确认后执行：/);
});

test('v0.53 access: the launch API refuses an undeclared agent until the write confirmation is given', async t => {
  let app;
  t.after(() => app?.close());
  const { config } = await fixture(t);
  await put(path.join(config.codexAgentsDir, 'loki.toml'), 'name="Loki"\ndescription="Role"');
  app = await createApp(config, { spawnImpl: fakeSpawner() });
  try { await app.listen(); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(error.code); return; } throw error; }
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const registry = await (await fetch(`${base}/api/registry`)).json();
  assert.equal(registry.agents.find(a => a.id === 'loki').access, 'unknown');
  const send = body => fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({ agentId: 'loki', cli: 'codex' })).status, 409);
  assert.equal((await send({ agentId: 'loki', cli: 'codex', writableConfirmed: true })).status, 200);
});
