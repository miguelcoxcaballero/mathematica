// views/practica.js (LEARN) — practice hub and sessions.
//   #/practica                      hub: por comando · por tema · aleatoria
//   #/practica/comando/<Nombre>     exercises (from every lesson) that use that command, easy → hard, unsolved first
//   #/practica/tema/<lessonId>      exercises of one lesson
//   #/practica/aleatoria[?n=10]     N exercises sampled from what the student has already studied (weak/stale first)
import { store } from '../store.js?v=1794353407';
import * as data from '../data.js?v=1794353407';
import * as fx from '../fx.js?v=1794353407';
import {
  mountExercise, isPractice, recallExercise, reviewRecord, reviewDue, ensureCss, h, yearBadge, yearOf, cmdChip, safe, play, exStatus, newSeed, startKernel,
} from '../exercise.js?v=1794353407';

const PREF_KEY = 'wolframlab-aero-practice';
const LEVEL_NAME = ['por aprender', 'visto', 'en práctica', 'dominado'];
const KERNEL_KINDS = new Set(['code', 'fix', 'fill', 'order']);

let V = null; // mounted view state
let indexP = null;

/* ============================================================ data */
async function allLessons() {
  if (typeof data.loadAllLessons === 'function') return data.loadAllLessons();
  const course = await data.loadCourse();
  const ids = [];
  for (const y of course.years || []) for (const s of y.subjects || []) for (const b of s.blocks || []) for (const u of b.units || []) if (u.lesson) ids.push(u.lesson);
  const out = await Promise.all(ids.map((id) => data.loadLesson(id).catch(() => null)));
  return out.filter(Boolean);
}

function loadIndex() {
  if (indexP) return indexP;
  indexP = (async () => {
    const [lessons, course, catalog] = await Promise.all([allLessons(), data.loadCourse().catch(() => null), data.loadCommands().catch(() => null)]);
    const units = new Map();
    let k = 0;
    for (const y of (course && course.years) || []) for (const s of y.subjects || []) for (const b of s.blocks || []) for (const u of b.units || []) if (u.lesson) units.set(u.lesson, { ...u, year: y.year, subject: s.name, block: b.name, pos: k++ });
    const items = [], byCmd = new Map(), byLesson = new Map(), byId = new Map();
    lessons.forEach((lesson, li) => {
      const unit = units.get(lesson.id) || null;
      const list = [];
      (lesson.steps || []).forEach((step, si) => {
        if (step && step.type === 'build') {
          // the recall of a build ("write it from memory") is practised like any other exercise
          const rx = recallExercise(lesson, si);
          if (!rx) return;
          const it = { ex: rx, lesson, unit, step: si, pos: (unit ? unit.pos : 1000 + li) * 1000 + si, year: yearOf(lesson), recall: true };
          items.push(it); list.push(it); byId.set(rx.id, it);
          for (const c of new Set(rx.cmds || [])) { if (!byCmd.has(c)) byCmd.set(c, []); byCmd.get(c).push(it); }
          return;
        }
        if (!step || step.type !== 'exercise' || !step.ex || !step.ex.id || !step.ex.kind) return;
        if (!isPractice(step.ex)) return; // notes and type-and-observe steps (old mcq/predict) are not exercises
        const it = { ex: step.ex, lesson, unit, step: si, pos: (unit ? unit.pos : 1000 + li) * 1000 + si, year: yearOf(lesson) };
        items.push(it); list.push(it); byId.set(step.ex.id, it);
        for (const c of new Set(step.ex.cmds || [])) { if (!byCmd.has(c)) byCmd.set(c, []); byCmd.get(c).push(it); }
      });
      byLesson.set(lesson.id, list);
    });
    const cat = new Map(((catalog && catalog.commands) || []).map((c) => [c.name, c]));
    return { lessons, units, items, byCmd, byLesson, byId, cat };
  })();
  indexP.catch(() => { indexP = null; });
  return indexP;
}

const prefs = () => safe(() => JSON.parse(localStorage.getItem(PREF_KEY)) || {}, {}) || {};
const savePrefs = (p) => safe(() => localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), ...p })));

