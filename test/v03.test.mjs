import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put, jsonl, fakeSpawner } from './fixtures/helpers.mjs';
import { parseFrontmatter } from '../src/registry/frontmatter.mjs';
import { parseToml } from '../src/registry/toml-lite.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { recommendationArgs, recommendationCatalog, validateRecommendations, runRecommendation } from '../src/recommend/runner.mjs';
import { auditRecommendation, verifyJoint } from '../src/joint/verify.mjs';
import { createJoint, jointArgs, jointPlan, scanClaudeTypes } from '../src/joint/spec.mjs';
import { createApp } from '../src/server.mjs';

const at = '2026-10-06T12:00:00Z';
const agent = (name, claudeName = name) => ({ id: name.replace(/^-/, '').toLowerCase(), name, kind: 'role', primary: '功能性 Agent', tags: [], description: '注册表用途',
  writable: false, permissions: { codex: { sandbox: 'read-only' }, claude: { tools: ['Read'], writable: false } },
  platforms: { codex: { available: true }, claude: { available: true, name: claudeName } } });
const agents = [agent('-jack', 'jack'), agent('Walvo', 'walvo')];
const joint = (cli = 'claude') => ({ jointId: '12345678-1234-4234-8234-123456789abc', sessionId: '12345678-1234-4234-8234-123456789abc', cli,
  createdAt: at, pid: process.pid, whitelist: agents.map(a => ({ id: a.id, codexName: a.name, claudeName: a.platforms.claude.name })) });
const cUse = (name, id) => ({ type: 'tool_use', name: 'Agent', id, input: { subagent_type: name } });
const cRow = (type, content, id) => ({ type, cwd: 'PROJECT', message: { role: type, id, content } });
const cResult = (id, error = false, content = '结果') => cRow('user', [{ type: 'tool_result', tool_use_id: id, is_error: error, content }]);
const xMeta = (id, spawn) => ({ type: 'session_meta', payload: { id, cwd: 'PROJECT', timestamp: at, source: spawn ? { subagent: { thread_spawn: spawn } } : 'cli' } });
const xTool = (name, args = {}) => ({ type: 'response_item', payload: { type: 'function_call', name: `functions.${name}`, arguments: JSON.stringify(args) } });
const xUser = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

