import { markAgentLink, fillAgentNames, openFileButton, runningMembers } from '../agent-links.js';
import { node, action, region, runningCloseHeading, runningCloseRow, updateRunningClose, renderCandidateNotice, emptyCatalog, pinButton, inAppButton, conceptResponse, updateConceptResponseNote, renderConceptThread } from './shared.js';
import { donut, barList, columns } from '../charts.js';
import { renderMarkdown } from '../markdown.js';
import { manageDialog } from '../accessibility.js';
import { cleanTitle, spineTitle, formatDate, summary, conceptStatus, avatarLetter, avatarColor, setStyle } from '../display.js';
export const initialCategory = 'role';
export const jointBuilderSkin = 'editorial-builder';
function build(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const make = (tag, id, text, cls, attrs, children) => {
    const el = node(doc, tag, text || undefined, cls);
    if (id) { el.id = id; r[id] = el; }
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value ?? '');
    el.append(...children); return el;
  };
  const p = {};
  p.brand = make('div', 'brand', '', 'brand', {}, [make('img', '', '', 'brand-logo', {src:'/brand/co-agent-icon.svg',alt:'',hidden:null}, []), make('div', 'issue-date', '', 'issue-date', {}, []), make('h1', '', 'CO-AGENT', '', {}, [])]);
  p.search = make('div', 'search-control', '', '', {}, [make('input', 'search', '', '', {type:'search',placeholder:'检索作者、书名…',autocomplete:'off','aria-label':'全局搜索',title:'/ 或 Ctrl+K'}, [])]);
  p.navigation = make("nav", "navigation", "", "", {"aria-label": "Agent 分类"}, []);
  p.catalog = make('section', 'catalog', '', '', {}, [make('div', 'cards', '', '', {'aria-live':'polite'}, [])]);
  p.directoryHeading = make('div', 'editorial-directory-heading', '', 'editorial-directory-heading', {}, [make('h2', 'view-title', '', 'eyebrow', {}, []), p.search]);
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
    make("div", "recommend-results", "", "cards", {}, []),
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
  p.running = make("section", "running-panel", "", "scan", {"aria-labelledby": "running-title"}, [runningCloseHeading(ctx,make("h2", "running-title", "运行中的会话", "", {}, [])), make("button", "reverify-all", "全部重新核验", "", {"type": "button", "aria-label": "全部重新核验范围内 Agent 的旧记录"}, []), make("p", "reverify-all-status", "", "", {"role": "status", "aria-live": "polite"}, []), make("div", "running-list", "正在读取…", "", {"aria-live": "polite"}, [])]);
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
  p.coverage = make("section", "coverage-panel", "", "", {"aria-label": "扫描摘要和数据覆盖"}, [make("h2", "", "扫描摘要和数据覆盖", "", {}, [])]);
  p.metrics = make("section", "metrics", "", "", {"aria-label": "统计概览"}, []);
  p.detailDialog = make("dialog", "detail", "", "editorial-drawer", {"role": "dialog", "aria-modal": "true", "aria-labelledby": "detail-title"}, [make("div", "detail-heading", "", "drawer-heading", {}, [make("h2", "detail-title", "", "", {}, []), make("button", "close-detail", "关闭", "", {"type": "button", "aria-label": "关闭详情"}, [])]), make("div", "detail-body", "", "", {}, [])]);
  const scan = make("details", "scan", "", "scan", {}, [make("summary", "scan-summary", "正在读取 Agent 目录…", "", {}, []), make("div", "scan-detail", "", "", {}, [])]);
  const stats_coverage = make("details", "stats-coverage", "", "scan", {}, [make("summary", "stats-summary", "数据覆盖 · 统计中…", "", {}, []), make("div", "stats-detail", "", "", {}, []), make("button", "stats-refresh", "重新统计", "", {"type": "button"}, [])]);
  const recent_panel = make("details", "recent-panel", "", "scan", {}, [make("summary", "", "最近的推荐与联合调用（20 条）", "", {}, []), make("div", "recent-list", "", "", {"aria-live": "polite"}, [])]);
  p.coverage.append(scan, stats_coverage); p.recommend.append(recent_panel);
  p.settings = action(doc, '设置', e => a.openSettings(e.currentTarget), '打开设置'); p.settings.id = 'settings-open';
  p.settings.setAttribute('data-focus-key', 'settings-open');
  p.detailHeading = r['detail-heading']; p.detailBody = r['detail-body'];
  const bind = (id, event, fn) => r[id].addEventListener(event, fn);
  bind('search', 'input', e => a.search(e.currentTarget.value));
  bind('history-filter', 'change', e => a.setHistoryFilter(e.currentTarget.value));
  bind('history-refresh', 'click', a.refreshHistory);
  bind('stats-refresh', 'click', a.refreshStats);
  bind('reverify-all', 'click', a.reverifyAll);
  bind('recommend-input', 'input', e => a.setRecommendInput(e.currentTarget.value));
  bind('recommend-engine', 'change', e => a.setRecommendEngine(e.currentTarget.value));
  bind('recommend-submit', 'click', a.recommend);
  bind('joint-cli', 'change', e => a.setJointCli(e.currentTarget.value));
  bind('joint-submit', 'click', a.launchRecommendedJoint);
  bind('select-all', 'change', e => a.selectAllRecommendations(e.currentTarget.checked));
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
  const callbacks = { '新建联合调用': e => a.openJoint(focusMemberIds(ctx.state), e.currentTarget),
    '发起联合调用': e => a.openJoint(ctx.state.jointSelectedIds, e.currentTarget),
    'AI 推荐': () => a.showView('recommend'), '历史调用': () => a.showView('history'),
    '运行中的会话': () => a.showView('running'), '扫描摘要和数据覆盖': () => a.showView('coverage'),
    '目录': () => a.showView('catalog'), '人物': () => a.selectCategory('role'), '藏书': () => a.selectCategory('book') };
  const el = action(ctx.doc, text, callbacks[name], name); el.className = cls || '';
  el.setAttribute('data-focus-key', `entry-${name}`); return el;
}
// v0.53: the example joint call is the catalog's featured entry (registry.display), never names in the code.
function focusMembers(state) {
  const featured = state.display?.featured, members = (featured?.members || []).map(member =>
    ({ ...member, agent: (state.allAgents || []).find(agent => agent.id.toLowerCase() === member.id) }));
  return members.length >= 2 && members.every(member => member.agent) ? members : [];
}
const focusMemberIds = state => focusMembers(state).map(member => member.agent.id);
function updateFocus(ctx) {
  const members=focusMembers(ctx.state),copy=ctx.refs.focusCopy;
  const lines=members.length&&ctx.state.display.featured.title?.length?ctx.state.display.featured.title:['一个问题，','请几位作者坐下来谈谈。'];
  ctx.refs.focusTitle.replaceChildren(...lines.flatMap((line,index)=>[...(index?[node(ctx.doc,'br')]:[]),node(ctx.doc,'span',line)]));
  if(!members.length){copy.textContent='一个问题，多位作者的回答。';return;}
  const parts=members.flatMap((member,index)=>[...(index?[node(ctx.doc,'span',index===members.length-1?' 与 ':'、')]:[]),
    markAgentLink(node(ctx.doc,'span',member.label),member.agent.id)]);
  copy.replaceChildren(...parts,node(ctx.doc,'span',' '+ctx.state.display.featured.text));
}
function directoryTitle(agent) {
  if (agent.kind !== 'book') return { text: agent.name, full: agent.name };
  const raw = agent.book?.title || agent.cleanTitle;
  const full = cleanTitle(raw).text || agent.name;
  return { text: agent.spineTitle || spineTitle(raw) || full, full };
}
export function render(ctx) {
  const { doc, refs:r } = ctx; const p = build(ctx), columns = region(doc, 'nav', 'editorial-columns'); columns.setAttribute('aria-label', '栏目');
  for (const name of ['目录', '人物', '藏书']) columns.append(entry(ctx, name));
  r['editorial-running'] = entry(ctx, '运行中的会话', '运行中 0');
  r['editorial-running'].id = 'editorial-running'; r['editorial-running'].hidden = true;
  r.conceptsEntry = action(doc, '概念', () => ctx.actions.openConcepts(), '随机概念');
  r.conceptsEntry.id = 'concepts-open'; r.conceptsEntry.setAttribute('data-focus-key', 'concepts-open');
  r.statsEntry = action(doc, '统计', () => ctx.actions.openStats(), '调用统计');
  r.statsEntry.id = 'stats-open'; r.statsEntry.setAttribute('data-focus-key', 'stats-open');
  r.seminarsEntry = seminarControl(ctx, '圆桌', 'open', () => ctx.actions.openSeminars());
  r.groupsEntry = action(doc, '调用组', () => ctx.actions.openGroups(), '调用组');
  r.groupsEntry.id = 'groups-open'; r.groupsEntry.setAttribute('data-focus-key', 'groups-open');
  const consultEntry = action(doc, '会诊室', () => ctx.actions.openConsults());
  consultEntry.id = 'consults-open'; consultEntry.setAttribute('data-focus-key', 'consults-open');
  const chatsEntry = action(doc, '对话', () => ctx.actions.openChats(), '软件内对话');
  chatsEntry.id = 'chats-open'; chatsEntry.setAttribute('data-focus-key', chatsEntry.id);
  const councilsEntry = action(doc, '顾问团', () => ctx.actions.openCouncils());
  councilsEntry.id = 'councils-open'; councilsEntry.setAttribute('data-focus-key', councilsEntry.id);
  const mapEntry = action(doc, '概念地图', () => ctx.actions.openConceptMap());
  mapEntry.id = 'concept-map-open'; mapEntry.setAttribute('data-focus-key', mapEntry.id);
  columns.append(r.groupsEntry, entry(ctx, 'AI 推荐', '推荐'), r.conceptsEntry, r.seminarsEntry, consultEntry, councilsEntry, mapEntry, chatsEntry, r.statsEntry, entry(ctx, '历史调用', '往期'), r['editorial-running'], p.settings);
  const head = region(doc, 'header', 'editorial-masthead', p.brand, columns);
  const title = node(doc, 'h2');
  r.focusTitle = title;
  r.focusCopy = node(doc, 'p', undefined, 'focus-copy');
  updateFocus(ctx);
  const focus = region(doc, 'section', 'editorial-focus', node(doc, 'p', '本周焦点', 'eyebrow'), title,
    r.focusCopy,
    region(doc,'div','focus-actions',entry(ctx, '新建联合调用', '发起联合调用', 'compose'), entry(ctx, 'AI 推荐', '先让 AI 推荐')), p.metrics);
  r.focus = focus;
  const directory = region(doc, 'section', 'editorial-directory', p.directoryHeading, p.navigation, p.catalog, r['recommend-results'], p.history, p.running, p.coverage);
  directory.setAttribute('aria-label', '藏书目录');
  r.spread = region(doc, 'main', 'editorial-spread', region(doc,'section','editorial-left',focus,p.recommend), directory);
  const root = region(doc, 'div', 'layout-editorial', head, renderCandidateNotice(ctx), r.spread, buildConcepts(ctx), buildStats(ctx));
  root.append(p.detailDialog);
  return root;
}
function updateVisibility(ctx) {
  const {refs:r,state:s}=ctx,p=r.parts,view=s.view;
  for(const name of ['catalog','recommend','history','running','coverage'])p[name].hidden=name!==view;
  r.focus.hidden = view === 'recommend'; r['recommend-results'].hidden = view !== 'recommend';
  r.navigation.hidden = view !== 'catalog';
}
export function renderCatalog(ctx, model) {
  const {doc,refs:r,actions:a}=ctx, target=r.cards, agents=model.agents, selectedId=model.selectedId;
  const onDetails=(agent,trigger)=>a.openDetail(agent.id,trigger), onLaunch=(agent,cli)=>a.launch(agent.id,cli);
  r['view-title'].textContent=ctx.state.view === 'catalog' ? `${ctx.state.category === 'role' && !model.query ? '人物目录' : '藏书目录'} · ${model.title}` : {history:'往期 · 历史调用',recommend:'推荐 · 为你的问题选书',running:'运行中的会话',coverage:'扫描与覆盖',concepts:'今日一讲',stats:'数据专栏'}[ctx.state.view];
  if(r.search.value !== model.query)r.search.value=model.query;
  updateFocus(ctx);
  updateVisibility(ctx);
  const rendered = new Map(); target.replaceChildren();
  function row(agent,index) {
    const el = region(doc, 'article', 'directory-row');
    if (selectedId === agent.id) el.setAttribute('data-selected', 'true');
    const open = action(doc, '', event => onDetails(agent, event.currentTarget), `查看 ${agent.name} 详情`);
    open.setAttribute('data-focus-key', `card-detail-${agent.id}`);

      const info = node(doc, 'div', undefined, 'directory-copy');
      el.append(node(doc, 'span', String(index + 1).padStart(2, '0'), 'directory-number'));
      const heading = directoryTitle(agent);
      open.textContent = heading.text; open.setAttribute('title', heading.full);
      open.className = 'directory-title';markAgentLink(open,agent);
      info.append(open,markAgentLink(node(doc,'div',agent.kind === 'book' ? `${agent.authorShort || '作者未载明'} · 由 ${agent.name} 主讲` : agent.purpose || summary(agent.description),'row-subtitle'), agent));
    el.append(info);
    const buttons = [];

      const controls = region(doc, 'div', 'directory-actions');
      for (const [cli, name] of [['claude', 'Claude'], ['codex', 'Codex']]) {
        const invoke = action(doc, name, () => onLaunch(agent, cli), `在 ${name} CLI 中调用 ${agent.name}`);
        invoke.disabled = !!agent.launchBusy || !agent.platforms[cli]?.available; buttons.push(invoke); controls.append(invoke);
        invoke.setAttribute('data-focus-key', `catalog-launch-${agent.id}-${cli}`);
        if (invoke.disabled) { const reason = node(doc, 'span', agent.launchBusy ? '正在启动，请稍候' : agent.platforms[cli]?.reason || '入口不可用', 'editorial-sr-only'); reason.id = `catalog-${agent.id}-${cli}-reason`; invoke.setAttribute('aria-describedby', reason.id); invoke.setAttribute('title', reason.textContent); info.append(reason); }
      }
      el.append(controls);

    const status = node(doc, 'div', undefined, 'status'); status.hidden = true; status.setAttribute('aria-live', 'polite'); el.append(status);
    rendered.set(agent.id, { card: el, status, buttons }); return el;
  }
  agents.forEach((a,i)=>target.append(row(a,i)));
  if(model.empty)target.append(emptyCatalog(ctx,model.empty));
  else if(!agents.length)target.append(node(doc,'p',model.query?'没有匹配的 Agent':'当前分类没有 Agent。','description'));
  for(const agent of agents)if(agent.launchStatus&&rendered.has(agent.id))renderStatus(doc,rendered.get(agent.id).status,agent.launchStatus);
  return rendered;
}
export function renderCategories(ctx, categories) {
  renderCandidateNotice(ctx, ctx.state.candidateCount);
  const { doc, refs: r, actions: a } = ctx; r.navigation.replaceChildren();
  for (const c of categories) {
    const el = action(doc, c.fullLabel || c.label, () => a.selectCategory(c.key));
    el.setAttribute('title',c.fullLabel || c.label); el.setAttribute('data-focus-key', `nav-${c.key}`);
    if (c.selected) el.setAttribute('aria-current', 'page'); r.navigation.append(el);
  }
}
export function renderDetail(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, body = r['detail-body'];
  const detailKey = JSON.stringify([model, ctx.state.view]);
  if (r.detailKey !== detailKey) {
    r.detailKey = detailKey;
    const expanded = r.detailAgentId === model?.id && body.querySelector('details')?.open;
    r.detailAgentId = model?.id;
    r['detail-title'].textContent = model?.name || '请选择 Agent'; r['detail-title'].removeAttribute('data-agent-link'); if(model)markAgentLink(r['detail-title'],model); body.replaceChildren();
    if (model) {
      const controls = region(doc, 'div', 'actions');
      for (const [cli, name] of [['claude','Claude'],['codex','Codex']]) {
        const launch = action(doc, `在 ${name} CLI 中调用 ${model.name}`, () => a.launch(model.id, cli));
        markAgentLink(launch,model);launch.setAttribute('data-focus-key', `detail-launch-${cli}`); launch.disabled = model.launchBusy || !model.platforms[cli]?.available;
        controls.append(launch);
        if (!model.platforms[cli]?.available) {
          const why = node(doc, 'p', model.platforms[cli]?.reason || '入口不可用', 'reason'); why.id = `detail-${cli}-reason`;
          launch.setAttribute('aria-describedby', why.id); controls.append(why);
        }
      }
      const add = action(doc, '加入联合调用', e => a.addToJoint(model.id, e.currentTarget, true), `加入联合调用 ${model.name}`);
      add.setAttribute('data-focus-key', 'detail-add'); controls.append(inAppButton(doc, model, a), add,pinButton(doc,model,a),openFileButton(doc,model,a)); body.append(controls);
      if (model.launchStatus) { const target = node(doc, 'div'); renderStatus(doc,target,model.launchStatus); body.append(target); }
      const content = node(doc, 'div');
      if(model.kind === 'book')content.append(markAgentLink(node(doc,'p',`${cleanTitle(model.book?.title).text} · ${model.authorShort} · ${model.book?.edition || '版本未载明'}`,'detail-subtitle'), model));
      const chips = region(doc,'div','detail-chips');
      for(const chip of model.chips){const tag=node(doc,'span',chip.label);tag.setAttribute('title',chip.title || '');tag.setAttribute('data-tone',chip.tone);chips.append(tag);}content.append(chips);
      content.append(node(doc,'p',model.statsState==='building'?'统计中…':model.stats7===null?'暂无数据':`近 7 天 ${model.stats7} · 累计 ${model.statsTotal}`,'stats'));
      content.append(node(doc, 'p', model.summary || '无描述', 'description'));
      const full = node(doc, 'details'); full.open=!!expanded; full.append(node(doc,'summary','完整说明'),node(doc,'p',model.fullDescription.replace(/<example\b[^>]*>[\s\S]*?<\/example>/gi,'').trim(),'full-description')); full.querySelector('summary').setAttribute('data-focus-key','detail-full-summary'); content.append(full);
      for (const section of model.sections) {
        const rows = node(doc,'dl');
        for (const row of section.rows) rows.append(node(doc,'dt',row.label),markAgentLink(node(doc,'dd',row.label==='书名'?cleanTitle(row.value).text:row.value), row.label === '书名' ? model : null));
        content.append(node(doc,'h3',section.title),rows);
      }
      if(!model.sections.some(s=>s.key==='stats'))content.append(node(doc,'h3','调用统计'),node(doc,'p',model.statsState==='building'?'统计中…':'暂无数据'));
      body.append(content);
      const history = node(doc, 'section'); body.append(history);
      drawAgentHistory(doc, history, model, model.history, item => a.resume(model.id,item.cli,item.launchId), () => a.reverifyAgent(model.id));
      if (model.historyMessage) history.append(node(doc,'p',model.historyMessage,'reason'));
    }
  }
  if(ctx.state.detailOpen){if(ctx.state.view!=='history' && !r.detail.open)r.dialog.open();}else if(r.detail.open)r.dialog.close();
}
export function renderMetrics(ctx, model) {
  const { doc, refs: r } = ctx, target = r.metrics; target.replaceChildren();
  const date = formatDate(ctx.state.date);
  r['issue-date'].textContent=`CO-AGENT · 第 ${model.total} 期 · ${date.slice(0,4)} 年 ${Number(date.slice(5,7))} 月`;
  const count = model.recent7 ?? (model.statsState === 'building' ? '统计中…' : '暂无数据');
  const figures = [['近 7 天调用',count],['书籍 Agent',model.books],['人名角色',model.roles]];
  for (const [title,value] of figures) target.append(region(doc,'div','metric-tile',node(doc,'strong',String(value),typeof value === 'number'?'':'metric-unknown'),node(doc,'span',title,'metric-label')));
  if (model.scopeLimited) { const info = node(doc,'span','ⓘ','scope-info'); info.setAttribute('title',model.scopeReasons.join('\n')); info.setAttribute('tabindex','0'); info.setAttribute('aria-label',`统计范围有限：${model.scopeReasons.join('；')}`); target.querySelector('.metric-label').append(info); }
}
function historyRow(ctx, item, { detail=false }={}) {
  const { doc, actions: a } = ctx, names = item.agents.map(x=>x.name).join('、');
  const el=region(doc,'article','directory-row history-row'), at=formatDate(item.createdAt);
  const date=node(doc,'time',undefined,'history-date');date.append(node(doc,'span',at.slice(5,10),'history-md'),node(doc,'span',at.slice(0,4),'history-year'));date.setAttribute('datetime',item.createdAt);date.setAttribute('title',`${at} · 本机时区`);
  const title=action(doc,names,e=>a.selectHistory(item.type,item.id,e.currentTarget),`查看调用记录 ${names}`);fillAgentNames(doc,title,item.agents);title.className='directory-title';title.setAttribute('data-focus-key',`history-title-${item.type}-${item.id}`);
  const state=item.status?.message?.endsWith(' · 会话已结束')?item.status.message:labels[item.status?.overall]||item.status?.overall||'未确认';
  const copy=region(doc,'div','directory-copy',title,node(doc,'div',[item.inputPreview,item.cliLabel || item.cli,state,item.type==='joint'?`◈ 联合 · ${item.agents.length} 个`:'○ 单次',at.slice(11)].filter(Boolean).join(' · '),'row-subtitle'));
  if(item.status?.overall==='closed'){const badge=node(doc,'span','已关闭','history-state');badge.setAttribute('data-tone','neutral');copy.append(badge);}
  if(detail)copy.append(node(doc,'p',`模式：${item.modeLabel || item.mode || '未声明'} · 来源：${item.sourceLabel || item.source || '未声明'}${item.resumeOf?` · 恢复自 ${item.resumeOf}`:''}${item.rerunOf?` · 重跑自 ${item.rerunOf}`:''}`));
  const controls=region(doc,'div','directory-actions');
  const run=action(doc,'重新调用',()=>a.rerun(item.type,item.id),`重新调用 ${names}`);
  run.disabled=ctx.refs.historyBusy; run.setAttribute('data-focus-key',`history-rerun-${detail?'detail':'all'}-${item.id}`); controls.append(run);
  const resume=action(doc,'继续',()=>a.resumeHistory(item.type,item.id),`继续该次会话 ${names}`);
  resume.disabled=!!ctx.refs.historyBusy||!item.canResume; resume.setAttribute('data-focus-key',`history-resume-${detail?'detail':'all'}-${item.id}`);controls.append(resume);
  if(!item.canResume){const why=node(doc,'span',item.resumeReason||'此会话尚不可恢复','reason');why.id=`history-${detail?'detail':'all'}-${item.type}-${item.id}-reason`;resume.setAttribute('title',why.textContent);resume.setAttribute('aria-describedby',why.id);copy.append(why);}
  el.append(date,copy,controls);return el;
}
export function renderHistory(ctx, model) {
  const { doc, refs:r }=ctx;r.historyBusy=model.busy;
  r['history-filter'].value=model.filter;r['history-status'].textContent=model.message;
  r['history-list'].replaceChildren();
  model.items.forEach(item=>r['history-list'].append(historyRow(ctx,item)));
  if(!model.items.length)r['history-list'].append(node(doc,'p','暂无调用记录'));
  if(ctx.state.view==='history' && ctx.state.detailOpen && model.selected){fillAgentNames(doc,r['detail-title'],model.selected.agents);r['detail-body'].replaceChildren(historyRow(ctx,model.selected,{detail:true}));if(!r.detail.open)r.dialog.open();}
}
export function renderRunning(ctx, items) {
  ctx.refs['editorial-running'].hidden=!items.length;
  ctx.refs['editorial-running'].textContent=`运行中 ${items.length}`;
  updateRunningClose(ctx,items);drawRunning(ctx.doc,ctx.refs['running-list'],{items},ctx);
  ctx.refs['reverify-all'].disabled=ctx.state.reverifyBusy;
  ctx.refs['reverify-all-status'].textContent=ctx.state.reverifyMessage;
}
export function renderCoverage(ctx, model) {
  const { refs:r }=ctx;
  drawCoverage(ctx.doc,r['stats-detail'],model.stats);
  r['stats-summary'].textContent=`数据覆盖 · ${model.stats?.building?'统计中…':model.stats?.limited?'统计范围有限':'来源可读'}`;
  const registry=model.registry;
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
    const card=region(doc,'article','directory-row');
    const heading=directoryTitle(agent);
    const title=action(doc,heading.text,e=>a.openDetail(agent.id,e.currentTarget),`查看 ${agent.name} 详情`);
    title.setAttribute('title',heading.full);markAgentLink(title,agent);
    title.className='directory-title';title.setAttribute('data-focus-key',`recommend-detail-${agent.id}`);
    const copy=region(doc,'div','directory-copy',title,markAgentLink(node(doc,'div',agent.kind==='book'?`${agent.authorShort || '作者未载明'} · 由 ${agent.name} 主讲`:agent.purpose || summary(agent.description),'row-subtitle'), agent));
    card.append(node(doc,'span',String(model.results.indexOf(agent)+1).padStart(2,'0'),'directory-number'),copy);
    const check=node(doc,'input');check.type='checkbox';check.checked=agent.selected;
    check.disabled=model.busy||model.jointBusy||(!check.checked&&model.selectedIds.length>=8);
    check.setAttribute('type','checkbox');check.setAttribute('data-focus-key',`recommend-check-${agent.id}`);check.setAttribute('aria-label',`加入联合调用 ${agent.name}`);
    check.addEventListener('change',()=>a.selectRecommendationAgent(agent.id,check.checked));
    copy.append(node(doc,'p',agent.reason,'model-reason'));
    card.append(region(doc,'label','select-agent',check,node(doc,'span','加入联合调用')));
    if(!agent.platforms[model.cli.replace('inapp:', '')]?.available)copy.append(node(doc,'p',`${model.cli.replace('inapp:', '')} 不可用：${agent.platforms[model.cli.replace('inapp:', '')]?.reason||'入口不可用'}`,'reason'));
    results.append(card);
  }
  const recent=r['recent-list'];recent.replaceChildren();
  for(const item of model.recent){if(item.type==='recommend')recent.append(region(doc,'div','recent-recommend',action(doc,`推荐 · ${item.engine} · ${item.status} · ${item.createdAt}`,()=>a.selectRecommendation(item.id)),node(doc,'p',item.preview)));
    else {const target=region(doc,'article','joint-card');drawJointStatus(doc,target,item,item.verification);target.append(action(doc,'重新核验',()=>a.reverifyJoint(item.id)));recent.append(target);}}
  if(!model.recent.length)recent.append(node(doc,'p','暂无推荐与联合调用记录'));
}
const conceptActive = record => ['queued', 'running'].includes(record?.status);
const verificationLabel = state => ({ ok: '通过', violation: '违规' }[state] || '未确认');
function conceptControl(ctx, text, key, callback) {
  const button = action(ctx.doc, text, () => { if (!button.disabled) return callback(); });
  button.setAttribute('data-focus-key', `concepts-${key}`); return button;
}
function buildConcepts(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const panel = region(doc, 'section', 'editorial-concepts'); panel.id = 'concepts-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', '随机概念');
  r.conceptsTitle = node(doc, 'h2', '今日一讲'); r.conceptsTitle.setAttribute('tabindex', '-1');
  r.conceptsNext = conceptControl(ctx, '再来一个', 'next', a.nextConcept);
  r.conceptsRefresh = conceptControl(ctx, '重新读取', 'refresh', a.openConcepts);
  const header = region(doc, 'header', 'editorial-concept-heading',
    region(doc, 'div', 'editorial-concept-heading-copy', node(doc, 'p', '随机概念 · CO-AGENT', 'eyebrow'), r.conceptsTitle),
    region(doc, 'div', 'editorial-concept-actions', conceptControl(ctx, '返回 Agent', 'back', () => a.showView('catalog')), r.conceptsNext));
  r.conceptsStatus = node(doc, 'p', '', 'editorial-concept-status'); r.conceptsStatus.setAttribute('role', 'status');
  r.conceptsError = node(doc, 'p', '', 'editorial-concept-warning'); r.conceptsError.setAttribute('role', 'alert');
  r.conceptsArchive = region(doc, 'nav', 'editorial-concept-archive'); r.conceptsArchive.setAttribute('aria-label', '概念存档');
  r.conceptsReading = region(doc, 'article', 'editorial-concept-reading');
  panel.append(header, r.conceptsStatus, r.conceptsError, r.conceptsRefresh,
    region(doc, 'div', 'editorial-concept-spread', r.conceptsArchive, r.conceptsReading));
  r.conceptsPanel = panel; return panel;
}
function conceptBadge(doc) { return node(doc, 'span', '今日', 'concept-today'); }
function termTranslations(doc, term, tag = 'p') {
  const line = node(doc, tag, undefined, 'editorial-term-translations');
  for (const lang of ['en', 'fr']) {
    if (!term?.[lang]) continue;
    if (line.children.length) line.append(node(doc, 'span', ' · '));
    const word = node(doc, 'span', term[lang]); word.setAttribute('lang', lang); line.append(word);
  }
  return line.children.length ? line : null;
}
function conceptArchive(ctx, model) {
  const { doc, refs: r, actions: a } = ctx;
  const items = [...model.items];
  const todayId = model.today?.conceptId;
  if (todayId && !items.some(item => item.conceptId === todayId)) items.unshift({ ...model.today });
  items.sort((left, right) => Number(right.conceptId === todayId) - Number(left.conceptId === todayId));
  const key = JSON.stringify([items, todayId, model.selected?.conceptId, items.map(item => conceptStatus(item))]);
  if (r.conceptArchiveKey === key) return;
  r.conceptArchiveKey = key;
  r.conceptsArchive.replaceChildren(node(doc, 'h3', '往期目录', 'eyebrow'));
  items.forEach((item, index) => {
    const dateText = formatDate(item.createdAt || item.startedAt || item.day).slice(0, 10);
    const date = node(doc, 'time', dateText); if (item.createdAt || item.day) date.setAttribute('datetime', item.createdAt || item.day);
    const title = item.result?.concept || item.concept || (item.conceptId === todayId ? '今日一讲' : '待生成概念');
    const term = item.term || item.result?.term;
    const open = conceptControl(ctx, term?.zh || title, `select-${item.conceptId}`, () => a.selectConcept(item.conceptId));
    open.className = 'directory-title'; open.setAttribute('title', title);
    if (item.conceptId === model.selected?.conceptId) open.setAttribute('aria-current', 'page');
    const meta = region(doc, 'div', 'editorial-concept-index-meta', date);
    if (item.conceptId === todayId) meta.append(conceptBadge(doc));
    const copy = region(doc, 'div', 'editorial-concept-index-copy', meta, open, termTranslations(doc, term),
      term?.zh ? node(doc, 'p', title, 'editorial-term-subtitle') : null,
      markAgentLink(node(doc, 'p', [item.agent?.name, conceptStatus(item)].filter(Boolean).join(' · '), 'row-subtitle'), item.agent));
    r.conceptsArchive.append(region(doc, 'div', 'editorial-concept-index-row', node(doc, 'span', String(index + 1).padStart(2, '0'), 'directory-number'), copy));
  });
  if (!items.length) r.conceptsArchive.append(node(doc, 'p', '暂无存档，可点击「再来一个」。', 'editorial-concept-note'));
}
function conceptCheck(doc, text, state) {
  const mark = node(doc, 'p', text, 'editorial-concept-mark');
  mark.setAttribute('data-tone', state === 'ok' ? 'ok' : state === 'violation' ? 'danger' : 'warning'); return mark;
}
function conceptReading(ctx, record, todayId) {
  const { doc, refs: r, actions: a } = ctx, body = r.conceptsReading;
  const key = JSON.stringify([record, todayId]);
  if (r.conceptReadingKey === key) return;
  r.conceptReadingKey = key; r.conceptButtons = {}; r.conceptRunStatuses = [];
  body.replaceChildren();
  if (!record) { body.append(node(doc, 'p', '请选择概念或等待详情读取。', 'editorial-concept-note')); return; }
  const result = record.result, term = record.term || result?.term;
  const originalTitle = result?.concept || record.concept || '正在准备概念';
  const title = node(doc, 'h2', term?.zh || originalTitle, 'editorial-concept-title');
  const heading = region(doc, 'header', 'editorial-concept-byline');
  if (record.conceptId === todayId) heading.append(conceptBadge(doc));
  heading.append(title);
  const translations = termTranslations(doc, term);
  if (translations) heading.append(translations);
  if (term?.zh) heading.append(node(doc, 'p', originalTitle, 'editorial-term-subtitle'));
  if (!term && result?.conceptEn) heading.append(node(doc, 'p', result.conceptEn, 'row-subtitle'));
  heading.append(markAgentLink(node(doc, 'p', `《${cleanTitle(record.agent?.title || record.agent?.bookLabel).text || '书名未载明'}》 · ${record.agent?.name || '讲解者未载明'}`, 'row-subtitle'), record.agent));
  r.conceptRecordStatus = node(doc, 'p', '', 'editorial-concept-note');
  r.conceptRecordStatus.setAttribute('role', 'status'); heading.append(r.conceptRecordStatus); body.append(heading);
  if (record.error) body.append(node(doc, 'p', `失败原因：${record.error}`, 'editorial-concept-warning'));
  if (record.status === 'failed') {
    r.conceptButtons.retry = conceptControl(ctx, '重试（生成新概念）', 'retry', a.nextConcept);
    body.append(r.conceptButtons.retry);
  }
  if (result) {
    body.append(node(doc, 'p', result.oneLine, 'editorial-concept-deck'),
      region(doc, 'aside', 'editorial-concept-why', node(doc, 'p', '为什么值得一讲', 'eyebrow'), node(doc, 'p', result.whyUnknown)));
    r.conceptButtons.perspectives = conceptControl(ctx, '多视角分析', 'perspectives', () => a.openPerspectivePicker(record.conceptId));
    r.conceptButtons.continue = conceptControl(ctx, '在终端中继续', 'continue', () => a.continueInJoint(record.conceptId));
    body.append(region(doc, 'div', 'editorial-concept-actions', r.conceptButtons.perspectives, r.conceptButtons.continue));
  }
  const structure = record.verify?.skillStructure;
  const structureText = structure?.state === 'ok' ? '通过' : `${structure?.state === 'missing' ? '未通过' : '未确认'}；缺少小节 ${(structure?.missing || []).join('、') || '未知'}${structure?.titleLine === false ? '；缺少标题行' : ''}`;
  if ((record.result || record.thinkError || record.verify?.state === 'violation')) body.append(region(doc, 'div', 'editorial-concept-checks',
    conceptCheck(doc, `Agent 核验：${verificationLabel(record.verify?.state)}`, record.verify?.state),
    conceptCheck(doc, `11 节结构：${structureText}`, structure?.state)));
  if (record.poolWarning) body.append(node(doc, 'p', record.poolWarning, 'editorial-concept-warning'));
  if (record.thinkError) body.append(node(doc, 'p', `THINK 另存失败：${record.thinkError}`, 'editorial-concept-warning'));
  if (result) {
    if (result.sourceRefs?.length) body.append(node(doc, 'p', `书内出处：${result.sourceRefs.join('；')}`, 'editorial-concept-note'));
    // Keep the long reading node through polling and new perspective results.
    const markdownKey = JSON.stringify([record.conceptId, result.markdown]);
    if (r.conceptMarkdownKey !== markdownKey) {
      r.conceptMarkdownKey = markdownKey; r.conceptMarkdown = renderMarkdown(doc, result.markdown);
      r.conceptMarkdown.className += ' editorial-concept-body';
      const firstParagraph = Array.from(r.conceptMarkdown.children).find(el => el.tagName === 'P');
      if (firstParagraph) firstParagraph.className = 'editorial-dropcap';
    }
    const response = conceptResponse(ctx, record); if (response) body.append(response);
    body.append(r.conceptMarkdown);
  }
  const letters = region(doc, 'section', 'editorial-concept-letters', node(doc, 'h3', '来稿 · 多视角分析'));
  letters.setAttribute('aria-label', '多视角分析结果');
  for (const run of record.perspectives || []) {
    const status = node(doc, 'p', '', 'editorial-concept-note'); status.setAttribute('role', 'status');
    r.conceptRunStatuses.push({ run, node: status });
    const section = region(doc, 'section', 'editorial-concept-run', status);
    if (run.error) section.append(node(doc, 'p', `失败原因：${run.error}`, 'editorial-concept-warning'));
    if (run.status === 'failed') {
      const retry = conceptControl(ctx, '重试多视角分析', `retry-${run.runId}`, () => a.runPerspectives(record.conceptId, (run.agents || []).map(agent => agent.id)));
      r.conceptButtons[`run-${run.runId}`] = retry; section.append(retry);
    }
    const parallel = typeof run.verify?.parallel === 'object' ? run.verify.parallel?.state : run.verify?.parallel;
    const parallelOk = parallel === true || parallel === 'ok';
    const violations = run.verify?.violations || [];
    section.append(conceptCheck(doc, `多视角核验：${verificationLabel(run.verify?.state)}；并行：${parallelOk ? '通过' : '未通过或未确认'}${violations.length ? `；${JSON.stringify(violations)}` : ''}`,
      violations.length || run.verify?.state === 'violation' ? 'violation' : run.verify?.state === 'ok' && parallelOk ? 'ok' : 'unconfirmed'));
    const grid = region(doc, 'div', 'editorial-letters-grid');
    for (const result of run.results || []) {
      const member = run.agents?.find(agent => agent.id === result.agentId);
      grid.append(region(doc, 'article', 'editorial-letter', markAgentLink(node(doc, 'h4', result.name || member?.name || result.agentId), {id:result.agentId}),
        markAgentLink(node(doc, 'p', member?.bookLabel || member?.purpose || '', 'row-subtitle'), member), renderMarkdown(doc, result.analysis)));
    }
    section.append(grid); letters.append(section);
  }
  if (!record.perspectives?.length) letters.append(node(doc, 'p', '尚无来稿，可选择其他 Agent 展开多视角分析。', 'editorial-concept-note'));
  body.append(letters);
}
export function renderConcepts(ctx, model) {
  const { refs: r, doc } = ctx, panel = r.conceptsPanel, visible = ctx.state.view === 'concepts';
  updateConceptResponseNote(ctx, model, r.conceptsEntry);
  const entering = visible && panel.hidden, restoreFocus = !visible && !panel.hidden && panel.contains(doc.activeElement);
  panel.hidden = !visible; r.spread.hidden = ['concepts', 'stats'].includes(ctx.state.view);
  ctx.root.parentElement?.setAttribute('data-concepts-open', String(visible));
  if (visible) r.conceptsEntry.setAttribute('aria-current', 'page'); else r.conceptsEntry.removeAttribute('aria-current');
  if (restoreFocus) r.conceptsEntry.focus();
  if (!visible) return;
  model ||= { items: [], today: undefined, selected: null, running: null, busy: false, error: '' };
  renderConceptThread(ctx, model, panel);
  if (entering) r.conceptsTitle.focus();
  const generationActive = !!model.running || conceptActive(model.selected);
  r.conceptsNext.disabled = model.busy || generationActive;
  r.conceptsStatus.textContent = [model.today === undefined ? '今日讲解载入中…' : !model.today?.conceptId ? '今日讲解尚未生成' : '',
    model.busy ? '正在提交…' : '', model.running ? `概念生成${conceptStatus({ status: 'running', ...model.running })}` : ''].filter(Boolean).join(' · ');
  r.conceptsStatus.hidden = !r.conceptsStatus.textContent;
  r.conceptsError.textContent = model.error || ''; r.conceptsError.hidden = !model.error;
  r.conceptsRefresh.hidden = !model.error; r.conceptsRefresh.disabled = model.busy;
  conceptArchive(ctx, model); conceptReading(ctx, model.selected, model.today?.conceptId);
  if (!model.selected) return;
  r.conceptRecordStatus.textContent = conceptStatus(model.selected);
  const perspectivesActive = (model.selected.perspectives || []).some(conceptActive);
  for (const [key, button] of Object.entries(r.conceptButtons)) button.disabled = !!model.busy ||
    (key === 'retry' ? generationActive : key === 'continue' ? false : model.selected.status !== 'done' || perspectivesActive);
  for (const item of r.conceptRunStatuses) item.node.textContent = `来稿 · ${conceptStatus(item.run)}`;
}
function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const button = action;
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

