# -*- coding: utf-8 -*-
"""Solve / NSolve / FindRoot re-implemented on top of SymPy + mpmath (owner: ENGINE).

Why not Mathics' own Solve: it loses root multiplicity, cannot thread vector equations, needs the variable
list, hangs on some transcendental equations with decimals, ignores inequalities/domains, and orders the
solutions differently from Mathematica.
"""
import math

import sympy as sp
from mathics.core.atoms import Integer, Real, String
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Atom, Symbol, SymbolFalse, SymbolTrue

from .conv import Conv, ConvError, S
from . import ext
from .ext import E, L, Rule, XB, SympyTimeout, budget, pyval, _dbg, _user_symbols

REL_HEADS = ("System`Less", "System`LessEqual", "System`Greater", "System`GreaterEqual", "System`Unequal",
             "System`Inequality", "System`Element", "System`NotElement")


# ----------------------------------------------------------------- helpers
def flatten_equations(eqs, ev=None):
    """-> (equations [(lhs, rhs)], conditions [expr], status) ; status in (None, 'false', 'bad')."""
    out, conds = [], []
    status = [None]

    def leaves(v):
        if v.has_form("List", None):
            r = []
            for q in v.elements:
                r.extend(leaves(q))
            return r
        return [v]

    def walk(e):
        hn = e.get_head_name() if isinstance(e, Expression) else None
        if e is SymbolTrue:
            return
        if e is SymbolFalse:
            status[0] = "false"
            return
        if hn in ("System`List", "System`And"):
            for q in e.elements:
                walk(q)
            return
        if hn == "System`Equal" and len(e.elements) >= 2:
            els = e.elements
            for a, b in zip(els[:-1], els[1:]):
                la, lb = a.has_form("List", None), b.has_form("List", None)
                if la and lb:
                    fa, fb = leaves(a), leaves(b)
                    if len(fa) != len(fb):
                        status[0] = "false"
                        return
                    out.extend(zip(fa, fb))
                elif la:
                    out.extend((q, b) for q in leaves(a))
                elif lb:
                    out.extend((a, q) for q in leaves(b))
                else:
                    out.append((a, b))
            return
        if hn in REL_HEADS:
            conds.append(e)
            return
        status[0] = "bad"

    walk(eqs)
    return out, conds, status[0]


def replace_expr(e, pairs):
    """Structural replacement of sub-expressions (pairs = [(old, new)])."""
    for old, new in pairs:
        if e.sameQ(old):
            return new
    if isinstance(e, Expression):
        head = replace_expr(e.get_head(), pairs)
        return Expression(head, *[replace_expr(x, pairs) for x in e.elements])
    return e


def contains_expr(e, target):
    if e.sameQ(target):
        return True
    if isinstance(e, Expression):
        return contains_expr(e.get_head(), target) or any(contains_expr(x, target) for x in e.elements)
    return False


def has_float(s):
    return bool(s.atoms(sp.Float))


def rationalize(s):
    """Floats -> exact rationals (so that SymPy's exact algorithms neither hang nor lose roots)."""
    if not has_float(s):
        return s
    return s.xreplace({f: sp.Rational(str(f)) if abs(f) < 1e15 else sp.Rational(f) for f in s.atoms(sp.Float)})


def nice_logs(s):
    """Log[2^50] -> 50 Log[2]; Log[1/8] -> -3 Log[2]."""
    def fix(e):
        a = e.args[0]
        if a.is_Rational and a > 0 and a != 1:
            if a.is_Integer:
                pp = sp.perfect_power(a)
                if pp:
                    return pp[1] * sp.log(pp[0])
                return e
            if a.p == 1:
                return -fix(sp.log(sp.Integer(a.q), evaluate=False))
        return e
    try:
        return s.replace(lambda e: isinstance(e, sp.log), fix)
    except Exception:
        return s


