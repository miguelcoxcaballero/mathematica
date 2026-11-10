// kernel-client.js — main-thread façade of the Wolfram Language kernel (SPEC §4).
// The kernel itself lives in a Web Worker (kernel-worker.js). This module gives:
//   · lazy, idempotent start() with Spanish loading phases + progress (kernel.status / kernel.progress / onStatus)
//   · a queue (one evaluation at a time), request/response by id
//   · abort(): kill the worker, reject everything pending with an AbortError, start a fresh kernel
//   · automatic restart if the worker crashes, retry when loading fails
//   · a watchdog: kernel.stuck becomes true when one evaluation runs for more than 45 s
//   · kernel.symbols(): Promise<string[]> with every System` symbol (cached in localStorage per engine version)
//   · kernel.defined: Set of Global` symbols that currently have a definition (updated after each evaluation)

const STUCK_MS = 45000;
const listeners = new Set();
const definedListeners = new Set();

let worker = null;
let startPromise = null;
let generation = 0;          // bumped every time the worker is killed
let seq = 0;
const pending = new Map();   // id → {resolve, reject, timer}
let queue = Promise.resolve();
let queued = 0;
let creep = null;
let cap = 0;
let symbolsPromise = null;
let retries = 0;

function abortError(msg) {
  const e = new Error(msg || 'Evaluación abortada');
  e.name = 'AbortError';
  return e;
}

function emit() {
  for (const cb of [...listeners]) {
    try { cb(kernel.status, kernel.progress); } catch (e) { console.error('[kernel] onStatus', e); }
  }
}

function setStatus(status, phase) {
  kernel.status = status;
  if (phase !== undefined) kernel.progress = { phase, pct: kernel.progress.pct };
  emit();
}

function stopCreep() { if (creep) { clearInterval(creep); creep = null; } }
function startCreep() {
  stopCreep();
  // Long silent stretches (compiling the wasm, loading 200 builtin modules) should not look frozen:
  // the bar creeps towards the cap announced by the worker.
  creep = setInterval(() => {
    const p = kernel.progress;
    if (kernel.status !== 'loading') return stopCreep();
    if (p.pct < cap - 0.002) { kernel.progress = { phase: p.phase, pct: p.pct + (cap - p.pct) * 0.04 }; emit(); }
  }, 250);
}

function onMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'progress') {
    if (kernel.status !== 'loading') return;
    cap = Math.max(m.cap || 0, m.pct || 0);
    kernel.progress = { phase: m.phase, pct: Math.max(m.pct || 0, m.phase === kernel.progress.phase ? kernel.progress.pct : 0) };
    emit();
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  if (kernel.stuck) { kernel.stuck = false; }
  if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Error del kernel'));
}

function send(op, args, watch) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const entry = { resolve, reject, timer: null };
    if (watch) entry.timer = setTimeout(() => { kernel.stuck = true; emit(); }, STUCK_MS);
    pending.set(id, entry);
    worker.postMessage({ id, op, args });
  });
}

function killWorker(reason) {
  generation++;
  stopCreep();
  if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; try { worker.terminate(); } catch { /* */ } }
  worker = null;
  startPromise = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(reason); }
  pending.clear();
  queue = Promise.resolve();
  queued = 0;
  kernel.stuck = false;
  setDefined([]);
}

function setDefined(list) {
  if (!Array.isArray(list)) return;
  const prev = kernel.defined;
  if (prev.size === list.length && list.every((n) => prev.has(n))) return;
  kernel.defined = new Set(list);
  for (const cb of [...definedListeners]) { try { cb(kernel.defined); } catch (e) { console.error(e); } }
}

