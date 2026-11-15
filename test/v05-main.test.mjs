import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fixture } from './fixtures/helpers.mjs';
import main from '../electron/main.cjs';
import { scrubEnvironment } from '../src/launch/spawner.mjs';
import { loadConfig } from '../src/config.mjs';

function harness(config, { lock = true, result, error, loadError, closeError } = {}) {
  const calls = [], windows = [], paths = {};
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => { calls.push('lock'); return lock; },
    quit: () => calls.push('quit'), whenReady: async () => calls.push('ready'),
    setAppUserModelId: id => calls.push(['id', id]),
    setPath: (name, value) => { assert.equal(existsSync(value), true, `Electron setPath requires an existing directory: ${name}`); paths[name] = value; },
    commandLine: { appendSwitch: flag => calls.push(['flag', flag]) },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = fn => { this.open = fn; };
      this.webContents.session = session.defaultSession;
      this.dead = false; windows.push(this);
    }
    isDestroyed() { return this.dead; }
    isMinimized() { return true; }
    restore() { calls.push('restore'); }
    show() { calls.push('show'); }
    focus() { calls.push('focus'); }
    async loadURL(url) { this.url = url; if (loadError) throw loadError; }
  }
  const session = { defaultSession: {
    setPermissionRequestHandler: fn => { session.permission = fn; },
    setPermissionCheckHandler: fn => { session.check = fn; },
    webRequest: { onBeforeRequest: fn => { session.request = fn; } },
  } };
  const serverApp = { server: { address: () => ({ port: config.port || 51234 }) },
    close: async () => { calls.push('close'); if (closeError) throw closeError; } };
  let imports = 0;
  const deps = { env: { CO_AGENT_DATA_DIR: config.dataDir }, electron: { app, BrowserWindow, session,
    Menu: { setApplicationMenu: value => calls.push(['menu', value]) },
    shell: { openExternal: async url => calls.push(['external', url]) },
    dialog: { showErrorBox: (title, message) => calls.push(['error', title, message]) },
  }, importConfig: async () => { imports++; return { loadConfig: async () => config }; },
  importServer: async () => ({ startServer: async (_config, { output }) => {
    calls.push('start'); await output('started'); if (error) throw error;
    return result || { app: serverApp, exitCode: 0, alreadyRunning: false };
  } }), log: async message => calls.push(['log', message]) };
  return { deps, app, session, calls, windows, paths, get imports() { return imports; } };
}

