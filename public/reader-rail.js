// 2026-11-01: in the reading mode a collapsed outline rail slides fully off the page after 3 s, leaving the text the
// whole width; resting the pointer on the left edge brings it back (an edge strip with a short delay against accidental
// passes, as in GitLab's sidebar peek and Obsidian's Auto Sidebar). Tab also brings it back, and keyboard focus on the rail
// holds it; focus left there by a mouse click does not. Shared by the book reader and the shelf's Word/lecture reader.
export function autoHideRail(doc, { dialog, rail, exit, edge, isCollapsed, isActive = () => true, onHidden,
  setTimer = setTimeout, clearTimer = clearTimeout, hideAfter = 3000, peekAfter = 120 }) {
  let hidden = false, hover = false, keyboard = false, hideTimer, peekTimer;
  const set = value => { if (hidden !== value) { hidden = value; onHidden(value); } };
  function schedule() {
    clearTimer(hideTimer);
    const held = keyboard && (rail.contains(doc.activeElement) || doc.activeElement === exit);
    if (dialog.open !== false && isCollapsed() && isActive() && !hover && !held) hideTimer = setTimer(() => set(true), hideAfter);
  }
  function reveal() { clearTimer(hideTimer); set(false); }
  // Revealed from the edge, it counts down at once: the rail slides in under a still pointer, so its own mouseenter may never
  // come; entering the rail cancels the countdown, and leaving it starts a new one.
  edge.addEventListener('mouseenter', () => { clearTimer(peekTimer); peekTimer = setTimer(() => { reveal(); schedule(); }, peekAfter); });
  edge.addEventListener('mouseleave', () => clearTimer(peekTimer));
  for (const part of [rail, exit]) {
    part.addEventListener('mouseenter', () => { hover = true; reveal(); });
    part.addEventListener('mouseleave', () => { hover = false; schedule(); });
    part.addEventListener('focusin', () => { if (keyboard) reveal(); });
    part.addEventListener('focusout', () => setTimer(schedule, 0));
  }
  dialog.addEventListener('mousedown', () => { keyboard = false; });
  dialog.addEventListener('keydown', event => { keyboard = true; if (event.key === 'Tab' && hidden) { reveal(); schedule(); } });
  return {
    schedule, reveal,
    // On close: no timers left, and the next opening starts with the rail in place.
    reset() { clearTimer(hideTimer); clearTimer(peekTimer); hover = false; set(false); },
    get hidden() { return hidden; },
  };
}
