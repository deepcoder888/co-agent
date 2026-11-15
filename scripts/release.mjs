// v0.53: the download for people who do not build CO-AGENT themselves. One ZIP laid out like this repository, so that
// `scripts\install.ps1` finds the app in `release\CO-AGENT-win32-x64` exactly as after `npm run package`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { zipFiles } from '../src/backup.mjs';
import { projectRoot } from '../src/config.mjs';

export const releaseScripts = ['scripts/install.ps1', 'scripts/install-common.ps1', 'scripts/uninstall.ps1'];
const appDir = 'release/CO-AGENT-win32-x64';

export async function releaseZip({ root = projectRoot } = {}) {
  root = path.resolve(root);
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const app = path.join(root, appDir);
  try { await fs.access(path.join(app, 'CO-AGENT.exe')); }
  catch { throw new Error(`没有打包好的程序：${app}；请先运行 npm run package`); }
  const files = [];
  async function add(relative, from = relative) {
    const [data, stat] = await Promise.all([fs.readFile(path.join(root, from)), fs.stat(path.join(root, from))]);
    files.push({ name: relative.replaceAll('\\', '/'), data, mtime: stat.mtime });
  }
  const exists = file => fs.access(path.join(root, file)).then(() => true, () => false);
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`打包目录里不应有链接：${child}`);
      if (entry.isDirectory()) await walk(child); else await add(child);
    }
  }
  await walk(appDir);
  for (const file of releaseScripts) await add(file);
  // 制作书籍 Agent needs a-deepbooker, its support files and the Deepbooker skill; bookmaker/README.md says where they go.
  if (!await exists('bookmaker/README.md')) throw new Error('缺少 bookmaker/README.md');
  await walk('bookmaker');
  // The public README and LICENSE: in the development repository they live in public-repo/, its own README is private.
  for (const file of ['LICENSE', 'README.md']) {
    const from = await exists(`public-repo/${file}`) ? `public-repo/${file}` : file;
    if (!await exists(from)) throw new Error(`缺少 ${file}`);
    await add(file, from);
  }
  const zip = zipFiles(files), sha256 = createHash('sha256').update(zip).digest('hex');
  const file = path.join(root, 'release', `CO-AGENT-${version}-win32-x64.zip`);
  await fs.writeFile(file, zip);
  await fs.writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`);
  return { file, sha256, files: files.length, bytes: zip.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { file, sha256, files, bytes } = await releaseZip();
  console.log(`RELEASE OK：${file}（${files} 个文件，${(bytes / 1048576).toFixed(1)} MB）\nSHA256 ${sha256}`);
}
