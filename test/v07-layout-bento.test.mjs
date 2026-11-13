import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { mountApp, toAgentView, toDetailView } from '../public/app.js';
import { mountLayouts } from '../public/layouts/index.js';
import { summary } from '../public/display.js';
import * as bento from '../public/layouts/bento.js';

const sleep = '睡眠／健康／运动';
const raw = (id, kind = 'role') => ({ id, name: id, kind, primary: kind === 'role' ? '功能性 Agent' : sleep,
  purpose: kind === 'role' ? '批判审查' : '', description: '可核对的说明。\n\n<example>user: 隐藏的触发示例</example>',
  book: kind === 'book' ? { title: '*Dear Sample*', author: '甲、乙、丙', edition: '2023' } : null,
  tags: [], sourceFile: 'synthetic.toml', permissions: { claude: { model: 'sonnet', writable: false } },
  platforms: { claude: { available: true, file: 'synthetic.md' }, codex: { available: true } },
  sources: { checked: true, total: 1, missing: [] }, sync: { state: '同步', detail: '核对相符' } });
const agents = [raw('-steven'), raw('-ark'), raw('-jack'), raw('-albert'), raw('Jadra', 'book')];
const registry = { agents, categories: [sleep, ...Array.from({ length: 10 }, (_, i) => `分类${i}`)],
  summary: { roles: 4, books: 1, synced: 5, outOfScope: 0, failed: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [], scannedAt: '2026-10-07T00:00:00Z' };
const record = (i) => ({ type: i % 2 ? 'joint' : 'launch', id: `h${i}`, agents: [{ id: '-steven', name: '-steven' }],
  cli: 'claude', createdAt: '2026-10-07T00:00:00Z', status: { overall: i % 2 ? 'failed' : 'done' },
  inputPreview: i % 2 ? '<script>用户原文' : '', source: 'manual', mode: 'agent', canResume: i === 0, resumeReason: i ? '会话文件不存在' : '' });
const rows = Array.from({ length: 7 }, (_, i) => record(i));
const stats = { sources: [{ available: true, id: 'fixture', failedFiles: [] }], perAgent: Object.fromEntries(agents.map((a, i) => [a.id,
  { last7d: { calls: i, bySource: {} }, total: { calls: i * 2, bySource: {} } }])), limited: true, limitedReasons: ['仅可读来源'] };
const visible = n => !n.closest('[hidden]');
const button = (root, label) => descendants(root).find(n => n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === label || n.textContent === label));
function fixture({ cssom = false } = {}) {
  const doc = documentFrom('<html data-ui="bento"><body><div id="layout-root"></div><dialog id="joint-builder"></dialog></body></html>');
  if (cssom) {
    // Record property-level CSSOM writes; reject attributes as the real CSP does.
    // This checks the styling API, not browser geometry or pixel rendering.
    const create = doc.createElement;
    doc.createElement = tag => {
      const el = create(tag), properties = new Map(), setAttribute = el.setAttribute.bind(el);
      el.style = { setProperty: (key, value) => properties.set(key, String(value)), getPropertyValue: key => properties.get(key) || '' };
      el.setAttribute = (key, value) => { assert.notEqual(key, 'style', 'style attributes are blocked by CSP'); setAttribute(key, value); };
      return el;
    };
  }
  const calls = [], actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const av = agents.map(a => toAgentView(a, { stats }));
  const model = {
    state: { view: 'catalog', category: 'role', selectedId: '-steven', query: '', sort: 'default', detailOpen: false, jointSelectedIds: [], allAgents: av, categories: registry.categories },
    categories: [{ key: 'role', label: '功能性 Agent', fullLabel: '功能性 Agent', count: 4, selected: true }, { key: 'book', label: '全部书籍', fullLabel: '全部书籍', count: 1 },
      ...registry.categories.map(key => ({ key, label: key, fullLabel: key, count: key === sleep ? 1 : 0 }))],
    catalog: { title: '功能性 Agent', count: 4, agents: av.slice(0, 4), query: '', sort: 'default', selectedId: '-steven', categories: registry.categories },
    detail: toDetailView(av[0], { items: [], unavailable: [] }),
    metrics: { recent7: 42, recentByKind: { role: 12, book: 30 }, total: 81, roles: 11, books: 70, sync: { ok: 81, total: 81 }, scopeLimited: true, scopeReasons: ['仅可读来源'], statsState: 'ready', top: av.map((a, i) => ({ id: a.id, name: a.name, count: 10 - i })) },
    history: { items: rows, recent: rows.slice(0, 5), filter: 'all', selected: null, busy: false, message: '' }, running: [], coverage: { registry, stats },
    recommend: { input: '', engine: 'claude', cli: 'claude', selectedIds: [], results: [], recent: [], settings: { recommend: { claude: { model: 'sonnet' }, codex: { model: 'gpt-test', effort: 'xhigh' } } } }
  };
  const dispatcher = mountLayouts(doc, actions); dispatcher.update(model);
  return { doc, calls, model, dispatcher, get: id => doc.getElementById(id), update: () => dispatcher.update(model) };
}
const css = await fs.readFile('public/layouts/bento.css', 'utf8');
function rule(selector) {
  const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, `CSS rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

test('B2-1 usage widths use CSP-safe CSSOM and count/max ratios, including zero and refreshed counts', () => {
  const h = fixture({ cssom: true });
  for (const counts of [[89, 55, 48, 33, 0], [0, 0, 0, 0, 0], [2, 1]]) {
    h.model.metrics.top = counts.map((count, i) => ({ id: `a${i}`, name: `A${i}`, count })); h.update();
    const fills = h.get('top-agents').querySelectorAll('.usage-fill');
    assert.equal(fills.length, counts.length);
    fills.forEach((fill, i) => {
      assert.equal(fill.style.getPropertyValue('width'), `${counts[i] / Math.max(1, ...counts) * 100}%`);
      assert.equal(fill.getAttribute('style'), null);
      assert.equal(fill.parentElement.getAttribute('aria-valuenow'), String(counts[i]));
    });
  }
  h.model.metrics.top = []; h.update();
  assert.equal(h.get('top-agents').querySelectorAll('.usage-fill').length, 0);
  assert.match(h.get('top-agents').textContent, /暂无数据/);
});

test('B2-2 catalog and recommendation subtitles prefer S2 purpose/bookLabel and fall back to description summaries', () => {
  const h = fixture(), role = structuredClone(h.model.state.allAgents[0]), book = structuredClone(h.model.state.allAgents[4]);
  const description = 'Read-only diagnostic Agent for Windows computers and installed system software. '.repeat(6);
  role.description = description; role.summary = description; role.purpose = '系统诊断';
  book.bookLabel = '《共享层清洗后的书名》';
  const show = () => {
    h.model.catalog.agents = [role, book];
    h.model.recommend.results = [role, book].map(agent => ({ ...agent, selected: false, reason: '相关' }));
    h.model.recommend.recommendation = { status: 'done' }; h.update();
    return ['cards', 'recommend-results'].map(id => h.get(id).querySelectorAll('.agent-subtitle').map(el => el.textContent));
  };
  assert.deepEqual(show(), Array(2).fill(['系统诊断', '《共享层清洗后的书名》']));
  // Missing purpose uses a display-only description fallback. Language must not
  // suppress registry metadata or introduce a local table of role definitions.
  delete book.bookLabel;
  for (const purpose of [description, undefined, null, '']) {
    role.purpose = purpose;
    assert.deepEqual(show(), Array(2).fill([purpose || summary(description), 'Dear Sample']));
  }
  assert.doesNotMatch(h.get('cards').textContent, /<example>|\*Dear Sample\*/);
});

test('B2-2 subtitles clamp at two lines and tiles keep content-driven 210px minimum height', () => {
  const subtitle = rule('[data-ui="bento"] .agent-subtitle'), tile = rule('[data-ui="bento"] .agent-tile');
  assert.match(subtitle, /display:\s*-webkit-box/);
  assert.match(subtitle, /-webkit-box-orient:\s*vertical/);
  assert.match(subtitle, /-webkit-line-clamp:\s*2(?:;|\s)/);
  assert.match(subtitle, /overflow:\s*hidden/);
  assert.match(tile, /min-height:\s*210px/);
  assert.doesNotMatch(tile, /(?:[;{]\s*)(?:max-)?height:/);
});

test('B2-3 empty and whitespace tasks keep the bright button active, validate on click, and recover on input', async () => {
  const h = fixture(), input = h.get('recommend-input'), submit = h.get('recommend-submit'), reason = h.get('recommend-disabled-reason');
  assert.match(rule('[data-ui="bento"] #recommend-submit'), /background:\s*#f0b44c/);
  assert.doesNotMatch(rule('[data-ui="bento"] #recommend-submit'), /opacity:\s*0?\./);
  assert.ok(reason.hidden || reason.className.includes('bento-sr-only'), 'initial prompt remains quiet');
  for (const text of ['', ' \n\t ']) {
    h.model.recommend.input = text; h.update();
    assert.equal(submit.disabled, false);
    await submit.fire('click');
    assert.equal(h.calls.filter(([name]) => name === 'recommend').length, 0);
    assert.equal(reason.textContent, '请输入问题');
    assert.ok(visible(reason)); assert.ok(!reason.className.includes('bento-sr-only'));
    assert.equal(reason.getAttribute('aria-live'), 'polite');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.ok(input.getAttribute('aria-describedby').split(' ').includes(reason.id));
    assert.equal(h.doc.activeElement, input);
    h.update(); assert.equal(reason.textContent, '请输入问题', 'polling preserves click feedback');
  }
  input.value = '核查睡眠说法'; await input.fire('input');
  assert.deepEqual(h.calls.at(-1), ['setRecommendInput', input.value]);
  assert.notEqual(input.getAttribute('aria-invalid'), 'true');
  assert.ok(reason.hidden || reason.className.includes('bento-sr-only'));
  h.model.recommend.input = input.value; h.update(); await submit.fire('click');
  assert.equal(h.calls.filter(([name]) => name === 'recommend').length, 1);
});

test('B2-3 busy and over-limit inputs still block submission; programmatic draft changes clear old validation', async () => {
  const h = fixture(), input = h.get('recommend-input'), submit = h.get('recommend-submit');
  await submit.fire('click');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  h.model.recommend.input = '恢复的草稿'; h.update();
  assert.notEqual(input.getAttribute('aria-invalid'), 'true');
  for (const [text, busy] of [['任务', true], ['字'.repeat(8001), false]]) {
    h.model.recommend.input = text; h.model.recommend.busy = busy; h.update();
    assert.equal(submit.disabled, true); await submit.fire('click');
    assert.equal(h.calls.filter(([name]) => name === 'recommend').length, 0);
  }
  h.model.recommend.input = '有效任务'; h.model.recommend.busy = false; h.update();
  await submit.fire('click'); assert.equal(h.calls.filter(([name]) => name === 'recommend').length, 1);
});

test('B4.1 page width, local fonts, spacing and every CSS selector are scoped', () => {
  const h = fixture(); assert.ok(h.doc.querySelector('.layout-bento'));
  assert.match(rule('[data-ui="bento"] .layout-bento'), /max-width:\s*1360px/);
  assert.match(rule('[data-ui="bento"] .bento-grid'), /gap:\s*16px/);
  assert.match(css, /#f3efe8/); assert.match(css, /"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", sans-serif/);
  assert.doesNotMatch(css, /@import|https?:|url\(/);
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim(); if (selector.startsWith('@media')) continue;
    assert.ok(selector.startsWith('[data-ui="bento"]'), selector);
    assert.doesNotMatch(selector, /,\s*(?!\[data-ui=)[.#a-z]/);
  }
});

test('B4.2 header contains only brand, label-free search and square settings control', () => {
  const h = fixture(), header = h.doc.querySelector('.bento-header');
  // The recording fixture's selector parser supports alphabetic tag names only.
  assert.equal(descendants(header).find(n => n.tagName === 'H1').textContent, 'CO-AGENT');
  assert.equal(h.get('brand').querySelector('img').getAttribute('width'), '40');
  assert.equal(h.get('search-control').textContent, '');
  assert.equal(h.get('search').getAttribute('aria-label'), '全局搜索');
  assert.equal(h.get('search').getAttribute('title'), '/ 或 Ctrl+K');
  assert.ok(button(header, '打开设置').querySelector('svg'));
  assert.doesNotMatch(header.textContent, /v0\.7|全局搜索|刷新目录|目录|AI 推荐|历史调用/);
  assert.equal(h.doc.querySelector('.utility-nav'), null);
  assert.match(rule('[data-ui="bento"] .brand h1'), /font-size:\s*28px/);
  assert.match(rule('[data-ui="bento"] #search'), /width:\s*420px/);
});

test('B4.3 ask tile has headline, inline task/submit, then compose/engine with quiet initial state', () => {
  const h = fixture(), ask = h.get('recommend-panel');
  assert.match(ask.textContent, /问 CO-AGENT.*描述你的任务，.*我来挑选合适的 Agent。/);
  assert.equal(ask.querySelectorAll('br').length, 1);
  assert.equal(h.get('recommend-input').getAttribute('rows'), '1');
  assert.equal(h.get('recommend-input').getAttribute('maxlength'), '8000');
  assert.equal(h.get('recommend-input').parentElement, h.get('recommend-submit').parentElement);
  assert.equal(button(ask, '新建联合调用').parentElement, h.get('recommend-engine').parentElement.parentElement);
  assert.equal(h.get('recommend-count').hidden, true);
  assert.equal(ask.querySelector('#recent-panel'), null);
  assert.doesNotMatch(ask.textContent, /白名单|事后核验|最近的推荐/);
  assert.match(h.get('recommend-engine').options[0].textContent, /Claude · sonnet/);
  assert.match(rule('[data-ui="bento"] .bento-ask'), /background:\s*#1c1b19/);
  assert.match(rule('[data-ui="bento"] .bento-ask'), /border-radius:\s*28px/);
  assert.match(rule('[data-ui="bento"] .ask-headline'), /font-size:\s*34px/);
});

test('B4.3 counter appears only above 7000, input identity survives updates, submission honors busy and limit', () => {
  const h = fixture(), input = h.get('recommend-input');
  for (const length of [7000, 7001, 8000, 8001]) {
    h.model.recommend.input = '字'.repeat(length); h.update();
    assert.equal(h.get('recommend-input'), input);
    assert.equal(h.get('recommend-count').hidden, length <= 7000);
    assert.equal(h.get('recommend-submit').disabled, length > 8000);
  }
  h.model.recommend.input = '有效任务'; h.model.recommend.busy = true; h.update();
  assert.equal(h.get('recommend-submit').disabled, true);
});

test('B4.3 metrics show kind breakdown, one scope hint and four/five custom blue usage bars', () => {
  const h = fixture(), metrics = h.get('metrics');
  assert.deepEqual(metrics.querySelectorAll('strong').map(n => n.textContent), ['42', '81']);
  assert.match(metrics.textContent, /功能性 12 · 书籍 30/);
  assert.match(metrics.textContent, /11 角色 · 70 书籍 · 同步 81\s*\/\s*81/);
  assert.equal(h.doc.querySelectorAll('.scope-info').length, 1);
  assert.equal(h.get('top-agents').querySelectorAll('.usage-row').length, 5);
  assert.equal(h.get('top-agents').querySelectorAll('meter').length, 0);
  assert.equal(h.get('top-agents').querySelectorAll('[role="meter"]').length, 5);
  assert.match(rule('[data-ui="bento"] .usage-fill'), /background:\s*#1f4e9c/);
  assert.match(rule('[data-ui="bento"] .usage-track'), /height:\s*10px/);
  assert.match(rule('[data-ui="bento"] .usage-track'), /background:\s*#ece6dc/);
  h.model.metrics.recent7 = null; h.model.metrics.recentByKind = { role: null, book: null }; h.model.metrics.statsState = 'unavailable'; h.update();
  assert.equal(h.get('metrics').querySelector('strong').textContent, '暂无数据');
  assert.doesNotMatch(h.get('metrics').textContent, /功能性 0/);
});

test('B4.4 catalog tiles precede categories; contain title, purpose, white badge and two named launch buttons', async () => {
  const h = fixture(), cards = h.get('cards').querySelectorAll('article');
  assert.equal(bento.initialCategory, 'role'); assert.equal(cards.length, 4);
  assert.equal(descendants(cards[0]).find(n => n.tagName === 'H3').textContent, '-steven');
  assert.match(cards[0].textContent, /批判审查/); assert.equal(cards[0].querySelector('.agent-badge').textContent, '7 天 0 · 累计 0');
  assert.equal(cards[0].querySelector('.tile-actions').querySelectorAll('button').length, 2);
  await cards[0].fire('click'); assert.equal(h.calls.at(-1)[0], 'openDetail');
  await button(cards[0], '在 Claude CLI 中调用 -steven').fire('click'); assert.deepEqual(h.calls.at(-1).slice(0, 3), ['launch', '-steven', 'claude']);
  const before = h.calls.length; await cards[0].fire('click', { target: button(cards[0], '在 Claude CLI 中调用 -steven') }); assert.equal(h.calls.length, before);
  const grid = h.doc.querySelector('.bento-grid'); assert.ok(grid.children.indexOf(h.get('catalog')) < grid.children.indexOf(h.get('navigation')));
  assert.match(rule('[data-ui="bento"] #cards'), /repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(rule('[data-ui="bento"] .agent-tile'), /padding:\s*24px/);
  assert.match(rule('[data-ui="bento"] .tile-actions button'), /height:\s*48px/);
  for (const color of ['#f6d9c4', '#d6e2f2', '#ede0f2', '#f2ecc6']) assert.ok(css.includes(color));
});

test('B4.4 book tiles clean titles, fallback to category badges, and disable unavailable CLI with reason', async () => {
  const h = fixture(), book = structuredClone(h.model.state.allAgents[4]);
  book.stats7 = null; book.statsTotal = null; book.platforms.codex = { available: false, reason: '未安装 Codex' };
  h.model.catalog.agents = [book]; h.update();
  assert.match(h.get('cards').textContent, /Dear Sample/); assert.doesNotMatch(h.get('cards').textContent, /\*|<example>|原书|甲|版本/);
  assert.equal(h.get('cards').querySelector('.agent-badge').textContent, '睡眠／健康');
  const disabled = button(h.get('cards'), '在 Codex CLI 中调用 Jadra'); assert.equal(disabled.disabled, true);
  assert.match(h.get(disabled.getAttribute('aria-describedby')).textContent, /未安装 Codex/);
  assert.match(disabled.title, /未安装/); const before = h.calls.length; await disabled.fire('click'); assert.equal(h.calls.length, before);
});

test('B4.5 category strip has label, flat capsules, roles first, count and full-name tooltip, no icons/statistics', async () => {
  const h = fixture(), nav = h.get('navigation'), controls = nav.querySelectorAll('.category-pill');
  assert.equal(nav.children[0].textContent, '书籍分类'); assert.equal(controls.length, 13);
  assert.equal(controls[0].getAttribute('aria-label'), '功能性 Agent 4');
  assert.equal(controls[0].children[0].textContent, '功能性 Agent'); assert.equal(controls[0].querySelector('.category-count').textContent, '4');
  assert.equal(controls[0].getAttribute('aria-current'), 'page');
  assert.equal(controls[2].title, sleep); assert.equal(nav.querySelectorAll('svg').length, 0);
  assert.doesNotMatch(nav.textContent, /· 7 天|▼|书籍类 Agent/);
  await controls[2].fire('click'); assert.deepEqual(h.calls.at(-1), ['selectCategory', sleep]);
  assert.match(rule('[data-ui="bento"] .category-pill'), /border-radius:\s*14px/);
});

test('B4.6 recent calls cap at five one-line rows with status chips and resume reason; history uses tile grid', async () => {
  const h = fixture(), recent = h.get('recent-history-list');
  assert.equal(recent.querySelectorAll('article').length, 5);
  assert.equal(recent.querySelectorAll('.history-state').length, 5);
  assert.equal(recent.querySelectorAll('.history-resume').length, 5);
  assert.equal(recent.querySelectorAll('.history-resume')[1].disabled, true);
  assert.match(recent.querySelectorAll('.history-resume')[1].title, /会话文件不存在/);
  assert.equal(h.get('all-history').textContent, '全部历史 →'); await h.get('all-history').fire('click'); assert.deepEqual(h.calls.at(-1), ['showView', 'history']);
  h.model.state.view = 'history'; h.update(); assert.equal(h.get('history-panel').hidden, false);
  assert.equal(h.get('history-list').querySelectorAll('.history-tile').length, 7);
  assert.match(rule('[data-ui="bento"] #history-list'), /display:\s*grid/);
  assert.match(h.get('history-list').textContent, /2026-10-07 08:00:00/);
  assert.match(h.get('history-list').textContent, /<script>用户原文/); assert.equal(h.get('history-list').querySelectorAll('script').length, 0);
  await button(h.get('history-list'), '重新调用 -steven').fire('click'); assert.deepEqual(h.calls.at(-1), ['rerun', 'launch', 'h0']);
  await button(h.get('history-list'), '继续该次会话 -steven').fire('click'); assert.deepEqual(h.calls.at(-1), ['resumeHistory', 'launch', 'h0']);
});

test('bento history polish: localized metadata, type pills and statusTone chips in recent, full and detail views', () => {
  const h = fixture({cssom:true});
  const items = ['ok','fail','running','pending'].map((tone, i) => ({...record(i),
    type: i % 2 ? 'joint' : i === 2 ? 'single' : 'launch',
    cliLabel:'Codex', sourceLabel:'AI 推荐', modeLabel:'转调', statusTone:tone,
    // The view-model tone is authoritative, independently of the raw status text.
    status:{overall:'done'}, resumeOf:'prior-session', rerunOf:'prior-call'}));
  h.model.history.items = items; h.model.history.recent = items; h.update();
  for (const id of ['history-list','recent-history-list']) {
    const cards = h.get(id).querySelectorAll('article');
    cards.forEach((card, i) => {
      assert.equal(card.querySelector('.history-type').textContent, i % 2 ? '联合' : '单次');
      assert.equal(card.querySelector('.history-cli').textContent,'Codex');
      const chip = card.querySelector('.history-state');
      assert.equal(chip.textContent,'完成'); assert.equal(chip.getAttribute('data-tone'),items[i].statusTone);
      assert.notEqual(chip.getAttribute('aria-hidden'),'true'); assert.equal(chip.getAttribute('style'),null);
      assert.doesNotMatch(card.textContent,/○|◈|claude|codex/);
      if (i % 2) assert.match(card.textContent,/1 个/);
    });
  }
  h.model.state.view='history'; h.model.state.detailOpen=true; h.model.history.selected=items[0]; h.update();
  assert.match(h.get('detail-body').textContent,/模式：转调 · 来源：AI 推荐/);
  assert.match(h.get('detail-body').textContent,/恢复自 prior-session · 重跑自 prior-call/);
  assert.equal(h.get('detail-body').querySelector('.history-state').getAttribute('data-tone'),'ok');
  h.model.history.selected = {...items[0],typeLabel:'提供的类型',statusTone:'unknown'}; h.update();
  assert.equal(h.get('detail-body').querySelector('.history-type').textContent,'提供的类型');
  assert.equal(h.get('detail-body').querySelector('.history-state').getAttribute('data-tone'),'pending');
  h.model.history.items = [record(0)]; h.update();
  assert.equal(h.get('history-list').querySelector('.history-cli').textContent,'Claude');
  assert.match(rule('[data-ui="bento"] .history-type'),/border-radius:\s*999px/);
  const palettes = ['ok','fail','running','pending'].map(tone => rule(`[data-ui="bento"] .history-state[data-tone="${tone}"]`));
  assert.equal(new Set(palettes.map(p => p.match(/background:\s*(#[\da-f]+)/i)?.[1])).size,4);
  for (const palette of palettes) assert.match(palette,/color:\s*#[\da-f]{6}/i);
});

test('B4.6 running and coverage tiles follow recent history and expose their detailed views', async () => {
  const h = fixture(); h.model.running = [{ type: 'launch', agentName: '-steven', cli: 'codex', createdAt: '2026-10-07T00:00:00Z', status: { overall: 'pending' } }]; h.update();
  const grid = h.doc.querySelector('.bento-grid'); const positions = ['recent-history', 'running-panel', 'coverage-tile'].map(id => grid.children.indexOf(h.get(id)));
  assert.ok(positions.every((value, i) => value >= 0 && (!i || value > positions[i - 1])));
  assert.match(button(h.get('running-panel'), '运行中的会话').textContent, /运行中 1/);
  await button(h.get('coverage-tile'), '扫描摘要和数据覆盖').fire('click'); assert.deepEqual(h.calls.at(-1), ['showView', 'coverage']);
  h.model.state.view = 'coverage'; h.update(); assert.ok(visible(h.get('coverage-panel')));
});

test('B4.7 recommendation results are separate pastel tiles below ask with selectable membership and audit', async () => {
  const h = fixture(); h.model.recommend.input = '任务';
  h.model.recommend.recommendation = { status: 'done', engine: 'claude', model: 'sonnet', audit: { ok: true, agentCalls: 0, children: 0 } };
  h.model.recommend.results = h.model.state.allAgents.map(a => ({ ...a, reason: '适合核查', selected: false })); h.update();
  assert.ok(!h.get('recommend-panel').contains(h.get('recommend-results')));
  assert.ok(visible(h.get('recommend-results'))); assert.equal(h.get('recommend-results').querySelectorAll('.agent-tile').length, 5);
  assert.match(h.get('recommend-results').textContent, /加入联合调用/);
  assert.match(h.get('recommend-status').textContent, /推荐审计通过/);
  const check = h.get('recommend-results').querySelector('input'); check.checked = true; await check.fire('change');
  assert.deepEqual(h.calls.at(-1), ['selectRecommendationAgent', '-steven', true]);
  assert.ok(visible(h.get('recommend-verification')));
  assert.match(rule('[data-ui="bento"] .bento-builder'), /border-radius:\s*28px/);
  assert.match(rule('[data-ui="bento"] .bento-detail'), /background:\s*#f3efe8/);
});

test('B4.7 detail retains all evidence, removes raw example markup and book-title asterisks, uses modal focus', async () => {
  const h = fixture(); h.model.detail = toDetailView(h.model.state.allAgents[4], { items: [], unavailable: [] }); h.model.state.detailOpen = true; h.update();
  assert.equal(h.get('detail').open, true); assert.equal(h.doc.activeElement, h.get('close-detail'));
  const text = h.get('detail-body').textContent;
  for (const fragment of ['Dear Sample', '2023', '权限与模型', '原书路径', '双版本同步', '调用统计', '继续上次会话']) assert.ok(text.includes(fragment), fragment);
  assert.doesNotMatch(text, /\*Dear Sample\*|<example>|隐藏的触发示例/);
  const full = h.get('detail-body').querySelector('details'); full.open = true; h.update(); assert.equal(h.get('detail-body').querySelector('details').open, true);
  await h.get('detail').fire('keydown', { key: 'Escape' }); assert.equal(h.get('detail').open, false); assert.deepEqual(h.calls.at(-1), ['closeDetail']);
});

test('B detail closes when its selected Agent disappears, and empty/null statistics never fabricate zero', () => {
  const h = fixture(); h.model.state.detailOpen = true; h.update(); assert.equal(h.get('detail').open, true);
  h.model.detail = null; h.model.catalog.agents = []; h.update();
  assert.equal(h.get('detail').open, false); assert.equal(h.get('detail-body').textContent, '');
  assert.match(h.get('cards').textContent, /当前分类没有 Agent/);
});

test('B updates do not mutate view models or lose focused input, and busy results enforce eight-member cap', async () => {
  const h = fixture(); h.model.recommend.input = '有输入'; h.model.recommend.recommendation = { status: 'done', audit: { ok: true } };
  h.model.recommend.results = Array.from({ length: 9 }, (_, i) => ({ ...h.model.state.allAgents[0], id: `a${i}`, name: `A${i}`, selected: i < 8, reason: '用途' }));
  h.model.recommend.selectedIds = h.model.recommend.results.slice(0, 8).map(a => a.id);
  const before = structuredClone(h.model); h.get('recommend-input').focus(); h.update();
  assert.deepEqual(h.model, before); assert.equal(h.doc.activeElement, h.get('recommend-input'));
  let checks = h.get('recommend-results').querySelectorAll('input'); assert.equal(checks[8].disabled, true); assert.equal(checks[0].disabled, false);
  h.model.recommend.jointBusy = true; h.update(); checks = h.get('recommend-results').querySelectorAll('input');
  assert.ok(checks.every(c => c.disabled)); assert.equal(h.get('joint-submit').disabled, true);
  const ids = descendants(h.doc.body).map(n => n.id).filter(Boolean); assert.equal(new Set(ids).size, ids.length);
});

async function mounted(t) {
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="fixture">');
  const doc = documentFrom(html); doc.documentElement.setAttribute('data-ui', 'bento'); const calls = [];
  const app = await mountApp(doc, async (url, options) => {
    calls.push({ url, options });
    const value = url === '/api/registry' || url === '/api/refresh' ? registry : url === '/api/stats' ? stats :
      url === '/api/settings' ? { ui: options?.body ? JSON.parse(options.body).ui : 'bento', recommend: { claude: { model: 'sonnet' } } } :
      url.startsWith('/api/history?') ? { items: rows } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true }); t.after(() => app.dispose());
  return { doc, app, calls, get: id => doc.getElementById(id) };
}

test('B functional contract: all eleven functions reachable, keyboard search, builder and settings work', async t => {
  const h = await mounted(t), { doc, app, get } = h;
  for (const label of ['AI 推荐', '新建联合调用', '历史调用', '运行中的会话', '扫描摘要和数据覆盖', '打开设置']) assert.ok(button(doc.body, label), label);
  assert.ok(get('navigation')); assert.ok(get('search'));
  await doc.fire('keydown', { key: '/', target: doc.body, preventDefault() {} }); assert.equal(doc.activeElement, get('search'));
  await doc.fire('keydown', { key: 'k', ctrlKey: true, target: doc.body, preventDefault() {} }); assert.equal(doc.activeElement, get('search'));
  await button(get('cards'), '查看 -steven 详情').fire('click');
  for (const label of ['在 Claude CLI 中调用 -steven', '在 Codex CLI 中调用 -steven', '继续上次会话 -steven']) assert.ok(button(get('detail-body'), label), label);
  app.actions.closeDetail(); await button(doc.body, '新建联合调用').fire('click'); assert.equal(get('joint-builder').open, true);
  await get('joint-builder').fire('keydown', { key: 'Escape' }); assert.equal(get('joint-builder').open, false);
  for (const [label, panel] of [['历史调用', 'history-panel'], ['运行中的会话', 'running-panel'], ['扫描摘要和数据覆盖', 'coverage-panel'], ['AI 推荐', 'recommend-panel']]) {
    await button(doc.body, label).fire('click'); assert.ok(visible(get(panel)), label);
  }
  await button(doc.body, '打开设置').fire('click'); assert.equal(get('settings-dialog').open, true);
  assert.ok(!h.calls.some(c => ['/api/launch', '/api/resume', '/api/joint'].includes(c.url)));
});

test('B switching to and from bento preserves category, Agent, search, draft, engine, history filter and joint members', async t => {
  const h = await mounted(t), { app, doc, get } = h;
  app.actions.selectCategory(sleep); await app.actions.openDetail('Jadra'); app.actions.search('Jadra');
  app.actions.setRecommendInput('尚未提交的任务'); app.actions.setRecommendEngine('codex'); app.actions.addToJoint('Jadra', undefined, false);
  await app.actions.setHistoryFilter('joint'); app.actions.openSettings();
  const choices = doc.querySelectorAll('[role="radio"]');
  for (const index of [0, 1, 2, 1, 3, 1]) {
    await choices[index].fire('click'); const snapshot = app.snapshot();
    assert.equal(snapshot.state.category, sleep); assert.equal(snapshot.catalog.selectedId, 'Jadra'); assert.equal(snapshot.catalog.query, 'Jadra');
    assert.equal(snapshot.recommend.input, '尚未提交的任务'); assert.equal(snapshot.recommend.engine, 'codex'); assert.equal(snapshot.history.filter, 'joint');
    assert.deepEqual(snapshot.state.jointSelectedIds, ['Jadra']); assert.equal(get('recommend-input').value, '尚未提交的任务');
  }
  assert.equal(h.calls.filter(c => c.url === '/api/registry').length, 1); assert.equal(h.calls.filter(c => c.url === '/api/recommend').length, 0);
});
