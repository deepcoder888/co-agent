import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { resolveCli } from '../launch/spec.mjs';
import { dateDirs } from '../launch/verify.mjs';
import { claudeRelay } from '../launch/claude.mjs';
import { missingSourcesFor } from '../../public/display.js';
import { agentCwd } from '../config.mjs';
import { claudeChatArgs, codexChatArgs, codexChatPrompt, claudeEvent, codexEvent, runAnswer, claudeName, relayMode } from './runner.mjs';
import { runRewrite, rewriteLimits } from './rewrite.mjs';

// v0.39 在 CO-AGENT 中调用: a chat is one engine and 1–8 Agents. Each Agent keeps its own CLI session, so
// follow-ups resume it; a turn sends one question to some or all members and every member answers on its own.
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
const active = answer => ['queued', 'running'].includes(answer?.status);
export const chatLimits = { members: 8, question: 8000, parallel: 4, list: 200 };
// A logged-out CLI is the most common failure; say what to do instead of the raw English message.
export function explainFailure(engine, message) {
  if (/authenticat|oauth|not logged in|log ?in|401|unauthori[sz]ed/i.test(message)) return `${engine === 'codex' ? 'Codex' : 'Claude'} CLI 没有登录或登录已过期：请在终端运行 ${engine === 'codex' ? 'codex login' : 'claude，然后输入 /login'}，登录后点「重试」。（原始信息：${message}）`;
  return message;
}

