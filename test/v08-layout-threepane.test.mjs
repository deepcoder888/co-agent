import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import * as threepane from '../public/layouts/threepane.js';
import { renderMarkdown } from '../public/markdown.js';
import { avatarColor } from '../public/display.js';

const markdown = '# 认知边界 - AI-Era Learning Map\n\n**完整正文** 与 *解释* 和 `code`。\n\n' +
  Array.from({length:11},(_,i)=>`### ${i+1}. Section\n\n内容 ${i+1}`).join('\n\n') +
  '\n\n- 观察\n- 证据\n\n> 保留条件\n\n| 输入 | 输出 |\n| --- | --- |\n| A | B |\n\n```mermaid\ngraph TD; A-->B\n```\n\n<script>literal</script>\n\n[坏](javascript:alert(1))';
const record = (id='today', extra={}) => ({conceptId:id,kind:'daily',day:'2026-10-08',createdAt:'2026-10-08T01:00:00Z',
  status:'done',agent:{id:'Walvo',name:'Walvo',title:'**Notes on Sample**'},
  result:{concept:id==='today'?'认知边界':`概念 ${id}`,conceptEn:'Boundary',oneLine:'一句说明',whyUnknown:'不易察觉的前提',sourceRefs:['第 1 章'],markdown},
  verify:{state:'unconfirmed',skillStructure:{state:'missing',missing:[3],titleLine:false}},thinkError:'目标目录不可写',perspectives:[],...extra});
const member = (id,kind='book') => ({id,name:id,kind,primary:kind==='book'?'睡眠／健康／运动':'功能性 Agent',
  book:kind==='book'?{title:'**Dear Sample**',author:'作者'}:null,purpose:kind==='role'?'项目协调':null,description:'说明',tags:[],
  platforms:{claude:{available:true},codex:{available:true}},permissions:{},sources:{checked:true,missing:[]},sync:{state:'同步'}});
const registry={agents:[member('Walvo'),member('Jadra'),member('Peter','role')],categories:['睡眠／健康／运动'],
  summary:{roles:1,books:2,synced:3},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
function textDOM(doc) {
  const create=doc.createElement;
  doc.createElement=tag=>{
    const el=create(tag);
    for (const key of ['innerHTML','outerHTML']) Object.defineProperty(el,key,{set(){throw new Error(`Forbidden ${key}`);}});
    el.insertAdjacentHTML=()=>{throw new Error('Forbidden HTML parsing');};
    return el;
  };
  doc.createTextNode=text=>{const el=doc.createElement('text');el.textContent=text;return el;};
  return doc;
}
const key=(root,name)=>root.querySelector(`[data-focus-key="concepts-${name}"]`);
const visible=el=>el&&!el.closest('[hidden]');
async function fixture(t) {
  const {doc,ids}=await appDocument('threepane');textDOM(doc);
  const requests=[],records=new Map(['newer','today','older'].map(id=>[id,record(id)]));
  const data={running:null,fail:false};
  const app=await mountApp(doc,async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body,options});
    if(data.fail&&url.startsWith('/api/concepts'))return{ok:false,status:503,json:async()=>({error:'合成读取失败'})};
    let value={items:[],unavailable:[]};
    if(url==='/api/registry'||url==='/api/refresh')value=registry;
    else if(url==='/api/settings')value={ui:body?.ui||'threepane',recommend:{codex:{model:'fixture',effort:'xhigh'}}};
    else if(url==='/api/stats')value={perAgent:{},sources:[],limited:true,limitedReasons:[]};
    else if(url==='/api/concepts?limit=30')value={items:[...records.values()].map(r=>({...r,result:r.result?{concept:r.result.concept,oneLine:r.result.oneLine}:null})),
      today:{day:'2026-10-08',conceptId:'today',status:records.get('today').status},running:data.running};
    else if(url==='/api/concepts'&&body){
      data.running={conceptId:'generated',kind:'manual',startedAt:new Date(Date.now()-65000).toISOString()};
      records.set('generated',record('generated',{status:'running',startedAt:data.running.startedAt,result:null,verify:null,thinkError:null}));value={conceptId:'generated'};
    }else if(url.endsWith('/perspectives')&&body)value={runId:'p-new'};
    else if(url.startsWith('/api/concepts/'))value=records.get(url.split('/').at(-1));
    else if(url==='/api/recommend')value={recommendId:'rec'};
    else if(url==='/api/recommend/rec')value={status:'done',results:[{id:'Walvo',reason:'应排除'},{id:'Jadra',reason:'补充视角'}]};
    return{ok:true,json:async()=>structuredClone(value)};
  },{confirm:async()=>true});
  t.after(()=>app.dispose());return{doc,ids,app,requests,records,data};
}
async function isolated(model) {
  const {doc}=await appDocument('threepane');textDOM(doc);const calls=[];
  const ctx={doc,refs:{},state:{view:'concepts'},actions:new Proxy({}, {get:(_,name)=>(...args)=>{calls.push([name,...args]);}})};
  ctx.root=threepane.render(ctx);doc.getElementById('layout-root').replaceChildren(ctx.root);
  threepane.renderConcepts(ctx,model);
  return{doc,ctx,calls,paint:value=>threepane.renderConcepts(ctx,value)};
}
const model=(selected=record(),extra={})=>({items:[selected],selected,today:{day:'2026-10-08',conceptId:'today'},running:null,busy:false,error:'',...extra});
const shape=node=>[node.tagName,node._text,node.children.map(shape)];

