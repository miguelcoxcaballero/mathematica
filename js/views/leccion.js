// views/leccion.js (LEARN) — lesson player.  #/leccion/<lessonId>[/<paso>]
//   #/leccion/<id>            the short list of TRAMOS of the lesson
//   #/leccion/<id>/<paso>     inside the tramo that contains step <paso> (0-based step index, the number the store keeps)
// SPEC §13: ONE thing per screen. A tramo is flattened into screens: a text, ONE ghost cell to type (explain cells and
// the pieces of a `build`, with the pieces already typed assembling above), the `recall` of a build (write it from memory,
// hints never penalised), one exercise, and a 3-line summary. No step list in sight: a thin progress line and back/next.
import { store } from '../store.js?v=1794358225';
import * as data from '../data.js?v=1794358225';
import { kernel } from '../kernel-client.js?v=1794358225';
import * as fx from '../fx.js?v=1794358225';
import {
  mountExercise, mountGhost, exerciseMode, recallExercise, reviewRecord, reviewDue, ensureCss, h, mdInline, codeBlock, yearBadge, yearOf, cmdChip, splitText, moreBox,
  exclusive, kernelReady, watchKernel,
  safe, play, exStatus, startKernel, kernelPill, newSeed, setImmersive, touchUI, touchText,
} from '../exercise.js?v=1794358225';

const WARMUP_KEY = 'wolframlab-aero-warmup';
let S = null; // state of the mounted lesson

/* ============================================================ model: tramos and screens */
function parseParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  let id = p.lessonId || p.lesson || p.id;
  let paso = p.paso != null ? p.paso : p.step;
  if (!id) ({ id, paso } = fromHash());
  const n = Number(paso);
  return { id, paso: Number.isFinite(n) && paso != null && paso !== '' ? Math.round(n) : null };
}
function fromHash() {
  const segs = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map((s) => safe(() => decodeURIComponent(s), s));
  return segs[0] === 'leccion' ? { id: segs[1], paso: segs[2] } : { id: null, paso: null };
}
const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.cm-editor, [contenteditable="true"], [data-editor]'));
const cellsOf = (step) => (Array.isArray(step.cells) ? step.cells.filter((c) => c && typeof c.code === 'string' && c.code.trim()) : []);
const partsOf = (step) => (Array.isArray(step.parts) ? step.parts.filter((c) => c && typeof c.code === 'string' && c.code.trim()) : []);

function stepKind(step) {
  if (step.type === 'explain' || step.type === 'build') return step.type;
  const m = exerciseMode(step.ex || {});
  return m === 'code' ? 'exercise' : m; // 'exercise' | 'ghost' | 'note'
}
function stepTitle(step, i) {
  if (step.type !== 'exercise') return step.title || `Paso ${i + 1}`;
  const ex = step.ex || {};
  return ex.title || (stepKind(step) === 'exercise' ? 'Ejercicio' : stepKind(step) === 'note' ? 'Nota' : 'Teclea y observa');
}

/** Tramos: from `section` on the steps; otherwise a new tramo starts at each build/explain (long runs of exercises are split). */
function tramosOf(lesson) {
  const steps = lesson.steps;
  const out = [];
  const hasSections = steps.some((s) => s && s.section);
  let cur = null, exRun = 0;
  steps.forEach((step, i) => {
    const isEx = step.type === 'exercise';
    let start = !cur;
    if (hasSections) start = start || !!step.section;
    else if (!isEx) start = true;
    else if (exRun >= 3 && cur.steps.length >= 3) start = true;
    if (start) { cur = { title: step.section || '', steps: [], auto: !step.section }; out.push(cur); exRun = 0; }
    cur.steps.push(i);
    exRun = isEx ? exRun + 1 : 0;
  });
  out.forEach((t, k) => {
    const first = steps[t.steps[0]];
    if (!t.title) {
      const onlyEx = t.steps.every((i) => steps[i].type === 'exercise');
      const real = onlyEx && t.steps.some((i) => steps[i].ex && steps[i].ex.real);
      t.title = onlyEx ? `${real ? 'Ejercicios reales' : 'Ejercicios'}: ${stepTitle(first, t.steps[0])}` : stepTitle(first, t.steps[0]);
    }
    t.index = k;
  });
  return out;
}

/** Screens of a tramo: one thing each. */
function screensOf(lesson, tramo) {
  const out = [];
  for (const i of tramo.steps) {
    const step = lesson.steps[i];
    const kind = stepKind(step);
    if (kind === 'explain') {
      const cells = cellsOf(step);
      if (!cells.length) out.push({ type: 'text', i });
      cells.forEach((c, k) => out.push({ type: 'cell', i, k, last: k === cells.length - 1 }));
    } else if (kind === 'build') {
      const parts = partsOf(step);
      parts.forEach((c, k) => out.push({ type: 'part', i, k })); // straight to the first piece (no intro screen)
      out.push({ type: 'recall', i });
    } else out.push({ type: 'ex', i, kind });
  }
  out.push({ type: 'summary' });
  return out;
}
function minutesOf(lesson, tramo) {
  let m = 0;
  for (const s of screensOf(lesson, tramo)) m += s.type === 'ex' ? (s.kind === 'exercise' ? 1 : 0.3) : s.type === 'recall' ? 0.7 : s.type === 'cell' || s.type === 'part' ? 0.3 : 0.1;
  return Math.max(1, Math.round(m));
}

