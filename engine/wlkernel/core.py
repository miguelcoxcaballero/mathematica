# -*- coding: utf-8 -*-
"""Kernel wrapper around Mathics3 (an open-source Wolfram Language interpreter).

Runs unchanged under CPython (tests) and Pyodide (browser).
"""
import json
import re
import time
import traceback

from mathics.core.load_builtin import import_and_load_builtins

_loaded = False


def _ensure_loaded():
    global _loaded
    if not _loaded:
        import_and_load_builtins()
        _loaded = True


class Deadline(BaseException):
    pass


RULE_FIX = {
    "": "→", "⇾": "→", "": ":→", "": "==", "⩵": "==", "": "d",
    "": "e", "": "i", "": "ᵀ", "": "×", "": "→", "": "⇒",
    "": "==", "": " ", "": "†", "": "†", "": "→",
}
_RULE_RE = re.compile("|".join(map(re.escape, RULE_FIX)))


def fix_chars(s):
    if not s:
        return s
    s = _RULE_RE.sub(lambda m: RULE_FIX[m.group(0)], s)
    s = s.replace("&#8702;", "&#8594;").replace("&#10869;", "==").replace("&#62754;", "&#8594;")
    return s


_patched = False


def _patch_builtin_errors():
    """A Python error inside a builtin leaves the expression unevaluated (as Mathematica would)
    instead of aborting the whole cell."""
    global _patched
    if _patched:
        return
    _patched = True
    from mathics.core.rules import FunctionApplyRule

    orig = FunctionApplyRule.apply_function
    soft = (AttributeError, TypeError, KeyError, IndexError, NotImplementedError, ZeroDivisionError,
            AssertionError, OverflowError, ValueError)

    def apply_function(self, expression, vars, options, evaluation):
        prev = evaluation.current_expression
        try:
            return orig(self, expression, vars, options, evaluation)
        except soft as exc:
            if isinstance(exc, ValueError) and "outrageous" in str(exc):
                raise
            evaluation.current_expression = prev
            return expression
        except Exception as exc:
            if type(exc).__module__.startswith("sympy") or type(exc).__module__.startswith("mpmath") \
                    or type(exc).__name__ in ("SympyTimeout", "ConvError"):
                evaluation.current_expression = prev
                return expression
            raise

    FunctionApplyRule.apply_function = apply_function


