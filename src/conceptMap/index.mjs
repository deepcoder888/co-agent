import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { processAlive } from '../launch/verify.mjs';
import { runMapProcess, validateMap, nonempty, mergeShape, relationShape, splitShape, relationTypes, relationId, relationHidden, effectiveMerges } from './runner.mjs';

export const normalize = term => typeof term === 'string' ? term.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase() : '';
const clip = (text, n) => Array.from(typeof text === 'string' ? text : '').slice(0, n).join('');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const emptyMap = () => ({ version: 1, organizedAt: null, organizedKeys: [], merges: [], relations: [], splits: [],
  manual: { unmerged: [], hiddenRelations: [], hiddenConcepts: [] }, lastRun: null });

export function deriveConcepts(concepts, seminars) {
  const nodes = new Map();
  function add(labels, oneLine, agent, record, sourceType, excerpt) {
    const key = normalize(labels.zh); if (!key || !agent?.id) return;
    if (!nodes.has(key)) nodes.set(key, { key, label: labels.zh, labels: { zh: labels.zh, en: labels.en || '', fr: labels.fr || '' }, aliases: [], oneLine: clip(oneLine, 120), mentions: [] });
    const node = nodes.get(key);
    for (const lang of ['zh', 'en', 'fr']) { if (!node.labels[lang] && labels[lang]) node.labels[lang] = labels[lang]; if (labels[lang] && !node.aliases.includes(labels[lang])) node.aliases.push(labels[lang]); }
    node.mentions.push({ agentId: agent.id, name: agent.name || agent.id, bookLabel: agent.bookLabel || null, sourceType,
      sourceId: record.conceptId || record.seminarId, date: record.day || record.createdAt, excerpt: clip(excerpt, 200) });
  }
  for (const r of concepts) {
    if (r.status !== 'done' || !r.result) continue;
    const v = r.result, labels = { zh: v.term?.zh || v.concept, en: v.term?.en || v.conceptEn, fr: v.term?.fr };
    add(labels, v.oneLine, r.agent, r, 'concept', v.oneLine);
    for (const p of r.perspectives || []) if (p.status === 'done') for (const result of p.results || []) {
      const agent = p.agents?.find(a => a.id === result.agentId || a.codexName === result.agent);
      add(labels, v.oneLine, agent ? { ...agent, name: result.name || agent.name } : { id: result.agentId, name: result.name }, r, 'perspective', result.analysis);
    }
  }
  for (const r of seminars) if (r.status === 'done' && r.result) {
    const v = r.result;
    for (const term of v.terms || []) for (const participant of v.perAgent || []) if (participant.coverage && participant.coverage !== '无') {
      const selected = v.selected?.find(a => a.id === participant.id || a.agent === participant.agent);
      add(term, v.commonAnswer?.summary, { ...selected, ...participant }, r, 'seminar', v.commonAnswer?.summary);
    }
  }
  return [...nodes.values()].map(n => ({ ...n, agentIds: [...new Set(n.mentions.map(m => m.agentId))] }));
}

export function buildGraph(raw, state) {
  const all = new Map(raw.map(n => [n.key, n])), hidden = new Set(state.manual.hiddenConcepts);
  const visible = new Map(raw.filter(n => !hidden.has(n.key)).map(n => [n.key, structuredClone(n)])), owner = new Map();
  const merges = effectiveMerges(state.merges, visible, state.manual);
  for (const m of merges) for (const k of m.members) owner.set(k, m.canonical);
  const canonical = k => owner.get(k) || k, organized = new Set(state.organizedKeys), nodes = new Map();
  for (const n of visible.values()) {
    const key = canonical(n.key);
    if (!nodes.has(key)) { const base = visible.get(key), merge = merges.find(m => m.canonical === key);
      nodes.set(key, { key, label: merge?.label || base.label, labels: base.labels, aliases: [], members: [], mentions: [] }); }
    const node = nodes.get(key); node.members.push(n.key); node.mentions.push(...n.mentions); node.aliases.push(...n.aliases);
  }
  for (const n of nodes.values()) {
    n.mentionCount = n.mentions.length;
    n.books = [...new Map(n.mentions.filter(m => m.bookLabel).map(m => [m.agentId, { agentId: m.agentId, name: m.name, bookLabel: m.bookLabel }])).values()];
    n.bookCount = n.books.length; n.organized = n.members.every(k => organized.has(k));
  }
  const seen = new Set(), relations = [];
  for (const r of state.relations) {
    if (!visible.has(r.a) || !visible.has(r.b) || relationHidden(r, state.manual, canonical)) continue;
    const a = canonical(r.a), b = canonical(r.b), id = relationId({ ...r, a, b }); if (a === b || seen.has(id)) continue;
    const refs = new Set([...nodes.get(a).mentions, ...nodes.get(b).mentions].map(m => m.agentId));
    const basis = r.basis.filter(id => refs.has(id)); if (!basis.length) continue;
    seen.add(id); relations.push({ ...r, a, b, basis });
  }
  return { nodes, owner, concepts: [...nodes.values()].map(({ mentions, books, ...n }) => n).sort((a, b) => b.bookCount - a.bookCount || a.key.localeCompare(b.key)), merges, relations,
    newCount: [...visible.keys()].filter(k => !organized.has(k)).length,
    hiddenConcepts: state.manual.hiddenConcepts.map(key => ({ key, label: all.get(key)?.label || key })),
    splits: (state.splits || []).filter(s => visible.has(s.key)) };
}

