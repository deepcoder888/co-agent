import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fixture, put, fakeSpawner } from './fixtures/helpers.mjs';
import { createStats } from '../src/stats/index.mjs';

async function running(t) {
  let app;
  t.after(() => app?.close()); // Close background indexing before fixture cleanup.
  const { config } = await fixture(t);
  await put(path.join(config.codexAgentsDir, 'jack.toml'), 'name="-jack"\ndescription="Role"');
  await put(path.join(config.codexAgentsDir, 'loki.toml'), 'name="Loki"\ndescription="Role"');
  await put(path.join(config.codexAgentsDir, 'other.toml'), 'name="Other"\ndescription="utility"');
  await put(path.join(config.claudeAgentDirs[0], 'jack.md'), '---\nname: jack\n---');
  const calls = [];
  app = await createApp(config, { spawnImpl: fakeSpawner(calls) });
  try { await app.listen(); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`BLOCKED localhost bind: ${error.code}: ${error.message}`); return null; }
    throw error;
  }
  const port = app.server.address().port;
  assert.equal(app.server.address().address, '127.0.0.1');
  return { app, config, calls, port, base: `http://127.0.0.1:${port}`, token: app.token };
}

function raw(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
}

test('U2/U3 registry exposes task adaptation; both token names work and new-name errors cannot fall back', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token } = ctx;
  const registry = await (await fetch(`${base}/api/registry`)).json();
  assert.equal(registry.agents.find(a => a.id === 'jack').taskFormat, true);
  assert.equal(registry.agents.find(a => a.id === 'loki').taskFormat, false);
  for (const name of ['X-Co-Agent-Token', 'X-Agent-Hub-Token']) {
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { [name]: token } })).status, 200);
    assert.equal((await fetch(`${base}/api/stats/refresh`, { method: 'POST', headers: { [name]: token, Origin: 'https://evil.example' } })).status, 403);
  }
  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: {
    'X-Co-Agent-Token': 'invalid', 'X-Agent-Hub-Token': token,
  } })).status, 403);
  for (const name of ['co-agent-icon.svg', 'co-agent-favicon.svg']) {
    const response = await fetch(`${base}/brand/${name}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  }
});

test('T7 registry API, HTML token and local static assets; immutable definitions', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token } = ctx;
  assert.match(token, /^[a-f0-9]{64}$/);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy'));
  assert.match(await response.text(), new RegExp(`<meta name="agent-hub-token" content="${token}">`));
  assert.match(await (await fetch(`${base}/index.html`)).text(), new RegExp(token));
  const registry = await (await fetch(`${base}/api/registry`)).json();
  assert.equal(registry.summary.roles, 2);
  assert.equal(registry.summary.outOfScope, 1);
  assert.equal(registry.agents[0].platforms.claude.available, true);
  for (const file of ['app.js', 'styles.css']) assert.equal((await fetch(`${base}/${file}`)).status, 200);
});

test('T7 wrong/missing Host, token and external/mismatched Origin rejected before mutation', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token, calls, port } = ctx;
  assert.equal(await raw(port, '/api/registry', { Host: `evil.example:${port}` }), 421);
  assert.equal(await raw(port, '/api/registry', { Host: 'localhost' }), 421);
  for (const headers of [{}, { 'X-Agent-Hub-Token': 'bad' }, { 'X-Agent-Hub-Token': 'é'.repeat(64) },
    { 'X-Agent-Hub-Token': token, Origin: 'https://evil.example' },
    { 'X-Agent-Hub-Token': token, Origin: `http://localhost:${port}` }]) {
    const response = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ agentId: 'jack', cli: 'claude' }) });
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, Origin: base } })).status, 200);
  assert.equal(await raw(port, '/api/registry', { Host: `localhost:${port}` }), 200);
});

test('T7 raw and encoded traversal blocked; no static source or spec exposure', async t => {
  const ctx = await running(t); if (!ctx) return;
  for (const requestPath of ['/../AGENTS.md', '/%2e%2e/AGENTS.md', '/..%5cAGENTS.md', '/%252e%252e/AGENTS.md', '/src/config.mjs', '/data/roles.json', '/%00', '/%zz']) {
    const status = await raw(ctx.port, requestPath);
    assert.ok([403, 404].includes(status), `${requestPath}: ${status}`);
  }
});

test('T7 validates launch body, in-scope id and availability; refresh changes only registry', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token, calls, config } = ctx;
  const send = body => fetch(`${base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Hub-Token': token }, body: JSON.stringify(body) });
  for (const body of [{ agentId: 'other', cli: 'codex' }, { agentId: 'absent', cli: 'codex' }, { agentId: 'jack', cli: 'shell' }, [], null, { agentId: { id: 'jack' }, cli: 'codex' }]) assert.equal((await send(body)).status, 400);
  const unavailable = await send({ agentId: 'loki', cli: 'claude' });
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json()).error, /Claude/);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${base}/api/launch/not-a-uuid`)).status, 404);
  assert.equal((await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'application/json' }, body: 'x'.repeat(33000) })).status, 413);
  await put(path.join(config.codexAgentsDir, 'new.toml'), 'name="NewBook"\ndescription="Read-only book Agent"');
  const refreshed = await (await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token } })).json();
  assert.equal(refreshed.summary.uncategorized, 0);
  assert.equal(refreshed.summary.candidates, 1);
  assert.equal(refreshed.candidates[0].id, 'newbook');
  assert.equal((await send({agentId:'newbook',cli:'codex'})).status,400, 'v0.18 candidate cannot launch before admission');
});

