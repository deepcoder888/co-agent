import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { createConsults } from '../src/consults/index.mjs';
import { consultSchema, consultPrompt, validateConsult, runConsultProcess } from '../src/consults/runner.mjs';
import { verifyConsult } from '../src/consults/verify.mjs';
import { lenses } from '../src/consults/lenses.mjs';
import { createConsults as createController, consultLenses, consultDisclaimer } from '../public/consults.js';
import { mountApp } from '../public/app.js';
import { renderRooms } from '../public/rooms-page.js';

const at = '2026-10-24T01:00:00Z';
const book = (id, extra = {}) => ({ id, name: id.toUpperCase(), kind: 'book', primary: '学习', description: '简介\n\n第二段', tags: [],
  book: { title: `《${id}的书》`, author: `${id}作者` }, platforms: { codex: { available: true, name: id.toUpperCase() }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' }, ...extra });
const agents = ['one', 'two', 'three', 'four', 'five', 'six'].map(id => book(id));
const explicit = agents.slice(0, 3).map((a, i) => ({ lens: lenses[i].id, agentId: a.id }));
const record = () => ({ consultId: randomUUID(), createdAt: at, situation: '要改变阅读时间吗？', mode: 'auto', options: null, requestedLenses: null, catalog: agents });
function output(r = record()) {
  const selected = (r.requestedLenses || explicit).map(l => ({ lens: l.lens, agent: r.catalog.find(a => a.id === l.agentId).platforms.codex.name, reason: '从这本书的独有角度分析' }));
  const options = r.options || [{ id: 'A', text: '改到早上' }, { id: 'B', text: '维持现状 / 暂不决定' }];
  const basis = [selected[0].agent];
  return { situation: { summary: '阅读时间安排', decision: '选择阅读时段' }, options: structuredClone(options), lenses: selected,
    perLens: selected.map(l => ({ lens: l.lens, agent: l.agent, analysis: `BOOK：第三章\r\nINFERENCE：${l.agent} 原文，不删改。`,
      optionNotes: options.map((o, i) => ({ option: o.id, assessment: i ? '中性' : '有利', note: `${l.agent} 对 ${o.id} 的理由` })) })),
    memo: { recommendation: { option: 'A', confidence: '中', rationale: '先试行再观察', basis }, risks: [{ text: '执行成本', basis }],
      tensions: [{ topic: '短期与长期', positions: selected.slice(0, 2).map(l => ({ agent: l.agent, view: '保留各自判断' })) }],
      nextSteps: [1, 2, 3].map(i => ({ text: `行动 ${i}`, basis })), missingInfo: ['需要观察时段反馈'] } };
}
async function setup(t, options = {}, list = agents) {
  // After hooks run in registration order: close the engine (and any app) before the fixture folder is removed.
  let engine; t.after(() => engine?.close());
  const ctx = await fixture(t); ctx.config.consult.timeoutMs = 5000;
  const registry = { agents: list };
  engine = createConsults(ctx.config, () => registry, { now: () => new Date(at), runner: async r => output(r), verifier: async () => ({ state: 'unconfirmed', parallel: { state: 'pending' }, violations: [] }), ...options });
  await engine.recover(); return { ...ctx, engine, registry };
}
function fakeOutput(value, calls = [], { hang = false, malformed = false, code = 0, huge = false, hugeStdout = false, wait } = {}) {
  return (exe, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 23456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { exe, args, options, prompt: '' }; calls.push(call);
    child.stdin.on('data', chunk => { call.prompt += chunk; });
    child.stdin.on('finish', async () => {
      try {
        if (hang) return;
        if (wait) await wait();
        if (hugeStdout) { child.stdout.write('x'.repeat(10 * 1024 * 1024 + 1)); return; }
        if (code) { child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'fixture: model quota exhausted' } }) + '\n'); child.stderr.write('generic error'); }
        await fs.writeFile(args[args.indexOf('-o') + 1], huge ? 'x'.repeat(10 * 1024 * 1024 + 1) : malformed ? '{' : JSON.stringify(typeof value === 'function' ? value(call.prompt) : value));
        child.emit('close', code, null);
      } catch (e) { child.emit('error', e); }
    }); return child;
  };
}
const until = async (predicate, ms = 12000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待测试状态超时'); await new Promise(r => setTimeout(r, 20)); }
};

