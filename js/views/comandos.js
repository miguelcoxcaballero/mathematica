// Vista: comandos (#/comandos = página guía con tres listas · #/comandos/<Nombre> = ficha tipo página de símbolo).
import { store } from '../store.js?v=1794352096';
import { loadCommands, loadSchema, loadCourse, safe, flatUnits, cmdHref, lessonHref, familyIndex } from '../data.js?v=1794352096';
import { h, hlWL, mdLite, yearBadge, emptyState, skeleton, timeAgo, ghostCell } from '../fx.js?v=1794352096';

let alive = false;
const S = { tab: null, q: '', fam: '', year: 0, sort: 'curso' };

const TABS = [
  { id: 'learned', label: 'Aprendidos', test: (l) => l === 3, hint: 'Los has usado bien en 3 ejercicios o más.' },
  { id: 'practice', label: 'En práctica', test: (l) => l === 1 || l === 2, hint: 'Ya los has visto o acertado alguna vez. Con tres aciertos pasan a aprendidos.' },
  { id: 'todo', label: 'Por aprender', test: (l) => l === 0, hint: 'Aún no los has tocado.' },
];
const LEVEL_TXT = ['Por aprender', 'Visto', 'En práctica', 'Dominado'];
const KIND_TAG = { function: 'Comando', operator: 'Operador', option: 'Opción', constant: 'Constante' };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plainMd = (s) => String(s || '').replace(/\*\*/g, '');

function mastery(lv) {
  return h('span', { class: `mastery l${lv}`, role: 'img', 'aria-label': LEVEL_TXT[lv], title: LEVEL_TXT[lv] }, h('i'), h('i'), h('i'));
}
/** `código` → <code>, resto escapado; una sola línea */
function inlineMd(s) {
  return mdLite(plainMd(s)).replace(/^<p>|<\/p>$/g, '').replace(/<\/p><p>/g, ' ');
}

/* =====================================================================
   LISTA (página guía)
   ===================================================================== */
