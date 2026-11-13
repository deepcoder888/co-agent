import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import * as threepane from '../public/layouts/threepane.js';

const categories=Array.from({length:11},(_,i)=>`分类${i}`);
const agents=Array.from({length:26},(_,i)=>({id:`a${i}`,name:`Agent${String(i).padStart(2,'0')}`,kind:i<4?'role':'book',
  primary:categories[i%11],purpose:i<4?'项目协调':null,book:i<4?null:{title:`《书籍${i}》`},description:'说明',tags:[],
  platforms:{claude:{available:true},codex:{available:true}},permissions:{},sources:{checked:true,missing:[]},sync:{state:'同步'}}));
const registry={agents,categories,summary:{roles:4,books:22,synced:26},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const bucket=n=>({calls:n,ok:Math.max(0,n-2),failed:Math.min(1,n),unknown:n>1?1:0,bySource:{claude:Math.floor(n/2),codex:n-Math.floor(n/2)}});
function statsData(){return{generatedAt:'2026-10-08T12:00:00Z',sources:[{available:true,failedFiles:[],scannedFiles:1}],
  perAgent:Object.fromEntries(agents.map((agent,i)=>{const n=i===1?24:i<24?24-i:0;return[agent.id,{last7d:bucket(n),last30d:bucket(n*2),total:bucket(n*3),lastAt:'2026-10-07T00:00:00Z'}];})),
  limited:true,limitedReasons:['累计缺口'],last7dLimited:false,last7dLimitedReasons:[],last30dLimited:true,last30dLimitedReasons:['30 天缺口'],
  daily:Array.from({length:30},(_,i)=>({day:new Date(Date.UTC(2026,8,9+i)).toISOString().slice(0,10),calls:i,role:i,book:0,claude:Math.floor(i/2),codex:i-Math.floor(i/2)}))};}
function safeDOM(doc){
  const guard=el=>{const set=el.setAttribute.bind(el);el.setAttribute=(key,value)=>{assert.notEqual(key,'style');set(key,value);};
    for(const key of ['innerHTML','outerHTML'])Object.defineProperty(el,key,{set(){throw new Error(`Forbidden ${key}`);}});
    el.insertAdjacentHTML=()=>{throw new Error('Forbidden HTML parsing');};return el;};
  const html=doc.createElement,svg=doc.createElementNS;
  doc.createElement=tag=>guard(html(tag));doc.createElementNS=(ns,tag)=>guard(svg(ns,tag));
  doc.createTextNode=text=>{const el=doc.createElement('text');el.textContent=text;return el;};
}
async function fixture(t){
  const {doc,ids}=await appDocument('threepane');safeDOM(doc);const stats=statsData(),requests=[];
  const app=await mountApp(doc,async(url,options={})=>{const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body});
    const value=url==='/api/registry'?registry:url==='/api/stats'||url==='/api/stats/refresh'?stats:
      url==='/api/settings'?{ui:body?.ui||'threepane',recommend:{codex:{model:'fixture'}}}:
      url==='/api/concepts?limit=30'?{items:[],today:null,running:null}:{items:[],unavailable:[]};
    return{ok:true,json:async()=>structuredClone(value)};
  },{confirm:async()=>true});t.after(()=>app.dispose());return{doc,ids,app,stats,requests};
}
const key=(root,name)=>root.querySelector(`[data-focus-key="stats-${name}"]`);
const visible=el=>el&&!el.closest('[hidden]');
const bars=root=>root.querySelectorAll('.chart-bar-row');
const idsOf=root=>bars(root).map(row=>row.getAttribute('data-agent-id'));
async function isolated(model){const{doc}=await appDocument('threepane');safeDOM(doc);const calls=[];
  const ctx={doc,refs:{},state:{view:'stats',categories},actions:new Proxy({},{get:(_,name)=>(...args)=>calls.push([name,...args])})};
  ctx.root=threepane.render(ctx);doc.getElementById('layout-root').replaceChildren(ctx.root);
  threepane.renderStats(ctx,model);return{doc,ctx,calls,paint:value=>threepane.renderStats(ctx,value)};}

