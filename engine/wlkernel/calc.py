# -*- coding: utf-8 -*-
"""Fast, predictable calculus kernels used by Integrate / LaplaceTransform / InverseLaplaceTransform /
Convolve / Fourier series (owner: ENGINE).

SymPy's general integrator is slow (seconds) or fails on the bread-and-butter integrands of the course:
polynomial x exponential x sines/cosines with unrelated frequencies, possibly cut by UnitStep/Piecewise.
Here those are done in closed form:
  * exp_poly_antiderivative : every term c x^n e^(a x)  (sin/cos/sinh/cosh are rewritten as exponentials)
  * split_pieces            : a piecewise/UnitStep/Abs expression as a list of smooth pieces
"""
import sympy as sp

from .ext import SympyTimeout


# ------------------------------------------------------------ exp-poly terms
def _linear_coeff(arg, x):
    """arg = k x + m with k, m free of x -> (k, m) else None."""
    arg = sp.expand(arg)
    k = arg.coeff(x, 1)
    m = arg.coeff(x, 0)
    if k.has(x) or m.has(x) or sp.expand(arg - k * x - m) != 0:
        return None
    return k, m


def to_exponentials(expr, x):
    """Rewrite sin/cos/sinh/cosh whose argument is linear in x as exponentials of x (other functions of x
    are left alone and will make exp_poly_terms fail)."""
    I = sp.I

    def conv(e):
        if not e.args or not e.has(x):
            return e
        if isinstance(e, (sp.sin, sp.cos, sp.sinh, sp.cosh)):
            lc = _linear_coeff(e.args[0], x)
            if lc is None or lc[0] == 0:
                return e
            a = e.args[0]
            if isinstance(e, sp.sin):
                return (sp.exp(I * a) - sp.exp(-I * a)) / (2 * I)
            if isinstance(e, sp.cos):
                return (sp.exp(I * a) + sp.exp(-I * a)) / 2
            if isinstance(e, sp.sinh):
                return (sp.exp(a) - sp.exp(-a)) / 2
            return (sp.exp(a) + sp.exp(-a)) / 2
        return e.func(*[conv(a) for a in e.args])
    return conv(expr)


def exp_poly_terms(expr, x):
    """expr as {(a): {n: c}} meaning sum c x^n e^(a x); None if expr is not of that class."""
    e = to_exponentials(expr, x)
    e = sp.expand(e, power_base=False, log=False)
    terms = {}
    for term in sp.Add.make_args(e):
        coeff = sp.Integer(1)
        a = sp.Integer(0)
        n = 0
        for fac in sp.Mul.make_args(term):
            if not fac.has(x):
                coeff *= fac
            elif fac == x:
                n += 1
            elif isinstance(fac, sp.Pow) and fac.base == x and fac.exp.is_Integer and fac.exp > 0:
                n += int(fac.exp)
            elif isinstance(fac, sp.exp):
                lc = _linear_coeff(fac.args[0], x)
                if lc is None:
                    return None
                a += lc[0]
                coeff *= sp.exp(lc[1])
            elif isinstance(fac, sp.Pow) and isinstance(fac.base, sp.exp) and not fac.exp.has(x):
                lc = _linear_coeff(fac.base.args[0] * fac.exp, x)
                if lc is None:
                    return None
                a += lc[0]
                coeff *= sp.exp(lc[1])
            elif isinstance(fac, sp.Pow) and not fac.base.has(x):
                # b^(k x + m)
                lc = _linear_coeff(fac.exp, x)
                if lc is None:
                    return None
                a += lc[0] * sp.log(fac.base)
                coeff *= fac.base ** lc[1]
            else:
                return None
        a = sp.expand(a)
        d = terms.setdefault(a, {})
        d[n] = d.get(n, 0) + coeff
    return terms


def _term_antiderivative(c, n, a, x):
    if a == 0:
        return c * x ** (n + 1) / (n + 1)
    total = 0
    f = sp.Integer(1)   # n!/(n-k)!
    for k in range(n + 1):
        total += (-1) ** k * f * x ** (n - k) / a ** (k + 1)
        f *= (n - k)
    return c * sp.exp(a * x) * total


