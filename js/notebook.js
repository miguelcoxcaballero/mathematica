// notebook.js — the Mathematica-like notebook UI (NOTEBOOK). SPEC §4:
//   createNotebook(container, {cells:[{code,note?}], title?, compact?, onResult?(code,result), onChange?(codes)})
//       → {addCell(code), getCells(), evaluateAll(), focus(), destroy()}
//   createCell(container, {code, readOnly?, placeholder?, onResult?(code,result), autorun?,
//                          ghost?: "code to type", onProgress?(0..1), onComplete?()})          (ghost: SPEC §11)
//       → {run(), getCode(), setCode(c), focus(), el, clearOutput(), showResult(result), destroy(),
//          isComplete(), setGhost(code|null)}
//   renderItems(container, items, {labels?})  — appends the items of SPEC §2 (does not clear the container)
// Editing: Shift+Enter / Ctrl+Enter evaluate · Enter = newline with auto-indent · Tab/Shift+Tab indent ·
// brackets and quotes auto-close · live Mathematica colouring (wl-highlight.js) · autocomplete of System symbols ·
// F1 or ?Name shows the command card from data/commands.json.
import { kernel } from './kernel-client.js';
import { highlight, setSystemSymbols, systemSymbols, symbolAt, tokenize } from './wl-highlight.js';

// ------------------------------------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
const RUN_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.6 1.3v9.4L10.4 6z" fill="currentColor"/></svg>';

// Graphics modules belong to the GFX agent: load them lazily and survive their absence.
let gfx = null; let manip = null;
const gfxP = import('./gfx2d.js').then((m) => { gfx = m; return m; }).catch((e) => { console.warn('[notebook] gfx2d.js no disponible', e); return null; });
const manipP = import('./manipulate.js').then((m) => { manip = m; return m; }).catch((e) => { console.warn('[notebook] manipulate.js no disponible', e); return null; });

// ------------------------------------------------------------------------------------------------ catalogue
let catalog = null; let catalogP = null;
function loadCatalog() {
  if (!catalogP) {
    catalogP = fetch(new URL('../data/commands.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        catalog = new Map();
        for (const c of (j && j.commands) || []) if (c && c.name) catalog.set(c.name, c);
        return catalog;
      })
      .catch(() => { catalog = new Map(); return catalog; });
  }
  return catalogP;
}

// Every live editor, so colours can be refreshed when the kernel learns new symbols/definitions.
const editors = new Set();
let symbolsWanted = false;
let sortedSymbols = null;
function refreshAll() { for (const ed of editors) ed.refresh(); }
function wantSymbols() {
  if (symbolsWanted) return;
  const fetchThem = () => kernel.symbols().then((names) => { setSystemSymbols(names); sortedSymbols = null; refreshAll(); }).catch(() => { symbolsWanted = false; });
  // cached list → immediately; otherwise wait until someone starts the kernel (colouring never forces a download)
  let cached = false;
  try { cached = !!localStorage.getItem('wolframlab-symbols'); } catch { /* */ }
  if (cached || kernel.status === 'ready' || kernel.status === 'busy') { symbolsWanted = true; fetchThem(); }
}
kernel.onStatus((s) => { if (s === 'ready') wantSymbols(); });
kernel.onDefined(() => refreshAll());

// ------------------------------------------------------------------------------------------------ output
const MATHML_OK = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mfrac', 'msqrt', 'mroot', 'msup', 'msub', 'msubsup',
  'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'merror', 'mmultiscripts',
  'mprescripts', 'none', 'semantics', 'annotation', 'mfenced', 'span', 'br']);

function mathNode(mathml) {
  const t = document.createElement('template');
  t.innerHTML = mathml;
  const bad = [];
  const walk = (n) => {
    for (const c of [...n.children]) {
      if (!MATHML_OK.has(c.localName)) { bad.push(c); continue; }
      for (const a of [...c.attributes]) if (/^on/i.test(a.name) || /href|src/i.test(a.name)) c.removeAttribute(a.name);
      walk(c);
    }
  };
  walk(t.content);
  for (const b of bad) b.replaceWith(document.createTextNode(b.textContent || ''));
  const m = t.content.querySelector('math');
  if (!m) return null;
  m.setAttribute('display', 'inline');
  tidyMath(m);
  return m;
}

