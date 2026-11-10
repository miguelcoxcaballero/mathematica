// views/leccion.js (LEARN) — lesson player.  #/leccion/<lessonId>[/<paso>]   (paso: 1-based)
import { store } from '../store.js';
import * as data from '../data.js';
import { kernel } from '../kernel-client.js';
import { createCell } from '../notebook.js';
import * as fx from '../fx.js';
import {
  mountExercise, ensureCss, h, md, mdInline, esc, codeBlock, yearBadge, yearOf, cmdChip, safe, play, exStatus,
  exclusive, kernelReady, startKernel, watchKernel, kernelPill, newSeed, levelOf,
} from '../exercise.js';

const KIND_ICON = { code: '⌨', fix: '🔧', fill: '▭', order: '⇅', mcq: '◉', predict: '?' };
const KIND_NAME = { code: 'Código', fix: 'Corregir', fill: 'Rellenar', order: 'Ordenar', mcq: 'Test', predict: 'Predecir' };

let S = null; // state of the mounted lesson

function parseParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  let id = p.lessonId || p.lesson || p.id;
  let paso = p.paso != null ? p.paso : p.step;
  if (!id) {
    const segs = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map((s) => safe(() => decodeURIComponent(s), s));
    if (segs[0] === 'leccion') { id = segs[1]; paso = segs[2]; }
  }
  const n = Number(paso);
  return { id, paso: Number.isFinite(n) && paso != null && paso !== '' ? n : null };
}

function typing(t) {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.cm-editor, [contenteditable="true"], [data-editor]'));
}

function stepTitle(step, i) {
  if (step.type === 'explain') return step.title || `Explicación ${i + 1}`;
  const ex = step.ex || {};
  return ex.title || `${KIND_NAME[ex.kind] || 'Ejercicio'}`;
}

function stepStatus(S, i) {
  const step = S.lesson.steps[i];
  if (step.type === 'explain') return S.visited.has(i) || i <= S.maxSeen ? 'seen' : 'todo';
  return exStatus(step.ex && step.ex.id);
}

