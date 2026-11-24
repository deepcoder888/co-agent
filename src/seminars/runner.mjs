import { runJsonProcess, termSchema, validateTerm } from '../concepts/runner.mjs';
import { inlineName } from '../config.mjs';
import { agentSnapshot } from '../concepts/index.mjs';
import { summary } from '../../public/display.js';

const string = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items, minItems = 0, maxItems) => ({ type: 'array', items, minItems, ...(maxItems === undefined ? {} : { maxItems }) });
// v0.53.12: every attribution carries a quote from that participant's own analysis, which the server looks up.
const cited = object({ agent: string, quote: string });
export const seminarSchema = object({
  selected: array(object({ agent: string, reason: string }), 3, 8),
  perAgent: array(object({ agent: string, analysis: string, coverage: { type: 'string', enum: ['直接','相关','无'] } }), 3, 8),
  commonAnswer: object({ summary: string, points: array(object({ text: string, support: array(cited, 1, 8), strength: { type: 'string', enum: ['全员一致','多数同意'] } })) }),
  divergences: array(object({ topic: string, positions: array(object({ agent: string, view: string, quote: string }), 1, 8) })),
  actions: array(object({ text: string, basis: array(cited, 1, 8) }), 3, 5),
  terms: array(termSchema, 1, 3),
});
const codexName = a => a.platforms?.codex?.name || a.codexName || a.name;
export function seminarPrompt(r, userName = '用户') {
  const selection = r.mode === 'auto' ? '从下面的书籍 Agent 目录中选出 3–5 个最能从各自书中回答这个问题的 Agent。优先选能直接论述这个问题的书，其次选能提供互补或对立视角的书；每个都写一句选择理由。不得选目录外的 Agent，不得选功能性 Agent。' : '参加者已经确定，按下面的名单进行，不得增删。';
  const catalog = r.catalog.map(a => {
    const snapshot = agentSnapshot(a);
    return `${codexName(a)}｜${snapshot.bookRef}｜${snapshot.author || '作者未载明'}｜${a.primary || '未分类'}｜${Array.from(summary(a.description)).slice(0, 80).join('').replace(/[\r\n]+/g, ' ')}`;
  }).join('\n');
  return `【CO-AGENT 研讨 ${r.seminarId}】
你是研讨主持人，只做以下事情：
1. 选人。${selection}
2. 立即并行派生所选子 Agent，每个恰好一次，全部派生之后才开始等待。不得派生名单外的 Agent，不得自己代替任何一方回答。
3. 交给每个子 Agent 的任务原文如下：
「请从你绑定的书出发，回答或分析下面这个问题。说明本书作者对此的看法，必须注明书内出处（章节）；区分书中原意（BOOK）与你的推论（INFERENCE）。如果本书没有直接论述，明确说明这一点，并给出最接近的相关观点。用中文写，400–800 字。最后单独一行写：覆盖程度：直接 / 相关 / 无。问题：${r.input}」
4. 全部完成后进行综合：
   - 共同答案：每个要点都标出支持它的 Agent，并标注共识强度：全员一致 = 所有参加者都支持；多数同意 = 超过半数支持；只有少数支持的要点不得写进共同答案。
   - 分歧点：说明议题，以及各方的立场与理由。
   - 对${inlineName(userName)}的行动建议 3–5 条：每条都要说明它依据哪几位作者。
5. 按输出 schema 返回。每位作者的分析一律使用原文，不得删改或总结。support、basis 和 positions 各项的 agent 只填参加者名字（与 selected 中完全一致），书内出处写进 text 或 view，不要写进这些名字字段。
   support、basis 和 positions 的每一项都要给 quote：从该参加者本轮分析的原文（也就是你放进 perAgent.analysis 的那段文字）里逐字抄出一句最能支持该要点、建议或立场的话，8–120 个字符；不得改写，不得把两处拼在一起，不得抄问题或别人的话。服务器会在该参加者的分析原文里按字面查找这句话，找不到的会在界面上标为「未在原文中找到」。
书籍 Agent 目录：
${catalog}${r.mode === 'explicit' ? `\n指定名单：${r.requestedAgents.map(id => codexName(r.catalog.find(a => a.id === id))).join('、')}` : ''}
核心概念 terms：从问题中提炼 1–3 个核心词，分别给出 zh（一个词或一个字，不超过 8 个汉字，不含冒号）、en（英文译名）、fr（法文译名，去掉冠词、保留重音）。只翻译核心概念这个词本身，不翻译问题或正文。输入本身就是一个词时，只返回它一个核心概念。`;
}

