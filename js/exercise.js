// exercise.js (LEARN) — the exercise widget used by lessons, practice sessions and command pages.
//   mountExercise(container, ex, {onDone(result), mode:'lesson'|'practice'|'exam', seed?, year?, lesson?, noTitle?})
//   → {destroy(), el, focus(), check()}
// SPEC §11 (typing-only): the student always types the whole code. An exercise is an EMPTY cell + "Comprobar";
// the old test-like kinds are converted at runtime (predict → ghost cell to type; fill/order → code exercise with the
// template / shuffled lines shown read-only; fix → broken code read-only; mcq → a note). "Ver solución" is a ghost to type.
//   mountGhost(host, code, {onDone, before, evaluate}) — a cell that must be typed character by character.
// Also exports the small UI helpers shared by the LEARN views (md, h, esc, badges, rng, kernel pill…).
import { kernel } from './kernel-client.js?v=1794354103';
import { createCell } from './notebook.js?v=1794354103';
import { store } from './store.js?v=1794354103';
import * as fx from './fx.js?v=1794354103';

const { sfx, xpFloat } = fx;

/* ============================================================ helpers (shared with the LEARN views) */
export function ensureCss() {
  if (document.querySelector('link[data-learn-css]')) return;
  const href = new URL('../css/learn.css', import.meta.url).href;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (l.href === href || /css\/learn\.css(\?|$)/.test(l.getAttribute('href') || '')) { l.dataset.learnCss = '1'; return; }
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href; link.dataset.learnCss = '1';
  document.head.appendChild(link);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** h('div', {class, html, text, dataset, style:{}, onclick}, ...children) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

/** Inline light markdown → safe HTML: `code`, **bold**, *italic*. */
export function mdInline(src) {
  const parts = String(src ?? '').split('`');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    // an unpaired trailing backtick is literal text
    if (i % 2 === 1 && i < parts.length - 1) { out += `<code>${esc(parts[i])}</code>`; continue; }
    const txt = (i % 2 === 1 ? '`' : '') + parts[i];
    out += esc(txt)
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(¿¡])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  }
  return out;
}

/** Light markdown of the SPEC (paragraphs, "- " lists, "1. " lists, ``` blocks) → safe HTML. */
export function md(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [], list = null, pre = null;
  const flushP = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.tag}>${list.items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    if (pre) {
      if (/^\s*```/.test(raw)) { out.push(`<pre class="lx-code">${hl(pre.join('\n'))}</pre>`); pre = null; } else pre.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { flushP(); flushL(); pre = []; continue; }
    if (!raw.trim()) { flushP(); flushL(); continue; }
    let m;
    if ((m = raw.match(/^\s*[-•]\s+(.*)$/))) {
      flushP();
      if (!list || list.tag !== 'ul') { flushL(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
    } else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushP();
      if (!list || list.tag !== 'ol') { flushL(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ' ' + raw.trim();
    } else { flushL(); para.push(raw.trim()); }
  }
  if (pre) out.push(`<pre class="lx-code">${hl(pre.join('\n'))}</pre>`);
  flushP(); flushL();
  return out.join('');
}

/**
 * SPEC §14 (minimum text): the visible line of a screen and what is left for «Más detalle».
 * Takes whole sentences of the first paragraph while they fit in `limit` (always at least the first one).
 */
export function splitText(src, limit = 90) {
  const text = String(src ?? '').replace(/\r/g, '').trim();
  if (!text) return { line: '', rest: '' };
  const multi = /\n\s*\n|^\s*([-•]|\d+[.)])\s/m.test(text);
  if (text.length <= limit && !multi) return { line: text.replace(/\s+/g, ' '), rest: '' };
  const para = text.split(/\n\s*\n|\n(?=\s*([-•]|\d+[.)])\s)/)[0];
  const ends = [];
  let inCode = false;
  for (let i = 0; i < para.length; i++) {
    const c = para[i];
    if (c === '`') inCode = !inCode;
    else if (!inCode && /[.!?]/.test(c) && (i === para.length - 1 || /\s/.test(para[i + 1])) && i >= 10) ends.push(i + 1);
  }
  if (!ends.length || ends[ends.length - 1] !== para.length) ends.push(para.length);
  let end = ends[0];
  for (const e of ends) { if (e <= limit) end = e; else break; }
  let line = para.slice(0, end).replace(/\s+/g, ' ').trim();
  let rest = (para.slice(end) + text.slice(para.length)).trim();
  if (line.length > limit * 1.8) {
    // a single endless sentence: cut at a word boundary (outside `code`) and keep the full text as detail
    let cut = line.lastIndexOf(' ', Math.round(limit * 1.3));
    while (cut > 20 && (line.slice(0, cut).split('`').length - 1) % 2 === 1) cut = line.lastIndexOf(' ', cut - 1);
    if (cut > 20) { line = line.slice(0, cut).replace(/[,;:]$/, '') + '…'; rest = text; }
  }
  return { line, rest };
}
/** Discreet closed disclosures under the cell: «Pista» (brief) and «Más detalle». Returns null when there is nothing to show. */
export function moreBox({ hint, more, moreLabel = 'Más detalle', hintLabel = 'Pista' } = {}) {
  const items = [];
  const mk = (label, text) => h('details', { class: 'lx-more-d' }, h('summary', null, label), h('div', { class: 'lx-md lx-more-b', html: md(text) }));
  if (hint && String(hint).trim()) items.push(mk(hintLabel, hint));
  if (more && String(more).trim()) items.push(mk(moreLabel, more));
  return items.length ? h('div', { class: 'lx-more' }, items) : null;
}

/** Minimal Wolfram Language highlighter (safe HTML). Uses fx.hlWL when the shell provides it. */
export function hl(code) {
  if (typeof fx.hlWL === 'function') { try { return fx.hlWL(code); } catch { /* fall through */ } }
  return esc(code);
}
export function codeBlock(code, cls = '') { return h('pre', { class: `lx-code ${cls}`.trim(), html: hl(code) }); }

export function icon(name, size = 18) {
  if (typeof fx.icon === 'function') { try { return fx.icon(name, size); } catch { /* ignore */ } }
  return '';
}

export function yearOf(obj) {
  if (obj && (obj.year === 1 || obj.year === 2)) return obj.year;
  const m = /^([12])-/.exec((obj && obj.id) || '');
  return m ? +m[1] : 0;
}
export function yearBadge(year, text) {
  const y = Number(year);
  if (y !== 1 && y !== 2) return h('span', { class: 'badge muted' }, text || 'Base');
  return h('span', { class: `badge y${y}`, title: `${y}º curso` }, text || `${y}º`);
}
export function diffDots(d) {
  const n = Math.max(1, Math.min(5, Math.round(d || 1)));
  const el = h('span', { class: 'lx-diff', title: `Dificultad ${n} de 5`, 'aria-label': `Dificultad ${n} de 5` });
  for (let i = 1; i <= 5; i++) el.appendChild(h('i', { class: i <= n ? 'on' : '' }));
  return el;
}
export function cmdChip(name) {
  const lv = safe(() => store.cmdLevel(name), 0) || 0;
  const names = ['por aprender', 'visto', 'en práctica', 'dominado'];
  return h('a', { class: `chip l${lv}`, href: `#/comandos/${encodeURIComponent(name)}`, title: `${name} · ${names[lv]} — ver ficha`, dataset: { cmd: name } }, name);
}
export function safe(fn, dflt) { try { return fn(); } catch (e) { console.warn('[learn]', e); return dflt; } }
export function play(name, opts) { safe(() => sfx.play(name, opts)); }
export function levelOf(xp) { return Math.floor(Math.sqrt(Math.max(0, xp || 0) / 50)) + 1; }

/* ---- seeded random ---- */
export function hashStr(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}
export function rng(seed) {
  let a = (typeof seed === 'string' ? hashStr(seed) : (seed >>> 0)) || 0x9e3779b9;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function newSeed() { return (Math.random() * 0xffffffff) >>> 0; }

/** Picks the random `params` (seeded) and substitutes {{name}} in every string field. Returns a deep copy. */
export function instantiate(ex, seed) {
  if (!ex || !ex.params || typeof ex.params !== 'object') return ex;
  const rnd = rng((seed ?? newSeed()) ^ hashStr(ex.id || ''));
  const vals = {};
  for (const [name, spec] of Object.entries(ex.params)) {
    let v;
    if (Array.isArray(spec)) v = spec[Math.floor(rnd() * spec.length)];
    else if (spec && Array.isArray(spec.int)) { const [lo, hi] = spec.int; v = lo + Math.floor(rnd() * (hi - lo + 1)); }
    else if (spec && Array.isArray(spec.range)) { const [lo, hi, st = 1] = spec.range; v = lo + st * Math.floor(rnd() * (Math.floor((hi - lo) / st) + 1)); }
    else if (spec && Array.isArray(spec.float)) { const [lo, hi, dec = 1] = spec.float; v = +(lo + rnd() * (hi - lo)).toFixed(dec); }
    else if (spec && Array.isArray(spec.choices)) v = spec.choices[Math.floor(rnd() * spec.choices.length)];
    else v = spec;
    vals[name] = v;
  }
  const sub = (s) => s.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g, (m, n) => (n in vals ? String(vals[n]) : m));
  const deep = (o) => (typeof o === 'string' ? sub(o) : Array.isArray(o) ? o.map(deep) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v)])) : o);
  const out = deep({ ...ex, params: undefined });
  out.params = ex.params;
  out._vals = vals;
  return out;
}

