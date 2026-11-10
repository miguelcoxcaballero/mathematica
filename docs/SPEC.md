# WolframLab Aero — especificación común (CONTRATO ENTRE AGENTES)

Web estática (GitHub Pages, sin build, sin frameworks, ES modules) para que un estudiante de Ing. Aeroespacial
aprenda Mathematica desde cero hasta resolver cualquier práctica/examen de 1º y 2º. Idioma de la interfaz y del
contenido: **español** (tuteo, tono directo y motivador). El código es Wolfram Language real.

Motor: **Mathics3** (intérprete libre de Wolfram Language) en **Pyodide** dentro de un Web Worker, ampliado con
`site/engine/wlkernel/` (Python). El mismo paquete corre en CPython para tests:
`/home/user/work/engine-test/venv/bin/python` (tiene Mathics3, sympy, numpy instalados).

## 0. Reglas de convivencia
- Cada agente SOLO escribe en los ficheros que su encargo le asigna. No tocar ficheros de otros. Leer, sí.
- Problemas del motor detectados por agentes que no son dueños del motor: añadir una línea a
  `/home/user/work/engine_issues.md` (formato: `- [quién] código mínimo → qué pasa → qué debería dar Mathematica`)
  y esquivarlo en el contenido si se puede. Los dueños del motor leen ese fichero periódicamente.
- Nada de datos personales (nombre del alumno, nombres de otros alumnos, profesores, claves) en `site/`.
- Rutas relativas siempre (la web se sirve desde `https://<user>.github.io/<repo>/`).
- Sin dependencias de red salvo Pyodide por CDN (`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`).

## 1. Estructura de `site/`
```
index.html                 app shell (dueño: SHELL)
css/tokens.css             variables y componentes base (YA ESCRITO; solo lectura para todos)
css/shell.css   (SHELL)    css/learn.css (LEARN)    css/notebook.css (NOTEBOOK)   css/gfx.css (GFX)
js/kernel-client.js, js/kernel-worker.js, js/notebook.js, js/wl-highlight.js      (NOTEBOOK)
js/gfx2d.js, js/gfx3d.js, js/manipulate.js                                        (GFX)
js/app.js, js/router.js, js/store.js, js/fx.js, js/data.js, js/views/{home,indice,registro,esquema,comandos,cuaderno}.js   (SHELL)
js/views/{leccion,practica,simulacro}.js, js/exercise.js                           (LEARN)
engine/wlkernel/{core,ext,conv,checker}.py, prelude.wl   (ENGINE)   engine/wlkernel/gfx.py (GFX)
engine/wheels/*, engine/manifest.json                    (NOTEBOOK)
data/course.json, data/commands.json, data/schema.json   (CATALOG)
data/lessons/<lessonId>.json                             (CONTENT-*)
data/exams/<examId>.json                                 (CONTENT-*)
docs/SPEC.md (este fichero)
```

## 2. Resultado de evaluar una celda (kernel → front)
`kernel.run(code)` → `{items:[Item...], inLine:int|null, lastLine:int|null, ms:int}`. Cada Item:
- `{kind:"out", line:n, type:"expr", mathml:"<math…>"|null, text:"InputForm", plain:"OutputForm"}`
- `{kind:"out", line:n, type:"graphics", g:{dim:2|3, prims:[…], opts:{…}}}`  (ver §3)
- `{kind:"out", line:n, type:"gallery", rows:[[item,…],…]}`  (items como los de arriba sin kind/line)
- `{kind:"out", line:n, type:"manipulate", id:int, controls:[…], animate:bool, initial:{items:[…]}}`
- `{kind:"message", symbol:"Solve", tag:"ifun", text:"…"}`  → se pinta `Solve::ifun: …` en rojo anaranjado
- `{kind:"print", text:"…"}`
Una celda con varias expresiones separadas por salto de línea produce varios `out` (como Mathematica).
`;` final suprime la salida. `%` = última salida.
Manipulate: `kernel.manipulate(id, {"Global`a": 2.5, …})` → `{items:[…]}`.
controls: `{name:"Global`a", label:"a", type:"slider", min, max, step, value, integer:bool}` o
`{name, label, type:"choice", choices:["…"], value:índice}`.

