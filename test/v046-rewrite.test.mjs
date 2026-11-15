import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { createChats } from '../src/chat/index.mjs';
import { runRewrite, rewritePrompt, rewriteSchema, validateRewrites, conceptMapFile } from '../src/chat/rewrite.mjs';
import { mountApp } from '../public/app.js';

// v0.46 按书改写 (2026-11-04): on request, one Codex call drafts a question per book; the user edits them before sending.
const agent = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent', purpose: kind === 'role' ? '协调' : null,
  book: kind === 'book' ? { title: `《${id} Book》`, author: `${id} Author`, blurb: `${id} 的简介` } : null, description: '说明', tags: [], permissions: {}, sync: { state: '同步' },
  sources: { checked: true, missing: [] }, platforms: { claude: { available: true, name: id }, codex: { available: true } } });
const agents = () => [agent('eliora'), agent('farvo'), agent('ark', 'role')];
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('等待超时'); };
const drafts = { items: [
  { id: 'eliora', fit: true, angle: '从探索式测试的章程出发', question: '用探索式测试的章程，Mod 该怎么做、怎么验证？' },
  { id: 'farvo', fit: false, angle: '书里没有游戏 Mod 的内容', question: '模型写的别的话' }] };

test('v046 rewrite: the prompt carries the question and each concept map; validation keeps the original for an unfit book', async () => {
  const config = { readingAgentsDir: 'D:\\work\\Reading\\.claude\\agents' };
  assert.equal(path.win32.normalize(conceptMapFile(config, 'eliora')), 'D:\\work\\Reading\\book-agents\\eliora-knowledge\\concept-map.md');
  const reads = [], calls = [];
  const result = await runRewrite('Mod 怎么做？', [agent('eliora'), agent('farvo')], config, {
    readFile: async file => { reads.push(file); if (file.includes('farvo')) throw Object.assign(new Error('缺'), { code: 'ENOENT' }); return '# K1 探索式测试\n' + '长'.repeat(7000); },
    runner: async (job, cfg) => { calls.push({ job, cfg }); return drafts; } });
  assert.equal(reads.length, 2);
  const { job } = calls[0];
  assert.equal(job.namespace, 'chat-rewrites'); assert.equal(job.label, '按书改写'); assert.equal(job.timeoutMs, 300000); assert.deepEqual(job.schema, rewriteSchema);
  assert.match(job.prompt, /不使用工具，不调用或派生 Agent，不写文件/); assert.match(job.prompt, /不要硬套/); assert.match(job.prompt, /"Mod 怎么做？"/);
  assert.match(job.prompt, /K1 探索式测试/); assert.ok(!job.prompt.includes('长'.repeat(6001)), 'a concept map is cut at 6000 characters');
  assert.match(job.prompt, /"conceptMap":""/, 'a missing concept map leaves the book with its title and blurb');
  assert.deepEqual(result.items, [
    { id: 'eliora', fit: true, angle: '从探索式测试的章程出发', question: '用探索式测试的章程，Mod 该怎么做、怎么验证？' },
    { id: 'farvo', fit: false, angle: '书里没有游戏 Mod 的内容', question: 'Mod 怎么做？' }]);
  assert.throws(() => validateRewrites({ items: [drafts.items[0]] }, ['eliora', 'farvo'], '问'), /数量/);
  assert.throws(() => validateRewrites({ items: [drafts.items[0], drafts.items[0]] }, ['eliora', 'farvo'], '问'), /重复/);
  assert.throws(() => validateRewrites({ items: [{ ...drafts.items[0], angle: '' }] }, ['eliora'], '问'), /角度或问题无效/);
  assert.equal(rewriteSchema.type, 'object', 'Codex structured output needs an object at the top level');
  assert.match(rewritePrompt('问', []), /书的角度是切入点，不是换一个问题/);
});

async function chatsFor(t, rewriteImpl = async (question, list) => ({ items: list.map(a => ({ id: a.id, fit: true, angle: `${a.id} 角度`, question: `${a.id}：${question}` })) })) {
  // After hooks run in registration order: close chats and apps before the fixture folder is removed.
  let chats; t.after(() => chats?.close());
  const { config } = await fixture(t), calls = [], registry = agents(), rewrites = [];
  chats = createChats(config, { getRegistry: () => ({ agents: registry }),
    rewriteImpl: async (...args) => { rewrites.push(args); return rewriteImpl(...args); },
    runImpl: job => { calls.push(job); return Promise.resolve({ text: '答', final: true, threadId: `T-${calls.length}` }); } });
  return { config, chats, calls, rewrites };
}
const settled = (chats, id) => until(async () => (await chats.get(id)).turns.every(turn => Object.values(turn.answers).every(a => a.status === 'done')));

