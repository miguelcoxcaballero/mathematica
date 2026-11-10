// WolframLab Aero — renderer 3D (WebGL compartido + lienzo 2D por gráfico; respaldo con algoritmo del pintor).
// Pinta la especificación JSON de gfx.py (SPEC §3): surf, iso, line3, pts3, poly3, arrow3, text3.
import { lut, niceTicks, fmtTick, hexRgb, textW } from './gfx2d.js';

const FONT = '"Source Sans 3","Source Sans Pro","Helvetica Neue",Helvetica,Arial,sans-serif';
const SURF = ['#E19C24', '#5E81B5', '#8FB032', '#EB6235', '#8778B3', '#C56E1A', '#5D9EC7', '#FFBF00', '#A5609D', '#929600'];
const DEF_W = 400;
const DEF_VIEW = [1.3, -2.4, 2];
const fin = v => typeof v === 'number' && isFinite(v);

// ===================================================================== WebGL compartido
const VS_MESH = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aUv; attribute vec4 aCol;
uniform mat4 uMVP; uniform mat3 uView; uniform vec3 uEye;
varying vec3 vPos; varying vec3 vN; varying vec3 vVP; varying vec4 vUv; varying vec4 vCol;
void main(){ vPos=aPos; vN=uView*aNrm; vVP=uView*(aPos-uEye); vUv=aUv; vCol=aCol; gl_Position=uMVP*vec4(aPos,1.0); }`;
const FS_MESH = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec3 uHalf; uniform float uLW;
varying vec3 vPos; varying vec3 vN; varying vec3 vVP; varying vec4 vUv; varying vec4 vCol;
void main(){
  vec3 q=abs(vPos)-uHalf;
  if(max(q.x,max(q.y,q.z))>0.0||vUv.w<0.0) discard;
  vec3 n=normalize(vN); vec3 V=normalize(-vVP);
  vec3 ng=normalize(cross(dFdx(vVP),dFdy(vVP)));
  n=normalize(mix(ng*sign(dot(ng,n)+1e-6),n,smoothstep(0.72,0.93,abs(dot(n,ng)))));
  if(dot(n,V)<0.0) n=-n;
  float d=0.22*max(dot(n,vec3(0.7071,0.0,0.7071)),0.0)+0.27*max(dot(n,vec3(0.5774,0.5774,0.5774)),0.0)+0.22*max(dot(n,vec3(0.0,0.7071,0.7071)),0.0);
  vec3 base=vCol.rgb;
  vec3 lit=base*(0.56+d)+base*vec3(0.62,0.68,0.88)*0.22*max(dot(n,vec3(-0.70,-0.52,0.49)),0.0);
  vec3 Hh=normalize(V+vec3(0.5774,0.5774,0.5774));
  lit+=vec3(0.13)*pow(max(dot(n,Hh),0.0),24.0);
  vec3 fw=fwidth(vUv.xyz)+1e-6;
  vec3 g=abs(fract(vUv.xyz-0.5)-0.5)/fw;
  float ln=min(g.x,min(g.y,g.z));
  float mk=1.0-smoothstep(uLW-0.55,uLW+0.55,ln);
  lit=mix(lit,lit*0.25,mk*0.62);
  gl_FragColor=vec4(min(lit,vec3(1.0)),vCol.a);
}`;
const VS_LINE = `
attribute vec3 aA; attribute vec3 aB; attribute vec2 aT; attribute vec4 aCol; attribute float aW;
uniform mat4 uMVP; uniform vec2 uRes; uniform float uDpr;
varying vec4 vCol; varying vec3 vPos;
void main(){
  vec4 a=uMVP*vec4(aA,1.0); vec4 b=uMVP*vec4(aB,1.0);
  vec2 sa=a.xy/a.w*uRes; vec2 sb=b.xy/b.w*uRes;
  vec2 d=(sb-sa)*aT.x; float l=length(d);
  vec2 n=l>1e-5?vec2(-d.y,d.x)/l:vec2(0.0,1.0);
  vec2 t=l>1e-5?d/l:vec2(0.0);
  vec4 p=a;
  p.xy+=(n*aT.y*aW*uDpr*0.5-t*0.35*uDpr)/uRes*p.w;
  p.z-=0.0007*p.w;
  vCol=aCol; vPos=aA; gl_Position=p;
}`;
const FS_LINE = `
precision highp float;
uniform vec3 uHalf; varying vec4 vCol; varying vec3 vPos;
void main(){ vec3 q=abs(vPos)-uHalf-0.004; if(max(q.x,max(q.y,q.z))>0.0) discard; gl_FragColor=vCol; }`;
const VS_PT = `
attribute vec3 aPos; attribute vec4 aCol; attribute float aSize;
uniform mat4 uMVP; uniform float uDpr; uniform vec3 uHalf; varying vec4 vCol;
void main(){
  vec4 p=uMVP*vec4(aPos,1.0); p.z-=0.001*p.w;
  vec3 q=abs(aPos)-uHalf-0.004;
  if(max(q.x,max(q.y,q.z))>0.0) p=vec4(2.0,2.0,2.0,1.0);
  vCol=aCol; gl_PointSize=aSize*uDpr; gl_Position=p;
}`;
const FS_PT = `
precision highp float; varying vec4 vCol;
void main(){ vec2 c=gl_PointCoord-0.5; float r=length(c); if(r>0.5) discard; gl_FragColor=vec4(vCol.rgb*(r>0.40?0.72:1.0),vCol.a); }`;

let G = null;            // {canvas, gl, mesh, line, pt, gen} | false
const LIVE = new Set();

function compile(gl, vs, fs, attrs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}
function initPrograms(g) {
  const gl = g.gl;
  g.mesh = compile(gl, VS_MESH, FS_MESH, ['aPos', 'aNrm', 'aUv', 'aCol']);
  g.line = compile(gl, VS_LINE, FS_LINE, ['aA', 'aB', 'aT', 'aCol', 'aW']);
  g.pt = compile(gl, VS_PT, FS_PT, ['aPos', 'aCol', 'aSize']);
}
function getGL() {
  if (G !== null) return G || null;
  try {
    if (typeof window !== 'undefined' && window.__WL_NO_WEBGL) throw new Error('disabled');
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('no webgl');
    if (!gl.getExtension('OES_standard_derivatives') || !gl.getExtension('OES_element_index_uint')) throw new Error('ext');
    G = { canvas, gl, gen: 1, lost: false };
    initPrograms(G);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); G.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      try { gl.getExtension('OES_standard_derivatives'); gl.getExtension('OES_element_index_uint'); initPrograms(G); G.gen++; G.lost = false; for (const p of LIVE) p.requestDraw(); } catch (e) { G = false; }
    });
  } catch (e) {
    G = false;
  }
  return G || null;
}

// ===================================================================== escena
class Scene {
  constructor(g) {
    this.g = g;
    const o = g.opts || {};
    this.o = o;
    this.pos = []; this.nrm = []; this.uv = []; this.col = [];
    this.idxO = []; this.idxT = [];
    this.lA = []; this.lB = []; this.lT = []; this.lC = []; this.lW = [];
    this.pP = []; this.pC = []; this.pS = [];
    this.texts = [];
    this.computeRange();
    for (const p of g.prims || []) {
      try {
        switch (p.t) {
          case 'surf': this.addSurf(p); break;
          case 'iso': this.addIso(p); break;
          case 'line3': this.addLine(p, false); break;
          case 'arrow3': this.addLine(p, true); break;
          case 'pts3': this.addPts(p); break;
          case 'poly3': this.addPoly(p); break;
          case 'text3': if (fin(p.x) && fin(p.y) && fin(p.z)) this.texts.push({ p: this.N3(p.x, p.y, p.z), text: String(p.text == null ? '' : p.text), color: p.color || '#000', size: p.size || 12 }); break;
        }
      } catch (e) { /* primitiva defectuosa */ }
    }
    this.nSceneLines = this.lA.length / 18;
    this.buildBox();
    this.finish();
  }

