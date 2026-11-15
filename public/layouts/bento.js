import { markAgentLink, fillAgentNames, openFileButton, runningMembers } from '../agent-links.js';
import { node, action, region, runningCloseHeading, runningCloseRow, updateRunningClose, renderCandidateNotice, emptyCatalog, pinButton, inAppButton, conceptResponse, conceptResponseNote, renderConceptThread } from './shared.js';
import { donut, barList, columns } from '../charts.js';
import { renderMarkdown } from '../markdown.js';
import { manageDialog } from '../accessibility.js';
import { bookLabel, categoryShort, cleanTitle, formatDate, summary, conceptStatus, avatarColor, avatarLetter, setStyle } from '../display.js';

export const initialCategory = 'role';
export const jointBuilderSkin = 'bento-builder';

// Layout-owned composition only; every durable value and command comes from ctx.
function control(ctx, text, label, key, callback, className = '') {
  const el = action(ctx.doc, text, event => { if (!el.disabled) return callback(event); }, label);
  el.className = className;
  el.setAttribute('data-focus-key', key);
  return el;
}
function select(ctx, id, label, options, callback) {
  const el = node(ctx.doc, 'select'); el.id = id; ctx.refs[id] = el;
  el.setAttribute('aria-label', label);
  for (const [value, text] of options) { const option = node(ctx.doc, 'option', text); option.value = value; el.append(option); }
  el.addEventListener('change', () => callback(el.value)); return el;
}
function settingsIcon(doc) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': true })) svg.setAttribute(key, value);
  const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '3');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1');
  svg.append(circle, path); return svg;
}
export function render(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const make = (tag, id, text, cls = '', attrs = {}) => {
    const el = node(doc, tag, text, cls); if (id) { el.id = id; r[id] = el; }
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  const brand = make('div', 'brand', undefined, 'brand');
  brand.append(make('img', '', undefined, 'brand-logo', { src: '/brand/co-agent-icon.svg', alt: '', width: '40', height: '40' }), node(doc, 'h1', 'CO-AGENT'));
  const search = make('input', 'search', undefined, '', { type: 'search', placeholder: '搜索 Agent、书名、作者', autocomplete: 'off', 'aria-label': '全局搜索', title: '/ 或 Ctrl+K' });
  search.addEventListener('input', () => a.search(search.value));
  const searchControl = make('div', 'search-control'); searchControl.append(search);
  const settings = control(ctx, '', '打开设置', 'settings-open', e => a.openSettings(e.currentTarget)); settings.id = 'settings-open'; settings.append(settingsIcon(doc));
  const header = region(doc, 'header', 'bento-header', brand, region(doc, 'div', 'header-tools', searchControl, settings));

  const ask = make('section', 'recommend-panel', undefined, 'bento-ask', { 'aria-label': 'AI 推荐' });
  const askLabel = control(ctx, '问 CO-AGENT', 'AI 推荐', 'ask-focus', () => a.showView('recommend'), 'ask-label');
  const headline = make('h2', 'recommend-title', undefined, 'ask-headline');
  headline.append(node(doc, 'span', '描述你的任务，'), node(doc, 'br'), node(doc, 'span', '我来挑选合适的 Agent。'));
  const input = make('textarea', 'recommend-input', undefined, '', { rows: '1', maxlength: '8000', placeholder: '例如：核实网上流传的睡眠说法', 'aria-label': '任务（最多 8000 字）', 'aria-describedby': 'recommend-count recommend-disabled-reason' });
  const count = make('p', 'recommend-count', '', 'task-count'); count.hidden = true;
  const disabledReason = make('p', 'recommend-disabled-reason', '', 'bento-sr-only', { 'aria-live': 'polite' });
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid'); disabledReason.className = 'bento-sr-only'; disabledReason.textContent = '';
    return a.setRecommendInput(input.value);
  }); r.recommendInput = input;
  const submit = control(ctx, '推荐 Agent', '推荐 Agent', 'recommend-submit', () => {
    if (!input.value.trim()) {
      input.setAttribute('aria-invalid', 'true'); disabledReason.className = 'task-count'; disabledReason.textContent = '请输入问题';
      input.focus(); return;
    }
    return a.recommend();
  }); submit.id = 'recommend-submit'; r[submit.id] = submit;
  submit.setAttribute('aria-describedby', 'recommend-disabled-reason');
  const compose = control(ctx, '＋ 新建联合调用', '新建联合调用', 'compose', e => a.openJoint(undefined, e.currentTarget), 'compose');
  const engine = select(ctx, 'recommend-engine', '推荐引擎', [['claude', 'Claude'], ['codex', 'Codex']], a.setRecommendEngine);
  const engineLabel = region(doc, 'label', 'engine-control', node(doc, 'span', '引擎：'), engine);
  const inputLine = region(doc, 'div', 'ask-input-line', input, submit);
  r.seminarsEntry = seminarControl(ctx, '开个研讨会 →', 'open', () => a.openSeminars());
  r.seminarsEntry.className = 'bento-seminar-entry';
  const consultEntry = action(doc, '会诊室 →', () => a.openConsults(), '会诊室');
  consultEntry.id = 'consults-open'; consultEntry.setAttribute('data-focus-key', 'consults-open'); consultEntry.className = 'bento-seminar-entry';
  const chatsEntry = action(doc, '软件内对话 →', () => a.openChats(), '软件内对话');
  chatsEntry.id = 'chats-open'; chatsEntry.setAttribute('data-focus-key', chatsEntry.id); chatsEntry.className = 'bento-seminar-entry';
  const councilsEntry = action(doc, '顾问团 →', () => a.openCouncils(), '顾问团');
  councilsEntry.id = 'councils-open'; councilsEntry.setAttribute('data-focus-key', councilsEntry.id); councilsEntry.className = 'bento-seminar-entry';
  const mapEntry = action(doc, '概念地图 →', () => a.openConceptMap(), '概念地图');
  mapEntry.id = 'concept-map-open'; mapEntry.setAttribute('data-focus-key', mapEntry.id); mapEntry.className = 'bento-seminar-entry';
  ask.append(askLabel, headline, region(doc, 'div', 'ask-form', inputLine, count, disabledReason, region(doc, 'div', 'ask-actions', compose, engineLabel, r.seminarsEntry, consultEntry, councilsEntry, mapEntry, chatsEntry)));

  const metrics = make('section', 'metrics', undefined, '', { 'aria-label': '统计概览' });
  const top = make('section', 'top-agents', undefined, 'bento-tile', { 'aria-label': '最常用' });
  const resultsPanel = make('section', 'recommend-output', undefined, '', { 'aria-label': '推荐结果' });
  const status = make('div', 'recommend-status', undefined, '', { role: 'status', 'aria-live': 'polite' });
  const results = make('div', 'recommend-results');
  const all = make('input', 'select-all', undefined, '', { type: 'checkbox', 'aria-label': '全选当前推荐', 'aria-describedby': 'select-all-disabled-reason' });
  all.addEventListener('change', () => a.selectAllRecommendations(all.checked));
  const jointCli = select(ctx, 'joint-cli', '联合调用 CLI', [['claude', 'Claude CLI'], ['codex', 'Codex CLI'], ['inapp:claude', 'CO-AGENT 内 · Claude'], ['inapp:codex', 'CO-AGENT 内 · Codex']], a.setJointCli);
  const jointSubmit = control(ctx, '执行联合调用', '执行推荐联合调用', 'joint-submit', a.launchRecommendedJoint, 'bento-primary'); jointSubmit.id = 'joint-submit'; r[jointSubmit.id] = jointSubmit;
  jointSubmit.setAttribute('aria-describedby', 'joint-disabled-reason');
  const resultActions = make('div', 'recommend-actions', undefined, 'workflow-actions');
  resultActions.append(region(doc, 'label', 'select-agent', all, node(doc, 'span', '全选当前推荐')), make('span', 'selected-count'), jointCli, jointSubmit);
  resultsPanel.append(status, results, resultActions, make('p', 'joint-disabled-reason', '', 'muted'), make('p', 'select-all-disabled-reason', '有推荐结果时可全选。', 'bento-sr-only'),
    make('p', 'recommend-verification', '用 Claude 时，CO-AGENT 会在运行前限定它只能调用所选的 Agent；用 Codex 时，CO-AGENT 无法事先限制它调用哪些 Agent，只能在运行后核对。', 'verification-note'));

  const catalog = make('section', 'catalog', undefined, '', { 'aria-labelledby': 'view-title' });
  catalog.append(make('h2', 'view-title', '功能性 Agent', 'bento-sr-only'), make('div', 'cards', undefined, '', { 'aria-live': 'polite' }));
  const navigation = make('nav', 'navigation', undefined, 'bento-tile', { 'aria-label': 'Agent 分类' });
  r.sort = select(ctx, 'sort', '目录排序', [['default', '默认排序'], ['last7d', '近期排序'], ['total', '累计排序']], a.sort);
  r.sort.options[1].title = '按近 7 天调用次数排序';
  const recent = make('section', 'recent-history', undefined, 'bento-tile bento-home-recent', { 'aria-label': '最近调用' });
  const allHistory = control(ctx, '全部历史 →', '历史调用', 'all-history', () => a.showView('history'), 'text-link'); allHistory.id = 'all-history';
  const statsEntry = control(ctx, '调用统计 →', '调用统计', 'stats-recent-open', () => a.openStats(), 'text-link'); statsEntry.id = 'stats-recent-open';
  // v0.14: saved 调用组 sit next to recent calls.
  const groupsEntry = control(ctx, '调用组 →', '调用组', 'groups-open', () => a.openGroups(), 'text-link'); groupsEntry.id = 'groups-open';
  recent.append(region(doc, 'div', 'bento-recent-heading', node(doc, 'h2', '最近调用'), region(doc, 'span', 'bento-recent-links', groupsEntry, statsEntry)), make('div', 'recent-history-list'), allHistory);
  const running = make('section', 'running-panel', undefined, 'bento-tile', { 'aria-label': '运行中的会话' });
  const runningTitle = control(ctx, '运行中 0', '运行中的会话', 'running-title', () => a.showView('running'), 'tile-heading'); runningTitle.id = 'running-title'; r[runningTitle.id] = runningTitle;
  const reverify = control(ctx, '全部重新核验', '全部重新核验范围内 Agent 的旧记录', 'reverify-all', a.reverifyAll); reverify.id = 'reverify-all'; r[reverify.id] = reverify;
  const runningTools = make('details', 'running-tools'); runningTools.append(node(doc, 'summary', '核验与刷新'), control(ctx, '刷新会话', '刷新运行中的会话', 'refresh-running', a.refreshRunning), reverify);
  running.append(runningCloseHeading(ctx,runningTitle), make('div', 'running-list', undefined, '', { 'aria-live': 'polite' }), runningTools, make('p', 'reverify-all-status', '', '', { role: 'status', 'aria-live': 'polite' }));
  const coverageTile = make('section', 'coverage-tile', undefined, 'bento-tile');
  coverageTile.append(control(ctx, '扫描与覆盖', '扫描摘要和数据覆盖', 'coverage-open', () => a.showView('coverage'), 'tile-heading'), make('p', 'coverage-summary', '', 'muted'));

  const back = control(ctx, '← 返回便当格', '返回便当格', 'bento-back', () => a.showView('catalog'), 'text-link'); back.id = 'bento-back'; r[back.id] = back;
  const history = make('section', 'history-panel', undefined, '', { 'aria-label': '历史调用' });
  const historyFilter = select(ctx, 'history-filter', '历史筛选', [['all', '全部'], ['launch', '单次'], ['joint', '联合']], a.setHistoryFilter);
  const refreshHistory = control(ctx, '刷新历史', '刷新历史', 'history-refresh', a.refreshHistory); refreshHistory.id = 'history-refresh';
  history.append(region(doc, 'div', 'view-heading', node(doc, 'h2', '历史调用'), region(doc, 'div', 'history-controls', historyFilter, refreshHistory)),
    make('p', 'history-status', '', '', { role: 'status', 'aria-live': 'polite' }), make('div', 'history-list'));
  const recentPanel = make('details', 'recent-panel', undefined, 'bento-tile');
  recentPanel.append(node(doc, 'summary', '最近的推荐与联合调用（20 条）'), make('div', 'recent-list')); history.append(recentPanel);
  const coverage = make('section', 'coverage-panel', undefined, 'bento-tile', { 'aria-label': '扫描摘要和数据覆盖' });
  const scan = make('details', 'scan'); scan.append(make('summary', 'scan-summary'), make('div', 'scan-detail')); scan.open = true;
  const statsRefresh = control(ctx, '重新统计', '重新统计', 'stats-refresh', a.refreshStats); statsRefresh.id = 'stats-refresh';
  const statsCoverage = make('details', 'stats-coverage'); statsCoverage.append(make('summary', 'stats-summary'), make('div', 'stats-detail'), statsRefresh); statsCoverage.open = true;
  coverage.append(node(doc, 'h2', '扫描与覆盖'), scan, statsCoverage);
  const detail = make('dialog', 'detail', undefined, 'bento-detail');
  const close = control(ctx, '关闭', '关闭详情', 'close-detail', a.closeDetail); close.id = 'close-detail';
  detail.append(region(doc, 'div', 'drawer-heading', make('h2', 'detail-title'), close), make('div', 'detail-body'));
  r.dialog = manageDialog(doc, detail, { labelledby: 'detail-title', initialFocus: close });
  detail.addEventListener('close', () => { if (!r.disposing && ctx.state.detailOpen) a.closeDetail(); });
  r.dispose = () => { r.disposing = true; if (detail.open) r.dialog.close(); };
  const grid = make('main', 'bento-grid', undefined, 'bento-grid');
  const today = make('section', 'concepts-today', undefined, 'bento-concept-tile bento-home-concept', { 'aria-label': '今日概念' });
  today.addEventListener('click', e => { if (!e.target.closest('button')) return openFeaturedConcept(ctx); });
  const concepts = make('section', 'concepts-panel', undefined, '', { 'aria-labelledby': 'concepts-title' }); concepts.hidden = true;
  const conceptsTitle = make('h2', 'concepts-title', '随机概念', '', { tabindex: '-1' });
  const conceptBack = control(ctx, '← 返回便当格', '返回便当格', 'concepts-back', () => a.showView('catalog'), 'text-link');
  r.conceptsNext = conceptControl(ctx, '再来一个', 'next', a.nextConcept);
  const archive = make('nav', 'concepts-archive', undefined, 'bento-concept-tile', { 'aria-label': '概念存档' });
  const reading = make('article', 'concepts-reading', undefined, 'bento-concept-tile');
  const perspectives = make('section', 'concepts-perspectives', undefined, '', { 'aria-label': '多视角分析结果' });
  concepts.append(region(doc, 'div', 'view-heading', conceptsTitle, region(doc, 'div', 'bento-concept-actions', conceptBack, r.conceptsNext)),
    make('div', 'concepts-messages', undefined, '', { role: 'status', 'aria-live': 'polite' }),
    region(doc, 'div', 'bento-concept-grid', archive, region(doc, 'div', 'bento-concept-content', reading, perspectives)));
  grid.append(ask, metrics, top, today, recent, resultsPanel, catalog, navigation, running, coverageTile);
  r.statsPanel = make('main', 'stats-panel', undefined, 'bento-stats', { 'aria-labelledby': 'stats-title' }); r.statsPanel.hidden = true;
  return region(doc, 'div', 'layout-bento', header, renderCandidateNotice(ctx), back, grid, history, coverage, detail, concepts, r.statsPanel);
}
function updateVisibility(ctx) {
  const { refs: r, state: s } = ctx, home = s.view === 'catalog', recommend = s.view === 'recommend';
  ctx.root.setAttribute('data-view', s.view);
  r['bento-grid'].hidden = !home && !recommend && s.view !== 'running';
  r['recommend-panel'].hidden = !home && !recommend;
  for (const id of ['metrics', 'top-agents', 'concepts-today', 'catalog', 'navigation', 'recent-history', 'coverage-tile']) r[id].hidden = !home;
  r['running-panel'].hidden = !home && s.view !== 'running';
  r['history-panel'].hidden = s.view !== 'history'; r['coverage-panel'].hidden = s.view !== 'coverage';
  r['bento-back'].hidden = home || ['concepts', 'stats'].includes(s.view);
}

