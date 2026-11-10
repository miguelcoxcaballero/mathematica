// views/simulacro.js (LEARN) — exam simulator (SPEC §9).
//   #/simulacros            list of mock exams (grouped by year, best score, attempts, countdown to the real exam)
//   #/simulacro/<examId>    intro → timed run (questions with numeric boxes + free notebook) → grading → review
import { store } from '../store.js?v=1794351414';
import * as data from '../data.js?v=1794351414';
import { kernel } from '../kernel-client.js?v=1794351414';
import { createNotebook } from '../notebook.js?v=1794351414';
import * as fx from '../fx.js?v=1794351414';
import { ensureCss, h, md, mdInline, yearBadge, safe, play, exclusive, kernelReady, startKernel, kernelPill, codeBlock, mountGhost } from '../exercise.js?v=1794351414';

const KEY = (id) => `wolframlab-aero-exam-${id}`;
const WARN_AT = [600, 300, 60]; // seconds left → warning
let V = null;

/* ============================================================ helpers */
const load = (id) => safe(() => JSON.parse(localStorage.getItem(KEY(id))), null);
const save = (id, st) => safe(() => localStorage.setItem(KEY(id), JSON.stringify(st)));
const clear = (id) => safe(() => localStorage.removeItem(KEY(id)));
const toast = (msg, kind) => safe(() => fx.toast(msg, kind));

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'menos de 1 min';
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '—');
  if (Number.isInteger(v) && Math.abs(v) < 1e9) return String(v);
  const a = Math.abs(v);
  const s = a !== 0 && (a < 1e-4 || a >= 1e7) ? v.toExponential(5) : String(+v.toPrecision(7));
  return s.replace('.', ',').replace(/e([+-]?)(\d+)/, ' ×10^$1$2').replace('^+', '^');
}
function fmtScore(x) { return (Math.round(x * 100) / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }); }
function daysTo(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y) return null;
  const t = new Date(y, (m || 1) - 1, d || 1), now = new Date();
  return Math.round((t - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}
function fmtDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return safe(() => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d)), dateStr);
}
function countdownLabel(days) {
  if (days == null) return '';
  if (days < 0) return 'ya pasó';
  if (days === 0) return '¡es hoy!';
  if (days === 1) return 'falta 1 día';
  return `faltan ${days} días`;
}

