import { manageDialog } from './accessibility.js';

const options = [
  ['threepane', '三栏', '邮件客户端', '分类、列表、详情并排，一屏看全，适合高频调用。'],
  ['bento', '便当格', '仪表盘', '提问、数字、常用与最近调用拼成一页仪表盘。'],
  ['editorial', '杂志', '编排', '衬线刊头、本周焦点与编号目录，适合慢读与挑书。'],
  ['shelf', '书房', '书架', '同事工牌、分类书架与书桌，像在书房里找人聊。'],
];
// Values/structure match docs/design/v0.9/layout-picker.html; all paint lives in CSS.
function thumbnail(make, id) {
  const el = (cls, ...children) => { const n = make('span', undefined, `picker-${cls}`); n.append(...children); return n; };
  const blank = () => make('i');
  if (id === 'threepane') {
    const left = el('tp-left', el('tp-pill'), ...Array.from({length:5}, (_, i) => el(`tp-line${i === 2 ? ' picker-selected-line' : ''}`)));
    const middle = el('tp-middle', el('tp-search'), ...Array.from({length:4}, (_, i) => el(`tp-row${i === 0 ? ' picker-selected-row' : ''}`,
      el(`tp-avatar picker-avatar-${i}`), el('tp-text', blank(), blank()))));
    const right = el('tp-right', el('tp-heading', el('tp-big'), el('tp-heading-text', blank(), blank())), el('tp-chips', blank(), blank(), blank()),
      el('tp-copy', blank(), blank()), el('tp-buttons', blank(), blank()));
    return el('tp', left, middle, right);
  }
  if (id === 'bento') return el('bt', el('bt-ask', blank(), make('b')), el('bt-stat-one', blank()), el('bt-stat-two', blank()),
    el('bt-bars', blank(), blank(), blank()), ...Array.from({length:4}, (_, i) => el(`bt-tile picker-tile-${i}`)));
  if (id === 'editorial') {
    const logo = make('span', 'CO-AGENT', 'picker-ed-logo');
    return el('ed', el('ed-mast', logo, el('ed-nav', ...Array.from({length:5}, blank))), el('ed-body',
      el('ed-lead', blank(), blank(), make('em'), make('em'), make('b')),
      el('ed-list', ...Array.from({length:4}, (_, i) => el('ed-row', make('span', `0${i + 1}`), blank())))));
  }
  return el('sh', make('span', 'CO-AGENT 书房', 'picker-sh-title'), el('sh-staff', ...Array.from({length:5}, blank)),
    el('sh-books', ...Array.from({length:10}, (_, i) => make('i', undefined, `picker-spine-${i}`))), el('sh-plank'));
}

