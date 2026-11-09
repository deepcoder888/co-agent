import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appDocument, allStyles} from './fixtures/app.mjs';
import {descendants} from './fixtures/dom.mjs';
import {mountApp, toHistoryView, pollFinished} from '../public/app.js';

const recovery='终端窗口会被关闭；之后可以在「历史调用」→「继续该次会话」恢复。';
const agent=name=>({id:name,name,kind:'book',primary:'学习',tags:[],description:'说明',book:{title:`书${name}`},permissions:{},sources:{checked:true,missing:[]},platforms:{claude:{available:true},codex:{available:true}}});
const agents=['甲','乙','丙'].map(agent);
const registry={agents,categories:['学习'],summary:{books:3,roles:0},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const rows=()=>[{type:'launch',id:'l1',agentId:'甲',agentName:'甲',cli:'codex',pid:1234,title:'不发送标题',createdAt:'2026-10-08T01:00:00Z',status:{overall:'ready'}},
  {type:'joint',id:'j1',cli:'claude',whitelist:[{id:'乙',codexName:'乙',claudeName:'乙'},{id:'丙',codexName:'丙',claudeName:'丙'}],createdAt:'2026-10-08T01:00:00Z',status:{overall:'ready'}}];
const historyRows=()=>[{type:'launch',id:'l1',cli:'codex',agents:[{id:'甲',name:'甲'}],createdAt:'2026-10-08T01:00:00Z',status:{overall:'closed',message:'已关闭（用户）'},closedAt:'2026-10-08T02:00:00Z',closedBy:'user',canResume:true}];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,ui='threepane',{confirm=async()=>true,native=false}={}){
  const {doc}=await appDocument(ui),requests=[],data={running:rows(),history:historyRows()};
  const create=doc.createElement;doc.createElement=tag=>{const node=create(tag),set=node.setAttribute.bind(node);node.setAttribute=(key,value)=>{assert.notEqual(key,'style');set(key,value);};Object.defineProperty(node,'innerHTML',{set(){assert.fail('unsafe HTML');}});return node;};
  const fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,options,body});let value;
    if(url==='/api/registry'||url==='/api/refresh')value=registry;
    else if(url==='/api/stats')value={perAgent:{},sources:[],limitedReasons:[]};
    else if(url==='/api/settings')value={ui:body?.ui || ui,recommend:{claude:{model:'fixture'},codex:{model:'fixture'}}};
    else if(url==='/api/running')value=data.readRunning?await data.readRunning():{items:data.running};
    else if(url==='/api/running/close')value=data.close?await data.close(body):{items:body.items.map(item=>({...item,result:'closed',windowClosed:true}))};
    else if(url.startsWith('/api/history?'))value={items:data.history};
    else value={items:[],unavailable:[]};
    return{ok:true,json:async()=>structuredClone(value)};
  };
  const app=await mountApp(doc,fetch,native?{}:{confirm});t.after(()=>app.dispose());
  return{app,doc,data,requests,posts:()=>requests.filter(r=>r.url==='/api/running/close'),toast:()=>doc.getElementById('running-close-status')};
}

test('v013 single close confirms exact name/CLI/recovery, freezes IDs and uses authenticated API only',async t=>{
  const prompts=[],h=await fixture(t,'threepane',{confirm:async(text,trigger)=>{prompts.push({text,trigger});return true;}}),trigger=h.doc.createElement('button');
  h.data.close=body=>{h.data.running=h.data.running.filter(r=>r.id!=='l1');return{items:body.items.map(item=>({...item,result:'closed',windowClosed:true}))};};
  await h.app.actions.closeRunning('launch','l1',trigger);
  assert.equal(prompts[0].text,`关闭 甲 的 Codex 会话？${recovery}`);assert.equal(prompts[0].trigger,trigger);
  assert.deepEqual(h.posts()[0].body,{items:[{type:'launch',id:'l1'}]});assert.equal(h.posts()[0].options.method,'POST');assert.equal(h.posts()[0].options.headers['X-Co-Agent-Token'],'synthetic-token');
  assert.equal(h.toast().textContent,'已关闭 1 个会话');assert.equal(h.toast().getAttribute('role'),'status');assert.equal(h.toast().hidden,false);
  assert.deepEqual(h.app.snapshot().running.map(r=>r.id),['j1']);assert.ok(h.requests.slice(h.requests.indexOf(h.posts()[0])+1).some(r=>r.url.startsWith('/api/history?')));
  assert.equal(h.requests.filter(r=>r.url==='/api/stats').length,1,'closing must not rebuild statistics');
});

