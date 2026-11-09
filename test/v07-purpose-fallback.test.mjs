import test from 'node:test';
import assert from 'node:assert/strict';
import { mountApp } from '../public/app.js';
import { summary } from '../public/display.js';
import { appDocument } from './fixtures/app.mjs';

const description = 'Registry purpose describes the role.\n\nSecond paragraph is not a short purpose.\n<example>user: hidden trigger</example>';
for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) {
  test(`${ui}: missing role purpose falls back only in display, including recommendations`, async t => {
    const {doc, ids} = await appDocument(ui);
    const agents = [
      {id:'peter', name:'Peter', purpose:null},
      {id:'jack', name:'-jack', purpose:'Registry-authored purpose'},
    ].map(a => ({...a, kind:'role', primary:'功能性 Agent', description, tags:[], permissions:{},
      platforms:{claude:{available:true},codex:{available:true}}}));
    const registry = {agents, categories:[], summary:{roles:2,books:0,inScope:2}, sources:[], outOfScope:[], conflicts:[], missingFromDisk:[]};
    const app = await mountApp(doc, async url => {
      const value = url === '/api/registry' ? registry : url === '/api/settings' ? {ui,recommend:{}} :
        url === '/api/stats' ? {sources:[],perAgent:{},limitedReasons:[]} :
        url === '/api/recommend' ? {recommendId:'fixture'} :
        url === '/api/recommend/fixture' ? {status:'done',results:agents.map(a => ({id:a.id,reason:'模型理由',purpose:'模型伪造用途'})),audit:{ok:true,agentCalls:0,children:0}} :
        {items:[],unavailable:[]};
      return {ok:true,json:async () => value};
    }, {confirm:async () => true});
    t.after(() => app.dispose());
    const expected = [summary(description), agents[1].purpose];
    app.actions.selectCategory('role');
    const subtitles = ui === 'shelf' ? ids.cards.querySelectorAll('.staff-badge').map(n => n.children[2]) :
      ids.cards.querySelectorAll(ui === 'bento' ? '.agent-subtitle' : '.row-subtitle');
    assert.deepEqual(subtitles.map(n => n.textContent), ui === 'shelf' ? [...expected].reverse() : expected);
    app.actions.showView('recommend'); app.actions.setRecommendInput('核对角色用途'); await app.actions.recommend();
    const results = ids['recommend-results'];
    const resultSubtitles = ui === 'shelf' ? results.querySelectorAll('.recommend-card').map(n => n.children[1]) :
      results.querySelectorAll(ui === 'bento' ? '.agent-subtitle' : '.row-subtitle');
    assert.deepEqual(resultSubtitles.map(n => n.textContent),expected);
    for (const text of expected) assert.ok(results.textContent.includes(text), `${ui} missing ${text}`);
    assert.doesNotMatch(results.textContent, /Second paragraph|hidden trigger|模型伪造用途/);
    const model = app.snapshot();
    assert.equal(model.recommend.results[0].purpose,null);
    assert.equal(model.state.allAgents[0].purpose,null);
    assert.equal(agents[0].purpose,null);
    assert.equal(model.recommend.results[1].purpose,agents[1].purpose);
    app.actions.openJoint(['peter']);
    assert.ok(ids['builder-selected'].textContent.includes(expected[0]));
    const row = ids['builder-results'].querySelectorAll('.builder-row')[0];
    assert.ok(row.textContent.includes(expected[0]));
  });
}
