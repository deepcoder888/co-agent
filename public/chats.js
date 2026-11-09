import { manageDialog } from './accessibility.js';
import { bookLabel, spineTitle, authorShort, missingSourcesFor } from './display.js';

// v0.39 在 CO-AGENT 中调用: the page state. A chat exists on the server from its first question; before that the
// page holds a pending one (members + engine). Answers stream in through polling while any of them is running.
export const chatActive = answer => ['queued', 'running'].includes(answer?.status);
export const chatRunning = chat => !!chat?.turns?.some(t => Object.values(t.answers).some(chatActive));
const engineName = engine => engine === 'codex' ? 'Codex' : 'Claude';

export function createChats({ api, getRegistry, confirm, onState = () => {}, onOpen = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { items: [], loaded: false, selected: null, pending: null, draft: '', recipients: null, busy: false, error: '', notice: '', rewrite: null, rewriting: false };
  let disposed = false, timer, version = 0;
  const agentOf = id => getRegistry()?.agents.find(a => a.id === id);
  const person = id => {
    const a = agentOf(id);
    return { id, name: a?.name || `${id}（已移除）`, kind: a?.kind || 'role', bookLabel: a ? bookLabel(a) : '', shortTitle: a?.kind === 'book' ? a.spineTitle || spineTitle(a) : '', author: a ? authorShort(a) : '' };
  };
  const members = () => (state.selected?.agentIds || state.pending?.agentIds || []);
  const recipientIds = () => state.selected ? (state.recipients || state.selected.agentIds) : (state.pending?.agentIds || []);
  // v0.46 按书改写: the book recipients a rewrite can be asked for (role Agents always get the original question).
  const bookRecipients = () => recipientIds().filter(id => agentOf(id)?.kind === 'book');
  function snapshot() {
    const ids = members(), key = [...ids].sort().join('|');
    const decorate = item => ({ ...item, names: item.agentIds.map(id => person(id).name) });
    return structuredClone({ ...state, members: ids.map(person), engine: state.selected?.engine || state.pending?.engine || 'codex',
      // v0.40: follow-ups (追问) belong to their 圆桌 or 会诊, not to this list.
      running: chatRunning(state.selected), related: state.items.filter(i => !i.origin && [...i.agentIds].sort().join('|') === key).map(decorate),
      others: state.items.filter(i => !i.origin && [...i.agentIds].sort().join('|') !== key).map(decorate),
      recipients: state.recipients || ids, rewritable: bookRecipients() });
  }
  const emit = () => { if (!disposed) onState(snapshot()); };
  function schedule() {
    clearTimer(timer); if (disposed) return;
    if (chatRunning(state.selected) || state.items.some(i => i.running)) timer = setTimer(poll, 800);
  }
  async function poll() {
    const mine = ++version;
    try {
      if (state.selected) { const chat = await api(`/api/chats/${encodeURIComponent(state.selected.chatId)}`); if (mine === version && !disposed) state.selected = chat; }
      const list = await api('/api/chats'); if (mine === version && !disposed) state.items = list.items;
    } catch (problem) { if (!disposed) state.error = `对话读取失败：${problem.message}`; }
    emit(); schedule();
  }
  async function refresh() {
    try { const list = await api('/api/chats'); if (!disposed) { state.items = list.items; state.loaded = true; } }
    catch (problem) { if (!disposed) state.error = `对话列表读取失败：${problem.message}`; }
    emit(); schedule();
  }
  // Only an invalid book path needs consent here: in-app answers cannot write files.
  async function sourcesFlag(ids, engine) {
    const missing = ids.map(agentOf).filter(a => a && missingSourcesFor(a, engine).length);
    if (!missing.length) return {};
    return await confirm(`原书路径失效，请确认后执行：\n${missing.map(a => `${a.name}：${missingSourcesFor(a, engine).join('；')}`).join('\n')}`) ? { sourcesConfirmed: true } : null;
  }
  async function begin({ agentIds, engine, groupId = null, question = '' }) {
    version++; state.selected = null; state.pending = { agentIds: [...agentIds], engine, groupId }; state.recipients = null; state.rewrite = null;
    state.draft = question; state.error = ''; state.notice = ''; onOpen(); emit(); void refresh();
    if (question.trim()) await send();
  }
  async function select(chatId) {
    const mine = ++version; state.busy = true; state.error = ''; emit();
    try {
      const chat = await api(`/api/chats/${encodeURIComponent(chatId)}`);
      if (mine !== version || disposed) return;
      state.selected = chat; state.pending = null; state.recipients = null; state.draft = ''; state.rewrite = null;
    } catch (problem) { state.error = `对话读取失败：${problem.message}`; }
    finally { state.busy = false; emit(); schedule(); }
  }
  async function send() {
    const text = state.draft, chat = state.selected, pending = state.pending;
    if (state.busy || state.rewriting || !text.trim() || (!chat && !pending)) return;
    const recipients = chat ? (state.recipients || chat.agentIds) : pending.agentIds, engine = chat?.engine || pending.engine;
    if (chat && chat.turns.some(t => recipients.some(r => chatActive(t.answers[r])))) { state.error = '所选成员还在回答，回答完成后再发送'; emit(); return; }
    state.busy = true; state.error = ''; emit();
    try {
      const flags = await sourcesFlag(recipients, engine);
      if (!flags) { state.notice = '已取消发送。'; return; }
      const drafts = state.rewrite?.source === text ? Object.fromEntries(state.rewrite.items.filter(i => recipients.includes(i.id)).map(i => [i.id, { question: i.question, angle: i.angle }])) : {};
      const extra = Object.keys(drafts).length ? { rewrites: drafts } : {};
      const mine = ++version;
      const result = chat ? await api(`/api/chats/${encodeURIComponent(chat.chatId)}/ask`, { question: text, ...(state.recipients ? { recipients } : {}), ...flags, ...extra })
        : await api('/api/chats', { agentIds: pending.agentIds, engine, groupId: pending.groupId, question: text, ...flags, ...extra });
      if (disposed) return;
      if (mine === version) { state.selected = result; state.pending = null; }
      state.draft = ''; state.notice = ''; state.rewrite = null;
      void refresh();
    } catch (problem) { state.error = problem.message; }
    finally { state.busy = false; emit(); schedule(); }
  }
  async function command(verb, body) {
    const chat = state.selected; if (!chat) return;
    state.error = ''; emit();
    try {
      const result = await api(`/api/chats/${encodeURIComponent(chat.chatId)}/${verb}`, body);
      if (verb === 'terminal') { state.notice = `已在终端中打开 ${person(body.agentId).name} 的会话。`; emit(); return; }
      if (!disposed && state.selected?.chatId === chat.chatId) state.selected = result;
    } catch (problem) { state.error = problem.message; }
    emit(); schedule();
  }
  return {
    snapshot, refresh,
    // From a detail panel, the joint builder or a group: start a new conversation with these members.
    start: begin,
    async open() { onOpen(); await refresh(); const first = state.items.find(i => !i.origin); if (!state.selected && !state.pending && first) await select(first.chatId); },
    select,
    send,
    setDraft(text) {
      state.draft = String(text);
      // Drafts written for another wording would answer a question the user no longer asks.
      if (state.rewrite && state.rewrite.source !== state.draft) { state.rewrite = null; state.notice = '问题改了，改写稿已作废，可以重新改写。'; emit(); }
    },
    // One Codex call drafts a question per book; the user reads and edits them before 发送.
    async rewrite() {
      const text = state.draft, ids = bookRecipients(), owner = state.selected?.chatId || state.pending;
      if (state.busy || state.rewriting || !text.trim() || !ids.length) return;
      state.rewriting = true; state.error = ''; state.notice = ''; emit();
      try {
        const result = await api('/api/chats/rewrite', { agentIds: ids, question: text });
        if (disposed || (state.selected?.chatId || state.pending) !== owner) return;
        if (state.draft !== text) { state.notice = '改写期间问题改了，这份改写稿没有采用。'; return; }
        state.rewrite = { source: text, items: result.items };
        state.notice = '改写稿在下面，可以修改；发送时每本书收到自己的版本。';
      } catch (problem) { state.error = problem.message; }
      finally { state.rewriting = false; emit(); }
    },
    editRewrite(id, text) { const item = state.rewrite?.items.find(i => i.id === id); if (item) item.question = String(text); },
    clearRewrite() { state.rewrite = null; state.notice = ''; emit(); },
    setRecipients(ids) { const all = members(); state.recipients = ids.length && ids.length < all.length ? ids.filter(id => all.includes(id)) : null; emit(); },
    stop: agentId => command('stop', agentId ? { agentId } : {}),
    retry: (turnId, agentId) => command('retry', { turnId, agentId }),
    terminal: agentId => command('terminal', { agentId }),
    newChat() { const ids = members(); if (ids.length) void begin({ agentIds: ids, engine: snapshot().engine, groupId: state.selected?.groupId ?? state.pending?.groupId ?? null }); },
    // Changing the engine starts a new conversation: a CLI session belongs to one engine.
    setEngine(engine) {
      if (!['claude', 'codex'].includes(engine) || snapshot().engine === engine) return;
      const ids = members(); if (ids.length) void begin({ agentIds: ids, engine, groupId: state.selected?.groupId ?? state.pending?.groupId ?? null });
    },
    dispose() { disposed = true; version++; clearTimer(timer); },
  };
}

// The engine choice after 「在 CO-AGENT 中调用」, shared by every layout's detail panel.
export function mountChatStart(doc, { getRegistry, onStart }) {
  const dialog = doc.createElement('dialog'); dialog.id = 'chat-start'; dialog.className = 'confirm-dialog chat-start-dialog';
  const title = doc.createElement('h2'); title.id = 'chat-start-title';
  const hint = doc.createElement('p'); hint.textContent = '由谁来回答';
  const group = doc.createElement('div'); group.className = 'chat-start-engines'; group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', 'chat-start-title');
  const status = doc.createElement('p'); status.className = 'chat-start-reason'; status.setAttribute('role', 'status');
  const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.id = 'chat-start-cancel';
  const actions = doc.createElement('div'); actions.className = 'actions'; actions.append(cancel);
  dialog.append(title, hint, group, status, actions); doc.body.append(dialog);
  const controller = manageDialog(doc, dialog, { labelledby: 'chat-start-title' });
  let agentId = null;
  cancel.addEventListener('click', () => controller.close());
  return {
    open(id, trigger) {
      const agent = getRegistry()?.agents.find(a => a.id === id); if (!agent) return;
      agentId = id; title.textContent = `在 CO-AGENT 中调用 ${agent.name}`; group.replaceChildren(); status.textContent = '';
      for (const engine of ['codex', 'claude']) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'chat-start-engine';
        button.textContent = engineName(engine); button.id = `chat-start-${engine}`;
        const platform = agent.platforms?.[engine];
        button.disabled = !platform?.available;
        if (!platform?.available) { button.title = platform?.reason || '入口不可用'; status.textContent = `${engineName(engine)} 不可用：${button.title}`; }
        button.addEventListener('click', () => { if (button.disabled) return; controller.close(); onStart({ agentIds: [agentId], engine }); });
        group.append(button);
      }
      controller.open(trigger);
    },
    dispose() { dialog.remove(); },
  };
}
