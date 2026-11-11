// keybar.js — the Wolfram key bar for touch devices (NOTEBOOK, SPEC §15.1 + §15.4). Nothing of this exists on
// devices without a touch screen.
// ONE slim row pinned right above the on-screen keyboard while a notebook cell is focused:
//   [ the symbols THIS cell needs … (scrollable) ] [ ⋯ ] [ primary action ]
//   · cell keys: createCell(el, {keys: [...]}) / cell.setKeys([...]); by default they are derived from the cell's
//     ghost code with keysFor(code) — unique non-alphanumeric tokens, compound operators as one key, canonical order;
//   · in ghost cells the key that comes next is highlighted and scrolled into view;
//   · «⋯» opens a compact sheet with every symbol, grouped; a tap inserts and closes it, a long press keeps it open;
//   · the primary action («▶ Evaluar» unless the host of the cell sets another one) stays fixed at the right.
//
//   import { keybar, keysFor } from './keybar.js?v=1794355523'
//   keysFor(code)           → ['[', ']', ',', '->', …]   the symbol keys a piece of code needs
//   keybar.visible          true while the bar is shown
//   keybar.height           px taken by the bar itself (0 when hidden)
//   keybar.isTouch()        touch device? ((pointer: coarse) or the Android app)   keybar.force(true|false|null): tests
//   keybar.update()         re-read the state of the focused cell (keys, primary label, ghost hint…)
//   keybar.ensureVisible(el) scroll el into the strip that is visible between the top of the screen and the bar
// CSS variables kept up to date on <html>:
//   --vvh    height of the visual viewport in px (what is really visible above the keyboard)
//   --kb-h   px at the bottom of the layout viewport covered by keyboard + bar (reserve it with padding/scroll-margin)
// <html> also gets the classes  wl-touch  (touch device)  and  wl-kb-open  (bar visible).
//
// Cells talk to the bar through attach(target)/detach(target); a target is
//   { ta, type(text), move(±1), enter(explicit), keys(), ghostNext(), isGhost(), primary(), run(), busy(), actions() }
// Keys go through target.type(): the same input path as the keyboard, so ghost validation applies.
import { tokenize } from './wl-highlight.js?v=1794355523';

// Canonical order of the cell keys (never the order of appearance: that would give the answer away).
const ORDER = ['[', ']', '[[', ']]', '{', '}', '(', ')', ',', ';', '->', ':>', '=', ':=', '==', '===', '!=', '=!=', '<', '>', '<=', '>=', '&&', '||', '!',
  '+', '-', '*', '/', '^', '.', '_', '/.', '//.', '//', '/@', '@@', '@@@', '@', '&', '#', '%', "'", '"', '<>', ';;', '|', '/;', '?', ':', '~', '`'];
const RANK = new Map(ORDER.map((k, i) => [k, i]));
const DEFAULT_KEYS = ['[', ']', '{', '}', '(', ')', ',', ';', '->', '=', ':=', '==', '+', '-', '*', '/', '^', '_', '/.', '"'];
const SHEET = [
  ['Corchetes', ['[', ']', '{', '}', '(', ')', '[[', ']]']],
  ['Operadores', ['+', '-', '*', '/', '^', '.', ',', ';', "'", '"', '_', '#', '&', '%', '@', '!', '|']],
  ['Reglas y asignación', ['->', ':>', '=', ':=', '/.', '//.', '//', '/@', '@@', '<>', ';;']],
  ['Comparación y lógica', ['==', '!=', '<', '>', '<=', '>=', '===', '&&', '||']],
  ['Constantes', ['Pi', 'E', 'I', 'Infinity', 'Degree']],
  ['Cursor', ['←', '→', '⏎']],
];