// Mathics' MathML is correct but spaced for a generic renderer. Make it read like Mathematica's StandardForm:
// "a - b x + 2 c", "{{x → 2}, {x → 3}}", "f[x, y]".
const MML = 'http://www.w3.org/1998/Math/MathML';
const INFIX = new Set(['+', '-', '=', '==', '===', '!=', '=!=', ':=', '->', ':>', '→', '⧴', '≠', '≥', '≤', '>', '<', '∧', '∨', '&&', '||', '/.', '//', '/;', '|', '∈', '⇒', '±', '×', '·', '*', '@@', '/@', '<>', '~~']);
function tidyMath(m) {
  const space = (mo, l, r) => { mo.setAttribute('lspace', l); mo.setAttribute('rspace', r); };
  for (const mn of m.querySelectorAll('mn')) {
    if (mn.textContent.trim() !== '-') continue;      // the minus sign arrives as <mn>-</mn>
    const mo = document.createElementNS(MML, 'mo');
    mo.textContent = '-';
    mn.replaceWith(mo);
  }
  for (const mo of m.querySelectorAll('mo')) {
    const t = mo.textContent;
    if (mo.hasAttribute('lspace')) continue;
    if (t === '\u00a0' || t === ' ') {                 // implicit multiplication
      const sp = document.createElementNS(MML, 'mspace');
      sp.setAttribute('width', '0.38em');
      mo.replaceWith(sp);
    } else if (/^[[\]{}()〚〛]$/.test(t)) space(mo, '0', '0');
    else if (t === ',' || t === ';') space(mo, '0', '0.42em');
    else if (INFIX.has(t.trim())) {
      const infix = !!mo.previousElementSibling && !!mo.nextElementSibling;
      mo.setAttribute('form', infix ? 'infix' : 'prefix');
      if (infix) space(mo, '0.32em', '0.32em'); else space(mo, '0', '0');
    }
  }
  // the arrow of rules is written as <mtext>→</mtext>
  for (const x of m.querySelectorAll('mtext')) if (INFIX.has(x.textContent.trim())) x.classList.add('wl-oper');
}

function copyButton(text) {
  const b = h('button', { class: 'wl-copy', type: 'button', title: 'Copiar como texto (InputForm)', text: 'copiar' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* */ } ta.remove();
    }
    b.textContent = 'copiado'; b.classList.add('is-done');
    setTimeout(() => { b.textContent = 'copiar'; b.classList.remove('is-done'); }, 1200);
  });
  return b;
}

function collapseIfLong(body) {
  requestAnimationFrame(() => {
    if (!body.isConnected || body.scrollHeight <= 460) return;
    body.classList.add('is-collapsed');
    const more = h('button', { class: 'wl-more', type: 'button', text: 'mostrar más' });
    more.addEventListener('click', () => {
      const open = body.classList.toggle('is-collapsed');
      more.textContent = open ? 'mostrar más' : 'mostrar menos';
    });
    body.after(more);
  });
}

// Body of one output (no label): expr | graphics | gallery | manipulate
function renderBody(item) {
  const type = item.type || (item.g ? 'graphics' : item.rows ? 'gallery' : 'expr');
  if (type === 'graphics') {
    const host = h('div', { class: 'wl-body wl-gfx-host' });
    const paint = (m) => {
      if (!m || !m.renderGraphics) { host.append(h('div', { class: 'wl-placeholder', text: 'Gráfico (el módulo de gráficos no está disponible)' })); return; }
      try { host.__wl = m.renderGraphics(host, item.g); } catch (e) { console.error('[notebook] renderGraphics', e); host.append(h('div', { class: 'wl-placeholder', text: 'No se pudo dibujar el gráfico: ' + (e.message || e) })); }
    };
    if (gfx) paint(gfx); else gfxP.then((m) => { if (host.isConnected || !host.__dead) paint(m); });
    return host;
  }
  if (type === 'manipulate') {
    const host = h('div', { class: 'wl-body wl-manip-host' });
    const paint = (m) => {
      if (!m || !m.renderManipulate) {
        host.append(h('div', { class: 'wl-placeholder', text: 'Manipulate (el módulo interactivo no está disponible)' }));
        if (item.initial && item.initial.items) renderItems(host, item.initial.items);
        return;
      }
      try { host.__wl = m.renderManipulate(host, item, kernel, (el, items) => renderItems(el, items)); } catch (e) { console.error('[notebook] renderManipulate', e); host.append(h('div', { class: 'wl-placeholder', text: 'No se pudo crear el Manipulate: ' + (e.message || e) })); }
    };
    if (manip && gfx) paint(manip); else Promise.all([manipP, gfxP]).then(([m]) => paint(m));
    return host;
  }
  if (type === 'gallery') {
    const g = h('div', { class: 'wl-body wl-gallery' });
    for (const row of item.rows || []) {
      const r = h('div', { class: 'wl-gallery-row' });
      for (const sub of row || []) if (sub) r.append(h('div', { class: 'wl-gallery-cell' }, renderBody(sub)));
      g.append(r);
    }
    return g;
  }
  const body = h('div', { class: 'wl-body wl-expr' });
  let m = null;
  if (item.mathml) { try { m = mathNode(item.mathml); } catch { m = null; } }
  if (m) body.append(m);
  else body.append(h('pre', { class: 'wl-plain', text: item.plain ?? item.text ?? '' }));
  return body;
}

function renderItem(item, labels) {
  if (!item) return null;
  if (item.kind === 'message') {
    const name = item.symbol ? `${item.symbol}::${item.tag || ''}` : '';
    const row = h('div', { class: 'wl-item wl-msg' }, labels ? h('div', { class: 'wl-label' }) : null,
      h('div', { class: 'wl-body' }, name ? h('span', { class: 'wl-msg-name', text: name + ': ' }) : null, h('span', { text: item.text || '' })));
    return row;
  }
  if (item.kind === 'print') {
    return h('div', { class: 'wl-item wl-print' }, labels ? h('div', { class: 'wl-label' }) : null, h('div', { class: 'wl-body' }, h('pre', { class: 'wl-plain', text: item.text ?? '' })));
  }
  const body = renderBody(item);
  const row = h('div', { class: 'wl-item wl-out wl-out--' + (item.type || 'expr') });
  if (labels) row.append(h('div', { class: 'wl-label', text: item.line != null ? `Out[${item.line}]=` : '' }));
  const wrap = h('div', { class: 'wl-out-wrap' }, body);
  row.append(wrap);
  if ((item.type || 'expr') === 'expr') {
    if (item.text) wrap.append(copyButton(item.text));
    collapseIfLong(body);
  }
  if (labels) row.append(h('div', { class: 'wl-bracket' }));
  return row;
}

