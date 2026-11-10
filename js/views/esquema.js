// Vista: esquema de comandos y comprensión (#/esquema) — página guía: anatomía, signos, familias e ideas clave.
import { store } from '../store.js?v=1794351414';
import { loadSchema, loadCommands, safe, cmdHref, familyIndex } from '../data.js?v=1794351414';
import { h, hlWL, mdLite, yearBadge, emptyState, skeleton, ghostCell } from '../fx.js?v=1794351414';

let alive = false;
let root = null;
const LEVEL_TXT = ['por aprender', 'visto', 'en práctica', 'dominado'];

/* ---------- anatomía ---------- */
const PARTS = {
  head: { k: 'Comando', t: 'El nombre de la orden. Siempre empieza por MAYÚSCULA y se escribe entero: Plot, Solve, Integrate. En minúscula Mathematica no lo reconoce (se queda en azul).' },
  br: { k: 'Corchetes', t: 'Los argumentos van SIEMPRE entre corchetes. Los paréntesis solo agrupan operaciones: Sin(x) está mal, Sin[x] está bien.' },
  what: { k: 'qué', t: 'El primer argumento: sobre qué actúa el comando. La función que dibujas, la ecuación que resuelves, la expresión que derivas.' },
  spec: { k: 'variable y recorrido', t: 'Una lista entre llaves que dice qué variable se mueve y entre qué valores. Algunos comandos solo piden la variable (Solve, D); otros, el recorrido completo (Plot, Table, Integrate).' },
  opt: { k: 'opción', t: 'Ajustes opcionales, siempre al final y siempre con flecha ->. Cambian el aspecto o el método sin cambiar lo que se calcula: PlotStyle -> Red, PlotRange -> All.' },
  sep: { k: 'Comas', t: 'Las comas separan los argumentos. El orden importa: primero el qué, luego la variable, al final las opciones.' },
};
const TEMPLATE = [['head', 'Comando'], ['br', '['], ['what', 'qué'], ['sep', ','], ['spec', '{variable, desde, hasta}'], ['sep', ','], ['opt', 'Opción -> valor'], ['br', ']']];
const EXAMPLES = [
  { parts: [['head', 'Plot'], ['br', '['], ['what', 'Sin[x]'], ['sep', ', '], ['spec', '{x, 0, 2 Pi}'], ['sep', ', '], ['opt', 'PlotStyle -> Red'], ['br', ']']], say: 'Dibuja Sin[x] con x entre 0 y 2π, en rojo.' },
  { parts: [['head', 'Integrate'], ['br', '['], ['what', 'x^2'], ['sep', ', '], ['spec', '{x, 0, 1}'], ['br', ']']], say: 'Integra x² con x entre 0 y 1.' },
  { parts: [['head', 'Table'], ['br', '['], ['what', 'n^2'], ['sep', ', '], ['spec', '{n, 1, 5}'], ['br', ']']], say: 'Lista de n² con n de 1 a 5.' },
  { parts: [['head', 'Solve'], ['br', '['], ['what', 'x^2 - 5 x + 6 == 0'], ['sep', ', '], ['spec', 'x'], ['br', ']']], say: 'Resuelve la ecuación; la incógnita es x (aquí basta la variable).' },
  { parts: [['head', 'Limit'], ['br', '['], ['what', 'Sin[x]/x'], ['sep', ', '], ['spec', 'x -> 0'], ['br', ']']], say: 'Límite cuando x tiende a 0 (la variable va con flecha).' },
  { parts: [['head', 'DSolve'], ['br', '['], ['what', "y'[x] == 2 y[x]"], ['sep', ', '], ['what', 'y[x]'], ['sep', ', '], ['spec', 'x'], ['br', ']']], say: 'Resuelve la EDO para la función y[x]; la variable es x.' },
];
const SIGNS = [
  ['[ ]', 'Corchetes', 'Argumentos de un comando o función.', 'Sin[Pi/2]'],
  ['{ }', 'Llaves', 'Listas: vectores, matrices, recorridos.', '{1, 2, 3}'],
  ['( )', 'Paréntesis', 'Solo para agrupar operaciones.', '(a + b)^2'],
  ['[[ ]]', 'Doble corchete', 'Sacar un elemento de una lista.', '{7, 8, 9}[[2]]'],
  ['=', 'Asignar', 'Guarda un valor en un nombre, ahora.', 'a = 3'],
  [':=', 'Definir', 'Define una función: se calcula al usarla.', 'f[x_] := x^2 + 1'],
  ['==', 'Ecuación', 'Igualdad matemática, para Solve y compañía.', 'x^2 == 4'],
  ['->', 'Regla', '«Cambia esto por esto». Así salen las soluciones.', 'x -> 2'],
  ['/.', 'Sustituir', 'Aplica una regla a una expresión.', 'x^2 + 1 /. x -> 3'],
  ['//', 'Después', 'Aplica un comando al resultado.', 'Sqrt[2] // N'],
  ['_', 'Patrón', '«Cualquier cosa». Imprescindible en f[x_].', 'g[t_] := Sin[2 t]'],
  [';', 'Silenciar', 'Ejecuta pero no muestra la salida.', 'b = 5;'],
  ['%', 'Último', 'El resultado anterior.', '% + 1'],
  ['(* *)', 'Comentario', 'Notas para ti: Mathematica las ignora.', '(* nota *)'],
];

