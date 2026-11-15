import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, put } from './fixtures/helpers.mjs';
import { appDocument } from './fixtures/app.mjs';
import { loadConfig, inlineName, recommendSettings } from '../src/config.mjs';
import { codexArgs } from '../src/launch/codex.mjs';
import { codexChatArgs } from '../src/chat/runner.mjs';
import { jointArgs } from '../src/joint/spec.mjs';
import { conceptArgs } from '../src/concepts/runner.mjs';
import { recommendationArgs } from '../src/recommend/runner.mjs';
import { consultPrompt } from '../src/consults/runner.mjs';
import { seminarPrompt } from '../src/seminars/runner.mjs';
import { createConcepts } from '../src/concepts/index.mjs';
import { createBackup } from '../src/backup.mjs';
import { zipIndex, readEntry } from '../src/books/epub.mjs';
import { conceptMapFile } from '../src/chat/rewrite.mjs';
import { discoverCandidates } from '../src/registry/candidates.mjs';
import { createApp } from '../src/server.mjs';
import { mountApp } from '../public/app.js';

// v0.50 (2026-11-08): the code holds no personal paths, models or names; each user's values live in their own
// config.json.
const unzip = buffer => { const index = zipIndex(buffer); return new Map([...index].map(([name, entry]) => [name, readEntry(buffer, entry)])); };
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-v050-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('v050 defaults are generic: no profile, model, name, copy folders, Reading or code backup', async t => {
  const root = await temp(t), dataDir = path.join(root, 'data');
  const config = await loadConfig({ env: { CO_AGENT_DATA_DIR: dataDir }, home: root });
  assert.equal(config.userName, '用户');
  assert.equal(config.launchProject, path.join(dataDir, 'workspace'));
  assert.deepEqual(config.claudeAgentDirs, [path.join(root, '.claude', 'agents'), path.join(dataDir, 'workspace', '.claude', 'agents')]);
  for (const key of ['readingAgentsDir', 'codexModel', 'codexEffort', 'codexProfile']) assert.equal(config[key], null, key);
  assert.deepEqual(config.recommend.codex, { model: null, effort: null });
  assert.deepEqual(config.concept, { timeoutMs: 2400000, thinkDir: null, autoDaily: false });
  assert.equal(config.seminar.thinkDir, null);
  assert.deepEqual(config.backup, { dir: path.join(root, 'Documents', 'CO-AGENT 备份'), codeDir: null });
  assert.deepEqual(config.codexArchiveDirs, []);
  assert.equal(config.terminalDisplay, 'primary'); assert.equal(config.terminalWindowMode, 'maximized');
  assert.deepEqual(recommendSettings(config, 'codex'), { model: 'Codex 默认', effort: 'Codex 默认' });
});

test('v050 nullable settings: plain names only, absolute paths only, null accepted', async t => {
  const root = await temp(t), home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  const load = () => loadConfig({ env: { CO_AGENT_DATA_DIR: dataDir }, home });
  for (const bad of [{ codexModel: '-c' }, { codexModel: 'a b' }, { codexProfile: '' }, { codexEffort: 'max' }, { recommend: { codex: { model: '--x' } } },
    { recommend: { codex: { effort: 'huge' } } }, { userName: '' }, { userName: 'x'.repeat(41) }, { readingAgentsDir: 'relative' },
    { concept: { thinkDir: 'relative' } }, { concept: { autoDaily: 'yes' } }, { backup: { codeDir: 'relative' } }, { launchProject: 'relative' },
    { codexArchiveDirs: ['relative'] }]) {
    await put(path.join(dataDir, 'config.json'), JSON.stringify(bad));
    await assert.rejects(load(), /config\.json/, JSON.stringify(bad));
  }
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ codexModel: null, codexProfile: null, readingAgentsDir: null, backup: { codeDir: null }, concept: { thinkDir: null } }));
  assert.equal((await load()).codexModel, null);
  // The default backup folder is never checked against the launch folder, so a home-folder workspace still starts.
  await put(path.join(dataDir, 'config.json'), JSON.stringify({ launchProject: home }));
  assert.equal((await load()).launchProject, home);
});

