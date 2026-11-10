# -*- coding: utf-8 -*-
"""NIntegrate and FindRoot re-implemented (owner: ENGINE).

Mathics' versions evaluate the integrand through the interpreter point by point (seconds per integral),
cannot do iterated integrals with variable limits, systems in FindRoot or WorkingPrecision, and never warn
about divergence. Here the expression is compiled once (SymPy -> numpy / mpmath) and integrated with an
adaptive Gauss-Kronrod rule; anything that cannot be compiled falls back to point evaluation by the kernel.
"""
import math

import sympy as sp
from mathics.core.atoms import Integer, Real, String, Complex as MComplex
from mathics.core.attributes import A_HOLD_ALL, A_PROTECTED
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolFalse, SymbolTrue

from . import ext
from .conv import Conv, ConvError, S
from .ext import E, L, Rule, XB, SympyTimeout, budget, pyval, _dbg, NUMPY_EXTRA

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
_NODES = None


def _nodes():
    global _NODES
    if _NODES is None:
        import numpy as np

        x = np.array([-v for v in _XGK[:7]] + [0.0] + list(reversed(_XGK[:7])))
        wk = np.array(list(_WGK[:7]) + [_WGK[7]] + list(reversed(_WGK[:7])))
        wg = np.zeros(15)
        # Gauss nodes are the odd-indexed Kronrod nodes (1,3,5,7,9,11,13)
        g = [_WG[0], _WG[1], _WG[2], _WG[3], _WG[2], _WG[1], _WG[0]]
        for i, w in zip(range(1, 15, 2), g):
            wg[i] = w
        _NODES = (x, wk, wg)
    return _NODES


class NotConverged(Exception):
    def __init__(self, value, err):
        self.value, self.err = value, err


def gk_adaptive(f, a, b, rtol=1e-9, atol=1e-13, limit=120):
    """Adaptive G7-K15 on [a, b] for a vectorised f (numpy array -> array). Returns (value, error, ok)."""
    import heapq

    import numpy as np

    x, wk, wg = _nodes()

    def rule(lo, hi):
        c, h = 0.5 * (lo + hi), 0.5 * (hi - lo)
        y = f(c + h * x)
        y = np.where(np.isfinite(y), y, 0.0)
        k = h * np.sum(wk * y)
        g = h * np.sum(wg * y)
        return k, abs(k - g)

    if a == b:
        return 0.0, 0.0, True
    total, err = rule(a, b)
    heap = [(-err, a, b, total)]
    n = 1
    tot_err = err
    while tot_err > max(atol, rtol * abs(total)) and n < limit:
        e, lo, hi, val = heapq.heappop(heap)
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            heapq.heappush(heap, (0.0, lo, hi, val))
            break
        v1, e1 = rule(lo, mid)
        v2, e2 = rule(mid, hi)
        total += v1 + v2 - val
        tot_err += e1 + e2 + e
        heapq.heappush(heap, (-e1, lo, mid, v1))
        heapq.heappush(heap, (-e2, mid, hi, v2))
        n += 1
        if n % 16 == 0:
            total = sum(h_[3] for h_ in heap)
            tot_err = sum(-h_[0] for h_ in heap)
    ok = tot_err <= max(atol, rtol * abs(total)) * 10 or tot_err <= 1e-10 * (1 + abs(total))
    return total, tot_err, ok


def _transform(f, a, b):
    """Map an (semi-)infinite range to a finite one: returns (g, lo, hi)."""
    import numpy as np

    inf = float("inf")
    if a == -inf and b == inf:
        def g(t):
            with np.errstate(all="ignore"):
                x = t / (1 - t * t)
                return f(x) * (1 + t * t) / (1 - t * t) ** 2
        return g, -1.0, 1.0
    if b == inf:
        def g(t):
            with np.errstate(all="ignore"):
                x = a + t / (1 - t)
                return f(x) / (1 - t) ** 2
        return g, 0.0, 1.0
    if a == -inf:
        def g(t):
            with np.errstate(all="ignore"):
                x = b - t / (1 - t)
                return f(x) / (1 - t) ** 2
        return g, 0.0, 1.0
    return f, a, b


