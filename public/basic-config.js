// v0.50 基本配置: name, Codex model, terminal and folders, saved to config.json and applied after a restart. On a
// first start (no config.json yet) the settings dialog opens here so the user confirms them before anything runs.
const NULLABLE = new Set(['codexModel', 'codexEffort', 'codexProfile', 'catalogDir', 'readingAgentsDir', 'concept.thinkDir', 'seminar.thinkDir', 'backup.codeDir']);
const PROGRAMS = ['claude', 'codex', 'pwsh', 'wt', 'git'];
// v0.53: a folder CO-AGENT makes or does not need yet is normal on a new install, not a problem to fix.
const LATER = { 'backup.dir': '还没有，第一次备份时自动创建', catalogDir: '还没有。没有清单也能用：在 Agent 管理里登记的 Agent 保存在数据目录里' };

function nest(entries) {
  const body = {};
  for (const [key, value] of entries) {
    const parts = key.split('.');
    let at = body;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts.at(-1)] = value;
  }
  return body;
}

export function mountBasicConfig(doc, fetchImpl, token, { openSettings = () => {} } = {}) {
  const section = doc.getElementById('settings-basic');
  if (!section) return null;
  const fields = Array.from(section.querySelectorAll('[data-config]')), first = doc.getElementById('settings-basic-first');
  const status = doc.getElementById('settings-basic-status'), env = doc.getElementById('settings-basic-env'), save = doc.getElementById('settings-basic-save');
  let disposed = false;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; };
  function fill({ values = {}, paths = {}, environment = {} }) {
    for (const field of fields) {
      const key = field.getAttribute('data-config'), value = values[key];
      if (field.getAttribute('type') === 'checkbox') field.checked = value === true;
      else field.value = Array.isArray(value) ? value.join('\n') : value ?? '';
    }
    for (const hint of section.querySelectorAll('[data-config-missing]')) {
      const key = hint.getAttribute('data-config-missing'), later = paths[key]?.createdLater === true && LATER[key];
      hint.hidden = paths[key]?.exists !== false;
      hint.textContent = later || '目录不存在'; hint.className = later ? 'settings-basic-later' : 'settings-basic-missing';
    }
    env?.replaceChildren(...PROGRAMS.map(name => node('li', environment[name] ? `${name}：已找到 ${environment[name]}` : `${name}：未找到`,
      environment[name] ? '' : 'settings-basic-absent')));
  }
  function collect() {
    return nest(fields.map(field => {
      const key = field.getAttribute('data-config');
      if (field.getAttribute('type') === 'checkbox') return [key, field.checked === true];
      const text = String(field.value ?? '');
      if (key === 'codexArchiveDirs') return [key, text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)];
      const value = text.trim();
      return [key, !value && NULLABLE.has(key) ? null : value];
    }));
  }
  async function load() {
    try {
      const response = await fetchImpl('/api/config');
      const value = await response.json(); if (disposed || !response.ok) return;
      fill(value);
      if (value.firstRun === true) {
        if (first) first.hidden = false;
        openSettings();
        section.scrollIntoView?.({ block: 'start' });
        // v0.53: the dialog's sticky heading covers the top of the scrolled-to section; scroll back by what it covers.
        const dialog = section.closest?.('dialog'), heading = dialog?.querySelector?.('.drawer-heading');
        if (heading?.getBoundingClientRect && section.getBoundingClientRect) {
          const covered = heading.getBoundingClientRect().bottom - section.getBoundingClientRect().top;
          if (covered > 0) dialog.scrollTop = Math.max(0, (dialog.scrollTop || 0) - covered - 12);
        }
        fields[0]?.focus({ preventScroll: true });
      }
    } catch { /* The rest of the app works without this section. */ }
  }
  async function submit() {
    if (disposed || save.disabled) return;
    save.disabled = true; status.textContent = '正在保存…';
    try {
      const response = await fetchImpl('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Co-Agent-Token': token }, body: JSON.stringify(collect()) });
      const result = await response.json(); if (disposed) return;
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (first) first.hidden = true;
      status.textContent = '已保存，重新启动 CO-AGENT 后生效。';
    } catch (error) { if (!disposed) status.textContent = `保存失败：${error.message}`; }
    finally { if (!disposed) save.disabled = false; }
  }
  save?.addEventListener('click', submit);
  return { load, submit, collect, dispose() { disposed = true; save?.removeEventListener('click', submit); } };
}
