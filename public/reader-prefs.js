// 排版设置 (2026-11-16): one set of reading preferences for both reading modes, the original-book reader
// (#book-reader, public/book-reader.js) and the shelf's lecture / Word report reader (#concept-reader, layouts/shelf.js).
// Each reader gets an 「Aa 排版」 button and panel; a change applies at once to every reader (CSS variables
// --reader-font-size, --reader-line-height, --reader-measure and the data-reader-theme attribute, set through CSSOM)
// and is saved in settings.json as `reader`. The server validates with the same rules (src/settings.mjs imports them).
export const READER_PREFS = Object.freeze({
  fontSize: Object.freeze({ min: 16, max: 26, step: 1, default: 19 }),
  lineHeight: Object.freeze({ min: 160, max: 240, step: 5, default: 205 }),
  measure: Object.freeze({ options: Object.freeze(['narrow', 'medium', 'wide']), default: 'medium' }),
  theme: Object.freeze({ options: Object.freeze(['paper', 'gray', 'night']), default: 'paper' }),
});
// The width of the text column, in characters of the body text (30 / 36 / 42).
export const READER_MEASURE = Object.freeze({ narrow: 30, medium: 36, wide: 42 });
export const defaultReaderPrefs = () => ({ fontSize: READER_PREFS.fontSize.default, lineHeight: READER_PREFS.lineHeight.default,
  measure: READER_PREFS.measure.default, theme: READER_PREFS.theme.default });
const inRange = ({ min, max, step }) => value => Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0;
const validField = {
  fontSize: inRange(READER_PREFS.fontSize), lineHeight: inRange(READER_PREFS.lineHeight),
  measure: value => READER_PREFS.measure.options.includes(value), theme: value => READER_PREFS.theme.options.includes(value),
};
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// A stored value: each missing or invalid field falls back to its default on its own.
export function normalizeReaderPrefs(value) {
  const prefs = defaultReaderPrefs();
  if (plainObject(value)) for (const key of Object.keys(prefs)) if (validField[key](value[key])) prefs[key] = value[key];
  return prefs;
}
// A value sent to be saved: only known fields, each valid; with partial, fields may be left out.
export function validReaderPrefs(value, { partial = false } = {}) {
  if (!plainObject(value)) return false;
  if (Object.keys(value).some(key => !Object.hasOwn(validField, key) || !validField[key](value[key]))) return false;
  return partial || Object.keys(validField).every(key => Object.hasOwn(value, key));
}

const MEASURE_NAMES = { narrow: '窄', medium: '中', wide: '宽' };
const THEME_NAMES = { paper: '米黄', gray: '灰', night: '夜间' };
const stores = new WeakMap();
function store(doc) {
  let state = stores.get(doc);
  if (!state) {
    state = { prefs: defaultReaderPrefs(), saved: defaultReaderPrefs(), dialogs: new Set(), panels: new Set(), api: null, loading: null, saving: null, dirty: false, touched: false };
    stores.set(doc, state);
  }
  return state;
}
function applyTo(dialog, prefs) {
  dialog.style?.setProperty?.('--reader-font-size', `${prefs.fontSize}px`);
  dialog.style?.setProperty?.('--reader-line-height', String(prefs.lineHeight / 100));
  dialog.style?.setProperty?.('--reader-measure', String(READER_MEASURE[prefs.measure]));
  dialog.setAttribute('data-reader-theme', prefs.theme);
}
function applyAll(doc) {
  const state = store(doc);
  for (const dialog of state.dialogs) {
    // A reader of a layout that was switched away from is gone from the page.
    if (dialog.isConnected === false) { state.dialogs.delete(dialog); continue; }
    applyTo(dialog, state.prefs);
  }
  for (const panel of state.panels) panel.refresh();
}
// The saved preferences are read once; book-reader.js passes its api (the shelf has none of its own).
export function configureReaderPrefs(doc, { api }) {
  const state = store(doc);
  state.api = api;
  state.loading ??= (async () => {
    try {
      const value = await api('/api/settings');
      if (!state.touched && plainObject(value?.reader)) { state.prefs = normalizeReaderPrefs(value.reader); state.saved = { ...state.prefs }; applyAll(doc); }
    } catch { /* the defaults stay */ }
  })();
  return state.loading;
}
// For tests and callers that wait for the last save.
export function readerPrefsState(doc) {
  const state = store(doc);
  return { prefs: { ...state.prefs }, saved: { ...state.saved }, idle: () => state.saving || Promise.resolve() };
}
function setStatus(doc, text) { for (const panel of store(doc).panels) panel.status(text); }
// Rapid clicks are merged: while one save is under way, only the newest value is sent after it; a failed save puts the
// last saved value back and says so.
function save(doc) {
  const state = store(doc);
  state.dirty = true;
  if (state.saving) return state.saving;
  state.saving = (async () => {
    while (state.dirty) {
      state.dirty = false;
      const sending = { ...state.prefs };
      try {
        if (!state.api) throw new Error('排版设置无法保存');
        const value = await state.api('/api/settings', { reader: sending }, 'PUT');
        state.saved = plainObject(value?.reader) ? normalizeReaderPrefs(value.reader) : sending;
        if (!state.dirty) setStatus(doc, '');
      } catch (problem) {
        if (!state.dirty) {
          state.prefs = { ...state.saved }; applyAll(doc);
          setStatus(doc, `排版设置保存失败，已恢复原设置：${problem.message}`);
        }
      }
    }
  })().finally(() => { state.saving = null; });
  return state.saving;
}
function change(doc, next) {
  const state = store(doc);
  const prefs = normalizeReaderPrefs({ ...state.prefs, ...next });
  if (Object.keys(prefs).every(key => prefs[key] === state.prefs[key])) return state.saving || Promise.resolve();
  state.prefs = prefs; state.touched = true; applyAll(doc);
  return save(doc);
}

