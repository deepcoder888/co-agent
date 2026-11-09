import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp, toAgentView, toDetailView } from '../public/app.js';

const file=(index,label,exists=true)=>({index,label,path:`D:\\fixture\\${label}.epub`,ext:'epub',exists});
const member=(id,kind='book',bookFiles=[])=>({id,name:`Name-${id}`,kind,primary:'测试分类',description:'用途说明',purpose:kind==='role'?'检查证据':null,
  book:kind==='book'?{title:`Title-${id}`,author:'作者',edition:'测试版'}:null,bookFiles,definitionFile:kind==='role'?{path:'D:\\fixture\\role.toml',exists:true}:null,
  tags:[],platforms:{claude:{available:true},codex:{available:true}},permissions:{},sources:{checked:true,missing:[]},sync:{state:'同步'}});
const agents=[member('one','book',[file(7,'Book-one')]),member('many','book',[file(2,'Book-A'),file(9,'Book-B',false)]),member('none'),member('role','role')];
const registry={agents,categories:['测试分类'],summary:{roles:1,books:3,synced:4},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const bucket={calls:1,ok:1,failed:0,unknown:0,bySource:{claude:1,codex:0}};
const stats={perAgent:Object.fromEntries(agents.map(a=>[a.id,{last7d:bucket,last30d:bucket,total:bucket,launches:{last7d:0,total:0},lastAt:null}])),sources:[{available:true,failedFiles:[],scannedFiles:1}],daily:[],limited:false,limitedReasons:[]};
const concept={conceptId:'c1',day:'2026-10-08',status:'done',agent:{id:'one',name:'Name-one',title:'Title-one'},result:{concept:'概念',oneLine:'说明',whyUnknown:'原因',sourceRefs:[],markdown:'正文'},verify:{state:'ok',skillStructure:{state:'ok',missing:[]}},perspectives:[{runId:'p1',status:'done',agents:[{id:'many',name:'Name-many'}],results:[{agentId:'many',name:'Name-many',analysis:'分析'}],verify:{state:'ok',parallel:true,violations:[]}}]};
const history={items:[{type:'joint',id:'j1',createdAt:'2026-10-08T10:00:00Z',agents:[agents[0],agents[1]],cli:'codex',source:'manual',mode:'joint',inputPreview:'输入',status:{overall:'ready'},canResume:false}],unavailable:[]};
const running={items:[{type:'launch',launchId:'l1',agentName:'Name-one',cli:'codex',createdAt:'2026-10-08T10:00:00Z',status:{overall:'pending'}},{type:'joint',jointId:'j1',cli:'codex',whitelist:[{id:'one',name:'Name-one'},{id:'many',name:'Name-many'}],createdAt:'2026-10-08T10:00:00Z',status:{overall:'pending'}}]};

// Recording DOM has no propagation engine; explicitly model capture -> target -> bubble
// here so a test cannot mistake stopPropagation in a bubble listener for capture.
function events(doc){
  const listeners=[],add=doc.addEventListener,remove=doc.removeEventListener;
  doc.addEventListener=(type,fn,options)=>{listeners.push({type,fn,capture:options===true||options?.capture===true});add(type,fn,options);};
  doc.removeEventListener=(type,fn,options)=>{const at=listeners.findIndex(x=>x.type===type&&x.fn===fn);if(at>=0)listeners.splice(at,1);remove(type,fn,options);};
  return {listeners,async dispatch(type,target,extra={}){
    let stopped=false;const event={type,target,button:0,clientX:240,clientY:160,...extra,defaultPrevented:false,
      preventDefault(){this.defaultPrevented=true;},stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;}};
    for(const l of [...listeners].filter(l=>l.type===type&&l.capture)){await l.fn(event);if(stopped)break;}
    if(!stopped){for(let el=target;el;el=el.parentElement){await el.fire(type,event);if(stopped)break;}}
    if(!stopped)for(const l of [...listeners].filter(l=>l.type===type&&!l.capture))await l.fn(event);
    return event;
  }};
}
function safeDOM(doc){const create=doc.createElement;doc.createElement=tag=>{const n=create(tag),set=n.setAttribute.bind(n);n.setAttribute=(key,value)=>{assert.notEqual(key,'style');set(key,value);};Object.defineProperty(n,'innerHTML',{set(){assert.fail('HTML injection');}});return n;};doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};return doc;}
async function controller(t){
  const {mountAgentLinks,markAgentLink}=await import('../public/agent-links.js');const doc=safeDOM(documentFrom('<body></body>')),event=events(doc),requests=[],data={fail:null};
  doc.defaultView={innerWidth:640,innerHeight:480};
  const control=mountAgentLinks(doc,{getRegistry:()=>registry,api:async(url,body)=>{requests.push({url,body});if(data.wait)await data.wait;if(data.fail)throw data.fail;return{};}});t.after(()=>control.dispose());
  const link=(id,tag='button')=>{const el=markAgentLink(doc.createElement(tag),agents.find(a=>a.id===id));el.textContent=id;doc.body.append(el);control.refresh();return el;};
  return{doc,...event,control,link,requests,data};
}
test('v010 capture intercepts Ctrl/Meta click and Ctrl Enter before ordinary handlers; plain clicks survive',async t=>{
  const h=await controller(t),link=h.link('one'),child=h.doc.createElement('strong');link.append(child);let ordinary=0;link.addEventListener('click',()=>ordinary++);
  assert.ok(h.listeners.some(l=>l.type==='click'&&l.capture));assert.ok(h.listeners.some(l=>l.type==='keydown'&&l.capture));
  await h.dispatch('click',child);assert.equal(ordinary,1);assert.equal(h.requests.length,0);
  for(const extra of [{ctrlKey:true},{metaKey:true}]){const e=await h.dispatch('click',child,extra);assert.equal(e.defaultPrevented,true);}
  link.focus();await h.dispatch('keydown',link,{key:'Enter',ctrlKey:true});assert.equal(ordinary,1);assert.equal(h.requests.length,3);
  assert.deepEqual(h.requests[0],{url:'/api/open',body:{agentId:'one',target:'book',index:7}});assert.match(h.doc.getElementById('agent-open-status').textContent,/已用默认程序打开《Book-one》/);
});
test('v010 role, absent book metadata, unknown agents, repeated keydown and plain keyboard do not guess paths',async t=>{
  const h=await controller(t);await h.dispatch('click',h.link('role'),{ctrlKey:true});assert.deepEqual(h.requests[0].body,{agentId:'role',target:'definition'});
  await h.dispatch('click',h.link('none'),{ctrlKey:true});assert.match(h.doc.getElementById('agent-open-status').textContent,/这个 Agent 没有登记原书文件/);
  const other=h.doc.createElement('span');other.setAttribute('data-agent-link','not-registered');h.doc.body.append(other);await h.dispatch('click',other,{ctrlKey:true});
  await h.dispatch('keydown',h.link('one'),{key:'Enter',ctrlKey:true,repeat:true});await h.dispatch('keydown',other,{key:'Enter'});assert.equal(h.requests.length,1);
});
test('v010 multiple files use supplied indexes, pointer menu, arrows/Home/End/Enter and Escape/outside close',async t=>{
  const h=await controller(t),link=h.link('many');link.focus();await h.dispatch('click',link,{ctrlKey:true});
  const menu=h.doc.getElementById('agent-book-menu'),items=menu.querySelectorAll('[role="menuitem"]');assert.equal(menu.getAttribute('role'),'menu');assert.equal(items.length,2);assert.equal(h.requests.length,0);
  assert.equal(menu.style.getPropertyValue('left'),'240px');assert.ok(h.doc.activeElement===items[0]);
  await h.dispatch('keydown',items[0],{key:'ArrowUp'});assert.ok(h.doc.activeElement===items[1]);await h.dispatch('keydown',items[1],{key:'Home'});assert.ok(h.doc.activeElement===items[0]);
  await h.dispatch('keydown',items[0],{key:'End'});await h.dispatch('keydown',items[1],{key:'Enter'});assert.deepEqual(h.requests[0].body,{agentId:'many',target:'book',index:9});assert.equal(menu.hidden,true);
  await h.dispatch('click',link,{ctrlKey:true});await h.dispatch('keydown',h.doc.activeElement,{key:'Escape'});assert.equal(menu.hidden,true);assert.ok(h.doc.activeElement===link);
  await h.dispatch('click',link,{ctrlKey:true});const outside=h.doc.createElement('button');h.doc.body.append(outside);let clicks=0;outside.addEventListener('click',()=>clicks++);await h.dispatch('click',outside);assert.equal(menu.hidden,true);assert.equal(clicks,1);
});
test('v010 failure paths are literal, reveal is token/API-only, and missing folders never get a reveal action',async t=>{
  const h=await controller(t);h.data.fail=Object.assign(new Error('原书文件不存在'),{status:404,data:{path:'D:\\<img onerror=x>.epub',folderExists:true}});
  await h.dispatch('click',h.link('one'),{ctrlKey:true});const toast=h.doc.getElementById('agent-open-status');assert.equal(toast.getAttribute('role'),'status');assert.match(toast.textContent,/原书文件不存在：D:\\<img/);assert.equal(toast.querySelector('img'),null);
  const reveal=toast.querySelector('button');assert.equal(reveal.textContent,'打开所在文件夹');h.data.fail=null;await reveal.fire('click');assert.deepEqual(h.requests.at(-1).body,{agentId:'one',target:'book',index:7,reveal:true});
  h.data.fail=Object.assign(new Error('原书文件不存在'),{status:404,data:{path:'D:\\missing.epub',folderExists:false}});await h.dispatch('click',h.link('one'),{ctrlKey:true});assert.equal(toast.querySelector('button'),null);
  h.data.fail=new Error('读取失败');await h.dispatch('click',h.link('role'),{ctrlKey:true});assert.match(toast.textContent,/读取失败/);
});
test('v010 menu and toast work inside modal candidates, titles append once, keyboard anchor uses CSSOM',async t=>{
  const h=await controller(t),dialog=h.doc.createElement('dialog');h.doc.body.append(dialog);dialog.showModal();const link=h.link('many','span');dialog.append(link);link.title='完整书名';link.getBoundingClientRect=()=>({left:40,bottom:80});h.control.refresh();h.control.refresh();
  assert.equal(link.title,'完整书名\nCtrl+单击打开原书');assert.equal(link.getAttribute('tabindex'),'0');await h.dispatch('keydown',link,{key:'Enter',ctrlKey:true});
  const menu=h.doc.getElementById('agent-book-menu');assert.ok(dialog.contains(menu));assert.equal(menu.style.getPropertyValue('left'),'40px');assert.equal(menu.style.getPropertyValue('top'),'80px');
  await menu.querySelector('[role="menuitem"]').fire('click');assert.ok(dialog.contains(h.doc.getElementById('agent-open-status')));
});
test('v010 disposal removes capture listeners and late opener responses cannot mutate UI',async t=>{
  const h=await controller(t);let resolve;h.data.wait=new Promise(done=>resolve=done);
  const pending=h.dispatch('click',h.link('one'),{ctrlKey:true});assert.equal(h.requests.length,1);
  await h.dispatch('click',h.link('role'),{ctrlKey:true});assert.equal(h.requests.length,1,'no duplicate request while opening');
  h.control.dispose();assert.ok(!h.listeners.some(l=>l.capture));resolve();await pending;
  assert.equal(h.doc.getElementById('agent-open-status') == null,true);
  await h.dispatch('click',h.link('one'),{ctrlKey:true});assert.equal(h.requests.length,1);
});

