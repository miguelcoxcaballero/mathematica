// WolframLab Aero — renderer 2D (SVG + raster para campos) con aspecto Mathematica.
// API (SPEC §4): renderGraphics(el, g) -> {destroy(), update(g)} ; g.dim === 3 se delega en gfx3d.js
import { renderGraphics3D } from './gfx3d.js?v=1794352003';

const NS = 'http://www.w3.org/2000/svg';
export const PALETTE = ['#5E81B5', '#E19C24', '#8FB032', '#EB6235', '#8778B3', '#C56E1A', '#5D9EC7', '#FFBF00',
  '#A5609D', '#929600', '#E95536', '#6685D9', '#F89F13', '#BC5B80', '#47B66D'];
const FONT = '"Source Sans 3","Source Sans Pro","Helvetica Neue",Helvetica,Arial,sans-serif';
const AXC = '#666666';       // ejes y números (GrayLevel[0.4])
const DEF_W = 420;

// ------------------------------------------------------------------ gradientes
const GRADS = {
  // aproximación del degradado por defecto de ContourPlot/DensityPlot (azul oscuro -> crema -> naranja)
  def: [[0, 38, 53, 122], [0.14, 52, 88, 160], [0.3, 86, 136, 196], [0.45, 152, 186, 214], [0.56, 214, 226, 226],
    [0.66, 244, 232, 196], [0.78, 247, 207, 130], [0.89, 240, 166, 66], [1, 226, 122, 36]],
  TemperatureMap: [[0, 46, 80, 170], [0.25, 120, 180, 230], [0.5, 250, 250, 240], [0.75, 245, 170, 90], [1, 205, 50, 40]],
  Rainbow: [[0, 120, 28, 134], [0.15, 64, 64, 190], [0.32, 70, 150, 190], [0.5, 100, 180, 100], [0.68, 200, 200, 60],
    [0.85, 230, 140, 45], [1, 220, 40, 30]],
  DarkRainbow: [[0, 60, 86, 146], [0.25, 64, 124, 80], [0.5, 190, 180, 60], [0.75, 200, 110, 50], [1, 150, 40, 50]],
  SunsetColors: [[0, 0, 0, 0], [0.2, 95, 20, 120], [0.45, 215, 50, 80], [0.7, 250, 150, 40], [0.9, 255, 230, 120], [1, 255, 255, 255]],
  SolarColors: [[0, 120, 0, 0], [0.4, 220, 80, 10], [0.75, 250, 170, 30], [1, 255, 240, 80]],
  ThermometerColors: [[0, 40, 60, 160], [0.3, 130, 170, 220], [0.5, 220, 220, 200], [0.75, 220, 130, 100], [1, 140, 20, 30]],
  BlueGreenYellow: [[0, 30, 30, 120], [0.35, 30, 120, 140], [0.7, 110, 190, 110], [1, 240, 240, 110]],
  GrayTones: [[0, 25, 25, 25], [1, 240, 240, 240]],
  GrayLevel: [[0, 0, 0, 0], [1, 255, 255, 255]],
  AvocadoColors: [[0, 0, 0, 0], [0.35, 30, 110, 40], [0.7, 150, 200, 60], [1, 255, 250, 150]],
  LakeColors: [[0, 75, 20, 135], [0.4, 60, 110, 200], [0.75, 130, 190, 230], [1, 240, 240, 245]],
  Pastel: [[0, 195, 120, 240], [0.25, 240, 140, 190], [0.5, 245, 205, 130], [0.75, 170, 225, 130], [1, 120, 190, 240]],
  Hue: [[0, 255, 0, 0], [1 / 6, 255, 255, 0], [2 / 6, 0, 255, 0], [3 / 6, 0, 255, 255], [4 / 6, 0, 0, 255], [5 / 6, 255, 0, 255], [1, 255, 0, 0]],
  vec: [[0, 48, 66, 140], [0.3, 78, 122, 188], [0.55, 150, 150, 170], [0.75, 226, 150, 70], [1, 226, 98, 38]],
};
const LUTS = {};
export function lut(name) {
  const key = GRADS[name] ? name : 'def';
  if (LUTS[key]) return LUTS[key];
  const st = GRADS[key], out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < st.length - 2 && t > st[k + 1][0]) k++;
    const a = st[k], b = st[k + 1], f = Math.min(1, Math.max(0, (t - a[0]) / ((b[0] - a[0]) || 1)));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * f);
  }
  return (LUTS[key] = out);
}
function lutCss(L, t) {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`;
}
export function hexRgb(h) {
  if (!h || h[0] !== '#') return [94, 129, 181];
  if (h.length === 4) return [1, 2, 3].map(i => parseInt(h[i] + h[i], 16));
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function darker(h, f = 0.3) {
  const [r, g, b] = hexRgb(h);
  return `rgb(${Math.round(r * (1 - f))},${Math.round(g * (1 - f))},${Math.round(b * (1 - f))})`;
}

// ------------------------------------------------------------------ utilidades
function S(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
let _mctx = null;
export function textW(s, px = 11, weight = '') {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d');
  if (!_mctx) return String(s).length * px * 0.55;
  _mctx.font = `${weight} ${px}px ${FONT}`;
  return _mctx.measureText(String(s)).width;
}
const fin = v => typeof v === 'number' && isFinite(v);
const r2 = v => Math.round(v * 100) / 100;
const clampPx = v => (v > 2e4 ? 2e4 : v < -2e4 ? -2e4 : v);
const SUP = { '-': '⁻', '+': '⁺', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const sup = n => String(n).split('').map(c => SUP[c] || c).join('');

export function niceTicks(lo, hi, target) {
  const span = hi - lo;
  if (!(span > 0) || !isFinite(span)) return { major: [], minor: [], step: 1 };
  const raw = span / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  let step, sub;
  if (m < 1.5) { step = 1; sub = 5; } else if (m < 3.5) { step = 2; sub = 4; } else if (m < 7.5) { step = 5; sub = 5; } else { step = 10; sub = 5; }
  step *= p;
  const major = [], minor = [];
  const e = span * 1e-9;
  for (let i = Math.ceil((lo - e) / step); i <= Math.floor((hi + e) / step); i++) major.push(i * step);
  const ms = step / sub;
  for (let j = Math.ceil((lo - e) / ms); j <= Math.floor((hi + e) / ms); j++) if (j % sub !== 0) minor.push(j * ms);
  return { major, minor, step };
}
export function fmtTick(v, step) {
  if (Math.abs(v) < step * 1e-6) v = 0;
  const av = Math.abs(v);
  let s;
  if (av !== 0 && (av >= 1e6 || step < 1e-4)) {
    const ex = Math.floor(Math.log10(av) + 1e-9);
    let mant = v / Math.pow(10, ex);
    mant = Math.round(mant * 1000) / 1000;
    s = (mant === 1 ? '' : mant === -1 ? '-' : mant + '×') + '10' + sup(ex);
  } else {
    const dec = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
    s = v.toFixed(dec);
  }
  return s.replace('-', '−');
}
export function fmtNum(v, span) {
  if (!fin(v)) return '–';
  const dec = Math.max(0, Math.min(8, 2 - Math.floor(Math.log10(Math.abs(span) || 1))));
  if (Math.abs(v) >= 1e6 || (Math.abs(span) < 1e-5 && span !== 0)) return v.toExponential(3).replace('-', '−');
  return v.toFixed(dec).replace('-', '−');
}

/** Texto con superíndices sencillos: x^2, E^(-x), 10^-3 … (devuelve anchura aproximada). */
export function richText(el, str, px) {
  str = String(str == null ? '' : str);
  el.textContent = '';
  if (str.indexOf('^') < 0) { el.textContent = str; return textW(str, px); }
  let i = 0, plain = '', w = 0;
  const flush = () => { if (plain) { S('tspan', null, el).textContent = plain; w += textW(plain, px); plain = ''; } };
  while (i < str.length) {
    const c = str[i];
    if (c === '^' && i + 1 < str.length) {
      let j = i + 1, ex = '';
      if (str[j] === '(') {
        let depth = 0, k = j;
        for (; k < str.length; k++) { if (str[k] === '(') depth++; else if (str[k] === ')') { depth--; if (depth === 0) break; } }
        ex = str.slice(j + 1, k); j = k + 1;
      } else {
        const m = /^[-+]?[\w.π]+/.exec(str.slice(j));
        if (m) { ex = m[0]; j += ex.length; }
      }
      if (ex) {
        flush();
        const sp = px * 0.72, dy = px * 0.38;
        const t = S('tspan', { 'font-size': r2(sp), dy: r2(-dy) }, el);
        t.textContent = ex.replace(/\^/g, '');
        w += textW(ex, sp);
        // devolver la línea base
        const z = S('tspan', { dy: r2(dy), 'font-size': r2(px) }, el);
        z.textContent = '​';
        i = j;
        continue;
      }
    }
    plain += c; i++;
  }
  flush();
  return w;
}

// ------------------------------------------------------------------ campos
function fieldData(p) {
  if (p._F) return p._F;
  const n = p.nx * p.ny, F = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = p.data[i];
    if (v == null || !isFinite(v)) F[i] = NaN; else { F[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!(hi >= lo)) { lo = 0; hi = 1; }
  // rango robusto (polos): recortar con percentiles si hay colas enormes
  let rlo = lo, rhi = hi;
  if (n > 50) {
    const s = Array.from(F).filter(isFinite).sort((a, b) => a - b);
    if (s.length > 20) {
      const q = f => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * (s.length - 1))))];
      const q1 = q(0.02), q9 = q(0.98), mid = q9 - q1;
      if (mid > 0 && hi - lo > 6 * mid) { rlo = Math.max(lo, q1 - 0.3 * mid); rhi = Math.min(hi, q9 + 0.3 * mid); }
    }
  }
  Object.defineProperty(p, '_F', { value: { F, lo, hi, rlo, rhi }, enumerable: false });
  return p._F;
}
function bilinear(p, F, x, y) {
  const gx = (x - p.x0) / (p.x1 - p.x0) * (p.nx - 1), gy = (y - p.y0) / (p.y1 - p.y0) * (p.ny - 1);
  if (gx < 0 || gy < 0 || gx > p.nx - 1 || gy > p.ny - 1) return NaN;
  const i = Math.min(p.nx - 2, Math.floor(gx)), j = Math.min(p.ny - 2, Math.floor(gy)), fx = gx - i, fy = gy - j;
  const o = j * p.nx + i;
  return (F[o] * (1 - fx) + F[o + 1] * fx) * (1 - fy) + (F[o + p.nx] * (1 - fx) + F[o + p.nx + 1] * fx) * fy;
}

/** Marching squares: isolínea de `level` -> polilíneas en coordenadas de rejilla [[gx,gy],...]. */
export function marchingSquares(F, nx, ny, level) {
  const pts = new Map();   // id de arista -> [gx, gy]
  const segs = [];
  const H = (i, j) => j * nx + i, V = (i, j) => nx * ny + j * nx + i;
  const val = (i, j) => F[j * nx + i] - level;
  const pt = (id, i0, j0, i1, j1) => {
    if (!pts.has(id)) {
      const a = val(i0, j0), b = val(i1, j1);
      let t = a / (a - b);
      if (!isFinite(t)) t = 0.5;
      t = Math.min(1, Math.max(0, t));
      pts.set(id, [i0 + (i1 - i0) * t, j0 + (j1 - j0) * t]);
    }
    return id;
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = val(i, j), b = val(i + 1, j), c = val(i + 1, j + 1), d = val(i, j + 1);
      if (a !== a || b !== b || c !== c || d !== d) continue;
      const m = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (m === 0 || m === 15) continue;
      const eB = () => pt(H(i, j), i, j, i + 1, j), eR = () => pt(V(i + 1, j), i + 1, j, i + 1, j + 1);
      const eT = () => pt(H(i, j + 1), i, j + 1, i + 1, j + 1), eL = () => pt(V(i, j), i, j, i, j + 1);
      switch (m) {
        case 1: case 14: segs.push([eL(), eB()]); break;
        case 2: case 13: segs.push([eB(), eR()]); break;
        case 3: case 12: segs.push([eL(), eR()]); break;
        case 4: case 11: segs.push([eR(), eT()]); break;
        case 6: case 9: segs.push([eB(), eT()]); break;
        case 7: case 8: segs.push([eL(), eT()]); break;
        case 5: case 10: {
          const ctr = (a + b + c + d) / 4 > 0;
          if ((m === 5) === ctr) { segs.push([eL(), eT()]); segs.push([eB(), eR()]); } else { segs.push([eL(), eB()]); segs.push([eR(), eT()]); }
          break;
        }
      }
    }
  }
  // unir segmentos en polilíneas
  const adj = new Map();
  segs.forEach((s, k) => { for (const id of s) { let a = adj.get(id); if (!a) adj.set(id, (a = [])); a.push(k); } });
  const used = new Uint8Array(segs.length), lines = [];
  const walk = (startId, k) => {
    const line = [pts.get(startId)];
    let id = startId;
    while (k != null && !used[k]) {
      used[k] = 1;
      const s = segs[k];
      id = s[0] === id ? s[1] : s[0];
      line.push(pts.get(id));
      const nb = adj.get(id);
      k = null;
      for (const q of nb) if (!used[q]) { k = q; break; }
    }
    return line;
  };
  for (const [id, a] of adj) if (a.length === 1 && !used[a[0]]) lines.push(walk(id, a[0]));
  for (let k = 0; k < segs.length; k++) if (!used[k]) lines.push(walk(segs[k][0], k));
  return lines;
}

function contourLevels(p, fd) {
  if (Array.isArray(p.levels) && p.levels.length) return p.levels.filter(fin).slice().sort((a, b) => a - b);
  const lo = fd.rlo, hi = fd.rhi;
  if (!(hi > lo)) return [];
  if (p.nlev) {
    const n = Math.max(1, Math.min(60, Math.round(p.nlev))), out = [];
    for (let k = 1; k <= n; k++) out.push(lo + (hi - lo) * k / (n + 1));
    return out;
  }
  const t = niceTicks(lo, hi, 9).major.filter(v => v > lo + (hi - lo) * 1e-6 && v < hi - (hi - lo) * 1e-6);
  return t;
}

// ------------------------------------------------------------------ Plot2D
class Plot2D {
  constructor(el, g) {
    this.el = el;
    this.g = g;
    this.root = document.createElement('div');
    this.root.className = 'wl-gfx wl-gfx2d';
    el.appendChild(this.root);
    this.root.__wlgfx = this;
    this._lastW = -1;
    this.render();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        const w = this.availW();
        if (w > 0 && Math.abs(w - this._lastW) > 1) { cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this.render()); }
      });
      this.ro.observe(el);
    }
  }
  availW() {
    const w = this.el.clientWidth;
    if (!w) return 0;
    let pad = 0;
    try { const cs = getComputedStyle(this.el); pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); } catch (e) { /* */ }
    return Math.max(0, w - pad);
  }
  update(g) { this.g = g; this.render(); }
  destroy() {
    if (this.ro) this.ro.disconnect();
    cancelAnimationFrame(this._raf);
    this.root.remove();
  }

  bbox() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const logy = !!(this.g.opts || {}).logy;
    const ax = v => { if (fin(v)) { if (v < x0) x0 = v; if (v > x1) x1 = v; } };
    const ay = v => { if (fin(v) && (!logy || v > 0)) { if (v < y0) y0 = v; if (v > y1) y1 = v; } };
    for (const p of this.g.prims || []) {
      switch (p.t) {
        case 'line': case 'points': case 'poly': (p.x || []).forEach(ax); (p.y || []).forEach(ay); break;
        case 'fill': (p.x || []).forEach(ax); (p.y || []).forEach(ay); (p.y2 || []).forEach(ay); break;
        case 'text': ax(p.x); ay(p.y); break;
        case 'arrows': for (const s of p.segs || []) { ax(s[0]); ax(s[2]); ay(s[1]); ay(s[3]); } break;
        case 'field': ax(p.x0); ax(p.x1); ay(p.y0); ay(p.y1); break;
      }
    }
    return [x0, x1, y0, y1];
  }

  render() {
    const g = this.g || {}, o = g.opts || {}, prims = g.prims || [];
    const root = this.root;
    root.textContent = '';
    const logy = !!o.logy;
    // ---- rangos
    const bb = this.bbox();
    const rng = o.range || [null, null];
    const fix = (r, lo, hi, isY) => {
      if (r && fin(r[0]) && fin(r[1]) && r[1] > r[0] && !(isY && logy && r[0] <= 0)) return [r[0], r[1]];
      if (isY && logy && r && fin(r[1]) && r[1] > 0 && fin(lo) && lo > 0) return [Math.min(lo, r[1] / 10), r[1]];
      if (!fin(lo) || !fin(hi)) return isY && logy ? [0.1, 10] : [-1, 1];
      if (isY && logy) { const f = Math.pow(hi / lo, 0.04) || 1.1; return hi > lo ? [lo / f, hi * f] : [lo / 2, hi * 2]; }
      if (hi - lo < 1e-12 * (Math.abs(hi) + 1)) { const d = Math.abs(lo) * 0.1 || 1; return [lo - d, hi + d]; }
      const pad = (hi - lo) * 0.03;
      return [lo - pad, hi + pad];
    };
    let [X0, X1] = fix(rng[0], bb[0], bb[1], false);
    let [Y0, Y1] = fix(rng[1], bb[2], bb[3], true);
    const ty = logy ? (v => (v > 0 ? Math.log10(v) : NaN)) : (v => v);
    const TY0 = ty(Y0), TY1 = ty(Y1);

    // ---- opciones
    const anyTrue = v => (Array.isArray(v) ? v.some(Boolean) : !!v);
    const frame = anyTrue(o.frame);
    const axesOpt = Array.isArray(o.axes) ? [!!o.axes[0], !!o.axes[1]] : [!!o.axes, !!o.axes];
    const axX = axesOpt[0] && !frame, axY = axesOpt[1] && !frame;
    const inX = axesOpt[0] && frame, inY = axesOpt[1] && frame;      // ejes interiores cuando además hay marco
    const legends = prims.filter(p => p.t === 'legend');
    const legItems = [].concat(...legends.map(l => l.items || []));
    const barLeg = legends.find(l => l.bar) || null;
    let bar = null;
    if (barLeg) {
      const fp = prims.find(p => p.t === 'field' && (p.mode === 'density' || p.mode === 'contour'));
      if (fp) {
        const fd = fieldData(fp);
        const lo = fin(barLeg.bar.lo) ? barLeg.bar.lo : fd.rlo, hi = fin(barLeg.bar.hi) ? barLeg.bar.hi : fd.rhi;
        if (hi > lo) bar = { lo, hi, cf: barLeg.bar.cf || fp.cf || 'def', levels: fp.mode === 'contour' ? contourLevels(fp, fd) : null };
      }
    }
    const al = o.axesLabel || [];
    const fl = o.frameLabel || [];
    const tk = o.ticks;
    const tkX = tk === false ? false : Array.isArray(tk) ? tk[0] : null;
    const tkY = tk === false ? false : Array.isArray(tk) ? tk[1] : null;

    // ---- tamaño
    const avail = this.availW();
    this._lastW = avail;
    let maxW = DEF_W, fixedH = null;
    if (Array.isArray(o.size)) { maxW = o.size[0] || DEF_W; fixedH = o.size[1] || null; } else if (fin(o.size) && o.size > 20) maxW = o.size;
    let barTicks = null;
    if (bar) { barTicks = niceTicks(bar.lo, bar.hi, 5); }
    const legW = bar ? 30 + Math.max(...barTicks.major.map(v => textW(fmtTick(v, barTicks.step), 11)), 10)
      : legItems.length ? Math.min(180, Math.max(...legItems.map(it => textW(it.label || '', 12))) + 44) : 0;
    const room = avail || maxW + legW;
    const legRight = legW > 0 && room - legW >= 250;
    let W = Math.max(120, Math.min(maxW, room - (legRight ? legW : 0)));

    // origen de los ejes
    const pickO = (lo, hi) => (lo <= 0 && hi >= 0 ? 0 : (Math.abs(lo) < Math.abs(hi) ? lo : hi));
    let ox = pickO(X0, X1), oyT = logy ? TY0 : pickO(TY0, TY1);
    if (o.origin) {
      if (fin(o.origin[0])) ox = Math.min(X1, Math.max(X0, o.origin[0]));
      if (fin(o.origin[1])) oyT = Math.min(TY1, Math.max(TY0, ty(o.origin[1])));
    }

    // ---- maquetación (márgenes dependientes de etiquetas)
    const TF = 11;                         // tamaño de números
    const aspect = fin(o.aspect) && o.aspect > 0 ? o.aspect : null;
    let mL = 4, mR = 8, mT = 6, mB = 4;
    if (o.plotLabel) mT += 20;
    const hasRaster = prims.some(p => p.t === 'field' && p.mode !== 'implicit');   // lectura fuera del área (encima)
    let Wp, Hp, xt, yt, xLabs, yLabs;
    const mkTicks = () => {
      const tx = Math.max(Wp > 200 ? 5 : 3, Math.min(8, Math.round(Wp / 62))), tyN = Math.max(3, Math.min(7, Math.round(Hp / 40)));
      xt = niceTicks(X0, X1, tx);
      if (logy) {
        const major = [], minor = [];
        for (let k = Math.floor(TY0); k <= Math.ceil(TY1); k++) {
          if (k >= TY0 - 1e-9 && k <= TY1 + 1e-9) major.push(k);
          for (let m = 2; m < 10; m++) { const v = k + Math.log10(m); if (v > TY0 && v < TY1) minor.push(v); }
        }
        const skip = Math.ceil(major.length / 7);
        yt = { major, minor, step: 1, log: true, skip };
      } else yt = niceTicks(TY0, TY1, tyN);
      xLabs = Array.isArray(tkX) ? tkX.filter(t => t[0] >= X0 && t[0] <= X1).map(t => [t[0], t[1] == null ? '' : String(t[1])])
        : tkX === false ? [] : xt.major.map(v => [v, fmtTick(v, xt.step)]);
      if (Array.isArray(tkY)) yLabs = tkY.filter(t => t[0] >= Y0 && t[0] <= Y1).map(t => [ty(t[0]), t[1] == null ? '' : String(t[1])]);
      else if (tkY === false) yLabs = [];
      else if (logy) {
        yLabs = yt.major.filter((v, i) => i % yt.skip === 0).map(k => [k, (k >= -3 && k <= 3) ? String(+Math.pow(10, k).toPrecision(1)) : '10' + sup(k)]);
      } else yLabs = yt.major.map(v => [v, fmtTick(v, yt.step)]);
      if (Array.isArray(tkX)) xt = { major: xLabs.map(t => t[0]), minor: [], step: 1 };
      if (Array.isArray(tkY)) yt = { major: yLabs.map(t => t[0]), minor: [], step: 1 };
      if (tkX === false) xt = { major: [], minor: [], step: 1 };
      if (tkY === false) yt = { major: [], minor: [], step: 1 };
    };
    const xLabW = al[0] ? textW(al[0], 12) + 8 : 0;
    for (let it = 0; it < 4; it++) {
      Wp = Math.max(40, W - mL - mR);
      Hp = fixedH ? Math.max(30, fixedH - mT - mB) : aspect ? Wp * aspect : Wp * (TY1 - TY0) / (X1 - X0);
      if (!fixedH && !aspect && logy) Hp = Wp * 0.618;
      if (!isFinite(Hp) || Hp <= 0) Hp = Wp * 0.618;
      const maxH = Math.max(480, maxW * 1.25);
      if (!fixedH && Hp > maxH) { const k = maxH / Hp; W = Math.max(90, (Wp * k) + mL + mR); Wp = Math.max(30, W - mL - mR); Hp = maxH; }
      if (Hp < 24) Hp = 24;
      mkTicks();
      const ylw = yLabs.length ? Math.max(...yLabs.map(t => textW(t[1], TF))) : 0;
      let nL = 4, nR = 8, nT = (o.plotLabel ? 26 : 6) + (hasRaster && !o.plotLabel ? 9 : 0), nB = 4;
      if (frame) {
        nL = ylw + 9 + (fl[1] ? 18 : 0);
        nB = (xLabs.length ? 17 : 5) + (fl[0] ? 18 : 0);
        nT += (fl[2] ? 18 : 2);
        nR = Math.max(10, (fl[3] ? 20 : 0), xLabs.length ? textW(xLabs[xLabs.length - 1][1], TF) / 2 + 2 : 0);
      } else {
        const fx = (ox - X0) / (X1 - X0), fy = (oyT - TY0) / (TY1 - TY0);
        if (axY) nL = Math.max(nL, ylw + 7 - fx * Wp);
        if (axX) nB = Math.max(nB, 17 - fy * Hp);
        if (axX && xLabs.length) {
          const first = xLabs[0], last = xLabs[xLabs.length - 1];
          nL = Math.max(nL, textW(first[1], TF) / 2 + 2 - (first[0] - X0) / (X1 - X0) * Wp);
          nR = Math.max(nR, textW(last[1], TF) / 2 + 2 - (X1 - last[0]) / (X1 - X0) * Wp);
        }
        if (axX && al[0]) nR = Math.max(nR, xLabW + 4);
        if (axY && al[1]) { nT += 17; const lw = textW(al[1], 12) / 2 + 2; nL = Math.max(nL, lw - fx * Wp); nR = Math.max(nR, lw - (1 - fx) * Wp); }
        if (axY && yLabs.length) nT = Math.max(nT, 7);
      }
      if (Math.abs(nL - mL) < 0.5 && Math.abs(nR - mR) < 0.5 && Math.abs(nT - mT) < 0.5 && Math.abs(nB - mB) < 0.5) break;
      mL = nL; mR = nR; mT = nT; mB = nB;
    }
    mL = Math.ceil(mL); mT = Math.ceil(mT);
    Wp = Math.round(Math.max(40, W - mL - mR));
    Hp = Math.round(Hp);
    const H = mT + Hp + Math.ceil(mB);
    const legBelowH = (!legRight && legItems.length && !bar) ? legItems.length * 18 + 8 : 0;
    const totalW = Math.round(W + (legRight ? legW : 0)), totalH = Math.max(H, legRight ? legItems.length * 18 + 8 : 0) + legBelowH;

    const sx = x => mL + (x - X0) / (X1 - X0) * Wp;
    const syT = t => mT + (1 - (t - TY0) / (TY1 - TY0)) * Hp;
    const sy = y => syT(ty(y));
    this.map = { sx, sy, X0, X1, Y0, Y1, mL, mT, Wp, Hp, logy, TY0, TY1, hasRaster };

    // ---- SVG
    const svg = S('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`, class: 'wl-svg', role: 'img' }, null);
    svg.style.fontFamily = FONT;
    if (fin(o.size) || Array.isArray(o.size)) svg.dataset.sized = '1';
    const uid = 'wlc' + (Plot2D._id = (Plot2D._id || 0) + 1);
    const defs = S('defs', null, svg);
    const cp = S('clipPath', { id: uid }, defs);
    S('rect', { x: mL, y: mT, width: Wp, height: Hp }, cp);
    if (o.bg) S('rect', { x: 0, y: 0, width: W, height: H, fill: o.bg }, svg);

    // rejilla
    if (o.grid) {
      const gg = S('g', { stroke: '#d6d6d6', 'stroke-width': 0.6, 'shape-rendering': 'crispEdges' }, svg);
      const gx = o.grid === true ? true : o.grid[0], gy = o.grid === true ? true : o.grid[1];
      const vx = gx === true ? xt.major : Array.isArray(gx) ? gx : [];
      const vy = gy === true ? yt.major.map(v => (logy ? Math.pow(10, v) : v)) : Array.isArray(gy) ? gy : [];
      for (const v of vx) if (fin(v) && v >= X0 && v <= X1) S('line', { x1: r2(sx(v)), x2: r2(sx(v)), y1: mT, y2: mT + Hp }, gg);
      for (const v of vy) if (fin(v) && v >= Y0 && v <= Y1) S('line', { y1: r2(sy(v)), y2: r2(sy(v)), x1: mL, x2: mL + Wp }, gg);
    }

    // ---- primitivas
    const body = S('g', { 'clip-path': `url(#${uid})` }, svg);
    this.over = null;        // puntos y textos cuyo centro cae dentro no se recortan (como en Mathematica)
    this.svg = svg;
    this.curves = [];
    this.fields = [];
    let autoIdx = 0;
    for (const p of prims) {
      try { this.drawPrim(p, body, sx, sy, autoIdx); } catch (e) { /* una primitiva defectuosa no rompe el gráfico */ }
      if (p.t === 'line') autoIdx++;
    }

    // ---- ejes / marco
    const ax = S('g', { stroke: AXC, 'stroke-width': 1, fill: 'none', 'shape-rendering': 'crispEdges' }, svg);
    const lab = S('g', { fill: AXC, 'font-size': TF, stroke: 'none' }, svg);
    const hx = v => Math.round(v) + 0.5;
    const oxPx = hx(sx(ox)), oyPx = hx(syT(oyT));
    const TL = 4.5, TS = 2.6;
    if (frame) {
      S('rect', { x: hx(mL) - 0.5 + 0.5, y: hx(mT), width: Wp, height: Hp }, ax);
      const xb = mT + Hp + 0.5, xtp = mT + 0.5, yl = mL + 0.5, yr = mL + Wp + 0.5;
      let d = '';
      for (const v of xt.major) { const X = hx(sx(v)); d += `M${X} ${xb}v${-TL}M${X} ${xtp}v${TL}`; }
      for (const v of xt.minor) { const X = hx(sx(v)); d += `M${X} ${xb}v${-TS}M${X} ${xtp}v${TS}`; }
      for (const v of yt.major) { const Y = hx(syT(v)); d += `M${yl} ${Y}h${TL}M${yr} ${Y}h${-TL}`; }
      for (const v of yt.minor) { const Y = hx(syT(v)); d += `M${yl} ${Y}h${TS}M${yr} ${Y}h${-TS}`; }
      // ejes interiores (sin números) si Axes -> True junto al marco y el origen cae dentro
      if (inX && oyPx > mT + 1 && oyPx < mT + Hp - 1) { d += `M${mL} ${oyPx}H${mL + Wp}`; for (const v of xt.major) { const X = hx(sx(v)); d += `M${X} ${oyPx}v${-TS}`; } }
      if (inY && oxPx > mL + 1 && oxPx < mL + Wp - 1) { d += `M${oxPx} ${mT}V${mT + Hp}`; for (const v of yt.major) { const Y = hx(syT(v)); d += `M${oxPx} ${Y}h${TS}`; } }
      if (d) S('path', { d }, ax);
      for (const [v, s] of xLabs) { const t = S('text', { x: r2(sx(v)), y: mT + Hp + 13.5, 'text-anchor': 'middle' }, lab); richText(t, s, TF); }
      for (const [v, s] of yLabs) { const t = S('text', { x: mL - 5, y: r2(syT(v) + 3.8), 'text-anchor': 'end' }, lab); richText(t, s, TF); }
      const L2 = S('g', { fill: '#444', 'font-size': 12.5 }, svg);
      if (fl[0]) richText(S('text', { x: mL + Wp / 2, y: mT + Hp + (xLabs.length ? 31 : 18), 'text-anchor': 'middle' }, L2), fl[0], 12.5);
      if (fl[1]) { const X = mL - 9 - (yLabs.length ? Math.max(...yLabs.map(t => textW(t[1], TF))) : 0) - 4, Y = mT + Hp / 2; richText(S('text', { x: X, y: Y, 'text-anchor': 'middle', transform: `rotate(-90 ${r2(X)} ${r2(Y)})` }, L2), fl[1], 12.5); }
      if (fl[2]) richText(S('text', { x: mL + Wp / 2, y: mT - 6, 'text-anchor': 'middle' }, L2), fl[2], 12.5);
      if (fl[3]) { const X = mL + Wp + 14, Y = mT + Hp / 2; richText(S('text', { x: X, y: Y, 'text-anchor': 'middle', transform: `rotate(-90 ${r2(X)} ${r2(Y)})` }, L2), fl[3], 12.5); }
    } else {
      let d = '';
      if (axX) {
        d += `M${mL} ${oyPx}H${mL + Wp}`;
        const up = oyPx - mT > 6 ? -1 : 1;
        for (const v of xt.major) { const X = hx(sx(v)); d += `M${X} ${oyPx}v${up * TL}`; }
        for (const v of xt.minor) { const X = hx(sx(v)); d += `M${X} ${oyPx}v${up * TS}`; }
        for (const [v, s] of xLabs) {
          const X = sx(v);
          if (axY && Math.abs(X - oxPx) < 7) continue;       // sin número en el cruce de ejes
          richText(S('text', { x: r2(X), y: oyPx + 13.5, 'text-anchor': 'middle' }, lab), s, TF);
        }
      }
      if (axY) {
        d += `M${oxPx} ${mT}V${mT + Hp}`;
        const right = mL + Wp - oxPx > 6 ? 1 : -1;
        for (const v of yt.major) { const Y = hx(syT(v)); d += `M${oxPx} ${Y}h${right * TL}`; }
        for (const v of yt.minor) { const Y = hx(syT(v)); d += `M${oxPx} ${Y}h${right * TS}`; }
        for (const [v, s] of yLabs) {
          const Y = syT(v);
          if (axX && Math.abs(Y - oyPx) < 6) continue;
          richText(S('text', { x: oxPx - 5, y: r2(Y + 3.8), 'text-anchor': 'end' }, lab), s, TF);
        }
      }
      if (d) S('path', { d }, ax);
      const L2 = S('g', { fill: '#444', 'font-size': 12 }, svg);
      if (axX && al[0]) richText(S('text', { x: mL + Wp + 6, y: oyPx + 4, 'text-anchor': 'start' }, L2), al[0], 12);
      if (axY && al[1]) richText(S('text', { x: oxPx, y: mT - 7, 'text-anchor': 'middle' }, L2), al[1], 12);
    }
    if (o.plotLabel) {
      const t = S('text', { x: mL + Wp / 2, y: 15, 'text-anchor': 'middle', fill: '#333', 'font-size': 13 }, svg);
      richText(t, o.plotLabel, 13);
    }

    // ---- leyenda
    if (bar && legRight) {
      const bx = W + 8, bw = 12, bh = Math.min(Hp, 220), by = mT + (Hp - bh) / 2;
      const L = lut(bar.cf), gid = uid + 'g';
      const lg = S('g', { 'font-size': 11, fill: AXC }, svg);
      if (bar.levels && bar.levels.length) {
        const lv = [bar.lo, ...bar.levels.filter(v => v > bar.lo && v < bar.hi), bar.hi];
        for (let k = 0; k < lv.length - 1; k++) {
          const t0 = (lv[k] - bar.lo) / (bar.hi - bar.lo), t1 = (lv[k + 1] - bar.lo) / (bar.hi - bar.lo);
          S('rect', { x: bx, y: r2(by + bh * (1 - t1)), width: bw, height: r2(bh * (t1 - t0) + 0.4), fill: lutCss(L, (t0 + t1) / 2) }, lg);
        }
      } else {
        const gr = S('linearGradient', { id: gid, x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
        for (let k = 0; k <= 16; k++) S('stop', { offset: k / 16, 'stop-color': lutCss(L, k / 16) }, gr);
        S('rect', { x: bx, y: by, width: bw, height: bh, fill: `url(#${gid})` }, lg);
      }
      S('rect', { x: bx + 0.5, y: Math.round(by) + 0.5, width: bw, height: Math.round(bh), fill: 'none', stroke: AXC, 'stroke-width': 0.8, 'shape-rendering': 'crispEdges' }, lg);
      for (const v of barTicks.major) {
        const Y = by + bh * (1 - (v - bar.lo) / (bar.hi - bar.lo));
        S('line', { x1: bx + bw, x2: bx + bw + 3, y1: r2(Y), y2: r2(Y), stroke: AXC, 'stroke-width': 0.8 }, lg);
        S('text', { x: bx + bw + 6, y: r2(Y + 3.8) }, lg).textContent = fmtTick(v, barTicks.step);
      }
    } else if (legItems.length) {
      const lg = S('g', { 'font-size': 12, fill: '#333' }, svg);
      const lx = legRight ? W + 10 : mL + 6;
      let ly = legRight ? Math.max(4, mT + Hp / 2 - legItems.length * 9) : H + 6;
      for (const it of legItems) {
        const c = it.color || PALETTE[0];
        if (it.swatch || it.kind === 'swatch') S('rect', { x: lx, y: ly + 3, width: 12, height: 12, fill: c, 'fill-opacity': it.opacity == null ? 0.6 : it.opacity, stroke: darker(c, 0.2), 'stroke-width': 0.8 }, lg);
        else if (it.kind === 'point') S('circle', { cx: lx + 10, cy: ly + 9, r: 3, fill: c }, lg);
        else S('line', { x1: lx, x2: lx + 20, y1: ly + 9, y2: ly + 9, stroke: c, 'stroke-width': Math.min(3, it.width || 1.6), 'stroke-dasharray': it.dash ? it.dash.join(' ') : null }, lg);
        let lbl = String(it.label || '');
        const maxLab = (legRight ? legW - 34 : W - 40);
        if (textW(lbl, 12) > maxLab) { while (lbl.length > 4 && textW(lbl + '…', 12) > maxLab) lbl = lbl.slice(0, -1); lbl += '…'; }
        richText(S('text', { x: lx + 26, y: ly + 13 }, lg), lbl, 12);
        ly += 18;
      }
    }

    // ---- interacción: retícula + lectura de coordenadas
    this.hover(svg, uid);
    root.appendChild(svg);
    root.style.maxWidth = totalW + 'px';
  }

  drawPrim(p, body, sx, sy, autoIdx) {
    const m = this.map;
    switch (p.t) {
      case 'line': {
        const xs = p.x || [], ys = p.y || [], n = Math.min(xs.length, ys.length);
        const color = p.color || PALETTE[autoIdx % PALETTE.length];
        let d = '', pen = false;
        const px = new Float32Array(n), py = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const X = fin(xs[i]) ? sx(xs[i]) : NaN, Y = fin(ys[i]) ? sy(ys[i]) : NaN;
          px[i] = X; py[i] = Y;
          if (X !== X || Y !== Y) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + r2(clampPx(X)) + ' ' + r2(clampPx(Y));
          pen = true;
        }
        if (!d) break;
        const w = p.width || 1.6;
        S('path', { d, fill: 'none', stroke: color, 'stroke-width': r2(w), 'stroke-linejoin': 'round', 'stroke-linecap': p.dash ? 'butt' : 'round',
          'stroke-dasharray': p.dash ? p.dash.map(r2).join(' ') : null, 'stroke-opacity': p.opacity != null && p.opacity < 1 ? p.opacity : null }, body);
        if (p.arrow) this.arrowHead(body, px, py, p.arrow, color, w, p.opacity);
        if (n > 1 && !p.arrow && !p.nohover) this.curves.push({ px, py, xs, ys, color });
        break;
      }
      case 'points': {
        const xs = p.x || [], ys = p.y || [], r = Math.max(0.8, (p.psize || 4.5) / 2);
        const color = p.color || PALETTE[0];
        const big = r > 2.6 && Math.min(xs.length, ys.length) <= 400;
        const gg = S('g', { fill: color, 'fill-opacity': p.opacity != null && p.opacity < 1 ? p.opacity : null }, big ? this.svg : body);
        const n = Math.min(xs.length, ys.length);
        const px = new Float32Array(n), py = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          px[i] = py[i] = NaN;
          if (!fin(xs[i]) || !fin(ys[i])) continue;
          const X = sx(xs[i]), Y = sy(ys[i]);
          if (X !== X || Y !== Y) continue;
          px[i] = X; py[i] = Y;
          if (big && (X < m.mL - 0.5 || X > m.mL + m.Wp + 0.5 || Y < m.mT - 0.5 || Y > m.mT + m.Hp + 0.5)) continue;
          S('circle', { cx: r2(clampPx(X)), cy: r2(clampPx(Y)), r: r2(r) }, gg);
        }
        this.curves.push({ px, py, xs, ys, color, pts: true });
        break;
      }
      case 'poly': {
        const xs = p.x || [], ys = p.y || [];
        let pts = '';
        for (let i = 0; i < xs.length; i++) if (fin(xs[i]) && fin(ys[i])) { const Y = sy(ys[i]); if (Y === Y) pts += r2(clampPx(sx(xs[i]))) + ',' + r2(clampPx(Y)) + ' '; }
        if (!pts) break;
        const color = p.color || PALETTE[0];
        S('polygon', { points: pts, fill: color, 'fill-opacity': p.opacity != null && p.opacity < 1 ? p.opacity : null,
          stroke: p.edge || 'none', 'stroke-width': p.edge ? (p.ewidth || 1) : null, 'stroke-linejoin': 'round' }, body);
        break;
      }
      case 'fill': {
        const xs = p.x || [], y1 = p.y || [], y2 = p.y2 || [];
        let d = '', run = [];
        const flush = () => {
          if (run.length > 1) {
            d += 'M' + run.map(i => r2(sx(xs[i])) + ' ' + r2(clampPx(sy(y1[i])))).join('L');
            d += 'L' + run.slice().reverse().map(i => r2(sx(xs[i])) + ' ' + r2(clampPx(sy(y2[i])))).join('L') + 'Z';
          }
          run = [];
        };
        for (let i = 0; i < xs.length; i++) {
          if (fin(xs[i]) && fin(y1[i]) && fin(y2[i]) && sy(y1[i]) === sy(y1[i]) && sy(y2[i]) === sy(y2[i])) run.push(i); else flush();
        }
        flush();
        if (d) S('path', { d, fill: p.color || PALETTE[0], 'fill-opacity': p.opacity == null ? 0.2 : p.opacity, stroke: 'none' }, body);
        break;
      }
      case 'text': {
        if (!fin(p.x) || !fin(p.y)) break;
        const off = p.off || [0, 0], size = p.size || 12;
        const anchor = off[0] < -0.3 ? 'start' : off[0] > 0.3 ? 'end' : 'middle';
        const X = sx(p.x) - (off[0] || 0) * 2, Y = sy(p.y) + size * 0.35 + (off[1] || 0) * size * 0.62;
        const inside = X >= m.mL - 1 && X <= m.mL + m.Wp + 1 && Y >= m.mT - 1 && Y <= m.mT + m.Hp + size;
        if (inside) body = this.svg;
        const t = S('text', { x: r2(X), y: r2(Y), 'text-anchor': anchor, fill: p.color || '#000', 'font-size': size,
          'font-weight': p.bold ? 600 : null, 'font-style': p.italic ? 'italic' : null }, body);
        richText(t, p.text, size);
        break;
      }
      case 'arrows': {
        const L = lut('vec'), segs = p.segs || [], mags = p.mags || [];
        const one = p.color || null;
        const frag = S('g', { 'stroke-linecap': 'butt', 'stroke-width': p.width || 1.1 }, body);
        for (let k = 0; k < segs.length; k++) {
          const s = segs[k];
          const x0 = sx(s[0]), y0 = sy(s[1]), x1 = sx(s[2]), y1 = sy(s[3]);
          if (!(fin(x0) && fin(y0) && fin(x1) && fin(y1))) continue;
          const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
          if (len < 0.5) continue;
          const c = one || lutCss(L, mags[k] == null ? 0.3 : mags[k]);
          const ux = dx / len, uy = dy / len, hl = Math.min(5.2, len * 0.42), hw = hl * 0.42;
          const bx = x1 - ux * hl, by = y1 - uy * hl;
          if (p.heads === false) { S('path', { d: `M${r2(x0)} ${r2(y0)}L${r2(x1)} ${r2(y1)}`, stroke: c, fill: 'none' }, frag); continue; }
          S('path', { d: `M${r2(x0)} ${r2(y0)}L${r2(bx + ux * hl * 0.3)} ${r2(by + uy * hl * 0.3)}`, stroke: c, fill: 'none' }, frag);
          S('path', { d: `M${r2(x1)} ${r2(y1)}L${r2(bx - uy * hw)} ${r2(by + ux * hw)}L${r2(bx + ux * hl * 0.25)} ${r2(by + uy * hl * 0.25)}L${r2(bx + uy * hw)} ${r2(by - ux * hw)}Z`, fill: c, stroke: 'none' }, frag);
        }
        break;
      }
      case 'field': this.drawField(p, body, sx, sy); break;
    }
  }

  arrowHead(body, px, py, mode, color, w, opacity) {
    const idx = [];
    for (let i = 0; i < px.length; i++) if (px[i] === px[i] && py[i] === py[i]) idx.push(i);
    if (idx.length < 2) return;
    let tipI, tx, ty, ux, uy;
    if (mode === 'mid') {
      // punto medio (en longitud) del tramo visible
      const m = this.map;
      const vis = idx.filter(i => px[i] >= m.mL - 2 && px[i] <= m.mL + m.Wp + 2 && py[i] >= m.mT - 2 && py[i] <= m.mT + m.Hp + 2);
      if (vis.length < 3) return;
      let tot = 0; const acc = [0];
      for (let k = 1; k < vis.length; k++) { tot += Math.hypot(px[vis[k]] - px[vis[k - 1]], py[vis[k]] - py[vis[k - 1]]); acc.push(tot); }
      if (tot < 26) return;
      let k = 1; while (k < acc.length - 1 && acc[k] < tot * 0.55) k++;
      tipI = vis[k]; const a = vis[Math.max(0, k - 2)];
      ux = px[tipI] - px[a]; uy = py[tipI] - py[a];
    } else {
      tipI = idx[idx.length - 1];
      let k = idx.length - 2;
      while (k > 0 && Math.hypot(px[tipI] - px[idx[k]], py[tipI] - py[idx[k]]) < 3) k--;
      ux = px[tipI] - px[idx[k]]; uy = py[tipI] - py[idx[k]];
    }
    const len = Math.hypot(ux, uy);
    if (!(len > 0)) return;
    ux /= len; uy /= len; tx = px[tipI]; ty = py[tipI];
    const hl = mode === 'mid' ? 7 : Math.max(8, 5 + w * 2.4), hw = hl * (mode === 'mid' ? 0.36 : 0.34);
    const bx = tx - ux * hl, by = ty - uy * hl;
    S('path', { d: `M${r2(tx)} ${r2(ty)}L${r2(bx - uy * hw)} ${r2(by + ux * hw)}L${r2(bx + ux * hl * 0.22)} ${r2(by + uy * hl * 0.22)}L${r2(bx + uy * hw)} ${r2(by - ux * hw)}Z`,
      fill: color, stroke: 'none', 'fill-opacity': opacity != null && opacity < 1 ? opacity : null }, body);
  }

  drawField(p, body, sx, sy) {
    const m = this.map, fd = fieldData(p), F = fd.F, nx = p.nx, ny = p.ny;
    if (!(nx > 1 && ny > 1)) return;
    const gx2px = gx => sx(p.x0 + gx / (nx - 1) * (p.x1 - p.x0)), gy2px = gy => sy(p.y0 + gy / (ny - 1) * (p.y1 - p.y0));
    const linesPath = (level) => {
      let d = '';
      for (const ln of marchingSquares(F, nx, ny, level)) {
        if (ln.length < 2) continue;
        d += 'M' + ln.map(q => r2(gx2px(q[0])) + ' ' + r2(gy2px(q[1]))).join('L');
        const a = ln[0], b = ln[ln.length - 1];
        if (ln.length > 3 && a[0] === b[0] && a[1] === b[1]) d += 'Z';
      }
      return d;
    };
    const mode = p.mode || 'contour';
    this.fields.push(p);
    if (mode === 'implicit') {
      const d = linesPath(0);
      if (d) S('path', { d, fill: 'none', stroke: p.color || PALETTE[0], 'stroke-width': p.width || 1.6, 'stroke-linejoin': 'round',
        'stroke-dasharray': p.dash ? p.dash.join(' ') : null, 'stroke-opacity': p.opacity != null && p.opacity < 1 ? p.opacity : null }, body);
      return;
    }
    // ---- ráster (rect visible del campo)
    const vx0 = Math.max(Math.min(p.x0, p.x1), m.X0), vx1 = Math.min(Math.max(p.x0, p.x1), m.X1);
    const vy0 = Math.max(Math.min(p.y0, p.y1), m.Y0), vy1 = Math.min(Math.max(p.y0, p.y1), m.Y1);
    if (!(vx1 > vx0 && vy1 > vy0)) return;
    const pxL = sx(vx0), pxR = sx(vx1), pxT = sy(vy1), pxB = sy(vy0);
    const cw = pxR - pxL, ch = pxB - pxT;
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    let sc = Math.max(2, dpr);
    while (cw * ch * sc * sc > 1.6e6 && sc > 1) sc *= 0.8;
    const RW = Math.max(2, Math.round(cw * sc)), RH = Math.max(2, Math.round(ch * sc));
    const levels = mode === 'contour' ? contourLevels(p, fd) : null;
    const L = lut(p.cf || 'def');
    const shading = p.shading !== false;
    if (mode !== 'contour' || shading) {
      const cv = document.createElement('canvas');
      cv.width = RW; cv.height = RH;
      const ctx = cv.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(RW, RH), D = img.data;
        // índices/pesos por columna
        const ci = new Int32Array(RW), cf = new Float64Array(RW);
        for (let X = 0; X < RW; X++) {
          const x = vx0 + (X + 0.5) / RW * (vx1 - vx0);
          let gx = (x - p.x0) / (p.x1 - p.x0) * (nx - 1);
          gx = Math.min(nx - 1, Math.max(0, gx));
          const i = Math.min(nx - 2, Math.floor(gx));
          ci[X] = i; cf[X] = gx - i;
        }
        const lo = fd.rlo, span = (fd.rhi - fd.rlo) || 1;
        let bandCol = null;
        if (mode === 'contour') {
          const nb = levels.length + 1;
          bandCol = new Uint8Array(nb * 3);
          for (let k = 0; k < nb; k++) {
            // color de la banda: el del valor medio de la banda dentro del rango
            const a = k === 0 ? lo : levels[k - 1], b = k === nb - 1 ? fd.rhi : levels[k];
            const t = nb === 1 ? 0.5 : Math.min(1, Math.max(0, ((a + b) / 2 - lo) / span));
            const q = Math.round(t * 255) * 3;
            bandCol[k * 3] = L[q]; bandCol[k * 3 + 1] = L[q + 1]; bandCol[k * 3 + 2] = L[q + 2];
          }
        }
        const rc = mode === 'region' ? hexRgb(p.color || PALETTE[0]) : null;
        const ra = mode === 'region' ? Math.round(255 * (p.opacity == null ? 0.45 : p.opacity)) : 255;
        const nl = levels ? levels.length : 0;
        for (let Y = 0; Y < RH; Y++) {
          const y = vy1 - (Y + 0.5) / RH * (vy1 - vy0);
          let gy = (y - p.y0) / (p.y1 - p.y0) * (ny - 1);
          gy = Math.min(ny - 1, Math.max(0, gy));
          const j = Math.min(ny - 2, Math.floor(gy)), fy = gy - j, row = j * nx;
          let o = Y * RW * 4;
          for (let X = 0; X < RW; X++, o += 4) {
            const i = ci[X], fx = cf[X], a = row + i;
            const v = (F[a] * (1 - fx) + F[a + 1] * fx) * (1 - fy) + (F[a + nx] * (1 - fx) + F[a + nx + 1] * fx) * fy;
            if (v !== v) continue;
            if (mode === 'region') {
              if (v > 0) { D[o] = rc[0]; D[o + 1] = rc[1]; D[o + 2] = rc[2]; D[o + 3] = ra; }
            } else if (mode === 'contour') {
              let k = 0, hi = nl;
              while (k < hi) { const mid = (k + hi) >> 1; if (levels[mid] < v) k = mid + 1; else hi = mid; }
              const q = k * 3;
              D[o] = bandCol[q]; D[o + 1] = bandCol[q + 1]; D[o + 2] = bandCol[q + 2]; D[o + 3] = 255;
            } else {
              let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
              const q = ((t * 255) | 0) * 3;
              D[o] = L[q]; D[o + 1] = L[q + 1]; D[o + 2] = L[q + 2]; D[o + 3] = 255;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
        const im = S('image', { x: r2(pxL), y: r2(pxT), width: r2(cw), height: r2(ch), preserveAspectRatio: 'none' }, body);
        try { im.setAttribute('href', cv.toDataURL('image/png')); } catch (e) { /* */ }
      }
    }
    if (mode === 'contour') {
      if (p.lines !== false) {
        let d = '';
        for (const lv of levels) d += linesPath(lv);
        if (d) S('path', { d, fill: 'none', stroke: p.lineColor || (shading ? '#1c1c28' : '#3a4a7a'), 'stroke-opacity': shading ? 0.5 : 0.9,
          'stroke-width': p.lineWidth || 0.7, 'stroke-linejoin': 'round' }, body);
      }
    } else if (mode === 'region') {
      if (p.boundary !== false) {
        const d = linesPath(0);
        if (d) S('path', { d, fill: 'none', stroke: p.edge || darker(p.color || PALETTE[0], 0.32), 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, body);
      }
    }
  }

  hover(svg, uid) {
    const m = this.map;
    const layer = S('g', { 'pointer-events': 'none', visibility: 'hidden' }, svg);
    const hl = S('line', { class: 'wl-cross', stroke: '#9b9b9b', 'stroke-width': 0.7, 'stroke-dasharray': '3 3' }, layer);
    const vl = S('line', { class: 'wl-cross', stroke: '#9b9b9b', 'stroke-width': 0.7, 'stroke-dasharray': '3 3' }, layer);
    const dot = S('circle', { class: 'wl-dot', r: 3.4, fill: '#fff', 'stroke-width': 1.6 }, layer);
    // lectura: texto pequeño gris con halo blanco (sin panel)
    const tipTx = S('text', { class: 'wl-readout', fill: '#6a6a6a', 'font-size': 11, stroke: '#fff', 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke fill' }, layer);
    const inv = (px, py) => {
      const x = m.X0 + (px - m.mL) / m.Wp * (m.X1 - m.X0);
      const t = m.TY0 + (1 - (py - m.mT) / m.Hp) * (m.TY1 - m.TY0);
      return [x, m.logy ? Math.pow(10, t) : t];
    };
    const curves = this.curves, fields = this.fields;
    const move = ev => {
      const rc = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const k = rc.width ? vb.width / rc.width : 1;
      let px = (ev.clientX - rc.left) * k, py = (ev.clientY - rc.top) * k;
      if (px < m.mL - 1 || px > m.mL + m.Wp + 1 || py < m.mT - 1 || py > m.mT + m.Hp + 1) { layer.setAttribute('visibility', 'hidden'); return; }
      // ¿cerca de una curva? -> imán
      let best = null, bd = 16 * 16;
      for (const c of curves) {
        const X = c.px, Y = c.py, n = X.length;
        for (let i = 0; i < n; i++) {
          const ax = X[i], ay = Y[i];
          if (ax !== ax || ay !== ay) continue;
          if (!c.pts && i + 1 < n && X[i + 1] === X[i + 1] && Y[i + 1] === Y[i + 1]) {
            const bx = X[i + 1], by = Y[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + dx * t, qy = ay + dy * t, d = (qx - px) * (qx - px) + (qy - py) * (qy - py);
            if (d < bd) { bd = d; best = { x: qx, y: qy, c, i, t }; }
          } else {
            const d = (ax - px) * (ax - px) + (ay - py) * (ay - py);
            if (d < bd) { bd = d; best = { x: ax, y: ay, c, i, t: 0 }; }
          }
        }
      }
      let dx, dy, label;
      if (best && best.x >= m.mL - 1 && best.x <= m.mL + m.Wp + 1 && best.y >= m.mT - 1 && best.y <= m.mT + m.Hp + 1) {
        px = best.x; py = best.y;
        const c = best.c, i = best.i, j = Math.min(c.xs.length - 1, i + 1);
        dx = c.xs[i] + ((c.xs[j] ?? c.xs[i]) - c.xs[i]) * best.t;
        dy = m.logy ? inv(px, py)[1] : c.ys[i] + ((c.ys[j] ?? c.ys[i]) - c.ys[i]) * best.t;
        dot.setAttribute('visibility', 'inherit');
        dot.setAttribute('cx', r2(px)); dot.setAttribute('cy', r2(py)); dot.setAttribute('stroke', c.color);
      } else {
        [dx, dy] = inv(px, py);
        dot.setAttribute('visibility', 'hidden');
      }
      label = `{${fmtNum(dx, m.X1 - m.X0)}, ${fmtNum(dy, m.logy ? dy : m.Y1 - m.Y0)}}`;
      if (!best) for (let q = fields.length - 1; q >= 0; q--) {
        const f = fields[q];
        if (f.mode === 'implicit' || f.mode === 'region') continue;
        const v = bilinear(f, fieldData(f).F, dx, dy);
        if (v === v) { label += `  f = ${fmtNum(v, fieldData(f).rhi - fieldData(f).rlo)}`; break; }
      }
      hl.setAttribute('x1', m.mL); hl.setAttribute('x2', m.mL + m.Wp); hl.setAttribute('y1', r2(py)); hl.setAttribute('y2', r2(py));
      vl.setAttribute('y1', m.mT); vl.setAttribute('y2', m.mT + m.Hp); vl.setAttribute('x1', r2(px)); vl.setAttribute('x2', r2(px));
      tipTx.textContent = label;
      const tw = textW(label, 11);
      let tx = px + 8, tyy = py - 8;
      const W = svg.viewBox.baseVal.width;
      if (m.hasRaster) { tx = m.mL + m.Wp - tw; tyy = m.mT - 4; } else {
        if (tx + tw > W - 2) tx = px - tw - 8;
        if (tx < 2) tx = 2;
        if (tyy < 12) tyy = py + 16;
      }
      tipTx.setAttribute('x', r2(tx)); tipTx.setAttribute('y', r2(tyy));
      layer.setAttribute('visibility', 'visible');
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => layer.setAttribute('visibility', 'hidden'));
    svg.addEventListener('pointercancel', () => layer.setAttribute('visibility', 'hidden'));
  }
}

export function renderGraphics2D(el, g) {
  const p = new Plot2D(el, g);
  return { destroy: () => p.destroy(), update: g2 => p.update(g2), el: p.root };
}

/** Punto de entrada (SPEC §4). */
export function renderGraphics(el, g) {
  if (!el) return { destroy() {}, update() {} };
  if (g && g.dim === 3) return renderGraphics3D(el, g);
  return renderGraphics2D(el, g || { prims: [], opts: {} });
}
export default renderGraphics;
