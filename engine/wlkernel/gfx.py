# -*- coding: utf-8 -*-
"""Graphics layer: plotting builtins that sample numerically and emit JSON specs
rendered by the front-end in Mathematica style, plus Manipulate support."""
import math

import sympy as sp
from mathics.core.atoms import Integer, Real, String
from mathics.core.attributes import A_HOLD_ALL, A_PROTECTED, A_READ_PROTECTED
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolNull, SymbolTrue, SymbolFalse

from .conv import Conv, ConvError, S
from . import ext
from .ext import E, L, Rule, XB, pyval, short

K = None
PALETTE = ["#5E81B5", "#E19C24", "#8FB032", "#EB6235", "#8778B3", "#C56E1A", "#5D9EC7", "#FFBF00", "#A5609D",
           "#929600", "#E95536", "#6685D9", "#F89F13", "#BC5B80", "#47B66D"]
NAMED = {"Red": "#ff0000", "Green": "#00ff00", "Blue": "#0000ff", "Black": "#000000", "White": "#ffffff",
         "Gray": "#808080", "Cyan": "#00ffff", "Magenta": "#ff00ff", "Yellow": "#ffff00", "Brown": "#996633",
         "Orange": "#ff8000", "Pink": "#ff80ff", "Purple": "#800080", "LightRed": "#ffd9d9",
         "LightGreen": "#e0ffe0", "LightBlue": "#deebff", "LightGray": "#d9d9d9", "LightCyan": "#e6ffff",
         "LightMagenta": "#ffe6ff", "LightYellow": "#ffffd9", "LightBrown": "#f0e0d1", "LightOrange": "#ffe6cc",
         "LightPink": "#ffecff", "LightPurple": "#f0d9f0", "Transparent": "#00000000", "Darker": None}

GOPTS = {
    "PlotRange": "Automatic", "PlotStyle": "Automatic", "AxesLabel": "None", "PlotLabel": "None", "Axes": "Automatic",
    "Frame": "Automatic", "FrameLabel": "None", "AspectRatio": "Automatic", "PlotLegends": "None", "Filling": "None",
    "FillingStyle": "Automatic", "GridLines": "None", "ImageSize": "Automatic", "PlotPoints": "Automatic",
    "MaxRecursion": "Automatic", "Epilog": "{}", "Prolog": "{}", "AxesOrigin": "Automatic", "Ticks": "Automatic",
    "Exclusions": "Automatic", "PlotTheme": "Automatic", "ColorFunction": "Automatic", "Mesh": "Automatic",
    "Contours": "Automatic", "ContourShading": "Automatic", "ContourStyle": "Automatic", "ContourLabels": "None",
    "BoundaryStyle": "Automatic", "VectorScale": "Automatic", "VectorPoints": "Automatic",
    "VectorStyle": "Automatic", "StreamPoints": "Automatic", "StreamStyle": "Automatic", "BoxRatios": "Automatic",
    "Boxed": "True", "ViewPoint": "Automatic", "PlotRangePadding": "Automatic", "Background": "None",
    "LabelStyle": "{}", "AxesStyle": "{}", "FrameTicks": "Automatic", "PlotMarkers": "None", "Joined": "False",
    "DataRange": "Automatic", "RegionFunction": "Automatic", "MeshStyle": "Automatic", "PerformanceGoal": "Automatic",
    "ColorFunctionScaling": "True", "ExclusionsStyle": "None", "PolarAxes": "False", "PlotLabels": "None",
    "ImagePadding": "Automatic", "BaseStyle": "{}", "MeshFunctions": "Automatic", "Lighting": "Automatic",
    "ViewVertical": "Automatic", "FrameStyle": "{}", "TicksStyle": "{}", "GridLinesStyle": "Automatic",
    "ClippingStyle": "Automatic", "WorkingPrecision": "MachinePrecision", "Evaluated": "Automatic",
    "VectorColorFunction": "Automatic", "StreamColorFunction": "Automatic", "StreamScale": "Automatic",
    "ScalingFunctions": "None", "PlotRangeClipping": "True", "AxesEdge": "Automatic", "FaceGrids": "None",
    "SphericalRegion": "False", "ViewAngle": "Automatic", "Method": "Automatic", "InterpolationOrder": "None",
    "LabelingFunction": "Automatic", "TargetUnits": "Automatic", "ImageMargins": "0", "Opacity": "Automatic",
    "MaxPlotPoints": "Automatic", "ExtentSize": "Automatic", "TextureCoordinateFunction": "Automatic",
    "NormalsFunction": "Automatic", "VectorMarkers": "Automatic", "VectorSizes": "Automatic",
    "VectorRange": "Automatic", "VectorAspectRatio": "Automatic", "IntervalMarkers": "Automatic",
}
PASS_OPTS = ["AxesLabel", "PlotLabel", "Axes", "Frame", "FrameLabel", "AspectRatio", "GridLines", "ImageSize",
             "Epilog", "Prolog", "AxesOrigin", "Ticks", "Background", "BoxRatios", "Boxed", "ViewPoint", "FrameTicks"]


def np():
    import numpy

    return numpy


def is_sym(e, name):
    return isinstance(e, Symbol) and e.get_name() == "System`" + name


def opt(options, name):
    return options.get("System`" + name)


def nlist(a, digits=5):
    """numpy array -> JSON list with NaN -> None and limited precision (digits+1 significant)."""
    n = np()
    a = n.asarray(a, dtype=float).ravel()
    if a.size == 0:
        return []
    bad = ~n.isfinite(a)
    anybad = bool(bad.any())
    if anybad:
        a = n.where(bad, 0.0, a)
    with n.errstate(all="ignore"):
        mag = n.where(a == 0, 1.0, n.abs(a))
        e = digits - n.floor(n.log10(mag))
        e = n.clip(e, -300, 300)
        p10 = n.power(10.0, e)
        r = n.where(e >= 0, n.round(a * p10) / p10, n.round(a / n.power(10.0, -e)) * n.power(10.0, -e))
    out = r.tolist()
    if anybad:
        for i in n.nonzero(bad)[0].tolist():
            out[i] = None
    return out


def pairs(xs, ys):
    return [nlist(xs), nlist(ys)]


# ------------------------------------------------------------------ styles
def hex2(v):
    return "%02x" % max(0, min(255, int(round(v * 255))))


def color_of(e, ev):
    """Return (hex, alpha) or None for a color expression."""
    hn = e.get_head_name() if isinstance(e, Expression) else None
    if isinstance(e, Symbol):
        nm = short(e)
        if nm in NAMED and NAMED[nm]:
            return NAMED[nm][:7], (0.0 if nm == "Transparent" else 1.0)
        return None
    if hn == "System`RGBColor":
        vals = [pyval(x, ev) for x in e.elements]
        if len(vals) == 1 and isinstance(e.elements[0], String):
            return e.elements[0].value, 1.0
        if len(vals) >= 3 and all(v is not None for v in vals):
            return "#" + hex2(vals[0]) + hex2(vals[1]) + hex2(vals[2]), (vals[3] if len(vals) > 3 else 1.0)
    if hn == "System`GrayLevel":
        v = pyval(e.elements[0], ev)
        a = pyval(e.elements[1], ev) if len(e.elements) > 1 else 1.0
        return "#" + hex2(v) * 3, a
    if hn == "System`Hue":
        import colorsys

        vals = [pyval(x, ev) for x in e.elements]
        h = vals[0] % 1.0
        s = vals[1] if len(vals) > 1 else 1.0
        b = vals[2] if len(vals) > 2 else 1.0
        r, g, bb = colorsys.hsv_to_rgb(h, s, b)
        return "#" + hex2(r) + hex2(g) + hex2(bb), (vals[3] if len(vals) > 3 else 1.0)
    if hn in ("System`Lighter", "System`Darker"):
        c = color_of(e.elements[0], ev)
        if c is None:
            return None
        f = pyval(e.elements[1], ev) if len(e.elements) > 1 else 1.0 / 3
        r, g, b = [int(c[0][i:i + 2], 16) / 255 for i in (1, 3, 5)]
        if hn.endswith("Lighter"):
            r, g, b = [v + (1 - v) * f for v in (r, g, b)]
        else:
            r, g, b = [v * (1 - f) for v in (r, g, b)]
        return "#" + hex2(r) + hex2(g) + hex2(b), c[1]
    if hn == "System`ColorData" or (isinstance(e, Expression) and e.get_head().get_head_name() == "System`ColorData"):
        try:
            i = int(pyval(e.elements[0], ev))
            return PALETTE[(i - 1) % len(PALETTE)], 1.0
        except Exception:
            return None
    return None


def apply_directive(st, d, ev):
    """Mutate style dict with directive d. Returns True if d was a directive."""
    if isinstance(d, Expression) and d.get_head_name() in ("System`Directive", "System`List"):
        ok = True
        for x in d.elements:
            ok = apply_directive(st, x, ev) and ok
        return ok
    c = color_of(d, ev)
    if c is not None:
        st["color"] = c[0]
        if c[1] is not None and c[1] < 1:
            st["opacity"] = c[1]
        return True
    if isinstance(d, Symbol):
        nm = short(d)
        if nm == "Thick":
            st["width"] = 2.6
        elif nm == "Thin":
            st["width"] = 0.7
        elif nm == "Dashed":
            st["dash"] = [6, 4]
        elif nm == "Dotted":
            st["dash"] = [1.5, 4]
        elif nm == "DotDashed":
            st["dash"] = [1.5, 4, 7, 4]
        elif nm in ("Automatic", "None", "Null"):
            return True
        else:
            return False
        return True
    if isinstance(d, Expression):
        hn = short(d.get_head()) if isinstance(d.get_head(), Symbol) else ""
        el = d.elements
        if hn == "Thickness":
            v = el[0]
            if isinstance(v, Symbol):
                st["width"] = {"Large": 3.2, "Medium": 2, "Small": 1, "Tiny": 0.6}.get(short(v), 1.6)
            else:
                st["width"] = max(0.4, (pyval(v, ev) or 0.004) * 420)
            return True
        if hn == "AbsoluteThickness":
            st["width"] = pyval(el[0], ev) or 1.5
            return True
        if hn == "PointSize":
            v = el[0]
            if isinstance(v, Symbol):
                st["psize"] = {"Large": 9, "Medium": 6, "Small": 4, "Tiny": 2.5}.get(short(v), 5)
            else:
                st["psize"] = max(1.5, (pyval(v, ev) or 0.012) * 420)
            return True
        if hn == "AbsolutePointSize":
            st["psize"] = pyval(el[0], ev) or 4
            return True
        if hn == "Opacity":
            st["opacity"] = pyval(el[0], ev)
            if len(el) > 1:
                apply_directive(st, el[1], ev)
            return True
        if hn in ("Dashing", "AbsoluteDashing"):
            v = el[0]
            if isinstance(v, Symbol):
                st["dash"] = {"Large": [10, 6], "Medium": [6, 4], "Small": [3, 3], "Tiny": [1.5, 3]}.get(short(v), [6, 4])
            elif v.has_form("List", None):
                vals = [pyval(x, ev) or 0.02 for x in v.elements]
                k = 420 if hn == "Dashing" else 1
                st["dash"] = [max(1, x * k) for x in vals] if vals else None
            else:
                st["dash"] = [max(1, (pyval(v, ev) or 0.02) * 420)] * 2
            return True
        if hn in ("EdgeForm", "FaceForm"):
            sub = {}
            for x in el:
                apply_directive(sub, x, ev)
            st["edge" if hn == "EdgeForm" else "face"] = sub if el and not is_sym(el[0], "None") else None
            return True
        if hn in ("FontSize", "Rule") and len(el) == 2 and short(el[0]) == "FontSize":
            st["fsize"] = pyval(el[1], ev)
            return True
        if hn in ("Arrowheads", "CapForm", "JoinForm", "Specularity", "Glow", "Lighting"):
            return True
    if isinstance(d, (Integer, Real)):
        return False
    return False


def styles_for(options, n, ev, key="PlotStyle"):
    """PlotStyle -> list of n style dicts (colors from the palette by default)."""
    ps = opt(options, key)
    base = [{"color": PALETTE[i % len(PALETTE)], "width": 1.6} for i in range(n)]
    if ps is None or is_sym(ps, "Automatic") or is_sym(ps, "None"):
        return base
    ps = ps.evaluate(ev)
    if ps.has_form("List", None) and len(ps.elements) > 0:
        items = list(ps.elements)
        if n == 1:
            # {Red, Thick} on a single curve is a combined directive
            apply_directive(base[0], ps, ev)
            return base
        for i in range(n):
            apply_directive(base[i], items[i % len(items)], ev)
        return base
    for st in base:
        apply_directive(st, ps, ev)
    return base


