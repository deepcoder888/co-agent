import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appDocument} from './fixtures/app.mjs';
import {descendants} from './fixtures/dom.mjs';
import {mountApp} from '../public/app.js';
import {mountPerspectivePicker} from '../public/calls.js';
import {layouts} from '../public/layouts/index.js';

const member=(id,kind='book')=>({id,name:`作者${id}`,kind,primary:'学习',tags:[],description:'说明',
  book:kind==='book'?{title:`原书${id}`,author:`作者${id}`}:null,platforms:{codex:{available:true,name:`cli-${id}`},claude:{available:true}},
  sources:{checked:true,missing:[]},permissions:{},sync:{state:'同步'}});
const agents=[...Array.from({length:9},(_,i)=>member(`b${i}`)),member('role','role')];
const registry={agents,categories:['学习'],summary:{books:9,roles:1},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const terms=[{zh:'能量',en:'Energy',fr:'Énergie'}];
const record=(id='s1',extra={})=>({version:1,seminarId:id,parentId:null,input:'为什么习惯难以改变？',mode:'auto',requestedAgents:null,
  status:'done',createdAt:'2026-10-08T01:00:00Z',startedAt:'2026-10-08T01:00:00Z',finishedAt:'2026-10-08T01:01:00Z',model:'fixture',effort:'xhigh',
  result:{terms,selected:agents.slice(0,3).map(a=>({agent:a.platforms.codex.name,id:a.id,name:a.name,bookLabel:a.book.title,reason:`理由${a.id}`})),
    perAgent:agents.slice(0,3).map(a=>({agent:a.platforms.codex.name,id:a.id,analysis:`## 原文${a.id}\n\nBOOK：第 3 章。\n\nINFERENCE：**完整观点**。`,coverage:'直接'})),
    commonAnswer:{summary:'共同说明',points:[{text:'共同点',support:['cli-b0','cli-b1','cli-b2'],strength:'全员一致'},{text:'多数观点',support:['cli-b0','cli-b1'],strength:'多数同意',strengthCorrected:true}]},
    divergences:[{topic:'争议',positions:[{agent:'cli-b0',view:'立场甲'},{agent:'cli-b1',view:'立场乙'}]}],actions:[1,2,3].map(i=>({text:`行动${i}`,basis:['cli-b0','cli-b2']}))},
  verify:{state:'unconfirmed',parallel:{state:'unconfirmed'},violations:['合成核验警告']},thinkError:'合成另存失败',...extra});
const listing=(items=[record()],running=null)=>({items,running});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function clock(){const tasks=new Map();let id=0;return{tasks,setTimer(fn,ms){tasks.set(++id,{fn,ms});return id;},clearTimer(id){tasks.delete(id);},async tick(){const [key,task]=tasks.entries().next().value;tasks.delete(key);await task.fn();}};}
async function controller(t,api,options={}){const {createSeminars}=await import('../public/seminars.js'),timers=clock();
  const model=createSeminars({api,getRegistry:()=>registry,confirm:async()=>true,permissionText:()=>'',...timers,...options});t.after(()=>model.dispose());return{model,timers};}
function safeDOM(doc){const create=doc.createElement;doc.createElement=tag=>{const el=create(tag),set=el.setAttribute.bind(el);el.setAttribute=(k,v)=>{assert.notEqual(k,'style');set(k,v);};Object.defineProperty(el,'innerHTML',{set(){assert.fail('HTML sink');}});return el;};doc.createTextNode=text=>{const el=doc.createElement('text');el.textContent=text;return el;};return doc;}

test('v011 polling: idle 60s, active 5s off-view, full records and trilingual snapshots are detached',async t=>{
  let data=listing();const records=new Map([['s1',record()],['s2',record('s2')]]);
  const {model,timers}=await controller(t,async url=>url.includes('?')?data:records.get(url.split('/').at(-1)));
  await model.openSeminars();assert.equal(model.snapshot().selected.seminarId,'s1');assert.equal([...timers.tasks.values()][0].ms,60000);
  assert.deepEqual(model.snapshot().terms,terms);assert.deepEqual(model.snapshot().selected.terms,terms);assert.deepEqual(model.snapshot().items[0].terms,terms);
  const copy=model.snapshot();copy.selected.result.terms[0].fr='corrupt';assert.equal(model.snapshot().terms[0].fr,'Énergie');
  data=listing([record()],{seminarId:'s1',status:'running'});records.set('s1',record('s1',{status:'running'}));await timers.tick();
  await model.selectSeminar('s2');assert.equal([...timers.tasks.values()][0].ms,5000);
  data=listing();records.set('s1',record());await timers.tick();assert.equal([...timers.tasks.values()][0].ms,60000);
  model.dispose();assert.equal(timers.tasks.size,0);
});
test('v011 stale selections, list responses, and disposed requests cannot replace current state',async t=>{
  const slow=deferred(),list=deferred();let lists=0,emits=0;
  const {model,timers}=await controller(t,async url=>url.includes('?')?(++lists===1?list.promise:listing([record('s2')])):url.endsWith('s1')?slow.promise:record('s2'),{onState:()=>emits++});
  const first=model.selectSeminar('s1');await model.selectSeminar('s2');slow.resolve(record());await first;assert.equal(model.snapshot().selected.seminarId,'s2');
  const pending=model.refresh();await model.refresh();list.resolve(listing([record()]));await pending;assert.equal(model.snapshot().items[0].seminarId,'s2');
  model.dispose();const before=emits;await model.openSeminars();assert.equal(emits,before);assert.equal(timers.tasks.size,0);
});
test('v011 automatic submit validates 1–2000 characters, is single-flight, and sends only input',async t=>{
  const gate=deferred(),posts=[];const {model}=await controller(t,async(url,body)=>{if(body){posts.push({url,body});return gate.promise;}return url.includes('?')?listing([record('new',{status:'queued',result:null})],{seminarId:'new'}):record('new',{status:'queued',result:null});});
  for(const text of ['', '   ', '中'.repeat(2001),null])assert.equal(await model.startSeminar(text),false);
  const pending=model.startSeminar('一个问题');assert.equal(model.snapshot().busy,true);assert.equal(await model.startSeminar('重复'),false);
  gate.resolve({seminarId:'new'});assert.equal(await pending,true);assert.deepEqual(posts,[{url:'/api/seminars',body:{input:'一个问题'}}]);assert.equal(model.snapshot().selected.seminarId,'new');
  // v0.48: another 圆桌 may start while this one runs (up to three).
  assert.equal(await model.startSeminar('正在运行时'),true);assert.equal(posts.length,2);
});
test('v011 409 adopts running evidence without retry; failed reads retain a useful error and polling',async t=>{
  let posts=0;const {model,timers}=await controller(t,async(url,body)=>{if(body){posts++;throw Object.assign(new Error('已有研讨'),{status:409,data:{running:{seminarId:'other',status:'running'}}});}throw new Error('读取断开');});
  assert.equal(await model.startSeminar('问题'),false);assert.equal(posts,1);assert.equal(model.snapshot().running.seminarId,'other');assert.match(model.snapshot().error,/已有研讨/);assert.equal([...timers.tasks.values()][0].ms,5000);
  await timers.tick();assert.match(model.snapshot().error,/读取断开/);assert.equal([...timers.tasks.values()][0].ms,5000);
});
test('v011 old detail failures during polling cannot overwrite a newer successful selection',async t=>{
  const old=deferred();const {model}=await controller(t,async url=>url.includes('?')?listing():url.endsWith('s1')?old.promise:record('s2'));
  const pending=model.refresh();await Promise.resolve();await model.selectSeminar('s2');old.reject(new Error('旧记录失败'));await pending;
  assert.equal(model.snapshot().selected.seminarId,'s2');assert.equal(model.snapshot().error,'');
});
test('v011 disposal during confirmation or POST suppresses further prompts, writes, callbacks and timers',async t=>{
  const current=structuredClone(registry);current.agents[0].writable=true;current.agents[0].sources.missing=['absent'];
  const approval=deferred();let prompts=0,posts=0,opened=0,emits=0;
  const {model,timers}=await controller(t,async(url,body)=>{if(body)posts++;return record();},{getRegistry:()=>current,confirm:()=>{prompts++;return approval.promise;},onOpen:()=>opened++,onState:()=>emits++});
  await model.selectSeminar('s1');const pending=model.rerunSeminar('s1',['b0','b1','b2']);await Promise.resolve();await Promise.resolve();
  assert.equal(prompts,1);model.dispose();const before=emits;approval.resolve(true);await pending;
  assert.equal(prompts,1);assert.equal(posts,0);assert.equal(opened,0);assert.equal(emits,before);assert.equal(timers.tasks.size,0);
  const post=deferred();const {model:later,timers:laterTimers}=await controller(t,async()=>post.promise,{onOpen:()=>opened++});
  const submitted=later.startSeminar('问题');later.dispose();post.resolve({seminarId:'late'});assert.equal(await submitted,false);assert.equal(opened,0);assert.equal(laterTimers.tasks.size,0);
});
test('v011 2000-character boundary succeeds; malformed accepted response does not invent a record',async t=>{
  const requests=[];const {model}=await controller(t,async(url,body)=>{requests.push({url,body});return{};});
  assert.equal(await model.startSeminar('字'.repeat(2000)),false);assert.equal(requests[0].body.input.length,2000);assert.match(model.snapshot().error,/响应无效/);assert.equal(model.snapshot().selected,null);assert.equal(model.snapshot().running,null);
});
test('v011 explicit rerun rejects nonbooks, missing/unavailable, duplicate and invalid participant counts',async t=>{
  const current=structuredClone(registry);current.agents[8].platforms.codex.available=false;const posts=[];
  const {model}=await controller(t,async(url,body)=>{if(body)posts.push(body);return record();},{getRegistry:()=>current});await model.selectSeminar('s1');
  for(const ids of [[],['b0','b1'],['b0','b0','b1'],['b0','b1','role'],['b0','b1','missing'],['b0','b1','b8'],agents.slice(0,9).map(a=>a.id)])assert.equal(await model.rerunSeminar('s1',ids),false);
  assert.equal(posts.length,0);
});
test('v011 explicit rerun freezes ids and confirmation flags, cancellation and changed registry stop submission',async t=>{
  const current=structuredClone(registry);current.agents[0].writable=true;current.agents[1].sources.missing=['absent'];
  const gate=deferred(),posts=[],prompts=[];const {model}=await controller(t,async(url,body)=>{if(body){posts.push(body);return{seminarId:'new'};}return url.includes('?')?listing([record('new')]):record(url.split('/').at(-1));},
    {getRegistry:()=>current,confirm:text=>{prompts.push(text);return gate.promise;}});
  await model.selectSeminar('s1');const ids=['b0','b1','b2'],pending=model.rerunSeminar('s1',ids);ids[2]='role';gate.resolve(true);assert.equal(await pending,true);
  assert.deepEqual(posts[0],{input:record().input,agentIds:['b0','b1','b2'],parentId:'s1',writableConfirmed:true,sourcesConfirmed:true});assert.equal(prompts.length,2);
  const {model:cancel}=await controller(t,async(url,body)=>{assert.equal(body,undefined);return record();},{getRegistry:()=>current,confirm:async()=>false});assert.equal(await cancel.rerunSeminar('s1',['b0','b1','b2']),false);
  const {model:changed}=await controller(t,async(url,body)=>{assert.equal(body,undefined);return record();},{getRegistry:()=>current,confirm:async()=>{current.agents[2].description+='改变';return true;}});
  assert.equal(await changed.rerunSeminar('s1',['b0','b1','b2']),false);assert.match(changed.snapshot().error,/变化/);
});
test('v011 add picker gets current participants; terminal continuation only prefills original question and ids',async t=>{
  const opened=[],pickers=[];const {model}=await controller(t,async(url,body)=>{assert.equal(body,undefined);return record();},{onJoint:value=>opened.push(value),onPicker:(value,ids)=>pickers.push({value,ids})});
  await model.openSeminarAddPicker('s1');assert.deepEqual(pickers[0].ids,['b0','b1','b2']);
  assert.equal(await model.continueSeminarInJoint('s1'),true);assert.deepEqual(opened,[{agentIds:['b0','b1','b2'],input:record().input,cli:'codex'}]);
});
test('v011 seminar picker reuses perspective component, books only, prechecked/deselectable, 3–8, no recommender call',async t=>{
  const {doc}=await appDocument();const submitted=[];const picker=mountPerspectivePicker(doc,{mode:'seminar',getRegistry:()=>registry,api:async()=>assert.fail('No recommendation job for explicit participants'),onRun:async(id,ids)=>{submitted.push({id,ids});return true;}});t.after(()=>picker.dispose());
  await picker.open(record(),undefined,['b0','b1','b2']);const all=doc.getElementById('seminar-all'),submit=doc.getElementById('seminar-submit');assert.ok(all);assert.equal(all.querySelector('[data-agent-id="role"]'),null);
  assert.equal(all.querySelectorAll('input').filter(n=>n.checked).length,3);let check=all.querySelector('[data-agent-id="b0"]');check.checked=false;await check.fire('change');assert.equal(submit.disabled,true);await submit.fire('click');assert.equal(submitted.length,0);
  for(const id of ['b0','b3','b4','b5','b6','b7']){check=all.querySelector(`[data-agent-id="${id}"]`);check.checked=true;await check.fire('change');}
  assert.equal(all.querySelector('[data-agent-id="b8"]').disabled,true);assert.match(doc.getElementById('seminar-count').textContent,/8.*3/);
  await submit.fire('click');assert.equal(submitted[0].ids.length,8);assert.equal(submitted[0].id,'s1');assert.equal(doc.getElementById('seminar-picker').open,false);
});
test('v011 picker can remove unavailable previous participants, search preserves selections, Escape restores focus',async t=>{
  const {doc}=await appDocument();const current=structuredClone(registry);current.agents[1].platforms.codex.available=false;current.agents=current.agents.filter(a=>a.id!=='b2');
  const picker=mountPerspectivePicker(doc,{mode:'seminar',getRegistry:()=>current,api:async()=>assert.fail('no API'),onRun:async()=>false});t.after(()=>picker.dispose());
  const trigger=doc.getElementById('refresh');trigger.focus();await picker.open(record(),trigger,['b0','b1','b2']);const all=doc.getElementById('seminar-all'),submit=doc.getElementById('seminar-submit');
  assert.equal(submit.disabled,true);for(const id of ['b1','b2']){const check=all.querySelector(`[data-agent-id="${id}"]`);assert.equal(check.disabled,false);check.checked=false;await check.fire('change');}
  const search=doc.getElementById('seminar-search');search.value='原书b3';await search.fire('input');assert.equal(all.querySelectorAll('input').length,1);const check=all.querySelector('input');check.checked=true;await check.fire('change');assert.match(doc.getElementById('seminar-count').textContent,/已选 2/);
  await doc.getElementById('seminar-picker').fire('keydown',{key:'Escape'});assert.equal(doc.activeElement,trigger);
  current.agents=structuredClone(registry.agents);await picker.open(record(),trigger,agents.slice(0,9).map(a=>a.id));assert.equal(submit.disabled,true,'over-eight initial lists cannot submit');
});

async function appFixture(t,ui){const {doc}=await appDocument(ui);safeDOM(doc);const requests=[],data={records:new Map([['s1',record()]]),list:listing(),concept:{conceptId:'c1',status:'done',agent:{id:'b0',name:'作者b0',title:'原书b0'},result:{concept:'能量：较长的原标题',conceptEn:'Old subtitle',term:terms[0],oneLine:'说明',markdown:'原讲解'},perspectives:[]}};
  const app=await mountApp(doc,async(url,opts={})=>{const body=opts.body?JSON.parse(opts.body):undefined;requests.push({url,body,opts});let value={items:[],unavailable:[]};
    if(url==='/api/registry')value=registry;else if(url==='/api/stats')value={perAgent:{},sources:[],limitedReasons:[]};else if(url==='/api/settings')value={ui:body?.ui||ui,recommend:{codex:{model:'fixture'}}};
    else if(url==='/api/seminars?limit=30')value=data.list;else if(url==='/api/seminars'){const id='new';value={seminarId:id};data.records.set(id,record(id,{status:'queued',result:null}));data.list=listing([data.records.get(id),record()],{seminarId:id,status:'queued'});}
    else if(url.startsWith('/api/seminars/'))value=data.records.get(url.split('/').at(-1));
    else if(url==='/api/concepts?limit=30')value={items:[data.concept],today:{conceptId:'c1'},running:null};else if(url==='/api/concepts/c1')value=data.concept;
    return{ok:true,json:async()=>structuredClone(value)};},{confirm:async()=>true});t.after(()=>app.dispose());return{doc,app,requests,data};}
// v0.40: 圆桌讨论 is a room of the shared chat page in every layout; the old per-layout seminar pages are gone.
for(const ui of Object.keys(layouts))test(`v040 ${ui}: 圆桌 opens as a chat-page room with the synthesis, author sheets, actions and preserved draft/folds`,async t=>{
  const h=await appFixture(t,ui);assert.equal(layouts[ui].renderSeminars,undefined);await h.doc.getElementById('seminars-open').fire('click');
  assert.equal(h.app.snapshot().state.view,'chat');assert.equal(h.app.snapshot().state.room,'seminars');
  const page=h.doc.getElementById('chat-panel'),main=page.querySelector('.room-main[data-room="seminars"]');assert.equal(page.hidden,false);assert.equal(main.hidden,false);
  assert.equal(h.doc.getElementById('chat-room-seminars').getAttribute('aria-current'),'page');assert.equal(h.doc.getElementById('room-side-seminars').hidden,false);
  for(const text of ['共同说明','全员一致','多数同意','理由b0','直接','立场甲','行动3','完整观点','核验','合成另存失败','Énergie','主持人综合'])assert.ok(main.textContent.includes(text),text);
  assert.ok(main.querySelector('.room-unanimous'));assert.ok(main.querySelector('.room-majority'));assert.equal(main.querySelectorAll('.room-author').length,3);
  // v0.53.12: a record saved before 原文回查 shows no source-check line, marks or quote titles.
  assert.ok(!main.textContent.includes('原文回查'));assert.ok(!main.textContent.includes('未在'));assert.equal(main.querySelector('.room-unverified'),null);
  assert.ok(main.querySelectorAll('small').every(s=>!s.getAttribute('title')));
  for(const name of ['openSeminars','startSeminar','selectSeminar','openSeminarAddPicker','rerunSeminar','continueSeminarInJoint','openRoom','newRoomRecord','sendFollowup'])assert.equal(typeof h.app.actions[name],'function',name);
  assert.deepEqual(h.app.snapshot().concepts.selected.term,terms[0]);assert.equal(h.app.snapshot().concepts.selected.result.markdown,'原讲解');
  const read=main.querySelector('.room-read');await read.fire('click');const sheet=read.parentElement;assert.match(sheet.className,/is-open/);
  await h.app.actions.refreshRunning();assert.match(sheet.className,/is-open/);assert.ok(sheet.isConnected);
  await h.doc.getElementById('room-seminars-add').fire('click');assert.ok(h.doc.getElementById('seminar-picker').className.includes(layouts[ui].jointBuilderSkin));assert.equal(h.doc.getElementById('seminar-all').querySelectorAll('input').filter(n=>n.checked).length,3);await h.doc.getElementById('seminar-close').fire('click');
  await h.doc.getElementById('room-seminars-continue').fire('click');assert.equal(h.doc.getElementById('builder-input').value,record().input);assert.deepEqual(h.app.snapshot().state.jointSelectedIds,['b0','b1','b2']);assert.equal(h.requests.filter(r=>r.url==='/api/joint').length,0);await h.doc.getElementById('builder-close').fire('click');
  await h.doc.getElementById('room-seminars-new').fire('click');const input=h.doc.getElementById('room-seminars-question');assert.equal(input.closest('[hidden]'),undefined);
  input.value='未提交草稿';await input.fire('input');await h.app.actions.refreshRunning();assert.equal(input.value,'未提交草稿');assert.ok(input.isConnected);
  await h.doc.getElementById('room-seminars-start').fire('click');const post=h.requests.find(r=>r.url==='/api/seminars'&&r.body);assert.deepEqual(post.body,{input:'未提交草稿'});assert.equal(post.opts.headers['X-Co-Agent-Token'],'synthetic-token');assert.equal(post.opts.method,'POST');assert.match(main.textContent,/排队中/);
  await h.app.actions.selectSeminar('s1');assert.equal(h.app.snapshot().chat.seminars.selected.seminarId,'s1');
  await h.app.actions.showView('catalog');assert.equal(page.hidden,true);assert.ok(!h.doc.getElementById('catalog').closest('[hidden]'));
});
test('v0.53.12 圆桌 synthesis marks quotes not found in the author\'s analysis, shows found quotes on hover and states the source check',async t=>{
  const h=await appFixture(t,'shelf'),quote=id=>`作者${id}原文里的一句话`,cite=(id,verified)=>({agent:`cli-${id}`,quote:quote(id),verified});
  const marked=record(),result=marked.result,[all,most]=result.commonAnswer.points;
  all.evidence=[cite('b0',true),cite('b1',false),cite('b2',false)];most.evidence=[cite('b0',true),cite('b1',true)];
  result.divergences[0].positions=[{agent:'cli-b0',view:'立场甲',quote:quote('b0'),verified:true},{agent:'cli-b1',view:'立场乙',quote:quote('b1'),verified:false}];
  for(const action of result.actions)action.evidence=[cite('b0',true),cite('b2',action.text==='行动1'?false:true)];
  result.sourceCheck={total:13,unverified:4};h.data.records.set('s1',marked);
  const clean=record('s2');clean.result.sourceCheck={total:13,unverified:0};h.data.records.set('s2',clean);
  await h.doc.getElementById('seminars-open').fire('click');const main=h.doc.querySelector('.room-main[data-room="seminars"]');
  assert.ok(main.textContent.includes('原文回查：综合引用的 13 处依据中有 4 处未在作者原文中找到，已逐条标出。'));
  const marks=main.querySelectorAll('.room-unverified');assert.equal(marks.length,2);
  assert.equal(marks[0].textContent,' · 未在「作者b1」、「作者b2」的原文中找到');assert.equal(marks[1].textContent,' · 未在「作者b2」的原文中找到');
  const titled=main.querySelectorAll('small').filter(s=>s.getAttribute('title'));
  assert.equal(titled[0].textContent,' · 支持：作者b0、作者b1、作者b2');assert.equal(titled[0].getAttribute('title'),'作者b0：「作者b0原文里的一句话」');
  assert.equal(titled[1].getAttribute('title'),'作者b0：「作者b0原文里的一句话」\n作者b1：「作者b1原文里的一句话」');
  assert.equal(titled[2].textContent,' · 依据：作者b0、作者b2');assert.equal(titled[2].getAttribute('title'),'作者b0：「作者b0原文里的一句话」');
  assert.equal(titled[3].getAttribute('title'),'作者b0：「作者b0原文里的一句话」\n作者b2：「作者b2原文里的一句话」');
  assert.ok(main.textContent.includes('作者b0：立场甲；作者b1：立场乙（未在原文中找到）'));
  await h.app.actions.selectSeminar('s2');
  assert.ok(main.textContent.includes('原文回查：综合引用的 13 处依据均见于作者原文。'));assert.equal(main.querySelector('.room-unverified'),null);
});
test('v040 switching layouts keeps the 圆桌 room, its draft and selection',async t=>{
  const h=await appFixture(t,'threepane');await h.app.actions.openSeminars();await h.app.actions.newRoomRecord('seminars');const input=h.doc.getElementById('room-seminars-question');input.value='保留问题';await input.fire('input');h.app.actions.openSettings();
  for(const radio of h.doc.querySelectorAll('[role="radio"]')){await radio.fire('click');assert.equal(h.doc.getElementById('room-seminars-question').value,'保留问题');assert.equal(h.app.snapshot().chat.seminars.selected.seminarId,'s1');assert.equal(h.doc.querySelectorAll('[id="chat-panel"]').length,1);assert.equal(h.app.snapshot().state.room,'seminars');}
});
test('v040 failed 圆桌 records expose retry without inventing consensus, escaped content stays literal',async t=>{
  const h=await appFixture(t,'bento');h.data.records.set('bad',record('bad',{status:'failed',error:'<img onerror=x>',result:null}));h.data.list=listing([h.data.records.get('bad')]);await h.app.actions.selectSeminar('bad');await h.app.actions.openSeminars();
  const main=h.doc.querySelector('.room-main[data-room="seminars"]');assert.match(main.textContent,/<img onerror=x>/);assert.equal(main.querySelector('img'),null);assert.ok(h.doc.getElementById('room-seminars-retry'));assert.equal(main.querySelector('.room-unanimous'),null);
  await h.doc.getElementById('room-seminars-retry').fire('click');assert.deepEqual(h.requests.find(r=>r.url==='/api/seminars'&&r.body).body,{input:record().input});
});
test('v011 stage/time labels use server evidence and preserve unknowns',async()=>{
  const {seminarStatus}=await import('../public/seminars.js');const start='2026-10-08T01:00:00Z';
  assert.match(seminarStatus({status:'running',startedAt:start,stage:'analyzing'},Date.parse(start)+62000),/分析中.*1 分 2 秒|1 分 2 秒.*分析中/);
  assert.match(seminarStatus({status:'running'}),/用时未知.*阶段未确认|阶段未确认.*用时未知/);
  assert.match(seminarStatus({status:'running',stage:'synthesizing'}),/综合中/);
});
test('v011 new module has no unsafe DOM/network/process surface; v0.40 rooms page neither',async()=>{
  for(const file of ['public/seminars.js','public/rooms-page.js','public/followups.js'])assert.doesNotMatch(await fs.readFile(file,'utf8'),/innerHTML|setAttribute\(['"]style|child_process|window\.open|https?:\/\//,file);
  for(const ui of Object.keys(layouts))assert.equal(layouts[ui].renderSeminars,undefined);
});
