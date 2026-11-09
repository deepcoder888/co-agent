import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appDocument} from './fixtures/app.mjs';
import {descendants} from './fixtures/dom.mjs';
import {mountApp} from '../public/app.js';

const storageKey='co-agent.threepane.reading-expanded';
function storage(initial) {
  const values=new Map(initial===undefined?[]:[[storageKey,initial]]);
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
}
// The recording DOM has no event propagation. Model capture before bubble here,
// including cancellation, so tests detect interference from app.js shortcuts.
function keyboard(doc) {
  const handlers=[];
  doc.addEventListener=(type,fn,options)=>handlers.push({type,fn,capture:options===true||!!options?.capture});
  doc.removeEventListener=(type,fn)=>{const i=handlers.findIndex(h=>h.type===type&&h.fn===fn);if(i>=0)handlers.splice(i,1);};
  const press=async(key,extra={})=>{
    let stopped=false;
    const e={key,target:doc.activeElement||doc.body,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},
      stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;},...extra};
    for(const h of handlers.filter(h=>h.type==='keydown'&&h.capture)){await h.fn(e);if(stopped)return e;}
    for(let target=e.target;target;target=target.parentElement){await target.fire('keydown',e);if(stopped)return e;}
    for(const h of handlers.filter(h=>h.type==='keydown'&&!h.capture)){await h.fn(e);if(stopped)break;}
    return e;
  };
  return {press,handlers};
}
const agents=['role','book'].map((kind,i)=>({id:`a${i}`,name:`阅读作者${i}`,kind,primary:'学习',tags:[],description:'阅读说明',
  book:kind==='book'?{title:'书名',author:'作者'}:undefined,platforms:{claude:{available:true},codex:{available:true}},
  permissions:{},sources:{checked:true,missing:[]},sync:{state:'同步'}}));
const registry={agents,categories:['学习'],summary:{roles:1,books:1,synced:2},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]};
const concept={conceptId:'c1',status:'done',day:'2026-10-08',agent:{id:'a1',name:'作者',title:'书名'},
  result:{concept:'测试概念',term:{zh:'能量',en:'Energy',fr:'Énergie'},markdown:'## 阅读正文\n\n保持内容'},perspectives:[]};
const seminar={seminarId:'s1',input:'研讨问题',status:'failed',error:'测试失败',result:null};
async function fixture(t,store=storage()) {
  const {doc,ids}=await appDocument('threepane');doc.defaultView={localStorage:store};const keys=keyboard(doc);
  const create=doc.createElement,svg=doc.createElementNS;
  const guard=el=>{const set=el.setAttribute.bind(el);el.setAttribute=(key,value)=>{assert.notEqual(key,'style');set(key,value);};
    Object.defineProperty(el,'innerHTML',{set(){assert.fail('innerHTML is forbidden');}});return el;};
  doc.createElement=tag=>guard(create(tag));doc.createElementNS=(ns,tag)=>guard(svg(ns,tag));
  doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};
  const app=await mountApp(doc,async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;let value={items:[],unavailable:[]};
    if(url==='/api/registry')value=registry;
    else if(url==='/api/settings')value={ui:body?.ui||'threepane'};
    else if(url==='/api/stats')value={perAgent:{},sources:[],limitedReasons:[]};
    else if(url.startsWith('/api/history?'))value={items:[{id:'h1',type:'launch',agents:[agents[0]],cli:'codex',status:{overall:'ready'}}]};
    else if(url==='/api/concepts?limit=30')value={items:[concept],today:{conceptId:'c1'},running:null};
    else if(url==='/api/concepts/c1')value=concept;
    else if(url==='/api/seminars?limit=30')value={items:[seminar],running:null};
    else if(url==='/api/seminars/s1')value=seminar;
    return {ok:true,json:async()=>structuredClone(value)};
  },{confirm:async()=>true});
  t.after(()=>app.dispose());
  return {doc,ids,app,store,...keys,button:()=>doc.querySelector('.reading-toggle'),middle:()=>doc.querySelector('.mail-list')};
}
function expanded(f,expected) {
  assert.equal(f.button()?.getAttribute('aria-pressed'),String(expected));
  assert.equal(f.middle().getAttribute('inert')!==null,expected);
  assert.equal(f.middle().getAttribute('aria-hidden'),expected?'true':null);
  assert.equal(f.doc.querySelector('.layout-threepane').className.split(/\s+/).includes('reading-expanded'),expected);
}

