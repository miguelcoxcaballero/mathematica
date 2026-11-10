// wl-highlight.js — Wolfram Language tokenizer + Mathematica-like syntax colouring (NOTEBOOK).
//   tokenize(code)            → [{t, s, e, v, …}]   t: ws|comment|string|number|symbol|pattern|slot|op|open|close|named|other
//   highlight(code, opts)     → HTML string for the <pre> that sits under the textarea
//                               opts: {defined:Set<string>, caret:number|null}
//   setSystemSymbols(names)   → teach the highlighter the real list of System` symbols (kernel.symbols())
//   isSystemSymbol(name), systemSymbols() , symbolAt(code, pos) → {name, start, end}|null
// Colours follow the Mathematica front end: undefined Global symbols blue, System/defined symbols black,
// pattern variables green italic, Module/With/Block locals green, iterator variables teal, strings gray,
// comments light gray, unmatched brackets magenta.

// A starter list so colouring is right before the kernel has loaded (the full list replaces it later).
const CORE = `Abs AbsoluteTiming Accumulate All Alternatives And Animate Apart Append AppendTo Apply ArcCos ArcCosh ArcCot ArcSin
ArcSinh ArcTan ArcTanh Arg Array ArrayPlot Arrow AspectRatio Assuming Assumptions Automatic Axes AxesLabel AxesOrigin Background
BarChart BesselJ BesselY Binomial Black Blank Block Blue Boole Brown C Cancel Cases Catch Ceiling CharacteristicPolynomial Chop Circle
Clear ClearAll Coefficient CoefficientList Collect ColorData ColorFunction Column Complement Complex ComplexExpand Complexes
ComplexInfinity Compile Conjugate Constant ContourPlot ContourPlot3D ContourShading Contours Cos Cosh Cot Count Cross Csc Curl Cyan
D DSolve DSolveValue Dashed Dashing Degree Delete DeleteCases DeleteDuplicates Denominator DensityPlot Derivative Det Diagonal
DiagonalMatrix Differences DiracDelta Direction Directive DirectedInfinity Disk Div Divide Do Dot Dotted Drop Dt E EdgeForm
Eigensystem Eigenvalues Eigenvectors Element Eliminate EllipticE EllipticK Epilog Equal Erf Erfc Evaluate EvenQ Except Exclusions Exp
ExpToTrig Expand ExpandAll ExpandDenominator ExpandNumerator Exponent Export Expression Extract FaceForm Factor FactorInteger
Factorial False Fibonacci Filling FindFit FindInstance FindMaximum FindMinimum FindRoot First Fit Flatten Floor Fold FoldList For
Fourier FourierTransform Frame FrameLabel FreeQ FresnelC FresnelS FullForm FullSimplify Function GCD Gamma GeometricTransformation
Glow Grad Graphics Graphics3D GraphicsColumn GraphicsGrid GraphicsRow Gray Greater GreaterEqual Green Grid GridLines Head
HeavisideTheta Hold HoldForm Hue I Identity IdentityMatrix If Im ImageSize Implies Import In Indeterminate Infinity Inner Input
InputForm Insert Integer IntegerDigits IntegerPart IntegerQ Integers Integrate Interpolation InterpolatingFunction Intersection
Inverse InverseFourierTransform InverseFunction InverseLaplaceTransform Join Joined KroneckerDelta LCM Laplacian LaplaceTransform
Last Legended Length Less LessEqual Level LightBlue LightGray Limit Line LinearSolve List ListLinePlot ListPlot ListPlot3D
ListQ Log Log10 Log2 LogLogPlot LogPlot Magenta Manipulate Map MapIndexed MapThread MatchQ MatrixExp MatrixForm MatrixPower
MatrixQ MatrixRank Max Maximize Mean Median Mesh MeshFunctions MemberQ Min Minimize Minus Mod Module Most N NDSolve NDSolveValue
NIntegrate NMaximize NMinimize NProduct NSolve NSum Names Nand Needs Negative Nest NestList NestWhile None Nor Norm Normal Normalize
Not NotebookDirectory Null NullSpace NumberForm NumberQ Numerator NumericQ O OddQ Opacity Options Or Orange Order OrderedQ Out Outer
PaddedForm ParametricPlot ParametricPlot3D Part Partition Pi Piecewise PieChart Pink Plot Plot3D PlotLabel PlotLegends PlotPoints
PlotRange PlotStyle PlotTheme Plus Point PointSize PolarPlot Polygon PolynomialQ PolynomialQuotient PolynomialRemainder Position
Positive Power PowerExpand Prepend PrependTo Prime PrimeQ Print Product Projection Purple Quiet Quotient RGBColor Random RandomChoice
RandomInteger RandomReal Range Rational Rationalize Rationals Re Real Reals Rectangle Red Reduce Refine RegionFunction RegionPlot
RegionPlot3D ReleaseHold Remove Replace ReplaceAll ReplacePart ReplaceRepeated Residue Rest Return Reverse RevolutionPlot3D Riffle
Root Roots RotateLeft RotateRight RotationMatrix Round Row RowReduce Rule RuleDelayed SameQ Scaled Sec Select Sequence Series
SeriesCoefficient SeriesData Set SetAttributes SetDelayed SetDirectory Short Show Sign Simplify Sin Sinh Slot Solve SolveAlways Sort
SortBy Sphere SphericalPlot3D Split Sqrt StandardDeviation StreamPlot String StringJoin StringLength StringQ Style Subscript Subsets
Subtract Sum Superscript Switch Symbol Table TableForm Take Tan Tanh Text Thick Thickness Thin Thread Through Ticks Times Timing
ToExpression ToRadicals ToString Together Total Tr TraditionalForm Transpose TrigExpand TrigFactor TrigReduce TrigToExp True Tube
Unequal Union UnitStep UnitVector Unset UpSet Variables Variance VectorAngle VectorPlot VectorPlot3D VectorQ ViewPoint Which While
White With Xor Yellow Zeta $Assumptions $Failed $MachineEpsilon $MachinePrecision $Version`.split(/\s+/);

