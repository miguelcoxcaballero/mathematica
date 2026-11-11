# -*- coding: utf-8 -*-
"""Builtins missing in Mathics3 that the course material uses (owner: ENGINE): special functions with
numeric evaluation, algebra helpers on top of SymPy, sums and recurrences."""
import sympy as sp
from mathics.core.atoms import Integer, Real, String, Complex as MComplex
from mathics.core.attributes import A_LISTABLE, A_NUMERIC_FUNCTION, A_PROTECTED, A_READ_PROTECTED
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolFalse, SymbolTrue

from . import ext
from .conv import Conv, ConvError, S
from .ext import E, L, Rule, XB, SympyTimeout, budget, pyval, _dbg, _user_symbols, _stash, _RESULT


def _num(v):
    """python number -> Mathics number."""
    if isinstance(v, complex):
        if abs(v.imag) < 1e-300 or abs(v.imag) < 1e-16 * abs(v.real):
            return Real(v.real)
        return MComplex(Real(v.real), Real(v.imag))
    return Real(float(v))


def _special(name, mpname, nargs=1, exact=None):
    import mpmath

    def call(*args):
        fn = getattr(mpmath, mpname) if isinstance(mpname, str) else mpname
        r = fn(*args)
        return complex(r) if isinstance(r, (mpmath.mpc, complex)) else float(r)

    def ev_inexact(self, z, evaluation):
        "%(name)s[z_?InexactNumberQ]"
        v = pyval(z, evaluation)
        if v is None:
            return None
        try:
            return _num(call(v))
        except Exception:
            return None

    def ev_exact(self, z, evaluation):
        "%(name)s[z_?ExactNumberQ]"
        if exact is None:
            return None
        try:
            c = Conv()
            r = exact(c.to(z))
            if r is None or r.has(exact):
                return None
            return c.back(r).evaluate(evaluation)
        except Exception:
            return None

    return type(name, (XB,), {"attributes": A_LISTABLE | A_NUMERIC_FUNCTION | A_PROTECTED,
                              "eval": ev_inexact, "eval_exact": ev_exact, "__module__": __name__})


def _exact_small(fn):
    def g(z):
        r = fn(z)
        return r if not isinstance(r, fn) else None
    g.has = lambda *_: False
    return fn


SPECIALS = []
for _n, _m, _ex in (("Erfi", "erfi", sp.erfi), ("SinIntegral", "si", sp.Si), ("CosIntegral", "ci", sp.Ci),
                    ("SinhIntegral", "shi", sp.Shi), ("CoshIntegral", "chi", sp.Chi), ("LogIntegral", "li", sp.li),
                    ("Sinc", "sinc", sp.sinc)):
    SPECIALS.append(_special(_n, _m, 1, _ex))


class KroneckerDelta(XB):
    attributes = A_PROTECTED

    def eval(self, a, b, evaluation):
        "KroneckerDelta[a_?NumericQ, b_?NumericQ]"
        va, vb = pyval(a, evaluation), pyval(b, evaluation)
        if va is None or vb is None:
            return None
        return Integer(1) if va == vb else Integer(0)

    def eval1(self, a, evaluation):
        "KroneckerDelta[a_?NumericQ]"
        va = pyval(a, evaluation)
        if va is None:
            return None
        return Integer(1) if va == 0 else Integer(0)


class Surd(XB):
    attributes = A_NUMERIC_FUNCTION | A_PROTECTED | A_LISTABLE

    def eval(self, x, n, evaluation):
        "Surd[x_?NumericQ, n_Integer]"
        v = pyval(x, evaluation)
        nn = n.value
        if v is None or isinstance(v, complex) or nn == 0:
            return None
        if v < 0 and nn % 2 == 0:
            return None
        if v < 0:
            return E("Times", Integer(-1), E("Power", E("Times", Integer(-1), x), E("Power", n, Integer(-1)))).evaluate(evaluation)
        return E("Power", x, E("Power", n, Integer(-1))).evaluate(evaluation)


# ------------------------------------------------------------ sympy algebra
def _sympy_map(name, fn, doc=None, conv_kw=None):
    def ev(self, e, evaluation):
        "%(name)s[e_]"
        return _thread(e, evaluation, fn)
    return type(name, (XB,), {"eval": ev, "__module__": __name__})