export function renderItems(container, items, opts = {}) {
  if (!container) return container;
  for (const item of items || []) {
    let node = null;
    try { node = renderItem(item, !!opts.labels); } catch (e) { console.error('[notebook] renderItems', e); node = h('div', { class: 'wl-item wl-msg', text: 'No se pudo mostrar esta salida.' }); }
    if (node) container.append(node);
  }
  return container;
}

function disposeOutputs(root) {
  for (const el of root.querySelectorAll('.wl-gfx-host, .wl-manip-host')) {
    el.__dead = true;
    try { el.__wl && el.__wl.destroy && el.__wl.destroy(); } catch { /* */ }
  }
}

// ------------------------------------------------------------------------------------------------ help card
function helpCard(name, onClose) {
  const card = h('div', { class: 'wl-help' });
  const fill = () => {
    card.textContent = '';
    const c = catalog && catalog.get(name);
    const close = h('button', { class: 'wl-help-x', type: 'button', title: 'Cerrar', text: '×', onclick: onClose });
    card.append(close, h('div', { class: 'wl-help-name', text: name }));
    if (!c) {
      card.append(h('div', { class: 'wl-help-desc', text: systemSymbols().has(name) ? 'Símbolo de Wolfram Language (todavía sin ficha en el catálogo).' : 'No es un símbolo del sistema: revisa las mayúsculas o defínelo tú.' }));
      return;
    }
    for (const s of (c.syntax || []).slice(0, 3)) card.append(h('code', { class: 'wl-help-syn', text: s }));
    if (c.desc) card.append(h('div', { class: 'wl-help-desc', text: c.desc }));
    const ex = (c.examples || [])[0];
    if (ex && ex.code) card.append(h('div', { class: 'wl-help-ex' }, h('span', { text: 'Ejemplo: ' }), h('code', { text: ex.code })));
    if (location.hash !== undefined) card.append(h('a', { class: 'wl-help-link', href: '#/comandos/' + encodeURIComponent(name), text: 'Ver ficha completa' }));
  };
  fill();
  if (!catalog) loadCatalog().then(fill);
  return card;
}

// ------------------------------------------------------------------------------------------------ autocomplete
let popup = null;
function closePopup() { if (popup) { popup.el.remove(); popup = null; } }
function candidates(prefix) {
  if (!sortedSymbols) sortedSymbols = [...systemSymbols()].sort();
  const out = [];
  for (const n of sortedSymbols) if (n.startsWith(prefix)) out.push(n);
  if (out.length === 1 && out[0] === prefix) return [];
  const rank = (n) => { const c = catalog && catalog.get(n); return c ? -(1e6 + (c.freq || 0)) : n.length; };
  out.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return out.slice(0, 40);
}
function openPopup(ed, sym) {
  const list = candidates(sym.name);
  if (!list.length) return closePopup();
  loadCatalog().then(() => { if (popup && popup.ed === ed) paintPopup(); });
  if (!popup || popup.ed !== ed) {
    closePopup();
    const el = h('div', { class: 'wl-ac', role: 'listbox' });
    document.body.append(el);
    popup = { ed, el, index: 0, list, sym };
  } else { popup.list = list; popup.sym = sym; popup.index = Math.min(popup.index, list.length - 1); if (list[popup.index] !== popup.current) popup.index = 0; }
  paintPopup();
  const r = ed.caretRect(sym.start);
  const el = popup.el;
  const w = Math.min(320, window.innerWidth - 16);
  el.style.width = w + 'px';
  let left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  const hgt = el.offsetHeight;
  if (top + hgt > window.innerHeight - 8 && r.top - hgt - 4 > 0) top = r.top - hgt - 4;
  el.style.left = left + 'px'; el.style.top = top + 'px';
}
function paintPopup() {
  const { el, list, index, sym } = popup;
  popup.current = list[index];
  el.textContent = '';
  const ul = h('div', { class: 'wl-ac-list' });
  list.forEach((n, i) => {
    const it = h('div', { class: 'wl-ac-item' + (i === index ? ' is-sel' : ''), role: 'option' }, h('b', { text: n.slice(0, sym.name.length) }), n.slice(sym.name.length));
    it.addEventListener('mousedown', (e) => { e.preventDefault(); popup.index = i; acceptPopup(); });
    ul.append(it);
  });
  el.append(ul);
  const c = catalog && catalog.get(list[index]);
  if (c) el.append(h('div', { class: 'wl-ac-desc' }, c.syntax && c.syntax[0] ? h('code', { text: c.syntax[0] }) : null, c.desc ? h('span', { text: ' ' + String(c.desc).split(/(?<=\.)\s/)[0] }) : null));
  const sel = ul.children[index];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}
