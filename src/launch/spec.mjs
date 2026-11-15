import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { claudeArgs } from './claude.mjs';
import { codexArgs } from './codex.mjs';
import { spawnTerminal, terminalPreview, terminalEnvironment, applyTerminalResult, scrubEnvironment } from './spawner.mjs';
import { requiresTaskFormat } from '../config.mjs';

const trustNotice = '首次在此目录使用交互式 Claude：请在弹出的窗口中选择「Yes, I trust this folder」并按回车，之后会话才会开始。';
const projectKey = value => value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();

async function claudeTrustNotice(config) {
  try {
    const state = JSON.parse(await fs.readFile(config.claudeStateFile, 'utf8'));
    const projects = state?.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      const entry = Object.entries(projects).find(([key]) => projectKey(key) === projectKey(config.launchProject));
      if (entry?.[1]?.hasTrustDialogAccepted === true) return undefined;
    }
  } catch { /* An unavailable state file requires manual trust, but must not prevent launch. */ }
  return trustNotice;
}

const isScript = file => process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(file);
const unsafeScript = file => Object.assign(new Error(`${path.basename(file)} 是脚本入口，CO-AGENT 不经 shell 无法安全启动它。` +
  '请用 npm 重新安装（npm i -g @openai/codex 或 npm i -g @anthropic-ai/claude-code），或安装带 .exe 的版本，' +
  '或在数据目录的 config.json 里把 codexExe / claudeExe 设为 .exe 的绝对路径'), { unsafeScript: true });
const isFile = file => fs.stat(file).then(stat => stat.isFile(), () => false);

// v0.53: npm installs leave only shims on PATH (codex.cmd, codex.ps1 and an extension-less sh script), and shell:false
// cannot run a .cmd. Read the npm cmd-shim and run what it runs: its .js entry with node.exe (the shim's own node.exe
// first, as the shim does), or the .exe it points to. Any other script stays refused.
async function resolveShim(file, env) {
  if ((await fs.stat(file)).size > 65536) throw unsafeScript(file);
  const text = await fs.readFile(file, 'utf8');
  const viaNode = text.includes('SET "_prog=node"') && text.match(/"%_prog%"\s+"%dp0%\\([^"%]+)"\s+%\*/);
  const direct = text.match(/^@"%dp0%\\([^"%]+)"\s+%\*\s*$/m);
  const target = path.resolve(path.dirname(file), (viaNode || direct)?.[1] ?? '');
  if (viaNode && /\.[cm]?js$/i.test(target) && await isFile(target)) {
    const local = path.join(path.dirname(file), 'node.exe');
    if (await isFile(local)) return { file, exe: local, prefix: [target] };
    try { return { file, exe: await resolveExecutable('node.exe', env), prefix: [target] }; }
    catch { throw Object.assign(new Error(`${path.basename(file)} 由 npm 安装，需要 Node.js，但 PATH 里找不到 node.exe`), { executableMissing: true }); }
  }
  if (direct && /\.exe$/i.test(target) && await isFile(target)) return { file, exe: target, prefix: [] };
  throw unsafeScript(file);
}

// A CLI to start with shell:false: { file: what was found, exe: the program to start, prefix: arguments before the CLI's own }.
export async function resolveCli(exe, env = process.env) {
  const file = await findExecutable(exe, env);
  if (!isScript(file)) return { file, exe: file, prefix: [] };
  if (/\.ps1$/i.test(file)) throw unsafeScript(file);
  return resolveShim(file, env);
}

export async function resolveExecutable(exe, env = process.env) {
  const file = await findExecutable(exe, env);
  if (isScript(file)) throw unsafeScript(file);
  return file;
}