async function logs(t, cli, mainRows, childRows = []) {
  const { config } = await fixture(t); config.launchProject = 'PROJECT';
  const j = joint(cli);
  const main = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${j.sessionId}.jsonl`) : path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-main.jsonl');
  await jsonl(main, mainRows);
  for (const [i, rows] of childRows.entries()) await jsonl(cli === 'claude' ? path.join(path.dirname(main), j.sessionId, 'subagents', `agent-${i}.jsonl`) : path.join(path.dirname(main), `rollout-child-${i}.jsonl`), rows);
  return { config, j, main };
}

test('J1 frontmatter tools scalar, flow list, block list; TOML permission fields; registry Ben/Peter/readonly', async t => {
  for (const tools of ['Read, Write, Edit', '[Read, "Write", Edit]', '\n  - Read\n  - Write\n  - Edit']) {
    assert.deepEqual(parseFrontmatter(`---\nname: ben\nmodel: sonnet\neffort: high\ntools: ${tools}\n---`).tools, ['Read', 'Write', 'Edit']);
  }
  assert.throws(() => parseFrontmatter('---\nname: ben\ntools: {Read: yes}\n---'));
  const fields = { model: 'gpt-6.1-sol', model_reasoning_effort: 'high', web_search: 'disabled', sandbox_mode: 'read-only' };
  assert.deepEqual(parseToml(Object.entries(fields).map(([k,v]) => `${k}="${v}"`).join('\n')).values, fields);
  const { config } = await fixture(t);
  for (const [name, sandbox, tools] of [['-Ben', 'workspace-write', 'Read, Write'], ['Peter', null, 'Read, Edit'], ['Walvo', 'read-only', 'Read']]) {
    await put(path.join(config.codexAgentsDir, `${name}.toml`), `name="${name}"\ndescription="book Agent"\n${sandbox ? `sandbox_mode="${sandbox}"` : ''}`);
    await put(path.join(config.claudeAgentDirs[0], `${name}.md`), `---\nname: ${name}\ntools: ${tools}\n---`);
  }
  const registry = await buildRegistry(config);
  assert.deepEqual(registry.agents.filter(a => a.writable).map(a => a.name).sort(), ['-Ben', 'Peter']);
  assert.equal(registry.agents.find(a => a.name === 'Peter').permissions.codex.sandbox, '未声明');
});

test('J3 exact argv, catalog limit, normalization, rejection, dedupe, eight results and registry purpose', async t => {
  const { config } = await fixture(t), files = { schema: 'schema.json', output: 'out.json' };
  assert.deepEqual(recommendationArgs('claude', config, 'UUID', files), ['--disallowedTools','Agent','Bash','Write','Edit','-p','--model','sonnet','--output-format','json','--session-id','UUID']);
  assert.deepEqual(recommendationArgs('codex', config, 'UUID', files), ['exec','-m','gpt-test','-c','model_reasoning_effort="xhigh"','-s','read-only','--skip-git-repo-check','--json','--output-schema','schema.json','-o','out.json','-']);
  const many = Array.from({ length: 12 }, (_, i) => agent(`Agent_${i}`));
  many[0].id = 'agent-0'; many[0].description = '中'.repeat(400); many[0].book = { title: '书名', author: '作者' };
  const catalog = recommendationCatalog(many);
  assert.deepEqual(Object.keys(catalog[0]), ['id','name','kind','primary','summary']);
  assert.equal(catalog[0].summary, '中'.repeat(300) + '\n书名：书名；作者：作者');
  const value = validateRecommendations({ recommendations: [{ id: 'FAKE', reason: '错误' }, { id: '-AGENT_0', reason: '模型文字', purpose: '伪造用途' }, { id: 'agent_0', reason: '重复' }, ...many.slice(1).map(a => ({ id: a.id, reason: '相关' }))], note: '' }, many);
  assert.equal(value.results.length, 8); assert.equal(value.rejected[0].id, 'FAKE');
  assert.equal(value.results[0].description, many[0].description); assert.equal(value.results[0].reason, '模型文字');
  assert.throws(() => validateRecommendations({ recommendations: [{ id: many[0].id, reason: '中'.repeat(81) }] }, many));
  assert.throws(() => validateRecommendations({ recommendations: [], note: '' }, many));
});

function backgroundFake(action, calls = []) {
  return (exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { calls.at(-1).killed = true; return true; };
    let input = ''; child.stdin.on('data', c => { input += c; });
    calls.push({ exe, args, options, child });
    child.stdin.on('finish', () => setImmediate(async () => { try { await action({ child, args, input }); } catch (e) { child.emit('error', e); } }));
    return child;
  };
}

for (const engine of ['claude', 'codex']) test(`J3 ${engine} injected background process uses stdin, persisted files, clean env and audited output`, async t => {
  const { config } = await fixture(t), calls = [], id = joint().jointId;
  const spawnImpl = backgroundFake(async ({ child, args, input }) => {
    assert.ok(input.includes('原始输入 $() ` &')); assert.ok(!args.some(a => a.includes('原始输入')));
    const result = { recommendations: [{ id: '-JACK', reason: '适合' }], note: '' };
    if (engine === 'claude') {
      await jsonl(path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`), [cRow('user', input)]);
      child.stdout.end(JSON.stringify({ result: JSON.stringify(result) }));
    } else {
      await put(args[args.indexOf('-o') + 1], JSON.stringify(result));
      await jsonl(path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-r.jsonl'), [xMeta('thread'), xUser(input)]);
      child.stdout.end('{"type":"thread.started","thread_id":"thread"}\n');
    }
    child.emit('close', 0, null);
  }, calls);
  const result = await runRecommendation({ recommendId: id, engine, input: '原始输入 $() ` &', createdAt: at }, agents, config, { spawnImpl, env: { CLAUDECODE: 'secret', PATH: 'kept' } });
  assert.equal(result.status, 'done'); assert.deepEqual(result.audit, { agentCalls: 0, children: 0, ok: true });
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.cwd, config.launchProject);
  assert.equal(calls[0].options.env.CLAUDECODE, undefined); assert.equal(calls[0].options.env.PATH, 'kept');
  for (const file of ['input.txt','catalog.json','prompt.txt', engine === 'codex' ? 'schema.json' : 'stdout.txt']) assert.ok((await fs.stat(path.join(config.dataDir, 'recommend', id, file))).isFile());
});