const conceptActive = value => ['queued', 'running'].includes(value?.status);
function conceptControl(ctx, text, key, callback, disabled = false) {
  const button = control(ctx, text, text, `concepts-${key}`, () => callback(), 'bento-concept-button');
  button.disabled = !!disabled; return button;
}
async function openFeaturedConcept(ctx) {
  const id = ctx.refs.featuredConcept?.conceptId;
  await ctx.actions.openConcepts();
  if (id) await ctx.actions.selectConcept(id);
}
function conceptSource(record) {
  const title = cleanTitle(record.agent?.title || record.agent?.bookLabel);
  return `《${title.text || '书名未载明'}》${title.multi > 1 ? ` 等 ${title.multi} 本` : ''} · ${record.agent?.name || 'Agent 未载明'}`;
}
function conceptBadge(doc) { return node(doc, 'span', '今日', 'concept-today-badge'); }
function conceptNotice(doc, text) { return node(doc, 'p', text, 'bento-concept-warning'); }
function conceptTerm(record) { return record?.result?.term || record?.term; }
function termTranslations(doc, term) {
  const line = node(doc, 'span', undefined, 'bento-term-translations');
  for (const lang of ['en', 'fr']) if (term?.[lang]) {
    if (line.children.length) line.append(node(doc, 'span', ' · '));
    const text = node(doc, 'span', term[lang]); text.setAttribute('lang', lang); line.append(text);
  }
  return line;
}
function appendConceptSubtitle(doc, target, record) {
  const term = conceptTerm(record);
  if (term) {
    target.append(termTranslations(doc, term));
    if (record.result?.concept || record.concept) target.append(node(doc, 'span', record.result?.concept || record.concept, 'bento-term-subtitle'));
  } else if (record.result?.conceptEn || record.conceptEn) target.append(termTranslations(doc, { en: record.result?.conceptEn || record.conceptEn }));
}
function conceptEvidence(doc, record) {
  const verified = record.verify?.state === 'ok', structure = record.verify?.skillStructure;
  const structureOk = structure?.state === 'ok' && !structure.missing?.length && structure.titleLine !== false;
  const evidence = region(doc, 'div', 'bento-concept-evidence',
    node(doc, 'p', `Agent 核验：${verified ? '通过' : record.verify?.state === 'violation' ? '违规' : '未确认'}`, verified ? 'bento-concept-mark' : 'bento-concept-warning'),
    node(doc, 'p', `讲解结构（11 小节）：${structureOk ? '通过' : `未通过或未确认；缺少小节 ${(structure?.missing || []).join('、') || '未知'}${structure?.titleLine === false ? '；缺少标题行' : ''}`}`, structureOk ? 'bento-concept-mark' : 'bento-concept-warning'));
  if (record.thinkError) evidence.append(conceptNotice(doc, `THINK 另存失败：${record.thinkError}`));
  return evidence;
}
export function renderConcepts(ctx, model) {
  const { doc, refs: r, actions: a } = ctx;
  model ||= { items: [], today: undefined, selected: null, running: null, busy: false, error: '' };
  const panel = r['concepts-panel'], viewing = ctx.state.view === 'concepts', entering = viewing && panel.hidden;
  const returning = !viewing && !panel.hidden && panel.contains(doc.activeElement);
  updateVisibility(ctx); panel.hidden = !viewing;
  // Another layout may have set this temporary A2 wrapper attribute before switching.
  ctx.root.parentElement?.removeAttribute('data-concepts-open');
  const record = model.selected, todayId = model.today?.conceptId, todayLoading = model.today === undefined;
  const today = todayId ? (record?.conceptId === todayId ? record : model.items.find(item => item.conceptId === todayId)) : null;
  const recent = !todayLoading && !todayId ? model.items.filter(item => item.status === 'done' && item.result)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0] : null;
  const featured = today || (recent && record?.conceptId === recent.conceptId ? record : recent);
  r.featuredConcept = featured || (todayId ? { conceptId: todayId, status: model.today.status } : null);
  const generationBusy = !!model.busy || !!model.running || conceptActive(record) || conceptActive(today);
  const runningText = model.running ? `概念生成${conceptStatus({ status: 'running', ...model.running })}` : '';
  const homeKey = JSON.stringify([r.featuredConcept, todayId, todayLoading, featured ? conceptStatus(featured) : '', generationBusy, model.busy, runningText, model.error]);
  if (r.conceptHomeKey !== homeKey) {
    r.conceptHomeKey = homeKey;
    const target = r['concepts-today'], labelText = !todayId && featured ? '最近概念' : '今日概念';
    target.setAttribute('aria-label', labelText);
    const label = region(doc, 'div', 'bento-concept-label', node(doc, 'span', labelText), todayId ? conceptBadge(doc) : null);
    if (!todayId && featured) {
      const date = featured.day || formatDate(featured.createdAt).slice(0, 10);
      const time = node(doc, 'time', date, 'bento-concept-source');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) time.setAttribute('datetime', date);
      label.append(time);
    }
    const entry = control(ctx, conceptTerm(featured)?.zh || featured?.result?.concept || (todayLoading ? '今日讲解载入中…' : todayId ? (featured?.status === 'failed' ? '今日概念生成失败' : '正在准备今日概念') : '今日讲解尚未生成'), '随机概念', 'concepts-open', () => openFeaturedConcept(ctx), 'bento-concept-title'); entry.id = 'concepts-open';
    target.replaceChildren(label, region(doc, 'h2', '', entry));
    if (featured) {
      appendConceptSubtitle(doc, target, featured);
      target.append(markAgentLink(node(doc, 'p', conceptSource(featured), 'bento-concept-source'), featured.agent));
      if (featured.result?.oneLine) target.append(node(doc, 'p', featured.result.oneLine, 'bento-concept-summary'));
      target.append(node(doc, 'p', conceptStatus(featured), 'bento-concept-status'));
      const note = conceptResponseNote(doc, today); if (note) target.append(note);
      if (featured.error) target.append(conceptNotice(doc, `失败原因：${featured.error}`));
      if ((featured.result || featured.thinkError || featured.verify?.state === 'violation')) target.append(conceptEvidence(doc, featured));
    }
    if (!todayLoading && !todayId) target.append(node(doc, 'p', `${featured ? '今日讲解尚未生成 · ' : ''}今日 09:00 自动生成`, 'bento-concept-status'));
    if (runningText) target.append(node(doc, 'p', runningText, 'bento-concept-status'));
    if (model.busy) target.append(node(doc, 'p', '正在提交…', 'bento-concept-status'));
    if (model.error) target.append(conceptNotice(doc, model.error));
    const actions = region(doc, 'div', 'bento-concept-actions',
      conceptControl(ctx, '再来一个', 'home-next', a.nextConcept, generationBusy),
      conceptControl(ctx, '多视角分析', 'home-perspectives', () => a.openPerspectivePicker(featured.conceptId), model.busy || !featured?.result || featured.status !== 'done' || featured.perspectives?.some(conceptActive)));
    if (today?.status === 'failed') actions.append(conceptControl(ctx, '重试（生成新概念）', 'home-retry', a.nextConcept, generationBusy));
    target.append(actions);
  }
  if (returning) doc.getElementById('concepts-open')?.focus();
  if (!viewing) return;
  renderConceptThread(ctx, model, panel);
  r.conceptsNext.disabled = generationBusy;
  const messagesKey = JSON.stringify([model.busy, model.error, runningText]);
  if (r.conceptMessagesKey !== messagesKey) {
    r.conceptMessagesKey = messagesKey; const messages = r['concepts-messages']; messages.replaceChildren();
    if (model.busy) messages.append(node(doc, 'p', '正在提交…', 'bento-concept-status'));
    if (runningText) messages.append(node(doc, 'p', runningText, 'bento-concept-status'));
    if (model.error) {
      const error = conceptNotice(doc, model.error); error.setAttribute('role', 'alert');
      messages.append(error, conceptControl(ctx, '重新读取', 'refresh', a.openConcepts, model.busy));
    }
  }
  const archiveKey = JSON.stringify([model.items, model.items.map(item => conceptStatus(item)), todayId, record?.conceptId]);
  if (r.conceptArchiveKey !== archiveKey) {
    r.conceptArchiveKey = archiveKey; const archive = r['concepts-archive']; archive.replaceChildren(node(doc, 'h3', '概念存档'));
    const items = [...model.items].sort((a, b) => Number(b.conceptId === todayId) - Number(a.conceptId === todayId));
    for (const item of items) {
      const term = conceptTerm(item), title = term?.zh || item.result?.concept || item.concept || '待生成概念';
      const entry = conceptControl(ctx, title, `select-${item.conceptId}`, () => a.selectConcept(item.conceptId));
      entry.className = 'bento-concept-archive-entry'; entry.setAttribute('data-concept-id', item.conceptId);
      entry.replaceChildren(region(doc, 'span', 'bento-concept-label', node(doc, 'strong', title), item.conceptId === todayId ? conceptBadge(doc) : null));
      appendConceptSubtitle(doc, entry, item);
      entry.append(node(doc, 'small', `${item.day || formatDate(item.createdAt)} · ${conceptStatus(item)}`));
      entry.setAttribute('aria-label', [title, term?.en, term?.fr, term ? item.result?.concept || item.concept : null].filter(Boolean).join(' · '));
      if (item.conceptId === record?.conceptId) entry.setAttribute('aria-current', 'page'); archive.append(entry);
    }
    if (!items.length) archive.append(node(doc, 'p', '暂无存档，可点击「再来一个」。', 'bento-concept-status'));
  }
  renderConceptReading(ctx, record, model, generationBusy);
  renderConceptPerspectives(ctx, record, model);
  if (entering) r['concepts-title'].focus();
}
function renderConceptReading(ctx, record, model, generationBusy) {
  const { doc, refs: r, actions: a } = ctx, body = r['concepts-reading'];
  // Keep completed Markdown mounted when elapsed time, picker state or another job updates.
  const { perspectives, ...reading } = record || {};
  const key = JSON.stringify([reading, model.today?.conceptId]);
  if (r.conceptReadingKey !== key) {
    r.conceptReadingKey = key; body.replaceChildren();
    r.conceptRetry = r.conceptAnalyze = r.conceptContinue = r.conceptRecordStatus = null;
    if (!record) { body.append(node(doc, 'p', '请选择概念或等待详情读取。', 'bento-concept-status')); return; }
    const result = record.result;
    body.append(region(doc, 'div', 'bento-concept-label', node(doc, 'span', '概念讲解'), record.conceptId === model.today?.conceptId ? conceptBadge(doc) : null),
      node(doc, 'h2', conceptTerm(record)?.zh || result?.concept || '正在准备概念', 'bento-concept-heading'));
    appendConceptSubtitle(doc, body, record);
    body.append(markAgentLink(node(doc, 'p', conceptSource(record), 'bento-concept-source'), record.agent));
    r.conceptRecordStatus = node(doc, 'p', '', 'bento-concept-status'); r.conceptRecordStatus.setAttribute('role', 'status'); body.append(r.conceptRecordStatus);
    if (record.error) body.append(conceptNotice(doc, `失败原因：${record.error}`));
    if (record.status === 'failed') {
      r.conceptRetry = conceptControl(ctx, '重试（生成新概念）', 'retry', a.nextConcept);
      body.append(r.conceptRetry);
    }
    if (result) {
      body.append(node(doc, 'p', result.oneLine, 'bento-concept-summary'), region(doc, 'aside', 'bento-concept-why',
        node(doc, 'strong', '为什么你可能不知道'), node(doc, 'p', result.whyUnknown)));
      r.conceptAnalyze = conceptControl(ctx, '多视角分析', 'perspectives', () => a.openPerspectivePicker(record.conceptId));
      r.conceptContinue = conceptControl(ctx, '在终端中继续', 'continue', () => a.continueInJoint(record.conceptId));
      body.append(region(doc, 'div', 'bento-concept-actions', r.conceptAnalyze, r.conceptContinue));
    }
    if ((record.result || record.thinkError || record.verify?.state === 'violation')) body.append(conceptEvidence(doc, record));
    if (record.poolWarning) body.append(conceptNotice(doc, record.poolWarning));
    if (result?.sourceRefs?.length) body.append(node(doc, 'p', `书内出处：${result.sourceRefs.join('；')}`, 'bento-concept-source'));
    const response = conceptResponse(ctx, record); if (response) body.append(response);
    if (result) body.append(renderMarkdown(doc, result.markdown));
  }
  if (r.conceptRecordStatus) r.conceptRecordStatus.textContent = conceptStatus(record);
  if (r.conceptRetry) r.conceptRetry.disabled = generationBusy;
  if (r.conceptAnalyze) r.conceptAnalyze.disabled = !!model.busy || record.status !== 'done' || !!perspectives?.some(conceptActive);
  if (r.conceptContinue) r.conceptContinue.disabled = !!model.busy;
}
function renderConceptPerspectives(ctx, record, model) {
  const { doc, refs: r, actions: a } = ctx, target = r['concepts-perspectives'], runs = record?.perspectives || [];
  const key = JSON.stringify([record?.conceptId, record?.status, runs, runs.map(run => conceptStatus(run)), model.busy]);
  if (r.conceptPerspectivesKey === key) return;
  r.conceptPerspectivesKey = key; target.replaceChildren();
  if (!record) return;
  target.append(node(doc, 'h3', '多视角分析', 'bento-concept-section-title'));
  if (!runs.length) target.append(node(doc, 'p', '还没有多视角分析。选择其他 Agent，听听他们的看法。', 'bento-concept-tile bento-concept-status'));
  for (const run of runs) {
    const group = node(doc, 'section', undefined, 'bento-perspective-run');
    const status = node(doc, 'h4', `多视角 · ${conceptStatus(run)}`, 'bento-concept-status'); status.setAttribute('role', 'status'); group.append(status);
    if (run.error) group.append(conceptNotice(doc, `失败原因：${run.error}`));
    if (run.status === 'failed') group.append(conceptControl(ctx, '重试多视角分析', `retry-${run.runId}`,
      () => a.runPerspectives(record.conceptId, (run.agents || []).map(agent => agent.id)), model.busy || runs.some(conceptActive) || record.status !== 'done'));
    const parallel = typeof run.verify?.parallel === 'object' ? run.verify.parallel?.state : run.verify?.parallel;
    const parallelOk = parallel === true || parallel === 'ok', verified = run.verify?.state === 'ok' && !run.verify?.violations?.length;
    group.append(node(doc, 'p', `多视角核验：${verified ? '通过' : run.verify?.state === 'violation' ? '违规' : '未确认'}；并行：${parallelOk ? '通过' : '未通过或未确认'}${run.verify?.violations?.length ? `；${JSON.stringify(run.verify.violations)}` : ''}`,
      verified && parallelOk ? 'bento-concept-mark' : 'bento-concept-warning'));
    const cards = node(doc, 'div', undefined, 'bento-perspective-cards');
    for (const result of run.results || []) cards.append(region(doc, 'article', 'bento-concept-tile bento-perspective-card',
      markAgentLink(node(doc, 'h4', result.name || result.agentId), {id:result.agentId}), renderMarkdown(doc, result.analysis)));
    if (!run.results?.length) cards.append(node(doc, 'p', conceptActive(run) ? '正在等待各位 Agent 的分析…' : '暂无分析正文。', 'bento-concept-tile bento-concept-status'));
    group.append(cards); target.append(group);
  }
}
function launchButton(ctx, agent, cli, key, full = false) {
  const name = cli === 'claude' ? 'Claude' : 'Codex';
  const button = control(ctx, '', `在 ${name} CLI 中调用 ${agent.name}`, key, () => ctx.actions.launch(agent.id, cli), `launch-${cli}`);
  // Keep the full spoken action while shortening its visible caption on the tile.
  button.append(node(ctx.doc, 'span', '在 ', full ? '' : 'bento-sr-only'), node(ctx.doc, 'span', name), node(ctx.doc, 'span', ' CLI 中调用', full ? '' : 'bento-sr-only'));
  button.disabled = !!agent.launchBusy || !agent.platforms[cli]?.available;
  if (button.disabled) {
    button.title = agent.launchBusy ? '启动进行中，请等待' : agent.platforms[cli]?.reason || '入口不可用';
    const reason = node(ctx.doc, 'span', button.title, 'bento-sr-only'); reason.id = `${key}-reason`;
    button.append(reason); button.setAttribute('aria-describedby', reason.id);
  }
  return button;
}
function agentTile(ctx, agent, prefix = 'card') {
  const { doc, actions: a } = ctx;
  const card = node(doc, 'article', undefined, 'agent-tile'); card.setAttribute('data-agent-id', agent.id);
  const title = control(ctx, agent.name, `查看 ${agent.name} 详情`, `${prefix}-detail-${agent.id}`, e => a.openDetail(agent.id, e.currentTarget), 'agent-name');
  markAgentLink(title,agent);
  const subtitle = agent.kind === 'book' ? agent.bookLabel || bookLabel(agent) : agent.purpose || summary(agent.description);
  const copy = region(doc, 'div', 'agent-copy', region(doc, 'h3', '', title), markAgentLink(node(doc, 'p', subtitle, 'agent-subtitle'), agent));
  const badge = node(doc, 'span', agent.stats7 !== null && agent.stats7 !== undefined && agent.statsTotal !== null && agent.statsTotal !== undefined
    ? `7 天 ${agent.stats7} · 累计 ${agent.statsTotal}` : categoryShort(agent.primary), 'agent-badge'); badge.title = badge.textContent;
  card.append(region(doc, 'div', 'agent-heading', copy, badge), region(doc, 'div', 'tile-actions', launchButton(ctx, agent, 'claude', `${prefix}-launch-${agent.id}-claude`), launchButton(ctx, agent, 'codex', `${prefix}-launch-${agent.id}-codex`)));
  if (agent.stats7 === null || agent.statsTotal === null) card.append(node(doc, 'span', agent.statsState === 'building' ? '调用统计：统计中…' : '调用统计：暂无数据', 'bento-sr-only'));
  card.addEventListener('click', event => { if (!event.target.closest('button, input, label, select')) return a.openDetail(agent.id, title); });
  if (agent.launchStatus) { const status = node(doc, 'div'); status.setAttribute('aria-live', 'polite'); renderStatus(doc, status, agent.launchStatus); card.append(status); }
  return card;
}
export function renderCatalog(ctx, model) {
  const { refs: r } = ctx;
  updateVisibility(ctx);
  r['view-title'].textContent = model.title; r.catalog.setAttribute('aria-label', model.title);
  if (r.search.value !== model.query) r.search.value = model.query;
  r.sort.value = model.sort;
  r.cards.replaceChildren(...model.agents.map(agent => {
    const card = agentTile(ctx, agent); if (agent.id === model.selectedId) card.setAttribute('data-selected', 'true'); return card;
  }));
  if (model.empty) r.cards.append(emptyCatalog(ctx, model.empty, 'empty-tile'));
  else if (!model.agents.length) r.cards.append(node(ctx.doc, 'p', model.query ? '没有匹配的 Agent' : '当前分类没有 Agent。', 'empty-tile'));
}
export function renderCategories(ctx, categories) {
  renderCandidateNotice(ctx, ctx.state.candidateCount);
  const { doc, refs: r, actions: a } = ctx;
  r.navigation.replaceChildren(node(doc, 'span', '书籍分类', 'category-label'));
  for (const c of categories) {
    const button = control(ctx, '', `${c.label} ${c.count}`, `nav-${c.key}`, () => a.selectCategory(c.key), 'category-pill');
    // Parentheses remain in the spoken text; the visible capsule separates the count by spacing.
    button.append(node(doc, 'span', c.label), node(doc, 'span', '（', 'bento-sr-only'), node(doc, 'span', String(c.count), 'category-count'), node(doc, 'span', '）', 'bento-sr-only'));
    button.title = c.fullLabel; if (c.selected) button.setAttribute('aria-current', 'page'); r.navigation.append(button);
  }
  r.navigation.append(r.sort);
}
export function renderMetrics(ctx, model) {
  const { doc, refs: r } = ctx, count = value => value ?? '未知';
  const recent = model.recent7 ?? (model.statsState === 'building' ? '统计中…' : '暂无数据');
  const first = control(ctx, '', `近 7 天调用 ${recent} · 查看调用统计`, 'stats-open', () => ctx.actions.openStats(), 'metric-tile'); first.id = 'stats-open';
  first.append(node(doc, 'span', '近 7 天调用'), node(doc, 'strong', String(recent)), node(doc, 'small', `功能性 ${count(model.recentByKind.role)} · 书籍 ${count(model.recentByKind.book)}`));
  const total = region(doc, 'div', 'metric-tile metric-total', node(doc, 'span', 'Agent 总数'), node(doc, 'strong', String(model.total)), node(doc, 'small', `${model.roles} 角色 · ${model.books} 书籍 · 同步 ${count(model.sync.ok)} / ${model.sync.total}`));
  r.metrics.replaceChildren(first, total);
  if (model.scopeLimited) {
    const info = node(doc, 'span', 'ⓘ', 'scope-info'); info.id = 'stats-scope-hint'; info.title = model.scopeReasons.join('\n'); info.setAttribute('aria-label', `统计范围有限：${info.title}`); first.append(info); first.setAttribute('aria-describedby', info.id); first.title = info.title;
  }
  r['top-agents'].replaceChildren(node(doc, 'h2', '最常用'));
  const maximum = Math.max(1, ...model.top.map(item => item.count));
  for (const item of model.top.slice(0, 5)) {
    const fill = node(doc, 'span', undefined, 'usage-fill');
    fill.style?.setProperty('width', `${Math.max(0, Math.min(100, item.count / maximum * 100))}%`);
    const track = region(doc, 'span', 'usage-track', fill);
    for (const [key, value] of Object.entries({ role: 'meter', 'aria-label': `${item.name} 累计调用`, 'aria-valuemin': 0, 'aria-valuemax': maximum, 'aria-valuenow': item.count })) track.setAttribute(key, value);
    r['top-agents'].append(region(doc, 'div', 'usage-row', markAgentLink(node(doc, 'span', item.name, 'usage-name'), item), track, node(doc, 'span', String(item.count), 'usage-count')));
  }
  if (!model.top.length) r['top-agents'].append(node(doc, 'p', model.statsState === 'building' ? '统计中…' : '暂无数据', 'muted'));
}
// Preserve all explanatory paragraphs, without showing authoring examples as UI copy.
function fullDescription(text = '') { return String(text).replace(/<example\b[^>]*>[\s\S]*?<\/example>/gi, '').trim(); }
export function renderDetail(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, body = r['detail-body'];
  const key = JSON.stringify([model, ctx.state.view]);
  if (r.detailKey !== key) {
    r.detailKey = key;
    const expanded = new Set(r.detailAgentId === model?.id ? Array.from(body.querySelectorAll('details')).filter(n => n.open).map(n => n.getAttribute('data-section')) : []);
    r.detailAgentId = model?.id; r['detail-title'].textContent = model?.name || '请选择 Agent'; r['detail-title'].removeAttribute('data-agent-link'); if(model)markAgentLink(r['detail-title'],model); body.replaceChildren();
    if (model) {
      if (model.book) body.append(markAgentLink(node(doc, 'p', `${bookLabel(model)} · ${model.authorShort} · ${model.book.edition || '版本未载明'}`, 'detail-subtitle'), model));
      const chips = region(doc, 'div', 'detail-chips');
      for (const chip of model.chips || []) { const el = node(doc, 'span', chip.label, `detail-chip ${chip.tone}`); el.title = chip.title || ''; chips.append(el); }
      body.append(chips, node(doc, 'p', model.summary || '无描述', 'detail-description'));
      body.append(node(doc, 'p', model.statsState === 'building' ? '统计中…' : model.stats7 === null ? '暂无数据' : `近 7 天 ${model.stats7} · 累计 ${model.statsTotal ?? '未知'}`, 'detail-stats'));
      const controls = region(doc, 'div', 'detail-actions', launchButton(ctx, model, 'claude', 'detail-launch-claude', true), launchButton(ctx, model, 'codex', 'detail-launch-codex', true), inAppButton(doc, model, a),
        control(ctx, '加入联合调用', `加入联合调用 ${model.name}`, 'detail-add', e => a.addToJoint(model.id, e.currentTarget, true)));
      controls.append(pinButton(doc,model,a),openFileButton(doc,model,a));body.append(controls);
      for (const cli of ['claude', 'codex']) if (!model.platforms[cli]?.available) body.append(node(doc, 'p', `${cli}：${model.platforms[cli]?.reason || '入口不可用'}`, 'reason'));
      const history = node(doc, 'section'); drawAgentHistory(doc, history, model, model.history, item => a.resume(model.id, item.cli, item.launchId), () => a.reverifyAgent(model.id)); body.append(history);
      if (model.historyMessage) body.append(node(doc, 'p', model.historyMessage, 'reason'));
      if (model.launchStatus) { const target = node(doc, 'div'); renderStatus(doc, target, model.launchStatus); body.append(target); }
      function section(id, title, contents) {
        const details = region(doc, 'details', 'detail-section', node(doc, 'summary', title), contents);
        details.setAttribute('data-section', id); details.open = expanded.has(id);
        details.querySelector('summary').setAttribute('data-focus-key', `detail-section-${id}`); body.append(details);
      }
      section('description', '完整说明', node(doc, 'p', fullDescription(model.fullDescription), 'full-description'));
      for (const item of model.sections || []) {
        const rows = node(doc, 'dl');
        for (const row of item.rows) rows.append(node(doc, 'dt', row.label), markAgentLink(node(doc, 'dd', row.label === '书名' ? cleanTitle(row.value).text : row.value), row.label === '书名' ? model : null));
        section(item.key, item.title, rows);
      }
      if (!model.sections?.some(s => s.key === 'stats')) section('stats', '调用统计', node(doc, 'p', model.statsState === 'building' ? '统计中…' : '暂无数据'));
    }
  }
  if (ctx.state.detailOpen && ctx.state.view !== 'history' && model) { if (!r.detail.open) r.dialog.open(); }
  else if (r.detail.open && (!ctx.state.detailOpen || (!model && ctx.state.view !== 'history'))) r.dialog.close();
}
function historyTile(ctx, item, compact = false, detail = false) {
  const { doc, actions: a, refs: r } = ctx, names = item.agents.map(agent => agent.name).join('、');
  const card = node(doc, 'article', undefined, compact ? 'recent-call' : 'history-tile');
  const type = item.typeLabel || (item.type === 'joint' ? '联合' : '单次');
  const kind = region(doc, 'span', 'history-kind', node(doc, 'span', type, 'history-type'));
  if (item.type === 'joint') kind.append(node(doc, 'span', `${item.agents.length} 个`, 'history-members-count'));
  const cli = item.cliLabel || (item.cli === 'claude' ? 'Claude' : item.cli === 'codex' ? 'Codex' : item.cli || '未声明');
  const state = item.status?.message?.endsWith(' · 会话已结束') ? item.status.message : labels[item.status?.overall] || item.status?.overall || '未确认';
  const chip = node(doc, 'span', state, 'history-state');
  chip.setAttribute('data-tone', ['ok','fail','running','pending','neutral'].includes(item.statusTone) ? item.statusTone : 'pending');
  card.append(kind, control(ctx, names, `查看调用记录 ${names}`, `history-select-${compact ? 'recent' : detail ? 'detail' : 'all'}-${item.type}-${item.id}`, e => a.selectHistory(item.type, item.id, e.currentTarget), 'history-name'),
    node(doc, 'time', formatDate(item.createdAt), 'history-date'), node(doc, 'span', cli, 'history-cli'), chip);
  if (!compact) {
    if (item.inputPreview) card.append(node(doc, 'p', item.inputPreview, 'history-preview'));
    if (detail) card.append(node(doc, 'p', `模式：${item.modeLabel || item.mode || '未声明'} · 来源：${item.sourceLabel || item.source || '未声明'}${item.resumeOf ? ` · 恢复自 ${item.resumeOf}` : ''}${item.rerunOf ? ` · 重跑自 ${item.rerunOf}` : ''}`));
  }
  const run = control(ctx, '重新调用', `重新调用 ${names}`, `history-run-${compact ? 'recent' : detail ? 'detail' : 'all'}-${item.type}-${item.id}`, () => a.rerun(item.type, item.id), 'history-rerun'); run.disabled = !!r.historyBusy;
  const resume = control(ctx, '继续', `继续该次会话 ${names}`, `history-resume-${compact ? 'recent' : detail ? 'detail' : 'all'}-${item.type}-${item.id}`, () => a.resumeHistory(item.type, item.id), 'history-resume'); resume.disabled = !!r.historyBusy || !item.canResume;
  if (!item.canResume) { resume.title = item.resumeReason || '此会话尚不可恢复'; if (!compact) card.append(node(doc, 'p', resume.title, 'reason')); }
  fillAgentNames(doc,card.querySelector('.history-name'),item.agents);card.append(region(doc, 'div', 'history-actions', run, resume)); return card;
}
export function renderHistory(ctx, model) {
  const { doc, refs: r } = ctx; r.historyBusy = model.busy;
  r['history-filter'].value = model.filter; r['history-status'].textContent = model.message;
  for (const [id, items, compact] of [['history-list', model.items, false], ['recent-history-list', model.recent.slice(0, 5), true]]) {
    r[id].replaceChildren(...items.map(item => historyTile(ctx, item, compact)));
    if (!items.length) r[id].append(node(doc, 'p', '暂无调用记录', 'muted'));
  }
  if (ctx.state.view === 'history' && ctx.state.detailOpen && model.selected) {
    fillAgentNames(doc,r['detail-title'],model.selected.agents); r['detail-body'].replaceChildren(historyTile(ctx, model.selected, false, true));
    if (!r.detail.open) r.dialog.open();
  }
}
export function renderRunning(ctx, items) {
  const { refs: r } = ctx; r['running-title'].textContent = `运行中 ${items.length}`;
  updateRunningClose(ctx,items);drawRunning(ctx.doc, r['running-list'], { items },ctx);
  r['reverify-all'].disabled = !!ctx.state.reverifyBusy; r['reverify-all-status'].textContent = ctx.state.reverifyMessage || '';
}
export function renderCoverage(ctx, model) {
  const { doc, refs: r } = ctx, registry = model.registry;
  drawCoverage(doc, r['stats-detail'], model.stats);
  r['stats-summary'].textContent = `数据覆盖 · ${model.stats?.building ? '统计中…' : !model.stats ? '尚未读取' : model.stats.limited ? '统计范围有限' : '来源可读'}`;
  r['scan-summary'].textContent = `目录扫描 · ${formatDate(registry.scannedAt)} · 范围外 ${registry.summary.outOfScope || 0} · 无法解析 ${registry.summary.failed || 0}`;
  r['coverage-summary'].textContent = `上次扫描 ${formatDate(registry.scannedAt)}\n范围外 ${registry.summary.outOfScope || 0} · 无法解析 ${registry.summary.failed || 0}`;
  const target = r['scan-detail']; target.replaceChildren();
  const rows = [['来源明细', registry.sources.map(s => `${s.path}：${s.available ? `文件 ${s.total}，解析 ${s.parsed}，排除 ${s.excluded}` : `不可读 · ${s.reason}`}`)],
    ['无法解析', registry.sources.flatMap(s => (s.failed || []).map(f => `${f.file}：${f.reason}`))], ['范围外', registry.outOfScope.map(a => `${a.name}：${a.reason}`)],
    ['身份冲突', registry.conflicts.map(c => `${c.id}：${c.reason} · ${c.files.join('；')}`)], ['映射存在、目录缺失', registry.missingFromDisk.map(a => a.name)],
    ...(registry.reports ? [['无 Word 报告的书籍', registry.reports.booksWithout.map(a => `${a.name}：${a.title}`)],
      ['未登记的 Word 报告文件', registry.reports.unusedFiles]] : [])];
  for (const [title, values] of rows) { target.append(node(doc, 'h3', title)); for (const value of values.length ? values : ['无']) target.append(node(doc, 'p', value)); }
}
export function renderRecommend(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, rec = model.recommendation;
  if (r['recommend-input'].value !== model.input) r['recommend-input'].value = model.input;
  r['recommend-count'].textContent = `${model.input.length} / 8000 字`; r['recommend-count'].hidden = model.input.length <= 7000;
  for (const option of r['recommend-engine'].options) { const settings = model.settings?.recommend?.[option.value]; option.textContent = `${option.value === 'claude' ? 'Claude' : 'Codex'} · ${settings?.model || '模型未声明'}`; option.title = `effort ${settings?.effort || '未声明'}`; }
  r['recommend-engine'].value = model.engine; r['recommend-engine'].disabled = !!model.busy;
  r['joint-cli'].value = model.cli; r['joint-cli'].disabled = !!model.jointBusy;
  r['recommend-submit'].disabled = !!model.busy || model.input.length > 8000;
  if (model.input.trim() || model.busy) r['recommend-input'].removeAttribute('aria-invalid');
  const invalid = r['recommend-input'].getAttribute('aria-invalid') === 'true';
  r['recommend-disabled-reason'].className = invalid ? 'task-count' : 'bento-sr-only';
  r['recommend-disabled-reason'].textContent = model.busy ? '推荐进行中，请等待。' : invalid ? '请输入问题' : model.input.length > 8000 ? '输入不能超过 8000 字。' : model.input.trim() ? '可开始分析。' : '';
  r['joint-submit'].disabled = !model.selectedIds.length || !!model.busy || !!model.jointBusy;
  r['selected-count'].textContent = `已选 ${model.selectedIds.length} 个`;
  r['select-all'].disabled = !model.results.length || !!model.busy || !!model.jointBusy;
  r['select-all'].checked = !!model.results.length && model.selectedIds.length === Math.min(8, model.results.length);
  r['select-all'].indeterminate = model.selectedIds.length > 0 && !r['select-all'].checked;
  r['joint-disabled-reason'].textContent = model.jointBusy ? '联合调用启动中，请等待。' : model.busy ? '推荐进行中，请等待。' : !model.selectedIds.length ? '请至少选择一个 Agent。' : '可执行联合调用。';
  r['recommend-output'].hidden = !['catalog', 'recommend'].includes(ctx.state.view) || (!rec && !model.busy);
  r['recommend-actions'].hidden = !model.results.length; r['joint-disabled-reason'].hidden = !model.results.length;
  r['recommend-verification'].hidden = !model.results.length;
  const status = r['recommend-status']; status.replaceChildren();
  if (model.busy && !rec) status.append(node(doc, 'p', '正在推荐 Agent…'));
  if (rec) {
    status.append(node(doc, 'p', `推荐：${labels[rec.status] || rec.status} · ${rec.engine || model.engine} · ${rec.model || '未声明'} · effort ${rec.effort || '未声明'}`));
    if (rec.error) status.append(node(doc, 'p', rec.error, 'error')); if (rec.note) status.append(node(doc, 'p', rec.note));
    if (rec.status === 'done') {
      if (!model.results.length) status.append(node(doc, 'p', '没有合适的 Agent'));
      if (rec.audit?.ok) status.append(node(doc, 'p', `推荐审计通过：Agent 调用 ${rec.audit.agentCalls}，子会话 ${rec.audit.children}`));
      else if (rec.audit?.agentCalls > 0 || rec.audit?.children > 0) status.append(node(doc, 'strong', '推荐阶段出现了 Agent 调用', 'audit-error'));
      else status.append(node(doc, 'p', `推荐审计未确认：${rec.audit?.error || '缺少证据'}`, 'audit-error'));
      for (const reject of rec.rejected || []) status.append(node(doc, 'p', `被拒绝的推荐：${reject.id} · ${reject.reason || ''}`, 'reason'));
    }
  }
  r['recommend-results'].replaceChildren();
  for (const agent of model.results) {
    const card = agentTile(ctx, agent, 'recommend'), check = node(doc, 'input'); check.type = 'checkbox'; check.setAttribute('type', 'checkbox'); check.checked = agent.selected;
    check.disabled = !!model.busy || !!model.jointBusy || (!check.checked && model.selectedIds.length >= 8);
    check.setAttribute('aria-label', `加入联合调用 ${agent.name}`); check.setAttribute('data-focus-key', `recommend-check-${agent.id}`);
    check.addEventListener('change', () => a.selectRecommendationAgent(agent.id, check.checked));
    card.append(region(doc, 'label', 'select-agent', check, node(doc, 'span', '加入联合调用')), node(doc, 'p', `模型理由：${agent.reason}`, 'model-reason'));
    if (!agent.platforms[model.cli.replace('inapp:', '')]?.available) card.append(node(doc, 'p', `${model.cli.replace('inapp:', '')} 不可用：${agent.platforms[model.cli.replace('inapp:', '')]?.reason || '入口不可用'}`, 'reason'));
    r['recommend-results'].append(card);
  }
  r['recent-list'].replaceChildren();
  for (const item of model.recent) {
    if (item.type === 'recommend') r['recent-list'].append(region(doc, 'article', 'recent-recommend', control(ctx, `推荐 · ${item.engine} · ${labels[item.status] || item.status} · ${formatDate(item.createdAt)}`, '查看最近推荐', `recent-recommend-${item.id}`, () => { a.showView('recommend'); return a.selectRecommendation(item.id); }), node(doc, 'p', item.preview)));
    else { const target = node(doc, 'article', undefined, 'joint-card'); drawJointStatus(doc, target, item, item.verification); target.append(control(ctx, '重新核验', '重新核验联合调用', `joint-reverify-${item.id}`, () => a.reverifyJoint(item.id))); r['recent-list'].append(target); }
  }
  if (!model.recent.length) r['recent-list'].append(node(doc, 'p', '暂无推荐与联合调用记录'));
}
const element = node;
function button(doc, text, callback) { return action(doc, text, callback); }
export function drawCoverage(doc, target, stats) {
  if (!target) return;
  target.replaceChildren();
  if (!stats) { target.append(element(doc, 'p', '统计中…')); return; }
  target.append(element(doc, 'p', stats.building ? '统计中…' : `更新时间（本机时区）：${formatDate(stats.generatedAt)}`));
  if (stats.dataDirMigration) target.append(element(doc, 'p', stats.dataDirMigration));
  for (const source of stats.sources) {
    target.append(element(doc, 'h3', source.id), element(doc, 'p', `${source.path}：${source.available ? '可读' : source.missing ? '还没有记录' : '不可读'} · 文件 ${source.files} / 解析 ${source.parsedFiles} · 坏行 ${source.badLines}`),
      element(doc, 'p', `覆盖（本机时区）：${formatDate(source.earliestAt)} → ${formatDate(source.latestAt)}`));
    const failures = element(doc, 'ul');
    for (const failed of source.failedFiles) failures.append(element(doc, 'li', `${failed.file}：${failed.reason}`));
    target.append(failures);
    for (const note of source.notes || []) target.append(element(doc, 'p', note, 'reason'));
  }
  target.append(element(doc, 'p', `范围外事件 ${stats.outOfScopeEvents} · 未标注角色的子会话 ${stats.unlabeledSubagents}`));
  for (const reason of stats.limitedReasons) target.append(element(doc, 'p', reason, 'reason'));
  if (stats.explanations?.length) {
    target.append(element(doc, 'h3', '说明'));
    for (const text of stats.explanations) target.append(element(doc, 'p', text));
  }
}
const stateNames = { alive: '存活', exited: '已退出', ok: '通过', mismatch: '不符', pending: '待核验', confirmed: '已确认', 'awaiting-first-call': '首次提问后核验' };
export function renderStatus(doc, target, status) {
  target.hidden = false; target.className = `status ${status.overall}`;
  target.replaceChildren();
  if (status.notice && ['pending', 'unconfirmed'].includes(status.overall)) {
    const notice = element(doc, 'p', status.notice, 'launch-notice');
    notice.setAttribute('role', 'note'); target.append(notice);
  }
  target.append(element(doc, 'strong', status.message || status.overall));
  if (status.terminalFallback === 'no-wt') target.append(element(doc, 'div', '未找到 Windows Terminal，窗口位置未控制', 'reason'));
  for (const [key, label] of [['process', '进程'], ['cwd', '目录'], ['agent', 'Agent'], ['waiting', '等待输入']]) {
    const item = status[key];
    const extra = key === 'process' && item.pid ? ` · PID ${item.pid}` : key === 'cwd' && item.observed ? ` · ${item.observed}` : '';
    target.append(element(doc, 'div', `${label}：${stateNames[item.state] || item.state}${extra}`));
  }
  if (status.evidenceError) target.append(element(doc, 'div', status.evidenceError, 'reason'));
}
export function pollFinished(status) {
  return ['failed', 'unconfirmed', 'resumed'].includes(status.overall) || (status.overall === 'ready' && status.agent?.state === 'confirmed');
}
const reverifySummary = summary => `已核验 ${summary.checked} 条：找到 ${summary.found} 条，未找到 ${summary.notFound} 条`;
export function drawAgentHistory(doc, target, agent, history, onResume, onReverify) {
  target.replaceChildren(element(doc, 'h3', '继续上次会话'));
  const list = element(doc, 'div'), live = element(doc, 'p'); live.setAttribute('aria-live', 'polite'); live.setAttribute('role', 'status');
  const action = button(doc, '重新核验旧记录', async () => {
    if (action.disabled) return;
    action.disabled = true; action.setAttribute('aria-busy', 'true'); live.textContent = '正在重新核验旧记录…';
    try { const result = await onReverify(); draw(result.history); live.textContent = reverifySummary(result.summary); }
    catch (problem) { live.textContent = `重新核验失败：${problem.message}`; }
    finally { action.disabled = false; action.setAttribute('aria-busy', 'false'); }
  });
  action.setAttribute('data-focus-key', `reverify-${agent.id}`);
  action.setAttribute('aria-label', `重新核验 ${agent.name} 的旧记录`);
  function draw(value) {
    let firstResume;
    list.replaceChildren();
    for (const item of value.items) {
      const resume = button(doc, `${formatDate(item.createdAt)} · ${item.cli} · ${item.mode}`, () => onResume(item));
      resume.setAttribute('data-focus-key', `resume-${agent.id}-${item.launchId}`);
      resume.setAttribute('aria-label', `继续上次会话 ${agent.name} · ${formatDate(item.createdAt)} · ${item.cli} · ${item.mode}`);
      firstResume ??= resume;
      list.append(resume);
    }
    if (!value.items.length) {
      const unavailable = button(doc, '继续上次会话', () => {}); unavailable.disabled = true;
      unavailable.setAttribute('aria-label', `继续上次会话 ${agent.name}`);
      const reason = element(doc, 'p', '暂无可恢复的已核验会话'); reason.id = `resume-${agent.id}-reason`;
      unavailable.setAttribute('aria-describedby', reason.id); list.append(unavailable, reason);
    }
    for (const item of value.unavailable || []) list.append(element(doc, 'p', item.reason, 'reason'));
    action.hidden = !onReverify || !(value.unavailable || []).some(item => item.canReverify);
    if (action.hidden && doc.activeElement === action) firstResume?.focus();
  }
  draw(history); target.append(list);
  if (onReverify && (history.unavailable || []).some(item => item.canReverify)) target.append(action, live);
}
export function drawRunning(doc, target, value, ctx) {
  if (!target) return;
  const states = { pending: '待核验', ready: '已就绪', resumed: '已恢复', failed: '失败', unconfirmed: '未确认', done: '完成' };
  target.replaceChildren();
  for (const item of value.items) {
    const row=fillAgentNames(doc,node(doc,'p'),runningMembers(item));
    row.append(node(doc,'span',` · ${item.cli} · ${formatDate(item.createdAt)} · ${states[item.status?.overall] || item.status?.overall || '待核验'}${item.status?.terminalFallback === 'no-wt' ? ' · 未找到 Windows Terminal，窗口位置未控制' : ''}`));target.append(ctx?runningCloseRow(ctx,item,row):row);
  }
  if (!value.items.length) target.append(element(doc, 'p', '暂无运行中的会话'));
}
const labels = { closed: '已关闭', pending: '待核验', running: '运行中', ready: '已就绪', resumed: '已恢复', done: '完成', failed: '失败', unconfirmed: '未确认', ok: '通过', 'not-parallel': '未并行', violation: '越权', alive: '存活', exited: '已退出', mismatch: '不符' };
export function drawJointStatus(doc, target, record, status) {
  target.replaceChildren(node(doc, 'h3', `联合调用 · ${record.cli}`), fillAgentNames(doc,node(doc,'p'),record.whitelist.map(a=>({...a,name:record.cli==='claude'?a.claudeName:a.codexName})),'可调用的 Agent：'));
  target.append(node(doc, 'p', '结果请在 CLI 窗口中查看'));
  if (record.terminalFallback === 'no-wt' || status?.terminalFallback === 'no-wt') target.append(node(doc, 'p', '未找到 Windows Terminal，窗口位置未控制', 'reason'));
  if (!status) { target.append(node(doc, 'p', '正在读取核验记录…')); return; }
  target.className = `joint-card ${status.overall}`;
  // A call closed before its first verification carries no cwd (closedStatus); show only the facts present.
  const facts = [['process', '进程'], ['cwd', '目录']].filter(([key]) => status[key]).map(([key, label]) => ` · ${label}：${labels[status[key].state] || status[key].state}`);
  target.append(node(doc, 'p', `整体：${status.message || labels[status.overall] || status.overall}${facts.join('')}`));
  if (record.resumeOf || status.overall === 'resumed' || !status.parallel) {
    target.append(node(doc, 'p', status.message || '恢复会话核验中'));
    if (status.evidenceError) target.append(node(doc, 'p', status.evidenceError, 'error'));
    return;
  }
  for (const [key, label] of [['parallel','并行'],['whitelist','调用范围'],['crossExam','交叉质询']]) if (status[key]) target.append(node(doc, 'p', `${label}：${labels[status[key].state] || status[key].state}`));
  for (const call of status.calls) target.append(node(doc, 'p', `${call.agent}：${labels[call.state] || call.state}`));
  for (const attempt of status.whitelist.deniedAttempts) target.append(node(doc, 'p', `平台已拒绝尝试：${attempt.agent} · ${JSON.stringify(attempt.evidence)}`, 'reason'));
  for (const violation of status.whitelist.violations) target.append(node(doc, 'p', `越权调用：${violation.agent} · ${JSON.stringify(violation)}`, 'reason'));
  if (status.taskTextNote) target.append(node(doc, 'p', status.taskTextNote, 'reason'));
  if (status.evidenceError) target.append(node(doc, 'p', status.evidenceError, 'error'));
  const evidence = node(doc, 'details'); evidence.append(node(doc, 'summary', '核验证据'), node(doc, 'pre', JSON.stringify({ parallel: status.parallel.evidence, calls: status.calls }, null, 2)));
  target.append(evidence);
}

