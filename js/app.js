// app.js (SHELL) — arranque: fondo animado, HUD (nivel, XP, racha, combo, sonido, motor), navegación y ajustes.
import { store, dayKey } from './store.js';
import { sfx, toast, levelUp, fxEnabled, h, icon, sparkle } from './fx.js';
import { router } from './router.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* =====================================================================
   Iconos declarados en el HTML con data-icon
   ===================================================================== */
function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, el.closest('.tabbar') ? 22 : 19);
  }
}

/* =====================================================================
   Fondo: campo de estrellas en canvas (ligero, 30 fps, se pausa si la pestaña no se ve)
   ===================================================================== */
const sky = (() => {
  const cv = $('#sky-canvas');
  const g = cv?.getContext('2d');
  let W = 0, H = 0, dpr = 1, stars = [], raf = 0, last = 0, shoot = null, nextShoot = 0, running = false;
  const TINTS = ['255,255,255', '255,255,255', '255,255,255', '190,225,255', '200,190,255', '255,220,180', '160,255,240'];

  function resize() {
    if (!cv) return;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const n = Math.max(70, Math.min(230, Math.round((W * H) / 8500)));
    stars = Array.from({ length: n }, () => {
      const z = Math.random() ** 1.8; // la mayoría, lejanas
      return { x: Math.random() * W, y: Math.random() * H, z, r: 0.35 + z * 1.25, ph: Math.random() * 6.28, tw: 0.4 + Math.random() * 1.6, c: TINTS[(Math.random() * TINTS.length) | 0] };
    });
    draw(performance.now(), 0);
  }
  function draw(t, dt) {
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const ts = t / 1000;
    for (const s of stars) {
      s.x -= (2 + s.z * 9) * dt; s.y += (0.6 + s.z * 2.4) * dt;
      if (s.x < -2) s.x = W + 2;
      if (s.y > H + 2) s.y = -2;
      const a = (0.2 + s.z * 0.6) * (0.72 + 0.28 * Math.sin(ts * s.tw + s.ph));
      g.fillStyle = `rgba(${s.c},${a.toFixed(3)})`;
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.283); g.fill();
      if (s.z > 0.88) { g.fillStyle = `rgba(${s.c},${(a * 0.1).toFixed(3)})`; g.beginPath(); g.arc(s.x, s.y, s.r * 2.6, 0, 6.283); g.fill(); }
    }
    if (shoot) {
      shoot.life -= dt;
      shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt;
      const a = Math.max(0, Math.min(1, shoot.life / 0.35));
      const tail = 90;
      const gr = g.createLinearGradient(shoot.x, shoot.y, shoot.x - (shoot.vx / shoot.sp) * tail, shoot.y - (shoot.vy / shoot.sp) * tail);
      gr.addColorStop(0, `rgba(255,255,255,${0.9 * a})`); gr.addColorStop(1, 'rgba(124,92,255,0)');
      g.strokeStyle = gr; g.lineWidth = 1.4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(shoot.x, shoot.y); g.lineTo(shoot.x - (shoot.vx / shoot.sp) * tail, shoot.y - (shoot.vy / shoot.sp) * tail); g.stroke();
      if (shoot.life <= 0) shoot = null;
    } else if (ts > nextShoot && dt > 0) {
      nextShoot = ts + 7 + Math.random() * 11;
      const ang = Math.PI * (0.78 + Math.random() * 0.14), sp = 520 + Math.random() * 260;
      shoot = { x: W * (0.35 + Math.random() * 0.65), y: H * Math.random() * 0.4, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, sp, life: 0.7 };
    }
  }
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 33) return; // ~30 fps
    const dt = Math.min(0.08, (t - last) / 1000);
    last = t;
    draw(t, dt);
  }
  function sync() {
    const want = fxEnabled() && !document.hidden;
    document.documentElement.classList.toggle('fx-off', !fxEnabled());
    if (want && !running) { running = true; last = performance.now(); nextShoot = last / 1000 + 4; raf = requestAnimationFrame(loop); }
    else if (!want && running) { running = false; cancelAnimationFrame(raf); shoot = null; draw(performance.now(), 0); }
  }
  function init() {
    if (!cv) return;
    resize();
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
    document.addEventListener('visibilitychange', sync);
    try { window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', sync); } catch { /* opcional */ }
    sync();
  }
  return { init, sync };
})();

/* =====================================================================
   HUD: nivel, XP, racha, combo, sonido
   ===================================================================== */
