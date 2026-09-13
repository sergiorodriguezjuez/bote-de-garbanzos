#!/usr/bin/env node
// Genera partidos.json para "El bote de garbanzos" (fase 2).
// Fuentes: football-data.org (partidos, gratis con clave), clubelo.com (Elo, gratis y sin clave),
// The Odds API (cuotas, gratis con clave, cuota limitada) y Open-Meteo (clima, gratis y sin clave).
// Solo fútbol por ahora: el tenis (fase 4) sigue con los datos de ejemplo del propio HTML.

const fs = require('fs');
const path = require('path');

const FD_TOKEN = process.env.FOOTBALL_DATA_API_KEY;
const ODDS_KEY = process.env.ODDS_API_KEY;

const SALIDA = path.join(__dirname, '..', 'partidos.json');
const ALIAS_PATH = path.join(__dirname, 'alias-equipos.json');
const ESTADIOS_PATH = path.join(__dirname, 'estadios.json');

if(!FD_TOKEN){
  console.error('Falta FOOTBALL_DATA_API_KEY (clave gratis en https://www.football-data.org/client/register)');
  process.exit(1);
}
if(!ODDS_KEY){
  console.warn('Falta ODDS_API_KEY: se generarán los partidos sin cuotas (sin detección de value bets).');
}

// Las 12 competiciones que cubre el plan gratis de football-data.org, mapeadas a su
// identificador de deporte en The Odds API (para pedir cuotas de la misma competición).
const LIGAS_CUOTAS = {
  PL: 'soccer_epl',
  ELC: 'soccer_efl_champ',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
  DED: 'soccer_netherlands_eredivisie',
  FL1: 'soccer_france_ligue_one',
  PPL: 'soccer_portugal_primeira_liga',
  BSA: 'soccer_brazil_campeonato',
  CL: 'soccer_uefa_champs_league',
  EC: 'soccer_uefa_european_championship',
  WC: 'soccer_fifa_world_cup',
};

const VENTAJA_LOCAL_ELO = 65;   // puntos de ventaja por jugar en casa (valor típico de clubelo.com)
const GOLES_MEDIOS_TOTAL = 2.7; // media histórica de goles/partido en las grandes ligas europeas
const N_SIMULACIONES = 10000;
const HORAS_CACHE_CUOTAS = 24;  // The Odds API es gratis solo hasta ~500 peticiones/mes: no pedirlas más de una vez al día por liga

const ESTADO_FD = {
  SCHEDULED: 'PROGRAMADO', TIMED: 'PROGRAMADO',
  IN_PLAY: 'EN_JUEGO', LIVE: 'EN_JUEGO', PAUSED: 'EN_JUEGO',
  FINISHED: 'FINALIZADO', AWARDED: 'FINALIZADO',
  SUSPENDED: 'SUSPENDIDO',
  POSTPONED: 'CANCELADO', CANCELLED: 'CANCELADO',
};

function normalizar(nombre){
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(cf|fc|sd|rcd|rc|cd|ud|afc|ac|as|ssc|ss|ogc|sc|ca|calcio|club|de|futbol)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function leerJSON(p, porDefecto){
  try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }catch(e){ return porDefecto; }
}

async function pedir(url, opciones){
  const r = await fetch(url, opciones);
  if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r;
}

/* ---------------- football-data.org: partidos de hoy, mañana y pasado mañana ---------------- */

async function obtenerPartidosFD(){
  const hoy = new Date();
  const hasta = new Date(hoy);
  hasta.setUTCDate(hasta.getUTCDate() + 2);
  const fmt = d => d.toISOString().slice(0, 10);
  const r = await pedir(
    `https://api.football-data.org/v4/matches?dateFrom=${fmt(hoy)}&dateTo=${fmt(hasta)}`,
    { headers: { 'X-Auth-Token': FD_TOKEN } }
  );
  const j = await r.json();
  return j.matches || [];
}

/* ---------------- clubelo.com: Elo de clubes, gratis y sin clave ---------------- */

async function obtenerMapaElo(){
  const fecha = new Date().toISOString().slice(0, 10);
  const r = await pedir(`http://api.clubelo.com/${fecha}`);
  const csv = await r.text();
  const filas = csv.trim().split('\n').slice(1); // primera línea = cabecera (Rank,Club,Country,Level,Elo,From,To)
  const mapa = {};
  for(const fila of filas){
    const cols = fila.split(',');
    const club = cols[1], elo = Number(cols[4]);
    if(club && !isNaN(elo)) mapa[normalizar(club)] = elo;
  }
  return mapa;
}

function buscarElo(nombreFD, mapaElo, alias){
  const alt = alias[nombreFD];
  if(alt && mapaElo[normalizar(alt)] != null) return mapaElo[normalizar(alt)];
  const n = normalizar(nombreFD);
  if(mapaElo[n] != null) return mapaElo[n];
  const claves = Object.keys(mapaElo);
  const parcial = claves.find(k => k.length > 3 && (k.includes(n) || n.includes(k)));
  return parcial != null ? mapaElo[parcial] : null;
}