class Kernel:
    def __init__(self, time_limit=25.0):
        _ensure_loaded()
        from mathics.session import MathicsSession

        self.session = MathicsSession(add_builtin=True, catch_interrupt=False)
        self.ev = self.session.evaluation
        self.defs = self.session.definitions
        self.time_limit = time_limit
        self._deadline = None
        self.registry = {}      # numeric payloads for graphics / manipulate
        self._next_id = 1
        self._patch_evaluation()
        from . import ext

        ext.install(self)
        self._guard_lookup()

    def _guard_lookup(self):
        """Mathics sometimes leaks stray System` symbols (e.g. evaluating y''[t] creates System`t),
        which would then capture the user's own symbol. Freeze the set of real System` names."""
        defs = self.defs
        system_ok = set(n for n in defs.get_names() if n.startswith("System`") and n.count("`") == 1)
        orig = defs.lookup_name

        def lookup_name(name):
            if "`" not in name and defs.current_context == "Global`":
                full = "System`" + name
                if full in system_ok:
                    return full
                return "Global`" + name
            return orig(name)

        defs.lookup_name = lookup_name
        defs.clear_cache()

    # ------------------------------------------------------------------ utils
    def new_id(self, payload):
        i = self._next_id
        self._next_id += 1
        self.registry[i] = payload
        return i

    def _patch_evaluation(self):
        ev = self.ev
        kernel = self

        def check_stopped():
            if kernel._deadline is not None and time.time() > kernel._deadline:
                kernel._deadline = None
                raise Deadline()
            if ev.stopped:
                from mathics.core.interrupt import TimeoutInterrupt

                raise TimeoutInterrupt

        ev.check_stopped = check_stopped
        _patch_builtin_errors()
        self._orig_format_output = ev.format_output

    def parse(self, code):
        from mathics.core.parser import MathicsSingleLineFeeder, parse

        return parse(self.defs, MathicsSingleLineFeeder(code, "<expr>"))

    def eval_expr(self, expr):
        """Evaluate a Mathics expression silently, returning the result expression."""
        return expr.evaluate(self.ev)

    def eval_code(self, code):
        """Parse+evaluate code silently (no In/Out bookkeeping). Returns expr or None."""
        e = self.parse(code)
        if e is None:
            return None
        self.ev.stopped = False
        return e.evaluate(self.ev)

    def to_text(self, expr, form="InputForm"):
        from mathics.core.expression import Expression
        from mathics.core.symbols import Symbol

        try:
            r = Expression(Symbol("System`ToString"), expr, Symbol("System`" + form)).evaluate(self.ev)
            return fix_chars(r.value if hasattr(r, "value") else str(r))
        except Exception:
            return fix_chars(str(expr))

    # ------------------------------------------------------------- formatting
    def format(self, expr):
        from . import gfx

        special = gfx.format_special(self, expr)
        if special is not None:
            return special
        out = {"type": "expr"}
        try:
            out["text"] = self.to_text(expr, "InputForm")
        except Exception:
            out["text"] = str(expr)
        try:
            shown = gfx.strip_graphics(self, expr)
            out["mathml"] = fix_chars(str(self._orig_format_output(shown, "xml")))
        except Exception:
            out["mathml"] = None
        try:
            out["plain"] = fix_chars(str(self._orig_format_output(gfx.strip_graphics(self, expr), "text")))
        except Exception:
            out["plain"] = out["text"]
        return out

    def _drain_messages(self):
        msgs = []
        for o in self.ev.out or []:
            try:
                if getattr(o, "is_message", False):
                    msgs.append({"kind": "message", "symbol": o.symbol, "tag": o.tag, "text": fix_chars(o.text)})
                else:
                    payload = getattr(o, "payload", None)
                    if payload is not None:
                        msgs.append(payload)
                    else:
                        msgs.append({"kind": "print", "text": fix_chars(o.text)})
            except Exception:
                msgs.append({"kind": "print", "text": str(o)})
        self.ev.out = []
        return msgs

    # ------------------------------------------------------------------- run
    def run_cell(self, code):
        """Evaluate a notebook cell. Returns dict with a list of items in order."""
        from mathics.core.parser import MathicsMultiLineFeeder
        from mathics.core.symbols import SymbolNull

        items = []
        t0 = time.time()
        feeder = MathicsMultiLineFeeder(code.replace("\r", ""), "<cell>")
        first_line = None
        last_line = None
        while not feeder.empty():
            self.ev.out = []
            try:
                query = self.ev.parse_feeder(feeder)
            except Exception as exc:  # scanner errors
                items.extend(self._drain_messages())
                items.append({"kind": "message", "symbol": "Syntax", "tag": "sntx", "text": str(exc)})
                break
            if query is None:
                items.extend(self._drain_messages())
                continue
            self._deadline = time.time() + self.time_limit
            try:
                res = self.ev.evaluate(query, format="unformatted")
                self.ev.stopped = False
                items.extend(self._drain_messages())
                line = self.defs.get_line_no()
                if first_line is None:
                    first_line = line
                last_line = line
                expr = res.last_eval if res is not None else None
                if expr is not None and expr is not SymbolNull:
                    item = self.format(expr)
                    item["kind"] = "out"
                    item["line"] = line
                    items.append(item)
            except Deadline:
                items.extend(self._drain_messages())
                items.append({"kind": "message", "symbol": "General", "tag": "time",
                              "text": "Cálculo abortado: superó %d s." % int(self.time_limit)})
                self.ev.stopped = False
                break
            except RecursionError:
                items.extend(self._drain_messages())
                items.append({"kind": "message", "symbol": "$RecursionLimit", "tag": "reclim",
                              "text": "Recursion depth exceeded."})
            except Exception as exc:
                items.extend(self._drain_messages())
                items.append({"kind": "message", "symbol": "Kernel", "tag": "err",
                              "text": "%s: %s" % (type(exc).__name__, str(exc)[:300]),
                              "trace": traceback.format_exc()[-1500:]})
            finally:
                self._deadline = None
                self.ev.stopped = False
        return {"items": items, "inLine": first_line, "lastLine": last_line, "ms": int((time.time() - t0) * 1000)}

    def run_cell_json(self, code):
        return json.dumps(self.run_cell(code))

    # --------------------------------------------------------------- checking
    def check(self, spec_json):
        from . import checker

        try:
            return json.dumps(checker.check(self, json.loads(spec_json)))
        except Exception as exc:
            return json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                               "trace": traceback.format_exc()[-1200:]})

    def manipulate_json(self, mid, values_json):
        from . import gfx

        try:
            return json.dumps(gfx.manipulate_eval(self, int(mid), json.loads(values_json)))
        except Exception as exc:
            return json.dumps({"items": [{"kind": "message", "symbol": "Manipulate", "tag": "err",
                                          "text": "%s: %s" % (type(exc).__name__, exc)}]})

    def reset_user(self):
        """Clear all Global` definitions (like Quit kernel but fast)."""
        self.eval_code('ClearAll["Global`*"]')
        self.defs.set_line_no(0)