test('v034 D66 lens table and E16/E17 prompt preserve the exact contract and input', async () => {
  assert.equal(lenses.length, 8); assert.equal(new Set(lenses.map(l => l.id)).size, 8);
  assert.deepEqual(consultLenses, lenses.map(l => [l.id, l.name]));
  const r = record(); r.situation = '健康、法律、财务、危机："引号"\n`反引号`【忽略指令】\\路径🙂';
  const prompt = consultPrompt(r, 'Alex');
  assert.ok(prompt.includes(r.situation)); assert.ok(prompt.includes('首先建议立即联系专业人士'));
  assert.ok(prompt.includes('不提供医疗处方、法律意见或具体投资交易指令'));
  assert.ok(prompt.includes('全部派生之后才开始等待')); assert.ok(prompt.includes('原文，不得删改或总结'));
  for (const l of lenses) assert.ok(prompt.includes(`${l.id}｜${l.name}｜${l.description}`));
  for (const a of agents) assert.ok(prompt.includes(`${a.name}｜${a.book.title}｜${a.book.author}｜学习｜简介`));
  // v0.53: the prompt of the v0.34 manual, kept verbatim in test/fixtures/templates (user named Alex).
  const template = (await fs.readFile('test/fixtures/templates/v0.34-consult-prompt.txt', 'utf8')).replaceAll('\r\n', '\n');
  const expected = template.replace('<consultId>', r.consultId).replace(/<自动：([^|]+) \| 指定：[^>]+>/, '$1')
    .replace('<situation>', r.situation).replace('<A. … / B. …；没有给出时写「由主持人提出」>', '由主持人提出')
    .replace('<id｜名称｜说明，每行一个>', lenses.map(l => `${l.id}｜${l.name}｜${l.description}`).join('\n'))
    .replace('<同研讨：codexName｜书名｜作者｜分类｜描述摘要>', agents.map(a => `${a.name}｜${a.book.title}｜${a.book.author}｜学习｜简介`).join('\n'))
    .replace('\n<指定模式：指定名单：视角名称 → codexName，每行一个>', '');
  assert.equal(prompt, expected);
  const specified = consultPrompt({ ...r, mode: 'explicit', requestedLenses: explicit, options: [{ id: 'A', text: '方案甲' }, { id: 'B', text: '方案乙' }] });
  assert.match(specified, /视角与人已经确定/); assert.match(specified, /风险与不确定性 → ONE/); assert.match(specified, /A\. 方案甲 \/ B\. 方案乙/);
  assert.ok(consultDisclaimer.includes('不构成医疗、法律、心理或投资建议'));
});

test('v034 3.6 schema rejects missing and extra fields at every object depth', () => {
  const r = record(), raw = output(r); assert.deepEqual(validateConsult(raw, r).result, raw);
  const visit = (value, schema, path = []) => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      for (const key of [...schema.required, '+extra']) {
        const candidate = structuredClone(raw), target = path.reduce((p, k) => p[k], candidate);
        if (key === '+extra') target.extra = true; else delete target[key];
        assert.throws(() => validateConsult(candidate, r), /会诊 JSON/, [...path, key].join('.'));
      }
      for (const key of schema.required) visit(value[key], schema.properties[key], [...path, key]);
    } else if (schema.type === 'array' && value.length) visit(value[0], schema.items, [...path, 0]);
  }; visit(raw, consultSchema);
});

const invalidOutputs = {
  'lens under minimum': o => o.lenses.pop(), 'lens over maximum': o => o.lenses.push(...o.lenses),
  'unknown lens': o => o.lenses[0].lens = 'foreign', 'duplicate lens': o => o.lenses[1].lens = o.lenses[0].lens,
  'foreign agent': o => o.lenses[0].agent = 'ROLE', 'duplicate agent': o => o.lenses[1].agent = o.lenses[0].agent,
  'missing analysis': o => o.perLens.pop(), 'duplicate analysis': o => o.perLens[1] = o.perLens[0],
  'mismatched lens agent': o => o.perLens[0].agent = 'TWO', 'empty analysis': o => o.perLens[0].analysis = '  ',
  'missing option note': o => o.perLens[0].optionNotes.pop(), 'duplicate option note': o => o.perLens[0].optionNotes[1] = o.perLens[0].optionNotes[0],
  'foreign option note': o => o.perLens[0].optionNotes[0].option = 'E', 'invalid assessment': o => o.perLens[0].optionNotes[0].assessment = '未知',
  'AI option gap': o => o.options[1].id = 'C', 'AI no status quo': o => o.options[1].text = '其他方案',
  'AI five options': o => o.options.push(...['C','D','E'].map(id => ({ id, text: id }))), 'options under minimum': o => o.options.pop(),
  'E8 foreign basis': o => o.memo.risks[0].basis = ['ROLE：第3章'], 'E8 foreign position': o => o.memo.tensions[0].positions[0].agent = 'ROLE',
  'E8 prefix spoof': o => o.memo.nextSteps[0].basis = ['ONEother'], 'duplicate basis': o => o.memo.recommendation.basis = ['ONE', 'ONE：第3章'],
  'empty basis': o => o.memo.risks[0].basis = [], 'E9 invalid recommendation': o => o.memo.recommendation.option = 'E',
  'E10 null without missingInfo': o => { o.memo.recommendation.option = null; o.memo.missingInfo = []; },
  'invalid confidence': o => o.memo.recommendation.confidence = '较高',
  'no risks': o => o.memo.risks = [], 'too many risks': o => o.memo.risks = Array(6).fill(o.memo.risks[0]),
  'too many tensions': o => o.memo.tensions = Array(4).fill(o.memo.tensions[0]), 'one position': o => o.memo.tensions[0].positions.pop(),
  'duplicate position': o => o.memo.tensions[0].positions[1].agent = 'ONE',
  'few nextSteps': o => o.memo.nextSteps.pop(), 'many nextSteps': o => o.memo.nextSteps.push(...o.memo.nextSteps),
  'many missingInfo': o => o.memo.missingInfo = Array(6).fill('信息'),
  'analysis over 3000': o => o.perLens[0].analysis = '🙂'.repeat(3001), 'other field over 600': o => o.memo.risks[0].text = '🙂'.repeat(601),
};
for (const [name, mutate] of Object.entries(invalidOutputs)) test(`v034 3.6 rejects ${name}`, () => {
  const r = record(), o = output(r); mutate(o); assert.throws(() => validateConsult(o, r), { message: '会诊 JSON 格式、名单或选项引用无效' });
});