## 3. Especificación JSON de gráficos (la produce `gfx.py`, la pinta `gfx2d.js/gfx3d.js`)
Fuente de verdad: `site/engine/wlkernel/gfx.py` (funciones `graphics_json`, `graphics3d_json`, y los `prims` que emite
cada builtin). Resumen 2D — `opts`: `range:[[x0,x1]|null,[y0,y1]|null]`, `all`, `aspect:number|"auto"`,
`axes:bool|[bool,bool]`, `frame`, `axesLabel:[..]`, `frameLabel`, `plotLabel`, `grid`, `size`, `ticks`, `origin`, `bg`, `logy`.
prims 2D: `line{x[],y[],color,width,dash,opacity,arrow}`, `points{x[],y[],color,psize}`, `poly{x[],y[],color,opacity,edge}`,
`fill{x[],y[],y2[],color,opacity}`, `text{x,y,text,color,size,off}`, `arrows{segs[[x0,y0,x1,y1]],mags[],color}`,
`field{x0,x1,y0,y1,nx,ny,data[] (fila-mayor, ny filas),mode:"contour"|"implicit"|"density"|"region",levels,nlev,shading,color,…}`,
`legend{items[{label,color,dash}]}`. Los `null` en arrays = hueco (cortar la línea).
3D — `opts`: `range[3]`, `box:[bx,by,bz]|null`, `axes`, `boxed`, `axesLabel`, `plotLabel`, `size`, `view`.
prims 3D: `surf{nx,ny,x[],y[],z[],mesh,ci,color?,opacity?}`, `iso{n,r[3][2],data[] (orden [iz][iy][ix]),ci,color?,opacity?}`
(isosuperficie en nivel 0), `line3{x,y,z,color,width}`, `pts3`, `poly3`, `arrow3`, `text3`.
Estilo visual objetivo: el de Mathematica (paleta por defecto `#5E81B5 #E19C24 #8FB032 #EB6235 #8778B3 …`, ejes
finos con ticks hacia dentro, Plot3D con malla y sombreado naranja-azulado, caja y ejes numerados, rotación con arrastre).

## 4. API JS entre módulos (ES modules, todos en `site/js/`)
```js
// kernel-client.js (NOTEBOOK)
export const kernel = {
  status,                       // 'idle'|'loading'|'ready'|'busy'|'error'
  progress,                     // {phase:string, pct:0..1} mientras carga
  onStatus(cb),                 // cb(status, progress) ; devuelve función para desuscribir
  start(),                      // Promise; carga perezosa del worker+Pyodide+motor (idempotente)
  run(code),                    // Promise<Result §2>   (arranca el kernel si hace falta)
  check(spec),                  // Promise<{ok,feedback,items,got,expected}>  (spec §6)
  manipulate(id, values),       // Promise<{items}>
  reset(),                      // Promise; borra las definiciones del usuario (Global`*)
  abort(),                      // Promise; mata el worker y lo rearranca
};
// notebook.js (NOTEBOOK)
export function createNotebook(container, opts) // opts:{cells:[{code,note?}], title?, compact?:bool, onResult?(code,result)}
   // → {addCell(code), getCells():string[], evaluateAll():Promise, focus(), destroy()}
export function createCell(container, opts)     // opts:{code, readOnly?, placeholder?, onResult?(code,result), autorun?}
   // → {run():Promise<Result>, getCode(), setCode(c), focus(), el, clearOutput(), showResult(result)}
export function renderItems(container, items)   // pinta items §2 (usa gfx y manipulate)
// gfx2d.js / gfx3d.js / manipulate.js (GFX)
export function renderGraphics(el, g)           // g.dim 2|3 ; devuelve {destroy()}
export function renderManipulate(el, item, kernel, renderItems)
// store.js (SHELL) — progreso en localStorage (clave "wolframlab-aero-v1")
export const store = {
  state,                                        // objeto vivo (ver §7)
  on(cb),                                       // cb(state) tras cada cambio
  markExercise(exId, {ok, cmds:[..], xp}),      // registra intento; suma XP si ok por primera vez; actualiza racha y comandos
  exercise(exId),                               // → {ok,tries,ts}|undefined
  cmdLevel(name),                               // 0 por aprender · 1 visto · 2 en práctica · 3 dominado
  markSeen(cmdName), setLessonStep(lessonId, i), lessonProgress(lessonId) /*0..1*/,
  recordExam(examId, {score,max,ms}), settings /*{sound:true, fx:true}*/, set(path,value), reset(),
};
// fx.js (SHELL) — sonido WebAudio sintetizado + efectos
export const sfx = { play(name) /* 'ok','fail','level','click','type','combo','unlock','tick','exam' */, mute(bool) };
export function confetti(opts?) ; export function toast(msg, kind?) ; export function xpFloat(el, amount);
// data.js (SHELL) — carga con caché
export async function loadCourse(), loadCommands(), loadSchema(), loadLesson(id), loadExam(id);
// router.js (SHELL): hash routing. Rutas:
//  #/                inicio       #/indice   #/registro   #/esquema   #/comandos   #/comandos/<Nombre>
//  #/leccion/<lessonId>[/<paso>]  #/practica  #/practica/comando/<Nombre>  #/practica/tema/<lessonId>  #/practica/aleatoria
//  #/simulacros  #/simulacro/<examId>   #/cuaderno
// Cada vista: export default { mount(el, params) , unmount?() }  (LEARN registra las suyas igual que SHELL)
```

## 5. Contenido — lecciones (`data/lessons/<lessonId>.json`)
`lessonId`: `1-pNN` (1º, práctica NN), `2-m2-plN` (2º, Matemáticas II), `2-m3-plN` (Matemáticas III), y lecciones puente
`0-…` si hicieran falta. Una lección = una práctica real, descompuesta de lo más simple a lo completo.
```json
{ "id":"1-p04", "year":1, "subject":"Matemáticas I", "block":"Cálculo I", "order":4,
  "title":"Límites, derivadas e integrales", "summary":"1-2 frases", "minutes":35,
  "commands":["Limit","D","Integrate"],            // comandos NUEVOS que introduce (nombres exactos de commands.json)
  "uses":["Solve","Plot"],                         // comandos ya vistos que reutiliza
  "steps":[
    {"type":"explain","title":"…","md":"texto (markdown ligero: **negrita**, `código`, listas -, párrafos)",
     "cells":[{"code":"Limit[Sin[x]/x, x -> 0]","note":"opcional","run":true}]},
    {"type":"exercise","ex":{ …Exercise… }}
  ] }
