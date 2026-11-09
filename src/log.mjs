import fs from 'node:fs/promises';
import path from 'node:path';
export function createLogger(dataDir, { limit = 5 * 1024 * 1024, file: name = 'server.log' } = {}) {
  const file = path.join(dataDir, 'logs', name); let pending = Promise.resolve();
  return message => {
    const work = pending.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const line = `${new Date().toISOString()} ${String(message).replace(/[\r\n]+/g, ' ')}\n`;
      let size = 0;
      try { size = (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size > limit || (size > 0 && size + Buffer.byteLength(line, 'utf8') > limit)) {
        await fs.rm(`${file}.1`, { force: true });
        try { await fs.rename(file, `${file}.1`); }
        catch (error) { if (error.code !== 'EXDEV') throw error; await fs.copyFile(file, `${file}.1`); await fs.unlink(file); }
      }
      await fs.appendFile(file, line, 'utf8');
    });
    pending = work.catch(() => {}); return work;
  };
}
