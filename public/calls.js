import { markAgentLink } from './agent-links.js';
import { manageDialog } from './accessibility.js';
import { avatarColor, avatarLetter, bookLabel, authorShort, setStyle, summary, cleanTitle, missingSourcesFor, readingQuote, accessLabel } from './display.js';

export function node(doc, tag, text, className) {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export function action(doc, text, callback, label = text) {
  const el = node(doc, 'button', text); el.type = 'button';
  el.setAttribute('aria-label', label); el.addEventListener('click', callback); return el;
}

export async function confirmMembers(members, cli, { confirm, permissionText }) {
  const unavailable = members.filter(a => !a?.platforms[cli]?.available);
  if (unavailable.length) throw new Error(`所选 CLI 不可用：${unavailable.map(a => `${a?.name || '已移除的 Agent'}：${a?.platforms[cli]?.reason || '入口不可用'}`).join('；')}`);
  const writable = members.filter(a => a.writable), missing = members.filter(a => missingSourcesFor(a, cli).length);
  if (writable.length && !await confirm(`以下 Agent 可写或权限未声明，请确认后执行：\n${writable.map(a => `${a.name}\n${permissionText(a)}`).join('\n\n')}`)) return null;
  if (missing.length && !await confirm(`原书路径失效，请确认后执行：\n${missing.map(a => `${a.name}：${missingSourcesFor(a, cli).join('；')}`).join('\n')}`)) return null;
  return { ...(writable.length ? { writableConfirmed: true } : {}), ...(missing.length ? { sourcesConfirmed: true } : {}) };
}

export function mountJointBuilder(doc, { api, getRegistry, matchesSearch, confirm, permissionText, onChat, onChanged = async () => {}, onSelection = () => {}, onSaveGroup, onUpdateGroup, getCategoryOrder = () => null }) {
  const get = id => doc.getElementById(id), dialog = get('joint-builder'); if (!dialog) return;
  const search = get('builder-search'), input = get('builder-input'), cli = get('builder-cli'), submit = get('builder-submit');
  const crossExam = get('builder-cross-exam'); // v0.24: optional cross-examination round, off by default
  // v0.39: 在 CO-AGENT 中 runs every member in the app; the CLI select then picks the answering engine.
  const place = get('builder-place'), cliLabel = get('builder-cli-label');
  const inApp = () => place?.value === 'inapp' && !!onChat;
  // v0.14: the builder creates/edits a saved 调用组; 只运行一次 keeps the original one-off manual joint.
  const name = get('builder-name'), save = get('builder-save'), saveRun = get('builder-save-run');
  const selected = new Set(), controller = manageDialog(doc, dialog, { labelledby: 'builder-title', initialFocus: search });
  let busy = false, editId = null;
  const names = () => [...selected].map(id => getRegistry()?.agents.find(a => a.id === id) || { id, name: `${id}（已移除）` });
  function identity(a) {
    const avatar = node(doc, 'span', avatarLetter(a.name), 'builder-avatar');
    avatar.setAttribute('aria-hidden', 'true'); setStyle(avatar, {backgroundColor:avatarColor(a.id)});
    const text = markAgentLink(node(doc, 'span', undefined, 'builder-identity'), a); text.append(node(doc, 'strong', a.name));
    const subtitle = a.kind === 'book' ? bookLabel(a) : a.purpose || summary(a.description);
    if (subtitle) { const line = node(doc, 'span', subtitle, 'muted builder-subtitle'); line.setAttribute('title', subtitle); if(a.kind==='book')markAgentLink(line,a); text.append(line); }
    if (a.kind === 'book' && a.book?.author) {
      const author = node(doc, 'span', authorShort(a), 'muted builder-author'); author.setAttribute('title', a.book.author); text.append(author);
    }
    return {avatar, text};
  }
  function chips(target, tray = false) {
    if (!target) return; target.replaceChildren();
    for (const a of names()) {
      const chip = node(doc, 'span', undefined, tray && a.kind === 'book' ? 'desk-book' : 'selection-chip');
      const remove = action(doc, '', () => { if (!busy) { selected.delete(a.id); render(); (get('builder-selected').querySelector('button') || search).focus(); } }, `移除 ${a.name}`);
      const {avatar, text} = identity(a), cross = node(doc, 'span', '×', 'builder-remove'); cross.setAttribute('aria-hidden', 'true');
      markAgentLink(remove,a); remove.append(avatar, text, cross);
      remove.disabled = busy; chip.append(remove); target.append(chip);
    }
    if (!selected.size) target.append(node(doc, 'span', tray ? readingQuote : '尚未选择 Agent', 'muted'));
  }
  function controls() {
    get('builder-count').textContent = `${input.value.length} / 8000 字`;
    const question = !!input.value.trim() && input.value.length <= 8000, named = !!name?.value.trim();
    submit.disabled = busy || !selected.size || !question;
    if (save) { save.disabled = busy || !selected.size || !named || !onSaveGroup; save.textContent = editId ? '保存修改' : '保存调用组'; }
    if (saveRun) saveRun.disabled = busy || !selected.size || !named || !question || !onSaveGroup;
    // Edit mode only changes name/members/CLI; questions are managed in the 提问 dialog.
    get('builder-question').hidden = !!editId; submit.hidden = !!editId; if (saveRun) saveRun.hidden = !!editId;
    if (crossExam) { crossExam.disabled = busy || inApp(); get('builder-cross-exam-label').hidden = !!editId; }
    if (place) { place.disabled = busy; place.closest('label').hidden = !!editId; }
    get('builder-title').textContent = editId ? '编辑调用组' : '新建联合调用';
    input.disabled = busy; cli.disabled = busy; if (name) name.disabled = busy;
    get('builder-limit').textContent = `已选 ${selected.size} / 8 个${selected.size >= 8 ? '，已达上限；先移除一个再添加。' : '，最多选择 8 个。'}`;
  }
  function render() {
    chips(get('builder-selected')); controls(); onSelection([...selected]);
    const results = get('builder-results'); results.replaceChildren();
    const registry = getRegistry(), agents = (registry?.agents || []).filter(a => matchesSearch(a, search.value));
    const row = a => {
      const label = node(doc, 'label', undefined, 'builder-row'), check = node(doc, 'input'); check.type = 'checkbox';
      check.checked = selected.has(a.id); check.disabled = busy || (!check.checked && selected.size >= 8);
      check.setAttribute('aria-label', `选择 ${a.name}`); check.setAttribute('aria-describedby', 'builder-limit');
      check.addEventListener('change', () => {
        if (busy || (check.checked && selected.size >= 8)) { check.checked = selected.has(a.id); return; }
        if (check.checked) selected.add(a.id); else selected.delete(a.id); render();
        Array.from(results.querySelectorAll('input')).find(n => n.getAttribute('aria-label') === `选择 ${a.name}`)?.focus();
      });
      const {avatar, text} = identity(a);
      const issues = [!a.platforms[cli.value]?.available ? `不可用：${a.platforms[cli.value]?.reason || '入口不可用'}` : '', a.writable ? `${accessLabel(a)}，执行前需确认` : '', missingSourcesFor(a, cli.value).length ? '原书路径失效，执行前需确认' : ''].filter(Boolean);
      if (issues.length) text.append(node(doc, 'span', issues.join(' · '), 'reason'));
      label.append(check, avatar, text); return label;
    };
    // Grouped like the shelf: staff first, then the layout's (else the registry's) category order, then 未分类 (2026-10-15).
    const order = ['功能性 Agent', ...(getCategoryOrder() || registry?.categories || [])], groups = new Map();
    for (const a of agents) {
      const key = a.kind === 'role' ? '功能性 Agent' : a.primary || '未分类';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const rank = key => { const i = order.indexOf(key); return i < 0 ? order.length : i; };
    for (const [name, members] of [...groups].sort((left, right) => rank(left[0]) - rank(right[0]))) {
      const group = node(doc, 'div', undefined, 'builder-group'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
      group.append(node(doc, 'h4', `${name} · ${members.length}`, 'builder-group-title'), ...members.map(row));
      results.append(group);
    }
    if (!agents.length) results.append(node(doc, 'p', '没有匹配的 Agent'));
  }
  const open = (trigger, prefillIds, prefill) => {
    if (busy && prefill) return false;
    if (!busy && editId) { editId = null; if (name) name.value = ''; }
    if (!busy && Array.isArray(prefillIds)) {
      selected.clear();
      for (const id of prefillIds.slice(0, 8)) if (getRegistry()?.agents.some(a => a.id === id)) selected.add(id);
    }
    if (prefill) {
      input.value = String(prefill.input ?? '');
      if (['claude', 'codex'].includes(prefill.cli)) cli.value = prefill.cli;
      search.value = ''; get('builder-status').textContent = '';
    }
    render(); if (!dialog.open) controller.open(trigger);
    return true;
  };
  const add = (agent, trigger, show = true) => {
    if (busy) return;
    if (!selected.has(agent.id) && selected.size >= 8) get('builder-status').textContent = '最多选择 8 个，请先移除一个。';
    else selected.add(agent.id);
    render(); if (show) open(trigger);
  };
  search.addEventListener('input', render); input.addEventListener('input', controls); cli.addEventListener('change', render);
  place?.addEventListener('change', () => { if (cliLabel) cliLabel.textContent = inApp() ? '回答引擎' : '默认 CLI'; if (crossExam) { crossExam.disabled = inApp(); if (inApp()) crossExam.checked = false; } render(); }); name?.addEventListener('input', controls);
  async function saveGroup(run) {
    if (busy || !selected.size || !name.value.trim() || (run && !input.value.trim())) return;
    busy = true; render(); get('builder-status').textContent = editId ? '正在保存修改…' : '正在保存调用组…';
    try {
      if (editId) await onUpdateGroup(editId, { name: name.value, agentIds: [...selected], cli: cli.value });
      else await onSaveGroup({ name: name.value, agentIds: [...selected], cli: cli.value, question: input.value, run, crossExam: run && !inApp() && crossExam?.checked === true, inApp: inApp() });
      get('builder-status').textContent = ''; name.value = ''; input.value = ''; selected.clear(); editId = null; if (crossExam) crossExam.checked = false;
      controller.close();
    } catch (error) { get('builder-status').textContent = error.message; }
    finally { busy = false; render(); }
  }
  save?.addEventListener('click', () => saveGroup(false)); saveRun?.addEventListener('click', () => saveGroup(true));
  get('builder-close').addEventListener('click', () => controller.close());
  submit.addEventListener('click', async () => {
    if (busy || !selected.size || !input.value.trim() || input.value.length > 8000) return;
    if (inApp()) {
      const options = { agentIds: [...selected], engine: cli.value, question: input.value };
      input.value = ''; controller.close(); await onChat(options); return;
    }
    const body = { source: 'manual', agentIds: [...selected], input: input.value, cli: cli.value, crossExam: crossExam?.checked === true };
    busy = true; render(); get('builder-status').textContent = '正在检查并启动…';
    try {
      const flags = await confirmMembers(names(), body.cli, { confirm, permissionText });
      if (!flags) { get('builder-status').textContent = '已取消执行。'; return; }
      await api('/api/joint', { ...body, ...flags });
      get('builder-status').textContent = '已发起联合调用，核验结果见运行中与最近记录。'; if (crossExam) crossExam.checked = false;
      controller.close(); await onChanged();
    } catch (error) { get('builder-status').textContent = error.message; }
    finally { busy = false; render(); }
  });
  render(); return { open, add, remove(id) { if (!busy) { selected.delete(id); render(); } }, refresh: render, get selected() { return [...selected]; },
    edit(group, trigger) {
      if (busy) return false; editId = group.id; name.value = group.name; cli.value = group.cli; selected.clear();
      for (const id of group.agentIds) selected.add(id); search.value = ''; get('builder-status').textContent = '';
      render(); if (!dialog.open) controller.open(trigger); return true;
    } };
}

// Shared dialog, styled through the current layout's jointBuilderSkin and public CSS.
// Recommendation jobs use the existing asynchronous /api/recommend contract.
export function mountPerspectivePicker(doc, { api, getRegistry, onRun, onContinue, mode = 'perspective',
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const seminar = mode === 'seminar', prefix = seminar ? 'seminar' : 'perspective';
  const dialog = node(doc, 'dialog', undefined, `builder-dialog perspective-dialog${seminar ? ' seminar-dialog' : ''}`); dialog.id = `${prefix}-picker`;
  const field = (tag, id, text) => { const el = node(doc, tag, text); el.id = id.replace('perspective', prefix); return el; };
  const search = field('input', 'perspective-search'); search.type = 'search'; search.setAttribute('aria-label', seminar ? '搜索研讨书籍 Agent' : '搜索多视角 Agent');
  search.setAttribute('placeholder', '搜索名字、书名或用途');
  const title = field('h2', 'perspective-title', seminar ? '加人重跑研讨' : '多视角分析'), count = field('p', 'perspective-count'), status = field('p', 'perspective-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); count.setAttribute('aria-live', 'polite');
  const recommended = field('section', 'perspective-recommend'), all = field('section', 'perspective-all');
  recommended.setAttribute('aria-label', '推荐'); all.setAttribute('aria-label', '全部');
  const submit = action(doc, seminar ? '加人重跑' : '开始多视角分析', () => execute(false)), terminal = action(doc, '在终端中继续', () => execute(true));
  submit.id = `${prefix}-submit`; terminal.id = `${prefix}-continue`; terminal.hidden = seminar; recommended.hidden = seminar;
  const close = action(doc, '关闭', () => controller.close(), seminar ? '关闭研讨选择器' : '关闭多视角选择器'); close.id = `${prefix}-close`;
  const header = node(doc, 'div', undefined, 'drawer-heading'); header.append(title, close);
  const actions = node(doc, 'div', undefined, 'workflow-actions'); actions.append(submit, terminal);
  dialog.append(header, search, count, recommended, all, status, actions); doc.body.append(dialog);
  const controller = manageDialog(doc, dialog, { labelledby: title.id, initialFocus: search });
  const selected = new Set(); let record, recommendation, loading = false, busy = false, disposed = false, generation = 0, timer, message = '';
  const eligible = () => {
    const agents = (getRegistry()?.agents || []).filter(a => seminar ? a.kind === 'book' : a.id !== record?.agent?.id && a.platforms?.codex?.available);
    if (seminar) for (const id of selected) if (!agents.some(a => a.id === id)) {
      const original = record.result?.selected?.find(a => a.id === id);
      agents.push({id,kind:'book',name:original?.name || id,book:{title:original?.bookLabel || '未载明书名'},platforms:{codex:{available:false,reason:'参加者已移除或不再是书籍 Agent'}}});
    }
    return agents;
  };
  const label = a => {
    const book = cleanTitle(a.book?.title);
    return `${a.name} · ${a.kind === 'book' ? `《${book.text || '未载明书名'}》${book.multi > 1 ? ` 等 ${book.multi} 本` : ''}` : a.purpose || summary(a.description) || '用途未载明'}`;
  };
  function render() {
    if (disposed || !record) return;
    const focus = doc.activeElement, focusId = focus?.getAttribute?.('data-agent-id'), inRecommendations = !!recommended.contains(focus);
    const agents = eligible(), query = search.value.trim().toLocaleLowerCase();
    const matches = a => [label(a), a.primary, a.book?.author, a.description].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
    function row(a, reason) {
      const row = node(doc, 'label', undefined, 'builder-row'), check = node(doc, 'input'); check.type = 'checkbox';
      check.setAttribute('data-agent-id', a.id); check.setAttribute('aria-label', `选择 ${label(a)}`); check.setAttribute('aria-describedby', count.id);
      check.checked = selected.has(a.id); check.disabled = busy || (!check.checked && (selected.size >= 8 || !a.platforms?.codex?.available));
      check.addEventListener('change', () => {
        if (busy || (!selected.has(a.id) && (selected.size >= 8 || !a.platforms?.codex?.available))) { check.checked = selected.has(a.id); return; }
        if (check.checked) selected.add(a.id); else selected.delete(a.id); check.focus(); render();
      });
      const avatar = node(doc, 'span', avatarLetter(a.name), 'builder-avatar'); avatar.setAttribute('aria-hidden', 'true'); setStyle(avatar, { backgroundColor: avatarColor(a.id) });
      const text = markAgentLink(node(doc, 'span', undefined, 'builder-identity'), a); text.append(node(doc, 'strong', label(a)));
      if (reason) text.append(node(doc, 'span', reason, 'muted'));
      if (!a.platforms?.codex?.available) text.append(node(doc, 'span', a.platforms?.codex?.reason || 'Codex 不可用，请取消选择', 'reason'));
      if (a.writable || missingSourcesFor(a, 'codex').length) text.append(node(doc, 'span', [a.writable ? `${accessLabel(a)}，执行前需确认` : '', missingSourcesFor(a, 'codex').length ? '原书路径失效，执行前需确认' : ''].filter(Boolean).join(' · '), 'reason'));
      row.append(check, avatar, text); return row;
    }
    recommended.replaceChildren(node(doc, 'h3', '推荐'));
    if (!loading) { const again = action(doc, '重新推荐', () => refreshRecommendation(), '重新生成推荐'); again.className = 'perspective-refresh'; again.disabled = busy; recommended.append(again); }
    if (loading) recommended.append(node(doc, 'p', '正在加载推荐…'));
    else if (recommendation?.status === 'done') {
      if (recommendation.model) recommended.append(node(doc, 'p', `模型：${recommendation.model}${recommendation.effort ? ` · ${recommendation.effort}` : ''}`, 'muted'));
      const seen = new Set(); let total = 0;
      for (const result of recommendation.results || []) {
        const agent = agents.find(a => a.id === result.id);
        if (agent && !seen.has(agent.id)) { seen.add(agent.id); if (matches(agent)) { recommended.append(row(agent, result.reason)); total++; } }
      }
      if (!total) recommended.append(node(doc, 'p', '暂无匹配推荐，可从全部 Agent 中选择。'));
    } else recommended.append(node(doc, 'p', recommendation?.error || '推荐不可用，可从全部 Agent 中选择。'));
    all.replaceChildren(node(doc, 'h3', '全部'));
    const groups = new Map();
    for (const agent of agents.filter(matches)) { const key = agent.kind === 'role' ? '功能性 Agent' : agent.primary || '未分类'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(agent); }
    for (const [name, members] of groups) { all.append(node(doc, 'h4', name)); for (const a of members) all.append(row(a)); }
    if (!groups.size) all.append(node(doc, 'p', '没有匹配的 Agent'));
    count.textContent = `已选 ${selected.size} / 8 个${seminar ? '，至少 3 个书籍 Agent' : ''}${selected.size >= 8 ? '，已达上限' : ''}`; status.textContent = message;
    const unavailable = seminar && [...selected].some(id => !agents.find(a => a.id === id)?.platforms?.codex?.available);
    submit.disabled = busy || selected.size < (seminar ? 3 : 1) || selected.size > 8 || unavailable || record.perspectives?.some(p => ['queued','running'].includes(p.status));
    terminal.disabled = busy || !selected.size; search.disabled = busy;
    if (focusId && focus?.isConnected === false) Array.from((inRecommendations ? recommended : all).querySelectorAll('input')).find(n => n.getAttribute('data-agent-id') === focusId)?.focus();
  }
  async function poll(id, version) {
    try {
      const value = await api(`/api/recommend/${encodeURIComponent(id)}`);
      if (disposed || version !== generation || !dialog.open) return;
      recommendation = value; loading = ['queued','running'].includes(value.status); render();
      if (loading) timer = setTimer(() => poll(id, version), 1000);
    } catch (problem) { if (!disposed && version === generation) { loading = false; recommendation = { error: `推荐读取失败：${problem.message}` }; render(); } }
  }
  // One recommendation per concept: reopening the picker reuses it (per-viewer cache); 重新推荐 starts a fresh run.
  const cacheKey = id => `co-agent:perspective-recommend:${id}`;
  const cache = { get(id) { try { return doc.defaultView?.localStorage?.getItem(cacheKey(id)) || null; } catch { return null; } },
    set(id, value) { try { doc.defaultView?.localStorage?.setItem(cacheKey(id), value); } catch { /* cache is optional */ } } };
  async function recommend(version, refresh) {
    const cached = !refresh && cache.get(record.conceptId);
    if (cached) {
      await poll(cached, version);
      if (disposed || version !== generation) return;
      if (recommendation && !recommendation.error && recommendation.status !== 'failed') return;
      recommendation = null; loading = true; render();
    }
    try {
      const result = await api('/api/recommend', { input: `${record.result.concept}\n${record.result.oneLine}`.slice(0, 8000), engine: 'codex' });
      cache.set(record.conceptId, result.recommendId);
      if (!disposed && version === generation && dialog.open) await poll(result.recommendId, version);
    } catch (problem) { if (!disposed && version === generation) { loading = false; recommendation = { error: `推荐失败：${problem.message}` }; render(); } }
  }
  async function refreshRecommendation() {
    if (seminar || disposed || busy || loading || !record) return;
    clearTimer(timer); const version = ++generation; recommendation = null; loading = true; render();
    await recommend(version, true);
  }
  async function open(value, trigger, initialIds = []) {
    if (disposed || busy) return;
    clearTimer(timer); const version = ++generation; record = structuredClone(value); selected.clear(); search.value = '';
    if (seminar) for (const id of initialIds) selected.add(id);
    recommendation = null; loading = !seminar; message = ''; render();
    if (!dialog.open) controller.open(trigger);
    if (!seminar) await recommend(version, false);
  }
  async function execute(continueInTerminal) {
    if (disposed || busy || (seminar && continueInTerminal) || !selected.size || (!continueInTerminal && submit.disabled)) return;
    const ids = [...selected], id = seminar ? record.seminarId : record.conceptId, version = generation;
    busy = true; message = ''; render();
    try {
      // Close the picker before opening the shared manual builder (no stacked modals).
      if (continueInTerminal) await new Promise(resolve => {
        const closed = () => { dialog.removeEventListener('close', closed); resolve(); };
        dialog.addEventListener('close', closed); controller.close();
      });
      if (disposed) return;
      const ok = await (continueInTerminal ? onContinue : onRun)(id, ids);
      if (disposed || (!continueInTerminal && version !== generation)) return;
      if (ok && dialog.open) controller.close();
      else if (!ok) message = seminar ? '未执行，请查看研讨页提示或重新选择。' : '未执行，请查看概念页提示或重新选择。';
    } catch (problem) { if (!disposed) message = problem.message; }
    finally { busy = false; render(); }
  }
  search.addEventListener('input', render);
  dialog.addEventListener('close', () => { generation++; clearTimer(timer); });
  return { open, refresh: render, close: () => { if (dialog.open) controller.close(); },
    dispose() { disposed = true; generation++; clearTimer(timer); if (dialog.open) controller.close(); dialog.remove(); } };
}

// Requests and state only: the active layout owns history markup.
export function createCallHistory({ api, getRegistry, confirm, permissionText, onState = () => {}, onChanged = async () => {} }) {
  let all = [], items = [], filter = 'all', generation = 0, busy = false, disposed = false, message = '', selectedId = null;
  const snapshot = () => ({ items, all, filter, selectedId, busy, message });
  const emit = () => { if (!disposed) onState(snapshot()); };
  async function load() {
    const version = ++generation, requested = filter;
    try {
      const value = await api(`/api/history?type=${requested}&limit=50`);
      const recent = requested === 'all' ? value : await api('/api/history?type=all&limit=50');
      if (disposed || version !== generation) return;
      items = value.items; all = recent.items;
      if (!items.some(i => `${i.type}:${i.id}` === selectedId)) selectedId = items[0] ? `${items[0].type}:${items[0].id}` : null;
      emit();
    } catch (error) { if (!disposed && version === generation) { message = `历史读取失败：${error.message}`; emit(); } }
  }
  async function execute(type, id, resume) {
    const item = all.find(i => i.type === type && i.id === id);
    if (busy || !item || (resume && !item.canResume)) return;
    busy = true; emit();
    try {
      const members = item.agents.map(a => getRegistry()?.agents.find(current => current.id === a.id));
      const flags = await confirmMembers(members, item.cli, { confirm, permissionText }); if (!flags || disposed) return;
      const body = resume && item.type === 'launch' ? { agentId: item.agents[0].id, launchId: item.id, ...flags } : { type, id, ...flags };
      await api(resume ? '/api/resume' : '/api/history/rerun', body);
      if (disposed) return;
      message = resume ? '已请求恢复，等待核验。' : '已重新调用，等待核验。';
      await load(); await onChanged();
    } catch (error) { message = error.message; }
    finally { busy = false; emit(); }
  }
  return { load, snapshot, execute, select(type, id) { selectedId = `${type}:${id}`; emit(); },
    setFilter(value) { filter = ['launch', 'joint'].includes(value) ? value : 'all'; return load(); },
    dispose() { disposed = true; generation++; } };
}
