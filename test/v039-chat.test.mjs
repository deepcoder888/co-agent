import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { createChats, chatLimits, explainFailure } from '../src/chat/index.mjs';
import { claudeChatArgs, codexChatArgs, codexChatPrompt, claudeEvent, codexEvent, runAnswer, claudeAllowedTools } from '../src/chat/runner.mjs';
import { mountApp } from '../public/app.js';
import { answerStatus } from '../public/chat-page.js';

const agent = (id, kind = 'book', extra = {}) => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent', purpose: kind === 'role' ? '协调' : null,
  book: kind === 'book' ? { title: `《${id} Book》`, author: `${id} Author` } : null, description: '说明', tags: [], permissions: {}, sync: { state: '同步' },
  sources: { checked: true, missing: [] }, platforms: { claude: { available: true, name: id }, codex: { available: true } }, ...extra });
const agents = () => [agent('walvo'), agent('jadra'), agent('liebo'), agent('peter', 'role'),
  agent('gone', 'book', { platforms: { claude: { available: false, reason: '没有 Claude 入口' }, codex: { available: true } } }),
  agent('broken', 'book', { sources: { checked: true, missing: ['D:\\missing.epub'] }, bookFiles: [{ path: 'D:\\missing.epub', exists: false }] })];
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('等待超时'); };

// A scripted answer runner: records each call and answers as the script says.
function scripted(script = () => ({ text: '回答' })) {
  const calls = [];
  const runImpl = (job, config) => { calls.push({ ...job, config }); return new Promise((resolve, reject) => {
    const step = script(job, calls.length);
    const finish = () => step.error ? reject(Object.assign(new Error(step.error), { state: { text: step.text || '', sessionId: step.sessionId } })) : resolve({ text: step.text, final: true, threadId: step.threadId, sessionId: step.sessionId });
    if (step.hold) job.signal.addEventListener('abort', () => reject(Object.assign(new Error('已停止'), { stopped: true, state: { text: '半句', sessionId: 's' } })));
    else setTimeout(finish, step.delay ?? 0);
  }); };
  return { calls, runImpl };
}
async function chatsFor(t, script) {
  // After hooks run in registration order: close chats and apps before the fixture folder is removed.
  let chats; t.after(() => chats?.close());
  const { config } = await fixture(t), run = scripted(script), registry = agents();
  config.taskContracts = { octopus: ['peter'] };
  const logs = []; chats = createChats(config, { getRegistry: () => ({ agents: registry }), runImpl: run.runImpl, log: m => logs.push(m), createResumeImpl: async (original, session) => ({ original, session }) });
  return { config, chats, ...run, registry, logs };
}
const settled = (chats, id) => until(async () => (await chats.get(id)).turns.every(turn => Object.values(turn.answers).every(a => !['queued', 'running'].includes(a.status))));

