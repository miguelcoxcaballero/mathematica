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

    from . import ext

    budgets = ext.BUILTIN_BUDGETS

    def apply_function(self, expression, vars, options, evaluation):
        prev = evaluation.current_expression
        try:
            b = budgets.get(self.name)
            if b is None:
                return orig(self, expression, vars, options, evaluation)
            if ext.SKIP_ONCE.pop(self.name, None):
                return expression       # our own attempt already ran out of time
            with ext.budget(b):
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
    _patch_symbol_iteration()
    _patch_nvalues()


def _patch_nvalues():
    """N[x^2] must stay x^2 (Mathics gives x^2. and then Coefficient/Exponent/patterns fail):
    integer exponents of non-numeric bases are not numericized, as in Mathematica."""
    import sys

    import mathics.eval.nevaluator as nev
    from mathics.core.atoms import Integer
    from mathics.core.expression import Expression
    from mathics.core.systemsymbols import SymbolPower

    orig = nev.eval_NValues
    if getattr(orig, "_wlx", False):
        return

    def eval_NValues(expr, prec, evaluation):
        if isinstance(expr, Expression) and expr.head is SymbolPower and len(expr.elements) == 2:
            base, expo = expr.elements
            if isinstance(expo, Integer) and not base.is_numeric(evaluation):
                nb = eval_NValues(base, prec, evaluation)
                return Expression(SymbolPower, base if nb is None else nb, expo)
        return orig(expr, prec, evaluation)

    eval_NValues._wlx = True
    for mod in list(sys.modules.values()):
        try:
            if mod is not None and getattr(mod, "eval_NValues", None) is orig:
                mod.eval_NValues = eval_NValues
        except Exception:
            pass


def _patch_symbol_iteration():
    """Mathics counts EVERY evaluation of a symbol with a non-literal value against $IterationLimit,
    cumulatively for the whole line, so any long Table/Sum/Do using such a variable aborted silently
    after 4096 uses. Count nesting depth instead (what the limit is meant to catch: x = x + 1)."""
    import sys

    from mathics.core.symbols import Symbol
    from mathics.core.systemsymbols import SymbolAborted

    def evaluate(self, evaluation):
        rules = evaluation.definitions.get_ownvalues(self.name)
        for rule in rules:
            result = rule.apply(self, evaluation, fully=True)
            if result is not None and not result.sameQ(self):
                if result.is_literal:
                    return result
                limit = evaluation.definitions.get_config_value("$IterationLimit") or sys.maxsize
                if limit != sys.maxsize and evaluation.iteration_count > limit:
                    evaluation.error("$IterationLimit", "itlim", limit)
                    return SymbolAborted
                evaluation.iteration_count += 1
                try:
                    return result.evaluate(evaluation)
                finally:
                    evaluation.iteration_count -= 1
        return self

    Symbol.evaluate = evaluate


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
        self._clear_history()
        self._snapshot_system()
        self.ev.predetermined_out = None

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
        try:
            return e.evaluate(self.ev)
        finally:
            self.ev.predetermined_out = None

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

    def _begin_eval(self):
        from . import ext

        ext.SKIP_ONCE.clear()
        ext._BUDGET[0] = None
        # Mathics bug: ANY nested `a; b;` (function bodies, prelude, checker code...) leaves
        # evaluation.predetermined_out set and the next line stores it as its Out[n].
        self.ev.predetermined_out = None

    def _fix_out(self, query, res, line):
        """Out[n] must be the value of line n (Mathics may have stored a stale `predetermined_out`).
        Only a top-level `a; b;` keeps Mathematica's rule (Out[n] = value of b)."""
        from mathics.core.expression import Expression
        from mathics.core.atoms import Integer
        from mathics.core.rules import Rule
        from mathics.core.symbols import Symbol, SymbolNull

        self.ev.predetermined_out = None
        try:
            last = res.last_eval if res is not None else None
            if last is None:
                return
            top_compound = query.get_head_name() == "System`CompoundExpression" and query.elements and \
                query.elements[-1] is SymbolNull
            if top_compound and last is SymbolNull:
                return
            stored = self.ev.get_stored_result(last, self.defs.outputforms)
            self.defs.add_rule("Out", Rule(Expression(Symbol("System`Out"), Integer(line)), stored))
        except Exception:
            pass

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
                self._begin_eval()
                res = self.ev.evaluate(query, format="unformatted")
                self.ev.stopped = False
                if res is not None and getattr(res, "out", None):
                    # Mathics hands the messages/prints of the line over to the Result object
                    self.ev.out = list(res.out) + list(self.ev.out or [])
                items.extend(self._drain_messages())
                line = self.defs.get_line_no()
                self._fix_out(query, res, line)
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
                self._deadline = None
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
        except Deadline:
            self._deadline = None
            return json.dumps({"ok": False, "feedback": "La comprobación tardó demasiado.", "items": []})
        except Exception as exc:
            return json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                               "trace": traceback.format_exc()[-1200:]})

    def manipulate_json(self, mid, values_json):
        from . import gfx

        try:
            return json.dumps(gfx.manipulate_eval(self, int(mid), json.loads(values_json)))
        except Deadline:
            self._deadline = None
            return json.dumps({"items": [{"kind": "message", "symbol": "Manipulate", "tag": "time",
                                          "text": "Evaluación demasiado lenta."}]})
        except Exception as exc:
            return json.dumps({"items": [{"kind": "message", "symbol": "Manipulate", "tag": "err",
                                          "text": "%s: %s" % (type(exc).__name__, exc)}]})

    def _snapshot_system(self):
        """Remember the user-level rules that the prelude attached to System`/WLX` symbols."""
        import copy

        snap = {}
        for name, d in self.defs.user.items():
            if not name.startswith("Global`"):
                snap[name] = copy.copy(d.__dict__)
                for key, val in list(snap[name].items()):
                    if isinstance(val, (list, dict, set)):
                        snap[name][key] = copy.copy(val)
        self._sys_snapshot = snap

    def _restore_system(self):
        """Undo what the user attached to System` symbols (y'[x] = ..., Unprotect[Sin]; Sin[7] = 2 ...)."""
        import copy

        snap = getattr(self, "_sys_snapshot", None)
        if snap is None:
            return
        user = self.defs.user
        changed = False
        for name in list(user.keys()):
            if name.startswith("Global`") or name in ("System`Out", "System`In", "System`$Line"):
                continue
            if name not in snap:
                if name.startswith("System`") or name.startswith("WLX`"):
                    del user[name]
                    changed = True
                continue
            d = user[name]
            for key, val in snap[name].items():
                cur = d.__dict__.get(key)
                if isinstance(val, (list, dict, set)):
                    if cur != val:
                        d.__dict__[key] = copy.copy(val)
                        changed = True
                elif cur is not val and cur != val:
                    d.__dict__[key] = val
                    changed = True
        if changed:
            self.defs.clear_cache()

    def reset_user(self):
        """Clear all Global` definitions (like Quit kernel but fast)."""
        self.eval_code('ClearAll["Global`*"]')
        self._restore_system()
        self._clear_history()
        self.ev.predetermined_out = None

    def _clear_history(self):
        """Forget In/Out so that % and Out[n] never return values from before a reset (or from the prelude)."""
        try:
            self.eval_code('Unprotect[Out, In]; Clear[Out, In]; Protect[Out, In];')
        except Exception:
            pass
        self.ev.out = []
        self.ev.stopped = False
        self.defs.set_line_no(0)
