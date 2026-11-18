// scripts/sync-boya.mjs — WaveLog · Sync Boya 1731 → Supabase
// Ejecutado por GitHub Actions cada hora
// Node.js 20+ con ES Modules

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// =============================================================================
//  CONFIGURACIÓN
// =============================================================================
const STATION_URL = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
const TABLE_NAME  = 'boya_barcelona';

// Cada dato viene con su nombre ESEOO (Hm0, Hmax, Tp, MeanDir...). Se identifica por
// ese nombre; el id solo sirve de respaldo. OJO: el id 32 es Tm02 (periodo medio), NO
// la Hs. Antes estaba en la lista de Hs y, cuando Portus cambió el orden de los datos
// (17-nov-2026), la Hs pasó a ser el Tm02 (~5 "m").
const ESEOO = { Hm0: 'hs', Hmax: 'hmax', Tp: 'tp', MeanDir: 'dir' };
const IDS   = { '13': 'hs', '17': 'hmax', '34': 'tp', '20': 'dir' };

const BROWSER_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Origin':          'https://portus.puertos.es',
  'Referer':         'https://portus.puertos.es/',
  'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// =============================================================================
//  ENTRADA PRINCIPAL
// =============================================================================
async function main() {
  console.log(`[sync-boya] Iniciando sync — ${new Date().toISOString()}`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[sync-boya] ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: { transport: ws }
  });

  // PASO 1: Obtener datos
  let registros;
  try {
    registros = await obtenerRegistros();
  } catch (err) {
    console.error('[sync-boya] ERROR al conectar con Puertos del Estado:', err.message);
    process.exit(1);
  }

  if (!registros || registros.length === 0) {
    console.error('[sync-boya] ERROR: La API devolvió una lista vacía');
    process.exit(1);
  }

  console.log(`[sync-boya] Registros recibidos: ${registros.length}`);

  // PASO 2: Convertir TODOS los registros con Hs válido (Portus devuelve ~48 h).
  //   Antes solo se guardaba el más reciente, así que si GitHub se saltaba
  //   ejecuciones (pasa a menudo con los cron horarios) esas horas se perdían.
  const filas = [];
  for (const reg of registros) {
    const oleaje   = extraerOleaje(reg);
    const fechaIso = convertirFechaAIso(reg.fecha);
    if (oleaje.hs === null || !fechaIso) continue;
    filas.push({
      fecha_oficial: fechaIso,
      hs:            redondear(oleaje.hs, 2),
      hmax:          oleaje.hmax !== null ? redondear(oleaje.hmax, 2) : redondear(oleaje.hs * 1.55, 2),
      tp:            oleaje.tp  !== null ? redondear(oleaje.tp,  1) : null,
      dir:           gradosACardinal(oleaje.dir),
      dir_grados:    oleaje.dir !== null ? Math.round(oleaje.dir)   : null,
    });
  }

  if (!filas.length) {
    console.error('[sync-boya] ERROR: Ningún registro contiene datos de Hs');
    process.exit(1);
  }
  filas.sort((a, b) => a.fecha_oficial.localeCompare(b.fecha_oficial));
  const ultima = filas.at(-1);
  console.log(`[sync-boya] ${filas.length} registros válidos · último: ${ultima.fecha_oficial} Hs=${ultima.hs}m`);

  // PASO 3: Guardar las últimas ~48 h, sobrescribiendo lo que hubiera: Portus es la
  //   fuente oficial y así cualquier dato mal guardado se corrige solo en la siguiente pasada.
  const { data: previos } = await supabase.from(TABLE_NAME).select('fecha_oficial')
    .gte('fecha_oficial', filas[0].fecha_oficial);
  const yaEstaban = new Set((previos || []).map(r => new Date(r.fecha_oficial).toISOString()));
  const { data: insertados, error: errorInsert } = await supabase
    .from(TABLE_NAME)
    .upsert(filas, { onConflict: 'fecha_oficial' })
    .select('fecha_oficial');

  if (errorInsert) {
    console.error('[sync-boya] ERROR de Supabase:', errorInsert.message);
    process.exit(1);
  }

  const nuevas = filas.filter(f => !yaEstaban.has(f.fecha_oficial));
  console.log(`[sync-boya] ${insertados?.length || 0} horas guardadas (${nuevas.length} nuevas, el resto actualizadas).`
    + (nuevas.length ? ` Nuevas: ${nuevas.map(r => r.fecha_oficial.slice(5, 16)).join(', ')}` : ''));
}

