// v0.53: a session folder that does not exist yet is not an error. 调用统计 says plainly that there are no records yet;
// a folder that exists but cannot be read keeps its detail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures/helpers.mjs';
import { createStats, aggregate } from '../src/stats/index.mjs';

test('v0.53 stats: missing Claude and Codex folders read as "no records yet", without the path or ENOENT', async t => {
  const { root, config } = await fixture(t);
  await fs.rm(config.claudeProjectsDir, { recursive: true }); await fs.rm(config.codexSessionsDir, { recursive: true });
  config.codexArchiveDirs = [path.join(root, 'no-archive')];
  const stats = createStats(config, []);
  await stats.refresh();
  const data = stats.snapshot();
  assert.deepEqual(data.limitedReasons, ['还没有 Claude 会话记录（这台电脑上还没用过 Claude CLI）',
    '还没有 Codex 会话记录（这台电脑上还没用过 Codex CLI）', '还没有 Codex 归档会话记录']);
  for (const reason of data.limitedReasons) assert.doesNotMatch(reason, /ENOENT|scandir|来源不可读|[A-Z]:\\/);
  const claude = data.sources.find(s => s.id === 'claude');
  assert.equal(claude.missing, true); assert.equal(claude.available, false);
  assert.deepEqual(claude.notes, ['还没有 Claude 会话记录（这台电脑上还没用过 Claude CLI）']);
  // The page still counts launches made from CO-AGENT itself.
  assert.ok(data.sources.find(s => s.id === 'hub').available);
});

test('v0.53 stats: a real read error keeps its detail', () => {
  const sources = [{ id: 'claude', path: 'D:\\walvo\\projects', available: false, notes: ['EACCES: permission denied, scandir'] }];
  assert.deepEqual(aggregate([], [], sources, Date.parse('2026-11-01T00:00:00Z')).limitedReasons,
    ['claude 来源不可读：D:\\walvo\\projects（EACCES: permission denied, scandir）']);
});
