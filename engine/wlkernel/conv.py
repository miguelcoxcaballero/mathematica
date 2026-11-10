# -*- coding: utf-8 -*-
"""Small, predictable Mathics <-> SymPy converter used by the extension builtins."""
import sympy as sp
from mathics.core.atoms import Complex, Integer, MachineReal, PrecisionReal, Rational, Real, String
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolFalse, SymbolTrue


def E(head, *args):
    return Expression(head, *args)


class ConvError(Exception):
    pass


S = lambda n: Symbol("System`" + n)  # noqa: E731

FUNCS = {
    "Sin": sp.sin, "Cos": sp.cos, "Tan": sp.tan, "Cot": sp.cot, "Sec": sp.sec, "Csc": sp.csc,
    "ArcSin": sp.asin, "ArcCos": sp.acos, "ArcTan": None, "ArcCot": sp.acot, "ArcSec": sp.asec, "ArcCsc": sp.acsc,
    "Sinh": sp.sinh, "Cosh": sp.cosh, "Tanh": sp.tanh, "Coth": sp.coth, "Sech": sp.sech, "Csch": sp.csch,
    "ArcSinh": sp.asinh, "ArcCosh": sp.acosh, "ArcTanh": sp.atanh,
    "Exp": sp.exp, "Abs": sp.Abs, "Sign": sp.sign, "Re": sp.re, "Im": sp.im, "Conjugate": sp.conjugate,
    "Arg": sp.arg, "Gamma": sp.gamma, "Factorial": sp.factorial, "Binomial": sp.binomial, "Erf": sp.erf,
    "Erfc": sp.erfc, "Erfi": sp.erfi, "Floor": sp.floor, "Ceiling": sp.ceiling, "Max": sp.Max, "Min": sp.Min,
    "HeavisideTheta": sp.Heaviside, "DiracDelta": sp.DiracDelta, "BesselJ": sp.besselj,
    "BesselY": sp.bessely, "BesselI": sp.besseli, "BesselK": sp.besselk, "Zeta": sp.zeta, "ProductLog": sp.LambertW,
    "SinIntegral": sp.Si, "CosIntegral": sp.Ci, "ExpIntegralEi": sp.Ei, "FresnelS": sp.fresnels,
    "FresnelC": sp.fresnelc, "KroneckerDelta": sp.KroneckerDelta, "LegendreP": sp.legendre,
    "PolyGamma": None, "Beta": sp.beta, "Sinc": sp.sinc, "EllipticK": sp.elliptic_k, "EllipticE": sp.elliptic_e,
    "Mod": sp.Mod, "LogGamma": sp.loggamma, "HermiteH": sp.hermite, "ChebyshevT": sp.chebyshevt,
    "LaguerreL": sp.laguerre, "ExpIntegralE": sp.expint, "Factorial2": sp.factorial2, "Fibonacci": sp.fibonacci,
}
CONSTS = {
    "Pi": sp.pi, "E": sp.E, "I": sp.I, "Infinity": sp.oo, "ComplexInfinity": sp.zoo, "EulerGamma": sp.EulerGamma,
    "GoldenRatio": sp.GoldenRatio, "Catalan": sp.Catalan, "True": sp.true, "False": sp.false,
    "Indeterminate": sp.nan, "Degree": sp.pi / 180,
}
REL = {"Equal": sp.Eq, "Unequal": sp.Ne, "Less": sp.Lt, "LessEqual": sp.Le, "Greater": sp.Gt, "GreaterEqual": sp.Ge}

REV_FUNCS = {}
for _k, _v in FUNCS.items():
    if _v is not None and _v not in REV_FUNCS:
        REV_FUNCS[_v] = _k
REV_FUNCS[sp.Heaviside] = "HeavisideTheta"


