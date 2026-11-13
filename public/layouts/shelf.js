import { markAgentLink, fillAgentNames, openFileButton, runningMembers } from '../agent-links.js';
import { node, action, region, runningCloseHeading, runningCloseRow, updateRunningClose, renderCandidateNotice, pinButton, inAppButton, conceptResponse, conceptResponseNote, renderConceptThread } from './shared.js';
import { renderMarkdown } from '../markdown.js';
import { donut, barList, columns } from '../charts.js';
import { manageDialog } from '../accessibility.js';
import { enter } from '../motion.js';
import { autoHideRail } from '../reader-rail.js';
import * as display from '../display.js';
const { formatDate, summary, bookLabel, spineTitle, authorShort, matchesSearch, conceptStatus, cleanTitle } = display;

export const initialCategory = 'all';
export const jointBuilderSkin = 'shelf-builder';
// The room's shelf order; the joint builder groups its list the same way.
export const categoryOrder = categories => [...new Set(['睡眠／健康／运动','投资／金融与金钱管理', ...categories, '未分类'])];

// Preserve the original room's ordering; remaining agents retain registry order.
const staffOrder = ['ark','jason','steven','jack','albert','peter','loki','alan','ames','ben','monsey'];
// v0.53: the books' default order is the catalog's shelfOrder (registry.display), never a list in the code.
const bookOrder = state => state.display?.shelfOrder || [];
const identity = agent => agent.name.replace(/^-+/, '').toLowerCase();
const ordered = (agents, order) => [...agents].sort((a, b) =>
  (order.indexOf(identity(a)) < 0 ? order.length : order.indexOf(identity(a))) -
  (order.indexOf(identity(b)) < 0 ? order.length : order.indexOf(identity(b))));
const purpose = agent => agent.purpose || summary(agent.description) || '用途未载明';
const titleForSpine = agent => agent.spineTitle || spineTitle(agent) || agent.name;
// S2's helper is optional until the parallel shared-layer change is merged.
// Never fall back to a style attribute: the application's CSP rejects it.
function setStyle(el, props) {
  if (!el.style) return; // The minimal recording DOM used by older tests has no CSSOM.
  if (display.setStyle) display.setStyle(el, props);
  else for (const [key, value] of Object.entries(props)) el.style.setProperty(key, value);
}
const plainDescription = text => String(text || '').replace(/<example\b[^>]*>[\s\S]*?<\/example>/gi, '').trim();
function field(ctx, tag, id, text, cls) {
  const el = node(ctx.doc, tag, text, cls);
  if (id) { el.id = id; ctx.refs[id] = el; }
  return el;
}
// v0.28 D 烫金图标 (2026-10-18; docs/design/v0.28-links): fine gilt line icons beside the room's text links.
const iconPaths = {
  history: ['M2.5 8a5.5 5.5 0 1 0 1.6-3.9', 'M2.5 2.5v2.5H5', 'M8 5v3l2 1.5'],
  stats: ['M2.5 13.5h11', 'M4.5 11V8', 'M8 11V4.5', 'M11.5 11V6.5'],
  group: ['M3.8 5.5a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0', 'M2 13c.4-2.3 2-3.6 4-3.6s3.6 1.3 4 3.6',
    'M9.6 6.3a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0', 'M11 9.6c1.6.1 2.7 1.2 3 3'],
  chevron: ['M6 3.5 10.5 8 6 12.5'],
  // 书房各室 menu (docs/design/v0.39-desk, version 2).
  roundtable: ['M4.8 8a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0-6.4 0', 'M7 2.2a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M12.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M1.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0'],
  consult: ['M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M8 5.5v5', 'M5.5 8h5'],
  chat: ['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z'],
  council: ['M2.5 13.5h11', 'M3 5.5h10L8 2.5z', 'M4.5 6v6', 'M8 6v6', 'M11.5 6v6'],
  map: ['M2.4 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0', 'M10.4 5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0', 'M5.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0', 'M5.5 4.3l5 .5M11 6.3l-3 4.3M6.3 10.5L4.5 5.5'],
};
function icon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'shelf-icon');
  for (const d of iconPaths[name]) { const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
// v0.42 书本检视 glyphs (24×24, white silhouettes like a game's item card): two per book category, an hourglass for the
// reading time and a weight for the weight. A path starting with ~ is drawn as a line, the rest are filled.
const glyphPaths = {
  coins: ['M3 18.5h12V21H3z', 'M4 15h12v2.5H4z', 'M2.5 11.5h12V14h-12z', 'M18 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z'],
  trend: ['M2 18.6 8.3 12.3l3.5 3.5L18.6 9H15V6.8h7.4v7.4h-2.2v-3.6l-8.4 8.4-3.5-3.5-4.9 4.9z'],
  head: ['M10 2.5c-4.3 0-7.5 3.2-7.5 7.4 0 2.6 1.2 4.6 3 5.9v5.7h8.5v-3h2.6c1.3 0 2.2-1 2.2-2.2v-2.6l2-.6c.6-.2.8-.8.5-1.3l-1.8-3C18.8 4.9 15.3 2.5 10 2.5z'],
  bulb: ['M12 2a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.6V17h6v-1.6c0-.6.3-1.2.8-1.6A6.5 6.5 0 0 0 12 2z', 'M9 18.5h6V20H9z', 'M10 21h4v1.5h-4z'],
  moon: ['M15 2.6A9.6 9.6 0 1 0 21.4 17 7.8 7.8 0 0 1 15 2.6z'],
  dumbbell: ['M1.5 10.2h2V8h3v8h-3v-2.2h-2z', 'M22.5 10.2h-2V8h-3v8h3v-2.2h2z', 'M7.5 6.5H10v11H7.5z', 'M14 6.5h2.5v11H14z', 'M10 10.8h4v2.4h-4z'],
  code: ['M8.6 5.4 2 12l6.6 6.6 1.8-1.8L5.6 12l4.8-4.8z', 'M15.4 5.4 13.6 7.2 18.4 12l-4.8 4.8 1.8 1.8L22 12z'],
  gear: ['M19.4 8.96L22.25 9.71L22.25 14.29L19.4 15.04L19.38 15.08L20.87 17.63L17.63 20.87L15.08 19.38L15.04 19.4L14.29 22.25L9.71 22.25L8.96 19.4L8.92 19.38L6.37 20.87L3.13 17.63L4.62 15.08L4.6 15.04L1.75 14.29L1.75 9.71L4.6 8.96L4.62 8.92L3.13 6.37L6.37 3.13L8.92 4.62L8.96 4.6L9.71 1.75L14.29 1.75L15.04 4.6L15.08 4.62L17.63 3.13L20.87 6.37L19.38 8.92zM8.8 12a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0-6.4 0z'],
  palette: ['M12 2.5C6.5 2.5 2 6.6 2 11.8c0 5 4.2 9.2 9.4 9.2 1.6 0 2.4-.9 2.4-2 0-1.4-1.2-1.6-1.2-2.8 0-1 .8-1.7 1.8-1.7h2.3c3.1 0 5.3-2.3 5.3-5.1C22 5.9 17.6 2.5 12 2.5zM5.5 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM8 6.8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM13 6.8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM15.8 10.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0z'],
  brush: ['M20.6 2 22 3.4 12.6 13.8 10.2 11.4z', 'M9.3 12.5l2.2 2.2c-.6 2.9-2.6 5.6-7.8 6.3.9-1.2 1.2-2.4 1.4-3.7.3-2.4 1.9-4.3 4.2-4.8z'],
  dice: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM6.4 8a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0zM14.4 8a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0zM10.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0zM6.4 16a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0zM14.4 16a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0z'],
  branch: ['~M5 12 19 5.5M5 12l14 6.5', 'M2.4 12a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0z', 'M16.4 5.5a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0z', 'M16.4 18.5a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0z'],
  scales: ['M11 4h2v15h-2z', 'M6 19.5h12V22H6z', 'M3 6h18v2H3z', 'M10.4 3.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0z', 'M1.5 14a3.5 3.5 0 0 0 7 0z', 'M15.5 14a3.5 3.5 0 0 0 7 0z', '~M5 8l-3 6M5 8l3 6M19 8l-3 6M19 8l3 6'],
  pawn: ['M12 2.5a3 3 0 0 0-1.9 5.3H8.5v2h1.8c-.2 3.2-1.4 5.6-3.3 7.2V19h10v-2c-1.9-1.6-3.1-4-3.3-7.2h1.8v-2h-1.6A3 3 0 0 0 12 2.5z', 'M5.5 20h13v2h-13z'],
  briefcase: ['M9 3.5h6a1.5 1.5 0 0 1 1.5 1.5V7H20a2 2 0 0 1 2 2v4.5H2V9a2 2 0 0 1 2-2h3.5V5A1.5 1.5 0 0 1 9 3.5zm.5 2V7h5V5.5z', 'M2 15h8.5v1.5h3V15H22v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z'],
  person: ['M12 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z', 'M3.5 21.5c.5-4.8 4-7.8 8.5-7.8s8 3 8.5 7.8z'],
  temple: ['M12 1.5 2 6.5h20z', 'M3 7.5h18v2H3z', 'M4.5 10.5h2.5v8H4.5zM10.75 10.5h2.5v8h-2.5zM17 10.5h2.5v8H17z', 'M3 19.5h18v2.5H3z'],
  flame: ['M12 2c1 3.5 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.6 1.2-4.2 2.6-5.6.3 1.6 1 2.6 2.2 3.1C10.6 7.6 11 4.8 12 2z'],
  open: ['M2 5c3.3-.6 6.6.1 9 2v13c-2.4-1.6-5.7-2.2-9-1.6z', 'M22 5c-3.3-.6-6.6.1-9 2v13c2.4-1.6 5.7-2.2 9-1.6z'],
  lens: ['M10 3a7 7 0 1 0 4.1 12.7l5.6 5.6 1.8-1.8-5.6-5.6A7 7 0 0 0 10 3zm0 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z'],
  atom: ['~M22 12A10 3.8 0 1 1 2 12A10 3.8 0 1 1 22 12zM17 20.66A10 3.8 60 1 1 7 3.34A10 3.8 60 1 1 17 20.66zM7 20.66A10 3.8 120 1 1 17 3.34A10 3.8 120 1 1 7 20.66z', 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0z'],
  flask: ['M9 2.5h6v2h-1v5.2l5.6 9.3A1.6 1.6 0 0 1 18.2 21.5H5.8A1.6 1.6 0 0 1 4.4 19l5.6-9.3V4.5H9z'],
  book: ['M5 2.5h12.5A1.5 1.5 0 0 1 19 4v14H6.5a1.5 1.5 0 0 0 0 3H19v1.5H6.5a3 3 0 0 1-3-3V4A1.5 1.5 0 0 1 5 2.5z'],
  spark: ['M18 2l1 2.6 2.6 1-2.6 1L18 9.2l-1-2.6-2.6-1 2.6-1z', 'M9 9l1.6 4.4L15 15l-4.4 1.6L9 21l-1.6-4.4L3 15l4.4-1.6z'],
  hourglass: ['~M6.5 3h11M6.5 21h11M8 3c0 4.2 4 6 4 9s-4 4.8-4 9M16 3c0 4.2-4 6-4 9s4 4.8 4 9', 'M9.6 20.2c.4-1.8 1.3-2.8 2.4-3.5 1.1.7 2 1.7 2.4 3.5z', 'M9.8 6.5h4.4c-.5 1-1.2 1.8-2.2 2.6-1-.8-1.7-1.6-2.2-2.6z'],
  weight: ['M9.5 3.5a2.5 2.5 0 1 1 4.4 1.6h2.6l3.5 15.5a1 1 0 0 1-1 1.2H5a1 1 0 0 1-1-1.2L7.5 5.1h2.6a2.5 2.5 0 0 1-.6-1.6zm1.4 0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0z'],
};
// The two glyphs of each category in data/book-categories.json; anything else gets a book and a spark.
export const categoryGlyphs = {
  '投资／金融与金钱管理': ['coins', 'trend'], '心理／认知与行为': ['head', 'bulb'], '睡眠／健康／运动': ['moon', 'dumbbell'],
  '软件工程': ['code', 'gear'], '艺术／美学': ['palette', 'brush'], '思维／逻辑／因果与不确定性': ['dice', 'branch'],
  '经济学／经济史／博弈论': ['scales', 'pawn'], '商业／传记／组织管理': ['briefcase', 'person'], '哲学／神话': ['temple', 'flame'],
  '学习／研究／工作方法': ['open', 'lens'], '科学／技术与社会': ['atom', 'flask'],
};
function glyph(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'inspect-glyph'); svg.setAttribute('data-glyph', name);
  for (const d of glyphPaths[name]) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d.replace(/^~/, '')); path.setAttribute('fill-rule', 'evenodd');
    if (d.startsWith('~')) path.setAttribute('class', 'is-line');
    svg.append(path);
  }
  return svg;
}
// 已研读 to a tenth of an hour, 共需 to the whole hour (2026-11-01).
const hoursRead = facts => (Math.floor((facts.readSeconds || 0) / 360) / 10).toFixed(1);
export const readingLine = facts => `已研读 ${hoursRead(facts)} 小时，共需 ${facts.hours} 小时`;
export const blurbOf = agent => agent.book?.blurb || `有关${String(agent.primary || '这本书').replace(/／/g, '、')}的详细信息。`;
function iconLink(ctx, name, ...args) { const el = control(ctx, ...args); el.prepend(icon(ctx.doc, name)); return el; }
function control(ctx, id, text, run, label = text, cls = '') {
  const el = action(ctx.doc, text, run, label); el.className = cls;
  if (id) { el.id = id; ctx.refs[id] = el; }
  el.setAttribute('data-focus-key', id || label); return el;
}
function select(ctx, id, values, change) {
  const el = field(ctx, 'select', id);
  for (const [value, text] of values) { const option = node(ctx.doc, 'option', text); option.value = value; el.append(option); }
  el.addEventListener('change', e => change(e.currentTarget.value)); return el;
}
function label(ctx, text, el) { return region(ctx.doc, 'label', '', node(ctx.doc, 'span', text), el); }
function panel(ctx, id, title) {
  return region(ctx.doc, 'section', 'shelf-panel',
    field(ctx, 'h2', id + '-title', title));
}
const conceptActive = value => ['queued', 'running'].includes(value?.status);
const conceptTerm = record => record?.result?.term || record?.term;
const conceptLongName = record => record?.result?.concept || record?.concept || '待生成概念';
const conceptName = record => conceptTerm(record)?.zh || conceptLongName(record);
function termTranslations(doc, term, leading = false) {
  const line = node(doc, 'span', undefined, 'shelf-term-translations');
  for (const lang of ['en', 'fr']) if (term?.[lang]) {
    if (leading || line.children.length) line.append(node(doc, 'span', ' · '));
    const word = node(doc, 'span', term[lang]); word.setAttribute('lang', lang); line.append(word);
  }
  return line;
}
function conceptTitleNodes(doc, record, tag = 'strong', archive = false) {
  const term = conceptTerm(record), title = node(doc, tag, conceptName(record), 'shelf-term-title');
  const translation = term ? termTranslations(doc, term, archive) : node(doc, 'span', record?.result?.conceptEn || record?.conceptEn || '', 'shelf-term-translations');
  const nodes = archive ? [region(doc, 'span', 'shelf-term-archive', title, translation)] : [title, translation];
  if (term?.zh && conceptLongName(record) !== term.zh) nodes.push(node(doc, 'span', conceptLongName(record), 'shelf-term-subtitle'));
  return nodes;
}
const conceptSource = record => record?.agent
  ? `《${cleanTitle(record.agent.title || record.agent.bookLabel).text || '书名未载明'}》 · ${record.agent.name || '讲解者未载明'}` : '来源待载入';
