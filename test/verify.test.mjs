import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyLaunch } from '../src/launch/verify.mjs';
import { fixture, jsonl as writeJsonl, put } from './fixtures/helpers.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const start = '2026-10-06T12:00:00.000Z';
async function jsonl(file, rows) {
  await writeJsonl(file, rows);
  // Fixtures have a synthetic launch clock; their file timestamps must use that clock too.
  const time = new Date(Date.parse(start) + 1000);
  await fs.utimes(file, time, time);
}
function launch(cli = 'claude', mode = 'agent') {
  return { launchId: id, sessionId: id, cli, mode, agentName: '-jack', pid: process.pid, createdAt: start };
}
const probe = `【Agent Hub 启动检查 ${id}】`;
const context = [
  { role: 'developer', text: 'Synthetic developer instructions' },
  { role: 'user', text: '# AGENTS.md instructions for synthetic project' },
];
function claudeRows(config, { cwd = config.launchProject, setting = '-jack', ready = true, marker = true } = {}) {
  return [{ type: 'agent-setting', agentSetting: setting },
    ...context.map(({ role, text }) => ({ type: role, message: { role, content: [{ type: 'text', text }] } })),
    { type: 'world_state', payload: { synthetic: true } },
    { type: 'user', cwd, message: { role: 'user', content: marker ? probe : 'old unrelated message' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ready ? 'READY' : 'hello' }] } }];
}

test('T10 Claude direct ready requires structural identity, cwd and post-probe READY', async t => {
  const { config } = await fixture(t);
  await jsonl(path.join(config.claudeProjectsDir, 'project', `${id}.jsonl`), claudeRows(config));
  const status = await verifyLaunch(launch(), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.overall, 'ready');
  assert.equal(status.agent.state, 'confirmed');
  assert.equal(status.cwd.state, 'ok');
  assert.equal(status.waiting.state, 'ok');
  assert.equal(status.process.pid, process.pid);
  assert.match(status.message, /已就绪/);
});

for (const [label, options, state, field] of [
  ['cwd mismatch', { cwd: 'C:\\wrong' }, 'failed', 'cwd'],
  ['agent mismatch', { setting: '-steven' }, 'failed', 'agent'],
  ['no probe marker', { marker: false }, 'pending', 'waiting'],
  ['assistant self-identification cannot confirm', { setting: '', ready: false }, 'pending', 'agent'],
]) test(`T10 Claude ${label}`, async t => {
  const { config } = await fixture(t);
  await jsonl(path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`), claudeRows(config, options).filter(row => row.agentSetting !== ''));
  const status = await verifyLaunch(launch(), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.overall, state);
  if (state === 'failed') assert.equal(status[field].state, 'mismatch');
});

test('T10 Claude relay initially awaiting, then confirms only exact Agent tool input; wrong identity fails', async t => {
  const { config } = await fixture(t);
  const file = path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`);
  const rows = claudeRows(config);
  await jsonl(file, rows);
  let status = await verifyLaunch(launch('claude', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.overall, 'ready');
  assert.equal(status.agent.state, 'awaiting-first-call');
  assert.match(status.message, /首次提问后核验/);
  rows.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: '-jack' } }] } });
  await jsonl(file, rows);
  status = await verifyLaunch(launch('claude', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.agent.state, 'confirmed');
  assert.equal(status.overall, 'ready');
  rows.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: '-steven' } }] } });
  await jsonl(file, rows);
  assert.equal((await verifyLaunch(launch('claude', 'relay'), config, { isAlive: () => true })).overall, 'failed');
});

test('T10 exited fails immediately; absent logs pending then timeout unconfirmed; no synthetic READY', async t => {
  const { config } = await fixture(t);
  assert.equal((await verifyLaunch(launch(), config, { isAlive: () => false })).overall, 'failed');
  assert.equal((await verifyLaunch(launch(), config, { now: Date.parse(start), isAlive: () => true })).overall, 'pending');
  const status = await verifyLaunch(launch(), config, { now: Date.parse(start) + 201, isAlive: () => true });
  assert.equal(status.overall, 'unconfirmed');
  assert.equal(status.waiting.state, 'pending');
});