let SYSTEM = new Set(CORE);
let full = false;

export function setSystemSymbols(names) {
  if (!names || !names.length) return;
  SYSTEM = new Set(names);
  for (const n of CORE) SYSTEM.add(n);
  full = true;
}
export function isSystemSymbol(name) { return SYSTEM.has(name); }
export function systemSymbols() { return SYSTEM; }
export function hasFullSymbolList() { return full; }

const SCOPING = new Set(['Module', 'Block', 'With', 'DynamicModule', 'Function']);
const ITERATING = new Set(['Table', 'Do', 'Sum', 'Product', 'NSum', 'NProduct', 'Plot', 'Plot3D', 'ParametricPlot', 'ParametricPlot3D',
  'ContourPlot', 'ContourPlot3D', 'DensityPlot', 'RegionPlot', 'RegionPlot3D', 'PolarPlot', 'LogPlot', 'LogLogPlot', 'LogLinearPlot',
  'StreamPlot', 'VectorPlot', 'VectorPlot3D', 'SphericalPlot3D', 'RevolutionPlot3D', 'Manipulate', 'Animate', 'NIntegrate', 'Integrate',
  'Array', 'ListAnimate', 'FindRoot', 'FindMinimum', 'FindMaximum', 'NDSolve', 'NDSolveValue', 'Maximize', 'Minimize', 'NMaximize', 'NMinimize']);

const OPS = ['===', '=!=', '@@@', '//.', '^:=', '...', '|->', ':=', '==', '!=', '<=', '>=', '->', ':>', '/.', '//', '/@', '@@', '&&',
  '||', '<>', '++', '--', '+=', '-=', '*=', '/=', '^=', '/;', ';;', '~~', '=.', '@*', '/*', '<|', '|>', '..', '::', '**'];
const LETTER = /[\p{L}$]/u;
const WORD = /[\p{L}\p{N}$]/u;
const DIGIT = /[0-9]/;

export function tokenize(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  const push = (t, s, e, extra) => { const k = { t, s, e, v: code.slice(s, e) }; if (extra) Object.assign(k, extra); out.push(k); return k; };
  while (i < n) {
    const c = code[i];
    const s = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ') {
      while (i < n && /[ \t\n\r ]/.test(code[i])) i++;
      push('ws', s, i);
    } else if (c === '(' && code[i + 1] === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) {
        if (code[i] === '(' && code[i + 1] === '*') { depth++; i += 2; } else if (code[i] === '*' && code[i + 1] === ')') { depth--; i += 2; } else i++;
      }
      push('comment', s, i, { open: depth > 0 });
    } else if (c === '"') {
      i++;
      while (i < n && code[i] !== '"') i += code[i] === '\\' ? 2 : 1;
      const closed = i < n;
      i = Math.min(n, i + 1);
      push('string', s, i, { open: !closed });
    } else if (DIGIT.test(c) || (c === '.' && DIGIT.test(code[i + 1] || ''))) {
      while (i < n && DIGIT.test(code[i])) i++;
      if (code[i] === '^' && code[i + 1] === '^') { i += 2; while (i < n && /[0-9a-zA-Z.]/.test(code[i])) i++; }
      if (code[i] === '.' && code[i + 1] !== '.') { i++; while (i < n && DIGIT.test(code[i])) i++; }
      if (code[i] === '`') { i++; if (code[i] === '`') i++; while (i < n && /[0-9.]/.test(code[i])) i++; }
      if (code[i] === '*' && code[i + 1] === '^') { i += 2; if (code[i] === '-' || code[i] === '+') i++; while (i < n && DIGIT.test(code[i])) i++; }
      push('number', s, i);
    } else if (LETTER.test(c) || c === '_' || (c === '`' && LETTER.test(code[i + 1] || ''))) {
      while (i < n && (WORD.test(code[i]) || (code[i] === '`' && LETTER.test(code[i + 1] || '')))) i++;
      if (code[i] === '_') {
        const nameEnd = i;
        while (code[i] === '_') i++;
        push('pattern', s, i, { name: code.slice(s, nameEnd) });
        if (code[i] === '.' && !DIGIT.test(code[i + 1] || '')) { push('op', i, i + 1); i++; }
      } else push('symbol', s, i);
    } else if (c === '#') {
      i++;
      if (code[i] === '#') i++;
      while (i < n && WORD.test(code[i])) i++;
      push('slot', s, i);
    } else if (c === '\\' && code[i + 1] === '[') {
      const j = code.indexOf(']', i);
      i = j < 0 ? n : j + 1;
      push('named', s, i);
    } else if (c === '[' || c === '{' || c === '(') { i++; push('open', s, i); }
    else if (c === ']' || c === '}' || c === ')') { i++; push('close', s, i); }
    else {
      const op = OPS.find((o) => code.startsWith(o, i));
      i += op ? op.length : 1;
      push(/[-+*/^=<>!&|@~?:;,.'%]/.test(c) || op ? 'op' : 'other', s, i);
    }
  }
  return out;
}

