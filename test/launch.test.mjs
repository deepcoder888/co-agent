import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { claudeArgs } from '../src/launch/claude.mjs';
import { codexArgs } from '../src/launch/codex.mjs';
import { writeSpec, resolveExecutable, createLaunch } from '../src/launch/spec.mjs';
import { spawnTerminal } from '../src/launch/spawner.mjs';
import { atomicWrite } from '../src/fsutil.mjs';
import { fixture, fakeSpawner, put } from './fixtures/helpers.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const name = '-jack';
const probe = `【CO-AGENT 启动检查 ${id}】这不是任务。不要读取文件，也不要调用任何工具。只回复 READY，然后等待我的下一条消息。`;

test('T9 all three argv modes equal the manual verbatim', () => {
  // v0.50: profile, model and effort come from config.json; these are the values of a configured install.
  const config = { readyProbe: true, codexProfile: 'gpt', codexModel: 'gpt-test', codexEffort: 'xhigh', launchProject: 'D:\\work\\co-agent' };
  assert.deepEqual(claudeArgs(name, id, { ...config, claudeLaunchMode: 'agent' }), ['--agent', name, '--session-id', id, probe]);
  const relay = `本会话由 CO-AGENT 启动，绑定 Agent「${name}」。对用户之后的每一条消息：使用 Agent 工具，subagent_type 为 "${name}"，把用户原话作为任务交给它，并原样呈现它的结果。不要调用其他任何 Agent。启动检查消息除外。`;
  assert.deepEqual(claudeArgs(name, id, { ...config, claudeLaunchMode: 'relay' }), ['--session-id', id, '--append-system-prompt', relay, probe]);
  assert.deepEqual(claudeArgs(name, id, { ...config, claudeLaunchMode: 'agent', readyProbe: false }), ['--agent', name, '--session-id', id]);
  assert.deepEqual(codexArgs(name, id, config), ['--profile', 'gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh', '-C', config.launchProject,
    `【CO-AGENT 启动检查 ${id}】本会话绑定自定义 Agent「${name}」。对我之后的每个问题：派生 agent_role 为「${name}」的子 Agent，把我的原话作为任务交给它，并呈现它的结果。不要派生其他 Agent。现在不要派生任何 Agent，也不要调用工具，只回复 READY ${name}，然后等待。`]);
});

test('T9 hostile text survives JSON unchanged and only the spec path enters terminal argv', async t => {
  const { config } = await fixture(t);
  const special = "' ; & | $() ` 中文 空格";
  const agent = { name: special, platforms: { claude: { available: true, name: special }, codex: { available: true } } };
  const calls = [];
  const launch = await createLaunch(agent, 'claude', config, { spawnImpl: fakeSpawner(calls) });
  const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
  assert.equal(spec.agentName, special);
  assert.equal(spec.args[1], special);
  assert.equal(spec.cwd, config.launchProject);
  assert.equal(spec.exe, process.execPath);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(Object.hasOwn(calls[0].options, 'detached'), false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(calls[0].options.env.AH_PWSH, process.execPath);
  assert.equal(calls[0].options.env.AH_CWD, config.launchProject);
  assert.equal(calls[0].options.env.AH_SCRIPT, path.resolve('launcher/launch.ps1'));
  assert.equal(calls[0].options.env.AH_SPEC, launch.specFile);
  assert.equal(calls[0].unref, undefined);
  assert.equal(launch.pid, process.pid);
  assert.deepEqual(launch.argvPreview.helper, calls[0].args);
  assert.deepEqual(launch.argvPreview.terminal, ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('launcher/launch.ps1'), '-SpecFile', launch.specFile]);
  assert.ok(calls[0].args.every(arg => !arg.includes(special)));
  assert.ok(launch.argvPreview.terminal.every(arg => !arg.includes(special)));
  assert.match(launch.launchId, /^[0-9a-f-]{36}$/);
});

test('finding #1 preflight passes resolved absolute pwsh path to helper and its environment', async t => {
  const { config } = await fixture(t);
  const calls = [];
  const agent = { name, platforms: { codex: { available: true } } };
  const relativeHost = path.relative(process.cwd(), process.execPath);
  await createLaunch(agent, 'codex', { ...config, pwshExe: relativeHost }, { spawnImpl: fakeSpawner(calls) });
  assert.equal(calls[0].exe, process.execPath);
  assert.equal(calls[0].options.env.AH_PWSH, process.execPath);
});