def _thread(e, ev, fn):
    if isinstance(e, Expression) and e.get_head_name() in ("System`List", "System`Equal", "System`Rule",
                                                           "System`Less", "System`Greater", "System`LessEqual",
                                                           "System`GreaterEqual", "System`And", "System`Or"):
        parts = [_thread(x, ev, fn) for x in e.elements]
        if any(p is None for p in parts):
            return None
        return Expression(e.get_head(), *parts)
    try:
        c = Conv()
        with budget(8.0):
            r = fn(c.to(e))
        return c.back(r).evaluate(ev)
    except Exception:
        _dbg()
        return None


def _trig_expand(s_):
    return sp.expand(sp.expand_trig(s_))


def _power_expand(s_):
    r = sp.expand_log(s_, force=True)
    r = sp.powdenest(r, force=True)
    r = sp.expand_power_base(r, force=True)
    return r


def _function_expand(s_):
    return sp.simplify(sp.expand_func(s_))


def _expand_wl(s_):
    """Mathematica's Expand: distribute products and integer powers; leave exponents/logs alone."""
    return sp.expand(s_, power_exp=False, power_base=False, log=False, trig=False, complex=False, func=False)


def _expand_trig_true(s_):
    r = sp.expand(sp.expand_trig(s_))
    try:
        r2 = sp.trigsimp(r)
        if r2.count_ops() <= r.count_ops():
            r = r2
    except Exception:
        pass
    return r


TrigExpand = _sympy_map("TrigExpand", _trig_expand)
FunctionExpand = _sympy_map("FunctionExpand", _function_expand)


def _stash_map(name, key, fn):
    """WLX`<name>Q[e]: True when the SymPy-backed transformation worked (result via WLX`<name>Get[])."""
    def evq(self, e, evaluation):
        "WLX`%(name)s[e_]"
        r = _thread(e, evaluation, fn)
        if r is None:
            return SymbolFalse
        return _stash(key, r)

    def evg(self, evaluation):
        "WLX`%(name)s[]"
        return _RESULT.pop(key, None)
    evq.__doc__ = "WLX`%sQ[e_]" % name
    evg.__doc__ = "WLX`%sGet[]" % name
    q = type(name + "Q", (XB,), {"eval": evq, "context": "WLX`", "name": name + "Q", "__module__": __name__})
    g = type(name + "Get", (XB,), {"eval": evg, "context": "WLX`", "name": name + "Get", "__module__": __name__})
    return [q, g]


STASHED = _stash_map("Expand", "expand", _expand_wl) + _stash_map("ExpandTrig", "expandtrig", _expand_trig_true) + \
    _stash_map("PowerExpand", "powerexpand", _power_expand)


class PolynomialGCD(XB):
    def eval(self, p, q, evaluation):
        "PolynomialGCD[p_, q_]"
        c = Conv()
        try:
            return c.back(sp.gcd(c.to(p), c.to(q))).evaluate(evaluation)
        except Exception:
            return None


class PolynomialLCM(XB):
    def eval(self, p, q, evaluation):
        "PolynomialLCM[p_, q_]"
        c = Conv()
        try:
            return c.back(sp.expand(sp.lcm(c.to(p), c.to(q)))).evaluate(evaluation)
        except Exception:
            return None


# ------------------------------------------------------------------- sums
class NSum(XB):
    options = {"Method": "Automatic", "WorkingPrecision": "MachinePrecision", "NSumTerms": "15",
               "AccuracyGoal": "Automatic", "PrecisionGoal": "Automatic"}
    attributes = A_PROTECTED
    messages = {"div": "Sum does not converge."}

    def eval(self, f, i, a, b, evaluation, options):
        "NSum[f_, {i_Symbol, a_, b_}, OptionsPattern[NSum]]"
        import mpmath

        try:
            c = Conv(integer=[i.get_name()])
            fs = c.to(f)
            isym = c.sym(i.get_name())
            av, bv = c.to(a), c.to(b)
            if fs.free_symbols - {isym}:
                return None
            fn = sp.lambdify(isym, fs, modules=["mpmath"])
            lo = int(av)
            if bv == sp.oo:
                with budget(8.0):
                    v = mpmath.nsum(lambda k: fn(mpmath.mpf(int(k))), [lo, mpmath.inf])
            else:
                hi = int(bv)
                v = mpmath.fsum(fn(mpmath.mpf(k)) for k in range(lo, hi + 1))
            v = complex(v)
            if v != v or abs(v) == float("inf"):
                return None
            return _num(v)
        except Exception:
            _dbg()
            return None