  computeRange() {
    const o = this.o, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const acc = (k, v) => { if (fin(v)) { if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } };
    const need = [0, 1, 2].map(k => !(o.range && o.range[k] && fin(o.range[k][0]) && fin(o.range[k][1]) && o.range[k][1] > o.range[k][0]));
    if (need.some(Boolean)) {
      for (const p of this.g.prims || []) {
        if (p.t === 'iso') { for (let k = 0; k < 3; k++) { const r = (p.inner || p.r)[k]; acc(k, r[0]); acc(k, r[1]); } } else if (p.t === 'text3') { acc(0, p.x); acc(1, p.y); acc(2, p.z); } else if (p.x && p.y && p.z) {
          const X = p.x, Y = p.y, Z = p.z;
          if (need[0]) for (let i = 0; i < X.length; i++) acc(0, X[i]);
          if (need[1]) for (let i = 0; i < Y.length; i++) acc(1, Y[i]);
          if (need[2]) for (let i = 0; i < Z.length; i++) acc(2, Z[i]);
        }
      }
    }
    this.range = [0, 1, 2].map(k => {
      if (!need[k]) return [o.range[k][0], o.range[k][1]];
      let a = lo[k], b = hi[k];
      if (!fin(a) || !fin(b)) return [-1, 1];
      if (b - a < 1e-12 * (Math.abs(a) + Math.abs(b) + 1)) { const d = Math.abs(a) * 0.1 || 1; return [a - d, b + d]; }
      const pad = (b - a) * 0.02;
      return [a - pad, b + pad];
    });
    let box = o.box;
    if (!(Array.isArray(box) && box.length === 3 && box.every(v => fin(v) && v > 0))) box = this.range.map(r => r[1] - r[0]);
    const mx = Math.max(box[0], box[1], box[2]) || 1;
    this.box = box.map(v => Math.max(0.04, v / mx));
    this.half = this.box.map(v => v / 2);
    this.R = Math.hypot(this.half[0], this.half[1], this.half[2]);
  }
  N(k, v) { const r = this.range[k]; return ((v - r[0]) / (r[1] - r[0]) - 0.5) * this.box[k]; }
  N3(x, y, z) { return [this.N(0, x), this.N(1, y), this.N(2, z)]; }

  rgba(color, ci, opacity) {
    const c = hexRgb(color || SURF[(ci || 0) % SURF.length]);
    const a = opacity == null ? 1 : Math.max(0, Math.min(1, opacity));
    return [c[0], c[1], c[2], Math.round(a * 255)];
  }

