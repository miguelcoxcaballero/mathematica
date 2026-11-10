// Vista: índice de contenidos (#/indice) — la ruta de aprendizaje, de lo simple a lo completo.
import { store } from '../store.js';
import { loadCourse, loadCommands, loadAllLessons, safe, flatUnits, nextUnit, yearProgress, lessonHref, cmdHref } from '../data.js';
import { h, icon, ring, yearBadge, emptyState, skeleton, fmtDate } from '../fx.js';

let alive = false;
let root = null;

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

function unitState(u, nextId) {
  if (store.lessonDone(u.lesson)) return 'done';
  if (u.lesson === nextId) return 'next';
  if (store.lessonProgress(u.lesson) > 0) return 'doing';
  return 'todo';
}

function unitCard(u, n, nextId, newCmds, passedNext) {
  const st = unitState(u, nextId);
  const pct = store.lessonProgress(u.lesson);
  const ex = store.lessonExercises(u.lesson);
  const meta = store.lessonMeta(u.lesson);
  const mins = u.minutes || meta?.min;
  const cmds = (newCmds.get(u.lesson) || meta?.cmds || []).slice(0, 9);
  const more = (newCmds.get(u.lesson) || meta?.cmds || []).length - cmds.length;

  const label = { done: 'Completada', doing: `En curso · ${Math.round(pct * 100)}%`, next: pct > 0 ? `Siguiente · ${Math.round(pct * 100)}%` : 'Siguiente recomendada', todo: 'Por hacer' }[st];
  const node = h('div', { class: 'idx-node', 'aria-hidden': 'true' },
    st === 'done' ? h('span', { html: icon('check', 18) }) : st === 'todo' && passedNext ? h('span', { class: 'idx-lock', html: icon('lock', 15) }) : h('span', null, String(n)));

  const metaBits = [];
  if (mins) metaBits.push(h('span', null, h('span', { html: icon('clock', 13) }), ` ${fmtMin(mins)}`));
  if (ex.total) metaBits.push(h('span', null, `${ex.done}/${ex.total} ejercicios`));
  if (u.nExercisesReal) metaBits.push(h('span', { class: 'idx-real' }, `${u.nExercisesReal} ${u.nExercisesReal === 1 ? 'real' : 'reales'}`));

  const card = h('article', { class: 'idx-card' },
    h('div', { class: 'idx-card-top' },
      yearBadge(u.year),
      h('span', { class: 'idx-prac mono' }, u.practice || u.lesson),
      h('span', { class: `idx-state s-${st}` }, label)),
    h('h3', { class: 'idx-title' }, h('a', { class: 'idx-link', href: lessonHref(u.lesson), 'aria-label': `${u.practice ? u.practice + ': ' : ''}${u.title} — ${label}` }, u.title)),
    u.topics?.length ? h('ul', { class: 'idx-topics' }, u.topics.slice(0, 5).map((t) => h('li', null, t))) : null,
    cmds.length ? h('div', { class: 'idx-cmds' }, h('span', { class: 'idx-cmds-k' }, 'nuevos'), cmds.map((c) => h('a', { class: `chip l${store.cmdLevel(c)}`, href: cmdHref(c) }, c)), more > 0 ? h('span', { class: 'muted idx-more' }, `+${more}`) : null) : null,
    h('div', { class: 'idx-foot' },
      h('div', { class: `progress y${u.year}` }, h('i', { style: { width: `${Math.round(pct * 100)}%` } })),
      h('div', { class: 'idx-meta' }, metaBits)));
  if (st === 'next') card.appendChild(h('span', { class: 'idx-go btn primary sm', 'aria-hidden': 'true' }, pct > 0 ? 'Continuar' : 'Empezar', h('span', { html: icon('arrow', 14) })));
  return h('li', { class: `idx-unit s-${st} y${u.year}${passedNext && st === 'todo' ? ' later' : ''}`, id: `u-${u.lesson}`, dataset: { lesson: u.lesson } }, node, card);
}

function examNode(e) {
  const best = store.examBest(e.id);
  return h('li', { class: `idx-unit idx-exam y${e.year}${best ? ' s-done' : ''}` },
    h('div', { class: 'idx-node', 'aria-hidden': 'true', html: icon('timer', 17) }),
    h('article', { class: 'idx-card' },
      h('div', { class: 'idx-card-top' }, yearBadge(e.year), h('span', { class: 'idx-prac mono' }, 'Simulacro'), e.durationMin ? h('span', { class: 'idx-prac mono' }, `${e.durationMin} min`) : null,
        best ? h('span', { class: 'idx-state s-done' }, `Mejor nota: ${String(Math.round((best.score / (best.max || 10)) * 100) / 10).replace('.', ',')}/10`) : h('span', { class: 'idx-state s-exam' }, e.date ? fmtDate(e.date + 'T12:00:00') : 'Meta')),
      h('h3', { class: 'idx-title' }, h('a', { class: 'idx-link', href: `#/simulacro/${encodeURIComponent(e.id)}` }, e.title)),
      e.description ? h('p', { class: 'idx-exam-d muted' }, e.description) : null));
}

