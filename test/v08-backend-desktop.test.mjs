import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fixture, put } from './fixtures/helpers.mjs';
import main from '../electron/main.cjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(config, { argv = ['app', '--daily-concept'], lock = true, daily = async () => ({ status: 'done' }), startError, dailyTimeoutMs } = {}) {
  const calls = [], windows = [], app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => lock, setPath() {}, setAppUserModelId() {}, commandLine: { appendSwitch() {} }, whenReady: async () => {}, quit: () => calls.push(['quit']), exit: code => calls.push(['exit', code]) });
  class BrowserWindow extends EventEmitter {
    constructor() { super(); calls.push(['window']); windows.push(this); this.fullScreen = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    isFullScreen() { return this.fullScreen; } setFullScreen(value) { calls.push(['fullscreen', value]); this.fullScreen = value; }
    isDestroyed() { return false; } isMinimized() { return false; } show() { calls.push(['show']); } focus() { calls.push(['focus']); } async loadURL() {}
  }
  const concepts = { ensureDaily: async () => { calls.push(['daily']); return daily(); }, close: async () => calls.push(['concept-close']) };
  const deps = { argv, dailyTimeoutMs, env: { CO_AGENT_DATA_DIR: config.dataDir },
    electron: { app, BrowserWindow, Menu: { setApplicationMenu() {} }, shell: {}, dialog: { showErrorBox: () => calls.push(['dialog']) },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    importConfig: async () => ({ loadConfig: async () => config }),
    importServer: async () => ({ startServer: async (_config, options) => {
      calls.push(['start', options]); if (startError) throw Error(startError);
      return { exitCode: 0, app: { server: { address: () => ({ port: 12345 }) }, concepts, close: async () => calls.push(['close']) } };
    } }), log: async message => calls.push(['log', message]),
  };
  return { app, calls, deps, windows };
}
for (const [status, exit] of [['done',0], ['exists',0], ['not-due',0], ['failed',1]]) test(`v08 headless ${status}: no windows/dialogs, waits and exits ${exit}`, async t => {
  const { config } = await fixture(t), h = harness(config, { daily: async () => ({ status }) });
  await main.createMain(h.deps).ready;
  assert.equal(h.calls.filter(c => c[0] === 'daily').length, 1); assert.ok(!h.calls.some(c => ['window','show','dialog'].includes(c[0])));
  assert.equal(h.calls.find(c => c[0] === 'start')[1].conceptAutoDaily, false);
  assert.deepEqual(h.calls.at(-1), ['exit', exit]); assert.ok(h.calls.some(c => c[0] === 'close'));
});
test('v08 headless lock loser exits 0 without server or window', async t => {
  const { config } = await fixture(t), h = harness(config, { lock: false }); await main.createMain(h.deps).ready;
  assert.deepEqual(h.calls, [['exit', 0]]);
});
test('v08 GUI second-instance daily flag never restores/shows/focuses', async t => {
  const { config } = await fixture(t), h = harness(config, { argv: ['app'] }), c = main.createMain(h.deps);
  await c.ready; const baseline = h.calls.length;
  h.app.emit('second-instance', {}, ['app', '--daily-concept']); await tick();
  assert.deepEqual(h.calls.slice(baseline).map(c => c[0]), ['daily']); await c.stop();
});
test('v08 headless normal second-instance creates a window while daily keeps running', async t => {
  const { config } = await fixture(t); let finish;
  const h = harness(config, { daily: () => new Promise(resolve => { finish = resolve; }) }), c = main.createMain(h.deps);
  while (!finish) await tick(); assert.ok(!h.calls.some(c => c[0] === 'window'));
  h.app.emit('second-instance', {}, ['app']);
  for (let i = 0; i < 500 && !h.calls.some(c => c[0] === 'window'); i++) await tick();
  assert.equal(h.calls.filter(c => c[0] === 'window').length, 1); assert.ok(!h.calls.some(c => c[0] === 'exit'));
  finish({ status: 'done' }); await c.ready;
  // The user opened the window during the run: finishing the daily run must not close it.
  assert.ok(!h.calls.some(c => c[0] === 'exit' || c[0] === 'quit' || c[0] === 'close'));
  assert.ok(h.calls.some(c => c[0] === 'log' && /转为普通运行/.test(c[1])));
  h.app.emit('window-all-closed');
  for (let i = 0; i < 500 && !h.calls.some(c => c[0] === 'quit'); i++) await tick();
  assert.ok(h.calls.some(c => c[0] === 'close')); assert.deepEqual(h.calls.at(-1), ['quit']);
});
test('v08 headless errors and 50-minute deadline are windowless nonzero exits', async t => {
  const { config } = await fixture(t);
  for (const opts of [{ startError: 'broken' }, { daily: () => new Promise(() => {}), dailyTimeoutMs: 15 }]) {
    const h = harness(config, opts); await main.createMain(h.deps).ready;
    assert.deepEqual(h.calls.at(-1), ['exit', 1]); assert.ok(!h.calls.some(c => ['window','dialog'].includes(c[0])));
  }
});

test('v08 scheduled-task wrapper uses exact settings and mocked registration/removal; install/uninstall supports WhatIf', async t => {
  const { root } = await fixture(t), runner = path.join(root, 'schedule.ps1'), from = path.join(root, 'package');
  for (const file of ['CO-AGENT.exe','resources/app/src/server.mjs','resources/app/package.json']) await put(path.join(from,file), 'fixture');
  await put(runner, String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
$calls=[Collections.Generic.List[object]]::new()
function New-ScheduledTaskAction { param($Execute,$Argument) @{execute=$Execute;argument=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$Daily,[switch]$Once,$At,$RepetitionInterval,$RepetitionDuration) @{daily=[bool]$Daily;at=$At;Repetition=if($Once){@{interval=$RepetitionInterval.TotalSeconds;duration=$RepetitionDuration.TotalSeconds}}else{$null}} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances) @{start=[bool]$StartWhenAvailable;battery=[bool]$AllowStartIfOnBatteries;keep=[bool]$DontStopIfGoingOnBatteries;limit=$ExecutionTimeLimit.TotalSeconds;multiple=$MultipleInstances} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) @{user=$UserId;logon=$LogonType;level=$RunLevel} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Principal,[switch]$Force) $calls.Add(@{op='register';name=$TaskName;action=$Action;trigger=$Trigger;settings=$Settings;principal=$Principal;force=[bool]$Force}) }
function Get-ScheduledTask { param($TaskName,$ErrorAction) @{TaskName='CO-AGENT 每日概念'} }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) $calls.Add(@{op='remove';name=$TaskName}) }
$install=Join-Path $env:CO_TEST_ROOT 'app'
$desktop=Join-Path $env:CO_TEST_ROOT 'desktop'
$menu=Join-Path $env:CO_TEST_ROOT 'menu'
New-Item -ItemType Directory -Path $desktop,$menu -Force|Out-Null
Set-Content -LiteralPath (Join-Path $desktop 'CO-AGENT.lnk') -Value 'fixture'
Set-Content -LiteralPath (Join-Path $menu 'CO-AGENT.lnk') -Value 'fixture'
$deps=@{Processes={@()};RegisterDailyTask={param($target) Register-CoDailyTask $target};RemoveDailyTask={Remove-CoDailyTask}}
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -WhatIf
if($calls.Count){throw 'WhatIf registered task'}
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -DailyConcept
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -DailyConcept
Uninstall-CoAgentDaily -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Yes -Dependencies $deps -WhatIf
if($calls.Count -ne 2){throw 'WhatIf removed task'}
Uninstall-CoAgentDaily -InstallDir $install -DesktopDir $desktop -StartMenuDir $menu -Yes -Dependencies $deps
if(Test-Path -LiteralPath $install){throw 'uninstall left files'}
if((Test-Path -LiteralPath (Join-Path $desktop 'CO-AGENT.lnk')) -or (Test-Path -LiteralPath (Join-Path $menu 'CO-AGENT.lnk'))){throw 'uninstall lost the explicit shortcut paths'}
@($calls.ToArray())|ConvertTo-Json -Depth 8
`);
  const r = spawnSync('pwsh.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File', runner], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root, CO_TEST_FROM: from, CO_AGENT_DATA_DIR: path.join(root,'data') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('\n[') + 1));
  assert.deepEqual(calls.map(c => c.op), ['register','register','remove']); const c = calls[0];
  assert.equal(c.name, 'CO-AGENT 每日概念'); assert.equal(c.action.execute, path.join(root,'app/CO-AGENT.exe')); assert.equal(c.action.argument, '--daily-concept');
  assert.equal(c.trigger.daily, true); assert.equal(c.trigger.at, '09:00');
  assert.deepEqual(c.trigger.Repetition, { interval: 3600, duration: 10800 });
  assert.deepEqual(c.settings, { start: true, battery: true, keep: true, limit: 3600, multiple: 'IgnoreNew' });
  assert.equal(c.principal.logon, 'Interactive'); assert.equal(c.principal.level, 'Limited'); assert.ok(c.principal.user); assert.equal(c.force, true);
});

test('v021 Alt+Enter toggles the window full screen; other keys and modifier mixes are left alone', async t => {
  const { config } = await fixture(t), h = harness(config, { argv: ['app'] }), c = main.createMain(h.deps);
  await c.ready;
  for (let i = 0; i < 500 && !h.windows.length; i++) await tick();
  const win = h.windows[0];
  const press = input => {
    let prevented = false;
    win.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } },
      { type: 'keyDown', key: 'Enter', alt: true, control: false, shift: false, meta: false, ...input });
    return prevented;
  };
  assert.equal(press({}), true); assert.equal(win.fullScreen, true);
  assert.equal(press({}), true); assert.equal(win.fullScreen, false);
  for (const input of [{ type: 'keyUp' }, { alt: false }, { key: 'a' }, { control: true }, { shift: true }, { meta: true }]) {
    assert.equal(press(input), false, JSON.stringify(input)); assert.equal(win.fullScreen, false);
  }
  assert.deepEqual(h.calls.filter(call => call[0] === 'fullscreen'), [['fullscreen', true], ['fullscreen', false]]);
  await c.stop();
});