/** Plain number typed by the student ("3,14", "-1.2e-3", "1.5*10^3", ".5") → number, or null if it is not a plain number. */
export function parsePlain(text) {
  let s = String(text ?? '').trim().replace(/\s+/g, '').replace(/−/g, '-').replace(/[×·]/g, '*');
  if (!s) return null;
  if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
  else if (/^[+-]?(\d+,\d*|,\d+)([eE][+-]?\d+|\*10\^\(?[+-]?\d+\)?)?$/.test(s)) s = s.replace(',', '.');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+)|\*10\^\(?([+-]?\d+)\)?|\*\^([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]) * Math.pow(10, +(m[2] || m[3] || m[4] || 0));
  return Number.isFinite(v) ? v : null;
}
/** Number printed by the kernel in InputForm ("6.283185307179586", "1.*^-7", "3", "2.5`") → number or null. */
function parseKernelNumber(text) {
  const s = String(text ?? '').trim().replace(/`[\d.]*/g, '').replace(/\s+/g, '');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:\*\^([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]) * Math.pow(10, +(m[2] || 0));
  return Number.isFinite(v) ? v : null;
}
/** Evaluates a student answer: plain number, or an expression (1/3, 2 Pi, Sqrt[2]…) through the kernel. → {value|null, how} */
async function evalAnswer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: null, how: 'empty' };
  const plain = parsePlain(raw);
  if (plain != null) return { value: plain, how: 'plain' };
  let expr = raw.replace(/π/g, 'Pi').replace(/−/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
  if (!/[[\]{}]/.test(expr)) expr = expr.replace(/(\d),(\d)/g, '$1.$2'); // decimal comma outside function calls
  try {
    if (!kernelReady()) await Promise.race([Promise.resolve(kernel.start()), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90000))]);
    const res = await exclusive(() => kernel.run(`N[(${expr})]`));
    const outs = ((res && res.items) || []).filter((it) => it.kind === 'out' && it.type === 'expr');
    const last = outs[outs.length - 1];
    const v = last ? parseKernelNumber(last.text != null ? last.text : last.plain) : null;
    return { value: v, how: v == null ? 'notnum' : 'kernel' };
  } catch (e) {
    return { value: null, how: 'nokernel' };
  }
}
function isClose(a, v, tol) {
  const t = tol > 0 ? tol : 1e-3;
  return Math.abs(a - v) <= t * Math.max(1, Math.abs(v)) + 1e-12;
}
function partList(exam) {
  const out = [];
  (exam.questions || []).forEach((q, qi) => {
    const parts = q.parts || [];
    const numeric = parts.filter((p) => (p.answerType || 'numeric') === 'numeric');
    const declared = numeric.reduce((s, p) => s + (typeof p.points === 'number' ? p.points : 0), 0);
    parts.forEach((p, pi) => {
      const type = p.answerType || 'numeric';
      let pts = typeof p.points === 'number' ? p.points : type === 'numeric' ? ((q.points || numeric.length) - declared) / Math.max(1, numeric.filter((x) => typeof x.points !== 'number').length) : 0;
      if (!(pts > 0) && type === 'numeric') pts = 1;
      out.push({ q, qi, p, pi, key: `${qi}.${pi}`, type, pts: type === 'numeric' ? pts : 0 });
    });
  });
  return out;
}

/* ============================================================ mount */
function parse(params) {
  const p = params && typeof params === 'object' ? { ...params } : {};
  if (!p.examId && !p.list) {
    const segs = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map((s) => safe(() => decodeURIComponent(s), s));
    if (segs[0] === 'simulacro' && segs[1]) p.examId = segs[1]; else p.list = true;
  }
  if (!p.query) { const q = location.hash.split('?')[1]; p.query = q ? Object.fromEntries(new URLSearchParams(q)) : {}; }
  return p;
}

async function mount(el, params) {
  ensureCss();
  const p = parse(params);
  const me = (V = { el, alive: true, cleanup: [] });
  el.innerHTML = '';
  const root = h('div', { class: 'sm' }, h('div', { class: 'lx-loading' }, h('i', { class: 'lx-spin' }), 'Cargando…'));
  el.appendChild(root);
  me.root = root;
  if (p.examId || p.exam) return mountExam(me, p.examId || p.exam, p.query || {});
  return mountList(me);
}

function unmount() {
  const me = V;
  if (!me) return;
  V = null; me.alive = false;
  me.cleanup.forEach((f) => safe(f));
  if (me.el) me.el.innerHTML = '';
}

/* ============================================================ list */
async function mountList(me) {
  const { root } = me;
  const course = await data.loadCourse().catch(() => null);
  if (V !== me) return;
  const exams = (course && course.exams) || [];
  const avail = new Map(await Promise.all(exams.map((e) => data.loadExam(e.id).then((x) => [e.id, x], () => [e.id, null]))));
  if (V !== me) return;
  const attempts = (id) => (safe(() => store.state.exams, []) || []).filter((a) => a.id === id);

  const head = h('header', { class: 'pr-head' }, h('h1', null, 'Simulacros'),
    h('p', { class: 'muted' }, 'Exámenes de Mathematica como los de verdad: tiempo limitado, cuaderno libre y respuestas numéricas en casillas. Al entregar ves la nota, el valor correcto y la solución paso a paso.'));
  const nodes = [head];

  // countdown to the next real exam
  const dated = [];
  for (const e of exams) { const d = daysTo(e.date); if (d != null && d >= 0) dated.push({ d, date: e.date, label: `Examen de Mathematica · ${e.subject || ''}`.trim() }); }
  for (const k of (course && course.keyDates) || []) { const d = daysTo(k.date); if (d != null && d >= 0 && /examen/i.test(k.label || '')) dated.push({ d, date: k.date, label: k.label }); }
  dated.sort((a, b) => a.d - b.d);
  if (dated.length) {
    const nx = dated[0];
    nodes.push(h('div', { class: `sm-count${nx.d <= 14 ? ' is-soon' : ''}` },
      h('div', { class: 'sm-count-n' }, h('b', null, String(nx.d)), h('span', null, nx.d === 1 ? 'día' : 'días')),
      h('div', { class: 'sm-count-t' }, h('div', { class: 'lp-kicker' }, 'Cuenta atrás'), h('strong', null, nx.label), h('span', { class: 'muted' }, fmtDate(nx.date)))));
  }
  if (!exams.length) {
    nodes.push(h('div', { class: 'lx-empty' }, h('h2', null, 'Todavía no hay simulacros publicados'), h('p', { class: 'muted' }, 'Mientras tanto, la práctica aleatoria es el mejor entrenamiento.'), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/practica' }, 'Ir a práctica'))));
    root.replaceChildren(...nodes);
    return;
  }
  const groups = new Map();
  for (const e of exams) { const y = Number(e.year) || 0; if (!groups.has(y)) groups.set(y, []); groups.get(y).push(e); }
  const soon = (list) => Math.min(...list.map((e) => { const d = daysTo(e.date); return d != null && d >= 0 ? d : 1e9; }));
  const order = [...groups.entries()].sort((a, b) => soon(a[1]) - soon(b[1]) || b[0] - a[0]);
  for (const [y, list] of order) {
    const grid = h('div', { class: 'sm-grid' });
    for (const e of list) {
      const exam = avail.get(e.id);
      const att = attempts(e.id);
      const best = att.reduce((b, a) => (b == null || (a.max ? a.score / a.max : 0) > (b.max ? b.score / b.max : 0) ? a : b), null);
      const st = load(e.id);
      const running = st && st.phase === 'run' && (st.mode === 'study' || st.startTs + st.durMs > Date.now());
      const d = daysTo(e.date);
      const nQ = exam ? (exam.questions || []).length : 0;
      const bestPct = best ? (best.max ? best.score / best.max : 0) : 0;
      const card = h('article', { class: `sm-card${exam ? '' : ' is-off'}${running ? ' is-running' : ''}`, dataset: { year: y } },
        h('div', { class: 'sm-card-top' }, yearBadge(y), h('span', { class: 'sm-card-sub' }, e.subject || ''), running ? h('span', { class: 'badge real' }, 'en curso') : null, !exam ? h('span', { class: 'badge muted' }, 'en preparación') : null),
        h('h3', { class: 'sm-card-t' }, e.title || e.id),
        e.description ? h('p', { class: 'sm-card-d muted' }, e.description) : null,
        h('div', { class: 'sm-card-meta' },
          h('span', null, `${e.durationMin || (exam && exam.durationMin) || '—'} min`),
          nQ ? h('span', null, `${nQ} preguntas`) : null,
          e.date ? h('span', { class: d != null && d >= 0 && d <= 14 ? 'sm-soon' : '' }, `${fmtDate(e.date)}${d != null ? ` · ${countdownLabel(d)}` : ''}`) : null),
        h('div', { class: 'sm-card-foot' },
          best ? h('div', { class: `sm-best${bestPct >= 0.5 ? ' is-pass' : ''}` }, h('b', null, fmtScore(best.max ? (10 * best.score) / best.max : best.score)), h('span', null, `mejor nota · ${att.length} ${att.length === 1 ? 'intento' : 'intentos'}`))
            : h('div', { class: 'sm-best is-none' }, h('b', null, '—'), h('span', null, 'sin intentos')),
          exam ? h('a', { class: 'btn primary', href: `#/simulacro/${encodeURIComponent(e.id)}` }, running ? 'Continuar →' : best ? 'Repetir →' : 'Empezar →') : h('span', { class: 'btn', 'aria-disabled': 'true' }, 'Pronto')));
      grid.appendChild(card);
    }
    nodes.push(h('section', { class: 'pr-sec' }, h('h3', { class: 'pr-year' }, y ? `${y}º curso` : 'General'), grid));
  }
  root.replaceChildren(...nodes);
}

