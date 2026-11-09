export function manageDialog(doc, dialog, { labelledby, initialFocus } = {}) {
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  if (labelledby) dialog.setAttribute('aria-labelledby', labelledby);
  dialog.setAttribute('tabindex', '-1');
  let trigger;
  const focusable = () => Array.from(dialog.querySelectorAll?.('button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])') || [])
    .filter(n => !n.disabled && !n.hidden && n.getAttribute?.('tabindex') !== '-1' && !n.closest?.('[hidden]'));
  const restore = () => {
    let target = trigger;
    if (target?.isConnected === false) {
      const key = target.getAttribute?.('data-focus-key');
      target = Array.from(doc.querySelectorAll?.('[data-focus-key]') || []).find(n => n.getAttribute('data-focus-key') === key);
    }
    target?.focus?.();
  };
  const close = () => { dialog.close(); };
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusable();
    if (!nodes.length) { event.preventDefault(); dialog.focus?.(); return; }
    if (event.shiftKey && (doc.activeElement === nodes[0] || doc.activeElement === dialog)) { event.preventDefault(); nodes.at(-1).focus(); }
    else if (!event.shiftKey && (doc.activeElement === nodes.at(-1) || doc.activeElement === dialog)) { event.preventDefault(); nodes[0].focus(); }
  };
  dialog.addEventListener('keydown', keydown);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', restore);
  // v0.14: the heading (title + 关闭) stays pinned while the dialog body scrolls.
  dialog.addEventListener('scroll', () => markStuck(dialog));
  return { open(from = doc.activeElement) { trigger = from; dialog.showModal(); pinHeading(doc, dialog); (initialFocus || focusable()[0] || dialog).focus?.(); }, close };
}
// The sticky heading spans the dialog's padding box, so each skin's own padding is measured on open
// and passed as CSS variables (CSSOM; the page CSP forbids style attributes).
export function pinHeading(doc, dialog) {
  const view = doc.defaultView, heading = dialog.querySelector?.(':scope > .drawer-heading');
  if (!heading || typeof view?.getComputedStyle !== 'function' || !dialog.style?.setProperty) return;
  const style = view.getComputedStyle(dialog);
  for (const side of ['top', 'right', 'left']) dialog.style.setProperty(`--dialog-pad-${side}`, style.getPropertyValue(`padding-${side}`) || '0px');
  markStuck(dialog);
}
function markStuck(dialog) {
  const heading = dialog.querySelector?.(':scope > .drawer-heading');
  heading?.classList?.toggle('is-stuck', (dialog.scrollTop || 0) > 4);
}
export function createConfirmation(doc, { dialog, title, body, cancel, accept }) {
  if (!title.id) title.id = 'confirm-title';
  const controller = manageDialog(doc, dialog, { labelledby: title.id, initialFocus: cancel });
  let settle, closingValue = false;
  const finish = value => { if (!settle) return; closingValue = value; controller.close(); };
  accept.addEventListener('click', () => finish(true)); cancel.addEventListener('click', () => finish(false));
  // Native dialog close is asynchronous. Resolve only here, before opening another confirmation.
  dialog.addEventListener('close', () => { const done = settle, value = closingValue; settle = undefined; closingValue = false; done?.(value); });
  // Optional wording for specific actions (e.g. closing sessions); every other caller keeps the generic texts.
  return (text, trigger, { title: heading = '确认执行', accept: acceptText = '确认执行', danger = false } = {}) => new Promise(resolve => {
    if (settle) { resolve(false); return; }
    title.textContent = heading; accept.textContent = acceptText;
    const classes = String(accept.className || '').split(/\s+/).filter(c => c && c !== 'danger');
    accept.className = [...classes, ...(danger ? ['danger'] : [])].join(' ');
    body.textContent = text; settle = resolve; controller.open(trigger);
  });
}

export function createStatusToast(doc, {id, className, duration = 8000}) {
  const node=doc.createElement('div');node.id=id;node.className=className;node.hidden=true;
  node.setAttribute('role','status');node.setAttribute('aria-live','polite');node.setAttribute('aria-atomic','true');doc.body.append(node);
  let timer,disposed=false;
  return {
    show(text){if(disposed)return;clearTimeout(timer);node.textContent=text;node.hidden=false;timer=setTimeout(()=>{node.hidden=true;},duration);},
    dispose(){disposed=true;clearTimeout(timer);node.remove();}
  };
}