def oscillatory_tail(f, a, direction, rtol=1e-9, kmax=17):
    """Integral of f from a to +inf (direction=1) or from -inf to a (direction=-1) by summing doubling blocks
    [R_k, R_{k+1}] with composite G7-K15 panels of width <= 1: robust for oscillatory, algebraically decaying
    integrands where the variable-change rule fails. Returns (value, error, ok)."""
    import numpy as np

    x, wk, wg = _nodes()
    total = 0.0
    last = []
    lo = 0.0
    width = 1.0
    for k in range(kmax + 1):
        hi = lo + width
        m = int(max(2, math.ceil(width * 1.5)))
        edges = np.linspace(lo, hi, m + 1)
        c = 0.5 * (edges[:-1] + edges[1:])
        h = 0.5 * (edges[1:] - edges[:-1])
        pts = c[:, None] + h[:, None] * x[None, :]
        y = f(a + direction * pts)
        y = np.where(np.isfinite(y), y, 0.0)
        contrib = np.sum(h[:, None] * wk[None, :] * y)
        total += contrib
        last.append(abs(contrib))
        scale = 1.0 + abs(total)
        if len(last) >= 3 and max(last[-2:]) < rtol * scale:
            return total, max(last[-2:]), True
        lo = hi
        width *= 2.0
        ext._tick_check()
    err = last[-1]
    return total, err, err < 1e-6 * (1.0 + abs(total))


def integrate_1d(f, a, b, points=(), rtol=1e-9, limit=120, oscillatory=False):
    """f vectorised; a, b floats or +-inf; points = interior break points. -> (value, err, ok)"""
    sign = 1.0
    if a > b:
        a, b, sign = b, a, -1.0
    pts = sorted(p for p in points if a < p < b)
    bounds = [a] + pts + [b]
    total, err, ok = 0.0, 0.0, True
    inf = float("inf")
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        if oscillatory and (lo == -inf or hi == inf):
            v = e = 0.0
            o = True
            mid = lo if lo != -inf else (hi if hi != inf else 0.0)
            if hi == inf:
                v1, e1, o1 = oscillatory_tail(f, mid, 1.0, rtol=rtol)
                v, e, o = v + v1, e + e1, o and o1
            else:
                v1, e1, o1 = gk_adaptive(f, mid, hi, rtol=rtol, limit=limit)
                v, e, o = v + v1, e + e1, o and o1
            if lo == -inf:
                v1, e1, o1 = oscillatory_tail(f, mid, -1.0, rtol=rtol)
                v, e, o = v + v1, e + e1, o and o1
            total += v
            err += e
            ok = ok and o
            continue
        g, l2, h2 = _transform(f, lo, hi)
        v, e, o = gk_adaptive(g, l2, h2, rtol=rtol, limit=limit)
        total += v
        err += e
        ok = ok and o
    return sign * total, err, ok


# -------------------------------------------------------------- compiling
def compile_numpy(expr, syms):
    """sympy expr -> function of numpy arrays (broadcasting); complex-safe."""
    import numpy as np

    fn = sp.lambdify(list(syms), expr, modules=[NUMPY_EXTRA, "numpy"])

    def call(*args):
        with np.errstate(all="ignore"):
            r = fn(*args)
        if np.isscalar(r) or getattr(r, "shape", None) == ():
            shape = np.broadcast(*args).shape if args else ()
            r = np.full(shape, r, dtype=complex if isinstance(r, complex) or np.iscomplexobj(r) else float)
        return r
    return call


def needs_complex(expr):
    return expr.has(sp.I)


class Compiled:
    """Numeric version of a Mathics expression in some variables: fast (numpy) when it converts to SymPy,
    otherwise evaluated by the kernel point by point."""

    def __init__(self, expr, vars, ev):
        self.expr, self.vars, self.ev = expr, vars, ev
        self.fast = None
        self.sym = None
        self.complex = False
        try:
            c = Conv(real=[v.get_name() for v in vars])
            s = c.to(expr)
            syms = [c.sym(v.get_name()) for v in vars]
            if isinstance(s, sp.Basic) and not (s.free_symbols - set(syms)) and \
                    not s.atoms(sp.core.function.AppliedUndef) and not s.has(sp.Derivative, sp.Integral, sp.Subs):
                self.sym = s
                self.syms = syms
                self.complex = needs_complex(s)
                self.fast = compile_numpy(s, syms)
                # smoke test
                import numpy as np

                self.fast(*[np.array([0.37, 0.61]) for _ in vars])
        except Exception:
            self.fast = None

    def __call__(self, *args):
        """args: numpy arrays (same shape) -> numpy array."""
        import numpy as np

        if self.fast is not None:
            if self.complex:
                r = self.fast(*[np.asarray(a, dtype=complex) for a in args])
                return r
            r = self.fast(*args)
            if np.iscomplexobj(r):
                return r
            if not np.all(np.isfinite(r)):
                # sqrt/log of negatives etc.: retry in the complex plane
                rc = self.fast(*[np.asarray(a, dtype=complex) for a in args])
                if np.any(np.abs(np.imag(rc)) > 0):
                    self.complex = True
                    return rc
            return r
        arrs = np.broadcast_arrays(*[np.asarray(a) for a in args])
        out = np.empty(arrs[0].shape, dtype=complex)
        it = np.nditer(arrs[0], flags=["multi_index"])
        cplx = False
        while not it.finished:
            idx = it.multi_index
            rules = L(*[Rule(v, Real(float(np.real(arr[idx])))) for v, arr in zip(self.vars, arrs)])
            val = pyval(E("ReplaceAll", self.expr, rules), self.ev)
            if val is None:
                val = float("nan")
            if isinstance(val, complex):
                cplx = True
            out[idx] = val
            it.iternext()
        return out if cplx else out.real


