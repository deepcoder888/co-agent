import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put } from './fixtures/helpers.mjs';
import { createConcepts, excludedConcepts } from '../src/concepts/index.mjs';
import { conceptSchema, conceptPrompt, validateConcept } from '../src/concepts/runner.mjs';
import { createApp } from '../src/server.mjs';
import { atomicWrite } from '../src/fsutil.mjs';

const term = { zh:'移情', en:'Transference', fr:'Transfert' };
const value = () => ({ concept:'移情：过时的地图',conceptEn:'Transference',oneLine:'认知线索',whyUnknown:'书名没有提示',sourceRefs:['第三章'],markdown:'# 完整原文\r\nÉnergie\r\n',term:{...term} });
const agent = { id:'pecko', name:'Pecko', kind:'book', platforms:{ codex:{available:true} },book:{title:'一条示例的路'},sources:{missing:[]} };
const old = () => { const result=value();delete result.term;return {version:1,conceptId:randomUUID(),kind:'manual',day:'2026-10-08',createdAt:'2026-10-08T01:00:00Z',status:'done',agent:{id:'pecko',name:'Pecko',codexName:'Pecko',title:'一条示例的路'},result,perspectives:[],thinkFile:'existing-file.txt'}; };
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t, options={}) {
  // After hooks run in registration order: close the engine (and any app) before the fixture folder is removed.
  let engine;t.after(()=>engine?.close());
  const ctx=await fixture(t);ctx.config.concept.thinkDir=path.join(ctx.root,'concept');
  engine=createConcepts(ctx.config,()=>({agents:[agent]}),{runner:async()=>value(),conceptVerifier:async()=>({state:'unconfirmed'}),...options});
  assert.equal(typeof engine.backfillTerm,'function');return {...ctx,engine};
}

test('v011 concept schema/prompt require term and preserve lectures with invalid terms for backfill',()=>{
  assert.ok(conceptSchema.required.includes('term'));
  const r={conceptId:'ID',agent:{codexName:'Pecko',title:'书'},excludedConcepts:[]};
  assert.match(conceptPrompt(r),/另给出核心概念 term：zh 必须是 concept 中连续的一段（1–8 个汉字）/);
  assert.deepEqual(validateConcept(value()).term,term);
  for(const bad of [undefined,null,{}, {...term,zh:'移情：地图'},{...term,zh:'超过八个汉字的概念名字'},{...term,zh:'Two words'}, {...term,en:''},{...term,fr:''},{...term,extra:1}]){
    assert.deepEqual(validateConcept({...value(),term:bad}),{...value(),term:null,response:null,responseError:'回应格式无效'});
  }
  const missing=value();delete missing.term;assert.throws(()=>validateConcept(missing),/概念 JSON 格式无效/);
});

test('v011 term translations preserve accents and remove French articles',async()=>{
  const {validateTerm}=await import('../src/concepts/terms.mjs');
  assert.deepEqual(validateTerm({zh:'能量',en:'Energy',fr:'l’Énergie'}),{zh:'能量',en:'Energy',fr:'Énergie'});
  assert.equal(validateTerm({...term,fr:'le Transfert'}).fr,'Transfert');
});

test('v011 concept names participate in dedupe and new THINK filenames use term.zh only',async t=>{
  const records=[old()];records[0].result.term={zh:' 移情 ',en:' Transference ',fr:' Transfert '};
  assert.deepEqual(excludedConcepts(records,'pecko'),['移情：过时的地图','transference']);
  let generated=value();const {engine,config}=await setup(t,{runner:async()=>generated});await engine.recover();
  const first=await engine.startManual({kind:'manual'});await engine.idle();const r=await engine.get(first.conceptId);
  assert.equal(r.status,'done');assert.equal(path.basename(r.thinkFile),'移情.txt');assert.deepEqual(await fs.readFile(r.thinkFile),Buffer.from(value().markdown));
  assert.deepEqual((await engine.list()).items[0].result.term,term);
  for(const field of ['concept','conceptEn']){
    generated={...value(),concept:'移情：不同副标题',conceptEn:'Different',[field]:value()[field]};
    const started=await engine.startManual({kind:'manual'});await engine.idle();assert.match((await engine.get(started.conceptId)).error,/重复/);
  }
  assert.equal((await fs.readdir(config.concept.thinkDir)).length,1);
});