async function mount(el, params) {
  ensureCss();
  const { id, paso } = parseParams(params);
  const me = (S = { el, id, alive: true, cleanup: [], stepCleanup: [] });
  el.innerHTML = '';
  const root = h('div', { class: 'lp lp--loading' }, h('div', { class: 'lx-loading' }, h('i', { class: 'lx-spin' }), 'Cargando lección…'));
  el.appendChild(root);
  me.root = root;

  let lesson = null;
  try { lesson = await data.loadLesson(id); } catch (e) { lesson = null; }
  if (!me.alive || S !== me) return;
  if (!lesson || !Array.isArray(lesson.steps) || !lesson.steps.length) {
    root.className = 'lp';
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'lx-empty card' },
      h('div', { class: 'lx-empty-ic' }, '🛠'),
      h('h2', null, 'Esta lección aún no está publicada'),
      h('p', { class: 'muted' }, `No se ha encontrado el contenido de “${id || ''}”. Puede que todavía se esté escribiendo.`),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/indice' }, 'Ir al índice'), h('a', { class: 'btn', href: '#/practica' }, 'Practicar lo que ya sé'))));
    return;
  }
  const n = lesson.steps.length;
  const year = yearOf(lesson);
  const saved = safe(() => store.state.lesson[lesson.id], null);
  Object.assign(me, {
    lesson, n, year,
    visited: new Set(),
    maxSeen: saved ? Math.max(saved.max ?? -1, saved.step ?? -1) : -1,
    seeds: new Map(),
    sess: { xp: 0, results: new Map(), startXp: safe(() => store.state.xp, 0) || 0, t0: Date.now() },
    idx: -1, widget: null, seenMarks: new Set(),
  });
  let idx = 0;
  if (paso != null) idx = Math.max(0, Math.min(n, Math.round(paso) - 1));
  else if (saved && !saved.done && Number.isFinite(saved.step)) idx = Math.max(0, Math.min(n - 1, saved.step));

  /* ---------- skeleton ---------- */
  root.className = 'lp';
  if (year) root.dataset.year = year;
  root.innerHTML = '';
  const crumbs = h('div', { class: 'lp-crumbs' }, yearBadge(year), h('span', { class: 'lp-crumb-t' }, [lesson.subject, lesson.block].filter(Boolean).join(' · ')));
  const title = h('h1', { class: 'lp-title' }, lesson.title || lesson.id);
  const xpEl = h('span', { class: 'lp-xp', title: 'XP ganado en esta sesión' }, '+0 XP');
  const tocBtn = h('button', { class: 'btn ghost lp-toc-btn', type: 'button', 'aria-expanded': 'false', title: 'Lista de pasos' }, h('span', { 'aria-hidden': 'true' }, '☰'), h('span', { class: 'lp-toc-l' }, 'Pasos'));
  const bar = h('i');
  const count = h('span', { class: 'lp-count' });
  const dots = h('nav', { class: 'lp-dots', 'aria-label': 'Pasos de la lección' });
  const head = h('header', { class: 'lp-head' },
    h('div', { class: 'lp-top' },
      h('a', { class: 'lp-back', href: '#/indice', title: 'Volver al índice', 'aria-label': 'Volver al índice' }, '‹'),
      h('div', { class: 'lp-titles' }, crumbs, title),
      xpEl, tocBtn),
    h('div', { class: 'lp-prog' }, h('div', { class: `progress${year ? ' y' + year : ''}` }, bar), count),
    dots);
  const side = h('aside', { class: 'lp-side', 'aria-label': 'Pasos' });
  const sideList = h('ol', { class: 'lp-steps' });
  side.append(h('div', { class: 'lp-side-h' }, h('strong', null, 'Pasos'), h('button', { class: 'lp-side-x', type: 'button', 'aria-label': 'Cerrar' }, '×')), sideList);
  const scrim = h('div', { class: 'lp-scrim' });
  const stage = h('section', { class: 'lp-stage' });
  const prevBtn = h('button', { class: 'btn ghost lp-prev', type: 'button' }, '← Anterior');
  const nextBtn = h('button', { class: 'btn primary lp-next', type: 'button' }, 'Siguiente →');
  const navHint = h('span', { class: 'lp-nav-hint muted' });
  const nav = h('footer', { class: 'lp-nav' }, prevBtn, navHint, nextBtn);
  const main = h('div', { class: 'lp-main' }, stage);
  root.append(head, main, nav);
  if (year) side.dataset.year = year;
  Object.assign(me, { stage, bar, count, dots, sideList, prevBtn, nextBtn, navHint, xpEl, side, tocBtn });
  // The step list is a docked column on wide screens and a drawer otherwise. The drawer lives in <body>:
  // the shell animates the view container with a transform, which would capture position:fixed descendants.
  const mq = window.matchMedia('(min-width: 1380px)');
  const placeSide = () => {
    side.classList.remove('is-open'); scrim.classList.remove('is-open'); tocBtn.setAttribute('aria-expanded', 'false');
    if (mq.matches) { scrim.remove(); main.insertBefore(side, stage); side.classList.add('is-docked'); } else { side.classList.remove('is-docked'); document.body.append(scrim, side); }
  };
  placeSide();
  safe(() => mq.addEventListener('change', placeSide));
  me.cleanup.push(() => { safe(() => mq.removeEventListener('change', placeSide)); side.remove(); scrim.remove(); });

  // step list + dots
  let exN = 0;
  lesson.steps.forEach((step, i) => {
    const isEx = step.type === 'exercise';
    if (isEx) exN++;
    const ex = step.ex || {};
    const d = h('button', { class: `lp-dot ${isEx ? 'is-ex' : 'is-exp'}${ex.real ? ' is-real' : ''}`, type: 'button', title: `${i + 1}. ${stepTitle(step, i)}`, 'aria-label': `Paso ${i + 1}: ${stepTitle(step, i)}`, dataset: { i } });
    dots.appendChild(d);
    const li = h('li', null, h('button', { class: 'lp-stepbtn', type: 'button', dataset: { i } },
      h('span', { class: 'lp-step-ic', 'aria-hidden': 'true' }, isEx ? (KIND_ICON[ex.kind] || '✎') : '📖'),
      h('span', { class: 'lp-step-t' }, h('span', { class: 'lp-step-name' }, stepTitle(step, i)), h('small', null, isEx ? `Ejercicio ${exN}${ex.real ? ' · REAL' : ''}` : 'Explicación')),
      h('span', { class: 'lp-step-st', 'aria-hidden': 'true' })));
    sideList.appendChild(li);
  });
  me.exTotal = exN;
  const endDot = h('button', { class: 'lp-dot is-end', type: 'button', title: 'Resumen de la lección', 'aria-label': 'Resumen', dataset: { i: n } });
  dots.appendChild(endDot);
  sideList.appendChild(h('li', null, h('button', { class: 'lp-stepbtn is-end', type: 'button', dataset: { i: n } }, h('span', { class: 'lp-step-ic' }, '🏁'), h('span', { class: 'lp-step-t' }, h('span', { class: 'lp-step-name' }, 'Resumen'), h('small', null, 'Qué has aprendido')), h('span', { class: 'lp-step-st' }))));

  const closeToc = () => { side.classList.remove('is-open'); scrim.classList.remove('is-open'); tocBtn.setAttribute('aria-expanded', 'false'); };
  const onPick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; closeToc(); go(+b.dataset.i); };
  dots.addEventListener('click', onPick);
  sideList.addEventListener('click', onPick);
  tocBtn.addEventListener('click', () => { const open = side.classList.toggle('is-open'); scrim.classList.toggle('is-open', open); tocBtn.setAttribute('aria-expanded', String(open)); });
  scrim.addEventListener('click', closeToc);
  side.querySelector('.lp-side-x').addEventListener('click', closeToc);
  prevBtn.addEventListener('click', () => go(me.idx - 1));
  nextBtn.addEventListener('click', () => { if (me.idx >= n) return; go(me.idx + 1); });

  const onKey = (e) => {
    if (S !== me || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && side.classList.contains('is-open')) { closeToc(); return; }
    if (typing(e.target) || document.querySelector('.fx-level, dialog[open]')) return;
    if (e.target instanceof HTMLElement && e.target.closest('.ex-order')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (me.idx < n) go(me.idx + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); if (me.idx > 0) go(me.idx - 1); }
  };
  document.addEventListener('keydown', onKey);
  me.cleanup.push(() => document.removeEventListener('keydown', onKey));
  me.cleanup.push(safe(() => store.on(() => { if (S === me) refreshStatus(me); }), null) || (() => {}));

  // warm the engine: almost every step needs it
  if (kernel.status === 'idle') startKernel();
  if (typeof data.loadCommands === 'function') data.loadCommands().then((c) => { me.allCmds = ((c && c.commands) || []).map((x) => x.name); }).catch(() => {});
  // course (for "next lesson" and the practice label) — not blocking
  data.loadCourse().then((course) => {
    if (S !== me) return;
    me.course = course;
    const units = flatUnits(course);
    const k = units.findIndex((u) => u.lesson === lesson.id);
    if (k >= 0) {
      me.unit = units[k];
      me.nextUnit = units.slice(k + 1).find((u) => u.lesson) || null;
      if (me.unit.practice && !crumbs.querySelector('.lp-crumb-p')) crumbs.appendChild(h('span', { class: 'lp-crumb-p' }, me.unit.practice));
      if (me.idx >= n) renderStep(me, 0);
    }
  }).catch(() => {});

  go(idx, 0, true);

  function go(i, dir, first) {
    if (S !== me) return;
    i = Math.max(0, Math.min(n, i));
    if (i === me.idx && !first) return;
    const d = dir != null ? dir : i > me.idx ? 1 : -1;
    me.idx = i;
    if (i < n) {
      me.visited.add(i);
      me.maxSeen = Math.max(me.maxSeen, i);
      safe(() => store.setLessonStep(lesson.id, i, n));
    } else {
      me.maxSeen = Math.max(me.maxSeen, n - 1);
      safe(() => store.setLessonStep(lesson.id, n - 1, n));
    }
    // keep the URL in sync without re-mounting the view
    const want = `#/leccion/${encodeURIComponent(lesson.id)}/${i + 1}`;
    if (location.hash !== want) safe(() => history.replaceState(history.state, '', want));
    renderStep(me, d);
    if (!first) {
      const top = root.getBoundingClientRect().top + window.scrollY - 70;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    }
  }
  me.go = go;
}