def _f(v):
    if v == sp.oo:
        return float("inf")
    if v == -sp.oo:
        return float("-inf")
    return float(v)


class NIntegrate(XB):
    attributes = A_HOLD_ALL | A_PROTECTED
    options = {"Method": "Automatic", "WorkingPrecision": "MachinePrecision", "PrecisionGoal": "Automatic",
               "AccuracyGoal": "Automatic", "MaxRecursion": "Automatic", "MinRecursion": "0",
               "Exclusions": "None", "MaxPoints": "Automatic", "Tolerance": "Automatic", "EvaluationMonitor": "None"}
    messages = {
        "ncvb": "NIntegrate failed to converge to prescribed accuracy after 9 recursive bisections in `1` near "
                "`2`. NIntegrate obtained `3` and `4` for the integral and error estimates.",
        "slwcon": "Numerical integration converging too slowly; suspect one of the following: singularity, value "
                  "of the integration is 0, highly oscillatory integrand, or WorkingPrecision too small.",
        "inumr": "The integrand `1` has evaluated to non-numerical values for all sampling points in the region "
                 "with boundaries `2`.",
    }
    summary_text = "numerical integration"

    def eval(self, f, specs, evaluation, options):
        "NIntegrate[f_, specs__List, OptionsPattern[NIntegrate]]"
        specs = specs.get_sequence()
        try:
            return self._go(f, list(specs), evaluation, options)
        except NotConverged:
            return None
        except Exception:
            _dbg()
            return None

    def _go(self, f, specs, ev, options):
        import numpy as np

        vars_ = []
        for sp_ in specs:
            if not sp_.has_form("List", 3, None) or not isinstance(sp_.elements[0], Symbol):
                return None
            vars_.append(sp_.elements[0])
        # evaluate integrand and limits with the variables cleared (NIntegrate has HoldAll)
        blk = L(*vars_)
        fe = E("Block", blk, f).evaluate(ev)
        if fe.has_form("List", None):
            parts = [self._go(q, specs, ev, options) for q in fe.elements]
            if any(p is None for p in parts):
                return None
            return L(*parts)
        if fe.get_head_name() == "System`Times":
            # symbolic constant factors (k, rho ...) come out of the integral, as Integrate would do
            from .conv import is_free_of

            names = [v.get_name() for v in vars_]
            free = [q for q in fe.elements if all(is_free_of(q, nm) for nm in names)
                    and E("NumericQ", q).evaluate(ev) is not SymbolTrue]
            if free:
                rest = [q for q in fe.elements if not any(q is r_ for r_ in free)]
                inner = self._go(E("Times", *rest) if rest else Integer(1), specs, ev, options)
                if inner is None:
                    return None
                return E("Times", inner, *free).evaluate(ev)
        lims = []
        for sp_ in specs:
            els = [E("Block", blk, q).evaluate(ev) for q in sp_.elements[1:]]
            lims.append(els)
        wp = options.get("System`WorkingPrecision")
        dps = None
        if wp is not None and wp.get_name() != "System`MachinePrecision":
            v = pyval(wp, ev)
            if v is not None and not isinstance(v, complex) and v > 16:
                dps = int(v)
        n = len(vars_)
        comp = Compiled(fe, vars_, ev)
        if dps is not None and n == 1 and comp.sym is not None:
            return self._high_precision(comp, lims[0], dps, ev)
        # limits as compiled functions of the outer variables
        lim_fns = []
        for k, els in enumerate(lims):
            fns = []
            for q in els:
                cq = Compiled(q, vars_[:k], ev) if k > 0 else None
                if k == 0:
                    v = pyval(q, ev)
                    if v is None or isinstance(v, complex):
                        iv = E("N", q).evaluate(ev)
                        nm = iv.get_head_name()
                        if nm == "System`DirectedInfinity" and iv.elements:
                            s_ = pyval(iv.elements[0], ev)
                            v = float("inf") if s_ and s_ > 0 else float("-inf")
                        else:
                            return None
                    fns.append(v)
                else:
                    fns.append(cq)
            lim_fns.append(fns)
        state = {"ok": True, "err": 0.0, "nan": 0, "count": 0}
        # switching surfaces of Boole/If/Piecewise/UnitStep/Abs integrands: for every level, polynomials in that
        # level's variable whose real roots (given the outer variables) are break points of the integrand
        kinks = [[] for _ in range(n)]
        if n > 1 and comp.sym is not None:
            try:
                from . import calc

                bexprs = set()
                for h in comp.sym.atoms(sp.Heaviside, sp.Abs, sp.sign):
                    bexprs.add(h.args[0])
                for pw in comp.sym.atoms(sp.Piecewise):
                    for _, cond in pw.args:
                        if cond in (sp.true, sp.false):
                            continue
                        for rel in cond.atoms(sp.core.relational.Relational):
                            bexprs.add(rel.lhs - rel.rhs)
                for g in bexprs:
                    for lev in range(n):
                        v = comp.syms[lev]
                        if not g.has(v) or (g.free_symbols - set(comp.syms[:lev + 1])):
                            continue
                        try:
                            pl = sp.Poly(g, v)
                        except Exception:
                            continue
                        if pl.degree() < 1 or pl.degree() > 6:
                            continue
                        cf = sp.lambdify(comp.syms[:lev], pl.all_coeffs(), modules=[NUMPY_EXTRA, "numpy"])
                        kinks[lev].append(cf)
            except Exception:
                kinks = [[] for _ in range(n)]

        def kink_points(level, outer, a, b):
            pts = []
            for cf in kinks[level]:
                try:
                    co = np.array([complex(q) for q in cf(*outer)])
                    while len(co) > 1 and co[0] == 0:
                        co = co[1:]
                    if len(co) < 2:
                        continue
                    for r in np.roots(co):
                        if abs(r.imag) < 1e-9 * (1 + abs(r.real)) and a < r.real < b:
                            pts.append(float(r.real))
                except Exception:
                    continue
            return pts
        rt = [1e-9, 1e-7, 1e-6, 1e-5][min(n - 1, 3)]
        limit = [140, 40, 14, 8][min(n - 1, 3)]

        def brk(level, outer):
            """break points of the integrand in variable `level` (only for the 1-D, compiled case)."""
            if n == 1 and comp.sym is not None:
                try:
                    from . import calc

                    lo, hi = lim_fns[0][0], lim_fns[0][-1]
                    if abs(lo) != float("inf") and abs(hi) != float("inf") and calc.has_piecewise(comp.sym, comp.syms[0]):
                        pts = calc._breakpoints(comp.sym, comp.syms[0], min(lo, hi), max(lo, hi))
                        return [float(sp.N(p)) for p in (pts or [])]
                except Exception:
                    pass
            return []

        def level_integral(level, outer):
            """integral over variables level..n-1 with outer variables fixed (floats)."""
            if level == 0:
                bounds = lim_fns[0]
            else:
                bounds = []
                for cq in lim_fns[level]:
                    val = cq(*[np.array([o]) for o in outer])
                    bounds.append(float(np.real(np.ravel(val)[0])))
            a, b = bounds[0], bounds[-1]
            inner_pts = [p for p in bounds[1:-1]] + (brk(level, outer) if level == 0 else [])
            if kinks[level] and a == a and b == b and abs(a) != float("inf") and abs(b) != float("inf"):
                inner_pts = inner_pts + kink_points(level, outer, min(a, b), max(a, b))
            if a != a or b != b:
                return 0.0
            if level == n - 1:
                def fv(xv):
                    args = [np.full(xv.shape, o) for o in outer] + [xv]
                    y = comp(*args)
                    state["count"] += xv.size
                    return y
            else:
                def fv(xv):
                    out = np.empty(xv.shape, dtype=complex)
                    for i, xi in enumerate(np.ravel(xv)):
                        out[i] = level_integral(level + 1, outer + [float(xi)])
                    return out if np.any(np.abs(out.imag) > 0) else out.real
            osc = comp.sym is not None and (comp.sym.has(sp.sin, sp.cos) or comp.sym.has(sp.I)) and \
                (abs(a) == float("inf") or abs(b) == float("inf"))
            v, e, ok = integrate_1d(fv, a, b, points=inner_pts, rtol=rt * (0.1 if level == n - 1 and n > 1 else 1.0),
                                    limit=limit, oscillatory=osc)
            if level == 0:
                state["err"] = e
                state["ok"] = ok
            ext._tick_check()
            return v

        with budget(20.0):
            val = level_integral(0, [])
        val = complex(val)
        if val != val:
            return None
        if not state["ok"]:
            # second opinion with tanh-sinh (endpoint singularities) for 1-D compiled integrands
            better = None
            if n == 1 and comp.sym is not None:
                better = self._tanh_sinh(comp, lim_fns[0])
            if better is not None:
                val = better
            else:
                ev.message("NIntegrate", "slwcon")
                ev.message("NIntegrate", "ncvb", vars_[0], vars_[0], _num(val), Real(float(state["err"])))
        return _num(val)

    @staticmethod
    def _tanh_sinh(comp, bounds):
        import mpmath

        try:
            f = sp.lambdify(comp.syms[0], comp.sym, modules=["mpmath"])
            a, b = bounds[0], bounds[-1]
            ma = mpmath.mpf("-inf") if a == float("-inf") else mpmath.mpf(a)
            mb = mpmath.mpf("inf") if b == float("inf") else mpmath.mpf(b)
            pts = [ma] + [mpmath.mpf(p) for p in bounds[1:-1]] + [mb]
            with budget(4.0):
                v, err = mpmath.quad(f, pts, error=True)
            v = complex(v)
            if v != v or abs(v) == float("inf") or float(err) > 1e-6 * (1 + abs(v)):
                return None
            return v
        except Exception:
            return None

    @staticmethod
    def _high_precision(comp, lims, dps, ev):
        import mpmath

        c = Conv()
        f = sp.lambdify(comp.syms[0], comp.sym, modules=["mpmath"])
        old = mpmath.mp.dps
        try:
            mpmath.mp.dps = dps + 5
            pts = []
            for q in lims:
                s_ = c.to(q)
                pts.append(mpmath.mpf("inf") if s_ == sp.oo else mpmath.mpf("-inf") if s_ == -sp.oo else
                           mpmath.mpmathify(sp.N(s_, dps + 5)))
            with budget(15.0):
                v = mpmath.quad(f, pts)
            return hp_number(v, dps)
        finally:
            mpmath.mp.dps = old