/* ---- kernel helpers ---- */
let chain = Promise.resolve();
/** Runs fn with exclusive use of the kernel among LEARN widgets (reset → setup → check sequences never interleave). */
export function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
export function kernelReady() { return kernel.status === 'ready' || kernel.status === 'busy'; }
export function startKernel() { return safe(() => Promise.resolve(kernel.start()).catch(() => {}), Promise.resolve()); }
/** cb(status, progress) now and on every change. Returns unsubscribe. */
export function watchKernel(cb) {
  const call = (s, p) => safe(() => cb(s || kernel.status, p || kernel.progress || { phase: '', pct: 0 }));
  const off = safe(() => kernel.onStatus((s, p) => call(s, p)), null);
  call(kernel.status, kernel.progress);
  return typeof off === 'function' ? off : () => {};
}
/** Small status pill: hidden when ready, progress while loading, retry on error. */
export function kernelPill({ always = false } = {}) {
  const el = h('span', { class: 'lx-kpill', role: 'status' });
  const off = watchKernel((status, prog) => {
    el.dataset.status = status;
    if (status === 'loading') {
      const pct = Math.round(100 * Math.max(0, Math.min(1, (prog && prog.pct) || 0)));
      el.innerHTML = `<i class="lx-spin"></i><span>Cargando Mathematica… ${pct}%</span><b style="width:${pct}%"></b>`;
      el.title = (prog && prog.phase) || '';
      el.hidden = false;
    } else if (status === 'error') {
      el.innerHTML = '<span>No se pudo cargar el motor</span>';
      const b = h('button', { class: 'lx-link', type: 'button', onclick: () => { safe(() => (kernel.abort ? kernel.abort() : kernel.start())); startKernel(); } }, 'Reintentar');
      el.appendChild(b);
      el.hidden = false;
    } else if (status === 'idle') {
      el.innerHTML = '<span>Motor en espera</span>'; el.hidden = !always;
    } else {
      el.innerHTML = `<i class="lx-dot"></i><span>${status === 'busy' ? 'Calculando…' : 'Motor listo'}</span>`;
      el.hidden = !always;
    }
  });
  return { el, destroy: off };
}

/* ---- per-exercise status from the store ---- */
export function exStatus(id) {
  const r = safe(() => store.exercise(id), null);
  if (!r) return 'todo';
  if (r.review) return 'review';
  if (r.ok) return 'ok';
  return r.tries ? 'tried' : 'todo';
}
export function setReview(id, flag) {
  const r = safe(() => store.exercise(id), null);
  if (!flag && !(r && r.review)) return;
  safe(() => store.set(`ex.${id}.review`, !!flag));
}

/* ---- XP ---- */
// SPEC §13: gentle tone — hints and failed tries never cost anything; a clean first try gets a small bonus.
export function xpFor(ex, { fails = 0, hints = 0 } = {}) {
  const base = 10 * Math.max(1, Math.min(5, Math.round(ex.difficulty || 1)));
  return base + (fails === 0 && hints === 0 ? 5 : 0);
}

/* ---- combo: consecutive first-try successes (per page session) ---- */
let combo = 0;
export function getCombo() { return combo; }

