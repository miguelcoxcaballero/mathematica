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

from .conv import Conv, ConvError, FUNCS, S
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
    "Frame": "Automatic", "FrameLabel": "None", "AspectRatio": "WLX`Unset", "PlotLegends": "None", "Filling": "None",
    "FillingStyle": "Automatic", "GridLines": "None", "ImageSize": "Automatic", "PlotPoints": "Automatic",
    "MaxRecursion": "Automatic", "Epilog": "{}", "Prolog": "{}", "AxesOrigin": "Automatic", "Ticks": "Automatic",
    "Exclusions": "Automatic", "PlotTheme": "Automatic", "ColorFunction": "Automatic", "Mesh": "Automatic",
    "Contours": "Automatic", "ContourShading": "Automatic", "ContourStyle": "Automatic", "ContourLabels": "None",
    "BoundaryStyle": "Automatic", "VectorScale": "Automatic", "VectorPoints": "Automatic",
    "VectorStyle": "Automatic", "StreamPoints": "Automatic", "StreamStyle": "Automatic", "BoxRatios": "WLX`Unset",
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


_TRAD_FN = {"Sin": "sin", "Cos": "cos", "Tan": "tan", "Cot": "cot", "Sec": "sec", "Csc": "csc", "Sinh": "sinh",
            "Cosh": "cosh", "Tanh": "tanh", "Log": "log", "Exp": "exp", "ArcSin": "arcsin", "ArcCos": "arccos",
            "ArcTan": "arctan", "ArcSinh": "arcsinh", "ArcCosh": "arccosh", "ArcTanh": "arctanh", "Abs": "abs",
            "Max": "max", "Min": "min", "Re": "Re", "Im": "Im", "Arg": "arg", "Sign": "sgn", "Floor": "floor",
            "Ceiling": "ceil", "Gamma": "Γ", "Erf": "erf"}


def traditional(t):
    """Cheap TraditionalForm look for labels: Sin[x] -> sin(x), f[x] -> f(x), == -> =, Sqrt[x] -> √x, Pi -> π."""
    import re

    if not t or len(t) > 400:
        return t
    t = t.replace("[[", "⟦").replace("]]", "⟧")
    t = re.sub(r"\bSqrt\[([A-Za-z0-9.α-ωΑ-Ω]+)\]", "√\\1", t)
    t = re.sub(r"\bSqrt\[", "√[", t)
    t = re.sub(r"\b([A-Z][A-Za-z0-9]*)\[", lambda m: _TRAD_FN.get(m.group(1), m.group(1)) + "[", t)
    t = t.replace("[", "(").replace("]", ")").replace("⟦", "[[").replace("⟧", "]]")
    t = t.replace("==", "=").replace(" * ", " ")
    t = re.sub(r"\bPi\b", "π", t)
    t = re.sub(r"\bE\^", "e^", t)
    t = re.sub(r"\bInfinity\b", "∞", t)
    return t


def label_text(e, ev):
    if e is None:
        return None
    if isinstance(e, String):
        return e.value
    if isinstance(e, Symbol) and short(e) in ("None", "Null", "Automatic"):
        return None
    if isinstance(e, Expression) and e.get_head_name() in ("System`Style", "System`HoldForm", "System`Text",
                                                           "System`Placed", "System`Tooltip", "System`Framed",
                                                           "System`TraditionalForm", "System`StandardForm",
                                                           "System`Subscript", "System`DisplayForm"):
        if e.get_head_name() == "System`Subscript" and len(e.elements) == 2:
            return (label_text(e.elements[0], ev) or "") + "_" + (label_text(e.elements[1], ev) or "")
        return label_text(e.elements[0], ev) if e.elements else None
    if isinstance(e, Expression) and e.get_head_name() == "System`Row" and e.elements and \
            e.elements[0].has_form("List", None):
        return "".join(label_text(x, ev) or "" for x in e.elements[0].elements)
    if isinstance(e, Expression) and e.get_head_name() == "System`StringJoin":
        return "".join(label_text(x, ev) or "" for x in e.elements)
    try:
        t = K.to_text(E("HoldForm", e), "OutputForm")
        return traditional(t.replace(" ^ ", "^"))
    except Exception:
        return str(e)


# ------------------------------------------------------- numeric sampling
_HE = {"timeout_at": 0.0, "bodies": {}}


def hold_eval(body, vars, ev, limit=1.6):
    """Evaluate the plot body symbolically with the plot variables blocked (as Plot does after localising them).
    Gives up after `limit` seconds (some symbolic rewrites explode) and returns the body untouched: it is then
    sampled numerically point by point."""
    import time as _t

    key = None
    try:
        key = str(body)[:600]
        if key in _HE["bodies"]:
            _HE["timeout_at"] = _t.time()
            return body
    except Exception:
        key = None
    old = getattr(K, "_deadline", None)
    mine = _t.time() + limit
    shortened = old is None or mine < old
    if shortened:
        K._deadline = mine
    try:
        r = E("Block", L(*vars), E("Hold", E("Evaluate", body))).evaluate(ev)
        if r.get_head_name() == "System`Hold" and len(r.elements) == 1:
            return r.elements[0]
    except ext_Deadline():
        if not shortened or (old is not None and _t.time() > old):
            raise
        ev.stopped = False
        _HE["timeout_at"] = _t.time()
        if key is not None:
            if len(_HE["bodies"]) > 40:
                _HE["bodies"].clear()
            _HE["bodies"][key] = True
    except Exception:
        pass
    finally:
        K._deadline = old
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
            if sh is None and hn.startswith("Global`") and (hn[7:] in EXTRA_HEADS or hn[7:] in FUNCS):
                sh = hn[7:]
                e = Expression(Symbol("System`" + sh), *el)
                hn = "System`" + sh
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
            if sh in ("AiryAi", "AiryBi") and len(el) == 1:
                return (sp.airyai if sh == "AiryAi" else sp.airybi)(self.to(el[0]))
            if sh in ("SinhIntegral", "CoshIntegral") and len(el) == 1:
                return (sp.Shi if sh == "SinhIntegral" else sp.Chi)(self.to(el[0]))
            if sh == "LogIntegral" and len(el) == 1:
                return sp.li(self.to(el[0]))
            if sh == "ChebyshevU" and len(el) == 2:
                return sp.chebyshevu(self.to(el[0]), self.to(el[1]))
            if sh == "Ramp" and len(el) == 1:
                return self.fn("WLXRamp", lambda a: n.maximum(a, 0.0), self.to(el[0]))
            if sh in ("RealAbs", "RealSign") and len(el) == 1:
                return (sp.Abs if sh == "RealAbs" else sp.sign)(self.to(el[0]))
            if sh == "Haversine" and len(el) == 1:
                return (1 - sp.cos(self.to(el[0]))) / 2
            if sh == "LogisticSigmoid" and len(el) == 1:
                return 1 / (1 + sp.exp(-self.to(el[0])))
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


GFX_NUMPY = {}


def _init_numeric():
    """Robust (nan instead of exceptions, complex-aware) element-wise special functions."""
    if GFX_NUMPY:
        return
    n = np()
    import math as _m

    def wrap(fn, real_fn=None):
        def one(*a):
            try:
                if real_fn is not None and not any(isinstance(v, complex) and v.imag != 0 for v in a):
                    try:
                        return complex(real_fn(*[float(v.real) if isinstance(v, complex) else float(v) for v in a]))
                    except (ValueError, OverflowError):
                        if fn is None:
                            return complex("nan")
                v = fn(*[(complex(v) if (isinstance(v, complex) and v.imag != 0) else float(v.real if isinstance(v, complex) else v))
                         for v in a])
                return complex(v)
            except Exception:
                return complex("nan")
        vec = n.vectorize(one, otypes=[complex])

        def call(*a):
            r = vec(*[n.asarray(v) for v in a])
            if not n.any(n.nan_to_num(n.abs(r.imag)) > 0):
                r = r.real
            return r
        return call
    GFX_NUMPY.update({
        "Max": lambda *a: _reduce(n.fmax, a), "Min": lambda *a: _reduce(n.fmin, a),
        "KroneckerDelta": lambda *a: ((a[0] == (a[1] if len(a) > 1 else 0)) * 1.0),
        "sinc": lambda x: n.sinc(n.asarray(x) / n.pi),
    })
    try:
        import mpmath as mp
    except Exception:
        return
    GFX_NUMPY.update({
        "gamma": wrap(mp.gamma, _m.gamma), "loggamma": wrap(mp.loggamma, _m.lgamma),
        "factorial": wrap(lambda x: mp.gamma(x + 1), lambda x: _m.gamma(x + 1)),
        "erf": wrap(mp.erf, _m.erf), "erfc": wrap(mp.erfc, _m.erfc), "erfi": wrap(mp.erfi),
        "besselj": wrap(mp.besselj), "bessely": wrap(mp.bessely), "besseli": wrap(mp.besseli),
        "besselk": wrap(mp.besselk), "Si": wrap(mp.si), "Ci": wrap(mp.ci), "Ei": wrap(mp.ei), "Shi": wrap(mp.shi),
        "Chi": wrap(mp.chi), "fresnels": wrap(mp.fresnels), "fresnelc": wrap(mp.fresnelc), "zeta": wrap(mp.zeta),
        "LambertW": wrap(mp.lambertw), "legendre": wrap(mp.legendre), "hermite": wrap(mp.hermite),
        "chebyshevt": wrap(mp.chebyt), "chebyshevu": wrap(mp.chebyu), "laguerre": wrap(mp.laguerre),
        "elliptic_k": wrap(mp.ellipk), "elliptic_e": wrap(mp.ellipe), "airyai": wrap(mp.airyai),
        "airybi": wrap(mp.airybi), "beta": wrap(mp.beta), "binomial": wrap(mp.binomial),
        "polygamma": wrap(mp.polygamma), "digamma": wrap(mp.digamma), "expint": wrap(mp.expint),
        "fibonacci": wrap(mp.fibonacci), "factorial2": wrap(mp.fac2), "li": wrap(mp.li),
        "uppergamma": wrap(lambda a, x: mp.gammainc(a, x)), "lowergamma": wrap(lambda a, x: mp.gammainc(a, 0, x)),
    })


# heads that this Mathics build does not know (they stay in Global`) but we can sample numerically
EXTRA_HEADS = {"Sinc", "Clip", "Surd", "CubeRoot", "SquareWave", "TriangleWave", "SawtoothWave", "RealAbs", "UnitBox",
               "UnitTriangle", "HeavisidePi", "HeavisideLambda", "Log10", "Log2", "Boole", "FractionalPart",
               "IntegerPart", "AiryAi", "AiryBi", "SinhIntegral", "CoshIntegral", "Ramp", "RealSign", "LogIntegral",
               "ChebyshevU", "Haversine", "LogisticSigmoid", "Subtract", "Minus", "Divide", "Round", "Norm", "Total",
               "Dot", "Max", "Min"}


def _lambdify(c, syms, s):
    _init_numeric()
    return sp.lambdify(syms, s, modules=[c.extra, GFX_NUMPY, ext.NUMPY_EXTRA, "numpy"])


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
    import time as _t

    yield expr
    if raw is not None and raw is not expr:
        yield raw
    if _t.time() - _HE["timeout_at"] < 6:
        return                      # the symbolic evaluation of this plot body just blew up: go numeric
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
        if out.size > 24:
            # not numeric anywhere (undefined function, typo...): do not waste a second finding it out
            probe_idx = [int(q) for q in n.linspace(0, out.size - 1, 7)]
            if all(one_slow([a[i] for a in flat]) is None for i in probe_idx):
                return out.reshape(shape)
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


def robust_range(ys, ordered=False):
    """Automatic y-range: full data range unless far outliers are poles (isolated spikes), which are cropped."""
    n = np()
    fin = n.isfinite(ys)
    y = ys[fin]
    if y.size == 0:
        return [-1.0, 1.0]
    lo, hi = float(y.min()), float(y.max())
    if y.size > 20:
        q1, q3 = n.percentile(y, [10, 90])
        iqr = q3 - q1
        if iqr > 0 and (hi - lo) > 12 * iqr:
            crop_lo = crop_hi = True
            if ordered:
                # a smooth finite peak is resolved by its neighbours; a pole is an isolated spike
                med = float(n.median(y))

                def isolated(k):
                    v = abs(ys[k] - med)
                    if v == 0:
                        return False
                    for kk in (k - 1, k + 1):
                        if 0 <= kk < len(ys):
                            if not fin[kk] or (ys[kk] - med) * (ys[k] - med) < 0 or abs(ys[kk] - med) < 0.5 * v:
                                return True
                    return False
                yy = n.where(fin, ys, med)
                crop_hi = isolated(int(n.argmax(yy)))
                crop_lo = isolated(int(n.argmin(yy)))
            if crop_lo:
                lo = max(lo, float(q1 - 0.5 * iqr))
            if crop_hi:
                hi = min(hi, float(q3 + 0.5 * iqr))
    if hi - lo < 1e-12 * (abs(hi) + abs(lo) + 1e-300):
        d = abs(lo) * 0.1 or 1.0
        lo, hi = lo - d, hi + d
    pad = (hi - lo) * 0.04
    return [lo - pad, hi + pad]