// =============================================================================
//  OBTENCIÓN DE DATOS — POST MAESTRO
// =============================================================================
async function obtenerRegistros() {
  const url = `${STATION_URL}&_ts=${Date.now()}`;

  try {
    const resp = await fetch(url, {
      method:  'POST',
      // ¡CLAVE! Añadimos Content-Type application/json para que entienda el body
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
      // ¡CLAVE! El array mágico que has descubierto
      body:    JSON.stringify([20, 34, 32, 17, 13]), 
    });

    if (resp.ok) {
      const data = await resp.json();
      return normalizar(data);
    }

    console.warn(`[sync-boya] POST devolvio ${resp.status}, intentando GET...`);
  } catch (err) {
    console.warn('[sync-boya] POST fallo con excepcion, intentando GET:', err.message);
  }

  const resp = await fetch(url, {
    method:  'GET',
    headers: BROWSER_HEADERS,
  });

  if (!resp.ok) throw new Error(`GET devolvio ${resp.status}`);

  const data = await resp.json();
  return normalizar(data);
}

function normalizar(data) {
  if (Array.isArray(data))              return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

// =============================================================================
//  PARSING DE FECHAS
// =============================================================================
function parseFecha(str) {
  if (!str) return 0;
  const iso = str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z';
  const t   = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function convertirFechaAIso(str) {
  if (!str) return null;
  const iso = str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z';
  const d   = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// =============================================================================
//  EXTRACCIÓN DE OLEAJE — APLICANDO EL FACTOR
// =============================================================================
function extraerOleaje(registro) {
  const resultado = { hs: null, hmax: null, tp: null, dir: null };

  const datos = registro.datos
    ?? registro.measurements
    ?? registro.data
    ?? (Array.isArray(registro) ? registro : []);

  for (const d of datos) {
    const campo = ESEOO[d.paramEseoo] ?? IDS[String(d.paramId ?? d.idVariable ?? d.id ?? '').trim()];
    if (!campo || d.averia === true) continue;

    const valorBruto = parseValor(d.valor ?? d.value ?? d.v ?? d.dato);
    if (valorBruto === null) continue;
    // Los valores vienen escalados (p. ej. Hs 138 con factor 100 = 1,38 m)
    const factor = parseValor(d.factor) || 1;
    resultado[campo] = valorBruto / factor;
  }

  // Sanidad: la Hs nunca puede superar la Hmax ni ser absurda para la boya costera
  if (resultado.hs !== null && (resultado.hs <= 0 || resultado.hs > 10
      || (resultado.hmax !== null && resultado.hs > resultado.hmax))) {
    console.warn(`[sync-boya] Hs descartada por incoherente: ${resultado.hs} (Hmax ${resultado.hmax})`);
    resultado.hs = null;
  }

  return resultado;
}

function parseValor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return isNaN(n) ? null : n;
}

// =============================================================================
//  CONVERSIÓN A CARDINAL — sin operador de modulo
// =============================================================================
function gradosACardinal(grados) {
  if (grados === null || grados === undefined || isNaN(grados)) return '--';

  const RUMBOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

  const normalizado = grados - Math.floor(grados / 360) * 360;
  const positivo    = normalizado < 0 ? normalizado + 360 : normalizado;
  const idxRaw      = Math.round(positivo / 45);
  const idx         = idxRaw - Math.floor(idxRaw / 8) * 8;

  return RUMBOS[idx];
}

function redondear(n, decimales) {
  const factor = Math.pow(10, decimales);
  return Math.round(n * factor) / factor;
}

// =============================================================================
//  ARRANQUE
// =============================================================================
main().catch((err) => {
  console.error('[sync-boya] ERROR no capturado:', err);
  process.exit(1);
});