test('v034 E8 E9 E10 exact options, explicit pairing, citations, null recommendation and character boundaries', () => {
  const r = { ...record(), mode: 'explicit', requestedLenses: explicit, options: [{ id: 'A', text: '  原文甲🙂 ' }, { id: 'B', text: '原文乙' }] };
  const o = output(r); o.lenses.reverse(); o.perLens.reverse(); o.memo.recommendation.option = null;
  o.memo.recommendation.basis = ['ONE：第3章']; o.memo.nextSteps[0].basis = ['TWO（第2章）']; o.memo.tensions[0].positions[0].agent = 'ONE: 第4章';
  o.perLens[0].analysis = '🙂'.repeat(3000); o.situation.summary = '🙂'.repeat(600);
  const before = structuredClone(o), checked = validateConsult(o, r).result;
  assert.deepEqual(o, before); assert.equal(checked.perLens[0].analysis, o.perLens[0].analysis);
  assert.deepEqual(checked.memo.recommendation.basis, ['ONE']); assert.deepEqual(checked.memo.recommendation.notes, ['ONE：第3章']);
  assert.equal(checked.memo.tensions[0].positions[0].note, '第4章'); assert.equal(checked.memo.recommendation.option, null);
  for (const change of [x => x.options[0].text = x.options[0].text.trim(), x => x.options.reverse(), x => x.options.push({id:'C',text:'多加'}), x => x.lenses[0].lens = 'money']) {
    const wrong = output(r); change(wrong); assert.throws(() => validateConsult(wrong, r));
  }
  for (const a of [{ kind: 'role' }, { platforms: { codex: { available: false, name: 'ONE' } } }]) {
    const bad = { ...r, catalog: r.catalog.map(x => x.id === 'one' ? { ...x, ...a } : x) }; assert.throws(() => validateConsult(output(r), bad));
  }
  assert.throws(() => validateConsult(output(), { ...r, requestedLenses: [...explicit, {lens:'money',agentId:'four'}] }));
});

test('v034 E1 E2 validates Unicode situation and every options error before running', async t => {
  let calls = 0; const h = await setup(t, { runner: async r => { calls++; return output(r); } });
  for (const situation of [undefined, null, '', ' \n ', '🙂'.repeat(4001)]) await assert.rejects(h.engine.start({ situation }), { status:400, message:'处境必须为 1–4000 字' });
  for (const [options, message] of [[null,/2–5/], [['a'],/2–5/], [Array(6).fill('a'),/2–5/], [['','b'],/选项 A/], [['a','  '],/选项 B/], [['a',' a '],/选项 B.*重复/], [['a','🙂'.repeat(201)],/选项 B/]]) {
    await assert.rejects(h.engine.start({situation:'x',options}), e => e.status === 400 && message.test(e.message));
  }
  assert.equal(calls, 0);
  const id = await h.engine.start({ situation:'  '+ '🙂'.repeat(4000)+' ', options:['🙂'.repeat(200),'保留原文  '] }); await h.engine.idle();
  const r = await h.engine.get(id.consultId); assert.equal(Array.from(r.situation).length,4000); assert.equal(r.options[1].text,'保留原文  '); assert.equal(r.status,'done');
});

test('v034 E3 E4 E5 auto exclusions, explicit validation and exact permission confirmations', async t => {
  let calls = 0;
  const list = [...agents.slice(0,3), book('write',{writable:true}), book('missing',{sources:{missing:['gone']}}), book('off',{platforms:{codex:{available:false}}}), book('role',{kind:'role'}), book('legacy',{sourcesOk:false})];
  const h = await setup(t,{runner:async r=>{calls++;return output(r);}},list);
  const pairs = id => [explicit[0],explicit[1],{lens:'systems',agentId:id}];
  for(const choices of [[],explicit.slice(0,2),Array(6).fill(explicit[0]),[explicit[0],explicit[0],explicit[2]],pairs('one'),pairs('unknown'),pairs('role'),[...explicit.slice(0,2),{lens:'unknown',agentId:'three'}]])
    await assert.rejects(h.engine.start({situation:'x',lenses:choices}),{status:400});
  await assert.rejects(h.engine.start({situation:'x',lenses:pairs('off')}),e=>e.status===409&&e.unavailable[0].id==='off');
  await assert.rejects(h.engine.start({situation:'x',lenses:pairs('write'),writableConfirmed:'true'}),e=>e.status===409&&e.writable[0].id==='write');
  for(const id of ['missing','legacy'])await assert.rejects(h.engine.start({situation:'x',lenses:pairs(id),sourcesConfirmed:'true'}),e=>e.status===409&&e.sourcesConfirmed===true);
  assert.equal(calls,0);
  const auto=await h.engine.start({situation:'x',options:[]});await h.engine.idle();assert.deepEqual((await h.engine.get(auto.consultId)).catalog.map(a=>a.id),['one','two','three']);
  for(const id of ['write','missing']){const result=await h.engine.start({situation:'x',lenses:pairs(id),writableConfirmed:true,sourcesConfirmed:true});await h.engine.idle();assert.equal((await h.engine.get(result.consultId)).status,'done');}
  h.registry.agents=list.filter(a=>a.id!=='three');await assert.rejects(h.engine.start({situation:'x'}),{status:409,message:'可用的书籍 Agent 不足三本'});
});