test('v011 startup backfill queue runs serially, coalesces POSTs and preserves markdown/THINK bytes across restart',async t=>{
  const gates=[],calls=[];let active=0,maximum=0;let restarted;t.after(()=>restarted?.close());
  const {engine,config,root}=await setup(t,{termRunner:async r=>{
    calls.push(r.conceptId);active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>gates.push(resolve));active--;return {term};
  }});
  const oldFile=path.join(root,'old.txt');await put(oldFile,'OLD É\r\n');
  const records=[old(),old(),{...old(),status:'failed'}];for(const r of records){r.thinkFile=oldFile;await put(path.join(config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));}
  await engine.recover();while(!gates.length)await tick();
  await engine.recover(); // A live backfill owns its record across repeated recovery.
  await Promise.all([engine.backfillTerm(records[0].conceptId),engine.backfillTerm(records[0].conceptId)]);
  assert.equal(calls.length,1);gates.shift()();while(!gates.length)await tick();assert.equal(calls.length,2);gates.shift()();await engine.idle();
  assert.equal(maximum,1);assert.equal(new Set(calls).size,2);
  for(const r of records.slice(0,2)){const saved=await engine.get(r.conceptId);assert.deepEqual(saved.result,{...r.result,term});assert.equal(saved.thinkFile,oldFile);assert.equal(saved.termBackfill.status,'done');}
  assert.equal(await fs.readFile(oldFile,'utf8'),'OLD É\r\n');
  await engine.backfillTerm(records[0].conceptId);await engine.recover();await engine.idle();assert.equal(calls.length,2);
  restarted=createConcepts(config,()=>({agents:[agent]}),{termRunner:async()=>{throw Error('must not run');}});await restarted.recover();await restarted.idle();
  assert.deepEqual((await restarted.get(records[1].conceptId)).result.term,term);
});

test('v011 backfill failure leaves original done record intact and never retries automatically or on duplicate POST',async t=>{
  let calls=0;const {engine,config}=await setup(t,{termRunner:async()=>{calls++;throw Error('fixture failed');}}),r=old();
  await put(path.join(config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));await engine.recover();await engine.idle();
  const saved=await engine.get(r.conceptId);assert.equal(saved.status,'done');assert.deepEqual(saved.result,r.result);assert.equal(saved.termBackfill.status,'failed');
  await assert.rejects(engine.backfillTerm(r.conceptId),{status:409});await engine.recover();await engine.idle();assert.equal(calls,1);
  await assert.rejects(engine.backfillTerm('bad'),{status:404});
});

test('v011 backfill preserves an existing short Chinese core word instead of replacing it',async t=>{
  const {engine,config}=await setup(t,{termRunner:async()=>({term:{zh:'习惯',en:'Habit',fr:'Habitude'}})}),r=old();r.result.concept='移情';
  await put(path.join(config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));await engine.recover();await engine.idle();
  const saved=await engine.get(r.conceptId);assert.equal(saved.termBackfill.status,'failed');assert.deepEqual(saved.result,r.result);
});

test('v011 backfill failed atomic save never publishes an unsaved term in memory or on disk',async t=>{
  const {engine,config}=await setup(t,{termRunner:async()=>({term}),recordWriter:async(file,bytes)=>{
    if(JSON.parse(bytes).result?.term)throw Object.assign(Error('fixture disk full'),{code:'ENOSPC'});
    return atomicWrite(file,bytes);
  }}),r=old();const file=path.join(config.dataDir,'concepts',r.conceptId+'.json');
  await put(file,JSON.stringify(r));await engine.recover();await engine.idle();
  const saved=await engine.get(r.conceptId);assert.equal(saved.termBackfill.status,'failed');assert.deepEqual(saved.result,r.result);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).result,r.result);
});

