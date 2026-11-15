// v0.50 基本配置: the settings a user changes in the app, written to <dataDir>/config.json. The running server keeps
// the config it started with; saved values apply after a restart. Validation is config.mjs's resolveConfig, the same
// function that loads the file, so the app can never save a config.json it would then refuse to start with.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig, readConfigOverrides, configFile } from './config.mjs';
import { atomicWrite } from './fsutil.mjs';
import { resolveCli } from './launch/spec.mjs';

export const BASIC_KEYS = ['userName', 'codexModel', 'codexEffort', 'codexProfile', 'terminalDisplay', 'terminalWindowMode',
  'launchProject', 'catalogDir', 'readingAgentsDir', 'concept.thinkDir', 'concept.autoDaily', 'seminar.thinkDir', 'backup.dir', 'backup.codeDir',
  'codexArchiveDirs', 'recommend.codex.model', 'recommend.codex.effort', 'allowAgentImport'];
const PATH_KEYS = ['launchProject', 'catalogDir', 'readingAgentsDir', 'concept.thinkDir', 'seminar.thinkDir', 'backup.dir', 'backup.codeDir'];
// Programs CO-AGENT starts; git is only needed when the backup includes a code folder.
const PROGRAMS = [['claude', 'claudeExe'], ['codex', 'codexExe'], ['pwsh', 'pwshExe'], ['wt', 'wtExe'], ['git', null]];

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const read = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function write(object, key, value) {
  const parts = key.split('.');
  let at = object;
  for (const part of parts.slice(0, -1)) at = at[part] = plainObject(at[part]) ? at[part] : {};
  at[parts.at(-1)] = value;
}
// { concept: { thinkDir } } → ['concept.thinkDir']; an array or scalar ends a key.
function flatten(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) => plainObject(value) ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]);
}
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// v0.53: folders whose absence is normal on a new install. The first backup creates the backup folder; the default
// catalog folder is optional, since what Agent 管理 lists is saved in the data dir.
const normalWhenMissing = (key, value, defaults) => key === 'backup.dir' || (key === 'catalogDir' && path.resolve(value) === path.resolve(defaults.catalogDir));

async function directoryExists(dir) {
  try { return (await fs.stat(dir)).isDirectory(); }
  catch { return false; }
}

// firstRunPrompt: false keeps the settings dialog from opening by itself (test fixtures stand for a configured install).
// An npm-installed CLI is found through its shim, which is what the user installed (v0.53).
const findProgram = (exe, env) => resolveCli(exe, env).then(found => found.file);

export function createBasicConfig(config, { resolver = findProgram, env = process.env, isDirectory = directoryExists,
  firstRunPrompt = config.firstRunPrompt !== false } = {}) {
  const options = { dataDir: config.dataDir, home: config.home };
  let work = Promise.resolve();
  return {
    // What applies after the next start: the saved file, which may be newer than the running config.
    async describe() {
      const overrides = await readConfigOverrides(config.dataDir);
      const saved = resolveConfig(overrides, options);
      const firstRun = firstRunPrompt && !(await fs.stat(configFile(config.dataDir)).then(() => true, () => false));
      const values = Object.fromEntries(BASIC_KEYS.map(key => [key, read(saved, key) ?? null]));
      const defaults = resolveConfig({}, options);
      const paths = Object.fromEntries(await Promise.all(PATH_KEYS.map(async key => {
        const exists = values[key] ? await isDirectory(values[key]) : null;
        return [key, exists === false && normalWhenMissing(key, values[key], defaults) ? { exists, createdLater: true } : { exists }];
      })));
      const environment = Object.fromEntries(await Promise.all(PROGRAMS.map(async ([name, key]) =>
        [name, await resolver(key ? config[key] : name, env).catch(() => null)])));
      return { firstRun, values, paths, environment };
    },
    save(body) {
      const run = work.then(async () => {
        if (!plainObject(body)) fail('设置必须是对象');
        const entries = flatten(body);
        if (!entries.length) fail('没有要保存的设置');
        const unknown = entries.find(([key]) => !BASIC_KEYS.includes(key));
        if (unknown) fail(`不能在这里修改的设置：${unknown[0]}`);
        const merged = structuredClone(await readConfigOverrides(config.dataDir));
        for (const [key, value] of entries) write(merged, key, value);
        try { resolveConfig(merged, options); }
        catch (error) { fail(error.message); }
        await atomicWrite(configFile(config.dataDir), JSON.stringify(merged, null, 2) + '\n');
        return { saved: true, restartRequired: true };
      });
      work = run.catch(() => {});
      return run;
    },
  };
}