def label_text(e, ev):
    if e is None:
        return None
    if isinstance(e, String):
        return e.value
    if isinstance(e, Symbol) and short(e) in ("None", "Null", "Automatic"):
        return None
    if isinstance(e, Expression) and e.get_head_name() in ("System`Style", "System`HoldForm", "System`Text",
                                                           "System`Placed", "System`Tooltip", "System`Framed"):
        return label_text(e.elements[0], ev)
    if isinstance(e, Expression) and e.get_head_name() == "System`Row":
        return "".join(label_text(x, ev) or "" for x in e.elements[0].elements)
    try:
        t = K.to_text(e, "OutputForm")
        return t.replace(" ^ ", "^")
    except Exception:
        return str(e)


# ------------------------------------------------------- numeric sampling
def hold_eval(body, vars, ev):
    try:
        r = E("Block", L(*vars), E("Hold", E("Evaluate", body))).evaluate(ev)
        if r.get_head_name() == "System`Hold" and len(r.elements) == 1:
            return r.elements[0]
    except ext_Deadline():
        raise
    except Exception:
        pass
    return body


def ext_Deadline():
    from .core import Deadline

    return Deadline


def strip_wrappers(e):
    while isinstance(e, Expression) and e.get_head_name() in ("System`Tooltip", "System`Evaluate", "System`Labeled",
                                                              "System`Legended", "System`Style", "System`Callout"):
        e = e.elements[0]
    return e


class PConv(Conv):
    """Conv with extra numeric-only heads used when sampling plots."""

    def __init__(self):
        super().__init__()
        self.extra = {}
        self.cplx = False

    def fn(self, name, impl, *args):
        self.extra[name] = impl
        return sp.Function(name)(*args)

    def to(self, e):
        n = np()
        if isinstance(e, Expression):
            head = e.get_head()
            el = e.elements
            if isinstance(head, Expression):
                if head.get_head_name() == "System`InterpolatingFunction" and len(head.elements) == 3 and len(el) == 1:
                    try:
                        pid, order = head.elements[1].value, head.elements[2].value
                        p = K.registry.get(pid)
                    except Exception:
                        p = None
                    if p is not None and order < len(p["cols"]):
                        t, col = n.asarray(p["t"], dtype=float), n.asarray(p["cols"][order], dtype=float)
                        return self.fn("WLXIF_%d_%d" % (pid, order),
                                       lambda a, t=t, col=col: n.interp(n.real(n.asarray(a)).astype(float), t, col),
                                       self.to(el[0]))
                return super().to(e)
            hn = e.get_head_name()
            sh = hn[7:] if hn.startswith("System`") else None
            if sh in ("Max", "Min") and el:
                args = []
                for x in el:
                    if isinstance(x, Expression) and x.has_form("List", None):
                        args.extend(self.to(y) for y in x.elements)
                    else:
                        args.append(self.to(x))
                op = n.fmax if sh == "Max" else n.fmin
                return self.fn("WLX" + sh, lambda *a, op=op: _reduce(op, [n.real(v) if n.iscomplexobj(v) else v for v in a]), *args)
            if sh in ("Re", "Im", "Abs", "Arg", "Conjugate", "Norm"):
                self.cplx = True
            if hn.endswith("`atan2") and len(el) == 2:
                return sp.atan2(self.to(el[0]), self.to(el[1]))
            if sh == "Subtract" and len(el) == 2:
                return self.to(el[0]) - self.to(el[1])
            if sh == "Minus" and len(el) == 1:
                return -self.to(el[0])
            if sh == "Divide" and len(el) == 2:
                return self.to(el[0]) / self.to(el[1])
            if sh in ("N", "Chop", "Evaluate", "Simplify", "FullSimplify", "Expand", "Rationalize", "HoldForm", "Together",
                      "TrigReduce", "Factor", "ComplexExpand", "Identity", "ExpToTrig", "TrigToExp", "PowerExpand",
                      "Refine", "TrigExpand", "ExpandAll", "Apart", "Cancel") and len(el) >= 1:
                return self.to(el[0])
            if sh == "Norm" and len(el) == 1:
                if isinstance(el[0], Expression) and el[0].has_form("List", None):
                    return sp.sqrt(sp.Add(*[sp.Abs(self.to(x)) ** 2 for x in el[0].elements]))
                return sp.Abs(self.to(el[0]))
            if sh == "Boole" and len(el) == 1:
                return sp.Piecewise((sp.Integer(1), self.to(el[0])), (sp.Integer(0), True))
            if sh in ("CubeRoot", "Surd") and el:
                k = 3 if sh == "CubeRoot" else int(el[1].to_python())
                return self.fn("WLXSurd%d" % k, lambda a, k=k: n.sign(a) * n.abs(a) ** (1.0 / k) if k % 2 else n.sqrt(a),
                               self.to(el[0]))
            if sh == "Round" and len(el) == 1:
                return self.fn("WLXRound", lambda a: n.round(a), self.to(el[0]))
            if sh in ("Log10", "Log2") and len(el) == 1:
                return sp.log(self.to(el[0])) / sp.log(10 if sh == "Log10" else 2)
            if sh == "Clip" and len(el) >= 1:
                lo, hi = -1.0, 1.0
                if len(el) > 1 and el[1].has_form("List", 2):
                    lo, hi = float(el[1].elements[0].to_python()), float(el[1].elements[1].to_python())
                return self.fn("WLXClip%s" % abs(hash((lo, hi))), lambda a, lo=lo, hi=hi: n.clip(a, lo, hi), self.to(el[0]))
            if sh in ("UnitBox", "HeavisidePi") and len(el) == 1:
                return self.fn("WLXBox", lambda a: (n.abs(a) <= 0.5) * 1.0, self.to(el[0]))
            if sh in ("UnitTriangle", "HeavisideLambda") and len(el) == 1:
                return self.fn("WLXTri", lambda a: n.maximum(0.0, 1 - n.abs(a)), self.to(el[0]))
            if sh == "SquareWave" and len(el) == 1:
                return self.fn("WLXSq", lambda a: n.where(n.mod(a, 1.0) < 0.5, 1.0, -1.0), self.to(el[0]))
            if sh == "SawtoothWave" and len(el) == 1:
                return self.fn("WLXSaw", lambda a: n.mod(a, 1.0), self.to(el[0]))
            if sh == "TriangleWave" and len(el) == 1:
                return self.fn("WLXTriW", lambda a: 4 * n.abs(n.mod(a - 0.25, 1.0) - 0.5) - 1, self.to(el[0]))
            if sh == "Sinc" and len(el) == 1:
                return self.fn("WLXSinc", lambda a: n.sinc(n.asarray(a) / n.pi), self.to(el[0]))
            if sh == "FractionalPart" and len(el) == 1:
                return self.fn("WLXFrac", lambda a: n.asarray(a) - n.trunc(a), self.to(el[0]))
            if sh == "IntegerPart" and len(el) == 1:
                return self.fn("WLXIntP", lambda a: n.trunc(a), self.to(el[0]))
            if sh == "Total" and len(el) == 1 and el[0].has_form("List", None):
                return sp.Add(*[self.to(x) for x in el[0].elements])
            if sh == "Dot" and len(el) == 2 and el[0].has_form("List", None) and el[1].has_form("List", None) \
                    and len(el[0].elements) == len(el[1].elements):
                return sp.Add(*[self.to(x) * self.to(y) for x, y in zip(el[0].elements, el[1].elements)])
        elif isinstance(e, Symbol) and e.get_name() == "System`I":
            self.cplx = True
        return super().to(e)


def _lambdify(c, syms, s):
    return sp.lambdify(syms, s, modules=[c.extra, ext.NUMPY_EXTRA, "numpy"])


def _bad_sympy(s, syms):
    if s.free_symbols - set(syms):
        return True
    for a in s.atoms(sp.core.function.AppliedUndef):
        if not a.func.__name__.startswith("WLX"):
            return True
    return s.has(sp.Integral, sp.Derivative, sp.Subs, sp.Sum, sp.Product, sp.zoo, sp.nan)


FN_STATS = {"fast": 0, "slow": 0}


def _candidates(expr, vars, ev, raw):
    """Expressions to try for vectorised conversion: evaluated body, raw body, re-evaluated body."""
    yield expr
    if raw is not None and raw is not expr:
        yield raw
    try:
        e2 = hold_eval(expr, vars, ev)
    except ext_Deadline():
        raise
    except Exception:
        return
    if e2 is not expr and not (hasattr(e2, "sameQ") and e2.sameQ(expr)):
        yield e2


def make_fn(expr, vars, ev, complex_out=False, raw=None):
    """Return f(*numpy arrays) -> float array (nan where not real).
    f.slow tells whether the vectorised path failed (then f.cost = seconds per point)."""
    n = np()
    names = [v.get_name() for v in vars]
    probe = [n.array([0.37 + 0.11 * i, 0.61 + 0.07 * i]) for i in range(len(vars))]
    for cand in _candidates(expr, vars, ev, raw):
        try:
            c = PConv()
            s = c.to(cand)
            if isinstance(s, list):
                continue
            syms = [c.sym(nm) for nm in names]
            if _bad_sympy(s, syms):
                continue
        except ext_Deadline():
            raise
        except Exception:
            continue
        retry = c.cplx or s.has(sp.I)
        f = None
        try:
            f0 = _lambdify(c, syms, s)
            with n.errstate(all="ignore"):
                try:
                    f0(*probe)
                except TypeError:
                    f0(*[a.astype(complex) for a in probe])
            f = f0
        except ext_Deadline():
            raise
        except Exception:
            # special functions unknown to numpy: mpmath, element by element
            try:
                import mpmath

                fm = sp.lambdify(syms, s, modules=[{k_: (lambda *a, _g=g: _g(*[complex(v) if isinstance(v, mpmath.mpc)
                                                                               else float(v) for v in a]))
                                                    for k_, g in c.extra.items()}, "mpmath"])

                def one(*a):
                    try:
                        v = fm(*a)
                        return complex(v)
                    except Exception:
                        return complex("nan")
                f1 = n.vectorize(one, otypes=[complex])
                f1(*probe)
                f = f1
            except ext_Deadline():
                raise
            except Exception:
                f = None
        if f is None:
            continue

        def fn(*arrs, f=f, retry=retry):
            shape = n.broadcast(*arrs).shape
            arrs = [n.asarray(a, dtype=float) for a in arrs]
            with n.errstate(all="ignore"):
                try:
                    r = n.asarray(f(*arrs))
                except TypeError:
                    r = n.asarray(f(*[a.astype(complex) for a in arrs]))
                if r.dtype == object:
                    r = r.astype(complex)
                if r.shape != shape:
                    r = n.broadcast_to(r, shape).copy()
                if retry and not n.iscomplexobj(r) and n.isnan(r).any():
                    try:
                        r2 = n.asarray(f(*[a.astype(complex) for a in arrs]))
                        if r2.shape != shape:
                            r2 = n.broadcast_to(r2, shape)
                        r = n.where(n.isnan(r), r2, r)
                    except Exception:
                        pass
                if complex_out:
                    return n.asarray(r, dtype=complex)
                if n.iscomplexobj(r):
                    r = n.where(n.abs(r.imag) > 1e-9 * (1 + n.abs(r.real)), n.nan, r.real)
                r = n.asarray(r, dtype=float)
            return r

        fn.slow = False
        fn.cost = 0.0
        FN_STATS["fast"] += 1
        return fn
    FN_STATS["slow"] += 1

    def one_slow(vals):
        assign = L(*[E("Set", v, Real(float(a))) for v, a in zip(vars, vals)])
        return pyval(E("Block", assign, expr), ev)

    def slow(*arrs):
        shape = n.broadcast(*arrs).shape
        flat = [n.ravel(n.broadcast_to(n.asarray(a, dtype=float), shape)) for a in arrs]
        out = n.full(flat[0].shape, n.nan, dtype=complex if complex_out else float)
        for i in range(out.size):
            v = one_slow([a[i] for a in flat])
            if v is None:
                continue
            if complex_out:
                out[i] = v
            elif not isinstance(v, complex):
                out[i] = v
            elif abs(v.imag) < 1e-9 * (1 + abs(v.real)):
                out[i] = v.real
        return out.reshape(shape)

    import time as _t

    t0 = _t.time()
    try:
        one_slow([float(p_[0]) for p_ in probe])
    except ext_Deadline():
        raise
    except Exception:
        pass
    slow.slow = True
    slow.cost = max(1e-5, _t.time() - t0)
    return slow


