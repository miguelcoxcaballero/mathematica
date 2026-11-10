// fx.js (SHELL) — sonido WebAudio sintetizado (sin ficheros) + efectos visuales + utilidades de interfaz.
// Todo respeta store.settings.sound / store.settings.fx y prefers-reduced-motion.
import { store } from './store.js?v=1794352096';

/* =====================================================================
   SONIDO
   ===================================================================== */
let ctx = null, master = null, unlocked = false;
const lastPlay = {};

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.3; // avisos suaves
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
  } catch { ctx = null; }
  return ctx;
}
function unlock() {
  if (unlocked) return;
  unlocked = true;
  if (!store.settings.sound) return; // se creará al activar el sonido
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, unlock, { once: true, capture: true, passive: true });
  }
}

function tone({ f = 440, f2 = null, t = 0, d = 0.15, type = 'sine', g = 0.2, a = 0.006, r = null }) {
  const t0 = ctx.currentTime + t;
  const o = ctx.createOscillator(), v = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
  v.gain.setValueAtTime(0.0001, t0);
  v.gain.exponentialRampToValueAtTime(g, t0 + a);
  v.gain.exponentialRampToValueAtTime(0.0001, t0 + (r ?? d));
  o.connect(v); v.connect(master);
  o.start(t0); o.stop(t0 + (r ?? d) + 0.05);
}
let noiseBuf = null;
function noise({ t = 0, d = 0.04, g = 0.08, hp = 1500, lp = 9000 }) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + t;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp;
  const l = ctx.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = lp;
  const v = ctx.createGain();
  v.gain.setValueAtTime(g, t0);
  v.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  s.connect(h); h.connect(l); l.connect(v); v.connect(master);
  s.start(t0, Math.random() * 0.3); s.stop(t0 + d + 0.02);
}
// campanita: fundamental + parcial agudo, con cola
function bell(f, t = 0, g = 0.16, d = 0.5) {
  tone({ f, t, d, g, type: 'sine' });
  tone({ f: f * 2.01, t, d: d * 0.6, g: g * 0.35, type: 'sine' });
  tone({ f: f * 3.02, t, d: d * 0.3, g: g * 0.12, type: 'triangle' });
}

const CUES = {
  // acierto: dos campanas ascendentes (quinta) + brillo
  ok() { bell(659.25, 0, 0.16, 0.28); bell(987.77, 0.09, 0.18, 0.5); noise({ t: 0.09, d: 0.06, g: 0.02, hp: 6000 }); },
  // fallo: "bwomp" suave descendente, nada estridente
  fail() { tone({ f: 233, f2: 155, d: 0.26, type: 'triangle', g: 0.2 }); tone({ f: 116, f2: 82, t: 0.02, d: 0.3, type: 'sine', g: 0.16 }); },
  // subida de nivel: arpegio mayor + acorde final
  level() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, i * 0.09, 0.15, 0.35));
    [523.25, 783.99, 1318.5].forEach((f) => bell(f, 0.42, 0.11, 1.1));
    noise({ t: 0.42, d: 0.5, g: 0.025, hp: 5000 });
  },
  // clic de interfaz: tic mínimo
  click() { tone({ f: 880, f2: 620, d: 0.035, type: 'sine', g: 0.07, a: 0.002 }); },
  // tecla en una celda: clic de ruido, tono ligeramente aleatorio
  type() { noise({ d: 0.018, g: 0.035, hp: 2200 + Math.random() * 1800, lp: 7000 }); },
  // combo: tres blips que suben (más agudo cuanto mayor el combo)
  combo(o) {
    const k = Math.min(12, Math.max(0, (o?.n || 3) - 2));
    const base = 520 * Math.pow(2, k / 12);
    [1, 1.26, 1.5].forEach((m, i) => tone({ f: base * m, t: i * 0.055, d: 0.09, type: 'square', g: 0.05 }));
    tone({ f: base * 2, t: 0.165, d: 0.22, type: 'triangle', g: 0.09 });
  },
  // desbloqueo: barrido ascendente + campana
  unlock() { tone({ f: 330, f2: 1320, d: 0.22, type: 'triangle', g: 0.09 }); bell(1318.5, 0.2, 0.14, 0.6); bell(1760, 0.3, 0.09, 0.7); },
  // tic de cuenta atrás (bloque de madera)
  tick() { tone({ f: 1250, f2: 900, d: 0.03, type: 'sine', g: 0.12, a: 0.001 }); noise({ d: 0.012, g: 0.03, hp: 3000 }); },
  // inicio/fin de examen: "ding-dong" de cabina de avión
  exam() { bell(587.33, 0, 0.2, 0.9); bell(440, 0.42, 0.2, 1.3); },
};

