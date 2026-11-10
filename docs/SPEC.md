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
cada builtin). Banco de pruebas visual: `site/dev/gfx.html` (+ `dev/gfx-specs.json`).
**2D — `opts`**: `range:[[x0,x1]|null,[y0,y1]|null]` (null → caja de los datos), `all`, `aspect:number|"auto"`
(alto/ancho; `"auto"` = mismas unidades en x e y), `axes:bool|[bool,bool]`, `frame`, `axesLabel:[x,y]` (puede llevar
`null`), `frameLabel:[abajo,izq,arriba,dcha]`, `plotLabel`, `grid:true|[gx,gy]` (cada uno `true|false|[valores]`),
`size:number|[w,h]`, `ticks:null|false|[tx,ty]` (cada uno `null|false|[[valor,"etiqueta"],…]`), `origin:[x,y]`, `bg`, `logy`.
**prims 2D**: `line{x[],y[],color,width,dash,opacity,arrow:"end"|"mid",nohover?}`, `points{x[],y[],color,psize,opacity}`,
`poly{x[],y[],color,opacity,edge,ewidth}`, `fill{x[],y[],y2[],color,opacity}`, `text{x,y,text,color,size,off}`,
`arrows{segs[[x0,y0,x1,y1]],mags[] (0..1),color?}`,
`field{x0,x1,y0,y1,nx,ny,data[] (fila-mayor, ny filas),mode:"contour"|"density"|"region"|"implicit",levels?,nlev?,
shading,cf?,lines?,lineColor?,lineWidth?,color,opacity,boundary?}`,
`legend{items[{label,color,dash,width,kind?:"point"|"swatch",opacity?}],bar?:{cf,lo,hi}}` (`bar` = barra de color).
Los `null` en arrays = hueco (cortar la línea). OJO: `ContourPlot` de ECUACIONES y el borde de `RegionPlot` ya no
salen como `field` sino como `line` (las isolíneas se calculan en Python a alta resolución); `field` queda para
`ContourPlot` de una función (`contour`), `DensityPlot` (`density`) y el relleno de `RegionPlot` (`region`).
**3D — `opts`**: `range[3]` (cada uno `[a,b]|null`), `all`, `box:[bx,by,bz]|null` (null → proporciones reales),
`axes:bool|[3]`, `boxed`, `axesLabel:[x,y,z]`, `plotLabel`, `size`, `view:[x,y,z]|null` (ViewPoint).
**prims 3D**: `surf{nx,ny,x[],y[],z[],mesh:true|false|n|[nu,nv],bd?,ci,color?,opacity?,m?[] (máscara: visible donde >0),
cf?,cv?[] (ColorFunction: nombre de degradado + escalar 0..1 por vértice; sin cv se usa z escalada)}`,
`iso{n,r[3][2],data[] (orden [iz][iy][ix]),ci,color?,opacity?,mesh?:n,pad?,inner?}` (isosuperficie en nivel 0 que
triangula el renderer; con `pad` la capa exterior queda justo fuera de la caja `inner` para cerrar el sólido). Lo
habitual (ContourPlot3D y RegionPlot3D vectorizables) es que el `iso` llegue YA triangulado desde Python:
`iso{v[] (x,y,z por vértice, coords. de datos),nrm[] (gradiente),i[] (triángulos),m?[] (máscara por vértice: visible
donde >0),n:0,data[] = firma gruesa del campo solo para comparar gráficos}`; RegionPlot3D = un `iso` por condición
(enmascarado con las demás → aristas nítidas) + caras de la caja como `surf{…,m,cap:true}`,
`line3{x,y,z,color,width,opacity?}`, `pts3{x,y,z,color,psize}`, `poly3{x,y,z,color,opacity?,edge?}`,
`arrow3{x,y,z,color,width}`, `text3{x,y,z,text,color}`. Color por defecto de superficies según `ci`:
`#E19C24 #5E81B5 #8FB032 …` (como Mathematica: la primera naranja, la segunda azul).
Renderers: `renderGraphics(el, g)` devuelve `{destroy(), update(g2), el}`; el nodo raíz es `div.wl-gfx` (clase extra
`wl-gfx2d`/`wl-gfx3d`). 2D = SVG (campos como imagen ráster dentro del SVG) con retícula y lectura de coordenadas al
pasar el ratón; 3D = WebGL compartido (un único contexto para todos los gráficos, copiado a un `canvas` 2D por
gráfico; respaldo sin WebGL con algoritmo del pintor), arrastrar = rotar (con inercia), rueda (con el gráfico activo o
Ctrl) / pellizco = zoom, doble clic = vista inicial. Hace falta cargar `css/gfx.css`.
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