test('v050 every Codex argv: identical to v0.49.1 with Alex values, no flags when left to Codex', () => {
  const launchProject = 'D:\\work\\co-agent', files = { schema: 's.json', output: 'o.json' };
  const set = { launchProject, codexProfile: 'gpt', codexModel: 'gpt-test', codexEffort: 'xhigh', recommend: { codex: { model: 'gpt-test', effort: 'xhigh' } } };
  const unset = { launchProject, codexProfile: null, codexModel: null, codexEffort: null, recommend: { codex: { model: null, effort: null } } };
  const flags = ['--profile', 'gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh'];
  assert.deepEqual(codexArgs('book', 'L', set).slice(0, -1), [...flags, '-C', launchProject]);
  assert.deepEqual(codexArgs('book', 'L', unset).slice(0, -1), ['-C', launchProject]);
  const chat = ['-s', 'read-only', '--skip-git-repo-check', '-C', launchProject, '--json'];
  assert.deepEqual(codexChatArgs({}, set, true), ['exec', ...flags, ...chat, '-']);
  assert.deepEqual(codexChatArgs({ threadId: 'T' }, unset, false), ['exec', ...chat, 'resume', 'T', '-']);
  assert.deepEqual(jointArgs('codex', { jointId: 'J' }, [{ name: 'a' }], set).slice(0, -1), [...flags, '-C', launchProject]);
  assert.deepEqual(jointArgs('codex', { jointId: 'J' }, [{ name: 'a' }], unset).slice(0, -1), ['-C', launchProject]);
  const tail = ['-c', 'agents.max_threads=8', '-s', 'read-only', '--skip-git-repo-check', '-C', launchProject, '--json', '--output-schema', 's.json', '-o', 'o.json', '-'];
  assert.deepEqual(conceptArgs(set, files), ['exec', '--profile', 'gpt', '-m', 'gpt-test', '-c', 'model_reasoning_effort="xhigh"', ...tail]);
  assert.deepEqual(conceptArgs(unset, files), ['exec', ...tail]);
  const recommend = ['-s', 'read-only', '--skip-git-repo-check', '--json', '--output-schema', 's.json', '-o', 'o.json', '-'];
  assert.deepEqual(recommendationArgs('codex', set, 'S', files), ['exec', '-m', 'gpt-test', '-c', 'model_reasoning_effort="xhigh"', ...recommend]);
  assert.deepEqual(recommendationArgs('codex', unset, 'S', files), ['exec', ...recommend]);
  assert.deepEqual(recommendationArgs('codex', { ...unset, codexModel: 'm2' }, 'S', files), ['exec', '-m', 'm2', ...recommend], 'recommendations follow codexModel');
});

test('v050 prompts name the configured user', () => {
  assert.equal(inlineName('Alex'), ' Alex '); assert.equal(inlineName('用户'), '用户'); assert.equal(inlineName(), '用户');
  const consult = { consultId: 'C', mode: 'auto', count: 3, catalog: [], situation: '处境', options: null };
  const plain = consultPrompt(consult), named = consultPrompt(consult, 'Alex');
  for (const text of ['与用户处境最相关', '「用户正面临下面的处境', '如果用户没有给出选项', '。用户给出了选项时']) assert.ok(plain.includes(text), text);
  for (const text of ['与 Alex 处境最相关', '「Alex 正面临下面的处境', '如果 Alex 没有给出选项', '。Alex 给出了选项时']) assert.ok(named.includes(text), text);
  assert.doesNotMatch(plain, /Alex/);
  const seminar = { seminarId: 'S', mode: 'auto', catalog: [], input: '问题' };
  assert.match(seminarPrompt(seminar), /对用户的行动建议/); assert.match(seminarPrompt(seminar, 'Alex'), /对 Alex 的行动建议/);
  assert.doesNotMatch(seminarPrompt(seminar), /Alex/);
});

