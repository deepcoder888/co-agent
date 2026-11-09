import { confirmMembers } from './calls.js';
export { drawJointStatus as renderJointStatus } from './layouts/threepane.js';

// No document references: drafts, requests and selection survive every layout switch.
// v0.39: the joint CLI may also be 'inapp:claude' / 'inapp:codex', which answers the recommendation question in the app.
export const jointCliValues = ['claude', 'codex', 'inapp:claude', 'inapp:codex'];
export function createWorkflows({ api, confirm, error, permissionText, getRegistry, onChat, onState = () => {}, onChanged = async () => {} }) {
  const selection = new Set(), joints = new Map();
  let input = '', engine = 'codex', cli = 'codex', recommendation, busy = false, jointBusy = false;
  let disposed = false, generation = 0, recentGeneration = 0, timer, recent = [], settings = {};
  const snapshot = () => ({ input, engine, cli, recommendation, busy, jointBusy, selectedIds: [...selection], settings,
    recent: recent.map(r => ({ ...r, verification: joints.get(r.id)?.status })) });
  const emit = () => { if (!disposed) onState(snapshot()); };
  async function pollRecommendation(id, version) {
    try {
      const value = await api(`/api/recommend/${id}`);
      if (disposed || version !== generation) return;
      recommendation = value; busy = value.status === 'running'; emit();
      if (busy) timer = setTimeout(() => pollRecommendation(id, version), 1000);
      else await loadRecent();
    } catch (problem) { if (!disposed && version === generation) { busy = false; error(`推荐读取失败：${problem.message}`); emit(); } }
  }
  async function selectRecommendation(id) {
    clearTimeout(timer); selection.clear(); recommendation = undefined; busy = true;
    const version = ++generation; emit(); await pollRecommendation(id, version);
  }
  async function pollJoint(entry) {
    clearTimeout(entry.timer);
    try {
      const status = await api(`/api/joint/${entry.record.id}`);
      if (disposed || joints.get(entry.record.id) !== entry) return;
      entry.status = status; emit();
      if (status.overall === 'pending') entry.timer = setTimeout(() => pollJoint(entry), 2000);
    } catch (problem) { if (!disposed) error(`联合调用核验失败：${problem.message}`); }
  }
  async function loadRecent() {
    const version = ++recentGeneration;
    try {
      const value = await api('/api/recent'); if (disposed || version !== recentGeneration) return;
      recent = value.items;
      const present = new Set(recent.map(i => i.id));
      for (const [id, entry] of joints) if (!present.has(id)) { clearTimeout(entry.timer); joints.delete(id); }
      emit();
      for (const item of recent.filter(r => r.type !== 'recommend')) {
        const existing = joints.get(item.id);
        if (existing) existing.record = item;
        else { const entry = { record: item }; joints.set(item.id, entry); await pollJoint(entry); }
      }
    } catch (problem) { if (!disposed) error(`最近记录读取失败：${problem.message}`); }
  }
  async function recommend() {
    if (busy || !input.trim() || input.length > 8000) return;
    const body = { input, engine };
    error(''); clearTimeout(timer); selection.clear(); recommendation = undefined; busy = true;
    const version = ++generation; emit();
    try {
      const result = await api('/api/recommend', body);
      if (!disposed && version === generation) await pollRecommendation(result.recommendId, version);
    } catch (problem) { if (!disposed && version === generation) { busy = false; error(problem.message); emit(); } }
  }
  async function launchJoint() {
    if (!selection.size || busy || jointBusy || recommendation?.status !== 'done') return;
    if (cli.startsWith('inapp:') && onChat) {
      error(''); await onChat({ agentIds: [...selection], engine: cli.slice('inapp:'.length), question: recommendation.input || input }); return;
    }
    const body = { recommendId: recommendation.recommendId, agentIds: [...selection], cli };
    const members = body.agentIds.map(id => getRegistry().agents.find(a => a.id === id));
    jointBusy = true; emit(); error('');
    try {
      const flags = await confirmMembers(members, body.cli, { confirm, permissionText }); if (!flags || disposed) return;
      await api('/api/joint', { ...body, ...flags }); await loadRecent(); await onChanged();
    } catch (problem) { error(problem.message); }
    finally { jointBusy = false; emit(); }
  }
  return { snapshot, recommend, launchJoint, selectRecommendation, loadRecent,
    setInput(value) { input = String(value); emit(); },
    setEngine(value) { if (['claude', 'codex'].includes(value)) engine = value; emit(); },
    setCli(value) { if (!jointBusy && jointCliValues.includes(value)) cli = value; emit(); },
    select(id, checked) { if (!busy && !jointBusy && recommendation?.results?.some(r => r.id === id)) {
      if (checked && selection.size < 8) selection.add(id); else if (!checked) selection.delete(id); emit();
    } },
    selectAll(checked) { if (!busy && !jointBusy) { selection.clear(); if (checked) for (const a of (recommendation?.results || []).slice(0, 8)) selection.add(a.id); emit(); } },
    reverifyJoint(id) { const entry = joints.get(id); if (entry) return pollJoint(entry); },
    async initialize() { try { settings = await api('/api/settings'); emit(); } catch (problem) { error(`推荐设置读取失败：${problem.message}`); } await loadRecent(); },
    dispose() { disposed = true; generation++; recentGeneration++; clearTimeout(timer); for (const entry of joints.values()) clearTimeout(entry.timer); } };
}
