import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadTaskContracts, taskContractsFile, requiresTaskFormat, projectRoot, recommendSettings } from './config.mjs';
import { catalogFile } from './catalog.mjs';
import { buildRegistry } from './registry/classify.mjs';
import { createReports } from './reports/index.mjs';
import { createBooks } from './books/index.mjs';
import { createLaunch } from './launch/spec.mjs';
import { verifyLaunch } from './launch/verify.mjs';
import { createStats } from './stats/index.mjs';
import { createWorkflows } from './recommend/workflows.mjs';
import { createSessions } from './launch/history.mjs';
import { createResume } from './launch/resume.mjs';
import { createLogger } from './log.mjs';
import { readSettings, writeSettings, validUi, validBookText, uiOptions, BOOK_TEXT, READER_PREFS, validReaderPrefs, DEPTH_OPTIONS, validDepth } from './settings.mjs';
import { readPins, writePins, validPins } from './pins.mjs';
import { createConcepts } from './concepts/index.mjs';
import { openAgent, createOpener } from './open.mjs';
import { createBackup } from './backup.mjs';
import { createBasicConfig } from './basic-config.mjs';
import { createSeminars } from './seminars/index.mjs';
import { createConsults } from './consults/index.mjs';
import { createChats } from './chat/index.mjs';
import { roomContext } from './chat/origin.mjs';
import { createCouncils } from './councils/index.mjs';
import { createConceptMap } from './conceptMap/index.mjs';
import { createCloser } from './close.mjs';
import { createGroups } from './groups.mjs';
import { createCandidates } from './registry/candidates.mjs';
import { createAgentLists } from './registry/lists.mjs';
import { startBookMaker } from './bookmaker.mjs';
import { missingSourcesFor } from '../public/display.js';

const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