test('v050 a concept without a copy folder is kept in the app only, with no copy error', async t => {
  // After hooks run in registration order: close the engine (and apps below) before the fixture folder is removed.
  let engine; t.after(() => engine?.close());
  const { config } = await fixture(t); config.concept.thinkDir = null;
  const value = { concept: '移情：过时的地图', conceptEn: 'Transference', oneLine: '认知线索', whyUnknown: '书名没有提示', sourceRefs: ['第三章'], markdown: '# 原文\n', term: { zh: '移情', en: 'Transference', fr: 'Transfert' } };
  const agent = { id: 'pecko', name: 'Pecko', kind: 'book', platforms: { codex: { available: true } }, book: { title: '一条示例的路' }, sources: { missing: [] } };
  engine = createConcepts(config, () => ({ agents: [agent] }), { runner: async () => value, conceptVerifier: async () => ({ state: 'unconfirmed' }),
    thinkWriter: async () => assert.fail('no copy folder is configured') });
  await engine.recover();
  const started = await engine.startManual({ kind: 'manual' }); await engine.idle();
  const record = await engine.get(started.conceptId);
  assert.equal(record.status, 'done'); assert.ok(!record.thinkFile); assert.ok(!record.thinkError);
});

test('v050 without a Reading folder: no concept-map file, candidates from descriptions, nothing thrown', async () => {
  assert.equal(conceptMapFile({ readingAgentsDir: null }, 'x'), null);
  assert.equal(conceptMapFile({ readingAgentsDir: 'D:\\R\\.claude\\agents' }, 'x'), path.join('D:\\R', 'book-agents', 'x-knowledge', 'concept-map.md'));
  const agents = [{ id: 'x', name: 'X', description: 'Read-only edition-bound book Agent', sourceFile: 'x.toml' }];
  const found = await discoverCandidates(agents, [], { roles: [] }, { books: [] }, { ids: [] }, { readingAgentsDir: null }, { exists: async () => false });
  assert.deepEqual(found.map(c => [c.id, c.hasReadingMd]), [['x', false]]);
});

test('v050 backup without a code folder holds only records and says nothing about code', async t => {
  const { config } = await fixture(t); config.backup.codeDir = null;
  await put(path.join(config.dataDir, 'pins.json'), '{"ids":[]}');
  const result = await createBackup(config, { version: '0.50.0', bundle: async () => assert.fail('no code folder'), opener: async () => {} }).start();
  assert.equal(result.code, 'skipped');
  const files = unzip(await fs.readFile(result.file));
  assert.ok(files.has('data/pins.json')); assert.ok(![...files.keys()].some(name => name.startsWith('code/')));
  const note = files.get('恢复说明.txt').toString('utf8');
  assert.doesNotMatch(note, /恢复代码|代码未备份|CO-AGENT\.bundle/); assert.match(note, /恢复记录/);
});

test('v050 the daily catch-up runs only when concept.autoDaily is on; the option still overrides it', async t => {
  const { config } = await fixture(t);
  const concepts = { recover: async () => {}, ensureDaily: async () => {}, list: async () => ({ items: [], running: null, today: {} }), close: async () => {}, idle: async () => {} };
  const started = async (options = {}) => {
    let timers = 0;
    const app = await createApp(config, { registryBuilder: async () => ({ agents: [] }), conceptsFactory: () => concepts,
      conceptTimers: { setInterval: () => { timers++; return { unref() {} }; }, clearInterval() {} }, ...options });
    await app.listen(); await app.close(); return timers;
  };
  config.concept.autoDaily = false; assert.equal(await started(), 0);
  config.concept.autoDaily = true; assert.equal(await started(), 1); assert.equal(await started({ conceptAutoDaily: false }), 0);
});

