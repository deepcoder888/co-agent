import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixture } from './fixtures/helpers.mjs';
import main from '../electron/main.cjs';

const SPLASH = path.resolve('electron/splash.html');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Fake Electron with a primary display, destroyable windows and manual timers/clock.
function harness(config, { argv = ['app'], loadError, startError, workArea = { x: 0, y: 0, width: 1707, height: 1067 } } = {}) {
  const calls = [], windows = [], timers = [];
  let clock = 1000;
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => true, quit: () => calls.push('quit'), exit: code => calls.push(['exit', code]),
    whenReady: async () => {}, setAppUserModelId: () => {}, setPath: () => {}, commandLine: { appendSwitch: () => {} },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.shown = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = fn => { this.open = fn; };
      windows.push(this);
    }
    isDestroyed() { return this.dead; }
    isMinimized() { return false; }
    restore() {}
    show() { this.shown = true; calls.push(['show', this.options.transparent ? 'splash' : 'main']); }
    focus() {}
    destroy() { this.dead = true; calls.push(['destroy', this.options.transparent ? 'splash' : 'main']); }
    async loadURL(url) { this.url = url; if (loadError && this.options.transparent) throw loadError; }
  }
  const session = { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
    webRequest: { onBeforeRequest: fn => { session.request = fn; } } } };
  const serverApp = { server: { address: () => ({ port: 51234 }) }, close: async () => calls.push('close'),
    concepts: { ensureDaily: async () => ({ status: 'exists' }) } };
  const deps = {
    env: { CO_AGENT_DATA_DIR: config.dataDir }, argv, splashFile: SPLASH,
    now: () => clock,
    timers: { setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
      clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } },
    electron: { app, BrowserWindow, session, screen: { getPrimaryDisplay: () => ({ workArea }) },
      Menu: { setApplicationMenu: () => {} }, shell: { openExternal: async () => {} },
      dialog: { showErrorBox: () => calls.push(['error', windows.filter(w => w.options.transparent).every(w => w.dead)]) } },
    importConfig: async () => ({ loadConfig: async () => config }),
    importServer: async () => ({ startServer: async () => {
      if (startError) throw new Error(startError);
      return { app: serverApp, exitCode: 0, alreadyRunning: false };
    } }),
    log: async message => calls.push(['log', message]),
  };
  const advance = async ms => {
    clock += ms;
    for (const t of timers.filter(t => t.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await tick();
  };
  return { deps, app, calls, windows, session, advance, get splash() { return windows.find(w => w.options.transparent); },
    get main() { return windows.find(w => !w.options.transparent); } };
}

test('v032 splash: 640x400 frameless window centered on the primary work area, loaded from electron/splash.html', async t => {
  const { config } = await fixture(t), h = harness(config, { workArea: { x: 0, y: 40, width: 1707, height: 1027 } });
  const c = main.createMain(h.deps); await c.ready;
  const s = h.splash; assert.ok(s, 'splash window created');
  assert.equal(h.windows[0], s, 'splash is created before the main window');
  assert.deepEqual({ w: s.options.width, h: s.options.height, x: s.options.x, y: s.options.y }, { w: 640, h: 400, x: 534, y: 354 });
  for (const key of ['transparent', 'skipTaskbar']) assert.equal(s.options[key], true);
  for (const key of ['frame', 'resizable', 'movable', 'show']) assert.equal(s.options[key], false);
  assert.deepEqual(s.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, zoomFactor: 1 });
  assert.equal(s.url, pathToFileURL(SPLASH).href);
  assert.deepEqual(s.open({ url: 'https://example.com' }), { action: 'deny' });
  let prevented = false; s.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://example.com'); assert.ok(prevented);
  await c.stop(); assert.ok(s.dead);
});

test('v032 splash: high Windows scaling shrinks the splash to 37.5% of the work area width, zooming its content', async t => {
  // The user's primary display at 250%: 2560x1600 physical = 1024x640 DIP.
  const { config } = await fixture(t), h = harness(config, { workArea: { x: 0, y: 0, width: 1024, height: 640 } });
  const c = main.createMain(h.deps); await c.ready;
  const s = h.splash.options;
  assert.deepEqual({ w: s.width, h: s.height, x: s.x, y: s.y, zoom: s.webPreferences.zoomFactor }, { w: 384, h: 240, x: 320, y: 200, zoom: 0.6 });
  await c.stop();
  const tiny = harness(config, { workArea: { x: 0, y: 0, width: 400, height: 300 } }), c2 = main.createMain(tiny.deps); await c2.ready;
  assert.equal(tiny.splash.options.webPreferences.zoomFactor, 0.5, 'never below half size');
  await c2.stop();
});

const nav = (h, hash) => h.splash.webContents.emit('did-navigate-in-page', {}, pathToFileURL(SPLASH).href + hash);

test('v032.1 splash: the main window waits for the page to report the whole animation (#done), then the splash closes', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  h.splash.emit('ready-to-show'); assert.ok(h.splash.shown);
  await h.advance(500); h.main.emit('ready-to-show');
  await h.advance(5000); assert.equal(h.main.shown, false, 'no fixed minimum: the page decides when the animation is complete');
  nav(h, '#done'); assert.equal(h.main.shown, true); assert.ok(h.splash.dead);
  assert.deepEqual(h.calls.filter(c => c[0] === 'show' || c[0] === 'destroy').slice(-2), [['show', 'main'], ['destroy', 'splash']]);
  await c.stop();
});

