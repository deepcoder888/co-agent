import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { docxToMarkdown } from '../src/reports/docx.mjs';
import { createReports, reportKey } from '../src/reports/index.mjs';
import { createApp } from '../src/server.mjs';
import { mountApp } from '../public/app.js';

// A minimal .docx: a ZIP with deflated parts, written the way Word does (local headers, central directory, end record).
function docx(parts) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw), file = Buffer.from(name, 'utf8'), crc = zlib.crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(file.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(file.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, file, data); central.push(entry, file); offset += 30 + file.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const p = (style, runs, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${runs}</w:p>`;
const r = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const list = (id, text) => p('', r(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`);
const cell = (text, props = '') => `<w:tc><w:tcPr>${props}</w:tcPr>${p('', r(text))}</w:tc>`;
function report(title = 'Dear Sample', body = '') {
  return docx({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>
      ${p('Title', r(title))}${p('Subtitle', r('全书论证审计'))}
      ${p('TOCHeading', r('目录'))}${p('TOC1', `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('PART I 3')}`)}
      ${p('', `<w:r><w:fldChar w:fldCharType="end"/></w:r>`)}
      ${p('Heading1', r('PART I · 论证'))}${p('Heading2', r('Executive summary'))}
      ${p('', r('Book content:', '<w:b/>') + r(' 失眠 &amp; 睡眠 ') + r('斜体', '<w:i/>') + r(' *星号* | 竖线 [括号]') + r('隐藏', '<w:vanish/>'))}
      ${p('', `<w:hyperlink r:id="rIdLink">${r('来源')}</w:hyperlink>` + r('，') + `<w:hyperlink r:id="rIdBad">${r('坏链接')}</w:hyperlink>`)}
      ${p('', r('# 不是标题'))}
      ${list(1, '要点一')}${list(1, '要点二')}${list(2, '步骤一')}${list(2, '步骤二')}
      ${p('Heading3', r('Table of contents'))}
      <w:tbl><w:tr>${cell('概念')}${cell('定义')}${cell('备注')}</w:tr>
        <w:tr>${cell('跨两列', '<w:gridSpan w:val="2"/>')}${cell('上', '<w:vMerge w:val="restart"/>')}</w:tr>
        <w:tr>${cell('甲')}${cell('乙')}${cell('', '<w:vMerge/>')}</w:tr></w:tbl>
      ${p('Heading4', r('细节'))}${p('', '<w:r><w:drawing/></w:r>' + r('图后文字'))}
      <w:sectPr/></w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}>${['Title:Title', 'Subtitle:Subtitle', 'TOCHeading:TOC Heading', 'TOC1:toc 1', 'Heading1:heading 1', 'Heading2:heading 2', 'Heading3:heading 3', 'Heading4:heading 4']
      .map(pair => { const [id, name] = pair.split(':'); return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`; }).join('')}</w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num></w:numbering>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdLink" Type="hyperlink" Target="https://example.test/source" TargetMode="External"/>
      <Relationship Id="rIdBad" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
  });
}

test('v021 docx: title, headings, inline marks, links, lists and tables become Markdown; Word TOC and field codes are dropped', () => {
  const out = docxToMarkdown(report());
  assert.equal(out.title, 'Dear Sample'); assert.equal(out.subtitle, '全书论证审计');
  assert.deepEqual(out.notices, ['图片或嵌入对象未显示']);
  const md = out.markdown;
  assert.doesNotMatch(md, /目录|PART I 3|TOC|Dear Sample|全书论证审计/, 'title/subtitle go to the masthead; the static TOC and its field codes are skipped');
  assert.match(md, /^## PART I · 论证$/m); assert.match(md, /^### Executive summary$/m); assert.match(md, /^#### Table of contents$/m); assert.match(md, /^##### 细节$/m);
  assert.match(md, /\*\*Book content:\*\* 失眠 & 睡眠 \*斜体\* \\\*星号\\\* \\\| 竖线 \\\[括号\\\]/);
  assert.doesNotMatch(md, /隐藏/);
  assert.match(md, /\[来源\]\(https:\/\/example\.test\/source\)，坏链接/, 'only http(s) targets become links');
  assert.match(md, /^\\# 不是标题$/m);
  assert.match(md, /^- 要点一\n- 要点二\n\n1\. 步骤一\n2\. 步骤二$/m);
  assert.match(md, /\| 概念 \| 定义 \| 备注 \|\n\| --- \| --- \| --- \|\n\| 跨两列 \|   \| 上 \|\n\| 甲 \| 乙 \|   \|/);
  assert.match(md, /［图片未显示］图后文字/);
});

test('v021 docx: damaged or non-Word input fails with a 422 and a readable reason', () => {
  for (const input of [Buffer.from('not a zip'), docx({ 'word/other.xml': '<x/>' }), report().subarray(0, 200)]) {
    assert.throws(() => docxToMarkdown(input), error => error.status === 422 && /Word 文件/.test(error.message));
  }
});

async function reportsFixture(t) {
  const { root } = await fixture(t), dir = path.join(root, 'word'), mappingFile = path.join(root, 'book-reports.json');
  await put(mappingFile, JSON.stringify({ directory: dir, agents: {
    jadra: [{ label: 'Dear Sample', prefix: 'Dear Sample' }],
    marvo: [{ label: '示例头等大事', prefix: '示例头等大事' }, { label: '周期', prefix: '周期' }],
    petvo: [{ label: '示例十二条目', prefix: '示例十二条目', exclude: ['示例十二条目2'] }],
  } }));
  const write = async (name, title, minutesAgo) => {
    const file = path.join(dir, name); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, report(title));
    const at = new Date(Date.now() - minutesAgo * 60000); await fs.utimes(file, at, at); return file;
  };
  await write('Dear Sample-deepbooker.docx', 'Dear Sample 旧版', 30);
  await write('Dear Sample-a-deepbooker-20261005-deepbooker.docx', 'Dear Sample 新版', 10);
  await write('Dear Sample-deepbooker.draft.docx', '草稿', 1);
  await write('.Dear Sample-staging.docx', '暂存', 1);
  await write('示例头等大事-deepbooker.docx', '示例头等大事', 20);
  await write('示例十二条目2-deepbooker.docx', '第二部', 5);
  return { dir, mappingFile, write };
}

test('v021 reports: the newest non-draft match wins, exclusions hold, missing books stay unavailable', async t => {
  const { dir, mappingFile } = await reportsFixture(t);
  const reports = createReports({ mappingFile }); await reports.load();
  assert.equal(reportKey('The Samples’ Call—How'), 'thesamplescallhow');
  const [jadra] = reports.describe('jadra');
  assert.equal(jadra.file, 'Dear Sample-a-deepbooker-20261005-deepbooker.docx'); assert.equal(jadra.available, true); assert.equal(jadra.label, 'Dear Sample');
  assert.deepEqual(reports.describe('marvo').map(r => [r.label, r.available]), [['示例头等大事', true], ['周期', false]]);
  assert.deepEqual(reports.describe('petvo').map(r => r.available), [false], '示例十二条目2 is excluded from 示例十二条目');
  assert.deepEqual(reports.describe('unknown'), []);
  const read = await reports.read('jadra', 0);
  assert.equal(read.title, 'Dear Sample 新版'); assert.equal(read.file, jadra.file); assert.match(read.markdown, /## PART I/);
  await assert.rejects(reports.read('marvo', 1), error => error.status === 404 && error.message === '暂无 Word 报告');
  await assert.rejects(reports.read('jadra', 7), error => error.status === 404);
  await assert.rejects(reports.read('__proto__', 0), error => error.status === 404);
  assert.ok((await fs.readdir(dir)).includes('Dear Sample-deepbooker.draft.docx'), 'reading never touches the source folder');
});

test('v021 reports: conversions are cached until the file changes, and a newer report is picked up without reloading', async t => {
  const { mappingFile, write } = await reportsFixture(t);
  let reads = 0;
  const io = { ...fs, readFile: async (...args) => { if (String(args[0]).endsWith('.docx')) reads++; return fs.readFile(...args); } };
  const reports = createReports({ mappingFile, io }); await reports.load();
  await reports.read('jadra', 0); await reports.read('jadra', 0);
  assert.equal(reads, 1);
  await write('Dear Sample-Adeepbooker-20261015-deepbooker.docx', 'Dear Sample 最新版', 0);
  assert.equal((await reports.read('jadra', 0)).title, 'Dear Sample 最新版'); assert.equal(reads, 2);
});

test('v021 HTTP: registry book agents carry reports; /api/reports serves Markdown and 404s anything else', async t => {
  let app; t.after(() => app?.close());
  const { config } = await fixture(t), { mappingFile } = await reportsFixture(t);
  const agent = (id, kind = 'book') => ({ id, name: id, kind, primary: '学习', book: kind === 'book' ? { title: '《书》', author: '作者' } : null, tags: [],
    platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
  app = await createApp(config, { conceptAutoDaily: false, reportOptions: { mappingFile },
    registryBuilder: async () => ({ agents: [agent('jadra'), agent('marvo'), agent('peter', 'role')], categories: ['学习'], summary: { books: 2, roles: 1 } }) });
  await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  const registry = await (await fetch(base + '/api/registry')).json();
  assert.equal(registry.agents.find(a => a.id === 'jadra').reports[0].available, true);
  assert.equal(registry.agents.find(a => a.id === 'peter').reports, undefined);
  const ok = await fetch(base + '/api/reports/jadra/0'); assert.equal(ok.status, 200);
  const body = await ok.json(); assert.equal(body.title, 'Dear Sample 新版'); assert.match(body.markdown, /### Executive summary/);
  for (const route of ['marvo/1', 'peter/0', 'nobody/0', 'jadra/x', 'jadra/0/extra', 'jadra/-1', '%E0%A4%A/0']) {
    assert.equal((await fetch(base + '/api/reports/' + route)).status, 404, route);
  }
});

function textNodes(doc) { doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; }; return doc; }
const member = (id, reports) => ({ id, name: id, kind: 'book', primary: '学习', book: { title: '《Dear Sample》', author: 'Jadra Woo' }, description: '说明', tags: [],
  platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' }, reports });
async function mounted(t, respond) {
  const { doc } = await appDocument('shelf'); textNodes(doc);
  const registry = { agents: [
    member('jadra', [{ index: 0, label: 'Dear Sample', available: true, file: 'Dear Sample-deepbooker.docx', updatedAt: '2026-10-05T02:00:00Z' }]),
    member('marvo', [{ index: 0, label: '示例头等大事', available: true, file: 'a.docx', updatedAt: '2026-10-05T02:00:00Z' }, { index: 1, label: '周期', available: false, file: null, updatedAt: null }]),
    member('arnova', []),
  ], categories: ['学习'], summary: { roles: 0, books: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };
  const requests = [];
  const app = await mountApp(doc, async url => {
    requests.push(url);
    if (url.startsWith('/api/reports/')) return respond(url);
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'shelf', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/groups' ? { groups: [] } : url.startsWith('/api/concepts?') ? { items: [], running: null, today: null } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  const buttons = () => [...doc.getElementById('detail-body').querySelectorAll('button')].filter(b => /Word/.test(b.textContent));
  return { doc, app, requests, buttons, reader: doc.getElementById('concept-reader') };
}

test('v021 shelf detail: one report reads "阅读本书的 Word", several are named, none is a disabled button', async t => {
  const h = await mounted(t, () => ({ ok: true, json: async () => ({}) }));
  await h.app.actions.openDetail('jadra');
  assert.deepEqual(h.buttons().map(b => [b.textContent, b.disabled]), [['阅读本书的 Word', false]]);
  assert.match(h.buttons()[0].title, /Dear Sample-deepbooker\.docx（更新于 2026-10-05/);
  const order = [...h.doc.getElementById('detail-body').querySelectorAll('button')].map(b => b.textContent);
  assert.ok(order.indexOf('阅读本书的 Word') === order.indexOf('打开原书') + 1, 'placed right after 打开原书');
  h.app.actions.closeDetail(); await h.app.actions.openDetail('marvo');
  assert.deepEqual(h.buttons().map(b => [b.textContent, b.disabled, b.title]), [['阅读 Word：示例头等大事', false, 'a.docx（更新于 2026-10-05 10:00:00）'], ['阅读 Word：周期', true, '暂无 Word 报告']]);
  h.app.actions.closeDetail(); await h.app.actions.openDetail('arnova');
  assert.deepEqual(h.buttons().map(b => [b.textContent, b.disabled, b.title]), [['阅读本书的 Word', true, '暂无 Word 报告']]);
  assert.ok(!h.requests.some(url => url.startsWith('/api/reports/')), 'no report is read until asked');
});

test('v021 shelf detail: the report opens in the reading mode, loading first, then title, outline and body', async t => {
  let release;
  const h = await mounted(t, url => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ...docxToMarkdown(report()), file: 'Dear Sample-deepbooker.docx', updatedAt: '2026-10-05T02:00:00Z', url }) }); }));
  await h.app.actions.openDetail('jadra');
  const trigger = h.buttons()[0]; trigger.focus();
  const opening = trigger.fire('click');
  assert.equal(h.reader.open, true);
  assert.equal(h.doc.querySelector('.shelf-reader-status').textContent, '正在读取 Word 报告…');
  release(); await opening;
  assert.ok(h.requests.includes('/api/reports/jadra/0'));
  assert.equal(h.doc.getElementById('concept-reader-title').textContent, 'Dear Sample');
  const masthead = h.doc.getElementById('concept-reader-masthead').textContent;
  assert.match(masthead, /Word 报告 · 更新于 2026-10-05/); assert.match(masthead, /全书论证审计/); assert.match(masthead, /《Dear Sample》 · Jadra Woo · 由 jadra 讲解 · Dear Sample-deepbooker\.docx/);
  assert.match(h.doc.querySelector('.shelf-reader-notice').textContent, /图片/);
  assert.deepEqual([...h.doc.getElementById('concept-reader-toc-list').children].map(b => b.textContent), ['PART I · 论证', 'Executive summary']);
  assert.equal(h.doc.getElementById('concept-reader-body').querySelectorAll('table').length, 1);
  await h.doc.getElementById('concept-reader-exit').fire('click');
  assert.equal(h.reader.open, false); assert.equal(h.doc.activeElement.textContent, '阅读本书的 Word');
});

test('v021 shelf detail: a failed read is shown in the reader, and a late answer after closing is ignored', async t => {
  let answer;
  const h = await mounted(t, () => new Promise(resolve => { answer = resolve; }));
  await h.app.actions.openDetail('jadra');
  let opening = h.buttons()[0].fire('click');
  answer({ ok: false, status: 404, json: async () => ({ error: '暂无 Word 报告' }) }); await opening;
  assert.equal(h.doc.querySelector('.shelf-reader-status').textContent, 'Word 报告读取失败：暂无 Word 报告');
  h.reader.close();
  opening = h.buttons()[0].fire('click'); h.reader.close();
  answer({ ok: true, json: async () => ({ ...docxToMarkdown(report('迟到的报告')), file: 'x.docx', updatedAt: '2026-10-05T02:00:00Z' }) }); await opening;
  assert.equal(h.reader.open, false); assert.notEqual(h.doc.getElementById('concept-reader-title').textContent, '迟到的报告');
});

test('v0.41.4 the Word report reader hides its collapsed outline rail after 3 s like the book reader, and the left edge brings it back', async t => {
  const h = await mounted(t, () => ({ ok: true, json: async () => ({ ...docxToMarkdown(report()), file: 'Dear Sample-deepbooker.docx', updatedAt: '2026-10-05T02:00:00Z' }) }));
  await h.app.actions.openDetail('jadra'); await h.buttons()[0].fire('click');
  const edge = h.reader.querySelector('.shelf-reader-edge'); assert.ok(edge);
  await h.doc.getElementById('concept-reader-toc-toggle').fire('click');
  assert.doesNotMatch(h.reader.className, /is-rail-hidden/);
  await new Promise(resolve => setTimeout(resolve, 3150));
  assert.match(h.reader.className, /is-rail-hidden/, 'gone after 3 s');
  await edge.fire('mouseenter'); await new Promise(resolve => setTimeout(resolve, 150));
  assert.doesNotMatch(h.reader.className, /is-rail-hidden/, 'back from the left edge');
  await h.doc.getElementById('concept-reader-toc-toggle').fire('click');
  h.reader.close(); assert.equal(h.reader.className, 'shelf-reader', 'closing leaves no hidden state behind');
});