export const sfx = {
  /** 'ok','fail','level','click','type','combo','unlock','tick','exam' */
  play(name, opts) {
    if (!store.settings.sound || !unlocked) return;
    const cue = CUES[name];
    if (!cue) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const now = performance.now();
    const gap = name === 'type' ? 25 : 70; // evita dobles disparos del mismo sonido
    if (lastPlay[name] && now - lastPlay[name] < gap) return;
    lastPlay[name] = now;
    try { cue(opts); } catch { /* el audio nunca debe romper la app */ }
  },
  /** mute(true) silencia y lo recuerda; mute(false) reactiva. */
  mute(flag) {
    const sound = !flag;
    if (store.settings.sound !== sound) store.set('settings.sound', sound);
    if (sound && unlocked) { const c = ensureCtx(); if (c?.state === 'suspended') c.resume().catch(() => {}); }
  },
  get muted() { return !store.settings.sound; },
  names: Object.keys(CUES),
};

/* =====================================================================
   EFECTOS VISUALES
   ===================================================================== */
export function fxEnabled() {
  if (!store.settings.fx) return false;
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}
function layer() {
  let l = document.getElementById('fx-layer');
  if (!l) { l = document.createElement('div'); l.id = 'fx-layer'; document.body.appendChild(l); }
  return l;
}

/* ---- confeti (canvas de partículas compartido) ---- */
// Confeti DISCRETO (SPEC §10): pocas piezas pequeñas, colores sobrios, vida corta. Pensado solo para hitos.
const PALETTE = ['#dd1100', '#f47a00', '#2f73b3', '#2c8f55', '#9b9b9b', '#d98c00'];
const MAX_CONFETTI = 60;
let cv = null, c2d = null, parts = [], raf = 0, lastT = 0;

function confettiLoop(t) {
  const dt = Math.min(0.04, (t - lastT) / 1000 || 0.016);
  lastT = t;
  const W = cv.width, H = cv.height, dpr = cv._dpr;
  c2d.clearRect(0, 0, W, H);
  parts = parts.filter((p) => p.life > 0 && p.y < H / dpr + 40);
  for (const p of parts) {
    p.vy += p.grav * dt; p.vx *= 1 - 0.9 * dt; p.vy *= 1 - 0.35 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt;
    const a = Math.min(1, p.life / 0.5);
    c2d.save();
    c2d.globalAlpha = a;
    c2d.translate(p.x * dpr, p.y * dpr);
    c2d.rotate(p.rot);
    c2d.scale(1, Math.cos(p.rot * 1.7)); // "voltereta" del papel
    c2d.fillStyle = p.color;
    if (p.shape === 0) c2d.fillRect((-p.w / 2) * dpr, (-p.h / 2) * dpr, p.w * dpr, p.h * dpr);
    else { c2d.beginPath(); c2d.arc(0, 0, (p.w / 2) * dpr, 0, 6.283); c2d.fill(); }
    c2d.restore();
  }
  if (parts.length) raf = requestAnimationFrame(confettiLoop);
  else { raf = 0; cv.remove(); cv = null; }
}