function exRec(id) { return safe(() => store.exercise(id), null) || null; }
function cmdLv(name) { return safe(() => store.cmdLevel(name), 0) || 0; }
function lessonStarted(id) {
  const L = safe(() => store.state.lesson[id], null);
  return !!L;
}
/** Has the student studied this exercise's material? (lesson started, or exercise tried, or every command already seen) */
function studied(it) {
  if (it.recall) return !!exRec(it.ex.id) || !!safe(() => store.state.lesson[it.lesson.id].typed[it.step], false); // only builds he has already built
  if (lessonStarted(it.lesson.id) || exRec(it.ex.id)) return true;
  const cmds = it.ex.cmds || [];
  return cmds.length > 0 && cmds.every((c) => cmdLv(c) >= 1);
}
/** Spaced-repetition weight: failures, time since last success, low mastery, flagged for review. */
function weight(it) {
  const r = exRec(it.ex.id);
  const fails = r ? Math.max(0, (r.tries || 0) - (r.ok ? 1 : 0)) : 0;
  const now = Date.now();
  let w = 1 + 2.5 * Math.min(fails, 4);
  if (r && r.review) w += 4;
  if (r && r.ok) {
    const days = (now - (r.okTs || r.ts || now)) / 86400000;
    w += Math.min(days, 30) / 4;
    if (days < 0.5 && !fails && !r.review) w *= 0.2; // just solved cleanly: let it rest
  } else w += 2.5;
  const cmds = it.ex.cmds || [];
  if (cmds.length) w += (3 - Math.min(...cmds.map(cmdLv))) * 0.8;
  if (it.ex.real) w += 0.6;
  return w;
}
function weakness(it) { const r = exRec(it.ex.id); return !r ? 1 : r.review ? 3 : !r.ok ? 2 : 0; }
/** easy → hard, not-yet-solved first */
function ordered(list) {
  const rank = (it) => { const s = exStatus(it.ex.id); return s === 'ok' ? 1 : 0; };
  return list.slice().sort((a, b) => rank(a) - rank(b) || (a.ex.difficulty || 1) - (b.ex.difficulty || 1) || a.pos - b.pos);
}
function sample(pool, n) {
  const left = pool.map((it) => ({ it, w: weight(it) }));
  const out = [];
  while (out.length < n && left.length) {
    const tot = left.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * tot, k = 0;
    for (; k < left.length - 1; k++) { r -= left[k].w; if (r <= 0) break; }
    out.push(left.splice(k, 1)[0].it);
  }
  // interleave: avoid the same lesson (and, if possible, the same year) twice in a row
  const res = [];
  const rest = out.slice();
  while (rest.length) {
    const prev = res[res.length - 1];
    let k = 0;
    if (prev) {
      k = rest.findIndex((x) => x.lesson.id !== prev.lesson.id && x.year !== prev.year);
      if (k < 0) k = rest.findIndex((x) => x.lesson.id !== prev.lesson.id);
      if (k < 0) k = 0;
    }
    res.push(rest.splice(k, 1)[0]);
  }
  return res;
}

/* ============================================================ mount */
function parse(params) {
  const p = params && typeof params === 'object' ? { ...params } : {};
  if (!p.mode) {
    const segs = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map((s) => safe(() => decodeURIComponent(s), s));
    p.mode = segs[1] || 'menu';
    if (p.mode === 'comando') p.name = segs[2];
    if (p.mode === 'tema') p.lessonId = segs[2];
  }
  if (!p.query) { const q = location.hash.split('?')[1]; p.query = q ? Object.fromEntries(new URLSearchParams(q)) : {}; }
  return p;
}

async function mount(el, params) {
  ensureCss();
  const p = parse(params);
  const me = (V = { el, alive: true, cleanup: [] });
  el.innerHTML = '';
  const root = h('div', { class: 'pr' }, h('div', { class: 'lx-loading' }, h('i', { class: 'lx-spin' }), 'Preparando ejercicios…'));
  el.appendChild(root);
  me.root = root;
  let idx;
  try { idx = await loadIndex(); } catch (e) { idx = null; }
  if (V !== me) return;
  if (!idx) { root.replaceChildren(empty('', 'No se han podido cargar los ejercicios', 'Comprueba la conexión y vuelve a intentarlo.', [h('button', { class: 'btn primary', type: 'button', onclick: () => { indexP = null; mount(el, params); } }, 'Reintentar')])); return; }
  me.idx = idx;
  if (p.mode === 'comando') startCommand(me, p.name || p.cmd || p.id);
  else if (p.mode === 'tema') startTopic(me, p.lessonId || p.tema || p.id);
  else if (p.mode === 'aleatoria') startRandom(me, p.query || {});
  else renderHub(me);
}

function unmount() {
  const me = V;
  if (!me) return;
  V = null; me.alive = false;
  if (me.widget) safe(() => me.widget.destroy());
  me.cleanup.forEach((f) => safe(f));
  if (me.el) me.el.innerHTML = '';
}