test('J3 timeout ends the replacement process tree; nonzero exit and malformed output fail without partial results', async t => {
  const { config } = await fixture(t); config.recommend.timeoutMs = 15;
  const calls = [], trees = [];
  const task = { recommendId: joint().jointId, engine: 'claude', input: '输入', createdAt: at };
  // v0.53: the tree is ended (an npm CLI's node.exe starts the real exe), never only the direct child.
  const killTree = async child => { trees.push(child); child.emit('close', null, 'SIGTERM'); };
  const timeout = await runRecommendation(task, agents, config, { spawnImpl: backgroundFake(() => {}, calls), killTree });
  assert.equal(timeout.status, 'failed'); assert.match(timeout.error, /推荐超时（15 ms）$/); assert.deepEqual(trees, [calls[0].child]);
  assert.equal(calls[0].killed, undefined); assert.deepEqual(timeout.results, []);
  // A test that forgets the tree-kill replacement is refused instead of reaching the real taskkill.
  const unguarded = await runRecommendation(task, agents, config, { spawnImpl: backgroundFake(() => {}, calls) });
  assert.match(unguarded.error, /推荐超时.*测试必须注入进程树终止替身/); assert.equal(calls[1].killed, undefined);
  for (const [code, output] of [[1, '{"result":"{}"}'], [0, '{broken']]) {
    const result = await runRecommendation(task, agents, config, { spawnImpl: backgroundFake(({ child }) => { child.stdout.end(output); child.emit('close', code, null); }) });
    assert.equal(result.status, 'failed'); assert.deepEqual(result.results, []);
  }
});

for (const cli of ['claude', 'codex']) test(`J3 ${cli} audit detects calls/children and refuses to certify missing logs`, async t => {
  const rows = cli === 'claude' ? [cRow('assistant', [cUse('jack','a')])] : [xMeta('thread'), xTool('spawn_agent', { agent_type: '-jack' })];
  const children = cli === 'claude' ? [[cRow('assistant', [])]] : [[xMeta('child', { parent_thread_id: 'thread', depth: 1, agent_role: '-jack' })]];
  const { config, j } = await logs(t, cli, rows, children);
  const audit = await auditRecommendation({ engine: cli, sessionId: j.sessionId, threadId: 'thread' }, config);
  assert.equal(audit.ok, false); assert.equal(audit.agentCalls, 1); assert.equal(audit.children, 1);
  assert.equal((await auditRecommendation({ engine: cli, sessionId: 'missing', threadId: 'missing' }, config)).ok, false);
});

test('J5 templates byte-match contract and Claude deny list excludes whitelist, covers builtins/plugins', async t => {
  const { config, root } = await fixture(t); config.claudePluginsCacheDir = path.join(root, 'plugins');
  await put(path.join(config.claudeAgentDirs[0], 'jack.md'), '---\nname: jack\n---');
  await put(path.join(config.claudeAgentDirs[0], 'other.md'), '---\nname: other\n---');
  await put(path.join(config.claudePluginsCacheDir, 'market', 'example', '1.0', 'agents', 'tool.md'), '---\nname: helper\n---');
  const types = await scanClaudeTypes(config); assert.ok(types.includes('example:helper')); assert.ok(types.includes('Explore'));
  const input = '原文\n$() & "'; const j = { ...joint(), input };
  // v0.53: the joint-call templates of the v0.24 manual, kept verbatim in test/fixtures/templates.
  const claude = (await fs.readFile('test/fixtures/templates/v0.24-joint-claude.txt', 'utf8')).replaceAll('\r\n', '\n')
    .replace('<逗号分隔的 claudeName>', 'jack,walvo').replace('<需要格式的 claudeName 列表；没有则写「无」>', 'jack');
  const codex = (await fs.readFile('test/fixtures/templates/v0.24-joint-codex.txt', 'utf8')).replaceAll('\r\n', '\n')
    .replace('<jointId>', j.jointId).replace('<逗号分隔的 codexName>', '-jack,Walvo').replace('<需要格式的 codexName 列表；没有则写「无」>', '-jack').replace(/<用户原文>$/, input);
  const cargs = jointArgs('claude', j, agents, config, types);
  assert.equal(cargs[0], '--disallowedTools'); assert.equal(cargs[cargs.indexOf('--append-system-prompt')+1], claude);
  assert.ok(cargs.includes('Agent(example:helper)')); assert.ok(cargs.includes('Agent(Explore)')); assert.ok(!cargs.includes('Agent(jack)'));
  assert.equal(cargs.at(-1), `【CO-AGENT 联合调用 ${j.jointId}】\n${input}`);
  assert.deepEqual(jointArgs('codex', j, agents, config), ['--profile','gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh','-C',config.launchProject,codex]);
  assert.throws(() => jointArgs('claude', j, agents, config, ['x'.repeat(30000)]), /30.?000/);
  const calls = []; const spec = await createJoint({ input, cli: 'claude', agents }, config, { spawnImpl: fakeSpawner(calls) });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.shell, false);
  assert.equal(path.dirname(spec.specFile), path.join(config.dataDir, 'joints'));
  await assert.rejects(fs.stat(path.join(config.dataDir, 'launches')), { code: 'ENOENT' });
});