function acceptPopup() {
  if (!popup) return;
  const { ed, sym, list, index } = popup;
  closePopup();
  ed.replaceRange(sym.start, ed.ta.selectionStart, list[index]);
}
window.addEventListener('scroll', () => closePopup(), true);
window.addEventListener('resize', () => closePopup());

// ------------------------------------------------------------------------------------------------ editor
const OPEN = { '[': ']', '{': '}', '(': ')' };
const CLOSE = new Set([']', '}', ')']);

// --- ghost typing (SPEC §11) ---------------------------------------------------------------------------
// The reference code is shown gray; what the student types turns black in place. Comparison ignores spaces and
// tabs (never line breaks); typographic quotes/dashes from phone keyboards count as their ASCII twins.
const normTyped = (s) => String(s).replace(/\r/g, '').replace(/[\u201c\u201d\u201e\u00ab\u00bb\u2033]/g, '"').replace(/[\u2018\u2019\u201a\u2032\u00b4]/g, "'")
  .replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...').replace(/\u00a0/g, ' ');
const prepGhost = (g) => normTyped(g).replace(/\t/g, '  ').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
const isSp = (c) => c === ' ' || c === '\t';
const skipSp = (G, p) => { while (p < G.length && isSp(G[p])) p++; return p; };
// How far into the ghost G does the typed text V get?  → {p: ghost chars consumed, okLen: good prefix of V,
// wrong: mistyped tail, bounced: an Enter/space that was simply ignored}
function ghostWalk(G, V) {
  let p = 0; let i = 0;
  for (; i < V.length; i++) {
    const c = V[i];
    if (isSp(c)) continue;
    const q = skipSp(G, p);
    if (q < G.length && G[q] === c) { p = q + 1; if (c === '\n') p = skipSp(G, p); } else break;
  }
  let wrong = V.slice(i).replace(/\n/g, '');
  let bounced = false;
  if (!wrong.trim()) { bounced = V.slice(i).includes('\n'); wrong = ''; if (V.length && isSp(V[V.length - 1])) p = skipSp(G, p); }
  else { wrong = wrong.replace(/^\s+/, '').slice(0, 6); }
  return { p, okLen: i, wrong, bounced };
}

