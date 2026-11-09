// v0.53 制作书籍 Agent: open an a-deepbooker session in Windows Terminal that turns one book file into a book Agent
// with its full Deepbooker reports. The work runs in that interactive session, where the user sees and approves what
// a-deepbooker does; CO-AGENT itself writes nothing. a-deepbooker is published with CO-AGENT.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BOOK_MAKER } from './registry/candidates.mjs';
import { createLaunch } from './launch/spec.mjs';

export { BOOK_MAKER };
export const BOOK_FILE_TYPES = ['.pdf', '.epub', '.mobi', '.azw3'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function findBookMaker(registry) {
  return [...(registry?.agents || []), ...(registry?.outOfScope || [])].find(agent => agent.id === BOOK_MAKER) || null;
}

export function describeBookMaker(registry) {
  const agent = findBookMaker(registry);
  return agent ? { name: agent.name, platforms: ['codex', 'claude'].filter(p => agent.platforms?.[p]?.available) } : null;
}

// The request a-deepbooker receives, in the words its own description uses for this job.
export function bookMakerTask(file, note) {
  return `A-deepbooker，把这本书做成书籍 Agent，并输出完整报告。\n书籍文件：${file}${note ? `\n补充要求：${note}` : ''}`;
}

export async function startBookMaker(body, registry, config, { launch = createLaunch, spawnImpl, env } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求体无效');
  const cli = body.cli ?? 'codex';
  if (!['codex', 'claude'].includes(cli)) fail('引擎必须是 codex 或 claude');
  const file = typeof body.file === 'string' ? body.file.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!file || !path.win32.isAbsolute(file) || /[\u0000-\u001f"<>|?*]/.test(file.slice(2))) fail('请填写书籍文件的完整路径（从盘符开始）');
  if (!BOOK_FILE_TYPES.includes(path.extname(file).toLowerCase())) fail(`书籍文件必须是 ${BOOK_FILE_TYPES.join('、')} 之一`);
  let stat;
  try { stat = await fs.stat(file); } catch { fail(`找不到书籍文件：${file}`); }
  if (!stat.isFile() || !stat.size) fail(`不是有效的书籍文件：${file}`);
  const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (Array.from(note).length > 300) fail('补充要求最多 300 字');
  const maker = findBookMaker(registry);
  if (!maker) fail(`这台电脑上还没有 ${BOOK_MAKER}：先在 Agent 管理里导入它的 Agent 文件`, 409);
  if (!maker.platforms?.[cli]?.available) fail(`这台电脑上没有 ${BOOK_MAKER} 的 ${cli === 'codex' ? 'Codex' : 'Claude'} 版`, 409);
  // a-deepbooker creates the new Agent, its knowledge package and reports: the user confirms that before it starts.
  if (body.writableConfirmed !== true) fail(`${BOOK_MAKER} 会在电脑上新建 Agent 文件、知识包和报告，请先确认`, 409);
  try { return await launch(maker, cli, config, { task: bookMakerTask(file, note), spawnImpl, env }); }
  catch (error) { fail(`启动失败：${error.message}`, 409); }
}
