// v0.40 rooms: a follow-up (追问) to a finished 圆桌讨论 or 会诊 is an in-app Codex chat with the people who took
// part; their first prompt carries the moderator's synthesis as background. The server builds that background from
// its own record, so the page only names the room and the record.
const codexName = a => a.platforms?.codex?.name || a.codexName || a.name;
const fail = (status, message) => Object.assign(new Error(message), { status });
const lines = items => items.filter(Boolean).join('\n');

function participants(record, names) {
  return names.map(name => {
    const agent = (record.catalog || []).find(a => codexName(a) === name);
    if (!agent) throw fail(409, `参加者 ${name} 不在这次记录的目录里`);
    return agent.id;
  });
}

export function seminarContext(record) {
  const r = record.result, names = r.selected.map(s => s.agent);
  return {
    agentIds: participants(record, names), title: Array.from(record.input.trim().split(/\r?\n/)[0]).slice(0, 40).join(''),
    context: lines([
      '【背景：CO-AGENT 圆桌讨论】',
      `问题：${record.input}`,
      `参加者：${names.join('、')}`,
      `共同答案：${r.commonAnswer.summary}`,
      ...r.commonAnswer.points.map(p => `- ${p.text}（${p.strength}；支持：${p.support.join('、')}）`),
      r.divergences.length ? '分歧：' : '',
      ...r.divergences.map(d => `- ${d.topic}：${d.positions.map(p => `${p.agent}：${p.view}`).join('；')}`),
      '行动建议：',
      ...r.actions.map((a, i) => `${i + 1}. ${a.text}（依据：${a.basis.join('、')}）`),
      '以上是你和其他几位作者之前参加的一场圆桌讨论的主持人综合。请从你绑定的书出发回答下面的追问；可以引用这份综合，但依据仍以你的书为准。',
      '追问：',
    ]),
  };
}

export function consultContext(record) {
  const r = record.result, memo = r.memo, rec = memo.recommendation;
  return {
    agentIds: participants(record, r.lenses.map(l => l.agent)), title: Array.from(r.situation.summary.trim()).slice(0, 40).join(''),
    context: lines([
      '【背景：CO-AGENT 会诊】',
      `处境：${r.situation.summary}`,
      `要做的决定：${r.situation.decision}`,
      '选项：', ...r.options.map(o => `${o.id}. ${o.text}`),
      `视角：${r.lenses.map(l => `${l.lens}·${l.agent}`).join('、')}`,
      rec.option === null ? `暂不推荐（把握程度：${rec.confidence}）：${rec.rationale}` : `推荐 ${rec.option}（把握程度：${rec.confidence}）：${rec.rationale}`,
      '主要风险：', ...memo.risks.map(x => `- ${x.text}`),
      '下一步行动：', ...memo.nextSteps.map(x => `- ${x.text}`),
      memo.missingInfo.length ? `会改变结论的信息：${memo.missingInfo.join('；')}` : '',
      '以上是你和其他几位作者之前参加的一次会诊的备忘录。请从你负责的视角和你绑定的书出发回答下面的追问；依据仍以你的书为准，不构成医疗、法律、心理或投资建议。',
      '追问：',
    ]),
  };
}

// origin: { room: 'seminars' | 'consults', id }. Only a finished record with a result can be followed up.
export async function roomContext(origin, { seminars, consults }) {
  if (!origin || typeof origin !== 'object' || !['seminars', 'consults'].includes(origin.room) || typeof origin.id !== 'string') throw fail(400, '追问的来源无效');
  const record = await (origin.room === 'seminars' ? seminars : consults).get(origin.id);
  if (record.status !== 'done' || !record.result) throw fail(409, origin.room === 'seminars' ? '这场圆桌还没有完成' : '这次会诊还没有完成');
  return origin.room === 'seminars' ? seminarContext(record) : consultContext(record);
}
