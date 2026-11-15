import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fixture, put, fakeSpawner, jsonl } from './fixtures/helpers.mjs';
import { createSessions } from '../src/launch/history.mjs';
import { createLaunch } from '../src/launch/spec.mjs';
import { createJoint } from '../src/joint/spec.mjs';
import { createResume, verifyResume } from '../src/launch/resume.mjs';
import { verifyLaunch } from '../src/launch/verify.mjs';
import { verifyJoint } from '../src/joint/verify.mjs';
import { createApp } from '../src/server.mjs';
import { parseHub } from '../src/stats/hub.mjs';

const closing = () => import('../src/close.mjs');
const instant = '2026-10-08T01:00:00.000Z';
const member = { id: 'walvo', name: 'Walvo', platforms: { claude: { available: true, name: 'walvo' }, codex: { available: true } }, sources: { missing: [] } };
function record(type = 'launch', extra = {}) {
  const id = randomUUID();
  return { [type === 'joint' ? 'jointId' : 'launchId']: id, createdAt: instant, pid: 4242, cli: 'codex', agentId: member.id,
    agentName: member.name, mode: type === 'joint' ? 'joint' : 'relay', title: `CO-AGENT · ${type === 'joint' ? '联合调用' : 'Walvo'} · ${id.slice(0,4)}`,
    ...(type === 'joint' ? { whitelist: [{ id: member.id, codexName: member.name, claudeName: 'walvo' }] } : {}), ...extra };
}
async function harness(t, type = 'launch', extra = {}, overrides = {}) {
  const { root, config } = await fixture(t), r = record(type, extra), id = r.launchId || r.jointId;
  const file = path.join(config.dataDir, type === 'joint' ? 'joints' : 'launches', `${id}.json`);
  await put(file, JSON.stringify(r));
  const calls = [], live = new Set([r.pid]), isAlive = pid => live.has(pid);
  const sessions = createSessions(config, { isAlive, verifier: async () => ({ overall: 'ready' }), jointVerifier: async () => ({ overall: 'done' }) });
  await sessions.register(type, r);
  let clock = Date.parse(instant);
  const options = { isAlive, queryProcess: async pid => { calls.push(['query', pid]); return { pid, name: 'pwsh.exe', creationDate: instant }; },
    killTree: async child => { calls.push(['kill', child.pid]); live.delete(child.pid); },
    closeWindow: async current => { calls.push(['window', current.title]); return { windowClosed: true }; },
    now: () => clock, sleep: async ms => { clock += ms; }, ...overrides };
  const closer = (await closing()).createCloser(config, sessions, options);
  return { root, config, r, file, sessions, calls, live, options, close: body => closer.close(body), body: { items: [{ type, id }] } };
}

test('v013 body validates all items before side effects; missing/dead/already closed are not-running', async t => {
  const h = await harness(t);
  for (const body of [null, {}, { items: [] }, { items: new Array(51).fill(h.body.items[0]) }, { items: [null] },
    { items: [{ type: 'bad', id: h.r.launchId }] }, { items: [{ type: 'launch', id: '../escape' }] },
    { items: [h.body.items[0], { type: 'joint', id: 'bad' }] }, { items: [{ ...h.body.items[0], pid: 123 }] }])
    await assert.rejects(h.close(body), e => e.status === 400);
  assert.deepEqual(h.calls, []);
  assert.equal((await h.close({ items: [{ type: 'launch', id: randomUUID() }] })).items[0].result, 'not-running');
  h.live.clear(); assert.equal((await h.close(h.body)).items[0].result, 'not-running'); assert.deepEqual(h.calls, []);
  h.r.closedAt = instant; h.live.add(h.r.pid);
  assert.equal((await h.close(h.body)).items[0].result, 'not-running'); assert.deepEqual(h.calls, []);
});