const typedMap = (S) => safe(() => (store.state.lesson[S.lesson.id] || {}).typed, null) || {};
function stepDone(S, i) {
  const step = S.lesson.steps[i];
  const kind = stepKind(step);
  if (kind === 'explain' || kind === 'build') return !!typedMap(S)[i];
  const st = exStatus(step.ex && step.ex.id);
  return st === 'ok' || st === 'review';
}
const markTyped = (S, i) => { if (!typedMap(S)[i]) safe(() => store.set(`lesson.${S.lesson.id}.typed.${i}`, 1)); };
function tramoStatus(S, t) {
  const done = t.steps.filter((i) => stepDone(S, i)).length;
  return done === t.steps.length ? 'done' : done > 0 ? 'doing' : 'todo';
}

/* ============================================================ mount */
async function mount(el, params) {
  ensureCss();
  const { id, paso } = parseParams(params);
  const me = (S = { el, id, alive: true, cleanup: [], screenCleanup: [], widget: null });
  el.innerHTML = '';
  const root = h('div', { class: 'ls' }, h('div', { class: 'lx-loading' }, h('i', { class: 'lx-spin' }), 'Cargando lección…'));
  el.appendChild(root);
  me.root = root;

  let lesson = null;
  try { lesson = await data.loadLesson(id); } catch (e) { lesson = null; }
  if (!me.alive || S !== me) return;
  if (!lesson || !Array.isArray(lesson.steps) || !lesson.steps.length) {
    root.replaceChildren(h('div', { class: 'lx-empty' },
      h('h2', null, 'Esta lección aún no está publicada'),
      h('p', { class: 'muted' }, `No se ha encontrado el contenido de “${id || ''}”. Puede que todavía se esté escribiendo.`),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/indice' }, 'Ir al índice'), h('a', { class: 'btn', href: '#/practica' }, 'Practicar lo que ya sé'))));
    return;
  }
  Object.assign(me, {
    lesson, n: lesson.steps.length, year: yearOf(lesson), tramos: tramosOf(lesson),
    seeds: new Map(), seenMarks: new Set(), kses: { step: null, upTo: -1 },
    sess: { xp: 0, results: new Map(), startXp: safe(() => store.state.xp, 0) || 0 },
    view: null, t: -1, screens: [], pos: 0,
  });

  const onKey = (e) => {
    if (S !== me || me.view !== 'tramo' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target) || document.querySelector('.fx-level, dialog[open]')) return;
    if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target instanceof HTMLElement && e.target.closest('button, a, summary')))) {
      if (me.nextBtn && !me.nextBtn.disabled && !me.nextBtn.hidden) { e.preventDefault(); goScreen(me, me.pos + 1); }
    } else if (e.key === 'ArrowLeft') { e.preventDefault(); goScreen(me, me.pos - 1); }
  };
  document.addEventListener('keydown', onKey);
  me.cleanup.push(() => document.removeEventListener('keydown', onKey));
  // the URL may change without the router re-mounting us (back button, links to another step of the same lesson)
  const onHash = () => { if (S !== me) return; const h2 = fromHash(); if (h2.id === lesson.id) sync(me, parseParams({ lessonId: h2.id, paso: h2.paso }).paso); };
  window.addEventListener('hashchange', onHash);
  me.cleanup.push(() => window.removeEventListener('hashchange', onHash));

  if (kernel.status === 'idle') startKernel(); // warm the engine: almost every screen needs it
  if (typeof data.loadCommands === 'function') data.loadCommands().then((c) => { me.allCmds = ((c && c.commands) || []).map((x) => x.name); }).catch(() => {});
  data.loadCourse().then((course) => {
    if (S !== me) return;
    const units = flatUnits(course);
    const k = units.findIndex((u) => u.lesson === lesson.id);
    if (k >= 0) { me.unit = units[k]; me.nextUnit = units.slice(k + 1).find((u) => u.lesson) || null; if (me.view === 'list') renderList(me); }
  }).catch(() => {});

  sync(me, paso);
}

function flatUnits(course) {
  if (typeof data.flatUnits === 'function') { const r = safe(() => data.flatUnits(course), null); if (r) return r; }
  const out = [];
  for (const y of (course && course.years) || []) for (const s of y.subjects || []) for (const b of s.blocks || []) for (const u of b.units || []) out.push({ ...u, year: y.year, subject: s.name, block: b.name });
  return out;
}

