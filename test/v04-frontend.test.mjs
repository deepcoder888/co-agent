import { appDocument, allStyles } from './fixtures/app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createCard, fillDetails, renderRunning, renderHistory, mountApp } from '../public/app.js';
import { manageDialog, createConfirmation } from '../public/accessibility.js';

class Element {
  constructor(doc,tag){this.doc=doc;this.tagName=tag;this.children=[];this.attrs={};this.events={};this._text='';this.hidden=false;this.isConnected=true;}
  set textContent(s){this._text=String(s);this.children=[];} get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  replaceChildren(...nodes){for(const n of this.children)n.isConnected=false;this.children=[];this._text='';this.append(...nodes);}
  setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k];}
  addEventListener(k,fn){(this.events[k]??=[]).push(fn);} removeEventListener(k,fn){this.events[k]=(this.events[k]||[]).filter(f=>f!==fn);}
  fire(k,event={}){event.target??=this;event.currentTarget=this;for(const f of this.events[k]||[])f(event);}
  focus(){this.doc.activeElement=this;} showModal(){this.open=true;} close(){this.open=false;this.fire('close');}
  querySelectorAll(selector){const all=descendants(this).slice(1);if(selector==='[data-focus-key]')return all.filter(n=>n.attrs['data-focus-key']);return all.filter(n=>['button','input','select','textarea','summary','a'].includes(n.tagName)&&!n.disabled);}
  contains(n){return descendants(this).includes(n);}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