def budget(fn, fast, slow_max, slow_min=24, seconds=1.2):
    """Number of samples for fn: `fast` if vectorised, otherwise limited by a time budget."""
    if not fn.slow:
        return fast
    return int(max(slow_min, min(slow_max, seconds / fn.cost)))


def make_cfn(expr, vars, ev):
    """Complex-valued sampler (used for functions of a complex variable)."""
    return make_fn(expr, vars, ev, complex_out=True)


def _wmin(*a):
    return sp.Function("WLXMin")(*a) if len(a) > 1 else a[0]


def _wmax(*a):
    return sp.Function("WLXMax")(*a) if len(a) > 1 else a[0]


def cond_to_field(s):
    """sympy boolean -> scalar field positive where the condition holds."""
    if isinstance(s, (sp.Lt, sp.Le)):
        return s.rhs - s.lhs
    if isinstance(s, (sp.Gt, sp.Ge)):
        return s.lhs - s.rhs
    if isinstance(s, sp.And):
        return _wmin(*[cond_to_field(a) for a in s.args])
    if isinstance(s, sp.Or):
        return _wmax(*[cond_to_field(a) for a in s.args])
    if isinstance(s, sp.Not):
        return -cond_to_field(s.args[0])
    if s is sp.true:
        return sp.Integer(1)
    if s is sp.false:
        return sp.Integer(-1)
    raise ConvError("cond")


def make_cond_fn(expr, vars, ev):
    """Scalar field > 0 where the condition holds (continuous when possible, so boundaries can be interpolated)."""
    n = np()
    names = [v.get_name() for v in vars]
    for attempt in (0, 1):
        try:
            c = PConv()
            s = cond_to_field(c.to(expr))
            syms = [c.sym(nm) for nm in names]
            if _bad_sympy(s, syms):
                raise ConvError("free")
            c.extra["WLXMin"] = lambda *a: _reduce(n.minimum, a)
            c.extra["WLXMax"] = lambda *a: _reduce(n.maximum, a)
            f = _lambdify(c, syms, s)

            def fn(*arrs, f=f):
                shape = n.broadcast(*arrs).shape
                with n.errstate(all="ignore"):
                    r = n.asarray(f(*[n.asarray(a, dtype=float) for a in arrs]))
                    if n.iscomplexobj(r):
                        r = n.where(n.abs(r.imag) > 1e-12, n.nan, r.real)
                    r = n.asarray(r, dtype=float)
                if r.shape != shape:
                    r = n.broadcast_to(r, shape).copy()
                return n.where(n.isfinite(r), r, -1.0)
            fn(*[n.array([0.3, 0.7]) for _ in vars])
            fn.slow = False
            FN_STATS["fast"] += 1
            return fn
        except ext_Deadline():
            raise
        except Exception:
            if attempt == 0:
                try:
                    e2 = hold_eval(expr, vars, ev)
                except ext_Deadline():
                    raise
                except Exception:
                    break
                if e2 is expr or (hasattr(e2, "sameQ") and e2.sameQ(expr)):
                    break
                expr = e2
    FN_STATS["slow"] += 1

    def slow(*arrs):
        shape = n.broadcast(*arrs).shape
        flat = [n.ravel(n.broadcast_to(n.asarray(a, dtype=float), shape)) for a in arrs]
        out = n.full(flat[0].shape, -1.0)
        for i in range(out.size):
            assign = L(*[E("Set", v, Real(float(a[i]))) for v, a in zip(vars, flat)])
            r = E("Block", assign, expr).evaluate(ev)
            out[i] = 1.0 if r is SymbolTrue else -1.0
        return out.reshape(shape)
    slow.slow = True
    return slow


def _reduce(op, args):
    r = args[0]
    for a in args[1:]:
        r = op(r, a)
    return r


def diff_expr(a, b):
    return E("Plus", a, E("Times", Integer(-1), b))


def num(e, ev, default=None):
    v = pyval(e, ev)
    if v is None or isinstance(v, complex):
        return default
    return v


def robust_range(ys):
    n = np()
    y = ys[n.isfinite(ys)]
    if y.size == 0:
        return [-1.0, 1.0]
    lo, hi = float(y.min()), float(y.max())
    if y.size > 20:
        q1, q3 = n.percentile(y, [10, 90])
        iqr = q3 - q1
        if iqr > 0 and (hi - lo) > 12 * iqr:
            lo2, hi2 = q1 - 2.2 * iqr, q3 + 2.2 * iqr
            lo, hi = max(lo, float(lo2)), min(hi, float(hi2))
    if hi - lo < 1e-12:
        d = abs(lo) * 0.1 or 1.0
        lo, hi = lo - d, hi + d
    pad = (hi - lo) * 0.04
    return [lo - pad, hi + pad]


def parse_range(pr, ev, dims=2):
    """PlotRange -> list of [lo,hi] or None per dimension, plus flag all."""
    res = [None] * dims
    allflag = False
    if pr is None:
        return res, allflag
    if isinstance(pr, Symbol):
        nm = short(pr)
        return res, nm in ("All", "Full")
    v = num(pr, ev)
    if v is not None:
        res[dims - 1] = [-v, v] if dims == 2 else [-v, v]
        return res, allflag
    if pr.has_form("List", 2) and not pr.elements[0].has_form("List", None) and \
            num(pr.elements[0], ev) is not None and num(pr.elements[1], ev) is not None:
        res[dims - 1] = [num(pr.elements[0], ev), num(pr.elements[1], ev)]
        return res, allflag
    if pr.has_form("List", None):
        for i, e in enumerate(pr.elements[:dims]):
            if e.has_form("List", 2):
                a, b = num(e.elements[0], ev), num(e.elements[1], ev)
                if a is not None and b is not None:
                    res[i] = [a, b]
            elif isinstance(e, Symbol) and short(e) in ("All", "Full"):
                allflag = True
            else:
                v = num(e, ev)
                if v is not None:
                    res[i] = [-v, v]
    return res, allflag


def gopts(options, defaults=None, exclude=()):
    """Collect Graphics-level option rules to store in the Graphics expression."""
    rules = []
    seen = set()
    for name in PASS_OPTS:
        if name in exclude:
            continue
        v = opt(options, name)
        if v is not None and not is_sym(v, "Automatic"):
            if name in ("Epilog", "Prolog") and v.has_form("List", 0):
                continue
            rules.append(Rule(S(name), v))
            seen.add(name)
    for name, v in (defaults or {}).items():
        if name not in seen:
            rules.append(Rule(S(name), v))
    return rules


def rng_expr(r):
    return L(*[L(Real(float(a)), Real(float(b))) for a, b in r])


def G2(prims, rules):
    pid = K.new_id({"kind": "g", "prims": prims})
    return E("Graphics", L(E(Symbol("WLX`G"), Integer(pid))), *rules)


def G3(prims, rules):
    pid = K.new_id({"kind": "g", "prims": prims})
    return E("Graphics3D", L(E(Symbol("WLX`G"), Integer(pid))), *rules)


def legend_prim(options, exprs, styles, ev):
    pl = opt(options, "PlotLegends")
    if pl is None or is_sym(pl, "None"):
        return None
    while isinstance(pl, Expression) and pl.get_head_name() in ("System`Placed", "System`LineLegend",
                                                                "System`SwatchLegend", "System`PointLegend"):
        pl = pl.elements[0]
    labels = []
    if isinstance(pl, String) and pl.value in ("Expressions", "AllExpressions"):
        labels = [label_text(e, ev) for e in exprs]
    elif isinstance(pl, Expression) and pl.has_form("List", None):
        labels = [label_text(e, ev) for e in pl.elements]
    else:
        labels = [str(i + 1) for i in range(len(exprs))]
    items = []
    for i, lab in enumerate(labels[:len(styles)]):
        items.append({"label": lab or "", "color": styles[i].get("color"), "dash": styles[i].get("dash")})
    return {"t": "legend", "items": items} if items else None


def held_list(f, vars, ev):
    """Evaluate plot body with vars blocked; return (list_of_exprs, was_list, originals)."""
    f = strip_wrappers(f)
    orig = None
    if isinstance(f, Expression) and f.has_form("List", None):
        orig = [strip_wrappers(x) for x in f.elements]
    he = hold_eval(f, vars, ev)
    he = strip_wrappers(he)
    if isinstance(he, Expression) and he.has_form("List", None):
        items = []
        for x in he.elements:
            x = strip_wrappers(x)
            if isinstance(x, Expression) and x.has_form("List", None):
                items.extend(strip_wrappers(y) for y in x.elements)
            else:
                items.append(x)
        if orig is None or len(orig) != len(items):
            orig = items
        return items, True, orig
    return [he], False, [orig[0] if orig else f]


def break_jumps(xs, ys, yr):
    """Insert NaN where the curve jumps across an asymptote."""
    n = np()
    ys = ys.copy()
    span = (yr[1] - yr[0]) or 1.0
    d = n.abs(n.diff(ys))
    big = n.where((d > 0.9 * span) | ~n.isfinite(d))[0]
    for i in big:
        if n.isfinite(ys[i]) and n.isfinite(ys[i + 1]) and (ys[i] > yr[1] or ys[i] < yr[0] or ys[i + 1] > yr[1]
                                                            or ys[i + 1] < yr[0] or ys[i] * ys[i + 1] < 0):
            ys[i + 1 if abs(ys[i + 1]) > abs(ys[i]) else i] = n.nan if d[i] > 3 * span else ys[i + 1 if abs(ys[i + 1]) > abs(ys[i]) else i]
            if d[i] > 3 * span:
                ys[i] = n.nan if abs(ys[i]) > abs(ys[i + 1]) else ys[i]
    return ys


class GB(XB):
    attributes = A_HOLD_ALL | A_PROTECTED
    options = GOPTS


# -------------------------------------------------------------------- Plot
class Plot(GB):
    def eval(self, f, x, a, b, evaluation, options):
        "Plot[f_, {x_Symbol, a_, b_}, OptionsPattern[Plot]]"
        return plot_curves(f, x, a, b, evaluation, options, mode="plot")


class LogPlot(GB):
    def eval(self, f, x, a, b, evaluation, options):
        "LogPlot[f_, {x_Symbol, a_, b_}, OptionsPattern[LogPlot]]"
        return plot_curves(E("Log", S("10"), f) if False else f, x, a, b, evaluation, options, mode="log")


def plot_curves(f, x, a, b, ev, options, mode="plot"):
    n = np()
    a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
    if a_v is None or b_v is None:
        return None
    exprs, was_list, orig = held_list(f, [x], ev)
    pp = num(opt(options, "PlotPoints"), ev)
    styles = styles_for(options, len(exprs), ev)
    prims = []
    allys = []
    curves = []
    for i, ex in enumerate(exprs):
        fn = make_fn(ex, [x], ev)
        npts = int(pp) if pp else (160 if fn.slow else 700)
        xs = n.linspace(a_v, b_v, npts)
        # avoid exact endpoint singularities
        eps = (b_v - a_v) * 1e-9
        xs[0] += eps
        xs[-1] -= eps
        ys = fn(xs)
        curves.append((xs, ys))
        allys.append(ys)
    cat = n.concatenate(allys) if allys else n.array([0.0])
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    if allflag:
        fin = cat[n.isfinite(cat)]
        yr = [float(fin.min()), float(fin.max())] if fin.size else [-1, 1]
        pad = (yr[1] - yr[0]) * 0.04 or 1
        yr = [yr[0] - pad, yr[1] + pad]
    else:
        yr = robust_range(cat)
    if pr[1] is not None:
        yr = pr[1]
    xr = pr[0] if pr[0] is not None else [a_v, b_v]
    fill = opt(options, "Filling")
    for i, (xs, ys) in enumerate(curves):
        ys2 = break_jumps(xs, ys, yr)
        st = styles[i]
        if fill is not None and not is_sym(fill, "None"):
            base = 0.0
            nm = short(fill) if isinstance(fill, Symbol) else None
            if nm == "Bottom":
                base = yr[0]
            elif nm == "Top":
                base = yr[1]
            elif num(fill, ev) is not None:
                base = num(fill, ev)
            other = None
            if isinstance(fill, Expression) and fill.has_form("List", None):
                for r in fill.elements:
                    if r.get_head_name() == "System`Rule" and num(r.elements[0], ev) == i + 1:
                        tgt = r.elements[1]
                        if tgt.has_form("List", 1):
                            j = int(num(tgt.elements[0], ev)) - 1
                            if 0 <= j < len(curves):
                                other = curves[j][1]
                        elif isinstance(tgt, Symbol) and short(tgt) == "Axis":
                            other = n.zeros_like(ys)
                if other is None:
                    other = False
            if other is not False:
                yb = other if other is not None else n.full_like(ys, base)
                prims.append({"t": "fill", "x": nlist(xs), "y": nlist(n.clip(ys, yr[0], yr[1])),
                              "y2": nlist(n.clip(yb, yr[0], yr[1])), "color": st["color"], "opacity": 0.2})
        p = {"t": "line", "x": nlist(xs), "y": nlist(ys2)}
        p.update(st)
        prims.append(p)
    leg = legend_prim(options, orig, styles, ev)
    if leg:
        prims.append(leg)
    defaults = {"AspectRatio": E("Power", S("GoldenRatio"), Integer(-1)), "Axes": SymbolTrue,
                "PlotRange": rng_expr([xr, yr])}
    if mode == "log":
        defaults["WLX`LogY"] = SymbolTrue
    rules = gopts(options, defaults)
    return G2(prims, rules)


