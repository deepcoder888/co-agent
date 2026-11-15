import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import path from 'node:path';
import { processAlive, closedStatus } from '../launch/verify.mjs';
import { parseCodex } from '../stats/codex.mjs';

// Codex writes session_meta within seconds of launch. Allow clock skew, but
// exclude later manual reuse of the prompt so it cannot make the original ambiguous.
const SESSION_BEFORE_MS = 5 * 60_000;
const SESSION_AFTER_MS = 10 * 60_000;

const cwdKey = value => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : '';
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(b => b.text || '').join('\n') : '';

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readRows(file, firstOnly = false, content) {
  const input = content === undefined ? createReadStream(file, { encoding: 'utf8' }) : Readable.from([content]);
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const rows = []; let line = 0;
  try {
    for await (const raw of reader) {
      line++; if (!raw.trim()) continue;
      let row;
      try { row = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { throw new Error(`会话 JSON 无效：${file}:${line}`); }
      if (!row || typeof row !== 'object') throw new Error(`会话行无效：${file}:${line}`);
      rows.push({ row, evidence: { file, line } });
      if (firstOnly) break;
    }
  } finally { reader.close(); input.destroy(); }
  return rows;
}

async function claudeSession(sessionId, config, includeChildren = true) {
  const matches = [];
  for (const entry of await entries(config.claudeProjectsDir)) if (entry.isDirectory()) {
    const dir = path.join(config.claudeProjectsDir, entry.name), file = path.join(dir, `${sessionId}.jsonl`);
    try { await fs.stat(file); matches.push({ dir, file }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length > 1) throw new Error('多个 Claude 主会话匹配相同 ID，无法唯一核验');
  if (!matches.length) return null;
  const { dir, file } = matches[0];
  const children = includeChildren ? await claudeChildren(dir, sessionId) : [];
  const childEntries = includeChildren ? await entries(path.join(dir, sessionId, 'subagents')) : [];
  return { file, rows: await readRows(file), children, childEntryCount: childEntries.length };
}

async function claudeChildren(dir, sessionId) {
  const children = [];
  const childEntries = await entries(path.join(dir, sessionId, 'subagents'));
  for (const entry of childEntries) if (entry.isFile() && entry.name.endsWith('.jsonl')) {
    const childFile = path.join(dir, sessionId, 'subagents', entry.name);
    children.push({ file: childFile, rows: await readRows(childFile) });
  }
  return children;
}

function claudeTools(rows) {
  const uses = new Map(), results = new Map();
  for (const { row, evidence } of rows) for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
    if (row.type === 'assistant' && block.type === 'tool_use' && block.name === 'Agent') {
      if (typeof block.id !== 'string' || typeof block.input?.subagent_type !== 'string') throw new Error(`Agent 工具调用缺少身份：${evidence.file}:${evidence.line}`);
      uses.set(block.id, { agent: block.input.subagent_type, id: block.id, messageId: row.message.id || `line-${evidence.line}`, evidence });
    }
    if (row.type === 'user' && block.type === 'tool_result') {
      if (!results.has(block.tool_use_id) || block.is_error === true) results.set(block.tool_use_id, { ...block, evidence });
    }
  }
  return { uses: [...uses.values()], results };
}

async function codexIndex(config) {
  const files = [];
  async function walk(dir) {
    for (const entry of await entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
    }
  }
  await walk(config.codexSessionsDir);
  const index = [];
  for (const file of files) {
    const first = (await readRows(file, true))[0];
    if (first?.row.type !== 'session_meta' || typeof first.row.payload?.id !== 'string') throw new Error(`session_meta 无效：${file}`);
    // Any source.subagent (thread_spawn, Codex >= 0.161 "guardian", other kinds) is never a main session.
    // Only thread_spawn children are whitelist-checked; guardian rollouts copy the parent conversation, marker included.
    const subagent = first.row.payload.source?.subagent;
    index.push({ file, meta: first.row.payload, spawn: subagent?.thread_spawn, subagent: !!subagent });
  }
  return index;
}

function descendants(index, mainId) {
  const selected = [], linked = new Set([mainId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of index) if (item.spawn && linked.has(item.spawn.parent_thread_id) && !linked.has(item.meta.id)) {
      selected.push(item); linked.add(item.meta.id); changed = true;
    }
  }
  return selected;
}

// Live verification and legacy backfill share the same clock-skew window and
// raw-ID prefilter. Copies inside the window still count as ambiguous matches.
export async function findJointSession(joint, config, index, { io = fs } = {}) {
  const marker = `【CO-AGENT 联合调用 ${joint.jointId}】`;
  if (joint.cli === 'claude') {
    const id = joint.sessionId || joint.jointId, session = await claudeSession(id, config, false);
    if (!session) return null;
    const start = session.rows.findIndex(({ row }) => row.type === 'user' && textOf(row.message?.content).includes(marker));
    if (start < 0) return null;
    return { ...session, id, cwd: session.rows.find(({ row }) => typeof row.cwd === 'string')?.row.cwd, rows: session.rows.slice(start) };
  }
  if (joint.cli !== 'codex') throw new Error('联合记录 CLI 无效');
  const earliest = Date.parse(joint.createdAt) - SESSION_BEFORE_MS, latest = Date.parse(joint.createdAt) + SESSION_AFTER_MS;
  if (!Number.isFinite(earliest)) throw new Error('联合记录创建时间无效');
  const matches = [];
  for (const item of index || await codexIndex(config)) if (!item.spawn && !item.subagent && Date.parse(item.meta.timestamp) >= earliest && Date.parse(item.meta.timestamp) <= latest) {
    const content = await io.readFile(item.file);
    if (!content.includes(joint.jointId)) continue;
    const rows = await readRows(item.file, false, content);
    const start = rows.findIndex(({ row }) => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user' && textOf(row.payload.content).includes(marker));
    if (start >= 0) matches.push({ ...item, id: item.meta.id, cwd: item.meta.cwd, rows: rows.slice(start) });
  }
  if (matches.length > 1) throw new Error('多个会话匹配联合标记，无法唯一核验');
  return matches[0] || null;
}

const resumeSince = joint => Math.max(joint.resumeBaseline?.mtimeMs || 0, Date.parse(joint.createdAt) || 0);

async function resumedSession(joint, status) {
  const size = joint.resumeBaseline?.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('恢复记录缺少原文件大小');
  const file = joint.sessionFile, content = await fs.readFile(file), stat = await fs.stat(file);
  if (content.length < size) throw new Error('会话文件被截断');
  if (size > 0 && content[size - 1] !== 10) throw new Error('恢复基线不在完整日志行边界');
  const firstLine = content.toString('utf8', 0, content.indexOf(10) < 0 ? content.length : content.indexOf(10));
  const first = firstLine.trim() ? JSON.parse(firstLine.replace(/^\uFEFF/, '')) : null;
  if (joint.cli === 'codex' && (first?.type !== 'session_meta' || first.payload?.id !== joint.sessionId)) throw new Error('恢复失败：会话 ID 改变');
  const lineOffset = content.subarray(0, size).reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0);
  const rows = [];
  for (const [index, raw] of content.subarray(size).toString('utf8').split('\n').entries()) {
    if (!raw.trim()) continue;
    const row = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!row || typeof row !== 'object') throw new Error('恢复会话行无效');
    if (joint.cli === 'claude' && row.sessionId !== undefined && row.sessionId !== joint.sessionId) throw new Error('恢复失败：会话 ID 改变');
    rows.push({ row, evidence: { file, line: lineOffset + index + 1 } });
  }
  status.session = { id: joint.sessionId, file };
  status.resume = { state: rows.length && content.length > size ? 'ok' : 'pending', baselineSize: size,
    size: content.length, mtimeMs: stat.mtimeMs, evidence: { file, firstLine: rows[0]?.evidence.line } };
  return { id: joint.sessionId, file, rows, meta: first?.payload,
    cwd: (joint.cli === 'claude' ? rows.find(({ row }) => typeof row.cwd === 'string')?.row.cwd : first?.payload?.cwd) || joint.cwd };
}

function codexTools(rows) {
  return rows.flatMap(({ row, evidence }) => {
    const p = row.type === 'response_item' ? row.payload : null;
    if (!p || p.type !== 'function_call') return [];
    const name = p.name?.split('.').at(-1);
    if (!['spawn_agent', 'wait_agent'].includes(name)) return [];
    let args;
    try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments; }
    catch { throw new Error(`工具参数 JSON 无效：${evidence.file}:${evidence.line}`); }
    return [{ name, args, evidence }];
  });
}