test('L1 lock loser quits without creating a server/window, using validated data directory', async t => {
  const { config } = await fixture(t), h = harness(config, { lock: false });
  await main.createMain(h.deps).ready;
  assert.deepEqual(h.calls, ['lock', 'quit']); assert.equal(h.imports, 0); assert.equal(h.windows.length, 0);
});
test('L1 secure window options, runtime directories, log output, ready-to-show and second instance', async t => {
  const { config } = await fixture(t), h = harness(config), controller = main.createMain(h.deps);
  await controller.ready;
  const win = h.windows[0]; assert.ok(win, JSON.stringify(h.calls));
  assert.deepEqual(win.options, { width: 1280, height: 860, minWidth: 960, minHeight: 640,
    title: 'CO-AGENT', icon: path.resolve('assets/brand/co-agent.ico'), backgroundColor: '#2b2118', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, plugins: true } });
  assert.equal(win.url, 'http://127.0.0.1:51234/');
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'id' && c[1] === 'com.asterhouse.coagent'));
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'menu' && c[1] === null));
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'log' && c[1] === 'started'));
  for (const name of ['userData', 'sessionData', 'crashDumps']) assert.ok(h.paths[name].startsWith(config.dataDir));
  assert.ok(!h.calls.includes('show')); win.emit('ready-to-show'); assert.equal(h.calls.at(-1), 'show');
  h.app.emit('second-instance'); assert.deepEqual(h.calls.slice(-3), ['restore', 'show', 'focus']);
  await controller.stop();
});
test('L1 storage paths and background switches are configured synchronously before config import/readiness', async t => {
  const { config } = await fixture(t), h = harness(config);
  let finishConfig;
  h.deps.importConfig = () => new Promise(resolve => { finishConfig = resolve; });
  const controller = main.createMain(h.deps);
  assert.equal(h.paths.userData, config.dataDir); assert.equal(h.paths.sessionData, config.dataDir);
  assert.ok(h.calls.some(c => c[0] === 'flag' && c[1] === 'disable-background-networking'));
  finishConfig({ loadConfig: async () => config }); await controller.ready; await controller.stop();
});
test('L1 synchronous directory setup preserves default legacy data migration', async t => {
  const { root } = await fixture(t), local = path.join(root, 'local');
  await fs.mkdir(path.join(local, 'Agent Hub/launches'), { recursive: true });
  await fs.writeFile(path.join(local, 'Agent Hub/launches/old.json'), 'legacy');
  const env = { LOCALAPPDATA: local }, h = harness({ dataDir: path.join(local, 'CO-AGENT'), port: 47821 }, { result: { alreadyRunning: true, exitCode: 0 } });
  h.deps.env = env; h.deps.importConfig = async () => ({ loadConfig: options => loadConfig({ ...options, env, home: root }) });
  const controller = main.createMain(h.deps); await controller.ready; await controller.stop();
  assert.equal(await fs.readFile(path.join(local, 'CO-AGENT/launches/old.json'), 'utf8'), 'legacy');
  assert.equal(await fs.readFile(path.join(local, 'Agent Hub/launches/old.json'), 'utf8'), 'legacy');
});
test('L1 same-origin navigation/popups allowed, external HTTP delegated, other protocols and permissions denied', async t => {
  const { config } = await fixture(t), h = harness(config), controller = main.createMain(h.deps);
  await controller.ready; const win = h.windows[0];
  for (const [url, allowed, external] of [
    ['http://127.0.0.1:51234/a?b#c', true, false], ['https://example.test/', false, true],
    ['http://127.0.0.1:51235/', false, true], ['http://localhost:51234/', false, true],
    ['file:///tmp/x', false, false], ['javascript:alert(1)', false, false], ['data:text/html,x', false, false],
    ['blob:http://127.0.0.1:51234/abc', false, false], ['invalid', false, false],
  ]) {
    let prevented = false; const before = h.calls.filter(c => c[0] === 'external').length;
    win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
    assert.equal(prevented, !allowed, url);
    assert.equal(win.open({ url }).action, allowed ? 'allow' : 'deny', url);
    assert.equal(h.calls.filter(c => c[0] === 'external').length - before, external ? 2 : 0, url);
  }
  for (const permission of ['media', 'notifications', 'geolocation', 'unknown']) {
    let granted; h.session.permission({}, permission, value => { granted = value; }); assert.equal(granted, false);
    assert.equal(h.session.check({}, permission), false);
  }
  // Network requests are restricted too; opening an external link is a deliberate browser action.
  for (const url of ['https://example.test/asset', 'file:///tmp/a', 'http://127.0.0.1:51235/api', 'blob:http://127.0.0.1:51234/abc']) {
    let answer; h.session.request({ url }, value => { answer = value; }); assert.equal(answer.cancel, true);
  }
  let answer; h.session.request({ url: win.url }, value => { answer = value; }); assert.equal(answer.cancel, false);
  await controller.stop();
});
for (const [url, allowed] of [
  ['http://127.0.0.1:51234/api/books/x/0/pdf', true],
  ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', true],
  ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css', true],
  ['chrome://resources/js/assert.js', true],
  ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js', false],
  ['chrome://settings/', false],
  ['https://example.com/', false],
  ['http://127.0.0.1:9999/', false],
  ['file:///C:/x.html', false],
]) {
  test(`v044 PDF request filter ${allowed ? 'allows' : 'blocks'} ${url}`, async t => {
    const { config } = await fixture(t), h = harness(config), controller = main.createMain(h.deps);
    t.after(() => controller.stop());
    await controller.ready;
    const answer = await new Promise(resolve => h.session.request({ url }, resolve));
    assert.deepEqual(answer, { cancel: !allowed }, url);
  });
}

