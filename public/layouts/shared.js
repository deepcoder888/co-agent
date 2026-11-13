import { markAgentLink } from '../agent-links.js';
import { renderMarkdown } from '../markdown.js';
import { conceptStatus, cleanTitle, avatarColor, avatarLetter, setStyle, runningName, formatDate, responseBody } from '../display.js';
import { donut, barList, columns } from '../charts.js';
import { mapMatches, renderMapGraph } from '../conceptMap.js';

// Element primitives and the temporary A2 concepts renderer. Stage B owns its composition.
export function node(doc, tag, text, className) {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export function region(doc, tag, className, ...children) {
  const el = node(doc, tag, undefined, className); el.append(...children.filter(Boolean)); return el;
}
export function action(doc, text, callback, label = text) {
  const el = node(doc, 'button', text); el.type = 'button';
  el.setAttribute('aria-label', label); el.addEventListener('click', callback); return el;
}

// Claude acceptance 2026-10-25: '…' read as truncated text; '＋' reads as adding to the previous view.
const stanceLabel = stance => ({ 赞同: '✓ 赞同', 反驳: '≠ 反驳', 补充: '＋ 补充' }[stance] || '无回应');
function focusConcept(doc) {
  const body = doc.getElementById('concepts-panel')?.querySelector('.concept-markdown');
  if (body) { body.setAttribute('tabindex', '-1'); body.focus(); }
}
export function conceptResponse(ctx, record) {
  const { doc, actions: a } = ctx, target = record?.respondsTo, response = record?.result?.response;
  if (record?.responseError) return node(doc, 'p', '本次回应未通过格式校验，已省略', 'concept-response-error');
  if (!target || !response) return null;
  const title = `回应 ${target.agent?.bookLabel || target.agent?.name || '书名未载明'}的「${target.concept}」· ${stanceLabel(response.stance)}`;
  const link = action(doc, '查看原概念', async () => { if (await a.openConceptResponse(target.conceptId)) focusConcept(doc); });
  link.setAttribute('data-focus-key', `concept-response-${record.conceptId}`);
  const card = region(doc, 'aside', 'concept-response', node(doc, 'h3', title), node(doc, 'p', responseBody(response.text)), link);
  card.setAttribute('aria-label', title); return card;
}
export function conceptResponseNote(doc, record) {
  const response = record?.result?.response || record?.response;
  return record?.respondsTo && response ? node(doc, 'small', `回应 ${record.respondsTo.day} · ${response.stance}`, 'concept-response-note') : null;
}
export function updateConceptResponseNote(ctx, model, entry) {
  if (!entry) return;
  entry.querySelector('.concept-response-note')?.remove();
  const todayId = model?.today?.conceptId;
  const today = todayId ? (model.selected?.conceptId === todayId ? model.selected : model.items?.find(r => r.conceptId === todayId)) : null;
  const note = conceptResponseNote(ctx.doc, today); if (note) entry.append(note);
}
// Each layout places this small disclosure in its own concept page.
export function renderConceptThread(ctx, model, host) {
  const { doc, refs: r, actions: a } = ctx;
  if (!r.conceptThread || !host.contains(r.conceptThread)) {
    const toggle = action(doc, '对话线', () => a.toggleConceptThread()); toggle.id = 'concept-thread-toggle';
    toggle.setAttribute('data-focus-key', toggle.id); toggle.setAttribute('aria-controls', 'concept-thread');
    const body = node(doc, 'section', undefined, 'concept-thread-body'); body.id = 'concept-thread'; body.setAttribute('aria-label', '每日概念对话线');
    r.conceptThread = region(doc, 'section', 'concept-thread', toggle, body); r.conceptThreadToggle = toggle; r.conceptThreadBody = body;
    host.prepend(r.conceptThread); r.conceptThreadKey = null;
  }
  r.conceptThreadToggle.setAttribute('aria-expanded', String(!!model?.threadOpen)); r.conceptThreadBody.hidden = !model?.threadOpen;
  const key = JSON.stringify([model?.threadItems, model?.threadLoading, model?.threadError, model?.selected?.conceptId]);
  if (r.conceptThreadKey === key) return;
  r.conceptThreadKey = key; const body = r.conceptThreadBody; body.replaceChildren();
  if (model?.threadLoading) { const status = node(doc, 'p', '正在读取对话线…'); status.setAttribute('role', 'status'); body.append(status); }
  if (model?.threadError) {
    const error = node(doc, 'p', model.threadError); error.setAttribute('role', 'alert');
    body.append(error, action(doc, '重新读取对话线', () => a.refreshConceptThread()));
  }
  const items = model?.threadItems || [], list = node(doc, 'ol', undefined, 'concept-thread-list');
  if (!items.length && !model?.threadLoading) body.append(node(doc, 'p', '暂无每日概念对话。'));
  for (const item of items) {
    const failed = item.status === 'failed', label = item.term?.zh || item.concept || '待生成概念';
    const open = action(doc, `${item.day} · ${item.agent?.bookLabel || item.agent?.name || '书名未载明'} · ${failed ? '这天没有生成' : label}`, async () => {
      if (await a.openConceptResponse(item.conceptId)) focusConcept(doc);
    });
    open.setAttribute('data-focus-key', `concept-thread-${item.conceptId}`);
    if (item.conceptId === model?.selected?.conceptId) open.setAttribute('aria-current', 'page');
    const row = region(doc, 'li', 'concept-thread-node', open, node(doc, 'span', failed ? '断点' : item.status === 'done' ? stanceLabel(item.response?.stance) : conceptStatus(item), 'concept-thread-stance'));
    row.setAttribute('data-concept-id', item.conceptId); row.setAttribute('data-status', item.status);
    if (item.response && item.respondsTo) {
      row.setAttribute('data-responds-to', item.respondsTo.conceptId);
      row.append(node(doc, 'p', `↳ 回应 ${item.respondsTo.day} · ${item.respondsTo.concept}`, 'concept-thread-target'),
        node(doc, 'p', responseBody(item.response.text), 'concept-thread-summary'));
    }
    list.append(row);
  }
  body.append(list);
}

export function renderDefaultConceptMap(ctx, model) {
  if (!model) return;
  const { doc, refs: r, actions: a } = ctx;
  const control = (text, id, callback) => { const b = action(doc, text, callback); b.id = `concept-map-${id}`; b.setAttribute('data-focus-key', b.id); b.disabled = model.busy; return b; };
  if (!r.conceptMapPanel) {
    const panel = node(doc, 'section', undefined, 'concept-map-page'); panel.id = 'concept-map-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'concept-map-title');
    const title = node(doc, 'h1', '跨书概念地图'); title.id = 'concept-map-title'; title.setAttribute('tabindex', '-1');
    const search = node(doc, 'input'); search.type = 'search'; search.id = 'concept-map-search'; search.setAttribute('data-focus-key', search.id);
    search.addEventListener('input', () => a.searchConceptMap(search.value));
    const label = node(doc, 'label', '搜索中英法标签或概念键'); label.setAttribute('for', search.id);
    const status = node(doc, 'p'); status.id = 'concept-map-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const error = node(doc, 'p'); error.id = 'concept-map-error'; error.setAttribute('role', 'alert');
    const organize = control('整理概念地图', 'organize', () => a.organizeConceptMap());
    const list = node(doc, 'nav', undefined, 'concept-map-list'); list.id = 'concept-map-list'; list.setAttribute('aria-label', '概念列表');
    const detail = node(doc, 'article', undefined, 'concept-map-detail'); detail.id = 'concept-map-detail'; detail.setAttribute('tabindex', '-1');
    const hidden = region(doc, 'details', 'concept-map-hidden', node(doc, 'summary', '设置 · 已隐藏')); const hiddenList = node(doc, 'div'); hidden.append(hiddenList);
    panel.append(region(doc, 'header', 'concept-map-head', title, control('返回 Agent', 'back', async () => { await a.showView('catalog'); doc.getElementById('concept-map-open')?.focus(); }),
      control('页面排版', 'settings', e => a.openSettings(e.currentTarget)), control('重新读取', 'refresh', () => a.openConceptMap()), organize), status, error,
      region(doc, 'div', 'concept-map-columns', region(doc, 'aside', 'concept-map-sidebar', label, search, list, hidden), detail));
    doc.getElementById('layout-root').append(panel);
    Object.assign(r, { conceptMapPanel: panel, conceptMapTitle: title, conceptMapSearch: search, conceptMapStatus: status, conceptMapError: error,
      conceptMapOrganize: organize, conceptMapList: list, conceptMapDetail: detail, conceptMapHidden: hiddenList });
  }
  const visible = ctx.state.view === 'conceptMap', entering = visible && r.conceptMapPanel.hidden;
  r.conceptMapPanel.hidden = !visible; if (entering) r.conceptMapTitle.focus();
  const entry = doc.getElementById('concept-map-open'); entry?.setAttribute('aria-expanded', String(visible)); entry?.setAttribute('aria-controls', 'concept-map-panel');
  r.conceptMapSearch.value = model.query;
  r.conceptMapOrganize.disabled = model.busy || !!model.running || !model.concepts.length;
  r.conceptMapOrganize.textContent = model.running ? '正在整理概念地图…' : '整理概念地图';
  r.conceptMapStatus.textContent = [model.notice, `有 ${model.newCount} 个新概念未整理`, model.organizedAt ? `上次整理：${formatDate(model.organizedAt)}` : '',
    model.running ? '整理完成后自动更新' : '', model.lastRun?.droppedCount ? `丢弃了 ${model.lastRun.droppedCount} 条：${model.lastRun.dropped.join('；')}` : '',
    model.lastRun?.truncated ? `本次输入 ${model.lastRun.inputCount} 个，未纳入 ${model.lastRun.truncated} 个` : '',
    model.lastRun?.status === 'failed' ? `整理失败：${model.lastRun.error}` : ''].filter(Boolean).join(' · ');
  r.conceptMapError.textContent = model.error;
  const listKey = JSON.stringify([model.concepts, model.selected?.key, model.query, model.busy, model.hiddenConcepts]);
  if (r.conceptMapListKey !== listKey) {
    r.conceptMapListKey = listKey; r.conceptMapList.replaceChildren(); r.conceptMapHidden.replaceChildren();
    if (!model.concepts.length) r.conceptMapList.append(node(doc, 'p', '地图会随每日概念和研讨自动丰富。'));
    const filtered = model.concepts.filter(n => mapMatches(n, model.query));
    if (model.concepts.length && !filtered.length) r.conceptMapList.append(node(doc, 'p', '没有匹配的概念。'));
    for (const n of filtered) {
      const b = control(`${n.label} · ${n.bookCount} 本书${n.organized ? '' : ' · 未整理'}`, `select-${n.key}`, async () => { await a.selectMapConcept(n.key); r.conceptMapDetail.focus(); });
      b.title = n.label; if (n.key === model.selected?.key) b.setAttribute('aria-current', 'page'); r.conceptMapList.append(b);
    }
    for (const n of model.hiddenConcepts) r.conceptMapHidden.append(region(doc, 'div', '', node(doc, 'span', n.label), control('恢复', `restore-${n.key}`, () => a.updateConceptMap({ restore: { hideConcept: n.key } }))));
    if (!model.hiddenConcepts.length) r.conceptMapHidden.append(node(doc, 'p', '没有隐藏的概念。'));
  }
  const detailKey = JSON.stringify([model.selected, model.busy]); if (r.conceptMapDetailKey === detailKey) return;
  r.conceptMapDetailKey = detailKey; const body = r.conceptMapDetail; body.replaceChildren(); const n = model.selected;
  if (!n) { body.append(node(doc, 'p', '选择一个概念，查看各书的说法与关系。')); return; }
  body.append(node(doc, 'h2', n.label), node(doc, 'p', ['zh', 'en', 'fr'].map(k => `${k.toUpperCase()}：${n.labels[k] || '未载明'}`).join(' · ')),
    control('隐藏这个概念', 'hide-concept', () => a.updateConceptMap({ hideConcept: n.key })), renderMapGraph(doc, n, a),
    node(doc, 'p', '线型：相关—实线；对立—虚线；包含—短点线；因果—点划线；书籍—细点线。Tab / 方向键切换节点，Enter / 空格打开。', 'concept-map-legend'));
  for (const s of n.splits) body.append(node(doc, 'p', `拆开建议（仅提示）：${s.key} · ${s.reason}`, 'concept-map-split'));
  body.append(node(doc, 'h3', '各书怎么说'));
  const types = { concept: '每日概念', perspective: '多视角', seminar: '研讨' };
  n.mentions.forEach((m, i) => body.append(region(doc, 'section', 'concept-map-mention', node(doc, 'h4', m.bookLabel || m.name),
    node(doc, 'p', `${m.name} · ${types[m.sourceType]} · ${/^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : formatDate(m.date)}`), node(doc, 'p', m.excerpt), control('查看原记录', `source-${i}`, () => a.openMapSource(m)))));
  body.append(node(doc, 'h3', '概念关系'));
  if (!n.relations.length) body.append(node(doc, 'p', '暂无关系。'));
  n.relations.forEach((rel, i) => body.append(region(doc, 'section', 'concept-map-relation', node(doc, 'strong', `${rel.type}${['包含', '因果'].includes(rel.type) ? (rel.a === n.key ? '（从此概念指向）' : '（指向此概念）') : ''} · `),
    control(rel.otherLabel, `relation-${i}`, () => a.selectMapConcept(rel.otherKey)), node(doc, 'p', rel.explanation), node(doc, 'p', `依据：${rel.basis.map(id => ctx.state.allAgents?.find(agent => agent.id === id)?.name || id).join('、')}`),
    control('隐藏这条关系', `hide-relation-${i}`, () => a.updateConceptMap({ hideRelation: { a: rel.a, b: rel.b, type: rel.type } })))));
  if (n.merges.length) { body.append(node(doc, 'h3', '合并成员')); for (const m of n.merges) for (const key of m.members) if (key !== m.canonical)
    body.append(region(doc, 'div', 'concept-map-member', node(doc, 'span', key), control('拆开', `unmerge-${key}`, () => a.updateConceptMap({ unmerge: { canonical: m.canonical, member: key } })))); }
}

// v0.29 常用 Agent: the same toggle in every layout's detail actions.
// v0.39: the third way to call after the two terminal CLIs; it then asks whether Claude or Codex answers.
export function inAppButton(doc, agent, actions, className = '') {
  const button = action(doc, '在 CO-AGENT 中调用', event => { if (!button.disabled) return actions.openChatStart(agent.id, event.currentTarget); }, `在 CO-AGENT 中调用 ${agent.name}`);
  if (className) button.className = className;
  button.disabled = !agent.platforms?.claude?.available && !agent.platforms?.codex?.available;
  button.setAttribute('data-focus-key', 'detail-inapp'); return button;
}
export function pinButton(doc, agent, actions, className = '') {
  const pinned = !!agent.pinned;
  const button = action(doc, pinned ? '★ 已设为常用' : '☆ 设为常用', event => actions.togglePin(agent.id, event.currentTarget), (pinned ? '取消常用 ' : '设为常用 ') + agent.name);
  if (className) button.className = className;
  button.setAttribute('aria-pressed', String(pinned)); button.setAttribute('data-focus-key', 'detail-pin');
  return button;
}

export function renderCandidateNotice(ctx, n = 0) {
  if (!ctx.refs.candidateNotice) {
    const button = action(ctx.doc, '', event => ctx.actions.openCandidates(event.currentTarget));
    button.className = 'candidate-notice quiet'; button.setAttribute('data-focus-key', 'candidate-notice');
    ctx.refs.candidateNotice = button;
  }
  const notice = ctx.refs.candidateNotice;
  notice.hidden = !n; notice.textContent = `发现 ${n} 个新书籍 Agent · 查看`; notice.setAttribute('aria-label', notice.textContent);
  return notice;
}

export function runningCloseHeading(ctx, heading) {
  const button=action(ctx.doc,'全部关闭',event=>{
    if(!button.disabled)return ctx.actions.closeAllRunning(event.currentTarget);
  });
  button.id='running-close-all';button.className='running-close-all';button.disabled=true;
  button.setAttribute('data-focus-key',button.id);ctx.refs.runningCloseAll=button;
  return region(ctx.doc,'div','running-heading',heading,button);
}
export function updateRunningClose(ctx, items) {
  const button=ctx.refs.runningCloseAll;if(!button)return;
  button.disabled=!!ctx.state.closeRunningBusy||!items.length;
  // Only a confirmed close-all shows progress; an open confirmation just disables the controls.
  button.textContent=ctx.state.closingAll?'正在关闭…':'全部关闭';
}
export function runningCloseRow(ctx, item, content) {
  const busy=!!ctx.state.closeRunningBusy, closing=(ctx.state.closingKeys||[]).includes(`${item.type}:${item.id}`);
  const button=action(ctx.doc,closing?'正在关闭…':'关闭',event=>{
    if(!button.disabled)return ctx.actions.closeRunning(item.type,item.id,event.currentTarget);
  },`关闭 ${runningName(item)} 会话`);
  button.disabled=busy;button.className='running-close-button';
  button.setAttribute('data-close-running',`${item.type}:${item.id}`);
  button.setAttribute('data-focus-key',`running-close-${item.type}-${item.id}`);
  return region(ctx.doc,'div','running-close-row',content,button);
}

// Shared functional composition only. The four Stage B renderers replace this stub.
// Stage A2 reachability implementation; Stage B may replace each layout's composition.
export function renderDefaultStats(ctx, model) {
  const {doc, refs, actions:a} = ctx;
  if (!refs.statsPanel) {
    const entry = action(doc, '调用统计', () => a.openStats()); entry.id='stats-open'; entry.className='stats-entry'; entry.setAttribute('data-focus-key','stats-open');
    const panel = node(doc,'section',undefined,'stats-default'); panel.id='stats-panel'; panel.hidden=true; panel.setAttribute('aria-label','调用统计');
    ctx.root.parentElement.append(entry,panel); refs.statsPanel=panel; refs.statsEntry=entry;
  }
  const panel=refs.statsPanel, visible=ctx.state.view==='stats', entering=visible && panel.hidden;
  const restore=!visible && !panel.hidden && panel.contains(doc.activeElement);
  panel.hidden=!visible; refs.statsEntry.hidden=visible; ctx.root.hidden=visible;
  ctx.root.parentElement.setAttribute('data-stats-open',String(visible));
  if (restore) refs.statsEntry.focus();
  if (!visible || !model) return;
  const signature=JSON.stringify(model);
  if (refs.statsSignature===signature) { if(entering) refs.statsHeading?.focus(); return; }
  refs.statsSignature=signature;
  const control=(label,key,callback,pressed) => { const b=action(doc,label,callback); b.setAttribute('data-focus-key',`stats-${key}`); if(pressed!==undefined)b.setAttribute('aria-pressed',String(pressed)); return b; };
  const title=node(doc,'h1','调用统计'); title.setAttribute('tabindex','-1'); refs.statsHeading=title;
  const ranges=region(doc,'div','stats-controls',...Object.entries({'7d':'近 7 天','30d':'近 30 天',all:'累计'}).map(([key,label])=>control(label,key,()=>a.setStatsRange(key),model.range===key)));
  ranges.setAttribute('aria-label','统计时间范围');
  panel.replaceChildren(region(doc,'div','workflow-actions',title,control('返回 Agent','back',()=>a.showView('catalog')),control('刷新统计','refresh',a.refreshStats)),ranges);
  if(model.limited) { const reason=node(doc,'p',`数据范围有限：${model.limitedReasons.join('；')}`,'stats-limited'); reason.setAttribute('role','status');panel.append(reason); }
  if(model.status!=='ready') {panel.append(node(doc,'p',model.status==='loading'?'统计正在建立…':'调用统计暂不可用'));return;}
  const t=model.totals;
  panel.append(node(doc,'p',`调用 ${t.calls} · Claude ${t.claude} / Codex ${t.codex} · 成功 ${t.ok} / 失败 ${t.failed} / 未知 ${t.unknown} · 已调用 Agent ${t.agentsUsed}`,'stats-totals'));
  panel.append(region(doc,'div','stats-donuts',
    region(doc,'section','stats-chart',node(doc,'h2','功能性 / 书籍'),donut({segments:model.byKind.map(s=>({...s,colorClass:`chart-${s.key}`})),centerLabel:'调用',centerValue:t.calls,onSelect:a.setStatsFilter},doc)),
    region(doc,'section','stats-chart',node(doc,'h2','书籍分类'),donut({segments:model.byCategory,centerLabel:'书籍调用',centerValue:model.byKind.find(s=>s.key==='book')?.value || 0,onSelect:a.setStatsCategory},doc))));
  const trend=region(doc,'section','stats-chart',node(doc,'h2','近 30 天每日趋势'),node(doc,'p','趋势固定展示近 30 天全部 Agent，日期按本机时区。'));
  trend.append(columns({points:model.daily.map(p=>({label:p.day,value:p.calls,parts:[{key:'claude',value:p.claude,colorClass:'chart-claude'},{key:'codex',value:p.codex,colorClass:'chart-codex'}]})),height:160},doc)); panel.append(trend);
  const filters=region(doc,'div','stats-controls',...Object.entries({all:'全部',role:'功能性',book:'书籍'}).map(([key,label])=>control(label,`filter-${key}`,()=>a.setStatsFilter(key),model.filter===key)));
  filters.setAttribute('aria-label','排行榜筛选');
  panel.append(node(doc,'h2','Agent 调用排行'),filters);
  if(model.categoryFilter)panel.append(control(`分类：${model.categoryFilter} · 取消筛选`,'category',()=>a.setStatsCategory(model.categoryFilter),true));
  panel.append(barList({rows:model.agents.map(agent=>({id:agent.id,label:agent.name,sublabel:agent.bookLabel || agent.purpose || '用途未载明',value:agent.value,parts:[{key:'claude',value:agent.claude,colorClass:'chart-claude'},{key:'codex',value:agent.codex,colorClass:'chart-codex'}]})),onSelect:id=>a.openDetail(id)},doc));
  panel.append(node(doc,'p',`未调用的 Agent：${model.zeroCount} 个`,'stats-zero'),control(model.showAll?'收起至前 20 名':`展开全部（${model.agentCount}）`,'expand',a.toggleStatsShowAll,model.showAll));
  panel.append(node(doc,'p',`更新：${model.generatedAt || '未载明'} · 调用次数不包含启动次数`,'stats-note'));
  if(entering) title.focus();
}

export function renderDefaultConcepts(ctx, model) {
  const { doc, refs, actions: a } = ctx;
  if (!refs.conceptsPanel) {
    const entry = action(doc, '随机概念', () => a.openConcepts()); entry.id = 'concepts-open'; entry.className = 'concepts-entry';
    entry.setAttribute('data-focus-key', 'concepts-open');
    const panel = node(doc, 'section', undefined, 'concepts-default'); panel.id = 'concepts-panel'; panel.setAttribute('aria-label', '随机概念');
    ctx.root.parentElement.append(entry, panel); refs.conceptsPanel = panel; refs.conceptsEntry = entry;
  }
  const panel = refs.conceptsPanel, visible = ctx.state.view === 'concepts', entering = visible && panel.hidden;
  const restoreFocus = !visible && !panel.hidden && panel.contains(doc.activeElement);
  panel.hidden = !visible; refs.conceptsEntry.hidden = visible;
  // Hide the existing composition only in this temporary view; no original DOM is removed.
  ctx.root.hidden = visible;
  ctx.root.parentElement.setAttribute('data-concepts-open', String(visible));
  if (restoreFocus) refs.conceptsEntry.focus();
  if (!visible || !model) return;
  const elapsed = [model.running ? conceptStatus({status:'running',...model.running}) : '', conceptStatus(model.selected),
    ...(model.selected?.perspectives || []).map(p => conceptStatus(p))];
  const key = JSON.stringify([model, elapsed]);
  if (refs.conceptsKey === key) return;
  refs.conceptsKey = key;
  const control = (text, key, callback, disabled = false) => {
    const button = action(doc, text, () => { if (!button.disabled) return callback(); });
    button.setAttribute('data-focus-key', `concepts-${key}`); button.disabled = disabled; return button;
  };
  const title = node(doc, 'h1', '随机概念'); title.setAttribute('tabindex', '-1');
  const header = region(doc, 'div', 'workflow-actions', title, control('返回 Agent', 'back', () => a.showView('catalog')),
    control('再来一个', 'next', a.nextConcept, model.busy || !!model.running));
  const status = node(doc, 'p', model.busy ? '正在提交…' : '', 'concept-status'); status.setAttribute('role', 'status');
  const error = node(doc, 'p', model.error || '', 'reason'); error.setAttribute('role', 'alert');
  panel.replaceChildren(header, status, error);
  renderConceptThread(ctx, model, panel);
  if (entering) title.focus();
  if (model.error) panel.append(control('重新读取', 'refresh', a.openConcepts));
  if (model.running) panel.append(node(doc, 'p', `概念生成${conceptStatus({status:'running', ...model.running})}`, 'concept-status'));
  const archive = node(doc, 'nav', undefined, 'concept-archive'); archive.setAttribute('aria-label', '概念存档');
  for (const item of model.items) {
    const title = item.result?.concept || item.concept || '待生成概念';
    const button = control(`${item.conceptId === model.today?.conceptId ? '今日 · ' : ''}${title} · ${conceptStatus(item)}`, `select-${item.conceptId}`, () => a.selectConcept(item.conceptId));
    if (item.conceptId === model.selected?.conceptId) button.setAttribute('aria-current', 'page'); archive.append(button);
  }
  if (!model.items.length) archive.append(node(doc, 'p', '暂无存档，可点击「再来一个」。'));
  panel.append(archive);
  const record = model.selected; if (!record) { panel.append(node(doc, 'p', '请选择概念或等待详情读取。')); return; }
  const body = node(doc, 'article', undefined, 'concept-reading');
  const result = record.result;
  body.append(node(doc, 'h2', result?.concept || '正在准备概念'), markAgentLink(node(doc, 'p', `《${cleanTitle(record.agent?.title || record.agent?.bookLabel).text || '书名未载明'}》 · ${record.agent?.name || ''}`), record.agent), node(doc, 'p', conceptStatus(record)));
  if (record.error) body.append(node(doc, 'p', `失败原因：${record.error}`, 'reason'));
  if (record.status === 'failed') body.append(control('重试（生成新概念）', 'retry', a.nextConcept, model.busy || !!model.running));
  if (result) {
    body.append(node(doc, 'p', result.oneLine), node(doc, 'aside', result.whyUnknown, 'concept-why'));
    const available = record.status === 'done' && !model.busy;
    body.append(region(doc, 'div', 'workflow-actions',
      control('多视角分析', 'perspectives', () => a.openPerspectivePicker(record.conceptId), !available),
      control('在终端中继续', 'continue', () => a.continueInJoint(record.conceptId), !available)));
    const verified = record.verify?.state === 'ok', structure = record.verify?.skillStructure;
    body.append(node(doc, 'p', `Agent 核验：${verified ? '通过' : record.verify?.state === 'violation' ? '违规' : '未确认'}`, verified ? 'concept-status' : 'concept-warning'));
    body.append(node(doc, 'p', `讲解结构：${structure?.state === 'ok' ? '通过' : `未通过或未确认；缺少小节 ${(structure?.missing || []).join('、') || '未知'}${structure?.titleLine === false ? '；缺少标题行' : ''}`}`, structure?.state === 'ok' ? 'concept-status' : 'concept-warning'));
    if (record.thinkError) body.append(node(doc, 'p', `THINK 另存失败：${record.thinkError}`, 'concept-warning'));
    if (result.sourceRefs?.length) body.append(node(doc, 'p', `书内出处：${result.sourceRefs.join('；')}`));
    const response = conceptResponse(ctx, record); if (response) body.append(response);
    body.append(renderMarkdown(doc, result.markdown));
  } else if (record.thinkError) body.append(node(doc, 'p', `THINK 另存失败：${record.thinkError}`, 'concept-warning'));
  if (record.poolWarning) body.append(node(doc, 'p', record.poolWarning, 'concept-warning'));
  const perspectives = node(doc, 'section', undefined, 'concept-perspectives'); perspectives.setAttribute('aria-label', '多视角分析结果');
  for (const run of record.perspectives || []) {
    const section = node(doc, 'section'); section.append(node(doc, 'h3', `多视角 · ${conceptStatus(run)}`));
    if (run.error) section.append(node(doc, 'p', `失败原因：${run.error}`, 'reason'));
    if (run.status === 'failed') section.append(control('重试多视角分析', `retry-${run.runId}`, () => a.runPerspectives(record.conceptId, (run.agents || []).map(a => a.id)), model.busy || record.perspectives.some(p => ['queued','running'].includes(p.status))));
    const parallel = typeof run.verify?.parallel === 'object' ? run.verify.parallel?.state : run.verify?.parallel;
    const parallelOk = parallel === 'ok' || parallel === true;
    if (run.verify?.state !== 'ok' || !parallelOk || run.verify?.violations?.length) section.append(node(doc, 'p', `多视角核验：${run.verify?.state || '未确认'}；并行：${parallelOk ? '通过' : '未通过或未确认'}${run.verify?.violations?.length ? `；${JSON.stringify(run.verify.violations)}` : ''}`, 'concept-warning'));
    const cards = node(doc, 'div', undefined, 'concept-perspective-cards');
    for (const result of run.results || []) cards.append(region(doc, 'article', 'concept-perspective-card', markAgentLink(node(doc, 'h4', result.name || result.agentId), {id:result.agentId}), renderMarkdown(doc, result.analysis)));
    section.append(cards); perspectives.append(section);
  }
  body.append(perspectives); panel.append(body);
}

// v0.14 调用组: shared group building blocks and the full-page fallback used by layouts without their own renderGroups.
export function groupMembers(doc, group) {
  const list = node(doc, 'span', undefined, 'group-member-list');
  for (const m of group.members) {
    const chip = node(doc, 'span', undefined, `group-member${m.missing ? ' missing' : ''}`);
    const avatar = node(doc, 'span', m.avatarLetter, 'group-avatar'); avatar.setAttribute('aria-hidden', 'true'); setStyle(avatar, { backgroundColor: m.avatarColor });
    chip.append(avatar, node(doc, 'span', m.name)); list.append(chip);
  }
  return list;
}
export function groupMeta(group) {
  const cli = { claude: 'Claude', codex: 'Codex' }[group.cli] || group.cli;
  const runs = group.runCount ? `运行 ${group.runCount} 次 · 上次 ${formatDate(group.lastRunAt)}` : '还没运行过';
  return `默认 ${cli} · ${group.presets.length} 个预设问题 · ${runs}`;
}
export function groupActions(ctx, group, prefix = 'group') {
  const { doc, actions: a } = ctx;
  const make = (text, key, run, label, className) => {
    const button = action(doc, text, event => { if (!button.disabled) return run(event.currentTarget); }, label);
    button.className = className; button.setAttribute('data-focus-key', `${prefix}-${key}-${group.id}`); button.disabled = !!ctx.state.groupsBusy; return button;
  };
  return region(doc, 'div', 'group-actions',
    make('提问', 'ask', t => a.askGroup(group.id, t), `向调用组「${group.name}」提问`, 'primary'),
    make('编辑', 'edit', t => a.editGroup(group.id, t), `编辑调用组「${group.name}」`, 'secondary'),
    make('删除', 'delete', t => a.deleteGroup(group.id, t), `删除调用组「${group.name}」`, 'quiet danger-text'));
}
export function renderDefaultGroups(ctx, model) {
  const { doc, refs: r, actions: a } = ctx;
  if (!model) return;
  if (!r.groupsPanel) {
    const panel = node(doc, 'section', undefined, 'groups-page'); panel.id = 'groups-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'groups-title');
    const title = node(doc, 'h1', '调用组'); title.id = 'groups-title'; title.setAttribute('tabindex', '-1');
    const create = action(doc, '＋ 新建联合调用', event => a.newGroup(event.currentTarget)); create.className = 'primary'; create.id = 'groups-new'; create.setAttribute('data-focus-key', 'groups-new');
    const back = action(doc, '返回', () => a.showView('catalog'), '返回 Agent 目录'); back.className = 'secondary'; back.id = 'groups-back'; back.setAttribute('data-focus-key', 'groups-back');
    const head = region(doc, 'header', 'groups-page-head', region(doc, 'div', '', title, node(doc, 'p', '选好一组 Agent 存起来，需要时再问它们；常问的问题可以存成预设。', 'groups-page-subtitle')), region(doc, 'div', 'groups-page-tools', back, create));
    const status = node(doc, 'p', '', 'groups-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const list = node(doc, 'div', undefined, 'groups-grid');
    panel.append(head, status, list); ctx.root.parentElement.append(panel);
    Object.assign(r, { groupsPanel: panel, groupsList: list, groupsStatus: status, groupsTitle: title });
  }
  const visible = ctx.state.view === 'groups';
  if (visible && r.groupsPanel.hidden) queueMicrotask(() => r.groupsTitle.focus?.());
  r.groupsPanel.hidden = !visible; ctx.root.hidden = visible;
  if (!visible) return;
  r.groupsStatus.textContent = model.loading ? '正在读取调用组…' : model.error || '';
  r.groupsList.replaceChildren();
  if (!model.groups.length && !model.loading) {
    const empty = region(doc, 'div', 'groups-empty', node(doc, 'h2', '还没有调用组'),
      node(doc, 'p', '点「＋ 新建联合调用」，选几个 Agent、起个名字保存。之后在这里点「提问」就能随时召集它们。'));
    r.groupsList.append(empty); return;
  }
  for (const group of model.groups) {
    const card = node(doc, 'article', undefined, 'group-card'); card.setAttribute('aria-label', group.name);
    card.append(node(doc, 'h2', group.name, 'group-card-name'), groupMembers(doc, group), node(doc, 'p', groupMeta(group), 'group-card-meta'), groupActions(ctx, group));
    r.groupsList.append(card);
  }
}