class XSumQ(XB):
    """WLX`SumQ[f, {i, a, b}]: closed form of a sum via SymPy (infinite or symbolic limits); divergence -> message."""
    name = "SumQ"
    context = "WLX`"

    def eval(self, f, i, a, b, evaluation):
        "WLX`SumQ[f_, {i_Symbol, a_, b_}]"
        try:
            c = Conv(integer=[i.get_name()])
            f0 = f
            f = E("Block", L(i), f).evaluate(evaluation)        # Sum holds its body: a[n] must become its definition
            fs = c.to(f)
            if fs.atoms(sp.core.function.AppliedUndef):
                # unknown sequence a[k]: nothing to sum in closed form (and Mathics' attempt is slow and ugly)
                ext.SKIP_ONCE["System`Sum"] = E("Sum", f0, L(i, a, b))
                return SymbolFalse
            isym = c.sym(i.get_name())
            av, bv = c.to(a), c.to(b)
            with budget(7.0):
                if bv == sp.oo and not (fs.free_symbols - {isym}):
                    conv_ = sp.Sum(fs, (isym, av, sp.oo)).is_convergent()
                    if conv_ is sp.false or conv_ is False:
                        evaluation.message("Sum", "div")
                        return _stash("sum", E("HoldForm", E("Sum", f0, L(i, a, b))))
                r = sp.summation(fs, (isym, av, bv))
            if r.has(sp.Sum) or r is sp.nan:
                return SymbolFalse
            from .ext import _generic_branch

            r = _generic_branch(r, isym)
            if r.has(sp.Piecewise):
                return SymbolFalse
            return _stash("sum", c.back(sp.simplify(r) if r.count_ops() < 200 else r).evaluate(evaluation))
        except Exception:
            _dbg()
            return SymbolFalse


class XSumGet(XB):
    name = "SumGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`SumGet[]"
        return _RESULT.pop("sum", None)


# ------------------------------------------------------------ recurrences
def _seq_normalize(expr, ynames, n):
    """Subscript[y, n + k] -> y[n + k] (returns new expr and whether Subscript was used)."""
    used = [False]

    def walk(e):
        if isinstance(e, Expression):
            if e.get_head_name() == "System`Subscript" and len(e.elements) == 2 and isinstance(e.elements[0], Symbol):
                used[0] = True
                return Expression(e.elements[0], walk(e.elements[1]))
            return Expression(walk(e.get_head()), *[walk(x) for x in e.elements])
        return e
    return walk(expr), used[0]


