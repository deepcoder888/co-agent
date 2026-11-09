import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadConfig, loadTaskContracts, projectRoot } from '../../src/config.mjs';

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-hub-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({ env: { AGENT_HUB_DATA_DIR: path.join(root, 'data') } });
  config.concept.thinkDir = path.join(root, 'think-concepts');
  // v0.50: the code defaults are generic (no profile, model or effort; no daily catch-up). Fixtures stand for a
  // configured install with the values the app used before v0.50, so exact-argv tests keep their expectations.
  config.concept.autoDaily = true;
  config.recommend.codex = { model: 'gpt-test', effort: 'xhigh' };
  Object.assign(config, {
    userName: 'Alex', codexProfile: 'gpt', codexModel: 'gpt-test', codexEffort: 'xhigh', terminalDisplay: 'secondary', terminalWindowMode: 'fullscreen',
    // v0.52: The user's ~/.codex and ~/.claude stay read-only, so Agent 管理 may not add files there.
    firstRunPrompt: false, allowAgentImport: false,
    // v0.53: a sample catalog (invented books and purposes) instead of anyone's own lists.
    catalogDir: path.join(projectRoot, 'test', 'fixtures', 'catalog'),
    codexAgentsDir: path.join(root, 'codex-agents'),
    readingAgentsDir: path.join(root, 'reading-agents'),
    claudeAgentDirs: [path.join(root, 'claude-agents')],
    claudeProjectsDir: path.join(root, 'claude-projects'),
    claudeStateFile: path.join(root, '.claude.json'),
    claudePluginsCacheDir: path.join(root, 'plugins'),
    codexSessionsDir: path.join(root, 'sessions'),
    codexArchiveDirs: [path.join(root, 'archive')],
    launchProject: path.join(root, 'project'),
    claudeExe: process.execPath, codexExe: process.execPath, pwshExe: process.execPath, wtExe: process.execPath,
    verifyTimeoutMs: 200, verifyPollMs: 10, port: 0,
    // Never write test backups to the real backup folder.
    backup: { dir: path.join(root, 'backups'), codeDir: path.join(root, 'project') },
  });
  config.taskContracts = await loadTaskContracts(path.join(config.catalogDir, 'task-contracts.json'));
  for (const dir of [config.codexAgentsDir, ...config.claudeAgentDirs,
    config.claudeProjectsDir, config.codexSessionsDir, config.launchProject]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return { root, config };
}

export async function put(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

export async function jsonl(file, rows) {
  await put(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

export function fakeSpawner(calls = [], pid = process.pid) {
  return (exe, args, options) => {
    const call = { exe, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = pid + 123; // Deliberately not the terminal PID returned on stdout.
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = () => { call.unref = true; };
    child.kill = () => { call.killed = true; return true; };
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.end(JSON.stringify({ pid, display: options.env.AH_WT ? '\\\\.\\DISPLAY2' : null,
        x: options.env.AH_WT ? 2600 : null, y: options.env.AH_WT ? 40 : null,
        mode: options.env.AH_MODE, fallback: null, ...(!options.env.AH_WT ? { terminalFallback: 'no-wt' } : {}) }));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
}