## 10. Diseño (v2 — PETICIÓN EXPRESA DEL USUARIO: minimalista, poco recargado, similar a Wolfram)
Ver `css/tokens.css` (reescrito). Referencias: el cuaderno de Mathematica, Wolfram Cloud y reference.wolfram.com.
- Fondo blanco, mucho espacio en blanco, tipografía sobria, reglas finas gris claro, esquinas casi rectas (4–6 px).
- UN color de acento (rojo Wolfram `--accent`) para la acción principal y el elemento activo; el resto en grises.
  Naranja `--accent-2` solo para realces puntuales. Nada de degradados, brillos/neón, sombras marcadas, fondos animados,
  partículas decorativas, emojis decorativos ni tarjetas dentro de tarjetas.
- Jerarquía por tamaño y peso de texto y por espacio, no por cajas de colores. Pocas cosas por pantalla; lo secundario,
  plegado o en una segunda vista. Navegación simple: barra superior fina o lateral estrecha con texto.
- El cuaderno imita Mathematica (papel blanco, `In[n]:=` / `Out[n]=` en azul grisáceo pequeño, corchete de celda a la
  derecha, fuente de Input monoespaciada). La app entera debe sentirse como una extensión natural de ese cuaderno.
- 1º = `--y1` (azul), 2º = `--y2` (naranja): insignia discreta `.badge.y1` / `.badge.y2` junto a cada lección, ejercicio,
  comando o examen (sigue siendo obligatorio distinguir 1º y 2º, pero sin estridencias).
- Gamificación SÍ, pero sobria: XP, racha y nivel como texto/indicadores pequeños; sonidos cortos y suaves; el feedback
  de acierto es una marca verde y una animación breve; confeti solo en hitos (fin de lección, subida de nivel, simulacro
  aprobado) y discreto. Todo desactivable.
- Móvil primero (≥360 px), sin scroll horizontal.

## 11. MECÁNICA v2 — PETICIÓN EXPRESA DEL USUARIO: nada tipo test, TODO se teclea
"No pongas nada de tipo test. Que tenga que escribir yo cada una de las líneas. Si quieres explicar qué hace cada una,
las tengo que escribir igual: que aparezcan en gris, como que no están escritas, y a medida que escriba yo los
caracteres que se vuelvan negros."
- **Prohibido** cualquier interacción de elegir/ordenar/rellenar huecos: nada de opciones A/B/C/D, arrastrar líneas,
  huecos sueltos ni botones que escriban código por él. El alumno teclea SIEMPRE el código completo.
- **Celdas de explicación = celdas fantasma** (`createCell(el, {ghost: "código"})`, la implementa NOTEBOOK):
  la celda empieza vacía; el código de referencia se ve en GRIS en su sitio; cada carácter que el alumno teclea y
  coincide pasa a NEGRO (con el coloreado normal); lo que falta sigue en gris delante del cursor. Un carácter que no
  coincide se marca (subrayado rojo) y no avanza el fantasma. Los espacios no cuentan (comparación insensible a
  espacios; la sangría tras un salto de línea se pone sola). Sin autocompletar, sin cierre automático de corchetes,
  sin pegar. Shift+Enter / ▶ solo evalúa cuando la línea está completa. API: `opts.ghost`, `opts.onProgress(0..1)`,
  `opts.onComplete()`, `cell.isComplete()`.
- **Ejercicios**: solo se muestran como celdas vacías donde el alumno escribe su propia solución (sin fantasma) y se
  comprueba con `check`. "Ver solución" (tras fallar) muestra la solución como FANTASMA para que la teclee, no como
  texto copiado en la celda.
- **Tipos de ejercicio válidos a partir de ahora en el contenido: `code` y `fix`** (en `fix` el código roto se muestra
  de solo lectura encima y el alumno escribe la versión corregida entera). Los `predict`, `mcq`, `fill` y `order` que ya
  existan en ficheros de lecciones NO se muestran como test: LEARN los convierte al vuelo —
  `predict` → paso de tecleo fantasma con `code` (y después su `explain`); `fill` → ejercicio `code` (la plantilla se
  enseña como pista de forma, la solución es la plantilla con las respuestas canónicas); `order` → ejercicio `code`
  (las líneas desordenadas se enseñan de solo lectura; se teclean en orden); `mcq` → se omite (o se muestra solo su
  `explain` como nota). Los autores deben ir sustituyéndolos por `code`/explicaciones tecleadas.
- Un paso `explain` se completa cuando todas sus celdas están tecleadas y evaluadas. Debe existir un "saltar" discreto.
- Ejemplos de las fichas de comandos y del esquema: también en modo fantasma. El cuaderno libre es libre.
- Consecuencia para autores: celdas de explicación CORTAS (1–3 líneas, sin comentarios largos dentro del código) y
  en número razonable (cada una se teclea); el texto explicativo va en `md`/`note`, no en comentarios `(* *)`.

