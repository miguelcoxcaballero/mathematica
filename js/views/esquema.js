// Vista: esquema de comandos y comprensión (#/esquema) — la chuleta visual: anatomía, signos, familias e ideas clave.
import { store } from '../store.js';
import { loadSchema, loadCommands, safe, cmdHref, notebookHref } from '../data.js';
import { h, icon, hlWL, wlPre, mdLite, yearBadge, emptyState, skeleton } from '../fx.js';

let alive = false;
let root = null;

/* ---------- anatomía ---------- */
const PARTS = {
  head: { k: 'Comando', t: 'El nombre de la orden. Siempre empieza por MAYÚSCULA y se escribe entero: Plot, Solve, Integrate. Si lo escribes en minúscula, Mathematica no lo reconoce (se queda en azul).' },
  br: { k: '[ corchetes ]', t: 'Los argumentos van SIEMPRE entre corchetes. Los paréntesis solo sirven para agrupar operaciones: Sin(x) está mal, Sin[x] está bien.' },
  what: { k: 'qué', t: 'El primer argumento: sobre qué actúa el comando. La función que dibujas, la ecuación que resuelves, la expresión que derivas…' },
  spec: { k: '{variable, desde, hasta}', t: 'Una lista entre llaves que dice qué variable se mueve y entre qué valores. Algunos comandos solo piden la variable (Solve, D); otros, el recorrido completo (Plot, Table, Integrate).' },
  opt: { k: 'Opción -> valor', t: 'Ajustes opcionales, siempre al final y siempre con flecha ->. Cambian el aspecto o el método sin cambiar lo que se calcula: PlotStyle -> Red, PlotRange -> All…' },
  sep: { k: ', comas', t: 'Las comas separan los argumentos. El orden importa: primero el qué, luego la variable, al final las opciones.' },
};
const TEMPLATE = [['head', 'Comando'], ['br', '['], ['what', 'qué'], ['sep', ','], ['spec', '{variable, desde, hasta}'], ['sep', ','], ['opt', 'Opción -> valor'], ['br', ']']];
const EXAMPLES = [
  { parts: [['head', 'Plot'], ['br', '['], ['what', 'Sin[x]'], ['sep', ','], ['spec', '{x, 0, 2 Pi}'], ['sep', ','], ['opt', 'PlotStyle -> Red'], ['br', ']']], say: 'Dibuja Sin[x] con x entre 0 y 2π, en rojo.' },
  { parts: [['head', 'Integrate'], ['br', '['], ['what', 'x^2'], ['sep', ','], ['spec', '{x, 0, 1}'], ['br', ']']], say: 'Integra x² con x entre 0 y 1.' },
  { parts: [['head', 'Table'], ['br', '['], ['what', 'n^2'], ['sep', ','], ['spec', '{n, 1, 5}'], ['br', ']']], say: 'Haz la lista de n² con n de 1 a 5.' },
  { parts: [['head', 'Solve'], ['br', '['], ['what', 'x^2 - 5 x + 6 == 0'], ['sep', ','], ['spec', 'x'], ['br', ']']], say: 'Resuelve la ecuación; la incógnita es x (aquí basta la variable).' },
  { parts: [['head', 'Limit'], ['br', '['], ['what', 'Sin[x]/x'], ['sep', ','], ['spec', 'x -> 0'], ['br', ']']], say: 'Límite de Sin[x]/x cuando x tiende a 0 (la variable va con flecha).' },
  { parts: [['head', 'NDSolve'], ['br', '['], ['what', "{y'[t] == -2 y[t], y[0] == 1}"], ['sep', ','], ['what2', 'y'], ['sep', ','], ['spec', '{t, 0, 5}'], ['br', ']']], say: 'Resuelve numéricamente la EDO con su condición inicial, para la función y, con t de 0 a 5.' },
];
const SIGNS = [
  ['[ ]', 'Corchetes', 'Argumentos de un comando o función.', 'Sin[Pi/2]', 'br'],
  ['{ }', 'Llaves', 'Listas: vectores, matrices, recorridos.', '{1, 2, 3}', 'cb'],
  ['( )', 'Paréntesis', 'Solo para agrupar operaciones.', '(a + b)^2', 'pa'],
  ['[[ ]]', 'Doble corchete', 'Sacar un elemento de una lista.', '{7, 8, 9}[[2]]', 'pt'],
  ['=', 'Asignar', 'Guarda un valor en un nombre, ya.', 'a = 3', 'op'],
  [':=', 'Definir', 'Define una función: se calcula al usarla.', 'f[x_] := x^2 + 1', 'op'],
  ['==', 'Ecuación', 'Igualdad matemática, para Solve y compañía.', 'Solve[x^2 == 4, x]', 'op'],
  ['->', 'Regla', '«Cambia esto por esto». Así salen las soluciones.', 'x -> 2', 'op'],
  ['/.', 'Sustituir', 'Aplica una regla a una expresión.', 'x^2 + 1 /. x -> 3', 'op'],
  ['//', 'Después', 'Aplica un comando al resultado.', 'Sqrt[2] // N', 'op'],
  ['_', 'Patrón', '«Cualquier cosa». Imprescindible en f[x_].', 'g[t_] := Sin[2 t]', 'pat'],
  [';', 'Silenciar', 'Ejecuta pero no muestra la salida.', 'b = 5;', 'pa'],
  ['%', 'Último', 'El resultado anterior.', '%  + 1', 'op'],
  ['(* *)', 'Comentario', 'Notas para ti: Mathematica las ignora.', '(* esto no se ejecuta *)', 'com'],
];

