import { recommendSettings } from '../config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { runRecommendation } from './runner.mjs';
import { createJoint } from '../joint/spec.mjs';
import { verifyJoint } from '../joint/verify.mjs';
import { missingSourcesFor } from '../../public/display.js';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
async function list(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function createWorkflows(config, getRegistry, { spawnImpl, recommendSpawnImpl, recommendRunner = runRecommendation, jointVerifier = verifyJoint, sessions } = {}) {
  const work = new Set(), checks = new Map();
  const recommendFile = id => path.join(config.dataDir, 'recommend', id, 'record.json');
  const jointFile = id => path.join(config.dataDir, 'joints', `${id}.json`);
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail(404, '记录不存在'); throw error; }
  }
  async function recover() {
    for (const entry of await list(path.join(config.dataDir, 'recommend'))) if (entry.isDirectory() && validId(entry.name)) {
      const file = recommendFile(entry.name);
      const record = await read(file);
      if (record.status === 'running') {
        record.status = 'failed'; record.error = '服务器重启，推荐进程状态无法恢复'; record.results = []; record.rejected = [];
        await atomicWrite(file, JSON.stringify(record, null, 2) + '\n');
      }
    }
  }
  return {
    recover,
    async startRecommendation(body) {
      if (!body || typeof body.input !== 'string' || !body.input.trim() || body.input.length > 8000 || !['claude', 'codex'].includes(body.engine)) fail(400, '输入必须为 1–8000 字，引擎必须为 claude 或 codex');
      const recommendId = randomUUID(), settings = recommendSettings(config, body.engine);
      const record = { recommendId, input: body.input, engine: body.engine, model: settings.model, effort: settings.effort, createdAt: new Date().toISOString(), status: 'running', results: [], rejected: [], audit: null, error: null };
      await atomicWrite(recommendFile(recommendId), JSON.stringify(record, null, 2) + '\n');
      const snapshot = structuredClone(getRegistry().agents);
      const promise = Promise.resolve().then(() => recommendRunner(record, snapshot, config, { spawnImpl: recommendSpawnImpl })).catch(error => ({ ...record, status: 'failed', error: error.message }))
        .then(result => atomicWrite(recommendFile(recommendId), JSON.stringify(result, null, 2) + '\n'));
      work.add(promise);
      // Keep rejected work observable through idle()/close(), never launch a recovery CLI.
      promise.catch(() => {}).finally(() => work.delete(promise));
      return { recommendId };
    },
    async recommendation(id) {
      if (!validId(id)) fail(404, '推荐记录不存在');
      return read(recommendFile(id));
    },
    async startJoint(body, { originalJoint, group } = {}) {
      // Only the server's stored joint may supply rerun provenance; request fields cannot bypass recommendation checks.
      if (originalJoint) body = { ...body, source: originalJoint.source || 'recommend', recommendId: originalJoint.recommendId ?? null,
        input: originalJoint.input, cli: originalJoint.cli, agentIds: originalJoint.whitelist.map(a => a.id), crossExam: originalJoint.crossExam === true };
      // v0.14: a saved 调用组 run. The group (members) comes from the server's store, never from the request body.
      const groupRef = group ? { id: group.id, name: group.name } : originalJoint?.group || null;
      if (group) body = { ...body, source: 'group', recommendId: null, agentIds: [...group.agentIds] };
      if (body?.source === 'group' && !groupRef) fail(400, '联合调用参数无效');
      if (!body || ![undefined, 'recommend', 'manual', 'group'].includes(body.source) || (!originalJoint && !['manual', 'group'].includes(body.source) && !validId(body.recommendId)) || !['claude', 'codex'].includes(body.cli) || !Array.isArray(body.agentIds) || !body.agentIds.length || body.agentIds.length > 8 ||
          body.agentIds.some(id => typeof id !== 'string') || new Set(body.agentIds).size !== body.agentIds.length ||
          ![undefined, true, false].includes(body.crossExam)) fail(400, '联合调用参数无效');
      const manual = body.source === 'manual' || body.source === 'group';
      const record = manual || originalJoint ? { input: body.input } : await read(recommendFile(body.recommendId));
      if (!manual && !originalJoint && (record.status !== 'done' || body.agentIds.some(id => !record.results.some(a => a.id === id)))) fail(400, 'agentIds 必须是本次推荐结果的非空子集');
      if (typeof record.input !== 'string' || !record.input.trim() || record.input.length > 8000) fail(400, '输入必须为 1–8000 字');
      const current = getRegistry().agents, agents = body.agentIds.map(id => current.find(a => a.id === id));
      if ((manual || originalJoint) && agents.some(a => !a)) fail(400, '该 Agent 不在范围内注册表中');
      const unavailable = body.agentIds.flatMap((id, i) => !agents[i]?.platforms[body.cli]?.available ? [{ id, name: agents[i]?.name || id, reason: agents[i]?.platforms[body.cli]?.reason || '当前注册表中不可用' }] : []);
      if (unavailable.length) fail(409, '所选 CLI 中存在不可用 Agent', { unavailable });
      const writable = agents.filter(a => a.writable);
      if (writable.length && body.writableConfirmed !== true) fail(409, '存在可写 Agent，请先确认权限', { writable: writable.map(a => ({ id: a.id, name: a.name, permissions: a.permissions })) });
      if (agents.some(a => missingSourcesFor(a, body.cli).length) && body.sourcesConfirmed !== true) fail(409, '原书路径失效，请先确认');
      try {
        const joint = await createJoint({ source: groupRef ? 'group' : manual ? 'manual' : 'recommend', recommendId: manual ? null : body.recommendId,
          rerunOf: originalJoint?.jointId, group: groupRef, input: record.input, cli: body.cli, agents, crossExam: body.crossExam === true }, config, { spawnImpl });
        await sessions?.register('joint', joint);
        return { jointId: joint.jointId, cli: joint.cli, whitelist: joint.whitelist, crossExam: joint.crossExam,
          argvPreview: joint.argvPreview, terminalFallback: joint.terminalFallback };
      } catch (error) { fail(409, `联合调用启动失败：${error.message}`); }
    },
    async joint(id) {
      if (!validId(id)) fail(404, '联合调用记录不存在');
      const record = await read(jointFile(id));
      if (sessions && !sessions.has('joint', id)) await sessions.register('joint', record);
      let entry = checks.get(id);
      if (!entry) { entry = { checkedAt: 0 }; checks.set(id, entry); }
      if (!entry.status || Date.now() - entry.checkedAt >= config.verifyPollMs) {
        if (!entry.checking) entry.checking = (sessions ? sessions.check('joint', id) : jointVerifier(record, config)).then(async status => {
          if (record.terminalFallback) status.terminalFallback = record.terminalFallback;
          if (!sessions) await atomicWrite(path.join(config.dataDir, 'joints', `${id}.status.json`), JSON.stringify(status, null, 2) + '\n');
          entry.status = status; entry.checkedAt = Date.now();
        }).finally(() => { entry.checking = null; });
        await entry.checking;
      }
      return { jointId: id, cli: record.cli, whitelistNames: record.whitelist, createdAt: record.createdAt, ...entry.status };
    },
    async recent() {
      const items = [];
      for (const entry of await list(path.join(config.dataDir, 'recommend'))) if (entry.isDirectory() && validId(entry.name)) {
        const record = await read(recommendFile(entry.name));
        items.push({ id: entry.name, type: 'recommend', engine: record.engine, status: record.status, createdAt: record.createdAt, preview: record.input.slice(0, 100) });
      }
      for (const entry of await list(path.join(config.dataDir, 'joints'))) if (entry.isFile() && validId(entry.name.slice(0, -5)) && entry.name.endsWith('.json')) {
        const record = await read(path.join(config.dataDir, 'joints', entry.name));
        items.push({ id: record.jointId, type: 'joint', cli: record.cli, createdAt: record.createdAt, whitelist: record.whitelist, preview: record.input.slice(0, 100), terminalFallback: record.terminalFallback });
      }
      items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return { items: items.slice(0, 20) };
    },
    async idle() { await Promise.all([...work]); },
  };
}