def _cis(e):
    """e^(r + i u) -> e^r (cos u + i sin u) for the exponentials whose argument contains I."""
    arg = sp.expand(e.args[0])
    re_parts, im_parts = [], []
    for t in sp.Add.make_args(arg):
        if t.has(sp.I):
            q = sp.expand(t / sp.I)
            if q.has(sp.I):
                return e
            im_parts.append(q)
        else:
            re_parts.append(t)
    if not im_parts:
        return e
    u = sp.Add(*im_parts)
    r = sp.Add(*re_parts)
    return sp.exp(r) * (sp.cos(u) + sp.I * sp.sin(u))


def real_form(expr, real=True):
    """Complex exponentials e^(i u) back to cos/sin, then the real part (every symbol is treated as real,
    which is how Mathematica prints these results). With real=False the imaginary part is kept."""
    if not expr.has(sp.I):
        return expr
    try:
        # symbols without a `real` assumption would give re(x), im(x): work on real stand-ins
        fwd = {s_: sp.Dummy(s_.name, real=True, positive=bool(s_.is_positive)) for s_ in expr.free_symbols
               if not s_.is_real}
        back = {v: k for k, v in fwd.items()}
        e = expr.xreplace(fwd) if fwd else expr
        e = e.replace(lambda q: isinstance(q, sp.exp) and q.args[0].has(sp.I), _cis)
        re_, im_ = e.as_real_imag()
        if re_.has(sp.re, sp.im, sp.arg) or im_.has(sp.re, sp.im, sp.arg):
            return expr
        out = re_ if real else re_ + sp.I * im_
        return out.xreplace(back) if back else out
    except SympyTimeout:
        raise
    except Exception:
        return expr


def no_stray_complex(result, *inputs):
    """Rule for every SymPy-backed path: a real input must not come back with I / complex exponentials.
    Returns the result in real form, or None when that is not possible (caller then falls back)."""
    if result is None or not isinstance(result, sp.Basic) or not result.has(sp.I):
        return result
    if any(isinstance(i_, sp.Basic) and i_.has(sp.I) for i_ in inputs):
        return result
    r = real_form(result)
    if r.has(sp.I):
        try:
            r2 = sp.simplify(result.rewrite(sp.cos))
            if not r2.has(sp.I):
                return r2
        except SympyTimeout:
            raise
        except Exception:
            pass
        return None
    return r


def exp_poly_antiderivative(expr, x, real=True):
    """Antiderivative of an exp-poly-trig expression in closed form, or None."""
    terms = exp_poly_terms(expr, x)
    if terms is None:
        return None
    total = 0
    for a, d in terms.items():
        for n, c in d.items():
            if c == 0:
                continue
            total += _term_antiderivative(c, n, a, x)
    if total == 0:
        return sp.Integer(0)
    if not real:
        return total
    r = real_form(total, real=not expr.has(sp.I))
    return sp.expand(r) if r.count_ops() < 800 else r


def exp_poly_definite(expr, x, lo, hi):
    """Definite integral of an exp-poly-trig integrand between finite limits (None if not that class)."""
    terms = exp_poly_terms(expr, x)
    if terms is None:
        return None
    total = 0
    for a, d in terms.items():
        for n, c in d.items():
            if c == 0:
                continue
            F = _term_antiderivative(c, n, a, x)
            total += F.subs(x, hi) - F.subs(x, lo)
    if total == 0:
        return sp.Integer(0)
    return compact(real_form(total, real=not expr.has(sp.I)))


def compact(r):
    """Cheap normal form: one fraction, cancelled, common factors pulled out."""
    try:
        if r.count_ops() > 1500:
            return r
        r2 = sp.cancel(sp.together(sp.expand(r)))
        n, d = sp.fraction(r2)
        r3 = sp.factor_terms(sp.expand(n)) / sp.factor_terms(d)
        return r3 if r3.count_ops() <= 1.5 * r.count_ops() + 10 else r
    except SympyTimeout:
        raise
    except Exception:
        return r


# ------------------------------------------------------------------ pieces
_PW_TYPES = (sp.Heaviside, sp.Piecewise, sp.Abs, sp.sign, sp.Max, sp.Min)


def has_piecewise(expr, x):
    return any(q.has(x) for q in expr.atoms(sp.Heaviside, sp.Abs, sp.sign, sp.Max, sp.Min)) or expr.has(sp.Piecewise)