for (const [label, content, resultRows, childRows, parallel, whitelist] of [
  ['parallel', [cUse('jack','a'), cUse('walvo','b')], [cResult('a'), cResult('b')], [], 'ok','ok'],
  ['sequential', [cUse('jack','a')], [cResult('a'), cRow('assistant',[cUse('walvo','b')],'m2')], [], 'not-parallel','ok'],
  ['violation', [cUse('jack','a'),cUse('walvo','b'),cUse('other','c')], [], [], 'ok','violation'],
  ['denied', [cUse('jack','a'),cUse('walvo','b'),cUse('other','c')], [cResult('c',true,'denied by permission rule')], [], 'ok','ok'],
  ['nested', [cUse('jack','a'),cUse('walvo','b')], [], [[cRow('assistant',[cUse('other','nested')])]], 'ok','violation'],
]) test(`J6 Claude ${label}`, async t => {
  const { config, j } = await logs(t, 'claude', [cRow('user',`【CO-AGENT 联合调用 ${joint().jointId}】\n原文`),cRow('assistant',content,'m1'),...resultRows], childRows);
  const status = await verifyJoint(j, config);
  assert.equal(status.parallel.state, parallel); assert.equal(status.whitelist.state, whitelist);
  if (label === 'parallel') assert.deepEqual(status.calls.map(c => c.state), ['done','done']);
  if (label === 'denied') assert.equal(status.whitelist.deniedAttempts.length, 1);
  if (label === 'violation') assert.ok(status.whitelist.violations.length);
});

test('J6 Claude streamed assistant rows with same message id count as one; error/running and timeout', async t => {
  const { config, j } = await logs(t,'claude',[cRow('user',`【CO-AGENT 联合调用 ${joint().jointId}】`),cRow('assistant',[cUse('jack','a')],'m'),cRow('assistant',[cUse('walvo','b')],'m'),cResult('a',true)]);
  let status = await verifyJoint(j,config); assert.equal(status.parallel.state,'ok'); assert.deepEqual(status.calls.map(c=>c.state),['failed','running']);
  status = await verifyJoint(j,config,{now: Date.parse(at)+900001}); assert.equal(status.overall,'unconfirmed');
});

for (const [label, tools, extra, expectedParallel, expectedWhitelist] of [
  ['parallel',[xTool('spawn_agent',{agent_type:'-jack'}),xTool('spawn_agent',{agent_type:'Walvo'}),xTool('wait_agent')],[], 'ok','ok'],
  ['early wait',[xTool('spawn_agent',{agent_type:'-jack'}),xTool('wait_agent'),xTool('spawn_agent',{agent_type:'Walvo'})],[], 'not-parallel','ok'],
  ['wrong role',[xTool('spawn_agent',{agent_type:'-jack'}),xTool('spawn_agent',{agent_type:'Walvo'}),xTool('wait_agent')],[[xMeta('evil',{parent_thread_id:'main',depth:1,agent_role:'Other'})]],'ok','violation'],
  ['depth2',[xTool('spawn_agent',{agent_type:'-jack'}),xTool('spawn_agent',{agent_type:'Walvo'}),xTool('wait_agent')],[[xMeta('nested',{parent_thread_id:'jackchild',depth:2,agent_role:'Walvo'})]],'ok','violation'],
]) test(`J6 Codex ${label}; arbitrary user marker; child terminal states`,async t=>{
  const children = [[xMeta('jackchild',{parent_thread_id:'main',depth:1,agent_role:'-jack'}),{type:'event_msg',payload:{type:'task_complete'}}],
    [xMeta('walkerchild',{parent_thread_id:'main',depth:1,agent_role:'Walvo'}),{type:'event_msg',payload:{type:'turn_aborted'}}],...extra];
  const { config,j }=await logs(t,'codex',[xMeta('main'),xUser('environment context'),xUser(`【CO-AGENT 联合调用 ${joint().jointId}】`),...tools],children);
  const status=await verifyJoint(j,config); assert.equal(status.parallel.state,expectedParallel); assert.equal(status.whitelist.state,expectedWhitelist);
  assert.deepEqual(status.calls.map(c=>c.state),['done','failed']); assert.match(status.taskTextNote,/任务文本.*加密的，无法核对；它调用了哪些 Agent 只能在运行后核对。$/); assert.doesNotMatch(status.taskTextNote,/白名单|事后核验/);
});