function empty(ic, title, text, actions) {
  return h('div', { class: 'lx-empty' }, h('h2', null, title), h('p', { class: 'muted' }, text), h('div', { class: 'row' }, actions || []));
}

/* ============================================================ hub */
function renderHub(me) {
  const { idx, root } = me;
  const studiedPool = idx.items.filter(studied);
  const pending = studiedPool.filter((it) => weakness(it) >= 2).length;
  const nPref = [5, 10, 20].includes(prefs().n) ? prefs().n : 10;

  const cmds = [...idx.byCmd.entries()].map(([name, list]) => {
    const c = idx.cat.get(name);
    const ok = list.filter((it) => exStatus(it.ex.id) === 'ok').length;
    return { name, list, n: list.length, ok, lv: cmdLv(name), year: (c && c.year) || Math.min(...list.map((it) => it.year || 9)) || 0, pos: Math.min(...list.map((it) => it.pos)), desc: (c && c.desc) || '' };
  }).sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name));

  const head = h('header', { class: 'pr-head' },
    h('h1', null, 'Práctica'),
    h('p', { class: 'muted' }, 'Repite hasta que los comandos te salgan solos.'));

  /* three big entries */
  const nBtns = h('div', { class: 'pr-n', role: 'group', 'aria-label': 'Número de ejercicios' });
  let nSel = nPref;
  const go = h('a', { class: 'btn primary pr-go', href: `#/practica/aleatoria?n=${nSel}` }, 'Empezar →');
  for (const n of [5, 10, 20]) {
    const b = h('button', { type: 'button', class: `pr-nbtn${n === nSel ? ' on' : ''}`, 'aria-pressed': String(n === nSel) }, String(n));
    b.addEventListener('click', (e) => { e.preventDefault(); nSel = n; savePrefs({ n }); for (const x of nBtns.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); } go.href = `#/practica/aleatoria?n=${n}`; });
    nBtns.appendChild(b);
  }
  const cards = h('div', { class: 'pr-modes' },
    h('a', { class: 'pr-mode pr-mode--cmd', href: '#pr-cmds', onclick: (e) => { e.preventDefault(); scrollToEl(root.querySelector('#pr-cmds')); const s = root.querySelector('.pr-search'); if (s) s.focus({ preventScroll: true }); } },
      h('h2', null, 'Por comando'),
      h('p', null, 'Un comando, de fácil a difícil.'),
      h('span', { class: 'pr-mode-meta' }, `${cmds.length} comandos con ejercicios`)),
    h('a', { class: 'pr-mode pr-mode--tema', href: '#pr-temas', onclick: (e) => { e.preventDefault(); scrollToEl(root.querySelector('#pr-temas')); } },
      h('h2', null, 'Por tema'),
      h('p', null, 'Los ejercicios de una práctica, con los reales.'),
      h('span', { class: 'pr-mode-meta' }, `${idx.lessons.length} temas · ${idx.items.length} ejercicios`)),
    h('div', { class: 'pr-mode pr-mode--rand' },
      h('h2', null, 'Aleatoria sobre lo ya estudiado'),
      h('p', null, 'Mezcla lo que más te cuesta y lo que hace tiempo que no tocas.'),
      studiedPool.length
        ? h('div', { class: 'pr-rand-row' }, nBtns, go)
        : h('span', { class: 'pr-mode-meta' }, 'Se activa en cuanto empieces tu primera lección.'),
      studiedPool.length ? h('span', { class: 'pr-mode-meta' }, `${studiedPool.length} ejercicios disponibles${pending ? ` · ${pending} pendientes de repaso` : ''}`) : h('a', { class: 'btn', href: firstLessonHref(idx) }, 'Ir a la primera lección')));

  /* recommended commands */
  const rec = cmds.filter((c) => c.lv === 1 || c.lv === 2).sort((a, b) => (b.n - b.ok) - (a.n - a.ok)).slice(0, 8);
  const recBox = rec.length ? h('section', { class: 'pr-rec' },
    h('h3', null, 'Para hoy: comandos a medio dominar'),
    h('div', { class: 'pr-rec-list' }, rec.map((c) => h('a', { class: `chip l${c.lv} pr-rec-chip`, href: `#/practica/comando/${encodeURIComponent(c.name)}`, title: `${LEVEL_NAME[c.lv]} · ${c.ok}/${c.n} resueltos` }, c.name, h('small', null, `${c.ok}/${c.n}`))))) : null;

  /* command grid */
  const search = h('input', { class: 'pr-search', type: 'search', placeholder: 'Buscar comando… (Plot, DSolve, integral…)', 'aria-label': 'Buscar comando', 'data-search': '', autocomplete: 'off', spellcheck: 'false' });
  const filters = [['all', 'Todos'], ['y1', '1º'], ['y2', '2º'], ['todo', 'Sin dominar'], ['done', 'Dominados']];
  let filt = 'all';
  const fRow = h('div', { class: 'pr-filters', role: 'group', 'aria-label': 'Filtrar comandos' }, filters.map(([k, l]) => h('button', { type: 'button', class: `pr-filter${k === 'all' ? ' on' : ''}`, dataset: { f: k } }, l)));
  const grid = h('div', { class: 'pr-grid' });
  const none = h('p', { class: 'muted pr-none', hidden: true }, 'Ningún comando coincide con la búsqueda.');
  const tiles = cmds.map((c) => {
    const t = h('a', { class: `pr-tile l${c.lv}`, href: `#/practica/comando/${encodeURIComponent(c.name)}`, title: `${c.name} · ${LEVEL_NAME[c.lv]} · ${c.n} ${c.n === 1 ? 'ejercicio' : 'ejercicios'}${c.desc ? ' — ' + c.desc : ''}` },
      h('i', { class: 'pr-lvdot', 'aria-hidden': 'true' }),
      h('span', { class: 'pr-tile-name' }, c.name),
      c.year === 1 || c.year === 2 ? yearBadge(c.year) : null,
      h('span', { class: 'pr-tile-n', title: `${c.ok} resueltos de ${c.n}` }, `${c.ok}/${c.n}`));
    t._c = c;
    grid.appendChild(t);
    return t;
  });
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const t of tiles) {
      const c = t._c;
      const okF = filt === 'all' || (filt === 'y1' && c.year === 1) || (filt === 'y2' && c.year === 2) || (filt === 'todo' && c.lv < 3) || (filt === 'done' && c.lv === 3);
      const okQ = !q || c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q);
      t.hidden = !(okF && okQ);
      if (!t.hidden) shown++;
    }
    none.hidden = shown > 0;
  };
  search.addEventListener('input', apply);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = tiles.find((t) => !t.hidden); if (first) location.hash = first.getAttribute('href'); } });
  fRow.addEventListener('click', (e) => { const b = e.target.closest('.pr-filter'); if (!b) return; filt = b.dataset.f; for (const x of fRow.children) x.classList.toggle('on', x === b); apply(); });
  const cmdSec = h('section', { class: 'pr-sec', id: 'pr-cmds' },
    h('div', { class: 'pr-sec-h' }, h('h2', null, 'Práctica específica por comando'), h('span', { class: 'muted pr-legend' }, h('i', { class: 'pr-lvdot l0' }), 'por aprender', h('i', { class: 'pr-lvdot l1' }), 'visto', h('i', { class: 'pr-lvdot l2' }), 'en práctica', h('i', { class: 'pr-lvdot l3' }), 'dominado')),
    h('div', { class: 'pr-tools' }, search, fRow),
    cmds.length ? grid : h('p', { class: 'muted' }, 'Todavía no hay ejercicios publicados.'), none);

  /* topics */
  const temaSec = h('section', { class: 'pr-sec', id: 'pr-temas' }, h('div', { class: 'pr-sec-h' }, h('h2', null, 'Práctica por tema')));
  const groups = new Map();
  for (const lesson of idx.lessons) { const y = yearOf(lesson) || 0; if (!groups.has(y)) groups.set(y, []); groups.get(y).push(lesson); }
  for (const [y, list] of [...groups.entries()].sort((a, b) => (a[0] || 9) - (b[0] || 9))) {
    const box = h('div', { class: 'pr-temas' });
    for (const lesson of list) {
      const its = idx.byLesson.get(lesson.id) || [];
      if (!its.length) continue;
      const ok = its.filter((it) => exStatus(it.ex.id) === 'ok').length;
      const real = its.filter((it) => it.ex.real).length;
      const unit = idx.units.get(lesson.id);
      box.appendChild(h('a', { class: 'pr-tema', href: `#/practica/tema/${encodeURIComponent(lesson.id)}` },
        h('span', { class: 'pr-tema-top' }, yearBadge(y), unit && unit.practice ? h('span', { class: 'pr-tema-p' }, unit.practice) : null, real ? h('span', { class: 'badge real' }, real === 1 ? "1 real" : `${real} reales`) : null),
        h('strong', { class: 'pr-tema-t' }, lesson.title || lesson.id),
        h('span', { class: `progress${y ? ' y' + y : ''}` }, h('i', { style: { width: `${Math.round(100 * ok / its.length)}%` } })),
        h('span', { class: 'pr-tema-n muted' }, `${ok} / ${its.length} resueltos`)));
    }
    if (box.children.length) temaSec.append(h('h3', { class: 'pr-year' }, y ? `${y}º curso` : 'Base'), box);
  }
  root.replaceChildren(head, cards, ...(recBox ? [recBox] : []), cmdSec, temaSec);
}

