import { manageDialog } from './accessibility.js';
import { node, action, confirmMembers } from './calls.js';
import { avatarColor, avatarLetter, setStyle } from './display.js';

// v0.14 调用组: saved, named joint-call groups with a default CLI and reusable preset questions.
// The model owns API calls and state; layouts only render GroupsView and call actions.
export const GROUP_LIMITS = Object.freeze({ name: 40, title: 40, text: 8000, presets: 30 });

export function createGroups({ api, getRegistry, confirm, permissionText, onState = () => {}, onChanged = async () => {}, onOpen = () => {}, notify = () => {} }) {
  let groups = [], loaded = false, loading = false, error = '', selectedId = null, busy = false, disposed = false;
  const emit = () => { if (!disposed) onState(); };
  const member = id => getRegistry()?.agents.find(a => a.id === id) || { id, name: `${id}（已移除）`, missing: true, platforms: {} };
  function view(group) {
    const members = group.agentIds.map(member);
    return { ...group, members: members.map(a => ({ id: a.id, name: a.name, kind: a.kind, missing: !!a.missing, avatarColor: avatarColor(a.id), avatarLetter: avatarLetter(a.name) })),
      presets: [...group.presets], memberNames: members.map(a => a.name).join('、') };
  }
  async function load() {
    loading = true; error = ''; emit();
    try { const value = await api('/api/groups'); if (disposed) return; groups = Array.isArray(value.groups) ? value.groups : []; loaded = true;
      if (selectedId && !groups.some(g => g.id === selectedId)) selectedId = null; if (!selectedId) selectedId = groups[0]?.id || null; }
    catch (problem) { error = `调用组读取失败：${problem.message}`; }
    finally { loading = false; emit(); }
  }
  const replace = group => { const i = groups.findIndex(g => g.id === group.id); if (i < 0) groups.push(group); else groups[i] = group; };
  async function guarded(work) {
    if (busy) return null; busy = true; error = ''; emit();
    try { return await work(); }
    catch (problem) { error = problem.message; throw problem; }
    finally { busy = false; emit(); }
  }
  return {
    load,
    snapshot() {
      const list = [...groups].sort((a, b) => (Date.parse(b.lastRunAt || b.updatedAt) || 0) - (Date.parse(a.lastRunAt || a.updatedAt) || 0)).map(view);
      return { loaded, loading, busy, error, selectedId, groups: list, selected: list.find(g => g.id === selectedId) || null };
    },
    async open() { onOpen(); if (!loaded) await load(); else emit(); },
    select(id) { if (groups.some(g => g.id === id)) { selectedId = id; emit(); } },
    get(id) { const group = groups.find(g => g.id === id); return group ? view(group) : null; },
    async create({ name, agentIds, cli, question }) {
      return guarded(async () => {
        const presets = question?.trim() ? [{ text: question, title: '' }] : [];
        const group = await api('/api/groups', { name, agentIds, cli, presets }, 'POST');
        replace(group); selectedId = group.id; loaded = true; notify(`已保存调用组「${group.name}」`); return group;
      });
    },
    async update(id, patch) {
      return guarded(async () => { const group = await api(`/api/groups/${id}`, patch, 'PUT'); replace(group); notify(`已更新调用组「${group.name}」`); return group; });
    },
    async remove(id, trigger) {
      const group = groups.find(g => g.id === id); if (!group || busy) return false;
      const ok = await confirm(`删除调用组「${group.name}」？\n它的 ${group.presets.length} 个预设问题会一起删除；已经运行过的记录仍保留在「历史调用」里。`, trigger, { title: '删除调用组', accept: '删除', danger: true });
      if (!ok || disposed) return false;
      await guarded(async () => { await api(`/api/groups/${id}`, undefined, 'DELETE'); groups = groups.filter(g => g.id !== id);
        if (selectedId === id) selectedId = groups[0]?.id || null; notify(`已删除调用组「${group.name}」`); });
      return true;
    },
    async addPreset(id, preset) {
      return guarded(async () => { const value = await api(`/api/groups/${id}/presets`, preset, 'POST'); const g = groups.find(x => x.id === id); g?.presets.push(value); return value; });
    },
    async updatePreset(id, presetId, preset) {
      return guarded(async () => { const value = await api(`/api/groups/${id}/presets/${presetId}`, preset, 'PUT'); const g = groups.find(x => x.id === id);
        if (g) g.presets = g.presets.map(p => p.id === presetId ? value : p); return value; });
    },
    async removePreset(id, presetId, trigger) {
      const g = groups.find(x => x.id === id), preset = g?.presets.find(p => p.id === presetId); if (!preset || busy) return false;
      if (!await confirm(`删除预设问题「${preset.title || preset.text.slice(0, 30)}」？`, trigger, { title: '删除预设问题', accept: '删除', danger: true }) || disposed) return false;
      await guarded(async () => { await api(`/api/groups/${id}/presets/${presetId}`, undefined, 'DELETE'); g.presets = g.presets.filter(p => p.id !== presetId); });
      return true;
    },
    // Confirms writable/missing-source members client-side (same wording as the builder); the server re-checks.
    async run(id, { input, cli, savePreset = false, presetTitle = '', crossExam = false }) {
      const group = groups.find(g => g.id === id); if (!group) throw new Error('调用组不存在');
      return guarded(async () => {
        const flags = await confirmMembers(group.agentIds.map(member), cli, { confirm, permissionText });
        if (!flags) return null;
        const value = await api(`/api/groups/${id}/run`, { input, cli, savePreset, presetTitle, crossExam: crossExam === true, ...flags }, 'POST');
        replace({ ...group, runCount: (group.runCount || 0) + 1, lastRunAt: new Date().toISOString(), presets: value.preset ? [...group.presets, value.preset] : group.presets });
        notify(value.presetError ? `已发起联合调用；预设未保存：${value.presetError}` : `已向「${group.name}」发起联合调用${value.preset ? '，并保存为预设' : ''}`);
        await onChanged(); return value;
      });
    },
    dispose() { disposed = true; },
  };
}

