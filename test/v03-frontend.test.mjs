import { appDocument } from './fixtures/app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard, fillDetails, mountApp } from '../public/app.js';
import { renderJointStatus } from '../public/workflows.js';

class Element {
  constructor(tag='div') { this.tagName=tag; this.children=[]; this.events={}; this.attrs={}; this.value=''; this._text=''; }
  set textContent(v) { this._text=String(v); this.children=[]; }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this._text=''; this.children=c; }
  setAttribute(k,v) { this.attrs[k]=v; }
  addEventListener(k,v) { this.events[k]=v; }
  removeEventListener(k) { delete this.events[k]; }
  focus() { this.focused=true; }
}
const doc={createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t)};
const all=el=>[el,...el.children.flatMap(all)];
const member=(id,extra={})=>({id,name:id,description:'注册表用途',kind:'role',primary:'功能性 Agent',tags:[],platforms:{claude:{available:true},codex:{available:true}},...extra});
const ben=member('ben',{writable:true,permissions:{codex:{sandbox:'workspace-write',model:'gpt',effort:'high',webSearch:'disabled'},claude:{model:'sonnet',effort:'max',tools:['Read','Write'],writable:true}}});
const book=member('walvo',{name:'Walvo',kind:'book',primary:'睡眠',description:'休息',book:{title:'我们为什么要睡觉',author:'马修沃克',edition:'2017'}});

test('J1 permissions displayed on cards and detail, missing fields explicitly undeclared',()=>{
  const card=createCard(doc,ben,{categories:[],onLaunch(){},onDetails(){}}).card;
  for (const text of ['可写','workspace-write','gpt','sonnet','high','max','disabled','Write','writable 可写']) assert.ok(card.textContent.includes(text),text);
  const body=new Element(); fillDetails(doc,body,member('Peter'));
  assert.ok(body.textContent.includes('未声明'));
});

async function mounted(t,fetchOverride,confirm=()=>false) {
  const {doc:mountedDoc,ids,events}=await appDocument('bento','token');
  const registry={agents:[ben,book],categories:['睡眠'],summary:{roles:1,books:1,uncategorized:0},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,options}); const custom=await fetchOverride?.(url,options);
    const value=custom??(url==='/api/registry'?registry:url==='/api/stats'?{sources:[],perAgent:{},limitedReasons:[]}:url==='/api/settings'?{recommend:{claude:{model:'sonnet',effort:'未声明'},codex:{model:'gpt-6.1-sol',effort:'medium'}}}:{items:[]});
    return {ok:true,json:async()=>value};
  };
  const app=await mountApp(mountedDoc,fetcher,{confirm}); t.after(()=>app.dispose()); app.actions.setJointCli('codex');
  return {ids,events,requests,mountedDoc};
}

test('J2 global search matches title author edition normalized name, no requests; clear restores category; shortcuts',async t=>{
  const {ids,events,requests,mountedDoc}=await mounted(t); const start=requests.length;
  assert.ok(!ids.cards.textContent.includes('Walvo'));
  for (const query of ['为什么','马修','2017','WALVO','睡眠']) {
    ids.search.value=query; ids.search.fire('input'); assert.ok(ids.cards.textContent.includes('Walvo'),query); assert.match(ids['view-title'].textContent,/1/);
  }
  ids.search.value='missing'; ids.search.fire('input'); assert.match(ids.cards.textContent,/没有匹配的 Agent/);
  ids.search.value=''; ids.search.fire('input'); assert.ok(!ids.cards.textContent.includes('Walvo')); assert.equal(requests.length,start);
  let prevented=false; events.keydown({key:'/',target:{tagName:'TEXTAREA'},preventDefault(){prevented=true;}}); assert.equal(prevented,false);
  events.keydown({key:'/',target:{tagName:'BODY'},preventDefault(){prevented=true;}}); assert.equal(mountedDoc.activeElement,ids.search);
  ids.search.focused=false; events.keydown({key:'k',ctrlKey:true,target:{tagName:'INPUT'},preventDefault(){}}); assert.equal(mountedDoc.activeElement,ids.search);
  ids.search.value='Walvo'; events.keydown({key:'Escape',target:ids.search,preventDefault(){}}); assert.equal(ids.search.value,'');
});

