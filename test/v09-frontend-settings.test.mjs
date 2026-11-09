import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { descendants } from './fixtures/dom.mjs';
import { mountSettings } from '../public/settings.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const reply=ui=>({ok:true,json:async()=>({ui})});
function timers(){let i=0;const tasks=new Map();return{tasks,setTimer:(fn,ms)=>{tasks.set(++i,{fn,ms});return i;},clearTimer:id=>tasks.delete(id)};}
async function setup(t,{fetchImpl,transition,motion=false}={}){
  const {doc,ids}=await appDocument('threepane'),clock=timers(),requests=[],layouts=[];
  doc.defaultView={matchMedia:()=>({matches:motion})};if(transition)doc.startViewTransition=transition;
  const control=mountSettings(doc,fetchImpl||((url,opts)=>{requests.push({url,opts});return Promise.resolve(reply(JSON.parse(opts.body).ui));}),'fixture',ui=>layouts.push(ui),{...clock,bindTrigger:false});
  t.after(()=>control.dispose?.());control.open(ids.refresh);return{doc,ids,clock,requests,layouts,control,radios:doc.querySelectorAll('[role="radio"]')};
}
test('v09 picker has exact copy, four distinct DOM thumbnails, neutral geometry and no shortcuts/references',async t=>{
  const {doc,radios}=await setup(t);assert.equal(radios.length,4);
  assert.equal(doc.getElementById('settings-options').getAttribute('aria-description'),'方向键移动焦点，Enter 应用');
  for(const [i,id] of ['threepane','bento','editorial','shelf'].entries()){
    const preview=radios[i].querySelector(`[data-layout-preview="${id}"]`);assert.ok(preview);assert.equal(preview.getAttribute('aria-hidden'),'true');
    assert.ok(preview.querySelector(`.picker-${['tp','bt','ed','sh'][i]}`));
    assert.ok(radios[i].querySelector('.picker-current'));assert.ok(radios[i].querySelector('.picker-saving'));
    for(const n of descendants(radios[i]))assert.equal(n.getAttribute('style'),null);
  }
  assert.doesNotMatch(doc.getElementById('settings-options').textContent,/参考：|Alt\+/);
  assert.match(doc.getElementById('settings-options').textContent,/分类、列表、详情并排，一屏看全，适合高频调用。/);
  const css=await fs.readFile('public/styles.css','utf8');
  for(const pattern of [/gap:\s*18px/,/height:\s*178px/,/border-radius:\s*20px/,/padding:\s*12px 12px 16px/,/bottom:\s*10px/,/left:\s*10px/,/translateY\(-2px\)/,/200ms/])assert.match(css,pattern);
});
test('v09 arrows/Home/End only rove focus; Enter/Space/click apply once and no Alt shortcuts',async t=>{
  const {doc,radios,requests}=await setup(t);
  await radios[0].fire('keydown',{key:'ArrowRight'});assert.equal(doc.activeElement,radios[1]);
  await radios[1].fire('keydown',{key:'ArrowDown'});assert.equal(doc.activeElement,radios[3]);
  await radios[3].fire('keydown',{key:'ArrowUp'});assert.equal(doc.activeElement,radios[1]);
  await radios[1].fire('keydown',{key:'Home'});assert.equal(doc.activeElement,radios[0]);
  await radios[0].fire('keydown',{key:'End'});assert.equal(doc.activeElement,radios[3]);assert.equal(requests.length,0);
  assert.equal(radios[0].getAttribute('aria-checked'),'true');assert.equal(radios[3].getAttribute('tabindex'),'0');
  await radios[3].fire('keydown',{key:'Enter'});assert.equal(requests.length,1);assert.equal(doc.documentElement.getAttribute('data-ui'),'shelf');
  await radios[1].fire('keydown',{key:' '});assert.equal(requests.length,2);await radios[1].fire('click');assert.equal(requests.length,2);
  await radios[2].fire('keydown',{key:'3',altKey:true});assert.equal(requests.length,2);
});
test('v09 save is single-flight with target overlay, successful transition, 8s toast and saved undo',async t=>{
  const gate=deferred();let saves=0,transitions=0;
  const {doc,radios,clock}=await setup(t,{fetchImpl:(_url,opts)=>++saves===1?gate.promise:Promise.resolve(reply(JSON.parse(opts.body).ui)),transition:fn=>{transitions++;const update=Promise.resolve(fn());return{updateCallbackDone:update,finished:update};}});
  const pending=radios[1].fire('click');assert.equal(doc.documentElement.getAttribute('data-ui'),'threepane');
  assert.equal(radios[1].querySelector('.picker-saving').hidden,false);assert.equal(radios[0].querySelector('.picker-saving').hidden,true);
  await radios[2].fire('click');assert.equal(saves,1);gate.resolve(reply('bento'));await pending;
  assert.equal(transitions,1);assert.equal(doc.documentElement.getAttribute('data-ui'),'bento');assert.equal(radios[1].querySelector('.picker-saving').hidden,true);
  const toast=doc.getElementById('settings-status');assert.equal(toast.getAttribute('role'),'status');assert.match(toast.textContent,/已切换为「便当格 · 仪表盘」/);
  assert.equal([...clock.tasks.values()][0].ms,8000);await toast.querySelector('button').fire('click');assert.equal(saves,2);assert.equal(doc.documentElement.getAttribute('data-ui'),'threepane');
  [...clock.tasks.values()][0].fn();assert.equal(toast.hidden,true);
});
test('v09 reduced motion and unsupported transitions switch directly',async t=>{
  const {radios,doc}=await setup(t,{motion:true,transition:()=>assert.fail('animation under reduced motion')});await radios[1].fire('click');assert.equal(doc.documentElement.getAttribute('data-ui'),'bento');
  const plain=await setup(t);await plain.radios[2].fire('click');assert.equal(plain.doc.documentElement.getAttribute('data-ui'),'editorial');
});
test('v09 failed/mismatched save stays on previous layout and announces on target card without stealing closed focus',async t=>{
  const gate=deferred();const {doc,ids,radios}=await setup(t,{fetchImpl:()=>gate.promise});const pending=radios[2].fire('click');
  await ids['settings-close'].fire('click');assert.equal(doc.activeElement,ids.refresh);
  gate.resolve({ok:false,json:async()=>({error:'磁盘不可写 <script>'})});await pending;
  assert.equal(doc.activeElement,ids.refresh);assert.equal(doc.documentElement.getAttribute('data-ui'),'threepane');assert.match(radios[2].querySelector('.picker-error').textContent,/磁盘不可写 <script>/);assert.equal(radios[2].querySelector('script'),null);
  const other=await setup(t,{fetchImpl:async()=>reply('shelf')});await other.radios[1].fire('click');assert.equal(other.doc.documentElement.getAttribute('data-ui'),'threepane');assert.match(other.radios[1].textContent,/不一致/);
});
test('v09 transition rejection cannot undo a successful persisted layout; disposal clears toast timer',async t=>{
  const {doc,radios,control,clock}=await setup(t,{transition:fn=>{const update=Promise.resolve(fn());return{updateCallbackDone:update,finished:Promise.reject(new Error('animation cancelled'))};}});
  await radios[1].fire('click');assert.equal(doc.documentElement.getAttribute('data-ui'),'bento');control.dispose();assert.equal(clock.tasks.size,0);
});