function partsRow(parts, big) {
  return h('div', { class: `esq-code${big ? ' big' : ''}` }, parts.map(([p, txt]) =>
    h('button', { type: 'button', class: `esq-p p-${p}`, dataset: { part: p }, 'aria-label': `${txt.trim()}: ${PARTS[p].k}` },
      h('span', { class: 'esq-p-c' }, txt), big ? h('span', { class: 'esq-p-l' }, PARTS[p].k) : null)));
}

// schema.json trae sus propias explicaciones de cada pieza ({role, d}): si están, mandan
const ROLE_KEY = [[/comando|cabeza/i, 'head'], [/corchete/i, 'br'], [/^qu[eé]/i, 'what'], [/coma/i, 'sep'], [/variable|recorrido|d[oó]nde/i, 'spec'], [/opci[oó]n/i, 'opt']];
function applySchemaAnatomy(a) {
  for (const p of a?.parts || []) {
    const hit = ROLE_KEY.find(([re]) => re.test(p.role || ''));
    if (hit && p.d) PARTS[hit[1]] = { k: PARTS[hit[1]].k, t: p.d };
  }
}

function anatomy(schema) {
  applySchemaAnatomy(schema?.anatomy);
  const info = h('div', { class: 'esq-info', 'aria-live': 'polite' }, h('b', null, 'Pulsa cada pieza'), 'Casi todos los comandos tienen esta misma forma. Si aprendes a leer uno, los lees todos.');
  const sec = h('section', { id: 'esq-anatomia' },
    h('h2', { class: 'sec-title' }, 'Anatomía de un comando'),
    h('div', { class: 'esq-stage' }, partsRow(TEMPLATE, true)),
    info,
    h('div', { class: 'esq-exs' },
      h('div', { class: 'esq-exs-k' }, 'La misma forma en comandos reales:'),
      EXAMPLES.map((e) => h('div', { class: 'esq-ex' }, partsRow(e.parts), h('span', { class: 'esq-ex-say' }, e.say)))));
  const setPart = (key) => {
    for (const b of sec.querySelectorAll('.esq-p')) b.classList.toggle('on', b.dataset.part === key);
    info.replaceChildren(h('b', null, PARTS[key].k), PARTS[key].t);
  };
  sec.addEventListener('click', (e) => { const b = e.target.closest('.esq-p'); if (b) setPart(b.dataset.part); });
  sec.addEventListener('pointerover', (e) => { const b = e.target.closest('.esq-p'); if (b && e.pointerType === 'mouse') setPart(b.dataset.part); });
  sec.addEventListener('focusin', (e) => { const b = e.target.closest('.esq-p'); if (b) setPart(b.dataset.part); });
  return sec;
}

function signs() {
  return h('section', { id: 'esq-signos' },
    h('h2', { class: 'sec-title' }, 'Los signos que importan'),
    h('table', { class: 'esq-signs' }, h('tbody', null, SIGNS.map(([sym, name, desc, ex]) => h('tr', null,
      h('td', { class: 'esq-sign-s' }, sym), h('td', { class: 'esq-sign-n' }, name), h('td', { class: 'esq-sign-d' }, desc), h('td', null, h('code', { class: 'wlc', html: hlWL(ex) })))))));
}

