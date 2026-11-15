import { markAgentLink, fillAgentNames, openFileButton, runningMembers } from '../agent-links.js';
import { node, action, region, runningCloseHeading, runningCloseRow, updateRunningClose, groupMembers, groupMeta, groupActions, renderCandidateNotice, emptyCatalog, pinButton, inAppButton, conceptResponse, updateConceptResponseNote, renderConceptThread } from './shared.js';
import { donut, barList, columns } from '../charts.js';
import { renderMarkdown } from '../markdown.js';
import { manageDialog } from '../accessibility.js';
import { avatarLetter, avatarColor, cleanTitle, formatDate, statsReadable, statsText, permissionText, accessLabel, syncLabel, summary, bookLabel, authorShort, conceptStatus } from '../display.js';
export const initialCategory = 'role';
// Legacy named helper, now a flat view; not used by the app controller.
export function renderNavigation(doc, nav, registry, selected, choose) {
  nav.replaceChildren();
  const categories = [{key:'role',label:'功能性 Agent',count:registry.summary.roles},
    {key:'book',label:'全部书籍',count:registry.summary.books},
    ...[...registry.categories,...(registry.summary.uncategorized>0?['未分类']:[])].map(key=>({key,label:key,count:registry.agents.filter(a=>a.kind==='book'&&a.primary===key).length}))];
  for(const c of categories){const el=action(doc,`${c.label}（${c.count}）`,()=>choose(c.key));if(c.key===selected)el.setAttribute('aria-current','page');nav.append(el);}
}
export const jointBuilderSkin = 'threepane-builder';
const readingStorageKey = 'co-agent.threepane.reading-expanded';
function readingOverlayOpen(doc) {
  if (Array.from(doc.querySelectorAll('dialog')).some(el => el.open || el.getAttribute('open') !== null)) return true;
  return Array.from(doc.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [popover]')).some(el => {
    if (el.tagName === 'DIALOG' || el.closest('[hidden]') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.getAttribute('popover') !== null) return el.matches(':popover-open');
    return true;
  });
}
function syncReading(ctx) {
  const {doc, refs:r, state:s} = ctx, reading = r.reading;
  if (!reading) return;
  const {button, middle, root, toolbar, icon} = reading;
  const host = s.view === 'concepts' ? r.parts.concepts.querySelector('.concept-toolbar') : toolbar;
  const hadFocus = doc.activeElement === button;
  if (button.parentElement !== host) host.append(button);
  toolbar.hidden = host !== toolbar;
  const available = reading.content[s.view] === true;
  reading.expanded = reading.wanted && available;
  button.disabled = !available;
  button.setAttribute('aria-pressed', String(reading.expanded));
  button.setAttribute('aria-label', reading.expanded ? '恢复三栏' : '展开阅读');
  button.title = reading.expanded ? '恢复三栏' : '展开阅读（隐藏中栏）';
  icon.setAttribute('d', reading.expanded ? 'M3 5v14M21 5v14M6 8l4 4-4 4M3 12h7M18 8l-4 4 4 4M14 12h7' : 'M8 5l-7 7 7 7M1 12h22M16 5l7 7-7 7');
  // Move focus before applying inert/aria-hidden. Never park focus in the hidden pane.
  if ((reading.expanded && middle.contains(doc.activeElement)) || (hadFocus && !button.disabled)) button.focus();
  root.className = `layout-threepane${reading.expanded ? ' reading-expanded' : ''}`;
  if (reading.expanded) { middle.setAttribute('inert', ''); middle.setAttribute('aria-hidden', 'true'); }
  else { middle.removeAttribute('inert'); middle.removeAttribute('aria-hidden'); }
}
function setReading(ctx, expanded) {
  const reading = ctx.refs.reading;
  if (!reading) return;
  reading.wanted = expanded;
  try { ctx.doc.defaultView?.localStorage?.setItem(readingStorageKey, String(expanded)); } catch { /* Session-only when storage is unavailable. */ }
  syncReading(ctx);
}
function readingContent(ctx, view, available) {
  if (!ctx.refs.reading) return;
  ctx.refs.reading.content[view] = available;
  if (ctx.state.view === view) syncReading(ctx);
}
function focusPaneHeading(ctx, heading) {
  (ctx.refs.reading?.expanded ? ctx.refs.reading.button : heading)?.focus();
}
function mountReading(ctx, root, middle, right) {
  const {doc, refs:r} = ctx;
  let wanted = false;
  try { wanted = doc.defaultView?.localStorage?.getItem(readingStorageKey) === 'true'; } catch { /* Default to three columns. */ }
  const button = action(doc, '', () => {
    if (button.disabled) return;
    setReading(ctx, !r.reading.expanded); button.focus();
  });
  button.className = 'reading-toggle'; button.setAttribute('data-focus-key', 'reading-toggle');
  middle.id = 'threepane-list'; button.setAttribute('aria-controls', middle.id);
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.append(icon); button.append(svg);
  const toolbar = region(doc, 'div', 'reading-toolbar', button); right.prepend(toolbar);
  r.reading = {button, middle, root, toolbar, icon, wanted, expanded:false,
    content:{catalog:false, history:false, concepts:false, recommend:true, running:true, stats:true, coverage:true}};
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing) return;
    // The full-page consultation composer owns / and Ctrl+K via app.js.
    if (['conceptMap', 'chat'].includes(ctx.state.view)) return;
    const target = event.target, editing = ['INPUT','TEXTAREA','SELECT'].includes(target?.tagName) || target?.isContentEditable;
    const search = (event.key === '/' && !editing && !event.ctrlKey && !event.altKey && !event.metaKey) ||
      (event.ctrlKey && event.key?.toLowerCase() === 'k');
    if (readingOverlayOpen(doc)) {
      // A popup owns its keyboard. Do not let the shared search shortcut focus behind it.
      if (search) { event.preventDefault(); event.stopImmediatePropagation?.(); }
      return;
    }
    if (search) {
      event.preventDefault(); event.stopImmediatePropagation?.(); setReading(ctx, false); r.search.focus();
    } else if (event.key === 'Escape' && r.reading.expanded) {
      event.preventDefault(); event.stopImmediatePropagation?.(); setReading(ctx, false);
    }
  };
  // Capture runs before app.js's bubble shortcut (which clears the search on Esc).
  doc.addEventListener('keydown', keydown, true);
  const dispose = r.dispose;
  r.dispose = () => { doc.removeEventListener('keydown', keydown, true); dispose(); };
  syncReading(ctx);
}
function build(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const make = (tag, id, text, cls, attrs, children) => {
    const el = node(doc, tag, text || undefined, cls);
    if (id) { el.id = id; r[id] = el; }
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value ?? '');
    el.append(...children); return el;
  };
  const p = {};
  p.brand = make("div", "brand", "", "brand", {}, [make("img", "", "", "brand-logo", {"src": "/brand/co-agent-icon.svg", "alt": "", "width": "28", "height": "28"}, []), make("span", "", "CO-AGENT", "", {}, [])]);
  p.search = make("div", "search-control", "", "", {}, [make("input", "search", "", "", {"type": "search", "placeholder": "搜索名称、书名、作者", "autocomplete": "off", "aria-label": "全局搜索", "title": "/ 或 Ctrl+K"}, [])]);
  p.navigation = make("nav", "navigation", "", "", {"aria-label": "Agent 分类"}, []);
  p.catalog = make("main", "catalog", "", "", {}, [
    make("div", "", "", "view-heading", {}, [
    make("h2", "view-title", "功能性 Agent", "", {}, []),
    make("select", "sort", "", "", {"aria-label":"排序"}, [
    make("option", "", "默认", "", {"value": "default"}, []),
    make("option", "", "近 7 天", "", {"value": "last7d"}, []),
    make("option", "", "累计", "", {"value": "total"}, [])])]),
    make("div", "cards", "", "cards", {"aria-live": "polite"}, [])]);
  p.recommend = make("section", "recommend-panel", "", "recommend-panel", {"aria-labelledby": "recommend-title"}, [
    make("h2", "recommend-title", "问 CO-AGENT", "", {}, []),
    make("label", "", "输入问题或内容（最多 8000 字）", "", {"for": "recommend-input"}, []),
    make("textarea", "recommend-input", "", "", {"maxlength": "8000", "rows": "5", "placeholder": "描述你希望 Agent 帮忙的任务"}, []),
    make("p", "recommend-count", "0 / 8000 字", "", {}, []),
    make("div", "", "", "workflow-actions", {}, [
    make("label", "", "推荐引擎", "", {}, [
    make("select", "recommend-engine", "", "", {}, [
    make("option", "", "Claude", "", {"value": "claude"}, []),
    make("option", "", "Codex", "", {"value": "codex"}, [])])]),
    make("span", "recommend-model", "", "", {}, []),
    make("button", "recommend-submit", "推荐 Agent", "", {"type": "button", "aria-describedby": "recommend-disabled-reason", "disabled": null}, [])]),
    make("p", "recommend-disabled-reason", "输入有效问题后可分析；推荐进行时请等待。", "", {}, []),
    make("div", "recommend-status", "", "", {"role": "status", "aria-live": "polite"}, []),
    make("div", "", "", "workflow-actions", {}, [
    make("label", "", "全选当前推荐", "", {}, [
    make("input", "select-all", "", "", {"type": "checkbox", "aria-describedby": "select-all-disabled-reason"}, [])]),
    make("span", "selected-count", "已选 0 个", "", {}, []),
    make("label", "", "联合调用 CLI", "", {}, [
    make("select", "joint-cli", "", "", {}, [
    make("option", "", "Claude CLI", "", {"value": "claude"}, []),
    make("option", "", "Codex CLI", "", {"value": "codex"}, []),
    make("option", "", "CO-AGENT 内 · Claude", "", {"value": "inapp:claude"}, []),
    make("option", "", "CO-AGENT 内 · Codex", "", {"value": "inapp:codex"}, [])])]),
    make("button", "joint-submit", "联合调用", "", {"type": "button", "aria-describedby": "joint-disabled-reason", "disabled": null}, [])]),
    make("p", "joint-disabled-reason", "选择至少一个 Agent 后可联合调用；推荐进行时请等待。", "", {}, []),
    make("p", "select-all-disabled-reason", "有推荐结果时可全选。", "", {}, []),
    make("p", "", "用 Claude 时，CO-AGENT 会在运行前限定它只能调用所选的 Agent；用 Codex 时，CO-AGENT 无法事先限制它调用哪些 Agent，只能在运行后核对。", "", {}, [])]);
  p.recommendList = make('section', 'recommend-list-panel', '', '', {'aria-label':'推荐结果'}, [make('h2', '', '推荐结果', 'list-heading', {}, []), make('div','recommend-results','','',{},[])]);
  p.recommend.append(make('button','recommend-add','将已选推荐加入联合调用','text-button',{'type':'button'},[]));
  p.running = make("section", "running-panel", "", "", {"aria-labelledby": "running-title"}, [runningCloseHeading(ctx,make("h2", "running-title", "运行中的会话", "list-heading", {}, [])), make("div", "running-list", "正在读取…", "", {"aria-live": "polite"}, [])]);
  p.runningDetail = make('section','running-detail','','aux-detail',{'aria-label':'运行中会话详情'},[make('h2','','运行中的会话','',{},[]),make('div','running-records','','',{},[]),make('button','reverify-all','全部重新核验','text-button',{'type':'button','aria-label':'全部重新核验范围内 Agent 的旧记录'},[]),make('p','reverify-all-status','','',{'role':'status','aria-live':'polite'},[])]);
  p.history = make("section", "history-panel", "", "", {"aria-label": "历史调用"}, [
    make("h2", "", "历史调用", "", {}, []),
    make("div", "", "", "workflow-actions", {}, [
    make("label", "", "筛选", "", {}, [
    make("select", "history-filter", "", "", {}, [
    make("option", "", "全部", "", {"value": "all"}, []),
    make("option", "", "单次", "", {"value": "launch"}, []),
    make("option", "", "联合", "", {"value": "joint"}, [])])]),
    make("button", "history-refresh", "刷新历史", "", {"type": "button"}, [])]),
    make("p", "history-status", "", "", {"role": "status", "aria-live": "polite"}, []),
    make("div", "history-list", "", "", {}, [])]);
  p.coverage = make("section", "coverage-panel", "", "aux-detail", {"aria-label": "扫描摘要和数据覆盖"}, [make("h2", "", "扫描摘要和数据覆盖", "", {}, [])]);
  p.coverageList = make('section','coverage-list','','',{'aria-label':'覆盖来源列表'},[make('h2','','扫描与覆盖','list-heading',{},[])]);
  p.conceptsList = make('section','concepts-list-panel','','',{'hidden':null,'aria-label':'概念存档'},[
    make('h2','concepts-count','概念存档','list-heading',{},[]),
    make('nav','concepts-archive','','concept-archive',{'aria-label':'概念存档'},[])]);
  const back=action(doc,'返回 Agent',()=>a.showView('catalog'));back.className='text-button';back.setAttribute('data-focus-key','concepts-back');
  const refresh=action(doc,'重新读取',()=>a.openConcepts());refresh.className='text-button';refresh.setAttribute('data-focus-key','concepts-refresh');
  r.conceptsRefresh=refresh;
  p.concepts = make('section','concepts-panel','','',{'hidden':null,'aria-label':'随机概念'},[
    region(doc,'div','concept-toolbar',back,refresh),
    make('p','concepts-status','','concept-status',{'role':'status','aria-live':'polite'},[]),
    make('p','concepts-error','','concept-notice',{'role':'alert'},[]),
    make('article','concepts-record','','',{},[])]);
  p.stats = make('section','stats-panel','','',{'hidden':null,'aria-label':'调用统计图表'},[]);
  p.statsRanking = make('section','stats-ranking-panel','','',{'hidden':null,'aria-label':'Agent 调用排行'},[]);
  // v0.14 调用组: quick list in the left column, group list (middle) and group detail (right).
  p.groupsNav = make('section','groups-nav','','groups-nav',{'aria-label':'调用组快捷入口'},[]);
  p.groupsList = make('section','groups-list-panel','','',{'hidden':null,'aria-labelledby':'groups-list-title'},[
    make('h2','groups-list-title','调用组','list-heading',{},[]),make('div','groups-list','','groups-list',{},[])]);
  p.groups = make('section','groups-detail','','groups-detail',{'hidden':null,'aria-label':'调用组详情'},[]);
  p.metrics = make("section", "metrics", "", "", {"aria-label": "统计概览"}, []);
  p.top = make("section", "top-agents", "", "", {"aria-label": "最常用"}, []);
  p.historyDetail = make("section", "history-detail", "", "", {"aria-label": "调用记录详情", "hidden": null}, []);
  p.recentHistory = make("section", "recent-history", "", "", {"aria-label": "最近调用"}, [make("h2", "", "最近调用", "", {}, []), make("div", "recent-history-list", "", "", {}, []), make("button", "all-history", "查看完整历史", "", {"type": "button"}, [])]);
  p.tray = make("div", "tray-selected", "", "", {}, []);
  p.detailDialog = make("dialog", "detail", "", "drawer", {"role": "dialog", "aria-modal": "true", "aria-labelledby": "detail-title"}, [make("div", "detail-heading", "", "drawer-heading", {}, [make("h2", "detail-title", "", "", {}, []), make("button", "close-detail", "关闭", "", {"type": "button", "aria-label": "关闭详情"}, [])]), make("div", "detail-body", "", "", {}, [])]);
  const scan = make("section", "scan", "", "scan", {}, [make("h3", "scan-summary", "正在读取 Agent 目录…", "", {}, []), make("div", "scan-detail", "", "", {}, [])]);
  const stats_coverage = make("section", "stats-coverage", "", "scan", {}, [make("h3", "stats-summary", "数据覆盖 · 统计中…", "", {}, []), make("div", "stats-detail", "", "", {}, []), make("button", "stats-refresh", "重新统计", "text-button", {"type": "button"}, [])]);
  const recent_panel = make("details", "recent-panel", "", "scan", {}, [make("summary", "", "最近的推荐与联合调用（20 条）", "", {}, []), make("div", "recent-list", "", "", {"aria-live": "polite"}, [])]);
  p.coverage.append(scan, stats_coverage); p.recommend.append(recent_panel);
  p.settings = action(doc, '', e => a.openSettings(e.currentTarget), '打开设置'); p.settings.id = 'settings-open';
  const gear = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  gear.setAttribute('viewBox','0 0 24 24'); gear.setAttribute('aria-hidden','true');
  const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d','M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0'); gear.append(shape);
  p.settings.append(gear,node(doc,'span','设置'));
  p.settings.setAttribute('data-focus-key', 'settings-open');
  p.detailHeading = r['detail-heading']; p.detailBody = r['detail-body'];
  const bind = (id, event, fn) => r[id].addEventListener(event, fn);
  bind('search', 'input', e => { setReading(ctx, false); r.search.focus(); a.search(e.currentTarget.value); });
  bind('sort', 'change', e => a.sort(e.currentTarget.value));
  bind('history-filter', 'change', e => a.setHistoryFilter(e.currentTarget.value));
  bind('history-refresh', 'click', a.refreshHistory);
  bind('all-history', 'click', () => a.showView('history'));
  bind('stats-refresh', 'click', a.refreshStats);
  bind('reverify-all', 'click', a.reverifyAll);
  bind('recommend-input', 'input', e => a.setRecommendInput(e.currentTarget.value));
  bind('recommend-engine', 'change', e => a.setRecommendEngine(e.currentTarget.value));
  bind('recommend-submit', 'click', a.recommend);
  bind('joint-cli', 'change', e => a.setJointCli(e.currentTarget.value));
  bind('joint-submit', 'click', a.launchRecommendedJoint);
  bind('select-all', 'change', e => a.selectAllRecommendations(e.currentTarget.checked));
  bind('recommend-add', 'click', e => a.openJoint(r.recommendSelectedIds, e.currentTarget));
  r.dialog = manageDialog(doc, p.detailDialog, { labelledby: 'detail-title' });
  bind('close-detail', 'click', a.closeDetail);
  p.detailDialog.addEventListener('close', () => { if (!r.disposing && ctx.state.detailOpen) a.closeDetail(); });
  r.dispose = () => { r.disposing = true; if (p.detailDialog.open) r.dialog.close(); };
  r.recommendInput = r['recommend-input'];
  r.parts = p;
  return p;
}
function entry(ctx, name, text = name, cls) {
  const a = ctx.actions;
  const callbacks = { '新建联合调用': e => a.openJoint(undefined, e.currentTarget),
    '发起联合调用': e => a.openJoint(ctx.state.jointSelectedIds, e.currentTarget),
    '调用组': () => a.openGroups(), 'AI 推荐': () => a.showView('recommend'), '随机概念': () => a.openConcepts(), '研讨': () => a.openSeminars(), '会诊室': () => a.openConsults(), '软件内对话': () => a.openChats(), '顾问团': () => a.openCouncils(), '概念地图': () => a.openConceptMap(), '历史调用': () => a.showView('history'),
    '运行中的会话': () => a.showView('running'), '调用统计': () => a.openStats(), '扫描摘要和数据覆盖': () => a.showView('coverage'),
    '目录': () => a.showView('catalog'), '人物': () => a.selectCategory('role'), '藏书': () => a.selectCategory('book') };
  const el = action(ctx.doc, text, callbacks[name], name); el.className = cls || '';
  el.setAttribute('data-focus-key', `entry-${name}`); return el;
}
function menu(ctx, { history = '历史调用', recommend = 'AI 推荐' } = {}) {
  const el = region(ctx.doc, 'nav', 'utility-nav'); el.setAttribute('aria-label', '功能导航');
  for (const [name, text, view] of [['调用组','调用组','groups'],['AI 推荐',recommend,'recommend'],['随机概念','随机概念','concepts'],['研讨','研讨','seminars'],['会诊室','会诊室','consults'],['顾问团','顾问团','councils'],['概念地图','概念地图','conceptMap'],['软件内对话','软件内对话','chat'],['历史调用',history,'history'],['运行中的会话','运行中 0','running'],['调用统计','调用统计','stats'],['扫描摘要和数据覆盖','扫描与覆盖','coverage']]) {
    const button = entry(ctx,name,text); button.setAttribute('data-view',view); el.append(button);
    if (view === 'running') ctx.refs.runningEntry = button;
    if (view === 'concepts') {button.id='concepts-open';button.setAttribute('data-focus-key','concepts-open');ctx.refs.conceptsEntry=button;}
    if (view === 'groups') {button.id='groups-open';button.setAttribute('data-focus-key','groups-open');ctx.refs.groupsEntry=button;}
    if (view === 'stats') {button.id='stats-open';button.setAttribute('data-focus-key','stats-open');ctx.refs.statsEntry=button;}
    if (view === 'seminars') {button.id='seminars-open';button.setAttribute('data-focus-key','seminars-open');ctx.refs.seminarsEntry=button;}
    if (view === 'consults') {button.id='consults-open';button.setAttribute('data-focus-key','consults-open');}
    if (view === 'chat') {button.id='chats-open';button.setAttribute('data-focus-key','chats-open');}
    if (view === 'conceptMap') {button.id='concept-map-open';button.setAttribute('data-focus-key','concept-map-open');}
    if (view === 'councils') {button.id='councils-open';button.setAttribute('data-focus-key','councils-open');}
  }
  ctx.refs.utilities = el;
  return el;
}
export function render(ctx) {
  const { doc } = ctx; const p = build(ctx);
  const left = region(doc, 'aside', 'mail-navigation', p.brand, entry(ctx, '新建联合调用', '＋ 新建联合调用', 'compose'), p.groupsNav, menu(ctx), node(doc,'hr',undefined,'mail-divider'), renderCandidateNotice(ctx), p.navigation, p.settings);
  const middle = region(doc, 'section', 'mail-list', p.search, p.catalog, p.history, p.recommendList, p.running, p.coverageList, p.conceptsList, p.stats, p.groupsList); middle.setAttribute('aria-label', 'Agent、调用与概念列表及统计图表');
  const right = region(doc, 'article', 'mail-detail', p.detailBody, p.historyDetail, p.recommend, p.runningDetail, p.coverage, p.concepts, p.statsRanking, p.groups); right.setAttribute('aria-label', 'Agent、调用与概念详情及统计排行');
  const root = region(doc, 'div', 'layout-threepane', left, middle, right);
  // Kept only for the historical dialog-helper contract. Threepane detail is inline.
  p.detailDialog.replaceChildren();
  root.append(p.detailDialog);
  p.detailDialog.hidden = true;
  mountReading(ctx, root, middle, right);
  return root;
}
function updateVisibility(ctx) {
  const {refs:r,state:s}=ctx,p=r.parts,view=s.view;
  for(const name of ['catalog','recommend','history','running','coverage','concepts','stats'])p[name].hidden=name!==view;
  p.detailBody.hidden=view!=='catalog';p.historyDetail.hidden=view!=='history';
  p.recommendList.hidden=view!=='recommend';p.runningDetail.hidden=view!=='running';p.coverageList.hidden=view!=='coverage';
  p.conceptsList.hidden=view!=='concepts';
  p.statsRanking.hidden=view!=='stats';
  p.groupsList.hidden=view!=='groups';p.groups.hidden=view!=='groups';
  for (const button of r.utilities.children) {
    if (button.getAttribute('data-view')===(view==='chat'&&s.room!=='chat'?s.room:view)) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  }
  syncReading(ctx);
}
function avatar(doc, agent, large = false) {
  const el = node(doc,'span',avatarLetter(agent.name),large?'avatar detail-avatar':'avatar');
  el.setAttribute('aria-hidden','true');
  // CSP disallows style attributes. Older recording DOM fixtures lack CSSOM.
  el.style?.setProperty('background',avatarColor(agent.id));
  return el;
}
function bracketedBookTitle(agent) {
  const {text,multi}=cleanTitle(agent.book?.title);
  return text ? `《${text}》${multi>1?` 等 ${multi} 本`:''}` : '';
}
const conceptActive = value => ['queued','running'].includes(value?.status);
function conceptBook(agent) {
  return bracketedBookTitle({book:{title:agent?.title||agent?.bookLabel}})||'《书名未载明》';
}
function termTranslations(doc, term, tag = 'p') {
  const line = node(doc, tag, undefined, 'term-translations');
  for (const lang of ['en','fr']) {
    if (!term?.[lang]) continue;
    if (line.children.length) line.append(node(doc,'span',' · '));
    const word = node(doc,'span',term[lang]); word.setAttribute('lang',lang); line.append(word);
  }
  return line.children.length ? line : null;
}
function conceptControl(ctx,text,key,callback,kind=key) {
  const button=action(ctx.doc,text,()=>{if(!button.disabled)return callback();});
  button.className=kind==='next'?'primary-button':kind==='perspectives'?'outline-button':'text-button';
  button.setAttribute('data-focus-key',`concepts-${key}`);
  ctx.refs.conceptControls.push({button,kind});
  return button;
}
function conceptNotice(doc,text,tone='pending') {
  const el=node(doc,'p',text,'concept-notice');el.setAttribute('data-tone',tone);return el;
}
function conceptVerification(doc,record) {
  const verify=record.verify,structure=verify?.skillStructure;
  const mark=node(doc,'div',undefined,'concept-verification');mark.setAttribute('aria-label','概念核验与结构');
  const state=verify?.state==='ok'?'通过':verify?.state==='violation'?'违规':'未确认';
  mark.append(conceptNotice(doc,`Agent 核验：${state}`,verify?.state==='ok'?'ok':verify?.state==='violation'?'fail':'pending'));
  const structural=structure?.state==='ok'?'通过':structure?.state==='missing'?'未通过':'未确认';
  const missing=structure?.state==='ok'?'':`；缺少小节 ${(structure?.missing||[]).join('、')||'未知'}${structure?.titleLine===false?'；缺少标题行':''}`;
  mark.append(conceptNotice(doc,`11 小节结构：${structural}${missing}`,structure?.state==='ok'?'ok':'pending'));
  if(record.thinkError)mark.append(conceptNotice(doc,`THINK 另存失败：${record.thinkError}`,'fail'));
  if(record.result?.sourceRefs?.length)mark.append(node(doc,'p',`书内出处：${record.result.sourceRefs.join('；')}`,'concept-source-refs'));
  return mark;
}
function conceptRunStatus(ctx,record,prefix='') {
  const el=node(ctx.doc,'p',undefined,'concept-status');el.setAttribute('role','status');
  ctx.refs.conceptClocks.push({el,record,prefix});return el;
}
function renderConceptPerspectives(ctx,record) {
  const {doc,actions:a}=ctx,section=node(doc,'section',undefined,'concept-perspectives');
  section.setAttribute('aria-label','多视角分析结果');section.append(node(doc,'h2','多视角分析'));
  if(!record?.perspectives?.length)section.append(node(doc,'p','选择其他 Agent，查看他们对这个概念的补充。','muted'));
  for(const run of record?.perspectives||[]) {
    const group=region(doc,'section','concept-perspective-run',conceptRunStatus(ctx,run,'多视角 · '));
    if(run.error)group.append(conceptNotice(doc,`失败原因：${run.error}`,'fail'));
    if(run.status==='failed')group.append(conceptControl(ctx,'重试多视角分析',`retry-${run.runId}`,
      ()=>a.runPerspectives(record.conceptId,(run.agents||[]).map(agent=>agent.id)),'retry-perspectives'));
    const parallel=typeof run.verify?.parallel==='object'?run.verify.parallel?.state:run.verify?.parallel;
    const parallelOk=parallel==='ok'||parallel===true,violations=run.verify?.violations||[];
    const verified=run.verify?.state==='ok'&&parallelOk&&!violations.length;
    group.append(conceptNotice(doc,`多视角核验：${run.verify?.state==='ok'?'通过':run.verify?.state==='violation'?'违规':'未确认'}；并行：${parallelOk?'通过':'未通过或未确认'}${violations.length?`；${JSON.stringify(violations)}`:''}`,verified?'ok':'pending'));
    const cards=node(doc,'div',undefined,'concept-perspective-cards');
    for(const result of run.results||[]) {
      const agent=run.agents?.find(agent=>agent.id===result.agentId),name=result.name||agent?.name||result.agentId||'Agent 未载明';
      const header=region(doc,'header','concept-perspective-heading',avatar(doc,{id:result.agentId||name,name}),markAgentLink(node(doc,'h3',name),{id:result.agentId}));
      const card=region(doc,'article','concept-perspective-card',header);
      if(agent?.bookLabel||agent?.purpose)card.append(markAgentLink(node(doc,'p',agent.bookLabel?conceptBook(agent):agent.purpose,'concept-source'), agent));
      card.append(renderMarkdown(doc,result.analysis));cards.append(card);
    }
    group.append(cards);section.append(group);
  }
  return section;
}
function renderConceptRecord(ctx,record) {
  const {doc,refs:r,actions:a}=ctx,body=r['concepts-record'],result=record?.result;
  r.conceptControls=[];r.conceptClocks=[];
  const term=result?.term??record?.term,original=result?.concept||record?.concept;
  const title=node(doc,'h1',term?.zh||original||(record?'待生成概念':'随机概念'),'concept-title');
  title.setAttribute('tabindex','-1');title.setAttribute('data-focus-key','concepts-title');
  body.replaceChildren(title);
  const translations=termTranslations(doc,term||{en:result?.conceptEn});if(translations)body.append(translations);
  if(term?.zh&&original)body.append(node(doc,'p',original,'term-subtitle'));
  if(record)body.append(markAgentLink(node(doc,'p',`${conceptBook(record.agent)} · ${record.agent?.name||'Agent 未载明'}`,'concept-source'), record.agent));
  if(result)body.append(node(doc,'p',result.oneLine,'concept-one-line'),region(doc,'aside','concept-why',
    node(doc,'strong','为什么你可能不知道'),node(doc,'p',result.whyUnknown)));
  body.append(region(doc,'div','detail-actions',
    conceptControl(ctx,'再来一个','next',a.nextConcept),
    conceptControl(ctx,'多视角分析','perspectives',()=>a.openPerspectivePicker(record.conceptId)),
    conceptControl(ctx,'在终端中继续','continue',()=>a.continueInJoint(record.conceptId))));
  if(!record){body.append(node(doc,'p','请选择存档，或点击「再来一个」生成概念。','muted'));return;}
  body.append(conceptRunStatus(ctx,record));
  if(record.error)body.append(conceptNotice(doc,`失败原因：${record.error}`,'fail'));
  if(record.status==='failed')body.append(conceptControl(ctx,'重试（生成新概念）','retry',a.nextConcept));
  if((record.result || record.thinkError || record.verify?.state === 'violation'))body.append(conceptVerification(doc,record));
  if(record.poolWarning)body.append(conceptNotice(doc,record.poolWarning));
  const response=conceptResponse(ctx,record);if(response)body.append(response);
  if(result)body.append(renderMarkdown(doc,result.markdown));
  body.append(renderConceptPerspectives(ctx,record));
}
export function renderConcepts(ctx,model) {
  const {doc,refs:r,actions:a}=ctx,p=r.parts,visible=ctx.state.view==='concepts',entering=visible&&!r.conceptsVisible;
  updateConceptResponseNote(ctx,model,r.conceptsEntry);
  const returnFocus=!visible&&r.conceptsVisible&&(p.concepts.contains(doc.activeElement)||p.conceptsList.contains(doc.activeElement));
  readingContent(ctx,'concepts',!!model?.selected);
  r.conceptsVisible=visible;updateVisibility(ctx);
  // Other layouts may still use the temporary A2 full-page composition.
  ctx.root.parentElement?.setAttribute('data-concepts-open','false');
  if(returnFocus)r.conceptsEntry.focus();
  if(!visible)return;
  model||={items:[],today:undefined,selected:null,running:null,busy:false,error:''};
  renderConceptThread(ctx,model,p.concepts);
  const selected=model.selected??null,activeRun=selected?.perspectives?.some(conceptActive);
  r['concepts-status'].textContent=[model.today===undefined?'今日讲解载入中…':!model.today?.conceptId?'今日讲解尚未生成':'',
    model.busy?'正在提交…':'',model.running?`概念生成：${conceptStatus({status:'running',...model.running})}`:''].filter(Boolean).join(' · ');
  r['concepts-status'].hidden=!r['concepts-status'].textContent;
  r['concepts-error'].textContent=model.error||'';r['concepts-error'].hidden=!model.error;
  r.conceptsRefresh.hidden=!model.error;r.conceptsRefresh.disabled=!!model.busy;
  const todayId=model.today?.conceptId,items=[...(model.items||[])];
  if(todayId&&!items.some(item=>item.conceptId===todayId))items.unshift(selected?.conceptId===todayId?selected:
    {conceptId:todayId,status:model.today.status,day:model.today.day,concept:'今日概念'});
  const sorted=[...items.filter(item=>item.conceptId===todayId),...items.filter(item=>item.conceptId!==todayId)];
  const archiveKey=JSON.stringify([sorted,todayId,selected?.conceptId,sorted.map(item=>conceptStatus(item))]);
  if(r.conceptArchiveKey!==archiveKey) {
    r.conceptArchiveKey=archiveKey;const archive=r['concepts-archive'];archive.replaceChildren();
    r['concepts-count'].textContent=`概念存档 · ${sorted.length} 条`;
    for(const item of sorted) {
      const term=item.result?.term??item.term,original=item.result?.concept||item.concept;
      const title=term?.zh||original||'待生成概念',row=region(doc,'article','mail-row concept-row');
      const current=item.conceptId===selected?.conceptId;
      if(current)row.setAttribute('data-selected','true');
      const button=action(doc,'',()=>a.selectConcept(item.conceptId),`查看概念 ${title}`);
      button.setAttribute('data-focus-key',`concepts-select-${item.conceptId}`);button.setAttribute('aria-pressed',String(current));
      if(current)button.setAttribute('aria-current','page');
      const heading=region(doc,'span','row-heading',node(doc,'strong',title));
      if(item.conceptId===todayId)heading.append(node(doc,'span','今日','concept-today'));
      const copy=region(doc,'span','agent-row-copy',heading,
        termTranslations(doc,term||{en:item.result?.conceptEn||item.conceptEn},'span'),
        term?.zh&&original?node(doc,'span',original,'row-subtitle term-subtitle'):null,
        markAgentLink(node(doc,'span',`${conceptBook(item.agent)} · ${item.agent?.name||'Agent 未载明'}`,'row-subtitle'), item.agent),
        node(doc,'span',`${item.day||formatDate(item.createdAt)} · ${conceptStatus(item)}`,'row-description'));
      button.append(avatar(doc,{id:item.agent?.id||item.conceptId,name:item.agent?.name||'概念'}),copy);row.append(button);archive.append(row);
    }
    if(!sorted.length)archive.append(node(doc,'p','暂无存档，可点击「再来一个」。','empty-list'));
  }
  // Submission state and elapsed clocks must not replace the reading DOM.
  const recordKey=JSON.stringify(selected);
  if(r.conceptRecordKey!==recordKey){r.conceptRecordKey=recordKey;renderConceptRecord(ctx,selected);}
  for(const {el,record,prefix}of r.conceptClocks) {
    const text=`${prefix}${conceptStatus(record)}`;if(el.textContent!==text)el.textContent=text;
  }
  for(const {button,kind}of r.conceptControls) {
    const generating=!!model.running||conceptActive(selected);
    if(kind==='next'||kind==='retry')button.disabled=!!model.busy||generating;
    else if(kind==='continue')button.disabled=!!model.busy||!selected?.result;
    else button.disabled=!!model.busy||!selected?.result||selected.status!=='done'||!!activeRun;
    button.title=button.disabled?(model.busy?'正在提交，请等待':generating&&(kind==='next'||kind==='retry')?'已有概念正在生成':activeRun&&kind!=='continue'?'此概念正在进行多视角分析':'概念尚未生成成功'):'';
  }
  if(entering&&!Array.from(doc.querySelectorAll('dialog')).some(dialog=>dialog.open))r['concepts-record'].querySelector('.concept-title')?.focus();
}
function rowCopy(doc, agent, selected = false) {
  const head = region(doc,'span','row-heading',markAgentLink(node(doc,'strong',agent.name), agent));
  if (selected) head.append(node(doc,'span','已选','selected-marker'));
  const subtitle = node(doc,'span',agent.kind==='book'?bracketedBookTitle(agent):agent.purpose || summary(agent.description),'row-subtitle'); subtitle.title=subtitle.textContent; if(agent.kind==='book')markAgentLink(subtitle,agent);
  const description = node(doc,'span',agent.kind==='book'?authorShort(agent):summary(agent.description),'row-description'); description.title=description.textContent;
  return region(doc,'span','agent-row-copy',head,subtitle,description);
}