/** Shows what the URL says: the list of tramos, or the tramo that contains step `paso`. */
function sync(S, paso) {
  if (paso == null) { if (S.view !== 'list') renderList(S); return; }
  const i = Math.max(0, Math.min(S.n - 1, paso));
  const t = S.tramos.findIndex((tr) => tr.steps.includes(i));
  if (S.view === 'tramo' && S.t === t) {
    if (S.entering) return;
    const scr = S.screens[S.pos];
    // already there — or in the «¿Recuerdas?» warm-up that precedes the tramo (the same URL change reaches us twice:
    // through the router and through our own hashchange listener; the second must not skip the warm-up)
    if (scr && (scr.i === i || scr.type === 'review')) return;
    const p = S.screens.findIndex((s) => s.i === i);
    if (p >= 0) { goScreen(S, p); return; }
  }
  enterTramo(S, t < 0 ? 0 : t, i);
}

function clearScreen(S) {
  S.screenCleanup.forEach((f) => safe(f));
  S.screenCleanup = [];
  if (S.widget) { safe(() => S.widget.destroy()); S.widget = null; }
}

/* ============================================================ list of tramos */
function renderList(S) {
  clearScreen(S);
  setImmersive(false);
  S.view = 'list'; S.t = -1;
  const { lesson, root, tramos } = S;
  root.className = 'ls ls--list';
  const want = `#/leccion/${encodeURIComponent(lesson.id)}`;
  if (location.hash !== want && fromHash().id === lesson.id) safe(() => history.replaceState(history.state, '', want));
  const statuses = tramos.map((t) => tramoStatus(S, t));
  const nextIdx = statuses.findIndex((s) => s !== 'done');
  const allDone = nextIdx < 0;
  const exSteps = lesson.steps.filter((s) => s.type === 'exercise' && s.ex);
  const exOk = exSteps.filter((s) => exStatus(s.ex.id) === 'ok').length;
  if (allDone && exOk === exSteps.length) {
    const L = safe(() => store.state.lesson[lesson.id], null);
    if (!(L && L.done)) { safe(() => store.setLessonStep(lesson.id, S.n - 1, S.n)); safe(() => (store.completeLesson ? store.completeLesson(lesson.id) : store.set(`lesson.${lesson.id}.done`, true))); }
  }
  const list = h('ol', { class: 'ls-tramos' });
  tramos.forEach((t, k) => {
    const st = statuses[k];
    const firstOpen = t.steps.find((i) => !stepDone(S, i));
    const target = firstOpen != null ? firstOpen : t.steps[0];
    list.appendChild(h('li', null, h('a', { class: `ls-tramo is-${st}${k === nextIdx ? ' is-next' : ''}`, href: `#/leccion/${encodeURIComponent(lesson.id)}/${target}` },
      h('span', { class: 'ls-tramo-n' }, String(k + 1)),
      h('span', { class: 'ls-tramo-t' }, t.title),
      h('span', { class: 'ls-tramo-m' }, `${minutesOf(lesson, t)} min`),
      h('span', { class: 'ls-tramo-st' }, st === 'done' ? '✓ hecho' : st === 'doing' ? 'en curso' : k === nextIdx ? 'empezar ›' : ''))));
  });
  const nx = allDone ? null : tramos[nextIdx];
  const nxStep = nx ? (nx.steps.find((i) => !stepDone(S, i)) ?? nx.steps[0]) : 0;
  const actions = h('div', { class: 'ls-actions' });
  if (nx) actions.appendChild(h('a', { class: 'btn primary', href: `#/leccion/${encodeURIComponent(lesson.id)}/${nxStep}` }, statuses.some((s) => s !== 'todo') ? `Continuar: ${nx.title} ›` : 'Empezar ›'));
  else if (S.nextUnit) {
    const u = S.nextUnit;
    const a = h('a', { class: 'btn primary', href: `#/leccion/${encodeURIComponent(u.lesson)}` }, `Siguiente lección: ${u.title || u.practice || u.lesson} ›`);
    actions.appendChild(a);
    data.loadLesson(u.lesson).catch(() => { a.replaceWith(h('span', { class: 'muted' }, `Siguiente (${u.practice || u.title}): en preparación`)); });
  }
  actions.appendChild(h('a', { class: 'lx-link', href: `#/practica/tema/${encodeURIComponent(lesson.id)}` }, 'Practicar estos comandos'));
  root.replaceChildren(...[
    h('a', { class: 'lp-back', href: '#/indice' }, '← Índice'),
    h('div', { class: 'lp-crumbs' }, yearBadge(S.year), h('span', null, [lesson.subject, S.unit && S.unit.practice].filter(Boolean).join(' · '))),
    h('h1', { class: 'lp-title' }, lesson.title || lesson.id),
    lesson.summary ? h('p', { class: 'ls-summary lx-md', html: mdInline(splitText(lesson.summary, 90).line) }) : null,
    allDone ? h('p', { class: 'ls-done' }, exOk === exSteps.length ? 'Lección completada.' : `Tramos recorridos · ${exSteps.length - exOk} ${exSteps.length - exOk === 1 ? 'ejercicio' : 'ejercicios'} por resolver sin mirar.`) : null,
    list, actions].filter(Boolean));
  if (allDone && exOk === exSteps.length && !S.celebrated && S.sess.results.size) {
    S.celebrated = true;
    play('unlock');
    safe(() => fx.confetti({ y: 0.3, count: 45, power: 0.8 })); // milestone: lesson completed (small)
  }
  window.scrollTo({ top: 0 });
}