/* ---- typical-mistake detector (client side, complements the kernel's feedback) ---- */
const LOWER_FUNCS = ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'plot', 'solve', 'integrate', 'limit', 'simplify', 'expand', 'factor', 'det', 'inverse', 'table', 'sum', 'dsolve', 'nsolve', 'abs', 'pi', 'plot3d', 'series', 'eigenvalues', 'transpose', 'show', 'manipulate', 'print', 'length', 'ndsolve', 'findroot', 'nintegrate'];
const PROPER = { sin: 'Sin', cos: 'Cos', tan: 'Tan', exp: 'Exp', log: 'Log', sqrt: 'Sqrt', plot: 'Plot', solve: 'Solve', integrate: 'Integrate', limit: 'Limit', simplify: 'Simplify', expand: 'Expand', factor: 'Factor', det: 'Det', inverse: 'Inverse', table: 'Table', sum: 'Sum', dsolve: 'DSolve', nsolve: 'NSolve', abs: 'Abs', pi: 'Pi', plot3d: 'Plot3D', series: 'Series', eigenvalues: 'Eigenvalues', transpose: 'Transpose', show: 'Show', manipulate: 'Manipulate', print: 'Print', length: 'Length', ndsolve: 'NDSolve', findroot: 'FindRoot', nintegrate: 'NIntegrate' };
export function diagnose(code, ex) {
  const tips = [];
  const src = String(code || '').replace(/\(\*[\s\S]*?\*\)/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const defined = new Set([...src.matchAll(/([a-z][A-Za-z0-9]*)\s*(?:\[[^\]]*_[^\]]*\]\s*:?=|=(?!=))/g)].map((m) => m[1]));
  const setupDefs = new Set([...String((ex && ex.setup) || '').matchAll(/([A-Za-z][A-Za-z0-9]*)\s*(?:\[[^\]]*\]\s*)?:?=/g)].map((m) => m[1]));
  for (const m of src.matchAll(/(?<![A-Za-z0-9$`])([a-z][a-z0-9]*)\s*([[(])/g)) {
    const w = m[1];
    if (LOWER_FUNCS.includes(w) && !defined.has(w) && !setupDefs.has(w)) { tips.push(`Los comandos de Mathematica empiezan por **mayúscula**: \`${PROPER[w]}\`, no \`${w}\`.`); break; }
  }
  if (!tips.length && /(?<![A-Za-z0-9$`])pi(?![A-Za-z0-9])/.test(src) && !defined.has('pi')) tips.push('El número π se escribe `Pi` (con mayúscula).');
  const par = /(?<![A-Za-z0-9$`])([A-Z][A-Za-z0-9]*)\(/.exec(src);
  if (par && !['N', 'I', 'E', 'C', 'D'].includes(par[1])) tips.push(`Los argumentos de una función van entre **corchetes**: \`${par[1]}[…]\`, no \`${par[1]}(…)\`.`);
  else if (/(?<![A-Za-z0-9$`])(sin|cos|tan|exp|log|sqrt)\(/.test(src)) tips.push('Los argumentos van entre **corchetes**: `Sin[x]`, no `sin(x)`.');
  const cnt = (re) => (src.match(re) || []).length;
  const pairs = [['[', ']', /\[/g, /\]/g], ['{', '}', /\{/g, /\}/g], ['(', ')', /\(/g, /\)/g]];
  for (const [a, b, ra, rb] of pairs) {
    const na = cnt(ra), nb = cnt(rb);
    if (na !== nb) { tips.push(`Revisa los símbolos de cierre: hay ${na} \`${a}\` y ${nb} \`${b}\`.`); break; }
  }
  const eqm = /(?<![A-Za-z0-9$`])(Solve|NSolve|DSolve|NDSolve|Reduce|FindRoot)\[([^\]]*)/.exec(src);
  if (eqm && /(?<![=!<>:])=(?!=)/.test(eqm[2]) && !/==/.test(eqm[2])) tips.push(`Dentro de \`${eqm[1]}\` una ecuación se escribe con **doble igual** \`==\`; un solo \`=\` asigna un valor.`);
  if (/\b[A-Za-z]\w*\[[a-z]\]\s*:=/.test(src) && !/_/.test(src)) tips.push('Al definir una función, la variable lleva guion bajo: `f[x_] := …`.');
  return tips.slice(0, 2);
}

const KIND_LABEL = { recall: 'De memoria', code: 'Escribe el código', fix: 'Corrige y reescribe', fill: 'Escribe la línea completa', order: 'Escribe las líneas en orden', predict: 'Teclea y observa', mcq: 'Nota' };
const OK_MSGS = ['Correcto.', 'Bien hecho.', 'Eso es.', 'Perfecto.', 'Exacto.'];
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/* ============================================================ ghost cells (SPEC §11: everything is typed) */
/** Does notebook.js implement ghost mode (opts.ghost / cell.isComplete)? If not, a gray reference line is shown above an empty cell. */
export function ghostSupported(cell) { return !!cell && typeof cell.isComplete === 'function'; }

/**
 * A cell whose code the student must type character by character.
 *   mountGhost(host, code, { onDone(result), onTyped(), before(): Promise, evaluate(code): Promise<result>, run?: false })
 * `run: false` = the piece is only typed (done as soon as it is complete), never evaluated.
 * `before` runs (inside the kernel lock) right before each evaluation; `evaluate` replaces the plain cell.run().
 * → { cell, el, isDone(), isTyped(), run(), focus(), destroy() }
 */
export function mountGhost(host, code, opts = {}) {
  ensureCss();
  const wrap = h('div', { class: 'lx-ghost' });
  host.appendChild(wrap);
  const msg = h('div', { class: 'lx-ghost-msg', hidden: true, 'aria-live': 'polite' });
  let done = false, destroyed = false, busy = false, cell = null, refEl = null;
  const finish = (result) => {
    if (done || destroyed) return;
    done = true; wrap.classList.add('is-done');
    safe(() => opts.onDone && opts.onDone(result));
  };
  const typed = () => { wrap.classList.add('is-typed'); msg.hidden = true; safe(() => opts.onTyped && opts.onTyped()); if (opts.run === false) finish(null); };
  try {
    cell = createCell(wrap, {
      ghost: code, placeholder: '',
      onProgress: (p) => safe(() => opts.onProgress && opts.onProgress(p)),
      onComplete: typed,
      onResult: (c, result) => { if (!opts.evaluate && matches()) finish(result); },
    });
  } catch (e) { console.error('[learn] createCell', e); wrap.appendChild(codeBlock(code)); }
  const native = ghostSupported(cell);
  const matches = () => (!cell ? false : native ? !!cell.isComplete() : squash(cell.getCode()) === squash(code));
  if (cell && !native) {
    // fallback while notebook.js has no ghost mode: the reference goes in gray right above, and darkens as it is typed
    wrap.classList.add('lx-ghost--ref');
    refEl = h('pre', { class: 'lx-ghostref', title: 'Teclea esta línea en la celda de abajo' });
    const paint = () => {
      const t = squash(cell.getCode()); let i = 0, k = 0;
      while (k < code.length && i < t.length) { if (/\s/.test(code[k])) { k++; continue; } if (code[k] !== t[i]) break; i++; k++; }
      refEl.replaceChildren(h('span', { class: 'is-typed' }, code.slice(0, k)), h('span', null, code.slice(k)));
      if (squash(code) === t && !wrap.classList.contains('is-typed')) typed();
      else if (squash(code) !== t) wrap.classList.remove('is-typed');
    };
    paint();
    wrap.insertBefore(refEl, wrap.firstChild);
    wrap.addEventListener('input', paint, true);
    wrap.addEventListener('paste', (e) => e.preventDefault(), true);
    wrap.addEventListener('drop', (e) => e.preventDefault(), true);
  }
  wrap.appendChild(msg);
  const run = () => {
    if (busy || destroyed || !cell) return Promise.resolve(null);
    if (!matches()) {
      msg.hidden = false;
      msg.textContent = 'Todavía no está completa: teclea la línea tal como aparece en gris.';
      wrap.classList.remove('lx-nudge'); void wrap.offsetWidth; wrap.classList.add('lx-nudge');
      return Promise.resolve(null);
    }
    msg.hidden = true;
    if (opts.run === false) { finish(null); return Promise.resolve(null); } // a piece that is only typed, not evaluated
    busy = true; wrap.classList.add('is-busy');
    return exclusive(async () => {
      if (destroyed) return null;
      if (opts.before) await opts.before();
      if (opts.evaluate) {
        const result = await opts.evaluate(cell.getCode());
        if (!destroyed && result) { safe(() => cell.showResult(result)); finish(result); }
        return result;
      }
      return cell.run();
    }).catch((e) => { console.warn('[learn] ghost run', e); return null; }).finally(() => { busy = false; wrap.classList.remove('is-busy'); });
  };
  // every evaluation request goes through run(): completeness check + kernel priming
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); run(); } }, true);
  wrap.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('.wl-run')) { e.preventDefault(); e.stopPropagation(); run(); } }, true);
  return {
    cell, el: wrap, run,
    isDone: () => done,
    isTyped: matches,
    focus: () => cell && safe(() => cell.focus()),
    destroy() { destroyed = true; if (cell && cell.destroy) safe(() => cell.destroy()); wrap.remove(); },
  };
}

