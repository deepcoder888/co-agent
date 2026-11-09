import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseToml } from '../src/registry/toml-lite.mjs';
import { parseFrontmatter } from '../src/registry/frontmatter.mjs';
import { discover } from '../src/registry/discover.mjs';
import { normalize, mergeIdentity } from '../src/registry/identity.mjs';
import { classify, buildRegistry } from '../src/registry/classify.mjs';
import { fixture, put } from './fixtures/helpers.mjs';

test('T2 four strings, supported escapes, initial newline and multiline continuation', () => {
  const text = String.raw`name = "a\"b\\c\n\t\r\u4e2d\U0001F600\b\f"
description = 'literal\path'
developer_instructions = """
first \
  
  second"""
sandbox_mode = '''
read-only\literal'''
model = "gpt"
web_search = true
count = -1_234
[tools]
name = "ignored"`;
  const { values, unsupported } = parseToml(text);
  assert.equal(values.name, 'a"b\\c\n\t\r中😀\b\f');
  assert.equal(values.description, 'literal\\path');
  assert.equal(values.developer_instructions, 'first second');
  assert.equal(values.sandbox_mode, 'read-only\\literal');
  assert.equal(values.web_search, true);
  assert.equal(values.count, -1234);
  assert.deepEqual(unsupported, []);
  assert.equal(parseToml('name="ok"\n[[array]]\nname="bad"').values.name, 'ok');
});

test('T2 skips unsupported compound values without parsing their inner keys', () => {
  const { values, unsupported } = parseToml('array = [\n "x", { name = "fake" }\n]\ndate = 2026-10-06\nfloat = 1.2\ninline = { x = true }\nname = "real" # comment\n');
  assert.deepEqual(values, { name: 'real' });
  assert.deepEqual(unsupported, ['array', 'date', 'float', 'inline']);
});

test('T2 TOML integers include hexadecimal, octal and binary; multiline terminal quotes retained', () => {
  const { values } = parseToml('hex = 0xDEAD_BEEF\noct = 0o755\nbin = 0b1101_0010\nname = """end""""\ndescription = \'\'\'end\'\'\'\'\'');
  assert.equal(values.hex, 0xdeadbeef);
  assert.equal(values.oct, 0o755);
  assert.equal(values.bin, 0b11010010);
  assert.equal(values.name, 'end"');
  assert.equal(values.description, "end''");
  assert.equal(parseToml('large = 9223372036854775807').values.large, 9223372036854775807n);
  assert.equal(parseToml('small = -9223372036854775808').values.small, -9223372036854775808n);
  assert.throws(() => parseToml('overflow = 9223372036854775808'), /行 1/);
});

for (const [label, input, line] of [
  ['unterminated', 'name="ok"\ndescription="bad', 2],
  ['bad escape', 'name="\\q"', 1],
  ['bad scalar', 'name=garbage', 1],
  ['trailing text', 'name="x" more', 1],
  ['duplicate', 'name="x"\nname="y"', 2],
  ['missing equals', 'name "x"', 1],
  ['bad unicode', 'name="\\uD800"', 1],
  ['unterminated array', 'name=[\n"x"', 1],
]) test(`T2 syntax error with line: ${label}`, () => assert.throws(() => parseToml(input), new RegExp(`行 ${line}`)));

test('T3 frontmatter quoted names and block descriptions; body names ignored', () => {
  assert.equal(parseFrontmatter('---\nname: "Harlo"\ndescription: |-\n  book Agent\n---\nname: Fake').name, 'Harlo');
  assert.equal(parseFrontmatter("---\r\nname: '-jack'\r\n---\r\n").name, '-jack');
  assert.throws(() => parseFrontmatter('name: Fake'), /frontmatter/);
  assert.throws(() => parseFrontmatter('---\nname: x\nname: y\n---'), /name/);
});

test('T4 direct discovery excludes each backup, records malformed files and unavailable sources', async t => {
  const { root, config } = await fixture(t);
  await put(path.join(config.codexAgentsDir, 'good.toml'), 'name="-jack"\ndescription="Role"');
  for (const file of ['a.bak.toml', 'b.before-change.toml', 'c.orig.toml', 'd.toml.bak']) await put(path.join(config.codexAgentsDir, file), 'broken');
  await put(path.join(config.codexAgentsDir, 'bad.toml'), 'name="unterminated');
  await put(path.join(config.codexAgentsDir, 'nested', 'ignored.toml'), 'name="ignored"');
  await put(path.join(config.claudeAgentDirs[0], 'jack.md'), '---\nname: jack\n---');
  config.claudeAgentDirs.push(path.join(root, 'absent'));
  const { records, sources } = await discover(config);
  assert.equal(records.length, 2);
  assert.equal(sources[0].total, 2);
  assert.equal(sources[0].parsed, 1);
  assert.equal(sources[0].excluded, 4);
  assert.match(sources[0].failed[0].reason, /行 1/);
  assert.equal(sources[2].available, false);
  assert.ok(sources.every(s => s.scannedAt && s.id && s.path));
});

