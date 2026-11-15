import './fixtures/time-zone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aggregate, createStats } from '../src/stats/index.mjs';
import { createApp } from '../src/server.mjs';
import { fixture, put, jsonl } from './fixtures/helpers.mjs';

const DAY = 86400000;
const now = Date.parse('2026-10-08T04:00:00.000Z'); // Etc/GMT-8 noon
const agents = [{ id: 'jack', name: '-jack', kind: 'role' }, { id: 'walvo', name: 'Walvo', kind: 'book' }, { id: 'jadra', name: 'Jadra', kind: 'book' }];
const bucket = (calls = 0, ok = 0, failed = 0, unknown = 0, claude = 0, codex = 0) => ({ calls, ok, failed, unknown, bySource: { claude, codex } });
const point = (day, calls = 0, role = 0, book = 0, claude = 0, codex = 0) => ({ day, calls, role, book, claude, codex });
const call = (id, at, status = 'ok', source = 'claude', kind = 'call') => ({ key: `${id}:${at}:${source}`, agentName: id,
  at: typeof at === 'number' ? new Date(at).toISOString() : at, source, status, kind });
const sources = [{ id: 'claude', path: 'claude-source', available: true, failedFiles: [], earliestAt: '2026-08-01T00:00:00Z' },
  { id: 'codex-live', path: 'codex-source', available: true, failedFiles: [], earliestAt: '2026-08-01T00:00:00Z' }];

function legacyFields(value) {
  const { windows, daily, last30dLimited, last30dLimitedReasons, ...old } = value;
  old.perAgent = Object.fromEntries(Object.entries(value.perAgent).map(([id, { last30d, launches, ...stats }]) => {
    const { last30d: launches30, ...oldLaunches } = launches;
    return [id, { ...stats, launches: oldLaunches }];
  }));
  return old;
}

test('v09 new empty snapshot includes independent 30-day buckets, complete daily zeros and windows without altering old fields', () => {
  const value = aggregate([], agents, sources, now);
  assert.equal(value.windowDays, 7); assert.deepEqual(value.windows, [7, 30]);
  assert.equal(value.timezone, 'Etc/GMT-8'); assert.equal(value.last30dLimited, false); assert.deepEqual(value.last30dLimitedReasons, []);
  for (const a of agents) {
    assert.deepEqual(value.perAgent[a.id].last30d, bucket()); assert.equal(value.perAgent[a.id].launches.last30d, 0);
    assert.notEqual(value.perAgent[a.id].last30d, value.perAgent[a.id].last7d);
    assert.notEqual(value.perAgent[a.id].last30d.bySource, value.perAgent[a.id].total.bySource);
  }
  const days = ['2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18',
    '2026-09-19','2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-09-28',
    '2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07','2026-10-08'];
  assert.deepEqual(value.daily, days.map(d => point(d)));
  assert.deepEqual(legacyFields(value), {
    generatedAt: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, windowDays: 7, limited: false, limitedReasons: [], last7dLimited: false, last7dLimitedReasons: [],
    sources, perAgent: Object.fromEntries(agents.map(a => [a.id, { last7d: bucket(), total: bucket(), launches: { last7d: 0, total: 0 }, lastAt: null }])),
    outOfScopeEvents: 0, unlabeledSubagents: 0, building: false,
  });
});