export function selectInput(raw, state, limit = 300) {
  const organized = new Set(state.organizedKeys), hidden = new Set(state.manual.hiddenConcepts);
  const all = raw.filter(n => !hidden.has(n.key)).sort((a, b) => a.key.localeCompare(b.key));
  const fresh = all.filter(n => !organized.has(n.key)), freshKeys = new Set(fresh.map(n => n.key)), agentIds = new Set(fresh.flatMap(n => n.agentIds));
  const related = new Set(state.relations.flatMap(r => freshKeys.has(r.a) ? [r.b] : freshKeys.has(r.b) ? [r.a] : []));
  const score = n => (related.has(n.key) ? 1000 : 0) + n.agentIds.filter(id => agentIds.has(id)).length;
  const context = all.filter(n => organized.has(n.key)).sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key));
  const selected = [...fresh, ...context].slice(0, limit);
  const brief = n => ({ key: n.key, label: n.label, labels: n.labels, oneLine: clip(n.oneLine, 120), agentIds: n.agentIds });
  return { concepts: selected.map(brief), allConcepts: raw.map(brief), newKeys: selected.filter(n => freshKeys.has(n.key)).map(n => n.key),
    merges: structuredClone(state.merges), relations: structuredClone(state.relations), manual: structuredClone(state.manual), total: all.length, truncated: Math.max(0, all.length - selected.length) };
}

const pair = p => p && nonempty(p.canonical) && nonempty(p.member) && p.canonical !== p.member;
const edge = r => r && nonempty(r.a) && nonempty(r.b) && r.a !== r.b && relationTypes.includes(r.type);
const nullableText = v => v === null || nonempty(v);
function validRun(r) {
  return r === null || (nonempty(r?.runId) && ['running', 'done', 'failed'].includes(r.status) && nonempty(r.startedAt)
    && nullableText(r.finishedAt) && nullableText(r.error)
    && (r.pid === undefined || r.pid === null || (Number.isSafeInteger(r.pid) && r.pid > 0))
    && (r.dropped === undefined || (Array.isArray(r.dropped) && r.dropped.length <= 20 && r.dropped.every(nonempty)))
    && ['droppedCount', 'inputCount', 'total', 'truncated'].every(k => r[k] === undefined || (Number.isSafeInteger(r[k]) && r[k] >= 0)));
}
function validState(s) {
  return s?.version === 1 && (s.organizedAt === null || nonempty(s.organizedAt)) && Array.isArray(s.organizedKeys) && s.organizedKeys.every(nonempty)
    && Array.isArray(s.merges) && s.merges.every(m => mergeShape(m) && m.members.includes(m.canonical) && new Set(m.members).size === m.members.length)
    && new Set(s.merges.flatMap(m => m.members)).size === s.merges.flatMap(m => m.members).length
    && Array.isArray(s.relations) && s.relations.every(relationShape) && Array.isArray(s.manual?.unmerged) && s.manual.unmerged.every(pair)
    && Array.isArray(s.manual.hiddenRelations) && s.manual.hiddenRelations.every(edge) && Array.isArray(s.manual.hiddenConcepts) && s.manual.hiddenConcepts.every(nonempty)
    && (s.splits === undefined || (Array.isArray(s.splits) && s.splits.every(splitShape)))
    && validRun(s.lastRun);
}