class RSolve(XB):
    messages = {"nosol": "No se pudo resolver la recurrencia."}

    def eval(self, eqs, y, n, evaluation):
        "RSolve[eqs_, y_, n_Symbol]"
        try:
            with budget(12.0):
                return self._go(eqs, y, n, evaluation)
        except Exception:
            _dbg()
            return None

    def _go(self, eqs, y, n, ev):
        from .solve import flatten_equations

        eqs2, sub1 = _seq_normalize(eqs, None, n)
        y2, sub2 = _seq_normalize(y, None, n)
        ys = list(y2.elements) if y2.has_form("List", None) else [y2]
        ys_orig = list(y.elements) if y.has_form("List", None) else [y]
        fnames = [q.get_head_name() if isinstance(q, Expression) else q.get_name() for q in ys]
        eqlist, conds, status = flatten_equations(eqs2)
        if status:
            return None
        nn = n.get_name()
        c = Conv(funcs=fnames, integer=[nn])
        ns = c.sym(nn)
        rec, ics = [], {}
        from .conv import is_free_of

        for a, b in eqlist:
            if is_free_of(a, nn) and is_free_of(b, nn):
                lhs, rhs = c.to(a), c.to(b)
                if isinstance(lhs, sp.core.function.AppliedUndef) and lhs.func.__name__ in fnames:
                    ics[lhs] = rhs
                elif isinstance(rhs, sp.core.function.AppliedUndef) and rhs.func.__name__ in fnames:
                    ics[rhs] = lhs
                else:
                    return None
            else:
                rec.append(c.to(a) - c.to(b))
        funcs = [sp.Function(nm) for nm in fnames]
        if len(funcs) == 1 and len(rec) == 1:
            sol = self._single(rec[0], funcs[0], ns, ics)
            if sol is None:
                return None
            sols = {funcs[0]: sol}
        else:
            sols = self._system(rec, funcs, ns, ics)
            if sols is None:
                return None
        rules = []
        for f, yo in zip(funcs, ys_orig):
            val = sols[f]
            val = val.subs({s_: c.sym("C[%s]" % s_.name[1:]) for s_ in val.free_symbols
                            if s_.name.startswith("C") and s_.name[1:].isdigit()})
            rules.append(Rule(yo, c.back(sp.simplify(val)).evaluate(ev)))
        return L(L(*rules))

    @staticmethod
    def _single(rec, f, ns, ics):
        try:
            sol = sp.rsolve(rec, f(ns), ics or None)
        except Exception:
            sol = None
        if sol is None:
            sol = _rsolve_linear(rec, f, ns, ics)
        return sol

    @staticmethod
    def _system(rec, funcs, ns, ics):
        """First-order linear constant-coefficient systems X[n+1] = A X[n] + b(n): via Z-transform algebra
        done as elimination to single recurrences is fragile, so iterate the matrix power in closed form."""
        m = len(funcs)
        nxt = [f(ns + 1) for f in funcs]
        cur = [f(ns) for f in funcs]
        try:
            solved = sp.solve(rec, nxt, dict=True)
        except Exception:
            return None
        if not solved:
            return None
        solved = solved[0]
        A = sp.zeros(m, m)
        bvec = sp.zeros(m, 1)
        for i, q in enumerate(nxt):
            ex = sp.expand(solved[q])
            for j, cu in enumerate(cur):
                A[i, j] = ex.coeff(cu)
                ex = ex - A[i, j] * cu
            if any(ex.has(cu) for cu in cur) or ex.atoms(sp.core.function.AppliedUndef):
                return None
            bvec[i] = ex
        if A.has(ns):
            return None
        x0 = sp.Matrix([ics.get(f(0), sp.Symbol("C%d" % (i + 1))) for i, f in enumerate(funcs)])
        P, J = A.jordan_form()
        Jn = sp.zeros(m, m)
        # power of a Jordan matrix
        k = sp.Symbol("WLX`k", integer=True, nonnegative=True)

        def jpow(Jm, e):
            out = sp.zeros(m, m)
            i = 0
            while i < m:
                j = i
                while j + 1 < m and Jm[j, j + 1] != 0:
                    j += 1
                lam = Jm[i, i]
                size = j - i + 1
                for r in range(size):
                    for cc in range(r, size):
                        d = cc - r
                        out[i + r, i + cc] = sp.binomial(e, d) * lam ** (e - d) if lam != 0 else \
                            sp.KroneckerDelta(e, d)
                i = j + 1
            return out
        An = P * jpow(J, ns) * P.inv()
        X = An * x0
        if any(v != 0 for v in bvec):
            # particular part: sum_{k=0}^{n-1} A^(n-1-k) b(k)
            Ak = P * jpow(J, ns - 1 - k) * P.inv()
            term = Ak * bvec.subs(ns, k)
            part = sp.Matrix([sp.summation(sp.expand(t_), (k, 0, ns - 1)) for t_ in term])
            if any(p_.has(sp.Sum) for p_ in part):
                return None
            X = X + part
        return {f: sp.simplify(sp.expand(X[i])) for i, f in enumerate(funcs)}


