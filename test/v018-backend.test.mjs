import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put } from './fixtures/helpers.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createCandidates, linkCandidate, runCandidateSuggestions, suggestionPrompt, suggestionSchema } from '../src/registry/candidates.mjs';

const categories = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json', 'utf8')).categories;
const candidate = (id = 'newbook', name = 'NewBook') => ({ id, name, description: 'edition-bound book Agent', hasReadingMd: true, bookFiles: [] });
const item = id => ({ id, title: '《测试书》', author: '作者', edition: '中文版', primary: categories[0] });
const registry = (...candidates) => ({ candidates, categories, agents: [], summary: {}, examples: [] });
const missing = () => Object.assign(Error('missing'), { code: 'ENOENT' });

// Every source/link operation is virtual. Tests never create even temporary symlinks.
function linkIO(config, { existing = false, escapedSource = false, escapedParent = false, source = true, fail = false } = {}) {
  const calls = [], dest = path.join(config.launchProject, '.claude', 'agents', 'NewBook.md');
  const target = path.join(config.readingAgentsDir, 'NEWBOOK.MD');
  return { calls, dest, target, io: {
    readdir: async dir => { assert.equal(dir, config.readingAgentsDir); return source ? ['NEWBOOK.MD'] : []; },
    realpath: async p => escapedSource && p === target ? path.join(config.launchProject, 'outside.md') : p,
    stat: async p => { assert.equal(p, target); return { isFile: () => true }; },
    lstat: async p => {
      if (p === dest && !existing) throw missing();
      return { isSymbolicLink: () => p === dest || escapedParent && p === path.join(config.launchProject, '.claude'), isDirectory: () => p !== dest };
    },
    symlink: async (...args) => { calls.push(args); if (fail) throw Object.assign(Error('privilege denied'), { code: 'EPERM' }); },
  } };
}

test('v018 discovery requires confirmation, merges additions with bundled priority, excludes ignored, backups and the book maker a-deepbooker', async t => {
  const { config } = await fixture(t);
  config.readingAgentsDir = path.join(config.dataDir, 'reading-fixture');
  await fs.mkdir(config.readingAgentsDir, { recursive: true });
  for (const [name, description] of [['NewBook', 'book Agent <example>not a summary</example>'], ['Bound', 'EDITION-BOUND'], ['Match', 'plain'], ['Other', 'utility'], ['Ignored', 'book Agent'], ['Added', 'book Agent'], ['a-deepbooker', 'book Agent'], ['Loki', 'book Agent'], ['Harlo', 'book Agent']]) {
    await put(path.join(config.codexAgentsDir, name + '.toml'), `name="${name}"\ndescription='${description}'\ndeveloper_instructions='C:/fixtures/missing.epub'`);
  }
  await put(path.join(config.codexAgentsDir, 'Backup.bak.toml'), 'name="Backup"\ndescription="book Agent"');
  await put(path.join(config.readingAgentsDir, 'mAtCh.MD'), 'fixture');
  await put(path.join(config.dataDir, 'book-additions.json'), JSON.stringify({ version: 1, books: [{ ...item('added'), agent: 'Added', tags: [] }, { ...item('harlo'), agent: 'Harlo', tags: [], title: 'must not win' }] }));
  await put(path.join(config.dataDir, 'book-ignored.json'), JSON.stringify({ version: 1, ids: ['ignored'] }));
  const r = await buildRegistry(config, { exists: async () => false });
  assert.deepEqual(r.candidates.map(c => c.id).sort(), ['bound', 'match', 'newbook']);
  assert.equal(r.summary.candidates, 3); assert.equal(r.candidates.find(c => c.id === 'match').hasReadingMd, true);
  assert.equal(r.candidates.find(c => c.id === 'newbook').hasReadingMd, false);
  assert.equal(r.candidates[0].bookFiles.length, 1); assert.ok(r.candidates.every(c => !c.description.includes('<example>')));
  assert.ok(!r.agents.some(a => ['newbook','bound','match','ignored'].includes(a.id)));
  assert.equal(r.agents.find(a => a.id === 'added').book.title, '《测试书》');
  assert.notEqual(r.agents.find(a => a.id === 'harlo').book.title, 'must not win');
});