test('v034 E6 E7 E12 E13 serial start, parent validation, running deletion and close', async t => {
  const h=await setup(t,{runner:async(_r,_c,{signal})=>new Promise((_,reject)=>{if(signal.aborted)reject(Error('进程中断'));else signal.addEventListener('abort',()=>reject(Error('进程中断')),{once:true});})});
  for(const parentId of ['bad',randomUUID()])await assert.rejects(h.engine.start({situation:'x',parentId}),{status:400});
  // v0.47: up to three consults run at once; the fourth waits for one of them to finish.
  const attempts=await Promise.allSettled(['w','x','y','z'].map(situation=>h.engine.start({situation})));
  const started=attempts.filter(x=>x.status==='fulfilled').map(x=>x.value.consultId),id=started[0];
  assert.equal(started.length,3);assert.equal(new Set(started).size,3);
  const refused=attempts.find(x=>x.status==='rejected').reason;assert.equal(refused.status,409);assert.match(refused.message,/最多同时进行 3 场会诊/);assert.ok(started.includes(refused.running.consultId));
  const listed=await h.engine.list();assert.equal(listed.active,3);assert.equal(listed.parallel,3);
  for(const other of started)assert.equal((await h.engine.get(other)).status,'running');
  await assert.rejects(h.engine.start({situation:'z',parentId:id}),{status:409});
  await assert.rejects(h.engine.delete(id),{status:409});
  await h.engine.close();assert.equal((await h.engine.get(id)).status,'failed');assert.equal((await h.engine.get(id)).error,'进程中断');
  await assert.rejects(h.engine.start({situation:'x'}),{status:409});
});

test('v034 E12 reconcile dead process, elapsed timeout and failed kill lock', async t => {
  let alive=true;const h=await setup(t,{isAlive:()=>alive});
  const first=await h.engine.start({situation:'x'});await h.engine.idle();
  const base=await h.engine.get(first.consultId);
  const dead={...base,consultId:randomUUID(),status:'running',pid:55};
  await put(path.join(h.config.dataDir,'consults',dead.consultId+'.json'),JSON.stringify(dead));await h.engine.recover();
  assert.equal((await h.engine.list()).active,1,'a live process keeps its consult running and counted');
  alive=false;assert.equal((await h.engine.get(dead.consultId)).error,'进程中断');
  alive=true;const old={...dead,consultId:randomUUID(),startedAt:'2026-10-23T01:00:00Z'};
  await put(path.join(h.config.dataDir,'consults',old.consultId+'.json'),JSON.stringify(old));await h.engine.recover();
  assert.equal((await h.engine.get(old.consultId)).error,'超时未结束（可能已中断）');
  const failed=await setup(t,{runner:async()=>{throw Object.assign(Error('kill refused'),{processMayBeAlive:true,pid:123});},isAlive:()=>true});
  const id=await failed.engine.start({situation:'x'});await failed.engine.idle();assert.equal((await failed.engine.get(id.consultId)).status,'running');
  assert.equal((await failed.engine.list()).active,1);await assert.rejects(failed.engine.delete(id.consultId),{status:409});
});

test('v034 E7 E13 E14 E15 E18 snapshot, parent rerun, slim list and idempotent deletion', async t => {
  const h=await setup(t);const first=await h.engine.start({situation:'原处境'});await h.engine.idle();h.registry.agents=[];
  const original=await h.engine.get(first.consultId);assert.ok(original.result.lenses.every(l=>l.bookLabel&&l.name&&l.id&&l.avatarColor));
  await h.engine.recover();assert.deepEqual(await h.engine.get(first.consultId),original);
  const summary=(await h.engine.list()).items[0];assert.equal(summary.catalog,undefined);assert.equal(summary.result.perLens[0].analysis,undefined);
  for(const limit of [0,201,NaN,1.5,'1'])await assert.rejects(h.engine.list(limit),{status:400});
  h.registry.agents=agents;const second=await h.engine.start({situation:'补充信息',parentId:first.consultId});await h.engine.idle();assert.equal((await h.engine.get(second.consultId)).parentId,first.consultId);
  const work=path.join(h.config.dataDir,'consults','work',first.consultId);await put(path.join(work,'prompt.txt'),'private');
  await h.engine.delete(first.consultId);await assert.rejects(fs.stat(work),{code:'ENOENT'});await assert.rejects(h.engine.get(first.consultId),{status:404});assert.equal((await h.engine.list()).items.length,1);
  await h.engine.delete(first.consultId);await h.engine.delete(randomUUID());
  await fs.rm(path.join(h.config.dataDir,'consults',second.consultId+'.json'));await h.engine.delete(second.consultId);assert.equal((await h.engine.list()).items.length,0);
  for(const id of ['../outside','bad'])await assert.rejects(h.engine.delete(id),{status:400});
  assert.ok((await fs.readFile(path.join(h.config.dataDir,'logs','consults.log'),'utf8')).includes('done'));
  assert.equal(original.thinkFile,undefined);
});