def hp_number(v, dps):
    """mpmath number -> Mathics number with dps significant digits."""
    import mpmath
    from mathics.core.atoms import PrecisionReal

    def one(x):
        return PrecisionReal(sp.Float(mpmath.nstr(x, dps + 2, strip_zeros=False), dps))
    if isinstance(v, mpmath.mpc) and abs(v.imag) > mpmath.mpf(10) ** (-dps) * (1 + abs(v.real)):
        return MComplex(one(v.real), one(v.imag))
    return one(v.real if isinstance(v, mpmath.mpc) else v)


def _num(v):
    if isinstance(v, complex):
        if abs(v.imag) <= 1e-14 * (1 + abs(v.real)):
            return Real(v.real)
        re_ = 0.0 if abs(v.real) <= 1e-14 * abs(v.imag) else v.real
        return MComplex(Real(re_), Real(v.imag))
    return Real(float(v))


# ---------------------------------------------------------------- FindRoot
class FindRoot(XB):
    attributes = A_HOLD_ALL | A_PROTECTED
    options = {"WorkingPrecision": "MachinePrecision", "MaxIterations": "100", "Method": "Automatic",
               "AccuracyGoal": "Automatic", "PrecisionGoal": "Automatic", "DampingFactor": "1", "Jacobian": "Automatic",
               "StepMonitor": "None", "EvaluationMonitor": "None"}
    messages = {
        "cvmit": "Failed to converge to the requested accuracy or precision within `1` iterations.",
        "lstol": "The line search decreased the step size to within tolerance specified by AccuracyGoal and "
                 "PrecisionGoal but was unable to find a sufficient decrease in the merit function.",
        "nveq": "The number of equations does not match the number of variables in `1`.",
        "snum": "Value `1` in search specification `2` is not a number or array of numbers.",
        "jsing": "Encountered a singular Jacobian at the point `1`. Try perturbing the initial point(s).",
    }
    summary_text = "find a numerical root"

    def eval(self, f, specs, evaluation, options):
        "FindRoot[f_, specs__List, OptionsPattern[FindRoot]]"
        specs = [s_.evaluate(evaluation) if not s_.has_form("List", None) else s_ for s_ in specs.get_sequence()]
        try:
            return self._go(f, specs, evaluation, options)
        except Exception:
            _dbg()
            return None

    def _go(self, f, specs, ev, options):
        import mpmath

        # {{x, x0}, {y, y0}}  or  {x, x0}, {y, y0}  or  {x, x0[, x1[, xmin, xmax]]}
        var_specs = []
        for s_ in specs:
            s_ = E("List", *[q for q in s_.elements])
            if s_.elements and all(q.has_form("List", None) for q in s_.elements):
                var_specs.extend(list(s_.elements))
            else:
                var_specs.append(s_)
        vars_, starts, second = [], [], []
        for vs in var_specs:
            els = vs.elements
            if len(els) < 2 or not isinstance(els[0], Symbol):
                return None
            vars_.append(els[0])
            v0 = pyval(E("N", els[1]), ev)
            if v0 is None:
                ev.message("FindRoot", "snum", els[1], vs)
                return None
            starts.append(v0)
            v1 = None
            if len(els) == 3:
                v1 = pyval(E("N", els[2]), ev)
            second.append(v1)
        blk = L(*vars_)
        fe = E("Block", blk, f).evaluate(ev)
        # equations -> residual expressions
        from .solve import flatten_equations

        resid = []
        if fe.get_head_name() in ("System`Equal", "System`List", "System`And"):
            eqs, conds, status = flatten_equations(fe)
            if status == "bad":
                items = list(fe.elements) if fe.has_form("List", None) else [fe]
                resid = items
            else:
                resid = [E("Subtract", a, b) for a, b in eqs]
        else:
            resid = [fe]
        if len(resid) != len(vars_):
            ev.message("FindRoot", "nveq", fe)
            return None
        wp = options.get("System`WorkingPrecision")
        dps = 16
        hp = False
        if wp is not None and wp.get_name() != "System`MachinePrecision":
            v = pyval(wp, ev)
            if v is not None and not isinstance(v, complex) and v >= 1:
                dps, hp = int(v), True
        maxit = 100
        mi = options.get("System`MaxIterations")
        if mi is not None and pyval(mi, ev):
            maxit = int(pyval(mi, ev))
        # compile
        fns = []
        fast = True
        try:
            c = Conv()
            syms = [c.sym(v.get_name()) for v in vars_]
            for r in resid:
                s_ = c.to(r)
                if (s_.free_symbols - set(syms)) or s_.atoms(sp.core.function.AppliedUndef) or \
                        s_.has(sp.Derivative, sp.Integral, sp.Subs):
                    raise ConvError("not numeric")
                fns.append(sp.lambdify(syms, s_, modules=["mpmath"]))
        except Exception:
            fast = False
        if not fast:
            fns = []
            for r in resid:
                def g(*xs, _r=r):
                    rules = L(*[Rule(v, _mp_to_m(x)) for v, x in zip(vars_, xs)])
                    val = pyval(E("ReplaceAll", _r, rules), ev)
                    if val is None:
                        raise ValueError("non numeric")
                    return mpmath.mpmathify(val)
                fns.append(g)
        old = mpmath.mp.dps
        try:
            mpmath.mp.dps = dps + (10 if hp else 4)
            x0 = [mpmath.mpmathify(v) for v in starts]
            with budget(15.0):
                sol, ok = _newton(fns, x0, second, maxit, dps)
            if sol is None:
                return None
            if not ok:
                ev.message("FindRoot", "lstol")
            rules = []
            for v, x in zip(vars_, sol):
                if hp:
                    rules.append(Rule(v, hp_number(x, dps)))
                else:
                    rules.append(Rule(v, _num(complex(x))))
            return L(*rules)
        finally:
            mpmath.mp.dps = old