/* ============================================================ inside a tramo */
async function enterTramo(S, t, stepIdx) {
  clearScreen(S);
  const me = S;
  const tramo = S.tramos[t];
  const { lesson, root } = S;
  S.view = 'tramo'; S.t = t; S.entering = true;
  setImmersive(true); // SPEC §15.2: inside a tramo only a thin progress line and «×»
  S.screens = screensOf(lesson, tramo);
  S.kses = { step: null, upTo: -1 };
  let pos = S.screens.findIndex((s) => s.i === stepIdx);
  if (pos < 0) pos = 0;
  // skeleton of a screen: thin top line, centred body, back/next
  root.className = 'ls ls--tramo';
  const bar = h('i');
  const count = h('span', { class: 'ls-count' });
  const top = h('header', { class: 'ls-top' },
    h('a', { class: 'lp-back', href: `#/leccion/${encodeURIComponent(lesson.id)}`, title: 'Volver a la lista de tramos' }, '← Tramos'),
    h('span', { class: 'ls-top-t' }, tramo.title), count,
    h('button', { class: 'lx-link ls-skiptop', type: 'button', title: 'Pasar a la siguiente pantalla sin completar esta', onclick: () => goScreen(S, S.pos + 1) }, 'saltar'),
    h('a', { class: 'ls-x', href: `#/leccion/${encodeURIComponent(lesson.id)}`, 'aria-label': 'Salir del tramo', title: 'Salir del tramo' }, '×'),
    h('div', { class: 'ls-bar', role: 'progressbar', 'aria-label': 'Avance del tramo' }, bar));
  const body = h('main', { class: 'ls-body' });
  const prevBtn = h('button', { class: 'btn ghost ls-prev', type: 'button' }, '‹ Atrás');
  const skipBtn = h('button', { class: 'lx-link ls-skip', type: 'button', title: 'Pasar a la siguiente pantalla sin completar esta' }, 'saltar');
  const nextBtn = h('button', { class: 'btn primary ls-next', type: 'button' }, 'Siguiente ›');
  const navHint = h('span', { class: 'ls-nav-hint' });
  const nav = h('footer', { class: 'ls-nav' }, prevBtn, navHint, skipBtn, nextBtn);
  root.replaceChildren(top, body, nav);
  Object.assign(S, { body, bar, count, prevBtn, skipBtn, nextBtn, navHint });
  // once a typed cell is done, Enter / Shift+Enter inside it moves on to the next screen (fast flow)
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.altKey || nextBtn.disabled || nextBtn.hidden) return;
    if (!(e.target instanceof Element) || !e.target.closest('.lx-ghost.is-done')) return;
    e.preventDefault(); e.stopPropagation();
    goScreen(S, S.pos + 1);
  }, true);
  prevBtn.addEventListener('click', () => goScreen(S, S.pos - 1));
  skipBtn.addEventListener('click', () => goScreen(S, S.pos + 1));
  nextBtn.addEventListener('click', () => { if (!nextBtn.disabled) goScreen(S, S.pos + 1); });

  // "¿recuerdas…?": 2–3 recalls of earlier tramos open the session (at most once every few hours)
  const last = Number(safe(() => localStorage.getItem(WARMUP_KEY), 0)) || 0;
  if (Date.now() - last > 3 * 3600000) {
    const due = reviewDue().filter((r) => !(r.lessonId === lesson.id && tramo.steps.includes(r.step))).slice(0, 3);
    if (due.length) {
      const items = (await Promise.all(due.map((r) => data.loadLesson(r.lessonId).then((l) => ({ r, l, ex: recallExercise(l, r.step) }), () => null)))).filter((x) => x && x.ex);
      if (S !== me || S.view !== 'tramo' || S.t !== t) { me.entering = false; return; }
      if (items.length) {
        safe(() => localStorage.setItem(WARMUP_KEY, String(Date.now())));
        S.screens = [...items.map((it, k) => ({ type: 'review', item: it, k, of: items.length })), ...S.screens];
        pos = 0;
      }
    }
  }
  S.pos = -1; S.entering = false;
  goScreen(S, pos, 0);
}

