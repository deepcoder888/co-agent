import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, separators } from '../src/registry/sources.mjs';
import { compareVersions } from '../src/registry/sync.mjs';
import { parseFrontmatter } from '../src/registry/frontmatter.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { fixture, put } from './fixtures/helpers.mjs';
import path from 'node:path';

const expected = ['; ', '；', '。', '，', '. ', ', ', ' (SHA', '`', '"', '”', '’', '）', "'", ' | ', ' SHA256', ' SHA', ' is ', ' and ', ' may ', ' (3.', ' (use ', ' (JPG', ' — ', ' -- ', ' → ', ' are ', ' with '];
for (const [name, suffix] of [['sentence-final period', '.'], ['trailing semicolon', ';'], ['trailing quote', '"']]) {
  test(`K3 amendment strips ${name} before the first existence test`, async () => {
    const file = 'D:\\books\\review.json'; const calls = [];
    const result = await checkSources(file + suffix, { exists: async p => { calls.push(p); return p === file; } });
    assert.deepEqual(result, { checked: true, missing: [], total: 1, templatesExcluded: 0 });
    assert.deepEqual(calls, [file]);
  });
}
test('K3 amendment strips the exact trailing set before testing candidates and after every cut', async () => {
  const file = 'D:\\books\\review.json';
  for (const suffix of [' ', '.', ';', ',', ':', '`', '"', "'", ' .;,:`"\'']) {
    for (const explanation of ['', ' is read-only']) {
      const calls = [];
      const result = await checkSources(file + suffix + explanation, { exists: async p => { calls.push(p); return p === file; } });
      assert.deepEqual(result.missing, [], JSON.stringify({ suffix, explanation }));
      assert.equal(calls.at(-1), file);
      assert.ok(calls.every(p => !/[ .;,:`"']$/.test(p)), JSON.stringify(calls));
    }
  }
  const unlisted = file + '）'; const calls = [];
  await checkSources(unlisted, { exists: async p => { calls.push(p); return p === unlisted; } });
  assert.deepEqual(calls, [unlisted]);
});
test('K3 amendment displays stripped missing candidates both before and after cuts', async () => {
  const file = 'D:\\books\\missing.json';
  for (const candidate of [file + ' .;,:`"\'', file + '; is read-only', file + '. is read-only']) {
    assert.deepEqual((await checkSources(candidate, { exists: async () => false })).missing, [file]);
  }
});
test('K3 amendment preserves inner dots and resolves the actual a.b.json file', async t => {
  const { root } = await fixture(t); const file = path.join(root, 'a.b.json');
  await put(file, '{}');
  assert.deepEqual(await checkSources(file + '.'), { checked: true, missing: [], total: 1, templatesExcluded: 0 });
  const calls = [];
  await checkSources(file + '.', { exists: async p => { calls.push(p); return p === file; } });
  assert.deepEqual(calls, [file]);
});
test('K3 separator list is verbatim; every separator truncates at an existing prefix', async () => {
  assert.deepEqual(separators, expected);
  for (const separator of expected) {
    const result = await checkSources(`标签：D:\\书籍 空格 (正文)\\原书.epub${separator}suffix`, { exists: async p => p === 'D:\\书籍 空格 (正文)\\原书.epub' });
    assert.deepEqual(result, { checked: true, missing: [], total: 1, templatesExcluded: 0 });
  }
});
test('K3 Q4 syntax, escaped slashes, longest existing prefix, missing file versus parent, templates and deduplication', async () => {
  const exists = async p => ['D:\\书 籍\\目录', 'D:\\书 籍\\目录\\正文.epub', 'D:/书 籍/目录/正文.epub', 'D:\\book; part.epub'].includes(p);
  const instructions = String.raw`标签：D:\书 籍\目录\正文.epub | SHA256 abc
标签 = D:/书 籍/目录/正文.epub' ; run stuff
Label: D:\书 籍\目录\缺失.epub is read-only
D:\book; part.epub; run foo
AD:\ignore.epub
D:\template\image00NNN.jpeg
D:\template\<basename>
D:\template\preflight-NNN.png
D:\template\a*.png
D:\template\a?.png
D:\template\{name}.png
d:\书 籍\目录\缺失.epub SHA abc`;
  const result = await checkSources(instructions, { exists });
  assert.equal(result.templatesExcluded, 6); assert.equal(result.total, 3);
  assert.deepEqual(result.missing, ['D:\\书 籍\\目录\\缺失.epub']);
  assert.deepEqual((await checkSources('D:\\a; b, c', { exists: async () => false })).missing, ['D:\\a']);
});
test('K6 compares body and description only, removes examples, normalizes whitespace, handles missing fields', () => {
  const codex = { developer_instructions: 'line  \r\nnext\t\r\n', description: 'desc\n<example>different\nexample</example>' };
  const claude = parseFrontmatter('---\nname: book\ndescription: |\n  desc\n  <example>other</example>\nmodel: opus\ntools: Read\n---\n\nline\nnext\n');
  assert.equal(compareVersions(codex, claude).state, '同步');
  for (const [c, state] of [[{...claude,description:'other'},'描述不同'],[{...claude,body:'other'},'指令不同'],[{...claude,description:'other',body:'other'},'描述和指令都不同'],[undefined,'无法比较']]) assert.equal(compareVersions(codex,c).state,state);
  assert.equal(compareVersions({},claude).state,'无法比较');
  assert.equal(parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\n---\nbody').description,'one two\n');
});
test('K3/K6 registry refresh rechecks book paths and never attaches sources to roles', async t => {
  const { root, config } = await fixture(t); const source = path.join(root, '书 空格.epub');
  await put(path.join(config.codexAgentsDir,'book.toml'), `name="Synthetic"\ndescription="Read-only book Agent"\ndeveloper_instructions='''Source: ${source}'''`);
  await put(path.join(config.claudeAgentDirs[0],'book.md'), `---\nname: Synthetic\ndescription: Read-only book Agent\n---\nSource: ${source}`);
  await put(path.join(config.codexAgentsDir,'jack.toml'), 'name="-jack"\ndescription="role"');
  // v0.18 requires an admitted catalog entry before source/launch checks apply.
  await put(path.join(config.dataDir,'book-additions.json'), JSON.stringify({version:1,books:[{agent:'Synthetic',title:'《测试书》',author:'作者',edition:'测试版',primary:'软件工程',tags:[]}]}));
  const first = await buildRegistry(config);
  assert.equal(first.agents.find(a=>a.id==='synthetic').sources.missing.length,1);
  assert.equal(first.agents.find(a=>a.id==='jack').sources,undefined);
  assert.equal(first.summary.synced,1);
  await put(source,'book');
  assert.equal((await buildRegistry(config)).agents.find(a=>a.id==='synthetic').sources.missing.length,0);
});
