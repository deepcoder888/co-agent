import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { zipFiles, collectRecords, createBackup, createGitBundle } from '../src/backup.mjs';
import { zipIndex, readEntry } from '../src/books/epub.mjs';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';

// v0.49 备份 (2026-11-08): one ZIP of the records and the code history that the user moves to the cloud drive monthly.
const unzip = buffer => { const index = zipIndex(buffer); return new Map([...index].map(([name, entry]) => [name, readEntry(buffer, entry)])); };

async function dataDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await put(path.join(data, 'settings.json'), '{"ui":"threepane"}');
  await put(path.join(data, 'chats', 'c1.json'), JSON.stringify({ title: '睡前要不要看书' }));
  await put(path.join(data, 'concepts', '2026', '概念.md'), '# 概念');
  for (const skipped of ['Cache/data_0', 'Local Storage/leveldb/000003.log', 'GPUCache/index', 'logs/co-agent.log', 'crashes/report.dmp', 'Preferences', 'DIPS'])
    await put(path.join(data, ...skipped.split('/')), 'x');
  await put(path.join(data, 'chats', 'c2.json.0b1c.tmp'), 'half-written');
  return { root, data };
}

test('v049 zipFiles: a plain UTF-8 ZIP that reads back byte for byte, stored when deflate does not help', () => {
  const noise = randomBytes(4096), text = Buffer.from('对话记录'.repeat(500));
  const files = unzip(zipFiles([{ name: 'data/对话/记录.json', data: text }, { name: 'noise.bin', data: noise }, { name: 'empty.txt', data: Buffer.alloc(0) }]));
  assert.deepEqual([...files.keys()], ['data/对话/记录.json', 'noise.bin', 'empty.txt']);
  assert.ok(files.get('data/对话/记录.json').equals(text)); assert.ok(files.get('noise.bin').equals(noise)); assert.equal(files.get('empty.txt').length, 0);
  // Without the UTF-8 flag (bit 11) Explorer shows Chinese names as mojibake.
  const one = zipFiles([{ name: '恢复说明.txt', data: text }]), central = one.readUInt32LE(one.length - 6);
  assert.equal(one.readUInt16LE(6) & 0x800, 0x800); assert.equal(one.readUInt16LE(central + 8) & 0x800, 0x800);
  const index = zipIndex(zipFiles([{ name: 'noise.bin', data: noise }, { name: 'text', data: text }]));
  assert.equal(index.get('noise.bin').method, 0, 'random bytes are stored'); assert.equal(index.get('text').method, 8, 'text is deflated');
});

test('v049 collectRecords: records at every depth; Electron caches, logs, crash dumps and unfinished writes are left out', async t => {
  const { data } = await dataDir(t);
  assert.deepEqual((await collectRecords(data)).map(f => f.name), ['data/chats/c1.json', 'data/concepts/2026/概念.md', 'data/settings.json']);
  assert.deepEqual(await collectRecords(path.join(data, 'missing')), []);
});

test('v049 createBackup: one ZIP with records, code bundle and restore note; revealed; never replaces an earlier one', async t => {
  const { root, data } = await dataDir(t), revealed = [], bundled = [];
  const config = { dataDir: data, backup: { dir: path.join(root, '备份'), codeDir: 'D:\\repo' } };
  const at = new Date(2026, 10, 8, 15, 30, 5);
  const backup = createBackup(config, { version: '0.49.0', now: () => at, opener: async (file, options) => revealed.push([file, options]),
    bundle: async (repo, file) => { bundled.push(repo); await fs.writeFile(file, 'bundle-bytes'); } });
  const result = await backup.start();
  assert.equal(result.file, path.join(root, '备份', 'CO-AGENT 备份 2026-11-08 153005.zip'));
  assert.deepEqual({ records: result.records, code: result.code }, { records: 3, code: 'included' });
  assert.deepEqual(bundled, ['D:\\repo']); assert.deepEqual(revealed, [[result.file, { reveal: true, exists: true, target: 'backup' }]]);
  const buffer = await fs.readFile(result.file); assert.equal(result.size, buffer.length);
  const files = unzip(buffer);
  assert.deepEqual([...files.keys()], ['data/chats/c1.json', 'data/concepts/2026/概念.md', 'data/settings.json', 'code/CO-AGENT.bundle', '恢复说明.txt']);
  assert.equal(files.get('data/chats/c1.json').toString(), JSON.stringify({ title: '睡前要不要看书' }));
  assert.equal(files.get('code/CO-AGENT.bundle').toString(), 'bundle-bytes');
  const note = files.get('恢复说明.txt').toString('utf8');
  assert.match(note, /v0\.49\.0/); assert.ok(note.includes(data), 'the note says where the records go back');
  assert.match(note, /git clone "CO-AGENT\.bundle" "D:\\repo"/); assert.match(note, /先退出 CO-AGENT/);
  assert.equal((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('co-agent-backup-') && n.endsWith('.bundle')).length, 0, 'the temporary bundle is removed');
  await assert.rejects(backup.start(), error => error.status === 409 && /已存在/.test(error.message));
  assert.equal((await fs.readFile(result.file)).equals(buffer), true, 'the earlier backup is untouched');
});

