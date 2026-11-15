// v0.49 备份 (2026-11-08): one click packs the user's records and the code history into a single ZIP in
// backup.dir. The user moves that file to the cloud drive by hand each month, so the ZIP must stand alone: the data
// directory itself is EFS-encrypted and the repository has no remote. Standard library only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killProcessTree } from './concepts/runner.mjs';

// Electron keeps its browser profile in the data dir too (app.setPath userData/sessionData). Those are caches and the
// window's own state, rebuilt on start, not the user's records; logs and crash dumps are diagnostics. Anything else,
// including record files added in later versions, is backed up.
export const SKIPPED_ENTRIES = new Set(['logs', 'crashes', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Local State', 'Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker', 'WebStorage',
  'Shared Dictionary', 'SharedStorage', 'SharedStorage-wal', 'blob_storage', 'Network', 'Preferences', 'DIPS', 'DIPS-wal', 'DIPS-journal',
  'Cookies', 'Cookies-journal', 'Trust Tokens', 'Trust Tokens-journal', 'TransportSecurity', 'Network Persistent State', 'VideoDecodeStats',
  'Partitions', 'Dictionaries', 'Crashpad', 'databases', 'QuotaManager', 'QuotaManager-journal', 'Platform Notifications', 'Origin Trials',
  'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal']);
const BUNDLE_NAME = 'code/CO-AGENT.bundle', NOTE_NAME = '恢复说明.txt';
const fail = (message, status = 500) => { throw Object.assign(new Error(message), { status }); };

