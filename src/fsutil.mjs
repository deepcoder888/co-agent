import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function rename(io, from, to) {
  // Windows scanners can briefly lock the destination: five waits total 310 ms.
  for (let attempt = 0; ; attempt++) {
    try { return await io.rename(from, to); }
    catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

export async function atomicWrite(file, content, overrides = {}) {
  const io = { ...fs, ...overrides };
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { await rename(io, temp, file); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await io.copyFile(temp, file);
      await io.unlink(temp);
    }
  } finally { await io.rm(temp, { force: true }); }
}
