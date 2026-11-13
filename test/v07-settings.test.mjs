import { allStyles } from './fixtures/app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fixture, put, fakeSpawner } from './fixtures/helpers.mjs';
import { createApp } from '../src/server.mjs';
import main from '../electron/main.cjs';
import { spinePalette } from '../public/layouts/shelf.js';

const themes = ['threepane', 'bento', 'editorial', 'shelf'];
const required = ['bg','panel','text','muted','line','accent','focus','danger','danger-bg','warning','warning-bg',
  'accent-fg','surface-2','sidebar-bg','success','radius','shadow-card','font-ui','font-mono','font-size'];
export function themeTokens(css, id) {
  const block = css.match(new RegExp(`\\[data-ui="${id}"\\]\\s*\\{([^}]+)\\}`))?.[1];
  assert.ok(block, `${id}: token block missing`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);?/g)].map(m => [m[1],m[2].trim()]));
}
export function contrast(a, b) {
  const luminance = hex => {
    const rgb = hex.replace('#','').match(/../g).map(v => parseInt(v,16)/255)
      .map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  };
  const x=luminance(a), y=luminance(b);
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
function resolved(tokens,key) {
  const alias=tokens[key].match(/^var\(--([\w-]+)\)$/);
  return alias?resolved(tokens,alias[1]):tokens[key];
}
function composite(color,bg) {
  if(color.startsWith('#'))return color;
  const [r,g,b,alpha]=color.match(/[\d.]+/g).map(Number),background=bg.slice(1).match(/../g).map(v=>parseInt(v,16));
  return '#'+[r,g,b].map((v,i)=>Math.round(v*alpha+background[i]*(1-alpha)).toString(16).padStart(2,'0')).join('');
}
for (const id of themes) test(`v07 settings ${id}: complete tokens and accessible text/buttons/focus`, async () => {
  const tokens = themeTokens(await allStyles(), id);
  for (const key of required) assert.ok(tokens[key], `${id}: --${key}`);
  for (const bg of ['bg','panel','sidebar-bg']) {
    for (const fg of ['text','muted']) assert.ok(contrast(tokens[fg],tokens[bg]) >= 4.5, `${id}: ${fg}/${bg}`);
    assert.ok(contrast(tokens.focus,tokens[bg]) >= 3, `${id}: focus/${bg}`);
  }
  assert.ok(contrast(tokens['accent-fg'],tokens.accent) >= 4.5, `${id}: primary`);
  for (const [fg,bg] of [['nav-active-text','nav-active-bg'],['writable-text','writable-bg'],['danger-text','danger-bg'],['warning','warning-bg']])
    assert.ok(contrast(resolved(tokens,fg),composite(resolved(tokens,bg),tokens.panel)) >= 4.5,`${id}: ${fg}/${bg}`);
});
test('v07 actual compose, tile, book spine, badge and dark hero colors meet 4.5:1', async () => {
  const css = await allStyles();
  const pairs = [['#001d35','#c2e7ff'],['#1d1b19','#f0b44c'],['#f3efe8','#1d1b19'],['#d0c5b7','#2c2925'],['#625c53','#d9e6d3'],['#705b45','#f3e9d8'],['#5c4b38','#f3e9d8']];
  for (const bg of ['#f6d9c4','#d6e2f2','#ede0f2','#f2ecc6']) pairs.push(['#50483d',bg],['#1d1b19',bg]);
  // v0.26: one shared spine palette with gilt titles replaces the per-book overrides; colleagues are walnut plaques.
  for (const bg of spinePalette) pairs.push(['#e6c98a',bg]);
  for (const bg of ['#46301d','#3a2717','#2e1e12']) pairs.push(['#ead8b4',bg],['#d4ae62',bg],['#c9b89c',bg]);
  assert.equal([...css.matchAll(/\.book-spine\[data-agent=/g)].length, 0);
  for (const [fg,bg] of pairs) assert.ok(contrast(fg,bg)>=4.5,`${fg}/${bg}: ${contrast(fg,bg)}`);
});
test('v07 layouts use local font stacks and resources, omit every replaced theme selector', async () => {
  const css = await allStyles();
  for (const id of ['classic','shadcn','tabler','dracula']) assert.ok(!css.includes(`[data-ui="${id}"]`));
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/);
  for (const id of themes) {
    const tokens = themeTokens(css, id);
    assert.match(tokens['font-ui'], /Microsoft YaHei UI/);
    if (['editorial', 'shelf'].includes(id)) assert.equal(tokens['font-title'], 'Georgia, "Songti SC", "SimSun", serif');
  }
  const html = await fs.readFile('public/index.html', 'utf8');
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/);
});

