// exercise.js (LEARN) — the exercise widget used by lessons, practice sessions and command pages.
//   mountExercise(container, ex, {onDone(result), mode:'lesson'|'practice'|'exam', seed?, year?, lesson?, hotkeys?})
//   → {destroy(), el, focus(), check()}
// Also exports the small UI helpers shared by the LEARN views (md, h, esc, badges, rng, kernel pill…).
import { kernel } from './kernel-client.js';
import { createCell, renderItems } from './notebook.js';
import { store } from './store.js';
import * as fx from './fx.js';

const { sfx, confetti, toast, xpFloat } = fx;

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
const CHOICE = new Set(['mcq', 'predict']);
export function xpFor(ex, { fails = 0, hints = 0 } = {}) {
  const base = 10 * Math.max(1, Math.min(5, Math.round(ex.difficulty || 1)));
  let f = 1 - 0.15 * hints;
  if (CHOICE.has(ex.kind)) f *= fails === 0 ? 1 : fails === 1 ? 0.5 : 0.25;
  f = Math.max(0.3, f);
  return Math.round(base * f) + (fails === 0 && hints === 0 ? 5 : 0);
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

const KIND_LABEL = { code: 'Escribe el código', fix: 'Arregla el error', fill: 'Rellena los huecos', order: 'Ordena las líneas', mcq: 'Elige la correcta', predict: 'Predice la salida' };
const OK_MSGS = ['¡Correcto!', '¡Bien hecho!', '¡Eso es!', '¡Perfecto!', '¡Exacto!', '¡Lo tienes!'];
const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/\*/g, '');

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
    const rnd = rng(seed ^ 0x5bd1e995);
    const yr = opts.year || yearOf(opts.lesson) || yearOf(ex);
    const prior = exStatus(ex.id);
    const st = { fails: 0, hints: 0, done: false, revealed: false, busy: false, t0: Date.now(), reported: false };
    const needsKernel = kind === 'code' || kind === 'fix' || (kind === 'fill' && !!ex.check) || false;

    root.className = `ex ex--${kind}${ex.real ? ' ex--real' : ''} ex--${mode}`;
    root.dataset.state = 'idle';
    root.dataset.exId = ex.id || '';
    if (yr) root.dataset.year = yr;

    /* ---------- header ---------- */
    const xpChip = h('span', { class: 'ex-xp', title: 'XP que ganarás si lo resuelves ahora' });
    const statusBadge = h('span', { class: 'ex-prior' });
    const setPrior = (s) => {
      statusBadge.className = 'ex-prior';
      if (s === 'ok') { statusBadge.className = 'ex-prior badge ok'; statusBadge.textContent = '✓ resuelto'; }
      else if (s === 'review') { statusBadge.className = 'ex-prior badge real'; statusBadge.textContent = '↻ repetir'; statusBadge.title = 'Viste la solución: resuélvelo tú para dominarlo'; }
      else statusBadge.textContent = '';
    };
    setPrior(prior);
    const updXp = () => {
      if (isExam) { xpChip.hidden = true; return; }
      const already = safe(() => store.exercise(ex.id), null);
      if (already && already.ok) { xpChip.textContent = 'repaso'; xpChip.classList.add('is-zero'); return; }
      xpChip.textContent = `+${xpFor(ex, st)} XP`;
    };
    updXp();
    const badges = h('div', { class: 'ex-badges' },
      yearBadge(yr),
      ex.real ? h('span', { class: 'badge real', title: 'Ejercicio real de práctica o examen' }, ex.source ? `REAL · ${ex.source}` : 'REAL') : null,
      h('span', { class: 'ex-kind' }, KIND_LABEL[kind] || kind),
      diffDots(ex.difficulty),
      statusBadge,
      h('span', { class: 'ex-spacer' }),
      xpChip);
    const cmds = h('div', { class: 'ex-cmds' }, (ex.cmds || []).map(cmdChip));
    root.appendChild(h('header', { class: 'ex-head' }, badges,
      ex.title ? h('h3', { class: 'ex-title' }, ex.title) : null));
    root.appendChild(h('div', { class: 'ex-prompt lx-md', html: md(ex.prompt || '') }));

    const body = h('div', { class: 'ex-body' });
    const actions = h('div', { class: 'ex-actions' });
    const hintsBox = h('div', { class: 'ex-hints' });
    const fb = h('div', { class: 'ex-feedback', 'aria-live': 'polite' });
    root.append(body, actions, hintsBox, fb);
    if ((ex.cmds || []).length) root.appendChild(h('footer', { class: 'ex-foot' }, h('span', { class: 'ex-foot-l' }, 'Practicas:'), cmds));

    /* ---------- shared actions ---------- */
    const btnCheck = h('button', { class: 'btn primary ex-check', type: 'button' }, 'Comprobar');
    const btnHint = h('button', { class: 'btn ghost ex-hint', type: 'button' });
    const btnSol = h('button', { class: 'btn ghost ex-sol', type: 'button', hidden: true }, 'Ver solución');
    const btnReset = h('button', { class: 'btn ghost ex-reset', type: 'button', title: 'Volver al código inicial' }, '↺ Reiniciar');
    const btnVariant = h('button', { class: 'btn ghost ex-variant', type: 'button', hidden: true, title: 'Mismos pasos, otros números' }, '↻ Otra variante');
    const kbd = h('span', { class: 'ex-kbd muted' });
    const hints = Array.isArray(ex.hints) ? ex.hints.filter(Boolean) : [];
    const updHintBtn = () => {
      if (isExam || !hints.length) { btnHint.hidden = true; return; }
      const left = hints.length - st.hints;
      btnHint.hidden = st.done;
      btnHint.disabled = left <= 0;
      btnHint.innerHTML = left > 0 ? `💡 Pista <small>${st.hints + 1}/${hints.length}</small>` : '💡 Sin más pistas';
      btnHint.title = left > 0 ? 'Cada pista resta un poco de XP' : '';
    };
    updHintBtn();
    btnHint.addEventListener('click', () => {
      if (st.hints >= hints.length || st.done) return;
      const i = st.hints++;
      play('click');
      const el = h('div', { class: 'ex-hintitem' }, h('span', { class: 'ex-hint-n' }, `Pista ${i + 1}`), h('div', { class: 'lx-md', html: md(hints[i]) }));
      hintsBox.appendChild(el);
      updHintBtn(); updXp();
      // once every hint is spent, the solution becomes available (no dead ends)
      if (st.hints >= hints.length && st.fails >= 1) offerSolution();
    });
    btnSol.addEventListener('click', () => reveal());
    btnVariant.addEventListener('click', () => { seed = newSeed(); play('click'); build(); });

    function offerSolution() {
      if (isExam || st.done || st.revealed || !btnSol.hidden) return;
      btnSol.hidden = false;
      btnSol.classList.add('lx-pop');
    }

    /* ---------- feedback ---------- */
    function showFail(res, code) {
      st.fails++;
      root.dataset.state = 'fail';
      root.classList.remove('lx-shake'); void root.offsetWidth; root.classList.add('lx-shake');
      play('fail');
      if (!isExam) combo = 0;
      safe(() => store.markExercise(ex.id, { ok: false, cmds: ex.cmds || [], xp: 0 }));
      fb.innerHTML = '';
      const box = h('div', { class: 'ex-fb ex-fb--bad' });
      box.appendChild(h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '✗'), h('div', { class: 'lx-md', html: mdInline((res && res.feedback) || 'Todavía no es correcto.') })));
      if (!isExam && res && (res.got != null || res.expected != null) && (res.got || res.expected)) {
        const diff = h('div', { class: 'ex-diff' });
        if (res.got != null && res.got !== '') diff.append(h('span', { class: 'ex-diff-l' }, 'Tu resultado'), h('code', { class: 'ex-diff-v got' }, String(res.got)));
        if (res.expected != null && res.expected !== '') diff.append(h('span', { class: 'ex-diff-l' }, 'Se esperaba'), h('code', { class: 'ex-diff-v exp' }, String(res.expected)));
        box.appendChild(diff);
      }
      if (!isExam && code != null) {
        const tips = diagnose(code, ex);
        if (tips.length) box.appendChild(h('ul', { class: 'ex-tips' }, tips.map((t) => h('li', { html: '<b>Posible causa:</b> ' + mdInline(t) }))));
      }
      if (!isExam) {
        const left = hints.length - st.hints;
        const nudge = st.fails >= 3 ? 'Llevas varios intentos: puedes ver la solución y repetirlo más tarde.' : left > 0 ? `Intento ${st.fails}. Si te atascas, pide una pista.` : `Intento ${st.fails}. Revisa el enunciado con calma.`;
        box.appendChild(h('div', { class: 'ex-fb-sub muted' }, nudge));
      }
      fb.appendChild(box);
      if (st.fails >= 3 || (st.fails >= 1 && hints.length && st.hints >= hints.length)) offerSolution();
      updXp();
      if (isExam) report({ ok: false });
    }

    function showInfo(msg) {
      fb.innerHTML = '';
      fb.appendChild(h('div', { class: 'ex-fb ex-fb--info' }, h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, 'i'), h('div', { class: 'lx-md', html: mdInline(msg) }))));
      root.classList.remove('lx-nudge'); void root.offsetWidth; root.classList.add('lx-nudge');
    }

    function showOk(extraNode) {
      const dry = st.revealed;
      st.done = true;
      root.dataset.state = 'ok';
      const firstTry = st.fails === 0 && st.hints === 0 && !dry;
      let gained = 0, r = null;
      if (!dry && !isExam) {
        const xp = xpFor(ex, st);
        r = safe(() => store.markExercise(ex.id, { ok: true, cmds: ex.cmds || [], xp }), null);
        gained = r && typeof r.xp === 'number' ? r.xp : 0;
        setReview(ex.id, false);
        combo = firstTry ? combo + 1 : 0;
      }
      play('ok');
      const big = (ex.difficulty || 1) >= 4 || !!ex.real;
      if (!isExam) {
        safe(() => confetti({ el: btnCheck.isConnected && !btnCheck.hidden ? btnCheck : root, count: big ? 150 : 36, power: big ? 1.1 : 0.7, spread: big ? Math.PI * 1.2 : Math.PI * 0.8 }));
        if (gained > 0) safe(() => xpFloat(xpChip, gained));
        if (combo >= 3 && firstTry) setTimeout(() => play('combo', { n: combo }), 260);
      }
      fb.innerHTML = '';
      const box = h('div', { class: 'ex-fb ex-fb--ok' });
      const head = h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '✓'),
        h('strong', null, dry ? 'Ahora sí. Volverá a salir en la práctica para que lo hagas sin mirar.' : OK_MSGS[Math.floor(Math.random() * OK_MSGS.length)]));
      if (gained > 0) head.appendChild(h('span', { class: 'ex-gain' }, `+${gained} XP`));
      if (!dry && !isExam && combo >= 2 && firstTry) head.appendChild(h('span', { class: 'ex-combo' }, `🔥 Combo ×${combo}`));
      if (!dry && firstTry && !isExam) head.appendChild(h('span', { class: 'ex-first' }, 'a la primera'));
      box.appendChild(head);
      if (ex.explain && !isExam) box.appendChild(h('div', { class: 'ex-explain lx-md', html: md(ex.explain) }));
      if (extraNode) box.appendChild(extraNode);
      fb.appendChild(box);
      btnCheck.hidden = true; btnSol.hidden = true; btnHint.hidden = true;
      if (exRaw.params && !isExam) btnVariant.hidden = false;
      setPrior(dry ? 'review' : 'ok');
      xpChip.classList.add('is-zero'); xpChip.textContent = gained > 0 ? `+${gained} XP` : dry ? 'sin XP' : 'repaso';
      for (const c of cmds.querySelectorAll('.chip')) { const lv = safe(() => store.cmdLevel(c.dataset.cmd), 0) || 0; c.className = `chip l${lv}`; }
      report({ ok: !dry, firstTry, xp: gained, leveledUp: !!(r && r.leveledUp), level: r && r.level });
    }

    function reveal() {
      if (st.done || st.revealed || isExam) return;
      st.revealed = true;
      root.dataset.state = 'revealed';
      play('click');
      setReview(ex.id, true);
      combo = 0;
      btnSol.hidden = true; btnHint.hidden = true;
      const box = h('div', { class: 'ex-fb ex-fb--sol' });
      box.appendChild(h('div', { class: 'ex-fb-title' }, h('span', { class: 'ex-fb-ic' }, '👁'), h('strong', null, 'Solución'), h('span', { class: 'badge real' }, 'visto · repetir más tarde')));
      const sol = solutionText();
      if (sol.code) {
        const pre = codeBlock(sol.code, 'ex-solcode');
        box.appendChild(pre);
        if (api && api.applySolution) {
          box.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { api.applySolution(sol.code); play('click'); } }, kind === 'order' ? 'Colocar en orden' : 'Copiar a mi celda')));
        }
      } else if (sol.text) box.appendChild(h('div', { class: 'lx-md', html: md(sol.text) }));
      if (ex.explain) box.appendChild(h('div', { class: 'ex-explain lx-md', html: md(ex.explain) }));
      box.appendChild(h('div', { class: 'ex-fb-sub muted' }, CHOICE.has(kind) ? 'No suma XP. Te volverá a salir en la práctica.' : 'No suma XP. Escríbela tú y compruébala: así se queda. Te volverá a salir en la práctica.'));
      fb.innerHTML = ''; fb.appendChild(box);
      setPrior('review');
      xpChip.classList.add('is-zero'); xpChip.textContent = 'sin XP';
      if (api && api.onReveal) api.onReveal();
      report({ ok: false, revealed: true });
    }

    function solutionText() {
      if (kind === 'mcq' || kind === 'predict') return { text: `La respuesta correcta es: ${(ex.options || [])[ex.answer] ?? '—'}` };
      if (kind === 'order') return { code: (ex.lines || []).join('\n') };
      if (kind === 'fill') return { code: ex.solution || fillTemplate((ex.blanks || []).map((b) => (Array.isArray(b) ? b[0] : b))) };
      return { code: ex.solution || '' };
    }
    function fillTemplate(vals) { return String(ex.template || '').replace(/__(\d+)__/g, (m, n) => vals[+n - 1] ?? ''); }

    function report(extra) {
      if (!isExam && st.reported) return;
      st.reported = true;
      const result = { id: ex.id, ok: false, revealed: false, firstTry: false, xp: 0, tries: st.fails + (extra.ok ? 1 : 0), fails: st.fails, hints: st.hints, ms: Date.now() - st.t0, cmds: ex.cmds || [], combo, ...extra };
      safe(() => opts.onDone && opts.onDone(result));
    }

    /* ---------- kernel-backed check ---------- */
    let pill = null;
    function wireKernelGate(button, label) {
      pill = kernelPill();
      cleanup.push(pill.destroy);
      const off = watchKernel((status) => {
        if (st.done && button === btnCheck) return;
        const ok = status === 'ready' || status === 'busy';
        button.disabled = !ok || st.busy;
        button.classList.toggle('is-waiting', !ok);
        if (!st.busy) button.textContent = label;
      });
      cleanup.push(off);
      if (kernel.status === 'idle') startKernel();
      return pill.el;
    }
    async function kernelCheck(code, button, label) {
      if (st.busy) return null;
      st.busy = true; root.dataset.state = 'busy';
      button.disabled = true;
      button.innerHTML = '<i class="lx-spin"></i> Comprobando…';
      const cancel = h('button', { class: 'lx-link ex-cancel', type: 'button', onclick: () => safe(() => kernel.abort()) }, 'Cancelar');
      const slow = setTimeout(() => { if (st.busy && !destroyed) actions.appendChild(cancel); }, 6000);
      let res;
      try {
        res = await exclusive(async () => {
          await kernel.reset();
          return kernel.check({ code, setup: ex.setup || undefined, check: ex.check || { type: 'none' }, requires: ex.requires || [], forbids: ex.forbids || [] });
        });
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      clearTimeout(slow); cancel.remove();
      st.busy = false;
      if (destroyed) return null;
      button.disabled = !kernelReady();
      button.textContent = label;
      if (!res || res.error) {
        root.dataset.state = 'idle';
        showInfo(`No se ha podido comprobar (${(res && res.error) || 'sin respuesta del motor'}). Inténtalo de nuevo.`);
        return null;
      }
      return res;
    }
    // makes free experimentation (Shift+Enter) see the exercise's hidden setup
    function primeSession() {
      const run = () => { if (destroyed || st.busy) return; exclusive(async () => { if (destroyed) return; await kernel.reset(); if (ex.setup) await kernel.run(ex.setup); }).catch(() => {}); };
      if (kernelReady()) run();
      else { let done = false; const off = watchKernel((s) => { if (!done && s === 'ready') { done = true; setTimeout(() => { off(); run(); }, 0); } }); cleanup.push(off); }
    }

    /* ============================ kinds ============================ */
    if (kind === 'code' || kind === 'fix') {
      const initial = (kind === 'fix' ? ex.broken : ex.starter) || '';
      const host = h('div', { class: 'ex-cell' });
      body.appendChild(host);
      if (ex.setup && !isExam) {
        const det = h('details', { class: 'ex-setup' }, h('summary', null, 'Datos ya definidos (se cargan solos)'), codeBlock(ex.setup));
        body.insertBefore(det, host);
      }
      let cell = null;
      try {
        cell = createCell(host, { code: initial, placeholder: kind === 'fix' ? '' : 'Escribe aquí tu código…' });
      } catch (e) { console.error('[learn] createCell', e); host.appendChild(h('div', { class: 'ex-fb ex-fb--info' }, 'No se pudo crear la celda.')); }
      const label = 'Comprobar';
      const pillEl = wireKernelGate(btnCheck, label);
      kbd.innerHTML = '<kbd>Shift</kbd>+<kbd>Enter</kbd> prueba · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> comprueba';
      const doCheck = async () => {
        if (!cell || st.busy || (st.done && !st.revealed)) return;
        const code = cell.getCode();
        if (!code.trim()) { showInfo('Escribe tu respuesta en la celda antes de comprobar.'); safe(() => cell.focus()); return; }
        if (kind === 'fix' && code.trim() === String(ex.broken || '').trim()) { showInfo('Todavía no has cambiado nada: localiza el error y corrígelo en la celda.'); safe(() => cell.focus()); return; }
        if (!kernelReady()) { showInfo('El motor de Mathematica aún se está cargando. En unos segundos podrás comprobar.'); return; }
        const res = await kernelCheck(code, btnCheck, label);
        if (!res) return;
        safe(() => cell.showResult({ items: res.items || [], inLine: null, lastLine: null, ms: 0 }));
        if (res.ok) showOk(); else showFail(res, code);
      };
      btnCheck.addEventListener('click', doCheck);
      host.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); doCheck(); }
      }, true);
      btnReset.addEventListener('click', () => { if (cell) { cell.setCode(initial); safe(() => cell.clearOutput()); safe(() => cell.focus()); play('click'); } });
      btnReset.hidden = !initial;
      actions.append(btnCheck, btnHint, btnSol, btnReset, btnVariant, pillEl, kbd);
      api = { check: doCheck, focus: () => cell && safe(() => cell.focus()), applySolution: (code) => { if (cell) { cell.setCode(code); safe(() => cell.focus()); } }, onReveal: () => { btnCheck.hidden = false; } };
      primeSession();
    } else if (kind === 'fill') {
      const blanks = (ex.blanks || []).map((b) => (Array.isArray(b) ? b : [b]));
      const tpl = String(ex.template || '');
      const paper = h('div', { class: 'ex-fill lx-paper' });
      const line = h('pre', { class: 'ex-fill-code' });
      const inputs = [];
      let last = 0, m;
      const re = /__(\d+)__/g;
      while ((m = re.exec(tpl))) {
        if (m.index > last) line.appendChild(h('span', { html: hl(tpl.slice(last, m.index)) }));
        const idx = +m[1] - 1;
        const inp = h('input', { class: 'ex-blank', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': `Hueco ${idx + 1}`, placeholder: '···', dataset: { i: idx } });
        inputs.push(inp);
        line.appendChild(inp);
        last = m.index + m[0].length;
      }
      if (last < tpl.length) line.appendChild(h('span', { html: hl(tpl.slice(last)) }));
      const out = h('div', { class: 'ex-fill-out' });
      paper.append(line, out);
      body.appendChild(paper);
      const size = (inp) => { inp.style.width = `${Math.max(3, inp.value.length + 1.5)}ch`; };
      const hit = (inp) => { const acc = blanks[+inp.dataset.i] || []; return inp.value.trim() !== '' && acc.some((a) => norm(a) === norm(inp.value)); };
      const values = () => { const v = []; for (const inp of inputs) v[+inp.dataset.i] = inp.value.trim(); return v; };
      inputs.forEach((inp, k) => {
        size(inp);
        inp.addEventListener('input', () => {
          for (const o of inputs) if (o !== inp && o.dataset.i === inp.dataset.i) { o.value = inp.value; size(o); o.classList.toggle('is-hit', hit(o)); }
          size(inp);
          inp.classList.toggle('is-hit', hit(inp));
          inp.classList.remove('is-miss');
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); const nxt = inputs.slice(k + 1).find((o) => !o.value.trim()); if (nxt) nxt.focus(); else doCheck(); }
        });
      });
      const label = 'Comprobar';
      let pillEl = null;
      if (needsKernel) pillEl = wireKernelGate(btnCheck, label);
      const doCheck = async () => {
        if (st.busy || (st.done && !st.revealed)) return;
        const vals = values();
        const empty = inputs.find((o) => !o.value.trim());
        if (empty) { showInfo('Rellena todos los huecos antes de comprobar.'); empty.focus(); return; }
        const code = fillTemplate(vals);
        if (!needsKernel) {
          const ok = inputs.every(hit);
          inputs.forEach((o) => o.classList.toggle('is-miss', !hit(o)));
          if (ok) { lock(); showOk(); } else showFail({ feedback: 'Algún hueco no es correcto (marcado en rojo).' }, code);
          return;
        }
        if (!kernelReady()) { showInfo('El motor de Mathematica aún se está cargando. En unos segundos podrás comprobar.'); return; }
        const res = await kernelCheck(code, btnCheck, label);
        if (!res) return;
        out.innerHTML = '';
        safe(() => renderItems(out, res.items || []));
        if (res.ok) { lock(); showOk(); } else showFail(res, code);
      };
      const lock = () => inputs.forEach((o) => { o.readOnly = true; o.classList.add('is-hit'); });
      btnCheck.addEventListener('click', doCheck);
      actions.append(btnCheck, btnHint, btnSol, btnVariant);
      if (pillEl) actions.append(pillEl);
      api = {
        check: doCheck, focus: () => inputs[0] && inputs[0].focus(),
        applySolution: () => { inputs.forEach((o) => { o.value = (blanks[+o.dataset.i] || [''])[0]; size(o); o.classList.toggle('is-hit', hit(o)); }); },
        onReveal: () => { btnCheck.hidden = false; },
      };
    } else if (kind === 'order') {
      const correct = (ex.lines || []).slice();
      let order = shuffled(correct.map((t, i) => ({ t, i })), rnd);
      if (correct.length > 1) { let guard = 0; while (order.every((o, k) => o.t === correct[k]) && guard++ < 20) order = shuffled(order, rnd); }
      const list = h('ol', { class: 'ex-order lx-paper' });
      const out = h('div', { class: 'ex-fill-out lx-paper', hidden: true });
      body.append(list, out);
      let selected = null;
      const rows = () => [...list.children];
      const current = () => rows().map((r) => r._t);
      const flip = (els, mutate) => {
        const before = new Map(els.map((e) => [e, e.getBoundingClientRect().top]));
        mutate();
        for (const e of els) {
          const dy = before.get(e) - e.getBoundingClientRect().top;
          if (!dy || e.classList.contains('dragging')) continue;
          e.style.transition = 'none'; e.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => { e.style.transition = ''; e.style.transform = ''; });
        }
      };
      const clearMarks = () => rows().forEach((r) => r.classList.remove('is-right', 'is-wrong'));
      const move = (row, toIdx) => {
        const rs = rows(); const from = rs.indexOf(row);
        if (toIdx < 0 || toIdx >= rs.length || toIdx === from) return;
        flip(rs, () => { if (toIdx > from) list.insertBefore(row, rs[toIdx].nextSibling); else list.insertBefore(row, rs[toIdx]); });
        clearMarks(); play('click');
      };
      for (const o of order) {
        const row = h('li', { class: 'ex-ord-row', tabindex: '0' },
          h('span', { class: 'ex-ord-handle', 'aria-hidden': 'true', title: 'Arrastra para mover' }, '⠿'),
          h('pre', { class: 'ex-ord-code', html: hl(o.t) }),
          h('span', { class: 'ex-ord-btns' },
            h('button', { type: 'button', class: 'ex-ord-up', 'aria-label': 'Subir línea', title: 'Subir' }, '▲'),
            h('button', { type: 'button', class: 'ex-ord-down', 'aria-label': 'Bajar línea', title: 'Bajar' }, '▼')));
        row._t = o.t;
        list.appendChild(row);
      }
      list.addEventListener('click', (e) => {
        if (st.done) return;
        const row = e.target.closest('.ex-ord-row'); if (!row) return;
        const rs = rows(); const i = rs.indexOf(row);
        if (e.target.closest('.ex-ord-up')) { move(row, i - 1); return; }
        if (e.target.closest('.ex-ord-down')) { move(row, i + 1); return; }
        if (row._dragged) { row._dragged = false; return; }
        // tap-to-move: tap a line, then tap where it should go
        if (!selected) { selected = row; row.classList.add('is-sel'); }
        else if (selected === row) { row.classList.remove('is-sel'); selected = null; }
        else { const s = selected; s.classList.remove('is-sel'); selected = null; move(s, i); }
      });
      list.addEventListener('keydown', (e) => {
        if (st.done) return;
        const row = e.target.closest('.ex-ord-row'); if (!row) return;
        const i = rows().indexOf(row);
        if (e.key === 'ArrowUp' && (e.altKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); e.stopPropagation(); move(row, i - 1); row.focus(); }
        else if (e.key === 'ArrowDown' && (e.altKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); e.stopPropagation(); move(row, i + 1); row.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); rows()[i - 1]?.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); rows()[i + 1]?.focus(); }
      });
      // pointer drag (mouse anywhere on the row; touch from the handle so the page can still scroll)
      let drag = null;
      list.addEventListener('pointerdown', (e) => {
        if (st.done || e.target.closest('button')) return;
        const row = e.target.closest('.ex-ord-row'); if (!row) return;
        if (e.pointerType === 'mouse' ? e.button !== 0 : !e.target.closest('.ex-ord-handle')) return;
        drag = { row, id: e.pointerId, y0: e.clientY, ty: 0, moved: false };
      });
      const onMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const { row } = drag;
        if (!drag.moved) {
          if (Math.abs(e.clientY - drag.y0) < 6) return;
          drag.moved = true; row.classList.add('dragging');
          if (selected) { selected.classList.remove('is-sel'); selected = null; }
          safe(() => row.setPointerCapture(e.pointerId));
          const r = row.getBoundingClientRect();
          drag.grab = drag.y0 - r.top;
        }
        e.preventDefault();
        const rs = rows(); const i = rs.indexOf(row);
        const prev = rs[i - 1], next = rs[i + 1];
        if (prev) { const r = prev.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { flip(rs, () => list.insertBefore(row, prev)); clearMarks(); } }
        if (next) { const r = next.getBoundingClientRect(); if (e.clientY > r.top + r.height / 2) { flip(rs, () => list.insertBefore(row, next.nextSibling)); clearMarks(); } }
        const natural = row.getBoundingClientRect().top - drag.ty;
        const lr = list.getBoundingClientRect();
        const want = Math.max(lr.top - 6, Math.min(lr.bottom - row.offsetHeight + 6, e.clientY - drag.grab));
        drag.ty = want - natural;
        row.style.transform = `translateY(${drag.ty}px)`;
      };
      const onUp = (e) => {
        if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
        const { row, moved } = drag; drag = null;
        if (!moved) return;
        row._dragged = true; setTimeout(() => { row._dragged = false; }, 50);
        row.style.transition = 'transform .16s'; row.style.transform = '';
        setTimeout(() => { row.style.transition = ''; row.classList.remove('dragging'); }, 170);
        play('click');
      };
      list.addEventListener('pointermove', onMove);
      list.addEventListener('pointerup', onUp);
      list.addEventListener('pointercancel', onUp);

      const label = 'Comprobar orden';
      btnCheck.textContent = label;
      const finish = (res) => {
        rows().forEach((r) => r.classList.add('is-right'));
        list.classList.add('is-locked');
        if (res && (res.items || []).length) { out.hidden = false; safe(() => renderItems(out, res.items)); }
        showOk();
      };
      const doCheck = async () => {
        if (st.busy || (st.done && !st.revealed)) return;
        const cur = current();
        const match = cur.every((t, i) => t === correct[i]);
        const code = cur.join('\n');
        if (match) {
          // order is right: success does not depend on the kernel; if it is up, run the code to show what it produces
          if (ex.check && kernelReady()) { const res = await kernelCheck(code, btnCheck, label); if (destroyed) return; finish(res); } else finish(null);
          return;
        }
        if (ex.check && kernelReady()) {
          const res = await kernelCheck(code, btnCheck, label);
          if (destroyed) return;
          if (res && res.ok) { finish(res); return; } // a different but equally valid order
        }
        rows().forEach((r, i) => { r.classList.toggle('is-right', r._t === correct[i]); r.classList.toggle('is-wrong', r._t !== correct[i]); });
        const n = cur.filter((t, i) => t === correct[i]).length;
        showFail({ feedback: `El orden aún no es correcto: ${n} de ${correct.length} líneas están en su sitio (en verde).` }, null);
      };
      btnCheck.addEventListener('click', doCheck);
      kbd.textContent = 'Arrastra las líneas, usa ▲▼ o toca una línea y luego su destino.';
      actions.append(btnCheck, btnHint, btnSol, kbd);
      if (ex.check && kernel.status === 'idle' && mode !== 'exam') startKernel();
      api = {
        check: doCheck, focus: () => rows()[0] && rows()[0].focus(),
        applySolution: () => { const rs = rows(); const used = new Set(); const sorted = correct.map((t) => { const r = rs.find((x) => x._t === t && !used.has(x)); used.add(r); return r; }); flip(rs, () => sorted.forEach((r) => r && list.appendChild(r))); clearMarks(); },
        onReveal: () => { btnCheck.hidden = false; },
      };
    } else if (kind === 'mcq' || kind === 'predict') {
      let cell = null; let runBtn = null; let pillEl = null;
      if (kind === 'predict' && ex.code) {
        const host = h('div', { class: 'ex-cell ex-cell--ro' });
        body.appendChild(host);
        try { cell = createCell(host, { code: ex.code, readOnly: true }); } catch (e) { console.error('[learn] createCell', e); host.appendChild(codeBlock(ex.code, 'lx-paper')); }
      }
      const optsEl = h('div', { class: 'ex-opts', role: 'group', 'aria-label': 'Opciones' });
      let idxs = (ex.options || []).map((_, i) => i);
      const positional = (ex.options || []).some((o) => /anterior|ambas|ninguna|todas|las dos|a\)|b\)/i.test(String(o)));
      if (mode === 'practice' && !positional) idxs = shuffled(idxs, rnd);
      const letters = 'ABCDEFGH';
      const buttons = [];
      idxs.forEach((oi, pos) => {
        const txt = String(ex.options[oi]);
        const isCode = kind === 'predict' && !/`/.test(txt);
        const b = h('button', { class: 'ex-opt', type: 'button', dataset: { oi } },
          h('span', { class: 'ex-opt-k' }, letters[pos] || String(pos + 1)),
          isCode ? h('code', { class: 'ex-opt-t ex-opt-code' }, txt) : h('span', { class: 'ex-opt-t lx-md', html: mdInline(txt) }));
        b.addEventListener('click', () => choose(b, oi));
        buttons.push(b);
        optsEl.appendChild(b);
      });
      body.appendChild(optsEl);
      const afterRun = () => {
        if (kind !== 'predict' || !cell || runBtn) return;
        runBtn = h('button', { class: 'btn ghost ex-run', type: 'button' }, '▶ Ejecútalo y compruébalo');
        runBtn.addEventListener('click', async () => {
          runBtn.disabled = true; runBtn.innerHTML = '<i class="lx-spin"></i> Ejecutando…';
          if (!pillEl) { const p = kernelPill(); cleanup.push(p.destroy); pillEl = p.el; actions.appendChild(pillEl); }
          try {
            await exclusive(async () => { await kernel.reset(); if (ex.setup) await kernel.run(ex.setup); if (!destroyed) await cell.run(); });
            if (!destroyed) runBtn.remove();
          } catch (e) { if (!destroyed) { runBtn.disabled = false; runBtn.textContent = '▶ Reintentar'; } }
        });
        actions.appendChild(runBtn);
      };
      const choose = (b, oi) => {
        if (st.done || st.revealed || b.disabled) return;
        if (oi === ex.answer) {
          b.classList.add('is-right');
          buttons.forEach((x) => { x.disabled = true; });
          showOk(); afterRun();
        } else {
          b.classList.add('is-wrong'); b.disabled = true;
          showFail({ feedback: kind === 'predict' ? 'Eso no es lo que devuelve. Sigue el código paso a paso.' : 'No es esa. Piensa por qué y prueba otra.' }, null);
        }
      };
      const onKey = (e) => {
        if (st.done || st.revealed || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (!root.isConnected) return;
        let i = -1;
        if (/^[1-9]$/.test(e.key)) i = +e.key - 1; else if (/^[a-h]$/i.test(e.key)) i = letters.indexOf(e.key.toUpperCase());
        if (i >= 0 && buttons[i]) { e.preventDefault(); buttons[i].click(); }
      };
      if (opts.hotkeys) { document.addEventListener('keydown', onKey); cleanup.push(() => document.removeEventListener('keydown', onKey)); kbd.textContent = `Teclas ${letters.slice(0, buttons.length).split('').join(' · ')}`; }
      actions.append(btnHint, btnSol, kbd);
      api = {
        check: () => {}, focus: () => buttons[0] && buttons[0].focus({ preventScroll: true }),
        onReveal: () => { buttons.forEach((x) => { x.disabled = true; if (+x.dataset.oi === ex.answer) x.classList.add('is-right'); }); afterRun(); },
      };
    } else {
      body.appendChild(h('div', { class: 'ex-fb ex-fb--info' }, `Tipo de ejercicio desconocido: ${kind}`));
      api = { check: () => {}, focus: () => {} };
    }
    if (isExam) { btnHint.hidden = true; btnSol.hidden = true; }
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