// The data column shares chart geometry and state, while owning its magazine composition.
const statsRanges = { '7d': '近 7 天', '30d': '近 30 天', all: '累计' };
function statsControl(ctx, text, key, callback) {
  const button = action(ctx.doc, text, callback);
  button.setAttribute('data-focus-key', `stats-${key}`); return button;
}
function buildStats(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  r.statsTitle = node(doc, 'h2', '数据专栏');
  r.statsTitle.id = 'editorial-stats-title'; r.statsTitle.setAttribute('tabindex', '-1');
  const controls = region(doc, 'div', 'editorial-stats-controls',
    statsControl(ctx, '返回目录', 'back', () => a.showView('catalog')),
    statsControl(ctx, '重新统计', 'refresh', () => a.refreshStats()));
  const heading = region(doc, 'header', 'editorial-stats-heading',
    region(doc, 'div', '', node(doc, 'p', '调用与阅读', 'eyebrow'), r.statsTitle), controls);
  const ranges = region(doc, 'div', 'editorial-stats-controls');
  ranges.setAttribute('role', 'group'); ranges.setAttribute('aria-label', '统计时间范围');
  r.statsRanges = {};
  for (const [range, label] of Object.entries(statsRanges)) {
    const button = statsControl(ctx, label, range, () => a.setStatsRange(range));
    r.statsRanges[range] = button; ranges.append(button);
  }
  r.statsContent = region(doc, 'div', 'editorial-stats-content');
  r.statsPanel = region(doc, 'section', 'editorial-stats', heading, ranges, r.statsContent);
  r.statsPanel.id = 'stats-panel'; r.statsPanel.hidden = true;
  r.statsPanel.setAttribute('aria-labelledby', r.statsTitle.id);
  return r.statsPanel;
}
function statsParts(item) {
  return [{ key: 'Claude', value: item.claude, colorClass: 'editorial-chart-claude' },
    { key: 'Codex', value: item.codex, colorClass: 'editorial-chart-codex' }];
}
function statsFigure(doc, title, caption, chart) {
  return region(doc, 'figure', 'editorial-stats-figure', node(doc, 'h3', title), chart, node(doc, 'figcaption', caption));
}
function statsDonut(ctx, segments, label, onSelect, selected) {
  const chart = donut({ segments, centerLabel: label, onSelect }, ctx.doc);
  // The selectable text legend identifies even zero-valued categories; color never stands alone.
  const legend = chart.querySelector('.chart-legend');
  for (const [i, button] of Array.from(legend.children).entries()) {
    button.className = segments[i].colorClass;
    button.setAttribute('aria-pressed', String(selected(segments[i].key)));
  }
  for (const slice of chart.querySelectorAll('[data-segment]')) slice.setAttribute('aria-pressed', String(selected(slice.getAttribute('data-segment'))));
  return chart;
}
function statsRanking(ctx, model) {
  const { doc, actions: a } = ctx;
  const filters = region(doc, 'div', 'editorial-stats-controls');
  filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '排行榜筛选');
  for (const [filter, label] of [['all', '全部'], ['role', '功能性'], ['book', '书籍']]) {
    const button = statsControl(ctx, label, `filter-${filter}`, () => a.setStatsFilter(filter));
    button.setAttribute('aria-pressed', String(model.filter === filter)); filters.append(button);
  }
  if (model.categoryFilter) filters.append(statsControl(ctx, `${model.categoryFilter} · 取消筛选`, 'category', () => a.setStatsCategory(model.categoryFilter)));
  const section = region(doc, 'section', 'editorial-stats-ranking',
    region(doc, 'header', 'editorial-stats-ranking-heading', node(doc, 'h3', 'Agent 调用排行'), filters));
  section.append(node(doc, 'p', `${model.showAll ? '全部' : '前 20 名'} · ${statsRanges[model.range]} · 按调用次数降序，点击查看详情。`, 'stats-note'));
  const legend = region(doc, 'div', 'editorial-stats-source-legend',
    node(doc, 'span', 'Claude', 'editorial-chart-claude'), node(doc, 'span', 'Codex', 'editorial-chart-codex'));
  section.append(legend);
  const positive = model.agents.filter(agent => agent.value > 0), zeros = model.agents.filter(agent => agent.value === 0);
  function ranking(list, offset = 0) {
    const chart = barList({ rows: list.map(agent => ({ id: agent.id, label: agent.name,
      sublabel: agent.bookLabel || agent.purpose || '', value: agent.value, parts: statsParts(agent) })),
    onSelect: id => a.openDetail(id) }, doc);
    // Number after the engine has sorted equal-valued names, without changing their sort key.
    Array.from(chart.querySelectorAll('.chart-bar-row')).forEach((row, index) => {
      const number = node(doc, 'span', String(offset + index + 1).padStart(2, '0'), 'editorial-stats-rank');
      number.setAttribute('aria-hidden', 'true'); row.prepend(number);
    });
    return chart;
  }
  if (positive.length) section.append(ranking(positive));
  else section.append(node(doc, 'p', model.totals.calls ? '当前筛选下没有调用。可切换分类查看其他 Agent。' : '该时间范围内没有调用', 'editorial-stats-empty'));
  section.append(node(doc, 'p', `未调用的 Agent：${model.zeroCount} 个`, 'stats-zero'));
  if (zeros.length) section.append(ranking(zeros, positive.length));
  if (model.agentCount > positive.length || model.showAll) {
    const expand = statsControl(ctx, model.showAll ? '收起排行榜' : `展开全部（${model.agentCount}）`, 'expand', () => a.toggleStatsShowAll());
    expand.className = 'editorial-stats-expand'; expand.setAttribute('aria-expanded', String(model.showAll)); section.append(expand);
  }
  return section;
}
export function renderStats(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, panel = r.statsPanel, visible = ctx.state.view === 'stats';
  const entering = visible && panel.hidden, restoreFocus = !visible && !panel.hidden && panel.contains(doc.activeElement);
  panel.hidden = !visible; r.spread.hidden = ['concepts', 'stats'].includes(ctx.state.view);
  ctx.root.parentElement?.setAttribute('data-stats-open', String(visible));
  if (visible) r.statsEntry.setAttribute('aria-current', 'page'); else r.statsEntry.removeAttribute('aria-current');
  if (restoreFocus) r.statsEntry.focus();
  if (!visible || !model) return;
  if (entering) r.statsTitle.focus();
  // Polls for other panels must not replace a focused SVG column or reset its tooltip.
  const signature = JSON.stringify([model, ctx.state.categories]);
  if (signature === r.statsSignature) return;
  r.statsSignature = signature;
  for (const [range, button] of Object.entries(r.statsRanges)) button.setAttribute('aria-pressed', String(range === model.range));
  const content = r.statsContent; content.replaceChildren();
  if (model.limited) {
    const notice = region(doc, 'aside', 'stats-limited', node(doc, 'strong', '数据覆盖有限'),
      node(doc, 'p', model.limitedReasons.length ? model.limitedReasons.join('；') : '部分调用记录不可用，以下仅反映可读取的数据。'));
    notice.setAttribute('role', 'status'); content.append(notice);
  }
  if (model.status !== 'ready') {
    const notice = node(doc, 'p', model.status === 'loading' ? '统计正在建立…' : '调用统计暂不可用，请重新统计。', 'editorial-stats-empty');
    notice.setAttribute('role', 'status'); content.append(notice); return;
  }
  const intro = region(doc, 'div', 'editorial-stats-intro',
    region(doc, 'p', 'editorial-stats-lead', node(doc, 'strong', String(model.totals.calls), 'editorial-stats-total'),
      node(doc, 'span', `${statsRanges[model.range]}调用 · ${model.totals.agentsUsed} 位 Agent`)),
    region(doc, 'div', 'editorial-stats-byline', node(doc, 'p', `Claude ${model.totals.claude} · Codex ${model.totals.codex}`),
      node(doc, 'p', `通过 ${model.totals.ok} · 失败 ${model.totals.failed} · 未知 ${model.totals.unknown}`, 'stats-note')));
  content.append(intro);
  // Bind category colors to registry order, never to the changing value ranking.
  const categoryKeys = [...new Set([...(ctx.state.categories || []), ...model.byCategory.map(c => c.key).sort()])];
  const kind = statsDonut(ctx, model.byKind.map(s => ({ ...s, colorClass: `editorial-chart-${s.key}` })), '全部调用',
    key => a.setStatsFilter(key), key => model.filter === key);
  const categories = statsDonut(ctx, model.byCategory.map(s => ({ ...s, colorClass: `editorial-chart-category-${categoryKeys.indexOf(s.key) % 11}` })), '书籍调用',
    key => a.setStatsCategory(key), key => model.categoryFilter === key);
  content.append(region(doc, 'div', 'editorial-stats-donuts',
    statsFigure(doc, '功能性与书籍', `图 01 · ${statsRanges[model.range]}全部调用的构成。选择扇区或图例筛选下方排行。`, kind),
    statsFigure(doc, '书籍分类', `图 02 · ${statsRanges[model.range]}书籍调用的分类分布。再次选择同一分类可取消筛选。`, categories)));
  const daily = model.daily;
  content.append(statsFigure(doc, '每日调用趋势',
    `图 03 · 固定展示近 30 天（本机时区），不随范围或排行筛选改变。${daily.length ? `${daily[0].day} — ${daily.at(-1).day}` : ''}`,
    columns({ points: daily.map(day => ({ label: day.day, value: day.calls, parts: statsParts(day) })), height: 160 }, doc)));
  content.append(statsRanking(ctx, model), node(doc, 'p', `更新时间（本机时区）：${model.generatedAt ? formatDate(model.generatedAt) : '未提供'} · 调用次数不包含单独记录的启动次数。`, 'stats-note'));
}

function seminarControl(ctx, text, key, callback) {
  const button = action(ctx.doc, text, event => { if (!button.disabled) return callback(event); });
  button.id = `seminars-${key}`; button.setAttribute('data-focus-key', button.id); return button;
}
