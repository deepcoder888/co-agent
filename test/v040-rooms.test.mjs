import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createChats } from '../src/chat/index.mjs';
import { roomContext, seminarContext, consultContext } from '../src/chat/origin.mjs';
import { createFollowups } from '../public/followups.js';
import { createChats as createChatController, mountChatStart } from '../public/chats.js';
import { createWorkflows } from '../public/workflows.js';
import { mountApp } from '../public/app.js';
import { rooms } from '../public/rooms-page.js';
import { layouts } from '../public/layouts/index.js';

// v0.40 (2026-11-01): 圆桌讨论, 会诊室 and 顾问团 became rooms of the chat page (ribbons, version 3), a finished
// 圆桌 or 会诊 can be followed up (追问) with the people who took part, and Codex is the default engine everywhere.
const agent = (id, extra = {}) => ({ id, name: id, kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: `《${id}》`, author: id },
  platforms: { codex: { available: true, name: `cx-${id}` }, claude: { available: true, name: id } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' }, ...extra });
const catalog = ['walvo', 'jadra', 'liebo'].map(id => agent(id));
const seminar = (extra = {}) => ({ seminarId: 's1', status: 'done', input: '睡不好的第二天，还要不要运动？\n第二行', mode: 'auto', createdAt: '2026-11-01T13:00:00Z', catalog,
  result: { terms: [], selected: catalog.map(a => ({ agent: `cx-${a.id}`, reason: '相关' })), perAgent: catalog.map(a => ({ agent: `cx-${a.id}`, analysis: `${a.id} 原文`, coverage: '直接' })),
    commonAnswer: { summary: '可以动，但降低强度', points: [{ text: '降低强度', support: ['cx-walvo', 'cx-jadra', 'cx-liebo'], strength: '全员一致' }] },
    divergences: [{ topic: '要不要补觉', positions: [{ agent: 'cx-walvo', view: '回到规律' }, { agent: 'cx-jadra', view: '别焦虑' }] }],
    actions: [{ text: '改为散步', basis: ['cx-liebo'] }] }, verify: { state: 'ok', parallel: { state: 'ok' }, violations: [] }, ...extra });
const consult = (extra = {}) => ({ consultId: 'k1', status: 'done', situation: '要不要换工作', createdAt: '2026-11-01T13:00:00Z', catalog,
  result: { situation: { summary: '换工作去读研', decision: '换还是不换' }, options: [{ id: 'A', text: '换' }, { id: 'B', text: '不换' }],
    lenses: [{ lens: 'risk', agent: 'cx-walvo', reason: 'r' }, { lens: 'money', agent: 'cx-jadra', reason: 'r' }, { lens: 'meaning', agent: 'cx-liebo', reason: 'r' }],
    perLens: [], memo: { recommendation: { option: 'A', confidence: '中', rationale: '先试一年', basis: ['cx-walvo'] }, risks: [{ text: '收入下降', basis: ['cx-jadra'] }],
      tensions: [], nextSteps: [{ text: '问三位读研的人', basis: ['cx-walvo'] }], missingInfo: ['存款能撑多久'] } }, ...extra });
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('等待超时'); };

test('v040 backend: the synthesis becomes background text naming the question, consensus, divergences and actions', () => {
  const s = seminarContext(seminar());
  assert.deepEqual(s.agentIds, ['walvo', 'jadra', 'liebo']); assert.equal(s.title, '睡不好的第二天，还要不要运动？');
  for (const text of ['【背景：CO-AGENT 圆桌讨论】', '问题：睡不好的第二天', '共同答案：可以动，但降低强度', '- 降低强度（全员一致', '要不要补觉：cx-walvo：回到规律', '1. 改为散步（依据：cx-liebo）', '依据仍以你的书为准']) assert.ok(s.context.includes(text), text);
  assert.ok(s.context.endsWith('追问：'));
  // v0.53.13: the 原文回查 fields of newer records leave the follow-up background unchanged.
  const checked = seminar(), r = checked.result, quote = '原文里的一句话';
  r.commonAnswer.points[0].evidence = r.commonAnswer.points[0].support.map(agent => ({ agent, quote, verified: true }));
  r.divergences[0].positions = r.divergences[0].positions.map(p => ({ ...p, quote, verified: false }));
  r.actions[0].evidence = [{ agent: 'cx-liebo', quote, verified: false }]; r.sourceCheck = { total: 6, unverified: 3 };
  assert.equal(seminarContext(checked).context, s.context);
  // v0.53.13: 各书独有 goes into the background, between the participants and the common answer.
  r.unique = [{ agent: 'cx-walvo', insight: '独有一', quote, verified: true }, { agent: 'cx-jadra', insight: '独有二', quote, verified: false }, { agent: 'cx-liebo', insight: '独有三', quote, verified: true }];
  assert.ok(seminarContext(checked).context.includes('参加者：cx-walvo、cx-jadra、cx-liebo\n各书独有：\n- cx-walvo：独有一\n- cx-jadra：独有二\n- cx-liebo：独有三\n共同答案：'));
  const c = consultContext(consult());
  assert.deepEqual(c.agentIds, ['walvo', 'jadra', 'liebo']);
  for (const text of ['【背景：CO-AGENT 会诊】', '处境：换工作去读研', 'A. 换', '推荐 A（把握程度：中）：先试一年', '- 收入下降', '- 问三位读研的人', '会改变结论的信息：存款能撑多久', '不构成医疗、法律、心理或投资建议']) assert.ok(c.context.includes(text), text);
  assert.throws(() => seminarContext(seminar({ catalog: catalog.slice(0, 2) })), { status: 409 });
});

test('v040 backend: roomContext accepts only a finished 圆桌 or 会诊 and reads it from its own service', async () => {
  const services = { seminars: { get: async id => id === 's1' ? seminar() : seminar({ status: 'running', result: null }) }, consults: { get: async () => consult() } };
  assert.equal((await roomContext({ room: 'seminars', id: 's1' }, services)).agentIds.length, 3);
  assert.match((await roomContext({ room: 'consults', id: 'k1' }, services)).context, /会诊/);
  await assert.rejects(roomContext({ room: 'seminars', id: 's2' }, services), { status: 409, message: '这场圆桌还没有完成' });
  for (const bad of [null, {}, { room: 'councils', id: 'x' }, { room: 'seminars', id: 1 }]) await assert.rejects(roomContext(bad, services), { status: 400 });
});

test('v040 backend: a follow-up chat is Codex-only, takes its members from the record and sends the background once per member', async t => {
  // After hooks run in registration order: close the chats before the fixture folder is removed.
  let chats; t.after(() => chats?.close());
  const { config } = await fixture(t), calls = [], registry = { agents: catalog };
  chats = createChats(config, { getRegistry: () => registry, contextFor: origin => roomContext(origin, { seminars: { get: async () => seminar() }, consults: { get: async () => consult() } }),
    runImpl: job => { calls.push(job); return Promise.resolve({ text: '答', final: true, threadId: `t-${calls.length}` }); } });
  const chat = await chats.start({ origin: { room: 'seminars', id: 's1' }, engine: 'claude', agentIds: ['walvo'], question: '那周末呢？' });
  assert.equal(chat.engine, 'codex', 'rooms run on Codex whatever the page sends'); assert.deepEqual(chat.agentIds, ['walvo', 'jadra', 'liebo']);
  assert.deepEqual(chat.origin, { room: 'seminars', id: 's1' }); assert.equal(chat.title, '睡不好的第二天，还要不要运动？');
  await until(async () => { const turn = (await chats.get(chat.chatId)).turns[0]; return turn.recipients.every(id => turn.answers[id].status === 'done'); });
  assert.equal(calls.length, 3); for (const call of calls) { assert.match(call.prompt, /【背景：CO-AGENT 圆桌讨论】[\s\S]*追问：\n那周末呢？/); assert.ok(call.args.includes('exec')); }
  assert.deepEqual((await chats.list()).items[0].origin, { room: 'seminars', id: 's1' });
  await chats.ask(chat.chatId, { question: '再具体一点', recipients: ['jadra'] });
  await until(() => calls.length === 4);
  assert.doesNotMatch(calls[3].prompt, /【背景/, 'a resumed member already has the background'); assert.match(calls[3].prompt, /再具体一点/);
  await assert.rejects(chats.start({ origin: { room: 'nope', id: 'x' }, question: 'q' }), { status: 400 });
  const plain = await chats.start({ engine: 'codex', agentIds: ['walvo'], question: '普通对话' });
  assert.equal(plain.origin, undefined); assert.equal((await chats.list()).items.find(i => i.chatId === plain.chatId).origin, null);
});

test('v040 follow-up controller: target is idempotent, finds the record\'s chat, starts it with the origin and continues it', async () => {
  const requests = [], chat = { chatId: 'c1', engine: 'codex', agentIds: ['walvo', 'jadra'], origin: { room: 'seminars', id: 's1' },
    turns: [{ turnId: 't1', question: '先问', recipients: ['walvo', 'jadra'], answers: { walvo: { status: 'done', text: 'a' }, jadra: { status: 'done', text: 'b' } } }] };
  let items = [];
  const api = async (url, body) => { requests.push([url, body]); if (url === '/api/chats' && !body) return { items }; if (url === '/api/chats' && body) return { ...chat, chatId: 'c2' }; return chat; };
  const f = createFollowups({ api, getRegistry: () => ({ agents: catalog }), confirm: async () => true, setTimer: () => 0, clearTimer: () => {} });
  f.target({ room: 'seminars', id: 's1' }, ['walvo', 'jadra']); f.target({ room: 'seminars', id: 's1' }, ['walvo', 'jadra']);
  await until(() => !f.snapshot().loading);
  assert.equal(requests.filter(([url]) => url === '/api/chats').length, 1, 'the same target loads once'); assert.equal(f.snapshot().chat, null);
  assert.deepEqual(f.snapshot().recipients, ['walvo', 'jadra']);
  f.setDraft('那周末呢？'); await f.send();
  assert.deepEqual(requests.at(-1), ['/api/chats', { origin: { room: 'seminars', id: 's1' }, question: '那周末呢？' }]); assert.equal(f.snapshot().chat.chatId, 'c2'); assert.equal(f.snapshot().draft, '');
  items = [{ chatId: 'c1', origin: { room: 'seminars', id: 's1' } }];
  f.target({ room: 'consults', id: 'k1' }); f.target({ room: 'seminars', id: 's1' }); await until(() => f.snapshot().chat?.chatId === 'c1');
  f.setRecipients(['jadra']); f.setDraft('只问 jadra'); await f.send();
  assert.deepEqual(requests.at(-1), ['/api/chats/c1/ask', { question: '只问 jadra', recipients: ['jadra'] }]);
  f.target(null); assert.equal(f.snapshot().origin, null); f.dispose();
});

test('v040 in-app 对话 lists leave follow-ups to their rooms', async () => {
  const items = [{ chatId: 'a', agentIds: ['walvo'], engine: 'codex', title: '普通' }, { chatId: 'b', agentIds: ['walvo'], engine: 'codex', title: '追问', origin: { room: 'seminars', id: 's1' } }];
  const c = createChatController({ api: async url => url === '/api/chats' ? { items } : items[0], getRegistry: () => ({ agents: catalog }), confirm: async () => true, setTimer: () => 0, clearTimer: () => {} });
  await c.start({ agentIds: ['walvo'], engine: 'codex' });
  assert.deepEqual(c.snapshot().related.map(i => i.chatId), ['a']); assert.equal(c.snapshot().others.length, 0); c.dispose();
});

test('v040 Codex is the default engine everywhere; Claude only when chosen', async () => {
  const w = createWorkflows({ api: async () => ({ items: [] }), confirm: async () => true, error() {}, permissionText: () => '', getRegistry: () => ({ agents: catalog }) });
  assert.equal(w.snapshot().engine, 'codex'); assert.equal(w.snapshot().cli, 'codex'); w.dispose();
  const c = createChatController({ api: async () => ({ items: [] }), getRegistry: () => ({ agents: catalog }), confirm: async () => true, setTimer: () => 0, clearTimer: () => {} });
  assert.equal(c.snapshot().engine, 'codex'); c.dispose();
  const { doc } = await appDocument();
  const started = [], dialog = mountChatStart(doc, { getRegistry: () => ({ agents: catalog }), onStart: o => started.push(o) });
  dialog.open('walvo'); assert.deepEqual(doc.getElementById('chat-start').querySelector('.chat-start-engines').children.map(b => b.id), ['chat-start-codex', 'chat-start-claude']);
  dialog.dispose();
  const html = await fs.readFile('public/index.html', 'utf8');
  assert.match(html, /<select id="builder-cli"><option value="codex">Codex<\/option><option value="claude">Claude<\/option>/);
  assert.match(await fs.readFile('public/groups.js', 'utf8'), /\[\['codex', 'Codex'\], \['claude', 'Claude'\]\]/);
  assert.match(await fs.readFile('public/layouts/threepane.js', 'utf8'), /launch\.className=cli==='codex'\?'primary-button'/);
});

const registry = { agents: catalog, categories: ['学习'], summary: { books: 3, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
async function app(t, ui = 'threepane', data = {}) {
  const { doc } = await appDocument(ui), requests = [];
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const state = { chats: [], ...data };
  const front = await mountApp(doc, async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, body }); let value = { items: [], unavailable: [] };
    if (url === '/api/registry') value = registry; else if (url === '/api/stats') value = { perAgent: {}, sources: [], limitedReasons: [] };
    else if (url === '/api/settings') value = { ui, recommend: {} };
    else if (url === '/api/seminars?limit=30') value = { items: [seminar()], running: null }; else if (url === '/api/seminars/s1') value = seminar();
    else if (url === '/api/consults?limit=30') value = { items: [consult()], running: null }; else if (url === '/api/consults/k1') value = consult();
    else if (url === '/api/councils') value = { items: [] };
    else if (url === '/api/chats' && !body) value = { items: state.chats };
    else if (url === '/api/chats' && body) value = { chatId: 'f1', engine: 'codex', agentIds: ['walvo', 'jadra', 'liebo'], origin: body.origin, title: 't',
      turns: [{ turnId: 'u1', question: body.question, recipients: ['walvo', 'jadra', 'liebo'], answers: Object.fromEntries(['walvo', 'jadra', 'liebo'].map(id => [id, { status: 'done', text: `${id} 的追问回答`, startedAt: '2026-11-01T13:00:00Z', endedAt: '2026-11-01T13:00:09Z' }])) }] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose()); return { doc, front, requests };
}

test('v040 ribbons: four rooms hang from the left column in every layout, follow the room and stay in the folded rail', async t => {
  assert.deepEqual(rooms.map(r => r[1]), ['对话', '圆桌', '会诊', '顾问团']);
  for (const ui of Object.keys(layouts)) {
    const h = await app(t, ui), ribbon = key => h.doc.getElementById(`chat-room-${key}`);
    await h.front.actions.openRoom('seminars');
    assert.equal(h.front.snapshot().state.view, 'chat'); assert.equal(h.front.snapshot().state.room, 'seminars');
    const nav = ribbon('chat').parentElement; assert.equal(nav.getAttribute('aria-label'), '房间'); assert.equal(nav.parentElement.className, 'chat-side');
    assert.equal(nav.parentElement.children[0], nav, 'the ribbons sit at the very top of the left column');
    assert.deepEqual(nav.children.map(b => b.textContent), ['对话', '圆桌', '会诊', '顾问团']);
    assert.equal(ribbon('seminars').getAttribute('aria-current'), 'page'); assert.equal(ribbon('chat').getAttribute('aria-current'), null);
    assert.equal(h.doc.getElementById('chat-side-body').hidden, true, 'the 回答引擎 toggle belongs to 对话 only');
    await ribbon('consults').fire('click'); assert.equal(h.front.snapshot().state.room, 'consults'); assert.equal(ribbon('consults').getAttribute('aria-current'), 'page');
    assert.equal(h.doc.querySelector('.room-main[data-room="consults"]').hidden, false); assert.equal(h.doc.querySelector('.room-main[data-room="seminars"]').hidden, true);
    await h.doc.getElementById('chat-side-toggle').fire('click');
    assert.equal(h.doc.getElementById('chat-panel').getAttribute('data-side'), 'folded'); assert.equal(h.doc.getElementById('room-side-consults').hidden, true); assert.equal(nav.hidden, false);
    await h.doc.getElementById('chat-side-toggle').fire('click'); assert.equal(h.doc.getElementById('room-side-consults').hidden, false);
    await ribbon('chat').fire('click'); assert.equal(h.front.snapshot().state.room, 'chat'); assert.equal(h.doc.getElementById('chat-side-body').hidden, false);
    h.front.dispose();
  }
  const css = await fs.readFile('public/styles.css', 'utf8');
  assert.match(css, /\.chat-page \.room-ribbon \{[^}]*writing-mode:vertical-rl/); assert.match(css, /\.room-ribbon\[aria-current="page"\] \{[^}]*height:104px/);
});

test('v040 圆桌 and 会诊: a finished record offers 追问 to the people who took part, with the synthesis as background, and shows the answers', async t => {
  const h = await app(t);
  await h.front.actions.openSeminars(); await until(() => !h.front.snapshot().chat.follow.loading);
  const main = h.doc.querySelector('.room-main[data-room="seminars"]'), input = h.doc.getElementById('room-seminars-input');
  assert.equal(input.closest('[hidden]'), undefined); assert.match(main.textContent, /带上这份综合作为背景 · 由 Codex 回答/);
  assert.deepEqual(main.querySelector('.chat-recipients').children.map(b => b.textContent), ['全部 3 位', 'walvo', 'jadra', 'liebo']);
  input.value = '那周末呢？'; await input.fire('input'); assert.equal(h.doc.getElementById('room-seminars-send').disabled, false);
  await input.fire('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} }); await until(() => h.front.snapshot().chat.follow.chat?.chatId === 'f1');
  assert.deepEqual(h.requests.find(r => r.url === '/api/chats' && r.body).body, { origin: { room: 'seminars', id: 's1' }, question: '那周末呢？' });
  assert.equal(input.value, '', 'the composer empties after sending');
  const follow = main.querySelector('.room-follow'); assert.equal(follow.hidden, false);
  for (const id of ['walvo', 'jadra', 'liebo']) assert.ok(follow.textContent.includes(`${id} 的追问回答`), id);
  await h.front.actions.newRoomRecord('seminars'); assert.equal(input.closest('[hidden]') !== undefined, true, 'the opening sheet has no 追问');
  await h.front.actions.openConsults(); await until(() => h.front.snapshot().chat.follow.origin?.room === 'consults');
  assert.deepEqual(h.front.snapshot().chat.follow.origin, { room: 'consults', id: 'k1' });
  assert.equal(h.doc.getElementById('room-consults-input').closest('[hidden]'), undefined);
});