test('v018 production link boundary, case-insensitive source, no overwrite and reported failures', async t => {
  const { config } = await fixture(t);
  for (const [options, expected] of [[{}, 'created'], [{ existing: true }, 'exists'], [{ source: false }, 'no-source'], [{ fail: true }, 'failed'], [{ escapedSource: true }, 'failed'], [{ escapedParent: true }, 'failed']]) {
    const mock = linkIO(config, options);
    const value = await linkCandidate(candidate(), config, { io: mock.io });
    assert.equal(value.link, expected); if (expected === 'failed') assert.ok(value.linkError);
    assert.equal(mock.calls.length, expected === 'created' || options.fail ? 1 : 0);
    if (mock.calls.length) assert.deepEqual(mock.calls[0], [mock.target, mock.dest, 'file']);
  }
  for (const name of ['../Bad', '..', 'a..b', 'C:\\escape', '/escape', '\\\\host\\share', 'a/b', 'a\\b', 'a:stream', 'NUL', 'Bad.']) {
    let touched = false;
    const io = new Proxy({}, { get: () => () => { touched = true; throw Error('must not touch fs'); } });
    assert.equal((await linkCandidate(candidate('bad', name), config, { io })).link, 'failed', name);
    assert.equal(touched, false);
  }
  await assert.rejects(linkCandidate(candidate(), config), /测试必须注入/);
});

test('v018 accept validates full batch before writing, serializes, survives link failure, ignore/unignore persists', async t => {
  const { config } = await fixture(t); let r = registry(candidate(), candidate('second', 'Second')), changes = 0;
  const mock = linkIO(config, { fail: true });
  const store = createCandidates(config, () => r, { linkIO: mock.io, onChanged: async () => { changes++; r = registry(candidate('second', 'Second')); } });
  for (const items of [[], Array(51).fill(item('newbook')), [item('stale')], [item('newbook'), item('newbook')], [{...item('newbook'), primary: 'invalid'}], [{...item('newbook'), title: ' '}], [{...item('newbook'), author: '字'.repeat(301)}], [item('newbook'), {...item('second'), edition: null}]]) await assert.rejects(store.accept({ items }), { status: 400 });
  await assert.rejects(fs.access(path.join(config.dataDir, 'book-additions.json')), { code: 'ENOENT' });
  const result = await store.accept({ items: [item('newbook')] });
  assert.equal(result.items[0].accepted, true); assert.equal(result.items[0].link, 'failed'); assert.match(result.items[0].linkError, /privilege/);
  const saved = JSON.parse(await fs.readFile(path.join(config.dataDir, 'book-additions.json'), 'utf8'));
  assert.deepEqual(saved.books, [{ agent: 'NewBook', title: '《测试书》', author: '作者', edition: '中文版', primary: categories[0], tags: [] }]);
  assert.equal(changes, 1);
  await store.ignore({ ids: ['second'] }); assert.deepEqual((await store.ignored()).ids, ['second']);
  await store.unignore({ ids: ['second'] }); assert.deepEqual((await store.ignored()).ids, []);
  await assert.rejects(store.ignore({ ids: ['outside'] }), { status: 400 });
  const another = createCandidates(config, () => registry(candidate()), { linkIO: mock.io });
  await assert.rejects(another.accept({ items: [item('newbook')] }), { status: 400 });
});

