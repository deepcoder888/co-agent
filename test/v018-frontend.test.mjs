import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { mountCandidates } from '../public/candidates.js';

const categories = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json','utf8')).categories;
const candidate = { id:'newbook',name:'NewBook',description:'<script>never executable</script> book Agent',hasReadingMd:true,bookFiles:[{path:'private.epub'}] };
const suggestion = {id:'newbook',title:'《书名》',author:'作者',edition:'2026',primary:categories[2]};
const baseRegistry = () => ({agents:[],candidates:[candidate],categories,summary:{roles:0,books:0,candidates:1},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]});
const flush = () => new Promise(r=>setTimeout(r,0));
async function setup(t,{pending=false,fail=false}={}) {
  const {doc,ids}=await appDocument(); let r=baseRegistry(), resolve, refreshed=0; const requests=[],messages=[];
  const promise=new Promise(r=>{resolve=r;});
  const controller=mountCandidates(doc,{ getRegistry:()=>r,notify:text=>messages.push(text),onChanged:async()=>{refreshed++;r={...r,candidates:[]};},api:async(url,body)=>{
    requests.push({url,body});
    if(url.endsWith('/suggest')) { if(fail)throw Error('fixture timeout'); return pending?promise:[suggestion]; }
    if(url.endsWith('/accept'))return {items:[{id:'newbook',accepted:true,link:'failed',linkError:'EPERM fixture'}]};
    if(url.endsWith('/ignored'))return {ids:['ignored']};
    return {ids:[]};
  }});
  t.after(()=>controller.dispose()); return {doc,ids,controller,requests,messages,resolve,get refreshed(){return refreshed;}};
}

test('v018 drawer defaults, accessible fields, sticky heading, escaped description and AI fills only untouched fields',async t=>{
  const h=await setup(t,{pending:true}); const opening=h.controller.open(); await flush();
  const d=h.ids['candidate-dialog']; assert.equal(d.open,true); assert.equal(d.getAttribute('aria-labelledby'),'candidate-title');
  assert.ok(d.querySelector('.drawer-heading')); assert.match(d.textContent,/AI 正在建议书名与分类/);
  const row=d.querySelector('[data-candidate-id="newbook"]'); assert.equal(row.querySelector('input[type="checkbox"]').checked,true);
  assert.equal(row.querySelector('select').options.length,11); assert.ok(row.querySelector('details')); assert.match(row.textContent,/原书文件 1/); assert.match(row.textContent,/Reading md/);
  assert.equal(d.querySelector('script'),null);
  const title=row.querySelector('[data-field="title"]'); title.value='我的书名'; await title.fire('input');
  h.resolve([suggestion]); await opening; await flush();
  assert.equal(title.value,'我的书名'); assert.equal(row.querySelector('[data-field="author"]').value,'作者');
  assert.equal(row.querySelector('select').value,categories[2]);
  assert.equal(h.ids['candidate-accept'].disabled,false); assert.equal(h.ids['candidate-accept'].className,'primary');
  assert.match(h.ids['candidate-accept'].textContent,/加入选中的 1 个/);
  assert.equal(h.ids['candidate-ignore'].className,'secondary');
  for(const el of descendants(d))assert.equal(el.getAttribute('style'),null);
});

test('v018 manual fallback, validation, selection, authenticated app callback, acceptance toast and refresh',async t=>{
  const h=await setup(t,{fail:true}); await h.controller.open();
  assert.match(h.ids['candidate-status'].textContent,/自己填写|手动填写/); assert.equal(h.ids['candidate-accept'].disabled,true);
  const d=h.ids['candidate-dialog'];
  for(const [key,value]of Object.entries(suggestion).filter(([k])=>k!=='id')) {const el=d.querySelector(`[data-field="${key}"]`);el.value=value;await el.fire(key==='primary'?'change':'input');}
  const check=d.querySelector('input[type="checkbox"]'); check.checked=false;await check.fire('change');assert.equal(h.ids['candidate-accept'].disabled,true);
  check.checked=true;await check.fire('change');await h.ids['candidate-accept'].fire('click');
  assert.deepEqual(h.requests.find(r=>r.url.endsWith('/accept')).body,{items:[suggestion]});
  assert.equal(d.open,false);assert.equal(h.refreshed,1);assert.match(h.messages[0],/已加入 1/);assert.match(h.messages[0],/失败 1.*EPERM/);
});

