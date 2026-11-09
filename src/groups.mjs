import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './fsutil.mjs';

// v0.14 调用组: a named, saved set of agents (1–8) with a default CLI and reusable preset questions.
// Stored in <dataDir>/groups.json; every mutation is serialized and written atomically.
export const LIMITS = Object.freeze({ groups: 100, members: 8, presets: 30, name: 40, title: 40, text: 8000 });
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const chars = value => Array.from(value).length;

function cleanName(value) {
  if (typeof value !== 'string') fail(400, '调用组名称必须是文字');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || chars(name) > LIMITS.name) fail(400, `调用组名称必须为 1–${LIMITS.name} 字`);
  return name;
}
function cleanCli(value) {
  if (!['claude', 'codex'].includes(value)) fail(400, 'CLI 必须为 claude 或 codex');
  return value;
}
function cleanMembers(value, agents) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.members || value.some(id => typeof id !== 'string')) fail(400, `调用组需要 1–${LIMITS.members} 个 Agent`);
  if (new Set(value).size !== value.length) fail(400, '调用组中的 Agent 不能重复');
  const missing = value.filter(id => !agents.some(a => a.id === id));
  if (missing.length) fail(400, `这些 Agent 不在注册表中：${missing.join('、')}`);
  return [...value];
}
function cleanPreset(value) {
  if (!value || typeof value !== 'object') fail(400, '预设问题无效');
  if (typeof value.text !== 'string' || !value.text.trim() || chars(value.text) > LIMITS.text) fail(400, `预设问题必须为 1–${LIMITS.text} 字`);
  const title = value.title === undefined || value.title === null ? '' : value.title;
  if (typeof title !== 'string' || chars(title.trim()) > LIMITS.title) fail(400, `预设标题最多 ${LIMITS.title} 字`);
  return { text: value.text, title: title.trim() };
}

export function createGroups(config, getRegistry, { now = () => new Date() } = {}) {
  const file = path.join(config.dataDir, 'groups.json');
  let queue = Promise.resolve();
  async function load() {
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, groups: [] }; throw error; }
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.groups)) throw Object.assign(new Error('groups.json 格式无效'), { status: 500 });
    return value;
  }
  // Serialize read-modify-write so concurrent requests never lose an update.
  function mutate(change) {
    const work = queue.then(async () => {
      const data = await load();
      const result = await change(data);
      await atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
      return result;
    });
    queue = work.catch(() => {});
    return work;
  }
  const find = (data, id) => {
    if (!validId(id)) fail(404, '调用组不存在');
    return data.groups.find(g => g.id === id) || fail(404, '调用组不存在');
  };
  const unique = (data, name, except) => {
    if (data.groups.some(g => g.id !== except && g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail(409, `已有同名调用组「${name}」`);
  };
  const stamp = () => now().toISOString();
  return {
    async list() { return { groups: (await load()).groups }; },
    async get(id) { return find(await load(), id); },
    create(body) {
      return mutate(data => {
        if (data.groups.length >= LIMITS.groups) fail(409, `调用组最多 ${LIMITS.groups} 个`);
        const name = cleanName(body?.name); unique(data, name);
        const presets = body?.presets === undefined ? [] : Array.isArray(body.presets) ? body.presets : fail(400, '预设问题列表无效');
        if (presets.length > LIMITS.presets) fail(400, `每个调用组最多 ${LIMITS.presets} 个预设问题`);
        const at = stamp();
        const group = { id: randomUUID(), name, agentIds: cleanMembers(body?.agentIds, getRegistry().agents), cli: cleanCli(body?.cli),
          presets: presets.map(p => ({ id: randomUUID(), ...cleanPreset(p), createdAt: at, updatedAt: at })),
          createdAt: at, updatedAt: at, lastRunAt: null, runCount: 0 };
        data.groups.push(group);
        return group;
      });
    },
    update(id, body) {
      return mutate(data => {
        const group = find(data, id);
        if (body?.name !== undefined) { const name = cleanName(body.name); unique(data, name, id); group.name = name; }
        if (body?.agentIds !== undefined) group.agentIds = cleanMembers(body.agentIds, getRegistry().agents);
        if (body?.cli !== undefined) group.cli = cleanCli(body.cli);
        group.updatedAt = stamp();
        return group;
      });
    },
    remove(id) {
      return mutate(data => { const group = find(data, id); data.groups = data.groups.filter(g => g !== group); return { deleted: id }; });
    },
    addPreset(id, body) {
      return mutate(data => {
        const group = find(data, id);
        if (group.presets.length >= LIMITS.presets) fail(409, `每个调用组最多 ${LIMITS.presets} 个预设问题`);
        const at = stamp(), preset = { id: randomUUID(), ...cleanPreset(body), createdAt: at, updatedAt: at };
        group.presets.push(preset); group.updatedAt = at;
        return preset;
      });
    },
    updatePreset(id, presetId, body) {
      return mutate(data => {
        const group = find(data, id), preset = group.presets.find(p => p.id === presetId) || fail(404, '预设问题不存在');
        Object.assign(preset, cleanPreset({ text: body?.text ?? preset.text, title: body?.title ?? preset.title }), { updatedAt: stamp() });
        group.updatedAt = preset.updatedAt;
        return preset;
      });
    },
    removePreset(id, presetId) {
      return mutate(data => {
        const group = find(data, id);
        if (!group.presets.some(p => p.id === presetId)) fail(404, '预设问题不存在');
        group.presets = group.presets.filter(p => p.id !== presetId); group.updatedAt = stamp();
        return { deleted: presetId };
      });
    },
    // Records a started run; the joint itself is started by the caller (workflows.startJoint).
    markRun(id) {
      return mutate(data => { const group = find(data, id); group.lastRunAt = stamp(); group.runCount = (group.runCount || 0) + 1; return group; });
    },
    idle() { return queue; },
  };
}
