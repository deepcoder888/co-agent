// Small recording DOM for event/state tests. It does not assert browser layout or rendering.
export function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
export function documentFrom(html) {
  const doc = { events: {}, activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.events = {}; this._text = ''; this.hidden = false; this.value = ''; this.open = false;
      // Record CSSOM writes separately from attributes; this does not simulate CSS/CSP.
      const properties = new Map();
      this.style = {
        setProperty: (key, value) => properties.set(key, String(value)),
        getPropertyValue: key => properties.get(key) || '',
        removeProperty: key => { const old = properties.get(key) || ''; properties.delete(key); return old; },
      };
    }
    get id() { return this.attrs.id; } set id(v) { this.attrs.id = v; }
    get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
    get parentElement() { return this.parent; }
    get isConnected() { return this === doc.documentElement || !!this.parent?.isConnected; }
    get options() { return this.children.filter(n => n.tagName === 'OPTION'); }
    set textContent(v) { this.replaceChildren(); this._text = String(v); }
    get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = undefined; }
    replaceChildren(...nodes) { this.children.forEach(n => { n.parent = undefined; }); this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'value') this.value = String(v); if (k === 'content') this.content = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; }
    addEventListener(k, f) { (this.events[k] ??= []).push(f); }
    removeEventListener(k, f) { this.events[k] = (this.events[k] || []).filter(x => x !== f); }
    async fire(k, e = {}) { e.target ??= this; e.currentTarget = this; e.preventDefault ??= () => {}; e.stopPropagation ??= () => {}; for (const fn of this.events[k] || []) await fn(e); }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; } close() { this.open = false; void this.fire('close'); }
    contains(other) { return descendants(this).includes(other); }
    matches(selector) {
      if (selector === '[hidden]') return this.hidden;
      const exclude = selector.match(/:not\(([^)]+)\)/);
      if (exclude && this.matches(exclude[1])) return false;
      selector = selector.replace(/:not\([^)]+\)/g, '');
      const tag = selector.match(/^[a-z]+/i)?.[0]; if (tag && tag.toUpperCase() !== this.tagName) return false;
      const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
      const cls = selector.match(/\.([\w-]+)/)?.[1]; if (cls && !this.className.split(/\s+/).includes(cls)) return false;
      for (const [, key, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!(key in this.attrs) || (value !== undefined && this.attrs[key] !== value)) return false;
      return true;
    }
    querySelectorAll(selector) { return descendants(this).slice(1).filter(n => selector.split(',').some(s => n.matches(s.trim()))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  }
  doc.createElement = tag => new Element(tag); doc.createElementNS = (_ns, tag) => new Element(tag);
  doc.documentElement = new Element('html');
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  doc.getElementById = id => descendants(doc.documentElement).find(n => n.id === id);
  doc.addEventListener = (k, f) => { (doc.events[k] ??= []).push(f); };
  doc.removeEventListener = (k, f) => { doc.events[k] = (doc.events[k] || []).filter(x => x !== f); };
  doc.fire = async (k, e) => { for (const fn of doc.events[k] || []) await fn(e); };
  const stack = [doc.documentElement];
  for (const part of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (part.startsWith('<!')) continue;
    if (part.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (part.startsWith('<')) {
      const tag = part.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const node = tag === 'html' ? doc.documentElement : new Element(tag);
      for (const [, key, value] of part.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(key, value ?? '');
      if (tag !== 'html') { stack.at(-1).append(node); if (!['meta', 'link', 'img', 'input', 'br', 'hr'].includes(tag) && !part.endsWith('/>')) stack.push(node); }
      continue;
    }
    stack.at(-1)._text += part;
  }
  doc.body = doc.querySelector('body');
  for (const select of doc.querySelectorAll('select')) select.value = select.options[0]?.value || '';
  return doc;
}
