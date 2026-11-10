// keybar.js — the Wolfram key bar for touch devices (NOTEBOOK, SPEC §15.1).
// A row of big keys ( [ ] { } -> /. == := … ) pinned right above the on-screen keyboard whenever a notebook cell
// is focused, plus one fixed primary action at the right («▶ Evaluar» unless the host of the cell overrides it).
//
//   import { keybar } from './keybar.js?v=1794354627'
//   keybar.visible          true while the bar is shown
//   keybar.height           px taken by the bar itself (0 when hidden)
//   keybar.isTouch()        is this a touch device (pointer: coarse / Android app)?  keybar.force(true|false|null) for tests
//   keybar.update()         re-read the state of the focused cell (label of the primary action, ghost hint…)
// CSS variables kept up to date on <html>:
//   --vvh    height of the visual viewport in px (what is really visible above the keyboard)
//   --kb-h   px at the bottom of the layout viewport covered by keyboard + bar (reserve it with padding/scroll-margin)
// <html> also gets the classes  wl-touch  (touch device)  and  wl-kb-open  (bar visible).
//
// The cells talk to the bar through attach(target)/detach(target); a target is
//   { ta, el, type(text), move(±1), enter(), ghostNext(), isGhost(), primary(), run(), busy() }
// Keys go through target.type(), i.e. the same input path as the keyboard, so ghost validation applies.

const KEYS = ['[', ']', '{', '}', '(', ')', ',', '->', '/.', '==', '=', ':=', '^', '_', '*', '/', '+', '-', "'", '"', ';', '%', '<', '>', '#', '&', '.', 'Pi'];
const root = document.documentElement;
let forced = null;
let bar = null; let row = null; let primaryBtn = null; let sugBox = null;
let target = null;
let hideTimer = 0;
let raf = 0;
let inset = 0;
let suggestions = null;   // {list, pick}

function isTouch() {
  if (forced != null) return forced;
  try {
    if (/[?&]keybar=1\b/.test(location.search)) return true;
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (!!window.WolframLabApp && navigator.maxTouchPoints > 0);
  } catch { return false; }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// A press that never steals the focus from the textarea (so the keyboard stays up) and that is not triggered
// by a horizontal swipe over the keys: act on pointerup if the finger did not travel.
function pressable(node, onPress, repeat) {
  let start = null; let timer = 0; let fired = false;
  const stop = () => { clearTimeout(timer); clearInterval(timer); timer = 0; start = null; node.classList.remove('is-down'); };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY }; fired = false;
    node.classList.add('is-down');
    if (repeat) timer = setTimeout(() => { fired = true; onPress(); timer = setInterval(onPress, 70); }, 380);
  });
  node.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) stop(); });
  node.addEventListener('pointerup', (e) => { const ok = !!start && !fired; stop(); if (ok) { e.preventDefault(); onPress(); } });
  node.addEventListener('pointercancel', stop);
  node.addEventListener('pointerleave', stop);
  for (const ev of ['mousedown', 'touchend', 'click']) node.addEventListener(ev, (e) => e.preventDefault());
  node.tabIndex = -1;
}

function build() {
  if (bar) return;
  bar = el('div', 'wl-kb');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Teclas de Wolfram Language');
  bar.hidden = true;
  row = el('div', 'wl-kb-keys');
  sugBox = el('div', 'wl-kb-sugs');
  row.append(sugBox);
  const arrow = (label, d, name) => { const b = el('button', 'wl-kb-key wl-kb-arrow', label); b.type = 'button'; b.setAttribute('aria-label', name); pressable(b, () => target && target.move(d), true); row.append(b); return b; };
  arrow('←', -1, 'Mover el cursor a la izquierda');
  arrow('→', 1, 'Mover el cursor a la derecha');
  for (const k of KEYS) {
    const b = el('button', 'wl-kb-key', k);
    b.type = 'button';
    b.dataset.k = k;
    pressable(b, () => { if (target) { target.type(k); schedule(); } });
    row.append(b);
  }
  const nl = el('button', 'wl-kb-key wl-kb-arrow', '⏎');
  nl.type = 'button'; nl.dataset.k = '\n'; nl.setAttribute('aria-label', 'Nueva línea');
  pressable(nl, () => target && target.enter(true));
  row.append(nl);
  primaryBtn = el('button', 'wl-kb-primary', '▶ Evaluar');
  primaryBtn.type = 'button';
  pressable(primaryBtn, () => {
    if (!target) return;
    const p = target.primary && target.primary();
    if (p && p.disabled) return;
    if (p && typeof p.onPress === 'function') { try { p.onPress(); } catch (e) { console.error('[keybar] primary', e); } } else target.run();
    schedule();
  });
  bar.append(row, primaryBtn);
  document.body.append(bar);
}

// --------------------------------------------------------------------------------------------- geometry
function measure() {
  raf = 0;
  const v = window.visualViewport;
  const layoutH = window.innerHeight || root.clientHeight;
  const vvh = v ? v.height : layoutH;
  const zoomed = v && v.scale > 1.05;
  // part of the layout viewport that lies below the visual one = the on-screen keyboard on iOS Safari and on
  // Android Chrome (which only resizes the visual viewport); 0 in an Android WebView with adjustResize.
  inset = v && !zoomed ? Math.max(0, Math.round(layoutH - (v.offsetTop + v.height))) : 0;
  root.style.setProperty('--vvh', Math.round(vvh) + 'px');
  let h = 0;
  if (bar && !bar.hidden) {
    bar.style.transform = inset ? `translate3d(0, ${-inset}px, 0)` : '';
    bar.classList.toggle('wl-kb--osk', inset > 0);
    h = bar.offsetHeight;
  }
  keybar.height = h;
  root.style.setProperty('--kb-h', (keybar.visible ? inset + h : 0) + 'px');
}
function schedule() { if (!raf) raf = requestAnimationFrame(() => { measure(); paint(); }); }