test('v09 threepane statistics entry precedes coverage and retains the three scrolling panes',async t=>{
  const{doc,ids,app}=await fixture(t);
  assert.deepEqual(doc.querySelector('.utility-nav').children.map(n=>n.textContent),['调用组','AI 推荐','随机概念','研讨','会诊室','顾问团','概念地图','软件内对话','历史调用','运行中 0','调用统计','扫描与覆盖']);
  assert.ok(ids['stats-open'].closest('.mail-navigation'));await ids['stats-open'].fire('click');
  assert.equal(app.snapshot().state.view,'stats');assert.equal(ids['stats-open'].getAttribute('aria-current'),'page');
  assert.ok(visible(ids['stats-panel']));assert.ok(ids['stats-panel'].closest('.mail-list'));
  assert.ok(visible(ids['stats-ranking-panel']));assert.ok(ids['stats-ranking-panel'].closest('.mail-detail'));
  assert.equal(ids['stats-panel'].querySelectorAll('.chart-donut').length,2);assert.ok(ids['stats-panel'].querySelector('.chart-columns'));
  assert.equal(doc.querySelector('.stats-default'),null);assert.equal(doc.querySelector('.layout-threepane').hidden,false);
  assert.deepEqual(doc.querySelector('.layout-threepane').children.filter(n=>n.tagName!=='DIALOG').map(n=>n.className),['mail-navigation','mail-list','mail-detail']);
  for(const id of ['catalog','detail-body','history-panel','concepts-panel','recommend-panel','coverage-panel'])assert.equal(visible(ids[id]),false,id);
});

test('v09 threepane range buttons choose exact buckets, reveal limited reasons and keep the 30-day series',async t=>{
  const{ids,app}=await fixture(t);await app.actions.openStats();const base=app.snapshot().stats.totals.calls;
  const ranges=ids['stats-panel'].querySelector('[aria-label="统计时间范围"]');
  assert.deepEqual(ranges.children.map(n=>n.textContent),['近 7 天','近 30 天','累计']);
  for(const[range,multiplier,reason]of[['30d',2,'30 天缺口'],['all',3,'累计缺口'],['7d',1,'']]){
    await key(ids['stats-panel'],range).fire('click');assert.equal(app.snapshot().stats.range,range);
    assert.equal(app.snapshot().stats.totals.calls,base*multiplier);assert.equal(key(ids['stats-panel'],range).getAttribute('aria-pressed'),'true');
    assert.equal(ids['stats-panel'].querySelectorAll('[data-point]').length,30);
    if(reason){assert.ok(visible(ids['stats-limited']));assert.match(ids['stats-limited'].textContent,new RegExp(reason));assert.equal(ids['stats-limited'].getAttribute('role'),'status');}
    else assert.equal(visible(ids['stats-limited']),false);
  }
  assert.match(ids['stats-panel'].textContent,/趋势固定.*30 天.*全部 Agent.*本机时区/);
});

test('v09 threepane both donuts filter with pointer and keyboard; all eleven categories retain legend controls',async t=>{
  const{doc,ids,app}=await fixture(t);await app.actions.openStats();const totals=app.snapshot().stats.totals;
  const book=ids['stats-panel'].querySelector('[data-segment="book"]');book.focus();await book.fire('keydown',{key:'Enter'});
  assert.equal(app.snapshot().stats.filter,'book');assert.equal(doc.activeElement.getAttribute('data-segment'),'book');assert.equal(doc.activeElement.isConnected,true);
  assert.ok(app.snapshot().stats.agents.every(a=>a.kind==='book'));
  await ids['stats-panel'].querySelector('[data-segment="role"]').fire('click');assert.equal(app.snapshot().stats.filter,'role');
  const charts=ids['stats-panel'].querySelectorAll('.chart-donut');assert.equal(charts[1].querySelector('.chart-legend').children.length,11);
  await ids['stats-panel'].querySelector('[data-segment="分类5"]').fire('keydown',{key:' '});
  assert.equal(app.snapshot().stats.categoryFilter,'分类5');assert.ok(app.snapshot().stats.agents.every(a=>a.category==='分类5'));
  assert.equal(key(ids['stats-panel'],'legend-分类5').getAttribute('aria-pressed'),'true');
  await ids['stats-panel'].querySelector('[data-segment="分类5"]').fire('click');assert.equal(app.snapshot().stats.categoryFilter,null);
  await key(ids['stats-ranking-panel'],'filter-role').fire('click');await key(ids['stats-ranking-panel'],'filter-all').fire('click');
  assert.equal(app.snapshot().stats.filter,'all');assert.deepEqual(app.snapshot().stats.totals,totals);
});

