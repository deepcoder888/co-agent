import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { fixture, fakeSpawner } from './fixtures/helpers.mjs';
import { createApp } from '../src/server.mjs';
import main from '../electron/main.cjs';

const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${ms} ms`)), ms).unref())]);

test('v0.33.1 server close drops a busy outside connection instead of waiting for it forever', async t => {
  const { config } = await fixture(t);
  const app = await createApp(config, { conceptAutoDaily: false, statsRefreshMs: 0,
    statsFactory: () => ({ refresh: async () => {}, snapshot: () => ({ building: false }), setAgents() {} }),
    registryBuilder: async () => ({ agents: [], summary: {}, sources: [], categories: [] }),
    spawnImpl: fakeSpawner([]), verifier: async () => ({ overall: 'pending' }), isAlive: () => true });
  await app.listen();
  const port = app.server.address().port;
  // A client in the middle of a request (headers not finished): the connection is active, not idle,
  // so closeIdleConnections() alone leaves server.close() waiting (the 2026-10-22 browser-tab case).
  const socket = net.connect(port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  const ended = new Promise(resolve => socket.once('close', resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  await within(app.close(), 2000, 'app.close()');
  await within(ended, 2000, 'the outside socket');
  assert.equal(app.server.listening, false);
});

function electronHarness(config, close) {
  const calls = [];
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, quit: () => calls.push('quit'), exit: code => calls.push(['exit', code]),
    whenReady: async () => {}, setAppUserModelId: () => {}, setPath: () => {}, commandLine: { appendSwitch: () => {} } });
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return false; } isMinimized() { return false; } show() {} focus() {} restore() {} destroy() {}
    async loadURL() {}
  }
  const session = { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, webRequest: { onBeforeRequest: () => {} } } };
  return { calls, app, deps: {
    env: { CO_AGENT_DATA_DIR: config.dataDir }, argv: ['app'], shutdownTimeoutMs: 50,
    electron: { app, BrowserWindow, session, Menu: { setApplicationMenu: () => {} }, shell: { openExternal: async () => {} },
      dialog: { showErrorBox: (...args) => calls.push(['error', ...args]) } },
    importConfig: async () => ({ loadConfig: async () => config }),
    importServer: async () => ({ startServer: async () => ({ exitCode: 0, alreadyRunning: false,
      app: { server: { address: () => ({ port: 51234 }) }, close } }) }),
    log: async message => calls.push(['log', message]),
  } };
}

test('v0.33.1 Electron quits even when the local server never finishes closing, and logs it', async t => {
  const { config } = await fixture(t), h = electronHarness(config, () => new Promise(() => {}));
  const c = main.createMain(h.deps); await c.ready;
  await within(c.stop(), 2000, 'stop()');
  assert.equal(h.calls.at(-1), 'quit');
  assert.ok(h.calls.some(c => c[0] === 'log' && /50 ms 内未关闭，强制退出/.test(c[1])));
  assert.ok(!h.calls.some(c => c[0] === 'error'), 'a slow shutdown is not an error box');
});

test('v0.33.1 a normal shutdown quits without the timeout message', async t => {
  const { config } = await fixture(t), h = electronHarness(config, async () => {});
  const c = main.createMain(h.deps); await c.ready;
  await c.stop();
  assert.equal(h.calls.at(-1), 'quit');
  assert.ok(!h.calls.some(c => c[0] === 'log' && /强制退出/.test(c[1])));
});