function flatUnits(course) {
  if (typeof data.flatUnits === 'function') { const r = safe(() => data.flatUnits(course), null); if (r) return r; }
  const out = [];
  for (const y of (course && course.years) || []) for (const s of y.subjects || []) for (const b of s.blocks || []) for (const u of b.units || []) out.push({ ...u, year: y.year, subject: s.name, block: b.name });
  return out;
}

function refreshStatus(S) {
  const { lesson, n } = S;
  const dots = S.dots.children, items = S.sideList.querySelectorAll('.lp-stepbtn');
  let okEx = 0;
  for (let i = 0; i < n; i++) {
    const st = stepStatus(S, i);
    if (lesson.steps[i].type === 'exercise' && st === 'ok') okEx++;
    for (const el of [dots[i], items[i]]) {
      if (!el) continue;
      el.dataset.st = st;
      el.classList.toggle('is-cur', i === S.idx);
      if (i === S.idx) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    }
    const mark = items[i] && items[i].querySelector('.lp-step-st');
    if (mark) mark.textContent = st === 'ok' ? '✓' : st === 'review' ? '↻' : st === 'tried' ? '•' : '';
  }
  for (const el of [dots[n], items[n]]) if (el) el.classList.toggle('is-cur', S.idx === n);
  S.okEx = okEx;
  const pos = Math.min(S.idx + 1, n);
  S.bar.style.width = `${Math.round(100 * (S.idx >= n ? 1 : pos / (n + 1)))}%`;
  S.count.textContent = S.idx >= n ? 'Resumen' : `${pos} / ${n}`;
  S.xpEl.textContent = `+${S.sess.xp} XP`;
  S.xpEl.classList.toggle('has', S.sess.xp > 0);
  const cur = S.dots.querySelector('.is-cur');
  if (cur && S.dots.scrollWidth > S.dots.clientWidth) S.dots.scrollLeft = cur.offsetLeft - S.dots.clientWidth / 2;
}