export function createChats(config, { getRegistry, spawnImpl, env = process.env, now = () => new Date(), runImpl = runAnswer, rewriteImpl = runRewrite, createResumeImpl, contextFor, log = () => {} } = {}) {
  const dir = path.join(config.dataDir, 'chats'), timeoutMs = config.chat?.timeoutMs ?? 30 * 60 * 1000;
  const chats = new Map(), writes = new Map(), controllers = new Map(), rewriting = new Set(), queue = [];
  let loaded = null, running = 0, closing = false;
  const file = id => path.join(dir, `${id}.json`);
  const stamp = () => now().toISOString();
  const key = (chatId, turnId, agentId) => `${chatId}/${turnId}/${agentId}`;
  // One write at a time per chat, and a short retry: on Windows a rename over a file that someone is reading
  // at that moment (the page's own reader, an indexer, antivirus) fails with EPERM/EACCES/EBUSY.
  const write = async (target, content) => {
    for (let attempt = 0; ; attempt++) {
      try { return await atomicWrite(target, content); }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  };
  const save = chat => {
    const content = JSON.stringify(chat, null, 2) + '\n';
    const work = (writes.get(chat.chatId) || Promise.resolve()).then(() => write(file(chat.chatId), content)).catch(error => log(`对话保存失败：${error.message}`));
    writes.set(chat.chatId, work); return work;
  };
  async function load() {
    loaded ??= (async () => {
      let names = [];
      try { names = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of names) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
        try {
          const chat = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
          if (!validId(chat?.chatId) || chats.has(chat.chatId)) continue;
          // An answer still running when the app stopped can never finish now.
          let changed = false;
          for (const turn of chat.turns || []) for (const answer of Object.values(turn.answers || {})) if (active(answer)) {
            Object.assign(answer, { status: 'failed', error: '软件关闭时回答被中断', endedAt: answer.endedAt || chat.updatedAt }); changed = true;
          }
          chats.set(chat.chatId, chat); if (changed) await save(chat);
        } catch (error) { log(`对话记录无法读取：${name}：${error.message}`); }
      }
    })();
    return loaded;
  }
  const agentOf = id => getRegistry()?.agents.find(a => a.id === id);
  function summary(chat) {
    const answers = chat.turns.flatMap(t => Object.values(t.answers));
    return { chatId: chat.chatId, kind: chat.kind, engine: chat.engine, agentIds: chat.agentIds, groupId: chat.groupId, origin: chat.origin || null, title: chat.title,
      createdAt: chat.createdAt, updatedAt: chat.updatedAt, turns: chat.turns.length, running: answers.some(active),
      failed: chat.turns.at(-1) ? Object.values(chat.turns.at(-1).answers).some(a => ['failed', 'stopped'].includes(a.status)) : false };
  }
  async function get(id) {
    await load(); const chat = validId(id) && chats.get(id);
    if (!chat) throw fail(404, '对话不存在');
    return structuredClone(chat);
  }
  function members(agentIds, engine, sourcesConfirmed) {
    if (!Array.isArray(agentIds) || !agentIds.length || agentIds.length > chatLimits.members || new Set(agentIds).size !== agentIds.length) throw fail(400, `成员必须为 1–${chatLimits.members} 个不重复的 Agent`);
    const agents = agentIds.map(id => agentOf(id));
    if (agents.some(a => !a)) throw fail(400, '有成员不在范围内注册表中');
    const unavailable = agents.filter(a => !a.platforms?.[engine]?.available);
    if (unavailable.length) throw fail(409, `${engine === 'claude' ? 'Claude' : 'Codex'} 不可用：${unavailable.map(a => `${a.name}：${a.platforms?.[engine]?.reason || '入口不可用'}`).join('；')}`);
    if (agents.some(a => missingSourcesFor(a, engine).length) && sourcesConfirmed !== true) throw fail(409, '原书路径失效，请先确认');
    return agents;
  }
  function question(text) {
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > chatLimits.question) throw fail(400, `问题必须为 1–${chatLimits.question} 字`);
    return text;
  }
  // v0.46 按书改写: drafts the user reviewed, one per book recipient; everyone else gets the original question.
  function rewrites(value, recipients) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '改写稿格式无效');
    const out = {};
    for (const [id, item] of Object.entries(value)) {
      if (!recipients.includes(id) || agentOf(id)?.kind !== 'book') throw fail(400, '改写稿只能给本轮所问的书籍 Agent');
      const text = typeof item?.question === 'string' ? item.question.trim() : '', angle = typeof item?.angle === 'string' ? item.angle.trim() : '';
      if (!text || Array.from(text).length > chatLimits.question || Array.from(angle).length > rewriteLimits.angle) throw fail(400, `改写后的问题必须为 1–${chatLimits.question} 字，角度最多 ${rewriteLimits.angle} 字`);
      out[id] = { question: text, angle };
    }
    return Object.keys(out).length ? out : null;
  }
  async function rewrite(body) {
    await load();
    if (closing) throw fail(503, '软件正在关闭');
    const text = question(body?.question), ids = body?.agentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > chatLimits.members || new Set(ids).size !== ids.length) throw fail(400, `书目必须为 1–${chatLimits.members} 个不重复的 Agent`);
    const agents = ids.map(agentOf);
    if (agents.some(a => a?.kind !== 'book')) throw fail(400, '只有书籍 Agent 可以按书改写');
    const controller = new AbortController(); rewriting.add(controller);
    try { return await rewriteImpl(text, agents, config, { spawnImpl, env, signal: controller.signal }); }
    catch (error) { throw fail(502, `按书改写没有成功：${error.message}`); }
    finally { rewriting.delete(controller); }
  }
  async function start(body) {
    await load();
    if (closing) throw fail(503, '软件正在关闭');
    // v0.40: a follow-up to a 圆桌讨论 or 会诊 names its record; the members and background come from that record, and Codex answers.
    const room = body?.origin === undefined ? null : await contextFor?.(body.origin);
    if (body?.origin !== undefined && !room) throw fail(400, '追问的来源无效');
    const engine = room ? 'codex' : body?.engine;
    if (!['claude', 'codex'].includes(engine)) throw fail(400, '回答引擎必须是 Claude 或 Codex');
    const agents = members(room ? room.agentIds : body.agentIds, engine, body.sourcesConfirmed), text = question(body.question);
    const chatId = randomUUID(), at = stamp();
    const chat = { version: 1, chatId, kind: agents.length > 1 ? 'joint' : 'single', engine, agentIds: agents.map(a => a.id),
      groupId: typeof body.groupId === 'string' ? body.groupId : null, title: room ? room.title : Array.from(text.trim().split(/\r?\n/)[0]).slice(0, 40).join(''),
      ...(room ? { origin: { room: body.origin.room, id: body.origin.id }, context: room.context } : {}),
      createdAt: at, updatedAt: at, members: Object.fromEntries(agents.map(a => [a.id, { name: a.name, sessionId: engine === 'claude' ? randomUUID() : null, threadId: null, started: false }])), turns: [] };
    const drafts = rewrites(body.rewrites, chat.agentIds);
    chats.set(chatId, chat);
    addTurn(chat, text, chat.agentIds, drafts);
    await save(chat); return structuredClone(chat);
  }
  async function ask(id, body) {
    await load(); const chat = chats.get(id);
    if (!validId(id) || !chat) throw fail(404, '对话不存在');
    if (closing) throw fail(503, '软件正在关闭');
    const text = question(body?.question), recipients = body?.recipients === undefined ? chat.agentIds : body.recipients;
    if (!Array.isArray(recipients) || !recipients.length || new Set(recipients).size !== recipients.length || recipients.some(r => !chat.agentIds.includes(r))) throw fail(400, '收件人必须是本对话的成员');
    const busy = recipients.filter(r => chat.turns.some(t => active(t.answers[r])));
    if (busy.length) throw fail(409, `${busy.map(r => chat.members[r].name).join('、')} 还在回答`);
    members(recipients, chat.engine, body.sourcesConfirmed);
    addTurn(chat, text, recipients, rewrites(body.rewrites, recipients)); await save(chat); return structuredClone(chat);
  }
  function addTurn(chat, text, recipients, drafts = null) {
    const turn = { turnId: randomUUID(), question: text, askedAt: stamp(), recipients: [...recipients], ...(drafts ? { rewrites: drafts } : {}),
      answers: Object.fromEntries(recipients.map(r => [r, { status: 'queued', text: '', startedAt: null, endedAt: null, error: null }])) };
    chat.turns.push(turn); chat.updatedAt = turn.askedAt;
    for (const r of recipients) queue.push({ chatId: chat.chatId, turnId: turn.turnId, agentId: r });
    pump();
  }
  function pump() {
    while (!closing && running < chatLimits.parallel && queue.length) {
      const job = queue.shift(), chat = chats.get(job.chatId), turn = chat?.turns.find(t => t.turnId === job.turnId), answer = turn?.answers[job.agentId];
      if (!answer || answer.status !== 'queued') continue;
      running++; void execute(chat, turn, job.agentId).finally(() => { running--; pump(); });
    }
  }
  async function execute(chat, turn, agentId) {
    const answer = turn.answers[agentId], member = chat.members[agentId], agent = agentOf(agentId), controller = new AbortController();
    controllers.set(key(chat.chatId, turn.turnId, agentId), controller);
    Object.assign(answer, { status: 'running', startedAt: stamp(), error: null, text: '' }); chat.updatedAt = answer.startedAt; void save(chat);
    let lastSave = 0;
    try {
      if (!agent) throw new Error('该 Agent 已不在注册表中');
      const first = !member.started, claude = chat.engine === 'claude';
      const { exe, prefix } = await resolveCli(claude ? config.claudeExe : config.codexExe, env);
      const args = [...prefix, ...(claude ? claudeChatArgs(agent, member, config, first) : codexChatArgs(member, config, first))];
      const own = turn.rewrites?.[agentId]?.question ?? turn.question;
      const asked = first && chat.context ? `${chat.context}\n${own}` : own;
      const prompt = claude ? asked : codexChatPrompt(agent, chat.chatId, asked, config, first);
      const cwd = claude ? config.launchProject : agentCwd(config);
      if (!claude) await fs.mkdir(cwd, { recursive: true });
      const state = await runImpl({ exe, args, prompt, timeoutMs, signal: controller.signal, cwd, parse: claude ? claudeEvent : codexEvent,
        onUpdate: s => {
          answer.text = s.text; if (s.threadId && !member.threadId) member.threadId = s.threadId;
          if (Date.now() - lastSave > 2000) { lastSave = Date.now(); void save(chat); }
        } }, config, { spawnImpl, env });
      if (state.threadId) member.threadId ??= state.threadId;
      member.started = true;
      Object.assign(answer, { status: 'done', text: state.text, endedAt: stamp() });
    } catch (error) {
      if (error.state?.threadId) member.threadId ??= error.state.threadId;
      // Resume only a session the CLI actually opened; otherwise the next question starts it again.
      if (chat.engine === 'claude' ? error.state?.sessionId : member.threadId) member.started = true;
      Object.assign(answer, { status: error.stopped ? 'stopped' : 'failed', text: error.state?.text || answer.text, error: error.stopped ? null : explainFailure(chat.engine, error.message), endedAt: stamp() });
    } finally {
      controllers.delete(key(chat.chatId, turn.turnId, agentId)); chat.updatedAt = stamp(); await save(chat);
    }
  }
  async function stop(id, body) {
    await load(); const chat = chats.get(id);
    if (!validId(id) || !chat) throw fail(404, '对话不存在');
    const targets = body?.agentId === undefined ? chat.agentIds : [body.agentId];
    for (const turn of chat.turns) for (const agentId of targets) {
      const answer = turn.answers[agentId];
      if (answer?.status === 'queued') Object.assign(answer, { status: 'stopped', endedAt: stamp() });
      controllers.get(key(chat.chatId, turn.turnId, agentId))?.abort();
    }
    await save(chat); return structuredClone(chat);
  }
  // Only the latest turn of a member that failed or was stopped can be asked again.
  async function retry(id, body) {
    await load(); const chat = chats.get(id), agentId = body?.agentId;
    if (!validId(id) || !chat) throw fail(404, '对话不存在');
    const turn = chat.turns.findLast(t => t.answers[agentId]);
    if (!turn || turn.turnId !== body?.turnId || !['failed', 'stopped'].includes(turn.answers[agentId].status)) throw fail(409, '只能重试这位成员最近一次失败或停止的回答');
    if (chat.turns.some(t => active(t.answers[agentId]))) throw fail(409, `${chat.members[agentId].name} 还在回答`);
    members([agentId], chat.engine, body.sourcesConfirmed);
    Object.assign(turn.answers[agentId], { status: 'queued', text: '', error: null, startedAt: null, endedAt: null });
    queue.push({ chatId: chat.chatId, turnId: turn.turnId, agentId }); pump();
    await save(chat); return structuredClone(chat);
  }
  async function list() {
    await load();
    return { items: [...chats.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, chatLimits.list).map(summary) };
  }
  async function sessionFile(chat, member) {
    if (chat.engine === 'claude') {
      for (const entry of await fs.readdir(config.claudeProjectsDir, { withFileTypes: true }).catch(() => [])) {
        const candidate = path.join(config.claudeProjectsDir, entry.name, `${member.sessionId}.jsonl`);
        if (entry.isDirectory() && await fs.stat(candidate).then(s => s.isFile(), () => false)) return candidate;
      }
      return null;
    }
    for (const day of new Set([...dateDirs(chat.createdAt), ...dateDirs(chat.updatedAt)])) {
      const folder = path.join(config.codexSessionsDir, day);
      for (const name of await fs.readdir(folder).catch(() => [])) if (name.startsWith('rollout-') && name.endsWith(`${member.threadId}.jsonl`)) return path.join(folder, name);
    }
    return null;
  }
  // 在终端中继续: hand the member's session to the existing terminal resume path.
  async function terminal(id, body) {
    await load(); const chat = chats.get(id), agentId = body?.agentId, member = chat?.members[agentId], agent = agentOf(agentId);
    if (!validId(id) || !chat) throw fail(404, '对话不存在');
    if (!member || !agent) throw fail(400, '成员无效');
    if (chat.turns.some(t => active(t.answers[agentId]))) throw fail(409, `${member.name} 还在回答，回答完成后再到终端继续`);
    const sessionId = chat.engine === 'claude' ? member.sessionId : member.threadId;
    const found = member.started && sessionId ? await sessionFile(chat, member) : null;
    if (!found) throw fail(409, '还没有可以继续的会话');
    const relay = chat.engine === 'claude' && relayMode(agent, config);
    const original = { launchId: chat.chatId, agentId, agentName: chat.engine === 'claude' ? claudeName(agent) : agent.name, terminalAgentName: agent.name,
      cli: chat.engine, mode: chat.engine === 'claude' ? (relay ? 'relay' : 'agent') : 'relay', cwd: config.launchProject, codexProfile: config.codexProfile,
      args: relay ? ['--append-system-prompt', claudeRelay(claudeName(agent), agent.name, config)] : [] };
    return createResumeImpl(original, { id: sessionId, file: found });
  }
  async function close() {
    closing = true; queue.length = 0;
    for (const controller of [...controllers.values(), ...rewriting]) controller.abort();
    while (running) await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.all([...writes.values()]);
  }
  return { list, get, start, ask, rewrite, stop, retry, terminal, close };
}