const publicDir = path.join(projectRoot, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function send(res, code, value, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function readBody(req, maximum = 32768) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('请求体必须是 JSON'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 请求体无效'), { status: 400 }); }
}

export async function createApp(config, { spawnImpl, opener, recommendSpawnImpl, recommendRunner, jointVerifier, isAlive, queryIdentity, listeningServer, registryBuilder = buildRegistry, verifier = verifyLaunch, statsFactory = createStats,
  conceptsFactory = createConcepts, conceptOptions = {}, conceptAutoDaily = config.concept?.autoDaily === true, conceptTimers = { setInterval, clearInterval },
  seminarsFactory = createSeminars, seminarOptions = {}, consultOptions = {}, councilOptions = {}, chatOptions = {}, conceptMapOptions = {}, closeOptions = {}, candidateOptions = {}, reportOptions = {}, bookOptions = {}, backupOptions = {}, basicConfigOptions = {}, statsRefreshMs = 600000 } = {}) {
  config.taskContracts = await loadTaskContracts(taskContractsFile(config));
  const token = randomBytes(32).toString('hex'), startedAt = new Date().toISOString(), log = createLogger(config.dataDir);
  // v0.50: the default launch folder lives in the data dir and is created on first use; a configured one must already exist.
  if (path.resolve(config.launchProject) === path.join(config.dataDir, 'workspace')) await fs.mkdir(config.launchProject, { recursive: true });
  const basicConfig = createBasicConfig(config, basicConfigOptions);
  let settings = await readSettings(config.dataDir, log), settingsWork = Promise.resolve();
  let pins = await readPins(config.dataDir, log), pinsWork = Promise.resolve();
  const settingsResponse = () => ({ ...settings, uiOptions, bookTextRange: BOOK_TEXT, readerRange: READER_PREFS, depthOptions: DEPTH_OPTIONS, recommend: { claude: config.recommend.claude, codex: recommendSettings(config, 'codex') },
    terminal: { display: config.terminalDisplay, windowMode: config.terminalWindowMode } });
  if (config.dataDirMigration) await log(`迁移：${config.dataDirMigration}`);
  // v0.21: book agents carry their Word reports (newest matching .docx per mapped book).
  const reports = createReports({ mappingFile: catalogFile(config, 'reports'), ...reportOptions });
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry, ...bookOptions });
  const loadRegistry = async () => {
    const value = await registryBuilder(config, { io: candidateOptions.io });
    await reports.load().catch(error => log(`Word 报告索引错误：${error.message}`).catch(() => {}));
    const coverage = reports.coverage(value.agents);
    return { ...value, reports: coverage, summary: { ...value.summary, reportsMissing: coverage.booksWithout.length },
      agents: value.agents.map(agent => ({ ...agent, taskFormat: requiresTaskFormat(agent.name, config),
        ...(agent.kind === 'book' ? { reports: reports.describe(agent.id, agent) } : {}) })) };
  };
  let registry = await loadRegistry();
  const sessions = createSessions(config, { verifier, jointVerifier, isAlive, queryIdentity, log });
  const closer = createCloser(config, sessions, { isAlive, ...closeOptions });
  await sessions.recover();
  const workflows = createWorkflows(config, () => registry, { spawnImpl, recommendSpawnImpl, recommendRunner, jointVerifier, sessions });
  const groups = createGroups(config, () => registry);
  await workflows.recover();
  const concepts = conceptsFactory(config, () => registry, conceptOptions);
  await concepts.recover();
  const seminars = seminarsFactory(config, () => registry, seminarOptions);
  await seminars.recover();
  const consults = createConsults(config, () => registry, consultOptions);
  // v0.39 在 CO-AGENT 中调用. 在终端中继续 registers its resume like any other launch.
  const chats = createChats(config, { getRegistry: () => registry, log, contextFor: origin => roomContext(origin, { seminars, consults }), ...chatOptions,
    createResumeImpl: async (original, session) => {
      const record = await createResume(original, session, config, { spawnImpl });
      await sessions.register('launch', record); refreshStats();
      return { launchId: record.launchId, cli: record.cli, agentName: record.agentName, argvPreview: record.argvPreview, terminalFallback: record.terminalFallback };
    } });
  await consults.recover();
  const councils = createCouncils(config, () => registry, councilOptions);
  await councils.recover();
  const conceptMap = createConceptMap(config, { getConcepts: () => concepts.allRecords(), getSeminars: () => seminars.allRecords(), ...conceptMapOptions });
  await conceptMap.recover();
  let conceptTimer;
  const catchUpConcept = () => concepts.ensureDaily().catch(error => log(`每日概念错误：${error.message}`).catch(() => {}));
  const stats = statsFactory(config, registry.agents);
  let statsWork;
  const refreshStats = () => { statsWork = stats.refresh().catch(() => {}); };
  let registryWork = Promise.resolve();
  const reloadRegistry = () => {
    const next = registryWork.then(async () => { registry = await loadRegistry(); stats.setAgents(registry.agents); refreshStats(); return registry; });
    registryWork = next.catch(() => {}); return next;
  };
  const backup = createBackup(config, { version, opener: opener ?? createOpener(), log, ...backupOptions });
  const candidates = createCandidates(config, () => registry, { ...candidateOptions, onChanged: reloadRegistry });
  const agentLists = createAgentLists(config, () => registry, { onChanged: reloadRegistry });
  const launchFromBody = async (body, rerunOf) => {
    if (!body || typeof body.agentId !== 'string' || !['claude', 'codex'].includes(body.cli)) throw Object.assign(new Error('agentId 或 CLI 无效'), { status: 400 });
    const agent = registry.agents.find(a => a.id === body.agentId);
    if (!agent) throw Object.assign(new Error('该 Agent 不在范围内注册表中'), { status: 400 });
    if (!agent.platforms[body.cli]?.available) throw Object.assign(new Error(agent.platforms[body.cli]?.reason || '平台不可用'), { status: 409 });
    if (agent.writable && body.writableConfirmed !== true) throw Object.assign(new Error('存在可写 Agent，请先确认权限'), { status: 409, writable: [{ id: agent.id, name: agent.name }] });
    if (missingSourcesFor(agent, body.cli).length && body.sourcesConfirmed !== true) throw Object.assign(new Error('原书路径失效，请先确认'), { status: 409 });
    let launch;
    try { launch = await createLaunch(agent, body.cli, config, { spawnImpl, rerunOf }); }
    catch (error) { throw Object.assign(new Error(`启动失败：${error.message}`), { status: 409 }); }
    await sessions.register('launch', launch); refreshStats();
    const { launchId, cli, agentName, mode, argvPreview, notice, terminalFallback } = launch;
    return { launchId, cli, agentName, mode, argvPreview, notice, terminalFallback };
  };
  refreshStats();
  let sessionTimer, sessionWork, statsTimer, closing = false;
  const pollSessions = () => {
    sessionWork = sessions.refresh().catch(error => log(`核验错误：${error.message}`)).finally(() => {
      if (!closing) { sessionTimer = setTimeout(pollSessions, config.verifyPollMs); sessionTimer.unref(); }
    });
  };
  const server = listeningServer || http.createServer();
  server.on('request', async (req, res) => {
    try {
      const port = server.address()?.port || config.port;
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { send(res, 421, { error: 'Host 不属于本服务' }); return; }
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const provided = req.headers['x-co-agent-token'] ?? req.headers['x-agent-hub-token'];
        if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
          send(res, 403, { error: '启动 token 无效' }); return;
        }
        if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
          send(res, 403, { error: 'Origin 不属于本服务' }); return;
        }
      }
      let pathname;
      // Decode once for every route, including book IDs. Malformed escapes are always 404.
      try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); }
      catch { send(res, 404, { error: '路径无效' }); return; }
      if (!pathname.startsWith('/') || pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) {
        send(res, 403, { error: '禁止路径穿越' }); return;
      }
      if (req.method === 'GET' && pathname === '/api/health') { send(res, 200, { app: 'CO-AGENT', version, pid: process.pid, startedAt, dataDir: config.dataDir }); return; }
      if (req.method === 'GET' && pathname === '/api/concept-map') { send(res, 200, await conceptMap.list()); return; }
      if (req.method === 'POST' && pathname === '/api/concept-map/organize') { send(res, 202, await conceptMap.organize()); return; }
      if (req.method === 'PUT' && pathname === '/api/concept-map/manual') { send(res, 200, await conceptMap.manual(await readBody(req))); return; }
      if (req.method === 'GET' && /^\/api\/concept-map\/[^/]+$/.test(pathname)) { send(res, 200, await conceptMap.get(pathname.split('/')[3])); return; }
      if (req.method === 'GET' && pathname === '/api/concepts/thread') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        if (query.has('limit') && (!/^[1-9]\d?$/.test(query.get('limit')) || query.getAll('limit').length !== 1)) throw Object.assign(new Error('limit 必须为 1–60 的整数'), { status: 400 });
        send(res, 200, await concepts.thread(query.has('limit') ? Number(query.get('limit')) : 30)); return;
      }
      if (req.method === 'GET' && pathname === '/api/concepts') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        send(res, 200, await concepts.list(query.has('limit') ? Number(query.get('limit')) : 30)); return;
      }
      if (req.method === 'POST' && pathname === '/api/concepts') { send(res, 202, await concepts.startManual(await readBody(req))); return; }
      if (req.method === 'POST' && /^\/api\/concepts\/[^/]+\/term$/.test(pathname)) {
        send(res, 202, await concepts.backfillTerm(pathname.split('/')[3])); return;
      }
      if (req.method === 'GET' && pathname === '/api/seminars') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        send(res, 200, await seminars.list(query.has('limit') ? Number(query.get('limit')) : 30)); return;
      }
      if (req.method === 'POST' && pathname === '/api/seminars') { send(res, 202, await seminars.start(await readBody(req))); return; }
      if (req.method === 'GET' && pathname === '/api/consults') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const limit = query.has('limit') && /^\d+$/.test(query.get('limit')) ? Number(query.get('limit')) : query.has('limit') ? NaN : 30;
        send(res, 200, await consults.list(limit)); return;
      }
      if (req.method === 'POST' && pathname === '/api/consults') { send(res, 202, await consults.start(await readBody(req))); return; }
      if (pathname === '/api/chats' || pathname.startsWith('/api/chats/')) {
        const [, , , id, verb] = pathname.split('/');
        if (req.method === 'GET' && !id) { send(res, 200, await chats.list()); return; }
        if (req.method === 'POST' && !id) { send(res, 202, await chats.start(await readBody(req))); return; }
        if (req.method === 'POST' && id === 'rewrite' && !verb) { send(res, 200, await chats.rewrite(await readBody(req))); return; }
        if (req.method === 'GET' && id && !verb) { send(res, 200, await chats.get(id)); return; }
        if (req.method === 'POST' && id && ['ask', 'stop', 'retry', 'terminal'].includes(verb)) { send(res, verb === 'ask' ? 202 : 200, await chats[verb](id, await readBody(req))); return; }
        send(res, 404, { error: '接口不存在' }); return;
      }
      if (pathname === '/api/councils') {
        if (req.method === 'GET') { send(res, 200, await councils.list()); return; }
        if (req.method === 'POST') { send(res, 201, await councils.create(await readBody(req))); return; }
      }
      if (/^\/api\/councils\/[^/]+$/.test(pathname)) {
        const id = pathname.split('/')[3];
        if (req.method === 'GET') { send(res, 200, await councils.get(id)); return; }
        if (req.method === 'PUT') { send(res, 200, await councils.update(id, await readBody(req))); return; }
        if (req.method === 'DELETE') { send(res, 200, await councils.delete(id)); return; }
      }
      if (req.method === 'POST' && /^\/api\/councils\/[^/]+\/sessions$/.test(pathname)) {
        send(res, 202, await councils.start(pathname.split('/')[3], await readBody(req))); return;
      }
      if (req.method === 'GET' && /^\/api\/councils\/[^/]+\/sessions\/[^/]+$/.test(pathname)) {
        const parts = pathname.split('/'); send(res, 200, await councils.getSession(parts[3], parts[5])); return;
      }
      if (req.method === 'POST' && /^\/api\/councils\/[^/]+\/undo$/.test(pathname)) {
        send(res, 200, await councils.undo(pathname.split('/')[3])); return;
      }
      if (/^\/api\/consults\/[^/]+$/.test(pathname)) {
        if (req.method === 'GET') { send(res, 200, await consults.get(pathname.split('/')[3])); return; }
        if (req.method === 'DELETE') { send(res, 200, await consults.delete(pathname.split('/')[3])); return; }
      }
      if (req.method === 'GET' && /^\/api\/seminars\/[^/]+$/.test(pathname)) { send(res, 200, await seminars.get(pathname.split('/')[3])); return; }
      if (req.method === 'POST' && /^\/api\/concepts\/[^/]+\/perspectives$/.test(pathname)) {
        send(res, 202, await concepts.startPerspectives(pathname.split('/')[3], await readBody(req))); return;
      }
      if (req.method === 'GET' && /^\/api\/concepts\/[^/]+$/.test(pathname)) { send(res, 200, await concepts.get(pathname.split('/')[3])); return; }
      if (req.method === 'GET' && pathname === '/api/running') { send(res, 200, await sessions.running()); return; }
      if (req.method === 'POST' && pathname === '/api/running/close') { send(res, 200, await closer.close(await readBody(req))); return; }
      if (req.method === 'GET' && pathname === '/api/history') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        send(res, 200, await sessions.allHistory({ type: query.get('type') ?? 'all', limit: query.has('limit') ? Number(query.get('limit')) : 50 })); return;
      }
      if (req.method === 'POST' && pathname === '/api/history/rerun') {
        const body = await readBody(req);
        const { record } = await sessions.originalRecord(body?.type, body?.id, false);
        const confirmations = { writableConfirmed: body.writableConfirmed, sourcesConfirmed: body.sourcesConfirmed };
        if (body.type === 'joint') {
          send(res, 200, await workflows.startJoint(confirmations, { originalJoint: record }));
          refreshStats();
        } else send(res, 200, await launchFromBody({ agentId: record.agentId || registry.agents.find(a => a.name === record.agentName || a.platforms.claude.name === record.agentName)?.id, cli: record.cli, ...confirmations }, body.id));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/history/reverify-all') {
        send(res, 200, await sessions.reverify(registry.agents.map(a => a.id), { allJoints: true })); return;
      }
      if (req.method === 'POST' && /^\/api\/history\/[^/]+\/reverify$/.test(pathname)) {
        const agentId = pathname.split('/')[3];
        if (!registry.agents.some(a => a.id === agentId)) { send(res, 404, { error: '该 Agent 不在范围内注册表中' }); return; }
        const { summary } = await sessions.reverify([agentId]);
        send(res, 200, { summary, history: await sessions.history(agentId) }); return;
      }
      if (req.method === 'GET' && pathname.startsWith('/api/history/')) {
        const agentId = pathname.slice('/api/history/'.length);
        if (!registry.agents.some(a => a.id === agentId)) { send(res, 404, { error: '该 Agent 不在范围内注册表中' }); return; }
        send(res, 200, await sessions.history(agentId)); return;
      }
      if (req.method === 'POST' && pathname === '/api/resume') {
        const body = await readBody(req);
        if (body?.type === 'joint') {
          const original = await sessions.originalRecord('joint', body.id);
          const agents = original.record.whitelist.map(a => registry.agents.find(current => current.id === a.id));
          if (agents.some(a => !a?.platforms[original.record.cli]?.available)) { send(res, 409, { error: '原 CLI 中存在不可用 Agent' }); return; }
          if (agents.some(a => a.writable) && body.writableConfirmed !== true) { send(res, 409, { error: '存在可写 Agent，请先确认权限' }); return; }
          if (agents.some(a => missingSourcesFor(a, original.record.cli).length) && body.sourcesConfirmed !== true) { send(res, 409, { error: '原书路径失效，请先确认' }); return; }
          const record = await createResume(original.record, original.session, config, { spawnImpl });
          await sessions.register('joint', record); refreshStats();
          send(res, 200, { jointId: record.jointId, cli: record.cli, resumeOf: record.resumeOf, argvPreview: record.argvPreview, terminalFallback: record.terminalFallback }); return;
        }
        if (body?.type && body.type !== 'launch') { send(res, 400, { error: '恢复类型无效' }); return; }
        const agent = registry.agents.find(a => a.id === body?.agentId);
        if (!agent || typeof body.launchId !== 'string') { send(res, 400, { error: '恢复参数无效' }); return; }
        const original = await sessions.original(agent.id, body.launchId);
        if (!agent.platforms[original.record.cli]?.available) { send(res, 409, { error: '原 CLI 入口不可用' }); return; }
        if (agent.writable && body.writableConfirmed !== true) { send(res, 409, { error: '存在可写 Agent，请先确认权限', writable: [{ id: agent.id, name: agent.name }] }); return; }
        if (missingSourcesFor(agent, original.record.cli).length && body.sourcesConfirmed !== true) { send(res, 409, { error: '原书路径失效，请先确认' }); return; }
        const record = await createResume(original.record, original.session, config, { spawnImpl });
        await sessions.register('launch', record); refreshStats();
        send(res, 200, { launchId: record.launchId, cli: record.cli, agentName: record.agentName, mode: record.mode, resumeOf: record.resumeOf,
          argvPreview: record.argvPreview, terminalFallback: record.terminalFallback }); return;
      }
      if (req.method === 'GET' && pathname === '/api/registry') { send(res, 200, registry); return; }
      if (req.method === 'GET' && pathname.startsWith('/api/reports/')) {
        const [id, index, extra] = pathname.slice('/api/reports/'.length).split('/');
        if (extra !== undefined || !/^\d{1,3}$/.test(index || '') || !registry.agents.some(agent => agent.id === id && agent.kind === 'book')) {
          send(res, 404, { error: '未找到该 Word 报告' }); return;
        }
        send(res, 200, await reports.read(id, Number(index), registry.agents.find(agent => agent.id === id))); return;
      }
      // v0.41 在软件中阅读原书: outline, chapters and images of an EPUB, the PDF for the embedded viewer, and reading positions.
      if (req.method === 'GET' && pathname.startsWith('/api/books/')) {
        const [agentId, index, verb, chapter, extra] = pathname.slice('/api/books/'.length).split('/');
        if (!/^\d{1,3}$/.test(index || '') || extra !== undefined) { send(res, 404, { error: '没有这本原书' }); return; }
        const i = Number(index);
        if (verb === undefined) { send(res, 200, await books.info(agentId, i)); return; }
        if (verb === 'chapters' && /^\d{1,6}$/.test(chapter || '')) { send(res, 200, await books.chapter(agentId, i, Number(chapter))); return; }
        if (verb === 'assets' && chapter === undefined) {
          const asset = await books.asset(agentId, i, new URL(req.url, 'http://localhost').searchParams.get('path'));
          send(res, 200, asset.data, asset.type); return;
        }
        if (verb === 'pdf' && chapter === undefined) {
          const file = await books.pdf(agentId, i);
          // Only this app may frame it; no object-src limit here, or Chromium's PDF viewer would be refused.
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': file.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "frame-ancestors 'self'" });
          await pipeline(createReadStream(file.path), res); return;
        }
        send(res, 404, { error: '没有这本原书' }); return;
      }
      // v0.42 书本检视: pages, weight and hours of the pulled-out book; the open reader's heartbeat adds reading time.
      if (req.method === 'GET' && /^\/api\/book-facts\/[^/]+$/.test(pathname)) { send(res, 200, await books.facts(pathname.split('/')[3])); return; }
      if (req.method === 'POST' && /^\/api\/reading-time\/[^/]+$/.test(pathname)) { send(res, 200, await books.addReadingTime(pathname.split('/')[3], await readBody(req))); return; }
      if (/^\/api\/reading-progress\/[^/]+$/.test(pathname) && (req.method === 'GET' || req.method === 'PUT')) {
        const agentId = pathname.split('/')[3];
        send(res, 200, req.method === 'GET' ? { progress: await books.progress(agentId) } : { progress: await books.saveProgress(agentId, await readBody(req)) }); return;
      }
      // v0.52 Agent 管理: tools, books and categories listed in the app (data dir), and new agent files.
      if (req.method === 'GET' && pathname === '/api/agent-lists') { send(res, 200, await agentLists.describe()); return; }
      if (req.method === 'POST' && pathname === '/api/agent-lists') { send(res, 200, await agentLists.change(await readBody(req))); return; }
      // v0.53 制作书籍 Agent: an a-deepbooker session in Windows Terminal with the book as its first task.
      if (req.method === 'POST' && pathname === '/api/book-maker') {
        const launch = await startBookMaker(await readBody(req), registry, config, { spawnImpl });
        await sessions.register('launch', launch); refreshStats();
        const { launchId, cli, agentName, mode, notice, terminalFallback } = launch;
        send(res, 200, { launchId, cli, agentName, mode, notice, terminalFallback }); return;
      }
      if (req.method === 'POST' && pathname === '/api/agent-files') { send(res, 200, await agentLists.importFile(await readBody(req, 1024 * 1024))); return; }
      // v0.50 基本配置: saved to config.json, applied after a restart.
      if (req.method === 'GET' && pathname === '/api/config') { send(res, 200, await basicConfig.describe()); return; }
      if (req.method === 'POST' && pathname === '/api/config') { send(res, 200, await basicConfig.save(await readBody(req))); return; }
      // v0.49 备份: one ZIP of the records and the code history in backup.dir, revealed in Explorer.
      if (req.method === 'POST' && pathname === '/api/backup') { send(res, 200, await backup.start()); return; }
      if (req.method === 'POST' && pathname === '/api/open') {
        const result = await openAgent(await readBody(req), registry.agents, { opener, log });
        send(res, result.status, result.body); return;
      }
      if (req.method === 'GET' && pathname === '/api/settings') {
        send(res, 200, settingsResponse()); return;
      }
      if (req.method === 'PUT' && pathname === '/api/settings') {
        const body = await readBody(req);
        // Each field may come alone: the layout picker sends ui, the text-size slider bookText, the readers' 排版 panel reader
        // (v0.53.14; its fields may come alone too and are merged into the saved ones).
        if (!body || Array.isArray(body) || (body.ui === undefined && body.bookText === undefined && body.reader === undefined && body.depth === undefined)) { send(res, 400, { error: '设置无效' }); return; }
        if (body.ui !== undefined && !validUi(body.ui)) { send(res, 400, { error: '界面风格无效' }); return; }
        if (body.bookText !== undefined && !validBookText(body.bookText)) { send(res, 400, { error: '书本描述字号无效' }); return; }
        if (body.reader !== undefined && !validReaderPrefs(body.reader, { partial: true })) { send(res, 400, { error: '阅读排版设置无效' }); return; }
        if (body.depth !== undefined && !validDepth(body.depth)) { send(res, 400, { error: '微立体设置无效' }); return; }
        const work = settingsWork.then(async () => {
          settings = await writeSettings(config.dataDir, body.ui ?? settings.ui, body.bookText ?? settings.bookText, { ...settings.reader, ...body.reader }, body.depth ?? settings.depth);
          return settingsResponse();
        });
        settingsWork = work.catch(() => {});
        send(res, 200, await work); return;
      }
      // v0.29 常用 Agent.
      if (req.method === 'GET' && pathname === '/api/pins') { send(res, 200, { ids: pins }); return; }
      if (req.method === 'PUT' && pathname === '/api/pins') {
        const body = await readBody(req);
        if (!body || Array.isArray(body) || !validPins(body.ids)) { send(res, 400, { error: '常用 Agent 列表无效' }); return; }
        const work = pinsWork.then(async () => { pins = await writePins(config.dataDir, body.ids); return { ids: pins }; });
        pinsWork = work.catch(() => {});
        send(res, 200, await work); return;
      }
      if (req.method === 'POST' && pathname === '/api/recommend') { send(res, 200, await workflows.startRecommendation(await readBody(req))); return; }
      if (req.method === 'GET' && pathname.startsWith('/api/recommend/')) { send(res, 200, await workflows.recommendation(pathname.slice('/api/recommend/'.length))); return; }
      if (req.method === 'POST' && pathname === '/api/joint') { send(res, 200, await workflows.startJoint(await readBody(req))); refreshStats(); return; }
      // v0.14 调用组 (saved joint-call groups with preset questions).
      if (pathname === '/api/groups' || pathname.startsWith('/api/groups/')) {
        const [, , , id, sub, presetId, extra] = pathname.split('/');
        if (extra !== undefined) { send(res, 404, { error: '接口不存在' }); return; }
        if (!id && req.method === 'GET') { send(res, 200, await groups.list()); return; }
        if (!id && req.method === 'POST') { send(res, 200, await groups.create(await readBody(req))); return; }
        if (id && !sub && req.method === 'GET') { send(res, 200, await groups.get(id)); return; }
        if (id && !sub && req.method === 'PUT') { send(res, 200, await groups.update(id, await readBody(req))); return; }
        if (id && !sub && req.method === 'DELETE') { send(res, 200, await groups.remove(id)); return; }
        if (id && sub === 'presets' && !presetId && req.method === 'POST') { send(res, 200, await groups.addPreset(id, await readBody(req))); return; }
        if (id && sub === 'presets' && presetId && req.method === 'PUT') { send(res, 200, await groups.updatePreset(id, presetId, await readBody(req))); return; }
        if (id && sub === 'presets' && presetId && req.method === 'DELETE') { send(res, 200, await groups.removePreset(id, presetId)); return; }
        if (id && sub === 'run' && !presetId && req.method === 'POST') {
          const body = await readBody(req), group = await groups.get(id);
          if (!body || typeof body !== 'object') { send(res, 400, { error: '运行参数无效' }); return; }
          const cli = body.cli ?? group.cli;
          const result = await workflows.startJoint({ input: body.input, cli, crossExam: body.crossExam, writableConfirmed: body.writableConfirmed, sourcesConfirmed: body.sourcesConfirmed }, { group });
          // Saved only after a successful start: a 409 confirmation round-trip must not store the question twice.
          let preset = null, presetError = null;
          if (body.savePreset) try { preset = await groups.addPreset(id, { text: body.input, title: body.presetTitle }); } catch (error) { presetError = error.message; }
          await groups.markRun(id); refreshStats();
          send(res, 200, { ...result, group: { id: group.id, name: group.name }, preset, presetError }); return;
        }
        send(res, 404, { error: '接口不存在' }); return;
      }
      if (req.method === 'GET' && pathname.startsWith('/api/joint/')) { send(res, 200, await workflows.joint(pathname.slice('/api/joint/'.length))); return; }
      if (req.method === 'GET' && pathname === '/api/recent') { send(res, 200, await workflows.recent()); return; }
      if (req.method === 'GET' && pathname === '/api/stats') { send(res, 200, stats.snapshot()); return; }
      if (req.method === 'POST' && pathname === '/api/stats/refresh') {
        stats.setAgents(registry.agents); refreshStats(); send(res, 200, stats.snapshot()); return;
      }
      if (req.method === 'POST' && pathname === '/api/refresh') {
        send(res, 200, await reloadRegistry()); return;
      }
      if (req.method === 'GET' && pathname === '/api/candidates/ignored') { send(res, 200, await candidates.ignored()); return; }
      if (req.method === 'POST' && ['/api/candidates/suggest', '/api/candidates/accept', '/api/candidates/ignore', '/api/candidates/unignore'].includes(pathname)) {
        const operation = pathname.split('/')[3];
        // 50 entries × 3 fields × 300 Unicode characters may exceed 32 KiB.
        send(res, 200, await candidates[operation](await readBody(req, operation === 'accept' ? 512 * 1024 : 32768))); return;
      }
      if (req.method === 'POST' && pathname === '/api/launch') {
        send(res, 200, await launchFromBody(await readBody(req))); return;
      }
      if (req.method === 'GET' && pathname.startsWith('/api/launch/')) {
        send(res, 200, await sessions.check('launch', pathname.slice('/api/launch/'.length))); return;
      }
      if (pathname.startsWith('/api/')) { send(res, 404, { error: '接口不存在' }); return; }
      if (req.method !== 'GET') { send(res, 405, { error: '方法不支持' }); return; }
      const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(publicDir + path.sep)) { send(res, 403, { error: '禁止路径穿越' }); return; }
      let real;
      try { real = await fs.realpath(file); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) { send(res, 404, { error: '文件不存在' }); return; } throw error; }
      if (!real.startsWith(publicDir + path.sep)) { send(res, 403, { error: '禁止符号链接越界' }); return; }
      let content = await fs.readFile(real);
      if (pathname === '/' || pathname === '/index.html') content = content.toString('utf8')
        .replace('<!-- AGENT_HUB_TOKEN -->', `<meta name="agent-hub-token" content="${token}">`)
        .replace('<!-- CO_AGENT_VERSION -->', version)
        .replace(/<html\b[^>]*>/i, `<html lang="zh-CN" data-ui="${settings.ui}" data-book-text="${settings.bookText}" data-depth="${settings.depth}">`);
      send(res, 200, content, mime[path.extname(file)] || 'application/octet-stream');
    } catch (error) {
      await log(`错误：${error.code || error.status || 'ERROR'} ${error.message}`).catch(() => {});
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : `服务错误：${error.message}`,
        ...(error.unavailable ? { unavailable: error.unavailable } : {}), ...(error.writable ? { writable: error.writable } : {}), ...(error.running ? { running: error.running } : {}), ...(error.sourcesConfirmed ? { sourcesConfirmed: true } : {}) });
      else res.end();
    }
  });
  return { server, token, backup, stats, workflows, sessions, concepts, seminars, consults, councils, chats, conceptMap, log, get registry() { return registry; },
    listen() { return new Promise((resolve, reject) => {
      const started = () => {
        log(`启动：CO-AGENT ${version} PID ${process.pid} http://127.0.0.1:${server.address().port}`).then(() => {
          pollSessions();
          if (statsRefreshMs > 0) { statsTimer = setInterval(refreshStats, statsRefreshMs); statsTimer.unref(); }
          if (conceptAutoDaily) { void catchUpConcept(); conceptTimer = conceptTimers.setInterval(catchUpConcept, 600000); conceptTimer.unref?.(); }
          resolve();
        }, reject);
      };
      if (server.listening) { started(); return; }
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        started();
      });
    }); },
    async close() { closing = true; clearTimeout(sessionTimer); clearInterval(statsTimer); conceptTimers.clearInterval(conceptTimer); await closer.idle(); await candidates.close(); await Promise.all([registryWork, concepts.close(), seminars.close(), consults.close(), councils.close(), chats.close(), conceptMap.close(), statsWork, sessionWork, settingsWork, pinsWork, books.idle(), workflows.idle(), sessions.idle()]); return new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
      // v0.33.1: all app work has finished; drop every remaining socket. An outside client that keeps a
      // connection busy (a browser tab polling /api/running) would otherwise hold close() open forever,
      // leaving a windowless process that owns the single-instance lock (2026-10-22).
      server.closeAllConnections();
    }); },
  };
}

