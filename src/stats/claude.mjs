import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

function userText(row) {
  if (row.type !== 'user' || row.message?.role !== 'user' || row.isMeta === true) return '';
  const content = row.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ?
    content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  // Context injected by the host and tool-result rows are not human questions.
  if (/^\s*(?:# AGENTS\.md instructions\b|<INSTRUCTIONS>|<environment_context>|<world_state>|<system-reminder>)/i.test(text)) return '';
  return text;
}

export async function parseClaude(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const calls = [], results = new Map();
  let badLines = 0, line = 0, setting, question, firstTimestampAt = null;
  try {
    for await (const raw of reader) {
      line++; if (!raw.trim()) continue;
      let row;
      try { row = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { badLines++; continue; }
      if (!row || typeof row !== 'object') { badLines++; continue; }
      if (!firstTimestampAt && Number.isFinite(Date.parse(row.timestamp))) firstTimestampAt = new Date(row.timestamp).toISOString();
      if (row.type === 'agent-setting' && typeof row.agentSetting === 'string' && row.agentSetting.trim()) setting = { name: row.agentSetting, sessionId: row.sessionId, line };
      const text = userText(row);
      if (!question && text.trim() && !/【(?:CO-AGENT|Agent Hub) 启动检查 /.test(text) && Number.isFinite(Date.parse(row.timestamp))) question = { at: new Date(row.timestamp).toISOString(), line, sessionId: row.sessionId };
      const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
      for (const block of blocks) {
        if (row.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Agent') {
          if (typeof block.id !== 'string' || !block.id || typeof block.input?.subagent_type !== 'string' || !block.input.subagent_type.trim() || !Number.isFinite(Date.parse(row.timestamp))) { badLines++; continue; }
          calls.push({ key: `claude:call:${block.id}`, kind: 'call', source: 'claude', agentName: block.input.subagent_type,
            at: new Date(row.timestamp).toISOString(), status: 'unknown', file, line, toolUseId: block.id, sessionId: row.sessionId });
        }
        if (row.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          // Contradictory repeated results are conservatively failed if any reports error.
          const prior = results.get(block.tool_use_id);
          if (!prior || block.is_error === true) results.set(block.tool_use_id, { status: block.is_error === true ? 'failed' : 'ok', file, line });
        }
      }
    }
  } finally { reader.close(); input.destroy(); }
  for (const call of calls) {
    const result = results.get(call.toolUseId);
    if (result) { call.status = result.status; call.statusEvidence = result; }
  }
  // Only main sessions can contribute --agent session events.
  if (setting && question && !file.split(path.sep).includes('subagents')) calls.push({
    key: `claude:session:${setting.sessionId || question.sessionId || file}`, kind: 'session', source: 'claude',
    agentName: setting.name, at: question.at, status: 'ok', file, line: question.line, settingLine: setting.line,
  });
  return { events: calls, badLines, firstTimestampAt };
}