test('v039 Claude args: the agent answers on stdin with streaming JSON, read-only tools and only hash commands, never asking', () => {
  const config = { claudeLaunchMode: 'agent', taskContracts: { octopus: ['peter'] } };
  const first = claudeChatArgs(agent('liebo'), { sessionId: 'S' }, config, true);
  assert.deepEqual(first.slice(0, 2), ['--agent', 'liebo']);
  assert.deepEqual(first.slice(first.indexOf('--disallowedTools'), first.indexOf('--permission-mode')), ['--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'Agent']);
  assert.deepEqual(first.slice(first.indexOf('--permission-mode'), first.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.deepEqual(claudeAllowedTools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash(sha256sum:*)', 'Bash(certutil -hashfile:*)', 'PowerShell(Get-FileHash:*)']);
  assert.ok(first.indexOf('--session-id') > first.indexOf('--allowedTools') && first.indexOf('-p') > first.indexOf('--session-id'), 'variadic lists end before the session flag and -p');
  assert.deepEqual(first.slice(-5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.ok(!first.some(a => /问题|\?/.test(a)), 'the question never travels in argv');
  const later = claudeChatArgs(agent('liebo'), { sessionId: 'S' }, config, false);
  assert.deepEqual(later.slice(later.indexOf('--resume'), later.indexOf('--resume') + 2), ['--resume', 'S']); assert.ok(!later.includes('--session-id'));
  // Roles that need the task format reach their Agent through the relay prompt and may call only that Agent.
  const relay = claudeChatArgs(agent('peter', 'role'), { sessionId: 'R' }, config, true);
  assert.ok(!relay.includes('--agent')); assert.ok(relay.includes('Agent(peter)')); assert.ok(!relay.slice(1, relay.indexOf('--permission-mode')).includes('Agent'));
  assert.match(relay[relay.indexOf('--append-system-prompt') + 1], /OCTOPUS_WORKER=1/);
});

test('v039 Codex args and prompts: read-only sandbox, JSON events, the first turn binds the role and later turns resume the thread', () => {
  const config = { codexProfile: 'gpt', codexModel: 'm', codexEffort: 'xhigh', launchProject: 'D:\\p', dataDir: 'D:\\d', taskContracts: { octopus: ['peter'] } };
  const first = codexChatArgs({}, config, true), later = codexChatArgs({ threadId: 'T' }, config, false);
  assert.deepEqual(first.slice(0, 3), ['exec', '--profile', 'gpt']);
  // v0.53.13: in-app Codex runs start in the data dir's empty agent-cwd, not in launchProject (no AGENTS.md injection).
  for (const args of [first, later]) assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', 'D:\\d\\agent-cwd']);
  for (const args of [first, later]) { assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', 'read-only']); assert.ok(args.includes('--json')); assert.equal(args.at(-1), '-'); }
  assert.deepEqual(later.slice(-3), ['resume', 'T', '-']);
  const prompt = codexChatPrompt(agent('jadra'), 'C1', '睡不好怎么办？', config, true);
  assert.match(prompt, /【CO-AGENT 软件内对话 C1】/); assert.match(prompt, /agent_role 为「jadra」/); assert.ok(prompt.endsWith('睡不好怎么办？'));
  assert.match(codexChatPrompt(agent('jadra'), 'C1', '再问一句', config, false), /重新派生 agent_role 为「jadra」[\s\S]*再问一句$/);
  assert.match(codexChatPrompt(agent('peter', 'role'), 'C1', '问', config, true), /OCTOPUS_WORKER=1\nIntended role: peter/);
});

test('v039 stream parsing: Claude deltas restart per message and the result wins; Codex keeps the thread id and the last message', () => {
  const claude = { text: '', final: false, error: null };
  for (const event of [{ type: 'system', subtype: 'init', session_id: 'S1' },
    { type: 'stream_event', event: { type: 'message_start' } }, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先查' } } },
    { type: 'stream_event', event: { type: 'message_start' } }, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '书里' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '说' } } }]) claudeEvent(event, claude);
  assert.equal(claude.text, '书里说'); assert.equal(claude.sessionId, 'S1');
  claudeEvent({ type: 'result', subtype: 'success', result: '书里说：完整回答' }, claude);
  assert.deepEqual([claude.text, claude.final], ['书里说：完整回答', true]);
  const failed = { text: '', error: null }; claudeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true }, failed);
  assert.match(failed.error, /error_max_turns/);
  const codex = { text: '', final: false, error: null };
  for (const event of [{ type: 'thread.started', thread_id: 'T1' }, { type: 'item.completed', item: { type: 'reasoning', text: '想' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '派生中' } }, { type: 'item.completed', item: { type: 'agent_message', text: '最终回答' } },
    { type: 'turn.completed' }]) codexEvent(event, codex);
  assert.deepEqual([codex.threadId, codex.text, codex.final], ['T1', '最终回答', true]);
  const broken = { text: '' }; codexEvent({ type: 'turn.failed', error: { message: '额度' } }, broken); assert.equal(broken.error, '额度');
});

function child() {
  const c = new EventEmitter(); c.pid = 4242; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
  c.input = ''; c.stdin.on('data', chunk => { c.input += chunk; }); return c;
}
test('v039 runAnswer: stdin carries the prompt, lines stream through onUpdate, exits and aborts settle exactly once', async () => {
  const config = { launchProject: process.cwd() };
  let spawned; const updates = [];
  const spawnImpl = (exe, args, options) => { spawned = { exe, args, options, child: child() }; return spawned.child; };
  const run = runAnswer({ exe: 'claude', args: ['-p'], prompt: '问题原文', parse: claudeEvent, timeoutMs: 5000, onUpdate: s => updates.push(s.text) }, config, { spawnImpl, env: { PATH: '', CLAUDECODE: '1' } });
  await until(() => spawned);
  assert.equal(spawned.options.shell, false); assert.equal(spawned.options.windowsHide, true); assert.equal(spawned.options.env.CLAUDECODE, undefined);
  spawned.child.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '一' } } }) + '\n{"type":"stream_ev');
  spawned.child.stdout.write('ent","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"二"}}}\n' + JSON.stringify({ type: 'result', subtype: 'success', result: '一二' }) + '\n');
  spawned.child.emit('close', 0, null);
  assert.equal((await run).text, '一二'); assert.equal(spawned.child.input, '问题原文'); assert.deepEqual(updates, ['一', '一二', '一二']);
  // A non-zero exit without a parsed error reports stderr.
  const failing = runAnswer({ exe: 'x', args: [], prompt: '', parse: codexEvent, timeoutMs: 5000 }, config, { spawnImpl, env: {} });
  await until(() => spawned.child.input !== undefined); spawned.child.stderr.write('登录失效'); spawned.child.emit('close', 1, null);
  await assert.rejects(failing, /退出码 1.*登录失效/);
  // Abort kills the tree and reports a stop, keeping the partial text.
  const controller = new AbortController(); let killed = 0;
  const stopped = runAnswer({ exe: 'x', args: [], prompt: '', parse: codexEvent, timeoutMs: 5000, signal: controller.signal }, config, { spawnImpl, env: {}, killTree: async () => { killed++; } });
  await until(() => spawned); spawned.child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '半句' } }) + '\n');
  await new Promise(r => setTimeout(r, 10)); controller.abort();
  await assert.rejects(stopped, error => error.stopped === true && error.state.text === '半句'); assert.equal(killed, 1);
  // Real CLIs never start from node:test.
  await assert.rejects(runAnswer({ exe: 'x', args: [], prompt: '', parse: codexEvent, timeoutMs: 10 }, config), /测试必须注入/);
});

