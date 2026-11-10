# -*- coding: utf-8 -*-
"""Browser bootstrap for the WolframLab kernel (owner: NOTEBOOK agent).

Mathics3 imports a few heavy third-party packages at import time although nothing we use needs them
(scipy = 14 MB download, pillow, requests + 4 deps). In the browser those packages are NOT downloaded;
this module installs featherweight stand-ins so that `import scipy`, `import PIL.Image`,
`import requests` succeed, and tells Mathics3 that the optional features built on them are missing
(FindRoot/FindMinimum then use Mathics3's own Newton methods). The two things Mathics3 really takes from
scipy are re-implemented here in a few lines so results match a CPython+scipy install:
  * scipy.integrate.quad / nquad  → adaptive Gauss–Kronrod (G7,K15), used by NIntegrate;
  * scipy.special.<fn>            → mpmath equivalents, used by lambdified numeric functions.

    import wlboot; wlboot.install()            # browser (kernel-worker.js does this)
    import wlboot; wlboot.install(force=True)  # CPython: simulate the browser even if scipy & co. exist

Call it BEFORE importing mathics / wlkernel.
"""
import importlib.abc
import importlib.machinery
import sys
import types

STUBBED = ("scipy", "PIL", "requests")
_installed = False


class _Stub:
    """Placeholder for anything inside a stubbed package: attribute access gives another stub,
    subclassing works (the base silently disappears), calling raises ImportError."""

    def __init__(self, name="stub", *args, **kwargs):
        self.__dict__["_n"] = name if isinstance(name, str) else "stub"

    def __getattr__(self, key):
        if key.startswith("__") and key.endswith("__"):
            raise AttributeError(key)
        return _Stub(self._n + "." + key)

    def __call__(self, *args, **kwargs):
        raise ImportError("%s no está disponible en el navegador" % self._n)

    def __mro_entries__(self, bases):
        return (object,)

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False

    def __repr__(self):
        return "<stub %s>" % self._n


class _StubModule(types.ModuleType):
    __version__ = "0 (stub)"

    def __getattr__(self, key):
        if key.startswith("__") and key.endswith("__"):
            raise AttributeError(key)
        return _Stub(self.__name__ + "." + key)


# ----------------------------------------------------------------------------- mini scipy.integrate
_XGK = (0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
        0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
        0.586087235467691130294144838258730, 0.405845151377397166906606412076961,
        0.207784955007898467600689403773245, 0.0)
_WGK = (0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
        0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
        0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
        0.204432940075298892414161999234649, 0.209482141084727828012999174891714)
_WG = (0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
       0.381830050505118944950369775488975, 0.417959183673469387755102040816327)


