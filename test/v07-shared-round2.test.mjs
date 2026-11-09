import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as display from '../public/display.js';
import { mountApp, toAgentView, toHistoryView } from '../public/app.js';
import { classify, buildRegistry } from '../src/registry/classify.mjs';
import { mergeIdentity, normalize } from '../src/registry/identity.mjs';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';

const roleMap = JSON.parse(await fs.readFile('test/fixtures/catalog/roles.json', 'utf8'));
const bookMap = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json', 'utf8'));
const rawRecord = name => ({name, kind:'codex', sourceId:'synthetic', file:`${name}.toml`, description:'Long English description, not the purpose.'});
function registry() {
  return {sources:[], conflicts:[], scannedAt:'2026-10-07T00:00:00Z',
    ...classify(mergeIdentity([...roleMap.roles, ...bookMap.books.map(b => b.agent)].map(rawRecord)).agents, roleMap, bookMap)};
}
async function appFixture(t, ui) {
  const {doc} = await appDocument(ui), data = registry(), requests = [];
  for (const a of data.agents) a.platforms.claude = {available:true};
  const app = await mountApp(doc, async (url, options) => {
    requests.push({url, options});
    const value = url === '/api/registry' ? data : url === '/api/stats' ? {perAgent:{},sources:[],limitedReasons:[]} :
      url === '/api/settings' ? {ui, recommend:{}} : {items:[],unavailable:[]};
    return {ok:true, json:async () => value};
  }, {confirm:async () => true});
  t.after(() => app.dispose());
  return {doc, app, requests};
}

test('S2-2 titles select only the first bracketed book and retain the multi-book count', () => {
  for (const [raw, text] of [
    ['《示例小宝典（珍藏版）》上下两册', '示例小宝典（珍藏版）'],
    ['**《怎样整理示例册》，三部合编**', '怎样整理示例册'],
    ['《甲》；《乙》', '甲'],
    ['《**示例工坊**》附录', '示例工坊'],
    ['*Dear Sample*', 'Dear Sample'],
  ]) assert.deepEqual(display.cleanTitle(raw), {text, multi:1});
  assert.deepEqual(display.cleanTitle('多书，3 部：《原则（实践版）》；《原则》；《世界秩序》'), {text:'原则（实践版）', multi:3});
  assert.equal(display.bookLabel('《示例小宝典（珍藏版）》上下两册'), '《示例小宝典（珍藏版）》');
  assert.equal(display.bookLabel('多书，3 部：《原则（实践版）》；《原则》；《世界秩序》'), '原则（实践版） 等 3 本');
});
test('S2-2 spine titles remove edition parentheses and subtitles without destroying substantive parentheses', () => {
  assert.equal(display.spineTitle('《示例小宝典（珍藏版）》上下两册'), '示例小宝典');
  assert.equal(display.spineTitle('《原则(实践版)：练习》'), '原则');
  assert.equal(display.spineTitle('Book (Second Edition): Subtitle'), 'Book');
  assert.equal(display.spineTitle('多书，3 部：《原则（实践版）》；《原则》；《世界秩序》'), '原则 等 3 本');
  assert.equal(display.spineTitle('《史记（前100年）》'), '史记（前100年）');
  assert.equal(display.spineTitle(''), '');
});
test('S2-6 setStyle writes custom, kebab and camel-case properties through CSSOM only', () => {
  const writes = [], removed = [];
  const el = {style:{setProperty:(k,v) => writes.push([k,v]), removeProperty:k => removed.push(k)},
    setAttribute() { assert.fail('style attributes are blocked by CSP'); }};
  display.setStyle(el, {'--avatar':'#3949ab', backgroundColor:'#3949ab', 'max-width':'64px', width:'37%', opacity:0, height:null});
  assert.deepEqual(writes, [['--avatar','#3949ab'],['background-color','#3949ab'],['max-width','64px'],['width','37%'],['opacity','0']]);
  assert.deepEqual(removed, ['height']);
});
test('S2-3 registry binds purposes by original map name, and never turns descriptions into purposes', () => {
  const data = registry();
  for (const name of roleMap.roles) assert.equal(data.agents.find(a => a.id === normalize(name)).purpose, roleMap.purposes[name], name);
  assert.ok(data.agents.filter(a => a.kind === 'book').every(a => a.purpose === null));
  const variant = classify(mergeIdentity([rawRecord('-ALAN')]).agents, roleMap, bookMap).agents[0];
  assert.equal(variant.name, '-ALAN'); assert.equal(variant.purpose, roleMap.purposes['-Alan']);
  for (const agent of data.agents) assert.equal(toAgentView(agent).purpose, agent.kind === 'book' ? null : agent.purpose);
  assert.equal(toAgentView({id:'b',name:'B',kind:'book',purpose:'stale',description:'Description'}).purpose, null);
  assert.equal(toAgentView({id:'r',name:'R',kind:'role',description:'Description'}).purpose, null);
});
test('S2-3 purpose passes through real registry discovery using only temporary fixture files', async t => {
  const {config} = await fixture(t);
  for (const name of roleMap.roles) await put(path.join(config.codexAgentsDir, `${normalize(name)}.toml`), `name=${JSON.stringify(name)}\ndescription="Role"`);
  const data = await buildRegistry(config);
  assert.equal(data.agents.length, 11);
  for (const a of data.agents) assert.equal(a.purpose, roleMap.purposes[a.name]);
});
test('S2-5 history labels are additive and preserve IDs, raw status, provenance and permissions', () => {
  for (const [source, sourceLabel, mode, modeLabel, cli, cliLabel] of [
    ['launch','单次','agent','直接','claude','Claude'], ['recommend','AI 推荐','joint','联合','codex','Codex'], ['manual','手动','relay','转调','claude','Claude'],
  ]) {
    const raw = {type:'joint', id:'j1', createdAt:'2026-10-07T00:00:00Z', cli, agents:[{id:'a',name:'A'}], source, mode,
      inputPreview:'<script>literal', status:{overall:'failed', evidence:['original']}, canResume:false, resumeReason:'文件不存在', rerunOf:'j0', resumeOf:'j0', extra:true};
    const view = toHistoryView(raw);
    for (const [key,value] of Object.entries(raw)) assert.deepEqual(view[key], value, key);
    assert.equal(view.sourceLabel,sourceLabel); assert.equal(view.modeLabel,modeLabel); assert.equal(view.cliLabel,cliLabel);
  }
  const unknown = toHistoryView({type:'launch',id:'u',source:'future-source',mode:'future-mode',cli:'future-cli'});
  assert.equal(unknown.sourceLabel,'future-source'); assert.equal(unknown.modeLabel,'future-mode'); assert.equal(unknown.cliLabel,'future-cli');
  const reserved = toHistoryView({source:'constructor',mode:'toString',cli:'__proto__'});
  assert.equal(reserved.sourceLabel,'constructor'); assert.equal(reserved.modeLabel,'toString'); assert.equal(reserved.cliLabel,'__proto__');
  assert.deepEqual(structuredClone(reserved),reserved);
  assert.equal(toHistoryView({}).sourceLabel,'未声明'); assert.equal(toHistoryView({}).modeLabel,'未声明');
});
test('S2-5 status tones cover verified success, failure, running and uncertain history', () => {
  for (const [tone, states] of Object.entries({ok:['ready','resumed','done','historical','ok'],fail:['failed'],running:['running'],pending:['pending','unconfirmed','unknown',undefined]}))
    for (const overall of states) assert.equal(toHistoryView({status:{overall}}).statusTone,tone,String(overall));
  assert.equal(toHistoryView({canResume:true,status:{overall:'failed'}}).statusTone,'fail', 'resumability must not hide failure');
});

