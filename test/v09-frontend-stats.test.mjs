import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import { layouts } from '../public/layouts/index.js';
const categories=Array.from({length:11},(_,i)=>`分类${i}`);
const agents=Array.from({length:26},(_,i)=>({id:`a${i}`,name:`Agent${String(i).padStart(2,'0')}`,kind:i<4?'role':'book',primary:categories[i%11],purpose:i<4?'用途':null,book:i<4?null:{title:`书${i}`},description:'说明',tags:[],platforms:{claude:{available:true},codex:{available:true}},sources:{checked:true,missing:[]},sync:{state:'同步'}}));
const registry={agents,categories,summary:{roles:4,books:22,synced:26},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const bucket=n=>({calls:n,ok:n,failed:0,unknown:0,bySource:{claude:n,codex:0}});
const stats={generatedAt:'2026-10-08T12:00:00Z',sources:[{id:'fixture',available:true,failedFiles:[],scannedFiles:1}],perAgent:Object.fromEntries(agents.map((a,i)=>[a.id,{last7d:bucket(i<24?24-i:0),last30d:bucket((i<24?24-i:0)*2),total:bucket((i<24?24-i:0)*3),lastAt:'2026-10-07T00:00:00Z',launches:{last7d:999,last30d:999,total:999}}])),limited:true,limitedReasons:['累计缺口'],last7dLimited:false,last7dLimitedReasons:[],last30dLimited:true,last30dLimitedReasons:['30 天缺口'],daily:Array.from({length:30},(_,i)=>({day:new Date(Date.UTC(2026,8,9+i)).toISOString().slice(0,10),calls:i,role:i,book:0,claude:i,codex:0}))};
test('v09 StatsView uses range buckets, top20, expand/zeros, global donuts and exact limited reasons',async()=>{
  const {createStatsView}=await import('../public/stats-view.js');const view=createStatsView({getStats:()=>stats,getRegistry:()=>registry});let m=view.snapshot();
  assert.equal(m.totals.calls,300);assert.equal(m.totals.agentsUsed,24);assert.equal(m.agents.length,20);assert.equal(m.zeroCount,2);assert.equal(m.agentCount,26);assert.equal(m.byCategory.length,11);assert.equal(m.daily.length,30);assert.equal(m.limited,false);
  assert.ok(m.agents.every((a,i,rows)=>!i||rows[i-1].value>=a.value));assert.ok(m.byCategory.every((a,i,rows)=>!i||rows[i-1].value>=a.value));
  view.toggleShowAll();m=view.snapshot();assert.equal(m.agents.length,26);assert.equal(m.agents.at(-1).value,0);
  view.setRange('30d');m=view.snapshot();assert.equal(m.totals.calls,600);assert.equal(m.showAll,false);assert.deepEqual(m.limitedReasons,['30 天缺口']);
  view.setRange('all');assert.equal(view.snapshot().totals.calls,900);assert.deepEqual(view.snapshot().limitedReasons,['累计缺口']);
});
test('v09 kind/category slice actions filter ranking and toggle category off without changing totals/trend',async()=>{
  const {createStatsView}=await import('../public/stats-view.js');let updates=0;const view=createStatsView({getStats:()=>stats,getRegistry:()=>registry,onState:()=>updates++});
  view.setFilter('role');assert.equal(view.snapshot().agents.length,4);assert.equal(view.snapshot().totals.calls,300);
  view.setCategory('分类5');let m=view.snapshot();assert.equal(m.filter,'book');assert.equal(m.categoryFilter,'分类5');assert.ok(m.agents.every(a=>a.category==='分类5'&&a.kind==='book'));
  view.setCategory('分类5');assert.equal(view.snapshot().categoryFilter,null);assert.equal(view.snapshot().filter,'all');
  view.setFilter('garbage');view.setRange('bad');view.setCategory('bad');assert.equal(view.snapshot().range,'7d');assert.ok(updates>=3);
});
test('v09 unavailable/missing buckets are unknown, not fabricated zero-call agents',async()=>{
  const {createStatsView}=await import('../public/stats-view.js');let value={...stats,building:true};const view=createStatsView({getStats:()=>value,getRegistry:()=>registry});
  assert.equal(view.snapshot().totals.calls,null);assert.equal(view.snapshot().zeroCount,0);assert.equal(view.snapshot().status,'loading');
  value=structuredClone(stats);delete value.perAgent.a0.last30d;view.setRange('30d');const m=view.snapshot();assert.equal(m.totals.calls,null);assert.equal(m.status,'unavailable');assert.match(m.limitedReasons.join(' '),/30|数据/);
});

test('v09 totals retain both CLIs, failures and unknowns; tie order, snapshots and all-zero periods stay honest',async()=>{
  const {createStatsView}=await import('../public/stats-view.js');const value=structuredClone(stats);
  for(const a of agents)value.perAgent[a.id].last7d=bucket(0);
  value.perAgent.a1.last7d={calls:5,ok:2,failed:1,unknown:2,bySource:{claude:2,codex:3}};value.perAgent.a0.last7d=bucket(5);
  const view=createStatsView({getStats:()=>value,getRegistry:()=>registry});let m=view.snapshot();
  assert.deepEqual(m.totals,{calls:10,claude:7,codex:3,ok:7,failed:1,unknown:2,agentsUsed:2});assert.deepEqual(m.agents.map(a=>a.id),['a0','a1']);
  m.daily[0].calls=9999;m.limitedReasons.push('污染');m.agents[0].value=9999;assert.equal(view.snapshot().totals.calls,10);assert.equal(value.daily[0].calls,0);assert.deepEqual(view.snapshot().limitedReasons,[]);
  value.perAgent.a0.last7d=bucket(0);value.perAgent.a1.last7d=bucket(0);m=view.snapshot();assert.equal(m.totals.calls,0);assert.equal(m.zeroCount,26);assert.equal(m.agents.length,0);assert.equal(m.byCategory.length,11);view.toggleShowAll();assert.equal(view.snapshot().agents.length,26);
});

test('v09 missing source coverage and malformed counts never fabricate a complete ranking',async()=>{
  const {createStatsView}=await import('../public/stats-view.js');const value=structuredClone(stats),view=createStatsView({getStats:()=>value,getRegistry:()=>registry});
  value.sources=[];assert.equal(view.snapshot().status,'unavailable');value.sources=stats.sources;value.perAgent.a0.last7d.bySource.codex=-1;assert.equal(view.snapshot().status,'unavailable');
});
async function appFixture(t,ui){const {doc}=await appDocument(ui),requests=[];
  const app=await mountApp(doc,async(url,opts={})=>{requests.push({url,opts});const body=opts.body?JSON.parse(opts.body):{};
    const value=url==='/api/registry'?registry:url==='/api/stats'||url==='/api/stats/refresh'?stats:url==='/api/settings'?{ui:body.ui||ui,recommend:{claude:{model:'fixture'},codex:{model:'fixture'}}}:url==='/api/concepts?limit=30'?{items:[],today:null,running:null}:{items:[],unavailable:[]};return{ok:true,json:async()=>value};},{confirm:async()=>true});t.after(()=>app.dispose());return{doc,app,requests};}
for(const ui of Object.keys(layouts))test(`v09 ${ui} stats default is reachable, interactive and preserves settings drafts`,async t=>{
  const {app,doc}=await appFixture(t,ui);assert.equal(typeof layouts[ui].renderStats,'function');await doc.getElementById('stats-open').fire('click');assert.equal(app.snapshot().state.view,'stats');
  const panel=doc.getElementById('stats-panel');assert.equal(panel.hidden,false);assert.equal(panel.querySelectorAll('.chart-donut').length,2);assert.ok(panel.querySelector('.chart-columns'));
  const bookSlice=panel.querySelector('[data-segment="book"]');bookSlice.focus();await bookSlice.fire('keydown',{key:'Enter'});
  assert.equal(doc.activeElement.getAttribute('data-segment'),'book');assert.equal(doc.activeElement.isConnected,true);
  await panel.querySelector('[data-segment="role"]').fire('click');assert.equal(app.snapshot().stats.filter,'role');
  await panel.querySelector('[data-segment="分类5"]').fire('click');assert.equal(app.snapshot().stats.categoryFilter,'分类5');
  await panel.querySelector('[data-segment="分类5"]').fire('click');assert.equal(app.snapshot().stats.categoryFilter,null);
  await app.actions.setStatsRange('30d');assert.match(panel.textContent,/30 天缺口/);await app.actions.setStatsFilter('role');assert.equal(app.snapshot().stats.agents.length,4);
  app.actions.setRecommendInput('未提交');app.actions.openSettings();await doc.querySelectorAll('[role="radio"]')[1].fire('click');assert.equal(app.snapshot().stats.range,'30d');assert.equal(app.snapshot().recommend.input,'未提交');
  await doc.getElementById('stats-panel').querySelector('[data-agent-id="a0"]').fire('click');assert.equal(app.snapshot().state.selectedId,'a0');assert.equal(app.snapshot().state.view,'catalog');
  await app.actions.openStats();app.actions.setStatsFilter('all');app.actions.toggleStatsShowAll();assert.equal(app.snapshot().stats.agents.length,26);assert.match(doc.getElementById('stats-panel').textContent,/未调用的 Agent：2 个/);
});
