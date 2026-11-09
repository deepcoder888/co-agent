import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';

// v0.47 (2026-11-07): several consults run at once (three at most), and a new one can be opened from the
// toolbar of the consult on screen, not only from the left column's 会诊记录.
const agent = id => ({ id, name: id, kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: `《${id}》`, author: id },
  platforms: { codex: { available: true, name: `cx-${id}` }, claude: { available: true, name: id } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const catalog = ['walvo', 'jadra', 'liebo'].map(agent);
const registry = { agents: catalog, categories: ['学习'], summary: { books: 3, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const running = { consultId: 'k1', status: 'running', situation: '要不要换工作', createdAt: '2026-11-07T10:00:00Z', startedAt: '2026-11-07T10:00:01Z', catalog, mode: 'auto', result: null };

async function mounted(t, { active = 1 } = {}) {
  const { doc } = await appDocument('threepane'), posts = [];
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const front = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; let value = { items: [], unavailable: [] };
    if (url === '/api/registry') value = registry; else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/settings') value = { ui: 'threepane', recommend: {} };
    else if (url === '/api/consults' && body) { posts.push(body); value = { consultId: 'k2' }; }
    else if (url === '/api/consults?limit=30') value = { items: [running], running: { consultId: 'k1', status: 'running' }, active: posts.length ? active + 1 : active, parallel: 3 };
    else if (url === '/api/consults/k1') value = running;
    else if (url === '/api/consults/k2') value = { ...running, consultId: 'k2', situation: posts[0]?.situation };
    else if (url === '/api/councils') value = { items: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose());
  await front.actions.openRoom('consults');
  return { doc, front, posts };
}

test('v047 consult room: with one consult running, 「＋ 新开一次会诊」 in the toolbar opens a fresh sheet that can start', async t => {
  const { doc, front, posts } = await mounted(t);
  const another = doc.getElementById('room-consults-new-main');
  assert.ok(another, 'the toolbar of the consult on screen offers a new one'); assert.ok(!another.disabled);
  assert.equal(doc.getElementById('room-consults-rerun').disabled, true, 'a running consult still cannot be rerun');
  await another.fire('click');
  const situation = doc.getElementById('room-consults-situation'), start = doc.getElementById('room-consults-start');
  assert.ok(situation && !situation.closest('[hidden]'), 'the opening sheet is shown');
  situation.value = '要不要读研'; await situation.fire('input');
  assert.equal(start.disabled, false); assert.equal(start.textContent, '开始会诊（另有 1 场在进行）');
  await start.fire('click');
  assert.deepEqual(posts.map(p => p.situation), ['要不要读研']);
  assert.equal(front.snapshot().chat.consults.active, 2, 'the new consult counts as running');
});

test('v047 consult room: at the limit the start button waits and says how many are running', async t => {
  const { doc } = await mounted(t, { active: 3 });
  await doc.getElementById('room-consults-new-main').fire('click');
  const situation = doc.getElementById('room-consults-situation'), start = doc.getElementById('room-consults-start');
  situation.value = '要不要读研'; await situation.fire('input');
  assert.equal(start.disabled, true); assert.equal(start.textContent, '已有 3 场会诊在进行');
});