function clearStep(S) {
  S.stepCleanup.forEach((f) => safe(f));
  S.stepCleanup = [];
  if (S.widget) { safe(() => S.widget.destroy()); S.widget = null; }
}

function renderStep(S, dir) {
  clearStep(S);
  const { lesson, n, stage } = S;
  const i = S.idx;
  const wrap = h('div', { class: `lp-step ${dir > 0 ? 'lp-in-r' : dir < 0 ? 'lp-in-l' : 'lp-in'}` });
  stage.replaceChildren(wrap);
  S.prevBtn.disabled = i <= 0;
  S.nextBtn.hidden = i >= n;
  S.root.classList.toggle('lp--end', i >= n);
  S.navHint.textContent = '';
  if (i >= n) { renderEnd(S, wrap); refreshStatus(S); return; }
  const step = lesson.steps[i];
  const last = i === n - 1;
  const setNext = (done, isEx) => {
    S.nextBtn.textContent = last ? (done || !isEx ? 'Terminar lección ✓' : 'Ir al resumen →') : (done || !isEx ? 'Siguiente →' : 'Saltar →');
    S.nextBtn.classList.toggle('primary', !!done || !isEx);
    S.nextBtn.classList.toggle('ghost', !done && !!isEx);
    S.nextBtn.classList.toggle('lx-pulse', !!done && !!isEx);
  };
  if (step.type === 'explain') {
    setNext(true, false);
    renderExplain(S, wrap, step, i);
  } else {
    const ex = step.ex || {};
    const exNo = lesson.steps.slice(0, i + 1).filter((s) => s.type === 'exercise').length;
    wrap.appendChild(h('div', { class: 'lp-kicker' }, `Ejercicio ${exNo} de ${S.exTotal}`, ex.real ? h('span', { class: 'lp-kicker-real' }, ' · de práctica/examen real') : null));
    const host = h('div', { class: 'lp-exhost' });
    wrap.appendChild(host);
    if (!S.seeds.has(i)) S.seeds.set(i, newSeed());
    const prev = S.sess.results.get(ex.id);
    setNext(false, true);
    S.widget = mountExercise(host, ex, {
      mode: 'lesson', seed: S.seeds.get(i), year: S.year, lesson, hotkeys: true,
      onDone: (res) => {
        S.sess.results.set(ex.id, res);
        if (res.xp) S.sess.xp += res.xp;
        setNext(true, true);
        refreshStatus(S);
        if (res.ok || res.revealed) {
          S.navHint.textContent = res.ok ? 'Pulsa Enter o → para seguir' : '';
          if (res.ok) setTimeout(() => { if (S.idx === i && !typingNow()) S.nextBtn.focus({ preventScroll: true }); }, 60);
        }
      },
    });
    if (prev && (prev.ok || prev.revealed)) setNext(true, true);
    else if (exStatus(ex.id) === 'ok') { setNext(true, true); S.nextBtn.classList.remove('lx-pulse'); }
  }
  refreshStatus(S);
}

