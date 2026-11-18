// lib/boya.mjs — WaveLog · Boya Barcelona II (Portus, estación 1731) → Supabase
// Lo usan el robot de GitHub (scripts/sync-boya.mjs) y la web al darle a "actualizar"
// (api/save-data.js). Sin librerías: solo fetch, para que funcione igual en los dos sitios.

const STATION_URL = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
const TABLE_NAME  = 'boya_barcelona';

// Cada dato viene con su nombre ESEOO (Hm0, Hmax, Tp, MeanDir...). Se identifica por
// ese nombre; el id solo sirve de respaldo. OJO: el id 32 es Tm02 (periodo medio), NO la Hs.
const ESEOO = { Hm0: 'hs', Hmax: 'hmax', Tp: 'tp', MeanDir: 'dir' };
const IDS   = { '13': 'hs', '17': 'hmax', '34': 'tp', '20': 'dir' };

const BROWSER_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Cache-Control':   'no-cache',
  'Origin':          'https://portus.puertos.es',
  'Referer':         'https://portus.puertos.es/',
  'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// Portus solo acepta POST con la lista de parámetros (GET devuelve 405)
export async function obtenerRegistros() {
  const resp = await fetch(`${STATION_URL}&_ts=${Date.now()}`, {
    method:  'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
    body:    JSON.stringify([20, 34, 32, 17, 13]),
    cache:   'no-store',
  });
  if (!resp.ok) throw new Error(`Portus devolvió ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
}

export function extraerOleaje(registro) {
  const r = { hs: null, hmax: null, tp: null, dir: null };
  for (const d of registro.datos ?? registro.data ?? []) {
    const campo = ESEOO[d.paramEseoo] ?? IDS[String(d.paramId ?? d.id ?? '').trim()];
    if (!campo || d.averia === true) continue;
    const bruto = parseValor(d.valor ?? d.value);
    if (bruto === null) continue;
    r[campo] = bruto / (parseValor(d.factor) || 1);   // p. ej. Hs 138 con factor 100 = 1,38 m
  }
  // Sanidad: la Hs nunca puede superar la Hmax ni ser absurda para la boya costera
  if (r.hs !== null && (r.hs <= 0 || r.hs > 10 || (r.hmax !== null && r.hs > r.hmax))) {
    console.warn(`[boya] Hs descartada por incoherente: ${r.hs} (Hmax ${r.hmax})`);
    r.hs = null;
  }
  return r;
}

export function aFilas(registros) {
  const filas = [];
  for (const reg of registros) {
    const o = extraerOleaje(reg);
    const fecha = fechaIso(reg.fecha);
    if (o.hs === null || !fecha) continue;
    filas.push({
      fecha_oficial: fecha,
      hs:         redondear(o.hs, 2),
      hmax:       o.hmax !== null ? redondear(o.hmax, 2) : redondear(o.hs * 1.55, 2),
      tp:         o.tp   !== null ? redondear(o.tp, 1)   : null,
      dir:        gradosACardinal(o.dir),
      dir_grados: o.dir  !== null ? Math.round(o.dir)    : null,
    });
  }
  return filas.sort((a, b) => a.fecha_oficial.localeCompare(b.fecha_oficial));
}

// Baja las ~48 h que da Portus y las guarda (sobrescribiendo: Portus es la fuente oficial)
export async function sincronizarBoya({ supabaseUrl, supabaseKey }) {
  const filas = aFilas(await obtenerRegistros());
  if (!filas.length) throw new Error('Ningún registro de Portus trae una Hs válida');
  const resp = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}?on_conflict=fecha_oficial`, {
    method:  'POST',
    headers: {
      apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(filas),
  });
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
  return { guardadas: filas.length, ultima: filas.at(-1) };
}

function parseValor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function fechaIso(str) {
  if (!str) return null;
  const d = new Date(str.trim().replace(' ', 'T').replace(/\.0+$/, '') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function gradosACardinal(g) {
  if (g === null || g === undefined || isNaN(g)) return '--';
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round((((g % 360) + 360) % 360) / 45) % 8];
}

function redondear(n, dec) {
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}