/* ============================================================ exam */
async function mountExam(me, id, query) {
  const { root } = me;
  let exam = null;
  try { exam = await data.loadExam(id); } catch (e) { exam = null; }
  const course = await data.loadCourse().catch(() => null);
  if (V !== me) return;
  if (!exam || !Array.isArray(exam.questions) || !exam.questions.length) {
    root.replaceChildren(h('div', { class: 'lx-empty' }, h('h2', null, 'Este simulacro aún no está publicado'),
      h('p', { class: 'muted' }, `No se ha encontrado “${id}”.`), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/simulacros' }, 'Ver simulacros'), h('a', { class: 'btn', href: '#/practica' }, 'Practicar'))));
    return;
  }
  const entry = ((course && course.exams) || []).find((e) => e.id === exam.id) || {};
  const X = (me.X = {
    exam, id: exam.id, entry,
    year: Number(exam.year || entry.year) || 0,
    durMs: Math.max(1, Number(exam.durationMin || entry.durationMin) || 60) * 60000,
    parts: partList(exam),
  });
  const st = load(X.id);
  if (st && st.phase === 'run') {
    if (st.mode !== 'study' && st.startTs + st.durMs <= Date.now()) {
      // time ran out while the student was away → grade what was saved
      toast('Se acabó el tiempo mientras estabas fuera: se ha entregado lo que tenías.', 'warn');
      return finish(me, st, true);
    }
    return renderRun(me, st, true);
  }
  if (st && st.phase === 'done' && st.result && query.ver) return renderResults(me, st);
  renderIntro(me, st);
}

function examHead(X, kicker) {
  return h('header', { class: 'pr-shead sm-head' },
    h('a', { class: 'lp-back', href: '#/simulacros', title: 'Volver a simulacros' }, '← Simulacros'),
    h('div', { class: 'lp-titles' }, h('div', { class: 'lp-crumbs' }, yearBadge(X.year), h('span', null, [X.exam.subject || X.entry.subject, kicker].filter(Boolean).join(' · '))), h('h1', { class: 'lp-title' }, X.exam.title || X.id)));
}

/* ---------- intro ---------- */
function renderIntro(me, prev) {
  const { root, X } = me;
  const { exam } = X;
  const nParts = X.parts.length;
  const total = X.parts.reduce((s, p) => s + p.pts, 0);
  const att = (safe(() => store.state.exams, []) || []).filter((a) => a.id === X.id);
  const best = att.reduce((b, a) => Math.max(b, a.max ? (10 * a.score) / a.max : a.score), -1);
  const d = daysTo(X.entry.date);
  let mode = 'exam';
  const mk = (val, title, text) => {
    const b = h('button', { type: 'button', class: `sm-mode${val === mode ? ' on' : ''}`, role: 'radio', 'aria-checked': String(val === mode), dataset: { mode: val } }, h('strong', null, title), h('span', null, text));
    b.addEventListener('click', () => { mode = val; for (const x of modes.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); } startBtn.textContent = mode === 'exam' ? 'Empezar simulacro →' : 'Empezar en modo estudio →'; });
    return b;
  };
  const modes = h('div', { class: 'sm-modes', role: 'radiogroup', 'aria-label': 'Modo' },
    mk('exam', 'Examen cronometrado', `${Math.round(X.durMs / 60000)} minutos, sin pausa. La nota cuenta para tu registro.`),
    mk('study', 'Modo estudio', 'Sin reloj. Compruebas cada apartado al momento y puedes ver su solución.'));
  const startBtn = h('button', { class: 'btn primary sm-start', type: 'button', 'data-nosfx': '' }, 'Empezar simulacro →');
  startBtn.addEventListener('click', () => {
    const st = { v: 1, phase: 'run', mode, startTs: Date.now(), durMs: X.durMs, answers: {}, checked: {}, loaded: {}, cells: null, warned: [] };
    save(X.id, st);
    play('exam');
    if (kernelReady()) exclusive(() => kernel.reset()).catch(() => {});
    renderRun(me, st, false);
  });
  const pill = kernelPill({ always: true });
  me.cleanup.push(pill.destroy);
  if (kernel.status === 'idle') startKernel();
  const card = h('div', { class: 'sm-intro' },
    exam.intro ? h('div', { class: 'lx-md sm-intro-md', html: md(exam.intro) }) : null,
    h('div', { class: 'lp-end-stats' }, stat(`${Math.round(X.durMs / 60000)} min`, 'duración'), stat(String(exam.questions.length), 'preguntas'), stat(String(nParts), 'apartados'), stat(fmtScore(total), 'puntos'),
      best >= 0 ? stat(fmtScore(best), `mejor nota · ${att.length} ${att.length === 1 ? 'intento' : 'intentos'}`) : null,
      d != null && d >= 0 ? stat(String(d), 'días para el examen real') : null),
    h('h3', null, 'Cómo funciona'),
    h('ul', { class: 'sm-rules' },
      h('li', null, h('b', null, 'Cuaderno libre al lado. '), 'Calcula lo que quieras con Mathematica y escribe solo el resultado en cada casilla.'),
      h('li', null, h('b', null, 'Respuestas numéricas con tolerancia. '), 'Da al menos 4 cifras significativas. Vale punto o coma decimal, y también expresiones como ', h('code', null, '1/3'), ' o ', h('code', null, '2 Pi'), '.'),
      h('li', null, h('b', null, '“Definir estos datos”'), ' carga en el kernel las matrices o funciones del enunciado. Todo lo demás lo escribes tú.'),
      h('li', null, h('b', null, 'El reloj no se para. '), 'Si sales de la página, sigue corriendo; tus respuestas se guardan solas. Al llegar a cero se entrega automáticamente.'),
      h('li', null, h('b', null, 'Al entregar'), ' ves tu nota sobre 10, el valor correcto de cada apartado y la solución, que podrás teclear para verla funcionar.')),
    exam.source ? h('p', { class: 'muted sm-source' }, `Origen: ${exam.source}`) : null,
    h('h3', null, 'Elige el modo'), modes,
    h('div', { class: 'row sm-intro-actions' }, startBtn,
      prev && prev.phase === 'done' && prev.result ? h('button', { class: 'btn', type: 'button', onclick: () => renderResults(me, prev) }, 'Ver mi última corrección') : null,
      h('a', { class: 'btn ghost', href: '#/simulacros' }, 'Volver'), pill.el));
  root.className = 'sm';
  root.replaceChildren(examHead(X, 'Simulacro'), card);
}
function stat(v, l) { return h('div', { class: 'lx-stat' }, h('b', null, v), h('span', null, l)); }

/* ---------- run ---------- */
function renderRun(me, st, resumed) {
  const { root, X } = me;
  const { exam } = X;
  const study = st.mode === 'study';
  const R = (me.R = { st, timer: 0, nb: null, saveT: 0, inputs: new Map(), done: false });
  st.answers = st.answers || {}; st.checked = st.checked || {}; st.loaded = st.loaded || {}; st.warned = st.warned || [];
  const persist = () => { if (R.done) return; if (R.nb) { const cells = safe(() => R.nb.getCells(), null); if (Array.isArray(cells)) st.cells = cells.map((c) => (typeof c === 'string' ? c : (c && c.code) || '')); } save(X.id, st); };
  const persistSoon = () => { clearTimeout(R.saveT); R.saveT = setTimeout(persist, 350); };

  /* top bar */
  const clock = h('div', { class: 'sm-clock', role: 'timer', 'aria-live': 'off', title: study ? 'Tiempo transcurrido' : 'Tiempo restante' }, h('span', { class: 'sm-clock-l' }, study ? 'Tiempo' : 'Quedan'), h('b', null, '--:--'));
  const clockB = clock.querySelector('b');
  const answered = h('span', { class: 'sm-answered' });
  const submitBtn = h('button', { class: 'btn primary sm-submit', type: 'button', 'data-nosfx': '' }, study ? 'Terminar y ver resumen' : 'Entregar');
  const tabs = h('div', { class: 'sm-tabs', role: 'tablist' },
    h('button', { type: 'button', role: 'tab', class: 'sm-tab on', dataset: { tab: 'q' }, 'aria-selected': 'true' }, 'Preguntas'),
    h('button', { type: 'button', role: 'tab', class: 'sm-tab', dataset: { tab: 'nb' }, 'aria-selected': 'false' }, 'Cuaderno'));
  const confirmBox = h('div', { class: 'sm-confirm', hidden: true });
  const timeline = h('i');
  const bar = h('div', { class: `sm-bar${study ? ' is-study' : ''}` },
    h('div', { class: 'sm-bar-row' },
      h('div', { class: 'sm-bar-t' }, yearBadge(X.year), h('strong', null, exam.title || X.id), study ? h('span', { class: 'badge muted' }, 'modo estudio') : null),
      answered, clock, submitBtn),
    h('div', { class: 'sm-timeline', 'aria-hidden': 'true' }, timeline), tabs, confirmBox);

  /* questions */
  const qs = h('div', { class: 'sm-qs' });
  const updAnswered = () => {
    const n = X.parts.filter((p) => String(st.answers[p.key] || '').trim()).length;
    answered.textContent = `${n}/${X.parts.length} respondidos`;
    answered.classList.toggle('is-all', n === X.parts.length);
  };
  exam.questions.forEach((q, qi) => {
    const parts = X.parts.filter((p) => p.qi === qi);
    const qPts = parts.reduce((s, p) => s + p.pts, 0);
    const card = h('article', { class: 'sm-q', id: `sm-q-${qi + 1}` },
      h('header', { class: 'sm-q-h' }, h('h3', null, q.title || `Pregunta ${qi + 1}`), qPts ? h('span', { class: 'sm-pts' }, `${fmtScore(qPts)} ${qPts === 1 ? 'pt' : 'pts'}`) : null),
      q.prompt ? h('div', { class: 'lx-md sm-q-p', html: md(q.prompt) }) : null);
    if (q.setup) {
      // the data of the statement can be defined in the kernel without typing it (nothing is written in the notebook)
      const btn = h('button', { class: 'btn sm-load', type: 'button' }, 'Definir estos datos en el kernel');
      const mark = () => { btn.classList.add('is-loaded'); btn.textContent = 'Datos definidos · volver a definir'; };
      if (st.loaded[qi] && resumed) btn.textContent = 'Volver a definir los datos';
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.innerHTML = '<i class="lx-spin"></i> Definiendo…';
        try {
          await exclusive(() => kernel.run(q.setup));
          st.loaded[qi] = true; persist(); mark();
          toast(`Datos de “${q.title || 'la pregunta ' + (qi + 1)}” definidos: ya puedes usarlos en tu cuaderno.`, 'ok');
        } catch (e) { btn.textContent = 'Reintentar'; toast('No se pudieron definir los datos. ¿Está listo el motor?', 'bad'); }
        btn.disabled = false;
      });
      card.appendChild(h('div', { class: 'sm-setup' }, h('div', { class: 'ex-ref-l' }, 'Datos del enunciado'), codeBlock(q.setup), btn));
    }
    for (const part of parts) {
      const { p, key, type } = part;
      const idAttr = `sm-a-${key.replace('.', '-')}`;
      const input = type === 'text'
        ? h('textarea', { class: 'sm-input sm-input--text', id: idAttr, rows: '2', placeholder: 'Tu respuesta (se autoevalúa al final)', spellcheck: 'false' })
        : h('input', { class: 'sm-input', id: idAttr, type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'resultado', 'aria-label': `Respuesta ${p.label || ''}` });
      input.value = st.answers[key] || '';
      const mark = h('span', { class: 'sm-mark', 'aria-live': 'polite' });
      const row = h('div', { class: 'sm-part', dataset: { key } },
        h('label', { class: 'sm-part-l', for: idAttr }, p.label ? h('b', null, p.label) : null, h('span', { class: 'lx-md', html: mdInline(p.prompt || '') }), part.pts ? h('span', { class: 'sm-pts sm-pts--s' }, `${fmtScore(part.pts)} ${part.pts === 1 ? 'pt' : 'pts'}`) : type === 'text' ? h('span', { class: 'sm-pts sm-pts--s' }, 'autoevaluación') : null),
        h('div', { class: 'sm-ans' }, type === 'numeric' ? h('span', { class: 'sm-eq', 'aria-hidden': 'true' }, '=') : null, input, mark));
      input.addEventListener('input', () => { st.answers[key] = input.value; delete st.checked[key]; row.classList.remove('is-ok', 'is-bad'); mark.textContent = ''; updAnswered(); persistSoon(); });
      if (study && type === 'numeric') {
        const chk = h('button', { class: 'btn sm-chk', type: 'button', 'data-nosfx': '' }, 'Comprobar');
        const extra = h('div', { class: 'sm-part-x' });
        const showSol = () => {
          extra.replaceChildren(h('div', { class: 'sm-sol' }, h('div', { class: 'sm-sol-v' }, 'Valor correcto: ', h('code', null, fmtNum(p.value))), p.solution ? codeBlock(p.solution) : null, p.explain ? h('div', { class: 'lx-md', html: md(p.explain) }) : null));
        };
        const paint = (c) => {
          row.classList.toggle('is-ok', !!c.ok); row.classList.toggle('is-bad', !c.ok);
          mark.textContent = c.ok ? '✓' : '✗';
          if (c.ok) extra.replaceChildren(p.explain ? h('div', { class: 'sm-sol lx-md', html: md(p.explain) }) : '');
          else extra.replaceChildren(h('span', { class: 'muted' }, c.how === 'notnum' ? 'Eso no se evalúa a un número. ' : c.how === 'nokernel' ? 'No se pudo evaluar la expresión (motor no disponible). ' : 'No coincide. Revisa el cálculo… '), h('button', { class: 'lx-link', type: 'button', onclick: showSol }, 'ver solución'));
        };
        const run = async () => {
          if (!input.value.trim()) { input.focus(); return; }
          chk.disabled = true; chk.innerHTML = '<i class="lx-spin"></i>';
          const a = await evalAnswer(input.value);
          chk.disabled = false; chk.textContent = 'Comprobar';
          if (V !== me) return;
          const ok = a.value != null && isClose(a.value, Number(p.value), p.tol);
          st.checked[key] = { ok, how: a.how }; persist();
          paint(st.checked[key]);
          play(ok ? 'ok' : 'fail');
          if (!ok) { row.classList.remove('lx-shake'); void row.offsetWidth; row.classList.add('lx-shake'); }
        };
        chk.addEventListener('click', run);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
        row.querySelector('.sm-ans').appendChild(chk);
        row.appendChild(extra);
        if (st.checked[key]) paint(st.checked[key]);
      } else if (type === 'numeric') {
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const all = [...qs.querySelectorAll('.sm-input')]; const nx = all[all.indexOf(input) + 1];
          if (nx) nx.focus();
        });
      }
      R.inputs.set(key, input);
      card.appendChild(row);
    }
    qs.appendChild(card);
  });
  qs.appendChild(h('div', { class: 'sm-qs-end' }, h('button', { class: 'btn primary', type: 'button', 'data-nosfx': '', onclick: () => askSubmit() }, study ? 'Terminar y ver resumen' : 'Entregar examen')));

  /* notebook */
  const nbHost = h('div', { class: 'sm-nb-host' });
  const nbCol = h('div', { class: 'sm-nb' }, nbHost);
  const cols = h('div', { class: 'sm-cols', dataset: { tab: 'q' } }, qs, nbCol);
  root.className = 'sm sm-run';
  root.replaceChildren(bar, cols);
  try {
    const cells = Array.isArray(st.cells) && st.cells.length ? st.cells.map((code) => ({ code })) : [{ code: '' }];
    R.nb = createNotebook(nbHost, { cells, title: 'Cuaderno', onResult: () => persistSoon(), onChange: () => persistSoon() });
  } catch (e) { console.error('[learn] createNotebook', e); nbHost.appendChild(h('p', { class: 'muted' }, 'No se pudo crear el cuaderno.')); }
  if (kernel.status === 'idle') startKernel();
  if (resumed && Object.keys(st.loaded).length) toast('Simulacro recuperado. Si recargaste la página, vuelve a evaluar tus celdas y a definir los datos.', 'info');

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.sm-tab'); if (!b) return;
    cols.dataset.tab = b.dataset.tab;
    for (const x of tabs.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }
    if (b.dataset.tab === 'nb') safe(() => R.nb && R.nb.focus());
  });

  /* timer */
  const tick = () => {
    if (V !== me || R.done) return;
    const now = Date.now();
    if (study) { clockB.textContent = fmtClock(now - st.startTs); return; }
    const left = st.startTs + st.durMs - now;
    clockB.textContent = fmtClock(left);
    timeline.style.width = `${Math.max(0, Math.min(100, (100 * (now - st.startTs)) / st.durMs))}%`;
    const s = Math.ceil(left / 1000);
    bar.classList.toggle('is-warn', s <= 600 && s > 60);
    bar.classList.toggle('is-danger', s <= 60);
    clock.classList.toggle('is-warn', s <= 600 && s > 60);
    clock.classList.toggle('is-danger', s <= 60);
    for (const w of WARN_AT) {
      if (s <= w && s > w - 5 && !st.warned.includes(w)) {
        st.warned.push(w); persistSoon();
        play('tick'); setTimeout(() => play('tick'), 180); setTimeout(() => play('tick'), 360);
        toast(w === 60 ? 'Queda 1 minuto. Repasa que has escrito todas las respuestas.' : `Quedan ${w / 60} minutos.`, 'warn');
        clock.classList.remove('lx-pop'); void clock.offsetWidth; clock.classList.add('lx-pop');
      }
    }
    if (s <= 10 && s > 0 && s !== R.lastTick) { R.lastTick = s; play('tick'); }
    if (left <= 0) { toast('Tiempo agotado: examen entregado.', 'warn'); submit(true); }
  };
  R.timer = setInterval(tick, 250);
  tick();
  const autosave = setInterval(persist, 5000);
  me.cleanup.push(() => { clearInterval(R.timer); clearInterval(autosave); clearTimeout(R.saveT); persist(); if (R.nb) safe(() => R.nb.destroy()); });
  updAnswered();

  function askSubmit() {
    const missing = X.parts.filter((p) => !String(st.answers[p.key] || '').trim()).length;
    confirmBox.hidden = false;
    confirmBox.replaceChildren(
      h('span', null, study ? '¿Terminar la sesión de estudio?' : missing ? `Te ${missing === 1 ? 'queda 1 apartado' : `quedan ${missing} apartados`} sin responder. ¿Entregar ya?` : '¿Entregar el examen? No podrás cambiar las respuestas.'),
      h('button', { class: 'btn primary', type: 'button', 'data-nosfx': '', onclick: () => submit(false) }, study ? 'Sí, terminar' : 'Sí, entregar'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { confirmBox.hidden = true; } }, 'Seguir'));
    confirmBox.scrollIntoView({ block: 'nearest' });
  }
  submitBtn.addEventListener('click', askSubmit);

  function submit(auto) {
    if (R.done) return;
    persist();
    R.done = true;
    clearInterval(R.timer);
    if (R.nb) { safe(() => R.nb.destroy()); R.nb = null; }
    finish(me, st, auto);
  }
}