test('L1 unsafe data overrides fail before creating any files, lock or server', async t => {
  const { config } = await fixture(t), h = harness(config);
  h.deps.env = { CO_AGENT_DATA_DIR: path.resolve('.tmp/forbidden-electron-data') };
  const controller = main.createMain(h.deps); await controller.ready;
  assert.ok(!h.calls.includes('lock')); assert.ok(!h.calls.includes('start')); assert.equal(h.windows.length, 0);
  await assert.rejects(fs.access(h.deps.env.CO_AGENT_DATA_DIR));
});
test('L1 alreadyRunning connects to configured port and never closes another server', async t => {
  const { config } = await fixture(t); config.port = 47821;
  const h = harness(config, { result: { alreadyRunning: true, exitCode: 0, app: { close: () => { throw Error('foreign server'); } } } });
  const controller = main.createMain(h.deps); await controller.ready;
  assert.equal(h.windows[0].url, 'http://127.0.0.1:47821/'); await controller.stop();
  assert.ok(!h.calls.includes('close')); assert.equal(h.calls.at(-1), 'quit');
});
for (const scenario of ['start failure', 'load failure', 'unsuccessful result', 'close failure']) {
  test(`L1 ${scenario} displays Chinese error/log path, quits, and cleans up owned server`, async t => {
    const { config } = await fixture(t);
    const h = harness(config, scenario === 'start failure' ? { error: Error('EADDRINUSE') } :
      scenario === 'load failure' ? { loadError: Error('ERR_CONNECTION') } :
      scenario === 'close failure' ? { closeError: Error('close failed') } : { result: { exitCode: 1 } });
    const controller = main.createMain(h.deps); await controller.ready;
    if (scenario === 'close failure') await controller.stop();
    const error = h.calls.find(c => c[0] === 'error'); assert.ok(error); assert.match(error[1], /CO-AGENT/);
    assert.ok(error[2].includes(path.join(config.dataDir, 'logs/server.log'))); assert.equal(h.calls.at(-1), 'quit');
    if (scenario.includes('load') || scenario.includes('close')) assert.ok(h.calls.indexOf('close') < h.calls.indexOf('quit'));
  });
}
test('L1 window-all-closed waits for close; repeated stop closes once; quit also awaits server', { timeout: 2000 }, async t => {
  const { config } = await fixture(t), h2 = harness(config);
  let release; h2.deps.importServer = async () => ({ startServer: async () => ({ exitCode: 0, app: {
    server: { address: () => ({ port: 47821 }) }, close: () => { h2.calls.push('close'); return new Promise(resolve => { release = resolve; }); },
  } }) });
  const c2 = main.createMain(h2.deps); await c2.ready;
  h2.app.emit('window-all-closed'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!h2.calls.includes('quit')); const stopping = c2.stop(); release(); await stopping;
  assert.equal(h2.calls.at(-1), 'quit'); await c2.stop(); assert.equal(h2.calls.filter(c => c === 'quit').length, 1);
  assert.equal(h2.calls.filter(c => c === 'close').length, 1);
  const h3 = harness(config), c3 = main.createMain(h3.deps); await c3.ready;
  let prevented = false; h3.app.emit('before-quit', { preventDefault: () => { prevented = true; } }); await c3.stop();
  assert.equal(prevented, true); assert.deepEqual(h3.calls.slice(-2), ['close', 'quit']);
});
test('L1 ELECTRON environment scrub is case insensitive and preserves unrelated variables', () => {
  assert.deepEqual(scrubEnvironment({ ELECTRON_RUN_AS_NODE: '1', electron_no_asar: '1', PATH: 'keep', ELECTRONICS: 'keep' }),
    { env: { PATH: 'keep', ELECTRONICS: 'keep' }, scrubbedEnv: ['ELECTRON_RUN_AS_NODE', 'electron_no_asar'] });
});
test('L1 quit during server startup waits for ownership and closes before quitting without a window', { timeout: 2000 }, async t => {
  const { config } = await fixture(t), h = harness(config);
  let finishStart, started;
  const starting = new Promise(resolve => { started = resolve; });
  h.deps.importServer = async () => ({ startServer: () => {
    started(); return new Promise(resolve => { finishStart = resolve; });
  } });
  const controller = main.createMain(h.deps); await starting;
  h.app.emit('before-quit', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.ok(!h.calls.includes('quit'));
  finishStart({ exitCode: 0, alreadyRunning: false, app: { close: async () => h.calls.push('close') } });
  await controller.ready; await controller.stop();
  assert.deepEqual(h.calls.slice(-2), ['close', 'quit']); assert.equal(h.windows.length, 0);
});
test('L1 config import failure is reported without starting server or creating a window', async t => {
  const { config } = await fixture(t), h = harness(config);
  h.deps.importConfig = async () => { throw Error('configuration unreadable'); };
  await main.createMain(h.deps).ready;
  assert.equal(h.windows.length, 0); assert.ok(!h.calls.includes('start'));
  assert.ok(h.calls.some(c => c[0] === 'error' && c[2].includes('configuration unreadable'))); assert.equal(h.calls.at(-1), 'quit');
});
