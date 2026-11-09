import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRegistry } from '../src/registry/classify.mjs';
import { checkSources } from '../src/registry/sources.mjs';
import { selectAgent } from '../src/concepts/index.mjs';
import { fixture, put } from './fixtures/helpers.mjs';

// v0.18 passed the registry's file-only check into checkSources, so every book whose definition named its
// knowledge directory counted as missing sources and daily concepts drew from a single remaining book.
test('v026 knowledge directories count as present sources and keep books in the concept pool', async t => {
  const { root, config } = await fixture(t);
  const book = path.join(root, 'Reading', 'Notes on Sample.epub');
  const knowledge = path.join(root, 'Reading', 'book-agents', 'walvo-knowledge');
  const gone = path.join(root, 'Reading', 'book-agents', 'jadra-knowledge');
  await put(book, 'fixture book');
  await fs.mkdir(knowledge, { recursive: true });
  const toml = (name, lines) => `name="${name}"\ndescription="Read-only book Agent"\ndeveloper_instructions='''\n${lines.join('\n')}\n'''`;
  await put(path.join(config.codexAgentsDir, 'walvo.toml'), toml('Walvo', [`Source: ${book}`, `Package: ${knowledge}`]));
  await put(path.join(config.codexAgentsDir, 'jadra.toml'), toml('Jadra', [`Package: ${gone}`]));

  // An injected file-only check still governs book files and discovery, never the source check.
  for (const options of [{}, { exists: async file => (await fs.stat(file).catch(() => null))?.isFile() ?? false }]) {
    const registry = await buildRegistry(config, options);
    const walvo = registry.agents.find(a => a.id === 'walvo'), jadra = registry.agents.find(a => a.id === 'jadra');
    assert.deepEqual(walvo.sources, { checked: true, missing: [], total: 2, templatesExcluded: 0, missingByVersion: { codex: [], claude: [] } });
    assert.deepEqual(jadra.sources.missing, [`${gone}（仅 Codex 版本）`]);
    assert.equal(walvo.bookFiles[0].exists, true);
    assert.equal(selectAgent(registry.agents, [], () => 0).id, 'walvo');
  }
});

// Carbo and Travo name existing paths followed by English prose ("… are indexes", "… with the exact …").
test('v026 prose after " are " or " with " does not hide an existing source path', async t => {
  const { root } = await fixture(t);
  const preflight = path.join(root, 'work', 'book-04-preflight'), cover = path.join(root, 'work', 'book-03-preflight', 'coverpage.jpg');
  await fs.mkdir(preflight, { recursive: true }); await put(cover, 'jpg');
  const instructions = `The records in ${preflight.replaceAll('\\', '/')} are indexes, not a source.\nCompare ${cover.replaceAll('\\', '/')} with the exact original EPUB member bytes.`;
  assert.deepEqual(await checkSources(instructions), { checked: true, missing: [], total: 2, templatesExcluded: 0 });
});
