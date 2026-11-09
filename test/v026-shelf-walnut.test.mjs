import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spinePalette } from '../public/layouts/shelf.js';

const css = await fs.readFile(new URL('../public/layouts/shelf.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\[data-ui="shelf"\\] ${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `missing rule ${selector}`); return match[1];
};

test('v026 book rows wrap onto new shelves instead of scrolling sideways', () => {
  const row = rule('.book-row');
  assert.match(row, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(row, /overflow-x|scrollbar-width|(?<![-\w])height:/);
  assert.match(row, /row-gap:\s*var\(--plank\)/);
  // One tile per slot plus plank repeats down the row, so every wrapped line gets its own plank.
  assert.match(row, /background-repeat:\s*repeat-y/);
  assert.match(row, /background-size:\s*100% calc\(var\(--slot\) \+ var\(--plank\)\)/);
  assert.match(css, /\.book-row > \.shelf-item,\s*\n?\[data-ui="shelf"\] \.book-row > p \{[^}]*height:\s*var\(--slot\)/);
});

test('v026 spines share one palette with gilt titles and bands', () => {
  assert.equal(spinePalette.length, 8);
  assert.equal(new Set(spinePalette).size, 8);
  for (const color of spinePalette) assert.match(color, /^#[\da-f]{6}$/);
  const spine = rule('.book-spine');
  assert.match(spine, /color:\s*#e6c98a/);
  assert.match(spine, /background:\s*var\(--spine-shade\), var\(--book-color/);
  assert.doesNotMatch(css, /--spine-bg|\.book-spine\[data-agent=/);
  assert.match(css, /\.book-spine::before,\s*\n?\[data-ui="shelf"\] \.book-spine::after \{[^}]*content:\s*""[^}]*pointer-events:\s*none/);
});

test('v026 colleague cards are walnut plaques with a gilt focus ring', () => {
  const badge = rule('.staff-badge');
  assert.match(badge, /background:\s*var\(--plaque\)/);
  assert.match(badge, /color:\s*#ead8b4/);
  assert.doesNotMatch(badge, /#f3e9d8/);
  assert.match(rule('.staff-badge:hover:enabled'), /background:\s*var\(--plaque\)/);
  assert.match(rule('.staff-badge:focus-visible'), /outline:\s*2px solid #f2c879/);
});
