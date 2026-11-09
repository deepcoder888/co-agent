import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, bookLabel, spineTitle, authorShort, summary, categoryShort, avatarColor } from '../public/display.js';

test('P1 display titles clean Markdown, Chinese brackets and multi-book prefixes without losing count', () => {
  assert.deepEqual(cleanTitle('**《示例工坊》**'), { text: '示例工坊', multi: 1 });
  assert.deepEqual(cleanTitle('_Dear Sample_'), { text: 'Dear Sample', multi: 1 });
  assert.deepEqual(cleanTitle('多书，4 部：《A》；《B》；《C》；《D》'), { text: 'A', multi: 4 });
  assert.equal(bookLabel({ book: { title: '《示例工坊》' } }), '《示例工坊》');
  assert.equal(bookLabel({ book: { title: '*Dear Sample*' } }), 'Dear Sample');
  assert.equal(bookLabel({ book: { title: '多书，2 部：《原则》；《世界秩序》' } }), '原则 等 2 本');
  assert.equal(spineTitle({ book: { title: '*Dear Sample: The Science*' } }), 'Dear Sample');
  assert.equal(spineTitle({ book: { title: '《示例工坊：如何示例》' } }), '示例工坊');
  assert.deepEqual(cleanTitle(''), { text: '', multi: 1 });
});
test('P1 authors, safe compact summaries and category names', () => {
  assert.equal(authorShort({ book: { author: 'G. Sample、N. Sample 主编；多作者教材' } }), 'G. Sample、N. Sample');
  assert.equal(authorShort({ book: { author: '分别为 A；B；C；D' } }), 'A、B');
  assert.equal(summary('正文第一段。\n\n第二段\n<example>触发文本</example>'), '正文第一段。');
  assert.equal(summary('<example>secret</example>\n正文\n\nuser: "不要显示"'), '正文');
  assert.ok(Array.from(summary('长'.repeat(200))).length <= 160);
  assert.equal(summary(''), '');
  assert.equal(categoryShort('投资／金融与金钱管理'), '投资／金融');
  assert.equal(categoryShort('睡眠／健康／运动'), '睡眠／健康');
  assert.equal(categoryShort('软件工程'), '软件工程');
});
test('P1 avatar pigments depend on id, not order or current category', () => {
  const palette = new Set(['#3949ab','#00796b','#ef6c00','#ad1457','#5d4037','#2e7d32','#6a1b9a','#0277bd']);
  for (const id of ['Walvo','Jadra','中文','a','b','c','d']) {
    assert.ok(palette.has(avatarColor(id))); assert.equal(avatarColor(id), avatarColor(id));
  }
  assert.ok(new Set(['a','b','c','d','e','f','g','h'].map(avatarColor)).size > 4);
});

test('P1 summary removes quoted trigger examples without deleting quoted terms in prose', () => {
  assert.equal(summary('解释睡眠。触发示例：“Walvo，解释睡眠压力。”'), '解释睡眠。');
  assert.equal(summary('Sleep agent. Trigger examples: "Walvo, help me."'), 'Sleep agent.');
  assert.equal(summary('解释“睡眠压力”这个概念。'), '解释“睡眠压力”这个概念。');
  assert.equal(authorShort('分别为 甲 主编；乙；丙'), '甲、乙');
});
