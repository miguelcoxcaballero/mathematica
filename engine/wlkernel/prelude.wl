(* Wolfram-level definitions completing Mathics3 for the course material *)

(*PUBLIC: LaplaceTransform InverseLaplaceTransform Grad Div Laplacian CharacteristicPolynomial Orthogonalize Projection Minors NestWhileList SetPrecision HeavisideTheta DiracDelta UnitStep DiscreteDelta Integrate Limit Simplify FullSimplify Refine Convolve Ordering ReIm FromDMS Hessian Curl Normalize VectorAngle EuclideanDistance Cofactor Adjugate UnitVector AbsArg Assuming ArcLength MatrixPower PositiveDefiniteMatrixQ SymmetricMatrixQ DiagonalizableMatrixQ Accumulate Variables Maximize Minimize NMaximize NMinimize FindMaximum UnitBox UnitTriangle Ramp Subsets ComplexExpand ToPolarCoordinates FromPolarCoordinates CoordinateTransform TrigToExp ExpToTrig Magnify Style Framed Labeled Rasterize Quiet Series ColorData Erfi SinIntegral CosIntegral SinhIntegral CoshIntegral LogIntegral Sinc KroneckerDelta Surd TrigExpand FunctionExpand PolynomialGCD PolynomialLCM NSum RSolve RecurrenceTable DSolveValue NDSolveValue Wronskian SolveAlways AsymptoticDSolveValue ArrayFlatten Differences Clip Rescale UpperTriangularize LowerTriangularize RotationMatrix HilbertMatrix MinValue MaxValue ArgMin ArgMax NMinValue NMaxValue NArgMin NArgMax DiagonalMatrixQ Expand PowerExpand Collect Sum Join LinearSolve Needs Subscript D Mod Factorial2 Solve NSolve FindRoot NIntegrate Residue Eliminate ZTransform InverseZTransform MatrixRank NullSpace Abs Arg Dt PrincipalValue LeastSquares Cartesian *)
Unprotect[Maximize, Minimize, Solve, LaplaceTransform, InverseLaplaceTransform, Grad, Div, Laplacian, CharacteristicPolynomial, Orthogonalize, Projection, Minors, NestWhileList, SetPrecision, HeavisideTheta, DiracDelta, UnitStep, DiscreteDelta, Integrate, Limit, Simplify, FullSimplify, Refine, Convolve, Ordering, ReIm, FromDMS, Hessian, Curl, Normalize, VectorAngle, EuclideanDistance, Cofactor, Adjugate, UnitVector, AbsArg, Assuming, ArcLength, MatrixPower, PositiveDefiniteMatrixQ, SymmetricMatrixQ, DiagonalizableMatrixQ, Accumulate, Variables, Maximize, Minimize, NMaximize, NMinimize, FindMaximum, UnitBox, UnitTriangle, Ramp, Subsets, ComplexExpand, ToPolarCoordinates, FromPolarCoordinates, CoordinateTransform, TrigToExp, ExpToTrig, Magnify, Style, Framed, Labeled, Rasterize, Quiet, Series];


(* ---- step / delta functions ---- *)
HeavisideTheta[x_?NumericQ] := Which[x > 0, 1, x < 0, 0, True, HeavisideTheta[0]] /; Im[x] == 0 && x != 0;
SetAttributes[HeavisideTheta, Listable];
DiracDelta[x_?NumericQ] := 0 /; x != 0;
DiscreteDelta[0] = 1; DiscreteDelta[x_?NumericQ] := 0 /; x != 0;
DiscreteDelta[a_, b__] := DiscreteDelta[a] DiscreteDelta[b];
UnitBox[x_?NumericQ] := If[Abs[x] <= 1/2, 1, 0];
UnitTriangle[x_?NumericQ] := If[Abs[x] <= 1, 1 - Abs[x], 0];
Ramp[x_?NumericQ] := If[x >= 0, x, 0];
Derivative[1][HeavisideTheta] = DiracDelta;
Derivative[1][UnitStep] = DiracDelta;

(* ---- Laplace ---- *)
LaplaceTransform[a_ + b_, t_, s_] := LaplaceTransform[a, t, s] + LaplaceTransform[b, t, s];
LaplaceTransform[c_ f_, t_, s_] := c LaplaceTransform[f, t, s] /; FreeQ[c, t] && !FreeQ[f, t];
LaplaceTransform[c_, t_, s_] := c/s /; FreeQ[c, t];
LaplaceTransform[Derivative[n_Integer][y_][t_], t_, s_] :=
  s^n LaplaceTransform[y[t], t, s] - Sum[s^(n - 1 - k) Derivative[k][y][0], {k, 0, n - 1}] /; AtomQ[y];
