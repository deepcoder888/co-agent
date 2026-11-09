import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp } from '../public/app.js';

// v0.48.4 (2026-11-08): 对话 gets the toolbar history menu and 新对话 button that the rooms have.
const agent = id => ({ id, name: id, kind: 'book', primary: '学习', tags: [], description: '说明', book: { title: `《${id}》`, author: id },
  platforms: { codex: { available: true, name: id }, claude: { available: true, name: id } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const registry = { agents: ['jadra', 'walvo'].map(agent), categories: ['学习'], summary: { roles: 0, books: 2 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const id = n => `c0000000-0000-4000-8000-00000000000${n}`;
const chat = (n, agentIds, title) => ({ version: 1, chatId: id(n), kind: 'single', engine: 'codex', agentIds, groupId: null, title,
  createdAt: '2026-11-08T10:00:00Z', updatedAt: `2026-11-08T1${n}:00:00Z`, members: Object.fromEntries(agentIds.map(a => [a, { name: a, started: true }])),
  turns: [{ turnId: 't1', question: title, askedAt: '2026-11-08T10:00:00Z', recipients: agentIds,
    answers: Object.fromEntries(agentIds.map(a => [a, { status: 'done', text: '答', startedAt: '2026-11-08T10:00:00Z', endedAt: '2026-11-08T10:00:30Z', error: null }])) }] });
const chats = [chat(3, ['jadra'], '睡前要不要看书'), chat(2, ['jadra'], '午睡多久合适'), chat(1, ['walvo'], '咖啡因的半衰期')];
const summary = c => ({ chatId: c.chatId, kind: c.kind, engine: c.engine, agentIds: c.agentIds, title: c.title, updatedAt: c.updatedAt, turns: 1, running: false, failed: false });

async function mounted(t, items) {
  const { doc } = await appDocument('threepane'), requests = [];
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const front = await mountApp(doc, async (url, opts = {}) => {
    requests.push(url);
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'threepane', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} }
      : url === '/api/chats' ? { items: items.map(summary) } : url.startsWith('/api/chats/') ? items.find(c => url.endsWith(c.chatId))
      : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose());
  return { doc, front, requests };
}

test('v0484 对话 page: 对话记录 and ＋ 新对话 in the toolbar; this book first, then the others', async t => {
  const { doc, front, requests } = await mounted(t, chats);
  await front.actions.openChats();
  assert.equal(front.snapshot().chat.selected.chatId, id(3), 'the newest conversation is open');
  const toolbar = doc.querySelector('.chat-toolbar'), history = doc.getElementById('chat-history');
  assert.equal(toolbar.hidden, false, 'a single-book conversation shows the toolbar too');
  assert.ok(history && !history.closest('[hidden]')); assert.equal(history.querySelector('summary').textContent, '对话记录（3）');
  const items = history.querySelectorAll('.chat-list-item');
  assert.deepEqual(items.map(el => el.querySelector('.chat-list-title').textContent), ['睡前要不要看书', '午睡多久合适', '咖啡因的半衰期'], 'this book first, then the others');
  assert.equal(items[0].getAttribute('aria-current'), 'page'); assert.match(items[2].textContent, /walvo/, 'another book shows its name');
  assert.equal(doc.getElementById('chat-layout-columns').parentElement.hidden, true, 'a single book needs no 并排/单列');

  const fresh = doc.getElementById('chat-new-main');
  assert.ok(fresh && !fresh.closest('[hidden]')); assert.equal(fresh.textContent, '＋ 新对话');
  await fresh.fire('click');
  assert.equal(front.snapshot().chat.selected, null); assert.deepEqual(front.snapshot().chat.pending.agentIds, ['jadra'], 'a new conversation with the same book');
  assert.equal(fresh.hidden, true, 'a new conversation needs no 新对话 button'); assert.ok(!history.closest('[hidden]'), 'history stays while writing');

  history.open = true; const before = requests.length;
  await history.querySelectorAll('.chat-list-item')[2].fire('click');
  assert.equal(history.open, false, 'choosing a conversation closes the menu');
  assert.ok(requests.slice(before).includes(`/api/chats/${id(1)}`)); assert.equal(front.snapshot().chat.selected.chatId, id(1));
});

test('v0484 对话 page: with no conversation yet there is no toolbar', async t => {
  const { doc, front } = await mounted(t, []);
  await front.actions.openChats();
  assert.equal(doc.querySelector('.chat-toolbar').hidden, true);
});