const nonempty = s => typeof s === 'string' && !!s.trim();
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new Error('研讨 JSON 格式、名单或共识支持人数无效'); };
// v0.53.12 原文回查: quotes are matched literally after removing what a model tends to change when copying
// (whitespace, full/half-width punctuation, quote marks, dashes, Markdown marks, letter case).
const quoteForms = { '，': ',', '、': ',', '。': '.', '；': ';', '：': ':', '！': '!', '？': '?', '（': '(', '）': ')', '…': '...' };
export const normalizeQuote = text => String(text).replace(/\s+/gu, '').replace(/[「」『』“”‘’"'—–\-*_`#>]/gu, '')
  .replace(/[，、。；：！？（）…]/gu, c => quoteForms[c]).toLowerCase();
const quoteOk = q => typeof q === 'string' && (n => n >= 8 && n <= 120)(Array.from(normalizeQuote(q)).length);
export function validateSeminar(value, record) {
  if (!shape(value, seminarSchema.required) || !Array.isArray(value.selected) || value.selected.length < 3 || value.selected.length > (record.mode === 'auto' ? 5 : 8)) invalid();
  const selected = value.selected.map(s => {
    if (!shape(s, ['agent','reason']) || !nonempty(s.reason)) invalid();
    const a = record.catalog.find(a => codexName(a) === s.agent);
    if (!a || a.kind !== 'book' || !a.platforms?.codex?.available) invalid();
    return a;
  });
  const names = selected.map(codexName);
  if (new Set(names).size !== names.length) invalid();
  if (record.mode === 'explicit' && (selected.length !== record.requestedAgents.length || selected.some(a => !record.requestedAgents.includes(a.id)))) invalid();
  // Models sometimes write "Corvo：第二部第1章…" into a name field (Claude acceptance 2026-10-08, real seminar).
  // Resolve such entries to the participant by exact name or name + separator, keep the rest as a note,
  // and still reject anyone outside the participant list.
  const resolve = entry => {
    if (typeof entry !== 'string') return null;
    const text = entry.trim();
    const name = names.find(n => text === n || [...'：:（( ，,·'].some(sep => text.startsWith(n + sep)));
    return name ? { name, note: text.slice(name.length).replace(/^[：:（( ，,·]+|[）)]$/g, '').trim() } : null;
  };
  const normalize = list => {
    if (!Array.isArray(list)) return null;
    const resolved = list.map(resolve);
    return resolved.every(Boolean) ? resolved : null;
  };
  const refs = list => { const r = normalize(list); return !!r && r.length > 0 && new Set(r.map(x => x.name)).size === r.length; };
  const names_ = list => normalize(list).map(x => x.name);
  const notes_ = list => normalize(list).filter(x => x.note).map(x => `${x.name}：${x.note}`);
  if (!Array.isArray(value.perAgent) || value.perAgent.length !== names.length || new Set(value.perAgent.map(p => p?.agent)).size !== names.length ||
      value.perAgent.some(p => !shape(p, ['agent','analysis','coverage']) || !names.includes(p.agent) || !nonempty(p.analysis) || !['直接','相关','无'].includes(p.coverage))) invalid();
  if (!shape(value.commonAnswer, ['summary','points']) || !nonempty(value.commonAnswer.summary) || !Array.isArray(value.commonAnswer.points)) invalid();
  // A quote of the wrong length means the model ignored the schema (invalid); a quote missing from that author's
  // analysis is only marked: a whole seminar is not discarded for one unsupported attribution.
  const quotes = list => Array.isArray(list) && list.every(x => shape(x, ['agent','quote']) && quoteOk(x.quote));
  const agentsOf = list => list.map(x => x.agent);
  const analyses = new Map(value.perAgent.map(p => [p.agent, normalizeQuote(p.analysis)]));
  const sourceCheck = { total: 0, unverified: 0 };
  const found = (agent, quote) => {
    const verified = analyses.get(agent).includes(normalizeQuote(quote));
    sourceCheck.total++; if (!verified) sourceCheck.unverified++;
    return verified;
  };
  const evidence = list => list.map(x => { const agent = resolve(x.agent).name; return { agent, quote: x.quote, verified: found(agent, x.quote) }; });
  let strengthCorrected = false;
  const points = value.commonAnswer.points.map(p => {
    if (!shape(p, ['text','support','strength']) || !nonempty(p.text) || !quotes(p.support) || !refs(agentsOf(p.support)) || !['全员一致','多数同意'].includes(p.strength) || p.support.length <= names.length / 2) invalid();
    const list = agentsOf(p.support), support = names_(list), strength = support.length === names.length ? '全员一致' : '多数同意';
    if (strength !== p.strength) strengthCorrected = true;
    return { ...p, support, strength, evidence: evidence(p.support), ...(notes_(list).length ? { notes: notes_(list) } : {}) };
  });
  if (!Array.isArray(value.divergences) || value.divergences.some(d => !shape(d, ['topic','positions']) || !nonempty(d.topic) || !Array.isArray(d.positions) ||
      !refs(d.positions.map(p => p?.agent)) || d.positions.some(p => !shape(p, ['agent','view','quote']) || !nonempty(p.view) || !quoteOk(p.quote)))) invalid();
  if (!Array.isArray(value.actions) || value.actions.length < 3 || value.actions.length > 5 || value.actions.some(a => !shape(a, ['text','basis']) || !nonempty(a.text) || !quotes(a.basis) || !refs(agentsOf(a.basis)))) invalid();
  const divergences = value.divergences.map(d => ({ ...d, positions: d.positions.map(p => { const agent = resolve(p.agent).name; return { ...p, agent, verified: found(agent, p.quote) }; }) }));
  const actions = value.actions.map(a => { const list = agentsOf(a.basis); return { ...a, basis: names_(list), evidence: evidence(a.basis), ...(notes_(list).length ? { notes: notes_(list) } : {}) }; });
  if (!Array.isArray(value.terms) || value.terms.length < 1 || value.terms.length > 3) invalid();
  const terms = value.terms.map(validateTerm);
  if (new Set(terms.map(t => t.zh)).size !== terms.length || (terms.some(t => [t.zh,t.en,t.fr].some(s => s.toLowerCase() === record.input.trim().toLowerCase())) && terms.length !== 1)) invalid();
  return { result: structuredClone({ ...value, commonAnswer: { ...value.commonAnswer, points }, divergences, actions, terms, sourceCheck }), strengthCorrected };
}
export async function runSeminarProcess(record, config, options) {
  const value = await runJsonProcess({ id: record.seminarId, namespace: 'seminars', prompt: seminarPrompt(record, config.userName), schema: seminarSchema,
    timeoutMs: config.seminar.timeoutMs, label: '研讨' }, config, options);
  validateSeminar(value, record);
  // Keep the original strength until the engine records whether it was corrected.
  return value;
}
