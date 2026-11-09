import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put, fakeSpawner } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { codexArgs } from '../src/launch/codex.mjs';
import { claudeArgs } from '../src/launch/claude.mjs';
import { startBookMaker, bookMakerTask, describeBookMaker, BOOK_MAKER } from '../src/bookmaker.mjs';
import { createApp } from '../src/server.mjs';
import { mountApp } from '../public/app.js';

// v0.53 制作书籍 Agent: CO-AGENT opens an a-deepbooker session whose first message is the book; a-deepbooker is
// published with CO-AGENT, and the user sees and approves its work in the terminal.
const maker = (platforms = { codex: { available: true }, claude: { available: true, name: 'a-deepbooker' } }) => ({ id: BOOK_MAKER, name: 'a-deepbooker', platforms });

test('v0531 a launch with a task sends it as the first message and keeps the start-check marker', () => {
  const config = { launchProject: 'D:\\work\\co-agent', codexProfile: null, readyProbe: false, claudeLaunchMode: 'agent' };
  const task = bookMakerTask('D:\\Books\\书.pdf', '跳过书评');
  assert.equal(task, 'A-deepbooker，把这本书做成书籍 Agent，并输出完整报告。\n书籍文件：D:\\Books\\书.pdf\n补充要求：跳过书评');
  const codex = codexArgs('a-deepbooker', 'L1', config, task).at(-1);
  assert.ok(codex.startsWith('【CO-AGENT 启动检查 L1】')); assert.match(codex, /agent_role 为「a-deepbooker」/); assert.ok(codex.endsWith(`任务：${task}`));
  assert.doesNotMatch(codex, /READY/);
  const claude = claudeArgs('a-deepbooker', 'L2', config, 'a-deepbooker', task);
  assert.deepEqual(claude, ['--agent', 'a-deepbooker', '--session-id', 'L2', `【CO-AGENT 启动检查 L2】${task}`], 'sent even with the READY probe off');
  const relay = claudeArgs('a-deepbooker', 'L3', { ...config, claudeLaunchMode: 'relay' }, 'a-deepbooker', task);
  assert.equal(relay.at(-1), `【CO-AGENT 启动检查 L3】${task}`); assert.ok(relay.includes('--append-system-prompt'));
  assert.match(codexArgs('x', 'L4', config).at(-1), /只回复 READY/, 'ordinary launches are unchanged');
});

test('v0531 the book file, note, engine and confirmation are checked before anything starts', async t => {
  const { root } = await fixture(t);
  const book = path.join(root, '书 库', '一本书.EPUB'); await put(book, 'epub');
  const empty = path.join(root, 'empty.pdf'); await put(empty, '');
  const registry = { agents: [], outOfScope: [maker()] }, calls = [];
  const launch = async (agent, cli, config, options) => { calls.push({ agent: agent.id, cli, task: options.task }); return { launchId: 'L', cli, agentName: agent.name }; };
  const start = (body, r = registry) => startBookMaker({ cli: 'codex', writableConfirmed: true, ...body }, r, {}, { launch });
  const refused = [
    [{ file: '' }, 400, /完整路径/], [{ file: 'relative\\a.pdf' }, 400, /完整路径/], [{ file: path.join(root, 'a.txt') }, 400, /PDF|\.pdf/],
    [{ file: path.join(root, 'missing.pdf') }, 400, /找不到书籍文件/], [{ file: empty }, 400, /不是有效的书籍文件/],
    [{ file: book, note: '字'.repeat(301) }, 400, /300 字/], [{ file: book, cli: 'other' }, 400, /引擎/],
    [{ file: book, writableConfirmed: false }, 409, /请先确认/],
  ];
  for (const [body, status, message] of refused) await assert.rejects(start(body), error => error.status === status && message.test(error.message), JSON.stringify(body));
  await assert.rejects(start({ file: book }, { agents: [], outOfScope: [] }), error => error.status === 409 && /还没有 a-deepbooker/.test(error.message));
  await assert.rejects(start({ file: book, cli: 'claude' }, { agents: [], outOfScope: [maker({ codex: { available: true }, claude: { available: false } })] }),
    error => error.status === 409 && /Claude 版/.test(error.message));
  assert.equal(calls.length, 0, 'nothing was launched for a refused request');
  const result = await start({ file: `"${book}"`, note: ' 跳过\n书评\t和推荐语 ' });
  assert.equal(result.launchId, 'L');
  assert.deepEqual(calls, [{ agent: BOOK_MAKER, cli: 'codex', task: bookMakerTask(book, '跳过 书评 和推荐语') }], 'quotes and control characters are cleaned');
  assert.deepEqual(describeBookMaker(registry), { name: 'a-deepbooker', platforms: ['codex', 'claude'] });
  assert.equal(describeBookMaker({ agents: [], outOfScope: [] }), null);
});