function typingNow() {
  const a = document.activeElement;
  return a && a !== document.body && typing(a) && !(a.closest && a.closest('.ex[data-state="ok"]'));
}

/* ---------- explain step ---------- */
function cmdsIn(S, code) {
  const names = new Set([...(S.lesson.commands || []), ...(S.lesson.uses || [])]);
  if (S.allCmds) for (const c of S.allCmds) names.add(c);
  const found = new Set();
  for (const m of String(code).replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/[A-Z][A-Za-z0-9]*/g)) if (names.has(m[0])) found.add(m[0]);
  return [...found];
}

function renderExplain(S, wrap, step, i) {
  wrap.classList.add('lp-explain');
  wrap.appendChild(h('div', { class: 'lp-kicker' }, i === 0 ? 'Empezamos' : 'Explicación'));
  if (step.title) wrap.appendChild(h('h2', { class: 'lp-h' }, step.title));
  wrap.appendChild(h('div', { class: 'lp-md lx-md', html: md(step.md || '') }));
  const cells = Array.isArray(step.cells) ? step.cells.filter((c) => c && typeof c.code === 'string') : [];
  if (!cells.length) return;
  const box = h('div', { class: 'lp-cells' });
  wrap.appendChild(box);
  let alive = true;
  S.stepCleanup.push(() => { alive = false; });
  let fresh = true; // the first evaluation of this visit starts from a clean session
  const recs = cells.map((c, k) => {
    const auto = c.run !== false;
    const status = h('span', { class: 'lp-cell-st', 'aria-live': 'polite' });
    const runBtn = h('button', { class: 'btn lp-run', type: 'button', title: 'Evaluar la celda (Shift+Enter)', 'data-nosfx': '' }, h('span', { 'aria-hidden': 'true' }, '▶'), h('span', null, 'Ejecutar'));
    const host = h('div', { class: 'lp-cell-host' });
    const note = h('div', { class: 'lp-cell-note lx-md', html: c.note ? mdInline(c.note) : (auto ? '' : 'Pruébala tú') });
    const row = h('div', { class: `lp-cell${auto ? '' : ' lp-cell--manual'}` }, h('div', { class: 'lp-cell-bar' }, h('span', { class: 'lp-cell-n' }, `${k + 1}`), note, status, runBtn), host);
    box.appendChild(row);
    const rec = { c, k, auto, ran: false, running: false, row, status, runBtn, cell: null };
    try {
      rec.cell = createCell(host, {
        code: c.code,
        onResult: (code) => {
          rec.ran = true;
          row.classList.add('is-ran');
          for (const name of cmdsIn(S, code)) { const key = `${i}:${name}`; if (!S.seenMarks.has(key)) { S.seenMarks.add(key); safe(() => store.markSeen(name)); } }
        },
      });
    } catch (e) { console.error('[learn] createCell', e); host.appendChild(codeBlock(c.code, 'lx-paper')); runBtn.hidden = true; }
    return rec;
  });
  // evaluates cell k (and, the first time, every earlier cell of the step, like "evaluate from the top")
  const run = (k) => exclusive(async () => {
    if (!alive) return;
    if (fresh) { fresh = false; await kernel.reset(); }
    const todo = recs.filter((r) => r.cell && (r.k === k || (r.k < k && !r.ran && r.auto)));
    for (const r of todo) {
      if (!alive) return;
      r.running = true; r.row.classList.add('is-running'); r.runBtn.disabled = true; r.status.innerHTML = '<i class="lx-spin"></i>';
      try { await r.cell.run(); r.ran = true; r.row.classList.add('is-ran'); } catch (e) { console.warn('[learn] cell.run', e); }
      r.running = false; r.row.classList.remove('is-running'); r.runBtn.disabled = false; r.status.textContent = '';
    }
  }).catch((e) => console.warn('[learn]', e));
  recs.forEach((r) => {
    r.runBtn.addEventListener('click', () => { play('click'); run(r.k); });
    // Shift+Enter inside the cell goes through the same path (so earlier cells are evaluated first)
    r.row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); run(r.k); } }, true);
  });
  wrap.appendChild(h('p', { class: 'lp-tryit muted' }, 'Las celdas son tuyas: cambia números o funciones y vuelve a ejecutar. No puedes romper nada.'));
  // auto-evaluate when the engine is ready, so the outputs appear as in a real notebook
  const autos = recs.filter((r) => r.auto && r.cell);
  if (autos.length) {
    const lastAuto = autos[autos.length - 1].k;
    const pill = kernelPill();
    S.stepCleanup.push(pill.destroy);
    box.insertBefore(h('div', { class: 'lp-cells-k' }, pill.el), box.firstChild);
    let started = false;
    const off = watchKernel((status) => {
      if (started || !alive) return;
      if (status === 'ready' || status === 'busy') { started = true; setTimeout(() => { if (alive) run(lastAuto); }, 120); }
    });
    S.stepCleanup.push(off);
  }
  // seeing the explanation counts as "seen" for the commands of its cells
  for (const c of cells) for (const name of cmdsIn(S, c.code)) { const key = `${i}:${name}`; if (!S.seenMarks.has(key)) { S.seenMarks.add(key); safe(() => store.markSeen(name)); } }
}