test('v013 close-all confirms count and all names once, retains the approved snapshot across polling',async t=>{
  const gate=deferred(),prompts=[],h=await fixture(t,'bento',{confirm:text=>{prompts.push(text);return gate.promise;}});
  const pending=h.app.actions.closeAllRunning();await tick();
  assert.equal(prompts[0],`关闭全部 2 个运行中的会话？\n甲\n联合调用：乙、丙\n${recovery}`);
  h.data.running.push({...rows()[0],id:'new',agentName:'新会话'});await h.app.actions.refreshRunning();gate.resolve(true);await pending;
  assert.equal(prompts.length,1);assert.deepEqual(h.posts()[0].body,{items:[{type:'launch',id:'l1'},{type:'joint',id:'j1'}]});
});

test('v013 cancellation, absent identities and empty lists never submit; busy prevents duplicate confirmations',async t=>{
  let prompts=0;const gate=deferred(),h=await fixture(t,'shelf',{confirm:()=>{prompts++;return gate.promise;}});
  const pending=h.app.actions.closeRunning('joint','j1');await tick();
  await h.app.actions.closeAllRunning();await h.app.actions.closeRunning('launch','l1');assert.equal(prompts,1);assert.equal(h.app.snapshot().state.closeRunningBusy,true);
  gate.resolve(false);await pending;assert.equal(h.posts().length,0);assert.equal(h.app.snapshot().state.closeRunningBusy,false);
  await h.app.actions.closeRunning('bad','l1');await h.app.actions.closeRunning('launch','absent');
  h.data.running=[];await h.app.actions.refreshRunning();await h.app.actions.closeAllRunning();assert.equal(prompts,1);assert.equal(h.posts().length,0);
});

test('v013 native confirmation defaults to cancel, escapes literal names, restores trigger on cancel',async t=>{
  const h=await fixture(t,'editorial',{native:true});h.data.running[0].agentName='<img src=x>';await h.app.actions.showView('running');
  const trigger=h.doc.querySelector('[data-close-running="launch:l1"]');assert.ok(trigger);
  const pending=trigger.fire('click');await tick();
  assert.equal(h.doc.getElementById('confirm').open,true);assert.equal(h.doc.activeElement,h.doc.getElementById('confirm-cancel'));
  assert.equal(h.doc.getElementById('confirm-body').textContent,`关闭 <img src=x> 的 Codex 会话？${recovery}`);assert.equal(h.doc.getElementById('confirm-body').querySelector('img'),null);
  await h.doc.getElementById('confirm').fire('keydown',{key:'Escape'});await pending;
  assert.equal(h.posts().length,0);assert.equal(h.doc.activeElement,h.doc.querySelector('[data-close-running="launch:l1"]'));
});

test('v013 close reports only actual successes, PID mismatch, not-running and manual-window reasons',async t=>{
  const h=await fixture(t);h.data.running.push({...rows()[0],id:'l2'});await h.app.actions.refreshRunning();
  h.data.close=()=>({results:[{type:'launch',id:'l1',result:'closed',windowClosed:false,windowReason:'有多个同名终端窗口，请手动关闭'},
    {type:'joint',id:'j1',result:'pid-mismatch'},{type:'launch',id:'l2',result:'not-running'}]});
  await h.app.actions.closeAllRunning();const message=h.toast().textContent;
  assert.match(message,/已关闭 1 个会话/);assert.match(message,/有 1 个终端窗口需要手动关闭/);assert.match(message,/有多个同名终端窗口/);assert.match(message,/PID/);assert.match(message,/不在运行/);
});

test('v013 an absent terminal or no-wt fallback is not falsely reported as requiring manual close',async t=>{
  const h=await fixture(t);h.data.running[1].terminalFallback='no-wt';await h.app.actions.refreshRunning();
  h.data.close=()=>[{type:'launch',id:'l1',result:'closed',windowClosed:false,windowReason:'终端窗口已不存在'}, {type:'joint',id:'j1',result:'closed',windowClosed:false}];
  await h.app.actions.closeAllRunning();assert.match(h.toast().textContent,/已关闭 2 个会话/);assert.match(h.toast().textContent,/终端窗口已不存在/);assert.doesNotMatch(h.toast().textContent,/需要手动关闭/);
});

test('v013 network failure resets busy and refreshes safely without retrying destructive POST',async t=>{
  const h=await fixture(t);h.data.close=()=>{throw new Error('合成连接中断');};
  await h.app.actions.closeAllRunning();assert.equal(h.app.snapshot().state.closeRunningBusy,false);assert.equal(h.posts().length,1);
  assert.match(h.toast().textContent,/合成连接中断/);assert.doesNotMatch(h.toast().textContent,/已关闭 2/);
  assert.ok(h.requests.slice(h.requests.indexOf(h.posts()[0])+1).some(r=>r.url==='/api/running'));
});

