import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp, toDetailView } from '../public/app.js';
import { layouts } from '../public/layouts/index.js';

function textNodes(doc) { doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; }; return doc; }
const member = (id, kind = 'book') => ({ id, name: id, kind, primary: kind === 'book' ? '学习' : '功能性 Agent',
  book: kind === 'book' ? { title: '《书》', author: '作者' } : null, purpose: kind === 'role' ? '协调' : null, description: '说明', tags: [],
  platforms: { codex: { available: true }, claude: { available: true } }, sources: kind === 'book' ? { checked: true, missing: [] } : { checked: false, missing: [] },
  permissions: {}, sync: { state: '同步' } });

test('v016 role agents get no 原书 chip; book agents keep it', () => {
  const view = agent => ({ ...agent, sourcesOk: agent.kind === 'book' ? true : null, sourcesReason: '', sync: agent.sync, platforms: agent.platforms });
  const role = toDetailView(view(member('Peter', 'role')), { items: [], unavailable: [] });
  const book = toDetailView(view(member('Walvo')), { items: [], unavailable: [] });
  assert.ok(!role.chips.some(c => /原书/.test(c.label)), JSON.stringify(role.chips.map(c => c.label)));
  assert.ok(book.chips.some(c => c.label === '原书可用'));
});

const registry = { agents: [member('Walvo'), member('Peter', 'role')], categories: ['学习'], summary: { roles: 1, books: 1 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
const running = { conceptId: 'c1', status: 'running', kind: 'daily', day: '2026-10-08', startedAt: '2026-10-08T01:00:00Z',
  agent: { id: 'Walvo', name: 'Walvo', title: '书' }, result: null, verify: { state: 'unconfirmed', skillStructure: { state: 'missing', missing: [1, 2, 3], titleLine: false } }, perspectives: [] };
for (const ui of Object.keys(layouts)) test(`v016 ${ui}: a running or failed-without-result concept shows no empty verification marks`, async t => {
  for (const status of ['running', 'failed']) {
    const { doc } = await appDocument(ui); textNodes(doc);
    const record = { ...running, status, ...(status === 'failed' ? { error: '进程中断' } : {}) };
    const app = await mountApp(doc, async url => {
      const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
        : url === '/api/settings' ? { ui, recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
        : url.startsWith('/api/concepts?') ? { items: [record], running: status === 'running' ? { conceptId: 'c1', kind: 'daily', startedAt: record.startedAt } : null, today: { day: '2026-10-08', conceptId: 'c1', status } }
        : url === '/api/concepts/c1' ? record : url === '/api/groups' ? { groups: [] } : { items: [], unavailable: [] };
      return { ok: true, json: async () => value };
    }, { confirm: async () => true });
    t.after(() => app.dispose());
    await app.actions.openConcepts();
    const text = doc.getElementById('concepts-panel').textContent;
    assert.doesNotMatch(text, /缺少小节/, `${ui} ${status}`); assert.doesNotMatch(text, /核验：未确认/, `${ui} ${status}`);
    if (status === 'failed') assert.match(text, /进程中断/);
  }
});
