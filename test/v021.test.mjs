import './fixtures/time-zone.mjs';
import { appDocument } from './fixtures/app.mjs';
import { layouts } from '../public/layouts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { createLaunch } from '../src/launch/spec.mjs';
import { spawnTerminal } from '../src/launch/spawner.mjs';
import { verifyLaunch } from '../src/launch/verify.mjs';
import { parseClaude } from '../src/stats/claude.mjs';
import { createStats } from '../src/stats/index.mjs';
import { fixture, fakeSpawner, jsonl, put } from './fixtures/helpers.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-06T12:00:00.000Z';
const agent = name => ({ id: name.replace(/^-/, '').toLowerCase(), name, platforms: {
  claude: { available: true, name: name.replace(/^-/, '').toLowerCase() }, codex: { available: true },
} });

test('U1 scrubs every case-insensitive host pattern, retains unrelated values and records names only', async t => {
  const { root, config } = await fixture(t);
  const removed = ['CLAUDECODE', 'claude_code_TEST', 'Claude_PID', 'CLAUDE_EFFORT', 'claude_agent_sdk_X',
    'CLAUDE_PLUGIN_X', 'Claude_Preview_X', 'CODEX_TOOLKIT_X', 'codex_thread_id', 'CODEX_SANDBOX',
    'codex_sandbox_more', 'octopus_worker'];
  const env = Object.fromEntries(removed.map(key => [key, 'secret-must-not-be-logged']));
  Object.assign(env, { PATH: 'synthetic-path', ANTHROPIC_API_KEY: 'retained-secret', AH_CUSTOM: 'keep',
    CLAUDECODE_OTHER: 'keep', CODEX_THREAD_ID_OTHER: 'keep', CO_AGENT_CUSTOM: 'keep' });
  const before = { ...env }, calls = [];
  await spawnTerminal(path.join(root, 'spec.json'), config, fakeSpawner(calls), env);
  for (const key of removed) assert.equal(Object.hasOwn(calls[0].options.env, key), false, key);
  for (const key of Object.keys(env).filter(key => !removed.includes(key))) assert.equal(calls[0].options.env[key], env[key]);
  assert.deepEqual(env, before);
  const launch = await createLaunch(agent('-steven'), 'claude', config, { spawnImpl: fakeSpawner(calls), env });
  const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
  assert.deepEqual(spec.scrubbedEnv, removed);
  assert.doesNotMatch(JSON.stringify(spec), /secret-must-not-be-logged|retained-secret/);
});