test('v018 suggestion prompt/schema, once-only cache across concurrent requests and restart, invalid output retry', async t => {
  const { config } = await fixture(t); let calls = 0, bad = false;
  const r = registry(candidate(), candidate('second','Second'));
  const runner = async (selected, allowed, examples) => { calls++; assert.equal(examples.length,3); assert.deepEqual(allowed,categories); return bad ? [{...item(selected[0].id), primary:'fake'}] : selected.map(c => item(c.id)); };
  const store = createCandidates(config, () => r, { runner });
  assert.deepEqual(await Promise.all([store.suggest({ids:['newbook']}), store.suggest({ids:['newbook']})]), [[item('newbook')],[item('newbook')]]);
  assert.equal(calls, 1);
  const restarted = createCandidates(config, () => r, { runner });
  assert.deepEqual(await restarted.suggest({ ids:['newbook'] }), [item('newbook')]); assert.equal(calls, 1);
  bad = true; await assert.rejects(store.suggest({ids:['second']}), { status:409 });
  bad = false; assert.equal((await store.suggest({})).length, 2); assert.equal(calls, 3);
  await assert.rejects(store.suggest({ids:['unknown']}), {status:400});
  const prompt = suggestionPrompt([{...candidate(),description:'book Agent <example>NEVER_SEND</example>'+'字'.repeat(800)}], categories, [{agent:'Known',...item('known')}]);
  assert.ok(!prompt.includes('NEVER_SEND')); assert.ok(!prompt.includes('字'.repeat(601)));
  for (const text of [...categories,'《','*','多书，N 部','只读','数据']) assert.ok(prompt.includes(text), text);
  // Codex rejects a top-level array schema (invalid_json_schema); suggestions are wrapped as { items }.
  assert.equal(suggestionSchema(categories).type, 'object'); assert.deepEqual(suggestionSchema(categories).required, ['items']);
  assert.deepEqual(suggestionSchema(categories).properties.items.items.properties.primary.enum, categories);
});

test('v018 Codex transport uses recommendation argv, stdin, fixed 180s deadline, injected kill and no real CLI', async t => {
  const { config } = await fixture(t); const calls = [], timers = [];
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter(); child.pid = 123456; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let prompt = ''; child.stdin.on('data', c => { prompt += c; });
    child.stdin.on('finish', async () => { calls.push({exe,args,options,prompt}); await fs.writeFile(args[args.indexOf('-o')+1], JSON.stringify({ items: [item('newbook')] })); child.emit('close',0); });
    return child;
  };
  const output = await runCandidateSuggestions([candidate()], categories, [], config, { spawnImpl, setTimer: (fn, ms) => { timers.push(ms); return setTimeout(fn, ms); } });
  assert.deepEqual(output,{ items: [item('newbook')] }); assert.deepEqual(timers,[180000]); // raw Codex object output, unwrapped by the engine
  const call = calls[0]; assert.equal(call.options.shell,false); assert.equal(call.options.windowsHide,true);
  assert.equal(call.args[call.args.indexOf('-s')+1],'read-only'); assert.equal(call.args[call.args.indexOf('-m')+1],config.recommend.codex.model);
  assert.ok(call.args.includes(`model_reasoning_effort=${JSON.stringify(config.recommend.codex.effort)}`)); assert.equal(call.args.at(-1),'-');
  assert.ok(!call.args.some(arg => arg.includes('book Agent'))); assert.match(call.prompt,/NewBook/);
  let killed = 0;
  await assert.rejects(runCandidateSuggestions([candidate()],categories,[],config, { spawnImpl: () => { const c = new EventEmitter(); c.pid=123456; c.stdin=new PassThrough(); return c; }, setTimer: fn => setTimeout(fn,1), killTree: async c => {assert.equal(c.pid,123456); killed++;} }), /超时/);
  assert.equal(killed,1); await assert.rejects(runCandidateSuggestions([],categories,[],config),/测试必须注入/);
  // v0.53: Codex ending without an answer (not signed in) is said plainly, without the missing file's path.
  const silent = () => { const c = new EventEmitter(); c.pid = 123456; c.stdin = new PassThrough(); c.stdin.on('finish', () => c.emit('close', 0)); c.stdin.resume(); return c; };
  await assert.rejects(runCandidateSuggestions([candidate()], categories, [], config, { spawnImpl: silent }),
    error => /Codex 没有给出结果/.test(error.message) && !/ENOENT|out\.json/.test(error.message));
});