test('v013 PID creation window is inclusive and mismatches/invalid identities never kill or close', async t => {
  for (const [delta, accepted] of [[-60001,false],[-60000,true],[180000,true],[180001,false]]) {
    const h = await harness(t, 'launch', {}, { queryProcess: async pid => ({ pid, name: 'powershell.exe', creationDate: new Date(Date.parse(instant) + delta).toISOString() }) });
    assert.equal((await h.close(h.body)).items[0].result, accepted ? 'closed' : 'pid-mismatch');
    assert.equal(h.calls.some(c => c[0] === 'kill'), accepted);
  }
  for (const identity of [null, {}, { pid: 5, name: 'pwsh.exe', creationDate: instant },
    { pid: 4242, name: 'pwsh.exe', creationDate: 'invalid' },
    ...['WindowsTerminal.exe','electron.exe','CO-AGENT.exe','claude.exe'].map(name => ({ pid: 4242, name, creationDate: instant }))]) {
    const h = await harness(t, 'launch', {}, { queryProcess: async () => identity });
    assert.equal((await h.close(h.body)).items[0].result, 'pid-mismatch'); assert.deepEqual(h.calls, []);
  }
  for (const pid of [null, 0, -1, 1.5, '4242', process.pid]) {
    const h = await harness(t, 'launch', { pid }, { isAlive: () => true });
    assert.equal((await h.close(h.body)).items[0].result, 'pid-mismatch'); assert.deepEqual(h.calls, []);
  }
});

test('v013 close order, atomic metadata, evidence preservation and statistics remain intact', async t => {
  for (const type of ['launch', 'joint']) {
    const h = await harness(t, type), session = { id: randomUUID(), file: path.join(h.root, 'session.jsonl') };
    await put(session.file, 'original session bytes\r\n');
    await h.sessions.register(type, h.r, { overall: 'ready', session });
    const events = type === 'launch' ? await parseHub(h.file) : null;
    const value = (await h.close(h.body)).items[0];
    assert.deepEqual(value, { ...h.body.items[0], result: 'closed', windowClosed: true });
    assert.deepEqual(h.calls.map(c => c[0]), ['query','kill','window']);
    const saved = JSON.parse(await fs.readFile(h.file, 'utf8'));
    assert.deepEqual(saved, { ...h.r, closedAt: instant, closedBy: 'user' });
    if (type === 'launch') assert.deepEqual((await parseHub(h.file)).events, events.events);
    const status = await h.sessions.check(type, h.body.items[0].id);
    assert.equal(status.overall, 'closed'); assert.equal(status.message, '已关闭（用户）'); assert.deepEqual(status.session, session);
    assert.deepEqual((await h.sessions.running()).items, []);
    const history = (await h.sessions.allHistory()).items[0];
    assert.equal(history.status.overall, 'closed'); assert.equal(history.statusTone, 'pending'); assert.equal(history.canResume, true);
    assert.equal(await fs.readFile(session.file, 'utf8'), 'original session bytes\r\n');
    assert.deepEqual((await h.sessions.originalRecord(type, h.body.items[0].id)).session, session);
    const recovered = createSessions(h.config, { isAlive: () => true }); await recovered.recover();
    assert.deepEqual((await recovered.running()).items, []); assert.equal((await recovered.allHistory()).items[0].status.overall, 'closed');
  }
});

test('v013 closed dominates direct verifiers and historical reverify without losing resumability', async t => {
  const h = await harness(t, 'launch', { cli: 'claude', mode: 'agent', args: ['--session-id', randomUUID()], closedAt: instant, closedBy: 'user' });
  for (const [verify, r] of [[verifyLaunch,h.r],[verifyResume,h.r],[verifyJoint,record('joint',{closedAt:instant})]]) {
    const status = await verify(r,h.config,{isAlive:()=>{throw new Error('closed PID must not be queried');}});
    assert.equal(status.overall,'closed'); assert.equal(status.message,'已关闭（用户）');
  }
  const sessionId = h.r.args[1], file = path.join(h.config.claudeProjectsDir,'project',`${sessionId}.jsonl`);
  await jsonl(file,[{cwd:h.config.launchProject,sessionId,agentSetting:member.name}]);
  await h.sessions.reverify([member.id]);
  const sidecar = JSON.parse(await fs.readFile(h.file.replace('.json','.status.json'),'utf8'));
  assert.equal(sidecar.overall,'closed'); assert.equal(sidecar.session.id,sessionId);
  assert.equal((await h.sessions.allHistory()).items[0].canResume,true);
});

test('v013 duplicate concurrent requests kill at most once; in-flight verification cannot undo closure', async t => {
  const h = await harness(t); let release, entered;
  const gate = new Promise(resolve => { release=resolve; }), started = new Promise(resolve => { entered=resolve; });
  const sessions = createSessions(h.config,{isAlive:h.options.isAlive,verifier:async()=>{entered();await gate;return {overall:'ready'};}});
  await sessions.register('launch',h.r);
  const check = sessions.check('launch',h.r.launchId); await started;
  const closer = (await closing()).createCloser(h.config,sessions,h.options);
  const a=closer.close(h.body),b=closer.close(h.body); release(); await check;
  const results=await Promise.all([a,b]); assert.deepEqual(results.map(r=>r.items[0].result),['closed','not-running']);
  assert.equal(h.calls.filter(c=>c[0]==='kill').length,1); assert.equal((await sessions.check('launch',h.r.launchId)).overall,'closed');
});

