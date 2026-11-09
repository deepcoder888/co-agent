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

export async function resolveExecutable(exe, env = process.env) {
  const hasPath = path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\');
  const extensions = process.platform === 'win32' && !path.extname(exe) ?
    ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
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
      if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(file)) {
        throw Object.assign(new Error('CLI 仅有脚本入口，无法通过 shell:false 安全启动；请配置可执行文件绝对路径'), { unsafeScript: true });
      }
      return file;
    } catch (error) { if (error.unsafeScript) throw error; }
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
  const exe = await resolveExecutable(cli === 'claude' ? config.claudeExe : config.codexExe, env);
  // Resolve pwsh as well; a missing host must fail before writing a launch or substituting a shell.
  const pwshExe = await resolveExecutable(config.pwshExe, env);
  const notice = cli === 'claude' ? await claudeTrustNotice(config) : undefined;
  const launchId = randomUUID(), createdAt = new Date().toISOString();
  const agentName = cli === 'claude' ? agent.platforms.claude.name || agent.name : agent.name;
  const mode = cli === 'claude' && !requiresTaskFormat(agent.name, config) ? config.claudeLaunchMode : 'relay';
  const args = cli === 'claude' ? claudeArgs(agentName, launchId, config, agent.name, task) : codexArgs(agentName, launchId, config, task);
  const { scrubbedEnv } = scrubEnvironment(env);
  const spec = { launchId, sessionId: launchId, agentId: agent.id, cli, agentName, mode, codexProfile: config.codexProfile, rerunOf, ...(task ? { task } : {}),
    cwd: config.launchProject, exe, args, title: `CO-AGENT · ${agent.name} · ${launchId.slice(0, 4)}`, terminalAgentName: agent.name, createdAt, scrubbedEnv,
    specFile: path.join(config.dataDir, 'launches', `${launchId}.json`), notice };
  const terminalConfig = await prepareTerminal(spec, { ...config, pwshExe }, env);
  const specFile = await writeSpec(spec, config, io);
  try { applyTerminalResult(spec, terminalConfig, await spawnTerminal(specFile, terminalConfig, spawnImpl, env)); }
  catch (error) { spec.error = error.message; await writeSpec(spec, config, io); throw error; }
  await writeSpec(spec, config, io);
  return spec;
}