test('v08 threepane entry follows AI 推荐; archive and reading stay in the existing three panes',async t=>{
  const {doc,ids,app}=await fixture(t);
  assert.deepEqual(doc.querySelector('.utility-nav').children.map(n=>n.textContent),['调用组','AI 推荐','随机概念','研讨','会诊室','顾问团','概念地图','软件内对话','历史调用','运行中 0','调用统计','扫描与覆盖']);
  assert.ok(ids['concepts-open'].closest('.mail-navigation'));assert.ok(visible(ids['concepts-open']));
  await ids['concepts-open'].fire('click');assert.equal(app.snapshot().state.view,'concepts');
  assert.equal(ids['concepts-open'].getAttribute('aria-current'),'page');
  assert.ok(visible(ids['concepts-panel']));assert.ok(ids['concepts-panel'].closest('.mail-detail'));
  assert.ok(visible(ids['concepts-archive']));assert.ok(ids['concepts-archive'].closest('.mail-list'));
  assert.equal(doc.querySelector('.layout-threepane').hidden,false);assert.equal(doc.querySelector('.concepts-default'),null);
  for(const id of ['catalog','history-panel','recommend-panel','running-panel','coverage-panel','detail-body'])assert.equal(visible(ids[id]),false,id);
  assert.deepEqual(doc.querySelector('.layout-threepane').children.filter(n=>n.tagName!=='DIALOG').map(n=>n.className),['mail-navigation','mail-list','mail-detail']);
});

test('v08 threepane today is pinned without mutating API order; archive selection and return restore focus',async t=>{
  const {doc,ids,app}=await fixture(t);await app.actions.openConcepts();
  const rows=ids['concepts-archive'].children;
  assert.deepEqual(rows.map(row=>row.querySelector('button').getAttribute('data-focus-key')),['concepts-select-today','concepts-select-newer','concepts-select-older']);
  assert.equal(rows[0].querySelector('.concept-today').textContent,'今日');assert.equal(ids['concepts-archive'].querySelectorAll('.concept-today').length,1);
  assert.equal(rows[0].querySelector('.avatar').style.getPropertyValue('background'),avatarColor('Walvo'));
  assert.deepEqual(app.snapshot().concepts.items.map(r=>r.conceptId),['newer','today','older']);
  await key(ids['concepts-archive'],'select-older').fire('click');assert.equal(app.snapshot().concepts.selected.conceptId,'older');
  assert.equal(key(ids['concepts-archive'],'select-older').getAttribute('aria-current'),'page');
  const back=key(ids['concepts-panel'],'back');back.focus();await back.fire('click');
  assert.equal(ids['concepts-panel'].hidden,true);assert.equal(visible(ids['concepts-archive']),false);assert.equal(doc.activeElement,ids['concepts-open']);
});

