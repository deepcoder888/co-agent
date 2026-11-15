import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HELPER, helperArgs, spawnTerminal } from '../src/launch/spawner.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLaunch } from '../src/launch/spec.mjs';
import { createResume } from '../src/launch/resume.mjs';
import { createJoint } from '../src/joint/spec.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { createApp } from '../src/server.mjs';
import { renderStatus, renderRunning } from '../public/app.js';
import { renderJointStatus } from '../public/workflows.js';
import { fixture, fakeSpawner, put } from './fixtures/helpers.mjs';

const agent = { id: 'book', name: 'Book;中文', platforms: { claude: { available: true, name: 'book' }, codex: { available: true } } };
const terminal = { pid: 314, display: '\\\\.\\DISPLAY2', x: 2600, y: 40, mode: 'fullscreen', fallback: null };
function output(value, code = 0, stderr = '') {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 999;
    queueMicrotask(() => { child.stdout.end(JSON.stringify(value)); child.stderr.end(stderr); child.emit('close', code, null); });
    return child;
  };
}

test('T1 terminal config defaults, overrides and strict validation', async t => {
  const { config } = await fixture(t);
  const load = () => loadConfig({ env: { CO_AGENT_DATA_DIR: config.dataDir } });
  const defaults = await load();
  // v0.50: the primary display and a maximized window unless config.json says otherwise.
  assert.equal(defaults.terminalDisplay, 'primary'); assert.equal(defaults.terminalWindowMode, 'maximized'); assert.equal(defaults.wtExe, 'wt.exe');
  await put(path.join(config.dataDir, 'config.json'), JSON.stringify({ terminalDisplay: 'secondary', terminalWindowMode: 'normal', wtExe: process.execPath }));
  const overridden = await load(); assert.equal(overridden.terminalDisplay, 'secondary'); assert.equal(overridden.terminalWindowMode, 'normal'); assert.equal(overridden.wtExe, process.execPath);
  for (const override of [{ terminalDisplay: 'third' }, { terminalDisplay: null }, { terminalWindowMode: 'full' }, { wtExe: '' }, { wtExe: 42 }]) {
    await put(path.join(config.dataDir, 'config.json'), JSON.stringify(override)); await assert.rejects(load(), /terminal|wtExe/);
  }
});

test('T2/T4 helper argv stays byte-identical, all values only in env, JSON PID overrides helper PID', async t => {
  const { root, config } = await fixture(t), calls = [];
  Object.assign(config, { wtExe: process.execPath, terminalTitle: 'CO-AGENT · Book;中文', terminalPidFile: path.join(root, 'data', 'a.pid') });
  const replace = output(terminal);
  const result = await spawnTerminal(path.join(root, 'a.json'), config, (exe, args, options) => { calls.push({ exe, args, options }); return replace(); }, { KEEP: 'yes', AH_MODE: 'bad', CLAUDECODE: 'secret' });
  assert.deepEqual(result, terminal); assert.deepEqual(calls[0].args, helperArgs()); assert.equal(calls[0].args.at(-1), HELPER);
  assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.shell, false);
  const env = calls[0].options.env;
  assert.equal(env.AH_WT, process.execPath); assert.equal(env.AH_DISPLAY, 'secondary'); assert.equal(env.AH_MODE, 'fullscreen');
  assert.equal(env.AH_TITLE, config.terminalTitle); assert.equal(env.AH_PIDFILE, config.terminalPidFile);
  assert.equal(env.AH_SPEC, path.join(root, 'a.json')); assert.equal(env.KEEP, 'yes'); assert.equal(env.CLAUDECODE, undefined);
  for (const value of [env.AH_SPEC, env.AH_TITLE, env.AH_CWD]) assert.ok(!HELPER.includes(value));
});