for (const ui of ['threepane','bento','editorial','shelf']) {
  test(`S2-1 ${ui} preserves full-width category separators throughout the shared view models`, async t => {
    const {app,doc} = await appFixture(t,ui);
    for (const category of bookMap.categories) {
      app.actions.selectCategory(category);
      const model = app.snapshot(), c = model.categories.find(c => c.key === category);
      assert.equal(c.fullLabel,category); assert.equal(c.label,display.categoryShort(category)); assert.equal(model.catalog.title,category);
      assert.equal(model.detail.meta.category,category);
      for (const a of model.catalog.agents) { assert.equal(a.primary,category); assert.equal(a.categoryShort,display.categoryShort(category)); }
      assert.doesNotMatch([c.label,c.fullLabel,model.catalog.title,...model.catalog.agents.map(a => a.categoryShort)].join('|'), /\/|\s／|／\s/);
      assert.doesNotMatch(doc.getElementById('navigation').textContent, /\/|\s／|／\s/);
    }
  });
  test(`S2-4 ${ui} joint rows and selected chips show the same CSSOM avatar and clean metadata`, async t => {
    const {doc,app,requests} = await appFixture(t,ui);
    app.actions.openJoint(['jack','munto','jadra']);
    const result = doc.getElementById('builder-results'), selected = doc.getElementById('builder-selected');
    // v0.53: titles and authors come from the catalog the fixture uses (the sample one), not from anyone's own list.
    const book = name => bookMap.books.find(b => b.agent === name);
    for (const [id,name,subtitle,author] of [['jack','-jack',roleMap.purposes['-jack'],''],['munto','Munto',book('Munto').title,book('Munto').author],['jadra','Jadra',book('Jadra').title,book('Jadra').author]]) {
      const row = result.querySelectorAll('label').find(n => n.querySelector('input').getAttribute('aria-label') === `选择 ${name}`);
      const chip = selected.querySelectorAll('button').find(n => n.getAttribute('aria-label') === `移除 ${name}`);
      for (const item of [row,chip]) {
        assert.ok(item); assert.match(item.textContent,new RegExp(name)); assert.ok(item.textContent.includes(subtitle));
        if (author) assert.ok(item.textContent.includes(author));
        assert.doesNotMatch(item.textContent,/上下两册|\*|Long English description/);
        const avatar = item.querySelector('.builder-avatar'); assert.ok(avatar); assert.equal(avatar.getAttribute('aria-hidden'),'true');
        assert.equal(avatar.style.getPropertyValue('background-color'), display.avatarColor(id)); assert.equal(avatar.getAttribute('style'),null);
      }
    }
    const submit = doc.getElementById('builder-submit'), input = doc.getElementById('builder-input');
    assert.equal(submit.disabled,true); input.value='纸面共同问题'; await input.fire('input'); assert.equal(submit.disabled,false);
    await selected.querySelector('[aria-label="移除 -jack"]').fire('click'); assert.deepEqual(app.snapshot().state.jointSelectedIds,['munto','jadra']);
    assert.ok(!requests.some(r => r.url === '/api/joint'));
  });
}
test('S2-4 enabled shared submit uses the active layout primary palette', async () => {
  const css = await fs.readFile('public/styles.css','utf8');
  const rule = css.match(/#builder-submit:enabled\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule,/background:\s*var\(--accent\)/); assert.match(rule,/color:\s*var\(--accent-fg\)/);
});
