(* Wolfram-level definitions completing Mathics3 for the course material *)

(*PUBLIC: LaplaceTransform InverseLaplaceTransform Grad Div Laplacian CharacteristicPolynomial Orthogonalize Projection Minors NestWhileList SetPrecision HeavisideTheta DiracDelta UnitStep DiscreteDelta Integrate Limit Simplify FullSimplify Refine Convolve Ordering ReIm FromDMS Hessian Curl Normalize VectorAngle EuclideanDistance Cofactor Adjugate UnitVector AbsArg Assuming ArcLength MatrixPower PositiveDefiniteMatrixQ SymmetricMatrixQ DiagonalizableMatrixQ Accumulate Variables Maximize Minimize NMaximize NMinimize FindMaximum UnitBox UnitTriangle Ramp Subsets ComplexExpand ToPolarCoordinates FromPolarCoordinates CoordinateTransform TrigToExp ExpToTrig Magnify Style Framed Labeled Rasterize Quiet Series ColorData *)
Unprotect[Solve, LaplaceTransform, InverseLaplaceTransform, Grad, Div, Laplacian, CharacteristicPolynomial, Orthogonalize, Projection, Minors, NestWhileList, SetPrecision, HeavisideTheta, DiracDelta, UnitStep, DiscreteDelta, Integrate, Limit, Simplify, FullSimplify, Refine, Convolve, Ordering, ReIm, FromDMS, Hessian, Curl, Normalize, VectorAngle, EuclideanDistance, Cofactor, Adjugate, UnitVector, AbsArg, Assuming, ArcLength, MatrixPower, PositiveDefiniteMatrixQ, SymmetricMatrixQ, DiagonalizableMatrixQ, Accumulate, Variables, Maximize, Minimize, NMaximize, NMinimize, FindMaximum, UnitBox, UnitTriangle, Ramp, Subsets, ComplexExpand, ToPolarCoordinates, FromPolarCoordinates, CoordinateTransform, TrigToExp, ExpToTrig, Magnify, Style, Framed, Labeled, Rasterize, Quiet, Series];


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
LaplaceTransform[DiracDelta[t_ - a_.], t_, s_] := Exp[-a s] /; FreeQ[a, t];
LaplaceTransform[DiracDelta[t_ - a_.] f_, t_, s_] := Exp[-a s] (f /. t -> a) /; FreeQ[a, t];
LaplaceTransform[eq_Equal, t_, s_] := LaplaceTransform[#, t, s] & /@ eq;
LaplaceTransform[l_List, t_, s_] := LaplaceTransform[#, t, s] & /@ l;
LaplaceTransform[Integrate[f_, {u_, 0, t_}], t_, s_] := LaplaceTransform[f /. u -> t, t, s]/s /; FreeQ[f, t];

InverseLaplaceTransform[a_ + b_, s_, t_] := InverseLaplaceTransform[a, s, t] + InverseLaplaceTransform[b, s, t] /; !FreeQ[{a, b}, Exp[_. s]] || !FreeQ[{a,b}, E^(_. s)];
InverseLaplaceTransform[c_ f_, s_, t_] := c InverseLaplaceTransform[f, s, t] /; FreeQ[c, s] && !FreeQ[f, s];
InverseLaplaceTransform[c_, s_, t_] := c DiracDelta[t] /; FreeQ[c, s];
InverseLaplaceTransform[E^(a_ s_) f_., s_, t_] := (HeavisideTheta[t + a] (InverseLaplaceTransform[f, s, t] /. t -> t + a)) /; FreeQ[a, s] && NumericQ[a] && a < 0;
InverseLaplaceTransform[l_List, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ l;
InverseLaplaceTransform[r_Rule, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ r;
InverseLaplaceTransform[r_Equal, s_, t_] := InverseLaplaceTransform[#, s, t] & /@ r;
InverseLaplaceTransform[LaplaceTransform[f_, t_, s_], s_, t2_] := f /. t -> t2;
InverseLaplaceTransform[f_, s_Symbol, t_] := InverseLaplaceTransform[Expand[f], s, t] /; !FreeQ[f, E^(_. s)] && Head[f] =!= Plus && Head[Expand[f]] === Plus;

(* ---- vector calculus ---- *)
Grad[f_, vars_List] := D[f, #] & /@ vars /; !ListQ[f];
Grad[f_List, vars_List] := Outer[D, f, vars];
Div[f_List, vars_List] := Sum[D[f[[i]], vars[[i]]], {i, Length[vars]}] /; Length[f] == Length[vars];
Laplacian[f_, vars_List] := Sum[D[f, {vars[[i]], 2}], {i, Length[vars]}];
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
Convolve[f_, g_, x_, y_] := Integrate[(f /. x -> WLX`u) (g /. x -> y - WLX`u), {WLX`u, -Infinity, Infinity}];

(* ---- calculus fixes ---- *)
Solve[a_List == b_List, v_, o___] := Solve[Thread[a == b], v, o] /; Length[a] == Length[b];
Solve[{a_List == b_List}, v_, o___] := Solve[Thread[a == b], v, o] /; Length[a] == Length[b];
Series[f_, {x_Symbol, x0_, n_Integer}] /; WLX`SeriesQ[f, x, x0, n] := WLX`SeriesGet[];
Integrate[f_, a_List, b__List] := Integrate[Integrate[f, b], a];
Integrate[f_List, a__] := Integrate[#, a] & /@ f;
Integrate[f_, a__, opts__Rule] := With[{as = Assumptions /. {opts} /. Assumptions -> True},
   WLX`StripCond[Block[{$Assumptions = $Assumptions && as}, Integrate[f, a]], as,
     (GenerateConditions /. {opts} /. GenerateConditions -> Automatic) === False]];
WLX`StripCond[ConditionalExpression[v_, _], as_, gc_] := If[as === True, v, Simplify[v, as]] /; as =!= True || gc;
WLX`StripCond[v_, as_, gc_] := v;
Integrate[f_, x_Symbol] /; WLX`IntQ[f, x, True] := WLX`IntGet[];
Integrate[f_, {x_Symbol, a_, b_}] /; WLX`IntQ[f, {x, a, b}, True] := WLX`IntGet[];
Limit[f_, x_ -> a_, Direction -> "FromAbove"] := Limit[f, x -> a, Direction -> -1];
Limit[f_, x_ -> a_, Direction -> "FromBelow"] := Limit[f, x -> a, Direction -> 1];
Limit[f_, x_ -> a_, Direction -> "TwoSided"] := Limit[f, x -> a];
Limit[f_, x_ -> a_, Assumptions -> _] := Limit[f, x -> a];
Limit[f_List, r_, o___] := Limit[#, r, o] & /@ f;
Limit[f_, {r1_Rule, r2__Rule}] := Limit[Limit[f, r1], {r2}];
Limit[f_, {r1_Rule}] := Limit[f, r1];

Simplify[e_, as_] := WLX`SimplifyAssuming[e, as] /; FreeQ[as, Rule] && as =!= {};
Simplify[e_, Assumptions -> as_] := WLX`SimplifyAssuming[e, as];
FullSimplify[e_, as_] := WLX`SimplifyAssuming[e, as] /; FreeQ[as, Rule] && as =!= {};
FullSimplify[e_, Assumptions -> as_] := WLX`SimplifyAssuming[e, as];
Refine[e_, as_] := WLX`SimplifyAssuming[e, as];

Maximize[{f_, c__}, v_] := WLX`Lagrange[f, {c}, v, 1] /; False;
FindMaximum[f_, v_List, o___] := With[{r = FindMinimum[-f, v, o]}, {-r[[1]], r[[2]]} /; ListQ[r]];
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
