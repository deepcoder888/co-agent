import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, jsonl } from './fixtures/helpers.mjs';
import { verifyJoint } from '../src/joint/verify.mjs';
import { verifyLaunch } from '../src/launch/verify.mjs';
import { verifyConcept } from '../src/concepts/verify.mjs';
import { parseCodex } from '../src/stats/codex.mjs';

// Codex >= 0.161 auto-spawns "guardian" subagents whose rollouts copy the parent conversation, CO-AGENT markers included
// (real case: joint 168c2761 had 1 main rollout plus 10 guardian copies, so it stayed 未确认 forever).
const at = '2026-10-08T11:44:00.000Z';
const guardian = id => ({ type: 'session_meta', payload: { id, cwd: 'PROJECT', timestamp: at, source: { subagent: { other: 'guardian' } } } });
const meta = (id, spawn) => ({ type: 'session_meta', payload: { id, cwd: 'PROJECT', timestamp: at, source: spawn ? { subagent: { thread_spawn: spawn } } : 'cli' } });
const user = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const tool = (name, args = {}) => ({ type: 'response_item', payload: { type: 'function_call', name: `functions.${name}`, arguments: JSON.stringify(args) } });
const done = { type: 'event_msg', payload: { type: 'task_complete' } };

test('v015 joint: guardian rollouts carrying the marker are neither main sessions nor whitelist children', async t => {
  const { config } = await fixture(t); config.launchProject = 'PROJECT';
  const jointId = '168c2761-4fc8-4903-a9fb-d9dade4656e2', marker = `【CO-AGENT 联合调用 ${jointId}】`;
  const dir = path.join(config.codexSessionsDir, '2026', '10', '08');
  const conversation = [user('environment context'), user(marker), tool('spawn_agent', { agent_type: 'Corvo' }), tool('spawn_agent', { agent_type: 'Dirvo' }), tool('wait_agent')];
  await jsonl(path.join(dir, 'rollout-main.jsonl'), [meta('main'), ...conversation]);
  for (let i = 0; i < 10; i++) await jsonl(path.join(dir, `rollout-guardian-${i}.jsonl`), [guardian(`guardian-${i}`), ...conversation]);
  await jsonl(path.join(dir, 'rollout-corvo.jsonl'), [meta('corvo', { parent_thread_id: 'main', depth: 1, agent_role: 'Corvo' }), done]);
  await jsonl(path.join(dir, 'rollout-dirvo.jsonl'), [meta('dirvo', { parent_thread_id: 'main', depth: 1, agent_role: 'Dirvo' }), done]);
  const joint = { jointId, sessionId: jointId, cli: 'codex', createdAt: at, pid: process.pid,
    whitelist: [{ id: 'corvo', codexName: 'Corvo', claudeName: 'corvo' }, { id: 'dirvo', codexName: 'Dirvo', claudeName: 'dirvo' }] };
  const status = await verifyJoint(joint, config, { now: Date.parse(at) + 60000, isAlive: () => false });
  assert.equal(status.evidenceError, undefined);
  assert.equal(status.session.id, 'main');
  assert.equal(status.parallel.state, 'ok'); assert.equal(status.whitelist.state, 'ok'); assert.deepEqual(status.whitelist.violations, []);
  assert.deepEqual(status.calls.map(c => c.state), ['done', 'done']); assert.equal(status.overall, 'done');
  // Real duplicates of the main session are still ambiguous.
  await jsonl(path.join(dir, 'rollout-main-copy.jsonl'), [meta('main-copy'), ...conversation]);
  assert.match((await verifyJoint(joint, config, { now: Date.parse(at) + 60000, isAlive: () => false })).evidenceError, /多个/);
});

test('v015 single Codex launch: a guardian copy of the probe does not make the main session ambiguous', async t => {
  const { config } = await fixture(t);
  const id = '11111111-1111-4111-8111-111111111111', probe = `【CO-AGENT 启动检查 ${id}】`;
  const dir = path.join(config.codexSessionsDir, '2026', '10', '08');
  const rows = source => [{ type: 'session_meta', payload: { id: source === 'cli' ? 'main' : 'guardian', cwd: config.launchProject, timestamp: at, source } },
    user(probe), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'READY -jack' }] } }];
  for (const [name, source] of [['main', 'cli'], ['guardian', { subagent: { other: 'guardian' } }]]) {
    const file = path.join(dir, `rollout-${name}.jsonl`); await jsonl(file, rows(source));
    const time = new Date(Date.parse(at) + 1000); await fs.utimes(file, time, time);
  }
  const status = await verifyLaunch({ launchId: id, sessionId: id, cli: 'codex', mode: 'relay', agentName: '-jack', pid: process.pid, createdAt: at },
    config, { now: Date.parse(at), isAlive: () => true });
  assert.notEqual(status.agent.state, 'mismatch'); assert.equal(status.session?.id, 'main');
});

test('v015 concept: a guardian copy of the exec main session is ignored', async t => {
  const { config } = await fixture(t);
  const r = { conceptId: '22222222-2222-4222-8222-222222222222', createdAt: at, agent: { id: 'walvo', name: 'Walvo', codexName: 'Walvo', title: '睡眠' }, excludedConcepts: [],
    result: { markdown: '# x' } };
  const marker = user(`【CO-AGENT 随机概念 ${r.conceptId}】`);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-main.jsonl'), [{ type: 'session_meta', payload: { id: 'main', timestamp: at, source: 'exec', cwd: config.launchProject } }, marker]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-guardian.jsonl'), [{ type: 'session_meta', payload: { id: 'g', timestamp: at, source: { subagent: { other: 'guardian' } }, cwd: config.launchProject } }, marker]);
  await jsonl(path.join(config.codexSessionsDir, 'rollout-child.jsonl'), [{ type: 'session_meta', payload: { id: 'child', timestamp: at, source: { subagent: { thread_spawn: { parent_thread_id: 'main', agent_role: 'Walvo', depth: 1 } } } } }]);
  const ok = await verifyConcept(r, config);
  assert.equal(ok.state, 'ok'); assert.equal(ok.session.id, 'main'); assert.deepEqual(ok.children.map(c => c.role), ['Walvo']);
});

test('v015 stats: guardian rollouts produce no call events', async t => {
  const { config } = await fixture(t);
  const file = path.join(config.codexSessionsDir, 'rollout-guardian.jsonl');
  await jsonl(file, [guardian('g'), user('【CO-AGENT 联合调用 x】'), tool('spawn_agent', { agent_type: 'Corvo' }), done]);
  const parsed = await parseCodex(file);
  assert.deepEqual(parsed.events, []); assert.equal(parsed.badLines, 0);
});
