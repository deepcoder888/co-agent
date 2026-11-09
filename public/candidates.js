import { manageDialog } from './accessibility.js';
import { node, region, action } from './layouts/shared.js';

const fields = { title: '书名', author: '作者', edition: '版本', primary: '分类' };
export function mountCandidates(doc, { api, getRegistry, onChanged, notify, getSkin = () => '' }) {
  const dialog = node(doc, 'dialog', undefined, 'candidate-dialog builder-dialog'); dialog.id = 'candidate-dialog';
  const title = node(doc, 'h2', '确认新书籍 Agent'); title.id = 'candidate-title';
  const button = (id, text, fn, cls) => { const b = action(doc, text, fn); b.id = id; b.className = cls; return b; };
  const close = button('candidate-close', '关闭', () => controller.close(), 'quiet');
  const status = node(doc, 'p', '', 'candidate-status'); status.id = 'candidate-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = node(doc, 'div', undefined, 'candidate-list');
  const suggest = button('candidate-suggest', '重新建议', () => requestSuggestions(), 'secondary');
  const accept = button('candidate-accept', '加入选中的 0 个', () => submit('accept'), 'primary');
  const ignore = button('candidate-ignore', '忽略选中', () => submit('ignore'), 'secondary');
  const footerClose = button('candidate-footer-close', '关闭', () => controller.close(), 'quiet');
  dialog.append(region(doc, 'div', 'drawer-heading', title, close),
    node(doc, 'p', '核对书名、作者和版本，再选择分类。只有确认加入后才会出现在书目中。', 'candidate-intro'),
    region(doc, 'div', 'candidate-tools', suggest, status), list, region(doc, 'footer', 'candidate-actions', accept, ignore, footerClose));
  doc.body.append(dialog);
  const controller = manageDialog(doc, dialog, { labelledby: title.id, initialFocus: close });
  const rows = new Map(); let suggesting = false, busy = false, disposed = false, epoch = 0;
  const selected = () => [...rows.values()].filter(row => row.check.checked);
  const valid = row => Object.keys(fields).every(key => {
    const value = row.inputs[key].value;
    return key === 'primary' ? getRegistry().categories.includes(value) : !!value.trim() && Array.from(value).length <= 300;
  });
  function controls() {
    const count = selected().length;
    accept.textContent = `加入选中的 ${count} 个`; accept.setAttribute('aria-label', accept.textContent);
    accept.disabled = busy || !count || count > 50 || !selected().every(valid);
    ignore.disabled = busy || !count || count > 50; suggest.disabled = busy || suggesting || !rows.size;
    for (const row of rows.values()) { row.check.disabled = busy; for (const input of Object.values(row.inputs)) input.disabled = busy; }
  }
  function makeRow(candidate) {
    const check = node(doc, 'input'); check.type = 'checkbox'; check.setAttribute('type', 'checkbox'); check.checked = true;
    check.setAttribute('aria-label', `选择 ${candidate.name}`); check.addEventListener('change', controls);
    const heading = region(doc, 'label', 'candidate-name', check, node(doc, 'strong', candidate.name));
    const inputs = {}, dirty = new Set(), form = region(doc, 'div', 'candidate-fields');
    for (const [key, label] of Object.entries(fields)) {
      const input = node(doc, key === 'primary' ? 'select' : 'input'); input.setAttribute('data-field', key); input.setAttribute('aria-label', `${candidate.name} ${label}`);
      if (key === 'primary') for (const category of getRegistry().categories) { const option = node(doc, 'option', category); option.value = category; input.append(option); }
      else { input.type = 'text'; input.setAttribute('maxlength', '300'); input.setAttribute('placeholder', label === '书名' ? '《中文书名》或 *English Title*' : `填写${label}`); }
      input.value = ''; input.required = true;
      input.addEventListener(key === 'primary' ? 'change' : 'input', () => { dirty.add(key); controls(); });
      inputs[key] = input; form.append(region(doc, 'label', 'candidate-field', node(doc, 'span', label), input));
    }
    const details = region(doc, 'details', 'candidate-description', node(doc, 'summary', '查看描述摘要'), node(doc, 'p', candidate.description || '描述未载明'));
    const source = node(doc, 'p', `原书文件 ${candidate.bookFiles?.length || 0} 个 · ${candidate.hasReadingMd ? 'Reading md 已找到，可尝试创建 Claude 链接' : '没有 Reading md，加入后仅有 Codex 入口'}`, 'candidate-source');
    const element = region(doc, 'section', 'candidate-row', heading, form, details, source); element.setAttribute('data-candidate-id', candidate.id);
    return { id: candidate.id, element, check, inputs, dirty, attempted: false };
  }
  function refresh() {
    if (disposed) return;
    const candidates = getRegistry()?.candidates || [], ids = new Set(candidates.map(c => c.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
    for (const candidate of candidates) if (!rows.has(candidate.id)) { const row = makeRow(candidate); rows.set(candidate.id, row); list.append(row.element); }
    if (!candidates.length) status.textContent = '目前没有待确认的新书籍 Agent。';
    controls();
  }
  async function requestSuggestions(onlyNew = false) {
    if (suggesting || busy || disposed) return;
    const targets = [...rows.values()].filter(row => !onlyNew || !row.attempted); if (!targets.length) return;
    const version = epoch; suggesting = true; targets.forEach(row => { row.attempted = true; });
    status.textContent = 'AI 正在建议书名与分类…'; controls();
    try {
      const results = await api('/api/candidates/suggest', { ids: targets.map(row => row.id) });
      if (disposed || epoch !== version) return;
      if (!Array.isArray(results)) throw new Error('建议响应无效');
      for (const item of results) {
        const row = rows.get(item.id); if (!row || !targets.includes(row)) continue;
        row.blurb = typeof item.blurb === 'string' ? item.blurb : '';
        for (const key of Object.keys(fields)) if (!row.dirty.has(key) && typeof item[key] === 'string') row.inputs[key].value = item[key];
      }
      status.textContent = '建议已填入，请核对后加入。已修改的字段保持不变。';
    } catch (error) { if (!disposed && epoch === version) status.textContent = `AI 建议失败：${error.message}。请手动填写，也可重新建议。`; }
    finally { suggesting = false; if (!disposed) controls(); }
  }
  async function submit(kind) {
    if (busy || disposed || (kind === 'accept' ? accept.disabled : ignore.disabled)) return;
    const targets = selected(); busy = true; epoch++; controls();
    try {
      const body = kind === 'accept' ? { items: targets.map(row => ({ id: row.id, ...Object.fromEntries(Object.keys(fields).map(key => [key, row.inputs[key].value.trim()])), ...(row.blurb ? { blurb: row.blurb } : {}) })) } : { ids: targets.map(row => row.id) };
      const result = await api('/api/candidates/' + kind, body);
      if (disposed) return;
      let message = `已忽略 ${targets.length} 个候选，可在设置的「目录」中撤销。`;
      if (kind === 'accept') {
        const count = state => result.items.filter(item => item.link === state).length;
        const errors = result.items.filter(item => item.link === 'failed').map(item => `${item.id}：${item.linkError || '原因未载明'}`).join('；');
        message = `已加入 ${result.items.length} 个书籍 Agent；Claude 链接：新建 ${count('created')}，已存在 ${count('exists')}，无源文件 ${count('no-source')}，失败 ${count('failed')}${errors ? `（${errors}）` : ''}`;
      }
      controller.close(); notify(message); await onChanged(); if (!disposed) refresh();
    } catch (error) { if (!disposed) status.textContent = `操作失败：${error.message}`; }
    finally { busy = false; if (!disposed) controls(); }
  }
  // The manual specifies undo in Settings without naming routes. Keep it local
  // to the directory section, with a read-only list and authenticated POST undo.
  const ignored = region(doc, 'details', 'candidate-ignored', node(doc, 'summary', '已忽略的新书籍 Agent'));
  ignored.id = 'candidate-ignored';
  const ignoredStatus = node(doc, 'p'); ignoredStatus.setAttribute('role', 'status');
  const ignoredList = node(doc, 'ul'); ignored.append(ignoredStatus, ignoredList);
  doc.getElementById('refresh')?.closest('section')?.append(ignored);
  ignored.addEventListener('toggle', () => { if (ignored.open) return loadIgnored(); });
  let ignoredBusy = false;
  async function loadIgnored() {
    if (disposed) return;
    try {
      const value = await api('/api/candidates/ignored'); if (disposed) return;
      const ids = value.ids || []; ignoredStatus.textContent = ids.length ? `已忽略 ${ids.length} 个` : '没有已忽略的候选。'; ignoredList.replaceChildren();
      for (const id of ids) {
        const undo = action(doc, '撤销忽略', async () => {
          if (ignoredBusy || disposed) return; ignoredBusy = true; undo.disabled = true;
          try { await api('/api/candidates/unignore', { ids: [id] }); if (!disposed) { await onChanged(); await loadIgnored(); notify(`已撤销忽略 ${id}`); } }
          catch (error) { if (!disposed) ignoredStatus.textContent = `撤销失败：${error.message}`; }
          finally { ignoredBusy = false; undo.disabled = false; }
        }, `撤销忽略 ${id}`); undo.className = 'quiet';
        ignoredList.append(region(doc, 'li', '', node(doc, 'span', id), undo));
      }
    } catch (error) { if (!disposed) ignoredStatus.textContent = `忽略名单读取失败：${error.message}`; }
  }
  return {
    async open(trigger) { if (disposed) return; refresh(); dialog.className = ['candidate-dialog', 'builder-dialog', getSkin()].filter(Boolean).join(' '); if (!dialog.open) controller.open(trigger); await requestSuggestions(true); },
    close: controller.close, refresh, loadIgnored,
    dispose() { disposed = true; epoch++; if (dialog.open) controller.close(); dialog.remove(); ignored.remove(); },
  };
}