# ---------------------------------------------------------------- ListPlot
def list_data(data, ev, options=None):
    """-> list of datasets, each (xs, ys)."""
    n = np()
    d = E("N", data).evaluate(ev)
    py = d.to_python()
    if not isinstance(py, (list, tuple)) or len(py) == 0:
        return []

    def is_num(v):
        return isinstance(v, (int, float))

    def one(ds):
        if all(is_num(v) for v in ds):
            x0, dx = 1.0, 1.0
            if options is not None:
                dr = opt(options, "DataRange")
                if dr is not None and dr.has_form("List", 2):
                    lo, hi = num(dr.elements[0], ev), num(dr.elements[1], ev)
                    if lo is not None and hi is not None and len(ds) > 1:
                        x0, dx = lo, (hi - lo) / (len(ds) - 1)
            return n.array([x0 + dx * i for i in range(len(ds))], dtype=float), n.array(ds, dtype=float)
        if all(isinstance(v, (list, tuple)) and len(v) == 2 and all(is_num(c) for c in v) for v in ds):
            arr = n.array(ds, dtype=float)
            return arr[:, 0], arr[:, 1]
        return None
    single = one(py)
    if single is not None:
        return [single]
    out = []
    for ds in py:
        if isinstance(ds, (list, tuple)):
            r = one(list(ds))
            if r is not None:
                out.append(r)
    return out


class ListPlot(GB):
    attributes = A_PROTECTED

    def eval(self, data, evaluation, options):
        "ListPlot[data_, OptionsPattern[ListPlot]]"
        joined = opt(options, "Joined") is SymbolTrue
        return list_plot(data, evaluation, options, joined)


class ListLinePlot(GB):
    attributes = A_PROTECTED

    def eval(self, data, evaluation, options):
        "ListLinePlot[data_, OptionsPattern[ListLinePlot]]"
        return list_plot(data, evaluation, options, True)


class DiscretePlot(GB):
    def eval(self, f, spec, evaluation, options):
        "DiscretePlot[f_, spec_List, OptionsPattern[DiscretePlot]]"
        tab = E("Table", L(spec.elements[0], f), spec).evaluate(evaluation)
        return list_plot(tab, evaluation, options, False, stems=True)


def list_plot(data, ev, options, joined, stems=False):
    n = np()
    sets = list_data(data, ev, options)
    if not sets:
        return None
    styles = styles_for(options, len(sets), ev)
    prims = []
    for i, (xs, ys) in enumerate(sets):
        st = dict(styles[i])
        if stems:
            for xv, yv in zip(xs.tolist(), ys.tolist()):
                prims.append({"t": "line", "x": [xv, xv], "y": [0, yv], "color": st["color"], "width": 1.2,
                              "opacity": 0.6})
        if joined:
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update(st)
            prims.append(p)
            if opt(options, "Mesh") is not None and short(opt(options, "Mesh")) in ("All", "Full"):
                prims.append({"t": "points", "x": nlist(xs), "y": nlist(ys), "color": st["color"], "psize": 4})
        else:
            p = {"t": "points", "x": nlist(xs), "y": nlist(ys), "psize": st.get("psize", 4.5)}
            p.update({k: v for k, v in st.items() if k != "width"})
            prims.append(p)
    allx = n.concatenate([s[0] for s in sets])
    ally = n.concatenate([s[1] for s in sets])
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    fx, fy = allx[n.isfinite(allx)], ally[n.isfinite(ally)]
    xr = [float(fx.min()), float(fx.max())] if fx.size else [0, 1]
    yr = [float(fy.min()), float(fy.max())] if fy.size else [0, 1]
    if not allflag:
        yr = robust_range(ally)
    else:
        pad = (yr[1] - yr[0]) * 0.05 or 1
        yr = [yr[0] - pad, yr[1] + pad]
    if yr[0] > 0 and yr[0] < 0.35 * yr[1]:
        yr[0] = 0.0
    padx = (xr[1] - xr[0]) * 0.03 or 0.5
    xr = [xr[0] - padx, xr[1] + padx]
    if pr[0] is not None:
        xr = pr[0]
    if pr[1] is not None:
        yr = pr[1]
    leg = legend_prim(options, [String("%d" % (i + 1)) for i in range(len(sets))], styles, ev)
    if leg:
        prims.append(leg)
    rules = gopts(options, {"AspectRatio": E("Power", S("GoldenRatio"), Integer(-1)), "Axes": SymbolTrue,
                            "PlotRange": rng_expr([xr, yr])})
    return G2(prims, rules)