function firstLessonHref(idx) {
  const first = idx.lessons[0];
  return first ? `#/leccion/${encodeURIComponent(first.id)}` : '#/indice';
}
function scrollToEl(el) { if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: 'smooth' }); }

/* ============================================================ sessions */
function startCommand(me, name) {
  const list = me.idx.byCmd.get(name) || [];
  if (!list.length) {
    me.root.replaceChildren(empty('', `Aún no hay ejercicios de ${name || 'ese comando'}`, 'Puede que el comando se practique dentro de otros ejercicios o que su lección todavía no esté publicada.',
      [h('a', { class: 'btn primary', href: '#/practica' }, 'Elegir otro comando'), name ? h('a', { class: 'btn', href: `#/comandos/${encodeURIComponent(name)}` }, 'Ver la ficha del comando') : null]));
    return;
  }
  const c = me.idx.cat.get(name);
  runSession(me, {
    kind: 'comando', endless: true,
    kicker: 'Práctica por comando', title: h('span', null, h('code', null, name)), sub: (c && c.desc) || '',
    year: c && c.year, cmd: name,
    build: () => ordered(list),
    again: `#/practica/comando/${encodeURIComponent(name)}`,
  });
}

function startTopic(me, id) {
  const list = me.idx.byLesson.get(id) || [];
  const lesson = me.idx.lessons.find((l) => l.id === id);
  if (!list.length || !lesson) {
    me.root.replaceChildren(empty('', 'Este tema aún no tiene ejercicios', 'Su lección todavía no está publicada. Mientras tanto puedes practicar otro tema.', [h('a', { class: 'btn primary', href: '#/practica' }, 'Elegir otro tema')]));
    return;
  }
  runSession(me, {
    kind: 'tema', endless: true,
    kicker: 'Práctica por tema', title: lesson.title || id, sub: [lesson.subject, lesson.block].filter(Boolean).join(' · '), year: yearOf(lesson), lessonId: id,
    build: () => ordered(list),
    again: `#/practica/tema/${encodeURIComponent(id)}`,
  });
}

