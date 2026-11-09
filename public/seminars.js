import { confirmMembers } from './calls.js';
import { conceptStatus } from './display.js';

const active = value => ['queued', 'running'].includes(value?.status);
const recordView = record => record ? { ...record, terms: record.result?.terms ?? record.terms ?? [] } : null;

export function seminarParticipants(record, registry) {
  return (record?.result?.selected || []).map(member => {
    const matches = (registry?.agents || []).filter(a => [a.id, a.name, a.platforms?.codex?.name]
      .some(name => name && typeof member.agent === 'string' && name.toLowerCase() === member.agent.toLowerCase()));
    const current = member.id ? registry?.agents.find(a => a.id === member.id) : matches.length === 1 ? matches[0] : null;
    return { ...member, id: member.id || current?.id || null, name: member.name || current?.name || member.agent };
  });
}

export function seminarStatus(record, now = Date.now()) {
  const status = conceptStatus(record, now);
  if (!active(record)) return status;
  const stage = record.stage || record.progress?.stage;
  const labels = { selecting: '选人中', analyzing: '分析中', synthesizing: '综合中', 选人中: '选人中', 分析中: '分析中', 综合中: '综合中' };
  return `${status} · ${labels[stage] || '阶段未确认'}`;
}

// API, timers and UI callbacks are injected; this controller never launches a CLI.
export function createSeminars({ api, getRegistry, confirm, permissionText, onState = () => {},
  onOpen = () => {}, onPicker = () => {}, onJoint = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { items: [], selected: null, running: null, active: 0, parallel: 3, busy: false, error: '', input: '' };
  let disposed = false, timer, selectedId = null, listVersion = 0, detailVersion = 0;
  const watched = new Map();
  const snapshot = () => structuredClone({ ...state, items: state.items.map(recordView), selected: recordView(state.selected),
    terms: state.selected?.result?.terms ?? state.selected?.terms ?? [] });
  const emit = () => { if (!disposed) onState(snapshot()); };
  const running = () => !!state.running || state.items.some(active) || active(state.selected) || watched.size > 0;
  // v0.48: up to `parallel` 圆桌 at once (the server sends the limit).
  const full = () => state.active >= state.parallel;
  function schedule() {
    clearTimer(timer);
    if (!disposed) timer = setTimer(refresh, running() ? 5000 : 60000);
  }
  function remember(record) {
    if (active(record)) watched.set(record.seminarId, record); else watched.delete(record.seminarId);
  }
  async function read(id) {
    const record = await api(`/api/seminars/${encodeURIComponent(id)}`);
    if (!record || record.seminarId !== id) throw new Error('研讨详情响应无效');
    return record;
  }
  async function selectSeminar(id) {
    if (disposed || typeof id !== 'string' || !id) return null;
    selectedId = id; state.selected = null; state.error = ''; const version = ++detailVersion; emit();
    try {
      const record = await read(id);
      if (disposed || version !== detailVersion) return null;
      state.selected = record; remember(record); return record;
    } catch (problem) {
      if (!disposed && version === detailVersion) state.error = `研讨读取失败：${problem.message}`;
      return null;
    } finally { if (!disposed && version === detailVersion) { emit(); schedule(); } }
  }
  async function refresh() {
    if (disposed) return;
    clearTimer(timer); const version = ++listVersion, selection = detailVersion;
    try {
      const value = await api('/api/seminars?limit=30');
      if (disposed || version !== listVersion) return;
      if (!Array.isArray(value.items)) throw new Error('研讨列表响应无效');
      state.items = value.items; state.running = value.running ?? null; state.error = '';
      state.active = Number.isInteger(value.active) ? value.active : value.items.filter(active).length;
      if (Number.isInteger(value.parallel) && value.parallel > 0) state.parallel = value.parallel;
      if (!selectedId && selection === detailVersion) selectedId = value.running?.seminarId || value.items[0]?.seminarId || null;
      const ids = new Set([...watched.keys(), ...value.items.filter(active).map(r => r.seminarId), selectedId, value.running?.seminarId].filter(Boolean));
      await Promise.all([...ids].map(async id => {
        const record = await read(id);
        if (disposed || version !== listVersion || selection !== detailVersion) return;
        remember(record); if (selectedId === id) state.selected = record;
      }));
    } catch (problem) { if (!disposed && version === listVersion && selection === detailVersion) state.error = `研讨读取失败：${problem.message}`; }
    finally { if (!disposed && version === listVersion) { emit(); schedule(); } }
  }
  async function obtain(id) { return state.selected?.seminarId === id ? state.selected : selectSeminar(id); }
  function validateInput(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 2000) throw new Error('请输入 1–2000 字的问题或概念');
    return input;
  }
  function members(ids) {
    if (!Array.isArray(ids) || ids.length < 3 || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('请选择 3–8 个不同的书籍 Agent');
    return ids.map(id => {
      const member = getRegistry()?.agents.find(a => a.id === id);
      if (!member || member.kind !== 'book' || !member.platforms?.codex?.available) throw new Error('所选参加者不存在、不是书籍 Agent 或 Codex 不可用');
      return structuredClone(member);
    });
  }
  function participantIds(record) {
    const ids = seminarParticipants(record, getRegistry()).map(a => a.id);
    if (!ids.length || ids.some(id => !id)) throw new Error('参加者身份未载明，无法预填');
    return ids;
  }
  async function submit(input, parentId, ids) {
    if (disposed || state.busy) return false;
    if (full()) { state.error = `最多同时进行 ${state.parallel} 场圆桌，请等其中一场结束`; emit(); return false; }
    state.busy = true; state.error = ''; emit();
    try {
      let flags = {};
      if (parentId) {
        const record = await obtain(parentId); if (disposed || !record) return false;
        if (active(record)) throw new Error('该研讨尚未完成');
        input = record.input;
        const selected = members(ids);
        flags = await confirmMembers(selected, 'codex', { confirm: text => disposed ? false : confirm(text), permissionText });
        if (!flags || disposed) return false;
        if (JSON.stringify(selected) !== JSON.stringify(members(ids))) throw new Error('Agent 信息已变化，请重新选择并确认');
      }
      validateInput(input);
      const value = await api('/api/seminars', { input, ...(parentId ? { agentIds: ids, parentId, ...flags } : {}) });
      if (disposed) return false;
      if (typeof value?.seminarId !== 'string' || !value.seminarId) throw new Error('研讨提交响应无效');
      listVersion++; detailVersion++; selectedId = value.seminarId;
      state.selected = null;
      state.running = { seminarId: selectedId, status: 'queued', createdAt: new Date().toISOString() }; state.active++;
      remember(state.running); onOpen(); await refresh(); return true;
    } catch (problem) {
      if (!disposed) {
        if (problem.status === 409) {
          listVersion++;
          if (Number.isInteger(problem.data?.active)) state.active = problem.data.active;
          if (Number.isInteger(problem.data?.parallel) && problem.data.parallel > 0) state.parallel = problem.data.parallel;
          if (problem.data?.running) state.running = problem.data.running;
          else await refresh();
        }
        state.error = problem.message;
      }
      return false;
    } finally { state.busy = false; emit(); schedule(); }
  }
  async function openSeminarAddPicker(id) {
    if (disposed || state.busy) return;
    try {
      const record = await obtain(id); if (disposed || !record) return;
      if (record.status !== 'done' || !record.result) throw new Error('研讨尚未生成成功');
      return await onPicker(structuredClone(record), participantIds(record));
    } catch (problem) { if (!disposed) { state.error = problem.message; emit(); } }
  }
  async function continueSeminarInJoint(id) {
    if (disposed || state.busy) return false;
    try {
      const record = await obtain(id); if (disposed || !record) return false;
      if (!record.result) throw new Error('暂无可继续的研讨结果');
      const ids = participantIds(record); members(ids);
      await onJoint({ agentIds: ids, input: validateInput(record.input), cli: 'codex' }); return true;
    } catch (problem) { if (!disposed) { state.error = problem.message; emit(); } return false; }
  }
  return { snapshot, refresh, selectSeminar, openSeminarAddPicker, continueSeminarInJoint,
    startSeminar: input => submit(input),
    rerunSeminar: (id, ids) => submit(null, id, Array.isArray(ids) ? [...ids] : ids),
    setInput(input) { if (!disposed && !state.busy) { state.input = String(input); emit(); } },
    async openSeminars() { if (!disposed) { onOpen(); await refresh(); } },
    dispose() { disposed = true; listVersion++; detailVersion++; clearTimer(timer); watched.clear(); } };
}
