import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { createApp } from '../src/server.mjs';
import { readSettings, writeSettings, DEPTH_OPTIONS } from '../src/settings.mjs';
import { mountSettings } from '../public/settings.js';

// 2026-11-24 微立体: buttons, cards and tags can look raised (public/depth.css); settings.json `depth`, <html data-depth>.
const root = new URL('../', import.meta.url);

test('v05316 settings: depth is off by default, saved on its own, invalid values 400, an invalid stored value reads as off', async t => {
  // After hooks run in registration order: close the app before the fixture folder is removed.
  let app; t.after(() => app?.close());
  const { config } = await fixture(t);
  const registry = { agents: [], categories: [], summary: { books: 0, roles: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => registry }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const put = body => fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token }, body: JSON.stringify(body) });
  const first = await (await fetch(base + '/api/settings')).json();
  assert.equal(first.depth, 'off'); assert.deepEqual(first.depthOptions, ['off', 'soft', 'bevel', 'neu', 'clay']);
  assert.match(await (await fetch(base + '/')).text(), / data-depth="off">/);
  const saved = await (await put({ depth: 'bevel' })).json();
  assert.equal(saved.depth, 'bevel'); assert.equal(saved.ui, first.ui, 'the look alone leaves the layout');
  assert.equal((await (await put({ bookText: 120 })).json()).depth, 'bevel', 'another setting alone leaves the look');
  assert.match(await (await fetch(base + '/')).text(), / data-depth="bevel">/);
  assert.equal((await readSettings(config.dataDir)).depth, 'bevel');
  for (const bad of [{ depth: 'glass' }, { depth: '' }, { depth: 1 }]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  await fs.writeFile(path.join(config.dataDir, 'settings.json'), JSON.stringify({ version: 1, ui: 'bento', bookText: 100, depth: 'shiny' }));
  assert.equal((await readSettings(config.dataDir)).depth, 'off');
  await assert.rejects(writeSettings(config.dataDir, 'shelf', 100, undefined, 'shiny'), { status: 400 });
});

test('v05316 settings dialog: a choice shows on the page at once, is saved, and a failed save puts the saved look back', async t => {
  const { doc } = await appDocument('shelf');
  doc.documentElement.setAttribute('data-depth', 'soft');
  let fail = false; const sent = [];
  const settings = mountSettings(doc, async (url, opts) => { sent.push(JSON.parse(opts.body));
    return fail ? { ok: false, status: 500, json: async () => ({ error: '磁盘满' }) } : { ok: true, json: async () => ({ ui: 'shelf', depth: JSON.parse(opts.body).depth }) }; }, { confirm: async () => true });
  t.after(() => settings.dispose());
  const inputs = doc.querySelectorAll('input[name="settings-depth"]');
  assert.deepEqual(inputs.map(i => i.value), DEPTH_OPTIONS);
  assert.deepEqual(inputs.filter(i => i.checked).map(i => i.value), ['soft'], 'the saved look is the checked one');
  const pick = value => inputs.find(i => i.value === value);
  const neu = pick('neu'); neu.checked = true; await neu.fire('change');
  assert.equal(doc.documentElement.getAttribute('data-depth'), 'neu'); assert.deepEqual(sent, [{ depth: 'neu' }]);
  assert.equal(doc.getElementById('settings-depth-status').textContent, '已保存');
  fail = true; const clay = pick('clay'); clay.checked = true; await clay.fire('change');
  assert.equal(doc.documentElement.getAttribute('data-depth'), 'neu', 'the saved look comes back');
  assert.equal(pick('neu').checked, true); assert.equal(pick('clay').checked, false);
  assert.match(doc.getElementById('settings-depth-status').textContent, /保存失败，已恢复原样式：磁盘满/);
});

test('v05316 depth.css: loaded after the layouts, four looks, reading modes and off untouched, each sample drawn in its own look', async () => {
  const html = await fs.readFile(new URL('public/index.html', root), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);
  assert.equal(sheets.at(-1), '/depth.css', 'after every layout, so its rules win ties');
  const css = await fs.readFile(new URL('public/depth.css', root), 'utf8');
  for (const look of ['soft', 'bevel', 'neu', 'clay']) {
    const head = `[data-depth="${look}"] *, .depth-preview[data-depth="${look}"] * {`;
    assert.ok(css.includes(head), look);
    const block = css.split(head)[1].split('}')[0];
    for (const v of ['--d-btn:', '--d-press:', '--d-card:', '--d-chip:']) assert.ok(block.includes(v), `${look} ${v}`);
  }
  const rules = css.match(/:root\[data-ui\]:not\(\[data-depth="off"\]\)[^{]+\{/g);
  assert.ok(rules.length >= 4, 'every rule that draws a look is switched off by off');
  for (const rule of rules.filter(r => /button/.test(r))) assert.match(rule, /:not\(dialog\.shelf-reader \*\)/, 'the reading modes stay flat');
  assert.doesNotMatch(css, /\.book-spine|\.staff-badge|#navigation|\.mail-row/, 'drawn objects, navigation and list rows are not touched');
  // Each choice in 设置 carries its own data-depth, so its sample shows that look whatever look is in use.
  const options = [...html.matchAll(/<span class="depth-preview" data-depth="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(options, DEPTH_OPTIONS);
});
