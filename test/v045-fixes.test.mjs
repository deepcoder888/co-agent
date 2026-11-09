import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chapterMarkdown } from '../src/books/epub.mjs';
import { validateConcept } from '../src/concepts/runner.mjs';
import { checkSources } from '../src/registry/sources.mjs';
import { responseBody } from '../public/display.js';
import { conceptResponse } from '../public/layouts/shared.js';
import { mountBookReader } from '../public/book-reader.js';
import { appDocument } from './fixtures/app.mjs';

test('v0.45.1 an EPUB table keeps its row headers in the first column (Spievo, chapter 49)', () => {
  const md = chapterMarkdown(`<html><body><table>
    <tr><th/><th>Negative</th><th>Positive</th></tr>
    <tr><th scope="row">Cognitive aspects</th><td/><td/></tr>
    <tr><td/><td>Threat</td><td>Opportunity</td></tr>
    <tr><td>a</td><th>b</th><td>c</td></tr></table></body></html>`, 'OEBPS/t.xhtml');
  assert.match(md, /^\| Cognitive aspects \| {3}\| {3}\|$/m, 'the row header stays first');
  assert.match(md, /^\| a \| b \| c \|$/m, 'cells keep document order whatever their tag');
});

test('v0.45.1 a daily concept the agent could not write reports the agent\'s reason, not a JSON format error', () => {
  const declined = { concept: '', conceptEn: null, oneLine: 'Zevo 未能完成：绑定的原始 PDF 缺失，来源校验未通过。', whyUnknown: '', sourceRefs: [],
    markdown: '## Direct Answer\n\n无法生成。\n\nSTATUS: NEEDS_REVALIDATION', term: { zh: '不要使用这一轮概', en: 'Failed generation', fr: 'Échec' }, response: { stance: '无', text: '' } };
  assert.throws(() => validateConcept(declined), /^Error: Agent 未能生成概念：Zevo 未能完成：绑定的原始 PDF 缺失，来源校验未通过。$/);
  assert.throws(() => validateConcept({ ...declined, oneLine: '长'.repeat(500) }), error => Array.from(error.message.split('：')[1]).length === 200, 'the reason is clipped');
  // Anything short of a stated refusal is still a format error naming its field.
  assert.throws(() => validateConcept({ ...declined, oneLine: ' ' }), /概念 JSON 格式无效：concept 为空/);
  assert.throws(() => validateConcept({ ...declined, sourceRefs: ['第1章'] }), /概念 JSON 格式无效：concept 为空/);
});

test('v0.45.1 the 版本 menu names a reading copy once', async t => {
  const { doc } = await appDocument('threepane'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const files = [{ index: 0, label: 'Design for sample learners', format: 'pdf', exists: true, readable: true },
    { index: 1, label: 'reading-copy（阅读副本）', format: 'epub', exists: true, readable: true, derived: true },
    { index: 2, label: 'zevo-ocr-reading', format: 'epub', exists: true, readable: true, derived: true }];
  const book = { id: 'dirvo', name: 'Dirvo', kind: 'book', book: { title: 'Design for Sample Lessons', author: 'Jo Sample' },
    bookFiles: files.map(f => ({ index: f.index, label: f.label, path: `D:/x/${f.index}.${f.format}`, ext: f.format, exists: true })) };
  const api = async url => url.startsWith('/api/reading-progress') ? { progress: null }
    : { agentId: 'dirvo', index: 0, format: 'pdf', label: files[0].label, pdf: '/api/books/dirvo/0/pdf', files };
  const reader = mountBookReader(doc, { api, getRegistry: () => ({ agents: [book] }), setTimer: () => 0, clearTimer: () => {} }); t.after(() => reader.dispose());
  await reader.open('dirvo');
  const labels = doc.getElementById('book-reader-file').querySelectorAll('option').map(o => o.textContent);
  assert.deepEqual(labels, ['PDF · Design for sample learners', 'EPUB · reading-copy（阅读副本）', 'EPUB · zevo-ocr-reading（阅读副本）']);
  assert.doesNotMatch(await fs.readFile('public/book-reader.js', 'utf8'), /识别版/);
});

test('v0.45.2 a path followed by English prose counts as present when its file exists (Baiyo, Rumvo)', async () => {
  const readme = 'D:/work/Reading/示例书（畅销版）/analogies/README.md';
  const text = `The optional report at ${readme} supplies claim links/statuses as REPORT, outside the sealed binding.`;
  const present = async file => file === readme;
  assert.deepEqual((await checkSources(text, { exists: present })).missing, []);
  // A file that really is absent is still reported by its whole name.
  assert.deepEqual((await checkSources(text, { exists: async () => false })).missing, [readme]);
});

test('v0.45.3 a response that opens by restating its stance drops that opening (daily concepts 2026-10-26 to 11-03)', async () => {
  for (const [text, body] of [['补充。药物身份链能先固定讨论对象', '药物身份链能先固定讨论对象'], ['补充：书中的评估实践说明', '书中的评估实践说明'],
    ['我补充：归属还存在一个“判断门槛”', '归属还存在一个“判断门槛”'], ['我选择“补充”。身份投票说明行动', '身份投票说明行动'], ['反驳，书中', '书中']]) assert.equal(responseBody(text), body);
  // A stance word that starts the argument itself stays.
  for (const text of ['我赞同先用内部证据计分', '我赞同“群体比例”会改变互动压力', '《如何整理示例》第1章指出']) assert.equal(responseBody(text), text);
  const lecture = { concept: '新概念', conceptEn: null, oneLine: '一句话', whyUnknown: '原因', sourceRefs: ['第1章'], markdown: '正文', term: null };
  const reason = '《示例之外》第6章指出，证据要与具体问题相关，来源与方法要可靠，判断的强度要与证据相称。'.repeat(2);
  const target = { respondsTo: { day: '2026-11-02', concept: '药物身份链' } };
  assert.equal(validateConcept({ ...lecture, response: { stance: '补充', text: `补充。${reason}` } }, target).response.text, reason);
  // The length rule applies to the body without the restated stance.
  assert.equal(validateConcept({ ...lecture, response: { stance: '补充', text: `补充。${Array.from(reason).slice(0, 58).join('')}` } }, target).responseError, '回应须为 60–400 字');
  const { doc } = await appDocument('threepane'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const card = conceptResponse({ doc, actions: {} }, { conceptId: 'c', respondsTo: { conceptId: 't', ...target.respondsTo, agent: { bookLabel: 'BMA' } }, result: { response: { stance: '补充', text: `补充。${reason}` } } });
  assert.equal(card.querySelector('p').textContent, reason);
});

test('v0.45.4 a running answer ends with a writing pen nib, still in reduced motion', async () => {
  const css = await fs.readFile('public/styles.css', 'utf8');
  const rule = /\.chat-answer\.status-running \.chat-streaming::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /mask:url\(pen\.svg\)/); assert.match(rule, /animation:chat-pen /);
  assert.match(await fs.readFile('public/pen.svg', 'utf8'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/);
  assert.match(css, /@keyframes chat-pen /); assert.doesNotMatch(css, /chat-caret/);
  assert.match(css, /\.chat-answer, \.chat-answer\.status-running \.chat-streaming::after \{ animation:none; \}/);
});