```
Reglas pedagógicas: pasos cortos; cada concepto = explain (1-3 celdas ejecutables) + 1-3 ejercicios que suben de
dificultad; terminar con los **ejercicios reales** de la práctica/examen (`"real":true`, `"source":"Práctica 4 · P2"`),
adaptando el enunciado al español si estaba en inglés. Entre 12 y 25 pasos por lección; ≥8 ejercicios; mezclar tipos.
Explicar SIEMPRE el porqué (qué hace cada argumento, errores típicos: mayúsculas, corchetes, `=` vs `==`, `:=`, `/.`).

### Exercise
```json
{ "id":"1-p04-e03",                // único global: <lessonId>-eNN
  "kind":"code",                    // code | fix | fill | order | mcq | predict
  "title":"corto", "prompt":"enunciado (markdown ligero)", "difficulty":2,   // 1..5
  "cmds":["Limit"],                 // comandos que practica (para dominio y práctica específica)
  "real":false, "source":null,
  "setup":"código oculto previo (opcional)", "starter":"código inicial (opcional)",
  "solution":"código de referencia (obligatorio en code/fix)",
  "check":{…}, "requires":["Limit"], "forbids":[],
  "hints":["pista 1","pista 2 (más directa)"], "explain":"qué había que ver, 1-3 frases",
  "params":{"a":[2,3,5],"n":{"int":[2,6]}}   // opcional: variantes aleatorias; usar {{a}} {{n}} en prompt/solution/check/setup/starter
}
```
- `fix`: además `"broken":"código con 1-3 errores típicos"`; el alumno lo corrige; se comprueba como `code`.
- `fill`: `"template":"Plot[__1__, {x, __2__, __3__}]"`, `"blanks":[["Sin[x]"],["0"],["2 Pi","2Pi","2*Pi"]]` (1ª = canónica);
  se ejecuta el código relleno y se aplica `check`.
- `order`: `"lines":["línea1","línea2",…]` en el orden correcto (se barajan); opcionalmente `check`.
- `mcq`/`predict`: `"options":["…"]`, `"answer":índice`; `predict` muestra `"code"` y pregunta qué devuelve.
Cada ejercicio se evalúa en limpio: reset de `Global`*` → `setup` → código del alumno → `check`.

## 6. `check` (lo ejecuta `engine/wlkernel/checker.py`)
`%` en las expresiones de check = última salida de la celda del alumno.
- `{"type":"expr","expected":"<WL>","compare":"equal|numeric|set|same","tol":1e-6}` — compara la ÚLTIMA SALIDA del alumno
  con `expected` (evaluado en la sesión). `equal` = igualdad matemática (Simplify + sondeo numérico), `numeric` = números o
  listas de números con tolerancia relativa, `set` = listas sin orden (salidas de Solve), `same` = idéntico.
- `{"type":"value","expr":"f[2]","expected":"4","compare":…}` — evalúa `expr` en la sesión del alumno (para comprobar
  definiciones de funciones/variables).
- `{"type":"satisfies","test":"<WL que debe dar True>","msg":"feedback si falla"}` — p. ej. `"Head[%] === List && Length[%] == 3"`.
- `{"type":"ode","eq":"y''[x]+y[x]==0","func":"y","var":"x","ics":["y[0]==1"],"constants":2}` — la salida (reglas de
  DSolve, expresión o función) debe satisfacer la EDO (y las condiciones; `constants` = nº de C[i] en la general).
  Úsalo SIEMPRE para resultados de DSolve (la forma de la solución puede diferir de la de Mathematica).
