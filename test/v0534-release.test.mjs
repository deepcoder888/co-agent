import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { releaseZip, releaseScripts } from '../scripts/release.mjs';
import { zipIndex, readEntry } from '../src/books/epub.mjs';

// v0.53: the download ZIP is laid out like the repository, so scripts\install.ps1 finds the app where npm run package
// puts it, and it carries the public README and LICENSE, never the development repository's own README.
async function fixture(t, { app = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
  await put('package.json', '{"name":"co-agent","version":"9.8.7"}');
  for (const file of releaseScripts) await put(file, `# ${file}`);
  await put('bookmaker/README.md', 'bookmaker readme'); await put('bookmaker/codex/agents/a-deepbooker.toml', 'name = "a-deepbooker"');
  await put('README.md', 'development notes');
  await put('public-repo/README.md', 'public readme');
  await put('public-repo/LICENSE', 'MIT License');
  if (app) {
    await put('release/CO-AGENT-win32-x64/CO-AGENT.exe', 'exe');
    await put('release/CO-AGENT-win32-x64/resources/app/src/server.mjs', 'x'.repeat(5000));
  }
  return root;
}

test('v0534 the release ZIP holds the built app, the install scripts and the public README and LICENSE', async t => {
  const root = await fixture(t);
  const result = await releaseZip({ root });
  assert.equal(path.basename(result.file), 'CO-AGENT-9.8.7-win32-x64.zip');
  const zip = await fs.readFile(result.file), entries = zipIndex(zip);
  assert.deepEqual([...entries.keys()].sort(), ['LICENSE', 'README.md', 'release/CO-AGENT-win32-x64/CO-AGENT.exe',
    'release/CO-AGENT-win32-x64/resources/app/src/server.mjs', ...releaseScripts,
    // v0.53: the 制作书籍 Agent bundle, so a download can set up a-deepbooker as bookmaker/README.md describes.
    'bookmaker/README.md', 'bookmaker/codex/agents/a-deepbooker.toml'].sort());
  assert.equal(readEntry(zip, entries.get('bookmaker/README.md')).toString(), 'bookmaker readme');
  assert.equal(readEntry(zip, entries.get('README.md')).toString(), 'public readme');
  assert.equal(readEntry(zip, entries.get('release/CO-AGENT-win32-x64/resources/app/src/server.mjs')).toString(), 'x'.repeat(5000));
  const sha = createHash('sha256').update(zip).digest('hex');
  assert.equal(result.sha256, sha);
  assert.equal(await fs.readFile(`${result.file}.sha256`, 'utf8'), `${sha}  CO-AGENT-9.8.7-win32-x64.zip\n`);
});

test('v0534 the release ZIP needs a built app first', async t => {
  const root = await fixture(t, { app: false });
  await assert.rejects(releaseZip({ root }), /请先运行 npm run package/);
});
