// app.js (SHELL) — arranque: barra superior (navegación, nivel/XP, racha, motor, sonido), ajustes y atajos.
import { store, dayKey } from './store.js?v=1794351414';
import { sfx, toast, levelUp, h, icon } from './fx.js?v=1794351414';
import { router } from './router.js?v=1794351414';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* =====================================================================
   Indicadores: nivel, XP, racha, combo, sonido (texto pequeño y sobrio)
   ===================================================================== */
const hud = (() => {
  let prev = { level: null, xp: null, streak: null, combo: 0 };

  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  function render() {
    const li = store.levelInfo();
    const lvlBtn = $('#hud-level');
    $('#hud-level-tx').textContent = `Nivel ${li.level}`;
    $('#hud-xp-txt').textContent = `${li.into}/${li.need} XP`;
    $('#hud-xp-fill').style.width = `${Math.round(li.pct * 100)}%`;
    lvlBtn.setAttribute('aria-label', `Nivel ${li.level} (${li.title}). ${li.into} de ${li.need} XP para el siguiente nivel.`);
    lvlBtn.title = `Nivel ${li.level} · ${li.title} — faltan ${li.to - li.xp} XP para el nivel ${li.level + 1}`;
    if (prev.xp != null && li.xp > prev.xp) flash(lvlBtn);

    const st = store.state.streak || 0;
    const lit = store.studiedToday();
    const sEl = $('#hud-streak');
    $('#hud-streak-tx').replaceChildren(`Racha ${st}`, h('span', { class: 'opt' }, st === 1 ? ' día' : ' días'));
    sEl.classList.toggle('lit', lit && st > 0);
    sEl.classList.toggle('risk', !lit && st > 0);
    sEl.title = lit ? 'Hoy ya has estudiado.' : st > 0 ? 'Resuelve un ejercicio hoy para no perder la racha.' : 'Resuelve un ejercicio para empezar una racha.';
    sEl.setAttribute('aria-label', `Racha: ${st} ${st === 1 ? 'día' : 'días'}. ${sEl.title}`);
    if (prev.streak != null && st > prev.streak) flash(sEl);

    const combo = store.state.combo || 0;
    const cEl = $('#hud-combo');
    cEl.hidden = combo < 2;
    if (combo >= 2) { cEl.textContent = `Combo ×${combo}`; if (combo !== prev.combo) flash(cEl); }

    const sBtn = $('#hud-sound');
    const on = !!store.settings.sound;
    if (sBtn.dataset.on !== String(on)) {
      sBtn.dataset.on = String(on);
      sBtn.innerHTML = icon(on ? 'sound' : 'mute', 17);
      sBtn.setAttribute('aria-pressed', String(on));
      sBtn.setAttribute('aria-label', on ? 'Sonido activado (pulsa para silenciar)' : 'Sonido silenciado (pulsa para activar)');
    }
    prev = { level: li.level, xp: li.xp, streak: st, combo };
  }

  // avisos comunes a toda la app, vengan de donde vengan los cambios (sobrios: un aviso de texto)
  function onEvent(evt) {
    if (!evt) return;
    if (evt.type === 'level') setTimeout(() => levelUp(evt.level, evt.title), 650);
    else if (evt.type === 'streak') toast(evt.streak > 1 ? `Racha de ${evt.streak} días.` : 'Primer ejercicio de hoy: racha en marcha.', 'streak', 2600);
    else if (evt.type === 'cmd' && evt.level === 3 && evt.from < 3) {
      const a = h('span', null, 'Comando dominado: ', h('code', null, evt.name));
      setTimeout(() => { toast(a, 'ok', 3600); sfx.play('unlock'); }, 900);
    }
  }

  function init() {
    $('#hud-settings').innerHTML = icon('gear', 17);
    $('#menu-btn').innerHTML = icon('menu', 20);
    render();
    store.on((_, evt) => { render(); onEvent(evt); });
    $('#hud-sound').addEventListener('click', () => {
      const on = !store.settings.sound;
      sfx.mute(!on);
      if (on) setTimeout(() => sfx.play('click'), 30);
      toast(on ? 'Sonido activado' : 'Sonido silenciado', 'info', 1400);
    });
    $('#hud-settings').addEventListener('click', openSettings);
    $('#hud-level').addEventListener('click', (e) => popover(e.currentTarget, levelPanel()));
    $('#hud-streak').addEventListener('click', (e) => popover(e.currentTarget, streakPanel()));
  }
  return { init, render };
})();

