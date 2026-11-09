import { confirmMembers } from './calls.js';

const active = value => ['queued', 'running'].includes(value?.status);
const working = record => active(record) || record?.perspectives?.some(active);
// undefined means the first list has not loaded; a successful empty list sets null.
const emptyView = () => ({ today: undefined, items: [], selected: null, running: null, busy: false, error: '',
  threadOpen: false, threadItems: [], threadLoading: false, threadError: '' });
export function conceptInput(record) {
  const result = record.result;
  const input = `请从各自视角继续分析这个概念，并注明出处。\n概念：${result.concept}${result.conceptEn ? `（${result.conceptEn}）` : ''}\n一句话说明：${result.oneLine}\n原讲解：${record.agent.name} · 《${record.agent.title || record.agent.bookLabel || '未载明书名'}》\n\n${result.markdown}`;
  return input.length <= 8000 ? input : `${input.slice(0, 7960)}\n\n（原讲解过长，以上为节选。）`;
}
// State and requests only. API/timers/dialog callbacks are replaceable in tests.
export function createConcepts({ api, getRegistry, confirm, permissionText, onState = () => {}, onOpen = () => {},
  onPicker = () => {}, onJoint = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = emptyView(), disposed = false, timer, listVersion = 0, detailVersion = 0, threadVersion = 0, selectedId = null;
  const watched = new Map();
  const snapshot = () => structuredClone(state);
  const emit = () => { if (!disposed) onState(snapshot()); };
  function schedule() {
    clearTimer(timer); if (disposed) return;
    const running = state.running || state.items.some(working) || [...watched.values()].some(working);
    timer = setTimer(refresh, running ? 5000 : 60000);
  }
  function remember(record) {
    if (working(record)) watched.set(record.conceptId, record); else watched.delete(record.conceptId);
  }
  async function detail(id, version) {
    const record = await api(`/api/concepts/${encodeURIComponent(id)}`);
    if (disposed) return null;
    if (!record || record.conceptId !== id) throw new Error('概念详情响应无效');
    // An obsolete request must not replace a newer selection or running evidence.
    if (version !== detailVersion) return null;
    remember(record);
    if (selectedId === id) state.selected = record;
    return record;
  }
  async function selectConcept(id) {
    if (disposed || typeof id !== 'string' || !id) return null;
    selectedId = id; state.selected = null; state.error = ''; const version = ++detailVersion; emit();
    try { return await detail(id, version); }
    catch (problem) { if (!disposed && version === detailVersion) state.error = `概念读取失败：${problem.message}`; return null; }
    finally { if (!disposed && version === detailVersion) { emit(); schedule(); } }
  }
  async function openConceptResponse(id) {
    // Keep the current lecture and its snapshot visible if the original is gone.
    const version = ++detailVersion; state.error = '';
    try {
      const record = await api(`/api/concepts/${encodeURIComponent(id)}`);
      if (disposed || version !== detailVersion) return null;
      if (!record || record.conceptId !== id) throw Object.assign(new Error('原记录不存在'), { status: 404 });
      selectedId = id; state.selected = record; remember(record); return record;
    } catch (error) {
      if (!disposed && version === detailVersion) state.error = error.status === 404 ? '原记录不存在' : `概念读取失败：${error.message}`;
      return null;
    } finally { if (!disposed && version === detailVersion) { emit(); schedule(); } }
  }
  async function refreshThread() {
    const version = ++threadVersion; state.threadLoading = true; state.threadError = ''; emit();
    try {
      const value = await api('/api/concepts/thread?limit=30');
      if (disposed || version !== threadVersion) return;
      if (!Array.isArray(value.items)) throw new Error('对话线响应无效');
      state.threadItems = value.items;
    } catch (error) { if (!disposed && version === threadVersion) state.threadError = `对话线读取失败：${error.message}`; }
    finally { if (!disposed && version === threadVersion) { state.threadLoading = false; emit(); } }
  }
  async function toggleConceptThread() {
    state.threadOpen = !state.threadOpen; emit();
    if (state.threadOpen) await refreshThread();
  }
  async function refresh() {
    if (disposed) return; clearTimer(timer); const version = ++listVersion, selection = detailVersion;
    try {
      const value = await api('/api/concepts?limit=30');
      if (disposed || version !== listVersion) return;
      if (!Array.isArray(value.items)) throw new Error('概念列表响应无效');
      // Failed generations are not archived in the list (2026-10-15); today's failure stays selectable to show its reason.
      state.items = value.items.filter(item => item.status !== 'failed'); state.today = value.today ?? null; state.running = value.running ?? null; state.error = '';
      if (!selectedId && selection === detailVersion) selectedId = value.today?.conceptId || state.items[0]?.conceptId || null;
      const ids = new Set([...watched.keys(), ...(selectedId ? [selectedId] : [])]);
      await Promise.all([...ids].map(async id => {
        const record = await api(`/api/concepts/${encodeURIComponent(id)}`);
        if (disposed || version !== listVersion || selection !== detailVersion) return;
        if (!record || record.conceptId !== id) throw new Error('概念详情响应无效');
        remember(record); if (selectedId === id) state.selected = record;
      }));
      if (state.threadOpen) await refreshThread();
    } catch (problem) { if (!disposed && version === listVersion) state.error = `概念读取失败：${problem.message}`; }
    finally { if (!disposed && version === listVersion) { emit(); schedule(); } }
  }
  async function nextConcept() {
    if (disposed || state.busy || state.running) return false;
    state.busy = true; state.error = ''; emit();
    try {
      const value = await api('/api/concepts', { kind: 'manual' }); if (disposed) return false;
      listVersion++; detailVersion++;
      state.running = { conceptId: value.conceptId, kind: 'manual', startedAt: new Date().toISOString() };
      onOpen(); await selectConcept(value.conceptId); await refresh(); return true;
    } catch (problem) {
      if (!disposed) {
        state.error = problem.message;
        if (problem.status === 409 && problem.data?.running) { listVersion++; state.running = problem.data.running; }
      }
      return false;
    } finally { state.busy = false; emit(); schedule(); }
  }
  async function obtain(id) { return state.selected?.conceptId === id ? state.selected : selectConcept(id); }
  function members(record, ids, allowEmpty = false) {
    if (!Array.isArray(ids) || ids.length > 8 || (!allowEmpty && !ids.length) || new Set(ids).size !== ids.length) throw new Error('请选择 1–8 个不同的 Agent');
    return ids.map(id => {
      const member = getRegistry()?.agents.find(a => a.id === id);
      if (!member || id === record.agent.id || !member.platforms?.codex?.available) throw new Error('所选 Agent 不存在、Codex 不可用或是原讲解 Agent');
      return structuredClone(member);
    });
  }
  async function runPerspectives(id, agentIds) {
    if (disposed || state.busy) return false;
    const ids = Array.isArray(agentIds) ? [...agentIds] : agentIds;
    state.busy = true; state.error = ''; emit();
    try {
      const record = await obtain(id); if (disposed || !record) return false;
      if (record.status !== 'done' || !record.result) throw new Error('概念尚未生成成功');
      if (record.perspectives?.some(active)) throw new Error('此概念正在进行多视角分析');
      const selected = members(record, ids), flags = await confirmMembers(selected, 'codex', { confirm, permissionText });
      if (!flags || disposed) return false;
      // Catalog refresh while a confirmation is open must not authorize a changed member.
      const current = members(record, ids);
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw new Error('Agent 信息已变化，请重新选择并确认');
      const value = await api(`/api/concepts/${encodeURIComponent(id)}/perspectives`, { agentIds: ids, ...flags });
      if (disposed) return false;
      listVersion++; detailVersion++;
      const pending = { ...record, perspectives: [...(record.perspectives || []), { runId: value.runId, status: 'queued',
        createdAt: new Date().toISOString(), agents: selected.map(a => ({ id: a.id, name: a.name })), results: [] }] };
      remember(pending); if (selectedId === id) state.selected = pending;
      return true;
    } catch (problem) { if (!disposed) state.error = problem.message; return false; }
    finally { state.busy = false; emit(); schedule(); }
  }
  async function openPerspectivePicker(id) {
    if (disposed || state.busy) return;
    const record = await obtain(id);
    if (disposed || !record) return;
    if (record.status !== 'done' || !record.result) { state.error = '概念尚未生成成功'; emit(); return; }
    return onPicker(structuredClone(record));
  }
  async function continueInJoint(id, agentIds) {
    if (disposed || state.busy) return false;
    try {
      const record = await obtain(id); if (disposed || !record) return false;
      if (!record.result) throw new Error('暂无可继续分析的概念正文');
      const ids = agentIds ?? record.perspectives?.at(-1)?.agents?.map(a => a.id) ?? [];
      members(record, ids, true);
      await onJoint({ agentIds: [...ids], input: conceptInput(record), cli: 'codex' }); return true;
    } catch (problem) { if (!disposed) { state.error = problem.message; emit(); } return false; }
  }
  return { snapshot, refresh, selectConcept, openConceptResponse, toggleConceptThread, refreshThread, nextConcept, openPerspectivePicker, runPerspectives, continueInJoint,
    async openConcepts() { if (!disposed) { onOpen(); await refresh(); } },
    dispose() { disposed = true; listVersion++; detailVersion++; threadVersion++; clearTimer(timer); watched.clear(); } };
}
