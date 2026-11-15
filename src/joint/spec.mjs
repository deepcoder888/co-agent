import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFrontmatter } from '../registry/frontmatter.mjs';
import { requiresTaskFormat } from '../config.mjs';
import { atomicWrite } from '../fsutil.mjs';
import { resolveExecutable, resolveCli, prepareTerminal } from '../launch/spec.mjs';
import { scrubEnvironment, spawnTerminal, applyTerminalResult } from '../launch/spawner.mjs';
import { codexModelArgs, codexProfileArgs } from '../launch/codex.mjs';

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function scanPluginAgents(config) {
  const names = new Set();
  // Verified machine layout: cache / marketplace / plugin / version / agents / *.md.
  for (const market of await entries(config.claudePluginsCacheDir)) if (market.isDirectory()) {
    const marketDir = path.join(config.claudePluginsCacheDir, market.name);
    for (const plugin of await entries(marketDir)) if (plugin.isDirectory()) {
      const pluginDir = path.join(marketDir, plugin.name);
      for (const version of await entries(pluginDir)) if (version.isDirectory()) {
        const dir = path.join(pluginDir, version.name, 'agents');
        for (const entry of await entries(dir)) if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) {
          const { name } = parseFrontmatter(await fs.readFile(path.join(dir, entry.name), 'utf8'));
          names.add(`${plugin.name}:${name}`);
        }
      }
    }
  }
  return [...names].sort();
}

export async function scanClaudeTypes(config) {
  const names = new Set(config.builtinClaudeAgents);
  for (const dir of config.claudeAgentDirs) for (const entry of await entries(dir)) {
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) {
      names.add(parseFrontmatter(await fs.readFile(path.join(dir, entry.name), 'utf8')).name);
    }
  }
  for (const name of await scanPluginAgents(config)) names.add(name);
  return [...names].sort();
}

// v0.24 (2026-10-16): structured synthesis, reviewer roles check in a later round, optional cross-examination.
// Templates: docs/plans/v0.24-执行细节书.md (test/v03.test.mjs compares the plain variant word for word).
export function jointPlan(agents) {
  const answer = agents.filter(a => !a.reviewer);
  return answer.length && answer.length < agents.length ? { answer, review: agents.filter(a => a.reviewer) } : { answer: agents, review: [] };
}
const synthesisItems = review => ['- 共识：每条注明由哪些 Agent 支持；若这些 Agent 的依据其实是同一研究或同一来源，标注「同源」，不算独立印证。',
  '- 分歧：列出各方立场、依据和各自适用的条件，不要把分歧抹平成折中结论。',
  '- 独有补充：只有一个 Agent 提出的观点。',
  '- 单一来源结论：只有一本书或一个 Agent 支持的结论单独标出。',
  ...(review ? ['- 核查结果：核查型 Agent 认为有误、过时或证据不足的论点，以及据此作出的修正。'] : []),
  '- 可执行建议：每条注明依据来自哪个 Agent。'].join('\n');
const crossExamTask = '任务：原始问题，加上其他 Agent 首轮的关键论点摘要（按 Agent 列出并保留各自依据）；要求它只依据自身书籍或自身职责，对这些论点逐条回应「同意 / 反对 / 补充」并给出依据，指出与自身来源冲突或证据不足之处。';
const reviewTask = '任务为核查这份清单：事实是否成立、是否已经过时、论证是否有漏洞，并附上原始问题。';
const numbered = rules => rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');