def numeric_value(s, probes=None):
    try:
        if probes:
            s = s.xreplace(probes)
        v = complex(sp.N(s, 20))
        if v != v:
            return None
        return v
    except Exception:
        return None


def probes_for(exprs):
    syms = set()
    for e in exprs:
        if isinstance(e, sp.Basic):
            syms |= e.free_symbols
            for f in e.atoms(sp.core.function.AppliedUndef):
                syms.add(f)
    out = {}
    for i, s_ in enumerate(sorted(syms, key=str)):
        out[s_] = sp.Float(0.37 + 0.211 * ((i * 7) % 5) + 0.013 * i)
    return out


# -------------------------------------------------------- single equation
class NoPeel(Exception):
    pass


def peel(lhs, rhs, v, info):
    """Solve lhs(v) == rhs when v occurs once in lhs: invert the chain of functions (all branches that
    Mathematica reports). Returns list of solutions or raises NoPeel."""
    sols = [rhs]
    for _ in range(40):
        if lhs == v:
            return sols
        if not lhs.has(v):
            raise NoPeel()
        if isinstance(lhs, sp.Add):
            dep = [a for a in lhs.args if a.has(v)]
            if len(dep) != 1:
                raise NoPeel()
            rest = lhs - dep[0]
            sols = [s_ - rest for s_ in sols]
            lhs = dep[0]
        elif isinstance(lhs, sp.Mul):
            dep = [a for a in lhs.args if a.has(v)]
            if len(dep) != 1:
                raise NoPeel()
            rest = lhs / dep[0]
            sols = [s_ / rest for s_ in sols]
            lhs = dep[0]
        elif isinstance(lhs, sp.Pow):
            b, e = lhs.base, lhs.exp
            if b.has(v) and not e.has(v):
                if e == 2:
                    sols = [q for s_ in sols for q in (-sp.sqrt(s_), sp.sqrt(s_))]
                elif e == -1:
                    sols = [1 / s_ for s_ in sols]
                elif e == -2:
                    sols = [q for s_ in sols for q in (-1 / sp.sqrt(s_), 1 / sp.sqrt(s_))]
                elif e == sp.Rational(1, 2):
                    sols = [s_ ** 2 for s_ in sols]
                    info["check"] = True
                elif e == -sp.Rational(1, 2):
                    sols = [1 / s_ ** 2 for s_ in sols]
                    info["check"] = True
                elif e.is_Integer and e > 2:
                    n = int(e)
                    news = []
                    for s_ in sols:
                        r0 = sp.root(s_, n)
                        for k in range(n):
                            news.append(r0 * sp.exp(2 * sp.pi * sp.I * k / n) if k else r0)
                    sols = news
                    info["expand_roots"] = True
                else:
                    raise NoPeel()
                lhs = b
            elif e.has(v) and not b.has(v):
                if b == sp.E:
                    sols = [sp.log(s_) for s_ in sols]
                else:
                    sols = [sp.log(s_) / sp.log(b) for s_ in sols]
                info["ifun"] = True
                lhs = e
            else:
                raise NoPeel()
        elif isinstance(lhs, sp.exp):
            sols = [sp.log(s_) for s_ in sols]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.log):
            sols = [sp.exp(s_) for s_ in sols]
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.cosh):
            sols = [q for s_ in sols for q in (-sp.acosh(s_), sp.acosh(s_))]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.sinh):
            sols = [sp.asinh(s_) for s_ in sols]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.tanh):
            sols = [sp.atanh(s_) for s_ in sols]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.sin):
            sols = [q for s_ in sols for q in (sp.asin(s_), sp.pi - sp.asin(s_))]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.cos):
            sols = [q for s_ in sols for q in (-sp.acos(s_), sp.acos(s_))]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.tan):
            sols = [sp.atan(s_) for s_ in sols]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.cot):
            sols = [sp.acot(s_) for s_ in sols]
            info["ifun"] = True
            lhs = lhs.args[0]
        elif isinstance(lhs, (sp.asin, sp.acos, sp.atan, sp.asinh, sp.acosh, sp.atanh)):
            fwd = {sp.asin: sp.sin, sp.acos: sp.cos, sp.atan: sp.tan, sp.asinh: sp.sinh, sp.acosh: sp.cosh,
                   sp.atanh: sp.tanh}[type(lhs)]
            sols = [fwd(s_) for s_ in sols]
            lhs = lhs.args[0]
        elif isinstance(lhs, sp.Abs):
            news = []
            for s_ in sols:
                if s_ == 0:
                    news.append(s_)
                elif s_.is_number and s_.is_real is not False and (s_.is_negative or (s_.is_real and s_ < 0)):
                    continue
                else:
                    news.extend([-s_, s_])
            sols = news
            lhs = lhs.args[0]
        else:
            raise NoPeel()
    raise NoPeel()


