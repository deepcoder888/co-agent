import fs from 'node:fs/promises';

export const TAIL_BYTES = 256 * 1024;
const HEADER_BLOCK = 4096;
const MAX_HEADER = 4 * 1024 * 1024;

export async function parseCodex(file, { onRead = () => {} } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    async function read(position, length) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      onRead({ position, length, bytesRead }); return buffer.subarray(0, bytesRead);
    }
    const chunks = []; let position = 0, firstEnd = -1;
    while (position < size && position < MAX_HEADER) {
      const chunk = await read(position, Math.min(HEADER_BLOCK, size - position));
      if (!chunk.length) break;
      const newline = chunk.indexOf(10);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      if (newline >= 0) { firstEnd = position + newline + 1; break; }
      position += chunk.length;
    }
    if (firstEnd < 0 && size > MAX_HEADER) throw new Error('session_meta 首行超过 4 MB，拒绝扩大读取');
    if (firstEnd < 0) firstEnd = size;
    let row;
    try { row = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('session_meta 首行 JSON 无效'); }
    const meta = row?.payload;
    if (row?.type !== 'session_meta' || !meta || typeof meta.id !== 'string' || !meta.id || !Number.isFinite(Date.parse(meta.timestamp))) throw new Error('session_meta 缺少有效 id 或 timestamp');
    const spawn = meta.source?.subagent?.thread_spawn;
    const firstTimestampAt = new Date(Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : meta.timestamp).toISOString();
    if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) return { events: [], badLines: 0, firstTimestampAt };
    const at = new Date(meta.timestamp).toISOString();
    if (typeof spawn.agent_role !== 'string' || !spawn.agent_role.trim()) return { events: [{ key: `codex:${meta.id}`, kind: 'unlabeled', source: 'codex', at, file, line: 1, sessionId: meta.id }], badLines: 0, firstTimestampAt };
    let status = 'unknown', statusEvidence, badLines = 0;
    const start = Math.max(firstEnd, size - TAIL_BYTES);
    const tail = await read(start, Math.max(0, size - start));
    let offset = 0;
    // The first tail line may be partial. Even if it happens to parse, discard it.
    if (start > firstEnd) { const newline = tail.indexOf(10); offset = newline < 0 ? tail.length : newline + 1; }
    while (offset < tail.length) {
      const newline = tail.indexOf(10, offset), end = newline < 0 ? tail.length : newline;
      const text = tail.subarray(offset, end).toString('utf8').trim();
      let entry;
      try { if (text) entry = JSON.parse(text); }
      catch { badLines++; }
      if (entry?.type === 'event_msg') {
        const type = entry.payload?.type;
        if (['task_started', 'task_complete', 'turn_aborted'].includes(type)) {
          status = type === 'task_complete' ? 'ok' : type === 'turn_aborted' ? 'failed' : 'unknown';
          statusEvidence = { file, byteOffset: start + offset, type: 'event_msg', payloadType: type };
        }
      }
      offset = end + (newline < 0 ? 0 : 1);
    }
    return { events: [{ key: `codex:${meta.id}`, kind: 'call', source: 'codex', agentName: spawn.agent_role, at, status,
      file, line: 1, sessionId: meta.id, parentThreadId: spawn.parent_thread_id, statusEvidence }], badLines, firstTimestampAt };
  } finally { await handle.close(); }
}
