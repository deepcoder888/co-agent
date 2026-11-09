import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, put } from './fixtures/helpers.mjs';

async function packageFixture(root) {
  const from = path.join(root, '打包 来源'), app = path.join(from, 'resources/app');
  await fs.mkdir(app, { recursive: true });
  for (const dir of ['src', 'public']) await fs.cp(dir, path.join(app, dir), { recursive: true });
  await put(path.join(app, 'package.json'), JSON.stringify({ version: '0.5.0', type: 'module' }));
  for (const file of ['CO-AGENT.exe', 'chrome_elf.dll', 'locales/zh-CN.pak']) await put(path.join(from, file), 'fixture - never execute');
  return from;
}
// L3 takes about 13 s alone but 24–31 s in the full suite while Codex runs (2026-11-03), so 30 s was no margin.
function run(runner, env) {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    windowsHide: true, shell: false, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
  });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  return result;
}
test('L3 temporary install/update/uninstall: path-only process stops, marker guards, exe shortcuts, data preserved', async t => {
  const { root } = await fixture(t), from = await packageFixture(root), runner = path.join(root, 'test-install.ps1');
  await put(runner, String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
. (Join-Path $env:CO_TEST_REPO 'scripts/uninstall.ps1')
$install = Join-Path $env:CO_TEST_ROOT '安装 空格'
$desktop = Join-Path $env:CO_TEST_ROOT '桌面'
$menu = Join-Path $env:CO_TEST_ROOT '开始 菜单'
$runtime = Join-Path $env:CO_TEST_ROOT '运行 数据'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'keep.txt') -Value 'preserve'
$env:CO_AGENT_DATA_DIR = $runtime
$calls = [System.Collections.Generic.List[object]]::new()
$exe = Join-Path $install 'CO-AGENT.exe'
$deps = @{
  Health = { throw 'forbidden health probe' }
  Process = { throw 'forbidden PID query' }
  Processes = { @(
    @{ProcessId=1234;ExecutablePath=$exe.ToUpperInvariant();CommandLine='parent'},
    @{ProcessId=1235;ExecutablePath=$exe;CommandLine='--type=renderer'},
    @{ProcessId=1236;ExecutablePath=(Join-Path $install 'child/../CO-AGENT.exe');CommandLine='--type=gpu-process'},
    @{ProcessId=2001;ExecutablePath=(Join-Path ($install + '-other') 'CO-AGENT.exe');CommandLine='other app'},
    @{ProcessId=2002;ExecutablePath=(Join-Path ($install + '-other') 'electron.exe');CommandLine='Claude desktop'},
    @{ProcessId=2003;ExecutablePath=$null;CommandLine=$null},
    @{ProcessId=3001;ExecutablePath=$env:CO_TEST_NODE;CommandLine=('"node.exe" "' + (Join-Path $install 'src/server.mjs') + '"')},
    @{ProcessId=3002;ExecutablePath=$env:CO_TEST_NODE;CommandLine=('"node.exe" "' + (Join-Path ($install + '-other') 'src/server.mjs') + '"')},
    @{ProcessId=3003;ExecutablePath=(Join-Path $env:CO_TEST_ROOT 'electron.exe');CommandLine=('"electron.exe" "' + (Join-Path $install 'src/server.mjs') + '"')}
  ) }
  Stop = { param($processId) $calls.Add(@{stopped=$processId}) }
  WaitExit = { param($processIds,$seconds) $calls.Add(@{waited=$processIds;seconds=$seconds}) }
  Shortcut = { param($file,$target,$arguments,$icon,$working)
    $calls.Add(@{shortcut=$file;target=$target;arguments=$arguments;icon=$icon;working=$working})
    Set-Content -LiteralPath $file -Value 'fake shortcut'
  }
}
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Dependencies $deps -WhatIf
if ((Test-Path -LiteralPath $install) -or $calls.Count) { throw 'WhatIf changed state' }
New-Item -ItemType Directory -Path $install | Out-Null
Set-Content -LiteralPath (Join-Path $install 'keep.txt') -Value 'unowned'
foreach ($marker in @('absent', 'wrong')) {
  if ($marker -eq 'wrong') { @{app='CO-AGENT';installDir=($install + '-other')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install '.co-agent-install.json') }
  $blocked = $false
  try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps } catch { $blocked = $true }
  if (!$blocked -or $calls.Count -or !(Test-Path -LiteralPath (Join-Path $install 'keep.txt'))) { throw 'ownership guard failed' }
}
Remove-Item -LiteralPath (Join-Path $install 'keep.txt'),(Join-Path $install '.co-agent-install.json') -Force
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Dependencies $deps
Set-Content -LiteralPath (Join-Path $install 'co-agent.vbs') -Value 'legacy'
Set-Content -LiteralPath (Join-Path $install 'stale.txt') -Value 'stale'
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps
if ((Test-Path -LiteralPath (Join-Path $install 'co-agent.vbs')) -or (Test-Path -LiteralPath (Join-Path $install 'stale.txt'))) { throw 'stale files survived replacement' }
foreach ($target in @($env:CO_TEST_REPO, $runtime, $env:CO_TEST_FROM)) {
  $blocked = $false
  try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $target -NoShortcuts -Dependencies $deps } catch { $blocked = $true }
  if (!$blocked) { throw 'unsafe install target allowed' }
}
$blocked = $false
try { Install-CoAgent -From (Join-Path $env:CO_TEST_ROOT 'absent') -InstallDir $install -NoShortcuts -Dependencies $deps } catch { $blocked = $_.Exception.Message.Contains('npm run package') }
if (!$blocked) { throw 'missing package error unclear' }
$blocked = $false
try { Uninstall-CoAgent -InstallDir $install -DesktopDir $runtime -StartMenuDir $menu -Yes -Dependencies $deps } catch { $blocked = $true }
if (!$blocked) { throw 'runtime shortcut deletion allowed' }
$outside = Join-Path $env:CO_TEST_ROOT 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
Set-Content -LiteralPath (Join-Path $outside 'keep.txt') -Value 'outside'
New-Item -ItemType Junction -Path (Join-Path $install 'junction') -Target $outside | Out-Null
$blocked = $false
try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps } catch { $blocked = $true }
if (!$blocked -or !(Test-Path -LiteralPath (Join-Path $outside 'keep.txt'))) { throw 'junction protection failed' }
Remove-Item -LiteralPath (Join-Path $install 'junction') -Force
$tree = @(Get-ChildItem -LiteralPath $install -File -Recurse | ForEach-Object { $_.FullName.Substring($install.Length+1) })
Uninstall-CoAgent -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Yes -Dependencies $deps -WhatIf
if (!(Test-Path -LiteralPath $install)) { throw 'uninstall WhatIf mutated target' }
Uninstall-CoAgent -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Yes -Dependencies $deps
if (Test-Path -LiteralPath $install) { throw 'uninstall failed' }
if ((Get-Content -LiteralPath (Join-Path $runtime 'keep.txt')).Trim() -ne 'preserve') { throw 'runtime data removed' }
if (Test-Path -LiteralPath (Join-Path $desktop 'CO-AGENT.lnk')) { throw 'shortcut remains' }
@{tree=$tree;calls=@($calls.ToArray());dataPreserved=$true;installRemoved=$true} | ConvertTo-Json -Depth 8
`);
  const result = run(runner, { CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root, CO_TEST_FROM: from, CO_TEST_NODE: process.execPath });
  const value = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n{') + 1));
  for (const file of ['CO-AGENT.exe', 'resources\\app\\src\\server.mjs', 'locales\\zh-CN.pak', 'chrome_elf.dll']) assert.ok(value.tree.includes(file), file);
  assert.ok(!value.tree.some(s => /co-agent\.vbs|test\\|docs\\|\.git/.test(s)));
  assert.deepEqual(value.calls.filter(c => c.stopped).map(c => c.stopped), [1234,1235,1236,3001,1234,1235,1236,3001,1234,1235,1236,3001]);
  assert.deepEqual(value.calls.filter(c => c.waited).map(c => [c.waited, c.seconds]), Array(3).fill([[1234,1235,1236,3001], 15]));
  // Every stop round waits before the next round (and before cleanup) starts.
  assert.deepEqual(value.calls.filter(c => c.stopped || c.waited).map(c => c.waited ? 'wait' : 'stop'), Array(3).fill(['stop','stop','stop','stop','wait']).flat());
  const shortcuts = value.calls.filter(c => c.shortcut); assert.equal(shortcuts.length, 2);
  for (const shortcut of shortcuts) {
    assert.equal(shortcut.target, path.join(root, '安装 空格/CO-AGENT.exe')); assert.equal(shortcut.arguments, '');
    assert.equal(shortcut.icon, shortcut.target); assert.equal(shortcut.working, path.join(root, '安装 空格'));
  }
  assert.equal(value.dataPreserved, true); assert.equal(value.installRemoved, true);
  if (process.env.CO_AGENT_V05_EVIDENCE) await fs.writeFile(process.env.CO_AGENT_V05_EVIDENCE, JSON.stringify(value, null, 2));
});
test('L3 install and uninstall wait for stopped processes and keep the marker when cleanup fails', async t => {
  const { root } = await fixture(t), from = await packageFixture(root), runner = path.join(root, 'wait-marker.ps1');
  await put(runner, String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
. (Join-Path $env:CO_TEST_REPO 'scripts/uninstall.ps1')
$install = Join-Path $env:CO_TEST_ROOT '安装 锁定'
$env:CO_AGENT_DATA_DIR = Join-Path $env:CO_TEST_ROOT '运行 数据'
$marker = Join-Path $install '.co-agent-install.json'
$events = [System.Collections.Generic.List[string]]::new()
$deps = @{
  Health = { throw 'forbidden health probe' }
  Processes = { @(@{ProcessId=4242;ExecutablePath=(Join-Path $install 'CO-AGENT.exe');CommandLine='parent'}) }
  Stop = { param($processId) $events.Add("stop:$processId") }
  WaitExit = { param($processIds,$seconds) $events.Add("wait:$($processIds -join ',')/$seconds") }
  # This test deliberately holds a real lock; bounded retries have separate v043 coverage.
  RemoveTimeoutMs = 0
}
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps
Set-Content -LiteralPath (Join-Path $install 'stale.txt') -Value 'stale'
# A process that never exits: the wait times out and nothing is deleted.
$deps.WaitExit = { param($processIds,$seconds) $events.Add('timeout'); throw 'wait timed out' }
$timedOut = $false
try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps } catch { $timedOut = $_.Exception.Message -eq 'wait timed out' }
if (!$timedOut -or !(Test-Path -LiteralPath $marker) -or !(Test-Path -LiteralPath (Join-Path $install 'stale.txt'))) { throw 'timeout did not abort before cleanup' }
# A still-locked CO-AGENT.exe (the 2026-10-11 failure): cleanup throws, the marker survives, a retry succeeds.
$deps.WaitExit = { param($processIds,$seconds) $events.Add('wait') }
$lock = [IO.File]::Open((Join-Path $install 'CO-AGENT.exe'), 'Open', 'Read', 'None')
$failed = $false
try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps } catch { $failed = $true }
$lock.Dispose()
if (!$failed) { throw 'locked file did not fail cleanup' }
$markerKept = Test-Path -LiteralPath $marker -PathType Leaf
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps
$record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
# Uninstall with a still-locked file: the marker is removed last, so the retry passes the ownership check.
$lock = [IO.File]::Open((Join-Path $install 'CO-AGENT.exe'), 'Open', 'Read', 'None')
$uninstallFailed = $false
try { Uninstall-CoAgent -InstallDir $install -NoShortcuts -Yes -Dependencies $deps } catch { $uninstallFailed = $true }
$lock.Dispose()
$uninstallMarkerKept = Test-Path -LiteralPath $marker -PathType Leaf
Uninstall-CoAgent -InstallDir $install -NoShortcuts -Yes -Dependencies $deps
# The real wait: an absent PID returns at once; a live process that outlives the timeout throws.
$real = (Get-CoDependencies @{}).WaitExit
& $real @(2147483000) 1
$realTimeout = $false
try { & $real @($PID) 1 } catch { $realTimeout = $_.Exception.Message.Contains("$PID") }
@{events=@($events.ToArray());markerKept=$markerKept;retryMarker=$record.installDir;staleGone=!(Test-Path -LiteralPath (Join-Path $install 'stale.txt'));realTimeout=$realTimeout;uninstallFailed=$uninstallFailed;uninstallMarkerKept=$uninstallMarkerKept;uninstalled=!(Test-Path -LiteralPath $install)} | ConvertTo-Json -Depth 4
`);
  const result = run(runner, { CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root, CO_TEST_FROM: from });
  const value = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n{') + 1));
  assert.deepEqual(value.events, ['stop:4242', 'wait:4242/15', 'stop:4242', 'timeout', 'stop:4242', 'wait', 'stop:4242', 'wait', 'stop:4242', 'wait', 'stop:4242', 'wait']);
  assert.equal(value.markerKept, true);
  assert.equal(value.retryMarker, path.join(root, '安装 锁定'));
  assert.equal(value.staleGone, true);
  assert.equal(value.realTimeout, true);
  assert.equal(value.uninstallFailed, true); assert.equal(value.uninstallMarkerKept, true); assert.equal(value.uninstalled, true);
});
test('L3 source prohibits name-wide termination/eval/file association; legacy VBS removed', async () => {
  const text = (await Promise.all(['scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/install-common.ps1'].map(file => fs.readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(text, /Invoke-Expression|Stop-Process\s+-Name|Invoke-Item|wscript\.exe/i);
  assert.match(text, /Get-CimInstance Win32_Process/); assert.match(text, /ExecutablePath/);
  await assert.rejects(fs.access('launcher/co-agent.vbs.template'));
});
test('L3 installed config keeps D10/D11 launch workspace and project Claude definitions', async t => {
  const { root } = await fixture(t), from = await packageFixture(root), install = path.join(root, '安装 app'), runtime = path.join(root, '运行 data');
  const runner = path.join(root, 'installed-config.ps1');
  await put(runner, String.raw`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $env:CO_TEST_INSTALL -NoShortcuts -Dependencies @{ Processes = { @() }; Health = { throw 'forbidden' } }
`);
  run(runner, { CO_AGENT_DATA_DIR: runtime, CO_TEST_REPO: process.cwd(), CO_TEST_INSTALL: install, CO_TEST_FROM: from });
  const installed = await import(pathToFileURL(path.join(install, 'resources/app/src/config.mjs')).href);
  const config = await installed.loadConfig({ env: { CO_AGENT_DATA_DIR: runtime } });
  // v0.50: never the install folder. Without config.json the launch folder is <data>/workspace; D10/D11's repository
  // binding is now the launchProject a configured install sets in config.json.
  assert.equal(config.launchProject, path.join(runtime, 'workspace')); assert.ok(config.claudeAgentDirs.includes(path.join(runtime, 'workspace', '.claude', 'agents')));
  assert.ok(!config.claudeAgentDirs.includes(path.join(install, '.claude/agents')));
  await put(path.join(runtime, 'config.json'), JSON.stringify({ launchProject: process.cwd() }));
  const configured = await installed.loadConfig({ env: { CO_AGENT_DATA_DIR: runtime } });
  assert.equal(configured.launchProject, process.cwd()); assert.ok(configured.claudeAgentDirs.includes(path.join(process.cwd(), '.claude/agents')));
});