// The symbol keys needed to type `code`: unique non-alphanumeric tokens, compound operators ( -> := == /. [[ … )
// as ONE key, in canonical order. No command names, letters or digits.
export function keysFor(code) {
  const set = new Set();
  const toks = tokenize(String(code == null ? '' : code)).filter((t) => t.t !== 'ws');
  // a[[i]] : two adjacent "[" whose partners are two adjacent "]"
  const mate = new Map(); const stack = []; const part = new Set();
  toks.forEach((t, i) => { if (t.t === 'open') stack.push(i); else if (t.t === 'close' && stack.length) { const j = stack.pop(); mate.set(j, i); } });
  toks.forEach((t, i) => {
    const n = toks[i + 1];
    if (t.v === '[' && n && n.v === '[' && n.s === t.e && mate.has(i) && mate.has(i + 1) && mate.get(i + 1) + 1 === mate.get(i)
      && toks[mate.get(i)].v === ']' && toks[mate.get(i + 1)].v === ']') { part.add(i); part.add(i + 1); part.add(mate.get(i)); part.add(mate.get(i + 1)); }
  });
  toks.forEach((t, i) => {
    switch (t.t) {
      case 'open': case 'close': set.add(part.has(i) ? t.v + t.v : t.v); break;
      case 'op': case 'other': set.add(t.v); break;
      case 'pattern': set.add('_'); break;
      case 'slot': set.add('#'); break;
      case 'string': set.add('"'); break;
      case 'comment': set.add('('); set.add('*'); set.add(')'); break;
      case 'number': if (t.v.includes('.')) set.add('.'); if (t.v.includes('`')) set.add('`'); if (t.v.includes('*^')) { set.add('*'); set.add('^'); } break;
      case 'symbol': if (t.v.includes('`')) set.add('`'); break;
      default: break;
    }
  });
  return [...set].sort((a, b) => (RANK.has(a) ? RANK.get(a) : 999) - (RANK.has(b) ? RANK.get(b) : 999) || (a < b ? -1 : 1));
}

const hasDom = typeof document !== 'undefined';
const root = hasDom ? document.documentElement : null;
let forced = null;
let bar = null; let row = null; let primaryBtn = null; let sugBox = null; let keyBox = null; let moreBtn = null; let sheet = null;
let target = null;
let hideTimer = 0;
let raf = 0;
let inset = 0;
let suggestions = null;   // {list, pick}
let shownKeys = null;
let actionsBox = null; let shownActions = null;

function isTouch() {
  if (!hasDom) return false;
  if (forced != null) return forced;
  try {
    if (/[?&]keybar=1\b/.test(location.search)) return true;
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (!!window.WolframLabApp && navigator.maxTouchPoints > 0);
  } catch { return false; }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// A press that never steals the focus from the textarea (so the keyboard stays up) and that is not triggered by
// a swipe over the keys: act on pointerup if the finger did not travel. opts.repeat: auto-repeat while held;
// opts.long: call onPress(true) after a long press instead.
function pressable(node, onPress, opts = {}) {
  let start = null; let timer = 0; let fired = false;
  const stop = () => { clearTimeout(timer); clearInterval(timer); timer = 0; start = null; node.classList.remove('is-down'); };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY }; fired = false;
    node.classList.add('is-down');
    if (opts.repeat) timer = setTimeout(() => { fired = true; onPress(true); timer = setInterval(() => onPress(true), 70); }, 380);
    else if (opts.long) timer = setTimeout(() => { fired = true; node.classList.remove('is-down'); onPress(true); }, 420);
  });
  node.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) stop(); });
  node.addEventListener('pointerup', (e) => { const ok = !!start && !fired; stop(); if (ok) { e.preventDefault(); onPress(false); } });
  node.addEventListener('pointercancel', stop);
  node.addEventListener('pointerleave', stop);
  for (const ev of ['mousedown', 'click', 'contextmenu']) node.addEventListener(ev, (e) => e.preventDefault());
  node.tabIndex = -1;
}

function press(k) {
  if (!target) return;
  if (k === '←') target.move(-1);
  else if (k === '→') target.move(1);
  else if (k === '⏎') target.enter(true);
  else target.type(k);
  schedule();
}
function keyButton(k, cls) {
  const b = el('button', 'wl-kb-key' + (cls ? ' ' + cls : ''), k);
  b.type = 'button';
  b.dataset.k = k;
  if (k === '←') b.setAttribute('aria-label', 'Mover el cursor a la izquierda');
  if (k === '→') b.setAttribute('aria-label', 'Mover el cursor a la derecha');
  if (k === '⏎') b.setAttribute('aria-label', 'Nueva línea');
  return b;
}

