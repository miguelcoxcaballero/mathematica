// data.js (SHELL) — carga de datos con caché en memoria. Rutas relativas al sitio (GitHub Pages).
// SPEC §4: loadCourse, loadCommands, loadSchema, loadLesson(id), loadExam(id).  Extra: loadAllLessons() y utilidades.
import { store } from './store.js?v=1794351916';

const ROOT = new URL('../', import.meta.url); // …/site/
const BASES = ['data/'];

const cache = new Map(); // ruta → Promise

export class DataError extends Error {
  constructor(msg, path, code) { super(msg); this.name = 'DataError'; this.path = path; this.code = code; }
}

async function fetchJSON(rel) {
  let lastErr = null;
  for (const base of BASES) {
    const url = new URL(base + rel, ROOT);
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) { lastErr = new DataError(`No existe ${rel} (${r.status})`, rel, 'missing'); continue; }
      const text = await r.text();
      try { return JSON.parse(text); } catch { lastErr = new DataError(`${rel} no es JSON válido`, rel, 'invalid'); }
    } catch (e) {
      lastErr = new DataError(`No se pudo cargar ${rel}: ${e.message}`, rel, 'network');
    }
  }
  throw lastErr || new DataError(`No se pudo cargar ${rel}`, rel, 'missing');
}

function cached(rel, post) {
  if (!cache.has(rel)) {
    const p = fetchJSON(rel).then((j) => (post ? post(j) : j));
    p.catch(() => cache.delete(rel)); // un fallo no se queda en caché: se puede reintentar
    cache.set(rel, p);
  }
  return cache.get(rel);
}

/* ---------- normalizadores (toleran pequeñas diferencias de forma) ---------- */
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const STATUS = { hecha: 'hecha', hecho: 'hecha', completa: 'hecha', done: 'hecha', parcial: 'parcial', partial: 'parcial', pendiente: 'pendiente', pending: 'pendiente' };

