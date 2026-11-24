import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');

// v0.51: the list lives in catalogDir. A missing file means no agent needs the task format; a broken one stops the
// start, because launching a format-bound agent without its format would silently change what it is asked.
export async function loadTaskContracts(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, octopus: [] }; throw new Error(`任务格式清单 task-contracts.json 无法读取：${error.message}`); }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`任务格式清单 task-contracts.json 无法读取：${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.octopus) ||
      value.octopus.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('任务格式清单 task-contracts.json 格式错误：version 必须为 1，octopus 必须为名称数组');
  }
  return value;
}
export const taskContractsFile = config => config.taskContractsFile ?? path.join(config.catalogDir, 'task-contracts.json');

export function requiresTaskFormat(name, config) { return config.taskContracts?.octopus.includes(name) === true; }

// v0.50: how prompts name the user. A Latin name is set off by spaces inside Chinese text (「与 Alex 处境」), a Chinese one is not (「与用户处境」).
export const inlineName = (name = '用户') => /[A-Za-z0-9]/.test(name) ? ` ${name} ` : name;

// v0.53.13: in-app Codex runs (rooms, concepts, chats, rewrites) start in an empty folder of the data dir instead of
// launchProject, so Codex injects neither the CO-AGENT repository's AGENTS.md nor its .codex/config.toml MCP servers
// into every book sub-agent (probe 2026-11-16: 39 614 characters of development rules before the task; 16 992 with
// an empty folder, all of them ~/.codex/AGENTS.md). Codex finds its agents in ~/.codex/agents regardless of cwd.
// Claude in-app chats keep launchProject: its .claude/agents links are how Claude finds the book agents.
export const agentCwd = config => path.join(config.dataDir, 'agent-cwd');

async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const absolute = value => typeof value === 'string' && value.trim() !== '' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
// Model and profile names follow a flag in Codex's argv: plain names only, never something that reads as another flag.
const plainName = value => typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

// v0.50: the code holds no personal paths, models or names. A value of null means the feature is not used (no copy,
// no reading-copy lookup, no code in the backup) or, for Codex, that Codex's own default applies and no flag is passed.
export function configDefaults(dataDir, home) {
  return {
    dataDir, userName: '用户', codexAgentsDir: path.join(home, '.codex', 'agents'), readingAgentsDir: null,
    launchProject: path.join(dataDir, 'workspace'), catalogDir: path.join(dataDir, 'catalog'), claudeProjectsDir: path.join(home, '.claude', 'projects'),
    claudeStateFile: path.join(home, '.claude.json'),
    claudePluginsCacheDir: path.join(home, '.claude', 'plugins', 'cache'),
    builtinClaudeAgents: ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'claude'],
    recommend: { claude: { model: 'sonnet', effort: '未声明' }, codex: { model: null, effort: null }, timeoutMs: 180000 },
    concept: { timeoutMs: 2400000, thinkDir: null, autoDaily: false },
    seminar: { timeoutMs: 2700000, thinkDir: null },
    consult: { timeoutMs: 2700000 },
    council: { timeoutMs: 2700000 },
    conceptMap: { timeoutMs: 600000 },
    // v0.49: the backup ZIP goes outside the data dir; codeDir is a repository bundled into it, if any.
    backup: { dir: path.join(home, 'Documents', 'CO-AGENT 备份'), codeDir: null },
    codexModel: null, codexEffort: null, codexProfile: null,
    codexSessionsDir: path.join(home, '.codex', 'sessions'),
    codexArchiveDirs: [],
    claudeExe: 'claude', codexExe: 'codex', pwshExe: 'pwsh.exe',
    wtExe: 'wt.exe', terminalDisplay: 'primary', terminalWindowMode: 'maximized',
    // v0.52: Agent 管理 may add (never replace) agent files in codexAgentsDir / claudeAgentDirs[0]; it can be turned off in 基本配置.
    allowAgentImport: true,
    port: 47821, claudeLaunchMode: 'agent', readyProbe: true,
    verifyTimeoutMs: 120000, verifyPollMs: 2000,
  };
}

// Merges config.json overrides onto the defaults and validates the result. Used both when loading and before
// 基本配置 saves a new config.json, so the two can never disagree about what is valid.
export function resolveConfig(overrides, { dataDir, home = os.homedir() }) {
  if (!plainObject(overrides)) throw new Error('config.json 必须为对象');
  const defaults = configDefaults(dataDir, home);
  const config = { ...defaults, ...overrides, dataDir, home };
  for (const key of ['concept', 'seminar', 'consult', 'council', 'conceptMap', 'backup']) {
    if (Object.hasOwn(overrides, key) && !plainObject(overrides[key])) throw new Error(`config.json ${key} 必须为对象`);
    config[key] = { ...defaults[key], ...overrides[key] };
  }
  if (typeof config.userName !== 'string' || !config.userName.trim() || config.userName.length > 40) throw new Error('config.json userName 必须为 1–40 字');
  config.userName = config.userName.trim();
  if (!Number.isInteger(config.concept.timeoutMs) || config.concept.timeoutMs <= 0 || config.concept.timeoutMs > 3000000 ||
      (config.concept.thinkDir !== null && !absolute(config.concept.thinkDir)) || typeof config.concept.autoDaily !== 'boolean') throw new Error('config.json concept 参数无效');
  if (!Number.isInteger(config.seminar.timeoutMs) || config.seminar.timeoutMs <= 0 || config.seminar.timeoutMs > 2147483647 ||
      (config.seminar.thinkDir !== null && !absolute(config.seminar.thinkDir))) throw new Error('config.json seminar 参数无效');
  for (const section of [config.concept, config.seminar]) if (section.thinkDir) section.thinkDir = path.resolve(section.thinkDir);
  if (!Number.isInteger(config.conceptMap.timeoutMs) || config.conceptMap.timeoutMs <= 0 || config.conceptMap.timeoutMs > 2147483647) throw new Error('config.json conceptMap 参数无效');
  if (!absolute(config.backup.dir)) throw new Error('config.json backup.dir 必须为绝对路径');
  if (config.backup.codeDir !== null && !absolute(config.backup.codeDir)) throw new Error('config.json backup.codeDir 必须为绝对路径或 null');
  if (!Number.isInteger(config.council.timeoutMs) || config.council.timeoutMs <= 0 || config.council.timeoutMs > 2147483647) throw new Error('config.json council 参数无效');
  if (!Number.isInteger(config.consult.timeoutMs) || config.consult.timeoutMs <= 0 || config.consult.timeoutMs > 2147483647) throw new Error('config.json consult 参数无效');
  if (!absolute(config.launchProject)) throw new Error('config.json launchProject 必须为绝对路径');
  // v0.51: null (基本配置 left empty) means the catalog folder in the data dir.
  config.catalogDir ??= defaults.catalogDir;
  if (!absolute(config.catalogDir)) throw new Error('config.json catalogDir 必须为绝对路径');
  if (!Object.hasOwn(overrides, 'claudeAgentDirs')) config.claudeAgentDirs = [path.join(home, '.claude', 'agents'), path.join(config.launchProject, '.claude', 'agents')];
  config.recommend = { ...defaults.recommend, ...overrides.recommend,
    claude: { ...defaults.recommend.claude, ...overrides.recommend?.claude },
    codex: { ...defaults.recommend.codex, ...overrides.recommend?.codex } };
  // The required Claude argv has no effort flag; inherited CLI settings cannot be inferred.
  config.recommend.claude.effort = '未声明';
  if (typeof config.recommend.claude.model !== 'string' || !config.recommend.claude.model.trim()) throw new Error('config.json recommend.claude.model 无效');
  if (config.recommend.codex.model !== null && !plainName(config.recommend.codex.model)) throw new Error('config.json recommend.codex.model 无效');
  if ((config.recommend.codex.effort !== null && !EFFORTS.includes(config.recommend.codex.effort)) ||
      !Number.isFinite(config.recommend.timeoutMs) || config.recommend.timeoutMs <= 0 || config.recommend.timeoutMs > 180000) throw new Error('config.json 推荐参数无效');
  if ((config.codexModel !== null && !plainName(config.codexModel)) || (config.codexEffort !== null && !EFFORTS.includes(config.codexEffort)) ||
      (config.codexProfile !== null && !plainName(config.codexProfile))) throw new Error('config.json Codex 模型参数无效');
  if (!Array.isArray(config.builtinClaudeAgents) || config.builtinClaudeAgents.some(s => typeof s !== 'string' || !s.trim()) ||
      typeof config.claudePluginsCacheDir !== 'string' || !config.claudePluginsCacheDir.trim()) throw new Error('config.json Claude 类型配置无效');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('config.json port 无效');
  if (!['agent', 'relay'].includes(config.claudeLaunchMode)) throw new Error('config.json claudeLaunchMode 无效');
  if (typeof config.allowAgentImport !== 'boolean') throw new Error('config.json allowAgentImport 必须为 true 或 false');
  if (!['primary', 'secondary'].includes(config.terminalDisplay)) throw new Error('config.json terminalDisplay 无效');
  if (!['fullscreen', 'maximized', 'normal'].includes(config.terminalWindowMode)) throw new Error('config.json terminalWindowMode 无效');
  if (typeof config.readyProbe !== 'boolean' || !Number.isFinite(config.verifyTimeoutMs) || config.verifyTimeoutMs < 0 ||
      !Number.isFinite(config.verifyPollMs) || config.verifyPollMs <= 0) throw new Error('config.json 核验参数无效');
  for (const key of ['codexAgentsDir', 'claudeProjectsDir', 'claudeStateFile', 'codexSessionsDir', 'claudeExe', 'codexExe', 'pwshExe', 'wtExe']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`config.json ${key} 无效`);
  }
  if (!Array.isArray(config.claudeAgentDirs) || config.claudeAgentDirs.some(dir => typeof dir !== 'string' || !dir)) throw new Error('config.json claudeAgentDirs 无效');
  if (config.readingAgentsDir !== null && !absolute(config.readingAgentsDir)) throw new Error('config.json readingAgentsDir 必须为绝对路径或 null');
  if (!Array.isArray(config.codexArchiveDirs) || config.codexArchiveDirs.some(dir => !absolute(dir))) throw new Error('config.json codexArchiveDirs 无效');
  // Only the configured folder itself is protected: deriving a parent (as the Reading root once was) could cover a
  // whole drive for a user whose agents folder sits near its root, and then the app could never start.
  const protectedDirs = [projectRoot, config.launchProject, path.join(home, '.codex'), path.join(home, '.claude'),
    ...(config.readingAgentsDir ? [config.readingAgentsDir] : []), config.codexAgentsDir,
    ...config.claudeAgentDirs, config.claudePluginsCacheDir, config.claudeProjectsDir, config.codexSessionsDir, ...config.codexArchiveDirs];
  if (protectedDirs.some(dir => inside(dir, dataDir))) throw new Error(`运行数据目录位于仓库或只读来源内：${dataDir}`);
  if (config.concept.thinkDir && protectedDirs.some(dir => inside(dir, config.concept.thinkDir))) throw new Error(`concept.thinkDir 位于仓库或只读来源内：${config.concept.thinkDir}`);
  // A backup inside the data dir would back itself up; inside the repo or a read-only source it would pollute them.
  // Only a folder the user chose is checked: the default under Documents must never keep the app from starting,
  // e.g. when the launch folder is the home folder.
  if (Object.hasOwn(overrides.backup ?? {}, 'dir') && [...protectedDirs, dataDir].some(dir => inside(dir, config.backup.dir))) throw new Error(`backup.dir 位于数据目录、仓库或只读来源内：${config.backup.dir}`);
  if (config.seminar.thinkDir && protectedDirs.some(dir => inside(dir, config.seminar.thinkDir))) throw new Error(`seminar.thinkDir 位于仓库或只读来源内：${config.seminar.thinkDir}`);
  return config;
}

// v0.50: what records and the page show for a Codex setting left to Codex's own default.
export const CODEX_DEFAULT = 'Codex 默认';
export function recommendSettings(config, engine) {
  const settings = config.recommend[engine];
  if (engine !== 'codex' || !settings) return settings;
  return { model: settings.model ?? config.codexModel ?? CODEX_DEFAULT, effort: settings.effort ?? config.codexEffort ?? CODEX_DEFAULT };
}

export const configFile = dir => path.join(dir, 'config.json');

export async function readConfigOverrides(dir) {
  let text;
  try { text = await fs.readFile(configFile(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`config.json 无法读取：${error.message}`); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`config.json 无法读取：${error.message}`); }
}

export async function loadConfig({ env = process.env, home = os.homedir(), log = console.log, dataDirWasAbsent = false } = {}) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dataDir = path.resolve(env.CO_AGENT_DATA_DIR || env.AGENT_HUB_DATA_DIR || path.join(local, 'CO-AGENT'));
  const legacyDir = path.resolve(local, 'Agent Hub');
  // An explicit override is authoritative: never inspect the real legacy directory in tests.
  const migrate = !env.CO_AGENT_DATA_DIR && !env.AGENT_HUB_DATA_DIR &&
    (dataDirWasAbsent || !(await exists(dataDir))) && await exists(legacyDir);
  const config = resolveConfig(await readConfigOverrides(migrate ? legacyDir : dataDir), { dataDir, home });
  config.taskContracts = await loadTaskContracts(taskContractsFile(config));
  // Validate all settings and placement before copying any runtime data.
  if (migrate) {
    await fs.mkdir(dataDir, { recursive: true });
    for (const name of ['config.json', 'launches']) {
      const from = path.join(legacyDir, name), to = path.join(dataDir, name);
      if (await exists(from)) {
        if (name === 'config.json') await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        else await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true });
      }
    }
    config.dataDirMigration = `已从旧目录迁移：${legacyDir} → ${dataDir}`;
    log(`CO-AGENT：${config.dataDirMigration}`);
  }
  return config;
}
