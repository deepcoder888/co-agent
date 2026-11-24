import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// 2026-11-24: on bento's dark ask tile the room entries (开个研讨会 →, 会诊室 →, …) fell back to the global white button
// with the tile's near-white text, because v0.40 removed their rule together with the old seminar page.
const root = new URL('../', import.meta.url);

test('v05317 bento: the room entries on the dark ask tile have their own gold text-link look, and 微立体 leaves them as links', async () => {
  const js = await fs.readFile(new URL('public/layouts/bento.js', root), 'utf8');
  assert.ok((js.match(/className = 'bento-seminar-entry'/g) || []).length >= 5, 'the five room entries use the class');
  const css = await fs.readFile(new URL('public/layouts/bento.css', root), 'utf8');
  const rule = css.match(/\[data-ui="bento"\] \.bento-seminar-entry \{([^}]*)\}/);
  assert.ok(rule, 'bento styles the entries itself');
  assert.match(rule[1], /color:#f0b44c/); assert.match(rule[1], /background:transparent/); assert.match(rule[1], /border:0/);
  const depth = await fs.readFile(new URL('public/depth.css', root), 'utf8');
  assert.doesNotMatch(depth, /\.bento-seminar-entry/, 'text links get no raised look');
});
