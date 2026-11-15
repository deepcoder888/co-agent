import fs from 'node:fs/promises';
import path from 'node:path';
import { normalize } from '../registry/identity.mjs';
import { atomicWrite } from '../fsutil.mjs';
import { parseClaude } from './claude.mjs';
import { parseCodex } from './codex.mjs';
import { parseHub } from './hub.mjs';

const DAY = 24 * 60 * 60 * 1000, WEEK = 7 * DAY, MONTH = 30 * DAY;
const localDay = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });
const bucket = () => ({ calls: 0, ok: 0, failed: 0, unknown: 0, bySource: { claude: 0, codex: 0 } });
const explanation = '仅解析 session_meta 首行与末尾最多 256 KB；中段坏行不可见；未知状态不代表成功或失败。';
const missingText = id => id === 'claude' ? '还没有 Claude 会话记录（这台电脑上还没用过 Claude CLI）'
  : id === 'codex-archive' ? '还没有 Codex 归档会话记录' : '还没有 Codex 会话记录（这台电脑上还没用过 Codex CLI）';
const errorText = error => error.code && !error.message.startsWith(`${error.code}:`) ? `${error.code}: ${error.message}` : error.message;

export function aggregate(events, agents, sources, now = Date.now()) {
  const perAgent = Object.fromEntries(agents.map(a => [a.id, { last7d: bucket(), last30d: bucket(), total: bucket(), launches: { last7d: 0, last30d: 0, total: 0 }, lastAt: null }]));
  const kinds = new Map(agents.map(a => [a.id, a.kind]));
  // The chart covers today and the preceding 29 calendar dates in this computer's time zone.
  // UTC is used only for label arithmetic; rolling windows remain elapsed time.
  const today = Date.parse(`${localDay.format(now)}T00:00:00Z`);
  const daily = Array.from({ length: 30 }, (_, i) => ({ day: new Date(today - (29 - i) * DAY).toISOString().slice(0, 10), calls: 0, role: 0, book: 0, claude: 0, codex: 0 }));
  const dailyByDay = new Map(daily.map(item => [item.day, item]));
  const limitedReasons = [], last7dLimitedReasons = [], last30dLimitedReasons = [];
  for (const source of sources) {
    if (!source.available) {
      const reason = source.missing ? source.notes[0] : `${source.id} 来源不可读：${source.path}（${source.notes?.join('；') || '目录不可用'}）`;
      limitedReasons.push(reason); last7dLimitedReasons.push(reason); last30dLimitedReasons.push(reason);
    }
    if (source.failedFiles?.length) {
      const reason = `${source.id} 有 ${source.failedFiles.length} 个文件解析失败`;
      limitedReasons.push(reason);
      if (source.failedFiles.some(f => !Number.isFinite(f.mtimeMs) || (f.mtimeMs >= now - WEEK && f.mtimeMs <= now))) last7dLimitedReasons.push(reason);
      if (source.failedFiles.some(f => !Number.isFinite(f.mtimeMs) || (f.mtimeMs >= now - MONTH && f.mtimeMs <= now))) last30dLimitedReasons.push(reason);
    }
  }
  const claudeAt = sources.find(s => s.id === 'claude')?.earliestAt;
  const codexAt = sources.filter(s => s.id.startsWith('codex-') && s.earliestAt).map(s => s.earliestAt).sort()[0];
  if (claudeAt && codexAt && Date.parse(claudeAt) > Date.parse(codexAt)) limitedReasons.push(`Claude 会话记录最早只到 ${formatLocal(claudeAt).slice(0, 10)}，此前的 Claude 调用无法统计`);
  let outOfScopeEvents = 0, unlabeledSubagents = 0;
  for (const event of events) {
    if (event.kind === 'unlabeled') { unlabeledSubagents++; continue; }
    const id = typeof event.agentName === 'string' ? normalize(event.agentName) : '';
    const agent = Object.hasOwn(perAgent, id) ? perAgent[id] : null;
    if (!agent) { outOfScopeEvents++; continue; }
    const timestamp = Date.parse(event.at), recent = timestamp >= now - WEEK && timestamp <= now;
    const recent30 = timestamp >= now - MONTH && timestamp <= now;
    if (event.kind === 'launch') { agent.launches.total++; if (recent) agent.launches.last7d++; if (recent30) agent.launches.last30d++; continue; }
    for (const [key, include] of [['total', true], ['last7d', recent], ['last30d', recent30]]) {
      if (!include) continue;
      agent[key].calls++; agent[key][['ok', 'failed'].includes(event.status) ? event.status : 'unknown']++;
      if (event.source === 'claude' || event.source === 'codex') agent[key].bySource[event.source]++;
    }
    if (Number.isFinite(timestamp) && timestamp <= now) {
      const day = dailyByDay.get(localDay.format(timestamp));
      if (day) {
        day.calls++;
        const kind = kinds.get(id);
        if (kind === 'role' || kind === 'book') day[kind]++;
        if (event.source === 'claude' || event.source === 'codex') day[event.source]++;
      }
    }
    if (!agent.lastAt || timestamp > Date.parse(agent.lastAt)) agent.lastAt = event.at;
  }
  return { generatedAt: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, windowDays: 7, windows: [7, 30], daily,
    limited: limitedReasons.length > 0, limitedReasons, last7dLimited: last7dLimitedReasons.length > 0, last7dLimitedReasons,
    last30dLimited: last30dLimitedReasons.length > 0, last30dLimitedReasons,
    sources, perAgent, outOfScopeEvents, unlabeledSubagents, building: false };
}