def poly_roots(expr, x, floats):
    """Roots (with multiplicity) of a univariate polynomial equation numer(expr) == 0, or None."""
    if expr.has(sp.tan, sp.cot, sp.sec, sp.csc):
        expr = expr.replace(sp.tan, lambda u: sp.sin(u) / sp.cos(u)).replace(sp.cot, lambda u: sp.cos(u) / sp.sin(u)) \
            .replace(sp.sec, lambda u: 1 / sp.cos(u)).replace(sp.csc, lambda u: 1 / sp.sin(u))
    num, den = sp.fraction(sp.together(expr))
    try:
        poly = sp.Poly(num, x)
    except Exception:
        return None
    if poly.degree() < 1:
        return None
    if poly.degree() > 1 and (poly.free_symbols - {x}) and not floats:
        # symbolic coefficients: exact factors give much simpler roots than the general formulas
        try:
            fl = sp.factor_list(num)[1]
            facs = [(f, m) for f, m in fl if f.has(x)]
            if len(facs) > 1 or (facs and facs[0][1] > 1):
                out = []
                for f, m in facs:
                    r = poly_roots(f, x, floats) if sp.Poly(f, x).degree() > 1 else \
                        [sp.simplify(-sp.Poly(f, x).all_coeffs()[1] / sp.Poly(f, x).all_coeffs()[0])]
                    if r is None:
                        out = None
                        break
                    out.extend(r * m)
                if out is not None:
                    return [r for r in out if not _zero_at(den, x, r)]
        except SympyTimeout:
            raise
        except Exception:
            pass
    if any(c_.has(x) for c_ in poly.all_coeffs()):
        return None
    numeric_coeffs = not (poly.free_symbols - {x}) and not poly.atoms(sp.core.function.AppliedUndef)
    out = []
    if floats and numeric_coeffs:
        for r in sp.Poly(poly, x).nroots(n=17, maxsteps=200):
            out.append(r)
    else:
        rts = sp.roots(poly, x)
        if sum(rts.values()) == poly.degree():
            for r, m in rts.items():
                out.extend([r] * m)
        elif numeric_coeffs:
            # no closed form (irreducible quintic...): exact factors first, numeric for the rest
            done = poly.degree()
            for fac, m in sp.factor_list(poly)[1]:
                rr = sp.roots(fac, x)
                if sum(rr.values()) == fac.degree():
                    for r, mm in rr.items():
                        out.extend([r] * (m * mm))
                else:
                    for r in fac.nroots(n=17, maxsteps=200):
                        out.extend([r] * m)
            if len(out) != done:
                return None
        else:
            return None
    if den.has(x):
        keep = []
        for r in out:
            try:
                d = den.subs(x, r)
                if d == 0 or (d.is_number and abs(complex(sp.N(d))) < 1e-12):
                    continue
            except Exception:
                pass
            keep.append(r)
        out = keep
    return out


def _zero_at(den, x, r):
    if not den.has(x):
        return False
    try:
        d = den.subs(x, r)
        return d == 0 or (d.is_number and abs(complex(sp.N(d))) < 1e-12)
    except Exception:
        return False