function normCourse(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  c.years = arr(c.years).map((y) => ({
    ...y,
    year: Number(y.year) || 1,
    label: y.label || `${y.year}º`,
    subjects: arr(y.subjects).map((s) => ({
      ...s,
      id: s.id || s.name,
      name: s.name || s.id || '',
      blocks: arr(s.blocks).map((b) => ({
        ...b,
        name: b.name || '',
        units: arr(b.units).map((u) => ({
          ...u,
          lesson: u.lesson || u.id || u.lessonId || '',
          practice: u.practice || '',
          title: u.title || u.practice || u.lesson || '',
          topics: arr(u.topics),
          status: STATUS[String(u.status || '').toLowerCase()] || 'pendiente',
          evidence: u.evidence || '',
          nExercisesReal: Number(u.nExercisesReal) || 0,
        })),
      })),
    })),
  }));
  c.exams = arr(c.exams);
  c.keyDates = arr(c.keyDates).filter((k) => k && k.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return c;
}

function normCommands(raw) {
  const list = Array.isArray(raw) ? raw : arr(raw?.commands);
  const commands = list.filter((c) => c && c.name).map((c) => ({
    ...c,
    cat: c.cat || c.family || 'otros',
    year: Number(c.year) || 1,
    syntax: arr(c.syntax),
    desc: c.desc || '',
    args: arr(c.args),
    examples: arr(c.examples).map((e) => (typeof e === 'string' ? { code: e } : e)).filter((e) => e && e.code),
    options: arr(c.options),
    related: arr(c.related),
    pitfalls: arr(c.pitfalls),
    usedIn: arr(c.usedIn),
    aka: arr(c.aka),
    of: arr(c.of),
    kind: c.kind || 'function',
    freq: Number(c.freq) || 0,
  }));
  const byName = new Map(commands.map((c) => [c.name, c]));
  return { ...(Array.isArray(raw) ? {} : raw), commands, byName };
}

// schema.json real: {anatomy:{example, parts:[{token, role, d}], rules:[…]}, mentalModels:[{id,title,idea,md,cells}],
//   families:[{id,title,idea,pattern,groups:[{title,commands:[…]}]}], flows:[{id,title,year,when,lessons,steps:[{cmd,d,code}]}]}
function normSchema(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const names = (list) => arr(list).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  const fams = arr(s.families || s.familias || s.categories || s.cats);
  s.families = fams.map((f, i) => {
    const groups = arr(f.groups).map((g) => ({ name: g.title || g.name || '', commands: names(g.commands) })).filter((g) => g.commands.length);
    const flat = groups.length ? groups.flatMap((g) => g.commands) : names(f.commands || f.cmds);
    return {
      ...f,
      id: f.id || f.cat || f.key || f.name || `fam${i}`,
      name: f.name || f.title || f.label || f.id || `Familia ${i + 1}`,
      desc: f.desc || f.description || f.summary || f.text || f.idea || '',
      pattern: f.pattern || f.patron || '',
      groups,
      commands: flat,
    };
  });
  const models = arr(s.models || s.mentalModels || s.modelos || s.modelosMentales || s.concepts);
  s.models = models.map((m, i) => ({
    ...m,
    id: m.id || `m${i}`,
    title: m.title || m.name || `Idea ${i + 1}`,
    idea: m.idea || '',
    text: m.text || m.md || m.desc || m.body || '',
    cells: arr(m.cells || m.examples || m.example || m.code).map((c) => (typeof c === 'string' ? { code: c } : c)).filter((c) => c && c.code),
  }));
  s.flows = arr(s.flows || s.recetas).filter((f) => f && f.title).map((f, i) => ({
    ...f,
    id: f.id || `f${i}`,
    year: Number(f.year) || 1,
    when: f.when || '',
    lessons: arr(f.lessons),
    steps: arr(f.steps).filter((st) => st && (st.code || st.d)),
  }));
  const a = s.anatomy && typeof s.anatomy === 'object' ? s.anatomy : {};
  s.anatomy = { ...a, parts: arr(a.parts), rules: arr(a.rules).filter((r) => typeof r === 'string') };
  return s;
}

/* ---------- API de la SPEC ---------- */
export function loadCourse() { return cached('course.json', normCourse); }
export function loadCommands() { return cached('commands.json', normCommands); }
export function loadSchema() { return cached('schema.json', normSchema); }
export function loadLesson(id) {
  return cached(`lessons/${encodeURIComponent(id)}.json`, (l) => { try { store.noteLesson(l); } catch { /* caché opcional */ } return l; });
}
export function loadExam(id) { return cached(`exams/${encodeURIComponent(id)}.json`); }

/** Devuelve null en vez de lanzar (para vistas que deben seguir pintando aunque falte un fichero). */
export function safe(promise) { return Promise.resolve(promise).catch(() => null); }

/** Todas las lecciones listadas en course.json (en orden). Tolera ficheros que falten. onEach(lesson, unit) opcional. */
export async function loadAllLessons(onEach) {
  const course = await safe(loadCourse());
  if (!course) return [];
  const units = flatUnits(course).filter((u) => u.lesson);
  const out = new Array(units.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < units.length) {
      const k = i++;
      const l = await safe(loadLesson(units[k].lesson));
      out[k] = l;
      if (l && onEach) { try { onEach(l, units[k]); } catch { /* sigue */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, units.length) }, worker));
  return out.filter(Boolean);
}

/* ---------- utilidades sobre el curso ---------- */
/** Aplana course.years → unidades con su contexto, en el orden recomendado. */
export function flatUnits(course) {
  const out = [];
  let idx = 0;
  for (const y of course?.years || []) {
    for (const s of y.subjects) {
      for (const b of s.blocks) {
        for (const u of b.units) {
          out.push({ ...u, year: y.year, yearLabel: y.label, subject: s.name, subjectId: s.id, block: b.name, idx: idx++ });
        }
      }
    }
  }
  return out;
}

/** Siguiente lección recomendada: la primera sin terminar empezada… o la primera sin terminar. */
export function nextUnit(course) {
  const units = flatUnits(course).filter((u) => u.lesson);
  if (!units.length) return null;
  const last = store.state.last?.lessonId;
  const lastU = last && units.find((u) => u.lesson === last);
  if (lastU && !store.lessonDone(last)) return { unit: lastU, resume: true };
  const firstOpen = units.find((u) => !store.lessonDone(u.lesson));
  if (!firstOpen) return { unit: units[units.length - 1], resume: false, allDone: true };
  return { unit: firstOpen, resume: store.lessonProgress(firstOpen.lesson) > 0 };
}

