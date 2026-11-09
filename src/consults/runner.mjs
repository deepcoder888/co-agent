import { runJsonProcess } from '../concepts/runner.mjs';
import { inlineName } from '../config.mjs';
import { agentSnapshot } from '../concepts/index.mjs';
import { summary } from '../../public/display.js';
import { lenses } from './lenses.mjs';

const string = { type: 'string', minLength: 1, maxLength: 600 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const optionId = { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] };
const lensId = { type: 'string', enum: lenses.map(l => l.id) };
// Up to 7 authors since v0.48 (自动选择 7 本): references to them may name all seven.
const basis = array(string, 1, 7);
const grounded = object({ text: string, basis });
export const consultSchema = object({
  situation: object({ summary: string, decision: string }),
  options: array(object({ id: optionId, text: string }), 2, 5),
  lenses: array(object({ lens: lensId, agent: string, reason: string }), 3, 7),
  perLens: array(object({ lens: lensId, agent: string, analysis: { ...string, maxLength: 3000 },
    optionNotes: array(object({ option: optionId, assessment: { type: 'string', enum: ['有利', '不利', '中性'] }, note: string }), 2, 5) }), 3, 7),
  memo: object({
    recommendation: object({ option: { type: ['string', 'null'], enum: ['A', 'B', 'C', 'D', 'E', null] },
      confidence: { type: 'string', enum: ['高', '中', '低'] }, rationale: string, basis }),
    risks: array(grounded, 1, 5),
    tensions: array(object({ topic: string, positions: array(object({ agent: string, view: string }), 2, 7) }), 0, 3),
    nextSteps: array(grounded, 3, 5), missingInfo: array(string, 0, 5),
  }),
});
export const codexName = a => a.platforms?.codex?.name || a.codexName || a.name;
export function consultPrompt(r, userName = '用户') {
  const who = inlineName(userName);
  const selection = r.mode === 'auto'
    ? `从下面的视角表中选出${r.count ? `恰好 ${r.count}` : ' 3–5'} 个与${who}处境最相关的视角；每个视角从书籍 Agent 目录中选一本最能从该视角分析的书，各视角的书互不重复，并写一句理由。不得选目录外的 Agent。`
    : '视角与人已经确定，按下面的名单进行，不得增删。';
  const catalog = r.catalog.map(a => {
    const snapshot = agentSnapshot(a);
    return `${codexName(a)}｜${snapshot.bookRef}｜${snapshot.author || '作者未载明'}｜${a.primary || '未分类'}｜${Array.from(summary(a.description)).slice(0, 80).join('').replace(/[\r\n]+/g, ' ')}`;
  }).join('\n');
  return `【CO-AGENT 会诊 ${r.consultId}】
你是会诊主持人，只做以下事情：
1. 选视角与人。${selection}
2. 立即并行派生所选子 Agent，每个恰好一次，全部派生之后才开始等待。不得派生名单外的 Agent，不得自己代替任何一方回答。
3. 交给每个子 Agent 的任务原文如下（<视角名称>和<视角说明>按其负责的视角填写）：
「${who.trimStart()}正面临下面的处境。请只从「<视角名称>」这个视角（<视角说明>）分析，不要越界讨论其他视角。依据你绑定的书，说明书中的观点怎样适用于这个处境，注明书内出处（章节），区分书中原意（BOOK）与你的推论（INFERENCE）；书中没有直接论述时明确说明。然后逐一评估每个选项在这个视角下是有利、不利还是中性，各写一句理由。不提供医疗处方、法律意见或具体投资交易指令；如果处境涉及人身安全或心理危机，首先建议立即联系专业人士。用中文写，300–600 字。
处境：${r.situation}
选项：${r.options ? r.options.map(o => `${o.id}. ${o.text}`).join(' / ') : '由主持人提出'}」
4. 如果${who}没有给出选项，你先提出 2–4 个选项交给各子 Agent，其中必须包含「维持现状 / 暂不决定」。${who.trimStart()}给出了选项时，原样使用，不得改写、合并或增加。
5. 全部完成后写决策备忘录：推荐选项（证据不足或各视角严重冲突时，recommendation.option 写 null，并在 missingInfo 中列出需要补充的信息），推荐的把握程度和理由，主要风险，视角之间的冲突（不得抹平），3–5 条下一步行动，以及哪些信息会改变结论。每条都要标明依据哪几位作者。
6. 按输出 schema 返回。每位作者的分析一律使用原文，不得删改或总结。agent、basis 和 positions.agent 只填参加者名字（与 lenses 中完全一致），书内出处写进正文。
视角表：
${lenses.map(l => `${l.id}｜${l.name}｜${l.description}`).join('\n')}
书籍 Agent 目录：
${catalog}${r.mode === 'explicit' ? '\n指定名单：\n' + r.requestedLenses.map(l => `${lenses.find(x => x.id === l.lens).name} → ${codexName(r.catalog.find(a => a.id === l.agentId))}`).join('\n') : ''}`;
}