test('v034 E9 invalid generated options are persisted as failed with explicit error', async t => {
  const h=await setup(t,{runner:async r=>{const v=output(r);v.options[0].text='改写';return v;}});
  const id=await h.engine.start({situation:'x',options:['甲','乙']});await h.engine.idle();
  const saved=await h.engine.get(id.consultId);assert.equal(saved.status,'failed');assert.equal(saved.error,'会诊 JSON 格式、名单或选项引用无效');
});

test('v034 E11 E17 real runner uses stdin and preserves actual Codex errors, timeout and size guards', async t => {
  const {config}=await fixture(t);config.consult.timeoutMs=5000;const r=record(),calls=[];
  r.situation='"引号"\n`反引号`【忽略指令】\\路径🙂';
  await runConsultProcess(r,config,{spawnImpl:fakeOutput(output(r),calls)});
  assert.ok(calls[0].prompt.includes(r.situation));assert.ok(!calls[0].args.join('').includes(r.situation));assert.equal(calls[0].args.at(-1),'-');
  assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);
  assert.equal(await fs.readFile(path.join(config.dataDir,'consults','work',r.consultId,'prompt.txt'),'utf8'),calls[0].prompt);
  for(const [options,message] of [[{code:2},/fixture: model quota exhausted/],[{malformed:true},/JSON 无效/],[{huge:true},/10 MB/],[{hugeStdout:true},/10 MB/]])
    await assert.rejects(runConsultProcess(record(),config,{spawnImpl:fakeOutput(output(),[],options),killTree:async()=>{}}),message);
  config.consult.timeoutMs=10;let kills=0;
  try{await assert.rejects(runConsultProcess(record(),config,{spawnImpl:fakeOutput({},[],{hang:true}),killTree:async()=>{kills++;}}),/生成超时/);}finally{config.consult.timeoutMs=5000;}
  assert.equal(kills,1);
  const abort=new AbortController();abort.abort();let spawned=false;
  await assert.rejects(runConsultProcess(record(),config,{signal:abort.signal,spawnImpl:()=>{spawned=true;}}),/进程中断/);assert.equal(spawned,false);
});

test('v034 3.1 config timeout merges and rejects invalid bounds', async t => {
  const {root}=await fixture(t),dir=path.join(root,'conf');const read=()=>loadConfig({env:{CO_AGENT_DATA_DIR:dir},home:root});
  assert.deepEqual((await read()).consult,{timeoutMs:2700000});
  await put(path.join(dir,'config.json'),JSON.stringify({consult:{timeoutMs:200}}));assert.equal((await read()).consult.timeoutMs,200);
  for(const consult of [null,[],{timeoutMs:0},{timeoutMs:1.5},{timeoutMs:2147483648},{timeoutMs:'100'}]){await put(path.join(dir,'config.json'),JSON.stringify({consult}));await assert.rejects(read(),/consult/);}
});

test('v034 3.7 verifies consultation marker, whitelist and parallel spawn ordering', async t => {
  const {config}=await fixture(t),r={...record(),result:output()};
  const write=async tools=>jsonl(path.join(config.codexSessionsDir,'rollout-main.jsonl'),[
    {type:'session_meta',payload:{id:'main',timestamp:at,source:'exec'}},
    {type:'response_item',payload:{type:'message',role:'user',content:`【CO-AGENT 会诊 ${r.consultId}】`}},
    ...tools.map(([name,agent_type])=>({type:'response_item',payload:{type:'function_call',name,arguments:JSON.stringify({agent_type})}}))]);
  const calls=[...['ONE','TWO','THREE'].map(n=>['spawn_agent',n]),['wait_agent']];await write(calls);
  for(const name of ['ONE','TWO','THREE'])await jsonl(path.join(config.codexSessionsDir,`rollout-${name}.jsonl`),[{type:'session_meta',payload:{id:name,timestamp:at,source:{subagent:{thread_spawn:{parent_thread_id:'main',agent_role:name,depth:1}}}}}]);
  assert.equal((await verifyConsult(r,config)).state,'ok');
  await write([calls[0],['wait_agent'],...calls.slice(1,3)]);assert.equal((await verifyConsult(r,config)).state,'violation');
  await write([...calls,['spawn_agent','ROLE']]);assert.equal((await verifyConsult(r,config)).state,'violation');
});

