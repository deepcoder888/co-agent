export function normalize(name) {
  return name.trim().replace(/^-+/, '').toLowerCase().replaceAll('_', '-');
}

export function mergeIdentity(records) {
  const groups = new Map(), conflicts = [], blocked = new Set();
  for (const record of records) {
    const id = normalize(record.name), key = `${record.sourceId}:${id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const [key, group] of groups) if (group.length > 1) {
    blocked.add(key);
    conflicts.push({ id: normalize(group[0].name), sourceId: group[0].sourceId, kind: group[0].kind, files: group.map(r => r.file), reason: '同一来源内规范化名称冲突' });
  }
  const codex = records.filter(r => r.kind === 'codex' && !blocked.has(`${r.sourceId}:${normalize(r.name)}`));
  const agents = codex.map(record => {
    const id = normalize(record.name);
    const matches = records.filter(r => r.kind === 'claude' && normalize(r.name) === id);
    const ambiguous = matches.length > 1 || matches.some(r => blocked.has(`${r.sourceId}:${id}`));
    if (matches.length > 1 && new Set(matches.map(r => r.sourceId)).size > 1) {
      conflicts.push({ id, kind: 'claude', files: matches.map(r => r.file), reason: '多个 Claude 来源的身份有歧义' });
    }
    const claude = matches[0];
    const permissions = {
      codex: { sandbox: ['read-only', 'workspace-write'].includes(record.sandbox_mode) ? record.sandbox_mode : '未声明',
        model: record.model || '未声明', effort: record.model_reasoning_effort || '未声明', webSearch: record.web_search ?? '未声明' },
      claude: { model: !ambiguous && claude?.model || '未声明', effort: !ambiguous && claude?.effort || '未声明',
        tools: !ambiguous && claude?.tools || [], writable: !ambiguous && !!claude?.tools?.some(t => ['Write', 'Edit'].includes(t)) },
    };
    const writable = permissions.codex.sandbox === 'workspace-write' || permissions.claude.writable;
    return { id, name: record.name, description: record.description, sourceFile: record.file,
      permissions, writable,
      platforms: { codex: { available: true, file: record.file },
        claude: claude && !ambiguous ? { available: true, file: claude.file, name: claude.name } :
          { available: false, reason: ambiguous ? 'Claude 版规范化名称冲突，无法安全选择' : '启动项目中没有该 Agent 的 Claude 版' } } };
  });
  return { agents, conflicts };
}