## 12. Referencias visuales reales de Wolfram (capturas en `/home/user/work/refs/*.png` — MIRARLAS con Read)
`fastintro.png` (Fast Introduction for Math Students: la referencia principal para lecciones: barra lateral gris claro
con lista de temas y elemento activo en rojo, columna de contenido blanca, título fino grande en rojo, texto gris
oscuro, celdas `In[1]:=`/`Out[1]=` con etiqueta pequeña azul grisácea y código en negrita, separadores finos),
`ref_plot.png`, `ref_dsolve.png` (páginas de documentación de un símbolo: caja de sintaxis azul muy claro, secciones en
naranja con chevrón, ejemplos con celdas), `ref_guide_calculus.png` (página guía: listas de comandos),
`ref_notebook_tutorial.png`, `ref_plot_mobile.png` (móvil). Tomar de ahí proporciones, tipografía, colores y densidad.

## 13. PEDAGOGÍA v3 — PETICIÓN EXPRESA DEL USUARIO: una cosa por pantalla, construir por piezas, recordar con pistas
"Evita sesiones con muchos pasos a la vez. Que cada cosa se vea individualmente en una pantalla completa y que luego se
vayan añadiendo una a una hasta tener un ejercicio hecho; todo explicado por partes con pocas piezas, luego por
componentes más grandes que se van uniendo, y al final que tenga que escribir todo. Que sea también un poco de
memorizar, pero que haya pistas. La idea no es que sea difícil, sino que aprenda."