// Every file under the data dir except the skipped top-level entries and unfinished atomic writes (*.tmp).
export async function collectRecords(dataDir) {
  const files = [];
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && SKIPPED_ENTRIES.has(entry.name)) continue;
      const file = path.join(dir, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        // A record deleted between listing and reading is simply not in this backup.
        try { const [data, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]); files.push({ name: `data/${name}`, data, mtime: stat.mtime }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await walk(dataDir, '');
  return files;
}

function dosTime(date) {
  const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
// A plain ZIP (no ZIP64) with UTF-8 names, so Explorer and any unzip tool open it. Deflated unless that is larger.
export function zipFiles(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data, mtime = new Date() } of files) {
    const nameBytes = Buffer.from(name, 'utf8'), packed = zlib.deflateRawSync(data), crc = zlib.crc32(data), { time, date } = dosTime(mtime);
    const [method, body] = packed.length < data.length ? [8, packed] : [0, data];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
    if (offset > 0xffffffff || files.length > 0xffff) fail('备份超过 4 GB 或 65535 个文件，无法写成普通 ZIP');
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// `git bundle create --all` holds every branch, tag and commit; it is restored with `git clone`. git is a console
// program, so windowsHide keeps its window from appearing.
export function createGitBundle(repo, file, { spawnImpl = spawn, timeoutMs = 120000, killTree = killProcessTree } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('git', ['-C', repo, 'bundle', 'create', file, '--all'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      ...(process.platform !== 'win32' ? { detached: true } : {}) });
    let stderr = '', settled = false, stopping = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    // v0.53: Git for Windows' git.exe on PATH starts the real git as a child, so a timeout ends the whole tree and settles
    // only then; otherwise the real git keeps writing the temporary bundle that createBackup is about to remove.
    const timer = setTimeout(async () => {
      stopping = true;
      let error = new Error('git bundle 超时');
      try {
        if (process.env.NODE_TEST_CONTEXT && killTree === killProcessTree) throw new Error('测试必须注入进程树终止替身');
        await killTree(child);
      } catch (e) { error = new Error(`${error.message}；终止进程树失败：${e.message}`); }
      finish(error);
    }, timeoutMs);
    child.stderr?.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.once('error', error => { if (!stopping) finish(new Error(error.code === 'ENOENT' ? '找不到 git' : error.message)); });
    child.once('exit', code => { if (!stopping) finish(code === 0 ? null : new Error(stderr.trim().split(/\r?\n/).pop() || `git 退出码 ${code}`)); });
  });
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const restoreNote = ({ at, version, dataDir, codeDir, code }) => [
  `CO-AGENT 备份 · ${at.toLocaleString('zh-CN', { hour12: false })} · v${version}`, '',
  `data/  ${dataDir} 中的记录：对话、会诊、圆桌、顾问团、每日概念、阅读进度、分组、自加的书和设置。`,
  '       不含 Electron 的缓存、日志和崩溃转储，它们会自动重建。',
  // v0.50: 'skipped' means no code folder is configured, so the note says nothing about code.
  ...(code === true ? [`${BUNDLE_NAME}  ${codeDir} 的全部分支、标签和提交（未提交的改动不在其中）。`] : code === 'skipped' ? [] : [`代码未备份：${code}`]), '',
  '恢复记录：先退出 CO-AGENT，把 data 文件夹里的内容复制到',
  `  ${dataDir}`, '  （同名文件会被替换），再启动 CO-AGENT。', '',
  ...(code === true ? ['恢复代码：', `  git clone "CO-AGENT.bundle" "${codeDir}"`, '  然后在该目录运行 npm ci（安装 electron 和 @electron/packager，需要联网），',
    '  再运行 npm run package 和 pwsh -File scripts/install.ps1。', ''] : [])].join('\r\n');

// v0.53: fs.rm retries EBUSY and EPERM with a linear backoff (100 + 200 + 300 ms), for a handle that git releases a
// moment after its process tree is ended. `remove` is replaceable only so a test can make a readable file unremovable.
const removeTemp = file => fs.rm(file, { force: true, maxRetries: 3, retryDelay: 100 });

export function createBackup(config, { version = '', opener, spawnImpl, killTree, now = () => new Date(), bundle = createGitBundle, log = async () => {},
  remove = removeTemp } = {}) {
  let running = null;
  async function run() {
    const at = now(), dir = config.backup.dir, codeDir = config.backup.codeDir;
    const files = await collectRecords(config.dataDir);
    if (!files.length) fail('数据目录里还没有记录可备份', 409);
    let code = codeDir ? true : 'skipped';
    if (codeDir) {
      const temp = path.join(os.tmpdir(), `co-agent-backup-${randomUUID()}.bundle`);
      try { await bundle(codeDir, temp, { spawnImpl, killTree }); files.push({ name: BUNDLE_NAME, data: await fs.readFile(temp), mtime: at }); }
      catch (error) { code = `代码打包失败：${error.message}`; }
      // v0.53: a temporary bundle that cannot be removed never costs the records backup; the log names it for deleting by hand.
      finally {
        try { await remove(temp); }
        catch (error) { try { await log(`备份：临时代码包未能删除，请手动删除 ${temp}：${error.message}`); } catch { /* the backup is written even if logging fails */ } }
      }
    }
    files.push({ name: NOTE_NAME, data: Buffer.from(`﻿${restoreNote({ at, version, dataDir: config.dataDir, codeDir, code })}`, 'utf8'), mtime: at });
    const archive = zipFiles(files), file = path.join(dir, `CO-AGENT 备份 ${stamp(at)}.zip`);
    await fs.mkdir(dir, { recursive: true });
    // Never replace an earlier backup.
    try { await fs.writeFile(file, archive, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') fail('同名备份已存在，请稍后再试', 409); throw error; }
    const records = files.filter(f => f.name.startsWith('data/')).length;
    await log(`备份：${file}，${records} 个记录文件，${archive.length} 字节${code === true || code === 'skipped' ? '' : `；${code}`}`);
    try { await opener?.(file, { reveal: true, exists: true, target: 'backup' }); } catch { /* the backup is written even if Explorer fails */ }
    return { file, size: archive.length, records, code: code === true ? 'included' : code };
  }
  return {
    get running() { return running !== null; },
    async start() {
      if (running) fail('正在备份，请等这一次完成', 409);
      running = run();
      try { return await running; } finally { running = null; }
    },
  };
}
