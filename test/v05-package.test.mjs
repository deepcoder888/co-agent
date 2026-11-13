import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, put } from './fixtures/helpers.mjs';
import { packageApp, included, archiveName } from '../scripts/package.mjs';
import { readSubsystem } from '../scripts/check-gui-subsystem.mjs';

function pe(subsystem = 2, magic = 0x20b) {
  const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64); bytes.writeUInt16LE(112, 64 + 20); bytes.writeUInt16LE(magic, 88);
  bytes.writeUInt16LE(subsystem, 88 + 68); return bytes;
}
test('L2 PE parser reads GUI/CUI PE32/PE32+ and rejects malformed/truncated headers', () => {
  for (const magic of [0x10b, 0x20b]) for (const subsystem of [2, 3]) assert.equal(readSubsystem(pe(subsystem, magic)), subsystem);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(64), pe().subarray(0, 100), pe(2, 0)]) assert.throws(() => readSubsystem(bytes));
  const bad = pe(); bad.writeUInt16LE(2, 84); assert.throws(() => readSubsystem(bad));
});
test('L2 allowlist includes ancestors and runtime files, excludes source control/tests/modules/docs/VBS', () => {
  for (const file of ['', '/', '/package.json', '/electron', '/electron/main.cjs', '/src/a.mjs', '/public/brand/x.svg', '/launcher', '/launcher/launch.ps1', '/assets', '/assets/brand', '/assets/brand/co-agent.ico', '\\src\\config.mjs']) assert.equal(included(file), true, file);
  // v0.51: Agent lists are never packaged: data/ is gone and profile/ is the user's own.
  for (const file of ['/data/task-contracts.json', '/profile', '/profile/roles.json', '/package-lock.json', '/node_modules', '/.git/config', '/.claude', '/test', '/docs', '/release', '/scripts', '/launcher/co-agent.vbs.template', '/assets/brand/co-agent-icon.svg', '/assets/other', '/src-other/a', '/launcher/launch.ps1.bak']) assert.equal(included(file), false, file);
});
async function setup(t) {
  const { root } = await fixture(t), repo = path.join(root, 'repo'), cache = path.join(root, 'cache');
  const archive = Buffer.from('fake verified zip'), hash = createHash('sha256').update(archive).digest('hex');
  await put(path.join(cache, 'hash', archiveName), archive);
  await put(path.join(repo, 'node_modules/electron/checksums.json'), JSON.stringify({ [archiveName]: hash }));
  let calls = 0, options;
  const packager = async opts => {
    calls++; options = opts;
    const out = path.join(repo, 'release/CO-AGENT-win32-x64');
    await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'CO-AGENT.exe'), pe());
    for (const file of ['src/server.mjs', 'src/catalog.mjs', 'launcher/launch.ps1', 'public/index.html']) await put(path.join(out, 'resources/app', file), 'fixture');
    return [out];
  };
  return { repo, cache, hash, packager, get calls() { return calls; }, get options() { return options; } };
}
test('L2 verified cache child/root/override builds offline with exact options and evidence', async t => {
  const s = await setup(t);
  const evidence = await packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: s.cache }, packager: s.packager });
  const o = s.options;
  assert.equal(s.calls, 1); assert.equal(o.electronZipDir, path.join(s.cache, 'hash'));
  assert.equal(o.dir, s.repo); assert.equal(o.out, path.join(s.repo, 'release')); assert.equal(o.name, 'CO-AGENT');
  assert.equal(o.platform, 'win32'); assert.equal(o.arch, 'x64'); assert.equal(o.electronVersion, '44.10.2');
  assert.equal(o.icon, path.join(s.repo, 'assets/brand/co-agent.ico')); assert.equal(o.asar, false); assert.equal(o.prune, false); assert.equal(o.overwrite, true);
  assert.deepEqual(o.win32metadata, { CompanyName: 'CO-AGENT', FileDescription: 'CO-AGENT', ProductName: 'CO-AGENT' });
  assert.equal(o.ignore('/test/a'), true); assert.equal(o.ignore('/src/a'), false); assert.ok(!Object.hasOwn(o, 'download'));
  assert.deepEqual(o.sanitizePackageJson[0]({ scripts: { package: 'bad' }, devDependencies: { electron: 'x' }, main: 'electron/main.cjs', version: '0.5.0' }), { main: 'electron/main.cjs', version: '0.5.0' });
  assert.equal(evidence.zipHash, s.hash); assert.equal(evidence.subsystem, 2); assert.equal(evidence.electronVersion, '44.10.2');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.repo, '.tmp/package-v0.5.json'))), evidence);
  await fs.rename(path.join(s.cache, 'hash', archiveName), path.join(s.cache, archiveName));
  await packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: s.cache }, packager: s.packager }); assert.equal(s.options.electronZipDir, s.cache);
  await packageApp({ root: s.repo, env: { LOCALAPPDATA: path.join(s.cache, '..') }, packager: s.packager }).then(() => assert.fail('missing default cache')).catch(e => assert.match(e.message, /离线 Electron 包缺失，未尝试下载/));
});
test('L2 missing cache/zip/deeper zip, mismatch/missing checksum refuse packager and downloads', async t => {
  const s = await setup(t);
  await fs.mkdir(path.join(s.cache, 'hash/deeper')); await fs.rename(path.join(s.cache, 'hash', archiveName), path.join(s.cache, 'hash/deeper', archiveName));
  for (const cache of [s.cache, path.join(s.cache, 'absent')]) await assert.rejects(packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: cache }, packager: s.packager }), /离线 Electron 包缺失，未尝试下载/);
  await fs.rename(path.join(s.cache, 'hash/deeper', archiveName), path.join(s.cache, archiveName));
  await put(path.join(s.repo, 'node_modules/electron/checksums.json'), JSON.stringify({ [archiveName]: '0'.repeat(64) }));
  await assert.rejects(packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: s.cache }, packager: s.packager }), /SHA256/);
  await put(path.join(s.repo, 'node_modules/electron/checksums.json'), '{}');
  await assert.rejects(packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: s.cache }, packager: s.packager }), /SHA256/);
  assert.equal(s.calls, 0);
});
test('L2 postchecks reject CUI and missing required files without successful evidence', async t => {
  const s = await setup(t), out = path.join(s.repo, 'release/CO-AGENT-win32-x64');
  for (const fault of ['cui', 'missing']) {
    await assert.rejects(packageApp({ root: s.repo, env: { CO_AGENT_ELECTRON_ZIP_DIR: s.cache }, packager: async o => {
      const result = await s.packager(o);
      if (fault === 'cui') await fs.writeFile(path.join(out, 'CO-AGENT.exe'), pe(3));
      else await fs.rm(path.join(out, 'resources/app/launcher/launch.ps1'));
      return result;
    } }), fault === 'cui' ? /WINDOWS_GUI/ : /launch.ps1/);
    await assert.rejects(fs.access(path.join(s.repo, '.tmp/package-v0.5.json')));
  }
});