test('v012 toggle has reciprocal SVG/aria states, stays focused and keeps mounted DOM and selection',async t=>{
  const f=await fixture(t),{doc,ids,app}=f,button=f.button();assert.ok(button);
  assert.equal(button.getAttribute('aria-label'),'展开阅读');assert.equal(button.title,'展开阅读（隐藏中栏）');
  assert.equal(button.getAttribute('aria-controls'),f.middle().id);expanded(f,false);
  assert.ok(button.querySelector('svg'));const icon=button.querySelector('path').getAttribute('d');
  ids.search.value='阅读';await ids.search.fire('input');const before=app.snapshot().state;
  const middle=f.middle(),card=ids.cards.children[0],detail=ids['detail-body'].children[0];middle.scrollTop=173;
  ids.search.focus();await button.fire('click');expanded(f,true);
  assert.equal(doc.activeElement,button);assert.equal(button.getAttribute('aria-label'),'恢复三栏');assert.equal(button.title,'恢复三栏');
  assert.notEqual(button.querySelector('path').getAttribute('d'),icon);
  // Native inert is the browser's tab/accessibility exclusion primitive. This
  // fixture records that contract; it cannot prove a real browser's Tab behavior.
  const tabStops=descendants(middle).filter(n=>['INPUT','BUTTON','TEXTAREA','SELECT','A'].includes(n.tagName)&&!n.closest('[inert]'));
  assert.equal(tabStops.length,0);assert.equal(middle.isConnected,true);
  await button.fire('click');expanded(f,false);assert.equal(doc.activeElement,button);
  assert.equal(f.middle(),middle);assert.equal(middle.scrollTop,173);assert.equal(ids.cards.children[0],card);
  assert.equal(ids['detail-body'].children[0],detail);assert.equal(ids.search.value,'阅读');
  const {date:beforeTime,...saved}=before,{date:afterTime,...restored}=app.snapshot().state;assert.deepEqual(restored,saved);
});

test('v012 localStorage survives fresh viewers and collapse, without changing unrelated keys',async t=>{
  const store=storage(),first=await fixture(t,store);store.values.set('unrelated','keep');
  await first.button().fire('click');assert.equal(store.getItem(storageKey),'true');
  const second=await fixture(t,store);expanded(second,true);
  await second.button().fire('click');assert.equal(store.getItem(storageKey),'false');
  const third=await fixture(t,store);expanded(third,false);assert.equal(store.getItem('unrelated'),'keep');
  const separate=await fixture(t);expanded(separate,false);
});

test('v012 unavailable, throwing and malformed storage default collapsed; writing never crashes',async t=>{
  for(const store of [null,{getItem(){throw Error('denied');},setItem(){throw Error('quota');}},storage('garbage')]){
    const f=await fixture(t,store);expanded(f,false);await f.button().fire('click');expanded(f,true);await f.button().fire('click');expanded(f,false);
  }
  const f=await fixture(t);Object.defineProperty(f.doc.defaultView,'localStorage',{get(){throw Error('SecurityError');}});
  f.app.actions.openSettings();await f.doc.querySelectorAll('[role="radio"]')[1].fire('click');await f.doc.querySelectorAll('[role="radio"]')[0].fire('click');
  expanded(f,false);await f.button().fire('click');expanded(f,true);
});