export function formatLocal(at) {
  if (!at || !Number.isFinite(Date.parse(at))) return '暂无数据';
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at));
}

async function collect(source, recursive, match) {
  const files = [], unreadable = [];
  async function walk(dir, root = false) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (root && source.id === 'hub' && error.code === 'ENOENT') return;
      // v0.53: a session folder that does not exist yet only means that CLI has not been used here; say so plainly.
      if (root && error.code === 'ENOENT') { source.available = false; source.missing = true; source.notes.push(missingText(source.id)); }
      else if (root) { source.available = false; source.notes.push(errorText(error)); }
      else source.failedFiles.push({ file: dir, reason: errorText(error) });
      if (error.code !== 'ENOENT') unreadable.push(dir);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) await walk(file);
      else if (entry.isFile() && match(entry.name)) files.push(file);
    }
  }
  await walk(source.path, true); return { files, unreadable };
}

const within = (file, dir) => {
  const relative = path.relative(dir, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function validCache(value) {
  if (value?.version !== 1 || value.parserRevision !== 2 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return false;
  return Object.values(value.files).every(f => f && Number.isFinite(f.size) && Number.isFinite(f.mtimeMs) &&
    Number.isInteger(f.badLines) && f.badLines >= 0 && Array.isArray(f.events) && f.events.every(e => e && typeof e.key === 'string' &&
      ['call', 'session', 'launch', 'unlabeled'].includes(e.kind) && ['claude', 'codex', 'hub'].includes(e.source) && Number.isFinite(Date.parse(e.at))));
}

export function createStats(config, agents, { now = () => Date.now(), onParse = () => {}, parsers = {}, write = atomicWrite } = {}) {
  const parse = { claude: parseClaude, codex: parseCodex, hub: parseHub, ...parsers };
  const cacheFile = path.join(config.dataDir, 'stats-index.json');
  let cache, savedJson, running, building = false, dirty = false;
  let result = aggregate([], agents, [], now());
  const decorate = value => ({ ...value, explanations: [explanation], dataDirMigration: config.dataDirMigration || null });
  async function build() {
    if (!cache) {
      try {
        const json = await fs.readFile(cacheFile, 'utf8'), stored = JSON.parse(json);
        if (validCache(stored)) { cache = stored; savedJson = json; }
        else cache = { version: 1, parserRevision: 2, files: {} };
      }
      catch { cache = { version: 1, parserRevision: 2, files: {} }; }
    }
    const definitions = [{ id: 'claude', type: 'claude', path: config.claudeProjectsDir },
      { id: 'codex-live', type: 'codex', path: config.codexSessionsDir },
      ...(config.codexArchiveDirs || []).map((dir, i) => ({ id: 'codex-archive', type: 'codex', path: dir, archiveIndex: i })),
      { id: 'hub', type: 'hub', path: path.join(config.dataDir, 'launches') }];
    const next = { version: 1, parserRevision: 2, files: {} }, sources = [], dedup = new Map();
    for (const definition of definitions) {
      const source = { id: definition.id, path: path.resolve(definition.path), available: true, files: 0, parsedFiles: 0, retainedFiles: 0,
        failedFiles: [], badLines: 0, earliestAt: null, latestAt: null, notes: [] };
      sources.push(source);
      const { files, unreadable } = await collect(source, definition.type !== 'hub', name => definition.type === 'codex' ? /^rollout-.*\.jsonl$/.test(name) : definition.type === 'hub' ? name.endsWith('.json') && !name.endsWith('.status.json') : name.endsWith('.jsonl'));
      source.files = files.length;
      function include(file, entry) {
        next.files[file] = entry;
        if (entry.retained) source.retainedFiles++; else source.parsedFiles++;
        source.badLines += entry.badLines;
        if (definition.type !== 'hub') {
          const firstTime = Date.parse(entry.firstTimestampAt);
          const coverageAt = new Date(Number.isFinite(firstTime) ? Math.min(entry.mtimeMs, firstTime) : entry.mtimeMs).toISOString();
          if (!source.earliestAt || Date.parse(coverageAt) < Date.parse(source.earliestAt)) source.earliestAt = coverageAt;
        }
        for (const event of entry.events) {
          if (definition.type === 'hub' && (!source.earliestAt || Date.parse(event.at) < Date.parse(source.earliestAt))) source.earliestAt = event.at;
          if (!source.latestAt || Date.parse(event.at) > Date.parse(source.latestAt)) source.latestAt = event.at;
          const prior = dedup.get(event.key);
          if (!prior || (event.source === 'claude' && prior.status === 'unknown' && event.status !== 'unknown')) dedup.set(event.key, event);
        }
      }
      for (const file of files) {
        let stat;
        try {
          stat = await fs.stat(file);
          if (definition.type !== 'hub') {
            const fileAt = new Date(stat.mtimeMs).toISOString();
            if (!source.earliestAt || Date.parse(fileAt) < Date.parse(source.earliestAt)) source.earliestAt = fileAt;
          }
          let entry = cache.files[file];
          if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
            onParse({ file, source: source.id });
            const parsed = await parse[definition.type](file);
            entry = { size: stat.size, mtimeMs: stat.mtimeMs, events: parsed.events, badLines: parsed.badLines,
              firstTimestampAt: parsed.firstTimestampAt || null };
          }
          if (entry.retained) { entry = { ...entry }; delete entry.retained; }
          include(file, entry);
        } catch (error) {
          if (error.code === 'ENOENT') {
            source.files--;
            if (cache.files[file]) include(file, { ...cache.files[file], retained: true });
          } else {
            source.failedFiles.push({ file, reason: errorText(error), mtimeMs: stat?.mtimeMs });
          }
        }
      }
      const found = new Set(files);
      for (const [file, entry] of Object.entries(cache.files)) {
        if (!found.has(file) && within(file, source.path) && !unreadable.some(dir => within(file, dir))) {
          include(file, { ...entry, retained: true });
        }
      }
    }
    const updated = aggregate([...dedup.values()], agents, sources, now());
    // Publish valid observations even if persistence fails; never hide the write failure.
    result = updated; cache = next;
    try {
      const json = JSON.stringify(next) + '\n';
      if (json !== savedJson) { await write(cacheFile, json); savedJson = json; }
    }
    catch (error) {
      const reason = `统计索引写入失败：${errorText(error)}`;
      result.limited = true; result.limitedReasons.push(reason); result.indexError = reason;
      throw error;
    }
    return result;
  }
  return {
    snapshot() { return decorate({ ...result, building }); },
    setAgents(value) { agents = value; },
    refresh() {
      if (running) { dirty = true; return running; }
      building = true;
      running = (async () => {
        do {
          dirty = false;
          // A queued refresh still runs if persistence of the preceding build fails.
          try { await build(); }
          catch (error) { if (!dirty) throw error; }
        } while (dirty);
        return result;
      })().finally(() => { building = false; running = null; });
      return running;
    },
  };
}
