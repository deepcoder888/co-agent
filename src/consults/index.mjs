import { CODEX_DEFAULT } from '../config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { processAlive } from '../launch/verify.mjs';
import { agentSnapshot } from '../concepts/index.mjs';
import { avatarColor, summary, missingSourcesFor } from '../../public/display.js';
import { runConsultProcess, validateConsult, codexName } from './runner.mjs';
import { verifyConsult } from './verify.mjs';
import { lenses } from './lenses.mjs';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const active = r => ['queued', 'running'].includes(r.status);
// v0.47 (2026-11-07): several consults may run at once; each is its own Codex run with its own work folder,
// and the check-up matches each run by its own id. Three at a time keeps the machine and the Codex quota usable.
export const consultLimits = { parallel: 3 };
export const consultCounts = [3, 5, 7];
const missing = a => (!a.sources?.missingByVersion && a.sourcesOk === false) || !!missingSourcesFor(a, 'codex').length;
export function enrich(r) {
  if (!r?.result || !Array.isArray(r.catalog)) return r;
  for (const a of [...r.result.lenses, ...r.result.perLens]) {
    const source = r.catalog.find(entry => codexName(entry) === a.agent);
    if (source) Object.assign(a, { id: source.id, name: source.name, bookLabel: agentSnapshot(source).bookLabel, avatarColor: avatarColor(source.id) });
  }
  return r;
}
export function createConsults(config, getRegistry, { now = () => new Date(), runner = runConsultProcess, verifier = verifyConsult,
  spawnImpl, killTree, isAlive = processAlive } = {}) {
  const dir = path.join(config.dataDir, 'consults'), records = new Map(), controllers = new Map(), work = new Set();
  let serial = Promise.resolve(), closed = false;
  const log = createLogger(config.dataDir, { file: 'consults.log' });
  const stamp = () => new Date(now()).toISOString();
  const sorted = () => [...records.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.sequence - a.sequence);
  const save = r => atomicWrite(path.join(dir, `${r.consultId}.json`), JSON.stringify(r, null, 2) + '\n');
  function exclusive(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  function getRecord(id) { if (!validId(id) || !records.has(id)) fail(404, '会诊记录不存在'); return records.get(id); }
  function running() { const r = sorted().find(active); return r ? { consultId: r.consultId, startedAt: r.startedAt, status: r.status } : null; }
  async function reconcile() {
    for (const r of records.values()) if (active(r) && !controllers.has(r.consultId)) {
      const error = !isAlive(r.pid) ? '进程中断'
        : Date.parse(r.startedAt || r.createdAt) < new Date(now()).getTime() - (config.consult.timeoutMs + 600000)
          ? '超时未结束（可能已中断）' : null;
      if (!error) continue;
      Object.assign(r, { status: 'failed', error, pid: null, finishedAt: stamp() }); await save(r);
      await log(`${r.consultId} ${error}`);
    }
  }
  async function execute(r, controller) {
    try {
      await exclusive(async () => { r.status = 'running'; r.startedAt = stamp(); await save(r); });
      const output = await runner(r, config, { spawnImpl, killTree, signal: controller.signal,
        onSpawn: (pid, scrubbedEnv) => exclusive(async () => { Object.assign(r, { pid, scrubbedEnv }); await save(r); }),
      });
      if (controller.signal.aborted) throw new Error('进程中断');
      r.result = validateConsult(output, r).result;
      enrich(r);
      try { r.verify = await verifier(r, config); }
      catch (error) { r.verify = { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [], error: error.message }; }
      if (controller.signal.aborted) throw new Error('进程中断');
      await exclusive(async () => { Object.assign(r, { status: 'done', finishedAt: stamp(), pid: null }); await save(r); });
      await log(`${r.consultId} done`);
    } catch (error) {
      await exclusive(async () => {
        const live = error.processMayBeAlive && Number.isSafeInteger(error.pid) && error.pid > 0;
        Object.assign(r, { status: live ? 'running' : 'failed', error: error.message, pid: live ? error.pid : null, finishedAt: live ? null : stamp() }); await save(r);
      });
      await log(`${r.consultId} ${error.message}`).catch(() => {});
    }
  }
  return {
    async recover() {
      await exclusive(async () => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json') && validId(entry.name.slice(0, -5))) {
          const r = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
          if (r.consultId !== entry.name.slice(0, -5)) throw new Error(`会诊文件身份不符：${entry.name}`);
          if (!controllers.has(r.consultId)) records.set(r.consultId, r);
        }
        await reconcile();
      });
    },
    async get(id) { return exclusive(async () => { await reconcile(); return structuredClone(enrich(getRecord(id))); }); },
    async list(limit = 30) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'limit 必须为 1–200 的整数');
      return exclusive(async () => {
        await reconcile();
        return structuredClone({ items: sorted().slice(0, limit).map(enrich).map(({ catalog, result, ...r }) => ({ ...r,
          result: result ? { ...result, perLens: result.perLens.map(({ analysis, ...p }) => p) } : null,
        })), running: running(), active: sorted().filter(active).length, parallel: consultLimits.parallel });
      });
    },
    async delete(id) {
      return exclusive(async () => {
        if (!validId(id)) fail(400, '会诊 id 无效');
        await reconcile();
        if (records.has(id) && active(records.get(id))) fail(409, '运行中的会诊不能删除', { running: running() });
        // UUID validation confines both deletions to this engine's data directory.
        await fs.rm(path.join(dir, 'work', id), { recursive: true, force: true });
        await fs.rm(path.join(dir, `${id}.json`), { force: true });
        records.delete(id);
        return { deleted: true, consultId: id };
      });
    },
    async start(body) {
      return exclusive(async () => {
        if (closed) fail(409, '会诊服务正在关闭');
        if (!body || Array.isArray(body) || typeof body.situation !== 'string' || !body.situation.trim() || Array.from(body.situation.trim()).length > 4000) fail(400, '处境必须为 1–4000 字');
        let options = null;
        if (Object.hasOwn(body, 'options')) {
          if (!Array.isArray(body.options) || (body.options.length !== 0 && (body.options.length < 2 || body.options.length > 5))) fail(400, '选项必须为空或 2–5 项');
          const seen = new Set();
          options = body.options.map((text, i) => {
            if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 200) fail(400, `选项 ${'ABCDE'[i]} 必须为 1–200 字`);
            if (seen.has(text.trim())) fail(400, `选项 ${'ABCDE'[i]} 与其他选项重复`);
            seen.add(text.trim()); return { id: 'ABCDE'[i], text };
          });
          if (!options.length) options = null;
        }
        if (Object.hasOwn(body, 'parentId')) {
          if (!validId(body.parentId) || !records.has(body.parentId)) fail(400, 'parentId 无效');
          await reconcile();
          if (active(getRecord(body.parentId))) fail(409, '原会诊尚未结束');
        }
        const explicit = Object.hasOwn(body, 'lenses');
        // v0.48 (2026-11-07): 自动选择 takes 3, 5 or 7 books; without a count the host picks 3–5 as before.
        const count = body.count ?? null;
        if (count !== null && (explicit || !consultCounts.includes(count))) fail(400, explicit ? '指定名单时不再另选书籍数量' : `书籍数量必须是 ${consultCounts.join('、')} 之一`);
        let candidates;
        if (explicit) {
          if (!Array.isArray(body.lenses) || body.lenses.length < 3 || body.lenses.length > 5 || body.lenses.some(l =>
            !l || !lenses.some(x => x.id === l.lens) || typeof l.agentId !== 'string') ||
            new Set(body.lenses.map(l => l.lens)).size !== body.lenses.length || new Set(body.lenses.map(l => l.agentId)).size !== body.lenses.length) fail(400, '必须指定 3–5 组有效且互不重复的视角与书籍 Agent');
          candidates = body.lenses.map(l => getRegistry().agents.find(a => a.id === l.agentId));
          if (candidates.some(a => !a || a.kind !== 'book')) fail(400, '所选 Agent 必须是注册表中的书籍 Agent');
          const unavailable = candidates.filter(a => !a.platforms?.codex?.available);
          if (unavailable.length) fail(409, '所选 Codex Agent 不可用', { unavailable: unavailable.map(a => ({ id: a.id, name: a.name })) });
          const writable = candidates.filter(a => a.writable);
          if (writable.length && body.writableConfirmed !== true) fail(409, '存在可写 Agent，请先确认权限', { writable: writable.map(a => ({ id: a.id, name: a.name, permissions: a.permissions })) });
          if (candidates.some(missing) && body.sourcesConfirmed !== true) fail(409, '原书路径失效，请先确认 sourcesConfirmed', { sourcesConfirmed: true });
        } else {
          candidates = getRegistry().agents.filter(a => a.kind === 'book' && a.platforms?.codex?.available && !a.writable && !missing(a));
          if (candidates.length < (count ?? 3)) fail(409, count ? `可用的书籍 Agent 不足 ${count} 本` : '可用的书籍 Agent 不足三本');
        }
        await reconcile();
        const live = sorted().filter(active).length;
        if (live >= consultLimits.parallel) fail(409, `最多同时进行 ${consultLimits.parallel} 场会诊，请等其中一场结束`, { running: running(), active: live, parallel: consultLimits.parallel });
        const r = { version: 1, consultId: randomUUID(), parentId: body.parentId ?? null, situation: body.situation.trim(), options,
          mode: explicit ? 'explicit' : 'auto', count, requestedLenses: explicit ? body.lenses.map(({ lens, agentId }) => ({ lens, agentId })) : null,
          status: 'queued', error: null, createdAt: stamp(), startedAt: null, finishedAt: null, model: config.codexModel ?? CODEX_DEFAULT, effort: config.codexEffort ?? CODEX_DEFAULT, pid: null,
          result: null, verify: { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [] },
          sequence: Math.max(0, ...sorted().map(r => r.sequence || 0)) + 1,
          catalog: candidates.map(a => ({ id: a.id, name: a.name, kind: a.kind, platforms: { codex: { ...a.platforms.codex } },
            book: a.book, primary: a.primary, description: summary(a.description) })),
        };
        await save(r); records.set(r.consultId, r);
        const controller = new AbortController(); controllers.set(r.consultId, controller);
        const task = execute(r, controller); work.add(task);
        task.catch(() => {}).finally(() => { work.delete(task); controllers.delete(r.consultId); });
        return { consultId: r.consultId };
      });
    },
    async idle() { await serial; while (work.size) await Promise.all([...work]); },
    async close() { closed = true; for (const controller of controllers.values()) controller.abort(); await this.idle(); },
  };
}