test('T9 spec writes atomically, handles EXDEV by copy/delete and cleans temporary files', async t => {
  const { config } = await fixture(t);
  const calls = [];
  const file = await writeSpec({ launchId: id, cli: 'codex', agentName: name, cwd: config.launchProject, exe: process.execPath, args: [name], title: 'Agent Hub', createdAt: new Date().toISOString() }, config,
    { rename: async () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); },
      copyFile: async (...args) => { calls.push(args); return fs.copyFile(...args); } });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).args, [name]);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [`${id}.json`]);
  await assert.rejects(atomicWrite(path.join(config.dataDir, 'fail.json'), '{}', { rename: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
  assert.ok(!(await fs.readdir(config.dataDir)).some(f => f.endsWith('.tmp')));
});

test('T9 preflight resolves PATH without execution; missing project/CLI/platform starts nothing', async t => {
  const { root, config } = await fixture(t);
  const calls = [], agent = { name, platforms: { codex: { available: true }, claude: { available: false, reason: '缺少版本' } } };
  assert.equal(await resolveExecutable(path.basename(process.execPath), { PATH: path.dirname(process.execPath), PATHEXT: '.EXE;.CMD' }), process.execPath);
  await assert.rejects(createLaunch(agent, 'claude', config, { spawnImpl: fakeSpawner(calls) }), /缺少版本/);
  await assert.rejects(createLaunch(agent, 'codex', { ...config, codexExe: 'agent-hub-nonexistent-cli' }, { spawnImpl: fakeSpawner(calls) }), /CLI/);
  await assert.rejects(createLaunch(agent, 'codex', { ...config, launchProject: path.join(root, 'absent') }, { spawnImpl: fakeSpawner(calls) }), /目录/);
  assert.equal(calls.length, 0);
  // shell:false cannot execute a Windows .cmd/.bat directly; never silently invoke a shell.
  await put(path.join(root, 'fake.cmd'), '@echo off');
  if (process.platform === 'win32') await assert.rejects(resolveExecutable(path.join(root, 'fake.cmd')), /不经 shell 无法安全启动/);
});

test('T9 asynchronous terminal spawn failure is reported, not swallowed or substituted', async t => {
  const { config } = await fixture(t);
  const child = new EventEmitter();
  child.unref = () => assert.fail('failed child cannot unref');
  await assert.rejects(spawnTerminal('spec.json', config, () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' })));
    return child;
  }), /synthetic spawn failure/);
});

test('T9 PowerShell source uses array invocation, literal cwd and no eval', async () => {
  const launcher = await fs.readFile('launcher/launch.ps1', 'utf8');
  assert.match(launcher, /Set-Location -LiteralPath \$spec\.cwd/);
  assert.match(launcher, /& \$spec\.exe @exeArgs @\(\$spec\.args\)/);
  assert.doesNotMatch(launcher, /Invoke-Expression|Start-Process|cmd\s+\/c/i);
});

const trustNotice = '首次在此目录使用交互式 Claude：请在弹出的窗口中选择「Yes, I trust this folder」并按回车，之后会话才会开始。';
for (const variant of ['backslashes', 'forward slashes', 'case and trailing separators', 'untrusted', 'parent only', 'string true', 'missing', 'malformed', 'unreadable', 'null projects']) {
  test(`finding #3 read-only Claude trust preflight: ${variant}`, async t => {
    const { config } = await fixture(t);
    let key = config.launchProject.replaceAll('/', '\\');
    const trusted = ['backslashes', 'forward slashes', 'case and trailing separators'].includes(variant);
    if (variant === 'forward slashes') key = key.replaceAll('\\', '/');
    if (variant === 'case and trailing separators') key = key.toUpperCase() + '\\\\';
    if (variant === 'parent only') key = path.dirname(config.launchProject);
    const content = variant === 'malformed' ? '{' : JSON.stringify({ projects: variant === 'null projects' ? null :
      { [key]: { hasTrustDialogAccepted: variant === 'string true' ? 'true' : variant !== 'untrusted' } } });
    if (variant === 'unreadable') await fs.mkdir(config.claudeStateFile);
    else if (variant !== 'missing') await put(config.claudeStateFile, content);
    const calls = [];
    const agent = { name, platforms: { claude: { available: true, name } } };
    const result = await createLaunch(agent, 'claude', config, { spawnImpl: fakeSpawner(calls) });
    assert.equal(calls.length, 1, 'trust failure must not block launch');
    assert.equal(result.notice, trusted ? undefined : trustNotice);
    if (variant === 'missing') await assert.rejects(fs.stat(config.claudeStateFile), { code: 'ENOENT' });
    else if (variant === 'unreadable') assert.equal((await fs.stat(config.claudeStateFile)).isDirectory(), true);
    else assert.equal(await fs.readFile(config.claudeStateFile, 'utf8'), content, 'state file must remain byte-for-byte unchanged');
  });
}

test('finding #3 Codex launch never reads Claude state or includes its trust notice', async t => {
  const { config } = await fixture(t);
  config.claudeStateFile = null; // Invalid read target would fail if Claude preflight were not CLI-specific.
  const agent = { name, platforms: { codex: { available: true } } };
  const result = await createLaunch(agent, 'codex', config, { spawnImpl: fakeSpawner() });
  assert.equal(result.notice, undefined);
});