def _scan_roots(arg, x, flo, fhi):
    """Real zeros of a non-polynomial arg(x) inside the finite interval (numeric scan + exact guess)."""
    import math

    f = sp.lambdify(x, arg, modules=["math"])
    n = 720
    xs = [flo + (fhi - flo) * i / n for i in range(n + 1)]
    vals = []
    for v in xs:
        try:
            vals.append(float(f(v)))
        except Exception:
            vals.append(float("nan"))
    cands = []
    for i in range(n):
        a, b, fa, fb = xs[i], xs[i + 1], vals[i], vals[i + 1]
        if fa != fa or fb != fb:
            continue
        if fa == 0.0:
            cands.append(a)
        elif fa * fb < 0:
            for _ in range(60):
                m = 0.5 * (a + b)
                fm = float(f(m))
                if fm == 0.0:
                    a = b = m
                    break
                if fa * fm < 0:
                    b = m
                else:
                    a, fa = m, fm
            cands.append(0.5 * (a + b))
    if vals[-1] == 0.0:
        cands.append(xs[-1])
    out = []
    for r in cands:
        exact = None
        for guess in (sp.nsimplify(r, rational=True, tolerance=1e-10),
                      sp.nsimplify(r / math.pi, rational=True, tolerance=1e-10) * sp.pi):
            try:
                if guess.q if hasattr(guess, "q") and guess.is_Rational else 1:
                    den = guess.q if guess.is_Rational else sp.fraction(guess / sp.pi)[1]
                    if den > 5000:
                        continue
                if abs(float(sp.N(guess)) - r) < 1e-9 and abs(complex(sp.N(arg.subs(x, guess), 30))) < 1e-20:
                    exact = guess
                    break
            except Exception:
                continue
        out.append(exact if exact is not None else sp.Float(r, 17))
    return out


def _breakpoints(expr, x, flo=None, fhi=None):
    """Points where the piecewise structure of expr may change; None if they depend on parameters."""
    pts = set()

    def roots_of(arg):
        if not arg.has(x):
            return True
        if arg.free_symbols - {x}:
            return False
        if arg.is_polynomial(x):
            try:
                rs = sp.real_roots(sp.Poly(arg, x)) if sp.Poly(arg, x).degree() > 2 else sp.solve(arg, x)
            except Exception:
                return False
            for r in rs:
                try:
                    if r.is_real or abs(complex(sp.N(r)).imag) < 1e-14:
                        pts.add(sp.nsimplify(r) if r.is_Float else r)
                except Exception:
                    return False
            return True
        if flo is None or fhi is None or flo == float("-inf") or fhi == float("inf"):
            # non-polynomial switch on an unbounded range: trust solve only when the function is monotonic-like
            if arg.has(sp.sin, sp.cos, sp.tan):
                return False
            try:
                rs = sp.solve(arg, x)
            except Exception:
                return False
            for r in rs:
                if r.is_real:
                    pts.add(r)
            return True
        try:
            for r in _scan_roots(arg, x, flo, fhi):
                pts.add(r)
        except Exception:
            return False
        return True

    for h in expr.atoms(sp.Heaviside, sp.Abs, sp.sign):
        if not roots_of(h.args[0]):
            return None
    for m in expr.atoms(sp.Max, sp.Min):
        args = m.args
        for i in range(len(args)):
            for j in range(i + 1, len(args)):
                if not roots_of(args[i] - args[j]):
                    return None
    for pw in expr.atoms(sp.Piecewise):
        for _, cond in pw.args:
            if cond in (sp.true, sp.false):
                continue
            for rel in cond.atoms(sp.core.relational.Relational):
                if not roots_of(rel.lhs - rel.rhs):
                    return None
    return sorted(pts, key=lambda v: float(sp.N(v)))