export function jointArgs(cli, joint, agents, config, knownTypes = []) {
  const nameOf = a => cli === 'claude' ? a.platforms.claude.name || a.name : a.name;
  const names = agents.map(nameOf);
  const formatted = agents.filter(a => requiresTaskFormat(a.name, config)).map(nameOf).join(',') || '无';
  const { answer, review } = jointPlan(agents), first = answer.map(nameOf).join(','), checkers = review.map(nameOf).join(',');
  const staged = review.length > 0, crossExam = joint.crossExam === true, rounds = staged || crossExam ? '各轮' : '各自';
  if (cli === 'claude') {
    const instruction = `本会话由 CO-AGENT 发起联合调用。白名单 Agent：${names.join(',')}。规则：\n${numbered([
      staged ? `收到首条消息后，在同一条回复中并行调用首轮 Agent：${first}（一条消息里发出多个 Agent 工具调用），不得逐个顺序调用。核查型 Agent ${checkers} 留到核查轮，首轮不要调用。`
        : '收到首条消息后，在同一条回复中并行调用白名单内的全部 Agent（一条消息里发出多个 Agent 工具调用），不得逐个顺序调用。',
      `首轮每个 Agent 的任务都是用户的原始输入（首条消息去掉第一行标记）。对于 ${formatted} ，任务文本必须严格采用：第一行单独为 OCTOPUS_WORKER=1，然后 Intended role: <其 Codex 名>、Task: <该轮任务；首轮为用户原话>、Constraints: <只从原话提炼，没有则写「遵守该 Agent 自身规则」>、Acceptance criteria: <只从原话提炼，没有则写「按该 Agent 默认验收标准」>。`,
      ...(crossExam ? [`交叉质询（已勾选，必须执行，不得省略或合并到综合里）：首轮全部返回后，在同一条回复中再次并行调用 ${first}，每个调用一次，必须是新的 Agent 调用，不复用首轮结果。${crossExamTask}`] : []),
      ...(staged ? [`核查：${crossExam ? '交叉质询' : '首轮'}全部返回后，把主要论点整理成编号清单（每条注明提出者和依据），在同一条回复中并行调用 ${checkers}，${reviewTask}`] : []),
      '不得调用白名单以外的任何 Agent。',
      `全部返回后，按 Agent 分段原样呈现${rounds}结果，再给出标明「主模型综合」的结构化综合，依次包含：\n${synthesisItems(staged)}`,
      '之后等待用户追问；追问时只可调用白名单内的 Agent。'])}`;
    const denyList = [...new Set(knownTypes)].filter(n => !names.includes(n)).map(n => `Agent(${n})`);
    const args = ['--disallowedTools', ...denyList, '--session-id', joint.jointId, '--append-system-prompt', instruction, `【CO-AGENT 联合调用 ${joint.jointId}】\n${joint.input}`];
    // Include the executable, separators and worst-case Windows argument quoting overhead.
    const length = [config.claudeExe, ...args].reduce((sum, arg) => sum + arg.length + (arg.match(/["\\]/g)?.length || 0) + 3, 0);
    if (length > 30000) throw new Error('Claude 总参数长度超过 30 000 字符，不启动');
    return args;
  }
  if (cli !== 'codex') throw new Error('CLI 必须是 claude 或 codex');
  const instruction = `【CO-AGENT 联合调用 ${joint.jointId}】本会话发起联合调用。白名单 Agent：${names.join(',')}。规则：\n${numbered([
    staged ? `立即为首轮的每一个 Agent：${first} 各派生一个子 Agent（agent_type 为该名称），全部派生完成之前不要等待任何一个，不得逐个顺序处理。核查型 Agent ${checkers} 留到核查轮，首轮不要派生。`
      : '立即为白名单中的每一个 Agent 各派生一个子 Agent（agent_type 为该名称），全部派生完成之前不要等待任何一个，不得逐个顺序处理。',
    `首轮每个子 Agent 的任务都是下面的用户原文。对于 ${formatted} ，任务文本必须严格采用：第一行单独为 OCTOPUS_WORKER=1，然后 Intended role: <其名称>、Task: <该轮任务；首轮为用户原文>、Constraints: <只从原文提炼，没有则写「遵守该 Agent 自身规则」>、Acceptance criteria: <只从原文提炼，没有则写「按该 Agent 默认验收标准」>。`,
    ...(crossExam ? [`交叉质询（已勾选，必须执行，不得省略或合并到综合里）：首轮全部完成后，再为 ${first} 中的每一个各派生一个新的子 Agent（不复用首轮子 Agent），全部派生完成之前不要等待任何一个。${crossExamTask}`] : []),
    ...(staged ? [`核查：${crossExam ? '交叉质询' : '首轮'}全部完成后，把主要论点整理成编号清单（每条注明提出者和依据），为 ${checkers} 各派生一个子 Agent，${reviewTask}`] : []),
    '不得派生白名单以外的任何 Agent。',
    `全部完成后，按 Agent 分段呈现${rounds}结果，再给出标明「主模型综合」的结构化综合，依次包含：\n${synthesisItems(staged)}`,
    '之后等待我的追问；追问时只可使用白名单内的 Agent。'])}
用户原文：
${joint.input}`;
  return [...codexProfileArgs(config.codexProfile), ...codexModelArgs(config), '-C', config.launchProject, instruction];
}

export async function createJoint({ input, cli, agents, recommendId = null, source = 'recommend', rerunOf, group = null, crossExam = false }, config, { spawnImpl, env = process.env } = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8000) throw new Error('输入必须为 1–8000 字');
  if (!agents.length || !['claude', 'codex'].includes(cli)) throw new Error('联合调用参数无效');
  if (agents.some(a => !a.platforms[cli]?.available)) throw new Error('所选平台不可用');
  if (!(await fs.stat(config.launchProject)).isDirectory()) throw new Error('启动项目目录不可用');
  const { exe, prefix: exeArgs } = await resolveCli(cli === 'claude' ? config.claudeExe : config.codexExe, env);
  const pwshExe = await resolveExecutable(config.pwshExe, env);
  const jointId = randomUUID();
  const staged = new Set(jointPlan(agents).review);
  const joint = { jointId, sessionId: jointId, recommendId, source, rerunOf, group, mode: 'joint', codexProfile: config.codexProfile, cli, input, cwd: config.launchProject, exe, exeArgs, createdAt: new Date().toISOString(),
    crossExam: crossExam === true,
    whitelist: agents.map(a => ({ id: a.id, codexName: a.name, claudeName: a.platforms.claude.name || a.name, ...(staged.has(a) ? { stage: 'review' } : {}) })),
    title: `CO-AGENT · 联合调用 · ${jointId.slice(0, 4)}`, scrubbedEnv: scrubEnvironment(env).scrubbedEnv };
  joint.args = jointArgs(cli, joint, agents, { ...config, claudeExe: [exe, ...exeArgs].join(' ') }, cli === 'claude' ? await scanClaudeTypes(config) : []);
  const specFile = path.join(config.dataDir, 'joints', `${jointId}.json`);
  joint.specFile = specFile;
  const terminalConfig = await prepareTerminal(joint, { ...config, pwshExe }, env);
  await atomicWrite(specFile, JSON.stringify(joint, null, 2) + '\n');
  try {
    applyTerminalResult(joint, terminalConfig, await spawnTerminal(specFile, terminalConfig, spawnImpl, env));
  } catch (error) {
    joint.error = error.message;
    await atomicWrite(specFile, JSON.stringify(joint, null, 2) + '\n');
    throw error;
  }
  await atomicWrite(specFile, JSON.stringify(joint, null, 2) + '\n');
  return joint;
}