test('v018 ignore selected and undo from settings directory; reopen preserves edits without another automatic suggestion',async t=>{
  const h=await setup(t);await h.controller.open();h.controller.close();await h.controller.open();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/suggest')).length,1);
  await h.ids['candidate-suggest'].fire('click');assert.equal(h.requests.filter(r=>r.url.endsWith('/suggest')).length,2);
  await h.ids['candidate-ignore'].fire('click');assert.deepEqual(h.requests.find(r=>r.url.endsWith('/ignore')).body,{ids:['newbook']});
  const ignored=h.ids['candidate-ignored'];ignored.open=true;await ignored.fire('toggle');assert.ok(ignored.closest('[aria-label="目录"]'));assert.match(ignored.textContent,/ignored/);
  await ignored.querySelector('button').fire('click');assert.deepEqual(h.requests.find(r=>r.url.endsWith('/unignore')).body,{ids:['ignored']});
});

test('v018 Escape restores focus; stale suggestions do not resurrect accepted or ignored rows',async t=>{
  const h=await setup(t,{pending:true});const trigger=h.ids.refresh;trigger.focus();
  const opening=h.controller.open(trigger);await flush();
  await h.ids['candidate-dialog'].fire('keydown',{key:'Escape'});assert.equal(h.ids['candidate-dialog'].open,false);assert.equal(h.doc.activeElement,trigger);
  void h.controller.open(trigger);await h.ids['candidate-ignore'].fire('click');
  h.resolve([suggestion]);await opening;assert.equal(h.ids['candidate-dialog'].open,false);assert.equal(h.ids['candidate-dialog'].querySelector('[data-candidate-id="newbook"]'),null);
});

for(const ui of ['threepane','bento','editorial','shelf'])test(`v018 ${ui} notice placement, opening, token and refresh disappearance`,async t=>{
  const {doc,ids}=await appDocument(ui);doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};
  let r=baseRegistry();const requests=[];
  const app=await mountApp(doc,async(url,options={})=>{
    requests.push({url,options});
    const value=url==='/api/registry'||url==='/api/refresh'?r:url==='/api/candidates/suggest'?[suggestion]:url==='/api/stats'?{perAgent:{},sources:[],limitedReasons:[]}:url==='/api/settings'?{ui,recommend:{claude:{},codex:{}}}:url.startsWith('/api/groups')?{groups:[]}:url.startsWith('/api/concepts?')?{items:[],running:null,today:{}}:{items:[],unavailable:[],ids:[]};
    return {ok:true,json:async()=>value};
  });t.after(()=>app.dispose());
  const notice=doc.querySelector('.candidate-notice');assert.ok(notice);assert.equal(notice.hidden,false);assert.match(notice.textContent,/发现 1 个新书籍 Agent · 查看/);
  if(ui==='threepane'){assert.ok(notice.closest('.mail-navigation'));const parent=ids.navigation.parentElement;assert.ok(parent.children.indexOf(notice)<parent.children.indexOf(ids.navigation));}
  if(ui==='bento'||ui==='editorial'){const head=doc.querySelector(ui==='bento'?'.bento-header':'.editorial-masthead');assert.equal(head.parentElement.children.indexOf(notice),head.parentElement.children.indexOf(head)+1);}
  if(ui==='shelf')assert.ok(notice.closest('.shelf-caption'));
  await notice.fire('click');await flush();assert.equal(ids['candidate-dialog'].open,true);
  assert.equal(requests.find(r=>r.url==='/api/candidates/suggest').options.headers['X-Co-Agent-Token'],'synthetic-token');
  r={...r,candidates:[]};await app.actions.refresh();assert.equal(doc.querySelector('.candidate-notice').hidden,true);
});
