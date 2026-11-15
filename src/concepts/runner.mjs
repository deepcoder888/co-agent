import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite } from '../fsutil.mjs';
import { resolveCli } from '../launch/spec.mjs';
import { scrubEnvironment } from '../launch/spawner.mjs';
import { codexModelArgs, codexProfileArgs } from '../launch/codex.mjs';
import { responseBody } from '../../public/display.js';

export const termSchema = { type: 'object', additionalProperties: false, required: ['zh','en','fr'], properties: {
  zh: { type: 'string', minLength: 1, maxLength: 8, pattern: '^[^:：\\s]+$' }, en: { type: 'string', minLength: 1 }, fr: { type: 'string', minLength: 1 },
} };
export const conceptSchema = { type: 'object', additionalProperties: false,
  required: ['concept', 'conceptEn', 'oneLine', 'whyUnknown', 'sourceRefs', 'markdown', 'term', 'response'], properties: {
    concept: { type: 'string' }, conceptEn: { type: ['string', 'null'] }, oneLine: { type: 'string' }, whyUnknown: { type: 'string' },
    sourceRefs: { type: 'array', items: { type: 'string' } }, markdown: { type: 'string' }, term: termSchema,
    response: { type: 'object', additionalProperties: false, required: ['stance', 'text'], properties: {
      stance: { type: 'string', enum: ['赞同', '反驳', '补充', '无'] }, text: { type: 'string' },
    } },
  } };
export const perspectiveSchema = { type: 'object', additionalProperties: false, required: ['results'], properties: {
  results: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['agent', 'analysis'], properties: { agent: { type: 'string' }, analysis: { type: 'string' } } } },
} };
export const termRule = 'zh 必须是 concept 中连续的一段（1–8 个汉字），能单独代表这个概念，不能是「概念」「创造」这类泛词；concept 本身不超过 8 个汉字时，zh 就是 concept。例：「会话目标罗盘」（6 字）→「会话目标罗盘」；「内外嵌套的调节工具箱」（10 字）→「调节工具箱」，不能是「嵌套」。en、fr 只翻译 zh 这个词。';
export function conceptPrompt(r) {
  const target = r.respondsTo;
  // The target is the latest completed daily concept within 7 days, not necessarily yesterday's.
  const responseTask = target ? `上一篇每日概念（${target.day}）是${target.agent.bookLabel || target.agent.name}的作者讲的「${target.concept}」：${target.oneLine || ''}。请先从你绑定的书出发，用 60–400 字回应：赞同、反驳还是补充？说明理由并注明书内出处。立场会单独标出，回应正文直接写理由，不要以「赞同」「反驳」「补充」开头。回应完再选你自己的概念。\n` : '';
  return `【CO-AGENT 随机概念 ${r.conceptId}】
你是协调者，只做以下事情：
1. 派生且只派生一个 agent_role 为「${r.agent.codexName}」的子 Agent。不得派生其他 Agent，不得自己代替它回答，不要调用其他工具。
2. 交给它的任务原文如下：
「${responseTask}请从你绑定的书${r.agent.bookRef ?? `《${r.agent.title}》`}中选出一个核心概念。它应当是读者很可能『不知道自己不知道』的概念：普通读者看书名和简介时意识不到它的存在，但理解它会改变对问题的理解或决策。不得选择以下已讲过的概念：${r.excludedConcepts.join('；') || '无'}。然后使用 $concept-ai-era 技能，用中文讲解这个概念。必须保留该技能规定的开头行和全部 11 个编号小节（### 1. 到 ### 11.）。讲解必须以书中内容为依据，并注明书内出处（章节）。不要执行该技能的 Final Persistence Step，不要写任何文件，文件由 CO-AGENT 保存。最后另起一段，用一句话说明：为什么读者很可能不知道自己不知道这个概念。」
3. 等它完成后，按输出 schema 返回：concept（概念中文名）、conceptEn（英文名，没有则为 null）、oneLine（一句话说明）、whyUnknown（子 Agent 给出的那句「为什么不知道」）、sourceRefs（书内出处数组）、markdown（子 Agent 的完整概念讲解原文，不得删改或总结；回应单独放 response，正文仍为 11 节）。response 必填，${target ? 'stance 只能为「赞同」「反驳」「补充」；text 是子 Agent 回应的原文，60–400 字，必须引用自己绑定书中的出处。' : '没有回应对象，stance 必须填「无」，text 必须为空字符串，不要回应其他概念。'}另给出核心概念 term：${termRule}法文去掉冠词并保留重音符号。`;
}
export function perspectivePrompt(concept, run) {
  const r = concept.result;
  return `【CO-AGENT 概念多视角 ${run.runId}】
你是协调者，只做以下事情：
1. 立即并行派生以下子 Agent，每个恰好一次，全部派生之后才开始等待：${run.agents.map(a => a.codexName).join('、')}。不得派生名单外的 Agent，不得自己代替任何一方回答。
2. 交给每个子 Agent 的任务原文如下：
「请从你绑定的书（或你的专业角色）的视角，分析下面这个概念：书中与它对应、支持、冲突或补充它的内容是什么？它在你的领域里会怎样被使用或被误用？请注明出处。用中文写，300–600 字。概念：${r.concept}${r.conceptEn ? `（${r.conceptEn}）` : ''}。一句话说明：${r.oneLine}。原讲解来自 ${concept.agent.name} 的${concept.agent.bookRef ?? `《${concept.agent.title}》`}，节选如下：${Array.from(r.markdown).slice(0, 4000).join('')}」
3. 全部完成后，按输出 schema 返回 results 数组，每项包含 agent（codexName）和 analysis（该子 Agent 回答的原文）。`;
}
// Codex opens at most 6 sub-agents at once by default; a 7-book 会诊 or an 8-author 圆桌 needs 8 (probe, 2026-11-07:
// the 7th spawn failed with "agent thread limit reached" until agents.max_threads was raised).
export const codexThreadLimit = 8;
export function conceptArgs(config, files) {
  return ['exec', ...codexProfileArgs(config.codexProfile), ...codexModelArgs(config, { quote: true }), '-c', `agents.max_threads=${codexThreadLimit}`,
    '-s', 'read-only', '--skip-git-repo-check', '-C', config.launchProject, '--json', '--output-schema', files.schema, '-o', files.output, '-'];
}