for (const key of ['wtExe', 'terminalTitle', 'terminalPidFile']) for (const bad of ['"', '\n', '\r']) {
  test(`T2 reject unsafe ${key} ${JSON.stringify(bad)} before spawn`, async t => {
    const { config } = await fixture(t), calls = []; config[key] = `unsafe${bad}value`;
    await assert.rejects(spawnTerminal('a.json', config, fakeSpawner(calls)), /双引号或换行/); assert.equal(calls.length, 0);
  });
}
for (const pid of [0, -1, 1.2, '314', null, 9007199254740992]) test(`T4 invalid JSON PID ${pid}`, async t => {
  const { config } = await fixture(t); await assert.rejects(spawnTerminal('a.json', config, output({ ...terminal, pid })), /终端 PID/);
});
test('T4 pidfile timeout diagnostic survives nonzero helper exit', async t => {
  const { config } = await fixture(t); await assert.rejects(spawnTerminal('a.json', config, output({}, 1, 'pidfile 等待超时（15000 ms）')), /pidfile.*15000/);
});

// Execute production helper functions with injected Start-Process and synthetic screens.
// The AST excludes the production DPI/Screen entrypoint; no window can be created.
async function runPowerShell(t, body, env = {}) {
  const { root } = await fixture(t), helper = path.join(root, 'helper.ps1'), runner = path.join(root, 'test.ps1');
  await put(helper, HELPER);
  await put(runner, String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($f in $functions) { . ([scriptblock]::Create($f.Extent.Text)) }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory) $script:call = @{exe=$FilePath;args=$ArgumentList;cwd=$WorkingDirectory}; if ($env:TEST_WRITE_PID -eq 'yes') { [IO.File]::WriteAllText($env:AH_PIDFILE, '314') } }
$env:AH_WT = 'C:\工具\wt.exe'; $env:AH_PWSH = 'C:\工具\pwsh.exe'
$env:AH_CWD = 'D:\中文;项目\'; $env:AH_SCRIPT = 'D:\app\launch.ps1'; $env:AH_SPEC = 'D:\数据;a.json'; $env:AH_TITLE = 'CO-AGENT · 中文;名'
$env:AH_PIDFILE = Join-Path $env:TEST_ROOT 'terminal.pid'
$screens = @([pscustomobject]@{Primary=$true;DeviceName='DISPLAY1';Bounds=@{X=0;Y=0}}, [pscustomobject]@{Primary=$false;DeviceName='DISPLAY2';Bounds=@{X=2560;Y=0}})
` + body);
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env, TEST_HELPER: helper, TEST_ROOT: root },
  });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

for (const mode of ['fullscreen', 'maximized', 'normal']) for (const display of ['primary', 'secondary']) {
  test(`T2 real helper functions injected: ${display}/${mode}, exact quoting and semicolon escape`, async t => {
    const result = await runPowerShell(t, String.raw`
$env:AH_MODE = $env:TEST_MODE; $env:AH_DISPLAY = $env:TEST_DISPLAY
$json = Invoke-AgentTerminal -Screens $screens
@{terminal=($json | ConvertFrom-Json);call=$script:call} | ConvertTo-Json -Depth 10 -Compress
`, { TEST_MODE: mode, TEST_DISPLAY: display, TEST_WRITE_PID: 'yes' });
    assert.equal(result.terminal.pid, 314); assert.equal(result.terminal.display, display === 'primary' ? 'DISPLAY1' : 'DISPLAY2');
    assert.equal(result.terminal.x, display === 'primary' ? 40 : 2600); assert.equal(result.terminal.y, 40);
    assert.equal(result.terminal.mode, mode); assert.equal(result.terminal.fallback, null);
    const modeArg = mode === 'normal' ? '' : ` "--${mode}"`;
    const expected = `"-w" "new" "--pos" "${display === 'primary' ? 40 : 2600},40"${modeArg} "--title" "CO-AGENT · 中文\\;名" "--suppressApplicationTitle" "-d" "D:\\中文\\;项目\\\\" "C:\\工具\\pwsh.exe" "-NoLogo" "-NoExit" "-ExecutionPolicy" "Bypass" "-File" "D:\\app\\launch.ps1" "-SpecFile" "D:\\数据\\;a.json"`;
    assert.equal(result.call.exe, 'C:\\工具\\wt.exe'); assert.equal(result.call.args, expected);
  });
}
test('T2 one monitor fallback and negative monitor coordinates', async t => {
  const result = await runPowerShell(t, String.raw`
