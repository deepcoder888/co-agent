import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../fsutil.mjs';
import { normalize } from '../registry/identity.mjs';
import { verifyLaunch, processAlive, closedStatus } from './verify.mjs';
import { verifyResume, launchMode } from './resume.mjs';
import { verifyJoint } from '../joint/verify.mjs';
import { reverifyHistory } from './reverify.mjs';
import { identityMatches, queryProcess } from '../close.mjs';
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function read(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function files(dir) {
  try { return (await fs.readdir(dir)).filter(n => n.endsWith('.json') && validId(n.slice(0, -5))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function createSessions(config, { verifier = verifyLaunch, jointVerifier = verifyJoint, isAlive = processAlive,
  queryIdentity = pid => {
    if (process.env.NODE_TEST_CONTEXT) throw new Error('测试必须注入进程身份查询');
    return queryProcess(pid, config);
  }, io, log = async () => {} } = {}) {
  const entries = new Map();
  const identities = new Map();
  const backfillAttempted = new Set();
  let reverifyWork = Promise.resolve();
  const directory = type => path.join(config.dataDir, type === 'joint' ? 'joints' : 'launches');
  const key = (type, id) => `${type}:${id}`;
  const idOf = (type, record) => type === 'joint' ? record.jointId : record.launchId;
  const identityKey = record => `${record.pid}:${record.createdAt}`;
  async function alive(record) {
    const key = identityKey(record);
    if (!isAlive(record.pid)) { identities.delete(key); return false; }
    if (!identities.has(key)) {
      const pending = Promise.resolve().then(() => queryIdentity(record.pid)).then(identity => {
        const matches = identityMatches(record, identity); identities.set(key, matches); return matches;
      }).catch(() => {
        // A helper failure is unknown, not an identity mismatch. Retry next refresh.
        identities.delete(key); return true;
      });
      identities.set(key, pending);
    }
    return identities.get(key);
  }
  async function register(type, record, status) {
    const id = idOf(type, record);
    if (!validId(id)) throw new Error('会话记录 ID 无效');
    entries.set(key(type, id), { type, id, record, status, checkedAt: 0 });
  }
  async function check(type, id) {
    await reverifyWork;
    const entry = entries.get(key(type, id));
    if (!entry) throw Object.assign(new Error('启动记录不存在'), { status: 404 });
    if (entry.closing) await entry.closing;
    if (entry.record.closedAt) return closedStatus(entry.record, entry.status);
    const live = await alive(entry.record), recordAlive = pid => pid === entry.record.pid ? live : isAlive(pid);
    if (entry.status?.overall === 'historical' || (entry.status?.reverified && entry.status?.process?.state === 'exited')) return entry.status;
    if (!entry.checking && (!entry.status || Date.now() - entry.checkedAt >= config.verifyPollMs || (!live && entry.status.process?.state === 'alive'))) {
      entry.checking = (async () => {
        const fn = type === 'joint' ? jointVerifier : entry.record.resumeOf ? verifyResume : verifier;
        let status = await fn(entry.record, config, { isAlive: recordAlive });
        if (entry.record.terminalFallback) status.terminalFallback = entry.record.terminalFallback;
        if (!status.session && entry.status?.session) status.session = entry.status.session;
        // Process lifetime and a verified session outcome are independent.
        status.process = { ...status.process, pid: entry.record.pid, state: live ? 'alive' : 'exited' };
        if (status.process.state === 'exited') {
          if (status.overall === 'done') status.message = '已完成 · 会话已结束';
          else if (['ready', 'resumed', 'done'].includes(entry.status?.overall)) {
            const message = entry.status.message || { ready: '已就绪', resumed: '已恢复', done: '已完成' }[entry.status.overall];
            status = { ...entry.status, process: status.process,
              message: message.endsWith(' · 会话已结束') ? message : `${message} · 会话已结束` };
          } else {
            const reason = status.reason || status.message;
            const independentFailure = status.evidenceError || status.cwd?.state === 'mismatch' || status.agent?.state === 'mismatch' ||
              status.whitelist?.state === 'violation' || status.calls?.some(call => call.state === 'failed') ||
              (reason && !/^(?:(?:启动|恢复)失败：)?进程已退出(?:（未完成核验）)?$/.test(reason));
            if (!['failed', 'unconfirmed'].includes(status.overall) || !independentFailure) {
              status.overall = 'failed'; status.message = '进程已退出（未完成核验）';
            }
          }
        }
        if (JSON.stringify(status) !== JSON.stringify(entry.status)) {
          await atomicWrite(path.join(directory(type), `${id}.status.json`), JSON.stringify(status, null, 2) + '\n', io);
          entry.status = status;
        }
        entry.checkedAt = Date.now(); return entry.status;
      })().finally(() => { entry.checking = undefined; });
    }
    if (entry.checking) await entry.checking;
    return entry.status;
  }
  async function recover() {
    const cutoff = Date.now() - 7 * 86400000;
    for (const type of ['launch', 'joint']) for (const name of await files(directory(type))) {
      try {
        const record = await read(path.join(directory(type), name));
        if (idOf(type, record) !== name.slice(0, -5) || !Number.isFinite(Date.parse(record.createdAt))) continue;
        let status;
        try { status = await read(path.join(directory(type), `${name.slice(0, -5)}.status.json`)); }
        catch (error) { if (error.code !== 'ENOENT') await log(`状态读取错误：${error.message}`); }
        if (type === 'joint' && status?.overall === 'failed' && status.message === '进程已退出' && !record.closedAt && !isAlive(record.pid)) {
          // This repair owns the one recovery attempt; an inconclusive result
          // must not trigger a second lazy backfill that changes the old sidecar.
          backfillAttempted.add(record.jointId);
          try {
            const verified = await jointVerifier(record, config, { isAlive });
            // An inconclusive result takes the v0.30 wording, so later startups skip this repair
            // (each attempt indexes every Codex rollout; Claude acceptance 2026-10-21).
            status = verified.overall === 'done'
              ? { ...verified, process: { ...verified.process, pid: record.pid, state: 'exited' }, message: '已完成 · 会话已结束' }
              : { ...status, message: '进程已退出（未完成核验）' };
            await atomicWrite(path.join(directory(type), `${name.slice(0, -5)}.status.json`), JSON.stringify(status, null, 2) + '\n', io);
          } catch (error) { await log(`联合退出结论修复错误：${record.jointId} ${error.message}`); }
        }
        if (type === 'joint' && !status?.session?.id) scheduleBackfill(record.jointId);
        if (Date.parse(record.createdAt) < cutoff) continue;
        await register(type, record, status);
      } catch (error) { await log(`启动记录读取错误：${name} ${error.message}`); }
    }
    await refresh();
  }
  async function refresh() {
    for (const entry of entries.values()) {
      if (entry.record.closedAt) continue;
      if (entry.status?.overall === 'historical') continue;
      if (entry.status?.process?.state === 'exited' && !isAlive(entry.record.pid)) { identities.delete(identityKey(entry.record)); continue; }
      try { await check(entry.type, entry.id); } catch (error) { await log(`核验错误：${entry.id} ${error.message}`); }
    }
  }
  async function running() {
    await refresh();
    return { items: [...entries.values()].filter(e => !e.record.closedAt && e.status?.overall !== 'historical' && isAlive(e.record.pid) && identities.get(identityKey(e.record)) !== false).map(e => ({ id: e.id, type: e.type,
      agentName: e.record.agentName, whitelist: e.record.whitelist, cli: e.record.cli, createdAt: e.record.createdAt, status: e.status }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) };
  }
  async function readRecord(type, id) {
    if (!['launch', 'joint'].includes(type) || !validId(id)) throw Object.assign(new Error('历史参数无效'), { status: 400 });
    let record;
    try { record = await read(path.join(directory(type), `${id}.json`)); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('历史记录不存在'), { status: 404 }); throw error; }
    if (idOf(type, record) !== id || !['claude', 'codex'].includes(record.cli)) throw Object.assign(new Error('历史记录无效'), { status: 409 });
    return record;
  }
  async function resumeInfo(type, id) {
    let status = entries.get(key(type, id))?.status;
    if (!status) try { status = await read(path.join(directory(type), `${id}.status.json`)); } catch { /* Missing or unreadable evidence is not proof. */ }
    const session = status?.session;
    if (!validId(session?.id) || typeof session?.file !== 'string') return { status, canResume: false,
      resumeReason: status?.reverified?.result !== 'found' && status?.reverified?.reason || '核验尚未找到会话文件和 ID' };
    try { if (!(await fs.stat(session.file)).isFile()) throw new Error('不是文件'); await fs.access(session.file, fs.constants.R_OK); }
    catch { return { status, canResume: false, resumeReason: '会话文件已经不存在或不可读' }; }
    return { status, session, canResume: true, resumeReason: null };
  }
  async function allHistory({ type = 'all', limit = 50 } = {}) {
    if (!['all', 'launch', 'joint'].includes(type) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('历史筛选或 limit 无效（1–500）'), { status: 400 });
    const items = [];
    for (const kind of type === 'all' ? ['launch', 'joint'] : [type]) for (const file of await files(directory(kind))) {
      try {
        const id = file.slice(0, -5), record = await readRecord(kind, id);
        if (!Number.isFinite(Date.parse(record.createdAt))) throw new Error('历史时间无效');
        const info = await resumeInfo(kind, id);
        if (kind === 'joint' && !info.status?.session?.id) scheduleBackfill(id);
        items.push({ type: kind, id, createdAt: record.createdAt, cli: record.cli,
          agents: kind === 'joint' ? record.whitelist.map(a => ({ id: a.id, name: a.codexName })) : [{ id: record.agentId || normalize(record.agentName || ''), name: record.agentName }],
          mode: kind === 'joint' ? 'joint' : launchMode(record), source: kind === 'joint' ? record.source || 'recommend' : 'launch',
          ...(kind === 'joint' && record.group ? { group: { id: record.group.id, name: record.group.name } } : {}),
          ...(kind === 'joint' ? { inputPreview: Array.from(record.input || '').slice(0, 120).join('') } : {}),
          status: record.closedAt ? { overall: 'closed', message: '已关闭（用户）' } : { overall: info.status?.overall || (record.error ? 'failed' : 'unconfirmed'),
            ...(info.status?.message ? { message: info.status.message } : {}) },
          ...(record.closedAt ? { statusTone: 'pending' } : {}),
          canResume: info.canResume, resumeReason: info.resumeReason, resumeOf: record.resumeOf || null, rerunOf: record.rerunOf || null });
      } catch (error) { await log(`历史读取错误：${file} ${error.message}`); }
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    return { items: items.slice(0, limit) };
  }
  async function originalRecord(type, id, requireSession = true) {
    const record = await readRecord(type, id);
    if (!requireSession) return { record };
    const info = await resumeInfo(type, id);
    if (!info.canResume) throw Object.assign(new Error(`该会话无法恢复：${info.resumeReason}`), { status: 409 });
    return { record, session: info.session };
  }
  async function history(agentId) {
    const items = [], unavailable = [];
    for (const name of await files(directory('launch'))) {
      try {
        const record = await read(path.join(directory('launch'), name));
        if (record.launchId !== name.slice(0, -5) || (record.agentId || normalize(record.agentName || '')) !== agentId) continue;
        let status;
        const entry = entries.get(key('launch', record.launchId));
        if (entry) status = await check('launch', record.launchId);
        else try { status = await read(path.join(directory('launch'), `${record.launchId}.status.json`)); } catch { /* Old unverified records are not resumable. */ }
        const session = status?.session;
        if (!validId(session?.id) || typeof session?.file !== 'string') { unavailable.push({ launchId: record.launchId,
          reason: status?.reverified?.result !== 'found' && status?.reverified?.reason || '核验尚未找到会话文件和 ID', canReverify: !session?.id }); continue; }
        try { if (!(await fs.stat(session.file)).isFile()) throw new Error('不是文件'); }
        catch { unavailable.push({ launchId: record.launchId, reason: '会话文件已经不存在或不可读' }); continue; }
        items.push({ launchId: record.launchId, createdAt: record.createdAt, cli: record.cli, mode: launchMode(record), session });
      } catch (error) { await log(`历史读取错误：${name} ${error.message}`); }
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items: items.slice(0, 10), unavailable };
  }
  function scheduleBackfill(id) {
    if (backfillAttempted.has(id)) return;
    backfillAttempted.add(id);
    // Do not wait in GET /history: the next poll picks up persisted evidence.
    reverify([], { jointIds: [id] }).catch(error => log(`联合历史核验错误：${id} ${error.message}`));
  }
  function reverify(agentIds, options = {}) {
    const work = reverifyWork.then(async () => {
      await Promise.all([...entries.values()].map(e => e.checking));
      return reverifyHistory(config, agentIds, { ...options, io, onUpdate: async (id, status, type) => {
        if (type === 'joint') backfillAttempted.add(id);
        const entry = entries.get(key(type, id));
        if (entry) { entry.status = closedStatus(entry.record, status); entry.checkedAt = Date.now(); }
      } });
    });
    reverifyWork = work.catch(() => {});
    return work;
  }
  async function markClosed(type, id, at) {
    const entry = entries.get(key(type, id));
    if (!entry) throw new Error('会话登记不存在');
    if (entry.closing) return entry.closing;
    const pendingReverify = reverifyWork, pendingCheck = entry.checking;
    entry.closing = (async () => {
      await pendingReverify; await pendingCheck;
      const record = { ...entry.record, closedAt: at, closedBy: 'user' };
      await atomicWrite(path.join(directory(type), `${id}.json`), JSON.stringify(record, null, 2) + '\n', io);
      entry.record = record; entry.status = closedStatus(record, entry.status); entry.checkedAt = Date.now();
      // The record is authoritative even if its disposable status cache cannot be saved.
      try { await atomicWrite(path.join(directory(type), `${id}.status.json`), JSON.stringify(entry.status, null, 2) + '\n', io); }
      catch (error) { await log(`已关闭状态缓存写入失败：${id} ${error.message}`); }
    })().finally(() => { entry.closing = undefined; });
    return entry.closing;
  }
  return { register, recover, check, refresh, running, history, reverify, allHistory, originalRecord, markClosed,
    registeredRecord(type, id) { return entries.get(key(type, id))?.record; },
    has(type, id) { return entries.has(key(type, id)); },
    async original(agentId, id) {
      if (!validId(id)) throw Object.assign(new Error('启动记录 ID 无效'), { status: 400 });
      // Refresh the evidence for legacy callers, but do not limit an explicit history selection to ten rows.
      if (entries.has(key('launch', id))) await check('launch', id);
      const result = await originalRecord('launch', id);
      if ((result.record.agentId || normalize(result.record.agentName || '')) !== agentId) throw Object.assign(new Error('该会话不属于所选 Agent'), { status: 409 });
      return result;
    },
    async idle() { await reverifyWork; await Promise.all([...entries.values()].flatMap(e => [e.checking, e.closing])); },
  };
}
