import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './fsutil.mjs';
import { READER_PREFS, defaultReaderPrefs, normalizeReaderPrefs, validReaderPrefs } from '../public/reader-prefs.js';

export const uiOptions = Object.freeze([
  { id: 'threepane', name: '三栏 · 邮件客户端' },
  { id: 'bento', name: '便当格 · 仪表盘' },
  { id: 'editorial', name: '杂志 · 编排' },
  { id: 'shelf', name: '书房 · 书架' },
]);
export const validUi = ui => uiOptions.some(option => option.id === ui);
// v0.42: text size of the description beside a pulled-out book, in percent (2026-11-01: a slider in settings).
export const BOOK_TEXT = Object.freeze({ min: 80, max: 160, step: 10, default: 100 });
export const validBookText = value => Number.isInteger(value) && value >= BOOK_TEXT.min && value <= BOOK_TEXT.max && value % BOOK_TEXT.step === 0;
// v0.53.14: the reading modes' typography (font size, line height, measure, colours), shared by both readers.
export { READER_PREFS, validReaderPrefs };

export async function readSettings(dataDir, log = async () => {}) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    const bookText = validBookText(value?.bookText) ? value.bookText : BOOK_TEXT.default, reader = normalizeReaderPrefs(value?.reader);
    if (value?.version === 1 && ['classic', 'shadcn', 'tabler', 'dracula'].includes(value.ui)) return { version: 1, ui: 'threepane', bookText, reader };
    if (value?.version !== 1 || !validUi(value.ui)) throw new Error('版本或主题无效');
    return { version: 1, ui: value.ui, bookText, reader };
  } catch (error) {
    await log(`设置读取回退：${error.code || error.message}，使用 shelf`);
    return { version: 1, ui: 'shelf', bookText: BOOK_TEXT.default, reader: defaultReaderPrefs() }; // the default layout (v0.53: 书房)
  }
}

export async function writeSettings(dataDir, ui, bookText = BOOK_TEXT.default, reader = defaultReaderPrefs()) {
  if (!validUi(ui)) throw Object.assign(new Error('界面风格无效'), { status: 400 });
  if (!validBookText(bookText)) throw Object.assign(new Error('书本描述字号无效'), { status: 400 });
  if (!validReaderPrefs(reader)) throw Object.assign(new Error('阅读排版设置无效'), { status: 400 });
  const value = { version: 1, ui, bookText, reader: { ...reader } };
  await atomicWrite(path.join(dataDir, 'settings.json'), JSON.stringify(value, null, 2) + '\n');
  return value;
}
