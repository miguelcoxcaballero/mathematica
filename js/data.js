// data.js (SHELL) — carga de datos con caché en memoria. Rutas relativas al sitio (GitHub Pages).
// SPEC §4: loadCourse, loadCommands, loadSchema, loadLesson(id), loadExam(id).  Extra: loadAllLessons() y utilidades.
import { store } from './store.js';

const ROOT = new URL('../', import.meta.url); // …/site/
// Modo desarrollo: `?fixtures=1` busca primero en dev/fixtures/ (los datos reales viven en data/).
const USE_FIXTURES = (() => { try { return new URLSearchParams(location.search).has('fixtures'); } catch { return false; } })();
const BASES = USE_FIXTURES ? ['data/', 'dev/fixtures/'] : ['data/'];

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
    freq: Number(c.freq) || 0,
  }));
  const byName = new Map(commands.map((c) => [c.name, c]));
  return { ...(Array.isArray(raw) ? {} : raw), commands, byName };
}

const FAMILY_COLORS = ['#22d3ee', '#7c5cff', '#ff9f43', '#3ddc97', '#ff5d73', '#ffd166', '#19e3c5', '#b25cff', '#5E81B5', '#EB6235', '#8FB032', '#f472b6', '#60a5fa', '#a3e635'];

function normSchema(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const fams = arr(s.families || s.familias || s.categories || s.cats);
  s.families = fams.map((f, i) => ({
    ...f,
    id: f.id || f.cat || f.key || f.name || `fam${i}`,
    name: f.name || f.title || f.label || f.id || `Familia ${i + 1}`,
    color: f.color || FAMILY_COLORS[i % FAMILY_COLORS.length],
    desc: f.desc || f.description || f.summary || f.text || '',
    idea: f.idea || f.pattern || f.patron || '',
    commands: arr(f.commands || f.cmds).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
  }));
  const models = arr(s.models || s.mentalModels || s.modelos || s.modelosMentales || s.concepts);
  s.models = models.map((m, i) => ({
    ...m,
    id: m.id || `m${i}`,
    title: m.title || m.name || `Idea ${i + 1}`,
    text: m.text || m.md || m.desc || m.body || '',
    cells: arr(m.cells || m.examples || m.example || m.code).map((c) => (typeof c === 'string' ? { code: c } : c)).filter((c) => c && c.code),
  }));
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

export function lessonHref(id, step) { return `#/leccion/${encodeURIComponent(id)}${step != null ? '/' + step : ''}`; }
export function cmdHref(name) { return `#/comandos/${encodeURIComponent(name)}`; }
export function notebookHref(code) { return `#/cuaderno?code=${encodeURIComponent(code)}`; }

export const KIND_LABEL = { code: 'Código', fix: 'Corregir', fill: 'Rellenar', order: 'Ordenar', mcq: 'Test', predict: 'Predecir' };
export const STATUS_LABEL = { hecha: 'Hecha', parcial: 'Parcial', pendiente: 'Pendiente' };
export const usingFixtures = USE_FIXTURES;
