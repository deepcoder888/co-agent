import { saveThink } from '../concepts/think.mjs';
import { shanghaiTime } from '../concepts/index.mjs';

export function seminarMarkdown(record) {
  const r = record.result;
  const name = agent => r.perAgent.find(a => a.agent === agent)?.name || agent;
  const book = a => a.bookLabel?.startsWith('《') ? a.bookLabel : `《${a.bookLabel || '书名未载明'}》`;
  return `# 研讨：${record.input}\n\n核心概念：${r.terms.map(t => `${t.zh} · ${t.en} · ${t.fr}`).join('；')}\n\n` +
    `日期：${shanghaiTime(new Date(record.createdAt)).day}（Asia/Shanghai）\n\n参加者：\n` +
    r.selected.map(s => { const a = r.perAgent.find(a => a.agent === s.agent); return `- ${a.name} · ${book(a)} · ${s.reason}`; }).join('\n') +
    `\n\n## 共同答案\n\n${r.commonAnswer.summary}\n\n` +
    r.commonAnswer.points.map(p => `- 【${p.strength}】${p.text}（支持：${p.support.map(name).join('、')}）`).join('\n') +
    '\n\n## 分歧点\n\n' + (r.divergences.map(d => `### ${d.topic}\n\n${d.positions.map(p => `- ${name(p.agent)}：${p.view}`).join('\n')}`).join('\n\n') || '无已列明分歧。') +
    '\n\n## 行动建议\n\n' + r.actions.map((a, i) => `${i + 1}. ${a.text}（依据：${a.basis.map(name).join('、')}）`).join('\n') +
    '\n\n## 各作者的看法\n\n' + r.perAgent.map(a => `### ${a.name} · ${book(a)}\n\n${a.analysis}`).join('\n\n') + '\n';
}
export function saveSeminarThink(record, dir, options = {}) {
  return saveThink(Array.from(record.input).slice(0, 40).join(''), seminarMarkdown(record), dir, { ...options, extension: '.md' });
}
