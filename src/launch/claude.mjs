import { requiresTaskFormat } from '../config.mjs';

// v0.53: with a task, the first message is the task itself, still carrying the start-check marker for verification.
export function claudeArgs(name, launchId, config, codexName = name, task) {
  const formatted = requiresTaskFormat(codexName, config);
  const probe = task ? `【CO-AGENT 启动检查 ${launchId}】${task}` : `【CO-AGENT 启动检查 ${launchId}】这不是任务。不要读取文件，也不要调用任何工具。只回复 READY，然后等待我的下一条消息。`;
  if (!formatted && config.claudeLaunchMode === 'agent') {
    const args = ['--agent', name, '--session-id', launchId];
    if (config.readyProbe || task) args.push(probe);
    return args;
  }
  return ['--session-id', launchId, '--append-system-prompt', claudeRelay(name, codexName, config), probe];
}
// The relay system prompt for roles that must be reached through the Agent tool (terminal launches and in-app chats).
export function claudeRelay(name, codexName, config) {
  const formatted = requiresTaskFormat(codexName, config);
  return formatted ? `本会话由 CO-AGENT 启动，绑定 Agent「${codexName}」。对用户之后的每一条消息（启动检查消息除外）：使用 Agent 工具，subagent_type 为 "${name}"。交给它的任务文本必须严格采用以下格式：第一行单独为 OCTOPUS_WORKER=1，四个字段都不得为空——
OCTOPUS_WORKER=1
Intended role: ${codexName}
Task: <用户原话，原样>
Constraints: <只从用户原话中提炼的约束；原话没有约束时写「遵守该 Agent 自身规则」>
Acceptance criteria: <只从用户原话中提炼的验收标准；原话没有时写「按该 Agent 默认验收标准」>
不得替用户编造原话中没有的要求。原样呈现该 Agent 的结果。不要调用其他任何 Agent。` :
    `本会话由 CO-AGENT 启动，绑定 Agent「${name}」。对用户之后的每一条消息：使用 Agent 工具，subagent_type 为 "${name}"，把用户原话作为任务交给它，并原样呈现它的结果。不要调用其他任何 Agent。启动检查消息除外。`;
}