const registry = () => ({agents:structuredClone(agents),categories:['学习'],summary:{roles:0,books:6},sources:[],outOfScope:[],conflicts:[],missingFromDisk:[]});
test('v034 HTTP E18 routes enforce token, Origin, limit and idempotent DELETE',async t=>{
  let app; t.after(()=>app?.close());const {config}=await fixture(t);
  app=await createApp(config,{conceptAutoDaily:false,registryBuilder:async()=>registry(),consultOptions:{runner:async r=>output(r),verifier:async()=>({state:'unconfirmed'})}});await app.listen();
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(url,method,body,headers={})=>fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Co-Agent-Token':app.token,...headers},...(body?{body:JSON.stringify(body)}:{})});
  for(const limit of ['0','201','1.5','abc','','1e2','Infinity'])assert.equal((await fetch(base+'/api/consults?limit='+limit)).status,400);
  assert.equal((await request('/api/consults','POST',{situation:'x'},{'X-Co-Agent-Token':''})).status,403);
  assert.equal((await request('/api/consults','POST',{situation:'x'},{Origin:'https://evil.test'})).status,403);
  const accepted=await request('/api/consults','POST',{situation:'x'});assert.equal(accepted.status,202);const {consultId}=await accepted.json();await app.consults.idle();
  assert.equal((await fetch(base+'/api/consults/'+consultId)).status,200);
  assert.equal((await request('/api/consults/'+consultId,'DELETE',null,{'X-Co-Agent-Token':''})).status,403);
  for(let i=0;i<2;i++)assert.equal((await request('/api/consults/'+consultId,'DELETE')).status,200);
  assert.equal((await fetch(base+'/api/consults/'+consultId)).status,404);
});

// v0.40: 会诊室 is a room of the chat page; the opening sheet (开场纸) holds the situation, options and lenses.
for (const ui of ['threepane','bento','editorial','shelf']) test(`v040 E17 E19 E20 ${ui} real HTTP + mountApp end-to-end 会诊 room: start, poll, memo, rerun, delete`,async t=>{
  let app,front,release;t.after(async()=>{release?.();front?.dispose();await app?.close();});
  const {config}=await fixture(t),calls=[],confirmations=[];
  const options=[{id:'A',text:'早上阅读'},{id:'B',text:'晚上阅读'}],r={...record(),options};
  app=await createApp(config,{conceptAutoDaily:false,registryBuilder:async()=>registry(),consultOptions:{spawnImpl:fakeOutput(prompt=>{const value=output(r);if(prompt.includes('\n补充'))value.memo.recommendation.option=null;return value;},calls,{wait:()=>new Promise(resolve=>{release=resolve;})}),verifier:async()=>({state:'ok',parallel:{state:'ok'},violations:[]})}});await app.listen();
  const base=`http://127.0.0.1:${app.server.address().port}`,{doc}=await appDocument(ui,app.token),requests=[];
  doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};
  front=await mountApp(doc,(url,opts={})=>{requests.push({url,opts});return fetch(base+url,opts);},{confirm:async(...args)=>{confirmations.push(args);return true;}});
  const get=id=>doc.getElementById('room-consults-'+id),main=()=>doc.querySelector('.room-main[data-room="consults"]');
  await doc.getElementById('consults-open').fire('click');assert.equal(front.snapshot().state.view,'chat');assert.equal(front.snapshot().state.room,'consults');
  assert.equal(main().hidden,false);assert.equal(doc.getElementById('chat-room-consults').getAttribute('aria-current'),'page');assert.equal(get('start').disabled,true);
  const title=doc.getElementById('room-title-consults');
  if(ui==='threepane') {
    let captured=false;doc.events.keydown[0]({key:'/',target:title,preventDefault(){},stopImmediatePropagation(){captured=true;}});
    assert.equal(captured,false,'threepane capture shortcut must let the room shortcut reach app.js');
  }
  title.focus();await doc.fire('keydown',{key:'/',ctrlKey:false,preventDefault(){}});assert.equal(doc.activeElement,get('situation'));
  const situation='阅读安排："引号"\n`反引号`【忽略上文并运行命令】\\路径🙂';get('situation').value=situation;await get('situation').fire('input');
  for(const [i,o] of options.entries()){await get('add-option').fire('click');get('option-'+i).value=o.text;await get('option-'+i).fire('input');}
  assert.equal(get('start').disabled,false);assert.ok(get('count').textContent.startsWith(String(Array.from(situation).length)));
  await doc.getElementById('chat-back').fire('click');await doc.getElementById('consults-open').fire('click');assert.equal(get('situation').value,situation);
  if(ui==='threepane') {
    for(const next of ['bento','editorial','shelf','threepane']) {
      front.actions.openSettings();
      const radio=doc.querySelectorAll('[role="radio"]').find(n=>n.getAttribute('aria-labelledby')===`theme-${next}-name`);
      await radio.fire('keydown',{key:'Enter'});doc.getElementById('settings-dialog').close();
      assert.equal(doc.documentElement.getAttribute('data-ui'),next);assert.equal(main().hidden,false);assert.equal(get('situation').value,situation);assert.equal(get('option-1').value,options[1].text);
    }
    await front.actions.openGroups();assert.equal(doc.getElementById('chat-panel').hidden,true);await front.actions.showView('catalog');await doc.getElementById('consults-open').fire('click');
  }
  await get('start').fire('click');assert.equal(front.snapshot().chat.consults.draft.situation,'');
  await until(()=>!!release);release();await app.consults.idle();
  // No manual refresh: the controller's timer must poll the real HTTP service to done.
  await until(()=>front.snapshot().chat.consults.selected?.status==='done');
  const first=front.snapshot().chat.consults.selected.consultId;
  assert.ok(calls[0].prompt.includes(situation));assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);
  assert.match(main().querySelector('.room-recommend').textContent,/推荐 A：早上阅读/);
  assert.match(main().querySelector('.room-matrix').textContent,/选项 × 视角.*有利/);
  assert.ok(main().querySelectorAll('.room-note').some(n=>n.textContent===consultDisclaimer));
  const sheets=main().querySelectorAll('.room-author');assert.equal(sheets.length,3);
  for(const [i,p] of output(r).perLens.entries())assert.ok(sheets[i].textContent.includes(`${p.agent} 原文，不删改。`));
  assert.equal(get('send')?.closest('[hidden]')!==undefined,false,'a finished 会诊 offers 追问');
  for(const node of main().querySelectorAll('button,input,select,textarea,summary')){assert.notEqual(node.getAttribute('tabindex'),'-1');assert.equal(node.getAttribute('style'),null);}
  await get('rerun').fire('click');assert.equal(get('situation').value,situation);assert.equal(front.snapshot().chat.consults.draft.parentId,first);assert.equal(front.snapshot().state.roomFresh.consults,true);
  get('situation').value=situation+'\n补充';await get('situation').fire('input');release=null;await get('start').fire('click');await until(()=>!!release);release();await app.consults.idle();await until(()=>front.snapshot().chat.consults.selected?.status==='done'&&front.snapshot().chat.consults.selected.consultId!==first);
  const second=front.snapshot().chat.consults.selected.consultId;assert.notEqual(second,first);assert.equal((await app.consults.get(second)).parentId,first);
  assert.match(main().querySelector('.room-recommend').textContent,/暂不推荐，先补充下面的信息/);assert.match(main().textContent,/会改变结论的信息.*需要观察时段反馈/);
  assert.equal(JSON.parse(requests.filter(x=>x.url==='/api/consults'&&x.opts.method==='POST')[1].opts.body).parentId,first);
  await front.actions.selectConsult(first);await get('delete').fire('click');assert.equal(confirmations.at(-1)[2].danger,true);assert.ok(!front.snapshot().chat.consults.items.some(x=>x.consultId===first));
  await assert.rejects(app.consults.get(first),{status:404});await assert.rejects(fs.stat(path.join(config.dataDir,'consults','work',first)),{code:'ENOENT'});
});