test('v046 chats: only book Agents are rewritten; each book is asked its own reviewed draft, roles the original', async t => {
  const { chats, calls, rewrites } = await chatsFor(t);
  await assert.rejects(chats.rewrite({ agentIds: ['eliora', 'ark'], question: '问' }), e => e.status === 400 && /只有书籍 Agent/.test(e.message));
  await assert.rejects(chats.rewrite({ agentIds: [], question: '问' }), e => e.status === 400);
  await assert.rejects(chats.rewrite({ agentIds: ['eliora'], question: ' ' }), e => e.status === 400);
  const result = await chats.rewrite({ agentIds: ['eliora', 'farvo'], question: 'Mod 怎么做？' });
  assert.deepEqual(result.items.map(i => i.question), ['eliora：Mod 怎么做？', 'farvo：Mod 怎么做？']);
  assert.equal(rewrites[0][0], 'Mod 怎么做？'); assert.deepEqual(rewrites[0][1].map(a => a.id), ['eliora', 'farvo']);
  assert.ok(rewrites[0][3].signal instanceof AbortSignal, 'closing the app can stop a running rewrite');

  await assert.rejects(chats.start({ engine: 'codex', agentIds: ['eliora', 'ark'], question: '问', rewrites: { ark: { question: '改', angle: '' } } }), /只能给本轮所问的书籍 Agent/);
  await assert.rejects(chats.start({ engine: 'codex', agentIds: ['eliora'], question: '问', rewrites: { eliora: { question: ' ', angle: '' } } }), /1–8000 字/);
  assert.equal((await chats.list()).items.length, 0, 'a rejected draft creates no chat');
  const chat = await chats.start({ engine: 'codex', agentIds: ['eliora', 'farvo', 'ark'], question: 'Mod 怎么做？',
    rewrites: { eliora: { question: '我改过的：用章程怎么测 Mod？', angle: '从章程出发' } } });
  assert.deepEqual(chat.turns[0].rewrites, { eliora: { question: '我改过的：用章程怎么测 Mod？', angle: '从章程出发' } });
  assert.equal(chat.turns[0].question, 'Mod 怎么做？', 'the thread still shows Alex\'s own words');
  await settled(chats, chat.chatId);
  const asked = id => calls.find(c => c.prompt.includes(`「${id}」`)).prompt;
  assert.match(asked('eliora'), /我的问题：\n我改过的：用章程怎么测 Mod？$/);
  assert.match(asked('farvo'), /我的问题：\nMod 怎么做？$/); assert.match(asked('ark'), /我的问题：\nMod 怎么做？$/);
  // A follow-up to some members carries its own drafts.
  await chats.ask(chat.chatId, { question: '再问', recipients: ['farvo'], rewrites: { farvo: { question: '从持续交付看再问', angle: '持续交付' } } });
  await settled(chats, chat.chatId);
  assert.match(calls.at(-1).prompt, /从持续交付看再问$/);
  await assert.rejects(chats.ask(chat.chatId, { question: '又问', recipients: ['farvo'], rewrites: { eliora: { question: '不是收件人', angle: '' } } }), /只能给本轮所问的书籍 Agent/);
});

test('v046 chats: a failed rewrite is explained and nothing is sent', async t => {
  const { chats, calls } = await chatsFor(t, async () => { throw new Error('按书改写生成超时（300000 ms）'); });
  await assert.rejects(chats.rewrite({ agentIds: ['eliora'], question: '问' }), e => e.status === 502 && /按书改写没有成功：按书改写生成超时/.test(e.message));
  assert.equal(calls.length, 0);
});

test('v046 server: POST /api/chats/rewrite needs the launch token and answers with the drafts', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t);
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents: agents(), categories: ['学习'], summary: {}, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }),
    chatOptions: { rewriteImpl: async () => drafts, runImpl: () => Promise.resolve({ text: '答', final: true }) } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, token = app.token) => fetch(`${base}/api/chats/rewrite`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post({ agentIds: ['eliora', 'farvo'], question: '问' }, 'f'.repeat(64))).status, 403);
  const ok = await post({ agentIds: ['eliora', 'farvo'], question: '问' });
  assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).items, drafts.items);
  assert.equal((await post({ agentIds: ['ark'], question: '问' })).status, 400);
  assert.equal((await fetch(`${base}/api/chats/rewrite`)).status, 404);
});

