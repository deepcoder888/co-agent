import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as sources from '../src/registry/sources.mjs';
import { buildRegistry } from '../src/registry/classify.mjs';
import { createApp } from '../src/server.mjs';
import { fixture, put } from './fixtures/helpers.mjs';

// Section 0 facts are mirrored only in disposable fixtures, never in the real
// registry or Reading directory. No test invokes the production opener.
async function registryFixture(t) {
  const ctx = await fixture(t);
  const { root, config } = ctx;
  const books = [
    path.join(root, 'Reading', 'Ground  Rules (A. Author) (example.org, mirror.example.net, example.net).epub'),
    path.join(root, 'Reading', 'Snowball (Ann Sample).PDF'),
    path.join(root, 'Reading', 'Letters.mobi'),
    path.join(root, 'Reading', 'The Steady Sample Way.azw3'),
  ];
  const walvo = path.join(root, 'Reading', 'Notes on Sample (Matt Walkerson).epub');
  const missing = path.join(root, 'Reading', 'Art and Sample Forms (Rolf Arnstein).pdf');
  const definition = path.join(config.codexAgentsDir, '-StEvEn.ToMl');
  const derived = path.join(root, 'Reading', 'agent-support', 'Bufano', 'derived.epub');
  const knowledge = path.join(root, 'Reading', 'BUFANO-KNOWLEDGE', 'snapshot.pdf');
  for (const file of [...books, walvo, derived, knowledge]) await put(file, 'fixture bytes');
  const toml = (name, instructions) => `name="${name}"\ndescription="Read-only book Agent"\ndeveloper_instructions='''\n${instructions}\n'''`;
  await put(path.join(config.codexAgentsDir, 'Bufano.TOML'), toml('Bufano', [
    `Source: ${books[0]}`,
    `Again: ${books[0].replaceAll('\\', '\\\\')}`,
    `Again: ${books[0].replaceAll('\\', '/').toUpperCase()}`,
    `Source: ${books[1].replaceAll('\\', '/')} | SHA256 abc`,
    `Source: ${books[2].replaceAll('\\', '\\\\')}; read only`,
    `Source: ${books[3]}`,
    `Derived: ${derived}`,
    `Package: ${knowledge}`,
    `Other: ${path.join(root, 'Reading', 'notes.txt')}`,
  ].join('\n')));
  await put(path.join(config.codexAgentsDir, 'walvo.toml'), toml('Walvo', walvo));
  await put(path.join(config.codexAgentsDir, 'arnova.toml'), toml('Arnova', missing));
  await put(definition, `name="-steven"\ndescription="Role"\ndeveloper_instructions='''${books[0]}'''`);
  await put(path.join(config.claudeAgentDirs[0], 'bufano.md'), `---\nname: Bufano\n---\n${path.join(root, 'Claude-only.epub')}`);
  return { ...ctx, books, walvo, missing, definition };
}