def _mp_to_m(x):
    import mpmath

    if isinstance(x, mpmath.mpc):
        if x.imag == 0:
            return Real(float(x.real))
        return MComplex(Real(float(x.real)), Real(float(x.imag)))
    return Real(float(x))


def _brent(f, a, b, fa, fb, tol, maxit):
    import mpmath

    if abs(fa) < abs(fb):
        a, b, fa, fb = b, a, fb, fa
    c, fc = a, fa
    d = e = b - a
    for _ in range(maxit):
        if fb == 0:
            return b
        if fa * fb > 0:
            a, fa = c, fc
            d = e = b - c
        if abs(fa) < abs(fb):
            c, fc = b, fb
            b, fb = a, fa
            a, fa = c, fc
        m = (a - b) / 2
        t = 2 * mpmath.eps * abs(b) + tol / 2
        if abs(m) <= t or fb == 0:
            return b
        if abs(e) >= t and abs(fc) > abs(fb):
            s_ = fb / fc
            if a == c:
                p = 2 * m * s_
                q = 1 - s_
            else:
                q_ = fc / fa
                r = fb / fa
                p = s_ * (2 * m * q_ * (q_ - r) - (b - c) * (r - 1))
                q = (q_ - 1) * (r - 1) * (s_ - 1)
            if p > 0:
                q = -q
            else:
                p = -p
            if 2 * p < min(3 * m * q - abs(t * q), abs(e * q)):
                e, d = d, p / q
            else:
                d = e = m
        else:
            d = e = m
        c, fc = b, fb
        b = b + d if abs(d) > t else b + (t if m > 0 else -t)
        fb = f(b)
    return b


