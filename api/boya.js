// api/boya.js — WaveLog · Boya Barcelona II (Estación 1731)
// Vercel Serverless Function · ES Modules

// =============================================================================
//  CONFIGURACIÓN
// =============================================================================
const STATION_URL = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';

// IDs oficiales de Puertos del Estado para la estación 1731
const PARAM_HS   = ['1', '32'];
const PARAM_HMAX = ['2', '33'];
const PARAM_TP   = ['4', '34'];
const PARAM_DIR  = ['6', '36'];

// Cabeceras que imitan un navegador real (imprescindibles para que el servidor
// del gobierno acepte la petición)
const BROWSER_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Referer':         'https://portus.puertos.es/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Origin': 'https://portus.puertos.es',
};


// =============================================================================
//  HANDLER PRINCIPAL
// =============================================================================
export default async function handler(req, res) {

  // --- Cabeceras de respuesta: CORS + destructor de caché en Vercel ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma',  'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico   = Boolean(fecha && hora);

  try {
    // -----------------------------------------------------------------
    //  1. OBTENER DATOS (GET → fallback POST si el servidor devuelve 405)
    // -----------------------------------------------------------------
    const registros = await obtenerRegistros();

    if (!registros || registros.length === 0) {
      throw new Error('La API de Puertos del Estado devolvió una lista vacía');
    }

    // -----------------------------------------------------------------
    //  2. ORDENAR DE MÁS NUEVO A MÁS VIEJO
    // -----------------------------------------------------------------
    registros.sort((a, b) => parseFecha(b.fecha) - parseFecha(a.fecha));

    // -----------------------------------------------------------------
    //  3. SELECCIÓN DE REGISTRO (LIVE vs HISTÓRICO)
    // -----------------------------------------------------------------
    let registro = null;

    if (modoHistorico) {
      registro = seleccionarPorHora(registros, fecha, hora);
    } else {
      registro = seleccionarUltimoConHs(registros);
    }

    if (!registro) {
      throw new Error('No se encontró ningún registro con datos de altura de ola (Hs)');
    }

    // -----------------------------------------------------------------
    //  4. EXTRACCIÓN DE VARIABLES
    // -----------------------------------------------------------------
    const oleaje = extraerOleaje(registro);

    if (oleaje.hs === null) {
      throw new Error('El registro seleccionado no contiene la variable Hs');
    }

    // -----------------------------------------------------------------
    //  5. RESPUESTA LIMPIA
    // -----------------------------------------------------------------
    return res.status(200).json({
      hs:        redondear(oleaje.hs, 2),
      hmax:      oleaje.hmax !== null ? redondear(oleaje.hmax, 2) : redondear(oleaje.hs * 1.55, 2),
      tp:        oleaje.tp   !== null ? redondear(oleaje.tp,  1) : null,
      dir:       gradosACardinal(oleaje.dir),
      dirGrados: oleaje.dir  !== null ? Math.round(oleaje.dir)   : null,
      fechaHora: registro.fecha || null,
      fuente:    'Boya Oficial 1731 — Puertos del Estado',
      modo:      modoHistorico ? 'historico' : 'live',
    });

  } catch (err) {
    console.error('[boya.js] FALLO:', err.message);

    // Respuesta de emergencia: el frontend puede detectar error:true
    return res.status(200).json({
      error:     true,
      mensaje:   err.message,
      hs:        null,
      hmax:      null,
      tp:        null,
      dir:       null,
      fechaHora: new Date().toISOString(),
    });
  }
}


// =============================================================================
//  OBTENCIÓN DE DATOS — GET con fallback POST
// =============================================================================
async function obtenerRegistros() {
  // Se añade un timestamp como parámetro para romper cualquier caché
  // intermedio (tanto en Vercel Edge como en el proxy del gobierno)
  const ts  = Date.now();
  const url = `${STATION_URL}&_ts=${ts}`;

  // --- Intento 1: GET ---
  try {
    const resp = await fetch(url, {
      method:  'GET',
      headers: BROWSER_HEADERS,
      cache:   'no-store',
    });

    if (resp.status === 405) {
      // El servidor rechazó GET, pasamos al fallback POST
      console.warn('[boya.js] GET devolvió 405, intentando POST…');
      return await fetchPost(url);
    }

    if (!resp.ok) {
      throw new Error(`GET fallido con estado ${resp.status}`);
    }

    const data = await resp.json();
    return normalizar(data);

  } catch (errGet) {
    // Si GET lanzó una excepción de red (ECONNREFUSED, timeout, etc.)
    // hacemos un último intento con POST antes de rendirse
    console.warn('[boya.js] GET lanzó excepción, intentando POST:', errGet.message);
    return await fetchPost(url);
  }
}