$env:AH_MODE='fullscreen'; $env:AH_DISPLAY='secondary'
$one = Invoke-AgentTerminal -Screens @($screens[0]) | ConvertFrom-Json
[IO.File]::Delete($env:AH_PIDFILE)
$screens[1].Bounds.X=-1080; $screens[1].Bounds.Y=-100
$negative = Invoke-AgentTerminal -Screens $screens | ConvertFrom-Json
@{one=$one;negative=$negative} | ConvertTo-Json -Compress
`, { TEST_WRITE_PID: 'yes' });
  assert.equal(result.one.fallback, 'primary'); assert.equal(result.one.x, 40); assert.equal(result.negative.x, -1040); assert.equal(result.negative.y, -60);
});
test('T2 no-wt uses old pwsh arguments without wt semicolon escaping', async t => {
  const result = await runPowerShell(t, String.raw`
$env:AH_WT=''; $env:AH_MODE='fullscreen'; $env:AH_DISPLAY='secondary'
$json=Invoke-AgentTerminal -Screens @()
@{terminal=($json | ConvertFrom-Json);call=$script:call} | ConvertTo-Json -Compress
`, { TEST_WRITE_PID: 'yes' });
  assert.equal(result.terminal.terminalFallback, 'no-wt'); assert.equal(result.terminal.pid, 314);
  assert.equal(result.call.exe, 'C:\\工具\\pwsh.exe'); assert.equal(result.call.cwd, 'D:\\中文;项目\\');
  assert.equal(result.call.args, '"-NoLogo" "-NoExit" "-ExecutionPolicy" "Bypass" "-File" "D:\\app\\launch.ps1" "-SpecFile" "D:\\数据;a.json"');
});
test('T2 real pidfile polling times out and rejects malformed PID', async t => {
  const result = await runPowerShell(t, String.raw`