def _newton(fns, x0, second, maxit, dps):
    """Damped Newton with a finite-difference Jacobian (secant in 1-D when two starting points are given)."""
    import mpmath

    n = len(fns)
    tol = mpmath.mpf(10) ** (-(dps - 2 if dps > 16 else 13))

    def F(x):
        return mpmath.matrix([f(*x) for f in fns])

    def norm(v):
        return mpmath.sqrt(sum(abs(q) ** 2 for q in v))

    x = list(x0)
    if n == 1 and second[0] is not None:
        a, b = x[0], mpmath.mpmathify(second[0])
        fa, fb = fns[0](a), fns[0](b)
        if isinstance(fa, mpmath.mpf) and isinstance(fb, mpmath.mpf) and fa * fb < 0:
            # the two starting values bracket a root: Brent's method (never leaves the bracket), as Mathematica
            r = _brent(fns[0], a, b, fa, fb, tol, maxit * 3)
            return [r], True
        if fa == 0:
            return [a], True
        if fb == 0:
            return [b], True
        # secant
        for _ in range(maxit):
            if fb == fa:
                break
            c = b - fb * (b - a) / (fb - fa)
            a, fa = b, fb
            b, fb = c, fns[0](c)
            if abs(b - a) <= tol * (1 + abs(b)) and abs(fb) <= mpmath.sqrt(tol):
                return [b], True
        return [b], abs(fb) < mpmath.mpf(10) ** (-6)
    fx = F(x)
    for it in range(maxit):
        nf = norm(fx)
        if nf == 0:
            return x, True
        # Jacobian
        J = mpmath.matrix(n, n)
        for j in range(n):
            h = mpmath.sqrt(mpmath.eps) * (1 + abs(x[j]))
            xp = list(x)
            xp[j] = x[j] + h
            xm = list(x)
            xm[j] = x[j] - h
            fp, fm = F(xp), F(xm)
            for i in range(n):
                J[i, j] = (fp[i] - fm[i]) / (2 * h)
        try:
            dx = mpmath.lu_solve(J, -fx)
        except ZeroDivisionError:
            # singular Jacobian: nudge
            x = [xi * (1 + mpmath.mpf("1e-3")) + mpmath.mpf("1e-3") for xi in x]
            fx = F(x)
            continue
        lam = mpmath.mpf(1)
        accepted = False
        for _ in range(40):
            xn = [xi + lam * dx[i] for i, xi in enumerate(x)]
            try:
                fn_ = F(xn)
                if norm(fn_) < nf or lam < mpmath.mpf("1e-6"):
                    accepted = True
                    break
            except Exception:
                pass
            lam /= 2
        if not accepted:
            return x, False
        step = norm([lam * dx[i] for i in range(n)])
        x, fx = xn, fn_
        if step <= tol * (1 + norm(x)) and norm(fx) <= mpmath.sqrt(tol) * (1 + nf):
            # polish once more
            return x, True
    return x, norm(fx) < mpmath.mpf(10) ** (-8)