/* ============================================================ runtime conversion of the old test-like kinds */
/** What the student sees for each kind (SPEC §11): 'code' (empty cell + check), 'ghost' (type & observe) or 'note'. */
export function exerciseMode(ex) {
  const k = ex && ex.kind;
  if (k === 'predict') return ex.code ? 'ghost' : 'note';
  if (k === 'mcq') return 'note';
  return 'code';
}
/** Is it a real exercise (something to solve and check)? Notes and type-and-observe steps are not. */
export function isPractice(ex) { return exerciseMode(ex) === 'code'; }

function fillBlanks(ex) { return (ex.blanks || []).map((b) => (Array.isArray(b) ? b : [b])); }
function fillWith(ex, vals) { return String(ex.template || '').replace(/__(\d+)__/g, (m, n) => vals[+n - 1] ?? ''); }
export function solutionOf(ex) {
  if (ex.kind === 'order') return (ex.lines || []).join('\n');
  if (ex.kind === 'fill') return ex.solution || fillWith(ex, fillBlanks(ex).map((b) => b[0]));
  if (ex.kind === 'predict') return ex.code || '';
  return ex.solution || '';
}
/** Accepts a typed answer without the kernel (only for fill/order exercises that have no `check`). */
function localAccept(ex, code) {
  const t = squash(code);
  if (ex.kind === 'order') return t === squash((ex.lines || []).join('\n'));
  if (ex.kind === 'fill') {
    const blanks = fillBlanks(ex);
    let combos = [[]];
    for (const alts of blanks) { const next = []; for (const c of combos) for (const a of alts) { if (next.length < 256) next.push([...c, a]); } combos = next; }
    return combos.some((vals) => squash(fillWith(ex, vals)) === t) || (!!ex.solution && squash(ex.solution) === t);
  }
  return t === squash(ex.solution || '');
}

/** Shape of a line: only the command, its brackets, braces and commas — `Plot[ , { , , }]` (SPEC §13 second hint). */
export function skeletonOf(code) {
  const out = [];
  for (const line of String(code || '').split('\n')) {
    let depth = 0, res = '', i = 0, inStr = false;
    const brace = []; // depth at which each open brace sits
    while (i < line.length) {
      const c = line[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; i++; continue; }
      if (c === '"') { inStr = true; i++; res += ' '; continue; }
      const id = /^[A-Za-z$][A-Za-z0-9$]*/.exec(line.slice(i));
      if (id) { const j = i + id[0].length; if (depth === 0 && line[j] === '[') res += id[0]; else res += ' '; i = j; continue; }
      if (c === '[') { if (depth === 0) res += '['; depth++; i++; continue; }
      if (c === ']') { depth--; if (depth === 0) res += ']'; i++; continue; }
      if (c === '{') { if (depth <= 1) { res += '{'; brace.push(depth); } depth++; i++; continue; }
      if (c === '}') { depth--; if (brace.length && brace[brace.length - 1] === depth) { brace.pop(); res += '}'; } i++; continue; }
      if (c === ',') { if (depth === 1 || (depth === 2 && brace.length) || (depth === 1 && brace.length)) res += ', '; i++; continue; }
      if (depth === 0) {
        const op = /^(:=|==|=|\/\.|\/\/|->|;)/.exec(line.slice(i));
        if (op) { res += ` ${op[0]} `; i += op[0].length; continue; }
      }
      res += ' '; i++;
    }
    out.push(res.replace(/\s+/g, ' ').replace(/\[\s+\]/g, '[ ]').replace(/\{\s+\}/g, '{ }').trim());
  }
  return out.join('\n');
}

