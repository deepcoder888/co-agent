// A single controller retains selection, search and polling across all layouts.
export function createConceptMap({ api, onState = () => {}, onOpen = () => {}, onSource = async () => true,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = { concepts: [], relations: [], merges: [], newCount: 0, organizedAt: null, running: null, lastRun: null,
    notice: null, hiddenConcepts: [], splits: [], selected: null, query: '', busy: false, error: '', loaded: false };
  let selectedKey = null, version = 0, disposed = false, timer;
  const snapshot = () => structuredClone(state);
  const emit = () => { if (!disposed) onState(snapshot()); };
  function schedule() { clearTimer(timer); if (!disposed) timer = setTimer(refresh, state.running ? 1500 : 60000); }
  async function refresh() {
    if (disposed) return; clearTimer(timer); const token = ++version;
    try {
      const value = await api('/api/concept-map');
      if (disposed || token !== version) return;
      if (!Array.isArray(value.concepts)) throw new Error('概念地图响应无效');
      let key = selectedKey;
      if (!value.concepts.some(n => n.key === key)) key = value.merges.find(m => m.members.includes(key))?.canonical || value.concepts[0]?.key || null;
      const selected = key ? await api(`/api/concept-map/${encodeURIComponent(key)}`) : null;
      if (disposed || token !== version) return;
      selectedKey = key; Object.assign(state, value, { selected, loaded: true });
    } catch (e) { if (!disposed && token === version) state.error = e.message; }
    finally { if (!disposed && token === version) { emit(); schedule(); } }
  }
  async function mutate(body, suffix, method) {
    if (disposed || state.busy) return false;
    version++; state.busy = true; state.error = ''; emit();
    try { await api(`/api/concept-map/${suffix}`, body, method); return true; }
    catch (e) { if (!disposed) state.error = e.message; return false; }
    finally { state.busy = false; if (!disposed) await refresh(); }
  }
  return { snapshot, refresh,
    async openConceptMap(key) { if (disposed) return; if (key) selectedKey = key; onOpen(); state.error = ''; await refresh(); },
    async selectMapConcept(key) { if (disposed) return; selectedKey = key; state.error = ''; await refresh(); },
    searchConceptMap(query) { state.query = query; emit(); },
    organizeConceptMap() { if (state.running || !state.concepts.length) return false; return mutate({}, 'organize', 'POST'); },
    updateConceptMap(body) { return mutate(body, 'manual', 'PUT'); },
    async openMapSource(mention) {
      try {
        const type = mention.sourceType === 'seminar' ? 'seminars' : 'concepts';
        await api(`/api/${type}/${encodeURIComponent(mention.sourceId)}`);
        if (!disposed && !await onSource(type, mention.sourceId)) throw Object.assign(new Error('原记录不存在'), { status: 404 });
      } catch (e) { if (!disposed) { state.error = e.status === 404 ? '原记录不存在' : e.message; emit(); } }
    },
    dispose() { disposed = true; version++; clearTimer(timer); },
  };
}

export function mapMatches(concept, query) {
  const fold = value => String(value || '').normalize('NFKC').toLowerCase();
  return [concept.key, concept.label, ...Object.values(concept.labels), ...(concept.aliases || [])].some(s => fold(s).includes(fold(query).trim()));
}

export function renderMapGraph(doc, selected, actions) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 640 480'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', `${selected.label}的关系图，Tab 或方向键切换节点，Enter 或空格打开`);
  svg.setAttribute('class', 'concept-map-graph');
  const make = (tag, attrs = {}, text) => { const el = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text !== undefined) el.textContent = text; return el; };
  const neighbors = [...selected.relations.map(r => ({ label: r.otherLabel, key: r.otherKey, type: r.type, action: () => actions.selectMapConcept(r.otherKey) })),
    ...selected.books.map(b => ({ label: b.bookLabel, key: b.agentId, type: '书籍', action: () => actions.openDetail(b.agentId) }))];
  const nodes = [], dash = { 相关: '', 对立: '8 5', 包含: '2 4', 因果: '10 3 2 3', 书籍: '1 4' };
  const addNode = (n, x, y, center = false) => {
    const el = make('a', { role: 'button', tabindex: '0', 'aria-label': `${n.type}：${n.label}`, 'data-focus-key': `map-node-${n.type}-${n.key}`, class: center ? 'map-center' : 'map-neighbor' });
    el.append(make('title', {}, n.label), make('circle', { cx: x, cy: y, r: center ? 46 : 24 }),
      make('text', { x, y: y + (center ? 4 : 43), 'text-anchor': 'middle' }, Array.from(n.label).slice(0, 8).join('') + (Array.from(n.label).length > 8 ? '…' : '')));
    el.addEventListener('click', n.action);
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return n.action(); }
      const i = nodes.indexOf(el), direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
      if (direction) { event.preventDefault(); nodes[(i + direction + nodes.length) % nodes.length].focus(); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); nodes[event.key === 'Home' ? 0 : nodes.length - 1].focus(); }
    }); nodes.push(el); return el;
  };
  const center = addNode({ label: selected.label, key: selected.key, type: '概念', action: () => actions.selectMapConcept(selected.key) }, 320, 230, true);
  neighbors.slice(0, 12).forEach((n, i, shown) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / shown.length, x = 320 + 230 * Math.cos(angle), y = 230 + 175 * Math.sin(angle);
    const line = make('line', { x1: 320, y1: 230, x2: x, y2: y, 'data-relation-type': n.type, 'stroke-dasharray': dash[n.type] });
    line.append(make('title', {}, n.type)); svg.append(line, addNode(n, x, y));
  });
  svg.append(center);
  if (neighbors.length > 12) svg.append(make('text', { x: 320, y: 474, 'text-anchor': 'middle', class: 'map-overflow' }, `另有 ${neighbors.length - 12} 个`));
  return svg;
}