export function renderCatalog(ctx, model) {
  const {doc,refs:r,actions:a}=ctx, target=r.cards;
  r['view-title'].textContent=`${model.title} · ${model.count} 个`; r['view-title'].title=r['view-title'].textContent;
  if (r.search.value!==model.query) r.search.value=model.query; r.sort.value=model.sort;
  updateVisibility(ctx);
  const rendered = new Map(); target.replaceChildren();
  for (const agent of model.agents) {
    const el = region(doc, 'article', 'mail-row');
    const selected=model.selectedId===agent.id;
    if (selected) el.setAttribute('data-selected', 'true');
    const open = action(doc, '', event => a.openDetail(agent.id, event.currentTarget), `查看 ${agent.name} 详情`);
    markAgentLink(open,agent); open.setAttribute('data-focus-key', `card-detail-${agent.id}`);
    open.setAttribute('aria-pressed',String(selected)); open.append(avatar(doc,agent),rowCopy(doc,agent,selected)); el.append(open); target.append(el);
    rendered.set(agent.id, {card:el,buttons:[]});
  }
  if(model.empty)target.append(emptyCatalog(ctx,model.empty,'empty-list'));
  else if(!model.agents.length)target.append(node(doc,'p',model.query?'没有匹配的 Agent':'当前分类没有 Agent。','empty-list'));
  return rendered;
}
export function renderCategories(ctx, categories) {
  renderCandidateNotice(ctx, ctx.state.candidateCount);
  const { doc, refs: r, actions: a } = ctx; r.navigation.replaceChildren();
  for (const c of categories) {
    const el = action(doc, '', event => { setReading(ctx, false); event.currentTarget.focus(); a.selectCategory(c.key); }, `${c.fullLabel}（${c.count}）`);
    el.append(node(doc,'span',c.label,'category-label'),node(doc,'span',String(c.count),'category-count'));
    el.title = c.fullLabel; el.setAttribute('data-focus-key', `nav-${c.key}`);
    if (c.selected) el.setAttribute('aria-current', 'page'); r.navigation.append(el);
  }
}
export function renderDetail(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, body = r['detail-body'];
  readingContent(ctx,'catalog',!!model);
  const key=JSON.stringify(model);
  if (r.detailKey===key) return;
  r.detailKey=key;
  const expanded = new Set(r.detailAgentId===model?.id ? Array.from(body.querySelectorAll('details')).filter(n=>n.open).map(n=>n.getAttribute('data-section')) : []);
  r.detailAgentId=model?.id; body.replaceChildren();
  if (!model) return;
  const title=markAgentLink(node(doc,'h1',model.name), model); title.id='detail-title'; r['detail-title']=title;
  const subtitle=node(doc,'div',model.kind==='book'?[bracketedBookTitle(model),authorShort(model),model.book?.edition].filter(Boolean).join(' · '):model.purpose || summary(model.description),'detail-subtitle');
  subtitle.title=subtitle.textContent; if(model.kind==='book')markAgentLink(subtitle,model);
  body.append(region(doc,'header','detail-hero',avatar(doc,model,true),region(doc,'div','detail-heading-copy',title,subtitle)));
  const chips=region(doc,'div','detail-chips');
  const chip=(text,cls='',hint='')=>{const n=node(doc,'span',text,`detail-chip ${cls}`.trim());n.title=hint;chips.append(n);};
  if (model.kind==='book') chip(model.sourcesOk===null?'原书路径未检查':model.sourcesOk?'原书可用':'原书路径失效',model.sourcesOk===null?'':model.sourcesOk?'source-ok':'source-missing',model.sourcesReason);
  chip(accessLabel(model));
  chip(`Claude ${model.platforms.claude?.available?'✓':'✕'} · Codex ${model.platforms.codex?.available?'✓':'✕'}`,'',Object.entries(model.platforms).filter(([,p])=>!p.available).map(([cli,p])=>`${cli}：${p.reason||'入口不可用'}`).join('；'));
  chip(syncLabel(model.sync),'',model.sync.detail);
  body.append(chips,node(doc,'p',summary(model.description)||'无描述','detail-summary'));
  const controls=region(doc,'div','detail-actions');
  for (const [cli,name] of [['claude','Claude'],['codex','Codex']]) {
    const launch=action(doc,`在 ${name} CLI 中调用`,()=>{if(!launch.disabled)return a.launch(model.id,cli);},`在 ${name} CLI 中调用 ${model.name}`);
    launch.className=cli==='codex'?'primary-button':'outline-button'; launch.disabled=model.launchBusy||!model.platforms[cli]?.available;
    launch.title=model.launchBusy?'正在启动，请等待':model.platforms[cli]?.available?'':model.platforms[cli]?.reason||'入口不可用';
    launch.setAttribute('data-focus-key',`detail-launch-${cli}`);controls.append(launch);
  }
  controls.append(inAppButton(doc,model,a,'outline-button'));
  const last=model.history.items[0];
  const resume=action(doc,'继续上次会话',()=>{if(!resume.disabled)return a.resume(model.id,last?.cli,last?.launchId);},`继续上次会话 ${model.name}`);
  resume.className='text-button';resume.disabled=model.launchBusy||(!last&&!model.canResume);
  resume.title=model.launchBusy?'正在启动，请等待':resume.disabled?model.resumeReason||'暂无可恢复的已核验会话':'';
  resume.setAttribute('data-focus-key','detail-resume');controls.append(resume);
  const add=action(doc,'加入联合调用',e=>a.addToJoint(model.id,e.currentTarget,true),`加入联合调用 ${model.name}`);add.className='text-button';add.setAttribute('data-focus-key','detail-add');controls.append(add,pinButton(doc,model,a,'text-button'),openFileButton(doc,model,a,'text-button'));body.append(controls);
  const meta=region(doc,'div','detail-meta'), terminal=model.meta;
  const display={secondary:'副屏',primary:'主屏'}, windowMode={fullscreen:'全屏',maximized:'最大化',normal:'普通窗口'};
  const terminalText=terminal.terminalDisplay&&terminal.terminalWindowMode?`${display[terminal.terminalDisplay]||terminal.terminalDisplay} · ${windowMode[terminal.terminalWindowMode]||terminal.terminalWindowMode}`:'未提供';
  for (const [label,value,cls] of [['分类',terminal.category,''],['模型（Claude）',`${terminal.claudeModel} · ${terminal.claudeEffort}`, ''],['终端窗口',terminalText,'terminal-value']]) {
    const content=node(doc,'div',value,cls);if(cls)content.title=terminal.terminalReason||terminalText;
    meta.append(region(doc,'div','meta-field',node(doc,'div',label,'meta-label'),content));
  }
  body.append(meta);
  const folds=region(doc,'div','detail-folds');
  for (const [sectionId,label] of [['full','完整说明'],['stats','统计'],['permissions','权限与模型'],['source','源文件'],['sync','双版本同步']]) {
    const fold=node(doc,'details');fold.setAttribute('data-section',sectionId);fold.open=expanded.has(sectionId);
    const heading=node(doc,'summary',label);heading.setAttribute('data-focus-key',`detail-${sectionId}-summary`);fold.append(heading);
    if (sectionId==='full') fold.append(node(doc,'p',(model.fullDescription||'无描述').replace(/<\/?example\b[^>]*>/gi,'').trim(),'full-description'));
    const sections=model.sections.filter(s=>s.key===sectionId||(sectionId==='source'&&s.key==='sources'));
    for (const section of sections) {
      const rows=node(doc,'dl');
      for (const row of section.rows) rows.append(node(doc,'dt',row.label),markAgentLink(node(doc,'dd',row.label==='书名'?cleanTitle(row.value).text:row.value), row.label === '书名' ? model : null));
      fold.append(rows);
    }
    if (sectionId==='stats') {
      if (!sections.length) fold.append(node(doc,'p',model.statsState==='building'?'统计中…':'暂无数据'));
      fold.append(r.metrics,r['top-agents']);
      const history=node(doc,'section');drawAgentHistory(doc,history,model,model.history,item=>a.resume(model.id,item.cli,item.launchId),()=>a.reverifyAgent(model.id));fold.append(history);
      if(model.historyMessage)fold.append(node(doc,'p',model.historyMessage,'reason'));
    }
    folds.append(fold);
  }
  body.append(folds);
  // Live launch verification is operational feedback, outside the default reading hierarchy.
  if (model.launchStatus) {const status=node(doc,'div');renderStatus(doc,status,model.launchStatus);status.setAttribute('role','status');body.append(status);}
}
export function renderMetrics(ctx, model) {
  const { doc, refs: r } = ctx, target = r.metrics; target.replaceChildren();
  const count = model.recent7 ?? (model.statsState === 'building' ? '统计中…' : '暂无数据');
  const figures = [['近 7 天调用',count,'当前范围内 Agent'],['Agent 总数 / 同步',model.total,`${model.roles} 角色 · ${model.books} 书籍 · 同步 ${model.sync.ok ?? '未知'} / ${model.sync.total}`]];
  for (const [title,value,sub] of figures) target.append(region(doc,'div','metric-tile',node(doc,'span',title),node(doc,'strong',String(value)),node(doc,'small',sub)));
  if (model.scopeLimited) { const info = node(doc,'span','ⓘ','scope-info'); info.title = model.scopeReasons.join('\n'); info.setAttribute('aria-label',`统计范围有限：${info.title}`); target.append(info); }
  const top = r['top-agents']; top.replaceChildren(node(doc,'h2','最常用'));
  if (!model.top.length) top.append(node(doc,'p','暂无数据'));
  for (const item of model.top.slice(0,5)) {
    const meter = node(doc,'meter'); meter.min=0; meter.max=Math.max(1,...model.top.map(i=>i.count)); meter.value=item.count;
    meter.setAttribute('aria-label',`${item.name} 累计 ${item.count} 次`);
    top.append(region(doc,'div','usage-row',markAgentLink(node(doc,'span',item.name), item),meter,node(doc,'span',String(item.count))));
  }
}
export function renderHistory(ctx, model) {
  const { doc, refs:r, actions:a }=ctx;
  readingContent(ctx,'history',!!model.selected);
  r['history-filter'].value=model.filter;r['history-status'].textContent=model.message;
  r['history-refresh'].disabled=model.busy;r['history-filter'].disabled=model.busy;r['history-list'].replaceChildren();
  for (const item of model.items) {
    const names=item.agents.map(a=>a.name).join('、'), row=region(doc,'article','mail-row history-row');
    const selected=model.selectedId===`${item.type}:${item.id}`;if(selected)row.setAttribute('data-selected','true');
    const open=action(doc,'',e=>a.selectHistory(item.type,item.id,e.currentTarget),`查看调用记录 ${names}`);
    open.setAttribute('data-focus-key',`history-${item.type}-${item.id}`);open.setAttribute('aria-pressed',String(selected));
    const icon=avatar(doc,item.agents[0]||{id:item.type,name:item.type==='joint'?'联合':'单次'});
    const head=region(doc,'span','row-heading',fillAgentNames(doc,node(doc,'strong'),item.agents),historyStatusChip(doc,item,'history-status-chip'));
    const copy=region(doc,'span','agent-row-copy',head,node(doc,'span',`${item.type==='joint'?`联合 · ${item.agents.length} 个`:'单次'} · ${historyCliLabel(item)}`,'row-subtitle'),node(doc,'span',formatDate(item.createdAt),'row-description'));
    if(item.inputPreview)copy.append(node(doc,'span',item.inputPreview,'row-description'));
    open.append(icon,copy);row.append(open);r['history-list'].append(row);
  }
  if(!model.items.length)r['history-list'].append(node(doc,'p','暂无调用记录','empty-list'));
  const detail=r['history-detail'];detail.replaceChildren();const item=model.selected;
  if (!item) {detail.append(node(doc,'p','请选择调用记录','muted'));return;}
  const names=item.agents.map(a=>a.name).join('、');
  detail.append(fillAgentNames(doc,node(doc,'h1'),item.agents),node(doc,'p',`${item.type==='joint'?`联合 · ${item.agents.length} 个`:'单次'} · ${formatDate(item.createdAt)} · ${historyCliLabel(item)}`,'muted'),historyStatusChip(doc,item,'detail-chip'));
  if(item.inputPreview)detail.append(node(doc,'p',item.inputPreview,'history-preview'));
  detail.append(node(doc,'p',`模式：${item.modeLabel||item.mode||'未声明'} · 来源：${item.sourceLabel||item.source||'未声明'}${item.resumeOf?` · 恢复自 ${item.resumeOf}`:''}${item.rerunOf?` · 重跑自 ${item.rerunOf}`:''}`,'muted'));
  const controls=region(doc,'div','detail-actions');
  const run=action(doc,'重新调用',()=>{if(!run.disabled)return a.rerun(item.type,item.id);},`重新调用 ${names}`);run.disabled=model.busy;run.className='primary-button';run.setAttribute('data-focus-key',`history-rerun-detail-${item.id}`);
  const resume=action(doc,'继续该次会话',()=>{if(!resume.disabled)return a.resumeHistory(item.type,item.id);},`继续该次会话 ${names}`);resume.className='outline-button';resume.disabled=model.busy||!item.canResume;
  resume.title=model.busy?'正在处理，请等待':item.canResume?'':item.resumeReason;resume.setAttribute('data-focus-key',`history-resume-detail-${item.id}`);controls.append(run,resume);detail.append(controls);
  if(!item.canResume)detail.append(node(doc,'p',item.resumeReason||'此会话尚不可恢复','reason'));
}
function historyCliLabel(item) {
  return item.cliLabel||({claude:'Claude',codex:'Codex'})[item.cli]||item.cli||'未声明';
}
function historyStatusChip(doc,item,cls) {
  // Prefer the shared tone; retain useful colors until pre-S2 records are upgraded.
  const fallback=({closed:'neutral',failed:'fail',violation:'fail',done:'ok',ok:'ok',ready:'ok',resumed:'ok',running:'running'})[item.status?.overall]||'pending';
  const tone=['ok','fail','running','pending','neutral'].includes(item.statusTone)?item.statusTone:fallback;
  const chip=node(doc,'span',statusLabel(item.status),cls);
  chip.setAttribute('data-tone',tone);
  return chip;
}
function statusLabel(status) { return status?.message?.endsWith(' · 会话已结束') ? status.message : ({ready:'已就绪',resumed:'已恢复',...labels})[status?.overall]||status?.overall||'待核验'; }
function jumpLink(doc, text, id, subtitle) {
  const link=node(doc,'a',undefined,'pane-link');link.setAttribute('href',`#${id}`);
  link.append(node(doc,'strong',text));if(subtitle)link.append(node(doc,'span',subtitle,'row-description'));return link;
}
export function renderRunning(ctx, items) {
  const {doc,refs:r}=ctx;r.runningEntry.textContent=`运行中 ${items.length}`;
  updateRunningClose(ctx,items);
  r['running-list'].replaceChildren();r['running-records'].replaceChildren();
  items.forEach((item,index)=>{
    const names=item.type==='joint'?(item.whitelist||[]).map(a=>a.codexName||a.claudeName||a.name).join('、'):item.agentName;
    const id=`running-record-${index}`;
    const jump=jumpLink(doc,names||'会话',id,`${item.cli} · ${statusLabel(item.status)}`);fillAgentNames(doc,jump.querySelector('strong'),runningMembers(item));if(item.type!=='joint')markAgentLink(jump,item.agentId);r['running-list'].append(runningCloseRow(ctx,item,jump));
    const detail=region(doc,'article','running-record',fillAgentNames(doc,node(doc,'h3'),runningMembers(item)),node(doc,'p',`${formatDate(item.createdAt)} · ${item.cli} · ${statusLabel(item.status)}`));detail.id=id;detail.tabIndex=-1;
    if(item.type==='joint'&&item.status?.process) {const status=node(doc,'div');drawJointStatus(doc,status,item,item.status);detail.append(status);}
    else if(item.status?.process&&item.status?.cwd&&item.status?.agent&&item.status?.waiting) {const status=node(doc,'div');renderStatus(doc,status,item.status);detail.append(status);}
    else if(item.status?.message)detail.append(node(doc,'p',item.status.message));
    if(item.terminalFallback==='no-wt'||item.status?.terminalFallback==='no-wt')detail.append(node(doc,'p','未找到 Windows Terminal，窗口位置未控制','reason'));
    r['running-records'].append(detail);
  });
  if(!items.length)for(const id of ['running-list','running-records'])r[id].append(node(doc,'p','暂无运行中的会话','empty-list'));
  r['reverify-all'].disabled=ctx.state.reverifyBusy;r['reverify-all-status'].textContent=ctx.state.reverifyMessage;
}
export function renderCoverage(ctx, model) {
  const { refs:r }=ctx;
  drawCoverage(ctx.doc,r['stats-detail'],model.stats);
  const coverageState=model.statsLoading||model.stats?.building?'统计中…':!model.stats?.sources?.some(s=>s.available)?'暂无可读来源':model.stats.limited?'统计范围有限':'来源可读';
  r['stats-summary'].textContent=`数据覆盖 · ${coverageState}`;
  const registry=model.registry;
  r['coverage-list'].replaceChildren(node(ctx.doc,'h2','扫描与覆盖','list-heading'),jumpLink(ctx.doc,'目录扫描','scan',`角色 ${registry.summary.roles} · 书籍 ${registry.summary.books}`),jumpLink(ctx.doc,'数据覆盖','stats-coverage',model.statsLoading?'统计中…':`${model.stats?.sources?.length||0} 个来源`));
  for (const [index,source] of (model.stats?.sources||[]).entries()) {
    const heading=r['stats-detail'].querySelectorAll('h3')[index];
    if (heading) {heading.id=`coverage-source-${index}`;r['coverage-list'].append(jumpLink(ctx.doc,source.id,heading.id,source.available?'来源可读':source.missing?'还没有记录':'来源不可读'));}
  }
  r['scan-summary'].textContent=`目录扫描 · ${formatDate(registry.scannedAt)} · 范围外 ${registry.summary.outOfScope||0} · 无法解析 ${registry.summary.failed||0}`;
  const target=r['scan-detail'];target.replaceChildren();
  const rows=[['来源明细',registry.sources.map(s=>`${s.path}：${s.available?`文件 ${s.total}，解析 ${s.parsed}，排除 ${s.excluded}`:`不可读 · ${s.reason}`}`)],
    ['无法解析',registry.sources.flatMap(s=>(s.failed||[]).map(f=>`${f.file}：${f.reason}`))],
    ['范围外',registry.outOfScope.map(a=>`${a.name}：${a.reason}`)],['身份冲突',registry.conflicts.map(c=>`${c.id}：${c.reason} · ${c.files.join('；')}`)],
    ['映射存在、目录缺失',registry.missingFromDisk.map(a=>a.name)],
    ...(registry.reports?[['无 Word 报告的书籍',registry.reports.booksWithout.map(a=>`${a.name}：${a.title}`)],
      ['未登记的 Word 报告文件',registry.reports.unusedFiles]]:[])];
  for(const [title,values]of rows){target.append(node(ctx.doc,'h3',title));for(const value of values.length?values:['无'])target.append(node(ctx.doc,'p',value));}
}
export function renderRecommend(ctx, model) {
  const {doc,refs:r,actions:a}=ctx, rec=model.recommendation;
  if(r['recommend-input'].value!==model.input)r['recommend-input'].value=model.input;
  r['recommend-count'].textContent=`${model.input.length} / 8000 字`;
  r['recommend-engine'].value=model.engine;r['joint-cli'].value=model.cli;
  const engine=model.settings?.recommend?.[model.engine];r['recommend-model'].textContent=engine?`model ${engine.model} · effort ${engine.effort}`:'模型未声明';
  r['recommend-submit'].disabled=model.busy||!model.input.trim()||model.input.length>8000;
  r['joint-submit'].disabled=!model.selectedIds.length||model.busy||model.jointBusy;
  r.recommendSelectedIds=[...model.selectedIds];
  r['recommend-add'].disabled=!model.selectedIds.length||model.busy||model.jointBusy;
  r['selected-count'].textContent=`已选 ${model.selectedIds.length} 个`;
  r['select-all'].disabled=!model.results.length||model.busy||model.jointBusy;
  r['select-all'].checked=!!model.results.length&&model.selectedIds.length===model.results.length;
  r['select-all'].indeterminate=model.selectedIds.length>0&&model.selectedIds.length<model.results.length;
  r['recommend-disabled-reason'].textContent=model.busy?'推荐进行中，请等待。':!model.input.trim()?'请输入问题或内容。':model.input.length>8000?'输入不能超过 8000 字。':'可开始分析。';
  r['joint-disabled-reason'].textContent=model.jointBusy?'联合调用启动中，请等待。':model.busy?'推荐进行中，请等待。':!model.selectedIds.length?'请至少选择一个 Agent。':'可执行联合调用。';
  const status=r['recommend-status'];status.replaceChildren();status.className='';
  if(rec){status.append(node(doc,'p',`推荐：${labels[rec.status]||rec.status} · ${rec.engine} · ${rec.model||'未声明'} · effort ${rec.effort||'未声明'}`));
    if(rec.error)status.append(node(doc,'p',rec.error,'error'));if(rec.note)status.append(node(doc,'p',rec.note));
    if(rec.status==='done'){
      if(!model.results.length)status.append(node(doc,'p','没有合适的 Agent'));
      if(rec.audit?.ok)status.append(node(doc,'p',`推荐审计通过：Agent 调用 ${rec.audit.agentCalls}，子会话 ${rec.audit.children}`));
      else if(rec.audit?.agentCalls>0||rec.audit?.children>0){status.className='audit-error';status.append(node(doc,'strong','推荐阶段出现了 Agent 调用'));}
      else status.append(node(doc,'p',`推荐审计未确认：${rec.audit?.error||'缺少证据'}`,'audit-error'));
      for(const reject of rec.rejected||[])status.append(node(doc,'p',`被拒绝的推荐：${reject.id} · ${reject.reason||''}`,'reason'));
    }
  }
  const results=r['recommend-results'];results.replaceChildren();
  for(const agent of model.results){
    const card=region(doc,'article','mail-row recommendation-row');
    const open=action(doc,'',e=>a.openDetail(agent.id,e.currentTarget),`查看 ${agent.name} 详情`);markAgentLink(open,agent);
    open.setAttribute('data-focus-key',`recommend-detail-${agent.id}`);open.append(avatar(doc,agent),rowCopy(doc,agent));
    const check=node(doc,'input');check.type='checkbox';check.checked=agent.selected;
    check.disabled=model.busy||model.jointBusy||(!check.checked&&model.selectedIds.length>=8);
    check.setAttribute('data-focus-key',`recommend-check-${agent.id}`);check.setAttribute('aria-label',`选择 ${agent.name}`);
    check.addEventListener('change',()=>a.selectRecommendationAgent(agent.id,check.checked));
    card.append(region(doc,'div','recommendation-choice',check,open),node(doc,'p',`模型理由：${agent.reason}`,'model-reason'));
    if(!agent.platforms[model.cli.replace('inapp:', '')]?.available)card.append(node(doc,'p',`${model.cli.replace('inapp:', '')} 不可用：${agent.platforms[model.cli.replace('inapp:', '')]?.reason||'入口不可用'}`,'reason'));
    results.append(card);
  }
  if(!model.results.length)results.append(node(doc,'p',model.busy?'正在分析…':'输入任务后，推荐结果将显示在这里。','empty-list'));
  const recent=r['recent-list'];recent.replaceChildren();
  for(const item of model.recent){if(item.type==='recommend')recent.append(region(doc,'div','recent-recommend',action(doc,`推荐 · ${item.engine} · ${item.status} · ${item.createdAt}`,()=>a.selectRecommendation(item.id)),node(doc,'p',item.preview)));
    else {const target=region(doc,'article','joint-card');drawJointStatus(doc,target,item,item.verification);target.append(action(doc,'重新核验',()=>a.reverifyJoint(item.id)));recent.append(target);}}
  if(!model.recent.length)recent.append(node(doc,'p','暂无推荐与联合调用记录'));
}
function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function categoryIcon(doc, index) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'category-icon'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-tone', String((index + 6) % 6));
  const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths = ['M4 5h16v14H4z M8 5v14 M11 9h6 M11 13h6', 'M4 18l5-7 5 3 6-9 M4 21h16',
    'M12 3l9 9-9 9-9-9z M8 12h8', 'M3 12h5l3-7 3 14 3-7h4',
    'M8 5l-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18', 'M4 4h16v16H4z M4 16l6-6 4 4 6-8',
    'M4 4h6v6H4z M14 14h6v6h-6z M10 7h7v7', 'M3 20h18 M5 20V9h4v11 M10 20V4h4v16 M15 20V12h4v8',
    'M3 8l9-5 9 5-9 5z M5 12v7h14v-7', 'M12 3v18 M3 12h18 M5 5l14 14 M19 5L5 19',
    'M3 6l9-3 9 3v15l-9-3-9 3z M12 3v15', 'M4 12h16 M12 4v16 M6 6l12 12 M18 6L6 18'];
  shape.setAttribute('d', paths[(index + paths.length) % paths.length]); svg.append(shape); return svg;
}
function button(doc, text, callback) {
  const node = element(doc, 'button', text); node.type = 'button'; node.addEventListener('click', callback); return node;
}
function statsBadge(doc, stats, id) {
  const node = element(doc, 'div', statsText(stats, id), 'stats');
  return node;
}
export function createCard(doc, agent, { categories, onLaunch, onDetails, stats, recommendation = false }) {
  const statusId = `${recommendation ? 'recommend' : 'card'}-${agent.id}-status`;
  const card = element(doc, 'article', undefined, 'card');
  const heading = element(doc, 'div', undefined, 'card-heading');
  const tone = agent.kind === 'role' ? 0 : Math.max(0, categories.indexOf(agent.primary)) + 1;
  const avatar = element(doc, 'span', avatarLetter(agent.name), `avatar tone-${tone}`); avatar.setAttribute('aria-hidden', 'true');
  const name = element(doc, 'h3');
  const detailButton = button(doc, agent.name, event => onDetails(agent, event?.currentTarget));
  markAgentLink(detailButton,agent);detailButton.setAttribute('aria-label', `查看 ${agent.name} 详情`);
  detailButton.setAttribute('data-focus-key', `${recommendation ? 'recommend' : 'card'}-detail-${agent.id}`);
  name.append(detailButton);
  heading.append(avatar, name); card.append(heading);
  if (agent.writable) heading.append(element(doc, 'strong', accessLabel(agent), 'writable-badge'));
  if (agent.kind === 'book' && agent.sources) card.append(element(doc, 'p', !agent.sources.checked ? '原书路径未检查' : agent.sources.missing.length ? `原书路径失效 ${agent.sources.missing.length} 处` : '原书可用', agent.sources.missing.length ? 'reason source-badge' : 'tag'));
  if (agent.sync && agent.sync.state !== '同步') card.append(element(doc, 'p', syncLabel(agent.sync), 'tag sync-badge'));
  heading.append(statsBadge(doc, stats, agent.id));
  const tag = element(doc, 'div', undefined, 'tag');
  tag.append(categoryIcon(doc, tone), element(doc, 'span', agent.primary)); card.append(tag);
  card.append(element(doc, 'p', agent.purpose || summary(agent.description), 'description'));
  if (agent.book) card.append(markAgentLink(element(doc, 'p', `${bookLabel(agent)}\n${authorShort(agent)} · ${agent.book.edition}`, 'book-meta'), agent));
  if (agent.tags.length) card.append(element(doc, 'p', agent.tags.join(' · '), 'tag'));
  if (agent.taskFormat) card.append(element(doc, 'p', '转调 · 自动套用任务格式', 'tag'));
  card.append(element(doc, 'div', `Codex ${agent.platforms.codex.available ? '✓' : '✗'} / Claude ${agent.platforms.claude.available ? '✓' : '✗'}`, 'platforms'));
  card.append(element(doc, 'p', permissionText(agent), 'permissions'));
  const actions = element(doc, 'div', undefined, 'actions'), buttons = [];
  for (const [cli, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
    const platform = agent.platforms[cli];
    const invoke = button(doc, `在 ${label} CLI 中调用`, () => { if (!invoke.disabled) onLaunch(agent, cli); });
    invoke.setAttribute('aria-label', `在 ${label} CLI 中调用 ${agent.name}`);
    invoke.setAttribute('aria-describedby', statusId);
    invoke.setAttribute('data-focus-key', `launch-${agent.id}-${cli}`);
    invoke.disabled = !platform.available;
    if (!platform.available) invoke.title = platform.reason;
    if (!recommendation) { actions.append(invoke); buttons.push(invoke); }
    if (!platform.available) {
      const reason = element(doc, 'p', platform.reason, 'reason');
      reason.id = `${recommendation ? 'recommend' : 'card'}-${agent.id}-${cli}-reason`;
      invoke.setAttribute('aria-describedby', reason.id); actions.append(reason);
    }
  }
  card.append(actions);
  const status = element(doc, 'div', undefined, 'status'); status.id = statusId; status.setAttribute('aria-live', 'polite'); status.hidden = true; card.append(status);
  return { card, status, buttons };
}
export function fillDetails(doc, body, agent, stats) {
  body.replaceChildren(element(doc, 'p', agent.description || '无描述', 'full-description'));
  const fields = [['Codex 源文件', agent.sourceFile]];
  if (agent.platforms.claude.file) fields.push(['Claude 入口文件', agent.platforms.claude.file]);
  if (agent.book) fields.push(['书名', agent.book.title], ['作者', agent.book.author], ['版本', agent.book.edition]);
  const list = element(doc, 'dl');
  for (const [key, value] of fields) list.append(element(doc, 'dt', key), markAgentLink(element(doc, 'dd', value || '未载明'),key==='书名'?agent:null));
  body.append(list);
  body.append(element(doc, 'h3', '权限与模型'), element(doc, 'p', permissionText(agent), 'permissions'));
  if (agent.sources) {
    body.append(element(doc, 'h3', '原书路径'), element(doc, 'p', `已检查：${agent.sources.checked ? '是' : '否'} · 路径 ${agent.sources.total} 条`));
    for (const missing of agent.sources.missing) body.append(element(doc, 'p', missing, 'reason'));
    if (agent.sources.missing.length) body.append(element(doc, 'p', '书的路径写在这个 Agent 的定义文件里（即 Codex 源文件和 Claude 入口文件）。请把书放回列出的路径，或用文本编辑器打开定义文件，把路径改成书现在的位置，然后到 设置 → 目录 点「刷新目录」。'));
  }
  if (agent.sync) {
    body.append(element(doc, 'h3', '双版本同步'), element(doc, 'p', agent.sync.detail && agent.sync.detail !== agent.sync.state ? `${syncLabel(agent.sync)}：${agent.sync.detail}` : syncLabel(agent.sync)));
    if (agent.sync.state !== '同步') body.append(element(doc, 'p', '如需一致：对照差异手动更新 Claude 版本，保留其中专为 Claude 写的工具映射段'));
  }
  body.append(statsBadge(doc, stats, agent.id));
  if (!statsReadable(stats) || stats.building || !stats.perAgent[agent.id]) return;
  const counts = stats.perAgent[agent.id];
  for (const [key, label] of [['last7d', '近 7 天'], ['total', '累计']]) {
    const count = counts[key];
    body.append(element(doc, 'p', `${label}：调用 ${count.calls} · Claude ${count.bySource.claude} / Codex ${count.bySource.codex} · 成功 ${count.ok} / 失败 ${count.failed} / 未知 ${count.unknown}`));
  }
  body.append(element(doc, 'p', `启动：近 7 天 ${counts.launches.last7d} · 累计 ${counts.launches.total}`),
    element(doc, 'p', `最后一次调用（本机时区）：${formatDate(counts.lastAt)}`));
  if (stats.last7dLimited) body.append(element(doc, 'p', `近 7 天范围有限：${stats.last7dLimitedReasons.join('；')}`, 'reason'));
}
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
export function drawRunning(doc, target, value) {
  if (!target) return;
  const states = { pending: '待核验', ready: '已就绪', resumed: '已恢复', failed: '失败', unconfirmed: '未确认', done: '完成' };
  target.replaceChildren();
  for (const item of value.items) {
    const row=fillAgentNames(doc,node(doc,'p'),runningMembers(item));
    row.append(node(doc,'span',` · ${item.cli} · ${formatDate(item.createdAt)} · ${states[item.status?.overall] || item.status?.overall || '待核验'}${item.status?.terminalFallback === 'no-wt' ? ' · 未找到 Windows Terminal，窗口位置未控制' : ''}`));target.append(row);
  }
  if (!value.items.length) target.append(element(doc, 'p', '暂无运行中的会话'));
}
const labels = { closed: '已关闭', pending: '待核验', running: '运行中', done: '完成', failed: '失败', unconfirmed: '未确认', ok: '通过', 'not-parallel': '未并行', violation: '越权', alive: '存活', exited: '已退出', mismatch: '不符' };
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

// Stage A2 default; Stage B owns this layout composition.
const statsRanges = {'7d':'近 7 天', '30d':'近 30 天', all:'累计'};
function statsControl(ctx, label, key, callback, pressed) {
  const button = action(ctx.doc, label, callback);
  button.setAttribute('data-focus-key', `stats-${key}`);
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  return button;
}
function statsDonut(ctx, segments, label, value, selected, onSelect) {
  const chart = donut({segments, centerLabel:label, centerValue:value, onSelect}, ctx.doc);
  const buttons = chart.querySelector('.chart-legend').children;
  segments.forEach((segment, index) => {
    const swatch = node(ctx.doc, 'span', undefined, `stats-swatch ${segment.colorClass}`);
    swatch.setAttribute('aria-hidden', 'true'); buttons[index].prepend(swatch);
    buttons[index].setAttribute('aria-pressed', String(segment.key === selected));
  });
  for (const slice of chart.querySelectorAll('[data-segment]')) {
    slice.setAttribute('aria-pressed', String(slice.getAttribute('data-segment') === selected));
  }
  return chart;
}
function statsSourceLegend(doc) {
  return region(doc, 'div', 'stats-source-legend', ...['Claude','Codex'].map(label => {
    const swatch = node(doc, 'span', undefined, `stats-swatch chart-${label.toLowerCase()}`);
    swatch.setAttribute('aria-hidden', 'true');
    return region(doc, 'span', '', swatch, node(doc, 'span', label));
  }));
}
function renderStatsSummary(ctx, model) {
  const {doc, refs:r, actions:a} = ctx, panel = r['stats-agent-summary'];
  const agent = model.agents.find(item => item.id === r.statsSelectedId);
  panel.replaceChildren(); panel.hidden = !agent;
  if (!agent) r.statsSelectedId = null;
  else {
    const title = markAgentLink(node(doc, 'h2', agent.name, 'stats-heading'), agent);
    title.setAttribute('tabindex', '-1'); title.setAttribute('data-focus-key', 'stats-agent-heading');
    const copy = region(doc, 'div', 'detail-heading-copy', title,
      markAgentLink(node(doc, 'p', agent.bookLabel || agent.purpose || '用途未载明', 'stats-note'), agent));
    const details = statsControl(ctx, '查看详情', 'agent-detail', event => a.openDetail(agent.id, event.currentTarget));
    details.className = 'outline-button';
    details.setAttribute('aria-label', `查看 ${agent.name} 详情`);
    panel.append(region(doc, 'div', 'detail-hero', avatar(doc, agent, true), copy),
      node(doc, 'p', `${statsRanges[model.range]} · 调用 ${agent.value} · Claude ${agent.claude} / Codex ${agent.codex}`, 'stats-summary-counts'),
      node(doc, 'p', `成功 ${agent.ok} / 失败 ${agent.failed} / 未知 ${agent.unknown}`, 'stats-note'),
      node(doc, 'p', `最近调用：${agent.lastAt ? formatDate(agent.lastAt) : '未载明'}`, 'stats-note'), details);
  }
  for (const button of r.parts.statsRanking.querySelectorAll('.chart-bar-row')) {
    button.setAttribute('aria-controls', 'stats-agent-summary');
    button.setAttribute('aria-pressed', String(button.getAttribute('data-agent-id') === r.statsSelectedId));
  }
}
export function renderStats(ctx, model) {
  const {doc, refs:r, actions:a} = ctx, {stats:panel, statsRanking:ranking} = r.parts;
  const visible = ctx.state.view === 'stats', entering = visible && !r.statsVisible;
  const leavingWithFocus = !visible && r.statsVisible && (panel.contains(doc.activeElement) || ranking.contains(doc.activeElement));
  r.statsVisible = visible;
  updateVisibility(ctx);
  // Other layouts still use the temporary shared page; clear its shell flag on return.
  ctx.root.parentElement?.setAttribute('data-stats-open', 'false');
  if (leavingWithFocus) r.statsEntry.focus();
  if (!visible || !model) return;
  const signature = JSON.stringify([model, ctx.state.categories]);
  if (signature === r.statsSignature) { if (entering) focusPaneHeading(ctx,r.statsHeading); return; }
  r.statsSignature = signature;
  const title = node(doc, 'h1', '调用统计', 'stats-heading');
  title.setAttribute('tabindex', '-1'); r.statsHeading = title;
  const toolbar = region(doc, 'div', 'stats-toolbar',
    statsControl(ctx, '返回 Agent', 'back', () => a.showView('catalog')),
    statsControl(ctx, '刷新统计', 'refresh', a.refreshStats));
  const ranges = region(doc, 'div', 'stats-controls', ...Object.entries(statsRanges).map(([key, label]) =>
    statsControl(ctx, label, key, () => a.setStatsRange(key), model.range === key)));
  ranges.setAttribute('aria-label', '统计时间范围');
  const limited = node(doc, 'p', `数据范围有限：${model.limitedReasons.join('；') || '统计来源覆盖不完整'}`, 'stats-limited');
  limited.id = 'stats-limited'; limited.setAttribute('role', 'status'); limited.hidden = !model.limited;
  panel.replaceChildren(region(doc, 'header', 'stats-header', toolbar, title, ranges, limited));
  const preview = node(doc, 'section', undefined, 'stats-agent-summary');
  preview.id = 'stats-agent-summary'; preview.hidden = true;
  preview.setAttribute('aria-label', '已选 Agent 摘要'); preview.setAttribute('aria-live', 'polite');
  r['stats-agent-summary'] = preview;
  ranking.replaceChildren(preview, node(doc, 'h2', 'Agent 调用排行', 'stats-heading'));
  if (model.status !== 'ready') {
    r.statsSelectedId = null;
    const message = model.status === 'loading' ? '统计正在建立…' : '调用统计暂不可用';
    for (const target of [panel, ranking]) {
      const status = node(doc, 'p', message, 'stats-empty'); status.setAttribute('role', 'status'); target.append(status);
    }
    if (entering) focusPaneHeading(ctx,title);
    return;
  }
  const t = model.totals;
  panel.append(region(doc, 'div', 'stats-totals',
    node(doc, 'p', `调用 ${t.calls} · 已调用 Agent ${t.agentsUsed}`),
    node(doc, 'p', `Claude ${t.claude} / Codex ${t.codex}`, 'stats-note'),
    node(doc, 'p', `成功 ${t.ok} / 失败 ${t.failed} / 未知 ${t.unknown}`, 'stats-note')));
  // Category order in the model changes with counts. Bind color to registry identity.
  const categories = [...new Set([...(ctx.state.categories || []), ...model.byCategory.map(s => s.key).sort()])];
  const kinds = model.byKind.map(s => ({...s, colorClass:`chart-${s.key}`}));
  const bookCategories = model.byCategory.map(s => ({...s, colorClass:`threepane-chart-${categories.indexOf(s.key) % 11}`}));
  const chartSection = (heading, ...children) => region(doc, 'section', 'stats-chart', node(doc, 'h2', heading), ...children);
  panel.append(chartSection('功能性 / 书籍', statsDonut(ctx, kinds, '调用', t.calls, model.filter, a.setStatsFilter)),
    chartSection('书籍分类', statsDonut(ctx, bookCategories, '书籍调用', model.byKind.find(s => s.key === 'book')?.value || 0, model.categoryFilter, a.setStatsCategory)));
  const points = model.daily.map(p => ({label:p.day, value:p.calls, parts:[
    {key:'claude', value:p.claude, colorClass:'chart-claude'}, {key:'codex', value:p.codex, colorClass:'chart-codex'}]}));
  const trend = chartSection('近 30 天每日趋势',
    node(doc, 'p', '趋势固定展示近 30 天全部 Agent，日期按本机时区。', 'stats-note'),
    statsSourceLegend(doc), columns({points, height:160}, doc));
  panel.append(trend, node(doc, 'p', `更新：${model.generatedAt ? formatDate(model.generatedAt) : '未载明'} · 调用次数不包含启动次数`, 'stats-note stats-updated'));
  const filters = region(doc, 'div', 'stats-controls', ...Object.entries({all:'全部', role:'功能性', book:'书籍'}).map(([key, label]) =>
    statsControl(ctx, label, `filter-${key}`, () => a.setStatsFilter(key), model.filter === key)));
  filters.setAttribute('aria-label', '排行榜筛选');
  ranking.append(filters);
  if (model.categoryFilter) {
    const clear = statsControl(ctx, `分类：${model.categoryFilter} · 取消筛选`, 'category', () => a.setStatsCategory(model.categoryFilter), true);
    clear.className = 'stats-category'; ranking.append(clear);
  }
  ranking.append(node(doc, 'p', `${statsRanges[model.range]} · ${model.agentCount} 个 Agent · ${model.showAll ? '全部' : '前 20 名'}，按调用数从高到低`, 'stats-note'), statsSourceLegend(doc));
  const rows = model.agents.map(agent => ({id:agent.id, label:agent.name, sublabel:agent.bookLabel || agent.purpose || '用途未载明', value:agent.value,
    parts:[{key:'claude', value:agent.claude, colorClass:'chart-claude'}, {key:'codex', value:agent.codex, colorClass:'chart-codex'}]}));
  const select = id => {
    r.statsSelectedId = id; renderStatsSummary(ctx, model);
    preview.querySelector('[data-focus-key="stats-agent-heading"]')?.focus(); ranking.parentElement.scrollTop = 0;
  };
  ranking.append(barList({rows:rows.filter(row => row.value > 0), onSelect:select}, doc));
  const expand = statsControl(ctx, model.showAll ? '收起至前 20 名' : `展开全部（${model.agentCount}）`, 'expand', a.toggleStatsShowAll);
  expand.setAttribute('aria-expanded', String(model.showAll)); expand.className = 'text-button'; ranking.append(expand);
  if (model.zeroCount) {
    const zero = statsControl(ctx, `未调用的 Agent：${model.zeroCount} 个 · ${model.showAll ? '收起' : '展开'}`, 'zero-expand', a.toggleStatsShowAll);
    zero.className = 'stats-zero'; zero.setAttribute('aria-expanded', String(model.showAll)); zero.setAttribute('aria-controls', 'stats-zero-list');
    const list = node(doc, 'div'); list.id = 'stats-zero-list'; list.hidden = !model.showAll;
    if (model.showAll) list.append(barList({rows:rows.filter(row => row.value === 0), onSelect:select}, doc));
    ranking.append(zero, list);
  }
  renderStatsSummary(ctx, model);
  if (entering) focusPaneHeading(ctx,title);
}

// v0.14 调用组 for threepane: left quick list (most recent first), middle list, right detail.
export function renderGroups(ctx, model) {
  const {doc,refs:r,actions:a}=ctx,p=r.parts; if(!p||!model)return;
  // Left column quick entries: up to five groups; one click opens the 提问 dialog.
  const quick=p.groupsNav; quick.replaceChildren();
  if(model.groups.length){
    const head=action(doc,'调用组',()=>a.openGroups(),'查看全部调用组');head.className='groups-nav-head';head.setAttribute('data-focus-key','groups-nav-head');
    quick.append(head);
    for(const group of model.groups.slice(0,5)){
      const button=action(doc,'',event=>a.askGroup(group.id,event.currentTarget),`向调用组「${group.name}」提问`);
      button.className='groups-nav-item';button.setAttribute('data-focus-key',`groups-nav-${group.id}`);
      button.append(node(doc,'span',group.name,'groups-nav-name'),node(doc,'span',String(group.members.length),'groups-nav-count'));
      button.title=`${group.memberNames}\n点击提问`;quick.append(button);
    }
    if(model.groups.length>5){const more=action(doc,`全部 ${model.groups.length} 个 →`,()=>a.openGroups(),'查看全部调用组');more.className='groups-nav-more';quick.append(more);}
  }
  quick.hidden=!model.groups.length;
  // Middle list.
  const list=r['groups-list']; list.replaceChildren();
  r['groups-list-title'].textContent=model.loading?'调用组 · 读取中…':`调用组 · ${model.groups.length} 个`;
  for(const group of model.groups){
    const row=action(doc,'',()=>a.selectGroup(group.id),`查看调用组「${group.name}」`);
    row.className='groups-row';row.setAttribute('data-focus-key',`groups-row-${group.id}`);
    if(group.id===model.selectedId)row.setAttribute('aria-current','true');
    const avatars=node(doc,'span',undefined,'groups-row-avatars');
    for(const m of group.members.slice(0,4)){const dot=node(doc,'span',m.avatarLetter,'avatar small');dot.setAttribute('aria-hidden','true');dot.style?.setProperty('background',m.avatarColor);avatars.append(dot);}
    if(group.members.length>4)avatars.append(node(doc,'span',`+${group.members.length-4}`,'avatar small more'));
    row.append(avatars,region(doc,'span','groups-row-text',node(doc,'strong',group.name),node(doc,'span',group.memberNames,'muted'),node(doc,'span',groupMeta(group),'muted small')));
    list.append(row);
  }
  if(!model.groups.length&&!model.loading)list.append(node(doc,'p','还没有调用组。点左上角「＋ 新建联合调用」，选好 Agent 起个名字保存。','groups-empty-hint'));
  // Right detail.
  const detail=p.groups; detail.replaceChildren();
  const group=model.selected;
  if(model.error)detail.append(node(doc,'p',model.error,'concept-notice'));
  if(!group){
    const create=action(doc,'＋ 新建联合调用',e=>a.newGroup(e.currentTarget));create.className='primary-button';create.setAttribute('data-focus-key','groups-detail-new');
    detail.append(region(doc,'div','groups-detail-empty',node(doc,'h1','调用组'),
      node(doc,'p','把常一起用的几个 Agent 存成一组。之后随时点「提问」，选一个预设问题或写个新问题就能召集它们。','muted'),create));
    return;
  }
  detail.append(node(doc,'h1',group.name,'groups-detail-title'),node(doc,'p',groupMeta(group),'muted'),groupMembers(doc,group),groupActions(ctx,group,'groups-detail'));
  const presets=node(doc,'section',undefined,'groups-detail-presets');presets.setAttribute('aria-label','预设问题');
  presets.append(node(doc,'h2','预设问题'));
  if(!group.presets.length)presets.append(node(doc,'p','还没有预设问题。点「提问」写一个问题，勾选「保存为预设问题」后就会出现在这里。','muted'));
  for(const preset of group.presets){
    const use=action(doc,'',event=>a.askGroup(group.id,event.currentTarget,preset.text),`用预设问题提问：${preset.title||preset.text.slice(0,40)}`);
    use.className='groups-preset';use.setAttribute('data-focus-key',`groups-preset-${preset.id}`);
    if(preset.title)use.append(node(doc,'strong',preset.title));
    use.append(node(doc,'span',preset.text,'groups-preset-text'));presets.append(use);
  }
  detail.append(presets);
}