function partsRow(parts, big) {
  return h('div', { class: `esq-code${big ? ' big' : ''}` }, parts.map(([p, txt]) => {
    const key = p === 'what2' ? 'what' : p;
    return h('button', { type: 'button', class: `esq-p p-${key}`, dataset: { part: key }, 'aria-label': `${txt}: ${PARTS[key].k}` },
      h('span', { class: 'esq-p-c' }, txt), big ? h('span', { class: 'esq-p-l' }, PARTS[key].k.replace(/^\[ corchetes \]$/, 'corchete').replace(', comas', 'coma')) : null);
  }));
}

function anatomy() {
  const info = h('div', { class: 'esq-info', 'aria-live': 'polite' }, h('b', null, 'Toca cada pieza'), h('span', null, 'Casi todos los comandos de Mathematica tienen esta misma forma. Si aprendes a leer una, las lees todas.'));
  const sec = h('section', { class: 'esq-anat card', id: 'esq-anatomia' },
    h('h2', { class: 'sec-title' }, 'Anatomía de un comando', h('small', null, 'la plantilla que se repite')),
    h('div', { class: 'esq-stage' }, partsRow(TEMPLATE, true)),
    info,
    h('div', { class: 'esq-exs' },
      h('div', { class: 'esq-exs-k' }, 'Mismos colores, comandos reales:'),
      EXAMPLES.map((e) => {
        const code = e.parts.map(([p, t]) => (p === 'sep' ? t + ' ' : t)).join('');
        return h('div', { class: 'esq-ex' }, partsRow(e.parts), h('span', { class: 'esq-ex-say muted' }, e.say), h('a', { class: 'btn sm ghost esq-try', href: notebookHref(code), title: 'Abrir en el cuaderno' }, h('span', { html: icon('play', 12) }), 'probar'));
      })));
  const setPart = (key) => {
    for (const b of sec.querySelectorAll('.esq-p')) b.classList.toggle('on', b.dataset.part === key);
    info.replaceChildren(h('b', { class: `p-${key}` }, PARTS[key].k), h('span', null, PARTS[key].t));
    sec.dataset.sel = key;
  };
  sec.addEventListener('click', (e) => { const b = e.target.closest('.esq-p'); if (b) setPart(b.dataset.part); });
  sec.addEventListener('pointerover', (e) => { const b = e.target.closest('.esq-p'); if (b && e.pointerType === 'mouse') setPart(b.dataset.part); });
  sec.addEventListener('focusin', (e) => { const b = e.target.closest('.esq-p'); if (b) setPart(b.dataset.part); });
  return sec;
}