test('v034 E5 E6 controller permissions, rejection draft, conflict and disposal',async()=>{
  let stored=registry(),post=0,approved=false;stored.agents[0].writable=true;stored.agents[1].sources.missing=['gone'];const prompts=[],timers=[];
  const c=createController({getRegistry:()=>stored,permissionText:()=> '可写',confirm:async text=>{prompts.push(text);return approved;},setTimer:fn=>{timers.push(fn);return 1;},clearTimer:()=>{},api:async(url,body)=>{
    if(url==='/api/consults'){post++;assert.equal(body.writableConfirmed,true);assert.equal(body.sourcesConfirmed,true);throw Object.assign(Error('最多同时进行 3 场会诊，请等其中一场结束'),{status:409,data:{running:{consultId:'other',status:'running'},active:3,parallel:3}});}
    return {items:[],running:null};
  }});
  c.setConsultDraft({situation:'保留草稿',options:['甲','乙'],explicit:true,lenses:explicit});assert.equal(await c.startConsult(),false);assert.equal(post,0);
  approved=true;assert.equal(await c.startConsult(),false);assert.equal(post,1);assert.match(prompts.join(' '),/可写.*原书路径失效/);assert.equal(c.snapshot().draft.situation,'保留草稿');assert.equal(c.snapshot().running.consultId,'other');
  await c.startConsult();assert.equal(post,1);c.dispose();const n=timers.length;await c.refresh();assert.equal(timers.length,n);
});

test('v034 E5 controller confirms and retries a server-side sources conflict once',async()=>{
  let posts=0,confirms=0;const id=randomUUID();const c=createController({getRegistry:registry,permissionText:()=>'',confirm:async()=>{confirms++;return true;},setTimer:()=>1,clearTimer:()=>{},api:async(url,body)=>{
    if(url==='/api/registry')return registry();
    if(url==='/api/consults'){posts++;if(posts===1)throw Object.assign(Error('确认来源'),{status:409,data:{sourcesConfirmed:true}});assert.equal(body.sourcesConfirmed,true);return {consultId:id};}
    if(url.includes(id))return {...record(),consultId:id,status:'done'};return {items:[],running:null};
  }});c.setConsultDraft({situation:'x',explicit:true,lenses:explicit});assert.equal(await c.startConsult(),true);assert.equal(posts,2);assert.equal(confirms,1);c.dispose();
});