def radical_roots(expr, x):
    """Equation with rational powers of ONE sub-expression b(x) (linear in x): substitute b = u^q."""
    pows = [p for p in expr.atoms(sp.Pow) if p.base.has(x) and p.exp.is_Rational and not p.exp.is_Integer]
    if not pows:
        return None
    bases = {p.base for p in pows}
    if len(bases) != 1:
        return None
    b = bases.pop()
    try:
        pb = sp.Poly(b, x)
    except Exception:
        return None
    if pb.degree() != 1:
        return None
    q = sp.ilcm(1, *[p.exp.q for p in pows])
    u = sp.Symbol("WLX`u")
    k1, k0 = pb.all_coeffs()
    e2 = expr.xreplace({p: u ** (p.exp * q) for p in pows}).subs(x, (u ** q - k0) / k1)
    if e2.has(x):
        return None
    us = poly_roots(e2, u, True)
    if us is None:
        return None
    out = []
    for r in us:
        xv = sp.N((r ** q - k0) / k1, 17)
        try:
            resid = abs(complex(sp.N(expr.subs(x, xv), 17)))
            scale = 1 + abs(complex(xv))
            if resid < 1e-7 * scale and not any(abs(complex(xv) - complex(o)) < 1e-9 * scale for o in out):
                out.append(xv)
        except Exception:
            continue
    return out


def solve_single(expr, x, floats, info):
    """All solutions (list of sympy exprs) of expr == 0 for the symbol x; None if we cannot."""
    if not expr.has(x):
        return [] if expr != 0 else None
    r = poly_roots(expr, x, floats)
    if r is not None:
        return r
    occurrences = expr.count(x)
    if occurrences == 1:
        inf2 = {}
        try:
            sols = peel(expr, sp.Integer(0), x, inf2)
            info.update(inf2)
            if inf2.get("expand_roots"):
                sols = [sp.expand_complex(s_) if s_.is_number else s_ for s_ in sols]
            if inf2.get("check"):
                good = []
                for s_ in sols:
                    pr = probes_for([expr, s_])
                    v = numeric_value(expr.subs(x, s_), pr)
                    if v is None or abs(v) < 1e-8:
                        good.append(s_)
                sols = good
            uniq = []
            for s_ in sols:
                s_ = nice_logs(s_)
                if not any(s_ == o or sp.simplify(s_ - o) == 0 for o in uniq):
                    uniq.append(s_)
            return uniq
        except NoPeel:
            pass
    if floats or info.get("numeric"):
        rr = radical_roots(expr, x)
        if rr is not None:
            return rr
    try:
        with budget(6.0):
            sols = sp.solve(expr, x)
    except SympyTimeout:
        rr = radical_roots(expr, x) if not expr.free_symbols - {x} else None
        if rr is not None:
            return rr
        raise
    except NotImplementedError:
        if floats or True:
            rr = radical_roots(expr, x) if not expr.free_symbols - {x} else None
            if rr is not None:
                return rr
        return None
    except Exception:
        return None
    if not expr.is_polynomial(x):
        info["ifun"] = info.get("ifun") or bool(expr.atoms(sp.exp, sp.log, sp.sin, sp.cos, sp.tan, sp.cosh, sp.sinh))
    if info.get("conds") and expr.has(sp.sin, sp.cos, sp.tan) and not expr.free_symbols - {x}:
        # with side conditions the other solutions of the period matter: add those in (-Pi, Pi]
        extra = []
        for s_ in sols:
            for k in (-2, -1, 1, 2):
                cand = s_ + k * sp.pi
                v = numeric_value(expr.subs(x, cand))
                nv = numeric_value(cand)
                if v is not None and abs(v) < 1e-9 and nv is not None and -math.pi - 1e-12 < nv.real <= math.pi + 1e-12 \
                        and not any(sp.simplify(cand - o) == 0 for o in list(sols) + extra):
                    extra.append(cand)
        sols = list(sols) + extra
    return [nice_logs(s_) for s_ in sols]