function levelPanel() {
  const li = store.levelInfo();
  const c = store.counts();
  return h('div', { class: 'pop-body' },
    h('div', { class: 'pop-kicker' }, `Nivel ${li.level}`),
    h('div', { class: 'pop-title' }, li.title),
    h('div', { class: 'progress', style: { margin: '10px 0 6px' } }, h('i', { style: { width: `${Math.round(li.pct * 100)}%` } })),
    h('div', { class: 'muted pop-small' }, `${li.xp} XP en total · faltan ${li.to - li.xp} para «${li.nextTitle}»`),
    h('dl', { class: 'pop-stats' },
      h('dt', null, 'Ejercicios resueltos'), h('dd', null, String(c.exOk)),
      h('dt', null, 'Comandos dominados'), h('dd', null, String(c.learned)),
      h('dt', null, 'Comandos en práctica'), h('dd', null, String(c.practising))),
    h('div', { class: 'muted pop-small' }, 'Cada ejercicio nuevo da 10 XP × dificultad (+5 si sale a la primera).'));
}

function streakPanel() {
  const days = store.recentDays(14);
  const st = store.state.streak || 0;
  const lit = store.studiedToday();
  const t = store.today();
  const letters = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  return h('div', { class: 'pop-body' },
    h('div', { class: 'pop-kicker' }, 'Racha'),
    h('div', { class: 'pop-title' }, st ? `${st} ${st === 1 ? 'día seguido' : 'días seguidos'}` : 'Sin racha todavía'),
    h('div', { class: 'muted pop-small' }, lit ? `Hoy: ${t.ok} ${t.ok === 1 ? 'ejercicio resuelto' : 'ejercicios resueltos'} · ${t.xp} XP.` : st ? 'Resuelve un ejercicio hoy para no perderla.' : 'Resuelve un ejercicio para empezarla.'),
    h('div', { class: 'daystrip' }, days.map((d) => {
      const dt = new Date(d.day + 'T12:00:00');
      return h('div', { class: `day${d.ok > 0 ? ' on' : d.ex > 0 ? ' half' : ''}${d.day === dayKey() ? ' today' : ''}`, title: `${d.day}: ${d.ok} aciertos, ${d.xp} XP` }, h('i'), h('span', null, letters[dt.getDay()]));
    })),
    h('div', { class: 'muted pop-small' }, `Mejor racha: ${store.state.best || st} ${(store.state.best || st) === 1 ? 'día' : 'días'}`));
}

/* =====================================================================
   Popover genérico (anclado a un botón)
   ===================================================================== */
let popEl = null, popAnchor = null;
function closePopover() {
  if (!popEl) return;
  popEl.remove(); popEl = null;
  popAnchor?.setAttribute('aria-expanded', 'false');
  popAnchor = null;
  document.removeEventListener('pointerdown', popOutside, true);
}
function popOutside(e) { if (popEl && !popEl.contains(e.target) && !popAnchor?.contains(e.target)) closePopover(); }
function popover(anchor, content) {
  if (popAnchor === anchor) { closePopover(); return; }
  closePopover();
  popEl = h('div', { class: 'popover', role: 'dialog' }, content);
  document.body.appendChild(popEl);
  popAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const w = popEl.offsetWidth;
  const left = Math.max(10, Math.min(window.innerWidth - w - 10, r.right - w));
  popEl.style.left = `${left}px`;
  popEl.style.top = `${r.bottom + 8}px`;
  setTimeout(() => document.addEventListener('pointerdown', popOutside, true), 0);
}

/* =====================================================================
   Motor (kernel): punto + palabra, y calentamiento en segundo plano
   ===================================================================== */