export async function auditRecommendation(record, config) {
  try {
    let agentCalls, children;
    if (record.engine === 'claude') {
      const session = await claudeSession(record.sessionId || record.recommendId, config);
      if (!session?.rows.length) throw new Error('推荐会话记录尚不可读或为空');
      agentCalls = claudeTools(session.rows).uses.length + session.children.reduce((n, c) => n + claudeTools(c.rows).uses.length, 0);
      children = session.childEntryCount;
    } else {
      if (!record.threadId) throw new Error('推荐事件流未提供 thread_id');
      const index = await codexIndex(config), main = index.filter(s => s.meta.id === record.threadId);
      if (main.length !== 1) throw new Error('推荐线程记录缺失或重复');
      const linked = descendants(index, record.threadId);
      children = linked.length; agentCalls = 0;
      for (const item of [...main, ...linked]) agentCalls += codexTools(await readRows(item.file)).filter(t => t.name === 'spawn_agent').length;
    }
    return { agentCalls, children, ok: agentCalls === 0 && children === 0 };
  } catch (error) { return { agentCalls: null, children: null, ok: false, error: `${error.code || 'ERROR'}: ${error.message}` }; }
}

function setCwd(status, observed, config) {
  if (typeof observed === 'string') status.cwd = { state: cwdKey(observed) === cwdKey(config.launchProject) ? 'ok' : 'mismatch', observed };
}