function goScreen(S, pos, dir) {
  if (S.view !== 'tramo') return;
  if (pos < 0) { location.hash = `#/leccion/${encodeURIComponent(S.lesson.id)}`; return; }
  if (pos >= S.screens.length) { location.hash = `#/leccion/${encodeURIComponent(S.lesson.id)}`; return; }
  const d = dir != null ? dir : pos > S.pos ? 1 : -1;
  S.pos = pos;
  const scr = S.screens[pos];
  if (scr.i != null) {
    safe(() => store.setLessonStep(S.lesson.id, scr.i, S.n));
    const want = `#/leccion/${encodeURIComponent(S.lesson.id)}/${scr.i}`;
    if (location.hash !== want) safe(() => history.replaceState(history.state, '', want));
  }
  renderScreen(S, d);
  window.scrollTo({ top: 0 });
}

/** Footer state: "Siguiente" is the primary action only when the screen is complete; a discreet "saltar" otherwise. */
function setComplete(S, pos, done, focus) {
  if (S.pos !== pos || S.view !== 'tramo') return;
  const scr = S.screens[pos];
  const next = S.screens[pos + 1];
  S.nextBtn.textContent = !next ? 'Volver a la lista ›' : next.type === 'summary' ? 'Terminar el tramo ›' : 'Siguiente ›';
  S.nextBtn.disabled = !done;
  S.nextBtn.classList.toggle('primary', !!done); // one primary action per screen
  S.root.classList.toggle('is-done', !!done);
  S.skipBtn.hidden = !!done || scr.type === 'summary';
  S.navHint.textContent = '';
  if (done && focus) {
    S.navHint.textContent = 'Enter';
    // desktop: Enter moves on. Touch with the key bar: the focus stays in the cell so the keyboard does not close.
    const keepKeyboard = touchUI() && document.documentElement.classList.contains('lx-primary');
    if (!keepKeyboard) setTimeout(() => { if (S.pos === pos && S.nextBtn.isConnected) S.nextBtn.focus({ preventScroll: true }); }, 80);
  }
}

function renderScreen(S, dir) {
  clearScreen(S);
  const pos = S.pos;
  const scr = S.screens[pos];
  const total = S.screens.length;
  S.bar.style.width = `${Math.min(100, Math.round((100 * pos) / Math.max(1, total - 1)))}%`; // the summary is the last screen = 100 %
  S.count.textContent = scr.type === 'summary' ? '' : `${pos + 1} / ${total - 1}`;
  S.prevBtn.textContent = pos === 0 ? '‹ Tramos' : '‹ Atrás';
  const wrap = h('div', { class: `ls-screen ls-screen--${scr.type} ${dir > 0 ? 'lp-in-r' : dir < 0 ? 'lp-in-l' : 'lp-in'}` });
  S.root.classList.toggle('ls--sum', scr.type === 'summary');
  S.body.replaceChildren(wrap);
  setComplete(S, pos, false, false);
  const done = (focus = true) => setComplete(S, pos, true, focus);
  const step = scr.i != null ? S.lesson.steps[scr.i] : null;
  if (scr.type === 'text') screenText(S, wrap, step, scr, done);
  else if (scr.type === 'cell') screenCell(S, wrap, step, scr, done);
  else if (scr.type === 'part') screenPart(S, wrap, step, scr, done);
  else if (scr.type === 'recall') screenRecall(S, wrap, step, scr, done);
  else if (scr.type === 'ex') screenExercise(S, wrap, step, scr, done);
  else if (scr.type === 'review') screenReview(S, wrap, scr, done);
  else screenSummary(S, wrap, done);
}