$messages=@()
try { Wait-TerminalPid -TimeoutMs 5 | Out-Null; throw 'accepted missing pid' } catch { $messages += $_.Exception.Message }
[IO.File]::WriteAllText($env:AH_PIDFILE,'0')
try { Wait-TerminalPid | Out-Null; throw 'accepted zero pid' } catch { $messages += $_.Exception.Message }
@{messages=$messages} | ConvertTo-Json -Compress
`);
  assert.match(result.messages[0], /pidfile.*超时/); assert.match(result.messages[1], /PID/);
  assert.match(HELPER, /TimeoutMs\s*=\s*15000/); assert.match(HELPER, /SetProcessDpiAwarenessContext/); assert.match(HELPER, /IntPtr\]\(-4\)/);
  assert.ok(HELPER.indexOf('SetProcessDpiAwarenessContext([IntPtr](-4))') < HELPER.indexOf('Add-Type -AssemblyName System.Windows.Forms'));
});

for (const route of ['claude', 'codex', 'resume', 'joint']) for (const wt of [true, false]) {
  test(`T3/T4 ${route} through common spawner, pidfile, preview, persisted metadata, wt=${wt}`, async t => {
    const { root, config } = await fixture(t), calls = [];
    config.wtExe = wt ? process.execPath : path.join(root, 'missing-wt.exe');
    const fake = fakeSpawner(calls, 314);
    const spawnImpl = (exe, args, options) => {
      const before = JSON.parse(readFileSync(options.env.AH_SPEC, 'utf8'));
      assert.equal(before.pidFile, options.env.AH_PIDFILE);
      assert.equal(before.terminalFallback, wt ? undefined : 'no-wt');
      assert.equal(before.pid, undefined);
      return fake(exe, args, options);
    }; let record;
    if (route === 'resume') {
      const file = path.join(root, 'session.jsonl'); await put(file, '{}\n');
      record = await createResume({ cli: 'codex', agentName: agent.name, agentId: agent.id, cwd: config.launchProject, codexProfile: 'gpt', launchId: 'old' }, { id: 'session', file }, config, { spawnImpl });
    } else if (route === 'joint') record = await createJoint({ input: '原文 " ; & $()\n保留', cli: 'codex', agents: [agent] }, config, { spawnImpl });
    else record = await createLaunch(agent, route, config, { spawnImpl });
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, helperArgs()); assert.equal(calls[0].options.shell, false);
    assert.equal(record.pid, 314); assert.equal(record.pidFile, record.specFile.replace(/\.json$/, '.pid'));
    assert.equal(calls[0].options.env.AH_PIDFILE, record.pidFile); assert.equal(calls[0].options.env.AH_TITLE, `CO-AGENT · ${route === 'joint' ? '联合调用' : agent.name} · ${(record.jointId || record.launchId).slice(0, 4)}`);
    assert.equal(calls[0].options.env.AH_WT, wt ? process.execPath : '');
    const saved = JSON.parse(await fs.readFile(record.specFile, 'utf8')); assert.equal(saved.pid, 314); assert.equal(saved.pidFile, record.pidFile);
    if (wt) {
      assert.equal(saved.display, '\\\\.\\DISPLAY2'); assert.equal(saved.terminalWindowMode, 'fullscreen'); assert.equal(saved.fallback, null);
      assert.ok(saved.argvPreview.wt.includes('--fullscreen')); assert.equal(saved.argvPreview.wt[saved.argvPreview.wt.indexOf('--pos') + 1], '2600,40');
    } else { assert.equal(saved.terminalFallback, 'no-wt'); assert.equal(saved.argvPreview.wt, null); }
    assert.deepEqual(saved.argvPreview.helper, calls[0].args);
    const store = createSessions(config, { isAlive: pid => pid === 314, verifier: async () => ({ overall: 'ready' }), jointVerifier: async () => ({ overall: 'done' }) });
    const type = route === 'joint' ? 'joint' : 'launch', id = record.jointId || record.launchId;
    await store.register(type, record); const status = await store.check(type, id); assert.equal(status.process.pid, 314);
    if (!wt) { assert.equal(status.terminalFallback, 'no-wt'); assert.equal((await store.running()).items[0].status.terminalFallback, 'no-wt'); }
  });
}
test('T3/T4 Claude resume keeps original catalog name across repeated resumes; Claude joint uses same wt path', async t => {
  const { root, config } = await fixture(t), calls = [], spawnImpl = fakeSpawner(calls, 314);
  const launch = await createLaunch(agent, 'claude', config, { spawnImpl });
  const file = path.join(root, 'session.jsonl'); await put(file, '{}\n');
  const first = await createResume(launch, { id: launch.sessionId, file }, config, { spawnImpl });
  const second = await createResume(first, { id: launch.sessionId, file }, config, { spawnImpl });
  assert.equal(first.mode, 'agent'); assert.equal(second.mode, 'agent');
  assert.equal(first.title, `CO-AGENT · ${agent.name} · ${first.launchId.slice(0, 4)}`); assert.equal(second.title, `CO-AGENT · ${agent.name} · ${second.launchId.slice(0, 4)}`);
  const joint = await createJoint({ input: 'user " ; text', cli: 'claude', agents: [agent] }, config, { spawnImpl });
  assert.equal(joint.title, `CO-AGENT · 联合调用 · ${joint.jointId.slice(0, 4)}`);
  for (const [i, record] of [launch, first, second, joint].entries()) {
    assert.equal(calls[i].options.env.AH_TITLE, record.title); assert.equal(calls[i].options.env.AH_PIDFILE, record.pidFile);
    assert.equal(calls[i].options.env.AH_WT, process.execPath); assert.ok(record.argvPreview.wt.includes('--fullscreen'));
  }
});
test('T2 unsafe title and wt script fail preflight without spec or spawn', async t => {
  const { root, config } = await fixture(t), calls = [];
  for (const bad of ['"', '\n', '\r']) await assert.rejects(createLaunch({ ...agent, name: 'Book' + bad }, 'codex', config, { spawnImpl: fakeSpawner(calls) }), /双引号或换行/);
  if (process.platform === 'win32') {
    const script = path.join(root, 'wt.cmd'); await put(script, '@echo off');
    await assert.rejects(createLaunch(agent, 'codex', { ...config, wtExe: script }, { spawnImpl: fakeSpawner(calls) }), /不经 shell 无法安全启动/);
  }
  assert.equal(calls.length, 0); await assert.rejects(fs.stat(path.join(config.dataDir, 'launches')), { code: 'ENOENT' });
});
for (const changed of [{ display: null }, { x: '2600' }, { y: null }, { mode: 'normal' }, { fallback: 'secondary' }, { terminalFallback: 'no-wt' }]) {
  test(`T4 rejects inconsistent helper metadata ${JSON.stringify(changed)}`, async t => {
    const { config } = await fixture(t); await assert.rejects(spawnTerminal('a.json', config, output({ ...terminal, ...changed })), /终端信息无效/);
  });
}
for (const wt of [true, false]) test(`T4 HTTP single/resume/joint expose final wt argv and survive restart, wt=${wt}`, async t => {
  // Stop background writers before fixture() removes the runtime data directory.
  let app;
  t.after(() => app?.close());
  const { root, config } = await fixture(t), calls = [], file = path.join(root, 'session.jsonl'); await put(file, '{}\n');
  config.wtExe = wt ? process.execPath : path.join(root, 'missing-wt.exe');
  const session = { id: '11111111-1111-4111-8111-111111111111', file };
  const options = { registryBuilder: async () => ({ agents: [agent] }), spawnImpl: fakeSpawner(calls, 314), isAlive: pid => pid === 314,
    verifier: async () => ({ overall: 'ready', session }), jointVerifier: async () => ({ overall: 'done' }),
    recommendRunner: async record => ({ ...record, status: 'done', results: [{ id: agent.id }], rejected: [] }) };
  app = await createApp(config, options); await app.listen();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  async function post(url, body) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const launch = await post('/api/launch', { agentId: agent.id, cli: 'claude' });
  const check = record => {
    assert.equal(record.terminalFallback, wt ? undefined : 'no-wt');
    if (wt) { assert.ok(record.argvPreview.wt.includes('--fullscreen')); assert.equal(record.argvPreview.wt[3], '2600,40'); }
    else assert.equal(record.argvPreview.wt, null);
  };
  check(launch);
  await app.sessions.check('launch', launch.launchId);
  const resume = await post('/api/resume', { agentId: agent.id, launchId: launch.launchId }); check(resume);
  const recommendation = await post('/api/recommend', { input: 'text', engine: 'codex' }); await app.workflows.idle();
  const joint = await post('/api/joint', { recommendId: recommendation.recommendId, agentIds: [agent.id], cli: 'codex' }); check(joint);
  assert.equal((await (await fetch(base + `/api/joint/${joint.jointId}`)).json()).terminalFallback, wt ? undefined : 'no-wt');
  await app.close(); app = await createApp(config, options); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
  const running = await (await fetch(base + '/api/running')).json(); assert.equal(running.items.length, 3);
  assert.ok(running.items.every(item => item.status.terminalFallback === (wt ? undefined : 'no-wt'))); assert.equal(calls.length, 3);
});
for (const value of ['314', '0']) test(`T2 complete constant helper entrypoint with injected Start-Process and PID ${value}`, async t => {
  const { root } = await fixture(t), helper = path.join(root, 'helper.txt'), runner = path.join(root, 'runner.ps1'), pidFile = path.join(root, 'a.pid');
  await put(helper, HELPER);
  await put(runner, String.raw`$ErrorActionPreference='Stop'
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory) [IO.File]::WriteAllText($env:AH_PIDFILE,$env:TEST_PID_VALUE); return @{Id=999} }
& ([scriptblock]::Create([IO.File]::ReadAllText($env:TEST_HELPER)))
`);
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TEST_HELPER: helper, TEST_PID_VALUE: value, AH_PIDFILE: pidFile, AH_WT: '', AH_PWSH: 'never-execute',
      AH_SCRIPT: 'never-execute.ps1', AH_SPEC: 'never-execute.json', AH_CWD: root, AH_MODE: 'fullscreen', AH_DISPLAY: 'secondary', AH_TITLE: 'CO-AGENT' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  if (value === '314') { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).pid, 314); assert.equal(JSON.parse(result.stdout).terminalFallback, 'no-wt'); }
  else { assert.equal(result.status, 1); assert.match(result.stderr, /pidfile.*PID/); assert.equal(result.stdout, ''); }
});
test('T3 launch.ps1 atomically writes own PID before cwd/title/CLI, using fake CLI', async t => {
  const { root } = await fixture(t), specFile = path.join(root, 'spec.json'), pidFile = path.join(root, 'launch.pid'), runner = path.join(root, 'runner.ps1');
  await put(specFile, JSON.stringify({ pidFile, cwd: root, title: 'fake', exe: 'Fake-Cli', args: ['user;"text'] }));
  await put(runner, String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Fake-Cli { if ([IO.File]::ReadAllText($env:TEST_PID).Trim() -ne [string]$PID) { throw 'PID not written before CLI' }; $global:seen=@($args); $global:LASTEXITCODE=0 }
function Write-Host {}
& $env:TEST_LAUNCHER -SpecFile $env:TEST_SPEC
if ($global:seen[0] -ne 'user;"text') { throw 'CLI argv changed' }
if ((Get-ChildItem -LiteralPath $env:TEST_ROOT -Filter '*.tmp').Count) { throw 'temporary PID leaked' }
@{pid=$PID;written=[IO.File]::ReadAllText($env:TEST_PID).Trim()} | ConvertTo-Json -Compress
`);
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', runner], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, env: { ...process.env, TEST_ROOT: root, TEST_PID: pidFile, TEST_SPEC: specFile, TEST_LAUNCHER: path.resolve('launcher/launch.ps1') } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr + result.stdout); const data = JSON.parse(result.stdout); assert.equal(Number(data.written), data.pid);
  const source = await fs.readFile('launcher/launch.ps1', 'utf8'); assert.ok(source.indexOf('[IO.File]::Move') < source.indexOf('Set-Location'));
});

