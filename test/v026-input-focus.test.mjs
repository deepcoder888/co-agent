import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('v026 text fields drop the focus ring everywhere; checkboxes and radios keep it', async () => {
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /:is\(input:not\(\[type=checkbox\],\[type=radio\]\),textarea\):focus \{ outline:none !important; \}/);
  assert.match(css, /input:focus-visible[^{]*\{\s*outline:3px solid var\(--focus\)/);
});