test('v018 routes enforce token/Origin, suggestion failure 409, acceptance refreshes registry and stats', async t => {
  let app; t.after(() => app?.close()); const { config } = await fixture(t);
  config.readingAgentsDir = path.join(config.dataDir, 'reading-fixture');
  await put(path.join(config.codexAgentsDir,'NewBook.toml'),'name="NewBook"\ndescription="edition-bound"');
  const mock = linkIO(config, { source:false }); let fail = true, statIds=[], refreshes=0;
  app = await createApp(config, { conceptAutoDaily:false,
    statsFactory:()=>({setAgents:agents=>{statIds=agents.map(a=>a.id);},refresh:async()=>{refreshes++;},snapshot:()=>({perAgent:{},sources:[]})}),
    candidateOptions:{ linkIO:mock.io, runner:async selected=>{if(fail)throw Error('fixture failure');return selected.map(c=>item(c.id));} } });
  await app.listen(); const base=`http://127.0.0.1:${app.server.address().port}`;
  const post = (route,body,headers={}) => fetch(base+'/api/candidates/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token,Origin:base,...headers},body:JSON.stringify(body)});
  for(const route of ['suggest','accept','ignore','unignore']) {
    assert.equal((await post(route,{}, {'X-Co-Agent-Token':'bad'})).status,403);
    assert.equal((await post(route,{}, {Origin:'https://evil.example'})).status,403);
  }
  assert.equal((await post('suggest',{})).status,409); fail=false;
  assert.deepEqual(await (await post('suggest',{})).json(),[item('newbook')]);
  assert.equal((await post('accept',{items:[item('newbook')]})).status,200);
  const r=await (await fetch(base+'/api/registry')).json(); assert.equal(r.summary.candidates,0); assert.equal(r.agents[0].book.title,'《测试书》');
  assert.deepEqual(statIds,['newbook']);assert.equal(refreshes,2);
  assert.equal((await (await fetch(base+'/api/candidates/ignored')).json()).ids.length,0);
  assert.equal((await post('accept',{items:[item('newbook')]})).status,400);
});

test('v018 readingAgentsDir is configurable and protects its source from runtime writes', async t => {
  const {root,config}=await fixture(t);
  const fresh=await loadConfig({env:{CO_AGENT_DATA_DIR:path.join(root,'isolated')}});
  assert.equal(fresh.readingAgentsDir,null,'v0.50: no Reading folder unless configured');
  await put(path.join(config.dataDir,'config.json'),JSON.stringify({readingAgentsDir:'../relative'}));
  await assert.rejects(loadConfig({env:{CO_AGENT_DATA_DIR:config.dataDir}}),/readingAgentsDir/);
  await put(path.join(config.dataDir,'config.json'),JSON.stringify({readingAgentsDir:root}));
  await assert.rejects(loadConfig({env:{CO_AGENT_DATA_DIR:config.dataDir}}),/只读/);
});

test('v018 suggestion validation rejects missing, duplicate, foreign and extra schema fields without caching', async t => {
  const { config } = await fixture(t); const r=registry(candidate(),candidate('second','Second'));
  for(const output of [[item('newbook')], [item('newbook'),item('newbook')], [item('newbook'),item('foreign')], [item('newbook'),{...item('second'),unexpected:true}], [{...item('newbook'),author:''},item('second')]]) {
    const store=createCandidates(config,()=>r,{runner:async()=>output});
    await assert.rejects(store.suggest({}),{status:409});
    await assert.rejects(fs.access(path.join(config.dataDir,'candidate-suggestions.json')),{code:'ENOENT'});
  }
});

test('v018 atomic-write failure never creates links; parallel accepts preserve both entries', async t=>{
  const {config}=await fixture(t);const r=registry(candidate(),candidate('second','Second'));let linked=0;
  const io={...fs,rename:async()=>{throw Object.assign(Error('disk failure'),{code:'EIO'});}};
  const store=createCandidates(config,()=>r,{io,linkIO:{symlink:async()=>{linked++;}}});
  await assert.rejects(store.accept({items:[item('newbook')]}),/disk failure/);assert.equal(linked,0);
  assert.deepEqual(await fs.readdir(config.dataDir),[]);
  const missingIO={lstat:async()=>{throw missing();}};
  const concurrent=createCandidates(config,()=>r,{linkIO:missingIO});
  await Promise.all([concurrent.accept({items:[item('newbook')]}),concurrent.accept({items:[item('second')]})]);
  const saved=JSON.parse(await fs.readFile(path.join(config.dataDir,'book-additions.json'),'utf8'));
  assert.deepEqual(saved.books.map(b=>b.agent),['NewBook','Second']);
});

test('v018 accept supports all 50 maximum-sized Unicode items without weakening other request limits',async t=>{
  let app;t.after(()=>app?.close());const {config}=await fixture(t);let visible=Array.from({length:50},(_,n)=>candidate(`reader${n}`,`Reader${n}`));
  const missingIO={lstat:async()=>{throw missing();}};
  app=await createApp(config,{conceptAutoDaily:false,registryBuilder:async()=>registry(...visible),candidateOptions:{linkIO:missingIO}});
  await app.listen();const base=`http://127.0.0.1:${app.server.address().port}`;
  const body={items:visible.map(c=>({...item(c.id),title:'中'.repeat(300),author:'文'.repeat(300),edition:'版'.repeat(300)}))};
  const response=await fetch(base+'/api/candidates/accept',{method:'POST',headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token},body:JSON.stringify(body)});
  assert.equal(response.status,200);assert.equal((await response.json()).items.length,50);
});