test('v010 polling replaces anchors without dismissing a focused menu; Escape restores the replacement',async t=>{
  const h=await controller(t),button=h.link('many');button.setAttribute('data-focus-key','catalog-many');
  const label=h.doc.createElement('strong');label.setAttribute('data-agent-link','many');button.append(label);
  await h.dispatch('click',label,{ctrlKey:true});const menu=h.doc.getElementById('agent-book-menu'),focused=h.doc.activeElement;
  button.remove();const replacement=h.doc.createElement('button');replacement.setAttribute('data-agent-link','many');replacement.setAttribute('data-focus-key','catalog-many');h.doc.body.append(replacement);h.control.refresh();
  assert.equal(menu.hidden,false);assert.ok(h.doc.activeElement===focused);
  await h.dispatch('keydown',focused,{key:'Escape'});assert.ok(h.doc.activeElement===replacement);
});

test('v010 running/detail text anchors survive polling and preserve inherited full hover titles',async t=>{
  const h=await controller(t),section=h.doc.createElement('section');section.id='running-list';h.doc.body.append(section);
  const link=h.link('many','span');link.title='完整的两本原书';section.append(link);
  const child=h.doc.createElement('strong');child.setAttribute('data-agent-link','many');link.append(child);h.control.refresh();
  assert.equal(child.title,'完整的两本原书\nCtrl+单击打开原书');
  await h.dispatch('click',link,{ctrlKey:true});const focused=h.doc.activeElement;
  section.replaceChildren();const replacement=h.doc.createElement('span');replacement.setAttribute('data-agent-link','many');section.append(replacement);h.control.refresh();
  assert.equal(h.doc.getElementById('agent-book-menu').hidden,false);
  await h.dispatch('keydown',focused,{key:'Escape'});assert.ok(h.doc.activeElement===replacement);
});