/* ---------- helpers shared by the typing screens ---------- */
function cmdsIn(S, code) {
  const names = new Set([...(S.lesson.commands || []), ...(S.lesson.uses || [])]);
  if (S.allCmds) for (const c of S.allCmds) names.add(c);
  const found = new Set();
  for (const m of String(code).replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/[A-Z][A-Za-z0-9]*/g)) if (names.has(m[0])) found.add(m[0]);
  return [...found];
}
function markSeen(S, i, code) { for (const name of cmdsIn(S, code)) { const key = `${i}:${name}`; if (!S.seenMarks.has(key)) { S.seenMarks.add(key); safe(() => store.markSeen(name)); } } }
/** Before evaluating cell k of step i: a clean session with the earlier cells of the step already evaluated (silently). */
function sessionFor(S, i, k, codes, setup) {
  return async () => {
    if (S.kses.step !== i) { await kernel.reset(); S.kses = { step: i, upTo: -1 }; if (setup) await kernel.run(setup); }
    for (let j = S.kses.upTo + 1; j < k; j++) if (codes[j] != null) await kernel.run(codes[j]);
    S.kses.upTo = Math.max(S.kses.upTo, k - 1); // cell k itself counts once the student has evaluated it (see ghostScreen)
  };
}
/** The statement — the one visible line and headline of a screen (SPEC §14). Returns what did not fit, for «Más detalle». */
function lineOf(wrap, text, limit = 90, fallback = '') {
  const sp = splitText(text, limit);
  const line = sp.line || fallback;
  if (line) wrap.appendChild(h('p', { class: 'lx-statement lx-md', html: mdInline(touchText(line)) }));
  return sp.rest;
}
/** Small gray label above the statement (the step title, when it says something). */
function labelOf(wrap, ...bits) {
  const txt = bits.filter((x) => x && String(x).trim()).join(' · ');
  if (txt) wrap.appendChild(h('div', { class: 'ls-label' }, txt));
}
const joinMd = (...xs) => xs.filter((x) => x && String(x).trim()).join('\n\n');
/** What the key bar's primary button does once the screen is done (touch): on to the next screen. */
const nextOf = (S) => () => { if (S.view === 'tramo' && S.nextBtn && !S.nextBtn.disabled) goScreen(S, S.pos + 1); };
function ghostScreen(S, wrap, code, { run, before, onDone, hint, more, step, k, keys }) {
  const host = h('div', { class: 'ls-cell' });
  wrap.appendChild(host);
  const pill = kernelPill();
  if (run) wrap.appendChild(h('div', { class: 'ls-hint' }, pill.el));
  const g = mountGhost(host, code, {
    run: run ? undefined : false, before, onNext: nextOf(S), keys,
    onDone: (res) => { if (run && S.kses.step === step) S.kses.upTo = Math.max(S.kses.upTo, k); onDone(res); },
  });
  // prepare the session as soon as the engine is ready (clean kernel, setup, earlier cells): whatever triggers the
  // evaluation — Shift+Enter, the ▶ of the cell or the key bar on a phone — finds it in place
  if (run && before) {
    let alive = true, fired = false;
    const prime = () => { if (alive) exclusive(async () => { if (alive) await before(); }).catch(() => {}); };
    if (kernelReady()) prime();
    else { const off = watchKernel((st) => { if (!fired && st === 'ready') { fired = true; setTimeout(() => { off(); prime(); }, 0); } }); S.screenCleanup.push(off); }
    S.screenCleanup.push(() => { alive = false; });
  }
  const mb = moreBox({ hint, more });
  if (mb) wrap.appendChild(mb);
  S.screenCleanup.push(() => { pill.destroy(); g.destroy(); });
  // focus at once (same task as the tap that brought us here): on a phone the keyboard then stays open between screens
  g.focus();
  return g;
}

/* ---------- text only ---------- */
function screenText(S, wrap, step, scr, done) {
  if (step.md) labelOf(wrap, stepTitle(step, scr.i));
  const rest = lineOf(wrap, step.md, 90, stepTitle(step, scr.i));
  const mb = moreBox({ hint: step.hint, more: joinMd(rest, step.more) });
  if (mb) wrap.appendChild(mb);
  markTyped(S, scr.i);
  done(false);
}

/* ---------- explain: ONE ghost cell per screen ---------- */
function screenCell(S, wrap, step, scr, done) {
  const cells = cellsOf(step);
  const c = cells[scr.k];
  labelOf(wrap, stepTitle(step, scr.i));
  // one statement: the first cell carries the idea of the step; the others, their own note
  let more;
  if (scr.k === 0) more = joinMd(lineOf(wrap, step.md || c.note, 90, 'Teclea esta línea y evalúala.'), step.md ? c.note : '', step.more, c.more);
  else more = joinMd(lineOf(wrap, c.note || '', 90, 'Ahora esta.'), c.more);
  markSeen(S, scr.i, c.code);
  const finish = (focus) => { if (scr.last) markTyped(S, scr.i); done(focus); };
  if (c.run === false) {
    // deliberately wrong / not to be evaluated: shown, not typed
    wrap.appendChild(h('div', { class: 'ls-cell' }, codeBlock(c.code)));
    const mb = moreBox({ hint: c.hint, more });
    if (mb) wrap.appendChild(mb);
    finish(false);
    return;
  }
  const codes = cells.map((x) => (x.run === false ? null : x.code));
  ghostScreen(S, wrap, c.code, { run: true, before: sessionFor(S, scr.i, scr.k, codes), onDone: () => finish(true), hint: c.hint || (scr.k === 0 ? step.hint : ''), more, step: scr.i, k: scr.k, keys: c.keys || step.keys });
}