function conceptButton(ctx, key, text, run, disabled = false, cls = 'shelf-outline') {
  const button = control(ctx, 'concepts-' + key, text, () => { if (!button.disabled) return run(); }, text, cls);
  button.disabled = disabled; return button;
}
// v0.20 reading mode (2026-10-15): design B's page with design D's collapsible outline;
// the provenance sections are folded, and only the lecture itself is shown.
const readerFolds = /^(grounding status|evidence ledger)$/i;
function readerTerm(record) {
  const seen = new Set(), words = [];
  for (const [lang, value] of Object.entries(conceptTerm(record) || {})) {
    const text = String(value || '').trim();
    if (text && !seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); words.push([lang, text]); }
  }
  if (!words.length && record?.result?.conceptEn) words.push(['en', record.result.conceptEn]);
  return words;
}
function readerBody(doc, markdown) {
  const root = renderMarkdown(doc, markdown), kept = [], children = [...root.children];
  // The masthead already shows the concept, so the lecture's own H1 title line is dropped.
  if (children[0]?.tagName === 'H1') children.shift();
  let fold = null;
  for (const child of children) {
    if (child.tagName === 'H2') {
      fold = null;
      if (readerFolds.test(child.textContent.trim())) {
        fold = node(doc, 'details', undefined, 'shelf-reader-fold');
        fold.append(node(doc, 'summary', child.textContent.trim())); kept.push(fold); continue;
      }
    }
    if (fold) fold.append(child); else kept.push(child);
  }
  root.replaceChildren(...kept);
  return root;
}
function readerHeadings(element, found = []) {
  for (const child of element.children) {
    if (['H2', 'H3', 'SUMMARY'].includes(child.tagName)) found.push(child);
    readerHeadings(child, found);
  }
  return found;
}
function readerJump(heading) {
  for (let parent = heading.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  heading.scrollIntoView?.({ block: 'start' });
  heading.focus?.({ preventScroll: true });
}
function setReaderToc(ctx, collapsed) {
  const r = ctx.refs, reading = r.readerHeading?.();
  r.readerTocCollapsed = collapsed;
  r['concept-reader-grid'].className = 'shelf-reader-grid' + (collapsed ? ' is-toc-collapsed' : '');
  // With the outline tucked away only the arrow stays, inside the rail (2026-10-15).
  r['concept-reader-exit'].className = 'shelf-reader-exit' + (collapsed ? ' is-compact' : '');
  const toggle = r['concept-reader-toc-toggle'], label = collapsed ? '展开目录' : '收起目录';
  toggle.textContent = collapsed ? '目录 ›' : '‹';
  toggle.setAttribute('aria-label', label); toggle.title = label;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  r['concept-reader-toc-heading'].hidden = collapsed;
  r['concept-reader-toc-list'].hidden = collapsed;
  if (collapsed) r.readerRail?.schedule(); else r.readerRail?.reveal();
  // The page column re-flows to its new width: keep the section being read at the top now and once the transition ends.
  if (reading) {
    const settle = () => reading.scrollIntoView?.({ block: 'start' });
    settle(); r['concept-reader-grid'].addEventListener('transitionend', settle, { once: true });
  }
}
const readerSource = ({ title, author, name }) => [`《${cleanTitle(title).text || '书名未载明'}》`, author, name && `由 ${name} 讲解`].filter(Boolean).join(' · ');
function conceptReaderView(r, record) {
  const agent = record.agent || {};
  return { eyebrow: `${record.conceptId === r.todayConceptId ? '今日一讲' : '概念讲解'}${record.day ? ' · ' + record.day : ''}`,
    title: conceptLongName(record), term: readerTerm(record), lead: record.result.oneLine || '',
    source: readerSource({ title: agent.title || agent.bookLabel, author: agent.author, name: agent.name }), markdown: record.result.markdown || '' };
}
function fillReader(ctx, view) {
  const { doc, refs: r } = ctx;
  r.readerObserver?.disconnect(); r.readerObserver = null;
  const title = node(doc, 'h1', view.title, 'shelf-reader-title'); title.id = 'concept-reader-title';
  const term = node(doc, 'p', undefined, 'shelf-reader-term');
  (view.term || []).forEach(([lang, text], i) => {
    if (i) term.append(node(doc, 'span', ' · '));
    const word = node(doc, 'span', text); word.setAttribute('lang', lang); term.append(word);
  });
  r['concept-reader-masthead'].replaceChildren(node(doc, 'p', view.eyebrow, 'shelf-reader-eyebrow'),
    title, term, node(doc, 'p', view.lead || '', 'shelf-reader-lead'), node(doc, 'p', view.source || '', 'shelf-reader-source'));
  const body = view.status ? node(doc, 'p', view.status, 'shelf-reader-status') : readerBody(doc, view.markdown || '');
  if (view.status) body.setAttribute('role', 'status');
  r['concept-reader-body'].replaceChildren(...(view.notices || []).map(text => node(doc, 'p', text, 'shelf-reader-notice')), body);
  const entries = readerHeadings(body).map((heading, i) => {
    const text = heading.textContent.trim();
    heading.id = 'concept-reader-section-' + i;
    if (heading.tagName !== 'SUMMARY') heading.setAttribute('tabindex', '-1');
    const item = action(doc, text, () => readerJump(heading), '跳转到：' + text);
    item.className = 'shelf-reader-toc-item ' + (heading.tagName === 'H3' ? 'is-sub' : 'is-main');
    return [heading, item];
  });
  r['concept-reader-toc-list'].replaceChildren(...entries.map(([, item]) => item));
  r.readerHeading = () => entries.find(([, item]) => item.getAttribute('aria-current') === 'true')?.[0];
  r['concept-reader-toc'].hidden = !entries.length;
  setReaderToc(ctx, !!r.readerTocCollapsed);
  const Observer = doc.defaultView?.IntersectionObserver;
  if (Observer && entries.length) {
    r.readerObserver = new Observer(seen => {
      const current = seen.find(entry => entry.isIntersecting)?.target;
      if (current) for (const [heading, item] of entries) {
        if (heading === current) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
      }
    }, { root: r['concept-reader'], rootMargin: '0px 0px -70% 0px' });
    for (const [heading] of entries) r.readerObserver.observe(heading);
  }
}
function openReader(ctx) {
  const r = ctx.refs, record = r.conceptRecord;
  if (!record?.result || r['concept-reader'].open) return;
  r.readerTicket = (r.readerTicket || 0) + 1;
  fillReader(ctx, conceptReaderView(r, record));
  r['concept-reader'].scrollTop = 0;
  r.readerDialog.open(r['concepts-reader']); r.readerRail.schedule();
}
// v0.21 (2026-10-15): a book's Deepbooker Word report opens in the same reading mode.
async function openReportReader(ctx, agent, report, trigger) {
  const r = ctx.refs;
  if (!report.available || r['concept-reader'].open) return;
  const ticket = r.readerTicket = (r.readerTicket || 0) + 1;
  const base = { eyebrow: 'Word 报告', title: report.label, lead: '',
    source: readerSource({ title: agent.book?.title || report.label, author: agent.book?.author, name: agent.name }) };
  fillReader(ctx, { ...base, status: '正在读取 Word 报告…' });
  r['concept-reader'].scrollTop = 0;
  r.readerDialog.open(trigger); r.readerRail.schedule();
  try {
    const data = await ctx.actions.readReport(agent.id, report.index);
    if (ticket !== r.readerTicket || !r['concept-reader'].open) return;
    fillReader(ctx, { ...base, eyebrow: `Word 报告 · 更新于 ${formatDate(data.updatedAt).slice(0, 10)}`, title: data.title || report.label,
      lead: data.subtitle || '', source: base.source + ' · ' + data.file, markdown: data.markdown, notices: data.notices });
    r['concept-reader'].scrollTop = 0;
  } catch (problem) {
    if (ticket === r.readerTicket && r['concept-reader'].open) fillReader(ctx, { ...base, status: 'Word 报告读取失败：' + problem.message });
  }
}
function reportButtons(ctx, model) {
  const reports = model.reports || [];
  if (!reports.length) {
    const none = control(ctx, '', '阅读本书的 Word', () => {}, '阅读本书的 Word', 'detail-report');
    none.disabled = true; none.title = '暂无 Word 报告'; return [none];
  }
  return reports.map(report => {
    const text = reports.length === 1 ? '阅读本书的 Word' : '阅读 Word：' + report.label;
    const button = control(ctx, '', text, event => openReportReader(ctx, model, report, event.currentTarget), '阅读 Word：' + report.label, 'detail-report');
    button.disabled = !report.available;
    button.title = report.available ? `${report.file}（更新于 ${formatDate(report.updatedAt)}）` : '暂无 Word 报告';
    return button;
  });
}
function buildReader(ctx) {
  const { doc, refs: r } = ctx;
  const reader = field(ctx, 'dialog', 'concept-reader', undefined, 'shelf-reader');
  const exit = control(ctx, 'concept-reader-exit', '', () => r.readerDialog.close(), '退出阅读模式', 'shelf-reader-exit');
  exit.title = '合上书（Esc）';
  exit.append(node(doc, 'span', '←', 'shelf-reader-exit-arrow'), node(doc, 'span', ' 合上书', 'shelf-reader-exit-label'), node(doc, 'kbd', 'Esc'));
  // The whole outline sidebar collapses to a rail; the page column widens (2026-10-15).
  const toggle = control(ctx, 'concept-reader-toc-toggle', '‹', () => setReaderToc(ctx, !r.readerTocCollapsed), '收起目录', 'shelf-reader-toc-toggle');
  toggle.setAttribute('aria-controls', 'concept-reader-toc-list'); toggle.setAttribute('aria-expanded', 'true');
  const toc = field(ctx, 'nav', 'concept-reader-toc', undefined, 'shelf-reader-toc'); toc.setAttribute('aria-label', '本讲目录');
  toc.append(region(doc, 'div', 'shelf-reader-toc-head', field(ctx, 'span', 'concept-reader-toc-heading', '本讲目录', 'shelf-reader-toc-heading'), toggle),
    field(ctx, 'div', 'concept-reader-toc-list', undefined, 'shelf-reader-toc-list'));
  const page = region(doc, 'article', 'shelf-reader-page', field(ctx, 'header', 'concept-reader-masthead', undefined, 'shelf-reader-masthead'),
    field(ctx, 'div', 'concept-reader-body', undefined, 'shelf-reader-body'));
  // The collapsed outline rail hides after 3 s and comes back from the left edge, as in the book reader (2026-11-01).
  const edge = node(doc, 'div', undefined, 'shelf-reader-edge'); edge.setAttribute('aria-hidden', 'true');
  reader.append(exit, field(ctx, 'div', 'concept-reader-grid', undefined, 'shelf-reader-grid'), edge);
  r['concept-reader-grid'].append(toc, page);
  r.readerDialog = manageDialog(doc, reader, { labelledby: 'concept-reader-title', initialFocus: exit });
  r.readerRail = autoHideRail(doc, { dialog: reader, rail: toc, exit, edge, isCollapsed: () => !!r.readerTocCollapsed, isActive: () => !toc.hidden,
    onHidden: hidden => { reader.className = 'shelf-reader' + (hidden ? ' is-rail-hidden' : ''); } });
  reader.addEventListener('close', () => { r.readerObserver?.disconnect(); r.readerObserver = null; r.readerTicket = (r.readerTicket || 0) + 1; r.readerRail.reset(); });
  return reader;
}
function todayBadge(doc) { return node(doc, 'span', '今日', 'shelf-today-badge'); }
function conceptNotice(doc, text, warning = false) {
  return node(doc, 'p', text, warning ? 'concept-warning' : 'shelf-concept-meta');
}
function buildConcepts(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const entry = control(ctx, 'concepts-open', '', async () => {
    await a.openConcepts();
    if (r.todayConceptId && r.todayConceptId !== r.conceptId) await a.selectConcept(r.todayConceptId);
  }, '随机概念', 'shelf-bookmark-open');
  const bookmark = field(ctx, 'section', 'shelf-concept-bookmark', undefined, 'shelf-bookmark');
  bookmark.setAttribute('aria-label', '今日一讲'); bookmark.append(entry);
  const section = field(ctx, 'section', 'concepts-panel', undefined, 'shelf-reading-desk');
  section.hidden = true; section.setAttribute('aria-labelledby', 'concepts-title');
  const title = field(ctx, 'h2', 'concepts-title', '阅读桌'); title.setAttribute('tabindex', '-1');
  section.append(region(doc, 'header', 'shelf-concept-toolbar',
    region(doc, 'div', '', node(doc, 'p', '今日一讲 · 随机概念', 'shelf-concept-eyebrow'), title),
    region(doc, 'div', 'workflow-actions',
      conceptButton(ctx, 'back', '返回书房', () => a.showView('catalog'), false, 'shelf-link'),
      conceptButton(ctx, 'next', '再来一个', a.nextConcept, false, 'shelf-primary'))));
  const status = field(ctx, 'p', 'concepts-status', '', 'shelf-concept-status'); status.setAttribute('role', 'status');
  const error = field(ctx, 'p', 'concepts-error', '', 'concept-warning'); error.setAttribute('role', 'alert');
  section.append(status, error, conceptButton(ctx, 'refresh', '重新读取', a.openConcepts, false, 'shelf-link'));
  const paper = field(ctx, 'article', 'concepts-reading', undefined, 'shelf-concept-paper');
  paper.setAttribute('aria-label', '概念讲解');
  const recordStatus = field(ctx, 'p', 'concepts-record-status', '', 'shelf-concept-meta'); recordStatus.setAttribute('role', 'status');
  paper.append(region(doc, 'div', 'shelf-reader-entry-row', field(ctx, 'header', 'concepts-heading'),
    conceptButton(ctx, 'reader', '阅读模式', () => openReader(ctx), true, 'shelf-outline shelf-reader-open')), recordStatus,
    field(ctx, 'p', 'concepts-failure', '', 'concept-warning'),
    conceptButton(ctx, 'retry', '重试', a.nextConcept, false, 'shelf-primary'),
    field(ctx, 'div', 'concepts-intro'),
    region(doc, 'div', 'workflow-actions',
      conceptButton(ctx, 'perspectives', '多视角分析', () => a.openPerspectivePicker(r.conceptId), false, 'shelf-primary'),
      conceptButton(ctx, 'continue', '在终端中继续', () => a.continueInJoint(r.conceptId))),
    field(ctx, 'div', 'concepts-marks', undefined, 'shelf-concept-marks'),
    field(ctx, 'p', 'concepts-think-error', '', 'concept-warning'),
    field(ctx, 'p', 'concepts-source-refs', '', 'shelf-concept-meta'),
    field(ctx, 'div', 'concepts-body'));
  r['concepts-retry'].title = '重新生成一个新概念，保留失败记录';
  const perspectives = field(ctx, 'section', 'concepts-perspective-results', undefined, 'shelf-perspectives');
  perspectives.setAttribute('aria-label', '多视角分析结果');
  const archive = field(ctx, 'nav', 'concepts-archive', undefined, 'shelf-concept-loans'); archive.setAttribute('aria-label', '概念存档');
  section.append(region(doc, 'div', 'shelf-reading-layout',
    region(doc, 'div', 'shelf-reading-pages', paper, perspectives),
    region(doc, 'aside', 'shelf-concept-archive', node(doc, 'h3', '概念存档'), archive)));
  return { bookmark, section, reader: buildReader(ctx) };
}
function renderConceptArchive(ctx, model) {
  const { doc, refs: r, actions: a } = ctx;
  const items = [...(model.items || [])].sort((left, right) =>
    Number(right.conceptId === model.today?.conceptId) - Number(left.conceptId === model.today?.conceptId));
  const elapsed = items.map(item => conceptStatus(item));
  const key = JSON.stringify([items, elapsed, model.today?.conceptId, model.selected?.conceptId]);
  if (key === r.conceptArchiveKey) return;
  r.conceptArchiveKey = key;
  const archive = r['concepts-archive'], scroll = archive.scrollTop;
  archive.replaceChildren();
  for (const [index, item] of items.entries()) {
    const button = conceptButton(ctx, 'select-' + item.conceptId, conceptName(item), () => a.selectConcept(item.conceptId), false, 'shelf-concept-loan');
    const date = node(doc, 'time', formatDate(item.createdAt), 'lending-stamp');
    if (item.createdAt) date.setAttribute('datetime', item.createdAt);
    button.replaceChildren(region(doc, 'span', 'lending-stamps', date, item.conceptId === model.today?.conceptId ? todayBadge(doc) : null),
      ...conceptTitleNodes(doc, item, 'strong', true), markAgentLink(node(doc, 'span', conceptSource(item), 'shelf-concept-meta'), item.agent),
      node(doc, 'span', elapsed[index], 'shelf-concept-meta'));
    if (item.conceptId === model.selected?.conceptId) button.setAttribute('aria-current', 'page');
    archive.append(button);
  }
  if (!items.length) archive.append(node(doc, 'p', '暂无存档，可点击「再来一个」。', 'muted'));
  archive.scrollTop = scroll || 0;
}
function renderConceptPerspectives(ctx, record, busy) {
  const { doc, refs: r, actions: a } = ctx, runs = record?.perspectives || [];
  const key = JSON.stringify([record?.conceptId, runs]);
  if (key !== r.conceptPerspectivesKey) {
    r.conceptPerspectivesKey = key; r.perspectiveRuns = [];
    const target = r['concepts-perspective-results']; target.replaceChildren(node(doc, 'h3', '多视角便签'));
    if (!runs.length) target.append(node(doc, 'p', '从其他书或同事的视角，留下补充、冲突与应用的便签。', 'muted'));
    for (const run of runs) {
      const status = node(doc, 'p', '', 'shelf-concept-status'); status.setAttribute('role', 'status');
      const section = region(doc, 'section', 'shelf-perspective-run', fillAgentNames(doc,node(doc,'h4'),run.agents || []), status);
      if (run.error) section.append(conceptNotice(doc, '失败原因：' + run.error, true));
      const ids = (run.agents || []).map(agent => agent.id);
      const retry = run.status === 'failed' ? conceptButton(ctx, 'retry-' + run.runId, '重试多视角分析', () => a.runPerspectives(record.conceptId, ids)) : null;
      if (retry) section.append(retry);
      const parallel = typeof run.verify?.parallel === 'object' ? run.verify.parallel?.state : run.verify?.parallel;
      const parallelOk = parallel === 'ok' || parallel === true, violations = run.verify?.violations || [];
      const verified = run.verify?.state === 'ok' && !violations.length;
      section.append(conceptNotice(doc, `多视角核验：${verified ? '通过' : run.verify?.state === 'violation' ? '违规' : '未确认'}；并行：${parallelOk ? '通过' : '未通过或未确认'}${violations.length ? '；' + JSON.stringify(violations) : ''}`, !verified || !parallelOk));
      const notes = region(doc, 'div', 'shelf-perspective-notes');
      for (const result of run.results || []) notes.append(region(doc, 'article', 'shelf-perspective-note',
        markAgentLink(node(doc, 'h4', result.name || result.agentId), {id:result.agentId}), renderMarkdown(doc, result.analysis)));
      section.append(notes); target.append(section); r.perspectiveRuns.push({ run, status, retry, ids });
    }
  }
  const active = runs.some(conceptActive);
  for (const { run, status, retry, ids } of r.perspectiveRuns || []) {
    status.textContent = '多视角 · ' + conceptStatus(run);
    if (retry) retry.disabled = busy || active || !ids.length;
  }
}
export function renderConcepts(ctx, model) {
  const { doc, refs: r, state: s } = ctx;
  model ||= { items: [], selected: null, today: undefined, running: null, busy: false, error: '' };
  const visible = s.view === 'concepts', entering = visible && !r.conceptsVisible;
  const restoreFocus = !visible && r.conceptsVisible && r['concepts-panel'].contains(doc.activeElement);
  r['concepts-panel'].hidden = !visible; r.conceptsVisible = visible;
  // Other layouts still use A2's external fallback panel; shelf owns its whole page.
  ctx.root.hidden = false; ctx.root.parentElement?.removeAttribute('data-concepts-open');
  r.todayConceptId = model.today?.conceptId; r.conceptId = model.selected?.conceptId;
  const today = (model.selected?.conceptId === r.todayConceptId ? model.selected : null) ||
    (model.items || []).find(item => item.conceptId === r.todayConceptId);
  const todayStatus = today ? conceptStatus(today) : r.todayConceptId
    ? conceptStatus({ ...model.today, ...(model.running?.conceptId === r.todayConceptId ? model.running : {}) }) : '';
  const todayLoading = model.today === undefined;
  const bookmarkKey = JSON.stringify([today, model.today, todayLoading, todayStatus]);
  if (r.bookmarkKey !== bookmarkKey) {
    r.bookmarkKey = bookmarkKey;
    r['concepts-open'].replaceChildren(
      region(doc, 'span', 'shelf-bookmark-caption', node(doc, 'span', '今日一讲'), r.todayConceptId ? todayBadge(doc) : null),
      ...(today ? conceptTitleNodes(doc, today) : [node(doc, 'strong', todayLoading ? '今日讲解载入中…' : r.todayConceptId ? '今日讲解待载入' : '今日讲解尚未生成')]),
      markAgentLink(node(doc, 'span', today ? conceptSource(today) : '从书中读一个尚未意识到的概念', 'shelf-concept-meta'), today?.agent),
      node(doc, 'span', today?.result?.oneLine || today?.oneLine || '', 'shelf-bookmark-summary'),
      node(doc, 'span', todayStatus ? todayStatus + ' · 到阅读桌 →' : '打开阅读桌 →', 'shelf-bookmark-foot'));
    const note = conceptResponseNote(doc, today); if (note) r['concepts-open'].append(note);
  }
  if (restoreFocus && s.view === 'catalog') r['concepts-open'].focus();
  if (!visible) return;
  renderConceptThread(ctx, model, r['concepts-panel']);
  r['shelf-back'].hidden = true;
  if (entering && !Array.from(doc.querySelectorAll('dialog')).some(dialog => dialog.open)) r['concepts-title'].focus();
  const record = model.selected, result = record?.result;
  const generationActive = !!model.running || conceptActive(record);
  r['concepts-next'].disabled = model.busy || generationActive;
  r['concepts-status'].textContent = [model.busy ? '正在提交…' : '', model.running ? '概念生成 · ' + conceptStatus({ ...model.running, status: 'running' }) : ''].filter(Boolean).join(' · ');
  r['concepts-status'].hidden = !r['concepts-status'].textContent;
  r['concepts-error'].textContent = model.error || ''; r['concepts-error'].hidden = !model.error;
  r['concepts-refresh'].hidden = !model.error; r['concepts-refresh'].disabled = model.busy;
  renderConceptArchive(ctx, model);
  const headingKey = JSON.stringify([record?.conceptId, record?.agent, conceptLongName(record), result?.conceptEn, conceptTerm(record), model.today?.conceptId]);
  if (headingKey !== r.conceptHeadingKey) {
    r.conceptHeadingKey = headingKey;
    r['concepts-heading'].replaceChildren();
    if (record?.conceptId === model.today?.conceptId && record) r['concepts-heading'].append(todayBadge(doc));
    r['concepts-heading'].append(...(record ? conceptTitleNodes(doc, record, 'h3') : [node(doc, 'h3', '等待开讲')]));
    if (record) r['concepts-heading'].append(markAgentLink(node(doc, 'p', conceptSource(record), 'shelf-concept-meta'), record.agent));
  }
  r.conceptRecord = record; r['concepts-reader'].disabled = !result;
  r['concepts-record-status'].textContent = record ? conceptStatus(record) : '';
  r['concepts-failure'].textContent = record?.error ? '失败原因：' + record.error : record?.status === 'failed' ? '失败原因：未载明' : '';
  r['concepts-failure'].hidden = !r['concepts-failure'].textContent;
  r['concepts-retry'].hidden = record?.status !== 'failed'; r['concepts-retry'].disabled = model.busy || generationActive;
  const introKey = JSON.stringify([result?.oneLine, result?.whyUnknown]);
  if (introKey !== r.conceptIntroKey) {
    r.conceptIntroKey = introKey; r['concepts-intro'].replaceChildren();
    if (result) r['concepts-intro'].append(node(doc, 'p', result.oneLine, 'shelf-concept-lead'),
      region(doc, 'aside', 'shelf-concept-why', node(doc, 'strong', '为什么可能不知道'), node(doc, 'p', result.whyUnknown)));
  }
  r['concepts-perspectives'].disabled = !result || record.status !== 'done' || model.busy || record.perspectives?.some(conceptActive);
  r['concepts-continue'].disabled = !result || model.busy;
  const marks = r['concepts-marks']; marks.replaceChildren();
  if (record && (record.result || record.thinkError || record.verify?.state === 'violation')) {
    const structure = record.verify?.skillStructure, verified = record.verify?.state === 'ok';
    const structured = structure?.state === 'ok' && structure.titleLine !== false && !structure.missing?.length;
    marks.append(conceptNotice(doc, 'Agent 核验：' + (verified ? '通过' : record.verify?.state === 'violation' ? '违规' : '未确认'), !verified),
      conceptNotice(doc, '11 小节结构：' + (structured ? '通过' : `未通过或未确认；缺少小节 ${(structure?.missing || []).join('、') || '未知'}${structure?.titleLine === false ? '；缺少标题行' : ''}`), !structured));
  }
  if (record?.poolWarning) marks.append(conceptNotice(doc, record.poolWarning, true));
  r['concepts-think-error'].textContent = record?.thinkError ? 'THINK 另存失败：' + record.thinkError : '';
  r['concepts-think-error'].hidden = !record?.thinkError;
  r['concepts-source-refs'].textContent = result?.sourceRefs?.length ? '书内出处：' + result.sourceRefs.join('；') : '';
  const bodyKey = JSON.stringify([record?.conceptId, result?.markdown, record?.respondsTo, result?.response, record?.responseError, !record && !!model.items?.length]);
  if (bodyKey !== r.conceptBodyKey) {
    r.conceptBodyKey = bodyKey;
    r['concepts-body'].replaceChildren(result ? renderMarkdown(doc, result.markdown) : node(doc, 'p', record ? '正文尚未生成。' : model.items?.length ? '请选择概念或等待详情读取。' : '暂无讲解，点击「再来一个」开始。'));
    const response = conceptResponse(ctx, record); if (response) r['concepts-body'].prepend(response);
  }
  renderConceptPerspectives(ctx, record, model.busy);
}
function buildRecommend(ctx) {
  const { doc, actions: a } = ctx;
  const box = panel(ctx, 'recommend', '请书房推荐'); box.id = 'recommend-panel'; ctx.refs['recommend-panel'] = box;
  const input = field(ctx, 'textarea', 'recommend-input'); input.rows = 5; input.maxLength = 8000;
  input.setAttribute('maxlength', '8000'); input.setAttribute('aria-label', '输入问题或内容（最多 8000 字）');
  input.setAttribute('placeholder', '描述你希望 Agent 帮忙的任务');
  input.addEventListener('input', e => a.setRecommendInput(e.currentTarget.value)); ctx.refs.recommendInput = input;
  box.append(label(ctx, '输入问题或内容（最多 8000 字）', input), field(ctx, 'p', 'recommend-count'),
    region(doc, 'div', 'workflow-actions',
      label(ctx, '推荐引擎', select(ctx, 'recommend-engine', [['claude','Claude'],['codex','Codex']], a.setRecommendEngine)),
      field(ctx, 'span', 'recommend-model'), control(ctx, 'recommend-submit', '推荐 Agent', a.recommend, '推荐 Agent', 'shelf-primary')),
    field(ctx, 'p', 'recommend-disabled-reason'), field(ctx, 'div', 'recommend-status'),
    field(ctx, 'div', 'recommend-results', undefined, 'recommend-cards'));
  const all = field(ctx, 'input', 'select-all'); all.type = 'checkbox'; all.setAttribute('aria-label', '全选当前推荐');
  all.addEventListener('change', e => a.selectAllRecommendations(e.currentTarget.checked));
  box.append(region(doc, 'div', 'workflow-actions', label(ctx, '全选当前推荐', all), field(ctx, 'span', 'selected-count'),
    label(ctx, '联合调用 CLI', select(ctx, 'joint-cli', [['claude','Claude CLI'],['codex','Codex CLI'],['inapp:claude','CO-AGENT 内 · Claude'],['inapp:codex','CO-AGENT 内 · Codex']], a.setJointCli)),
    control(ctx, 'joint-submit', '联合调用', a.launchRecommendedJoint, '联合调用', 'shelf-primary')),
    field(ctx, 'p', 'joint-disabled-reason'),
    node(doc, 'p', 'Claude 使用平台禁止规则；Codex 白名单只支持事后核验，子任务文本加密，无法逐字核验。'));
  const recent = node(doc, 'details'); recent.append(node(doc, 'summary', '最近的推荐与联合调用（20 条）'), field(ctx, 'div', 'recent-list')); box.append(recent);
  ctx.refs['recommend-status'].setAttribute('role', 'status');
  return box;
}
export function render(ctx) {
  const { doc, refs: r, actions: a } = ctx;
  const brand = field(ctx, 'div', 'brand', undefined, 'shelf-brand');
  brand.append(node(doc, 'h1', 'CO-AGENT 书房', 'shelf-title'),
    region(doc, 'div', 'shelf-caption', field(ctx, 'p', 'shelf-subtitle', '', 'shelf-subtitle'),
      renderCandidateNotice(ctx),
      region(doc, 'nav', 'shelf-nav',
        iconLink(ctx, 'history', 'shelf-history', '借阅记录', () => a.showView('history'), '历史调用', 'shelf-link'),
        iconLink(ctx, 'stats', 'stats-open', '借阅统计', () => a.openStats(), '借阅统计', 'shelf-link'),
        iconLink(ctx, 'group', 'groups-open', '调用组', () => a.openGroups(), '调用组', 'shelf-link'))));
  const search = field(ctx, 'input', 'search'); search.type = 'search';
  search.setAttribute('aria-label', '全局搜索'); search.setAttribute('title', '/ 或 Ctrl+K');
  search.setAttribute('placeholder', '找一本书或一位作者'); search.setAttribute('autocomplete', 'off');
  search.addEventListener('input', e => a.search(e.currentTarget.value));
  const tools = region(doc, 'div', 'shelf-tools',
    control(ctx, 'shelf-reading', '', () => a.showView('running'), '查看在读会话', 'shelf-link shelf-reading-pill'),
    region(doc, 'div', '', search),
    control(ctx, 'shelf-recommend', '请书房推荐', () => a.showView('recommend'), 'AI 推荐', 'shelf-primary'),
    control(ctx, 'settings-open', '⚙', e => a.openSettings(e.currentTarget), '打开设置', 'shelf-settings'));
  tools.children[1].id = 'search-control'; r['shelf-reading'].hidden = true;
  const header = region(doc, 'header', 'shelf-header', brand, tools);
  const back = control(ctx, 'shelf-back', '← 返回书房', () => { a.search(''); a.selectCategory('all'); }, '返回书房', 'shelf-link');
  back.hidden = true;
  const catalog = field(ctx, 'main', 'catalog');
  const title = field(ctx, 'h2', 'view-title', '', 'shelf-search-title'); title.hidden = true;
  const cards = field(ctx, 'div', 'cards');
  const staff = field(ctx, 'section', 'shelf-staff', undefined, 'staff-row'); staff.setAttribute('aria-label', '同事');
  // Scroll arrows for the staff row: each shows only when more staff lie in that direction.
  const staffStrip = field(ctx, 'div', 'shelf-staff-strip', undefined, 'staff-strip');
  const staffStep = dir => {
    const reduce = ctx.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const by = Math.max(160, Math.round((staff.clientWidth || 0) * 0.8)) * dir;
    if (typeof staff.scrollBy === 'function') staff.scrollBy({ left: by, behavior: reduce ? 'auto' : 'smooth' });
    else staff.scrollLeft = (staff.scrollLeft || 0) + by;
    if (typeof staff.scrollBy !== 'function') r.updateStaffArrows?.();
  };
  const staffPrev = control(ctx, 'shelf-staff-prev', '‹', () => staffStep(-1), '向左查看更多同事', 'staff-arrow staff-arrow-prev');
  const staffNext = control(ctx, 'shelf-staff-next', '›', () => staffStep(1), '向右查看更多同事', 'staff-arrow staff-arrow-next');
  r.updateStaffArrows = () => {
    const max = (staff.scrollWidth || 0) - (staff.clientWidth || 0), left = staff.scrollLeft || 0;
    const canLeft = max > 2 && left > 2, canRight = max > 2 && left < max - 2;
    staffPrev.hidden = !canLeft; staffNext.hidden = !canRight;
    staffStrip.className = ['staff-strip', canLeft ? 'can-left' : '', canRight ? 'can-right' : ''].filter(Boolean).join(' ');
  };
  staff.addEventListener('scroll', () => r.updateStaffArrows());
  ctx.doc.defaultView?.addEventListener?.('resize', () => r.updateStaffArrows());
  staffStrip.append(staffPrev, staff, staffNext);
  const shelves = field(ctx, 'div', 'navigation', undefined, 'shelf-layers'); shelves.setAttribute('aria-label', '书籍分类书架');
  const concepts = buildConcepts(ctx);
  cards.append(staffStrip, concepts.bookmark, shelves, field(ctx, 'p', 'shelf-empty')); catalog.append(title, cards);
  const recommend = buildRecommend(ctx);
  const history = panel(ctx, 'history', '借阅记录'); history.id = 'history-panel'; r['history-panel'] = history;
  history.setAttribute('aria-label', '历史调用');
  history.append(region(doc, 'div', 'workflow-actions',
    label(ctx, '筛选', select(ctx, 'history-filter', [['all','全部'],['launch','单次'],['joint','联合']], a.setHistoryFilter)),
    control(ctx, 'history-refresh', '刷新记录', a.refreshHistory)),
    field(ctx, 'p', 'history-status'), field(ctx, 'div', 'history-list', undefined, 'lending-grid'));
  r['history-status'].setAttribute('role', 'status');
  const running = panel(ctx, 'running', '在读会话'); running.id = 'running-panel'; r['running-panel'] = running;
  running.append(runningCloseHeading(ctx,r['running-title']));
  running.append(region(doc, 'div', 'workflow-actions',
    control(ctx, 'running-refresh', '刷新在读会话', a.refreshRunning),
    control(ctx, 'reverify-all', '全部重新核验', a.reverifyAll)),
    field(ctx, 'p', 'reverify-all-status'), field(ctx, 'div', 'running-list'));
  r['reverify-all-status'].setAttribute('role', 'status');
  const coverage = panel(ctx, 'coverage', '扫描摘要和数据覆盖'); coverage.id = 'coverage-panel'; r['coverage-panel'] = coverage;
  const scan = field(ctx, 'details', 'scan'), stats = field(ctx, 'details', 'stats-coverage');
  scan.append(field(ctx, 'summary', 'scan-summary'), field(ctx, 'div', 'scan-detail'));
  stats.append(field(ctx, 'summary', 'stats-summary'), field(ctx, 'div', 'stats-detail'),
    control(ctx, 'stats-refresh', '重新统计', a.refreshStats));
  coverage.append(field(ctx, 'section', 'metrics'), scan, stats);
  const services = region(doc, 'div', 'shelf-services',
    control(ctx, 'shelf-running', '在读会话', () => a.showView('running'), '运行中的会话', 'shelf-link'),
    control(ctx, 'shelf-coverage', '扫描与覆盖', () => a.showView('coverage'), '扫描摘要和数据覆盖', 'shelf-link'));
  // 2026-10-31 (version 2): the desk keeps the two joint-call buttons; the other rooms open from 书房各室 ▾,
  // a native popover anchored above its button (Esc and a click outside close it).
  const rooms = node(doc, 'div', undefined, 'shelf-rooms'); rooms.id = 'shelf-rooms'; rooms.setAttribute('popover', ''); rooms.setAttribute('aria-label', '书房各室');
  const room = (name, id, text, run) => iconLink(ctx, name, id, text, () => { rooms.hidePopover?.(); return run(); }, text, 'shelf-room');
  rooms.append(room('roundtable', 'seminars-open', '圆桌讨论', () => a.openSeminars()), room('consult', 'consults-open', '会诊室', () => a.openConsults()),
    room('chat', 'chats-open', '软件内对话', () => a.openChats()), room('council', 'councils-open', '顾问团', () => a.openCouncils()),
    room('map', 'concept-map-open', '概念地图', () => a.openConceptMap()));
  const roomsOpen = control(ctx, 'shelf-rooms-open', '书房各室 ▾', () => {}, '书房各室', 'shelf-outline shelf-rooms-open');
  roomsOpen.setAttribute('popovertarget', rooms.id);
  const tray = region(doc, 'section', 'desk-tray', field(ctx, 'div', 'tray-selected'),
    region(doc, 'div', 'desk-actions',
      control(ctx, 'shelf-joint', '发起联合调用（0）', e => a.openJoint(ctx.state.jointSelectedIds, e.currentTarget), '发起联合调用', 'shelf-primary'),
      control(ctx, 'shelf-new-joint', '新建联合调用', e => a.openJoint([], e.currentTarget), '新建联合调用', 'shelf-outline'),
      roomsOpen, rooms));
  tray.setAttribute('aria-label', '书桌'); r['shelf-joint'].disabled = true;
  const detail = field(ctx, 'dialog', 'detail', undefined, 'drawer shelf-detail');
  const icon = node(doc, 'img'); icon.setAttribute('src', '/brand/co-agent-icon.svg'); icon.setAttribute('alt', '');
  icon.setAttribute('width', '28'); icon.setAttribute('height', '28');
  detail.append(region(doc, 'div', 'drawer-heading', region(doc, 'div', 'detail-identity', icon, field(ctx, 'h2', 'detail-title')),
    control(ctx, 'close-detail', '关闭', a.closeDetail, '关闭详情')), field(ctx, 'div', 'detail-body'));
  r.dialog = manageDialog(doc, detail, { labelledby: 'detail-title' });
  detail.addEventListener('close', () => { if (!r.disposing && ctx.state.detailOpen) a.closeDetail(); });
  const bookStage = buildBookStage(ctx);
  r.dispose = () => { r.disposing = true; if (detail.open) r.dialog.close(); r.bookStage.dispose(); if (concepts.reader.open) r.readerDialog.close(); };
  return region(doc, 'div', 'layout-shelf', header, back, catalog, concepts.section, buildStats(ctx), recommend, history, running, coverage, services, tray, detail, bookStage, concepts.reader);
}
function updateVisibility(ctx) {
  const { refs: r, state: s } = ctx;
  for (const view of ['catalog','recommend','history','running','coverage']) r[view === 'catalog' ? 'catalog' : view + '-panel'].hidden = s.view !== view;
  r['shelf-back'].hidden = s.view === 'catalog' && s.category === 'all' && !s.query.trim();
  r['tray-selected'].replaceChildren();
  for (const id of s.jointSelectedIds) {
    const agent = s.allAgents.find(a => a.id === id), name = agent?.name || id;
    r['tray-selected'].append(markAgentLink(control(ctx, '', name + ' ×', () => ctx.actions.removeFromJoint(id), '移除 ' + name, 'desk-tag'),agent || id));
  }
  if (!s.jointSelectedIds.length) r['tray-selected'].append(node(ctx.doc, 'span', display.readingQuote, 'muted'));
  r['shelf-joint'].textContent = '发起联合调用（' + s.jointSelectedIds.length + '）';
  r['shelf-joint'].disabled = s.jointSelectedIds.length === 0;
  for (const button of ctx.root.querySelectorAll('.put-on-desk')) {
    const selected = s.jointSelectedIds.includes(button.getAttribute('data-member'));
    button.disabled = selected || s.jointSelectedIds.length >= 8;
    button.title = selected ? '已在书桌上' : button.disabled ? '最多选择 8 个，请先移除一个。' : '放上书桌';
    button.textContent = selected ? '已在书桌' : '放上书桌';
  }
}
function deskAction(ctx, agent, detail = false) {
  const el = control(ctx, '', '放上书桌', e => ctx.actions.addToJoint(agent.id, e.currentTarget, false),
    (detail ? '加入联合调用 ' : '放上书桌 ') + agent.name, 'put-on-desk');
  el.setAttribute('data-member', agent.id);
  const selected = ctx.state.jointSelectedIds.includes(agent.id);
  el.disabled = selected || ctx.state.jointSelectedIds.length >= 8;
  el.title = selected ? '已在书桌上' : el.disabled ? '最多选择 8 个，请先移除一个。' : '放上书桌';
  return el;
}
// v0.26 A 胡桃木书柜: muted cloth tones tuned to the room's walls; the gilt titles (#e6c98a) keep at least 5.8:1 on each.
export const spinePalette = ['#552424','#2a4232','#24324a','#4e3820','#442e48','#2a4444','#5a4220','#383230'];
function bookDimensions(agent) {
  let hash = 0; for (const char of agent.id) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return { height: 230 + hash % 31, width: Math.min(64, 52 + Math.max(0, Array.from(titleForSpine(agent)).length - 12) * 2), color: spinePalette[hash % spinePalette.length] };
}
// v0.38 抽书转封面 (docs/design/v0.38/shelf-motion.html): a click on a spine pulls the book out of its row, flies it
// to the centre and turns it to a generated cover; a second click opens the detail beside it; closing the detail,
// Esc, × or the dimmed room flies it back into its slot. Without WAAPI or layout boxes (tests) a click opens the detail.
const BOOK_H = 380, BOOK_W = Math.round(BOOK_H * 0.68);
const SPRING = 'cubic-bezier(.3,1.32,.46,1)', OUT = 'cubic-bezier(.22,1,.36,1)', HOME = 'cubic-bezier(.4,0,.2,1)';
const hashOf = text => { let hash = 0; for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0; return hash; };
// One of three cover designs, fixed per book; the cloth is the spine's own colour.
export function bookCover(doc, agent) {
  const title = titleForSpine(agent), length = Array.from(title).length, author = authorShort(agent) || agent.book?.author || '';
  const template = ['frame', 'band', 'classic'][hashOf(agent.id) % 3];
  const cover = node(doc, 'div', undefined, 'book-cover cover-' + template);
  setStyle(cover, { '--cover-title': length <= 6 ? '34px' : length <= 12 ? '28px' : length <= 22 ? '23px' : '19px' });
  const heading = node(doc, 'strong', title, 'cover-title'), byline = node(doc, 'span', author, 'cover-author');
  if (template === 'frame') cover.append(heading, node(doc, 'span', '◆ ◇ ◆', 'cover-ornament'), byline);
  else if (template === 'band') cover.append(byline, region(doc, 'div', 'cover-band', heading));
  else cover.append(heading, node(doc, 'span', undefined, 'cover-rule'), byline);
  return cover;
}
const canPullOut = (doc, spine) => typeof spine.animate === 'function' && typeof spine.getBoundingClientRect === 'function'
  && typeof doc.defaultView?.getComputedStyle === 'function' && typeof doc.defaultView?.innerWidth === 'number';
function buildBookStage(ctx) {
  const { doc, refs: r } = ctx, view = doc.defaultView;
  const stage = node(doc, 'dialog', undefined, 'shelf-book-stage'); stage.id = 'shelf-book-stage'; stage.tabIndex = -1;
  stage.append(control(ctx, 'shelf-book-close', '×', () => closeAny(), '合上并放回书架', 'shelf-book-close'));
  // v0.42 书本检视 (2026-11-01, after a game's item card): beside the turned-out book, its category glyphs, title,
  // two-sentence description (data/book-blurbs.json), hours read in the app of hours needed, and weight by pages.
  const inspect = region(doc, 'section', 'book-inspect'); inspect.id = 'book-inspect'; inspect.setAttribute('aria-labelledby', 'book-inspect-title');
  stage.append(inspect);
  let book = null, inspectHeight = 0;
  const measureInspect = () => {
    const height = inspect.getBoundingClientRect?.().height;
    inspectHeight = Number.isFinite(height) && height > 0 ? height : 0;
  };
  function fillInspect(agent, title) {
    const icons = region(doc, 'div', 'inspect-glyphs', ...(categoryGlyphs[agent.primary] || ['book', 'spark']).map(name => glyph(doc, name)));
    const heading = node(doc, 'h2', `《${title}》`, 'inspect-title'); heading.id = 'book-inspect-title';
    const time = node(doc, 'span', '正在估算研读时长…'), weight = node(doc, 'span', '正在称重…');
    const row = (name, text, label) => { const li = region(doc, 'li', 'inspect-' + name, glyph(doc, name), text); li.setAttribute('aria-label', label); return li; };
    const weightRow = row('weight', weight, '重量'), stats = region(doc, 'ul', 'inspect-stats', row('hourglass', time, '研读时长'), weightRow);
    inspect.replaceChildren(icons, heading, node(doc, 'p', blurbOf(agent), 'inspect-blurb'), stats);
    Promise.resolve(ctx.actions.bookFacts?.(agent.id)).then(facts => {
      if (book?.agent !== agent || !facts) return;
      if (!facts.books) { time.textContent = `已研读 ${hoursRead(facts)} 小时，没有能在软件里阅读的原书`; weightRow.hidden = true; return; }
      time.textContent = readingLine(facts); weight.textContent = `${facts.weightKg.toFixed(2)} 公斤`;
      weightRow.title = `${facts.estimatedPages ? '约 ' : ''}${facts.pages} 页${facts.books > 1 ? `，共 ${facts.books} 本` : ''}`;
    }).catch(() => { if (book?.agent === agent) { time.textContent = '研读时长暂时无法估算'; weight.textContent = '重量暂时无法估算'; } })
      .finally(() => { if (book?.agent === agent) reposition(); });
  }
  const reduce = () => !!view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const spineOf = key => Array.from(doc.querySelectorAll('.book-spine')).find(n => n.getAttribute('data-focus-key') === key && !n.closest('[hidden]'));
  const geometry = spine => {
    const box = spine.getBoundingClientRect(), s = spine.offsetHeight / BOOK_H;
    return { cx: box.left + box.width / 2, cy: box.top + box.height / 2, s, lean: view.getComputedStyle(spine).getPropertyValue('--lean').trim() || '0deg' };
  };
  // Beside the detail only when both fit; a narrow window keeps the book centred under the detail.
  const side = () => view.innerWidth >= 960;
  const place = (x, y, extra) => `translate(${x - BOOK_W / 2}px,${y - BOOK_H / 2}px) ${extra}`;
  // v0.42: the book stands left of its card (the card starts at the middle), or above it in a narrow window.
  const coverAt = () => {
    if (side()) return [Math.max(BOOK_W * 0.75, view.innerWidth * 0.3), view.innerHeight / 2 - 12, 1];
    if (!inspectHeight) return [view.innerWidth / 2, view.innerHeight * 0.36, 0.72];
    // The card's final bottom is 5vh (its entrance translate must not affect this measurement).
    const top = view.innerHeight * 0.95 - inspectHeight;
    return [view.innerWidth / 2, top / 2, Math.max(0.5, Math.min(0.72, (top - 32) / BOOK_H))];
  };
  const detailAt = () => side() ? [Math.max(BOOK_W * 0.6, view.innerWidth * 0.27), view.innerHeight / 2, 0.86] : coverAt();
  // spin: the reader's own turn of the book (2026-11-01: drag to rotate it), on top of the cover and detail poses.
  // Turned spine-out, the spine face stands half a book width nearer the viewer and the stage's perspective would show it
  // 8% larger and pushed off-centre; translateZ sets it back into the screen plane so it lands exactly on the real spine.
  const SPINE_Z = `translateZ(${-BOOK_W / 2}px)`, FLAT = 'translateZ(0px)';
  const poses = (g, spin = { x: 0, y: 0 }) => {
    const [cx, cy, cs] = coverAt(), [dx, dy, ds] = detailAt(), turn = (x, y) => `rotateX(${x + spin.x}deg) rotateY(${y + spin.y}deg)`;
    return {
      shelf: place(g.cx, g.cy, `scale(${g.s}) ${SPINE_Z} rotateZ(${g.lean}) rotateY(90deg)`),
      pull: place(g.cx, g.cy - 28, `scale(${g.s * 1.06}) ${SPINE_Z} rotateZ(0deg) rotateY(90deg)`),
      cover: place(cx, cy, `scale(${cs}) ${FLAT} ${turn(5, 20)}`),
      detail: place(dx, dy, ds === 1 ? `scale(1) ${FLAT} ${turn(5, 20)}` : `scale(${ds}) ${FLAT} ${turn(4, 28)}`),
    };
  };
  const ground = pose => { // the soft contact shadow under the book in the cover and detail poses
    const [x, y, scale] = pose === 'detail' ? detailAt() : coverAt();
    book.ground.style.transform = `translate(${x - BOOK_W / 2}px,${y + BOOK_H * scale / 2 - 12}px) scale(${scale},1)`;
  };
  // frames: transforms, or { transform, offset } for a waypoint inside one continuous flight.
  const run = async (frames, ms, easing) => {
    const keys = frames.map(f => typeof f === 'string' ? { transform: f } : f), to = keys.at(-1).transform;
    const animation = book.el.animate(keys, { duration: reduce() ? 0 : ms, easing, fill: 'forwards' });
    try { await animation.finished; } catch { /* cancelled by dispose */ }
    if (!book) return; book.el.style.transform = to; animation.cancel();
  };
  // Applies the reader's turn at once, in the cover or the detail pose; a turn wraps to −180°…180° so the flight home stays short.
  function turn(x, y) {
    if (!book || !['cover', 'detail'].includes(book.state)) return;
    book.spin = { x: Math.max(-60, Math.min(60, x)), y: ((y + 540) % 360) - 180 };
    book.el.style.transform = poses(book.g, book.spin)[book.state];
  }
  // Coasting after a flick: degrees per millisecond, slowed by friction with a 350 ms time constant until it is barely moving.
  const clock = () => view?.performance?.now?.() ?? Date.now();
  function coast(vx, vy) {
    coastStop();
    const speed = Math.hypot(vx, vy);
    if (!book || reduce() || !view?.requestAnimationFrame || speed < 0.02) return;
    const cap = Math.min(1, 1.2 / speed); // a hard flick turns the book about once more at most, not spin after spin
    const motion = { vx: vx * cap, vy: vy * cap, last: null, frame: 0 };
    const step = time => {
      if (!book || book.coast !== motion) return;
      const dt = motion.last === null ? 16 : Math.min(48, time - motion.last); motion.last = time;
      const x = book.spin.x + motion.vx * dt, y = book.spin.y + motion.vy * dt;
      if (Math.abs(x) >= 60) motion.vx = 0;
      turn(x, y);
      const keep = Math.exp(-dt / 350); motion.vx *= keep; motion.vy *= keep;
      if (Math.hypot(motion.vx, motion.vy) < 0.01) { book.coast = null; return; }
      motion.frame = view.requestAnimationFrame(step);
    };
    book.coast = motion; motion.frame = view.requestAnimationFrame(step);
  }
  function coastStop() { if (book?.coast) { view?.cancelAnimationFrame?.(book.coast.frame); book.coast = null; } }
  const markOut = (key, out) => { for (const spine of doc.querySelectorAll('.book-spine')) if (spine.getAttribute('data-focus-key') === key) spine.classList.toggle('is-out', out); };
  async function open(spine, agent) {
    if (book) return;
    const key = spine.getAttribute('data-focus-key'), g = geometry(spine), title = titleForSpine(agent);
    const el = node(doc, 'div', undefined, 'book-3d'); el.tabIndex = 0; el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `《${title}》封面，按 Enter 查看详情`);
    const style = view.getComputedStyle(spine), titleStyle = view.getComputedStyle(spine.querySelector('.spine-title') || spine);
    setStyle(el, { '--book-w': BOOK_W + 'px', '--book-h': BOOK_H + 'px', '--book-d': (spine.offsetWidth / g.s) + 'px', '--book-k': String(1 / g.s),
      '--book-color': style.getPropertyValue('--book-color').trim() || spinePalette[0], '--spine-font': ((parseFloat(titleStyle.fontSize) || 18) / g.s) + 'px',
      ...(parseFloat(titleStyle.maxWidth) ? { '--spine-title-w': (parseFloat(titleStyle.maxWidth) / g.s) + 'px' } : {}) });
    const face = (cls, ...children) => region(doc, 'div', 'book-face ' + cls, ...children);
    el.append(face('book-back'), face('book-pages'), face('book-top'), face('book-bottom'),
      face('book-spine-face', node(doc, 'span', title, 'book-spine-title')), face('book-front', bookCover(doc, agent)));
    const shadow = node(doc, 'div', undefined, 'book-ground');
    el.addEventListener('click', () => { if (book?.dragged) { book.dragged = false; return; } toDetail(); });
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toDetail(); return; }
      const step = { ArrowLeft: [0, -15], ArrowRight: [0, 15], ArrowUp: [10, 0], ArrowDown: [-10, 0] }[event.key];
      if (step) { event.preventDefault(); coastStop(); turn(book.spin.x + step[0], book.spin.y + step[1]); }
      else if (event.key === 'Home') { event.preventDefault(); coastStop(); turn(0, 0); }
    });
    // Drag to turn the book: across spins it, up and down tilts it (±60°). A press without movement is still a click.
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !book || !['cover', 'detail'].includes(book.state)) return;
      coastStop();
      book.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, spin: { ...book.spin }, samples: [] }; book.dragged = false;
      el.setPointerCapture?.(event.pointerId);
    });
    el.addEventListener('pointermove', event => {
      const drag = book?.drag; if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!book.dragged && Math.hypot(dx, dy) < 4) return;
      book.dragged = true; el.classList.add('is-turning');
      turn(drag.spin.x - dy * 0.4, drag.spin.y + dx * 0.5);
      const now = event.timeStamp ?? clock(); drag.samples.push({ t: now, x: event.clientX, y: event.clientY });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
    });
    // Let go while moving and the book keeps turning, slowing to a stop (2026-11-01): the speed of the last 100 ms.
    const release = (event, flung) => {
      const drag = book?.drag; if (drag?.id !== event.pointerId) return;
      book.drag = null; el.classList.remove('is-turning');
      const last = drag.samples.at(-1), first = drag.samples[0], dt = last && first ? last.t - first.t : 0;
      if (flung && book.dragged && dt > 0 && (event.timeStamp ?? clock()) - last.t < 80)
        coast(-(last.y - first.y) * 0.4 / dt, (last.x - first.x) * 0.5 / dt);
    };
    el.addEventListener('pointerup', event => release(event, true)); el.addEventListener('pointercancel', event => release(event, false));
    stage.prepend(shadow, el); stage.setAttribute('aria-label', `《${title}》`);
    book = { state: 'opening', agent, key, el, ground: shadow, g, pendingClose: false, spin: { x: 0, y: 0 }, drag: null, dragged: false, coast: null };
    fillInspect(agent, title);
    r.bookOutKey = key; markOut(key, true);
    stage.className = 'shelf-book-stage'; stage.showModal(); stage.focus();
    measureInspect(); const p = poses(g); el.style.transform = p.shelf;
    await run([p.shelf, p.pull], 260, OUT);                     // 1. pulled forward out of the row
    if (!book) return; ground('cover'); shadow.classList.add('on');
    await run([p.pull, p.cover], 860, SPRING);                  // 2. flies to the centre, turning to its cover
    if (!book) return; book.state = 'cover';
    if (book.pendingClose) return closeBook();
    stage.classList.add('is-cover'); reposition(); el.focus({ preventScroll: true });
  }
  async function toDetail() {
    if (book?.state !== 'cover') return;
    coastStop(); book.state = 'moving'; stage.classList.replace('is-cover', 'is-detail');
    r.detail.classList.toggle('beside-book', side()); ground('detail');
    const p = poses(book.g, book.spin), move = run([p.cover, p.detail], 560, SPRING);
    ctx.actions.openDetail(book.agent.id, book.el);
    await move; if (!book) return; book.state = 'detail';
    if (book.pendingClose || !r.detail.open) closeBook();
  }
  async function closeBook() {
    if (!book || !['cover', 'detail'].includes(book.state)) return;
    coastStop(); const from = book.state; book.state = 'closing'; book.pendingClose = false;
    stage.classList.replace('is-cover', 'is-closing'); stage.classList.replace('is-detail', 'is-closing'); book.ground.classList.remove('on');
    const g = (s => s ? geometry(s) : book.g)(spineOf(book.key)), p = poses(g); // re-measure: the shelf may have re-rendered
    // A book turned past its back goes home the short way round to the spine-out 90°, not the long way.
    const turned = poses(book.g, { ...book.spin, y: book.spin.y < -110 ? book.spin.y + 360 : book.spin.y });
    // One flight, eased in from rest and out into the slot: it glides to just in front of its slot and slides in without
    // stopping there. The waypoint sits where the spine face (the side that lands) moves at the same speed on both legs.
    const [x, y, s] = from === 'detail' ? detailAt() : coverAt(), fly = Math.hypot(x - BOOK_W / 2 * s - g.cx, y - g.cy + 28);
    await run([turned[from], { transform: p.pull, offset: Math.min(0.92, Math.max(0.6, fly / (fly + 28))) }, p.shelf], from === 'detail' ? 840 : 780, HOME);
    if (book) finish(true);
  }
  function finish(focus) {
    coastStop(); const key = book.key; book.el.remove(); book.ground.remove(); book = null; r.bookOutKey = null;
    markOut(key, false); r.detail.classList.remove('beside-book');
    if (stage.open) stage.close();
    if (focus) spineOf(key)?.focus({ preventScroll: true });
  }
  // Esc, × or a click on the dim room; during a flight the request waits until the book has landed.
  function closeAny() {
    if (!book) return;
    if (book.state === 'opening' || book.state === 'moving') book.pendingClose = true; else closeBook();
  }
  stage.addEventListener('cancel', event => { event.preventDefault(); closeAny(); });
  stage.addEventListener('click', event => { if (event.target === stage) closeAny(); });
  // Closing the detail (its 关闭, Esc or the app) puts the book back as well.
  r.detail.addEventListener('close', () => { if (book && ['moving', 'detail'].includes(book.state)) closeAny(); });
  // Beside the book, the detail's transparent backdrop is the dim room: a click there closes like the stage's.
  r.detail.addEventListener('click', event => {
    if (event.target !== r.detail || !r.detail.classList.contains('beside-book')) return;
    const box = r.detail.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) ctx.actions.closeDetail();
  });
  function reposition() {
    measureInspect();
    if (!book || !['cover', 'detail'].includes(book.state)) return;
    book.el.style.transform = poses(book.g, book.spin)[book.state]; ground(book.state);
  }
  view?.addEventListener?.('resize', reposition);
  r.bookStage = { open, dispose: () => { if (book) finish(false); } };
  return stage;
}
function catalogItem(ctx, agent) {
  const { doc, actions: a } = ctx, role = agent.kind === 'role';
  const item = region(doc, 'article', 'shelf-item');
  if (ctx.state.selectedId === agent.id) item.setAttribute('data-selected', 'true');
  const open = control(ctx, '', '', e => {
    const spine = e.currentTarget;
    return !role && ctx.refs.bookStage && canPullOut(doc, spine) ? ctx.refs.bookStage.open(spine, agent) : a.openDetail(agent.id, spine);
  }, '查看 ' + agent.name + ' 详情', role ? 'staff-badge' : 'book-spine');
  markAgentLink(open,agent);open.setAttribute('data-focus-key', 'card-detail-' + agent.id);
  if (role) {
    const use = node(doc, 'span', purpose(agent)); use.title = use.textContent;
    open.append(node(doc, 'small', 'STAFF'), markAgentLink(node(doc, 'strong', agent.name), agent), use);
  }
  else {
    const size = bookDimensions(agent);
    open.setAttribute('data-agent', identity(agent)); open.setAttribute('data-member', agent.id);
    setStyle(open, { height: size.height + 'px', width: size.width + 'px', '--book-color': size.color });
    open.title = (agent.bookLabel || bookLabel(agent)) + ' · ' + (agent.book?.author || authorShort(agent) || '作者未载明') + ' · ' + agent.name;
    const edge = node(doc, 'span', undefined, 'spine-edge'); edge.setAttribute('aria-hidden', 'true');
    open.append(edge, markAgentLink(node(doc, 'span', titleForSpine(agent), 'spine-title'), agent));
  }
  markAgentLink(open,agent);item.append(open, deskAction(ctx, agent)); return item;
}
// While a book is pulled out its slot stays empty, also across re-renders of the shelf.
function markPulledOut(ctx, item) {
  const spine = item.querySelector('.book-spine');
  if (spine && ctx.refs.bookOutKey && spine.getAttribute('data-focus-key') === ctx.refs.bookOutKey) spine.classList?.add('is-out');
  return item;
}
// The last book of a row leans on its neighbour: it pivots on its bottom-left corner, and its slot opens just enough
// (contact height × tan θ) for its left edge to rest on the neighbour's top corner instead of cutting into it.
function leanLastBook(books, row) {
  if (books.length < 2) return;
  const last = bookDimensions(books.at(-1)), previous = bookDimensions(books.at(-2));
  let hash = 0; for (const char of books.at(-1).id) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const theta = (7 + hash % 3) * Math.PI / 180, contact = Math.min(last.height * Math.cos(theta), previous.height);
  const item = row.children[row.children.length - 1], spine = item?.querySelector('.book-spine');
  if (!spine) return;
  // On the item, so its spine and its 放上书桌 button tilt together.
  setStyle(item, { '--lean': `-${(theta * 180 / Math.PI).toFixed(2)}deg`, 'margin-left': `${Math.max(0, contact * Math.tan(theta) - 3).toFixed(1)}px` });
}
// The same agent also stands on its own shelf, so the pinned copy gets its own focus keys.
function pinnedItem(ctx, agent) {
  const item = catalogItem(ctx, agent);
  for (const button of item.querySelectorAll('button')) button.setAttribute('data-focus-key', 'pinned-' + button.getAttribute('data-focus-key'));
  return markPulledOut(ctx, item);
}
export function renderCategories(ctx) {
  renderCandidateNotice(ctx, ctx.state.candidateCount);
  // Category navigation is each layer's heading and “整排查看”, rendered with its books.
}
// Long titles thicken their book before the text shrinks (2026-11-01): the spine widens 4px at a time up to
// 84px while the title keeps 18–15px, then the font goes down to 12px. Measured after insertion into a visible shelf.
const SPINE_MAX = 84, SPINE_PAD = 3;
function fitSpineTitles(root) {
  let measured = true;
  for (const title of root.querySelectorAll('.spine-title')) {
    const spine = title.parentElement;
    if (!title.clientWidth || !title.clientHeight) { measured = false; continue; }
    const fits = () => title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight;
    if (!spine.getAttribute('data-width')) spine.setAttribute('data-width', String(spine.offsetWidth || 52));
    const base = spine.getAttribute('data-width');
    const tryAt = (width, size) => {
      setStyle(spine, { width: width + 'px' });
      setStyle(title, { 'font-size': size + 'px', 'max-width': (width - SPINE_PAD) + 'px' });
      return fits();
    };
    let done = false;
    for (let width = Number(base); width <= SPINE_MAX && !done; width += 4) for (let size = 18; size >= 15 && !done; size--) done = tryAt(width, size);
    for (let size = 14; size >= 12 && !done; size--) done = tryAt(SPINE_MAX, size);
  }
  return measured;
}
export function renderCatalog(ctx, model) {
  const { doc, refs: r, actions: a, state: s } = ctx;
  if (r.search.value !== model.query) r.search.value = model.query;
  r['view-title'].textContent = model.title; r['view-title'].hidden = !model.query.trim();
  // Polling must not replace the focused book or reset horizontal shelf scrolling.
  const staff = ordered(s.allAgents.filter(agent => agent.kind === 'role' && (!model.query.trim() || matchesSearch(agent, model.query))), staffOrder);
  const key = JSON.stringify([staff, model.agents, model.sort, model.categories, s.category, s.selectedId, model.query, s.pinnedIds, bookOrder(s)]);
  if (r.catalogKey !== key) {
    r.catalogKey = key;
    r.catalogNeedsFit = true;
    const scroll = new Map(Array.from(r.navigation.querySelectorAll('.book-row')).map(row => [row.getAttribute('data-category'), row.scrollLeft]));
    const staffScroll = r['shelf-staff'].scrollLeft;
    r['shelf-staff'].replaceChildren(...staff.map(agent => catalogItem(ctx, agent)));
    r['shelf-staff'].hidden = !staff.length; r['shelf-staff'].scrollLeft = staffScroll || 0;
    r['shelf-staff-strip'].hidden = !staff.length;
    // Measure after layout; fall back to an immediate update where rAF is unavailable (tests).
    const raf = ctx.doc.defaultView?.requestAnimationFrame; if (raf) raf(() => r.updateStaffArrows?.()); else r.updateStaffArrows?.();
    r.navigation.replaceChildren();
    // v0.29 常用: pinned agents, books and colleagues alike, stand on the top shelf of the room's full view.
    const pinned = s.category === 'all' && !model.query.trim() ? (s.pinnedIds || []).map(id => s.allAgents.find(agent => agent.id === id)).filter(Boolean) : [];
    if (pinned.length) {
      const row = region(doc, 'div', 'book-row', ...pinned.map(agent => pinnedItem(ctx, agent)));
      row.setAttribute('data-category', '常用');
      r.navigation.append(region(doc, 'section', 'shelf-layer shelf-pinned', region(doc, 'div', 'shelf-layer-heading', node(doc, 'h3', '常用')), row, region(doc, 'div', 'wood-edge')));
    }
    const order = categoryOrder(model.categories);
    for (const category of order) {
      let books = model.agents.filter(agent => agent.kind === 'book' && agent.primary === category);
      const single = s.category === category && !model.query.trim();
      if (!books.length && !single) continue;
      if (model.sort === 'default') books = ordered(books, bookOrder(s));
      const viewAll = control(ctx, '', '整排查看', () => { a.search(''); a.selectCategory(category); }, '整排查看 ' + category, 'shelf-link shelf-view-all');
      viewAll.append(region(doc, 'span', 'shelf-chevron', icon(doc, 'chevron')));
      const heading = region(doc, 'div', 'shelf-layer-heading', node(doc, 'h3', category), viewAll);
      const row = region(doc, 'div', 'book-row', ...books.map(agent => markPulledOut(ctx, catalogItem(ctx, agent))));
      leanLastBook(books, row);
      row.setAttribute('data-category', category); row.scrollLeft = scroll.get(category) || 0;
      if (!books.length) row.append(node(doc, 'p', '当前分类没有书籍。', 'muted'));
      r.navigation.append(region(doc, 'section', 'shelf-layer', heading, row, region(doc, 'div', 'wood-edge')));
    }
    // Books rise into place one after another when the room or a category opens, not on every repaint.
    Array.from(r.navigation.querySelectorAll('.book-spine')).forEach((spine, index) => setStyle(spine, { '--i': String(Math.min(index, 24)) }));
    const shape = JSON.stringify([s.category, model.sort]);
    if (r.catalogShape !== shape) { r.catalogShape = shape; enter(r.navigation, 1000); }
    r['shelf-empty'].textContent = model.query ? '没有匹配的 Agent' : '当前分类没有 Agent。';
    r['shelf-empty'].hidden = !!model.agents.length || !!staff.length;
  }
  updateVisibility(ctx);
  if (s.view === 'catalog' && r.catalogNeedsFit) {
    r.catalogNeedsFit = !fitSpineTitles(r.navigation);
  }
}
export function renderDetail(ctx, model) {
  const { doc, refs: r, actions: a, state: s } = ctx, body = r['detail-body'];
  const key = JSON.stringify(model);
  if (r.detailKey !== key) {
    const expanded = new Set(Array.from(body.querySelectorAll('details')).filter(n => n.open).map(n => n.getAttribute('data-section')));
    const sameAgent = r.detailAgent === model?.id; r.detailAgent = model?.id; r.detailKey = key;
    r['detail-title'].textContent = model?.name || '请选择 Agent'; r['detail-title'].removeAttribute('data-agent-link'); if(model)markAgentLink(r['detail-title'],model); body.replaceChildren();
    if (model) {
      if (model.book) body.append(markAgentLink(node(doc, 'p', [bookLabel(model), model.book.author, model.book.edition].filter(Boolean).join(' · '), 'detail-book'), model));
      const chips = region(doc, 'div', 'detail-chips');
      for (const chip of model.chips) { const el = node(doc, 'span', chip.label, 'detail-chip'); el.title = chip.title || ''; chips.append(el); }
      body.append(chips, node(doc, 'p', model.summary || '无描述', 'description'));
      const controls = region(doc, 'div', 'actions');
      for (const [cli, name] of [['claude','Claude'],['codex','Codex']]) {
        const launch = control(ctx, '', '在 ' + name + ' CLI 中调用', () => a.launch(model.id, cli), '在 ' + name + ' CLI 中调用 ' + model.name);
        launch.disabled = model.launchBusy || !model.platforms[cli]?.available;
        launch.title = model.platforms[cli]?.reason || '';
        controls.append(launch);
        if (!model.platforms[cli]?.available) {
          const reason = node(doc, 'p', launch.title || '入口不可用', 'reason'); reason.id = 'detail-' + cli + '-reason';
          launch.setAttribute('aria-describedby', reason.id); controls.append(reason);
        }
      }
      controls.append(inAppButton(doc, model, a), deskAction(ctx, model, true),pinButton(doc,model,a),openFileButton(doc,model,a),...(model.kind === 'book' ? reportButtons(ctx, model) : [])); body.append(controls);
      if (model.launchStatus) { const status = node(doc, 'div'); renderStatus(doc, status, model.launchStatus); body.append(status); }
      body.append(node(doc, 'p', model.statsState === 'building' ? '统计中…' : model.stats7 === null ? '调用统计：暂无数据' : '近 7 天 ' + model.stats7 + ' · 累计 ' + model.statsTotal, 'detail-stats'));
      const full = node(doc, 'details'); full.setAttribute('data-section', 'description'); full.open = sameAgent && expanded.has('description');
      full.append(node(doc, 'summary', '完整说明'), node(doc, 'p', plainDescription(model.fullDescription), 'full-description'));
      full.querySelector('summary').setAttribute('data-focus-key', 'detail-full-summary'); body.append(full);
      for (const section of model.sections) {
        const fold = node(doc, 'details'); fold.setAttribute('data-section', section.key); fold.open = sameAgent && expanded.has(section.key);
        const title = node(doc, 'summary', section.title); title.setAttribute('data-focus-key', 'detail-section-' + section.key);
        const rows = node(doc, 'dl');
        for (const row of section.rows) rows.append(node(doc, 'dt', row.label), markAgentLink(node(doc, 'dd', row.label === '书名' ? bookLabel(model) : row.value), row.label === '书名' ? model : null));
        fold.append(title, rows); body.append(fold);
      }
      const history = node(doc, 'section');
      drawAgentHistory(doc, history, model, model.history, item => a.resume(model.id, item.cli, item.launchId), () => a.reverifyAgent(model.id));
      body.append(history); if (model.historyMessage) history.append(node(doc, 'p', model.historyMessage, 'reason'));
    }
  }
  if (s.detailOpen && s.view !== 'history') { if (!r.detail.open) r.dialog.open(); }
  else if (!s.detailOpen && r.detail.open) r.dialog.close();
}
export function renderMetrics(ctx, model) {
  const { doc, refs: r } = ctx;
  r['shelf-subtitle'].textContent = model.books + ' 本书 · ' + model.roles + ' 位同事 · 点书脊，向作者提问';
  r.metrics.replaceChildren(node(doc, 'p', '近 7 天调用：' + (model.recent7 ?? (model.statsState === 'building' ? '统计中…' : '暂无数据')) +
    ' · Agent ' + model.total + ' · 同步 ' + (model.sync.ok ?? '未知') + '/' + model.sync.total));
  if (model.scopeLimited) { const info = node(doc, 'span', 'ⓘ', 'scope-info'); info.title = model.scopeReasons.join('\n'); info.setAttribute('aria-label', '统计范围有限：' + info.title); r.metrics.append(info); }
}
function lendingCard(ctx, item, detail = false) {
  const { doc, actions: a } = ctx, names = item.agents.map(agent => agent.name).join('、');
  const card = region(doc, 'article', 'lending-card');
  const date = node(doc, 'time', formatDate(item.createdAt), 'lending-stamp'); date.setAttribute('datetime', item.createdAt || '');
  const type = node(doc, 'span', item.typeLabel || (item.type === 'joint' ? '联合' : '单次'), 'lending-type');
  const cli = item.cliLabel || (item.cli === 'claude' ? 'Claude' : item.cli === 'codex' ? 'Codex' : item.cli || '未声明');
  const state = item.status?.message?.endsWith(' · 会话已结束') ? item.status.message : labels[item.status?.overall] || item.status?.overall || '未确认';
  const chip = node(doc, 'span', state, 'lending-state');
  chip.setAttribute('data-tone', ['ok','fail','running','pending','neutral'].includes(item.statusTone) ? item.statusTone : 'pending');
  card.append(region(doc, 'div', 'lending-stamps', date, type),
    control(ctx, '', '借阅人：' + names, e => a.selectHistory(item.type, item.id, e.currentTarget), '查看调用记录 ' + names, 'lending-members'),
    region(doc, 'p', 'lending-meta', node(doc, 'span', (item.type === 'joint' ? item.agents.length + ' 个 · ' : '') + cli), chip));
  if (item.inputPreview) card.append(node(doc, 'p', item.inputPreview, 'history-preview'));
  if (detail) card.append(node(doc, 'p', '模式：' + (item.modeLabel || item.mode || '未声明') + ' · 来源：' + (item.sourceLabel || item.source || '未声明') + (item.resumeOf ? ' · 恢复自 ' + item.resumeOf : '') + (item.rerunOf ? ' · 重跑自 ' + item.rerunOf : '')));
  const rerun = control(ctx, '', '再借一次', () => a.rerun(item.type, item.id), '重新调用');
  const resume = control(ctx, '', '继续阅读', () => a.resumeHistory(item.type, item.id), '继续该次会话');
  for (const [el, verb] of [[rerun,'rerun'],[resume,'resume']]) {
    el.setAttribute('data-focus-key', 'history-' + verb + '-' + (detail ? 'detail-' : '') + item.type + '-' + item.id);
    el.title = names; el.disabled = !!ctx.refs.historyBusy;
  }
  resume.disabled ||= !item.canResume;
  if (!item.canResume) {
    const reason = node(doc, 'p', item.resumeReason || '此会话尚不可恢复', 'reason');
    reason.id = 'resume-reason-' + (detail ? 'detail-' : '') + item.type + '-' + item.id;
    resume.title = reason.textContent; resume.setAttribute('aria-describedby', reason.id); card.append(reason);
  }
  fillAgentNames(doc,card.querySelector('.lending-members'),item.agents,'借阅人：');card.append(region(doc, 'div', 'actions', rerun, resume)); return card;
}
export function renderHistory(ctx, model) {
  const { doc, refs: r } = ctx; r.historyBusy = model.busy;
  r['history-filter'].value = model.filter; r['history-status'].textContent = model.message;
  r['history-list'].replaceChildren(...model.items.map(item => lendingCard(ctx, item)));
  if (!model.items.length) r['history-list'].append(node(doc, 'p', '暂无借阅记录'));
  if (ctx.state.view === 'history' && ctx.state.detailOpen && model.selected) {
    r['detail-title'].textContent = '借阅记录';r['detail-title'].removeAttribute('data-agent-link');
    r['detail-body'].replaceChildren(lendingCard(ctx, model.selected, true)); r.detailKey = null;
    if (!r.detail.open) r.dialog.open();
  }
}
export function renderRunning(ctx, items) {
  const { refs: r, state: s } = ctx;
  r['shelf-reading'].replaceChildren(node(ctx.doc, 'span', '', 'shelf-live-dot'), node(ctx.doc, 'span', '在读 '), node(ctx.doc, 'b', String(items.length)));
  r['shelf-reading'].hidden = !items.length;
  updateRunningClose(ctx,items);drawRunning(ctx.doc, r['running-list'], { items },ctx);
  r['reverify-all'].disabled = s.reverifyBusy; r['reverify-all-status'].textContent = s.reverifyMessage;
}
export function renderCoverage(ctx, model) {
  const { doc, refs: r } = ctx, registry = model.registry;
  drawCoverage(doc, r['stats-detail'], model.stats);
  r['stats-summary'].textContent = '数据覆盖 · ' + (model.stats?.building ? '统计中…' : model.stats?.limited ? '统计范围有限' : model.stats ? '来源可读' : '暂无数据');
  r['scan-summary'].textContent = '目录扫描 · ' + formatDate(registry.scannedAt) + ' · 范围外 ' + (registry.summary.outOfScope || 0) + ' · 无法解析 ' + (registry.summary.failed || 0);
  const target = r['scan-detail']; target.replaceChildren();
  const rows = [['来源明细', registry.sources.map(s => s.path + '：' + (s.available ? '文件 ' + s.total + '，解析 ' + s.parsed + '，排除 ' + s.excluded : '不可读 · ' + s.reason))],
    ['无法解析', registry.sources.flatMap(s => (s.failed || []).map(f => f.file + '：' + f.reason))],
    ['范围外', registry.outOfScope.map(a => a.name + '：' + a.reason)], ['身份冲突', registry.conflicts.map(c => c.id + '：' + c.reason + ' · ' + c.files.join('；'))],
    ['映射存在、目录缺失', registry.missingFromDisk.map(a => a.name)],
    ...(registry.reports ? [['无 Word 报告的书籍', registry.reports.booksWithout.map(a => `${a.name}：${a.title}`)],
      ['未登记的 Word 报告文件', registry.reports.unusedFiles]] : [])];
  for (const [title, values] of rows) { target.append(node(doc, 'h3', title)); for (const text of values.length ? values : ['无']) target.append(node(doc, 'p', text)); }
}
export function renderRecommend(ctx, model) {
  const { doc, refs: r, actions: a } = ctx, rec = model.recommendation;
  if (r['recommend-input'].value !== model.input) r['recommend-input'].value = model.input;
  r['recommend-count'].textContent = model.input.length + ' / 8000 字';
  r['recommend-engine'].value = model.engine; r['joint-cli'].value = model.cli;
  const engine = model.settings?.recommend?.[model.engine];
  r['recommend-model'].textContent = engine ? 'model ' + engine.model + ' · effort ' + engine.effort : '模型未声明';
  r['recommend-submit'].disabled = model.busy || !model.input.trim() || model.input.length > 8000;
  r['joint-submit'].disabled = !model.selectedIds.length || model.busy || model.jointBusy;
  r['selected-count'].textContent = '已选 ' + model.selectedIds.length + ' 个';
  r['select-all'].disabled = !model.results.length || model.busy || model.jointBusy;
  r['select-all'].checked = !!model.results.length && model.selectedIds.length === model.results.length;
  r['select-all'].indeterminate = model.selectedIds.length > 0 && model.selectedIds.length < model.results.length;
  r['recommend-disabled-reason'].textContent = model.busy ? '推荐进行中，请等待。' : !model.input.trim() ? '请输入问题或内容。' : model.input.length > 8000 ? '输入不能超过 8000 字。' : '可开始分析。';
  r['joint-disabled-reason'].textContent = model.jointBusy ? '联合调用启动中，请等待。' : model.busy ? '推荐进行中，请等待。' : !model.selectedIds.length ? '请至少选择一个 Agent。' : '可执行联合调用。';
  const status = r['recommend-status']; status.replaceChildren(); status.className = '';
  if (rec) {
    status.append(node(doc, 'p', '推荐：' + (labels[rec.status] || rec.status) + ' · ' + rec.engine + ' · ' + (rec.model || '未声明') + ' · effort ' + (rec.effort || '未声明')));
    if (rec.error) status.append(node(doc, 'p', rec.error, 'error')); if (rec.note) status.append(node(doc, 'p', rec.note));
    if (rec.status === 'done') {
      if (!model.results.length) status.append(node(doc, 'p', '没有合适的 Agent'));
      if (rec.audit?.ok) status.append(node(doc, 'p', '推荐审计通过：Agent 调用 ' + rec.audit.agentCalls + '，子会话 ' + rec.audit.children));
      else if (rec.audit?.agentCalls > 0 || rec.audit?.children > 0) status.append(node(doc, 'strong', '推荐阶段出现了 Agent 调用', 'audit-error'));
      else status.append(node(doc, 'p', '推荐审计未确认：' + (rec.audit?.error || '缺少证据'), 'audit-error'));
      for (const reject of rec.rejected || []) status.append(node(doc, 'p', '被拒绝的推荐：' + reject.id + ' · ' + (reject.reason || ''), 'reason'));
    }
  }
  r['recommend-results'].replaceChildren();
  for (const agent of model.results) {
    const card = region(doc, 'article', 'recommend-card',
      control(ctx, '', agent.name, e => a.openDetail(agent.id, e.currentTarget), '查看 ' + agent.name + ' 详情', 'recommend-member'),
      markAgentLink(node(doc, 'p', agent.kind === 'book' ? bookLabel(agent) : purpose(agent)), agent), node(doc, 'p', agent.summary));
    const check = node(doc, 'input'); check.type = 'checkbox'; check.checked = agent.selected;
    check.disabled = model.busy || model.jointBusy || (!check.checked && model.selectedIds.length >= 8);
    check.setAttribute('data-focus-key', 'recommend-check-' + agent.id); check.setAttribute('aria-label', '选择 ' + agent.name);
    check.addEventListener('change', () => a.selectRecommendationAgent(agent.id, check.checked));
    markAgentLink(card.querySelector('.recommend-member'),agent);card.append(markAgentLink(label(ctx, '加入联合调用 ' + agent.name, check),agent), node(doc, 'p', '模型理由：' + agent.reason));
    if (!agent.platforms[model.cli.replace('inapp:', '')]?.available) card.append(node(doc, 'p', model.cli.replace('inapp:', '') + ' 不可用：' + (agent.platforms[model.cli.replace('inapp:', '')]?.reason || '入口不可用'), 'reason'));
    r['recommend-results'].append(card);
  }
  const recent = r['recent-list']; recent.replaceChildren();
  for (const item of model.recent) {
    if (item.type === 'recommend') recent.append(region(doc, 'div', 'recent-recommend', control(ctx, '', '推荐 · ' + item.engine + ' · ' + item.status + ' · ' + formatDate(item.createdAt), () => a.selectRecommendation(item.id)), node(doc, 'p', item.preview)));
    else { const card = region(doc, 'article', 'joint-card'); drawJointStatus(doc, card, item, item.verification); card.append(control(ctx, '', '重新核验', () => a.reverifyJoint(item.id))); recent.append(card); }
  }
  if (!model.recent.length) recent.append(node(doc, 'p', '暂无推荐与联合调用记录'));
}