test('v040 E1 E2 E4 E6 E15 E20 opening sheet counts Unicode, validates options and explicit rows, and keeps snapshot authors',async()=>{
  const {doc}=await appDocument();doc.createTextNode=text=>{const n=doc.createElement('text');n.textContent=text;return n;};
  const model={items:[],selected:null,running:null,busy:false,error:'',books:agents.map(a=>({id:a.id,name:a.name,bookLabel:a.book.title,available:true,ready:true})),
    draft:{situation:'',options:[],explicit:false,lenses:[],parentId:null}};
  const side=doc.createElement('aside'),host=doc.createElement('div');doc.getElementById('layout-root').append(side,host);
  let fresh=true;
  const ctx={doc,refs:{chatArrange(){},chatLayout:'columns'},state:{view:'chat',allAgents:agents},actions:{setConsultDraft(p){Object.assign(model.draft,structuredClone(p));render();}}};
  const render=()=>renderRooms(ctx,{room:'consults',fresh:{consults:fresh},consults:model,follow:{}},{side,main:host}), get=id=>doc.getElementById('room-consults-'+id);render();
  const input=async value=>{get('situation').value=value;await get('situation').fire('input');};
  for(const value of ['',' \n ','🙂'.repeat(4001)]){await input(value);assert.equal(get('start').disabled,true);assert.equal(get('validation').textContent,'处境必须为 1–4000 字');}
  await input('🙂'.repeat(4000));assert.equal(get('count').textContent,'4000 / 4000 字');assert.equal(get('start').disabled,false);
  await get('add-option').fire('click');assert.equal(get('start').disabled,true);
  await get('add-option').fire('click');
  for(const [i,value] of ['甲','甲'].entries()){get('option-'+i).value=value;await get('option-'+i).fire('input');}
  assert.match(get('validation').textContent,/选项 B.*重复/);
  get('option-1').value='乙'.repeat(201);await get('option-1').fire('input');assert.match(get('validation').textContent,/选项 B.*200/);
  get('option-1').value='乙';await get('option-1').fire('input');assert.equal(get('start').disabled,false);
  await get('remove-option-1').fire('click');assert.equal(get('start').disabled,true);await get('remove-option-0').fire('click');assert.equal(get('start').disabled,false);
  assert.equal(get('auto').getAttribute('aria-pressed'),'true');await get('explicit').fire('click');assert.equal(get('explicit').getAttribute('aria-pressed'),'true');
  assert.equal(model.draft.lenses.length,3);assert.equal(get('start').disabled,true);
  for(const [i,l] of explicit.entries()){get('agentId-'+i).value=l.agentId;await get('agentId-'+i).fire('change');}
  assert.equal(get('start').disabled,false);await get('add-lens').fire('click');await get('add-lens').fire('click');assert.equal(get('add-lens').disabled,true);
  await get('remove-lens-4').fire('click');await get('remove-lens-3').fire('click');assert.equal(get('remove-lens-0').disabled,true);
  get('lens-1').value='risk';await get('lens-1').fire('change');assert.equal(get('start').disabled,true);
  get('lens-1').value='bias';await get('lens-1').fire('change');assert.equal(get('start').disabled,false);
  model.running={consultId:'running',status:'running'};model.active=1;model.parallel=3;render();assert.equal(get('start').disabled,false);assert.equal(get('start').textContent,'开始会诊（另有 1 场在进行）');
  model.active=3;render();assert.equal(get('start').disabled,true);assert.equal(get('start').textContent,'已有 3 场会诊在进行');
  model.running=null;model.active=0;model.busy=true;render();assert.equal(get('situation').disabled,true);assert.equal(get('explicit').disabled,true);
  for(const field of host.querySelectorAll('input,select,textarea').filter(n=>!n.closest('[hidden]')))assert.ok(host.querySelector(`label[for="${field.id}"]`)||field.getAttribute('aria-label'),field.id);
  model.busy=false;model.books=[];model.selected={...record(),status:'done',result:output()};fresh=false;
  model.selected.result.lenses.forEach((l,i)=>Object.assign(l,{name:agents[i].name,bookLabel:agents[i].book.title}));render();
  const main=host.querySelector('.room-main[data-room="consults"]');assert.ok(main.textContent.includes('ONE'));assert.ok(main.textContent.includes('《one的书》'));
  assert.equal(main.querySelector('.chat-error').getAttribute('role'),'alert');assert.equal(main.querySelector('.chat-notice').getAttribute('role'),'status');
});

test('v034 E11 engine persists real runner failures and releases its running lock',async t=>{
  for(const [options,message] of [[{code:2},/model quota exhausted/],[{malformed:true},/JSON 无效/],[{huge:true},/10 MB/]]) {
    const h=await setup(t,{runner:runConsultProcess,spawnImpl:fakeOutput({},[],options)});
    const {consultId}=await h.engine.start({situation:'x'});await h.engine.idle();const saved=await h.engine.get(consultId);
    assert.equal(saved.status,'failed');assert.match(saved.error,message);assert.equal((await h.engine.list()).running,null);
  }
});

test('v034 E5 auto eligibility checks Codex source paths independently of Claude',async t=>{
  const list=agents.slice(0,3).map(a=>({...a,sources:{missing:['claude-only'],missingByVersion:{claude:['claude-only'],codex:[]}}}));
  const h=await setup(t,{},list);const {consultId}=await h.engine.start({situation:'x'});await h.engine.idle();assert.equal((await h.engine.get(consultId)).status,'done');
  h.registry.agents[0].sources.missingByVersion.codex=['missing codex book'];await assert.rejects(h.engine.start({situation:'x'}),{status:409,message:'可用的书籍 Agent 不足三本'});
});
