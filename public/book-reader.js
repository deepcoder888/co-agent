import { manageDialog } from './accessibility.js';
import { autoHideRail } from './reader-rail.js';
import { renderMarkdown } from './markdown.js';
import { cleanTitle, authorShort, preferredBookFile } from './display.js';

// v0.41 在软件中阅读原书 (2026-11-01): 「打开原书」 opens the book in the reading mode of 「阅读本书的 Word」, in every
// layout. The dialog sits in a host marked data-ui="shelf", so the shelf's reader styles apply wherever it opens.
// EPUB chapters render on the paper page with the book's own outline; a PDF shows in Chromium's viewer inside the page;
// the position (file, chapter, scroll) is remembered per book. 「用系统程序打开」 stays as the second way.
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

export function mountBookReader(doc, { api, getRegistry, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  const host = el(doc, 'div', undefined, 'book-reader-host'); host.setAttribute('data-ui', 'shelf');
  const dialog = el(doc, 'dialog', undefined, 'shelf-reader book-reader'); dialog.id = 'book-reader';
  const exit = button(doc, '', () => controller.close(), '合上书', 'shelf-reader-exit'); exit.id = 'book-reader-exit'; exit.title = '合上书（Esc）';
  exit.append(el(doc, 'span', '←', 'shelf-reader-exit-arrow'), el(doc, 'span', ' 合上书', 'shelf-reader-exit-label'), el(doc, 'kbd', 'Esc'));
  const fileLabel = el(doc, 'label', '版本', 'book-reader-file-label'); fileLabel.setAttribute('for', 'book-reader-file');
  const files = el(doc, 'select', undefined, 'book-reader-file'); files.id = 'book-reader-file';
  files.addEventListener('change', () => { if (state) load(state.agentId, Number(files.value), { chapter: 0, ratio: 0 }); });
  const external = button(doc, '用系统程序打开', () => openExternal(), '用系统程序打开原书', 'book-reader-external'); external.id = 'book-reader-external';
  const tools = el(doc, 'div', undefined, 'book-reader-tools'); tools.append(fileLabel, files, external);
  const toggle = button(doc, '‹', () => setToc(!tocCollapsed), '收起目录', 'shelf-reader-toc-toggle'); toggle.id = 'book-reader-toc-toggle';
  toggle.setAttribute('aria-controls', 'book-reader-toc-list'); toggle.setAttribute('aria-expanded', 'true');
  const tocHeading = el(doc, 'span', '目录', 'shelf-reader-toc-heading');
  const tocList = el(doc, 'div', undefined, 'shelf-reader-toc-list'); tocList.id = 'book-reader-toc-list';
  const tocHead = el(doc, 'div', undefined, 'shelf-reader-toc-head'); tocHead.append(tocHeading, toggle);
  const toc = el(doc, 'nav', undefined, 'shelf-reader-toc'); toc.id = 'book-reader-toc'; toc.setAttribute('aria-label', '本书目录'); toc.append(tocHead, tocList);
  const masthead = el(doc, 'header', undefined, 'shelf-reader-masthead');
  const body = el(doc, 'div', undefined, 'shelf-reader-body'); body.id = 'book-reader-body';
  const prev = button(doc, '', () => go(state.chapter - 1), '上一章', 'book-reader-turn'); prev.id = 'book-reader-prev';
  const next = button(doc, '', () => go(state.chapter + 1), '下一章', 'book-reader-turn is-next'); next.id = 'book-reader-next';
  const pager = el(doc, 'nav', undefined, 'book-reader-pager'); pager.setAttribute('aria-label', '翻章'); pager.append(prev, next);
  // The version picker and 用系统程序打开 head the page and scroll away with it, so they never sit over the text (2026-11-01).
  const page = el(doc, 'article', undefined, 'shelf-reader-page'); page.append(tools, masthead, body, pager);
  const grid = el(doc, 'div', undefined, 'shelf-reader-grid'); grid.append(toc, page);
  // The collapsed outline rail hides after 3 s and comes back from the left edge (public/reader-rail.js).
  const edge = el(doc, 'div', undefined, 'shelf-reader-edge'); edge.setAttribute('aria-hidden', 'true');
  dialog.append(exit, grid, edge); host.append(dialog); doc.body.append(host);
  const controller = manageDialog(doc, dialog, { labelledby: 'book-reader-title', initialFocus: exit });
  let state = null, ticket = 0, tocCollapsed = false, saveTimer, entries = [], beatTimer, lastBeat = 0, lastInput = 0;
  const rail = autoHideRail(doc, { dialog, rail: toc, exit, edge, isCollapsed: () => tocCollapsed, isActive: () => state?.format === 'epub',
    onHidden: setDialogClass, setTimer, clearTimer });
  dialog.addEventListener('close', () => { beat(); clearTimer(beatTimer); save(); clearTimer(saveTimer); rail.reset(); state = null; ticket++; });
  // Input inside the page; inside the PDF viewer it cannot be seen, so focus on that viewer also counts as reading.
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'scroll']) dialog.addEventListener(type, () => { lastInput = now(); });
  function beat() {
    if (!state?.agentId || !lastBeat) return;
    const at = now(), seconds = Math.min(120, (at - lastBeat) / 1000); lastBeat = at;
    const front = doc.visibilityState !== 'hidden' && doc.hasFocus?.() !== false;
    const active = at - lastInput < IDLE_MS || doc.activeElement?.classList?.contains?.('book-reader-pdf') === true;
    if (front && seconds > 0) api(`/api/reading-time/${encodeURIComponent(state.agentId)}`, { seconds: Math.round(seconds * 10) / 10, active }, 'POST').catch(() => { /* a lost beat is half a minute */ });
  }
  function ticking() { clearTimer(beatTimer); beatTimer = setTimer(() => { beat(); ticking(); }, BEAT_MS); }
  function setDialogClass() { dialog.className = ['shelf-reader book-reader', state?.format === 'pdf' && 'is-pdf', rail?.hidden && 'is-rail-hidden'].filter(Boolean).join(' '); }
  dialog.addEventListener('scroll', () => { if (state?.format === 'epub') { clearTimer(saveTimer); saveTimer = setTimer(save, 800); } });

  function setToc(collapsed) {
    tocCollapsed = collapsed;
    grid.className = 'shelf-reader-grid' + (collapsed ? ' is-toc-collapsed' : '');
    exit.className = 'shelf-reader-exit' + (collapsed ? ' is-compact' : '');
    const label = collapsed ? '展开目录' : '收起目录';
    toggle.textContent = collapsed ? '目录 ›' : '‹'; toggle.setAttribute('aria-label', label); toggle.title = label;
    toggle.setAttribute('aria-expanded', String(!collapsed)); tocHeading.hidden = collapsed; tocList.hidden = collapsed;
    if (collapsed) rail.schedule(); else rail.reveal();
  }
  function ratio() {
    const room = (dialog.scrollHeight || 0) - (dialog.clientHeight || 0);
    return room > 0 ? Math.min(1, Math.max(0, (dialog.scrollTop || 0) / room)) : 0;
  }
  function save() {
    if (!state?.info || state.saving === false) return;
    const body = { index: state.index, chapter: state.chapter || 0, ratio: state.format === 'epub' ? ratio() : 0 };
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
      const link = button(doc, item.title, () => go(item.chapter), '跳到：' + item.title, 'shelf-reader-toc-item ' + (item.depth ? 'is-sub' : 'is-main'));
      link.setAttribute('data-chapter', String(item.chapter)); return link;
    });
    tocList.replaceChildren(...entries); toc.hidden = !entries.length;
  }
  function chapterTitle(n) { return state.info.chapters[n]?.title || state.info.toc?.findLast(t => t.chapter <= n)?.title || `第 ${n + 1} 部分`; }
  async function go(n, restore = 0) {
    if (!state?.info || n < 0 || n >= state.info.chapters.length) return;
    const mine = ++ticket; state.chapter = n;
    head(`原书 · ${formatName.epub} · ${n + 1} / ${state.info.chapters.length}`, chapterTitle(n));
    status('正在翻到这一章…');
    for (const link of entries) if (Number(link.getAttribute('data-chapter')) === n) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
    entries.find(link => link.getAttribute('aria-current') === 'true')?.scrollIntoView?.({ block: 'nearest' });
    try {
      const data = await api(`/api/books/${encodeURIComponent(state.agentId)}/${state.index}/chapters/${n}`);
      if (mine !== ticket) return;
      body.replaceChildren(renderMarkdown(doc, data.markdown));
      const before = state.info.chapters[n - 1], after = state.info.chapters[n + 1];
      prev.hidden = !before; next.hidden = !after;
      prev.textContent = before ? `‹ 上一章：${chapterTitle(n - 1)}` : ''; next.textContent = after ? `下一章：${chapterTitle(n + 1)} ›` : '';
      dialog.scrollTop = 0;
      if (restore) { const room = (dialog.scrollHeight || 0) - (dialog.clientHeight || 0); if (room > 0) dialog.scrollTop = Math.round(restore * room); }
      save();
    } catch (problem) { if (mine === ticket) status(`这一章读取失败：${problem.message}`); }
  }
  async function load(agentId, index, place) {
    const mine = ++ticket;
    state = { ...state, agentId, index, chapter: 0, info: null, format: null };
    status('正在打开原书…'); toc.hidden = true; pager.hidden = true; rail.reveal(); setDialogClass();
    try {
      const info = await api(`/api/books/${encodeURIComponent(agentId)}/${index}`);
      if (mine !== ticket) return;
      state.info = info; state.format = info.format; fillFiles(info);
      if (info.format === 'pdf') {
        rail.reveal(); setDialogClass();
        head(`原书 · PDF`, info.label);
        const frame = el(doc, 'iframe', undefined, 'book-reader-pdf'); frame.setAttribute('src', info.pdf); frame.setAttribute('title', `${info.label}（PDF）`);
        body.replaceChildren(frame); save(); return;
      }
      setDialogClass();
      if (info.unsupported) { head(`原书 · ${formatName[info.format] || info.format}`, info.label); status('这个格式不能在软件里阅读，请用系统程序打开，或在右上角换一个版本。'); return; }
      pager.hidden = false; fillToc(info); setToc(tocCollapsed);
      await go(Math.min(place?.chapter || 0, info.chapters.length - 1), place?.ratio || 0);
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
    dispose() { if (dialog.open) controller.close(); clearTimer(saveTimer); clearTimer(beatTimer); host.remove(); },
  };
}