# ----------------------------------------------------------------- Solve
def sort_key(vals, probes):
    key = []
    for v in vals:
        nv = numeric_value(v, probes)
        if nv is None:
            return None
        re_, im_ = nv.real, nv.imag
        if abs(im_) < 1e-12 * (1 + abs(re_)):
            im_ = 0.0
        if abs(re_) < 1e-12 * (1 + abs(im_)):
            re_ = 0.0
        exact_number = isinstance(v, sp.Basic) and v.is_number and all(
            q.is_Rational for q in (sp.re(v), sp.im(v)))
        key.append((0 if exact_number else 1, round(re_, 10), round(im_, 10)))
    return tuple(key)


class Solve(XB):
    messages = {
        "eqf": "`1` is not a well-formed equation.",
        "svars": 'Equations may not give solutions for all "solve" variables.',
        "ifun": "Inverse functions are being used by Solve, so some solutions may not be found; use Reduce "
                "for complete solution information.",
        "ivar": "`1` is not a valid variable.",
        "naqs": "`1` is not a quantified system of equations and inequalities.",
    }
    summary_text = "find generic solutions for variables"
    numeric = False

    def eval_novars(self, eqs, evaluation):
        "%(name)s[eqs_]"
        return self._go(eqs, None, None, evaluation)

    def eval(self, eqs, vars, evaluation):
        "%(name)s[eqs_, vars_]"
        return self._go(eqs, vars, None, evaluation)

    def eval_dom(self, eqs, vars, dom, evaluation):
        "%(name)s[eqs_, vars_, dom_Symbol]"
        return self._go(eqs, vars, dom, evaluation)

    def _go(self, eqs, vars, dom, ev):
        name = self.get_name()
        try:
            with budget(14.0):
                return self._solve(eqs, vars, dom, ev)
        except SympyTimeout:
            return None
        except ConvError:
            _dbg()
        except Exception:
            _dbg()
        # last resort: Mathics' own Solve
        if ORIGINAL.get("Solve") is not None and vars is not None and not self.numeric:
            try:
                return ORIGINAL["Solve"].eval(eqs, vars, ev)
            except Exception:
                return None
        return None

    def _solve(self, eqs, vars, dom, ev):
        name = self.get_name().split("`")[-1]
        eqlist, conds, status = flatten_equations(eqs)
        if status == "bad":
            ev.message(name, "eqf", eqs)
            return None
        if status == "false":
            return L()
        # ------------------------------------------------ variables
        if vars is None:
            names = []
            for a, b in eqlist:
                _user_symbols(a, names)
                _user_symbols(b, names)
            vlist = [Symbol(n) for n in sorted(names, key=lambda n: n.split("`")[-1])]
            # symbols used as function heads are not variables
            vlist = [v for v in vlist if not any(_is_head(a, v) or _is_head(b, v) for a, b in eqlist)]
        else:
            vlist = list(vars.elements) if vars.has_form("List", None) else [vars]
        for v in vlist:
            if (isinstance(v, Atom) and not isinstance(v, Symbol)) or \
                    v.get_head_name() in ("System`Plus", "System`Times", "System`Power") or \
                    (isinstance(v, Symbol) and v.get_name() in ("System`Pi", "System`E", "System`I")):
                ev.message(name, "ivar", v)
                return None
        if not eqlist and not conds:
            return L(L())
        # non-symbol variables (C[1], y'[0], LaplaceTransform[...], Subscript[...]) -> dummies
        pairs = []
        dummies = {}
        for i, v in enumerate(vlist):
            if not isinstance(v, Symbol):
                d = Symbol("WLX`sv%d" % i)
                pairs.append((v, d))
                dummies[d.get_name()] = v
        if pairs:
            # longest first so that y''[0] is not broken by y'[0]
            eqlist = [(replace_expr(a, pairs), replace_expr(b, pairs)) for a, b in eqlist]
            conds = [replace_expr(q, pairs) for q in conds]
        vsyms_m = [replace_expr(v, pairs) if not isinstance(v, Symbol) else v for v in vlist]
        real_vars = set()
        if dom is not None and dom.get_name() == "System`Reals":
            real_vars = {v.get_name() for v in vsyms_m}
        c = Conv(real=real_vars)
        xs = [c.sym(v.get_name()) for v in vsyms_m]
        exprs = []
        floats = False
        for a, b in eqlist:
            e = c.to(a) - c.to(b)
            if has_float(e):
                floats = True
                e = rationalize(e)
            if e == 0:
                continue
            exprs.append(e)
        sconds = []
        for q in conds:
            try:
                sq = c.to(q)
                if isinstance(sq, sp.Symbol) and sq.name.startswith("Element_"):
                    if sq.name == "Element_Reals":
                        real_filter = True
                    continue
                sconds.append(rationalize(sq) if isinstance(sq, sp.Basic) else sq)
            except ConvError:
                pass
        if any(e.is_number and e != 0 for e in exprs):
            return L()
        exprs = [e for e in exprs if not e.is_number]
        used = [x for x in xs if any(e.has(x) for e in exprs)]
        info = {"numeric": self.numeric, "conds": bool(sconds)}
        if not exprs:
            sols = [{}]
        elif not used:
            # equations without the variables: generic -> no solution (Mathematica gives {} unless identity)
            return L()
        elif len(exprs) == 1 and len(used) == 1:
            r = solve_single(exprs[0], used[0], floats, info)
            if r is None:
                return None
            sols = [{used[0]: s_} for s_ in r]
        else:
            sols = self._system(exprs, used, floats, info)
            if sols is None:
                return None
        if len(used) < len(xs) and exprs and vars is not None:
            info["svars"] = True
        # ------------------------------------------------ conditions / domain
        want_real = dom is not None and dom.get_name() == "System`Reals"
        want_int = dom is not None and dom.get_name() == "System`Integers"
        keep = []
        for sol in sols:
            ok = True
            for cond in sconds:
                try:
                    cv = cond.subs(sol)
                    if cv == False:  # noqa: E712
                        ok = False
                        break
                    if cv != True and isinstance(cv, sp.Basic) and not cv.free_symbols:  # noqa: E712
                        cv2 = sp.N(cv)
                        if cv2 == False:  # noqa: E712
                            ok = False
                            break
                except Exception:
                    pass
            if ok and (want_real or want_int):
                for v in sol.values():
                    if not v.free_symbols:
                        nv = numeric_value(v)
                        if nv is not None and abs(nv.imag) > 1e-10 * (1 + abs(nv.real)):
                            ok = False
                            break
                        if want_int and nv is not None and abs(nv.real - round(nv.real)) > 1e-10:
                            ok = False
                            break
                    elif v.has(sp.I):
                        ok = False
                        break
            if ok:
                keep.append(sol)
        sols = keep
        # ------------------------------------------------ order (Mathematica: by value, variable by variable)
        probes = probes_for([v for s_ in sols for v in s_.values()])
        keyed = []
        sortable = True
        for i, sol in enumerate(sols):
            k_ = sort_key([sol.get(x, sp.Integer(0)) for x in used if x in sol], probes)
            if k_ is None:
                sortable = False
                break
            keyed.append((k_, i, sol))
        if sortable and len(sols) > 1:
            keyed.sort(key=lambda t: (t[0], t[1]))
            sols = [t[2] for t in keyed]
        # ------------------------------------------------ back to WL
        if info.get("ifun") and not self.numeric:
            ev.message(name, "ifun")
        if info.get("svars") and not self.numeric:
            ev.message(name, "svars")
        out = []
        for sol in sols:
            rules = []
            for x, v in zip(xs, vlist):
                if x not in sol:
                    continue
                val = sol[x]
                if floats or self.numeric:
                    try:
                        val = sp.N(val, 17) if not val.free_symbols else val.xreplace(
                            {q: sp.Float(q, 17) for q in val.atoms(sp.Rational) if not q.is_Integer}) if False else \
                            (sp.N(val, 17) if not val.free_symbols else val)
                    except Exception:
                        pass
                    if isinstance(val, sp.Basic) and not val.free_symbols and val.is_number:
                        nv = numeric_value(val)
                        if nv is not None:
                            if abs(nv.imag) < 1e-13 * (1 + abs(nv.real)):
                                val = sp.Float(nv.real)
                            else:
                                val = sp.Float(nv.real) + sp.I * sp.Float(nv.imag) if abs(nv.real) > 1e-13 * abs(nv.imag) \
                                    else sp.I * sp.Float(nv.imag)
                m = c.back(val)
                if dummies:
                    m = replace_expr(m, [(Symbol(dn), dv) for dn, dv in dummies.items()])
                m = m.evaluate(ev)
                if (floats or self.numeric) and not _is_inexact_free(m):
                    m = E("N", m).evaluate(ev)
                rules.append(Rule(v, m))
            out.append(L(*rules))
        return L(*out)

    def _system(self, exprs, used, floats, info):
        # linear systems: solve for the LAST variables in terms of the first (as Mathematica does)
        try:
            A, b = sp.linear_eq_to_matrix(exprs, used)
            linear = True
        except Exception:
            linear = False
        if linear:
            rev = list(reversed(used))
            res = sp.solve(exprs, rev, dict=True)
            if not res:
                return []
            if len(res[0]) < len(used):
                info["svars"] = True
            return res
        with budget(11.0):
            try:
                res = sp.solve(exprs, used, dict=True)
            except NotImplementedError:
                return None
        if res and any(len(r) < len(used) for r in res):
            info["svars"] = True
        if any(e.atoms(sp.exp, sp.log, sp.sin, sp.cos, sp.tan) for e in exprs):
            info["ifun"] = True
        return [{k_: nice_logs(v) for k_, v in r.items()} for r in res]