test('v010 popup clamps to viewport; Tab and Space work; missing files are still requested',async t=>{
  const h=await controller(t),link=h.link('many');await h.dispatch('click',link,{metaKey:true,clientX:900,clientY:-10});
  const menu=h.doc.getElementById('agent-book-menu');assert.equal(menu.style.getPropertyValue('left'),'616px');assert.equal(menu.style.getPropertyValue('top'),'8px');
  const tab=await h.dispatch('keydown',h.doc.activeElement,{key:'Tab'});assert.equal(menu.hidden,true);assert.equal(tab.defaultPrevented,false);
  await h.dispatch('keydown',link,{key:'Enter',metaKey:true});await h.dispatch('keydown',h.doc.activeElement,{key:'ArrowDown'});
  await h.dispatch('keydown',h.doc.activeElement,{key:' '});assert.deepEqual(h.requests.at(-1).body,{agentId:'many',target:'book',index:9});
});

async function appFixture(t,ui,registryValue=registry){const {doc}=await appDocument(ui);safeDOM(doc);const event=events(doc),requests=[];
  const app=await mountApp(doc,async(url,opts={})=>{const body=opts.body?JSON.parse(opts.body):undefined;requests.push({url,body,opts});let value={items:[],unavailable:[]};
    if(url==='/api/registry'||url==='/api/refresh')value=registryValue;else if(url==='/api/stats')value=stats;else if(url==='/api/settings')value={ui:body?.ui||ui,recommend:{codex:{model:'fixture'}}};
    else if(url.startsWith('/api/history?'))value=history;else if(url==='/api/running')value=running;else if(url==='/api/concepts?limit=30')value={items:[concept],today:{conceptId:'c1',status:'done'},running:null};else if(url==='/api/concepts/c1')value=concept;
    else if(url==='/api/recommend')value={recommendId:'r1'};else if(url==='/api/recommend/r1')value={status:'done',results:[{id:'one',reason:'理由'},{id:'many',reason:'理由'}]};
    return{ok:true,json:async()=>structuredClone(value)};},{confirm:async()=>true});t.after(()=>app.dispose());return{doc,app,requests,...event};}
