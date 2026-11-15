// v0.53: a git bundle that runs past its time limit ends the whole process tree before the backup goes on. Git for
// Windows' git.exe on PATH starts the real git as a child, so killing only the launcher could leave git writing the
// temporary bundle. No test here starts a real git or taskkill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBackup, createGitBundle } from '../src/backup.mjs';
import { put } from './fixtures/helpers.mjs';

function fakeGit() {
  const children = [];
  const spawnImpl = (exe, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, exe, args, options, stderr: new EventEmitter(), killed: 0, kill() { this.killed++; } });
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settledState = promise => Promise.race([promise.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);

test('v0.53 createGitBundle timeout: the process tree is ended first, then the bundle rejects with git bundle 超时', async () => {
  const { children, spawnImpl } = fakeGit(), killed = [], kill = deferred();
  const run = createGitBundle('repo', 'out.bundle', { spawnImpl, timeoutMs: 10, killTree: child => { killed.push(child); return kill.promise; } });
  run.catch(() => {});
  assert.equal(await settledState(run), 'pending', 'still waiting for the process tree to end');
  assert.equal(killed.length, 1); assert.equal(killed[0], children[0]);
  assert.equal(children[0].killed, 0, 'not just the launcher');
  assert.equal(children[0].options.shell, false); assert.equal(children[0].options.windowsHide, true);
  assert.equal(children[0].options.detached, process.platform !== 'win32' ? true : undefined, 'a process group only where the group is killed');
  kill.resolve();
  await assert.rejects(run, error => /^git bundle 超时/.test(error.message) && !/终止进程树失败/.test(error.message));
  assert.equal(killed.length, 1);
});

test('v0.53 createGitBundle timeout: a failed process-tree kill is reported with the timeout', async () => {
  const { spawnImpl } = fakeGit();
  await assert.rejects(createGitBundle('repo', 'out.bundle', { spawnImpl, timeoutMs: 10, killTree: async () => { throw new Error('拒绝访问'); } }),
    error => /^git bundle 超时/.test(error.message) && error.message.includes('终止进程树失败：拒绝访问'));
});

test('v0.53 createGitBundle timeout: exit or error events while the tree is being ended do not change the outcome', async () => {
  for (const late of [child => child.emit('exit', 0), child => child.emit('exit', 1), child => child.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }))]) {
    const { children, spawnImpl } = fakeGit(), kill = deferred();
    let calls = 0;
    const run = createGitBundle('repo', 'out.bundle', { spawnImpl, timeoutMs: 10, killTree: () => { calls++; return kill.promise; } });
    run.catch(() => {});
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    late(children[0]);
    assert.equal(await settledState(run), 'pending', 'a late event does not settle the bundle');
    kill.resolve();
    await assert.rejects(run, error => error.message === 'git bundle 超时');
    assert.equal(calls, 1);
  }
});

test('v0.53 createGitBundle: success and an ordinary git failure behave as before and never end a process tree', async () => {
  const kills = [], killTree = async child => { kills.push(child); };
  const ok = fakeGit(), done = createGitBundle('repo', 'out.bundle', { spawnImpl: ok.spawnImpl, timeoutMs: 50, killTree });
  assert.deepEqual(ok.children[0].args, ['-C', 'repo', 'bundle', 'create', 'out.bundle', '--all']);
  ok.children[0].emit('exit', 0);
  await done;

  const bad = fakeGit(), failed = createGitBundle('repo', 'out.bundle', { spawnImpl: bad.spawnImpl, timeoutMs: 50, killTree });
  bad.children[0].stderr.emit('data', 'warning: something\r\nfatal: not a git repository\r\n');
  bad.children[0].emit('exit', 128);
  await assert.rejects(failed, { message: 'fatal: not a git repository' });

  const missing = fakeGit(), absent = createGitBundle('repo', 'out.bundle', { spawnImpl: missing.spawnImpl, timeoutMs: 50, killTree });
  missing.children[0].emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(absent, { message: '找不到 git' });

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(kills, [], 'the timers were cleared');
});

test('v0.53 createGitBundle timeout: without an injected process-tree kill a test run refuses the real one', async () => {
  const { children, spawnImpl } = fakeGit();
  await assert.rejects(createGitBundle('repo', 'out.bundle', { spawnImpl, timeoutMs: 10 }),
    { message: 'git bundle 超时；终止进程树失败：测试必须注入进程树终止替身' });
  assert.equal(children.length, 1, 'only the fake git was started');
  assert.equal(children[0].killed, 0);
});

test('v0.53 createBackup passes the process-tree kill to the bundle; a timed-out bundle leaves records only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-backup-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await put(path.join(data, 'settings.json'), '{}');
  const config = { dataDir: data, backup: { dir: path.join(root, 'out'), codeDir: path.join(root, 'repo') } };
  const killTree = async () => {}, seen = [];
  let tick = 0;
  const now = () => new Date(2026, 10, 8, 12, 0, tick++);
  await createBackup(config, { now, killTree, bundle: async (repo, file, options) => { seen.push(options); await fs.writeFile(file, 'b'); } }).start();
  assert.equal(seen.length, 1); assert.equal(seen[0].killTree, killTree);

  const { children, spawnImpl } = fakeGit(), killed = [];
  const result = await createBackup(config, { now, spawnImpl, killTree: async child => { killed.push(child); },
    bundle: (repo, file, options) => createGitBundle(repo, file, { ...options, timeoutMs: 10 }) }).start();
  assert.equal(result.code, '代码打包失败：git bundle 超时');
  assert.deepEqual(killed, children); assert.equal(children.length, 1);
});
