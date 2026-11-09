import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { normalize } from '../registry/identity.mjs';

export { cwdKey, texts, isProbe, lines, dateDirs };

const cwdKey = value => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : '';
const texts = content => typeof content === 'string' ? content : Array.isArray(content) ?
  content.filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text || '').join('\n') : '';
const message = row => row.type === 'response_item' && row.payload?.type === 'message' ? row.payload : null;
const threadSpawn = row => row?.payload?.source?.subagent?.thread_spawn;
const isProbe = (text, id) => ['CO-AGENT', 'Agent Hub'].some(brand => text.includes(`【${brand} 启动检查 ${id}】`));

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function closedStatus(record, status = {}) {
  return record.closedAt ? { ...status, overall: 'closed', message: '已关闭（用户）',
    process: { ...status.process, state: 'exited', pid: record.pid } } : status;
}

async function lines(file, visitor) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of reader) {
      let row;
      try { row = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { index++; continue; }
      if (visitor(row, index++) === false) break;
    }
  } finally { reader.close(); input.destroy(); }
}

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function claudeEvidence(launch, config, status) {
  const files = (await entries(config.claudeProjectsDir)).filter(e => e.isDirectory()).map(e =>
    path.join(config.claudeProjectsDir, e.name, `${launch.sessionId}.jsonl`));
  for (const file of files) {
    let probeSeen = false, observedCwd = false;
    try {
      await lines(file, row => {
        if (!observedCwd && typeof row.cwd === 'string') {
          observedCwd = true;
          status.cwd = { state: cwdKey(row.cwd) === cwdKey(config.launchProject) ? 'ok' : 'mismatch', observed: row.cwd };
        }
        if (row.type === 'user' && isProbe(texts(row.message?.content), launch.launchId)) probeSeen = true;
        if (launch.mode === 'agent' && row.type === 'agent-setting' && typeof row.agentSetting === 'string') {
          const same = normalize(row.agentSetting) === normalize(launch.agentName);
          if (status.agent.state !== 'mismatch') status.agent = { state: same ? 'confirmed' : 'mismatch', evidence: { file, type: 'agent-setting', agentSetting: row.agentSetting } };
        }
        if (row.type === 'assistant') {
          if (probeSeen && texts(row.message?.content).trim() && status.process.state === 'alive') status.waiting.state = 'ok';
          if (launch.mode === 'relay' && Array.isArray(row.message?.content)) {
            for (const tool of row.message.content) if (tool.type === 'tool_use' && tool.name === 'Agent' && typeof tool.input?.subagent_type === 'string') {
              const same = normalize(tool.input.subagent_type) === normalize(launch.agentName);
              if (status.agent.state !== 'mismatch') status.agent = { state: same ? 'confirmed' : 'mismatch', evidence: { file, type: 'tool_use', subagent_type: tool.input.subagent_type } };
            }
          }
        }
      });
      status.session = { id: launch.sessionId, file };
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function dateDirs(createdAt) {
  const start = new Date(createdAt), dirs = new Set();
  for (const offset of [0, 1]) {
    const date = new Date(start); date.setUTCDate(date.getUTCDate() + offset);
    dirs.add(date.toISOString().slice(0, 10).replaceAll('-', '/'));
    const local = new Date(start); local.setDate(local.getDate() + offset);
    dirs.add(`${local.getFullYear()}/${String(local.getMonth() + 1).padStart(2, '0')}/${String(local.getDate()).padStart(2, '0')}`);
  }
  return [...dirs];
}

async function codexEvidence(launch, config, status) {
  const files = [];
  for (const dir of dateDirs(launch.createdAt)) {
    const absolute = path.join(config.codexSessionsDir, dir);
    for (const entry of await entries(absolute)) if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path.join(absolute, entry.name));
  }
  const children = [], mains = [];
  for (const file of files) {
    let meta, main = false, ready = false;
    try {
      if ((await fs.stat(file)).mtimeMs < Date.parse(launch.createdAt)) continue;
      await lines(file, (row, index) => {
        if (index === 0) {
          if (row.type !== 'session_meta' || !row.payload) return false;
          meta = row.payload;
          const child = threadSpawn(row);
          if (child) { children.push({ ...child, file }); return false; }
          // Guardian and other non-spawn subagent rollouts copy the parent's probe message; they are never the main session.
          if (row.payload.source?.subagent) return false;
          if (!meta.id || !Number.isFinite(Date.parse(meta.timestamp)) || Date.parse(meta.timestamp) < Date.parse(launch.createdAt)) return false;
        }
        const msg = message(row);
        if (msg?.role === 'user' && isProbe(texts(msg.content), launch.launchId)) main = true;
        if (main && msg?.role === 'assistant' && texts(msg.content).trim()) ready = true;
      });
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (main && meta) mains.push({ meta, ready, file });
  }
  if (mains.length > 1) {
    status.agent = { state: 'mismatch', evidence: '多个主会话包含相同 launchId，无法唯一核验' }; return;
  }
  const main = mains[0];
  if (!main) return;
  status.session = { id: main.meta.id, file: main.file };
  if (typeof main.meta.cwd === 'string') status.cwd = { state: cwdKey(main.meta.cwd) === cwdKey(config.launchProject) ? 'ok' : 'mismatch', observed: main.meta.cwd };
  if (main.ready && status.process.state === 'alive') status.waiting.state = 'ok';
  const linked = children.filter(c => c.parent_thread_id === main.meta.id);
  const wrong = linked.find(c => typeof c.agent_role !== 'string' || normalize(c.agent_role) !== normalize(launch.agentName));
  const correct = linked.find(c => typeof c.agent_role === 'string' && normalize(c.agent_role) === normalize(launch.agentName));
  if (wrong || correct) status.agent = { state: wrong ? 'mismatch' : 'confirmed', evidence: wrong || correct };
}

export async function verifyLaunch(launch, config, { now = Date.now(), isAlive = processAlive } = {}) {
  if (launch.closedAt) return closedStatus(launch, { notice: launch.notice });
  const status = { process: { state: isAlive(launch.pid) ? 'alive' : 'exited', pid: launch.pid },
    cwd: { state: 'pending', observed: null }, agent: { state: launch.mode === 'agent' ? 'pending' : 'awaiting-first-call', evidence: null },
    waiting: { state: 'pending' }, overall: 'pending', message: '正在核验启动', notice: launch.notice };
  if (status.process.state === 'alive') {
    try {
      if (launch.cli === 'claude') await claudeEvidence(launch, config, status);
      else await codexEvidence(launch, config, status);
    } catch (error) { status.evidenceError = `${error.code || 'ERROR'}: ${error.message}`; }
  }
  const mismatch = status.cwd.state === 'mismatch' ? '工作目录不符' : status.agent.state === 'mismatch' ? 'Agent 不符' : null;
  if (mismatch || status.process.state === 'exited') {
    status.overall = 'failed'; status.reason = mismatch || '进程已退出'; status.message = `启动失败：${status.reason}`;
  } else if (status.cwd.state === 'ok' && status.waiting.state === 'ok' &&
    (status.agent.state === 'confirmed' || (launch.mode === 'relay' && status.agent.state === 'awaiting-first-call'))) {
    status.overall = 'ready';
    status.message = status.agent.state === 'awaiting-first-call' ? '已就绪 · Agent 首次提问后核验' : '已就绪';
  } else if (now - Date.parse(launch.createdAt) > config.verifyTimeoutMs) {
    status.overall = 'unconfirmed'; status.message = '启动未确认';
  }
  return status;
}
