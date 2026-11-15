// v0.53: a temporary code bundle that cannot be removed never costs the records backup. Where the bundle failed, the
// temporary path is turned into a non-empty directory, which a non-recursive fs.rm refuses with a real error
// (ERR_FS_EISDIR, not retried). A bundle that was read but cannot be removed has no such real condition on every
// system, so that case injects `remove`. Logging is best effort: a log that throws or rejects never fails a written
// backup. No test here starts a real git or taskkill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackup } from '../src/backup.mjs';
import { zipIndex, readEntry } from '../src/books/epub.mjs';
import { put } from './fixtures/helpers.mjs';

const unzip = buffer => { const index = zipIndex(buffer); return new Map([...index].map(([name, entry]) => [name, readEntry(buffer, entry)])); };
const LEFTOVER = /^备份：临时代码包未能删除，请手动删除 /;

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-backup-temp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await put(path.join(data, 'settings.json'), '{}');
  // The leftovers sit in the OS temp folder under the names createBackup chose; they are removed when the test ends.
  const temps = [];
  t.after(() => Promise.all(temps.map(file => fs.rm(file, { recursive: true, force: true }))));
  let tick = 0;
  return { temps, config: { dataDir: data, backup: { dir: path.join(root, 'out'), codeDir: path.join(root, 'repo') } },
    now: () => new Date(2026, 10, 8, 12, 0, tick++) };
}
// A non-empty directory where the temporary file should be.
async function blockTemp(temps, file) {
  temps.push(file);
  await fs.mkdir(file);
  await fs.writeFile(path.join(file, 'held'), 'x');
}

test('v0.53 createBackup: a timed-out bundle whose temporary file cannot be removed still writes the records and logs the leftover', async t => {
  const { temps, config, now } = await setup(t), logged = [];
  const result = await createBackup(config, { now, log: async message => { logged.push(message); },
    bundle: async (repo, file) => { await blockTemp(temps, file); throw new Error('git bundle 超时'); } }).start();
  assert.equal(result.code, '代码打包失败：git bundle 超时');
  const files = unzip(await fs.readFile(result.file));
  assert.ok(files.has('data/settings.json')); assert.equal(files.has('code/CO-AGENT.bundle'), false);
  assert.match(files.get('恢复说明.txt').toString(), /代码未备份：代码打包失败：git bundle 超时/);
  assert.equal(path.dirname(temps[0]), os.tmpdir());
  assert.ok((await fs.stat(temps[0])).isDirectory(), 'the temporary path really could not be removed');
  const leftover = logged.filter(message => LEFTOVER.test(message));
  assert.equal(leftover.length, 1); assert.ok(leftover[0].includes(temps[0]), 'the log names the file to delete by hand');
  assert.deepEqual(logged.filter(message => !LEFTOVER.test(message)), [`备份：${result.file}，1 个记录文件，${result.size} 字节；代码打包失败：git bundle 超时`]);
});

test('v0.53 createBackup: a bundle that was read but cannot be removed is still in the ZIP, and the leftover is logged', async t => {
  const { temps, config, now } = await setup(t), logged = [], removed = [];
  const result = await createBackup(config, { now, log: async message => { logged.push(message); },
    bundle: async (repo, file) => { temps.push(file); await fs.writeFile(file, 'bundle-bytes'); },
    remove: async file => { removed.push(file); throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } }).start();
  assert.equal(result.code, 'included');
  assert.deepEqual(removed, temps);
  const files = unzip(await fs.readFile(result.file));
  assert.equal(files.get('code/CO-AGENT.bundle').toString(), 'bundle-bytes');
  assert.match(files.get('恢复说明.txt').toString(), /git clone "CO-AGENT\.bundle"/);
  assert.deepEqual(logged, [`备份：临时代码包未能删除，请手动删除 ${temps[0]}：EBUSY: resource busy or locked`,
    `备份：${result.file}，1 个记录文件，${result.size} 字节`]);
});

const FAILING_LOGS = [() => { throw new Error('日志写入失败'); }, async () => { throw new Error('日志写入失败'); }];

test('v0.53 createBackup: a log that throws or rejects about the leftover does not fail the backup', async t => {
  const { temps, config, now } = await setup(t);
  // Every message fails here, the leftover and the backup's own line after the ZIP is written: both are best effort.
  for (const failing of FAILING_LOGS) {
    const attempted = [], revealed = [];
    const log = message => { attempted.push(message); return failing(); };
    const result = await createBackup(config, { now, log, opener: async file => { revealed.push(file); },
      bundle: async (repo, file) => { await blockTemp(temps, file); throw new Error('git bundle 超时'); } }).start();
    assert.equal(result.code, '代码打包失败：git bundle 超时');
    assert.ok(unzip(await fs.readFile(result.file)).has('data/settings.json'));
    assert.equal(attempted.length, 2); assert.match(attempted[0], LEFTOVER);
    assert.equal(attempted[1], `备份：${result.file}，1 个记录文件，${result.size} 字节；代码打包失败：git bundle 超时`);
    assert.deepEqual(revealed, [result.file]);
  }
  assert.equal(temps.length, 2);
});

test('v0.53 createBackup: a log that throws or rejects after the ZIP is written does not fail the backup', async t => {
  const { temps, config, now } = await setup(t);
  for (const failing of FAILING_LOGS) {
    const attempted = [], revealed = [];
    const log = message => { attempted.push(message); return failing(); };
    const result = await createBackup(config, { now, log, opener: async (file, options) => { revealed.push([file, options]); },
      bundle: async (repo, file) => { temps.push(file); await fs.writeFile(file, 'bundle-bytes'); } }).start();
    assert.deepEqual(Object.keys(result), ['file', 'size', 'records', 'code']);
    assert.equal(result.records, 1); assert.equal(result.code, 'included');
    const archive = await fs.readFile(result.file), files = unzip(archive);
    assert.equal(result.size, archive.length);
    assert.equal(files.get('data/settings.json').toString(), '{}');
    assert.equal(files.get('code/CO-AGENT.bundle').toString(), 'bundle-bytes');
    assert.deepEqual(attempted, [`备份：${result.file}，1 个记录文件，${result.size} 字节`]);
    // The step after the log still runs: the written backup is revealed.
    assert.deepEqual(revealed, [[result.file, { reveal: true, exists: true, target: 'backup' }]]);
  }
});

test('v0.53 createBackup: the normal path removes the temporary bundle and logs nothing about a leftover', async t => {
  const { temps, config, now } = await setup(t), logged = [];
  const result = await createBackup(config, { now, log: async message => { logged.push(message); },
    bundle: async (repo, file) => { temps.push(file); await fs.writeFile(file, 'bundle-bytes'); } }).start();
  assert.equal(result.code, 'included');
  await assert.rejects(fs.stat(temps[0]), { code: 'ENOENT' });
  assert.deepEqual(logged, [`备份：${result.file}，1 个记录文件，${result.size} 字节`]);

  // A bundle that fails before writing anything leaves nothing to remove; force: true keeps that quiet.
  logged.length = 0;
  const failed = await createBackup(config, { now, log: async message => { logged.push(message); },
    bundle: async (repo, file) => { temps.push(file); throw new Error('找不到 git'); } }).start();
  assert.equal(failed.code, '代码打包失败：找不到 git');
  await assert.rejects(fs.stat(temps[1]), { code: 'ENOENT' });
  assert.deepEqual(logged, [`备份：${failed.file}，1 个记录文件，${failed.size} 字节；代码打包失败：找不到 git`]);
});