function stateFromUses(uses, results, name) {
  const calls = uses.filter(u => u.agent === name);
  if (!calls.length) return { state: 'pending', evidence: [] };
  const states = calls.map(u => results.has(u.id) ? results.get(u.id).is_error === true ? 'failed' : 'done' : 'running');
  return { state: states.includes('running') ? 'running' : states.includes('failed') ? 'failed' : 'done',
    evidence: calls.map(u => ({ ...u.evidence, toolUseId: u.id, result: results.get(u.id)?.evidence })) };
}

async function verifyClaude(joint, config, status) {
  const session = joint.resumeOf ? await resumedSession(joint, status) : await findJointSession(joint, config);
  if (!session) return;
  status.session = { id: session.id, file: session.file };
  const rows = session.rows;
  setCwd(status, session.cwd, joint.resumeOf ? { launchProject: joint.cwd } : config);
  const { uses, results } = claudeTools(rows), allowed = joint.whitelist.map(a => a.claudeName), firstRound = firstRoundNames(joint, 'claudeName');
  if (uses.length) {
    const first = uses.filter(u => u.messageId === uses[0].messageId);
    status.parallel = { state: firstRound.every(n => first.some(u => u.agent === n)) ? 'ok' : 'not-parallel', evidence: first.map(u => ({ agent: u.agent, messageId: u.messageId, ...u.evidence })) };
  }
  if (status.crossExam) crossExamState(status, firstRound, name => uses.filter(u => u.agent === name).length);
  const violations = [], deniedAttempts = [];
  for (const use of uses) if (!allowed.includes(use.agent)) {
    const result = results.get(use.id);
    if (result?.is_error === true && /denied by permission rule/i.test(textOf(result.content))) deniedAttempts.push({ ...use, result: result.evidence });
    else violations.push(use);
  }
  for (const child of await claudeChildren(path.dirname(session.file), session.id)) {
    const childRows = joint.resumeOf ? child.rows.filter(({ row }) => Date.parse(row.timestamp) >= resumeSince(joint)) : child.rows;
    for (const use of claudeTools(childRows).uses) violations.push({ ...use, reason: '子会话嵌套调用 Agent' });
  }
  status.whitelist = { state: violations.length ? 'violation' : 'ok', violations, deniedAttempts };
  status.calls = joint.whitelist.map(a => ({ agent: a.claudeName, ...stateFromUses(uses, results, a.claudeName) }));
}

async function verifyCodex(joint, config, status) {
  const main = joint.resumeOf ? await resumedSession(joint, status) : null;
  const index = await codexIndex(config), session = main || await findJointSession(joint, config, index);
  if (!session) return;
  setCwd(status, session.cwd, joint.resumeOf ? { launchProject: joint.cwd } : config);
  status.session = { id: session.id, file: session.file };
  const tools = codexTools(session.rows), wait = tools.findIndex(t => t.name === 'wait_agent');
  const spawns = (wait < 0 ? tools : tools.slice(0, wait)).filter(t => t.name === 'spawn_agent');
  const allowed = joint.whitelist.map(a => a.codexName), firstRound = firstRoundNames(joint, 'codexName'), linked = descendants(index, session.id)
    .filter(child => !joint.resumeOf || Date.parse(child.meta.timestamp) >= resumeSince(joint));
  if (status.crossExam) crossExamState(status, firstRound, name => tools.filter(t => t.name === 'spawn_agent' && t.args?.agent_type === name).length);
  if (wait >= 0) status.parallel = { state: spawns.length >= firstRound.length && firstRound.every(n => spawns.some(t => t.args?.agent_type === n)) && spawns.every(t => allowed.includes(t.args?.agent_type)) ? 'ok' : 'not-parallel', evidence: spawns.map(t => ({ agent: t.args?.agent_type, ...t.evidence })) };
  const violations = linked.filter(c => !allowed.includes(c.spawn.agent_role) || c.spawn.depth >= 2 || c.spawn.parent_thread_id !== session.id)
    .map(c => ({ agent: c.spawn.agent_role, parentThreadId: c.spawn.parent_thread_id, depth: c.spawn.depth, file: c.file, line: 1 }));
  for (const tool of tools) if (tool.name === 'spawn_agent' && !allowed.includes(tool.args?.agent_type)) {
    violations.push({ agent: tool.args?.agent_type || '(missing agent_type)', ...tool.evidence });
  }
  status.whitelist = { state: violations.length ? 'violation' : 'ok', violations, deniedAttempts: [] };
  const childStates = [];
  for (const child of linked.filter(c => c.spawn.parent_thread_id === session.id)) {
    const parsed = await parseCodex(child.file), event = parsed.events[0];
    if (parsed.badLines) throw new Error(`子会话末尾存在 ${parsed.badLines} 个坏行：${child.file}`);
    childStates.push({ name: child.spawn.agent_role, state: event?.status === 'ok' ? 'done' : event?.status === 'failed' ? 'failed' : 'running', evidence: event?.statusEvidence || { file: child.file, line: 1 } });
  }
  status.calls = allowed.map(name => {
    const children = childStates.filter(c => c.name === name);
    return { agent: name, state: !children.length ? 'pending' : children.some(c => c.state === 'running') ? 'running' : children.some(c => c.state === 'failed') ? 'failed' : 'done', evidence: children.map(c => c.evidence) };
  });
}