function createEditor({ code = '', readOnly = false, placeholder = '', onRun, onHelp, onInput, ghost = null, onGhost }) {
  let G = ghost != null ? prepGhost(ghost) : null;
  const pre = h('pre', { class: 'wl-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'wl-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', rows: '1', 'aria-label': 'Celda de entrada de Wolfram Language', placeholder });
  if (readOnly) ta.readOnly = true;
  const el = h('div', { class: 'wl-editor' + (readOnly ? ' is-readonly' : '') + (G != null ? ' is-ghost' : '') }, pre, ta);
  ta.value = G != null ? '' : code;
  let focused = false;
  let gstate = { p: 0, wrong: '', complete: false };
  let composing = false;

  // Re-derive the ghost state from whatever is in the textarea; unless the keyboard is mid-composition (dead keys,
  // Android word composing) the textarea is rewritten to the canonical "ghost prefix + mistyped tail".
  function ghostSync(quiet) {
    const V = normTyped(ta.value);
    const st = ghostWalk(G, V);
    let ok;
    if (!composing) {
      const canon = G.slice(0, st.p) + st.wrong;
      if (ta.value !== canon) ta.value = canon;
      if (ta.selectionStart !== canon.length || ta.selectionEnd !== canon.length) ta.setSelectionRange(canon.length, canon.length);
      ok = G.slice(0, st.p);
    } else ok = V.slice(0, st.okLen);
    const rest = G.slice(st.p);
    pre.innerHTML = highlight(ok + rest, { defined: kernel.defined, ghostFrom: ok.length, wrong: st.wrong }) + '\n';
    const complete = !st.wrong && skipSp(G, st.p) >= G.length;
    const was = gstate;
    gstate = { p: st.p, wrong: st.wrong, complete };
    el.classList.toggle('is-wrong', !!st.wrong);
    el.classList.toggle('is-complete', complete);
    if (!quiet && onGhost) {
      const total = G.replace(/[ \t]/g, '').length || 1;
      onGhost({ progress: G.slice(0, st.p).replace(/[ \t]/g, '').length / total, complete, justCompleted: complete && !was.complete,
        wrong: st.wrong, expected: G[skipSp(G, st.p)], bounced: st.bounced });
    }
  }

  const ed = {
    el, ta,
    ghost: {
      active: () => G != null,
      complete: () => G != null && gstate.complete,
      set(g) { G = g == null ? null : prepGhost(g); el.classList.toggle('is-ghost', G != null); ta.value = ''; gstate = { p: 0, wrong: '', complete: false }; ed.refresh(); },
      shake() { el.classList.remove('wl-shake'); void el.offsetWidth; el.classList.add('wl-shake'); },
    },
    refresh() {
      if (G != null) { ghostSync(true); return; }
      const v = ta.value;
      const caret = focused && ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null;
      pre.innerHTML = highlight(v, { defined: kernel.defined, caret }) + '\n';
    },
    // Insert through execCommand so the browser's own undo stack keeps working.
    insert(text) {
      ta.focus();
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
      if (!ok) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    },
    replaceRange(from, to, text) { ta.focus(); ta.setSelectionRange(from, to); ed.insert(text); },
    caretRect(pos) {
      // the <pre> mirrors the textarea glyph for glyph: measure there
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      let left = pos; let node;
      while ((node = walker.nextNode())) {
        if (left <= node.length) {
          const r = document.createRange();
          r.setStart(node, left); r.setEnd(node, left);
          const rects = r.getClientRects();
          const b = rects.length ? rects[0] : r.getBoundingClientRect();
          if (b && (b.top || b.left)) return b;
          break;
        }
        left -= node.length;
      }
      return ta.getBoundingClientRect();
    },
    destroy() { editors.delete(ed); if (popup && popup.ed === ed) closePopup(); },
  };

  const lineStart = (v, pos) => v.lastIndexOf('\n', pos - 1) + 1;
  function indentLines(out) {
    const v = ta.value; const s0 = ta.selectionStart; const e0 = ta.selectionEnd;
    const from = lineStart(v, s0);
    let to = v.indexOf('\n', e0 > s0 && v[e0 - 1] === '\n' ? e0 - 1 : e0); if (to < 0) to = v.length;
    const lines = v.slice(from, to).split('\n');
    let dFirst = 0; let dAll = 0;
    const next = lines.map((ln, i) => {
      if (!out) { if (i === 0) dFirst = 2; dAll += 2; return '  ' + ln; }
      const m = /^( {1,2}|\t)/.exec(ln); const d = m ? m[0].length : 0;
      if (i === 0) dFirst = -Math.min(d, s0 - from); dAll -= d; return ln.slice(d);
    });
    ed.replaceRange(from, to, next.join('\n'));
    ta.setSelectionRange(Math.max(from, s0 + dFirst), Math.max(from, e0 + dAll));
  }

  function ghostKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && (e.shiftKey || mod)) { e.preventDefault(); onRun && onRun(); return; }
    if (e.key === 'F1') { e.preventDefault(); const sym = symbolAt(G, Math.min(G.length, gstate.p)); if (sym && onHelp) onHelp(sym.name); return; }
    if (mod && /^[zyv]$/i.test(e.key)) { e.preventDefault(); return; }            // no undo / paste games
    if (['ArrowLeft', 'ArrowUp', 'Home', 'PageUp'].includes(e.key)) { e.preventDefault(); return; }
    const len = ta.value.length;
    if (ta.selectionStart !== len || ta.selectionEnd !== len) ta.setSelectionRange(len, len);   // always type at the end
    if (e.key === 'Enter') {
      e.preventDefault();
      if (gstate.wrong) { ed.ghost.shake(); return; }
      const q = skipSp(G, gstate.p);
      if (G[q] === '\n') { ta.value = G.slice(0, q + 1); ghostSync(); onInput && onInput(); } else { ed.ghost.shake(); onGhost && onGhost({ enterBlocked: true, complete: gstate.complete }); }
    }
  }

  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; if (G != null) { ghostSync(); onInput && onInput(); } });
  for (const ev of ['paste', 'drop', 'cut']) ta.addEventListener(ev, (e) => { if (G != null) e.preventDefault(); });
  ta.addEventListener('beforeinput', (e) => { if (G != null && /^(insertFromPaste|insertFromDrop|insertFromYank|historyUndo|historyRedo)$/.test(e.inputType || '')) e.preventDefault(); });

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (G != null) { ghostKey(e); return; }
    const v = ta.value; const s = ta.selectionStart; const en = ta.selectionEnd;
    if (popup && popup.ed === ed) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        popup.index = (popup.index + (e.key === 'ArrowDown' ? 1 : popup.list.length - 1)) % popup.list.length; paintPopup(); return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') { e.preventDefault(); acceptPopup(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(); return; }
    }
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); closePopup(); onRun && onRun(); return; }
    if (e.key === 'F1') { e.preventDefault(); const sym = symbolAt(v, s); if (sym && onHelp) onHelp(sym.name); return; }
    if (readOnly) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const ls = lineStart(v, s);
      const line = v.slice(ls, s);
      let indent = /^[ \t]*/.exec(line)[0];
      let depth = 0;
      for (const t of tokenize(line)) { if (t.t === 'open') depth++; else if (t.t === 'close') depth--; }
      if (depth > 0) indent += '  ';
      else if (depth < 0) indent = indent.slice(0, Math.max(0, indent.length - 2));
      const prev = v[s - 1]; const next = v[en];
      if (s === en && OPEN[prev] && OPEN[prev] === next) {
        const outer = /^[ \t]*/.exec(line)[0];
        ed.insert('\n' + outer + '  ' + '\n' + outer);
        const p = s + 1 + outer.length + 2; ta.setSelectionRange(p, p);
      } else ed.insert('\n' + indent);
      return;
    }
    if (e.key === 'Tab') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (e.shiftKey || v.slice(s, en).includes('\n')) indentLines(e.shiftKey); else ed.insert('  ');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (OPEN[e.key]) {
      const close = OPEN[e.key];
      if (s !== en) { e.preventDefault(); const sel = v.slice(s, en); ed.insert(e.key + sel + close); ta.setSelectionRange(s + 1, en + 1); return; }
      const next = v[en];
      if (next === undefined || /[\s\])},;]/.test(next)) { e.preventDefault(); ed.insert(e.key + close); ta.setSelectionRange(s + 1, s + 1); }
      return;
    }
    if (CLOSE.has(e.key) && s === en && v[s] === e.key) {
      // type over the closer that was inserted automatically (only while brackets are balanced)
      let bal = 0;
      for (const t of tokenize(v)) { if (t.t === 'open' && t.v === Object.keys(OPEN).find((k) => OPEN[k] === e.key)) bal++; else if (t.t === 'close' && t.v === e.key) bal--; }
      if (bal <= 0) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); ed.refresh(); }
      return;
    }
    if (e.key === '"') {
      if (s !== en) { e.preventDefault(); const sel = v.slice(s, en); ed.insert('"' + sel + '"'); ta.setSelectionRange(s + 1, en + 1); return; }
      const inside = tokenize(v).find((t) => t.s < s && s < t.e && (t.t === 'string' || t.t === 'comment'));
      if (inside && inside.t === 'string' && v[s] === '"' && s === inside.e - 1 && v[s - 1] !== '\\') { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return; }
      if (!inside && (v[s] === undefined || /[\s\])},;]/.test(v[s]))) { e.preventDefault(); ed.insert('""'); ta.setSelectionRange(s + 1, s + 1); }
      return;
    }
    if (e.key === 'Backspace' && s === en && s > 0) {
      const a = v[s - 1]; const b = v[s];
      if ((OPEN[a] && OPEN[a] === b) || (a === '"' && b === '"' && v[s - 2] !== '\\')) {
        e.preventDefault(); ta.setSelectionRange(s - 1, s + 1);
        let ok = false; try { ok = document.execCommand('delete'); } catch { ok = false; }
        if (!ok) { ta.setRangeText('', s - 1, s + 1, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }
  });

  ta.addEventListener('input', (e) => {
    if (G != null) { composing = !!(e && e.isComposing); ghostSync(); onInput && onInput(); return; }
    ed.refresh();
    if (!readOnly) {
      const s = ta.selectionStart;
      const sym = s === ta.selectionEnd ? symbolAt(ta.value, s) : null;
      if (sym && sym.end === s && sym.name.length >= 2 && /^[A-Z$]/.test(sym.name)) openPopup(ed, sym); else closePopup();
    }
    onInput && onInput();
  });
  ta.addEventListener('focus', () => { focused = true; el.classList.add('is-focus'); ed.refresh(); wantSymbols(); });
  ta.addEventListener('blur', () => { focused = false; el.classList.remove('is-focus'); ed.refresh(); setTimeout(() => { if (popup && popup.ed === ed && document.activeElement !== ta) closePopup(); }, 120); });
  const onSel = () => { if (focused) ed.refresh(); };
  ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') { onSel(); if (popup && popup.ed === ed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) closePopup(); } });
  ta.addEventListener('click', () => { if (G != null) { const n = ta.value.length; ta.setSelectionRange(n, n); return; } onSel(); closePopup(); });

  editors.add(ed);
  ed.refresh();
  return ed;
}