/* ---------- grading ---------- */
async function finish(me, st, auto) {
  const { root, X } = me;
  root.className = 'sm';
  root.replaceChildren(examHead(X, 'Corrigiendo'), h('div', { class: 'sm-grading' }, h('i', { class: 'lx-spin' }), h('strong', null, 'Corrigiendo tus respuestas…'), h('span', { class: 'muted' }, 'Las expresiones como 1/3 o 2 Pi se evalúan con Mathematica.')));
  const usedMs = st.mode === 'study' ? Date.now() - st.startTs : Math.min(st.durMs, Date.now() - st.startTs);
  const graded = {};
  let got = 0, total = 0;
  for (const part of X.parts) {
    const raw = String((st.answers || {})[part.key] || '').trim();
    if (part.type !== 'numeric') { graded[part.key] = { raw, type: 'text' }; continue; }
    total += part.pts;
    const a = await evalAnswer(raw);
    if (V !== me) return;
    const ok = a.value != null && isClose(a.value, Number(part.p.value), part.p.tol);
    if (ok) got += part.pts;
    graded[part.key] = { raw, value: a.value, how: a.how, ok, pts: ok ? part.pts : 0 };
  }
  const score = total ? Math.round((1000 * got) / total) / 100 : 0;
  st.phase = 'done';
  st.result = { score, got, total, usedMs, graded, auto: !!auto, ts: Date.now(), mode: st.mode };
  save(X.id, st);
  if (st.mode !== 'study') safe(() => store.recordExam(X.id, { score, max: 10, ms: usedMs }));
  play('exam');
  if (score >= 5 && st.mode !== 'study') setTimeout(() => safe(() => fx.confetti({ y: 0.3, count: 50, power: 0.8 })), 350); // milestone: exam passed (small)
  renderResults(me, st);
}