test('J4/J5 unavailable selected item is flagged and blocks POST; positive writable confirmation includes fields',async t=>{
  const unavailable={...book,platforms:{claude:{available:true},codex:{available:false,reason:'无 Codex 入口'}}};
  let results=[unavailable], confirmedText;
  const {ids,requests}=await mounted(t,url=>url==='/api/recommend'?{recommendId:'r'}:url==='/api/recommend/r'?{recommendId:'r',status:'done',engine:'claude',results,rejected:[],audit:{ok:true,agentCalls:0,children:0}}:url==='/api/joint'?{jointId:'j'}:undefined,text=>{confirmedText=text;return true;});
  // The unavailable item is a historical recommendation no longer present in the current registry.
  unavailable.id='missing'; unavailable.name='Missing';
  ids['recommend-input'].value='任务'; await ids['recommend-input'].fire('input'); await ids['recommend-submit'].fire('click');
  ids['select-all'].checked=true; ids['select-all'].fire('change');
  assert.match(ids['recommend-results'].textContent,/不可用/); await ids['joint-submit'].fire('click');
  assert.ok(!requests.some(r=>r.url==='/api/joint'));
  results=[ben]; await ids['recommend-submit'].fire('click'); ids['select-all'].checked=true; ids['select-all'].fire('change');
  await ids['joint-submit'].fire('click');
  assert.match(confirmedText,/ben/); assert.match(confirmedText,/workspace-write/); assert.match(confirmedText,/Write/);
  const posted=requests.find(r=>r.url==='/api/joint'); assert.deepEqual(JSON.parse(posted.options.body),{recommendId:'r',agentIds:['ben'],cli:'codex',writableConfirmed:true});
});

test('J7 joint status renders whitelist, statuses, denied attempts, evidence, CLI result location and encrypted-task note',()=>{
  const target=new Element();
  renderJointStatus(doc,target,{cli:'codex',whitelist:[{codexName:'-jack'}]},{overall:'unconfirmed',process:{state:'alive'},cwd:{state:'ok'},parallel:{state:'not-parallel',evidence:[{line:3}]},
    whitelist:{state:'ok',violations:[],deniedAttempts:[{agent:'other',evidence:{line:5}}]},calls:[{agent:'-jack',state:'running',evidence:[{line:4}]}],taskTextNote:'任务文本加密，无法核验实际任务'});
  for (const text of ['-jack','运行中','未并行','平台已拒绝尝试','other','结果请在 CLI 窗口中查看','无法核验','核验证据']) assert.ok(target.textContent.includes(text),text);
});

test('J3/J4/J5 rendered recommendation purpose, model reason, select all, reset, unavailable and writable cancellation',async t=>{
  let num=0;
  const {ids,requests}=await mounted(t,(url)=>url==='/api/recommend'?{recommendId:`r${++num}`}:
    url.startsWith('/api/recommend/')?{status:'done',results:[{...ben,reason:'模型理由文本'},{...book,reason:'睡眠相关'}],rejected:[{id:'fake'}],note:'',audit:{ok:false,agentCalls:1,children:0}}:undefined);
  assert.equal(ids['joint-submit'].disabled,true);
  ids['recommend-input'].value='睡眠问题'; ids['recommend-input'].fire('input'); assert.match(ids['recommend-count'].textContent,/4/);
  await ids['recommend-submit'].fire('click');
  assert.ok(ids['recommend-results'].textContent.includes('注册表用途')); assert.ok(ids['recommend-results'].textContent.includes('模型理由'));
  assert.ok(ids['recommend-status'].textContent.includes('推荐阶段出现了 Agent 调用'));
  ids['select-all'].checked=true; ids['select-all'].fire('change'); assert.match(ids['selected-count'].textContent,/2/); assert.equal(ids['joint-submit'].disabled,false);
  await ids['joint-submit'].fire('click'); assert.ok(!requests.some(r=>r.url==='/api/joint'),'cancel must not POST');
  await ids['recommend-submit'].fire('click'); assert.match(ids['selected-count'].textContent,/0/); assert.equal(ids['joint-submit'].disabled,true);
  assert.ok(all(ids['recommend-results']).filter(n=>n.tagName.toLowerCase()==='input').length>=2);
});