test('v09 rolling 30-day cutoff is inclusive and independent of the 7-day window; future totals stay unchanged', () => {
  const events = [
    call('-JACK', now - 30 * DAY - 1, 'failed'), call('-jack', now - 30 * DAY, 'ok', 'codex'),
    call('jack', now - 7 * DAY - 1, 'unknown'), call('jack', now - 7 * DAY, 'failed', 'codex'),
    call('jack', now, undefined, 'claude', 'session'), call('jack', now + 1, 'ok', 'codex'),
    call('Walvo', now - 12 * DAY, 'other-status', 'codex'),
    call('jack', now - 30 * DAY, undefined, 'hub', 'launch'), call('jack', now - 30 * DAY - 1, undefined, 'hub', 'launch'),
    call('jack', now - 7 * DAY, undefined, 'hub', 'launch'), call('jack', now + 1, undefined, 'hub', 'launch'),
    call('outside', now), call('', now, undefined, 'codex', 'unlabeled'),
  ];
  const beforeEvents = structuredClone(events), beforeSources = structuredClone(sources);
  const value = aggregate(events, agents, sources, now);
  assert.deepEqual(value.perAgent.jack.last30d, bucket(4, 2, 1, 1, 2, 2));
  assert.deepEqual(value.perAgent.walvo.last30d, bucket(1, 0, 0, 1, 0, 1));
  assert.deepEqual(value.perAgent.jadra.last30d, bucket());
  assert.deepEqual(value.perAgent.jack.launches, { last7d: 1, last30d: 2, total: 4 });
  assert.deepEqual(legacyFields(value), {
    generatedAt: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, windowDays: 7,
    limited: false, limitedReasons: [], last7dLimited: false, last7dLimitedReasons: [], sources,
    perAgent: {
      jack: { last7d: bucket(2, 1, 1, 0, 1, 1), total: bucket(6, 3, 2, 1, 3, 3), launches: { last7d: 1, total: 4 }, lastAt: new Date(now + 1).toISOString() },
      walvo: { last7d: bucket(), total: bucket(1, 0, 0, 1, 0, 1), launches: { last7d: 0, total: 0 }, lastAt: new Date(now - 12 * DAY).toISOString() },
      jadra: { last7d: bucket(), total: bucket(), launches: { last7d: 0, total: 0 }, lastAt: null },
    }, outOfScopeEvents: 1, unlabeledSubagents: 1, building: false,
  });
  assert.deepEqual(events, beforeEvents); assert.deepEqual(sources, beforeSources);
});

test('v09 daily uses UTC+8 midnight, known agent kind/source, today up to now, and excludes launches/unlabeled/out-of-scope', () => {
  const value = aggregate([
    call('jack', '2026-09-08T15:59:59.999Z'), // 31st calendar date, but inside the rolling window
    call('-jack', '2026-09-08T16:00:00.000Z', 'failed'), // first calendar date, inclusive
    call('Walvo', '2026-10-07T15:59:59.999Z', 'unknown', 'codex'), // yesterday
    call('Walvo', '2026-10-07T16:00:00.000Z', 'failed'), // today
    call('-jack', '2026-10-08T04:00:00.000Z', 'ok', 'codex'),
    call('jack', '2026-10-08T04:00:00.001Z'), // future, same date
    call('jack', '2026-10-08T16:00:00.000Z'), // tomorrow
    call('walvo', now, 'ok', 'hub', 'launch'), call('outside', now), call('', now, 'ok', 'codex', 'unlabeled'),
  ], agents, sources, now);
  assert.equal(value.daily.length, 30);
  assert.deepEqual(value.daily.filter(p => p.calls), [point('2026-09-09', 1, 1, 0, 1, 0), point('2026-10-07', 1, 0, 1, 0, 1), point('2026-10-08', 2, 1, 1, 1, 1)]);
  assert.equal(value.daily.reduce((sum, p) => sum + p.calls, 0), 4);
  assert.equal(Object.values(value.perAgent).reduce((sum, a) => sum + a.last30d.calls, 0), 5, 'rolling 30d and 30 UTC+8 calendar dates have distinct lower bounds');
  for (const p of value.daily) { assert.equal(p.calls, p.role + p.book); assert.equal(p.calls, p.claude + p.codex); }
});

for (const [at, first, last, contains] of [
  ['2026-12-31T16:00:00Z', '2026-12-03', '2027-01-01', '2026-12-31'],
  ['2024-03-01T00:00:00Z', '2024-02-01', '2024-03-01', '2024-02-29'],
  ['2025-03-01T00:00:00Z', '2025-01-31', '2025-03-01', '2025-02-28'],
  ['2026-10-07T15:59:59.999Z', '2026-09-08', '2026-10-07', '2026-09-30'],
]) test(`v09 daily continuity across calendar boundary ${at}`, () => {
  const value = aggregate([], [], [], Date.parse(at));
  assert.equal(value.daily.length, 30); assert.equal(value.daily[0].day, first); assert.equal(value.daily.at(-1).day, last);
  assert.ok(value.daily.some(p => p.day === contains)); assert.equal(new Set(value.daily.map(p => p.day)).size, 30);
  for (let i = 1; i < value.daily.length; i++) assert.equal(Date.parse(value.daily[i].day) - Date.parse(value.daily[i - 1].day), DAY);
});

