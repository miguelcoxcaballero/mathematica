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
    names = set(re.findall(r"(?<![A-Za-z0-9$`])([A-Za-z$][A-Za-z0-9$]*)", code))
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

        self.k._deadline = _t.time() + 20
        try:
            return self.k.eval_code(code)
        finally:
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

    def graphics(self, chk, last):
        from . import gfx

        if last is None:
            return {"ok": False, "feedback": "La celda no ha producido ningún gráfico."}
        g = gfx.unwrap_legended(last)
        dim = chk.get("dim", 2)
        hn = g.get_head_name() if isinstance(g, Expression) else ""
        want = "System`Graphics3D" if dim == 3 else "System`Graphics"
        if hn != want:
            return {"ok": False, "feedback": "Se esperaba un gráfico %s." % ("3D" if dim == 3 else "2D")}
        spec = gfx.graphics3d_json(g, self.ev) if dim == 3 else gfx.graphics_json(g, self.ev)
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
            ref = gfx.unwrap_legended(ref)
            rspec = gfx.graphics3d_json(ref, self.ev) if dim == 3 else gfx.graphics_json(ref, self.ev)
            if not self.same_data(spec, rspec, float(chk.get("tol", 0.02))):
                return {"ok": False, "feedback": chk.get("msg") or "El gráfico no representa lo que se pide (compara función e intervalo)."}
        opts = spec["opts"]
        for key in chk.get("opts", []):
            if not opts.get(key):
                return {"ok": False, "feedback": "Falta la opción correspondiente a `%s`." % key}
        return {"ok": True}

    @staticmethod
    def same_data(a, b, tol):
        def sig(spec):
            out = []
            for p in spec["prims"]:
                if p["t"] in ("line", "points", "line3", "pts3"):
                    ys = [v for v in p.get("y", []) if v is not None]
                    xs = [v for v in p.get("x", []) if v is not None]
                    if xs and ys:
                        out.append((p["t"], min(xs), max(xs), min(ys), max(ys), sum(ys) / len(ys)))
                elif p["t"] in ("surf",):
                    zs = [v for v in p.get("z", []) if v is not None]
                    if zs:
                        out.append((p["t"], min(zs), max(zs), sum(zs) / len(zs)))
                elif p["t"] in ("field", "iso"):
                    ds = [v for v in p.get("data", []) if v is not None]
                    if ds:
                        out.append((p["t"], p.get("mode"), min(ds), max(ds), sum(ds) / len(ds)))
            return out
        sa, sb = sig(a), sig(b)
        used = [False] * len(sa)
        for rb in sb:
            ok = False
            for i, ra in enumerate(sa):
                if used[i] or ra[0] != rb[0] or len(ra) != len(rb):
                    continue
                nums_a = [v for v in ra[1:] if isinstance(v, (int, float))]
                nums_b = [v for v in rb[1:] if isinstance(v, (int, float))]
                scale = max(1e-9, max(abs(v) for v in nums_b))
                if all(abs(x - y) <= tol * scale + 1e-9 for x, y in zip(nums_a, nums_b)):
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
            try:
                last = ck.evalx(E("Out", Integer(outs[-1]["line"])))
            except Exception:
                last = None
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
    if out.get("ok"):
        out.setdefault("feedback", "¡Correcto!")
    return out