async function findExecutable(exe, env) {
  const hasPath = path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\');
  // Windows runs a bare name only with a PATHEXT extension; an extension-less file there is npm's sh shim, not a program.
  const extensions = process.platform === 'win32' && !path.extname(exe) ?
    (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = hasPath ? extensions.map(ext => path.resolve(`${exe}${ext}`)) :
    (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).flatMap(dir =>
      extensions.map(ext => path.resolve(dir.replace(/^"|"$/g, ''), `${exe}${ext}`)));
  for (const file of candidates) {
    try {
      let stat;
      try { stat = await fs.stat(file); }
      catch (error) {
        // Windows App Execution Aliases (e.g. WindowsApps\wt.exe) are reparse points fs.stat cannot follow (EACCES), yet CreateProcess launches them.
        if (process.platform !== 'win32' || error.code !== 'EACCES' || !/\.exe$/i.test(file)) throw error;
        const link = await fs.lstat(file);
        if (!link.isSymbolicLink() && !link.isFile()) continue;
      }
      if (stat && !stat.isFile()) continue;
      await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return file;
    } catch { /* Try the next candidate. */ }
  }
  throw Object.assign(new Error(`CLI 未安装或无法在 PATH 中解析：${exe}`), { executableMissing: true });
}

export async function prepareTerminal(record, config, env = process.env) {
  record.pidFile = record.specFile.replace(/\.json$/i, '.pid');
  const terminalConfig = { ...config, terminalTitle: record.title, terminalPidFile: record.pidFile };
  terminalEnvironment(record.specFile, terminalConfig); // Reject unsafe values even if wt is absent.
  try { terminalConfig.wtExe = await resolveExecutable(config.wtExe ?? 'wt.exe', env); }
  catch (error) {
    if (!error.executableMissing) throw error;
    terminalConfig.wtExe = ''; record.terminalFallback = 'no-wt';
  }
  record.argvPreview = terminalPreview(record.specFile, terminalConfig);
  return terminalConfig;
}

export async function writeSpec(spec, config, io) {
  if (!/^[0-9a-f-]{36}$/i.test(spec.launchId)) throw new Error('launchId 无效');
  const file = path.join(config.dataDir, 'launches', `${spec.launchId}.json`);
  await atomicWrite(file, JSON.stringify(spec, null, 2) + '\n', io);
  return file;
}

export async function createLaunch(agent, cli, config, { spawnImpl, io, env = process.env, rerunOf, task } = {}) {
  if (!['claude', 'codex'].includes(cli)) throw new Error('CLI 必须是 claude 或 codex');
  if (!agent.platforms[cli]?.available) throw new Error(agent.platforms[cli]?.reason || '所选平台不可用');
  try { if (!(await fs.stat(config.launchProject)).isDirectory()) throw new Error('不是目录'); }
  catch (error) { throw new Error(`启动项目目录不可用：${config.launchProject}（${error.message}）`); }
  const { exe, prefix: exeArgs } = await resolveCli(cli === 'claude' ? config.claudeExe : config.codexExe, env);
  // Resolve pwsh as well; a missing host must fail before writing a launch or substituting a shell.
  const pwshExe = await resolveExecutable(config.pwshExe, env);
  const notice = cli === 'claude' ? await claudeTrustNotice(config) : undefined;
  const launchId = randomUUID(), createdAt = new Date().toISOString();
  const agentName = cli === 'claude' ? agent.platforms.claude.name || agent.name : agent.name;
  const mode = cli === 'claude' && !requiresTaskFormat(agent.name, config) ? config.claudeLaunchMode : 'relay';
  const args = cli === 'claude' ? claudeArgs(agentName, launchId, config, agent.name, task) : codexArgs(agentName, launchId, config, task);
  const { scrubbedEnv } = scrubEnvironment(env);
  const spec = { launchId, sessionId: launchId, agentId: agent.id, cli, agentName, mode, codexProfile: config.codexProfile, rerunOf, ...(task ? { task } : {}),
    cwd: config.launchProject, exe, exeArgs, args, title: `CO-AGENT · ${agent.name} · ${launchId.slice(0, 4)}`, terminalAgentName: agent.name, createdAt, scrubbedEnv,
    specFile: path.join(config.dataDir, 'launches', `${launchId}.json`), notice };
  const terminalConfig = await prepareTerminal(spec, { ...config, pwshExe }, env);
  const specFile = await writeSpec(spec, config, io);
  try { applyTerminalResult(spec, terminalConfig, await spawnTerminal(specFile, terminalConfig, spawnImpl, env)); }
  catch (error) { spec.error = error.message; await writeSpec(spec, config, io); throw error; }
  await writeSpec(spec, config, io);
  return spec;
}
