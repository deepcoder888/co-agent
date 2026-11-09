import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import { layouts, mountLayouts } from '../public/layouts/index.js';
import { createWorkflows } from '../public/workflows.js';
import { createCallHistory } from '../public/calls.js';

const categoryNames=['睡眠／健康／运动','投资／金融与金钱管理',...Array.from({length:9},(_,i)=>`分类${i}`)];
const member=(id,kind,primary)=>({id,name:id,kind,primary,description:'首段\n\n<example>例子</example>',tags:[],book:kind==='book'?{title:'*Dear Sample: Science*',author:'甲、乙、丙',edition:'2023'}:null,
  platforms:{claude:{available:true,file:'synthetic.md'},codex:{available:true}},permissions:{claude:{model:'sonnet',effort:'high'}},sources:{checked:true,total:1,missing:[]},sync:{state:'同步',detail:'ok'}});
const agents=[member('Peter','role','功能性 Agent'),member('Walvo','book',categoryNames[0]),member('Jadra','book',categoryNames[0]),member('Granto','book',categoryNames[1])];
const registry={agents,categories:categoryNames,summary:{roles:1,books:3,synced:4},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[],scannedAt:'2026-10-07T00:00:00Z'};
const counts=n=>({last7d:{calls:n,bySource:{claude:n,codex:0}},total:{calls:n*2,bySource:{claude:n*2,codex:0}}});
const stats={perAgent:Object.fromEntries(agents.map((a,i)=>[a.id,counts(i+1)])),sources:[{available:true,id:'fixture',failedFiles:[]}],limited:true,limitedReasons:['合成限制']};
const record={type:'joint',id:'j1',agents:[{id:'Walvo',name:'Walvo'}],cli:'codex',source:'manual',createdAt:'2026-10-07T00:00:00Z',inputPreview:'问题',status:{overall:'done'},canResume:false,resumeReason:'会话文件不存在'};
async function fixture(t,ui='threepane'){
  const {doc,ids}=await appDocument(ui),calls=[];
  const app=await mountApp(doc,async(url,options)=>{calls.push({url,options});const value=url==='/api/registry'||url==='/api/refresh'?registry:url==='/api/stats'?stats:
    url==='/api/settings'?{ui:options?JSON.parse(options.body).ui:ui,recommend:{claude:{model:'sonnet',effort:'high'},codex:{model:'gpt-test',effort:'xhigh'}}}:
    url.startsWith('/api/history?')?{items:[record]}:{items:[],unavailable:[]};return{ok:true,json:async()=>value};},{confirm:async()=>true});
  t.after(()=>app.dispose());return{doc,ids,app,calls};
}
const methods=['render','renderCategories','renderCatalog','renderDetail','renderMetrics','renderHistory','renderRunning','renderCoverage','renderRecommend'];
const requiredActions=['launch','resume','openDetail','selectCategory','search','openJoint','addToJoint','recommend','rerun','resumeHistory','setHistoryFilter','openSettings','refresh'];
for(const ui of Object.keys(layouts))test(`P1 ${ui}: index dispatches every section and module owns fresh DOM`,async t=>{
  const {doc,app}=await fixture(t,ui),seen=[];
  const modules=Object.fromEntries(Object.entries(layouts).map(([id,mod])=>[id,{...mod,...Object.fromEntries(methods.map(method=>[method,(ctx,...args)=>{seen.push(`${id}:${method}`);return mod[method](ctx,...args);}]))}]));
  const dispatcher=mountLayouts(doc,app.actions,{modules});dispatcher.update(app.snapshot());
  for(const method of methods)assert.ok(seen.includes(`${ui}:${method}`),method);
  for(const name of requiredActions)assert.equal(typeof dispatcher.context.actions[name],'function',name);
  assert.ok(doc.getElementById('joint-builder').className.includes(layouts[ui].jointBuilderSkin));
  const oldRoot=dispatcher.context.root;dispatcher.set(ui);assert.equal(oldRoot.isConnected,false);
  assert.notEqual(dispatcher.context.root,oldRoot);assert.ok(dispatcher.context.root.isConnected);
  assert.equal(doc.querySelectorAll('[id="search"]').length,1);
});
for(const ui of Object.keys(layouts))test(`P1 ${ui}: H4 removals and H5 selected row/detail consistency`,async t=>{
  const {doc,ids,app}=await fixture(t,ui);
  app.actions.selectCategory('role');assert.equal(app.snapshot().detail.id,'Peter');
  app.actions.selectCategory(categoryNames[0]);
  assert.equal(app.snapshot().catalog.selectedId,'Walvo');assert.equal(app.snapshot().detail.id,'Walvo');
  assert.equal(ids['detail-title'].textContent,'Walvo');
  await app.actions.openDetail('Jadra');app.actions.selectCategory(categoryNames[0]);assert.equal(app.snapshot().detail.id,'Jadra');
  app.actions.selectCategory(categoryNames[1]);assert.equal(app.snapshot().detail.id,'Granto');
  app.actions.search('不存在');assert.equal(app.snapshot().detail,null);assert.equal(app.snapshot().catalog.selectedId,null);assert.equal(ids['detail-body'].textContent,'');
  app.actions.search('');assert.equal(app.snapshot().detail.id,'Granto');
  const categories=app.snapshot().categories;assert.equal(categories.length,13);
  assert.ok(categories.every(c=>Object.keys(c).sort().join(',')==='count,fullLabel,key,label,selected'));
  assert.equal(ids.navigation.querySelectorAll('details').length,0);assert.equal(ids.navigation.querySelectorAll('svg').filter(n=>n.parentElement.className!=='shelf-chevron').length,0);
  assert.doesNotMatch(ids.navigation.textContent,/7 天|暂无数据/);
  assert.equal(ids['search-control'].textContent,'');assert.match(ids.search.getAttribute('aria-label'),/全局搜索/);assert.equal(ids.search.getAttribute('title'),'/ 或 Ctrl+K');
  assert.ok(ids.refresh.closest('#settings-dialog'));assert.match(ids['settings-last-scan'].textContent,/2026-10-07/);
  assert.equal(doc.getElementById('layout-root').querySelectorAll('.limited').length,0);
  assert.doesNotMatch(ids.brand.textContent,/v0\.7/);
});
test('P1 rich view models cover all four P2 specifications with honest unknowns',async t=>{
  const {app}=await fixture(t);app.actions.selectCategory(categoryNames[0]);const m=app.snapshot(),agent=m.catalog.agents[0];
  for(const key of ['id','kind','name','purpose','bookLabel','spineTitle','authorShort','summary','categoryShort','avatarColor','platforms','writable','sourcesOk','sync','stats7','statsTotal','canResume','resumeReason'])assert.ok(Object.hasOwn(agent,key),key);
  assert.equal(agent.stats7,2);assert.equal(agent.statsTotal,4);assert.equal(agent.summary,'首段');
  assert.equal(m.detail.fullDescription,agents[1].description);assert.ok(m.detail.chips.length);assert.ok(m.detail.sections.some(s=>s.key==='sources'));
  assert.equal(m.detail.meta.category,categoryNames[0]);assert.equal(m.detail.meta.claudeModel,'sonnet');assert.equal(m.detail.meta.claudeEffort,'high');
  assert.equal(m.detail.meta.terminalDisplay,null);assert.equal(m.detail.meta.terminalWindowMode,null);assert.match(m.detail.meta.terminalReason,/未提供/);
  for(const key of ['type','id','createdAt','cli','agents','source','inputPreview','status','canResume','resumeReason'])assert.ok(Object.hasOwn(m.history.items[0],key),key);
  assert.deepEqual(m.metrics.recentByKind,{role:1,book:9});assert.equal(m.metrics.recent7,10);assert.deepEqual(m.metrics.sync,{ok:4,total:4});
  assert.deepEqual(m.metrics.scopeReasons,['合成限制']);assert.equal(m.metrics.top[0].name,'Granto');
  assert.equal(m.state.allAgents.length,4);assert.ok(Date.parse(m.state.date));
});
test('P1 switching preserves drafts, selection, history filter and search without re-fetch or reload',async t=>{
  const {doc,app,calls}=await fixture(t);app.actions.selectCategory(categoryNames[0]);await app.actions.openDetail('Jadra');app.actions.search('Jadra');
  app.actions.setRecommendInput('尚未发送');app.actions.setRecommendEngine('codex');app.actions.addToJoint('Walvo',undefined,false);
  await app.actions.setHistoryFilter('joint');app.actions.openSettings();
  for(const radio of doc.querySelectorAll('[role="radio"]')){await radio.fire('click');const m=app.snapshot();
    assert.equal(m.catalog.selectedId,'Jadra');assert.equal(m.detail.id,'Jadra');assert.equal(m.catalog.query,'Jadra');assert.equal(m.state.category,categoryNames[0]);
    assert.equal(m.recommend.input,'尚未发送');assert.equal(m.recommend.engine,'codex');assert.equal(m.history.filter,'joint');assert.deepEqual(m.state.jointSelectedIds,['Walvo']);}
  assert.equal(calls.filter(c=>c.url==='/api/registry').length,1);assert.equal(calls.filter(c=>c.url==='/api/recommend').length,0);
  app.actions.openJoint([]);assert.deepEqual(app.snapshot().state.jointSelectedIds,[]);
  app.actions.openJoint(['Jadra']);assert.deepEqual(app.snapshot().state.jointSelectedIds,['Jadra']);
});
test('P1 scope and CSS are isolated, all four sheets linked locally, shared controller has no layout branches',async()=>{
  const css=await fs.readFile('public/styles.css','utf8'),html=await fs.readFile('public/index.html','utf8');
  assert.doesNotMatch(css,/\[data-ui\s*=/);assert.doesNotMatch(css,/\.layout-|\.mail-|\.bento-|\.editorial-|\.shelf-/);
  for(const id of Object.keys(layouts)){
    assert.ok(html.includes(`href="/layouts/${id}.css"`));const css=await fs.readFile(`public/layouts/${id}.css`,'utf8');
    assert.match(css,new RegExp(`\\[data-ui="${id}"\\]`));assert.doesNotMatch(css,/@import|https?:/);
    for(const other of Object.keys(layouts).filter(x=>x!==id))assert.ok(!css.includes(`[data-ui="${other}"]`));
    const js=await fs.readFile(`public/layouts/${id}.js`,'utf8');assert.doesNotMatch(js,/\bfetch\(|\.\.\/layouts\/|from ['"]\.\/(?:threepane|bento|editorial|shelf)/);
  }
  const index=await fs.readFile('public/layouts/index.js','utf8');assert.doesNotMatch(index,/current\s*===|layout\s*===|parts\./);
  assert.doesNotMatch(await fs.readFile('public/app.js','utf8'),/createElement|location\.reload|layout\.current\s*===/);
});
test('P1 headless workflow ignores stale recommendation response and freezes joint approval snapshot',async t=>{
  let release,approved;const calls=[];const workflow=createWorkflows({api:async(url,body)=>{calls.push({url,body});if(url==='/api/recommend')return{recommendId:'r'};
    if(url==='/api/recommend/r')return{recommendId:'r',status:'done',results:[agents[0]],audit:{ok:true}};
    if(url==='/api/recommend/stale')return new Promise(r=>release=r);return{items:[]};},getRegistry:()=>registry,permissionText:()=>'',error:()=>{},confirm:()=>new Promise(r=>approved=r)});
  t.after(()=>workflow.dispose());workflow.setInput('问题');await workflow.recommend();workflow.select('Peter',true);
  // Add a writable declaration only in the synthetic registry during this bounded test.
  agents[0].writable=true;const pending=workflow.launchJoint();workflow.setCli('codex');workflow.select('Peter',false);
  approved(true);await pending;agents[0].writable=false;
  assert.deepEqual(calls.find(c=>c.url==='/api/joint').body,{recommendId:'r',agentIds:['Peter'],cli:'codex',writableConfirmed:true});
  const stale=workflow.selectRecommendation('stale');workflow.dispose();release({status:'done',results:[agents[1]]});await stale;
  assert.equal(workflow.snapshot().recommendation,undefined);
});
test('P1 history controller discards out-of-order filter responses; unavailable resume never posts',async()=>{
  let resolveOld;const calls=[];const history=createCallHistory({api:async(url,body)=>{calls.push({url,body});if(url.includes('type=launch'))return new Promise(r=>resolveOld=r);return{items:[record]};},getRegistry:()=>registry,confirm:async()=>true,permissionText:()=>''});
  const pending=history.setFilter('launch');await history.setFilter('joint');resolveOld({items:[]});await pending;
  assert.equal(history.snapshot().filter,'joint');assert.equal(history.snapshot().items[0].id,'j1');
  await history.execute('joint','j1',true);assert.ok(!calls.some(c=>c.url==='/api/resume'));history.dispose();
});

test('P1 modal Escape stays closed across refresh and focus returns to a visible trigger',async t=>{
  const {doc,ids,app}=await fixture(t,'bento');await app.actions.openDetail('Walvo');
  assert.equal(ids.detail.open,true);await ids.detail.fire('keydown',{key:'Escape'});assert.equal(ids.detail.open,false);
  await app.actions.refreshRunning();assert.equal(ids.detail.open,false);assert.equal(app.snapshot().state.detailOpen,false);
  assert.ok(doc.activeElement?.isConnected);
});
test('P1 refreshing a changed catalog reconciles a removed selection',async t=>{
  const {app}=await fixture(t);app.actions.selectCategory(categoryNames[0]);await app.actions.openDetail('Walvo');
  const original=registry.agents;registry.agents=original.filter(a=>a.id!=='Walvo');
  try{await app.actions.refresh();assert.equal(app.snapshot().detail.id,'Jadra');assert.equal(app.snapshot().catalog.selectedId,'Jadra');}
  finally{registry.agents=original;}
});

test('P1 routine polling preserves expanded detail and focused controls',async t=>{
  const {doc,ids,app}=await fixture(t,'bento');await app.actions.openDetail('Walvo');
  const full=ids['detail-body'].querySelector('details');full.open=true;
  const summary=full.querySelector('summary');summary.focus();
  await app.actions.refreshRunning();
  assert.equal(ids['detail-body'].querySelector('details').open,true);
  assert.equal(doc.activeElement.isConnected,true);
});

test('P1 switching while settings are open cannot stack a new detail modal above settings',async t=>{
  const {doc,ids,app}=await fixture(t,'bento');await app.actions.openDetail('Walvo');app.actions.openSettings();
  await doc.querySelectorAll('[role="radio"]')[2].fire('click');
  assert.equal(ids['settings-dialog'].open,true);assert.equal(ids.detail.open,false);assert.equal(app.snapshot().catalog.selectedId,'Walvo');
});