const kernelUI = (() => {
  let kernel = null, missing = false, status = 'idle', progress = null;
  const PHASES = { pyodide: 'Python', packages: 'paquetes', wheels: 'paquetes', mathics: 'Mathics', engine: 'motor', init: 'arranque', prelude: 'preludio' };

  function paint() {
    const pill = $('#kpill'), tx = $('#kpill-tx'), fill = $('#kpill-fill'), bar = $('#kbar');
    if (!pill) return;
    const st = missing ? 'missing' : status;
    pill.dataset.status = st;
    let label = '', tip = 'Motor de cálculo: Wolfram Language (Mathics3) dentro de tu navegador.';
    const pct = Math.max(0, Math.min(1, Number(progress?.pct) || 0));
    if (st === 'missing') { label = 'Sin motor'; tip = 'El motor todavía no está instalado en esta versión de la web. Pulsa para reintentar.'; }
    else if (st === 'idle') { label = 'Motor en reposo'; tip += ' Pulsa para arrancarlo.'; }
    else if (st === 'loading') {
      const raw = String(progress?.phase || '').trim();
      const ph = (PHASES[raw] ? `Cargando ${PHASES[raw]}` : raw).replace(/[.…]+$/, '');
      label = `Cargando motor${pct ? ` ${Math.round(pct * 100)} %` : '…'}`;
      tip = `${ph || 'Preparando el motor de cálculo'}. La primera vez tarda un poco; después va de caché.`;
    } else if (st === 'ready') { label = 'Motor listo'; tip += ' Pulsa para opciones.'; }
    else if (st === 'busy') { label = 'Calculando…'; tip = 'El motor está evaluando una celda.'; }
    else if (st === 'error') { label = 'Motor caído'; tip = `${String(progress?.phase || 'El motor ha fallado al cargar.')} Pulsa para reintentar.`; }
    // en pantallas estrechas se oculta la palabra "Motor" (.opt) y queda "listo", "en reposo", "caído"…
    const m = label.match(/^(Motor |Cargando motor ?)(.*)$/);
    if (m && m[2]) tx.replaceChildren(h('span', { class: 'opt' }, m[1]), m[2]); else tx.textContent = label;
    pill.title = tip;
    pill.setAttribute('aria-label', `${label}. ${tip}`);
    bar.dataset.status = st;
    fill.style.transform = `scaleX(${st === 'loading' ? Math.max(0.03, pct) : 0})`;
  }

  function onStatus(s, p) {
    status = s || kernel?.status || 'idle';
    progress = p || kernel?.progress || null;
    paint();
  }

  async function load() {
    if (kernel) return kernel;
    try {
      const mod = await import('./kernel-client.js?v=1794351414');
      kernel = mod.kernel || mod.default;
      if (!kernel || typeof kernel.start !== 'function') throw new Error('kernel-client sin kernel.start');
      missing = false;
      status = kernel.status || 'idle'; progress = kernel.progress || null;
      try { kernel.onStatus?.(onStatus); } catch (e) { console.warn('[kernel] onStatus', e); }
      paint();
      return kernel;
    } catch (e) {
      console.warn('[kernel] no disponible:', e?.message || e);
      kernel = null; missing = true; paint();
      return null;
    }
  }

  async function start(userAction = false) {
    const k = await load();
    if (!k) { if (userAction) toast('El motor de cálculo aún no está disponible en esta versión.', 'warn'); return; }
    try { await k.start(); } catch (e) {
      console.warn('[kernel] start', e);
      if (status !== 'error') { status = 'error'; paint(); }
      if (userAction) toast('El motor no ha podido arrancar. Revisa tu conexión y reintenta.', 'bad');
    }
  }

  async function restart() {
    const k = await load();
    if (!k) return;
    try { await (k.abort ? k.abort() : k.start()); toast('Motor reiniciado: definiciones borradas.', 'ok'); } catch { toast('No se pudo reiniciar el motor.', 'bad'); }
  }
  async function clearDefs() {
    const k = await load();
    if (!k?.reset) return;
    try { await k.reset(); toast('Definiciones borradas.', 'ok'); } catch { toast('No se pudo limpiar el motor.', 'bad'); }
  }

  function panel() {
    const st = missing ? 'missing' : status;
    return h('div', { class: 'pop-body' },
      h('div', { class: 'pop-kicker' }, 'Motor de cálculo'),
      h('div', { class: 'pop-title' }, st === 'busy' ? 'Calculando…' : 'Listo'),
      h('div', { class: 'muted pop-small' }, st === 'busy' ? 'Hay un cálculo en marcha. Si se ha quedado colgado, reinicia el motor.' : 'Todas las celdas de la web comparten esta sesión, igual que un cuaderno de Mathematica.'),
      h('div', { class: 'row', style: { marginTop: '12px', gap: '8px' } },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { closePopover(); clearDefs(); } }, 'Borrar definiciones'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { closePopover(); restart(); } }, 'Reiniciar motor')));
  }

  function init() {
    paint();
    $('#kpill').addEventListener('click', (e) => {
      const st = missing ? 'missing' : status;
      if (st === 'ready' || st === 'busy') popover(e.currentTarget, panel());
      else if (st === 'loading') toast($('#kpill').title, 'info');
      else if (st === 'error') { kernel?.abort ? kernel.abort().catch(() => {}).then(() => start(true)) : start(true); }
      else start(true);
    });
    // calentar el motor en segundo plano ~1,5 s tras el primer pintado (salvo ahorro de datos)
    const saver = navigator.connection?.saveData === true;
    const warm = () => { if (!saver) start(false); else load(); };
    const kick = () => setTimeout(warm, 1500);
    if (document.readyState === 'complete') requestAnimationFrame(kick);
    else window.addEventListener('load', () => requestAnimationFrame(kick), { once: true });
  }
  return { init, start, restart };
})();