test('v050 GET/POST /api/config: first run, values, folders, programs, token, validation, kept keys', async t => {
  let app; t.after(() => app?.close());
  const { root, config } = await fixture(t);
  const found = path.join(root, 'bin', 'codex.exe'); config.codexExe = 'codex-v050';
  app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents: [] }),
    basicConfigOptions: { firstRunPrompt: true, resolver: async exe => exe === config.codexExe ? found : Promise.reject(new Error('missing')) } });
  await app.listen();
  const url = `http://127.0.0.1:${app.server.address().port}/api/config`;
  const post = (body, token = app.token) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-co-agent-token': token }, body: JSON.stringify(body) });
  let state = await (await fetch(url)).json();
  assert.equal(state.firstRun, true); assert.equal(state.values.userName, '用户'); assert.equal(state.values['concept.autoDaily'], false);
  assert.deepEqual(state.environment, { claude: null, codex: found, pwsh: null, wt: null, git: null });
  assert.equal(state.paths.readingAgentsDir.exists, null);
  const file = path.join(config.dataDir, 'config.json');
  await put(file, JSON.stringify({ port: 0, claudeLaunchMode: 'relay' }));
  assert.equal((await post({ userName: 'Alex' }, 'f'.repeat(64))).status, 403);
  for (const bad of [{ codexEffort: 'max' }, { port: 1 }, { concept: { timeoutMs: 1 } }, {}, { readingAgentsDir: 'relative' }]) {
    const response = await post(bad);
    assert.equal(response.status, 400, JSON.stringify(bad)); assert.ok((await response.json()).error);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { port: 0, claudeLaunchMode: 'relay' }, 'a refused save writes nothing');
  const saved = await post({ userName: 'Alex', codexModel: 'gpt-test', concept: { thinkDir: root, autoDaily: true }, backup: { codeDir: null }, codexArchiveDirs: [path.join(root, 'archive-v050')] });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { saved: true, restartRequired: true });
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(written.port, 0); assert.equal(written.claudeLaunchMode, 'relay'); assert.equal(written.userName, 'Alex');
  assert.deepEqual(written.concept, { thinkDir: root, autoDaily: true });
  state = await (await fetch(url)).json();
  assert.equal(state.firstRun, false); assert.equal(state.values.userName, 'Alex'); assert.equal(state.values['concept.thinkDir'], root);
  assert.equal(state.paths['concept.thinkDir'].exists, true);
  const reloaded = await loadConfig({ env: { CO_AGENT_DATA_DIR: config.dataDir } });
  assert.equal(reloaded.userName, 'Alex'); assert.equal(reloaded.codexModel, 'gpt-test'); assert.equal(reloaded.claudeLaunchMode, 'relay');
  assert.equal(config.userName, 'Alex', 'the running server keeps the config it started with');
});

function fetcher(state, posts) {
  return async (url, opts = {}) => {
    if (url === '/api/config' && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: state.saveOk, status: state.saveOk ? 200 : 400, json: async () => state.saveOk ? { saved: true } : { error: 'config.json codexEffort 无效' } }; }
    const value = url === '/api/config' ? state.config
      : url === '/api/registry' ? { agents: [], categories: [], summary: { roles: 0, books: 0 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] }
      : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] } : url === '/api/settings' ? { ui: 'threepane', recommend: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => structuredClone(value) };
  };
}

test('v050 基本配置: first start opens settings, fields fill, save sends nulls and lines, then no prompt', async t => {
  const { doc } = await appDocument('shelf'), posts = [];
  const values = { userName: '用户', codexModel: null, codexEffort: null, codexProfile: null, terminalDisplay: 'primary', terminalWindowMode: 'maximized',
    launchProject: 'C:\\data\\workspace', readingAgentsDir: null, 'concept.thinkDir': null, 'concept.autoDaily': false, 'seminar.thinkDir': null,
    'backup.dir': 'C:\\Users\\u\\Documents\\CO-AGENT 备份', 'backup.codeDir': null, codexArchiveDirs: [] };
  const state = { saveOk: true, config: { firstRun: true, values, paths: { 'backup.dir': { exists: false }, launchProject: { exists: true } },
    environment: { claude: 'C:\\bin\\claude.exe', codex: null } } };
  const front = await mountApp(doc, fetcher(state, posts), { confirm: async () => true });
  t.after(() => front.dispose());
  // The recording DOM reads a dot in a selector as a class, so look the keys up directly.
  const field = key => doc.querySelectorAll('[data-config]').find(el => el.getAttribute('data-config') === key);
  assert.equal(doc.getElementById('settings-dialog').open, true, 'a first start opens the settings');
  assert.equal(doc.getElementById('settings-basic-first').hidden, false);
  assert.equal(doc.activeElement, field('userName'));
  assert.equal(field('userName').value, '用户'); assert.equal(field('backup.dir').value, 'C:\\Users\\u\\Documents\\CO-AGENT 备份');
  assert.equal(doc.querySelectorAll('[data-config-missing]').find(el => el.getAttribute('data-config-missing') === 'backup.dir').hidden, false); assert.equal(doc.querySelectorAll('[data-config-missing]').find(el => el.getAttribute('data-config-missing') === 'launchProject').hidden, true);
  const env = doc.getElementById('settings-basic-env').querySelectorAll('li').map(li => li.textContent);
  assert.deepEqual(env, ['claude：已找到 C:\\bin\\claude.exe', 'codex：未找到', 'pwsh：未找到', 'wt：未找到', 'git：未找到']);
  field('userName').value = ' Alex '; field('codexModel').value = 'gpt-test'; field('codexEffort').value = 'xhigh';
  field('codexArchiveDirs').value = 'D:\\a\n\n  D:\\b  '; field('concept.autoDaily').checked = true; field('readingAgentsDir').value = '  ';
  await doc.getElementById('settings-basic-save').fire('click');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { userName: 'Alex', codexModel: 'gpt-test', codexEffort: 'xhigh', codexProfile: null, terminalDisplay: 'primary',
    terminalWindowMode: 'maximized', launchProject: 'C:\\data\\workspace', catalogDir: null, readingAgentsDir: null, concept: { thinkDir: null, autoDaily: true },
    seminar: { thinkDir: null }, backup: { dir: 'C:\\Users\\u\\Documents\\CO-AGENT 备份', codeDir: null }, codexArchiveDirs: ['D:\\a', 'D:\\b'], allowAgentImport: false });
  assert.equal(doc.getElementById('settings-basic-status').textContent, '已保存，重新启动 CO-AGENT 后生效。');
  assert.equal(doc.getElementById('settings-basic-first').hidden, true);
  state.saveOk = false; await doc.getElementById('settings-basic-save').fire('click');
  assert.equal(doc.getElementById('settings-basic-status').textContent, '保存失败：config.json codexEffort 无效');
});