function documentFixture(){const doc={activeElement:null,createElement:tag=>new Element(doc,tag),createElementNS:(_ns,tag)=>new Element(doc,tag),events:{},addEventListener(k,f){this.events[k]=f;},removeEventListener(){},querySelectorAll:()=>[]};return doc;}
const book={id:'harlo',name:'Harlo',kind:'book',primary:'历史',description:'内容',book:{title:'书',author:'作者',edition:'版'},tags:[],sourceFile:'source',sources:{checked:true,total:3,missing:['D:\\missing.epub']},sync:{state:'指令不同',detail:'body differs'},platforms:{claude:{available:true},codex:{available:false,reason:'CLI 不可用'}}};
test('K3/K6/K7 cards use named actions, disabled reason linkage, text badges; details include advisory commands only',()=>{
  const doc=documentFixture(), {card}=createCard(doc,book,{categories:[],onDetails(){},onLaunch(){}});
  const all=descendants(card);assert.match(card.textContent,/原书路径失效 1 处/);assert.match(card.textContent,/不同步/);
  const launch=all.find(n=>n.textContent==='在 Claude CLI 中调用');assert.equal(launch.attrs['aria-label'],'在 Claude CLI 中调用 Harlo');
  const disabled=all.find(n=>n.textContent==='在 Codex CLI 中调用'); assert.equal(disabled.disabled,true);
  assert.ok(all.some(n=>n.id===disabled.attrs['aria-describedby']&&n.textContent==='CLI 不可用'));
  const detail=new Element(doc,'div');fillDetails(doc,detail,book);
  for(const text of ['D:\\missing.epub','rebind_book_sources.py','dry-run','对照差异手动更新 Claude 版本','保留其中专为 Claude 写的工具映射段'])assert.ok(detail.textContent.includes(text));
  assert.doesNotMatch(detail.textContent,/删除过期|port_codex_agents/);
  assert.ok(!descendants(detail).some(n=>n.tagName==='button'&&/rebind|port_codex/.test(n.textContent)));
});
test('K7 dialog moves focus, traps forward/backward Tab, Esc closes, returns focus including native close',()=>{
  const doc=documentFixture(),trigger=new Element(doc,'button'),dialog=new Element(doc,'dialog'),first=new Element(doc,'button'),last=new Element(doc,'button');dialog.id='detail';dialog.append(first,last);trigger.focus();
  const controller=manageDialog(doc,dialog,{labelledby:'title'});controller.open();assert.equal(doc.activeElement,first);
  assert.equal(dialog.attrs.role,'dialog');assert.equal(dialog.attrs['aria-modal'],'true');assert.equal(dialog.attrs['aria-labelledby'],'title');
  let prevented=false;last.focus();dialog.fire('keydown',{key:'Tab',preventDefault(){prevented=true;}});assert.equal(doc.activeElement,first);assert.equal(prevented,true);
  first.focus();dialog.fire('keydown',{key:'Tab',shiftKey:true,preventDefault(){}});assert.equal(doc.activeElement,last);
  dialog.fire('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(dialog.open,false);assert.equal(doc.activeElement,trigger);
  controller.open();dialog.close();assert.equal(doc.activeElement,trigger);
});
test('K7 confirmation is a modal dialog with safe default cancel, accepts/cancels asynchronously and restores focus',async()=>{
  const doc=documentFixture(), trigger=new Element(doc,'button'),dialog=new Element(doc,'dialog'),title=new Element(doc,'h2'),body=new Element(doc,'p'),cancel=new Element(doc,'button'),accept=new Element(doc,'button');
  dialog.id='confirm';dialog.append(title,body,cancel,accept);trigger.focus();
  const confirm=createConfirmation(doc,{dialog,title,body,cancel,accept});
  const pending=confirm('原书路径失效，确认 Harlo');assert.equal(doc.activeElement,cancel);assert.match(body.textContent,/Harlo/);
  accept.fire('click');assert.equal(await pending,true);assert.equal(doc.activeElement,trigger);
  const next=confirm('可写');dialog.fire('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(await next,false);assert.equal(doc.activeElement,trigger);
});
test('K7 focus returns to the replacement trigger after a registry/stats repaint',()=>{
  const doc=documentFixture(),trigger=new Element(doc,'button'),replacement=new Element(doc,'button'),dialog=new Element(doc,'dialog'),inside=new Element(doc,'button');
  trigger.setAttribute('data-focus-key','card-harlo');replacement.setAttribute('data-focus-key','card-harlo');doc.querySelectorAll=()=>[replacement];dialog.append(inside);trigger.focus();
  const controller=manageDialog(doc,dialog);controller.open();trigger.isConnected=false;controller.close();assert.equal(doc.activeElement,replacement);
});
test('K7 sequential confirmations wait for native asynchronous close events without cancelling the next dialog',async()=>{
  const doc=documentFixture(),dialog=new Element(doc,'dialog'),title=new Element(doc,'h2'),body=new Element(doc,'p'),cancel=new Element(doc,'button'),accept=new Element(doc,'button');dialog.append(title,body,cancel,accept);
  dialog.close=()=>{dialog.open=false;setImmediate(()=>dialog.fire('close'));};
  const confirm=createConfirmation(doc,{dialog,title,body,cancel,accept});
  const both=(async()=>[await confirm('可写确认'),await confirm('路径确认')])();
  accept.fire('click');await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(dialog.open,true);assert.equal(body.textContent,'路径确认');accept.fire('click');assert.deepEqual(await both,[true,true]);
});
test('K3/K4/K7 mounted app awaits source confirmation, cancel starts nothing, details expose launch/resume and return focus',async t=>{
  const {doc,ids}=await appDocument('bento','token');
  const registry={agents:[book],categories:['历史'],summary:{roles:0,books:1,uncategorized:0,outOfScope:0,failed:0,synced:0,inScope:1},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[],scannedAt:'2026-10-06T00:00:00Z'};
  const stats={sources:[],perAgent:{},limitedReasons:[],outOfScopeEvents:0,unlabeledSubagents:0};const calls=[];let approved=false;
  const mounted=await mountApp(doc,async(url,options)=>{
    calls.push({url,options});const value=url==='/api/stats'?stats:url.startsWith('/api/history/')?{items:[{launchId:'original',createdAt:'2026-10-06T16:00:00Z',cli:'claude',mode:'agent'}],unavailable:[]}:['/api/launch','/api/resume'].includes(url)?{launchId:'new'}:url.startsWith('/api/launch/')?{overall:'unconfirmed',message:'启动未确认',process:{state:'alive'},cwd:{state:'pending'},agent:{state:'pending'},waiting:{state:'pending'}}:url==='/api/registry'?registry:url==='/api/settings'?{recommend:{}}:{items:[]};return{ok:true,json:async()=>value};
  },{confirm:async()=>approved});t.after(()=>mounted.dispose()); mounted.actions.search('harlo');
  const invoke=()=>descendants(ids.cards).find(n=>n.textContent==='在 Claude CLI 中调用');invoke().fire('click');await new Promise(r=>setImmediate(r));assert.ok(!calls.some(c=>c.url==='/api/launch'));
  approved=true;invoke().fire('click');await new Promise(r=>setImmediate(r));assert.deepEqual(JSON.parse(calls.find(c=>c.url==='/api/launch').options.body),{agentId:'harlo',cli:'claude',sourcesConfirmed:true});
  const trigger=descendants(ids.cards).find(n=>n.attrs['aria-label']==='查看 Harlo 详情');trigger.focus();trigger.fire('click');await new Promise(r=>setImmediate(r));assert.equal(ids.detail.open,true);assert.equal(doc.activeElement,ids['close-detail']);
  const resume=descendants(ids['detail-body']).find(n=>n.attrs['aria-label']?.startsWith('继续上次会话 Harlo'));assert.ok(resume);resume.fire('click');await new Promise(r=>setImmediate(r));assert.deepEqual(JSON.parse(calls.find(c=>c.url==='/api/resume').options.body),{agentId:'harlo',launchId:'original',sourcesConfirmed:true});
  ids.detail.fire('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(ids.detail.open,false);assert.ok(doc.activeElement.attrs['aria-label']?.includes('Harlo'));
});
test('K4/K5 history buttons and running panel show name, Shanghai time, CLI/mode and missing explanation',()=>{
  const doc=documentFixture(),target=new Element(doc,'div');let chosen;
  renderHistory(doc,target,book,{items:[{launchId:'a',createdAt:'2026-10-06T16:00:00Z',cli:'claude',mode:'relay'}],unavailable:[{reason:'会话文件不存在'}]},item=>chosen=item);
  assert.match(target.textContent,/2026-10-07 00:00:00.*claude.*relay/);assert.match(target.textContent,/会话文件不存在/);
  const action=descendants(target).find(n=>n.tagName==='button');assert.match(action.attrs['aria-label'],/继续上次会话 Harlo/);action.fire('click');assert.equal(chosen.launchId,'a');
  renderRunning(doc,target,{items:[{type:'joint',whitelist:[{codexName:'Harlo'},{codexName:'-steven'}],cli:'codex',createdAt:'2026-10-06T16:00:00Z',status:{overall:'pending'}}]});
  for(const text of ['Harlo','-steven','codex','2026-10-07 00:00:00','待核验'])assert.ok(target.textContent.includes(text));assert.equal(descendants(target).filter(n=>n.tagName==='button').length,0);
});
const luminance=hex=>{const rgb=hex.match(/\w\w/g).map(s=>parseInt(s,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
test('H3 history reverify uses named button, busy state, stable live announcement, refreshed list and failure retry', async()=>{
  const doc=documentFixture(),target=new Element(doc,'section');let resolve,fail=false,calls=0;
  const onReverify=()=>{calls++;return fail?Promise.reject(new Error('读取失败')):new Promise(r=>resolve=r);};
  renderHistory(doc,target,book,{items:[],unavailable:[{canReverify:true,reason:'尚未核验'}]},()=>{},onReverify);
  const action=descendants(target).find(n=>n.textContent==='重新核验旧记录');assert.ok(action);assert.equal(action.attrs['aria-label'],'重新核验 Harlo 的旧记录');
  const live=descendants(target).find(n=>n.attrs['aria-live']==='polite');assert.ok(live);
  action.fire('click');action.fire('click');assert.equal(calls,1);assert.equal(action.disabled,true);assert.match(live.textContent,/正在/);
  resolve({summary:{checked:2,found:1,notFound:1},history:{items:[{launchId:'found',cli:'codex',mode:'relay',createdAt:'2026-10-06T00:00:00Z'}],unavailable:[{canReverify:true,reason:'不存在'}]}});
  await new Promise(r=>setImmediate(r));assert.equal(live.textContent,'已核验 2 条：找到 1 条，未找到 1 条');assert.ok(descendants(target).includes(live));assert.match(target.textContent,/codex/);
  fail=true;action.fire('click');await new Promise(r=>setImmediate(r));assert.match(live.textContent,/读取失败/);assert.equal(action.disabled,false);
  fail=false;action.focus();action.fire('click');resolve({summary:{checked:1,found:1,notFound:0},history:{items:[{launchId:'found',cli:'codex',mode:'relay',createdAt:'2026-10-06T00:00:00Z'}],unavailable:[]}});
  await new Promise(r=>setImmediate(r));assert.equal(action.hidden,true);assert.match(doc.activeElement.attrs['aria-label'],/继续上次会话 Harlo/);assert.equal(live.textContent,'已核验 1 条：找到 1 条，未找到 0 条');
  renderHistory(doc,target,book,{items:[],unavailable:[]},()=>{},onReverify);assert.ok(!descendants(target).some(n=>n.textContent==='重新核验旧记录'));
});
test('H3 mounted per-agent and all reverify send token POST, announce and refresh open history without spawning', async t=>{
  const {doc,ids}=await appDocument('bento','token');
  const registry={agents:[book],categories:['历史'],summary:{roles:0,books:1,uncategorized:0,outOfScope:0,failed:0},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
  let found=false;const calls=[],history=()=>({items:found?[{launchId:'found',cli:'codex',mode:'relay',createdAt:'2026-10-06T00:00:00Z'}]:[],unavailable:[{canReverify:true,reason:'旧记录'}]});
  const mounted=await mountApp(doc,async(url,options)=>{calls.push({url,options});let value;
    if(url.endsWith('/reverify')||url.endsWith('reverify-all')){found=true;value={summary:{checked:2,found:1,notFound:1},history:history()};}
    else value=url==='/api/running'?{items:[]}:url.startsWith('/api/history/')?history():url==='/api/stats'?{sources:[],perAgent:{},limitedReasons:[]}:url==='/api/registry'?registry:url==='/api/settings'?{recommend:{}}:{items:[]};
    return {ok:true,json:async()=>value};
  },{confirm:async()=>true});t.after(()=>mounted.dispose()); mounted.actions.search('harlo');
  descendants(ids.cards).find(n=>n.attrs['aria-label']==='查看 Harlo 详情').fire('click');await new Promise(r=>setImmediate(r));
  descendants(ids['detail-body']).find(n=>n.textContent==='重新核验旧记录').fire('click');await new Promise(r=>setImmediate(r));
  const per=calls.find(c=>c.url==='/api/history/harlo/reverify');assert.equal(per.options.method,'POST');assert.equal(per.options.headers['X-Co-Agent-Token'],'token');assert.match(ids['detail-body'].textContent,/已核验 2 条/);
  ids['reverify-all'].fire('click');await new Promise(r=>setImmediate(r));assert.ok(calls.some(c=>c.url==='/api/history/reverify-all'&&c.options.method==='POST'));assert.match(ids['reverify-all-status'].textContent,/已核验 2 条：找到 1 条，未找到 1 条/);
  assert.ok(!calls.some(c=>['/api/launch','/api/resume'].includes(c.url)));
});
test('K7 CSS variable color pairs satisfy text 4.5:1 and focus 3:1; reduced motion and dialog semantics present',async()=>{
  const css=await allStyles(),html=await fs.readFile('public/index.html','utf8');
  const {doc}=await appDocument(); const {layouts}=await import('../public/layouts/index.js'); const ctx={doc,refs:{},state:{},actions:{}}; layouts.threepane.render(ctx);
  const threepane=css.match(/\[data-ui="threepane"\]\s*\{([^}]+)\}/)[1];
  const vars=Object.fromEntries([...threepane.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(m=>[m[1],m[2]]));
  for(const [fg,bg,min] of [['text','bg',4.5],['text','panel',4.5],['muted','panel',4.5],['accent','panel',4.5],['danger','danger-bg',4.5],['warning','warning-bg',4.5],['focus','panel',3]]){
    assert.ok(vars[fg]&&vars[bg],`${fg}/${bg} CSS variable missing`);const a=luminance(vars[fg].slice(1)),b=luminance(vars[bg].slice(1)),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert.ok(ratio>=min,`${fg}/${bg}=${ratio}`);
  }
  assert.match(css,/prefers-reduced-motion:\s*reduce/);
  assert.equal(ctx.refs.detail.getAttribute('role'),'dialog'); assert.equal(ctx.refs.detail.getAttribute('aria-modal'),'true');
  assert.match(html,/<dialog[^>]*id="confirm"[^>]*role="dialog"[^>]*aria-modal="true"/);
  for(const id of ['recommend-submit','joint-submit'])assert.ok(ctx.refs[id].getAttribute('aria-describedby'));
});