/** confetti({x, y, count, spread, power, colors}) — x,y en 0..1 de la ventana (por defecto, centro-arriba) o un elemento en `el`. */
export function confetti(opts = {}) {
  if (!fxEnabled()) return;
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = 'fx-confetti';
    cv.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv._dpr = dpr;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    layer().appendChild(cv);
    c2d = cv.getContext('2d');
  }
  let x = (opts.x ?? 0.5) * innerWidth, y = (opts.y ?? 0.32) * innerHeight;
  if (opts.el?.getBoundingClientRect) {
    const r = opts.el.getBoundingClientRect();
    x = r.left + r.width / 2; y = r.top + r.height / 2;
  }
  // se acepta cualquier `count`, pero se reduce (÷3) y se limita: el efecto nunca llena la pantalla
  const count = Math.min(MAX_CONFETTI, Math.max(8, Math.round((opts.count ?? 90) / 3)), Math.max(0, 90 - parts.length));
  const spread = opts.spread ?? Math.PI * 0.9;
  const power = Math.min(1, opts.power ?? 0.8);
  const colors = opts.colors || PALETTE;
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const sp = (180 + Math.random() * 320) * power;
    parts.push({
      x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, grav: 900 + Math.random() * 300,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 12,
      w: 3 + Math.random() * 3, h: 5 + Math.random() * 5, shape: 0,
      color: colors[(Math.random() * colors.length) | 0], life: 0.9 + Math.random() * 0.7,
    });
  }
  if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(confettiLoop); }
}

/* ---- toasts ---- */
const TOAST_ICON = { ok: 'check', bad: 'x', warn: 'alert', xp: 'star', info: 'info', streak: 'flame', unlock: 'lock' };
/** toast('Guardado') · toast('Algo falló', 'bad') · kinds: info|ok|bad|warn|xp|streak|unlock. Devuelve el elemento. */
export function toast(msg, kind = 'info', ms = 3400) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts'; box.className = 'toasts';
    box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  const ic = document.createElement('span'); ic.className = 'toast-ic'; ic.innerHTML = icon(TOAST_ICON[kind] || 'info', 16); ic.setAttribute('aria-hidden', 'true');
  const tx = document.createElement('span'); tx.className = 'toast-tx';
  if (msg instanceof Node) tx.appendChild(msg); else tx.textContent = String(msg);
  t.append(ic, tx);
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  const timer = setTimeout(close, ms);
  t.addEventListener('click', () => { clearTimeout(timer); close(); });
  return t;
}

/* ---- "+20 XP" flotante ---- */
export function xpFloat(el, amount) {
  if (!amount || !fxEnabled()) return;
  const r = el?.getBoundingClientRect ? el.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const f = document.createElement('div');
  f.className = 'fx-xp';
  f.textContent = `+${amount} XP`;
  f.style.left = `${Math.max(40, Math.min(innerWidth - 40, r.left + r.width / 2))}px`;
  f.style.top = `${Math.max(30, r.top)}px`;
  layer().appendChild(f);
  f.addEventListener('animationend', () => f.remove());
  setTimeout(() => f.remove(), 1500);
}

/** Antes dibujaba chispas decorativas. El diseño v2 no lleva partículas de adorno: se conserva la función (no hace nada). */
export function sparkle() { /* intencionadamente vacío */ }

/* ---- subida de nivel ---- */
/** Hito sobrio: sonido corto + aviso de texto + un poco de confeti (si los efectos están activos). */
export function levelUp(level, title) {
  sfx.play('level');
  const msg = h('span', null, h('b', null, `Nivel ${level}`), title ? ` · ${title}` : '');
  toast(msg, 'xp', 4600);
  confetti({ x: 0.5, y: 0.9, count: 120, power: 1, spread: Math.PI * 0.7 });
}