test('T4 follows Claude md symlink target', async t => {
  const { root, config } = await fixture(t);
  const target = path.join(root, 'target.md');
  await put(target, '---\nname: Linked\n---');
  const link = path.join(config.claudeAgentDirs[0], 'linked.md');
  const readFile = fs.readFile.bind(fs), readdir = fs.readdir.bind(fs);
  // Model a symlink Dirent and OS-followed read without creating a real link.
  t.mock.method(fs, 'readdir', (dir, options) => dir === config.claudeAgentDirs[0]
    ? Promise.resolve([{ name: 'linked.md', isFile: () => false, isSymbolicLink: () => true }]) : readdir(dir, options));
  t.mock.method(fs, 'readFile', (file, options) => readFile(file === link ? target : file, options));
  const result = await discover(config);
  assert.equal(result.records[0].name, 'Linked');
  assert.equal(result.sources[1].parsed, 1);
});

const record = (name, kind = 'codex', sourceId = kind, description = '') => ({ name, kind, sourceId, file: `${sourceId}/${name}`, description });
test('T5 normalization and Codex-led merge retain Claude original name', () => {
  assert.equal(normalize(' -steven '), 'steven');
  assert.equal(normalize('book_currency_auditor'), 'book-currency-auditor');
  assert.equal(normalize('Loki'), 'loki');
  const { agents } = mergeIdentity([record('-Jack'), record('jack', 'claude'), record('Loki'), record('OnlyClaude', 'claude')]);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].name, '-Jack');
  assert.equal(agents[0].platforms.claude.name, 'jack');
  assert.equal(agents[1].platforms.claude.available, false);
  assert.equal(agents[1].platforms.claude.reason, '启动项目中没有该 Agent 的 Claude 版');
});

test('T5 same-source conflicts do not silently merge or permit launch', () => {
  const merged = mergeIdentity([record('-Jack'), record('jack'), record('JACK', 'claude'), record('Loki')]);
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.agents.map(a => a.id), ['loki']);
  assert.equal(merged.conflicts[0].files.length, 2);
  const claudeConflict = mergeIdentity([record('Jack'), record('-jack', 'claude'), record('jack', 'claude')]);
  assert.equal(claudeConflict.agents[0].platforms.claude.available, false);
  assert.match(claudeConflict.agents[0].platforms.claude.reason, /冲突/);
});

test('T6 classification keeps unmapped books out until v0.18 confirmation; preserves roles, maps and missing mappings', () => {
  const records = mergeIdentity([record('Loki', 'codex', 'codex', 'book Agent'), record('Harlo'), record('NewBook', 'codex', 'codex', 'a book Agent here'), record('A-book', 'codex', 'codex', 'book Agent'), record('Other')]).agents;
  const result = classify(records, { roles: ['Loki', '-Missing'] }, { categories: ['History'], books: [{ agent: 'Harlo', primary: 'History', tags: [], title: 'Book', author: 'Writer', edition: '2024' }] });
  assert.equal(result.agents[0].kind, 'role');
  assert.equal(result.agents[1].book.title, 'Book');
  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.outOfScope.map(a => a.name), ['NewBook', 'A-book', 'Other']);
  assert.equal(result.missingFromDisk[0].name, '-Missing');
  assert.equal(result.summary.roles, 1);
  assert.equal(result.summary.books, 1);
  assert.equal(result.summary.uncategorized, 0);
});

test('T6 registry integrates immutable supplied maps and scan coverage', async t => {
  const { config } = await fixture(t);
  await put(path.join(config.codexAgentsDir, 'loki.toml'), 'name="Loki"\ndescription="Role"');
  const registry = await buildRegistry(config);
  assert.equal(registry.summary.roles, 1);
  assert.equal(registry.categories.length, 11);
  // Every supplied role/book except the one on disk (Loki); derived from the data files so adding books needs no edit.
  const roleMap = JSON.parse(await fs.readFile('test/fixtures/catalog/roles.json', 'utf8')), bookMap = JSON.parse(await fs.readFile('test/fixtures/catalog/book-categories.json', 'utf8'));
  assert.equal(registry.missingFromDisk.length, roleMap.roles.length + bookMap.books.length - 1);
});