/* ---------- end of lesson ---------- */
function renderEnd(S, wrap) {
  const { lesson, n } = S;
  wrap.classList.add('lp-end');
  const exSteps = lesson.steps.map((s, i) => ({ s, i })).filter((x) => x.s.type === 'exercise' && x.s.ex);
  const total = exSteps.length;
  const ok = exSteps.filter((x) => exStatus(x.s.ex.id) === 'ok').length;
  const weak = exSteps.filter((x) => {
    const st = exStatus(x.s.ex.id);
    const r = S.sess.results.get(x.s.ex.id);
    return st !== 'ok' || (r && (r.fails >= 2 || r.revealed));
  });
  const first = [...S.sess.results.values()].filter((r) => r.firstTry).length;
  const complete = ok === total;
  const done = safe(() => store.state.lesson[lesson.id] && store.state.lesson[lesson.id].done, false);
  if (complete && !done) safe(() => (store.completeLesson ? store.completeLesson(lesson.id) : store.set(`lesson.${lesson.id}.done`, true)));
  const xpNow = safe(() => store.state.xp, 0) || 0;
  const lvl0 = levelOf(S.sess.startXp), lvl1 = levelOf(xpNow);

  const pct = total ? ok / total : 1;
  const ringEl = typeof fx.ring === 'function'
    ? safe(() => fx.ring({ pct, size: 132, stroke: 11, color: complete ? 'var(--ok)' : 'var(--accent)', color2: 'var(--accent-2)', label: `${ok}/${total}`, sub: 'ejercicios' }), null)
    : null;
  wrap.appendChild(h('div', { class: `lp-end-hero card${complete ? ' is-complete' : ''}` },
    ringEl || h('div', { class: 'lp-end-big' }, `${ok}/${total}`),
    h('div', { class: 'lp-end-txt' },
      h('div', { class: 'lp-kicker' }, complete ? 'Lección completada' : 'Has llegado al final'),
      h('h2', null, complete ? `🏁 ${lesson.title}` : `Te ${total - ok === 1 ? 'queda 1 ejercicio' : `quedan ${total - ok} ejercicios`} para completarla`),
      h('p', { class: 'muted' }, complete ? 'Todos los ejercicios resueltos. Lo que acabas de practicar es lo que cae en la práctica y en el examen.' : 'La lección se da por completada cuando resuelves todos sus ejercicios. Abajo tienes los pendientes.'),
      h('div', { class: 'lp-end-stats' },
        stat(`+${S.sess.xp}`, 'XP en esta sesión'),
        stat(String(first), 'a la primera'),
        lvl1 > lvl0 ? stat(`Nv ${lvl1}`, '¡has subido de nivel!') : stat(`Nv ${lvl1}`, 'tu nivel')))));

  const cmds = [...new Set([...(lesson.commands || [])])];
  const uses = [...new Set((lesson.uses || []).filter((c) => !cmds.includes(c)))];
  if (cmds.length || uses.length) {
    wrap.appendChild(h('div', { class: 'card lp-end-card' },
      h('h3', null, 'Comandos de esta lección'),
      cmds.length ? h('div', { class: 'lp-end-chips' }, cmds.map(cmdChip)) : null,
      uses.length ? h('div', { class: 'lp-end-uses' }, h('span', { class: 'muted' }, 'También has usado: '), uses.map(cmdChip)) : null,
      h('p', { class: 'muted lp-legend' }, h('span', { class: 'chip l1' }, 'visto'), h('span', { class: 'chip l2' }, 'en práctica'), h('span', { class: 'chip l3' }, 'dominado'), ' Un comando se domina al acertar 3 ejercicios que lo usan.')));
  }
  if (weak.length) {
    const list = h('ul', { class: 'lp-weak' });
    for (const x of weak) {
      const st = exStatus(x.s.ex.id);
      const label = st === 'review' ? 'viste la solución' : st === 'ok' ? 'te costó' : st === 'tried' ? 'sin resolver' : 'sin hacer';
      list.appendChild(h('li', null,
        h('span', { class: `lp-weak-st st-${st}` }, st === 'ok' ? '✓' : st === 'review' ? '↻' : '○'),
        h('span', { class: 'lp-weak-t' }, stepTitle(x.s, x.i), h('small', { class: 'muted' }, ` · ${label}`)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => S.go(x.i) }, st === 'ok' ? 'Repasar' : 'Hacer ahora')));
    }
    wrap.appendChild(h('div', { class: 'card lp-end-card' }, h('h3', null, complete ? 'Puntos a reforzar' : 'Pendientes y puntos débiles'), list));
  }
  const actions = h('div', { class: 'lp-end-actions' });
  if (!complete && weak.length) actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: () => S.go(weak[0].i) }, 'Resolver los pendientes'));
  actions.appendChild(h('a', { class: `btn${complete ? '' : ' ghost'}`, href: `#/practica/tema/${encodeURIComponent(lesson.id)}` }, '⚡ Practicar estos comandos'));
  const nextSlot = h('span', { class: 'lp-next-slot' });
  actions.appendChild(nextSlot);
  actions.appendChild(h('a', { class: 'btn ghost', href: '#/indice' }, 'Volver al índice'));
  actions.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => S.go(0) }, '↺ Repasar desde el principio'));
  wrap.appendChild(actions);
  if (S.nextUnit) {
    const u = S.nextUnit;
    const a = h('a', { class: `btn${complete ? ' primary' : ''}`, href: `#/leccion/${encodeURIComponent(u.lesson)}` }, `Siguiente lección: ${u.title || u.practice || u.lesson} →`);
    nextSlot.appendChild(a);
    // hide the link if that lesson is not published yet
    data.loadLesson(u.lesson).catch(() => { a.replaceWith(h('span', { class: 'muted lp-next-soon' }, `Siguiente (${u.practice || u.title}): en preparación`)); });
  }

  if (!S.endShown) {
    S.endShown = true;
    if (complete) {
      play('unlock');
      safe(() => fx.confetti({ y: 0.35, count: 160, power: 1.1 }));
      setTimeout(() => safe(() => fx.confetti({ x: 0.2, y: 0.55, count: 50 })), 260);
      setTimeout(() => safe(() => fx.confetti({ x: 0.8, y: 0.55, count: 50 })), 380);
    } else play('click');
  }
}

function stat(v, l) { return h('div', { class: 'lx-stat' }, h('b', null, v), h('span', null, l)); }

function unmount() {
  const me = S;
  if (!me) return;
  me.alive = false;
  S = null;
  safe(() => clearStep(me));
  (me.cleanup || []).forEach((f) => safe(f));
  if (me.el) me.el.innerHTML = '';
}

// same lesson, another step → move without re-mounting (router calls update() when the view is already mounted)
function update(params) {
  const { id, paso } = parseParams(params);
  if (!S || !S.lesson || S.lesson.id !== id) return false;
  if (paso != null) S.go(Math.round(paso) - 1);
  return true;
}

export default { mount, unmount, update };