test('v08 threepane right pane follows the reading order and renders the shared Markdown DOM',async t=>{
  const {doc,ids,app}=await fixture(t);await app.actions.openConcepts();
  const body=ids['concepts-record'],classes=body.children.map(n=>n.className);
  const ordered=['concept-title','concept-source','concept-one-line','concept-why','detail-actions','concept-verification','concept-markdown','concept-perspectives'];
  for(let i=1;i<ordered.length;i++)assert.ok(classes.indexOf(ordered[i])>classes.indexOf(ordered[i-1]),ordered[i]);
  assert.equal(body.querySelector('.concept-title').tagName,'H1');assert.equal(body.querySelector('.concept-title').textContent,'认知边界');assert.equal(body.querySelector('.concept-source').textContent,'《Notes on Sample》 · Walvo');
  assert.equal(body.querySelector('.concept-one-line').textContent,'一句说明');assert.match(body.querySelector('.concept-why').textContent,/不易察觉的前提/);
  assert.deepEqual(body.querySelector('.detail-actions').children.map(n=>n.textContent),['再来一个','多视角分析','在终端中继续']);
  assert.match(body.querySelector('.concept-verification').textContent,/Agent 核验：未确认/);
  assert.match(body.querySelector('.concept-verification').textContent,/11.*结构.*3/);
  assert.match(body.textContent,/THINK 另存失败：目标目录不可写/);assert.match(body.textContent,/第 1 章/);
  assert.deepEqual(shape(body.querySelector('.concept-markdown')),shape(renderMarkdown(doc,markdown)));
  assert.equal(body.querySelectorAll('script,img,iframe').length,0);assert.match(body.textContent,/<script>literal<\/script>/);
});

test('v08 threepane next action uses the shared manual request and displays elapsed generation time',async t=>{
  const {ids,app,requests}=await fixture(t);await app.actions.openConcepts();
  await key(ids['concepts-panel'],'next').fire('click');
  const post=requests.find(r=>r.url==='/api/concepts'&&r.body);assert.deepEqual(post.body,{kind:'manual'});assert.equal(post.options.headers['X-Co-Agent-Token'],'synthetic-token');
  assert.match(ids['concepts-panel'].textContent,/运行中.*已用 1 分/);assert.equal(key(ids['concepts-panel'],'next').disabled,true);
  await key(ids['concepts-panel'],'next').fire('click');assert.equal(requests.filter(r=>r.url==='/api/concepts'&&r.body).length,1);
  assert.equal(key(ids['concepts-panel'],'perspectives').disabled,true);assert.equal(key(ids['concepts-panel'],'continue').disabled,true);
});

test('v08 threepane picker uses this skin, runs selected perspectives and terminal action only prefills the builder',async t=>{
  const {doc,ids,app,requests}=await fixture(t);await app.actions.openConcepts();
  await key(ids['concepts-panel'],'perspectives').fire('click');
  assert.equal(ids['perspective-picker'].open,true);assert.match(ids['perspective-picker'].className,/threepane-builder/);
  assert.equal(ids['perspective-all'].querySelector('[data-agent-id="Walvo"]'),null);assert.match(ids['perspective-recommend'].textContent,/补充视角/);
  const check=ids['perspective-all'].querySelector('[data-agent-id="Jadra"]');check.checked=true;await check.fire('change');await ids['perspective-submit'].fire('click');
  assert.deepEqual(requests.find(r=>r.url==='/api/concepts/today/perspectives').body,{agentIds:['Jadra']});
  assert.equal(ids['perspective-picker'].open,false);assert.match(ids['concepts-panel'].textContent,/多视角.*排队中/);
  await key(ids['concepts-panel'],'continue').fire('click');assert.equal(ids['joint-builder'].open,true);
  assert.match(ids['joint-builder'].className,/threepane-builder/);assert.equal(ids['builder-cli'].value,'codex');assert.match(ids['builder-input'].value,/认知边界/);
  assert.match(ids['builder-selected'].textContent,/Jadra/);assert.equal(requests.filter(r=>r.url==='/api/joint').length,0);
  assert.equal(doc.querySelector('.layout-threepane').hidden,false);
});

