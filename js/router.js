// router.js (SHELL) — enrutado por hash (SPEC §4).
// Cada vista: export default { mount(el, params), unmount?(), update?(params) }.
//  #/  #/indice  #/registro  #/esquema  #/comandos  #/comandos/<Nombre>
//  #/leccion/<lessonId>[/<paso>]  #/practica  #/practica/comando/<Nombre>  #/practica/tema/<lessonId>  #/practica/aleatoria
//  #/simulacros  #/simulacro/<examId>  #/cuaderno
import { emptyState, h, icon } from './fx.js?v=1794354103';

const LOADERS = {
  home: () => import('./views/home.js?v=1794354103'),
  indice: () => import('./views/indice.js?v=1794354103'),
  registro: () => import('./views/registro.js?v=1794354103'),
  esquema: () => import('./views/esquema.js?v=1794354103'),
  comandos: () => import('./views/comandos.js?v=1794354103'),
  cuaderno: () => import('./views/cuaderno.js?v=1794354103'),
  leccion: () => import('./views/leccion.js?v=1794354103'),
  practica: () => import('./views/practica.js?v=1794354103'),
  simulacro: () => import('./views/simulacro.js?v=1794354103'),
};

// re → vista; keys = nombres de los grupos capturados; extra = params fijos. `nav` = entrada del menú que se ilumina.
const ROUTES = [
  { re: /^\/?$/, view: 'home', nav: 'home', title: 'Inicio' },
  { re: /^\/indice$/, view: 'indice', nav: 'indice', title: 'Índice de contenidos' },
  { re: /^\/registro$/, view: 'registro', nav: 'registro', title: 'Registro de prácticas' },
  { re: /^\/esquema$/, view: 'esquema', nav: 'esquema', title: 'Esquema de comandos' },
  { re: /^\/comandos$/, view: 'comandos', nav: 'comandos', title: 'Comandos' },
  { re: /^\/comandos\/([^/]+)$/, view: 'comandos', nav: 'comandos', keys: ['name'], title: (p) => p.name },
  { re: /^\/leccion\/([^/]+)(?:\/([^/]+))?$/, view: 'leccion', nav: 'indice', keys: ['lessonId', 'paso'], title: 'Lección' },
  { re: /^\/practica$/, view: 'practica', nav: 'practica', extra: { mode: 'menu' }, title: 'Práctica' },
  { re: /^\/practica\/comando\/([^/]+)$/, view: 'practica', nav: 'practica', keys: ['name'], extra: { mode: 'comando' }, title: (p) => `Practicar ${p.name}` },
  { re: /^\/practica\/tema\/([^/]+)$/, view: 'practica', nav: 'practica', keys: ['lessonId'], extra: { mode: 'tema' }, title: 'Práctica por tema' },
  { re: /^\/practica\/aleatoria$/, view: 'practica', nav: 'practica', extra: { mode: 'aleatoria' }, title: 'Práctica aleatoria' },
  { re: /^\/simulacros$/, view: 'simulacro', nav: 'simulacros', extra: { list: true }, title: 'Simulacros' },
  { re: /^\/simulacro\/([^/]+)$/, view: 'simulacro', nav: 'simulacros', keys: ['examId'], title: 'Simulacro' },
  { re: /^\/cuaderno$/, view: 'cuaderno', nav: 'cuaderno', title: 'Cuaderno libre' },
];

const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** '#/comandos/Plot?x=1' → {path, parts, query, view, nav, params} */
export function parseHash(hash = location.hash) {
  let raw = String(hash || '').replace(/^#/, '');
  if (!raw.startsWith('/')) raw = '/' + raw;
  const qi = raw.indexOf('?');
  const path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/\/+$/, '') || '/';
  const query = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(raw.slice(qi + 1))) query[k] = v;
  const parts = path.split('/').filter(Boolean).map(dec);
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = { ...(r.extra || {}) };
    (r.keys || []).forEach((k, i) => { if (m[i + 1] != null) params[k] = dec(m[i + 1]); });
    // alias cómodos para que cada vista lea el que prefiera
    if (params.lessonId) { params.id = params.lessonId; params.lesson = params.lessonId; if (r.view === 'practica') params.tema = params.lessonId; }
    if (params.examId) { params.id = params.examId; params.exam = params.examId; }
    if (params.name) { params.id = params.name; params.cmd = params.name; params.comando = params.name; }
    if (params.paso != null) { const n = Number(params.paso); if (Number.isFinite(n)) params.step = n; }
    Object.assign(params, { route: path, path, parts, query, view: r.view });
    const title = typeof r.title === 'function' ? r.title(params) : r.title;
    return { path, parts, query, view: r.view, nav: r.nav, params, title, found: true };
  }
  return { path, parts, query, view: null, nav: null, params: { route: path, path, parts, query }, title: 'No encontrado', found: false };
}

const listeners = new Set();
let outlet = null;
let current = null; // {view, mod, path, key}
let token = 0;
let traverse = false; // navegación atrás/adelante → restaurar scroll
const scrollMem = new Map();

function fire(info) { for (const cb of [...listeners]) { try { cb(info); } catch (e) { console.error('[router] listener', e); } } }