def _is_head(e, sym):
    if isinstance(e, Expression):
        h = e.get_head()
        if h is sym or (isinstance(h, Symbol) and h.get_name() == sym.get_name()):
            return True
        if isinstance(h, Expression) and _contains_symbol(h, sym):
            return True
        return any(_is_head(x, sym) for x in e.elements)
    return False


def _contains_symbol(e, sym):
    if isinstance(e, Symbol):
        return e.get_name() == sym.get_name()
    if isinstance(e, Expression):
        return _contains_symbol(e.get_head(), sym) or any(_contains_symbol(x, sym) for x in e.elements)
    return False


def _is_inexact_free(m):
    """True if expr has no exact numbers left that N would change (cheap test: contains a Real already)."""
    if isinstance(m, Real):
        return True
    if isinstance(m, Expression):
        return any(_is_inexact_free(x) for x in m.elements)
    return False


class NSolve(Solve):
    options = {"WorkingPrecision": "MachinePrecision"}
    numeric = True

    def eval_novars(self, eqs, evaluation, options):
        "NSolve[eqs_, OptionsPattern[NSolve]]"
        return self._go(eqs, None, None, evaluation)

    def eval(self, eqs, vars, evaluation, options):
        "NSolve[eqs_, vars_, OptionsPattern[NSolve]]"
        return self._go(eqs, vars, None, evaluation)

    def eval_dom(self, eqs, vars, dom, evaluation, options):
        "NSolve[eqs_, vars_, dom_Symbol, OptionsPattern[NSolve]]"
        return self._go(eqs, vars, dom, evaluation)


ORIGINAL = {}


def install(kernel):
    try:
        from mathics.builtin.numbers import calculus as _calc

        ORIGINAL["Solve"] = _calc.Solve(expression=False)
    except Exception:
        ORIGINAL["Solve"] = None
    ext.contribute(kernel, [Solve, NSolve])
