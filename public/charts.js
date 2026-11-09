import { markAgentLink } from './agent-links.js';
// Offline SVG primitives. Text is always literal; geometry uses presentation attributes.
const NS = 'http://www.w3.org/2000/svg';
const count = value => Number.isFinite(value) && value > 0 ? value : 0;
const compare = (a, b) => count(b.value) - count(a.value) || String(a.label).localeCompare(String(b.label), 'zh-CN');
function helpers(doc) {
  const html = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const svg = (tag, attrs = {}, text) => { const n = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value); if (text !== undefined) n.textContent = text; return n; };
  const data = rows => { const list = html('ul', undefined, 'chart-data'); for (const row of rows) list.append(html('li', row)); return list; };
  return {html, svg, data};
}
function select(node, callback, key) {
  if (!callback) return;
  node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0');
  node.addEventListener('click', () => callback(key));
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) return callback(key); } });
}
const describe = item => `${item.label}：${count(item.value)}${item.parts?.length ? `（${item.parts.map(p => `${p.key} ${count(p.value)}`).join('，')}）` : ''}`;

export function donut({segments = [], centerLabel = '', centerValue, onSelect} = {}, doc = document) {
  const {html, svg, data} = helpers(doc), root = html('div', undefined, 'chart-donut');
  const graph = svg('svg', {viewBox:'0 0 200 200', 'aria-label':centerLabel || '调用分布'});
  graph.append(svg('title', {}, `${centerLabel}：${centerValue ?? segments.reduce((n, s) => n + count(s.value), 0)}`));
  const positive = segments.filter(s => count(s.value)), total = positive.reduce((n, s) => n + s.value, 0);
  let angle = -Math.PI / 2;
  for (const [i, segment] of positive.entries()) {
    const next = angle + segment.value / total * Math.PI * 2;
    const point = (r, a) => `${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)}`;
    // A full circle needs two arcs; two coincident endpoints would draw nothing.
    const path = positive.length === 1
      ? 'M100 20 A80 80 0 1 1 100 180 A80 80 0 1 1 100 20 M100 48 A52 52 0 1 0 100 152 A52 52 0 1 0 100 48 Z'
      : `M${point(80, angle)} A80 80 0 ${next-angle > Math.PI ? 1 : 0} 1 ${point(80, next)} L${point(52, next)} A52 52 0 ${next-angle > Math.PI ? 1 : 0} 0 ${point(52, angle)} Z`;
    const slice = svg('path', {d:path, class:`chart-slice ${segment.colorClass || `chart-color-${i % 11}`}`, 'data-segment':segment.key, 'aria-label':describe(segment)});
    slice.setAttribute('data-focus-key', `stats-slice-${segment.key}`);
    slice.append(svg('title', {}, describe(segment))); select(slice, onSelect, segment.key); graph.append(slice); angle = next;
  }
  graph.append(svg('text', {x:100, y:98, 'text-anchor':'middle', class:'chart-center-value'}, String(centerValue ?? total)),
    svg('text', {x:100, y:120, 'text-anchor':'middle', class:'chart-center-label'}, centerLabel));
  root.append(graph, data(segments.map(describe)));
  if (!total) root.append(html('p', '该时间范围内没有调用', 'chart-empty'));
  // Visible legend remains selectable without relying on color or SVG hit targets.
  const legend = html('div', undefined, 'chart-legend');
  for (const segment of segments) {
    const label = html(onSelect ? 'button' : 'span', describe(segment));
    if (onSelect) { label.type = 'button'; label.setAttribute('data-focus-key', `stats-legend-${segment.key}`); label.addEventListener('click', () => onSelect(segment.key)); }
    legend.append(label);
  }
  root.append(legend); return root;
}

