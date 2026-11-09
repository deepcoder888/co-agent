import { runJsonProcess, termSchema, validateTerm, termFits, termRule } from './runner.mjs';
export { validateTerm, termFits } from './runner.mjs';
export const termOutputSchema = { type: 'object', additionalProperties: false, required: ['term'], properties: { term: termSchema } };
export function termPrompt(record) {
  return '只补齐核心概念 term：' + termRule + '法文去掉冠词并保留重音符号。不调用工具、不派生 Agent、不读写文件、不重写讲解。按 schema 返回。输入数据：\n' + JSON.stringify({
    concept: record.result.concept, conceptEn: record.result.conceptEn, book: record.agent.title, oneLine: record.result.oneLine,
  });
}
export async function runTermProcess(record, config, options) {
  const value = await runJsonProcess({ id: `${record.conceptId}-term`, namespace: 'concepts', prompt: termPrompt(record), schema: termOutputSchema,
    timeoutMs: config.concept.timeoutMs, label: '术语补齐' }, config, options);
  return validateTermOutput(value, record);
}
export function validateTermOutput(value, record) {
  if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'term')) throw new Error('术语补齐 JSON 格式无效');
  const term = validateTerm(value.term);
  if (!termFits(term, record?.result?.concept)) throw new Error('术语补齐核心词不符合概念名规则');
  return { term };
}