/* =====================================================================
   Ajustes (diálogo): sonido, efectos, exportar/importar/borrar progreso, atajos
   ===================================================================== */
function toggleRow(label, desc, key) {
  const id = `set-${key}`;
  const input = h('input', { type: 'checkbox', id, class: 'switch', role: 'switch' });
  input.checked = !!store.settings[key];
  input.addEventListener('change', () => {
    store.set(`settings.${key}`, input.checked);
    if (key === 'sound' && input.checked) setTimeout(() => sfx.play('ok'), 40);
  });
  return h('label', { class: 'set-row', for: id }, h('span', null, h('b', null, label), h('small', { class: 'muted' }, desc)), input);
}

let dialog = null;
function openSettings() {
  closePopover();
  if (dialog?.open) return;
  dialog?.remove();
  const c = store.counts();
  const li = store.levelInfo();

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try { await store.importFile(f); toast('Progreso importado.', 'ok'); dialog.close(); router.refresh(); } catch (e) { toast(e.message || 'No se pudo importar.', 'bad'); }
    fileInput.value = '';
  });

  let armed = false, armTimer = 0;
  const resetBtn = h('button', { class: 'btn danger', type: 'button' }, h('span', { class: 'lbl' }, 'Borrar todo el progreso'));
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true; resetBtn.classList.add('armed');
      resetBtn.querySelector('.lbl').textContent = '¿Seguro? Pulsa otra vez para borrar';
      armTimer = setTimeout(() => { armed = false; resetBtn.classList.remove('armed'); resetBtn.querySelector('.lbl').textContent = 'Borrar todo el progreso'; }, 4000);
      return;
    }
    clearTimeout(armTimer);
    store.reset();
    toast('Progreso borrado. Empiezas de cero.', 'warn');
    dialog.close();
    router.refresh();
  });

  const keys = [['g h', 'Inicio'], ['g i', 'Índice'], ['g p', 'Práctica'], ['g s', 'Simulacros'], ['g c', 'Comandos'], ['g e', 'Esquema'], ['g r', 'Registro'], ['g n', 'Cuaderno'], ['/', 'Buscar en la página'], ['m', 'Sonido sí/no'], ['?', 'Estos ajustes']];

  dialog = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
    h('form', { method: 'dialog', class: 'dlg-head' },
      h('h2', { id: 'dlg-title' }, 'Ajustes y progreso'),
      h('button', { class: 'st-icon', 'aria-label': 'Cerrar', html: icon('x', 18) })),
    h('div', { class: 'dlg-body' },
      h('section', null,
        h('h3', null, 'Experiencia'),
        toggleRow('Sonido', 'Avisos cortos y suaves: acierto, fallo, nivel.', 'sound'),
        toggleRow('Efectos visuales', 'Confeti discreto en los hitos y el «+XP» al acertar.', 'fx')),
      h('section', null,
        h('h3', null, 'Tu progreso'),
        h('p', { class: 'muted' }, `Nivel ${li.level} (${li.title}) · ${li.xp} XP · ${c.exOk} ${c.exOk === 1 ? 'ejercicio resuelto' : 'ejercicios resueltos'} · ${c.learned} ${c.learned === 1 ? 'comando dominado' : 'comandos dominados'}. Se guarda solo en este navegador: haz una copia de vez en cuando.`),
        store.memoryOnly ? h('p', { class: 'set-warn' }, 'Este navegador no deja guardar datos (modo privado): el progreso se perderá al cerrar la pestaña.') : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => { store.exportFile(); toast('Copia descargada.', 'ok'); } }, 'Exportar copia (.json)'),
          h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Importar copia'),
          resetBtn,
          fileInput)),
      h('section', null,
        h('h3', null, 'Atajos de teclado'),
        h('div', { class: 'set-keys' }, keys.map(([k, d]) => h('div', null, h('span', null, k.split(' ').map((x) => h('kbd', null, x))), h('span', { class: 'muted' }, d)))),
        h('p', { class: 'muted', style: { marginTop: '10px' } }, 'En una celda: Mayús + Intro evalúa, como en Mathematica.'))));
  document.body.appendChild(dialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { clearTimeout(armTimer); dialog?.remove(); dialog = null; });
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
}