test('v013 invalid close responses never claim success and never retry',async t=>{
  const h=await fixture(t);
  for(const value of [{}, {items:[]}, {items:[{type:'launch',id:'other',result:'closed',windowClosed:true}]}, {items:[{type:'launch',id:'l1',result:'closed',windowClosed:true},{type:'launch',id:'l1',result:'closed',windowClosed:true}]}]){
    h.data.close=()=>value;await h.app.actions.closeRunning('launch','l1');assert.match(h.toast().textContent,/结果.*无效/);assert.doesNotMatch(h.toast().textContent,/已关闭 1/);
  }
  assert.equal(h.posts().length,4);
});

test('v013 pre-close running reads cannot restore closed rows after the close refresh',async t=>{
  const h=await fixture(t),old=deferred();let reads=0;
  h.data.readRunning=()=>++reads===1?old.promise:{items:[]};const pending=h.app.actions.refreshRunning();
  await h.app.actions.closeAllRunning();old.resolve({items:rows()});await pending;assert.deepEqual(h.app.snapshot().running,[]);
});

test('v013 disposed confirmation and in-flight POST never trigger later actions, refreshes or toasts',async t=>{
  const gate=deferred(),h=await fixture(t,'threepane',{confirm:()=>gate.promise});const pending=h.app.actions.closeAllRunning();await tick();h.app.dispose();gate.resolve(true);await pending;assert.equal(h.posts().length,0);
  const later=await fixture(t),post=deferred();later.data.close=()=>post.promise;const started=later.app.actions.closeAllRunning();await tick();later.app.dispose();const before=later.requests.length;
  post.resolve({items:rows().map(({type,id})=>({type,id,result:'closed',windowClosed:true}))});await started;
  assert.equal(later.requests.length,before);assert.equal(later.doc.getElementById('running-close-status'),undefined);
});

test('v013 native confirm acceptance restores a usable focus target when the last row disappears',async t=>{
  const h=await fixture(t,'threepane',{native:true});h.data.running=[rows()[0]];await h.app.actions.showView('running');
  // Model native focus: disabled controls cannot receive focus.
  const create=h.doc.createElement;h.doc.createElement=tag=>{const n=create(tag),focus=n.focus.bind(n);n.focus=()=>{if(!n.disabled)focus();};return n;};
  const trigger=h.doc.querySelector('[data-close-running]');const pending=trigger.fire('click');await tick();
  h.data.close=body=>{h.data.running=[];return{items:body.items.map(r=>({...r,result:'closed',windowClosed:true}))};};
  await h.doc.getElementById('confirm-accept').fire('click');await pending;
  assert.equal(h.doc.activeElement,h.doc.getElementById('running-title'));
});

test('v013 canceling close-all restores focus even though its persistent trigger was disabled',async t=>{
  const h=await fixture(t,'shelf',{native:true});await h.app.actions.showView('running');
  const all=h.doc.getElementById('running-close-all'),focus=all.focus.bind(all);all.focus=()=>{if(!all.disabled)focus();};
  const pending=all.fire('click');await tick();await h.doc.getElementById('confirm-cancel').fire('click');await pending;
  assert.equal(h.doc.activeElement,all);assert.equal(h.posts().length,0);
});

test('v013 close-all above API limit uses one confirmation and sequential batches of at most 50',async t=>{
  let prompts=0;const h=await fixture(t,'bento',{confirm:async()=>{prompts++;return true;}});
  h.data.running=Array.from({length:51},(_,i)=>({...rows()[0],id:`l${i}`}));await h.app.actions.refreshRunning();
  await h.app.actions.closeAllRunning();assert.equal(prompts,1);assert.deepEqual(h.posts().map(r=>r.body.items.length),[50,1]);
  assert.equal(h.toast().textContent,'已关闭 51 个会话');
});

test('v013 a later batch failure retains confirmed outcomes, stops without retries and refreshes',async t=>{
  const h=await fixture(t);h.data.running=Array.from({length:101},(_,i)=>({...rows()[0],id:`l${i}`}));await h.app.actions.refreshRunning();let batch=0;
  h.data.close=body=>{if(++batch===2)throw new Error('第二批断开');return{items:body.items.map(r=>({...r,result:'closed',windowClosed:true}))};};
  await h.app.actions.closeAllRunning();assert.equal(h.posts().length,2);assert.match(h.toast().textContent,/已关闭 50 个会话/);assert.match(h.toast().textContent,/第二批断开/);
});

