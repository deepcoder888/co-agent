import { createWorkflows } from './workflows.js';
import { createConfirmation, createStatusToast } from './accessibility.js';
import { mountSettings } from './settings.js';
import { mountBasicConfig } from './basic-config.js';
import { mountAgentManager } from './agent-manager.js';
import { mountJointBuilder, createCallHistory, mountPerspectivePicker, confirmMembers } from './calls.js';
import { createConcepts } from './concepts.js';
import { createSeminars } from './seminars.js';
import { createConsults } from './consults.js';
import { createCouncils } from './councils.js';
import { createConceptMap } from './conceptMap.js';
import { mountAgentLinks } from './agent-links.js';
import { createStatsView } from './stats-view.js';
import { mountLayouts, layouts } from './layouts/index.js';
import { createGroups, mountGroupAsk } from './groups.js';
import { mountCandidates } from './candidates.js';
import { mountMotion } from './motion.js';
import { createChats, mountChatStart } from './chats.js';
import { createFollowups } from './followups.js';
import { mountBookReader } from './book-reader.js';
import { seminarParticipants } from './seminars.js';
import { matchesSearch, permissionText, accessLabel, syncLabel, sortAgents, statsReadable, summary, cleanTitle, bookLabel, spineTitle, authorShort, categoryShort, avatarColor, formatDate, runningName } from './display.js';
export { excerpt, avatarLetter, formatDate, sortAgents, permissionText, matchesSearch } from './display.js';
// Historical helper imports stay usable; live UI rendering is dispatched through layouts/index.
export { createCard, fillDetails, renderStatus, drawCoverage as renderCoverage, drawRunning as renderRunning,
  drawAgentHistory as renderHistory, renderNavigation } from './layouts/threepane.js';
