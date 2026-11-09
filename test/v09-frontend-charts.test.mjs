import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFrom, descendants } from './fixtures/dom.mjs';
const fixture=()=>{const doc=documentFrom('<body></body>'),ns=[];const create=doc.createElementNS;doc.createElementNS=(namespace,tag)=>{ns.push(namespace);return create(namespace,tag);};return{doc,ns};};
function accessible(chart,ns){assert.ok(chart.querySelector('title'));assert.ok(chart.querySelector('.chart-data'));assert.ok(ns.length);assert.ok(ns.every(n=>n==='http://www.w3.org/2000/svg'));for(const el of descendants(chart))assert.equal(el.getAttribute('style'),null);}
test('v09 donut skips zero slices, exposes exact values and pointer/keyboard selection',async()=>{
  const {donut}=await import('../public/charts.js'),{doc,ns}=fixture(),selected=[];
  const chart=donut({segments:[{key:'role',label:'功能性',value:3,colorClass:'chart-role'},{key:'book',label:'书籍',value:1,colorClass:'chart-book'},{key:'zero',label:'零',value:0}],centerLabel:'调用',centerValue:4,onSelect:key=>selected.push(key)},doc);
  accessible(chart,ns);const slices=chart.querySelectorAll('[data-segment]');assert.equal(slices.length,2);assert.equal(slices[0].getAttribute('role'),'button');
  await slices[0].fire('click');await slices[1].fire('keydown',{key:'Enter'});await slices[1].fire('keydown',{key:' '});assert.deepEqual(selected,['role','book','book']);assert.match(chart.textContent,/功能性.*3/);
  assert.doesNotMatch(JSON.stringify(descendants(chart).map(n=>n.attrs)),/NaN|Infinity/);
});
test('v09 donut handles all zero and a complete single slice with honest empty text',async()=>{
  const {donut}=await import('../public/charts.js'),{doc}=fixture();const empty=donut({segments:[{label:'零',value:0}],centerValue:0},doc);assert.match(empty.textContent,/该时间范围内没有调用/);assert.equal(empty.querySelectorAll('[data-segment]').length,0);
  const full=donut({segments:[{key:'one',label:'全部',value:20}],centerValue:20},doc);assert.equal(full.querySelectorAll('[data-segment]').length,1);
});
test('v09 barList sorts values descending then labels, draws source stacks and has one button per row',async()=>{
  const {barList}=await import('../public/charts.js'),{doc,ns}=fixture(),selected=[];
  const rows=[{id:'z',label:'Z',sublabel:'零',value:0,parts:[]},{id:'b',label:'B',sublabel:'书',value:5,parts:[{key:'claude',value:2},{key:'codex',value:3}]},{id:'a',label:'A',sublabel:'用途',value:5,parts:[{key:'codex',value:5}]}];
  const chart=barList({rows,max:5,onSelect:id=>selected.push(id)},doc);accessible(chart,ns);
  const buttons=chart.querySelectorAll('button');assert.deepEqual(buttons.map(n=>n.getAttribute('data-agent-id')),['a','b','z']);await buttons[1].fire('click');assert.deepEqual(selected,['b']);
  assert.match(chart.textContent,/用途/);assert.equal(rows[0].id,'z');const widths=buttons[1].querySelectorAll('rect').filter(n=>n.getAttribute('data-part')).map(n=>Number(n.getAttribute('width')));assert.deepEqual(widths,[40,60]);
});
test('v09 columns render 30 focusable dates, stacked bars and visible hover/focus values',async()=>{
  const {columns}=await import('../public/charts.js'),{doc,ns}=fixture();const points=Array.from({length:30},(_,i)=>({label:`2026-09-${String(i+1).padStart(2,'0')}`,value:i,parts:[{key:'claude',value:i,colorClass:'chart-claude'}]}));
  const chart=columns({points,height:120},doc);accessible(chart,ns);const bars=chart.querySelectorAll('[data-point]');assert.equal(bars.length,30);
  await bars[4].fire('focus');assert.match(chart.querySelector('.chart-tooltip').textContent,/2026-09-05.*4/);await bars[8].fire('mouseenter');assert.match(chart.querySelector('.chart-tooltip').textContent,/2026-09-09.*8/);
  assert.doesNotMatch(JSON.stringify(descendants(chart).map(n=>n.attrs)),/NaN|Infinity/);
});
test('v09 chart labels are literal text and empty/invalid input cannot create invalid geometry',async()=>{
  const charts=await import('../public/charts.js'),{doc}=fixture();for(const chart of [charts.donut({segments:[{key:'x',label:'<script>',value:-1}]},doc),charts.barList({rows:[{id:'x',label:'<img>',value:NaN,parts:[]}],max:0},doc),charts.columns({points:[],height:0},doc)]){assert.equal(chart.querySelector('script,img'),null);assert.doesNotMatch(JSON.stringify(descendants(chart).map(n=>n.attrs)),/NaN|Infinity/);}
});
