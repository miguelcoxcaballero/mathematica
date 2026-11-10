// Vista: registro de prácticas y ejercicios (#/registro) — una tabla sobria: qué hay en su Drive y qué lleva hecho aquí.
import { store, dayKey } from '../store.js?v=1794352036';
import { loadCourse, loadLesson, loadAllLessons, safe, flatUnits, lessonHref, STATUS_LABEL } from '../data.js?v=1794352036';
import { h, icon, yearBadge, emptyState, skeleton, timeAgo, fmtDate, toast } from '../fx.js?v=1794352036';

let alive = false;
const S = { year: 0, status: '', q: '', open: new Set() };

const STATUS_CLS = { hecha: 'ok', parcial: 'real', pendiente: 'muted' };
// Mecánica v2 (SPEC §11): todo se teclea. Los tipos antiguos se muestran como lo que son ahora.
const KIND = { code: 'Código', fix: 'Corregir', fill: 'Código', order: 'Código', predict: 'Teclear', mcq: 'Nota' };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function lastAttempts() {
  const map = new Map();
  for (const [id, e] of Object.entries(store.state.ex || {})) {
    const l = id.replace(/-e\d+[a-z]?$/i, '');
    if (!map.has(l) || map.get(l) < e.ts) map.set(l, e.ts);
  }
  return map;
}
function exercisesOf(lesson) {
  return (lesson?.steps || []).filter((s) => s?.type === 'exercise' && s.ex?.id).map((s) => s.ex);
}
const plain = (s) => String(s || '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
function exTitle(ex) {
  const t = plain(ex.title) || plain(ex.prompt);
  return t.length > 90 ? t.slice(0, 88) + '…' : t || ex.id;
}

/* ---------- CSV ---------- */
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function download(name, rows) {
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const dstr = (ts) => (ts ? dayKey(new Date(ts)) : '');

function exportUnits(units, last) {
  const rows = [['curso', 'asignatura', 'bloque', 'practica', 'leccion', 'titulo', 'estado_drive', 'evidencia', 'ejercicios_reales', 'resueltos_app', 'total_app', 'progreso_pct', 'ultimo_intento']];
  for (const u of units) {
    const e = store.lessonExercises(u.lesson);
    rows.push([u.year, u.subject, u.block, u.practice, u.lesson, u.title, u.status, u.evidence, u.nExercisesReal, e.done, e.total ?? '', Math.round(store.lessonProgress(u.lesson) * 100), dstr(last.get(u.lesson))]);
  }
  download(`wolframlab-registro-practicas-${dayKey()}.csv`, rows);
}
async function exportExercises(units, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Preparando…';
  try {
    const lessons = await loadAllLessons();
    const by = new Map(lessons.map((l) => [l.id, l]));
    const rows = [['curso', 'asignatura', 'practica', 'leccion', 'ejercicio', 'titulo', 'tipo', 'dificultad', 'real', 'fuente', 'comandos', 'resuelto', 'intentos', 'ultimo_intento']];
    for (const u of units) {
      const exs = exercisesOf(by.get(u.lesson));
      if (!exs.length) { rows.push([u.year, u.subject, u.practice, u.lesson, '', '(lección sin publicar)', '', '', '', '', '', '', '', '']); continue; }
      for (const ex of exs) {
        const r = store.exercise(ex.id);
        rows.push([u.year, u.subject, u.practice, u.lesson, ex.id, exTitle(ex), KIND[ex.kind] || ex.kind || '', ex.difficulty || '', ex.real ? 'sí' : 'no', ex.source || '', (ex.cmds || []).join(' '), r?.ok ? 'sí' : r ? 'no' : '', r?.tries || 0, dstr(r?.ts)]);
      }
    }
    download(`wolframlab-registro-ejercicios-${dayKey()}.csv`, rows);
    toast(`CSV con ${rows.length - 1} filas descargado.`, 'ok');
  } catch { toast('No se pudo generar el CSV.', 'bad'); }
  btn.disabled = false;
  btn.textContent = old;
}

/* ---------- detalle expandible ---------- */
function detail(u) {
  const box = h('div', { class: 'reg-detail', role: 'region', 'aria-label': `Ejercicios de ${u.practice || u.title}` });
  box.appendChild(h('p', { class: 'reg-ev' }, h('b', null, `En tu Drive: ${STATUS_LABEL[u.status].toLowerCase()}. `), u.evidence || 'Sin anotaciones sobre esta práctica.', u.dateHint ? ` (${u.dateHint})` : ''));
  const list = h('div', { class: 'reg-exs' }, skeleton(3));
  box.appendChild(list);
  box.appendChild(h('div', { class: 'row reg-actions' },
    h('a', { class: 'more', href: lessonHref(u.lesson) }, 'Abrir la lección'),
    h('a', { class: 'more', href: `#/practica/tema/${encodeURIComponent(u.lesson)}` }, 'Practicar este tema')));

  safe(loadLesson(u.lesson)).then((lesson) => {
    if (!alive) return;
    const exs = exercisesOf(lesson).filter((e) => e.kind !== 'mcq');
    if (!lesson) { list.replaceChildren(h('p', { class: 'muted reg-none' }, 'La lección interactiva de esta práctica aún no está publicada. En cuanto lo esté, aquí verás todos sus ejercicios.')); return; }
    if (!exs.length) { list.replaceChildren(h('p', { class: 'muted reg-none' }, 'Esta lección no tiene ejercicios evaluables.')); return; }
    const done = exs.filter((e) => store.exercise(e.id)?.ok).length;
    list.replaceChildren(
      h('div', { class: 'reg-exs-head' }, `${exs.length} ejercicios · ${done} resueltos · ${exs.filter((e) => e.real).length} reales`),
      h('ol', { class: 'reg-exlist' }, exs.map((ex, i) => {
        const r = store.exercise(ex.id);
        const st = r?.ok ? 'ok' : r ? 'bad' : 'none';
        const d = Math.max(1, Math.min(5, Number(ex.difficulty) || 1));
        return h('li', { class: `reg-ex st-${st}` },
          h('span', { class: 'reg-ex-st', title: st === 'ok' ? 'Resuelto' : st === 'bad' ? 'Intentado, sin resolver' : 'Sin intentar', html: st === 'ok' ? icon('check', 14) : st === 'bad' ? icon('x', 13) : '' }),
          h('span', { class: 'reg-ex-id' }, String(ex.id).replace(u.lesson + '-', '') || String(i + 1)),
          h('span', { class: 'reg-ex-t' }, exTitle(ex), ex.real ? h('span', { class: 'badge real', title: 'Ejercicio real de la práctica o del examen' }, ex.source ? plain(ex.source) : 'real') : null),
          h('span', { class: 'reg-ex-kind' }, KIND[ex.kind] || ex.kind || '—'),
          h('span', { class: 'dots', title: `Dificultad ${d} de 5`, role: 'img', 'aria-label': `Dificultad ${d} de 5` }, Array.from({ length: 5 }, (_, k) => h('i', { class: k < d ? 'on' : '' }))),
          h('span', { class: 'reg-ex-when' }, r ? `${r.tries} ${r.tries === 1 ? 'intento' : 'intentos'} · ${timeAgo(r.ts)}` : '—'));
      })));
  });
  return box;
}

/* ---------- fila ---------- */
function row(u, last, rerender) {
  const e = store.lessonExercises(u.lesson);
  const pct = store.lessonProgress(u.lesson);
  const lt = last.get(u.lesson);
  const open = S.open.has(u.lesson);
  const id = `reg-d-${u.lesson}`;
  const toggle = () => { if (S.open.has(u.lesson)) S.open.delete(u.lesson); else S.open.add(u.lesson); rerender(u.lesson); };
  const app = e.total ? `${e.done}/${e.total}` : pct >= 1 ? 'Completa' : e.done ? `${e.done} ${e.done === 1 ? 'hecho' : 'hechos'}` : pct > 0 ? `${Math.round(pct * 100)} %` : '—';
  const r = h('div', { class: `reg-row y${u.year}${open ? ' open' : ''}`, role: 'row', dataset: { lesson: u.lesson } },
    h('div', { class: 'reg-c reg-c-year', role: 'cell' }, yearBadge(u.year)),
    h('div', { class: 'reg-c reg-c-prac', role: 'cell' }, u.practice || u.lesson),
    h('div', { class: 'reg-c reg-c-title', role: 'cell' },
      h('button', { class: 'reg-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': id, onclick: toggle }, u.title),
      h('span', { class: 'reg-sub' }, [u.subject, u.block].filter(Boolean).join(' · '))),
    h('div', { class: 'reg-c reg-c-drive', role: 'cell' }, h('span', { class: `badge ${STATUS_CLS[u.status]}`, title: u.evidence }, STATUS_LABEL[u.status])),
    h('div', { class: 'reg-c reg-c-real', role: 'cell', title: 'Ejercicios reales de la práctica' }, u.nExercisesReal ? String(u.nExercisesReal) : '—', h('span', { class: 'reg-lbl' }, ' reales')),
    h('div', { class: 'reg-c reg-c-app', role: 'cell' },
      h('div', { class: 'reg-app-top' }, h('b', { class: 'num' }, app), h('span', null, lt ? timeAgo(lt) : '')),
      h('div', { class: `progress y${u.year}` }, h('i', { style: { width: `${Math.round(pct * 100)}%` } }))),
    h('div', { class: 'reg-c reg-c-chev', role: 'cell', 'aria-hidden': 'true', html: icon('chevron', 16) }));
  const wrap = h('div', { class: 'reg-item', role: 'rowgroup' }, r);
  if (open) { const d = detail(u); d.id = id; wrap.appendChild(d); }
  return wrap;
}

export default {
  async mount(el) {
    alive = true;
    el.appendChild(h('div', { class: 'page wide reg' }, skeleton(8, 'skel-page')));
    const course = await safe(loadCourse());
    if (!alive) return;
    const units = course ? flatUnits(course).filter((u) => u.lesson) : [];
    if (!units.length) {
      el.replaceChildren(h('div', { class: 'page wide reg' }, emptyState({ title: 'El registro se está preparando', text: 'Cuando esté publicado el plan del curso verás aquí todas tus prácticas y ejercicios.', actions: [h('a', { class: 'btn primary', href: '#/' }, 'Volver al inicio')] })));
      return;
    }
    const last = lastAttempts();
    const count = (st) => units.filter((u) => u.status === st).length;
    const c = store.counts();
    const years = [...new Set(units.map((u) => u.year))].sort();

    const listEl = h('div', { class: 'reg-body', role: 'rowgroup' });
    const countEl = h('span', { 'aria-live': 'polite' });

    const matches = (u) => {
      if (S.year && u.year !== S.year) return false;
      if (S.status && u.status !== S.status) return false;
      if (S.q) {
        const hay = norm([u.title, u.practice, u.lesson, u.subject, u.block, u.evidence, (u.topics || []).join(' '), store.lessonMeta(u.lesson)?.cmds?.join(' ')].join(' '));
        if (!S.q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    };
    let shown = units;
    const render = (focusLesson) => {
      shown = units.filter(matches);
      countEl.textContent = shown.length === units.length ? `${units.length} prácticas. ` : `${shown.length} de ${units.length} prácticas. `;
      if (!shown.length) {
        listEl.replaceChildren(emptyState({ title: 'Nada con esos filtros', text: 'Prueba a quitar algún filtro o a buscar otra palabra.', actions: [h('button', { class: 'btn', type: 'button', onclick: () => { S.year = 0; S.status = ''; S.q = ''; search.value = ''; syncSegs(); render(); } }, 'Quitar filtros')] }));
        return;
      }
      listEl.replaceChildren(...shown.map((u) => row(u, last, render)));
      if (focusLesson) listEl.querySelector(`[data-lesson="${CSS.escape(focusLesson)}"] .reg-toggle`)?.focus({ preventScroll: true });
    };

    const seg = (items, get, set, label) => {
      const g = h('div', { class: 'seg', role: 'group', 'aria-label': label });
      for (const [val, text, n] of items) {
        g.appendChild(h('button', { type: 'button', 'data-val': String(val), 'aria-pressed': String(get() === val), onclick: () => { set(val); syncSegs(); render(); } }, text, n != null ? h('b', null, String(n)) : null));
      }
      g._get = get;
      return g;
    };
    const segYear = seg([[0, 'Todos'], ...years.map((y) => [y, `${y}º`, units.filter((u) => u.year === y).length])], () => S.year, (v) => { S.year = v; }, 'Curso');
    const segStatus = seg([['', 'Todas'], ['hecha', 'Hechas', count('hecha')], ['parcial', 'Parciales', count('parcial')], ['pendiente', 'Pendientes', count('pendiente')]], () => S.status, (v) => { S.status = v; }, 'Estado en tu Drive');
    function syncSegs() { for (const g of [segYear, segStatus]) for (const b of g.children) b.setAttribute('aria-pressed', String(String(g._get()) === b.dataset.val)); }

    const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar práctica, tema o comando', 'aria-label': 'Buscar en el registro', 'data-search': '', value: S.q });
    let deb = 0;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { S.q = norm(search.value.trim()); render(); }, 120); });

    const csv1 = h('button', { class: 'btn link', type: 'button', title: 'Una fila por práctica (respeta los filtros)', onclick: () => { exportUnits(shown, last); toast('CSV de prácticas descargado.', 'ok'); } }, 'Exportar CSV de prácticas');
    const csv2 = h('button', { class: 'btn link', type: 'button', title: 'Una fila por ejercicio (respeta los filtros)' }, 'CSV de ejercicios');
    csv2.addEventListener('click', () => exportExercises(shown, csv2));

    const legend = course.statusLegend || {};
    const exams = course.exams || [];

    const page = h('div', { class: 'page wide reg' },
      h('header', { class: 'page-head' },
        h('h1', null, 'Registro de prácticas'),
        h('p', { class: 'reg-sum' },
          'De tus ', h('b', null, String(units.length)), ' prácticas de 1º y 2º, en tu Drive hay ', h('b', null, String(count('hecha'))), ' hechas, ',
          h('b', null, String(count('parcial'))), ' a medias y ', h('b', null, String(count('pendiente'))), ' sin evidencia. Aquí llevas ',
          h('b', null, String(c.exOk)), c.exOk === 1 ? ' ejercicio resuelto.' : ' ejercicios resueltos.', ' Pulsa una fila para ver sus ejercicios.')),
      h('div', { class: 'reg-tools' }, segYear, segStatus, h('label', { class: 'search' }, search, h('kbd', null, '/'))),
      h('div', { class: 'reg-table', role: 'table', 'aria-label': 'Registro de prácticas' },
        h('div', { class: 'reg-head', role: 'row' }, ['Curso', 'Práctica', 'Título', 'En tu Drive', 'Reales', 'En la app', ''].map((t) => h('div', { role: 'columnheader' }, t))),
        listEl),
      h('div', { class: 'reg-foot' },
        h('div', { class: 'reg-export' }, countEl, csv1, csv2),
        h('div', null,
          h('span', { class: 'badge ok' }, 'Hecha'), ` ${legend.hecha || 'cuaderno completo.'} `,
          h('span', { class: 'badge real' }, 'Parcial'), ` ${legend.parcial || 'a medias.'} `,
          h('span', { class: 'badge muted' }, 'Pendiente'), ` ${legend.pendiente || 'sin evidencia.'}`)));

    if (exams.length) {
      page.appendChild(h('section', null,
        h('h2', { class: 'sec-title' }, 'Simulacros de examen'),
        h('ul', { class: 'reg-exams' }, exams.map((e) => {
          const tries = store.state.exams.filter((x) => x.id === e.id);
          const best = store.examBest(e.id);
          const nota = best ? Math.round((best.score / (best.max || 10)) * 100) / 10 : null;
          return h('li', null,
            yearBadge(e.year),
            h('div', null, h('a', { href: `#/simulacro/${encodeURIComponent(e.id)}` }, e.title), h('small', null, [e.subject, e.durationMin ? `${e.durationMin} min` : null, e.date ? `examen el ${fmtDate(e.date + 'T12:00:00')}` : null].filter(Boolean).join(' · '))),
            nota != null ? h('span', { class: `reg-nota ${nota >= 5 ? 'ok' : 'bad'}`, title: `${tries.length} ${tries.length === 1 ? 'intento' : 'intentos'}` }, `${String(nota).replace('.', ',')}/10`) : h('span', { class: 'muted' }, 'Sin intentar'));
        }))));
    }

    el.replaceChildren(page);
    render();

    // en segundo plano: conoce el nº de ejercicios de cada lección y repinta si no estás usando la tabla
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 500));
    idle(async () => {
      await loadAllLessons();
      if (alive && !S.open.size && !listEl.contains(document.activeElement)) render();
    });
  },
  unmount() { alive = false; },
};
