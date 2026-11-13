// Pure presentation values. Source metadata is retained separately in detail sections.

// v0.33 (2026-10-22): the empty joint-call tray shows one of these, picked once per app launch.
export const READING_QUOTES = Object.freeze([
  { text: '读一切好书，就像与过去几个世纪最高尚的人交谈。', source: '笛卡尔' },
  { text: '书犹药也，善读之可以医愚。', source: '刘向' },
  { text: '读书破万卷，下笔如有神。', source: '杜甫' },
  { text: '学而不思则罔，思而不学则殆。', source: '《论语》' },
  { text: '温故而知新，可以为师矣。', source: '《论语》' },
  { text: '三人行，必有我师焉。', source: '《论语》' },
  { text: '君子以文会友，以友辅仁。', source: '《论语》' },
  { text: '独学而无友，则孤陋而寡闻。', source: '《礼记·学记》' },
  { text: '学然后知不足，教然后知困。', source: '《礼记·学记》' },
  { text: '博学之，审问之，慎思之，明辨之，笃行之。', source: '《礼记·中庸》' },
  { text: '他山之石，可以攻玉。', source: '《诗经·小雅》' },
  { text: '如切如磋，如琢如磨。', source: '《诗经·卫风》' },
  { text: '好读书，不求甚解；每有会意，便欣然忘食。', source: '陶渊明' },
  { text: '读书百遍，其义自见。', source: '董遇' },
  { text: '问渠那得清如许？为有源头活水来。', source: '朱熹' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', source: '陆游' },
  { text: '旧书不厌百回读，熟读深思子自知。', source: '苏轼' },
  { text: '腹有诗书气自华。', source: '苏轼' },
  { text: '书卷多情似故人，晨昏忧乐每相亲。', source: '于谦' },
  { text: '读史使人明智，读诗使人灵秀。', source: '培根' },
  { text: '如果说我看得更远，那是因为站在巨人的肩上。', source: '牛顿' },
]);
export function pickReadingQuote(random = Math.random) {
  const quote = READING_QUOTES[Math.min(READING_QUOTES.length - 1, Math.floor(random() * READING_QUOTES.length))];
  return `${quote.text}——${quote.source}`;
}
// Evaluated once per page load, so the line stays put while the app is open and changes on the next launch.
export const readingQuote = pickReadingQuote();
export function missingSourcesFor(agent, cli) {
  return agent.sources?.missingByVersion
    ? agent.sources.missingByVersion[cli] || []
    : agent.sources?.missing || [];
}

export function runningName(item) {
  return item.type === 'joint'
    ? `联合调用：${(item.whitelist || []).map(a => a.codexName || a.claudeName || a.name || a.id || '未载明').join('、')}`
    : item.agentName || '未载明';
}

function unwrapEmphasis(raw) {
  let text = String(raw || '').trim();
  while (/^(\*\*|__|\*|_)([\s\S]+)\1$/.test(text)) text = text.replace(/^(\*\*|__|\*|_)([\s\S]+)\1$/, '$2').trim();
  return text;
}
export function cleanTitle(raw = '') {
  const text = unwrapEmphasis(raw);
  const multi = text.match(/^多书[，,]\s*(\d+)\s*部[：:]\s*([\s\S]*)$/);
  if (multi) return { text: cleanTitle(multi[2].split(/[；;]/)[0]).text, multi: Number(multi[1]) };
  return { text: unwrapEmphasis(text.match(/《([^》]+)》/)?.[1] ?? text), multi: 1 };
}
const titleOf = agent => typeof agent === 'string' ? agent : agent?.book?.title || '';
// 2026-11-01: EPUBs the book pipeline derived from a PDF or MOBI (OCR or page text) are named reading-copy*,
// *-reading or *-ocr. 打开原书 prefers an original EPUB, then the PDF, and opens a derived copy only when nothing else can be read.
export const derivedReadingCopy = file => String(file?.ext || '').toLowerCase() === 'epub' && /(reading|ocr)/i.test(String(file?.path || '').split(/[\\/]/).pop());
export function preferredBookFile(files = []) {
  const ext = f => String(f?.ext || '').toLowerCase(), ok = f => f && f.exists !== false;
  for (const test of [f => ext(f) === 'epub' && !derivedReadingCopy(f), f => ext(f) === 'pdf', f => ext(f) === 'epub']) {
    const index = files.findIndex(f => ok(f) && test(f)); if (index >= 0) return index;
  }
  return -1;
}
export function bookLabel(agent) {
  const { text, multi } = cleanTitle(titleOf(agent));
  if (multi > 1) return `${text} 等 ${multi} 本`;
  return text && /\p{Script=Han}/u.test(text) && !text.startsWith('《') ? `《${text}》` : text;
}
export function spineTitle(agent) {
  const { text, multi } = cleanTitle(titleOf(agent));
  // Preserve substantive parentheticals (dates, concepts); omit only edition notes.
  const title = text.replace(/（([^（）]*)）|\(([^()]*)\)/g, (all, full, half) => /版|\bedition\b/i.test(full ?? half) ? '' : all)
    .split(/[：:]/)[0].trim();
  return multi > 1 ? `${title} 等 ${multi} 本` : title;
}
export function authorShort(agent) {
  const raw = typeof agent === 'string' ? agent : agent?.book?.author || '';
  return raw.replace(/^分别为\s*/, '').replace(/\s*主编[；;]多作者教材.*$/, '')
    .split(/[、；;]/).map(s => s.replace(/\s*主编\s*$/, '').trim()).filter(Boolean).slice(0, 2).join('、');
}
export function summary(description = '') {
  const text = String(description || '').replace(/<example\b[^>]*>[\s\S]*?<\/example>/gi, '')
    .replace(/(?:触发示例|触发例子|trigger examples?)\s*[:：][\s\S]*$/i, '')
    .replace(/^\s*(?:user|assistant|用户|助手|触发示例|示例)\s*[:：].*$/gmi, '').trim().split(/\n\s*\n/)[0].trim();
  const chars = Array.from(text); return chars.length > 160 ? chars.slice(0, 159).join('') + '…' : text;
}
export function categoryShort(name = '') {
  return String(name).split(/[／/]/).slice(0, 2).map(s => s.trim().split(/[与和]/)[0]).join('／');
}
export function avatarColor(id = '') {
  let hash = 0; for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ['#3949ab','#00796b','#ef6c00','#ad1457','#5d4037','#2e7d32','#6a1b9a','#0277bd'][hash % 8];
}

// CSP style-src 'self' forbids style attributes/cssText. Write declarations via CSSOM.
// Keys may be custom properties, kebab-case or camelCase; null removes a property.
export function setStyle(el, props) {
  for (const [key, value] of Object.entries(props)) {
    const property = key.startsWith('--') ? key : key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
    if (value == null) el.style.removeProperty(property);
    else el.style.setProperty(property, String(value));
  }
  return el;
}


export function excerpt(description) {
  if (!description) return '无描述';
  const ending = description.match(/[。！？]|[.!?](?=\s|$)/);
  const first = ending ? description.slice(0, ending.index + 1) : description;
  const chars = Array.from(first);
  return chars.length > 120 ? chars.slice(0, 120).join('') + '…' : first;
}

export function avatarLetter(name) { return Array.from(name.replace(/^-+/, ''))[0]?.toUpperCase() || '?'; }

export function formatDate(at) {
  if (!at || !Number.isFinite(Date.parse(at))) return '暂无数据';
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at));
}