function signs() {
  return h('section', { class: 'esq-signs', id: 'esq-signos' },
    h('h2', { class: 'sec-title' }, 'Los signos que importan', h('small', null, 'confundirlos es el 80 % de los errores')),
    h('div', { class: 'esq-signgrid' }, SIGNS.map(([sym, name, desc, ex, cls]) =>
      h('a', { class: `esq-sign s-${cls}`, href: notebookHref(ex), title: 'Probar en el cuaderno' },
        h('span', { class: 'esq-sign-s mono' }, sym),
        h('span', { class: 'esq-sign-t' }, h('b', null, name), h('small', { class: 'muted' }, desc)),
        h('code', { class: 'esq-sign-e', html: hlWL(ex) })))));
}

/* ---------- familias ---------- */
function families(schema, cmds) {
  let fams = (schema?.families || []).map((f) => ({ ...f }));
  const byName = cmds?.byName || new Map();
  // completa con commands.json: si la familia no lista comandos, se deducen por `cat`
  if (cmds) {
    for (const f of fams) if (!f.commands.length) f.commands = cmds.commands.filter((c) => c.cat === f.id).map((c) => c.name);
    if (!fams.length) {
      const cats = new Map();
      for (const c of cmds.commands) { if (!cats.has(c.cat)) cats.set(c.cat, []); cats.get(c.cat).push(c.name); }
      const COLORS = ['#22d3ee', '#7c5cff', '#ff9f43', '#3ddc97', '#ff5d73', '#ffd166', '#19e3c5', '#b25cff', '#60a5fa', '#f472b6', '#a3e635', '#EB6235'];
      fams = [...cats].map(([id, list], i) => ({ id, name: id, color: COLORS[i % COLORS.length], desc: '', commands: list }));
    }
  }
  fams = fams.filter((f) => f.commands.length);
  if (!fams.length) return h('section', { id: 'esq-familias' }, h('h2', { class: 'sec-title' }, 'Familias de comandos'), emptyState({ icon: 'graph', title: 'El mapa de familias se está dibujando', text: 'En cuanto esté el catálogo de comandos, aquí verás todos agrupados por para qué sirven.' }));

  const stats = (f) => {
    const lv = f.commands.map((c) => store.cmdLevel(c));
    return { n: lv.length, learned: lv.filter((l) => l === 3).length, prac: lv.filter((l) => l === 1 || l === 2).length };
  };
  const total = fams.reduce((s, f) => s + f.commands.length, 0);

  const panel = h('div', { class: 'esq-fam-panel card' });
  const map = h('div', { class: 'esq-map', role: 'tablist', 'aria-label': 'Familias de comandos' });
  const n = fams.length;
  const maxN = Math.max(...fams.map((f) => f.commands.length));
  const lines = [];
  fams.forEach((f, i) => {
    const s = stats(f);
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const rr = n > 10 ? (i % 2 ? 1 : 0.7) : 1;
    const x = 50 + 40 * rr * Math.cos(ang), y = 50 + 37 * rr * Math.sin(ang);
    const size = Math.round(84 + 46 * Math.sqrt(f.commands.length / maxN));
    lines.push(`<line x1="50" y1="50" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${f.color}" stroke-opacity=".35" stroke-width=".35" stroke-dasharray=".8 1" vector-effect="non-scaling-stroke"/>`);
    const pctL = s.n ? (s.learned / s.n) * 100 : 0, pctP = s.n ? ((s.learned + s.prac) / s.n) * 100 : 0;
    const b = h('button', {
      class: 'esq-bub', type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { fam: f.id },
      style: { left: `${x}%`, top: `${y}%`, width: `${size}px`, height: `${size}px`, '--c': f.color, '--ring': `conic-gradient(var(--ok) 0 ${pctL}%, ${f.color} ${pctL}% ${pctP}%, rgba(255,255,255,.1) ${pctP}% 100%)` },
      title: `${f.name}: ${s.learned} dominados, ${s.prac} en práctica, de ${s.n}`,
    }, h('span', { class: 'esq-bub-n' }, f.name), h('span', { class: 'esq-bub-c mono' }, `${s.learned}/${s.n}`));
    b.style.setProperty('--c', f.color);
    b.style.setProperty('--ring', `conic-gradient(var(--ok) 0 ${pctL}%, ${f.color} ${pctL}% ${pctP}%, rgba(255,255,255,.1) ${pctP}% 100%)`);
    b.style.animationDelay = `${i * 45}ms`;
    map.appendChild(b);
  });
  map.prepend(h('div', { class: 'esq-map-lines', 'aria-hidden': 'true', html: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${lines.join('')}</svg>` }));
  map.appendChild(h('div', { class: 'esq-core', 'aria-hidden': 'true' }, h('b', null, String(total)), h('span', null, 'comandos'), h('small', null, `${fams.length} familias`)));

  const cmdCard = (name) => {
    const c = byName.get(name);
    const lv = store.cmdLevel(name);
    const st = store.cmd(name);
    return h('div', { class: 'esq-cmdcard' },
      h('div', { class: 'esq-cmdcard-top' }, h('b', { class: 'mono esq-cmdcard-n' }, name), c ? yearBadge(c.year) : null,
        h('span', { class: `mastery l${lv}`, title: ['Por aprender', 'Visto', 'En práctica', 'Dominado'][lv] }, h('i'), h('i'), h('i')),
        h('span', { class: 'muted esq-cmdcard-l' }, ['Por aprender', 'Visto', `En práctica · ${st?.ok || 0}/3`, 'Dominado'][lv])),
      c?.syntax?.length ? wlPre(c.syntax.slice(0, 2).join('\n')) : null,
      h('p', { class: 'esq-cmdcard-d' }, c?.desc || 'Aún no hay ficha para este comando.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn sm primary', href: cmdHref(name) }, 'Ver ficha', h('span', { html: icon('arrow', 14) })),
        h('a', { class: 'btn sm', href: `#/practica/comando/${encodeURIComponent(name)}` }, h('span', { html: icon('bolt', 14) }), 'Practicar'),
        c?.examples?.[0] ? h('a', { class: 'btn sm ghost', href: notebookHref(c.examples[0].code) }, h('span', { html: icon('play', 12) }), 'probar') : null));
  };

  const select = (id, cmdName) => {
    const f = fams.find((x) => x.id === id) || fams[0];
    for (const b of map.querySelectorAll('.esq-bub')) { const on = b.dataset.fam === f.id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const s = stats(f);
    const sorted = [...f.commands].sort((a, b) => (byName.get(b)?.freq || 0) - (byName.get(a)?.freq || 0));
    const first = cmdName && f.commands.includes(cmdName) ? cmdName : sorted[0];
    const cardBox = h('div', { class: 'esq-fam-card' }, cmdCard(first));
    const chips = h('div', { class: 'chips esq-fam-chips' }, sorted.map((c) => h('button', { type: 'button', class: `chip l${store.cmdLevel(c)}${c === first ? ' sel' : ''}`, dataset: { cmd: c }, 'aria-pressed': String(c === first) }, c)));
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      for (const x of chips.children) { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); }
      cardBox.replaceChildren(cmdCard(b.dataset.cmd));
    });
    panel.style.setProperty('--c', f.color);
    panel.replaceChildren(
      h('div', { class: 'esq-fam-main' },
        h('div', { class: 'esq-fam-head' }, h('i', { class: 'esq-fam-dot' }), h('h3', null, f.name), h('span', { class: 'mono muted' }, `${s.learned} dominados · ${s.prac} en práctica · ${s.n} en total`)),
        f.desc ? h('div', { class: 'muted md esq-fam-desc', html: mdLite(f.desc) }) : null,
        f.idea ? h('div', { class: 'esq-fam-idea' }, typeof f.idea === 'string' && /[\[\]]/.test(f.idea) && !/\s[a-záéíóú]{3,}\s[a-záéíóú]{3,}\s/.test(f.idea) ? wlPre(f.idea) : h('span', { class: 'md', html: mdLite(String(f.idea)) })) : null,
        chips,
        h('div', { class: 'esq-chiplegend muted' }, h('span', { class: 'chip l0' }, 'por aprender'), h('span', { class: 'chip l1' }, 'visto'), h('span', { class: 'chip l2' }, 'en práctica'), h('span', { class: 'chip l3' }, 'dominado'))),
      cardBox);
  };
  map.addEventListener('click', (e) => { const b = e.target.closest('.esq-bub'); if (b) { select(b.dataset.fam); if (window.innerWidth < 900) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } });
  // primera familia: la que más tengas en práctica, o la primera
  const start = [...fams].sort((a, b) => stats(b).prac - stats(a).prac)[0];
  select(stats(start).prac ? start.id : fams[0].id);

  return h('section', { class: 'esq-fams', id: 'esq-familias' },
    h('h2', { class: 'sec-title' }, 'Familias de comandos', h('small', null, 'toca una familia y luego un comando')),
    map, panel);
}