test('v07 settings acceptance: settings footer version is injected from package on both index routes and matches health/lockfile', async t => {
  const ctx=await running(t);
  const manifest=JSON.parse(await fs.readFile('package.json','utf8'));
  const lock=JSON.parse(await fs.readFile('package-lock.json','utf8'));
  assert.equal(manifest.version,'0.53.3');
  assert.equal(lock.version,manifest.version);assert.equal(lock.packages[''].version,manifest.version);
  const source=await fs.readFile('public/index.html','utf8');assert.match(source,/<!-- CO_AGENT_VERSION -->/);
  for(const entry of await fs.readdir('public',{recursive:true,withFileTypes:true})) {
    if(entry.isFile() && /\.(html|js|css)$/.test(entry.name))
      assert.doesNotMatch(await fs.readFile(path.join(entry.parentPath,entry.name),'utf8'),/\bv\d+\.\d+\.\d+\b/,entry.name);
  }
  for(const route of ['/','/index.html']) {
    const response=await fetch(ctx.base+route);assert.equal(response.status,200);
    const html=await response.text();
    assert.ok(html.includes(`<footer>CO-AGENT v${manifest.version} ·`));
    assert.doesNotMatch(html,/<!-- CO_AGENT_VERSION -->/);assert.ok(html.includes(ctx.app.token));assert.match(html,/data-ui="threepane"/);
  }
  assert.equal((await (await fetch(ctx.base+'/api/health')).json()).version,manifest.version);
  assert.equal(ctx.calls.length,0);
});