function stateCard(kind, info, err) {
  const back = h('a', { class: 'btn', href: '#/' }, 'Volver al inicio');
  const idx = h('a', { class: 'btn primary', href: '#/indice' }, 'Ir al índice');
  if (kind === '404') {
    return emptyState({ icon: 'route', title: 'Ruta desconocida', text: `No hay nada en “${info.path}”. Puede que el enlace esté mal escrito.`, actions: [idx, back] });
  }
  if (kind === 'missing') {
    return emptyState({ icon: 'wrench', title: 'Sección en construcción', text: 'Esta parte de la web todavía se está montando. Mientras tanto puedes seguir por el índice o trastear en el cuaderno.', actions: [idx, h('a', { class: 'btn', href: '#/cuaderno' }, 'Abrir cuaderno')] });
  }
  if (kind === 'data') {
    return emptyState({ icon: 'layers', title: 'Contenido en preparación', text: 'Este contenido aún no está publicado. Vuelve al índice y elige otra unidad.', actions: [idx, back] });
  }
  const retry = h('button', { class: 'btn primary', type: 'button', onclick: () => router.refresh() }, 'Reintentar');
  const box = emptyState({ icon: 'alert', title: 'Algo ha fallado al abrir esta página', text: 'No has perdido nada: tu progreso está guardado. Prueba a reintentar.', actions: [retry, back] });
  if (err) box.appendChild(h('pre', { class: 'empty-err' }, String(err?.message || err)));
  return box;
}

async function render() {
  if (!outlet) return;
  const info = parseHash();
  const my = ++token;
  const key = info.path + '?' + new URLSearchParams(info.query).toString();

  // misma vista ya montada → update() si existe (sin desmontar); misma ruta exacta → nada
  if (current && current.view === info.view && current.mod) {
    if (current.key === key) return;
    if (typeof current.mod.update === 'function') {
      try {
        const r = await current.mod.update(info.params);
        if (r !== false) { current.key = key; current.path = info.path; fire(info); return; }
      } catch (e) { console.error('[router] update', e); }
    }
  }

  if (current) {
    scrollMem.set(current.path, window.scrollY);
    try { await current.mod?.unmount?.(); } catch (e) { console.error('[router] unmount', e); }
  }
  current = { view: info.view, mod: null, path: info.path, key };
  fire(info);

  outlet.classList.remove('view-in');
  outlet.setAttribute('aria-busy', 'true');
  outlet.dataset.view = info.view || '404';

  if (!info.found) {
    outlet.replaceChildren(stateCard('404', info));
    finish(info, my);
    return;
  }

  // esqueleto mientras llega el módulo (solo si tarda)
  const slow = setTimeout(() => {
    if (my !== token) return;
    outlet.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'skel skel-page', 'aria-hidden': 'true' }, h('i', { style: { width: '40%', height: '28px' } }), h('i', { style: { width: '70%' } }), h('i', { style: { width: '100%', height: '140px' } }), h('i', { style: { width: '100%', height: '140px' } }))));
  }, 180);

  let mod = null;
  try {
    const ns = await LOADERS[info.view]();
    mod = ns.default || ns;
    if (!mod || typeof mod.mount !== 'function') throw new Error('La vista no exporta mount()');
  } catch (e) {
    clearTimeout(slow);
    if (my !== token) return;
    console.warn(`[router] vista "${info.view}" no disponible:`, e?.message || e);
    outlet.replaceChildren(stateCard(/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Cannot find module|mount\(\)/i.test(String(e?.message || e)) ? 'missing' : 'error', info, e));
    finish(info, my);
    return;
  }
  clearTimeout(slow);
  if (my !== token) return;

  // cada montaje recibe su propio contenedor: si la vista anterior sigue pintando tras un await, no pisa a la nueva
  const host = h('div', { class: 'view-host' });
  outlet.replaceChildren(host);
  current.mod = mod;
  try {
    await mod.mount(host, info.params);
  } catch (e) {
    if (my !== token) return;
    console.error(`[router] error al montar "${info.view}"`, e);
    try { await mod.unmount?.(); } catch { /* nada */ }
    current.mod = null;
    outlet.replaceChildren(stateCard(e?.name === 'DataError' && e.code === 'missing' ? 'data' : 'error', info, e));
  }
  finish(info, my);
}

function finish(info, my) {
  if (my !== token) return;
  outlet.removeAttribute('aria-busy');
  void outlet.offsetWidth; // reinicia la animación de entrada
  outlet.classList.add('view-in');
  const y = traverse ? scrollMem.get(info.path) || 0 : 0;
  traverse = false;
  window.scrollTo(0, y);
  if (y) requestAnimationFrame(() => window.scrollTo(0, y));
  document.title = info.path === '/' ? 'WolframLab Aero' : `${info.title} · WolframLab Aero`;
}

export const router = {
  /** start(elementoDondePintar) */
  start(el) {
    outlet = el;
    window.addEventListener('hashchange', render);
    try { window.navigation?.addEventListener('navigate', (e) => { traverse = e.navigationType === 'traverse'; }); } catch { /* API opcional */ }
    if (!location.hash) history.replaceState(null, '', '#/');
    return render();
  },
  /** navigate('#/indice') · navigate('/comandos/Plot', {replace:true}) */
  navigate(to, { replace = false } = {}) {
    const hash = to.startsWith('#') ? to : '#' + to;
    if (replace) { history.replaceState(null, '', hash); render(); } else if (location.hash === hash) render(); else location.hash = hash;
  },
  /** vuelve a montar la vista actual */
  refresh() { if (current) current.key = null, current.view = null; return render(); },
  /** registra o sustituye el cargador de una vista: register('leccion', () => import('./views/leccion.js?v=1794354103')) */
  register(name, loader) { LOADERS[name] = loader; },
  /** cb({path, view, nav, params, title}) en cada cambio de ruta */
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  get current() { return parseHash(); },
  parseHash,
};

export default router;
