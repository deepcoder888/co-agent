import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { descendants } from './fixtures/dom.mjs';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';
import { avatarColor } from '../public/display.js';
import * as threepane from '../public/layouts/threepane.js';

const categories = ['睡眠／健康／运动', ...Array.from({length:10}, (_, i) => `书籍分类${i}`)];
const member = (id, kind = 'book') => ({id, name:id, kind, primary:kind === 'book' ? categories[0] : '功能性 Agent',
  purpose:'检查论证与证据', description:'第一段说明。\n\n第二段必须保留。\n<example>user: 不应出现在正文</example>', tags:[], sourceFile:'fixture.toml',
  book:kind === 'book' ? {title:'*Dear Sample*', author:'甲、乙、丙', edition:'2023'} : null,
  permissions:{claude:{model:'opus', effort:'xhigh'}}, sources:{checked:true, total:1, missing:[]}, sync:{state:'同步', detail:'一致'},
  platforms:{claude:{available:true, file:'fixture.md'}, codex:{available:true}}});
const agents = [member('Peter', 'role'), member('Walvo'), member('Jadra')];
const record = (id, canResume) => ({id, type:'joint', createdAt:'2026-10-07T00:00:00Z', cli:'codex', agents:[{id:'Walvo',name:'Walvo'}],
  mode:'joint', source:'manual', inputPreview:'共同问题 <script>literal</script>', status:{overall:'done'}, canResume, resumeReason:canResume ? '' : '会话文件不存在'});
