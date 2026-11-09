import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, put } from './fixtures/helpers.mjs';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { readCatalogFile, CATALOG_FILES } from '../src/catalog.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { createReports } from '../src/reports/index.mjs';
import { createBasicConfig } from '../src/basic-config.mjs';
import { createApp } from '../src/server.mjs';
import { included } from '../scripts/package.mjs';

// v0.51 (2026-11-08): the Agent lists left the code. They are read from catalogDir (default <dataDir>/catalog);
// The user's are the repo's profile/ folder, which is never packaged or published.
async function emptyCatalog(t) {
  const ctx = await fixture(t);
  ctx.config.catalogDir = path.join(ctx.root, 'catalog');
  await put(path.join(ctx.config.codexAgentsDir, 'helper.toml'), 'name="Helper"\ndescription="A tool"');
  await put(path.join(ctx.config.codexAgentsDir, 'reader.toml'), 'name="Reader"\ndescription="Read-only edition-bound book Agent"');
  return ctx;
}

test('v051 with no catalog files every agent is unlisted and nothing fails', async t => {
  const { config } = await emptyCatalog(t);
  for (const key of Object.keys(CATALOG_FILES)) assert.ok(await readCatalogFile(config, key), key);
  const registry = await buildRegistry(config);
  assert.equal(registry.summary.roles, 0); assert.equal(registry.summary.books, 0);
  assert.deepEqual(registry.agents, []); assert.deepEqual(registry.categories, []);
  assert.deepEqual(registry.outOfScope.map(a => a.id).sort(), ['helper', 'reader']);
  assert.deepEqual(registry.missingFromDisk, []);
  assert.deepEqual(registry.candidates.map(c => c.id), ['reader'], 'a book-like agent is still offered as a new book');
});

test('v051 a broken catalog file is named in the error', async t => {
  const { config } = await emptyCatalog(t);
  await put(path.join(config.catalogDir, 'book-categories.json'), '{');
  await assert.rejects(buildRegistry(config), /book-categories\.json 不是有效的 JSON/);
  await put(path.join(config.catalogDir, 'book-categories.json'), '{"categories":"x","books":[]}');
  await assert.rejects(buildRegistry(config), /book-categories\.json 格式错误/);
  await put(path.join(config.catalogDir, 'book-categories.json'), '{"version":1,"categories":[],"books":[]}');
  await put(path.join(config.catalogDir, 'roles.json'), '{"roles":[1]}');
  await assert.rejects(buildRegistry(config), /roles\.json 格式错误/);
});

test('v051 reports without a folder scan nothing, not even the working folder', async t => {
  const { root } = await fixture(t);
  let reads = 0;
  const io = { ...fs, readdir: async (...args) => { reads++; return fs.readdir(...args); } };
  const reports = createReports({ mappingFile: path.join(root, 'absent', 'book-reports.json'), io });
  await reports.load();
  assert.equal(reads, 0);
  const coverage = reports.coverage([{ id: 'b', kind: 'book', name: 'B', book: { title: '《一本很长的书名》' } }]);
  assert.equal(coverage.directory, null); assert.deepEqual(coverage.unusedFiles, []); assert.equal(coverage.booksWithout.length, 1);
});

test('v051 config: catalogDir defaults to the data dir, null means the default, and it drives the task format', async t => {
  const { root } = await fixture(t), dataDir = path.join(root, 'conf'), home = path.join(root, 'home');
  const load = () => loadConfig({ env: { CO_AGENT_DATA_DIR: dataDir }, home });
  assert.equal((await load()).catalogDir, path.join(dataDir, 'catalog'));
  assert.deepEqual((await load()).taskContracts, { version: 1, octopus: [] });
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ catalogDir: null }));
  assert.equal((await load()).catalogDir, path.join(dataDir, 'catalog'));
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ catalogDir: 'relative' }));
  await assert.rejects(load(), /catalogDir/);
  const mine = path.join(root, 'mine');
  await put(path.join(mine, 'task-contracts.json'), JSON.stringify({ version: 1, octopus: ['-helper'] }));
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ catalogDir: mine }));
  assert.deepEqual((await load()).taskContracts.octopus, ['-helper']);
});

test('v051 基本配置 saves catalogDir and reports whether it exists', async t => {
  const { config } = await fixture(t);
  const basic = createBasicConfig(config, { resolver: async () => null });
  // describe() shows the saved config.json, which has no catalogDir yet: the data dir's catalog, not created yet.
  let described = await basic.describe();
  assert.equal(described.values.catalogDir, path.join(config.dataDir, 'catalog')); assert.equal(described.paths.catalogDir.exists, false);
  await basic.save({ catalogDir: path.join(projectRoot, 'test', 'fixtures', 'catalog') });
  described = await basic.describe();
  assert.equal(described.values.catalogDir, path.join(projectRoot, 'test', 'fixtures', 'catalog')); assert.equal(described.paths.catalogDir.exists, true);
  await basic.save({ catalogDir: null });
  assert.equal((await basic.describe()).values.catalogDir, path.join(config.dataDir, 'catalog'), 'empty means the default again');
  assert.equal(JSON.parse(await fs.readFile(path.join(config.dataDir, 'config.json'), 'utf8')).catalogDir, null);
});

test('v051 the server runs on an empty catalog: registry, reports and coverage', async t => {
  const { config } = await emptyCatalog(t);
  const app = await createApp(config, { conceptAutoDaily: false });
  await app.listen(); t.after(() => app.close());
  const registry = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/registry`)).json();
  assert.equal(registry.summary.roles, 0); assert.equal(registry.reports.directory, null);
  assert.equal(registry.outOfScope.length, 2);
});

test('v051 the package carries no Agent lists', () => {
  for (const file of ['/profile', '/profile/roles.json', '/data', '/data/roles.json']) assert.equal(included(file), false, file);
  assert.equal(included('/src/catalog.mjs'), true);
});