const hud = (() => {
  let prev = { level: null, xp: null, streak: null, combo: 0 };
  let comboTimer = 0;

  function render(evt) {
    const li = store.levelInfo();
    const lvlBtn = $('#hud-level');
    $('#hud-level-n').textContent = li.level;
    lvlBtn.setAttribute('aria-label', `Nivel ${li.level}: ${li.title}`);
    lvlBtn.title = `Nivel ${li.level} · ${li.title}\n${li.xp} XP en total`;
    $('#hud-rank').textContent = li.title;
    $('#hud-xp-txt').textContent = `${li.into} / ${li.need} XP`;
    $('#hud-xp-fill').style.width = `${Math.max(2, Math.round(li.pct * 100))}%`;
    const xpEl = $('#hud-xp');
    xpEl.setAttribute('aria-valuenow', String(Math.round(li.pct * 100)));
    xpEl.title = `${li.to - li.xp} XP para el nivel ${li.level + 1} (${li.nextTitle})`;
    $('#side-rank').textContent = `Nv ${li.level} · ${li.title}`;
    $('#side-next').textContent = `Siguiente: ${li.nextTitle} · faltan ${li.to - li.xp} XP`;
    if (prev.xp != null && li.xp > prev.xp) { xpEl.classList.remove('gain'); void xpEl.offsetWidth; xpEl.classList.add('gain'); }
    if (prev.level != null && li.level > prev.level) { lvlBtn.classList.remove('pop'); void lvlBtn.offsetWidth; lvlBtn.classList.add('pop'); }

    const st = store.state.streak || 0;
    const lit = store.studiedToday();
    const sEl = $('#hud-streak');
    $('#hud-streak-n').textContent = st;
    $('.hud-streak-u', sEl).textContent = st === 1 ? 'día' : 'días';
    sEl.classList.toggle('lit', lit && st > 0);
    sEl.classList.toggle('risk', !lit && st > 0);
    sEl.setAttribute('aria-label', `Racha: ${st} ${st === 1 ? 'día' : 'días'}${lit ? '' : st > 0 ? ' — estudia hoy para no perderla' : ''}`);
    if (prev.streak != null && st > prev.streak) { sEl.classList.remove('pop'); void sEl.offsetWidth; sEl.classList.add('pop'); }

    const combo = store.state.combo || 0;
    const cEl = $('#hud-combo');
    if (combo >= 2) {
      cEl.hidden = false;
      $('#hud-combo-n').textContent = `×${combo}`;
      cEl.dataset.heat = combo >= 10 ? '3' : combo >= 5 ? '2' : '1';
      if (combo !== prev.combo) { cEl.classList.remove('pop'); void cEl.offsetWidth; cEl.classList.add('pop'); }
      clearTimeout(comboTimer);
    } else if (!cEl.hidden) {
      if (prev.combo >= 2 && evt?.type === 'exercise') { cEl.classList.add('lost'); comboTimer = setTimeout(() => { cEl.hidden = true; cEl.classList.remove('lost'); }, 600); }
      else cEl.hidden = true;
    }

    const sBtn = $('#hud-sound');
    const on = !!store.settings.sound;
    if (sBtn.dataset.on !== String(on)) {
      sBtn.dataset.on = String(on);
      sBtn.innerHTML = icon(on ? 'sound' : 'mute', 19);
      sBtn.setAttribute('aria-pressed', String(on));
      sBtn.setAttribute('aria-label', on ? 'Sonido activado (pulsa para silenciar)' : 'Sonido silenciado (pulsa para activar)');
    }
    prev = { level: li.level, xp: li.xp, streak: st, combo };
  }

  // reacciones "de juego" comunes a toda la app, vengan de donde vengan los cambios
  function onEvent(evt) {
    if (!evt) return;
    if (evt.type === 'level') setTimeout(() => levelUp(evt.level, evt.title), 650);
    else if (evt.type === 'streak') {
      if (evt.streak > 1) toast(`Racha de ${evt.streak} días. No la sueltes.`, 'streak');
      else toast('Primer ejercicio de hoy: racha en marcha.', 'streak');
      sparkle($('#hud-streak'), '#ff9f43', 12);
    } else if (evt.type === 'cmd' && evt.level === 3 && evt.from < 3) {
      const a = h('span', null, 'Comando dominado: ', h('code', null, evt.name));
      setTimeout(() => { toast(a, 'unlock', 4200); sfx.play('unlock'); }, 900);
    } else if (evt.type === 'exercise' && evt.ok && [3, 5, 10, 15, 20, 30].includes(evt.combo)) {
      // el sonido de combo lo lanza quien corrige el ejercicio (exercise.js); aquí solo el destello del HUD
      setTimeout(() => sparkle($('#hud-combo'), '#19e3c5', 10), 350);
    } else if (evt.type === 'settings') sky.sync();
    else if (evt.type === 'import' || evt.type === 'reset') sky.sync();
  }

  function init() {
    $('#hud-settings').innerHTML = icon('gear', 19);
    render();
    store.on((_, evt) => { render(evt); onEvent(evt); });
    $('#hud-sound').addEventListener('click', () => {
      const on = !store.settings.sound;
      sfx.mute(!on);
      if (on) setTimeout(() => sfx.play('ok'), 30);
      toast(on ? 'Sonido activado' : 'Sonido silenciado', 'info', 1600);
    });
    $('#hud-settings').addEventListener('click', openSettings);
    $('#hud-level').addEventListener('click', (e) => popover(e.currentTarget, levelPanel()));
    $('#hud-xp').addEventListener('click', () => popover($('#hud-level'), levelPanel()));
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
    h('div', { class: 'pop-stats' },
      h('div', null, h('b', null, c.exOk), h('span', null, 'ejercicios resueltos')),
      h('div', null, h('b', null, c.learned), h('span', null, 'comandos dominados')),
      h('div', null, h('b', null, c.practising), h('span', null, 'en práctica'))),
    h('div', { class: 'muted pop-small' }, 'Ganas 10 XP × dificultad por cada ejercicio nuevo (+5 si sale a la primera).'));
}

function streakPanel() {
  const days = store.recentDays(14);
  const st = store.state.streak || 0;
  const lit = store.studiedToday();
  const letters = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  return h('div', { class: 'pop-body' },
    h('div', { class: 'pop-kicker' }, 'Racha'),
    h('div', { class: 'pop-title' }, st ? `${st} ${st === 1 ? 'día seguido' : 'días seguidos'}` : 'Sin racha todavía'),
    h('div', { class: 'muted pop-small' }, lit ? 'Hoy ya has estudiado. Mañana, otro poco.' : st ? 'Resuelve un ejercicio hoy para no perderla.' : 'Resuelve un ejercicio para encenderla.'),
    h('div', { class: 'daystrip' }, days.map((d) => {
      const dt = new Date(d.day + 'T12:00:00');
      const lvl = d.ex === 0 ? 0 : d.ok >= 6 ? 3 : d.ok >= 3 ? 2 : 1;
      return h('div', { class: `day l${lvl}${d.day === dayKey() ? ' today' : ''}`, title: `${d.day}: ${d.ok} aciertos, ${d.xp} XP` }, h('i'), h('span', null, letters[dt.getDay()]));
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
  const left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2));
  popEl.style.left = `${left}px`;
  popEl.style.top = `${r.bottom + 10}px`;
  popEl.style.setProperty('--arrow', `${r.left + r.width / 2 - left}px`);
  setTimeout(() => document.addEventListener('pointerdown', popOutside, true), 0);
}

/* =====================================================================
   Motor (kernel): píldora de estado + calentamiento en segundo plano
   ===================================================================== */
const kernelUI = (() => {
  let kernel = null, missing = false, status = 'idle', progress = null, wasLoading = false;
  const PHASES = { pyodide: 'Python', packages: 'paquetes', wheels: 'paquetes', mathics: 'Mathics', engine: 'motor', init: 'arranque', prelude: 'preludio' };

  function paint() {
    const pill = $('#kpill'), tx = $('#kpill-tx'), fill = $('#kpill-fill');
    if (!pill) return;
    const st = missing ? 'missing' : status;
    pill.dataset.status = st;
    let label = '', short = '', tip = 'Motor de cálculo: Wolfram Language (Mathics3) dentro de tu navegador.';
    const pct = Math.max(0, Math.min(1, Number(progress?.pct) || 0));
    if (st === 'missing') { label = 'Motor no disponible'; short = 'N/D'; tip = 'El motor todavía no está instalado en esta versión de la web. Pulsa para reintentar.'; }
    else if (st === 'idle') { label = 'Motor en reposo'; short = 'Motor'; tip += ' Pulsa para arrancarlo.'; }
    else if (st === 'loading') {
      const ph = String(progress?.phase || '').trim();
      label = `Cargando motor${pct ? ` ${Math.round(pct * 100)}%` : '…'}`; short = pct ? `${Math.round(pct * 100)}%` : '…';
      tip = `Preparando el motor${ph ? ': ' + (PHASES[ph] || ph) : ''}. La primera vez tarda un poco; después va de caché.`;
    } else if (st === 'ready') { label = 'Motor listo'; short = 'Listo'; tip += ' Pulsa para opciones.'; }
    else if (st === 'busy') { label = 'Calculando…'; short = '···'; tip = 'El motor está evaluando una celda.'; }
    else if (st === 'error') { label = 'Motor caído · reintentar'; short = 'Error'; tip = 'El motor ha fallado al cargar. Pulsa para reintentar.'; }
    tx.textContent = label;
    tx.dataset.short = short;
    pill.title = tip;
    pill.setAttribute('aria-label', label);
    fill.style.transform = `scaleX(${st === 'loading' ? Math.max(0.04, pct) : st === 'ready' || st === 'busy' ? 1 : 0})`;
    if (st === 'loading') {
      const ph = String(progress?.phase || '').trim();
      if (ph) tx.textContent = `${label} · ${PHASES[ph] || ph}`;
    }
  }

  function onStatus(s, p) {
    status = s || kernel?.status || 'idle';
    progress = p || kernel?.progress || null;
    if (status === 'loading') wasLoading = true;
    if (status === 'ready' && wasLoading) {
      wasLoading = false;
      const pill = $('#kpill');
      pill.classList.remove('flash'); void pill.offsetWidth; pill.classList.add('flash');
      sfx.play('unlock');
    }
    paint();
  }

  async function load() {
    if (kernel) return kernel;
    try {
      const mod = await import('./kernel-client.js');
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
    try { await (k.abort ? k.abort() : k.start()); toast('Motor reiniciado: definiciones borradas.', 'ok'); } catch (e) { toast('No se pudo reiniciar el motor.', 'bad'); }
  }
  async function clearDefs() {
    const k = await load();
    if (!k?.reset) return;
    try { await k.reset(); toast('Definiciones borradas (como Quit en Mathematica).', 'ok'); } catch { toast('No se pudo limpiar el motor.', 'bad'); }
  }

  function panel() {
    const st = missing ? 'missing' : status;
    const txt = {
      ready: 'El motor está cargado. Todas las celdas de la web comparten esta sesión, igual que un cuaderno de Mathematica.',
      busy: 'Hay un cálculo en marcha. Si se ha quedado colgado, reinicia el motor.',
    }[st];
    return h('div', { class: 'pop-body' },
      h('div', { class: 'pop-kicker' }, 'Motor de cálculo'),
      h('div', { class: 'pop-title' }, st === 'busy' ? 'Calculando…' : 'Listo'),
      h('div', { class: 'muted pop-small' }, txt),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); clearDefs(); } }, 'Borrar definiciones'),
        h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); restart(); } }, 'Reiniciar motor')));
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
  const resetBtn = h('button', { class: 'btn danger', type: 'button' }, h('span', { html: icon('trash', 16) }), h('span', { class: 'lbl' }, 'Borrar todo el progreso'));
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

  const soundTest = h('div', { class: 'set-sounds' }, ['ok', 'fail', 'combo', 'unlock', 'level', 'exam', 'tick'].map((n) => h('button', { class: 'chip', type: 'button', 'data-nosfx': '', onclick: () => sfx.play(n, { n: 6 }) }, n)));

  const keys = [['g h', 'Inicio'], ['g i', 'Índice'], ['g p', 'Práctica'], ['g s', 'Simulacros'], ['g c', 'Comandos'], ['g e', 'Esquema'], ['g r', 'Registro'], ['g n', 'Cuaderno'], ['/', 'Buscar en la página'], ['m', 'Sonido sí/no'], ['?', 'Estos ajustes']];

  dialog = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
    h('form', { method: 'dialog', class: 'dlg-head' },
      h('h2', { id: 'dlg-title' }, 'Ajustes y progreso'),
      h('button', { class: 'hud-btn', 'aria-label': 'Cerrar', html: icon('x', 18) })),
    h('div', { class: 'dlg-body' },
      h('section', null,
        h('h3', null, 'Experiencia'),
        toggleRow('Sonido', 'Efectos sintetizados: acierto, fallo, nivel, combo…', 'sound'),
        soundTest,
        toggleRow('Efectos visuales', 'Fondo animado, confeti y partículas. Desactívalo si tu equipo va justo.', 'fx')),
      h('section', null,
        h('h3', null, 'Tu progreso'),
        h('p', { class: 'muted' }, `Nivel ${li.level} · ${li.xp} XP · ${c.exOk} ejercicios resueltos · ${c.learned} comandos dominados. Se guarda solo en este navegador: haz una copia de vez en cuando.`),
        store.memoryOnly ? h('p', { class: 'set-warn' }, 'Este navegador no deja guardar datos (modo privado): el progreso se perderá al cerrar la pestaña.') : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => { store.exportFile(); toast('Copia descargada.', 'ok'); } }, h('span', { html: icon('download', 16) }), 'Exportar copia (.json)'),
          h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, h('span', { html: icon('upload', 16) }), 'Importar copia'),
          fileInput),
        h('div', { class: 'row', style: { marginTop: '12px' } }, resetBtn)),
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
   Menú "Más" (móvil)
   ===================================================================== */