function evalBox(s) {
  const ev = s.evaluation;
  if (!ev || (!ev.format && !ev.notes?.length && !ev.mathematicaWeight)) return null;
  return h('details', { class: 'idx-eval' },
    h('summary', null, h('span', { html: icon('info', 15) }), ' Cómo se evalúa Mathematica aquí', ev.mathematicaWeight ? h('span', { class: 'badge muted' }, String(ev.mathematicaWeight).split(':')[0].split('=')[0].trim().slice(0, 28)) : null),
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
  if (cmds) for (const c of cmds.commands) if (c.firstLesson) { if (!newCmds.has(c.firstLesson)) newCmds.set(c.firstLesson, []); newCmds.get(c.firstLesson).push(c.name); }

  const doneN = units.filter((u) => store.lessonDone(u.lesson)).length;
  const overall = units.length ? units.reduce((s, u) => s + store.lessonProgress(u.lesson), 0) / units.length : 0;
  const minsLeft = units.filter((u) => !store.lessonDone(u.lesson)).reduce((s, u) => s + (u.minutes || store.lessonMeta(u.lesson)?.min || 0) * (1 - store.lessonProgress(u.lesson)), 0);

  const page = h('div', { class: 'page idx' });
  page.appendChild(h('header', { class: 'page-head' },
    h('div', null,
      h('span', { class: 'kicker' }, 'índice de contenidos'),
      h('h1', null, 'Tu ruta: de cero al examen'),
      h('p', null, 'Ordenada de lo más simple a lo más completo. Cada unidad es una práctica real de tu carrera. Nada está bloqueado: el orden es una recomendación, puedes saltar donde quieras.')),
    h('div', { class: 'idx-jump seg', role: 'group', 'aria-label': 'Saltar a un curso' },
      (course.years || []).map((y) => h('button', { type: 'button', 'data-y': y.year, 'aria-pressed': 'true', onclick: () => jump(y.year) }, `${y.year}º`, h('b', null, `${yearProgress(course, y.year).done}/${yearProgress(course, y.year).units}`))))));

  const main = h('div', { class: 'idx-main' });
  let n = 0, passed = false;
  for (const y of course.years || []) {
    const yp = yearProgress(course, y.year);
    const yUnits = units.filter((u) => u.year === y.year);
    const yMins = yUnits.reduce((s, u) => s + (u.minutes || 0), 0);
    const sec = h('section', { class: `idx-year y${y.year}`, id: `idx-y${y.year}` });
    sec.appendChild(h('header', { class: 'idx-yhead' },
      h('div', { class: 'idx-ynum', 'aria-hidden': 'true' }, `${y.year}º`),
      h('div', { class: 'idx-ytx' },
        h('div', { class: 'idx-ylabel' }, yearBadge(y.year, `${y.year}º curso`), h('b', null, String(y.label || '').replace(/^\d+º\s*·\s*/, '')), y.state ? h('span', { class: 'muted' }, y.state) : null),
        h('div', { class: `progress y${y.year}` }, h('i', { style: { width: `${Math.round(yp.pct * 100)}%` } }))),
      h('div', { class: 'idx-ystat mono' }, h('b', null, `${yp.done}/${yp.units}`), h('span', null, yMins ? fmtMin(yMins) : 'lecciones'))));

    for (const s of y.subjects || []) {
      const sub = h('div', { class: 'idx-subj' },
        h('div', { class: 'idx-subj-head' },
          h('h2', null, s.name),
          h('div', { class: 'idx-subj-tags' }, s.semester ? h('span', { class: 'badge muted' }, /anual/i.test(s.semester) ? 'anual' : `semestre ${s.semester}`) : null, s.state ? h('span', { class: `badge ${/en curso/i.test(s.state) ? 'ok' : 'muted'}` }, s.state) : null)),
        s.summary ? h('p', { class: 'muted idx-subj-sum' }, s.summary) : null,
        evalBox(s));
      for (const b of s.blocks || []) {
        const us = (b.units || []).filter((u) => u.lesson);
        if (!us.length) continue;
        const bDone = us.filter((u) => store.lessonDone(u.lesson)).length;
        sub.appendChild(h('h3', { class: 'idx-block' }, h('span', null, b.name), h('small', { class: 'mono' }, `${bDone}/${us.length}`)));
        const ol = h('ol', { class: 'idx-units' });
        for (const u of us) {
          n += 1;
          const full = { ...u, year: y.year, subject: s.name, block: b.name };
          ol.appendChild(unitCard(full, n, nextId, newCmds, passed));
          if (u.lesson === nextId) passed = true;
        }
        sub.appendChild(ol);
      }
      const exams = (course.exams || []).filter((e) => Number(e.year) === y.year && (e.subject === s.name || e.subject === s.id));
      if (exams.length) {
        sub.appendChild(h('h3', { class: 'idx-block idx-block-exam' }, h('span', null, 'Meta: el examen'), h('small', { class: 'mono' }, `${exams.length} ${exams.length === 1 ? 'simulacro' : 'simulacros'}`)));
        sub.appendChild(h('ol', { class: 'idx-units' }, exams.map(examNode)));
      }
      sec.appendChild(sub);
    }
    main.appendChild(sec);
  }

  // panel lateral (escritorio) / resumen (móvil)
  const aside = h('aside', { class: 'idx-aside' },
    h('div', { class: 'card idx-panel' },
      h('div', { class: 'idx-panel-top' },
        ring({ pct: overall, size: 92, stroke: 9, color: '#7c5cff', color2: '#19e3c5' }),
        h('div', null, h('b', { class: 'idx-panel-n' }, `${doneN}/${units.length}`), h('div', { class: 'muted' }, 'lecciones completadas'), minsLeft > 0 ? h('div', { class: 'muted idx-panel-t' }, `≈ ${fmtMin(Math.round(minsLeft / 5) * 5)} por delante`) : null)),
      nx ? h('a', { class: 'btn primary idx-panel-go', href: nx.allDone ? '#/practica/aleatoria' : lessonHref(nx.unit.lesson) }, nx.allDone ? 'Todo hecho: a practicar' : store.lessonProgress(nx.unit.lesson) > 0 ? 'Continuar' : 'Empezar', h('span', { html: icon('arrow', 16) })) : null,
      nx && !nx.allDone ? h('button', { class: 'idx-panel-next', type: 'button', onclick: () => focusUnit(nx.unit.lesson) }, h('span', { class: 'muted' }, 'Siguiente recomendada'), h('b', null, `${nx.unit.practice ? nx.unit.practice + ' · ' : ''}${nx.unit.title}`)) : null,
      h('ul', { class: 'idx-legend' },
        h('li', { class: 's-done' }, h('i'), 'Completada'),
        h('li', { class: 's-doing' }, h('i'), 'En curso'),
        h('li', { class: 's-next' }, h('i'), 'Siguiente recomendada'),
        h('li', { class: 's-todo' }, h('i'), 'Por hacer (abierta)')),
      h('p', { class: 'muted idx-panel-note' }, 'Los ', h('span', { class: 'chip l0', style: { cursor: 'default' } }, 'chips'), ' son los comandos nuevos de cada unidad; cambian de color según los vas dominando.')));

  page.appendChild(h('div', { class: 'idx-layout' }, main, aside));
  return page;
}

function jump(year) {
  const el = root?.querySelector(`#idx-y${year}`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 64, behavior: 'smooth' });
}
function focusUnit(lesson) {
  const el = root?.querySelector(`#u-${CSS.escape(lesson)}`);
  if (!el) return;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 150, behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  el.querySelector('.idx-link')?.focus({ preventScroll: true });
}

