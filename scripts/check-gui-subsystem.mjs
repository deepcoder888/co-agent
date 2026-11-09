import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readSubsystem(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('无效的 DOS/PE 可执行文件');
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  if (optional + 70 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('无效或截断的 PE 头');
  const size = bytes.readUInt16LE(pe + 20);
  if (size < 70 || optional + size > bytes.length || ![0x10b, 0x20b].includes(bytes.readUInt16LE(optional))) throw new Error('无效的 PE 可选头');
  return bytes.readUInt16LE(optional + 68);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const subsystem = readSubsystem(await fs.readFile(process.argv[2]));
  if (subsystem !== 2) throw new Error(`子系统 ${subsystem}，需要 WINDOWS_GUI (2)`);
  console.log('Subsystem = 2 (WINDOWS_GUI)');
}