for (const brand of ['Agent Hub', 'CO-AGENT']) for (const [cli, mode] of [['claude', 'agent'], ['claude', 'relay'], ['codex', 'relay']]) {
  test(`U1/U3 ${brand} ${cli}/${mode} accepts post-probe non-READY text only while alive`, async t => {
    const { config } = await fixture(t);
    const launch = { launchId: id, sessionId: id, agentName: '-jack', cli, mode, createdAt: at, pid: 123 };
    const marker = `【${brand} 启动检查 ${id}】`;
    const msg = (role, text) => cli === 'claude' ? { type: role, cwd: config.launchProject, message: { role, content: [{ type: 'text', text }] } } :
      { type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
    const header = cli === 'claude' ? { type: 'agent-setting', agentSetting: '-jack' } :
      { type: 'session_meta', payload: { id: 'parent', timestamp: at, cwd: config.launchProject, source: 'cli' } };
    const file = cli === 'claude' ? path.join(config.claudeProjectsDir, 'p', `${id}.jsonl`) :
      path.join(config.codexSessionsDir, '2026', '10', '06', 'rollout-main.jsonl');
    const check = async rows => {
      await jsonl(file, rows); const date = new Date(Date.parse(at) + 1000); await fs.utimes(file, date, date);
      return verifyLaunch(launch, config, { now: Date.parse(at), isAlive: () => true });
    };
    assert.equal((await check([header, msg('assistant', 'FINAL_STATUS: NEEDS_INPUT'), msg('user', marker)])).waiting.state, 'pending');
    assert.equal((await check([header, msg('user', marker), msg('assistant', '  ')])).waiting.state, 'pending');
    const status = await check([header, msg('user', marker), msg('assistant', 'FINAL_STATUS: NEEDS_INPUT')]);
    assert.equal(status.waiting.state, 'ok'); assert.equal(status.overall, 'ready');
    assert.equal((await verifyLaunch(launch, config, { isAlive: () => false })).waiting.state, 'pending');
  });
}

test('U2 all eight roles use exact contract templates and force Claude relay even with probe disabled', async t => {
  const { config } = await fixture(t);
  // v0.53: the launch templates of the v0.2.1 manual, kept verbatim in test/fixtures/templates.
  const templates = await Promise.all(['claude', 'codex'].map(cli => fs.readFile(path.join(projectRoot, `test/fixtures/templates/v0.2.1-${cli}.txt`), 'utf8').then(text => text.replaceAll('\r\n', '\n'))));
  const contracts = JSON.parse(await fs.readFile('test/fixtures/catalog/task-contracts.json', 'utf8'));
  for (const name of contracts.octopus) {
    const role = agent(name), calls = [];
    for (const cli of ['claude', 'codex']) {
      const launch = await createLaunch(role, cli, { ...config, readyProbe: false, claudeLaunchMode: 'agent' }, { spawnImpl: fakeSpawner(calls) });
      const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
      const expected = templates[cli === 'claude' ? 0 : 1].replaceAll('<codexName>', name)
        .replaceAll('<claudeName>', role.platforms.claude.name).replaceAll('<launchId>', launch.launchId);
      assert.equal(launch.mode, 'relay');
      if (cli === 'claude') {
        assert.deepEqual(spec.args, ['--session-id', launch.launchId, '--append-system-prompt', expected,
          `【CO-AGENT 启动检查 ${launch.launchId}】这不是任务。不要读取文件，也不要调用任何工具。只回复 READY，然后等待我的下一条消息。`]);
      } else assert.deepEqual(spec.args, ['--profile', config.codexProfile, '-m', 'gpt-test', '-c', 'model_reasoning_effort=xhigh', '-C', config.launchProject, expected]);
      assert.equal(spec.title, `CO-AGENT · ${role.name} · ${spec.launchId.slice(0, 4)}`);
      assert.equal(calls.at(-1).options.shell, false);
      assert.ok(calls.at(-1).args.every(arg => !arg.includes(expected)));
    }
  }
});

test('U2 outside-list Claude honors global modes and Codex retains original renamed instruction', async t => {
  const { config } = await fixture(t);
  for (const mode of ['agent', 'relay']) {
    const launch = await createLaunch(agent('harlo'), 'claude', { ...config, claudeLaunchMode: mode }, { spawnImpl: fakeSpawner() });
    const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
    assert.equal(launch.mode, mode); assert.doesNotMatch(spec.args.join('\n'), /OCTOPUS_WORKER/);
    if (mode === 'agent') assert.deepEqual(spec.args.slice(0, 4), ['--agent', 'harlo', '--session-id', launch.launchId]);
  }
  const launch = await createLaunch(agent('Loki'), 'codex', config, { spawnImpl: fakeSpawner() });
  const spec = JSON.parse(await fs.readFile(launch.specFile, 'utf8'));
  assert.equal(spec.args.at(-1), `【CO-AGENT 启动检查 ${launch.launchId}】本会话绑定自定义 Agent「Loki」。对我之后的每个问题：派生 agent_role 为「Loki」的子 Agent，把我的原话作为任务交给它，并呈现它的结果。不要派生其他 Agent。现在不要派生任何 Agent，也不要调用工具，只回复 READY Loki，然后等待。`);
});

test('U2 a malformed contract fails server startup clearly before scanning or spawning', async t => {
  const { root, config } = await fixture(t), file = path.join(root, 'task-contracts.json');
  for (const contents of ['{', '[]', '{}', '{"version":2,"octopus":["-jack"]}', '{"octopus":"bad"}', '{"octopus":[null]}', '{"octopus":[""]}']) {
    await put(file, contents);
    let scanned = false;
    await assert.rejects(createApp({ ...config, taskContractsFile: file }, {
      registryBuilder: async () => { scanned = true; return { agents: [] }; }, spawnImpl: () => assert.fail('spawn'),
    }), /任务格式清单.*task-contracts\.json/);
    assert.equal(scanned, false);
  }
});

for (const [oldExists, newExists] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`U3 migration COPY combinations old=${oldExists} new=${newExists}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-agent-migration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const legacy = path.join(root, 'Agent Hub'), target = path.join(root, 'CO-AGENT');
    if (oldExists) {
      await put(path.join(legacy, 'config.json'), '{"port":12345}');
      await put(path.join(legacy, 'launches', 'nested', 'spec.json'), 'preserve bytes 中文');
      await put(path.join(legacy, 'stats-index.json'), 'do not copy');
      await put(path.join(legacy, 'other.txt'), 'do not copy');
    }
    if (newExists) await put(path.join(target, 'config.json'), '{"port":54321}');
    const messages = [];
    const config = await loadConfig({ env: { LOCALAPPDATA: root }, home: root, log: msg => messages.push(msg) });
    assert.equal(config.dataDir, target);
    assert.equal(Boolean(config.dataDirMigration), oldExists && !newExists);
    assert.equal(messages.length, oldExists && !newExists ? 1 : 0);
    assert.equal(config.port, newExists ? 54321 : oldExists ? 12345 : 47821);
    if (oldExists) {
      assert.equal(await fs.readFile(path.join(legacy, 'launches', 'nested', 'spec.json'), 'utf8'), 'preserve bytes 中文');
      assert.equal(await fs.readFile(path.join(legacy, 'stats-index.json'), 'utf8'), 'do not copy');
    }
    if (oldExists && !newExists) {
      assert.deepEqual(await fs.readFile(path.join(legacy, 'config.json')), await fs.readFile(path.join(target, 'config.json')));
      assert.equal(await fs.readFile(path.join(target, 'launches', 'nested', 'spec.json'), 'utf8'), 'preserve bytes 中文');
      await assert.rejects(fs.stat(path.join(target, 'stats-index.json')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(target, 'other.txt')), { code: 'ENOENT' });
      assert.match(createStats(config, []).snapshot().dataDirMigration, /已从旧目录迁移/);
    }
  });
}

test('U3 explicit data env priorities never inspect or migrate legacy LOCALAPPDATA', async t => {
  const { root } = await fixture(t);
  await put(path.join(root, 'Agent Hub', 'config.json'), '{invalid');
  const newer = path.join(root, 'chosen-new'), older = path.join(root, 'chosen-old');
  assert.equal((await loadConfig({ env: { LOCALAPPDATA: root, CO_AGENT_DATA_DIR: newer, AGENT_HUB_DATA_DIR: older } })).dataDir, newer);
  assert.equal((await loadConfig({ env: { LOCALAPPDATA: root, AGENT_HUB_DATA_DIR: older } })).dataDir, older);
  await assert.rejects(fs.stat(path.join(root, 'CO-AGENT')), { code: 'ENOENT' });
});

test('U3 public branding is byte-identical, named and accessible', async () => {
  for (const name of ['co-agent-icon.svg', 'co-agent-favicon.svg']) assert.deepEqual(
    await fs.readFile(`public/brand/${name}`), await fs.readFile(`assets/brand/${name}`));
  const html = await fs.readFile('public/index.html', 'utf8');
  assert.match(html, /<title>CO-AGENT<\/title>/);
  assert.match(html, /<footer>CO-AGENT v<!-- CO_AGENT_VERSION -->/);
  for (const layout of Object.values(layouts)) {
    const { doc } = await appDocument(); const root=layout.render({doc,refs:{},state:{},actions:{}});
    const icon=root.querySelector('img'); assert.equal(icon.getAttribute('src'),'/brand/co-agent-icon.svg'); assert.equal(icon.getAttribute('alt'),'');
  }
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/brand\/co-agent-favicon.svg">/);
});

for (const brand of ['Agent Hub', 'CO-AGENT']) test(`U3 stats excludes ${brand} probe-only sessions but includes subsequent real questions`, async t => {
  const { root } = await fixture(t), file = path.join(root, 'main.jsonl');
  const rows = [{ type: 'agent-setting', agentSetting: '-steven' },
    { type: 'user', timestamp: at, message: { role: 'user', content: `【${brand} 启动检查 ${id}】` } }];
  await jsonl(file, rows); assert.equal((await parseClaude(file)).events.length, 0);
  await jsonl(file, [...rows, { type: 'user', timestamp: at, message: { role: 'user', content: 'real question' } }]);
  assert.equal((await parseClaude(file)).events.length, 1);
});

test('U4 absent hub is available zero; existing unreadable hub stays limited and error prefix is unique', async t => {
  const { config } = await fixture(t);
  config.codexArchiveDirs = [];
  const stats = createStats(config, []); await stats.refresh();
  const data = stats.snapshot(), hub = data.sources.find(s => s.id === 'hub');
  assert.equal(hub.available, true); assert.equal(hub.files, 0); assert.equal(hub.parsedFiles, 0);
  assert.equal(data.limited, false);
  await put(path.join(config.dataDir, 'launches'), 'not a directory'); await stats.refresh();
  assert.equal(stats.snapshot().sources.find(s => s.id === 'hub').available, false);
  assert.equal(stats.snapshot().limited, true);
  assert.doesNotMatch(JSON.stringify(stats.snapshot().limitedReasons), /ENOTDIR: ENOTDIR:/);
  config.codexSessionsDir = path.join(config.dataDir, 'missing');
  await stats.refresh(); assert.doesNotMatch(JSON.stringify(stats.snapshot().limitedReasons), /ENOENT: ENOENT:|256 KB/);
  assert.equal(stats.snapshot().explanations.filter(s => s.includes('256 KB')).length, 1);
});

test('U4 coverage includes zero-event sessions and min(mtime, first timestamp) across cache reloads', async t => {
  const { config } = await fixture(t); config.codexArchiveDirs = [];
  const claude = path.join(config.claudeProjectsDir, 'p', 'empty.jsonl');
  await jsonl(claude, [{ type: 'agent-setting', agentSetting: 'harlo' }, { type: 'user', timestamp: '2026-09-06T16:01:00Z', message: { role: 'user', content: '【Agent Hub 启动检查 x】' } }]);
  await fs.utimes(claude, new Date('2026-09-08'), new Date('2026-09-08'));
  const codex = path.join(config.codexSessionsDir, 'rollout-parent.jsonl');
  await jsonl(codex, [{ type: 'session_meta', payload: { id: 'parent', timestamp: '2026-07-01T00:00:00Z', source: 'cli' } }]);
  await fs.utimes(codex, new Date('2026-06-01'), new Date('2026-06-01'));
  const check = async stats => {
    await stats.refresh(); const data = stats.snapshot();
    assert.equal(data.sources[0].earliestAt, '2026-09-06T16:01:00.000Z');
    assert.equal(data.sources[1].earliestAt, '2026-06-01T00:00:00.000Z');
    assert.ok(data.limitedReasons.includes('Claude 会话记录最早只到 2026-09-07，此前的 Claude 调用无法统计'));
  };
  const stats = createStats(config, []); await check(stats); await check(createStats(config, []));
  await fs.utimes(claude, new Date('2026-05-01'), new Date('2026-05-01'));
  await stats.refresh(); assert.equal(stats.snapshot().sources[0].earliestAt, '2026-05-01T00:00:00.000Z');
});

test('U4 old v0.2 cache is rebuilt to fix unchanged probe events and missing coverage metadata', async t => {
  const { config } = await fixture(t); config.codexArchiveDirs = [];
  const file = path.join(config.claudeProjectsDir, 'p', 'probe.jsonl');
  await jsonl(file, [{ type: 'agent-setting', agentSetting: '-steven' }, { type: 'user', timestamp: at, message: { role: 'user', content: '【CO-AGENT 启动检查 x】' } }]);
  const stat = await fs.stat(file);
  await put(path.join(config.dataDir, 'stats-index.json'), JSON.stringify({ version: 1, files: { [file]: {
    size: stat.size, mtimeMs: stat.mtimeMs, badLines: 0, events: [{ key: 'claude:session:old', kind: 'session', source: 'claude', at, agentName: '-steven' }],
  } } }));
  let parses = 0; const stats = createStats(config, [agent('-steven')], { onParse: () => parses++ });
  await stats.refresh(); assert.equal(parses, 1); assert.equal(stats.snapshot().perAgent.steven.total.calls, 0);
});

test('U4 coverage fallback includes malformed session files with known mtime', async t => {
  const { config } = await fixture(t); config.codexArchiveDirs = [];
  const file = path.join(config.codexSessionsDir, 'rollout-broken.jsonl');
  await put(file, '{bad\n'); const date = new Date('2026-01-01'); await fs.utimes(file, date, date);
  const stats = createStats(config, []); await stats.refresh();
  assert.equal(stats.snapshot().sources[1].earliestAt, '2026-01-01T00:00:00.000Z');
  assert.equal(stats.snapshot().sources[1].failedFiles.length, 1);
});

test('U3 migration validates copied config placement before writing new data directory', async t => {
  const { root } = await fixture(t);
  const target = path.join(root, 'CO-AGENT');
  await put(path.join(root, 'Agent Hub', 'config.json'), JSON.stringify({ codexAgentsDir: root }));
  await assert.rejects(loadConfig({ env: { LOCALAPPDATA: root }, home: root }), /运行数据/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

// v0.51: the list lives in catalogDir; a new install has none, so missing or empty means no agent needs the format.
test('U2 a missing or empty contract means no task format', async t => {
  const { root, config } = await fixture(t), file = path.join(root, 'task-contracts.json');
  for (const contents of [null, '{"version":1,"octopus":[]}']) {
    if (contents !== null) await put(file, contents);
    const started = { ...config, taskContractsFile: file };
    const app = await createApp(started, { registryBuilder: async () => ({ agents: [] }), conceptAutoDaily: false });
    t.after(() => app.close());
    assert.deepEqual(started.taskContracts, { version: 1, octopus: [] });
  }
});