async function running(t, options = {}) {
  let app;
  t.after(() => app?.close()); // Stop indexers before removing the fixture.
  const ctx = await registryFixture(t);
  const calls = [];
  app = await createApp(ctx.config, {
    conceptAutoDaily: false,
    opener: async (...args) => { calls.push(args); },
    ...options,
  });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Co-Agent-Token': app.token, Origin: base };
  const post = (body, extraHeaders = {}) => fetch(base + '/api/open', {
    method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  return { ...ctx, app, base, calls, headers, post };
}

async function openLogs(config) {
  return (await fs.readFile(path.join(config.dataDir, 'logs', 'server.log'), 'utf8'))
    .split('\n').filter(line => line.includes(' 打开：')).map(line => JSON.parse(line.split(' 打开：')[1]));
}

test('v010 real-registry sanity through actual discovery: four books, slash variants, missing book, case-matched role definition', async t => {
  const ctx = await registryFixture(t);
  const registry = await buildRegistry(ctx.config);
  const byId = Object.fromEntries(registry.agents.map(agent => [agent.id, agent]));
  assert.equal(registry.summary.failed, 0);
  assert.deepEqual(byId.bufano.bookFiles, ctx.books.map((file, index) => ({
    index, label: ['Ground Rules (A. Author)', 'Snowball (Ann Sample)', 'Letters', 'The Steady Sample Way'][index],
    path: file, ext: ['epub', 'pdf', 'mobi', 'azw3'][index], exists: true,
  })));
  assert.deepEqual(byId.walvo.bookFiles, [{ index: 0, label: 'Notes on Sample (Matt Walkerson)', path: ctx.walvo, ext: 'epub', exists: true }]);
  assert.deepEqual(byId.arnova.bookFiles, [{ index: 0, label: 'Art and Sample Forms (Rolf Arnstein)', path: ctx.missing, ext: 'pdf', exists: false }]);
  assert.deepEqual(byId.steven.definitionFile, { path: ctx.definition, exists: true });
  assert.equal(byId.steven.bookFiles, undefined);
  assert.equal(byId.steven.sources, undefined);
  assert.equal(byId.bufano.definitionFile, undefined);
  assert.equal(byId.bufano.platforms.claude.available, true);
  assert.equal(byId.arnova.sources.checked, true);
  assert.equal(byId.arnova.sources.missing.length, 1);
});

test('v010 extraction normalizes dot segments and casing, preserves source order, punctuation and author labels even when missing', async () => {
  const checked = [];
  const instructions = String.raw`Source: D:\Books\part\..\First (Author) (example.org).EPUB; read only
Second: D:/Books/Second.pdf; next D:\Books\Third.mobi
Repeat: d:/books/FIRST (AUTHOR) (EXAMPLE.ORG).epub
Missing: D:\\Books\\Missing; volume, 2 (A. Writer) (mirror.example.net).azw3 is read-only
Dot: D:\Books\a.b.pdf.
Quotes: "D:\Books\'Quoted' & $literal.epub" (read only)
Ignore: D:\Books\agent-support\copy.pdf
Ignore: D:\Books\Something-Knowledge\copy.epub
Ignore: D:\Books\x.txt
Ignore: D:\Books\wrong.pdf.exe
Ignore: D:\Books\wrong.epub.backup
Ignore: D:\Books\fake.epub\notes.txt
Ignore: AD:\Books\bad.epub
Ignore: D:\Books\<template>.epub
Ignore: D:\Books\*.epub`;
  const files = await sources.extractBookFiles(instructions, { exists: async file => { checked.push(file); return false; } });
  assert.deepEqual(files, [
    ['First (Author)', String.raw`D:\Books\First (Author) (example.org).EPUB`, 'epub'],
    ['Second', String.raw`D:\Books\Second.pdf`, 'pdf'],
    ['Third', String.raw`D:\Books\Third.mobi`, 'mobi'],
    ['Missing; volume, 2 (A. Writer)', String.raw`D:\Books\Missing; volume, 2 (A. Writer) (mirror.example.net).azw3`, 'azw3'],
    ['a.b', String.raw`D:\Books\a.b.pdf`, 'pdf'],
    ["'Quoted' & $literal", String.raw`D:\Books\'Quoted' & $literal.epub`, 'epub'],
  ].map(([label, file, ext], index) => ({ index, label, path: file, ext, exists: false })));
  assert.deepEqual(checked, files.map(file => file.path));
  for (const value of [undefined, null, '', 42, 'No paths']) assert.deepEqual(await sources.extractBookFiles(value), []);
});

test('v010 a directory named with a book extension is not an existing file; registry refresh rechecks missing files', async t => {
  const ctx = await registryFixture(t);
  await fs.mkdir(ctx.missing);
  assert.equal((await buildRegistry(ctx.config)).agents.find(a => a.id === 'arnova').bookFiles[0].exists, false);
  await fs.rmdir(ctx.missing);
  await put(ctx.missing, 'fixture book');
  assert.equal((await buildRegistry(ctx.config)).agents.find(a => a.id === 'arnova').bookFiles[0].exists, true);
});

test('v010 POST open resolves registry-only books and definitions, exposes fields, and logs each successful dispatch', async t => {
  const ctx = await running(t);
  const registry = await (await fetch(ctx.base + '/api/registry')).json();
  assert.equal(registry.agents.find(a => a.id === 'bufano').bookFiles.length, 4);
  assert.equal(registry.agents.find(a => a.id === 'steven').definitionFile.path, ctx.definition);
  for (const body of [
    { agentId: 'bufano', target: 'book', index: 1 },
    { agentId: 'walvo', target: 'book' },
    { agentId: 'steven', target: 'definition' },
  ]) {
    const response = await ctx.post(body);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  }
  assert.deepEqual(ctx.calls, [[ctx.books[1], 'book'], [ctx.walvo, 'book'], [ctx.definition, 'definition']].map(([file, target]) => [file, { reveal: false, exists: true, target }]));
  assert.deepEqual(await openLogs(ctx.config), [
    { agentId: 'bufano', target: 'book', index: 1, result: 'opened' },
    { agentId: 'walvo', target: 'book', index: 0, result: 'opened' },
    { agentId: 'steven', target: 'definition', index: null, result: 'opened' },
  ]);
});

test('v010 POST open inherits Host, both token headers, and Origin protection before invoking opener', async t => {
  const ctx = await running(t);
  const body = { agentId: 'walvo', target: 'book' };
  for (const headers of [
    { 'X-Co-Agent-Token': '' }, { 'X-Co-Agent-Token': 'bad', 'X-Agent-Hub-Token': ctx.app.token },
    { Origin: 'https://evil.example' }, { Origin: 'null' },
    { Origin: ctx.base.replace('127.0.0.1', 'localhost') },
  ]) assert.equal((await ctx.post(body, headers)).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(ctx.base + '/api/open', { method: 'POST', headers: { ...ctx.headers, Host: 'evil.example' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(wrongHost, 421);
  assert.equal((await fetch(ctx.base + '/api/open')).status, 404);
  assert.equal(ctx.calls.length, 0);
  const legacy = await fetch(ctx.base + '/api/open', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Hub-Token': ctx.app.token }, body: JSON.stringify(body) });
  assert.equal(legacy.status, 200); assert.equal(ctx.calls.length, 1);
});

test('v010 invalid target, id, index, shape, reveal and client paths are rejected without side effects or arbitrary data in logs', async t => {
  const ctx = await running(t);
  const valid = { agentId: 'bufano', target: 'book' };
  const bad = [null, [], 42, 'string', {}, { ...valid, agentId: 'not-a-real-agent\nSECRET' },
    { ...valid, agentId: '-steven' }, { ...valid, target: 'file' }, { agentId: 'bufano', target: 'definition' },
    { agentId: 'steven', target: 'book' }, { agentId: 'steven', target: 'definition', index: 0 },
    ...[-1, 4, 1.5, '0', null, {}, true].map(index => ({ ...valid, index })),
    ...['true', 1, null, {}].map(reveal => ({ ...valid, reveal })),
    { ...valid, path: ctx.books[0] }, { ...valid, path: 'C:\\SECRET\\payload.exe' },
    { ...valid, file: 'C:\\SECRET\\payload.exe', reveal: true }, { ...valid, command: 'SECRET' },
  ];
  for (const body of bad) assert.equal((await ctx.post(body)).status, 400, JSON.stringify(body));
  assert.equal(ctx.calls.length, 0);
  const logs = await openLogs(ctx.config);
  assert.equal(logs.length, bad.length);
  assert.ok(logs.every(row => row.result === 'invalid'));
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
  assert.ok(logs.every(row => Object.keys(row).sort().join(',') === 'agentId,index,result,target'));
  for (const [body, contentType, status] of [['{', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(33000), 'application/json', 413]]) {
    assert.equal((await fetch(ctx.base + '/api/open', { method: 'POST', headers: { ...ctx.headers, 'Content-Type': contentType }, body })).status, status);
  }
  assert.equal(ctx.calls.length, 0);
});

test('v010 missing-file 404, live existence checks, reveal selection or parent fallback, and missing-folder 404', async t => {
  const ctx = await running(t);
  const body = { agentId: 'arnova', target: 'book', index: 0 };
  const missing = await ctx.post(body);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: '原书文件不存在', path: ctx.missing, folderExists: true });
  assert.equal(ctx.calls.length, 0);
  assert.equal((await ctx.post({ ...body, reveal: true })).status, 200);
  assert.deepEqual(ctx.calls.at(-1), [ctx.missing, { reveal: true, exists: false, target: 'book' }]);
  await put(ctx.missing, 'now present');
  assert.equal((await ctx.post(body)).status, 200);
  assert.deepEqual(ctx.calls.at(-1), [ctx.missing, { reveal: false, exists: true, target: 'book' }]);
  assert.equal((await ctx.post({ ...body, reveal: true })).status, 200);
  assert.deepEqual(ctx.calls.at(-1), [ctx.missing, { reveal: true, exists: true, target: 'book' }]);
  await fs.unlink(ctx.walvo); // Registry said true: never trust the cached exists flag.
  assert.equal((await ctx.post({ agentId: 'walvo', target: 'book' })).status, 404);
  // Move only this fixture directory; the root comes from mkdtemp above.
  const from = path.resolve(ctx.root, 'Reading'), to = path.resolve(ctx.root, 'Moved-Reading');
  for (const dir of [from, to]) assert.ok(dir.startsWith(path.resolve(ctx.root) + path.sep));
  await fs.rename(from, to);
  for (const reveal of [false, true]) {
    const response = await ctx.post({ ...body, reveal });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: '原书文件不存在', path: ctx.missing, folderExists: false });
  }
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual((await openLogs(ctx.config)).map(row => row.result), ['not-found', 'revealed', 'opened', 'revealed', 'not-found', 'not-found', 'not-found']);
});

test('v010 missing role definition follows the same 404/reveal contract and a book-shaped directory is not opened as a file', async t => {
  const ctx = await running(t);
  await fs.unlink(ctx.definition);
  const body = { agentId: 'steven', target: 'definition' };
  const response = await ctx.post(body);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: '原书文件不存在', path: ctx.definition, folderExists: true });
  assert.equal((await ctx.post({ ...body, reveal: true })).status, 200);
  assert.deepEqual(ctx.calls, [[ctx.definition, { reveal: true, exists: false, target: 'definition' }]]);
  await fs.mkdir(ctx.missing);
  assert.equal((await ctx.post({ agentId: 'arnova', target: 'book' })).status, 404);
  assert.equal(ctx.calls.length, 1);
});

test('v010 registry refresh replaces open targets without accepting any client path', async t => {
  const ctx = await running(t);
  const replacement = path.join(ctx.root, 'Replacement.epub'); await put(replacement, 'replacement');
  await put(path.join(ctx.config.codexAgentsDir, 'walvo.toml'), `name="Walvo"\ndeveloper_instructions='''${replacement}'''`);
  assert.equal((await fetch(ctx.base + '/api/refresh', { method: 'POST', headers: ctx.headers })).status, 200);
  assert.equal((await ctx.post({ agentId: 'walvo', target: 'book' })).status, 200);
  assert.deepEqual(ctx.calls, [[replacement, { reveal: false, exists: true, target: 'book' }]]);
});

test('v010 opener rejection returns a failure and one result log, without leaking exception data', async t => {
  const ctx = await running(t, { opener: async () => { throw new Error('SECRET command and path'); } });
  const response = await ctx.post({ agentId: 'walvo', target: 'book' });
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: '打开失败' });
  assert.deepEqual(await openLogs(ctx.config), [{ agentId: 'walvo', target: 'book', index: 0, result: 'failed' }]);
  assert.ok(!(await fs.readFile(path.join(ctx.config.dataDir, 'logs', 'server.log'), 'utf8')).includes('SECRET'));
});