// Keep the focused cell above the bar: the cell carries scroll-margin-bottom: var(--kb-h) (notebook.css).
let revealTimer = 0;
function reveal(delay = 60) {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (!target || !target.ta || document.activeElement !== target.ta) return;
    measure();
    const v = window.visualViewport;
    const top = (v ? v.offsetTop : 0) + 8;
    const bottom = (v ? v.offsetTop + v.height : window.innerHeight) - keybar.height - 10;
    const r = target.ta.getBoundingClientRect();
    if (r.bottom > bottom || r.top < top) {
      const node = target.ta.closest('.wl-in') || target.ta;
      try { node.scrollIntoView({ block: r.height > bottom - top ? 'end' : 'nearest', inline: 'nearest' }); } catch { node.scrollIntoView(false); }
      // scrollIntoView works on the layout viewport; finish the job inside the visual one if needed
      const r2 = target.ta.getBoundingClientRect();
      if (r2.bottom > bottom) window.scrollBy(0, Math.ceil(r2.bottom - bottom));
      else if (r2.top < top) window.scrollBy(0, Math.floor(r2.top - top));
    }
  }, delay);
}

// --------------------------------------------------------------------------------------------- painting
let lastNext = null;
function paint() {
  if (!bar || bar.hidden || !target) return;
  const p = (target.primary && target.primary()) || null;
  const busy = target.busy && target.busy();
  const label = p && p.label ? p.label : busy ? 'Evaluando…' : '▶ Evaluar';
  if (primaryBtn.textContent !== label) primaryBtn.textContent = label;
  const dim = !!(p ? p.disabled : busy || (target.isGhost() && target.ghostNext() != null));
  primaryBtn.classList.toggle('is-dim', dim);
  primaryBtn.classList.toggle('is-ready', !dim);
  bar.classList.toggle('wl-kb--ghost', !!target.isGhost());
  // ghost cells: light up the key that comes next (longest key that matches what the ghost expects)
  let next = null;
  const expect = target.isGhost() ? target.ghostNext() : null;
  if (expect) {
    if (expect[0] === '\n') next = '\n';
    else for (const k of KEYS) if (expect.startsWith(k) && (!next || k.length > next.length) && !(k === 'Pi' && /^Pi[A-Za-z0-9]/.test(expect))) next = k;
  }
  if (next !== lastNext) {
    lastNext = next;
    for (const b of row.querySelectorAll('.wl-kb-key')) b.classList.toggle('is-next', next != null && b.dataset.k === next);
    const b = next != null && row.querySelector('.wl-kb-key.is-next');
    if (b) {
      const want = b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2;
      try { row.scrollTo({ left: Math.max(0, want), behavior: 'smooth' }); } catch { row.scrollLeft = Math.max(0, want); }
    }
  }
  // completions as chips at the start of the row
  const list = suggestions && suggestions.list.length ? suggestions.list : null;
  const sig = list ? list.join('|') : '';
  if (sugBox.dataset.sig !== sig) {
    sugBox.dataset.sig = sig;
    sugBox.textContent = '';
    if (list) {
      for (const name of list.slice(0, 5)) {
        const c = el('button', 'wl-kb-key wl-kb-sug', name);
        c.type = 'button';
        pressable(c, () => { const s = suggestions; suggestions = null; if (s) s.pick(name); schedule(); });
        sugBox.append(c);
      }
      try { row.scrollTo({ left: 0 }); } catch { row.scrollLeft = 0; }
    }
  }
}

function show() {
  build();
  clearTimeout(hideTimer);
  if (bar.hidden) { bar.hidden = false; keybar.visible = true; root.classList.add('wl-kb-open'); lastNext = undefined; }
  measure(); paint();
  reveal(80); reveal(420);            // again once the keyboard has finished sliding in
}
function hide() {
  if (!bar || bar.hidden) return;
  bar.hidden = true; keybar.visible = false; suggestions = null;
  root.classList.remove('wl-kb-open');
  measure();
}

export const keybar = {
  visible: false,
  height: 0,
  isTouch,
  force(v) { forced = v; root.classList.toggle('wl-touch', isTouch()); if (!isTouch()) hide(); },
  attach(t) {
    if (!isTouch()) return;
    target = t; suggestions = null;
    show();
  },
  detach(t) {
    if (target !== t) return;
    clearTimeout(hideTimer);
    // focus usually comes straight back (a key was pressed, or the host moved it to the next cell): wait a moment
    hideTimer = setTimeout(() => { if (target === t && document.activeElement !== t.ta) { target = null; hide(); } }, 180);
  },
  update() { if (target) schedule(); },
  suggest(t, list, pick) { if (target !== t) return; suggestions = list && list.length ? { list, pick } : null; schedule(); },
  reveal() { reveal(40); },
  get target() { return target; },
};

// --------------------------------------------------------------------------------------------- wiring
if (isTouch()) root.classList.add('wl-touch');
const onViewport = () => { schedule(); if (target) reveal(120); };
try {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  if (window.matchMedia) {
    const mq = window.matchMedia('(pointer: coarse)');
    const flip = () => { root.classList.toggle('wl-touch', isTouch()); if (!isTouch()) hide(); };
    if (mq.addEventListener) mq.addEventListener('change', flip);
  }
} catch { /* very old browsers: no bar positioning */ }
measure();

export default keybar;