function startRandom(me, query) {
  const pool = me.idx.items.filter(studied);
  if (!pool.length) {
    me.root.replaceChildren(empty('', 'Todavía no has estudiado nada', 'La práctica aleatoria solo usa ejercicios de lecciones que ya has empezado o de comandos que ya has visto. Empieza una lección y vuelve: aquí se mezclará todo lo que vayas aprendiendo.',
      [h('a', { class: 'btn primary', href: firstLessonHref(me.idx) }, 'Empezar la primera lección'), h('a', { class: 'btn', href: '#/indice' }, 'Ver el índice')]));
    return;
  }
  const qn = Number(query.n);
  if (![5, 10, 20].includes(qn)) { renderRandomIntro(me, pool); return; }
  savePrefs({ n: qn });
  runSession(me, {
    kind: 'aleatoria', endless: false,
    kicker: 'Práctica aleatoria', title: `${Math.min(qn, pool.length)} ejercicios`, sub: '',
    build: () => {
      const picked = sample(me.idx.items.filter(studied), qn);
      // the session opens with 2–3 "¿recuerdas?" from the review queue (SPEC §13)
      const due = reviewDue().map((r) => me.idx.byId.get(`${r.lessonId}-b${r.step}`)).filter(Boolean).slice(0, 3);
      const rest = picked.filter((it) => !due.includes(it));
      return [...due.map((it) => ({ ...it, warm: true })), ...rest].slice(0, Math.max(qn, due.length));
    },
    again: `#/practica/aleatoria?n=${qn}`,
  });
}