test('v09 threepane category colors stay bound to category identities when ranking order changes',async t=>{
  const{ids,app,stats}=await fixture(t);await app.actions.openStats();
  const before=ids['stats-panel'].querySelector('[data-segment="分类5"]').getAttribute('class');
  stats.perAgent.a5.last30d=bucket(9999);await app.actions.refreshStats();await key(ids['stats-panel'],'30d').fire('click');
  assert.equal(app.snapshot().stats.byCategory[0].key,'分类5');
  assert.equal(ids['stats-panel'].querySelector('[data-segment="分类5"]').getAttribute('class'),before);
  const legend=key(ids['stats-panel'],'legend-分类5');assert.ok(legend.querySelector('.stats-swatch'));assert.equal(legend.querySelector('.stats-swatch').getAttribute('aria-hidden'),'true');
});

test('v09 threepane trend exposes every date and exact Claude/Codex counts on hover and focus',async t=>{
  const{ids,app}=await fixture(t);await app.actions.openStats();const trend=ids['stats-panel'].querySelector('.chart-columns');
  const points=trend.querySelectorAll('[data-point]');assert.equal(points.length,30);
  await points[5].fire('focus');assert.match(trend.querySelector('.chart-tooltip').textContent,/2026-09-14.*5.*claude 2.*codex 3/);
  await points[0].fire('mouseenter');assert.match(trend.querySelector('.chart-tooltip').textContent,/2026-09-09.*0/);
  assert.ok(points.every(p=>p.getAttribute('tabindex')==='0'));assert.ok(trend.querySelector('title'));assert.equal(trend.querySelector('.chart-data').children.length,30);
});

test('v09 threepane ranking is descending with tie order, two-source geometry, top20 and expandable zero group',async t=>{
  const{ids,app}=await fixture(t);await app.actions.openStats();const panel=ids['stats-ranking-panel'];
  assert.equal(bars(panel).length,20);assert.deepEqual(idsOf(panel),app.snapshot().stats.agents.map(a=>a.id));assert.deepEqual(idsOf(panel).slice(0,2),['a0','a1']);
  const first=bars(panel)[0],parts=first.querySelectorAll('[data-part]');assert.deepEqual(parts.map(p=>p.getAttribute('data-part')),['claude','codex']);
  assert.deepEqual(parts.map(p=>Number(p.getAttribute('width'))),[50,50]);assert.match(first.textContent,/项目协调/);
  assert.match(panel.textContent,/未调用的 Agent：2 个/);assert.match(key(panel,'expand').textContent,/展开全部（26）/);
  await key(panel,'expand').fire('click');assert.equal(bars(panel).length,26);assert.equal(ids['stats-zero-list'].querySelectorAll('.chart-zero').length,2);
  assert.deepEqual(idsOf(panel).slice(-2),['a24','a25']);assert.match(key(panel,'expand').textContent,/收起至前 20 名/);
  await key(panel,'expand').fire('click');assert.equal(bars(panel).length,20);
  await key(panel,'zero-expand').fire('click');assert.equal(bars(panel).length,26);
});

