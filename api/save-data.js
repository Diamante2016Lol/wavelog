// api/save-data.js — WaveLog · Sync horario Boya 1731 → Supabase (SIN LIBRERÍAS)
// Llamado por cron-job.org una vez por hora
// ES Modules — compatible con Vercel Serverless Functions

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  // Comprobación de variables de entorno antes de hacer nada
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      ok: false,
      error: 'Configuración incompleta: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas',
    });
  }

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

    if (!registroValido || !oleaje) throw new Error('No se encontró registro reciente con Hs');

    // -----------------------------------------------------------------------
    //  PASO 2: Construir el registro a insertar
    // -----------------------------------------------------------------------
    const fechaIso = convertirFechaAIso(registroValido.fecha);

    if (!fechaIso) throw new Error(`Fecha con formato inválido: ${registroValido.fecha}`);

    const nuevoRegistro = {
      fecha_oficial: fechaIso,
      hs:            redondear(oleaje.hs, 2),
      hmax:          oleaje.hmax !== null ? redondear(oleaje.hmax, 2) : redondear(oleaje.hs * 1.55, 2),
      tp:            oleaje.tp  !== null ? redondear(oleaje.tp,  1) : null,
      dir:           gradosACardinal(oleaje.dir),
      dir_grados:    oleaje.dir !== null ? Math.round(oleaje.dir)   : null,
    };

    // -----------------------------------------------------------------------
    //  PASO 3: Insertar en Supabase SIN librerías (Usando fetch nativo)
    // -----------------------------------------------------------------------
    const tablaUrl = `${supabaseUrl}/rest/v1/${TABLE_NAME}`;

    const supabaseResp = await fetch(tablaUrl, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates, return=representation'
      },
      body: JSON.stringify(nuevoRegistro)
    });

    if (!supabaseResp.ok) {
        const errorText = await supabaseResp.text();
        throw new Error(`Error de Supabase: ${errorText}`);
    }

    const insertado = await supabaseResp.json();
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
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// =============================================================================
//  FUNCIONES DE APOYO (Idénticas a tu proxy de boya)
// =============================================================================
async function obtenerRegistros() {
  const url = `${STATION_URL}&_ts=${Date.now()}`;

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
      body:    '{}',
      cache:   'no-store',
    });
    if (resp.ok) return normalizar(await resp.json());
  } catch (err) { /* Silenciamos el error para probar GET */ }

  const resp = await fetch(url, { method: 'GET', headers: BROWSER_HEADERS, cache: 'no-store' });
  if (!resp.ok) throw new Error(`Ambos métodos fallaron. Estado GET: ${resp.status}`);
  return normalizar(await resp.json());
}

function normalizar(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

function parseFecha(str) {
  if (!str) return 0;
  return new Date(str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z').getTime() || 0;
}

function convertirFechaAIso(str) {
  if (!str) return null;
  const d = new Date(str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extraerOleaje(registro) {
  const resultado = { hs: null, hmax: null, tp: null, dir: null };
  const datos = registro.datos ?? registro.measurements ?? registro.data ?? (Array.isArray(registro) ? registro : []);

  for (const d of datos) {
    const id = String(d.paramId ?? d.idVariable ?? d.id ?? '').trim();
    const valor = parseFloat(String(d.valor ?? d.value ?? d.v ?? d.dato).replace(',', '.'));
    if (isNaN(valor)) continue;

    if (PARAM_HS.includes(id)) resultado.hs = valor;
    else if (PARAM_HMAX.includes(id)) resultado.hmax = valor;
    else if (PARAM_TP.includes(id)) resultado.tp = valor;
    else if (PARAM_DIR.includes(id)) resultado.dir = valor;
  }
  return resultado;
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  let normalizado = grados - Math.floor(grados / 360) * 360;
  if (normalizado < 0) normalizado += 360;
  return rumbos[(Math.round(normalizado / 45) - Math.floor(Math.round(normalizado / 45) / 8) * 8)];
}

function redondear(n, decimales) {
  const factor = Math.pow(10, decimales);
  return Math.round(n * factor) / factor;
}