export function createConceptMap(config, { getConcepts, getSeminars, now = () => new Date(), runner = runMapProcess, spawnImpl, killTree, write = atomicWrite, isAlive = processAlive }) {
  const file = path.join(config.dataDir, 'concept-map.json');
  let state = emptyMap(), notice = null, serial = Promise.resolve(), work = null, controller = null, closed = false;
  const stamp = () => new Date(now()).toISOString();
  const exclusive = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  const save = async next => { await write(file, JSON.stringify(next, null, 2) + '\n'); state = next; };
  const derive = async () => { const [c, s] = await Promise.all([getConcepts(), getSeminars()]); return deriveConcepts(c, s); };
  const running = () => controller || (state.lastRun?.pid && isAlive(state.lastRun.pid)) ? { runId: state.lastRun.runId, startedAt: state.lastRun.startedAt } : null;
  async function execute(record, control) {
    try {
      const value = await runner(record, config, { spawnImpl, killTree, signal: control.signal,
        onSpawn: pid => exclusive(() => save({ ...state, lastRun: { ...state.lastRun, pid } })) });
      await exclusive(async () => {
        if (control.signal.aborted) throw new Error('进程中断');
        const checked = validateMap(value, record.input, state);
        const { dropped, droppedCount, ...graph } = checked;
        await save({ ...state, ...graph, organizedAt: stamp(), organizedKeys: [...new Set([...state.organizedKeys, ...record.input.concepts.map(c => c.key)])],
          lastRun: { ...state.lastRun, status: 'done', pid: null, error: null, finishedAt: stamp(), dropped, droppedCount } });
      });
    } catch (error) {
      await exclusive(() => save({ ...state, lastRun: { ...state.lastRun, status: 'failed', error: error.message, finishedAt: stamp(),
        pid: error.processMayBeAlive ? error.pid : null } }));
    }
  }
  return {
    recover() { return exclusive(async () => {
      let text; try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      let loaded; try { loaded = JSON.parse(text); if (!validState(loaded)) throw new Error('格式无效'); }
      catch { const backup = path.join(config.dataDir, `concept-map.corrupt-${Date.now()}-${randomUUID()}.json`);
        try { await fs.rename(file, backup); } catch (e) { if (e.code !== 'EXDEV') throw e; await fs.copyFile(file, backup, 1); await fs.unlink(file); }
        state = emptyMap(); notice = `概念地图文件损坏，已保留为 ${path.basename(backup)}，从空白开始。`; return; }
      state = loaded;
      if (state.lastRun?.status === 'running') await save({ ...state, lastRun: { ...state.lastRun, status: 'failed', error: '应用重启，整理中断', finishedAt: stamp() } });
    }); },
    list() { return exclusive(async () => {
      const { nodes, owner, ...graph } = buildGraph(await derive(), state);
      return { ...graph, organizedAt: state.organizedAt, running: running(), lastRun: structuredClone(state.lastRun), notice };
    }); },
    get(key) { return exclusive(async () => {
      const graph = buildGraph(await derive(), state), canonical = graph.owner.get(key) || key, n = graph.nodes.get(canonical);
      if (!n) fail(404, '概念不存在');
      return { ...n, merges: graph.merges.filter(m => m.canonical === canonical), splits: graph.splits.filter(s => n.members.includes(s.key)),
        relations: graph.relations.filter(r => r.a === canonical || r.b === canonical).map(r => { const otherKey = r.a === canonical ? r.b : r.a;
          return { ...r, otherKey, otherLabel: graph.nodes.get(otherKey).label }; }) };
    }); },
    organize() { return exclusive(async () => {
      if (closed || running()) fail(409, '概念地图正在整理或关闭');
      const input = selectInput(await derive(), state); if (!input.concepts.length) fail(409, '暂无可整理的概念');
      const record = { runId: randomUUID(), input };
      await save({ ...state, lastRun: { runId: record.runId, status: 'running', error: null, startedAt: stamp(), finishedAt: null,
        inputCount: input.concepts.length, total: input.total, truncated: input.truncated, dropped: [], droppedCount: 0, pid: null } });
      controller = new AbortController(); const control = controller;
      work = execute(record, control).finally(() => { controller = null; work = null; });
      // A write failure remains observable through idle/close, without an unhandled rejection.
      work.catch(() => {}); return { runId: record.runId };
    }); },
    manual(body) { return exclusive(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) fail(400, '手动覆盖必须包含一个操作');
      const restore = Object.hasOwn(body, 'restore'), op = restore ? body.restore : body;
      if (!op || typeof op !== 'object' || Array.isArray(op) || Object.keys(op).length !== 1) fail(400, '恢复操作无效');
      const [kind] = Object.keys(op), value = op[kind], next = structuredClone(state), manual = next.manual;
      const raw = await derive(), keys = new Set(raw.map(n => n.key));
      if (kind === 'hideConcept' && nonempty(value) && (restore || keys.has(value))) {
        manual.hiddenConcepts = restore ? manual.hiddenConcepts.filter(k => k !== value) : [...new Set([...manual.hiddenConcepts, value])];
      } else if (kind === 'unmerge' && pair(value) && (restore || (keys.has(value.canonical) && keys.has(value.member)))) {
        const id = p => JSON.stringify([p.canonical, p.member].sort());
        manual.unmerged = manual.unmerged.filter(p => id(p) !== id(value)); if (!restore) manual.unmerged.push({ canonical: value.canonical, member: value.member });
      } else if (kind === 'hideRelation' && edge(value) && (restore || (keys.has(value.a) && keys.has(value.b)))) {
        manual.hiddenRelations = manual.hiddenRelations.filter(r => relationId(r) !== relationId(value));
        if (!restore) manual.hiddenRelations.push({ a: value.a, b: value.b, type: value.type });
      } else fail(400, '手动覆盖字段或概念无效');
      await save(next); return { manual: structuredClone(manual) };
    }); },
    async idle() { await serial; if (work) await work; },
    async close() { closed = true; controller?.abort(); await this.idle(); },
  };
}