class FindMinimum(XB):
    attributes = A_HOLD_ALL | A_PROTECTED
    options = {"WorkingPrecision": "MachinePrecision", "MaxIterations": "500", "Method": "Automatic",
               "AccuracyGoal": "Automatic", "PrecisionGoal": "Automatic", "Gradient": "Automatic",
               "StepMonitor": "None", "EvaluationMonitor": "None"}
    messages = {"cvmit": "Failed to converge to the requested accuracy or precision within `1` iterations.",
                "nrnum": "The function value is not a real number at the starting point."}
    summary_text = "local numerical minimisation"
    sign = 1.0

    def eval(self, f, specs, evaluation, options):
        "%(name)s[f_, specs__List, OptionsPattern[%(name)s]]"
        specs = [s_.evaluate(evaluation) if not s_.has_form("List", None) else s_ for s_ in specs.get_sequence()]
        try:
            return self._go(f, specs, evaluation)
        except Exception:
            _dbg()
            return None

    def _go(self, f, specs, ev):
        var_specs = []
        for s_ in specs:
            if s_.elements and all(q.has_form("List", None) for q in s_.elements):
                var_specs.extend(list(s_.elements))
            else:
                var_specs.append(s_)
        vars_, x0 = [], []
        for vs in var_specs:
            els = vs.elements
            if not els or not isinstance(els[0], Symbol):
                return None
            vars_.append(els[0])
            v0 = pyval(E("N", els[1]), ev) if len(els) > 1 else 1.0
            if v0 is None or isinstance(v0, complex):
                return None
            x0.append(float(v0))
        fe = E("Block", L(*vars_), f).evaluate(ev)
        if fe.has_form("List", None):
            return None                     # constrained form: not supported here
        sgn = self.sign
        fn = None
        try:
            c = Conv(real=[v.get_name() for v in vars_])
            se = c.to(fe)
            syms = [c.sym(v.get_name()) for v in vars_]
            if not (se.free_symbols - set(syms)) and not se.atoms(sp.core.function.AppliedUndef) \
                    and not se.has(sp.Derivative, sp.Integral):
                lam = sp.lambdify(syms, se, modules=["math"])

                def fn(xs):
                    try:
                        v = lam(*xs)
                        v = float(v.real) if isinstance(v, complex) else float(v)
                        return sgn * v if v == v else float("inf")
                    except Exception:
                        return float("inf")
        except Exception:
            fn = None
        if fn is None:
            def fn(xs):
                rules = L(*[Rule(v, Real(float(x))) for v, x in zip(vars_, xs)])
                val = pyval(E("ReplaceAll", fe, rules), ev)
                if val is None or isinstance(val, complex):
                    return float("inf")
                return sgn * float(val)
        with budget(15.0):
            xs, fv, ok = _bfgs(fn, x0)
        if xs is None:
            ev.message(self.get_name().split("`")[-1], "nrnum")
            return None
        rules = L(*[Rule(v, Real(_clean(x))) for v, x in zip(vars_, xs)])
        return L(Real(_clean(sgn * fv)), rules)