// ------------------------------------------------------------------------------------------------ cell
export function createCell(container, opts = {}) {
  const label = h('div', { class: 'wl-label', text: 'In[ ]:=' });
  const outs = h('div', { class: 'wl-outs' });
  const status = h('div', { class: 'wl-status', hidden: true });
  const helpSlot = h('div', { class: 'wl-help-slot' });
  const runBtn = h('button', { class: 'wl-run', type: 'button', title: 'Evaluar (Shift+Enter)', 'aria-label': 'Evaluar celda' });
  runBtn.innerHTML = RUN_ICON;
  let running = null;
  let destroyed = false;
  let timer = null; let offStatus = null; let t0 = 0;

  const showHelp = (name) => {
    helpSlot.textContent = '';
    helpSlot.append(helpCard(name, () => { helpSlot.textContent = ''; }));
  };
  const hint = h('div', { class: 'wl-hint', hidden: true });
  let hintTimer = null;
  const say = (text, sticky) => {
    clearTimeout(hintTimer);
    hint.textContent = text || ''; hint.hidden = !text;
    if (text && !sticky) hintTimer = setTimeout(() => { hint.hidden = true; }, 2600);
  };
  const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  const EVAL_HINT = touch ? 'Pulsa ▶ para evaluar' : 'Shift + Enter para evaluar';
  let completedOnce = false;
  const onGhost = (g) => {
    if (g.enterBlocked) { say(g.complete ? EVAL_HINT : 'Escribe la línea completa', g.complete); return; }
    if (g.wrong) {
      const exp = g.expected;
      const same = exp && g.wrong[0] && exp.toLowerCase() === g.wrong[0].toLowerCase();
      say(exp === undefined ? 'Ya está todo escrito: borra lo que sobra' : exp === '\n' ? 'Aquí toca salto de línea (Enter)' : `Aquí va «${exp}»` + (same ? ' — ojo con las mayúsculas' : ''), true);
    } else if (g.bounced) say('Escribe la línea completa');
    else if (g.complete) say(EVAL_HINT, true);
    else say('');
    el.classList.toggle('is-ghost-complete', !!g.complete);
    if (opts.onProgress) { try { opts.onProgress(g.progress); } catch (e) { console.error(e); } }
    if (g.justCompleted) { completedOnce = true; if (opts.onComplete) { try { opts.onComplete(); } catch (e) { console.error(e); } } }
  };
  const editor = createEditor({ code: opts.code || '', readOnly: !!opts.readOnly, placeholder: opts.placeholder || '', onRun: () => { run(); }, onHelp: showHelp, onInput: () => { opts.onInput && opts.onInput(); }, ghost: opts.ghost != null ? opts.ghost : null, onGhost });
  const el = h('div', { class: 'wl-cell' + (opts.ghost != null ? ' wl-cell--ghost' : '') },
    h('div', { class: 'wl-in' }, label, editor.el, h('div', { class: 'wl-tools' }, runBtn), h('div', { class: 'wl-bracket' })),
    hint, helpSlot, status, outs, h('div', { class: 'wl-bracket wl-bracket--group' }));
  runBtn.addEventListener('click', () => { run(); });
  if (container) container.append(el);

  function paintStatus() {
    if (!running) return;
    const s = kernel.status; const p = kernel.progress || { phase: '', pct: 0 };
    status.hidden = false;
    status.textContent = '';
    const secs = Math.round((performance.now() - t0) / 1000);
    if (s === 'loading' || s === 'idle') {
      status.className = 'wl-status is-loading';
      status.append(h('div', { class: 'wl-status-text', text: (p.phase || 'Preparando el kernel…') + ' ' + Math.round((p.pct || 0) * 100) + ' %' }),
        h('div', { class: 'wl-bar' }, h('i', { style: `width:${Math.round((p.pct || 0) * 100)}%` })));
    } else if (s === 'error') {
      status.className = 'wl-status is-error';
      status.append(h('div', { class: 'wl-status-text', text: p.phase || 'No se pudo cargar el kernel.' }));
    } else if (secs >= 3 || kernel.stuck) {
      status.className = 'wl-status is-busy' + (kernel.stuck ? ' is-stuck' : '');
      status.append(h('span', { class: 'wl-status-text', text: kernel.stuck ? `Esta evaluación lleva ${secs} s y no responde. ` : `Calculando… ${secs} s ` }),
        h('button', { class: 'wl-link', type: 'button', text: 'Abortar evaluación', title: 'Detiene el cálculo reiniciando el kernel (se pierden las definiciones)', onclick: () => { kernel.abort().catch(() => {}); } }));
    } else { status.hidden = true; }
  }
  function setRunning(on) {
    el.classList.toggle('is-running', on);
    runBtn.disabled = on;
    if (on) {
      t0 = performance.now();
      offStatus = kernel.onStatus(paintStatus);
      timer = setInterval(paintStatus, 1000);
      paintStatus();
    } else {
      if (offStatus) offStatus(); offStatus = null;
      clearInterval(timer); timer = null;
      status.hidden = true; status.textContent = '';
    }
  }

  function clearOutput() { disposeOutputs(outs); outs.textContent = ''; el.classList.remove('has-out'); }
  function showResult(result) {
    clearOutput();
    if (!result) return;
    if (result.inLine != null) label.textContent = `In[${result.inLine}]:=`;
    renderItems(outs, result.items || [], { labels: true });
    el.classList.toggle('has-out', outs.childElementCount > 0);
  }

  function run() {
    if (running) return running;
    if (editor.ghost.active() && !editor.ghost.complete()) {   // ghost cells only evaluate once fully typed
      editor.ghost.shake(); say('Escribe la línea completa');
      return Promise.resolve({ items: [], inLine: null, lastLine: null, ms: 0, incomplete: true });
    }
    if (editor.ghost.active()) say('');
    const code = editor.ta.value;
    if (!code.trim()) return Promise.resolve({ items: [], inLine: null, lastLine: null, ms: 0 });
    const help = /^\s*\?\s*([A-Za-z$][\w$]*)\s*$/.exec(code);
    if (help) { showHelp(help[1]); return Promise.resolve({ items: [], inLine: null, lastLine: null, ms: 0 }); }
    setRunning(true);
    running = kernel.run(code).then((result) => {
      if (destroyed) return result;
      showResult(result);
      return result;
    }, (err) => {
      const aborted = err && err.name === 'AbortError';
      const result = {
        items: [aborted
          ? { kind: 'message', symbol: '', tag: '', text: '$Aborted — evaluación detenida. El kernel se ha reiniciado: vuelve a evaluar las celdas con tus definiciones.' }
          : { kind: 'message', symbol: 'Kernel', tag: 'error', text: String((err && err.message) || err) }],
        inLine: null, lastLine: null, ms: 0, error: true, aborted,
      };
      if (!destroyed) showResult(result);
      return result;
    }).then((result) => {
      running = null;
      if (!destroyed) setRunning(false);
      if (!destroyed && opts.onResult) { try { opts.onResult(code, result); } catch (e) { console.error('[notebook] onResult', e); } }
      return result;
    });
    return running;
  }

  const api = {
    el, run,
    getCode: () => editor.ta.value,
    setCode: (c) => { editor.ta.value = String(c ?? ''); editor.refresh(); },
    isComplete: () => (editor.ghost.active() ? editor.ghost.complete() : true),
    setGhost: (g) => { editor.ghost.set(g); el.classList.toggle('wl-cell--ghost', g != null); el.classList.remove('is-ghost-complete'); say(''); },
    focus: () => { editor.ta.focus({ preventScroll: false }); },
    clearOutput, showResult,
    resetLabel: () => { label.textContent = 'In[ ]:='; },
    destroy: () => { destroyed = true; setRunning(false); clearOutput(); editor.destroy(); el.remove(); },
  };
  if (opts.autorun) Promise.resolve().then(() => { if (!destroyed) run(); });
  return api;
}