test('v013 kill errors and 10s exit deadline never close windows or claim closed', async t => {
  for (const killTree of [async()=>{throw new Error('tree failed');},async()=>{}]) {
    const h=await harness(t,'launch',{}, {killTree});
    const outcome=(await h.close(h.body)).items[0]; assert.equal(outcome.result,'failed');
    assert.match(outcome.error,/tree failed|10|超时/);
    assert.ok(!h.calls.some(c=>c[0]==='window')); assert.equal(JSON.parse(await fs.readFile(h.file,'utf8')).closedAt,undefined);
  }
  const h=await harness(t,'launch',{}, {queryProcess:async()=>{throw new Error('CIM denied');}});
  assert.equal((await h.close(h.body)).items[0].result,'failed'); assert.deepEqual(h.calls,[]);
});

test('v013 no-WT skips window helper; window errors preserve closed tree result with a warning', async t => {
  const noWt=await harness(t,'launch',{terminalFallback:'no-wt'});
  assert.equal((await noWt.close(noWt.body)).items[0].windowClosed,false); assert.ok(!noWt.calls.some(c=>c[0]==='window'));
  const h=await harness(t,'launch',{}, {closeWindow:async()=>{throw new Error('window access denied');}});
  const result=(await h.close(h.body)).items[0]; assert.equal(result.result,'closed'); assert.equal(result.windowClosed,false); assert.match(result.windowReason,/window access denied/);
});

test('v013 record save failure cannot publish closed; one failed item does not abort the remaining batch', async t => {
  const h=await harness(t), before=await fs.readFile(h.file);
  const sessions=createSessions(h.config,{isAlive:h.options.isAlive,io:{rename:async()=>{throw new Error('disk denied');}}});
  await sessions.register('launch',h.r);
  const closer=(await closing()).createCloser(h.config,sessions,h.options);
  const missing={type:'joint',id:randomUUID()};
  const outcome=await closer.close({items:[h.body.items[0],missing]});
  assert.equal(outcome.items[0].result,'failed'); assert.match(outcome.items[0].error,/disk denied/); assert.equal(outcome.items[1].result,'not-running');
  assert.equal(sessions.registeredRecord('launch',h.r.launchId).closedAt,undefined); assert.deepEqual(await fs.readFile(h.file),before);
  const fifty=await closer.close({items:Array.from({length:50},()=>({type:'launch',id:randomUUID()}))});
  assert.equal(fifty.items.length,50); assert.ok(fifty.items.every(item=>item.result==='not-running'));
});

test('v013 disappearance after identity query is not-running, without kill or window calls',async t=>{
  const h=await harness(t); h.options.queryProcess=async pid=>{h.live.clear();return {pid,name:'pwsh.exe',creationDate:instant};};
  const closer=(await closing()).createCloser(h.config,h.sessions,h.options);
  assert.equal((await closer.close(h.body)).items[0].result,'not-running');assert.deepEqual(h.calls,[]);
});

