import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appDocument } from './fixtures/app.mjs';
import { documentFrom } from './fixtures/dom.mjs';
import { mountApp } from '../public/app.js';
import { bookCover, springEasing } from '../public/layouts/shelf.js';
import { enter, mountMotion } from '../public/motion.js';

const member = (id, kind = 'book', primary = '学习') => ({ id, name: id, kind, primary: kind === 'book' ? primary : '功能性 Agent',
  book: kind === 'book' ? { title: `《${id} Book》`, author: `${id} Author` } : null, purpose: kind === 'role' ? '协调' : null, description: '说明', tags: [],
  platforms: { codex: { available: true }, claude: { available: true } }, sources: { checked: true, missing: [] }, permissions: {}, sync: { state: '同步' } });
const registry = { agents: [member('Walvo'), member('Jadra'), member('Rusko', 'book', '睡眠'), member('Peter', 'role')],
  categories: ['学习', '睡眠'], summary: { roles: 1, books: 3 }, sources: [], outOfScope: [], conflicts: [], missingFromDisk: [] };

async function shelf(t) {
  const { doc } = await appDocument('shelf'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const app = await mountApp(doc, async url => {
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'shelf', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app, row: category => doc.querySelectorAll('.book-row').find(r => r.getAttribute('data-category') === category) };
}

test('v038 shelf: only the last book of a row leans, its slot opens by contact height × tan θ; a lone book stands', async t => {
  const { row } = await shelf(t);
  const spines = row('学习').querySelectorAll('.book-spine');
  assert.equal(spines.length, 2);
  assert.equal(spines[0].parent.style.getPropertyValue('--lean'), '');
  // The lean sits on the item, so the spine and its 放上书桌 button tilt about the same pivot.
  const lean = spines[1].parent.style.getPropertyValue('--lean');
  assert.match(lean, /^-[789]\.00deg$/);
  const theta = -parseFloat(lean) * Math.PI / 180, gap = parseFloat(spines[1].parent.style.getPropertyValue('margin-left'));
  // Heights are 230–260 px, so the contact height lies between 230·cos θ and 260.
  assert.ok(gap >= 230 * Math.cos(theta) * Math.tan(theta) - 3 - 0.1 && gap <= 260 * Math.tan(theta) - 3 + 0.1, String(gap));
  const lone = row('睡眠').querySelector('.book-spine');
  assert.equal(lone.parent.style.getPropertyValue('--lean'), ''); assert.equal(lone.parent.style.getPropertyValue('margin-left'), '');
});

test('v038 shelf: spines carry a hidden page edge; without WAAPI a click still opens the detail directly', async t => {
  const { doc, app, row } = await shelf(t);
  const spine = row('学习').querySelector('.book-spine');
  const edge = spine.querySelector('.spine-edge'); assert.ok(edge); assert.equal(edge.getAttribute('aria-hidden'), 'true');
  assert.equal(spine.textContent, 'Walvo Book');
  assert.ok(doc.getElementById('shelf-book-stage'), 'the pull-out stage is mounted');
  assert.equal(doc.querySelector('[aria-label="合上并放回书架"]').textContent, '×');
  await spine.fire('click');
  assert.equal(app.snapshot().state.detailOpen, true); assert.equal(app.snapshot().state.selectedId, 'Walvo');
  assert.equal(doc.getElementById('detail').open, true); assert.equal(doc.getElementById('shelf-book-stage').open, false);
});

test('v038 generated covers: one of three stable designs per book, with its title and author', () => {
  const doc = documentFrom('<html><body></body></html>');
  doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const seen = new Set();
  for (const id of ['walvo', 'jadra', 'rusko', 'liebo', 'stevo', 'hafo', 'levro', 'munto', 'granto']) {
    const agent = { id, name: id, spineTitle: `${id} title`, book: { author: `${id} author` } };
    const a = bookCover(doc, agent), b = bookCover(doc, agent);
    const template = a.className.match(/cover-(frame|band|classic)/)?.[1];
    assert.ok(template, a.className); assert.equal(b.className, a.className, 'stable per book'); seen.add(template);
    assert.equal(a.querySelector('.cover-title').textContent, `${id} title`);
    assert.equal(a.querySelector('.cover-author').textContent, `${id} author`);
    assert.match(a.style.getPropertyValue('--cover-title'), /^(34|28|23|19)px$/);
    if (template === 'frame') assert.equal(a.querySelector('.cover-ornament').textContent, '◆ ◇ ◆');
    if (template === 'band') assert.ok(a.querySelector('.cover-band').querySelector('.cover-title'));
    if (template === 'classic') assert.ok(a.querySelector('.cover-rule'));
  }
  assert.equal(seen.size, 3, 'all three designs occur');
});

function classed() {
  const set = new Set();
  return { hidden: false, classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) } };
}
test('v038 motion: an entering view holds ui-enter briefly; the observer marks views that lose hidden and new layouts', async () => {
  const el = classed(); enter(el, 5); assert.ok(el.classList.contains('ui-enter'));
  await new Promise(r => setTimeout(r, 30)); assert.ok(!el.classList.contains('ui-enter'));
  const hiddenEl = classed(); hiddenEl.hidden = true; enter(hiddenEl, 5); assert.ok(!hiddenEl.classList.contains('ui-enter'));
  let callback, disconnected = false, options;
  class Observer { constructor(fn) { callback = fn; } observe(_root, value) { options = value; } disconnect() { disconnected = true; } }
  const root = { children: [] }, doc = { defaultView: { MutationObserver: Observer }, getElementById: () => root };
  const motion = mountMotion(doc);
  assert.deepEqual(options.attributeFilter, ['hidden']); assert.equal(options.attributeOldValue, true);
  const shown = classed(), stillHidden = classed(), alreadyVisible = classed(), layout = classed(); stillHidden.hidden = true;
  callback([{ type: 'attributes', target: shown, oldValue: '' }, { type: 'attributes', target: stillHidden, oldValue: null },
    { type: 'attributes', target: alreadyVisible, oldValue: null }, { type: 'childList', target: root, addedNodes: [layout] }]);
  assert.ok(shown.classList.contains('ui-enter')); assert.ok(layout.classList.contains('ui-enter'));
  assert.ok(!stillHidden.classList.contains('ui-enter')); assert.ok(!alreadyVisible.classList.contains('ui-enter'));
  motion.dispose(); assert.ok(disconnected);
  assert.doesNotThrow(() => mountMotion({ defaultView: {}, getElementById: () => root }).dispose(), 'no MutationObserver: no-op');
});