test('J6 unobserved logs, malformed data and mismatched cwd cannot be reported ok',async t=>{
  const { config,j,main }=await logs(t,'claude',[cRow('user','wrong marker'),cRow('assistant',[cUse('jack','a')])]);
  assert.equal((await verifyJoint(j,config)).parallel.state,'pending');
  await put(main,'{broken\n'); assert.ok((await verifyJoint(j,config)).evidenceError);
});

test('J6 cwd mismatch, pre-marker calls excluded, pending/running children, and no wait remain unconfirmed',async t=>{
  const {config,j,main}=await logs(t,'codex',[xMeta('main'),xUser(`【CO-AGENT 联合调用 ${joint().jointId}】`),xTool('spawn_agent',{agent_type:'-jack'}),xTool('spawn_agent',{agent_type:'Walvo'})],
    [[xMeta('child',{parent_thread_id:'main',depth:1,agent_role:'-jack'}),{type:'event_msg',payload:{type:'task_started'}}]]);
  let status=await verifyJoint(j,config,{now:Date.parse(at)+1000}); assert.equal(status.parallel.state,'pending'); assert.deepEqual(status.calls.map(c=>c.state),['running','pending']);
  config.launchProject='WRONG'; status=await verifyJoint(j,config,{now:Date.parse(at)+1000}); assert.equal(status.cwd.state,'mismatch'); assert.equal(status.overall,'failed');
  await jsonl(main,[xMeta('main'),xTool('spawn_agent',{agent_type:'Other'}),xUser(`【CO-AGENT 联合调用 ${joint().jointId}】`),xTool('spawn_agent',{agent_type:'-jack'}),xTool('spawn_agent',{agent_type:'Walvo'}),xTool('wait_agent')]);
  config.launchProject='PROJECT'; status=await verifyJoint(j,config,{now:Date.parse(at)+1000}); assert.equal(status.parallel.state,'ok');
});

test('J3 Claude non-json files in subagent directory disprove empty-directory audit',async t=>{
  const {config,j,main}=await logs(t,'claude',[cRow('user','input')]);
  await put(path.join(path.dirname(main),j.sessionId,'subagents','pending.tmp'),'pending');
  const audit=await auditRecommendation({engine:'claude',sessionId:j.sessionId},config); assert.equal(audit.ok,false); assert.equal(audit.children,1);
});

test('J7 running recommendation after restart fails explicitly without another spawn',async t=>{
  let app; t.after(()=>app?.close()); const {config}=await fixture(t), id=joint().jointId;
  await put(path.join(config.dataDir,'recommend',id,'record.json'),JSON.stringify({recommendId:id,status:'running',engine:'claude',input:'任务',createdAt:at,results:[]}));
  const calls=[]; app=await createApp(config,{spawnImpl:fakeSpawner(calls),recommendSpawnImpl:backgroundFake(()=>{},calls)});
  assert.equal((await app.workflows.recommendation(id)).status,'failed'); assert.equal(calls.length,0);
});