/* ---------- results ---------- */
function renderResults(me, st) {
  const { root, X } = me;
  const { exam } = X;
  const res = st.result;
  const study = res.mode === 'study';
  const att = (safe(() => store.state.exams, []) || []).filter((a) => a.id === X.id);
  const best = att.reduce((b, a) => Math.max(b, a.max ? (10 * a.score) / a.max : a.score), -1);
  const pass = res.score >= 5;
  const nOk = X.parts.filter((p) => res.graded[p.key] && res.graded[p.key].ok).length;
  const nNum = X.parts.filter((p) => p.type === 'numeric').length;
  const msg = res.score >= 9 ? 'Sobresaliente. Estás listo para el examen de verdad.' : res.score >= 7 ? 'Notable. Repasa los fallos y vuelve a intentarlo otro día.' : pass ? 'Aprobado justo: mira dónde se te fue cada punto.' : 'Todavía no llega. Estudia las soluciones de abajo y repite: la segunda vuelta siempre sale mejor.';
  const hero = h('div', { class: `lp-end-hero sm-hero${pass ? ' is-complete' : ' is-fail'}` },
    h('div', { class: 'lp-end-big' }, h('b', null, fmtScore(res.score)), h('span', null, '/ 10'), h('small', null, 'nota')),
    h('div', { class: 'lp-end-txt' },
      h('div', { class: 'lp-kicker' }, study ? 'Modo estudio · resumen' : res.auto ? 'Tiempo agotado · examen entregado' : 'Examen entregado'),
      h('h2', null, study ? 'Sesión de estudio terminada' : res.score >= 9 ? 'Sobresaliente' : res.score >= 7 ? 'Notable' : pass ? 'Aprobado' : 'Todavía no'),
      h('p', { class: 'muted' }, study ? 'En modo estudio la nota no se guarda en tu registro.' : msg),
      h('div', { class: 'lp-end-stats' }, stat(`${nOk}/${nNum}`, 'apartados correctos'), stat(fmtDur(res.usedMs), study ? 'de estudio' : `de ${Math.round(X.durMs / 60000)} min`), stat(`${fmtScore(res.got)}/${fmtScore(res.total)}`, 'puntos'), best >= 0 ? stat(fmtScore(best), 'tu mejor nota') : null)));
  const actions = () => h('div', { class: 'lp-end-actions' },
    h('button', { class: 'btn primary', type: 'button', onclick: () => { clear(X.id); renderIntro(me, null); window.scrollTo({ top: 0 }); } }, 'Repetir el simulacro'),
    h('a', { class: 'btn', href: '#/simulacros' }, 'Otros simulacros'),
    h('a', { class: 'btn ghost', href: '#/practica/aleatoria' }, 'Práctica aleatoria'));

  const list = h('div', { class: 'sm-review' });
  const nbs = [];
  exam.questions.forEach((q, qi) => {
    const parts = X.parts.filter((p) => p.qi === qi);
    const qGot = parts.reduce((s, p) => s + ((res.graded[p.key] && res.graded[p.key].pts) || 0), 0);
    const qTot = parts.reduce((s, p) => s + p.pts, 0);
    const card = h('article', { class: `sm-q sm-rq${qTot && qGot === qTot ? ' is-full' : qGot === 0 && qTot ? ' is-zero' : ''}` },
      h('header', { class: 'sm-q-h' }, h('h3', null, q.title || `Pregunta ${qi + 1}`), qTot ? h('span', { class: 'sm-pts' }, `${fmtScore(qGot)} / ${fmtScore(qTot)} pts`) : null),
      q.prompt ? h('div', { class: 'lx-md sm-q-p', html: md(q.prompt) }) : null);
    for (const part of parts) {
      const { p, key, type } = part;
      const g = res.graded[key] || { raw: '' };
      const row = h('div', { class: `sm-rpart ${type !== 'numeric' ? 'is-text' : g.ok ? 'is-ok' : g.raw ? 'is-bad' : 'is-blank'}` });
      row.appendChild(h('div', { class: 'sm-rpart-h' },
        h('span', { class: 'sm-rmark', 'aria-hidden': 'true' }, type !== 'numeric' ? '·' : g.ok ? '✓' : g.raw ? '✗' : '–'),
        h('div', { class: 'sm-part-l' }, p.label ? h('b', null, p.label) : null, h('span', { class: 'lx-md', html: mdInline(p.prompt || '') })),
        type === 'numeric' ? h('span', { class: 'sm-pts sm-pts--s' }, `${fmtScore(g.pts || 0)} / ${fmtScore(part.pts)}`) : h('span', { class: 'sm-pts sm-pts--s' }, 'autoevaluación')));
      const yours = !g.raw ? h('span', { class: 'muted' }, 'sin responder')
        : type !== 'numeric' ? h('span', null, g.raw)
          : h('span', null, h('code', null, g.raw), g.how === 'kernel' && g.value != null ? h('small', { class: 'muted' }, ` = ${fmtNum(g.value)}`) : g.how === 'notnum' ? h('small', { class: 'sm-note' }, ' · no se evalúa a un número') : g.how === 'nokernel' ? h('small', { class: 'sm-note' }, ' · no se pudo evaluar (motor no disponible)') : null);
      row.appendChild(h('div', { class: 'sm-cmp' },
        h('span', { class: 'ex-diff-l' }, 'Tu respuesta'), h('div', { class: 'sm-cmp-v yours' }, yours),
        h('span', { class: 'ex-diff-l' }, type === 'numeric' ? 'Valor correcto' : 'Respuesta modelo'), h('div', { class: 'sm-cmp-v right' }, h('code', null, type === 'numeric' ? fmtNum(Number(p.value)) : String(p.value ?? '—')), type === 'numeric' && p.tol ? h('small', { class: 'muted' }, ` (tolerancia ${p.tol})`) : null)));
      if (p.explain) row.appendChild(h('div', { class: 'sm-explain lx-md', html: md(p.explain) }));
      card.appendChild(row);
    }
    // reference solution: ghost cells to type (SPEC §11). The data and the earlier parts are evaluated silently first.
    const sols = parts.filter((part) => part.p.solution);
    if (sols.length) {
      const body = h('div', { class: 'sm-solbox-b' });
      const det = h('details', { class: 'sm-solbox' }, h('summary', null, 'Solución de referencia: tecléala para verla funcionar'), body);
      let built = false;
      det.addEventListener('toggle', () => {
        if (!det.open || built) return;
        built = true;
        if (q.setup) body.appendChild(h('div', { class: 'sm-solrow' }, h('div', { class: 'ex-ref-l' }, 'Datos del enunciado (se definen solos)'), codeBlock(q.setup)));
        let fresh = true;
        const ran = sols.map(() => false);
        sols.forEach((part, k) => {
          const host = h('div', { class: 'sm-solrow' }, part.p.label ? h('div', { class: 'ex-ref-l' }, `Apartado ${part.p.label}`) : null);
          body.appendChild(host);
          const g = mountGhost(host, part.p.solution, {
            before: async () => {
              if (fresh) { fresh = false; await kernel.reset(); if (q.setup) await kernel.run(q.setup); }
              for (let j = 0; j < k; j++) if (!ran[j]) { ran[j] = true; await kernel.run(sols[j].p.solution); }
            },
            onDone: () => { ran[k] = true; },
          });
          nbs.push(g);
        });
      });
      card.appendChild(det);
    }
    list.appendChild(card);
  });
  me.cleanup.push(() => nbs.forEach((n) => safe(() => n.destroy())));
  root.className = 'sm sm-res';
  root.replaceChildren(examHead(X, 'Corrección'), hero, actions(), h('h2', { class: 'sm-review-h' }, 'Corrección apartado por apartado'), list, actions());
  window.scrollTo({ top: 0 });
}

export default { mount, unmount };