- `{"type":"graphics","dim":2,"min":1,"like":"Plot[Sin[x],{x,0,2Pi}]","has":["legend"],"opts":["axesLabel","plotLabel"]}`
  — la salida es un gráfico; `like` compara los datos muestreados con un gráfico de referencia.
- `{"type":"defined","name":"f"}`, `{"type":"all","checks":[…]}`, `{"type":"any","checks":[…]}`, `{"type":"none"}`.
- `requires`/`forbids` (al nivel del ejercicio): símbolos que deben/no deben aparecer en el código (operadores por nombre:
  `ReplaceAll` `/.`, `Rule` `->`, `SetDelayed` `:=`, `Map` `/@`, `Part` `[[`, `Postfix` `//`, `Function` `&`, `Out` `%`, `Derivative` `'`).
Validación OBLIGATORIA del contenido: `engine-test/venv/bin/python tools/validate.py site/data/lessons/<id>.json`
(desde `/home/user/work`). Debe terminar con `TOTAL ERRORS: 0`.

## 7. Estado del progreso (`store.state`)
```json
{ "v":1, "xp":0, "streak":0, "lastDay":"2026-11-10", "combo":0,
  "ex":{"1-p04-e03":{"ok":true,"tries":2,"ts":1731240000000}},
  "cmd":{"Limit":{"seen":3,"ok":2,"last":1731240000000}},
  "lesson":{"1-p04":{"step":5,"done":false}},
  "exams":[{"id":"2-m2-sim1","score":7.5,"max":10,"ms":3600000,"ts":0}],
  "settings":{"sound":true,"fx":true} }
```
Niveles: nivel = floor(sqrt(xp/50))+1. XP por ejercicio = 10·dificultad (+5 si a la primera).
Comando "aprendido" = `cmd.ok ≥ 3`; "en práctica" = 1–2; "visto" = seen>0; "por aprender" = nada.

## 8. Catálogo
`data/commands.json`: `{"commands":[{ "name":"Plot","cat":"graficos2d","year":1,"firstLesson":"1-p06",
 "syntax":["Plot[f, {x, a, b}]"],"desc":"…","args":[{"n":"f","d":"…"}],"examples":[{"code":"…","note":"…"}],
 "options":["PlotStyle","PlotRange"],"related":["Show"],"pitfalls":["…"],"usedIn":["1-p06","2-m2-pl1"],"freq":177 }]}`
`data/schema.json`: familias para el esquema visual + modelos mentales (ver encargo CATALOG).
`data/course.json`: índice y registro: `{"years":[{"year":1,"label":"1º · curso 2025-26","subjects":[{"id":"mat1","name":"Matemáticas I",
 "blocks":[{"name":"Cálculo I","units":[{"lesson":"1-p01","practice":"Práctica 1","title":"…","topics":["…"],
 "status":"hecha|parcial|pendiente","evidence":"cuaderno S04 completo","nExercisesReal":3}]}]}]}],
 "exams":[{"id":"2-m2-sim1","title":"…","year":2,"subject":"Matemáticas II","durationMin":75,"date":"2027-01-18"}],
 "keyDates":[{"date":"2027-01-18","label":"Examen Mathematica · Matemáticas II"}]}`

## 9. Simulacros (`data/exams/<examId>.json`)
```json
{ "id":"2-m2-sim1","year":2,"subject":"Matemáticas II","title":"Simulacro 1 · examen de Mathematica",
  "durationMin":75,"intro":"instrucciones","source":"basado en el examen de 2021 y los guiones PL1–PL9",
  "questions":[{ "title":"P1 · EDO lineal","prompt":"enunciado","points":2,"setup":"código opcional",
     "parts":[{"label":"a)","prompt":"…","answerType":"numeric","value":1.2345,"tol":1e-3,"points":1,
               "solution":"código WL que produce el valor (última salida = número)","explain":"…"}]}] }
```
Los exámenes reales piden respuestas numéricas en casillas con tolerancia: el simulacro igual (cuaderno libre al lado +
casillas). `answerType`: `numeric` (por defecto) | `text` (autoevaluación, no puntúa automáticamente).
Validar con `tools/validate.py site/data/exams/<id>.json`.

## 10. Diseño
Ver `css/tokens.css`. Shell oscuro "cabina/espacio" con acentos neón; el cuaderno imita Mathematica (papel blanco,
`In[n]:=` / `Out[n]=` en azul grisáceo pequeño, corchete de celda a la derecha, fuente monoespaciada para Input).
1º = color `--y1` (cian), 2º = `--y2` (naranja); usar SIEMPRE la insignia `.badge.y1` / `.badge.y2` junto a cualquier
lección, ejercicio, comando o examen. Móvil primero (≥360 px), sin scroll horizontal.