test('v012 each left category restores middle and moves focus with the category action',async t=>{
  const f=await fixture(t);
  for(const key of ['role','book','学习']){
    await f.button().fire('click');expanded(f,true);
    const select=f.doc.querySelector(`[data-focus-key="nav-${key}"]`);select.focus();await select.fire('click');expanded(f,false);
    assert.equal(f.app.snapshot().state.category,key);assert.equal(f.doc.activeElement.getAttribute('data-focus-key'),`nav-${key}`);
    assert.equal(f.store.getItem(storageKey),'false');
  }
});

test('v012 slash and Ctrl+K restore and focus global search, also from concepts and stats',async t=>{
  const f=await fixture(t);
  for(const view of ['catalog','concepts','stats']){
    if(view==='concepts')await f.app.actions.openConcepts();else if(view==='stats')await f.app.actions.openStats();
    for(const [key,extra] of [['/',{}],['K',{ctrlKey:true}]]){
      if(f.button().getAttribute('aria-pressed')==='false')await f.button().fire('click');
      f.button().focus();const event=await f.press(key,extra);expanded(f,false);
      assert.equal(event.defaultPrevented,true);assert.equal(f.doc.activeElement,f.ids.search);assert.equal(f.app.snapshot().state.view,view);
    }
  }
});

test('v012 slash typing in editors is untouched; search input always restores before querying',async t=>{
  const f=await fixture(t);await f.app.actions.openConcepts();await f.button().fire('click');
  // Synthetic input targets also check the shortcut guard without a native focus engine.
  const e=await f.press('/',{target:f.doc.getElementById('builder-input')});assert.equal(e.defaultPrevented,false);expanded(f,true);
  f.ids.search.value='阅读';await f.ids.search.fire('input');expanded(f,false);
  assert.equal(f.app.snapshot().state.query,'阅读');assert.equal(f.doc.activeElement,f.ids.search);
});

test('v012 Escape restores without clearing query or leaving the active view',async t=>{
  const f=await fixture(t);f.ids.search.value='阅读';await f.ids.search.fire('input');await f.app.actions.openConcepts();
  await f.button().fire('click');await f.press('Escape');expanded(f,false);
  assert.equal(f.app.snapshot().state.query,'阅读');assert.equal(f.app.snapshot().state.view,'concepts');assert.equal(f.doc.activeElement,f.button());
});

test('v012 Escape and search shortcuts respect dialogs and visible menus/selectors',async t=>{
  const f=await fixture(t);await f.button().fire('click');f.app.actions.openSettings(f.button());
  const dialog=f.doc.querySelectorAll('dialog').find(d=>d.open);assert.ok(dialog);dialog.focus();
  await f.press('Escape');assert.equal(dialog.open,false);expanded(f,true);
  for(const role of ['menu','listbox']){
    const popup=f.doc.createElement('div');popup.setAttribute('role',role);f.doc.body.append(popup);popup.focus();
    popup.addEventListener('keydown',e=>{if(e.key==='Escape'){popup.hidden=true;e.preventDefault();e.stopPropagation();}});
    await f.press('k',{ctrlKey:true});expanded(f,true);assert.equal(f.doc.activeElement,popup);
    await f.press('Escape');expanded(f,true);assert.equal(popup.hidden,true);popup.remove();
  }
  await f.press('Escape');expanded(f,false);
});

test('v012 already handled Escape cannot collapse reading when an earlier capture listener closes a popup',async t=>{
  const f=await fixture(t);await f.button().fire('click');
  // Recreate ordering after switching back to this layout: a shared capture
  // handler can run first and mark the event handled while removing its menu.
  f.app.actions.openSettings();await f.doc.querySelectorAll('[role="radio"]')[1].fire('click');
  f.doc.addEventListener('keydown',e=>{if(e.key==='Escape')e.preventDefault();},true);
  await f.doc.querySelectorAll('[role="radio"]')[0].fire('click');
  const dialog=f.doc.querySelectorAll('dialog').find(d=>d.open);dialog.close();
  await f.press('Escape');expanded(f,true);
});