def _at_sample(expr, x, mid):
    """expr with its piecewise atoms resolved for x near the sample point mid."""
    def val(a):
        v = a.subs(x, mid)
        return float(sp.N(v))

    def conv(e):
        if not isinstance(e, sp.Basic) or not e.args:
            return e
        if isinstance(e, sp.Heaviside) and e.args[0].has(x):
            return sp.Integer(1) if val(e.args[0]) > 0 else sp.Integer(0)
        if isinstance(e, sp.Abs) and e.args[0].has(x):
            inner = conv(e.args[0])
            return inner if val(e.args[0]) >= 0 else -inner
        if isinstance(e, sp.sign) and e.args[0].has(x):
            return sp.Integer(1) if val(e.args[0]) > 0 else sp.Integer(-1)
        if isinstance(e, (sp.Max, sp.Min)) and e.has(x):
            vals = [(val(a), a) for a in e.args]
            pick = max(vals, key=lambda t: t[0]) if isinstance(e, sp.Max) else min(vals, key=lambda t: t[0])
            return conv(pick[1])
        if isinstance(e, sp.Piecewise):
            for v, cond in e.args:
                cv = cond if cond in (sp.true, sp.false) else cond.subs(x, mid)
                if cv == True:  # noqa: E712
                    return conv(v)
                if cv != False:  # noqa: E712
                    try:
                        if bool(sp.N(cv)):
                            return conv(v)
                    except Exception:
                        raise ValueError("undecidable condition")
            return sp.Integer(0)
        return e.func(*[conv(a) for a in e.args])
    return conv(expr)


def split_pieces(expr, x, lo=-sp.oo, hi=sp.oo):
    """[(a, b, smooth_expr)] covering (lo, hi), or None when the break points are not numeric."""
    if not has_piecewise(expr, x):
        return [(lo, hi, expr)]
    try:
        flo = float(sp.N(lo)) if lo != -sp.oo else float("-inf")
        fhi = float(sp.N(hi)) if hi != sp.oo else float("inf")
        if not flo < fhi:
            return None
        pts = _breakpoints(expr, x, flo, fhi)
        if pts is None:
            return None
        inner = [p for p in pts if flo < float(sp.N(p)) < fhi]
        bounds = [lo] + inner + [hi]
        out = []
        for a, b in zip(bounds[:-1], bounds[1:]):
            fa = float(sp.N(a)) if a != -sp.oo else None
            fb = float(sp.N(b)) if b != sp.oo else None
            if fa is None and fb is None:
                mid = sp.Integer(0)
            elif fa is None:
                mid = sp.Float(fb - 1.0)
            elif fb is None:
                mid = sp.Float(fa + 1.0)
            else:
                mid = sp.Float(fa + 0.5 * (fb - fa))
            piece = _at_sample(expr, x, mid)
            if out and out[-1][2] == piece:
                out[-1] = (out[-1][0], b, piece)
            else:
                out.append((a, b, piece))
        return out
    except SympyTimeout:
        raise
    except Exception:
        return None


def definite_fast(expr, x, lo, hi):
    """Definite integral with numeric limits of a (piecewise) exp-poly-trig integrand; None if not applicable."""
    if lo.free_symbols or hi.free_symbols or lo in (sp.oo, -sp.oo) or hi in (sp.oo, -sp.oo):
        if has_piecewise(expr, x):
            return None
        return exp_poly_definite(expr, x, lo, hi) if lo not in (sp.oo, -sp.oo) and hi not in (sp.oo, -sp.oo) else None
    try:
        flo, fhi = float(sp.N(lo)), float(sp.N(hi))
    except Exception:
        return None
    if flo == fhi:
        return sp.Integer(0)
    sign = 1
    if flo > fhi:
        lo, hi, sign = hi, lo, -1
    pieces = split_pieces(expr, x, lo, hi)
    if pieces is None:
        return None
    total = 0
    for a, b, g in pieces:
        if g == 0:
            continue
        v = exp_poly_definite(g, x, a, b)
        if v is None:
            return None
        total += v
    return sign * total


# ----------------------------------------------------------------- Laplace
def laplace_fast(fs, t, s):
    """Laplace transform of a causal piecewise exp-poly-trig function (t > 0). None if not applicable."""
    pieces = split_pieces(fs, t, sp.Integer(0), sp.oo)
    if pieces is None:
        return None
    total = 0
    for a, b, g in pieces:
        if g == 0:
            continue
        terms = exp_poly_terms(g, t)
        if terms is None:
            return None
        for al, d in terms.items():
            for n, c in d.items():
                if c == 0:
                    continue
                F = _term_antiderivative(c, n, al - s, t)
                up = 0 if b == sp.oo else F.subs(t, b)
                total += up - F.subs(t, a)
    if total == 0:
        return sp.Integer(0)
    return tidy_transform(real_form(total, real=not fs.has(sp.I)), s)