function codexRows(config, { cwd = config.launchProject, marker = id, firstMarker = true, timestamp = start, ready = true } = {}) {
  return [{ type: 'session_meta', payload: { id: 'parent-id', cwd, timestamp, source: 'cli', originator: 'codex-tui', history_mode: 'paginated' } },
    ...context.map(({ role, text }) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } })),
    { type: 'world_state', payload: { synthetic: true } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstMarker ? `【Agent Hub 启动检查 ${marker}】` : 'unrelated' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ready ? 'READY -jack' : 'hello' }] } }];
}

test('T10 Codex current/next-day main session, normalized cwd, parent-linked child confirmation', async t => {
  const { config } = await fixture(t);
  const file = path.join(config.codexSessionsDir, '2026', '10', '07', 'rollout-main.jsonl');
  await jsonl(file, codexRows(config, { cwd: config.launchProject.replaceAll('\\', '/').toUpperCase() }));
  let status = await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.overall, 'ready');
  assert.equal(status.agent.state, 'awaiting-first-call');
  await jsonl(path.join(config.codexSessionsDir, '2026', '10', '07', 'rollout-child.jsonl'), [{ type: 'session_meta', payload: { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-id', agent_role: 'JACK' } } } } }]);
  status = await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.agent.state, 'confirmed');
  assert.equal(status.overall, 'ready');
});

test('T10 Codex ignores bare launch id, old sessions, unrelated children and self claims', async t => {
  const { config } = await fixture(t);
  const dir = path.join(config.codexSessionsDir, '2026', '10', '06');
  const rows = codexRows(config, { firstMarker: false });
  rows.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: id }] } });
  await jsonl(path.join(dir, 'rollout-unrelated.jsonl'), rows);
  await jsonl(path.join(dir, 'rollout-old.jsonl'), codexRows(config, { timestamp: '2026-10-05T00:00:00Z' }));
  assert.equal((await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true })).overall, 'pending');
  await jsonl(path.join(dir, 'rollout-main.jsonl'), codexRows(config));
  await jsonl(path.join(dir, 'rollout-child.jsonl'), [{ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'different-parent', agent_role: '-jack' } } } } }]);
  const status = await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.agent.state, 'awaiting-first-call');
});

test('T10 Codex wrong linked agent or wrong cwd fails; malformed partial JSON is not evidence', async t => {
  const { config } = await fixture(t);
  const dir = path.join(config.codexSessionsDir, '2026', '10', '06');
  await jsonl(path.join(dir, 'rollout-main.jsonl'), codexRows(config, { cwd: 'C:\\wrong' }));
  assert.equal((await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true })).cwd.state, 'mismatch');
  await jsonl(path.join(dir, 'rollout-main.jsonl'), codexRows(config));
  await jsonl(path.join(dir, 'rollout-child.jsonl'), [{ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'parent-id', agent_role: '-steven' } } } } }]);
  assert.equal((await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true })).agent.state, 'mismatch');
  await put(path.join(dir, 'rollout-child.jsonl'), '{"type":');
  assert.equal((await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true })).agent.state, 'awaiting-first-call');
});