/* =====================================================================
   UTILIDADES DE INTERFAZ (las usan las vistas del shell; cualquiera puede importarlas)
   ===================================================================== */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** h('div', {class:'x', onclick:fn, dataset:{a:1}, html:'<b>..</b>'}, hijo, 'texto', [más]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

/** Markdown ligero de la SPEC: **negrita**, `código`, listas "- ", párrafos. Devuelve HTML seguro. */
export function mdLite(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const out = [];
  for (const block of String(text ?? '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let buf = [], list = [];
    const flushP = () => { if (buf.length) { out.push(`<p>${buf.map(inline).join('<br>')}</p>`); buf = []; } };
    const flushL = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; } };
    for (const l of lines) {
      const m = l.match(/^\s*[-•]\s+(.*)$/);
      if (m) { flushP(); list.push(m[1]); } else { flushL(); buf.push(l); }
    }
    flushP(); flushL();
  }
  return out.join('');
}

/** Resaltado mínimo de Wolfram Language para <pre class="wl sh-wl"> (HTML seguro). */
export function hlWL(code) {
  const src = String(code ?? '');
  const re = /(\(\*[\s\S]*?\*\))|("(?:[^"\\]|\\.)*")|(\d+\.?\d*(?:`\d*)?(?:\*\^-?\d+)?)|([\p{L}$][\p{L}\p{N}$]*)(_{1,3}[\p{L}]*)?|(:=|==|!=|<=|>=|->|:>|\/\.|\/\/|\/@|@@|&&|\|\||\[\[|\]\]|[\[\]{}()])|(\s+)|([\s\S])/gu;
  let out = '', m;
  while ((m = re.exec(src))) {
    if (m[1]) out += `<span class="t-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="t-num">${esc(m[3])}</span>`;
    else if (m[4]) {
      const name = m[4];
      const next = src[re.lastIndex];
      const cls = m[5] ? 't-pat' : /^\p{Lu}/u.test(name) ? (next === '[' ? 't-fn' : 't-sym') : 't-var';
      out += `<span class="${cls}">${esc(name + (m[5] || ''))}</span>`;
    } else if (m[6]) {
      const b = m[6];
      const cls = b === '[' || b === ']' ? 't-br' : b === '{' || b === '}' ? 't-cb' : b === '(' || b === ')' ? 't-pa' : b === '[[' || b === ']]' ? 't-pt' : 't-op';
      out += `<span class="${cls}">${esc(b)}</span>`;
    } else out += esc(m[7] ?? m[8]);
  }
  return out;
}
export function wlPre(code, extraClass = '') {
  return h('pre', { class: `wl sh-wl ${extraClass}`.trim(), html: hlWL(code) });
}

/** Celda FANTASMA (SPEC §11): el código de referencia sale en gris y el alumno lo teclea para ejecutarlo.
 *  Usa createCell(host, {ghost}) de notebook.js; si el cuaderno aún no está disponible deja el código de solo lectura. */
let nbModule = null;
export function ghostCell(host, code, opts = {}) {
  host.replaceChildren(wlPre(code));
  (nbModule ||= import('./notebook.js?v=1794352096')).then((nb) => {
    if (!host.isConnected || typeof nb.createCell !== 'function') return;
    const box = document.createElement('div');
    try {
      nb.createCell(box, { ghost: code, ...opts });
      host.replaceChildren(box);
    } catch (e) { console.warn('[fx] ghostCell', e); }
  }).catch(() => { nbModule = null; });
  return host;
}

