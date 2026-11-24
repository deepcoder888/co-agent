import { manageDialog } from './accessibility.js';
import { autoHideRail } from './reader-rail.js';
import { renderMarkdown } from './markdown.js';
import { cleanTitle, authorShort, preferredBookFile } from './display.js';
import { mountReaderPrefs, configureReaderPrefs } from './reader-prefs.js';

// v0.41 在软件中阅读原书 (2026-11-01): 「打开原书」 opens the book in the reading mode of 「阅读本书的 Word」, in every
// layout. The dialog sits in a host marked data-ui="shelf", so the shelf's reader styles apply wherever it opens.
// EPUB chapters render on the paper page with the book's own outline; a PDF shows in Chromium's viewer inside the page;
// the position (file, chapter, scroll) is remembered per book. 「用系统程序打开」 stays as the second way.
// 阅读体验 (2026-11-16): the outline jumps to sections inside a chapter and marks exactly one entry as the
// place being read; superscripts, footnotes and links inside the book work, with 「↩ 回到刚才的位置」 after a jump;
// ← / → turn chapters; a quiet line at the bottom shows the share of the book and the minutes left in the chapter; the
// place is kept by paragraph; a PDF remembers the page typed into 「读到第几页」; 「Aa 排版」 (public/reader-prefs.js).
const el = (doc, tag, text, className) => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (doc, text, run, label, className) => {
  const node = el(doc, 'button', text, className); node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', event => { if (!node.disabled) return run(event); });
  return node;
};
const formatName = { epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI' };
// v0.42 研读时长 (2026-11-01): while a book is open here and the window is in front, a beat every 30 s reports the
// seconds since the last one; the server counts them only if someone used the computer in the last 5 minutes.
export const BEAT_MS = 30000, IDLE_MS = 300000;
// Scrolling updates the outline mark and the progress line at most this often; a jump leaves its anchor this far below
// the top of the page; an anchor this close to the top counts as reached.
export const TRACK_MS = 100, ANCHOR_GAP = 24, ANCHOR_REACHED = 40;
const MAX_PAGE = 100000;

export function mountBookReader(doc, { api, getRegistry, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  const host = el(doc, 'div', undefined, 'book-reader-host'); host.setAttribute('data-ui', 'shelf');
  const dialog = el(doc, 'dialog', undefined, 'shelf-reader book-reader'); dialog.id = 'book-reader';
  const exit = button(doc, '', () => controller.close(), '合上书', 'shelf-reader-exit'); exit.id = 'book-reader-exit'; exit.title = '合上书（Esc）';
  exit.append(el(doc, 'span', '←', 'shelf-reader-exit-arrow'), el(doc, 'span', ' 合上书', 'shelf-reader-exit-label'), el(doc, 'kbd', 'Esc'));
  const fileLabel = el(doc, 'label', '版本', 'book-reader-file-label'); fileLabel.setAttribute('for', 'book-reader-file');
  const files = el(doc, 'select', undefined, 'book-reader-file'); files.id = 'book-reader-file';
  files.addEventListener('change', () => { if (state) load(state.agentId, Number(files.value), { chapter: 0, ratio: 0 }); });
  // 2026-11-16: Chromium's PDF viewer does not tell the page which page is shown, so the reader types it in.
  const pageLabel = el(doc, 'label', '读到第几页', 'book-reader-page-label'); pageLabel.setAttribute('for', 'book-reader-page');
  const pageInput = el(doc, 'input', undefined, 'book-reader-page'); pageInput.id = 'book-reader-page';
  for (const [key, value] of [['type', 'number'], ['min', '1'], ['max', String(MAX_PAGE)], ['step', '1'], ['inputmode', 'numeric'], ['placeholder', '从头']]) pageInput.setAttribute(key, value);
  pageInput.addEventListener('change', () => setPage());
  pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault?.(); setPage(); } });
  pageLabel.hidden = pageInput.hidden = true;
  const external = button(doc, '用系统程序打开', () => openExternal(), '用系统程序打开原书', 'book-reader-external'); external.id = 'book-reader-external';
  const tools = el(doc, 'div', undefined, 'book-reader-tools'); tools.append(fileLabel, files, pageLabel, pageInput, external);
  const toggle = button(doc, '‹', () => setToc(!tocCollapsed), '收起目录', 'shelf-reader-toc-toggle'); toggle.id = 'book-reader-toc-toggle';
  toggle.setAttribute('aria-controls', 'book-reader-toc-list'); toggle.setAttribute('aria-expanded', 'true');
  const tocHeading = el(doc, 'span', '目录', 'shelf-reader-toc-heading');
  const tocList = el(doc, 'div', undefined, 'shelf-reader-toc-list'); tocList.id = 'book-reader-toc-list';
  const tocHead = el(doc, 'div', undefined, 'shelf-reader-toc-head'); tocHead.append(tocHeading, toggle);
  const toc = el(doc, 'nav', undefined, 'shelf-reader-toc'); toc.id = 'book-reader-toc'; toc.setAttribute('aria-label', '本书目录'); toc.append(tocHead, tocList);
  const masthead = el(doc, 'header', undefined, 'shelf-reader-masthead');
  const body = el(doc, 'div', undefined, 'shelf-reader-body'); body.id = 'book-reader-body';
  const prev = button(doc, '', () => go(state.chapter - 1), '上一章', 'book-reader-turn'); prev.id = 'book-reader-prev'; prev.title = '上一章（←）';
  const next = button(doc, '', () => go(state.chapter + 1), '下一章', 'book-reader-turn is-next'); next.id = 'book-reader-next'; next.title = '下一章（→）';
  const pager = el(doc, 'nav', undefined, 'book-reader-pager'); pager.setAttribute('aria-label', '翻章'); pager.append(prev, next);
  // The version picker and 用系统程序打开 head the page and scroll away with it, so they never sit over the text (2026-11-01).
  const page = el(doc, 'article', undefined, 'shelf-reader-page'); page.append(tools, masthead, body, pager);
  const grid = el(doc, 'div', undefined, 'shelf-reader-grid'); grid.append(toc, page);
  // The collapsed outline rail hides after 3 s and comes back from the left edge (public/reader-rail.js).
  const edge = el(doc, 'div', undefined, 'shelf-reader-edge'); edge.setAttribute('aria-hidden', 'true');
  // After following a link inside the book: back to where the reader was.
  const back = button(doc, '↩ 回到刚才的位置', () => returnBack(), undefined, 'book-reader-back'); back.id = 'book-reader-back'; back.hidden = true;
  // The progress line is read by sight; the same words are its title, and screen readers are not interrupted by it.
  const progress = el(doc, 'p', undefined, 'book-reader-progress'); progress.id = 'book-reader-progress'; progress.setAttribute('aria-hidden', 'true'); progress.hidden = true;
  const prefs = mountReaderPrefs(doc, dialog, { idPrefix: 'book-reader' });
  dialog.append(exit, prefs.element, grid, edge, back, progress); host.append(dialog); doc.body.append(host);
  const controller = manageDialog(doc, dialog, { labelledby: 'book-reader-title', initialFocus: exit });
  configureReaderPrefs(doc, { api });
  let state = null, ticket = 0, tocCollapsed = false, saveTimer, entries = [], beatTimer, lastBeat = 0, lastInput = 0, trackTimer, tracking = false;
  const rail = autoHideRail(doc, { dialog, rail: toc, exit, edge, isCollapsed: () => tocCollapsed, isActive: () => state?.format === 'epub',
    onHidden: setDialogClass, setTimer, clearTimer });
  dialog.addEventListener('close', () => {
    beat(); clearTimer(beatTimer); save(); clearTimer(saveTimer); stopTracking(); rail.reset(); prefs.close();
    back.hidden = true; progress.hidden = true; state = null; ticket++;
  });
  // Input inside the page; inside the PDF viewer it cannot be seen, so focus on that viewer also counts as reading.
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'scroll']) dialog.addEventListener(type, () => { lastInput = now(); });
  // A restored place is re-aligned as the chapter's pictures load, until the reader does something.
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) dialog.addEventListener(type, () => { if (state) state.realign = null; });
  dialog.addEventListener('keydown', turnByKey);
  function beat() {
    if (!state?.agentId || !lastBeat) return;
    const at = now(), seconds = Math.min(120, (at - lastBeat) / 1000); lastBeat = at;
    const front = doc.visibilityState !== 'hidden' && doc.hasFocus?.() !== false;
    const active = at - lastInput < IDLE_MS || doc.activeElement?.classList?.contains?.('book-reader-pdf') === true;
    if (front && seconds > 0) api(`/api/reading-time/${encodeURIComponent(state.agentId)}`, { seconds: Math.round(seconds * 10) / 10, active }, 'POST').catch(() => { /* a lost beat is half a minute */ });
  }
  function ticking() { clearTimer(beatTimer); beatTimer = setTimer(() => { beat(); ticking(); }, BEAT_MS); }
  function setDialogClass() { dialog.className = ['shelf-reader book-reader', state?.format === 'pdf' && 'is-pdf', rail?.hidden && 'is-rail-hidden'].filter(Boolean).join(' '); }
  dialog.addEventListener('scroll', () => {
    if (state?.format !== 'epub') return;
    clearTimer(saveTimer); saveTimer = setTimer(save, 800);
    if (!tracking) { tracking = true; trackTimer = setTimer(() => { tracking = false; track(); }, TRACK_MS); }
  });
  function stopTracking() { clearTimer(trackTimer); tracking = false; }

  function setToc(collapsed) {
    tocCollapsed = collapsed;
    grid.className = 'shelf-reader-grid' + (collapsed ? ' is-toc-collapsed' : '');
    exit.className = 'shelf-reader-exit' + (collapsed ? ' is-compact' : '');
    const label = collapsed ? '展开目录' : '收起目录';
    toggle.textContent = collapsed ? '目录 ›' : '‹'; toggle.setAttribute('aria-label', label); toggle.title = label;
    toggle.setAttribute('aria-expanded', String(!collapsed)); tocHeading.hidden = collapsed; tocList.hidden = collapsed;
    if (collapsed) rail.schedule(); else rail.reveal();
  }
  // Positions on the page. Without layout (no getBoundingClientRect) they are unknown and the reader falls back to ratios.
  function ratio() {
    const room = (dialog.scrollHeight || 0) - (dialog.clientHeight || 0);
    return room > 0 ? Math.min(1, Math.max(0, (dialog.scrollTop || 0) / room)) : 0;
  }
  const frameTop = () => dialog.getBoundingClientRect?.()?.top;
  function viewTop(node) {
    const box = node?.getBoundingClientRect?.(), top = frameTop();
    return box && typeof top === 'number' ? box.top - top : null;
  }
  function scrollToY(y) {
    const top = Math.max(0, Math.round(y || 0));
    // Instantly, not through the dialog's scroll-behavior:smooth.
    if (typeof dialog.scrollTo === 'function') dialog.scrollTo({ top, behavior: 'instant' }); else dialog.scrollTop = top;
  }
  const blocks = () => Array.from(body.querySelector('.concept-markdown')?.children || []);
  const anchorNode = name => name ? Array.from(body.querySelectorAll('span[data-book-anchor]')).find(node => node.getAttribute('data-book-anchor') === name) || null : null;
  // The paragraph at the top of the page and how much of it has scrolled past.
  function position() {
    const list = blocks();
    for (let i = 0; i < list.length; i++) {
      const top = viewTop(list[i]); if (top === null) return {};
      const height = list[i].getBoundingClientRect().height || 0;
      if (top + height > 0) return { block: i, offset: height > 0 ? Math.round(Math.min(1, Math.max(0, -top / height)) * 10000) / 10000 : 0 };
    }
    return list.length ? { block: list.length - 1, offset: 1 } : {};
  }
  function save() {
    if (!state?.info || state.saving === false) return;
    const body = { index: state.index, chapter: state.chapter || 0, ratio: state.format === 'epub' ? ratio() : 0 };
    if (state.format === 'epub' && state.rendered === state.chapter) Object.assign(body, position());
    if (state.format === 'pdf' && state.page) body.page = state.page;
    api(`/api/reading-progress/${encodeURIComponent(state.agentId)}`, body, 'PUT').catch(() => { /* a lost position only means starting from the chapter */ });
  }
  function head(eyebrow, lead = '') {
    const agent = state.agent, title = el(doc, 'h1', cleanTitle(agent.book?.title || agent.bookLabel || state.info?.title || agent.name).text || agent.name, 'shelf-reader-title');
    title.id = 'book-reader-title';
    masthead.replaceChildren(el(doc, 'p', eyebrow, 'shelf-reader-eyebrow'), title, el(doc, 'p', lead, 'shelf-reader-lead'),
      el(doc, 'p', [agent.book?.author || authorShort(agent), `书籍 Agent：${agent.name}`].filter(Boolean).join(' · '), 'shelf-reader-source'));
  }
  function status(text) { const p = el(doc, 'p', text, 'shelf-reader-status'); p.setAttribute('role', 'status'); body.replaceChildren(p); }
  function fillFiles(info) {
    files.replaceChildren(...info.files.map(f => {
      const option = el(doc, 'option', `${formatName[f.format] || f.format.toUpperCase()} · ${f.label}${f.derived && !f.label.includes('阅读副本') ? '（阅读副本）' : ''}${f.exists ? '' : '（文件不存在）'}${f.readable ? '' : '（需用系统程序打开）'}`);
      option.value = String(f.index); option.disabled = !f.readable || !f.exists; return option;
    }));
    files.value = String(info.index); fileLabel.hidden = files.hidden = info.files.length < 2;
  }
  function fillToc(info) {
    const items = info.toc?.length ? info.toc : info.chapters.map((c, i) => ({ title: c.title || `第 ${i + 1} 部分`, chapter: i, depth: 0 }));
    entries = items.map(item => {
      const entry = { chapter: item.chapter, anchor: String(item.anchor || '') };
      entry.button = button(doc, item.title, () => go(item.chapter, { anchor: entry.anchor, entry }), '跳到：' + item.title, 'shelf-reader-toc-item ' + (item.depth ? 'is-sub' : 'is-main'));
      entry.button.setAttribute('data-chapter', String(item.chapter));
      if (entry.anchor) entry.button.setAttribute('data-anchor', entry.anchor);
      return entry;
    });
    tocList.replaceChildren(...entries.map(entry => entry.button)); toc.hidden = !entries.length;
  }
  // Exactly one outline entry is the place being read: in the chapter shown, the last one whose anchor has reached the
  // top of the page (an entry without an anchor stands at the chapter's start), else its first; a chapter without
  // entries of its own belongs to the last entry before it.
  function currentEntry() {
    const n = state.rendered ?? state.chapter, own = entries.filter(entry => entry.chapter === n);
    if (!own.length) return entries.findLast(entry => entry.chapter <= n) || entries[0] || null;
    let current = own[0];
    for (const entry of own) {
      if (!entry.anchor) { current = entry; continue; }
      const top = viewTop(anchorNode(entry.anchor));
      if (top !== null && top <= ANCHOR_REACHED) current = entry;
    }
    return current;
  }
  function mark(current) {
    let changed = false;
    for (const entry of entries) {
      const on = entry === current;
      if (on !== (entry.button.getAttribute('aria-current') === 'true')) changed = true;
      if (on) entry.button.setAttribute('aria-current', 'true'); else entry.button.removeAttribute('aria-current');
    }
    if (changed) current?.button.scrollIntoView?.({ block: 'nearest' });
  }
  // 全书 37% · 本章还剩约 12 分钟: chapter sizes from the server, the place in the chapter from the scroll position.
  function showProgress() {
    const info = state.info, n = state.rendered, units = (info.chapters || []).map(c => Number(c.units) > 0 ? Number(c.units) : 0);
    const total = units.reduce((sum, u) => sum + u, 0), speed = Number(info.speed);
    if (!total || !(speed > 0) || n === null || n === undefined) { progress.hidden = true; return; }
    const r = ratio(), done = units.slice(0, n).reduce((sum, u) => sum + u, 0) + units[n] * r, left = units[n] * (1 - r) / speed;
    const text = `全书 ${Math.min(100, Math.max(0, Math.round(done / total * 100)))}% · 本章还剩${left < 1 ? '不到 1 分钟' : `约 ${Math.ceil(left)} 分钟`}`;
    progress.textContent = text; progress.title = text; progress.hidden = false;
  }
  function track() {
    if (state?.format !== 'epub' || !state.info || state.rendered === null || state.rendered === undefined) return;
    mark(currentEntry()); showProgress();
  }
  function chapterTitle(n) { return state.info.chapters[n]?.title || state.info.toc?.findLast(t => t.chapter <= n)?.title || `第 ${n + 1} 部分`; }
  // Puts the page at a place in the rendered chapter: an anchor, else a paragraph and its offset, else a share of the page.
  function place(where = {}) {
    if (where.anchor !== undefined && where.anchor !== '') {
      const target = anchorNode(where.anchor), top = viewTop(target);
      if (target && top !== null) scrollToY((dialog.scrollTop || 0) + top - ANCHOR_GAP);
      else if (target?.scrollIntoView) target.scrollIntoView({ block: 'start' });
      else scrollToY(0);
      return;
    }
    const block = Number.isSafeInteger(where.block) ? blocks()[where.block] : null, top = viewTop(block);
    if (block && top !== null) {
      const offset = typeof where.offset === 'number' ? Math.min(1, Math.max(0, where.offset)) : 0;
      scrollToY((dialog.scrollTop || 0) + top + offset * (block.getBoundingClientRect().height || 0));
      return;
    }
    const room = (dialog.scrollHeight || 0) - (dialog.clientHeight || 0);
    scrollToY(where.ratio > 0 && room > 0 ? where.ratio * room : 0);
  }
  function restore(where = {}) {
    place(where);
    const realign = () => place(where);
    state.realign = where.anchor || Number.isSafeInteger(where.block) || where.ratio > 0 ? realign : null;
    if (state.realign) for (const image of body.querySelectorAll('img')) image.addEventListener('load', () => { if (state?.realign === realign) realign(); });
  }
  // where: { anchor, entry } from the outline or a link; { ratio, block, offset } for a saved or remembered place.
  async function go(n, where = {}) {
    if (!state?.info || n < 0 || n >= state.info.chapters.length) return;
    if (where.anchor !== undefined && state.rendered === n && state.chapter === n) {
      restore(where); mark(where.entry || currentEntry()); showProgress(); save(); return;
    }
    const mine = ++ticket; state.chapter = n; state.rendered = null; state.realign = null;
    head(`原书 · ${formatName.epub} · ${n + 1} / ${state.info.chapters.length}`, chapterTitle(n));
    status('正在翻到这一章…');
    mark(where.entry || entries.find(entry => entry.chapter === n) || entries.findLast(entry => entry.chapter <= n) || null);
    try {
      const data = await api(`/api/books/${encodeURIComponent(state.agentId)}/${state.index}/chapters/${n}`);
      if (mine !== ticket) return;
      body.replaceChildren(renderMarkdown(doc, data.markdown, { book: true }));
      state.rendered = n;
      for (const link of body.querySelectorAll('.book-link')) link.addEventListener('click', () => follow(link));
      const before = state.info.chapters[n - 1], after = state.info.chapters[n + 1];
      prev.hidden = !before; next.hidden = !after;
      prev.textContent = before ? `‹ 上一章：${chapterTitle(n - 1)}` : ''; next.textContent = after ? `下一章：${chapterTitle(n + 1)} ›` : '';
      restore(where);
      if (where.entry) mark(where.entry); else mark(currentEntry());
      showProgress(); save();
    } catch (problem) { if (mine === ticket) status(`这一章读取失败：${problem.message}`); }
  }
  // A link inside the book (a footnote number, a cross-reference): remember the place, go there, offer the way back.
  function follow(link) {
    if (state?.format !== 'epub' || !state.info) return;
    const chapter = Number(link.getAttribute('data-book-chapter')), anchor = link.getAttribute('data-book-anchor') || '';
    if (!Number.isSafeInteger(chapter) || chapter < 0 || chapter >= state.info.chapters.length) return;
    state.back = { chapter: state.chapter, ratio: ratio(), ...position() };
    back.hidden = false;
    return go(chapter, { anchor });
  }
  async function returnBack() {
    const where = state?.back; if (!where) return;
    state.back = null; back.hidden = true; dialog.focus?.();
    if (state.rendered === where.chapter && state.chapter === where.chapter) { restore(where); mark(currentEntry()); showProgress(); save(); return; }
    await go(where.chapter, where);
  }
  // ← / → turn chapters in an EPUB, except while choosing a version, typing, or in the 排版 panel.
  function turnByKey(event) {
    if (state?.format !== 'epub' || !state.info || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target, tag = String(target?.tagName || '').toUpperCase();
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes(tag) || target?.isContentEditable || target?.closest?.('.reader-prefs')) return;
    event.preventDefault?.();
    return go(state.chapter + (event.key === 'ArrowRight' ? 1 : -1));
  }
  function showPdf() {
    const frame = el(doc, 'iframe', undefined, 'book-reader-pdf');
    frame.setAttribute('src', state.info.pdf + (state.page ? `#page=${state.page}` : '')); frame.setAttribute('title', `${state.info.label}（PDF）`);
    body.replaceChildren(frame);
  }
  // A page typed in (Enter or leaving the box) is saved and the viewer is rebuilt at that page; an empty box means the start.
  function setPage() {
    if (state?.format !== 'pdf' || !state.info) return;
    const raw = String(pageInput.value ?? '').trim(), value = raw === '' ? null : Number(raw);
    if (value !== null && !(Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE)) { pageInput.value = state.page ? String(state.page) : ''; return; }
    if (value === (state.page || null)) return;
    state.page = value; showPdf(); save();
  }
  async function load(agentId, index, where) {
    const mine = ++ticket;
    state = { ...state, agentId, index, chapter: 0, rendered: null, info: null, format: null, page: null, back: null, realign: null };
    back.hidden = true; progress.hidden = true; pageLabel.hidden = pageInput.hidden = true;
    status('正在打开原书…'); toc.hidden = true; pager.hidden = true; rail.reveal(); setDialogClass();
    try {
      const info = await api(`/api/books/${encodeURIComponent(agentId)}/${index}`);
      if (mine !== ticket) return;
      state.info = info; state.format = info.format; fillFiles(info);
      // 2026-11-17: an English book is set in a Latin serif (in the Chinese serif its curly quotes are a full character wide).
      dialog.setAttribute('data-reader-lang', info.format === 'epub' && info.lang === 'en' ? 'en' : 'zh');
      if (info.format === 'pdf') {
        rail.reveal(); setDialogClass();
        head(`原书 · PDF`, info.label);
        state.page = Number.isSafeInteger(where?.page) && where.page >= 1 && where.page <= MAX_PAGE ? where.page : null;
        pageInput.value = state.page ? String(state.page) : ''; pageLabel.hidden = pageInput.hidden = false;
        showPdf(); save(); return;
      }
      setDialogClass();
      if (info.unsupported) { head(`原书 · ${formatName[info.format] || info.format}`, info.label); status('这个格式不能在软件里阅读，请用系统程序打开，或在右上角换一个版本。'); return; }
      pager.hidden = false; fillToc(info); setToc(tocCollapsed);
      await go(Math.min(where?.chapter || 0, info.chapters.length - 1), { ratio: where?.ratio || 0, block: where?.block, offset: where?.offset });
    } catch (problem) { if (mine === ticket) { head('原书', ''); status(`原书打开失败：${problem.message}`); } }
  }
  async function openExternal() {
    if (!state) return;
    try { await api('/api/open', { agentId: state.agentId, target: 'book', index: state.index }); external.textContent = '已用系统程序打开'; }
    catch (problem) { external.textContent = `打开失败：${problem.message}`; }
    setTimer(() => { external.textContent = '用系统程序打开'; }, 3000);
  }
  return {
    // Opens the remembered file and place, else the first file this reader can show.
    async open(agentId, trigger) {
      const agent = getRegistry()?.agents.find(a => a.id === agentId && a.kind === 'book');
      if (!agent || dialog.open) return false;
      let saved = null;
      try { saved = (await api(`/api/reading-progress/${encodeURIComponent(agentId)}`)).progress; } catch { /* start at the beginning */ }
      const usable = f => f && f.exists !== false && ['epub', 'pdf'].includes(String(f.ext || '').toLowerCase());
      const index = usable(agent.bookFiles?.[saved?.index]) ? saved.index : preferredBookFile(agent.bookFiles);
      state = { agentId, agent, index: Math.max(0, index), saving: true };
      head('原书', ''); controller.open(trigger);
      lastBeat = lastInput = now(); ticking();
      if (index < 0) { fillFiles({ index: 0, files: (agent.bookFiles || []).map((f, i) => ({ index: i, label: f.label || '', format: String(f.ext || ''), exists: f.exists !== false, readable: false })) });
        status('这本书没有能在软件里阅读的 EPUB 或 PDF，请用系统程序打开。'); return true; }
      await load(agentId, index, saved?.index === index ? saved : null);
      return true;
    },
    get isOpen() { return !!dialog.open; },
    dispose() { if (dialog.open) controller.close(); clearTimer(saveTimer); clearTimer(beatTimer); stopTracking(); host.remove(); },
  };
}