test('T7 valid launch uses injected spawner; status GET checks four items and missing executable is a failure', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token, calls, config } = ctx;
  const launch = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'jack', cli: 'codex' }) });
  assert.equal(launch.status, 200);
  const result = await launch.json();
  assert.equal(result.agentName, '-jack');
  assert.equal(result.mode, 'relay');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.argvPreview.helper, calls[0].args);
  assert.deepEqual(result.argvPreview.terminal, ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('launcher/launch.ps1'), '-SpecFile', calls[0].options.env.AH_SPEC]);
  const status = await (await fetch(`${base}/api/launch/${result.launchId}`)).json();
  for (const field of ['process', 'cwd', 'agent', 'waiting']) assert.ok(status[field].state);
  assert.equal(status.process.pid, process.pid);
  config.codexExe = 'agent-hub-missing-cli';
  const missing = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'jack', cli: 'codex' }) });
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /CLI/);
  assert.equal(calls.length, 1);
});

test('T7 occupied configured port fails instead of changing port', async t => {
  const ctx = await running(t); if (!ctx) return;
  const second = await createApp({ ...ctx.config, port: ctx.port }, { spawnImpl: fakeSpawner() });
  await assert.rejects(second.listen(), error => error.code === 'EADDRINUSE');
  await second.close();
  assert.equal(second.server.listening, false);
});

test('finding #3 launch API and fresh/cached status responses carry trust notice', async t => {
  const ctx = await running(t); if (!ctx) return;
  const { base, token, config, calls } = ctx;
  const notice = '首次在此目录使用交互式 Claude：请在弹出的窗口中选择「Yes, I trust this folder」并按回车，之后会话才会开始。';
  config.verifyTimeoutMs = 60000;
  config.verifyPollMs = 60000;
  const send = cli => fetch(`${base}/api/launch`, { method: 'POST', headers: { 'X-Agent-Hub-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'jack', cli }) });
  const response = await send('claude');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.notice, notice);
  const statusUrl = `${base}/api/launch/${result.launchId}`;
  for (let i = 0; i < 2; i++) {
    const status = await (await fetch(statusUrl)).json();
    assert.equal(status.overall, 'pending');
    assert.equal(status.notice, notice);
  }
  config.verifyTimeoutMs = 0;
  config.verifyPollMs = 0; // Force a new verification without waiting or launching anything real.
  const timedOut = await (await fetch(statusUrl)).json();
  assert.equal(timedOut.overall, 'unconfirmed');
  assert.equal(timedOut.notice, notice);
  assert.equal((await (await fetch(statusUrl)).json()).notice, notice);
  await put(config.claudeStateFile, JSON.stringify({ projects: { [config.launchProject]: { hasTrustDialogAccepted: true } } }));
  const trusted = await (await send('claude')).json();
  assert.equal(trusted.notice, undefined);
  assert.equal((await (await fetch(`${base}/api/launch/${trusted.launchId}`)).json()).notice, undefined);
  const codex = await (await send('codex')).json();
  assert.equal(codex.notice, undefined);
  assert.equal((await (await fetch(`${base}/api/launch/${codex.launchId}`)).json()).notice, undefined);
  assert.equal(calls.length, 3);
});

test('S5 background stats does not block registry, serialized token-protected refresh and API schema', async t => {
  let app, release;
  t.after(async () => { release?.(); await app?.close(); });
  const { config } = await fixture(t);
  const gate = new Promise(resolve => { release = resolve; });
  const registry = { agents: [{ id: 'jack', name: '-jack' }], marker: 'registry-ready' };
  await put(path.join(config.claudeProjectsDir, 'p', 'main.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name: 'Agent', id: 'synthetic', input: { subagent_type: '-jack' } }] } }) + '\n');
  app = await createApp(config, { registryBuilder: async () => registry,
    statsFactory: (cfg, agents) => createStats(cfg, agents, { parsers: { claude: async () => { await gate; return { events: [], badLines: 0 }; } } }) });
  await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/registry`)).json()).marker, 'registry-ready');
  const data = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(data.building, true); assert.equal(data.timezone, 'Etc/GMT-8'); assert.equal(data.windowDays, 7);
  for (const field of ['generatedAt', 'limited', 'limitedReasons', 'sources', 'perAgent', 'outOfScopeEvents', 'unlabeledSubagents']) assert.ok(Object.hasOwn(data, field));
  assert.equal((await fetch(`${base}/api/stats/refresh`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/stats/refresh`, { method: 'POST', headers: { 'X-Agent-Hub-Token': app.token, Origin: 'https://evil.test' } })).status, 403);
  const refreshed = await (await fetch(`${base}/api/stats/refresh`, { method: 'POST', headers: { 'X-Agent-Hub-Token': app.token } })).json();
  assert.equal(refreshed.building, true); release(); await app.stats.refresh();
  assert.equal((await (await fetch(`${base}/api/stats`)).json()).building, false);
});
