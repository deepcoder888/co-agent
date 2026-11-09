// D66. Maintained with the consultation plan; these IDs are persisted in records.
export const lenses = Object.freeze([
  { id: 'risk', name: '风险与不确定性', description: '最坏情况、尾部风险、可逆性、安全边际' },
  { id: 'bias', name: '判断与认知偏差', description: '这个决定可能被哪些偏差扭曲，怎样校准判断' },
  { id: 'systems', name: '系统与长期影响', description: '反馈回路、二阶效应、时间上的累积' },
  { id: 'execution', name: '执行与习惯', description: '怎样落地、启动成本、坚持机制' },
  { id: 'money', name: '财务与价值', description: '成本、收益、机会成本、复利' },
  { id: 'health', name: '身心与精力', description: '睡眠、精力、压力、身体代价' },
  { id: 'people', name: '关系与沟通', description: '涉及谁、怎样沟通、对关系的影响' },
  { id: 'meaning', name: '意义与价值观', description: '与长期目标和价值观是否一致' },
].map(Object.freeze));