test('v09 toast expiry restores focused undo to the current radio, without stealing other focus',async t=>{
  const {doc,radios,clock}=await setup(t);await radios[1].fire('click');
  doc.getElementById('settings-status').querySelector('button').focus();[...clock.tasks.values()][0].fn();assert.ok(doc.activeElement===radios[1]);
  await radios[2].fire('click');radios[0].focus();[...clock.tasks.values()][0].fn();assert.equal(doc.activeElement,radios[0]);
});

test('v09 cancelled snapshot transition falls back once and a failed undo keeps persisted current layout',async t=>{
  let saves=0;const {doc,radios}=await setup(t,{transition:()=>{throw new Error('snapshot unavailable');},fetchImpl:async()=>++saves===1?reply('bento'):{ok:false,json:async()=>({error:'撤销保存失败'})}});
  await radios[1].fire('click');assert.equal(doc.documentElement.getAttribute('data-ui'),'bento');
  await doc.getElementById('settings-status').querySelector('button').fire('click');assert.equal(doc.documentElement.getAttribute('data-ui'),'bento');assert.match(radios[0].querySelector('.picker-error').textContent,/撤销保存失败/);
});

test('v09 disposing before save completion cannot repaint or create an undo timer',async t=>{
  const gate=deferred();const {doc,radios,control,clock,layouts}=await setup(t,{fetchImpl:()=>gate.promise});const pending=radios[1].fire('click');control.dispose();gate.resolve(reply('bento'));await pending;
  assert.equal(doc.documentElement.getAttribute('data-ui'),'threepane');assert.deepEqual(layouts,['threepane']);assert.equal(clock.tasks.size,0);
});

test('v09 a keyboard-focused undo leaves the restored radio as the single roving tab stop',async t=>{
  const {doc,radios}=await setup(t);await radios[1].fire('click');const undo=doc.getElementById('settings-status').querySelector('button');undo.focus();await undo.fire('click');
  assert.equal(radios[0].getAttribute('tabindex'),'0');assert.equal(radios[1].getAttribute('tabindex'),'-1');assert.ok(doc.activeElement===radios[0]);
});
