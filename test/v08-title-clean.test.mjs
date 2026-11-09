import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSnapshot } from '../src/concepts/index.mjs';

const agent = title => ({ id: 'x', name: 'X', platforms: { codex: { name: 'X' } }, book: { title, author: 'A' } });

test('v08 concept snapshot cleans registry titles for prompts and labels', () => {
  const zh = agentSnapshot(agent('《一条示例的路：示例成熟的旅程》'));
  assert.equal(zh.title, '一条示例的路：示例成熟的旅程');
  assert.equal(zh.bookRef, '《一条示例的路：示例成熟的旅程》');
  assert.equal(zh.bookLabel, '《一条示例的路：示例成熟的旅程》');
  const en = agentSnapshot(agent('*Dear Sample*'));
  assert.equal(en.title, 'Dear Sample'); assert.equal(en.bookRef, '《Dear Sample》');
  const multi = agentSnapshot(agent('多书，2 部：《示例头等大事》；《周期》'));
  assert.equal(multi.title, '示例头等大事'); assert.equal(multi.bookRef, '《示例头等大事》；《周期》');
  assert.equal(multi.bookLabel, '示例头等大事 等 2 本');
  assert.ok(![zh, en, multi].some(s => /《《|》》|\*/.test(s.bookRef + s.bookLabel)));
});