class Conv:
    """Converter bound to assumptions for particular symbols."""

    def __init__(self, funcs=(), real=(), positive=(), integer=(), heaviside="HeavisideTheta"):
        self.funcs = set(funcs)      # full names of symbols to be treated as undetermined functions
        self.real = set(real)
        self.positive = set(positive)
        self.integer = set(integer)
        self.syms = {}
        self.heaviside = heaviside
        self._unitstep = False
        self._theta = False

    # ------------------------------------------------------------ to sympy
    def sym(self, name):
        if name not in self.syms:
            kw = {}
            if name in self.positive:
                kw["positive"] = True
            elif name in self.real:
                kw["real"] = True
            if name in self.integer:
                kw["integer"] = True
            self.syms[name] = sp.Symbol(name, **kw)
        return self.syms[name]

    def to(self, e):
        if isinstance(e, Integer):
            return sp.Integer(e.value)
        if isinstance(e, Rational):
            return sp.Rational(e.value.p, e.value.q) if hasattr(e.value, "p") else sp.Rational(str(e.value))
        if isinstance(e, (MachineReal, PrecisionReal, Real)):
            return sp.Float(e.to_python())
        if isinstance(e, Complex):
            return self.to(e.real) + sp.I * self.to(e.imag)
        if isinstance(e, String):
            return sp.Symbol('"' + e.value + '"')
        if isinstance(e, Symbol):
            name = e.get_name()
            short = name.split("`")[-1]
            if name.startswith("System`") and short in CONSTS:
                return CONSTS[short]
            return self.sym(name)
        if not isinstance(e, Expression):
            raise ConvError("atom %r" % (e,))
        head = e.get_head()
        hn = e.get_head_name()
        el = e.elements
        short = hn.split("`")[-1] if hn.startswith("System`") else None
        if short == "Plus":
            return sp.Add(*[self.to(x) for x in el])
        if short == "Times":
            return sp.Mul(*[self.to(x) for x in el])
        if short == "Power":
            return sp.Pow(self.to(el[0]), self.to(el[1]))
        if short == "Sqrt":
            return sp.sqrt(self.to(el[0]))
        if short == "Log":
            if len(el) == 1:
                return sp.log(self.to(el[0]))
            return sp.log(self.to(el[1])) / sp.log(self.to(el[0]))
        if short == "ArcTan":
            if len(el) == 1:
                return sp.atan(self.to(el[0]))
            return sp.atan2(self.to(el[1]), self.to(el[0]))
        if short == "UnitStep" and len(el) == 1:
            self._unitstep = True
            return sp.Heaviside(self.to(el[0]), 1)
        if short == "HeavisideTheta" and len(el) == 1:
            self._theta = True
            return sp.Heaviside(self.to(el[0]))
        if short == "Boole" and len(el) == 1:
            return sp.Piecewise((sp.Integer(1), self.to(el[0])), (sp.Integer(0), True))
        if short == "UnitBox" and len(el) == 1:
            return sp.Piecewise((sp.Integer(1), sp.Abs(self.to(el[0])) <= sp.Rational(1, 2)), (sp.Integer(0), True))
        if short == "UnitTriangle" and len(el) == 1:
            a_ = self.to(el[0])
            return sp.Piecewise((1 - sp.Abs(a_), sp.Abs(a_) <= 1), (sp.Integer(0), True))
        if short == "Ramp" and len(el) == 1:
            a_ = self.to(el[0])
            return sp.Piecewise((a_, a_ >= 0), (sp.Integer(0), True))
        if short == "Surd" and len(el) == 2:
            return sp.real_root(self.to(el[0]), self.to(el[1]))
        if short == "CubeRoot" and len(el) == 1:
            return sp.real_root(self.to(el[0]), 3)
        if short == "Log10" and len(el) == 1:
            return sp.log(self.to(el[0])) / sp.log(10)
        if short == "Log2" and len(el) == 1:
            return sp.log(self.to(el[0])) / sp.log(2)
        if short == "PolyGamma":
            return sp.polygamma(self.to(el[0]), self.to(el[1])) if len(el) == 2 else sp.digamma(self.to(el[0]))
        if short == "DirectedInfinity":
            if len(el) == 0:
                return sp.zoo
            return self.to(el[0]) * sp.oo
        if short in FUNCS and FUNCS[short] is not None:
            return FUNCS[short](*[self.to(x) for x in el])
        if short in REL and len(el) == 2:
            return REL[short](self.to(el[0]), self.to(el[1]))
        if short in REL and len(el) > 2:
            return sp.And(*[REL[short](self.to(a), self.to(b)) for a, b in zip(el[:-1], el[1:])])
        if short == "Inequality":
            parts = []
            for i in range(0, len(el) - 2, 2):
                op = el[i + 1].get_name().split("`")[-1]
                parts.append(REL[op](self.to(el[i]), self.to(el[i + 2])))
            return sp.And(*parts)
        if short == "And":
            return sp.And(*[self.to(x) for x in el])
        if short == "Or":
            return sp.Or(*[self.to(x) for x in el])
        if short == "Not":
            return sp.Not(self.to(el[0]))
        if short == "List":
            return [self.to(x) for x in el]
        if short == "Rational":
            return sp.Rational(self.to(el[0]), self.to(el[1]))
        if short == "Complex":
            return self.to(el[0]) + sp.I * self.to(el[1])
        if short == "Piecewise":
            pieces = [(self.to(p.elements[0]), self.to(p.elements[1])) for p in el[0].elements]
            default = self.to(el[1]) if len(el) > 1 else sp.Integer(0)
            pieces.append((default, True))
            return sp.Piecewise(*pieces)
        if short == "If" and len(el) == 3:
            return sp.Piecewise((self.to(el[1]), self.to(el[0])), (self.to(el[2]), True))
        if short == "C" and len(el) == 1:
            return self.sym("C[%s]" % el[0])
        if short == "Element":
            dom = el[1].get_name().split("`")[-1]
            return sp.Symbol("Element_%s" % dom)
        # Derivative[n][f][x]
        if isinstance(head, Expression) and isinstance(head.get_head(), Expression) and \
                head.get_head().get_head_name() == "System`Derivative":
            orders = [o.value for o in head.get_head().elements]
            f = head.elements[0]
            fname = f.get_name()
            args = [self.to(x) for x in el]
            fn = sp.Function(fname)
            res = fn(*args)
            # derivative wrt positional slots
            dummies = []
            for i, (o, a) in enumerate(zip(orders, args)):
                if o == 0:
                    continue
                if isinstance(a, sp.Symbol):
                    res = sp.Derivative(res, (a, o))
                else:
                    d = sp.Dummy("xi%d" % i)
                    inner = fn(*[d if j == i else aa for j, aa in enumerate(args)])
                    res = sp.Subs(sp.Derivative(inner, (d, o)), d, a)
            return res
        if isinstance(head, Symbol) and hn.endswith("`atan2") and len(el) == 2:
            return sp.atan2(self.to(el[0]), self.to(el[1]))     # name leaked by Mathics' own SymPy bridge
        # user/undetermined function f[x]
        if isinstance(head, Symbol) and (hn in self.funcs or not hn.startswith("System`")):
            return sp.Function(hn)(*[self.to(x) for x in el])
        raise ConvError("cannot convert %s" % hn)

    # ---------------------------------------------------------- from sympy
    def back(self, s):
        E = Expression
        if isinstance(s, (list, tuple)):
            return ListExpression(*[self.back(x) for x in s])
        if isinstance(s, sp.MatrixBase):
            return ListExpression(*[ListExpression(*[self.back(x) for x in row]) for row in s.tolist()])
        if s is sp.true or s is True:
            return SymbolTrue
        if s is sp.false or s is False:
            return SymbolFalse
        if isinstance(s, sp.Integer) or isinstance(s, int):
            return Integer(int(s))
        if isinstance(s, sp.Rational):
            return E(S("Times"), Integer(int(s.p)), E(S("Power"), Integer(int(s.q)), Integer(-1)))
        if isinstance(s, sp.Float) or isinstance(s, float):
            return Real(float(s))
        if s is sp.pi:
            return S("Pi")
        if s is sp.E:
            return S("E")
        if s is sp.I:
            return S("I")
        if s is sp.oo:
            return E(S("DirectedInfinity"), Integer(1))
        if s is -sp.oo:
            return E(S("DirectedInfinity"), Integer(-1))
        if s is sp.zoo:
            return E(S("DirectedInfinity"))
        if s is sp.nan:
            return S("Indeterminate")
        if s is sp.EulerGamma:
            return S("EulerGamma")
        if s is sp.GoldenRatio:
            return S("GoldenRatio")
        if s is sp.Catalan:
            return S("Catalan")
        if isinstance(s, sp.Symbol):
            n = s.name
            if n.startswith("C[") and n.endswith("]"):
                return E(S("C"), Integer(int(n[2:-1])))
            if n.startswith('"'):
                return String(n.strip('"'))
            if "`" in n:
                return Symbol(n)
            return Symbol("Global`" + n)
        if isinstance(s, sp.Add):
            return E(S("Plus"), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Mul):
            return E(S("Times"), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Pow):
            return E(S("Power"), self.back(s.base), self.back(s.exp))
        if isinstance(s, sp.exp):
            return E(S("Power"), S("E"), self.back(s.args[0]))
        if isinstance(s, sp.log):
            return E(S("Log"), self.back(s.args[0]))
        if isinstance(s, sp.atan2):
            return E(S("ArcTan"), self.back(s.args[1]), self.back(s.args[0]))
        if isinstance(s, sp.atan):
            return E(S("ArcTan"), self.back(s.args[0]))
        if isinstance(s, sp.sinc):
            a_ = self.back(s.args[0])
            return E(S("Times"), E(S("Sin"), a_), E(S("Power"), a_, Integer(-1)))
        if isinstance(s, sp.Heaviside):
            return E(S("UnitStep" if self._unitstep and not self._theta else self.heaviside), self.back(s.args[0]))
        if isinstance(s, sp.polygamma):
            return E(S("PolyGamma"), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Piecewise):
            pieces = []
            default = Integer(0)
            for val, cond in s.args:
                if cond is sp.true:
                    default = self.back(val)
                    break
                pieces.append(ListExpression(self.back(val), self.back(cond)))
            if not pieces:
                return default
            return E(S("Piecewise"), ListExpression(*pieces), default)
        for rel, name in ((sp.Eq, "Equal"), (sp.Ne, "Unequal"), (sp.Lt, "Less"), (sp.Le, "LessEqual"),
                          (sp.Gt, "Greater"), (sp.Ge, "GreaterEqual")):
            if isinstance(s, rel):
                return E(S(name), self.back(s.args[0]), self.back(s.args[1]))
        if isinstance(s, sp.And):
            return E(S("And"), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Or):
            return E(S("Or"), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Not):
            return E(S("Not"), self.back(s.args[0]))
        if isinstance(s, sp.Derivative):
            f = s.expr
            if isinstance(f, sp.core.function.AppliedUndef):
                orders = [0] * len(f.args)
                ok = True
                for v, n in s.variable_count:
                    if v in f.args:
                        orders[list(f.args).index(v)] += int(n)
                    else:
                        ok = False
                if ok:
                    d = E(E(S("Derivative"), *[Integer(o) for o in orders]), Symbol(f.func.__name__))
                    return E(d, *[self.back(a) for a in f.args])
            return E(S("D"), self.back(f), *[ListExpression(self.back(v), Integer(int(n)))
                                             for v, n in s.variable_count])
        if isinstance(s, sp.Subs):
            inner = self.back(s.expr)
            rules = [E(S("Rule"), self.back(v), self.back(p)) for v, p in zip(s.variables, s.point)]
            # Derivative[n][f][xi] /. xi -> a  ==> Derivative[n][f][a]
            return E(S("ReplaceAll"), inner, ListExpression(*rules))
        if isinstance(s, sp.core.function.AppliedUndef):
            name = s.func.__name__
            if name.startswith("WLXC") and name[4:].isdigit():
                return E(E(S("C"), Integer(int(name[4:]))), *[self.back(a) for a in s.args])
            return E(Symbol(name if "`" in name else "Global`" + name), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Integral):
            lims = []
            for lim in s.limits:
                if len(lim) == 3:
                    lims.append(ListExpression(*[self.back(x) for x in lim]))
                else:
                    lims.append(self.back(lim[0]))
            return E(S("Integrate"), self.back(s.function), *lims)
        if isinstance(s, sp.Sum):
            return E(S("Sum"), self.back(s.function), *[ListExpression(*[self.back(x) for x in lim])
                                                        for lim in s.limits])
        if isinstance(s, sp.LaplaceTransform):
            return E(S("LaplaceTransform"), *[self.back(a) for a in s.args[:3]])
        if isinstance(s, sp.InverseLaplaceTransform):
            return E(S("InverseLaplaceTransform"), *[self.back(a) for a in s.args[:3]])
        if isinstance(s, sp.RootOf):
            poly = s.expr
            x = s.poly.gen
            slot = E(S("Slot"), Integer(1))
            body = self.back(poly.subs(x, sp.Symbol("Global`￿slot")))
            body = body.replace_vars({"Global`￿slot": slot}) if hasattr(body, "replace_vars") else body
            return E(S("Root"), E(S("Function"), body), Integer(s.index + 1))
        if isinstance(s, sp.re):
            return E(S("Re"), self.back(s.args[0]))
        if isinstance(s, sp.im):
            return E(S("Im"), self.back(s.args[0]))
        if isinstance(s, sp.Tuple):
            return ListExpression(*[self.back(a) for a in s.args])
        if isinstance(s, sp.Dummy):
            return Symbol("Global`" + s.name)
        f = type(s)
        if f in REV_FUNCS:
            return E(S(REV_FUNCS[f]), *[self.back(a) for a in s.args])
        if isinstance(s, sp.Number):
            return Real(float(s))
        if isinstance(s, sp.Order):
            return E(S("O"), self.back(s.args[0]))
        raise ConvError("cannot convert back %s (%s)" % (s, type(s).__name__))


def is_free_of(expr, name):
    """True if Mathics expr does not contain symbol named `name`."""
    if isinstance(expr, Symbol):
        return expr.get_name() != name
    if isinstance(expr, Expression):
        if not is_free_of(expr.get_head(), name):
            return False
        return all(is_free_of(e, name) for e in expr.elements)
    return True