const PAIR = { '[': ']', '{': '}', '(': ')' };

// Bracket matching + scoping analysis. Annotates tokens in place: .bad (unmatched bracket), .mate (index of the
// partner), .cls for symbols ('sys' | 'def' | 'undef' | 'local' | 'iter').
function analyse(tokens, defined) {
  const stack = [];
  const calls = []; // {head, open, close, args:[[from,to]…]} indices into tokens
  const prevSig = (k) => { for (let j = k - 1; j >= 0; j--) if (tokens[j].t !== 'ws' && tokens[j].t !== 'comment') return j; return -1; };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'open') {
      const p = prevSig(k);
      const call = { ch: t.v, open: k, close: -1, head: t.v === '[' && p >= 0 && tokens[p].t === 'symbol' ? tokens[p].v : null, commas: [] };
      stack.push(call);
    } else if (t.t === 'close') {
      let found = -1;
      for (let j = stack.length - 1; j >= 0; j--) if (PAIR[stack[j].ch] === t.v) { found = j; break; }
      if (found < 0) { t.bad = true; continue; }
      while (stack.length - 1 > found) tokens[stack.pop().open].bad = true;
      const call = stack.pop();
      call.close = k;
      tokens[call.open].mate = k; t.mate = call.open;
      if (call.head) calls.push(call);
    } else if (t.t === 'op' && t.v === ',' && stack.length) stack[stack.length - 1].commas.push(k);
  }
  for (const c of stack) tokens[c.open].bad = true;

  // statements = runs separated by newlines at bracket depth 0; pattern names are local to their statement
  let depth = 0; let start = 0;
  const flushStatement = (from, to) => {
    const names = new Set();
    for (let j = from; j < to; j++) if (tokens[j].t === 'pattern' && tokens[j].name) names.add(tokens[j].name);
    if (!names.size) return;
    for (let j = from; j < to; j++) if (tokens[j].t === 'symbol' && names.has(tokens[j].v)) tokens[j].cls = 'local';
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'open' && !t.bad) depth++;
    else if (t.t === 'close' && !t.bad) depth = Math.max(0, depth - 1);
    else if (t.t === 'ws' && depth === 0 && t.v.includes('\n')) { flushStatement(start, k); start = k + 1; }
  }
  flushStatement(start, tokens.length);

  const sig = (from, to) => { const r = []; for (let j = from; j < to; j++) if (tokens[j].t !== 'ws' && tokens[j].t !== 'comment') r.push(j); return r; };
  const paint = (names, from, to, cls) => {
    if (!names.size) return;
    for (let j = from; j <= to; j++) if (tokens[j].t === 'symbol' && names.has(tokens[j].v) && !tokens[j].cls) tokens[j].cls = cls;
  };
  for (const c of calls) {
    if (!SCOPING.has(c.head) && !ITERATING.has(c.head)) continue;
    const bounds = [c.open, ...c.commas, c.close];
    const args = [];
    for (let a = 0; a + 1 < bounds.length; a++) args.push(sig(bounds[a] + 1, bounds[a + 1]));
    if (SCOPING.has(c.head)) {
      const first = args[0] || [];
      const names = new Set();
      if (first.length === 1 && tokens[first[0]].t === 'symbol') names.add(tokens[first[0]].v);
      else if (first.length && tokens[first[0]].v === '{') {
        // {a, b = 1, c}: a symbol right after '{' or ',' at the list's own depth
        const close = tokens[first[0]].mate ?? c.close;
        let d = 0;
        for (let j = first[0]; j < close; j++) {
          const t = tokens[j];
          if (t.t === 'open') { d++; continue; }
          if (t.t === 'close') { d--; continue; }
          if (d === 1 && t.t === 'symbol') {
            const p = sig(first[0], j).pop();
            if (p !== undefined && (tokens[p].v === '{' || tokens[p].v === ',')) names.add(t.v);
          }
        }
      }
      paint(names, c.open, c.close, 'local');
    } else {
      const names = new Set();
      for (let a = 1; a < args.length; a++) {
        const g = args[a];
        if (g.length >= 3 && tokens[g[0]].v === '{' && tokens[g[1]].t === 'symbol' && tokens[g[2]].v === ',') names.add(tokens[g[1]].v);
        else if (g.length >= 4 && tokens[g[0]].v === '{' && tokens[g[1]].v === '{' && tokens[g[2]].t === 'symbol') names.add(tokens[g[2]].v);
      }
      paint(names, c.open, c.close, 'iter');
    }
  }
  for (const t of tokens) {
    if (t.t !== 'symbol' || t.cls) continue;
    const short = t.v.includes('`') ? t.v.slice(t.v.lastIndexOf('`') + 1) : t.v;
    if (SYSTEM.has(short) || t.v.startsWith('System`')) t.cls = 'sys';
    else t.cls = defined && defined.has(short) ? 'def' : 'undef';
  }
  return tokens;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

