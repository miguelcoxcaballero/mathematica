# Guía para autores de contenido (lecciones y simulacros)

Lee antes `docs/SPEC.md` §5, §6 y §9 (esquema exacto). Aquí va el criterio de calidad.

## Quién es el alumno
Estudiante de 2º de Ingeniería Aeroespacial. Aprobó las prácticas de 1º copiando recetas: **no entiende Mathematica**.
Quiere pasar de "no entiendo nada" a resolver él solo cualquier práctica y el examen. Hay que explicarle el PORQUÉ de
cada cosa con frases cortas y ejemplos mínimos que pueda ejecutar y modificar.

## Fuentes (solo lectura)
`/home/user/work/digests/` — resúmenes fieles del material real de su Drive:
- `1_PNN.md` (27 prácticas de 1º: enunciados de la prueba de cada sesión + soluciones), `1_mis_practicas_resumen.md`
  (sus propios cuadernos + apuntes con enunciados), `1_recetario.md`, `1_examenes.md`, `1_libro.md`
- `2_MatII_PL1..9.md`, `2_MatII_examenes.md`, `2_MatII_formulario.md`, `2_MatII_overview.md`
- `2_MatIII_PL1..4.md`, `2_MatIII_examenes.md`, `2_MatIII_formulario.md`, `2_MatIII_overview.md`
- `nbtxt/*.txt` transcripciones de cuadernos (código `In>` exacto).
No copies nombres de personas. Los enunciados en inglés se traducen al español. Puedes cambiar los datos numéricos de un
ejercicio real (y decirlo: "adaptado de…"), pero conserva el tipo de problema y los comandos.

## Estructura de una lección (una práctica)
1. **Gancho** (explain): para qué sirve esto en ingeniería, en 2-3 frases, y qué sabrás hacer al acabar.
2. **Escalera**: por cada comando/idea nueva → `explain` con 1-3 celdas mínimas (la más simple posible primero) →
   1-3 ejercicios cortos (dificultad 1-2): primero `predict`/`mcq`/`fill`, luego `code`.
3. **Errores típicos** (`fix`): mayúsculas (`sin[x]`), paréntesis en vez de corchetes, `=` por `==`, olvidar `_` en
   `f[x_]`, usar la salida de Solve sin `/.`, llaves que faltan en `{x, a, b}`, etc.
4. **Combinar** (dificultad 3): ejercicios de 2-4 líneas que encadenan lo anterior.
5. **Ejercicios reales** (dificultad 3-5, `"real": true`, `"source": "Práctica N · Pk"`): los de la práctica/prueba,
   troceados en apartados comprobables si son largos. Con `hints` graduadas y `explain` final.
Entre 12 y 25 pasos; ≥ 8 ejercicios; ≥ 3 reales cuando el digest los tenga. Las lecciones posteriores pueden asumir las
anteriores (orden: 1-p01 … 1-p27, 2-m2-pl1 … pl9, 2-m3-pl1 … pl3).

## Estilo del texto (`md`, `prompt`, `hints`, `explain`)
- Español, tuteo, frases cortas. Nada de relleno ni de "¡Genial!" constante.
- Markdown ligero: `**negrita**`, `` `código` ``, listas con `- `, párrafos separados por línea en blanco. Sin HTML,
  sin LaTeX, sin tablas, sin títulos `#`.
- Fórmulas en texto llano o en notación Wolfram entre backticks: `` `x^2 + 1` ``.
- En cada `explain` di qué es cada argumento: "`{x, 0, 2 Pi}` = variable, desde, hasta".
- Un `prompt` debe poder resolverse sin adivinar: da la función, el intervalo, el nombre de variable que se espera.
- Si se espera que defina algo (`f`, `sol`…), dilo explícitamente y comprueba con `value`/`defined`.

## Checks robustos (lo más importante)
- La comprobación debe aceptar CUALQUIER respuesta correcta razonable y rechazar las incorrectas.
- Resultado simbólico → `expr` + `equal`. Numérico → `numeric` con `tol` (p. ej. 1e-4). Soluciones de `Solve` →
  `compare: "set"`. `DSolve` → **siempre** `type: "ode"`. Gráficos → `graphics` con `like`. Definiciones → `value`.
- No compares cadenas ni formas concretas (`same`) salvo que la forma sea el objetivo.
- Usa `requires` para forzar el comando que se practica (si no, vale teclear el número a mano).
- Si la última línea del alumno termina en `;` no hay salida: en esos casos usa `value`/`satisfies` sobre variables.
- `setup` para dar datos ya definidos (matrices, funciones) sin que el alumno los teclee; menciónalos en el `prompt`.
- Evita funciones que el motor no tenga. Prueba TODO con `tools/validate.py` (debe dar `TOTAL ERRORS: 0`).
  Para explorar el motor a mano: `engine-test/venv/bin/python tools/t.py fichero.txt` (celdas separadas por una línea `%%`).
- Si algo que Mathematica sí hace falla en el motor: apúntalo en `/home/user/work/engine_issues.md` y busca otra forma
  (o reintenta más tarde: el motor se está mejorando en paralelo). No dejes ejercicios que no validen.

## Ejemplo mínimo de pasos
```json
{"type":"explain","title":"Derivar con D","md":"`D[f, x]` deriva `f` respecto de `x`. El primer argumento es **qué** derivas; el segundo, **respecto de qué**.\n\nPara la derivada segunda: `D[f, {x, 2}]` (variable y orden, entre llaves).",
 "cells":[{"code":"D[x^3, x]"},{"code":"D[Sin[x]^2, {x, 2}]","note":"segunda derivada"}]},
{"type":"exercise","ex":{"id":"1-p04-e05","kind":"predict","title":"¿Qué devuelve?","prompt":"Sin ejecutarlo: ¿qué devuelve esta celda?","code":"D[x^2 y, y]","options":["2 x y","x^2","2 x","0"],"answer":1,"difficulty":1,"cmds":["D"],"explain":"Se deriva respecto de `y`: `x^2` actúa como constante."}},
{"type":"exercise","ex":{"id":"1-p04-e06","kind":"code","title":"Tu primera derivada","prompt":"Calcula la derivada de `x^3 Sin[x]` respecto de `x`.","difficulty":1,"cmds":["D"],"solution":"D[x^3 Sin[x], x]","check":{"type":"expr","expected":"D[x^3 Sin[x], x]"},"requires":["D"],"hints":["La forma es `D[expresión, variable]`.","`D[x^3 Sin[x], x]`"],"explain":"Mathematica aplica sola la regla del producto."}}
```
