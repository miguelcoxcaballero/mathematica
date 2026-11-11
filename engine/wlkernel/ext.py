# -*- coding: utf-8 -*-
"""Extension builtins (symbolic/numeric) added on top of Mathics3."""
import math
import os
import time

import sympy as sp
from mathics.core.atoms import Integer, Real, String
from mathics.core.attributes import A_HOLD_ALL, A_PROTECTED, A_HOLD_FIRST, A_LISTABLE, A_NUMERIC_FUNCTION
from mathics.core.builtin import Builtin
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolNull, SymbolTrue, SymbolFalse

from .conv import Conv, ConvError, S, is_free_of

KERNEL = None

# ------------------------------------------------------------ time budgets
# Neither SymPy nor Mathics can be interrupted from outside in the browser (no threads/signals), so a
# watchdog runs inside the interpreter: sys.monitoring JUMP events (= every loop iteration of any pure
# Python code) tick a counter and, every few thousand ticks, compare the clock with
#   (a) the innermost `budget(...)` deadline -> SympyTimeout (an Exception: the builtin gives up), and
#   (b) the kernel's cell deadline           -> core.Deadline (a BaseException: the cell is aborted).
# Where sys.monitoring is missing, a tick in SymPy's Basic.__new__ covers (most of) SymPy.
_TICK = [0]
_BUDGET = [None]
_WATCHDOG = [None]


class SympyTimeout(Exception):
    pass


def _dbg():
    """Print the current traceback when WLX_DEBUG is set (native debugging only)."""
    if os.environ.get("WLX_DEBUG"):
        import sys
        import traceback

        et, ev_, tb = sys.exc_info()
        frames = traceback.extract_tb(tb)
        own = [f for f in frames if "wlkernel" in f.filename][-3:]
        print("WLX_DEBUG %s: %s | %s" % (et.__name__, str(ev_)[:200], " <- ".join(
            "%s:%d %s" % (f.filename.split("/")[-1], f.lineno, f.name) for f in reversed(own))), file=sys.stderr)


def _tick_check():
    now = time.time()
    b = _BUDGET[0]
    if b is not None and now > b:
        raise SympyTimeout()
    k = KERNEL
    if k is not None and k._deadline is not None and now > k._deadline:
        if _WATCHDOG[0] == "monitoring":
            from .core import Deadline

            raise Deadline()
        raise SympyTimeout()


def _install_watchdog():
    if _WATCHDOG[0]:
        return
    try:
        import sys

        mon = sys.monitoring
        tid = None
        for cand in (4, 3, 5):
            if mon.get_tool(cand) is None:
                tid = cand
                break
        if tid is None:
            raise RuntimeError("no free tool id")
        mon.use_tool_id(tid, "wlkernel-watchdog")
        tick = _TICK

        def on_jump(code, offset, dest):
            tick[0] += 1
            if not (tick[0] & 2047):
                _tick_check()

        mon.register_callback(tid, mon.events.JUMP, on_jump)
        mon.set_events(tid, mon.events.JUMP)
        _WATCHDOG[0] = "monitoring"
        return
    except Exception:
        pass
    _install_sympy_tick()
    _WATCHDOG[0] = "sympy-tick"


def _install_sympy_tick():
    from sympy.core.basic import Basic

    if getattr(Basic, "_wlx_tick", False):
        return
    onew = object.__new__
    tick = _TICK

    def __new__(cls, *args):
        tick[0] += 1
        if not (tick[0] & 511):
            _tick_check()
        obj = onew(cls)
        obj._assumptions = cls.default_assumptions
        obj._mhash = None
        obj._args = args
        return obj

    Basic.__new__ = __new__
    Basic._wlx_tick = True


# Time budgets (seconds) for Mathics' own heavy builtins: when exceeded the call is left unevaluated
# (as Mathematica does when it cannot do something) instead of eating the whole cell time limit.
BUILTIN_BUDGETS = {
    "System`Integrate": 10.0, "System`Solve": 12.0, "System`Limit": 8.0, "System`Simplify": 8.0,
    "System`FullSimplify": 10.0, "System`Sum": 8.0, "System`Product": 8.0, "System`Factor": 8.0,
    "System`Apart": 8.0, "System`Together": 8.0, "System`Series": 8.0, "System`Cancel": 8.0,
    "System`Expand": 10.0, "System`Eigenvalues": 10.0, "System`Eigenvectors": 10.0, "System`Eigensystem": 10.0,
    "System`Inverse": 10.0, "System`Det": 10.0, "System`MatrixExp": 10.0, "System`RowReduce": 10.0,
    "System`NullSpace": 10.0, "System`LinearSolve": 10.0, "System`TrigExpand": 8.0, "System`TrigReduce": 8.0,
    "System`PossibleZeroQ": 4.0,
}
SKIP_ONCE = {}


class budget:
    """with budget(seconds): ...  -> SymPy work inside raises SympyTimeout when the time is over."""

    def __init__(self, seconds):
        self.seconds = seconds

    def __enter__(self):
        self.prev = _BUDGET[0]
        d = time.time() + self.seconds
        _BUDGET[0] = d if self.prev is None else min(d, self.prev)
        return self

    def __exit__(self, *exc):
        _BUDGET[0] = self.prev
        return False


def E(head, *args):
    if isinstance(head, str):
        head = S(head)
    return Expression(head, *args)


def L(*args):
    return ListExpression(*args)


def Rule(a, b):
    return E("Rule", a, b)


def pyval(expr, ev):
    """Numeric python value of a Mathics expr (float/complex) or None."""
    try:
        r = E("N", expr).evaluate(ev)
        v = r.to_python()
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, complex):
            return v
    except Exception:
        pass
    return None


def short(expr):
    return expr.get_name().split("`")[-1]


def simp(s):
    try:
        return sp.simplify(s)
    except Exception:
        return s


class XB(Builtin):
    context = "System`"
    summary_text = "extension builtin"


# ---------------------------------------------------------------- Laplace
def _heaviside_fix(s):
    return s.replace(lambda e: isinstance(e, sp.Heaviside) and len(e.args) == 2, lambda e: sp.Heaviside(e.args[0]))


class LaplaceTransform(XB):
    def eval_conv(self, f, u, t, s, evaluation):
        "LaplaceTransform[Integrate[f_, {u_Symbol, 0, t_Symbol}], t_Symbol, s_]"
        # convolution theorem: Int_0^t A(u) B(t-u) du  ->  L[A] L[B]
        ev = evaluation
        factors = list(f.elements) if f.get_head_name() == "System`Times" else [f]
        A = [x for x in factors if is_free_of(x, t.get_name())]
        B = [x for x in factors if not is_free_of(x, t.get_name())]
        Aex = E("Times", *A) if A else Integer(1)
        Bex = E("Times", *B) if B else Integer(1)
        if B:
            shifted = E("Simplify", E("ReplaceAll", Bex, Rule(t, E("Plus", t, u)))).evaluate(ev)
            if not is_free_of(shifted, u.get_name()):
                return None
            Bt = shifted
        else:
            Bt = Integer(1)
        At = E("ReplaceAll", Aex, Rule(u, t))
        return E("Times", E("LaplaceTransform", At, t, s), E("LaplaceTransform", Bt, t, s)).evaluate(ev)

    def eval(self, f, t, s, evaluation):
        "LaplaceTransform[f_, t_Symbol, s_]"
        from . import calc

        tn = t.get_name()
        params = [nm for nm in _user_symbols(f) if nm != tn]
        c = Conv(real=[tn] + params)
        try:
            fs = c.to(f)
            ts = c.sym(tn)
            if fs.atoms(sp.core.function.AppliedUndef) or fs.has(sp.Derivative, sp.Subs, sp.Integral):
                return None
            ss = c.to(s)
            sd = sp.Symbol("WLX`sdummy", positive=True)
            r = None
            delta_part = 0
            if fs.has(sp.DiracDelta):
                # g(t) DiracDelta[k t - k a] -> g(a) e^(-a s)/|k|   (a >= 0)
                rest = 0
                for term in sp.Add.make_args(sp.expand(fs)):
                    ds = [d_ for d_ in term.atoms(sp.DiracDelta) if d_.has(ts)]
                    if not ds:
                        rest += term
                        continue
                    if len(ds) != 1 or len(ds[0].args) != 1:
                        return None
                    g = term / ds[0]
                    pl = sp.Poly(ds[0].args[0], ts)
                    if pl.degree() != 1 or g.has(sp.DiracDelta):
                        return None
                    k1, k0 = pl.all_coeffs()
                    a0 = -k0 / k1
                    delta_part += g.subs(ts, a0) * sp.exp(-a0 * sd) / sp.Abs(k1)
                fs = rest
                if fs == 0:
                    return c.back(delta_part.subs(sd, ss)).evaluate(evaluation)
            tpos = sp.Symbol("WLX`tpos", positive=True)
            fs = fs.subs(ts, tpos)
            ts = tpos
            try:
                with budget(6.0):
                    r = calc.laplace_fast(fs, ts, sd)
            except Exception:
                _dbg()
                r = None
            if r is None:
                with budget(8.0):
                    fs2 = _heaviside_fix(fs)
                    r = sp.laplace_transform(fs2, ts, sd, noconds=True)
                    if r.has(sp.LaplaceTransform) or r.has(sp.Integral):
                        return None
                    r = calc.real_form(simp_light(r)) if r.has(sp.I) else simp_light(r)
            r = (r + delta_part).subs(sd, ss)
            return c.back(r).evaluate(evaluation)
        except Exception:
            _dbg()
            return None


def simp_light(r):
    try:
        r2 = sp.together(r)
        r3 = sp.factor_terms(r2)
        return r3
    except Exception:
        return r


class InverseLaplaceTransform(XB):
    def eval(self, F, s, t, evaluation):
        "InverseLaplaceTransform[F_, s_Symbol, t_]"
        from . import calc

        if not is_free_of(F, "System`LaplaceTransform") or not is_free_of(F, "System`InverseLaplaceTransform"):
            return None
        sn = s.get_name()
        params = [nm for nm in _user_symbols(F) if nm != sn]
        c = Conv(real=params)
        try:
            Fs = c.to(F)
            if Fs.atoms(sp.core.function.AppliedUndef) or Fs.has(sp.Derivative, sp.Subs, sp.Integral):
                return None
            ssym = c.sym(sn)
            td = sp.Symbol("WLX`tdummy", positive=True)
            tt = c.to(t)
            total = None
            try:
                with budget(8.0):
                    total = calc.inverse_laplace_fast(rationalize_floats(Fs), ssym, td)
            except Exception:
                _dbg()
                total = None
            if total is None:
                with budget(8.0):
                    try:
                        Fa = sp.apart(Fs, ssym)
                    except Exception:
                        Fa = Fs
                    total = 0
                    for term in sp.Add.make_args(Fa):
                        r = sp.inverse_laplace_transform(term, ssym, td)
                        if r.has(sp.InverseLaplaceTransform):
                            return None
                        total += r
                    total = total.replace(lambda e: isinstance(e, sp.Heaviside) and e.args[0] == td, lambda e: sp.Integer(1))
                    total = _heaviside_fix(sp.expand(total))
                    if total.has(sp.I):
                        total = calc.real_form(total)
            had_float = bool(Fs.atoms(sp.Float))
            total = total.subs(td, tt)
            if total.has(sp.Heaviside):
                total = sp.collect(sp.expand(total), list(total.atoms(sp.Heaviside)))
            res = c.back(total)
            if had_float:
                res = E("N", res)
            return res.evaluate(evaluation)
        except Exception:
            _dbg()
            return None


def rationalize_floats(s_):
    fl = s_.atoms(sp.Float)
    if not fl:
        return s_
    return s_.xreplace({f: sp.Rational(str(f)) for f in fl})


class XConvolveCausal(XB):
    """WLX`ConvolveQ[f, g, t, x]: convolution of two causal functions (UnitStep/HeavisideTheta factors)
    through the Laplace transform; result via WLX`ConvolveGet[]."""
    name = "ConvolveQ"
    context = "WLX`"

    def eval(self, f, g, t, x, evaluation):
        "WLX`ConvolveQ[f_, g_, t_Symbol, x_]"
        from . import calc

        try:
            names = ("System`UnitStep", "System`HeavisideTheta")
            if not (_has_head(f, names) and _has_head(g, names)):
                return SymbolFalse
            tn = t.get_name()
            c = Conv(real=[tn] + [nm for nm in _user_symbols(E("List", f, g)) if nm != tn])
            fs, gs = c.to(f), c.to(g)
            ts = c.sym(tn)
            # both must vanish for t < 0
            for h in (fs, gs):
                pcs = calc.split_pieces(h, ts, -sp.oo, sp.Integer(0))
                if pcs is None or any(p_[2] != 0 for p_ in pcs):
                    return SymbolFalse
            sd = sp.Symbol("WLX`sdummy", positive=True)
            tp = sp.Symbol("WLX`tpos", positive=True)
            with budget(10.0):
                Lf = calc.laplace_fast(fs.subs(ts, tp), tp, sd)
                Lg = calc.laplace_fast(gs.subs(ts, tp), tp, sd)
                if Lf is None or Lg is None:
                    return SymbolFalse
                h = calc.inverse_laplace_fast(Lf * Lg, sd, tp)
            if h is None:
                return SymbolFalse
            xs = c.to(x)
            h = sp.simplify(h) if h.count_ops() < 300 and not h.has(sp.Heaviside) else h
            if not h.has(sp.Heaviside):
                res = sp.Heaviside(xs, 1) * h.subs(tp, xs)
            else:
                res = h.subs(tp, xs)
            return _stash("conv", c.back(res).evaluate(evaluation))
        except Exception:
            _dbg()
            return SymbolFalse


class XConvolveGet(XB):
    name = "ConvolveGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`ConvolveGet[]"
        return _RESULT.pop("conv", None)