test('v039 chats: validation, first answer, persisted record, a resumed follow-up to some members and the busy guard', async t => {
  const { chats, calls, config, logs } = await chatsFor(t, (job, n) => n === 3 ? { hold: true } : { text: `第 ${n} 个回答`, threadId: 'T' + n });
  await assert.rejects(chats.start({ engine: 'gpt', agentIds: ['walvo'], question: '问' }), { status: 400 });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: [], question: '问' }), { status: 400 });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: ['walvo', 'walvo'], question: '问' }), { status: 400 });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: Array.from({ length: chatLimits.members + 1 }, (_, i) => 'a' + i), question: '问' }), { status: 400 });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: ['gone'], question: '问' }), { status: 409, message: /没有 Claude 入口/ });
  await assert.rejects(chats.start({ engine: 'codex', agentIds: ['broken'], question: '问' }), { status: 409, message: /原书路径失效/ });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: ['walvo'], question: '   ' }), { status: 400 });
  await assert.rejects(chats.start({ engine: 'claude', agentIds: ['walvo'], question: 'x'.repeat(8001) }), { status: 400 });
  const chat = await chats.start({ engine: 'claude', agentIds: ['walvo', 'jadra'], question: '第一问\n第二行', groupId: 'g1' });
  assert.equal(chat.kind, 'joint'); assert.equal(chat.title, '第一问'); assert.equal(chat.groupId, 'g1'); assert.match(chat.members.walvo.sessionId, /^[0-9a-f-]{36}$/);
  await settled(chats, chat.chatId);
  let saved = await chats.get(chat.chatId);
  assert.deepEqual(Object.values(saved.turns[0].answers).map(a => a.status), ['done', 'done']);
  assert.ok(calls.every(c => c.args.includes('--session-id') && c.prompt === '第一问\n第二行'));
  assert.equal(saved.members.walvo.started, true);
  // Writes are queued per chat; the last one lands shortly after the answer settles in memory.
  const onDisk = async () => JSON.parse(await fs.readFile(path.join(config.dataDir, 'chats', `${chat.chatId}.json`), 'utf8').catch(() => '{}'));
  await until(async () => (await onDisk()).turns?.[0].answers.jadra.status === 'done').catch(async e => { throw new Error(`${e.message}: ${JSON.stringify((await onDisk()).turns?.[0].answers)} ${logs.join(' | ')}`); });
  await assert.rejects(chats.ask(chat.chatId, { question: '问', recipients: ['liebo'] }), { status: 400 });
  await chats.ask(chat.chatId, { question: '只问 walvo', recipients: ['walvo'] });
  await until(() => calls.length === 3);
  assert.ok(calls[2].args.includes('--resume') && calls[2].args.includes(saved.members.walvo.sessionId));
  await assert.rejects(chats.ask(chat.chatId, { question: '再问' }), { status: 409, message: /walvo 还在回答/ });
  await chats.ask(chat.chatId, { question: '只问 jadra', recipients: ['jadra'] });
  await chats.stop(chat.chatId, { agentId: 'walvo' }); await settled(chats, chat.chatId);
  saved = await chats.get(chat.chatId);
  assert.equal(saved.turns[1].answers.walvo.status, 'stopped'); assert.equal(saved.turns[1].answers.walvo.text, '半句');
  assert.equal(saved.turns[2].answers.jadra.status, 'done');
  const { items } = await chats.list();
  assert.equal(items[0].chatId, chat.chatId); assert.equal(items[0].turns, 3); assert.equal(items[0].running, false); assert.equal(items[0].failed, false);
});