### 13.1 Nuevo tipo de paso `build` (construcción por piezas) — es el paso PRINCIPAL para enseñar algo nuevo
```json
{ "type":"build", "title":"Dibujar una función", "md":"qué vamos a construir y para qué (1-2 frases)",
  "target":"Plot[Sin[x], {x, 0, 2 Pi}, PlotStyle -> Red]",
  "parts":[
    {"code":"Sin[x]",                         "md":"La función. `Sin` con mayúscula y el argumento entre corchetes."},
    {"code":"{x, 0, 2 Pi}",                   "md":"El intervalo, entre llaves: variable, desde, hasta."},
    {"code":"Plot[Sin[x], {x, 0, 2 Pi}]",     "md":"Las dos piezas dentro de `Plot`, separadas por coma.", "run":true},
    {"code":"PlotStyle -> Red",               "md":"Una opción: nombre, flecha `->`, valor."},
    {"code":"Plot[Sin[x], {x, 0, 2 Pi}, PlotStyle -> Red]", "md":"Todo junto.", "run":true} ],
  "recall":{ "prompt":"Ahora sin mirar: dibuja `Sin[x]` de 0 a 2 Pi en rojo.",
             "hints":["Empieza por el comando: `Plot[`", "Después la función y el intervalo entre llaves", "La opción va al final: `PlotStyle -> Red`"],
             "check":{"type":"graphics","dim":2,"like":"Plot[Sin[x], {x, 0, 2 Pi}]"} },
  "cmds":["Plot","PlotStyle"] }
```
- `parts`: de 2 a 6 piezas, de la más pequeña a la completa: primero piezas sueltas (1 idea cada una), luego componentes
  que las unen, la última = `target`. `run:true` solo en las piezas que tiene sentido evaluar (dan una salida que enseña
  algo); las demás solo se teclean. Cada `md`: 1–2 frases sobre ESA pieza (qué es, por qué va así, error típico).
- `recall`: escribir el `target` (o una variante mínima) DE MEMORIA en una celda vacía; `check` opcional (por defecto:
  la salida debe ser igual a la de `target`; en gráficos usar `graphics`+`like`); `hints` de 2–4, graduadas.
- Reglas de autor: cada concepto/comando nuevo se enseña con un `build`; después 1–3 ejercicios `code` cortos que lo
  varían; los pasos `explain` quedan para texto de contexto con, como mucho, 1 celda. Lecciones troceadas en **tramos**
  cortos: añadir `"section":"Título del tramo"` al primer paso de cada tramo (un tramo = 1–2 `build` + sus ejercicios,
  5–10 min). Los ejercicios reales largos se dividen en apartados pequeños, uno por pantalla, que se van sumando.

### 13.2 Cómo lo presenta el reproductor (LEARN)
- **Una sola cosa por pantalla, a pantalla completa**: una pieza = una pantalla (su texto corto arriba, UNA celda
  fantasma centrada, nada más). Sin listas de pasos a la vista, sin barras laterales abiertas; solo un indicador fino
  de avance del tramo y "atrás / siguiente".
- **Ensamblaje visible**: en un `build`, las piezas ya tecleadas quedan arriba en pequeño (gris oscuro) y se ve cómo
  encajan en el objetivo; al unirlas, la pantalla siguiente pide teclear el componente unido (fantasma).
- **Al final, todo de memoria** (`recall`): celda vacía. Pistas siempre disponibles y SIN penalización visible:
  1ª pista = texto; 2ª = el esqueleto en gris (solo corchetes, llaves y comas: `Plot[ , { , , }]`); 3ª = el código
  completo en gris para teclearlo. Tono amable: equivocarse no resta, se reintenta.
- Los pasos `explain` con varias celdas se muestran una celda por pantalla. Los ejercicios `code`: una pantalla cada uno.
- **Tramos**: la página de una lección muestra primero la lista corta de tramos (título, minutos, hecho/pendiente); se
  entra en UN tramo; al acabarlo, resumen de 3 líneas (qué has construido, qué comandos) y vuelta a la lista. Si el
  contenido no trae `section`, un tramo nuevo empieza en cada `build`/`explain`.
- **Memorizar con repaso**: al terminar un tramo, sus `target` entran en la cola de repaso; la práctica aleatoria y el
  inicio de la siguiente sesión empiezan con 2–3 "recuerdas…" (escribir de memoria con pistas) de tramos anteriores.

## 14. TEXTO MÍNIMO — PETICIÓN EXPRESA DEL USUARIO ("mucho texto; el mínimo posible salvo que pulse un desplegable")
- En pantalla, por defecto, SOLO: un título corto (≤ 5 palabras), UNA línea de instrucción (≤ 90 caracteres) y la celda.
  Nada de párrafos, listas ni introducciones. Sin lista de pasos a la vista.
- Todo lo demás va plegado en dos desplegables discretos bajo la celda, cerrados por defecto:
  **«Pista»** (breve: 1 frase, ≤ 140 caracteres) y **«Más detalle»** (explicación avanzada: 2–4 frases; por qué funciona,
  error típico, variantes).
- Campos de contenido (todos los tipos de paso y cada `part` de un `build`):
  `md` = la línea visible (≤ 90 caracteres, una sola frase, imperativa: "Escribe la función entre corchetes.");
  `hint` = pista breve (≤ 140); `more` = más detalle (texto libre corto, markdown ligero).
  En ejercicios: `prompt` ≤ 160 caracteres (qué hay que conseguir, con los datos); `hints` como hasta ahora (la 1ª es la
  pista breve); `explain` = más detalle. `build.md` ≤ 90; `recall.prompt` ≤ 120.
- Reproductor (LEARN): si un texto supera el límite (contenido antiguo), muestra solo su primera frase y manda el resto
  a «Más detalle» automáticamente. Pantallas de bienvenida/tramo: una línea.
- `tools/validate.py` avisa (WARN, no error) de los textos que superan estos límites.

### 14.1 Aclaración del usuario: NO esconder el texto — hacerlo INNECESARIO con práctica
"No escondas todo el texto simplemente para que esto sea el caso; la idea es que se practique todo de la forma más
práctica posible para que esto no haga falta."
- El texto no se traslada a los desplegables: se ELIMINA. La explicación es lo que pasa al teclear y ejecutar.
  `hint`/`more` son un salvavidas breve y opcional (muchas pantallas no llevan ninguno), no un sitio donde volcar párrafos.
- Enseñar haciendo, con estas técnicas (en `build.parts` con `run:true` para que se vea la salida):
  - **Par mínimo / contraste**: dos piezas casi iguales cuya salida distinta enseña la regla
    (`10/4` → `5/2`, luego `10/4.` → `2.5`; `Sin[Pi]` frente a `sin[Pi]`; `x = 3` frente a `x == 3`).
  - **Variación mínima**: repetir la misma forma cambiando UNA cosa cada vez (otro número, otra función, un argumento más).
  - **Error provocado**: teclear a propósito la forma incorrecta, ver qué devuelve o qué mensaje sale, y después la correcta.
  - **Crecimiento**: la misma línea va ganando piezas (`Plot[Sin[x], {x,0,2Pi}]` → + `PlotStyle -> Red` → + `AxesLabel -> …`).
  - **Recuperación**: al final del tramo, escribirlo todo sin gris; y volver a pedirlo en tramos posteriores.
- La línea visible dice QUÉ hacer ("Ahora con punto decimal."), no explica teoría. Si una pantalla necesita un párrafo
  para entenderse, está mal partida: divídela en más piezas ejecutables.
- Más pantallas pequeñas y más repeticiones valen más que una explicación: un tramo puede tener 10–15 pantallas de
  10–20 segundos cada una.
