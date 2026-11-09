import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../fsutil.mjs';
import { normalize } from '../registry/identity.mjs';
import { cwdKey, texts, isProbe, lines, dateDirs, closedStatus } from './verify.mjs';
import { launchMode } from './resume.mjs';
import { findJointSession } from '../joint/verify.mjs';

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function candidates(record, config) {
  const found = [];
  if (record.cli === 'claude') {
    const at = record.args?.indexOf('--session-id') ?? -1;
    const id = at >= 0 ? record.args[at + 1] : undefined;
    if (!validId(id)) return found;
    for (const entry of await entries(config.claudeProjectsDir)) {
      if (!entry.isDirectory()) continue;
      const file = path.join(config.claudeProjectsDir, entry.name, `${id}.jsonl`);
      let cwd, agentSetting = null;
      try {
        await lines(file, row => {
          if (cwd === undefined && typeof row.cwd === 'string') cwd = row.cwd;
          if (launchMode(record) === 'agent' && typeof row.agentSetting === 'string' && row.agentSetting === record.agentName) agentSetting = row.agentSetting;
        });
        found.push({ id, file, cwd, evidence: { cli: 'claude', cwd: cwd ?? null, ...(launchMode(record) === 'agent' ? { agentSetting } : {}) } });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else if (record.cli === 'codex') {
    if (!Number.isFinite(Date.parse(record.createdAt))) return found;
    for (const dir of dateDirs(record.createdAt)) for (const entry of await entries(path.join(config.codexSessionsDir, dir))) {
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      const file = path.join(config.codexSessionsDir, dir, entry.name);
      let meta, probe = false;
      await lines(file, (row, index) => {
        if (index === 0) {
          if (row.type !== 'session_meta' || row.payload?.source !== 'cli' || !validId(row.payload.id)) return false;
          meta = row.payload;
        }
        if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user' && isProbe(texts(row.payload.content), record.launchId)) probe = true;
      });
      if (meta && probe) found.push({ id: meta.id, file, cwd: meta.cwd, evidence: { cli: 'codex', source: 'cli', cwd: meta.cwd ?? null, launchId: record.launchId } });
    }
  }
  return found;
}

// No process liveness or spawning: only legacy specs, sidecars and read-only logs.
export async function reverifyHistory(config, agentIds, { io, now = () => new Date().toISOString(), onUpdate = async () => {}, jointIds, allJoints = false } = {}) {
  const scope = new Set(agentIds), summary = { checked: 0, found: 0, notFound: 0 };
  const foundByAgent = Object.fromEntries([...scope].map(id => [id, 0]));
  for (const type of jointIds ? ['joint'] : ['launch', 'joint']) {
    const directory = path.join(config.dataDir, type === 'joint' ? 'joints' : 'launches');
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !validId(entry.name.slice(0, -5))) continue;
      const record = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
      const id = type === 'joint' ? record.jointId : record.launchId;
      if (id !== entry.name.slice(0, -5)) continue;
      const agentId = record.agentId || normalize(record.agentName || '');
      if (type === 'joint') {
        if (jointIds ? !jointIds.includes(id) : !allJoints && !record.whitelist?.some(a => scope.has(a.id))) continue;
      } else if (!scope.has(agentId)) continue;
      const sidecar = path.join(directory, `${id}.status.json`);
      let status = {};
      try { status = JSON.parse(await fs.readFile(sidecar, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (status.session?.id) continue;
      let reverified, session;
      try {
        let matches;
        if (type === 'joint') {
          const match = await findJointSession(record, config);
          matches = match ? [match] : [];
        } else matches = await candidates(record, config);
        if (matches.length > 1) reverified = { result: 'not-found', reason: '多个会话文件匹配该启动记录，无法唯一核验' };
        else if (!matches.length) reverified = { result: 'not-found', reason: '会话文件不存在（该次启动未生成会话记录）' };
        else {
          const match = matches[0];
          const expectedCwd = type === 'joint' ? record.cwd || record.launchProject || config.launchProject : config.launchProject;
          if (!cwdKey(match.cwd)) reverified = { result: 'not-found', reason: '找到会话但缺少工作目录证据' };
          else if (cwdKey(match.cwd) !== cwdKey(expectedCwd)) reverified = { result: 'cwd-mismatch', reason: `找到会话但工作目录不符：${match.cwd}` };
          else if (!validId(match.id)) reverified = { result: 'not-found', reason: '会话 ID 无效' };
          else { session = { id: match.id, file: match.file }; reverified = { result: 'found', evidence: match.evidence || { cli: record.cli, cwd: match.cwd, jointId: id } }; }
        }
      } catch (error) { reverified = { result: 'not-found', reason: `会话日志读取失败：${error.code || 'ERROR'}: ${error.message}` }; }
      const updated = { ...status, reverified: { ...status.reverified, at: now(), ...reverified } };
      if (session) {
        updated.session = { ...status.session, ...session };
        if (type === 'launch') Object.assign(updated, { process: { ...status.process, state: 'exited' }, overall: 'historical', message: '历史会话 · 已核验' });
      }
      Object.assign(updated, closedStatus(record, updated));
      await atomicWrite(sidecar, JSON.stringify(updated, null, 2) + '\n', io);
      await onUpdate(id, updated, type);
      summary.checked++;
      if (session) {
        summary.found++;
        for (const member of type === 'joint' ? new Set(record.whitelist.map(a => a.id)) : [agentId]) if (scope.has(member)) foundByAgent[member]++;
      } else summary.notFound++;
    }
  }
  return { summary, foundByAgent };
}