/* =====================================================================
   Navegación: resaltado, menú móvil, sonido de clic, atajos de teclado
   ===================================================================== */
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
  $('#menu-btn').innerHTML = icon(open ? 'x' : 'menu', 20);
}

function initNav() {
  router.onChange((info) => {
    closePopover();
    setMenu(false);
    for (const a of $$('#nav [data-nav]')) {
      const on = a.dataset.nav === info.nav;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    document.body.dataset.route = info.view || '404';
    // recuerda la última lección abierta para "continuar donde lo dejaste"
    if (info.view === 'leccion' && info.params.lessonId && store.state.last?.lessonId !== info.params.lessonId) {
      store.set('last', { lessonId: info.params.lessonId, step: store.state.lesson[info.params.lessonId]?.step || 0, ts: Date.now() });
    }
  });
  $('#menu-btn').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  $('#nav-settings').addEventListener('click', () => { setMenu(false); openSettings(); });

  // clic suave en elementos de interfaz (no dentro de celdas/editores)
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('a[href^="#/"], button, .chip, [role="tab"], summary');
    if (!t || t.disabled || t.closest('[data-nosfx]')) return;
    sfx.play('click');
  }, true);

  // atajos: "g" + letra, "/" buscar, "m" sonido, "?" ajustes
  const GO = { h: '#/', i: '#/indice', p: '#/practica', s: '#/simulacros', c: '#/comandos', e: '#/esquema', r: '#/registro', n: '#/cuaderno' };
  let gAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.cm-editor, [contenteditable="true"], [data-editor]'));
    if (e.key === 'Escape') { closePopover(); setMenu(false); return; }
    if (typing || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (gAt && performance.now() - gAt < 1200 && GO[k]) { e.preventDefault(); gAt = 0; router.navigate(GO[k]); return; }
    gAt = 0;
    if (k === 'g') { gAt = performance.now(); return; }
    if (e.key === '/') {
      const s = document.querySelector('#view [data-search]');
      if (s) { e.preventDefault(); s.focus(); s.select?.(); }
    } else if (k === 'm') { $('#hud-sound').click(); }
    else if (e.key === '?') { e.preventDefault(); openSettings(); }
  });

  $('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); $('#view').focus(); });
}

/* =====================================================================
   Arranque
   ===================================================================== */
function boot() {
  hud.init();
  initNav();
  kernelUI.init();
  router.start($('#view'));
  if (store.memoryOnly) toast('Este navegador no permite guardar el progreso (¿modo privado?).', 'warn', 6000);
  window.addEventListener('unhandledrejection', (e) => { console.error('[app] promesa rechazada', e.reason); });
}

boot();

// ganchos para depurar desde la consola
window.wolframlab = { store, router, sfx, kernel: kernelUI };