export function drawCoverage(doc, target, stats) {
  if (!target) return;
  target.replaceChildren();
  if (!stats) { target.append(node(doc, 'p', '统计中…')); return; }
  target.append(node(doc, 'p', stats.building ? '统计中…' : `更新时间（本机时区）：${formatDate(stats.generatedAt)}`));
  if (stats.dataDirMigration) target.append(node(doc, 'p', stats.dataDirMigration));
  for (const source of stats.sources) {
    target.append(node(doc, 'h3', source.id), node(doc, 'p', `${source.path}：${source.available ? '可读' : '不可读'} · 文件 ${source.files} / 解析 ${source.parsedFiles} · 坏行 ${source.badLines}`),
      node(doc, 'p', `覆盖（本机时区）：${formatDate(source.earliestAt)} → ${formatDate(source.latestAt)}`));
    const failures = node(doc, 'ul');
    for (const failed of source.failedFiles) failures.append(node(doc, 'li', `${failed.file}：${failed.reason}`));
    target.append(failures);
    for (const note of source.notes || []) target.append(node(doc, 'p', note, 'reason'));
  }
  target.append(node(doc, 'p', `范围外事件 ${stats.outOfScopeEvents} · 未标注角色的子会话 ${stats.unlabeledSubagents}`));
  for (const reason of stats.limitedReasons) target.append(node(doc, 'p', reason, 'reason'));
  if (stats.explanations?.length) {
    target.append(node(doc, 'h3', '说明'));
    for (const text of stats.explanations) target.append(node(doc, 'p', text));
  }
}
const stateNames = { alive: '存活', exited: '已退出', ok: '通过', mismatch: '不符', pending: '待核验', confirmed: '已确认', 'awaiting-first-call': '首次提问后核验' };
export function renderStatus(doc, target, status) {
  target.hidden = false; target.className = `status ${status.overall}`;
  target.replaceChildren();
  if (status.notice && ['pending', 'unconfirmed'].includes(status.overall)) {
    const notice = node(doc, 'p', status.notice, 'launch-notice');
    notice.setAttribute('role', 'note'); target.append(notice);
  }
  target.append(node(doc, 'strong', status.message || status.overall));
  if (status.terminalFallback === 'no-wt') target.append(node(doc, 'div', '未找到 Windows Terminal，窗口位置未控制', 'reason'));
  for (const [key, label] of [['process', '进程'], ['cwd', '目录'], ['agent', 'Agent'], ['waiting', '等待输入']]) {
    const item = status[key];
    const extra = key === 'process' && item.pid ? ` · PID ${item.pid}` : key === 'cwd' && item.observed ? ` · ${item.observed}` : '';
    target.append(node(doc, 'div', `${label}：${stateNames[item.state] || item.state}${extra}`));
  }
  if (status.evidenceError) target.append(node(doc, 'div', status.evidenceError, 'reason'));
}
export function pollFinished(status) {
  return ['failed', 'unconfirmed', 'resumed'].includes(status.overall) || (status.overall === 'ready' && status.agent?.state === 'confirmed');
}
const reverifySummary = summary => `已核验 ${summary.checked} 条：找到 ${summary.found} 条，未找到 ${summary.notFound} 条`;
export function drawAgentHistory(doc, target, agent, history, onResume, onReverify) {
  target.replaceChildren(node(doc, 'h3', '继续上次会话'));
  const list = node(doc, 'div'), live = node(doc, 'p'); live.setAttribute('aria-live', 'polite'); live.setAttribute('role', 'status');
  const recheck = action(doc, '重新核验旧记录', async () => {
    if (recheck.disabled) return;
    recheck.disabled = true; recheck.setAttribute('aria-busy', 'true'); live.textContent = '正在重新核验旧记录…';
    try { const result = await onReverify(); draw(result.history); live.textContent = reverifySummary(result.summary); }
    catch (problem) { live.textContent = `重新核验失败：${problem.message}`; }
    finally { recheck.disabled = false; recheck.setAttribute('aria-busy', 'false'); }
  });
  recheck.setAttribute('data-focus-key', `reverify-${agent.id}`);
  recheck.setAttribute('aria-label', `重新核验 ${agent.name} 的旧记录`);
  function draw(value) {
    let firstResume;
    list.replaceChildren();
    for (const item of value.items) {
      const resume = action(doc, `${formatDate(item.createdAt)} · ${item.cli} · ${item.mode}`, () => onResume(item));
      resume.className = 'agent-resume';
      resume.setAttribute('data-focus-key', `resume-${agent.id}-${item.launchId}`);
      resume.setAttribute('aria-label', `继续上次会话 ${agent.name} · ${formatDate(item.createdAt)} · ${item.cli} · ${item.mode}`);
      firstResume ??= resume;
      list.append(resume);
    }
    if (!value.items.length) {
      const unavailable = action(doc, '继续上次会话', () => {}); unavailable.disabled = true;
      unavailable.setAttribute('aria-label', `继续上次会话 ${agent.name}`);
      const reason = node(doc, 'p', '暂无可恢复的已核验会话'); reason.id = `resume-${agent.id}-reason`;
      unavailable.setAttribute('aria-describedby', reason.id); list.append(unavailable, reason);
    }
    for (const item of value.unavailable || []) list.append(node(doc, 'p', item.reason, 'reason'));
    recheck.hidden = !onReverify || !(value.unavailable || []).some(item => item.canReverify);
    if (recheck.hidden && doc.activeElement === recheck) firstResume?.focus();
  }
  draw(history); target.append(list);
  if (onReverify && (history.unavailable || []).some(item => item.canReverify)) target.append(recheck, live);
}
export function drawRunning(doc, target, value, ctx) {
  if (!target) return;
  const states = { pending: '待核验', ready: '已就绪', resumed: '已恢复', failed: '失败', unconfirmed: '未确认', done: '完成' };
  target.replaceChildren();
  for (const item of value.items) {
    const row=fillAgentNames(doc,node(doc,'p'),runningMembers(item));
    row.append(node(doc,'span',` · ${item.cli} · ${formatDate(item.createdAt)} · ${states[item.status?.overall] || item.status?.overall || '待核验'}${item.status?.terminalFallback === 'no-wt' ? ' · 未找到 Windows Terminal，窗口位置未控制' : ''}`));target.append(ctx?runningCloseRow(ctx,item,row):row);
  }
  if (!value.items.length) target.append(node(doc, 'p', '暂无运行中的会话'));
}
const labels = { closed: '已关闭', pending: '待核验', running: '运行中', ready: '已就绪', resumed: '已恢复', done: '完成', failed: '失败', unconfirmed: '未确认', ok: '通过', 'not-parallel': '未并行', violation: '越权', alive: '存活', exited: '已退出', mismatch: '不符' };
export function drawJointStatus(doc, target, record, status) {
  target.replaceChildren(node(doc, 'h3', `联合调用 · ${record.cli}`), fillAgentNames(doc,node(doc,'p'),record.whitelist.map(a=>({...a,name:record.cli==='claude'?a.claudeName:a.codexName})),'白名单：'));
  target.append(node(doc, 'p', '结果请在 CLI 窗口中查看'));
  if (record.terminalFallback === 'no-wt' || status?.terminalFallback === 'no-wt') target.append(node(doc, 'p', '未找到 Windows Terminal，窗口位置未控制', 'reason'));
  if (!status) { target.append(node(doc, 'p', '正在读取核验记录…')); return; }
  target.className = `joint-card ${status.overall}`;
  // A call closed before its first verification carries no cwd (closedStatus); show only the facts present.
  const facts = [['process', '进程'], ['cwd', '目录']].filter(([key]) => status[key]).map(([key, label]) => ` · ${label}：${labels[status[key].state] || status[key].state}`);
  target.append(node(doc, 'p', `整体：${status.message || labels[status.overall] || status.overall}${facts.join('')}`));
  if (record.resumeOf || status.overall === 'resumed' || !status.parallel) {
    target.append(node(doc, 'p', status.message || '恢复会话核验中'));
    if (status.evidenceError) target.append(node(doc, 'p', status.evidenceError, 'error'));
    return;
  }
  for (const [key, label] of [['parallel','并行'],['whitelist','白名单'],['crossExam','交叉质询']]) if (status[key]) target.append(node(doc, 'p', `${label}：${labels[status[key].state] || status[key].state}`));
  for (const call of status.calls) target.append(node(doc, 'p', `${call.agent}：${labels[call.state] || call.state}`));
  for (const attempt of status.whitelist.deniedAttempts) target.append(node(doc, 'p', `平台已拒绝尝试：${attempt.agent} · ${JSON.stringify(attempt.evidence)}`, 'reason'));
  for (const violation of status.whitelist.violations) target.append(node(doc, 'p', `越权调用：${violation.agent} · ${JSON.stringify(violation)}`, 'reason'));
  if (status.taskTextNote) target.append(node(doc, 'p', status.taskTextNote, 'reason'));
  if (status.evidenceError) target.append(node(doc, 'p', status.evidenceError, 'error'));
  const evidence = node(doc, 'details'); evidence.append(node(doc, 'summary', '核验证据'), node(doc, 'pre', JSON.stringify({ parallel: status.parallel.evidence, calls: status.calls }, null, 2)));
  target.append(evidence);
}