def _rsolve_linear(rec, f, ns, ics):
    """Linear constant-coefficient recurrence with any right-hand side: homogeneous part from the
    characteristic roots, particular part by variation (first order) or undetermined guess via summation."""
    apps = sorted({a for a in rec.atoms(sp.core.function.AppliedUndef) if a.func == f},
                  key=lambda a: sp.simplify(a.args[0] - ns))
    if not apps:
        return None
    shifts = [sp.simplify(a.args[0] - ns) for a in apps]
    if not all(s_.is_Integer for s_ in shifts):
        return None
    ex = sp.expand(rec)
    coeffs = {}
    for a, sft in zip(apps, shifts):
        coeffs[int(sft)] = ex.coeff(a)
        ex = ex - coeffs[int(sft)] * a
    if ex.atoms(sp.core.function.AppliedUndef) or any(cf.has(ns) for cf in coeffs.values()):
        return None
    g = -ex        # sum c_k y[n+k] = g(n)
    lo, hi = min(coeffs), max(coeffs)
    order = hi - lo
    r = sp.Symbol("WLX`r")
    char = sum(cf * r ** (k_ - lo) for k_, cf in coeffs.items())
    roots = sp.roots(sp.Poly(char, r))
    if sum(roots.values()) != order:
        return None
    consts = sp.symbols("C1:%d" % (order + 1))
    basis = []
    for rt, mult in roots.items():
        for j in range(mult):
            basis.append(ns ** j * rt ** ns)
    hom = sum(cst * b for cst, b in zip(consts, basis))
    part = 0
    if g != 0:
        if order == 1:
            # y[n+1] = q y[n] + h(n):  y_p[n] = sum_{k=0}^{n-1} q^(n-1-k) h(k)   (indices shifted by lo)
            q = -coeffs[lo] / coeffs[hi]
            h = (g / coeffs[hi]).subs(ns, ns - lo)
            k = sp.Symbol("WLX`k", integer=True, nonnegative=True)
            part = sp.summation(sp.expand(q ** (ns - 1 - k) * h.subs(ns, k)), (k, 0, ns - 1))
            if part.has(sp.Sum):
                part = sp.Sum(q ** (ns - 1 - k) * h.subs(ns, k), (k, 0, ns - 1)).doit()
                if part.has(sp.Sum):
                    return None
        else:
            part = _particular_guess(coeffs, g, ns)
            if part is None:
                return None
    gen = hom + part
    if ics:
        eqs = [sp.Eq(gen.subs(ns, k_.args[0]), v) for k_, v in ics.items()]
        sol = sp.solve(eqs, consts, dict=True)
        if not sol:
            return None
        gen = gen.subs(sol[0])
    return sp.simplify(gen)


def _particular_guess(coeffs, g, ns):
    """Undetermined coefficients for g = sum poly(n) * b^n (b constant, includes b = 1)."""
    g = sp.expand(g)
    total = 0
    groups = {}
    for term in sp.Add.make_args(g):
        base = sp.Integer(1)
        poly = sp.Integer(1)
        for fac in sp.Mul.make_args(term):
            if isinstance(fac, sp.Pow) and fac.exp.has(ns) and not fac.base.has(ns):
                e = sp.expand(fac.exp)
                k1 = e.coeff(ns, 1)
                k0 = e.coeff(ns, 0)
                if sp.expand(e - k1 * ns - k0) != 0:
                    return None
                base *= fac.base ** k1
                poly *= fac.base ** k0
            else:
                poly *= fac
        if not poly.is_polynomial(ns):
            return None
        groups[base] = groups.get(base, 0) + poly
    r = sp.Symbol("WLX`r")
    lo = min(coeffs)
    char = sum(cf * r ** (k_ - lo) for k_, cf in coeffs.items())
    for base, poly in groups.items():
        deg = sp.Poly(poly, ns).degree()
        mult = 0
        cp = sp.Poly(char, r)
        while cp.eval(base) == 0:
            mult += 1
            cp = cp.diff(r)
        as_ = sp.symbols("a0:%d" % (deg + 1))
        guess = ns ** mult * sum(a_ * ns ** j for j, a_ in enumerate(as_)) * base ** ns
        resid = sum(cf * guess.subs(ns, ns + k_) for k_, cf in coeffs.items()) - poly * base ** ns
        resid = sp.expand(sp.simplify(resid / base ** ns))
        sol = sp.solve(sp.Poly(resid, ns).all_coeffs(), as_, dict=True)
        if not sol:
            return None
        total += guess.subs(sol[0])
    return total