test('v039 chats: retry only the latest failed answer; Codex threads resume; an interrupted answer fails after a restart', async t => {
  let fail = true;
  const { chats, calls, config, registry } = await chatsFor(t, () => fail ? { error: '额度用尽' } : { text: '好了', threadId: 'T-9' });
  const chat = await chats.start({ engine: 'codex', agentIds: ['jadra'], question: '一问' });
  await settled(chats, chat.chatId);
  let saved = await chats.get(chat.chatId);
  assert.equal(saved.turns[0].answers.jadra.status, 'failed'); assert.equal(saved.turns[0].answers.jadra.error, '额度用尽');
  assert.equal(saved.members.jadra.started, false, 'no thread was opened, so the next try starts fresh');
  await assert.rejects(chats.retry(chat.chatId, { turnId: 'nope', agentId: 'jadra' }), { status: 409 });
  fail = false; await chats.retry(chat.chatId, { turnId: saved.turns[0].turnId, agentId: 'jadra' }); await settled(chats, chat.chatId);
  saved = await chats.get(chat.chatId);
  assert.equal(saved.turns[0].answers.jadra.status, 'done'); assert.equal(saved.members.jadra.threadId, 'T-9');
  assert.equal(calls[1].args[0], 'exec'); assert.ok(!calls[1].args.includes('resume'));
  assert.match(calls[1].prompt, /【CO-AGENT 软件内对话/);
  await assert.rejects(chats.retry(chat.chatId, { turnId: saved.turns[0].turnId, agentId: 'jadra' }), { status: 409 });
  await chats.ask(chat.chatId, { question: '二问' }); await settled(chats, chat.chatId);
  assert.deepEqual(calls[2].args.slice(-3), ['resume', 'T-9', '-']); assert.match(calls[2].prompt, /二问$/);
  // A record left running by a closed app is marked failed when it is read again.
  // Drain the old instance's queued disk writes before seeding the interrupted record.
  await chats.close();
  const file = path.join(config.dataDir, 'chats', `${chat.chatId}.json`), record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.turns[1].answers.jadra.status = 'running'; await put(file, JSON.stringify(record));
  const again = createChats(config, { getRegistry: () => ({ agents: registry }), runImpl: () => Promise.reject(new Error('不应运行')) });
  const reread = await again.get(chat.chatId);
  assert.equal(reread.turns[1].answers.jadra.status, 'failed'); assert.match(reread.turns[1].answers.jadra.error, /软件关闭/);
  await again.close();
});

