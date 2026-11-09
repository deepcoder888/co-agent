import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { mountApp } from '../public/app.js';

// v0.48.3 (2026-11-07): 顾问团 gets the toolbar history menu and 新建 button that 圆桌 and 会诊室 have.
const book = id => ({ id, name: id.toUpperCase(), kind: 'book', primary: '学习', tags: [], description: '简介',
  book: { title: `《${id}的书》`, author: `${id}作者` }, platforms: { codex: { available: true, name: id.toUpperCase() }, claude: { available: true } },
  sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const registry = () => ({ agents: ['one', 'two', 'three'].map(book), categories: ['学习'], summary: { roles: 0, books: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] });

test('v0483 顾问团 page: 顾问团记录 and ＋ 新建顾问团 in the toolbar; archived councils are listed and marked', async t => {
  const { config } = await fixture(t); let front;
  const app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry() });
  t.after(async () => { front?.dispose(); await app.close(); }); await app.listen();
  const reading = await app.councils.create({ name: '读书顾问团', goal: '每天读书半小时', memberIds: ['one', 'two'] });
  const old = await app.councils.create({ name: '旧的顾问团', goal: '早睡', memberIds: ['two', 'three'] });
  await app.councils.update(old.councilId, { archived: true });
  const base = `http://127.0.0.1:${app.server.address().port}`, { doc } = await appDocument('threepane', app.token);
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  front = await mountApp(doc, (url, opts) => fetch(base + url, opts), { confirm: async () => true });
  const get = id => doc.getElementById('room-councils-' + id);
  await doc.getElementById('councils-open').fire('click');
  assert.equal(front.snapshot().chat.councils.selected.councilId, reading.councilId, 'the first open council is shown');

  const history = get('history');
  assert.ok(history && !history.closest('[hidden]'), 'the menu is in the toolbar');
  assert.equal(history.querySelector('summary').textContent, '顾问团记录（2）');
  const items = history.querySelectorAll('.chat-list-item');
  assert.deepEqual(items.map(el => el.querySelector('.chat-list-title').textContent), ['读书顾问团', '旧的顾问团'], 'open councils first, then archived');
  assert.match(items[1].textContent, /已归档/); assert.doesNotMatch(items[0].textContent, /已归档/);

  const fresh = get('new-main');
  assert.ok(fresh && !fresh.closest('[hidden]'), '＋ 新建顾问团 is in the toolbar of an opened council');
  await fresh.fire('click');
  assert.ok(front.snapshot().chat.councils.draft, 'a new-council draft opens'); assert.ok(get('name'));
  assert.ok(!get('new-main')?.parentElement, 'the draft needs no 新建 button'); assert.ok(get('history').parentElement, 'history stays while drafting');

  get('history').open = true;
  await get('history').querySelectorAll('.chat-list-item')[1].fire('click');
  assert.equal(get('history').open, false, 'choosing a council closes the menu');
  const c = front.snapshot().chat.councils;
  assert.equal(c.draft, null); assert.equal(c.selected.councilId, old.councilId, 'an archived council opens from the menu');
});
