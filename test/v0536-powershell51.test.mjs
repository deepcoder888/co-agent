// v0.53: people run `powershell -File scripts\install.ps1` or right-click → Run with PowerShell, which is Windows
// PowerShell 5.1. It reads a script without a BOM as ANSI, so the scripts carry a UTF-8 BOM and stop at once with one
// message that PowerShell 7 is needed and how to run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const scripts = ['scripts/install.ps1', 'scripts/install-common.ps1', 'scripts/uninstall.ps1', 'launcher/launch.ps1'];
const guarded = ['scripts/install.ps1', 'scripts/uninstall.ps1', 'launcher/launch.ps1'];

test('v0.53 PowerShell scripts start with a UTF-8 BOM and check the version before anything else', async () => {
  for (const file of scripts) assert.deepEqual([...(await fs.readFile(file)).subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
  for (const file of guarded) {
    const text = await fs.readFile(file, 'utf8'), check = text.indexOf('if ($PSVersionTable.PSVersion.Major -lt 7)');
    assert.ok(check > 0, file);
    const before = text.slice(0, check).replace(/^﻿/, '').replace(/^\s*#.*$/gm, '');
    assert.match(before.trim(), /^(\[CmdletBinding[^\n]*\]\s*)?param\(/, `${file}: only the param block comes before the check`);
    assert.doesNotMatch(before, /Join-Path \$PSScriptRoot/, `${file}: 5.1 leaves $PSScriptRoot empty while parameters bind`);
    assert.match(text.slice(check), /^[\s\S]*?pwsh -File[\s\S]*?exit 1/);
  }
});

const windowsPowerShell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { shell: false, windowsHide: true }).status === 0;

test('v0.53 under Windows PowerShell 5.1 the scripts parse and stop with the PowerShell 7 message', { skip: !windowsPowerShell && 'Windows PowerShell 5.1 is not available' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-ps51-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of scripts) { await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true }); await fs.copyFile(file, path.join(root, file)); }
  const run = args => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const parse = run(['-Command', `foreach ($f in Get-ChildItem -LiteralPath '${root}' -Recurse -Filter *.ps1) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$e); "$($f.Name)=$($e.Count)" }`]);
  assert.deepEqual(parse.stdout.trim().split(/\r?\n/).sort(), ['install-common.ps1=0', 'install.ps1=0', 'launch.ps1=0', 'uninstall.ps1=0']);
  for (const [file, args] of [['scripts/install.ps1', ['-InstallDir', path.join(root, 'app'), '-WhatIf']], ['scripts/uninstall.ps1', ['-InstallDir', path.join(root, 'app'), '-WhatIf']], ['launcher/launch.ps1', ['-SpecFile', path.join(root, 'none.json')]]]) {
    const result = run(['-File', path.join(root, file), ...args]);
    assert.equal(result.status, 1, `${file}: ${result.stderr}`);
    assert.match(result.stdout, /CO-AGENT needs PowerShell 7 \(pwsh\); this is Windows PowerShell 5\.1/);
    assert.ok(result.stdout.includes(`pwsh -File "${path.join(root, file)}"`), result.stdout);
    assert.equal(result.stderr.trim(), '', `${file}: no parse or runtime errors`);
  }
  await assert.rejects(fs.stat(path.join(root, 'app')), { code: 'ENOENT' });
});
