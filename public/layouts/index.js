/**
 * P1 layout boundary (all four modules implement the same named exports).
 * render(ctx) returns an owned root node. renderCategories(ctx, CategoryView[]),
 * renderCatalog(ctx, CatalogView), renderDetail(ctx, DetailView|null),
 * renderMetrics(ctx, MetricsView), renderHistory(ctx, HistoryModel),
 * renderRunning(ctx, RunningView[]), renderCoverage(ctx, CoverageView), and
 * renderRecommend(ctx, RecommendView), renderConcepts(ctx, ConceptsView),
 * renderStats(ctx, StatsView) update
 * that root. jointBuilderSkin is a CSS class on the shared #joint-builder and
 * #perspective-picker and #seminar-picker dialogs. No renderer fetches or owns app state.
 * ctx = {doc, root, refs, state, actions}. refs is a fresh module-local DOM cache;
 * refs.search and refs.recommendInput are optional focus targets for shortcuts;
 * refs.dispose() is an optional module cleanup hook (e.g. close its dialogs).
 * initialCategory is optional module metadata used ONLY at app startup (default role).
 * state is a detached read-only snapshot: {view,category,query,sort,selectedId,
 * detailOpen,jointSelectedIds,allAgents,categories,date,reverifyBusy,reverifyMessage,
 * closeRunningBusy}. closeRunningBusy locks all close buttons during confirmation,
 * POST and refresh; renderRunning retains its RunningView[] argument.
 * render() may initialize refs; every update receives the latest ctx.state.
 * For existing helper-level regression tests, threepane also exports createCard,
 * fillDetails, renderStatus, drawCoverage, drawRunning, drawAgentHistory,
 * drawJointStatus and renderNavigation. Keep these local helpers when replacing its UI.
 * All sections are dispatched on an update, including hidden sections. Modules
 * decide placement/visibility. Preserve editable controls when refreshing content.
 * No shared-file edits are required to change markup, dialogs or navigation.
 * CSP is style-src 'self': never use style attributes, setAttribute('style', ...)
 * or cssText. For dynamic styles import setStyle from '../display.js' and call
 * setStyle(el, {'--avatar': color, backgroundColor: color, width: '37%'}).
 * It writes CSSOM declarations; null/undefined removes a declaration. Direct
 * el.style.setProperty(...) / el.style.width = ... and stable CSS classes also work.
 *
 * Actions (all return void or a Promise; never call APIs from a layout):
 * launch(agentId,cli), resume(agentId,cli?,launchId?), openDetail(agentId,trigger?),
 * openAgentFile(agentId,event?) opens registry book/definition via the shared handler.
 * closeDetail(), selectCategory(key), search(text), sort(order), showView(view),
 * openJoint(prefillIds?,trigger?) [undefined=keep selection, []=empty],
 * addToJoint(agentId,trigger?,show=true), removeFromJoint(agentId), recommend(),
 * setRecommendInput(text), setRecommendEngine(cli), setJointCli(cli),
 * selectRecommendationAgent(id,checked), selectAllRecommendations(checked),
 * launchRecommendedJoint(), selectRecommendation(id), reverifyJoint(id),
 * rerun(type,id), resumeHistory(type,id), selectHistory(type,id,trigger?),
 * setHistoryFilter('all'|'launch'|'joint'), refreshHistory(), openSettings(trigger?),
 * refresh(), refreshStats(), refreshRunning(), reverifyAgent(id), reverifyAll().
 * closeRunning(type,id,trigger?), closeAllRunning(trigger?) confirm with cancel
 * focused, freeze the displayed record IDs, and POST only {items:[{type,id}]}.
 * They report per-item outcomes in a status toast and reload running + history.
 * Lists over the API limit use sequential batches of at most 50 after one
 * confirmation; failures stop later batches and never retry uncertain requests.
 * openConcepts(), selectConcept(id), nextConcept(), openPerspectivePicker(id),
 * runPerspectives(id,agentIds), continueInJoint(id,agentIds?). continueInJoint
 * only opens the manual builder: ids default to the last perspective's members
 * (or []), input contains the concept/source/explanation, cli defaults to codex.
 * view: catalog|recommend|history|running|coverage|concepts|stats|groups|conceptMap|chat; category: pinned|role|book|all|full name.
 * v0.14 调用组: renderGroups(ctx, GroupsView) is optional; layouts without it use shared renderDefaultGroups
 * (a full page in #layout-root). GroupsView = {loaded,loading,busy,error,selectedId,selected,groups:[{id,name,cli,
 * agentIds,members:[{id,name,missing,avatarColor,avatarLetter}],memberNames,presets:[{id,title,text}],runCount,lastRunAt}]}.
 * Actions: openGroups(), selectGroup(id), newGroup(trigger?), askGroup(id,trigger?,prefillText?), editGroup(id,trigger?),
 * deleteGroup(id,trigger?) (destructive confirm), refreshGroups(). The shared #group-ask dialog carries jointBuilderSkin.
 * v0.29 常用: togglePin(agentId,trigger?) persists /api/pins. AgentView.pinned marks pinned agents, state.pinnedIds keeps
 * pin order, and categories start with {key:'pinned',label:'常用'} while any pin exists. Detail actions use shared pinButton.
 *
 * CategoryView: {key,label,fullLabel,count,selected}; no category call statistics.
 * Full category names retain the source full-width ／ with no surrounding spaces;
 * label/categoryShort abbreviate segments without changing that separator.
 * AgentView: raw registry fields plus {id,kind,name,purpose,bookLabel,cleanTitle,
 * spineTitle,authorShort,summary,categoryShort,avatarColor,platforms:{claude,codex},
 * writable,sourcesOk:boolean|null,sourcesReason,sync,stats7:number|null,
 * statsTotal:number|null,statsState,statsDetail,canResume,resumeReason,
 * resumeByCli:{claude,codex},launchStatus,launchBusy}. Platform = {available,reason,...}.
 * purpose is the registry's roles.json purposes[original role-map name], or null
 * for books/missing metadata. Never overwrite that field or use a per-layout map.
 * Short-purpose UI text uses purpose || summary(description) as a display-only fallback.
 * cleanTitle keeps the first 《...》 title only; spineTitle also removes edition
 * parentheses and colon subtitles. bookLabel/spineTitle retain '等 N 本' for sets.
 * CatalogView: {title,count,agents,selectedId,query,sort,categories}.
 * DetailView retains bookFiles:[{index,label,path,ext,exists}] and
 * definitionFile:{path,exists}|null from the registry. openAgentFile sends only
 * agentId/target/index/reveal; layouts never submit paths. All displayed Agent
 * names and book titles carry data-agent-link=agentId (or inherit that marker).
 * The app captures Ctrl/Meta+click and Ctrl/Meta+Enter, appends hover hints and
 * provides focus stops for noninteractive names. Plain activation is unchanged.
 * DetailView extends AgentView with {chips:[{label,tone,title}],fullDescription,
 * meta:{category,claudeModel,claudeEffort,terminalDisplay,terminalWindowMode,
 * terminalReason},sections:[{key,title,rows:[{label,value}]}],history:{items,
 * unavailable},historyMessage}. Missing terminal config is null with an explicit
 * reason: the accepted /api/settings response does not expose terminal settings.
 * A module may group/reorder/fold these source fields freely; never infer facts.
 * MetricsView: {recent7,recentByKind:{role,book},total,roles,books,sync:{ok,total},
 * scopeLimited,scopeReasons,statsState,top:[{id,name,count}]} (unknown counts=null).
 * HistoryView: {type,id,createdAt,cli,agents,source,inputPreview,status,canResume,
 * resumeReason,mode,resumeOf,rerunOf,sourceLabel,modeLabel,cliLabel,statusTone};
 * status is the unchanged backend object. Labels: launch=单次, recommend=AI 推荐,
 * manual=手动; agent=直接, relay=转调, joint=联合; claude=Claude, codex=Codex.
 * Unknown labels retain raw values (missing=未声明). statusTone: ready/resumed/done/
 * historical/ok=ok, failed=fail, running=running, closed=neutral (已关闭),
 * all unknown/unconfirmed=pending. closed does not change canResume.
 * An ok tone means successful verification for that state, not task completion.
 * HistoryModel: {items,all,recent,filter,selectedId,selected,busy,message};
 * selectedId is 'type:id', recent is latest 5. All items are HistoryViews.
 * RunningView keeps all /api/running item fields including status and whitelist.
 * Single launches lacking agentId are resolved against unique registry names;
 * ambiguous or removed names retain agentId:null and have no guessed link.
 * CoverageView: {registry,stats,loading,statsLoading}; preserves full evidence.
 * RecommendView: {input,engine,cli,busy,jointBusy,selectedIds,settings,
 * recommendation,results:[AgentView & {reason,selected}],recent}. recommendation
 * retains status/model/effort/audit/rejected/note/error/recommendId; recent keeps
 * full records plus verification (parallel/whitelist/calls/evidence).
 * ConceptsView: {today,items,selected,running,busy,error,threadOpen,threadItems,threadLoading,threadError}. today is the API's
 * {day,conceptId,status} or null; items retain the API ConceptSummary fields
 * unchanged (summary fields are not further specified by v0.8 section 5).
 * selected is null while selecting, otherwise the COMPLETE /api/concepts/:id
 * record: {version,conceptId,kind,day,createdAt,startedAt,finishedAt,status,error,
 * attempt,agent:{id,name,codexName,title,author,bookLabel},cli,model,effort,
 * excludedConcepts,result:{concept,conceptEn,term?:{zh,en,fr},oneLine,whyUnknown,sourceRefs,markdown}|null,
 * verify:{state,session,children,skillStructure:{state,missing,titleLine}},
 * thinkFile,thinkError,perspectives:[{runId,createdAt,startedAt,finishedAt,status,
 * error,agents,results:[{agentId,name,analysis}],verify:{state,parallel,violations}}]}.
 * running is the API generation {conceptId,kind,startedAt} or null. busy means
 * a submission/confirmation is pending, not an entire background generation.
 * error is a user-readable request/validation error. Never infer verification
 * from status=done. Render Markdown with renderMarkdown; conceptStatus provides
 * elapsed text with an honest unknown-time fallback. Polling is owned by concepts.js
 * (5s while returned/observed work is active, otherwise 60s), even off this view.
 * Selection/polling survive layout changes. renderDefaultConcepts in shared.js is
 * the temporary A2 composition; Stage B replaces only each module's renderer.
 * v0.37: respondsTo is a frozen daily target (including oneLine); result.response is
 * {stance,text}|null and record.responseError explains omission. Thread items are
 * one daily record per day, newest first, including failures; text is capped at 80
 * code points. toggleConceptThread(), refreshConceptThread(), openConceptResponse(id)
 * own requests. Source navigation preserves the selected lecture on missing targets.
 * F38 ConceptView is each ConceptsView.items entry / selected record, retaining
 * the complete API data and adding term = result.term || term || null. No text is
 * translated client-side; concept, conceptEn, Markdown and French accents survive.
 * v0.40: SeminarView, ConsultsView and CouncilsView are ChatView.seminars/.consults/.councils; the shared chat
 * page (chat-page.js, rooms-page.js) renders them as rooms, with ChatView.room naming the shown room.
 * SeminarView: {items,selected,running,busy,error,terms,input}. items retain all
 * SeminarSummary fields; selected is the complete record or null while selecting:
 * {version,seminarId,parentId,input,mode:'auto'|'explicit',requestedAgents,status,
 * error,createdAt,startedAt,finishedAt,model,effort,result,verify,thinkFile,thinkError}.
 * result: {terms:[{zh,en,fr}],selected:[{agent,reason,id,name,bookLabel,avatarColor}],
 * perAgent:[{agent,id?,name?,bookLabel?,avatarColor?,analysis,coverage}],
 * commonAnswer:{summary,points:[{text,support,strength,strengthCorrected?}]},
 * divergences:[{topic,positions:[{agent,view}]}],actions:[{text,basis}]}.
 * Every record/summary additionally exposes terms = result.terms || terms || [].
 * SeminarView.terms mirrors the selected terms. All raw F38/result/verify fields
 * remain intact; never infer successful verification from status=done.
 * running is the unchanged API descriptor or null. busy covers POST/confirmation;
 * input is the unsent draft, retained through polling and layout changes.
 * Polling stays active off-view: 5s with observed work, otherwise 60s; owned by
 * seminars.js. Optional stage/progress.stage evidence maps selecting/analyzing/
 * synthesizing to labels; absent evidence is explicitly unknown, not guessed.
 * Actions: openSeminars(), startSeminar(input), selectSeminar(id),
 * openSeminarAddPicker(id), rerunSeminar(id,agentIds), continueSeminarInJoint(id),
 * setSeminarInput(text). Explicit lists require 3–8 unique available Codex book
 * Agents and the existing writable/missing-source confirmations. Continuation
 * only prefills a manual Codex joint builder with participants and the question.
 * StatsView: {range:'7d'|'30d'|'all',filter:'all'|'role'|'book',showAll,
 * totals:{calls,claude,codex,ok,failed,unknown,agentsUsed},byKind:[{key,label,value}],
 * byCategory:[{key,label,value}],agents:[{id,name,kind,category,bookLabel|purpose,
 * value,claude,codex,ok,failed,unknown,lastAt}],zeroCount,daily,limited,
 * limitedReasons,generatedAt,status:'loading'|'ready'|'unavailable',agentCount,
 * categoryFilter:string|null}. Counts are null while loading/unavailable, never
 * invented zeros. byCategory includes every registry category, sorted descending.
 * agents is the visible ranking: top 20 positive rows, or all filtered rows when
 * expanded (including zero rows last); ties use name then id. agentCount/zeroCount
 * refer to the filtered population. byKind, byCategory and totals use the selected
 * window independently of the ranking filters. daily retains the API's full
 * 30-day Asia/Shanghai sequence, independent of window and filters.
 * Actions: openStats(), setStatsRange(range), setStatsFilter(filter),
 * setStatsCategory(category), toggleStatsShowAll(). Category selects book+category;
 * selecting it again clears category and resets filter to all. Changing a range
 * or filter collapses the ranking. openDetail handles row selection as before.
 * Model choices survive layout changes. renderDefaultStats is the A2 stub only.
 * All UI strings are literal text, never HTML. Date helper uses Asia/Shanghai.
 */