test('J3/J5/J7 HTTP authentication, validation, no substitutions, writable confirmation, restart and recent20',async t=>{
  let app; t.after(()=>app?.close());
  const {config}=await fixture(t); const calls=[];
  const members=[...agents, {...agent('-Ben','ben'),writable:true}];
  const registryBuilder=async()=>({agents:members,categories:[],sources:[],summary:{roles:3,books:0}});
  const recommendRunner=async record=>({...record,status:'done',results:members,rejected:[],audit:{agentCalls:0,children:0,ok:true}});
  const options={registryBuilder,recommendRunner,spawnImpl:fakeSpawner(calls)};
  app=await createApp(config,options); await app.listen();
  let base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async(url,body,auth=true)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Co-Agent-Token':app.token}:{})},body:JSON.stringify(body)});
  assert.equal((await post('/api/recommend',{input:'x',engine:'claude'},false)).status,403);
  for (const body of [{input:'',engine:'claude'},{input:'中'.repeat(8001),engine:'claude'},{input:'x',engine:'evil'}]) assert.equal((await post('/api/recommend',body)).status,400);
  const response=await post('/api/recommend',{input:'中'.repeat(8000),engine:'claude'}); assert.equal(response.status,200); const {recommendId}=await response.json();
  await app.workflows.idle();
  assert.equal((await (await fetch(`${base}/api/recommend/${recommendId}`)).json()).status,'done');
  assert.equal((await post('/api/joint',{recommendId,agentIds:['fake'],cli:'claude'})).status,400);
  assert.equal((await post('/api/joint',{recommendId,agentIds:[],cli:'claude'})).status,400);
  assert.equal((await post('/api/joint',{recommendId,agentIds:['jack','jack'],cli:'claude'})).status,400);
  assert.equal((await post('/api/joint',{recommendId,agentIds:['ben'],cli:'claude'})).status,409);
  assert.equal((await post('/api/joint',{recommendId,agentIds:['ben'],cli:'claude',writableConfirmed:'true'})).status,409);
  const recordFile=path.join(config.dataDir,'recommend',recommendId,'record.json');
  const stored=JSON.parse(await fs.readFile(recordFile,'utf8')); stored.input='中'.repeat(8001); await put(recordFile,JSON.stringify(stored));
  assert.equal((await post('/api/joint',{recommendId,agentIds:['ben'],cli:'codex',writableConfirmed:true})).status,400);
  stored.input='中'.repeat(8000); await put(recordFile,JSON.stringify(stored));
  members[0].platforms.claude={available:false,reason:'合成不可用'};
  const unavailable=await post('/api/joint',{recommendId,agentIds:['jack'],cli:'claude'}); assert.equal(unavailable.status,409); assert.equal((await unavailable.json()).unavailable[0].id,'jack'); assert.equal(calls.length,0);
  const launched=await post('/api/joint',{recommendId,agentIds:['ben'],cli:'codex',writableConfirmed:true}); assert.equal(launched.status,200); const {jointId}=await launched.json(); assert.equal(calls.length,1);
  assert.equal((await fetch(`${base}/api/joint/${jointId}`)).status,200);
  await app.close(); app=await createApp(config,options); await app.listen(); base=`http://127.0.0.1:${app.server.address().port}`;
  const recent=await (await fetch(base+'/api/recent')).json(); assert.ok(recent.items.some(i=>i.id===jointId)); assert.ok(recent.items.some(i=>i.id===recommendId));
  assert.equal((await (await fetch(`${base}/api/recommend/${recommendId}`)).json()).status,'done');
  for (let i=0;i<21;i++) { const r=await post('/api/recommend',{input:`任务${i}`,engine:'codex'}); assert.equal(r.status,200); }
  await app.workflows.idle(); assert.equal((await (await fetch(base+'/api/recent')).json()).items.length,20);
  await assert.rejects(fs.stat(path.join(config.dataDir,'launches')),{code:'ENOENT'});
});

// v0.24: structured synthesis, reviewer round and optional cross-examination (docs/plans/v0.24-执行细节书.md).
const book = (name, claudeName) => ({ ...agent(name, claudeName), kind: 'book', primary: '睡眠' });
const reviewer = (name, claudeName) => ({ ...agent(name, claudeName), reviewer: true });
const rulesOf = text => text.split('\n').filter(line => /^\d+\. /.test(line));
const instructionOf = (cli, agentsList, crossExam, config) => {
  const args = jointArgs(cli, { ...joint(cli), input: '几点睡最合适', crossExam }, agentsList, config, []);
  return cli === 'claude' ? args[args.indexOf('--append-system-prompt') + 1] : args.at(-1);
};