def tidy_transform(r, s):
    """Rational function of s (possibly with e^(-a s) factors) in a compact real form."""
    try:
        groups = split_exponentials(r, s)
        if groups is None:
            return r
        out = 0
        for c, R in sorted(groups.items(), key=lambda kv: sp.default_sort_key(kv[0])):
            g = sp.cancel(sp.together(R))
            n2, d2 = sp.fraction(g)
            out += sp.exp(c * s) * sp.factor_terms(sp.expand(n2)) / sp.factor(d2)
        # one common denominator when every group shares it (Mathematica's usual shape)
        try:
            dens = {sp.factor(sp.fraction(sp.cancel(sp.together(R)))[1]) for R in groups.values()}
            if len(groups) > 1 and len(dens) == 1:
                den = dens.pop()
                num = sum(sp.exp(c * s) * sp.fraction(sp.cancel(sp.together(R)))[0] for c, R in groups.items())
                lead = sp.Poly(den, s).LC() if den.is_polynomial(s) else 1
                return num / den
        except SympyTimeout:
            raise
        except Exception:
            pass
        return out
    except SympyTimeout:
        raise
    except Exception:
        return r


def _residue_term(R, s, t, root, mult):
    """Residue of R(s) e^(s t) at a pole of multiplicity mult."""
    g = sp.cancel(R * (s - root) ** mult)
    expr = g * sp.exp(s * t)
    if mult > 1:
        expr = sp.diff(expr, s, mult - 1) / sp.factorial(mult - 1)
    return expr.subs(s, root)


def inverse_rational(R, s, t):
    """Inverse Laplace transform (t > 0) of a rational function of s, in real form. None if poles unknown."""
    R = sp.cancel(sp.together(R))
    num, den = sp.fraction(R)
    try:
        pn, pd = sp.Poly(num, s), sp.Poly(den, s)
    except Exception:
        return None
    result = 0
    if pn.degree() >= pd.degree():
        q, rem = sp.div(pn, pd)
        for (k,), c in q.terms():
            result += c * (sp.DiracDelta(t) if k == 0 else sp.DiracDelta(t, k))
        pn = rem
        if pn.is_zero:
            return result
    Rp = pn.as_expr() / pd.as_expr()
    roots = sp.roots(pd, s)
    if sum(roots.values()) != pd.degree():
        # numeric poles for numeric denominators without closed-form roots
        if pd.free_symbols - {s}:
            return None
        roots = {}
        for r in pd.nroots(n=17, maxsteps=200):
            key = None
            for k_ in roots:
                if abs(complex(k_) - complex(r)) < 1e-9:
                    key = k_
            if key is None:
                roots[r] = 1
            else:
                roots[key] += 1
    done = set()
    for r, m in roots.items():
        if r in done:
            continue
        cr = sp.conjugate(r)
        is_real = sp.im(r) == 0 or r.is_real
        term = _residue_term(Rp, s, t, r, m)
        if is_real is True:
            result += sp.expand(term)
            done.add(r)
            continue
        if cr != r and cr in roots and not Rp.atoms(sp.I) :
            # real coefficients: conjugate poles give twice the real part
            re_part = sp.re(sp.expand_complex(term))
            result += 2 * re_part
            done.add(r)
            done.add(cr)
        else:
            result += term
            done.add(r)
    if result.has(sp.re) or result.has(sp.im):
        return None
    if result.has(sp.I):
        result = real_form(result, real=not R.has(sp.I))
    return sp.expand(result)


