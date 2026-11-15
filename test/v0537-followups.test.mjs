// v0.53: notes a stranger understands. The recommend views explain the Claude/Codex difference in plain words, the
// joint card does not say 白名单, and a missing original book is fixed through the definition file, not a script only
// the author has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocument } from './fixtures/app.mjs';
import { mountApp, toAgentView, toDetailView } from '../public/app.js';
import { drawJointStatus as threepaneJoint } from '../public/layouts/threepane.js';
import { drawJointStatus as bentoJoint } from '../public/layouts/bento.js';
import { drawJointStatus as editorialJoint } from '../public/layouts/editorial.js';
import { drawJointStatus as shelfJoint } from '../public/layouts/shelf.js';

const registry = { agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], candidates: [] };
const NOTE = '用 Claude 时，CO-AGENT 会在运行前限定它只能调用所选的 Agent；用 Codex 时，CO-AGENT 无法事先限制它调用哪些 Agent，只能在运行后核对。';
const JARGON = /禁止规则|白名单|事后核验|逐字核验|子任务文本加密/;

async function mount(t, ui) {
  const { doc } = await appDocument(ui);
  const app = await mountApp(doc, async url => {
    const value = url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/config' ? { firstRun: false, values: {}, paths: {}, environment: {} }
      : url === '/api/agent-lists' ? { allowImport: false, bookMaker: null, categories: [], roles: [], books: [], unlisted: [] }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui, recommend: {} } : { items: [], unavailable: [] };
    return { ok: true, status: 200, json: async () => structuredClone(value) };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return doc;
}

for (const ui of ['threepane', 'bento', 'editorial', 'shelf']) test(`v0.53 recommend view (${ui}): the engine note is plain words, not internal jargon`, async t => {
  const text = (await mount(t, ui)).documentElement.textContent;
  assert.ok(text.includes(NOTE), 'the plain note is shown');
  assert.doesNotMatch(text, JARGON);
});

for (const [ui, draw] of [['threepane', threepaneJoint], ['bento', bentoJoint], ['editorial', editorialJoint], ['shelf', shelfJoint]]) test(`v0.53 joint card (${ui}): members and the call check are not labelled 白名单`, async () => {
  const { doc } = await appDocument(ui), target = doc.createElement('section');
  const record = { cli: 'codex', whitelist: [{ id: 'walvo', codexName: 'Walvo', claudeName: 'walvo' }, { id: 'jadra', codexName: 'Jadra', claudeName: 'jadra' }] };
  draw(doc, target, record, { overall: 'running', process: { state: 'alive' }, cwd: { state: 'ok' }, parallel: { state: 'ok' },
    whitelist: { state: 'ok', violations: [], deniedAttempts: [] }, calls: [{ agent: 'Walvo', state: 'running' }] });
  assert.match(target.textContent, /可调用的 Agent：Walvo、Jadra/);
  assert.match(target.textContent, /调用范围：通过/);
  assert.doesNotMatch(target.textContent, JARGON);
});

test('v0.53 missing original book: the advice points to the definition file and 刷新目录, never a script under ~/.claude', () => {
  const agent = { id: 'walvo', name: 'Walvo', kind: 'book', primary: '学习', book: { title: '《示例》', author: '作者', edition: '版' }, description: '说明', tags: [],
    sourceFile: 'agents\\walvo.toml', platforms: { codex: { available: true }, claude: { available: true, file: 'agents\\walvo.md' } },
    sources: { checked: true, total: 1, missing: ['D:\\books\\walvo.epub'] }, permissions: {}, sync: { state: '同步' } };
  const rows = toDetailView(toAgentView(agent), { items: [], unavailable: [] }).sections.find(s => s.key === 'sources').rows;
  const advice = rows.find(r => r.label === '怎么修复');
  assert.ok(advice, JSON.stringify(rows.map(r => r.label)));
  assert.match(advice.value, /定义文件里（即 Codex 源文件和 Claude 入口文件）/);
  assert.match(advice.value, /把书放回列出的路径，或用文本编辑器打开定义文件，把路径改成书现在的位置，然后到 设置 → 目录 点「刷新目录」/);
  assert.doesNotMatch(JSON.stringify(rows), /rebind_book_sources|\.claude[\\/]+scripts|dry-run|重绑/);
  const intact = toDetailView(toAgentView({ ...agent, sources: { checked: true, total: 1, missing: [] } }), { items: [], unavailable: [] });
  assert.ok(!intact.sections.find(s => s.key === 'sources').rows.some(r => r.label === '怎么修复'));
});
