import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { processAlive } from '../launch/verify.mjs';
import { missingSourcesFor } from '../../public/display.js';
import { runCouncilProcess, validateCouncil, synthesizeMemory, codexName } from './runner.mjs';
import { verifyCouncil } from './verify.mjs';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const active = r => ['queued', 'running'].includes(r.status);
const emptyMemory = () => ({ summary: '', recommendations: [], openItems: [], recentReports: [] });
const shortSession = ({ sessionId, councilId, status, error, createdAt, startedAt, finishedAt, undone, undoneAt }) =>
  ({ sessionId, councilId, status, error, createdAt, startedAt, finishedAt, undone, undoneAt });
const checkText = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) fail(400, `${label}必须为 1–${max} 字`);
};

export function createCouncils(config, getRegistry, { now = () => new Date(), runner = runCouncilProcess, verifier = verifyCouncil,
  spawnImpl, killTree, isAlive = processAlive, write = atomicWrite } = {}) {
  const dir = path.join(config.dataDir, 'councils'), councils = new Map(), sessions = new Map(), controllers = new Map(), work = new Set();
  const log = createLogger(config.dataDir, { file: 'councils.log' });
  let serial = Promise.resolve(), closed = false;
  const stamp = () => new Date(now()).toISOString();
  const saveCouncil = c => write(path.join(dir, `${c.councilId}.json`), JSON.stringify(c, null, 2) + '\n');
  const saveSession = s => write(path.join(dir, s.councilId, 'sessions', `${s.sessionId}.json`), JSON.stringify(s, null, 2) + '\n');
  function exclusive(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  function getCouncil(id) { if (!validId(id) || !councils.has(id)) fail(404, '顾问团不存在'); return councils.get(id); }
  const history = id => [...sessions.values()].filter(s => s.councilId === id).sort((a, b) => b.sequence - a.sequence);
  const running = () => [...sessions.values()].filter(s => active(s) || (s.pid && isAlive(s.pid)));
  function unlocked(id) { if (running().some(s => s.councilId === id)) fail(409, '该顾问团正在讨论'); }
  function members(ids) {
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) fail(400, '成员必须为 2–5 个不重复的书籍 Agent');
    const selected = ids.map(id => getRegistry().agents.find(a => a.id === id));
    if (selected.some(a => !a || a.kind !== 'book')) fail(400, '成员必须是注册表中的书籍 Agent');
    return selected;
  }
  function unique(name, id) {
    if ([...councils.values()].some(c => c.councilId !== id && c.name.toLowerCase() === name.trim().toLowerCase())) fail(409, '顾问团名字已存在');
  }
  function view(c) {
    const { memory, headSessionId, nextRecNumber, ...item } = c;
    return { ...item, running: running().find(s => s.councilId === c.councilId)?.sessionId || null,
      members: c.memberIds.map(id => {
        const a = getRegistry().agents.find(a => a.id === id && a.kind === 'book');
        const past = history(c.councilId).flatMap(s => s.memberSnapshot).find(a => a.id === id);
        return { id, name: a?.name || past?.name || id, codexName: a ? codexName(a) : past ? codexName(past) : id,
          book: a?.book || past?.book, available: !!a?.platforms?.codex?.available };
      }) };
  }
  // The council's head is the commit point. It also makes a two-file undo or
  // completion recoverable if the process exits between atomic file writes.
  async function reconcile(restarting = false) {
    for (const c of councils.values()) {
      const chain = new Set(); let id = c.headSessionId;
      while (id) {
        const s = sessions.get(id);
        if (!s || s.councilId !== c.councilId || chain.has(id)) throw new Error('顾问团讨论链损坏');
        chain.add(id); id = s.parentSessionId;
      }
      for (const s of history(c.councilId)) {
        if (controllers.has(s.sessionId)) continue;
        let dirty = false;
        if (chain.has(s.sessionId) && (s.commitPending || s.undone || s.status !== 'done')) {
          Object.assign(s, { status: 'done', commitPending: false, undone: false, undoneAt: null, error: null, pid: null }); dirty = true;
        } else if (!chain.has(s.sessionId) && s.commitPending) {
          Object.assign(s, { status: 'failed', commitPending: false, error: '提交中断，记忆未更新', finishedAt: stamp(), pid: null }); dirty = true;
        } else if (!chain.has(s.sessionId) && s.status === 'done' && !s.undone) {
          Object.assign(s, { undone: true, undoneAt: c.updatedAt }); dirty = true;
        } else if (active(s) && (restarting || !isAlive(s.pid) || Date.parse(s.startedAt || s.createdAt) < new Date(now()).getTime() - config.council.timeoutMs - 600000)) {
          Object.assign(s, { status: 'failed', error: restarting ? '应用重启，讨论中断' : '进程中断或超时未结束', finishedAt: stamp(), pid: isAlive(s.pid) ? s.pid : null }); dirty = true;
        } else if (s.status === 'failed' && s.pid && !isAlive(s.pid)) { s.pid = null; dirty = true; }
        if (dirty) {
          await saveSession(s);
          if (!s.pid && validId(s.sessionId)) await fs.rm(path.join(dir, c.councilId, 'work', s.sessionId), { recursive: true, force: true });
          await log(`${s.sessionId} reconcile ${s.error || s.status}`).catch(() => {});
        }
      }
    }
  }
  async function execute(s, controller) {
    try {
      await exclusive(async () => { s.status = 'running'; s.startedAt = stamp(); await saveSession(s); });
      const raw = await runner(s, config, { spawnImpl, killTree, signal: controller.signal,
        onSpawn: (pid, scrubbedEnv) => exclusive(async () => { Object.assign(s, { pid, scrubbedEnv }); await saveSession(s); }) });
      if (controller.signal.aborted) throw new Error('进程中断');
      const result = validateCouncil(raw, s);
      const c = getCouncil(s.councilId);
      const merged = synthesizeMemory(s.memoryBefore, result, s.report, stamp(), c.nextRecNumber);
      let verify;
      try { verify = await verifier({ ...s, result }, config); }
      catch (error) { verify = { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [], error: error.message }; }
      await exclusive(async () => {
        if (controller.signal.aborted) throw new Error('进程中断');
        const finishedAt = stamp();
        const done = { ...s, result, verify, status: 'done', pid: null, finishedAt, commitPending: true };
        await saveSession(done);
        const updated = { ...getCouncil(s.councilId), memory: merged.memory, nextRecNumber: merged.nextNumber,
          headSessionId: s.sessionId, sessionCount: c.sessionCount + 1, lastSessionAt: finishedAt, nextCheck: result.nextCheck, updatedAt: finishedAt };
        await saveCouncil(updated); // Nothing changes in memory before this succeeds.
        councils.set(c.councilId, updated); Object.assign(s, done, { commitPending: false });
        // The head already committed; a final status-write failure is recoverable.
        await saveSession(s).catch(error => log(`${s.sessionId} 状态待恢复：${error.message}`).catch(() => {}));
      });
      await log(`${s.sessionId} done`).catch(() => {});
    } catch (error) {
      await exclusive(async () => {
        Object.assign(s, { status: 'failed', result: null, commitPending: false, error: error.message,
          pid: error.processMayBeAlive && Number.isSafeInteger(error.pid) && error.pid > 0 ? error.pid : null, finishedAt: stamp() });
        await saveSession(s);
      });
      await log(`${s.sessionId} ${error.message}`).catch(() => {});
    }
  }
  return {
    async recover() {
      return exclusive(async () => {
        let entries;
        try { entries = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const file of entries) if (file.endsWith('.json') && validId(file.slice(0, -5))) {
          const c = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
          if (c.councilId !== file.slice(0, -5)) throw new Error('顾问团文件身份不符');
          if (history(c.councilId).some(s => controllers.has(s.sessionId))) continue;
          councils.set(c.councilId, c);
          const sessionDir = path.join(dir, c.councilId, 'sessions');
          let files; try { files = await fs.readdir(sessionDir); } catch (e) { if (e.code !== 'ENOENT') throw e; files = []; }
          for (const file of files) if (file.endsWith('.json') && validId(file.slice(0, -5))) {
            const s = JSON.parse(await fs.readFile(path.join(sessionDir, file), 'utf8'));
            if (s.sessionId !== file.slice(0, -5) || s.councilId !== c.councilId) throw new Error('顾问团讨论文件身份不符');
            sessions.set(s.sessionId, s);
          }
        }
        await reconcile(true);
      });
    },
    async list() { return exclusive(async () => { await reconcile(); return structuredClone({ items: [...councils.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(view) }); }); },
    async get(id) { return exclusive(async () => { await reconcile(); const c = getCouncil(id); return structuredClone({ ...view(c), memory: c.memory, sessions: history(id).map(shortSession) }); }); },
    async getSession(id, sid) { return exclusive(async () => {
      await reconcile(); getCouncil(id); const s = sessions.get(sid);
      if (!validId(sid) || !s || s.councilId !== id) fail(404, '讨论记录不存在'); return structuredClone(s);
    }); },
    async create(body) { return exclusive(async () => {
      checkText(body?.name, 40, '名字'); checkText(body?.goal, 1000, '目标'); members(body?.memberIds); unique(body.name);
      const c = { version: 1, councilId: randomUUID(), name: body.name.trim(), goal: body.goal, memberIds: [...body.memberIds],
        createdAt: stamp(), updatedAt: stamp(), archived: false, memory: emptyMemory(), sessionCount: 0, lastSessionAt: null, nextCheck: null,
        headSessionId: null, nextRecNumber: 1 };
      await saveCouncil(c); councils.set(c.councilId, c); return structuredClone(view(c));
    }); },
    async update(id, body) { return exclusive(async () => {
      await reconcile(); const c = getCouncil(id); unlocked(id);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['name', 'goal', 'memberIds', 'archived'].includes(k))) fail(400, '顾问团更新字段无效');
      const next = structuredClone(c);
      if (Object.hasOwn(body, 'name')) { checkText(body.name, 40, '名字'); unique(body.name, id); next.name = body.name.trim(); }
      if (Object.hasOwn(body, 'goal')) { checkText(body.goal, 1000, '目标'); next.goal = body.goal; }
      if (Object.hasOwn(body, 'memberIds')) { members(body.memberIds); next.memberIds = [...body.memberIds]; }
      if (Object.hasOwn(body, 'archived')) { if (typeof body.archived !== 'boolean') fail(400, '归档状态必须为布尔值'); next.archived = body.archived; }
      next.updatedAt = stamp(); await saveCouncil(next); councils.set(id, next); return structuredClone(view(next));
    }); },
    async start(id, body) { return exclusive(async () => {
      if (closed) fail(409, '顾问团服务正在关闭');
      await reconcile(); const c = getCouncil(id); checkText(body?.report, 4000, '汇报'); unlocked(id);
      if (c.archived) fail(409, '顾问团已归档，请先取消归档');
      if (running().length >= 2) fail(409, '同时进行的顾问团讨论已达上限');
      const selected = c.memberIds.map(id => getRegistry().agents.find(a => a.id === id && a.kind === 'book'));
      if (selected.some(a => !a)) fail(409, '成员不可用，请先移除或替换这个成员');
      if (selected.some(a => !a.platforms?.codex?.available)) fail(409, '所选 Codex Agent 不可用');
      const writable = selected.filter(a => a.writable);
      if (writable.length && body.writableConfirmed !== true) fail(409, '存在可写 Agent，请先确认权限', { writable: writable.map(a => ({ id: a.id, name: a.name, permissions: a.permissions })) });
      if (selected.some(a => (!a.sources?.missingByVersion && a.sourcesOk === false) || missingSourcesFor(a, 'codex').length) && body.sourcesConfirmed !== true) fail(409, '原书路径失效，请先确认', { sourcesConfirmed: true });
      const s = { version: 1, sessionId: randomUUID(), councilId: id, goal: c.goal, report: body.report, status: 'queued', error: null,
        createdAt: stamp(), startedAt: null, finishedAt: null, pid: null, memberSnapshot: structuredClone(selected), memoryBefore: structuredClone(c.memory),
        result: null, undone: false, undoneAt: null, verify: { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [] },
        sequence: Math.max(0, ...history(id).map(s => s.sequence)) + 1, parentSessionId: c.headSessionId, commitPending: false };
      await saveSession(s); sessions.set(s.sessionId, s);
      const controller = new AbortController(); controllers.set(s.sessionId, controller);
      const task = execute(s, controller); work.add(task);
      task.catch(error => log(`${s.sessionId} 保存失败：${error.message}`).catch(() => {})).finally(() => { work.delete(task); controllers.delete(s.sessionId); });
      return { sessionId: s.sessionId };
    }); },
    async undo(id) { return exclusive(async () => {
      await reconcile(); const c = getCouncil(id); unlocked(id);
      const s = sessions.get(c.headSessionId); if (!s) fail(409, '没有可撤销的讨论');
      const previous = sessions.get(s.parentSessionId), time = stamp();
      const next = { ...c, memory: structuredClone(s.memoryBefore), headSessionId: s.parentSessionId,
        sessionCount: c.sessionCount - 1, lastSessionAt: previous?.finishedAt || null, nextCheck: previous?.result?.nextCheck || null, updatedAt: time };
      await saveCouncil(next); councils.set(id, next);
      Object.assign(s, { undone: true, undoneAt: time });
      await saveSession(s).catch(error => log(`${s.sessionId} 撤销标记待恢复：${error.message}`).catch(() => {}));
      return { sessionId: s.sessionId, undone: true };
    }); },
    async delete(id) { return exclusive(async () => {
      if (!validId(id)) fail(400, '顾问团 id 无效'); await reconcile(); unlocked(id);
      // Both paths are confined by UUID validation; missing files are already deleted.
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
      await fs.rm(path.join(dir, `${id}.json`), { force: true });
      councils.delete(id); for (const s of history(id)) sessions.delete(s.sessionId);
      return { deleted: true, councilId: id };
    }); },
    async idle() { await serial; while (work.size) await Promise.allSettled([...work]); },
    async close() { closed = true; for (const c of controllers.values()) c.abort(); await this.idle(); },
  };
}