function markedNames(root,surface){
  let checked=0;
  for(const n of descendants(root)){if(['PRE','CODE','TEXT','TEXTAREA','INPUT','OPTION'].includes(n.tagName)||n.closest('.chart-data'))continue;
    for(const agent of agents){if([agent.name,agent.book?.title].filter(Boolean).some(text=>n._text?.includes(text))){assert.equal(n.closest('[data-agent-link]')?.getAttribute('data-agent-link'),agent.id,`${surface}: ${n.tagName} ${n._text}`);checked++;}}
  }
  assert.ok(checked>0,`${surface}: no name rendered`);
}
for(const ui of ['threepane','bento','editorial','shelf'])test(`v010 ${ui}: every structured name surface, details buttons, token and ordinary selection`,async t=>{
  const h=await appFixture(t,ui);h.app.actions.selectCategory('all');markedNames(h.doc.getElementById('catalog'),`${ui} catalog`);
  await h.app.actions.openDetail('one');markedNames(h.doc.getElementById('detail-body'),`${ui} details`);assert.equal(h.app.snapshot().detail.bookFiles[0].index,7);
  const open=h.doc.querySelector('[data-open-agent="one"]');assert.ok(open);assert.equal(open.textContent,'打开原书');await open.fire('click');
  // v0.41: the book opens in the app's reading mode; 「用系统程序打开」 there still asks the server to open it.
  assert.equal(h.doc.getElementById('book-reader').open,true);assert.ok(h.requests.some(r=>r.url==='/api/books/one/0'));assert.equal(h.requests.some(r=>r.url==='/api/open'),false);
  await h.doc.getElementById('book-reader-external').fire('click');const req=h.requests.find(r=>r.url==='/api/open');h.doc.getElementById('book-reader').close();assert.ok(req);assert.equal(req.opts.headers['X-Co-Agent-Token'],'synthetic-token');assert.equal(req.opts.method,'POST');assert.equal('path' in req.body,false);
  await h.app.actions.openDetail('role');const definition=h.doc.querySelector('[data-open-agent="role"]');assert.equal(definition.textContent,'打开定义文件');assert.equal(definition.disabled===true,false);
  await h.app.actions.showView('history');markedNames(h.doc.getElementById('history-list'),`${ui} history`);
  await h.app.actions.selectHistory('joint','j1');markedNames(h.doc.getElementById('detail-body'),`${ui} history detail`);h.app.actions.closeDetail();
  await h.app.actions.showView('running');markedNames(h.doc.getElementById('running-list'),`${ui} running`);
  h.app.actions.setRecommendInput('问题');await h.app.actions.recommend();await h.app.actions.showView('recommend');markedNames(h.doc.getElementById('recommend-results'),`${ui} recommend`);
  h.app.actions.openJoint([]);markedNames(h.doc.getElementById('builder-results'),`${ui} joint`);
  const candidate=h.doc.getElementById('builder-results').querySelector('[data-agent-link="one"]'),subtitle=candidate.querySelector('.builder-subtitle');
  assert.match(subtitle.getAttribute('title'),/Title-one.*\nCtrl\+单击打开原书/);
  const checkbox=candidate.closest('label').querySelector('input'),checked=checkbox.checked;
  const modified=await h.dispatch('click',candidate,{ctrlKey:true});assert.equal(modified.defaultPrevented,true);assert.equal(checkbox.checked,checked);assert.deepEqual(h.app.snapshot().state.jointSelectedIds,[]);
  await h.doc.getElementById('builder-close').fire('click');
  await h.app.actions.openConcepts();markedNames(h.doc.getElementById('concepts-panel'),`${ui} concepts`);await h.app.actions.openPerspectivePicker('c1');markedNames(h.doc.getElementById('perspective-all'),`${ui} perspectives`);await h.doc.getElementById('perspective-close').fire('click');
  await h.app.actions.openStats();markedNames(h.doc.querySelector('.chart-bar-list'),`${ui} stats`);
  h.app.actions.selectCategory('all');const link=h.doc.getElementById('catalog').querySelector('[data-focus-key="card-detail-one"]');const before=h.app.snapshot().state.selectedId,opens=h.requests.filter(r=>r.url==='/api/open').length;
  await h.dispatch('click',link,{ctrlKey:true});assert.equal(h.app.snapshot().state.selectedId,before);assert.equal(h.requests.filter(r=>r.url==='/api/open').length,opens+1);
  await h.dispatch('click',link);assert.equal(h.app.snapshot().state.selectedId,'one');assert.equal(h.app.snapshot().state.detailOpen,true);assert.equal(h.requests.filter(r=>r.url==='/api/open').length,opens+1);
  // v0.41: 「打开原书」 reads in the app; Ctrl+click on a book's name still offers its files for the system program.
  await h.app.actions.openDetail('many');await h.dispatch('click',h.doc.getElementById('catalog').querySelector('[data-focus-key="card-detail-many"]'),{ctrlKey:true});
  const menu=h.doc.getElementById('agent-book-menu');assert.equal(menu.hidden,false);assert.equal(menu.querySelectorAll('[role="menuitem"]').length,2);
  await h.dispatch('keydown',h.doc.activeElement,{key:'Escape'});assert.equal(h.app.snapshot().state.detailOpen,true,'Escape closes only the file menu');
  await h.app.actions.openDetail('none');await h.dispatch('click',h.doc.getElementById('catalog').querySelector('[data-focus-key="card-detail-none"]'),{ctrlKey:true});assert.match(h.doc.getElementById('agent-open-status').textContent,/没有登记原书文件/);
  await h.doc.querySelector('[data-open-agent="none"]').fire('click');assert.match(h.doc.getElementById('book-reader').textContent,/没有能在软件里阅读的 EPUB 或 PDF/);h.doc.getElementById('book-reader').close();
});