export default {
  async mount(el, params) {
    alive = true; root = el;
    el.appendChild(h('div', { class: 'page idx' }, h('div', { class: 'card' }, skeleton(4)), h('div', { class: 'card' }, skeleton(6))));
    const [course, cmds] = await Promise.all([safe(loadCourse()), safe(loadCommands())]);
    if (!alive) return;
    if (!course || !flatUnits(course).length) {
      el.replaceChildren(h('div', { class: 'page idx' }, emptyState({ icon: 'route', title: 'El índice se está preparando', text: 'Todavía no está publicado el plan del curso. Vuelve en un rato; mientras, puedes trastear en el cuaderno.', actions: [h('a', { class: 'btn primary', href: '#/cuaderno' }, 'Abrir cuaderno')] })));
      return;
    }
    el.replaceChildren(build(course, cmds));
    const y = Number(params?.query?.curso);
    if (y) setTimeout(() => alive && jump(y), 120);

    // en segundo plano: carga las lecciones para conocer nº de ejercicios y comandos; repinta una vez al acabar
    const before = JSON.stringify(flatUnits(course).map((u) => store.lessonMeta(u.lesson)?.n || 0));
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 400));
    idle(async () => {
      await loadAllLessons();
      if (!alive) return;
      const after = JSON.stringify(flatUnits(course).map((u) => store.lessonMeta(u.lesson)?.n || 0));
      if (after !== before) { const sy = window.scrollY; el.replaceChildren(build(course, cmds)); window.scrollTo(0, sy); }
    });
  },
  update(params) {
    const y = Number(params?.query?.curso);
    if (y) jump(y);
  },
  unmount() { alive = false; root = null; },
};
