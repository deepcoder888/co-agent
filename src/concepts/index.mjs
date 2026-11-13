import { CODEX_DEFAULT } from '../config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { processAlive } from '../launch/verify.mjs';
import { runConceptProcess, validateConcept, validatePerspectives, termFits } from './runner.mjs';
import { verifyConcept, verifyPerspectives, skillStructure } from './verify.mjs';
import { saveThink, thinkMarkdown } from './think.mjs';
import { runTermProcess, validateTermOutput } from './terms.mjs';
import { cleanTitle, bookLabel, missingSourcesFor } from '../../public/display.js';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const active = record => ['queued', 'running'].includes(record.status);
const normalized = value => typeof value === 'string' ? value.replace(/\s+/gu, '').toLowerCase() : '';
const missingSources = agent => (!agent.sources?.missingByVersion && agent.sourcesOk === false) || !!missingSourcesFor(agent, 'codex').length;
const DAILY_MAX_ATTEMPTS = 3;
const DAILY_RETRY_DELAY_MS = 30 * 60_000;
const eligibleBooks = agents => agents.filter(a => a.kind === 'book' && a.platforms.codex?.available && !missingSources(a));
export function localTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { day: `${fields.year}-${fields.month}-${fields.day}`, minutes: Number(fields.hour) * 60 + Number(fields.minute) };
}
export function selectAgent(agents, recent, randomIntImpl = randomInt) {
  const pool = eligibleBooks(agents);
  if (!pool.length) fail(409, '没有可用且原书路径有效的 Codex 书籍 Agent');
  const used = new Set(recent.slice(0, 7).map(r => r.agent.id)), fresh = pool.filter(a => !used.has(a.id));
  const choices = fresh.length ? fresh : pool;
  return choices[randomIntImpl(choices.length)];
}
export function excludedConcepts(records, agentId) {
  return [...new Set(records.filter(r => r.status === 'done' && r.agent.id === agentId)
    .flatMap(r => [r.result?.concept, r.result?.conceptEn].map(normalized)).filter(Boolean))];
}
export function agentSnapshot(a) {
  // Registry titles carry display markup (《》, Markdown emphasis, "多书，N 部：" lists); prompts and labels use the cleaned forms.
  const raw = a.book?.title || '', { text, multi } = cleanTitle(raw);
  const list = raw.match(/^多书[，,]\s*\d+\s*部[：:]\s*([\s\S]*)$/)?.[1].trim();
  return { id: a.id, name: a.name, codexName: a.platforms.codex.name || a.name, title: text || a.name,
    bookRef: list || (text ? `《${text}》` : a.name),
    author: a.book?.author ?? null, bookLabel: raw ? bookLabel(a) : null, purpose: a.purpose ?? null };
}

// Calendar dates are day fields in this computer's time zone, never UTC createdAt dates.
export function responseTarget(records, kind, day, agentId) {
  if (kind !== 'daily') return null;
  const first = records.filter(r => r.kind === 'daily' && r.day === day)
    .sort((a, b) => (a.attempt || 1) - (b.attempt || 1) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence || 0) - (b.sequence || 0))[0];
  if (first) return structuredClone(first.respondsTo ?? null);
  const target = records.filter(r => r.kind === 'daily' && r.status === 'done' && r.result && r.day < day &&
    Date.parse(day) - Date.parse(r.day) <= 7 * 86400000)
    .sort((a, b) => b.day.localeCompare(a.day) || (b.sequence || 0) - (a.sequence || 0))[0];
  if (!target || target.agent.id === agentId) return null;
  return structuredClone({ conceptId: target.conceptId, day: target.day,
    agent: { id: target.agent.id, name: target.agent.name, bookLabel: target.agent.bookLabel },
    concept: target.result.concept, term: target.result.term ?? null, oneLine: target.result.oneLine });
}
const responseSummary = result => result?.response ? { ...result.response, text: Array.from(result.response.text).slice(0, 80).join('') } : null;