async function mountList(el) {
  el.appendChild(h('div', { class: 'page cmd' }, skeleton(8, 'skel-page')));
  const [cmds, schema, course] = await Promise.all([safe(loadCommands()), safe(loadSchema()), safe(loadCourse())]);
  if (!alive) return;
  if (!cmds?.commands.length) {
    el.replaceChildren(h('div', { class: 'page cmd' }, emptyState({ title: 'El catálogo de comandos está en camino', text: 'Aquí tendrás todos los comandos de 1º y 2º con su ficha, sus ejemplos y tu nivel de dominio.', actions: [h('a', { class: 'btn primary', href: '#/indice' }, 'Ir al índice')] })));
    return;
  }
  const fams = familyIndex(schema, cmds);
  const famById = new Map(fams.map((f) => [f.id, f]));
  const order = new Map((course ? flatUnits(course) : []).map((u, i) => [u.lesson, i]));
  const all = cmds.commands;
  const level = (c) => store.cmdLevel(c.name);
  const counts = TABS.map((t) => all.filter((c) => t.test(level(c))).length);
  if (!S.tab) S.tab = counts[1] ? 'practice' : counts[0] ? 'learned' : 'todo';

  const body = h('div', { class: 'cmd-body' });
  const info = h('p', { class: 'cmd-info', 'aria-live': 'polite' });
  const tabs = h('div', { class: 'cmd-tabs', role: 'tablist', 'aria-label': 'Listas de comandos' }, TABS.map((t, i) =>
    h('button', { type: 'button', role: 'tab', class: 'cmd-tab', dataset: { tab: t.id }, 'aria-selected': String(S.tab === t.id), onclick: () => { S.tab = t.id; render(); } }, t.label, h('b', null, String(counts[i])))));

  const sorters = {
    curso: (a, b) => (order.get(a.firstLesson) ?? 999) - (order.get(b.firstLesson) ?? 999) || b.freq - a.freq || a.name.localeCompare(b.name),
    uso: (a, b) => b.freq - a.freq || a.name.localeCompare(b.name),
    az: (a, b) => a.name.localeCompare(b.name),
    reciente: (a, b) => (store.cmd(b.name)?.last || 0) - (store.cmd(a.name)?.last || 0) || b.freq - a.freq,
  };

  function row(c) {
    const lv = level(c);
    return h('li', { class: 'cmd-row' },
      h('span', { class: 'cmd-row-m' },
        h('a', { class: 'sym', href: cmdHref(c.name) }, c.name), c.symbol ? h('span', { class: 'cmd-sym' }, `(${c.symbol})`) : null,
        h('span', { class: 'dash' }, '—'), h('span', { html: inlineMd(c.desc.split(/(?<=\.)\s/)[0] || c.desc) })),
      h('span', { class: 'cmd-row-s' }, yearBadge(c.year), mastery(lv)));
  }

  function render() {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    const tab = TABS.find((t) => t.id === S.tab);
    const words = S.q.split(/\s+/).filter(Boolean);
    const hay = (c) => norm([c.name, c.symbol, c.desc, c._group, famById.get(c._fam)?.name, c.aka.join(' '), c.syntax.join(' ')].join(' '));
    const inTabAll = all.filter((c) => tab.test(level(c)));
    const list = inTabAll.filter((c) => (!S.fam || c._fam === S.fam) && (!S.year || c.year === S.year) && (!words.length || words.every((w) => hay(c).includes(w))));
    info.textContent = `${tab.hint}${list.length === inTabAll.length ? '' : ` Mostrando ${list.length} de ${inTabAll.length}.`}`;

    if (!list.length) {
      // ¿está en otra lista? primero los que coinciden por nombre, luego por sinónimo, luego por descripción
      const score = (c) => (words.every((w) => norm(c.name).includes(w)) ? 0 : words.every((w) => norm(c.aka.join(' ') + ' ' + (c.symbol || '')).includes(w)) ? 1 : 2);
      const elsewhere = words.length ? all.filter((c) => !tab.test(level(c)) && words.every((w) => hay(c).includes(w))).sort((a, b) => score(a) - score(b) || b.freq - a.freq).slice(0, 8) : [];
      const msg = inTabAll.length === 0
        ? { learned: ['Todavía no dominas ninguno', 'Un comando llega aquí cuando lo usas bien en 3 ejercicios.'], practice: ['Nada en marcha todavía', 'Abre una lección: cada comando que teclees aparecerá aquí.'], todo: ['Los has tocado todos', 'No queda ningún comando sin estrenar.'] }[S.tab]
        : ['Ningún comando con esos filtros', elsewhere.length ? 'Pero está en otra lista:' : 'Prueba con otra palabra o quita los filtros.'];
      body.replaceChildren(emptyState({
        title: msg[0], text: msg[1],
        actions: [
          elsewhere.length ? h('span', { class: 'sqs' }, elsewhere.map((c) => h('a', { class: 'sym', href: cmdHref(c.name) }, c.name))) : null,
          inTabAll.length === 0 ? h('a', { class: 'btn primary', href: '#/indice' }, 'Ir al índice') : h('button', { class: 'btn', type: 'button', onclick: () => { S.q = ''; S.fam = ''; S.year = 0; search.value = ''; famSel.value = ''; syncYear(); render(); } }, 'Quitar filtros'),
        ].filter(Boolean),
      }));
      return;
    }
    const kids = [];
    if (S.sort === 'curso') {
      // como una página guía: familia › grupo › comandos
      for (const f of fams) {
        const mine = list.filter((c) => c._fam === f.id);
        if (!mine.length) continue;
        kids.push(h('h2', { class: 'cmd-fam' }, f.name));
        for (const g of f.groups) {
          const rows = g.commands.filter((c) => mine.includes(c)).sort(sorters.curso);
          if (!rows.length) continue;
          if (g.name) kids.push(h('h3', { class: 'cmd-group' }, g.name));
          kids.push(h('ul', { class: 'cmd-list' }, rows.map(row)));
        }
      }
    } else {
      kids.push(h('ul', { class: 'cmd-list' }, [...list].sort(sorters[S.sort]).map(row)));
    }
    body.replaceChildren(...kids);
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar un comando o para qué sirve', 'aria-label': 'Buscar comando', 'data-search': '', value: S.q, autocomplete: 'off', spellcheck: 'false' });
  let deb = 0;
  search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { S.q = norm(search.value.trim()); render(); }, 100); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = body.querySelector('.cmd-row a'); if (first) location.hash = first.getAttribute('href'); } });

  const famSel = h('select', { class: 'input', 'aria-label': 'Familia' }, h('option', { value: '' }, 'Todas las familias'), fams.map((f) => h('option', { value: f.id }, `${f.name} (${f.commands.length})`)));
  famSel.value = S.fam;
  famSel.addEventListener('change', () => { S.fam = famSel.value; render(); });

  const yearSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Curso' }, [[0, 'Todos'], [1, '1º'], [2, '2º']].map(([v, t]) => h('button', { type: 'button', dataset: { val: v }, 'aria-pressed': String(S.year === v), onclick: () => { S.year = v; syncYear(); render(); } }, t)));
  function syncYear() { for (const b of yearSeg.children) b.setAttribute('aria-pressed', String(Number(b.dataset.val) === S.year)); }

  const sortSel = h('select', { class: 'input', 'aria-label': 'Orden' }, [['curso', 'Por familias'], ['uso', 'Más usados primero'], ['az', 'A → Z'], ['reciente', 'Tocados hace poco']].map(([v, t]) => h('option', { value: v }, t)));
  sortSel.value = S.sort;
  sortSel.addEventListener('change', () => { S.sort = sortSel.value; render(); });

  el.replaceChildren(h('div', { class: 'page cmd' },
    h('header', { class: 'page-head doc' },
      h('span', { class: 'doc-tag' }, 'Guía'),
      h('h1', null, 'Comandos'),
      h('p', null, `Los ${all.length} comandos que aparecen en tus prácticas y exámenes de 1º y 2º. Cada uno sube de nivel cuando lo usas bien en un ejercicio.`)),
    tabs,
    h('div', { class: 'cmd-tools' }, h('label', { class: 'search' }, search, h('kbd', null, '/')), famSel, yearSeg, sortSel),
    info, body));
  render();
}