async function running(t, config) {
  let app;
  // after hooks run in registration order: close before fixture directory cleanup.
  t.after(()=>app?.close());
  config ||= (await fixture(t)).config;
  const calls=[];
  app=await createApp(config,{spawnImpl:fakeSpawner(calls)});
  await app.listen();
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const send=(body,headers={})=>fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token,...headers},body:JSON.stringify(body)});
  return {app,base,send,config,calls};
}
test('v07 settings settings API defaults/logs; preserves recommendation config; protects PUT and validates bodies', async t => {
  const ctx=await running(t), {base,send,config,calls}=ctx;
  const value=await (await fetch(`${base}/api/settings`)).json();
  assert.equal(value.ui,'threepane'); assert.deepEqual(value.uiOptions.map(o=>o.id),themes);
  assert.deepEqual(value.recommend,{claude:config.recommend.claude,codex:config.recommend.codex});
  assert.match(await fs.readFile(path.join(config.dataDir,'logs/server.log'),'utf8'),/设置.*threepane/);
  assert.equal((await send({ui:'shelf'},{'X-Co-Agent-Token':''})).status,403);
  assert.equal((await send({ui:'shelf'},{Origin:'https://evil.test'})).status,403);
  const badHost = await new Promise((resolve,reject)=>{
    const request=http.request(`${base}/api/settings`,{method:'PUT',headers:{Host:'evil.test','X-Co-Agent-Token':ctx.app.token}},response=>{response.resume();resolve(response.statusCode);});
    request.on('error',reject);request.end();
  });
  assert.equal(badHost,421);
  for(const body of [null,[],{}, {ui:'unknown'},{ui:'__proto__'},{ui:'<script>'},{ui:1}]) assert.equal((await send(body)).status,400);
  assert.equal((await fetch(`${base}/api/settings`,{method:'PUT',headers:{'X-Co-Agent-Token':ctx.app.token,'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal(calls.length,0);
  await assert.rejects(fs.access(path.join(config.dataDir,'settings.json')));
});
test('v07 settings valid PUT is durable and injects first-paint theme on both index routes', async t => {
  const {config}=await fixture(t), ctx=await running(t,config);
  for(const ui of themes) {
    const response=await ctx.send({ui});assert.equal(response.status,200);assert.equal((await response.json()).ui,ui);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir,'settings.json'),'utf8')),{version:1,ui,bookText:100}); // v0.42 description size
    for(const route of ['/', '/index.html']) {
      const html=await (await fetch(ctx.base+route)).text();assert.match(html,new RegExp(`<html[^>]+data-ui="${ui}"`));assert.match(html,new RegExp(ctx.app.token));
    }
  }
  await ctx.app.close();const restarted=await running(t,config);
  assert.equal((await (await fetch(restarted.base+'/api/settings')).json()).ui,'shelf');
  assert.equal((await fs.readdir(config.dataDir)).filter(n=>n.startsWith('settings.json.')&&n.endsWith('.tmp')).length,0);
});
for(const contents of ['{', '{"version":2,"ui":"shelf"}', '{"version":1,"ui":"<bad>"}', 'null'])
  test(`v07 settings invalid persisted settings fall back without rewriting: ${contents}`,async t=>{
    const {config}=await fixture(t);const file=path.join(config.dataDir,'settings.json');await put(file,contents);
    const ctx=await running(t,config);assert.equal((await (await fetch(ctx.base+'/api/settings')).json()).ui,'threepane');
    assert.equal(await fs.readFile(file,'utf8'),contents);assert.match(await fs.readFile(path.join(config.dataDir,'logs/server.log'),'utf8'),/设置.*threepane/);
  });
test('v07 settings failed atomic save keeps in-memory theme and returns error',async t=>{
  const ctx=await running(t);await ctx.send({ui:'editorial'});
  const file=path.join(ctx.config.dataDir,'settings.json');await fs.rm(file);await fs.mkdir(file);
  assert.equal((await ctx.send({ui:'bento'})).status,500);
  assert.equal((await (await fetch(ctx.base+'/api/settings')).json()).ui,'editorial');
});
test('v07 settings concurrent PUTs finish with consistent response, disk and first-paint theme',async t=>{
  const ctx=await running(t);
  const responses=await Promise.all(['shelf','bento','editorial'].map(ui=>ctx.send({ui})));
  for(const response of responses)assert.equal(response.status,200);
  const values=await Promise.all(responses.map(response=>response.json()));
  assert.deepEqual(values.map(value=>value.ui),['shelf','bento','editorial']);
  const persisted=JSON.parse(await fs.readFile(path.join(ctx.config.dataDir,'settings.json'),'utf8'));
  assert.equal((await (await fetch(ctx.base+'/api/settings')).json()).ui,persisted.ui);
  assert.match(await (await fetch(ctx.base+'/')).text(),new RegExp(`data-ui="${persisted.ui}"`));
});

// Record actual DOM nodes and dispatched events, without a browser or third-party DOM.
class Element {
  constructor(doc,tag){this.doc=doc;this.tagName=tag;this.children=[];this.attrs={};this.events={};this._text='';this.hidden=false;}
  set textContent(v){this._text=String(v);this.children=[];} get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k];}
  addEventListener(k,f){(this.events[k]??=[]).push(f);} removeEventListener(k,f){this.events[k]=(this.events[k]||[]).filter(v=>v!==f);}
  async fire(k,e={}){e.target??=this;e.currentTarget=this;e.preventDefault??=()=>{};e.stopPropagation??=()=>{};await Promise.all((this.events[k]||[]).map(f=>f(e)));}
  focus(){this.doc.activeElement=this;} showModal(){this.open=true;} close(){this.open=false;void this.fire('close');}
  closest(selector){if(selector==='[hidden]')return this.hidden?this:this.parent?.closest(selector);return null;}
  querySelectorAll(){return descendants(this).slice(1).filter(n=>['button','input','select','textarea'].includes(n.tagName)&&n.getAttribute('tabindex')!=='-1');}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