async function fixture(t) {
  const {doc, ids} = await appDocument('threepane'), calls = [];
  // Record CSSOM separately: under style-src 'self', style attributes do not paint.
  // This is a protocol check, not a browser/CSP or pixel-rendering simulation.
  const styleAttributeWrites = [], createElement = doc.createElement;
  doc.createElement = tag => {
    const el = createElement(tag), properties = new Map(), setAttribute = el.setAttribute.bind(el);
    el.style = {
      setProperty: (name, value) => properties.set(name, String(value)),
      getPropertyValue: name => properties.get(name) || '',
    };
    el.setAttribute = (name, value) => {
      if (name === 'style') styleAttributeWrites.push({el, value});
      setAttribute(name, value);
    };
    return el;
  };
  const registry = {agents:structuredClone(agents), categories, summary:{roles:1, books:2, synced:3}, sources:[], outOfScope:[], conflicts:[], missingFromDisk:[]};
  const running = [{id:'run1', launchId:'run1', type:'launch', agentName:'Walvo', cli:'claude', createdAt:'2026-10-07T00:00:00Z', status:{overall:'pending', process:{state:'alive'}, cwd:{state:'ok'}, agent:{state:'pending'}, waiting:{state:'pending'}}}];
  const app = await mountApp(doc, async (url, options) => {
    calls.push({url, options});
    const value = url === '/api/registry' || url === '/api/refresh' ? registry :
      url === '/api/settings' ? {ui:options ? JSON.parse(options.body).ui : 'threepane', recommend:{claude:{model:'sonnet',effort:'high'}}} :
      url === '/api/stats' ? {perAgent:{}, sources:[], limited:true, limitedReasons:['测试覆盖有限']} :
      url === '/api/running' ? {items:running} : url.startsWith('/api/history?') ? {items:[record('j1',true),record('j2',false)]} :
      url === '/api/history/Walvo' ? {items:[{cli:'claude', launchId:'l1', createdAt:'2026-10-07T00:00:00Z', mode:'agent'}], unavailable:[]} :
      url === '/api/recommend' ? {recommendId:'r1'} : url === '/api/recommend/r1' ? {recommendId:'r1',status:'done',engine:'claude',results:[{...registry.agents[1],reason:'适合问题'}],audit:{ok:true,agentCalls:0,children:0}} :
      url === '/api/launch' || url === '/api/resume' ? {launchId:'l2'} : url === '/api/launch/l2' ? {overall:'failed',message:'合成终态',process:{state:'exited'},cwd:{state:'ok'},agent:{state:'pending'},waiting:{state:'pending'}} : {items:[], unavailable:[]};
    return {ok:true, json:async()=>value};
  }, {confirm:async()=>true});
  t.after(()=>app.dispose());
  const find = (label, root = doc.documentElement) => descendants(root).find(n=>n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === label || n.textContent === label));
  return {doc, ids, app, calls, registry, find, styleAttributeWrites};
}
const visible = node => node && !node.closest('[hidden]');
const rules = async () => (await fs.readFile('public/layouts/threepane.css','utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
function cssRule(css, selector) {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return blocks.filter(([,head])=>head.split(',').map(x=>x.trim()).includes(`[data-ui="threepane"] ${selector}`)).map(([, ,body])=>body).join(';');
}
test('threepane §3.1: exactly three pane siblings, viewport containment and independent scroll declarations', async t => {
  const {doc} = await fixture(t), root = doc.querySelector('.layout-threepane');
  assert.deepEqual(root.children.filter(n=>n.tagName !== 'DIALOG').map(n=>n.className), ['mail-navigation','mail-list','mail-detail']);
  const css = await rules();
  assert.match(cssRule(css,'.layout-threepane'), /height:\s*100vh/);
  assert.match(cssRule(css,'body'), /overflow:\s*hidden/);
  for (const cls of ['.mail-navigation','.mail-list','.mail-detail']) assert.match(cssRule(css,cls), /overflow-y:\s*auto/);
  // The recording DOM has no layout engine; scrollHeight is a separate browser acceptance check.
});
test('threepane §3.2: brand, compose, four utilities, divider, flat categories, bottom settings', async t => {
  const {doc, ids, find, app} = await fixture(t), nav = doc.querySelector('.mail-navigation');
  assert.deepEqual(nav.children.map(n=>n.id || n.className), ['brand','compose','groups-nav','utility-nav','mail-divider','candidate-notice quiet','navigation','settings-open'] /* v0.18 candidate notice */);
  assert.equal(ids.brand.textContent,'CO-AGENT'); assert.equal(ids.brand.querySelector('img').getAttribute('width'),'28');
  assert.deepEqual(doc.querySelector('.utility-nav').children.map(n=>n.textContent), ['调用组','AI 推荐','随机概念','研讨','会诊室','顾问团','概念地图','软件内对话','历史调用','运行中 1','调用统计','扫描与覆盖'] /* v0.35 顾问团 */);
  assert.equal(ids.navigation.children.length,13); // 角色 + 全部书籍 + 11 主类: contract's "12" is an arithmetic error.
  assert.equal(ids.navigation.querySelectorAll('svg').length,0); assert.equal(ids.navigation.querySelectorAll('details').length,0);
  for (const row of ids.navigation.children) { assert.equal(row.children.length,2); assert.ok(row.title); }
  await ids.navigation.children[2].fire('click'); assert.equal(app.snapshot().state.category,categories[0]);
  assert.equal(ids.navigation.children[2].getAttribute('aria-current'),'page');
  assert.doesNotMatch(ids.navigation.textContent,/· 7 天|▼|全局搜索/);
  assert.ok(find('打开设置').querySelector('svg'));
  const css=await rules(); assert.match(cssRule(css,'.mail-navigation'), /flex:\s*1 1 230px/); assert.match(cssRule(css,'.mail-navigation'), /max-width:\s*260px/);
  assert.match(cssRule(css,'.compose'), /height:\s*44px/); assert.match(cssRule(css,'#settings-open'), /position:\s*sticky/);
});
test('threepane §3.3: search capsule, count/sort header, three-line cleaned rows and selected marker', async t => {
  const {ids,app} = await fixture(t); app.actions.selectCategory(categories[0]);
  assert.equal(ids.search.getAttribute('placeholder'),'搜索名称、书名、作者'); assert.equal(ids['search-control'].textContent,'');
  assert.equal(ids.search.getAttribute('aria-label'),'全局搜索'); assert.equal(ids.search.getAttribute('title'),'/ 或 Ctrl+K');
  assert.equal(ids['view-title'].textContent,`${categories[0]} · 2 个`); assert.ok(ids['view-title'].parentElement.contains(ids.sort));
  const rows=ids.cards.children; assert.equal(rows.length,2);
  assert.equal(rows[0].getAttribute('data-selected'),'true'); assert.equal(rows[0].querySelector('.selected-marker').textContent,'已选');
  assert.equal(rows[0].querySelector('.avatar').style.getPropertyValue('background'),avatarColor('Walvo'));
  assert.equal(rows[0].querySelector('.row-subtitle').textContent,'《Dear Sample》'); assert.equal(rows[0].querySelector('.row-description').textContent,'甲、乙');
  assert.doesNotMatch(ids.cards.textContent,/\*|<example>|范围有限/);
  app.actions.selectCategory('role'); assert.equal(ids.cards.querySelector('.row-subtitle').textContent,'检查论证与证据');
  assert.equal(ids.cards.querySelector('.row-description').textContent,'第一段说明。');
  const css=await rules(); assert.match(cssRule(css,'.mail-list'), /flex:\s*2 1 380px/); assert.match(cssRule(css,'.mail-list'), /max-width:\s*460px/);
  assert.match(cssRule(css,'.mail-row'), /padding:\s*14px 16px/); assert.match(cssRule(css,'.row-subtitle'), /text-overflow:\s*ellipsis/);
});
test('threepane §3.4: detail order, chips, actionable pills, config truthfulness and five collapsed sections', async t => {
  const {ids,app,find,doc,calls,registry}=await fixture(t); app.actions.selectCategory(categories[0]); await app.actions.openDetail('Walvo');
  assert.deepEqual(ids['detail-body'].children.map(n=>n.className), ['detail-hero','detail-chips','detail-summary','detail-actions','detail-meta','detail-folds']);
  assert.equal(ids['detail-title'].tagName,'H1'); assert.equal(ids['detail-title'].textContent,'Walvo');
  assert.match(doc.querySelector('.detail-subtitle').textContent,/《Dear Sample》 · 甲、乙 · 2023/);
  assert.deepEqual(doc.querySelector('.detail-chips').children.map(n=>n.textContent),['原书可用','只读','Claude ✓ · Codex ✓','两个版本一致']);
  assert.equal(doc.querySelector('.detail-summary').textContent,'第一段说明。');
  assert.deepEqual(doc.querySelector('.detail-actions').children.map(n=>n.textContent),['在 Claude CLI 中调用','在 Codex CLI 中调用','在 CO-AGENT 中调用','继续上次会话','加入联合调用','☆ 设为常用','打开原书'] /* v0.10; v0.29 常用; v0.39 软件内调用 */);
  assert.match(doc.querySelector('.detail-meta').textContent,/模型（Claude）opus · xhigh终端窗口未提供/);
  assert.match(doc.querySelector('.terminal-value').title,/未提供终端配置/);
  const folds=doc.querySelector('.detail-folds').children;
  assert.deepEqual(folds.map(n=>n.querySelector('summary').textContent),['完整说明','统计','权限与模型','源文件','双版本同步']);
  assert.ok(folds.every(n=>n.tagName==='DETAILS'&&!n.open)); assert.match(folds[0].textContent,/第二段必须保留/);
  assert.match(folds[0].textContent,/user: 不应出现在正文/); // Keep complete source content inside the collapsed explanation, without raw example tags.
  assert.doesNotMatch(ids['detail-body'].textContent,/<example>|\*Dear Sample\*/); assert.equal(doc.querySelectorAll('.scope-info').length,1);
  folds[0].open=true; await app.actions.refreshRunning(); assert.equal(doc.querySelector('.detail-folds').children[0].open,true);
  await find('继续上次会话 Walvo').fire('click'); assert.ok(calls.some(c=>c.url==='/api/resume'&&JSON.parse(c.options.body).launchId==='l1'));
  registry.agents[2].sources.missing=['missing.epub']; registry.agents[2].writable=true; registry.agents[2].platforms.codex={available:false,reason:'缺少入口'};
  registry.agents[2].sync={state:'不一致',detail:'版本不同'}; await app.actions.refresh(); await app.actions.openDetail('Jadra');
  assert.deepEqual(doc.querySelector('.detail-chips').children.map(n=>n.textContent),['原书路径失效','可写','Claude ✓ · Codex ✕','不一致']); // v0.53: the state is described, not called 不同步
  assert.equal(find('在 Codex CLI 中调用 Jadra').disabled,true); assert.equal(find('在 Codex CLI 中调用 Jadra').title,'缺少入口');
  assert.equal(find('继续上次会话 Jadra').disabled,true); assert.match(find('继续上次会话 Jadra').title,/暂无/);
});
test('threepane §3.5: history keeps compact selectable rows in middle and operations/reasons on right', async t => {
  const {doc,ids,find,calls}=await fixture(t); await find('历史调用').fire('click');
  assert.ok(visible(ids['history-panel'])); assert.ok(ids['history-panel'].closest('.mail-list')); assert.ok(ids['history-detail'].closest('.mail-detail'));
  assert.equal(ids['history-list'].querySelectorAll('button').length,2); assert.equal(ids['history-list'].querySelectorAll('.history-status-chip').length,2);
  assert.ok(find('重新调用 Walvo',ids['history-detail'])); await find('重新调用 Walvo',ids['history-detail']).fire('click');
  assert.ok(calls.some(c=>c.url==='/api/history/rerun'));
  await find('继续该次会话 Walvo',ids['history-detail']).fire('click'); assert.ok(calls.some(c=>c.url==='/api/resume'));
  await ids['history-list'].querySelectorAll('button')[1].fire('click');
  assert.equal(find('继续该次会话 Walvo',ids['history-detail']).disabled,true); assert.match(ids['history-detail'].textContent,/会话文件不存在/);
  assert.equal(doc.querySelector('.history-preview').querySelector('script'),null);
});
test('threepane §3.5: recommendation input on right, selectable results on middle; running and coverage split panes', async t => {
  const {doc,ids,app,find}=await fixture(t); await find('AI 推荐').fire('click');
  assert.ok(visible(ids['recommend-panel'])); assert.ok(ids['recommend-input'].closest('.mail-detail')); assert.ok(ids['recommend-results'].closest('.mail-list'));
  ids['recommend-input'].value='问题'; await ids['recommend-input'].fire('input'); await ids['recommend-submit'].fire('click');
  const check=ids['recommend-results'].querySelector('input'); assert.ok(check); check.checked=true; await check.fire('change');
  assert.deepEqual(app.snapshot().recommend.selectedIds,['Walvo']); assert.doesNotMatch(ids['recommend-results'].textContent,/\*|<example>|范围有限/);
  await find('将已选推荐加入联合调用').fire('click'); assert.equal(ids['joint-builder'].open,true); assert.match(ids['builder-selected'].textContent,/Walvo/);
  await ids['builder-close'].fire('click'); await find('运行中的会话').fire('click');
  assert.ok(visible(ids['running-panel'])); assert.ok(ids['running-list'].closest('.mail-list')); assert.ok(visible(ids['running-detail'])); assert.match(ids['running-detail'].textContent,/Walvo/);
  await find('扫描摘要和数据覆盖').fire('click'); assert.ok(visible(ids['coverage-panel'])); assert.ok(ids['coverage-list'].closest('.mail-list')); assert.ok(ids['scan-detail'].closest('.mail-detail')); assert.ok(visible(ids['stats-detail']));
});
test('threepane §3.6: shared builder remains functional; Material skin is scoped, 640px wide with 28px corners', async t => {
  // calls.js owns candidate content: its missing avatar/title-cleaning hook is a reported shared-layer gap, not a skin assertion.
  const {ids,find}=await fixture(t); await find('新建联合调用').fire('click');
  assert.match(ids['joint-builder'].className,/threepane-builder/); assert.equal(ids['joint-builder'].open,true);
  const check=ids['builder-results'].querySelector('input'); check.checked=true; await check.fire('change');
  assert.ok(ids['builder-selected'].querySelector('button')); await ids['builder-selected'].querySelector('button').fire('click'); assert.equal(ids['builder-results'].querySelector('input').checked,false);
  const css=await rules(); assert.match(cssRule(css,'.threepane-builder'),/width:\s*min\(640px/); assert.match(cssRule(css,'.threepane-builder'),/border-radius:\s*28px/);
  assert.match(cssRule(css,'#builder-search'),/border-radius:\s*22px/); assert.match(cssRule(css,'.builder-row'),/padding:\s*14px 16px/);
  assert.match(cssRule(css,'#builder-submit'),/background:\s*#0b57d0/);
  for (const [,head] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) for (const selector of head.split(',')) assert.ok(selector.trim().startsWith('[data-ui="threepane"]'),selector);
  assert.doesNotMatch(css,/@import|https?:/);
});
test('threepane all 11 functions reachable, keyboard search and switching preserve shared selections/drafts', async t => {
  const {doc,ids,app,find,calls}=await fixture(t);
  await doc.fire('keydown',{key:'/',target:doc.body,preventDefault(){}}); assert.equal(doc.activeElement,ids.search);
  await doc.fire('keydown',{key:'k',ctrlKey:true,target:doc.body,preventDefault(){}}); assert.equal(doc.activeElement,ids.search);
  app.actions.selectCategory(categories[0]); await find('查看 Walvo 详情').fire('click');
  await find('在 Claude CLI 中调用 Walvo').fire('click'); await find('在 Codex CLI 中调用 Walvo').fire('click');
  assert.deepEqual(calls.filter(c=>c.url==='/api/launch').map(c=>JSON.parse(c.options.body).cli),['claude','codex']);
  await find('加入联合调用 Walvo').fire('click'); await ids['builder-close'].fire('click');
  app.actions.search('Walvo'); app.actions.setRecommendInput('未提交草稿'); app.actions.openSettings();
  for (const index of [1,0,2,0,3,0]) {
    await doc.querySelectorAll('[role="radio"]')[index].fire('click'); const value=app.snapshot();
    assert.equal(value.state.category,categories[0]); assert.equal(value.catalog.selectedId,'Walvo'); assert.equal(value.catalog.query,'Walvo');
    assert.equal(value.recommend.input,'未提交草稿'); assert.deepEqual(value.state.jointSelectedIds,['Walvo']);
  }
  assert.equal(calls.filter(c=>c.url==='/api/registry').length,1); assert.equal(calls.filter(c=>c.url==='/api/recommend').length,0);
  assert.equal(ids.search.value,'Walvo'); assert.equal(ids['recommend-input'].value,'未提交草稿');
});
test('threepane §3.4 terminal values use supplied configuration when available', async t => {
  const {doc,app}=await fixture(t), value=app.snapshot(); value.detail.meta.terminalDisplay='secondary'; value.detail.meta.terminalWindowMode='fullscreen';
  const ctx={doc,refs:{},state:value.state,actions:app.actions}; ctx.root=threepane.render(ctx); threepane.renderDetail(ctx,value.detail);
  assert.equal(ctx.refs['detail-body'].querySelector('.terminal-value').textContent,'副屏 · 全屏');
});
test('threepane §§3.1–3.6: contract dimensions, typography and pigments stay exact', async () => {
  const css=await rules();
  const expected = {
    '.mail-navigation':{'background':'#f6f7f9','border-right':'1px solid #e3e6ea','padding':'20px 14px','gap':'4px'},
    '.brand':{'gap':'10px','padding':'4px 8px 18px','font-size':'16px','font-weight':'600'},
    '.compose':{'height':'44px','border-radius':'22px','background':'#c2e7ff','color':'#001d35','padding':'0 18px','margin-bottom':'12px'},
    '#navigation button':{'height':'36px','padding':'0 12px','border-radius':'18px'},
    '#navigation button[aria-current=page]':{'background':'#d3e3fd','font-weight':'600'},
    '#search-control':{'padding':'16px','border-bottom':'1px solid #e3e6ea'},
    '#search':{'height':'44px','border-radius':'22px','background':'#eef1f4','border':'0','padding':'0 18px'},
    '.view-heading':{'padding':'12px 16px'}, '#view-title':{'font-size':'13px','color':'#59636e','font-weight':'400'},
    '#sort':{'border':'0','background':'transparent'}, '.mail-row':{'padding':'14px 16px','border-bottom':'1px solid #eef0f2'},
    '.mail-row[data-selected=true]':{'background':'#eef3fe'},
    '.avatar':{'width':'40px','height':'40px','border-radius':'50%','color':'#ffffff','font-weight':'600'},
    '.row-heading strong':{'font-size':'15px','font-weight':'600'}, '.selected-marker':{'font-size':'12px','color':'#59636e'},
    '.row-description':{'font-size':'13px','color':'#59636e','white-space':'nowrap','text-overflow':'ellipsis'},
    '.mail-detail':{'padding':'32px 40px','flex':'999 1 480px'}, '#detail-body':{'gap':'22px'},
    '.detail-hero':{'gap':'16px'}, '.detail-avatar':{'width':'64px','height':'64px','font-size':'26px'},
    '#detail-title':{'font-size':'26px','font-weight':'600','margin':'0'}, '.detail-subtitle':{'color':'#59636e'},
    '.detail-chips':{'gap':'8px'}, '.detail-chip':{'border-radius':'6px','font-size':'13px','padding':'4px 10px','background':'#eef1f4'},
    '.detail-chip.source-ok':{'background':'#e6f4ea','color':'#137333'}, '.detail-chip.source-missing':{'background':'#fce8e6','color':'#c5221f'},
    '.detail-summary':{'line-height':'1.7','max-width':'720px','margin':'0'},
    '.detail-actions':{'gap':'12px'}, '.primary-button':{'height':'44px','border-radius':'22px','background':'#0b57d0','padding':'0 22px'},
    '.outline-button':{'border':'1px solid #747775','color':'#0b57d0'}, '.text-button':{'background':'transparent','border':'0','padding':'0 16px'},
    '.detail-meta':{'border-top':'1px solid #e3e6ea','padding-top':'18px','grid-template-columns':'repeat(3,minmax(0,1fr))','gap':'16px'},
    '.meta-label':{'font-size':'13px','color':'#59636e'}, '.meta-field':{'font-weight':'600'},
    '.threepane-builder':{'width':'min(640px,calc(100% - 24px))','border-radius':'28px'}, '#builder-search':{'height':'44px','border-radius':'22px'},
    '.builder-row':{'padding':'14px 16px','border-bottom':'1px solid #eef0f2'}, '#builder-submit':{'height':'44px','border-radius':'22px','background':'#0b57d0'},
  };
  for (const [selector, values] of Object.entries(expected)) {
    const declarations=Object.fromEntries(cssRule(css,selector).split(';').filter(x=>x.trim()).map(s=>s.split(':').map(x=>x.trim())));
    for (const [key,value] of Object.entries(values)) assert.equal(declarations[key],value,`${selector}: ${key}`);
  }
});
test('threepane §3.5: missing coverage evidence never claims readable sources', async t => {
  const {doc,app}=await fixture(t), value=app.snapshot(),ctx={doc,refs:{},state:value.state,actions:app.actions};ctx.root=threepane.render(ctx);
  threepane.renderCoverage(ctx,{...value.coverage,stats:null,statsLoading:false});assert.match(ctx.refs['stats-summary'].textContent,/暂无可读来源/);
  threepane.renderCoverage(ctx,{...value.coverage,stats:{sources:[],limited:false,limitedReasons:[]},statsLoading:true});assert.match(ctx.refs['stats-summary'].textContent,/统计中/);
});

test('threepane T2-1: list, detail and recommendation avatars use stable CSSOM colors, never style attributes', async t => {
  const {doc,ids,app,find,styleAttributeWrites}=await fixture(t);
  app.actions.selectCategory(categories[0]); await app.actions.openDetail('Walvo');
  const checkAvatar = el => {
    assert.ok(el); assert.equal(el.textContent,'W'); assert.equal(el.getAttribute('aria-hidden'),'true');
    assert.equal(el.style.getPropertyValue('background'),avatarColor('Walvo'));
  };
  checkAvatar(ids.cards.querySelector('.avatar')); checkAvatar(doc.querySelector('.detail-avatar'));
  await find('AI 推荐').fire('click');
  ids['recommend-input'].value='睡眠问题'; await ids['recommend-input'].fire('input'); await ids['recommend-submit'].fire('click');
  checkAvatar(ids['recommend-results'].querySelector('.avatar'));
  app.actions.selectCategory(categories[0]); app.actions.sort('total');
  checkAvatar(ids.cards.querySelector('.avatar'));
  assert.equal(styleAttributeWrites.length,0,'setAttribute(style) is rejected by the app CSP');
  const css=await rules();
  for (const property of ['width','height']) {
    assert.match(cssRule(css,'.avatar'),new RegExp(`${property}:\\s*40px`));
    assert.match(cssRule(css,'.detail-avatar'),new RegExp(`${property}:\\s*64px`));
  }
  assert.match(cssRule(css,'.avatar'),/border-radius:\s*50%/);
});

test('threepane T2-2: book rows and detail bracket English, Chinese and multi-book titles exactly once', async t => {
  const {doc,ids,app,registry}=await fixture(t);
  const cases = [
    ['**Notes on Sample**','《Notes on Sample》'],
    ['《Dear Sample》','《Dear Sample》'],
    ['*示例工坊*','《示例工坊》'],
    ['《示例工坊》','《示例工坊》'],
    ['多书，2部：《Notes on Sample》；《Dear Sample》','《Notes on Sample》 等 2 本'],
    ['', ''],
  ];
  for (const [raw,expected] of cases) {
    registry.agents[1].book.title=raw;
    await app.actions.refresh(); app.actions.selectCategory(categories[0]); await app.actions.openDetail('Walvo');
    assert.equal(ids.cards.querySelector('.row-subtitle').textContent,expected,raw);
    assert.equal(doc.querySelector('.detail-subtitle').textContent,[expected,'甲、乙','2023'].filter(Boolean).join(' · '),raw);
  }
  app.actions.selectCategory('role'); await app.actions.openDetail('Peter');
  assert.equal(doc.querySelector('.detail-subtitle').textContent,'检查论证与证据');
});

test('threepane T2-3: long detail subtitles retain full title text with single-line ellipsis and a shrinking flex child', async t => {
  const {doc,app,registry}=await fixture(t);
  registry.agents[1].book.edition='English First Edition 2017 / Scribner / ' + '完整版本说明'.repeat(20);
  await app.actions.refresh(); app.actions.selectCategory(categories[0]); await app.actions.openDetail('Walvo');
  let subtitle=doc.querySelector('.detail-subtitle');
  // v0.10 appends the Ctrl+click hint to the tooltip only; the visible text stays the plain subtitle.
  assert.equal(subtitle.title,`《Dear Sample》 · 甲、乙 · ${registry.agents[1].book.edition}\nCtrl+单击打开原书`);
  assert.equal(subtitle.textContent,subtitle.title.replace(/\nCtrl\+单击打开原书$/,''));
  app.actions.selectCategory('role'); await app.actions.openDetail('Peter');
  subtitle=doc.querySelector('.detail-subtitle'); assert.equal(subtitle.title,'检查论证与证据');
  const css=await rules(), declarations=cssRule(css,'.detail-subtitle');
  assert.match(declarations,/white-space:\s*nowrap/); assert.match(declarations,/overflow:\s*hidden/);
  assert.match(declarations,/text-overflow:\s*ellipsis/);
  assert.match(cssRule(css,'.detail-heading-copy'),/min-width:\s*0/);
  assert.match(cssRule(css,'.detail-heading-copy'),/flex:\s*1/);
});

test('threepane T2-4: history uses first-member avatars and shared labels/tones, keeping action identifiers raw', async t => {
  const {doc,app}=await fixture(t), value=app.snapshot(), events=[];
  const ctx={doc,refs:{},state:value.state,actions:{...app.actions,
    selectHistory:(type,id)=>events.push(['select',type,id]),
    rerun:(type,id)=>events.push(['rerun',type,id]),
    resumeHistory:(type,id)=>events.push(['resume',type,id])}};
  ctx.root=threepane.render(ctx);
  const items=['ok','fail','running','pending'].map((tone,i)=>({...record(`record-${i}`,true),
    type:i===0?'launch':'joint', cli:'codex', cliLabel:'Claude', mode:'agent', modeLabel:'直接',
    source:'recommend',sourceLabel:'AI 推荐',status:{overall:'pending'},statusTone:tone}));
  // Deliberately differing labels/tones prove the shared presentation fields win.
  for (const item of items) {
    threepane.renderHistory(ctx,{...value.history,items,selected:item,selectedId:`${item.type}:${item.id}`});
    const list=ctx.refs['history-list'],detail=ctx.refs['history-detail'];
    for (const [i,row] of list.children.entries()) {
      assert.equal(row.querySelector('.avatar').textContent,'W');
      assert.equal(row.querySelector('.avatar').style.getPropertyValue('background'),avatarColor('Walvo'));
      assert.equal(row.querySelector('.history-status-chip').getAttribute('data-tone'),items[i].statusTone);
      assert.match(row.querySelector('.row-subtitle').textContent,/ · Claude$/);
    }
    assert.doesNotMatch(list.textContent,/○|codex/);
    assert.equal(detail.querySelector('.detail-chip').getAttribute('data-tone'),item.statusTone);
    assert.match(detail.textContent,/模式：直接 · 来源：AI 推荐/); assert.match(detail.textContent,/ · Claude/);
    assert.doesNotMatch(detail.textContent,/模式：agent|来源：recommend|codex/);
  }
  await ctx.refs['history-list'].children[0].querySelector('button').fire('click');
  const buttons=ctx.refs['history-detail'].querySelectorAll('button');
  await buttons[0].fire('click'); await buttons[1].fire('click');
  assert.deepEqual(events,[['select','launch','record-0'],['rerun','joint','record-3'],['resume','joint','record-3']]);
});

test('threepane T2-4: pre-S2 history falls back to raw metadata, capitalized CLI and safe status colors', async t => {
  const {doc,app}=await fixture(t), value=app.snapshot(),ctx={doc,refs:{},state:value.state,actions:app.actions};
  ctx.root=threepane.render(ctx);
  for (const [overall,tone] of [['failed','fail'],['done','ok'],['running','running'],['pending','pending'],['future-status','pending']]) {
    const item={...record('legacy',false),type:'launch',mode:'relay',source:'manual',status:{overall},resumeOf:'original'};
    threepane.renderHistory(ctx,{...value.history,items:[item],selected:item});
    assert.match(ctx.refs['history-list'].querySelector('.row-subtitle').textContent,/单次 · Codex$/);
    assert.match(ctx.refs['history-detail'].textContent,/模式：relay · 来源：manual · 恢复自 original/);
    for (const chip of [ctx.refs['history-list'].querySelector('.history-status-chip'),ctx.refs['history-detail'].querySelector('.detail-chip')]) {
      assert.equal(chip.getAttribute('data-tone'),tone);
    }
  }
  const item={...record('empty-members',false),agents:[],cli:'claude',statusTone:'invalid',mode:null,source:null};
  threepane.renderHistory(ctx,{...value.history,items:[item],selected:item});
  assert.match(ctx.refs['history-list'].textContent,/Claude/); assert.doesNotMatch(ctx.refs['history-list'].textContent,/○/);
  assert.match(ctx.refs['history-detail'].textContent,/模式：未声明 · 来源：未声明/);
  assert.equal(ctx.refs['history-list'].querySelector('.history-status-chip').getAttribute('data-tone'),'ok');
});

test('threepane T2-4: history tone palettes match the contract for both list and detail badges', async () => {
  const css=await rules();
  for (const [tone,background,color] of [['fail','#fce8e6','#c5221f'],['ok','#e6f4ea','#137333'],['running','#e8f0fe','#0b57d0'],['pending','#eef1f4','#59636e']]) {
    for (const cls of ['.history-status-chip','.detail-chip']) {
      const declarations=cssRule(css,`${cls}[data-tone=${tone}]`);
      assert.match(declarations,new RegExp(`background:\\s*${background}`),`${cls} ${tone}`);
      assert.match(declarations,new RegExp(`color:\\s*${color}`),`${cls} ${tone}`);
    }
  }
});