export function mountSettings(doc, fetchImpl, token, onLayout = () => {},
  { bindTrigger = true, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const get = id => doc.getElementById(id), dialog = get('settings-dialog');
  if (!dialog) return;
  const group = get('settings-options'), live = get('settings-status'), cards = [];
  let current = doc.documentElement.getAttribute('data-ui') || 'threepane', saving = -1, disposed = false, timer;
  if (!options.some(option => option[0] === current)) current = 'threepane';
  let focusIndex = options.findIndex(option => option[0] === current);
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', 'settings-style-title');
  group.setAttribute('aria-description', '方向键移动焦点，Enter 应用'); group.replaceChildren();
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true'); live.hidden = true;
  const label = index => `${options[index][1]} · ${options[index][2]}`;
  function sync() {
    for (let i = 0; i < cards.length; i++) {
      const selected = options[i][0] === current, card = cards[i];
      card.radio.setAttribute('aria-checked', String(selected)); card.radio.setAttribute('tabindex', i === focusIndex ? '0' : '-1');
      card.radio.setAttribute('aria-disabled', String(saving !== -1)); card.radio.setAttribute('aria-busy', String(i === saving));
      card.badge.hidden = !selected; card.overlay.hidden = saving !== i;
    }
    group.setAttribute('aria-busy', String(saving !== -1));
  }
  function hideToast() {
    clearTimer(timer);
    // A timed disappearance must not leave keyboard focus in a hidden button.
    if (dialog.open && live.querySelector?.('button') === doc.activeElement) {
      focusIndex = options.findIndex(option => option[0] === current); sync(); cards[focusIndex].radio.focus();
    }
    live.hidden = true;
  }
  function toast(index, previous) {
    live.className = 'picker-toast'; live.hidden = false;
    const undo = node('button', '撤销'); undo.type = 'button';
    undo.addEventListener('click', () => choose(options.findIndex(option => option[0] === previous)));
    live.replaceChildren(node('span', `已切换为「${label(index)}」`), undo);
    timer = setTimer(hideToast, 8000); timer?.unref?.();
  }
  async function apply(next) {
    let applied = false;
    const update = () => { if (disposed || applied) return; applied = true; current = next; doc.documentElement.setAttribute('data-ui', next); onLayout(next); };
    const reduce = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof doc.startViewTransition === 'function' && !reduce) {
      try {
        const transition = doc.startViewTransition(update);
        transition.ready?.catch(() => {}); transition.finished?.catch(() => {});
        await transition.updateCallbackDone;
      } catch { /* Snapshot/animation failure must not roll back a successful save. */ }
    }
    update();
  }
  async function choose(index) {
    if (disposed || saving !== -1 || !options[index] || options[index][0] === current) return;
    const previous = current, next = options[index][0]; hideToast(); saving = index; focusIndex = index;
    cards[index].error.textContent = ''; cards[index].error.hidden = true; sync();
    if (dialog.open) cards[index].radio.focus();
    try {
      const response = await fetchImpl('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify({ ui: next }) });
      const value = await response.json(); if (disposed) return;
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      if (value.ui !== next) throw new Error('保存返回的页面排版不一致');
      await apply(next); if (!disposed) toast(index, previous);
    } catch (error) {
      if (disposed) return;
      cards[index].error.textContent = `保存失败，已保留原排版：${error.message}`; cards[index].error.hidden = false;
      live.className = 'picker-save-error'; live.textContent = cards[index].error.textContent; live.hidden = false;
      if (dialog.open) { focusIndex = options.findIndex(option => option[0] === current); cards[focusIndex].radio.focus(); }
    } finally { saving = -1; if (!disposed) sync(); }
  }
  for (const [index, [id, name, subtitle, description]] of options.entries()) {
    const radio = node('button', undefined, 'theme-option'); radio.type = 'button';
    radio.setAttribute('role', 'radio'); radio.setAttribute('aria-labelledby', `theme-${id}-name`); radio.setAttribute('aria-describedby', `theme-${id}-description theme-${id}-error`);
    const title = node('span', name, 'picker-name'); title.id = `theme-${id}-name`; title.append(node('span', subtitle, 'picker-tag'));
    const meta = node('span', undefined, 'picker-meta'); meta.append(title);
    const detail = node('span', description, 'theme-description'); detail.id = `theme-${id}-description`;
    const preview = node('span', undefined, 'picker-thumb'); preview.setAttribute('data-layout-preview', id); preview.setAttribute('aria-hidden', 'true');
    const badge = node('span', '✓ 当前', 'picker-current'), overlay = node('span', undefined, 'picker-saving');
    const spinner = node('span', undefined, 'picker-spinner'), progress = node('span', undefined, 'picker-progress'); progress.append(spinner, node('span', '正在切换…')); overlay.append(progress);
    preview.append(thumbnail(node, id), badge, overlay);
    const error = node('span', '', 'picker-error'); error.id = `theme-${id}-error`; error.hidden = true;
    radio.append(preview, meta, detail, error);
    radio.addEventListener('click', () => choose(index));
    radio.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) return choose(index); return; }
      const offsets = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 };
      let next;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else if (Object.hasOwn(offsets, event.key)) next = (index + offsets[event.key] + options.length) % options.length;
      else return;
      event.preventDefault(); event.stopPropagation(); focusIndex = next; sync(); cards[next].radio.focus();
    });
    cards.push({radio,badge,overlay,error}); group.append(radio);
  }
  doc.documentElement.setAttribute('data-ui', current); onLayout(current); sync();
  // v0.42 书本描述字号 (2026-11-01): the slider sizes the description beside a pulled-out book while it moves
  // and is saved when let go; a failed save puts the saved size back.
  const bookText = get('settings-book-text'), bookTextValue = get('settings-book-text-value'), bookTextStatus = get('settings-book-text-status');
  let savedBookText = Number(doc.documentElement.getAttribute('data-book-text')) || 100, bookTextWork = Promise.resolve();
  const showBookText = value => {
    doc.documentElement.style?.setProperty?.('--book-text-scale', String(value / 100));
    if (bookTextValue) bookTextValue.textContent = `${value}%`;
  };
  const previewBookText = () => showBookText(Number(bookText.value));
  const saveBookText = () => { bookTextWork = bookTextWork.then(async () => {
    const value = Number(bookText.value); if (disposed || value === savedBookText) return;
    bookTextStatus.textContent = '正在保存…';
    try {
      const response = await fetchImpl('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify({ bookText: value }) });
      const result = await response.json(); if (disposed) return;
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      savedBookText = result.bookText; doc.documentElement.setAttribute('data-book-text', String(savedBookText)); bookTextStatus.textContent = `已保存：${savedBookText}%`;
    } catch (error) {
      if (disposed) return;
      bookText.value = String(savedBookText); showBookText(savedBookText); bookTextStatus.textContent = `保存失败，已恢复原字号：${error.message}`;
    }
  }); return bookTextWork; };
  if (bookText) { bookText.value = String(savedBookText); bookText.addEventListener('input', previewBookText); bookText.addEventListener('change', saveBookText); }
  showBookText(savedBookText);
  // 2026-11-24 微立体: a choice shows at once on the whole page and is then saved; a failed save puts the saved look back.
  const depthStatus = get('settings-depth-status'), depthInputs = Array.from(doc.querySelectorAll?.('input[name="settings-depth"]') || []);
  let savedDepth = doc.documentElement.getAttribute('data-depth') || 'off', depthWork = Promise.resolve();
  const showDepth = value => { doc.documentElement.setAttribute('data-depth', value); for (const input of depthInputs) input.checked = input.value === value; };
  const saveDepth = event => { const value = event.target.value; showDepth(value); depthWork = depthWork.then(async () => {
    if (disposed || value === savedDepth) return;
    if (depthStatus) depthStatus.textContent = '正在保存…';
    try {
      const response = await fetchImpl('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify({ depth: value }) });
      const result = await response.json(); if (disposed) return;
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      savedDepth = result.depth; if (depthStatus) depthStatus.textContent = '已保存';
    } catch (error) {
      if (disposed) return;
      showDepth(savedDepth); if (depthStatus) depthStatus.textContent = `保存失败，已恢复原样式：${error.message}`;
    }
  }); return depthWork; };
  for (const input of depthInputs) input.addEventListener('change', saveDepth);
  showDepth(savedDepth);
  // v0.49 备份 (2026-11-08): the server writes one ZIP and selects it in Explorer; the user moves it to the cloud drive.
  const backupButton = get('settings-backup'), backupStatus = get('settings-backup-status');
  const runBackup = async () => {
    if (disposed || backupButton.disabled) return;
    backupButton.disabled = true; backupStatus.textContent = '正在备份…';
    try {
      const response = await fetchImpl('/api/backup', { method: 'POST', headers: { 'X-Co-Agent-Token': token } });
      const result = await response.json(); if (disposed) return;
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const size = result.size >= 1048576 ? `${(result.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(result.size / 1024))} KB`;
      backupStatus.textContent = `已备份到 ${result.file}（${result.records} 个记录文件，${size}），资源管理器已选中它。` +
        (result.code === 'included' || result.code === 'skipped' ? '' : `${result.code}，这次只有记录。`);
    } catch (error) { if (!disposed) backupStatus.textContent = `备份失败：${error.message}`; }
    finally { if (!disposed) backupButton.disabled = false; }
  };
  backupButton?.addEventListener('click', runBackup);
  const controller = manageDialog(doc, dialog, { labelledby: 'settings-title' });
  const open = trigger => { if (disposed) return; controller.open(trigger); focusIndex = options.findIndex(option => option[0] === current); sync(); cards[focusIndex].radio.focus(); };
  const trigger = bindTrigger ? get('settings-open') : null, openFromEvent = event => open(event.currentTarget), close = () => controller.close();
  trigger?.addEventListener('click', openFromEvent); get('settings-close').addEventListener('click', close);
  return { ...controller, open, dispose() { disposed = true; clearTimer(timer); trigger?.removeEventListener('click', openFromEvent); get('settings-close').removeEventListener('click', close);
    bookText?.removeEventListener('input', previewBookText); bookText?.removeEventListener('change', saveBookText); for (const input of depthInputs) input.removeEventListener('change', saveDepth); backupButton?.removeEventListener('click', runBackup); }, saveBookText, runBackup };
}
