// Vista: inicio (#/) — lo justo: continuar, próximo examen, progreso de 1º y 2º, y tres enlaces.
import { store } from '../store.js?v=1794353407';
import { loadCourse, safe, flatUnits, nextUnit, yearProgress, lessonHref } from '../data.js?v=1794353407';
import { h, yearBadge, fmtDate, skeleton } from '../fx.js?v=1794353407';

let off = null;

/* ---------- fechas clave ---------- */
function parseKeyDate(k) {
  const m = String(k.label || '').match(/(\d{1,2}):(\d{2})\s*h/);
  const [y, mo, d] = String(k.date).split('-').map(Number);
  return new Date(y, (mo || 1) - 1, d || 1, m ? Number(m[1]) : 9, m ? Number(m[2]) : 0, 0);
}
function upcomingDates(course) {
  const now = Date.now();
  return (course?.keyDates || [])
    .filter((k) => k.kind !== 'hoy')
    .map((k) => ({ ...k, at: parseKeyDate(k) }))
    .filter((k) => k.at.getTime() + 6 * 3600e3 > now)
    .sort((a, b) => a.at - b.at);
}
const isExam = (k) => k.kind === 'examen' || /examen/i.test(k.label || '');
function daysTo(at) {
  const a = new Date(at.getFullYear(), at.getMonth(), at.getDate()), n = new Date();
  return Math.max(0, Math.round((a - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000));
}

/* ---------- continuar ---------- */
function continueBlock(course) {
  const c = store.counts();
  const nx = course ? nextUnit(course) : null;
  const fresh = c.exTried === 0 && !store.state.last;
  const sec = h('section', { class: 'home-cont page-head' });
  if (!nx) {
    sec.append(h('span', { class: 'kicker' }, 'WolframLab Aero'), h('h1', null, 'Aprende Mathematica tecleándolo'),
      h('p', null, 'El índice del curso todavía se está preparando. Mientras tanto puedes escribir en el cuaderno libre.'),
      h('div', { class: 'home-actions', style: { marginTop: '18px' } }, h('a', { class: 'btn primary', href: '#/cuaderno' }, 'Abrir el cuaderno')));
    return sec;
  }
  const u = nx.unit;
  const pct = store.lessonProgress(u.lesson);
  const L = store.state.lesson[u.lesson];
  const ex = store.lessonExercises(u.lesson);
  const meta = store.lessonMeta(u.lesson);
  const bits = [u.subject, u.block].filter(Boolean);
  if (L && meta?.n && !L.done) bits.push(`paso ${Math.min(meta.n, (L.step || 0) + 1)} de ${meta.n}`);
  if (ex.total) bits.push(`${ex.done}/${ex.total} ejercicios`);
  if (u.minutes || meta?.min) bits.push(`≈ ${u.minutes || meta.min} min`);
  const step = L && !L.done && L.step > 0 ? L.step : undefined;

  sec.append(
    h('span', { class: 'kicker' }, fresh ? 'Empieza aquí' : nx.allDone ? 'Todo completado: repasa' : pct > 0 ? 'Continuar donde lo dejaste' : 'Siguiente lección'),
    h('h1', null, u.title),
    h('div', { class: 'home-meta' }, yearBadge(u.year), h('span', null, [u.practice, ...bits].filter(Boolean).join(' · '))),
    h('div', { class: `progress y${u.year}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)), 'aria-label': 'Progreso de la lección' }, h('i', { style: { width: `${Math.round(pct * 100)}%` } })),
    h('div', { class: 'home-actions' },
      h('a', { class: 'btn primary', href: lessonHref(u.lesson, step) }, nx.allDone ? 'Repasar' : pct > 0 ? 'Continuar' : 'Empezar'),
      h('a', { class: 'more', href: '#/indice' }, 'Ver el índice completo')));
  return sec;
}

/* ---------- próximo examen ---------- */
function examCol(course) {
  const col = h('section', { class: 'home-col' }, h('h2', { class: 'sec-title' }, 'Próximo examen'));
  const up = upcomingDates(course);
  const target = up.find((k) => isExam(k) && (k.exam || /mathematica/i.test(k.label || ''))) || up.find(isExam) || up[0];
  if (!target) { col.appendChild(h('p', { class: 'muted' }, 'No hay fechas próximas.')); return col; }
  const units = flatUnits(course).filter((x) => x.lesson);
  const exam = (course.exams || []).find((e) => e.id === target.exam) || (course.exams || []).find((e) => e.date === target.date);
  const subj = exam?.subject || (/(Matemáticas\s+[IVX]+)/.exec(target.label || '') || [])[1];
  const exYear = exam?.year || 2;
  let route = units.filter((x) => x.year < exYear || (subj ? x.subject === subj : x.year === exYear));
  if (!route.length) route = units;
  const left = route.filter((x) => !store.lessonDone(x.lesson)).length;
  const days = daysTo(target.at);
  const perWeek = left / Math.max(1, days / 7);
  const hasTime = /\d{1,2}:\d{2}\s*h/.test(target.label || '');
  const p2 = (n) => String(n).padStart(2, '0');
  col.append(
    h('p', { class: 'home-days' }, h('b', null, String(days)), days === 1 ? 'día' : 'días'),
    h('p', null, String(target.label || '').replace(/\s*·\s*\d{1,2}:\d{2}\s*h/, '')),
    h('p', { class: 'muted' }, fmtDate(target.at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (hasTime ? `, ${p2(target.at.getHours())}:${p2(target.at.getMinutes())} h` : '')),
    h('p', { class: 'muted' }, left === 0 ? 'Has completado todas las lecciones de la ruta.' : `Te quedan ${left} ${left === 1 ? 'lección' : 'lecciones'}: unas ${perWeek >= 10 ? 'diez o más' : String(Math.max(1, Math.round(perWeek)))} por semana.`),
    exam ? h('p', { style: { marginTop: '8px' } }, h('a', { class: 'more', href: `#/simulacro/${encodeURIComponent(exam.id)}` }, 'Hacer un simulacro')) : null);
  return col;
}

/* ---------- progreso por curso ---------- */
function progressCol(course) {
  const col = h('section', { class: 'home-col' }, h('h2', { class: 'sec-title' }, 'Progreso'));
  for (const y of course.years || []) {
    const yp = yearProgress(course, y.year);
    col.appendChild(h('a', { class: 'home-prog', href: `#/indice?curso=${y.year}` },
      yearBadge(y.year),
      h('span', { class: 'home-prog-n' }, (y.subjects || []).map((s) => s.name).join(' · ') || `${y.year}º`),
      h('span', { class: 'num' }, `${yp.done}/${yp.units}`),
      h('div', { class: `progress y${y.year}` }, h('i', { style: { width: `${Math.round(yp.pct * 100)}%` } }))));
  }
  const c = store.counts();
  col.appendChild(h('p', { class: 'muted' }, `${c.exOk} ${c.exOk === 1 ? 'ejercicio resuelto' : 'ejercicios resueltos'} · ${c.learned} ${c.learned === 1 ? 'comando dominado' : 'comandos dominados'}`));
  return col;
}

function linksCol() {
  const items = [
    ['#/practica/aleatoria', 'Práctica aleatoria', 'Ejercicios mezclados de lo que ya has visto.'],
    ['#/simulacros', 'Simulacros de examen', 'Con tiempo y casillas numéricas, como el real.'],
    ['#/cuaderno', 'Cuaderno libre', 'Una hoja en blanco para probar lo que quieras.'],
  ];
  return h('section', { class: 'home-col' }, h('h2', { class: 'sec-title' }, 'Ir a'),
    h('ul', { class: 'home-links' }, items.map(([href, t, d]) => h('li', null, h('a', { class: 'more', href }, t), h('small', null, d)))));
}

export default {
  async mount(el) {
    const page = h('div', { class: 'page wide home' }, skeleton(4, 'skel-page'));
    el.appendChild(page);
    const course = await safe(loadCourse());
    const build = () => {
      const kids = [continueBlock(course)];
      const cols = h('div', { class: 'home-cols' });
      if (course) cols.append(examCol(course), progressCol(course));
      cols.appendChild(linksCol());
      kids.push(cols);
      page.replaceChildren(...kids);
    };
    build();
    off = store.on((_, evt) => { if (evt?.external || evt?.type === 'import' || evt?.type === 'reset') build(); });
  },
  unmount() { off?.(); off = null; },
};