test('v0531 HTTP: POST /api/book-maker opens the terminal session with the book as the first task', async t => {
  const { root, config } = await fixture(t);
  await put(path.join(config.codexAgentsDir, 'a-deepbooker.toml'), 'name="a-deepbooker"\ndescription="Creates a book Agent and complete Deepbooker reports"\nsandbox_mode="workspace-write"');
  const book = path.join(root, 'book.pdf'); await put(book, '%PDF');
  const calls = [];
  const app = await createApp(config, { conceptAutoDaily: false, spawnImpl: fakeSpawner(calls) });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, token = app.token) => fetch(base + '/api/book-maker', { method: 'POST', headers: { 'content-type': 'application/json', 'x-co-agent-token': token }, body: JSON.stringify(body) });
  assert.equal((await post({ file: book, writableConfirmed: true }, 'f'.repeat(64))).status, 403);
  const lists = await (await fetch(base + '/api/agent-lists')).json();
  assert.deepEqual(lists.bookMaker, { name: 'a-deepbooker', platforms: ['codex'] });
  assert.equal((await (await fetch(base + '/api/registry')).json()).candidates.some(c => c.id === BOOK_MAKER), false, 'the book maker is never offered as a book');
  const response = await post({ file: book, note: '只读正文', writableConfirmed: true });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.agentName, 'a-deepbooker'); assert.equal(result.cli, 'codex');
  const spec = JSON.parse(await fs.readFile(path.join(config.dataDir, 'launches', `${result.launchId}.json`), 'utf8'));
  assert.equal(spec.task, bookMakerTask(book, '只读正文'));
  assert.ok(spec.args.at(-1).includes(`书籍文件：${book}`)); assert.ok(spec.args.at(-1).startsWith(`【CO-AGENT 启动检查 ${result.launchId}】`));
});

test('v0531 Agent 管理 page: 制作书籍 Agent needs a file and the confirmation, and reports the session', async t => {
  const { doc } = await appDocument('shelf'), posts = [];
  const lists = { allowImport: false, categories: [], roles: [], books: [], unlisted: [], bookMaker: { name: 'a-deepbooker', platforms: ['codex', 'claude'] } };
  let reply = { ok: true, value: { launchId: 'L', cli: 'claude', agentName: 'a-deepbooker' } };
  const front = await mountApp(doc, async (url, opts = {}) => {
    if (url === '/api/book-maker') { posts.push(JSON.parse(opts.body)); return { ok: reply.ok, status: reply.ok ? 200 : 409, json: async () => reply.value }; }
    const value = url === '/api/agent-lists' ? lists
      : url === '/api/registry' ? { agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui: 'shelf', recommend: {} }
      : url === '/api/config' ? { firstRun: false, values: {}, paths: {}, environment: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => front.dispose());
  await doc.getElementById('settings-agents').fire('click');
  const get = id => doc.getElementById(id), start = get('agent-manager-book-start');
  assert.equal(get('agent-manager-maker-missing').hidden, true);
  assert.deepEqual(get('agent-manager-book-cli').querySelectorAll('option').map(o => o.value), ['codex', 'claude']);
  assert.equal(start.disabled, true, 'no file yet');
  get('agent-manager-book-file').value = 'D:\\Books\\一本书.pdf'; await get('agent-manager-book-file').fire('input');
  assert.equal(start.disabled, true, 'not confirmed yet');
  get('agent-manager-book-confirm').checked = true; await get('agent-manager-book-confirm').fire('change');
  assert.equal(start.disabled, false);
  get('agent-manager-book-cli').value = 'claude'; get('agent-manager-book-note').value = ' 跳过书评 ';
  await start.fire('click');
  assert.deepEqual(posts, [{ file: 'D:\\Books\\一本书.pdf', note: '跳过书评', cli: 'claude', writableConfirmed: true }]);
  assert.equal(get('agent-manager-status').textContent, '已在终端里打开 a-deepbooker（Claude），开始制作「一本书.pdf」。');
  assert.equal(get('agent-manager-book-file').value, ''); assert.equal(get('agent-manager-book-confirm').checked, false); assert.equal(start.disabled, true);
  reply = { ok: false, value: { error: '找不到书籍文件：D:\\x.pdf' } };
  get('agent-manager-book-file').value = 'D:\\x.pdf'; get('agent-manager-book-confirm').checked = true; await get('agent-manager-book-confirm').fire('change');
  await start.fire('click');
  assert.equal(get('agent-manager-status').textContent, '启动失败：找不到书籍文件：D:\\x.pdf');
  lists.bookMaker = null; get('agent-manager-close').fire('click'); await doc.getElementById('settings-agents').fire('click');
  assert.equal(get('agent-manager-maker-missing').hidden, false); assert.match(get('agent-manager-maker-missing').textContent, /允许导入 Agent 文件/);
});