test('v038 styles: restrained durations, reduced motion switches entry and press motion off, shelf keeps its lean', async () => {
  const shared = await fs.readFile('public/styles.css', 'utf8'), shelfCss = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(shared, /--motion-fast:150ms; --motion:220ms;/);
  // The v0.38 block; later increments add their own reduced-motion blocks after it.
  const reduce = shared.slice(shared.search(/@media \(prefers-reduced-motion:reduce\) \{\s*\.ui-enter/));
  assert.match(reduce, /\.ui-enter, \.ui-enter \*, dialog\[open\], dialog\[open\]::backdrop \{ animation:none !important; \}/);
  assert.match(reduce, /:active \{ scale:none; \}/);
  assert.match(shared, /@keyframes shelf-book-in/); assert.match(shared, /@keyframes shelf-side-in/);
  const shelfReduce = shelfCss.slice(shelfCss.search(/@media \(prefers-reduced-motion:reduce\) \{\s*\[data-ui="shelf"\] \.book-spine \{ transition:none; \}/));
  assert.match(shelfReduce, /\.book-spine:active:enabled \{ transform:rotate\(var\(--lean,0deg\)\); \}/);
  assert.match(shelfCss, /\.shelf-detail\.beside-book::backdrop \{ background:transparent; backdrop-filter:none; animation:none; \}/);
  assert.match(shelfCss, /\.book-spine\.is-out \{ visibility:hidden;/);
  // v0.38.1: the hovered spine (z-index 2) no longer covers 放上书桌, which tilts with a leaning book.
  assert.match(shelfCss, /\.shelf-item \.put-on-desk \{\s*z-index:3;\s*transform-origin:-4px calc\(100% \+ 8px\);\s*transform:rotate\(var\(--lean,0deg\)\);/);
  // v0.53.18: one 900 ms flight out (no stop in front of the row), a 600 ms move beside the detail.
  for (const [name, ms] of [['fly', 900], ['detail', 600]]) assert.ok((await fs.readFile('public/layouts/shelf.js', 'utf8')).includes(`, ${ms}, SPRING)`), name);
});

// v0.41.6 (2026-11-01): the pulled-out book turns under a drag or the arrow keys. A small WAAPI and layout shim lets
// the stage run in the recording DOM; reduced motion makes every flight instant.
async function turningShelf(t, { reduced = true, frames = null, facts = null, record = null } = {}) {
  const { doc } = await appDocument('shelf'); doc.createTextNode = text => { const n = doc.createElement('text'); n.textContent = text; return n; };
  const create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag);
    const classes = () => el.className.split(/\s+/).filter(Boolean), write = list => { el.className = list.join(' '); };
    el.classList = { add: (...c) => write([...new Set([...classes(), ...c])]), remove: (...c) => write(classes().filter(x => !c.includes(x))),
      toggle: (c, on) => { const has = classes().includes(c), want = on ?? !has; write(want ? [...new Set([...classes(), c])] : classes().filter(x => x !== c)); return want; },
      replace: (a, b) => write(classes().map(x => x === a ? b : x)), contains: c => classes().includes(c) };
    el.animate = (keys, options) => { record?.push({ el, keys, options }); return { finished: Promise.resolve(), cancel() {} }; };
    el.getBoundingClientRect = () => ({ left: 100, top: 300, width: 52, height: 240, right: 152, bottom: 540 });
    Object.defineProperty(el, 'offsetHeight', { value: 240 }); Object.defineProperty(el, 'offsetWidth', { value: 52 });
    el.setPointerCapture = () => {};
    return el;
  };
  for (const node of doc.querySelectorAll('*')) if (!node.classList) Object.assign(node, { classList: { add() {}, remove() {}, toggle() {}, replace() {}, contains: () => false } });
  doc.defaultView = { innerWidth: 1440, innerHeight: 960, matchMedia: () => ({ matches: reduced }), addEventListener() {},
    ...(frames ? { requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: id => { frames[id - 1] = null; } } : {}),
    getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '18px', maxWidth: '' }) };
  const app = await mountApp(doc, async url => {
    if (url.startsWith('/api/book-facts/')) { if (!facts) return { ok: false, status: 500, json: async () => ({ error: '无' }) }; return { ok: true, json: async () => facts }; }
    const value = url === '/api/registry' ? registry : url === '/api/stats' ? { perAgent: {}, sources: [], limitedReasons: [] }
      : url === '/api/settings' ? { ui: 'shelf', recommend: { claude: { model: 'm', effort: 'e' }, codex: { model: 'm', effort: 'e' } } }
      : url === '/api/pins' ? { ids: [] } : url === '/api/concepts?limit=30' ? { items: [], running: null, today: {} } : { items: [], unavailable: [] };
    return { ok: true, json: async () => value };
  }, { confirm: async () => true });
  t.after(() => app.dispose());
  return { doc, app };
}