// Page: the button appears only with book recipients; the drafts can be edited, cancelled, and go out with 发送.
const registry = { agents: agents(), categories: ['学习'], summary: { roles: 1, books: 2 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
async function mounted(t, { rewrite = { items: drafts.items.map(i => ({ ...i, question: i.fit ? i.question : '书里怎么说？' })) } } = {}) {
  const { doc } = await appDocument('threepane'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const requests = [];
  const chat = body => ({ version: 1, chatId: 'c0000000-0000-4000-8000-000000000046', kind: 'joint', engine: 'codex', agentIds: ['eliora', 'farvo', 'ark'], groupId: null, title: '问',
    createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z', members: { eliora: { name: 'eliora' }, farvo: { name: 'farvo' }, ark: { name: 'ark' } },
    turns: [{ turnId: 't1', question: body?.question || '书里怎么说？', askedAt: '2026-11-04T10:00:00Z', recipients: ['eliora', 'farvo', 'ark'], ...(body?.rewrites ? { rewrites: body.rewrites } : {}),
      answers: Object.fromEntries(['eliora', 'farvo', 'ark'].map(id => [id, { status: 'done', text: '答', startedAt: '2026-11-04T10:00:00Z', endedAt: '2026-11-04T10:00:30Z', error: null }])) }] });
  let created = null;
  const app = await mountApp(doc, async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, method, body });
    if (url === '/api/chats' && method === 'POST') created = chat(body);
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'threepane', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} }
      : url === '/api/chats/rewrite' ? rewrite : url === '/api/chats' && method === 'POST' ? created : url === '/api/chats' ? { items: [] }
      : url.startsWith('/api/chats/') ? created : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, requests };
}

test('v046 chat page: 按书改写 drafts per book, editable, cancelled by changing the question, and sent with 发送', async t => {
  const { doc, app, requests } = await mounted(t);
  await app.actions.startChat({ agentIds: ['ark'], engine: 'codex' });
  assert.equal(doc.getElementById('chat-rewrite').hidden, true, 'a role Agent alone has nothing to rewrite');
  await app.actions.startChat({ agentIds: ['eliora', 'farvo', 'ark'], engine: 'codex' });
  const button = doc.getElementById('chat-rewrite'), input = doc.getElementById('chat-input'), panel = doc.querySelector('.chat-rewrites');
  assert.equal(button.hidden, false); assert.equal(button.disabled, true); assert.equal(panel.hidden, true);
  input.value = '书里怎么说？'; await input.fire('input');
  assert.equal(button.disabled, false);
  await button.fire('click');
  assert.deepEqual(requests.find(r => r.url === '/api/chats/rewrite').body, { agentIds: ['eliora', 'farvo'], question: '书里怎么说？' });
  assert.equal(panel.hidden, false); assert.equal(button.textContent, '重新改写'); assert.equal(doc.getElementById('chat-send').textContent, '按改写发送');
  const rows = panel.querySelectorAll('.chat-rewrite-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector('.chat-rewrite-angle').textContent, /^eliora · 从探索式测试的章程出发$/);
  assert.match(rows[1].className, /is-unfit/); assert.match(rows[1].textContent, /书里没有合适的角度，按原问题发/); assert.equal(rows[1].querySelector('textarea'), null);
  const box = doc.getElementById('chat-rewrite-eliora'); assert.equal(box.value, drafts.items[0].question);
  box.value = '我自己改的问题'; await box.fire('input');
  await doc.getElementById('chat-send').fire('click');
  const sent = requests.find(r => r.url === '/api/chats' && r.method === 'POST').body;
  assert.deepEqual(sent.rewrites, { eliora: { question: '我自己改的问题', angle: '从探索式测试的章程出发' }, farvo: { question: '书里怎么说？', angle: '书里没有游戏 Mod 的内容' } });
  assert.equal(sent.question, '书里怎么说？');
  assert.equal(panel.hidden, true, 'the drafts are used once');
  const asked = doc.querySelectorAll('.chat-rewrite-asked');
  assert.equal(asked.length, 2, 'each rewritten sheet shows the question its book received');
  assert.match(asked[0].querySelector('summary').textContent, /^按书改写：从探索式测试的章程出发$/);
  assert.equal(asked[0].querySelector('p').textContent, '我自己改的问题');

  // A changed question voids the drafts; 取消改写 drops them too.
  input.value = '新问题'; await input.fire('input');
  await button.fire('click'); assert.equal(panel.hidden, false);
  input.value = '新问题，改一下'; await input.fire('input');
  assert.equal(panel.hidden, true); assert.match(doc.querySelector('.chat-notice').textContent, /改写稿已作废/);
  await button.fire('click'); await doc.getElementById('chat-rewrite-clear').fire('click');
  assert.equal(panel.hidden, true); assert.equal(doc.getElementById('chat-send').textContent, '发送');
  const css = await fs.readFile('public/styles.css', 'utf8');
  assert.match(css, /\.chat-rewrites \{ display:flex; flex-direction:column;/); assert.match(css, /\.chat-rewrite-asked p \{/);
});