// The 「Aa 排版」 button and its panel for one reader dialog. The caller places `element` (after the exit button);
// Esc closes the open panel first and leaves the book open.
export function mountReaderPrefs(doc, dialog, { idPrefix }) {
  const state = store(doc);
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, run, label, className) => {
    const node = el('button', text, className); node.setAttribute('type', 'button');
    if (label) node.setAttribute('aria-label', label);
    // Not awaited: a save runs on in the background (readerPrefsState(doc).idle() waits for it).
    node.addEventListener('click', event => { if (!node.disabled) run(event); });
    return node;
  };
  const wrap = el('div', undefined, 'reader-prefs');
  const panel = el('div', undefined, 'reader-prefs-panel'); panel.id = `${idPrefix}-prefs`;
  panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '排版设置'); panel.hidden = true;
  const toggle = button('', () => setOpen(panel.hidden), '排版设置', 'reader-prefs-toggle'); toggle.id = `${idPrefix}-prefs-toggle`;
  toggle.append(el('span', 'Aa', 'reader-prefs-glyph'), el('span', ' 排版', 'reader-prefs-label'));
  toggle.setAttribute('aria-controls', panel.id); toggle.setAttribute('aria-expanded', 'false'); toggle.title = '排版：字号、行距、版心、配色';
  const step = (key, delta) => change(doc, { [key]: state.prefs[key] + delta * READER_PREFS[key].step });
  const row = (label, ...controls) => { const line = el('div', undefined, 'reader-prefs-row'); line.append(el('span', label, 'reader-prefs-name'), ...controls); return line; };
  const fontDown = button('A−', () => step('fontSize', -1), '字号减小', 'reader-prefs-step'), fontUp = button('A＋', () => step('fontSize', 1), '字号增大', 'reader-prefs-step');
  const fontValue = el('output', '', 'reader-prefs-value'); fontValue.id = `${idPrefix}-prefs-font`;
  const lineDown = button('−', () => step('lineHeight', -1), '行距减小', 'reader-prefs-step'), lineUp = button('＋', () => step('lineHeight', 1), '行距增大', 'reader-prefs-step');
  const lineValue = el('output', '', 'reader-prefs-value'); lineValue.id = `${idPrefix}-prefs-line`;
  const choices = (key, names, label) => {
    const group = el('div', undefined, 'reader-prefs-choices'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    const items = READER_PREFS[key].options.map(value => {
      const item = button(names[value], () => change(doc, { [key]: value }), undefined, 'reader-prefs-choice');
      item.setAttribute('data-value', value); if (key === 'theme') item.setAttribute('data-theme', value); return item;
    });
    group.append(...items); return { group, items };
  };
  const measure = choices('measure', MEASURE_NAMES, '版心宽度'), theme = choices('theme', THEME_NAMES, '配色');
  const reset = button('恢复默认', () => change(doc, defaultReaderPrefs()), undefined, 'reader-prefs-reset');
  const status = el('p', '', 'reader-prefs-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  panel.append(row('字号', fontDown, fontValue, fontUp), row('行距', lineDown, lineValue, lineUp), row('版心', measure.group), row('配色', theme.group), reset, status);
  wrap.append(toggle, panel);

  function refresh() {
    const { fontSize, lineHeight } = state.prefs, limits = READER_PREFS;
    fontValue.textContent = `${fontSize}`; lineValue.textContent = (lineHeight / 100).toFixed(2);
    fontDown.disabled = fontSize <= limits.fontSize.min; fontUp.disabled = fontSize >= limits.fontSize.max;
    lineDown.disabled = lineHeight <= limits.lineHeight.min; lineUp.disabled = lineHeight >= limits.lineHeight.max;
    for (const [key, list] of [['measure', measure.items], ['theme', theme.items]])
      for (const item of list) item.setAttribute('aria-pressed', String(item.getAttribute('data-value') === state.prefs[key]));
  }
  function setOpen(open) {
    panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    wrap.className = 'reader-prefs' + (open ? ' is-open' : '');
  }
  function close(focusToggle = false) { if (panel.hidden) return false; setOpen(false); if (focusToggle) toggle.focus?.(); return true; }
  // Esc inside the panel (or anywhere in the reader while it is open) closes the panel, not the book: the capture
  // listener on the dialog runs before the dialog's own Escape handler (public/accessibility.js).
  const escape = event => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault?.(); event.stopImmediatePropagation?.(); event.stopPropagation?.();
    close(true);
  };
  wrap.addEventListener('keydown', escape);
  dialog.addEventListener('keydown', escape, true);
  // A press elsewhere in the reader closes the panel.
  dialog.addEventListener('pointerdown', event => { if (!panel.hidden && !wrap.contains?.(event.target)) close(); });
  dialog.addEventListener('close', () => close());
  state.panels.add({ refresh, status: text => { status.textContent = text; } });
  state.dialogs.add(dialog);
  applyTo(dialog, state.prefs); refresh();
  return { element: wrap, toggle, panel, close, get open() { return !panel.hidden; } };
}