// The 提问 dialog: preset list (fill / edit / delete), a question box, optional 保存为预设, CLI override, then 运行.
export function mountGroupAsk(doc, { groups, onChat, getSkin = () => '' }) {
  const dialog = node(doc, 'dialog', undefined, 'builder-dialog group-ask-dialog'); dialog.id = 'group-ask';
  const title = node(doc, 'h2', '调用组'); title.id = 'group-ask-title';
  const eyebrow = node(doc, 'p', '向调用组提问', 'group-ask-eyebrow');
  const close = action(doc, '关闭', () => controller.close(), '关闭提问窗口'); close.id = 'group-ask-close';
  const members = node(doc, 'div', undefined, 'group-members'); members.setAttribute('aria-label', '成员');
  const presetTitle = node(doc, 'h3', '预设问题'); presetTitle.id = 'group-ask-presets-title';
  const presets = node(doc, 'ul', undefined, 'group-presets'); presets.setAttribute('aria-labelledby', presetTitle.id);
  const label = node(doc, 'label', '问题'); label.setAttribute('for', 'group-ask-input');
  const input = node(doc, 'textarea'); input.id = 'group-ask-input'; input.rows = 5; input.maxLength = 8000;
  input.setAttribute('placeholder', '写下这次要问这组 Agent 的问题，或点上面的预设问题填入');
  const count = node(doc, 'p', '0 / 8000 字', 'group-ask-count');
  const save = node(doc, 'input'); save.type = 'checkbox'; save.id = 'group-ask-save';
  const saveLabel = node(doc, 'label', undefined, 'group-ask-save'); saveLabel.append(save, node(doc, 'span', '保存为预设问题'));
  const saveTitle = node(doc, 'input'); saveTitle.id = 'group-ask-preset-title'; saveTitle.maxLength = 40; saveTitle.setAttribute('placeholder', '预设标题（可选）'); saveTitle.hidden = true;
  saveTitle.setAttribute('aria-label', '预设标题（可选）');
  // v0.24 (2026-10-16): the same optional cross-examination round as 新建联合调用; off by default.
  const crossExam = node(doc, 'input'); crossExam.type = 'checkbox'; crossExam.id = 'group-ask-cross-exam';
  const crossExamLabel = node(doc, 'label', undefined, 'group-ask-save group-ask-cross-exam'); crossExamLabel.id = 'group-ask-cross-exam-label';
  crossExamLabel.title = '首轮之后，每个 Agent 再回应其他 Agent 的论点；多一轮，更慢';
  crossExamLabel.append(crossExam, node(doc, 'span', '交叉质询（多一轮，更慢）'));
  const cli = node(doc, 'select'); cli.id = 'group-ask-cli'; cli.setAttribute('aria-label', '本次使用的 CLI');
  for (const [value, text] of [['codex', 'Codex'], ['claude', 'Claude']]) { const option = node(doc, 'option', text); option.value = value; cli.append(option); }
  const cliText = node(doc, 'span', '本次用 '), cliLabel = node(doc, 'label'); cliLabel.append(cliText, cli);
  // v0.39: 在 CO-AGENT 中 answers inside the app; the CLI select then picks the answering engine.
  const place = node(doc, 'select'); place.id = 'group-ask-place'; place.setAttribute('aria-label', '运行位置');
  for (const [value, text] of [['terminal', '各自的终端窗口'], ['inapp', '在 CO-AGENT 中']]) { const option = node(doc, 'option', text); option.value = value; place.append(option); }
  const placeLabel = node(doc, 'label', '运行位置 '); placeLabel.append(place); placeLabel.hidden = !onChat;
  const inApp = () => !!onChat && place.value === 'inapp';
  const run = action(doc, '运行', () => submit(), '运行这次联合调用'); run.id = 'group-ask-run'; run.className = 'primary';
  const cancel = action(doc, '取消', () => controller.close()); cancel.id = 'group-ask-cancel';
  const status = node(doc, 'p', '', 'group-ask-status'); status.id = 'group-ask-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const heading = node(doc, 'div', undefined, 'drawer-heading'); const headText = node(doc, 'div'); headText.append(eyebrow, title); heading.append(headText, close);
  const options = node(doc, 'div', undefined, 'group-ask-options'); options.append(saveLabel, saveTitle, crossExamLabel);
  const actions = node(doc, 'div', undefined, 'workflow-actions group-ask-actions'); actions.append(placeLabel, cliLabel, cancel, run);
  dialog.append(heading, members, presetTitle, presets, label, input, count, options, actions, status);
  doc.body.append(dialog);
  const controller = manageDialog(doc, dialog, { labelledby: title.id, initialFocus: input });
  let groupId = null, editing = null, submitting = false;

  function controls() {
    const group = groups.get(groupId), text = input.value;
    count.textContent = `${Array.from(text).length} / 8000 字`;
    saveTitle.hidden = !save.checked;
    const full = (group?.presets.length || 0) >= GROUP_LIMITS.presets;
    save.disabled = submitting || full; if (full) save.checked = false;
    saveLabel.title = full ? `每组最多 ${GROUP_LIMITS.presets} 个预设问题` : '';
    run.disabled = submitting || !text.trim() || Array.from(text).length > 8000 || !group;
    run.textContent = submitting ? '正在启动…' : '运行';
    input.disabled = cli.disabled = place.disabled = submitting; crossExam.disabled = submitting || inApp();
    if (inApp()) crossExam.checked = false; cliText.textContent = inApp() ? '回答用 ' : '本次用 ';
  }
  function presetRow(group, preset) {
    const li = node(doc, 'li', undefined, 'group-preset');
    if (editing === preset.id) {
      const t = node(doc, 'input'); t.value = preset.title; t.maxLength = 40; t.setAttribute('aria-label', '预设标题'); t.setAttribute('placeholder', '标题（可选）');
      const body = node(doc, 'textarea'); body.value = preset.text; body.rows = 3; body.maxLength = 8000; body.setAttribute('aria-label', '预设问题内容');
      const ok = action(doc, '保存', async () => {
        if (!body.value.trim()) { status.textContent = '预设问题不能为空'; body.focus(); return; }
        try { await groups.updatePreset(group.id, preset.id, { title: t.value, text: body.value }); editing = null; render(); status.textContent = '已更新预设问题'; }
        catch (problem) { status.textContent = problem.message; }
      }, '保存预设问题'); ok.className = 'primary';
      const back = action(doc, '取消', () => { editing = null; render(); }, '取消编辑预设问题');
      const row = node(doc, 'div', undefined, 'group-preset-edit-actions'); row.append(back, ok);
      li.className = 'group-preset editing'; li.append(t, body, row); queueMicrotask(() => body.focus?.()); return li;
    }
    const use = action(doc, '', () => { input.value = preset.text; controls(); input.focus(); status.textContent = `已填入预设「${preset.title || '未命名'}」，可以修改后再运行`; },
      `使用预设问题：${preset.title || preset.text.slice(0, 40)}`);
    use.className = 'group-preset-use';
    if (preset.title) use.append(node(doc, 'strong', preset.title));
    use.append(node(doc, 'span', preset.text, 'group-preset-text'));
    const edit = action(doc, '编辑', () => { editing = preset.id; render(); }, `编辑预设问题 ${preset.title || ''}`.trim());
    const remove = action(doc, '删除', async event => { if (await groups.removePreset(group.id, preset.id, event.currentTarget)) render(); }, `删除预设问题 ${preset.title || ''}`.trim());
    edit.className = remove.className = 'group-preset-tool';
    li.append(use, edit, remove); return li;
  }
  function render() {
    const group = groups.get(groupId); if (!group) return;
    dialog.className = `builder-dialog group-ask-dialog ${getSkin()}`.trim();
    title.textContent = group.name;
    members.replaceChildren(...group.members.map(m => {
      const chip = node(doc, 'span', undefined, `group-member${m.missing ? ' missing' : ''}`);
      const avatar = node(doc, 'span', m.avatarLetter, 'builder-avatar'); avatar.setAttribute('aria-hidden', 'true'); setStyle(avatar, { backgroundColor: m.avatarColor });
      chip.append(avatar, node(doc, 'span', m.name)); return chip;
    }));
    presets.replaceChildren(...(group.presets.length ? group.presets.map(p => presetRow(group, p))
      : [node(doc, 'li', '还没有预设问题。写好下面的问题后勾选「保存为预设问题」，以后点一下就能复用。', 'group-presets-empty')]));
    controls();
  }
  async function submit() {
    const group = groups.get(groupId); if (!group || submitting || !input.value.trim()) return;
    submitting = true; status.textContent = '正在检查并启动…'; controls();
    try {
      if (inApp()) {
        // The preset is saved first; a failed save does not stop the question.
        if (save.checked) await groups.addPreset(groupId, { title: saveTitle.value, text: input.value }).catch(problem => { status.textContent = `预设未保存：${problem.message}`; });
        const options = { agentIds: group.agentIds, engine: cli.value, question: input.value, groupId };
        input.value = ''; save.checked = false; saveTitle.value = ''; controller.close(); await onChat(options); return;
      }
      const result = await groups.run(groupId, { input: input.value, cli: cli.value, savePreset: save.checked, presetTitle: saveTitle.value, crossExam: crossExam.checked === true });
      if (!result) { status.textContent = '已取消运行。'; return; }
      input.value = ''; save.checked = false; saveTitle.value = ''; crossExam.checked = false; controller.close();
    } catch (problem) { status.textContent = problem.message; }
    finally { submitting = false; if (dialog.open) render(); }
  }
  input.addEventListener('input', controls); place.addEventListener('change', controls); save.addEventListener('change', () => { controls(); if (save.checked) saveTitle.focus(); });
  dialog.addEventListener('close', () => { editing = null; });
  return {
    open(id, trigger, prefill) {
      const group = groups.get(id); if (!group) return false;
      if (groupId !== id) { input.value = ''; save.checked = false; saveTitle.value = ''; crossExam.checked = false; }
      if (typeof prefill === 'string') input.value = prefill;
      groupId = id; editing = null; cli.value = group.cli; status.textContent = ''; render();
      if (!dialog.open) controller.open(trigger); return true;
    },
    refresh() { if (dialog.open) render(); },
    close() { if (dialog.open) controller.close(); },
    dispose() { if (dialog.open) dialog.close(); dialog.remove(); },
  };
}