/* ---------- build: intro, pieces (assembling above), recall ---------- */
const squashMap = (s) => { const idx = []; let out = ''; for (let k = 0; k < s.length; k++) if (!/\s/.test(s[k])) { out += s[k]; idx.push(k); } return { out, idx }; };
/** Where does `piece` sit inside `target`? (whitespace-insensitive) → [from, to) or null */
function locate(target, piece) {
  const T = squashMap(target), P = squashMap(piece).out;
  if (!P) return null;
  const at = T.out.indexOf(P);
  return at < 0 ? null : [T.idx[at], T.idx[at + P.length - 1] + 1];
}
function assembly(step, upTo, current) {
  const target = String(step.target || '');
  const parts = partsOf(step);
  const mark = new Array(target.length).fill(0);
  for (let j = 0; j < upTo; j++) { const r = locate(target, parts[j].code); if (r) for (let x = r[0]; x < r[1]; x++) mark[x] = 1; }
  if (current != null) { const r = locate(target, parts[current].code); if (r) for (let x = r[0]; x < r[1]; x++) mark[x] = mark[x] ? 1 : 2; }
  const pre = h('pre', { class: 'ls-asm-target' });
  let run = '', cls = -1;
  const flush = () => { if (run) pre.appendChild(h('span', { class: cls === 1 ? 'is-on' : cls === 2 ? 'is-now' : '' }, run)); run = ''; };
  for (let x = 0; x < target.length; x++) { if (mark[x] !== cls) { flush(); cls = mark[x]; } run += target[x]; }
  flush();
  return h('div', { class: 'ls-asm', title: 'Lo que estás construyendo: en oscuro, lo que ya has tecleado' }, pre);
}
function screenPart(S, wrap, step, scr, done) {
  const parts = partsOf(step);
  const p = parts[scr.k];
  labelOf(wrap, stepTitle(step, scr.i));
  wrap.appendChild(assembly(step, scr.k, scr.k));
  const rest = lineOf(wrap, p.md, 90, scr.k === partsOf(step).length - 1 ? 'Ahora todo junto.' : 'Teclea esta pieza.');
  markSeen(S, scr.i, p.code);
  const run = p.run === true;
  const codes = parts.map((x) => (x.run === true ? x.code : null));
  ghostScreen(S, wrap, p.code, {
    run, before: run ? sessionFor(S, scr.i, scr.k, codes, step.setup) : undefined, onDone: () => done(true),
    hint: p.hint, more: joinMd(rest, p.more, scr.k === 0 ? step.more : ''), step: scr.i, k: scr.k, keys: p.keys || step.keys,
  });
}
function screenRecall(S, wrap, step, scr, done) {
  S.kses = { step: null, upTo: -1 };
  labelOf(wrap, 'De memoria', stepTitle(step, scr.i));
  const host = h('div', { class: 'ls-ex' });
  wrap.appendChild(host);
  const ex = recallExercise(S.lesson, scr.i);
  if (!ex) { markTyped(S, scr.i); done(false); return; }
  if (!S.seeds.has(scr.i)) S.seeds.set(scr.i, newSeed());
  S.widget = mountExercise(host, ex, {
    mode: 'lesson', recall: true, seed: S.seeds.get(scr.i), year: S.year, lesson: S.lesson, noTitle: true, onNext: nextOf(S),
    onDone: (res) => {
      if (res.xp) S.sess.xp += res.xp;
      S.sess.results.set(ex.id, res);
      markTyped(S, scr.i);
      reviewRecord(S.lesson.id, scr.i, { revealed: !!res.revealed, hints: res.hints || 0 }); // into the review queue
      done(true);
    },
  });
  if (S.widget) safe(() => S.widget.focus());
}

/* ---------- exercise: one per screen ---------- */
function screenExercise(S, wrap, step, scr, done) {
  S.kses = { step: null, upTo: -1 };
  const ex = step.ex || {};
  const exs = S.lesson.steps.filter((s) => s.type === 'exercise' && stepKind(s) === 'exercise');
  const no = exs.indexOf(step) + 1;
  const t = stepTitle(step, scr.i);
  labelOf(wrap, scr.kind === 'exercise' ? `Ejercicio ${no} de ${exs.length}` : scr.kind === 'note' ? 'Nota' : '', /^(ejercicio|nota|teclea y observa)$/i.test(t) ? '' : t);
  const host = h('div', { class: 'ls-ex' });
  wrap.appendChild(host);
  if (!S.seeds.has(scr.i)) S.seeds.set(scr.i, newSeed());
  S.widget = mountExercise(host, ex, {
    mode: 'lesson', seed: S.seeds.get(scr.i), year: S.year, lesson: S.lesson, noTitle: true, onNext: nextOf(S),
    onDone: (res) => {
      S.sess.results.set(ex.id, res);
      if (res.xp) S.sess.xp += res.xp;
      done(!res.note);
    },
  });
  if (scr.kind !== 'note' && S.widget) safe(() => S.widget.focus());
}