/** Progreso agregado de un curso (1 o 2): {units, done, pct, exDone, exTotal} */
export function yearProgress(course, year) {
  const units = flatUnits(course).filter((u) => u.year === year && u.lesson);
  let sum = 0, done = 0, exDone = 0, exTotal = 0, exKnown = true;
  for (const u of units) {
    const p = store.lessonProgress(u.lesson);
    sum += p;
    if (p >= 1) done++;
    const e = store.lessonExercises(u.lesson);
    exDone += e.done;
    if (e.total == null) exKnown = false; else exTotal += e.total;
  }
  return { units: units.length, done, pct: units.length ? sum / units.length : 0, exDone, exTotal: exKnown ? exTotal : null };
}

/* ---------- familias de comandos (esquema + lista de comandos) ---------- */
const CAT_LABEL = {
  sintaxis: 'Sintaxis básica', numeros: 'Números y expresiones', funciones: 'Funciones y programación', listas: 'Listas y tablas',
  ecuaciones: 'Ecuaciones', calculo: 'Cálculo', series: 'Series y sumas', vectorial: 'Cálculo en varias variables', lineal: 'Álgebra lineal',
  edo: 'Ecuaciones diferenciales', transformadas: 'Transformadas', compleja: 'Variable compleja', graficos2d: 'Gráficos 2D', graficos3d: 'Gráficos 3D',
};
const CAT_ORDER = Object.keys(CAT_LABEL);

/** Familias ordenadas: [{id, name, desc, commands:[cmd…], groups:[{name, commands:[cmd…]}]}]. Usa schema.json si existe;
 *  si no, agrupa por `cat` de commands.json. Deja en cada comando `c._fam` (id de su familia). */
export function familyIndex(schema, cmds) {
  if (!cmds?.commands?.length) return [];
  const fams = new Map();
  const famOf = new Map();   // comando → id de familia (según el esquema)
  const groupOf = new Map(); // comando → nombre de grupo (según el esquema)
  for (const f of schema?.families || []) {
    fams.set(f.id, { id: f.id, name: f.name, desc: f.desc || '', pattern: f.pattern || '', commands: [], groups: [], _order: f.groups.map((g) => g.name) });
    for (const n of f.commands) if (!famOf.has(n)) famOf.set(n, f.id);
    for (const g of f.groups) for (const n of g.commands) if (!groupOf.has(n)) groupOf.set(n, g.name);
  }
  for (const c of cmds.commands) {
    const id = famOf.get(c.name) || (fams.has(c.cat) ? c.cat : null) || c.cat || 'otros';
    if (!fams.has(id)) fams.set(id, { id, name: CAT_LABEL[id] || id.charAt(0).toUpperCase() + id.slice(1), desc: '', pattern: '', commands: [], groups: [], _order: [] });
    c._fam = id;
    c._group = groupOf.get(c.name) ?? c.group ?? '';
    fams.get(id).commands.push(c);
  }
  const out = [...fams.values()].filter((f) => f.commands.length);
  if (!schema?.families?.length) out.sort((a, b) => ((CAT_ORDER.indexOf(a.id) + 1) || 99) - ((CAT_ORDER.indexOf(b.id) + 1) || 99));
  for (const f of out) {
    const gs = new Map(f._order.map((n) => [n, []]));
    for (const c of f.commands) { if (!gs.has(c._group)) gs.set(c._group, []); gs.get(c._group).push(c); }
    f.groups = [...gs].filter(([, list]) => list.length).map(([name, commands]) => ({ name, commands }));
  }
  return out;
}

export function lessonHref(id, step) { return `#/leccion/${encodeURIComponent(id)}${step != null ? '/' + step : ''}`; }
export function cmdHref(name) { return `#/comandos/${encodeURIComponent(name)}`; }
export function notebookHref(code) { return `#/cuaderno?code=${encodeURIComponent(code)}`; }

export const KIND_LABEL = { code: 'Código', fix: 'Corregir', fill: 'Rellenar', order: 'Ordenar', mcq: 'Test', predict: 'Predecir' };
export const STATUS_LABEL = { hecha: 'Hecha', parcial: 'Parcial', pendiente: 'Pendiente' };