/* ---- build steps: "write it from memory" as an exercise, and the review queue (SPEC §13) ---- */
const PLOT3D = /^\s*[A-Za-z]*3D\[/, PLOT2D = /^\s*(Plot|ListPlot|ListLinePlot|ParametricPlot|PolarPlot|ContourPlot|DensityPlot|StreamPlot|VectorPlot|RegionPlot|LogPlot|LogLogPlot|Graphics|Show|BarChart|Histogram|DiscretePlot)\[/;
/** The recall of a `build` step as a code exercise (id "<lessonId>-b<stepIndex>"). */
export function recallExercise(lesson, i) {
  const st = lesson && lesson.steps && lesson.steps[i];
  if (!st || st.type !== 'build' || !st.target) return null;
  const rc = st.recall || {};
  const target = String(st.target);
  let check = rc.check;
  if (!check) check = PLOT3D.test(target) ? { type: 'graphics', dim: 3, like: target } : PLOT2D.test(target) ? { type: 'graphics', dim: 2, like: target } : { type: 'expr', expected: target };
  return {
    id: `${lesson.id}-b${i}`, kind: 'code', recall: true, lessonId: lesson.id, step: i,
    title: st.title || 'De memoria', prompt: rc.prompt || `Escribe de memoria: ${st.title || ''}`,
    difficulty: 2, cmds: st.cmds || [], setup: st.setup || undefined,
    solution: rc.solution || target, check, hints: rc.hints || [], explain: rc.explain || '',
    params: st.params,
  };
}
const REVIEW_DAYS = [1, 3, 7, 16, 35, 90];
const reviewKey = (lessonId, step) => `${lessonId}~${step}`;
export function reviewState() { return safe(() => store.state.review, null) || {}; }
/** Records the outcome of a recall. revealed (typed over the full ghost) → comes back soon; clean → longer interval. */
export function reviewRecord(lessonId, step, { revealed = false, hints = 0 } = {}) {
  const key = reviewKey(lessonId, step);
  const prev = reviewState()[key] || { n: 0 };
  const now = Date.now();
  let n = prev.n || 0, due;
  if (revealed) { n = 0; due = now + 10 * 60000; }
  else if (!prev.t) { due = now + 10 * 60000; }                      // first time (end of the build): due for the next session
  else { if (!hints) n = Math.min(REVIEW_DAYS.length - 1, n + 1); due = now + REVIEW_DAYS[Math.max(0, n - 1)] * 86400000 * (hints ? 0.5 : 1); }
  safe(() => store.set(`review.${key}`, { n, t: now, due }));
}
/** Targets whose review is due (oldest first): [{lessonId, step, due}] */
export function reviewDue(now = Date.now()) {
  return Object.entries(reviewState()).map(([key, v]) => { const k = key.lastIndexOf('~'); return { lessonId: key.slice(0, k), step: +key.slice(k + 1), due: (v && v.due) || 0, n: (v && v.n) || 0 }; })
    .filter((r) => r.lessonId && Number.isFinite(r.step) && r.due <= now).sort((a, b) => a.due - b.due);
}

/* ============================================================ the widget */
export function mountExercise(container, exRaw, opts = {}) {
  ensureCss();
  const mode = opts.mode || 'lesson';
  const isExam = mode === 'exam';
  let seed = opts.seed ?? newSeed();
  let destroyed = false;
  let cleanup = [];
  const root = h('article', { class: 'ex' });
  container.appendChild(root);
  let api = null;

  build();

  function build() {
    cleanup.forEach((f) => safe(f)); cleanup = [];
    root.innerHTML = '';
    const ex = instantiate(exRaw, seed);
    const kind = ex.kind;
    const view = exerciseMode(ex);
    const rnd = rng(seed ^ 0x5bd1e995);
    const yr = opts.year || yearOf(opts.lesson) || yearOf(ex);
    const prior = exStatus(ex.id);
    const st = { fails: 0, hints: 0, done: false, revealed: false, busy: false, t0: Date.now(), reported: false, shape: false };
    const gentle = !!(opts.recall || ex.recall); // recall from memory: hints always available, nothing is penalised

    root.className = `ex ex--${kind} ex--v-${view}${ex.real ? ' ex--real' : ''} ex--${mode}`;
    root.dataset.state = 'idle';
    root.dataset.exId = ex.id || '';
    if (yr) root.dataset.year = yr;

    /* ---------- header: one discreet meta line + title + prompt ---------- */
    const xpChip = h('span', { class: 'ex-xp', title: 'XP que ganarás si lo resuelves ahora' });
    const statusBadge = h('span', { class: 'ex-prior' });
    const setPrior = (s) => {
      statusBadge.className = 'ex-prior';
      if (s === 'ok') { statusBadge.className = 'ex-prior badge ok'; statusBadge.textContent = 'resuelto'; }
      else if (s === 'review') { statusBadge.className = 'ex-prior badge real'; statusBadge.textContent = 'repetir'; statusBadge.title = 'Viste la solución: resuélvelo tú para dominarlo'; }
      else statusBadge.textContent = '';
    };
    setPrior(view === 'code' ? prior : 'todo');
    const updXp = () => {
      if (isExam || view !== 'code') { xpChip.hidden = true; return; }
      const already = safe(() => store.exercise(ex.id), null);
      if (already && already.ok) { xpChip.textContent = 'repaso'; xpChip.classList.add('is-zero'); return; }
      xpChip.textContent = `+${gentle ? 15 : xpFor(ex, st)} XP`;
    };
    updXp();
    const badges = h('div', { class: 'ex-badges' },
      yearBadge(yr),
      h('span', { class: 'ex-kind' }, KIND_LABEL[gentle ? 'recall' : kind] || kind),
      view === 'code' ? diffDots(ex.difficulty) : null,
      ex.real ? h('span', { class: 'badge real', title: 'Ejercicio real de práctica o examen' }, ex.source ? `Real · ${ex.source}` : 'Real') : null,
      statusBadge,
      h('span', { class: 'ex-spacer' }),
      xpChip);
    const cmds = h('div', { class: 'ex-cmds' }, (ex.cmds || []).map(cmdChip));
    // SPEC §14: the statement is the headline; the title (if it says something) is a small gray label, the meta goes to the foot
    const generic = !ex.title || /^(ejercicio|nota|teclea y observa|de memoria)\.?$/i.test(String(ex.title).trim());
    if (!opts.noTitle && !generic) root.appendChild(h('div', { class: 'ex-label' }, ex.title));
    const statement = (text, fallback) => h('div', { class: 'ex-prompt lx-statement lx-md', html: mdInline(String(text || '').trim() || fallback) });

    const body = h('div', { class: 'ex-body' });
    const actions = h('div', { class: 'ex-actions' });
    const hintsBox = h('div', { class: 'ex-hints' });
    const fb = h('div', { class: 'ex-feedback', 'aria-live': 'polite' });
    const foot = h('footer', { class: 'ex-foot' }, badges, cmds);

    function report(extra) {
      if (!isExam && st.reported) return;
      st.reported = true;
      const result = { id: ex.id, ok: false, revealed: false, firstTry: false, xp: 0, tries: st.fails + (extra.ok ? 1 : 0), fails: st.fails, hints: st.hints, ms: Date.now() - st.t0, cmds: ex.cmds || [], combo, ...extra };
      safe(() => opts.onDone && opts.onDone(result));
    }
    // clean session + hidden setup, so that what the student evaluates sees the exercise's data
    const prime = async () => { await kernel.reset(); if (ex.setup) await kernel.run(ex.setup); };
    function primeWhenReady() {
      const run = () => { if (destroyed || st.busy) return; exclusive(async () => { if (!destroyed) await prime(); }).catch(() => {}); };
      if (kernelReady()) run();
      else { let fired = false; const off = watchKernel((s) => { if (!fired && s === 'ready') { fired = true; setTimeout(() => { off(); run(); }, 0); } }); cleanup.push(off); }
      if (kernel.status === 'idle') startKernel();
    }
    const refBlock = (label, node, cls = '') => h('div', { class: `ex-ref ${cls}`.trim() }, h('div', { class: 'ex-ref-l' }, label), node);

    /* ============================ note (old mcq): nothing to choose, just the idea ============================ */
    if (view === 'note') {
      const pr = splitText(ex.prompt || '', 160);
      root.appendChild(statement(pr.line, ex.title || 'Una idea para recordar.'));
      const ans = Array.isArray(ex.options) && ex.options[ex.answer] != null ? String(ex.options[ex.answer]) : '';
      if (ans) body.appendChild(h('div', { class: 'ex-note-a lx-md', html: mdInline(/`/.test(ans) || kind !== 'predict' ? ans : '`' + ans + '`') }));
      const mb = moreBox({ hint: ex.hint, more: [pr.rest, ex.more, ex.explain].filter(Boolean).join('\n\n') });
      if (mb) body.appendChild(mb);
      root.append(body);
      if (foot) root.appendChild(foot);
      // a note is "done" by reading it: recorded without XP, combo or command mastery
      const rec = safe(() => store.exercise(ex.id), null);
      if (!isExam && !(rec && rec.ok)) safe(() => store.set(`ex.${ex.id}`, { ok: true, tries: 0, ts: Date.now(), note: true }));
      api = { check: () => {}, focus: () => {} };
      setTimeout(() => { if (!destroyed) report({ ok: true, note: true }); }, 0);
      return;
    }

    /* ============================ ghost (old predict): type the cell and watch what it returns ============================ */
    if (view === 'ghost') {
      root.appendChild(statement('Teclea la celda y mira qué devuelve.', ''));
      const host = h('div', { class: 'ex-cell' });
      const after = h('div', { class: 'ex-feedback' });
      body.append(host);
      root.append(body, after);
      if (foot) root.appendChild(foot);
      let primed = false;
      const g = mountGhost(host, ex.code, {
        before: async () => { if (!primed) { primed = true; await prime(); } },
        onDone: () => {
          st.done = true; root.dataset.state = 'ok';
          play('ok');
          const rec = safe(() => store.exercise(ex.id), null);
          let gained = 0;
          if (!isExam && !(rec && rec.ok)) { const r = safe(() => store.markExercise(ex.id, { ok: true, cmds: [], xp: 5 }), null); gained = r && r.xp ? r.xp : 0; }
          for (const c of ex.cmds || []) safe(() => store.markSeen(c));
          const ans = Array.isArray(ex.options) && ex.options[ex.answer] != null ? String(ex.options[ex.answer]) : '';
          const box = h('div', { class: 'ex-fb ex-fb--ok' }, h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '✓'), h('strong', null, ans ? 'Devuelve ' : 'Evaluada.'), ans ? h('code', null, ans) : null, gained ? h('span', { class: 'ex-gain' }, `+${gained} XP`) : null));
          after.replaceChildren(box);
          const mb = moreBox({ more: [ex.more, ex.explain].filter(Boolean).join('\n\n') });
          if (mb) after.appendChild(mb);
          if (gained) safe(() => xpFloat(xpChip.hidden ? root : xpChip, gained));
          report({ ok: true, xp: gained, typed: true });
        },
      });
      cleanup.push(() => g.destroy());
      if (kernel.status === 'idle') startKernel();
      api = { check: () => g.run(), focus: () => g.focus() };
      return;
    }

    /* ============================ code: an empty cell, the student writes everything ============================ */
    const pr = splitText(ex.prompt || '', 160);
    root.appendChild(statement(pr.line, ex.title && !generic ? ex.title : 'Escribe el código que se pide.'));
    if (kind === 'fix' && ex.broken) body.appendChild(refBlock('Con errores: escríbelo bien abajo', codeBlock(ex.broken), 'ex-ref--bad'));
    else if (kind === 'fill' && ex.template) body.appendChild(refBlock('Forma (□ = lo que falta)', codeBlock(String(ex.template).replace(/__\d+__/g, '□'))));
    else if (kind === 'order' && Array.isArray(ex.lines)) {
      let lines = shuffled(ex.lines, rnd);
      if (ex.lines.length > 1) { let guard = 0; while (lines.every((l, i) => l === ex.lines[i]) && guard++ < 20) lines = shuffled(lines, rnd); }
      body.appendChild(refBlock('Desordenadas: escríbelas en orden', h('div', { class: 'ex-lines' }, lines.map((l) => codeBlock(l)))));
    } else if (ex.starter) body.appendChild(refBlock('Punto de partida', codeBlock(ex.starter)));
    if (ex.setup && !isExam) body.appendChild(h('details', { class: 'ex-setup lx-more-d' }, h('summary', null, 'Datos ya definidos'), codeBlock(ex.setup)));
    const host = h('div', { class: 'ex-cell' });
    body.appendChild(host);
    // «Más detalle»: what did not fit in the statement + the exercise's own `more` (e.g. the original exam statement); once solved, + `explain`
    const detail = [pr.rest, ex.more].filter((x) => x && String(x).trim()).join('\n\n');
    let moreEl = moreBox({ more: detail });
    root.append(body, actions, hintsBox, fb);
    if (moreEl) root.appendChild(moreEl);
    const placeShape = () => { if (shapeEl && host.isConnected) host.parentNode.insertBefore(shapeEl, host); };
    if (foot) root.appendChild(foot);

    const needsKernel = !!ex.check || kind === 'code' || kind === 'fix';
    const label = 'Comprobar';
    const btnCheck = h('button', { class: 'btn primary ex-check', type: 'button', 'data-nosfx': '' }, label);
    const btnHint = h('button', { class: 'lx-link ex-hint', type: 'button' });
    const btnSol = h('button', { class: 'lx-link ex-sol', type: 'button', hidden: true }, gentle ? 'Verla entera y teclearla' : 'Ver solución');
    const btnVariant = h('button', { class: 'lx-link ex-variant', type: 'button', hidden: true, title: 'El mismo ejercicio con otros números' }, 'Otra variante');
    const kbd = h('span', { class: 'ex-kbd', hidden: true });
    btnCheck.title = 'Ctrl+Enter comprueba · Shift+Enter solo evalúa';
    const hints = [ex.hint, ...(Array.isArray(ex.hints) ? ex.hints : [])].filter((x, i, a) => x && String(x).trim() && a.indexOf(x) === i);
    // hint ladder (never penalised): text hints → the shape of the line (brackets, braces, commas) → the whole solution as a ghost to type
    const shape = (() => { const sk = skeletonOf(solutionOf(ex)); return /[[{]/.test(sk) && squash(sk) !== squash(solutionOf(ex)) ? sk : ''; })();
    const shapeEl = h('pre', { class: 'lx-ghostref ex-shape', hidden: true, title: 'La forma de la línea: comando, corchetes, llaves y comas' });
    const updHintBtn = () => {
      if (isExam) { btnHint.hidden = true; return; }
      const left = hints.length - st.hints;
      const canShape = !!shape && !st.shape;
      btnHint.hidden = st.done || st.revealed || (left <= 0 && !canShape);
      btnHint.textContent = left > 0 ? (st.hints ? 'Otra pista' : 'Pista') : 'Ver la forma';
      btnHint.title = 'Las pistas no restan nada';
    };
    updHintBtn();
    const solutionDue = () => st.shape || (st.hints >= hints.length && !shape && (gentle || st.fails >= 1 || hints.length > 0)) || st.fails >= (gentle ? 2 : 3);
    const offerSolution = () => { if (isExam || st.done || st.revealed || !btnSol.hidden || !solutionOf(ex)) return; btnSol.hidden = false; };
    btnHint.addEventListener('click', () => {
      if (st.done || st.revealed) return;
      if (st.hints < hints.length) {
        const i = st.hints++;
        hintsBox.appendChild(h('div', { class: 'ex-hintitem' }, h('span', { class: 'ex-hint-n' }, `Pista ${i + 1}`), h('div', { class: 'lx-md', html: md(hints[i]) })));
      } else if (shape && !st.shape) {
        st.shape = true; st.hints++;
        shapeEl.textContent = shape; shapeEl.hidden = false;
      }
      updHintBtn(); updXp();
      if (solutionDue()) offerSolution();
      if (cell) safe(() => cell.focus());
    });
    btnVariant.addEventListener('click', () => { seed = newSeed(); build(); });

    let cell = null;
    placeShape();
    try { cell = createCell(host, { code: '', placeholder: gentle ? 'Escríbelo de memoria…' : 'Escribe aquí tu código…' }); } catch (e) { console.error('[learn] createCell', e); host.appendChild(h('div', { class: 'ex-fb ex-fb--info' }, 'No se pudo crear la celda.')); }

    /* ---------- kernel gate ---------- */
    let pillEl = null;
    if (needsKernel) {
      const pill = kernelPill();
      cleanup.push(pill.destroy);
      pillEl = pill.el;
      cleanup.push(watchKernel((status) => {
        if (st.done) return;
        const ok = status === 'ready' || status === 'busy';
        btnCheck.disabled = !ok || st.busy;
        btnCheck.classList.toggle('is-waiting', !ok);
      }));
      primeWhenReady();
    }
    async function kernelCheck(code) {
      st.busy = true; root.dataset.state = 'busy';
      btnCheck.disabled = true;
      btnCheck.innerHTML = '<i class="lx-spin"></i> Comprobando…';
      const cancel = h('button', { class: 'lx-link ex-cancel', type: 'button', onclick: () => safe(() => kernel.abort()) }, 'Cancelar');
      const slow = setTimeout(() => { if (st.busy && !destroyed) actions.appendChild(cancel); }, 6000);
      let res;
      try {
        res = await exclusive(async () => {
          await kernel.reset();
          return kernel.check({ code, setup: ex.setup || undefined, check: ex.check || { type: 'none' }, requires: ex.requires || [], forbids: ex.forbids || [] });
        });
      } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      clearTimeout(slow); cancel.remove();
      st.busy = false;
      if (destroyed) return null;
      btnCheck.disabled = !kernelReady();
      btnCheck.textContent = label;
      if (!res || res.error) {
        root.dataset.state = 'idle';
        showInfo(`No se ha podido comprobar (${(res && res.error) || 'sin respuesta del motor'}). Inténtalo de nuevo.`);
        return null;
      }
      return res;
    }

    /* ---------- feedback ---------- */
    function showInfo(text) {
      fb.replaceChildren(h('div', { class: 'ex-fb ex-fb--info' }, h('div', { class: 'ex-fb-title' }, h('div', { class: 'lx-md', html: mdInline(text) }))));
    }
    function showFail(res, code) {
      st.fails++;
      root.dataset.state = 'fail';
      host.classList.remove('lx-shake'); void host.offsetWidth; host.classList.add('lx-shake');
      play('fail');
      if (!isExam && !gentle) combo = 0;
      if (!gentle) safe(() => store.markExercise(ex.id, { ok: false, cmds: ex.cmds || [], xp: 0 }));
      const box = h('div', { class: 'ex-fb ex-fb--bad' });
      box.appendChild(h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '✗'), h('div', { class: 'lx-md', html: mdInline((res && res.feedback) || 'Todavía no es correcto.') })));
      if (!isExam && res && (res.got || res.expected)) {
        const diff = h('div', { class: 'ex-diff' });
        if (res.got) diff.append(h('span', { class: 'ex-diff-l' }, 'Tu resultado'), h('code', { class: 'ex-diff-v got' }, String(res.got)));
        if (res.expected) diff.append(h('span', { class: 'ex-diff-l' }, 'Se esperaba'), h('code', { class: 'ex-diff-v exp' }, String(res.expected)));
        box.appendChild(diff);
      }
      if (!isExam && code != null) {
        const tips = diagnose(code, ex);
        if (tips.length) box.appendChild(h('ul', { class: 'ex-tips' }, tips.map((t) => h('li', { html: '<b>Posible causa:</b> ' + mdInline(t) }))));
      }
      if (!isExam) {
        const left = hints.length - st.hints;
        if (st.fails === 1) box.appendChild(h('div', { class: 'ex-fb-sub muted' }, left > 0 || (shape && !st.shape) ? 'Equivocarse no resta: prueba otra vez o pide una pista.' : 'Equivocarse no resta: prueba otra vez.'));
      }
      fb.replaceChildren(box);
      if (solutionDue()) offerSolution();
      updXp();
      if (isExam) report({ ok: false });
    }
    function showOk() {
      const dry = st.revealed;
      st.done = true;
      root.dataset.state = 'ok';
      const firstTry = st.fails === 0 && st.hints === 0 && !dry;
      let gained = 0, r = null;
      if (!dry && !isExam) {
        r = safe(() => store.markExercise(ex.id, { ok: true, cmds: ex.cmds || [], xp: gentle ? 15 : xpFor(ex, st) }), null);
        gained = r && typeof r.xp === 'number' ? r.xp : 0;
        setReview(ex.id, false);
        combo = r && typeof r.combo === 'number' ? r.combo : firstTry ? combo + 1 : 0;
      }
      play('ok');
      // sober feedback: a green mark and a short animation; confetti is reserved for milestones
      if (!isExam && gained > 0) safe(() => xpFloat(xpChip, gained));
      const box = h('div', { class: 'ex-fb ex-fb--ok' });
      const head = h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '✓'),
        h('strong', null, dry ? 'Así es. Volverá a salir para que lo escribas sin mirar.' : OK_MSGS[Math.floor(Math.random() * OK_MSGS.length)]));
      if (gained > 0) head.appendChild(h('span', { class: 'ex-gain' }, `+${gained} XP`));
      if (!dry && firstTry && !isExam) head.appendChild(h('span', { class: 'ex-first' }, 'a la primera'));
      if (!dry && !isExam && combo >= 3) head.appendChild(h('span', { class: 'ex-combo' }, `${combo} seguidos`));
      box.appendChild(head);
      fb.replaceChildren(box);
      if (!isExam) {
        const mb = moreBox({ more: [detail, ex.explain].filter((x) => x && String(x).trim()).join('\n\n') });
        if (moreEl) { moreEl.remove(); moreEl = null; }
        if (mb) fb.appendChild(mb);
      }
      btnCheck.hidden = true; btnSol.hidden = true; btnHint.hidden = true; kbd.hidden = true; shapeEl.hidden = true;
      if (exRaw.params && !isExam && !dry) btnVariant.hidden = false;
      setPrior(dry ? 'review' : 'ok');
      xpChip.classList.add('is-zero'); xpChip.textContent = gained > 0 ? `+${gained} XP` : dry ? 'sin XP' : 'repaso';
      for (const c of cmds.querySelectorAll('.chip')) { const lv = safe(() => store.cmdLevel(c.dataset.cmd), 0) || 0; c.className = `chip l${lv}`; }
      report({ ok: !dry, revealed: dry, firstTry, xp: gained, leveledUp: !!(r && r.leveledUp), level: r && r.level });
    }

    /* ---------- check ---------- */
    const doCheck = async () => {
      if (!cell || st.busy || st.done || st.revealed) return;
      const code = cell.getCode();
      if (!code.trim()) { showInfo('Escribe tu solución en la celda antes de comprobar.'); safe(() => cell.focus()); return; }
      if (!needsKernel) { if (localAccept(ex, code)) showOk(); else showFail({ feedback: kind === 'order' ? 'El orden o alguna línea no coincide todavía.' : 'La línea todavía no es correcta.' }, code); return; }
      if (!kernelReady()) { showInfo('El motor de Mathematica aún se está cargando. En unos segundos podrás comprobar.'); return; }
      const res = await kernelCheck(code);
      if (!res) return;
      safe(() => cell.showResult({ items: res.items || [], inLine: null, lastLine: null, ms: 0 }));
      if (res.ok) showOk(); else showFail(res, code);
    };
    btnCheck.addEventListener('click', doCheck);
    host.addEventListener('keydown', (e) => { if (!st.revealed && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); doCheck(); } }, true);
    // the whole answer is typed: no pasting (nor dropping) code into the cell
    host.addEventListener('paste', (e) => e.preventDefault(), true);
    host.addEventListener('drop', (e) => e.preventDefault(), true);

    /* ---------- "ver solución": shown as a ghost that the student types (never pasted) ---------- */
    btnSol.addEventListener('click', () => {
      if (st.done || st.revealed || isExam) return;
      const sol = solutionOf(ex);
      if (!sol) return;
      st.revealed = true;
      root.dataset.state = 'revealed';
      setReview(ex.id, true);
      combo = 0;
      btnSol.hidden = true; btnHint.hidden = true; btnCheck.hidden = true; kbd.hidden = true; shapeEl.hidden = true;
      if (pillEl) pillEl.remove();
      setPrior('review');
      xpChip.classList.add('is-zero'); xpChip.textContent = 'sin XP';
      if (cell && cell.destroy) safe(() => cell.destroy());
      cell = null;
      host.replaceChildren();
      const g = mountGhost(host, sol, {
        evaluate: async (code) => {
          await kernel.reset();
          const res = await kernel.check({ code, setup: ex.setup || undefined, check: ex.check || { type: 'none' }, requires: [], forbids: [] });
          return res && !res.error ? { items: res.items || [], inLine: null, lastLine: null, ms: 0 } : { items: [], inLine: null, lastLine: null, ms: 0 };
        },
        onDone: () => { if (!destroyed) showOk(); },
      });
      cleanup.push(() => g.destroy());
      fb.replaceChildren();
      setTimeout(() => g.focus(), 30);
    });

    actions.append(btnCheck, btnHint, btnSol, btnVariant);
    if (pillEl) actions.append(pillEl);
    actions.append(kbd);
    if (isExam) { btnHint.hidden = true; btnSol.hidden = true; }
    api = { check: doCheck, focus: () => cell && safe(() => cell.focus()) };
  }

  return {
    el: root,
    check: () => api && api.check && api.check(),
    focus: () => api && api.focus && api.focus(),
    destroy() {
      destroyed = true;
      cleanup.forEach((f) => safe(f)); cleanup = [];
      root.remove();
    },
  };
}

export default mountExercise;
