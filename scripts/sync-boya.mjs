// scripts/sync-boya.mjs — WaveLog · Sync Boya 1731 → Supabase
// Ejecutado por GitHub Actions cada hora
// Node.js 20+ con ES Modules

import { createClient } from '@supabase/supabase-js';

// =============================================================================
//  CONFIGURACIÓN
// =============================================================================
const STATION_URL = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
const TABLE_NAME  = 'boya_barcelona';

const PARAM_HS   = ['1', '32'];
const PARAM_HMAX = ['2', '33'];
const PARAM_TP   = ['4', '34'];
const PARAM_DIR  = ['6', '36'];

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

  const supabase = createClient(supabaseUrl, supabaseKey);

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

  // PASO 2: Seleccionar el más reciente con Hs válido
  registros.sort((a, b) => parseFecha(b.fecha) - parseFecha(a.fecha));

  let registroValido = null;
  let oleaje         = null;

  for (const reg of registros) {
    const datos = extraerOleaje(reg);
    if (datos.hs !== null) {
      registroValido = reg;
      oleaje         = datos;
      break;
    }
  }

  if (!registroValido || !oleaje) {
    console.error('[sync-boya] ERROR: Ningún registro contiene datos de Hs');
    process.exit(1);
  }

  console.log(`[sync-boya] Registro seleccionado: ${registroValido.fecha} · Hs=${oleaje.hs}m`);

  // PASO 3: Insertar en Supabase
  const fechaIso = convertirFechaAIso(registroValido.fecha);

  if (!fechaIso) {
    console.error(`[sync-boya] ERROR: Fecha inválida → ${registroValido.fecha}`);
    process.exit(1);
  }

  const fila = {
    fecha_oficial: fechaIso,
    hs:            redondear(oleaje.hs, 2),
    hmax:          oleaje.hmax !== null ? redondear(oleaje.hmax, 2) : redondear(oleaje.hs * 1.55, 2),
    tp:            oleaje.tp   !== null ? redondear(oleaje.tp,  1) : null,
    dir:           gradosACardinal(oleaje.dir),
    dir_grados:    oleaje.dir  !== null ? Math.round(oleaje.dir)   : null,
  };

  const { data: insertado, error: errorInsert } = await supabase
    .from(TABLE_NAME)
    .insert(fila, { onConflict: 'fecha_oficial', ignoreDuplicates: true })
    .select();

  if (errorInsert) {
    console.error('[sync-boya] ERROR de Supabase:', errorInsert.message);
    process.exit(1);
  }

  const esDuplicado = !insertado || insertado.length === 0;

  if (esDuplicado) {
    console.log(`[sync-boya] Registro ${fechaIso} ya existia — omitido`);
  } else {
    console.log(`[sync-boya] Guardado: Hs=${fila.hs}m Hmax=${fila.hmax}m Tp=${fila.tp}s Dir=${fila.dir} (${fechaIso})`);
  }
}


// =============================================================================
//  OBTENCIÓN DE DATOS — POST primero, GET como fallback
// =============================================================================
async function obtenerRegistros() {
  const url = `${STATION_URL}&_ts=${Date.now()}`;

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
      body:    '{}',
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
//  EXTRACCION DE OLEAJE — por paramId
// =============================================================================
function extraerOleaje(registro) {
  const resultado = { hs: null, hmax: null, tp: null, dir: null };

  const datos = registro.datos
    ?? registro.measurements
    ?? registro.data
    ?? (Array.isArray(registro) ? registro : []);

  for (const d of datos) {
    const id    = String(d.paramId ?? d.idVariable ?? d.id ?? '').trim();
    const valor = parseValor(d.valor ?? d.value ?? d.v ?? d.dato);

    if (valor === null) continue;

    if      (PARAM_HS.includes(id))   resultado.hs   = valor;
    else if (PARAM_HMAX.includes(id)) resultado.hmax = valor;
    else if (PARAM_TP.includes(id))   resultado.tp   = valor;
    else if (PARAM_DIR.includes(id))  resultado.dir  = valor;
  }

  return resultado;
}

function parseValor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return isNaN(n) ? null : n;
}


// =============================================================================
//  CONVERSION A CARDINAL — sin operador de modulo
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