test('v039 chats: 在终端中继续 needs a finished, opened session file and hands it to the resume path', async t => {
  const { chats, config } = await chatsFor(t, () => ({ text: '答' }));
  const chat = await chats.start({ engine: 'claude', agentIds: ['liebo'], question: '问' });
  await settled(chats, chat.chatId);
  await assert.rejects(chats.terminal(chat.chatId, { agentId: 'liebo' }), { status: 409, message: /没有可以继续的会话/ });
  const sessionId = (await chats.get(chat.chatId)).members.liebo.sessionId;
  const file = path.join(config.claudeProjectsDir, 'D--project', `${sessionId}.jsonl`); await put(file, '{}\n');
  const handed = await chats.terminal(chat.chatId, { agentId: 'liebo' });
  assert.deepEqual(handed.session, { id: sessionId, file });
  assert.deepEqual([handed.original.cli, handed.original.mode, handed.original.agentName, handed.original.cwd], ['claude', 'agent', 'liebo', config.launchProject]);
  await assert.rejects(chats.terminal(chat.chatId, { agentId: 'walvo' }), { status: 400 });
});

test('v039 server: /api/chats routes require the launch token and answer through the injected runner', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t), run = scripted(() => ({ text: '服务端回答' }));
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents: agents(), categories: ['学习'], summary: {}, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }),
    chatOptions: { runImpl: run.runImpl } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body, token = app.token) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post('/api/chats', { engine: 'codex', agentIds: ['jadra'], question: '问' }, 'f'.repeat(64))).status, 403);
  const created = await post('/api/chats', { engine: 'codex', agentIds: ['jadra'], question: '问' });
  assert.equal(created.status, 202); const chat = await created.json();
  await until(async () => (await (await fetch(`${base}/api/chats/${chat.chatId}`)).json()).turns[0].answers.jadra.status === 'done');
  assert.equal((await (await fetch(`${base}/api/chats`)).json()).items[0].chatId, chat.chatId);
  assert.equal((await post(`/api/chats/${chat.chatId}/ask`, { question: '再问' })).status, 202);
  assert.equal((await post(`/api/chats/${chat.chatId}/delete`, {})).status, 404);
  assert.equal((await fetch(`${base}/api/chats/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test('v039 a logged-out CLI is explained in Chinese with the login step, keeping the original message', () => {
  assert.match(explainFailure('claude', 'Failed to authenticate: OAuth session expired and could not be refreshed'), /^Claude CLI 没有登录或登录已过期：请在终端运行 claude，然后输入 \/login[\s\S]*原始信息：Failed to authenticate/);
  assert.match(explainFailure('codex', '401 Unauthorized'), /codex login/);
  assert.equal(explainFailure('codex', '回答超时（30 分钟）'), '回答超时（30 分钟）');
});

test('v039 answer status wording', () => {
  const at = Date.parse('2026-10-31T10:00:00Z'), iso = s => new Date(at + s * 1000).toISOString();
  assert.equal(answerStatus({ status: 'queued' }, at), '排队中');
  assert.equal(answerStatus({ status: 'running', startedAt: iso(-12) }, at), '正在回答 · 12 秒');
  assert.equal(answerStatus({ status: 'done', startedAt: iso(0), endedAt: iso(67) }, at), '用时 1 分 7 秒');
  assert.equal(answerStatus({ status: 'stopped' }, at), '已停止'); assert.equal(answerStatus({ status: 'failed' }, at), '没有回答成功');
});

// Frontend: every layout's detail offers the third way, which asks for the engine and opens the shared page.
const registry = { agents: agents(), categories: ['学习'], summary: { roles: 1, books: 5 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
async function mounted(t, ui) {
  const { doc } = await appDocument(ui); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const requests = [], chat = { version: 1, chatId: 'c0000000-0000-4000-8000-000000000001', kind: 'single', engine: 'codex', agentIds: ['jadra'], groupId: null, title: '问',
    createdAt: '2026-10-31T10:00:00Z', updatedAt: '2026-10-31T10:00:00Z', members: { jadra: { name: 'jadra', started: true } },
    turns: [{ turnId: 't1', question: '书里怎么说？', askedAt: '2026-10-31T10:00:00Z', recipients: ['jadra'],
      answers: { jadra: { status: 'done', text: '**要点**：先观察。', startedAt: '2026-10-31T10:00:00Z', endedAt: '2026-10-31T10:00:30Z', error: null } } }] };
  const app = await mountApp(doc, async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, method, body });
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui, recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} }
      : url === '/api/chats' && method === 'POST' ? chat : url === '/api/chats' ? { items: [] } : url.startsWith('/api/chats/') ? chat : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, requests };
}
for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v039 ${ui}: 在 CO-AGENT 中调用 → engine → shared chat page → first question`, async t => {
  const { doc, app, requests } = await mounted(t, ui);
  await app.actions.openDetail('jadra');
  const button = doc.querySelectorAll('[data-focus-key="detail-inapp"]').find(n => !n.closest('[hidden]'));
  assert.ok(button, `${ui} detail has the in-app button`); assert.equal(button.textContent, '在 CO-AGENT 中调用');
  await button.fire('click');
  assert.equal(doc.getElementById('chat-start').open, true); assert.equal(doc.getElementById('chat-start-title').textContent, '在 CO-AGENT 中调用 jadra');
  await doc.getElementById('chat-start-codex').fire('click');
  assert.equal(app.snapshot().state.view, 'chat'); assert.equal(app.snapshot().state.detailOpen, false);
  const panel = doc.getElementById('chat-panel'); assert.equal(panel.hidden, false);
  assert.equal(doc.getElementById('chat-engine-codex').getAttribute('aria-pressed'), 'true');
  assert.match(doc.querySelector('.chat-empty').textContent, /向 jadra 提出第一个问题，由 Codex 回答/);
  assert.equal(doc.getElementById('chat-send').disabled, true);
  const input = doc.getElementById('chat-input'); input.value = '书里怎么说？'; await input.fire('input');
  assert.equal(doc.getElementById('chat-send').disabled, false);
  await doc.getElementById('chat-send').fire('click');
  assert.deepEqual(requests.find(r => r.url === '/api/chats' && r.method === 'POST').body, { agentIds: ['jadra'], engine: 'codex', groupId: null, question: '书里怎么说？' });
  assert.match(panel.querySelector('.chat-question-text').textContent, /书里怎么说/);
  assert.equal(panel.querySelector('.chat-answer').className, 'chat-answer status-done');
  assert.ok(panel.querySelector('.chat-answer-body strong'), 'a finished answer renders as Markdown');
  assert.equal(panel.querySelector('.chat-answer-state').textContent, '用时 30 秒');
});

test('v039 joint builder and group dialog: 在 CO-AGENT 中 starts a chat instead of a terminal joint', async t => {
  const { doc, app, requests } = await mounted(t, 'shelf');
  await app.actions.openJoint(['walvo', 'jadra']);
  const place = doc.getElementById('builder-place'), cli = doc.getElementById('builder-cli');
  place.value = 'inapp'; await place.fire('change');
  assert.equal(doc.getElementById('builder-cli-label').textContent, '回答引擎');
  assert.equal(doc.getElementById('builder-cross-exam').disabled, true);
  cli.value = 'codex'; doc.getElementById('builder-input').value = '一起回答'; await doc.getElementById('builder-input').fire('input');
  await doc.getElementById('builder-submit').fire('click');
  assert.equal(requests.some(r => r.url === '/api/joint'), false);
  assert.deepEqual(requests.find(r => r.url === '/api/chats' && r.method === 'POST').body, { agentIds: ['walvo', 'jadra'], engine: 'codex', groupId: null, question: '一起回答' });
  assert.equal(app.snapshot().state.view, 'chat');
});

test('v039 shelf desk: two joint-call buttons and 书房各室, a popover holding the five rooms', async t => {
  const { doc, app } = await mounted(t, 'shelf');
  const actions = doc.querySelector('.desk-actions');
  assert.deepEqual(actions.children.filter(n => n.tagName === 'BUTTON').map(n => n.textContent), ['发起联合调用（0）', '新建联合调用', '书房各室 ▾']);
  const trigger = doc.getElementById('shelf-rooms-open'), menu = doc.getElementById('shelf-rooms');
  assert.equal(trigger.getAttribute('popovertarget'), 'shelf-rooms'); assert.equal(menu.getAttribute('popover'), '');
  assert.deepEqual(menu.children.map(n => [n.id, n.textContent]), [['seminars-open', '圆桌讨论'], ['consults-open', '会诊室'], ['chats-open', '软件内对话'], ['councils-open', '顾问团'], ['concept-map-open', '概念地图']]);
  let hidden = 0; menu.hidePopover = () => { hidden++; };
  await doc.getElementById('chats-open').fire('click');
  assert.equal(hidden, 1); assert.equal(app.snapshot().state.view, 'chat');
});

test('v039 chat page: the left column folds into a rail and remembers the choice', async t => {
  const { doc, app } = await mounted(t, 'bento');
  const store = new Map(); doc.defaultView = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  await app.actions.openChatStart('jadra'); await doc.getElementById('chat-start-codex').fire('click');
  const panel = doc.getElementById('chat-panel'), toggle = doc.getElementById('chat-side-toggle'), body = doc.getElementById('chat-side-body');
  assert.equal(panel.getAttribute('data-side'), 'open'); assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(toggle.getAttribute('aria-controls'), 'chat-side-body room-side-seminars room-side-consults room-side-councils');
  await toggle.fire('click');
  assert.equal(panel.getAttribute('data-side'), 'folded'); assert.equal(body.hidden, true);
  assert.equal(toggle.getAttribute('aria-label'), '展开左栏'); assert.equal(toggle.textContent, '›'); assert.equal(store.get('co-agent.chat.side'), 'folded');
  assert.ok(doc.getElementById('chat-back'), 'the rail keeps the way back');
  await toggle.fire('click');
  assert.equal(panel.getAttribute('data-side'), 'open'); assert.equal(body.hidden, false); assert.equal(store.get('co-agent.chat.side'), 'open');
});

test('v0.45.5 chat page: the folded rail hides after 3 s like the reading mode, and the left edge brings it back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, app } = await mounted(t, 'bento');
  await app.actions.openChatStart('jadra'); await doc.getElementById('chat-start-codex').fire('click');
  const panel = doc.getElementById('chat-panel'), side = panel.querySelector('.chat-side'), edge = panel.querySelector('.chat-side-edge');
  const hidden = () => panel.getAttribute('data-side-hidden') !== null;
  panel.open = undefined; // The fixture gives every element open = false; a real <section> has no open property.
  t.mock.timers.tick(5000); assert.equal(hidden(), false, 'an open column never hides');
  await doc.getElementById('chat-side-toggle').fire('click');
  t.mock.timers.tick(2000);
  // Re-rendering the page (typing, streaming answers) does not restart the countdown.
  const input = doc.getElementById('chat-input'); input.value = '再问'; await input.fire('input');
  t.mock.timers.tick(999); assert.equal(hidden(), false);
  t.mock.timers.tick(1); assert.equal(hidden(), true);
  await edge.fire('mouseenter'); t.mock.timers.tick(120); assert.equal(hidden(), false, 'resting on the left edge brings it back');
  await side.fire('mouseenter'); t.mock.timers.tick(5000); assert.equal(hidden(), false, 'the pointer on the rail holds it');
  await side.fire('mouseleave'); t.mock.timers.tick(3000); assert.equal(hidden(), true);
  app.actions.showView('catalog'); assert.equal(hidden(), false, 'the next visit starts with the rail in place');
});

test('v039 chat page: joint answers switch between 并排 and 单列 (remembered); the composer is one growing line', async t => {
  const { doc } = await appDocument('shelf'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const answer = text => ({ status: 'done', text, startedAt: '2026-10-31T10:00:00Z', endedAt: '2026-10-31T10:00:30Z', error: null });
  const joint = { version: 1, chatId: 'c0000000-0000-4000-8000-000000000002', kind: 'joint', engine: 'codex', agentIds: ['walvo', 'jadra'], groupId: null, title: '问',
    createdAt: '2026-10-31T10:00:00Z', updatedAt: '2026-10-31T10:00:00Z', members: { walvo: { name: 'walvo' }, jadra: { name: 'jadra' } },
    turns: [{ turnId: 't1', question: '一起答', askedAt: '2026-10-31T10:00:00Z', recipients: ['walvo', 'jadra'], answers: { walvo: answer('甲'), jadra: answer('乙') } }] };
  const app = await mountApp(doc, async url => {
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'shelf', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} }
      : url === '/api/chats' ? { items: [{ chatId: joint.chatId, kind: 'joint', engine: 'codex', agentIds: joint.agentIds, title: '问', updatedAt: joint.updatedAt, turns: 1, running: false, failed: false }] }
      : url.startsWith('/api/chats/') ? joint : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  const store = new Map(); doc.defaultView = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  await app.actions.openChats();
  const panel = doc.getElementById('chat-panel'), toolbar = doc.querySelector('.chat-toolbar');
  assert.equal(toolbar.hidden, false); assert.equal(panel.getAttribute('data-layout'), 'columns');
  assert.equal(doc.getElementById('chat-thread').className, 'chat-thread is-joint');
  assert.equal(doc.getElementById('chat-layout-columns').getAttribute('aria-pressed'), 'true');
  await doc.getElementById('chat-layout-stack').fire('click');
  assert.equal(panel.getAttribute('data-layout'), 'stack'); assert.equal(store.get('co-agent.chat.layout'), 'stack');
  assert.equal(doc.getElementById('chat-layout-stack').getAttribute('aria-pressed'), 'true');
  const input = doc.getElementById('chat-input');
  assert.equal(input.rows, 1); assert.match(input.getAttribute('placeholder'), /^继续问 全部成员…（Enter 发送，Shift\+Enter 换行）$/);
  assert.equal(doc.querySelector('label[for="chat-input"]').className, 'chat-sr-only');
  const css = await fs.readFile('public/styles.css', 'utf8');
  assert.match(css, /\.chat-page\[data-layout="stack"\] \.chat-answers-joint \{ display:flex; flex-direction:column; align-items:stretch; \}/);
  assert.match(css, /\.chat-page #chat-input \{ flex:1; min-height:0; max-height:240px;/);
});