for (const cli of ['claude', 'codex']) {
  test(`finding #2 ${cli} matches probe after injected developer, AGENTS user and world_state`, async t => {
    const { config } = await fixture(t);
    const rows = cli === 'claude' ? claudeRows(config) : codexRows(config);
    const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`) :
      path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-main.jsonl');
    await jsonl(file, rows);
    const status = await verifyLaunch(launch(cli, cli === 'codex' ? 'relay' : 'agent'), config, { now: Date.parse(start), isAlive: () => true });
    assert.equal(status.overall, 'ready');
    assert.equal(status.waiting.state, 'ok');
  });

  for (const invalid of ['bare UUID', 'developer probe', 'assistant probe', 'world_state probe', 'wrong launchId']) {
    test(`finding #2 ${cli} rejects ${invalid} as the user probe`, async t => {
      const { config } = await fixture(t);
      const rows = cli === 'claude' ? claudeRows(config, { marker: false }) : codexRows(config, { firstMarker: false });
      const role = invalid.split(' ')[0];
      const text = invalid === 'bare UUID' ? id : invalid === 'wrong launchId' ? `【Agent Hub 启动检查 ${id.replace('11111111', '22222222')}】` : probe;
      const extra = invalid === 'world_state probe' ? { type: 'world_state', payload: { text } } : cli === 'claude' ?
        { type: ['developer', 'assistant'].includes(role) ? role : 'user', message: { content: [{ type: 'text', text }] } } :
        { type: 'response_item', payload: { type: 'message', role: ['developer', 'assistant'].includes(role) ? role : 'user', content: [{ type: 'input_text', text }] } };
      rows.splice(rows.length - 1, 0, extra);
      const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`) :
        path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-main.jsonl');
      await jsonl(file, rows);
      const status = await verifyLaunch(launch(cli, cli === 'codex' ? 'relay' : 'agent'), config, { now: Date.parse(start), isAlive: () => true });
      assert.equal(status.overall, 'pending');
      assert.equal(status.waiting.state, 'pending');
    });
  }

  test(`finding #2 ${cli} READY must be an assistant message after the probe`, async t => {
    const { config } = await fixture(t);
    const rows = cli === 'claude' ? claudeRows(config) : codexRows(config);
    const ready = rows.pop();
    rows.splice(rows.length - 1, 0, ready);
    const userReady = cli === 'claude' ? { type: 'user', message: { content: 'READY -jack' } } :
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'READY -jack' }] } };
    rows.push(userReady);
    const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`) :
      path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-main.jsonl');
    await jsonl(file, rows);
    const status = await verifyLaunch(launch(cli, cli === 'codex' ? 'relay' : 'agent'), config, { now: Date.parse(start), isAlive: () => true });
    assert.equal(status.cwd.state, 'ok');
    assert.equal(status.waiting.state, 'pending');
    assert.equal(status.overall, 'pending');
  });
}

test('finding #2 multiple Codex mains containing the exact probe are a mismatch', async t => {
  const { config } = await fixture(t);
  const dir = path.join(config.codexSessionsDir, '2026', '10', '06');
  await jsonl(path.join(dir, 'rollout-one.jsonl'), codexRows(config));
  const other = codexRows(config); other[0].payload.id = 'other-parent';
  await jsonl(path.join(dir, 'rollout-two.jsonl'), other);
  const status = await verifyLaunch(launch('codex', 'relay'), config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(status.overall, 'failed');
  assert.equal(status.agent.state, 'mismatch');
});

test('finding #3 every verification outcome retains the launch trust notice', async t => {
  const { config } = await fixture(t);
  const notice = '首次在此目录使用交互式 Claude：请在弹出的窗口中选择「Yes, I trust this folder」并按回车，之后会话才会开始。';
  const entry = { ...launch(), notice };
  for (const [now, isAlive, overall] of [[Date.parse(start), () => true, 'pending'], [Date.parse(start) + 201, () => true, 'unconfirmed'], [Date.parse(start), () => false, 'failed']]) {
    const status = await verifyLaunch(entry, config, { now, isAlive });
    assert.equal(status.overall, overall);
    assert.equal(status.notice, notice);
  }
  await jsonl(path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`), claudeRows(config));
  const ready = await verifyLaunch(entry, config, { now: Date.parse(start), isAlive: () => true });
  assert.equal(ready.overall, 'ready');
  assert.equal(ready.notice, notice);
});
