import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { layouts } from '../public/layouts/index.js';
import * as callsModule from '../public/calls.js';
import { renderDefaultConcepts } from '../public/layouts/shared.js';
import { conceptStatus } from '../public/display.js';

function textNodes(doc) {
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  return doc;
}
const member = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent',
  book: kind === 'book' ? { title: '**Dear Sample**', author: '作者' } : null, purpose: kind === 'role' ? '项目协调' : null,
  description: '说明', tags: [], platforms: { codex: { available: true }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const agents = [member('source'), member('Peter', 'role'), ...Array.from({ length: 9 }, (_, i) => member(`b${i}`))];
const registry = { agents, categories: ['学习'], summary: { roles: 1, books: 10 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const record = (id = 'c1', extra = {}) => ({ conceptId: id, status: 'done', kind: 'daily', day: '2026-10-08',
  startedAt: '2026-10-08T01:00:00Z', agent: { id: 'source', name: 'source', title: 'Dear Sample' },
  result: { concept: '认知边界', conceptEn: 'Boundary', oneLine: '一句说明', whyUnknown: '不易察觉', sourceRefs: ['第 1 章'], markdown: '# 认知边界\n\n**完整正文**' },
  verify: { state: 'unconfirmed', skillStructure: { state: 'missing', missing: [3], titleLine: false } }, thinkError: '写入失败', perspectives: [], ...extra });
const listing = (records, running = null) => ({ items: records, running, today: { day: '2026-10-08', conceptId: records[0]?.conceptId ?? null, status: records[0]?.status ?? null } });
function clock() {
  let seq = 0; const tasks = new Map();
  return { tasks, setTimer(fn, ms) { const id = ++seq; tasks.set(id, { fn, ms }); return id; }, clearTimer(id) { tasks.delete(id); },
    async tick() { const [id, task] = tasks.entries().next().value; tasks.delete(id); await task.fn(); } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function controller(t, api, options = {}) {
  const { createConcepts } = await import('../public/concepts.js'); const timers = clock();
  const model = createConcepts({ api, getRegistry: () => registry, confirm: async () => true, permissionText: () => '权限', ...timers, ...options });
  t.after(() => model.dispose()); return { model, timers };
}

test('v08 Markdown renders the specified blocks and inline syntax as DOM', async () => {
  const { renderMarkdown } = await import('../public/markdown.js'); const doc = textNodes(documentFrom('<body></body>'));
  const root = renderMarkdown(doc, '# 标题\n\n段落 **粗体** 与 *斜体* 和 `code`。\n\n- 一\n- 二\n\n3. 三\n4. 四\n\n> 引用\n\n---\n\n| 列一 | 列二 |\n| --- | --- |\n| 值 | **强调** |\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\n<script>原样</script>\n```');
  for (const tag of ['h1','p','strong','em','code','ul','ol','li','blockquote','hr','table','thead','tbody','th','td','pre']) assert.ok(descendants(root).some(n=>n.tagName===tag.toUpperCase()), tag);
  assert.equal(root.querySelector('ol').getAttribute('start'), '3');
  assert.match(root.textContent, /Mermaid 图（源码）/); assert.match(root.textContent, /<script>原样<\/script>/);
});
test('v08 Markdown never creates executable HTML, images, styles or unsafe URLs', async () => {
  const { renderMarkdown } = await import('../public/markdown.js'); const doc = textNodes(documentFrom('<body></body>'));
  const root = renderMarkdown(doc, '<img src=x onerror=alert(1)>\n\n[站点](https://example.test/a) [坏](javascript:alert(1)) [文件](file:///C:/secret) [数据](data:text/html,evil) ![图](https://example.test/i.png)\n\n<script>alert(1)</script>');
  assert.equal(root.querySelectorAll('script, img, iframe, style').length, 0);
  assert.match(root.textContent, /站点.*https:\/\/example.test\/a/);
  for (const link of root.querySelectorAll('a')) { assert.match(link.getAttribute('href'), /^https?:\/\//); assert.equal(link.getAttribute('rel'), 'noopener noreferrer'); }
  assert.equal(root.querySelectorAll('a').length, 1);
  for (const el of descendants(root)) assert.ok(!Object.keys(el.attrs).some(key => /^on|^style$/i.test(key)));
  assert.doesNotMatch(await fs.readFile('public/markdown.js','utf8'), /innerHTML|outerHTML|insertAdjacentHTML|DOMParser/);
});
test('v08 Markdown preserves malformed input, fenced code and escaped delimiters', async () => {
  const { renderMarkdown } = await import('../public/markdown.js'); const doc = textNodes(documentFrom('<body></body>'));
  const root = renderMarkdown(doc, '\\*literal\\*\n\n```\n**not bold**\n# not heading\n');
  assert.match(root.textContent, /\*literal\*/); assert.equal(root.querySelectorAll('strong,h1').length, 0);
  assert.match(root.querySelector('code').textContent, /\*\*not bold\*\*/);
});
test('v08 polling uses 60s idle / 5s generation and perspective runs, including after navigation', async t => {
  let data = listing([record()]); const records = new Map([['c1', record()], ['c2', record('c2')]]);
  const { model, timers } = await controller(t, async url => url.includes('?') ? data : records.get(url.split('/').at(-1)));
  await model.openConcepts(); assert.equal(model.snapshot().selected.conceptId, 'c1'); assert.equal([...timers.tasks.values()][0].ms, 60000);
  data = listing([record()], { conceptId: 'new', kind: 'manual' }); await timers.tick(); assert.equal([...timers.tasks.values()][0].ms, 5000);
  data = listing([record()]); records.set('c1', record('c1', { perspectives: [{ runId: 'p1', status: 'running' }] }));
  await timers.tick(); await model.selectConcept('c2'); assert.equal([...timers.tasks.values()][0].ms, 5000);
  records.set('c1', record()); await timers.tick(); assert.equal([...timers.tasks.values()][0].ms, 60000);
  model.dispose(); assert.equal(timers.tasks.size, 0);
});
test('v08 stale selection responses and disposal cannot repaint or restart polling', async t => {
  const slow = deferred(); let emissions = 0;
  const { model, timers } = await controller(t, async url => url.endsWith('/a') ? slow.promise : record('b'), { onState: () => emissions++ });
  const pending = model.selectConcept('a'); await model.selectConcept('b'); slow.resolve(record('a')); await pending;
  assert.equal(model.snapshot().selected.conceptId, 'b'); const before = emissions; model.dispose(); await model.selectConcept('a');
  assert.equal(emissions, before); assert.equal(timers.tasks.size, 0);
});
test('v08 next manual concept is single-flight and POST 409 restores running state without retrying', async t => {
  const pending = deferred(), requests = []; const conflict = Object.assign(new Error('正在生成'), { status: 409, data: { running: { conceptId: 'existing', kind: 'daily' } } });
  const { model } = await controller(t, async (url, body) => { requests.push({url,body}); if (body) return pending.promise; return listing([]); });
  const task = model.nextConcept(); await model.nextConcept(); pending.resolve(Promise.reject(conflict)); await task;
  assert.equal(requests.filter(r => r.body).length, 1); assert.deepEqual(requests[0].body, {kind:'manual'});
  assert.equal(model.snapshot().running.conceptId, 'existing'); assert.match(model.snapshot().error, /正在生成/); assert.equal(model.snapshot().busy, false);
});
test('v08 manual generation selects the returned id and fetches the full record', async t => {
  const requests = [];
  const {model} = await controller(t, async (url,body) => { requests.push({url,body}); return body ? {conceptId:'new'} : url.includes('?') ? listing([record('new',{status:'running',result:null})],{conceptId:'new'}) : record('new',{status:'running',result:null}); });
  await model.nextConcept(); assert.equal(model.snapshot().selected.conceptId,'new'); assert.ok(requests.some(r=>r.url==='/api/concepts/new'));
});
test('v08 perspectives reject source, unknown/unavailable, duplicates, empty and over-eight before POST', async t => {
  const requests=[]; const {model}=await controller(t,async(url,body)=>{if(body) requests.push(body);return record();}); await model.selectConcept('c1');
  for(const ids of [[],['source'],['missing'],['b0','b0'],Array.from({length:9},(_,i)=>`b${i}`)]) assert.equal(await model.runPerspectives('c1',ids),false);
  assert.equal(requests.length,0);
});
test('v08 perspectives confirmations freeze ids, propagate flags, and never execute on cancellation', async t => {
  const approval=deferred(), posted=[]; const current=structuredClone(registry); current.agents[1].writable=true;current.agents[1].sources.missing=['absent'];
  const {model}=await controller(t,async(url,body)=>{if(body){posted.push({url,body});return{runId:'p'};}return record();},{getRegistry:()=>current,confirm:()=>approval.promise});
  await model.selectConcept('c1');const ids=['Peter'];const pending=model.runPerspectives('c1',ids);ids[0]='b0';approval.resolve(true);assert.equal(await pending,true);
  assert.deepEqual(posted[0],{url:'/api/concepts/c1/perspectives',body:{agentIds:['Peter'],writableConfirmed:true,sourcesConfirmed:true}});
  const {model:cancel}=await controller(t,async(url,body)=>{assert.equal(body,undefined);return record();},{getRegistry:()=>current,confirm:async()=>false});
  await cancel.selectConcept('c1');assert.equal(await cancel.runPerspectives('c1',['Peter']),false);
});
test('v08 terminal continuation only prefills manual builder, including concept context', async t => {
  const opened=[]; const {model}=await controller(t,async(url,body)=>{assert.equal(body,undefined);return record();},{onJoint:value=>opened.push(value)});
  await model.continueInJoint('c1',['b0','Peter']); assert.deepEqual(opened[0].agentIds,['b0','Peter']);assert.equal(opened[0].cli,'codex');
  assert.match(opened[0].input,/认知边界/);assert.match(opened[0].input,/完整正文/);assert.ok(opened[0].input.length<=8000);
});

test('v08 picker is searchable, grouped, source-free, skinnable and enforces max 8', async t => {
  const {doc}=await appDocument();const timers=clock(),gate=deferred(),submitted=[];
  const picker=callsModule.mountPerspectivePicker(doc,{getRegistry:()=>registry,api:async(url,body)=>body?{recommendId:'r'}:gate.promise,
    onRun:async(id,ids)=>{submitted.push({id,ids});return true;},onContinue:async()=>true,...timers});t.after(()=>picker.dispose());
  const pending=picker.open(record());assert.match(doc.getElementById('perspective-recommend').textContent,/推荐.*加载/);
  gate.resolve({status:'done',model:'fixture-model',results:[{id:'source',reason:'排除'}, {id:'b0',reason:'补充视角'}]});await pending;
  const dialog=doc.getElementById('perspective-picker');assert.doesNotMatch(dialog.textContent,/source ·/);assert.match(dialog.textContent,/b0 · 《Dear Sample》/);assert.match(dialog.textContent,/Peter · 项目协调/);assert.match(dialog.textContent,/补充视角/);
  assert.equal(dialog.querySelector('input').getAttribute('aria-label'),'搜索多视角 Agent');
  for(let i=0;i<8;i++){const check=doc.getElementById('perspective-all').querySelector(`[data-agent-id="b${i}"]`);check.checked=true;await check.fire('change');}
  assert.equal(doc.getElementById('perspective-all').querySelector('[data-agent-id="Peter"]').disabled,true);
  await doc.getElementById('perspective-submit').fire('click');assert.equal(submitted[0].ids.length,8);assert.equal(dialog.open,false);
});
test('v08 picker ignores old recommendations after reopen/close, cancels timers and restores focus', async t => {
  const {doc}=await appDocument();const timers=clock(),pending=deferred();let calls=0;
  const picker=callsModule.mountPerspectivePicker(doc,{getRegistry:()=>registry,api:async(url,body)=>{if(body)return{recommendId:`r${++calls}`};return url.endsWith('r1')?pending.promise:{status:'running'};},onRun:async()=>true,onContinue:async()=>true,...timers});t.after(()=>picker.dispose());
  const trigger=doc.getElementById('refresh');trigger.focus();const first=picker.open(record(),trigger);await picker.open(record('c2'),trigger);
  pending.resolve({status:'done',results:[{id:'b0',reason:'旧结果'}]});await first;assert.doesNotMatch(doc.getElementById('perspective-picker').textContent,/旧结果/);
  await doc.getElementById('perspective-picker').fire('keydown',{key:'Escape'});assert.equal(timers.tasks.size,0);assert.equal(doc.activeElement,trigger);
});

async function appFixture(t,ui,override=()=>null){
  const {doc,ids}=await appDocument(ui);textNodes(doc);const requests=[];
  const app=await mountApp(doc,async(url,opts={})=>{const body=opts.body?JSON.parse(opts.body):undefined;requests.push({url,opts,body});
    const replacement=override(url,body);if(replacement)return replacement;
    const value=url==='/api/registry'?registry:url==='/api/stats'?{perAgent:{},sources:[],limitedReasons:[]}:
      url==='/api/settings'?{ui:body?.ui||ui,recommend:{claude:{model:'fixture',effort:'high'},codex:{model:'fixture',effort:'xhigh'}}}:
      url==='/api/concepts?limit=30'?listing([record()]):url==='/api/concepts/c1'?record():
      url==='/api/recommend'?{recommendId:'r'}:url==='/api/recommend/r'?{status:'done',results:[{id:'b0',reason:'理由'}]}:
      url==='/api/joint'?{jointId:'j'}:{items:[],unavailable:[]};return{ok:true,json:async()=>value};},{confirm:async()=>true});
  t.after(()=>app.dispose());return{doc,ids,requests,app};
}
for(const ui of Object.keys(layouts))test(`v08 ${ui} default concept view exposes content, warnings and all actions`,async t=>{
  const {doc,app,requests}=await appFixture(t,ui);assert.equal(typeof layouts[ui].renderConcepts,'function');
  await doc.getElementById('concepts-open').fire('click');const m=app.snapshot();assert.equal(m.state.view,'concepts');
  assert.deepEqual(Object.keys(m.concepts).sort(),['today','items','selected','running','busy','error','threadOpen','threadItems','threadLoading','threadError'].sort());
  const panel=doc.getElementById('concepts-panel');assert.equal(panel.hidden,false);assert.match(panel.textContent,/认知边界/);assert.match(panel.textContent,/不易察觉/);
  assert.match(panel.textContent,/核验.*未确认/);assert.match(panel.textContent,/结构.*3/);assert.match(panel.textContent,/THINK.*写入失败/);
  for(const name of ['openConcepts','selectConcept','nextConcept','openPerspectivePicker','runPerspectives','continueInJoint'])assert.equal(typeof app.actions[name],'function');
  await app.actions.openPerspectivePicker('c1');assert.ok(doc.getElementById('perspective-picker').className.includes(layouts[ui].jointBuilderSkin));
  const recommendation=requests.find(r=>r.url==='/api/recommend');assert.deepEqual(recommendation.body,{input:'认知边界\n一句说明',engine:'codex'});assert.equal(recommendation.opts.headers['X-Co-Agent-Token'],'synthetic-token');
  const check=doc.getElementById('perspective-all').querySelector('[data-agent-id="b0"]');check.checked=true;await check.fire('change');
  await doc.getElementById('perspective-continue').fire('click');assert.equal(doc.getElementById('joint-builder').open,true);assert.equal(doc.getElementById('perspective-picker').open,false);
  assert.equal(doc.getElementById('builder-cli').value,'codex');assert.match(doc.getElementById('builder-input').value,/认知边界/);
  await doc.getElementById('builder-submit').fire('click');const sent=requests.find(r=>r.url==='/api/joint');
  assert.equal(sent.body.source,'manual');assert.deepEqual(sent.body.agentIds,['b0']);assert.equal(sent.opts.headers['X-Co-Agent-Token'],'synthetic-token');
  doc.getElementById('joint-builder').close();const back=panel.querySelector('[data-focus-key="concepts-back"]');back.focus();await back.fire('click');assert.equal(panel.hidden,true);assert.equal(doc.activeElement,doc.getElementById('concepts-open'));
});
test('v08 layout switching preserves concept state and selected full record',async t=>{
  const {app,doc,requests}=await appFixture(t,'threepane');await app.actions.openConcepts();app.actions.openSettings();
  for(const radio of doc.querySelectorAll('[role="radio"]')){await radio.fire('click');assert.equal(app.snapshot().concepts.selected.conceptId,'c1');assert.equal(app.snapshot().state.view,'concepts');}
  assert.equal(requests.filter(r=>r.url==='/api/concepts?limit=30').length,2);
});

test('v08 a stale refresh cannot erase an accepted perspective job',async t=>{
  const old=deferred(); let reading=false;
  const {model,timers}=await controller(t,async(url,body)=>body?{runId:'fresh'}:url.includes('?')?listing([record()]):reading?old.promise:record());
  await model.selectConcept('c1');reading=true;const refreshing=model.refresh();await Promise.resolve();
  assert.equal(await model.runPerspectives('c1',['b0']),true);old.resolve(record());await refreshing;
  assert.equal(model.snapshot().selected.perspectives.at(-1)?.runId,'fresh');assert.equal([...timers.tasks.values()][0].ms,5000);
});
test('v08 disposal while awaiting approval prevents perspective POST',async t=>{
  const gate=deferred(),current=structuredClone(registry);current.agents[1].writable=true;let posted=false;
  const {model}=await controller(t,async(url,body)=>{if(body)posted=true;return record();},{getRegistry:()=>current,confirm:()=>gate.promise});
  await model.selectConcept('c1');const pending=model.runPerspectives('c1',['Peter']);await Promise.resolve();model.dispose();gate.resolve(true);await pending;assert.equal(posted,false);
});
test('v08 confirmation refuses a registry change and unavailable Codex members',async t=>{
  const gate=deferred(),current=structuredClone(registry);current.agents[1].writable=true;let posted=false;
  const {model}=await controller(t,async(url,body)=>{if(body)posted=true;return record();},{getRegistry:()=>current,confirm:()=>gate.promise});
  await model.selectConcept('c1');const pending=model.runPerspectives('c1',['Peter']);await Promise.resolve();current.agents[1].description='changed';gate.resolve(true);assert.equal(await pending,false);
  assert.match(model.snapshot().error,/信息已变化/);current.agents[2].platforms.codex.available=false;assert.equal(await model.runPerspectives('c1',['b0']),false);assert.equal(posted,false);
});
test('v08 concept request failure is visible and polling recovers without a POST',async t=>{
  let fail=true;const {model,timers}=await controller(t,async(url,body)=>{assert.equal(body,undefined);if(fail)throw new Error('离线替身失败');return url.includes('?')?listing([record()]):record();});
  await model.openConcepts();assert.match(model.snapshot().error,/离线替身失败/);assert.equal([...timers.tasks.values()][0].ms,60000);
  fail=false;await timers.tick();assert.equal(model.snapshot().error,'');assert.equal(model.snapshot().selected.conceptId,'c1');
  const copy=model.snapshot();copy.selected.result.markdown='mutated';assert.notEqual(model.snapshot().selected.result.markdown,'mutated');
});
test('v08 picker waits for native asynchronous close before opening terminal builder',async t=>{
  const {doc}=await appDocument();const timers=clock();let continued=false;
  const picker=callsModule.mountPerspectivePicker(doc,{getRegistry:()=>registry,api:async(url,body)=>body?{recommendId:'r'}:{status:'done',results:[]},onRun:async()=>true,onContinue:async()=>{continued=true;return true;},...timers});t.after(()=>picker.dispose());
  await picker.open(record());const dialog=doc.getElementById('perspective-picker');dialog.close=()=>{dialog.open=false;};
  const check=doc.getElementById('perspective-all').querySelector('[data-agent-id="b0"]');check.checked=true;await check.fire('change');
  const pending=doc.getElementById('perspective-continue').fire('click');await Promise.resolve();assert.equal(continued,false);await dialog.fire('close');await pending;assert.equal(continued,true);
});
test('v08 picker search covers purpose, excludes unavailable agents and retains hidden selections',async t=>{
  const {doc}=await appDocument(),current=structuredClone(registry),timers=clock();current.agents.at(-1).platforms.codex.available=false;const sent=[];
  const picker=callsModule.mountPerspectivePicker(doc,{getRegistry:()=>current,api:async()=>{throw new Error('推荐服务失败');},onRun:async(id,ids)=>{sent.push(ids);return true;},onContinue:async()=>true,...timers});t.after(()=>picker.dispose());
  await picker.open(record());assert.match(doc.getElementById('perspective-recommend').textContent,/推荐服务失败/);
  assert.equal(doc.getElementById('perspective-all').querySelector('[data-agent-id="b8"]'),null);
  const check=doc.getElementById('perspective-all').querySelector('[data-agent-id="b0"]');check.checked=true;await check.fire('change');
  const search=doc.getElementById('perspective-search');search.value='项目协调';await search.fire('input');assert.match(doc.getElementById('perspective-all').textContent,/Peter/);assert.doesNotMatch(doc.getElementById('perspective-all').textContent,/b0/);
  await doc.getElementById('perspective-submit').fire('click');assert.deepEqual(sent,[['b0']]);
});
test('v08 fallback displays running time, failure retry and perspective Markdown without hiding warnings',()=>{
  const doc=textNodes(documentFrom('<body><div id="host"><div id="root"></div></div></body>')),requests=[];
  const ctx={doc,root:doc.getElementById('root'),refs:{},state:{view:'concepts'},actions:{showView:()=>{},openConcepts:()=>{},nextConcept:()=>requests.push('next'),selectConcept:()=>{},openPerspectivePicker:()=>{},continueInJoint:()=>{},runPerspectives:(id,ids)=>requests.push({id,ids})}};
  const r=record('c1',{status:'failed',error:'合成生成失败',perspectives:[{runId:'p',status:'failed',error:'分析失败',agents:[{id:'b0'}],verify:{state:'violation',parallel:{state:'not-parallel'},violations:['extra role']},results:[{name:'b0',analysis:'**已收到的部分结果**'}]}]});
  const model={items:[r],selected:r,today:null,running:{conceptId:'other',startedAt:new Date(Date.now()-65000).toISOString()},busy:false,error:''};
  renderDefaultConcepts(ctx,model);const panel=doc.getElementById('concepts-panel');assert.match(panel.textContent,/已用 1 分/);assert.match(panel.textContent,/合成生成失败/);assert.match(panel.textContent,/分析失败/);assert.match(panel.textContent,/extra role/);assert.match(panel.textContent,/已收到的部分结果/);
  assert.equal(panel.querySelector('[data-focus-key="concepts-retry"]').disabled,true);
  panel.querySelector('[data-focus-key="concepts-retry-p"]').fire('click');assert.deepEqual(requests,[{id:'c1',ids:['b0']}]);
});
test('v08 fallback preserves an unchanged completed Markdown DOM across unrelated updates',()=>{
  const doc=textNodes(documentFrom('<body><div id="host"><div id="root"></div></div></body>'));
  const ctx={doc,root:doc.getElementById('root'),refs:{},state:{view:'concepts'},actions:{}};
  const model={items:[],selected:record(),today:null,running:null,busy:false,error:''};renderDefaultConcepts(ctx,model);
  const before=doc.querySelector('.concept-markdown');renderDefaultConcepts(ctx,structuredClone(model));assert.equal(doc.querySelector('.concept-markdown'),before);
});
test('v08 HTTP 409 survives the app API wrapper and manual request carries its token',async t=>{
  const {app,requests}=await appFixture(t,'threepane',(url,body)=>url==='/api/concepts'&&body?{ok:false,status:409,json:async()=>({error:'正在生成',running:{conceptId:'existing',kind:'daily'}})}:null);
  assert.equal(await app.actions.nextConcept(),false);assert.equal(app.snapshot().concepts.running.conceptId,'existing');assert.match(app.snapshot().concepts.error,/正在生成/);
  const request=requests.find(r=>r.url==='/api/concepts');assert.deepEqual(request.body,{kind:'manual'});assert.equal(request.opts.headers['X-Co-Agent-Token'],'synthetic-token');
});
test('v08 Markdown supports heading levels, nested lists and escaped table pipes',async()=>{
  const {renderMarkdown}=await import('../public/markdown.js'),doc=textNodes(documentFrom('<body></body>'));
  const root=renderMarkdown(doc,'# C#\n\n## 二\n### 三\n#### 四\n##### 五\n###### 六\n\n- 外层\n  - 内层\n\n| A | B |\n| --- | --- |\n| x\\|y | `a|b` |');
  for(let i=1;i<=6;i++)assert.ok(descendants(root).some(n=>n.tagName===`H${i}`));
  assert.equal(descendants(root).find(n=>n.tagName==='H1').textContent,'C#');assert.equal(root.querySelectorAll('ul').length,2);
  assert.equal(root.querySelectorAll('td')[0].textContent,'x|y');assert.equal(root.querySelectorAll('td')[1].textContent,'a|b');
});
test('v08 terminal prefill is bounded and clearly marks truncated explanations',async t=>{
  const opened=[];const {model}=await controller(t,async()=>record('long',{result:{...record().result,markdown:'原文'.repeat(6000)}}),{onJoint:v=>opened.push(v)});
  await model.continueInJoint('long',[]);assert.ok(opened[0].input.length<=8000);assert.match(opened[0].input,/节选/);assert.deepEqual(opened[0].agentIds,[]);
});
test('v08 running state without a timestamp is never presented as zero elapsed time',()=>{
  assert.match(conceptStatus({status:'running'}),/用时未知/);assert.match(conceptStatus({status:'mystery'}),/未确认/);
});

test('v08 picker reuses one recommendation per concept; 重新推荐 starts a fresh run', async t => {
  const {doc}=await appDocument();const timers=clock();const store=new Map();
  doc.defaultView={localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v))}};
  const posts=[];const picker=callsModule.mountPerspectivePicker(doc,{getRegistry:()=>registry,
    api:async(url,body)=>{if(body){posts.push(body);return{recommendId:`r${posts.length}`};}return{status:'done',results:[{id:'b0',reason:`理由${url.slice(-1)}`}]};},
    onRun:async()=>true,onContinue:async()=>true,...timers});t.after(()=>picker.dispose());
  await picker.open(record());assert.equal(posts.length,1);assert.match(doc.getElementById('perspective-recommend').textContent,/理由1/);
  await doc.getElementById('perspective-picker').fire('keydown',{key:'Escape'});
  await picker.open(record());assert.equal(posts.length,1,'reopening the same concept must not start another recommendation');
  assert.match(doc.getElementById('perspective-recommend').textContent,/理由1/);
  const again=[...descendants(doc.getElementById('perspective-recommend'))].find(n=>n.textContent==='重新推荐');assert.ok(again);
  await again.fire('click');assert.equal(posts.length,2);assert.match(doc.getElementById('perspective-recommend').textContent,/理由2/);
  await doc.getElementById('perspective-picker').fire('keydown',{key:'Escape'});
  await picker.open(record('c2'));assert.equal(posts.length,3,'a different concept gets its own recommendation');
});

test('v08 the concept list hides failed generations; a failed today stays selected to show its reason', async t => {
  const failed = record('f1', { status: 'failed', result: null, error: '概念 JSON 格式无效' }), done = record('d1'), running = record('r1', { status: 'running', result: null });
  const details = [];
  const { model } = await controller(t, async path => {
    if (path.startsWith('/api/concepts?')) return listing([failed, running, done]);
    const id = decodeURIComponent(path.split('/').pop()); details.push(id); return [failed, running, done].find(r => r.conceptId === id);
  });
  await model.refresh();
  const state = model.snapshot();
  assert.deepEqual(state.items.map(item => item.conceptId), ['r1', 'd1']);
  assert.equal(state.today.conceptId, 'f1'); assert.equal(state.selected.conceptId, 'f1'); assert.deepEqual(details, ['f1']);
});