test('v09 threepane bar click shows summary at right top; 查看详情 alone opens the existing agent detail',async t=>{
  const{doc,ids,app,requests}=await fixture(t);await app.actions.openStats();const panel=ids['stats-ranking-panel'];
  await panel.querySelector('[data-agent-id="a5"]').fire('click');
  assert.equal(app.snapshot().state.view,'stats');assert.equal(panel.children[0],ids['stats-agent-summary']);
  assert.match(ids['stats-agent-summary'].textContent,/Agent05/);assert.match(ids['stats-agent-summary'].textContent,/《书籍5》/);
  assert.match(ids['stats-agent-summary'].textContent,/Claude 9.*Codex 10/);assert.match(ids['stats-agent-summary'].textContent,/成功 17.*失败 1.*未知 1/);
  assert.equal(panel.querySelector('[data-agent-id="a5"]').getAttribute('aria-pressed'),'true');
  assert.equal(panel.querySelector('[data-agent-id="a5"]').getAttribute('aria-controls'),'stats-agent-summary');
  assert.equal(key(panel,'agent-heading').getAttribute('tabindex'),'-1');
  assert.equal(doc.activeElement,key(panel,'agent-heading'));
  await app.actions.refreshRunning();assert.match(ids['stats-agent-summary'].textContent,/Agent05/);
  await key(panel,'agent-detail').fire('click');assert.equal(app.snapshot().state.view,'catalog');assert.equal(app.snapshot().state.selectedId,'a5');
  assert.equal(ids['detail-title'].textContent,'Agent05');assert.equal(requests.some(r=>r.url==='/api/launch'),false);
  await app.actions.openStats();await key(ids['stats-ranking-panel'],'filter-role').fire('click');assert.doesNotMatch(ids['stats-agent-summary'].textContent,/Agent05/);
});

test('v09 threepane category reset, refresh and return stay reachable without submitting an Agent call',async t=>{
  const{doc,ids,app,requests}=await fixture(t);await app.actions.openStats();
  await key(ids['stats-panel'],'legend-分类5').fire('click');
  const reset=key(ids['stats-ranking-panel'],'category');assert.match(reset.textContent,/分类5.*取消筛选/);
  await reset.fire('click');assert.equal(app.snapshot().stats.categoryFilter,null);assert.equal(app.snapshot().stats.filter,'all');
  await key(ids['stats-panel'],'refresh').fire('click');assert.equal(requests.filter(r=>r.url==='/api/stats/refresh').length,2);
  await key(ids['stats-ranking-panel'],'agent-a0').fire('click');
  assert.equal(doc.activeElement,key(ids['stats-ranking-panel'],'agent-heading'));
  await key(ids['stats-panel'],'back').fire('click');assert.equal(app.snapshot().state.view,'catalog');
  assert.equal(visible(ids['stats-panel']),false);assert.equal(visible(ids['stats-ranking-panel']),false);
  assert.equal(requests.some(r=>/launch|joint|recommend/.test(r.url)&&r.body),false);
});

test('v09 threepane all-zero data renders empty donuts and ranking while zero agents remain reachable',async t=>{
  const{ids,app,stats}=await fixture(t);for(const item of Object.values(stats.perAgent))item.last7d=bucket(0);await app.actions.openStats();
  assert.equal(ids['stats-panel'].querySelectorAll('[data-segment]').length,0);assert.equal(ids['stats-panel'].querySelectorAll('.chart-donut').length,2);
  assert.match(ids['stats-panel'].textContent,/该时间范围内没有调用/);assert.match(ids['stats-ranking-panel'].textContent,/该时间范围内没有调用/);
  assert.equal(bars(ids['stats-ranking-panel']).length,0);assert.match(ids['stats-ranking-panel'].textContent,/未调用的 Agent：26 个/);
  await key(ids['stats-ranking-panel'],'zero-expand').fire('click');assert.equal(bars(ids['stats-zero-list']).length,26);
  await bars(ids['stats-zero-list'])[0].fire('click');assert.match(ids['stats-agent-summary'].textContent,/调用 0/);
});

test('v09 threepane loading and unavailable statistics never masquerade as a zero-call period',async t=>{
  const{app}=await fixture(t);const ready=app.snapshot().stats;
  for(const status of ['loading','unavailable']){
    const{doc}=await isolated({...ready,status,totals:Object.fromEntries(Object.keys(ready.totals).map(key=>[key,null])),agents:[],byKind:[],byCategory:[],zeroCount:0,agentCount:0,limited:true,limitedReasons:['来源缺失']});
    assert.match(doc.getElementById('stats-panel').textContent,/来源缺失/);assert.match(doc.getElementById('stats-ranking-panel').textContent,status==='loading'?/统计正在建立/:/调用统计暂不可用/);
    assert.equal(doc.getElementById('stats-panel').querySelector('.chart-donut'),null);
    assert.doesNotMatch(doc.getElementById('stats-ranking-panel').textContent,/未调用的 Agent：0|该时间范围内没有调用/);
    assert.ok(key(doc,'7d'));assert.ok(key(doc,'30d'));assert.ok(key(doc,'all'));
  }
});