async function fetchPost(url) {
  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      'Content-Length': '0',
    },
    body:  '{}',
    cache: 'no-store',
  });

  if (!resp.ok) {
    throw new Error(`POST también falló con estado ${resp.status}`);
  }

  const data = await resp.json();
  return normalizar(data);
}

// Garantiza que siempre trabajamos con un array
function normalizar(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}


// =============================================================================
//  PARSING DE FECHAS
//  El gobierno usa el formato "2026-05-10 18:00:00.0" (sin zona horaria)
//  que los datos reales vienen en UTC.
// =============================================================================
function parseFecha(str) {
  if (!str) return 0;
  // "2026-05-10 18:00:00.0"  →  "2026-05-10T18:00:00Z"
  const limpia = str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z';
  const t = new Date(limpia).getTime();
  return isNaN(t) ? 0 : t;
}


// =============================================================================
//  SELECCIÓN DE REGISTRO
// =============================================================================

// Modo Live: el registro válido más reciente que contenga Hs
function seleccionarUltimoConHs(registros) {
  for (const reg of registros) {
    const { hs } = extraerOleaje(reg);
    if (hs !== null) return reg;
  }
  return null;
}

// Modo Histórico: el registro cuya fecha esté más cerca de fecha+hora
function seleccionarPorHora(registros, fecha, hora) {
  // Construir el timestamp objetivo en UTC
  const horaLimpia = hora.length === 5 ? hora : hora.slice(0, 5); // "HH:MM"
  const objetivo   = new Date(`${fecha}T${horaLimpia}:00Z`).getTime();

  if (isNaN(objetivo)) return null;

  let mejorRegistro = null;
  let menorDif      = Infinity;

  for (const reg of registros) {
    const t   = parseFecha(reg.fecha);
    const dif = Math.abs(t - objetivo);
    if (dif < menorDif) {
      menorDif      = dif;
      mejorRegistro = reg;
    }
  }

  return mejorRegistro;
}


// =============================================================================
//  EXTRACCIÓN DE OLEAJE
//  Busca exclusivamente por paramId (resistente a cambios de nombre)
// =============================================================================
function extraerOleaje(registro) {
  const resultado = { hs: null, hmax: null, tp: null, dir: null };

  const datos = obtenerDatos(registro);
  if (!datos || datos.length === 0) return resultado;

  for (const d of datos) {
    const id    = String(d.paramId ?? d.idVariable ?? d.id ?? '').trim();
    const valor = parseValor(d.valor ?? d.value ?? d.v ?? d.dato);

    if (valor === null) continue;

    if (PARAM_HS.includes(id)) {
      resultado.hs = valor;
    } else if (PARAM_HMAX.includes(id)) {
      resultado.hmax = valor;
    } else if (PARAM_TP.includes(id)) {
      resultado.tp = valor;
    } else if (PARAM_DIR.includes(id)) {
      resultado.dir = valor;
    }
  }

  return resultado;
}

// Devuelve el array de mediciones independientemente de la clave que use el JSON
function obtenerDatos(registro) {
  return registro.datos
      ?? registro.measurements
      ?? registro.data
      ?? (Array.isArray(registro) ? registro : []);
}

// Convierte cualquier representación de número (incluyendo comas europeas) a float
function parseValor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return isNaN(n) ? null : n;
}


// =============================================================================
//  CONVERSIÓN DE DIRECCIÓN A PUNTOS CARDINALES
//  Implementado sin el operador de módulo (requerimiento del proyecto)
// =============================================================================
function gradosACardinal(grados) {
  if (grados === null || grados === undefined || isNaN(grados)) return '--';

  const RUMBOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

  // Equivalente a ((grados mod 360) + 360) mod 360 sin usar el operador mod
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