function build() {
  if (bar) return;
  bar = el('div', 'wl-kb');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Símbolos de Wolfram Language');
  bar.hidden = true;
  // the generic menu: every symbol, grouped
  sheet = el('div', 'wl-kb-sheet');
  sheet.hidden = true;
  for (const [title, keys] of SHEET) {
    const grp = el('div', 'wl-kb-group');
    grp.append(el('div', 'wl-kb-cap', title));
    const box = el('div', 'wl-kb-grid');
    for (const k of keys) {
      const arrow = k === '←' || k === '→';
      const b = keyButton(k, k.length > 2 ? 'wl-kb-word' : '');
      // tap: insert and close · long press: insert and keep the sheet open · arrows repeat and never close it
      pressable(b, (held) => { press(k); if (!held && !arrow) toggleSheet(false); }, arrow ? { repeat: true } : { long: true });
      box.append(b);
    }
    grp.append(box);
    sheet.append(grp);
  }
  actionsBox = el('div', 'wl-kb-group wl-kb-actions');
  sheet.append(actionsBox);
  const line = el('div', 'wl-kb-row');
  row = el('div', 'wl-kb-keys');
  sugBox = el('div', 'wl-kb-sugs');
  keyBox = el('div', 'wl-kb-cellkeys');
  row.append(sugBox, keyBox);
  moreBtn = el('button', 'wl-kb-key wl-kb-more', '⋯');
  moreBtn.type = 'button';
  moreBtn.setAttribute('aria-label', 'Todos los símbolos');
  moreBtn.setAttribute('aria-expanded', 'false');
  pressable(moreBtn, () => toggleSheet());
  primaryBtn = el('button', 'wl-kb-primary', '▶ Evaluar');
  primaryBtn.type = 'button';
  pressable(primaryBtn, () => {
    if (!target) return;
    toggleSheet(false);
    const p = target.primary && target.primary();
    if (p && p.disabled) return;
    if (p && typeof p.onPress === 'function') { try { p.onPress(); } catch (e) { console.error('[keybar] primary', e); } } else target.run();
    schedule();
  });
  line.append(row, moreBtn, primaryBtn);
  bar.append(sheet, line);
  document.body.append(bar);
}

function toggleSheet(open) {
  if (!sheet) return;
  const want = open == null ? sheet.hidden : !!open;
  if (want === !sheet.hidden) return;
  sheet.hidden = !want;
  moreBtn.classList.toggle('is-on', want);
  moreBtn.setAttribute('aria-expanded', String(want));
  measure(); paint();
  if (want) reveal(30);
}

// --------------------------------------------------------------------------------------------- geometry
function measure() {
  raf = 0;
  if (!hasDom) return;
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

// Scroll `node` into the strip that is really visible: below the top of the visual viewport, above the bar.
// Works with the page scroller or any scrollable ancestor. If the node is taller than the strip its top wins.
function ensureVisible(node, preferBottom) {
  if (!node || !node.getBoundingClientRect) return;
  measure();
  const v = window.visualViewport;
  const top = (v ? v.offsetTop : 0) + 8;
  const bottom = (v ? v.offsetTop + v.height : window.innerHeight) - keybar.height - 10;
  const r = node.getBoundingClientRect();
  let dy = 0;
  if (r.height > bottom - top) dy = preferBottom ? r.bottom - bottom : r.top - top;
  else if (r.bottom > bottom) dy = r.bottom - bottom;
  else if (r.top < top) dy = r.top - top;
  if (Math.abs(dy) < 1) return;
  let sc = node.parentElement;
  while (sc && sc !== document.body && sc !== root) {
    const o = getComputedStyle(sc).overflowY;
    if ((o === 'auto' || o === 'scroll') && sc.scrollHeight > sc.clientHeight + 1) break;
    sc = sc.parentElement;
  }
  if (sc && sc !== document.body && sc !== root) {
    const before = sc.scrollTop;
    sc.scrollTop += dy;
    dy -= sc.scrollTop - before;
    if (Math.abs(dy) < 1) return;
  }
  window.scrollBy(0, Math.round(dy));
}
// Keep the focused cell above the bar (again once the keyboard has finished sliding in).
let revealTimer = 0;
function reveal(delay = 60) {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (!target || !target.ta || document.activeElement !== target.ta) return;
    ensureVisible(target.ta.closest('.wl-in') || target.ta, true);
  }, delay);
}

