// Vista: inicio (#/) — continuar, cuenta atrás, progreso por curso, objetivos de hoy, accesos y comandos.
import { store, dayKey } from '../store.js';
import { loadCourse, loadCommands, safe, flatUnits, nextUnit, yearProgress, lessonHref, cmdHref } from '../data.js';
import { h, icon, ring, yearBadge, emptyState, fmtDate, skeleton } from '../fx.js';

let timer = 0;
let off = null;

function greeting() {
  const hr = new Date().getHours();
  return hr < 6 ? 'Buenas noches' : hr < 13 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
}

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
const daysTo = (at) => Math.max(0, Math.ceil((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000));

const inst = (v, l, ic) => h('div', { class: 'home-inst-i' }, h('span', { class: 'home-inst-ic', html: icon(ic, 15) }), h('b', null, v), h('span', null, l));

/* ---------- tarjeta: continuar ---------- */
function continueCard(course) {
  const li = store.levelInfo();
  const c = store.counts();
  const card = h('section', { class: 'home-cont card' });
  card.appendChild(h('div', { class: 'home-cont-glow', 'aria-hidden': 'true' }));
  const nx = course ? nextUnit(course) : null;
  const fresh = c.exTried === 0 && !store.state.last;
  card.appendChild(h('span', { class: 'kicker' }, fresh ? 'empieza aquí' : 'continuar donde lo dejaste'));
  card.appendChild(h('h1', { class: 'home-hello' }, `${greeting()}, `, h('em', null, li.title.toLowerCase()), '.'));

  if (!nx) {
    card.appendChild(h('p', { class: 'muted' }, 'El índice del curso todavía se está preparando. Mientras tanto puedes practicar en el cuaderno libre.'));
    card.appendChild(h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/cuaderno' }, 'Abrir cuaderno', h('span', { html: icon('arrow', 16) }))));
    return card;
  }
  const u = nx.unit;
  const units = flatUnits(course).filter((x) => x.lesson);
  const doneN = units.filter((x) => store.lessonDone(x.lesson)).length;
  const pct = store.lessonProgress(u.lesson);
  const L = store.state.lesson[u.lesson];
  const ex = store.lessonExercises(u.lesson);
  const meta = store.lessonMeta(u.lesson);

  card.appendChild(h('p', { class: 'home-sub' },
    fresh ? 'De «no entiendo nada» a resolver tú solo cualquier práctica. Paso a paso, ejecutando cada línea.'
      : nx.allDone ? 'Has completado todas las lecciones. Toca afinar con práctica aleatoria y simulacros.'
        : `Llevas ${doneN} de ${units.length} lecciones y ${c.exOk} ${c.exOk === 1 ? 'ejercicio resuelto' : 'ejercicios resueltos'}. La siguiente te espera.`));

  const stepTxt = [];
  if (L && meta?.n) stepTxt.push(`paso ${Math.min(meta.n, (L.step || 0) + 1)} de ${meta.n}`);
  if (ex.total) stepTxt.push(`${ex.done}/${ex.total} ejercicios`);
  else if (u.nExercisesReal) stepTxt.push(`${u.nExercisesReal} ejercicios reales`);
  if (u.minutes || meta?.min) stepTxt.push(`≈ ${u.minutes || meta.min} min`);

  const step = L && !L.done && L.step > 0 ? L.step : null;
  const box = h('a', { class: `home-next y${u.year}`, href: lessonHref(u.lesson, step ?? undefined) },
    h('div', { class: 'home-next-top' }, yearBadge(u.year), h('span', { class: 'home-next-path' }, [u.practice, u.subject, u.block].filter(Boolean).join(' · '))),
    h('div', { class: 'home-next-title' }, u.title),
    u.topics?.length ? h('div', { class: 'home-next-topics muted' }, u.topics.slice(0, 3).join(' · ')) : null,
    h('div', { class: `progress y${u.year}` }, h('i', { style: { width: `${Math.round(pct * 100)}%` } })),
    h('div', { class: 'home-next-foot' },
      h('span', { class: 'muted' }, stepTxt.join(' · ') || 'Sin empezar'),
      h('span', { class: 'btn primary home-go' }, nx.allDone ? 'Repasar' : pct > 0 ? 'Continuar' : 'Empezar', h('span', { html: icon('arrow', 16) }))));
  card.appendChild(box);
  card.appendChild(h('div', { class: 'home-inst' },
    inst(String(store.state.xp), 'XP totales', 'star'),
    inst(String(store.state.streak || 0), store.state.streak === 1 ? 'día de racha' : 'días de racha', 'flame'),
    inst(String(c.exOk), 'ejercicios', 'check'),
    inst(String(c.learned), 'comandos dominados', 'brackets')));
  return card;
}

/* ---------- tarjeta: cuenta atrás ---------- */
function countdownCard(course) {
  const card = h('section', { class: 'home-count card' });
  const up = upcomingDates(course);
  const target = up.find((k) => isExam(k) && (k.exam || /mathematica/i.test(k.label || ''))) || up.find(isExam) || up[0];
  card.appendChild(h('span', { class: 'kicker' }, 'cuenta atrás'));
  if (!target) {
    card.appendChild(h('div', { class: 'home-t' }, h('b', null, '—')));
    card.appendChild(h('p', { class: 'muted' }, 'No hay fechas clave próximas. Buen momento para adelantar.'));
    return card;
  }
  const units = flatUnits(course).filter((x) => x.lesson);
  // ruta hasta el examen: todo lo anterior + la asignatura del examen
  const exam = (course.exams || []).find((e) => e.id === target.exam) || (course.exams || []).find((e) => e.date === target.date);
  const subj = exam?.subject || (/(Matemáticas\s+[IVX]+)/.exec(target.label || '') || [])[1];
  const exYear = exam?.year || 2;
  let route = units.filter((x) => x.year < exYear || (subj ? x.subject === subj : x.year === exYear));
  if (!route.length) route = units;
  const prog = route.length ? route.reduce((s, x) => s + store.lessonProgress(x.lesson), 0) / route.length : 0;
  const left = route.filter((x) => !store.lessonDone(x.lesson)).length;
  const days = daysTo(target.at);
  const weeks = Math.max(1, days / 7);
  const perWeek = left / weeks;
  const t0 = store.state.created || Date.now();
  const elapsed = Math.max(0, Math.min(1, (Date.now() - t0) / Math.max(1, target.at - t0)));

  const tEl = h('div', { class: 'home-t', role: 'timer', 'aria-label': `Faltan ${days} días` },
    h('span', { class: 'home-t-pre' }, 'T−'), h('b', { class: 'home-t-d' }, String(days)), h('span', { class: 'home-t-u' }, days === 1 ? 'día' : 'días'),
    h('span', { class: 'home-t-clock mono' }, ''));
  card.appendChild(tEl);
  card.appendChild(h('div', { class: 'home-count-label' }, String(target.label || '').replace(/\s*·\s*\d{1,2}:\d{2}\s*h/, '')));
  card.appendChild(h('div', { class: 'muted home-count-date' }, fmtDate(target.at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (/\d{1,2}:\d{2}\s*h/.test(target.label || '') ? ` · ${String(target.at.getHours()).padStart(2, '0')}:${String(target.at.getMinutes()).padStart(2, '0')} h` : '')));

  // trayectoria: avión = tu avance; marca = tiempo consumido
  const P = (t) => [14 + 272 * t, 80 - 58 * (1 - (1 - t) * (1 - t))]; // ascenso que se va nivelando
  const tilt = (t) => (Math.atan2(-116 * (1 - t), 272) * 180) / Math.PI;
  const pts = Array.from({ length: 41 }, (_, i) => P(i / 40));
  const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const [px, py] = P(prog), [tx, ty] = P(elapsed), [ex2, ey2] = P(1);
  const ahead = prog + 0.02 >= elapsed;
  const svg = h('div', { class: 'home-traj', html: `
    <svg viewBox="0 0 300 96" role="img" aria-label="Tu avance: ${Math.round(prog * 100)} %. Tiempo consumido: ${Math.round(elapsed * 100)} %.">
      <defs><linearGradient id="tj" x1="0" x2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#19e3c5"/></linearGradient></defs>
      <path d="${path(pts)}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round"/>
      <path d="${path(pts.filter((_, i) => i / 40 <= prog + 1e-9).concat([[px, py]]))}" fill="none" stroke="url(#tj)" stroke-width="3" stroke-linecap="round"/>
      <line x1="${tx.toFixed(1)}" y1="${(ty - 9).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(ty + 9).toFixed(1)}" stroke="#ffd166" stroke-width="2" stroke-linecap="round"/>
      <text x="${Math.max(16, Math.min(270, tx)).toFixed(1)}" y="${(ty + 22).toFixed(1)}" text-anchor="middle" class="tj-l" fill="#ffd166">hoy</text>
      <circle cx="14" cy="80" r="3.5" fill="#7c5cff"/>
      <g transform="translate(${ex2.toFixed(1)} ${ey2.toFixed(1)})"><path d="M0 4V-14" stroke="#ff9f43" stroke-width="2" stroke-linecap="round"/><path d="M0-14h11l-3 4 3 4H0z" fill="#ff9f43"/></g>
      <g class="tj-plane" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${tilt(prog).toFixed(1)})"><path d="M-9 5 12 0-9-5-5 0z" fill="#e8eeff"/></g>
    </svg>` });
  card.appendChild(svg);
  card.appendChild(h('div', { class: 'home-pace' },
    h('div', null, h('b', null, `${Math.round(prog * 100)}%`), h('span', null, 'ruta al examen')),
    h('div', null, h('b', null, String(left)), h('span', null, left === 1 ? 'lección pendiente' : 'lecciones pendientes')),
    h('div', { class: left === 0 ? 'ok' : perWeek > 6 ? 'hot' : '' }, h('b', null, left === 0 ? '✓' : perWeek >= 10 ? '10+' : perWeek.toFixed(perWeek < 3 ? 1 : 0).replace('.', ',')), h('span', null, left === 0 ? 'ruta completa' : 'lecciones / semana'))));
  if (left > 0 && Date.now() - t0 > 3 * 86400e3) {
    card.appendChild(h('div', { class: `home-plan ${ahead ? 'ok' : 'late'}` }, ahead ? 'Vas por delante del calendario. Mantén el ritmo.' : 'Vas algo por detrás del calendario: una lección extra esta semana lo arregla.'));
  }

  const others = up.filter((k) => k !== target).slice(0, 3);
  if (others.length) {
    card.appendChild(h('ul', { class: 'home-dates' }, others.map((k) => {
      const d = daysTo(k.at);
      const href = k.lesson ? lessonHref(k.lesson) : k.exam ? `#/simulacro/${encodeURIComponent(k.exam)}` : null;
      const label = h('span', { class: 'home-dates-l' }, String(k.label || '').replace(/\s*\((fecha )?estima[^)]*\)/i, ''));
      return h('li', null, h('b', { class: 'mono' }, d === 0 ? 'hoy' : `${d} d`), href ? h('a', { href }, label) : label, k.kind === 'estimada' ? h('span', { class: 'badge muted', title: 'Fecha estimada, sin confirmar' }, 'estimada') : null);
    })));
  }

  const clock = tEl.querySelector('.home-t-clock');
  const tick = () => {
    const ms = target.at - Date.now();
    if (ms <= 0) { clock.textContent = 'es hoy'; return; }
    const hh = Math.floor((ms % 86400e3) / 3600e3), mm = Math.floor((ms % 3600e3) / 60e3), ss = Math.floor((ms % 60e3) / 1e3);
    const p = (n) => String(n).padStart(2, '0');
    clock.textContent = `${p(hh)}:${p(mm)}:${p(ss)}`;
  };
  tick();
  timer = setInterval(tick, 1000);
  return card;
}

/* ---------- anillos por curso ---------- */
function yearCard(course, year) {
  const yp = yearProgress(course, year);
  const y = (course.years || []).find((x) => x.year === year);
  const color = year === 1 ? '#22d3ee' : '#ff9f43', color2 = year === 1 ? '#0891b2' : '#f97316';
  const blocks = [];
  for (const s of y?.subjects || []) for (const b of s.blocks || []) {
    const us = (b.units || []).filter((u) => u.lesson);
    if (!us.length) continue;
    const p = us.reduce((a, u) => a + store.lessonProgress(u.lesson), 0) / us.length;
    blocks.push(h('li', { title: `${s.name} · ${b.name}: ${Math.round(p * 100)} %` }, h('span', null, b.name), h('div', { class: `progress y${year}` }, h('i', { style: { width: `${Math.round(p * 100)}%` } })), h('b', { class: 'mono' }, String(us.length))));
  }
  return h('a', { class: `home-year card link y${year}`, href: `#/indice?curso=${year}` },
    h('div', { class: 'home-year-top' },
      ring({ pct: yp.pct, size: 104, stroke: 10, color, color2, sub: `${yp.done}/${yp.units}` }),
      h('div', { class: 'home-year-tx' },
        h('div', { class: 'row', style: { gap: '8px' } }, yearBadge(year), y?.state ? h('span', { class: 'muted home-year-state' }, y.state) : null),
        h('h3', null, (y?.subjects || []).map((s) => s.name).join(' · ') || `${year}º`),
        h('div', { class: 'muted home-year-meta' }, `${yp.done} de ${yp.units} lecciones`, yp.exTotal ? ` · ${yp.exDone}/${yp.exTotal} ejercicios` : yp.exDone ? ` · ${yp.exDone} ejercicios` : ''))),
    blocks.length ? h('ul', { class: 'home-blocks' }, blocks) : null,
    h('span', { class: 'home-year-go' }, 'Ver ruta', h('span', { html: icon('arrow', 14) })));
}

/* ---------- objetivos de hoy ---------- */
function goalsCard() {
  const t = store.today();
  const goals = [
    { label: 'Resuelve 3 ejercicios', cur: Math.min(3, t.ok || 0), max: 3 },
    { label: 'Estrena 1 comando', cur: Math.min(1, t.cmds || 0), max: 1 },
    { label: 'Gana 50 XP', cur: Math.min(50, t.xp || 0), max: 50 },
  ];
  const done = goals.filter((g) => g.cur >= g.max).length;
  const week = store.recentDays(7);
  const L = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  return h('section', { class: `home-goals card${done === goals.length ? ' all' : ''}` },
    h('div', { class: 'home-goals-head' }, h('h3', null, 'Objetivos de hoy'), h('span', { class: 'mono home-goals-n' }, `${done}/${goals.length}`)),
    h('ul', { class: 'home-goal-list' }, goals.map((g) => h('li', { class: g.cur >= g.max ? 'done' : '' },
      h('span', { class: 'home-goal-ck', html: g.cur >= g.max ? icon('check', 14) : '' }),
      h('span', { class: 'home-goal-l' }, g.label),
      h('span', { class: 'mono home-goal-v' }, `${g.cur}/${g.max}`),
      h('span', { class: 'home-goal-bar' }, h('i', { style: { width: `${(g.cur / g.max) * 100}%` } }))))),
    h('div', { class: 'home-week', 'aria-label': 'Últimos 7 días' }, week.map((d) => {
      const dt = new Date(d.day + 'T12:00:00');
      return h('div', { class: `home-wd${d.ok > 0 ? ' on' : d.ex > 0 ? ' half' : ''}${d.day === dayKey() ? ' today' : ''}`, title: `${fmtDate(dt, { weekday: 'long', day: 'numeric', month: 'short' })}: ${d.ok} aciertos · ${d.xp} XP` },
        h('i', { html: d.ok > 0 ? icon('flame', 13) : '' }), h('span', null, L[dt.getDay()]));
    })));
}

/* ---------- accesos rápidos ---------- */
function quick() {
  const items = [
    ['#/practica/aleatoria', 'dice', 'Práctica aleatoria', 'Ejercicios mezclados de lo que ya has visto', 'q1'],
    ['#/simulacros', 'timer', 'Simulacros', 'Examen cronometrado con casillas numéricas', 'q2'],
    ['#/cuaderno', 'book', 'Cuaderno', 'Hoja en blanco para probar lo que quieras', 'q3'],
  ];
  return h('section', { class: 'home-quick' }, items.map(([href, ic, t, d, cls]) =>
    h('a', { class: `home-q card link ${cls}`, href }, h('span', { class: 'home-q-ic', html: icon(ic, 26) }), h('span', { class: 'home-q-tx' }, h('b', null, t), h('small', { class: 'muted' }, d)), h('span', { class: 'home-q-go', html: icon('arrow', 18) }))));
}

/* ---------- comandos ---------- */
function commandCards(cmds) {
  const all = Object.entries(store.state.cmd || {}).map(([name, c]) => ({ name, ...c, level: store.cmdLevel(name) }));
  const known = (n) => !cmds || cmds.byName.has(n);
  const learned = all.filter((c) => c.level >= 2 && known(c.name)).sort((a, b) => (b.learned || b.last || 0) - (a.learned || a.last || 0)).slice(0, 12);
  const now = Date.now();
  const weak = all.filter((c) => known(c.name) && c.level < 3 && ((c.fail || 0) > 0 || (c.level === 1 && c.seen >= 2) || (c.level === 2 && now - (c.last || 0) > 5 * 86400e3)))
    .map((c) => ({ ...c, score: (c.fail || 0) * 2 - (c.ok || 0) + (now - (c.last || 0)) / (7 * 86400e3) }))
    .sort((a, b) => b.score - a.score).slice(0, 10);

  const a = h('section', { class: 'card home-cmds' },
    h('div', { class: 'home-cmds-head' }, h('h3', null, 'Últimos comandos aprendidos'), h('a', { href: '#/comandos', class: 'home-more' }, 'Ver todos')),
    learned.length
      ? h('div', { class: 'chips' }, learned.map((c) => h('a', { class: `chip l${c.level}`, href: cmdHref(c.name), title: c.level === 3 ? 'Dominado' : 'En práctica' }, c.name)))
      : h('p', { class: 'muted home-empty' }, 'Todavía ninguno. Cada comando que uses bien en un ejercicio aparecerá aquí; con tres aciertos pasa a ', h('span', { class: 'chip l3', style: { cursor: 'default' } }, 'dominado'), '.'));
  const b = h('section', { class: 'card home-cmds' },
    h('div', { class: 'home-cmds-head' }, h('h3', null, 'Para repasar'), h('a', { href: '#/practica', class: 'home-more' }, 'Practicar')),
    weak.length
      ? h('div', { class: 'chips' }, weak.map((c) => h('a', { class: `chip l${c.level} weak`, href: `#/practica/comando/${encodeURIComponent(c.name)}`, title: `${c.ok || 0} aciertos · ${c.fail || 0} fallos — pulsa para practicarlo` }, c.name, (c.fail || 0) > 0 ? h('i', { class: 'home-fail' }, `${c.fail}✕`) : null)))
      : h('p', { class: 'muted home-empty' }, 'Nada flojo por ahora. Los comandos en los que falles o que lleves días sin tocar saldrán aquí para que los refuerces.'));
  return h('div', { class: 'home-cmds-grid' }, a, b);
}

export default {
  async mount(el) {
    const page = h('div', { class: 'page home' }, h('div', { class: 'home-hero' }, h('div', { class: 'card' }, skeleton(5)), h('div', { class: 'card' }, skeleton(5))));
    el.appendChild(page);
    const [course, cmds] = await Promise.all([safe(loadCourse()), safe(loadCommands())]);
    const build = () => {
      clearInterval(timer);
      const kids = [];
      kids.push(h('div', { class: 'home-hero' }, continueCard(course), course ? countdownCard(course) : h('section', { class: 'card home-count' }, emptyState({ icon: 'calendar', title: 'Sin calendario', text: 'Las fechas clave aparecerán aquí.' }))));
      const row = h('div', { class: 'home-row' });
      if (course) for (const y of course.years || []) row.appendChild(yearCard(course, y.year));
      row.appendChild(goalsCard());
      kids.push(row, quick(), commandCards(cmds));
      page.replaceChildren(...kids);
    };
    build();
    // si el progreso cambia desde otra pestaña o al importar, repinta
    off = store.on((_, evt) => { if (evt?.external || evt?.type === 'import' || evt?.type === 'reset') build(); });
  },
  unmount() { clearInterval(timer); timer = 0; off?.(); off = null; },
};