class RecurrenceTable(XB):
    def eval(self, eqs, y, n, a, b, evaluation):
        "RecurrenceTable[eqs_, y_, {n_Symbol, a_Integer, b_Integer}]"
        try:
            from .solve import flatten_equations
            from .conv import is_free_of

            eqs2, _ = _seq_normalize(eqs, None, n)
            y2, _ = _seq_normalize(y, None, n)
            fname = y2.get_head_name() if isinstance(y2, Expression) else y2.get_name()
            eqlist, conds, status = flatten_equations(eqs2)
            nn = n.get_name()
            c = Conv(funcs=[fname], integer=[nn])
            ns = c.sym(nn)
            f = sp.Function(fname)
            vals = {}
            rec = None
            for p, q in eqlist:
                if is_free_of(p, nn) and is_free_of(q, nn):
                    lhs, rhs = c.to(p), c.to(q)
                    if isinstance(rhs, sp.core.function.AppliedUndef):
                        lhs, rhs = rhs, lhs
                    vals[int(lhs.args[0])] = rhs
                else:
                    rec = c.to(p) - c.to(q)
            apps = [q for q in rec.atoms(sp.core.function.AppliedUndef) if q.func == f]
            shifts = sorted(int(sp.simplify(q.args[0] - ns)) for q in apps)
            top = shifts[-1]
            expr = sp.solve(rec, f(ns + top))[0]
            lo, hi = a.value, b.value
            k0 = min(vals)
            idx = max(vals) + 1
            while idx <= hi:
                m = idx - top
                e = expr.subs(ns, m)
                for q in list(e.atoms(sp.core.function.AppliedUndef)):
                    if q.func == f:
                        e = e.subs(q, vals[int(q.args[0])])
                vals[idx] = sp.nsimplify(e) if False else sp.simplify(e)
                idx += 1
            return L(*[c.back(vals[k_]) for k_ in range(lo, hi + 1)]).evaluate(evaluation)
        except Exception:
            _dbg()
            return None


class XNAbs(XB):
    """WLX`NAbs[z] / WLX`NArg[z]: exact modulus / argument of an exact numeric quantity via SymPy."""
    name = "NAbs"
    context = "WLX`"

    def eval(self, z, evaluation):
        "WLX`NAbs[z_]"
        try:
            c = Conv()
            with budget(4.0):
                zs = c.to(z)
                r = sp.Abs(zs)
                if r.has(sp.Abs):
                    re_, im_ = zs.as_real_imag()
                    r = sp.sqrt(sp.simplify(re_ ** 2 + im_ ** 2)) if im_ != 0 else (re_ if sp.N(re_) >= 0 else -re_)
                r = sp.simplify(r) if r.count_ops() < 150 else r
            return c.back(r).evaluate(evaluation)
        except Exception:
            _dbg()
            return S("$Failed")


class XNArg(XB):
    name = "NArg"
    context = "WLX`"

    def eval(self, z, evaluation):
        "WLX`NArg[z_]"
        try:
            c = Conv()
            with budget(4.0):
                zs = c.to(z)
                re_, im_ = zs.as_real_imag()
                r = sp.atan2(im_, re_)
                if r.has(sp.atan2):
                    r = sp.arg(zs)
                if r.has(sp.arg) or r.has(sp.atan2):
                    return S("$Failed")
            return c.back(r).evaluate(evaluation)
        except Exception:
            return S("$Failed")


class ComplexExpand(XB):
    def eval(self, e, evaluation):
        "ComplexExpand[e_]"
        return self._go(e, [], evaluation)

    def eval_vars(self, e, vars, evaluation):
        "ComplexExpand[e_, vars_]"
        vl = vars.elements if vars.has_form("List", None) else [vars]
        return self._go(e, [v.get_name() for v in vl], evaluation)

    def _go(self, e, cvars, ev):
        if isinstance(e, Expression) and e.get_head_name() in ("System`List", "System`Equal", "System`Rule"):
            parts = [self._go(x, cvars, ev) for x in e.elements]
            if any(p is None for p in parts):
                return None
            return Expression(e.get_head(), *parts)
        try:
            names = [nm for nm in _user_symbols(e) if nm not in cvars]
            c = Conv(real=names)
            with budget(6.0):
                s_ = c.to(e)
                if s_.atoms(sp.core.function.AppliedUndef):
                    return None
                re_, im_ = sp.expand(s_).as_real_imag()
                re_ = sp.expand(re_)
                im_ = sp.expand(im_)
                try:
                    r2, i2 = sp.simplify(re_), sp.simplify(im_)
                    if r2.count_ops() <= re_.count_ops():
                        re_ = r2
                    if i2.count_ops() <= im_.count_ops():
                        im_ = i2
                except SympyTimeout:
                    raise
                except Exception:
                    pass
            if not cvars and (re_.has(sp.re, sp.im, sp.arg) or im_.has(sp.re, sp.im, sp.arg)):
                return None
            return c.back(re_ + sp.I * im_).evaluate(ev)
        except Exception:
            _dbg()
            return None


