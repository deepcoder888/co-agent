import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const css = await fs.readFile(new URL('../public/layouts/shelf.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\[data-ui="shelf"\\] ${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `missing rule ${selector}`); return match[1];
};

test('v028 D: room links drop the underline and warm on hover', () => {
  const link = rule('.shelf-link');
  assert.match(link, /text-decoration:\s*none/);
  assert.doesNotMatch(css, /text-decoration:\s*underline;\s*\n?\s*text-underline-offset/);
  assert.match(rule('.shelf-link:hover:enabled'), /color:\s*#f2c879[\s\S]*background:\s*rgba\(242,200,121,\.09\)/);
  assert.match(rule('.shelf-icon'), /stroke:\s*currentColor/);
  assert.match(rule('.shelf-reading-pill'), /border-radius:\s*16px/);
  assert.match(rule('.shelf-chevron'), /border-radius:\s*50%/);
});
