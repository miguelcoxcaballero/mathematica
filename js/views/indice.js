// Vista: índice de contenidos (#/indice) — la ruta de aprendizaje, de lo simple a lo completo, como una página de documentación.
import { store } from '../store.js?v=1794351634';
import { loadCourse, loadCommands, loadAllLessons, safe, flatUnits, nextUnit, yearProgress, lessonHref, cmdHref } from '../data.js?v=1794351634';
import { h, icon, yearBadge, emptyState, skeleton, fmtDate } from '../fx.js?v=1794351634';

let alive = false;
let root = null;

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

function unitState(u, nextId) {
  if (store.lessonDone(u.lesson)) return 'done';
  if (u.lesson === nextId) return 'next';
  if (store.lessonProgress(u.lesson) > 0) return 'doing';
  return 'todo';
}

function unitRow(u, n, nextId, newCmds) {
  const st = unitState(u, nextId);
  const pct = store.lessonProgress(u.lesson);
  const ex = store.lessonExercises(u.lesson);
  const meta = store.lessonMeta(u.lesson);
  const mins = u.minutes || meta?.min;
  // comandos nuevos de la unidad: primero las funciones (lo que más se teclea), sin opciones ni constantes
  const allCmds = newCmds.get(u.lesson) || (meta?.cmds || []).map((name) => ({ name }));
  const cmds = allCmds.slice(0, 8);
  const side = [];
  if (st === 'done') side.push(h('span', { class: 'ok' }, 'Completada'));
  else if (pct > 0) side.push(h('span', null, `${Math.round(pct * 100)} %`), h('div', { class: `progress y${u.year}` }, h('i', { style: { width: `${Math.round(pct * 100)}%` } })));
  if (mins && st !== 'done') side.push(h('span', null, fmtMin(mins)));

  return h('li', { class: `idx-row s-${st} y${u.year}`, id: `u-${u.lesson}`, dataset: { lesson: u.lesson } },
    h('span', { class: 'idx-n', 'aria-hidden': 'true', html: st === 'done' ? icon('check', 15) : '' }, st === 'done' ? null : String(n)),
    h('div', { class: 'idx-main' },
      h('div', { class: 'idx-line' },
        yearBadge(u.year),
        h('span', { class: 'idx-prac' }, u.practice || u.lesson),
        h('a', { class: 'idx-title', href: lessonHref(u.lesson) }, u.title),
        st === 'next' ? h('span', { class: 'idx-tag' }, pct > 0 ? 'Continuar' : 'Siguiente') : null),
      u.topics?.length ? h('p', { class: 'idx-topics' }, u.topics.join(' · ')) : null,
      cmds.length ? h('p', { class: 'idx-cmds sqs' }, cmds.map((c) => h('a', { class: `l${store.cmdLevel(c.name)}`, href: cmdHref(c.name), title: 'Comando nuevo en esta unidad' }, c.name)), allCmds.length > cmds.length ? h('span', { class: 'more-n' }, `+${allCmds.length - cmds.length}`) : null) : null),
    h('div', { class: 'idx-side' }, side,
      ex.total ? h('span', null, `${ex.done}/${ex.total} ejercicios`) : u.nExercisesReal ? h('span', null, `${u.nExercisesReal} ${u.nExercisesReal === 1 ? 'ejercicio real' : 'ejercicios reales'}`) : null));
}

function examRow(e) {
  const best = store.examBest(e.id);
  const nota = best ? String(Math.round((best.score / (best.max || 10)) * 100) / 10).replace('.', ',') : null;
  return h('li', { class: `idx-row y${e.year}${best ? ' s-done' : ''}` },
    h('span', { class: 'idx-n', 'aria-hidden': 'true', html: best ? icon('check', 15) : '' }),
    h('div', { class: 'idx-main' },
      h('div', { class: 'idx-line' }, yearBadge(e.year), h('span', { class: 'idx-prac' }, 'Simulacro'), h('a', { class: 'idx-title', href: `#/simulacro/${encodeURIComponent(e.id)}` }, e.title)),
      e.description ? h('p', { class: 'idx-topics' }, e.description) : null),
    h('div', { class: 'idx-side' }, nota ? h('span', { class: 'ok' }, `Mejor nota ${nota}`) : null, e.durationMin ? h('span', null, `${e.durationMin} min`) : null, e.date ? h('span', null, fmtDate(e.date + 'T12:00:00')) : null));
}

function evalBox(s) {
  const ev = s.evaluation;
  if (!ev || (!ev.format && !ev.notes?.length && !ev.mathematicaWeight)) return null;
  return h('details', { class: 'idx-eval' },
    h('summary', null, 'Cómo se evalúa Mathematica en esta asignatura'),
    h('div', { class: 'idx-eval-b' },
      ev.mathematicaWeight ? h('p', null, h('b', null, 'Peso: '), ev.mathematicaWeight) : null,
      ev.format ? h('p', null, ev.format) : null,
      ev.notes?.length ? h('ul', null, ev.notes.map((n) => h('li', null, n))) : null));
}