test('v09 missing kind/source stays unclassified rather than inventing a split; invalid timestamps never enter daily', () => {
  const value = aggregate([call('legacy', now), call('jack', now, 'ok', 'hub'), call('walvo', 'invalid-time')], [...agents, { id: 'legacy', name: 'legacy' }], [], now);
  assert.deepEqual(value.daily.at(-1), point('2026-10-08', 2, 1, 0, 1, 0));
  assert.deepEqual(value.perAgent.walvo.last30d, bucket());
  assert.equal(value.perAgent.walvo.total.calls, 1, 'legacy total semantics are unchanged for aggregate callers');
});

for (const [label, mtimeMs, limited30, limited7] of [
  ['at 30d cutoff', now - 30 * DAY, true, false], ['before 30d cutoff', now - 30 * DAY - 1, false, false],
  ['between 7 and 30', now - 14 * DAY, true, false], ['at 7d cutoff', now - 7 * DAY, true, true],
  ['now', now, true, true], ['future', now + 1, false, false], ['missing mtime', undefined, true, true], ['NaN', NaN, true, true],
]) test(`v09 limited reasons apply the same inclusive mtime rule: ${label}`, () => {
  const value = aggregate([], agents, [{ id: 'codex-live', available: true, failedFiles: [{ file: 'broken', mtimeMs }] }], now);
  const reason = 'codex-live 有 1 个文件解析失败';
  assert.equal(value.last30dLimited, limited30); assert.deepEqual(value.last30dLimitedReasons, limited30 ? [reason] : []);
  assert.equal(value.last7dLimited, limited7); assert.deepEqual(value.last7dLimitedReasons, limited7 ? [reason] : []);
  assert.equal(value.limited, true); assert.deepEqual(value.limitedReasons, [reason]);
});

test('v09 unavailable sources limit both windows; historical coverage and partial bad lines keep their existing semantics', () => {
  const unavailable = { id: 'claude', path: 'missing-source', available: false, notes: ['EACCES'], failedFiles: [] };
  const missing = aggregate([], agents, [unavailable], now);
  assert.equal(missing.last30dLimited, true); assert.deepEqual(missing.last30dLimitedReasons, missing.last7dLimitedReasons);
  assert.match(missing.last30dLimitedReasons[0], /missing-source.*EACCES/);
  const historical = aggregate([], agents, [{ ...sources[0], earliestAt: '2026-10-01T00:00:00Z', badLines: 1 }, sources[1]], now);
  assert.equal(historical.limited, true); assert.equal(historical.last7dLimited, false); assert.equal(historical.last30dLimited, false);
  assert.deepEqual(historical.last30dLimitedReasons, []); assert.match(historical.limitedReasons[0], /此前的 Claude/);
});

async function logFixture(t) {
  const { config } = await fixture(t);
  await fs.mkdir(config.codexArchiveDirs[0], { recursive: true });
  const claudeFile = path.join(config.claudeProjectsDir, 'project', 'main.jsonl');
  const claudeRows = [
    { type: 'assistant', timestamp: new Date(now - 14 * DAY).toISOString(), message: { content: [{ type: 'tool_use', name: 'Agent', id: 'claude-call', input: { subagent_type: '-jack' } }] } },
    { type: 'user', timestamp: new Date(now - 14 * DAY).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'claude-call', is_error: true }] } },
  ];
  await jsonl(claudeFile, claudeRows);
  await jsonl(path.join(config.claudeProjectsDir, 'project', 'main', 'subagents', 'duplicate.jsonl'), claudeRows.slice(0, 1));
  const live = path.join(config.codexSessionsDir, 'rollout-child.jsonl');
  const rows = [{ type: 'session_meta', payload: { id: 'codex-child', timestamp: '2026-10-07T16:00:00Z', source: { subagent: { thread_spawn: { agent_role: 'Walvo', depth: 1, parent_thread_id: 'main' } } } } },
    { type: 'event_msg', payload: { type: 'task_complete' } }];
  await jsonl(live, rows); await jsonl(path.join(config.codexArchiveDirs[0], 'rollout-copy.jsonl'), rows);
  const launch = { launchId: 'launch-one', agentName: 'Walvo', cli: 'codex', createdAt: new Date(now - 14 * DAY).toISOString() };
  for (const name of ['one','copy']) await put(path.join(config.dataDir, 'launches', name + '.json'), JSON.stringify(launch));
  return { config, live };
}