test('v024 prompts: reviewers wait for a review round, cross-examination is a required extra round, synthesis is structured', async t => {
  const { config } = await fixture(t); config.taskContracts = { octopus: ['-jason'] };
  const walvo = book('Walvo', 'walvo'), jadra = book('Jadra', 'jadra'), jason = reviewer('-jason', 'jason'), steven = reviewer('-steven', 'steven');
  assert.deepEqual(jointPlan([walvo, jason]).review, [jason]);
  assert.deepEqual(jointPlan([jason, steven]).review, [], 'reviewers alone answer the question themselves');

  const staged = instructionOf('claude', [walvo, jadra, jason], false, config), stagedRules = rulesOf(staged);
  assert.deepEqual(stagedRules.map(rule => Number(rule.split('.')[0])), [1, 2, 3, 4, 5, 6]);
  assert.match(stagedRules[0], /并行调用首轮 Agent：walvo,jadra（/); assert.match(stagedRules[0], /核查型 Agent jason 留到核查轮/);
  assert.match(stagedRules[1], /对于 jason ，任务文本必须严格采用/);
  assert.match(stagedRules[2], /^3\. 核查：首轮全部返回后，把主要论点整理成编号清单.*并行调用 jason，任务为核查这份清单/);
  assert.match(stagedRules[3], /^4\. 不得调用白名单以外的任何 Agent。$/);
  assert.match(stagedRules[4], /按 Agent 分段原样呈现各轮结果/);
  assert.match(staged, /- 核查结果：核查型 Agent 认为有误/); assert.doesNotMatch(staged, /交叉质询/);

  const cross = instructionOf('claude', [walvo, jadra], true, config), crossRules = rulesOf(cross);
  assert.match(crossRules[2], /^3\. 交叉质询（已勾选，必须执行，不得省略或合并到综合里）：首轮全部返回后，在同一条回复中再次并行调用 walvo,jadra，每个调用一次，必须是新的 Agent 调用/);
  assert.doesNotMatch(cross, /核查/); assert.match(cross, /各轮结果/);
  for (const item of ['共识', '分歧', '独有补充', '单一来源结论', '可执行建议']) assert.match(cross, new RegExp(`^- ${item}：`, 'm'));
  assert.match(cross, /标注「同源」，不算独立印证/); assert.match(cross, /不要把分歧抹平成折中结论/);

  const both = rulesOf(instructionOf('claude', [walvo, jadra, jason], true, config));
  assert.deepEqual(both.map(rule => rule.slice(3, 7)), ['收到首条', '首轮每个', '交叉质询', '核查：交', '不得调用', '全部返回', '之后等待']);

  const reviewersOnly = instructionOf('claude', [jason, steven], false, config);
  assert.match(reviewersOnly, /并行调用白名单内的全部 Agent/); assert.doesNotMatch(reviewersOnly, /核查轮|核查结果/);

  const codex = instructionOf('codex', [walvo, jadra, jason], true, config);
  assert.match(codex, /^1\. 立即为首轮的每一个 Agent：Walvo,Jadra 各派生一个子 Agent.*核查型 Agent -jason 留到核查轮，首轮不要派生。$/m);
  assert.match(codex, /^3\. 交叉质询.*再为 Walvo,Jadra 中的每一个各派生一个新的子 Agent（不复用首轮子 Agent）/m);
  assert.match(codex, /^4\. 核查：交叉质询全部完成后.*为 -jason 各派生一个子 Agent，任务为核查这份清单/m);
  assert.match(codex, /\n用户原文：\n几点睡最合适$/);
});

test('v024 createJoint records crossExam and marks staged reviewers; old records keep working', async t => {
  const { config } = await fixture(t), calls = [];
  const spec = await createJoint({ input: '问题', cli: 'claude', agents: [book('Walvo', 'walvo'), reviewer('-jason', 'jason')], crossExam: true }, config, { spawnImpl: fakeSpawner(calls) });
  assert.equal(spec.crossExam, true);
  assert.deepEqual(spec.whitelist.map(a => [a.codexName, a.stage]), [['Walvo', undefined], ['-jason', 'review']]);
  const plain = await createJoint({ input: '问题', cli: 'claude', agents: [book('Walvo', 'walvo')] }, config, { spawnImpl: fakeSpawner(calls) });
  assert.equal(plain.crossExam, false); assert.ok(!plain.whitelist.some(a => a.stage));
});

