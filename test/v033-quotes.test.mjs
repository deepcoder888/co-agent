import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFrom } from './fixtures/dom.mjs';
import { READING_QUOTES, pickReadingQuote, readingQuote } from '../public/display.js';
import * as shelf from '../public/layouts/shelf.js';

test('v033 quotes: the original line plus 20 more, each unique, attributed and short enough for the tray', () => {
  assert.equal(READING_QUOTES.length, 21);
  assert.deepEqual(READING_QUOTES[0], { text: '读一切好书，就像与过去几个世纪最高尚的人交谈。', source: '笛卡尔' });
  assert.equal(new Set(READING_QUOTES.map(q => q.text)).size, 21, 'no duplicate lines');
  for (const { text, source } of READING_QUOTES) {
    assert.match(text, /[。？！]$/, text); assert.ok(source.trim(), text);
    assert.ok(Array.from(`${text}——${source}`).length <= 30, `fits the tray: ${text}`);
  }
  assert.ok(Object.isFrozen(READING_QUOTES));
});

test('v033 quotes: picked uniformly with the attribution appended, including the edges of random()', () => {
  assert.equal(pickReadingQuote(() => 0), '读一切好书，就像与过去几个世纪最高尚的人交谈。——笛卡尔');
  assert.equal(pickReadingQuote(() => 0.9999999), '如果说我看得更远，那是因为站在巨人的肩上。——牛顿');
  assert.equal(pickReadingQuote(() => 1), '如果说我看得更远，那是因为站在巨人的肩上。——牛顿', 'never out of range');
  assert.equal(pickReadingQuote(() => 4 / 21 + 1e-9), '温故而知新，可以为师矣。——《论语》');
  assert.ok(READING_QUOTES.some(q => readingQuote === `${q.text}——${q.source}`), 'the launch quote comes from the list');
});

test('v033 quotes: the empty shelf desk tray shows this launch\'s quote and keeps it across renders', () => {
  const doc = documentFrom('<html><body></body></html>');
  const state = { view: 'catalog', category: 'all', query: '', sort: 'default', selectedId: null,
    jointSelectedIds: [], allAgents: [], categories: [], detailOpen: false };
  const ctx = { doc, state, refs: {}, actions: {} };
  ctx.root = shelf.render(ctx); doc.body.append(ctx.root);
  const model = { title: '藏书', agents: [], query: '', sort: 'default', categories: [] };
  shelf.renderCatalog(ctx, model);
  const tray = ctx.refs['tray-selected'];
  assert.equal(tray.textContent, readingQuote);
  shelf.renderCatalog(ctx, model); assert.equal(tray.textContent, readingQuote, 'stable while the app is open');
});