test('v09 scanner/cache deduplicates all new metrics, recomputes kind/date from cached events, and retains index version', async t => {
  const { config, live } = await logFixture(t); let parses = 0, clock = now;
  const stats = createStats(config, agents, { now: () => clock, onParse: () => parses++ });
  assert.equal(stats.snapshot().daily.length, 30); assert.equal(stats.snapshot().perAgent.jack.last30d.calls, 0);
  await stats.refresh(); const value = stats.snapshot();
  assert.deepEqual(value.perAgent.jack.last30d, bucket(1, 0, 1, 0, 1, 0));
  assert.deepEqual(value.perAgent.walvo.last30d, bucket(1, 1, 0, 0, 0, 1));
  assert.equal(value.perAgent.walvo.launches.last30d, 1); assert.equal(value.daily.reduce((n, p) => n + p.calls, 0), 2);
  const parsed = parses; await stats.refresh(); assert.equal(parses, parsed); assert.deepEqual(stats.snapshot(), value);
  const restored = createStats(config, agents, { now: () => clock, onParse: () => parses++ }); await restored.refresh();
  assert.equal(parses, parsed); assert.deepEqual(restored.snapshot(), value);
  clock += DAY; stats.setAgents(agents.map(a => a.id === 'walvo' ? { ...a, kind: 'role' } : a)); await stats.refresh();
  assert.equal(parses, parsed); assert.equal(stats.snapshot().daily.at(-1).day, '2026-10-09');
  assert.deepEqual(stats.snapshot().daily.find(p => p.day === '2026-10-08'), point('2026-10-08', 1, 1, 0, 0, 1));
  await fs.rm(live); await stats.refresh(); assert.equal(stats.snapshot().perAgent.walvo.last30d.calls, 1, 'archive still supplies one event');
  await fs.rm(path.join(config.codexArchiveDirs[0], 'rollout-copy.jsonl')); await stats.refresh();
  assert.equal(stats.snapshot().perAgent.walvo.last30d.calls, 1, 'retained live/archive events remain deduplicated');
  assert.equal(stats.snapshot().daily.reduce((n,p) => n + p.calls, 0), 2);
  const cache = JSON.parse(await fs.readFile(path.join(config.dataDir, 'stats-index.json'), 'utf8'));
  assert.equal(cache.version, 1); assert.equal(cache.parserRevision, 2);
});

test('v09 cache-write failure publishes new metrics and preserves existing limited-window behavior', async t => {
  const { config } = await logFixture(t);
  const stats = createStats(config, agents, { now: () => now, write: async () => { throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' }); } });
  await assert.rejects(stats.refresh(), /fixture disk full/); const value = stats.snapshot();
  assert.equal(value.building, false); assert.equal(value.perAgent.jack.last30d.calls, 1); assert.equal(value.daily.length, 30);
  assert.equal(value.limited, true); assert.match(value.indexError, /ENOSPC/);
  assert.equal(value.last7dLimited, false); assert.equal(value.last30dLimited, false);
});

test('v09 HTTP stats exposes new fields while building and after refresh without running any CLI', async t => {
  const { config } = await logFixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await createApp(config, { conceptAutoDaily: false, registryBuilder: async () => ({ agents }),
    statsFactory: (cfg, list) => createStats(cfg, list, { now: () => now, write: async (file, data) => { await gate; await put(file, data); } }),
  });
  t.after(async () => { release(); await app.close(); }); await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const first = await (await fetch(base + '/api/stats')).json();
  assert.equal(first.building, true); assert.deepEqual(first.windows, [7,30]); assert.equal(first.daily.length, 30);
  assert.equal(first.windowDays, 7); assert.equal(typeof first.last30dLimited, 'boolean');
  assert.equal((await fetch(base + '/api/stats/refresh', { method: 'POST' })).status, 403);
  release(); await app.stats.refresh();
  const complete = await (await fetch(base + '/api/stats')).json();
  assert.equal(complete.building, false); assert.equal(complete.perAgent.walvo.last30d.calls, 1); assert.equal(complete.perAgent.walvo.launches.last30d, 1);
  assert.deepEqual(complete.daily.at(-1), point('2026-10-08', 1, 0, 1, 0, 1));
  assert.equal((await (await fetch(base + '/api/health')).json()).version, '0.53.11');
});