/* ---------------- The Odds API: cuotas 1x2 y goles, con caché para no gastar la cuota gratuita ---------------- */
// Cada mercado que se pide multiplica el gasto de la cuota (500/mes gratis): h2h + totals = 2
// créditos por liga y pasada. Se queda ahí a propósito — córners/tarjetas existen como mercado en
// la API, pero no tenemos ninguna fuente de datos para calcular una probabilidad propia de eso, así
// que no habría con qué comparar esa cuota (sin probabilidad propia no hay "valor" que detectar).

async function obtenerCuotasLiga(codigoLiga){
  const clave = LIGAS_CUOTAS[codigoLiga];
  if(!clave || !ODDS_KEY) return [];
  const r = await pedir(
    `https://api.the-odds-api.com/v4/sports/${clave}/odds?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`
  );
  return r.json();
}

function precioMedio(evento, clave, predicado){
  const precios = [];
  for(const casa of evento.bookmakers || []){
    const mercado = casa.markets.find(m => m.key === clave);
    const resultado = mercado && mercado.outcomes.find(predicado);
    if(resultado) precios.push(1 / resultado.price);
  }
  if(!precios.length) return null;
  const media = precios.reduce((a, b) => a + b, 0) / precios.length;
  return +(1 / media).toFixed(2); // se promedian probabilidades implícitas, no las cuotas en crudo
}

function buscarCuotasPartido(loc, vis, eventos){
  const nLoc = normalizar(loc), nVis = normalizar(vis);
  const evento = eventos.find(e => {
    const h = normalizar(e.home_team), a = normalizar(e.away_team);
    return (h.includes(nLoc) || nLoc.includes(h)) && (a.includes(nVis) || nVis.includes(a));
  });
  if(!evento) return null;
  const cLoc = precioMedio(evento, 'h2h', o => normalizar(o.name) === nLoc || normalizar(o.name) === normalizar(evento.home_team));
  const cVis = precioMedio(evento, 'h2h', o => normalizar(o.name) === nVis || normalizar(o.name) === normalizar(evento.away_team));
  const cEmpate = precioMedio(evento, 'h2h', o => normalizar(o.name) === 'draw' || normalizar(o.name) === 'empate');
  if(cLoc == null || cVis == null) return null;
  const cuotas = { loc: cLoc, vis: cVis, casa: 'Media de mercado (The Odds API)', actualizado: new Date().toISOString() };
  const masDe25 = precioMedio(evento, 'totals', o => o.name === 'Over' && Math.abs(o.point - 2.5) < 0.01);
  const menosDe25 = precioMedio(evento, 'totals', o => o.name === 'Under' && Math.abs(o.point - 2.5) < 0.01);
  if(masDe25 != null) cuotas.masDe25 = masDe25;
  if(menosDe25 != null) cuotas.menosDe25 = menosDe25;
  if(cEmpate != null) cuotas.empate = cEmpate;
  return cuotas;
}

/* ---------------- clima: Open-Meteo, gratis y sin clave, solo si conocemos el estadio ---------------- */

async function obtenerClima(estadio){
  if(!estadio) return null;
  try{
    const r = await pedir(
      `https://api.open-meteo.com/v1/forecast?latitude=${estadio.lat}&longitude=${estadio.lon}` +
      `&current=temperature_2m,precipitation,wind_speed_10m&timezone=UTC`
    );
    const j = await r.json();
    if(!j.current) return null;
    return {
      estadio: estadio.nombre,
      techo: !!estadio.techo,
      lluvia_mm: j.current.precipitation,
      viento_kmh: Math.round(j.current.wind_speed_10m),
      temp_c: Math.round(j.current.temperature_2m),
    };
  }catch(e){
    return null;
  }
}

/* ---------------- Montecarlo: Elo -> goles esperados (Poisson) -> resultado ---------------- */

function poissonSample(lambda){
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do{ k++; p *= Math.random(); }while(p > L);
  return k - 1;
}