import * as threepane from './threepane.js';
import * as bento from './bento.js';
import * as editorial from './editorial.js';
import * as shelf from './shelf.js';
import { renderDefaultGroups, renderDefaultConceptMap } from './shared.js';
import { renderDefaultChat } from '../chat-page.js';

/** CouncilsView: {items, selected, busy, error, draft, report, books}.
 * selected contains memory and complete session records; list items omit them.
 * draft is null or {councilId,name,goal,memberIds}. The controller owns drafts,
 * permission confirmations, CRUD, undo and off-view polling (5s active / 60s idle).
 */

/** ConsultsView: {items, selected, running, busy, error, books, draft}.
 * draft: {situation, options:string[], explicit, lenses:[{lens,agentId}], parentId}.
 * selected retains the full consult record and enriched result; items omit catalog and analysis.
 * Actions: openConsults(), startConsult(), selectConsult(id), deleteConsult(id,trigger),
 * rerunConsult(id), setConsultDraft(patch). Drafts live in the controller across views/layouts.
 */

export const layouts = { threepane, bento, editorial, shelf };
const sections = { categories: 'renderCategories', catalog: 'renderCatalog', detail: 'renderDetail',
  metrics: 'renderMetrics', history: 'renderHistory', running: 'renderRunning', coverage: 'renderCoverage', recommend: 'renderRecommend', concepts: 'renderConcepts', stats: 'renderStats', groups: 'renderGroups', conceptMap: 'renderConceptMap', chat: 'renderChat' };