/* =====================================================================
   FICHA (página de símbolo)
   ===================================================================== */
async function mountDetail(el, name) {
  el.appendChild(h('div', { class: 'page cmd' }, skeleton(8, 'skel-page')));
  const [cmds, schema, course] = await Promise.all([safe(loadCommands()), safe(loadSchema()), safe(loadCourse())]);
  if (!alive) return;
  const c = cmds?.byName.get(name) || cmds?.commands.find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.symbol === name);
  if (!c) {
    const key = norm(name).slice(0, 4);
    const near = (cmds?.commands || []).filter((x) => norm(x.name).includes(key) || norm(name).includes(norm(x.name))).slice(0, 8);
    el.replaceChildren(h('div', { class: 'page cmd' },
      h('div', { class: 'cmd-crumb' }, h('a', { href: '#/comandos' }, '‹ Comandos')),
      emptyState({
        title: cmds ? `No hay ficha de «${name}»` : 'El catálogo de comandos está en camino',
        text: cmds ? 'Puede que no entre en tus prácticas o que se escriba de otra forma (recuerda: empiezan por mayúscula).' : 'En cuanto esté publicado podrás consultar aquí cada comando.',
        actions: [near.length ? h('span', { class: 'sqs' }, near.map((x) => h('a', { class: 'sym', href: cmdHref(x.name) }, x.name))) : null, h('a', { class: 'btn', href: '#/comandos' }, 'Ver todos')].filter(Boolean),
      })));
    return;
  }
  store.markSeen(c.name);
  const fams = familyIndex(schema, cmds);
  const f = fams.find((x) => x.id === c._fam);
  const units = new Map((course ? flatUnits(course) : []).map((u) => [u.lesson, u]));
  const lv = store.cmdLevel(c.name);
  const st = store.cmd(c.name) || {};
  const sibs = f ? f.groups.flatMap((g) => g.commands) : [];
  const ix = sibs.indexOf(c);
  const prev = sibs[ix - 1], next = sibs[ix + 1];
  const practiceHref = `#/practica/comando/${encodeURIComponent(c.name)}`;
  const link = (n) => (cmds.byName.has(n) ? h('a', { class: 'sym', href: cmdHref(n) }, n) : h('span', { class: 'opt' }, n));
  const sec = (title, body, extra) => h('section', { class: 'cmd-sec' }, h('h2', { class: 'sec-title' }, title, extra ? h('small', null, extra) : null), body);

  const usedIn = [...new Set([c.firstLesson, ...c.usedIn].filter(Boolean))];
  const stateTxt = lv === 3 ? 'Lo has usado bien en 3 ejercicios o más.' : lv === 2 ? `${st.ok} de 3 aciertos para dominarlo.` : lv === 1 ? 'Lo has visto; falta usarlo bien en un ejercicio.' : 'Todavía no lo has usado.';

  el.replaceChildren(h('div', { class: 'page cmd cmd-detail' },
    h('div', { class: 'cmd-crumb' },
      h('span', null, h('a', { href: '#/comandos' }, 'Comandos'), f ? ` › ${f.name}` : '', c._group ? ` › ${c._group}` : ''),
      c.related.length ? h('span', null, 'Ver también: ', h('span', { class: 'sqs' }, c.related.slice(0, 3).map(link))) : null),
    h('header', { class: 'page-head doc', style: { marginTop: '18px' } },
      h('span', { class: 'doc-tag is-sym' }, KIND_TAG[c.kind] || 'Comando'),
      h('h1', { class: 'cmd-name' }, c.name, c.symbol ? h('span', { class: 'cmd-sym' }, c.symbol) : null, yearBadge(c.year))),
    // caja de sintaxis azul muy claro, como en la documentación
    h('div', { class: 'cmd-syn' },
      (c.syntax.length ? c.syntax : [c.name]).map((s, i) => h('div', { class: 'cmd-syn-row' }, h('code', { class: 'wlc', html: hlWL(s) }), i === 0 && c.desc ? h('div', { class: 'md', html: mdLite(c.desc).replace(/^<p>/, '<p>') }) : null))),
    h('div', { class: 'cmd-state' }, mastery(lv), h('span', { class: 'cmd-state-l' }, LEVEL_TXT[lv]), h('span', { class: 'muted' }, stateTxt, st.last ? ` Última vez: ${timeAgo(st.last)}.` : ''),
      h('a', { class: 'btn primary', href: practiceHref }, 'Practicar este comando')),
    c.args.length ? sec('Qué es cada cosa', h('dl', { class: 'cmd-args' }, c.args.flatMap((a) => [h('dt', null, a.n ?? a.name ?? ''), h('dd', { class: 'md', html: mdLite(a.d ?? a.desc ?? '') })]))) : null,
    c.examples.length ? sec('Ejemplos', h('div', null,
      h('p', { class: 'muted cmd-ex-tip' }, 'Teclea cada ejemplo tal cual: el gris se vuelve negro según lo escribes. Luego, Mayús + Intro.'),
      c.examples.map((e) => h('div', { class: 'cmd-ex' }, e.note ? h('div', { class: 'cmd-ex-note md', html: mdLite(e.note.charAt(0).toUpperCase() + e.note.slice(1) + (/[.:?!]$/.test(e.note) ? '' : ':')) }) : null, ghostCell(h('div'), e.code)))), `${c.examples.length}`) : null,
    c.pitfalls.length ? sec('Errores típicos', h('ul', { class: 'cmd-pitfalls' }, c.pitfalls.map((p) => h('li', { class: 'md', html: inlineMd(p) })))) : null,
    c.options.length ? sec('Opciones habituales', h('div', { class: 'cmd-inline sqs' }, c.options.map(link))) : null,
    c.of.length ? sec('Es una opción de', h('div', { class: 'cmd-inline sqs' }, c.of.map(link))) : null,
    c.related.length ? sec('Relacionados', h('div', { class: 'cmd-inline sqs' }, c.related.map(link))) : null,
    usedIn.length ? sec('Dónde lo usas', h('ul', { class: 'cmd-lessons' }, usedIn.slice(0, 14).map((id) => {
      const u = units.get(id);
      const yr = u?.year || (String(id).startsWith('2') ? 2 : 1);
      return h('li', null, yearBadge(yr), h('span', null, h('a', { href: lessonHref(id) }, u?.practice || id), u ? h('small', null, ` ${u.title}`) : null, id === c.firstLesson ? h('small', null, ' (estreno)') : null));
    }), usedIn.length > 14 ? h('li', { class: 'muted' }, `y ${usedIn.length - 14} lecciones más`) : null), c.freq ? `aparece ${c.freq} veces en tu material` : '') : null,
    h('div', { class: 'cmd-nav' },
      prev ? h('a', { href: cmdHref(prev.name) }, `‹ ${prev.name}`) : h('span'),
      next ? h('a', { href: cmdHref(next.name) }, `${next.name} ›`) : h('span'))));
}

export default {
  async mount(el, params) {
    alive = true;
    const name = params?.name;
    if (name) await mountDetail(el, name); else await mountList(el);
  },
  unmount() { alive = false; },
};