class FindMaximum(FindMinimum):
    sign = -1.0
    summary_text = "local numerical maximisation"


def _clean(v):
    return 0.0 if abs(v) < 1e-13 else float(v)


def _bfgs(f, x0, tol=1e-10, maxit=500):
    """Quasi-Newton minimisation with central-difference gradients and a backtracking line search."""
    n = len(x0)
    x = list(x0)
    fx = f(x)
    if fx == float("inf") or fx != fx:
        return None, None, False

    def grad(x, fx):
        g = []
        for i in range(n):
            h = 1e-6 * (1.0 + abs(x[i]))
            xp = list(x)
            xp[i] += h
            xm = list(x)
            xm[i] -= h
            fp, fm = f(xp), f(xm)
            if fp == float("inf") or fm == float("inf"):
                g.append((fp - fx) / h if fp != float("inf") else (fx - fm) / h if fm != float("inf") else 0.0)
            else:
                g.append((fp - fm) / (2 * h))
        return g

    H = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    g = grad(x, fx)
    for it in range(maxit):
        gn = math.sqrt(sum(v * v for v in g))
        if gn < 1e-9 * (1.0 + abs(fx)):
            break
        d = [-sum(H[i][j] * g[j] for j in range(n)) for i in range(n)]
        slope = sum(d[i] * g[i] for i in range(n))
        if slope >= 0:
            H = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
            d = [-v for v in g]
            slope = -gn * gn
        t = 1.0
        ok = False
        for _ in range(60):
            xn = [x[i] + t * d[i] for i in range(n)]
            fn_ = f(xn)
            if fn_ <= fx + 1e-4 * t * slope:
                ok = True
                break
            t *= 0.5
        if not ok:
            break
        gnew = grad(xn, fn_)
        sv = [xn[i] - x[i] for i in range(n)]
        yv = [gnew[i] - g[i] for i in range(n)]
        sy = sum(sv[i] * yv[i] for i in range(n))
        step = math.sqrt(sum(v * v for v in sv))
        dfx = abs(fx - fn_)
        x, fx, g = xn, fn_, gnew
        if sy > 1e-14:
            Hy = [sum(H[i][j] * yv[j] for j in range(n)) for i in range(n)]
            yHy = sum(yv[i] * Hy[i] for i in range(n))
            for i in range(n):
                for j in range(n):
                    H[i][j] += (1.0 + yHy / sy) * sv[i] * sv[j] / sy - (Hy[i] * sv[j] + sv[i] * Hy[j]) / sy
        if step < tol * (1.0 + math.sqrt(sum(v * v for v in x))) and dfx < tol * (1.0 + abs(fx)):
            break
        ext._tick_check()
    # polish with a few Newton-like tiny steps is unnecessary for 6-digit answers
    return x, fx, True


def install(kernel):
    ext.contribute(kernel, [NIntegrate, FindRoot, FindMinimum, FindMaximum])


def quick_numeric(expr, x, lo, hi):
    """Numeric value of a 1-D definite integral of a SymPy expression without parameters (complex ok); None on failure."""
    import numpy as np

    try:
        if expr.free_symbols - {x}:
            return None
        fn = compile_numpy(expr, [x])
        cplx = expr.has(sp.I)

        def f(xv):
            return fn(np.asarray(xv, dtype=complex) if cplx else xv)
        a = float("inf") if hi == sp.oo else float(sp.N(hi))
        b0 = float("-inf") if lo == -sp.oo else float(sp.N(lo))
        v, e, ok = integrate_1d(f, b0, a)
        if not ok:
            return None
        return complex(v)
    except Exception:
        return None
