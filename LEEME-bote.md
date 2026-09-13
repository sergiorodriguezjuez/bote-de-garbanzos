# El bote de garbanzos — estado del proyecto

## Objetivo de dinero (añadido 2026-09-13)

Prueba de ingreso: 10€ simulados → intentar hacerlos crecer con value betting real antes de
arriesgar dinero de verdad. Se acordó **validar primero sin dinero real** (backtest / calibración)
antes de pasar a apostar los 10€ de verdad. Detalle de la decisión y los números en la memoria del
proyecto.

## Fase 1 — HECHA

`bote-de-garbanzos.html` ya:

- Coge **todos los partidos del día en que abres la página** que **no han terminado**: los que faltan
  por empezar y los que están **en juego** (`jugablesDeHoy()` en el `<script>`).
- Deduce el estado real de cada partido por la hora si el feed aún no lo ha marcado (`estadoActual()`).
- Se **repasa solo cada minuto** y hay un botón **"Analizar los partidos de hoy"** para forzarlo cuando quieras.
- Muestra por partido: probabilidad simulada (barra), Elo, **clima** y **bajas** (con etiqueta de
  cobertura cuando el parte de lesiones no está confirmado).
- Fútbol sale a 3 vías (local / empate / visitante); tenis a 2.
- Marcador Yo vs La abuela y apuestas: igual que antes, guardado en `window.storage`
  (clave nueva `garbanzos-estado-v2`).

### Cómo probarlo

- **Abriendo el archivo directamente**: funciona, usa `datosEjemplo()` (datos ficticios, con horas
  relativas a ahora para que siempre se vea un partido "en juego" y otros "por jugar").
- **Con datos reales**: hay que servir la carpeta por HTTP para que cargue `partidos.json`:
  - `python -m http.server` en esta carpeta y abrir `http://localhost:8000/bote-de-garbanzos.html`
  - o subirlo a GitHub Pages / Netlify / Vercel.
- Si `partidos.json` no se puede cargar, cae en los datos de ejemplo sin romperse.

## Fase 1.5 — HECHA (2026-09-13): cartera de prueba y value betting

Añadido directamente en `bote-de-garbanzos.html`, sin esperar al backend:

- Nuevo campo opcional por partido en el esquema: `cuotas` (`loc` / `empate` / `vis`, cuota decimal).
- **Value bet** = la probabilidad simulada da más valor esperado que la cuota del mercado
  (`prob_modelo × cuota − 1 > 4%`, umbral configurable en `CONFIG_APUESTAS.umbralEdge`).
- Tamaño de la apuesta con **Kelly fraccionado** (1/4 de Kelly, `fraccionKelly`) y un tope de
  seguridad del 15% de la banca por apuesta (`apuestaMaxPct`), porque el modelo aún no está validado.
- **Cartera simulada** de 10€ (`garbanzos-cartera-v1` en `window.storage`): registra cada value bet,
  liquida sola cuando marcas el "Ganó" del partido, lleva banca, rendimiento % y tabla de historial.
- **Brier score en vivo**: sobre todas las predicciones resueltas (tengan apuesta o no), mide si el
  modelo está bien calibrado. Referencia de azar: ~0.5 a 2 vías (tenis), ~0.67 a 3 vías (fútbol).
  Es una versión ligera y continua de lo que iba a ser `backtest.js` en la fase 5.
- Botón "Vaciar el bote y la cartera" reinicia ambas cosas.

**Comprobado con los datos de ejemplo:** con cuotas realistas (con margen de casa del 5-8%), la
mayoría de partidos NO dan value bet — es lo esperado, el mercado suele estar bien puesto. Cuando sí
aparece una, con 10€ de banca la apuesta que sugiere Kelly fraccionado es de céntimos (p. ej. 0.08€
sobre un edge del 9.6%), muy por debajo del mínimo que aceptan casas reales (normalmente 0.10-0.50€).
Esto confirma que **el reto no es solo encontrar value, es acumular ventaja durante meses** para que
las apuestas dejen de ser calderilla; no hay atajo para llegar rápido a una banca grande.

**Limitación de esta fase:** las `cuotas` hay que ponerlas a mano en `partidos.json` (o en los datos
de ejemplo) porque todavía no hay una fuente automática. Eso es la fase 2.

## Formato de datos

`partidos.json` lleva el esquema comentado dentro (claves `_esquema`, `_campos`, incluye `cuotas`).
Ese es el fichero que tendrá que **generar el backend** en la fase 2.

## Fase 2 — HECHA (2026-09-13): backend real (solo fútbol por ahora)

`scripts/generar-partidos.js` (Node, sin dependencias externas: usa `fetch` nativo) genera
`partidos.json` de verdad, uniendo:

- **Partidos**: football-data.org (`/v4/matches`), las 12 competiciones del plan gratis (PL, ELC,
  PD, SA, BL1, DED, FL1, PPL, BSA, CL, EC, WC) para hoy + los 2 días siguientes.
- **Elo**: clubelo.com (gratis, sin clave). El emparejamiento de nombres entre las dos fuentes es por
  aproximación (`normalizar()` + coincidencia parcial); si un equipo no encuentra Elo, el script avisa
  por consola y no simula ese partido hasta que se añada un alias en `scripts/alias-equipos.json`.
- **Cuotas**: The Odds API (clave gratis, ~500 peticiones/mes). Se piden por liga y se cachean 24h
  (o se reutilizan sin más si el partido ya empezó) para no agotar la cuota gratuita.
- **Clima**: Open-Meteo (gratis, sin clave), solo para los equipos que tengan estadio en
  `scripts/estadios.json` (sembrado con ~30 clubes grandes de las 5 grandes ligas; el script avisa de
  los que faltan).
- **Montecarlo**: Elo → goles esperados de local/visitante vía Poisson (ventaja de campo +65 Elo,
  media de 2.7 goles/partido) → 10.000 simulaciones por partido. Simplificación deliberada: usa el
  Elo general del club, no ataque/defensa por separado; suficiente para esta fase.

`.github/workflows/actualizar-partidos.yml` lo ejecuta cada 30 min (6:00-23:59 UTC) y hace commit +
push de `partidos.json` si cambió.

### Lo que le queda por hacer al usuario (fuera del alcance de Claude)

1. **Clave de football-data.org** (gratis): registrarse en football-data.org/client/register.
2. **Clave de The Odds API** (gratis): registrarse en the-odds-api.com.
3. Subir esta carpeta a un repositorio de GitHub (`git init`, commit, `git remote add origin ...`, push).
4. En el repo → *Settings → Secrets and variables → Actions*, añadir dos secrets:
   `FOOTBALL_DATA_API_KEY` y `ODDS_API_KEY`.
5. En *Settings → Actions → General → Workflow permissions*, marcar "Read and write permissions"
   (si no, el workflow no podrá hacer el commit de `partidos.json`).
6. Activar GitHub Pages (Settings → Pages) para servir `index.html`/`bote-de-garbanzos.html` con
   `partidos.json` accesible por `fetch` (abrir el archivo en local con doble clic no sirve para
   cargar el JSON real, solo para ver los datos de ejemplo).

Para probar el script en local antes de subirlo: `$env:FOOTBALL_DATA_API_KEY="tu_clave"` (PowerShell)
y `node scripts/generar-partidos.js`.

## Fase 2.1 — HECHA (2026-09-13): segundo mercado (más/menos de 2.5 goles)

La cartera de prueba ya no mira solo quién gana el partido: también compara la probabilidad
simulada de más/menos de 2.5 goles totales contra la cuota de mercado (mercado `totals` de The Odds
API). Un mismo partido puede tener value bet en **los dos mercados a la vez** (por ejemplo, "Celta
gana" Y "más de 2.5 goles" pueden ser ambos value bets del mismo partido) — la cartera los trata y
liquida por separado. El de 1X2 sigue liquidándose al marcar el "Ganó"; el de goles se liquida solo,
en cuanto el partido queda FINALIZADO, leyendo el marcador final.

**Corners y tarjetas — descartado por ahora, con motivo:** The Odds API sí tiene esos mercados
(`alternate_totals_corners`, `alternate_totals_cards`), pero cada mercado adicional que se pide
multiplica el gasto de la cuota gratuita (fórmula: nº de mercados × nº de regiones), y sobre todo:
**no tenemos ninguna fuente de datos para calcular una probabilidad propia de córners o tarjetas**
(el Elo no dice nada de eso). Sin probabilidad propia no hay con qué comparar esa cuota — se podría
enseñar el número, pero no detectar si tiene valor. Haría falta buscar otra fuente de estadísticas
por equipo (córners/tarjetas por partido) antes de que esto tenga sentido.

## Siguientes fases (pendientes)

| Fase | Qué falta |
|------|-----------|
| 3 | Lesiones de fútbol: API-Football `/injuries` (100 pet/día, 3 tomas al día) + respaldo Transfermarkt + `overrides.json` manual que manda sobre todo. |
| 4 | Tenis: Elo de Tennis Abstract, bajas/retiradas del cuadro, escaneo de noticias para "molestias". |
| 5 | `backtest.js` offline sobre histórico (más allá del Brier score en vivo de la fase 1.5): curva de calibración completa, ROI simulado por deporte/mercado, antes de decidir apostar dinero real. |

### Limitación conocida

No hay fuente gratuita fiable de **lesiones/molestias de tenis**. Se cubrirá con bajas del cuadro
(dato duro) + noticias (señal blanda) + el `overrides.json` manual.