def split_exponentials(F, s):
    """F = sum_c e^(c s) R_c(s) -> {c: R_c}; None if F is not of that form."""
    F = sp.together(F)
    num, den = sp.fraction(F)
    if any(e.has(s) for e in den.atoms(sp.exp)):
        # exponentials downstairs: multiply through if it is a single monomial e^(a s)
        dfs = sp.Mul.make_args(sp.factor_terms(den))
        ex = [f for f in dfs if isinstance(f, sp.exp) and f.has(s)]
        rest = [f for f in dfs if not (isinstance(f, sp.exp) and f.has(s))]
        if any(e.has(s) for r_ in rest for e in r_.atoms(sp.exp)):
            return None
        for f in ex:
            num = num * sp.exp(-f.args[0])
        den = sp.Mul(*rest)
    num = sp.expand(num)
    groups = {}
    for term in sp.Add.make_args(num):
        c = sp.Integer(0)
        rest = sp.Integer(1)
        for fac in sp.Mul.make_args(term):
            if isinstance(fac, sp.exp) and fac.has(s):
                lc = _linear_coeff(fac.args[0], s)
                if lc is None:
                    return None
                c += lc[0]
                rest *= sp.exp(lc[1])
            elif isinstance(fac, sp.Pow) and isinstance(fac.base, sp.exp) and fac.base.has(s) and not fac.exp.has(s):
                lc = _linear_coeff(fac.base.args[0] * fac.exp, s)
                if lc is None:
                    return None
                c += lc[0]
                rest *= sp.exp(lc[1])
            else:
                rest *= fac
        if any(e.has(s) for e in rest.atoms(sp.exp)):
            return None
        groups[c] = groups.get(c, 0) + rest
    return {c: v / den for c, v in groups.items() if v != 0}


def inverse_laplace_fast(F, s, t):
    """Inverse Laplace transform of sum e^(-a s) R(s) with R rational: sum H(t - a) f(t - a)."""
    groups = split_exponentials(F, s)
    if groups is None:
        return None
    total = 0
    for c, R in groups.items():
        if R.has(sp.exp) and any(e.has(s) for e in R.atoms(sp.exp)):
            return None
        if not R.is_rational_function(s):
            return None
        f = inverse_rational(R, s, t)
        if f is None:
            return None
        if c == 0:
            total += f
        else:
            neg = (-c)
            ok = neg.is_positive or (neg.is_number and float(sp.N(neg)) > 0) or bool(neg.free_symbols)
            if not ok:
                return None
            total += sp.Heaviside(t - neg) * f.subs(t, t - neg)
    return total


# ------------------------------------------------------- numeric quadrature
def numeric_integral(expr, x, lo, hi):
    """mpmath quadrature of a (piecewise) expression without free parameters; None on failure."""
    import mpmath

    if expr.free_symbols - {x} or lo.free_symbols or hi.free_symbols:
        return None
    try:
        pieces = split_pieces(expr, x, lo, hi) or [(lo, hi, expr)]
        total = mpmath.mpf(0)
        for a, b, g in pieces:
            if g == 0:
                continue
            f = sp.lambdify(x, g, modules=["mpmath"])
            fa = mpmath.mpf(-mpmath.inf) if a == -sp.oo else mpmath.mpmathify(sp.N(a, 20))
            fb = mpmath.mpf(mpmath.inf) if b == sp.oo else mpmath.mpmathify(sp.N(b, 20))
            total += mpmath.quad(f, [fa, fb])
        v = complex(total)
        if v != v:
            return None
        return sp.Float(v.real) if abs(v.imag) < 1e-13 * (1 + abs(v.real)) else sp.Float(v.real) + sp.I * sp.Float(v.imag)
    except SympyTimeout:
        raise
    except Exception:
        return None


def half_angle_radicals(expr, x):
    """Sqrt[2 - 2 Cos[u]] -> 2 Abs[Sin[u/2]], Sqrt[2 + 2 Cos[u]] -> 2 Abs[Cos[u/2]] (after simplifying the radicand)."""
    def fix(p):
        if not (p.exp == sp.Rational(1, 2) and p.base.has(sp.cos, sp.sin) and p.base.has(x)):
            return p
        try:
            rad = sp.expand(sp.trigsimp(sp.expand(p.base)))
        except Exception:
            return p
        cs = [c_ for c_ in rad.atoms(sp.cos) if c_.has(x)]
        if len(cs) != 1 or rad.atoms(sp.sin):
            return p
        cu = cs[0]
        k = rad.coeff(cu, 1)
        m = sp.expand(rad - k * cu)
        if m.has(x) or k.has(x) or not (m.is_positive and k.is_real):
            return p
        if sp.simplify(m + k) == 0:      # m (1 - cos u)
            return sp.sqrt(2 * m) * sp.Abs(sp.sin(cu.args[0] / 2))
        if sp.simplify(m - k) == 0:      # m (1 + cos u)
            return sp.sqrt(2 * m) * sp.Abs(sp.cos(cu.args[0] / 2))
        return p
    try:
        return expr.replace(lambda p: isinstance(p, sp.Pow), fix)
    except Exception:
        return expr
