// v0.38 motion: when a view or panel inside the page becomes visible, it gets the `ui-enter` class for a moment,
// so its own fade-in and its list items' stagger (styles.css) play once on entry and not on every re-render.
// Layouts re-render lists on every update; gating the item animation on this class keeps polling repaints still.
export const ENTER_MS = 700;
const timers = new Map();
// Layouts call this for content that changes in place (the shelf's rows when another category opens).
export function enter(el, ms = ENTER_MS) {
  if (!el?.classList || el.hidden) return;
  clearTimeout(timers.get(el)); el.classList.add('ui-enter');
  timers.set(el, setTimeout(() => { el.classList.remove('ui-enter'); timers.delete(el); }, ms));
}
export function mountMotion(doc, root = doc.getElementById('layout-root')) {
  const Observer = doc.defaultView?.MutationObserver;
  if (!root || typeof Observer !== 'function') return { dispose() {} };
  const observer = new Observer(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.oldValue !== null && !record.target.hidden) enter(record.target);
      // A newly mounted layout (start-up or a layout switch) enters as a whole.
      if (record.type === 'childList' && record.target === root) for (const added of record.addedNodes) enter(added);
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
  for (const child of Array.from(root.children || [])) enter(child);
  return { dispose() { observer.disconnect(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); } };
}
