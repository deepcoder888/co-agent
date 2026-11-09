// v0.50 基本配置: name, Codex model, terminal and folders, saved to config.json and applied after a restart. On a
// first start (no config.json yet) the settings dialog opens here so the user confirms them before anything runs.
const NULLABLE = new Set(['codexModel', 'codexEffort', 'codexProfile', 'catalogDir', 'readingAgentsDir', 'concept.thinkDir', 'seminar.thinkDir', 'backup.codeDir']);
const PROGRAMS = ['claude', 'codex', 'pwsh', 'wt', 'git'];

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
    for (const hint of section.querySelectorAll('[data-config-missing]')) hint.hidden = paths[hint.getAttribute('data-config-missing')]?.exists !== false;
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
        fields[0]?.focus();
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
