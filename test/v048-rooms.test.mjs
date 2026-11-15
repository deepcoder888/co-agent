import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createConsults } from '../src/consults/index.mjs';
import { consultPrompt, consultSchema, validateConsult } from '../src/consults/runner.mjs';
import { conceptArgs } from '../src/concepts/runner.mjs';
import { mountApp } from '../public/app.js';

// v0.48 (2026-11-07): 自动选择 takes 3, 5 or 7 books; 会诊记录 opens from the toolbar; 圆桌 run in parallel too.
const ids = ['walvo', 'jadra', 'liebo', 'clemo', 'carbo', 'brovo', 'dwelo'];
const agent = id => ({ id, name: id, kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: `《${id}》`, author: id },
  platforms: { codex: { available: true, name: `cx-${id}` }, claude: { available: true, name: id } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const catalog = ids.map(agent);
const lensIds = ['risk', 'bias', 'systems', 'execution', 'money', 'health', 'people'];
const output = n => ({ situation: { summary: 's', decision: 'd' }, options: [{ id: 'A', text: '维持现状' }, { id: 'B', text: '换' }],
  lenses: ids.slice(0, n).map((id, i) => ({ lens: lensIds[i], agent: `cx-${id}`, reason: 'r' })),
  perLens: ids.slice(0, n).map((id, i) => ({ lens: lensIds[i], agent: `cx-${id}`, analysis: 'a', optionNotes: [{ option: 'A', assessment: '中性', note: 'n' }, { option: 'B', assessment: '有利', note: 'n' }] })),
  memo: { recommendation: { option: 'B', confidence: '中', rationale: 'r', basis: ids.slice(0, n).map(id => `cx-${id}`) }, risks: [{ text: 'r', basis: ['cx-walvo'] }],
    tensions: [], nextSteps: [1, 2, 3].map(() => ({ text: 'n', basis: ['cx-walvo'] })), missingInfo: [] } });

test('v048 会诊 engine: 自动选择 takes exactly 3, 5 or 7 books, the host is told the number, and the memo must match it', async t => {
  // After hooks run in registration order: close both engines before the fixture folder is removed.
  let engine, few; t.after(async () => { await engine?.close(); await few?.close(); });
  const { config } = await fixture(t), seen = [];
  engine = createConsults(config, () => ({ agents: catalog }), { runner: async r => { seen.push(r); return output(r.count); }, verifier: async () => ({ state: 'ok' }) });
  await assert.rejects(engine.start({ situation: 'x', count: 4 }), e => e.status === 400 && /3、5、7/.test(e.message));
  await assert.rejects(engine.start({ situation: 'x', count: 5, lenses: [] }), e => e.status === 400 && /指定名单时不再另选书籍数量/.test(e.message));
  const { consultId } = await engine.start({ situation: 'x', count: 7 }); await engine.idle();
  const record = await engine.get(consultId);
  assert.equal(record.count, 7); assert.equal(record.status, 'done'); assert.equal(record.result.lenses.length, 7);
  assert.match(consultPrompt(seen[0], 'Alex'), /选出恰好 7 个与 Alex 处境最相关的视角/);
  assert.match(consultPrompt({ ...seen[0], count: null }), /选出 3–5 个/, 'an old record without a count keeps the 3–5 wording');
  assert.throws(() => validateConsult(output(5), { ...seen[0] }), /无效/, 'five lenses do not satisfy a 7-book consult');
  assert.equal(consultSchema.properties.lenses.maxItems, 7); assert.equal(consultSchema.properties.perLens.maxItems, 7);
  few = createConsults(config, () => ({ agents: catalog.slice(0, 5) }), { runner: async () => output(5) });
  await assert.rejects(few.start({ situation: 'x', count: 7 }), e => e.status === 409 && /不足 7 本/.test(e.message));
});

test('v048 Codex runs for 会诊 and 圆桌 may open 8 sub-agents (the default stops at 6)', () => {
  const args = conceptArgs({ codexProfile: 'gpt', codexModel: 'm', codexEffort: 'xhigh', launchProject: 'D:\\p' }, { schema: 's', output: 'o' });
  assert.deepEqual(args.slice(args.indexOf('agents.max_threads=8') - 1, args.indexOf('agents.max_threads=8') + 1), ['-c', 'agents.max_threads=8']);
});

const registry = { agents: catalog, categories: ['学习'], summary: { books: 7, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const consult = { consultId: 'k1', status: 'done', situation: '要不要换工作\n第二行', createdAt: '2026-11-07T10:00:00Z', catalog, mode: 'auto', count: 3, result: null, error: null };
const seminar = { seminarId: 's1', status: 'done', input: '睡不好还要不要运动\n第二行', createdAt: '2026-11-07T11:00:00Z', mode: 'auto', result: null, error: null };
async function mounted(t, { seminarActive = 0, seminars = [] } = {}) {
  const { doc } = await appDocument('threepane'), requests = [];
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const front = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body }); let value = { items: [], unavailable: [] };
    if (url === '/api/registry') value = registry; else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/settings') value = { ui: 'threepane', recommend: {} };
    else if (url === '/api/consults' && body) value = { consultId: 'k1' };
    else if (url === '/api/consults?limit=30') value = { items: [consult], running: null, active: 0, parallel: 3 };
    else if (url === '/api/consults/k1') value = consult;
    else if (url === '/api/seminars?limit=30') value = { items: seminars, running: null, active: seminarActive, parallel: 3 };
    else if (url === '/api/seminars/s1') value = seminar;
    else if (url === '/api/councils') value = { items: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose());
  return { doc, front, requests };
}

test('v048 会诊 page: 3 / 5 / 7 本 follow 自动选择, picking one returns to 自动选择, and the count is sent', async t => {
  const { doc, front, requests } = await mounted(t);
  await front.actions.openRoom('consults'); await front.actions.newRoomRecord('consults');
  const chip = n => doc.getElementById(`room-consults-count-${n}`), pressed = () => [3, 5, 7].filter(n => chip(n).getAttribute('aria-pressed') === 'true');
  const modes = doc.getElementById('room-consults-auto').parentElement;
  assert.deepEqual(modes.children.map(el => el.id || el.className), ['room-consults-auto', 'room-counts', 'room-consults-explicit'], 'the numbers sit right after 自动选择');
  assert.deepEqual(pressed(), [3], '3 本 is the default');
  await chip(7).fire('click'); assert.deepEqual(pressed(), [7]);
  await doc.getElementById('room-consults-explicit').fire('click'); assert.deepEqual(pressed(), [], 'a hand-picked list has no count');
  await chip(5).fire('click'); assert.deepEqual(pressed(), [5]); assert.equal(doc.getElementById('room-consults-auto').getAttribute('aria-pressed'), 'true');
  const situation = doc.getElementById('room-consults-situation'); situation.value = '要不要读研'; await situation.fire('input');
  await doc.getElementById('room-consults-start').fire('click');
  assert.deepEqual(requests.find(r => r.url === '/api/consults' && r.body).body, { situation: '要不要读研', options: [], count: 5 });
});

test('v048 会诊 page: 会诊记录 in the toolbar lists every consult and opens one, also from a fresh sheet', async t => {
  const { doc, front, requests } = await mounted(t);
  await front.actions.openRoom('consults'); await front.actions.newRoomRecord('consults');
  const history = doc.getElementById('room-consults-history');
  assert.ok(history && !history.closest('[hidden]'), 'the menu is on screen while writing a new consult');
  assert.equal(history.querySelector('summary').textContent, '会诊记录（1）');
  const items = history.querySelectorAll('.chat-list-item'); assert.equal(items.length, 1);
  assert.match(items[0].textContent, /要不要换工作/); assert.match(items[0].textContent, /3 个视角/);
  history.open = true; const before = requests.length;
  await items[0].fire('click');
  assert.equal(history.open, false, 'choosing a consult closes the menu');
  assert.ok(requests.slice(before).some(r => r.url === '/api/consults/k1'));
  assert.equal(front.snapshot().state.roomFresh.consults, false);
});

test('v048 圆桌 page: another 圆桌 can start while one runs; at three the start button waits', async t => {
  for (const [active, disabled, note] of [[1, false, /另有 1 场圆桌在进行/], [3, true, /已有 3 场圆桌在进行，等其中一场结束再开/]]) {
    const { doc, front } = await mounted(t, { seminarActive: active });
    await front.actions.openRoom('seminars'); await front.actions.newRoomRecord('seminars');
    const input = doc.getElementById('room-seminars-question');
    input.value = '睡不好还要不要运动'; await input.fire('input');
    assert.equal(!!doc.getElementById('room-seminars-start').disabled, disabled); assert.match(doc.getElementById('room-seminars-count').textContent, note);
  }
});

// v0.48.1 (2026-11-07): 圆桌 gets the same toolbar history menu as 会诊.
test('v0481 圆桌 page: 圆桌记录 in the toolbar lists every 圆桌 and opens one, also from a fresh sheet', async t => {
  const { doc, front, requests } = await mounted(t, { seminars: [seminar] });
  await front.actions.openRoom('seminars'); await front.actions.newRoomRecord('seminars');
  const history = doc.getElementById('room-seminars-history');
  assert.ok(history && !history.closest('[hidden]'), 'the menu is on screen while writing a new 圆桌');
  assert.equal(history.querySelector('summary').textContent, '圆桌记录（1）');
  const items = history.querySelectorAll('.chat-list-item'); assert.equal(items.length, 1);
  assert.match(items[0].textContent, /睡不好还要不要运动/); assert.doesNotMatch(items[0].textContent, /第二行/);
  history.open = true; const before = requests.length;
  await items[0].fire('click');
  assert.equal(history.open, false, 'choosing a 圆桌 closes the menu');
  assert.ok(requests.slice(before).some(r => r.url === '/api/seminars/s1'));
  assert.equal(front.snapshot().state.roomFresh.seminars, false);
  assert.ok(doc.getElementById('room-seminars-history'), 'the menu stays in the toolbar on an opened 圆桌');
});

test('v0481 圆桌 page: with no 圆桌 yet there is no history menu', async t => {
  const { doc, front } = await mounted(t);
  await front.actions.openRoom('seminars'); await front.actions.newRoomRecord('seminars');
  const history = doc.getElementById('room-seminars-history');
  assert.ok(!history || history.closest('[hidden]') || !history.parentElement, 'nothing to list, nothing shown');
});

// v0.48.2 (2026-11-07): 圆桌 gets the toolbar's 新开 button too, as in 会诊室.
test('v0482 圆桌 page: ＋ 新开一场圆桌 in the toolbar opens a fresh sheet from an opened 圆桌', async t => {
  const { doc, front } = await mounted(t, { seminars: [seminar], seminarActive: 3 });
  await front.actions.openRoom('seminars'); await front.actions.selectSeminar('s1');
  assert.equal(front.snapshot().state.roomFresh.seminars, false);
  const another = doc.getElementById('room-seminars-new-main');
  assert.ok(another && !another.closest('[hidden]'), 'the button is in the toolbar of an opened 圆桌');
  assert.equal(another.textContent, '＋ 新开一场圆桌'); assert.ok(!another.disabled, 'three running 圆桌 do not block writing the next one');
  await another.fire('click');
  assert.equal(front.snapshot().state.roomFresh.seminars, true);
  assert.ok(doc.getElementById('room-seminars-question'), 'the opening sheet is back');
  assert.ok(!doc.getElementById('room-seminars-new-main')?.parentElement, 'a fresh sheet needs no 新开 button');
});
