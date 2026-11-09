import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

export function skillStructure(markdown = '') {
  const sections = new Set(); let titleLine = false, fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^# .+ - AI-Era Learning Map\s*$/.test(line)) titleLine = true;
    const section = line.match(/^### (1[01]|[1-9])\.\s+\S/);
    if (section) sections.add(Number(section[1]));
  }
  const missing = Array.from({ length: 11 }, (_, i) => i + 1).filter(n => !sections.has(n));
  return { state: titleLine && !missing.length ? 'ok' : 'missing', missing, titleLine };
}

// Same first-row metadata index and five-minute prefilter as joint/verify.mjs.
// Its private index is not exported; keep the concept marker reader within A1.
async function indexRollouts(config, io) {
  const index = [];
  async function walk(dir) {
    let entries;
    try { entries = await io.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const input = createReadStream(file, { encoding: 'utf8', highWaterMark: 4096 });
        const reader = readline.createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of reader) {
            if (!line.trim()) continue;
            const row = JSON.parse(line.replace(/^\uFEFF/, ''));
            if (row.type !== 'session_meta' || typeof row.payload?.id !== 'string') throw new Error(`session_meta 无效：${file}`);
            index.push({ file, meta: row.payload, spawn: row.payload.source?.subagent?.thread_spawn }); break;
          }
        } finally { reader.close(); input.destroy(); }
      }
    }
  }
  await walk(config.codexSessionsDir); return index;
}

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.text || '').join('\n') : '';
async function evidence(record, config, perspectives, io, markerPrefix) {
  const earliest = Date.parse(record.createdAt) - 300000;
  if (!Number.isFinite(earliest)) throw new Error('创建时间无效');
  const id = perspectives ? record.runId : record.conceptId;
  const marker = `【CO-AGENT ${markerPrefix || (perspectives ? '概念多视角' : '随机概念')} ${id}】`;
  const index = await indexRollouts(config, io), matches = [];
  for (const item of index) {
    if (item.meta.source !== 'exec' || Date.parse(item.meta.timestamp) < earliest || !Number.isFinite(Date.parse(item.meta.timestamp))) continue;
    const content = await io.readFile(item.file, 'utf8');
    if (!content.includes(id)) continue;
    const rows = content.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s.replace(/^\uFEFF/, '')));
    const start = rows.findIndex(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user' && textOf(r.payload.content).includes(marker));
    if (start >= 0) matches.push({ ...item, rows: rows.slice(start) });
  }
  if (matches.length > 1) throw new Error('多个主会话匹配概念标记，存在歧义');
  if (!matches.length) return null;
  const main = matches[0], ids = new Set([main.meta.id]), linked = [];
  // Walk all descendants, not only immediate children: recursion is a violation.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of index) if (item.spawn && ids.has(item.spawn.parent_thread_id) && !linked.includes(item)) {
      linked.push(item); ids.add(item.meta.id); changed = true;
    }
  }
  const tools = main.rows.flatMap((row, i) => {
    const p = row.type === 'response_item' && row.payload;
    if (p?.type !== 'function_call') return [];
    const name = p.name?.split('.').at(-1);
    if (!['spawn_agent', 'wait_agent'].includes(name)) return [];
    return [{ name, args: typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments, file: main.file, row: i }];
  });
  return { main, linked, tools };
}

export async function verifyConcept(record, config, { io = fs } = {}) {
  const result = { state: 'unconfirmed', session: null, children: [], skillStructure: skillStructure(record.result?.markdown), violations: [] };
  try {
    const found = await evidence(record, config, false, io); if (!found) return result;
    const { main, linked, tools } = found, allowed = record.agent.codexName;
    result.session = { id: main.meta.id, file: main.file };
    result.children = linked.map(c => ({ role: c.spawn.agent_role, depth: c.spawn.depth, file: c.file }));
    result.violations = linked.filter(c => c.spawn.agent_role !== allowed || c.spawn.depth !== 1 || c.spawn.parent_thread_id !== main.meta.id)
      .map(c => ({ role: c.spawn.agent_role, depth: c.spawn.depth, file: c.file, reason: '角色、层级或父线程不符' }));
    const spawns = tools.filter(t => t.name === 'spawn_agent');
    if (spawns.some(t => t.args?.agent_type !== allowed) || spawns.length > 1 || linked.length > 1) result.violations.push({ reason: '额外或重复的 Agent 派生' });
    result.state = result.violations.length ? 'violation' : linked.length === 1 ? 'ok' : 'unconfirmed';
  } catch (error) { result.error = `${error.code || 'ERROR'}: ${error.message}`; }
  return result;
}

export async function verifyPerspectives(record, config, { io = fs, markerPrefix = '概念多视角' } = {}) {
  const result = { state: 'unconfirmed', parallel: { state: 'pending', evidence: [] }, violations: [] };
  try {
    const found = await evidence(record, config, true, io, markerPrefix); if (!found) return result;
    const { main, linked, tools } = found, allowed = record.agents.map(a => a.codexName);
    result.session = { id: main.meta.id, file: main.file };
    for (const c of linked) if (!allowed.includes(c.spawn.agent_role) || c.spawn.depth !== 1 || c.spawn.parent_thread_id !== main.meta.id) result.violations.push({ role: c.spawn.agent_role, depth: c.spawn.depth, file: c.file, reason: '白名单或层级不符' });
    const spawns = tools.filter(t => t.name === 'spawn_agent');
    for (const t of spawns) if (!allowed.includes(t.args?.agent_type)) result.violations.push({ role: t.args?.agent_type, file: t.file, reason: '名单外派生' });
    for (const name of allowed) if (linked.filter(c => c.spawn.agent_role === name).length > 1 || spawns.filter(t => t.args?.agent_type === name).length > 1) result.violations.push({ role: name, reason: '重复派生' });
    const wait = tools.findIndex(t => t.name === 'wait_agent');
    if (wait >= 0) {
      const before = tools.slice(0, wait).filter(t => t.name === 'spawn_agent');
      const parallel = before.length === allowed.length && spawns.length === allowed.length && allowed.every(name => before.some(t => t.args?.agent_type === name));
      result.parallel = { state: parallel ? 'ok' : 'not-parallel', evidence: before };
      if (!parallel) result.violations.push({ reason: '未在第一次 wait 之前派生全部 Agent' });
    }
    const complete = allowed.every(name => linked.some(c => c.spawn.agent_role === name));
    result.state = result.violations.length ? 'violation' : complete && result.parallel.state === 'ok' ? 'ok' : 'unconfirmed';
  } catch (error) { result.error = `${error.code || 'ERROR'}: ${error.message}`; }
  return result;
}