function openMore(anchor) {
  const items = [['simulacros', '#/simulacros', 'timer', 'Simulacros', 'Exámenes cronometrados'], ['esquema', '#/esquema', 'graph', 'Esquema', 'El mapa de comandos'], ['registro', '#/registro', 'table', 'Registro', 'Prácticas y ejercicios'], ['cuaderno', '#/cuaderno', 'book', 'Cuaderno', 'Hoja en blanco']];
  const sheet = h('div', { class: 'sheet-body' },
    items.map(([nav, href, ic, t, d]) => h('a', { class: 'sheet-item', href, 'data-nav': nav, onclick: () => closeSheet() }, h('span', { class: 'sheet-ic', html: icon(ic, 22) }), h('span', null, h('b', null, t), h('small', { class: 'muted' }, d)))),
    h('button', { class: 'sheet-item', type: 'button', onclick: () => { closeSheet(); openSettings(); } }, h('span', { class: 'sheet-ic', html: icon('gear', 22) }), h('span', null, h('b', null, 'Ajustes y progreso'), h('small', { class: 'muted' }, 'Sonido, efectos, copia de seguridad'))));
  const wrap = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Más secciones' }, h('div', { class: 'sheet-back', onclick: () => closeSheet() }), h('div', { class: 'sheet-panel' }, h('div', { class: 'sheet-grip' }), sheet));
  function closeSheet() { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 220); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  anchor.setAttribute('aria-expanded', 'true');
  const cur = router.current.nav;
  $$('[data-nav]', wrap).forEach((a) => a.classList.toggle('active', a.dataset.nav === cur));
  wrap.querySelector('a,button')?.focus({ preventScroll: true });
}