function start() {
  if (startPromise) return startPromise;
  const gen = generation;
  kernel.error = null;
  kernel.progress = { phase: 'Descargando Python…', pct: 0 };
  cap = 0.05;
  setStatus('loading');
  startCreep();
  startPromise = new Promise((resolve, reject) => {
    try {
      worker = new Worker(new URL('./kernel-worker.js?v=1794351414', import.meta.url), { type: 'module' });
    } catch (e) { reject(e); return; }
    worker.onmessage = onMessage;
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || 'El kernel se ha detenido inesperadamente');
      if (e && e.preventDefault) e.preventDefault();
      if (gen !== generation) return;
      const wasLoading = kernel.status === 'loading';
      killWorker(err);
      if (wasLoading) reject(err);
      else { console.warn('[kernel] reinicio automático tras un fallo:', err.message); start().catch(() => {}); }
    };
    send('init', {}, false).then(resolve, reject);
  }).then((info) => {
    if (gen !== generation) throw abortError();
    stopCreep();
    retries = 0;
    kernel.info = info;
    kernel.progress = { phase: '', pct: 1 };
    setStatus(queued ? 'busy' : 'ready');
    return info;
  }, (err) => {
    if (gen !== generation) throw err;
    stopCreep();
    console.error('[kernel] no se pudo arrancar:', err);
    killWorker(err);
    if (retries < 1) { // one silent retry (flaky network while downloading ~20 MB)
      retries++;
      return new Promise((r) => setTimeout(r, 1200)).then(() => start());
    }
    retries = 0;
    if (/Failed to fetch|NetworkError|Load failed|HTTP \d+|importing a module script failed/i.test(String(err && err.message))) {
      const detail = String(err.message || '');
      err = new Error('No se pudo descargar el motor (¿sin conexión a internet?). Comprueba la conexión y vuelve a intentarlo.');
      err.detail = detail;
    }
    kernel.error = err;
    kernel.progress = { phase: /^No se pudo/.test(err.message) ? err.message : 'No se pudo cargar el kernel: ' + (err.message || err), pct: 0 };
    setStatus('error');
    throw err;
  });
  startPromise.catch(() => {});
  return startPromise;
}

// Run `op` after everything already queued; resolves/rejects with the worker's answer.
function call(op, args, watch = true) {
  const gen0 = generation;
  queued++;
  const job = queue.then(async () => {
    if (gen0 !== generation) throw abortError();
    await start();
    if (gen0 !== generation) throw abortError();
    if (kernel.status !== 'busy') setStatus('busy');
    const result = await send(op, args, watch);
    if (result && Array.isArray(result.defined)) { setDefined(result.defined); delete result.defined; }
    return result;
  });
  const settle = () => {
    if (gen0 !== generation) return;
    queued = Math.max(0, queued - 1);
    if (!queued && kernel.status === 'busy') setStatus('ready');
    else if (kernel.stuck === false) emit();
  };
  queue = job.then(settle, settle);
  return job;
}

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }

export const kernel = {
  status: 'idle',                       // 'idle'|'loading'|'ready'|'busy'|'error'
  progress: { phase: '', pct: 0 },      // while loading
  stuck: false,                         // true when the running evaluation exceeds 45 s (offer "Abortar")
  error: null,                          // last start-up error
  info: null,                           // {version, pyodide, bundled} once ready
  defined: new Set(),                   // Global` symbols with a definition

  onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  onDefined(cb) { definedListeners.add(cb); return () => definedListeners.delete(cb); },

  start() {
    if (kernel.status === 'error') { startPromise = null; }
    return start();
  },
  run(code) { return call('run', { code: String(code ?? '') }); },
  check(spec) { return call('check', { spec }); },
  manipulate(id, values) { return call('manipulate', { id, values }, false); },
  reset() { return call('reset', {}, false).then(() => undefined); },

  // Kill the worker (the only way to stop a running Python computation) and boot a fresh kernel.
  abort() {
    killWorker(abortError('Evaluación abortada: el kernel se ha reiniciado'));
    retries = 0;
    return start().then(() => undefined);
  },

  // Never starts the kernel by itself when a cached list exists (it is only used for colouring/autocomplete).
  symbols() {
    const cached = lsGet('wolframlab-symbols');
    if (cached && Array.isArray(cached.names) && cached.names.length > 500 && !(kernel.info && kernel.info.version !== cached.v)) {
      return Promise.resolve(cached.names);
    }
    if (!symbolsPromise) {
      symbolsPromise = call('symbols', {}, false).then((names) => {
        lsSet('wolframlab-symbols', { v: kernel.info && kernel.info.version, names });
        symbolsPromise = null;
        return names;
      }, (e) => { symbolsPromise = null; throw e; });
    }
    return symbolsPromise;
  },
};

export default kernel;