export function createConcepts(config, getRegistry, { now = () => new Date(), randomIntImpl = randomInt, runner = runConceptProcess,
  perspectiveRunner = runConceptProcess, conceptVerifier = verifyConcept, perspectiveVerifier = verifyPerspectives,
  spawnImpl, killTree, isAlive = processAlive, thinkWriter = saveThink, termRunner = runTermProcess, recordWriter = atomicWrite,
  dailyMaxAttempts = DAILY_MAX_ATTEMPTS, dailyRetryDelayMs = DAILY_RETRY_DELAY_MS } = {}) {
  const dir = path.join(config.dataDir, 'concepts'), records = new Map(), work = new Set(), controllers = new Map();
  let serial = Promise.resolve(), logWork = Promise.resolve(), closed = false, termWork = null;
  const writeLog = createLogger(config.dataDir, { file: 'concepts.log' }), dailyLogStates = new Map();
  const stamp = () => new Date(now()).toISOString();
  const sorted = () => [...records.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.sequence - a.sequence);
  const file = id => path.join(dir, `${id}.json`);
  const save = r => recordWriter(file(r.conceptId), JSON.stringify(r, null, 2) + '\n');
  // This queue covers record mutation as well as writes. Generation and perspectives
  // may run together, but cannot overwrite one another's fields during completion.
  function exclusive(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  function log(message) {
    const task = writeLog(message);
    logWork = task.catch(() => {}); return task;
  }
  function logDaily(day, status) {
    if (['not-due', 'exists', 'busy', 'retry-wait'].includes(status) && dailyLogStates.get(day) === status) return Promise.resolve();
    dailyLogStates.set(day, status);
    return log(`${day} daily ${status}`);
  }
  function getRecord(id) {
    if (!validId(id) || !records.has(id)) fail(404, '概念记录不存在');
    return records.get(id);
  }
  const running = () => {
    const r = sorted().find(active);
    return r ? { conceptId: r.conceptId, kind: r.kind, startedAt: r.startedAt } : null;
  };
  async function reconcile() {
    for (const r of records.values()) {
      const changes = [];
      const items = [[r, r.conceptId], ...(r.perspectives || []).map(p => [p, p.runId]),
        ...(r.termBackfill && active(r.termBackfill) ? [[r.termBackfill, `term:${r.conceptId}`]] : [])];
      for (const [item, id] of items) if (active(item) && !controllers.has(id)) {
        // Queued term work has no PID yet; retain its normal queue until it ages out.
        const interrupted = (item !== r.termBackfill || item.status === 'running') && !isAlive(item.pid);
        const error = interrupted ? '进程中断'
          : Date.parse(item.startedAt || item.createdAt) < new Date(now()).getTime() - (config.concept.timeoutMs + 600000)
            ? '超时未结束（可能已中断）' : null;
        if (!error) continue;
        Object.assign(item, { status: 'failed', error, finishedAt: stamp(), pid: null });
        changes.push(`${id} ${error}`);
      }
      if (changes.length) { await save(r); for (const message of changes) await log(message); }
    }
  }
  function track(id, task) {
    work.add(task);
    task.catch(error => log(`${id} 存档失败：${error.message}`).catch(() => {})).finally(() => { work.delete(task); controllers.delete(id); });
    return task;
  }
  async function execute(record, run, controller) {
    const item = run || record, id = item.runId || item.conceptId;
    try {
      await exclusive(async () => { item.status = 'running'; item.startedAt = stamp(); await save(record); await log(`${id} running`); });
      let output = await (run ? perspectiveRunner : runner)(item, config, { spawnImpl, killTree, signal: controller.signal, concept: run ? record : undefined,
        onSpawn: (pid, scrubbedEnv) => exclusive(async () => { item.pid = pid; item.scrubbedEnv = scrubbedEnv; await save(record); }),
      });
      if (controller.signal.aborted) throw new Error('进程中断');
      if (run) {
        validatePerspectives(output, run);
        run.results = run.agents.map(a => ({ agentId: a.id, name: a.name, analysis: output.results.find(v => v.agent === a.codexName).analysis }));
        try { run.verify = await perspectiveVerifier(run, config); }
        catch (error) { run.verify = { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [], error: error.message }; }
      } else {
        const { responseError, ...result } = validateConcept(output, record);
        output = result; record.responseError = responseError;
        const excluded = new Set([...record.excludedConcepts, ...excludedConcepts(sorted(), record.agent.id)]);
        if ([output.concept, output.conceptEn].some(s => s && excluded.has(normalized(s)))) throw new Error('生成了已讲过的重复概念');
        record.result = output;
        try { record.verify = await conceptVerifier(record, config); }
        catch (error) { record.verify = { state: 'unconfirmed', session: null, children: [], skillStructure: skillStructure(output.markdown), error: error.message }; }
        // v0.50: without a configured copy folder the concept stays only in the app.
        if (config.concept.thinkDir) {
          try { record.thinkFile = await thinkWriter(output.term?.zh || output.concept, thinkMarkdown(record), config.concept.thinkDir); }
          catch (error) { record.thinkError = `${config.concept.thinkDir}：${error.code || 'ERROR'}: ${error.message}`; }
        }
      }
      await exclusive(async () => { item.status = 'done'; item.finishedAt = stamp(); item.pid = null; await save(record); await log(`${id} done 核验=${item.verify.state}`); });
    } catch (error) {
      await exclusive(async () => {
        // Do not release the generation lock if termination itself failed.
        const live = error.processMayBeAlive && Number.isSafeInteger(error.pid) && error.pid > 0;
        item.status = live ? 'running' : 'failed'; item.error = `${error.code || 'ERROR'}: ${error.message}`;
        item.finishedAt = live ? null : stamp(); item.pid = live ? error.pid : null;
        await save(record); await log(`${id} ${item.status} ${item.error}`);
      });
    }
    if (!run && record.status === 'done' && !record.result.term) {
      await exclusive(() => queueTerm(record));
      drainTerms();
    }
    return structuredClone(item);
  }
  async function begin(kind, day, attempt) {
    if (closed) fail(409, '概念服务正在关闭');
    const current = running(); if (current) fail(409, '正在生成', { running: current });
    const recent = sorted(), agents = getRegistry().agents, agent = selectAgent(agents, recent, randomIntImpl), conceptId = randomUUID();
    const eligible = eligibleBooks(agents).length, books = agents.filter(a => a.kind === 'book').length;
    const record = { version: 1, conceptId, kind, day, createdAt: stamp(), startedAt: null, finishedAt: null, status: 'queued', error: null, attempt,
      agent: agentSnapshot(agent), cli: 'codex', model: config.codexModel ?? CODEX_DEFAULT, effort: config.codexEffort ?? CODEX_DEFAULT,
      excludedConcepts: excludedConcepts(recent, agent.id), result: null,
      respondsTo: responseTarget(recent, kind, day, agent.id), responseError: null,
      verify: { state: 'unconfirmed', session: null, children: [], skillStructure: skillStructure() },
      thinkFile: null, thinkError: null, perspectives: [], sequence: Math.max(0, ...recent.map(r => r.sequence || 0)) + 1 };
    if (eligible * 2 < books) record.poolWarning = `可选书籍 ${eligible}/${books} 本：其余原书路径失效或 Codex 不可用`;
    await save(record); records.set(conceptId, record);
    if (record.poolWarning) await log(`${conceptId} ${record.poolWarning}`);
    const controller = new AbortController(); controllers.set(conceptId, controller);
    const completion = track(conceptId, execute(record, null, controller));
    return { conceptId, completion };
  }
  async function queueTerm(r) {
    if (r.status !== 'done' || !r.result) fail(409, '概念尚未完成');
    const refit = !!r.result.term && !termFits(r.result.term, r.result.concept);
    const newRefit = refit && r.termBackfill?.reason !== 'refit';
    if (r.termBackfill?.status === 'failed' && !newRefit) fail(409, '术语补齐已尝试，请检查失败记录');
    if (r.result.term && !newRefit) return { conceptId: r.conceptId, status: refit ? r.termBackfill.status : 'done' };
    if (!r.termBackfill || (newRefit && !active(r.termBackfill))) {
      r.termBackfill = { status: 'queued', attempt: 0, createdAt: stamp(), startedAt: null, finishedAt: null, pid: null, error: null };
      if (newRefit) r.termBackfill.reason = 'refit';
      await save(r);
    } else if (newRefit) {
      // An existing queued/running repair already owns the attempt; do not reset it.
      r.termBackfill.reason = 'refit';
      await save(r);
    }
    return { conceptId: r.conceptId, status: r.termBackfill.status };
  }
  function drainTerms() {
    if (termWork || closed) return;
    const task = (async () => {
      while (!closed) {
        const next = await exclusive(async () => {
          if (closed || [...records.values()].some(r => r.termBackfill?.status === 'running')) return null;
          const r = sorted().reverse().find(r => r.status === 'done' && r.result &&
            (!r.result.term || r.termBackfill?.reason === 'refit') && r.termBackfill?.status === 'queued');
          if (!r) return null;
          const key = `term:${r.conceptId}`, controller = new AbortController(); controllers.set(key, controller);
          Object.assign(r.termBackfill, { status: 'running', attempt: 1, startedAt: stamp() });
          await save(r); return { r, key, controller };
        });
        if (!next) break;
        const { r, key, controller } = next;
        try {
          const output = validateTermOutput(await termRunner(r, config, { spawnImpl, killTree, signal: controller.signal,
            onSpawn: (pid, scrubbedEnv) => exclusive(async () => { Object.assign(r.termBackfill, { pid, scrubbedEnv }); await save(r); }),
          }), r);
          if (controller.signal.aborted) throw new Error('进程中断');
          await exclusive(async () => {
            // Merge into the existing result; never regenerate markdown or THINK.
            const previous = r.result;
            r.result = { ...previous, term: output.term };
            Object.assign(r.termBackfill, { status: 'done', finishedAt: stamp(), pid: null });
            try { await save(r); } catch (error) { r.result = previous; throw error; }
          });
        } catch (error) {
          await exclusive(async () => {
            const live = error.processMayBeAlive && Number.isSafeInteger(error.pid) && error.pid > 0;
            Object.assign(r.termBackfill, { status: live ? 'running' : 'failed', error: error.message, pid: live ? error.pid : null, finishedAt: live ? null : stamp() }); await save(r);
          });
        } finally { controllers.delete(key); }
        await log(`${r.conceptId} term ${r.termBackfill.status}`);
      }
    })();
    termWork = task; work.add(task);
    task.catch(error => log(`术语队列错误：${error.message}`).catch(() => {})).finally(() => {
      work.delete(task); termWork = null;
      // Handle an enqueue just as the previous drain observed an empty queue.
      if (!closed && ![...records.values()].some(r => r.termBackfill?.status === 'running') &&
          [...records.values()].some(r => r.termBackfill?.status === 'queued')) drainTerms();
    });
  }
  return {
    async recover() {
      await exclusive(async () => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json') && validId(entry.name.slice(0, -5))) {
          let r;
          try {
            r = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
            if (r?.conceptId !== entry.name.slice(0, -5) || !r.agent?.id || !r.status) throw new Error('概念文件身份或字段无效');
            if (r.kind === 'daily' && (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)))) throw new Error('每日概念日期无效');
          } catch (error) {
            await log(`跳过不可读概念 ${entry.name}：${error.message}`); continue;
          }
          if (!controllers.has(r.conceptId) && !controllers.has(`term:${r.conceptId}`) && !(r.perspectives || []).some(p => controllers.has(p.runId))) records.set(r.conceptId, r);
        }
        await reconcile();
        for (const r of sorted()) if (r.status === 'done' && r.result &&
            ((!r.result.term && !r.termBackfill) || (r.result.term && !termFits(r.result.term, r.result.concept) && r.termBackfill?.reason !== 'refit'))) await queueTerm(r);
      });
      drainTerms();
    },
    async backfillTerm(id) {
      const result = await exclusive(async () => {
        if (closed) fail(409, '概念服务正在关闭');
        await reconcile(); return queueTerm(getRecord(id));
      });
      drainTerms(); return result;
    },
    async get(id) { return exclusive(() => structuredClone(getRecord(id))); },
    async allRecords() { return exclusive(() => structuredClone(sorted())); },
    async thread(limit = 30) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 60) fail(400, 'limit 必须为 1–60 的整数');
      return exclusive(() => {
        // One node per day: a completed attempt wins, otherwise the latest attempt.
        const days = new Map();
        for (const r of sorted().filter(r => r.kind === 'daily')) {
          const existing = days.get(r.day);
          if (!existing || (r.status === 'done' && existing.status !== 'done')) days.set(r.day, r);
        }
        return structuredClone({ items: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit).map(r => ({
          conceptId: r.conceptId, day: r.day, agent: r.agent, concept: r.result?.concept ?? null, term: r.result?.term ?? null,
          oneLine: r.result?.oneLine ?? null, respondsTo: r.respondsTo ?? null, response: responseSummary(r.result), status: r.status,
        })) });
      });
    },
    async list(limit = 30) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'limit 必须为 1–200 的整数');
      return exclusive(() => {
        const all = sorted(), day = localTime(now()).day, today = all.find(r => r.kind === 'daily' && r.day === day);
        return structuredClone({ items: all.slice(0, limit).map(({ result, perspectives, ...r }) => ({ ...r,
          respondsTo: r.respondsTo ?? null, response: responseSummary(result),
          result: result ? { concept: result.concept, conceptEn: result.conceptEn, oneLine: result.oneLine, whyUnknown: result.whyUnknown, term: result.term ?? null, response: responseSummary(result) } : null,
          perspectives: (perspectives || []).map(({ results, ...p }) => p),
        })), running: running(), today: { day, conceptId: today?.conceptId ?? null, status: today?.status ?? null } });
      });
    },
    async startManual(body) {
      if (!body || body.kind !== 'manual') fail(400, 'kind 必须为 manual');
      const { conceptId } = await exclusive(async () => { await reconcile(); return begin('manual', localTime(now()).day, 1); });
      return { conceptId };
    },
    async ensureDaily(at = now()) {
      const { day, minutes } = localTime(at);
      if (minutes < 535) { await logDaily(day, 'not-due'); return { status: 'not-due' }; }
      const decision = await exclusive(async () => {
        await reconcile(); const daily = sorted().filter(r => r.kind === 'daily' && r.day === day);
        const existing = daily.find(r => r.status === 'done' || active(r));
        if (existing) return { status: 'exists', conceptId: existing.conceptId };
        const attempt = Math.max(0, ...daily.map(r => r.attempt || 1));
        if (attempt >= dailyMaxAttempts) return { status: 'failed', conceptId: daily[0].conceptId, error: daily[0].error };
        const previous = daily.find(r => r.status === 'failed');
        const retryAt = Date.parse(previous?.finishedAt) + dailyRetryDelayMs;
        if (new Date(at).getTime() < retryAt) return { status: 'retry-wait', retryAt: new Date(retryAt).toISOString() };
        // A manual run holds the same lock. Catch-up can try on its next tick.
        if (running()) return { status: 'busy', running: running() };
        try { return await begin('daily', day, attempt + 1); }
        catch (error) { return { status: 'failed', error: error.message }; }
      });
      if (decision.completion) { await logDaily(day, 'started'); return decision.completion; }
      await logDaily(day, decision.status); return decision;
    },
    async startPerspectives(id, body) {
      return exclusive(async () => {
        if (closed) fail(409, '概念服务正在关闭');
        await reconcile(); const record = getRecord(id);
        if (record.status !== 'done' || !record.result) fail(409, '概念尚未完成');
        if (!body || !Array.isArray(body.agentIds) || body.agentIds.length < 1 || body.agentIds.length > 8 ||
            body.agentIds.some(id => typeof id !== 'string') || new Set(body.agentIds).size !== body.agentIds.length || body.agentIds.includes(record.agent.id)) fail(400, 'agentIds 必须为 1–8 个互不重复且不同于讲解者的 Agent');
        const agents = body.agentIds.map(id => getRegistry().agents.find(a => a.id === id));
        if (agents.some(a => !a)) fail(400, '该 Agent 不在范围内注册表中');
        const unavailable = agents.filter(a => !a.platforms.codex?.available);
        if (unavailable.length) fail(409, '所选 Codex Agent 不可用', { unavailable: unavailable.map(a => ({ id: a.id, name: a.name })) });
        const writable = agents.filter(a => a.writable);
        if (writable.length && body.writableConfirmed !== true) fail(409, '存在可写 Agent，请先确认权限', { writable: writable.map(a => ({ id: a.id, name: a.name, permissions: a.permissions })) });
        if (agents.some(missingSources) && body.sourcesConfirmed !== true) fail(409, '原书路径失效，请先确认');
        if (record.perspectives.some(active)) fail(409, '该概念正在进行多视角分析');
        const run = { runId: randomUUID(), createdAt: stamp(), startedAt: null, finishedAt: null, status: 'queued', error: null,
          agents: agents.map(agentSnapshot), results: [], verify: { state: 'unconfirmed', parallel: { state: 'pending' }, violations: [] } };
        record.perspectives.push(run); await save(record);
        const controller = new AbortController(); controllers.set(run.runId, controller);
        track(run.runId, execute(record, run, controller));
        return { runId: run.runId };
      });
    },
    async idle() { await serial; while (work.size) await Promise.all([...work]); await logWork; },
    async close() {
      closed = true; for (const controller of controllers.values()) controller.abort();
      await this.idle();
    },
  };
}