function renderRandomIntro(me, pool) {
  const lessons = new Set(pool.map((it) => it.lesson.id));
  const pending = pool.filter((it) => weakness(it) >= 2).length;
  const fresh = pool.filter((it) => weakness(it) === 1).length;
  let n = [5, 10, 20].includes(prefs().n) ? prefs().n : 10;
  const btns = h('div', { class: 'pr-n pr-n--big', role: 'group', 'aria-label': 'Número de ejercicios' });
  const go = h('a', { class: 'btn primary pr-go', href: `#/practica/aleatoria?n=${n}` }, 'Empezar →');
  for (const k of [5, 10, 20]) {
    const b = h('button', { type: 'button', class: `pr-nbtn${k === n ? ' on' : ''}` }, String(k), h('small', null, k === 5 ? '≈ 5 min' : k === 10 ? '≈ 10 min' : '≈ 25 min'));
    b.addEventListener('click', () => { n = k; savePrefs({ n }); for (const x of btns.children) x.classList.toggle('on', x === b); go.href = `#/practica/aleatoria?n=${k}`; });
    btns.appendChild(b);
  }
  me.root.replaceChildren(
    h('header', { class: 'pr-shead' }, h('a', { class: 'lp-back', href: '#/practica', title: 'Volver a práctica' }, '← Práctica'),
      h('div', { class: 'lp-titles' }, h('div', { class: 'lp-crumbs' }, 'Práctica'), h('h1', { class: 'lp-title' }, 'Aleatoria sobre lo ya estudiado'))),
    h('div', { class: 'pr-intro' },
      h('p', { class: 'pr-intro-t' }, 'Ejercicios mezclados de lo que ya has visto.'),
      h('div', { class: 'lp-end-stats' }, stat(String(pool.length), 'ejercicios disponibles'), stat(String(lessons.size), lessons.size === 1 ? 'tema' : 'temas'), stat(String(pending), 'para repasar'), stat(String(fresh), 'sin estrenar')),
      h('h3', null, '¿Cuántos ejercicios?'), btns,
      h('div', { class: 'row' }, go, h('a', { class: 'btn ghost', href: '#/practica' }, 'Volver'))));
}

function stat(v, l) { return h('div', { class: 'lx-stat' }, h('b', null, v), h('span', null, l)); }