test('v08 threepane request errors offer read retry without generating a new concept',async t=>{
  const {ids,app,data,requests}=await fixture(t);data.fail=true;await app.actions.openConcepts();
  assert.match(ids['concepts-panel'].textContent,/合成读取失败/);assert.equal(ids['concepts-error'].getAttribute('role'),'alert');
  data.fail=false;await key(ids['concepts-panel'],'refresh').fire('click');assert.equal(app.snapshot().concepts.error,'');
  assert.equal(requests.filter(r=>r.url==='/api/concepts'&&r.body).length,0);
});

test('v08 threepane failed generation keeps reason/partial body and retries through nextConcept',async()=>{
  const value=model(record('today',{status:'failed',error:'合成进程中断'})),{doc,paint,calls}=await isolated(value);
  assert.match(doc.getElementById('concepts-panel').textContent,/失败原因：合成进程中断/);assert.ok(doc.querySelector('.concept-markdown'));
  const retry=key(doc,'retry');assert.match(retry.textContent,/重试.*新概念/);await retry.fire('click');assert.deepEqual(calls,[['nextConcept']]);
  paint({...value,running:{conceptId:'other',startedAt:new Date(Date.now()-65000).toISOString()}});
  assert.equal(key(doc,'retry').disabled,true);await key(doc,'retry').fire('click');assert.equal(calls.length,1);
  assert.match(doc.getElementById('concepts-panel').textContent,/已用 1 分/);
});

test('v08 threepane perspective failures retain cards and verification evidence; retry uses that run members',async()=>{
  const perspective={runId:'p1',status:'failed',error:'分析超时',agents:[{id:'Jadra',name:'Jadra',bookLabel:'《Dear Sample》'}],
    verify:{state:'violation',parallel:{state:'not-parallel'},violations:['名单外 Agent']},results:[{agentId:'Jadra',name:'Jadra',analysis:'**部分结果**\n\n<script>literal</script>'}]};
  const value=model(record('today',{perspectives:[perspective]})),{doc,paint,calls}=await isolated(value);
  const cards=doc.querySelector('.concept-perspective-cards');assert.equal(cards.children.length,1);assert.match(cards.textContent,/Jadra.*部分结果/);
  assert.ok(cards.querySelector('strong'));assert.equal(cards.querySelector('script'),null);
  assert.match(doc.querySelector('.concept-perspectives').textContent,/分析超时/);assert.match(doc.querySelector('.concept-perspectives').textContent,/名单外 Agent/);
  assert.match(doc.querySelector('.concept-perspectives').textContent,/并行：未通过/);
  await key(doc,'retry-p1').fire('click');assert.deepEqual(calls,[['runPerspectives','today',['Jadra']]]);
  paint(model(record('today',{perspectives:[perspective,{runId:'p2',status:'running',startedAt:new Date(Date.now()-65000).toISOString(),agents:[],results:[]}]})));
  assert.equal(key(doc,'retry-p1').disabled,true);assert.equal(key(doc,'perspectives').disabled,true);assert.equal(key(doc,'continue').disabled,false);
  assert.match(doc.querySelector('.concept-perspectives').textContent,/运行中.*已用 1 分/);
});

test('v08 threepane unknown verification is not success; complete and failed structures have explicit marks',async()=>{
  const {doc,paint}=await isolated(model(record('today',{verify:null,thinkError:null})));
  assert.match(doc.querySelector('.concept-verification').textContent,/核验：未确认/);assert.match(doc.querySelector('.concept-verification').textContent,/结构：未确认/);
  paint(model(record('today',{verify:{state:'ok',skillStructure:{state:'ok',missing:[],titleLine:true}},thinkError:null})));
  assert.match(doc.querySelector('.concept-verification').textContent,/Agent 核验：通过/);assert.match(doc.querySelector('.concept-verification').textContent,/11.*结构：通过/);
  paint(model(record('today',{verify:{state:'violation',skillStructure:{state:'missing',missing:[1,11],titleLine:false}}})));
  assert.match(doc.querySelector('.concept-verification').textContent,/核验：违规/);assert.match(doc.querySelector('.concept-verification').textContent,/1、11.*缺少标题行/);
});