test('v010 default opener uses explorer argv, shell:false, windowsHide and unref only after spawn; never executes a real process', async () => {
  const { createOpener } = await import('../src/open.mjs');
  const calls = [];
  const opener = createOpener({ spawnImpl: (exe, args, options) => {
    const child = new EventEmitter(); const call = { exe, args, options, unref: false }; calls.push(call);
    child.unref = () => { call.unref = true; }; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  const file = String.raw`D:\Books & Notes\A, B (Author) $value.epub`;
  const base = { shell: false, windowsHide: false, detached: true, stdio: 'ignore' }; // GUI handlers: SW_HIDE would hide the opened window
  // Claude acceptance 2026-10-08: Explorer cannot parse a Node-quoted "/select,<path with spaces>" (it fell back to
  // Documents), so reveal passes a verbatim, explicitly quoted argument.
  for (const [options, argument, extra] of [
    [{ reveal: false, exists: true }, file, {}],
    [{ reveal: true, exists: true }, `/select,"${file}"`, { windowsVerbatimArguments: true }],
    [{ reveal: true, exists: false }, String.raw`"D:\Books & Notes"`, { windowsVerbatimArguments: true }],
  ]) {
    const work = opener(file, options);
    assert.equal(calls.at(-1).unref, false); await work;
    assert.deepEqual(calls.at(-1), { exe: 'explorer.exe', args: [argument], options: { ...base, ...extra }, unref: true });
  }
});

test('v010 definition files use the default app only when a UserChoice exists, else VS Code, else Notepad', async () => {
  const { createOpener } = await import('../src/open.mjs');
  const file = String.raw`C:\Users\x\.codex\agents\steven.toml`;
  const code = String.raw`C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe`;
  for (const [choice, vscode, exe, args] of [
    [true, true, 'explorer.exe', [file]],
    [false, true, code, [file]],
    [false, false, 'notepad.exe', [file]],
  ]) {
    const calls = [];
    const opener = createOpener({
      spawnImpl: (exe, args, options) => { const child = new EventEmitter(); child.unref = () => {}; calls.push({ exe, args, options }); queueMicrotask(() => child.emit('spawn')); return child; },
      hasUserChoice: async ext => { assert.equal(ext, '.toml'); return choice; },
      exists: async p => vscode && p === code,
      env: { LOCALAPPDATA: String.raw`C:\Users\x\AppData\Local`, ProgramFiles: String.raw`C:\Program Files` },
    });
    await opener(file, { target: 'definition' });
    assert.equal(calls.length, 1); assert.equal(calls[0].exe, exe); assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, false);
  }
  // Books never consult the association check.
  const calls = []; let asked = false;
  const opener = createOpener({ spawnImpl: (exe, args) => { const c = new EventEmitter(); c.unref = () => {}; calls.push(exe); queueMicrotask(() => c.emit('spawn')); return c; },
    hasUserChoice: async () => { asked = true; return false; } });
  await opener(String.raw`D:\Books\x.epub`, { target: 'book' }); assert.deepEqual(calls, ['explorer.exe']); assert.equal(asked, false);
});

test('v010 default opener reports both synchronous and asynchronous spawn failure without unref or retries', async () => {
  const { createOpener } = await import('../src/open.mjs');
  for (const synchronous of [true, false]) {
    let count = 0, unref = false;
    const opener = createOpener({ spawnImpl: () => {
      count++; const error = Object.assign(new Error('fixture explorer missing'), { code: 'ENOENT' });
      if (synchronous) throw error;
      const child = new EventEmitter(); child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit('error', error)); return child;
    } });
    await assert.rejects(opener(String.raw`D:\Books\x.epub`), { code: 'ENOENT' });
    assert.equal(count, 1); assert.equal(unref, false);
  }
});

test('v010 package and both root lockfile versions are 0.13.0 with unchanged dependencies', async () => {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  assert.equal(manifest.version, '0.53.4'); assert.equal(lock.version, '0.53.4'); assert.equal(lock.packages[''].version, '0.53.4');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, { '@electron/packager': '20.3.0', electron: '44.10.2' });
});
