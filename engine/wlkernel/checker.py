# -*- coding: utf-8 -*-
"""Exercise checker. See docs/SPEC.md (section "check") for the JSON contract.

check(kernel, spec) where spec = {
   "code": "<user code>",            # evaluated as a normal cell (unless "noRun")
   "setup": "<hidden code run before the user code>" (optional),
   "check": {...} ,                   # see CHECK TYPES
   "requires": ["Limit", ...], "forbids": ["N", ...]   (optional, static scan of the user code)
}
returns {"ok": bool, "feedback": str, "items": [...cell output items...], "got": text, "expected": text}
"""
import random
import re

from mathics.core.atoms import Integer, Real, String
from mathics.core.expression import Expression
from mathics.core.list import ListExpression
from mathics.core.symbols import Symbol, SymbolFalse, SymbolNull, SymbolTrue

from .conv import S
from .ext import E, L, Rule, pyval

STRING_RE = re.compile(r'"(?:[^"\\]|\\.)*"')
COMMENT_RE = re.compile(r"\(\*.*?\*\)", re.S)


def symbols_in(code):
    code = COMMENT_RE.sub(" ", code)
    code = STRING_RE.sub('""', code)
    # a name cannot start with a digit, so `2Pi`, `3I`, `2x` are implicit products: the name still counts
    # (but not the exponent marker of numbers such as 1.5*^3 or the backtick precision 1.2`20)
    names = set(re.findall(r"(?<![A-Za-z$`])(?:(?<=\d)|(?<![A-Za-z0-9$`]))([A-Za-z$][A-Za-z0-9$]*)", code))
    ops = {
        "/.": "ReplaceAll", "//.": "ReplaceRepeated", "->": "Rule", ":>": "RuleDelayed", ":=": "SetDelayed",
        "/@": "Map", "@@": "Apply", "//": "Postfix", "[[": "Part", "==": "Equal", "&&": "And", "||": "Or",
        "'": "Derivative", "&": "Function", "#": "Slot", "%": "Out", "<>": "StringJoin", ";;": "Span", "!=": "Unequal",
        "===": "SameQ", ".": "Dot", "^": "Power", "!": "Factorial", "_": "Blank",
    }
    for op, nm in ops.items():
        if op in code:
            if op == "." and not re.search(r"[\]\}A-Za-z0-9]\s*\.\s*[A-Za-z\{\(]", code):
                continue
            if op == "//" and not re.search(r"//(?!\.)", code):
                continue
            if op == "!" and not re.search(r"[A-Za-z0-9\)\]]!(?!=)", code):
                continue
            if op == "=" and "==" in code:
                continue
            names.add(nm)
    if re.search(r"(?<![=!<>:])=(?!=)", code):
        names.add("Set")
    return names


def is_num(v):
    return isinstance(v, (int, float, complex))


def close(a, b, tol):
    try:
        return abs(a - b) <= tol * (1.0 + abs(b))
    except Exception:
        return False