test('v032.1 splash: #done before the main window is ready shows it as soon as it is ready', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  h.splash.emit('ready-to-show'); nav(h, '#done'); assert.equal(h.main.shown, false);
  await h.advance(100); h.main.emit('ready-to-show'); assert.equal(h.main.shown, true); assert.ok(h.splash.dead);
  await c.stop();
});

test('v032.1 splash: without a report the main window still appears 8 s after the splash was shown', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  h.splash.emit('ready-to-show'); await h.advance(1000); h.main.emit('ready-to-show');
  await h.advance(6999); assert.equal(h.main.shown, false);
  await h.advance(1); assert.equal(h.main.shown, true); assert.ok(h.splash.dead);
  await c.stop();
});

test('v032 splash: clicking (#skip) shows the main window as soon as it is ready', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  h.splash.emit('ready-to-show');
  h.splash.webContents.emit('did-navigate-in-page', {}, pathToFileURL(SPLASH).href + '#skip');
  assert.equal(h.main.shown, false, 'nothing to show before the main window is ready');
  await h.advance(300); h.main.emit('ready-to-show');
  assert.equal(h.main.shown, true); assert.ok(h.splash.dead);
  await c.stop();
});

test('v032 splash: clicking while waiting for the animation skips the remaining time', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  h.splash.emit('ready-to-show'); await h.advance(200); h.main.emit('ready-to-show'); assert.equal(h.main.shown, false);
  h.splash.webContents.emit('did-navigate-in-page', {}, pathToFileURL(SPLASH).href + '#skip');
  assert.equal(h.main.shown, true); assert.ok(h.splash.dead);
  await h.advance(5000); assert.equal(h.calls.filter(c => c[0] === 'show' && c[1] === 'main').length, 1, 'the cancelled timer does not show twice');
  await c.stop();
});

test('v032 splash: the headless daily concept run never shows a splash', async t => {
  const { config } = await fixture(t), h = harness(config, { argv: ['app', '--daily-concept'] }), c = main.createMain(h.deps);
  await c.ready;
  assert.equal(h.splash, undefined); assert.equal(h.windows.length, 0);
});

test('v032 splash: a failed splash load closes it without quitting, and the main window still appears', async t => {
  const { config } = await fixture(t), h = harness(config, { loadError: new Error('missing file') }), c = main.createMain(h.deps);
  h.app.emit('window-all-closed');
  await c.ready; await tick();
  assert.ok(h.splash.dead); assert.ok(!h.calls.includes('quit'));
  assert.ok(h.calls.some(c => c[0] === 'log' && /启动画面加载失败/.test(c[1])));
  h.main.emit('ready-to-show'); assert.equal(h.main.shown, true);
  await c.stop();
});

test('v032 splash: a startup error closes the splash before the error box', async t => {
  const { config } = await fixture(t), h = harness(config, { startError: 'port busy' }), c = main.createMain(h.deps);
  await c.ready; await tick();
  assert.deepEqual(h.calls.find(c => c[0] === 'error'), ['error', true]);
  assert.ok(h.splash.dead);
});

test('v032 splash: the request filter allows only the splash file besides the local origin', async t => {
  const { config } = await fixture(t), h = harness(config), c = main.createMain(h.deps); await c.ready;
  const decide = url => new Promise(resolve => h.session.request({ url }, resolve));
  assert.deepEqual(await decide(pathToFileURL(SPLASH).href), { cancel: false });
  assert.deepEqual(await decide(pathToFileURL(SPLASH).href + '#skip'), { cancel: false });
  assert.deepEqual(await decide(pathToFileURL(path.resolve('electron/main.cjs')).href), { cancel: true });
  assert.deepEqual(await decide('http://127.0.0.1:51234/'), { cancel: false });
  assert.deepEqual(await decide('https://example.com/'), { cancel: true });
  await c.stop();
});

test('v032 splash page: self-contained, reports #skip and #reduced, and is packaged', async () => {
  const html = await fs.readFile(SPLASH, 'utf8');
  assert.doesNotMatch(html, /<(?:link|img)\b|\bsrc=|@import|url\(/i, 'no external resources: the request filter blocks them');
  assert.match(html, /location\.hash = 'skip'/); assert.match(html, /location\.hash = 'done'/);
  assert.match(html, /querySelector\('\.motto'\)\.addEventListener\('animationend'/, '#done follows the last animation');
  // v0.46.1 (2026-11-07): 「诸脑」 reads aloud as 「猪脑」, so the motto avoids 诸 altogether.
  assert.match(html, /<div class="motto">群书共议 · 百家同堂<\/div>/); assert.doesNotMatch(html, /诸/);
  assert.match(html, /\.splash:not\(\.play\)[^{]*\{ animation-play-state: paused !important; \}/, 'nothing moves before the window is visible');
  assert.match(html, /visibilitychange/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /width: 640px; height: 400px/);
  const { included } = await import('../scripts/package.mjs');
  assert.equal(included('/electron/splash.html'), true, 'packager passes app-relative paths');
});