  addSurf(p) {
    const nx = p.nx, ny = p.ny, n = nx * ny;
    if (!(nx > 1 && ny > 1)) return;
    const P = new Float32Array(n * 3), ok = new Uint8Array(n), NR = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = p.x[i], y = p.y[i], z = p.z[i];
      if (fin(x) && fin(y) && fin(z)) { ok[i] = 1; P[i * 3] = this.N(0, x); P[i * 3 + 1] = this.N(1, y); P[i * 3 + 2] = this.N(2, z); }
    }
    const hz = this.half[2] * 3 + 1;
    const mask = p.m || null;
    const quads = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
        if (!(ok[a] && ok[b] && ok[c] && ok[d])) continue;
        if (mask && !(mask[a] > 0 || mask[b] > 0 || mask[c] > 0 || mask[d] > 0)) continue;
        // normal de cara (producto de diagonales) acumulada en los 4 vértices
        const ux = P[c * 3] - P[a * 3], uy = P[c * 3 + 1] - P[a * 3 + 1], uz = Math.max(-hz, Math.min(hz, P[c * 3 + 2])) - Math.max(-hz, Math.min(hz, P[a * 3 + 2]));
        const vx = P[d * 3] - P[b * 3], vy = P[d * 3 + 1] - P[b * 3 + 1], vz = Math.max(-hz, Math.min(hz, P[d * 3 + 2])) - Math.max(-hz, Math.min(hz, P[b * 3 + 2]));
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
        for (const q of [a, b, c, d]) { NR[q * 3] += fx; NR[q * 3 + 1] += fy; NR[q * 3 + 2] += fz; }
        quads.push(a, b, c, d);
      }
    }
    if (!quads.length) return;
    // costura de superficies cerradas (u o v periódicos): promediar normales
    const weld = (i0, i1) => { for (let k = 0; k < 3; k++) { const s = NR[i0 * 3 + k] + NR[i1 * 3 + k]; NR[i0 * 3 + k] = s; NR[i1 * 3 + k] = s; } };
    const same = (i0, i1) => ok[i0] && ok[i1] && Math.abs(P[i0 * 3] - P[i1 * 3]) + Math.abs(P[i0 * 3 + 1] - P[i1 * 3 + 1]) + Math.abs(P[i0 * 3 + 2] - P[i1 * 3 + 2]) < 1e-5;
    let seamU = true, seamV = true;
    for (let j = 0; j < ny && seamU; j++) if (!same(j * nx, j * nx + nx - 1)) seamU = false;
    for (let i = 0; i < nx && seamV; i++) if (!same(i, (ny - 1) * nx + i)) seamV = false;
    if (seamU) for (let j = 0; j < ny; j++) weld(j * nx, j * nx + nx - 1);
    if (seamV) for (let i = 0; i < nx; i++) weld(i, (ny - 1) * nx + i);
    let mu = 0, mv = 0;
    const mesh = p.mesh;
    if (mesh === true || mesh == null) { mu = mv = 16; } else if (typeof mesh === 'number') { mu = mv = Math.max(1, Math.round(mesh) + 1); } else if (Array.isArray(mesh)) { mu = Math.max(1, Math.round(mesh[0] || 0) + 1); mv = Math.max(1, Math.round(mesh[1] == null ? mesh[0] : mesh[1]) + 1); } else if (p.bd) { mu = mv = 1; }
    if (seamU && mu === 1) mu = 0;
    if (seamV && mv === 1) mv = 0;
    const base = this.pos.length / 3;
    const rgba = this.rgba(p.color, p.ci, p.opacity);
    const L = p.cf ? lut(p.cf) : null, cv = p.cv || null;
    const zr = this.range[2];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const q = j * nx + i;
        this.pos.push(P[q * 3], P[q * 3 + 1], P[q * 3 + 2]);
        let x = NR[q * 3], y = NR[q * 3 + 1], z = NR[q * 3 + 2];
        const l = Math.hypot(x, y, z);
        if (l > 0) { x /= l; y /= l; z /= l; } else { x = 0; y = 0; z = 1; }
        this.nrm.push(x, y, z);
        this.uv.push(mu ? i / (nx - 1) * mu : 0.5, mv ? j / (ny - 1) * mv : 0.5, 0.5, mask ? (fin(mask[q]) ? mask[q] : -1) : 1);
        if (L) {
          let t = cv ? cv[q] : (p.z[q] - zr[0]) / (zr[1] - zr[0]);
          t = fin(t) ? Math.max(0, Math.min(1, t)) : 0;
          const k = Math.round(t * 255) * 3;
          this.col.push(L[k], L[k + 1], L[k + 2], rgba[3]);
        } else this.col.push(rgba[0], rgba[1], rgba[2], rgba[3]);
      }
    }
    const idx = rgba[3] < 255 ? this.idxT : this.idxO;
    for (let k = 0; k < quads.length; k += 4) {
      const a = base + quads[k], b = base + quads[k + 1], c = base + quads[k + 2], d = base + quads[k + 3];
      idx.push(a, b, c, a, c, d);
    }
  }

  /** Malla ya triangulada por gfx.py: v[] posiciones, nrm[] gradiente (espacio de datos), m[] máscara, i[] índices. */
  addMesh(p) {
    const V = p.v, I = p.i, G = p.nrm || [], M = p.m || null, nv = (V.length / 3) | 0;
    if (!nv || !I || !I.length) return;
    const rgba = this.rgba(p.color, p.ci, p.opacity);
    const base = this.pos.length / 3;
    const k = [0, 1, 2].map(a => (this.range[a][1] - this.range[a][0]) / this.box[a]);
    for (let q = 0; q < nv; q++) {
      const x = V[q * 3], y = V[q * 3 + 1], z = V[q * 3 + 2];
      this.pos.push(this.N(0, x), this.N(1, y), this.N(2, z));
      let gx = (G[q * 3] || 0) * k[0], gy = (G[q * 3 + 1] || 0) * k[1], gz = (G[q * 3 + 2] || 0) * k[2];
      const l = Math.hypot(gx, gy, gz);
      if (l > 0) { gx /= l; gy /= l; gz /= l; } else { gz = 1; }
      this.nrm.push(-gx, -gy, -gz);
      this.uv.push(0.5, 0.5, 0.5, M ? (fin(M[q]) ? M[q] : -1) : 1);
      this.col.push(rgba[0], rgba[1], rgba[2], rgba[3]);
    }
    const idx = rgba[3] < 255 ? this.idxT : this.idxO;
    for (let q = 0; q + 2 < I.length; q += 3) idx.push(base + I[q], base + I[q + 1], base + I[q + 2]);
  }

  addIso(p) {
    if (p.v && p.i) { this.addMesh(p); return; }
    const n = p.n, N = n * n * n;
    if (!(n > 1) || !p.data || p.data.length < N) return;
    const F = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = p.data[i]; F[i] = (v == null || !isFinite(v)) ? NaN : v; }
    // coordenadas normalizadas por índice (con capa exterior opcional: RegionPlot3D cierra el sólido)
    const ax = [0, 1, 2].map(k => {
      const out = new Float32Array(n), r = p.r[k], inn = p.pad && p.inner ? p.inner[k] : null;
      for (let i = 0; i < n; i++) {
        let v;
        if (inn) v = i === 0 ? r[0] : i === n - 1 ? r[1] : inn[0] + (i - 1) / (n - 3) * (inn[1] - inn[0]);
        else v = r[0] + i / (n - 1) * (r[1] - r[0]);
        out[i] = this.N(k, v);
      }
      return out;
    });
    const X = ax[0], Y = ax[1], Z = ax[2];
    const n2 = n * n;
    // gradiente en nodos
    const GX = new Float32Array(N), GY = new Float32Array(N), GZ = new Float32Array(N);
    const pad = !!(p.pad && n > 4);
    const lo = pad ? 1 : 0, hi = pad ? n - 2 : n - 1;      // las capas de cierre no entran en el gradiente
    const dd = (A, i, s, o) => {
      if (pad && (i === 0 || i === n - 1)) return i === 0 ? 1e6 : -1e6;   // tapa: normal = eje, hacia fuera
      const i0 = i > lo ? i - 1 : i, i1 = i < hi ? i + 1 : i;
      let a = F[o + (i0 - i) * s], b = F[o + (i1 - i) * s], h = A[i1] - A[i0];
      if (a !== a) { a = F[o]; h = A[i1] - A[i]; }
      if (b !== b) { b = F[o]; h = A[i] - A[i0]; }
      return h !== 0 ? (b - a) / h : 0;
    };
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = k * n2 + j * n + i;
      if (F[o] !== F[o]) continue;
      const px = pad && (i === 0 || i === n - 1), py = pad && (j === 0 || j === n - 1), pz = pad && (k === 0 || k === n - 1);
      if (px || py || pz) { GX[o] = px ? dd(X, i, 1, o) : 0; GY[o] = py ? dd(Y, j, n, o) : 0; GZ[o] = pz ? dd(Z, k, n2, o) : 0; continue; }
      GX[o] = dd(X, i, 1, o); GY[o] = dd(Y, j, n, o); GZ[o] = dd(Z, k, n2, o);
    }
    const rgba = this.rgba(p.color, p.ci, p.opacity);
    const idx = rgba[3] < 255 ? this.idxT : this.idxO;
    const cache = new Map();
    const M = p.mesh ? (typeof p.mesh === 'number' ? p.mesh + 1 : 6) : 0;
    const bx = this.box;
    const vert = (a, b) => {
      const key = a < b ? a * N + b : b * N + a;
      let id = cache.get(key);
      if (id !== undefined) return id;
      const fa = F[a], fb = F[b];
      let t = fa / (fa - fb);
      if (!(t >= 0 && t <= 1)) t = 0.5;
      const ia = a % n, ja = ((a / n) | 0) % n, ka = (a / n2) | 0, ib = b % n, jb = ((b / n) | 0) % n, kb = (b / n2) | 0;
      const x = X[ia] + (X[ib] - X[ia]) * t, y = Y[ja] + (Y[jb] - Y[ja]) * t, z = Z[ka] + (Z[kb] - Z[ka]) * t;
      let gx = GX[a] + (GX[b] - GX[a]) * t, gy = GY[a] + (GY[b] - GY[a]) * t, gz = GZ[a] + (GZ[b] - GZ[a]) * t;
      const l = Math.hypot(gx, gy, gz);
      if (l > 0) { gx /= l; gy /= l; gz /= l; } else { gx = 0; gy = 0; gz = 1; }
      id = this.pos.length / 3;
      this.pos.push(x, y, z); this.nrm.push(-gx, -gy, -gz);
      if (M) this.uv.push((x / bx[0] + 0.5) * M, (y / bx[1] + 0.5) * M, (z / bx[2] + 0.5) * M, 1); else this.uv.push(0.5, 0.5, 0.5, 1);
      this.col.push(rgba[0], rgba[1], rgba[2], rgba[3]);
      cache.set(key, id);
      return id;
    };
    const TET = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
    const off = [0, 1, 1 + n, n, n2, n2 + 1, n2 + 1 + n, n2 + n];
    const c = new Int32Array(8), ins = [], outs = [];
    for (let k = 0; k < n - 1; k++) for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const o = k * n2 + j * n + i;
      let pos = 0, bad = false;
      for (let q = 0; q < 8; q++) { c[q] = o + off[q]; const v = F[c[q]]; if (v !== v) { bad = true; break; } if (v > 0) pos++; }
      if (bad || pos === 0 || pos === 8) continue;
      for (const T of TET) {
        ins.length = 0; outs.length = 0;
        for (let q = 0; q < 4; q++) { const id = c[T[q]]; (F[id] > 0 ? ins : outs).push(id); }
        if (ins.length === 0 || ins.length === 4) continue;
        if (ins.length === 1) idx.push(vert(ins[0], outs[0]), vert(ins[0], outs[1]), vert(ins[0], outs[2]));
        else if (ins.length === 3) idx.push(vert(outs[0], ins[0]), vert(outs[0], ins[1]), vert(outs[0], ins[2]));
        else {
          const a = vert(ins[0], outs[0]), b = vert(ins[0], outs[1]), d = vert(ins[1], outs[0]), e = vert(ins[1], outs[1]);
          idx.push(a, b, e, a, e, d);
        }
      }
    }
  }

  seg(a, b, col, w) {
    // 6 vértices: (propio, otro, signo dir, lado)
    const A = this.lA, B = this.lB, T = this.lT, C = this.lC, W = this.lW;
    const put = (p, q, s, side) => { A.push(p[0], p[1], p[2]); B.push(q[0], q[1], q[2]); T.push(s, side); C.push(col[0], col[1], col[2], col[3]); W.push(w); };
    put(a, b, 1, -1); put(a, b, 1, 1); put(b, a, -1, -1);
    put(b, a, -1, -1); put(a, b, 1, 1); put(b, a, -1, 1);
  }

  addLine(p, arrow) {
    const X = p.x || [], Y = p.y || [], Z = p.z || [], n = Math.min(X.length, Y.length, Z.length);
    const col = this.rgba(p.color || '#5E81B5', 0, p.opacity);
    const w = p.width || 1.6;
    let prev = null, last2 = null, last = null;
    for (let i = 0; i < n; i++) {
      if (!(fin(X[i]) && fin(Y[i]) && fin(Z[i]))) { prev = null; continue; }
      const q = this.N3(X[i], Y[i], Z[i]);
      if (prev) { this.seg(prev, q, col, w); last2 = prev; last = q; }
      prev = q;
    }
    if (arrow && last && last2) {
      // punta: cono
      let dx = last[0] - last2[0], dy = last[1] - last2[1], dz = last[2] - last2[2];
      const first = this.N3(X[0], Y[0], Z[0]);
      const total = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0)) return;
      dx /= len; dy /= len; dz /= len;
      const hl = Math.max(0.018, Math.min(0.075, total * 0.3)), hr = hl * 0.33;
      let ux, uy, uz;
      if (Math.abs(dz) < 0.9) { ux = -dy; uy = dx; uz = 0; } else { ux = 0; uy = -dz; uz = dy; }
      let l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
      const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
      const bx = last[0] - dx * hl, by = last[1] - dy * hl, bz = last[2] - dz * hl;
      const base = this.pos.length / 3, K = 10;
      const push = (x, y, z, nx, ny, nz) => { this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(0.5, 0.5, 0.5, 1); this.col.push(col[0], col[1], col[2], col[3]); };
      for (let k = 0; k < K; k++) {
        const a = k / K * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const rx = ux * ca + vx * sa, ry = uy * ca + vy * sa, rz = uz * ca + vz * sa;
        push(bx + rx * hr, by + ry * hr, bz + rz * hr, rx + dx * 0.35, ry + dy * 0.35, rz + dz * 0.35);
      }
      push(last[0], last[1], last[2], dx, dy, dz);
      push(bx, by, bz, -dx, -dy, -dz);
      const idx = col[3] < 255 ? this.idxT : this.idxO;
      for (let k = 0; k < K; k++) { const k2 = (k + 1) % K; idx.push(base + k, base + k2, base + K); idx.push(base + k2, base + k, base + K + 1); }
    }
  }

  addPts(p) {
    const X = p.x || [], Y = p.y || [], Z = p.z || [], n = Math.min(X.length, Y.length, Z.length);
    const col = this.rgba(p.color || '#5E81B5', 0, p.opacity), s = Math.max(2, p.psize || 5);
    for (let i = 0; i < n; i++) {
      if (!(fin(X[i]) && fin(Y[i]) && fin(Z[i]))) continue;
      const q = this.N3(X[i], Y[i], Z[i]);
      this.pP.push(q[0], q[1], q[2]); this.pC.push(col[0], col[1], col[2], col[3]); this.pS.push(s);
    }
  }

  addPoly(p) {
    const X = p.x || [], Y = p.y || [], Z = p.z || [], n = Math.min(X.length, Y.length, Z.length);
    const pts = [];
    for (let i = 0; i < n; i++) if (fin(X[i]) && fin(Y[i]) && fin(Z[i])) pts.push(this.N3(X[i], Y[i], Z[i]));
    if (pts.length < 3) return;
    // normal de Newell
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const col = this.rgba(p.color || '#b0b0b0', 0, p.opacity);
    const base = this.pos.length / 3;
    for (const q of pts) { this.pos.push(q[0], q[1], q[2]); this.nrm.push(nx, ny, nz); this.uv.push(0.5, 0.5, 0.5, 1); this.col.push(col[0], col[1], col[2], col[3]); }
    const idx = col[3] < 255 ? this.idxT : this.idxO;
    for (let i = 1; i < pts.length - 1; i++) idx.push(base, base + i, base + i + 1);
    if (p.edge !== null && p.edge !== false) {
      const ec = this.rgba(typeof p.edge === 'string' ? p.edge : '#222222', 0, col[3] < 255 ? 0.55 : 0.85);
      for (let i = 0; i < pts.length; i++) this.seg(pts[i], pts[(i + 1) % pts.length], ec, 0.8);
    }
  }

  buildBox() {
    const o = this.o, h = this.half;
    const boxed = o.boxed !== false;
    const axesOpt = Array.isArray(o.axes) ? [0, 1, 2].map(k => !!o.axes[k]) : [!!o.axes, !!o.axes, !!o.axes];
    this.axesOpt = axesOpt;
    const colB = [84, 84, 84, 255], colT = [70, 70, 70, 255];
    // 12 aristas: eje a, signos (sb, sc) de los otros dos ejes
    this.edges = [];
    this.edgeRanges = [];
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3, c = (a + 2) % 3;
      for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
        const p0 = [0, 0, 0], p1 = [0, 0, 0];
        p0[a] = -h[a]; p1[a] = h[a]; p0[b] = p1[b] = sb * h[b]; p0[c] = p1[c] = sc * h[c];
        const start = this.lA.length / 3;
        this.seg(p0, p1, colB, 0.9);
        this.edges.push({ a, b, c, sb, sc, p0, p1 });
        this.edgeRanges.push([start, 6]);
      }
    }
    this.boxed = boxed;
    // marcas: para cada arista, dos variantes (marca a lo largo de b o de c, hacia dentro)
    this.ticks = [0, 1, 2].map(k => {
      const r = this.range[k];
      const t = niceTicks(r[0], r[1], k === 2 ? Math.max(3, Math.round(5 * Math.min(1, this.box[2] * 1.6))) : Math.max(3, Math.round(5 * Math.min(1, this.box[k] * 1.4))));
      return t;
    });
    const tl = 0.022, ts = 0.012;
    this.tickRanges = [];
    for (const e of this.edges) {
      const variants = [];
      for (const [dir, sgn] of [[e.b, -e.sb], [e.c, -e.sc]]) {
        const start = this.lA.length / 3;
        const tk = this.ticks[e.a];
        const mk = (v, len) => {
          const q0 = e.p0.slice(); q0[e.a] = this.N(e.a, v);
          const q1 = q0.slice(); q1[dir] += sgn * len;
          this.seg(q0, q1, colT, 0.8);
        };
        for (const v of tk.major) mk(v, tl);
        for (const v of tk.minor) mk(v, ts);
        variants.push([start, this.lA.length / 3 - start]);
      }
      this.tickRanges.push(variants);
    }
  }

  finish() {
    this.aPos = new Float32Array(this.pos); this.aNrm = new Float32Array(this.nrm); this.aUv = new Float32Array(this.uv); this.aCol = new Uint8Array(this.col);
    this.iO = new Uint32Array(this.idxO); this.iT = new Uint32Array(this.idxT);
    this.aLA = new Float32Array(this.lA); this.aLB = new Float32Array(this.lB); this.aLT = new Float32Array(this.lT); this.aLC = new Uint8Array(this.lC); this.aLW = new Float32Array(this.lW);
    this.aPP = new Float32Array(this.pP); this.aPC = new Uint8Array(this.pC); this.aPS = new Float32Array(this.pS);
    this.pos = this.nrm = this.uv = this.col = this.idxO = this.idxT = this.lA = this.lB = this.lT = this.lC = this.lW = this.pP = this.pC = this.pS = null;
    // centroides de triángulos transparentes (para ordenar)
    const nt = this.iT.length / 3;
    this.tc = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a = this.iT[t * 3] * 3, b = this.iT[t * 3 + 1] * 3, c = this.iT[t * 3 + 2] * 3;
      for (let k = 0; k < 3; k++) this.tc[t * 3 + k] = (this.aPos[a + k] + this.aPos[b + k] + this.aPos[c + k]) / 3;
    }
    this.iTs = new Uint32Array(this.iT.length);
    this.order = new Uint32Array(nt);
    this.keys = new Float32Array(nt);
    this.sortDir = null;
  }
}