function statsControl(ctx, label, key, callback, pressed) {
  const button = control(ctx, label, label, `stats-${key}`, callback, 'bento-stats-button');
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  return button;
}

function seminarControl(ctx, text, key, callback) {
  const button = control(ctx, text, text, `seminars-${key}`, () => callback(), 'bento-concept-button');
  button.id = `seminars-${key}`; return button;
}
function statsSources(doc) {
  return region(doc, 'div', 'bento-stats-sources', node(doc, 'span', 'Claude', 'bento-stats-claude'), node(doc, 'span', 'Codex', 'bento-stats-codex'));
}
function statsDonut(ctx, segments, centerLabel, centerValue, selected, onSelect) {
  const chart = donut({ segments, centerLabel, centerValue, onSelect }, ctx.doc);
  // Keep the visible legend and SVG in sync; selection never relies on color alone.
  for (const slice of chart.querySelectorAll('[data-segment]')) slice.setAttribute('aria-pressed', String(slice.getAttribute('data-segment') === selected));
  const labels = chart.querySelector('.chart-legend').children;
  segments.forEach((segment, i) => { labels[i].className = segment.colorClass; labels[i].setAttribute('aria-pressed', String(segment.key === selected)); });
  return chart;
}
export function renderStats(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, panel = r.statsPanel, visible = ctx.state.view === 'stats';
  const entering = visible && panel.hidden, returning = !visible && !panel.hidden && panel.contains(doc.activeElement);
  updateVisibility(ctx); panel.hidden = !visible;
  // Clear the temporary wrapper flag left by a Stage A layout when switching.
  ctx.root.parentElement?.removeAttribute('data-stats-open');
  if (returning && ctx.state.view === 'catalog' && !ctx.state.detailOpen) doc.getElementById('stats-open')?.focus();
  if (!visible || !model) return;
  const signature = JSON.stringify(model);
  if (r.statsSignature === signature) { if (entering) r.statsHeading.focus(); return; }
  r.statsSignature = signature;
  const ready = model.status === 'ready', t = model.totals, count = value => value ?? '—';
  const tile = (id, title, className) => {
    const el = region(doc, 'section', `bento-stats-tile ${className}`, node(doc, 'h3', title)); el.id = id;
    el.setAttribute('aria-label', title); return el;
  };
  const heading = node(doc, 'h2', '调用统计'); heading.id = 'stats-title'; heading.setAttribute('tabindex', '-1'); r.statsHeading = heading;
  const ranges = region(doc, 'div', 'bento-stats-controls', ...Object.entries({ '7d': '近 7 天', '30d': '近 30 天', all: '累计' })
    .map(([key, label]) => statsControl(ctx, label, key, () => a.setStatsRange(key), model.range === key)));
  ranges.setAttribute('role', 'group'); ranges.setAttribute('aria-label', '统计时间范围');
  panel.replaceChildren(region(doc, 'div', 'view-heading', heading, region(doc, 'div', 'bento-stats-controls',
    statsControl(ctx, '← 返回便当格', 'back', () => a.showView('catalog')), statsControl(ctx, '刷新统计', 'refresh', () => a.refreshStats()))),
    region(doc, 'div', 'bento-stats-toolbar', ranges, node(doc, 'p', `更新：${formatDate(model.generatedAt)} · 调用次数不包含启动次数`, 'bento-stats-note')));
  if (model.limited) {
    const notice = node(doc, 'p', `数据范围有限：${model.limitedReasons.join('；') || '部分来源尚不可用'}`, 'bento-stats-limited'); notice.id = 'stats-limited'; notice.setAttribute('role', 'status'); panel.append(notice);
  }
  const grid = region(doc, 'div', 'bento-stats-grid'); panel.append(grid);
  for (const [id, title, value, note] of [
    ['calls', '调用总数', t.calls, `已调用 Agent ${count(t.agentsUsed)}`],
    ['claude', 'Claude 调用', t.claude, '来自 Claude CLI'],
    ['codex', 'Codex 调用', t.codex, '来自 Codex CLI'],
  ]) {
    const number = tile(`stats-${id}`, title, `bento-stats-number bento-stats-number-${id}`);
    number.append(node(doc, 'strong', String(count(value)), 'bento-stats-value'), node(doc, 'p', note, 'bento-stats-note')); grid.append(number);
  }
  if (!ready) {
    const status = node(doc, 'p', model.status === 'loading' ? '统计正在建立…' : '调用统计暂不可用', 'bento-stats-state'); status.setAttribute('role', 'status'); grid.append(status);
  } else {
    const kind = tile('stats-kind', '功能性 / 书籍', 'bento-stats-kind');
    kind.append(statsDonut(ctx, model.byKind.map(s => ({ ...s, colorClass: `bento-stats-${s.key}` })), '调用', t.calls, model.filter, a.setStatsFilter));
    const category = tile('stats-category', '书籍分类', 'bento-stats-category');
    // Category rank changes with the window; retain each category's color identity.
    const keys = model.byCategory.map(s => s.key).sort();
    category.append(statsDonut(ctx, model.byCategory.map(s => ({ ...s, colorClass: `bento-stats-color-${keys.indexOf(s.key) % 11}` })),
      '书籍调用', model.byKind.find(s => s.key === 'book')?.value ?? 0, model.categoryFilter, a.setStatsCategory));
    const trend = tile('stats-trend', '近 30 天每日趋势', 'bento-stats-trend');
    trend.append(node(doc, 'p', '趋势固定展示近 30 天全部 Agent，日期按本机时区。', 'bento-stats-note'), statsSources(doc),
      columns({ points: model.daily.map(p => ({ label: p.day, value: p.calls, parts: [
        { key: 'claude', value: p.claude, colorClass: 'bento-stats-claude' }, { key: 'codex', value: p.codex, colorClass: 'bento-stats-codex' },
      ] })), height: 160 }, doc));
    const ranking = tile('stats-ranking', 'Agent 调用排行', 'bento-stats-ranking');
    const filters = region(doc, 'div', 'bento-stats-controls', ...Object.entries({ all: '全部', role: '功能性', book: '书籍' })
      .map(([key, label]) => statsControl(ctx, label, `filter-${key}`, () => a.setStatsFilter(key), model.filter === key)));
    filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '排行榜筛选');
    ranking.append(node(doc, 'p', `成功 ${t.ok} · 失败 ${t.failed} · 未知 ${t.unknown}（全部 Agent）`, 'bento-stats-note'), filters);
    if (model.categoryFilter) ranking.append(statsControl(ctx, `分类：${model.categoryFilter} · 取消筛选`, 'category', () => a.setStatsCategory(model.categoryFilter), true));
    ranking.append(statsSources(doc), barList({ rows: model.agents.map(agent => ({ id: agent.id, label: agent.name,
      sublabel: agent.bookLabel || agent.purpose || '用途未载明', value: agent.value, parts: [
        { key: 'claude', value: agent.claude, colorClass: 'bento-stats-claude' }, { key: 'codex', value: agent.codex, colorClass: 'bento-stats-codex' },
      ] })), onSelect: id => a.openDetail(id) }, doc), node(doc, 'p', `未调用的 Agent：${model.zeroCount} 个`, 'bento-stats-zero'),
      statsControl(ctx, model.showAll ? '收起至前 20 名' : `展开全部（${model.agentCount}）`, 'expand', () => a.toggleStatsShowAll(), model.showAll));
    grid.append(kind, category, trend, ranking);
  }
  if (entering) heading.focus();
}