# ------------------------------------------------------------------ DSolve
class DSolve(XB):
    messages = {
        "nosol": "No se pudo resolver simbólicamente esta ecuación diferencial.",
        "deqn": "Se esperaba una ecuación (con ==) o lista de ecuaciones en el primer argumento.",
        "dsvar": "`1` no puede usarse como variable independiente.",
    }
    summary_text = "solve differential equations symbolically"

    def eval(self, eqn, y, x, evaluation):
        "DSolve[eqn_, y_, x_]"
        try:
            return self._solve(eqn, y, x, evaluation)
        except Exception:
            _dbg()
        return None

    def _solve(self, eqn, y, x, ev):
        eqs = list(eqn.elements) if eqn.has_form("List", None) else [eqn]
        flat = []
        for e in eqs:
            if e.has_form("List", None):
                flat.extend(e.elements)
            elif e.get_head_name() == "System`And":
                flat.extend(e.elements)
            else:
                flat.append(e)
        eqs = []
        for e in flat:
            if e.get_head_name() == "System`Equal" and len(e.elements) == 2 and \
                    e.elements[0].has_form("List", None) and e.elements[1].has_form("List", None) and \
                    len(e.elements[0].elements) == len(e.elements[1].elements):
                def _fl(v):
                    out_ = []
                    for q in v.elements:
                        if q.has_form("List", None):
                            out_.extend(_fl(q))
                        else:
                            out_.append(q)
                    return out_
                la_, lb_ = _fl(e.elements[0]), _fl(e.elements[1])
                if len(la_) == len(lb_):
                    eqs.extend(E("Equal", p_, q_) for p_, q_ in zip(la_, lb_))
                    continue
            eqs.append(e)
        for e in eqs:
            if e is SymbolTrue:
                continue
            if e.get_head_name() != "System`Equal":
                ev.message("DSolve", "deqn")
                return None
        eqs = [e for e in eqs if e is not SymbolTrue]
        if not isinstance(x, Symbol):
            if x.has_form("List", 1, None):
                return self._pde(eqs, y, x, ev)
            ev.message("DSolve", "dsvar", x)
            return None
        ys = list(y.elements) if y.has_form("List", None) else [y]
        fnames = []
        pure = []
        for yy in ys:
            if isinstance(yy, Symbol):
                fnames.append(yy.get_name())
                pure.append(True)
            else:
                fnames.append(yy.get_head_name())
                pure.append(False)
        xname = x.get_name()
        params = set()
        for e in eqs:
            for nm in _user_symbols(e):
                if nm != xname and nm not in fnames:
                    params.add(nm)
        c = Conv(funcs=fnames, positive=params)
        xs = c.sym(xname)
        funcs = [sp.Function(n)(xs) for n in fnames]
        odes, ics = [], {}
        for e in eqs:
            lhs, rhs = e.elements[0], e.elements[1]
            if is_free_of(e, xname):
                # initial / boundary condition
                key = self._ic_key(lhs, fnames, xs, c)
                val = c.to(rhs)
                if key is None:
                    key = self._ic_key(rhs, fnames, xs, c)
                    val = c.to(lhs)
                if key is None:
                    raise ConvError("ic")
                ics[key] = val
            else:
                odes.append(sp.Eq(c.to(lhs), c.to(rhs)))
        if not odes:
            ev.message("DSolve", "deqn")
            return None
        if len(odes) == 1 and len(funcs) == 1:
            sol = self._single(odes[0], funcs[0], ics)
            sols = sol if isinstance(sol, list) else [sol]
            sols = [[s] for s in sols]
        else:
            sol = None
            if len(odes) == len(funcs):
                try:
                    with budget(10.0):
                        sol = _laplace_system(odes, funcs, xs, ics) if (ics or not all(
                            sp.ode_order(o.lhs - o.rhs, f_) <= 1 for o in odes for f_ in funcs)) else None
                except Exception:
                    _dbg()
                    sol = None
            if sol is None and not ics and len(odes) == len(funcs):
                try:
                    with budget(8.0):
                        sol = _mma_linear_system(odes, funcs, xs)
                except Exception:
                    _dbg()
                    sol = None
            if sol is None:
                with budget(16.0):
                    sol = sp.dsolve(odes, funcs, ics=ics or None)
            if sol and isinstance(sol[0], (list, tuple)):
                sols = [list(s) for s in sol]
            else:
                sols = [list(sol)]
        out = []
        for group in sols:
            rules = []
            for eq in group:
                eq = self._rename_constants(eq, c)
                lhs_f = eq.lhs
                rhs = eq.rhs
                if not (isinstance(lhs_f, sp.core.function.AppliedUndef) and lhs_f in funcs):
                    # implicit solution: try to solve for the function
                    cand = None
                    for f in funcs:
                        try:
                            ss = sp.solve(eq, f)
                        except Exception:
                            ss = []
                        if ss:
                            cand = (f, ss)
                            break
                    if cand is None:
                        if len(funcs) == 1 and len(group) == 1:
                            # implicit solution, shown as Mathematica does: Solve[F[x, y[x]] == C[1], y[x]]
                            imp = E("Equal", c.back(eq.lhs), c.back(eq.rhs))
                            out.append(E("HoldForm", E("Solve", imp, ys[0] if not pure[0] else E(ys[0], x))))
                            rules = None
                            break
                        raise ConvError("implicit")
                    f, ss = cand
                    for s1 in ss:
                        out.append(L(self._rule(f, s1, fnames, pure, ys, x, c, ev)))
                    rules = None
                    break
                rhs = self._pretty(rhs)
                rules.append(self._rule(lhs_f, rhs, fnames, pure, ys, x, c, ev))
            if rules:
                out.append(L(*rules))
        if len(out) == 1 and out[0].get_head_name() == "System`HoldForm":
            return out[0]
        out = [o for o in out if o.get_head_name() != "System`HoldForm"]
        return L(*out)

    def _pde(self, eqs, y, x, ev):
        vars_ = list(x.elements)
        if len(eqs) != 1 or y.has_form("List", None):
            ev.message("DSolve", "nosol")
            return None
        pure = isinstance(y, Symbol)
        fname = y.get_name() if pure else y.get_head_name()
        c = Conv(funcs=[fname])
        syms = [c.sym(v.get_name()) for v in vars_]
        f = sp.Function(fname)(*syms)
        eq = c.to(eqs[0].elements[0]) - c.to(eqs[0].elements[1])
        derivs = list(eq.atoms(sp.Derivative))
        sol = None
        if len(derivs) == 1 and not eq.subs(derivs[0], 0).has(f) and len(derivs[0].variable_count) == 1:
            v, n = derivs[0].variable_count[0]
            g = sp.solve(eq, derivs[0])
            if g:
                expr = g[0]
                for _ in range(int(n)):
                    expr = sp.integrate(expr, v)
                others = [s_ for s_ in syms if s_ != v]
                for k in range(int(n)):
                    expr += v ** k * sp.Function("WLXC%d" % (k + 1))(*others)
                sol = expr
        if sol is None:
            sol = _pde_extra(eq, f, syms)
        if sol is None:
            res = sp.pdsolve(sp.Eq(eq, 0), f)
            rhs = res.rhs
            for fn in rhs.atoms(sp.core.function.AppliedUndef):
                if fn.func.__name__ == "F":
                    rhs = rhs.subs(fn, sp.Function("WLXC1")(*fn.args))
            sol = rhs
        try:
            with budget(4.0):
                sol = sp.simplify(sol)
        except Exception:
            pass
        body = c.back(sol).evaluate(ev)
        if pure:
            return L(L(Rule(y, E("Function", L(*vars_), body))))
        return L(L(Rule(y, body)))

    @staticmethod
    def _pretty(rhs):
        try:
            with budget(3.0):
                r = sp.simplify(rhs)
                if r.has(sp.I) and not rhs.has(sp.I):
                    return rhs
                if sp.count_ops(r) <= sp.count_ops(rhs) * 1.2 + 2:
                    return r
        except Exception:
            pass
        return rhs

    @staticmethod
    def _single(ode, func, ics):
        with budget(14.0):
            gen = _dsolve_general(ode, func)
            if gen is None:
                raise ConvError("no solution")
            gens = gen if isinstance(gen, list) else [gen]
            # explicit form whenever possible
            expl = []
            for g in gens:
                if g.lhs == func and not g.rhs.has(func):
                    expl.append(g)
                    continue
                try:
                    with budget(5.0):
                        ss = sp.solve(g, func)
                except Exception:
                    ss = []
                ss = [s_ for s_ in ss if not s_.has(func)]
                if ss:
                    expl.extend(sp.Eq(func, s_) for s_ in ss)
                else:
                    expl.append(g)
            if not ics:
                if len(expl) == 1 and expl[0].lhs == func:
                    try:
                        with budget(4.0):
                            alt = _mma_constants(ode, func, expl[0].rhs)
                        if alt is not None:
                            return [sp.Eq(func, alt)]
                    except Exception:
                        _dbg()
                return expl
            res = []
            x = func.args[0]
            for g in expl:
                if g.lhs != func:
                    # implicit solution: fix the constant from the conditions when it is a plain point condition
                    sub = _implicit_ics(g, func, ics)
                    if sub is not None:
                        res.append(g.subs(sub))
                    continue
                for sub in _apply_ics(g.rhs, x, ics):
                    res.append(sp.Eq(func, g.rhs.subs(sub)))
            if not res:
                raise ConvError("ics")
            # drop duplicates
            uniq = []
            for r in res:
                if r not in uniq:
                    uniq.append(r)
            return uniq

    @staticmethod
    def _ic_key(lhs, fnames, xs, c):
        head = lhs.get_head()
        if isinstance(head, Symbol) and head.get_name() in fnames and len(lhs.elements) == 1:
            return sp.Function(head.get_name())(c.to(lhs.elements[0]))
        if isinstance(head, Expression) and isinstance(head.get_head(), Expression) and \
                head.get_head().get_head_name() == "System`Derivative":
            n = head.get_head().elements[0].value
            fname = head.elements[0].get_name()
            if fname in fnames:
                f = sp.Function(fname)(xs)
                return sp.Subs(sp.Derivative(f, (xs, n)), xs, c.to(lhs.elements[0]))
        return None

    @staticmethod
    def _rename_constants(eq, c):
        subs = {}
        for s in eq.free_symbols:
            n = s.name
            if len(n) >= 2 and n[0] == "C" and n[1:].isdigit():
                subs[s] = c.sym("C[%s]" % n[1:])
        return eq.subs(subs) if subs else eq

    @staticmethod
    def _rule(f, rhs, fnames, pure, ys, x, c, ev):
        idx = fnames.index(f.func.__name__)
        body = c.back(rhs).evaluate(ev)
        if pure[idx]:
            return Rule(ys[idx], E("Function", L(x), body))
        return Rule(ys[idx], body)


def _pde_extra(eq, f, syms):
    """Cases SymPy's pdsolve does not do: f_xy = g, constant-coefficient 2nd order homogeneous,
    a f_x + b f_y = G(f)."""
    if len(syms) != 2:
        return None
    v1, v2 = syms
    C1, C2 = sp.Function("WLXC1"), sp.Function("WLXC2")
    eq = sp.expand(eq)
    d11, d12, d22 = sp.Derivative(f, (v1, 2)), sp.Derivative(f, v1, v2), sp.Derivative(f, (v2, 2))
    d1, d2 = sp.Derivative(f, v1), sp.Derivative(f, v2)
    derivs = eq.atoms(sp.Derivative)
    second = [d for d in derivs if sum(n for _, n in d.variable_count) == 2]
    if second and all(sum(n for _, n in d.variable_count) == 2 for d in derivs):
        A, B, Cc = eq.coeff(d11), eq.coeff(d12), eq.coeff(d22)
        rest = sp.simplify(eq - A * d11 - B * d12 - Cc * d22)
        if rest.has(f) or any(q.has(v1, v2) for q in (A, B, Cc)):
            return None
        if A == 0 and Cc == 0 and B != 0:
            g = -rest / B
            part = sp.integrate(sp.integrate(g, v1), v2) if g != 0 else 0
            return part + C1(v1) + C2(v2)
        if rest != 0:
            return None
        m = sp.Symbol("WLX`m")
        if A != 0:
            # f = phi(v2 + m v1):  A m^2 + B m + C = 0
            rts = sp.roots(sp.Poly(A * m ** 2 + B * m + Cc, m))
            lst = [r_ for r_, k in rts.items() for _ in range(k)]
            if len(lst) != 2:
                return None
            try:
                lst.sort(key=lambda r_: (complex(sp.N(r_.subs({q: 0.7 for q in r_.free_symbols}))).real,
                                         complex(sp.N(r_.subs({q: 0.7 for q in r_.free_symbols}))).imag))
            except Exception:
                pass
            if lst[0] == lst[1]:
                return C1(v2 + lst[0] * v1) + v1 * C2(v2 + lst[0] * v1)
            return C1(v2 + lst[0] * v1) + C2(v2 + lst[1] * v1)
        # A == 0: B f_12 + C f_22 = 0 -> f = C1(v1) + C2(v2 - (C/B) v1) ... use phi(v1 + m v2): C m^2 + B m = 0
        if Cc != 0:
            return C1(v1) + C2(v1 - (B / Cc) * v2) if B != 0 else C1(v1) + v2 * C2(v1)
        return None
    if derivs and all(d in (d1, d2) for d in derivs):
        a, b = eq.coeff(d1), eq.coeff(d2)
        G = sp.simplify(-(eq - a * d1 - b * d2))
        zz = sp.Dummy("z")
        Gz = G.subs(f, zz)
        if a == 0 or b == 0 or a.has(v1, v2, f) or b.has(v1, v2, f) or Gz.has(v1, v2) or not Gz.has(zz):
            return None
        if sp.diff(Gz, zz, 2) == 0:
            return None                 # linear in f: pdsolve gives the usual form
        I1 = sp.integrate(1 / Gz, zz)
        if I1.has(sp.Integral):
            return None
        inv = _peel_invert(I1, v1 / a + C1(v2 - b * v1 / a), zz)
        return inv
    return None


_HINT_SKIP = ("_Integral", "power_series")
_HINT_LAST = ("lie_group", "factorable")


def _exp_substitution(expr, x):
    """Integrate g(e^(k x)) dx with u = e^(k x) (SymPy alone is very slow on these). None if not applicable."""
    exps = [e for e in expr.atoms(sp.exp) if e.has(x)]
    if not exps:
        return None
    ks = []
    for e in exps:
        a = e.args[0]
        k = sp.expand(a).coeff(x)
        if k == 0 or sp.expand(a - k * x) != 0 or k.has(x):
            return None
        ks.append(k)
    k0 = min(ks, key=lambda v: (sp.Abs(v).evalf() if v.is_number else 1))
    u = sp.Symbol("WLX`u", positive=True)
    rep = {}
    for e, k in zip(exps, ks):
        q = sp.nsimplify(k / k0) if (k / k0).is_number else sp.simplify(k / k0)
        if not q.is_Rational:
            return None
        rep[e] = u ** q
    g = expr.xreplace(rep)
    if g.has(x):
        return None
    r = sp.integrate(sp.simplify(g / (k0 * u)), u)
    if r.has(sp.Integral):
        return None
    return r.subs(u, sp.exp(k0 * x))


def fast_integrate(expr, x):
    """Indefinite integral with a couple of cheap substitutions tried before SymPy's general machinery."""
    try:
        r = _exp_substitution(expr, x)
        if r is not None:
            return r
    except SympyTimeout:
        raise
    except Exception:
        pass
    return sp.integrate(expr, x)


def _own_vop(ode, func):
    """Constant-coefficient linear ODE, variation of parameters with our faster integrals."""
    x = func.args[0]
    order = sp.ode_order(ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode, func)
    lc = _linear_coeffs(ode, func, order)
    if lc is None:
        return None
    ps, q = lc
    if any(p_.has(x) for p_ in ps) or q == 0:
        return None
    hom = sum(p_ * (sp.Derivative(func, (x, k)) if k else func) for k, p_ in enumerate(ps))
    yh = sp.dsolve(hom, func, hint="nth_linear_constant_coeff_homogeneous").rhs
    consts = _ode_consts(yh)
    if len(consts) != order:
        return None
    basis = [sp.expand(yh).coeff(c_) for c_ in consts]
    if sp.simplify(sum(c_ * b_ for c_, b_ in zip(consts, basis)) - yh) != 0:
        return None
    g = -q / ps[order]
    W = sp.Matrix([[sp.diff(b_, x, k) for b_ in basis] for k in range(order)])
    rhs = sp.Matrix([0] * (order - 1) + [g])
    us = W.LUsolve(rhs)
    yp = 0
    for b_, up in zip(basis, us):
        integ = fast_integrate(sp.simplify(up), x)
        if integ.has(sp.Integral):
            return None
        yp += b_ * integ
    return sp.Eq(func, yh + sp.simplify(yp))


def _peel_invert(lhs, rhs, v):
    """Solve lhs(v) == rhs for v when lhs is a chain of invertible elementary functions (principal branch)."""
    for _ in range(12):
        if lhs == v:
            return rhs
        if not lhs.has(v):
            return None
        if isinstance(lhs, sp.Add):
            dep = [a for a in lhs.args if a.has(v)]
            if len(dep) != 1:
                return None
            rhs = rhs - (lhs - dep[0])
            lhs = dep[0]
        elif isinstance(lhs, sp.Mul):
            dep = [a for a in lhs.args if a.has(v)]
            if len(dep) != 1:
                return None
            rhs = rhs / (lhs / dep[0])
            lhs = dep[0]
        elif isinstance(lhs, sp.tan):
            lhs, rhs = lhs.args[0], sp.atan(rhs)
        elif isinstance(lhs, sp.cot):
            lhs, rhs = lhs.args[0], sp.acot(rhs)
        elif isinstance(lhs, sp.log):
            lhs, rhs = lhs.args[0], sp.exp(rhs)
        elif isinstance(lhs, sp.exp):
            lhs, rhs = lhs.args[0], sp.log(rhs)
        elif isinstance(lhs, sp.atan):
            lhs, rhs = lhs.args[0], sp.tan(rhs)
        elif isinstance(lhs, sp.sinh):
            lhs, rhs = lhs.args[0], sp.asinh(rhs)
        elif isinstance(lhs, sp.asinh):
            lhs, rhs = lhs.args[0], sp.sinh(rhs)
        elif isinstance(lhs, sp.tanh):
            lhs, rhs = lhs.args[0], sp.atanh(rhs)
        elif isinstance(lhs, sp.Pow) and lhs.exp == -1:
            lhs, rhs = lhs.base, 1 / rhs
        elif isinstance(lhs, sp.Pow) and lhs.exp.is_Integer and lhs.exp % 2 == 1 and not lhs.exp.has(v):
            lhs, rhs = lhs.base, sp.real_root(rhs, lhs.exp) if False else rhs ** (sp.Integer(1) / lhs.exp)
        else:
            return None
    return None


def _own_homogeneous(ode, func):
    """y' = F(y/x): with y = x v the equation separates:  Int dv/(F(v) - v) = Log[x] + C."""
    x = func.args[0]
    expr = ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode
    yp = sp.Derivative(func, x)
    d = sp.Dummy("yp")
    e2 = expr.subs(yp, d)
    if e2.has(sp.Derivative):
        return None
    ss = sp.solve(e2, d)
    if len(ss) != 1:
        return None
    v = sp.Symbol("WLX`v")
    F = sp.simplify(ss[0].subs(func, v * x))
    if F.has(x) or F.has(func):
        return None
    den = sp.simplify(F - v)
    C1 = sp.Symbol("C1")
    if den == 0:
        return sp.Eq(func, C1 * x)
    I1 = sp.integrate(sp.simplify(1 / den), v)
    if I1.has(sp.Integral):
        return None
    try:
        I1 = sp.trigsimp(I1)
    except Exception:
        pass
    imp = sp.Eq(I1, sp.log(x) + C1)
    inv = _peel_invert(I1, sp.log(x) + C1, v)
    vs = [inv] if inv is not None else sp.solve(imp, v)
    vs = [q for q in vs if not q.has(v)]
    if not vs:
        return sp.Eq(I1.subs(v, func / x), sp.log(x) + C1)
    out = [sp.Eq(func, x * q) for q in vs]
    return out if len(out) > 1 else out[0]


