import { CODEX_DEFAULT } from '../config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { processAlive } from '../launch/verify.mjs';
import { agentSnapshot } from '../concepts/index.mjs';
import { avatarColor, summary, missingSourcesFor } from '../../public/display.js';
import { runSeminarProcess, validateSeminar } from './runner.mjs';
import { verifySeminar } from './verify.mjs';
import { saveSeminarThink } from './think.mjs';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const active = r => ['queued','running'].includes(r.status);
// v0.48 (2026-11-07): several 圆桌 may run at once, like 会诊 (each its own Codex run, work folder and id).
export const seminarLimits = { parallel: 3 };
const missing = a => (!a.sources?.missingByVersion && a.sourcesOk === false) || !!missingSourcesFor(a, 'codex').length;
// Both the participant list and the analyses carry display identity (Claude acceptance 2026-10-08: the
// three-pane participant rows showed 《书名未载明》 because only perAgent was enriched). Applied on read too,
// so records saved before this fix display correctly without re-running the seminar.
export function enrich(r) {
  if (!r?.result || !Array.isArray(r.catalog)) return r;
  for (const a of [...(r.result.selected || []), ...(r.result.perAgent || [])]) {
    const source = r.catalog.find(entry => (entry.platforms?.codex?.name || entry.name) === a.agent);
    if (!source) continue;
    Object.assign(a, { id: source.id, name: source.name, bookLabel: agentSnapshot(source).bookLabel, avatarColor: avatarColor(source.id) });
  }
  return r;
}
export function createSeminars(config, getRegistry, { now = () => new Date(), runner = runSeminarProcess, verifier = verifySeminar,
  spawnImpl, killTree, isAlive = processAlive, thinkWriter = saveSeminarThink } = {}) {
  const dir = path.join(config.dataDir, 'seminars'), records = new Map(), controllers = new Map(), work = new Set();
  let serial = Promise.resolve(), closed = false;
  const log = createLogger(config.dataDir, { file: 'seminars.log' });
  const stamp = () => new Date(now()).toISOString();
  const sorted = () => [...records.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.sequence - a.sequence);
  const save = r => atomicWrite(path.join(dir, `${r.seminarId}.json`), JSON.stringify(r, null, 2) + '\n');
  function exclusive(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  function getRecord(id) { if (!validId(id) || !records.has(id)) fail(404, '研讨记录不存在'); return records.get(id); }
  function running() { const r = sorted().find(active); return r ? { seminarId: r.seminarId, startedAt: r.startedAt, status: r.status } : null; }
  async function reconcile() {
    for (const r of records.values()) if (active(r) && !controllers.has(r.seminarId)) {
      const error = !isAlive(r.pid) ? '进程中断'
        : Date.parse(r.startedAt || r.createdAt) < new Date(now()).getTime() - (config.seminar.timeoutMs + 600000)
          ? '超时未结束（可能已中断）' : null;
      if (!error) continue;
      Object.assign(r, { status: 'failed', error, pid: null, finishedAt: stamp() }); await save(r);
      await log(`${r.seminarId} ${error}`);
    }
  }
  async function execute(r, controller) {
    try {
      await exclusive(async () => { r.status = 'running'; r.startedAt = stamp(); await save(r); });
      const output = await runner(r, config, { spawnImpl, killTree, signal: controller.signal,
        onSpawn: (pid, scrubbedEnv) => exclusive(async () => { Object.assign(r, { pid, scrubbedEnv }); await save(r); }),
      });
      if (controller.signal.aborted) throw new Error('进程中断');
      const checked = validateSeminar(output, r); r.strengthCorrected = checked.strengthCorrected;
      r.result = checked.result;
      enrich(r);
      try { r.verify = await verifier(r, config); }
      catch (error) { r.verify = { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [], error: error.message }; }
      if (config.seminar.thinkDir) {
        try { r.thinkFile = await thinkWriter(r, config.seminar.thinkDir); }
        catch (error) { r.thinkError = `${config.seminar.thinkDir}：${error.code || 'ERROR'}: ${error.message}`; }
      }
      await exclusive(async () => { Object.assign(r, { status: 'done', finishedAt: stamp(), pid: null }); await save(r); });
    } catch (error) {
      await exclusive(async () => {
        const live = error.processMayBeAlive && Number.isSafeInteger(error.pid) && error.pid > 0;
        Object.assign(r, { status: live ? 'running' : 'failed', error: error.message, pid: live ? error.pid : null, finishedAt: live ? null : stamp() }); await save(r);
      });
    }
  }
  return {
    async recover() {
      await exclusive(async () => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json') && validId(entry.name.slice(0, -5))) {
          const r = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
          if (r.seminarId !== entry.name.slice(0, -5)) throw new Error(`研讨文件身份不符：${entry.name}`);
          if (!controllers.has(r.seminarId)) records.set(r.seminarId, r);
        }
        await reconcile();
      });
    },
    async get(id) { return exclusive(() => structuredClone(enrich(getRecord(id)))); },
    async allRecords() { return exclusive(() => structuredClone(sorted().map(enrich))); },
    async list(limit = 30) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'limit 必须为 1–200 的整数');
      return exclusive(() => structuredClone({ items: sorted().slice(0, limit).map(({ catalog, result, ...r }) => ({ ...r,
        result: result ? { terms: result.terms, selected: result.selected, perAgent: result.perAgent.map(({ analysis, ...a }) => a), commonAnswer: { summary: result.commonAnswer.summary } } : null,
      })), running: running(), active: sorted().filter(active).length, parallel: seminarLimits.parallel }));
    },
    async start(body) {
      return exclusive(async () => {
        if (closed) fail(409, '研讨服务正在关闭');
        if (!body || Array.isArray(body) || typeof body.input !== 'string' || !body.input.trim() || Array.from(body.input.trim()).length > 2000) fail(400, 'input 必须为 1–2000 字');
        const explicit = Object.hasOwn(body, 'agentIds');
        if (!explicit && Object.hasOwn(body, 'parentId')) fail(400, 'parentId 只适用于指定名单重跑');
        let candidates;
        if (explicit) {
          if (!Array.isArray(body.agentIds) || body.agentIds.length < 3 || body.agentIds.length > 8 || body.agentIds.some(id => typeof id !== 'string') || new Set(body.agentIds).size !== body.agentIds.length) fail(400, 'agentIds 必须为 3–8 个互不重复的书籍 Agent');
          candidates = body.agentIds.map(id => getRegistry().agents.find(a => a.id === id));
          if (candidates.some(a => !a || a.kind !== 'book')) fail(400, '所选 Agent 必须是注册表中的书籍 Agent');
          if (Object.hasOwn(body, 'parentId')) {
            if (!validId(body.parentId) || !records.has(body.parentId)) fail(400, 'parentId 无效');
            if (active(getRecord(body.parentId))) fail(409, '原研讨尚未完成');
          }
          const unavailable = candidates.filter(a => !a.platforms?.codex?.available);
          if (unavailable.length) fail(409, '所选 Codex Agent 不可用', { unavailable: unavailable.map(a => ({ id: a.id, name: a.name })) });
          const writable = candidates.filter(a => a.writable);
          if (writable.length && body.writableConfirmed !== true) fail(409, '存在可写 Agent，请先确认权限', { writable: writable.map(a => ({ id: a.id, name: a.name, permissions: a.permissions })) });
          if (candidates.some(missing) && body.sourcesConfirmed !== true) fail(409, '原书路径失效，请先确认');
        } else {
          candidates = getRegistry().agents.filter(a => a.kind === 'book' && a.platforms?.codex?.available && !a.writable && !missing(a));
          if (candidates.length < 3) fail(409, '不足三个可用且无需权限确认的书籍 Agent');
        }
        await reconcile();
        const live = sorted().filter(active).length;
        if (live >= seminarLimits.parallel) fail(409, `最多同时进行 ${seminarLimits.parallel} 场圆桌，请等其中一场结束`, { running: running(), active: live, parallel: seminarLimits.parallel });
        const r = { version: 1, seminarId: randomUUID(), parentId: body.parentId ?? null, input: body.input.trim(),
          mode: explicit ? 'explicit' : 'auto', requestedAgents: explicit ? [...body.agentIds] : null,
          status: 'queued', error: null, createdAt: stamp(), startedAt: null, finishedAt: null, model: config.codexModel ?? CODEX_DEFAULT, effort: config.codexEffort ?? CODEX_DEFAULT,
          result: null, verify: { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [] },
          thinkFile: null, thinkError: null, strengthCorrected: false, sequence: Math.max(0, ...sorted().map(r => r.sequence || 0)) + 1,
          catalog: candidates.map(a => ({ id: a.id, name: a.name, kind: a.kind, platforms: { codex: { ...a.platforms.codex } },
            book: a.book, primary: a.primary, description: summary(a.description) })),
        };
        await save(r); records.set(r.seminarId, r);
        const controller = new AbortController(); controllers.set(r.seminarId, controller);
        const task = execute(r, controller); work.add(task);
        task.catch(() => {}).finally(() => { work.delete(task); controllers.delete(r.seminarId); });
        return { seminarId: r.seminarId };
      });
    },
    async idle() { await serial; while (work.size) await Promise.all([...work]); },
    async close() { closed = true; for (const controller of controllers.values()) controller.abort(); await this.idle(); },
  };
}
