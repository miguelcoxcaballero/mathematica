// views/leccion.js (LEARN) — lesson player.  #/leccion/<lessonId>[/<paso>]
// <paso> is the 0-based step index (the number the store keeps in state.lesson[id].step and SHELL's lessonHref uses).
// SPEC §11/§12: the page reads like Wolfram's "Fast Introduction": gray list of steps on the left (active one in red),
// white content column, thin red title, short text and In/Out cells. Every cell of an explanation is a GHOST cell the
// student types; exercises are empty cells checked by the kernel. A step is complete when everything is typed/solved.
import { store } from '../store.js';
import * as data from '../data.js';
import { kernel } from '../kernel-client.js';
import { createCell } from '../notebook.js';
import * as fx from '../fx.js';
import {
  mountExercise, mountGhost, exerciseMode, ensureCss, h, md, mdInline, codeBlock, yearBadge, yearOf, cmdChip, safe, play, exStatus,
  exclusive, startKernel, watchKernel, kernelPill, newSeed, levelOf,
} from '../exercise.js';

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

function stepKind(step) {
  if (step.type === 'explain') return 'explain';
  const m = exerciseMode(step.ex || {});
  return m === 'code' ? 'exercise' : m; // 'exercise' | 'ghost' | 'note'
}
function stepTitle(step, i) {
  if (step.type === 'explain') return step.title || `Paso ${i + 1}`;
  const ex = step.ex || {};
  return ex.title || (stepKind(step) === 'exercise' ? 'Ejercicio' : stepKind(step) === 'note' ? 'Nota' : 'Teclea y observa');
}
const typedMap = (S) => safe(() => (store.state.lesson[S.lesson.id] || {}).typed, null) || {};
function stepStatus(S, i) {
  const step = S.lesson.steps[i];
  if (step.type === 'explain') return typedMap(S)[i] ? 'ok' : S.visited.has(i) || i <= S.maxSeen ? 'seen' : 'todo';
  const st = exStatus(step.ex && step.ex.id);
  if (stepKind(step) !== 'exercise') return st === 'ok' ? 'ok' : S.visited.has(i) || i <= S.maxSeen ? 'seen' : 'todo';
  return st;
}
const stepDone = (S, i) => { const st = stepStatus(S, i); return st === 'ok' || st === 'review'; };

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
    root.appendChild(h('div', { class: 'lx-empty' },
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
  if (paso != null) idx = Math.max(0, Math.min(n, Math.round(paso)));
  else if (saved && !saved.done && Number.isFinite(saved.step)) idx = Math.max(0, Math.min(n - 1, saved.step));

  /* ---------- skeleton ---------- */
  root.className = 'lp';
  if (year) root.dataset.year = year;
  root.innerHTML = '';
  const crumbT = h('span', { class: 'lp-crumb-t' }, [lesson.subject, lesson.block].filter(Boolean).join(' · '));
  const crumbs = h('div', { class: 'lp-crumbs' }, yearBadge(year), crumbT, h('span', { class: 'lp-crumb-l' }, lesson.title || lesson.id));
  const xpEl = h('span', { class: 'lp-xp', title: 'XP ganado en esta sesión' }, '');
  const tocBtn = h('button', { class: 'lx-link lp-toc-btn', type: 'button', 'aria-expanded': 'false', title: 'Lista de pasos' }, 'Pasos');
  const count = h('span', { class: 'lp-count' });
  const dots = h('nav', { class: 'lp-dots', 'aria-label': 'Pasos de la lección' });
  const head = h('header', { class: 'lp-head' }, h('div', { class: 'lp-top' }, crumbs, xpEl, tocBtn), h('div', { class: 'lp-prog' }, dots, count));

  const side = h('aside', { class: 'lp-side', 'aria-label': 'Pasos de la lección' });
  const sideList = h('ol', { class: 'lp-steps' });
  const sideSub = h('span', { class: 'lp-side-sub' }, '');
  side.append(
    h('div', { class: 'lp-side-h' },
      h('a', { class: 'lp-back', href: '#/indice', title: 'Volver al índice' }, '← Índice'),
      h('button', { class: 'lp-side-x', type: 'button', 'aria-label': 'Cerrar' }, '×')),
    h('div', { class: 'lp-side-lesson' }, sideSub, h('strong', null, lesson.title || lesson.id)),
    sideList);
  const scrim = h('div', { class: 'lp-scrim' });
  const stage = h('section', { class: 'lp-stage' });
  const prevBtn = h('button', { class: 'btn ghost lp-prev', type: 'button' }, '‹ Anterior');
  const skipBtn = h('button', { class: 'lx-link lp-skip', type: 'button', title: 'Pasar al siguiente sin completar este paso' }, 'saltar');
  const nextBtn = h('button', { class: 'btn primary lp-next', type: 'button' }, 'Siguiente ›');
  const navHint = h('span', { class: 'lp-nav-hint' });
  const nav = h('footer', { class: 'lp-nav' }, prevBtn, navHint, skipBtn, nextBtn);
  const col = h('div', { class: 'lp-col' }, head, stage, nav);
  root.append(col);
  if (year) side.dataset.year = year;
  Object.assign(me, { stage, count, dots, sideList, prevBtn, nextBtn, skipBtn, navHint, xpEl, side, tocBtn });
  // The step list is a docked column on wide screens and a drawer otherwise. The drawer lives in <body>:
  // the shell animates the view container with a transform, which would capture position:fixed descendants.
  const mq = window.matchMedia('(min-width: 1180px)');
  const placeSide = () => {
    side.classList.remove('is-open'); scrim.classList.remove('is-open'); tocBtn.setAttribute('aria-expanded', 'false');
    if (mq.matches) { scrim.remove(); root.insertBefore(side, col); side.classList.add('is-docked'); root.classList.add('lp--docked'); } else { side.classList.remove('is-docked'); root.classList.remove('lp--docked'); document.body.append(scrim, side); }
  };
  placeSide();
  safe(() => mq.addEventListener('change', placeSide));
  me.cleanup.push(() => { safe(() => mq.removeEventListener('change', placeSide)); side.remove(); scrim.remove(); });

  // step list + thin progress segments
  let exN = 0;
  me.exNo = [];
  lesson.steps.forEach((step, i) => {
    const kind = stepKind(step);
    if (kind === 'exercise') exN++;
    me.exNo[i] = exN;
    const ex = step.ex || {};
    dots.appendChild(h('button', { class: 'lp-dot', type: 'button', title: `${i + 1}. ${stepTitle(step, i)}`, 'aria-label': `Paso ${i + 1}: ${stepTitle(step, i)}`, dataset: { i } }));
    sideList.appendChild(h('li', null, h('button', { class: `lp-stepbtn is-${kind}`, type: 'button', dataset: { i } },
      h('span', { class: 'lp-step-name' }, stepTitle(step, i)),
      kind === 'exercise' ? h('span', { class: 'lp-step-k' }, ex.real ? 'real' : 'ejercicio') : null,
      h('span', { class: 'lp-step-st', 'aria-hidden': 'true' }))));
  });
  me.exTotal = exN;
  dots.appendChild(h('button', { class: 'lp-dot is-end', type: 'button', title: 'Resumen de la lección', 'aria-label': 'Resumen', dataset: { i: n } }));
  sideList.appendChild(h('li', null, h('button', { class: 'lp-stepbtn is-end', type: 'button', dataset: { i: n } }, h('span', { class: 'lp-step-name' }, 'Resumen'), h('span', { class: 'lp-step-st' }))));

  const closeToc = () => { side.classList.remove('is-open'); scrim.classList.remove('is-open'); tocBtn.setAttribute('aria-expanded', 'false'); };
  const onPick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; closeToc(); go(+b.dataset.i); };
  dots.addEventListener('click', onPick);
  sideList.addEventListener('click', onPick);
  tocBtn.addEventListener('click', () => { const open = side.classList.toggle('is-open'); scrim.classList.toggle('is-open', open); tocBtn.setAttribute('aria-expanded', String(open)); });
  scrim.addEventListener('click', closeToc);
  side.querySelector('.lp-side-x').addEventListener('click', closeToc);
  prevBtn.addEventListener('click', () => go(me.idx - 1));
  nextBtn.addEventListener('click', () => { if (me.idx < n && !nextBtn.disabled) go(me.idx + 1); });
  skipBtn.addEventListener('click', () => { if (me.idx < n) go(me.idx + 1); });

  const onKey = (e) => {
    if (S !== me || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && side.classList.contains('is-open')) { closeToc(); return; }
    if (typing(e.target) || document.querySelector('.fx-level, dialog[open]')) return;
    if (e.key === 'ArrowRight') { if (me.idx < n && !nextBtn.disabled) { e.preventDefault(); go(me.idx + 1); } } else if (e.key === 'ArrowLeft') { if (me.idx > 0) { e.preventDefault(); go(me.idx - 1); } }
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
    const units = flatUnits(course);
    const k = units.findIndex((u) => u.lesson === lesson.id);
    if (k >= 0) {
      me.unit = units[k];
      me.nextUnit = units.slice(k + 1).find((u) => u.lesson) || null;
      if (me.unit.practice) { sideSub.textContent = me.unit.practice; crumbT.textContent = [lesson.subject, me.unit.practice].filter(Boolean).join(' · '); }
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
    me.visited.add(Math.min(i, n - 1));
    me.maxSeen = Math.max(me.maxSeen, Math.min(i, n - 1));
    safe(() => store.setLessonStep(lesson.id, Math.min(i, n - 1), n));
    // keep the URL in sync without re-mounting the view
    const want = `#/leccion/${encodeURIComponent(lesson.id)}/${i}`;
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
  const { n } = S;
  const dots = S.dots.children, items = S.sideList.querySelectorAll('.lp-stepbtn');
  for (let i = 0; i < n; i++) {
    const st = stepStatus(S, i);
    for (const el of [dots[i], items[i]]) {
      if (!el) continue;
      el.dataset.st = st;
      el.classList.toggle('is-cur', i === S.idx);
      if (i === S.idx) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    }
    const mark = items[i] && items[i].querySelector('.lp-step-st');
    if (mark) mark.textContent = st === 'ok' ? '✓' : st === 'review' ? '↻' : st === 'tried' ? '·' : '';
  }
  for (const el of [dots[n], items[n]]) if (el) el.classList.toggle('is-cur', S.idx === n);
  S.count.textContent = S.idx >= n ? 'resumen' : `${S.idx + 1} / ${n}`;
  S.xpEl.textContent = S.sess.xp > 0 ? `+${S.sess.xp} XP` : '';
  const cur = S.sideList.querySelector('.is-cur');
  if (cur && S.side.classList.contains('is-docked') && S.sideList.scrollHeight > S.sideList.clientHeight) {
    const top = cur.offsetTop - S.sideList.offsetTop;
    if (top < S.sideList.scrollTop || top > S.sideList.scrollTop + S.sideList.clientHeight - 40) S.sideList.scrollTop = Math.max(0, top - 80);
  }
}

function clearStep(S) {
  S.stepCleanup.forEach((f) => safe(f));
  S.stepCleanup = [];
  if (S.widget) { safe(() => S.widget.destroy()); S.widget = null; }
}

/** Marks the current step as complete in the footer (primary "Siguiente", focus so Enter moves on). */
function setComplete(S, i, done, focus) {
  if (S.idx !== i) return;
  const last = i === S.n - 1;
  S.nextBtn.textContent = last ? 'Terminar lección ›' : 'Siguiente ›';
  S.nextBtn.disabled = !done;
  S.skipBtn.hidden = !!done;
  S.navHint.textContent = '';
  if (done && focus) {
    S.navHint.textContent = 'Enter para seguir';
    setTimeout(() => { if (S.idx === i && S.nextBtn.isConnected) S.nextBtn.focus({ preventScroll: true }); }, 80);
  }
}

function renderStep(S, dir) {
  clearStep(S);
  const { lesson, n, stage } = S;
  const i = S.idx;
  const wrap = h('div', { class: `lp-step ${dir > 0 ? 'lp-in-r' : dir < 0 ? 'lp-in-l' : 'lp-in'}` });
  stage.replaceChildren(wrap);
  S.prevBtn.disabled = i <= 0;
  S.nextBtn.hidden = i >= n;
  S.skipBtn.hidden = true;
  S.navHint.textContent = '';
  S.root.classList.toggle('lp--end', i >= n);
  if (i >= n) { renderEnd(S, wrap); refreshStatus(S); return; }
  const step = lesson.steps[i];
  const kind = stepKind(step);
  setComplete(S, i, stepDone(S, i), false);
  if (kind === 'explain') {
    renderExplain(S, wrap, step, i);
  } else {
    const ex = step.ex || {};
    wrap.appendChild(h('div', { class: 'lp-kicker' }, kind === 'exercise' ? `Ejercicio ${S.exNo[i]} de ${S.exTotal}` : kind === 'note' ? 'Nota' : 'Teclea y observa', ex.real ? h('span', { class: 'lp-kicker-real' }, ' · de práctica o examen real') : null));
    wrap.appendChild(h('h1', { class: 'lp-title' }, stepTitle(step, i)));
    const host = h('div', { class: 'lp-exhost' });
    wrap.appendChild(host);
    if (!S.seeds.has(i)) S.seeds.set(i, newSeed());
    S.widget = mountExercise(host, ex, {
      mode: 'lesson', seed: S.seeds.get(i), year: S.year, lesson, noTitle: true,
      onDone: (res) => {
        S.sess.results.set(ex.id, res);
        if (res.xp) S.sess.xp += res.xp;
        refreshStatus(S);
        setComplete(S, i, true, !res.note);
      },
    });
    if (kind !== 'note') setTimeout(() => { if (S.idx === i && S.widget && !stepDone(S, i)) safe(() => S.widget.focus()); }, 350);
  }
  refreshStatus(S);
}

/* ---------- explain step: text + cells that the student types (ghost) ---------- */
function cmdsIn(S, code) {
  const names = new Set([...(S.lesson.commands || []), ...(S.lesson.uses || [])]);
  if (S.allCmds) for (const c of S.allCmds) names.add(c);
  const found = new Set();
  for (const m of String(code).replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/[A-Z][A-Za-z0-9]*/g)) if (names.has(m[0])) found.add(m[0]);
  return [...found];
}

function renderExplain(S, wrap, step, i) {
  wrap.classList.add('lp-explain');
  wrap.appendChild(h('h1', { class: 'lp-title' }, stepTitle(step, i)));
  if (step.md) wrap.appendChild(h('div', { class: 'lp-md lx-md', html: md(step.md) }));
  const cells = Array.isArray(step.cells) ? step.cells.filter((c) => c && typeof c.code === 'string' && c.code.trim()) : [];
  const seen = (code) => { for (const name of cmdsIn(S, code)) { const key = `${i}:${name}`; if (!S.seenMarks.has(key)) { S.seenMarks.add(key); safe(() => store.markSeen(name)); } } };
  const complete = (focus) => {
    if (!typedMap(S)[i]) safe(() => store.set(`lesson.${S.lesson.id}.typed.${i}`, 1));
    refreshStatus(S);
    setComplete(S, i, true, focus);
  };
  if (!cells.length) { complete(false); return; }
  const box = h('div', { class: 'lp-cells' });
  wrap.appendChild(box);
  let alive = true;
  S.stepCleanup.push(() => { alive = false; });
  let fresh = true; // the first evaluation of this visit starts from a clean session
  const before = async () => { if (fresh) { fresh = false; await kernel.reset(); } };
  const pill = kernelPill();
  S.stepCleanup.push(pill.destroy);
  const noteEl = (c) => (c.note ? h('div', { class: 'lp-cell-note lx-md', html: mdInline(c.note) }) : null);

  if (typedMap(S)[i]) {
    /* already typed once: plain editable cells with their outputs, free to change and re-evaluate */
    const recs = cells.map((c, k) => {
      const host = h('div', { class: 'lp-cell-host' });
      box.appendChild(h('div', { class: 'lp-cell' }, noteEl(c), host));
      const rec = { c, k, auto: c.run !== false, ran: false, cell: null };
      try { rec.cell = createCell(host, { code: c.code, onResult: (code) => { rec.ran = true; seen(code); } }); } catch (e) { console.error('[learn] createCell', e); host.appendChild(codeBlock(c.code)); }
      S.stepCleanup.push(() => rec.cell && rec.cell.destroy && safe(() => rec.cell.destroy()));
      return rec;
    });
    // evaluating cell k evaluates first the earlier ones that have not run yet (like "evaluate from the top")
    const run = (k) => exclusive(async () => {
      if (!alive) return;
      await before();
      for (const r of recs.filter((r) => r.cell && (r.k === k || (r.k < k && !r.ran && r.auto)))) { if (!alive) return; try { await r.cell.run(); r.ran = true; } catch (e) { console.warn('[learn] cell.run', e); } }
    }).catch((e) => console.warn('[learn]', e));
    recs.forEach((r) => {
      const hostEl = r.cell && r.cell.el ? r.cell.el.parentNode : null;
      if (!hostEl) return;
      hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); run(r.k); } }, true);
      hostEl.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('.wl-run')) { e.preventDefault(); e.stopPropagation(); run(r.k); } }, true);
    });
    const autos = recs.filter((r) => r.auto && r.cell);
    if (autos.length) {
      let started = false;
      S.stepCleanup.push(watchKernel((status) => { if (!started && alive && (status === 'ready' || status === 'busy')) { started = true; setTimeout(() => { if (alive) run(autos[autos.length - 1].k); }, 120); } }));
    }
    wrap.appendChild(h('div', { class: 'lp-cells-foot' }, pill.el, h('span', { class: 'muted' }, 'Ya tecleaste este paso. Las celdas son tuyas: cambia lo que quieras y vuelve a evaluar.'),
      h('button', { class: 'lx-link', type: 'button', onclick: () => { safe(() => store.set(`lesson.${S.lesson.id}.typed.${i}`, 0)); renderStep(S, 0); } }, 'Volver a teclearlo')));
    seenAll();
    return;
  }

  /* first time: one cell at a time; the next one appears when the current one has been typed and evaluated */
  const tip = h('div', { class: 'lp-typehint' }, pill.el, h('span', { class: 'muted' }, 'Teclea la línea gris tal cual y evalúala con ', h('kbd', null, 'Shift'), '+', h('kbd', null, 'Enter'), '.'));
  const progress = h('span', { class: 'lp-cellcount muted' });
  tip.appendChild(progress);
  let k = 0;
  const showNext = (focus) => {
    if (!alive) return;
    // cells marked run:false are deliberately wrong or not meant to be evaluated: shown as plain code, not typed
    while (k < cells.length && cells[k].run === false) { box.appendChild(h('div', { class: 'lp-cell lp-cell--static' }, noteEl(cells[k]), codeBlock(cells[k].code))); k++; }
    if (k >= cells.length) { tip.remove(); complete(focus); return; }
    const c = cells[k];
    const host = h('div', { class: 'lp-cell-host' });
    const row = h('div', { class: 'lp-cell lp-cell--ghost' }, noteEl(c), host);
    box.appendChild(row);
    progress.textContent = cells.length > 1 ? `Celda ${k + 1} de ${cells.length}` : '';
    const g = mountGhost(host, c.code, {
      before,
      onDone: () => {
        row.classList.add('is-done');
        seen(c.code);
        k++;
        play('click');
        setTimeout(() => showNext(true), 150);
      },
    });
    S.stepCleanup.push(() => g.destroy());
    if (focus) setTimeout(() => { if (alive) { g.focus(); if (row.getBoundingClientRect().bottom > window.innerHeight - 90) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 60);
  };
  wrap.appendChild(tip);
  showNext(false);
  // focus the first cell once the entry animation is over (not on touch screens: the keyboard would cover the text)
  if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(() => { if (alive && S.idx === i) { const ta = box.querySelector('textarea, [contenteditable="true"]'); if (ta) ta.focus({ preventScroll: true }); } }, 380);
  seenAll();

  function seenAll() { for (const c of cells) seen(c.code); }
}

/* ---------- end of lesson ---------- */
function renderEnd(S, wrap) {
  const { lesson } = S;
  wrap.classList.add('lp-end');
  const exSteps = lesson.steps.map((s, i) => ({ s, i })).filter((x) => x.s.type === 'exercise' && x.s.ex && stepKind(x.s) === 'exercise');
  const other = lesson.steps.map((s, i) => ({ s, i })).filter((x) => stepKind(x.s) !== 'exercise');
  const total = exSteps.length;
  const ok = exSteps.filter((x) => exStatus(x.s.ex.id) === 'ok').length;
  const untyped = other.filter((x) => !stepDone(S, x.i) && !(x.s.type === 'explain' && !(x.s.cells || []).length));
  const weak = exSteps.filter((x) => {
    const st = exStatus(x.s.ex.id);
    const r = S.sess.results.get(x.s.ex.id);
    return st !== 'ok' || (r && (r.fails >= 2 || r.revealed));
  });
  const first = [...S.sess.results.values()].filter((r) => r.firstTry).length;
  const complete = ok === total && lesson.steps.every((s) => s.type !== 'exercise' || !s.ex || exStatus(s.ex.id) === 'ok');
  const done = safe(() => store.state.lesson[lesson.id] && store.state.lesson[lesson.id].done, false);
  if (complete && !done) safe(() => (store.completeLesson ? store.completeLesson(lesson.id) : store.set(`lesson.${lesson.id}.done`, true)));
  const xpNow = safe(() => store.state.xp, 0) || 0;
  const lvl0 = levelOf(S.sess.startXp), lvl1 = levelOf(xpNow);
  const left = total - ok;

  wrap.appendChild(h('div', { class: 'lp-kicker' }, complete ? 'Lección completada' : 'Has llegado al final'));
  wrap.appendChild(h('h1', { class: 'lp-title' }, complete ? lesson.title : left > 0 ? `Te ${left === 1 ? 'queda 1 ejercicio' : `quedan ${left} ejercicios`} para completarla` : 'Te quedan pasos por teclear'));
  wrap.appendChild(h('div', { class: `lp-end-hero${complete ? ' is-complete' : ''}` },
    h('div', { class: 'lp-end-big' }, h('b', null, `${ok}`), h('span', null, `/ ${total}`), h('small', null, 'ejercicios')),
    h('div', { class: 'lp-end-txt' },
      h('p', { class: 'muted' }, complete ? 'Todos los ejercicios resueltos. Lo que acabas de escribir es lo que cae en la práctica y en el examen.' : 'La lección se da por completada cuando resuelves todos sus ejercicios. Abajo tienes lo pendiente.'),
      h('div', { class: 'lp-end-stats' },
        stat(`+${S.sess.xp}`, 'XP en esta sesión'),
        stat(String(first), 'a la primera'),
        lvl1 > lvl0 ? stat(`Nivel ${lvl1}`, 'has subido de nivel') : stat(`Nivel ${lvl1}`, 'tu nivel')))));

  const cmds = [...new Set([...(lesson.commands || [])])];
  const uses = [...new Set((lesson.uses || []).filter((c) => !cmds.includes(c)))];
  if (cmds.length || uses.length) {
    wrap.appendChild(h('div', { class: 'lp-end-card' },
      h('h3', null, 'Comandos de esta lección'),
      cmds.length ? h('div', { class: 'lp-end-chips' }, cmds.map(cmdChip)) : null,
      uses.length ? h('div', { class: 'lp-end-uses' }, h('span', { class: 'muted' }, 'También has usado: '), uses.map(cmdChip)) : null,
      h('p', { class: 'muted lp-legend' }, h('span', { class: 'chip l1' }, 'visto'), h('span', { class: 'chip l2' }, 'en práctica'), h('span', { class: 'chip l3' }, 'dominado'), ' Un comando se domina al acertar 3 ejercicios que lo usan.')));
  }
  if (weak.length || untyped.length) {
    const list = h('ul', { class: 'lp-weak' });
    for (const x of weak) {
      const st = exStatus(x.s.ex.id);
      const label = st === 'review' ? 'viste la solución' : st === 'ok' ? 'te costó' : st === 'tried' ? 'sin resolver' : 'sin hacer';
      list.appendChild(h('li', null,
        h('span', { class: `lp-weak-st st-${st}` }, st === 'ok' ? '✓' : st === 'review' ? '↻' : '○'),
        h('span', { class: 'lp-weak-t' }, stepTitle(x.s, x.i), h('small', { class: 'muted' }, ` · ${label}`)),
        h('button', { class: 'lx-link', type: 'button', onclick: () => S.go(x.i) }, st === 'ok' ? 'repasar' : 'hacer ahora')));
    }
    for (const x of untyped) {
      list.appendChild(h('li', null, h('span', { class: 'lp-weak-st' }, '○'), h('span', { class: 'lp-weak-t' }, stepTitle(x.s, x.i), h('small', { class: 'muted' }, ' · sin teclear')),
        h('button', { class: 'lx-link', type: 'button', onclick: () => S.go(x.i) }, 'teclear ahora')));
    }
    wrap.appendChild(h('div', { class: 'lp-end-card' }, h('h3', null, complete ? 'Para reforzar' : 'Pendiente'), list));
  }
  const actions = h('div', { class: 'lp-end-actions' });
  const nextSlot = h('span', { class: 'lp-next-slot' });
  if (!complete && weak.length) actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: () => S.go(weak[0].i) }, 'Resolver lo pendiente'));
  else actions.appendChild(nextSlot);
  actions.appendChild(h('a', { class: 'btn', href: `#/practica/tema/${encodeURIComponent(lesson.id)}` }, 'Practicar estos comandos'));
  if (!complete && weak.length) actions.appendChild(nextSlot);
  actions.appendChild(h('a', { class: 'lx-link', href: '#/indice' }, 'Volver al índice'));
  actions.appendChild(h('button', { class: 'lx-link', type: 'button', onclick: () => S.go(0) }, 'Repasar desde el principio'));
  wrap.appendChild(actions);
  if (S.nextUnit) {
    const u = S.nextUnit;
    const a = h('a', { class: `btn${complete ? ' primary' : ''}`, href: `#/leccion/${encodeURIComponent(u.lesson)}` }, `Siguiente lección: ${u.title || u.practice || u.lesson} ›`);
    nextSlot.appendChild(a);
    // hide the link if that lesson is not published yet
    data.loadLesson(u.lesson).catch(() => { a.replaceWith(h('span', { class: 'muted lp-next-soon' }, `Siguiente (${u.practice || u.title}): en preparación`)); });
  }

  if (!S.endShown) {
    S.endShown = true;
    if (complete) {
      play('unlock');
      safe(() => fx.confetti({ y: 0.3, count: 45, power: 0.8 })); // milestone: lesson completed (small)
    }
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
  if (paso != null) S.go(Math.round(paso));
  return true;
}

export default { mount, unmount, update };