test('v049 createBackup: records are still backed up when git fails; one backup at a time; an empty data dir is refused', async t => {
  const { root, data } = await dataDir(t);
  let tick = 0, release;
  const config = { dataDir: data, backup: { dir: path.join(root, 'out'), codeDir: 'D:\\repo' } };
  const failing = createBackup(config, { now: () => new Date(2026, 10, 8, 10, 0, tick++), bundle: async () => { throw new Error('找不到 git'); } });
  const result = await failing.start();
  assert.equal(result.code, '代码打包失败：找不到 git');
  const files = unzip(await fs.readFile(result.file));
  assert.equal(files.has('code/CO-AGENT.bundle'), false); assert.match(files.get('恢复说明.txt').toString(), /代码未备份：代码打包失败：找不到 git/);

  const slow = createBackup(config, { now: () => new Date(2026, 10, 8, 11, 0, tick++), bundle: () => new Promise(resolve => { release = resolve; }) });
  const first = slow.start();
  // Wait until the backup really is at its git step; a fixed 20 ms was not always enough (v0.53 export run).
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(slow.running, true);
  await assert.rejects(slow.start(), error => error.status === 409 && /正在备份/.test(error.message));
  release(); await first; assert.equal(slow.running, false);

  const empty = createBackup({ dataDir: path.join(root, 'nothing'), backup: config.backup }, { bundle: async () => {} });
  await assert.rejects(empty.start(), error => error.status === 409);
});

test('v049 createGitBundle: a real bundle of a small repository verifies and clones', async t => {
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) { t.skip('git is not installed'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), git = (...args) => spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  await put(path.join(repo, 'a.txt'), 'hello');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'one'], ['tag', 'v1']])
    assert.equal(git(...args).status, 0);
  const file = path.join(root, 'out.bundle');
  await createGitBundle(repo, file);
  assert.equal(git('bundle', 'verify', file).status, 0);
  const clone = spawnSync('git', ['clone', '-q', file, path.join(root, 'clone')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  assert.equal(await fs.readFile(path.join(root, 'clone', 'a.txt'), 'utf8'), 'hello');
  await assert.rejects(createGitBundle(path.join(root, 'not-a-repo'), path.join(root, 'x.bundle')));
});

test('v049 config: backup defaults outside the data dir; a folder inside the data dir or repo is refused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { CO_AGENT_DATA_DIR: root };
  const config = await loadConfig({ env, home: root });
  // v0.50: Documents by default and no code unless a code folder is configured.
  assert.deepEqual(config.backup, { dir: path.join(root, 'Documents', 'CO-AGENT 备份'), codeDir: null });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ backup: { dir: 'E:\\网盘\\CO-AGENT' } }));
  assert.equal((await loadConfig({ env, home: root })).backup.dir, 'E:\\网盘\\CO-AGENT');
  for (const backup of [{ dir: path.join(root, 'backups') }, { dir: path.join(projectRoot, 'backups') }, { dir: 'backups' }, { codeDir: '' }, []]) {
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ backup }));
    await assert.rejects(loadConfig({ env, home: root }), /backup/);
  }
});

test('v049 POST /api/backup needs the token and returns the written file', async t => {
  let app;
  t.after(() => app?.close());
  const { config } = await fixture(t);
  await put(path.join(config.dataDir, 'pins.json'), '{"ids":[]}');
  const revealed = [];
  app = await createApp(config, { opener: async file => revealed.push(file), conceptAutoDaily: false, backupOptions: { bundle: async (repo, file) => fs.writeFile(file, 'b') } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/backup`, { method: 'POST' })).status, 403);
  const response = await fetch(`${base}/api/backup`, { method: 'POST', headers: { 'X-Co-Agent-Token': app.token } });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(path.dirname(result.file), config.backup.dir); assert.equal(result.code, 'included'); assert.ok(result.records >= 1);
  assert.deepEqual(revealed, [result.file]);
  assert.ok(unzip(await fs.readFile(result.file)).has('data/pins.json'));
});

test('v049 settings: 立即备份 posts once, shows where the ZIP went, and reports a failure', async t => {
  const { doc } = await appDocument('threepane'), posts = [];
  let reply = { ok: true, value: { file: 'D:\\work\\CO-AGENT 备份\\CO-AGENT 备份 2026-11-08 153005.zip', size: 3355443, records: 412, code: 'included' } };
  const front = await mountApp(doc, async (url, opts = {}) => {
    if (url === '/api/backup') { posts.push(opts); return { ok: reply.ok, status: reply.ok ? 200 : 409, json: async () => reply.value }; }
    const value = url === '/api/registry' ? { agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui: 'threepane', recommend: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose());
  const button = doc.getElementById('settings-backup'), status = doc.getElementById('settings-backup-status');
  assert.equal(button.textContent, '立即备份');
  await button.fire('click');
  assert.equal(posts.length, 1); assert.equal(posts[0].method, 'POST'); assert.match(posts[0].headers['X-Co-Agent-Token'], /\S/);
  assert.equal(status.textContent, '已备份到 D:\\work\\CO-AGENT 备份\\CO-AGENT 备份 2026-11-08 153005.zip（412 个记录文件，3.2 MB），资源管理器已选中它。');
  assert.equal(button.disabled, false);
  reply = { ok: true, value: { ...reply.value, size: 2048, code: '代码打包失败：找不到 git' } };
  await button.fire('click');
  assert.match(status.textContent, /2 KB）.*代码打包失败：找不到 git，这次只有记录。$/);
  reply = { ok: false, value: { error: '正在备份，请等这一次完成' } };
  await button.fire('click');
  assert.equal(status.textContent, '备份失败：正在备份，请等这一次完成');
});