class XEigQ(XB):
    """WLX`EigQ[m, kind]: exact matrices whose characteristic polynomial has an irreducible factor of degree >= 3
    (Mathics spends ~10 s producing Cardano radicals with spurious imaginary parts): give Root objects, as
    Mathematica does. kind: 1 values, 2 vectors, 3 system."""
    name = "EigQ"
    context = "WLX`"

    def eval(self, m, kind, evaluation):
        "WLX`EigQ[m_, kind_Integer]"
        try:
            c = Conv()
            rows = c.to(m)
            M = sp.Matrix(rows)
            n = M.rows
            if n != M.cols or n < 3 or n > 6 or not all(v.is_Rational for v in M):
                return SymbolFalse
            lam = sp.Symbol("WLX`lam")
            with budget(6.0):
                p = M.charpoly(lam).as_expr()
                facs = sp.factor_list(p, lam)[1]
                if all(sp.Poly(f, lam).degree() <= 2 for f, _ in facs):
                    return SymbolFalse
                if any(mult > 1 for f, mult in facs):
                    return SymbolFalse
                roots = sp.Poly(p, lam).all_roots()
                roots.sort(key=lambda r: (-abs(complex(sp.N(r))), -complex(sp.N(r)).real))
                vals = roots
                vecs = []
                if kind.value in (2, 3):
                    for r in roots:
                        A = M - r * sp.eye(n)
                        adj = A.adjugate()
                        rn = complex(sp.N(r))
                        best, bestn = None, 0.0
                        for j in range(n):
                            col = adj[:, j]
                            nv = sum(abs(complex(sp.N(q))) for q in col)
                            if nv > bestn:
                                best, bestn = col, nv
                        if best is None or bestn < 1e-12:
                            return SymbolFalse
                        last = None
                        for q in reversed(list(best)):
                            if abs(complex(sp.N(q))) > 1e-12:
                                last = q
                                break
                        vecs.append([sp.expand(q) / sp.expand(last) if q != last else sp.Integer(1) for q in best])
            if kind.value == 1:
                res = c.back(vals)
            elif kind.value == 2:
                res = c.back(vecs)
            else:
                res = L(c.back(vals), c.back(vecs))
            return _stash("eig", res.evaluate(evaluation))
        except Exception:
            _dbg()
            return SymbolFalse


class XEigGet(XB):
    name = "EigGet"
    context = "WLX`"

    def eval(self, evaluation):
        "WLX`EigGet[]"
        return _RESULT.pop("eig", None)


class Eliminate(XB):
    def eval(self, eqs, vars, evaluation):
        "Eliminate[eqs_, vars_]"
        from .solve import flatten_equations

        try:
            eqlist, conds, status = flatten_equations(eqs)
            vl = list(vars.elements) if vars.has_form("List", None) else [vars]
            if status or len(eqlist) <= len(vl):
                return None
            c = Conv()
            xs = [c.sym(v.get_name()) for v in vl]
            ex = [c.to(a) - c.to(b) for a, b in eqlist]
            with budget(8.0):
                # use the equations where the variables are easiest to isolate
                order = sorted(range(len(ex)), key=lambda i: ex[i].count_ops())
                pick = order[:len(xs)]
                sol = sp.solve([ex[i] for i in pick], xs, dict=True)
                if not sol:
                    return None
                rest = [sp.numer(sp.together(sp.simplify(ex[i].subs(sol[0])))) for i in order[len(xs):]]
            outs = []
            for r in rest:
                r = sp.expand(r)
                if r == 0:
                    continue
                pos = [t for t in sp.Add.make_args(r) if not t.could_extract_minus_sign()]
                neg = [-t for t in sp.Add.make_args(r) if t.could_extract_minus_sign()]
                outs.append(E("Equal", c.back(sp.Add(*pos)), c.back(sp.Add(*neg))))
            if not outs:
                return SymbolTrue
            res = outs[0] if len(outs) == 1 else E("And", *outs)
            return res.evaluate(evaluation)
        except Exception:
            _dbg()
            return None


BUILTINS = SPECIALS + [Eliminate, XEigQ, XEigGet, XNAbs, XNArg, ComplexExpand, KroneckerDelta, Surd, TrigExpand, FunctionExpand,
                       PolynomialGCD, PolynomialLCM, NSum, XSumQ, XSumGet, RSolve, RecurrenceTable] + STASHED


def install(kernel):
    ext.contribute(kernel, BUILTINS)
