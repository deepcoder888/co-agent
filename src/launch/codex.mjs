import { requiresTaskFormat } from '../config.mjs';

// v0.50: a profile, model or effort of null means Codex's own default, so its flag is left out entirely.
export const codexProfileArgs = profile => profile ? ['--profile', profile] : [];
export function codexModelArgs(config = {}, { model = config.codexModel, effort = config.codexEffort, quote = false } = {}) {
  return [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${quote ? JSON.stringify(effort) : effort}`] : [])];
}

// v0.53: a launch may carry its first task (制作书籍 Agent). The start-check marker stays in that first message, so the
// session is still verified as this launch; the agent's first reply counts as ready.
export function codexArgs(name, launchId, config, task) {
  const prompt = task ? `【CO-AGENT 启动检查 ${launchId}】本会话绑定自定义 Agent「${name}」。派生 agent_role 为「${name}」的子 Agent，把下面的任务原样交给它，并呈现它的结果；之后我的每个问题也同样交给它。不要派生其他 Agent。\n任务：${task}` :
    requiresTaskFormat(name, config) ? `【CO-AGENT 启动检查 ${launchId}】本会话绑定自定义 Agent「${name}」。对我之后的每个问题：派生 agent_role 为「${name}」的子 Agent，交给它的任务文本必须严格采用以下格式：第一行单独为 OCTOPUS_WORKER=1，四个字段都不得为空——
OCTOPUS_WORKER=1
Intended role: ${name}
Task: <我的原话，原样>
Constraints: <只从我的原话中提炼的约束；没有时写「遵守该 Agent 自身规则」>
Acceptance criteria: <只从我的原话中提炼的验收标准；没有时写「按该 Agent 默认验收标准」>
不得替我编造原话中没有的要求。呈现它的结果。不要派生其他 Agent。现在不要派生任何 Agent，也不要调用工具，只回复 READY ${name}，然后等待。` :
    `【CO-AGENT 启动检查 ${launchId}】本会话绑定自定义 Agent「${name}」。对我之后的每个问题：派生 agent_role 为「${name}」的子 Agent，把我的原话作为任务交给它，并呈现它的结果。不要派生其他 Agent。现在不要派生任何 Agent，也不要调用工具，只回复 READY ${name}，然后等待。`;
  return [...codexProfileArgs(config.codexProfile), ...codexModelArgs(config), '-C', config.launchProject, prompt];
}