export function probeHealth(port, { timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) { request.destroy(); finish(null); } });
      response.on('end', () => { try { finish(response.statusCode === 200 ? JSON.parse(body) : null); } catch { finish(null); } });
      response.on('error', () => finish(null));
    });
    const timer = setTimeout(() => { request.destroy(); finish(null); }, timeoutMs);
    request.on('error', () => finish(null));
  });
}
export async function startServer(config, { output = console.log, ...options } = {}) {
  // Bind before recovery/indexing: a second launch must not mutate the running app's records.
  const listeningServer = http.createServer(), log = createLogger(config.dataDir);
  let app;
  try {
    await new Promise((resolve, reject) => {
      listeningServer.once('error', reject);
      listeningServer.listen(config.port, '127.0.0.1', () => { listeningServer.removeListener('error', reject); resolve(); });
    });
    app = await createApp(config, { ...options, listeningServer });
    await app.listen(); output(`CO-AGENT：http://127.0.0.1:${app.server.address().port}`); return { app, exitCode: 0, alreadyRunning: false };
  }
  catch (error) {
    if (app) await app.close();
    else if (listeningServer.listening) await new Promise(resolve => listeningServer.close(resolve));
    if (error.code === 'EADDRINUSE') {
      const health = await probeHealth(config.port);
      if (health?.app === 'CO-AGENT') { await log('已在运行'); output('CO-AGENT 已在运行'); return { exitCode: 0, alreadyRunning: true }; }
      const occupied = new Error(`端口 ${config.port} 已被其他程序占用，CO-AGENT 无法启动；请释放该端口。`);
      await log(`错误：${occupied.message}`); throw occupied;
    }
    await log(`错误：${error.code || 'ERROR'} ${error.message}`); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = await loadConfig();
    const { app } = await startServer(config);
    if (app) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().catch(error => { console.error(error.message); process.exitCode = 1; }));
  } catch (error) { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; }
}