function domFixture(){
  const doc={activeElement:null,createElement:tag=>new Element(doc,tag)};
  const ids={};for(const id of ['settings-open','settings-dialog','settings-options','settings-close','settings-status'])ids[id]=new Element(doc,id==='settings-dialog'?'dialog':id.endsWith('open')||id.endsWith('close')?'button':'div');
  doc.documentElement=new Element(doc,'html');doc.documentElement.setAttribute('data-ui','threepane');
  doc.getElementById=id=>ids[id];ids['settings-dialog'].append(ids['settings-options'],ids['settings-close'],ids['settings-status']);
  return {doc,ids};
}
test('v07 settings settings dialog: semantics, previews, focus trap/Esc/native close, arrow/Home/End focus only, explicit apply and PUT',async()=>{
  const {mountSettings}=await import('../public/settings.js');const {doc,ids}=domFixture(),calls=[];
  mountSettings(doc,async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ui:JSON.parse(options.body).ui})};},'test-token');
  const radios=descendants(ids['settings-options']).filter(n=>n.getAttribute('role')==='radio');assert.equal(radios.length,4);
  assert.equal(ids['settings-options'].getAttribute('role'),'radiogroup');
  for(const id of themes){const preview=descendants(ids['settings-options']).find(n=>n.getAttribute('data-layout-preview')===id);assert.ok(preview);assert.ok(preview.children.length);}
  ids['settings-open'].focus();await ids['settings-open'].fire('click');assert.equal(doc.activeElement,radios[0]);
  assert.equal(ids['settings-dialog'].attrs['aria-modal'],'true');
  ids['settings-close'].focus();await ids['settings-dialog'].fire('keydown',{key:'Tab'});assert.equal(doc.activeElement,radios[0]);
  await ids['settings-dialog'].fire('keydown',{key:'Tab',shiftKey:true});assert.equal(doc.activeElement,ids['settings-close']);
  await radios[0].fire('keydown',{key:'ArrowRight'});assert.equal(doc.documentElement.attrs['data-ui'],'threepane');assert.equal(doc.activeElement,radios[1]);assert.equal(calls.length,0);
  await radios[1].fire('keydown',{key:'Enter'});assert.equal(doc.documentElement.attrs['data-ui'],'bento');
  assert.equal(calls[0].url,'/api/settings');assert.equal(calls[0].options.method,'PUT');assert.equal(calls[0].options.headers['X-Co-Agent-Token'],'test-token');
  assert.deepEqual(JSON.parse(calls[0].options.body),{ui:'bento'});assert.match(ids['settings-status'].textContent,/已切换为「便当格 · 仪表盘」/);
  assert.equal(radios[1].attrs['aria-checked'],'true');assert.equal(radios[0].attrs.tabindex,'-1');
  await radios[1].fire('keydown',{key:'End'});assert.equal(doc.activeElement,radios[3]);assert.equal(doc.documentElement.attrs['data-ui'],'bento');
  await radios[3].fire('keydown',{key:' '});assert.equal(doc.documentElement.attrs['data-ui'],'shelf');
  await radios[3].fire('keydown',{key:'ArrowDown'});assert.equal(doc.activeElement,radios[1]);assert.equal(doc.documentElement.attrs['data-ui'],'shelf');
  await radios[1].fire('keydown',{key:'ArrowLeft'});assert.equal(doc.activeElement,radios[0]);assert.equal(doc.documentElement.attrs['data-ui'],'shelf');
  await radios[0].fire('keydown',{key:'Home'});assert.equal(doc.activeElement,radios[0]);assert.equal(doc.documentElement.attrs['data-ui'],'shelf');
  await radios[0].fire('click');assert.equal(doc.documentElement.attrs['data-ui'],'threepane');
  await ids['settings-dialog'].fire('keydown',{key:'Escape'});assert.equal(doc.activeElement,ids['settings-open']);assert.equal(ids['settings-dialog'].open,false);
  await ids['settings-open'].fire('click');ids['settings-dialog'].close();assert.equal(doc.activeElement,ids['settings-open']);
});
test('v07 settings switch waits for save, failed PUT preserves radio/theme and announces, rapid selection is serialized',async()=>{
  const {mountSettings}=await import('../public/settings.js');const {doc,ids}=domFixture();let rejectRequest,resolveRequest;const calls=[];
  mountSettings(doc,(url,options)=>{calls.push({url,options});return new Promise((resolve,reject)=>{rejectRequest=reject;resolveRequest=resolve;});},'token');
  const radios=descendants(ids['settings-options']).filter(n=>n.attrs.role==='radio');
  await ids['settings-open'].fire('click');
  const first=radios[3].fire('click');assert.equal(doc.documentElement.attrs['data-ui'],'threepane');
  await radios[2].fire('click');assert.equal(calls.length,1);
  rejectRequest(new Error('磁盘写入失败'));await first;assert.equal(doc.documentElement.attrs['data-ui'],'threepane');assert.equal(radios[0].attrs['aria-checked'],'true');assert.equal(doc.activeElement,radios[0]);
  assert.match(ids['settings-status'].textContent,/磁盘写入失败/);assert.equal(ids['settings-status'].attrs['aria-live'],'polite');
  const next=radios[2].fire('click');resolveRequest({ok:false,json:async()=>({error:'拒绝保存'})});await next;assert.equal(doc.documentElement.attrs['data-ui'],'threepane');assert.match(ids['settings-status'].textContent,/拒绝保存/);
  const retry=radios[1].fire('click');resolveRequest({ok:true,json:async()=>({ui:'bento'})});await retry;assert.equal(doc.documentElement.attrs['data-ui'],'bento');
});
test('v07 settings saved initial theme is selected; closing during a failed save never steals focus',async()=>{
  const {mountSettings}=await import('../public/settings.js');const {doc,ids}=domFixture();let fail;
  doc.documentElement.setAttribute('data-ui','shelf');
  mountSettings(doc,()=>new Promise((_resolve,reject)=>{fail=reject;}),'token');
  const radios=descendants(ids['settings-options']).filter(n=>n.attrs.role==='radio');
  await ids['settings-open'].fire('click');assert.equal(doc.activeElement,radios[3]);
  const save=radios[2].fire('click');await ids['settings-close'].fire('click');
  assert.equal(doc.activeElement,ids['settings-open']);fail(new Error('关闭后保存失败'));await save;
  assert.equal(doc.activeElement,ids['settings-open']);assert.equal(doc.documentElement.attrs['data-ui'],'shelf');
});

