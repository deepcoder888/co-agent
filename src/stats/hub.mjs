import fs from 'node:fs/promises';

export async function parseHub(file) {
  const row = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!row || typeof row.launchId !== 'string' || !row.launchId || typeof row.agentName !== 'string' || !row.agentName.trim() ||
      !['claude', 'codex'].includes(row.cli) || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('启动记录缺少有效 launchId、cli、agentName 或 createdAt');
  return { events: [{ key: `hub:${row.launchId}`, kind: 'launch', source: 'hub', agentName: row.agentName,
    at: new Date(row.createdAt).toISOString(), file, line: 1, launchId: row.launchId, cli: row.cli }], badLines: 0 };
}
