import { confirmMembers } from './calls.js';
import { bookLabel, roomReady } from './display.js';

// Labels mirror D66; the backend owns and validates the canonical IDs.
export const consultLenses = [
  ['risk', '风险与不确定性'], ['bias', '判断与认知偏差'], ['systems', '系统与长期影响'], ['execution', '执行与习惯'],
  ['money', '财务与价值'], ['health', '身心与精力'], ['people', '关系与沟通'], ['meaning', '意义与价值观'],
];
export const consultDisclaimer = '本备忘录由书中观点推演而来，不构成医疗、法律、心理或投资建议；涉及健康、法律或大额财务时，请咨询专业人士。';
export const consultActive = record => ['queued', 'running'].includes(record?.status);
// v0.48: 自动选择 asks for 3, 5 or 7 books (2026-11-07); 3 is the default.
export const consultCounts = [3, 5, 7];
const emptyDraft = () => ({ situation: '', options: [], explicit: false, count: 3, lenses: [], parentId: null });
export function consultDraftError(draft) {
  const count = Array.from(draft.situation.trim()).length;
  if (!count || count > 4000) return '处境必须为 1–4000 字';
  if (draft.options.length && (draft.options.length < 2 || draft.options.length > 5)) return '选项必须为空或 2–5 项';
  const seen = new Set();
  for (const [i, text] of draft.options.entries()) {
    if (!text.trim() || Array.from(text).length > 200) return `选项 ${'ABCDE'[i]} 必须为 1–200 字`;
    if (seen.has(text.trim())) return `选项 ${'ABCDE'[i]} 与其他选项重复`;
    seen.add(text.trim());
  }
  if (draft.explicit && (draft.lenses.length < 3 || draft.lenses.length > 5 || draft.lenses.some(l => !consultLenses.some(x => x[0] === l.lens) || !l.agentId) ||
    new Set(draft.lenses.map(l => l.lens)).size !== draft.lenses.length || new Set(draft.lenses.map(l => l.agentId)).size !== draft.lenses.length)) return '请选择 3–5 组互不重复的视角与书';
  return '';
}

