import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fixture, put } from './fixtures/helpers.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { extractBookFiles } from '../src/registry/sources.mjs';
import { createBooks } from '../src/books/index.mjs';
import { openEpub, chapterMarkdown } from '../src/books/epub.mjs';
import { preferredBookFile, derivedReadingCopy } from '../public/display.js';

const run = promisify(execFile);
const python = (...args) => run('python', ['-X', 'utf8', '-I', ...args], { windowsHide: true, shell: false });
const script = path.resolve('scripts/make-reading-copy.py');

async function library(t, { copy = true, declared = false, added = true } = {}) {
  const { root, config } = await fixture(t);
  config.readingAgentsDir = path.join(root, 'Reading', '.claude', 'agents');
  const original = path.join(root, 'Reading', 'original.pdf');
  const readingCopy = path.join(root, 'Reading', 'book-agents', 'x-source', 'reading-copy.epub');
  await put(original, '%PDF-1.4\n1 0 obj <</Type /Pages /Count 17>> endobj');
  if (copy) await put(readingCopy, 'must not be read to compute bookFacts');
  const instructions = `${original}\n${declared ? readingCopy.toUpperCase() : ''}`;
  await put(path.join(config.codexAgentsDir, 'x.toml'), `name="X"\ndescription="edition-bound book Agent"\ndeveloper_instructions='''${instructions}'''`);
  if (added) await put(path.join(config.dataDir, 'book-additions.json'), JSON.stringify({ version: 1, books: [
    { agent: 'X', title: 'Fixture', author: 'Test', edition: '英文', primary: '学习', tags: [] },
  ] }));
  return { config, original, readingCopy, instructions, registry: await buildRegistry(config) };
}

test('v045 registry appends the conventional reading copy after the original and keeps preferred file and facts', async t => {
  const { config, original, readingCopy, registry } = await library(t);
  const files = registry.agents.find(a => a.id === 'x').bookFiles;
  assert.deepEqual(files, [
    { index: 0, label: 'original', path: original, ext: 'pdf', exists: true },
    { index: 1, label: 'reading-copy（阅读副本）', path: readingCopy, ext: 'epub', exists: true, derived: true },
  ]);
  assert.equal(preferredBookFile(files), 0);
  assert.equal(derivedReadingCopy(files[1]), true);
  const books = createBooks({ dataDir: config.dataDir, getRegistry: () => registry });
  const facts = await books.facts('x');
  assert.equal(facts.books, 1); assert.equal(facts.pages, 17); assert.equal(facts.estimatedPages, false);
});

test('v045 a missing conventional file leaves extracted book files unchanged', async t => {
  const { instructions, registry } = await library(t, { copy: false });
  assert.deepEqual(registry.agents.find(a => a.id === 'x').bookFiles, await extractBookFiles(instructions));
});

test('v045 a declared copy with different path casing is neither duplicated nor changed', async t => {
  const { instructions, registry } = await library(t, { declared: true });
  const files = registry.agents.find(a => a.id === 'x').bookFiles;
  assert.deepEqual(files, await extractBookFiles(instructions));
  assert.equal(files.length, 2); assert.equal(preferredBookFile(files), 0);
});

test('v045 candidates use the same configured Reading root and discovery rule', async t => {
  const { readingCopy, registry } = await library(t, { added: false });
  const candidate = registry.candidates.find(a => a.id === 'x');
  assert.equal(candidate.bookFiles.at(-1).path, readingCopy);
  assert.equal(candidate.bookFiles.at(-1).derived, true);
  assert.equal(preferredBookFile(candidate.bookFiles), 0);
});

test('v045 discovery never uses a path-containing agent id', async () => {
  for (const agentId of ['../x', 'a/b', 'a\\b', '', 'x:y']) {
    const files = await extractBookFiles('', { agentId, readingAgentsDir: 'D:/Reading/.claude/agents',
      exists: async () => { assert.fail('must not probe outside the conventional directory'); } });
    assert.deepEqual(files, []);
  }
});

test('v045 PDF tool preserves text lines, blank pages, nested bookmarks, XML and source provenance in the real EPUB reader', async t => {
  await fs.mkdir('.tmp/reading-copies', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/reading-copies/fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { stdout } = await python('test/fixtures/reading-copy.py', script, root);
  assert.match(stdout, /passed/);
  const book = openEpub(await fs.readFile(path.join(root, 'bookmarks/reading-copy.epub')));
  assert.equal(book.title, 'Fixture <&> 中文');
  assert.equal(book.chapters.length, 2);
  assert.deepEqual(book.toc, [
    { title: 'Parent <&>', chapter: 0, depth: 0, anchor: '' },
    { title: 'Child', chapter: 1, depth: 1, anchor: '' },
    { title: 'Promoted child', chapter: 1, depth: 0, anchor: '' },
  ]); // v0.53.14: outline entries carry their link's anchor ('' without a fragment)
  assert.match(book.chapter(0), /First \\<line\\> & text\nSecond line/);
  assert.equal(book.chapter(1), '### PDF 第 2 页\n');
  const plain = openEpub(await fs.readFile(path.join(root, 'plain/reading-copy.epub')));
  assert.deepEqual(plain.toc.map(x => x.title), ['第 1 页', '第 2 页']);
  assert.equal(chapterMarkdown('<body><p>first<br/>second</p><p>third</p></body>', 'page.xhtml'), 'first\nsecond\n\nthird\n');
  const out = path.join(root, 'english');
  await python(script, '--pdf', path.join(root, 'plain.pdf'), '--out-dir', out, '--title', 'English', '--lang', 'en');
  const english = openEpub(await fs.readFile(path.join(out, 'reading-copy.epub')));
  assert.deepEqual(english.toc.map(x => x.title), ['Page 1', 'Page 2']);
  assert.equal(english.chapter(1), '### PDF Page 2\n');
});

test('v045 tool refuses either existing output before even reading the PDF and preserves every byte and mtime', async t => {
  await fs.mkdir('.tmp/reading-copies', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/reading-copies/no-overwrite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ['reading-copy.epub', 'reading-copy-provenance.json'];
  const snapshot = async dir => Promise.all((await fs.readdir(dir)).map(async name => ({ name,
    sha256: createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex'),
    mtime: (await fs.stat(path.join(dir, name), { bigint: true })).mtimeNs,
  })));
  for (const [index, files] of [[0, names], [1, names.slice(0, 1)], [2, names.slice(1)]]) {
    const dir = path.join(root, String(index));
    for (const name of files) await put(path.join(dir, name), 'sentinel ' + name);
    const before = await snapshot(dir);
    await assert.rejects(python(script, '--pdf', path.join(root, 'absent.pdf'), '--out-dir', dir, '--title', 'Test', '--lang', 'en'),
      error => error.code === 1 && /Refusing to overwrite/.test(error.stderr));
    assert.deepEqual(await snapshot(dir), before);
  }
});