class Ck:
    def __init__(self, kernel):
        self.k = kernel
        self.ev = kernel.ev

    def ev_code(self, code):
        self.ev.out = []
        self.ev.stopped = False
        import time as _t

        from .core import Deadline

        self.k._deadline = _t.time() + 20
        # `%` in check code = last output of the student's cell (SPEC §6): evaluate as if on the next line
        line0 = self.k.defs.get_line_no()
        pct = getattr(self, "pct_line", None)
        if pct is not None:
            self.k.defs.set_line_no(pct + 1)
            # `Out[$Line]` (work-around some lessons used before `%` was fixed) keeps meaning the same output
            try:
                from mathics.core.rules import Rule as _MRule

                self.k.defs.add_rule("Out", _MRule(E("Out", Integer(pct + 1)), E("Out", Integer(pct))))
            except Exception:
                pass
        try:
            return self.k.eval_code(code)
        except Deadline:
            self.k._deadline = None
            return None
        finally:
            self.k.defs.set_line_no(line0)
            if pct is not None:
                try:
                    self.k.defs.unset("Out", E("Out", Integer(pct + 1)))
                except Exception:
                    pass
            self.k._deadline = None
            self.ev.out = []
            self.ev.stopped = False

    def evalx(self, expr):
        self.ev.stopped = False
        r = expr.evaluate(self.ev)
        self.ev.out = []
        self.ev.stopped = False
        return r

    # ---------------------------------------------------------- comparisons
    def numeric(self, a, b, tol):
        """Numeric comparison of two expressions (numbers or nested lists of numbers)."""
        va = self.pynum(a)
        vb = self.pynum(b)
        return self._cmp_py(va, vb, tol)

    def pynum(self, e):
        try:
            r = self.evalx(E("N", e))
            v = r.to_python()
            return self._clean(v)
        except Exception:
            return None

    def _clean(self, v):
        if isinstance(v, (list, tuple)):
            return [self._clean(x) for x in v]
        if isinstance(v, bool):
            return v
        if is_num(v):
            return v
        return None

    def _cmp_py(self, a, b, tol):
        if a is None or b is None:
            return False
        if isinstance(a, list) or isinstance(b, list):
            if not (isinstance(a, list) and isinstance(b, list)) or len(a) != len(b):
                # allow {x} vs x
                if isinstance(a, list) and len(a) == 1 and not isinstance(b, list):
                    return self._cmp_py(a[0], b, tol)
                if isinstance(b, list) and len(b) == 1 and not isinstance(a, list):
                    return self._cmp_py(a, b[0], tol)
                return False
            return all(self._cmp_py(x, y, tol) for x, y in zip(a, b))
        if isinstance(a, bool) or isinstance(b, bool):
            return a == b
        return close(complex(a), complex(b), tol)

    def free_symbols(self, e, acc=None):
        acc = set() if acc is None else acc
        if isinstance(e, Symbol):
            n = e.get_name()
            if not n.startswith("System`"):
                acc.add(n)
        elif isinstance(e, Expression):
            h = e.get_head()
            if isinstance(h, Expression):
                self.free_symbols(h, acc)
            for x in e.elements:
                self.free_symbols(x, acc)
        return acc

    def equal(self, a, b, tol=1e-8):
        """Mathematical equality of two expressions."""
        if a is None or b is None:
            return False
        if a.sameQ(b):
            return True
        la, lb = a.has_form("List", None), b.has_form("List", None)
        if la or lb:
            if not (la and lb) or len(a.elements) != len(b.elements):
                return False
            return all(self.equal(x, y, tol) for x, y in zip(a.elements, b.elements))
        for hn in ("System`Rule", "System`Equal", "System`RuleDelayed"):
            if a.get_head_name() == hn or b.get_head_name() == hn:
                if a.get_head_name() != b.get_head_name() or len(a.elements) != len(b.elements):
                    return False
                return all(self.equal(x, y, tol) for x, y in zip(a.elements, b.elements))
        if isinstance(a, String) or isinstance(b, String):
            return isinstance(a, String) and isinstance(b, String) and a.value.strip() == b.value.strip()
        if a in (SymbolTrue, SymbolFalse) or b in (SymbolTrue, SymbolFalse):
            return a is b
        try:
            d = self.evalx(E("Simplify", E("Subtract", a, b)))
            if isinstance(d, (Integer, Real)) and abs(d.to_python()) < 1e-9:
                return True
        except Exception:
            pass
        # numeric probing on the free symbols
        syms = sorted(self.free_symbols(a) | self.free_symbols(b))
        if not syms:
            va, vb = self.pynum(a), self.pynum(b)
            return va is not None and vb is not None and self._cmp_py(va, vb, max(tol, 1e-7))
        rnd = random.Random(12345)
        hits = 0
        for _ in range(8):
            rules = L(*[Rule(Symbol(s), Real(rnd.uniform(0.3, 1.7))) for s in syms])
            va = self.pynum(E("ReplaceAll", a, rules))
            vb = self.pynum(E("ReplaceAll", b, rules))
            if va is None or vb is None or isinstance(va, list) or isinstance(vb, list):
                continue
            if not close(complex(va), complex(vb), 1e-6):
                return False
            hits += 1
        return hits >= 4

    def as_set(self, e):
        if e is None or not e.has_form("List", None):
            return None
        return list(e.elements)

    def set_equal(self, a, b, tol):
        A, B = self.as_set(a), self.as_set(b)
        if A is None or B is None or len(A) != len(B):
            return False
        used = [False] * len(B)
        for x in A:
            found = False
            for j, y in enumerate(B):
                if used[j]:
                    continue
                if self.item_equal(x, y, tol):
                    used[j] = True
                    found = True
                    break
            if not found:
                return False
        return True

    def item_equal(self, x, y, tol):
        if x.has_form("List", None) and y.has_form("List", None) and x.elements and \
                all(e.get_head_name() == "System`Rule" for e in x.elements):
            return self.set_equal(x, y, tol)
        if x.get_head_name() == "System`Rule" and y.get_head_name() == "System`Rule":
            return x.elements[0].sameQ(y.elements[0]) and self.value_equal(x.elements[1], y.elements[1], tol)
        return self.value_equal(x, y, tol)

    def value_equal(self, x, y, tol):
        vx, vy = self.pynum(x), self.pynum(y)
        if vx is not None and vy is not None and not isinstance(vx, list) and not isinstance(vy, list):
            return self._cmp_py(vx, vy, max(tol, 1e-7))
        return self.equal(x, y, tol)

    # ---------------------------------------------------------------- checks
    def run(self, chk, last):
        t = chk.get("type", "expr")
        tol = float(chk.get("tol", 1e-6))
        if t == "all":
            for c in chk["checks"]:
                r = self.run(c, last)
                if not r["ok"]:
                    return r
            return {"ok": True}
        if t == "any":
            r = {"ok": False}
            for c in chk["checks"]:
                r = self.run(c, last)
                if r["ok"]:
                    return r
            return r
        if t in ("expr", "value"):
            got = last if t == "expr" else self.ev_code(chk["expr"])
            if got is None:
                return {"ok": False, "feedback": chk.get("msg") or "Tu celda no ha devuelto ningún resultado "
                        "(¿has terminado la última línea con ; ?)."}
            exp = self.ev_code(chk["expected"])
            mode = chk.get("compare", "equal")
            if mode == "numeric":
                ok = self.numeric(got, exp, tol)
            elif mode in ("set", "rules"):
                ok = self.set_equal(got, exp, tol) or self.equal(got, exp, tol)
            elif mode == "same":
                ok = got.sameQ(exp)
            else:
                ok = self.equal(got, exp, tol) or (mode == "equal" and self.set_like(got, exp, tol))
            res = {"ok": ok, "got": self.k.to_text(got)[:400], "expected": self.k.to_text(exp)[:400]}
            if not ok:
                res["feedback"] = chk.get("msg") or "El resultado no coincide con el esperado."
            return res
        if t == "satisfies":
            r = self.ev_code(chk["test"])
            ok = r is SymbolTrue
            return {"ok": ok, "feedback": None if ok else (chk.get("msg") or "El resultado no cumple la condición pedida.")}
        if t == "ode":
            return self.ode(chk, last)
        if t == "graphics":
            return self.graphics(chk, last)
        if t == "defined":
            # a symbol must have a definition (function or variable)
            name = chk["name"]
            r = self.ev_code("Length[DownValues[%s]] + Length[OwnValues[%s]] > 0" % (name, name))
            ok = r is SymbolTrue
            return {"ok": ok, "feedback": None if ok else (chk.get("msg") or "No has definido `%s`." % name)}
        if t == "none":
            return {"ok": True}
        return {"ok": False, "feedback": "Tipo de comprobación desconocido: %s" % t}

    def set_like(self, got, exp, tol):
        # tolerate different ordering for Solve-like outputs
        if got.has_form("List", None) and exp.has_form("List", None) and exp.elements and \
                all(e.has_form("List", None) and e.elements and e.elements[0].get_head_name() == "System`Rule"
                    for e in exp.elements):
            return self.set_equal(got, exp, tol)
        return False

    def ode(self, chk, last):
        """The user's result (rules from DSolve, or an expression, or a defined function) must satisfy eq (+ ics)."""
        func, var = chk["func"], chk["var"]
        eqs = chk["eq"] if isinstance(chk["eq"], list) else [chk["eq"]]
        ics = chk.get("ics", [])
        if chk.get("expr"):
            sol = self.ev_code(chk["expr"])
        else:
            sol = last
        if sol is None:
            return {"ok": False, "feedback": "No hay resultado que comprobar."}
        # normalise to expression in var
        e = sol
        while e.has_form("List", None) and len(e.elements) == 1:
            e = e.elements[0]
        if e.get_head_name() == "System`Rule":
            rhs = e.elements[1]
            if rhs.get_head_name() == "System`Function":
                e = self.evalx(Expression(rhs, self.k.parse(var)))
            else:
                e = rhs
        if e.has_form("List", None):
            return {"ok": False, "feedback": "Se esperaba una única solución."}
        self.k.registry["__sol"] = e
        v = self.k.parse(var)
        f = self.k.parse(func)
        fun = E("Function", L(v), e)
        rules = L(Rule(f, fun))
        for eq in eqs:
            q = self.k.parse(eq)
            resid = self.evalx(E("Simplify", E("ReplaceAll", E("Subtract", q.elements[0], q.elements[1]), rules)))
            if not self.zeroish(resid, [var]):
                return {"ok": False, "feedback": chk.get("msg") or "La función obtenida no satisface la ecuación diferencial."}
        for ic in ics:
            q = self.k.parse(ic)
            lhs = self.evalx(E("ReplaceAll", q.elements[0], rules))
            if not self.value_equal(lhs, self.evalx(q.elements[1]), 1e-6):
                return {"ok": False, "feedback": "La solución no cumple la condición inicial %s." % ic}
        if chk.get("constants") is not None:
            n = 0
            txt = self.k.to_text(e)
            n = len(set(re.findall(r"C\[(\d+)\]", txt)))
            if n != int(chk["constants"]):
                return {"ok": False, "feedback": "La solución general debe tener %d constante(s) arbitraria(s)." % int(chk["constants"])}
        return {"ok": True, "got": self.k.to_text(e)[:400]}

    def zeroish(self, e, vars_):
        if isinstance(e, (Integer, Real)):
            return abs(e.to_python()) < 1e-8
        syms = sorted(self.free_symbols(e))
        rnd = random.Random(7)
        hits = 0
        for _ in range(6):
            rules = L(*[Rule(Symbol(s), Real(rnd.uniform(0.3, 1.5))) for s in syms] +
                      [Rule(E("C", Integer(i)), Real(rnd.uniform(0.5, 1.5))) for i in range(1, 6)])
            v = self.pynum(E("ReplaceAll", e, rules))
            if v is None or isinstance(v, list):
                continue
            if abs(v) > 1e-6:
                return False
            hits += 1
        return hits >= 3

    def _gspec(self, expr, dim):
        """(spec, error, ncontrols) for a Graphics/Graphics3D (possibly wrapped) or the initial state of a Manipulate."""
        from . import gfx

        g = gfx.unwrap_legended(expr)
        hn = g.get_head_name() if isinstance(g, Expression) else ""
        if hn in ("System`Manipulate", "System`Animate"):
            try:
                item = gfx.manipulate_json(self.k, g)
            except Exception:
                item = None
            self.ev.out = []
            if not item:
                return None, "No se pudo evaluar el Manipulate.", 0
            for it in (item.get("initial") or {}).get("items", []):
                gg = it.get("g") if it.get("type") == "graphics" else None
                if gg is None and it.get("type") == "gallery":
                    for row in it.get("rows", []):
                        for cell in row:
                            if cell and cell.get("type") == "graphics":
                                gg = cell["g"]
                                break
                        if gg:
                            break
                if gg is not None:
                    if gg.get("dim", 2) != dim:
                        return None, "Se esperaba un gráfico %s." % ("3D" if dim == 3 else "2D"), 0
                    return gg, None, len(item.get("controls", []))
            return None, "El Manipulate no muestra ningún gráfico.", len(item.get("controls", []))
        want = "System`Graphics3D" if dim == 3 else "System`Graphics"
        if hn != want:
            return None, "Se esperaba un gráfico %s." % ("3D" if dim == 3 else "2D"), 0
        return (gfx.graphics3d_json(g, self.ev) if dim == 3 else gfx.graphics_json(g, self.ev)), None, 0

    def graphics(self, chk, last):
        if last is None:
            return {"ok": False, "feedback": "La celda no ha producido ningún gráfico."}
        dim = chk.get("dim", 2)
        spec, err, nctl = self._gspec(last, dim)
        if spec is None:
            return {"ok": False, "feedback": err}
        if chk.get("controls") is not None and nctl < int(chk["controls"]):
            return {"ok": False, "feedback": chk.get("msg") or "Se esperaba un Manipulate con al menos %d control(es)." % int(chk["controls"])}
        prims = spec["prims"]
        kinds = [p["t"] for p in prims]
        curve_kinds = {"line", "points", "field", "arrows", "poly", "surf", "iso", "line3", "pts3", "poly3", "arrow3"}
        n = sum(1 for kk in kinds if kk in curve_kinds)
        if n < int(chk.get("min", 1)):
            return {"ok": False, "feedback": "El gráfico tiene menos elementos de los esperados (%d de %d)." % (n, int(chk.get("min", 1)))}
        for kk in chk.get("has", []):
            if kk not in kinds:
                return {"ok": False, "feedback": chk.get("msg") or "Falta un elemento en el gráfico (%s)." % kk}
        like = chk.get("like")
        if like:
            ref = self.ev_code(like)
            rspec = self._gspec(ref, dim)[0] if ref is not None else None
            if rspec is None or not self.same_data(spec, rspec, float(chk.get("tol", 0.02))):
                return {"ok": False, "feedback": chk.get("msg") or "El gráfico no representa lo que se pide (compara función e intervalo)."}
        opts = spec["opts"]
        for key in chk.get("opts", []):
            if not opts.get(key):
                return {"ok": False, "feedback": "Falta la opción correspondiente a `%s`." % key}
        return {"ok": True}

    @staticmethod
    def same_data(a, b, tol):
        def clean(vals):
            return [v for v in vals if isinstance(v, (int, float)) and v == v and abs(v) != float("inf")]

        def stats(vals):
            vals = clean(vals)
            if not vals:
                return None
            return (min(vals), max(vals), sum(vals) / len(vals))

        def at_fraction(xs, ys, frac):
            """y at x = xmin + frac (xmax - xmin) by linear interpolation; None unless x is monotonic."""
            pts = [(x, y) for x, y in zip(xs, ys) if isinstance(x, (int, float)) and isinstance(y, (int, float))
                   and x == x and y == y]
            if len(pts) < 2 or any(q[0] < p_[0] - 1e-12 for p_, q in zip(pts, pts[1:])):
                return None
            x0, x1 = pts[0][0], pts[-1][0]
            if x1 <= x0:
                return None
            xt = x0 + frac * (x1 - x0)
            for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
                if xa <= xt <= xb:
                    return ya if xb == xa else ya + (yb - ya) * (xt - xa) / (xb - xa)
            return None

        def sig(spec):
            out = []
            for p in spec["prims"]:
                t = p["t"]
                if t in ("line", "points"):
                    sx, sy = stats(p.get("x", [])), stats(p.get("y", []))
                    if sx is None or sy is None:
                        continue
                    nums = (sx[0], sx[1]) + sy
                    q1 = at_fraction(p.get("x", []), p.get("y", []), 0.23)
                    q2 = at_fraction(p.get("x", []), p.get("y", []), 0.71)
                    out.append((t, None, nums, (q1, q2) if q1 is not None and q2 is not None else None))
                elif t in ("line3", "pts3"):
                    parts = [stats(p.get(ax, [])) for ax in ("x", "y", "z")]
                    if all(q is not None for q in parts):
                        out.append((t, None, tuple(v for q in parts for v in q), None))
                elif t == "surf":
                    parts = [stats(p.get(ax, [])) for ax in ("x", "y", "z")]
                    if parts[2] is None:
                        continue
                    nums = tuple(v for q in parts if q is not None for v in q[:2]) + (parts[2][2],)
                    extra = None
                    nx, ny, zs = p.get("nx"), p.get("ny"), p.get("z", [])
                    if isinstance(nx, int) and isinstance(ny, int) and len(zs) == nx * ny and nx > 3 and ny > 3:
                        def zat(fx, fy):
                            v = zs[int(round(fy * (ny - 1))) * nx + int(round(fx * (nx - 1)))]
                            return v if isinstance(v, (int, float)) and v == v else None
                        e1, e2 = zat(0.25, 0.25), zat(0.75, 0.5)
                        if e1 is not None and e2 is not None:
                            extra = (e1, e2)
                    out.append((t, None, nums, extra))
                elif t in ("field", "iso"):
                    st = stats(p.get("data", []))
                    if st is not None:
                        ext_ = tuple(float(p[k_]) for k_ in ("x0", "x1", "y0", "y1") if isinstance(p.get(k_), (int, float)))
                        rr = p.get("r")
                        extra = None
                        if isinstance(rr, list):
                            try:
                                ext_ = tuple(float(v) for pair in rr for v in pair)
                            except Exception:
                                pass
                        data = clean(p.get("data", []))
                        if len(data) == len(p.get("data", [])) and len(data) > 16:
                            extra = (data[len(data) // 4 + 1], data[(2 * len(data)) // 3 + 2])
                        out.append((t, p.get("mode"), st + ext_, extra))
            return out
        sa, sb = sig(a), sig(b)
        used = [False] * len(sa)
        for rb in sb:
            ok = False
            for i, ra in enumerate(sa):
                if used[i] or ra[0] != rb[0] or ra[1] != rb[1] or len(ra[2]) != len(rb[2]):
                    continue
                nums_a, nums_b = ra[2], rb[2]
                scale = max(1e-9, max(abs(v) for v in nums_b))
                if all(abs(x - y) <= tol * scale + 1e-9 for x, y in zip(nums_a, nums_b)) and \
                        (ra[3] is None or rb[3] is None or len(ra[3]) != len(rb[3]) or
                         all(abs(x - y) <= 2.5 * tol * scale + 1e-9 for x, y in zip(ra[3], rb[3]))):
                    used[i] = True
                    ok = True
                    break
            if not ok:
                return False
        return True


def check(kernel, spec):
    ck = Ck(kernel)
    code = spec.get("code", "")
    out = {"ok": False, "items": []}
    # static requirements
    used = symbols_in(code)
    missing = [r for r in spec.get("requires", []) if r not in used]
    banned = [r for r in spec.get("forbids", []) if r in used]
    if spec.get("setup"):
        kernel.run_cell(spec["setup"])
    last = None
    if not spec.get("noRun"):
        res = kernel.run_cell(code)
        out["items"] = res["items"]
        line = res.get("lastLine")
        outs = [it for it in res["items"] if it.get("kind") == "out"]
        if outs:
            ck.pct_line = outs[-1]["line"]
            try:
                last = ck.evalx(E("Out", Integer(outs[-1]["line"])))
            except Exception:
                last = None
        elif line is not None:
            ck.pct_line = line      # cell ended in `;`: % is still the value of the last line
        if any(it.get("kind") == "message" and it.get("symbol") in ("Syntax", "Kernel") for it in res["items"]):
            out["feedback"] = "Hay un error de sintaxis o de evaluación. Lee el mensaje en rojo y corrígelo."
            return out
    if missing:
        out["feedback"] = "Debes usar: " + ", ".join("`%s`" % m for m in missing) + "."
        return out
    if banned:
        out["feedback"] = "En este ejercicio no se puede usar: " + ", ".join("`%s`" % m for m in banned) + "."
        return out
    chk = spec.get("check") or {"type": "none"}
    r = ck.run(chk, last)
    out.update(r)
    if out.get("ok") and not out.get("feedback"):
        out["feedback"] = "¡Correcto!"
    return out