export function barList({rows = [], max, onSelect} = {}, doc = document) {
  const {html, svg, data} = helpers(doc), root = html('div', undefined, 'chart-bar-list');
  const sorted = [...rows].sort(compare), ceiling = Math.max(count(max), ...sorted.map(r => count(r.value)), 1);
  for (const row of sorted) {
    const button = html('button', undefined, row.value ? 'chart-bar-row' : 'chart-bar-row chart-zero'); button.type = 'button';
    markAgentLink(button,row); button.setAttribute('data-agent-id', row.id); button.setAttribute('data-focus-key', `stats-agent-${row.id}`);
    button.setAttribute('aria-label', `${row.label} · ${row.sublabel || ''} · ${describe(row)}`);
    const graph = svg('svg', {viewBox:'0 0 100 8', 'aria-hidden':'true', preserveAspectRatio:'none'});
    graph.append(svg('title', {}, describe(row))); graph.append(svg('rect', {x:0,y:0,width:100,height:8,class:'chart-track'}));
    let x = 0;
    for (const part of row.parts?.length ? row.parts : [{key:'total',value:row.value}]) {
      const width = Math.min(count(part.value) / ceiling * 100, 100 - x);
      graph.append(svg('rect', {x,y:0,width,height:8,'data-part':part.key,class:part.colorClass || `chart-${part.key}`})); x += width;
    }
    button.append(html('span', row.label, 'chart-row-label'), html('span', row.sublabel || '', 'chart-row-sublabel'), graph, html('strong', String(count(row.value))));
    button.addEventListener('click', () => onSelect?.(row.id)); root.append(button);
  }
  if (!sorted.length) { const graph = svg('svg', {viewBox:'0 0 100 1', 'aria-hidden':'true'}); graph.append(svg('title', {}, '调用排行榜为空')); root.append(graph, html('p', '该时间范围内没有调用')); }
  root.append(data(sorted.map(describe))); return root;
}