/* ---------- modelos mentales ---------- */
function models(schema) {
  const ms = schema?.models || [];
  if (!ms.length) return null;
  return h('section', { class: 'esq-models', id: 'esq-ideas' },
    h('h2', { class: 'sec-title' }, 'Ideas clave', h('small', null, 'los modelos mentales que lo desbloquean todo')),
    h('div', { class: 'esq-modelgrid' }, ms.map((m, i) => h('article', { class: 'card esq-model' },
      h('div', { class: 'esq-model-n mono', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
      h('h3', null, m.title),
      m.text ? h('div', { class: 'md esq-model-t', html: mdLite(m.text) }) : null,
      m.cells.map((c) => h('div', { class: 'esq-cell' },
        wlPre(c.code),
        h('div', { class: 'esq-cell-f' }, c.note ? h('span', { class: 'muted' }, c.note) : h('span'), h('a', { class: 'btn sm ghost esq-try', href: notebookHref(c.code), title: 'Abrir en el cuaderno y ejecutarlo' }, h('span', { html: icon('play', 12) }), 'probar'))))))));
}

function jumpTo(id) {
  const el = root?.querySelector('#' + id);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: 'smooth' });
}

export default {
  async mount(el) {
    alive = true; root = el;
    el.appendChild(h('div', { class: 'page esq' }, h('div', { class: 'card' }, skeleton(5)), h('div', { class: 'card' }, skeleton(5))));
    const [schema, cmds] = await Promise.all([safe(loadSchema()), safe(loadCommands())]);
    if (!alive) return;
    const mm = models(schema);
    const nav = [['esq-anatomia', 'Anatomía'], ['esq-signos', 'Signos'], ['esq-familias', 'Familias'], ...(mm ? [['esq-ideas', 'Ideas clave']] : [])];
    el.replaceChildren(h('div', { class: 'page esq' },
      h('header', { class: 'page-head' },
        h('div', null,
          h('span', { class: 'kicker' }, 'esquema de comandos y comprensión'),
          h('h1', null, 'El mapa: cómo piensa Mathematica'),
          h('p', null, 'Tu chuleta visual. Primero la forma que comparten todos los comandos, luego los signos, las familias y las ideas que hacen que todo encaje.')),
        h('div', { class: 'seg esq-nav', role: 'group', 'aria-label': 'Secciones' }, nav.map(([id, t]) => h('button', { type: 'button', onclick: () => jumpTo(id) }, t)))),
      anatomy(), signs(), families(schema, cmds), mm));
  },
  unmount() { alive = false; root = null; },
};