// v0.24: reviewer roles join after the first round, so only first-round members must start in parallel.
function firstRoundNames(joint, key) { return joint.whitelist.filter(a => a.stage !== 'review').map(a => a[key]); }
// A requested cross-examination calls every first-round member a second time (a new call, never a reuse).
function crossExamState(status, firstRound, count) {
  const evidence = firstRound.map(agent => ({ agent, calls: count(agent) }));
  status.crossExam = { state: evidence.every(e => e.calls >= 2) ? 'ok' : 'pending', evidence };
}

export async function verifyJoint(joint, config, { now = Date.now(), isAlive = processAlive } = {}) {
  if (joint.closedAt) return closedStatus(joint);
  const status = { process: { state: isAlive(joint.pid) ? 'alive' : 'exited', pid: joint.pid }, cwd: { state: 'pending', observed: null },
    parallel: { state: 'pending', evidence: [] }, whitelist: { state: 'pending', violations: [], deniedAttempts: [] },
    calls: joint.whitelist.map(a => ({ agent: joint.cli === 'claude' ? a.claudeName : a.codexName, state: 'pending', evidence: [] })), overall: 'pending' };
  if (joint.cli === 'codex') status.taskTextNote = 'Codex 交给各 Agent 的任务文本在日志里是加密的，无法核对；它调用了哪些 Agent 只能在运行后核对。';
  if (joint.resumeOf) status.resume = { state: 'pending' };
  if (joint.crossExam === true) status.crossExam = { state: 'pending', evidence: [] };
  try { await (joint.cli === 'claude' ? verifyClaude : verifyCodex)(joint, config, status); }
  catch (error) { status.evidenceError = `${error.code || 'ERROR'}: ${error.message}`; }
  const settled = status.calls.every(c => ['done', 'failed'].includes(c.state));
  // Requested means required: a session that ended without the cross-examination round failed.
  if (status.crossExam?.state === 'pending' && status.process.state === 'exited' && !status.evidenceError && !joint.resumeOf) {
    status.crossExam.state = 'failed'; status.message = '已勾选交叉质询，但会话结束前没有检测到质询轮';
  }
  const crossExamOk = !status.crossExam || status.crossExam.state === 'ok';
  if (joint.error || status.cwd.state === 'mismatch' || status.whitelist.state === 'violation' || status.crossExam?.state === 'failed') status.overall = 'failed';
  else if (joint.resumeOf && !status.evidenceError && status.resume.state === 'ok' && status.process.state === 'alive' && status.whitelist.state === 'ok') {
    status.overall = status.calls.some(c => c.state === 'failed') ? 'failed' : 'resumed';
    status.message = status.overall === 'resumed' ? '已恢复 · 会话文件增长，调用范围已核对' : '恢复后的 Agent 调用失败';
  }
  else if (!status.evidenceError && settled && crossExamOk && status.cwd.state === 'ok' && status.parallel.state === 'ok' && status.whitelist.state === 'ok') status.overall = status.calls.some(c => c.state === 'failed') ? 'failed' : 'done';
  else if (now - Date.parse(joint.createdAt) > 900000) status.overall = 'unconfirmed';
  else if (status.process.state === 'exited') status.overall = 'failed';
  if (joint.error) status.evidenceError = joint.error;
  return status;
}