test('v0.41.6 the pulled-out book turns under a drag or the arrow keys; a press without movement still opens the detail', async t => {
  const { doc, app } = await turningShelf(t);
  const spine = doc.querySelectorAll('.book-spine')[0];
  await spine.fire('click'); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const book = doc.querySelector('.book-3d'), stage = doc.getElementById('shelf-book-stage');
  assert.ok(book, 'the book is pulled out'); assert.match(stage.className, /is-cover/);
  assert.match(book.style.transform, /rotateX\(5deg\) rotateY\(20deg\)$/);
  assert.equal(doc.querySelector('.shelf-book-hint'), null, 'no hint under the book (2026-11-01)');
  assert.equal(book.querySelectorAll('.book-bottom').length, 1, 'tilting shows the foot of the book as well');
  await book.fire('pointerdown', { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
  await book.fire('pointermove', { pointerId: 1, clientX: 502, clientY: 401 });
  assert.match(book.style.transform, /rotateY\(20deg\)$/, 'a 2 px wobble is not a drag');
  await book.fire('pointermove', { pointerId: 1, clientX: 700, clientY: 300 });
  assert.match(book.className, /is-turning/);
  assert.match(book.style.transform, /rotateX\(45deg\) rotateY\(120deg\)$/, 'across spins it (0.5°/px), up tilts it (0.4°/px)');
  await book.fire('pointermove', { pointerId: 1, clientX: 700, clientY: -400 });
  assert.match(book.style.transform, /rotateX\(65deg\)/, 'the tilt stops at 60° from the pose');
  await book.fire('pointerup', { pointerId: 1 }); assert.doesNotMatch(book.className, /is-turning/);
  await book.fire('click'); assert.equal(app.snapshot().state.detailOpen, false, 'the click that ends a drag does not open the detail');
  await book.fire('keydown', { key: 'Home', preventDefault() {} }); assert.match(book.style.transform, /rotateX\(5deg\) rotateY\(20deg\)$/, 'Home turns it back');
  await book.fire('keydown', { key: 'ArrowRight', preventDefault() {} }); await book.fire('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.match(book.style.transform, /rotateX\(15deg\) rotateY\(35deg\)$/);
  for (let i = 0; i < 12; i++) await book.fire('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.match(book.style.transform, /rotateY\(-145deg\)$/, 'a full turn wraps to −180°…180°, so the flight home stays short');
  await book.fire('click'); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.equal(app.snapshot().state.detailOpen, true, 'a plain click opens the detail');
  assert.match(book.style.transform, /rotateX\(14deg\) rotateY\(-137deg\)$/, 'the turn carries into the detail pose');
});

test('v0.41.7 let go while moving and the book keeps turning, slowing to a stop; a still release, a new press or reduced motion do not coast', async t => {
  const frames = [], { doc } = await turningShelf(t, { reduced: false, frames });
  await doc.querySelectorAll('.book-spine')[0].fire('click'); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const book = doc.querySelector('.book-3d'), spinY = () => Number(book.style.transform.match(/rotateY\((-?[\d.]+)deg\)$/)[1]);
  const flick = async (until) => {
    frames.length = 0;
    await book.fire('pointerdown', { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
    for (let i = 1; i <= 5; i++) await book.fire('pointermove', { pointerId: 1, clientX: 500 + i * 20, clientY: 400, timeStamp: 1000 + i * 16 });
    await book.fire('pointerup', { pointerId: 1, timeStamp: until });
  };
  await flick(1090);
  const released = spinY(); assert.equal(released, 70, 'the drag itself: 100 px at 0.5°/px from 20°');
  assert.equal(frames.filter(Boolean).length, 1, 'a fast release starts coasting');
  let time = 2000, seen = [released];
  for (let i = 0; i < 400 && frames.some(Boolean); i++) { const fn = frames.pop(); frames.length = 0; if (fn) { time += 16; fn(time); seen.push(spinY()); } }
  const steps = seen.slice(1).map((v, i) => ((v - seen[i] + 540) % 360) - 180);
  assert.ok(steps.length > 20, `it coasts for a while (${steps.length} frames)`);
  assert.ok(steps.every(d => d >= 0), 'in the direction of the flick');
  assert.ok(steps[0] > steps.at(-1) && steps.at(-1) < 0.2, 'and slows down to a stop');
  assert.equal(frames.filter(Boolean).length, 0, 'then it stops asking for frames');
  assert.ok(steps.reduce((a, b) => a + b, 0) < 1.2 * 350 + 1, 'even a hard flick coasts at most about one more turn');
  await flick(1300); assert.equal(frames.filter(Boolean).length, 0, 'held still before letting go: no coasting');
  await flick(1090); assert.equal(frames.filter(Boolean).length, 1);
  await book.fire('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  assert.equal(frames.filter(Boolean).length, 0, 'a new press catches the book');
  await book.fire('pointerup', { pointerId: 2 });
});


// v0.42 书本检视 (2026-11-01): the turned-out book stands left and a game-style card reads beside it.
test('v0.42 the pulled-out book stands left of its card: glyphs, title, description, hours read of hours needed, weight', async t => {
  const facts = { agentId: 'Walvo', books: 1, pages: 300, estimatedPages: true, weightKg: 0.52, hours: 10, readSeconds: 5000 };
  const { doc } = await turningShelf(t, { facts });
  await doc.querySelectorAll('.book-spine')[0].fire('click'); for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  const book = doc.querySelector('.book-3d'), card = doc.getElementById('book-inspect');
  assert.match(book.style.transform, /^translate\(303px,/, 'the book stands at 30% of a wide window (432 px less half its 258 px width)');
  assert.equal(card.querySelector('.inspect-title').textContent, '《Walvo Book》');
  assert.equal(card.querySelector('.inspect-blurb').textContent, '有关学习的详细信息。', 'without a written description the category stands in');
  assert.deepEqual(card.querySelector('.inspect-glyphs').children.map(g => g.getAttribute('data-glyph')), ['book', 'spark']);
  assert.equal(card.querySelector('.inspect-hourglass').textContent, '已研读 1.3 小时，共需 10 小时');
  assert.equal(card.querySelector('.inspect-weight').textContent, '0.52 公斤');
  assert.equal(card.querySelector('.inspect-weight').title, '约 300 页');
  assert.doesNotMatch(card.textContent, /技能|耐久|100%/, 'no skill points and no durability');
});
test('v0.42 a failed estimate says so instead of leaving the card waiting', async t => {
  const { doc } = await turningShelf(t);
  await doc.querySelectorAll('.book-spine')[0].fire('click'); for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(doc.querySelector('.inspect-hourglass').textContent, '研读时长暂时无法估算');
});

// v0.44.1 (2026-11-02: putting the book back looked unnatural): one continuous flight with a waypoint in front of
// the slot, the spine face set back into the screen plane so it lands on the real spine, the short way round, the room
// brightening on the way.
test('v0.44.1 the book flies home in one eased flight, lands flat on its spine and turns the short way round', async t => {
  const { doc } = await turningShelf(t);
  await doc.querySelectorAll('.book-spine')[0].fire('click'); for (let i = 0; i < 2; i++) await new Promise(r => setTimeout(r, 0));
  const book = doc.querySelector('.book-3d'), stage = doc.getElementById('shelf-book-stage'), calls = [];
  book.animate = (frames, options) => { calls.push({ frames, options }); return { finished: Promise.resolve(), cancel() {} }; };
  for (let i = 0; i < 13; i++) await book.fire('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.match(book.style.transform, /rotateY\(-145deg\)$/, 'turned to its back');
  await doc.querySelector('.shelf-book-close').fire('click'); for (let i = 0; i < 2; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 1, 'no stop in front of the slot: a single animation');
  // v0.53.18: the flight is sampled along a curve; it ends turned spine-out above the slot and drops straight in.
  const frames = calls[0].frames, from = frames[0], to = frames.at(-1);
  assert.ok(frames.length > 10 && frames.every((f, i) => i === 0 || f.offset > frames[i - 1].offset), 'keyframes in order');
  assert.match(from.transform, /scale\(1\) translateZ\(0px\) scaleZ\(1\) rotateZ\(0deg\) rotateX\(5deg\) rotateY\(215deg\)$/, '−145° goes home as 215°, 125° from 90° instead of 235°');
  const late = frames.filter(f => f.offset >= 0.8);
  for (const frame of late) assert.match(frame.transform, /scaleZ\([^)]*\) rotateZ\([^)]*\) rotateX\(0deg\) rotateY\(90deg\)$/, `spine-out at ${frame.offset}`);
  // 2026-11-24: pressed flat by the time it reaches the slot, so no slanted cover shows beside it and the flat spine takes over seamlessly.
  assert.match(to.transform, /translateZ\(-2\.58px\) scaleZ\(0\.02\) rotateZ/);
  const at = f => f.transform.match(/^translate\(([-\d.]+)px,([-\d.]+)px\)/).slice(1).map(Number);
  const xs = late.filter(f => f.offset >= 0.9).map(f => at(f)[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 5, `the last stretch comes (nearly) straight down into the slot: ${xs}`);
  assert.deepEqual(at(to), [126 - 129, 420 - 190], 'and lands on the spine (centre 126, 420)');
  assert.equal(calls[0].options.easing, 'cubic-bezier(.4,0,.2,1)', 'eased in from rest and out into the slot');
  assert.match(stage.className, /is-closing/, 'the room brightens during the flight');
  assert.equal(doc.querySelector('.book-3d'), null, 'and the book is back on the shelf');
  const css = await fs.readFile('public/layouts/shelf.css', 'utf8');
  assert.match(css, /\.shelf-book-stage\.is-closing::backdrop \{ opacity:0; transition:opacity \.7s/);
});

// v0.53.18 (2026-11-24: make taking a book out and putting it back smoother). The flight out no longer stops dead in
// front of the row and springs off again; the shadow flies with the book; the detail slides out when closed.
const flightOf = (record, cls) => record.filter(c => c.el.className.split(/\s+/).includes(cls));
const xy = key => key.transform.match(/^translate\(([-\d.]+)px,([-\d.]+)px\)/).slice(1).map(Number);
const angle = (key, axis) => Number(key.transform.match(new RegExp(`rotate${axis}\\((-?[\\d.]+)deg\\)`))[1]);
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
// The recording DOM's matches() ignores pseudo-classes; a test says whether the spine is hovered.
const hover = (el, on) => { const matches = el.matches.bind(el); el.matches = s => s === ':hover' ? on : matches(s); };
const flush = frames => { for (const fn of frames.splice(0)) fn?.(0); }; // runs one animation frame's callbacks

test('v05318 the spring easing starts from rest, overshoots about 1% and settles', () => {
  const easing = springEasing(), points = easing.slice(7, -1).split(', ').map(Number);
  assert.match(easing, /^linear\(0, /); assert.equal(points.at(-1), 1); assert.equal(points.length, 41);
  assert.ok(points[1] < 0.03, `no kick at the start: ${points[1]}`);
  const peak = Math.max(...points), top = points.indexOf(peak);
  assert.ok(peak > 1.004 && peak < 1.02, `a small overshoot: ${peak}`);
  assert.ok(points.slice(0, top + 1).every((p, i) => i === 0 || p >= points[i - 1]), 'it rises without a stop up to its peak');
});

test('v05318 a book comes out in one flight: up out of the row, then a curve to the centre, turning once clear; its shadow gathers as it arrives', async t => {
  const record = [], { doc } = await turningShelf(t, { reduced: false, record });
  const spine = doc.querySelectorAll('.book-spine')[0]; hover(spine, false); // not hovered
  await spine.fire('click'); await ticks(2);
  const [book] = flightOf(record, 'book-3d'), [shadow] = flightOf(record, 'book-ground');
  assert.equal(flightOf(record, 'book-3d').length, 1, 'no stop in front of the row: one animation');
  assert.equal(book.options.duration, 900); assert.match(book.options.easing, /^linear\(/);
  assert.deepEqual([shadow.options.duration, shadow.options.easing], [book.options.duration, book.options.easing], 'the shadow keeps time with the book');
  const keys = book.keys, rising = keys.filter(k => k.offset <= 0.1);
  assert.match(keys[0].transform, /^translate\(-3px,230px\) scale\(0\.631578947368421\) translateZ\(-2\.58px\) scaleZ\(0\.02\) rotateZ\(0deg\) rotateX\(0deg\) rotateY\(90deg\)$/, 'it leaves from the spine as it stands, flat');
  assert.match(keys.at(-1).transform, /scale\(1\) translateZ\(0px\) scaleZ\(1\) rotateZ\(0deg\) rotateX\(5deg\) rotateY\(20deg\)$/, 'and arrives at its cover');
  assert.ok(rising.every((k, i) => i === 0 || (xy(k)[1] < xy(rising[i - 1])[1] && Math.abs(xy(k)[0] - xy(keys[0])[0]) < 6)), 'first straight up out of the row');
  assert.ok(keys.filter(k => k.offset <= 0.12).every(k => angle(k, 'Y') === 90), 'turning only once clear of the row');
  const steps = keys.slice(1).map((k, i) => Math.hypot(xy(k)[0] - xy(keys[i])[0], xy(k)[1] - xy(keys[i])[1]));
  assert.ok(steps.every(d => d > 0), 'it never stands still on the way');
  assert.deepEqual([shadow.keys[0].opacity, shadow.keys.at(-1).opacity], [0, 1]);
  assert.ok(shadow.keys.filter(k => k.offset <= 0.55).every(k => k.opacity === 0), 'the shadow appears only as the book arrives');
  assert.ok(shadow.keys.every((k, i) => xy(k)[0] === xy(keys[i])[0]), 'right under the book all the way');
  assert.equal(doc.querySelector('.book-ground').style.opacity, '1');
});

test('v05318 a hovered spine: the book leaves lifted and bright, as the spine was shown', async t => {
  const record = [], frames = [], { doc } = await turningShelf(t, { reduced: false, record, frames });
  const spine = doc.querySelectorAll('.book-spine')[0]; hover(spine, true);
  await spine.fire('click'); await ticks(2);
  const [book] = flightOf(record, 'book-3d');
  assert.match(book.keys[0].transform, /^translate\(-3px,220px\) .* rotateX\(-8deg\) rotateY\(90deg\)$/, '10 px up, tipped 8° like the hovered spine');
  const el = doc.querySelector('.book-3d');
  assert.match(el.className, /from-hover/, 'as bright as the hovered spine');
  flush(frames); assert.match(el.className, /from-hover/, 'for the first frame');
  flush(frames); assert.doesNotMatch(el.className, /from-hover/, 'then dims to its own colour on the way');
});

test('v05318 opening the detail: one smooth move beside it, the detail built after the first frame', async t => {
  const record = [], frames = [], { doc, app } = await turningShelf(t, { reduced: false, record, frames });
  const spine = doc.querySelectorAll('.book-spine')[0]; hover(spine, false);
  await spine.fire('click'); await ticks(2); frames.length = 0; record.length = 0;
  await doc.querySelector('.book-3d').fire('click');
  const [move] = flightOf(record, 'book-3d'), [shadow] = flightOf(record, 'book-ground');
  assert.equal(move.options.duration, 600); assert.match(move.options.easing, /^linear\(/);
  assert.equal(shadow.keys.length, 2, 'the shadow moves with the book instead of jumping ahead of it');
  assert.equal(app.snapshot().state.detailOpen, false, 'not built in the frame the move starts');
  flush(frames); assert.equal(app.snapshot().state.detailOpen, false, 'nor in the frame that starts it');
  flush(frames);
  assert.equal(app.snapshot().state.detailOpen, true, 'built right after');
});

test('v05318 put back after a key, the book lands on the focused (lifted) spine and the spine takes over without rising again', async t => {
  const record = [], frames = [], { doc } = await turningShelf(t, { reduced: false, record, frames });
  const spine = doc.querySelectorAll('.book-spine')[0], key = spine.getAttribute('data-focus-key'); hover(spine, false);
  const putBack = async () => {
    await spine.fire('click'); await ticks(2); record.length = 0;
    await doc.querySelector('.shelf-book-close').fire('click'); await ticks(2);
    return flightOf(record, 'book-3d')[0].keys.at(-1).transform;
  };
  await doc.fire('pointerdown', {});
  assert.match(await putBack(), /^translate\(-3px,230px\) .* rotateX\(0deg\) rotateY\(90deg\)$/, 'after a pointer: flat into the slot');
  assert.ok(doc.querySelectorAll('.book-spine').every(n => !/is-landing/.test(n.className)));
  frames.length = 0;
  await doc.fire('keydown', { key: 'Shift' });
  assert.match(await putBack(), /^translate\(-3px,220px\) .* rotateX\(-8deg\) rotateY\(90deg\)$/, 'after a key: onto the lifted spine');
  const landed = doc.querySelectorAll('.book-spine').find(n => n.getAttribute('data-focus-key') === key); // the shelf may have re-rendered
  assert.match(landed.className, /is-landing/, 'the spine shows at once, without its own transition');
  flush(frames); assert.match(landed.className, /is-landing/);
  flush(frames); assert.doesNotMatch(landed.className, /is-landing/, 'and gets it back two frames later');
});

test('v05318 styles: the shadow has no transition of its own, the card is gone before the detail comes, the detail slides out', async () => {
  const css = (await fs.readFile('public/layouts/shelf.css', 'utf8')).replace(/\r\n/g, '\n');
  const ground = css.match(/\[data-ui="shelf"\] \.book-ground \{([^}]*)\}/)[1];
  assert.doesNotMatch(ground, /transition/); assert.doesNotMatch(css, /\.book-ground\.on/);
  assert.match(css, /\.shelf-book-stage:not\(\.is-cover\) \.book-inspect \{ transition:opacity \.12s/);
  assert.match(css, /\.shelf-detail\.beside-book \{\s*transition:opacity \.2s[^;]*overlay \.22s allow-discrete, display \.22s allow-discrete;/);
  assert.match(css, /\.shelf-detail\.beside-book:not\(\[open\]\) \{ opacity:0; translate:28px 0; \}/);
  assert.match(css, /\.book-spine\.is-landing,\s*\[data-ui="shelf"\] \.book-spine\.is-landing \.spine-edge \{ transition:none; \}/);
  const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion:reduce) {\n  [data-ui="shelf"] .book-spine { transition:none; }'));
  for (const rule of ['.shelf-detail.beside-book,', '.book-3d .book-spine-face,', '.shelf-book-stage:not(.is-cover) .book-inspect,']) assert.ok(reduce.includes(rule), rule);
});