function helperSpawn(t, output, inspect = async () => {}) {
  return (exe,args,options) => {
    assert.equal(options.shell,false); assert.equal(options.windowsHide,true);
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>true;
    queueMicrotask(async()=>{try { await inspect(exe,args,options); child.stdout.end(JSON.stringify(output)); child.stderr.end(); child.emit('close',0); } catch(error) { child.emit('error',error); }});
    return child;
  };
}
test('v013 console helpers use static argv and spec files; process query cannot accept injected PID text',async t=>{
  const {config}=await fixture(t), mod=await closing();
  const identity={pid:4242,name:'pwsh.exe',creationDate:instant}; let specPath;
  const query=await mod.queryProcess(4242,config,{spawnImpl:helperSpawn(t,identity,async(exe,args,options)=>{
    assert.equal(exe,config.pwshExe); assert.deepEqual(args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
    assert.equal(args[4],mod.PROCESS_HELPER); specPath=options.env.CO_AGENT_CLOSE_SPEC;
    assert.ok(specPath.startsWith(config.dataDir+path.sep)); assert.deepEqual(JSON.parse(await fs.readFile(specPath,'utf8')),{pid:4242});
    assert.match(mod.PROCESS_HELPER,/CreationDate/); assert.match(mod.PROCESS_HELPER,/Win32_Process/);
  })});
  assert.deepEqual(query,identity); await assert.rejects(fs.stat(specPath),{code:'ENOENT'});
  await assert.rejects(mod.queryProcess('4; Stop-Process -Name *',config,{spawnImpl:()=>{assert.fail('spawn');}}),/PID/);
  const title='CO-AGENT · 中文 $() ; & · abcd';
  await mod.closeTerminalWindow({title},config,{spawnImpl:helperSpawn(t,{windowClosed:true},async(exe,args,options)=>{
    assert.equal(args[4],mod.WINDOW_HELPER); assert.ok(!args.some(arg=>arg.includes(title)));
    assert.deepEqual(JSON.parse(await fs.readFile(options.env.CO_AGENT_CLOSE_SPEC,'utf8')),{title});
  })});
});

test('v013 actual C# window policy filters visible exact class/title using only injected native operations',async t=>{
  const {WINDOW_SOURCE,WINDOW_HELPER}=await closing(),{root}=await fixture(t);
  const source=WINDOW_SOURCE+String.raw`
public static class WindowFixture {
  public static string Check() {
    string title="CO-AGENT · Walvo · abcd";
    var exact=new CoAgentWindowCloser.Window {Handle=new IntPtr(100),Visible=true,ClassName="CASCADIA_HOSTING_WINDOW_CLASS",Title=title};
    var noise=new[] {
      new CoAgentWindowCloser.Window {Handle=new IntPtr(101),Visible=false,ClassName=exact.ClassName,Title=title},
      new CoAgentWindowCloser.Window {Handle=new IntPtr(102),Visible=true,ClassName="Other",Title=title},
      new CoAgentWindowCloser.Window {Handle=new IntPtr(103),Visible=true,ClassName=exact.ClassName,Title=title+" more"},
      new CoAgentWindowCloser.Window {Handle=new IntPtr(104),Visible=true,ClassName=exact.ClassName,Title=title.ToLowerInvariant()}
    };
    var calls=new List<IntPtr>(); Func<IntPtr,bool> post=handle=>{calls.Add(handle);return true;};
    var result=CoAgentWindowCloser.CloseExact(title,()=>noise,post);
    if(result.windowClosed || result.windowReason!="终端窗口已不存在" || calls.Count!=0) throw new Exception("zero");
    var windows=new List<CoAgentWindowCloser.Window>(noise);windows.Add(exact);
    result=CoAgentWindowCloser.CloseExact(title,()=>windows.ToArray(),post);
    if(!result.windowClosed || calls.Count!=1 || calls[0]!=exact.Handle) throw new Exception("one");
    calls.Clear();windows.Add(new CoAgentWindowCloser.Window {Handle=new IntPtr(200),Visible=true,ClassName=exact.ClassName,Title=title});
    result=CoAgentWindowCloser.CloseExact(title,()=>windows.ToArray(),post);
    if(result.windowClosed || result.windowReason!="有多个同名终端窗口，请手动关闭" || calls.Count!=0) throw new Exception("many");
    result=CoAgentWindowCloser.CloseExact(title,()=>new[]{exact},handle=>false);
    if(result.windowClosed || result.windowReason!="终端窗口关闭请求失败") throw new Exception("post failure");
    return "all native operations mocked";
  }
}`;
  const file=path.join(root,'window-policy.ps1');
  await put(file,"\ufeff$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n"+source+"\n'@\n[WindowFixture]::Check()\n");
  const output=execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',file],{shell:false,windowsHide:true,encoding:'utf8'});
  assert.match(output,/all native operations mocked/);
  assert.match(WINDOW_HELPER,/EnumWindows/); assert.match(WINDOW_HELPER,/IsWindowVisible/); assert.match(WINDOW_HELPER,/GetClassName/); assert.match(WINDOW_HELPER,/GetWindowText/);
  assert.match(WINDOW_HELPER,/StringComparison.Ordinal/); assert.match(WINDOW_HELPER,/Count == 1/); assert.match(WINDOW_HELPER,/PostMessage/); assert.match(WINDOW_HELPER,/0x0010/);
});

test('v013 actual PowerShell process helper uses only an injected CIM query and preserves UTC creation time',async t=>{
  const {PROCESS_HELPER}=await closing(),{root}=await fixture(t),spec=path.join(root,'query.json'),script=path.join(root,'query.ps1');
  await put(spec,JSON.stringify({pid:4242}));
  await put(script,"\ufefffunction Get-CimInstance { param($ClassName,$Filter)\nif ($ClassName -cne 'Win32_Process' -or $Filter -cne 'ProcessId=4242') { throw 'wrong query' }\n[pscustomobject]@{ProcessId=4242;Name='pwsh.exe';CreationDate=[DateTime]::Parse('2026-10-08T01:00:00Z').ToUniversalTime()}\n}\n"+PROCESS_HELPER);
  const output=execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',script],{shell:false,windowsHide:true,encoding:'utf8',env:{...process.env,CO_AGENT_CLOSE_SPEC:spec}});
  const result=JSON.parse(output);assert.equal(result.pid,4242);assert.equal(result.name,'pwsh.exe');assert.equal(Date.parse(result.creationDate),Date.parse(instant));
});

test('v013 process-tree boundary uses only verified numeric PID argv, never image names',async t=>{
  const {killProcessTree}=await import('../src/concepts/runner.mjs'); const calls=[];
  await killProcessTree({pid:4242},{platform:'win32',spawnImpl:(exe,args,options)=>{
    calls.push({exe,args,options}); const child=new EventEmitter(); queueMicrotask(()=>child.emit('close',0)); return child;
  }});
  assert.equal(calls.length,1); assert.deepEqual(calls[0].args,['/PID','4242','/T','/F']);
  assert.equal(calls[0].options.shell,false); assert.equal(calls[0].options.windowsHide,true); assert.ok(!calls[0].args.includes('/IM'));
});

test('v013 launch/joint/resume title follows each new record ID and flows into wt and saved RawUI spec',async t=>{
  const {config,root}=await fixture(t),calls=[],spawnImpl=fakeSpawner(calls,4242);
  const launch=await createLaunch(member,'codex',config,{spawnImpl});
  const joint=await createJoint({input:'test',cli:'codex',agents:[member]},config,{spawnImpl});
  const file=path.join(root,'session.jsonl'); await put(file,'{}\n');
  const records=[launch,joint];
  for(const original of [launch,joint]) records.push(await createResume({...original,closedAt:instant,closedBy:'user'},{id:randomUUID(),file},config,{spawnImpl}));
  for(const [i,r] of records.entries()) {
    const expected=`CO-AGENT · ${r.jointId?'联合调用':member.name} · ${(r.jointId||r.launchId).slice(0,4)}`;
    assert.equal(r.title,expected); assert.equal(calls[i].options.env.AH_TITLE,expected); assert.equal(r.argvPreview.wt[r.argvPreview.wt.indexOf('--title')+1],expected);
    assert.equal(JSON.parse(await fs.readFile(r.specFile,'utf8')).title,expected); assert.equal(r.closedAt,undefined);
  }
  const script=await fs.readFile('launcher/launch.ps1','utf8'); assert.match(script,/WindowTitle\s*=\s*\$spec\.title/);
});

test('v013 HTTP close requires token/Origin, reports per-item outcomes, and does not refresh stats',async t=>{
  // After hooks run in registration order: close the app before the fixture folder is removed.
  let app; t.after(()=>app?.close());
  const {config}=await fixture(t), live=new Set([4242]),calls=[]; let refreshes=0;
  app=await createApp(config,{conceptAutoDaily:false,isAlive:pid=>live.has(pid),registryBuilder:async()=>({agents:[]}),
    verifier:async()=>({overall:'ready'}),statsFactory:()=>({refresh:async()=>{refreshes++;}}),
    closeOptions:{queryProcess:async pid=>({pid,name:'pwsh.exe',creationDate:instant}),killTree:async child=>{calls.push(child.pid);live.delete(child.pid);},closeWindow:async()=>({windowClosed:true})}});
  await app.listen(); const r=record();
  await put(path.join(config.dataDir,'launches',`${r.launchId}.json`),JSON.stringify(r)); await app.sessions.register('launch',r);
  const base=`http://127.0.0.1:${app.server.address().port}`,body={items:[{type:'launch',id:r.launchId}]};
  const request=async(headers={},value=body)=>fetch(base+'/api/running/close',{method:'POST',headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token,...headers},body:JSON.stringify(value)});
  assert.equal((await request({'X-Co-Agent-Token':''})).status,403); assert.equal((await request({Origin:'https://evil.invalid'})).status,403); assert.deepEqual(calls,[]);
  assert.equal((await request({}, {items:[]})).status,400); const before=refreshes;
  const response=await request({Origin:base}); assert.equal(response.status,200); assert.equal((await response.json()).items[0].result,'closed');
  assert.deepEqual(calls,[4242]); assert.equal(refreshes,before); assert.deepEqual((await (await fetch(base+'/api/running')).json()).items,[]);
});
