import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnTerminal } from '../src/launch/spawner.mjs';
import { fixture, fakeSpawner } from './fixtures/helpers.mjs';

const expectedHelper = (await fs.readFile(new URL('./fixtures/terminal-helper.txt', import.meta.url), 'utf8')).replaceAll('\r\n', '\n').trimEnd();
const result = { pid: 314, display: '\\\\.\\DISPLAY2', x: 2600, y: 40, mode: 'fullscreen', fallback: null };

function helper({ stdout = JSON.stringify(result), stderr = '', code = 0, signal = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => assert.fail('the helper must stay observed until close');
  child.killCount = 0;
  child.kill = () => { child.killCount++; return true; };
  queueMicrotask(() => {
    child.emit('spawn');
    child.stdout.write(stdout); child.stderr.write(stderr);
    if (!hang) { child.stdout.end(); child.stderr.end(); child.emit('close', code, signal); }
  });
  return child;
}

test('finding #1 exact constant helper argv, hidden options and app-controlled environment', async t => {
  const { root, config } = await fixture(t);
  const spec = path.join(root, '中文 空格', 'launch.json'), calls = [];
  const result = await spawnTerminal(spec, config, fakeSpawner(calls, 314));
  assert.equal(result.pid, 314);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, config.pwshExe);
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expectedHelper]);
  const retainedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|CLAUDE_PLUGIN_|CLAUDE_PREVIEW_|CODEX_TOOLKIT_|CODEX_THREAD_ID$|CODEX_SANDBOX|OCTOPUS_WORKER$|ELECTRON_)/i.test(key)));
  const { env, ...options } = calls[0].options;
  assert.deepEqual(options, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const expectedEnv = { ...retainedEnv, AH_PWSH: config.pwshExe, AH_CWD: config.launchProject,
    AH_SCRIPT: path.resolve('launcher/launch.ps1'), AH_SPEC: spec,
    AH_WT: config.wtExe, AH_DISPLAY: 'secondary', AH_MODE: 'fullscreen', AH_TITLE: 'CO-AGENT', AH_PIDFILE: spec.replace(/\.json$/, '.pid') };
  assert.deepEqual(Object.keys(env).sort(), Object.keys(expectedEnv).sort());
  for (const [key, value] of Object.entries(expectedEnv)) assert.ok(env[key] === value, `环境变量 ${key} 原值应保留`);
  assert.ok(calls[0].args.every(arg => !arg.includes(spec) && !arg.includes(config.launchProject)));
});

test('finding #1 collects chunked stdout and waits for close before accepting terminal PID', async t => {
  const { root, config } = await fixture(t);
  const child = helper({ hang: true, stdout: '{"pid":31' });
  let settled = false;
  const pending = spawnTerminal(path.join(root, 'spec.json'), config, () => child);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.stdout.end('4,"display":"DISPLAY2","x":2600,"y":40,"mode":"fullscreen","fallback":null}\n'); child.stderr.end(); child.emit('close', 0, null);
  assert.equal((await pending).pid, 314);
});

for (const [label, stdout] of [['empty', ''], ['non-numeric', 'READY'], ['zero', '0'],
  ['negative', '-1'], ['mixed output', '314\nREADY'], ['decimal', '1.2'], ['unsafe integer', '9007199254740992']]) {
  test(`finding #1 rejects ${label} helper PID without falling back to helper.pid`, async t => {
    const { root, config } = await fixture(t);
    let calls = 0;
    await assert.rejects(spawnTerminal(path.join(root, 'spec.json'), config, () => {
      calls++; return helper({ stdout, stderr: 'synthetic PID diagnostic' });
    }), error => /终端 PID/.test(error.message) && error.message.includes('synthetic PID diagnostic'));
    assert.equal(calls, 1);
  });
}

test('finding #1 nonzero helper exit includes stderr and code despite valid-looking stdout', async t => {
  const { root, config } = await fixture(t);
  let calls = 0;
  await assert.rejects(spawnTerminal(path.join(root, 'spec.json'), config, () => {
    calls++; return helper({ stdout: '314', code: 7, stderr: 'Start-Process synthetic failure' });
  }), error => /辅助进程/.test(error.message) && error.message.includes('7') && error.message.includes('Start-Process synthetic failure'));
  assert.equal(calls, 1);
});

test('finding #1 signalled helper exit is a failure', async t => {
  const { root, config } = await fixture(t);
  await assert.rejects(spawnTerminal(path.join(root, 'spec.json'), config, () => helper({ code: null, signal: 'SIGTERM', stderr: 'synthetic signal' })), /SIGTERM.*synthetic signal/);
});

test('finding #1 helper watchdog is 20 seconds, kills helper and starts nothing else', async t => {
  const { root, config } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = helper({ hang: true, stdout: '', stderr: 'synthetic hang diagnostic' });
  let calls = 0, settled = false;
  const pending = spawnTerminal(path.join(root, 'spec.json'), config, () => { calls++; return child; });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  t.mock.timers.tick(19999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, error => /超时/.test(error.message) && error.message.includes('20000') && error.message.includes('synthetic hang diagnostic'));
  assert.equal(child.killCount, 1);
  assert.equal(calls, 1);
  // A late close/error cannot turn the timeout into success or cause an unhandled event.
  child.emit('close', 0, null); child.emit('error', new Error('late synthetic error'));
});

for (const [label, key] of [['pwsh', 'pwshExe'], ['cwd', 'launchProject'], ['spec', 'specFile']]) {
  for (const bad of ['"', '\n', '\r']) test(`finding #1 rejects ${label} path with ${JSON.stringify(bad)} before spawn`, async t => {
    const { root, config } = await fixture(t);
    let spec = path.join(root, 'spec.json');
    if (key === 'specFile') spec += bad;
    else config[key] += bad;
    const calls = [];
    await assert.rejects(spawnTerminal(spec, config, fakeSpawner(calls)), /路径/);
    assert.equal(calls.length, 0);
  });
}

for (const bad of ['"', '\n', '\r']) test(`finding #1 rejects launcher script path with ${JSON.stringify(bad)} before spawning`, async t => {
  const { root, config } = await fixture(t);
  const join = t.mock.method(path, 'join', (...parts) => parts.at(-1) === 'launch.ps1' ? `C:\\unsafe${bad}script.ps1` : parts.join(path.sep));
  const calls = [];
  await assert.rejects(spawnTerminal(path.resolve(root, 'spec.json'), config, fakeSpawner(calls)), /路径/);
  assert.equal(calls.length, 0);
  join.mock.restore();
});

test('finding #1 preserves Chinese stderr when UTF-8 bytes arrive across chunks', async t => {
  const { root, config } = await fixture(t);
  const child = helper({ hang: true, stdout: '' });
  const pending = spawnTerminal(path.join(root, 'spec.json'), config, () => child);
  await Promise.resolve();
  const diagnostic = '辅助进程启动错误';
  const bytes = Buffer.from(diagnostic, 'utf8');
  child.stderr.write(bytes.subarray(0, 1)); child.stderr.end(bytes.subarray(1));
  child.stdout.end(); child.emit('close', 1, null);
  await assert.rejects(pending, error => error.message.includes(diagnostic));
});

test('finding #1 synchronous spawn failure is Chinese and preserves original error', async t => {
  const { root, config } = await fixture(t);
  await assert.rejects(spawnTerminal(path.join(root, 'spec.json'), config, () => {
    throw new Error('synthetic sync spawn error');
  }), /辅助进程.*synthetic sync spawn error/);
});
