import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBookFiles } from '../src/registry/sources.mjs';

test('v0.10 derived reading copies are labelled and listed after originals', async () => {
  const text = [
    'Reading copy: D:/work/Reading/book-agents/brosk-source/reading-copy.epub.',
    'Original: D:/work/Reading/ai/已处理/学会示例.mobi',
  ].join('\n');
  const files = await extractBookFiles(text, { exists: async () => true });
  assert.deepEqual(files.map(f => [f.index, f.ext, f.derived === true, f.label]), [
    [0, 'mobi', false, '学会示例'],
    [1, 'epub', true, 'reading-copy（阅读副本）'],
  ]);
});
