import { confirmMembers } from './calls.js';
import { bookLabel } from './display.js';

export const councilActive = s => ['queued', 'running'].includes(s?.status);
export function councilDraftError(draft) {
  if (!draft?.name.trim() || Array.from(draft.name).length > 40) return '名字必须为 1–40 字';
  if (!draft.goal.trim() || Array.from(draft.goal).length > 1000) return '目标必须为 1–1000 字';
  if (draft.memberIds.length < 2 || draft.memberIds.length > 5 || new Set(draft.memberIds).size !== draft.memberIds.length) return '请选择 2–5 本不同的书';
  return '';
}
export function createCouncils({ api, getRegistry, confirm, permissionText, onState = () => {}, onOpen = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { items: [], selected: null, busy: false, error: '', draft: null, report: '' };
  const reports = new Map(), cached = new Map();
  let selectedId = null, version = 0, disposed = false, timer;
  const url = id => `/api/councils/${encodeURIComponent(id)}`;
  const snapshot = () => structuredClone({ ...state, books: (getRegistry()?.agents || []).filter(a => a.kind === 'book')
    .map(a => ({ id: a.id, name: a.name, bookLabel: bookLabel(a), available: !!a.platforms?.codex?.available })) });
  const emit = () => { if (!disposed) onState(snapshot()); };
  function schedule() {
    clearTimer(timer);
    if (!disposed) timer = setTimer(refresh, state.items.some(c => c.running) || state.selected?.sessions.some(councilActive) ? 5000 : 60000);
  }
  async function read(id) {
    const c = await api(url(id));
    if (c?.councilId !== id || !Array.isArray(c.sessions)) throw new Error('顾问团详情响应无效');
    c.sessions = await Promise.all(c.sessions.map(async s => {
      const key = JSON.stringify(s), previous = cached.get(s.sessionId);
      if (previous?.key === key && !councilActive(s)) return previous.value;
      const value = await api(`${url(id)}/sessions/${encodeURIComponent(s.sessionId)}`);
      if (value.sessionId !== s.sessionId || value.councilId !== id) throw new Error('讨论记录响应无效');
      cached.set(s.sessionId, { key, value }); return value;
    }));
    return c;
  }
  async function refresh() {
    if (disposed) return;
    clearTimer(timer); const token = ++version, id = selectedId;
    try {
      const value = await api('/api/councils');
      if (!Array.isArray(value.items)) throw new Error('顾问团列表响应无效');
      let selected = null;
      if (id) {
        try { selected = await read(id); }
        catch (e) { if (e.status !== 404) throw e; }
      }
      if (disposed || token !== version) return;
      state.items = value.items; state.selected = selected;
      if (id && !selected) { selectedId = null; state.report = ''; }
    } catch (error) { if (!disposed && token === version) state.error = error.message; }
    finally { if (!disposed && token === version) { emit(); schedule(); } }
  }
  async function selectCouncil(id) {
    if (disposed || state.busy) return;
    version++; selectedId = id; state.selected = null; state.error = ''; state.draft = null;
    state.report = reports.get(id) || ''; emit(); await refresh();
  }
  async function mutate(fn) {
    if (disposed || state.busy) return false;
    version++; state.busy = true; state.error = ''; emit();
    try { return await fn(); }
    catch (error) { if (!disposed) state.error = error.message; return false; }
    finally { state.busy = false; if (!disposed) { await refresh(); emit(); } }
  }
  async function startCouncilSession() {
    const id = selectedId, report = state.report;
    if (!id) return false;
    return mutate(async () => {
      if (!report.trim() || Array.from(report).length > 4000) throw new Error('汇报必须为 1–4000 字');
      // Refresh membership before asking permissions. The server checks member
      // availability and confirmation requirements again when starting the run.
      const current = await api(url(id));
      const select = registry => current.memberIds.map(id => registry?.agents.find(a => a.id === id && a.kind === 'book'));
      let members = select(getRegistry());
      if (members.some(a => !a)) throw new Error('成员不可用，请先移除或替换这个成员');
      let flags = await confirmMembers(members, 'codex', { confirm: text => !disposed && confirm(text), permissionText });
      if (!flags || disposed) return false;
      let value;
      try { value = await api(`${url(id)}/sessions`, { report, ...flags }); }
      catch (e) {
        if (e.status !== 409 || (!e.data?.writable && !e.data?.sourcesConfirmed)) throw e;
        members = select(await api('/api/registry'));
        if (members.some(a => !a)) throw new Error('成员不可用，请先移除或替换这个成员');
        flags = await confirmMembers(members, 'codex', { confirm: text => !disposed && confirm(text), permissionText });
        if (!flags || disposed) return false;
        if (e.data.sourcesConfirmed && !flags.sourcesConfirmed) {
          if (!await confirm('原书路径失效，请确认后执行。') || disposed) return false;
          flags.sourcesConfirmed = true;
        }
        if (e.data.writable && !flags.writableConfirmed) throw e;
        value = await api(`${url(id)}/sessions`, { report, ...flags });
      }
      if (!value?.sessionId) throw new Error('讨论提交响应无效');
      reports.delete(id); state.report = ''; return true;
    });
  }
  return { snapshot, refresh, selectCouncil, startCouncilSession,
    async openCouncils() { if (!disposed) { onOpen(); await refresh(); } },
    newCouncil() { if (!disposed && !state.busy) { state.draft = { councilId: null, name: '', goal: '', memberIds: [] }; state.error = ''; emit(); } },
    editCouncil() { if (!disposed && !state.busy && state.selected) {
      const { councilId, name, goal, memberIds } = state.selected; state.draft = { councilId, name, goal, memberIds: [...memberIds] }; emit();
    } },
    cancelCouncilEdit() { if (!state.busy) { state.draft = null; emit(); } },
    setCouncilDraft(patch) { if (!disposed && !state.busy && state.draft) { for (const k of ['name', 'goal', 'memberIds']) if (Object.hasOwn(patch, k)) state.draft[k] = structuredClone(patch[k]); emit(); } },
    setCouncilReport(text) { if (!disposed && !state.busy && selectedId) { state.report = text; reports.set(selectedId, text); emit(); } },
    saveCouncil() { const draft = structuredClone(state.draft); return mutate(async () => {
      const error = councilDraftError(draft); if (error) throw new Error(error);
      const { councilId, ...body } = draft;
      const saved = await api(councilId ? url(councilId) : '/api/councils', body, councilId ? 'PUT' : 'POST');
      if (!saved?.councilId) throw new Error('顾问团保存响应无效');
      selectedId = saved.councilId; state.report = reports.get(selectedId) || ''; state.draft = null; return true;
    }); },
    archiveCouncil() { const c = state.selected; if (!c) return false; return mutate(async () => { await api(url(c.councilId), { archived: !c.archived }, 'PUT'); return true; }); },
    undoCouncil(trigger) { const id = selectedId; if (!id) return false; return mutate(async () => {
      if (!await confirm('撤销最近一次讨论并恢复之前的计划和记忆？讨论记录将保留。', trigger, { title: '撤销讨论', accept: '撤销' }) || disposed) return false;
      await api(`${url(id)}/undo`, {}, 'POST'); return true;
    }); },
    deleteCouncil(trigger) { const id = selectedId; if (!id) return false; return mutate(async () => {
      if (!await confirm('删除整个顾问团及全部讨论记录？此操作无法撤销。', trigger, { title: '删除顾问团', accept: '删除', danger: true }) || disposed) return false;
      await api(url(id), undefined, 'DELETE'); selectedId = null; state.selected = null; state.draft = null; state.report = ''; reports.delete(id);
      for (const [sid, cachedSession] of cached) if (cachedSession.value.councilId === id) cached.delete(sid);
      return true;
    }); },
    dispose() { disposed = true; version++; clearTimer(timer); },
  };
}
