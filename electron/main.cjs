const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true };
// Chromium's built-in PDF viewer and its shared resources (v0.44, 2026-11-02).
// These schemes have a null origin, so match protocol and host instead.
const PDF_VIEWER_EXTENSION_HOST = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const CHROME_RESOURCES_HOST = 'resources';

function createMain({ electron, importServer, importConfig, log, env = process.env, argv = process.argv, dailyTimeoutMs = 50 * 60 * 1000,
  splashFile, splashMaxMs = 8000, shutdownTimeoutMs = 5000, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  const { app, BrowserWindow, Menu, session, shell, dialog, screen } = electron;
  const headless = argv.includes('--daily-concept');
  // A headless daily run becomes a normal app run once the user opens its window, so finishing the run never closes that window.
  let windowless = headless;
  let window, ownedServer, config, startingServer, stopping, origin, openingWindow, dailyWork;
  let quitting = false, exitCode = 0, pendingWindow = false, pendingDaily = false;
  // v0.32 splash (2026-10-22): shown on a normal launch until the main window is ready and the
  // whole animation has played (#done from the page, v0.32.1), or at once when clicked (#skip).
  // splashMaxMs bounds the wait if the page never reports. Never shown for --daily-concept.
  let splash, splashUrl, splashShownAt = 0, splashSkipped = false, splashDone = false, splashTimer, mainReady = false;
  const record = async message => { try { await log(message, config); } catch { /* Error box remains available if disk logging fails. */ } };
  function closeSplash() {
    if (splashTimer) { timers.clearTimeout(splashTimer); splashTimer = undefined; }
    const closing = splash; splash = undefined;
    if (closing && !closing.isDestroyed()) closing.destroy();
  }
  function revealMain() {
    if (!mainReady || stopping || !window || window.isDestroyed()) return;
    if (splash && !splash.isDestroyed() && !splashSkipped && !splashDone) {
      const wait = (splashShownAt || now()) + splashMaxMs - now();
      if (wait > 0) {
        if (!splashTimer) splashTimer = timers.setTimeout(() => { splashTimer = undefined; revealMain(); }, wait);
        return;
      }
    }
    window.show();
    closeSplash();
  }
  function openSplash() {
    if (!splashFile || headless) return;
    try {
      // The 640x400 design takes 37.5% of the primary work area's width, never more than its own size:
      // at 250% Windows scaling (1024x640 DIP) the window is 384x240 DIP, i.e. 960x600 physical pixels.
      const area = screen.getPrimaryDisplay().workArea, zoom = Math.max(0.5, Math.min(1, area.width * 0.375 / 640));
      const width = Math.round(640 * zoom), height = Math.round(400 * zoom);
      splashUrl = pathToFileURL(splashFile).href;
      const shown = new BrowserWindow({ width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
        frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, show: false, title: 'CO-AGENT', webPreferences: { ...webPreferences, zoomFactor: zoom } });
      splash = shown;
      const contents = shown.webContents;
      contents.on('will-navigate', event => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('did-navigate-in-page', (_event, url) => {
        let hash = '';
        try { hash = new URL(url).hash; } catch { /* Ignore malformed URLs. */ }
        if (hash === '#done') { splashDone = true; revealMain(); }
        if (hash === '#skip') { splashSkipped = true; revealMain(); }
      });
      shown.once('ready-to-show', () => { if (splash === shown && !shown.isDestroyed()) { shown.show(); splashShownAt = now(); } });
      Promise.resolve(shown.loadURL(splashUrl)).catch(error => { void record(`启动画面加载失败：${error.message}`); if (splash === shown) closeSplash(); });
    } catch (error) { void record(`启动画面创建失败：${error.message}`); closeSplash(); }
  }
  const errorBox = async error => {
    closeSplash();
    const dataDir = config?.dataDir || path.resolve(env.CO_AGENT_DATA_DIR || env.AGENT_HUB_DATA_DIR ||
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CO-AGENT'));
    await record(`Electron 错误：${error.message}`);
    if (windowless) { exitCode = 1; return; }
    dialog.showErrorBox('CO-AGENT 启动或退出失败', `CO-AGENT 无法完成操作：${error.message}\n请查看日志：${path.join(dataDir, 'logs', 'server.log')}`);
  };
  async function closeServer() {
    const server = ownedServer; ownedServer = undefined;
    if (!server) return;
    // v0.33.1: never let a stuck shutdown keep the process (and the single-instance lock) alive.
    let timer;
    const timedOut = new Promise(resolve => { timer = timers.setTimeout(() => resolve('timeout'), shutdownTimeoutMs); });
    const outcome = await Promise.race([Promise.resolve(server.close()).then(() => 'closed'), timedOut]).finally(() => timers.clearTimeout(timer));
    if (outcome === 'timeout') await record(`退出：本地服务器 ${shutdownTimeoutMs} ms 内未关闭，强制退出`);
  }
  function stop() {
    if (!stopping) stopping = (async () => {
      closeSplash();
      try { await startingServer?.catch(() => {}); await dailyWork?.catch(() => {}); await closeServer(); } catch (error) { await errorBox(error); }
      finally { quitting = true; if (windowless) app.exit(exitCode); else app.quit(); }
    })();
    return stopping;
  }
  function showWindow() {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  function secureContents(contents, origin) {
    const local = url => { try { const parsed = new URL(url); return parsed.protocol === 'http:' && parsed.origin === origin; } catch { return false; } };
    const navigate = (event, url) => {
      if (local(url)) return;
      event.preventDefault(); external(url);
    };
    const external = url => {
      try {
        if (['http:', 'https:'].includes(new URL(url).protocol)) {
          Promise.resolve(shell.openExternal(url)).catch(error => record(`外部链接打开失败：${error.message}`));
        }
      } catch { /* Invalid URLs and other protocols are rejected. */ }
    };
    contents.on('will-navigate', navigate);
    contents.on('will-redirect', navigate);
    contents.setWindowOpenHandler(({ url }) => {
      if (local(url)) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...webPreferences } } };
      external(url); return { action: 'deny' };
    });
    contents.on('did-create-window', child => secureContents(child.webContents, origin));
  }
  async function createWindow() {
    if (window && !window.isDestroyed()) { showWindow(); return; }
    if (openingWindow) return openingWindow;
    openingWindow = (async () => {
      const { readSettings } = await import(pathToFileURL(path.join(root, 'src/settings.mjs')).href);
      const { ui } = await readSettings(config.dataDir, record);
      const backgrounds = { threepane: '#ffffff', bento: '#f3efe8', editorial: '#f7f4ee', shelf: '#2b2118' };
      if (stopping) return;
      window = new BrowserWindow({ width: 1280, height: 860, minWidth: 960, minHeight: 640,
        title: 'CO-AGENT', icon: path.join(root, 'assets', 'brand', 'co-agent.ico'),
        backgroundColor: backgrounds[ui], show: false, webPreferences: { ...webPreferences, plugins: true } }); // plugins: Chromium's PDF viewer for original books (v0.41)
      secureContents(window.webContents, origin);
      const created = window;
      // Alt+Enter toggles full screen anywhere in the app, dialogs included (2026-10-15).
      created.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'Enter' || !input.alt || input.control || input.shift || input.meta) return;
        event.preventDefault();
        if (!created.isDestroyed()) created.setFullScreen(!created.isFullScreen());
      });
      // Shown by revealMain: at once, or after the splash has played (or been clicked away).
      created.once('ready-to-show', () => { if (!stopping && !created.isDestroyed() && window === created) { mainReady = true; revealMain(); } });
      await created.loadURL(`${origin}/`);
    })();
    try { await openingWindow; } finally { openingWindow = undefined; }
  }
  async function ensureDaily() {
    if (!ownedServer?.concepts) throw new Error('无法向现有服务器提交每日概念：未持有概念服务实例');
    return ownedServer.concepts.ensureDaily();
  }
  function secondInstance(_event, commandLine = []) {
    if (commandLine.includes('--daily-concept')) {
      if (!origin) { pendingDaily = true; return; }
      void ensureDaily().catch(error => record(`每日概念错误：${error.message}`));
      return;
    }
    if (!origin) { pendingWindow = true; return; }
    if (window && !window.isDestroyed()) showWindow();
    else void createWindow().catch(errorBox);
  }
  const ready = (async () => {
    // Electron requires these paths/switches before ready: do this before the first await.
    const dataDir = path.resolve(env.CO_AGENT_DATA_DIR || env.AGENT_HUB_DATA_DIR ||
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CO-AGENT'));
    // v0.50: configured folders (launch project, Reading, archives) are checked by loadConfig once config.json is read.
    for (const protectedDir of [root, path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude')]) {
      const relative = path.relative(path.resolve(protectedDir), dataDir);
      if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        throw new Error(`运行数据目录位于仓库或只读来源内：${dataDir}`);
      }
    }
    const dataDirWasAbsent = !fs.existsSync(dataDir);
    fs.mkdirSync(path.join(dataDir, 'crashes'), { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
    app.setPath('crashDumps', path.join(dataDir, 'crashes'));
    if (!app.requestSingleInstanceLock()) { quitting = true; if (headless) app.exit(0); else app.quit(); return; }
    app.setAppUserModelId('com.asterhouse.coagent');
    for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync', 'no-default-browser-check']) app.commandLine.appendSwitch(flag);
    app.on('second-instance', secondInstance);
    // Closing the splash before the main window exists (e.g. a failed splash load) must not quit the app.
    app.on('window-all-closed', () => { if (!windowless && window) void stop(); });
    app.on('before-quit', event => { if (!quitting) { event.preventDefault(); stop(); } });
    const { loadConfig } = await importConfig(); config = await loadConfig({ env, dataDirWasAbsent });
    if (path.resolve(config.dataDir) !== dataDir) throw new Error('Electron 数据目录与服务器配置不一致');
    await app.whenReady();
    if (stopping) return;
    openSplash();
    const { startServer } = await importServer();
    if (stopping) return;
    startingServer = Promise.resolve().then(() => startServer(config, { output: message => record(message), ...(headless ? { conceptAutoDaily: false } : {}),
      // v0.42: reading time counts only while someone is at the computer; the system's idle time also sees the PDF viewer.
      ...(electron.powerMonitor ? { bookOptions: { systemIdle: () => electron.powerMonitor.getSystemIdleTime() } } : {}) })).then(result => {
      if (!result.alreadyRunning) ownedServer = result.app;
      return result;
    });
    const result = await startingServer;
    if (result.exitCode !== 0) throw new Error(`本地服务器启动失败（退出码 ${result.exitCode}）`);
    if (!result.alreadyRunning) {
      if (!result.app) throw new Error('本地服务器未返回有效实例');
    }
    if (stopping) return;
    const port = result.alreadyRunning ? config.port : ownedServer.server.address().port;
    origin = `http://127.0.0.1:${port}`;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // Prevent remote subresources/background fetches as well as remote navigations.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = (url.protocol === 'http:' && url.origin === origin) ||
          (!!splashUrl && url.protocol === 'file:' && url.href.split('#')[0] === splashUrl) ||
          (url.protocol === 'chrome-extension:' && url.host === PDF_VIEWER_EXTENSION_HOST) ||
          (url.protocol === 'chrome:' && url.host === CHROME_RESOURCES_HOST);
      } catch { /* deny */ }
      callback({ cancel: !allowed });
    });
    Menu.setApplicationMenu(null);
    if (!headless || pendingWindow) await createWindow();
    if (headless) {
      let timer;
      dailyWork = Promise.race([ensureDaily(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('每日概念无头运行超过 50 分钟')), dailyTimeoutMs);
      })]);
      try {
        const daily = await dailyWork;
        exitCode = ['done', 'exists', 'not-due', 'retry-wait'].includes(daily?.status) ? 0 : 1;
        await record(`每日概念无头运行结束：${daily?.status || 'unknown'} exit=${exitCode}`);
      } finally { clearTimeout(timer); }
      if (window && !window.isDestroyed()) { windowless = false; await record('每日概念无头运行结束：窗口已打开，转为普通运行'); }
      else await stop();
    } else if (pendingDaily) void ensureDaily().catch(error => record(`每日概念错误：${error.message}`));
  })().catch(async error => { await errorBox(error); await stop(); });
  return { ready, stop, get window() { return window; } };
}

module.exports = { createMain };

if (require.main === module) {
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  let logger;
  createMain({ electron: require('electron'), importServer: () => load('src/server.mjs'), importConfig: () => load('src/config.mjs'),
    splashFile: path.join(root, 'electron', 'splash.html'),
    log: async (message, config) => {
      if (!config) return;
      if (!logger) logger = (await load('src/log.mjs')).createLogger(config.dataDir);
      await logger(message);
    } });
}