test('v018 refresh cannot restore stale candidates after a newer refresh completes',async t=>{
  let app;t.after(()=>app?.close());const {config}=await fixture(t);let reads=0,release,entered;
  const gate=new Promise(r=>{entered=r;});
  app=await createApp(config,{conceptAutoDaily:false,registryBuilder:async()=>{reads++;if(reads===2){entered();await new Promise(r=>{release=r;});return registry(candidate());}return registry();}});
  await app.listen();const base=`http://127.0.0.1:${app.server.address().port}`;
  const refresh=()=>fetch(base+'/api/refresh',{method:'POST',headers:{'X-Co-Agent-Token':app.token}});
  const first=refresh();await gate;const second=refresh();await new Promise(r=>setTimeout(r,15));release();
  await Promise.all([first,second]);const r=await(await fetch(base+'/api/registry')).json();assert.equal(r.candidates.length,0);
});

test('v018 link handles destination race and refuses ambiguous/missing/non-file source without mutation',async t=>{
  const {config}=await fixture(t);
  for(const scenario of ['race','ambiguous','missing','directory','parent-missing','parent-realpath']) {
    const mock=linkIO(config);
    if(scenario==='race')mock.io.symlink=async()=>{throw Object.assign(Error('exists'),{code:'EEXIST'});};
    if(scenario==='ambiguous')mock.io.readdir=async()=>['NEWBOOK.MD','NewBook.md'];
    if(scenario==='missing')mock.io.stat=async()=>{throw missing();};
    if(scenario==='directory')mock.io.stat=async()=>({isFile:()=>false});
    if(scenario==='parent-missing')mock.io.lstat=async()=>{throw missing();};
    if(scenario==='parent-realpath')mock.io.realpath=async()=>path.join(config.dataDir,'outside');
    const result=await linkCandidate(candidate(),config,{io:mock.io});
    assert.equal(result.link,scenario==='race'?'exists':['missing','directory'].includes(scenario)?'no-source':'failed');assert.equal(mock.calls.length,0);
  }
});

test('v018 transport failures and shutdown abort use injected process cleanup and never cache success',async t=>{
  const {config}=await fixture(t);
  for(const scenario of ['exit','spawn-error','stdin-error','abort']) {
    let kills=0;const abort=new AbortController();
    const options={signal:abort.signal,killTree:async c=>{assert.equal(c.pid,123456);kills++;},spawnImpl:()=>{
      const child=new EventEmitter();child.pid=123456;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin.on('finish',()=>queueMicrotask(()=>{
        if(scenario==='exit')child.emit('close',1);
        if(scenario==='spawn-error')child.emit('error',Error('mock spawn failure'));
        if(scenario==='stdin-error')child.stdin.emit('error',Error('mock stdin failure'));
        if(scenario==='abort')abort.abort();
      }));return child;
    }};
    await assert.rejects(runCandidateSuggestions([candidate()],categories,[],config,options),/失败|failure|中断/);
    assert.equal(kills,scenario==='exit'?0:1);
  }
  let started;const gate=new Promise(resolve=>{started=resolve;});
  const store=createCandidates(config,()=>registry(candidate()),{runner:(_s,_c,_e,_config,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});started();})});
  const suggestion=assert.rejects(store.suggest({}),{status:409});await gate;await store.close();await suggestion;
  await assert.rejects(fs.access(path.join(config.dataDir,'candidate-suggestions.json')),{code:'ENOENT'});
});
