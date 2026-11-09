import { spawn } from 'node:child_process';
import { requiresTaskFormat } from '../config.mjs';
import { claudeRelay } from '../launch/claude.mjs';
import { codexModelArgs, codexProfileArgs } from '../launch/codex.mjs';
import { killProcessTree } from '../concepts/runner.mjs';
import { scrubEnvironment } from '../launch/spawner.mjs';

// In-app answers run without a terminal, so nobody can approve a tool call (2026-10-31):
// Claude may read, search and use the web, and run only file-hash commands; Codex runs in its read-only sandbox.
export const claudeAllowedTools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'Bash(sha256sum:*)', 'Bash(certutil -hashfile:*)', 'PowerShell(Get-FileHash:*)'];
const claudeDeniedTools = ['Write', 'Edit', 'NotebookEdit'];
const streaming = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

export const claudeName = agent => agent.platforms?.claude?.name || agent.name;
export const relayMode = (agent, config) => requiresTaskFormat(agent.name, config) || config.claudeLaunchMode !== 'agent';

// Variadic tool lists come before -p; the question itself arrives on stdin.
export function claudeChatArgs(agent, member, config, first) {
  const name = claudeName(agent), session = first ? ['--session-id', member.sessionId] : ['--resume', member.sessionId];
  if (relayMode(agent, config)) {
    return ['--disallowedTools', ...claudeDeniedTools, '--permission-mode', 'dontAsk', '--allowedTools', ...claudeAllowedTools, `Agent(${name})`,
      ...session, '--append-system-prompt', claudeRelay(name, agent.name, config), ...streaming];
  }
  return ['--agent', name, '--disallowedTools', ...claudeDeniedTools, 'Agent', '--permission-mode', 'dontAsk', '--allowedTools', ...claudeAllowedTools,
    ...session, ...streaming];
}

export function codexChatArgs(member, config, first) {
  const common = [...codexProfileArgs(config.codexProfile), ...codexModelArgs(config), '-s', 'read-only', '--skip-git-repo-check', '-C', config.launchProject, '--json'];
  return first ? ['exec', ...common, '-'] : ['exec', ...common, 'resume', member.threadId, '-'];
}

const taskFormat = name => `交给它的任务文本必须严格采用以下格式：第一行单独为 OCTOPUS_WORKER=1，四个字段都不得为空——
OCTOPUS_WORKER=1
Intended role: ${name}
Task: <我的原话，原样；此前的问答原文附在后面>
Constraints: <只从我的原话中提炼的约束；没有时写「遵守该 Agent 自身规则」>
Acceptance criteria: <只从我的原话中提炼的验收标准；没有时写「按该 Agent 默认验收标准」>
不得替我编造原话中没有的要求。`;
// Codex reaches a custom Agent only through a sub-agent; the coordinating thread keeps the history across turns.
export function codexChatPrompt(agent, chatId, question, config, first) {
  const name = agent.name, format = requiresTaskFormat(name, config) ? taskFormat(name) : '把我的原话交给它；如果之前已有问答，把此前的问答原文一并交给它。';
  if (!first) return `我的下一个问题（照前面的约定：重新派生 agent_role 为「${name}」的子 Agent，并把此前的问答原文一并交给它）：\n${question}`;
  return `【CO-AGENT 软件内对话 ${chatId}】本对话绑定自定义 Agent「${name}」。对我的每个问题：派生 agent_role 为「${name}」的子 Agent，${format}原样呈现它的回答，不要加你自己的开场或总结。不要派生其他 Agent，不要自己代替它回答。\n我的问题：\n${question}`;
}

// Claude stream-json: deltas of the assistant message being written, then one result line.
export function claudeEvent(event, state) {
  if (event?.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') state.sessionId = event.session_id;
  if (event?.type === 'stream_event') {
    const inner = event.event;
    if (inner?.type === 'message_start') state.text = '';
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') state.text += inner.delta.text;
  }
  if (event?.type === 'result') {
    if (event.is_error || (event.subtype && event.subtype !== 'success')) state.error = typeof event.result === 'string' && event.result.trim() ? event.result : `Claude 返回 ${event.subtype || '错误'}`;
    else if (typeof event.result === 'string') { state.text = event.result; state.final = true; }
  }
}
// Codex --json: the thread id for later turns, each completed agent message, and turn failures.
export function codexEvent(event, state) {
  if (event?.type === 'thread.started' && typeof event.thread_id === 'string') state.threadId = event.thread_id;
  if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') state.text = event.item.text;
  if (event?.type === 'turn.completed') state.final = true;
  if (event?.type === 'turn.failed') state.error = event.error?.message || 'Codex 回合失败';
  if (event?.type === 'error' && typeof event.message === 'string') state.error = event.message;
}

// One answer: spawn, feed the prompt on stdin, parse JSON lines as they arrive, and stop on timeout or abort.
export function runAnswer({ exe, args, prompt, parse, timeoutMs, signal, onUpdate = () => {} }, config,
  { spawnImpl = spawn, env = process.env, killTree = killProcessTree } = {}) {
  // A missing injection must never start a real CLI from node:test.
  if (process.env.NODE_TEST_CONTEXT && spawnImpl === spawn) return Promise.reject(new Error('测试必须注入 CLI 进程替身'));
  const state = { text: '', final: false, error: null };
  return new Promise((resolve, reject) => {
    let child, buffer = '', stderr = '', settled = false, stopping = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(Object.assign(error, { state })) : resolve(state);
    };
    const stop = async error => {
      if (settled || stopping) return; stopping = true;
      try { if (child?.pid) await killTree(child); } catch (killError) { error.message += `；${killError.message}`; }
      finish(error);
    };
    const abort = () => { void stop(Object.assign(new Error('已停止'), { stopped: true })); };
    const timer = setTimeout(() => { void stop(new Error(`回答超时（${Math.round(timeoutMs / 60000)} 分钟）`)); }, timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const line = text => {
      if (!text.trim()) return;
      let event; try { event = JSON.parse(text); } catch { return; }
      parse(event, state); onUpdate(state);
    };
    try {
      child = spawnImpl(exe, args, { cwd: config.launchProject, shell: false, windowsHide: true, env: scrubEnvironment(env).env, stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform !== 'win32' ? { detached: true } : {}) });
      child.once('error', error => { void stop(error); });
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => {
        if (settled || stopping) return;
        buffer += chunk; const parts = buffer.split(/\r?\n/); buffer = parts.pop();
        for (const part of parts) line(part);
        if (buffer.length > 4 * 1024 * 1024) void stop(new Error('输出单行超过 4 MB'));
      });
      child.stderr?.on('data', chunk => { if (!settled && !stopping && stderr.length < 64 * 1024) stderr += chunk; });
      child.once('close', (code, sig) => {
        if (stopping) return; line(buffer);
        if (state.error) finish(new Error(state.error));
        else if (code !== 0 || sig) finish(new Error(`进程失败（退出码 ${code}${sig ? `，信号 ${sig}` : ''}）：${stderr.trim().slice(-600) || '无错误输出'}`));
        else if (!state.text.trim()) finish(new Error('没有得到回答文本'));
        else finish(null);
      });
      child.stdin.on('error', error => { void stop(error); });
      child.stdin.end(prompt);
    } catch (error) { void stop(error); }
  });
}