for(const ui of ['threepane','bento','editorial','shelf'])test(`v013 ${ui}: heading/row controls, far-right order, busy and empty states, neutral resumable history`,async t=>{
  const h=await fixture(t,ui),gate=deferred();await h.app.actions.showView('running');h.data.close=()=>gate.promise;
  const all=h.doc.getElementById('running-close-all'),list=h.doc.getElementById('running-list');assert.ok(all);assert.equal(all.textContent,'全部关闭');assert.equal(all.disabled,false);
  assert.ok(all.parentElement.querySelector('h2') || all.parentElement.querySelector('#running-title'),'close-all sits beside heading');
  const buttons=list.querySelectorAll('[data-close-running]');assert.equal(buttons.length,2);
  assert.equal(buttons[0].getAttribute('aria-label'),'关闭 甲 会话');assert.equal(buttons[1].getAttribute('aria-label'),'关闭 联合调用：乙、丙 会话');
  for(const b of buttons)assert.equal(b.parentElement.children.at(-1),b,'close control is last in its row');
  const pending=buttons[0].fire('click');await tick();
  // Claude acceptance: everything is disabled while closing, but only the confirmed row says 正在关闭… and close-all keeps its label.
  assert.equal(h.doc.getElementById('running-close-all').disabled,true);assert.equal(h.doc.getElementById('running-close-all').textContent,'全部关闭');
  const [closing,other]=list.querySelectorAll('[data-close-running]');assert.equal(closing.disabled,true);assert.equal(closing.textContent,'正在关闭…');
  assert.equal(other.disabled,true);assert.equal(other.textContent,'关闭');
  h.data.running=[];gate.resolve({items:[{type:'launch',id:'l1',result:'closed',windowClosed:true}]});await pending;assert.equal(h.doc.getElementById('running-close-all').disabled,true);
  await h.app.actions.showView('history');const badges=h.doc.getElementById('history-list').querySelectorAll('[data-tone="neutral"]');assert.ok(badges.some(b=>b.textContent==='已关闭'));
  await h.app.actions.resumeHistory('launch','l1');assert.deepEqual(h.requests.find(r=>r.url==='/api/resume').body,{agentId:'甲',launchId:'l1'});
});

test('v013 closed history preserves canResume and is terminal for launch polling',()=>{
  const view=toHistoryView(historyRows()[0]);assert.equal(view.statusTone,'neutral');assert.equal(view.canResume,true);assert.equal(view.status.overall,'closed');assert.equal(pollFinished(view.status),true);
});

test('v013 CSS keeps closing controls right-aligned and closed status neutral without inline style',async()=>{
  const css=await allStyles();assert.match(css,/\.running-close-row\s*\{[^}]*display:\s*flex/);assert.match(css,/\.running-close-button\s*\{[^}]*margin-left:\s*auto/);
  for(const ui of ['threepane','bento','editorial','shelf']){const sheet=await fs.readFile(`public/layouts/${ui}.css`,'utf8');assert.match(sheet,/data-tone="neutral"/);}
});

test('v013 confirmation uses specific wording and a destructive accept only for closing sessions', async () => {
  const { createConfirmation } = await import('../public/accessibility.js');
  const el = () => ({ id: '', className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, focus() {} });
  const dialog = { ...el(), showModal() {}, close() {}, open: false, querySelectorAll: () => [] };
  const parts = { dialog, title: el(), body: el(), cancel: el(), accept: el() };
  const confirm = createConfirmation({ activeElement: null, querySelectorAll: () => [] }, parts);
  void confirm('关闭 甲 的 Codex 会话？', null, { title: '关闭会话', accept: '关闭', danger: true });
  assert.equal(parts.title.textContent, '关闭会话'); assert.equal(parts.accept.textContent, '关闭'); assert.equal(parts.accept.className, 'danger');
});

test('v013 a joint closed before its first verification renders in every layout without cwd',async()=>{
  const {documentFrom}=await import('./fixtures/dom.mjs');
  const record={id:'j1',cli:'claude',whitelist:[{id:'甲',claudeName:'甲',codexName:'甲'}]};
  for(const id of ['threepane','bento','editorial','shelf']){
    const {drawJointStatus}=await import(`../public/layouts/${id}.js`);const doc=documentFrom('<body></body>');
    // closedStatus(record, {}) shape: process only, no cwd/parallel.
    const closed=doc.createElement('article');drawJointStatus(doc,closed,record,{overall:'closed',message:'已关闭（用户）',process:{state:'exited',pid:7}});
    assert.match(closed.textContent,/整体：.*进程：/,id);assert.doesNotMatch(closed.textContent,/目录：/,id);assert.match(closed.textContent,/已关闭（用户）/,id);
    const bare=doc.createElement('article');drawJointStatus(doc,bare,record,{overall:'closed',message:'已关闭（用户）'});
    assert.doesNotMatch(bare.textContent,/进程：|目录：/,id);
    const full=doc.createElement('article');drawJointStatus(doc,full,record,{overall:'unconfirmed',process:{state:'exited'},cwd:{state:'confirmed'},message:'核验中'});
    assert.match(full.textContent,/进程：.*目录：/,id);
  }
});
