import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';

test('T1 defaults derive home and accept a shallow data-directory config override', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-hub-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({ env: { AGENT_HUB_DATA_DIR: root }, home: root });
  assert.equal(config.codexAgentsDir, path.join(root, '.codex', 'agents'));
  // v0.50: generic defaults; the launch folder lives in the data dir and Codex gets no profile unless configured.
  assert.deepEqual(config.claudeAgentDirs, [path.join(root, '.claude', 'agents'), path.join(root, 'workspace', '.claude', 'agents')]);
  assert.equal(config.port, 47821);
  assert.equal(config.launchProject, path.join(root, 'workspace'));
  assert.equal(config.codexProfile, null);
  assert.equal(config.claudeStateFile, path.join(root, '.claude.json'));
  assert.equal(config.readyProbe, true);
  assert.equal(config.verifyTimeoutMs, 120000);
  assert.equal(config.verifyPollMs, 2000);
  assert.equal(config.claudeLaunchMode, 'agent');
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ port: 12345, claudeAgentDirs: ['custom'], claudeLaunchMode: 'relay', claudeStateFile: path.join(root, 'custom-state.json') }));
  const overridden = await loadConfig({ env: { AGENT_HUB_DATA_DIR: root }, home: root });
  assert.equal(overridden.port, 12345);
  assert.deepEqual(overridden.claudeAgentDirs, ['custom']);
  assert.equal(overridden.codexExe, 'codex');
  assert.equal(overridden.claudeStateFile, path.join(root, 'custom-state.json'));
  assert.equal((await loadConfig({ env: { LOCALAPPDATA: root }, home: root })).dataDir, path.join(root, 'CO-AGENT'));
});

test('T1 rejects repo runtime data and invalid config instead of unsafe fallback', async t => {
  await assert.rejects(loadConfig({ env: { AGENT_HUB_DATA_DIR: path.join(projectRoot, 'runtime') } }), /运行数据/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-hub-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'config.json'), '{');
  await assert.rejects(loadConfig({ env: { AGENT_HUB_DATA_DIR: root } }), /config/);
  for (const claudeStateFile of ['', null, 42]) {
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ claudeStateFile }));
    await assert.rejects(loadConfig({ env: { AGENT_HUB_DATA_DIR: root } }), /claudeStateFile/);
  }
});