def _gk15(f, a, b):
    c, h = 0.5 * (a + b), 0.5 * (b - a)
    fc = f(c)
    rk, rg = _WGK[7] * fc, _WG[3] * fc
    vals = [(_WGK[7], fc)]
    for j in range(7):
        d = h * _XGK[j]
        f1, f2 = f(c - d), f(c + d)
        rk += _WGK[j] * (f1 + f2)
        if j % 2:
            rg += _WG[j // 2] * (f1 + f2)
        vals.append((_WGK[j], f1))
        vals.append((_WGK[j], f2))
    # QUADPACK's error heuristic: scale the raw |K15 - G7| by how smooth the integrand looks.
    mean = 0.5 * rk
    resasc = abs(h) * sum(w * abs(v - mean) for w, v in vals)
    err = abs((rk - rg) * h)
    if resasc != 0.0 and err != 0.0:
        err = resasc * min(1.0, (200.0 * err / resasc) ** 1.5)
    return rk * h, err


def quad(func, a, b, args=(), full_output=0, epsabs=1.49e-8, epsrel=1.49e-8, limit=50, _strict=True, **_ignored):
    """Globally adaptive G7-K15 quadrature (same idea as QUADPACK's QAG). Returns (value, abserr[, info]).
    QUADPACK's QAGS usually lands far below the requested tolerance thanks to extrapolation; to give the
    same 15-digit answers on smooth integrands (and ~1e-10 on endpoint singularities) we simply aim lower."""
    import heapq
    import math

    def f(x):
        try:
            y = func(x, *args)
            y = complex(y)
            if y.imag == 0.0:
                y = y.real
                return y if math.isfinite(y) else 0.0
            return y if (math.isfinite(y.real) and math.isfinite(y.imag)) else 0.0
        except (ZeroDivisionError, OverflowError, ValueError):
            return 0.0

    a, b = float(a), float(b)
    sign = 1.0
    if b < a:
        a, b, sign = b, a, -1.0
    limit = max(int(limit), 50)
    if _strict:
        epsabs, epsrel, limit = min(epsabs, 1e-10), min(epsrel, 1e-10), max(limit, 300)
    value, err = _gk15(f, a, b)
    heap = [(-err, a, b, value)]
    total, toterr, n = value, err, 1
    while toterr > max(epsabs, epsrel * abs(total)) and n < limit and heap:
        _, lo, hi, old = heapq.heappop(heap)
        mid = 0.5 * (lo + hi)
        if not (lo < mid < hi):
            break
        v1, e1 = _gk15(f, lo, mid)
        v2, e2 = _gk15(f, mid, hi)
        heapq.heappush(heap, (-e1, lo, mid, v1))
        heapq.heappush(heap, (-e2, mid, hi, v2))
        n += 1
        total = math.fsum(x[3].real for x in heap) + 1j * math.fsum(x[3].imag for x in heap)
        if total.imag == 0.0:
            total = total.real
        toterr = math.fsum(-x[0] for x in heap)
    total = sign * total
    if full_output:
        return total, toterr, {"neval": 15 * (2 * n - 1), "last": n}
    return total, toterr


def nquad(func, ranges, args=None, opts=None, full_output=False):
    """Iterated quad over a box: func(x0, …, xn) integrated over ranges [[a0,b0], …]."""
    ranges = [tuple(r) for r in ranges]
    depth = len(ranges)
    tol = 1e-8 if depth == 1 else (1e-6 if depth == 2 else 1e-4)

    def level(i, tail):
        lo, hi = ranges[i]
        if i == 0:
            return quad(lambda x: func(x, *tail), lo, hi, epsabs=tol, epsrel=tol, limit=60, _strict=False)
        return quad(lambda x: level(i - 1, (x,) + tail)[0], lo, hi, epsabs=tol, epsrel=tol, limit=40, _strict=False)

    value, err = level(depth - 1, ())
    if full_output:
        return value, err, {"neval": 0}
    return value, err


def _special_namespace():
    """scipy.special names → mpmath implementations (scalars; numpy arrays element-wise)."""
    import mpmath as mp

    def wrap(fn):
        def scalar(*a):
            r = fn(*a)
            try:
                return float(r)
            except TypeError:
                return complex(r)

        def call(*a):
            if any(hasattr(x, "shape") and getattr(x, "shape", ()) != () for x in a):
                import numpy

                return numpy.vectorize(scalar)(*a)
            return scalar(*a)

        return call

    table = {
        "erf": mp.erf, "erfc": mp.erfc, "erfi": mp.erfi, "erfinv": mp.erfinv, "gamma": mp.gamma,
        "gammaln": mp.loggamma, "loggamma": mp.loggamma, "beta": mp.beta, "digamma": mp.digamma,
        "psi": mp.digamma, "polygamma": mp.polygamma, "zeta": mp.zeta, "factorial": mp.factorial,
        "factorial2": mp.fac2, "binom": mp.binomial, "jv": mp.besselj, "jn": mp.besselj, "yv": mp.bessely,
        "yn": mp.bessely, "iv": mp.besseli, "kv": mp.besselk, "hankel1": mp.hankel1, "hankel2": mp.hankel2,
        "hyp1f1": mp.hyp1f1, "hyp2f1": mp.hyp2f1, "hyp0f1": mp.hyp0f1, "expi": mp.ei, "exp1": mp.e1,
        "expn": mp.expint, "lambertw": mp.lambertw, "ellipk": mp.ellipk, "ellipe": mp.ellipe,
        "legendre": None, "gammainc": lambda a, x: mp.gammainc(a, 0, x, regularized=True),
        "gammaincc": lambda a, x: mp.gammainc(a, x, regularized=True),
        "eval_legendre": mp.legendre, "eval_chebyt": mp.chebyt, "eval_chebyu": mp.chebyu,
        "eval_hermite": mp.hermite, "eval_laguerre": mp.laguerre,
        "sici": None, "fresnel": None, "airy": None,
    }
    ns = {k: wrap(v) for k, v in table.items() if v is not None}
    ns["sici"] = lambda x: (float(mp.si(x)), float(mp.ci(x)))
    ns["fresnel"] = lambda x: (float(mp.fresnels(x)), float(mp.fresnelc(x)))
    ns["airy"] = lambda x: (float(mp.airyai(x)), float(mp.airyai(x, derivative=1)),
                            float(mp.airybi(x)), float(mp.airybi(x, derivative=1)))
    return ns


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, names):
        self.names = set(names)

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in self.names:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        mod = _StubModule(spec.name)
        mod.__path__ = []
        return mod

    def exec_module(self, module):
        if module.__name__ == "scipy.integrate":
            module.quad, module.nquad = quad, nquad
            module.__all__ = ["quad", "nquad"]
        elif module.__name__ == "scipy.special":
            ns = _special_namespace()
            module.__dict__.update(ns)
            module.__all__ = sorted(ns)
        elif module.__name__ == "scipy":
            module.__all__ = []


def _really_installed(name):
    for finder in sys.meta_path:
        if isinstance(finder, _StubFinder):
            continue
        try:
            if finder.find_spec(name, None) is not None:
                return True
        except Exception:
            pass
    return False


def install(force=False):
    """Install the stand-ins. Returns the tuple of package names that are stubbed."""
    global _installed
    names = tuple(n for n in STUBBED if force or not _really_installed(n))
    if _installed or not names:
        return names
    _installed = True
    for n in list(sys.modules):
        if n.split(".")[0] in names:
            del sys.modules[n]
    finder = _StubFinder(names)
    if force:
        sys.meta_path.insert(0, finder)
    else:
        sys.meta_path.append(finder)

    # Mathics3 decides whether an optional builtin is available with importlib.util.find_spec();
    # make the stubbed packages count as "not installed".
    import mathics.core.builtin as mcb

    original = mcb.check_requires_list

    def check_requires_list(requires):
        for package in requires:
            if package.split(".")[0] in names:
                # …except for the NIntegrate glue, which our mini scipy.integrate serves.
                caller = sys._getframe(1).f_globals.get("__name__", "")
                if package == "scipy" and caller == "mathics.builtin.scipy_utils.integrators":
                    continue
                return False
        return original(requires)

    mcb.check_requires_list = check_requires_list
    return names
