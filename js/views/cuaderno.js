// Vista: cuaderno libre (#/cuaderno) — una hoja en blanco que se guarda sola en este navegador.
// Con ?code=… el código NO se inyecta (SPEC §11: todo se teclea): se muestra como referencia para escribirlo.
import { h, wlPre, toast } from '../fx.js?v=1794351974';

const KEY = 'wolframlab-aero-cuaderno';
let nb = null;
let timer = 0;
let alive = false;
let lastSaved = '';
let fallbackEl = null;

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    const cells = Array.isArray(j?.cells) ? j.cells.filter((c) => typeof c === 'string') : [];
    return cells.length ? cells : [''];
  } catch { return ['']; }
}
function currentCells() {
  if (nb?.getCells) { try { return nb.getCells().map(String); } catch { return null; } }
  if (fallbackEl) return [...fallbackEl.querySelectorAll('textarea')].map((t) => t.value);
  return null;
}
function save() {
  const cells = currentCells();
  if (!cells) return;
  const text = JSON.stringify({ cells, ts: Date.now() });
  const sig = JSON.stringify(cells);
  if (sig === lastSaved) return;
  lastSaved = sig;
  try { localStorage.setItem(KEY, text); } catch { /* sin almacenamiento: se pierde al cerrar */ }
}
const onHide = () => save();

export default {
  async mount(el, params) {
    alive = true;
    const cells = load();
    lastSaved = JSON.stringify(cells);
    const ref = typeof params?.query?.code === 'string' && params.query.code.trim() ? params.query.code : null;

    const host = h('div', { class: 'cua-nb' });
    const bar = h('div', { class: 'cua-bar' });
    const page = h('div', { class: 'page wide cua' },
      h('header', { class: 'page-head' },
        h('h1', null, 'Cuaderno libre'),
        h('p', null, 'Escribe lo que quieras y pulsa Mayús + Intro para evaluarlo, como en Mathematica. Todas las celdas comparten sesión y el cuaderno se guarda solo en este navegador.')),
      ref ? h('div', { class: 'cua-ref' }, h('small', null, 'Para probar, tecléalo tú en una celda:'), wlPre(ref)) : null,
      bar, host);
    el.appendChild(page);

    let mod = null;
    try { mod = await import('../notebook.js?v=1794351974'); } catch (e) { console.warn('[cuaderno] notebook.js no disponible:', e?.message || e); }
    if (!alive) return;

    const make = (list) => mod.createNotebook(host, { cells: list.map((code) => ({ code })), onResult: () => save(), onChange: () => save() });
    if (mod && typeof mod.createNotebook === 'function') {
      try { nb = make(cells); } catch (e) { console.error('[cuaderno] createNotebook', e); nb = null; }
    }

    if (nb) {
      // el cuaderno ya trae «Evaluar todo», «Reiniciar kernel» y «+ celda»: aquí solo falta vaciarlo
      let armed = 0;
      const clearBtn = h('button', { class: 'btn link', type: 'button', title: 'Borra todas las celdas de este cuaderno' }, 'Vaciar el cuaderno');
      clearBtn.addEventListener('click', () => {
        if (Date.now() - armed > 3500) { armed = Date.now(); clearBtn.textContent = '¿Seguro? Pulsa otra vez para vaciarlo'; setTimeout(() => { if (clearBtn.isConnected) clearBtn.textContent = 'Vaciar el cuaderno'; }, 3600); return; }
        try { nb.destroy?.(); } catch { /* nada */ }
        host.replaceChildren();
        nb = make(['']);
        clearBtn.textContent = 'Vaciar el cuaderno';
        armed = 0;
        save();
        toast('Cuaderno vaciado.', 'info', 1800);
        nb.focus?.();
      });
      bar.append(h('span', { class: 'cua-note' }, 'Se guarda automáticamente.'), h('span', { class: 'sp' }), clearBtn);
      page.appendChild(bar); // debajo del cuaderno
      setTimeout(() => { if (alive && !ref) nb.focus?.(); }, 60);
    } else {
      // sin motor de cuaderno todavía: al menos se puede escribir y se guarda
      fallbackEl = h('div', { class: 'cua-fallback' },
        cells.map((code) => { const t = h('textarea', { spellcheck: 'false', 'aria-label': 'Celda', 'data-editor': '' }); t.value = code; return t; }),
        h('p', { class: 'cua-note' }, 'El motor de cálculo aún no está disponible en esta versión: puedes escribir (se guarda), pero todavía no evaluar.'));
      fallbackEl.addEventListener('input', () => save());
      host.appendChild(fallbackEl);
      bar.remove();
    }

    timer = setInterval(save, 4000);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
  },
  unmount() {
    save();
    alive = false;
    clearInterval(timer); timer = 0;
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onHide);
    try { nb?.destroy?.(); } catch { /* nada */ }
    nb = null; fallbackEl = null;
  },
};