export function highlight(code, opts = {}) {
  const tokens = analyse(tokenize(code), opts.defined);
  // bracket pair next to the caret
  let m1 = -1; let m2 = -1;
  const caret = opts.caret;
  if (caret != null) {
    let rank = 9;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if ((t.t !== 'open' && t.t !== 'close') || t.mate == null) continue;
      const r = t.t === 'close' && t.e === caret ? 0 : t.t === 'open' && t.s === caret ? 1 : t.t === 'open' && t.e === caret ? 2 : t.t === 'close' && t.s === caret ? 3 : 9;
      if (r < rank) { rank = r; m1 = k; m2 = t.mate; }
    }
  }
  // Ghost typing (SPEC §11): everything from opts.ghostFrom on is "not written yet" (gray); opts.wrong is the
  // mistyped text shown (red underline) between the typed part and the ghost.
  const gf = opts.ghostFrom == null ? Infinity : opts.ghostFrom;
  const piece = (t, k, v) => {
    switch (t.t) {
      case 'comment': return `<span class="wl-c">${v}</span>`;
      case 'string': return `<span class="wl-s">${v}</span>`;
      case 'number': return `<span class="wl-n">${v}</span>`;
      case 'pattern': case 'slot': return `<span class="wl-p">${v}</span>`;
      case 'named': return `<span class="wl-k">${v}</span>`;
      case 'op': return `<span class="wl-o">${v}</span>`;
      case 'open': case 'close':
        return t.bad ? `<span class="wl-bad">${v}</span>` : (k === m1 || k === m2 ? `<span class="wl-b wl-match">${v}</span>` : `<span class="wl-b">${v}</span>`);
      case 'symbol':
        return t.cls === 'sys' || t.cls === 'def' ? `<span class="wl-k">${v}</span>`
          : t.cls === 'local' ? `<span class="wl-l">${v}</span>`
            : t.cls === 'iter' ? `<span class="wl-i">${v}</span>` : `<span class="wl-u">${v}</span>`;
      default: return v;
    }
  };
  let html = '';
  let ghost = '';
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.e <= gf) html += piece(t, k, esc(t.v));
    else if (t.s >= gf) ghost += esc(t.v);
    else { html += piece(t, k, esc(t.v.slice(0, gf - t.s))); ghost += esc(t.v.slice(gf - t.s)); }
  }
  if (opts.wrong) html += `<span class="wl-wrong">${esc(opts.wrong)}</span>`;
  if (ghost) html += `<span class="wl-ghost">${ghost}</span>`;
  return html;
}

// Symbol under / just before a caret position (for autocomplete and F1 help).
export function symbolAt(code, pos) {
  let s = pos; let e = pos;
  while (s > 0 && WORD.test(code[s - 1])) s--;
  while (e < code.length && WORD.test(code[e])) e++;
  if (s === e || !LETTER.test(code[s])) return null;
  return { name: code.slice(s, e), start: s, end: e };
}

// Names of the System symbols used in a piece of code (handy for "commands practised" bookkeeping).
export function systemSymbolsIn(code) {
  const seen = new Set();
  for (const t of tokenize(code)) if (t.t === 'symbol' && SYSTEM.has(t.v)) seen.add(t.v);
  return [...seen];
}