// Simplificación deliberada: usa el Elo general de cada equipo (no ataque/defensa por separado)
// para repartir los goles esperados del partido. Suficiente para fase 2; se puede refinar más
// adelante con estadísticas de goles a favor/en contra si hiciera falta más precisión.
function simular(eloLoc, eloVis, n = N_SIMULACIONES){
  const fuerzaLoc = Math.pow(10, (eloLoc + VENTAJA_LOCAL_ELO) / 400);
  const fuerzaVis = Math.pow(10, eloVis / 400);
  const cuotaFuerza = fuerzaLoc / (fuerzaLoc + fuerzaVis);
  const lambdaLoc = GOLES_MEDIOS_TOTAL * cuotaFuerza;
  const lambdaVis = GOLES_MEDIOS_TOTAL * (1 - cuotaFuerza);
  let loc = 0, emp = 0, vis = 0, masDe25 = 0;
  for(let i = 0; i < n; i++){
    const gl = poissonSample(lambdaLoc), gv = poissonSample(lambdaVis);
    if(gl > gv) loc++; else if(gl < gv) vis++; else emp++;
    if(gl + gv > 2.5) masDe25++;
  }
  return {
    n, pLoc: loc / n, pEmpate: emp / n, pVis: vis / n,
    pMasDe25: masDe25 / n, pMenosDe25: (n - masDe25) / n,
    actualizado: new Date().toISOString(),
  };
}

/* ---------------- programa principal ---------------- */

async function main(){
  const alias = leerJSON(ALIAS_PATH, {});
  const estadios = leerJSON(ESTADIOS_PATH, {});
  const anterior = leerJSON(SALIDA, { partidos: [] });
  const anteriorPorId = Object.fromEntries((anterior.partidos || []).map(p => [p.id, p]));

  const [partidosFD, mapaElo] = await Promise.all([
    obtenerPartidosFD(),
    obtenerMapaElo().catch(e => {
      console.warn(`clubelo.com no respondió (${e.message}); esta pasada no tendrá Elo ni simulación, se reintentará en la próxima.`);
      return {};
    }),
  ]);

  const sinElo = new Set();
  const sinEstadio = new Set();
  const cuotasPorLiga = {};
  const partidos = [];

  for(const m of partidosFD){
    const comp = m.competition;
    const loc = m.homeTeam.name, vis = m.awayTeam.name;
    const estado = ESTADO_FD[m.status] || 'PROGRAMADO';
    const id = `fd-${m.id}`;

    const eloLoc = buscarElo(loc, mapaElo, alias);
    const eloVis = buscarElo(vis, mapaElo, alias);
    if(eloLoc == null) sinElo.add(loc);
    if(eloVis == null) sinElo.add(vis);
    const sim = (eloLoc != null && eloVis != null) ? simular(eloLoc, eloVis) : null;

    // Cuotas: se reutilizan si el partido ya no está por jugarse, o si las que teníamos son
    // recientes, para no gastar la cuota gratuita de The Odds API en cada pasada del cron.
    const previa = anteriorPorId[id];
    const previaFresca = previa && previa.cuotas &&
      (Date.now() - new Date(previa.cuotas.actualizado).getTime()) < HORAS_CACHE_CUOTAS * 3600000;
    let cuotas = null;
    if(previa && previa.cuotas && (estado !== 'PROGRAMADO' || previaFresca)){
      cuotas = previa.cuotas;
    }else if(LIGAS_CUOTAS[comp.code]){
      if(!(comp.code in cuotasPorLiga)){
        cuotasPorLiga[comp.code] = await obtenerCuotasLiga(comp.code).catch(() => []);
      }
      cuotas = buscarCuotasPartido(loc, vis, cuotasPorLiga[comp.code]);
    }

    const estadio = estadios[normalizar(loc)];
    if(!estadio) sinEstadio.add(loc);

    partidos.push({
      id, dep: 'Fútbol',
      torneo: comp.name,
      ronda: m.matchday ? `Jornada ${m.matchday}` : (m.stage && m.stage !== 'REGULAR_SEASON' ? m.stage.replace(/_/g, ' ') : undefined),
      inicioUTC: m.utcDate,
      estado,
      loc, vis,
      elo: (eloLoc != null && eloVis != null) ? { loc: eloLoc, vis: eloVis } : undefined,
      sim: sim || undefined,
      cuotas: cuotas || undefined,
      clima: await obtenerClima(estadio),
      lesiones: { cobertura: 'sin confirmar', loc: [], vis: [] }, // pendiente de la fase 3
      marcador: (m.score && m.score.fullTime && m.score.fullTime.home != null)
        ? { txt: `${m.score.fullTime.home}-${m.score.fullTime.away}` }
        : undefined,
    });
  }

  if(sinElo.size) console.warn(`Sin Elo (añade el nombre exacto a alias-equipos.json si hace falta): ${[...sinElo].join(', ')}`);
  if(sinEstadio.size) console.warn(`Sin estadio/clima (añádelos a estadios.json si te interesa este equipo): ${[...sinEstadio].join(', ')}`);

  fs.writeFileSync(SALIDA, JSON.stringify({
    _esquema: 'Generado automáticamente por scripts/generar-partidos.js (fase 2, vía GitHub Actions). Campos documentados en LEEME-bote.md.',
    generado: new Date().toISOString(),
    partidos,
  }, null, 2));

  console.log(`Escritos ${partidos.length} partidos en ${SALIDA}`);
}

main().catch(e => { console.error(e); process.exit(1); });
