// v0.52 Agent 管理 (2026-11-08): list the agents already on this computer as tools or books, manage the book
// categories, and import agent files when this computer allows it. What is listed here is saved in the data dir;
// entries from the catalog folder are shown in counts but cannot be removed here.
import { manageDialog } from './accessibility.js';
import { node, region, action } from './layouts/shared.js';

const label = (doc, text, control) => { const el = node(doc, 'label', undefined, 'agent-manager-field'); el.append(node(doc, 'span', text), control); return el; };
function input(doc, name, max) {
  const el = node(doc, 'input'); el.type = 'text'; el.setAttribute('autocomplete', 'off');
  if (max) el.setAttribute('maxlength', String(max)); if (name) el.setAttribute('data-field', name); return el;
}

export function mountAgentManager(doc, { api, onChanged = async () => {}, notify = () => {}, getSkin = () => '' }) {
  const dialog = node(doc, 'dialog', undefined, 'agent-manager-dialog builder-dialog'); dialog.id = 'agent-manager-dialog';
  const title = node(doc, 'h2', 'Agent 管理'); title.id = 'agent-manager-title';
  const close = action(doc, '关闭', () => controller.close(), '关闭 Agent 管理'); close.id = 'agent-manager-close'; close.className = 'quiet';
  const status = node(doc, 'p', '', 'agent-manager-status'); status.id = 'agent-manager-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const categories = node(doc, 'ul', undefined, 'agent-manager-list'); categories.id = 'agent-manager-categories';
  const categoryName = input(doc, null, 20); categoryName.id = 'agent-manager-category'; categoryName.setAttribute('aria-label', '新分类名');
  const addCategory = action(doc, '添加分类', () => change({ op: 'addCategory', name: categoryName.value.trim() }).then(ok => { if (ok) categoryName.value = ''; }));
  addCategory.id = 'agent-manager-add-category';
  const unlisted = node(doc, 'ul', undefined, 'agent-manager-list'); unlisted.id = 'agent-manager-unlisted';
  const noCategory = node(doc, 'p', '先添加分类，才能把 Agent 设为书籍。', 'agent-manager-note'); noCategory.id = 'agent-manager-no-category';
  const added = node(doc, 'ul', undefined, 'agent-manager-list'); added.id = 'agent-manager-added';
  const file = node(doc, 'input'); file.type = 'file'; file.id = 'agent-manager-file';
  file.setAttribute('accept', '.toml,.md'); file.setAttribute('multiple', ''); file.setAttribute('aria-label', '选择 Agent 文件');
  const importing = region(doc, 'section', 'agent-manager-section', node(doc, 'h3', '导入 Agent 文件'),
    node(doc, 'p', '选择 .toml（Codex 版）或 .md（Claude 版）Agent 文件。只新建，已有同名文件或同名 Agent 时不会覆盖。导入后出现在「未登记的 Agent」里。', 'agent-manager-note'), file);
  importing.id = 'agent-manager-import';
  // v0.53 制作书籍 Agent: a-deepbooker turns one book file into a book Agent in a terminal session.
  const bookFile = input(doc, null, 400); bookFile.id = 'agent-manager-book-file';
  bookFile.setAttribute('placeholder', '书籍文件的完整路径（PDF、EPUB、MOBI 或 AZW3）');
  const bookNote = input(doc, null, 300); bookNote.id = 'agent-manager-book-note'; bookNote.setAttribute('placeholder', '例如：跳过书评和推荐语');
  const bookCli = node(doc, 'select'); bookCli.id = 'agent-manager-book-cli';
  const bookConfirm = node(doc, 'input'); bookConfirm.type = 'checkbox'; bookConfirm.id = 'agent-manager-book-confirm';
  const confirmLabel = node(doc, 'label', undefined, 'agent-manager-check'); confirmLabel.append(bookConfirm, node(doc, 'span', 'a-deepbooker 会在电脑上新建 Agent 文件、知识包和报告，我已了解'));
  const bookStart = action(doc, '在终端里开始制作', () => makeBook()); bookStart.id = 'agent-manager-book-start'; bookStart.className = 'primary';
  const makerMissing = node(doc, 'p', '这台电脑上还没有 a-deepbooker。先在下面「导入 Agent 文件」里导入它的 Agent 文件。', 'agent-manager-note'); makerMissing.id = 'agent-manager-maker-missing';
  const makerForm = region(doc, 'div', 'agent-manager-form', label(doc, '书籍文件', bookFile), label(doc, '补充要求（可选）', bookNote),
    label(doc, '引擎', bookCli), confirmLabel, region(doc, 'div', 'agent-manager-row', bookStart));
  const making = region(doc, 'section', 'agent-manager-section', node(doc, 'h3', '制作书籍 Agent'),
    node(doc, 'p', '用 a-deepbooker 把一本书做成书籍 Agent，同时生成完整的 Deepbooker 报告。它会在终端里打开一个会话，通常要几个小时，过程中需要你在终端里确认它的操作。做好后点「刷新目录」，新书会出现在「确认新书籍 Agent」或下面的「未登记的 Agent」里。', 'agent-manager-note'),
    makerMissing, makerForm);
  making.id = 'agent-manager-making';
  dialog.append(region(doc, 'div', 'drawer-heading', title, close),
    node(doc, 'p', '把电脑上已有的 Agent 登记为工具 Agent 或书籍 Agent。这里的改动保存在数据目录里；来自清单文件夹的条目在这里只读。', 'agent-manager-intro'),
    status,
    making,
    region(doc, 'section', 'agent-manager-section', node(doc, 'h3', '分类'), categories, region(doc, 'div', 'agent-manager-row', categoryName, addCategory)),
    region(doc, 'section', 'agent-manager-section', node(doc, 'h3', '未登记的 Agent'), noCategory, unlisted),
    region(doc, 'section', 'agent-manager-section', node(doc, 'h3', '在软件里登记的'), added),
    importing);
  doc.body.append(dialog);
  const controller = manageDialog(doc, dialog, { labelledby: title.id, initialFocus: close });
  let lists = { allowImport: false, categories: [], roles: [], books: [], unlisted: [] }, busy = false, disposed = false;

  const makerReady = () => !!lists.bookMaker && !!bookFile.value.trim() && bookConfirm.checked === true && !busy;
  const makerControls = () => { bookStart.disabled = !makerReady(); };
  async function makeBook() {
    if (!makerReady() || disposed) return;
    busy = true; makerControls(); status.textContent = '正在打开 a-deepbooker…';
    try {
      const result = await api('/api/book-maker', { file: bookFile.value.trim(), note: bookNote.value.trim(), cli: bookCli.value, writableConfirmed: true });
      if (disposed) return;
      const name = bookFile.value.trim().split(/[\\/]/).pop();
      status.textContent = `已在终端里打开 ${result.agentName}（${result.cli === 'codex' ? 'Codex' : 'Claude'}），开始制作「${name}」。`;
      notify(status.textContent); bookFile.value = ''; bookNote.value = ''; bookConfirm.checked = false;
    } catch (error) { if (!disposed) status.textContent = `启动失败：${error.message}`; }
    finally { busy = false; if (!disposed) makerControls(); }
  }
  for (const control of [bookFile, bookConfirm]) { control.addEventListener('input', makerControls); control.addEventListener('change', makerControls); }
  async function change(body) {
    if (busy || disposed) return false;
    busy = true; status.textContent = '正在保存…';
    try {
      const result = await api('/api/agent-lists', body); if (disposed) return false;
      lists = result; render(); status.textContent = result.message; notify(result.message); await onChanged();
      return true;
    } catch (error) { if (!disposed) status.textContent = `保存失败：${error.message}`; return false; }
    finally { busy = false; }
  }
  function form(row, fields, submit) {
    const save = action(doc, '保存', () => submit()), cancel = action(doc, '取消', () => render());
    save.className = 'primary'; cancel.className = 'quiet';
    row.querySelector('.agent-manager-actions')?.remove();
    row.append(region(doc, 'div', 'agent-manager-form', ...fields, region(doc, 'div', 'agent-manager-row', save, cancel)));
    fields[0]?.querySelector?.('input,select')?.focus();
  }
  function unlistedRow(agent) {
    const row = node(doc, 'li', undefined, 'agent-manager-item');
    const head = region(doc, 'div', 'agent-manager-head', node(doc, 'strong', agent.name), node(doc, 'small', agent.platforms.map(p => p === 'codex' ? 'Codex' : 'Claude').join(' · ')));
    const asTool = action(doc, '设为工具', () => {
      const purpose = input(doc, 'purpose', 40); purpose.setAttribute('aria-label', `${agent.name} 的用途`);
      form(row, [label(doc, '用途（一句话，最多 40 字）', purpose)], () => change({ op: 'addRole', id: agent.id, purpose: purpose.value.trim() }));
    }, `把 ${agent.name} 设为工具 Agent`);
    const asBook = action(doc, '设为书籍', () => {
      const [bookTitle, author, edition] = ['title', 'author', 'edition'].map(name => input(doc, name, 300));
      const primary = node(doc, 'select'); primary.setAttribute('data-field', 'primary');
      primary.append(...lists.categories.map(c => { const option = node(doc, 'option', c.name); option.value = c.name; return option; }));
      primary.value = lists.categories[0]?.name || '';
      form(row, [label(doc, '书名', bookTitle), label(doc, '作者', author), label(doc, '版本', edition), label(doc, '分类', primary)],
        () => change({ op: 'addBook', id: agent.id, title: bookTitle.value.trim(), author: author.value.trim(), edition: edition.value.trim(), primary: primary.value }));
    }, `把 ${agent.name} 设为书籍 Agent`);
    asBook.disabled = !lists.categories.length;
    row.append(...[head, agent.description && node(doc, 'p', agent.description, 'agent-manager-description'), region(doc, 'div', 'agent-manager-actions', asTool, asBook)].filter(Boolean));
    return row;
  }
  function render() {
    categories.replaceChildren(...lists.categories.map(c => {
      const row = region(doc, 'li', 'agent-manager-item agent-manager-category', node(doc, 'span', c.name), node(doc, 'small', `${c.books} 本${c.source === 'catalog' ? ' · 清单文件' : ''}`));
      if (c.source === 'app' && !c.books) {
        const remove = action(doc, '删除', () => change({ op: 'removeCategory', name: c.name }), `删除分类 ${c.name}`); remove.className = 'quiet'; row.append(remove);
      }
      return row;
    }));
    if (!lists.categories.length) categories.replaceChildren(node(doc, 'li', '还没有分类。', 'agent-manager-empty'));
    noCategory.hidden = !!lists.categories.length || !lists.unlisted.length;
    unlisted.replaceChildren(...(lists.unlisted.length ? lists.unlisted.map(unlistedRow) : [node(doc, 'li', '没有未登记的 Agent。', 'agent-manager-empty')]));
    const mine = [...lists.roles.filter(r => r.source === 'app').map(r => ({ ...r, kind: 'role', text: `工具 Agent · ${r.purpose || ''}` })),
      ...lists.books.filter(b => b.source === 'app').map(b => ({ ...b, kind: 'book', text: `书籍 Agent · ${b.title} · ${b.primary}` }))];
    added.replaceChildren(...(mine.length ? mine.map(entry => {
      const remove = action(doc, '移出', () => change({ op: entry.kind === 'role' ? 'removeRole' : 'removeBook', id: entry.id }), `移出 ${entry.name}`);
      remove.className = 'quiet';
      return region(doc, 'li', 'agent-manager-item', region(doc, 'div', 'agent-manager-head', node(doc, 'strong', entry.name), node(doc, 'small', entry.text)), remove);
    }) : [node(doc, 'li', '还没有在软件里登记的 Agent。', 'agent-manager-empty')]));
    importing.hidden = !lists.allowImport;
    const maker = lists.bookMaker;
    makerMissing.hidden = !!maker; makerForm.hidden = !maker;
    makerMissing.textContent = lists.allowImport ? '这台电脑上还没有 a-deepbooker。先在下面「导入 Agent 文件」里导入它的 Agent 文件。'
      : '这台电脑上还没有 a-deepbooker。先在 设置 → 基本配置 里允许导入 Agent 文件，再在这里导入它。';
    if (maker) {
      const chosen = bookCli.value;
      bookCli.replaceChildren(...maker.platforms.map(p => { const option = node(doc, 'option', p === 'codex' ? 'Codex' : 'Claude'); option.value = p; return option; }));
      bookCli.value = maker.platforms.includes(chosen) ? chosen : maker.platforms[0] || '';
    }
    makerControls();
  }
  async function load() {
    try { lists = await api('/api/agent-lists'); if (!disposed) render(); }
    catch (error) { if (!disposed) status.textContent = `读取失败：${error.message}`; }
  }
  async function importFiles() {
    const files = Array.from(file.files || []);
    if (!files.length || busy || disposed) return;
    busy = true; status.textContent = '正在导入…';
    const lines = [];
    for (const one of files) {
      try {
        const result = await api('/api/agent-files', { fileName: one.name, content: await one.text() });
        lines.push(result.listed ? `已导入 ${result.name}（${result.kind === 'codex' ? 'Codex' : 'Claude'} 版）`
          : `已导入 ${result.name} 的 Claude 版；CO-AGENT 以 Codex 版为准，同名 Codex 版导入后才会出现在目录里`);
      } catch (error) { lines.push(`${one.name}：${error.message}`); }
    }
    busy = false; file.value = '';
    if (disposed) return;
    await onChanged(); await load();
    status.textContent = lines.join('；');
  }
  file.addEventListener('change', importFiles);
  return {
    async open(trigger) {
      if (disposed) return;
      dialog.className = ['agent-manager-dialog', 'builder-dialog', getSkin()].filter(Boolean).join(' ');
      status.textContent = '';
      await load();
      if (!dialog.open) controller.open(trigger);
    },
    close: controller.close, load, change, importFiles,
    dispose() { disposed = true; file.removeEventListener('change', importFiles); if (dialog.open) controller.close(); dialog.remove(); },
  };
}
