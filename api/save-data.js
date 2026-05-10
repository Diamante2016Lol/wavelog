// api/save-data.js — WaveLog · Sync horario Boya 1731 → Supabase
// Llamado por cron-job.org una vez por hora
// ES Modules — compatible con Vercel Serverless Functions

import { createClient } from '@supabase/supabase-js';

// =============================================================================
//  CONFIGURACIÓN
// =============================================================================
const STATION_URL  = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
const TABLE_NAME   = 'boya_barcelona';

// IDs oficiales de Puertos del Estado — búsqueda por ID, nunca por nombre
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
  // User-Agent de Safari en iPhone — el que mejor resultado ha dado
  'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};


// =============================================================================
//  HANDLER PRINCIPAL
// =============================================================================
export default async function handler(req, res) {

  // Solo aceptamos GET (que es lo que envía cron-job.org) y OPTIONS
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Comprobación de variables de entorno antes de hacer nada
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[save-data] Faltan variables de entorno de Supabase');
    return res.status(500).json({
      ok:      false,
      error:   'Configuración incompleta: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas',
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // -----------------------------------------------------------------------
    //  PASO 1: Obtener datos de la boya
    // -----------------------------------------------------------------------
    const registros = await obtenerRegistros();

    if (!registros || registros.length === 0) {
      throw new Error('La API de Puertos del Estado devolvió una lista vacía');
    }

    // Ordenar de más nuevo a más viejo y quedarse con el primero que tenga Hs
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
      throw new Error('No se encontró ningún registro reciente con datos de Hs');
    }

    // -----------------------------------------------------------------------
    //  PASO 2: Construir el registro a insertar
    // -----------------------------------------------------------------------
    // Convertir la fecha del gobierno a ISO 8601 con zona UTC
    const fechaIso = convertirFechaAIso(registroValido.fecha);

    if (!fechaIso) {
      throw new Error(`Fecha con formato inválido: ${registroValido.fecha}`);
    }

    const nuevoRegistro = {
      fecha_oficial: fechaIso,
      hs:            redondear(oleaje.hs, 2),
      hmax:          oleaje.hmax !== null ? redondear(oleaje.hmax, 2) : redondear(oleaje.hs * 1.55, 2),
      tp:            oleaje.tp  !== null ? redondear(oleaje.tp,  1) : null,
      dir:           gradosACardinal(oleaje.dir),
      dir_grados:    oleaje.dir !== null ? Math.round(oleaje.dir)   : null,
    };

    // -----------------------------------------------------------------------
    //  PASO 3: Insertar en Supabase evitando duplicados
    //  onConflict: 'fecha_oficial' aprovecha la restricción UNIQUE de la tabla.
    //  ignoreDuplicates: true hace que no lance error si ya existe.
    // -----------------------------------------------------------------------
    const { data: insertado, error: errorInsert } = await supabase
      .from(TABLE_NAME)
      .insert(nuevoRegistro, { onConflict: 'fecha_oficial', ignoreDuplicates: true })
      .select();

    if (errorInsert) {
      throw new Error(`Error de Supabase al insertar: ${errorInsert.message}`);
    }

    // Si insertado está vacío significa que el registro ya existía (duplicado ignorado)
    const esDuplicado = !insertado || insertado.length === 0;

    return res.status(200).json({
      ok:          true,
      accion:      esDuplicado ? 'ignorado_duplicado' : 'insertado',
      registro:    nuevoRegistro,
      mensaje:     esDuplicado
                     ? `Registro para ${fechaIso} ya existía en la tabla — no se insertó`
                     : `Registro para ${fechaIso} guardado correctamente`,
    });

  } catch (err) {
    console.error('[save-data] ERROR:', err.message);
    return res.status(500).json({
      ok:      false,
      error:   err.message,
    });
  }
}


// =============================================================================
//  OBTENCIÓN DE DATOS — POST primero, GET como fallback
// =============================================================================
async function obtenerRegistros() {
  const url = `${STATION_URL}&_ts=${Date.now()}`;

  // Intento 1: POST con body vacío
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
      body:    '{}',
      cache:   'no-store',
    });

    if (resp.ok) {
      const data = await resp.json();
      return normalizar(data);
    }

    // Si POST falla con 405 o 403, intentamos GET
    console.warn(`[save-data] POST devolvió ${resp.status}, intentando GET…`);

  } catch (errPost) {
    console.warn('[save-data] POST lanzó excepción, intentando GET:', errPost.message);
  }

  // Intento 2: GET estándar
  const resp = await fetch(url, {
    method:  'GET',
    headers: BROWSER_HEADERS,
    cache:   'no-store',
  });

  if (!resp.ok) {
    throw new Error(`Tanto POST como GET fallaron. Último estado: ${resp.status}`);
  }

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
//  Formato del gobierno: "2026-05-10 18:00:00.0" (UTC implícito)
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
//  EXTRACCIÓN DE OLEAJE — búsqueda por paramId (resistente a cambios de nombre)
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
//  CONVERSIÓN A CARDINAL — sin operador de módulo
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


// =============================================================================
//  UTILIDADES
// =============================================================================
function redondear(n, decimales) {
  const factor = Math.pow(10, decimales);
  return Math.round(n * factor) / factor;
}