// v0.29 B 堆叠面积 + 7 日均线 (2026-10-19; docs/design/v0.29-trend), shared by all four layouts:
// stacked source areas, a dashed 7-day average, a recessive grid, Monday ticks, a marked peak and a crosshair card.
// The SVG stretches to any width (non-scaling strokes); every text and marker is HTML on top, so labels keep
// their pixel size in narrow columns. .chart-tooltip stays the polite text readout; the card repeats it visually.
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const dateOf = label => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label); return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3])) : null; };
const shortDate = label => { const d = dateOf(label); return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : String(label); };
const longDate = label => { const d = dateOf(label); return d ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${weekdays[d.getUTCDay()]}` : String(label); };
const niceStep = max => { for (let power = 1; ; power *= 10) for (const s of [1, 2, 5]) if (Math.ceil(max / (s * power)) <= 4) return s * power; };
const partName = key => String(key).charAt(0).toUpperCase() + String(key).slice(1);

export function columns({points = [], height = 160} = {}, doc = document) {
  const {html, svg, data} = helpers(doc), root = html('div', undefined, 'chart-columns');
  // Horizontal units are 0..1000 of the plot width; vertical units are real pixels.
  const W = 1000, H = Math.max(24, count(height)) + 40, T = 26;
  const partsOf = point => point.parts?.length ? point.parts : [{key:'total', value:point.value}];
  const totals = points.map(p => count(p.value)), max = Math.max(0, ...totals);
  const step = niceStep(Math.max(1, max)), top = Math.ceil(Math.max(1, max) / step) * step;
  const x = i => points.length > 1 ? i * W / (points.length - 1) : W / 2, y = v => H - v / top * (H - T);
  const average = totals.map((_, i) => { const days = totals.slice(Math.max(0, i - 6), i + 1); return days.reduce((n, v) => n + v, 0) / days.length; });
  const peak = totals.indexOf(max), last = points.length - 1;
  const place = (node, i, top) => { node.style.setProperty('left', `${x(i) / W * 100}%`); node.style.setProperty('top', `${top}px`); return node; };

  const summary = html('div', undefined, 'chart-trend-summary');
  for (const [name, value, unit] of [[`${points.length} 天调用`, totals.reduce((n, v) => n + v, 0), '次'], ['活跃天数', totals.filter(Boolean).length, `/ ${points.length}`],
    ['峰值', max, max ? shortDate(points[peak].label) : '']]) {
    const item = html('div'); item.append(html('small', name), html('strong', String(value)), html('span', unit)); summary.append(item);
  }

  const canvas = html('div', undefined, 'chart-trend-canvas'); canvas.style.setProperty('height', `${H}px`);
  const graph = svg('svg', {viewBox:`0 0 ${W} ${H}`, preserveAspectRatio:'none', 'aria-label':'近 30 天调用趋势'}), tooltip = html('p', '聚焦或悬停日期查看调用数', 'chart-tooltip');
  tooltip.setAttribute('aria-live', 'polite');
  graph.append(svg('title', {}, '每日调用次数（Asia/Shanghai）'));
  const thin = {'vector-effect':'non-scaling-stroke'};
  for (let v = 0; v <= top; v += step) {
    graph.append(svg('line', {x1:0, x2:W, y1:y(v), y2:y(v), class:v ? 'chart-grid' : 'chart-baseline', ...thin}));
    const tick = html('span', String(v), 'chart-axis chart-axis-y'); tick.style.setProperty('top', `${y(v)}px`); canvas.append(tick);
  }
  if (points.length) {
    const line = values => 'M' + values.map((v, i) => `${x(i)} ${y(v)}`).join(' L');
    let lower = points.map(() => 0);
    partsOf(points[0]).forEach((part, k) => {
      const upper = points.map((p, i) => lower[i] + count(partsOf(p)[k]?.value));
      const back = lower.map((v, i) => `${x(i)} ${y(v)}`).reverse().join(' L');
      graph.append(svg('path', {d:`${line(upper)} L${back} Z`, class:`chart-trend-area ${part.colorClass || `chart-${part.key}`}`, 'data-part':part.key}));
      lower = upper;
    });
    graph.append(svg('path', {d:line(totals), class:'chart-trend-line', ...thin}), svg('path', {d:line(average), class:'chart-trend-average', ...thin}));
    if (max) {
      const align = peak >= last - 1 ? 'chart-at-end' : peak <= 1 ? 'chart-at-start' : 'chart-at-middle';
      canvas.append(place(html('span', undefined, 'chart-trend-peak'), peak, y(max)), place(html('span', `峰值 ${max}`, `chart-trend-note ${align}`), peak, y(max) - 10));
    }
    points.forEach((point, i) => {
      if (dateOf(point.label)?.getUTCDay() !== 1) return;
      // Narrow plots drop the weekday word (container query) so the five Monday dates never collide.
      const tick = html('span', undefined, `chart-axis chart-axis-x ${i === last ? 'chart-at-end' : 'chart-at-middle'}`);
      tick.append(html('span', shortDate(point.label)), html('span', ' 周一', 'chart-axis-week')); canvas.append(place(tick, i, H + 6));
    });
  }
  const cross = html('span', undefined, 'chart-trend-cross'), dot = html('span', undefined, 'chart-trend-dot');
  cross.style.setProperty('top', `${T - 8}px`); cross.hidden = true; dot.hidden = true;
  const card = html('div', undefined, 'chart-trend-card'); card.hidden = true; card.setAttribute('aria-hidden', 'true');
  const hide = () => { card.hidden = true; cross.hidden = true; dot.hidden = true; };
  const show = (point, i) => {
    tooltip.textContent = describe(point);
    cross.style.setProperty('left', `${x(i) / W * 100}%`); place(dot, i, y(totals[i])); cross.hidden = false; dot.hidden = false;
    const rows = partsOf(point).map(part => {
      const swatch = svg('svg', {viewBox:'0 0 8 8', class:'chart-trend-swatch', 'aria-hidden':'true'});
      swatch.append(svg('rect', {width:8, height:8, rx:2, class:part.colorClass || `chart-${part.key}`}));
      const row = html('div', undefined, 'chart-trend-row'); row.append(swatch, html('span', partName(part.key)), html('span', String(count(part.value)))); return row;
    });
    const sum = html('div', undefined, 'chart-trend-row chart-trend-total'); sum.append(html('span', '合计'), html('span', String(totals[i])));
    card.replaceChildren(html('b', longDate(point.label)), ...rows, sum);
    place(card, i, y(totals[i])); card.hidden = false;
  };
  const band = points.length > 1 ? W / (points.length - 1) : W;
  points.forEach((point, index) => {
    const group = svg('g', {tabindex:0, 'data-point':index, 'aria-label':describe(point), role:'img'});
    group.setAttribute('data-focus-key', `stats-day-${point.label}`);
    const from = Math.max(0, x(index) - band / 2), to = Math.min(W, x(index) + band / 2);
    group.append(svg('title', {}, describe(point)), svg('rect', {x:from, y:0, width:to - from, height:H, class:'chart-column-target'}));
    for (const event of ['focus', 'mouseenter']) group.addEventListener(event, () => show(point, index));
    group.addEventListener('blur', hide);
    graph.append(group);
  });
  canvas.prepend(graph); canvas.append(cross, dot, card); canvas.addEventListener('mouseleave', hide);
  const plot = html('div', undefined, 'chart-trend-plot'); plot.append(canvas);
  // The latest average lives in the legend, clear of the peak mark at the right edge.
  const legend = html('div', undefined, 'chart-trend-legend'); legend.append(html('span', points.length ? `7 日均线 · 最新 ${average[last].toFixed(1)}` : '7 日均线'));
  root.append(...(points.length ? [summary] : []), plot, legend, tooltip, data(points.map(describe)));
  if (!points.length) root.append(html('p', '每日趋势数据尚不可用', 'chart-empty'));
  return root;
}
