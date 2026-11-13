import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseToml } from '../src/registry/toml-lite.mjs';
import { parseFrontmatter } from '../src/registry/frontmatter.mjs';
import { BOOK_MAKER } from '../src/bookmaker.mjs';

// v0.53.2: bookmaker/ is the published a-deepbooker bundle that 制作书籍 Agent opens. Its runtime refuses to start when a
// file differs from dependencies.json, so the lock must match the bundle byte for byte.
const root = path.resolve(import.meta.dirname, '..', 'bookmaker');
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('v0532 the Codex and Claude agent files of the bundle parse, and the book maker is one of them', async () => {
  for (const name of [BOOK_MAKER, 'a-book']) {
    const { values } = parseToml(await read(`codex/agents/${name}.toml`));
    assert.equal(values.name.toLowerCase(), name, 'Codex names are matched without case (A-deepbooker)');
    assert.ok(values.developer_instructions.length > 1000, `${name} has its instructions`);
    assert.equal(values.model, undefined, `${name} uses the user's own Codex model`);
    assert.equal(values.model_provider, undefined);
    assert.equal(parseFrontmatter(await read(`claude/agents/${name}.md`)).name, name);
  }
});

// v0.53: the Deepbooker plugin manifest was once published empty; Codex needs its name and skills path to install it.
test('v0533 the Deepbooker plugin manifest is complete, with LF line endings', async () => {
  const text = await read('plugins/deepbooker/.codex-plugin/plugin.json');
  const manifest = JSON.parse(text);
  assert.equal(manifest.name, 'deepbooker');
  assert.equal(manifest.skills, './skills/');
  assert.ok(manifest.description && manifest.interface?.displayName === 'Deepbooker');
  assert.equal(manifest.author.name, 'deepcoder888');
  assert.ok(!text.includes('\r\n'));
});

test('v0532 dependencies.json pins every bundled file it names, with LF line endings', async () => {
  const lock = JSON.parse(await read('agent-support/a-deepbooker/dependencies.json'));
  const local = installed => installed.replace('~/.codex/agents/', 'codex/agents/').replace('~/.codex/', '')
    .replace('<DEEPBOOKER_HOME>/.deepbooker-work/', 'tools/').replace('<DEEPBOOKER_HOME>/', '');
  assert.equal(Object.keys(lock).length, 10);
  for (const [key, { path: installed, sha256 }] of Object.entries(lock)) {
    const data = await fs.readFile(path.join(root, local(installed)));
    assert.equal(createHash('sha256').update(data).digest('hex'), sha256, key);
    assert.ok(!data.includes('\r\n'), `${key} has LF line endings`);
  }
});