/* =====================================================================
   Navegación: resaltado, sonido de clic, atajos de teclado
   ===================================================================== */
function initNav() {
  const MORE = new Set(['simulacros', 'esquema', 'registro', 'cuaderno']);
  router.onChange((info) => {
    closePopover();
    for (const a of $$('#nav [data-nav], #tabbar [data-nav]')) {
      const on = a.dataset.nav === info.nav || (a.dataset.nav === 'more' && MORE.has(info.nav));
      a.classList.toggle('active', on);
      if (a.tagName === 'A') { if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    }
    document.body.dataset.route = info.view || '404';
    // recuerda la última lección abierta para "continuar donde lo dejaste"
    if (info.view === 'leccion' && info.params.lessonId && store.state.last?.lessonId !== info.params.lessonId) {
      store.set('last', { lessonId: info.params.lessonId, step: store.state.lesson[info.params.lessonId]?.step || 0, ts: Date.now() });
    }
  });
  $('#tab-more').addEventListener('click', (e) => openMore(e.currentTarget));

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
    if (e.key === 'Escape') { closePopover(); return; }
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

  // enlace "saltar al contenido"
  $('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); $('#view').focus(); });
}

/* =====================================================================
   Arranque
   ===================================================================== */
function boot() {
  hydrateIcons();
  sky.init();
  hud.init();
  initNav();
  kernelUI.init();
  router.start($('#view'));
  if (store.memoryOnly) toast('Este navegador no permite guardar el progreso (¿modo privado?).', 'warn', 6000);
  // errores no capturados: avisar sin romper
  window.addEventListener('unhandledrejection', (e) => { console.error('[app] promesa rechazada', e.reason); });
}

boot();

// pequeños ganchos para depurar desde la consola
window.wolframlab = { store, router, sfx, kernel: kernelUI };