/* ---------- "¿recuerdas…?" (review queue) ---------- */
function screenReview(S, wrap, scr, done) {
  S.kses = { step: null, upTo: -1 };
  const { r, l, ex } = scr.item;
  labelOf(wrap, `¿Recuerdas? · ${scr.k + 1} de ${scr.of}`, ex.title);
  const host = h('div', { class: 'ls-ex' });
  wrap.appendChild(host);
  S.widget = mountExercise(host, ex, {
    mode: 'practice', recall: true, seed: newSeed(), year: yearOf(l), lesson: l, noTitle: true, onNext: nextOf(S),
    onDone: (res) => {
      if (res.xp) S.sess.xp += res.xp;
      reviewRecord(r.lessonId, r.step, { revealed: !!res.revealed, hints: res.hints || 0 });
      done(true);
    },
  });
  if (S.widget) safe(() => S.widget.focus());
}

/* ---------- end of the tramo: three lines ---------- */
function screenSummary(S, wrap, done) {
  const { lesson } = S;
  const tramo = S.tramos[S.t];
  const steps = tramo.steps.map((i) => ({ i, s: lesson.steps[i] }));
  const built = steps.filter((x) => x.s.type === 'build' && x.s.target);
  const exs = steps.filter((x) => stepKind(x.s) === 'exercise');
  const exOk = exs.filter((x) => exStatus(x.s.ex.id) === 'ok').length;
  const pending = steps.filter((x) => !stepDone(S, x.i));
  const review = exs.filter((x) => exStatus(x.s.ex.id) === 'review');
  const cmds = new Set();
  for (const x of steps) { for (const c of (x.s.cmds || (x.s.ex && x.s.ex.cmds) || [])) cmds.add(c); if (x.s.type === 'explain') for (const c of cellsOf(x.s)) for (const n of cmdsIn(S, c.code)) if ((lesson.commands || []).includes(n)) cmds.add(n); }
  const complete = !pending.length;
  safe(() => store.setLessonStep(lesson.id, tramo.steps[tramo.steps.length - 1], S.n));
  labelOf(wrap, complete ? 'Tramo terminado' : 'Fin del tramo');
  wrap.appendChild(h('h1', { class: 'lx-statement' }, tramo.title));
  const lines = h('ul', { class: 'ls-sum' });
  if (built.length) lines.appendChild(h('li', null, h('span', { class: 'ls-sum-l' }, 'Has construido'), h('span', { class: 'ls-sum-v' }, built.map((x) => h('code', null, x.s.target)))));
  else { const typed = steps.filter((x) => x.s.type === 'explain' && cellsOf(x.s).length); if (typed.length) lines.appendChild(h('li', null, h('span', { class: 'ls-sum-l' }, 'Has tecleado'), h('span', { class: 'ls-sum-v' }, typed.map((x) => stepTitle(x.s, x.i)).join(' · ')))); }
  if (cmds.size) lines.appendChild(h('li', null, h('span', { class: 'ls-sum-l' }, 'Comandos'), h('span', { class: 'ls-sum-v lp-end-chips' }, [...cmds].slice(0, 10).map(cmdChip))));
  if (exs.length) lines.appendChild(h('li', null, h('span', { class: 'ls-sum-l' }, 'Ejercicios'), h('span', { class: 'ls-sum-v' }, `${exOk} de ${exs.length} resueltos${review.length ? ` · ${review.length} para repetir` : ''}${S.sess.xp ? ` · +${S.sess.xp} XP` : ''}`)));
  wrap.appendChild(lines);
  if (pending.length) {
    const first = pending[0];
    wrap.appendChild(h('p', { class: 'ls-hint' }, `${pending.length} sin completar. `,
      h('button', { class: 'lx-link', type: 'button', onclick: () => { const p = S.screens.findIndex((s) => s.i === first.i); if (p >= 0) goScreen(S, p); } }, 'Ir al primero')));
  }
  const nextT = S.tramos[S.t + 1];
  const actions = h('div', { class: 'ls-actions' });
  if (nextT) actions.appendChild(h('a', { class: 'btn primary', href: `#/leccion/${encodeURIComponent(lesson.id)}/${nextT.steps[0]}` }, `Siguiente tramo: ${nextT.title} ›`));
  actions.appendChild(h('a', { class: nextT ? 'lx-link' : 'btn primary', href: `#/leccion/${encodeURIComponent(lesson.id)}` }, nextT ? 'Volver a la lista de tramos' : 'Volver a la lección ›'));
  wrap.appendChild(actions);
  S.nextBtn.hidden = true; S.skipBtn.hidden = true;
  S.screenCleanup.push(() => { if (S.nextBtn) S.nextBtn.hidden = false; });
  if (complete) play('ok');
  void done;
}

function unmount() {
  const me = S;
  if (!me) return;
  me.alive = false;
  S = null;
  safe(() => clearScreen(me));
  setImmersive(false);
  (me.cleanup || []).forEach((f) => safe(f));
  if (me.el) me.el.innerHTML = '';
}

// same lesson, another step (or the list) → no re-mount (the router calls update() when the view is already mounted)
function update(params) {
  const { id, paso } = parseParams(params);
  if (!S || !S.lesson || S.lesson.id !== id) return false;
  sync(S, paso);
  return true;
}

export default { mount, unmount, update };