test('v011 interrupted/live backfill recovery retains single-run lock and shutdown aborts the owned call',async t=>{
  let alive=true,calls=0;
  const {engine,config}=await setup(t,{isAlive:()=>alive,termRunner:async()=>{calls++;return {term};}});
  const live={...old(),termBackfill:{status:'running',pid:999,attempt:1}},queued=old();
  for(const r of [live,queued])await put(path.join(config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));
  await engine.recover();await engine.idle();assert.equal(calls,0);
  alive=false;await engine.recover();await engine.idle();assert.equal((await engine.get(live.conceptId)).termBackfill.status,'failed');assert.equal(calls,1);
  const owned=await setup(t,{termRunner:async(_r,_c,{signal})=>new Promise((_resolve,reject)=>{
    if(signal.aborted)reject(Error('进程中断'));else signal.addEventListener('abort',()=>reject(Error('进程中断')),{once:true});
  })});const r=old();await put(path.join(owned.config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));await owned.engine.recover();await owned.engine.close();
  assert.equal((await owned.engine.get(r.conceptId)).result.term,undefined);
});

test('v011 tiny backfill process supplies only four input fields and term-only schema, with model/config and injected spawn',async t=>{
  const {runTermProcess,termPrompt,termOutputSchema}=await import('../src/concepts/terms.mjs');
  const {config}=await fixture(t),r=old();let prompt='',seen;
  const result=await runTermProcess(r,config,{spawnImpl:(exe,args,options)=>{
    seen={exe,args,options};const c=new EventEmitter();c.pid=123;c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();
    c.stdin.on('data',data=>{prompt+=data;});c.stdin.on('finish',async()=>{await fs.writeFile(args[args.indexOf('-o')+1],JSON.stringify({term}));c.emit('close',0,null);});return c;
  }});
  assert.deepEqual(result,{term});assert.equal(prompt,termPrompt(r));assert.ok(!prompt.includes(r.result.markdown));assert.ok(!prompt.includes('whyUnknown'));
  const input=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));assert.deepEqual(Object.keys(input),['concept','conceptEn','book','oneLine']);
  assert.deepEqual(termOutputSchema.required,['term']);assert.equal(seen.options.windowsHide,true);assert.equal(seen.options.shell,false);
  assert.equal(seen.args[seen.args.indexOf('-m')+1],config.codexModel);assert.ok(seen.args.includes('model_reasoning_effort="xhigh"'));
});

test('v011 POST term is authenticated and reuses startup queue without rewriting content',async t=>{
  let app;t.after(()=>app?.close());
  const {root,config}=await fixture(t);config.concept.thinkDir=path.join(root,'think');const r=old();let release,calls=0;
  await put(path.join(config.dataDir,'concepts',r.conceptId+'.json'),JSON.stringify(r));
  app=await createApp(config,{conceptAutoDaily:false,registryBuilder:async()=>({agents:[agent]}),conceptOptions:{termRunner:async()=>{calls++;await new Promise(resolve=>{release=resolve;});return {term};}}});
  await app.listen();const base=`http://127.0.0.1:${app.server.address().port}`,url=base+`/api/concepts/${r.conceptId}/term`;
  assert.equal((await fetch(url,{method:'POST'})).status,403);assert.equal((await fetch(url,{method:'POST',headers:{'X-Co-Agent-Token':app.token,Origin:'https://evil.test'}})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'X-Co-Agent-Token':app.token}})).status,202);
  while(!release)await tick();release();await app.concepts.idle();assert.equal(calls,1);
  assert.deepEqual((await (await fetch(base+`/api/concepts/${r.conceptId}`)).json()).result,{...r.result,term});
});