test('v08 threepane handles empty archive, unloaded today and unknown elapsed time without hiding actions',async()=>{
  const {doc,paint,calls}=await isolated(model(null,{items:[],today:null}));
  assert.match(doc.getElementById('concepts-archive').textContent,/暂无存档/);assert.equal(key(doc,'next').disabled,false);
  await key(doc,'next').fire('click');assert.deepEqual(calls,[['nextConcept']]);
  paint(model(null,{items:[],today:{conceptId:'unloaded',status:'running'},running:{conceptId:'unloaded'}}));
  assert.ok(key(doc,'select-unloaded'));assert.match(doc.getElementById('concepts-archive').textContent,/今日/);
  assert.match(doc.getElementById('concepts-panel').textContent,/用时未知/);assert.equal(key(doc,'next').disabled,true);
});

test('v08 threepane completed Markdown survives unrelated busy/time updates and leaving/re-entering',async()=>{
  const value=model(),{doc,ctx,paint}=await isolated(value),body=doc.querySelector('.concept-markdown');
  paint({...value,busy:true,running:{conceptId:'other'}});assert.ok(doc.querySelector('.concept-markdown')===body);
  assert.equal(key(doc,'next').disabled,true);assert.equal(key(doc,'perspectives').disabled,true);
  ctx.state.view='catalog';paint(value);assert.equal(doc.getElementById('concepts-panel').hidden,true);
  ctx.state.view='concepts';paint(value);assert.ok(doc.querySelector('.concept-markdown')===body);
});

test('v08 threepane layout switches preserve selected concept, drafts and joint selections without submitting work',async t=>{
  const {doc,ids,app,requests}=await fixture(t);app.actions.selectCategory('book');app.actions.search('Jadra');
  app.actions.setRecommendInput('原草稿');app.actions.addToJoint('Jadra',undefined,false);
  await app.actions.openConcepts();await key(ids['concepts-archive'],'select-older').fire('click');
  const before=structuredClone(app.snapshot().concepts);app.actions.openSettings();
  for(const index of [1,0,2,0,3,0]){
    await doc.querySelectorAll('[role="radio"]')[index].fire('click');const snapshot=app.snapshot();
    assert.equal(snapshot.state.view,'concepts');assert.deepEqual(snapshot.concepts,before);
    assert.equal(snapshot.state.query,'Jadra');assert.equal(snapshot.recommend.input,'原草稿');assert.deepEqual(snapshot.state.jointSelectedIds,['Jadra']);
  }
  assert.ok(visible(ids['concepts-panel']));assert.equal(key(ids['concepts-archive'],'select-older').getAttribute('aria-current'),'page');
  assert.equal(requests.filter(r=>r.body&&r.url!=='/api/settings').length,0);
});

test('v08 threepane styles keep Material tokens, containment, readable Markdown and shared picker skin; no HTML/style injection',async()=>{
  const css=(await fs.readFile('public/layouts/threepane.css','utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
  const rule=selector=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,head])=>head.split(',').map(s=>s.trim()).includes(`[data-ui="threepane"] ${selector}`)).map(([, ,body])=>body).join(';');
  for(const [,head]of css.matchAll(/([^{}]+)\{[^{}]*\}/g))for(const selector of head.split(','))assert.ok(selector.trim().startsWith('[data-ui="threepane"]'),selector);
  assert.match(rule('.concept-title'),/font-size:\s*26px/);assert.match(rule('#concepts-record'),/gap:\s*22px/);
  assert.match(rule('.concept-why'),/border-radius:\s*6px/);assert.match(rule('.concept-today'),/background:\s*#d3e3fd/);
  assert.match(rule('#concepts-archive'),/display:\s*flex/);assert.match(rule('#concepts-archive'),/flex-direction:\s*column/);
  assert.match(rule('.concept-perspective-cards'),/grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(rule('.concept-markdown'),/line-height:\s*1\.7/);
  assert.match(rule('#perspective-search'),/border-radius:\s*22px/);assert.match(rule('#perspective-submit'),/background:\s*#0b57d0/);
  const js=await fs.readFile('public/layouts/threepane.js','utf8');assert.doesNotMatch(js,/innerHTML|outerHTML|insertAdjacentHTML|cssText|setAttribute\(['"]style/);
  assert.match(js,/import\s*\{\s*renderMarkdown\s*\}\s*from\s*['"]\.\.\/markdown\.js/);assert.doesNotMatch(css,/@import|https?:/);
});
