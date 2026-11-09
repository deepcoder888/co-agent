import { missingSourcesFor } from './display.js';
import { chatActive } from './chats.js';

// v0.40 rooms: 追问 on a finished 圆桌讨论 or 会诊. The follow-up is an in-app Codex chat whose origin names the record;
// the server picks the members (the people who took part) and gives them the synthesis as background.
// target() is idempotent, so the page can call it on every paint with the record it shows.
export function createFollowups({ api, getRegistry, confirm, onState = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { origin: null, agentIds: [], chat: null, loading: false, busy: false, error: '', notice: '', recipients: null };
  const drafts = new Map();
  let key = null, version = 0, timer, disposed = false;
  const keyOf = origin => origin ? `${origin.room}/${origin.id}` : null;
  const members = () => state.chat?.agentIds || state.agentIds;
  const running = () => !!state.chat?.turns.some(t => Object.values(t.answers).some(chatActive));
  function snapshot() {
    return structuredClone({ ...state, draft: drafts.get(key) || '', running: running(), recipients: state.recipients || members() });
  }
  const emit = () => { if (!disposed) onState(); };
  function schedule() { clearTimer(timer); if (!disposed && running()) timer = setTimer(poll, 800); }
  async function poll() {
    const mine = version, id = state.chat?.chatId; if (!id) return;
    try { const chat = await api(`/api/chats/${encodeURIComponent(id)}`); if (mine === version && !disposed) state.chat = chat; }
    catch (problem) { if (mine === version && !disposed) state.error = `追问读取失败：${problem.message}`; }
    emit(); schedule();
  }
  async function load(origin) {
    const mine = version;
    try {
      const list = await api('/api/chats');
      const found = (list.items || []).find(item => item.origin?.room === origin.room && item.origin?.id === origin.id);
      const chat = found ? await api(`/api/chats/${encodeURIComponent(found.chatId)}`) : null;
      if (mine !== version || disposed) return;
      state.chat = chat;
    } catch (problem) { if (mine === version && !disposed) state.error = `追问读取失败：${problem.message}`; }
    finally { if (mine === version && !disposed) { state.loading = false; emit(); schedule(); } }
  }
  async function command(verb, body) {
    const chat = state.chat; if (!chat) return;
    state.error = ''; emit();
    try {
      const result = await api(`/api/chats/${encodeURIComponent(chat.chatId)}/${verb}`, body);
      if (verb === 'terminal') state.notice = '已在终端中打开这段追问。';
      else if (!disposed && state.chat?.chatId === chat.chatId) state.chat = result;
    } catch (problem) { state.error = problem.message; }
    emit(); schedule();
  }
  return {
    snapshot,
    target(origin, agentIds = []) {
      const next = keyOf(origin);
      if (next === key) { if (origin && !state.chat) state.agentIds = [...agentIds]; return; }
      version++; clearTimer(timer); key = next;
      Object.assign(state, { origin: origin ? { room: origin.room, id: origin.id } : null, agentIds: [...agentIds], chat: null, error: '', notice: '', recipients: null, loading: !!origin });
      if (origin) void load(origin);
    },
    setDraft(text) { if (key) drafts.set(key, String(text)); },
    setRecipients(ids) { const all = members(); state.recipients = ids.length && ids.length < all.length ? ids.filter(id => all.includes(id)) : null; emit(); },
    async send() {
      const text = drafts.get(key) || '', chat = state.chat, origin = state.origin;
      if (state.busy || !origin || !text.trim()) return;
      const recipients = state.recipients || members();
      if (chat && chat.turns.some(t => recipients.some(id => chatActive(t.answers[id])))) { state.error = '所选作者还在回答，回答完成后再发送'; emit(); return; }
      state.busy = true; state.error = ''; state.notice = ''; emit();
      const mine = version, sentKey = key;
      try {
        // In-app answers cannot write files, so an invalid book path is the only thing to confirm.
        const missing = recipients.map(id => getRegistry()?.agents.find(a => a.id === id)).filter(a => a && missingSourcesFor(a, 'codex').length);
        const flags = missing.length ? (await confirm(`原书路径失效，请确认后执行：\n${missing.map(a => `${a.name}：${missingSourcesFor(a, 'codex').join('；')}`).join('\n')}`) ? { sourcesConfirmed: true } : null) : {};
        if (!flags) { state.notice = '已取消发送。'; return; }
        const result = chat ? await api(`/api/chats/${encodeURIComponent(chat.chatId)}/ask`, { question: text, ...(state.recipients ? { recipients } : {}), ...flags })
          : await api('/api/chats', { origin, question: text, ...flags });
        drafts.delete(sentKey);
        if (mine === version && !disposed) state.chat = result;
      } catch (problem) { if (mine === version) state.error = problem.message; }
      finally { state.busy = false; emit(); schedule(); }
    },
    stop: agentId => command('stop', agentId ? { agentId } : {}),
    retry: (turnId, agentId) => command('retry', { turnId, agentId }),
    terminal: agentId => command('terminal', { agentId }),
    dispose() { disposed = true; version++; clearTimer(timer); },
  };
}