function runSession(me, cfg) {
  const { root } = me;
  const S = (me.sess = { cfg, round: 0, queue: [], pos: -1, results: [], t0: Date.now(), xp: 0, cmd0: new Map(), seen: new Set() });
  const snap = (it) => { for (const c of it.ex.cmds || []) if (!S.cmd0.has(c)) S.cmd0.set(c, cmdLv(c)); };

  const okEl = h('b', { class: 'pr-m-ok' }, '0'), badEl = h('b', { class: 'pr-m-bad' }, '0'), xpEl = h('b', { class: 'pr-m-xp' }, '+0');
  const finishBtn = h('button', { class: 'lx-link pr-finish', type: 'button' }, 'Terminar');
  const head = h('header', { class: 'pr-shead' },
    h('a', { class: 'lp-back', href: '#/practica', title: 'Volver a práctica' }, '← Práctica'),
    h('div', { class: 'lp-titles' }, h('div', { class: 'lp-crumbs' }, cfg.year ? yearBadge(cfg.year) : null, h('span', null, cfg.kicker)), h('h1', { class: 'lp-title' }, cfg.title)),
    h('div', { class: 'pr-meters', 'aria-live': 'polite' }, h('span', { title: 'Aciertos' }, okEl, ' bien'), h('span', { title: 'Fallos, saltos y soluciones vistas' }, badEl, ' mal'), h('span', { title: 'XP de esta sesión' }, xpEl, ' XP')),
    finishBtn);
  const bar = h('i');
  const count = h('span', { class: 'lp-count' });
  const prog = h('div', { class: 'lp-prog' }, h('div', { class: 'progress' }, bar), count);
  const stage = h('section', { class: 'pr-stage' });
  const skipBtn = h('button', { class: 'btn ghost pr-skip', type: 'button' }, 'Saltar');
  const nextBtn = h('button', { class: 'btn primary lp-next', type: 'button' }, 'Siguiente →');
  const hint = h('span', { class: 'lp-nav-hint muted' });
  const nav = h('footer', { class: 'lp-nav' }, skipBtn, hint, nextBtn);
  root.className = 'pr pr-session';
  root.replaceChildren(head, prog, stage, nav);

  const meters = () => {
    const ok = S.results.filter((r) => r.ok).length;
    okEl.textContent = String(ok); badEl.textContent = String(S.results.length - ok); xpEl.textContent = `+${S.xp}`;
  };
  const newRound = (items) => {
    S.round++;
    S.queue = items || cfg.build();
    S.queue.forEach(snap);
    S.pos = -1;
    S.roundStart = S.results.length;
  };
  const show = () => {
    if (V !== me) return;
    if (me.widget) { safe(() => me.widget.destroy()); me.widget = null; }
    const it = S.queue[S.pos];
    const total = S.queue.length;
    bar.style.width = `${Math.round(100 * S.pos / total)}%`;
    count.textContent = `${cfg.endless && S.round > 1 ? `Ronda ${S.round} · ` : ''}${S.pos + 1} / ${total}`;
    const unit = it.unit;
    const src = h('div', { class: 'pr-src' },
      h('span', { class: 'pr-src-t' }, [it.warm ? '¿Recuerdas?' : it.recall ? 'De memoria' : '', unit && unit.practice, it.lesson.title].filter(Boolean).join(' · ')),
      h('a', { class: 'pr-src-a', href: `#/leccion/${encodeURIComponent(it.lesson.id)}/${explainStep(it)}`, title: 'Abrir la explicación de la lección' }, 'Repasar la teoría'));
    const host = h('div', { class: 'pr-exhost' });
    const wrap = h('div', { class: 'lp-step lp-in-r' }, src, host);
    stage.replaceChildren(wrap);
    S.current = { it, done: false };
    skipBtn.hidden = false;
    nextBtn.disabled = true; nextBtn.classList.remove('primary'); // one primary action per screen: Comprobar
    nextBtn.textContent = S.pos === total - 1 ? 'Ver resumen →' : 'Siguiente →';
    hint.textContent = '';
    // a new variant every time the exercise comes up again
    me.widget = mountExercise(host, it.ex, {
      mode: 'practice', seed: newSeed(), year: it.year, lesson: it.lesson, recall: !!it.recall,
      onDone: (res) => {
        if (S.current.it !== it || S.current.done) return;
        S.current.done = true;
        S.results.push({ ...res, it });
        if (it.recall) reviewRecord(it.lesson.id, it.step, { revealed: !!res.revealed, hints: res.hints || 0 });
        if (res.xp) S.xp += res.xp;
        meters();
        skipBtn.hidden = true;
        nextBtn.disabled = false; nextBtn.classList.add('primary');
        hint.textContent = 'Enter';
        setTimeout(() => { if (S.current && S.current.it === it && nextBtn.isConnected) nextBtn.focus({ preventScroll: true }); }, 60);
      },
    });
    S.seen.add(it.ex.id);
    if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(() => { if (S.current && S.current.it === it && me.widget) safe(() => me.widget.focus()); }, 320);
    const top = root.getBoundingClientRect().top + window.scrollY - 70;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
  };
  const advance = () => {
    if (S.pos >= S.queue.length - 1) { summary(); return; }
    S.pos++;
    show();
  };
  skipBtn.addEventListener('click', () => {
    if (!S.current || S.current.done) return;
    S.current.done = true;
    S.results.push({ id: S.current.it.ex.id, ok: false, skipped: true, firstTry: false, xp: 0, fails: 0, hints: 0, it: S.current.it });
    meters();
    advance();
  });
  nextBtn.addEventListener('click', () => { if (!nextBtn.disabled) advance(); });
  finishBtn.addEventListener('click', () => summary());
  const onKey = (e) => {
    if (V !== me || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !S.current) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.cm-editor, [contenteditable="true"], [data-editor], .ex-order'))) return;
    if (document.querySelector('.fx-level, dialog[open]')) return;
    if (e.key === 'ArrowRight' && S.current.done && !nextBtn.disabled && nav.isConnected) { e.preventDefault(); advance(); }
  };
  document.addEventListener('keydown', onKey);
  me.cleanup.push(() => document.removeEventListener('keydown', onKey));

  function summary() {
    if (V !== me) return;
    if (me.widget) { safe(() => me.widget.destroy()); me.widget = null; }
    S.current = null;
    const res = S.results;
    const n = res.length;
    if (!n) { location.hash = '#/practica'; return; }
    const ok = res.filter((r) => r.ok).length;
    const first = res.filter((r) => r.firstTry).length;
    const failed = res.filter((r) => !r.ok);
    const acc = ok / n;
    const mins = Math.max(1, Math.round((Date.now() - S.t0) / 60000));
    const improved = [...S.cmd0.entries()].map(([c, lv0]) => ({ c, lv0, lv1: cmdLv(c) })).filter((x) => x.lv1 > x.lv0);
    const msg = acc === 1 ? 'Sesión perfecta.' : acc >= 0.8 ? 'Muy bien.' : 'Repite las falladas ahora que las tienes frescas.';
    const wrap = h('div', { class: 'lp-step lp-in pr-sum' });
    wrap.appendChild(h('div', { class: `lp-end-hero${acc >= 0.8 ? ' is-complete' : ''}` },
      h('div', { class: 'lp-end-big' }, h('b', null, `${Math.round(acc * 100)}`), h('span', null, '%'), h('small', null, 'aciertos')),
      h('div', { class: 'lp-end-txt' },
        h('div', { class: 'lp-kicker' }, cfg.endless ? `Ronda ${S.round} terminada` : 'Sesión terminada'),
        h('h2', null, `${ok} de ${n} ${n === 1 ? 'ejercicio resuelto' : 'ejercicios resueltos'}`),
        h('p', { class: 'muted' }, msg),
        h('div', { class: 'lp-end-stats' }, stat(`${first}`, 'a la primera'), stat(`+${S.xp}`, 'XP ganado'), stat(`${mins} min`, 'de práctica')))));
    if (improved.length) {
      wrap.appendChild(h('div', { class: 'lp-end-card' }, h('h3', null, 'Comandos que han subido de nivel'),
        h('div', { class: 'pr-improved' }, improved.map((x) => h('span', { class: 'pr-imp' }, cmdChip(x.c), h('small', { class: 'muted' }, `${LEVEL_NAME[x.lv0]} → `), h('small', { class: `pr-imp-to l${x.lv1}` }, LEVEL_NAME[x.lv1]))))));
    }
    if (failed.length) {
      const list = h('ul', { class: 'lp-weak' });
      const seen = new Set();
      for (const r of failed) {
        if (seen.has(r.it.ex.id)) continue; seen.add(r.it.ex.id);
        list.appendChild(h('li', null,
          h('span', { class: `lp-weak-st ${r.revealed ? 'st-review' : 'st-tried'}` }, r.revealed ? '↻' : r.skipped ? '–' : '✗'),
          h('span', { class: 'lp-weak-t' }, r.it.ex.title || 'Ejercicio', h('small', { class: 'muted' }, ` · ${r.it.lesson.title}${r.revealed ? ' · viste la solución' : r.skipped ? ' · saltado' : ''}`)),
          h('span', { class: 'pr-weak-cmds' }, (r.it.ex.cmds || []).slice(0, 3).map(cmdChip))));
      }
      wrap.appendChild(h('div', { class: 'lp-end-card' }, h('h3', null, 'Para repetir'), list));
    }
    const actions = h('div', { class: 'lp-end-actions' });
    if (failed.length) {
      const ids = new Set();
      const items = failed.map((r) => r.it).filter((it) => !ids.has(it.ex.id) && ids.add(it.ex.id));
      actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: () => restart(items, true) }, `Repetir las falladas (${items.length})`));
    }
    actions.appendChild(h('button', { class: `btn${failed.length ? '' : ' primary'}`, type: 'button', onclick: () => restart(null, false) }, cfg.endless ? 'Otra ronda (nuevas variantes) →' : 'Otra sesión →'));
    if (cfg.lessonId) actions.appendChild(h('a', { class: 'btn ghost', href: `#/leccion/${encodeURIComponent(cfg.lessonId)}` }, 'Ir a la lección'));
    if (cfg.cmd) actions.appendChild(h('a', { class: 'btn ghost', href: `#/comandos/${encodeURIComponent(cfg.cmd)}` }, 'Ficha del comando'));
    actions.appendChild(h('a', { class: 'btn ghost', href: '#/practica' }, 'Volver a práctica'));
    wrap.appendChild(actions);
    root.replaceChildren(head, wrap);
    finishBtn.hidden = true;
    play(acc >= 0.8 ? 'unlock' : 'click');
    window.scrollTo({ top: 0 });
  }

  function restart(items, onlyFailed) {
    S.results = []; S.xp = 0; S.t0 = Date.now(); S.cmd0 = new Map();
    finishBtn.hidden = false;
    root.replaceChildren(head, prog, stage, nav);
    newRound(items ? (onlyFailed ? items : items) : null);
    meters();
    if (!S.queue.length) { location.hash = '#/practica'; return; }
    S.pos = 0; show();
  }

  newRound();
  if (S.queue.some((it) => KERNEL_KINDS.has(it.ex.kind))) startKernel();
  meters();
  S.pos = 0;
  show();
}

function explainStep(it) {
  if (it.recall) return it.step;
  const steps = it.lesson.steps || [];
  for (let i = it.step - 1; i >= 0; i--) if (steps[i] && steps[i].type === 'explain') return i;
  return it.step;
}
export default { mount, unmount };
