import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSubsystem } from './check-gui-subsystem.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const archiveName = 'electron-v44.10.2-win32-x64.zip';
export function included(file) {
  const name = file.replaceAll('\\', '/');
  return ['', '/', '/package.json', '/launcher', '/launcher/launch.ps1', '/assets', '/assets/brand', '/assets/brand/co-agent.ico'].includes(name) ||
    /^\/(electron|src|public)(\/|$)/.test(name);
}
async function findArchive(cache) {
  async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  if (await isFile(path.join(cache, archiveName))) return cache;
  let entries;
  try { entries = await fs.readdir(cache, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && await isFile(path.join(cache, entry.name, archiveName))) return path.join(cache, entry.name);
  }
  throw new Error(`离线 Electron 包缺失，未尝试下载：${path.join(cache, archiveName)}。先运行 npx install-electron 下载它（Electron 44 起 npm ci 不再自动下载）`);
}
export async function packageApp({ root = projectRoot, env = process.env, packager } = {}) {
  root = path.resolve(root);
  const cache = env.CO_AGENT_ELECTRON_ZIP_DIR || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'electron', 'Cache'));
  if (!cache) throw new Error('离线 Electron 包缺失，未尝试下载：未设置 LOCALAPPDATA 或 CO_AGENT_ELECTRON_ZIP_DIR');
  const zipDir = await findArchive(path.resolve(cache));
  const zipHash = createHash('sha256').update(await fs.readFile(path.join(zipDir, archiveName))).digest('hex');
  const checksums = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'electron', 'checksums.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(checksums[archiveName] || '') || zipHash !== checksums[archiveName].toLowerCase()) throw new Error(`离线 Electron 包 SHA256 校验失败：${archiveName}，实际 ${zipHash}`);
  // Installed packager's electronZipDir branch throws on missing zip; it cannot fall back to downloading.
  const runPackager = packager || (await import('@electron/packager')).packager;
  const paths = await runPackager({ dir: root, out: path.join(root, 'release'), name: 'CO-AGENT', platform: 'win32', arch: 'x64',
    electronVersion: '44.10.2', electronZipDir: zipDir, icon: path.join(root, 'assets', 'brand', 'co-agent.ico'),
    asar: false, prune: false, overwrite: true,
    win32metadata: { CompanyName: 'CO-AGENT', FileDescription: 'CO-AGENT', ProductName: 'CO-AGENT' },
    ignore: file => !included(file),
    sanitizePackageJson: [json => { const { scripts, devDependencies, ...runtime } = json; return runtime; }],
  });
  const output = path.join(root, 'release', 'CO-AGENT-win32-x64');
  const subsystem = readSubsystem(await fs.readFile(path.join(output, 'CO-AGENT.exe')));
  if (subsystem !== 2) throw new Error(`子系统 ${subsystem}，需要 WINDOWS_GUI (2)`);
  // v0.51: no data/ in the package; Agent lists are read from catalogDir.
  const required = ['src/server.mjs', 'src/catalog.mjs', 'launcher/launch.ps1', 'public/index.html'];
  for (const file of required) {
    if (!(await fs.stat(path.join(output, 'resources', 'app', file))).isFile()) throw new Error(`打包必需文件缺失：${file}`);
  }
  const evidence = { offline: true, electronVersion: '44.10.2', archive: archiveName, zipDir, zipHash, checksumMatched: true, output, paths, subsystem, required, asar: false };
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
  await fs.writeFile(path.join(root, '.tmp', 'package-v0.5.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await packageApp(); console.log(`PACKAGE OK（离线）：${result.output}\nSHA256 ${result.zipHash}\nSubsystem = 2 (WINDOWS_GUI)`); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