// Every claude/codex runner ends the whole tree: an npm-installed CLI runs as node.exe, which starts the real exe.
export async function killProcessTree(child, { spawnImpl = spawn, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  if (platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  await new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawnImpl(exe, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill?.(); reject(new Error('终止进程树超时')); }, 10000);
    killer.once('error', error => { clearTimeout(timer); reject(error); });
    killer.once('close', code => { clearTimeout(timer); code === 0 || code === 128 ? resolve() : reject(new Error(`终止进程树失败（退出码 ${code}）`)); });
  });
}

const objectWith = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const nonempty = s => typeof s === 'string' && !!s.trim();
const GENERIC_TERMS = new Set(['概念', '创造', '协调', '嵌套', '方法', '思维', '原则', '系统', '模型', '理论',
  '能力', '价值', '问题', '过程', '结构', '关系', '意义', '习惯', '认知', '学习']);
export function termFits(term, concept) {
  if (typeof term?.zh !== 'string' || typeof concept !== 'string') return false;
  const zh = term.zh.replace(/\s+/gu, ''), name = concept.replace(/\s+/gu, '');
  if (!/^\p{Script=Han}{1,8}$/u.test(zh)) return false;
  if (/^\p{Script=Han}{1,8}$/u.test(name)) return zh === name;
  return name.includes(zh) && !GENERIC_TERMS.has(zh);
}
export function validateTerm(value) {
  if (!objectWith(value, ['zh','en','fr']) || !['zh','en','fr'].every(k => nonempty(value[k])) || !/^\p{Script=Han}{1,8}$/u.test(value.zh.trim())) throw new Error('核心概念 term 格式无效');
  const term = { zh: value.zh.trim(), en: value.en.trim(), fr: value.fr.trim().replace(/^(?:(?:le|la|les|un|une|des)\s+|l['’]\s*)/iu, '') };
  if (!term.fr) throw new Error('核心概念 term 法文无效');
  return term;
}
export function validateConcept(value, record = {}) {
  // Response defects are local: validate the original lecture independently.
  const invalid = (field, reason) => { throw new Error(`概念 JSON 格式无效：${field} ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('根对象', '类型错误');
  const { response, responseError, ...lecture } = value;
  // An agent that cannot write the lecture (a blocked tool, a missing source) leaves the concept and its sources empty and
  // says why in oneLine; show that reason, not a format error (four daily runs, 2026-10-13 to 10-26).
  if (typeof lecture.concept === 'string' && !lecture.concept.trim() && Array.isArray(lecture.sourceRefs) && !lecture.sourceRefs.length && nonempty(lecture.oneLine)) {
    throw new Error(`Agent 未能生成概念：${Array.from(lecture.oneLine.trim()).slice(0, 200).join('')}`);
  }
  const required = conceptSchema.required.filter(k => k !== 'response');
  const text = (field, content) => {
    if (typeof content !== 'string') invalid(field, '类型错误');
    if (!content.trim()) invalid(field, '为空');
  };
  for (const field of required) {
    if (!Object.hasOwn(lecture, field)) invalid(field, '缺失');
    if (field === 'term' || (field === 'conceptEn' && value[field] === null)) continue;
    if (field === 'sourceRefs') {
      if (!Array.isArray(value[field])) invalid(field, '类型错误');
      if (!value[field].length) invalid(field, '为空');
      value[field].forEach((ref, i) => text(`${field}[${i}]`, ref));
    } else text(field, value[field]);
  }
  for (const field of Object.keys(lecture)) if (!required.includes(field)) invalid(field, '未知字段');
  // A defective term must not discard a valid lecture. This also accepts the
  // null produced by the process runner when the engine validates it again.
  let term = null;
  try { if (termFits(value.term, value.concept)) term = validateTerm(value.term); }
  catch { /* Term-only backfill repairs invalid translation/shape fields. */ }
  let error = null, checked = null;
  // The runner and engine both validate. Preserve a previously discarded response.
  if (response === null && Object.hasOwn(value, 'responseError')) error = responseError;
  else if (!objectWith(response, ['stance', 'text']) || typeof response.text !== 'string') error = '回应格式无效';
  else if (!record.respondsTo) {
    if (response.stance !== '无' || response.text !== '') error = '没有回应对象时必须填「无」和空回应';
  } else if (!['赞同', '反驳', '补充'].includes(response.stance)) error = '有回应对象时立场必须为赞同、反驳或补充';
  else if (Array.from(responseBody(response.text).trim()).length < 60 || Array.from(response.text.trim()).length > 400) error = '回应须为 60–400 字';
  else if (!/《|第|章|S0/u.test(response.text)) error = '回应缺少书内出处';
  else checked = { ...response, text: responseBody(response.text) };
  return { ...lecture, term, response: checked, responseError: error };
}
export function validatePerspectives(value, run) {
  if (!objectWith(value, ['results']) || !Array.isArray(value.results) || value.results.length !== run.agents.length ||
      value.results.some(r => !objectWith(r, ['agent','analysis']) || !nonempty(r.analysis) || !run.agents.some(a => a.codexName === r.agent)) ||
      new Set(value.results.map(r => r.agent)).size !== run.agents.length) throw new Error('多视角 JSON 格式或 Agent 名单无效');
  return value;
}

export async function runConceptProcess(record, config, { concept, ...options } = {}) {
  const perspectives = !!record.runId;
  const value = await runJsonProcess({ id: record.runId || record.conceptId, namespace: 'concepts',
    prompt: perspectives ? perspectivePrompt(concept, record) : conceptPrompt(record), schema: perspectives ? perspectiveSchema : conceptSchema,
    timeoutMs: config.concept.timeoutMs, label: '概念' }, config, options);
  return perspectives ? validatePerspectives(value, record) : validateConcept(value, record);
}

// Shared stdin/schema transport for concepts, term backfill and seminars.
function processError(stdout, stderr) {
  let turnFailure, errorMessage;
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'turn.failed' && nonempty(event.error?.message)) turnFailure = event.error.message;
    else if (event?.type === 'error' && nonempty(event.message)) errorMessage = event.message;
  }
  const clip = (text, limit) => Array.from(text).slice(0, limit).join('');
  if (turnFailure || errorMessage) return clip((turnFailure || errorMessage).trim(), 300);
  const lines = [...new Set(stderr.split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(?:ERROR|WARN|INFO)\s+[\w:]+:\s*/, '').trim()).filter(Boolean))].slice(-3);
  // Share the budget so a long transport line cannot hide the other final diagnostics.
  const limit = Math.floor((300 - Math.max(0, lines.length - 1)) / (lines.length || 1));
  return lines.map(line => clip(line, limit)).join('\n') || '无错误输出';
}

export async function runJsonProcess({ id, namespace, prompt, schema, timeoutMs, label }, config, { spawnImpl = spawn, env = process.env, signal, onSpawn = async () => {}, killTree = killProcessTree, write = atomicWrite } = {}) {
  // A missing injection must never start a real CLI from node:test, including startup catch-up.
  if (process.env.NODE_TEST_CONTEXT && spawnImpl === spawn) throw new Error('测试必须注入 Codex 进程替身');
  const dir = path.join(config.dataDir, namespace, 'work', id);
  const files = { schema: path.join(dir, 'schema.json'), output: path.join(dir, 'out.json') };
  await write(path.join(dir, 'prompt.txt'), prompt);
  await write(files.schema, JSON.stringify(schema, null, 2) + '\n');
  const { exe, prefix } = await resolveCli(config.codexExe, env), clean = scrubEnvironment(env);
  let stdout = '', stderr = '', failure;
  try {
    await new Promise((resolve, reject) => {
      let child, settled = false, stopping = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const stop = async error => {
        if (settled || stopping) return; stopping = true;
        try { await killTree(child); }
        catch (killError) { error = Object.assign(new Error(`${error.message}；${killError.message}`), { processMayBeAlive: true, pid: child?.pid }); }
        finish(error);
      };
      const abort = () => { void stop(new Error('进程中断')); };
      const timer = setTimeout(() => { void stop(new Error(`${label}生成超时（${timeoutMs} ms）`)); }, timeoutMs);
      if (signal?.aborted) { finish(new Error('进程中断')); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        child = spawnImpl(exe, [...prefix, ...conceptArgs(config, files)], { cwd: config.launchProject, shell: false, windowsHide: true,
          ...(process.platform !== 'win32' ? { detached: true } : {}), env: clean.env, stdio: ['pipe','pipe','pipe'] });
        child.once('error', error => { void stop(error); });
        child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => { if (settled || stopping) return; stdout += chunk; if (stdout.length > 10 * 1024 * 1024) void stop(new Error(`${label}输出超过 10 MB`)); });
        child.stderr?.on('data', chunk => { if (settled || stopping) return; stderr += chunk; if (stderr.length > 1024 * 1024) void stop(new Error(`${label}错误输出超过 1 MB`)); });
        child.once('close', (code, sig) => { if (!stopping) finish(code !== 0 || sig ? new Error(`${label}进程失败（退出码 ${code}${sig ? `，信号 ${sig}` : ''}）：${processError(stdout, stderr)}`) : null); });
        if (!child.stdin) throw new Error(`${label}进程缺少 stdin`);
        child.stdin.on('error', error => { void stop(error); });
        Promise.resolve(onSpawn(child.pid, clean.scrubbedEnv)).then(() => { if (!settled && !stopping) child.stdin.end(prompt); }, error => { void stop(error); });
      } catch (error) { void stop(error); }
    });
    if ((await fs.stat(files.output)).size > 10 * 1024 * 1024) throw new Error(`${label} JSON 输出超过 10 MB`);
    let value;
    try { value = JSON.parse(await fs.readFile(files.output, 'utf8')); } catch (error) { throw new Error(`${label} JSON 无效：${error.message}`); }
    return value;
  } catch (error) {
    failure = error; throw error;
  } finally {
    try { await write(path.join(dir, 'stdout.txt'), stdout); await write(path.join(dir, 'stderr.txt'), stderr); }
    catch (error) {
      // Never mask a failed tree kill: the owning engine must keep its live lock.
      if (!failure) throw error;
      failure.message += `；过程日志写入失败：${error.message}`;
    }
  }
}