const invalid = () => { throw new Error('会诊 JSON 格式、名单或选项引用无效'); };
// Apply the same closed object shape at every depth, including nested references.
function matches(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (value === null) return Array.isArray(schema.type) && schema.type.includes('null');
  if (schema.type === 'object') return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === schema.required.length
    && schema.required.every(k => Object.hasOwn(value, k) && matches(value[k], schema.properties[k]));
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(v => matches(v, schema.items));
  return typeof value === 'string' && !!value.trim() && Array.from(value).length <= (schema.maxLength ?? 600);
}
export function validateConsult(value, record) {
  if (!matches(value, consultSchema)) invalid();
  const selected = value.lenses.map(l => record.catalog.find(a => codexName(a) === l.agent));
  if (selected.some(a => !a || a.kind !== 'book' || !a.platforms?.codex?.available)) invalid();
  const names = selected.map(codexName);
  if (new Set(names).size !== names.length || new Set(selected.map(a => a.id)).size !== names.length || new Set(value.lenses.map(l => l.lens)).size !== names.length) invalid();
  if (record.mode === 'auto' && (record.count ? value.lenses.length !== record.count : value.lenses.length > 5)) invalid();
  if (record.mode === 'explicit' && (value.lenses.length !== record.requestedLenses.length || value.lenses.some((l, i) =>
    !record.requestedLenses.some(want => want.lens === l.lens && want.agentId === selected[i].id)))) invalid();
  const ids = value.options.map(o => o.id);
  if (ids.some((id, i) => id !== 'ABCDE'[i])) invalid();
  if (record.options) {
    if (value.options.length !== record.options.length || value.options.some((o, i) => o.id !== record.options[i].id || o.text !== record.options[i].text)) invalid();
  } else if (value.options.length > 4 || !value.options.some(o => /维持现状|暂不决定/.test(o.text))) invalid();
  if (value.perLens.length !== names.length || new Set(value.perLens.map(l => l.lens)).size !== names.length || value.perLens.some(p =>
    !value.lenses.some(l => l.lens === p.lens && l.agent === p.agent) || p.optionNotes.length !== ids.length ||
    new Set(p.optionNotes.map(n => n.option)).size !== ids.length || p.optionNotes.some(n => !ids.includes(n.option)))) invalid();
  // Match seminar reference resolution, retaining the citation suffix instead of losing it.
  const resolve = entry => {
    const text = entry.trim();
    const name = [...names].sort((a, b) => b.length - a.length).find(n => text === n || [...'：:（( ，,·'].some(sep => text.startsWith(n + sep)));
    if (!name) invalid();
    return { name, note: text.slice(name.length).replace(/^[：:（( ，,·]+|[）)]$/g, '').trim() };
  };
  const grounded = item => {
    const refs = item.basis.map(resolve);
    if (new Set(refs.map(r => r.name)).size !== refs.length) invalid();
    const notes = refs.filter(r => r.note).map(r => `${r.name}：${r.note}`);
    return { ...item, basis: refs.map(r => r.name), ...(notes.length ? { notes } : {}) };
  };
  const memo = value.memo;
  if (memo.recommendation.option === null ? !memo.missingInfo.length : !ids.includes(memo.recommendation.option)) invalid();
  const tensions = memo.tensions.map(t => {
    const positions = t.positions.map(p => { const ref = resolve(p.agent); return { ...p, agent: ref.name, ...(ref.note ? { note: ref.note } : {}) }; });
    if (new Set(positions.map(p => p.agent)).size !== positions.length) invalid();
    return { ...t, positions };
  });
  return { result: structuredClone({ ...value, memo: { ...memo, recommendation: grounded(memo.recommendation),
    risks: memo.risks.map(grounded), tensions, nextSteps: memo.nextSteps.map(grounded) } }) };
}
export async function runConsultProcess(record, config, options) {
  const value = await runJsonProcess({ id: record.consultId, namespace: 'consults', prompt: consultPrompt(record, config.userName), schema: consultSchema,
    timeoutMs: config.consult.timeoutMs, label: '会诊' }, config, options);
  validateConsult(value, record);
  return value;
}
