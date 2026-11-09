import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// v0.49.1 (2026-11-08): 书本展示 sits on the dialog background, which is dark in 书房, so its text takes the
// layout's --text/--muted. The --picker-* colors are for the white theme cards only.
test('v0491 书本展示 and 备份 in settings use the layout text colors', async () => {
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter(line => /^#settings-dialog \.settings-(book-text|backup)\S* .*color:/.test(line));
  assert.ok(rules.length >= 6, 'the section rules are found');
  for (const rule of rules) assert.doesNotMatch(rule, /color:var\(--picker-(ink|muted)\)/, rule);
  for (const layout of ['threepane', 'bento', 'editorial', 'shelf']) {
    const own = await fs.readFile(new URL(`../public/layouts/${layout}.css`, import.meta.url), 'utf8');
    assert.match(own, /--text:/, `${layout} defines --text`); assert.match(own, /--muted:/, `${layout} defines --muted`);
  }
});