/* ---------- familias ---------- */
function families(schema, cmds) {
  const fams = familyIndex(schema, cmds);
  if (!fams.length) return h('section', { id: 'esq-familias' }, h('h2', { class: 'sec-title' }, 'Familias de comandos'), emptyState({ title: 'El mapa de familias se está preparando', text: 'En cuanto esté el catálogo de comandos, aquí los verás agrupados por para qué sirven.' }));
  const stats = (f) => {
    const lv = f.commands.map((c) => store.cmdLevel(c.name));
    return { n: lv.length, learned: lv.filter((l) => l === 3).length, prac: lv.filter((l) => l === 1 || l === 2).length };
  };
  const main = h('div', { class: 'esq-fam-main' });
  const list = h('ul', { class: 'esq-famlist', role: 'tablist', 'aria-label': 'Familias de comandos' }, fams.map((f) =>
    h('li', null, h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { fam: f.id } }, h('span', null, f.name), h('span', { class: 'num' }, String(f.commands.length))))));

  const cmdCard = (c) => {
    const lv = store.cmdLevel(c.name);
    const st = store.cmd(c.name);
    return h('div', { class: 'esq-cmdcard' },
      h('div', { class: 'esq-cmdcard-top' }, h('a', { class: 'sym', href: cmdHref(c.name) }, c.name), yearBadge(c.year),
        h('span', { class: `mastery l${lv}`, role: 'img', 'aria-label': LEVEL_TXT[lv] }, h('i'), h('i'), h('i')),
        h('span', { class: 'esq-cmdcard-l' }, lv === 2 ? `en práctica · ${st?.ok || 0}/3` : LEVEL_TXT[lv])),
      c.syntax.slice(0, 2).map((s) => h('code', { class: 'wlc', html: hlWL(s) })),
      c.desc ? h('div', { class: 'md', html: mdLite(c.desc) }) : null,
      h('div', { class: 'row' }, h('a', { class: 'more', href: cmdHref(c.name) }, 'Ver la ficha'), h('a', { class: 'more', href: `#/practica/comando/${encodeURIComponent(c.name)}` }, 'Practicar')));
  };

  const select = (id) => {
    const f = fams.find((x) => x.id === id) || fams[0];
    for (const b of list.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.fam === f.id));
    const s = stats(f);
    const byFreq = (a, b) => b.freq - a.freq;
    const groups = f.groups.map((g) => {
      const box = h('div', { class: 'esq-group' },
        g.name ? h('h4', { class: 'sub-title' }, g.name) : null,
        h('div', { class: 'esq-syms sqs' }, [...g.commands].sort(byFreq).map((c) => h('button', { type: 'button', class: `l${store.cmdLevel(c.name)}`, dataset: { cmd: c.name }, 'aria-pressed': 'false', title: LEVEL_TXT[store.cmdLevel(c.name)] }, c.name))));
      return box;
    });
    main.replaceChildren(
      h('h3', null, f.name),
      h('p', { class: 'esq-fam-meta' }, `${s.n} comandos · ${s.learned} dominados · ${s.prac} en práctica`),
      f.desc ? h('div', { class: 'md esq-fam-desc', html: mdLite(f.desc) }) : null,
      f.pattern ? h('p', { class: 'esq-fam-pat' }, h('code', { class: 'wlc', html: hlWL(f.pattern) })) : null,
      ...groups,
      h('p', { class: 'esq-legend' }, 'Pulsa un comando para ver su resumen. ', h('span', { class: 'ok' }, '✓'), ' dominado · ', h('span', { class: 'pr' }, '·'), ' visto o en práctica'));
  };
  main.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const was = b.getAttribute('aria-pressed') === 'true';
    main.querySelector('.esq-cmdcard')?.remove();
    for (const x of main.querySelectorAll('[data-cmd]')) x.setAttribute('aria-pressed', 'false');
    if (was) return;
    b.setAttribute('aria-pressed', 'true');
    const c = cmds.byName.get(b.dataset.cmd);
    if (c) b.closest('.esq-group').appendChild(cmdCard(c));
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-fam]'); if (b) select(b.dataset.fam); });
  select(fams[0].id);

  return h('section', { id: 'esq-familias' },
    h('h2', { class: 'sec-title' }, 'Familias de comandos', h('small', null, `${cmds.commands.length} comandos en ${fams.length} familias`)),
    h('div', { class: 'esq-fam' }, list, main));
}

function rules(schema) {
  const rs = schema?.anatomy?.rules || [];
  if (!rs.length) return null;
  return h('section', { id: 'esq-reglas' },
    h('h2', { class: 'sec-title' }, 'Reglas que no fallan'),
    h('ol', { class: 'esq-rules' }, rs.map((r) => h('li', { class: 'md', html: mdLite(r).replace(/^<p>|<\/p>$/g, '') }))));
}