def union_range(rs):
    return [min(r[0] for r in rs), max(r[1] for r in rs)]


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
        # PlotRange -> s : from -s to s in every direction
        return [[-abs(v), abs(v)] for _ in range(dims)], allflag
    if pr.has_form("List", 2) and not pr.elements[0].has_form("List", None) and \
            num(pr.elements[0], ev) is not None and num(pr.elements[1], ev) is not None:
        res[dims - 1] = [num(pr.elements[0], ev), num(pr.elements[1], ev)]
        return res, allflag
    if pr.has_form("List", None):
        for i, e in enumerate(pr.elements[:dims]):
            if e.has_form("List", 2):
                a, b = num(e.elements[0], ev), num(e.elements[1], ev)
                if a is not None and b is not None:
                    res[i] = [min(a, b), max(a, b)]
            elif isinstance(e, Symbol) and short(e) in ("All", "Full"):
                allflag = True
            else:
                v = num(e, ev)
                if v is not None:
                    res[i] = [-abs(v), abs(v)]
    for i, r in enumerate(res):
        if r is not None and not (r[1] > r[0]):
            res[i] = None
    return res, allflag


def is_default(name, v):
    """Is v the default value of option `name` (i.e. the user did not give it)?"""
    d = GOPTS.get(name)
    if d is None:
        return False
    if isinstance(v, Symbol):
        return v.get_name().split("`")[-1] == d.split("`")[-1]
    if d == "{}":
        return isinstance(v, Expression) and v.has_form("List", 0)
    if d == "0":
        return isinstance(v, Integer) and v.value == 0
    return False


_KEEP_AUTOMATIC = ("AspectRatio", "GridLines", "BoxRatios")


def gopts(options, defaults=None, exclude=()):
    """Collect Graphics-level option rules to store in the Graphics expression."""
    rules = []
    seen = set()
    for name in PASS_OPTS:
        if name in exclude:
            continue
        v = opt(options, name)
        if v is None or is_default(name, v):
            continue
        if is_sym(v, "Automatic") and name not in _KEEP_AUTOMATIC:
            continue
        rules.append(Rule(S(name), v))
        seen.add(name)
    for name, v in (defaults or {}).items():
        if name not in seen:
            rules.append(Rule(S(name) if "`" not in name else Symbol(name), v))
    return rules


def rng_expr(r):
    return L(*[L(Real(float(a)), Real(float(b))) for a, b in r])


def G2(prims, rules):
    pid = K.new_id({"kind": "g", "prims": prims})
    return E("Graphics", L(E(Symbol("WLX`G"), Integer(pid))), *rules)


def G3(prims, rules):
    pid = K.new_id({"kind": "g", "prims": prims})
    return E("Graphics3D", L(E(Symbol("WLX`G"), Integer(pid))), *rules)


def legend_prim(options, exprs, styles, ev, kind=None):
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
    elif is_sym(pl, "Automatic"):
        labels = [label_text(e, ev) if not isinstance(e, String) else e.value for e in exprs]
    else:
        labels = [str(i + 1) for i in range(len(exprs))]
    items = []
    for i, lab in enumerate(labels[:len(styles)]):
        it = {"label": lab or "", "color": styles[i].get("color"), "dash": styles[i].get("dash")}
        if styles[i].get("width"):
            it["width"] = styles[i]["width"]
        if kind:
            it["kind"] = kind
            if kind == "swatch" and "opacity" in styles[i]:
                it["opacity"] = styles[i]["opacity"]
        items.append(it)
    return {"t": "legend", "items": items} if items else None


def bar_legend(options, cf, lo=None, hi=None):
    """PlotLegends -> Automatic on Density/ContourPlot: colour bar (limits filled in by the renderer if None)."""
    pl = opt(options, "PlotLegends")
    if pl is None or is_sym(pl, "None"):
        return None
    return {"t": "legend", "items": [], "bar": {"cf": cf, "lo": lo, "hi": hi}}


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


def raw_of(orig, exprs, i):
    """Unevaluated version of curve i (only meaningful when it differs from the evaluated one)."""
    if orig is None or i >= len(orig) or orig[i] is exprs[i]:
        return None
    return orig[i]


def exclusions(options, x, ev):
    """Exclusions option -> None (never break), or list of explicit x positions (possibly empty = automatic)."""
    ex = opt(options, "Exclusions")
    if ex is None or is_sym(ex, "Automatic"):
        return []
    if is_sym(ex, "None") or ex is SymbolFalse:
        return None
    items = ex.elements if ex.has_form("List", None) else [ex]
    out = []
    for it in items:
        if it.get_head_name() == "System`Equal" and len(it.elements) == 2:
            v = num(it.elements[1], ev)
            if v is None:
                v = num(it.elements[0], ev)
        else:
            v = num(it, ev)
        if v is not None:
            out.append(v)
    return out


