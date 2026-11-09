import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp, startServer } from '../src/server.mjs';
import { createLogger } from '../src/log.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { resumeArgs, createResume, verifyResume } from '../src/launch/resume.mjs';
import { createLaunch } from '../src/launch/spec.mjs';
import { verifyLaunch } from '../src/launch/verify.mjs';
import { createStats } from '../src/stats/index.mjs';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const agent = { id:'book',name:'Book',platforms:{claude:{available:true,name:'book'},codex:{available:true}} };
test('K1 health is token-free, version comes from package, CO-AGENT port conflict exits 0, other listener fails', async t=> {
  let first; t.after(()=>first?.close()); const {config}=await fixture(t);
  first=await createApp(config); await first.listen(); const port=first.server.address().port;
  const health=await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.deepEqual(Object.keys(health).sort(),['app','dataDir','pid','startedAt','version']);
  assert.equal(health.version,JSON.parse(await fs.readFile('package.json','utf8')).version); assert.equal(health.app,'CO-AGENT');
  assert.equal(health.pid,process.pid); assert.equal(health.dataDir,config.dataDir); assert.ok(Number.isFinite(Date.parse(health.startedAt)));
  const messages=[]; const running=await startServer({...config,port},{output:s=>messages.push(s)});
  assert.equal(running.alreadyRunning,true); assert.equal(running.exitCode,0); assert.match(messages.join(''),/已在运行/);
  const other=http.createServer((_req,res)=>res.end('{"app":"other"}')); t.after(()=>new Promise(r=>other.close(r))); await new Promise(r=>other.listen(0,'127.0.0.1',r));
  await assert.rejects(startServer({...config,port:other.address().port}),/端口.*其他程序/);
  assert.match(await fs.readFile(path.join(config.dataDir,'logs/server.log'),'utf8'),/启动|已在运行/);
});
test('K1 second instance never marks an active recommendation as restarted or invokes recovery',async t=>{
  let app;t.after(()=>app?.close());const {config}=await fixture(t);app=await createApp(config);await app.listen();
  const file=path.join(config.dataDir,'recommend',id,'record.json'),record={recommendId:id,status:'running',input:'active'};await put(file,JSON.stringify(record));
  let scanned=0;const result=await startServer({...config,port:app.server.address().port},{registryBuilder:async()=>{scanned++;throw new Error('must not recover');},output(){}});
  assert.equal(result.exitCode,0);assert.equal(scanned,0);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),record);
});
test('K1 captured Node entrypoint exits 0 for an existing app and nonzero for a foreign listener',async t=>{
  let app;t.after(()=>app?.close());const {config}=await fixture(t);app=await createApp(config);await app.listen();
  const execute=async port=>{
    await put(path.join(config.dataDir,'config.json'),JSON.stringify({...config,port}));
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.resolve('src/server.mjs')],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CO_AGENT_DATA_DIR:config.dataDir}});
      let stdout='',stderr='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Node entrypoint timed out'));},5000);
      child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',code=>{clearTimeout(timeout);resolve({code,stdout,stderr});});
    });
  };
  const same=await execute(app.server.address().port);assert.equal(same.code,0,same.stderr);assert.match(same.stdout,/已在运行/);
  const other=http.createServer((_req,res)=>res.end('{"app":"foreign"}'));t.after(()=>new Promise(r=>other.close(r)));await new Promise(r=>other.listen(0,'127.0.0.1',r));
  const different=await execute(other.address().port);assert.equal(different.code,1);assert.match(different.stderr,/端口.*其他程序/);
});
test('K1 logging serializes writes, rotates >5 MB, retains exactly one old log', async t=>{
  const {config}=await fixture(t); const dir=path.join(config.dataDir,'logs'); await put(path.join(dir,'server.log'),'x'.repeat(5*1024*1024+1)); await put(path.join(dir,'server.log.1'),'obsolete');
  const log=createLogger(config.dataDir); await Promise.all([log('启动'),log('迁移'),log('错误')]);
  assert.equal((await fs.stat(path.join(dir,'server.log.1'))).size,5*1024*1024+1);
  assert.match(await fs.readFile(path.join(dir,'server.log'),'utf8'),/启动[\s\S]*迁移[\s\S]*错误/);
  assert.deepEqual((await fs.readdir(dir)).sort(),['server.log','server.log.1']);
});
test('K4 resume argv is exact, uses original relay instruction/profile/cwd, and contains no startup probe',()=>{
  const record={cli:'claude',agentName:'book',mode:'agent',args:['--agent','book','--session-id',id,'probe'],cwd:'D:\\旧 项目',codexProfile:'old'};
  assert.deepEqual(resumeArgs(record,sid),['--agent','book','--resume',sid]);
  assert.deepEqual(resumeArgs({...record,mode:'relay',args:['--session-id',id,'--append-system-prompt','原始转调']},sid),['--resume',sid,'--append-system-prompt','原始转调']);
  // v0.50: model and effort come from the configuration; the profile still comes from the record.
  assert.deepEqual(resumeArgs({...record,cli:'codex'},sid,{codexModel:'gpt-test',codexEffort:'xhigh'}),['resume',sid,'--profile','old','-m','gpt-test','-c','model_reasoning_effort=xhigh','-C','D:\\旧 项目']);
  assert.deepEqual(resumeArgs({...record,cli:'codex'},sid),['resume',sid,'--profile','old','-C','D:\\旧 项目']);
  assert.deepEqual(resumeArgs({...record,cli:'codex',codexProfile:undefined,args:['-C','x']},sid),['resume',sid,'-C','D:\\旧 项目'],'a record without --profile never takes another argument as its profile');
  assert.throws(()=>resumeArgs({...record,mode:'relay',args:[]},sid),/转调/);
});
test('K4 create/resume persists original mode and terminal PID, scrubs env, missing files never spawn',async t=>{
  const {config}=await fixture(t); const calls=[]; const launch=await createLaunch(agent,'claude',config,{spawnImpl:fakeSpawner(calls)});
  const original=JSON.parse(await fs.readFile(launch.specFile,'utf8')); assert.equal(original.pid,process.pid); assert.equal(original.mode,'agent'); assert.equal(original.agentId,'book');
  const file=path.join(config.claudeProjectsDir,'p',`${launch.sessionId}.jsonl`); await jsonl(file,[{type:'user',sessionId:launch.sessionId}]);
  const session={id:launch.sessionId,file};
  const resumed=await createResume(original,session,config,{spawnImpl:fakeSpawner(calls),env:{PATH:process.env.PATH,CLAUDECODE:'secret'}});
  assert.equal(resumed.resumeOf,launch.launchId); assert.equal(resumed.sessionId,launch.sessionId); assert.equal(calls.length,2);
  assert.deepEqual(resumed.args,['--agent','book','--resume',launch.sessionId]); assert.equal(calls[1].options.env.CLAUDECODE,undefined); assert.equal(calls[1].options.shell,false);
  assert.equal(JSON.parse(await fs.readFile(resumed.specFile,'utf8')).pid,process.pid);
  await fs.rm(file); await assert.rejects(createResume(original,session,config,{spawnImpl:fakeSpawner(calls)}),/会话文件/); assert.equal(calls.length,2);
});
test('K4 resume verifies alive, fresh write and unchanged Claude/Codex IDs; dead/missing/unchanged stay unconfirmed or fail',async t=>{
  const {config}=await fixture(t); const file=path.join(config.claudeProjectsDir,'p',`${sid}.jsonl`); await jsonl(file,[{type:'user',sessionId:sid}]); const baseline=await fs.stat(file);
  const record={cli:'claude',mode:'agent',pid:42,sessionId:sid,sessionFile:file,createdAt:new Date(Date.now()+1000).toISOString(),resumeBaseline:{size:baseline.size},notice:'notice'};
  assert.equal((await verifyResume(record,config,{isAlive:()=>true})).overall,'pending');
  await fs.appendFile(file,JSON.stringify({type:'assistant',sessionId:sid})+'\n'); assert.equal((await verifyResume(record,config,{isAlive:()=>true})).overall,'resumed');
  await fs.appendFile(file,JSON.stringify({sessionId:id})+'\n'); assert.equal((await verifyResume(record,config,{isAlive:()=>true})).overall,'failed');
  assert.equal((await verifyResume(record,config,{isAlive:()=>false})).overall,'failed');
  await fs.rm(file); assert.notEqual((await verifyResume(record,config,{isAlive:()=>true})).overall,'resumed');
  const codexFile=path.join(config.codexSessionsDir,'rollout.jsonl'); await jsonl(codexFile,[{type:'session_meta',payload:{id:sid}}]);
  const cx={...record,cli:'codex',sessionFile:codexFile,resumeBaseline:{size:(await fs.stat(codexFile)).size}};
  await fs.appendFile(codexFile,JSON.stringify({type:'event_msg',payload:{type:'task_started'}})+'\n'); assert.equal((await verifyResume(cx,config,{isAlive:()=>true})).overall,'resumed');
  await jsonl(codexFile,[{type:'session_meta',payload:{id}}, {type:'event_msg',payload:{type:'task_started'}}]); assert.equal((await verifyResume({...cx,resumeBaseline:{size:0}},config,{isAlive:()=>true})).overall,'failed');
});
test('K4/K5 verified sessions survive restart, history max 10, missing explanation, status changes atomic EXDEV, seven-day running horizon',async t=>{
  const {config}=await fixture(t); const sessionFile=path.join(config.claudeProjectsDir,'p',`${sid}.jsonl`); await put(sessionFile,'{}\n');
  const verifier=async()=>({overall:'ready',process:{state:'alive'},session:{id:sid,file:sessionFile}});
  const io={rename:async()=>{throw Object.assign(new Error('EXDEV'),{code:'EXDEV'});}};
  const store=createSessions(config,{verifier,isAlive:()=>true,io});
  for(let i=0;i<12;i++) {const launchId=`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`; const rec={launchId,cli:'claude',agentId:'book',agentName:'book',mode:'agent',pid:42,createdAt:new Date(Date.now()-i*1000).toISOString()}; await put(path.join(config.dataDir,'launches',`${launchId}.json`),JSON.stringify(rec)); await store.register('launch',rec); await store.check('launch',launchId); }
  assert.equal((await store.history('book')).items.length,10);
  const recovered=createSessions(config,{verifier,isAlive:()=>true}); await recovered.recover(); assert.equal((await recovered.running()).items.length,12);
  assert.equal((await recovered.history('book')).items[0].launchId,'11111111-1111-4111-8111-000000000000');
  const dead=createSessions(config,{verifier,isAlive:()=>false}); await dead.recover(); assert.equal((await dead.running()).items.length,0);
  await fs.rm(sessionFile); const history=await recovered.history('book'); assert.equal(history.items.length,0); assert.match(history.unavailable[0].reason,/会话文件/);
  const old={launchId:id,cli:'claude',pid:42,createdAt:new Date(Date.now()-8*86400000).toISOString()}; await put(path.join(config.dataDir,'launches',`${id}.json`),JSON.stringify(old)); await recovered.recover(); assert.ok(!(await recovered.running()).items.some(i=>i.id===id));
});
test('K5 sidecars never count as launches, change source coverage, or produce parse errors',async t=>{
  const {config}=await fixture(t); const createdAt=new Date().toISOString(); await put(path.join(config.dataDir,'launches',`${id}.json`),JSON.stringify({launchId:id,agentName:'Book',cli:'claude',createdAt}));
  const stats=createStats(config,[agent]); await stats.refresh(); const before=stats.snapshot();
  await put(path.join(config.dataDir,'launches',`${id}.status.json`),JSON.stringify({launchId:id,agentName:'Book',cli:'claude',createdAt,overall:'ready'}));
  await stats.refresh(); const after=stats.snapshot(); assert.deepEqual(after.perAgent,before.perAgent);
  assert.equal(after.sources.find(s=>s.id==='hub').files,1); assert.equal(after.sources.find(s=>s.id==='hub').failedFiles.length,0);
});
test('K4 launch verifier exposes independently found session file/id',async t=>{
  const {config}=await fixture(t); const file=path.join(config.claudeProjectsDir,'p',`${sid}.jsonl`); await jsonl(file,[{type:'user',cwd:config.launchProject,sessionId:sid,message:{content:`【CO-AGENT 启动检查 ${id}】`}},{type:'agent-setting',agentSetting:'book'},{type:'assistant',message:{content:'ready'}}]);
  const status=await verifyLaunch({launchId:id,sessionId:sid,cli:'claude',mode:'agent',agentName:'book',pid:42,createdAt:new Date().toISOString()},config,{isAlive:()=>true}); assert.deepEqual(status.session,{id:sid,file});
});
test('K3/K4/K5 HTTP confirmation, history, resume, background persistence and restart use only fake spawn',async t=>{
  let app;t.after(()=>app?.close());const {config}=await fixture(t);config.verifyPollMs=20;const calls=[],file=path.join(config.claudeProjectsDir,'p',`${sid}.jsonl`);await jsonl(file,[{type:'user',sessionId:sid}]);
  const listed={...agent,kind:'book',sources:{checked:true,total:1,missing:['D:\\missing.epub']}};
  const status={overall:'ready',process:{state:'alive'},cwd:{state:'ok'},agent:{state:'confirmed'},waiting:{state:'ok'},session:{id:sid,file}};
  const options={registryBuilder:async()=>({agents:[listed]}),verifier:async()=>structuredClone(status),spawnImpl:fakeSpawner(calls)};
  app=await createApp(config,options);await app.listen();let base=`http://127.0.0.1:${app.server.address().port}`;
  const post=(url,body,auth=true)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Co-Agent-Token':app.token}:{})},body:JSON.stringify(body)});
  assert.equal((await post('/api/launch',{agentId:'book',cli:'claude',sourcesConfirmed:'true'})).status,409);assert.equal(calls.length,0);
  const launch=await (await post('/api/launch',{agentId:'book',cli:'claude',sourcesConfirmed:true})).json();
  // No status HTTP request: background observation alone must create the sidecar.
  const sidecar=path.join(config.dataDir,'launches',`${launch.launchId}.status.json`);let persisted;
  for(let i=0;i<40;i++){try{persisted=JSON.parse(await fs.readFile(sidecar,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(r=>setTimeout(r,10));}}
  assert.equal(persisted.overall,'ready');
  const history=await (await fetch(base+'/api/history/book')).json();assert.equal(history.items[0].launchId,launch.launchId);
  assert.equal((await post('/api/resume',{agentId:'book',launchId:launch.launchId,sourcesConfirmed:true},false)).status,403);
  assert.equal((await post('/api/resume',{agentId:'fake',launchId:launch.launchId})).status,400);
  assert.equal((await post('/api/resume',{agentId:'book',launchId:launch.launchId})).status,409);
  const resumed=await (await post('/api/resume',{agentId:'book',launchId:launch.launchId,sourcesConfirmed:true})).json();assert.equal(resumed.resumeOf,launch.launchId);assert.equal(calls.length,2);
  await fs.appendFile(file,JSON.stringify({type:'assistant',sessionId:sid})+'\n');
  // A background poll may cache pending immediately before the append. Observe the next poll,
  // rather than assuming the first HTTP request bypasses verifyPollMs.
  let resumedStatus;
  for(let i=0;i<40;i++){
    resumedStatus=(await (await fetch(base+`/api/launch/${resumed.launchId}`)).json()).overall;
    if(resumedStatus!=='pending')break;
    await new Promise(r=>setTimeout(r,config.verifyPollMs));
  }
  assert.equal(resumedStatus,'resumed');
  await app.close();app=await createApp(config,options);await app.listen();base=`http://127.0.0.1:${app.server.address().port}`;
  const running=await (await fetch(base+'/api/running')).json();assert.equal(running.items.length,2);assert.equal(calls.length,2);
  await fs.rm(file);const missing=await (await fetch(base+'/api/history/book')).json();assert.equal(missing.items.length,0);assert.match(missing.unavailable[0].reason,/会话文件/);
});
test('K5 joint sidecars persist every change and recover independently of browser polling',async t=>{
  const {config}=await fixture(t);config.verifyPollMs=0;const jointId=id;const rec={jointId,cli:'codex',pid:42,createdAt:new Date().toISOString(),whitelist:[{codexName:'Book'}]};await put(path.join(config.dataDir,'joints',`${jointId}.json`),JSON.stringify(rec));
  let alive=true,phase='pending';const store=createSessions(config,{isAlive:()=>alive,jointVerifier:async()=>({overall:phase,process:{state:'alive'}})});await store.recover();
  const file=path.join(config.dataDir,'joints',`${jointId}.status.json`);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).overall,'pending');phase='done';await store.refresh();assert.equal(JSON.parse(await fs.readFile(file,'utf8')).overall,'done');
  assert.equal((await store.running()).items[0].whitelist[0].codexName,'Book');alive=false;await store.refresh();assert.equal(JSON.parse(await fs.readFile(file,'utf8')).process.state,'exited');
});