export function createConsults({ api, getRegistry, confirm, permissionText, onState = () => {}, onOpen = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { items: [], selected: null, running: null, active: 0, parallel: 3, busy: false, error: '', draft: emptyDraft() };
  let disposed = false, timer, selectedId = null, listVersion = 0, detailVersion = 0;
  const snapshot = () => structuredClone({ ...state, books: (getRegistry()?.agents || []).filter(a => a.kind === 'book')
    .map(a => ({ id: a.id, name: a.name, bookLabel: bookLabel(a), available: !!a.platforms?.codex?.available, ready: roomReady(a) })) });
  const emit = () => { if (!disposed) onState(snapshot()); };
  const running = () => !!state.running || state.items.some(consultActive) || consultActive(state.selected);
  // v0.47: up to `parallel` consults at once (the server sends the limit); a new one can start while others run.
  const full = () => state.active >= state.parallel;
  function schedule() { clearTimer(timer); if (!disposed) timer = setTimer(refresh, running() ? 5000 : 60000); }
  async function read(id) {
    const r = await api(`/api/consults/${encodeURIComponent(id)}`);
    if (!r || r.consultId !== id) throw new Error('会诊详情响应无效');
    return r;
  }
  async function selectConsult(id) {
    if (disposed || state.busy || typeof id !== 'string' || !id) return null;
    selectedId = id; state.selected = null; state.error = ''; const version = ++detailVersion; emit();
    try { const r = await read(id); if (!disposed && version === detailVersion) { state.selected = r; return r; } }
    catch (e) { if (!disposed && version === detailVersion) state.error = e.message; }
    finally { if (!disposed && version === detailVersion) { emit(); schedule(); } }
    return null;
  }
  async function refresh() {
    if (disposed) return;
    clearTimer(timer); const version = ++listVersion, selection = detailVersion;
    try {
      const value = await api('/api/consults?limit=30');
      if (disposed || version !== listVersion || selection !== detailVersion) return;
      if (!Array.isArray(value.items)) throw new Error('会诊列表响应无效');
      state.items = value.items; state.running = value.running ?? null;
      state.active = Number.isInteger(value.active) ? value.active : value.items.filter(consultActive).length;
      if (Number.isInteger(value.parallel) && value.parallel > 0) state.parallel = value.parallel;
      if (!selectedId) selectedId = value.running?.consultId || value.items[0]?.consultId || null;
      if (selectedId) {
        try {
          const record = await read(selectedId);
          if (!disposed && version === listVersion && selection === detailVersion) state.selected = record;
        } catch (e) {
          if (disposed || version !== listVersion || selection !== detailVersion) return;
          if (e.status === 404) { selectedId = null; state.selected = null; } else throw e;
        }
      }
    } catch (e) { if (!disposed && version === listVersion && selection === detailVersion) state.error = `会诊读取失败：${e.message}`; }
    finally { if (!disposed && version === listVersion) { emit(); schedule(); } }
  }
  function members(draft) {
    const selected = draft.lenses.map(l => getRegistry()?.agents.find(a => a.id === l.agentId));
    if (selected.some(a => !a || a.kind !== 'book')) throw new Error('所选书籍已移除，请重新选择');
    return structuredClone(selected);
  }
  async function startConsult() {
    if (disposed || state.busy) return false;
    if (full()) { state.error = `最多同时进行 ${state.parallel} 场会诊，请等其中一场结束`; emit(); return false; }
    const draft = structuredClone(state.draft);
    const invalid = consultDraftError(draft); if (invalid) { state.error = invalid; emit(); return false; }
    state.busy = true; state.error = ''; emit();
    try {
      let flags = {}, selected;
      if (draft.explicit) {
        selected = members(draft);
        flags = await confirmMembers(selected, 'codex', { confirm: text => !disposed && confirm(text), permissionText });
        if (!flags || disposed) return false;
        if (JSON.stringify(selected) !== JSON.stringify(members(draft))) throw new Error('Agent 信息已变化，请重新选择并确认');
      }
      const body = { situation: draft.situation, options: draft.options, ...(draft.explicit ? { lenses: draft.lenses } : { count: draft.count }),
        ...(draft.parentId ? { parentId: draft.parentId } : {}), ...flags };
      let value;
      try { value = await api('/api/consults', body); }
      catch (e) {
        // A server-side permission change may be newer than the page's registry snapshot.
        if (!draft.explicit || e.status !== 409 || (!e.data?.writable && !e.data?.sourcesConfirmed)) throw e;
        const refreshed = await api('/api/registry');
        const current = draft.lenses.map(l => refreshed.agents.find(a => a.id === l.agentId));
        if (current.some(a => !a || a.kind !== 'book')) throw new Error('所选书籍已移除，请重新选择');
        flags = await confirmMembers(current, 'codex', { confirm: text => !disposed && confirm(text), permissionText });
        if (!flags || disposed) return false;
        if (e.data.sourcesConfirmed && !flags.sourcesConfirmed) {
          if (!await confirm('原书路径失效，请确认后执行。')) return false;
          flags.sourcesConfirmed = true;
        }
        if (e.data.writable && !flags.writableConfirmed) throw e;
        if (disposed) return false;
        value = await api('/api/consults', { ...body, ...flags });
      }
      if (disposed) return false;
      if (typeof value?.consultId !== 'string' || !value.consultId) throw new Error('会诊提交响应无效');
      listVersion++; detailVersion++; selectedId = value.consultId; state.selected = null;
      state.running = { consultId: selectedId, status: 'queued' }; state.active++; state.draft = emptyDraft(); onOpen();
      await refresh(); return true;
    } catch (e) {
      if (!disposed) {
        if (e.data?.running) state.running = e.data.running;
        if (Number.isInteger(e.data?.active)) state.active = e.data.active;
        if (Number.isInteger(e.data?.parallel) && e.data.parallel > 0) state.parallel = e.data.parallel;
        state.error = e.message;
      }
      return false;
    }
    finally { state.busy = false; emit(); schedule(); }
  }
  async function rerunConsult(id) {
    if (disposed || state.busy) return;
    try {
      const record = state.selected?.consultId === id ? state.selected : await selectConsult(id);
      if (!record || disposed) return;
      if (consultActive(record)) throw new Error('原会诊尚未结束');
      state.draft = { situation: record.situation, options: (record.options || record.result?.options || []).map(o => o.text),
        explicit: record.mode === 'explicit', count: consultCounts.includes(record.count) ? record.count : 3, lenses: structuredClone(record.requestedLenses || []), parentId: id };
      state.error = ''; onOpen(); emit();
    } catch (e) { state.error = e.message; emit(); }
  }
  async function deleteConsult(id, trigger) {
    if (disposed || state.busy) return false;
    state.busy = true; state.error = ''; emit();
    try {
      const record = state.items.find(r => r.consultId === id) || state.selected;
      if (record?.consultId === id && consultActive(record)) throw new Error('运行中的会诊不能删除');
      if (!await confirm('删除这次会诊及其工作文件？此操作无法撤销。', trigger, { title: '删除会诊', accept: '删除', danger: true }) || disposed) return false;
      await api(`/api/consults/${encodeURIComponent(id)}`, undefined, 'DELETE');
      listVersion++; detailVersion++;
      if (selectedId === id) { selectedId = null; state.selected = null; }
      if (state.draft.parentId === id) state.draft.parentId = null;
      state.items = state.items.filter(r => r.consultId !== id); await refresh(); return true;
    } catch (e) { if (!disposed) state.error = e.message; return false; }
    finally { state.busy = false; emit(); schedule(); }
  }
  return { snapshot, refresh, selectConsult, startConsult, rerunConsult, deleteConsult,
    setConsultDraft(patch) { if (!disposed && !state.busy) { for (const key of ['situation', 'options', 'explicit', 'count', 'lenses']) if (Object.hasOwn(patch, key)) state.draft[key] = structuredClone(patch[key]); emit(); } },
    async openConsults() { if (!disposed) { onOpen(); await refresh(); } },
    dispose() { disposed = true; listVersion++; detailVersion++; clearTimer(timer); },
  };
}
