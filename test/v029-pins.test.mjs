import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put, fakeSpawner } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { readPins, writePins, maxPins } from '../src/pins.mjs';
import { mountApp } from '../public/app.js';

test('v029 pins store: missing and corrupt files read as empty; writes keep order and reject bad lists', async t => {
  const { config } = await fixture(t), logs = [];
  assert.deepEqual(await readPins(config.dataDir, async line => logs.push(line)), []);
  assert.deepEqual(logs, [], 'a missing file is not worth a log line');
  assert.deepEqual(await writePins(config.dataDir, ['walvo', '-steven']), ['walvo', '-steven']);
  assert.deepEqual(await readPins(config.dataDir), ['walvo', '-steven']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.dataDir, 'pins.json'), 'utf8')), { version: 1, ids: ['walvo', '-steven'] });
  for (const bad of [['a', 'a'], [''], [1], 'walvo', Array.from({ length: maxPins + 1 }, (_, i) => 'a' + i), ['bad\nid']]) {
    await assert.rejects(writePins(config.dataDir, bad), { status: 400 });
  }
  await put(path.join(config.dataDir, 'pins.json'), '{');
  assert.deepEqual(await readPins(config.dataDir, async line => logs.push(line)), []);
  assert.match(logs[0], /常用 Agent 读取回退/);
});

test('v029 /api/pins reads, saves with the launch token and validates the body', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t);
  app = await createApp(config, { spawnImpl: fakeSpawner([]) }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = (body, token = app.token) => fetch(`${base}/api/pins`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${base}/api/pins`)).json(), { ids: [] });
  assert.equal((await send({ ids: ['walvo'] }, 'f'.repeat(64))).status, 403);
  assert.equal((await send({ ids: ['walvo', 'walvo'] })).status, 400);
  assert.equal((await send(['walvo'])).status, 400);
  assert.deepEqual(await (await send({ ids: ['jadra', 'walvo'] })).json(), { ids: ['jadra', 'walvo'] });
  assert.deepEqual(await (await fetch(`${base}/api/pins`)).json(), { ids: ['jadra', 'walvo'] });
  assert.deepEqual(await readPins(config.dataDir), ['jadra', 'walvo']);
});

const member = (id, kind = 'book', primary = '学习') => ({ id, name: id, kind, primary: kind === 'book' ? primary : '功能性 Agent',
  book: kind === 'book' ? { title: `《${id}》`, author: '作者' } : null, purpose: kind === 'role' ? '协调' : null, description: '说明', tags: [],
  platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const registry = { agents: [member('Walvo'), member('Jadra'), member('Rusko', 'book', '睡眠'), member('Peter', 'role')],
  categories: ['学习', '睡眠'], summary: { roles: 1, books: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };

async function mounted(t, ui, { pins = [], failPut = false } = {}) {
  const { doc } = await appDocument(ui); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const requests = []; let stored = [...pins];
  const app = await mountApp(doc, async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ url, method, body, opts });
    if (url === '/api/pins' && method === 'PUT') {
      if (failPut) return { ok: false, status: 400, json: async () => ({ error: '常用 Agent 列表无效' }) };
      stored = body.ids; return { ok: true, json: async () => ({ ids: stored }) };
    }
    const value = url === '/api/pins' ? { ids: stored } : url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui, recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, requests, stored: () => stored };
}
const pinControl = doc => doc.querySelector('[data-focus-key="detail-pin"]');

test('v029 pinning adds a leading 常用 category in pin order and saves through PUT /api/pins', async t => {
  const h = await mounted(t, 'threepane');
  assert.ok(!h.app.snapshot().categories.some(c => c.key === 'pinned'), 'no pins, no category');
  await h.app.actions.togglePin('Rusko'); await h.app.actions.togglePin('Walvo');
  const put = h.requests.filter(r => r.url === '/api/pins' && r.method === 'PUT');
  assert.deepEqual(put.map(r => r.body.ids), [['Rusko'], ['Rusko', 'Walvo']]);
  assert.equal(put[0].opts.headers['X-Co-Agent-Token'], 'synthetic-token');
  const snap = h.app.snapshot();
  assert.deepEqual(snap.categories[0], { key: 'pinned', label: '常用', fullLabel: '常用 Agent', count: 2, selected: false });
  assert.deepEqual(snap.state.pinnedIds, ['Rusko', 'Walvo']);
  h.app.actions.selectCategory('pinned');
  assert.equal(h.app.snapshot().catalog.title, '常用 Agent');
  assert.deepEqual(h.app.snapshot().catalog.agents.map(a => a.id), ['Rusko', 'Walvo']);
  await h.app.actions.togglePin('Rusko'); await h.app.actions.togglePin('Walvo');
  assert.equal(h.app.snapshot().state.category, 'role', 'an emptied 常用 view falls back to the start category');
  assert.ok(!h.app.snapshot().categories.some(c => c.key === 'pinned'));
});

test('v029 a rejected save shows a toast and restores the server list', async t => {
  const h = await mounted(t, 'bento', { pins: ['Jadra'], failPut: true });
  assert.deepEqual(h.app.snapshot().state.pinnedIds, ['Jadra'], 'pins load at startup');
  await h.app.actions.togglePin('Walvo');
  assert.deepEqual(h.app.snapshot().state.pinnedIds, ['Jadra']);
  assert.match(h.doc.getElementById('app-toast').textContent, /常用 Agent 保存失败/);
});

for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) {
  test(`v029 ${ui} detail offers a pressed-state 常用 toggle`, async t => {
    const h = await mounted(t, ui, { pins: ['Jadra'] });
    await h.app.actions.openDetail('Jadra');
    let button = pinControl(h.doc);
    assert.equal(button.textContent, '★ 已设为常用'); assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.getAttribute('aria-label'), '取消常用 Jadra');
    await button.fire('click'); await h.app.actions.togglePin('Walvo');
    await h.app.actions.openDetail('Jadra'); button = pinControl(h.doc);
    assert.equal(button.textContent, '☆ 设为常用'); assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(h.stored(), ['Walvo']);
  });
}

test('v029 shelf stands pinned books and colleagues on a top 常用 shelf with their own focus keys', async t => {
  const h = await mounted(t, 'shelf', { pins: ['Peter', 'Rusko'] });
  const layers = h.doc.querySelectorAll('.shelf-layer');
  // The fake DOM's selector parser only knows letter-only tag names, so headings are read through children.
  const title = layer => layer?.querySelector('.shelf-layer-heading').children[0].textContent;
  assert.equal(title(layers[0]), '常用');
  assert.deepEqual(layers[0].children.map(n => n.className), ['shelf-layer-heading', 'book-row', 'wood-edge']);
  const row = layers[0].querySelector('.book-row');
  assert.deepEqual(row.querySelectorAll('button').map(n => n.getAttribute('data-focus-key')).filter(k => k.startsWith('pinned-card-detail-')), ['pinned-card-detail-Peter', 'pinned-card-detail-Rusko']);
  assert.ok(row.querySelector('.staff-badge') && row.querySelector('.book-spine'), 'a colleague plaque and a spine');
  h.app.actions.search('Walvo');
  assert.ok(!h.doc.querySelectorAll('.shelf-layer').some(layer => title(layer) === '常用'), 'search results replace the 常用 shelf');
});