def refine_curve(fn, xs, ys, yr, passes=2, per=6, cap=3000):
    """Insert samples where the curve jumps / leaves its domain so asymptotes and end points look sharp."""
    n = np()
    if fn.slow:
        return xs, ys
    span = (yr[1] - yr[0]) or 1.0
    for _ in range(passes):
        fin = n.isfinite(ys)
        d = n.abs(n.diff(n.where(fin, ys, 0.0)))
        edge = fin[1:] != fin[:-1]
        inview = (n.minimum(ys[1:], ys[:-1]) < yr[1] + 25 * span) & (n.maximum(ys[1:], ys[:-1]) > yr[0] - 25 * span)
        idx = n.nonzero(edge | ((d > 0.08 * span) & fin[1:] & fin[:-1] & inview))[0]
        if idx.size == 0:
            break
        if idx.size * per > cap:
            idx = idx[:cap // per]
        t = (n.arange(1, per + 1) / (per + 1.0))[None, :]
        nx = (xs[idx][:, None] + (xs[idx + 1] - xs[idx])[:, None] * t).ravel()
        ny = fn(nx)
        xs = n.concatenate([xs, nx])
        ys = n.concatenate([ys, ny])
        o = n.argsort(xs, kind="stable")
        xs, ys = xs[o], ys[o]
    return xs, ys


def break_jumps(xs, ys, yr, forced=()):
    """Insert NaN (pen up) across poles and jump discontinuities. Returns new (xs, ys)."""
    n = np()
    span = (yr[1] - yr[0]) or 1.0
    fin = n.isfinite(ys)
    y0 = n.where(fin, ys, 0.0)
    d = n.abs(n.diff(y0))
    both = fin[1:] & fin[:-1]
    a, b = y0[:-1], y0[1:]
    pole = both & (((a > yr[1]) & (b < yr[0])) | ((a < yr[0]) & (b > yr[1])) |
                   ((d > 2.5 * span) & (a * b < 0)))
    # isolated big step between two flat neighbours = jump discontinuity
    dl = n.concatenate([[0.0], d[:-1]])
    dr = n.concatenate([d[1:], [0.0]])
    jump = both & (d > 0.06 * span) & (d > 12 * n.maximum(dl, dr))
    cut = n.nonzero(pole | jump)[0]
    pos = list(cut + 1)
    for v in forced or ():
        k = int(n.searchsorted(xs, v))
        if 0 < k < len(xs):
            pos.append(k)
    if not pos:
        return xs, ys
    pos = sorted(set(pos))
    xs2 = n.insert(xs, pos, [(xs[k - 1] + xs[k]) / 2 for k in pos])
    ys2 = n.insert(ys, pos, n.nan)
    return xs2, ys2


class GB(XB):
    attributes = A_HOLD_ALL | A_PROTECTED
    options = GOPTS


# -------------------------------------------------------------------- Plot
class Plot(GB):
    def eval(self, f, x, a, b, evaluation, options):
        "Plot[f_, {x_Symbol, a_, b_}, OptionsPattern[Plot]]"
        sf = opt(options, "ScalingFunctions")
        mode = "log" if isinstance(sf, String) and sf.value == "Log" else "plot"
        return plot_curves(f, x, a, b, evaluation, options, mode=mode)


class LogPlot(GB):
    def eval(self, f, x, a, b, evaluation, options):
        "LogPlot[f_, {x_Symbol, a_, b_}, OptionsPattern[LogPlot]]"
        return plot_curves(f, x, a, b, evaluation, options, mode="log")


def plot_curves(f, x, a, b, ev, options, mode="plot"):
    n = np()
    a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
    if a_v is None or b_v is None or a_v == b_v:
        return None
    if a_v > b_v:
        a_v, b_v = b_v, a_v
    exprs, was_list, orig = held_list(f, [x], ev)
    pp = num(opt(options, "PlotPoints"), ev)
    styles = styles_for(options, len(exprs), ev)
    excl = exclusions(options, x, ev)
    prims = []
    curves = []
    slow_budget = 1.4 / max(1, len(exprs))
    for i, ex in enumerate(exprs):
        fn = make_fn(ex, [x], ev, raw=raw_of(orig, exprs, i))
        npts = budget(fn, 700, 160, seconds=slow_budget)
        if pp and not fn.slow:
            npts = int(max(50, min(4000, pp * 12)))
        xs = n.linspace(a_v, b_v, npts)
        eps = (b_v - a_v) * 1e-9          # avoid exact endpoint singularities
        xs[0] += eps
        xs[-1] -= eps
        curves.append([fn, xs, fn(xs)])
    cat = n.concatenate([c[2] for c in curves]) if curves else n.array([0.0])
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    if mode == "log":
        pos = cat[n.isfinite(cat) & (cat > 0)]
        if pos.size:
            hi = float(pos.max())
            lo = max(float(pos.min()), hi * 1e-14)
            if lo >= hi:
                lo, hi = hi / 10, hi * 10
            k = (hi / lo) ** 0.04
            yr = [lo / k, hi * k]
        else:
            yr = [0.1, 10.0]
        if pr[1] is not None and pr[1][0] > 0:
            yr = pr[1]
        elif pr[1] is not None and pr[1][1] > 0:
            yr = [min(yr[0], pr[1][1] / 10), pr[1][1]]
    else:
        if allflag:
            fin = cat[n.isfinite(cat)]
            yr = [float(fin.min()), float(fin.max())] if fin.size else [-1, 1]
            pad = (yr[1] - yr[0]) * 0.04 or 1
            yr = [yr[0] - pad, yr[1] + pad]
        else:
            yr = union_range([robust_range(c[2], ordered=True) for c in curves])
        yr_auto = union_range([robust_range(c[2], ordered=True) for c in curves])
        if pr[1] is not None:
            yr = pr[1]
    xr = pr[0] if pr[0] is not None else [a_v, b_v]
    fill = opt(options, "Filling")
    has_fill = fill is not None and not is_sym(fill, "None")
    base_ys = [c[2] for c in curves]
    base_xs = [c[1] for c in curves]
    for i, (fn, xs, ys) in enumerate(curves):
        st = styles[i]
        if has_fill:
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
                            if 0 <= j < len(curves) and len(base_ys[j]) == len(ys):
                                other = base_ys[j]
                        elif isinstance(tgt, Symbol) and short(tgt) == "Axis":
                            other = n.zeros_like(ys)
                        elif isinstance(tgt, Symbol) and short(tgt) in ("Bottom", "Top"):
                            other = n.full_like(ys, yr[0] if short(tgt) == "Bottom" else yr[1])
                        elif num(tgt, ev) is not None:
                            other = n.full_like(ys, num(tgt, ev))
                if other is None:
                    other = False
            if other is not False:
                yb = other if other is not None else n.full_like(ys, base)
                if mode == "log":
                    yb = n.maximum(yb, yr[0])
                fst = {}
                fs = opt(options, "FillingStyle")
                if fs is not None and not is_sym(fs, "Automatic"):
                    apply_directive(fst, fs.evaluate(ev), ev)
                prims.append({"t": "fill", "x": nlist(base_xs[i]), "y": nlist(n.clip(ys, yr[0], yr[1])),
                              "y2": nlist(n.clip(yb, yr[0], yr[1])), "color": fst.get("color", st["color"]),
                              "opacity": fst.get("opacity", 0.2)})
        if mode != "log":
            xs, ys = refine_curve(fn, xs, ys, yr_auto)
            if excl is not None:
                xs, ys = break_jumps(xs, ys, yr_auto, excl)
            # nothing useful lives far outside the frame: keep the JSON small and the SVG sane
            span = yr_auto[1] - yr_auto[0]
            ys = n.clip(ys, yr_auto[0] - 60 * span, yr_auto[1] + 60 * span)
        p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
        p.update(st)
        prims.append(p)
    leg = legend_prim(options, orig, styles, ev)
    if leg:
        prims.append(leg)
    pls = opt(options, "PlotLabels")
    if pls is not None and not is_sym(pls, "None"):
        labs = [label_text(e, ev) for e in (pls.elements if pls.has_form("List", None) else orig)]
        for i, (fn, xs, ys) in enumerate(curves):
            if i < len(labs) and labs[i]:
                ok = n.nonzero(n.isfinite(ys) & (ys >= yr[0]) & (ys <= yr[1]))[0]
                if ok.size:
                    k = int(ok[-1])
                    prims.append({"t": "text", "x": float(xs[k]), "y": float(ys[k]), "text": labs[i],
                                  "color": styles[i]["color"], "size": 11, "off": [1.2, -1.2]})
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
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def one(ds):
        if len(ds) == 0:
            return None
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
        # tolerate a few non-numeric entries (e.g. Indeterminate): drop them
        good = [v for v in ds if isinstance(v, (list, tuple)) and len(v) == 2 and all(is_num(c) for c in v)]
        if len(good) >= max(2, len(ds) // 2):
            arr = n.array(good, dtype=float)
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


def fast_table(e, ev):
    """ListPlot[Table[{x, f}, {x, a, b, dx}]] (the course's favourite inside Manipulate): sample f vectorised instead
    of letting the kernel evaluate it point by point. Returns (xs, ys) or None when that is not possible."""
    n = np()
    if not (isinstance(e, Expression) and e.get_head_name() == "System`Table" and len(e.elements) == 2):
        return None
    body, it = e.elements
    if not it.has_form("List", None) or len(it.elements) not in (2, 3, 4):
        return None
    var = it.elements[0]
    if not isinstance(var, Symbol):
        return None
    vals = [num(x.evaluate(ev), ev) for x in it.elements[1:]]
    if any(v is None for v in vals):
        return None
    if len(vals) == 1:
        a, b, st = 1.0, vals[0], 1.0
    elif len(vals) == 2:
        a, b, st = vals[0], vals[1], 1.0
    else:
        a, b, st = vals
    if st == 0 or (b - a) / st < 0:
        return None
    npts = int(math.floor((b - a) / st + 1e-9)) + 1
    if npts < 2 or npts > 20000:
        return None
    xs = a + st * n.arange(npts)
    he = hold_eval(body, [var], ev)
    if isinstance(he, Expression) and he.has_form("List", None):
        if len(he.elements) != 2:
            return None
        fx, fy = make_fn(he.elements[0], [var], ev), make_fn(he.elements[1], [var], ev)
        if fx.slow or fy.slow:
            return None
        X, Y = fx(xs), fy(xs)
    else:
        fy = make_fn(he, [var], ev)
        if fy.slow:
            return None
        X, Y = n.arange(1, npts + 1, dtype=float), fy(xs)
    ok = n.isfinite(X) & n.isfinite(Y)
    if not ok.any():
        return None
    return X[ok], Y[ok]


def held_data(data, ev):
    """Datasets of a held ListPlot argument: fast path for Table[...] (or a list of them), else evaluate."""
    try:
        if isinstance(data, Expression):
            if data.get_head_name() == "System`Table":
                r = fast_table(data, ev)
                if r is not None:
                    return [r], None
            elif data.has_form("List", None) and data.elements and \
                    all(isinstance(x, Expression) and x.get_head_name() == "System`Table" for x in data.elements):
                rs = [fast_table(x, ev) for x in data.elements]
                if all(r is not None for r in rs):
                    return rs, None
    except ext_Deadline():
        raise
    except Exception:
        pass
    return None, data.evaluate(ev)


class ListPlot(GB):

    def eval(self, data, evaluation, options):
        "ListPlot[data_, OptionsPattern[ListPlot]]"
        joined = opt(options, "Joined") is SymbolTrue
        return list_plot(data, evaluation, options, joined)


class ListLinePlot(GB):

    def eval(self, data, evaluation, options):
        "ListLinePlot[data_, OptionsPattern[ListLinePlot]]"
        return list_plot(data, evaluation, options, True)


class ListLogPlot(GB):

    def eval(self, data, evaluation, options):
        "ListLogPlot[data_, OptionsPattern[ListLogPlot]]"
        joined = opt(options, "Joined") is SymbolTrue
        return list_plot(data, evaluation, options, joined, log=True)


class DiscretePlot(GB):
    def eval(self, f, spec, evaluation, options):
        "DiscretePlot[f_, spec_List, OptionsPattern[DiscretePlot]]"
        if len(spec.elements) < 2:
            return None
        if len(spec.elements) == 2:
            spec = L(spec.elements[0], Integer(1), spec.elements[1])
        tab = E("Table", L(spec.elements[0], f), spec).evaluate(evaluation)
        return list_plot(tab, evaluation, options, False, stems=True)


def list_plot(data, ev, options, joined, stems=False, log=False):
    n = np()
    sets, evaluated = held_data(data, ev)
    if sets is None:
        sets = list_data(evaluated, ev, options)
    if not sets:
        return None
    styles = styles_for(options, len(sets), ev)
    fill = opt(options, "Filling")
    has_fill = fill is not None and not is_sym(fill, "None")
    prims = []
    for i, (xs, ys) in enumerate(sets):
        st = dict(styles[i])
        if stems or (has_fill and not joined):
            sx, sy = [], []
            for xv, yv in zip(xs.tolist(), ys.tolist()):
                sx.extend([xv, xv, None])
                sy.extend([0, yv, None])
            prims.append({"t": "line", "x": sx, "y": sy, "color": st["color"], "width": 1.1, "opacity": 0.55,
                          "nohover": True})
        if joined:
            if has_fill:
                prims.append({"t": "fill", "x": nlist(xs), "y": nlist(ys), "y2": [0.0] * len(xs), "color": st["color"],
                              "opacity": 0.2})
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update({k: v for k, v in st.items() if k != "psize"})
            prims.append(p)
            m = opt(options, "Mesh")
            if (m is not None and isinstance(m, Symbol) and short(m) in ("All", "Full")) or \
                    (opt(options, "PlotMarkers") is not None and not is_sym(opt(options, "PlotMarkers"), "None")):
                prims.append({"t": "points", "x": nlist(xs), "y": nlist(ys), "color": st["color"],
                              "psize": st.get("psize", 4.5)})
        else:
            p = {"t": "points", "x": nlist(xs), "y": nlist(ys), "psize": st.get("psize", 4.5)}
            p.update({k: v for k, v in st.items() if k not in ("width", "dash")})
            prims.append(p)
    allx = n.concatenate([s[0] for s in sets])
    ally = n.concatenate([s[1] for s in sets])
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    fx, fy = allx[n.isfinite(allx)], ally[n.isfinite(ally)]
    xr = [float(fx.min()), float(fx.max())] if fx.size else [0, 1]
    yr = [float(fy.min()), float(fy.max())] if fy.size else [0, 1]
    if log:
        pos = fy[fy > 0]
        lo, hi = (float(pos.min()), float(pos.max())) if pos.size else (0.1, 10.0)
        k = (hi / lo) ** 0.05 if hi > lo else 2.0
        yr = [lo / k, hi * k]
    elif not allflag:
        yr = robust_range(ally)
        if yr[0] > 0 and (yr[0] < 0.35 * yr[1] or stems or has_fill):
            yr[0] = 0.0
        if yr[1] < 0 and (stems or has_fill):
            yr[1] = 0.0
    else:
        pad = (yr[1] - yr[0]) * 0.05 or 1
        yr = [yr[0] - pad, yr[1] + pad]
    padx = (xr[1] - xr[0]) * 0.03 or 0.5
    xr = [xr[0] - padx, xr[1] + padx]
    if xr[0] > 0 and xr[0] < 0.2 * xr[1]:
        xr[0] = 0.0
    if pr[0] is not None:
        xr = pr[0]
    if pr[1] is not None and not (log and pr[1][0] <= 0):
        yr = pr[1]
    leg = legend_prim(options, [String("%d" % (i + 1)) for i in range(len(sets))], styles, ev,
                      kind=None if joined else "point")
    if leg:
        prims.append(leg)
    defaults = {"AspectRatio": E("Power", S("GoldenRatio"), Integer(-1)), "Axes": SymbolTrue,
                "PlotRange": rng_expr([xr, yr])}
    if log:
        defaults["WLX`LogY"] = SymbolTrue
    return G2(prims, gopts(options, defaults))


# ---------------------------------------------------- Parametric / Polar
def _curve_list(he):
    """{fx, fy} or {{fx, fy}, ...} -> list of 2-element lists (None if malformed)."""
    if not (isinstance(he, Expression) and he.has_form("List", None)) or not he.elements:
        return None
    return [he] if not he.elements[0].has_form("List", None) else list(he.elements)


def close_gaps(n, xs, ys, lim):
    """Break a parametric polyline where consecutive points are absurdly far apart (poles)."""
    d = n.hypot(n.diff(xs), n.diff(ys))
    fin = n.isfinite(d)
    if not fin.any():
        return xs, ys
    cut = n.nonzero(fin & (d > lim))[0]
    if cut.size == 0:
        return xs, ys
    return n.insert(xs, cut + 1, n.nan), n.insert(ys, cut + 1, n.nan)


def unthrough(e):
    """Through[{f, g}[x]] left unevaluated -> {f[x], g[x]}."""
    if isinstance(e, Expression) and e.get_head_name() == "System`Through" and len(e.elements) == 1:
        inner = e.elements[0]
        if isinstance(inner, Expression) and isinstance(inner.get_head(), Expression) and \
                inner.get_head().has_form("List", None):
            return L(*[Expression(h, *inner.elements) for h in inner.get_head().elements])
    return e


def pair_fns(ex, ey, vars, ev):
    """Samplers for a coordinate pair. {Re[w], Im[w]} is sampled once as a complex function (half the work when
    w can only be evaluated point by point)."""
    n = np()
    if isinstance(ex, Expression) and isinstance(ey, Expression) and ex.get_head_name() == "System`Re" and \
            ey.get_head_name() == "System`Im" and len(ex.elements) == 1 and len(ey.elements) == 1 and \
            ex.elements[0].sameQ(ey.elements[0]):
        fc = make_cfn(ex.elements[0], vars, ev)
        cache = {}

        def both(*arrs):
            key = tuple(id(a) for a in arrs)
            if key not in cache:
                cache.clear()
                cache[key] = (fc(*arrs), arrs)       # keep arrs alive so ids stay unique
            return cache[key][0]

        def fx(*arrs):
            return n.real(both(*arrs)).astype(float)

        def fy(*arrs):
            return n.imag(both(*arrs)).astype(float)
        fx.slow = fy.slow = fc.slow
        fx.cost = fy.cost = fc.cost / 2
        return fx, fy
    return make_fn(ex, vars, ev), make_fn(ey, vars, ev)


class ParametricPlot(GB):
    def eval(self, f, t, a, b, evaluation, options):
        "ParametricPlot[f_, {t_Symbol, a_, b_}, OptionsPattern[ParametricPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
        if a_v is None or b_v is None:
            return None
        he = unthrough(strip_wrappers(hold_eval(strip_wrappers(f), [t], ev)))
        curves = _curve_list(he)
        if curves is None:
            return None
        styles = styles_for(options, len(curves), ev)
        prims, allx, ally = [], [], []
        for i, cv in enumerate(curves):
            cv = unthrough(cv)
            if not cv.has_form("List", 2):
                return None
            fx, fy = pair_fns(cv.elements[0], cv.elements[1], [t], ev)
            npts = min(budget(fx, 800, 140, seconds=0.6), budget(fy, 800, 140, seconds=0.6))
            ts = n.linspace(a_v, b_v, npts)
            xs, ys = fx(ts), fy(ts)
            allx.append(xs)
            ally.append(ys)
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update(styles[i])
            prims.append(p)
        return finish_xy(prims, allx, ally, options, ev, curves, styles, robust=True)

    def eval_region(self, f, u, a, b, v, c, d, evaluation, options):
        "ParametricPlot[f_, {u_Symbol, a_, b_}, {v_Symbol, c_, d_}, OptionsPattern[ParametricPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        he = unthrough(strip_wrappers(hold_eval(strip_wrappers(f), [u, v], ev)))
        if not (isinstance(he, Expression) and he.has_form("List", 2)):
            return None
        fx, fy = pair_fns(he.elements[0], he.elements[1], [u, v], ev)
        slow = fx.slow or fy.slow
        ps = opt(options, "PlotStyle")
        nofill = ps is not None and is_sym(ps, "None")
        st = styles_for(options, 1, ev)[0]
        prims, allx, ally = [], [], []
        nm = 15                                   # mesh lines per direction (as Mathematica)
        m = 13 if slow else 121
        us, vs = n.linspace(a_v, b_v, m), n.linspace(c_v, d_v, m)
        if slow:
            U, V = n.meshgrid(us, vs)
            X, Y = fx(U, V), fy(U, V)
            rows = [(X[k, :], Y[k, :]) for k in range(m)] + [(X[:, k], Y[:, k]) for k in range(m)]
            border = [(X[0, :], Y[0, :]), (X[:, -1], Y[:, -1]), (X[-1, ::-1], Y[-1, ::-1]), (X[::-1, 0], Y[::-1, 0])]
        else:
            rows = []
            for k in range(nm + 2):
                vv = c_v + (d_v - c_v) * k / (nm + 1)
                rows.append((fx(us, n.full_like(us, vv)), fy(us, n.full_like(us, vv))))
            for k in range(nm + 2):
                uu = a_v + (b_v - a_v) * k / (nm + 1)
                rows.append((fx(n.full_like(vs, uu), vs), fy(n.full_like(vs, uu), vs)))
            lo_v, hi_v, lo_u, hi_u = rows[0], rows[nm + 1], rows[nm + 2], rows[2 * nm + 3]
            border = [lo_v, hi_u, (hi_v[0][::-1], hi_v[1][::-1]), (lo_u[0][::-1], lo_u[1][::-1])]
        if not nofill:
            bx = n.concatenate([b_[0] for b_ in border])
            by = n.concatenate([b_[1] for b_ in border])
            ok = n.isfinite(bx) & n.isfinite(by)
            if ok.sum() > 3:
                prims.append({"t": "poly", "x": nlist(bx[ok]), "y": nlist(by[ok]), "color": st["color"],
                              "opacity": st.get("opacity", 0.3), "edge": None})
        mesh_col = "#444444" if nofill else st["color"]
        edge = (0, nm + 1, nm + 2, 2 * nm + 3) if not slow else (0, m - 1, m, 2 * m - 1)
        for k, (rx, ry) in enumerate(rows):
            is_edge = k in edge
            prims.append({"t": "line", "x": nlist(rx), "y": nlist(ry), "color": mesh_col,
                          "width": 1.2 if is_edge else 0.6, "opacity": 1.0 if is_edge else 0.55, "nohover": not is_edge})
            allx.append(rx)
            ally.append(ry)
        fr = opt(options, "Frame")
        noframe = fr is SymbolFalse or (fr is not None and is_sym(fr, "None"))
        return finish_xy(prims, allx, ally, options, ev, [he], [st],
                         extra={"Frame": SymbolTrue, "Axes": SymbolTrue if noframe else SymbolFalse})


def finish_xy(prims, allx, ally, options, ev, exprs, styles, aspect="Automatic", extra=None, robust=False):
    n = np()
    X, Y = n.concatenate(allx), n.concatenate(ally)
    pr, allflag = parse_range(opt(options, "PlotRange"), ev)
    rngs = []
    for A in (X, Y):
        fa = A[n.isfinite(A)]
        if fa.size == 0:
            rngs.append([-1.0, 1.0])
            continue
        if robust and not allflag:
            r = robust_range(fa)
        else:
            r = [float(fa.min()), float(fa.max())]
            pad = (r[1] - r[0]) * 0.04
            if pad == 0:
                pad = abs(r[0]) * 0.1 or 1.0
            r = [r[0] - pad, r[1] + pad]
        rngs.append(r)
    xr, yr = rngs
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
        if a_v is None or b_v is None:
            return None
        exprs, was_list, orig = held_list(f, [t], ev)
        styles = styles_for(options, len(exprs), ev)
        prims, allx, ally = [], [], []
        for i, ex in enumerate(exprs):
            fn = make_fn(ex, [t], ev, raw=raw_of(orig, exprs, i))
            turns = max(1.0, abs(b_v - a_v) / (2 * math.pi))
            ts = n.linspace(a_v, b_v, budget(fn, int(min(4000, 500 + 400 * turns)), 150))
            r = fn(ts)
            xs, ys = r * n.cos(ts), r * n.sin(ts)
            allx.append(xs)
            ally.append(ys)
            p = {"t": "line", "x": nlist(xs), "y": nlist(ys)}
            p.update(styles[i])
            prims.append(p)
        return finish_xy(prims, allx, ally, options, ev, orig, styles, robust=True)


# ------------------------------------------- Contour / Density / Region
def grid_xy(a, b, c, d, m, my=None):
    n = np()
    xs, ys = n.linspace(a, b, m), n.linspace(c, d, my or m)
    X, Y = n.meshgrid(xs, ys)
    return X, Y


def field_prim(Z, a, b, c, d, digits=4, **kw):
    p = {"t": "field", "x0": a, "x1": b, "y0": c, "y1": d, "nx": int(Z.shape[1]), "ny": int(Z.shape[0]),
         "data": nlist(Z, digits)}
    p.update(kw)
    return p


_MS_CASES = {1: [(3, 0)], 2: [(0, 1)], 3: [(3, 1)], 4: [(1, 2)], 6: [(0, 2)], 7: [(3, 2)], 8: [(3, 2)], 9: [(0, 2)],
             11: [(1, 2)], 12: [(3, 1)], 13: [(0, 1)], 14: [(3, 0)]}


def implicit_lines(F, a, b, c, d, level=0.0, reject_poles=True):
    """Marching squares on grid F[j, i] (rows = y). Returns list of (xs, ys) polylines in data coordinates."""
    n = np()
    ny, nx = F.shape
    G = F - level
    fin = n.isfinite(G)
    S_ = (G > 0)
    ok = fin[:-1, :-1] & fin[:-1, 1:] & fin[1:, 1:] & fin[1:, :-1]
    case = (S_[:-1, :-1] * 1 + S_[:-1, 1:] * 2 + S_[1:, 1:] * 4 + S_[1:, :-1] * 8)
    case = n.where(ok, case, 0)
    jj, ii = n.nonzero((case > 0) & (case < 15))
    if jj.size == 0:
        return []
    cs = case[jj, ii]
    # edge ids: horizontal edge (j,i)-(j,i+1) -> j*nx+i ; vertical edge (j,i)-(j+1,i) -> nx*ny + j*nx+i
    eid = [jj * nx + ii, nx * ny + jj * nx + ii + 1, (jj + 1) * nx + ii, nx * ny + jj * nx + ii]   # bottom,right,top,left
    segs_a, segs_b = [], []
    for cval, pairs_ in _MS_CASES.items():
        m = cs == cval
        if m.any():
            for e0, e1 in pairs_:
                segs_a.append(eid[e0][m])
                segs_b.append(eid[e1][m])
    for cval in (5, 10):
        m = cs == cval
        if m.any():
            ctr = (G[jj[m], ii[m]] + G[jj[m], ii[m] + 1] + G[jj[m] + 1, ii[m] + 1] + G[jj[m] + 1, ii[m]]) / 4 > 0
            first = ctr if cval == 5 else ~ctr
            for sel, prs in ((first, [(3, 2), (0, 1)]), (~first, [(3, 0), (1, 2)])):
                for e0, e1 in prs:
                    segs_a.append(eid[e0][m][sel])
                    segs_b.append(eid[e1][m][sel])
    A, B = n.concatenate(segs_a), n.concatenate(segs_b)
    # coordinates of every used edge crossing
    used = n.unique(n.concatenate([A, B]))
    hor = used < nx * ny
    j0 = n.where(hor, used // nx, (used - nx * ny) // nx)
    i0 = n.where(hor, used % nx, (used - nx * ny) % nx)
    j1 = n.where(hor, j0, j0 + 1)
    i1 = n.where(hor, i0 + 1, i0)
    va, vb = G[j0, i0], G[j1, i1]
    with n.errstate(all="ignore"):
        t = va / (va - vb)
    t = n.where(n.isfinite(t), n.clip(t, 0.0, 1.0), 0.5)
    dx, dy = (b - a) / (nx - 1), (d - c) / (ny - 1)
    px = a + (i0 + (i1 - i0) * t) * dx
    py = c + (j0 + (j1 - j0) * t) * dy
    if reject_poles and used.size > 8:
        jump = n.abs(va - vb)
        med = float(n.median(jump))
        if med > 0:
            badc = jump > 400 * med
            if badc.any() and badc.sum() < 0.5 * used.size:
                bad_ids = set(used[badc].tolist())
                keep = n.array([(x_ not in bad_ids) and (y_ not in bad_ids) for x_, y_ in zip(A.tolist(), B.tolist())])
                A, B = A[keep], B[keep]
    pos = {int(e_): k for k, e_ in enumerate(used.tolist())}
    adj = {}
    Al, Bl = A.tolist(), B.tolist()
    for k in range(len(Al)):
        adj.setdefault(Al[k], []).append(k)
        adj.setdefault(Bl[k], []).append(k)
    done = [False] * len(Al)
    lines = []

    def walk(start, k):
        ids = [start]
        cur = start
        while k is not None and not done[k]:
            done[k] = True
            cur = Bl[k] if Al[k] == cur else Al[k]
            ids.append(cur)
            k = None
            for q in adj[cur]:
                if not done[q]:
                    k = q
                    break
        return ids
    for e_, ks in adj.items():
        if len(ks) == 1 and not done[ks[0]]:
            lines.append(walk(e_, ks[0]))
    for k in range(len(Al)):
        if not done[k]:
            lines.append(walk(Al[k], k))
    out = []
    for ids in lines:
        idx = n.array([pos[i_] for i_ in ids])
        out.append((px[idx], py[idx]))
    return out


def lines_to_prim(lines, st, digits=4):
    """Several polylines -> one line prim (null-separated)."""
    xs, ys = [], []
    for lx, ly in lines:
        if xs:
            xs.append(None)
            ys.append(None)
        xs.extend(nlist(lx, digits))
        ys.extend(nlist(ly, digits))
    p = {"t": "line", "x": xs, "y": ys}
    p.update(st)
    return p


def contour_opts(options, ev):
    cont = opt(options, "Contours")
    levels, nlev = None, None
    if cont is not None and not is_sym(cont, "Automatic"):
        cv = cont.evaluate(ev)
        if cv.has_form("List", None):
            levels = sorted(v for v in (num(x_, ev) for x_ in cv.elements) if v is not None)
        elif num(cv, ev) is not None:
            nlev = int(num(cv, ev))
    return levels, nlev


def apply_region(options, X, Y, Z, ev):
    rf = opt(options, "RegionFunction")
    if rf is None or is_sym(rf, "Automatic"):
        return Z
    try:
        n = np()
        return n.where(region_mask(rf, X, Y, Z, ev) > 0, Z, n.nan)
    except ext_Deadline():
        raise
    except Exception:
        return Z


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
            pp = num(opt(options, "PlotPoints"), ev)
            for i, e in enumerate(exprs):
                if e.get_head_name() != "System`Equal" or len(e.elements) != 2:
                    continue
                fn = make_fn(diff_expr(e.elements[0], e.elements[1]), [x, y], ev)
                m = int(max(10, min(40, math.sqrt(budget(fn, 1600, 1600, 100, seconds=1.2 / len(exprs))))))
                if not fn.slow:
                    m = 301 if len(exprs) <= 6 else 241
                    if pp:
                        m = int(max(m, min(601, pp * 8)))
                X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
                lines = implicit_lines(fn(X, Y), a_v, b_v, c_v, d_v)
                st = dict(styles[i])
                if lines:
                    prims.append(lines_to_prim(lines, st))
            leg = legend_prim(options, orig, styles, ev)
            if leg:
                prims.append(leg)
        else:
            fn = make_fn(exprs[0], [x, y], ev, raw=raw_of(orig, exprs, 0))
            m = int(max(8, min(26, math.sqrt(budget(fn, 676, 676, 64))))) if fn.slow else 91
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            Z = apply_region(options, X, Y, fn(X, Y), ev)
            levels, nlev = contour_opts(options, ev)
            sh = opt(options, "ContourShading")
            shading = not (sh is not None and (sh is SymbolFalse or is_sym(sh, "None")))
            kw = {"mode": "contour", "shading": shading}
            if levels is not None:
                kw["levels"] = levels
            if nlev:
                kw["nlev"] = nlev
            if cf_name(options):
                kw["cf"] = cf_name(options)
            cs = opt(options, "ContourStyle")
            if cs is not None and (is_sym(cs, "None") or cs is SymbolFalse):
                kw["lines"] = False
            elif cs is not None and not is_sym(cs, "Automatic"):
                st = {}
                apply_directive(st, cs.evaluate(ev), ev)
                if "color" in st:
                    kw["lineColor"] = st["color"]
                if "width" in st:
                    kw["lineWidth"] = st["width"]
            prims.append(field_prim(Z, a_v, b_v, c_v, d_v, **kw))
            bl = bar_legend(options, cf_name(options))
            if bl:
                prims.append(bl)
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


def cf_name(options):
    cf = opt(options, "ColorFunction")
    if isinstance(cf, String):
        return cf.value
    if cf is not None and is_sym(cf, "Hue"):
        return "Hue"
    if cf is not None and is_sym(cf, "GrayLevel"):
        return "GrayLevel"
    if isinstance(cf, Expression) and cf.get_head_name() == "System`ColorData" and cf.elements \
            and isinstance(cf.elements[0], String):
        return cf.elements[0].value
    return None


class DensityPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "DensityPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[DensityPlot]]"
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        raw = strip_wrappers(f)
        he = hold_eval(raw, [x, y], ev)
        fn = make_fn(he, [x, y], ev, raw=raw)
        m = int(max(8, min(26, math.sqrt(budget(fn, 676, 676, 64))))) if fn.slow else 101
        X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
        kw = {"mode": "density"}
        if cf_name(options):
            kw["cf"] = cf_name(options)
        prims = [field_prim(apply_region(options, X, Y, fn(X, Y), ev), a_v, b_v, c_v, d_v, **kw)]
        bl = bar_legend(options, cf_name(options))
        if bl:
            prims.append(bl)
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


class RegionPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "RegionPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[RegionPlot]]"
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        exprs, was_list, orig = held_list(f, [x, y], ev)
        styles = styles_for(options, len(exprs), ev)
        bs = opt(options, "BoundaryStyle")
        no_bd = bs is not None and (is_sym(bs, "None") or bs is SymbolFalse)
        bst = {}
        if bs is not None and not no_bd and not is_sym(bs, "Automatic"):
            apply_directive(bst, bs.evaluate(ev), ev)
        prims = []
        for i, e in enumerate(exprs):
            fn = make_cond_fn(e, [x, y], ev)
            st = styles[i]
            if fn.slow:
                X, Y = grid_xy(a_v, b_v, c_v, d_v, 30)
                prims.append(field_prim(fn(X, Y), a_v, b_v, c_v, d_v, 2, mode="region", color=st["color"],
                                        opacity=st.get("opacity", 0.4), boundary=not no_bd))
                continue
            m = 321
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            Fh = fn(X, Y)
            prims.append(field_prim(Fh[::2, ::2], a_v, b_v, c_v, d_v, 2, mode="region", color=st["color"],
                                    opacity=st.get("opacity", 0.4), boundary=False))
            if not no_bd:
                lines = implicit_lines(Fh, a_v, b_v, c_v, d_v, reject_poles=False)
                if lines:
                    col = bst.get("color") or darker_hex(st["color"], 0.3)
                    prims.append(lines_to_prim(lines, {"color": col, "width": bst.get("width", 1.2),
                                                       "nohover": True}))
        leg = legend_prim(options, orig, [dict(s_, opacity=s_.get("opacity", 0.4)) for s_ in styles], ev, kind="swatch")
        if leg:
            prims.append(leg)
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


def darker_hex(h, f=0.3):
    try:
        r, g, b = [int(h[i:i + 2], 16) for i in (1, 3, 5)]
        return "#%02x%02x%02x" % (int(r * (1 - f)), int(g * (1 - f)), int(b * (1 - f)))
    except Exception:
        return h


# ----------------------------------------------------- Vector / Stream
class VectorPlot(GB):
    def eval(self, f, x, a, b, y, c, d, evaluation, options):
        "VectorPlot[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, OptionsPattern[VectorPlot]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        he = hold_eval(strip_wrappers(f), [x, y], ev)
        if not (isinstance(he, Expression) and he.has_form("List", 2)):
            return None
        fu, fv = make_fn(he.elements[0], [x, y], ev), make_fn(he.elements[1], [x, y], ev)
        vp = num(opt(options, "VectorPoints"), ev)
        m = int(vp) if vp else 15
        m = max(4, min(m, 30))
        if fu.slow or fv.slow:
            m = min(m, 10)
        xs = n.linspace(a_v, b_v, m + 2)[1:-1]
        ys = n.linspace(c_v, d_v, m + 2)[1:-1]
        X, Y = n.meshgrid(xs, ys)
        U, V = fu(X, Y), fv(X, Y)
        mag = n.sqrt(U ** 2 + V ** 2)
        okm = mag[n.isfinite(mag)]
        mx = float(n.percentile(okm, 98)) if okm.size else 1.0
        mx = mx or 1.0
        vs = opt(options, "VectorScale")
        uniform = vs is not None and vs.has_form("List", 3) and is_sym(vs.elements[2], "None")
        sx, sy = (b_v - a_v) / (m + 1), (d_v - c_v) / (m + 1)
        segs, mags = [], []
        for i in range(m):
            for j in range(m):
                u, v, g = float(U[i, j]), float(V[i, j]), float(mag[i, j])
                if not (math.isfinite(u) and math.isfinite(v)) or g == 0:
                    continue
                rel = min(1.0, g / mx)
                k = 0.82 if uniform else (0.34 + 0.62 * rel)
                # normalise in screen-like units (per-axis cell size)
                ux, vy = u / g, v / g
                nrm = math.hypot(ux / sx, vy / sy) or 1.0
                dx, dy = ux / nrm * k * 0.5, vy / nrm * k * 0.5
                segs.append([float(X[i, j] - dx), float(Y[i, j] - dy), float(X[i, j] + dx), float(Y[i, j] + dy)])
                mags.append(rel)
        st = {}
        s_opt = opt(options, "VectorStyle")
        if s_opt is not None and not is_sym(s_opt, "Automatic"):
            apply_directive(st, s_opt.evaluate(ev), ev)
        vcf = opt(options, "VectorColorFunction")
        if "color" not in st and vcf is not None and is_sym(vcf, "None"):
            st["color"] = PALETTE[0]
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
        if None in (a_v, b_v, c_v, d_v):
            return None
        he = hold_eval(strip_wrappers(f), [x, y], ev)
        if not (isinstance(he, Expression) and he.has_form("List", 2)):
            return None
        fu, fv = make_fn(he.elements[0], [x, y], ev), make_fn(he.elements[1], [x, y], ev)
        slow = fu.slow or fv.slow
        w, h = (b_v - a_v), (d_v - c_v)
        m = 7 if slow else 14
        steps = 24 if slow else 110
        hstep = 1.0 / 130          # in unit-square coordinates
        gx = (n.arange(m) + 0.5) / m
        # jittered seeds (deterministic) in the unit square
        SX, SY = n.meshgrid(gx, gx)
        SX = SX.ravel() + 0.21 / m * n.sin(n.arange(m * m) * 2.4)
        SY = SY.ravel() + 0.21 / m * n.cos(n.arange(m * m) * 1.7)

        def direction(PX, PY):
            U, V = fu(a_v + PX * w, c_v + PY * h), fv(a_v + PX * w, c_v + PY * h)
            U, V = U / w, V / h
            g = n.sqrt(U * U + V * V)
            g = n.where((g == 0) | ~n.isfinite(g), n.nan, g)
            return U / g, V / g

        trails = []
        for sgn in (1.0, -1.0):
            PX, PY = SX.copy(), SY.copy()
            tx, ty = [PX.copy()], [PY.copy()]
            for _ in range(steps):
                k1x, k1y = direction(PX, PY)
                k2x, k2y = direction(PX + sgn * hstep / 2 * k1x, PY + sgn * hstep / 2 * k1y)
                PX = PX + sgn * hstep * k2x
                PY = PY + sgn * hstep * k2y
                out = (PX < 0) | (PX > 1) | (PY < 0) | (PY > 1)
                PX = n.where(out, n.nan, PX)
                PY = n.where(out, n.nan, PY)
                tx.append(PX.copy())
                ty.append(PY.copy())
            trails.append((n.array(tx), n.array(ty)))
        (FX, FY), (BX, BY) = trails
        # evenly spaced selection: a line stops when it enters a cell already used by another line
        NG = 26
        occ = {}
        order = sorted(range(SX.size), key=lambda k: (abs(SX[k] - 0.5) + abs(SY[k] - 0.5)))
        st = {}
        s_opt = opt(options, "StreamStyle")
        if s_opt is not None and not is_sym(s_opt, "Automatic"):
            apply_directive(st, s_opt.evaluate(ev), ev)
        col = st.get("color", PALETTE[0])
        prims = []
        for k in order:
            c0 = (int(SX[k] * NG), int(SY[k] * NG))
            if c0 in occ:
                continue
            halves = []
            mine = set()
            for TX, TY in ((FX, FY), (BX, BY)):
                px, py = TX[:, k].tolist(), TY[:, k].tolist()
                keep = 0
                for q in range(len(px)):
                    if px[q] != px[q] or py[q] != py[q]:
                        break
                    cell = (min(NG - 1, int(px[q] * NG)), min(NG - 1, int(py[q] * NG)))
                    if cell in occ and occ[cell] != k:
                        break
                    mine.add(cell)
                    keep = q + 1
                halves.append((px[:keep], py[:keep]))
            (fxs, fys), (bxs, bys) = halves
            lx = bxs[::-1] + fxs[1:]
            ly = bys[::-1] + fys[1:]
            if len(lx) < 12:
                continue
            for cell in mine:
                occ[cell] = k
            lx = a_v + n.array(lx) * w
            ly = c_v + n.array(ly) * h
            prims.append({"t": "line", "x": nlist(lx, 4), "y": nlist(ly, 4), "color": col,
                          "width": st.get("width", 1.1), "arrow": "mid", "opacity": 0.9})
        defaults = {"AspectRatio": Integer(1), "Frame": SymbolTrue, "Axes": SymbolFalse,
                    "PlotRange": rng_expr([[a_v, b_v], [c_v, d_v]])}
        return G2(prims, gopts(options, defaults))


# ---------------------------------------------------------------------- 3D
def mesh_spec(options, ev, default=True):
    """Mesh option -> True (default 15 lines) | False | n | [nu, nv]."""
    m = opt(options, "Mesh")
    if m is None or is_sym(m, "Automatic"):
        return default
    if is_sym(m, "None") or m is SymbolFalse:
        return False
    if isinstance(m, Symbol) and short(m) in ("All", "Full"):
        return True
    v = num(m, ev)
    if v is not None:
        return int(max(0, v))
    if m.has_form("List", 2):
        a, b = num(m.elements[0], ev), num(m.elements[1], ev)
        if a is not None and b is not None:
            return [int(a), int(b)]
    return default


def surf_prim(X, Y, Z, st=None, idx=0, mesh=True, mask=None, cf=None, cv=None, bd=False):
    p = {"t": "surf", "nx": int(X.shape[1]), "ny": int(X.shape[0]), "x": nlist(X, 4), "y": nlist(Y, 4),
         "z": nlist(Z, 4), "mesh": mesh, "ci": idx}
    if bd:
        p["bd"] = True
    if mask is not None:
        p["m"] = nlist(mask, 2)
    if cf:
        p["cf"] = cf
        if cv is not None:
            p["cv"] = nlist(cv, 2)
    if st:
        if st.get("explicit"):
            p["color"] = st.get("color")
        if "opacity" in st:
            p["opacity"] = st["opacity"]
    return p


def styles3(options, k, ev, key="PlotStyle"):
    ps = opt(options, key)
    base = [{"color": None} for _ in range(k)]
    if ps is None or is_sym(ps, "Automatic") or is_sym(ps, "None"):
        return base
    ps = ps.evaluate(ev)
    items = list(ps.elements) if ps.has_form("List", None) and k > 1 else [ps]
    if not items:
        return base
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
    return robust_range(v)


def rules3(options, defaults):
    return gopts(options, defaults)


def color_field(options, vars3, X, Y, Z, ev):
    """ColorFunction for surfaces -> (name, per-vertex scalar in [0,1] or None)."""
    n = np()
    cf = opt(options, "ColorFunction")
    if cf is None or is_sym(cf, "Automatic") or is_sym(cf, "None"):
        return None, None
    name = cf_name(options)
    if name:
        return name, None                      # renderer uses scaled z
    scaled = opt(options, "ColorFunctionScaling") is not SymbolFalse
    try:
        sx, sy, sz = Symbol("WLX`cx"), Symbol("WLX`cy"), Symbol("WLX`cz")
        body = E(cf, sx, sy, sz).evaluate(ev)
        nm = None
        if isinstance(body, Expression) and body.get_head_name() in ("System`Hue", "System`GrayLevel") and body.elements:
            nm, arg = short(body.get_head()), body.elements[0]
        elif isinstance(body, Expression) and isinstance(body.get_head(), Expression) and \
                body.get_head().get_head_name() == "System`ColorData" and body.elements:
            h = body.get_head().elements[0]
            nm, arg = (h.value if isinstance(h, String) else "def"), body.elements[0]
        if nm is None:
            return None, None
        fn = make_fn(arg, [sx, sy, sz], ev)
        if fn.slow:
            return None, None

        def sc(A):
            if not scaled:
                return A
            f = A[n.isfinite(A)]
            if f.size == 0 or f.max() == f.min():
                return n.zeros_like(A)
            return (A - f.min()) / (f.max() - f.min())
        cv = fn(sc(X), sc(Y), sc(Z))
        if nm == "Hue":
            cv = n.mod(cv, 1.0)
        return nm, n.clip(n.nan_to_num(cv), 0.0, 1.0)
    except ext_Deadline():
        raise
    except Exception:
        return None, None


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
        mesh = mesh_spec(options, ev)
        pp = num(opt(options, "PlotPoints"), ev)
        for i, e in enumerate(exprs):
            fn = make_fn(e, [x, y], ev, raw=raw_of(orig, exprs, i))
            if fn.slow:
                m = int(max(6, min(18, math.sqrt(budget(fn, 324, 324, 36, seconds=1.5 / len(exprs))))))
            else:
                m = int(pp) if pp else 51
                m = max(8, min(m, 90))
            X, Y = grid_xy(a_v, b_v, c_v, d_v, m)
            Z = fn(X, Y)
            if not fn.slow:
                X, Y, Z = snap_domain(fn, X, Y, Z)
            mask = None
            if rf is not None and not is_sym(rf, "Automatic"):
                try:
                    mask = region_mask(rf, X, Y, Z, ev)
                    # normalise so that interpolation to zero gives a smooth cut
                    sc_ = float(n.nanmax(n.abs(mask))) or 1.0
                    mask = n.clip(mask / sc_, -1, 1)
                except ext_Deadline():
                    raise
                except Exception:
                    mask = None
            cf, cv = color_field(options, None, X, Y, Z, ev)
            prims.append(surf_prim(X, Y, Z, sts[i], i, mesh, mask=mask, cf=cf, cv=cv, bd=True))
            allz.append((Z if mask is None else n.where(mask > 0, Z, n.nan)).ravel())
        pr, allflag = parse_range(opt(options, "PlotRange"), ev, 3)
        cat = n.concatenate(allz)
        if allflag:
            fin = cat[n.isfinite(cat)]
            zr = [float(fin.min()), float(fin.max())] if fin.size else [-1, 1]
            if zr[1] - zr[0] < 1e-12:
                zr = [zr[0] - 1, zr[1] + 1]
        else:
            zr = range3(cat, pr[2])
        defaults = {"PlotRange": rng_expr([pr[0] or [a_v, b_v], pr[1] or [c_v, d_v], zr]),
                    "BoxRatios": L(Integer(1), Integer(1), Real(0.4)), "Axes": SymbolTrue}
        return G3(prims, rules3(options, defaults))


def snap_domain(fn, X, Y, Z, iters=12):
    """Move grid nodes where f is not real onto the boundary of the domain (smooth edge instead of a staircase)."""
    n = np()
    fin = n.isfinite(Z)
    if fin.all() or not fin.any():
        return X, Y, Z
    X0, Y0 = X, Y
    X, Y, Z = X.copy(), Y.copy(), Z.copy()
    ny, nx = Z.shape
    done = n.zeros_like(fin)
    for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        nb = n.zeros_like(fin)
        js = slice(max(0, -dj), ny - max(0, dj))
        is_ = slice(max(0, -di), nx - max(0, di))
        jn = slice(max(0, dj), ny - max(0, -dj))
        in_ = slice(max(0, di), nx - max(0, -di))
        nb[js, is_] = fin[jn, in_]
        sel = (~fin) & nb & (~done)
        if not sel.any():
            continue
        jj, ii = n.nonzero(sel)
        ax, ay = X0[jj + dj, ii + di], Y0[jj + dj, ii + di]
        bx, by = X0[jj, ii], Y0[jj, ii]
        lo, hi = n.zeros(jj.size), n.ones(jj.size)
        for _ in range(iters):
            mid = (lo + hi) / 2
            ok = n.isfinite(fn(ax + (bx - ax) * mid, ay + (by - ay) * mid))
            lo = n.where(ok, mid, lo)
            hi = n.where(ok, hi, mid)
        px, py = ax + (bx - ax) * lo, ay + (by - ay) * lo
        pz = fn(px, py)
        good = n.isfinite(pz)
        X[jj[good], ii[good]], Y[jj[good], ii[good]], Z[jj[good], ii[good]] = px[good], py[good], pz[good]
        done[jj[good], ii[good]] = True
    return X, Y, Z


def region_mask(rf, X, Y, Z, ev):
    """RegionFunction -> scalar field (> 0 inside)."""
    n = np()
    xs, ys, zs = Symbol("WLX`rx"), Symbol("WLX`ry"), Symbol("WLX`rz")
    body = E(rf, xs, ys, zs).evaluate(ev)
    fn = make_cond_fn(body, [xs, ys, zs], ev)
    return fn(X, Y, n.where(n.isfinite(Z), Z, 0.0))


class ParametricPlot3D(GB):
    def eval_curve(self, f, t, a, b, evaluation, options):
        "ParametricPlot3D[f_, {t_Symbol, a_, b_}, OptionsPattern[ParametricPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v = num(a.evaluate(ev), ev), num(b.evaluate(ev), ev)
        if a_v is None or b_v is None:
            return None
        he = strip_wrappers(hold_eval(strip_wrappers(f), [t], ev))
        curves = _curve_list(he)
        if curves is None:
            return None
        sts = styles_for(options, len(curves), ev)
        prims, pts = [], []
        for i, cv in enumerate(curves):
            if not cv.has_form("List", 3):
                return None
            fs = [make_fn(c, [t], ev) for c in cv.elements]
            npts = min(budget(f_, 600, 120, seconds=0.4) for f_ in fs)
            ts = n.linspace(a_v, b_v, npts)
            P = [fn(ts) for fn in fs]
            p = {"t": "line3", "x": nlist(P[0], 4), "y": nlist(P[1], 4), "z": nlist(P[2], 4),
                 "color": sts[i]["color"], "width": sts[i].get("width", 2)}
            if "opacity" in sts[i]:
                p["opacity"] = sts[i]["opacity"]
            prims.append(p)
            pts.append(n.array(P))
        return finish3(prims, pts, options, ev)

    def eval_surface(self, f, u, a, b, v, c, d, evaluation, options):
        "ParametricPlot3D[f_, {u_Symbol, a_, b_}, {v_Symbol, c_, d_}, OptionsPattern[ParametricPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        he = strip_wrappers(hold_eval(strip_wrappers(f), [u, v], ev))
        surfs = _curve_list(he)
        if surfs is None:
            return None
        sts = styles3(options, len(surfs), ev)
        mesh = mesh_spec(options, ev)
        pp = num(opt(options, "PlotPoints"), ev)
        prims, pts = [], []
        for i, sf in enumerate(surfs):
            if not sf.has_form("List", 3):
                return None
            fs = [make_fn(c2, [u, v], ev) for c2 in sf.elements]
            if any(f_.slow for f_ in fs):
                m = 12
            else:
                m = max(8, min(int(pp) if pp else 46, 80))
            U, V = grid_xy(a_v, b_v, c_v, d_v, m)
            P = [fn(U, V) for fn in fs]
            cf, cv = color_field(options, None, P[0], P[1], P[2], ev)
            prims.append(surf_prim(P[0], P[1], P[2], sts[i], i, mesh, cf=cf, cv=cv, bd=True))
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
        if not allflag and v.size > 50:
            rr = robust_range(v)
            lo, hi = max(lo, rr[0]), min(hi, rr[1])
        if hi - lo < 1e-12:
            lo, hi = lo - 1, hi + 1
        rng.append([lo, hi])
    defaults = {"PlotRange": rng_expr(rng), "Axes": SymbolTrue}
    if box is not None:
        defaults["BoxRatios"] = box
    defaults.update(extra or {})
    return G3(prims, rules3(options, defaults))


def iso_prim(F, r, color=None, ci=0, opacity=None, mesh=False):
    p = {"t": "iso", "n": int(F.shape[0]), "r": [[float(a), float(b)] for a, b in r], "data": nlist(F, 3), "ci": ci}
    if color:
        p["color"] = color
    if opacity is not None:
        p["opacity"] = opacity
    if mesh:
        p["mesh"] = mesh
    return p


def grid3(r, m):
    n = np()
    ax = [n.linspace(lo, hi, m) for lo, hi in r]
    # index order [iz, iy, ix]
    Z, Y, X = n.meshgrid(ax[2], ax[1], ax[0], indexing="ij")
    return X, Y, Z


def box3(r):
    """Real proportions of a 3D range, tamed so that no side is thinner than 1/4 of the longest."""
    spans = [abs(hi - lo) or 1.0 for lo, hi in r]
    mx = max(spans)
    return L(*[Real(max(0.25, s / mx)) for s in spans])


class ContourPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "ContourPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[ContourPlot3D]]"
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        if any(v is None for rr in r for v in rr):
            return None
        exprs, was_list, orig = held_list(f, [x, y, z], ev)
        sts = styles3(options, len(exprs), ev)
        cs = opt(options, "ContourStyle")
        if cs is not None and not is_sym(cs, "Automatic"):
            sts = styles3(options, len(exprs), ev, "ContourStyle")
        mesh = mesh_spec(options, ev)
        if mesh is True:
            mesh = 5
        elif isinstance(mesh, list):
            mesh = mesh[0]
        pp = num(opt(options, "PlotPoints"), ev)
        prims = []
        k = 0
        for i, ex in enumerate(exprs):
            levels = [0.0]
            if ex.get_head_name() == "System`Equal" and len(ex.elements) == 2:
                ex = diff_expr(ex.elements[0], ex.elements[1])
            else:
                levels = None
                cont = opt(options, "Contours")
                if cont is not None and not is_sym(cont, "Automatic"):
                    cv = cont.evaluate(ev)
                    if cv.has_form("List", None):
                        levels = [v for v in (num(v_, ev) for v_ in cv.elements) if v is not None]
            fn = make_fn(ex, [x, y, z], ev)
            if fn.slow:
                m = int(max(6, min(11, budget(fn, 1331, 1331, 216) ** (1 / 3.0))))
            else:
                m = 30 if len(exprs) > 1 else 34
                if pp:
                    m = int(max(16, min(44, pp * 2)))
            X, Y, Z = grid3(r, m)
            F = fn(X, Y, Z)
            if levels is None:
                n = np()
                fin = F[n.isfinite(F)]
                if fin.size == 0:
                    continue
                lo_, hi_ = float(fin.min()), float(fin.max())
                levels = [lo_ + (hi_ - lo_) * q for q in (0.25, 0.5, 0.75)]
            for lv in levels:
                st = sts[i] if len(levels) == 1 else {}
                prims.append(iso_prim(F - lv, r, st.get("color") if st.get("explicit") else None,
                                      i if len(levels) == 1 else k, st.get("opacity", sts[i].get("opacity")), mesh))
                k += 1
        defaults = {"PlotRange": rng_expr(r), "Axes": SymbolTrue, "BoxRatios": L(Integer(1), Integer(1), Integer(1))}
        return G3(prims, rules3(options, defaults))


def _extrap(A):
    """Pad a 3D array by one layer on every side using linear extrapolation."""
    n = np()
    A = n.pad(A, 1, mode="edge")
    A[0], A[-1] = 2 * A[1] - A[2], 2 * A[-2] - A[-3]
    A[:, 0], A[:, -1] = 2 * A[:, 1] - A[:, 2], 2 * A[:, -2] - A[:, -3]
    A[:, :, 0], A[:, :, -1] = 2 * A[:, :, 1] - A[:, :, 2], 2 * A[:, :, -2] - A[:, :, -3]
    return A


def snet_mesh(F, axes, mask=None):
    """Surface nets (vectorised) for the level set F = 0 on a grid F[iz, iy, ix]: one vertex per cell crossed by
    the surface (mean of its edge crossings), one quad per sign-changing grid edge. The grid is extended one
    layer by extrapolation so the surface reaches (slightly past) the box; the renderer clips at the box.
    Returns (P[k,3], G[k,3] gradient of F, m[k] mask or None, tris[t,3]) or None."""
    n = np()
    F = _extrap(n.asarray(F, dtype=float))
    M = _extrap(n.asarray(mask, dtype=float)) if mask is not None else None
    ax = [n.concatenate([[2 * a[0] - a[1]], a, [2 * a[-1] - a[-2]]]) for a in axes]
    xs, ys, zs = ax
    nz, ny, nx = F.shape
    S = F > 0
    c = n.zeros((nz - 1, ny - 1, nx - 1), dtype=n.int8)
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                c += S[dz:nz - 1 + dz, dy:ny - 1 + dy, dx:nx - 1 + dx]
    active = (c > 0) & (c < 8)
    K = int(active.sum())
    if K == 0:
        return None
    cid = n.full(active.shape, -1, dtype=n.int64)
    cid[active] = n.arange(K)
    gz, gy, gx = n.gradient(F, zs, ys, xs)
    nf = 7 if M is not None else 6
    acc = n.zeros((K, nf))
    cnt = n.zeros(K)
    quads = []
    coords = (zs, ys, xs)
    for axis in (0, 1, 2):                       # edge direction: 0 = z, 1 = y, 2 = x  (array axes)
        sl_a = [slice(None)] * 3
        sl_b = [slice(None)] * 3
        sl_a[axis] = slice(0, -1)
        sl_b[axis] = slice(1, None)
        sl_a, sl_b = tuple(sl_a), tuple(sl_b)
        E = S[sl_a] != S[sl_b]
        idx = n.nonzero(E)
        if idx[0].size == 0:
            continue
        fa, fb = F[sl_a][E], F[sl_b][E]
        with n.errstate(all="ignore"):
            t = fa / (fa - fb)
        t = n.where(n.isfinite(t), n.clip(t, 0.0, 1.0), 0.5)
        pos = [coords[q][idx[q]].astype(float) for q in range(3)]
        ca = coords[axis]
        pos[axis] = ca[idx[axis]] + (ca[idx[axis] + 1] - ca[idx[axis]]) * t
        feats = [pos[2], pos[1], pos[0]]
        for g in (gx, gy, gz):
            ga, gb = g[sl_a][E], g[sl_b][E]
            feats.append(ga + (gb - ga) * t)
        if M is not None:
            ma, mb = M[sl_a][E], M[sl_b][E]
            feats.append(ma + (mb - ma) * t)
        feats = n.stack(feats, 1)
        # the four cells around this edge: offsets (0 or -1) along the two other axes
        o1, o2 = [q for q in range(3) if q != axis]
        ring = []
        for d1, d2 in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            ci = [idx[0].copy(), idx[1].copy(), idx[2].copy()]
            ci[o1] = ci[o1] + d1
            ci[o2] = ci[o2] + d2
            ok = (ci[o1] >= 0) & (ci[o2] >= 0) & (ci[o1] < active.shape[o1]) & (ci[o2] < active.shape[o2])
            ids = n.full(idx[0].shape, -1, dtype=n.int64)
            ids[ok] = cid[ci[0][ok], ci[1][ok], ci[2][ok]]
            good = ids >= 0
            n.add.at(acc, ids[good], feats[good])
            n.add.at(cnt, ids[good], 1.0)
            ring.append(ids)
        ring = n.stack(ring, 1)
        quads.append(ring[(ring >= 0).all(1)])
    if not quads:
        return None
    Q = n.concatenate(quads)
    if Q.shape[0] == 0:
        return None
    acc = acc / n.maximum(cnt, 1.0)[:, None]
    tris = n.concatenate([Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]])
    return acc[:, 0:3], acc[:, 3:6], (acc[:, 6] if M is not None else None), tris


def region_terms(expr, vars, ev):
    """Condition -> list of vectorised scalar fields, one per conjunct (region = all fields > 0), or None."""
    n = np()
    names = [v.get_name() for v in vars]
    for cand in _candidates(expr, vars, ev, None):
        try:
            c = PConv()
            s0 = c.to(cand)
            parts = list(s0.args) if isinstance(s0, (sp.And, sp.Or)) else [s0]
            union = isinstance(s0, sp.Or)
            if not parts or len(parts) > 8:
                return None
            fields = [cond_to_field(p_) for p_ in parts]
            syms = [c.sym(nm) for nm in names]
            if any(_bad_sympy(f_, syms) for f_ in fields):
                continue
            c.extra["WLXMin"] = lambda *a: _reduce(n.minimum, a)
            c.extra["WLXMax"] = lambda *a: _reduce(n.maximum, a)
            fs = [_lambdify(c, syms, f_) for f_ in fields]

            def make(f):
                def fn(*arrs):
                    shape = n.broadcast(*arrs).shape
                    with n.errstate(all="ignore"):
                        r = n.asarray(f(*[n.asarray(a, dtype=float) for a in arrs]))
                        if n.iscomplexobj(r):
                            r = n.where(n.abs(r.imag) > 1e-12, n.nan, r.real)
                        r = n.asarray(r, dtype=float)
                    if r.shape != shape:
                        r = n.broadcast_to(r, shape).copy()
                    return n.where(n.isfinite(r), r, -1.0)
                return fn
            fns = [make(f) for f in fs]
            for fn in fns:
                fn(*[n.array([0.3, 0.7]) for _ in vars])
            return fns, union
        except ext_Deadline():
            raise
        except Exception:
            continue
    return None


def region_solid(fns, r, m, st, ci, union=False):
    """Boundary of {all fields > 0} (or {any field > 0} if union) inside the box r as crisp prims: one masked
    iso-mesh per term (surface F_i = 0 where the other terms allow it) plus the six box faces masked by the region."""
    n = np()
    axes = [n.linspace(lo, hi, m) for lo, hi in r]
    X, Y, Z = grid3(r, m)
    Fs = [fn(X, Y, Z) for fn in fns]
    total = _reduce(n.maximum if union else n.minimum, Fs)
    prims = []
    color = st.get("color") if st.get("explicit") else None
    opacity = st.get("opacity")

    def style(p):
        if color:
            p["color"] = color
        if opacity is not None:
            p["opacity"] = opacity
        return p
    sig = nlist(total[::4, ::4, ::4], 2)          # coarse signature of the region (used when comparing plots)
    for i, F in enumerate(Fs):
        if not (F <= 0).any() or not (F > 0).any():
            continue                                # this condition does not cut the box
        others = [Fs[j] for j in range(len(Fs)) if j != i]
        mask = (-_reduce(n.maximum, others) if union else _reduce(n.minimum, others)) if others else None
        res = snet_mesh(F, axes, mask)
        if res is None:
            continue
        P, G, mk, tris = res
        if mk is not None:
            keep = (mk[tris] > 0).any(1)
            tris = tris[keep]
            if tris.shape[0] == 0:
                continue
            used, inv = n.unique(tris, return_inverse=True)
            tris = inv.reshape(-1, 3)
            P, G, mk = P[used], G[used], mk[used]
            sc = float(n.max(n.abs(mk))) or 1.0
            mk = mk / sc
        p = {"t": "iso", "n": 0, "r": [[float(a_), float(b_)] for a_, b_ in r], "data": sig, "ci": ci,
             "v": nlist(P, 3), "nrm": nlist(G / (n.linalg.norm(G, axis=1, keepdims=True) + 1e-300), 1),
             "i": tris.ravel().tolist()}
        sig = []
        if mk is not None:
            p["m"] = nlist(mk, 2)
        prims.append(style(p))
    # box faces
    scale = float(n.max(n.abs(total))) or 1.0
    for ax_ in range(3):                             # 0: x, 1: y, 2: z  (arrays are indexed [iz, iy, ix])
        for side in (0, -1):
            sl = [slice(None)] * 3
            sl[2 - ax_] = side
            sl = tuple(sl)
            live = [F[sl] for F in Fs if float(n.max(n.abs(F[sl]))) > 1e-9 * scale]
            if union:
                M = total[sl]
            else:
                M = _reduce(n.minimum, live) if live else n.ones_like(total[sl])
            if not (M > 0).any():
                continue
            p = surf_prim(X[sl], Y[sl], Z[sl], None, ci, False, mask=n.clip(M / (float(n.max(n.abs(M))) or 1.0), -1, 1))
            p["cap"] = True
            prims.append(style(p))
    if sig:
        # no curved boundary inside the box: keep the signature in an empty iso prim
        prims.append({"t": "iso", "n": 0, "r": [[float(a_), float(b_)] for a_, b_ in r], "data": sig, "ci": ci,
                      "v": [], "nrm": [], "i": []})
    return prims


class RegionPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "RegionPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[RegionPlot3D]]"
        n = np()
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        if any(v is None for rr in r for v in rr):
            return None
        exprs, was_list, orig = held_list(f, [x, y, z], ev)
        sts = styles3(options, len(exprs), ev)
        pp = num(opt(options, "PlotPoints"), ev)
        mesh = mesh_spec(options, ev, default=False)
        if mesh is True:
            mesh = 5
        elif isinstance(mesh, list):
            mesh = mesh[0]
        prims = []
        for i, ex in enumerate(exprs):
            rt = region_terms(ex, [x, y, z], ev)
            if rt is not None:
                fns, union = rt
                m = 30 if len(exprs) == 1 else 24
                if pp:
                    m = int(max(20, min(36, pp)))
                if len(fns) > 4:
                    m = min(m, 30)
                prims.extend(region_solid(fns, r, m, sts[i], i, union))
                continue
            fn = make_cond_fn(ex, [x, y, z], ev)
            if fn.slow:
                m = 10
            else:
                m = 36 if len(exprs) == 1 else 30
                if pp:
                    m = int(max(24, min(42, pp)))
            X, Y, Z = grid3(r, m)
            F = fn(X, Y, Z)
            # close the solid at the box faces: an extra outer layer just outside the box with negative values
            F2 = n.full((m + 2, m + 2, m + 2), -1.0)
            F2[1:-1, 1:-1, 1:-1] = F
            # pad = -|F| of the adjacent inner node: the cap then ends exactly where the surface F = 0 does
            F2[0, :, :] = -n.abs(F2[1, :, :]) - 1e-9
            F2[-1, :, :] = -n.abs(F2[-2, :, :]) - 1e-9
            F2[:, 0, :] = -n.abs(F2[:, 1, :]) - 1e-9
            F2[:, -1, :] = -n.abs(F2[:, -2, :]) - 1e-9
            F2[:, :, 0] = -n.abs(F2[:, :, 1]) - 1e-9
            F2[:, :, -1] = -n.abs(F2[:, :, -2]) - 1e-9
            h = [(hi - lo) / (m - 1) for lo, hi in r]
            r2 = [[lo - hh * 0.02, hi + hh * 0.02] for (lo, hi), hh in zip(r, h)]
            p = {"t": "iso", "n": m + 2, "r": [[float(a_), float(b_)] for a_, b_ in r2], "pad": True,
                 "inner": [[float(a_), float(b_)] for a_, b_ in r], "data": nlist(F2, 3), "ci": i}
            if sts[i].get("explicit"):
                p["color"] = sts[i].get("color")
            if sts[i].get("opacity") is not None:
                p["opacity"] = sts[i].get("opacity")
            if mesh:
                p["mesh"] = mesh
            prims.append(p)
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
        if None in (a_v, b_v, c_v, d_v):
            return None
        he = strip_wrappers(hold_eval(strip_wrappers(f), [t], ev))
        if isinstance(he, Expression) and he.has_form("List", 2):
            fr, fz = make_fn(he.elements[0], [t], ev), make_fn(he.elements[1], [t], ev)
            slow = fr.slow or fz.slow
        elif isinstance(he, Expression) and he.has_form("List", 1):
            fr, fz = (lambda tt: tt), make_fn(he.elements[0], [t], ev)
            slow = fz.slow
        else:
            fr, fz = (lambda tt: tt), make_fn(he, [t], ev, raw=strip_wrappers(f))
            slow = fz.slow
        m = 16 if slow else 46
        # sample the profile once per t (cheap even on the slow path), then revolve
        ts = n.linspace(a_v, b_v, m)
        ths = n.linspace(c_v, d_v, m)
        R1, Z1 = n.asarray(fr(ts), dtype=float), n.asarray(fz(ts), dtype=float)
        TH, _ = n.meshgrid(ths, ts)
        R, Zv = n.repeat(R1[:, None], m, axis=1), n.repeat(Z1[:, None], m, axis=1)
        X, Y = R * n.cos(TH), R * n.sin(TH)
        st = styles3(options, 1, ev)[0]
        cf, cv = color_field(options, None, X, Y, Zv, ev)
        return finish3([surf_prim(X, Y, Zv, st, 0, mesh_spec(options, ev), cf=cf, cv=cv, bd=True)],
                       [n.array([X.ravel(), Y.ravel(), Zv.ravel()])], options, ev)


class SphericalPlot3D(GB):
    def eval(self, f, th, a, b, ph, c, d, evaluation, options):
        "SphericalPlot3D[f_, {th_Symbol, a_, b_}, {ph_Symbol, c_, d_}, OptionsPattern[SphericalPlot3D]]"
        n = np()
        ev = evaluation
        a_v, b_v, c_v, d_v = [num(z.evaluate(ev), ev) for z in (a, b, c, d)]
        if None in (a_v, b_v, c_v, d_v):
            return None
        exprs, was_list, orig = held_list(f, [th, ph], ev)
        sts = styles3(options, len(exprs), ev)
        prims, pts = [], []
        for i, ex in enumerate(exprs):
            fn = make_fn(ex, [th, ph], ev, raw=raw_of(orig, exprs, i))
            m = 13 if fn.slow else 46
            TH, PH = grid_xy(a_v, b_v, c_v, d_v, m)
            R = fn(TH, PH)
            X, Y, Zv = R * n.sin(TH) * n.cos(PH), R * n.sin(TH) * n.sin(PH), R * n.cos(TH)
            cf, cv = color_field(options, None, X, Y, Zv, ev)
            prims.append(surf_prim(X, Y, Zv, sts[i], i, mesh_spec(options, ev), cf=cf, cv=cv, bd=True))
            pts.append(n.array([X.ravel(), Y.ravel(), Zv.ravel()]))
        return finish3(prims, pts, options, ev)


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
        return finish3(prims, [arr.T], options, evaluation, box=L(Integer(1), Integer(1), Real(0.4)))


class ListPlot3D(GB):
    attributes = A_PROTECTED

    def eval(self, data, evaluation, options):
        "ListPlot3D[data_, OptionsPattern[ListPlot3D]]"
        n = np()
        py = E("N", data).evaluate(evaluation).to_python()
        try:
            arr = n.array(py, dtype=float)
            if arr.ndim != 2 or arr.shape[0] < 2 or arr.shape[1] < 2:
                return None
        except Exception:
            return None
        if arr.shape[1] == 3 and arr.shape[0] > 3:
            # list of {x, y, z} triples: regular grid if possible
            xs, ys = n.unique(arr[:, 0]), n.unique(arr[:, 1])
            if xs.size * ys.size != arr.shape[0]:
                return None
            Zg = n.full((ys.size, xs.size), n.nan)
            Zg[n.searchsorted(ys, arr[:, 1]), n.searchsorted(xs, arr[:, 0])] = arr[:, 2]
            X, Y = n.meshgrid(xs, ys)
            arr = Zg
        else:
            ny, nx = arr.shape
            X, Y = n.meshgrid(n.arange(1, nx + 1, dtype=float), n.arange(1, ny + 1, dtype=float))
        st = styles3(options, 1, evaluation)[0]
        cf, cv = color_field(options, None, X, Y, arr, evaluation)
        return finish3([surf_prim(X, Y, arr, st, 0, mesh_spec(options, evaluation), cf=cf, cv=cv, bd=True)],
                       [n.array([X.ravel(), Y.ravel(), arr.ravel()])], options,
                       evaluation, box=L(Integer(1), Integer(1), Real(0.4)))


class VectorPlot3D(GB):
    def eval(self, f, x, a, b, y, c, d, z, e, g, evaluation, options):
        "VectorPlot3D[f_, {x_Symbol, a_, b_}, {y_Symbol, c_, d_}, {z_Symbol, e_, g_}, OptionsPattern[VectorPlot3D]]"
        n = np()
        ev = evaluation
        r = [[num(lo.evaluate(ev), ev), num(hi.evaluate(ev), ev)] for lo, hi in ((a, b), (c, d), (e, g))]
        if any(v is None for rr in r for v in rr):
            return None
        he = hold_eval(strip_wrappers(f), [x, y, z], ev)
        if not (isinstance(he, Expression) and he.has_form("List", 3)):
            return None
        fs = [make_fn(c2, [x, y, z], ev) for c2 in he.elements]
        m = 4 if any(f_.slow for f_ in fs) else 7
        ax = [n.linspace(lo, hi, m + 2)[1:-1] for lo, hi in r]
        X, Y, Z = n.meshgrid(*ax, indexing="ij")
        U, V, W = [fn(X, Y, Z) for fn in fs]
        mag = n.sqrt(U ** 2 + V ** 2 + W ** 2)
        mx = float(n.nanmax(mag)) if n.isfinite(mag).any() else 1.0
        mx = mx or 1.0
        cells = [(hi - lo) / (m + 1) for lo, hi in r]
        st = {}
        s_opt = opt(options, "VectorStyle")
        if s_opt is not None and not is_sym(s_opt, "Automatic"):
            apply_directive(st, s_opt.evaluate(ev), ev)
        prims = []
        for idx in n.ndindex(X.shape):
            g_ = float(mag[idx])
            if not math.isfinite(g_) or g_ == 0:
                continue
            # direction in box units (each axis scaled by its cell), length by magnitude
            dv = [float(U[idx]) / cells[0], float(V[idx]) / cells[1], float(W[idx]) / cells[2]]
            nrm = math.sqrt(sum(v * v for v in dv)) or 1.0
            k = (0.3 + 0.6 * g_ / mx) / nrm
            p0 = [float(X[idx]), float(Y[idx]), float(Z[idx])]
            p1 = [p0[j] + dv[j] * k * cells[j] for j in range(3)]
            p0 = [p0[j] - (p1[j] - p0[j]) * 0.5 for j in range(3)]
            p1 = [p1[j] - (p1[j] - p0[j]) / 3.0 for j in range(3)]
            rel = g_ / mx
            prims.append({"t": "arrow3", "x": nlist([p0[0], p1[0]], 4), "y": nlist([p0[1], p1[1]], 4),
                          "z": nlist([p0[2], p1[2]], 4), "color": st.get("color") or vec_color(rel), "width": 1.3})
        defaults = {"PlotRange": rng_expr(r), "Axes": SymbolTrue, "BoxRatios": L(Integer(1), Integer(1), Integer(1))}
        return G3(prims, rules3(options, defaults))


_VEC_STOPS = [(0.0, (48, 66, 140)), (0.3, (78, 122, 188)), (0.55, (150, 150, 170)), (0.75, (226, 150, 70)),
              (1.0, (226, 98, 38))]


def vec_color(t):
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(_VEC_STOPS[:-1], _VEC_STOPS[1:]):
        if t <= t1:
            f = (t - t0) / ((t1 - t0) or 1)
            return "#%02x%02x%02x" % tuple(int(round(c0[k] + (c1[k] - c0[k]) * f)) for k in range(3))
    return "#e26226"


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
            if nm in GOPTS and is_default(nm, v):
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


def labels_of(v, ev, dims=2):
    """AxesLabel -> [x, y(, z)] (a single label names the last axis, as in Mathematica)."""
    if v is None or is_sym(v, "None"):
        return None
    if v.has_form("List", None):
        out = []
        for x in v.elements:
            if x.has_form("List", None):
                out.extend(label_text(y, ev) for y in x.elements)
            else:
                out.append(label_text(x, ev))
        return out if any(out) else None
    t = label_text(v, ev)
    return ([None] * (dims - 1) + [t]) if t else None


def frame_labels(v, ev):
    """FrameLabel -> [bottom, left, top, right]."""
    if v is None or is_sym(v, "None"):
        return None
    if v.has_form("List", None):
        el = v.elements
        if len(el) == 2 and el[0].has_form("List", None) and el[1].has_form("List", None):
            lr = [label_text(y, ev) for y in el[0].elements] + [None, None]
            bt = [label_text(y, ev) for y in el[1].elements] + [None, None]
            out = [bt[0], lr[0], bt[1], lr[1]]
        else:
            out = [label_text(x, ev) for x in el[:4]]
        return out if any(out) else None
    t = label_text(v, ev)
    return [t] if t else None


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
        "axesLabel": labels_of(d.get("AxesLabel"), ev), "frameLabel": frame_labels(d.get("FrameLabel"), ev),
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
         "boxed": not (d.get("Boxed") is SymbolFalse), "axesLabel": labels_of(d.get("AxesLabel"), ev, 3),
         "plotLabel": label_text(d.get("PlotLabel"), ev), "size": size_of(d.get("ImageSize"), ev), "view": view}
    return {"dim": 3, "prims": prims, "opts": o}


GALLERY_HEADS = {"GraphicsRow": "row", "GraphicsColumn": "col", "GraphicsGrid": "grid", "Row": "row", "Column": "col",
                 "Grid": "grid", "List": "row", "TableForm": "grid", "MatrixForm": "grid"}


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
    # GraphicsRow & co. are not builtins of this Mathics build (they stay in Global`): match by short name
    sh = hn.split("`")[-1] if (hn.startswith("System`") or hn.startswith("Global`")) else None
    if sh in GALLERY_HEADS and e.elements:
        kind = GALLERY_HEADS[sh]
        rows = None

        def all_g(lst):
            return bool(lst) and all(is_graphic(x) for x in lst)

        def flat(x):
            return list(x.elements) if x.has_form("List", None) else [x]
        if sh == "List":
            if all_g(e.elements):
                rows = [list(e.elements)]
            elif all(x.has_form("List", None) and all_g(x.elements) for x in e.elements):
                rows = [list(x.elements) for x in e.elements]
        else:
            first = e.elements[0]
            if first.has_form("List", None) and first.elements:
                if all_g(first.elements):
                    rows = [list(first.elements)] if kind != "col" else [[x] for x in first.elements]
                elif all(x.has_form("List", None) and all_g(x.elements) for x in first.elements):
                    rows = [list(x.elements) for x in first.elements]
                elif kind in ("row", "col") and all_g([y for x in first.elements for y in flat(x)]):
                    items = [y for x in first.elements for y in flat(x)]
                    rows = [items] if kind == "row" else [[x] for x in items]
            elif is_graphic(first) and kind in ("row", "col") and all_g(e.elements):
                rows = [list(e.elements)]
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
            held = list(el[1].elements) if el[1].has_form("List", None) and len(el[1].elements) == len(vals) else vals
            labels = []
            for i_, v in enumerate(vals):
                hv = held[i_]
                if v.get_head_name() in ("System`Rule", "System`RuleDelayed") and len(v.elements) == 2:
                    labels.append(label_text(v.elements[1], ev) or "")      # value -> label
                    vals[i_] = v.elements[0]
                elif isinstance(v, String):
                    labels.append(v.value)
                else:
                    try:
                        labels.append(K.to_text(E("HoldForm", hv), "InputForm"))
                    except Exception:
                        labels.append(label_text(v, ev) or "")
            c["type"] = "choice"
            c["choices"] = labels
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
    first_id = kernel._next_id
    try:
        res = E("Block", L(*assigns), p["body"]).evaluate(ev)
        items.extend(kernel._drain_messages())
        if res is not SymbolNull:
            it = kernel.format(res)
            it["kind"] = "out"
            items.append(it)
        # graphics payloads created by this frame are already serialised: do not let the registry grow
        if not any(i_.get("type") in ("manipulate", "gallery") for i_ in items):
            for k_ in range(first_id, kernel._next_id):
                pl = kernel.registry.get(k_)
                if isinstance(pl, dict) and pl.get("kind") == "g":
                    kernel.registry.pop(k_, None)
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


BUILTINS = [Plot, LogPlot, ListLogPlot, ListPlot, ListLinePlot, DiscretePlot, ParametricPlot, PolarPlot, ContourPlot, DensityPlot,
            RegionPlot, VectorPlot, StreamPlot, Plot3D, ParametricPlot3D, ContourPlot3D, RegionPlot3D,
            RevolutionPlot3D, SphericalPlot3D, ListPointPlot3D, ListPlot3D, VectorPlot3D, Show, Manipulate, Animate,
            ColorDataX]


def install(kernel):
    global K
    K = kernel
    ext.contribute(kernel, BUILTINS)
