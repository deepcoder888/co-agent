import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';

const names = ['Walvo', 'Jadra', 'Rusko', 'Peter', 'A', 'B', 'C', 'D', 'E'];
const agents = names.map((name, index) => ({ id: name.toLowerCase(), name, kind: index === 3 ? 'role' : 'book', primary: '健康', description: '描述', tags: [],
  book: { title: `书 ${name}`, author: `作者 ${name}`, edition: '2026' }, permissions: {}, sources: { checked: true, missing: [], total: 1 },
  platforms: { claude: { available: true }, codex: { available: true } } }));
const tick = () => new Promise(r => setImmediate(r));
async function appFixture(t, ui = 'threepane') {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="test-token">');
  const doc = documentFrom(html); doc.documentElement.setAttribute('data-ui', ui);
  const registry = { agents, categories: ['健康'], summary: { roles: 1, books: 8, inScope: 9, synced: 9, outOfScope: 0, failed: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  const calls = [], confirmations = []; let approved = true;
  const history = { items: [{ type: 'joint', id: 'original', createdAt: '2026-10-06T16:00:00Z', cli: 'codex', agents: [{ id: 'walvo', name: 'Walvo' }], mode: 'joint', source: 'manual', inputPreview: '<script>任务', status: { overall: 'done' }, canResume: true }] };
  const app = await mountApp(doc, async (url, options) => {
    calls.push({ url, options });
    let value = url === '/api/settings' ? { ui: options ? JSON.parse(options.body).ui : ui, recommend: { claude: { model: 'sonnet', effort: '未声明' }, codex: { model: 'gpt-test', effort: 'xhigh' } } } :
      url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } :
      url.startsWith('/api/history?') ? history : url.startsWith('/api/history/') ? { items: [], unavailable: [] } :
      url === '/api/joint' ? { jointId: 'new' } : { items: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async text => { confirmations.push(text); return approved; } });
  t.after(() => app.dispose());
  const find = (text, root = doc.documentElement) => descendants(root).find(n => n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === text || n.textContent === text));
  return { doc, app, calls, confirmations, find, approve: value => { approved = value; } };
}
for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v07 ${ui} distinct structure, all feature entries, detail/launch/resume and builder accessible`, async t => {
  const h = await appFixture(t, ui), { doc, find } = h;
  assert.ok(doc.querySelector(`.layout-${ui}`));
  for (const label of ['新建联合调用', 'AI 推荐', '历史调用', '运行中的会话', '扫描摘要和数据覆盖', '打开设置']) assert.ok(find(label), `${ui}: ${label}`);
  assert.ok(doc.getElementById('navigation')); assert.ok(doc.getElementById('search'));
  doc.getElementById('search').value = 'Walvo'; await doc.getElementById('search').fire('input');
  const detail = find('查看 Walvo 详情'); assert.ok(detail); await detail.fire('click'); await tick();
  assert.ok(doc.getElementById('detail-body').textContent.includes('书 Walvo'));
  for (const label of ['在 Claude CLI 中调用 Walvo', '在 Codex CLI 中调用 Walvo', '加入联合调用 Walvo']) assert.ok(find(label));
  assert.match(doc.getElementById('detail-body').textContent, /继续上次会话/);
  await find('加入联合调用 Walvo').fire('click');
  if (ui === 'shelf') { assert.equal(doc.getElementById('detail').open, false); await find('发起联合调用').fire('click'); }
  assert.equal(doc.getElementById('joint-builder').open, true);
  assert.match(doc.getElementById('builder-selected').textContent, /Walvo/);
  assert.equal(doc.activeElement, doc.getElementById('builder-search'));
});
for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v07 ${ui} keyboard search, builder Tab/Esc, focus restoration and no hidden critical panel`, async t => {
  const { doc, find } = await appFixture(t, ui);
  await doc.fire('keydown', { key: '/', target: doc.body, preventDefault() {} }); assert.equal(doc.activeElement, doc.getElementById('search'));
  const search = doc.getElementById('search'); search.value = 'not present'; await search.fire('input');
  assert.match(doc.getElementById('cards').textContent, /没有匹配/);
  await doc.fire('keydown', { key: 'Escape', target: search }); assert.equal(search.value, '');
  await doc.fire('keydown', { key: 'k', ctrlKey: true, target: doc.body, preventDefault() {} }); assert.equal(doc.activeElement, search);
  const trigger = find('新建联合调用'); trigger.focus(); await trigger.fire('click');
  const dialog = doc.getElementById('joint-builder');
  const available = dialog.querySelectorAll('button,input,select,textarea').filter(n => !n.disabled && !n.hidden);
  available.at(-1).focus(); await dialog.fire('keydown', { key: 'Tab' }); assert.equal(doc.activeElement, available[0]);
  await dialog.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(doc.activeElement, available.at(-1));
  await dialog.fire('keydown', { key: 'Escape' }); assert.equal(dialog.open, false); assert.equal(doc.activeElement, trigger);
  for (const [name, id] of [['AI 推荐','recommend-panel'],['历史调用','history-panel'],['运行中的会话','running-panel'],['扫描摘要和数据覆盖','coverage-panel']]) {
    await find(name).fire('click'); assert.ok(doc.getElementById(id).isConnected); assert.equal(doc.getElementById(id).closest('[hidden]'), undefined, `${ui} ${name} must be visible`);
  }
});
test('v07 manual confirmations cancel safely; pending changes cannot replace approved selection or input', async t => {
  const h = await appFixture(t), { doc, find, calls } = h;
  agents[0].writable = true; agents[0].sources.missing.push('absent.epub');
  t.after(() => { agents[0].writable = false; agents[0].sources.missing = []; });
  await find('查看 Walvo 详情')?.fire('click');
  await find('新建联合调用').fire('click');
  const walvo = doc.getElementById('builder-results').querySelector('[aria-label="选择 Walvo"]'); walvo.checked = true; await walvo.fire('change');
  doc.getElementById('builder-input').value = '任务'; await doc.getElementById('builder-input').fire('input');
  h.approve(false); await doc.getElementById('builder-submit').fire('click'); assert.ok(!calls.some(c => c.url === '/api/joint'));
  h.approve(true); await doc.getElementById('builder-submit').fire('click');
  const body = JSON.parse(calls.find(c => c.url === '/api/joint').options.body);
  assert.equal(body.writableConfirmed, true); assert.equal(body.sourcesConfirmed, true); assert.equal(body.input, '任务');
  assert.ok(h.confirmations.some(s => s.includes('可写'))); assert.ok(h.confirmations.some(s => s.includes('原书路径失效')));
});
test('v07 switching layouts preserves category/Agent, search, builder state and module-owned panels without refetch/reload', async t => {
  const { doc, find, calls } = await appFixture(t);
  await find('健康（8）').fire('click');
  await find('查看 Walvo 详情').fire('click');
  doc.getElementById('recommend-input').value = '未提交的问题'; await doc.getElementById('recommend-input').fire('input');
  await find('打开设置').fire('click');
  const radios = doc.querySelectorAll('[role="radio"]');
  for (const radio of [radios[1], radios[2], radios[3], radios[0]]) {
    await radio.fire('click');
    assert.match(doc.getElementById('view-title').textContent, /健康/);
    assert.equal(doc.getElementById('detail-title').textContent, 'Walvo');
    assert.equal(doc.getElementById('recommend-input').value, '未提交的问题');
  }
  assert.equal(calls.filter(c => c.url === '/api/registry').length, 1);
  const source = await fs.readFile('public/app.js', 'utf8'); assert.doesNotMatch(source, /location\.reload/);
});
test('v07 manual builder search, eight limit, chips, counter, submit snapshot and dialog focus', async t => {
  const { doc, find, calls } = await appFixture(t);
  const trigger = find('新建联合调用'); trigger.focus(); await trigger.fire('click');
  const search = doc.getElementById('builder-search'); search.value = '作者 Walvo'; await search.fire('input');
  let checks = doc.getElementById('builder-results').querySelectorAll('input'); assert.equal(checks.length, 1); checks[0].checked = true; await checks[0].fire('change');
  search.value = ''; await search.fire('input');
  const unchecked = () => doc.getElementById('builder-results').querySelectorAll('input').find(check => !check.checked);
  for (let i = 1; i < 8; i++) { const check = unchecked(); check.checked = true; await check.fire('change'); }
  assert.equal(doc.getElementById('builder-results').querySelectorAll('input').filter(check => check.checked).length, 8);
  assert.equal(unchecked().disabled, true);
  assert.match(doc.getElementById('builder-limit').textContent, /8/);
  await find('移除 Walvo').fire('click'); assert.equal(unchecked().disabled, false);
  const input = doc.getElementById('builder-input'); input.value = '共同问题'; await input.fire('input'); assert.match(doc.getElementById('builder-count').textContent, /4 \/ 8000/);
  doc.getElementById('builder-cli').value = 'codex'; await doc.getElementById('builder-submit').fire('click');
  const posted = calls.find(c => c.url === '/api/joint'); assert.ok(posted); assert.equal(posted.options.headers['X-Co-Agent-Token'], 'test-token');
  // Checked in on-screen order: the grouped list shows staff before the category's books (v0.21).
  const picked = agents.slice(1, 8), shown = [...picked.filter(a => a.kind === 'role'), ...picked.filter(a => a.kind !== 'role')];
  assert.deepEqual(JSON.parse(posted.options.body), { source: 'manual', agentIds: shown.map(a => a.id), input: '共同问题', cli: 'codex', crossExam: false });
  assert.equal(doc.getElementById('joint-builder').open, false); assert.equal(doc.activeElement, trigger);
});
test('v07 history list literal text, Shanghai time, filter and authenticated rerun/resume', async t => {
  const { doc, find, calls } = await appFixture(t);
  await find('历史调用').fire('click');
  assert.match(doc.getElementById('history-list').textContent, /2026-10-07 00:00:00/);
  assert.match(doc.getElementById('history-list').textContent, /<script>任务/);
  assert.equal(doc.getElementById('history-list').querySelectorAll('script').length, 0);
  const row = doc.getElementById('history-list'), detail = doc.getElementById('history-detail');
  assert.equal(find('重新调用 Walvo', row), undefined);
  assert.equal(find('继续该次会话 Walvo', row), undefined);
  await find('重新调用 Walvo', detail).fire('click');
  await find('继续该次会话 Walvo', detail).fire('click');
  assert.deepEqual(JSON.parse(calls.find(c => c.url === '/api/history/rerun').options.body), { type: 'joint', id: 'original' });
  assert.deepEqual(JSON.parse(calls.find(c => c.url === '/api/resume').options.body), { type: 'joint', id: 'original' });
  const filter = doc.getElementById('history-filter'); filter.value = 'joint'; await filter.fire('change');
  assert.ok(calls.some(c => c.url === '/api/history?type=joint&limit=50'));
});

test('v07 bento has two metric tiles and editorial renders three live figures without a top-agent panel', async t => {
  const { doc, find } = await appFixture(t, 'editorial');
  const figures = () => doc.getElementById('metrics').querySelectorAll('strong').map(n => n.textContent);
  assert.deepEqual(figures(), ['暂无数据', '8', '1']);
  await find('打开设置').fire('click');
  const radios = doc.querySelectorAll('[role="radio"]');
  await radios[1].fire('click');
  assert.deepEqual(figures(), ['暂无数据', '9']);
  assert.match(doc.getElementById('metrics').textContent, /同步 9 \/ 9/);
  await radios[2].fire('click');
  assert.deepEqual(figures(), ['暂无数据', '8', '1']);
});