// v0.14: sections a layout does not implement fall back to the shared renderer.
const defaults = { renderGroups: renderDefaultGroups, renderConceptMap: renderDefaultConceptMap, renderChat: renderDefaultChat };
export function mountLayouts(doc, actions, { modules = layouts } = {}) {
  const root = doc.getElementById('layout-root');
  let current, ctx, models;
  function update(value) {
    models = structuredClone(value); value = models; if (!ctx) return;
    ctx.state = value.state;
    ctx.root.hidden = false;
    const focused = doc.activeElement, key = focused?.getAttribute?.('data-focus-key');
    for (const [name, method] of Object.entries(sections)) (modules[current][method] || defaults[method])?.(ctx, value[name]);
    if (['conceptMap', 'chat'].includes(value.state.view)) ctx.root.hidden = true;
    if (key && focused.isConnected === false && (doc.activeElement === focused || doc.activeElement === doc.body || doc.activeElement?.isConnected === false)) Array.from(doc.querySelectorAll('[data-focus-key]')).find(n => n.getAttribute('data-focus-key') === key && !n.closest('[hidden]'))?.focus();
  }
  function set(id) {
    current = Object.hasOwn(modules, id) ? id : 'threepane';
    ctx?.refs?.dispose?.();
    ctx = { doc, root: null, refs: {}, actions, state: models?.state || {view:'catalog',category:'role',query:'',sort:'default',selectedId:null,detailOpen:false,jointSelectedIds:[],allAgents:[],categories:[],date:new Date().toISOString(),reverifyBusy:false,reverifyMessage:''} };
    root.replaceChildren();
    ctx.root = modules[current].render(ctx); root.append(ctx.root);
    doc.documentElement.setAttribute('data-ui', current);
    const builder = doc.getElementById('joint-builder'), picker = doc.getElementById('perspective-picker');
    if (builder) builder.className = `builder-dialog ${modules[current].jointBuilderSkin}`;
    if (picker) picker.className = `builder-dialog perspective-dialog ${modules[current].jointBuilderSkin}`;
    const groupAsk = doc.getElementById('group-ask');
    if (groupAsk) groupAsk.className = `builder-dialog group-ask-dialog ${modules[current].jointBuilderSkin}`;
    const seminarPicker=doc.getElementById('seminar-picker');
    if (seminarPicker) seminarPicker.className = `builder-dialog perspective-dialog seminar-dialog ${modules[current].jointBuilderSkin}`;
    if (models) update(models);
  }
  set(doc.documentElement.getAttribute('data-ui'));
  return { set, update, get current() { return current; }, get initialCategory() { return modules[current].initialCategory; }, get context() { return ctx; } };
}