// ===================================================================== gráfico
class Plot3D {
  constructor(el, g) {
    this.el = el;
    this.root = document.createElement('div');
    this.root.className = 'wl-gfx wl-gfx3d';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wl-canvas3d';
    this.root.appendChild(this.canvas);
    el.appendChild(this.root);
    this.root.__wlgfx = this;
    this.ctx = this.canvas.getContext('2d');
    this.glres = null;
    this.vel = [0, 0];
    this.active = false;
    this.keep = el.closest ? el.closest('[data-wl-keepview]') : null;
    this.setSpec(g, true);
    this.bind();
    LIVE.add(this);
    for (const p of LIVE) if (p !== this && p.seen && !p.canvas.isConnected) p.destroy();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { const w = this.availW(); if (w > 0 && Math.abs(w - this._lastW) > 1) { this.layout(); this.requestDraw(); } });
      this.ro.observe(el);
    }
    this.layout();
    this.draw();
  }

  setSpec(g, first) {
    this.g = g;
    this.freeGL();
    this.scene = new Scene(g);
    const v = (g.opts && Array.isArray(g.opts.view) && g.opts.view.every(fin) && Math.hypot(...g.opts.view) > 1e-6) ? g.opts.view : DEF_VIEW;
    const vkey = v.join(',');
    const d = Math.hypot(v[0], v[1], v[2]);
    const home = { az: Math.atan2(v[1], v[0]), el: Math.asin(Math.max(-1, Math.min(1, v[2] / d))), zoom: 1 };
    if (Math.abs(v[0]) + Math.abs(v[1]) < 1e-9) home.az = -Math.PI / 2;
    this.dist = Math.max(d, this.scene.R * 1.35);
    this.home = home;
    if (first || vkey !== this._vkey) {
      const kv = this.keep && this.keep.__wlView;
      this.view = kv ? { ...kv } : { ...home };
    }
    this._vkey = vkey;
    this._fit = null;
  }
  update(g) { this.setSpec(g, false); this.layout(); this.draw(); }

  availW() {
    const w = this.el.clientWidth;
    if (!w) return 0;
    let pad = 0;
    try { const cs = getComputedStyle(this.el); pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); } catch (e) { /* */ }
    return Math.max(0, w - pad);
  }

  layout() {
    const o = this.g.opts || {};
    const avail = this.availW();
    this._lastW = avail;
    let maxW = DEF_W, fixedH = null;
    if (Array.isArray(o.size)) { maxW = o.size[0] || DEF_W; fixedH = o.size[1] || null; } else if (fin(o.size) && o.size > 20) maxW = o.size;
    const W = Math.max(140, Math.min(maxW, avail || maxW));
    // proporción de la imagen: la de la caja proyectada desde el punto de vista inicial
    const q = this.extent(this.home);
    const hasAxes = this.scene.axesOpt.some(Boolean);
    const padX = hasAxes ? Math.min(46, W * 0.11) : 10, padY = hasAxes ? Math.min(34, W * 0.085) : 10;
    const top = o.plotLabel ? 22 : 0;
    const H = fixedH || Math.round(Math.max(W * 0.5, Math.min(W * 1.2, (W - 2 * padX) * q.h / q.w + 2 * padY + top)));
    this.W = W; this.H = H; this.padX = padX; this.padY = padY; this.top = top;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    this.root.style.maxWidth = W + 'px';
  }

  /** Extensión en pantalla (a escala 1) de la caja vista desde `view`. */
  extent(view) {
    const cam = this.camera(view, 1, 0, 0);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const h = this.scene.half;
    for (let i = 0; i < 8; i++) {
      const q = cam.proj([(i & 1 ? 1 : -1) * h[0], (i & 2 ? 1 : -1) * h[1], (i & 4 ? 1 : -1) * h[2]]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    return { x0, x1, y0, y1, w: (x1 - x0) || 1, h: (y1 - y0) || 1 };
  }
  /** Encaje (como RotationAction -> "Fit"): escala y centro para que la caja quepa siempre en el lienzo. */
  fit(view) {
    const q = this.extent(view), W = this.W, H = this.H;
    const s = Math.min((W - 2 * this.padX) / q.w, (H - 2 * this.padY - this.top) / q.h);
    const z = view.zoom || 1;
    return { s: s * z, cx: W / 2 - (q.x0 + q.x1) / 2 * s * z, cy: (H + this.top) / 2 - (q.y0 + q.y1) / 2 * s * z };
  }

  /** Cámara: base (r,u,b), ojo, y proyección a píxeles CSS (s = px por unidad en el plano central). */
  camera(view, s, cx, cy) {
    const ce = Math.cos(view.el), se = Math.sin(view.el), ca = Math.cos(view.az), sa = Math.sin(view.az);
    const d = this.dist;
    const b = [ce * ca, ce * sa, se];                // hacia el observador
    const r = [-sa, ca, 0];
    const u = [-se * ca, -se * sa, ce];
    const e = [b[0] * d, b[1] * d, b[2] * d];
    const proj = p => {
      const x = p[0] - e[0], y = p[1] - e[1], z = p[2] - e[2];
      const X = r[0] * x + r[1] * y + r[2] * z, Y = u[0] * x + u[1] * y + u[2] * z, Z = b[0] * x + b[1] * y + b[2] * z;
      const k = s * d / -Z;
      return [cx + X * k, cy - Y * k, -Z];
    };
    return { r, u, b, e, d, proj };
  }

  mvp(cam, s) {
    const { r, u, b, e, d } = cam, W = this.W, H = this.H;
    const R = this.scene.R;
    const near = Math.max(0.05, d - R * 1.05 - 0.05), far = d + R * 1.05 + 0.05;
    const fx = 2 * s * d / W, fy = 2 * s * d / H;
    const A = -(far + near) / (far - near), B = -2 * far * near / (far - near);
    const tr = -(r[0] * e[0] + r[1] * e[1] + r[2] * e[2]), tu = -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]), tb = -(b[0] * e[0] + b[1] * e[1] + b[2] * e[2]);
    // desplazamiento del centro (cx, cy) respecto al centro del lienzo, en NDC
    const ox = (this.cx - W / 2) / (W / 2), oy = -(this.cy - H / 2) / (H / 2);
    // filas: clip.x = fx*X + ox*w ; clip.y = fy*Y + oy*w ; clip.z = A*Z + B ; clip.w = -Z
    const row0 = [fx * r[0] - ox * b[0], fx * r[1] - ox * b[1], fx * r[2] - ox * b[2], fx * tr - ox * tb];
    const row1 = [fy * u[0] - oy * b[0], fy * u[1] - oy * b[1], fy * u[2] - oy * b[2], fy * tu - oy * tb];
    const row2 = [A * b[0], A * b[1], A * b[2], A * tb + B];
    const row3 = [-b[0], -b[1], -b[2], -tb];
    const m = new Float32Array(16);
    for (let c = 0; c < 4; c++) { m[c * 4] = row0[c]; m[c * 4 + 1] = row1[c]; m[c * 4 + 2] = row2[c]; m[c * 4 + 3] = row3[c]; }
    return m;
  }

  // ------------------------------------------------------------ interacción
  bind() {
    const cv = this.canvas;
    const pts = new Map();
    let pinch = 0, last = null, lastT = 0;
    const store = () => { if (this.keep) this.keep.__wlView = { ...this.view }; };
    cv.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* */ }
      this.active = true;
      this.vel = [0, 0];
      last = [ev.clientX, ev.clientY]; lastT = performance.now();
      if (pts.size === 2) { const a = [...pts.values()]; pinch = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]); }
      cv.classList.add('grabbing');
    });
    cv.addEventListener('pointermove', ev => {
      if (!pts.has(ev.pointerId)) return;
      pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
      if (pts.size >= 2) {
        const a = [...pts.values()], dd = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
        if (pinch > 0 && dd > 0) { this.view.zoom = Math.max(0.35, Math.min(8, this.view.zoom * dd / pinch)); this.requestDraw(); }
        pinch = dd;
        return;
      }
      const dx = ev.clientX - last[0], dy = ev.clientY - last[1];
      const now = performance.now(), dt = Math.max(1, now - lastT);
      last = [ev.clientX, ev.clientY]; lastT = now;
      const k = 0.0105;
      this.view.az -= dx * k;
      this.view.el = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.view.el + dy * k));
      this.vel = [-dx * k / dt * 16, dy * k / dt * 16];
      store();
      this.requestDraw();
    });
    const up = ev => {
      if (!pts.has(ev.pointerId)) return;
      pts.delete(ev.pointerId);
      pinch = 0;
      if (pts.size === 1) { last = [...pts.values()][0].slice(); lastT = performance.now(); }
      if (pts.size === 0) {
        cv.classList.remove('grabbing');
        if (performance.now() - lastT > 90) this.vel = [0, 0];
        if (Math.abs(this.vel[0]) + Math.abs(this.vel[1]) > 0.002) this.inertia();
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (pts.size === 0) this.active = false; });
    cv.addEventListener('wheel', ev => {
      if (!(this.active || ev.ctrlKey || ev.metaKey)) return;       // no secuestrar el scroll de la página
      ev.preventDefault();
      const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0016));
      this.view.zoom = Math.max(0.35, Math.min(8, this.view.zoom * f));
      store();
      this.requestDraw();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { this.view = { ...this.home }; this.vel = [0, 0]; store(); this.requestDraw(); });
  }
  inertia() {
    cancelAnimationFrame(this._inert);
    const step = () => {
      this.vel[0] *= 0.93; this.vel[1] *= 0.93;
      if (Math.abs(this.vel[0]) + Math.abs(this.vel[1]) < 0.0006 || !this.canvas.isConnected) return;
      this.view.az += this.vel[0];
      this.view.el = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.view.el + this.vel[1]));
      if (this.keep) this.keep.__wlView = { ...this.view };
      this.draw();
      this._inert = requestAnimationFrame(step);
    };
    this._inert = requestAnimationFrame(step);
  }
  requestDraw() {
    if (this._pending) return;
    this._pending = requestAnimationFrame(() => { this._pending = 0; this.draw(); });
  }

  // ------------------------------------------------------------ GL
  freeGL() {
    const r = this.glres;
    if (r && G && G.gl && r.gen === G.gen) { const gl = G.gl; for (const k in r.b) gl.deleteBuffer(r.b[k]); }
    this.glres = null;
  }
  ensureGL(g) {
    if (this.glres && this.glres.gen === g.gen) return this.glres;
    const gl = g.gl, sc = this.scene;
    const mk = (target, data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage || gl.STATIC_DRAW); return b; };
    const A = gl.ARRAY_BUFFER, E = gl.ELEMENT_ARRAY_BUFFER;
    this.glres = { gen: g.gen, b: {
      pos: mk(A, sc.aPos), nrm: mk(A, sc.aNrm), uv: mk(A, sc.aUv), col: mk(A, sc.aCol), iO: mk(E, sc.iO), iT: mk(E, sc.iTs, gl.DYNAMIC_DRAW),
      lA: mk(A, sc.aLA), lB: mk(A, sc.aLB), lT: mk(A, sc.aLT), lC: mk(A, sc.aLC), lW: mk(A, sc.aLW),
      pP: mk(A, sc.aPP), pC: mk(A, sc.aPC), pS: mk(A, sc.aPS) } };
    sc.sortDir = null;
    return this.glres;
  }

  chooseAxes(cam, P) {
    // arista de cada eje sobre la silueta de la caja (como AxesEdge -> Automatic)
    const sc = this.scene, h = sc.half, res = [null, null, null];
    const ctr = P([0, 0, 0]);
    const front = (axis, sign) => {      // ¿cara (axis = sign) orientada al observador?
      const c = [0, 0, 0]; c[axis] = sign * h[axis];
      return (cam.e[0] - c[0]) * (axis === 0 ? sign : 0) + (cam.e[1] - c[1]) * (axis === 1 ? sign : 0) + (cam.e[2] - c[2]) * (axis === 2 ? sign : 0) > 0;
    };
    sc.edges.forEach((e, i) => {
      if (!sc.axesOpt[e.a]) return;
      const fb = front(e.b, e.sb), fc = front(e.c, e.sc);
      const a = P(e.p0), b = P(e.p1), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let score;
      if (fb !== fc) score = 1000; else score = fb ? -500 : 0;       // silueta > ocultas > delanteras
      if (e.a === 2) score += -mid[0] * 0.5 + (ctr[0] - mid[0] > 0 ? 30 : 0);            // z: la de la izquierda
      else score += mid[1] * 0.5;                                                           // x, y: la de abajo
      // variante de marcas: sobre la cara trasera adyacente
      const variant = (fb !== fc) ? (fb ? 1 : 0) : 0;
      if (!res[e.a] || score > res[e.a].score) res[e.a] = { i, e, score, variant, a, b, mid };
    });
    return res;
  }

  draw() {
    if (this.dead) return;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.canvas.isConnected) this.seen = true;
    const sc = this.scene, W = this.W, H = this.H, dpr = this.dpr, o = this.g.opts || {};
    const ft = this.fit(this.view), s = ft.s;
    this.cx = ft.cx; this.cy = ft.cy;
    const cam = this.camera(this.view, s, this.cx, this.cy);
    const P = cam.proj;
    const axes = this.chooseAxes(cam, P);
    const pw = this.canvas.width, ph = this.canvas.height;
    const g = getGL();
    let drawn = false;
    if (g && !g.lost) {
      try {
        const gl = g.gl;
        if (g.canvas.width < pw || g.canvas.height < ph) { g.canvas.width = Math.max(g.canvas.width, pw); g.canvas.height = Math.max(g.canvas.height, ph); }
        const res = this.ensureGL(g), b = res.b;
        const m = this.mvp(cam, s);
        gl.viewport(0, 0, pw, ph);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, pw, ph);
        const bg = o.bg ? hexRgb(o.bg) : [255, 255, 255];
        gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
        gl.clearDepth(1);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        const half = [sc.half[0] * 1.004 + 0.0025, sc.half[1] * 1.004 + 0.0025, sc.half[2] * 1.004 + 0.0025];
        const useMesh = () => {
          const pr = g.mesh;
          gl.useProgram(pr.p);
          gl.uniformMatrix4fv(pr.u.uMVP, false, m);
          gl.uniformMatrix3fv(pr.u.uView, false, new Float32Array([cam.r[0], cam.u[0], cam.b[0], cam.r[1], cam.u[1], cam.b[1], cam.r[2], cam.u[2], cam.b[2]]));
          gl.uniform3fv(pr.u.uEye, cam.e);
          gl.uniform3fv(pr.u.uHalf, half);
          gl.uniform1f(pr.u.uLW, 0.42 * dpr);
          for (let i = 0; i < 5; i++) (i < 4 ? gl.enableVertexAttribArray(i) : gl.disableVertexAttribArray(i));
          gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.uv); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        };
        // 1) opacos
        if (sc.iO.length) {
          useMesh();
          gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.iO);
          gl.drawElements(gl.TRIANGLES, sc.iO.length, gl.UNSIGNED_INT, 0);
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        // 2) líneas (curvas + caja + marcas)
        {
          const pr = g.line;
          gl.useProgram(pr.p);
          gl.uniformMatrix4fv(pr.u.uMVP, false, m);
          gl.uniform2f(pr.u.uRes, pw / 2, ph / 2);
          gl.uniform1f(pr.u.uDpr, dpr);
          gl.uniform3fv(pr.u.uHalf, half);
          for (let i = 0; i < 5; i++) gl.enableVertexAttribArray(i);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.lA); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.lB); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.lT); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.lC); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.lW); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);
          gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (sc.nSceneLines) gl.drawArrays(gl.TRIANGLES, 0, sc.nSceneLines * 6);
          if (sc.boxed) gl.drawArrays(gl.TRIANGLES, sc.edgeRanges[0][0], 12 * 6);
          for (const ax of axes) {
            if (!ax) continue;
            if (!sc.boxed) gl.drawArrays(gl.TRIANGLES, sc.edgeRanges[ax.i][0], 6);
            const tr = sc.tickRanges[ax.i][ax.variant];
            if (tr[1] && o.ticks !== false) gl.drawArrays(gl.TRIANGLES, tr[0], tr[1]);
          }
          gl.disable(gl.BLEND);
        }
        // 3) puntos
        if (sc.aPS.length) {
          const pr = g.pt;
          gl.useProgram(pr.p);
          gl.uniformMatrix4fv(pr.u.uMVP, false, m);
          gl.uniform1f(pr.u.uDpr, dpr);
          gl.uniform3fv(pr.u.uHalf, half);
          for (let i = 0; i < 5; i++) (i < 3 ? gl.enableVertexAttribArray(i) : gl.disableVertexAttribArray(i));
          gl.bindBuffer(gl.ARRAY_BUFFER, b.pP); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.pC); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.pS); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.POINTS, 0, sc.aPS.length);
        }
        // 4) transparentes, de atrás hacia delante
        if (sc.iT.length) {
          const nt = sc.order.length, bx = cam.b;
          const key = bx[0].toFixed(3) + bx[1].toFixed(3) + bx[2].toFixed(3);
          if (sc.sortDir !== key) {
            sc.sortDir = key;
            for (let t = 0; t < nt; t++) { sc.order[t] = t; sc.keys[t] = sc.tc[t * 3] * bx[0] + sc.tc[t * 3 + 1] * bx[1] + sc.tc[t * 3 + 2] * bx[2]; }
            const keys = sc.keys;
            sc.order.sort((i, j) => keys[i] - keys[j]);
            for (let t = 0; t < nt; t++) { const q = sc.order[t] * 3; sc.iTs[t * 3] = sc.iT[q]; sc.iTs[t * 3 + 1] = sc.iT[q + 1]; sc.iTs[t * 3 + 2] = sc.iT[q + 2]; }
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.iT);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sc.iTs, gl.DYNAMIC_DRAW);
          }
          useMesh();
          gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.iT);
          gl.drawElements(gl.TRIANGLES, sc.iTs.length, gl.UNSIGNED_INT, 0);
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
        gl.disable(gl.SCISSOR_TEST);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(g.canvas, 0, g.canvas.height - ph, pw, ph, 0, 0, pw, ph);
        drawn = true;
      } catch (e) {
        drawn = false;
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!drawn) this.paint(ctx, cam, P, axes);
    this.overlay(ctx, cam, P, axes);
  }

  /** Respaldo sin WebGL: algoritmo del pintor con sombreado plano. */
  paint(ctx, cam, P, axes) {
    const sc = this.scene, o = this.g.opts || {};
    ctx.fillStyle = o.bg || '#fff';
    ctx.fillRect(0, 0, this.W, this.H);
    const pos = sc.aPos, nrm = sc.aNrm, col = sc.aCol, uv = sc.aUv, h = sc.half;
    const nv = pos.length / 3;
    const X = new Float32Array(nv), Y = new Float32Array(nv), D = new Float32Array(nv);
    for (let i = 0; i < nv; i++) { const q = P([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); X[i] = q[0]; Y[i] = q[1]; D[i] = q[2]; }
    const items = [];
    const inBox = i => Math.abs(pos[i * 3]) <= h[0] * 1.01 + 0.003 && Math.abs(pos[i * 3 + 1]) <= h[1] * 1.01 + 0.003 && Math.abs(pos[i * 3 + 2]) <= h[2] * 1.01 + 0.003 && uv[i * 4 + 3] >= 0;
    const L = [[0.7071, 0, 0.7071, 0.30], [0.5774, 0.5774, 0.5774, 0.34], [0, 0.7071, 0.7071, 0.30]];
    const addTris = idx => {
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        if (!(inBox(a) && inBox(b) && inBox(c))) continue;
        let nx = nrm[a * 3] + nrm[b * 3] + nrm[c * 3], ny = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1], nz = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2];
        // a espacio de vista
        let vx = cam.r[0] * nx + cam.r[1] * ny + cam.r[2] * nz, vy = cam.u[0] * nx + cam.u[1] * ny + cam.u[2] * nz, vz = cam.b[0] * nx + cam.b[1] * ny + cam.b[2] * nz;
        const l = Math.hypot(vx, vy, vz) || 1; vx /= l; vy /= l; vz /= l;
        if (vz < 0) { vx = -vx; vy = -vy; vz = -vz; }
        let d = 0.42;
        for (const q of L) d += q[3] * Math.max(0, vx * q[0] + vy * q[1] + vz * q[2]);
        const f = Math.min(1.08, d);
        const cr = Math.min(255, col[a * 4] * f) | 0, cg = Math.min(255, col[a * 4 + 1] * f) | 0, cb = Math.min(255, col[a * 4 + 2] * f) | 0, al = col[a * 4 + 3] / 255;
        items.push({ z: (D[a] + D[b] + D[c]) / 3, k: 0, a, b, c, fill: al < 1 ? `rgba(${cr},${cg},${cb},${al})` : `rgb(${cr},${cg},${cb})`, op: al >= 1 });
      }
    };
    addTris(sc.iO); addTris(sc.iT);
    const lA = sc.aLA, lB = sc.aLB, lC = sc.aLC, lW = sc.aLW;
    const addSeg = (v0, cnt) => {
      for (let v = v0; v < v0 + cnt; v += 6) {
        const a = P([lA[v * 3], lA[v * 3 + 1], lA[v * 3 + 2]]), b = P([lB[v * 3], lB[v * 3 + 1], lB[v * 3 + 2]]);
        items.push({ z: (a[2] + b[2]) / 2 - 0.004, k: 1, p: a, q: b, stroke: `rgba(${lC[v * 4]},${lC[v * 4 + 1]},${lC[v * 4 + 2]},${lC[v * 4 + 3] / 255})`, w: lW[v] });
      }
    };
    addSeg(0, sc.nSceneLines * 6);
    if (sc.boxed) addSeg(sc.edgeRanges[0][0], 72);
    for (const ax of axes) { if (!ax) continue; if (!sc.boxed) addSeg(sc.edgeRanges[ax.i][0], 6); const tr = sc.tickRanges[ax.i][ax.variant]; addSeg(tr[0], tr[1]); }
    for (let i = 0; i < sc.aPS.length; i++) {
      const q = P([sc.aPP[i * 3], sc.aPP[i * 3 + 1], sc.aPP[i * 3 + 2]]);
      items.push({ z: q[2] - 0.004, k: 2, p: q, r: sc.aPS[i] / 2, fill: `rgb(${sc.aPC[i * 4]},${sc.aPC[i * 4 + 1]},${sc.aPC[i * 4 + 2]})` });
    }
    items.sort((p, q) => q.z - p.z);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const it of items) {
      if (it.k === 0) {
        ctx.beginPath(); ctx.moveTo(X[it.a], Y[it.a]); ctx.lineTo(X[it.b], Y[it.b]); ctx.lineTo(X[it.c], Y[it.c]); ctx.closePath();
        ctx.fillStyle = it.fill; ctx.fill();
        if (it.op) { ctx.strokeStyle = it.fill; ctx.lineWidth = 0.6; ctx.stroke(); }
      } else if (it.k === 1) {
        ctx.beginPath(); ctx.moveTo(it.p[0], it.p[1]); ctx.lineTo(it.q[0], it.q[1]); ctx.strokeStyle = it.stroke; ctx.lineWidth = it.w; ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(it.p[0], it.p[1], it.r, 0, 6.2832); ctx.fillStyle = it.fill; ctx.fill(); }
    }
  }

  overlay(ctx, cam, P, axes) {
    const sc = this.scene, o = this.g.opts || {};
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ctr = P([0, 0, 0]);
    const TF = 10.5;
    for (const ax of axes) {
      if (!ax) continue;
      const e = ax.e, tk = sc.ticks[e.a];
      // normal exterior en pantalla (perpendicular a la arista, alejándose del centro)
      let dx = ax.b[0] - ax.a[0], dy = ax.b[1] - ax.a[1];
      const l = Math.hypot(dx, dy);
      let nx, ny;
      if (l < 4) { nx = ax.mid[0] - ctr[0]; ny = ax.mid[1] - ctr[1]; const q = Math.hypot(nx, ny) || 1; nx /= q; ny /= q; } else {
        nx = -dy / l; ny = dx / l;
        if ((ax.mid[0] - ctr[0]) * nx + (ax.mid[1] - ctr[1]) * ny < 0) { nx = -nx; ny = -ny; }
      }
      ctx.font = `${TF}px ${FONT}`;
      ctx.fillStyle = '#3c3c3c';
      let maxExt = 0, lastPos = null;
      if (o.ticks !== false && l >= 4) {
        const labs = tk.major.map(v => { const q0 = e.p0.slice(); q0[e.a] = sc.N(e.a, v); return { p: P(q0), s: fmtTick(v, tk.step) }; });
        // evitar solapes: saltar etiquetas demasiado juntas
        for (const lb of labs) {
          const tw = ctx.measureText(lb.s).width, ext = Math.abs(nx) * tw / 2 + Math.abs(ny) * TF / 2 + 5;
          const x = lb.p[0] + nx * ext, y = lb.p[1] + ny * ext;
          if (lastPos && Math.abs(x - lastPos[0]) < (tw + lastPos[2]) / 2 + 3 && Math.abs(y - lastPos[1]) < TF + 1) continue;
          ctx.fillText(lb.s, x, y);
          lastPos = [x, y, tw];
          maxExt = Math.max(maxExt, Math.abs(nx) * tw + Math.abs(ny) * TF + 6);
        }
      }
      const lab = o.axesLabel && o.axesLabel[e.a];
      if (lab) {
        ctx.font = `12px ${FONT}`;
        ctx.fillStyle = '#222';
        const tw = ctx.measureText(lab).width, ext = maxExt + 5 + Math.abs(nx) * tw / 2 + Math.abs(ny) * 7;
        let x = ax.mid[0] + nx * ext, y = ax.mid[1] + ny * ext;
        x = Math.max(tw / 2 + 2, Math.min(this.W - tw / 2 - 2, x)); y = Math.max(8, Math.min(this.H - 8, y));
        ctx.fillText(lab, x, y);
      }
    }
    for (const t of sc.texts) {
      const q = P(t.p);
      ctx.font = `${t.size || 12}px ${FONT}`;
      ctx.fillStyle = t.color || '#000';
      ctx.fillText(t.text, q[0], q[1]);
    }
    if (o.plotLabel) {
      ctx.font = `13px ${FONT}`; ctx.fillStyle = '#333';
      ctx.fillText(String(o.plotLabel), this.W / 2, 12);
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    LIVE.delete(this);
    if (this.ro) this.ro.disconnect();
    cancelAnimationFrame(this._inert); cancelAnimationFrame(this._pending);
    this.freeGL();
    this.root.remove();
  }
}

export function renderGraphics3D(el, g) {
  const p = new Plot3D(el, g || { prims: [], opts: {} });
  return { destroy: () => p.destroy(), update: g2 => p.update(g2), el: p.root, getView: () => ({ ...p.view }), setView: v => { p.view = { ...p.view, ...v }; p.requestDraw(); } };
}
export function renderGraphics(el, g) { return renderGraphics3D(el, g); }
export default renderGraphics3D;