export function sortAgents(agents, order, stats) {
  if (!['last7d', 'total'].includes(order) || !statsReadable(stats) || stats.building) return [...agents];
  return [...agents].sort((a, b) => (stats.perAgent[b.id]?.[order].calls || 0) - (stats.perAgent[a.id]?.[order].calls || 0));
}

export function permissionText(agent) {
  const c = agent.permissions?.codex || {}, a = agent.permissions?.claude || {};
  return `Codex：sandbox ${c.sandbox || '未声明'} · model ${c.model || '未声明'} · effort ${c.effort || '未声明'} · web_search ${c.webSearch ?? '未声明'}\nClaude：model ${a.model || '未声明'} · effort ${a.effort || '未声明'} · tools ${a.tools?.length ? a.tools.join(', ') : '未声明'} · writable ${typeof a.writable === 'boolean' ? a.writable ? '可写' : '只读' : '未声明'}`;
}

export function matchesSearch(agent, query) {
  const name = agent.name.replace(/^-+/, '').toLowerCase().replaceAll('_', '-');
  return [agent.name, agent.id, name, agent.description, agent.book?.title, agent.book?.author, agent.book?.edition, agent.primary, ...(agent.tags || [])]
    .filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase());
}

export function statsReadable(stats) { return stats?.sources?.some(s => s.available) && stats.perAgent; }

export function statsText(stats, id) {
  if (!stats || stats.building) return '统计中…';
  if (!statsReadable(stats) || !stats.perAgent[id]) return '暂无数据';
  const agent = stats.perAgent[id];
  return `近 7 天 ${agent.last7d.calls} · 累计 ${agent.total.calls}`;
}

// The stance is shown beside a response, so an opening that restates it ("补充。", "我补充：", "我选择“补充”。") is dropped.
export const responseBody = (text = '') => String(text).replace(/^\s*(?:我(?:选择)?)?[“"「]?(?:赞同|反驳|补充)[”"」]?\s*[。：:，,；;]\s*/u, '');

export function conceptStatus(value, now = Date.now()) {
  const labels = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败' };
  let text = Object.hasOwn(labels, value?.status) ? labels[value.status] : '状态未确认';
  if (['running','queued'].includes(value?.status)) {
    const start = Date.parse(value.startedAt || value.createdAt);
    text += Number.isFinite(start) ? ` · 已用 ${Math.floor(Math.max(0, now - start) / 60000)} 分 ${Math.floor(Math.max(0, now - start) / 1000) % 60} 秒` : ' · 用时未知';
  }
  return text;
}