def _own_clairaut(ode, func):
    """y = x y' + f(y')  ->  y = C x + f(C)."""
    x = func.args[0]
    expr = ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode
    p, Y = sp.Dummy("p"), sp.Dummy("Y")
    e = expr.subs(sp.Derivative(func, x), p)
    if e.has(sp.Derivative):
        return None
    e = e.subs(func, Y)
    if not e.has(Y) or not e.has(p):
        return None
    hs = sp.solve(e, Y)
    if len(hs) != 1:
        return None
    g = sp.simplify(hs[0] - x * p)
    if g.has(x) or sp.diff(g, p, 2) == 0:
        return None
    C1 = sp.Symbol("C1")
    return sp.Eq(func, C1 * x + g.subs(p, C1))


def _mma_constants(ode, func, rhs):
    """Linear constant-coefficient ODE: number the constants as Mathematica does
    (real roots ascending; a +- b i gives e^(a x)(C[2] Cos[b x] + C[1] Sin[b x]), or C[1] Cos + C[2] Sin if a = 0)."""
    x = func.args[0]
    expr = ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode
    order = sp.ode_order(expr, func)
    if order < 2:
        return None
    lc = _linear_coeffs(ode, func, order)
    if lc is None:
        return None
    ps, q = lc
    if any(p_.has(x) for p_ in ps):
        return None
    consts = _ode_consts(rhs)
    if len(consts) != order or any(sp.diff(rhs, c_, 2) != 0 for c_ in consts):
        return None
    yp = rhs.subs({c_: 0 for c_ in consts})
    r = sp.Symbol("WLX`r")
    roots = sp.roots(sp.Poly(sum(p_ * r ** k for k, p_ in enumerate(ps)), r))
    if sum(roots.values()) != order:
        return None
    probe = {s_: sp.Float(0.731 + 0.217 * i) for i, s_ in enumerate(sorted(expr.free_symbols - {x}, key=str))}
    reals, cplx = [], []
    for rt, m in roots.items():
        try:
            nv = complex(sp.N(rt.subs(probe)))
        except Exception:
            return None
        if abs(nv.imag) < 1e-12:
            reals.append((nv.real, rt, m))
        elif nv.imag > 0:
            cplx.append((nv.real, nv.imag, rt, m))
    if 2 * sum(m for *_, m in cplx) + sum(m for *_, m in reals) != order:
        return None
    basis = []
    for _, rt, m in sorted(reals, key=lambda t: t[0]):
        for j in range(m):
            basis.append(x ** j * sp.exp(rt * x))
    for _, _, rt, m in sorted(cplx, key=lambda t: (t[0], t[1])):
        a_, b_ = sp.re(rt), sp.im(rt)
        if a_.has(sp.re, sp.im) or b_.has(sp.re, sp.im):
            a_, b_ = sp.simplify((rt + sp.conjugate(rt)) / 2), sp.simplify((rt - sp.conjugate(rt)) / (2 * sp.I))
            if a_.has(sp.conjugate) or b_.has(sp.conjugate):
                return None
        for j in range(m):
            if a_ == 0:
                basis += [x ** j * sp.cos(b_ * x), x ** j * sp.sin(b_ * x)]
            else:
                basis += [x ** j * sp.exp(a_ * x) * sp.sin(b_ * x), x ** j * sp.exp(a_ * x) * sp.cos(b_ * x)]
    cs = sp.symbols("C1:%d" % (order + 1))
    return sum(c_ * b_ for c_, b_ in zip(cs, basis)) + yp


def _laplace_system(odes, funcs, x, ics):
    """Linear constant-coefficient system of any order (conditions at 0, missing ones become C[i]) by the
    Laplace transform: algebraic system for the transforms + inverse transform in real form."""
    from . import calc

    n = len(funcs)
    s_ = sp.Symbol("WLX`s", positive=True)
    tp = sp.Symbol("WLX`tpos", positive=True)
    Ys = [sp.Symbol("WLX`Y%d" % i) for i in range(n)]
    orders = []
    exprs = [sp.expand(o.lhs - o.rhs) for o in odes]
    for f in funcs:
        orders.append(max([sp.ode_order(e, f) for e in exprs] + [0]))
    # initial values
    init = {}
    cidx = 1
    for (i, f), o in zip(enumerate(funcs), orders):
        for j in range(o):
            key = f.func(0) if j == 0 else sp.Subs(sp.Derivative(f, (x, j)), x, 0)
            val = None
            for k_, v_ in ics.items():
                if j == 0 and isinstance(k_, sp.core.function.AppliedUndef) and k_.func == f.func and k_.args[0] == 0:
                    val = v_
                elif j > 0 and isinstance(k_, sp.Subs) and k_.expr.expr == f and k_.expr.variable_count[0][1] == j \
                        and k_.point[0] == 0:
                    val = v_
            if val is None:
                val = sp.Symbol("C%d" % cidx)
                cidx += 1
            init[(i, j)] = val
    used = sum(1 for k_ in ics)
    given = sum(1 for (i, j), v in init.items() if not (isinstance(v, sp.Symbol) and v.name.startswith("C")))
    if used != given:
        return None                     # conditions not at 0 (or not understood)
    alg = []
    for e in exprs:
        tot = 0
        rest = e
        for i, f in enumerate(funcs):
            for j in range(orders[i], -1, -1):
                d = sp.Derivative(f, (x, j)) if j else f
                co = rest.coeff(d)
                if co == 0:
                    continue
                if co.has(x) or co.atoms(sp.core.function.AppliedUndef):
                    return None
                rest = sp.expand(rest - co * d)
                tr = s_ ** j * Ys[i] - sum(s_ ** (j - 1 - m) * init[(i, m)] for m in range(j))
                tot += co * tr
        if rest.atoms(sp.core.function.AppliedUndef) or rest.has(sp.Derivative):
            return None
        if rest != 0:
            G = calc.laplace_fast(rest.subs(x, tp), tp, s_)
            if G is None:
                return None
            tot += G
        alg.append(tot)
    sol = sp.solve(alg, Ys, dict=True)
    if not sol:
        return None
    out = []
    for i, f in enumerate(funcs):
        Yi = sp.together(sol[0][Ys[i]])
        yi = calc.inverse_laplace_fast(Yi, s_, tp)
        if yi is None:
            return None
        yi = yi.subs(tp, x)
        try:
            yi2 = sp.simplify(yi) if yi.count_ops() < 250 else yi
            if not yi2.has(sp.I):
                yi = yi2
        except SympyTimeout:
            raise
        except Exception:
            pass
        out.append(sp.Eq(f, yi))
    return out


def _mma_linear_system(odes, funcs, x):
    """X' = A X with constant A: X = MatrixExp[A x].{C1, ..., Cn} (Mathematica's choice: C[i] = x_i(0))."""
    n = len(funcs)
    ders = [sp.Derivative(f, x) for f in funcs]
    exprs = [o.lhs - o.rhs for o in odes]
    if any(sp.ode_order(e, f) > 1 for e in exprs for f in funcs):
        return None
    sol = sp.solve(exprs, ders, dict=True)
    if not sol:
        return None
    A = sp.zeros(n, n)
    for i, d in enumerate(ders):
        if d not in sol[0]:
            return None
        e = sp.expand(sol[0][d])
        for j, f in enumerate(funcs):
            A[i, j] = e.coeff(f)
            e = e - A[i, j] * f
        if sp.simplify(e) != 0:
            return None             # not homogeneous
    if A.has(x) or A.atoms(sp.core.function.AppliedUndef):
        return None
    from . import calc

    M = (A * x).exp()
    M = M.applyfunc(lambda v: calc.real_form(sp.simplify(v)) if v.has(sp.I) else sp.simplify(v))
    if M.has(sp.I):
        M = M.applyfunc(lambda v: sp.simplify(v.rewrite(sp.cos)) if v.has(sp.I) else v)
        if M.has(sp.I):
            return None
    cs = sp.Matrix(sp.symbols("C1:%d" % (n + 1)))
    X = M * cs
    return [sp.Eq(f, sp.expand(X[i])) for i, f in enumerate(funcs)]


def _dsolve_general(ode, func):
    """General solution of a single ODE choosing SymPy hints ourselves (the default order can be very slow)."""
    x = func.args[0]
    try:
        if sp.ode_order(ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode, func) == 1:
            with budget(3.0):
                r = _own_clairaut(ode, func)
            if r is not None:
                return r
    except Exception:
        pass
    try:
        with budget(5.0):
            info = sp.classify_ode(ode, func)
    except Exception:
        info = ()
    try:
        from sympy.solvers.ode.ode import allhints
    except Exception:
        allhints = ()
    # SymPy's own preference ("default") is the order of `allhints`
    hints = [h for h in allhints if h in info] + [h for h in info if h not in allhints]
    hints = [h for h in hints if h and not any(k in h for k in _HINT_SKIP)]
    hints = [h for h in hints if h not in _HINT_LAST] + [h for h in hints if h in _HINT_LAST]
    expr = ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode
    real_ode = not expr.has(sp.I)
    backup = None
    tried = 0
    if any("variation_of_parameters" in h for h in hints[:1]) and "nth_linear_constant_coeff" in hints[0]:
        try:
            with budget(6.0):
                r = _own_vop(ode, func)
            if r is not None:
                return r
        except Exception:
            pass
    if any(h.startswith("1st_homogeneous_coeff") for h in hints) and "separable" not in hints and "1st_linear" not in hints:
        try:
            with budget(5.0):
                r = _own_homogeneous(ode, func)
            if r is not None:
                return r
        except Exception:
            pass
    for h in hints:
        if tried >= 5:
            break
        tried += 1
        try:
            with budget(3.0 if h in _HINT_LAST else 6.0):
                r = sp.dsolve(ode, func, hint=h)
            rs = r if isinstance(r, list) else [r]
            if any(q.has(sp.Integral) or q.has(sp.Order) for q in rs):
                continue
            if real_ode and any(q.has(sp.I) for q in rs):
                if backup is None:
                    backup = r
                continue
            if any(q.lhs != func or q.rhs.has(func) for q in rs) and backup is None and tried < 3:
                backup = r      # implicit: maybe another method gives an explicit one
                continue
            return r
        except Exception:
            continue
    if backup is not None:
        return backup
    r = _linear2_exp_poly(ode, func)
    if r is not None:
        return r
    return None


def _linear_coeffs(ode, func, order):
    """ode (Eq or expr) as sum p_k(x) y^(k) + q(x): returns ([p_0..p_n], q) or None."""
    x = func.args[0]
    expr = ode.lhs - ode.rhs if isinstance(ode, sp.Equality) else ode
    expr = sp.expand(expr)
    ds = [func] + [sp.Derivative(func, (x, k)) for k in range(1, order + 1)]
    dummies = [sp.Dummy("d%d" % k) for k in range(order + 1)]
    e2 = expr
    for k in range(order, -1, -1):
        e2 = e2.subs(ds[k], dummies[k])
    if e2.has(func) or e2.has(sp.Derivative):
        return None
    try:
        poly = sp.Poly(e2, *dummies)
    except Exception:
        return None
    if poly.total_degree() > 1:
        return None
    ps = [poly.coeff_monomial(d) for d in dummies]
    q = poly.coeff_monomial(1)
    return ps, q


def _linear2_exp_poly(ode, func):
    """2nd order linear homogeneous ODE with polynomial coefficients: look for a solution e^(r x) P(x)
    and complete it by reduction of order."""
    x = func.args[0]
    lc = _linear_coeffs(ode, func, 2)
    if lc is None:
        return None
    (p0, p1, p2), q = lc
    if q != 0 or p2 == 0:
        return None
    try:
        polys = [sp.Poly(p, x) for p in (p0, p1, p2)]
    except Exception:
        return None
    if any(pp.free_symbols - {x} for pp in polys):
        return None
    d = max(pp.degree() for pp in polys)
    r = sp.Symbol("r")
    char = sum(pp.coeff_monomial(x ** d) * r ** k for k, pp in enumerate(polys))
    cands = [sp.Integer(0)]
    try:
        cands += [c_ for c_ in sp.roots(sp.Poly(char, r)).keys() if c_ not in cands]
    except Exception:
        pass
    y1 = None
    for rr in cands:
        q2, q1, q0 = p2, 2 * rr * p2 + p1, rr ** 2 * p2 + rr * p1 + p0
        for n in range(0, 7):
            cs = sp.symbols("a0:%d" % (n + 1))
            u = sum(c_ * x ** k for k, c_ in enumerate(cs))
            res = sp.expand(q2 * u.diff(x, 2) + q1 * u.diff(x) + q0 * u)
            eqs = sp.Poly(res, x).all_coeffs()
            sol = sp.solve(eqs, cs, dict=True)
            if not sol:
                continue
            uu = u.subs(sol[0])
            if uu == 0:
                continue
            free = [c_ for c_ in cs if uu.has(c_)]
            if len(free) != 1:
                continue
            uu = sp.factor(uu.subs(free[0], 1))
            y1 = sp.exp(rr * x) * uu
            break
        if y1 is not None:
            break
    if y1 is None:
        return None
    w = sp.exp(-sp.integrate(sp.cancel(p1 / p2), x))
    integ = sp.integrate(sp.simplify(w / y1 ** 2), x)
    if integ.has(sp.Integral):
        return None
    y2 = sp.simplify(sp.expand(y1 * integ))
    C1, C2 = sp.symbols("C1 C2")
    return sp.Eq(func, C1 * y1 + C2 * y2)


def _ode_consts(expr):
    return sorted([s for s in expr.free_symbols if len(s.name) >= 2 and s.name[0] == "C" and s.name[1:].isdigit()],
                  key=lambda s: int(s.name[1:]))


def _bad(v):
    return v.has(sp.nan) or v.has(sp.zoo) or v.has(sp.oo) or v.has(-sp.oo) or v.has(sp.AccumBounds)


def _apply_ics(rhs, x, ics):
    """Solve for the arbitrary constants of rhs (explicit solution) from initial/boundary conditions.
    Singular points are handled with limits (a constant multiplying a divergent term must vanish)."""
    consts = _ode_consts(rhs)
    conds = []
    forced = {}
    for key, val in ics.items():
        if isinstance(key, sp.Subs):
            order = key.expr.variable_count[0][1]
            point = key.point[0]
        else:
            order, point = 0, key.args[0]
        expr = sp.diff(rhs, x, order) if order else rhs
        try:
            v = expr.subs(x, point)
        except Exception:
            v = sp.nan
        if _bad(v):
            ex = sp.expand(expr)
            lin = True
            total = 0
            rest = ex
            for c_ in consts:
                co = ex.coeff(c_)
                if co.has(*consts):
                    lin = False
                    break
                rest = rest - co * c_
                if co == 0:
                    continue
                li = sp.limit(co, x, point)
                if _bad(li) or li.has(sp.Limit):
                    forced[c_] = 0
                else:
                    total += li * c_
            if not lin:
                v = sp.limit(expr, x, point)
            else:
                rest = sp.expand(rest)
                lr = sp.limit(rest, x, point) if rest != 0 else 0
                v = total + lr
        conds.append(sp.Eq(v, val))
    if forced:
        conds = [c_.subs(forced) for c_ in conds if c_ is not sp.true]
    conds = [c_ for c_ in conds if c_ is not sp.true and c_ != True]  # noqa: E712
    if any(c_ is sp.false or c_ == False for c_ in conds):  # noqa: E712
        return []
    free = [c_ for c_ in consts if c_ not in forced]
    sols = sp.solve(conds, free, dict=True) if conds else [{}]
    out = []
    for sub in sols:
        d = dict(forced)
        d.update(sub)
        out.append(d)
    return out


def _implicit_ics(g, func, ics):
    x = func.args[0]
    consts = _ode_consts(g.lhs - g.rhs)
    if len(consts) != 1 or len(ics) != 1:
        return None
    (key, val), = ics.items()
    if isinstance(key, sp.Subs):
        return None
    try:
        e = (g.lhs - g.rhs).subs(func, sp.Symbol("WLX`y0")).subs(x, key.args[0]).subs(sp.Symbol("WLX`y0"), val)
        ss = sp.solve(e, consts[0])
        if ss:
            return {consts[0]: ss[0]}
    except Exception:
        pass
    return None