for(const [ui,color] of [['threepane','#ffffff'],['bento','#f3efe8'],['editorial','#f7f4ee'],['shelf','#2b2118'],['bad','#ffffff'],['corrupt','#ffffff'],['missing','#ffffff']])
  test(`v07 settings Electron reads ${ui} before constructing window (substitute only)`,async t=>{
    const {config}=await fixture(t);if(ui!=='missing')await put(path.join(config.dataDir,'settings.json'),ui==='corrupt'?'{':JSON.stringify({version:1,ui}));
    const app=new EventEmitter();Object.assign(app,{setPath(){},requestSingleInstanceLock:()=>true,setAppUserModelId(){},commandLine:{appendSwitch(){}},whenReady:async()=>{},quit(){}});
    const windows=[];class BrowserWindow extends EventEmitter {constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};windows.push(this);}async loadURL(){}isDestroyed(){return false;}}
    const controller=main.createMain({env:{CO_AGENT_DATA_DIR:config.dataDir},electron:{app,BrowserWindow,Menu:{setApplicationMenu(){}},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}}}},shell:{},dialog:{showErrorBox(_title,message){assert.fail(message);}}},importConfig:async()=>({loadConfig:async()=>config}),importServer:async()=>({startServer:async()=>({exitCode:0,app:{server:{address:()=>({port:51234})},close:async()=>{}}})}),log:async()=>{}});
    await controller.ready;assert.equal(windows[0].options.backgroundColor,color);assert.equal(windows[0].options.show,false);await controller.stop();
  });