test('v010 editorial focus feature retains its exact prose with individually linked names',async t=>{
  const ids=['walvo','jadra','rusko'],extra=ids.map(id=>({...member(id),name:id[0].toUpperCase()+id.slice(1)}));
  const h=await appFixture(t,'editorial',{...registry,agents:[...agents,...extra],display: { shelfOrder: [], featured: { members: [{ id: 'walvo', label: 'Walvo' }, { id: 'jadra', label: 'Jadra' }, { id: 'rusko', label: 'Rusko' }], title: ['一个示例问题，', '请三位作者坐下来谈谈。'], text: '从三个示例角度回答同一个问题。一次联合调用，三份并排的回答。' } }});
  const copy=h.doc.querySelector('.focus-copy');assert.equal(copy.textContent,'Walvo、Jadra 与 Rusko 从三个示例角度回答同一个问题。一次联合调用，三份并排的回答。');
  assert.deepEqual(copy.querySelectorAll('[data-agent-link]').map(el=>el.getAttribute('data-agent-link')),ids);
});

test('v010 ambiguous running names never acquire a guessed identity',async t=>{
  const duplicate={...agents[0],id:'duplicate'};const h=await appFixture(t,'bento',{...registry,agents:[...agents,duplicate]});
  assert.equal(h.app.snapshot().running[0].agentId,null);
});
test('v010 new frontend has no opener process, external fetch, HTML or inline-style sinks',async()=>{
  const source=await fs.readFile('public/agent-links.js','utf8');assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|setAttribute\(['"]style|child_process|explorer\.exe|window\.open|https?:\/\//);
  const view=toDetailView(toAgentView(agents[3]),{items:[]});assert.deepEqual(view.definitionFile,agents[3].definitionFile);
});