// ------------------------------------------------------------------------------------------------ notebook
const STATUS_WORD = { idle: 'kernel en reposo', loading: 'cargando', ready: 'listo', busy: 'calculando', error: 'error' };

export function createNotebook(container, opts = {}) {
  const compact = !!opts.compact;
  const cells = []; // {cell, slot}
  const list = h('div', { class: 'wl-nb-cells' });
  const root = h('div', { class: 'wl-nb' + (compact ? ' wl-nb--compact' : '') });
  let offStatus = null;
  const changed = () => { if (opts.onChange) { try { opts.onChange(api.getCells()); } catch (e) { console.error(e); } } };

  if (!compact) {
    const dot = h('span', { class: 'wl-dot' });
    const word = h('span', { class: 'wl-pill-word' });
    const pill = h('span', { class: 'wl-pill', role: 'status' }, dot, word);
    const bar = h('div', { class: 'wl-bar wl-nb-bar-progress', hidden: true }, h('i'));
    const evalAll = h('button', { class: 'wl-tbtn', type: 'button', text: 'Evaluar todo', onclick: () => { api.evaluateAll(); } });
    const restart = h('button', { class: 'wl-tbtn', type: 'button', text: 'Reiniciar kernel' });
    restart.addEventListener('click', () => {
      for (const c of cells) c.cell.resetLabel();
      kernel.abort().catch(() => {});
    });
    const paint = (s, p) => {
      pill.className = 'wl-pill is-' + s;
      word.textContent = s === 'loading' ? `${(p && p.phase) || 'cargando…'} ${Math.round(((p && p.pct) || 0) * 100)} %` : s === 'error' ? ((p && p.phase) || 'error') : STATUS_WORD[s] || s;
      bar.hidden = s !== 'loading';
      bar.firstChild.style.width = Math.round(((p && p.pct) || 0) * 100) + '%';
      restart.textContent = s === 'busy' ? 'Abortar' : s === 'idle' ? 'Arrancar kernel' : 'Reiniciar kernel';
      restart.title = s === 'busy' ? 'Detiene el cálculo en curso reiniciando el kernel' : 'Borra todas las definiciones y arranca un kernel limpio';
    };
    offStatus = kernel.onStatus(paint);
    paint(kernel.status, kernel.progress);
    root.append(h('div', { class: 'wl-nb-bar' }, opts.title ? h('div', { class: 'wl-nb-title', text: opts.title }) : null, pill, h('div', { class: 'wl-nb-actions' }, evalAll, restart)), bar);
  }
  root.append(list);
  const tail = h('button', { class: 'wl-add wl-add--tail', type: 'button', title: 'Añadir una celda al final', text: '+ celda', onclick: () => { api.addCell('').focus(); } });
  if (!compact) root.append(tail);
  if (container) container.append(root);

  function insert(code, note, index) {
    const slot = h('div', { class: 'wl-nb-slot' });
    const rec = { cell: null, slot };
    if (!compact) {
      slot.append(h('button', { class: 'wl-add wl-add--between', type: 'button', title: 'Insertar una celda aquí', 'aria-label': 'Insertar celda', text: '+', onclick: () => { insert('', null, cells.indexOf(rec)).cell.focus(); changed(); } }));
    }
    if (note) slot.append(h('div', { class: 'wl-nb-note', text: note }));
    rec.cell = createCell(slot, { code, onResult: opts.onResult, onInput: changed });
    if (!compact) {
      rec.cell.el.querySelector('.wl-tools').append(h('button', { class: 'wl-del', type: 'button', title: 'Eliminar celda', 'aria-label': 'Eliminar celda', text: '×', onclick: () => {
        const i = cells.indexOf(rec);
        if (i < 0) return;
        cells.splice(i, 1); rec.cell.destroy(); slot.remove(); changed();
        if (!cells.length) insert('', null, 0);
      } }));
    }
    if (index == null || index >= cells.length) { list.append(slot); cells.push(rec); } else { list.insertBefore(slot, cells[index].slot); cells.splice(index, 0, rec); }
    return rec;
  }

  const api = {
    el: root,
    addCell(code) { const rec = insert(String(code ?? ''), null, null); changed(); return rec.cell; },
    getCells: () => cells.map((c) => c.cell.getCode()),
    async evaluateAll() {
      const results = [];
      for (const c of [...cells]) {
        if (!c.cell.getCode().trim()) continue;
        const r = await c.cell.run();
        results.push(r);
        if (r && r.aborted) break;
      }
      return results;
    },
    focus() { if (cells[0]) cells[0].cell.focus(); },
    destroy() { if (offStatus) offStatus(); for (const c of cells) c.cell.destroy(); cells.length = 0; root.remove(); },
  };
  const initial = opts.cells && opts.cells.length ? opts.cells : [{ code: '' }];
  for (const c of initial) insert(typeof c === 'string' ? c : (c.code || ''), typeof c === 'string' ? null : c.note, null);
  return api;
}
