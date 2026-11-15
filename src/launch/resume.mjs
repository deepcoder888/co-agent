import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../fsutil.mjs';
import { resolveExecutable, resolveCli, prepareTerminal } from './spec.mjs';
import { spawnTerminal, applyTerminalResult, scrubEnvironment } from './spawner.mjs';
import { processAlive, closedStatus } from './verify.mjs';
import { codexModelArgs, codexProfileArgs } from './codex.mjs';

export function launchMode(record) {
  return record.mode || (record.cli === 'claude' && record.args?.includes('--agent') ? 'agent' : 'relay');
}

export function resumeArgs(record, sessionId, config = {}) {
  if (record.cli === 'codex') {
    // Records keep the profile they were started with; since v0.50 a launch without a profile has none to repeat.
    const at = record.args?.indexOf('--profile') ?? -1;
    const profile = record.codexProfile || (at >= 0 ? record.args[at + 1] : null);
    if (!record.cwd) throw new Error('原记录缺少工作目录');
    return ['resume', sessionId, ...codexProfileArgs(profile), ...codexModelArgs(config), '-C', record.cwd];
  }
  if (record.cli !== 'claude') throw new Error('原记录 CLI 无效');
  if (launchMode(record) === 'agent') return ['--agent', record.agentName, '--resume', sessionId];
  const at = record.args?.indexOf('--append-system-prompt') ?? -1;
  const relay = at >= 0 ? record.args[at + 1] : undefined;
  if (typeof relay !== 'string' || !relay.trim()) throw new Error('原记录缺少转调指令，无法恢复');
  if (record.jointId) {
    if (record.args?.[0] !== '--disallowedTools') throw new Error('原联合记录缺少 deny 列表，无法安全恢复');
    const end = record.args.findIndex((arg, index) => index > 0 && arg.startsWith('--'));
    if (end < 1) throw new Error('原联合记录 deny 列表无效');
    return [...record.args.slice(0, end), '--resume', sessionId, '--append-system-prompt', relay];
  }
  return ['--resume', sessionId, '--append-system-prompt', relay];
}
export async function createResume(original, session, config, { spawnImpl, env = process.env, io } = {}) {
  let baseline;
  try { baseline = await fs.stat(session.file); if (!baseline.isFile()) throw new Error('不是文件'); }
  catch (error) { throw new Error(`会话文件不可用：${error.message}`); }
  const args = resumeArgs(original, session.id, config);
  const { exe, prefix: exeArgs } = await resolveCli(original.cli === 'claude' ? config.claudeExe : config.codexExe, env);
  const pwshExe = await resolveExecutable(config.pwshExe, env);
  if (!(await fs.stat(original.cwd)).isDirectory()) throw new Error('原启动项目目录不可用');
  const launchId = randomUUID(), joint = !!original.jointId, specFile = path.join(config.dataDir, joint ? 'joints' : 'launches', `${launchId}.json`);
  const record = { ...(joint ? { jointId: launchId, whitelist: original.whitelist, input: original.input, source: original.source || 'recommend', recommendId: original.recommendId ?? null } : { launchId }),
    agentId: original.agentId, agentName: original.agentName, mode: joint ? 'joint' : launchMode(original), cli: original.cli,
    sessionId: session.id, sessionFile: session.file, resumeOf: original.jointId || original.launchId,
    resumeBaseline: { size: baseline.size, mtimeMs: baseline.mtimeMs }, codexProfile: original.codexProfile,
    createdAt: new Date().toISOString(), cwd: original.cwd, exe, exeArgs, args, specFile,
    title: `CO-AGENT · ${joint ? '联合调用' : original.terminalAgentName || original.agentName} · ${launchId.slice(0, 4)}`, terminalAgentName: original.terminalAgentName || original.agentName,
    scrubbedEnv: scrubEnvironment(env).scrubbedEnv };
  const terminalConfig = await prepareTerminal(record, { ...config, launchProject: original.cwd, pwshExe }, env);
  const save = () => atomicWrite(specFile, JSON.stringify(record, null, 2) + '\n', io);
  await save();
  try { applyTerminalResult(record, terminalConfig, await spawnTerminal(specFile, terminalConfig, spawnImpl, env)); }
  catch (error) { record.error = error.message; await save(); throw error; }
  await save(); return record;
}
export async function verifyResume(record, config, { now = Date.now(), isAlive = processAlive } = {}) {
  if (record.closedAt) return closedStatus(record);
  const alive = isAlive(record.pid);
  const status = { overall: 'pending', message: '正在核验恢复', process: { state: alive ? 'alive' : 'exited', pid: record.pid },
    cwd: { state: 'pending' }, agent: { state: 'pending' }, waiting: { state: 'pending' } };
  if (!alive) return { ...status, overall: 'failed', message: '恢复失败：进程已退出' };
  try {
    const stat = await fs.stat(record.sessionFile);
    const content = await fs.readFile(record.sessionFile, 'utf8');
    const rows = content.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s.replace(/^\uFEFF/, '')));
    const baselineSize = record.resumeBaseline?.size;
    if (!Number.isSafeInteger(baselineSize) || baselineSize < 0) throw new Error('恢复记录缺少原文件大小');
    if (stat.size < baselineSize) throw new Error('会话文件被截断');
    const freshRows = Buffer.from(content, 'utf8').subarray(baselineSize).toString('utf8').split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s));
    const mismatched = record.cli === 'claude' ? freshRows.some(row => row.sessionId !== undefined && row.sessionId !== record.sessionId) :
      rows[0]?.type !== 'session_meta' || rows[0]?.payload?.id !== record.sessionId;
    if (mismatched) return { ...status, overall: 'failed', message: '恢复失败：会话 ID 改变', agent: { state: 'mismatch' } };
    status.session = { id: record.sessionId, file: record.sessionFile };
    const hasNewLine = freshRows.length > 0;
    // Windows mtime has submillisecond precision; createdAt is rounded to milliseconds.
    // The unchanged baseline must not look like activity just because it rounds later.
    if (hasNewLine || stat.mtimeMs > Math.max(record.resumeBaseline.mtimeMs || 0, Date.parse(record.createdAt))) {
      status.overall = 'resumed'; status.message = '已恢复 · 会话 ID 不变';
      status.cwd = { state: 'ok', observed: record.cwd }; status.agent = { state: 'confirmed' }; status.waiting = { state: 'ok' };
    }
  } catch (error) { status.evidenceError = `${error.code || 'ERROR'}: ${error.message}`; }
  if (status.overall === 'pending' && now - Date.parse(record.createdAt) > config.verifyTimeoutMs) { status.overall = 'unconfirmed'; status.message = '恢复未确认'; }
  return status;
}