// Explicit whitelist: earlier tests in this file reshape the shared agents' Claude names.
const pair = () => [{ id: 'jack', codexName: '-jack', claudeName: 'jack' }, { id: 'walvo', codexName: 'Walvo', claudeName: 'walvo' }];
test('v024 Claude: staged reviewers are not required in the first message; cross-examination ok, pending, then failed', async t => {
  const marker = cRow('user', `【CO-AGENT 联合调用 ${joint().jointId}】\n原文`);
  let { config, j } = await logs(t, 'claude', [marker, cRow('assistant', [cUse('jack', 'a')], 'm1'), cResult('a'), cRow('assistant', [cUse('walvo', 'b')], 'm2'), cResult('b')]);
  j.whitelist = pair(); j.whitelist[1].stage = 'review';
  assert.equal((await verifyJoint(j, config)).parallel.state, 'ok');
  j.whitelist[1].stage = undefined;
  assert.equal((await verifyJoint(j, config)).parallel.state, 'not-parallel', 'without staging the old rule still applies');

  ({ config, j } = await logs(t, 'claude', [marker, cRow('assistant', [cUse('jack', 'a'), cUse('walvo', 'b')], 'm1'), cResult('a'), cResult('b'),
    cRow('assistant', [cUse('jack', 'c'), cUse('walvo', 'd')], 'm2'), cResult('c'), cResult('d')]));
  j.whitelist = pair(); j.crossExam = true;
  let status = await verifyJoint(j, config);
  assert.equal(status.crossExam.state, 'ok'); assert.deepEqual(status.crossExam.evidence, [{ agent: 'jack', calls: 2 }, { agent: 'walvo', calls: 2 }]);
  assert.equal(status.overall, 'done');

  ({ config, j } = await logs(t, 'claude', [marker, cRow('assistant', [cUse('jack', 'a'), cUse('walvo', 'b')], 'm1'), cResult('a'), cResult('b')]));
  j.whitelist = pair(); j.crossExam = true;
  status = await verifyJoint(j, config, { now: Date.parse(at) + 1000 });
  assert.equal(status.crossExam.state, 'pending'); assert.equal(status.overall, 'pending', 'first round done is not the end when cross-examination was requested');
  status = await verifyJoint(j, config, { isAlive: () => false });
  assert.equal(status.crossExam.state, 'failed'); assert.equal(status.overall, 'failed'); assert.match(status.message, /已勾选交叉质询/);
  delete j.crossExam;
  assert.equal((await verifyJoint(j, config)).crossExam, undefined, 'records without the field are verified as before');
});

test('v024 Codex: staged reviewers may spawn after the first wait; cross-examination needs a second spawn of each first-round member', async t => {
  const children = [[xMeta('jackchild', { parent_thread_id: 'main', depth: 1, agent_role: '-jack' }), { type: 'event_msg', payload: { type: 'task_complete' } }],
    [xMeta('walkerchild', { parent_thread_id: 'main', depth: 1, agent_role: 'Walvo' }), { type: 'event_msg', payload: { type: 'task_complete' } }]];
  const head = [xMeta('main'), xUser(`【CO-AGENT 联合调用 ${joint().jointId}】`)];
  let { config, j } = await logs(t, 'codex', [...head, xTool('spawn_agent', { agent_type: '-jack' }), xTool('wait_agent'), xTool('spawn_agent', { agent_type: 'Walvo' })], children);
  j.whitelist[1].stage = 'review';
  assert.equal((await verifyJoint(j, config)).parallel.state, 'ok');
  ({ config, j } = await logs(t, 'codex', [...head, xTool('spawn_agent', { agent_type: '-jack' }), xTool('spawn_agent', { agent_type: 'Walvo' }), xTool('wait_agent'),
    xTool('spawn_agent', { agent_type: '-jack' }), xTool('spawn_agent', { agent_type: 'Walvo' }), xTool('wait_agent')], children));
  j.crossExam = true;
  let status = await verifyJoint(j, config);
  assert.equal(status.parallel.state, 'ok'); assert.equal(status.crossExam.state, 'ok');
  ({ config, j } = await logs(t, 'codex', [...head, xTool('spawn_agent', { agent_type: '-jack' }), xTool('spawn_agent', { agent_type: 'Walvo' }), xTool('wait_agent'),
    xTool('spawn_agent', { agent_type: '-jack' })], children));
  j.crossExam = true;
  status = await verifyJoint(j, config);
  assert.equal(status.crossExam.state, 'pending'); assert.deepEqual(status.crossExam.evidence.map(e => e.calls), [2, 1]);
});