test('v09 threepane filters/range/expansion survive layout switches; preview updates do not replace chart DOM',async t=>{
  const{doc,ids,app,requests}=await fixture(t);await app.actions.openStats();
  await key(ids['stats-panel'],'30d').fire('click');await key(ids['stats-ranking-panel'],'filter-book').fire('click');await key(ids['stats-ranking-panel'],'expand').fire('click');
  const chart=ids['stats-panel'].querySelector('.chart-donut');await bars(ids['stats-ranking-panel'])[0].fire('click');assert.ok(ids['stats-panel'].querySelector('.chart-donut')===chart);
  app.actions.setRecommendInput('保留草稿');const before=app.snapshot().stats;app.actions.openSettings();
  for(const index of [1,0,2,0,3,0]){await doc.querySelectorAll('[role="radio"]')[index].fire('click');assert.deepEqual(app.snapshot().stats,before);assert.equal(app.snapshot().state.view,'stats');assert.equal(app.snapshot().recommend.input,'保留草稿');}
  assert.ok(visible(ids['stats-panel']));assert.ok(visible(ids['stats-ranking-panel']));assert.equal(doc.querySelector('.layout-threepane').hidden,false);
  assert.deepEqual(requests.filter(r=>r.body&&r.url!=='/api/settings').map(r=>r.url),['/api/stats/refresh']);
});

test('v09 threepane keeps literal chart text, accessible alternatives and scoped Material colors without unsafe styles',async t=>{
  const{app}=await fixture(t),value=app.snapshot().stats;value.agents[0].name='<img src=x onerror=1>';value.agents[0].purpose='<script>literal</script>';value.limited=true;value.limitedReasons=['<script>gap</script>'];
  const{doc}=await isolated(value),panel=doc.getElementById('stats-ranking-panel');
  assert.match(panel.textContent,/<img src=x onerror=1>/);assert.equal(panel.querySelectorAll('script,img').length,0);
  for(const chart of doc.querySelectorAll('.chart-donut,.chart-bar-list,.chart-columns')){assert.ok(chart.querySelector('title'));assert.ok(chart.querySelector('.chart-data'));}
  for(const el of descendants(doc.getElementById('layout-root')))assert.equal(el.getAttribute('style'),null);
  const css=(await fs.readFile('public/layouts/threepane.css','utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
  const rule=selector=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,head])=>head.split(',').map(s=>s.trim()).includes(`[data-ui="threepane"] ${selector}`)).map(([, ,body])=>body).join(';');
  for(const[,head]of css.matchAll(/([^{}]+)\{[^{}]*\}/g))for(const selector of head.split(','))assert.ok(selector.trim().startsWith('[data-ui="threepane"]'),selector);
  assert.match(rule('.stats-heading'),/font-size:\s*26px/);assert.match(rule('.stats-controls button'),/border-radius:\s*18px/);
  assert.match(rule('.stats-limited'),/border-radius:\s*6px/);assert.match(rule('.chart-bar-row'),/padding:\s*14px 16px/);
  assert.match(rule('.chart-claude'),/fill:\s*#0b57d0/);assert.match(rule('.chart-codex'),/fill:\s*#00796b/);
  for(let i=0;i<11;i++)assert.match(rule(`.threepane-chart-${i}`),/fill:\s*#[0-9a-f]{6}/);
  const js=await fs.readFile('public/layouts/threepane.js','utf8');assert.match(js,/import\s*\{[^}]*donut[^}]*barList[^}]*columns[^}]*\}\s*from\s*['"]\.\.\/charts\.js/);
  assert.doesNotMatch(js,/innerHTML|outerHTML|insertAdjacentHTML|cssText|setAttribute\(['"]style/);assert.doesNotMatch(css,/@import|https?:/);
});
