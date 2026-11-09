import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileExists } from './registry/sources.mjs';

// Resolves when Explorer has spawned, not when the reader has opened the file.
// Tests inject either this spawn implementation or the entire opener below.
const launch = (spawnImpl, exe, args, options = {}) => new Promise((resolve, reject) => {
  // explorer.exe, Code.exe and notepad.exe are GUI-subsystem programs, so no console can appear. windowsHide must stay
  // false here: SW_HIDE is passed on to the opened app's first window (Claude acceptance 2026-10-08 found the folder
  // and VS Code windows opened invisibly). The console helper reg.exe below keeps windowsHide: true.
  const child = spawnImpl(exe, args, { shell: false, windowsHide: false, detached: true, stdio: 'ignore', ...options });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolve(); });
});
// True when the user picked a default app for the extension. Without a UserChoice, Windows 11 shows
// the "Select an app" chooser even if handlers are registered (e.g. .toml on the user's machine).
export function createUserChoiceCheck({ spawnImpl = spawn } = {}) {
  return extension => new Promise(resolve => {
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`;
    const child = spawnImpl('reg.exe', ['query', key, '/v', 'ProgId'], { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}
const vscodeCandidates = env => [
  path.win32.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
];

export function createOpener({ spawnImpl = spawn, hasUserChoice = createUserChoiceCheck({ spawnImpl }), exists: present = fileExists, env = process.env } = {}) {
  return async (file, { reveal = false, exists = true, target = 'book' } = {}) => {
    if (reveal) {
      // Explorer does not parse a Node-quoted "/select,<path with spaces>" argument, so pass it verbatim.
      // Windows paths cannot contain double quotes, so quoting the path here is unambiguous.
      const argument = exists ? `/select,"${file}"` : `"${path.win32.dirname(file)}"`;
      return launch(spawnImpl, 'explorer.exe', [argument], { windowsVerbatimArguments: true });
    }
    if (target === 'definition' && !(await hasUserChoice(path.win32.extname(file).toLowerCase()))) {
      // D31: definition files open in the default app; with no default chosen, prefer VS Code, then Notepad.
      for (const exe of vscodeCandidates(env)) if (await present(exe)) return launch(spawnImpl, exe, [file]);
      return launch(spawnImpl, 'notepad.exe', [file], { detached: false });
    }
    return launch(spawnImpl, 'explorer.exe', [file]);
  };
}

const defaultOpener = createOpener();
const allowedKeys = new Set(['agentId', 'target', 'index', 'reveal']);
async function folderExists(file) {
  try { return (await fs.stat(path.win32.dirname(file))).isDirectory(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

export async function openAgent(body, agents, { opener = defaultOpener, log } = {}) {
  const audit = { agentId: null, target: null, index: null, result: 'invalid' };
  const invalid = { status: 400, body: { error: 'agentId、target、index 或 reveal 无效' } };
  try {
    // Reject unknown fields, including client paths, instead of silently ignoring
    // them. Only canonical registry values are ever passed to Explorer or logs.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowedKeys.has(key)) ||
      typeof body.agentId !== 'string' || !['book', 'definition'].includes(body.target) ||
      (Object.hasOwn(body, 'reveal') && typeof body.reveal !== 'boolean')) return invalid;
    const agent = agents.find(agent => agent.id === body.agentId);
    if (!agent) return invalid;
    audit.agentId = agent.id; audit.target = body.target;
    let entry;
    if (body.target === 'book') {
      const index = Object.hasOwn(body, 'index') ? body.index : 0;
      if (agent.kind !== 'book' || !Number.isSafeInteger(index) || index < 0 || !agent.bookFiles?.[index]) return invalid;
      entry = agent.bookFiles[index]; audit.index = index;
    } else {
      if (agent.kind !== 'role' || Object.hasOwn(body, 'index') || !agent.definitionFile) return invalid;
      entry = agent.definitionFile;
    }
    const exists = await fileExists(entry.path), reveal = body.reveal === true;
    if (!exists) {
      const parentExists = await folderExists(entry.path);
      if (!reveal || !parentExists) {
        audit.result = 'not-found';
        return { status: 404, body: { error: '原书文件不存在', path: entry.path, folderExists: parentExists } };
      }
    }
    await opener(entry.path, { reveal, exists, target: body.target });
    audit.result = reveal ? 'revealed' : 'opened';
    return { status: 200, body: { ok: true } };
  } catch {
    audit.result = 'failed';
    return { status: 500, body: { error: '打开失败' } };
  } finally {
    await log?.(`打开：${JSON.stringify(audit)}`);
  }
}