# ----------------------------------------------------------------- NDSolve
class NDSolve(XB):
    messages = {"fail": "NDSolve no pudo plantear el sistema numérico: `1`."}
    options = {"Method": "Automatic", "MaxSteps": "Automatic", "WorkingPrecision": "MachinePrecision",
               "AccuracyGoal": "Automatic", "PrecisionGoal": "Automatic", "MaxStepSize": "Automatic",
               "StartingStepSize": "Automatic"}

    def eval(self, eqn, y, x, a, b, evaluation, options):
        "NDSolve[eqn_, y_, {x_Symbol, a_, b_}, OptionsPattern[NDSolve]]"
        try:
            return self._solve(eqn, y, x, a, b, evaluation)
        except Exception as exc:
            evaluation.message("NDSolve", "fail", String(str(exc)[:120]))
            return None

    def _solve(self, eqn, y, x, a, b, ev):
        import numpy as np

        eqs = list(eqn.elements) if eqn.has_form("List", None) else [eqn]
        ys = list(y.elements) if y.has_form("List", None) else [y]
        fnames, pure = [], []
        for yy in ys:
            if isinstance(yy, Symbol):
                fnames.append(yy.get_name())
                pure.append(True)
            else:
                fnames.append(yy.get_head_name())
                pure.append(False)
        xname = x.get_name()
        c = Conv(funcs=fnames)
        xs = c.sym(xname)
        a_v, b_v = pyval(a, ev), pyval(b, ev)
        odes, ics = [], []
        for e in eqs:
            ee = E("N", e).evaluate(ev) if False else e
            lhs, rhs = ee.elements[0], ee.elements[1]
            if is_free_of(ee, xname):
                key = DSolve._ic_key(lhs, fnames, xs, c)
                ics.append((key, c.to(rhs)))
            else:
                odes.append(c.to(lhs) - c.to(rhs))
        funcs = [sp.Function(n)(xs) for n in fnames]
        orders = []
        for f in funcs:
            o = 0
            for ode in odes:
                for d in ode.atoms(sp.Derivative):
                    if d.expr == f:
                        o = max(o, d.variable_count[0][1])
            orders.append(max(o, 1))
        highest = [sp.Derivative(f, (xs, o)) for f, o in zip(funcs, orders)]
        sol = sp.solve(odes, highest, dict=True)
        if not sol:
            raise ValueError("no se puede despejar la derivada de mayor orden")
        sol = sol[0]
        # state symbols
        state, rep = [], {}
        for i, (f, o) in enumerate(zip(funcs, orders)):
            for k in range(o):
                sym = sp.Symbol("u_%d_%d" % (i, k))
                state.append(sym)
        idx = 0
        slices = []
        for i, (f, o) in enumerate(zip(funcs, orders)):
            for k in range(o - 1, -1, -1):
                rep[sp.Derivative(f, (xs, k)) if k > 0 else f] = sp.Symbol("u_%d_%d" % (i, k))
            slices.append((idx, o))
            idx += o
        rhs = []
        for i, (f, o) in enumerate(zip(funcs, orders)):
            for k in range(o - 1):
                rhs.append(sp.Symbol("u_%d_%d" % (i, k + 1)))
            expr = sol[highest[i]]
            for k in range(o - 1, 0, -1):
                expr = expr.subs(sp.Derivative(f, (xs, k)), sp.Symbol("u_%d_%d" % (i, k)))
            expr = expr.subs(f, sp.Symbol("u_%d_0" % i))
            rhs.append(expr)
        fn = sp.lambdify([xs] + state, rhs, modules=[NUMPY_EXTRA, "numpy"])
        y0 = [None] * len(state)
        x0 = None
        for key, val in ics:
            if isinstance(key, sp.Subs):
                fname = key.expr.expr.func.__name__
                order = key.expr.variable_count[0][1]
                point = key.point[0]
            else:
                fname = key.func.__name__
                order = 0
                point = key.args[0]
            i = fnames.index(fname)
            y0[slices[i][0] + order] = float(val)
            x0 = float(point)
        if x0 is None or any(v is None for v in y0):
            raise ValueError("faltan condiciones iniciales")

        def F(t, u):
            return np.array([float(v) for v in fn(t, *u)], dtype=float)

        def integrate(t0, t1, n):
            ts = np.linspace(t0, t1, n + 1)
            us = np.zeros((n + 1, len(state)))
            us[0] = y0
            h = (t1 - t0) / n
            for k in range(n):
                t, u = ts[k], us[k]
                k1 = F(t, u)
                k2 = F(t + h / 2, u + h / 2 * k1)
                k3 = F(t + h / 2, u + h / 2 * k2)
                k4 = F(t + h, u + h * k3)
                us[k + 1] = u + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
                if not np.all(np.isfinite(us[k + 1])):
                    us[k + 1:] = np.nan
                    break
            return ts, us

        n = 1500
        if x0 <= a_v + 1e-12:
            ts, us = integrate(x0, b_v, n)
        elif x0 >= b_v - 1e-12:
            ts, us = integrate(x0, a_v, n)
            ts, us = ts[::-1], us[::-1]
        else:
            t1, u1 = integrate(x0, a_v, n // 2)
            t2, u2 = integrate(x0, b_v, n // 2)
            ts = np.concatenate([t1[::-1], t2[1:]])
            us = np.concatenate([u1[::-1], u2[1:]])
        rules = []
        for i, yy in enumerate(ys):
            start, o = slices[i]
            cols = [us[:, start + k] for k in range(o)]
            # also store highest derivative
            try:
                hd = np.array([F(t, u)[start + o - 1] for t, u in zip(ts, us)])
                cols.append(hd)
            except Exception:
                pass
            pid = KERNEL.new_id({"kind": "interp", "t": ts, "cols": cols})
            dom = L(L(Real(float(ts[0])), Real(float(ts[-1]))))
            ifn = E("InterpolatingFunction", dom, Integer(pid), Integer(0))
            if pure[i]:
                rules.append(Rule(yy, ifn))
            else:
                rules.append(Rule(yy, E(ifn, x)))
        return L(L(*rules))


class InterpolatingFunction(XB):
    def eval_call(self, dom, pid, order, x, evaluation):
        "InterpolatingFunction[dom_, pid_Integer, order_Integer][x_?NumericQ]"
        import numpy as np

        p = KERNEL.registry.get(pid.value)
        if p is None:
            return None
        xv = pyval(x, evaluation)
        if xv is None or isinstance(xv, complex):
            return None
        o = order.value
        if o >= len(p["cols"]):
            return None
        return Real(float(np.interp(xv, p["t"], p["cols"][o])))

    def eval_deriv(self, n, dom, pid, order, evaluation):
        "Derivative[n_Integer][InterpolatingFunction[dom_, pid_Integer, order_Integer]]"
        return E("InterpolatingFunction", dom, pid, Integer(order.value + n.value))


class Interpolation(XB):
    options = {"InterpolationOrder": "3", "Method": "Automatic"}

    def eval(self, data, evaluation, options):
        "Interpolation[data_List, OptionsPattern[Interpolation]]"
        import numpy as np

        pts = E("N", data).evaluate(evaluation).to_python()
        try:
            if pts and not isinstance(pts[0], (list, tuple)):
                xs = np.arange(1, len(pts) + 1, dtype=float)
                ys = np.array(pts, dtype=float)
            else:
                xs = np.array([p[0] for p in pts], dtype=float)
                ys = np.array([p[1] for p in pts], dtype=float)
        except Exception:
            return None
        order = np.argsort(xs)
        xs, ys = xs[order], ys[order]
        # densify with cubic (Catmull-Rom style) for smoothness
        if len(xs) >= 4:
            dense_x = np.linspace(xs[0], xs[-1], 40 * len(xs))
            dense_y = _pchip(xs, ys, dense_x)
        else:
            dense_x, dense_y = xs, ys
        d1 = np.gradient(dense_y, dense_x) if len(dense_x) > 1 else dense_y * 0
        pid = KERNEL.new_id({"kind": "interp", "t": dense_x, "cols": [dense_y, d1]})
        return E("InterpolatingFunction", L(L(Real(float(xs[0])), Real(float(xs[-1])))), Integer(pid), Integer(0))


def _pchip(x, y, xi):
    import numpy as np

    n = len(x)
    h = np.diff(x)
    delta = np.diff(y) / h
    d = np.zeros(n)
    d[0], d[-1] = delta[0], delta[-1]
    for k in range(1, n - 1):
        d[k] = (delta[k - 1] + delta[k]) / 2
    idx = np.clip(np.searchsorted(x, xi) - 1, 0, n - 2)
    t = (xi - x[idx]) / h[idx]
    h00 = 2 * t ** 3 - 3 * t ** 2 + 1
    h10 = t ** 3 - 2 * t ** 2 + t
    h01 = -2 * t ** 3 + 3 * t ** 2
    h11 = t ** 3 - t ** 2
    return h00 * y[idx] + h10 * h[idx] * d[idx] + h01 * y[idx + 1] + h11 * h[idx] * d[idx + 1]


# ------------------------------------------------------------------ NSolve
class NSolve(XB):
    options = {"WorkingPrecision": "MachinePrecision"}

    def eval(self, eqs, vars, evaluation, options):
        "NSolve[eqs_, vars_, OptionsPattern[NSolve]]"
        return self._go(eqs, vars, evaluation)

    def eval_dom(self, eqs, vars, dom, evaluation, options):
        "NSolve[eqs_, vars_, dom_Symbol, OptionsPattern[NSolve]]"
        res = self._go(eqs, vars, evaluation)
        if res is None or dom.get_name() != "System`Reals":
            return res
        keep = []
        for sol in res.elements:
            ok = True
            for r in sol.elements:
                v = pyval(r.elements[1], evaluation)
                if isinstance(v, complex) and abs(v.imag) > 1e-9:
                    ok = False
            if ok:
                keep.append(sol)
        return L(*keep)

    def _go(self, eqs, vars, ev):
        if isinstance(vars, Symbol) and eqs.get_head_name() == "System`Equal":
            c = Conv()
            try:
                expr = c.to(eqs.elements[0]) - c.to(eqs.elements[1])
                x = c.sym(vars.get_name())
                num = sp.numer(sp.together(expr))
                poly = sp.Poly(num, x)
                if poly.free_symbols == {x} or not poly.free_symbols - {x}:
                    roots = poly.nroots(n=15, maxsteps=200)
                    roots = sorted(roots, key=lambda r: (abs(sp.im(r)) > 1e-12, sp.re(r), sp.im(r)))
                    out = []
                    for r in roots:
                        re_, im_ = float(sp.re(r)), float(sp.im(r))
                        if abs(im_) < 1e-12:
                            val = Real(re_)
                        else:
                            val = E("Complex", Real(re_), Real(im_)).evaluate(ev)
                        out.append(L(Rule(vars, val)))
                    return L(*out)
            except Exception:
                pass
        res = E("Solve", eqs, vars).evaluate(ev)
        if res.get_head_name() == "System`Solve":
            return None
        return E("N", res).evaluate(ev)


# ----------------------------------------------------------------- Residue
def _fast_residue(fs, zs, p):
    """Residue at a pole that is visible as explicit factors of the denominator: remove them structurally and
    differentiate (no series expansion). None if the structure is not that simple."""
    num, den = sp.fraction(fs)
    if not den.has(zs):
        return None
    m = 0
    coef = sp.Integer(1)
    rest = sp.Integer(1)
    for fac in sp.Mul.make_args(den):
        base, ex = (fac.base, fac.exp) if isinstance(fac, sp.Pow) else (fac, sp.Integer(1))
        if not base.has(zs):
            rest *= fac
            continue
        v = base.subs(zs, p)
        try:
            zero = v == 0 or sp.simplify(v) == 0 or (v.is_number and abs(complex(sp.N(v, 30))) < 1e-25)
        except Exception:
            return None
        if not zero:
            rest *= fac
            continue
        if not (ex.is_Integer and ex > 0) or not base.is_polynomial(zs):
            return None
        pb = sp.Poly(base, zs)
        q, r = sp.div(pb, sp.Poly(zs - p, zs))
        if sp.simplify(r.as_expr()) != 0:
            return None
        qe = q.as_expr()
        if sp.simplify(qe.subs(zs, p)) == 0:
            return None                         # repeated root inside the factor: let the general code do it
        m += int(ex)
        rest *= qe ** ex
    if m == 0:
        return None
    try:
        nv = num.subs(zs, p)
        if nv.has(sp.nan, sp.zoo) or sp.N(rest.subs(zs, p)) == 0:
            return None
    except Exception:
        return None
    g = num / rest
    if m > 1:
        g = sp.diff(g, zs, m - 1) / sp.factorial(m - 1)
    return g.subs(zs, p)


class Residue(XB):
    def eval(self, f, z, z0, evaluation):
        "Residue[f_, {z_Symbol, z0_}]"
        c = Conv()
        try:
            fs = c.to(f)
            zs = c.sym(z.get_name())
            p = c.to(z0)
            r = None
            if p not in (sp.oo, sp.zoo, -sp.oo):
                try:
                    with budget(4.0):
                        r = _fast_residue(fs, zs, p)
                except Exception:
                    _dbg()
                    r = None
            if r is None:
                with budget(9.0):
                    if p in (sp.oo, sp.zoo):
                        w = sp.Symbol("WLX`w")
                        r = sp.residue(-fs.subs(zs, 1 / w) / w ** 2, w, 0)
                    else:
                        r = sp.residue(fs, zs, p)
            try:
                with budget(3.0):
                    r2 = simp(r)
                    if r2.count_ops() <= r.count_ops():
                        r = r2
            except Exception:
                pass
            return c.back(r).evaluate(evaluation)
        except Exception:
            # numeric fallback through a small contour integral
            try:
                p = pyval(z0, evaluation)
                import cmath

                tot = 0
                n = 400
                rad = 1e-3
                for k in range(n):
                    th = 2 * math.pi * (k + 0.5) / n
                    zz = p + rad * cmath.exp(1j * th)
                    v = pyval(E("ReplaceAll", f, Rule(z, E("Complex", Real(zz.real), Real(zz.imag)))), evaluation)
                    tot += v * 1j * rad * cmath.exp(1j * th) * (2 * math.pi / n)
                r = tot / (2j * math.pi)
                return E("Chop", E("Complex", Real(r.real), Real(r.imag))).evaluate(evaluation)
            except Exception:
                return None


# ----------------------------------------------------- Fourier transforms
def _fourier_params(options, ev):
    a, b = 0.0, 1.0
    fp = options.get("System`FourierParameters")
    asym, bsym = sp.Integer(0), sp.Integer(1)
    if fp is not None and fp.has_form("List", 2):
        c = Conv()
        asym, bsym = c.to(fp.elements[0]), c.to(fp.elements[1])
    return asym, bsym


class FourierTransform(XB):
    options = {"FourierParameters": "{0, 1}", "Assumptions": "$Assumptions", "GenerateConditions": "False"}

    def eval(self, f, t, w, evaluation, options):
        "FourierTransform[f_, t_Symbol, w_, OptionsPattern[FourierTransform]]"
        a, b = _fourier_params(options, evaluation)
        return _ft(f, t, w, a, b, +1, evaluation)


class InverseFourierTransform(XB):
    options = {"FourierParameters": "{0, 1}", "Assumptions": "$Assumptions", "GenerateConditions": "False"}

    def eval(self, f, w, t, evaluation, options):
        "InverseFourierTransform[f_, w_Symbol, t_, OptionsPattern[InverseFourierTransform]]"
        a, b = _fourier_params(options, evaluation)
        return _ft(f, w, t, a, b, -1, evaluation)


def _ft(f, t, w, a, b, sign, ev):
    """WL convention: sqrt(|b|/(2 pi)^(1-a)) Int f(t) e^{i b w t} dt ; inverse: sqrt(|b|/(2pi)^(1+a)) Int F e^{-i b w t} dw"""
    from . import calc

    tn = t.get_name()
    c = Conv(real=[tn] + [nm for nm in _user_symbols(f) if nm != tn])
    try:
        fs = _heaviside_fix(c.to(f))
        if fs.atoms(sp.core.function.AppliedUndef):
            return None
        ts = c.sym(tn)
        wr = sp.Symbol("WLX`wr", real=True)
        expo = (1 - a) if sign > 0 else (1 + a)
        pref = sp.sqrt(sp.Abs(b) / (2 * sp.pi) ** expo)
        res = None
        try:
            with budget(10.0):
                # G(W) = Int f e^{i sgn W t} dt with W = b w  (b may be negative: handled by the substitution)
                W = sp.Symbol("WLX`W", real=True)
                G = calc.fourier_core(fs, ts, W, sign)
                if G is not None:
                    res = G.subs(W, b * wr)
                    if res.has(sp.DiracDelta):
                        res = res.replace(lambda e: isinstance(e, sp.DiracDelta) and len(e.args) == 1 and
                                          sp.simplify(e.args[0] / wr).is_number,
                                          lambda e: sp.DiracDelta(wr) / sp.Abs(sp.simplify(e.args[0] / wr)))
                    res = res.replace(lambda e: isinstance(e, sp.Heaviside) and sp.simplify(e.args[0] / wr).is_number
                                      and e.args[0] != wr and e.args[0] != -wr,
                                      lambda e: sp.Heaviside(wr if sp.simplify(e.args[0] / wr) > 0 else -wr))
                    res = res.replace(lambda e: isinstance(e, sp.Abs) and sp.simplify(e.args[0] / wr).is_number,
                                      lambda e: sp.Abs(sp.simplify(e.args[0] / wr)) * sp.Abs(wr))
        except Exception:
            _dbg()
            res = None
        if res is None:
            with budget(8.0):
                k = sp.Symbol("WLX`k", real=True)
                Fk = sp.fourier_transform(fs, ts, k)
                if Fk.has(sp.FourierTransform) or Fk.has(sp.Integral):
                    val = sp.integrate(fs * sp.exp(sign * sp.I * b * wr * ts), (ts, -sp.oo, sp.oo), conds="none")
                    if val.has(sp.Integral):
                        return None
                    res = val
                else:
                    res = Fk.subs(k, -sign * b * wr / (2 * sp.pi))
                res = simp(res)
        res = pref * res
        try:
            if res.count_ops() < 300:
                res = sp.simplify(res)
        except Exception:
            pass
        res = res.subs(wr, c.to(w))
        res = _heaviside_fix(res)
        return c.back(res).evaluate(ev)
    except Exception:
        _dbg()
        return None


class FourierSinTransform(XB):
    options = {"FourierParameters": "{0, 1}"}

    def eval(self, f, t, w, evaluation, options):
        "FourierSinTransform[f_, t_Symbol, w_, OptionsPattern[FourierSinTransform]]"
        return _sincos(f, t, w, sp.sin, 1, options, evaluation)


class FourierCosTransform(XB):
    options = {"FourierParameters": "{0, 1}"}

    def eval(self, f, t, w, evaluation, options):
        "FourierCosTransform[f_, t_Symbol, w_, OptionsPattern[FourierCosTransform]]"
        return _sincos(f, t, w, sp.cos, 1, options, evaluation)


class InverseFourierSinTransform(XB):
    options = {"FourierParameters": "{0, 1}"}

    def eval(self, f, t, w, evaluation, options):
        "InverseFourierSinTransform[f_, t_Symbol, w_, OptionsPattern[InverseFourierSinTransform]]"
        return _sincos(f, t, w, sp.sin, -1, options, evaluation)


class InverseFourierCosTransform(XB):
    options = {"FourierParameters": "{0, 1}"}

    def eval(self, f, t, w, evaluation, options):
        "InverseFourierCosTransform[f_, t_Symbol, w_, OptionsPattern[InverseFourierCosTransform]]"
        return _sincos(f, t, w, sp.cos, -1, options, evaluation)


def _sincos(f, t, w, trig, sign, options, ev):
    a, b = _fourier_params(options, ev)
    c = Conv(positive=[t.get_name()])
    try:
        fs = _heaviside_fix(c.to(f))
        ts = c.sym(t.get_name())
        wp = sp.Symbol("WLX`wp", positive=True)
        val = sp.integrate(fs * trig(b * wp * ts), (ts, 0, sp.oo), conds="none")
        if val.has(sp.Integral):
            return None
        expo = (1 - a) if sign > 0 else (1 + a)
        res = 2 * sp.sqrt(sp.Abs(b) / (2 * sp.pi) ** expo) * val
        res = simp(res).subs(wp, c.to(w))
        return c.back(res).evaluate(ev)
    except Exception:
        return None


# ------------------------------------------------------------ Fourier series
def _fs_setup(f, x, options, ev):
    a, b = _fourier_params(options, ev)
    c = Conv(real=[x.get_name()])
    fs = _heaviside_fix(c.to(f))
    xs = c.sym(x.get_name())
    half = sp.pi / sp.Abs(b)
    return c, fs, xs, b, half


def _integ(expr, xs, lo, hi):
    from . import calc

    try:
        val = calc.definite_fast(expr, xs, sp.sympify(lo), sp.sympify(hi))
        if val is not None:
            return sp.simplify(val) if val.count_ops() < 200 else val
    except SympyTimeout:
        raise
    except Exception:
        pass
    val = sp.integrate(expr, (xs, lo, hi))
    if val.has(sp.Integral):
        val = sp.integrate(sp.piecewise_fold(expr), (xs, lo, hi))
    return sp.simplify(val)


def _coef_formula(make, xs, lo, hi, nmax):
    """[c_1 .. c_nmax] with c_k = Integral make(k) dx: one symbolic integration in k, then substitution
    (falls back to one integral per k where the general formula is singular)."""
    from . import calc

    k = sp.Symbol("WLX`kk", integer=True, positive=True)
    gen = None
    if nmax > 4:
        try:
            with budget(6.0):
                gen = calc.definite_fast(make(k), xs, sp.sympify(lo), sp.sympify(hi))
        except SympyTimeout:
            gen = None
        except Exception:
            gen = None
    out = []
    for j in range(1, nmax + 1):
        v = None
        if gen is not None:
            try:
                v = gen.subs(k, j)
                if v.has(sp.nan, sp.zoo, sp.oo):
                    v = None
                else:
                    v = sp.simplify(v) if 40 < v.count_ops() < 120 else v
            except SympyTimeout:
                raise
            except Exception:
                v = None
        if v is None:
            v = _integ(make(j), xs, lo, hi)
        out.append(v)
    return out


class FourierTrigSeries(XB):
    options = {"FourierParameters": "{1, 1}", "Assumptions": "$Assumptions"}

    def eval(self, f, x, n, evaluation, options):
        "FourierTrigSeries[f_, x_Symbol, n_Integer, OptionsPattern[FourierTrigSeries]]"
        try:
            c, fs, xs, b, half = _fs_setup(f, x, options, evaluation)
            a0 = _integ(fs, xs, -half, half) / (2 * half)
            total = a0
            aks = _coef_formula(lambda k: fs * sp.cos(b * k * xs), xs, -half, half, n.value)
            bks = _coef_formula(lambda k: fs * sp.sin(b * k * xs), xs, -half, half, n.value)
            for k in range(1, n.value + 1):
                total += aks[k - 1] / half * sp.cos(b * k * xs) + bks[k - 1] / half * sp.sin(b * k * xs)
            return c.back(total).evaluate(evaluation)
        except Exception:
            _dbg()
            return None


class FourierSeries(XB):
    options = {"FourierParameters": "{1, 1}", "Assumptions": "$Assumptions"}

    def eval(self, f, x, n, evaluation, options):
        "FourierSeries[f_, x_Symbol, n_Integer, OptionsPattern[FourierSeries]]"
        try:
            c, fs, xs, b, half = _fs_setup(f, x, options, evaluation)
            total = 0
            for k in range(-n.value, n.value + 1):
                ck = _integ(fs * sp.exp(-sp.I * b * k * xs), xs, -half, half) / (2 * half)
                total += ck * sp.exp(sp.I * b * k * xs)
            return c.back(total).evaluate(evaluation)
        except Exception:
            return None


class FourierCoefficient(XB):
    options = {"FourierParameters": "{1, 1}", "Assumptions": "$Assumptions"}

    def eval(self, f, x, n, evaluation, options):
        "FourierCoefficient[f_, x_Symbol, n_, OptionsPattern[FourierCoefficient]]"
        try:
            c, fs, xs, b, half = _fs_setup(f, x, options, evaluation)
            ns = c.to(n)
            if isinstance(ns, sp.Symbol):
                c.integer.add(n.get_name())
                c.syms.pop(n.get_name(), None)
                ns = c.to(n)
            ck = _integ(fs * sp.exp(-sp.I * b * ns * xs), xs, -half, half) / (2 * half)
            return c.back(ck).evaluate(evaluation)
        except Exception:
            return None


class FourierSinCoefficient(XB):
    options = {"FourierParameters": "{1, 1}", "Assumptions": "$Assumptions"}

    def eval(self, f, x, n, evaluation, options):
        "FourierSinCoefficient[f_, x_Symbol, n_, OptionsPattern[FourierSinCoefficient]]"
        return _trigcoef(f, x, n, sp.sin, options, evaluation)


class FourierCosCoefficient(XB):
    options = {"FourierParameters": "{1, 1}", "Assumptions": "$Assumptions"}

    def eval(self, f, x, n, evaluation, options):
        "FourierCosCoefficient[f_, x_Symbol, n_, OptionsPattern[FourierCosCoefficient]]"
        return _trigcoef(f, x, n, sp.cos, options, evaluation)


def _trigcoef(f, x, n, trig, options, ev):
    try:
        c, fs, xs, b, half = _fs_setup(f, x, options, ev)
        if isinstance(n, Symbol):
            c.integer.add(n.get_name())
        ns = c.to(n)
        val = _integ(fs * trig(b * ns * xs), xs, -half, half) / half
        if trig is sp.cos and ns == 0:
            val = val / 2
        return c.back(val).evaluate(ev)
    except Exception:
        return None


class FourierSinSeries(XB):
    options = {"FourierParameters": "{1, 1}"}

    def eval(self, f, x, n, evaluation, options):
        "FourierSinSeries[f_, x_Symbol, n_Integer, OptionsPattern[FourierSinSeries]]"
        try:
            c, fs, xs, b, half = _fs_setup(f, x, options, evaluation)
            total = 0
            for k in range(1, n.value + 1):
                bk = 2 * _integ(fs * sp.sin(b * k * xs), xs, 0, half) / half
                total += bk * sp.sin(b * k * xs)
            return c.back(total).evaluate(evaluation)
        except Exception:
            return None


class FourierCosSeries(XB):
    options = {"FourierParameters": "{1, 1}"}

    def eval(self, f, x, n, evaluation, options):
        "FourierCosSeries[f_, x_Symbol, n_Integer, OptionsPattern[FourierCosSeries]]"
        try:
            c, fs, xs, b, half = _fs_setup(f, x, options, evaluation)
            total = _integ(fs, xs, 0, half) / half
            for k in range(1, n.value + 1):
                ak = 2 * _integ(fs * sp.cos(b * k * xs), xs, 0, half) / half
                total += ak * sp.cos(b * k * xs)
            return c.back(total).evaluate(evaluation)
        except Exception:
            return None


# ------------------------------------------------------------- Z transform
class ZTransform(XB):
    def eval(self, f, n, z, evaluation):
        "ZTransform[f_, n_Symbol, z_]"
        from . import calc

        nn = n.get_name()
        c = Conv(integer=[nn], real=[nm for nm in _user_symbols(f) if nm != nn])
        try:
            if not is_free_of(f, "System`DiscreteDelta") or not is_free_of(f, "System`KroneckerDelta"):
                return None
            fs = c.to(f)
            if fs.atoms(sp.core.function.AppliedUndef):
                return None
            ns = c.to(n)
            zp = sp.Symbol("WLX`z", positive=True)
            with budget(8.0):
                val = None
                terms = calc.exp_poly_terms(fs, ns)
                if terms is not None:
                    # sum_n c n^k (e^a)^n z^-n  with  sum n^k q^n = (q d/dq)^k 1/(1-q)
                    q = sp.Symbol("WLX`q")
                    val = 0
                    for al, d in terms.items():
                        for k, cf in d.items():
                            g = 1 / (1 - q)
                            for _ in range(k):
                                g = sp.together(q * sp.diff(g, q))
                            val += cf * g.subs(q, sp.exp(al) / zp)
                    val = calc.real_form(val, real=not fs.has(sp.I))
                    val = sp.factor(sp.cancel(sp.together(val)))
                if val is None:
                    val = sp.summation(fs * zp ** (-ns), (ns, 0, sp.oo))
                    if isinstance(val, sp.Piecewise):
                        val = val.args[0][0]
                    if val.has(sp.Sum):
                        return None
                    val = sp.factor(sp.simplify(val))
            return c.back(val.subs(zp, c.to(z))).evaluate(evaluation)
        except Exception:
            _dbg()
            return None


class InverseZTransform(XB):
    def eval(self, F, z, n, evaluation):
        "InverseZTransform[F_, z_Symbol, n_]"
        c = Conv()
        try:
            Fs = c.to(F)
            zs = c.sym(z.get_name())
            ns = c.to(n)
            if not Fs.is_rational_function(zs):
                # sums of c Cos[a/z], c Sin[a/z], c E^(a/z):  a^n Cos[n Pi/2]/n!, a^n Sin[n Pi/2]/n!, a^n/n!
                tot = 0
                for term in sp.Add.make_args(sp.expand(Fs)):
                    co, fn = term.as_independent(zs)
                    a_ = sp.simplify(fn.args[0] * zs) if isinstance(fn, (sp.cos, sp.sin, sp.exp)) else None
                    if a_ is None or a_.has(zs):
                        return None
                    if isinstance(fn, sp.cos):
                        tot += co * a_ ** ns * sp.cos(ns * sp.pi / 2) / sp.factorial(ns)
                    elif isinstance(fn, sp.sin):
                        tot += co * a_ ** ns * sp.sin(ns * sp.pi / 2) / sp.factorial(ns)
                    else:
                        tot += co * a_ ** ns / sp.factorial(ns)
                return c.back(tot).evaluate(evaluation)
            G = sp.apart(sp.together(Fs / zs), zs, full=False)
            total = 0
            for term in sp.Add.make_args(G):
                num, den = sp.fraction(sp.together(term))
                if not den.has(zs):
                    # polynomial part of F/z  -> c z^k  => F has c z^(k+1): non causal; skip unless constant
                    p = sp.Poly(term, zs)
                    for (k,), coef in p.terms():
                        total += coef * sp.KroneckerDelta(ns + k + 1, 0)
                    continue
                dp = sp.Poly(den, zs)
                fac = sp.factor_list(den, zs)
                lead = fac[0]
                if len(fac[1]) != 1:
                    return None
                base, mult = fac[1][0]
                bp = sp.Poly(base, zs)
                if bp.degree() != 1:
                    # complex pair: split over complex roots
                    roots = sp.roots(dp, zs)
                    if not roots:
                        return None
                    sub = sp.apart(term, zs, full=True).doit()
                    for t2 in sp.Add.make_args(sub):
                        r = _invz_simple(t2, zs, ns)
                        if r is None:
                            return None
                        total += r
                    continue
                r = _invz_simple(term, zs, ns)
                if r is None:
                    return None
                total += r
            total = sp.simplify(total)
            if total.has(sp.I):
                try:
                    alt = sp.simplify(sp.re(sp.expand_complex(total.rewrite(sp.cos))))
                    if not alt.has(sp.I) and not alt.has(sp.re):
                        total = alt
                except Exception:
                    pass
            res = c.back(total)
            res = E("ReplaceAll", res, E("RuleDelayed", E("KroneckerDelta", E("Pattern", Symbol("WLX`a"), E("Blank")), Integer(0)),
                                           E("DiscreteDelta", Symbol("WLX`a"))))
            return res.evaluate(evaluation)
        except Exception:
            return None


def _invz_simple(term, zs, ns):
    """term = c/(z-a)^k (part of F/z) -> c * Binomial(n, k-1) a^(n-k+1)."""
    num, den = sp.fraction(sp.together(term))
    if num.has(zs):
        return None
    fac = sp.factor_list(den, zs)
    lead = fac[0]
    if len(fac[1]) != 1:
        return None
    base, k = fac[1][0]
    bp = sp.Poly(base, zs)
    if bp.degree() != 1:
        return None
    a1, a0 = bp.all_coeffs()
    a = -a0 / a1
    coef = num / (lead * a1 ** k)
    if a == 0:
        return coef * sp.KroneckerDelta(ns - (k - 1), 0)
    if k == 1:
        return coef * a ** ns
    return coef * sp.binomial(ns, k - 1) * a ** (ns - k + 1)


# ---------------------------------------------------------- misc symbolic
class SumConvergence(XB):
    def eval(self, f, n, evaluation):
        "SumConvergence[f_, n_Symbol]"
        c = Conv(integer=[n.get_name()], positive=[n.get_name()])
        try:
            fs = c.to(f)
            ns = c.sym(n.get_name())
            r = sp.Sum(fs, (ns, 1, sp.oo)).is_convergent()
            if r is sp.true or r is True:
                return SymbolTrue
            if r is sp.false or r is False:
                return SymbolFalse
            return c.back(r).evaluate(evaluation)
        except Exception:
            return None


class TrigReduce(XB):
    def eval(self, f, evaluation):
        "TrigReduce[f_]"
        c = Conv()
        try:
            fs = c.to(f)
            r = sp.expand(sp.fu(fs, measure=lambda e: e.count_ops()))
            r2 = sp.expand(sp.simplify(fs.rewrite(sp.exp)).rewrite(sp.cos)) if False else r
            # power reduction via exponential form
            ex = sp.expand(fs.rewrite(sp.exp))
            red = sp.simplify(ex.rewrite(sp.cos))
            best = min([r, red, sp.expand(red)], key=lambda e: (e.has(sp.Pow) and any(
                isinstance(p.base, (sp.sin, sp.cos)) for p in e.atoms(sp.Pow)), e.count_ops()))
            return c.back(best).evaluate(evaluation)
        except Exception:
            return None


class TrigFactor(XB):
    def eval(self, f, evaluation):
        "TrigFactor[f_]"
        c = Conv()
        try:
            return c.back(sp.factor(sp.trigsimp(c.to(f)))).evaluate(evaluation)
        except Exception:
            return None


class JordanDecomposition(XB):
    def eval(self, m, evaluation):
        "JordanDecomposition[m_List]"
        c = Conv()
        try:
            M = sp.Matrix(c.to(m))
            P, J = M.jordan_form()
            return L(c.back(simp(P)), c.back(simp(J))).evaluate(evaluation)
        except Exception:
            return None


class Fit(XB):
    def eval(self, data, funs, vars, evaluation):
        "Fit[data_List, funs_List, vars_]"
        import numpy as np

        try:
            pts = E("N", data).evaluate(evaluation).to_python()
            vlist = list(vars.elements) if vars.has_form("List", None) else [vars]
            if pts and not isinstance(pts[0], (list, tuple)):
                pts = [[i + 1, p] for i, p in enumerate(pts)]
            A = []
            for p in pts:
                rules = L(*[Rule(v, Real(float(p[i]))) for i, v in enumerate(vlist)])
                row = [pyval(E("ReplaceAll", fn, rules), evaluation) for fn in funs.elements]
                A.append(row)
            A = np.array(A, dtype=float)
            b = np.array([p[len(vlist)] for p in pts], dtype=float)
            coef, *_ = np.linalg.lstsq(A, b, rcond=None)
            scale = float(np.max(np.abs(coef))) or 1.0
            coef = np.array([0.0 if abs(cf) < 1e-13 * scale else float(cf) for cf in coef])
            terms = [E("Times", Real(float(cf)), fn) for cf, fn in zip(coef, funs.elements)]
            return E("Plus", *terms).evaluate(evaluation)
        except Exception:
            return None


class InterpolatingPolynomial(XB):
    def eval(self, data, x, evaluation):
        "InterpolatingPolynomial[data_List, x_]"
        c = Conv()
        try:
            pts = c.to(data)
            if pts and not isinstance(pts[0], list):
                pts = [[i + 1, p] for i, p in enumerate(pts)]
            xs = sp.Symbol("WLX`x")
            poly = sp.interpolate([(p[0], p[1]) for p in pts], xs)
            poly = sp.expand(poly).subs(xs, c.to(x))
            return c.back(poly).evaluate(evaluation)
        except Exception:
            return None


class PolynomialQuotient(XB):
    def eval(self, p, q, x, evaluation):
        "PolynomialQuotient[p_, q_, x_Symbol]"
        c = Conv()
        try:
            return c.back(sp.div(c.to(p), c.to(q), c.sym(x.get_name()))[0]).evaluate(evaluation)
        except Exception:
            return None


class PolynomialRemainder(XB):
    def eval(self, p, q, x, evaluation):
        "PolynomialRemainder[p_, q_, x_Symbol]"
        c = Conv()
        try:
            return c.back(sp.div(c.to(p), c.to(q), c.sym(x.get_name()))[1]).evaluate(evaluation)
        except Exception:
            return None


class Reduce(XB):
    def eval(self, expr, vars, evaluation):
        "Reduce[expr_, vars_]"
        return self._go(expr, vars, None, evaluation)

    def eval_dom(self, expr, vars, dom, evaluation):
        "Reduce[expr_, vars_, dom_Symbol]"
        return self._go(expr, vars, dom, evaluation)

    def _go(self, expr, vars, dom, ev):
        vlist = list(vars.elements) if vars.has_form("List", None) else [vars]
        try:
            c = Conv(real=[v.get_name() for v in vlist])
            cond = c.to(expr)
            if isinstance(cond, list):
                cond = sp.And(*cond)
            if len(vlist) == 1:
                x = c.sym(vlist[0].get_name())
                if cond.has(sp.Lt, sp.Le, sp.Gt, sp.Ge) or (dom is not None and short(dom) == "Reals"):
                    sol = sp.solveset(cond, x, domain=sp.S.Reals) if isinstance(cond, sp.Eq) else \
                        sp.reduce_inequalities(cond, x) if not isinstance(cond, (sp.And, sp.Or)) else \
                        sp.reduce_inequalities(list(cond.args), x) if isinstance(cond, sp.And) else None
                    if sol is None:
                        return None
                    if isinstance(sol, sp.Set):
                        sol = sol.as_relational(x)
                    sol = self._clean(sol)
                    return c.back(sol).evaluate(ev)
            res = E("Solve", expr, vars).evaluate(ev)
            if res.get_head_name() == "System`Solve":
                return None
            ors = []
            for s in res.elements:
                ands = [E("Equal", r.elements[0], r.elements[1]) for r in s.elements]
                ors.append(ands[0] if len(ands) == 1 else E("And", *ands))
            if not ors:
                return SymbolFalse
            return ors[0] if len(ors) == 1 else E("Or", *ors)
        except Exception:
            return None

    @staticmethod
    def _clean(sol):
        def drop(e):
            if isinstance(e, (sp.Lt, sp.Gt, sp.Le, sp.Ge)) and (e.has(sp.oo) or e.has(-sp.oo)):
                return sp.true
            return e
        return sol.replace(lambda e: isinstance(e, (sp.Lt, sp.Gt, sp.Le, sp.Ge)), drop) if hasattr(sol, "replace") else sol


class XSympySimplify(XB):
    """WLX`SimplifyAssuming[expr, assum] : simplification honoring simple assumptions."""
    name = "SimplifyAssuming"
    context = "WLX`"

    def eval(self, expr, assum, evaluation):
        "WLX`SimplifyAssuming[expr_, assum_]"
        try:
            pos, real, integer = current_assumptions(evaluation, assum)
            c = Conv(positive=pos, real=real, integer=integer, negative=set(_LAST_NEG))
            s = c.to(expr)
            r = sp.simplify(s)
            try:
                r2 = sp.refine(r)
                r = r2
            except Exception:
                pass
            cands = [r]
            try:
                cands.append(sp.powdenest(sp.powsimp(r, force=False), force=False))
            except Exception:
                pass
            best = min(cands, key=lambda e: e.count_ops())
            return c.back(best).evaluate(evaluation)
        except Exception:
            return expr

    def _collect(self, a, pos, real, integer):
        hn = a.get_head_name()
        if hn in ("System`And", "System`List"):
            for e in a.elements:
                self._collect(e, pos, real, integer)
        elif hn == "System`Greater" and len(a.elements) == 2 and isinstance(a.elements[0], Symbol):
            v = pyval(a.elements[1], KERNEL.ev)
            if v is not None and not isinstance(v, complex) and v >= 0:
                pos.add(a.elements[0].get_name())
            else:
                real.add(a.elements[0].get_name())
        elif hn == "System`Less" and len(a.elements) == 2 and isinstance(a.elements[1], Symbol):
            v = pyval(a.elements[0], KERNEL.ev)
            if v is not None and not isinstance(v, complex) and v >= 0:
                pos.add(a.elements[1].get_name())
            else:
                real.add(a.elements[1].get_name())
        elif hn in ("System`Less", "System`LessEqual", "System`GreaterEqual", "System`Greater", "System`Inequality"):
            for e in a.elements:
                if isinstance(e, Symbol) and not e.get_name().startswith("System`"):
                    real.add(e.get_name())
        elif hn == "System`Element" and len(a.elements) == 2:
            dom = short(a.elements[1])
            vs = a.elements[0].elements if a.elements[0].has_form("List", None) or \
                a.elements[0].get_head_name() == "System`Alternatives" else [a.elements[0]]
            for v in vs:
                if isinstance(v, Symbol):
                    if dom == "Reals":
                        real.add(v.get_name())
                    elif dom == "Integers":
                        integer.add(v.get_name())
                        real.add(v.get_name())


def collect_assumptions(a, pos, real, integer, neg=None):
    """Read simple assumptions (x > 0, a < b, Element[n, Integers], lists/And of those) into name sets."""
    if a is None:
        return
    hn = a.get_head_name()
    if hn in ("System`And", "System`List"):
        for e in a.elements:
            collect_assumptions(e, pos, real, integer, neg)
        return
    el = a.elements if isinstance(a, Expression) else ()

    def num(e):
        v = pyval(e, KERNEL.ev)
        return v if v is not None and not isinstance(v, complex) else None

    def usersym(e):
        return isinstance(e, Symbol) and not e.get_name().startswith("System`")
    if hn in ("System`Greater", "System`GreaterEqual", "System`Less", "System`LessEqual") and len(el) == 2:
        lo, hi = (el[1], el[0]) if hn.startswith("System`Greater") else (el[0], el[1])   # lo < hi
        strict = hn in ("System`Greater", "System`Less")
        if usersym(hi):
            v = num(lo)
            if v is not None and (v > 0 or (v == 0 and strict)):
                pos.add(hi.get_name())
            else:
                real.add(hi.get_name())
        if usersym(lo):
            v = num(hi)
            if neg is not None and v is not None and (v < 0 or (v == 0 and strict)):
                neg.add(lo.get_name())
            real.add(lo.get_name())
        for e in el:
            if isinstance(e, Expression):
                for nm in _user_symbols(e):
                    real.add(nm)
    elif hn in ("System`Less", "System`LessEqual", "System`GreaterEqual", "System`Greater", "System`Inequality"):
        for e in el:
            if usersym(e):
                real.add(e.get_name())
        # 0 < x < 1 style
        if hn in ("System`Less", "System`LessEqual") and len(el) >= 3:
            v = num(el[0])
            if v is not None and v >= 0:
                for e in el[1:]:
                    if usersym(e):
                        pos.add(e.get_name())
        if hn == "System`Inequality" and len(el) >= 3 and short(el[1]) in ("Less", "LessEqual"):
            v = num(el[0])
            if v is not None and v >= 0:
                for e in el[2::2]:
                    if usersym(e):
                        pos.add(e.get_name())
    elif hn == "System`Element" and len(el) == 2:
        dom = short(el[1])
        vs = el[0].elements if el[0].has_form("List", None) or \
            el[0].get_head_name() == "System`Alternatives" else [el[0]]
        for v in vs:
            if isinstance(v, Symbol):
                if dom == "Reals":
                    real.add(v.get_name())
                elif dom == "Integers":
                    integer.add(v.get_name())
                    real.add(v.get_name())
                elif dom in ("PositiveReals", "PositiveIntegers"):
                    pos.add(v.get_name())
                    if dom == "PositiveIntegers":
                        integer.add(v.get_name())


def _user_symbols(e, acc=None):
    acc = [] if acc is None else acc
    if isinstance(e, Symbol):
        n = e.get_name()
        if not n.startswith("System`") and n not in acc:
            acc.append(n)
    elif isinstance(e, Expression):
        h = e.get_head()
        if isinstance(h, Expression):
            _user_symbols(h, acc)
        for x in e.elements:
            _user_symbols(x, acc)
    return acc


_LAST_NEG = set()


def current_assumptions(ev, extra=None):
    """($Assumptions && extra) as sets (positive, real, integer); negatives are left in _LAST_NEG."""
    pos, real, integer = set(), set(), set()
    _LAST_NEG.clear()
    try:
        a = S("$Assumptions").evaluate(ev)
        if a is not SymbolTrue:
            collect_assumptions(a, pos, real, integer, _LAST_NEG)
    except Exception:
        pass
    if extra is not None and extra is not SymbolTrue:
        collect_assumptions(extra, pos, real, integer, _LAST_NEG)
    return pos, real, integer


_RESULT = {}
_INT_SPENT = [0.0]


def _stash(key, value):
    _RESULT[key] = value
    return SymbolTrue


_PIECEWISE_HEADS = ("System`Abs", "System`Sign", "System`HeavisideTheta", "System`UnitStep", "System`Piecewise",
                    "System`Max", "System`Min", "System`Boole", "System`If", "System`UnitBox", "System`UnitTriangle",
                    "System`Ramp", "System`Floor", "System`Ceiling", "System`DiracDelta")


def _has_head(e, names):
    if isinstance(e, Expression):
        if e.get_head_name() in names:
            return True
        return any(_has_head(x, names) for x in e.elements)
    return False


def _degenerate_cond(cond):
    """True for conditions that only hold on exceptional parameter values (equalities)."""
    if cond is sp.true:
        return False
    if isinstance(cond, sp.Eq):
        return True
    if isinstance(cond, (sp.And, sp.Or)):
        if isinstance(cond, sp.And):
            return any(_degenerate_cond(a) for a in cond.args)
        return all(_degenerate_cond(a) for a in cond.args)
    return False


def _generic_branch(r, xs):
    """Piecewise whose conditions only involve parameters -> the generic branch (as Mathematica does):
    the first branch whose condition is not an exceptional equality (a == 0 ...)."""
    if isinstance(r, sp.Piecewise):
        if all(not (cond.has(xs)) for _, cond in r.args):
            conds = [cond for _, cond in r.args]
            best = None
            for val, cond in r.args:
                if _degenerate_cond(cond):
                    continue
                if cond is sp.true or cond.has(sp.Ne) or all(_degenerate_cond(c2) for c2 in conds if c2 is not cond):
                    best = val
                    break
            if best is not None and not best.has(sp.Integral):
                return _generic_branch(best, xs)
            return r
    if isinstance(r, sp.Basic) and r.has(sp.Piecewise) and not isinstance(r, sp.Piecewise):
        try:
            return r.replace(lambda e: isinstance(e, sp.Piecewise), lambda e: _generic_branch(e, xs))
        except Exception:
            return r
    return r


def _nice_cond(cond):
    """|arg(s)| < pi/2  ->  re(s) > 0, etc."""
    def fix(e):
        if isinstance(e, (sp.Lt, sp.Le)) and isinstance(e.lhs, sp.Abs) and isinstance(e.lhs.args[0], sp.arg) \
                and e.rhs == sp.pi / 2:
            return (sp.Gt if isinstance(e, sp.Lt) else sp.Ge)(sp.re(e.lhs.args[0].args[0]), 0)
        return e
    try:
        return cond.replace(lambda e: isinstance(e, (sp.Lt, sp.Le)), fix)
    except Exception:
        return cond


class IntQ(XB):
    """WLX`IntQ[f, x | {x, a, b}, assum]: True if our SymPy integration succeeded (result via WLX`IntGet[])."""
    name = "IntQ"
    context = "WLX`"

    def eval(self, f, spec, assum, evaluation):
        "WLX`IntQ[f_, spec_, assum_]"
        if _INT_SPENT[0] > 12.0 or not is_free_of(f, "System`Integrate"):
            # this cell already burnt its symbolic-integration allowance: leave the rest unevaluated
            SKIP_ONCE["System`Integrate"] = E("Integrate", f, spec)
            return SymbolFalse
        t_start = time.time()
        self._converted = False
        try:
            with budget(10.0):
                r = self._go(f, spec, assum, evaluation)
            if r is None:
                _INT_SPENT[0] += time.time() - t_start
                if self._converted:
                    # SymPy could not do it: Mathics' own attempt (same SymPy, weaker bridge) only adds time and
                    # half-evaluated garbage, so the integral stays unevaluated as in Mathematica
                    SKIP_ONCE["System`Integrate"] = E("Integrate", f, spec)
            if r is not None and is_free_of(E("List", f, spec), "System`I") and \
                    not _has_head(E("List", f, spec), ("System`Complex",)) and \
                    (not is_free_of(r, "System`I") or _has_head(r, ("System`Complex",))):
                # real input, complex-looking output: never show that (Mathics' own Integrate gets its chance)
                r2 = E("Simplify", E("ExpToTrig", r)).evaluate(evaluation)
                r = r2 if is_free_of(r2, "System`I") and not _has_head(r2, ("System`Complex",)) else None
        except SympyTimeout:
            _INT_SPENT[0] += time.time() - t_start
            SKIP_ONCE["System`Integrate"] = E("Integrate", f, spec)
            r = None
        except Exception:
            _dbg()
            r = None
        if r is None:
            return SymbolFalse
        return _stash("int", r)

    def _go(self, f, spec, assum, ev):
        definite = spec.has_form("List", 3)
        x = spec.elements[0] if definite else spec
        if not isinstance(x, Symbol) or x.get_name().startswith("System`"):
            return None
        if f.has_form("List", None) or f.get_head_name() in ("System`Equal", "System`Rule"):
            return None
        xn = x.get_name()
        pos, real, integer = current_assumptions(ev, assum)
        pos.discard(xn)
        piecewise = _has_head(f, _PIECEWISE_HEADS)
        if definite or piecewise:
            real = set(real) | {xn}
        if definite:
            # every symbol in a real-looking bound is real-valued (Mathematica's generic answers agree)
            for b in spec.elements[1:]:
                for nm in _user_symbols(b):
                    real.add(nm)
        c = Conv(real=real, positive=pos, integer=integer)
        fs = c.to(f)
        xs = c.sym(xn)
        if fs.atoms(sp.core.function.AppliedUndef) or fs.has(sp.Derivative, sp.Subs):
            return None
        self._converted = True
        self._conv = c
        from . import calc

        if fs.has(sp.tan, sp.cot, sp.sec, sp.csc) and fs.has(sp.sin, sp.cos, sp.exp):
            try:
                alt = fs.replace(sp.tan, lambda u: sp.sin(u) / sp.cos(u)).replace(sp.cot, lambda u: sp.cos(u) / sp.sin(u)) \
                    .replace(sp.sec, lambda u: 1 / sp.cos(u)).replace(sp.csc, lambda u: 1 / sp.sin(u))
                alt = sp.cancel(sp.together(alt))
                if not alt.has(sp.tan, sp.cot, sp.sec, sp.csc) and alt.count_ops() <= fs.count_ops() + 2:
                    fs = alt
            except SympyTimeout:
                raise
            except Exception:
                pass
        rat = None
        if fs.is_rational_function(xs) and not fs.is_polynomial(xs) and not fs.has(sp.I):
            # rational functions: real partial fractions (ArcTan/Log), never complex logarithms
            try:
                from sympy.integrals.rationaltools import ratint

                rat = ratint(sp.together(fs), xs, real=True)
                if rat.has(sp.Integral) or rat.has(sp.RootSum) or rat.has(sp.I):
                    rat = None
            except SympyTimeout:
                raise
            except Exception:
                rat = None
        if not definite and rat is not None:
            return c.back(_tidy_antiderivative(rat, xs)).evaluate(ev)
        if not definite:
            r = _heaviside_antiderivative(fs, xs) if fs.has(sp.Heaviside) else None
            if r is None and not piecewise and fs.has(sp.exp, sp.sin, sp.cos, sp.sinh, sp.cosh):
                r = calc.no_stray_complex(calc.exp_poly_antiderivative(fs, xs), fs)
                if r is not None:
                    return c.back(_tidy_antiderivative(_trig_tidy(r), xs)).evaluate(ev)
                try:
                    r = _exp_substitution(fs, xs)
                except SympyTimeout:
                    raise
                except Exception:
                    r = None
            if r is None:
                r = sp.integrate(fs, xs)
            if (r.has(sp.Integral) or r.has(sp.meijerg)) and piecewise:
                r = sp.integrate(sp.piecewise_fold(fs.rewrite(sp.Piecewise)), xs)
            if r.has(sp.Integral):
                return None
            r = _generic_branch(r, xs)
            r = _heaviside_fix(r)
            r = calc.no_stray_complex(r, fs)
            if r is None:
                return None
            return c.back(_tidy_antiderivative(r, xs)).evaluate(ev)
        a, b = c.to(spec.elements[1]), c.to(spec.elements[2])
        r = None
        if a == b:
            return Integer(0)
        inexact = bool(fs.atoms(sp.Float)) or bool(a.atoms(sp.Float)) or bool(b.atoms(sp.Float))
        if fs.has(sp.Pow) and fs.has(sp.cos, sp.sin):
            fs2 = calc.half_angle_radicals(fs, xs)
            if fs2 != fs:
                fs, piecewise = fs2, True
        if inexact and not (fs.free_symbols - {xs}) and not a.free_symbols and not b.free_symbols:
            # decimals in, decimals out: exact machinery only if it is quick
            try:
                with budget(2.5):
                    r = calc.definite_fast(fs, xs, a, b)
                    if r is None:
                        r = sp.integrate(fs, (xs, a, b))
                    if r is not None and (r.has(sp.Integral) or r.free_symbols or r is sp.nan):
                        r = None
            except Exception:
                r = None
            if r is None:
                r = calc.numeric_integral(fs, xs, a, b)
            if r is None:
                return None
            return c.back(sp.N(r)).evaluate(ev)
        try:
            r = calc.definite_fast(fs, xs, a, b)
        except SympyTimeout:
            raise
        except Exception:
            _dbg()
            r = None
        r = calc.no_stray_complex(r, fs, a, b)
        if r is not None:
            return c.back(self._finish(_trig_tidy(r))).evaluate(ev)
        contour_nv = None
        if fs.has(sp.I) and not (fs.free_symbols - {xs}) and not a.free_symbols and not b.free_symbols \
                and a not in (sp.oo, -sp.oo) and b not in (sp.oo, -sp.oo):
            # complex integrand of a real parameter (contour integral): a vanishing value is recognised at once
            from . import numeric

            contour_nv = numeric.quick_numeric(fs, xs, a, b)
            if contour_nv is not None and abs(contour_nv) < 1e-10:
                return Integer(0)
        if rat is not None and a not in (sp.oo, -sp.oo) and b not in (sp.oo, -sp.oo):
            try:
                den = sp.fraction(sp.together(fs))[1]
                if not sp.Poly(den, xs).free_symbols - {xs} and not sp.real_roots(sp.Poly(den, xs)):
                    r = rat.subs(xs, b) - rat.subs(xs, a)
                    return c.back(self._finish(r)).evaluate(ev)
            except SympyTimeout:
                raise
            except Exception:
                pass
        r = calc.no_stray_complex(self._by_pieces(fs, xs, a, b), fs, a, b) if piecewise else None
        if r is not None:
            return c.back(self._finish(r)).evaluate(ev)
        try:
            if contour_nv is not None:
                try:
                    with budget(4.0):
                        r = sp.integrate(fs, (xs, a, b))
                except SympyTimeout:
                    r = None
            else:
                r = sp.integrate(fs, (xs, a, b))
        except SympyTimeout:
            raise
        except Exception:
            r = None
        if (r is None or r.has(sp.Integral)) and contour_nv is not None:
            # no primitive: accept the quadrature when it is clearly a simple multiple of Pi (2 Pi I Res ...)
            def exact(v):
                if abs(v) < 1e-10:
                    return sp.Integer(0)
                for base in (sp.pi, sp.Integer(1)):
                    q = sp.nsimplify(v / float(base), rational=True, tolerance=1e-10)
                    if q.is_Rational and q.q <= 360:
                        return q * base
                return None
            er, ei = exact(contour_nv.real), exact(contour_nv.imag)
            if er is not None and ei is not None:
                return c.back(er + sp.I * ei).evaluate(ev)
        if r is None or r.has(sp.Integral):
            r2 = None
            if piecewise:
                try:
                    r2 = sp.integrate(sp.piecewise_fold(fs.rewrite(sp.Piecewise)), (xs, a, b))
                except SympyTimeout:
                    raise
                except Exception:
                    r2 = None
            if r2 is not None and not r2.has(sp.Integral):
                r = r2
            elif isinstance(r, sp.Piecewise) and len(r.args) == 2 and r.args[1][1] is sp.true \
                    and not r.args[0][0].has(sp.Integral) and r.args[1][0].has(sp.Integral):
                val, cond = r.args[0]
                val = self._finish(val)
                if assum is not None and assum is not SymbolTrue:
                    return c.back(val).evaluate(ev)
                return E("ConditionalExpression", c.back(val), c.back(_nice_cond(cond))).evaluate(ev)
            else:
                return None
        if r in (sp.nan, sp.oo, -sp.oo, sp.zoo) or r.has(sp.oo, sp.zoo, sp.nan):
            if not fs.free_symbols - {xs} or r in (sp.oo, -sp.oo, sp.zoo):
                ev.message("Integrate", "idiv", f, L(*spec.elements[1:]))
                SKIP_ONCE["System`Integrate"] = E("Integrate", f, spec)
            return None
        r = _generic_branch(r, xs)
        suspicious = r.has(sp.I) and not fs.has(sp.I)
        r = calc.no_stray_complex(r, fs, a, b)
        if r is None:
            return None
        r = self._finish(r)
        if fs.has(sp.I) and not (fs.free_symbols - {xs}) and not a.free_symbols and not b.free_symbols:
            # complex integrand: SymPy can take the wrong branch of a logarithm (closed contours give 0)
            r = self._branch_check(r, fs, xs, a, b)
        elif (fs.free_symbols - {xs}) or a.free_symbols or b.free_symbols:
            if not self._probe_ok(r, fs, xs, a, b, c, strict=suspicious):
                return None
        return c.back(r).evaluate(ev)

    @staticmethod
    def _probe_ok(r, fs, xs, a, b, c, strict=False):
        """Definite integral with parameters from SymPy's general machinery: compare with quadrature at two
        parameter values (SymPy sometimes returns a wrong branch, e.g. complex logs for a real area).
        True unless both probes clearly disagree."""
        from . import numeric

        if not (fs.has(sp.Pow) or fs.has(sp.log)) or r.has(sp.Piecewise) and False:
            pass
        syms = sorted((fs.free_symbols | a.free_symbols | b.free_symbols | r.free_symbols) - {xs}, key=str)
        if not syms or len(syms) > 4:
            return True
        bad = 0
        for trial in range(3 if strict else 2):
            sub = {}
            for i, s_ in enumerate(syms):
                nm = s_.name
                if nm in c.integer:
                    v = sp.Integer(2 + i + 3 * trial)
                elif nm in c.negative:
                    v = -sp.Rational(37 + 11 * i + 24 * trial, 100)
                elif strict and trial == 1 and nm not in c.positive:
                    v = -sp.Rational(83 + 9 * i, 100)       # a complex-looking primitive may be right only for x > 0
                elif strict and trial == 2:
                    v = sp.Rational(190 + 13 * i, 100)
                else:
                    v = sp.Rational(37 + 11 * i + 24 * trial, 100)
                sub[s_] = v
            try:
                lo, hi = a.subs(sub), b.subs(sub)
                if not (lo.is_real and hi.is_real) and lo not in (sp.oo, -sp.oo) and hi not in (sp.oo, -sp.oo):
                    if strict:
                        continue
                    return True
                nv = numeric.quick_numeric(fs.subs(sub), xs, lo, hi)
                if nv is None:
                    if strict:
                        continue
                    return True
                sv = complex(sp.N(r.subs(sub)))
                if sv != sv:
                    if strict:
                        continue
                    return True
                if abs(nv - sv) > 1e-5 * (1 + abs(nv)):
                    if os.environ.get("WLX_DEBUG"):
                        print("WLX_DEBUG probe mismatch", sub, nv, sv, file=__import__("sys").stderr)
                    if strict:
                        return False
                    bad += 1
                elif not strict:
                    return True
            except SympyTimeout:
                raise
            except Exception:
                return True
        return bad < 2

    @staticmethod
    def _branch_check(r, fs, xs, a, b):
        from . import numeric

        try:
            nv = numeric.quick_numeric(fs, xs, a, b)
            sv = complex(sp.N(r))
            if nv is None or abs(nv - sv) <= 1e-6 * (1 + abs(nv)):
                return r

            def exact(v):
                if abs(v) < 1e-10:
                    return sp.Integer(0)
                for base in (sp.Integer(1), sp.pi):
                    q = sp.nsimplify(v / float(base), rational=True, tolerance=1e-9)
                    if q.is_Rational and q.q <= 720:
                        return q * base
                return sp.Float(v)
            return exact(nv.real) + sp.I * exact(nv.imag)
        except Exception:
            return r

    @staticmethod
    def _by_pieces(fs, xs, a, b):
        """Piecewise integrand with numeric limits: integrate each smooth piece with SymPy."""
        from . import calc

        if a.free_symbols or b.free_symbols:
            return None
        try:
            fa = float(sp.N(a)) if a != -sp.oo else float("-inf")
            fb = float(sp.N(b)) if b != sp.oo else float("inf")
        except Exception:
            return None
        sign = 1
        if fa > fb:
            a, b, sign = b, a, -1
        pieces = calc.split_pieces(fs, xs, a, b)
        if pieces is None or len(pieces) == 1 and pieces[0][2] == fs:
            return None
        total = 0
        for lo, hi, g in pieces:
            if g == 0:
                continue
            v = calc.exp_poly_definite(g, xs, lo, hi) if lo not in (sp.oo, -sp.oo) and hi not in (sp.oo, -sp.oo) else None
            if v is None:
                v = sp.integrate(g, (xs, lo, hi))
            if v.has(sp.Integral) or v in (sp.nan,):
                return None
            total += v
        return sign * total

    @staticmethod
    def _finish(r):
        r = _heaviside_fix(r)
        if r.has(sp.polar_lift) or r.has(sp.exp_polar):
            try:
                r = sp.unpolarify(r)
            except Exception:
                pass
        try:
            if r.count_ops() < 400:
                r2 = sp.simplify(r)
                if r2.count_ops() <= r.count_ops():
                    r = r2
        except SympyTimeout:
            raise
        except Exception:
            pass
        return r


def _heaviside_antiderivative(fs, xs):
    """Int g(x) H(x - a) dx = H(x - a) (G(x) - G(a)), term by term."""
    total = 0
    for term in sp.Add.make_args(sp.expand(fs)):
        hs = [h for h in term.atoms(sp.Heaviside) if h.has(xs)]
        if not hs:
            g = sp.integrate(term, xs)
            if g.has(sp.Integral):
                return None
            total += g
            continue
        if len(hs) != 1:
            return None
        h = hs[0]
        g = term / h
        if g.has(sp.Heaviside) and any(q.has(xs) for q in g.atoms(sp.Heaviside)):
            return None
        arg = h.args[0]
        p = sp.Poly(arg, xs)
        if p.degree() != 1:
            return None
        k, m = p.all_coeffs()
        a = -m / k
        if not (k.is_positive or k.is_negative):
            return None
        G = sp.integrate(g, xs)
        if G.has(sp.Integral):
            return None
        if k.is_positive:
            total += sp.Heaviside(xs - a) * sp.expand(G - G.subs(xs, a))
        else:   # H(a - x) = 1 - H(x - a)
            total += G - sp.Heaviside(xs - a) * sp.expand(G - G.subs(xs, a))
    return total


def _trig_tidy(r):
    """Light clean-up of the closed forms produced by calc (collect common factors, no heavy simplify)."""
    try:
        if r.count_ops() > 600:
            return r
        r2 = sp.factor_terms(sp.together(r)) if r.count_ops() < 250 else r
        return r2 if r2.count_ops() <= r.count_ops() else r
    except SympyTimeout:
        raise
    except Exception:
        return r


def _tidy_antiderivative(r, xs):
    try:
        if r.has(sp.I) and not r.has(sp.exp):
            return r
        if isinstance(r, sp.Add) and r.count_ops() < 200:
            r2 = sp.factor_terms(r)
            if r2.count_ops() < r.count_ops():
                return r2
    except SympyTimeout:
        raise
    except Exception:
        pass
    return r


class IntPVQ(XB):
    """WLX`IntPVQ[f, {x, a, b}]: Cauchy principal value."""
    name = "IntPVQ"
    context = "WLX`"

    def eval(self, f, x, a, b, evaluation):
        "WLX`IntPVQ[f_, {x_Symbol, a_, b_}]"
        try:
            c = Conv(real=[x.get_name()])
            with budget(8.0):
                fs = c.to(f)
                r = sp.Integral(fs, (c.sym(x.get_name()), c.to(a), c.to(b))).principal_value()
                if r.has(sp.Integral) or r.has(sp.nan, sp.zoo, sp.oo):
                    return SymbolFalse
                r = sp.simplify(r)
            return _stash("int", c.back(r).evaluate(evaluation))
        except Exception:
            _dbg()
            return SymbolFalse


class LimitQ(XB):
    """WLX`LimitQ[f, x, a, dir, assum]: limit through SymPy (two-sided limits with different laterals give
    Indeterminate, piecewise/Mod/Abs are resolved next to the point, decimals stay decimals)."""
    name = "LimitQ"
    context = "WLX`"

    def eval(self, f, x, a, d, assum, evaluation):
        "WLX`LimitQ[f_, x_Symbol, a_, d_, assum_]"
        from . import calc

        try:
            if f.has_form("List", None):
                return SymbolFalse
            xn = x.get_name()
            pos, real, integer = current_assumptions(evaluation, assum)
            pos.discard(xn)
            c = Conv(real=set(real) | {xn}, positive=pos, integer=integer, negative=set(_LAST_NEG) - {xn})
            fs = c.to(f)
            xs = c.sym(xn)
            if fs.atoms(sp.core.function.AppliedUndef) or fs.has(sp.Derivative, sp.Subs, sp.Integral):
                return SymbolFalse
            p = c.to(a)
            inexact = bool(fs.atoms(sp.Float)) or bool(p.atoms(sp.Float)) if isinstance(p, sp.Basic) else False
            if inexact:
                from fractions import Fraction

                def near(fl):
                    # 3.27 -> 327/100, -1.2576923076923077 -> -327/260 (so that leading terms cancel as in Mathematica)
                    fr = Fraction(float(fl)).limit_denominator(10 ** 7)
                    if abs(float(fr) - float(fl)) <= 1e-13 * max(1.0, abs(float(fl))):
                        return sp.Rational(fr.numerator, fr.denominator)
                    return sp.Rational(str(fl))
                fs = fs.xreplace({q: near(q) for q in fs.atoms(sp.Float)})
                p = p.xreplace({q: near(q) for q in p.atoms(sp.Float)}) if isinstance(p, sp.Basic) else p
            dv = d.get_string_value() if isinstance(d, String) else pyval(d, evaluation)
            side = 0
            if dv in ("FromAbove", -1.0):
                side = 1
            elif dv in ("FromBelow", 1.0):
                side = -1

            def one(sd):
                g = fs
                if calc.has_piecewise(fs, xs) and p not in (sp.oo, -sp.oo) and not p.free_symbols:
                    g2 = calc.near_point(fs, xs, p, sd)
                    if g2 is not None:
                        g = g2
                return sp.limit(g, xs, p, "+" if sd > 0 else "-")

            with budget(7.0):
                if p in (sp.oo, -sp.oo):
                    if calc.has_piecewise(fs, xs):
                        return SymbolFalse
                    r = sp.limit(fs, xs, p)
                elif side:
                    r = one(side)
                else:
                    r1, r2 = one(1), one(-1)
                    if r1 == r2 or sp.simplify(r1 - r2) == 0:
                        r = r1
                    elif r1.has(sp.Limit) or r2.has(sp.Limit):
                        return SymbolFalse
                    else:
                        return _stash("limit", S("Indeterminate"))
            if r.has(sp.Limit) or r.has(sp.AccumBounds) or r is sp.nan:
                if r.has(sp.AccumBounds):
                    return _stash("limit", S("Indeterminate"))
                return SymbolFalse
            res = c.back(sp.simplify(r) if r.count_ops() < 150 else r)
            if inexact:
                res = E("N", res)
            return _stash("limit", res.evaluate(evaluation))
        except Exception:
            _dbg()
            return SymbolFalse


class LimitGet(XB):
    name = "LimitGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`LimitGet[]"
        return _RESULT.pop("limit", None)


class XNRank(XB):
    name = "NRank"
    context = "WLX`"

    def eval(self, m, evaluation):
        "WLX`NRank[m_]"
        import numpy as np

        try:
            arr = np.array(E("N", m).evaluate(evaluation).to_python(), dtype=complex)
            sv = np.linalg.svd(arr, compute_uv=False)
            tol = max(arr.shape) * (sv[0] if len(sv) else 0.0) * 1e-12
            return Integer(int((sv > tol).sum()))
        except Exception:
            return S("$Failed")


_DERIV_CACHE = {}
_DERIV_BUSY = [False]


class DerivQ(XB):
    """WLX`DerivQ[f, n]: f' of a user-defined function is computed once and remembered (Mathics recomputes the
    symbolic derivative on every call: 40 ms per f'[x] inside Table/Plot/NIntegrate)."""
    name = "DerivQ"
    context = "WLX`"

    def eval(self, f, n, evaluation):
        "WLX`DerivQ[f_Symbol, n_Integer]"
        if _DERIV_BUSY[0]:
            return SymbolFalse
        name = f.get_name()
        if name.startswith("System`") or n.value < 1:
            return SymbolFalse
        try:
            d = evaluation.definitions.get_definition(name)
            dv = d.downvalues
            if not dv:
                return SymbolFalse
            sig = tuple(id(r) for r in dv)
            key = (name, n.value)
            hit = _DERIV_CACHE.get(key)
            if hit is not None and hit[0] == sig:
                return _stash("deriv", hit[1])
            _DERIV_BUSY[0] = True
            try:
                res = E(E("Derivative", n), f).evaluate(evaluation)
            finally:
                _DERIV_BUSY[0] = False
            if res.get_head_name() != "System`Function":
                return SymbolFalse
            if len(_DERIV_CACHE) > 300:
                _DERIV_CACHE.clear()
            _DERIV_CACHE[key] = (sig, res)
            return _stash("deriv", res)
        except Exception:
            _DERIV_BUSY[0] = False
            return SymbolFalse


class DerivGet(XB):
    name = "DerivGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`DerivGet[]"
        return _RESULT.pop("deriv", None)


class IntGet(XB):
    name = "IntGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`IntGet[]"
        return _RESULT.pop("int", None)


class Dt(XB):
    """Total derivative. Dt[f, x], Dt[f, {x, n}], Dt[f] with the option Constants."""
    options = {"Constants": "{}"}

    def eval_total(self, f, evaluation, options):
        "Dt[f_, OptionsPattern[Dt]]"
        return self._top(f, None, 1, evaluation, options)

    def eval_var(self, f, x, evaluation, options):
        "Dt[f_, x_Symbol, OptionsPattern[Dt]]"
        return self._top(f, x, 1, evaluation, options)

    def eval_n(self, f, x, n, evaluation, options):
        "Dt[f_, {x_Symbol, n_Integer}, OptionsPattern[Dt]]"
        if n.value < 0:
            return None
        if n.value == 0:
            return f
        if isinstance(f, Symbol) and f.get_name() != x.get_name() and not self._const(f, self._consts(options), evaluation):
            return None
        return self._top(f, x, n.value, evaluation, options)

    @staticmethod
    def _consts(options):
        co = options.get("System`Constants")
        out = []
        if co is not None:
            for cc in (co.elements if co.has_form("List", None) else [co]):
                if isinstance(cc, Symbol):
                    out.append(cc.get_name())
        return out

    @staticmethod
    def _const(sym, consts, ev):
        n = sym.get_name()
        return n in consts or n.startswith("System`") and E("NumericQ", sym).evaluate(ev) is SymbolTrue

    def _top(self, f, x, n, ev, options):
        consts = self._consts(options)
        co = options.get("System`Constants")
        raw_list = co is not None and co.has_form("List", None)
        opt = [Rule(S("Constants"), L(*[Symbol(c_) for c_ in consts]))] if consts else []
        if isinstance(f, Symbol):
            if x is not None and f.get_name() == x.get_name():
                return Integer(1) if n == 1 else Integer(0)
            if self._const(f, consts, ev):
                return Integer(0)
            if consts and not raw_list:
                # normalise Constants -> y to Constants -> {y} (so that patterns/Solve variables match)
                return E("Dt", f, x, *opt) if x is not None else E("Dt", f, *opt)
            return None
        r = f
        for _ in range(n):
            r = self._dt(r, x, consts, opt, ev)
            if r is None:
                return None
            r = r.evaluate(ev)
        return r

    def _unknown(self, e, x, opt):
        return E("Dt", e, x, *opt) if x is not None else E("Dt", e, *opt)

    def _dt(self, e, x, consts, opt, ev):
        from .solve import replace_expr

        if isinstance(e, Symbol):
            if x is not None and e.get_name() == x.get_name():
                return Integer(1)
            if self._const(e, consts, ev):
                return Integer(0)
            return self._unknown(e, x, opt)
        if not isinstance(e, Expression):
            return Integer(0)
        hn = e.get_head_name()
        el = e.elements
        if hn in ("System`Equal", "System`List", "System`Rule", "System`Plus"):
            return E(e.get_head(), *[self._dt(q, x, consts, opt, ev) for q in el])
        if hn == "System`Times":
            terms = []
            for i, q in enumerate(el):
                d = self._dt(q, x, consts, opt, ev)
                terms.append(E("Times", *(list(el[:i]) + [d] + list(el[i + 1:]))))
            return E("Plus", *terms)
        if hn == "System`Power" and len(el) == 2:
            base, ex = el
            db, de = self._dt(base, x, consts, opt, ev), self._dt(ex, x, consts, opt, ev)
            t1 = E("Times", ex, E("Power", base, E("Plus", ex, Integer(-1))), db)
            t2 = E("Times", E("Power", base, ex), E("Log", base), de)
            return E("Plus", t1, t2)
        if hn == "System`Dt":
            # derivative of an unknown total derivative: raise the order
            inner = [q for q in el if q.get_head_name() != "System`Rule"]
            if x is not None and len(inner) == 2:
                if isinstance(inner[1], Symbol) and inner[1].get_name() == x.get_name():
                    return E("Dt", inner[0], L(x, Integer(2)), *opt)
                if inner[1].has_form("List", 2) and inner[1].elements[0].sameQ(x):
                    return E("Dt", inner[0], L(x, E("Plus", inner[1].elements[1], Integer(1))), *opt)
            return self._unknown(e, x, opt)
        # f[a1, ..., an]: chain rule with the partial derivatives of f
        dummies = [Symbol("WLX`dt%d" % i) for i in range(len(el))]
        proto = Expression(e.get_head(), *dummies)
        pairs = list(zip(dummies, el))
        terms = []
        for i, q in enumerate(el):
            dq = self._dt(q, x, consts, opt, ev)
            if isinstance(dq, Integer) and dq.value == 0:
                continue
            part = E("D", proto, dummies[i]).evaluate(ev)
            terms.append(E("Times", replace_expr(part, pairs), dq))
        return E("Plus", *terms) if terms else Integer(0)


_SERIES_CACHE = {}


class SeriesQ(XB):
    """WLX`SeriesQ[f, x, x0, n]: True if our sympy-based (Laurent-capable) series succeeded."""
    name = "SeriesQ"
    context = "WLX`"

    def eval(self, f, x, x0, n, evaluation):
        "WLX`SeriesQ[f_, x_Symbol, x0_, n_Integer]"
        c = Conv()
        try:
            fs = c.to(f)
            xs = c.sym(x.get_name())
            p = c.to(x0)
            order = n.value
            w = sp.Symbol("WLX`w")
            pref = None
            if p in (sp.oo, -sp.oo, sp.zoo):
                facs = sp.Mul.make_args(sp.powsimp(fs))
                ex = [q for q in facs if (isinstance(q, sp.exp) or (isinstance(q, sp.Pow) and q.base == sp.E)) and q.has(xs)
                      or (isinstance(q, sp.Pow) and isinstance(q.base, sp.exp) and q.base.has(xs))]
                if ex:
                    pref = sp.Mul(*ex)
                    fs = sp.Mul(*[q for q in facs if q not in ex])
                g = fs.subs(xs, 1 / w)
            else:
                g = fs.subs(xs, w + p)
            if g.free_symbols - {w} and False:
                return SymbolFalse
            ser = sp.series(g, w, 0, order + 1)
            poly = ser.removeO()
            if poly.has(sp.log(w)) or poly.has(sp.Order):
                return SymbolFalse
            poly = sp.expand(poly)
            coeffs = {}
            for term in sp.Add.make_args(poly):
                cf, e = term.as_coeff_exponent(w)
                if cf.has(w) or not e.is_Integer:
                    return SymbolFalse
                coeffs[int(e)] = coeffs.get(int(e), 0) + cf
            if not coeffs:
                nmin = order + 1
                lst = []
            else:
                nmin = min(coeffs)
                lst = [sp.simplify(coeffs.get(k, 0)) for k in range(nmin, order + 1)]
            if p in (sp.oo, -sp.oo, sp.zoo):
                # a series at Infinity is stored as a series in 1/x about 0: Mathics then displays, Normal-izes and
                # extracts coefficients correctly (its own Infinity series print as (x + -Infinity)^k)
                data = E("SeriesData", E("Power", x, Integer(-1)), Integer(0),
                         L(*[c.back(v) for v in lst]), Integer(nmin), Integer(order + 1), Integer(1))
            else:
                data = E("SeriesData", x, c.back(p), L(*[c.back(v) for v in lst]), Integer(nmin), Integer(order + 1),
                         Integer(1))
            if pref is not None:
                # essential singularity at Infinity: exponential factor times the (finite) expansion of the rest
                tot = sum(v * xs ** (-(nmin + k_)) for k_, v in enumerate(lst))
                data = E("Times", c.back(pref), c.back(tot))
            _SERIES_CACHE["last"] = data
            return SymbolTrue
        except Exception:
            return SymbolFalse


class SeriesGet(XB):
    name = "SeriesGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`SeriesGet[]"
        return _SERIES_CACHE.pop("last", None)


class XTimingNote(XB):
    name = "KernelInfo"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`KernelInfo[]"
        import mathics

        return String("Mathics3 %s + SymPy %s (Wolfram Language de código abierto)" % (mathics.__version__, sp.__version__))


def _np_heaviside(x, h0=0.5):
    import numpy as np

    return np.heaviside(x, h0)


NUMPY_EXTRA = {}


def _init_numpy_extra():
    import numpy as np

    NUMPY_EXTRA.update({
        "Heaviside": lambda x, h0=0.5: np.heaviside(x, h0),
        # -0.0 must behave as 0 (exact results use atan2(0, -r) = +Pi; IEEE gives -Pi for atan2(-0.0, -r))
        "arctan2": lambda y, x: np.arctan2(y + 0.0, x),
        "DiracDelta": lambda x: np.zeros_like(np.asarray(x, dtype=float)),
        "sign": np.sign, "Abs": np.abs, "re": np.real, "im": np.imag, "conjugate": np.conjugate,
        "arg": np.angle, "sinc": lambda x: np.sinc(np.asarray(x) / np.pi),
        "cot": lambda x: 1 / np.tan(x), "sec": lambda x: 1 / np.cos(x), "csc": lambda x: 1 / np.sin(x),
        "acot": lambda x: np.arctan(1 / x), "coth": lambda x: 1 / np.tanh(x), "sech": lambda x: 1 / np.cosh(x),
        "csch": lambda x: 1 / np.sinh(x),
    })
    try:
        import math as _m

        vec = np.vectorize
        NUMPY_EXTRA.update({
            "gamma": vec(lambda x: _m.gamma(x) if x > 0 or x != int(x) else float("nan")),
            "erf": vec(_m.erf), "erfc": vec(_m.erfc), "factorial": vec(lambda x: _m.gamma(x + 1)),
            "loggamma": vec(_m.lgamma),
        })
    except Exception:
        pass
    try:
        import mpmath

        def mp(fn):
            return np.vectorize(lambda *a: float(fn(*a)))
        NUMPY_EXTRA.update({"besselj": mp(mpmath.besselj), "bessely": mp(mpmath.bessely),
                            "besseli": mp(mpmath.besseli), "besselk": mp(mpmath.besselk),
                            "Si": mp(mpmath.si), "Ci": mp(mpmath.ci), "Ei": mp(mpmath.ei),
                            "fresnels": mp(mpmath.fresnels), "fresnelc": mp(mpmath.fresnelc),
                            "zeta": mp(mpmath.zeta), "LambertW": mp(mpmath.lambertw), "erfi": mp(mpmath.erfi),
                            "legendre": mp(mpmath.legendre), "hermite": mp(mpmath.hermite),
                            "elliptic_k": mp(mpmath.ellipk), "elliptic_e": mp(mpmath.ellipe)})
    except Exception:
        pass


BUILTINS = [LaplaceTransform, InverseLaplaceTransform, SeriesQ, SeriesGet, DSolve, NDSolve, InterpolatingFunction, Interpolation, Residue,
            FourierTransform, InverseFourierTransform, FourierSinTransform, FourierCosTransform,
            InverseFourierSinTransform, InverseFourierCosTransform, FourierTrigSeries, FourierSeries,
            FourierCoefficient, FourierSinCoefficient, FourierCosCoefficient, FourierSinSeries, FourierCosSeries,
            ZTransform, InverseZTransform, SumConvergence, TrigReduce, TrigFactor, JordanDecomposition, Fit,
            InterpolatingPolynomial, PolynomialQuotient, PolynomialRemainder, Reduce, XSympySimplify, Dt,
            IntQ, IntGet, DerivQ, DerivGet, IntPVQ, LimitQ, LimitGet, XNRank, XConvolveCausal, XConvolveGet,
            XTimingNote]


def contribute(kernel, classes):
    for cls in classes:
        try:
            inst = cls(expression=False)
            inst.contribute(kernel.defs, is_pymodule=False)
        except Exception as exc:  # pragma: no cover
            print("ext: could not load", cls.__name__, exc)


def install(kernel):
    global KERNEL
    KERNEL = kernel
    _install_watchdog()
    _init_numpy_extra()
    contribute(kernel, BUILTINS)
    from . import solve, more, numeric

    solve.install(kernel)
    more.install(kernel)
    numeric.install(kernel)
    from . import gfx

    gfx.install(kernel)
    # WL-level prelude, parsed in a private context so that its pattern/iterator
    # variables never shadow user symbols. New public names are pre-declared in System`.
    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.join(here, "prelude.wl"), encoding="utf8").read()
    from mathics.core.parser import MathicsMultiLineFeeder
    import re as _re

    defs = kernel.defs
    m = _re.search(r"\(\*PUBLIC:(.*?)\*\)", src, _re.S)
    public = _re.findall(r"[A-Za-z][A-Za-z0-9]*", m.group(1)) if m else []
    for nm in public:
        if not defs.have_definition("System`" + nm):
            defs.get_user_definition("System`" + nm, create=True)
    defs.clear_cache()
    old_ctx, old_path = defs.get_current_context(), defs.get_context_path()
    defs.set_current_context("WLX`")
    defs.set_context_path(("System`", "WLX`"))
    feeder = MathicsMultiLineFeeder(src, "<prelude>")
    ev = kernel.ev
    try:
        while not feeder.empty():
            ev.out = []
            try:
                q = ev.parse_feeder(feeder)
                if q is not None:
                    q.evaluate(ev)
            except Exception as exc:  # pragma: no cover
                print("prelude error:", exc)
            for o in ev.out or []:
                print("prelude msg:", getattr(o, "text", o))
    finally:
        defs.set_current_context(old_ctx)
        defs.set_context_path(old_path)
        defs.clear_cache()
    ev.out = []
    kernel.defs.set_line_no(0)
