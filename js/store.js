// store.js (SHELL) — progreso del alumno en localStorage (SPEC §4 y §7).
// Sin dependencias: lo importan todos los módulos.

const KEY = 'wolframlab-aero-v1';
const META_KEY = 'wolframlab-aero-meta';
const VERSION = 1;
const COMBO_WINDOW = 30 * 60 * 1000; // el combo caduca tras 30 min sin acertar

const RANKS = [
  'Pasajero', 'Cadete', 'Alumno piloto', 'Piloto de planeador', 'Piloto privado', 'Piloto comercial',
  'Comandante', 'Piloto de pruebas', 'Ingeniero de vuelo', 'Jefe de escuadrilla', 'Astronauta',
  'Especialista de misión', 'Comandante de misión', 'Director de vuelo', 'Ingeniero jefe', 'Leyenda aeroespacial',
];

/* ---------- fechas (día local) ---------- */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayToDate(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function dayDiff(a, b) { // días de a → b
  return Math.round((dayToDate(b) - dayToDate(a)) / 86400000);
}

/* ---------- estado ---------- */
function defaults() {
  return {
    v: VERSION, xp: 0, streak: 0, best: 0, lastDay: null, combo: 0, comboTs: 0,
    ex: {}, cmd: {}, lesson: {}, exams: [], days: {},
    settings: { sound: true, fx: true },
    created: Date.now(),
  };
}
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function migrate(raw) {
  const base = defaults();
  if (!isObj(raw)) return base;
  // v futura: se respeta lo que se entienda. v ausente/antigua: se completa con los valores por defecto.
  const s = { ...base, ...raw };
  s.v = VERSION;
  s.xp = Math.max(0, Number(s.xp) || 0);
  s.streak = Math.max(0, Number(s.streak) || 0);
  s.best = Math.max(Number(s.best) || 0, s.streak);
  s.combo = Math.max(0, Number(s.combo) || 0);
  for (const k of ['ex', 'cmd', 'lesson', 'days']) if (!isObj(s[k])) s[k] = {};
  if (!Array.isArray(s.exams)) s.exams = [];
  s.settings = { ...base.settings, ...(isObj(raw.settings) ? raw.settings : {}) };
  if (!s.created) s.created = Date.now();
  return s;
}

let memoryOnly = false;
function read(key) {
  try { const t = localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { memoryOnly = true; }
}

let state = migrate(read(KEY));
let meta = read(META_KEY) || {}; // {lessonId:{n, ex:[ids], min, cmds:[..]}} — caché derivada, no es progreso
const subs = new Set();

function normalizeOnLoad() {
  // racha rota si el último día de estudio es anterior a ayer
  if (state.lastDay && dayDiff(state.lastDay, dayKey()) > 1) state.streak = 0;
  if (state.comboTs && Date.now() - state.comboTs > COMBO_WINDOW) state.combo = 0;
  // limpia días viejos (se guardan ~120)
  const keys = Object.keys(state.days).sort();
  while (keys.length > 120) delete state.days[keys.shift()];
}
normalizeOnLoad();

function save() { write(KEY, state); }
function emit(evt) {
  for (const cb of [...subs]) { try { cb(state, evt || { type: 'change' }); } catch (e) { console.error('[store] listener', e); } }
}
function commit(evts) {
  save();
  const list = Array.isArray(evts) ? evts : [evts];
  if (!list.length) emit();
  else for (const e of list) emit(e);
}

/* ---------- niveles ---------- */
export function levelOf(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1; }
export function xpForLevel(level) { return 50 * (level - 1) * (level - 1); }
export function rankName(level) { return RANKS[Math.min(RANKS.length, Math.max(1, level)) - 1]; }

function levelInfo(xp = state.xp) {
  const level = levelOf(xp);
  const from = xpForLevel(level), to = xpForLevel(level + 1);
  return { level, xp, from, to, into: xp - from, need: to - from, pct: (xp - from) / (to - from), title: rankName(level), nextTitle: rankName(level + 1) };
}

/* ---------- día / racha ---------- */
function todayRec() {
  const k = dayKey();
  return (state.days[k] ||= { ex: 0, ok: 0, xp: 0, cmds: 0 });
}
function touchDay(evts) {
  const k = dayKey();
  if (state.lastDay === k) return;
  const gap = state.lastDay ? dayDiff(state.lastDay, k) : null;
  state.streak = gap === 1 ? state.streak + 1 : 1;
  state.best = Math.max(state.best || 0, state.streak);
  state.lastDay = k;
  evts.push({ type: 'streak', streak: state.streak, continued: gap === 1 });
}
function addXp(amount, evts, extra) {
  amount = Math.max(0, Math.round(Number(amount) || 0));
  if (!amount) return 0;
  const before = levelOf(state.xp);
  state.xp += amount;
  todayRec().xp += amount;
  evts.push({ type: 'xp', amount, ...(extra || {}) });
  const after = levelOf(state.xp);
  if (after > before) evts.push({ type: 'level', level: after, title: rankName(after) });
  return amount;
}

/* ---------- comandos ---------- */
function cmdLevel(name) {
  const c = state.cmd[name];
  if (!c) return 0;
  if ((c.ok || 0) >= 3) return 3;
  if ((c.ok || 0) >= 1) return 2;
  return (c.seen || 0) > 0 ? 1 : 0;
}

/* ---------- API ---------- */
export const store = {
  get state() { return state; },
  get settings() { return state.settings; },
  get memoryOnly() { return memoryOnly; },
  KEY,

  /** cb(state, evt) tras cada cambio. evt.type: change|xp|level|streak|cmd|exercise|lesson|exam|settings|reset|import. Devuelve la función para desuscribir. */
  on(cb) { subs.add(cb); return () => subs.delete(cb); },

  /** Registra un intento. Suma XP solo la primera vez que sale bien. Devuelve un resumen útil para la interfaz. */
  markExercise(exId, { ok = false, cmds = [], xp } = {}) {
    if (!exId) return null;
    const evts = [];
    const now = Date.now();
    const prev = state.ex[exId];
    const rec = prev ? { ...prev } : { ok: false, tries: 0, ts: now };
    const wasOk = !!rec.ok;
    rec.tries = (rec.tries || 0) + 1;
    rec.ts = now;
    if (ok) { rec.ok = true; if (!wasOk) rec.okTs = now; }
    state.ex[exId] = rec;

    touchDay(evts);
    const day = todayRec();
    day.ex += 1;

    const list = [...new Set((cmds || []).filter((c) => typeof c === 'string' && c))];
    let newCmds = 0;
    for (const name of list) {
      const before = cmdLevel(name);
      const c = (state.cmd[name] ||= { seen: 0, ok: 0, last: now });
      c.seen = (c.seen || 0) + 1;
      c.last = now;
      if (ok) c.ok = (c.ok || 0) + 1; else c.fail = (c.fail || 0) + 1;
      const after = cmdLevel(name);
      if (after !== before) {
        if (before < 2 && after >= 2) { newCmds += 1; }
        if (after === 3) c.learned = now;
        evts.push({ type: 'cmd', name, level: after, from: before });
      }
    }
    day.cmds = (day.cmds || 0) + newCmds;

    let gained = 0;
    const first = ok && !wasOk;
    if (ok) {
      day.ok += 1;
      state.combo = (state.comboTs && now - state.comboTs > COMBO_WINDOW ? 0 : state.combo) + 1;
      state.comboTs = now;
      if (first) gained = addXp(xp == null ? 10 : xp, evts, { exId });
    } else {
      state.combo = 0;
    }
    // lección completada si todos sus ejercicios están resueltos y se ha llegado al final
    const lessonId = exId.replace(/-e\d+[a-z]?$/i, '');
    if (ok && lessonId !== exId) maybeFinishLesson(lessonId, evts);

    evts.unshift({ type: 'exercise', exId, ok, first, combo: state.combo });
    commit(evts);
    const li = levelInfo();
    return { ok, first, xp: gained, combo: state.combo, streak: state.streak, level: li.level, leveledUp: evts.some((e) => e.type === 'level'), tries: rec.tries };
  },

  exercise(exId) { return state.ex[exId]; },

  cmdLevel,
  cmd(name) { return state.cmd[name]; },

  markSeen(cmdName) {
    if (!cmdName || typeof cmdName !== 'string') return;
    const before = cmdLevel(cmdName);
    const now = Date.now();
    const c = (state.cmd[cmdName] ||= { seen: 0, ok: 0, last: now });
    // ver la misma ficha/explicación muchas veces seguidas no infla el contador
    if (c.seen > 0 && c.seenTs && now - c.seenTs < 60000) return;
    c.seen = (c.seen || 0) + 1;
    c.seenTs = now;
    c.last = now;
    const after = cmdLevel(cmdName);
    commit(after !== before ? [{ type: 'cmd', name: cmdName, level: after, from: before }] : []);
  },

  /** Guarda el paso actual (índice 0…n-1). `total` es opcional: si se da (o se conoce por data.js) se usa para el %. */
  setLessonStep(lessonId, i, total) {
    if (!lessonId) return;
    i = Math.max(0, Number(i) || 0);
    const L = (state.lesson[lessonId] ||= { step: 0, done: false });
    L.step = i;
    L.max = Math.max(L.max || 0, i);
    L.ts = Date.now();
    if (total > 0) L.n = total;
    const evts = [{ type: 'lesson', lessonId, step: i }];
    state.last = { lessonId, step: i, ts: L.ts };
    maybeFinishLesson(lessonId, evts);
    commit(evts);
  },

  completeLesson(lessonId) {
    const L = (state.lesson[lessonId] ||= { step: 0, done: false });
    if (L.done) return;
    L.done = true; L.doneTs = Date.now();
    commit([{ type: 'lesson', lessonId, done: true }]);
  },

  lessonDone(lessonId) { return !!state.lesson[lessonId]?.done; },

  /** 0..1. Mezcla pasos visitados y ejercicios resueltos (si se conoce la lección). */
  lessonProgress(lessonId) {
    const L = state.lesson[lessonId];
    if (L?.done) return 1;
    const m = meta[lessonId];
    const n = m?.n || L?.n || 0;
    const exIds = m?.ex || [];
    const exOk = exIds.length ? exIds.filter((id) => state.ex[id]?.ok).length : countOkByPrefix(lessonId);
    const visited = L ? Math.min(n || Infinity, (L.max ?? L.step ?? 0) + 1) : 0;
    if (!n) return L || exOk ? Math.min(.9, .05 + exOk * .06) : 0;
    if (!exIds.length) return Math.max(0, Math.min(.99, visited / n)); // sin lista de ejercicios: solo pasos
    return Math.max(0, Math.min(.99, (visited + exOk) / (n + exIds.length)));
  },

  /** {done, total|null} de ejercicios de una lección. */
  lessonExercises(lessonId) {
    const m = meta[lessonId];
    if (m?.ex?.length) return { done: m.ex.filter((id) => state.ex[id]?.ok).length, total: m.ex.length };
    return { done: countOkByPrefix(lessonId), total: null };
  },

  /** data.js llama aquí al cargar una lección: permite calcular progresos sin volver a pedir el fichero. */
  noteLesson(lesson) {
    if (!lesson?.id || !Array.isArray(lesson.steps)) return;
    const ex = lesson.steps.filter((s) => s?.type === 'exercise' && s.ex?.id).map((s) => s.ex.id);
    const real = lesson.steps.filter((s) => s?.type === 'exercise' && s.ex?.real).length;
    const next = { n: lesson.steps.length, ex, real, min: lesson.minutes || null, cmds: lesson.commands || [], title: lesson.title || '' };
    const prev = meta[lesson.id];
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    meta[lesson.id] = next;
    write(META_KEY, meta);
  },
  lessonMeta(lessonId) { return meta[lessonId] || null; },

  recordExam(examId, { score = 0, max = 10, ms = 0 } = {}) {
    const evts = [];
    touchDay(evts);
    const prevBest = state.exams.filter((e) => e.id === examId).reduce((b, e) => Math.max(b, e.max ? e.score / e.max : 0), 0);
    const frac = max ? Math.max(0, Math.min(1, score / max)) : 0;
    state.exams.push({ id: examId, score, max, ms, ts: Date.now() });
    if (state.exams.length > 200) state.exams.shift();
    // hasta 100 XP por simulacro; al repetir solo cuenta la mejora sobre tu mejor nota
    addXp(Math.round(100 * Math.max(0, frac - prevBest)), evts, { examId });
    evts.unshift({ type: 'exam', examId, score, max });
    commit(evts);
  },
  examBest(examId) {
    const list = state.exams.filter((e) => e.id === examId);
    if (!list.length) return null;
    return list.reduce((b, e) => ((e.max ? e.score / e.max : 0) > (b.max ? b.score / b.max : -1) ? e : b), list[0]);
  },

  /** set('settings.sound', false) · set('lesson.1-p04.done', true) */
  set(path, value) {
    const parts = String(path).split('.');
    let o = state;
    while (parts.length > 1) {
      const k = parts.shift();
      if (!isObj(o[k])) o[k] = {};
      o = o[k];
    }
    o[parts[0]] = value;
    commit([{ type: String(path).startsWith('settings') ? 'settings' : 'change', path, value }]);
  },

  reset() {
    const keep = { ...state.settings };
    state = defaults();
    state.settings = keep;
    commit([{ type: 'reset' }]);
  },

  /* ----- extras (no están en la SPEC, son aditivos) ----- */
  levelInfo,
  level() { return levelOf(state.xp); },
  /** registro de hoy: {ex, ok, xp, cmds} */
  today() { return state.days[dayKey()] || { ex: 0, ok: 0, xp: 0, cmds: 0 }; },
  /** últimos n días (antiguo → hoy): [{day, ex, ok, xp, cmds}] */
  recentDays(n = 14) {
    const out = [];
    const d = new Date();
    d.setDate(d.getDate() - (n - 1));
    for (let i = 0; i < n; i++) {
      const k = dayKey(d);
      out.push({ day: k, ...(state.days[k] || { ex: 0, ok: 0, xp: 0, cmds: 0 }) });
      d.setDate(d.getDate() + 1);
    }
    return out;
  },
  /** ¿ha estudiado hoy? (la llama está "encendida") */
  studiedToday() { return state.lastDay === dayKey(); },
  counts() {
    const ex = Object.values(state.ex);
    const cmds = Object.keys(state.cmd);
    return {
      exOk: ex.filter((e) => e.ok).length, exTried: ex.length,
      learned: cmds.filter((c) => cmdLevel(c) === 3).length,
      practising: cmds.filter((c) => cmdLevel(c) === 2).length,
      seen: cmds.filter((c) => cmdLevel(c) === 1).length,
    };
  },

  exportJSON() { return JSON.stringify({ app: 'wolframlab-aero', exported: new Date().toISOString(), state }, null, 2); },
  importJSON(text) {
    let raw;
    try { raw = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('El fichero no es un JSON válido.'); }
    const s = isObj(raw?.state) ? raw.state : raw;
    if (!isObj(s) || !('xp' in s) || !isObj(s.ex)) throw new Error('El fichero no parece una copia de progreso de WolframLab Aero.');
    state = migrate(s);
    normalizeOnLoad();
    commit([{ type: 'import' }]);
    return state;
  },
  exportFile() {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wolframlab-aero-progreso-${dayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  },
  importFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('No se pudo leer el fichero.'));
      r.onload = () => { try { resolve(store.importJSON(String(r.result))); } catch (e) { reject(e); } };
      r.readAsText(file);
    });
  },
};

function countOkByPrefix(lessonId) {
  const p = lessonId + '-e';
  let n = 0;
  for (const k in state.ex) if (k.startsWith(p) && state.ex[k].ok) n++;
  return n;
}

function maybeFinishLesson(lessonId, evts) {
  const L = state.lesson[lessonId];
  const m = meta[lessonId];
  if (!L || L.done || !m?.n) return;
  const atEnd = (L.max ?? L.step ?? 0) >= m.n - 1;
  const allOk = m.ex.every((id) => state.ex[id]?.ok);
  if (atEnd && allOk) {
    L.done = true; L.doneTs = Date.now();
    evts.push({ type: 'lesson', lessonId, done: true });
  }
}

// otra pestaña cambió el progreso → sincroniza
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try { state = migrate(JSON.parse(e.newValue)); emit({ type: 'change', external: true }); } catch { /* ignora */ }
  });
}

export default store;