LaplaceTransform[eq_Equal, t_, s_] := LaplaceTransform[#, t, s] & /@ eq;
LaplaceTransform[l_List, t_, s_] := LaplaceTransform[#, t, s] & /@ l;
LaplaceTransform[Integrate[f_, {u_, 0, t_}], t_, s_] := LaplaceTransform[f /. u -> t, t, s]/s /; FreeQ[f, t];

WLX`unk[g_] := !FreeQ[g, _Integrate] || !FreeQ[g, Derivative[__][_][__]] || !FreeQ[g, _LaplaceTransform] || !FreeQ[g, (h_Symbol /; Context[h] =!= "System`")[__]];
LaplaceTransform[E^(a_. t_) g_, t_, s_] := (LaplaceTransform[g, t, WLX`ss] /. WLX`ss -> s - a) /; FreeQ[a, t] && WLX`unk[g];
LaplaceTransform[t_^n_. g_, t_, s_] := (-1)^n D[LaplaceTransform[g, t, s], {s, n}] /; IntegerQ[n] && n > 0 && WLX`unk[g];
LaplaceTransform[InverseLaplaceTransform[f_, s_, t_], t_, s2_] := f /. s -> s2;

InverseLaplaceTransform[a_ + b_, s_, t_] := InverseLaplaceTransform[a, s, t] + InverseLaplaceTransform[b, s, t] /; WLX`unk[{a, b}];
InverseLaplaceTransform[c_ f_, s_, t_] := c InverseLaplaceTransform[f, s, t] /; FreeQ[c, s] && !FreeQ[f, s];
InverseLaplaceTransform[c_, s_, t_] := c DiracDelta[t] /; FreeQ[c, s];
InverseLaplaceTransform[l_List, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ l;
InverseLaplaceTransform[r_Rule, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ r;
InverseLaplaceTransform[r_Equal, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ r;
InverseLaplaceTransform[LaplaceTransform[f_, t_, s_], s_, t2_] := f /. t -> t2;
InverseLaplaceTransform[f_, s_Symbol, t_] := InverseLaplaceTransform[Expand[f], s, t] /; !FreeQ[f, _LaplaceTransform] && Head[f] =!= Plus && Head[Expand[f]] === Plus;

(* ---- vector calculus ---- *)
Grad[f_, vars_List] := D[f, #] & /@ vars /; !ListQ[f];
Grad[f_List, vars_List] := Outer[D, f, vars];
Div[f_List, vars_List] := Total[MapThread[D, {f, vars}]] /; Length[f] == Length[vars];
Laplacian[f_, vars_List] := Total[D[f, {#, 2}] & /@ vars];
Curl[{f1_, f2_}, {x_, y_}] := D[f2, x] - D[f1, y];
Curl[{f1_, f2_, f3_}, {x_, y_, z_}] := {D[f3, y] - D[f2, z], D[f1, z] - D[f3, x], D[f2, x] - D[f1, y]};
Hessian[f_, vars_List] := Outer[D[f, #1, #2] &, vars, vars];

(* ---- linear algebra ---- *)
CharacteristicPolynomial[m_List, x_] := Det[m - x IdentityMatrix[Length[m]]];
Projection[u_List, v_List] := (Conjugate[v] . u)/(Conjugate[v] . v) v;
Orthogonalize[vs_List] := Module[{basis = {}, w},
   Do[w = v - Sum[Projection[v, b], {b, basis}]; w = Simplify[w];
     If[!(And @@ (PossibleZeroQ /@ w)), AppendTo[basis, Simplify[w/Sqrt[Simplify[w . Conjugate[w]]]]], AppendTo[basis, 0 w]],
     {v, vs}]; basis] /; MatrixQ[vs];
Orthogonalize[vs_List, f_] := Module[{basis = {}, w},
   Do[w = v - Sum[f[v, b]/f[b, b] b, {b, basis}]; w = Simplify[w];
     AppendTo[basis, Simplify[w/Sqrt[f[w, w]]]], {v, vs}]; basis];
Normalize[v_List] := With[{n = Norm[v]}, If[PossibleZeroQ[n], v, v/n]];
VectorAngle[u_List, v_List] := ArcCos[(u . v)/(Norm[u] Norm[v])];
EuclideanDistance[u_, v_] := Norm[u - v];
Minors[m_List] := Minors[m, Length[m] - 1];
Minors[m_List, k_Integer] := With[{r = Subsets[Range[Length[m]], {k}], c = Subsets[Range[Length[First[m]]], {k}]},
   Table[Det[m[[i, j]]], {i, r}, {j, c}]];
Adjugate[m_List] := Module[{n = Length[m]}, Transpose[Table[(-1)^(i + j) Det[Drop[m, {i}, {j}]], {i, n}, {j, n}]]];
UnitVector[n_Integer, k_Integer] := Table[If[i == k, 1, 0], {i, n}];
SymmetricMatrixQ[m_] := MatrixQ[m] && m === Transpose[m];
PositiveDefiniteMatrixQ[m_] := MatrixQ[m] && And @@ (# > 0 & /@ N[Eigenvalues[m]]);
DiagonalizableMatrixQ[m_] := MatrixQ[m] && MatrixRank[Eigenvectors[m]] == Length[m];

(* ---- iteration helpers ---- *)
NestWhileList[f_, x_, test_] := NestWhileList[f, x, test, 1, Infinity];
NestWhileList[f_, x_, test_, m_Integer] := NestWhileList[f, x, test, m, Infinity];
NestWhileList[f_, x_, test_, m_Integer, max_] := Module[{l = {x}, n = 0},
   While[n < max && (Length[l] < m || TrueQ[test @@ Take[l, -m]]), AppendTo[l, f[Last[l]]]; n++]; l];
NestWhileList[f_, x_, test_, All, max_ : Infinity] := Module[{l = {x}, n = 0},
   While[n < max && TrueQ[test @@ l], AppendTo[l, f[Last[l]]]; n++]; l];
SetPrecision[x_, p_] := N[x, p];
Ordering[l_List] := SortBy[Range[Length[l]], l[[#]] &];
Ordering[l_List, n_Integer] := If[n >= 0, Take[Ordering[l], n], Take[Ordering[l], n]];
ReIm[z_] := {Re[z], Im[z]};
AbsArg[z_] := {Abs[z], Arg[z]};
FromDMS[{d_, m_, s_}] := d + m/60 + s/3600;
FromDMS[{d_, m_}] := d + m/60;
FromDMS[d_?NumericQ] := d;
ToPolarCoordinates[{x_, y_}] := {Sqrt[x^2 + y^2], ArcTan[x, y]};
FromPolarCoordinates[{r_, t_}] := {r Cos[t], r Sin[t]};
Convolve[f_, g_, x_, y_] /; WLX`ConvolveQ[f, g, x, y] := WLX`ConvolveGet[];
Convolve[f_, g_, x_, y_] := Integrate[(f /. x -> WLX`u) (g /. x -> y - WLX`u), {WLX`u, -Infinity, Infinity}];

(* ---- algebra / misc builtins missing or weak in Mathics ---- *)
Unprotect[Expand, PowerExpand, Collect, Sum, Join, LinearSolve, Needs, Subscript, Mod, Factorial2, D, Transpose];
Transpose[{v_List}] := List /@ v /; VectorQ[v, !ListQ[#] &];
HoldPattern[Expand[e_, Trig -> True]] /; WLX`ExpandTrigQ[e] := WLX`ExpandTrigGet[];
HoldPattern[Expand[e_]] /; (!FreeQ[e, Power[_, _?(!IntegerQ[#] &)]] || !FreeQ[e, _Sin | _Cos | _Log | _Tan | _Sinh | _Cosh]) && WLX`ExpandQ[e] := WLX`ExpandGet[];
HoldPattern[PowerExpand[e_]] /; WLX`PowerExpandQ[e] := WLX`PowerExpandGet[];
Collect[a_ == b_, x__] := Collect[a, x] == Collect[b, x];
Sum[f_, {i_Symbol, a_Integer, b_Integer}] := Total[Table[f, {i, a, b}]] /; b - a < 5000;
Sum[f_, {i_Symbol, b_Integer}] := Total[Table[f, {i, 1, b}]] /; b < 5000;
Sum[f_, {i_Symbol, a_, b_}] /; (b === Infinity || !NumericQ[b] || !NumericQ[a]) && FreeQ[{a, b}, i] && WLX`SumQ[f, {i, a, b}] := WLX`SumGet[];
Join[a_List, b_List, 2] := MapThread[Join, {a, b}];
Join[a_List, b_List, c_List, 2] := MapThread[Join, {a, b, c}];
ArrayFlatten[m_List] := Join @@ (MapThread[Join, #] & /@ m) /; MatrixQ[m, MatrixQ];
LinearSolve[m_?MatrixQ, b_?MatrixQ] := Transpose[LinearSolve[m, #] & /@ Transpose[b]];
Needs[_String] := Null;
Mod[m_Real | m_Rational, n_Integer | n_Rational | n_Real] := m - n Floor[m/n];
Mod[m_Integer, n_Rational | n_Real] := m - n Floor[m/n];
Factorial2[n_Integer] := Product[WLX`k, {WLX`k, n, 1, -2}] /; n >= 0;
Differences[l_List] := Rest[l] - Most[l];
Differences[l_List, n_Integer] := Nest[Differences, l, n];
Clip[x_?NumericQ] := Clip[x, {-1, 1}];
Clip[x_?NumericQ, {a_, b_}] := Which[x < a, a, x > b, b, True, x];
Clip[l_List, r___] := Clip[#, r] & /@ l;
Rescale[x_, {a_, b_}] := (x - a)/(b - a);
Rescale[x_, {a_, b_}, {c_, d_}] := c + (x - a) (d - c)/(b - a);
UpperTriangularize[m_?MatrixQ] := Table[If[j >= i, m[[i, j]], 0], {i, Length[m]}, {j, Length[First[m]]}];
LowerTriangularize[m_?MatrixQ] := Table[If[j <= i, m[[i, j]], 0], {i, Length[m]}, {j, Length[First[m]]}];
RotationMatrix[t_] := {{Cos[t], -Sin[t]}, {Sin[t], Cos[t]}};
RotationMatrix[t_, {0, 0, 1}] := {{Cos[t], -Sin[t], 0}, {Sin[t], Cos[t], 0}, {0, 0, 1}};
RotationMatrix[t_, {1, 0, 0}] := {{1, 0, 0}, {0, Cos[t], -Sin[t]}, {0, Sin[t], Cos[t]}};
RotationMatrix[t_, {0, 1, 0}] := {{Cos[t], 0, Sin[t]}, {0, 1, 0}, {-Sin[t], 0, Cos[t]}};
HilbertMatrix[n_Integer] := Table[1/(i + j - 1), {i, n}, {j, n}];
DiagonalMatrixQ[m_] := MatrixQ[m] && m === DiagonalMatrix[Diagonal[m]];
MinValue[f_, v_] := First[Minimize[f, v]]; MaxValue[f_, v_] := First[Maximize[f, v]];
ArgMin[f_, v_] := (If[ListQ[v], v, {v}] /. Last[Minimize[f, v]]) // If[ListQ[v], #, First[#]] &;
ArgMax[f_, v_] := (If[ListQ[v], v, {v}] /. Last[Maximize[f, v]]) // If[ListQ[v], #, First[#]] &;
NMinValue[f_, v_] := First[NMinimize[f, v]]; NMaxValue[f_, v_] := First[NMaximize[f, v]];
Wronskian[fs_List, x_] := Det[Table[D[fs, {x, k}], {k, 0, Length[fs] - 1}]];
WLX`first[r : {_List, ___}, y_] := y /. First[r];
DSolveValue[eq_, y_, x_] := WLX`first[DSolve[eq, y, x], y];
NDSolveValue[eq_, y_, x_] := WLX`first[NDSolve[eq, y, x], y];
SolveAlways[a_ == b_, x_] := Solve[Thread[CoefficientList[Expand[a - b], x] == 0]];
AsymptoticDSolveValue[eqs_, y_[x_], {x_, x0_, n_Integer}] := Module[{eq, ics, ser, res, ord, ceqs, vars, sol, fn},
   eq = Select[Flatten[{eqs}], !FreeQ[#, x] &]; ics = Select[Flatten[{eqs}], FreeQ[#, x] &];
   ser = Sum[WLX`a[k] (x - x0)^k, {k, 0, n}];
   fn = Function @@ {x, ser};
   res = (eq[[1, 1]] - eq[[1, 2]]) /. y -> fn;
   ord = Max[Cases[eq, Derivative[m_][y][_] :> m, Infinity], 1];
   ceqs = CoefficientList[Expand[res /. x -> x + x0], x];
   ceqs = Thread[Take[ceqs, Min[Length[ceqs], n + 1 - ord]] == 0];
   If[ics === {}, ics = Table[(D[y[x], {x, k}] /. x -> x0) == C[k + 1], {k, 0, ord - 1}]];
   ceqs = Join[ceqs, ics /. y -> fn];
   vars = Table[WLX`a[k], {k, 0, n}];
   sol = Solve[ceqs, vars];
   If[ListQ[sol] && sol =!= {}, Expand[ser /. First[sol]], $Failed]];
Cofactor[m_?MatrixQ, {i_Integer, j_Integer}] := (-1)^(i + j) Det[Drop[m, {i}, {j}]];
D[(f : Erfi | SinIntegral | CosIntegral | SinhIntegral | CoshIntegral | LogIntegral)[u_], x_Symbol] := Switch[f, Erfi, 2 E^(u^2)/Sqrt[Pi], SinIntegral, Sin[u]/u, CosIntegral, Cos[u]/u, SinhIntegral, Sinh[u]/u, CoshIntegral, Cosh[u]/u, LogIntegral, 1/Log[u]] D[u, x];
Protect[Expand, PowerExpand, Collect, Sum, Join, LinearSolve, Needs, Mod, Factorial2, D, Transpose];

(* ---- complex numbers: Mathics' Abs drops the bars of products (Abs[-x] -> x) and mishandles exact complexes ---- *)
Unprotect[Abs, Arg];
Abs[c_?NumericQ x_] := Abs[c] Abs[x] /; !NumericQ[x];
Abs[z_?NumericQ] := With[{r = WLX`NAbs[z]}, If[r === $Failed, Sqrt[Re[z]^2 + Im[z]^2], r]] /; !MatchQ[z, _Integer | _Rational | _Real | Complex[_Integer | _Rational | _Real, _Integer | _Rational | _Real]] && Precision[z] === Infinity;
Abs[z_?NumericQ] := Abs[N[z]] /; !MatchQ[z, _Integer | _Rational | _Real | _Complex] && Precision[z] =!= Infinity;
Arg[z_?NumericQ] := With[{r = WLX`NArg[z]}, If[r === $Failed, ArcTan[Re[z], Im[z]], r]] /; Precision[z] === Infinity && !MatchQ[z, _Integer | _Rational];
Protect[Abs, Arg];

Unprotect[MatrixRank, NullSpace, ZTransform, InverseZTransform];
HoldPattern[MatrixRank[m_?MatrixQ]] := WLX`NRank[m] /; !FreeQ[m, _Real];
HoldPattern[NullSpace[m_?MatrixQ]] /; !TrueQ[WLX`$inNS] && FreeQ[m, _Real] := Block[{WLX`$inNS = True}, (# (LCM @@ Denominator[#])) & /@ NullSpace[m]] /; MatrixQ[m, IntegerQ[#] || Head[#] === Rational &];
ZTransform[a_ + b_, n_, z_] := ZTransform[a, n, z] + ZTransform[b, n, z] /; WLX`unk[{a, b}] || !FreeQ[{a, b}, _Subscript | _DiscreteDelta];
ZTransform[c_ f_, n_, z_] := c ZTransform[f, n, z] /; FreeQ[c, n] && !FreeQ[f, n] && (WLX`unk[f] || !FreeQ[f, _Subscript | _DiscreteDelta]);
ZTransform[eq_Equal, n_, z_] := ZTransform[#, n, z] & /@ eq;
ZTransform[l_List, n_, z_] := ZTransform[#, n, z] & /@ l;
ZTransform[DiscreteDelta[n_ + k_.], n_, z_] := z^k /; IntegerQ[k] && k <= 0;
ZTransform[(y_Symbol /; Context[y] =!= "System`")[n_ + k_Integer], n_, z_] := z^k ZTransform[y[n], n, z] - Sum[z^(k - WLX`j) y[WLX`j], {WLX`j, 0, k - 1}] /; k > 0;
ZTransform[Subscript[y_, n_ + k_Integer], n_, z_] := z^k ZTransform[Subscript[y, n], n, z] - Sum[z^(k - WLX`j) Subscript[y, WLX`j], {WLX`j, 0, k - 1}] /; k > 0;
InverseZTransform[ZTransform[f_, n_, z_], z_, n2_] := f /. n -> n2;
InverseZTransform[r_Rule, z_, n_] := InverseZTransform[#, z, n] & /@ r;
InverseZTransform[l_List, z_, n_] := InverseZTransform[#, z, n] & /@ l;
Protect[MatrixRank, NullSpace, ZTransform, InverseZTransform];

Unprotect[Derivative];
HoldPattern[Derivative[n_Integer][f_Symbol]] /; WLX`DerivQ[f, n] := WLX`DerivGet[];

Unprotect[Normal];
HoldPattern[Normal[SeriesData[x_, DirectedInfinity[1], c_List, nmin_, nmax_, den_]]] := Total[Table[c[[WLX`k]] x^(-(nmin + WLX`k - 1)/den), {WLX`k, Length[c]}]];
Normal[e_] := (e /. s_SeriesData :> Normal[s]) /; Head[e] =!= SeriesData && !FreeQ[e, SeriesData[_, DirectedInfinity[1], __]];
Protect[Normal];

Unprotect[LeastSquares];
HoldPattern[LeastSquares[a_?MatrixQ, b_List]] := PseudoInverse[a] . b;
Protect[LeastSquares];
Curl[f_, Cartesian[x_, y_, z_]] := Curl[f, {x, y, z}];
Div[f_, Cartesian[x_, y_, z_]] := Div[f, {x, y, z}];
Grad[f_, Cartesian[x_, y_, z_]] := Grad[f, {x, y, z}];
Laplacian[f_, Cartesian[x_, y_, z_]] := Laplacian[f, {x, y, z}];

Unprotect[Eigenvalues, Eigenvectors, Eigensystem];
HoldPattern[Eigenvalues[m_?MatrixQ]] /; WLX`EigQ[m, 1] := WLX`EigGet[];
HoldPattern[Eigenvectors[m_?MatrixQ]] /; WLX`EigQ[m, 2] := WLX`EigGet[];
HoldPattern[Eigensystem[m_?MatrixQ]] /; WLX`EigQ[m, 3] := WLX`EigGet[];
Protect[Eigenvalues, Eigenvectors, Eigensystem];

(* ---- calculus fixes ---- *)
SetAttributes[C, NHoldAll];
Unprotect[D];
D[a_ == b_, x__] := D[a, x] == D[b, x];
D[f_List, {v_List}] := Table[D[fi, vj], {fi, f}, {vj, v}] /; VectorQ[f, !ListQ[#] &];
D[HoldPattern[Sum[f_, it__List]], x_Symbol] := Sum[Evaluate[D[f, x]], it] /; FreeQ[{it}, x];
D[HoldPattern[Sum[f_, it__List]], {x_Symbol, n_Integer}] := Sum[Evaluate[D[f, {x, n}]], it] /; FreeQ[{it}, x];
D[HoldPattern[Integrate[f_, {t_, a_, b_}]], x_Symbol] := (f /. t -> b) D[b, x] - (f /. t -> a) D[a, x] + Integrate[D[f, x], {t, a, b}] /; t =!= x;
Derivative[1][Erfi] = (2 E^(#^2)/Sqrt[Pi]) &;
Protect[D];
Series[f_, {x_Symbol, x0_, n_Integer}] /; WLX`SeriesQ[f, x, x0, n] := WLX`SeriesGet[];
Integrate[f_, a_List, b__List] := Integrate[Integrate[f, b], a];
Integrate[f_List, a__] := Integrate[#, a] & /@ f;
Integrate::idiv = "Integral of `1` does not converge on `2`.";
Sum::div = "Sum does not converge.";
Integrate[f_, {x_Symbol, a_, b_}, o1___Rule, PrincipalValue -> True, o2___Rule] /; WLX`IntPVQ[f, {x, a, b}] := WLX`IntGet[];
Integrate[f_, a__, opts__Rule] := With[{as = Assumptions /. {opts} /. Assumptions -> True},
   WLX`StripCond[Block[{$Assumptions = $Assumptions && as}, Integrate[f, a]], as,
     (GenerateConditions /. {opts} /. GenerateConditions -> Automatic) === False]];
WLX`StripCond[ConditionalExpression[v_, _], as_, gc_] := If[as === True, v, Simplify[v, as]] /; as =!= True || gc;
WLX`StripCond[v_, as_, gc_] := v;
N[HoldPattern[Integrate[Integrate[Integrate[f_, c_List], b_List], a_List]], ___] := NIntegrate[f, a, b, c];
N[HoldPattern[Integrate[Integrate[f_, b_List], a_List]], ___] := NIntegrate[f, a, b];
N[HoldPattern[Integrate[f_, l__List]], ___] := NIntegrate[f, l];
Integrate[f_, x_Symbol] /; WLX`IntQ[f, x, True] := WLX`IntGet[];
Integrate[f_, {x_Symbol, a_, b_}] /; WLX`IntQ[f, {x, a, b}, True] := WLX`IntGet[];
ClearAttributes[Limit, Listable];
HoldPattern[Limit[f_, x_Symbol -> a_]] /; WLX`LimitQ[f, x, a, 0, True] := WLX`LimitGet[];
HoldPattern[Limit[f_, x_Symbol -> a_, opts__Rule]] /; WLX`LimitQ[f, x, a, Direction /. {opts} /. Direction -> 0, Assumptions /. {opts} /. Assumptions -> True] := WLX`LimitGet[];
Limit[f_, x_ -> a_, Direction -> "FromAbove"] := Limit[f, x -> a, Direction -> -1];
Limit[f_, x_ -> a_, Direction -> "FromBelow"] := Limit[f, x -> a, Direction -> 1];
Limit[f_, x_ -> a_, Direction -> "TwoSided"] := Limit[f, x -> a];
Limit[f_, x_ -> a_, Assumptions -> _] := Limit[f, x -> a];
Limit[f_List, r_, o___] := Limit[#, r, o] & /@ f;
Limit[f_, {r1_Rule, r2__Rule}] := Limit[Limit[f, r1], {r2}];
Limit[f_, {r1_Rule}] := Limit[f, r1];

Simplify[e_] := WLX`SimplifyAssuming[e, True] /; $Assumptions =!= True;
FullSimplify[e_] := WLX`SimplifyAssuming[e, True] /; $Assumptions =!= True;
Simplify[e_, as_] := WLX`SimplifyAssuming[e, as] /; FreeQ[as, Rule] && as =!= {};
Simplify[e_, Assumptions -> as_] := WLX`SimplifyAssuming[e, as];
FullSimplify[e_, as_] := WLX`SimplifyAssuming[e, as] /; FreeQ[as, Rule] && as =!= {};
FullSimplify[e_, Assumptions -> as_] := WLX`SimplifyAssuming[e, as];
Refine[e_, as_] := WLX`SimplifyAssuming[e, as];

Maximize[a__] /; !TrueQ[WLX`$inOpt] := Block[{WLX`$inOpt = True}, Maximize[a] /. {{v_, r : {___Rule}}} :> {v, r}];
Minimize[a__] /; !TrueQ[WLX`$inOpt] := Block[{WLX`$inOpt = True}, Minimize[a] /. {{v_, r : {___Rule}}} :> {v, r}];
Unprotect[Get]; Get[s_String] := Null /; StringMatchQ[s, "*`"]; Protect[Get];
NMinimize[f_, v_, ___] := N[Minimize[f, v]] /. {{a_, b_List}} :> {a, b};
NMaximize[f_, v_, ___] := N[Maximize[f, v]] /. {{a_, b_List}} :> {a, b};

TrigToExp[e_] := e /. {Sin[x_] :> (E^(I x) - E^(-I x))/(2 I), Cos[x_] :> (E^(I x) + E^(-I x))/2,
    Tan[x_] :> -I (E^(I x) - E^(-I x))/(E^(I x) + E^(-I x)), Sinh[x_] :> (E^x - E^(-x))/2, Cosh[x_] :> (E^x + E^(-x))/2};
ExpToTrig[e_] := e /. {E^(x_) :> Cosh[x] + Sinh[x]} /. {Cosh[Complex[0, a_] x_.] :> Cos[a x], Sinh[Complex[0, a_] x_.] :> I Sin[a x]};

Magnify[g_, ___] := g;
Rasterize[g_, ___] := g;
Quiet[e_, ___] := e /; False;

Protect[LaplaceTransform, InverseLaplaceTransform, Grad, Div, Laplacian, CharacteristicPolynomial,
  Orthogonalize, Projection, Minors, NestWhileList, SetPrecision, HeavisideTheta, DiracDelta,
  DiscreteDelta, Integrate, Limit, Simplify, FullSimplify, Refine];
