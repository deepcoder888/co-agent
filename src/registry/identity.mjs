export function normalize(name) {
  return name.trim().replace(/^-+/, '').toLowerCase().replaceAll('_', '-');
}

// v0.53 access: 'write' when either side can certainly write, 'read' only when every available side is known read-only,
// otherwise 'unknown' (a Codex agent without sandbox_mode follows the user's own Codex default). A Claude agent without a
// tools list inherits every tool, Write and Edit included.
const codexAccess = sandbox => sandbox === 'read-only' ? 'read' : ['workspace-write', 'danger-full-access'].includes(sandbox) ? 'write' : 'unknown';
const claudeWrites = tools => !tools?.length || tools.some(t => /^(?:Write|Edit|MultiEdit|NotebookEdit)\b/.test(t));

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
      codex: { sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(record.sandbox_mode) ? record.sandbox_mode : '未声明',
        model: record.model || '未声明', effort: record.model_reasoning_effort || '未声明', webSearch: record.web_search ?? '未声明' },
      claude: { model: !ambiguous && claude?.model || '未声明', effort: !ambiguous && claude?.effort || '未声明',
        tools: !ambiguous && claude?.tools || [], writable: !ambiguous && !!claude && claudeWrites(claude.tools) },
    };
    const sides = [codexAccess(record.sandbox_mode), ...(claude && !ambiguous ? [permissions.claude.writable ? 'write' : 'read'] : [])];
    const access = sides.includes('write') ? 'write' : sides.every(side => side === 'read') ? 'read' : 'unknown';
    // writable means "may write": every write-confirmation gate also stops an agent whose access is undeclared.
    const writable = access !== 'read';
    return { id, name: record.name, description: record.description, sourceFile: record.file,
      permissions, access, writable,
      platforms: { codex: { available: true, file: record.file },
        claude: claude && !ambiguous ? { available: true, file: claude.file, name: claude.name } :
          { available: false, reason: ambiguous ? 'Claude 版规范化名称冲突，无法安全选择' : '启动项目中没有该 Agent 的 Claude 版' } } };
  });
  return { agents, conflicts };
}