/** Anillo de progreso SVG. ring({pct:0..1, size, stroke, color, label, sub}) */
export function ring({ pct = 0, size = 120, stroke = 10, color = 'var(--accent)', color2 = null, label = '', sub = '', cls = '' } = {}) {
  void color2; // el diseño v2 no usa degradados: trazo plano de un solo color
  stroke = Math.min(stroke, Math.max(3, Math.round(size / 18)));
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct || 0));
  const wrap = h('div', { class: `ring ${cls}`.trim(), style: { width: size + 'px', height: size + 'px' }, role: 'img', 'aria-label': `${Math.round(p * 100)} %` });
  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
      <circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>
    <div class="ring-in"><b></b><small></small></div>`;
  wrap.querySelector('b').textContent = label || `${Math.round(p * 100)}%`;
  wrap.querySelector('small').textContent = sub;
  const arc = wrap.querySelector('.ring-arc');
  requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = String(c * (1 - p)); }));
  return wrap;
}

/** Insignia de curso .badge.y1/.y2 */
export function yearBadge(year, text) {
  const y = Number(year) === 2 ? 2 : 1;
  return h('span', { class: `badge y${y}` }, text || `${y}º`);
}

/** Estado vacío / en construcción / error. */
export function emptyState({ icon: ic = 'wrench', title = 'En construcción', text = '', actions = [] } = {}) {
  void ic; // el diseño v2 no lleva icono decorativo: solo texto
  return h('div', { class: 'empty' },
    h('h3', null, title),
    text ? h('p', { class: 'muted' }, text) : null,
    actions.length ? h('div', { class: 'row empty-actions' }, actions) : null);
}

export function skeleton(lines = 3, cls = '') {
  return h('div', { class: `skel ${cls}`.trim(), 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('i', { style: { width: `${[92, 78, 64, 85, 55][i % 5]}%` } })));
}

export function fmtDate(d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  try { return new Intl.DateTimeFormat('es-ES', opts).format(d instanceof Date ? d : new Date(d)); } catch { return String(d); }
}
export function timeAgo(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return fmtDate(ts, { day: 'numeric', month: 'short' });
}

/* ---- iconos SVG en línea (24×24, trazo) ---- */
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  route: '<circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="5" r="2.2"/><path d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9 9.5v10"/>',
  graph: '<circle cx="12" cy="5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><circle cx="12" cy="13" r="1.6"/><path d="M12 7.3v4.1M10.7 14 6.6 16.6M13.3 14l4.1 2.6"/>',
  brackets: '<path d="M9 4H5.5v16H9M15 4h3.5v16H15"/><path d="M10 12h4"/>',
  bolt: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 2.5h5M12 2.5V6"/>',
  book: '<path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h11M9 8.5h6"/>',
  flame: '<path d="M12 2.5c.6 3.4 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2 .9-3.3 2-4.3.4 1.6 1.2 2.3 2 2.8C10 9 10.2 5.5 12 2.5z"/>',
  sound: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  arrow: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  download: '<path d="M12 3.5v12M7 11l5 5 5-5M4.5 20.5h15"/>',
  upload: '<path d="M12 16.5v-12M7 9l5-5 5 5M4.5 20.5h15"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  star: '<path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.2 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z"/>',
  plane: '<path d="M21.5 3.5 2.5 10.5l7 3 3 7z"/><path d="m9.5 13.5 5-4"/>',
  rocket: '<path d="M12 2.5c3.5 2.5 5 6 5 9.5l-2 4.5H9L7 12c0-3.5 1.5-7 5-9.5z"/><circle cx="12" cy="9.5" r="1.8"/><path d="M9 16.5 7 21l3-1.5M15 16.5l2 4.5-3-1.5M7 12l-3 3.5 3.5.5M17 12l3 3.5-3.5.5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.7" cy="8.7" r=".9"/><circle cx="15.3" cy="15.3" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="15.3" cy="8.7" r=".9"/><circle cx="8.7" cy="15.3" r=".9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 0-6 5.6L3.5 17l3.5 3.5 4.9-5a4.5 4.5 0 0 0 5.6-6l-3 3-2.5-2.5z"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.3"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5l-9 9M17.5 13.5v6h-13v-13h6"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  layers: '<path d="m12 3.5 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  folder: '<path d="M3.5 6.5h6l2 2.5h9v10.5h-17z"/>',
};
/** icon('home') → cadena SVG; iconEl('home') → elemento. */
export function icon(name, size = 20) {
  const body = (ICONS[name] || ICONS.info);
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
export function iconEl(name, size = 20) {
  const s = document.createElement('span');
  s.className = 'ic-wrap';
  s.innerHTML = icon(name, size);
  return s.firstChild;
}