test('v012 Escape from a closed select restores reading without stealing its focus',async t=>{
  const f=await fixture(t);f.app.actions.showView('recommend');await f.button().fire('click');
  f.ids['recommend-engine'].focus();const escape=await f.press('Escape');expanded(f,false);assert.equal(escape.defaultPrevented,true);
  assert.equal(f.doc.activeElement,f.ids['recommend-engine']);
});

test('v012 one button follows all right views and shares expansion without focusing the inert pane',async t=>{
  const f=await fixture(t),button=f.button();await button.fire('click');
  for(const view of ['concepts','history','running','stats','coverage','recommend','catalog']){
    if(view==='concepts')await f.app.actions.openConcepts();
    else if(view==='stats')await f.app.actions.openStats();else f.app.actions.showView(view);
    assert.equal(f.button(),button);assert.equal(f.doc.querySelectorAll('.reading-toggle').length,1);assert.ok(button.closest('.mail-detail'));
    assert.ok(!button.closest('[hidden]'),view);expanded(f,true);assert.ok(!f.middle().contains(f.doc.activeElement),view);
    if(view==='concepts')assert.equal(button.parentElement,f.ids['concepts-panel'].querySelector('.concept-toolbar'));
  }
});

test('v012 no selection reveals the middle and empty right pane cannot trap the viewer',async t=>{
  const f=await fixture(t);await f.button().fire('click');f.app.actions.search('不存在的名称');expanded(f,false);
  assert.equal(f.app.snapshot().state.selectedId,null);assert.equal(f.button().disabled,true);
  await f.button().fire('click');expanded(f,false);assert.equal(f.middle().getAttribute('inert'),null);
});

test('v012 layout switches keep viewer preference and app state; listeners are disposed',async t=>{
  const f=await fixture(t);f.ids.search.value='阅读';await f.ids.search.fire('input');await f.app.actions.openConcepts();
  await f.button().fire('click');const before=f.app.snapshot();f.app.actions.openSettings();const initial=f.handlers.length;
  for(const i of [1,0,2,0,3,0]){
    await f.doc.querySelectorAll('[role="radio"]')[i].fire('click');assert.equal(f.app.snapshot().state.query,before.state.query);
    assert.equal(f.app.snapshot().state.selectedId,before.state.selectedId);assert.equal(f.app.snapshot().concepts.selected.conceptId,'c1');
    if(i===0){expanded(f,true);assert.equal(f.handlers.length,initial);}else assert.equal(f.button(),null);
  }
});

test('v012 stylesheet centres all reading content at 72ch, collapses width/opacity, scopes reduced motion and uses classes',async t=>{
  const f=await fixture(t);await f.button().fire('click');for(const n of descendants(f.ids['layout-root']))assert.equal(n.getAttribute('style'),null);
  const css=(await fs.readFile('public/layouts/threepane.css','utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
  const blocks=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const collapsed=blocks.filter(([,selector])=>selector.includes('.reading-expanded .mail-list')).map(([, ,body])=>body).join(';');
  assert.match(collapsed,/(?:max-)?width:\s*0/);assert.match(collapsed,/opacity:\s*0/);assert.match(collapsed,/flex(?:-basis)?:[^;]*\b0/);
  const measure=blocks.find(([,selector,body])=>selector.includes('.reading-expanded .mail-detail >')&&/72ch/.test(body));assert.ok(measure);assert.match(measure[2],/margin-inline:\s*auto/);
  assert.match(css,/transition:[^;{}]*200ms ease/);assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\[data-ui="threepane"\][^{]*\{\s*transition:\s*none/);
  for(const [,selectors]of blocks)for(const selector of selectors.split(','))assert.ok(selector.trim().startsWith('[data-ui="threepane"]'),selector);
  const js=await fs.readFile('public/layouts/threepane.js','utf8');assert.doesNotMatch(js,/innerHTML|cssText|setAttribute\(['"]style/);
});
