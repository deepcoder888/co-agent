// v0.53: a CLI installed with npm leaves only shims on PATH. CO-AGENT reads the npm cmd-shim and starts what it runs,
// always with an argv array and shell:false; any other script entry stays refused with a message that says what to do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { resolveCli, resolveExecutable, createLaunch } from '../src/launch/spec.mjs';
import { runJsonProcess } from '../src/concepts/runner.mjs';
import { createBasicConfig } from '../src/basic-config.mjs';
import { fixture, fakeSpawner, put } from './fixtures/helpers.mjs';

const windows = process.platform === 'win32';
// The shims npm 10 writes for a package whose bin is a .js file (cmd-shim), and for one whose bin is an .exe.
const nodeShim = (entry) => ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`, ''].join('\r\n');
const exeShim = (entry) => `@"%dp0%\\${entry}"   %*\r\n`;
const shEntry = '#!/bin/sh\nexec node "$basedir/node_modules/walvo-cli/bin/walvo.js" "$@"\n';

async function npmBin(root, { localNode = false } = {}) {
  const bin = path.join(root, 'npm-bin');
  const entry = path.join(bin, 'node_modules', 'walvo-cli', 'bin', 'walvo.js');
  await put(entry, 'console.log("walvo")\n');
  await put(path.join(bin, 'codex.cmd'), nodeShim('node_modules\\walvo-cli\\bin\\walvo.js'));
  await put(path.join(bin, 'codex'), shEntry);
  await put(path.join(bin, 'codex.ps1'), '& node "$basedir/node_modules/walvo-cli/bin/walvo.js" $args\n');
  if (localNode) await put(path.join(bin, 'node.exe'), '');
  return { bin, entry, env: { PATH: [bin, path.dirname(process.execPath)].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
}

test('v0.53 npm shim: codex.cmd resolves to node.exe running the package entry, never the sh shim', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const { bin, entry, env } = await npmBin(root);
  assert.deepEqual(await resolveCli('codex', env), { file: path.join(bin, 'codex.CMD'), exe: process.execPath, prefix: [entry] });
  // The shim's own node.exe comes first, as in the shim itself.
  await put(path.join(bin, 'node.exe'), '');
  assert.deepEqual(await resolveCli('codex', env), { file: path.join(bin, 'codex.CMD'), exe: path.join(bin, 'node.exe'), prefix: [entry] });
  // A native program needs no prefix; the old string resolver still refuses scripts for pwsh, wt and git.
  assert.deepEqual(await resolveCli(process.execPath, env), { file: process.execPath, exe: process.execPath, prefix: [] });
  await assert.rejects(resolveExecutable('codex', env), /codex\.cmd 是脚本入口/i);
});

test('v0.53 npm shim: a bin that is an .exe starts that .exe directly', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const bin = path.join(root, 'npm-bin'), exe = path.join(bin, 'node_modules', 'jadra-cli', 'bin', 'claude.exe');
  await put(exe, ''); await put(path.join(bin, 'claude.cmd'), exeShim('node_modules\\jadra-cli\\bin\\claude.exe'));
  assert.deepEqual(await resolveCli('claude', { PATH: bin, PATHEXT: '.EXE;.CMD' }), { file: path.join(bin, 'claude.CMD'), exe, prefix: [] });
});

test('v0.53 npm shim: other scripts stay refused and say what to do; a lone sh shim is not a program', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const dir = path.join(root, 'scripts'), env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  await put(path.join(dir, 'codex.cmd'), '@echo off\r\ncall "%~dp0\\run.bat" %*\r\n');
  await assert.rejects(resolveCli('codex', env), error => error.unsafeScript && /codex\.cmd 是脚本入口/i.test(error.message) && /config\.json/.test(error.message));
  // A shim whose target is missing, or not a .js/.exe, is not run either.
  await put(path.join(dir, 'gone.cmd'), nodeShim('node_modules\\gone\\bin\\gone.js'));
  await assert.rejects(resolveCli('gone', env), { unsafeScript: true });
  await put(path.join(dir, 'other.cmd'), nodeShim('node_modules\\other\\bin\\other.sh')); await put(path.join(dir, 'node_modules', 'other', 'bin', 'other.sh'), '');
  await assert.rejects(resolveCli('other', env), { unsafeScript: true });
  await put(path.join(dir, 'only.ps1'), 'Write-Host hi\n');
  await assert.rejects(resolveCli(path.join(dir, 'only.ps1'), env), { unsafeScript: true });
  await put(path.join(dir, 'shonly'), shEntry);
  await assert.rejects(resolveCli('shonly', env), { executableMissing: true });
  // node.exe missing: the npm install is found but cannot run.
  const { env: npmEnv } = await npmBin(root);
  await assert.rejects(resolveCli('codex', { ...npmEnv, PATH: path.join(root, 'npm-bin') }), /需要 Node\.js/);
});

test('v0.53 npm shim: terminal launch writes node.exe plus the entry in exeArgs, CLI args unchanged', { skip: !windows }, async t => {
  const { root, config } = await fixture(t);
  const { entry, env } = await npmBin(root);
  const calls = [], agent = { name: 'helper', platforms: { codex: { available: true } } };
  const launch = await createLaunch(agent, 'codex', { ...config, codexExe: 'codex' }, { spawnImpl: fakeSpawner(calls), env });
  const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
  assert.equal(spec.exe, process.execPath);
  assert.deepEqual(spec.exeArgs, [entry]);
  assert.equal(spec.args[0], '--profile');
  assert.equal(calls[0].options.shell, false);
});

test('v0.53 npm shim: headless Codex runs start node.exe with the entry before the CLI arguments', { skip: !windows }, async t => {
  const { root, config } = await fixture(t);
  const { entry, env } = await npmBin(root);
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter(); child.pid = 4242;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('finish', async () => {
      await put(path.join(config.dataDir, 'npmcheck', 'work', 'one', 'out.json'), '{"ok":true}');
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const value = await runJsonProcess({ id: 'one', namespace: 'npmcheck', prompt: 'p', schema: { type: 'object' }, timeoutMs: 5000, label: '检查' },
    { ...config, codexExe: 'codex' }, { spawnImpl, env, killTree: async () => {} });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls[0].exe, process.execPath);
  assert.equal(calls[0].args[0], entry);
  assert.equal(calls[0].args[1], 'exec');
  assert.equal(calls[0].options.shell, false);
});

test('v0.53 npm shim: 基本配置 environment check reports an npm install as found', { skip: !windows }, async t => {
  const { root, config } = await fixture(t);
  const { bin, env } = await npmBin(root);
  const basic = createBasicConfig({ ...config, codexExe: 'codex', claudeExe: 'claude-absent' }, { env });
  const { environment } = await basic.describe();
  assert.equal(environment.codex, path.join(bin, 'codex.CMD'));
  assert.equal(environment.claude, null);
});

test('v0.53 launch.ps1 passes exeArgs before the CLI arguments, as separate argv items', { skip: !windows }, async t => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { shell: false, windowsHide: true });
  if (pwsh.status !== 0) { t.skip('pwsh is not installed'); return; }
  const { root } = await fixture(t);
  const script = path.join(root, 'echo.js'), out = path.join(root, 'argv.json'), spec = path.join(root, 'spec.json');
  await put(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)));\n`);
  await put(spec, JSON.stringify({ exe: process.execPath, exeArgs: [script], args: ['two words', '--flag', '中文 "quoted"'], cwd: root, title: 'check', pidFile: path.join(root, 'x.pid') }));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.resolve('launcher/launch.ps1'), '-SpecFile', spec], { shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), [script, 'two words', '--flag', '中文 "quoted"']);
  // A spec written before v0.53 has no exeArgs and still starts the program with only its own arguments.
  await put(spec, JSON.stringify({ exe: process.execPath, args: [script, 'one'], cwd: root, title: 'check', pidFile: path.join(root, 'x.pid') }));
  assert.equal(spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.resolve('launcher/launch.ps1'), '-SpecFile', spec], { shell: false, windowsHide: true }).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), [script, 'one']);
});