function build(course, cmds) {
  const units = flatUnits(course).filter((u) => u.lesson);
  const nx = nextUnit(course);
  const nextId = nx && !nx.allDone ? nx.unit.lesson : null;
  const newCmds = new Map();
  if (cmds) {
    const rank = { function: 0, operator: 1, constant: 2, option: 3 };
    for (const c of cmds.commands) if (c.firstLesson) { if (!newCmds.has(c.firstLesson)) newCmds.set(c.firstLesson, []); newCmds.get(c.firstLesson).push(c); }
    for (const list of newCmds.values()) list.sort((a, b) => (rank[a.kind] ?? 1) - (rank[b.kind] ?? 1) || b.freq - a.freq);
  }
  const doneN = units.filter((u) => store.lessonDone(u.lesson)).length;
  const minsLeft = units.filter((u) => !store.lessonDone(u.lesson)).reduce((s, u) => s + (u.minutes || store.lessonMeta(u.lesson)?.min || 0) * (1 - store.lessonProgress(u.lesson)), 0);

  const page = h('div', { class: 'page idx' });
  page.appendChild(h('header', { class: 'page-head' },
    h('h1', null, 'Índice de contenidos'),
    h('p', null, 'Cada unidad es una práctica real de tu carrera, ordenadas de lo más simple a lo más completo. Nada está bloqueado: el orden es una recomendación.'),
    h('p', { class: 'idx-now' },
      `${doneN} de ${units.length} lecciones completadas`, minsLeft > 0 ? ` · quedan unas ${fmtMin(Math.round(minsLeft / 5) * 5)}` : '',
      nx && !nx.allDone ? [' · ', h('button', { class: 'btn link more', type: 'button', onclick: () => focusUnit(nx.unit.lesson) }, `Siguiente: ${nx.unit.practice || nx.unit.title}`)] : null)));

  let n = 0;
  for (const y of course.years || []) {
    const yp = yearProgress(course, y.year);
    const yMins = units.filter((u) => u.year === y.year).reduce((s, u) => s + (u.minutes || 0), 0);
    const sec = h('section', { class: `idx-year y${y.year}`, id: `idx-y${y.year}` });
    sec.appendChild(h('header', { class: 'idx-yhead' },
      yearBadge(y.year, `${y.year}º curso`),
      h('h2', null, String(y.label || '').replace(/^\d+º\s*·\s*/, '') || `${y.year}º`),
      y.state ? h('span', { class: 'muted' }, y.state) : null,
      h('span', { class: 'num' }, `${yp.done}/${yp.units} lecciones${yMins ? ` · ${fmtMin(yMins)}` : ''}`)));

    for (const s of y.subjects || []) {
      const sub = h('div', { class: 'idx-subj' },
        h('div', { class: 'idx-subj-head' }, h('h3', null, s.name), h('span', null, [s.semester ? (/anual/i.test(s.semester) ? 'anual' : `semestre ${s.semester}`) : null, s.state].filter(Boolean).join(' · '))),
        s.summary ? h('p', { class: 'idx-subj-sum' }, s.summary) : null,
        evalBox(s));
      for (const b of s.blocks || []) {
        const us = (b.units || []).filter((u) => u.lesson);
        if (!us.length) continue;
        const bDone = us.filter((u) => store.lessonDone(u.lesson)).length;
        sub.appendChild(h('h4', { class: 'idx-block' }, h('span', null, b.name), h('small', null, `${bDone}/${us.length}`)));
        const ol = h('ol', { class: 'idx-list' });
        for (const u of us) { n += 1; ol.appendChild(unitRow({ ...u, year: y.year, subject: s.name, block: b.name }, n, nextId, newCmds)); }
        sub.appendChild(ol);
      }
      const exams = (course.exams || []).filter((e) => Number(e.year) === y.year && (e.subject === s.name || e.subject === s.id));
      if (exams.length) {
        sub.appendChild(h('h4', { class: 'idx-block' }, h('span', null, 'El examen'), h('small', null, `${exams.length} ${exams.length === 1 ? 'simulacro' : 'simulacros'}`)));
        sub.appendChild(h('ol', { class: 'idx-list' }, exams.map(examRow)));
      }
      sec.appendChild(sub);
    }
    page.appendChild(sec);
  }
  return page;
}

function jump(year) {
  const el = root?.querySelector(`#idx-y${year}`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 46, behavior: 'smooth' });
}
function focusUnit(lesson) {
  const el = root?.querySelector(`#u-${CSS.escape(lesson)}`);
  if (!el) return;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 150, behavior: 'smooth' });
  el.classList.remove('idx-flash'); void el.offsetWidth; el.classList.add('idx-flash');
  el.querySelector('.idx-title')?.focus({ preventScroll: true });
}

export default {
  async mount(el, params) {
    alive = true; root = el;
    el.appendChild(h('div', { class: 'page idx' }, skeleton(6, 'skel-page')));
    const [course, cmds] = await Promise.all([safe(loadCourse()), safe(loadCommands())]);
    if (!alive) return;
    if (!course || !flatUnits(course).length) {
      el.replaceChildren(h('div', { class: 'page idx' }, emptyState({ title: 'El índice se está preparando', text: 'Todavía no está publicado el plan del curso. Mientras, puedes escribir en el cuaderno libre.', actions: [h('a', { class: 'btn primary', href: '#/cuaderno' }, 'Abrir el cuaderno')] })));
      return;
    }
    el.replaceChildren(build(course, cmds));
    const y = Number(params?.query?.curso);
    if (y) setTimeout(() => alive && jump(y), 120);

    // en segundo plano: carga las lecciones para conocer nº de ejercicios; repinta una vez si cambia algo
    const sig = () => JSON.stringify(flatUnits(course).map((u) => store.lessonMeta(u.lesson)?.n || 0));
    const before = sig();
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 400));
    idle(async () => {
      await loadAllLessons();
      if (!alive || sig() === before) return;
      const sy = window.scrollY;
      el.replaceChildren(build(course, cmds));
      window.scrollTo(0, sy);
    });
  },
  update(params) {
    const y = Number(params?.query?.curso);
    if (y) jump(y);
  },
  unmount() { alive = false; root = null; },
};
