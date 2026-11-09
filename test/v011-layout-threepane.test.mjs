import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appDocument} from './fixtures/app.mjs';
import {descendants} from './fixtures/dom.mjs';
import {mountApp} from '../public/app.js';
import * as layout from '../public/layouts/threepane.js';
import {renderMarkdown} from '../public/markdown.js';

const terms=[{zh:'能量',en:'Energy',fr:'Énergie'},{zh:'习惯',en:'Habit',fr:'Habitude'}];
const agents=Array.from({length:4},(_,i)=>({id:`b${i}`,name:`作者${i}`,kind:'book',primary:'学习',tags:[],description:'说明',
  book:{title:`《原书${i}》`,author:`作者${i}`},platforms:{codex:{available:true,name:`cli-${i}`},claude:{available:true}},
  permissions:{},sources:{checked:true,missing:[]},sync:{state:'同步'}}));
const registry={agents,categories:['学习'],summary:{roles:0,books:4,synced:4},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const markdown='## 原书观点\n\nBOOK：第 3 章。\n\nINFERENCE：**完整观点**，énergie。\n\n- 行动\n- 观察\n\n<script>literal</script>';
function record(id='s1',extra={}) {return {version:1,seminarId:id,input:'为什么习惯难以改变？',mode:'auto',requestedAgents:null,
  status:'done',createdAt:'2026-10-08T01:00:00Z',startedAt:'2026-10-08T01:00:00Z',finishedAt:'2026-10-08T01:01:00Z',model:'fixture',effort:'xhigh',
  result:{terms,selected:agents.slice(0,3).map((a,i)=>({agent:`cli-${i}`,id:a.id,name:a.name,bookLabel:a.book.title,avatarColor:'#00796b',reason:`理由${i}`})),
    perAgent:agents.slice(0,3).map((a,i)=>({agent:`cli-${i}`,id:a.id,analysis:markdown,coverage:['直接','相关','无'][i]})),
    commonAnswer:{summary:'共同说明',points:[{text:'共同点',support:['cli-0','cli-1','cli-2'],strength:'全员一致'},
      {text:'多数观点',support:['cli-0','cli-1'],strength:'多数同意',strengthCorrected:true}]},
    divergences:[{topic:'争议议题',positions:[{agent:'cli-0',view:'立场甲'},{agent:'cli-1',view:'立场乙'}]}],
    actions:[1,2,3].map(i=>({text:`行动${i}`,basis:['cli-0','cli-2']}))},
  verify:{state:'unconfirmed',parallel:{state:'unconfirmed'},violations:['核验警告']},thinkError:'磁盘不可写',...extra};}
const concept=(id='c1',extra={})=>({conceptId:id,status:'done',day:'2026-10-08',agent:{id:'b0',name:'作者0',title:'《原书0》'},
  result:{concept:'能量：较长的原标题',conceptEn:'Old name',term:terms[0],oneLine:'一句说明',whyUnknown:'隐含假设',markdown},perspectives:[],...extra});
function safeDOM(doc) {
  const guard=el=>{const set=el.setAttribute.bind(el);el.setAttribute=(k,v)=>{assert.notEqual(k,'style');set(k,v);};
    for(const k of ['innerHTML','outerHTML'])Object.defineProperty(el,k,{set(){assert.fail(`unsafe ${k}`);}});
    el.insertAdjacentHTML=()=>assert.fail('unsafe HTML parsing');return el;};
  const html=doc.createElement,svg=doc.createElementNS;doc.createElement=t=>guard(html(t));doc.createElementNS=(ns,t)=>guard(svg(ns,t));
  doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};
}
const key=(root,k)=>root.querySelector(`[data-focus-key="seminars-${k}"]`);
const visible=el=>!!el&&!el.closest('[hidden]');
const shape=n=>[n.tagName,n._text,n.children.map(shape)];
async function fixture(t) {
  const{doc,ids}=await appDocument('threepane');safeDOM(doc);const requests=[];
  const data={records:new Map([['s1',record()],['old',record('old',{result:{...record().result,terms:[]}})]]),running:null,fail:false,concept:concept()};
  const app=await mountApp(doc,async(url,options={})=>{const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body});
    if(data.fail&&url.startsWith('/api/seminars'))return{ok:false,status:503,json:async()=>({error:'读取失败示例'})};
    let value={items:[],unavailable:[]};
    if(url==='/api/registry')value=registry;
    else if(url==='/api/settings')value={ui:body?.ui||'threepane',recommend:{codex:{model:'fixture'}}};
    else if(url==='/api/stats')value={perAgent:{},sources:[],limitedReasons:[]};
    else if(url==='/api/seminars?limit=30')value={items:[...data.records.values()],running:data.running};
    else if(url==='/api/seminars'&&body){const id='new';data.records.set(id,record(id,{status:'queued',result:null,thinkError:null}));data.running={seminarId:id,status:'queued'};value={seminarId:id};}
    else if(url.startsWith('/api/seminars/'))value=data.records.get(url.split('/').at(-1));
    else if(url==='/api/concepts?limit=30')value={items:[data.concept],today:{conceptId:'c1'},running:null};
    else if(url==='/api/concepts/c1')value=data.concept;
    return{ok:true,json:async()=>structuredClone(value)};
  },{confirm:async()=>true});t.after(()=>app.dispose());return{doc,ids,app,data,requests};
}
async function isolated(selected=record(),extra={}) {
  const{doc,ids}=await appDocument('threepane');safeDOM(doc);const calls=[];
  const ctx={doc,refs:{},state:{view:'seminars',allAgents:agents},actions:new Proxy({},{get:(_,name)=>(...args)=>calls.push([name,...args])})};
  ctx.root=layout.render(ctx);ids['layout-root'].replaceChildren(ctx.root);
  const model={items:selected?[selected]:[],selected,running:null,busy:false,error:'',input:'草稿',terms:selected?.result?.terms||[],...extra};
  const paint=m=>layout.renderSeminars(ctx,m);paint(model);return{doc,ids,ctx,calls,model,paint};
}

test('v011 threepane F38 concept title and archive preserve accented translations and the original subtitle',async t=>{
  const{ids,app}=await fixture(t);await app.actions.openConcepts();const body=ids['concepts-record'];
  assert.equal(body.querySelector('.concept-title').textContent,'能量');assert.equal(body.querySelector('.term-translations').textContent,'Energy · Énergie');
  assert.equal(body.querySelector('.term-translations').querySelector('[lang="fr"]').textContent,'Énergie');assert.equal(body.querySelector('.term-subtitle').textContent,'能量：较长的原标题');
  const archive=ids['concepts-archive'];assert.equal(archive.querySelector('strong').textContent,'能量');assert.match(archive.textContent,/Energy · Énergie/);assert.match(archive.textContent,/能量：较长的原标题/);assert.match(archive.textContent,/今日/);
});
