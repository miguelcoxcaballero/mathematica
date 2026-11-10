// WolframLab Aero — panel Manipulate/Animate al estilo Mathematica.
// renderManipulate(el, item, kernel, renderItems) -> {destroy()}
//   item: {id, controls:[{name,label,type:"slider",min,max,step,value,integer}|{name,label,type:"choice",choices,value}], animate, initial:{items}}
//   kernel.manipulate(id, {name: valor}) -> Promise<{items}> ; renderItems(container, items) pinta items (SPEC §2).

const PLAY = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.4 1.5h2.6v9H2.4zM7 1.5h2.6v9H7z" fill="currentColor"/></svg>';

function h(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function decimalsOf(step) {
  if (!(step > 0) || !isFinite(step)) return 2;
  const s = String(+step.toPrecision(6));
  if (s.indexOf('e-') >= 0) return Math.min(8, parseInt(s.split('e-')[1], 10) + 1);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}
function fmt(c, v) {
  if (c.integer) return String(Math.round(v));
  const span = Math.abs(c.max - c.min) || 1;
  let dec = Math.max(decimalsOf(c.step), span >= 100 ? 0 : span >= 10 ? 1 : 2);
  dec = Math.min(dec, span < 0.01 ? 6 : span < 1 ? 4 : 3);
  return v.toFixed(dec).replace('-', '−');
}

export function renderManipulate(el, item, kernel, renderItems) {
  const controls = (item && item.controls) || [];
  const root = h('div', 'wl-manip', el);
  const panel = h('div', 'wl-manip-controls', root);
  const out = h('div', 'wl-manip-out', root);
  out.setAttribute('data-wl-keepview', '1');
  const status = h('div', 'wl-manip-status', root);
  const values = {};
  const ui = [];
  let dead = false, busy = false, pending = false, timer = 0, lastSent = 0, shown = null;
  let playing = null, playTimer = 0;

  // ------------------------------------------------------------ salida
  const show = items => {
    if (dead || !items) return;
    // camino rápido: un único gráfico -> actualizar en el sitio (conserva la rotación 3D y evita parpadeos)
    const gi = items.length === 1 && items[0] && items[0].type === 'graphics' ? items[0] : null;
    if (gi && shown && shown.g && shown.dim === gi.g.dim) {
      const host = out.querySelector('.wl-gfx');
      const inst = host && host.__wlgfx;
      if (inst && typeof inst.update === 'function' && host.isConnected) {
        try { inst.update(gi.g); shown = { g: true, dim: gi.g.dim }; return; } catch (e) { /* camino general */ }
      }
    }
    const hgt = out.offsetHeight;
    if (hgt) out.style.minHeight = hgt + 'px';
    out.textContent = '';
    try { renderItems(out, items); } catch (e) { h('div', 'wl-manip-err', out, String(e && e.message || e)); }
    shown = gi ? { g: true, dim: gi.g.dim } : null;
    requestAnimationFrame(() => { out.style.minHeight = ''; });
  };

  // ------------------------------------------------------------ peticiones (la última gana; como mucho una en cola)
  const send = () => {
    if (dead) return;
    if (busy) { pending = true; return; }
    busy = true; pending = false;
    lastSent = performance.now();
    root.classList.add('busy');
    let p;
    try { p = Promise.resolve(kernel.manipulate(item.id, { ...values })); } catch (e) { p = Promise.reject(e); }
    p.then(res => {
      status.textContent = '';
      if (res && res.items) show(res.items);
    }).catch(err => {
      status.textContent = 'No se pudo actualizar: ' + (err && err.message ? err.message : err);
      if (playing) stop();
    }).then(() => {
      busy = false;
      root.classList.remove('busy');
      if (dead) return;
      if (pending) send();
      else if (playing) scheduleTick();
    });
  };
  const request = () => {
    if (dead) return;
    if (busy) { pending = true; return; }
    if (timer) return;
    const wait = Math.max(0, 40 - (performance.now() - lastSent));
    timer = setTimeout(() => { timer = 0; send(); }, wait);
  };

  // ------------------------------------------------------------ animación
  const stop = () => {
    if (playing) { playing.btn.innerHTML = PLAY; playing.btn.classList.remove('on'); playing.btn.setAttribute('aria-label', 'Reproducir'); }
    playing = null;
    clearTimeout(playTimer); playTimer = 0;
  };
  const tick = () => {
    playTimer = 0;
    if (dead || !playing) return;
    if (!root.isConnected) { stop(); return; }
    const u = playing, c = u.c;
    const span = c.max - c.min;
    let step = c.integer ? Math.max(1, Math.round(c.step || 1)) : Math.max(c.step || span / 200, span / 90);
    if (c.integer && span / step > 120) step = Math.ceil(span / 120);
    let v = values[c.name] + step;
    if (v > c.max + 1e-9) v = c.min;
    u.set(v, true);
    send();
  };
  const scheduleTick = () => {
    if (!playing || playTimer) return;
    const c = playing.c, slow = c.integer && (c.max - c.min) / Math.max(1, c.step || 1) < 25;
    const wait = Math.max(0, (slow ? 320 : 55) - (performance.now() - lastSent));
    playTimer = setTimeout(tick, wait);
  };
  const play = u => {
    if (playing === u) { stop(); return; }
    stop();
    playing = u;
    u.btn.innerHTML = PAUSE; u.btn.classList.add('on'); u.btn.setAttribute('aria-label', 'Pausa');
    if (!busy) scheduleTick();
  };

  // ------------------------------------------------------------ controles
  controls.forEach((c, k) => {
    const row = h('div', 'wl-manip-row', panel);
    const id = 'wlm' + item.id + '_' + k + '_' + Math.random().toString(36).slice(2, 6);
    const lab = h('label', 'wl-manip-label', row, c.label == null ? '' : String(c.label));
    lab.setAttribute('for', id);
    if (c.type === 'choice') {
      const choices = c.choices || [];
      values[c.name] = Math.max(0, Math.min(choices.length - 1, c.value | 0));
      const short = choices.length <= 6 && choices.join('').length <= 34;
      if (short) {
        const bar = h('div', 'wl-manip-setter', row);
        bar.setAttribute('role', 'radiogroup');
        const btns = choices.map((txt, i) => {
          const b = h('button', 'wl-manip-opt' + (i === values[c.name] ? ' on' : ''), bar, String(txt));
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', i === values[c.name] ? 'true' : 'false');
          b.addEventListener('click', () => {
            values[c.name] = i;
            btns.forEach((x, j) => { x.classList.toggle('on', j === i); x.setAttribute('aria-checked', j === i ? 'true' : 'false'); });
            request();
          });
          return b;
        });
      } else {
        const sel = h('select', 'wl-manip-select', row);
        sel.id = id;
        choices.forEach((txt, i) => { const o = h('option', null, sel, String(txt)); o.value = String(i); });
        sel.value = String(values[c.name]);
        sel.addEventListener('change', () => { values[c.name] = parseInt(sel.value, 10) || 0; request(); });
      }
      return;
    }
    // deslizador
    const min = +c.min, max = +c.max;
    const step = c.integer ? Math.max(1, Math.round(c.step || 1)) : (c.step > 0 ? c.step : (max - min) / 200);
    const clamp = v => Math.max(min, Math.min(max, v));
    const snap = v => { const q = min + Math.round((v - min) / step) * step; return clamp(c.integer ? Math.round(q) : +q.toPrecision(12)); };
    values[c.name] = clamp(typeof c.value === 'number' ? c.value : min);
    const inp = h('input', 'wl-manip-slider', row);
    inp.type = 'range'; inp.id = id;
    inp.min = String(min); inp.max = String(max); inp.step = c.integer ? String(step) : 'any';
    inp.value = String(values[c.name]);
    const val = h('output', 'wl-manip-value', row, fmt(c, values[c.name]));
    val.setAttribute('for', id);
    const btn = h('button', 'wl-manip-play', row);
    btn.type = 'button'; btn.innerHTML = PLAY;
    btn.setAttribute('aria-label', 'Reproducir'); btn.title = 'Animar este parámetro';
    const paint = () => {
      const f = max > min ? (values[c.name] - min) / (max - min) : 0;
      inp.style.setProperty('--f', (f * 100).toFixed(2) + '%');
      val.textContent = fmt(c, values[c.name]);
    };
    const u = { c, btn, set: (v, fromAnim) => { values[c.name] = snap(v); inp.value = String(values[c.name]); paint(); if (!fromAnim) request(); } };
    paint();
    inp.addEventListener('input', () => {
      if (playing === u) stop();
      values[c.name] = snap(parseFloat(inp.value));
      paint();
      request();
    });
    btn.addEventListener('click', () => play(u));
    ui.push(u);
  });

  // estado inicial
  if (item && item.initial && item.initial.items) show(item.initial.items);
  if (item && item.animate && ui.length) play(ui[0]);

  return {
    destroy() {
      dead = true;
      stop();
      clearTimeout(timer);
      out.querySelectorAll('.wl-gfx').forEach(n => { try { n.__wlgfx && n.__wlgfx.destroy && n.__wlgfx.destroy(); } catch (e) { /* */ } });
      root.remove();
    },
    el: root,
    getValues: () => ({ ...values }),
  };
}
export default renderManipulate;
