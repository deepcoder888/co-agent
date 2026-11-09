import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './fsutil.mjs';

// v0.29 常用 Agent (2026-10-19): agent ids in the order the user pinned them, stored in the data dir.
export const maxPins = 50;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\x00-\x1f]/.test(id);
export const validPins = ids => Array.isArray(ids) && ids.length <= maxPins && ids.every(validId) && new Set(ids).size === ids.length;

export async function readPins(dataDir, log = async () => {}) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, 'pins.json'), 'utf8'));
    if (value?.version !== 1 || !validPins(value.ids)) throw new Error('格式无效');
    return value.ids;
  } catch (error) {
    if (error.code !== 'ENOENT') await log(`常用 Agent 读取回退：${error.code || error.message}，使用空列表`);
    return [];
  }
}

export async function writePins(dataDir, ids) {
  if (!validPins(ids)) throw Object.assign(new Error('常用 Agent 列表无效'), { status: 400 });
  await atomicWrite(path.join(dataDir, 'pins.json'), JSON.stringify({ version: 1, ids }, null, 2) + '\n');
  return ids;
}