# ---------------------------------------------------- Parametric / Polar
class ParametricPlot(GB):
    def eval(self, f, t, a, b, evaluation, options):
        "ParametricPlot[f_, {t_Symbol, a_, b_}, OptionsPattern[ParametricPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
        if a_v is None or b_v is None:
            return None
        he = strip_wrappers(hold_eval(strip_wrappers(f), [t], ev))
        if not (isinstance(he, Expression) and he.has_form("List", None)):
            return None
        curves = [he] if not he.elements[0].has_form("List", None) else list(he.elements)
        styles = styles_for(options, len(curves), ev)
        prims, allx, ally = [], [], []
        for i, cv in enumerate(curves):
            if not cv.has_form("List", 2):
                return None
            fx, fy = make_fn(cv.elements[0], [t], ev), make_fn(cv.elements[1], [t], ev)
            ts = n.linspace(a_v, b_v, 140 if (fx.slow or fy.slow) else 800)
            xs, ys = fx(ts), fy(ts)
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update(styles[i])
            prims.append(p)
            allx.append(xs)
            ally.append(ys)
        return finish_xy(prims, allx, ally, options, ev, curves, styles)

    def eval_region(self, f, u, a, b, v, c, d, evaluation, options):
        "ParametricPlot[f_, {u_Symbol, a_, b_}, {v_Symbol, c_, d_}, OptionsPattern[ParametricPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = strip_wrappers(hold_eval(strip_wrappers(f), [u, v], ev))
        if not he.has_form("List", 2):
            return None
        fx, fy = make_fn(he.elements[0], [u, v], ev), make_fn(he.elements[1], [u, v], ev)
        m = 12 if (fx.slow or fy.slow) else 30
        st = styles_for(options, 1, ev)[0]
        prims, allx, ally = [], [], []
        us, vs = n.linspace(a_v, b_v, m), n.linspace(c_v, d_v, m)
        U, V = n.meshgrid(us, vs)
        X, Y = fx(U, V), fy(U, V)
        for i in range(m - 1):
            for j in range(m - 1):
                px = [X[i, j], X[i, j + 1], X[i + 1, j + 1], X[i + 1, j]]
                py = [Y[i, j], Y[i, j + 1], Y[i + 1, j + 1], Y[i + 1, j]]
                if all(n.isfinite(px)) and all(n.isfinite(py)):
                    prims.append({"t": "poly", "x": nlist(px), "y": nlist(py), "color": st["color"], "opacity": 0.35,
                                  "edge": None})
        for k in range(0, m, max(1, m // 10)):
            prims.append({"t": "line", "x": nlist(X[k, :]), "y": nlist(Y[k, :]), "color": st["color"], "width": 0.8})
            prims.append({"t": "line", "x": nlist(X[:, k]), "y": nlist(Y[:, k]), "color": st["color"], "width": 0.8})
        allx.append(X.ravel())
        ally.append(Y.ravel())
        return finish_xy(prims, allx, ally, options, ev, [he], [st])


def finish_xy(prims, allx, ally, options, ev, exprs, styles, aspect="Automatic", extra=None):
    n = np()
    X, Y = n.concatenate(allx), n.concatenate(ally)
    fx, fy = X[n.isfinite(X)], Y[n.isfinite(Y)]
    xr = [float(fx.min()), float(fx.max())] if fx.size else [-1, 1]
    yr = [float(fy.min()), float(fy.max())] if fy.size else [-1, 1]
    for r in (xr, yr):
        pad = (r[1] - r[0]) * 0.04
        if pad == 0:
            pad = abs(r[0]) * 0.1 or 1.0
        r[0] -= pad
        r[1] += pad
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    if pr[0] is not None:
        xr = pr[0]
    if pr[1] is not None:
        yr = pr[1]
    leg = legend_prim(options, exprs, styles, ev)
    if leg:
        prims.append(leg)
    defaults = {"AspectRatio": S(aspect), "Axes": SymbolTrue, "PlotRange": rng_expr([xr, yr])}
    defaults.update(extra or {})
    return G2(prims, gopts(options, defaults))


class PolarPlot(GB):
    def eval(self, f, t, a, b, evaluation, options):
        "PolarPlot[f_, {t_Symbol, a_, b_}, OptionsPattern[PolarPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
        exprs, was_list, orig = held_list(f, [t], ev)
        styles = styles_for(options, len(exprs), ev)
        prims, allx, ally = [], [], []
        for i, ex in enumerate(exprs):
            fn = make_fn(ex, [t], ev)
            ts = n.linspace(a_v, b_v, 150 if fn.slow else 900)
            r = fn(ts)
            xs, ys = r * n.cos(ts), r * n.sin(ts)
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update(styles[i])
            prims.append(p)
            allx.append(xs)
            ally.append(ys)
        return finish_xy(prims, allx, ally, options, ev, orig, styles)


# ------------------------------------------- Contour / Density / Region
def grid_xy(a, b, c, d, m):
    n = np()
    xs, ys = n.linspace(a, b, m), n.linspace(c, d, m)
    X, Y = n.meshgrid(xs, ys)
    return X, Y


def field_prim(Z, a, b, c, d, **kw):
    p = {"t": "field", "x0": a, "x1": b, "y0": c, "y1": d, "nx": int(Z.shape[1]), "ny": int(Z.shape[0]),
         "data": nlist(Z, 4)}
    p.update(kw)
    return p


class ContourPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "ContourPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[ContourPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        exprs, was_list, orig = held_list(f, [x, y], ev)
        prims = []
        implicit = [e for e in exprs if isinstance(e, Expression) and e.get_head_name() == "System`Equal"]
        if implicit:
            styles = styles_for(options, len(exprs), ev, "ContourStyle")
            if opt(options, "ContourStyle") is None or is_sym(opt(options, "ContourStyle"), "Automatic"):
                styles = styles_for(options, len(exprs), ev, "PlotStyle")
            for i, e in enumerate(exprs):
                if e.get_head_name() != "System`Equal":
                    continue
                g = diff_expr(e.elements[0], e.elements[1])
                fn = make_fn(g, [x, y], ev)
                m = 26 if fn.slow else 121
                X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
                st = styles[i]
                prims.append(field_prim(fn(X, Y), a_v, b_v, c_v, d_v, mode="implicit", color=st["color"],
                                        width=st.get("width", 1.6), dash=st.get("dash")))
            leg = legend_prim(options, orig, styles, ev)
            if leg:
                prims.append(leg)
        else:
            fn = make_fn(exprs[0], [x, y], ev)
            m = 24 if fn.slow else 81
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            Z = fn(X, Y)
            cont = opt(options, "Contours")
            levels = None
            nlev = 10
            if cont is not None and not is_sym(cont, "Automatic"):
                cv = cont.evaluate(ev)
                if cv.has_form("List", None):
                    levels = [num(v, ev) for v in cv.elements if num(v, ev) is not None]
                elif num(cv, ev) is not None:
                    nlev = int(num(cv, ev))
            sh = opt(options, "ContourShading")
            shading = not (sh is not None and (sh is SymbolFalse or is_sym(sh, "None")))
            prims.append(field_prim(Z, a_v, b_v, c_v, d_v, mode="contour", levels=levels, nlev=nlev,
                                    shading=shading, cf=cf_name(options)))
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


def cf_name(options):
    cf = opt(options, "ColorFunction")
    if isinstance(cf, String):
        return cf.value
    return None


class DensityPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "DensityPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[DensityPlot]]"
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = hold_eval(strip_wrappers(f), [x, y], ev)
        fn = make_fn(he, [x, y], ev)
        m = 24 if fn.slow else 90
        X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
        prims = [field_prim(fn(X, Y), a_v, b_v, c_v, d_v, mode="density", cf=cf_name(options))]
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


class RegionPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "RegionPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[RegionPlot]]"
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        exprs, was_list, orig = held_list(f, [x, y], ev)
        styles = styles_for(options, len(exprs), ev)
        prims = []
        for i, e in enumerate(exprs):
            fn = make_cond_fn(e, [x, y], ev)
            m = 28 if fn.slow else 141
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            prims.append(field_prim(fn(X, Y), a_v, b_v, c_v, d_v, mode="region", color=styles[i]["color"],
                                    opacity=styles[i].get("opacity", 0.45)))
        leg = legend_prim(options, orig, styles, ev)
        if leg:
            prims.append(leg)
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


# ----------------------------------------------------- Vector / Stream
class VectorPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "VectorPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[VectorPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = hold_eval(strip_wrappers(f), [x, y], ev)
        if not he.has_form("List", 2):
            return None
        fu, fv = make_fn(he.elements[0], [x, y], ev), make_fn(he.elements[1], [x, y], ev)
        vp = num(opt(options, "VectorPoints"), ev)
        m = int(vp) if vp else 15
        m = max(4, min(m, 30))
        xs = n.linspace(a_v, b_v, m + 2)[1:-1]
        ys = n.linspace(c_v, d_v, m + 2)[1:-1]
        X, Y = n.meshgrid(xs, ys)
        U, V = fu(X, Y), fv(X, Y)
        mag = n.sqrt(U ** 2 + V ** 2)
        mx = float(n.nanmax(mag)) if n.isfinite(mag).any() else 1.0
        mx = mx or 1.0
        vs = opt(options, "VectorScale")
        uniform = vs is not None and vs.has_form("List", 3) and is_sym(vs.elements[2], "None")
        cell = min((b_v - a_v), (d_v - c_v) * 1.0) / (m + 1)
        sx, sy = (b_v - a_v) / (m + 1), (d_v - c_v) / (m + 1)
        segs, mags = [], []
        for i in range(m):
            for j in range(m):
                u, v, g = U[i, j], V[i, j], mag[i, j]
                if not (n.isfinite(u) and n.isfinite(v)) or g == 0:
                    continue
                k = 0.85 if uniform else (0.35 + 0.65 * g / mx)
                # normalise in screen-like units (per-axis cell size)
                ux, vy = u / g, v / g
                nrm = math.hypot(ux / sx, vy / sy) or 1.0
                dx, dy = ux / nrm * k * 0.5, vy / nrm * k * 0.5
                segs.append([float(X[i, j] - dx), float(Y[i, j] - dy), float(X[i, j] + dx), float(Y[i, j] + dy)])
                mags.append(float(g / mx))
        st = {}
        s_opt = opt(options, "VectorStyle")
        if s_opt is not None and not is_sym(s_opt, "Automatic"):
            apply_directive(st, s_opt.evaluate(ev), ev)
        prims = [{"t": "arrows", "segs": [[float("%.5g" % v) for v in s] for s in segs],
                  "mags": [float("%.3g" % v) for v in mags], "color": st.get("color")}]
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


class StreamPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "StreamPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[StreamPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = hold_eval(strip_wrappers(f), [x, y], ev)
        if not he.has_form("List", 2):
            return None
        fu, fv = make_fn(he.elements[0], [x, y], ev), make_fn(he.elements[1], [x, y], ev)
        m = 6 if (fu.slow or fv.slow) else 11
        xs = n.linspace(a_v, b_v, m + 2)[1:-1]
        ys = n.linspace(c_v, d_v, m + 2)[1:-1]
        X0, Y0 = n.meshgrid(xs, ys)
        steps = 30 if (fu.slow or fv.slow) else 90
        L0 = max(b_v - a_v, d_v - c_v)
        h = L0 / 160.0
        sx, sy = (b_v - a_v), (d_v - c_v)

        def direction(X, Y):
            U, V = fu(X, Y), fv(X, Y)
            g = n.sqrt((U / sx) ** 2 + (V / sy) ** 2)
            g = n.where(g == 0, n.nan, g)
            return U / g / sx * sx * (1.0 / L0) * L0 / 1.0 * 0 + U / g, V / g

        prims = []
        col = PALETTE[0]
        st = {}
        s_opt = opt(options, "StreamStyle")
        if s_opt is not None and not is_sym(s_opt, "Automatic"):
            apply_directive(st, s_opt.evaluate(ev), ev)
        lines = []
        for sgn in (1.0, -1.0):
            X, Y = X0.ravel().copy(), Y0.ravel().copy()
            trail_x, trail_y = [X.copy()], [Y.copy()]
            for _ in range(steps):
                k1x, k1y = direction(X, Y)
                k2x, k2y = direction(X + sgn * h / 2 * k1x * sx / L0, Y + sgn * h / 2 * k1y * sy / L0)
                X = X + sgn * h * k2x * sx / L0
                Y = Y + sgn * h * k2y * sy / L0
                out = (X < a_v) | (X > b_v) | (Y < c_v) | (Y > d_v)
                X = n.where(out, n.nan, X)
                Y = n.where(out, n.nan, Y)
                trail_x.append(X.copy())
                trail_y.append(Y.copy())
            TX, TY = n.array(trail_x), n.array(trail_y)
            if sgn < 0:
                TX, TY = TX[::-1], TY[::-1]
            lines.append((TX, TY))
        (FX, FY), (BX, BY) = lines
        for k in range(FX.shape[1]):
            lx = n.concatenate([BX[:, k], FX[1:, k]])
            ly = n.concatenate([BY[:, k], FY[1:, k]])
            prims.append({"t": "line", "x": nlist(lx, 4), "y": nlist(ly, 4), "color": st.get("color", col),
                          "width": 1.1, "arrow": "mid", "opacity": 0.9})
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


# ---------------------------------------------------------------------- 3D
def surf_prim(X, Y, Z, st=None, idx=0, mesh=True):
    p = {"t": "surf", "nx": int(X.shape[1]), "ny": int(X.shape[0]), "x": nlist(X, 4), "y": nlist(Y, 4),
         "z": nlist(Z, 4), "mesh": mesh, "ci": idx}
    if st:
        if st.get("explicit"):
            p["color"] = st.get("color")
        if "opacity" in st:
            p["opacity"] = st["opacity"]
    return p


def styles3(options, k, ev):
    ps = opt(options, "PlotStyle")
    base = [{"color": None} for _ in range(k)]
    if ps is None or is_sym(ps, "Automatic") or is_sym(ps, "None"):
        return base
    ps = ps.evaluate(ev)
    items = list(ps.elements) if ps.has_form("List", None) and k > 1 else [ps]
    for i in range(k):
        st = {}
        apply_directive(st, items[i % len(items)], ev)
        if "color" in st:
            st["explicit"] = True
        base[i] = st
    return base


def range3(vals, pr):
    n = np()
    v = vals[n.isfinite(vals)]
    if pr is not None:
        return pr
    if v.size == 0:
        return [-1.0, 1.0]
    r = robust_range(v)
    return r


def mesh_flag(options):
    m = opt(options, "Mesh")
    return not (m is not None and (is_sym(m, "None") or m is SymbolFalse))


def rules3(options, defaults):
    return gopts(options, defaults)


class Plot3D(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "Plot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[Plot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        exprs, was_list, orig = held_list(f, [x, y], ev)
        sts = styles3(options, len(exprs), ev)
        prims, allz = [], []
        rf = opt(options, "RegionFunction")
        for i, e in enumerate(exprs):
            fn = make_fn(e, [x, y], ev)
            pp = num(opt(options, "PlotPoints"), ev)
            m = int(pp) if pp else (16 if fn.slow else 46)
            m = max(6, min(m, 80))
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            Z = fn(X, Y)
            if rf is not None and not is_sym(rf, "Automatic"):
                try:
                    mask = region_mask(rf, X, Y, Z, ev)
                    Z = n.where(mask, Z, n.nan)
                except Exception:
                    pass
            prims.append(surf_prim(X, Y, Z, sts[i], i, mesh_flag(options)))
            allz.append(Z.ravel())
        pr, allflag = parse_range(opt(options, "PlotRange"), ev, 3)
        cat = n.concatenate(allz)
        if allflag:
            fin = cat[n.isfinite(cat)]
            zr = [float(fin.min()), float(fin.max())] if fin.size else [-1, 1]
        else:
            zr = range3(cat, pr[2])
        defaults = {"PlotRange": rng_expr([pr[0] or [a_v, b_v], pr[1] or [c_v, d_v], zr]),
                    "BoxRatios": L(Integer(1), Integer(1), Real(0.4)), "Axes": SymbolTrue}
        return G3(prims, rules3(options, defaults))


def region_mask(rf, X, Y, Z, ev):
    n = np()
    xs, ys, zs = Symbol("WLX`rx"), Symbol("WLX`ry"), Symbol("WLX`rz")
    body = E(rf, xs, ys, zs).evaluate(ev)
    fn = make_cond_fn(body, [xs, ys, zs], ev)
    return fn(X, Y, n.where(n.isfinite(Z), Z, 0.0)) > 0


class ParametricPlot3D(GB):
    def eval_curve(self, f, t, a, b, evaluation, options):
        "ParametricPlot3D[f_, {t_Symbol, a_, b_}, OptionsPattern[ParametricPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
        he = strip_wrappers(hold_eval(strip_wrappers(f), [t], ev))
        if not he.has_form("List", None):
            return None
        curves = [he] if not he.elements[0].has_form("List", None) else list(he.elements)
        sts = styles_for(options, len(curves), ev)
        prims, pts = [], []
        for i, cv in enumerate(curves):
            if not cv.has_form("List", 3):
                return None
            fs = [make_fn(c, [t], ev) for c in cv.elements]
            ts = n.linspace(a_v, b_v, 120 if any(f_.slow for f_ in fs) else 500)
            P = [fn(ts) for fn in fs]
            prims.append({"t": "line3", "x": nlist(P[0], 4), "y": nlist(P[1], 4), "z": nlist(P[2], 4),
                          "color": sts[i]["color"], "width": sts[i].get("width", 2)})
            pts.append(n.array(P))
        return finish3(prims, pts, options, ev)

    def eval_surface(self, f, u, a, b, v, c, d, evaluation, options):
        "ParametricPlot3D[f_, {u_Symbol, a_, b_}, {v_Symbol, c_, d_}, OptionsPattern[ParametricPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = strip_wrappers(hold_eval(strip_wrappers(f), [u, v], ev))
        if not he.has_form("List", None):
            return None
        surfs = [he] if not he.elements[0].has_form("List", None) else list(he.elements)
        sts = styles3(options, len(surfs), ev)
        prims, pts = [], []
        for i, sf in enumerate(surfs):
            if not sf.has_form("List", 3):
                return None
            fs = [make_fn(c2, [u, v], ev) for c2 in sf.elements]
            m = 14 if any(f_.slow for f_ in fs) else 40
            U, V = grid_xy(a_v, b_v, c_v, d_v, m)
            P = [fn(U, V) for fn in fs]
            prims.append(surf_prim(P[0], P[1], P[2], sts[i], i, mesh_flag(options)))
            pts.append(n.array([p.ravel() for p in P]))
        return finish3(prims, pts, options, ev)


def finish3(prims, pts, options, ev, box=None, extra=None):
    n = np()
    P = n.concatenate(pts, axis=1) if pts else n.zeros((3, 1))
    pr, allflag = parse_range(opt(options, "PlotRange"), ev, 3)
    rng = []
    for i in range(3):
        if pr[i] is not None:
            rng.append(pr[i])
            continue
        v = P[i][n.isfinite(P[i])]
        lo, hi = (float(v.min()), float(v.max())) if v.size else (-1.0, 1.0)
        if hi - lo < 1e-12:
            lo, hi = lo - 1, hi + 1
        rng.append([lo, hi])
    defaults = {"PlotRange": rng_expr(rng), "Axes": SymbolTrue,
                "BoxRatios": box if box is not None else S("Automatic")}
    defaults.update(extra or {})
    return G3(prims, rules3(options, defaults))


def iso_prim(F, r, color=None, ci=0, opacity=None):
    p = {"t": "iso", "n": int(F.shape[0]), "r": [[float(a), float(b)] for a, b in r], "data": nlist(F, 3), "ci": ci}
    if color:
        p["color"] = color
    if opacity is not None:
        p["opacity"] = opacity
    return p


def grid3(r, m):
    n = np()
    ax = [n.linspace(lo, hi, m) for lo, hi in r]
    # index order [iz, iy, ix]
    Z, Y, X = n.meshgrid(ax[2], ax[1], ax[0], indexing="ij")
    return X, Y, Z


class ContourPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "ContourPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[ContourPlot3D]]"
        n = np()
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        exprs, was_list, orig = held_list(f, [x, y, z], ev)
        sts = styles3(options, len(exprs), ev)
        cs = opt(options, "ContourStyle")
        if cs is not None and not is_sym(cs, "Automatic"):
            sts = []
            for i in range(len(exprs)):
                st = {}
                csv = cs.evaluate(ev)
                item = csv.elements[i % len(csv.elements)] if csv.has_form("List", None) and len(exprs) > 1 else csv
                apply_directive(st, item, ev)
                st["explicit"] = "color" in st
                sts.append(st)
        prims = []
        for i, ex in enumerate(exprs):
            levels = [0.0]
            if ex.get_head_name() == "System`Equal":
                ex = diff_expr(ex.elements[0], ex.elements[1])
            else:
                cont = opt(options, "Contours")
                if cont is not None and not is_sym(cont, "Automatic"):
                    cv = cont.evaluate(ev)
                    if cv.has_form("List", None):
                        levels = [num(v, ev) for v in cv.elements]
            fn = make_fn(ex, [x, y, z], ev)
            m = 9 if fn.slow else 30
            X, Y, Z = grid3(r, m)
            F = fn(X, Y, Z)
            for lv in levels:
                prims.append(iso_prim(F - lv, r, sts[i].get("color") if sts[i].get("explicit") else None, i,
                                      sts[i].get("opacity")))
        defaults = {"PlotRange": rng_expr(r), "Axes": SymbolTrue, "BoxRatios": L(Integer(1), Integer(1), Integer(1))}
        return G3(prims, rules3(options, defaults))


class RegionPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "RegionPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[RegionPlot3D]]"
        n = np()
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        exprs, was_list, orig = held_list(f, [x, y, z], ev)
        sts = styles3(options, len(exprs), ev)
        prims = []
        for i, ex in enumerate(exprs):
            fn = make_cond_fn(ex, [x, y, z], ev)
            m = 10 if fn.slow else 34
            X, Y, Z = grid3(r, m)
            F = fn(X, Y, Z)
            # close the solid at the box faces
            F2 = n.full((m + 2, m + 2, m + 2), -1.0)
            scale = float(n.nanmax(n.abs(F))) or 1.0
            F2[1:-1, 1:-1, 1:-1] = F
            F2[0], F2[-1] = -scale * 0 - n.abs(F2[1]) * 0 - 1e-6 * scale - n.maximum(F2[1], 0) * 0, F2[-1]
            F2[0, :, :] = -n.maximum(F2[1, :, :], 0) - 1e-9
            F2[-1, :, :] = -n.maximum(F2[-2, :, :], 0) - 1e-9
            F2[:, 0, :] = -n.maximum(F2[:, 1, :], 0) - 1e-9
            F2[:, -1, :] = -n.maximum(F2[:, -2, :], 0) - 1e-9
            F2[:, :, 0] = -n.maximum(F2[:, :, 1], 0) - 1e-9
            F2[:, :, -1] = -n.maximum(F2[:, :, -2], 0) - 1e-9
            h = [(hi - lo) / (m - 1) for lo, hi in r]
            r2 = [[lo - hh * 0.02, hi + hh * 0.02] for (lo, hi), hh in zip(r, h)]
            # grid of m+2 samples: outer layer sits just outside the box
            prims.append({"t": "iso", "n": m + 2, "r": [[float(a_), float(b_)] for a_, b_ in r2], "pad": True,
                          "inner": [[float(a_), float(b_)] for a_, b_ in r], "data": nlist(F2, 3), "ci": i,
                          "color": sts[i].get("color") if sts[i].get("explicit") else None,
                          "opacity": sts[i].get("opacity")})
        defaults = {"PlotRange": rng_expr(r), "Axes": SymbolTrue, "BoxRatios": L(Integer(1), Integer(1), Integer(1))}
        return G3(prims, rules3(options, defaults))


class RevolutionPlot3D(GB):
    def eval(self, f, t, a, b, evaluation, options):
        "RevolutionPlot3D[f_, {t_Symbol, a_, b_}, OptionsPattern[RevolutionPlot3D]]"
        return self._go(f, t, a, b, Real(0.0), E("Times", Integer(2), S("Pi")), evaluation, options)

    def eval_theta(self, f, t, a, b, th, c, d, evaluation, options):
        "RevolutionPlot3D[f_, {t_Symbol, a_, b_}, {th_Symbol, c_, d_}, OptionsPattern[RevolutionPlot3D]]"
        return self._go(f, t, a, b, c, d, evaluation, options)

    def _go(self, f, t, a, b, c, d, ev, options):
        n = np()
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = strip_wrappers(hold_eval(strip_wrappers(f), [t], ev))
        if he.has_form("List", 2):
            fr, fz = make_fn(he.elements[0], [t], ev), make_fn(he.elements[1], [t], ev)
        else:
            fr, fz = (lambda tt: tt), make_fn(he, [t], ev)
        m = 44
        T, TH = grid_xy(a_v, b_v, c_v, d_v, m)
        R, Zv = fr(T), fz(T)
        X, Y = R * n.cos(TH), R * n.sin(TH)
        st = styles3(options, 1, ev)[0]
        return finish3([surf_prim(X, Y, Zv, st, 0, mesh_flag(options))], [n.array([X.ravel(), Y.ravel(), Zv.ravel()])],
                       options, ev)


class SphericalPlot3D(GB):
    def eval(self, f, th, a, b, ph, c, d, evaluation, options):
        "SphericalPlot3D[f_, {th_Symbol, a_, b_}, {ph_Symbol, c_, d_}, OptionsPattern[SphericalPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        he = hold_eval(strip_wrappers(f), [th, ph], ev)
        fn = make_fn(he, [th, ph], ev)
        m = 14 if fn.slow else 44
        TH, PH = grid_xy(a_v, b_v, c_v, d_v, m)
        R = fn(TH, PH)
        X, Y, Zv = R * n.sin(TH) * n.cos(PH), R * n.sin(TH) * n.sin(PH), R * n.cos(TH)
        st = styles3(options, 1, ev)[0]
        return finish3([surf_prim(X, Y, Zv, st, 0, mesh_flag(options))], [n.array([X.ravel(), Y.ravel(), Zv.ravel()])],
                       options, ev)


class ListPointPlot3D(GB):
    attributes = A_PROTECTED

    def eval(self, data, evaluation, options):
        "ListPointPlot3D[data_, OptionsPattern[ListPointPlot3D]]"
        n = np()
        py = E("N", data).evaluate(evaluation).to_python()
        try:
            arr = n.array(py, dtype=float)
            if arr.ndim != 2 or arr.shape[1] != 3:
                return None
        except Exception:
            return None
        st = styles_for(options, 1, evaluation)[0]
        prims = [{"t": "pts3", "x": nlist(arr[:, 0]), "y": nlist(arr[:, 1]), "z": nlist(arr[:, 2]),
                  "color": st["color"], "psize": st.get("psize", 4)}]
        return finish3(prims, [arr.T], options, evaluation)


class ListPlot3D(GB):
    attributes = A_PROTECTED

    def eval(self, data, evaluation, options):
        "ListPlot3D[data_, OptionsPattern[ListPlot3D]]"
        n = np()
        py = E("N", data).evaluate(evaluation).to_python()
        try:
            arr = n.array(py, dtype=float)
            if arr.ndim != 2 or arr.shape[1] == 3 and arr.shape[0] != 3:
                return None
        except Exception:
            return None
        ny, nx = arr.shape
        X, Y = n.meshgrid(n.arange(1, nx + 1, dtype=float), n.arange(1, ny + 1, dtype=float))
        return finish3([surf_prim(X, Y, arr, None, 0, True)], [n.array([X.ravel(), Y.ravel(), arr.ravel()])], options,
                       evaluation, box=L(Integer(1), Integer(1), Real(0.4)))


class VectorPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "VectorPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[VectorPlot3D]]"
        n = np()
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        he = hold_eval(strip_wrappers(f), [x, y, z], ev)
        if not he.has_form("List", 3):
            return None
        fs = [make_fn(c2, [x, y, z], ev) for c2 in he.elements]
        m = 6
        ax = [n.linspace(lo, hi, m + 2)[1:-1] for lo, hi in r]
        X, Y, Z = n.meshgrid(*ax, indexing="ij")
        U, V, W = [fn(X, Y, Z) for fn in fs]
        mag = n.sqrt(U ** 2 + V ** 2 + W ** 2)
        mx = float(n.nanmax(mag)) or 1.0
        cell = min(hi - lo for lo, hi in r) / (m + 1)
        prims = []
        for idx in n.ndindex(X.shape):
            g_ = mag[idx]
            if not n.isfinite(g_) or g_ == 0:
                continue
            k = cell * (0.3 + 0.6 * g_ / mx) / g_
            p0 = [X[idx], Y[idx], Z[idx]]
            p1 = [X[idx] + U[idx] * k, Y[idx] + V[idx] * k, Z[idx] + W[idx] * k]
            prims.append({"t": "arrow3", "x": nlist([p0[0], p1[0]], 4), "y": nlist([p0[1], p1[1]], 4),
                          "z": nlist([p0[2], p1[2]], 4), "color": PALETTE[0], "width": 1.3})
        defaults = {"PlotRange": rng_expr(r), "Axes": SymbolTrue, "BoxRatios": L(Integer(1), Integer(1), Integer(1))}
        return G3(prims, rules3(options, defaults))


# ------------------------------------------------------------- Show & co.
class Show(XB):
    attributes = A_PROTECTED
    options = GOPTS

    def eval(self, gs, evaluation, options):
        "Show[gs__, OptionsPattern[Show]]"
        items = []
        for g in gs.get_sequence():
            if g.has_form("List", None):
                items.extend(g.elements)
            else:
                items.append(g)
        items = [unwrap_legended(i) for i in items]
        items = [i for i in items if i.get_head_name() in ("System`Graphics", "System`Graphics3D")]
        if not items:
            return None
        head = items[0].get_head()
        prims, seen, rules = [], set(), []
        given = {}
        for k, v in options.items():
            nm = k.split("`")[-1]
            if nm in GOPTS and GOPTS[nm] == str(v).split("`")[-1]:
                continue  # default value, i.e. not explicitly given
            given[nm] = v
        for nm, v in given.items():
            rules.append(Rule(S(nm), v))
            seen.add(nm)
        for it in items:
            if it.elements:
                prims.append(it.elements[0])
        for it in items:
            for r in it.elements[1:]:
                if r.get_head_name() in ("System`Rule", "System`RuleDelayed"):
                    nm = r.elements[0].get_name()
                    if nm not in seen and nm.split("`")[-1] not in seen:
                        if nm.split("`")[-1] in ("Epilog", "Prolog"):
                            rules.append(r)
                            continue
                        seen.add(nm)
                        rules.append(r)
        return Expression(head, L(*prims), *rules)


def unwrap_legended(e):
    while isinstance(e, Expression) and e.get_head_name() in ("System`Legended", "System`Labeled", "System`Magnify",
                                                              "System`Framed", "System`Style", "System`Rasterize"):
        e = e.elements[0]
    return e


# ---------------------------------------------- Graphics -> JSON conversion
def opt_dict(g):
    d = {}
    for r in g.elements[1:]:
        if r.get_head_name() in ("System`Rule", "System`RuleDelayed"):
            nm = r.elements[0].get_name().split("`")[-1]
            if nm not in d:
                d[nm] = r.elements[1]
        elif r.has_form("List", None):
            for r2 in r.elements:
                if r2.get_head_name() == "System`Rule":
                    nm = r2.elements[0].get_name().split("`")[-1]
                    d.setdefault(nm, r2.elements[1])
    return d


def coords(e, ev, dim=2):
    try:
        v = E("N", e).evaluate(ev).to_python()
    except Exception:
        return None
    return v


def walk2(e, st, out, ev):
    """Convert 2D primitives to JSON prims."""
    if isinstance(e, Expression) and e.has_form("List", None):
        local = dict(st)
        for x in e.elements:
            if not apply_directive(local, x, ev):
                walk2(x, local, out, ev)
        return
    if not isinstance(e, Expression):
        return
    hn = e.get_head_name()
    el = e.elements
    name = hn.split("`")[-1]
    col = st.get("color", "#000000")
    base = {"color": col}
    for k in ("opacity", "dash"):
        if k in st:
            base[k] = st[k]
    if hn == "WLX`G":
        p = K.registry.get(el[0].value)
        if p:
            out.extend(p["prims"])
        return
    if name in ("Graphics",):
        if el:
            walk2(el[0], st, out, ev)
        return
    if name == "Point":
        v = coords(el[0], ev)
        if v is None:
            return
        pts = [v] if v and not isinstance(v[0], (list, tuple)) else v
        p = {"t": "points", "x": [q[0] for q in pts], "y": [q[1] for q in pts], "psize": st.get("psize", 4.5)}
        p.update(base)
        out.append(p)
    elif name in ("Line", "Arrow", "BezierCurve", "BSplineCurve"):
        v = coords(el[0], ev)
        if v is None:
            return
        lines = v if v and v[0] and isinstance(v[0][0], (list, tuple)) else [v]
        for ln in lines:
            p = {"t": "line", "x": [q[0] for q in ln], "y": [q[1] for q in ln], "width": st.get("width", 1.4)}
            p.update(base)
            if name == "Arrow":
                p["arrow"] = "end"
            out.append(p)
    elif name in ("Polygon", "Triangle"):
        v = coords(el[0], ev)
        if v is None:
            return
        polys = v if v and v[0] and isinstance(v[0][0], (list, tuple)) else [v]
        for pg in polys:
            p = {"t": "poly", "x": [q[0] for q in pg], "y": [q[1] for q in pg]}
            p.update(base)
            _edge(p, st)
            out.append(p)
    elif name == "Rectangle":
        a = coords(el[0], ev) if el else [0, 0]
        b = coords(el[1], ev) if len(el) > 1 else [a[0] + 1, a[1] + 1]
        p = {"t": "poly", "x": [a[0], b[0], b[0], a[0]], "y": [a[1], a[1], b[1], b[1]]}
        p.update(base)
        _edge(p, st)
        out.append(p)
    elif name in ("Circle", "Disk"):
        c = coords(el[0], ev) if el else [0, 0]
        r = coords(el[1], ev) if len(el) > 1 else 1
        rx, ry = (r if isinstance(r, (list, tuple)) else (r, r))
        t0, t1 = 0, 2 * math.pi
        if len(el) > 2:
            ang = coords(el[2], ev)
            t0, t1 = ang[0], ang[1]
        k = 96
        xs = [c[0] + rx * math.cos(t0 + (t1 - t0) * i / k) for i in range(k + 1)]
        ys = [c[1] + ry * math.sin(t0 + (t1 - t0) * i / k) for i in range(k + 1)]
        if name == "Disk":
            if len(el) > 2:
                xs.append(c[0])
                ys.append(c[1])
            p = {"t": "poly", "x": xs, "y": ys}
            p.update(base)
            _edge(p, st)
        else:
            p = {"t": "line", "x": xs, "y": ys, "width": st.get("width", 1.4)}
            p.update(base)
        out.append(p)
    elif name == "Text":
        pos = coords(el[1], ev) if len(el) > 1 else [0, 0]
        off = coords(el[2], ev) if len(el) > 2 else [0, 0]
        sub = dict(st)
        t = el[0]
        if isinstance(t, Expression) and t.get_head_name() == "System`Style":
            for d in t.elements[1:]:
                if not apply_directive(sub, d, ev):
                    v = num(d, ev)
                    if v:
                        sub["fsize"] = v
        p = {"t": "text", "x": pos[0], "y": pos[1], "text": label_text(t, ev) or "", "color": sub.get("color", "#000"),
             "size": sub.get("fsize", 12), "off": off}
        out.append(p)
    elif name == "Inset":
        t = el[0]
        pos = coords(el[1], ev) if len(el) > 1 else [0, 0]
        out.append({"t": "text", "x": pos[0], "y": pos[1], "text": label_text(t, ev) or "", "color": col, "size": 12,
                    "off": [0, 0]})
    elif name in ("Style", "Tooltip", "Legended", "Annotation", "Mouseover", "Button", "GraphicsGroup"):
        local = dict(st)
        for d in el[1:]:
            apply_directive(local, d, ev)
        walk2(el[0], local, out, ev)
    elif name == "GraphicsComplex":
        pts = coords(el[0], ev)
        _complex(el[1], pts, st, out, ev)


def _edge(p, st):
    if "edge" in st:
        ed = st["edge"]
        p["edge"] = ed.get("color", "#000000") if ed else None
        if ed and "width" in ed:
            p["ewidth"] = ed["width"]
    if "face" in st and st["face"]:
        p["color"] = st["face"].get("color", p["color"])
        if "opacity" in st["face"]:
            p["opacity"] = st["face"]["opacity"]


def _complex(e, pts, st, out, ev):
    if isinstance(e, Expression) and e.has_form("List", None):
        local = dict(st)
        for x in e.elements:
            if not apply_directive(local, x, ev):
                _complex(x, pts, local, out, ev)
        return
    if isinstance(e, Expression) and e.get_head_name().split("`")[-1] in ("Line", "Polygon", "Point"):
        idx = e.elements[0].to_python()
        groups = idx if idx and isinstance(idx[0], (list, tuple)) else [idx]
        name = e.get_head_name().split("`")[-1]
        for gidx in groups:
            xs = [pts[i - 1][0] for i in gidx]
            ys = [pts[i - 1][1] for i in gidx]
            t = {"Line": "line", "Polygon": "poly", "Point": "points"}[name]
            out.append({"t": t, "x": xs, "y": ys, "color": st.get("color", "#000"), "width": st.get("width", 1.4)})


def walk3(e, st, out, ev):
    if isinstance(e, Expression) and e.has_form("List", None):
        local = dict(st)
        for x in e.elements:
            if not apply_directive(local, x, ev):
                walk3(x, local, out, ev)
        return
    if not isinstance(e, Expression):
        return
    hn = e.get_head_name()
    el = e.elements
    name = hn.split("`")[-1]
    col = st.get("color", "#555555")
    base = {"color": col}
    if "opacity" in st:
        base["opacity"] = st["opacity"]
    if hn == "WLX`G":
        p = K.registry.get(el[0].value)
        if p:
            out.extend(p["prims"])
        return
    if name == "Graphics3D":
        if el:
            walk3(el[0], st, out, ev)
        return
    if name == "Point":
        v = coords(el[0], ev)
        pts = [v] if v and not isinstance(v[0], (list, tuple)) else v
        p = {"t": "pts3", "x": [q[0] for q in pts], "y": [q[1] for q in pts], "z": [q[2] for q in pts],
             "psize": st.get("psize", 5)}
        p.update(base)
        out.append(p)
    elif name in ("Line", "Arrow", "Tube"):
        v = coords(el[0], ev)
        if name == "Arrow" and isinstance(el[0], Expression) and el[0].get_head_name() == "System`Tube":
            v = coords(el[0].elements[0], ev)
        lines = v if v and v[0] and isinstance(v[0][0], (list, tuple)) else [v]
        for ln in lines:
            p = {"t": "arrow3" if name == "Arrow" else "line3", "x": [q[0] for q in ln], "y": [q[1] for q in ln],
                 "z": [q[2] for q in ln], "width": st.get("width", 1.6)}
            p.update(base)
            out.append(p)
    elif name in ("Polygon", "Triangle"):
        v = coords(el[0], ev)
        polys = v if v and v[0] and isinstance(v[0][0], (list, tuple)) else [v]
        for pg in polys:
            p = {"t": "poly3", "x": [q[0] for q in pg], "y": [q[1] for q in pg], "z": [q[2] for q in pg]}
            p.update(base)
            out.append(p)
    elif name in ("Sphere", "Ball"):
        c = coords(el[0], ev) if el else [0, 0, 0]
        r = coords(el[1], ev) if len(el) > 1 else 1
        n = np()
        m = 20
        TH, PH = n.meshgrid(n.linspace(0, math.pi, m), n.linspace(0, 2 * math.pi, 2 * m))
        centers = c if c and isinstance(c[0], (list, tuple)) else [c]
        for cc in centers:
            X, Y, Zv = cc[0] + r * n.sin(TH) * n.cos(PH), cc[1] + r * n.sin(TH) * n.sin(PH), cc[2] + r * n.cos(TH)
            p = surf_prim(X, Y, Zv, None, 0, False)
            p["color"] = col
            if "opacity" in st:
                p["opacity"] = st["opacity"]
            out.append(p)
    elif name in ("Cuboid", "Parallelepiped"):
        a = coords(el[0], ev) if el else [0, 0, 0]
        b = coords(el[1], ev) if len(el) > 1 else [a[0] + 1, a[1] + 1, a[2] + 1]
        x0, y0, z0 = a
        x1, y1, z1 = b
        faces = [[(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
                 [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)],
                 [(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)]]
        for f in faces:
            p = {"t": "poly3", "x": [q[0] for q in f], "y": [q[1] for q in f], "z": [q[2] for q in f]}
            p.update(base)
            out.append(p)
    elif name in ("Cylinder", "Cone"):
        ends = coords(el[0], ev) if el else [[0, 0, -1], [0, 0, 1]]
        r = coords(el[1], ev) if len(el) > 1 else 1
        n = np()
        p0, p1 = n.array(ends[0], dtype=float), n.array(ends[1], dtype=float)
        axis = p1 - p0
        ln = n.linalg.norm(axis) or 1.0
        w = axis / ln
        tmp = n.array([1.0, 0, 0]) if abs(w[0]) < 0.9 else n.array([0, 1.0, 0])
        u = n.cross(w, tmp)
        u /= n.linalg.norm(u)
        v = n.cross(w, u)
        m = 28
        TH, S_ = n.meshgrid(n.linspace(0, 2 * math.pi, m), n.linspace(0, 1, 2))
        rad = r * (1 - S_) if name == "Cone" else r
        P = p0[:, None, None] + axis[:, None, None] * S_ + (u[:, None, None] * n.cos(TH) + v[:, None, None] * n.sin(TH)) * rad
        p = surf_prim(P[0], P[1], P[2], None, 0, False)
        p["color"] = col
        if "opacity" in st:
            p["opacity"] = st["opacity"]
        out.append(p)
    elif name == "Text":
        pos = coords(el[1], ev) if len(el) > 1 else [0, 0, 0]
        out.append({"t": "text3", "x": pos[0], "y": pos[1], "z": pos[2], "text": label_text(el[0], ev) or "",
                    "color": st.get("color", "#000")})
    elif name in ("Style", "Tooltip", "Legended"):
        local = dict(st)
        for d in el[1:]:
            apply_directive(local, d, ev)
        walk3(el[0], local, out, ev)


def size_of(v, ev):
    if v is None:
        return None
    if isinstance(v, Symbol):
        return {"Tiny": 120, "Small": 220, "Medium": 380, "Large": 560, "Full": 720}.get(short(v))
    if v.has_form("List", 2):
        a, b = num(v.elements[0], ev), num(v.elements[1], ev)
        return [a, b] if a and b else (a or None)
    return num(v, ev)


def bool_or_pair(v, default):
    if v is None or is_sym(v, "Automatic"):
        return default
    if v is SymbolTrue:
        return True
    if v is SymbolFalse or is_sym(v, "None"):
        return False
    if v.has_form("List", None):
        return [x is SymbolTrue or (x.has_form("List", None) and any(y is SymbolTrue for y in x.elements)) for x in v.elements]
    return default


def labels_of(v, ev):
    if v is None or is_sym(v, "None"):
        return None
    if v.has_form("List", None):
        out = []
        for x in v.elements:
            if x.has_form("List", None):
                out.extend(label_text(y, ev) for y in x.elements)
            else:
                out.append(label_text(x, ev))
        return out
    return [label_text(v, ev)]


def grid_of(v, ev):
    if v is None or is_sym(v, "None"):
        return None
    if is_sym(v, "Automatic"):
        return True
    if v.has_form("List", 2):
        res = []
        for x in v.elements:
            if is_sym(x, "Automatic"):
                res.append(True)
            elif is_sym(x, "None"):
                res.append(False)
            elif x.has_form("List", None):
                res.append([num(y.elements[0] if y.has_form("List", None) else y, ev) for y in x.elements])
            else:
                res.append(False)
        return res
    return None


def ticks_of(v, ev):
    if v is None or is_sym(v, "Automatic"):
        return None
    if is_sym(v, "None") or v is SymbolFalse:
        return False
    if v.has_form("List", None):
        res = []
        for ax in v.elements:
            if is_sym(ax, "Automatic"):
                res.append(None)
            elif is_sym(ax, "None"):
                res.append(False)
            elif ax.has_form("List", None):
                tl = []
                for tk in ax.elements:
                    if tk.has_form("List", None) and len(tk.elements) >= 2:
                        tl.append([num(tk.elements[0], ev), label_text(tk.elements[1], ev)])
                    else:
                        tl.append([num(tk, ev), label_text(tk, ev)])
                res.append([t for t in tl if t[0] is not None])
            else:
                res.append(None)
        return res
    return None


def graphics_json(g, ev):
    g = unwrap_legended(g)
    d = opt_dict(g)
    prims = []
    if "Prolog" in d:
        walk2(d["Prolog"], {}, prims, ev)
    if g.elements:
        walk2(g.elements[0], {}, prims, ev)
    if "Epilog" in d:
        walk2(d["Epilog"], {}, prims, ev)
    pr, allflag = parse_range(d.get("PlotRange"), ev, 2)
    ar = d.get("AspectRatio")
    aspect = "auto"
    if ar is not None and not is_sym(ar, "Automatic"):
        v = num(ar, ev)
        aspect = v if v else ("auto" if not is_sym(ar, "Full") else 1)
    o = {
        "range": pr, "all": allflag, "aspect": aspect,
        "axes": bool_or_pair(d.get("Axes"), False), "frame": bool_or_pair(d.get("Frame"), False),
        "axesLabel": labels_of(d.get("AxesLabel"), ev), "frameLabel": labels_of(d.get("FrameLabel"), ev),
        "plotLabel": label_text(d.get("PlotLabel"), ev), "grid": grid_of(d.get("GridLines"), ev),
        "size": size_of(d.get("ImageSize"), ev), "ticks": ticks_of(d.get("Ticks"), ev),
        "logy": d.get("LogY") is SymbolTrue,
    }
    ao = d.get("AxesOrigin")
    if ao is not None and ao.has_form("List", 2):
        o["origin"] = [num(ao.elements[0], ev), num(ao.elements[1], ev)]
    bg = d.get("Background")
    if bg is not None:
        c = color_of(bg, ev)
        if c:
            o["bg"] = c[0]
    return {"dim": 2, "prims": prims, "opts": o}


def graphics3d_json(g, ev):
    g = unwrap_legended(g)
    d = opt_dict(g)
    prims = []
    if g.elements:
        walk3(g.elements[0], {}, prims, ev)
    pr, allflag = parse_range(d.get("PlotRange"), ev, 3)
    br = d.get("BoxRatios")
    box = None
    if br is not None and br.has_form("List", 3):
        box = [num(x, ev) for x in br.elements]
    vp = d.get("ViewPoint")
    view = None
    if vp is not None and vp.has_form("List", 3):
        view = [num(x, ev) for x in vp.elements]
    elif vp is not None and isinstance(vp, Symbol):
        view = {"Top": [0, 0, 3], "Front": [0, -3, 0], "Above": [0, 0, 3], "Right": [3, 0, 0], "Left": [-3, 0, 0],
                "Back": [0, 3, 0], "Bottom": [0, 0, -3], "Below": [0, 0, -3]}.get(short(vp))
    o = {"range": pr, "all": allflag, "box": box, "axes": bool_or_pair(d.get("Axes"), False),
         "boxed": not (d.get("Boxed") is SymbolFalse), "axesLabel": labels_of(d.get("AxesLabel"), ev),
         "plotLabel": label_text(d.get("PlotLabel"), ev), "size": size_of(d.get("ImageSize"), ev), "view": view}
    return {"dim": 3, "prims": prims, "opts": o}


GALLERY_HEADS = {"System`GraphicsRow": "row", "System`GraphicsColumn": "col", "System`GraphicsGrid": "grid",
                 "System`Row": "row", "System`Column": "col", "System`Grid": "grid", "System`List": "row",
                 "System`TableForm": "grid", "System`MatrixForm": "grid"}


def is_graphic(e):
    e = unwrap_legended(e)
    return isinstance(e, Expression) and e.get_head_name() in ("System`Graphics", "System`Graphics3D",
                                                               "System`Manipulate", "System`Animate")


def format_special(kernel, expr):
    ev = kernel.ev
    e = unwrap_legended(expr)
    if not isinstance(e, Expression):
        return None
    hn = e.get_head_name()
    if hn == "System`Graphics":
        return {"type": "graphics", "g": graphics_json(e, ev)}
    if hn == "System`Graphics3D":
        return {"type": "graphics", "g": graphics3d_json(e, ev)}
    if hn in ("System`Manipulate", "System`Animate"):
        return manipulate_json(kernel, e)
    if hn in GALLERY_HEADS and e.elements:
        first = e.elements[0] if hn != "System`List" else e
        rows = None
        if hn == "System`List":
            if all(is_graphic(x) for x in e.elements):
                rows = [list(e.elements)]
            elif all(x.has_form("List", None) and x.elements and all(is_graphic(y) for y in x.elements) for x in e.elements):
                rows = [list(x.elements) for x in e.elements]
        elif first.has_form("List", None) and first.elements:
            if all(is_graphic(x) for x in first.elements):
                rows = [list(first.elements)] if GALLERY_HEADS[hn] != "col" else [[x] for x in first.elements]
            elif all(x.has_form("List", None) and x.elements and all(is_graphic(y) for y in x.elements) for x in first.elements):
                rows = [list(x.elements) for x in first.elements]
        if rows:
            return {"type": "gallery", "rows": [[format_special(kernel, x) for x in row] for row in rows]}
    return None


def strip_graphics(kernel, expr):
    def rep(e):
        if isinstance(e, Expression):
            hn = e.get_head_name()
            if hn == "System`Graphics":
                return Symbol("Global`-Graphics-")
            if hn == "System`Graphics3D":
                return Symbol("Global`-Graphics3D-")
            if hn == "System`InterpolatingFunction" and len(e.elements) == 3:
                return E("InterpolatingFunction", e.elements[0], String("<>"))
            head = e.get_head()
            new_head = rep(head) if isinstance(head, Expression) else head
            els = [rep(x) for x in e.elements]
            if new_head is head and all(a is b for a, b in zip(els, e.elements)):
                return e
            return Expression(new_head, *els)
        return e
    try:
        return rep(expr)
    except Exception:
        return expr


# --------------------------------------------------------------- Manipulate
class Manipulate(XB):
    attributes = A_HOLD_ALL | A_PROTECTED


class Animate(XB):
    attributes = A_HOLD_ALL | A_PROTECTED


def parse_controls(specs, ev):
    controls = []
    for sp_ in specs:
        if sp_.get_head_name() in ("System`Rule", "System`RuleDelayed"):
            continue
        if not sp_.has_form("List", None) or not sp_.elements:
            continue
        el = [x for x in sp_.elements if x.get_head_name() not in ("System`Rule", "System`RuleDelayed")]
        var = el[0]
        init, label = None, None
        if var.has_form("List", None):
            parts = var.elements
            var = parts[0]
            if len(parts) > 1:
                init = parts[1].evaluate(ev)
            if len(parts) > 2:
                label = label_text(parts[2].evaluate(ev), ev)
        if not isinstance(var, Symbol):
            continue
        c = {"name": var.get_name(), "label": label or short(var)}
        rest = [x.evaluate(ev) for x in el[1:]]
        if len(rest) == 1 and rest[0].has_form("List", None):
            vals = list(rest[0].elements)
            c["type"] = "choice"
            c["choices"] = [label_text(v, ev) if not isinstance(v, String) else v.value for v in vals]
            c["exprs"] = vals
            c["value"] = 0
            if init is not None:
                for i, v in enumerate(vals):
                    if v.sameQ(init):
                        c["value"] = i
        elif len(rest) >= 2:
            a, b = num(rest[0], ev), num(rest[1], ev)
            if a is None or b is None:
                continue
            c["type"] = "slider"
            c["min"], c["max"] = a, b
            step = num(rest[2], ev) if len(rest) > 2 else None
            c["step"] = step if step else (b - a) / 200.0
            c["integer"] = bool(step) and float(step).is_integer() and float(a).is_integer()
            iv = num(init, ev) if init is not None else None
            c["value"] = iv if iv is not None else a
        else:
            continue
        controls.append(c)
    return controls


def manipulate_json(kernel, e):
    ev = kernel.ev
    body = e.elements[0]
    controls = parse_controls(e.elements[1:], ev)
    exprs = {c["name"]: c.pop("exprs", None) for c in controls}
    mid = kernel.new_id({"kind": "manip", "body": body, "controls": controls, "exprs": exprs})
    values = {c["name"]: c["value"] for c in controls}
    first = manipulate_eval(kernel, mid, values)
    return {"type": "manipulate", "id": mid, "controls": controls, "animate": e.get_head_name() == "System`Animate",
            "initial": first}


def manipulate_eval(kernel, mid, values):
    import time as _t

    from .core import Deadline

    p = kernel.registry.get(mid)
    ev = kernel.ev
    if p is None:
        return {"items": []}
    assigns = []
    for c in p["controls"]:
        v = values.get(c["name"], c["value"])
        if c["type"] == "choice":
            val = p["exprs"][c["name"]][int(v)]
        else:
            val = Integer(int(round(v))) if c.get("integer") else Real(float(v))
        assigns.append(E("Set", Symbol(c["name"]), val))
    ev.out = []
    ev.stopped = False
    kernel._deadline = _t.time() + 12
    items = []
    try:
        res = E("Block", L(*assigns), p["body"]).evaluate(ev)
        items.extend(kernel._drain_messages())
        if res is not SymbolNull:
            it = kernel.format(res)
            it["kind"] = "out"
            items.append(it)
    except Deadline:
        items.append({"kind": "message", "symbol": "Manipulate", "tag": "time", "text": "Evaluación demasiado lenta."})
    finally:
        kernel._deadline = None
        ev.stopped = False
    return {"items": items}


class ColorDataX(XB):
    name = "ColorData"
    attributes = A_PROTECTED

    def eval(self, i, k, evaluation):
        "ColorData[i_Integer][k_Integer]"
        h = PALETTE[(k.value - 1) % len(PALETTE)]
        return E("RGBColor", *[Real(int(h[j:j + 2], 16) / 255.0) for j in (1, 3, 5)])


class Legended(XB):
    def eval(self, g, l, evaluation):
        "Legended[g_, l_]"
        return None


BUILTINS = [Plot, LogPlot, ListPlot, ListLinePlot, DiscretePlot, ParametricPlot, PolarPlot, ContourPlot, DensityPlot,
            RegionPlot, VectorPlot, StreamPlot, Plot3D, ParametricPlot3D, ContourPlot3D, RegionPlot3D,
            RevolutionPlot3D, SphericalPlot3D, ListPointPlot3D, ListPlot3D, VectorPlot3D, Show, Manipulate, Animate,
            ColorDataX]


def install(kernel):
    global K
    K = kernel
    ext.contribute(kernel, BUILTINS)