// --------------------------------------------------------------------------------------------- painting
let lastNext;
function paint() {
  if (!bar || bar.hidden || !target) return;
  // the keys of this cell
  const keys = (target.keys && target.keys()) || DEFAULT_KEYS;
  const sig = keys.join('\u0001');
  if (sig !== shownKeys) {
    shownKeys = sig;
    keyBox.textContent = '';
    for (const k of keys) { const b = keyButton(k, k.length > 2 ? 'wl-kb-word' : ''); pressable(b, () => press(k)); keyBox.append(b); }
    lastNext = undefined;
    row.scrollLeft = 0;
  }
  // actions on the cell itself (new cell below, delete…): last group of the sheet
  const acts = (target.actions && target.actions()) || [];
  const asig = acts.map((a) => a.label).join('|');
  if (asig !== shownActions) {
    shownActions = asig;
    actionsBox.textContent = '';
    actionsBox.hidden = !acts.length;
    if (acts.length) {
      actionsBox.append(el('div', 'wl-kb-cap', 'Celda'));
      const box = el('div', 'wl-kb-grid');
      acts.forEach((a, i) => {
        const b = el('button', 'wl-kb-key wl-kb-word wl-kb-act', a.label);
        b.type = 'button';
        pressable(b, () => { toggleSheet(false); const cur = (target && target.actions && target.actions()) || []; if (cur[i]) { try { cur[i].onPress(); } catch (e) { console.error('[keybar] action', e); } } });
        box.append(b);
      });
      actionsBox.append(box);
    }
  }
  const p = (target.primary && target.primary()) || null;
  const busy = target.busy && target.busy();
  const label = p && p.label ? p.label : busy ? 'Evaluando…' : '▶ Evaluar';
  if (primaryBtn.textContent !== label) primaryBtn.textContent = label;
  const dim = !!(p ? p.disabled : busy || (target.isGhost() && target.ghostNext() != null));
  primaryBtn.classList.toggle('is-dim', dim);
  // ghost cells: light up the key that comes next (the longest key matching what the ghost expects);
  // if this cell's row does not have it, light «⋯», where every symbol lives
  let next = null;
  const expect = target.isGhost() ? target.ghostNext() : null;
  if (expect && !/^[A-Za-z0-9$\s]/.test(expect)) {
    for (const k of keys) if (expect.startsWith(k) && (!next || k.length > next.length)) next = k;
    if (!next) next = '⋯';
  }
  if (next !== lastNext) {
    lastNext = next;
    for (const b of keyBox.children) b.classList.toggle('is-next', next != null && b.dataset.k === next);
    moreBtn.classList.toggle('is-next', next === '⋯');
    const b = next != null && keyBox.querySelector('.is-next');
    if (b) {
      const want = b.offsetLeft - row.offsetLeft - (row.clientWidth - b.offsetWidth) / 2;
      try { row.scrollTo({ left: Math.max(0, want), behavior: 'smooth' }); } catch { row.scrollLeft = Math.max(0, want); }
    }
  }
  if (sheet && !sheet.hidden) {
    let best = null;
    if (expect && next === '⋯') for (const b of sheet.querySelectorAll('.wl-kb-key')) if (expect.startsWith(b.dataset.k) && (!best || b.dataset.k.length > best.length)) best = b.dataset.k;
    for (const b of sheet.querySelectorAll('.wl-kb-key')) b.classList.toggle('is-next', best != null && b.dataset.k === best);
  }
  // completions as chips at the start of the row (free cells)
  const list = suggestions && suggestions.list.length ? suggestions.list : null;
  const ssig = list ? list.join('|') : '';
  if (sugBox.dataset.sig !== ssig) {
    sugBox.dataset.sig = ssig;
    sugBox.textContent = '';
    if (list) {
      for (const name of list.slice(0, 5)) {
        const c = el('button', 'wl-kb-key wl-kb-sug', name);
        c.type = 'button';
        pressable(c, () => { const s = suggestions; suggestions = null; if (s) s.pick(name); schedule(); });
        sugBox.append(c);
      }
      row.scrollLeft = 0;
    }
  }
}

function show() {
  build();
  clearTimeout(hideTimer);
  if (bar.hidden) { bar.hidden = false; keybar.visible = true; root.classList.add('wl-kb-open'); lastNext = undefined; }
  measure(); paint();
  reveal(80); setTimeout(() => reveal(0), 450);
}
function hide() {
  if (!bar || bar.hidden) return;
  toggleSheet(false);
  bar.hidden = true; keybar.visible = false; suggestions = null;
  root.classList.remove('wl-kb-open');
  measure();
}

export const keybar = {
  visible: false,
  height: 0,
  isTouch,
  keysFor,
  force(v) { forced = v; root.classList.toggle('wl-touch', isTouch()); if (!isTouch()) hide(); },
  attach(t) {
    if (!isTouch()) return;
    if (target !== t) { suggestions = null; toggleSheet(false); }
    target = t;
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
  ensureVisible,
  get target() { return target; },
};

// --------------------------------------------------------------------------------------------- wiring
if (hasDom) {
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
}

export default keybar;
