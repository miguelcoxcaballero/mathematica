# WolframLab Aero

Herramienta de estudio para aprender **Mathematica / Wolfram Language** desde cero hasta resolver las prácticas y
exámenes de 1º y 2º de Ingeniería Aeroespacial (Matemáticas I, II y III).

- **Cuaderno estilo Mathematica en el navegador**: celdas `In[n]:=` / `Out[n]=`, Shift+Enter, gráficos 2D/3D,
  `Manipulate`. Ejecuta Wolfram Language real con [Mathics3](https://mathics.org) (intérprete libre de Wolfram Language)
  sobre [Pyodide](https://pyodide.org), ampliado con los comandos que usan las prácticas (`DSolve` con condiciones
  iniciales, `LaplaceTransform`, `Residue`, series de Fourier, gráficos con opciones…). Todo corre en tu navegador, sin servidor.
- **Ruta de aprendizaje** de lo más simple a lo completo, una lección por práctica, marcando qué es de 1º y qué de 2º.
- **Índice de contenidos**, **registro de prácticas y ejercicios**, **esquema de comandos** y fichas de cada comando.
- **Comandos aprendidos / en práctica / por aprender**, práctica específica por comando, práctica aleatoria sobre lo
  ya estudiado y **simulacros de examen** con cronómetro y corrección por tolerancia.
- Progreso guardado en el propio navegador (localStorage); se puede exportar e importar.

## Uso
Es una web estática: basta con servir esta carpeta (GitHub Pages, o en local `python3 -m http.server` y abrir
`http://localhost:8000`). La primera carga del motor descarga Python y SymPy (unos segundos); después queda en caché.

## Estructura
`index.html`, `css/`, `js/` (interfaz), `engine/` (motor: paquete Python `wlkernel` + ruedas de Mathics3),
`data/` (lecciones, comandos, simulacros), `docs/` (especificación interna).

## Limitaciones
El motor es Mathics3, no el kernel propietario de Wolfram: la sintaxis y los comandos son los mismos, pero algunos
resultados pueden salir escritos de otra forma equivalente y hay funciones avanzadas sin implementar. Antes del examen,
repasa también en el Mathematica de la universidad.

## Licencia
El código de este repositorio se distribuye bajo GPL-3.0 (ver `LICENSE`), la misma licencia de Mathics3, cuyo paquete
se incluye en `engine/wheels/`. Wolfram, Mathematica y Wolfram Language son marcas de Wolfram Research; este proyecto no
está afiliado a Wolfram Research.