const statsRanges = { '7d': '近 7 天', '30d': '近 30 天', all: '累计' };
function statsButton(ctx, key, text, run, pressed, cls = '') {
  const button = control(ctx, 'shelf-stats-' + key, text, run, text, cls);
  button.setAttribute('data-focus-key', 'stats-' + key);
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  return button;
}
function buildStats(ctx) {
  const { doc, actions: a } = ctx;
  const board = field(ctx, 'section', 'stats-panel', undefined, 'shelf-stats-board');
  board.hidden = true; board.setAttribute('aria-labelledby', 'stats-title');
  const title = field(ctx, 'h2', 'stats-title', '借阅统计板'); title.setAttribute('tabindex', '-1');
  const ranges = region(doc, 'div', 'shelf-stats-controls', ...Object.entries(statsRanges).map(([key, text]) =>
    statsButton(ctx, key, text, () => a.setStatsRange(key), false)));
  ranges.setAttribute('role', 'group'); ranges.setAttribute('aria-label', '统计时间范围');
  const notice = field(ctx, 'div', 'stats-limited', undefined, 'shelf-stats-limited'); notice.setAttribute('role', 'status'); notice.hidden = true;
  const status = field(ctx, 'p', 'stats-status', '', 'shelf-stats-status'); status.setAttribute('role', 'status');
  board.append(region(doc, 'header', 'shelf-stats-toolbar',
    region(doc, 'div', '', node(doc, 'p', '书房 · 调用统计', 'shelf-concept-eyebrow'), title),
    region(doc, 'div', 'workflow-actions', statsButton(ctx, 'back', '返回书房', () => a.showView('catalog'), undefined, 'shelf-link'),
      statsButton(ctx, 'refresh', '刷新统计', a.refreshStats, undefined, 'shelf-outline'))),
    ranges, notice, status, field(ctx, 'div', 'stats-content', undefined, 'shelf-stats-content'));
  return board;
}
function statsCard(doc, title, cls, ...children) {
  const card = region(doc, 'section', 'shelf-stats-card ' + cls, node(doc, 'h3', title), ...children);
  card.setAttribute('aria-label', title); return card;
}
function statsDonut(doc, segments, centerLabel, centerValue, onSelect, selected) {
  const chart = donut({ segments, centerLabel, centerValue, onSelect }, doc);
  for (const slice of chart.querySelectorAll('[data-segment]')) slice.setAttribute('aria-pressed', String(slice.getAttribute('data-segment') === selected));
  const legend = chart.querySelector('.chart-legend');
  for (const [index, button] of Array.from(legend.children).entries()) {
    button.className = segments[index].colorClass;
    button.setAttribute('aria-pressed', String(segments[index].key === selected));
  }
  return chart;
}
const statsParts = value => [
  { key: 'claude', value: value.claude, colorClass: 'shelf-chart-claude' },
  { key: 'codex', value: value.codex, colorClass: 'shelf-chart-codex' },
];
function statsBars(ctx, agents) {
  return barList({ rows: agents.map(agent => ({ id: agent.id, label: agent.name,
    sublabel: agent.bookLabel || agent.purpose || '用途未载明', value: agent.value, parts: statsParts(agent) })),
    onSelect: id => ctx.actions.openDetail(id) }, ctx.doc);
}
export function renderStats(ctx, model) {
  const { doc, refs: r, state: s, actions: a } = ctx, board = r['stats-panel'];
  const visible = s.view === 'stats', entering = visible && board.hidden;
  const restore = !visible && !board.hidden && board.contains(doc.activeElement);
  board.hidden = !visible; ctx.root.hidden = false;
  // Clear the shared stub's parent flag when switching back from another layout.
  ctx.root.parentElement?.setAttribute('data-stats-open', 'false');
  r['stats-open'].setAttribute('aria-expanded', String(visible)); r['stats-open'].setAttribute('aria-controls', 'stats-panel');
  if (restore && s.view === 'catalog' && !s.detailOpen) r['stats-open'].focus();
  if (!visible) return;
  r['shelf-back'].hidden = true;
  if (entering && !Array.from(doc.querySelectorAll('dialog')).some(dialog => dialog.open)) r['stats-title'].focus();
  for (const range of Object.keys(statsRanges)) r['shelf-stats-' + range].setAttribute('aria-pressed', String(model?.range === range));
  // Keep chart focus and tooltip/scroll state during unchanged background paints.
  const signature = JSON.stringify([model, s.categories]);
  if (signature === r.statsSignature) return;
  r.statsSignature = signature;
  const content = r['stats-content'], notice = r['stats-limited'], status = r['stats-status'];
  content.replaceChildren(); notice.replaceChildren(); notice.hidden = !model?.limited;
  if (model?.limited) notice.append(node(doc, 'strong', '数据范围有限'),
    region(doc, 'ul', '', ...(model.limitedReasons?.length ? model.limitedReasons : ['数据缺口原因未载明']).map(reason => node(doc, 'li', reason))));
  const ready = model?.status === 'ready'; status.hidden = ready;
  status.textContent = ready ? '' : !model || model.status === 'loading' ? '统计正在建立…' : '调用统计暂不可用，请刷新统计。';
  if (!ready) return;
  const t = model.totals;
  const total = node(doc, 'strong', String(t.calls)); total.setAttribute('data-stat', 'calls');
  const sources = region(doc, 'p', 'shelf-stats-sources',
    node(doc, 'span', `Claude ${t.claude}`, 'shelf-chart-claude'), node(doc, 'span', `Codex ${t.codex}`, 'shelf-chart-codex'));
  content.append(region(doc, 'div', 'shelf-stats-summary',
    region(doc, 'div', '', node(doc, 'span', statsRanges[model.range] + '调用', 'shelf-stats-label'), total),
    region(doc, 'div', '', sources, node(doc, 'p', `已调用 Agent ${t.agentsUsed} · 成功 ${t.ok} / 失败 ${t.failed} / 未知 ${t.unknown}`, 'shelf-stats-note'))));
  if (!t.calls) content.append(node(doc, 'p', '该时间范围内没有调用。可切换时间范围，或展开查看未调用的 Agent。', 'shelf-stats-empty'));
  // Category identity, not its changing rank, determines its book-spine color.
  const categoryOrder = [...new Set([...(s.categories || []), ...model.byCategory.map(c => c.key).sort()])];
  const categorySegments = model.byCategory.map(item => ({ ...item, colorClass: `shelf-chart-${categoryOrder.indexOf(item.key) % 11}` }));
  content.append(region(doc, 'div', 'shelf-stats-donuts',
    statsCard(doc, '功能性 / 书籍', 'shelf-stats-kinds', node(doc, 'p', '点击扇区或图例，查看对应的借阅排行。', 'shelf-stats-note'),
      statsDonut(doc, model.byKind.map(item => ({ ...item, colorClass: item.key === 'role' ? 'shelf-chart-claude' : 'shelf-chart-codex' })),
        '调用', t.calls, a.setStatsFilter, model.filter)),
    statsCard(doc, '书籍分类', 'shelf-stats-categories', node(doc, 'p', '点击分类筛选，再点一次取消。', 'shelf-stats-note'),
      statsDonut(doc, categorySegments, '书籍调用', model.byKind.find(item => item.key === 'book')?.value ?? 0, a.setStatsCategory, model.categoryFilter))));
  const trend = statsCard(doc, '近 30 天每日趋势', 'shelf-stats-trend',
    node(doc, 'p', '固定展示近 30 天全部 Agent，日期按本机时区；不随上方范围或排行筛选变化。', 'shelf-stats-note'),
    columns({ points: model.daily.map(point => ({ label: point.day, value: point.calls, parts: statsParts(point) })), height: 160 }, doc));
  trend.append(region(doc, 'p', 'shelf-stats-sources', node(doc, 'span', 'Claude', 'shelf-chart-claude'), node(doc, 'span', 'Codex', 'shelf-chart-codex')));
  content.append(trend);
  const filters = region(doc, 'div', 'shelf-stats-controls', ...Object.entries({ all: '全部', role: '功能性', book: '书籍' }).map(([key, text]) =>
    statsButton(ctx, 'filter-' + key, text, () => a.setStatsFilter(key), model.filter === key)));
  filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '排行榜筛选');
  const ranking = statsCard(doc, '借阅排行', 'shelf-stats-ranking',
    node(doc, 'p', '按调用次数从高到低 · 同次按名称排序 · 点击书脊查看 Agent 详情', 'shelf-stats-note'), filters);
  if (model.categoryFilter) ranking.append(statsButton(ctx, 'category', `分类：${model.categoryFilter} · 取消筛选`, () => a.setStatsCategory(model.categoryFilter), true));
  const positive = model.agents.filter(agent => agent.value > 0), zero = model.agents.filter(agent => agent.value === 0);
  const list = region(doc, 'div', 'shelf-stats-spines'); list.id = 'stats-ranking-list';
  if (positive.length) list.append(statsBars(ctx, positive));
  else list.append(node(doc, 'p', model.filter === 'all' ? '该时间范围内没有调用' : '当前筛选没有调用，可切换筛选或展开未调用的 Agent。', 'shelf-stats-note'));
  const unused = region(doc, 'section', 'shelf-stats-zero', node(doc, 'h4', `未调用的 Agent：${model.zeroCount} 个`));
  if (model.showAll && zero.length) unused.append(statsBars(ctx, zero));
  list.append(unused);
  const expand = statsButton(ctx, 'expand', model.showAll ? '收起至前 20 名' : `展开全部（${model.agentCount}）`, a.toggleStatsShowAll, model.showAll);
  expand.setAttribute('aria-expanded', String(model.showAll)); expand.setAttribute('aria-controls', list.id);
  ranking.append(list, expand); content.append(ranking,
    node(doc, 'p', `更新：${formatDate(model.generatedAt)} · 调用次数不包含启动次数`, 'shelf-stats-note'));
}
