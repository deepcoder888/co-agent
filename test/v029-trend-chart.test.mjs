import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFrom, descendants } from './fixtures/dom.mjs';
import { columns } from '../public/charts.js';

// Real shape: 09-20 … 10-19 with sparse Claude days, then Codex days peaking at 20 on 10-18 (a Sunday).
const raw = [0,0,0,0,0,0,2,5,0,0,0,0,0,0,0,0,6,1,6,0,0,0,0,0,0,0,0,0,0,0].map((claude, i) => ({ claude, codex: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5,2,2,14,2,0,20,2][i] }));
const label = i => { const d = new Date(Date.UTC(2026, 8, 20 + i)); return d.toISOString().slice(0, 10); };
const points = raw.map((p, i) => ({ label: label(i), value: p.claude + p.codex,
  parts: [{ key: 'claude', value: p.claude, colorClass: 'chart-claude' }, { key: 'codex', value: p.codex, colorClass: 'chart-codex' }] }));
// Labels and markers are HTML over the stretched SVG, so they keep their pixel size.
const texts = chart => descendants(chart).filter(n => n.className.split(' ').some(c => c === 'chart-axis' || c === 'chart-trend-note')).map(n => n.textContent);

test('v029 trend chart B: summary, stacked areas, 7-day average, peak, nice grid and Monday ticks', () => {
  const chart = columns({ points, height: 160 }, documentFrom('<body></body>'));
  const summary = chart.querySelector('.chart-trend-summary').children.map(n => n.children.map(c => c.textContent).join(' '));
  assert.deepEqual(summary, ['30 天调用 67 次', '活跃天数 12 / 30', '峰值 20 10/18']);
  assert.deepEqual(chart.querySelectorAll('.chart-trend-area').map(n => n.getAttribute('data-part')), ['claude', 'codex']);
  assert.ok(chart.querySelector('.chart-trend-average') && chart.querySelector('.chart-trend-line'));
  const labels = texts(chart);
  assert.deepEqual(labels.filter(t => /^\d+$/.test(t)), ['0', '5', '10', '15', '20'], 'grid steps of 5 up to the peak');
  assert.deepEqual(labels.filter(t => t.endsWith('周一')), ['9/21 周一', '9/28 周一', '10/5 周一', '10/12 周一', '10/19 周一']);
  assert.ok(labels.includes('峰值 20'));
  // Last 7 days (10-13 … 10-19): 2+2+14+2+0+20+2 = 42 → 6.0, shown in the legend clear of the peak.
  assert.equal(chart.querySelector('.chart-trend-legend').textContent, '7 日均线 · 最新 6.0');
  assert.doesNotMatch(JSON.stringify(descendants(chart).map(n => n.attrs)), /NaN|Infinity/);
});

test('v029 trend chart B: focus or hover opens the crosshair card with each source and the total; leaving hides it', async () => {
  const chart = columns({ points, height: 160 }, documentFrom('<body></body>'));
  const days = chart.querySelectorAll('[data-point]'), card = chart.querySelector('.chart-trend-card');
  assert.equal(days.length, 30); assert.equal(card.hidden, true);
  await days[25].fire('focus');
  assert.equal(card.hidden, false);
  assert.deepEqual(card.children.map(n => n.textContent), ['10月15日 周四', 'Claude0', 'Codex14', '合计14']);
  assert.equal(chart.querySelector('.chart-tooltip').textContent, '2026-10-15：14（claude 0，codex 14）');
  assert.equal(chart.querySelector('.chart-trend-cross').hidden, false);
  assert.ok(Math.abs(parseFloat(card.style.getPropertyValue('left')) - 25 / 29 * 100) < 1e-9);
  await days[25].fire('blur');
  assert.equal(card.hidden, true); assert.equal(chart.querySelector('.chart-trend-dot').hidden, true);
});

test('v029 trend chart B: all-zero and empty data stay honest', () => {
  const zero = columns({ points: points.map(p => ({ ...p, value: 0, parts: p.parts.map(part => ({ ...part, value: 0 })) })) }, documentFrom('<body></body>'));
  assert.ok(!texts(zero).some(t => t.startsWith('峰值')));
  assert.deepEqual(texts(zero).filter(t => /^\d+$/.test(t)), ['0', '1']);
  const empty = columns({ points: [] }, documentFrom('<body></body>'));
  assert.match(empty.textContent, /每日趋势数据尚不可用/); assert.equal(empty.querySelector('.chart-trend-summary'), null);
});