export function pollFinished(status) {
  return ['failed','unconfirmed','resumed','closed'].includes(status.overall) || (status.overall === 'ready' && status.agent?.state === 'confirmed');
}
const historyKey = item => `${item.type}:${item.id}`;
// F38 adds a display alias without changing the original result or legacy text.
const conceptView = record => record ? {...record,term:record.result?.term ?? record.term ?? null} : null;
const conceptsView = model => ({...model,items:model.items.map(conceptView),selected:conceptView(model.selected)});
const reverifySummary = s => `已核验 ${s.checked} 条：找到 ${s.found} 条，未找到 ${s.notFound} 条`;
export function toAgentView(agent, { stats, history = [], active } = {}) {
  const readable = !stats?.building && statsReadable(stats), counts = readable ? stats.perAgent[agent.id] : null;
  const resumable = history.filter(h => h.type === 'launch' && h.agents?.some(a=>a.id===agent.id) && h.canResume);
  const resumeByCli = Object.fromEntries(['claude','codex'].map(cli => {
    const record=resumable.find(h=>h.cli===cli);
    return [cli,{canResume:!!record,launchId:record?.id||null,reason:record?'':'暂无可恢复的已核验会话'}];
  }));
  return { ...agent, purpose:agent.kind==='role' ? agent.purpose??null : null, bookLabel:bookLabel(agent), cleanTitle:cleanTitle(agent.book?.title).text,
    spineTitle:spineTitle(agent),authorShort:authorShort(agent),summary:summary(agent.description),categoryShort:categoryShort(agent.primary),avatarColor:avatarColor(agent.id),
    writable:!!agent.writable,sourcesOk:agent.sources?.checked ? !agent.sources.missing.length : null,
    sourcesReason:agent.sources?.checked ? agent.sources.missing.length ? `原书路径失效 ${agent.sources.missing.length} 处` : '' : '原书路径未检查',
    sync:agent.sync||{state:'未检查',detail:''},stats7:counts?.last7d?.calls??null,statsTotal:counts?.total?.calls??null,
    statsState:!stats||stats.building?'building':readable?'ready':'unavailable',statsDetail:counts||null,
    canResume:resumable.length>0,resumeReason:resumable.length?'':'暂无可恢复的已核验会话',resumeByCli,
    launchStatus:active?.status||null,launchBusy:!!active?.busy };
}
export function toDetailView(agent, history, settings = {}, message = '') {
  if(!agent)return null;
  const terminal=settings.terminal;
  const sections=[{key:'source',title:'来源与书目',rows:[{label:'Codex 源文件',value:agent.sourceFile||'未载明'},
    {label:'Claude 入口文件',value:agent.platforms.claude.file||'未载明'},...(agent.book?['title','author','edition'].map((key,i)=>({label:['书名','作者','版本'][i],value:agent.book[key]||'未载明'})):[])]},
    {key:'permissions',title:'权限与模型',rows:[{label:'声明',value:permissionText(agent)}]}];
  if(agent.sources)sections.push({key:'sources',title:'原书路径',rows:[{label:'检查',value:`已检查：${agent.sources.checked?'是':'否'} · 路径 ${agent.sources.total} 条`},
    ...agent.sources.missing.map(value=>({label:'失效',value})),...(agent.sources.missing.length?[{label:'怎么修复',value:'书的路径写在这个 Agent 的定义文件里（即 Codex 源文件和 Claude 入口文件）。请把书放回列出的路径，或用文本编辑器打开定义文件，把路径改成书现在的位置，然后到 设置 → 目录 点「刷新目录」。'}]:[])]});
  sections.push({key:'sync',title:'双版本同步',rows:[{label:'状态',value:agent.sync.detail&&agent.sync.detail!==agent.sync.state?`${syncLabel(agent.sync)}：${agent.sync.detail}`:syncLabel(agent.sync)},
    ...(agent.sync.state!=='同步'?[
      ...(agent.sync.descriptionDiff?[{label:'Codex 描述',value:agent.sync.descriptionDiff.codex??'（无此行）'},
        {label:'Claude 描述',value:agent.sync.descriptionDiff.claude??'（无此行）'}]:[]),
      ...(agent.sync.diff||[]).flatMap(diff=>[{label:'Codex',value:diff.codex??'（无此行）'},{label:'Claude',value:diff.claude??'（无此行）'}]),
      {label:'如需一致',value:'对照差异手动更新 Claude 版本，保留其中专为 Claude 写的工具映射段'}]:[])]});
  const counts=agent.statsDetail;
  if(counts)sections.push({key:'stats',title:'调用统计',rows:[...['last7d','total'].map((key,i)=>({label:['近 7 天','累计'][i],
    value:`调用 ${counts[key]?.calls||0} · Claude ${counts[key]?.bySource?.claude||0} / Codex ${counts[key]?.bySource?.codex||0} · 成功 ${counts[key]?.ok||0} / 失败 ${counts[key]?.failed||0} / 未知 ${counts[key]?.unknown||0}`})),
    {label:'启动',value:`近 7 天 ${counts.launches?.last7d||0} · 累计 ${counts.launches?.total||0}`},{label:'最后调用（本机时区）',value:formatDate(counts.lastAt)}]});
  return {...agent,fullDescription:agent.description||'无描述',chips:[{label:agent.kind==='book'?'书籍 Agent':'功能性 Agent',tone:'kind'},
    {label:accessLabel(agent),tone:agent.writable?'warning':'normal'},
    // v0.16: role agents bind no book, so the source chip is shown for book agents only.
    ...(agent.kind==='book'?[{label:agent.sourcesOk===null?'原书路径未检查':agent.sourcesOk?'原书可用':'原书路径失效',tone:agent.sourcesOk?'success':'warning',title:agent.sourcesReason}]:[]),
    {label:syncLabel(agent.sync),tone:agent.sync.state==='同步'?'success':'normal',title:agent.sync.detail},...Object.entries(agent.platforms).map(([cli,p])=>({label:`${cli} ${p.available?'可用':'不可用'}`,tone:p.available?'success':'danger',title:p.reason||''}))],
    meta:{category:agent.primary,claudeModel:agent.permissions?.claude?.model||'未声明',claudeEffort:agent.permissions?.claude?.effort||'未声明',
      terminalDisplay:terminal?.display??null,terminalWindowMode:terminal?.windowMode??null,terminalReason:terminal?'':'当前设置接口未提供终端配置'},
    sections,history:history||{items:[],unavailable:[]},historyMessage:message};
}
export function toHistoryView(item) {
  const label = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : value || '未声明';
  const overall = item.status?.overall;
  const statusTone = ['ready','resumed','done','historical','ok'].includes(overall) ? 'ok' :
    overall === 'closed' ? 'neutral' : overall === 'failed' ? 'fail' : overall === 'running' ? 'running' : 'pending';
  return {...item,type:item.type,id:item.id,createdAt:item.createdAt,cli:item.cli,agents:item.agents||[],source:item.source||'未声明',
    sourceLabel:item.group?.name?`调用组 · ${item.group.name}`:label({launch:'单次',recommend:'AI 推荐',manual:'手动',group:'调用组'},item.source),
    modeLabel:label({agent:'直接',relay:'转调',joint:'联合'},item.mode),
    cliLabel:label({claude:'Claude',codex:'Codex'},item.cli),statusTone,
    inputPreview:item.inputPreview||'',status:item.status||{overall:'unconfirmed'},canResume:!!item.canResume,resumeReason:item.canResume?'':item.resumeReason||'此会话尚不可恢复'};
}
export async function mountApp(doc, fetchImpl = fetch, { confirm } = {}) {
  const get=id=>doc.getElementById(id),token=doc.querySelector('meta[name="agent-hub-token"]').content;
  const error=text=>{get('error').textContent=text;get('error').hidden=!text;};
  if(!confirm)confirm=createConfirmation(doc,{dialog:get('confirm'),title:get('confirm-title'),body:get('confirm-body'),cancel:get('confirm-cancel'),accept:get('confirm-accept')});
  // body without method = POST (legacy); v0.14 adds explicit PUT/DELETE for 调用组.
  async function api(url,body,method){const verb=method||(body===undefined?'GET':'POST');
    const response=await fetchImpl(url,verb==='GET'?{}:{method:verb,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),'X-Co-Agent-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||`HTTP ${response.status}`),{status:response.status,data:value});return value;}
  const active=new Map(),agentHistories=new Map(),historyMessages=new Map();
  let registry,stats,layout,builder,history,workflow,settings,basicConfig,agentManager,concepts,picker,seminars,consults,councils,conceptMap,chats,chatStart,followups,bookReader,seminarPicker,statsView,agentLinks,groups,groupAsk,candidates,disposed=false,statsTimer,runningTimer,loading=false,statsLoading=false,historyGeneration=0;
  let runningVersion=0;
  const closeToast=createStatusToast(doc,{id:'running-close-status',className:'running-close-toast'});
  const toast=createStatusToast(doc,{id:'app-toast',className:'app-toast',duration:5000});
  let running=[],pins=[],pinsWork=Promise.resolve(),state={view:'catalog',category:'role',query:'',sort:'default',selectedId:null,detailOpen:false,jointSelectedIds:[],reverifyBusy:false,reverifyMessage:'',closeRunningBusy:false,closingKeys:[],closingAll:false,room:'chat',roomFresh:{}};
  function models(){
    const records=(history?.snapshot().all||[]).map(toHistoryView);
    const allAgents=registry.agents.map(a=>{
      const cache=agentHistories.get(a.id);
      const resumeRecords=cache ? records.filter(r=>!(r.type==='launch'&&r.agents.some(m=>m.id===a.id))).concat(cache.items.map(h=>({...h,type:'launch',id:h.launchId,agents:[{id:a.id,name:a.name}],canResume:true}))) : records;
      return {...toAgentView(a,{stats,history:resumeRecords,active:active.get(a.id)}),pinned:pins.includes(a.id)};
    });
    // v0.29 常用: the pinned view leads the categories while any pin exists, in pin order.
    const pinnedCount=allAgents.filter(a=>a.pinned).length;if(state.category==='pinned'&&!pinnedCount)state.category=layout?.initialCategory||'role';
    let visible=sortAgents(allAgents.filter(a=>state.query.trim()?matchesSearch(a,state.query):state.category==='all'||(state.category==='pinned'?a.pinned:state.category==='role'?a.kind==='role':state.category==='book'?a.kind==='book':a.kind==='book'&&a.primary===state.category)),state.sort,stats);
    if(state.category==='pinned'&&!state.query.trim()&&state.sort==='default')visible=[...visible].sort((x,y)=>pins.indexOf(x.id)-pins.indexOf(y.id));
    if(!visible.some(a=>a.id===state.selectedId))state.selectedId=visible[0]?.id||null;
    const selected=visible.find(a=>a.id===state.selectedId);
    const categories=[...(pinnedCount?[{key:'pinned',label:'常用',fullLabel:'常用 Agent',count:pinnedCount}]:[]),{key:'role',label:'功能性 Agent',fullLabel:'功能性 Agent',count:registry.summary.roles},
      {key:'book',label:'全部书籍',fullLabel:'全部书籍',count:registry.summary.books},
      ...[...registry.categories,...(registry.summary.uncategorized>0?['未分类']:[])].map(key=>({key,label:categoryShort(key),fullLabel:key,count:allAgents.filter(a=>a.kind==='book'&&a.primary===key).length}))].map(c=>({...c,selected:c.key===state.category}));
    const hs=history?.snapshot()||{items:[],all:[],filter:'all',selectedId:null,message:'',busy:false};
    const items=hs.items.map(toHistoryView),all=hs.all.map(toHistoryView),ws=workflow?.snapshot()||{input:'',engine:'codex',cli:'codex',selectedIds:[],recent:[],settings:{}};
    const readable=!stats?.building&&statsReadable(stats);
    const sum=kind=>readable?allAgents.filter(a=>!kind||a.kind===kind).reduce((n,a)=>n+(a.stats7||0),0):null;
    const fallbackHistory={items:records.filter(h=>h.type==='launch'&&h.canResume&&h.agents.some(a=>a.id===selected?.id)).map(h=>({...h,launchId:h.id})),unavailable:[]};
    return {state:{...state,allAgents,pinnedIds:pins.filter(id=>allAgents.some(a=>a.id===id)),candidateCount:registry.candidates?.length||0,categories:registry.categories,display:registry.display||null,date:new Date().toISOString()},categories,
      catalog:{title:state.query.trim()?`搜索命中 ${visible.length} 个 Agent`:state.category==='all'?'全部 Agent':state.category==='pinned'?'常用 Agent':state.category==='role'?'功能性 Agent':state.category==='book'?'全部书籍 Agent':state.category,
        count:visible.length,agents:visible,selectedId:state.selectedId,query:state.query,sort:state.sort,categories:registry.categories,
        empty:allAgents.length?null:{unlisted:registry.outOfScope?.length||0}},
      detail:toDetailView(selected,agentHistories.get(selected?.id)||fallbackHistory,ws.settings,historyMessages.get(selected?.id)),
      metrics:{recent7:sum(),recentByKind:{role:sum('role'),book:sum('book')},total:allAgents.length,roles:registry.summary.roles,books:registry.summary.books,
        sync:{ok:registry.summary.synced??null,total:allAgents.length},scopeLimited:!!stats?.limited,scopeReasons:stats?.limitedReasons||[],statsState:!stats||stats.building?'building':readable?'ready':'unavailable',
        top:readable?allAgents.map(a=>({id:a.id,name:a.name,count:a.statsTotal||0})).sort((a,b)=>b.count-a.count):[]},
      history:{...hs,items,all,recent:all.slice(0,5),selected:items.find(h=>historyKey(h)===hs.selectedId)||null},running:running.map(item=>{
        if(item.type==='joint'||item.agentId)return item;
        const matches=registry.agents.filter(a=>[a.name,a.platforms?.[item.cli]?.name].some(name=>name&&name.toLowerCase()===item.agentName?.toLowerCase()));
        return {...item,agentId:matches.length===1?matches[0].id:null};
      }),
      concepts:conceptsView(concepts.snapshot()),chat:roomsView(chats.snapshot()),conceptMap:conceptMap.snapshot(),groups:groups.snapshot(),stats:statsView.snapshot(),coverage:{registry,stats,loading,statsLoading},recommend:{...ws,results:ws.recommendation?.status==='done'?(ws.recommendation.results||[]).map(result=>{
        const current=allAgents.find(a=>a.id===result.id)||toAgentView({...result,tags:result.tags||[],platforms:{claude:{available:false,reason:'当前注册表中不存在该 Agent'},codex:{available:false,reason:'当前注册表中不存在该 Agent'}}});
        return {...current,reason:result.reason||'',selected:ws.selectedIds.includes(result.id)};}):[]}};
  }
  // v0.40: 圆桌讨论, 会诊室 and 顾问团 are rooms of the chat page; a finished 圆桌 or 会诊 shown there can be followed up.
  function roomsView(c){
    const sem=seminars.snapshot(),con=consults.snapshot(),cou=councils.snapshot(),inRoom=room=>state.view==='chat'&&state.room===room&&!state.roomFresh[room];
    const record=inRoom('seminars')?sem.selected:inRoom('consults')?con.selected:null;
    if(record?.status==='done'&&record.result){
      const ids=record.seminarId?seminarParticipants(record,registry).map(p=>p.id):record.result.lenses.map(l=>registry.agents.find(a=>a.platforms?.codex?.name===l.agent)?.id);
      followups.target({room:record.seminarId?'seminars':'consults',id:record.seminarId||record.consultId},ids.filter(Boolean));
    } else followups.target(null);
    return {...c,groupName:groups.get((c.selected||c.pending)?.groupId)?.name||'',room:state.room,fresh:{...state.roomFresh},seminars:sem,consults:con,councils:cou,follow:followups.snapshot()};
  }
  function enterRoom(room){state.view='chat';state.room=room;state.roomFresh[room]=false;state.detailOpen=false;paint();}
  function paint(){if(disposed||!registry||!layout)return;const data=models();layout.update(data);agentLinks?.refresh();get('settings-last-scan').textContent=`上次扫描：${formatDate(registry.scannedAt)}`;}
  async function loadPins(){try{const value=await api('/api/pins');if(!disposed&&Array.isArray(value?.ids)){pins=value.ids;paint();}}catch(problem){error(`常用 Agent 读取失败：${problem.message}`);}}
  async function readAgentHistory(id){const version=++historyGeneration;
    try{const value=await api(`/api/history/${encodeURIComponent(id)}`);if(disposed||version!==historyGeneration)return;
      if(Array.isArray(value.items)){agentHistories.set(id,value);historyMessages.delete(id);paint();}}
    catch(problem){if(!disposed&&version===historyGeneration){historyMessages.set(id,`会话记录读取失败：${problem.message}`);paint();}}}
  async function load(force=false){loading=true;error('');get('refresh').disabled=true;
    try{const value=await api(force?'/api/refresh':'/api/registry',force?{}:undefined);if(disposed)return;registry=value;paint();builder?.refresh();picker?.refresh();seminarPicker?.refresh();candidates?.refresh();if(force&&stats)await loadStats();}
    catch(problem){error(problem.message);}finally{loading=false;get('refresh').disabled=false;}}
  async function loadStats(force=false){clearTimeout(statsTimer);statsLoading=true;
    try{const value=await api(force?'/api/stats/refresh':'/api/stats',force?{}:undefined);if(disposed)return;
      if(!value.perAgent||!Array.isArray(value.sources))throw new Error('统计响应无效');stats=value;paint();if(stats.building)statsTimer=setTimeout(()=>loadStats(),1000);}
    catch(problem){if(!disposed)error(`统计读取失败：${problem.message}`);}finally{statsLoading=false;}}
  async function loadRunning(){if(disposed)return;clearTimeout(runningTimer);
    const version=++runningVersion;
    try{const value=await api('/api/running');if(!disposed&&version===runningVersion){if(!Array.isArray(value.items))throw new Error('运行记录响应无效');running=value.items;paint();}}
    catch(problem){if(!disposed&&version===runningVersion)error(`运行记录读取失败：${problem.message}`);}if(!disposed&&version===runningVersion)runningTimer=setTimeout(loadRunning,2000);}
  function notifyClose(text){
    if(!disposed)closeToast.show(text);
  }
  function closeResults(value, records){
    // The manual specifies item fields, but not the envelope; validate every ID
    // for each conventional response shape rather than trusting an aggregate count.
    const results=Array.isArray(value)?value:value?.items ?? value?.results;
    const expected=new Map(records.map(item=>[historyKey(item),item])),seen=new Set();
    if(!Array.isArray(results)||results.length!==expected.size)throw new Error('关闭结果响应无效，请刷新运行列表核对');
    for(const result of results){
      const key=result&&historyKey(result);
      if(!expected.has(key)||seen.has(key)||!['closed','not-running','pid-mismatch','failed','error'].includes(result.result)
        ||(result.result==='closed'&&typeof result.windowClosed!=='boolean'))throw new Error('关闭结果响应无效，请刷新运行列表核对');
      seen.add(key);
    }
    return results;
  }
  function closeSummary(results, records){
    const expected=new Map(records.map(item=>[historyKey(item),item]));
    const closed=results.filter(item=>item.result==='closed'),parts=[`已关闭 ${closed.length} 个会话`];
    const manual=closed.filter(item=>!item.windowClosed&&item.windowReason!=='终端窗口已不存在'
      &&expected.get(historyKey(item)).terminalFallback!=='no-wt'&&expected.get(historyKey(item)).status?.terminalFallback!=='no-wt');
    if(manual.length)parts.push(`有 ${manual.length} 个终端窗口需要手动关闭`);
    const absent=results.filter(item=>item.result==='not-running').length,mismatch=results.filter(item=>item.result==='pid-mismatch').length;
    if(absent)parts.push(`${absent} 个会话已不在运行`);
    if(mismatch)parts.push(`${mismatch} 个会话因 PID 身份不符未关闭`);
    for(const result of results){
      if(result.windowReason)parts.push(String(result.windowReason));
      if(['failed','error'].includes(result.result))parts.push(`${runningName(expected.get(historyKey(result)))}：${result.error || result.reason || '关闭失败'}`);
    }
    return [...new Set(parts)].join('；');
  }
  async function closeRunningRecords(records, trigger, all){
    if(disposed||state.closeRunningBusy||!records.length)return;
    // Never extend a confirmed list with sessions discovered by later polling.
    records=structuredClone(records);
    const recovery='终端窗口会被关闭；之后可以在「历史调用」→「继续该次会话」恢复。';
    const text=all?`关闭全部 ${records.length} 个运行中的会话？\n${records.map(runningName).join('\n')}\n${recovery}`
      :`关闭 ${runningName(records[0])} 的 ${{claude:'Claude',codex:'Codex'}[records[0].cli] || records[0].cli} 会话？${recovery}`;
    state.closeRunningBusy=true;paint();let submitted=false;const results=[];
    try{
      if(!await confirm(text,trigger,{title:all?'关闭全部会话':'关闭会话',accept:all?`关闭 ${records.length} 个`:'关闭',danger:true})||disposed)return;
      state.closingKeys=records.map(({type,id})=>`${type}:${id}`);state.closingAll=all;paint();
      submitted=true;runningVersion++;clearTimeout(runningTimer);
      for(let start=0;start<records.length;start+=50){
        const batch=records.slice(start,start+50);
        const value=await api('/api/running/close',{items:batch.map(({type,id})=>({type,id}))});
        if(disposed)return;
        results.push(...closeResults(value,batch));
      }
      notifyClose(closeSummary(results,records));
    }catch(problem){if(!disposed)notifyClose(`${results.length?`${closeSummary(results,records)}；`:''}关闭失败：${problem.message}；请刷新运行列表核对，未自动重试`);}
    finally{
      // A failed/uncertain POST can still have closed a process. Read, never retry.
      if(!disposed&&submitted){await loadRunning();if(!disposed)await history.load();}
      state.closeRunningBusy=false;state.closingKeys=[];state.closingAll=false;paint();
      if(!disposed&&trigger&&!Array.from(doc.querySelectorAll('dialog')).some(d=>d.open)){
        const key=trigger.getAttribute?.('data-focus-key');
        const replacement=trigger.isConnected?trigger:Array.from(doc.querySelectorAll('[data-focus-key]')).find(n=>n.getAttribute('data-focus-key')===key);
        if(doc.activeElement?.isConnected===false||doc.activeElement===doc.body||get('confirm').contains(doc.activeElement)){
          const target=replacement || get('running-close-all');
          if(target&&!target.disabled&&!target.closest('[hidden]'))target.focus();
          else {const heading=get('running-title');if(heading&&!heading.closest('[hidden]')){heading.setAttribute('tabindex','-1');heading.focus();}}
        }
      }
    }
  }
  async function changed(){await history.load();await loadRunning();await workflow.loadRecent();if(stats)await loadStats();}
  async function poll(id,entry){if(disposed||active.get(id)!==entry)return;
    try{entry.status=await api(`/api/launch/${entry.launchId}`);if(disposed||active.get(id)!==entry)return;paint();if(pollFinished(entry.status))return;}
    catch(problem){error(`核验读取失败：${problem.message}`);}if(!disposed&&active.get(id)===entry)entry.timer=setTimeout(()=>poll(id,entry),2000);}
  async function launch(id,cli,resumeOf){const agent=registry?.agents.find(a=>a.id===id);if(!agent||active.get(id)?.busy||!agent.platforms[cli]?.available)return;
    error('');const previous=active.get(id);if(previous?.timer)clearTimeout(previous.timer);const entry={busy:true};active.set(id,entry);paint();
    try{const flags=await confirmMembers([agent],cli,{confirm,permissionText});if(!flags||disposed)return;
      const result=await api(resumeOf?'/api/resume':'/api/launch',{agentId:id,...(resumeOf?{launchId:resumeOf}:{cli}),...flags});
      if(disposed)return;entry.launchId=result.launchId;entry.status={notice:result.notice,terminalFallback:result.terminalFallback,overall:'pending',message:'正在核验启动',process:{state:'pending'},cwd:{state:'pending'},agent:{state:'pending'},waiting:{state:'pending'}};
      paint();await poll(id,entry);await loadStats();await loadRunning();await history.load();}
    catch(problem){error(problem.message);}finally{entry.busy=false;paint();}}
  const actions={launch,
    closeRunning:(type,id,trigger)=>closeRunningRecords(running.filter(item=>item.type===type&&item.id===id),trigger,false),
    closeAllRunning:trigger=>closeRunningRecords(running,trigger,true),
    openAgentFile:(id,event)=>agentLinks.openAgentFile(id,event),
    // v0.41: 「打开原书」 reads the book inside the app; Ctrl+click on a book name still opens it with the system program.
    readBook:(id,trigger)=>bookReader.open(id,trigger),
    bookFacts:id=>api(`/api/book-facts/${encodeURIComponent(id)}`),
    readReport:(id,index)=>api(`/api/reports/${encodeURIComponent(id)}/${index}`),
    async resume(id,cli,launchId){if(!launchId){await readAgentHistory(id);const item=agentHistories.get(id)?.items.find(i=>!cli||i.cli===cli);if(!item)return;cli=item.cli;launchId=item.launchId;}return launch(id,cli,launchId);},
    openDetail(id,trigger){const agent=registry?.agents.find(a=>a.id===id);if(!agent)return;
      // Recommendation results can be outside the current category; show their row before detail.
      const visible=models().catalog.agents;if(!visible.some(a=>a.id===id)){state.category=agent.kind==='role'?'role':agent.primary;state.query='';}
      state.selectedId=id;state.detailOpen=true;state.view='catalog';trigger?.focus?.();paint();return readAgentHistory(id);},
    closeDetail(){state.detailOpen=false;paint();},
    selectCategory(key){state.category=key;state.view='catalog';paint();},
    // Saves are queued; a rejected save shows a toast and reloads the server's list.
    togglePin(id){if(!registry?.agents.some(a=>a.id===id))return;const next=pins.includes(id)?pins.filter(p=>p!==id):[...pins,id];pins=next;paint();
      const work=pinsWork.then(()=>api('/api/pins',{ids:next},'PUT')).then(()=>{},async problem=>{if(disposed)return;toast.show(`常用 Agent 保存失败：${problem.message}`);await loadPins();});
      pinsWork=work;return work;},
    search(text){state.query=String(text);state.view='catalog';paint();},sort(value){state.sort=value;paint();},
    showView(view){if(view==='chat')return chats.open();if(view==='conceptMap')return conceptMap.openConceptMap();if(view==='councils')return actions.openCouncils();if(view==='consults')return consults.openConsults();if(view==='groups')return actions.openGroups();if(view==='seminars')return seminars.openSeminars();if(view==='stats')return actions.openStats();if(view==='concepts')return concepts.openConcepts();if(!['catalog','recommend','history','running','coverage'].includes(view))return;state.view=view;state.detailOpen=false;paint();if(view==='history')return history.load();if(view==='running')return loadRunning();if(view==='recommend')layout.context.refs.recommendInput?.focus();},
    openStats(){state.view='stats';state.detailOpen=false;paint();return loadStats(true);},
    // v0.14 调用组
    openGroups:()=>groups.open(),selectGroup:id=>groups.select(id),newGroup:trigger=>builder.open(trigger,[]),
    askGroup(id,trigger,prefill){groups.select(id);return groupAsk.open(id,trigger,prefill);},
    editGroup(id,trigger){const group=groups.get(id);if(group)builder.edit(group,trigger);},
    deleteGroup:(id,trigger)=>groups.remove(id,trigger),refreshGroups:()=>groups.load(),
    setStatsRange:value=>statsView.setRange(value),setStatsFilter:value=>statsView.setFilter(value),
    setStatsCategory:value=>statsView.setCategory(value),toggleStatsShowAll:()=>statsView.toggleShowAll(),
    openConcepts:()=>concepts.openConcepts(),selectConcept:id=>concepts.selectConcept(id),nextConcept:()=>concepts.nextConcept(),
    openConceptResponse:id=>concepts.openConceptResponse(id),toggleConceptThread:()=>concepts.toggleConceptThread(),refreshConceptThread:()=>concepts.refreshThread(),
    openPerspectivePicker:id=>concepts.openPerspectivePicker(id),runPerspectives:(id,ids)=>concepts.runPerspectives(id,ids),continueInJoint:(id,ids)=>concepts.continueInJoint(id,ids),
    openRoom(room){if(room==='chat')return chats.open();if(room==='seminars')return seminars.openSeminars();if(room==='consults')return consults.openConsults();if(room==='councils')return actions.openCouncils();},
    newRoomRecord(room){state.roomFresh[room]=true;paint();},
    sendFollowup:()=>followups.send(),setFollowupDraft:text=>followups.setDraft(text),setFollowupRecipients:ids=>followups.setRecipients(ids),
    followupStop:agentId=>followups.stop(agentId),followupRetry:(turnId,agentId)=>followups.retry(turnId,agentId),followupTerminal:agentId=>followups.terminal(agentId),
    openSeminars:()=>seminars.openSeminars(),startSeminar:input=>seminars.startSeminar(input),selectSeminar:id=>{state.roomFresh.seminars=false;return seminars.selectSeminar(id);},
    openSeminarAddPicker:id=>seminars.openSeminarAddPicker(id),rerunSeminar:(id,ids)=>seminars.rerunSeminar(id,ids),
    continueSeminarInJoint:id=>seminars.continueSeminarInJoint(id),setSeminarInput:input=>seminars.setInput(input),
    openConsults:()=>consults.openConsults(),startConsult:()=>consults.startConsult(),selectConsult:id=>{state.roomFresh.consults=false;return consults.selectConsult(id);},
    deleteConsult:(id,trigger)=>consults.deleteConsult(id,trigger),rerunConsult:async id=>{await consults.rerunConsult(id);if(consults.snapshot().draft.parentId===id){state.roomFresh.consults=true;paint();}},setConsultDraft:patch=>consults.setConsultDraft(patch),
    openConceptMap:key=>conceptMap.openConceptMap(key),selectMapConcept:key=>conceptMap.selectMapConcept(key),
    searchConceptMap:q=>conceptMap.searchConceptMap(q),organizeConceptMap:()=>conceptMap.organizeConceptMap(),
    updateConceptMap:body=>conceptMap.updateConceptMap(body),openMapSource:mention=>conceptMap.openMapSource(mention),
    async openCouncils(){await councils.openCouncils();const c=councils.snapshot(),first=c.items.find(x=>!x.archived);if(!c.selected&&!c.draft&&first)await councils.selectCouncil(first.councilId);},selectCouncil:id=>councils.selectCouncil(id),newCouncil:()=>councils.newCouncil(),
    editCouncil:()=>councils.editCouncil(),cancelCouncilEdit:()=>councils.cancelCouncilEdit(),setCouncilDraft:p=>councils.setCouncilDraft(p),saveCouncil:()=>councils.saveCouncil(),
    setCouncilReport:text=>councils.setCouncilReport(text),startCouncilSession:()=>councils.startCouncilSession(),
    archiveCouncil:()=>councils.archiveCouncil(),undoCouncil:trigger=>councils.undoCouncil(trigger),deleteCouncil:trigger=>councils.deleteCouncil(trigger),
    openJoint(ids,trigger){builder.open(trigger,ids);},addToJoint(id,trigger,show=true){const agent=registry?.agents.find(a=>a.id===id);if(agent){if(!show)state.detailOpen=false;builder.add(agent,trigger,show);paint();}},removeFromJoint(id){builder.remove(id);},
    recommend:()=>workflow.recommend(),setRecommendInput:text=>workflow.setInput(text),setRecommendEngine:cli=>workflow.setEngine(cli),setJointCli:cli=>workflow.setCli(cli),
    selectRecommendationAgent:(id,checked)=>workflow.select(id,checked),selectAllRecommendations:checked=>workflow.selectAll(checked),launchRecommendedJoint:()=>workflow.launchJoint(),
    selectRecommendation:id=>workflow.selectRecommendation(id),reverifyJoint:id=>workflow.reverifyJoint(id),
    rerun:(type,id)=>history.execute(type,id,false),resumeHistory:(type,id)=>history.execute(type,id,true),
    selectHistory(type,id,trigger){state.view='history';state.detailOpen=true;trigger?.focus?.();history.select(type,id);},setHistoryFilter:type=>history.setFilter(type),refreshHistory:()=>history.load(),
    openCandidates:trigger=>candidates.open(trigger),openAgentManager:trigger=>agentManager.open(trigger),
    // v0.39 在 CO-AGENT 中调用
    openChatStart:(id,trigger)=>chatStart.open(id,trigger),startChat:options=>chats.start(options),openChats:()=>chats.open(),
    selectChat:id=>chats.select(id),sendChat:()=>chats.send(),rewriteChat:()=>chats.rewrite(),editChatRewrite:(id,text)=>chats.editRewrite(id,text),clearChatRewrite:()=>chats.clearRewrite(),setChatDraft:text=>chats.setDraft(text),setChatRecipients:ids=>chats.setRecipients(ids),
    stopChat:agentId=>chats.stop(agentId),retryChat:(turnId,agentId)=>chats.retry(turnId,agentId),chatTerminal:agentId=>chats.terminal(agentId),
    newChat:()=>chats.newChat(),setChatEngine:engine=>chats.setEngine(engine),
    openSettings:trigger=>settings.open(trigger),refresh:()=>load(true),refreshStats:()=>loadStats(true),refreshRunning:loadRunning,
    async reverifyAgent(id){const value=await api(`/api/history/${encodeURIComponent(id)}/reverify`,{});if(!disposed){agentHistories.set(id,value.history);historyMessages.set(id,reverifySummary(value.summary));paint();}return value;},
    async reverifyAll(){if(state.reverifyBusy)return;state.reverifyBusy=true;state.reverifyMessage='正在全部重新核验…';paint();
      try{const value=await api('/api/history/reverify-all',{});state.reverifyMessage=reverifySummary(value.summary);if(state.selectedId)await readAgentHistory(state.selectedId);await history.load();await loadRunning();}
      catch(problem){state.reverifyMessage=`重新核验失败：${problem.message}`;}finally{state.reverifyBusy=false;paint();}}
  };
  statsView=createStatsView({getStats:()=>stats,getRegistry:()=>registry,onState:paint});
  history=createCallHistory({api,getRegistry:()=>registry,confirm,permissionText,onState:()=>{if(history)get('call-status').textContent=history.snapshot().message;paint();},onChanged:async()=>{await loadRunning();await workflow.loadRecent();}});
  workflow=createWorkflows({api,confirm,error,permissionText,getRegistry:()=>registry,onChat:options=>chats.start(options),onState:paint,onChanged:async()=>{await history.load();await loadRunning();}});
  groups=createGroups({api,getRegistry:()=>registry,confirm,permissionText,onState:()=>{paint();groupAsk?.refresh();},onChanged:changed,notify:text=>toast.show(text),
    onOpen:()=>{state.view='groups';state.detailOpen=false;paint();}});
  groupAsk=mountGroupAsk(doc,{groups,onChat:options=>chats.start(options),getSkin:()=>layouts[layout?.current]?.jointBuilderSkin||''});
  builder=mountJointBuilder(doc,{api,getRegistry:()=>registry,matchesSearch,onChat:options=>chats.start(options),getCategoryOrder:()=>layouts[layout?.current]?.categoryOrder?.(registry?.categories||[]),confirm,permissionText,onChanged:changed,onSelection:ids=>{state.jointSelectedIds=ids;paint();},
    async onSaveGroup({name,agentIds,cli,question,run,crossExam,inApp}){const group=await groups.create({name,agentIds,cli,question});
      if(run&&inApp)await chats.start({agentIds,engine:cli,question,groupId:group.id});
      else if(run)await groups.run(group.id,{input:question,cli,crossExam});else{state.view='groups';state.detailOpen=false;paint();}return group;},
    onUpdateGroup:(id,patch)=>groups.update(id,patch)});
  concepts=createConcepts({api,getRegistry:()=>registry,confirm,permissionText,onState:paint,
    onOpen:()=>{state.view='concepts';state.detailOpen=false;paint();},onPicker:record=>picker.open(record),
    onJoint:prefill=>{picker.close();if(!builder.open(undefined,prefill.agentIds,prefill))throw new Error('联合调用正在提交，请稍后再试');}});
  picker=mountPerspectivePicker(doc,{api,getRegistry:()=>registry,onRun:actions.runPerspectives,onContinue:actions.continueInJoint});
  seminars=createSeminars({api,getRegistry:()=>registry,confirm,permissionText,onState:paint,
    onOpen:()=>enterRoom('seminars'),onPicker:(record,ids)=>seminarPicker.open(record,undefined,ids),
    onJoint:prefill=>{seminarPicker.close();if(!builder.open(undefined,prefill.agentIds,prefill))throw new Error('联合调用正在提交，请稍后再试');}});
  seminarPicker=mountPerspectivePicker(doc,{mode:'seminar',api,getRegistry:()=>registry,onRun:actions.rerunSeminar});
  chats=createChats({api,getRegistry:()=>registry,confirm,onState:paint,onOpen:()=>{state.view='chat';state.room='chat';state.detailOpen=false;paint();}});
  followups=createFollowups({api,getRegistry:()=>registry,confirm,onState:paint});
  chatStart=mountChatStart(doc,{getRegistry:()=>registry,onStart:options=>chats.start(options)});
  consults=createConsults({api,getRegistry:()=>registry,confirm,permissionText,onState:paint,
    onOpen:()=>enterRoom('consults')});
  councils=createCouncils({api,getRegistry:()=>registry,confirm,permissionText,onState:paint,
    onOpen:()=>enterRoom('councils')});
  conceptMap=createConceptMap({api,onState:paint,onOpen:()=>{state.view='conceptMap';state.detailOpen=false;paint();},
    onSource:async(type,id)=>{const record=await(type==='seminars'?seminars.selectSeminar(id):concepts.selectConcept(id));
      if(!record)return false;if(type==='seminars')enterRoom('seminars');else{state.view=type;state.detailOpen=false;paint();}return true;}});
  layout=mountLayouts(doc,actions);state.category=layout.initialCategory||'role';
  candidates=mountCandidates(doc,{api,getRegistry:()=>registry,onChanged:()=>load(true),notify:text=>toast.show(text),getSkin:()=>layouts[layout.current]?.jointBuilderSkin||''});
  settings=mountSettings(doc,fetchImpl,token,ui=>{
    // Keep selection and drafts, but never open a fresh modal over the settings dialog.
    state.detailOpen=false;paint();layout.set(ui);paint();
  },{bindTrigger:false});
  basicConfig=mountBasicConfig(doc,fetchImpl,token,{openSettings:()=>settings.open()});
  agentManager=mountAgentManager(doc,{api,onChanged:()=>load(true),notify:text=>toast.show(text),getSkin:()=>layouts[layout.current]?.jointBuilderSkin||''});
  get('settings-agents')?.addEventListener('click',event=>{settings.close();return agentManager.open(event.currentTarget);});
  get('refresh').addEventListener('click',actions.refresh);get('settings-coverage').addEventListener('click',()=>{settings.close();actions.showView('coverage');});
  const shortcuts=event=>{if(Array.from(doc.querySelectorAll('dialog')).some(d=>d.open))return;
    const inputFocused=['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName?.toUpperCase())||event.target?.isContentEditable;
    if((event.key==='/'&&!inputFocused)||(event.ctrlKey&&event.key.toLowerCase()==='k')){event.preventDefault();(state.view==='conceptMap'?layout.context.refs.conceptMapSearch:state.view==='chat'?(get('chat-panel')?.querySelectorAll('textarea,input')||[]).find(n=>(n.tagName==='TEXTAREA'||n.className.includes('room-line'))&&!n.closest('[hidden]')&&!n.disabled):layout.context.refs.search)?.focus();}
    if(event.key==='Escape')actions.search('');};
  doc.addEventListener('keydown',shortcuts);
  agentLinks=mountAgentLinks(doc,{api,getRegistry:()=>registry});
  bookReader=mountBookReader(doc,{api,getRegistry:()=>registry});
  const motion=mountMotion(doc);
  await load();await loadPins();await loadStats();await loadRunning();await history.load();await workflow.initialize();await concepts.refresh();await seminars.refresh();await consults.refresh();await councils.refresh();await groups.load();paint();await basicConfig?.load();
  return {actions,snapshot:()=>structuredClone(models()),dispose(){disposed=true;historyGeneration++;runningVersion++;closeToast.dispose();toast.dispose();candidates.dispose();groups.dispose();groupAsk.dispose();history.dispose();workflow.dispose();concepts.dispose();picker.dispose();seminars.dispose();consults.dispose();councils.dispose();conceptMap.dispose();chats.dispose();followups.dispose();bookReader.dispose();chatStart.dispose();seminarPicker.dispose();settings.dispose();basicConfig?.dispose();agentManager?.dispose();agentLinks.dispose();motion.dispose();layout.context.refs.dispose?.();doc.removeEventListener('keydown',shortcuts);clearTimeout(statsTimer);clearTimeout(runningTimer);for(const entry of active.values())clearTimeout(entry.timer);active.clear();}};
}
if(typeof document!=='undefined')mountApp(document).catch(problem=>{const target=document.getElementById('error');target.textContent=problem.message;target.hidden=false;});