class Element {
  constructor() { this.children = []; this.textContent = ''; }
  append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; }
  setAttribute() {} get text() { return this.textContent + this.children.map(n => n.text).join(''); }
}
test('T4 fallback notice appears next to single, joint and running status', () => {
  const doc = { createElement: () => new Element() }, target = new Element();
  const status = { overall: 'ready', terminalFallback: 'no-wt', process: { state: 'alive' }, cwd: { state: 'ok' }, agent: { state: 'confirmed' }, waiting: { state: 'ok' } };
  renderStatus(doc, target, status); assert.match(target.text, /未找到 Windows Terminal，窗口位置未控制/);
  renderRunning(doc, target, { items: [{ agentName: 'Book', cli: 'claude', createdAt: new Date().toISOString(), status }] }); assert.match(target.text, /未找到 Windows Terminal，窗口位置未控制/);
  renderJointStatus(doc, target, { cli: 'codex', whitelist: [{ codexName: 'Book' }], terminalFallback: 'no-wt' }, { ...status, parallel: { state: 'ok', evidence: [] }, whitelist: { state: 'ok', deniedAttempts: [], violations: [] }, calls: [] });
  assert.match(target.text, /未找到 Windows Terminal，窗口位置未控制/);
});

test('v0.5.1 acceptance fix: resolves a Windows App Execution Alias such as WindowsApps\wt.exe', { skip: process.platform !== 'win32' || !process.env.LOCALAPPDATA }, async t => {
  const { existsSync, lstatSync } = await import('node:fs');
  const alias = (await import('node:path')).join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
  let isAlias = false;
  try { isAlias = existsSync(alias) || lstatSync(alias).isSymbolicLink(); } catch { /* no alias on this machine */ }
  if (!isAlias) { t.skip('no WindowsApps wt.exe alias on this machine'); return; }
  const { resolveExecutable } = await import('../src/launch/spec.mjs');
  assert.equal((await resolveExecutable(alias)).toLowerCase(), alias.toLowerCase());
});
