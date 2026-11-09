import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// The shelf staff row (11 colleagues) is wider than the window; arrows reveal the hidden staff (2026-10-09).

async function mount(t) {
  // A minimal app mount with the 11 staff roles; scroll geometry is simulated below.
  const { documentFrom } = await import('./fixtures/dom.mjs');
  const { mountApp } = await import('../public/app.js');
  const html = (await fs.readFile('public/index.html', 'utf8')).replace('<!-- AGENT_HUB_TOKEN -->', '<meta name="agent-hub-token" content="arrow-test">');
  const doc = documentFrom(html); doc.documentElement.setAttribute('data-ui', 'shelf');
  const roles = ['-ark','-jason','-steven','-jack','-albert','Peter','Loki','-Alan','-Ames','-Ben','-Monsey'].map(name => ({ id: name.replace(/^-/, '').toLowerCase(), name, kind: 'role',
    primary: '功能性 Agent', purpose: '用途', description: '说明', tags: [], permissions: {}, platforms: { claude: { available: true }, codex: { available: true } }, sources: { checked: true, missing: [] }, sync: { state: '同步' } }));
  const registry = { agents: roles, categories: [], summary: { roles: 11, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  const app = await mountApp(doc, async url => ({ ok: true, json: async () => url === '/api/registry' ? registry
    : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui: 'shelf' } : { items: [], unavailable: [] } }), { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, get: id => doc.getElementById(id) };
}

test('v017 shelf staff arrows show only toward hidden staff and scroll the row', async t => {
  const { get } = await mount(t);
  const row = get('shelf-staff'), prev = get('shelf-staff-prev'), next = get('shelf-staff-next'), strip = get('shelf-staff-strip');
  assert.ok(prev && next && strip); assert.equal(row.parentElement, strip);
  assert.equal(next.getAttribute('aria-label'), '向右查看更多同事'); assert.equal(prev.getAttribute('aria-label'), '向左查看更多同事');
  // Simulate layout: 11 cards (148px + 12px gap) in a 1000px viewport.
  Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(row, 'scrollWidth', { value: 11 * 160 - 12, configurable: true });
  row.scrollLeft = 0; row.fire ? await row.fire('scroll') : null;
  assert.equal(prev.hidden, true); assert.equal(next.hidden, false); assert.match(strip.className, /can-right/);
  await next.fire('click');
  assert.ok(row.scrollLeft > 0, 'next scrolls right'); assert.equal(prev.hidden, false);
  row.scrollLeft = 11 * 160 - 12 - 1000; await row.fire('scroll');
  assert.equal(next.hidden, true); assert.equal(prev.hidden, false); assert.match(strip.className, /can-left/); assert.doesNotMatch(strip.className, /can-right/);
  await prev.fire('click'); assert.ok(row.scrollLeft < 11 * 160 - 12 - 1000, 'prev scrolls left');
  // When everything fits, no arrows at all.
  Object.defineProperty(row, 'scrollWidth', { value: 900, configurable: true }); row.scrollLeft = 0; await row.fire('scroll');
  assert.equal(prev.hidden, true); assert.equal(next.hidden, true); assert.equal(strip.className, 'staff-strip');
});

test('v017 shelf staff arrow styles use classes only and respect reduced motion', async () => {
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\.staff-arrow\[hidden\]\s*\{\s*display:none;/);
  assert.match(css, /prefers-reduced-motion:reduce\)\s*\{\s*\[data-ui="shelf"\] \.staff-arrow \{ transition:none; \}/);
  const js = await fs.readFile('public/layouts/shelf.js', 'utf8');
  assert.doesNotMatch(js, /setAttribute\('style'/);
});
