const clean = value => value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim();
const description = value => clean(value.replace(/\s*<example>.*?<\/example>/gs, ''));
const lines = value => clean(value).split('\n').map(line => line.trimEnd()).filter(line => line.trim());
const truncate = value => {
  const chars = Array.from(value);
  return chars.length > 200 ? chars.slice(0, 199).join('') + '…' : value;
};
function differences(codex, claude) {
  const lcs = Array.from({ length: codex.length + 1 }, () => new Uint32Array(claude.length + 1));
  for (let i = codex.length - 1; i >= 0; i--) for (let j = claude.length - 1; j >= 0; j--) {
    lcs[i][j] = codex[i] === claude[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const diff = [];
  let i = 0, j = 0;
  while (i < codex.length || j < claude.length) {
    if (i < codex.length && j < claude.length && codex[i] === claude[j]) { i++; j++; continue; }
    const removed = [], added = [];
    while (i < codex.length || j < claude.length) {
      if (i < codex.length && j < claude.length && codex[i] === claude[j]) break;
      if (i < codex.length && (j === claude.length || lcs[i + 1][j] >= lcs[i][j + 1])) removed.push(codex[i++]);
      else added.push(claude[j++]);
    }
    // Addition-only blocks are permitted; show the first three deletions/rewrites.
    for (let n = 0; n < removed.length && diff.length < 3; n++) {
      diff.push({ codex: truncate(removed[n]), claude: n < added.length ? truncate(added[n]) : null });
    }
    if (diff.length === 3) break;
  }
  return diff;
}
export function compareVersions(codex, claude) {
  if (![codex?.developer_instructions, codex?.description, claude?.body, claude?.description].every(v => typeof v === 'string')) {
    return { state: '无法比较', detail: '缺少版本、正文或可解析的描述/指令' };
  }
  const codexDescription = description(codex.description), claudeDescription = description(claude.description);
  const d = codexDescription !== claudeDescription;
  const codexLines = lines(codex.developer_instructions), claudeLines = lines(claude.body);
  let matched = 0;
  for (const line of claudeLines) if (matched < codexLines.length && line === codexLines[matched]) matched++;
  const i = matched !== codexLines.length, extra = claudeLines.length - codexLines.length;
  const state = d && i ? '描述和指令都不同' : d ? '描述不同' : i ? '指令不同' : '同步';
  return { state, detail: state === '同步' ? extra > 0 ? `描述与正文一致；Claude 版本另有 ${extra} 行附加内容（如工具映射）`
    : '描述与正文一致（忽略示例块、换行与行尾空白）' : state,
    ...(i ? { diff: differences(codexLines, claudeLines) } : {}),
    ...(d ? { descriptionDiff: { codex: truncate(codexDescription), claude: truncate(claudeDescription) } } : {}),
  };
}