test('v050 基本配置: a configured install opens nothing by itself', async t => {
  const { doc } = await appDocument('threepane');
  const front = await mountApp(doc, fetcher({ config: { firstRun: false, values: { userName: 'Alex' }, paths: {}, environment: {} } }, []), { confirm: async () => true });
  t.after(() => front.dispose());
  assert.equal(doc.getElementById('settings-dialog').open, false);
  assert.equal(doc.getElementById('settings-basic-first').hidden, true);
  assert.equal(doc.querySelector('[data-config="userName"]').value, 'Alex');
});

test('v050 install.ps1: the daily task only with -DailyConcept, removed with -NoDailyConcept, kept otherwise', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = await temp(t), from = path.join(root, 'package'), runner = path.join(root, 'daily.ps1');
  for (const file of ['CO-AGENT.exe', 'resources/app/src/server.mjs', 'resources/app/package.json']) await put(path.join(from, file), 'fixture');
  await put(runner, String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $env:CO_TEST_REPO 'scripts/install.ps1')
$calls=[Collections.Generic.List[string]]::new()
$deps=@{Processes={@()};RegisterDailyTask={param($target) $calls.Add('register')};RemoveDailyTask={$calls.Add('remove')}}
$install=Join-Path $env:CO_TEST_ROOT 'app'
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps
$calls.Add('|')
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -DailyConcept
$calls.Add('|')
Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -NoDailyConcept
$calls.Add('|')
try { Install-CoAgent -From $env:CO_TEST_FROM -InstallDir $install -NoShortcuts -Dependencies $deps -DailyConcept -NoDailyConcept; $calls.Add('no error') } catch { $calls.Add('refused') }
($calls -join ',')
`);
  const env = { ...process.env, CO_TEST_REPO: process.cwd(), CO_TEST_ROOT: root, CO_TEST_FROM: from, CO_AGENT_DATA_DIR: path.join(root, 'data') };
  const run = args => spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 60000, env });
  const r = run(['-File', runner]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split(/\r?\n/).at(-1), '|,register,|,remove,|,refused', 'no switch registers nothing');
  // Uninstall always removes the task, so asking it to register one at the same time is refused before anything runs.
  const refused = run(['-File', path.join(process.cwd(), 'scripts', 'install.ps1'), '-Uninstall', '-DailyConcept', '-Yes', '-InstallDir', path.join(root, 'app')]);
  assert.equal(refused.status, 1); assert.match(refused.stderr + refused.stdout, /-DailyConcept/);
});