/** Fila plegable: título + resumen a la vista; el contenido (con sus celdas fantasma) se monta al abrirla. */
function fold(title, summary, build, extra) {
  const body = h('div', { class: 'esq-fold-b' });
  const d = h('details', { class: 'esq-fold' }, h('summary', null, h('span', { class: 'esq-fold-t' }, extra, title), summary ? h('span', { class: 'esq-fold-s' }, summary) : null), body);
  d.addEventListener('toggle', () => { if (d.open && !body.firstChild) body.append(...build().filter(Boolean)); });
  return d;
}

/* ---------- ideas clave (modelos mentales) ---------- */
function models(schema) {
  const ms = schema?.models || [];
  if (!ms.length) return null;
  return h('section', { id: 'esq-ideas' },
    h('h2', { class: 'sec-title' }, 'Ideas clave', h('small', null, 'ábrelas una a una y teclea sus ejemplos')),
    ms.map((m) => fold(m.title, m.idea, () => [
      m.text ? h('div', { class: 'md esq-model-t', html: mdLite(m.text) }) : null,
      ...m.cells.map((c) => h('div', { class: 'esq-cell' }, c.note ? h('small', null, c.note.charAt(0).toUpperCase() + c.note.slice(1) + ':') : null, ghostCell(h('div'), c.code))),
    ])));
}

/* ---------- recetas: qué comandos encadenar en cada problema típico ---------- */
function flows(schema, cmds) {
  const fs = schema?.flows || [];
  if (!fs.length) return null;
  const sym = (n) => (cmds?.byName.has(n) ? h('a', { class: 'sym', href: cmdHref(n) }, n) : h('b', null, n));
  return h('section', { id: 'esq-recetas' },
    h('h2', { class: 'sec-title' }, 'Recetas de examen', h('small', null, 'qué comandos encadenar en cada problema típico')),
    fs.map((f) => fold(f.title, f.when, () => [
      h('ol', { class: 'esq-steps' }, f.steps.map((st) => h('li', null,
        h('div', { class: 'esq-step-d' }, st.cmd ? [sym(st.cmd), h('span', { class: 'dash' }, ' — ')] : null, h('span', { class: 'md', html: mdLite(st.d || '').replace(/^<p>|<\/p>$/g, '') })),
        st.code ? ghostCell(h('div', { class: 'esq-cell' }), st.code) : null))),
      f.lessons.length ? h('p', { class: 'esq-fold-l' }, 'Se trabaja en: ', h('span', { class: 'sqs' }, f.lessons.map((id) => h('a', { href: `#/leccion/${encodeURIComponent(id)}` }, id)))) : null,
    ], yearBadge(f.year))));
}

function jumpTo(id) {
  const el = root?.querySelector('#' + id);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 60, behavior: 'smooth' });
}

export default {
  async mount(el) {
    alive = true; root = el;
    el.appendChild(h('div', { class: 'page esq' }, skeleton(6, 'skel-page')));
    const [schema, cmds] = await Promise.all([safe(loadSchema()), safe(loadCommands())]);
    if (!alive) return;
    const mm = models(schema), rr = rules(schema), ff = flows(schema, cmds);
    const nav = [['esq-anatomia', 'Anatomía de un comando'], ['esq-signos', 'Signos'], ...(rr ? [['esq-reglas', 'Reglas']] : []), ['esq-familias', 'Familias'], ...(mm ? [['esq-ideas', 'Ideas clave']] : []), ...(ff ? [['esq-recetas', 'Recetas de examen']] : [])];
    el.replaceChildren(h('div', { class: 'page esq' },
      h('header', { class: 'page-head doc' },
        h('span', { class: 'doc-tag' }, 'Guía'),
        h('h1', null, 'Esquema de comandos'),
        h('p', null, 'La forma que comparten todos los comandos, los signos que no debes confundir y el mapa de familias: lo que necesitas tener en la cabeza para leer y escribir Mathematica.'),
        h('div', { class: 'esq-toc sqs' }, nav.map(([id, t]) => h('button', { type: 'button', onclick: () => jumpTo(id) }, t)))),
      anatomy(schema), signs(), rr, families(schema, cmds), mm, ff));
  },
  unmount() { alive = false; root = null; },
};
